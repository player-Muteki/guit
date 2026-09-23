use crate::status::{ParsedStatus, StatusEntry};
use serde::Serialize;
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum HeadState {
    /// A normal named branch with at least one commit.
    Branch,
    /// HEAD points directly at a commit.
    Detached,
    /// A branch exists but has no commits yet.
    Unborn,
}

/// Frontend-facing view of the `# branch.*` headers. Unborn, detached,
/// no-upstream and hidden states are kept distinct and never collapsed into
/// "clean".
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchView {
    pub name: Option<String>,
    pub head_state: HeadState,
    pub oid: Option<String>,
    pub upstream: Option<String>,
    /// Three-state: has upstream, ahead/behind known; otherwise null.
    pub ahead: Option<u64>,
    pub behind: Option<u64>,
}

impl BranchView {
    pub fn from_parsed(parsed: &ParsedStatus) -> BranchView {
        match parsed.branch.as_ref() {
            None => BranchView {
                name: None,
                head_state: HeadState::Unborn,
                oid: None,
                upstream: None,
                ahead: None,
                behind: None,
            },
            Some(header) => {
                let headless = header.is_unborn();
                let detached = header.is_detached();
                BranchView {
                    name: if detached {
                        None
                    } else {
                        Some(header.head.clone())
                    },
                    head_state: if detached {
                        HeadState::Detached
                    } else if headless {
                        HeadState::Unborn
                    } else {
                        HeadState::Branch
                    },
                    oid: (!headless).then(|| header.oid.clone()),
                    upstream: header.upstream.clone(),
                    ahead: header.has_upstream().then_some(header.ahead),
                    behind: header.has_upstream().then_some(header.behind),
                }
            }
        }
    }
}

/// Opaque handle the frontend uses to refer to a file. IDs are only valid
/// within the snapshot that produced them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize)]
#[serde(transparent)]
pub struct FileId(pub u32);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FileGroup {
    Conflict,
    Staged,
    Worktree,
    Untracked,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileView {
    pub id: FileId,
    /// Sanitized for display only; never convert back into a path.
    pub display: String,
    pub rename_from: Option<String>,
    pub group: FileGroup,
    pub index_status: String,
    pub worktree_status: String,
    pub staged: bool,
    pub unstaged: bool,
    pub conflict: bool,
    pub untracked: bool,
    pub submodule: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawPath {
    pub path: Vec<u8>,
    /// Present for rename/copy records: the path Git reported as the source.
    pub origin: Option<Vec<u8>>,
}

/// Maps `FileId`s to the exact bytes Git produced. The frontend never learns
/// the real path, and display strings cannot be turned back into paths.
#[derive(Debug, Default)]
pub struct PathTable {
    next_id: u32,
    entries: HashMap<FileId, RawPath>,
}

impl PathTable {
    pub fn from_status(parsed: &ParsedStatus) -> (Self, Vec<FileView>) {
        let mut table = PathTable::default();
        let mut views = Vec::with_capacity(parsed.entries.len());
        for entry in &parsed.entries {
            let id = table.allocate(entry);
            let (index_status, worktree_status, submodule) = match entry {
                StatusEntry::Tracked(t) => (
                    t.index_status.to_string(),
                    t.worktree_status.to_string(),
                    t.submodule_state.starts_with('S'),
                ),
                StatusEntry::Rename(r) => (
                    r.tracked.index_status.to_string(),
                    r.tracked.worktree_status.to_string(),
                    r.tracked.submodule_state.starts_with('S'),
                ),
                StatusEntry::Unmerged(u) => (
                    u.index_status.to_string(),
                    u.worktree_status.to_string(),
                    u.submodule_state.starts_with('S'),
                ),
                StatusEntry::Untracked { .. } => ("?".to_owned(), "?".to_owned(), false),
            };
            let staged = entry.is_staged();
            let unstaged = entry.is_worktree_change();
            let group = if entry.is_conflict() {
                FileGroup::Conflict
            } else if matches!(entry, StatusEntry::Untracked { .. }) {
                FileGroup::Untracked
            } else if staged && !unstaged {
                FileGroup::Staged
            } else {
                FileGroup::Worktree
            };
            let rename_from = match entry {
                StatusEntry::Rename(r) => Some(display_name(&r.origin_path)),
                _ => None,
            };
            views.push(FileView {
                id,
                display: display_name(entry.raw_path()),
                rename_from,
                group,
                index_status,
                worktree_status,
                staged,
                unstaged,
                conflict: entry.is_conflict(),
                untracked: matches!(entry, StatusEntry::Untracked { .. }),
                submodule,
            });
        }
        (table, views)
    }

    fn allocate(&mut self, entry: &StatusEntry) -> FileId {
        let id = FileId(self.next_id);
        self.next_id += 1;
        let raw = match entry {
            StatusEntry::Rename(r) => RawPath {
                path: r.tracked.path.clone(),
                origin: Some(r.origin_path.clone()),
            },
            other => RawPath {
                path: other.raw_path().clone(),
                origin: None,
            },
        };
        self.entries.insert(id, raw);
        id
    }

    // Resolved by write operations to recover the exact Git path for a FileId.
    pub fn resolve(&self, id: FileId) -> Option<&RawPath> {
        self.entries.get(&id)
    }

    #[allow(dead_code)]
    pub fn len(&self) -> usize {
        self.entries.len()
    }
}

/// Render raw Git path bytes for the UI: lossy UTF-8 with control characters
/// escaped, so a display string can never be a working command argument.
pub fn display_name(raw: &[u8]) -> String {
    let mut out = String::new();
    for ch in String::from_utf8_lossy(raw).chars() {
        if ch.is_control() {
            out.push_str(&format!("\\x{:02x}", ch as u32));
        } else {
            out.push(ch);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::status::{RenameEntry, TrackedEntry, UnmergedEntry};

    fn tracked(path: &[u8], i: char, w: char) -> StatusEntry {
        StatusEntry::Tracked(TrackedEntry {
            index_status: i,
            worktree_status: w,
            submodule_state: "N...".into(),
            head_mode: "100644".into(),
            index_mode: "100644".into(),
            worktree_mode: "100644".into(),
            head_oid: "0".repeat(40),
            index_oid: "0".repeat(40),
            path: path.to_vec(),
        })
    }

    #[test]
    fn ids_map_back_to_exact_raw_bytes_including_non_utf8() {
        let parsed = ParsedStatus {
            branch: None,
            entries: vec![
                tracked("正常 中文.txt".as_bytes(), 'M', '.'),
                tracked(b"bad\xffname", '.', 'M'),
                StatusEntry::Untracked {
                    path: "tab\tnewline\n.txt".as_bytes().to_vec(),
                },
            ],
        };
        let (table, views) = PathTable::from_status(&parsed);
        assert_eq!(table.len(), 3);
        assert_eq!(
            table.resolve(views[0].id).unwrap().path,
            "正常 中文.txt".as_bytes()
        );
        assert_eq!(
            table.resolve(views[1].id).unwrap().path,
            b"bad\xffname".to_vec()
        );
        assert_eq!(
            table.resolve(views[2].id).unwrap().path,
            "tab\tnewline\n.txt".as_bytes()
        );
        // Display strings stay single-line and shell-inspectable.
        assert_eq!(views[1].display, "bad\u{fffd}name");
        assert_eq!(views[2].display, "tab\\x09newline\\x0a.txt");
    }

    #[test]
    fn rename_keeps_both_paths_addressable_under_one_id() {
        let parsed = ParsedStatus {
            branch: None,
            entries: vec![StatusEntry::Rename(RenameEntry {
                tracked: TrackedEntry {
                    index_status: 'R',
                    worktree_status: '.',
                    submodule_state: "N...".into(),
                    head_mode: "100644".into(),
                    index_mode: "100644".into(),
                    worktree_mode: "100644".into(),
                    head_oid: "0".repeat(40),
                    index_oid: "1".repeat(40),
                    path: "新 名.txt".as_bytes().to_vec(),
                },
                score: "R100".into(),
                origin_path: "old name.txt".as_bytes().to_vec(),
            })],
        };
        let (table, views) = PathTable::from_status(&parsed);
        let raw = table.resolve(views[0].id).unwrap();
        assert_eq!(raw.path, "新 名.txt".as_bytes());
        assert_eq!(raw.origin.as_deref(), Some("old name.txt".as_bytes()));
        assert_eq!(views[0].group, FileGroup::Staged);
        assert_eq!(views[0].rename_from.as_deref(), Some("old name.txt"));
    }

    #[test]
    fn branch_view_keeps_head_states_distinct() {
        use crate::status::BranchHeader;
        let view = |header: Option<BranchHeader>| {
            BranchView::from_parsed(&ParsedStatus {
                branch: header,
                entries: vec![],
            })
        };
        let normal = view(Some(BranchHeader {
            oid: "b".repeat(40),
            head: "main".into(),
            upstream: Some("origin/main".into()),
            ahead: 3,
            behind: 1,
        }));
        assert_eq!(normal.head_state, HeadState::Branch);
        assert_eq!((normal.ahead, normal.behind), (Some(3), Some(1)));
        let detached = view(Some(BranchHeader {
            oid: "b".repeat(40),
            head: "(detached)".into(),
            upstream: None,
            ahead: 0,
            behind: 0,
        }));
        assert_eq!(detached.head_state, HeadState::Detached);
        assert!(detached.name.is_none() && detached.oid.is_some());
        assert_eq!((detached.ahead, detached.behind), (None, None));
        let unborn = view(Some(BranchHeader {
            oid: "(initial)".into(),
            head: "master".into(),
            upstream: None,
            ahead: 0,
            behind: 0,
        }));
        assert_eq!(unborn.head_state, HeadState::Unborn);
        assert!(unborn.oid.is_none() && unborn.name.as_deref() == Some("master"));
        let headerless = view(None);
        assert_eq!(headerless.head_state, HeadState::Unborn);
    }

    #[test]
    fn branch_view_matches_real_git_states() {
        use std::process::Command;
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        std::fs::create_dir(&source).unwrap();
        let git = |dir: &std::path::Path, args: &[&str]| {
            let status = Command::new("git")
                .args(args)
                .current_dir(dir)
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("GIT_CONFIG_GLOBAL", "/nonexistent-guit-test-config")
                .env("GIT_AUTHOR_NAME", "guit test")
                .env("GIT_AUTHOR_EMAIL", "test@example.invalid")
                .env("GIT_COMMITTER_NAME", "guit test")
                .env("GIT_COMMITTER_EMAIL", "test@example.invalid")
                .env("GIT_TERMINAL_PROMPT", "0")
                .env("LC_ALL", "C")
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .expect("git");
            assert!(status.success(), "git {args:?} failed in {dir:?}");
        };
        let branch_of = |dir: &std::path::Path| -> BranchView {
            let identity = crate::repo::detect(dir).unwrap();
            let bytes = crate::repo::status_output(&identity, false).unwrap();
            BranchView::from_parsed(&crate::status::parse(&bytes).unwrap())
        };

        git(&source, &["init", "--quiet", "--initial-branch=main"]);
        std::fs::write(source.join("a.txt"), "one\n").unwrap();
        git(&source, &["add", "."]);
        git(&source, &["commit", "-q", "-m", "one"]);
        let fresh = root.path().join("fresh");
        git(
            root.path(),
            &[
                "clone",
                "-q",
                "--",
                &source.to_string_lossy(),
                &fresh.to_string_lossy(),
            ],
        );
        let tracked = branch_of(&fresh);
        assert_eq!(tracked.head_state, HeadState::Branch);
        assert_eq!(tracked.name.as_deref(), Some("main"));
        assert_eq!((tracked.ahead, tracked.behind), (Some(0), Some(0)));
        assert!(tracked.upstream.is_some());

        // Source advances; the clone is behind after fetching.
        std::fs::write(source.join("a.txt"), "two\n").unwrap();
        git(&source, &["commit", "-q", "-am", "two"]);
        git(&fresh, &["fetch", "-q", "origin"]);
        let behind = branch_of(&fresh);
        assert_eq!((behind.ahead, behind.behind), (Some(0), Some(1)));

        // Local commit makes it diverge.
        std::fs::write(fresh.join("local.txt"), "mine\n").unwrap();
        git(&fresh, &["add", "local.txt"]);
        git(&fresh, &["commit", "-q", "-m", "local"]);
        let diverged = branch_of(&fresh);
        assert_eq!((diverged.ahead, diverged.behind), (Some(1), Some(1)));

        // Detached HEAD.
        git(&fresh, &["checkout", "-q", "HEAD~1"]);
        let detached = branch_of(&fresh);
        assert_eq!(detached.head_state, HeadState::Detached);
        assert!(detached.name.is_none() && detached.oid.is_some());

        // Unborn branch in a brand-new repository.
        let empty = root.path().join("empty");
        std::fs::create_dir(&empty).unwrap();
        git(&empty, &["init", "--quiet", "--initial-branch=main"]);
        let unborn = branch_of(&empty);
        assert_eq!(unborn.head_state, HeadState::Unborn);
        assert_eq!(unborn.name.as_deref(), Some("main"));
    }

    #[test]
    fn groups_partition_conflicts_staged_worktree_and_untracked() {
        let parsed = ParsedStatus {
            branch: None,
            entries: vec![
                StatusEntry::Unmerged(UnmergedEntry {
                    index_status: 'U',
                    worktree_status: 'U',
                    submodule_state: "N...".into(),
                    modes: std::array::from_fn(|_| "100644".to_owned()),
                    stage_oids: std::array::from_fn(|_| "0".repeat(40)),
                    path: b"conflict.txt".to_vec(),
                }),
                tracked(b"both.txt", 'M', 'M'),
                tracked(b"staged.txt", 'M', '.'),
                tracked(b"worktree.txt", '.', 'M'),
                StatusEntry::Untracked {
                    path: b"fresh.txt".to_vec(),
                },
            ],
        };
        let (_, views) = PathTable::from_status(&parsed);
        let groups: Vec<_> = views.iter().map(|v| v.group).collect();
        assert_eq!(
            groups,
            vec![
                FileGroup::Conflict,
                // Both-sided edits stay visible in the work tree group.
                FileGroup::Worktree,
                FileGroup::Staged,
                FileGroup::Worktree,
                FileGroup::Untracked,
            ]
        );
        assert!(views[1].staged && views[1].unstaged);
    }

    #[cfg(unix)]
    #[test]
    fn real_repository_paths_resolve_byte_exact_through_ids() {
        use std::ffi::OsStr;
        use std::os::unix::ffi::OsStrExt;
        use std::process::Command;
        let directory = tempfile::tempdir().unwrap();
        let repo = directory.path();
        let git = |args: &[&OsStr]| {
            let status = Command::new("git")
                .args(args)
                .current_dir(repo)
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("GIT_CONFIG_GLOBAL", "/nonexistent-guit-test-config")
                .env("GIT_TERMINAL_PROMPT", "0")
                .env("LC_ALL", "C")
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .expect("git");
            assert!(status.success(), "git {args:?} failed");
        };
        let odd = OsStr::from_bytes(b"bad\xffname.txt");
        git(&[OsStr::new("init"), OsStr::new("--quiet")]);
        std::fs::File::create(repo.join(odd)).unwrap();
        git(&[OsStr::new("add"), OsStr::new("--"), odd]);
        let identity = crate::repo::detect(repo).unwrap();
        let bytes = crate::repo::status_output(&identity, true).unwrap();
        let parsed = crate::status::parse(&bytes).unwrap();
        let (table, views) = PathTable::from_status(&parsed);
        let entry = views
            .iter()
            .find(|v| v.display == "bad\u{fffd}name.txt")
            .expect("non UTF-8 path appears with a lossy display name");
        assert_eq!(
            table.resolve(entry.id).unwrap().path,
            b"bad\xffname.txt".to_vec()
        );
    }
}
