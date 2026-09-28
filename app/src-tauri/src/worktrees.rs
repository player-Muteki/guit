//! Worktree management. The list is
//! parsed from `git worktree list --porcelain` fail-closed; the frontend
//! addresses entries only by their list position (`u32`), so raw paths never
//! round-trip through the client except as display text. Removal is the
//! destructive leg and consumes the same one-time ticket as stash and ref
//! deletions, bound to the entry's HEAD oid observed at preview time. There
//! is deliberately no force path: a dirty worktree is refused by Git itself
//! and that refusal is surfaced verbatim (redacted) in the details.

use crate::probe::ProbeError;
use crate::repo::RepoIdentity;
use crate::write::{self, OperationKind, OperationResult, Outcome, PreviewResult, WriteState};
use crate::{branches, history, sequencer, session};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

/// Read-only listing helpers never participate in write cancellation; they
/// run against this permanently-unset flag, mirroring the stash module.
static NO_CANCEL: AtomicBool = AtomicBool::new(false);

const MAX_PATH_LEN: usize = 4096;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeView {
    pub index: u32,
    /// Lossy display text; `addressable` says whether the underlying bytes
    /// round-trip losslessly, which removal requires.
    pub path: String,
    /// None exactly when Git prints no HEAD line: bare and orphan worktrees
    /// (measured on Git 2.53).
    pub head: Option<String>,
    pub branch: Option<String>,
    pub detached: bool,
    pub orphan: bool,
    pub bare: bool,
    pub locked: bool,
    pub prunable: bool,
    pub addressable: bool,
}

fn protocol_error() -> ProbeError {
    ProbeError::new(
        "worktree_protocol_error",
        "The worktree listing did not match Git's expected format; refusing to guess.",
    )
}

fn session_directory(sessions: &session::SessionState) -> Result<PathBuf, ProbeError> {
    let identity = sessions
        .current_identity()
        .ok_or_else(|| ProbeError::new("worktree_no_session", "No repository is open."))?;
    bare_or_work_dir(&identity)
}

/// Read-only listings resolve in a bare repository from its git dir, like
/// the stash list does.
fn bare_or_work_dir(identity: &RepoIdentity) -> Result<PathBuf, ProbeError> {
    if identity.is_bare {
        Ok(identity.git_dir.clone())
    } else {
        identity
            .work_dir()
            .map(Path::to_path_buf)
            .map_err(|_| ProbeError::new("repo_worktree_missing", "The work tree is gone."))
    }
}

/// Git 2.53 porcelain: records separated by blank lines, each starting with
/// `worktree <path>` (raw bytes; the first space splits keyword from value),
/// then `HEAD <oid>` and exactly one of `branch refs/heads/<name>` /
/// `detached` / `orphan`, plus optional `bare`, `locked [reason]` and
/// `prunable [reason]` flags. Any other shape is a protocol error — a
/// listing we cannot fully understand must never be presented as the truth.
pub(crate) fn parse_porcelain(stdout: &[u8]) -> Result<Vec<WorktreeView>, ProbeError> {
    let mut views = Vec::new();
    let mut records = Vec::new();
    let mut current: Vec<&[u8]> = Vec::new();
    for line in stdout.split(|byte| *byte == b'\n') {
        if line.is_empty() {
            if !current.is_empty() {
                records.push(std::mem::take(&mut current));
            }
        } else {
            current.push(line);
        }
    }
    if !current.is_empty() {
        records.push(current);
    }
    for record in records {
        let mut path: Option<&[u8]> = None;
        let mut head: Option<String> = None;
        let mut branch: Option<String> = None;
        let mut detached = false;
        let mut orphan = false;
        let mut bare = false;
        let mut locked = false;
        let mut prunable = false;
        for (position, line) in record.iter().enumerate() {
            let (keyword, value) = match line.iter().position(|byte| *byte == b' ') {
                Some(space) => (&line[..space], Some(&line[space + 1..])),
                None => (*line, None),
            };
            match keyword {
                b"worktree" if position == 0 => {
                    path = Some(value.ok_or_else(protocol_error)?);
                }
                b"HEAD" if position == 1 => {
                    let raw = value.ok_or_else(protocol_error)?;
                    let oid = std::str::from_utf8(raw)
                        .map_err(|_| protocol_error())?
                        .to_owned();
                    if !history::valid_oid(&oid) {
                        return Err(protocol_error());
                    }
                    head = Some(oid);
                }
                b"branch" => {
                    if detached || orphan || branch.is_some() {
                        return Err(protocol_error());
                    }
                    let raw = value.ok_or_else(protocol_error)?;
                    let name = std::str::from_utf8(raw).map_err(|_| protocol_error())?;
                    branch = Some(
                        name.strip_prefix("refs/heads/")
                            .ok_or_else(protocol_error)?
                            .to_owned(),
                    );
                }
                b"detached" => {
                    if branch.is_some() || orphan || value.is_some() {
                        return Err(protocol_error());
                    }
                    detached = true;
                }
                b"orphan" => {
                    if branch.is_some() || detached || value.is_some() {
                        return Err(protocol_error());
                    }
                    orphan = true;
                }
                b"bare" => bare = true,
                b"locked" => locked = true,
                b"prunable" => prunable = true,
                _ => return Err(protocol_error()),
            }
        }
        let raw_path = path.ok_or_else(protocol_error)?;
        if bare && (branch.is_some() || detached) {
            return Err(protocol_error());
        }
        // Measured on Git 2.53: bare (and, per Git's docs, orphan) worktrees
        // print no HEAD line at all; every other record must have one.
        if head.is_none() && !(bare || orphan) {
            return Err(protocol_error());
        }
        let index = u32::try_from(views.len()).map_err(|_| protocol_error())?;
        views.push(WorktreeView {
            index,
            addressable: std::str::from_utf8(raw_path).is_ok(),
            path: String::from_utf8_lossy(raw_path).into_owned(),
            head,
            branch,
            detached,
            orphan,
            bare,
            locked,
            prunable,
        });
    }
    Ok(views)
}

pub(crate) fn worktree_list(dir: &Path) -> Result<Vec<WorktreeView>, ProbeError> {
    let output = branches::run_git(dir, &["worktree", "list", "--porcelain"], &NO_CANCEL)?;
    if output.truncated {
        return Err(ProbeError::new(
            "worktree_list_too_large",
            "The worktree listing exceeded the read limit.",
        ));
    }
    parse_porcelain(&output.stdout)
}

pub(crate) fn list_view(sessions: &session::SessionState) -> Result<Vec<WorktreeView>, ProbeError> {
    worktree_list(&session_directory(sessions)?)
}

/// Validates the dialog-returned path before it ever reaches an argv slot:
/// one absolute-path argument, never through a shell.
fn validate_path(path: &str) -> Result<(), ProbeError> {
    if path.is_empty() || path.trim().is_empty() {
        return Err(ProbeError::new(
            "worktree_path_invalid",
            "No directory was chosen for the new worktree.",
        ));
    }
    if path.contains('\0') || path.len() > MAX_PATH_LEN {
        return Err(ProbeError::new(
            "worktree_path_invalid",
            "The chosen path is not a usable directory name.",
        ));
    }
    Ok(())
}

pub(crate) fn worktree_add(
    state: &WriteState,
    sessions: &session::SessionState,
    snapshot_version: u64,
    path: String,
    target: String,
) -> Result<OperationResult, ProbeError> {
    let operation_id = state.begin()?;
    let result = run_add(state, sessions, snapshot_version, &path, &target);
    state.finish();
    result.map(|mut result| {
        result.operation_id = operation_id;
        result
    })
}

/// Assumes the queue slot is held; tests call this directly to pre-arm
/// cancellation, mirroring the other runners.
fn run_add(
    state: &WriteState,
    sessions: &session::SessionState,
    snapshot_version: u64,
    path: &str,
    target: &str,
) -> Result<OperationResult, ProbeError> {
    let kind = OperationKind::WorktreeAdd;
    let work_root = match sessions.commit_context(snapshot_version) {
        Err(error) => return write::plain(sessions, kind, Outcome::Rejected, &error.message),
        Ok((work_root, unborn)) => {
            if unborn {
                return write::plain(
                    sessions,
                    kind,
                    Outcome::Rejected,
                    "Cannot add a worktree before the first commit.",
                );
            }
            if let Err(refusal) = validate_path(path) {
                return write::plain(sessions, kind, Outcome::Rejected, &refusal.message);
            }
            if !sequencer::validate_target(&work_root, target) {
                return write::plain(
                    sessions,
                    kind,
                    Outcome::Rejected,
                    "Worktrees check out a full commit id or an exact local branch name.",
                );
            }
            work_root
        }
    };
    if state.cancel_flag().load(Ordering::SeqCst) {
        return write::plain(
            sessions,
            kind,
            Outcome::Cancelled,
            "Cancelled before Git ran.",
        );
    }
    write::run_and_report(
        sessions,
        kind,
        branches::run_git(
            &work_root,
            &["worktree", "add", path, target],
            state.cancel_flag(),
        ),
        write::Wording {
            ok: format!("Worktree added for {target}."),
            failed: "git worktree add reported a failure.".to_owned(),
            cancelled: "Cancelled while Git ran; the new directory may be partially created."
                .to_owned(),
        },
    )
}

pub(crate) fn preview_remove_worktree(
    state: &WriteState,
    sessions: &session::SessionState,
    snapshot_version: u64,
    index: u32,
) -> Result<PreviewResult, ProbeError> {
    let (_work_root, _unborn) = sessions.commit_context(snapshot_version)?;
    let dir = session_directory(sessions)?;
    let entry = worktree_list(&dir)?
        .into_iter()
        .find(|view| view.index == index)
        .ok_or_else(|| {
            ProbeError::new(
                "worktree_missing",
                "That worktree is no longer listed; refresh the view.",
            )
        })?;
    if entry.bare {
        return Err(ProbeError::new(
            "worktree_bare",
            "The bare main worktree is the repository itself and cannot be removed.",
        ));
    }
    if !entry.addressable {
        return Err(ProbeError::new(
            "worktree_not_addressable",
            "This worktree's path cannot be addressed losslessly; removal is refused.",
        ));
    }
    // An orphan worktree (its branch was deleted elsewhere) has no HEAD oid
    // to bind a ticket to; guit refuses rather than issue an unbound one.
    let Some(head) = entry.head.clone() else {
        return Err(ProbeError::new(
            "worktree_orphan",
            "This worktree's branch no longer exists; guit refuses removal without a stable \
             binding — clean it up with git worktree remove directly.",
        ));
    };
    let work_root = sessions
        .current_identity()
        .and_then(|identity| identity.work_root.clone())
        .unwrap_or_default();
    if entry.path == work_root.to_string_lossy() {
        return Err(ProbeError::new(
            "worktree_current",
            "This is the work tree guit has open; remove it from that checkout, not this one.",
        ));
    }
    let nonce = state.stage_worktree_remove(dir.clone(), entry.path.clone(), head.clone());
    let snapshot = session::refresh(sessions)?
        .ok_or_else(|| ProbeError::new("write_no_session", "No repository session is open."))?;
    Ok(PreviewResult {
        nonce,
        candidates: vec![entry.path],
        dropped: Vec::new(),
        snapshot,
        target_oid: Some(head),
    })
}

pub(crate) fn remove_worktree(
    state: &WriteState,
    sessions: &session::SessionState,
    nonce: String,
) -> Result<OperationResult, ProbeError> {
    let operation_id = state.begin()?;
    let result = run_remove(state, sessions, &nonce);
    state.finish();
    result.map(|mut result| {
        result.operation_id = operation_id;
        result
    })
}

fn run_remove(
    state: &WriteState,
    sessions: &session::SessionState,
    nonce: &str,
) -> Result<OperationResult, ProbeError> {
    write::confirm(
        state,
        sessions,
        OperationKind::WorktreeRemove,
        nonce,
        write::Refusals {
            expired: "That confirmation has expired; preview the action again.",
            session_changed:
                "The repository session changed after the preview; the worktree was untouched.",
            cancelled_before_git: "Cancelled before Git ran.",
        },
        |preview| match preview.bound {
            write::Bound::WorktreeRemove { path, head } => Some((preview.work_root, (path, head))),
            _ => None,
        },
        |_work_root, (path, head)| {
            let fresh = worktree_list(&session_directory(sessions)?)?;
            let unchanged = fresh
                .iter()
                .any(|view| view.path == *path && view.head.as_deref() == Some(head.as_str()));
            if !unchanged {
                return Ok(Err(
                    "The worktree list changed after the preview; nothing was removed.".to_owned(),
                ));
            }
            let still_current = sessions
                .current_identity()
                .and_then(|identity| identity.work_root)
                .is_some_and(|work_root| *path == work_root.to_string_lossy().into_owned());
            Ok(if still_current {
                Err("This is the work tree guit has open; removal was refused.".to_owned())
            } else {
                Ok(())
            })
        },
        |work_root, (path, _)| {
            write::ran_from(
                branches::run_git(
                    work_root,
                    &["worktree", "remove", path],
                    state.cancel_flag(),
                ),
                write::Wording {
                    ok: "Worktree removed.".to_owned(),
                    // Git's own refusal (dirty contents, locked, ...) is the
                    // authoritative reason; there is no force path here.
                    failed: "git worktree remove reported a failure.".to_owned(),
                    cancelled: "Cancelled while Git ran; the worktree may be partially removed."
                        .to_owned(),
                },
            )
        },
    )
}

pub(crate) fn prune_worktrees(
    state: &WriteState,
    sessions: &session::SessionState,
    snapshot_version: u64,
) -> Result<OperationResult, ProbeError> {
    let operation_id = state.begin()?;
    let result = run_prune(state, sessions, snapshot_version);
    state.finish();
    result.map(|mut result| {
        result.operation_id = operation_id;
        result
    })
}

/// Only removes Git's own records of worktree directories that no longer
/// exist; nothing on disk is deleted, so no ticket is required. The count
/// comes from `prunable` marks in a fresh listing rather than `-v` output,
/// which Git 2.53 prints to stderr already translated to the user's locale.
fn run_prune(
    state: &WriteState,
    sessions: &session::SessionState,
    snapshot_version: u64,
) -> Result<OperationResult, ProbeError> {
    let kind = OperationKind::WorktreePrune;
    let work_root = match sessions.commit_context(snapshot_version) {
        Err(error) => return write::plain(sessions, kind, Outcome::Rejected, &error.message),
        Ok((work_root, unborn)) => {
            if unborn {
                return write::plain(
                    sessions,
                    kind,
                    Outcome::Rejected,
                    "Cannot prune worktrees before the first commit.",
                );
            }
            work_root
        }
    };
    if state.cancel_flag().load(Ordering::SeqCst) {
        return write::plain(
            sessions,
            kind,
            Outcome::Cancelled,
            "Cancelled before Git ran.",
        );
    }
    let stale = worktree_list(&work_root)?
        .iter()
        .filter(|view| view.prunable)
        .count();
    write::run_and_report(
        sessions,
        kind,
        branches::run_git(&work_root, &["worktree", "prune"], state.cancel_flag()),
        write::Wording {
            ok: if stale == 0 {
                "No stale worktree records.".to_owned()
            } else {
                format!("Pruned {stale} stale worktree record(s).")
            },
            failed: "git worktree prune reported a failure.".to_owned(),
            cancelled: "Cancelled while Git ran; some stale records may remain.".to_owned(),
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repo;

    const COMMIT_ID: &[&str] = &[
        "-c",
        "user.name=guit test",
        "-c",
        "user.email=test@example.invalid",
    ];

    fn git(dir: &Path, args: &[&str]) {
        repo::git_with(dir, COMMIT_ID, args);
    }

    fn seeded_repo() -> tempfile::TempDir {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path();
        repo::git_with(dir, &[], &["init", "--quiet", "--initial-branch=main"]);
        std::fs::write(dir.join("a.txt"), "one\n").unwrap();
        git(dir, &["add", "--", "a.txt"]);
        git(dir, &["commit", "-q", "-m", "base"]);
        git(dir, &["branch", "side"]);
        root
    }

    fn oid40(seed: u8) -> String {
        (0..40)
            .map(|i| format!("{:x}", (seed as usize + i) % 16))
            .collect()
    }

    #[test]
    fn porcelain_parses_paths_with_spaces_detached_bare_and_flags() {
        let stdout = format!(
            "worktree /tmp/repo main\nHEAD {}\nbranch refs/heads/main\n\n\
             worktree /tmp/link ed\nHEAD {}\ndetached\nlocked user reason\n\n\
             worktree /tmp/bare\nbare\n\n",
            oid40(1),
            oid40(2),
        );
        let views = parse_porcelain(stdout.as_bytes()).unwrap();
        assert_eq!(views.len(), 3);
        assert_eq!(views[0].head.as_deref(), Some(oid40(1).as_str()));
        assert_eq!(views[0].path, "/tmp/repo main");
        assert_eq!(views[0].branch.as_deref(), Some("main"));
        assert!(views[0].addressable);
        assert_eq!(views[1].path, "/tmp/link ed");
        assert!(views[1].detached && views[1].locked && views[1].branch.is_none());
        assert!(views[2].bare);
        assert_eq!(views[2].head, None, "Git 2.53 prints no HEAD line for bare");
        assert_eq!(views[2].index, 2);
        let orphan = parse_porcelain("worktree /o\norphan\n".as_bytes()).unwrap();
        assert_eq!(orphan.len(), 1);
        assert!(orphan[0].orphan && orphan[0].head.is_none());
    }

    #[test]
    fn parse_is_fail_closed_on_shape() {
        let good_head = format!("HEAD {}", oid40(1));
        let cases: Vec<Vec<u8>> = vec![
            // unknown keyword
            format!("worktree /r\n{good_head}\nbranch refs/heads/main\nchore x\n").into(),
            // missing HEAD
            b"worktree /r\nbranch refs/heads/main\n".to_vec(),
            // bad oid
            "worktree /r\nHEAD not-hex\nbranch refs/heads/main\n"
                .as_bytes()
                .to_vec(),
            // branch outside refs/heads
            format!("worktree /r\n{good_head}\nbranch refs/remotes/origin/x\n").into_bytes(),
            // detached and branch together
            format!("worktree /r\n{good_head}\nbranch refs/heads/main\ndetached\n").into_bytes(),
            // record that does not start with the path keyword
            good_head.clone().into_bytes(),
        ];
        for case in cases {
            assert_eq!(
                parse_porcelain(&case)
                    .map(|_| ())
                    .unwrap_err()
                    .code
                    .as_str(),
                "worktree_protocol_error",
                "must refuse: {case:?}"
            );
        }
    }

    #[test]
    fn add_links_a_worktree_and_the_gitdir_file_points_back() {
        let repository = seeded_repo();
        let root = repository.path();
        let outer = tempfile::tempdir().unwrap();
        let wt = outer.path().join("linked dir");
        let sessions = session::SessionState::default();
        let view = session::open(&sessions, root).unwrap();
        let state = WriteState::default();

        let result = worktree_add(
            &state,
            &sessions,
            view.version,
            wt.display().to_string(),
            "side".into(),
        )
        .unwrap();
        assert_eq!(result.outcome, Outcome::Success, "msg: {}", result.message);
        let gitfile = std::fs::read_to_string(wt.join(".git")).unwrap();
        assert!(gitfile.starts_with("gitdir: "), "linked worktree marker");
        let list = list_view(&sessions).unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[1].branch.as_deref(), Some("side"));
        assert_eq!(list[1].path, wt.display().to_string());
    }

    #[test]
    fn add_refuses_bad_targets_and_paths_without_running_git() {
        let repository = seeded_repo();
        let root = repository.path();
        let sessions = session::SessionState::default();
        let view = session::open(&sessions, root).unwrap();
        let state = WriteState::default();
        let outer = tempfile::tempdir().unwrap();
        let mut version = view.version;
        for (path, target) in [
            (
                outer.path().join("w1").display().to_string(),
                "HEAD~1".to_string(),
            ),
            (
                outer.path().join("w2").display().to_string(),
                "ghost".to_string(),
            ),
            (
                outer.path().join("w3").display().to_string(),
                "  ".to_string(),
            ),
            (String::new(), "side".to_string()),
            ("   ".to_string(), "side".to_string()),
        ] {
            let result = worktree_add(&state, &sessions, version, path, target).unwrap();
            assert_eq!(result.outcome, Outcome::Rejected);
            assert_eq!(result.exit_code, None, "Git must not have been invoked");
            version = result.snapshot.expect("re-read").version;
        }
        assert!(!outer.path().join("w1").exists());
    }

    #[test]
    fn add_passes_through_gits_duplicate_checkout_refusal() {
        let repository = seeded_repo();
        let root = repository.path();
        let outer = tempfile::tempdir().unwrap();
        let sessions = session::SessionState::default();
        let view = session::open(&sessions, root).unwrap();
        let state = WriteState::default();
        let first = worktree_add(
            &state,
            &sessions,
            view.version,
            outer.path().join("one").display().to_string(),
            "side".into(),
        )
        .unwrap();
        assert_eq!(first.outcome, Outcome::Success);
        let version = first.snapshot.expect("re-read").version;
        let second = worktree_add(
            &state,
            &sessions,
            version,
            outer.path().join("two").display().to_string(),
            "side".into(),
        )
        .unwrap();
        assert_eq!(second.outcome, Outcome::Failed, "msg: {}", second.message);
        assert!(second.details.is_some(), "Git's own refusal survives");
        assert!(!outer.path().join("two").exists());
    }

    #[test]
    fn remove_needs_a_ticket_and_refuses_the_current_and_replayed_cases() {
        let repository = seeded_repo();
        let root = repository.path();
        let outer = tempfile::tempdir().unwrap();
        let wt = outer.path().join("linked");
        let sessions = session::SessionState::default();
        let view = session::open(&sessions, root).unwrap();
        let state = WriteState::default();
        let added = worktree_add(
            &state,
            &sessions,
            view.version,
            wt.display().to_string(),
            "side".into(),
        )
        .unwrap();
        assert_eq!(added.outcome, Outcome::Success);
        let version = added.snapshot.expect("re-read").version;

        // The session's own worktree can never be the removal target.
        let error = preview_remove_worktree(&state, &sessions, version, 0).unwrap_err();
        assert_eq!(error.code.as_str(), "worktree_current");

        let preview = preview_remove_worktree(&state, &sessions, version, 1).unwrap();
        assert_eq!(preview.candidates, vec![wt.display().to_string()]);
        assert!(preview.target_oid.is_some());

        // Drift: the worktree moves after the preview.
        std::fs::write(wt.join("a.txt"), "moved\n").unwrap();
        git(&wt, &["commit", "-qam", "inside linked"]);
        let drift = remove_worktree(&state, &sessions, preview.nonce.clone()).unwrap();
        assert_eq!(drift.outcome, Outcome::Rejected);
        assert!(drift.message.contains("changed after the preview"));
        assert_eq!(drift.exit_code, None);
        assert!(wt.exists(), "the refusal must not have removed anything");
        let version = drift.snapshot.expect("re-read").version;

        // Fresh preview, confirmed once, and the ticket is spent.
        let preview = preview_remove_worktree(&state, &sessions, version, 1).unwrap();
        let version = preview.snapshot.version;
        let removed = remove_worktree(&state, &sessions, preview.nonce.clone()).unwrap();
        assert_eq!(
            removed.outcome,
            Outcome::Success,
            "msg: {}",
            removed.message
        );
        assert!(!wt.exists());
        assert_eq!(list_view(&sessions).unwrap().len(), 1);
        let replay = remove_worktree(&state, &sessions, preview.nonce).unwrap();
        assert_eq!(replay.outcome, Outcome::Rejected);
        assert!(replay.message.contains("expired"));
        let _ = version;
    }

    #[test]
    fn remove_of_a_dirty_worktree_reports_gits_refusal_and_keeps_it() {
        let repository = seeded_repo();
        let root = repository.path();
        let outer = tempfile::tempdir().unwrap();
        let wt = outer.path().join("dirty");
        let sessions = session::SessionState::default();
        let view = session::open(&sessions, root).unwrap();
        let state = WriteState::default();
        let added = worktree_add(
            &state,
            &sessions,
            view.version,
            wt.display().to_string(),
            "side".into(),
        )
        .unwrap();
        let version = added.snapshot.expect("re-read").version;
        std::fs::write(wt.join("a.txt"), "dirty edit\n").unwrap();
        let preview = preview_remove_worktree(&state, &sessions, version, 1).unwrap();
        let result = remove_worktree(&state, &sessions, preview.nonce).unwrap();
        assert_eq!(result.outcome, Outcome::Failed);
        assert!(result.details.is_some(), "Git says why it refused");
        assert!(wt.exists(), "nothing is force-removed");
    }

    #[test]
    fn bare_repositories_list_but_never_remove() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        repo::git_with(
            root,
            &[],
            &["init", "--quiet", "--bare", "--initial-branch=main"],
        );
        let sessions = session::SessionState::default();
        session::open(&sessions, root).unwrap();
        let list = list_view(&sessions).unwrap();
        assert_eq!(list.len(), 1);
        assert!(list[0].bare);
        let state = WriteState::default();
        // The version gate and bare guard refuse before the listing: a bare
        // session has no working copy for guit to bind a ticket to.
        let version = session::refresh(&sessions)
            .unwrap()
            .expect("snapshot")
            .version;
        let error = preview_remove_worktree(&state, &sessions, version, 0).unwrap_err();
        assert_eq!(error.code.as_str(), "write_bare_repo");
    }

    #[test]
    fn prune_counts_records_of_directories_that_vanished() {
        let repository = seeded_repo();
        let root = repository.path();
        let outer = tempfile::tempdir().unwrap();
        let wt = outer.path().join("doomed");
        let sessions = session::SessionState::default();
        let view = session::open(&sessions, root).unwrap();
        let state = WriteState::default();
        let added = worktree_add(
            &state,
            &sessions,
            view.version,
            wt.display().to_string(),
            "side".into(),
        )
        .unwrap();
        let version = added.snapshot.expect("re-read").version;
        std::fs::remove_dir_all(&wt).unwrap();

        let result = prune_worktrees(&state, &sessions, version).unwrap();
        assert_eq!(result.outcome, Outcome::Success, "msg: {}", result.message);
        assert_eq!(result.message, "Pruned 1 stale worktree record(s).");
        assert_eq!(list_view(&sessions).unwrap().len(), 1);
        let version = result.snapshot.expect("re-read").version;
        let again = prune_worktrees(&state, &sessions, version).unwrap();
        assert_eq!(again.message, "No stale worktree records.");
    }

    // Cross-module scenario: in-flight detection reads the session
    // identity's own git dir, so a merge started inside a linked worktree
    // is visible exactly where it runs — the work tree guit has open and
    // the main checkout see different states.
    #[test]
    fn a_merge_in_progress_in_a_linked_worktree_is_detected_from_that_worktree() {
        use crate::inflight::OperationKindView;
        use crate::sequencer;
        let repository = tempfile::tempdir().unwrap();
        let root = repository.path();
        repo::git_with(root, &[], &["init", "--quiet", "--initial-branch=main"]);
        std::fs::write(root.join("a.txt"), "base\n").unwrap();
        git(root, &["add", "--", "a.txt"]);
        git(root, &["commit", "-q", "-m", "base"]);
        git(root, &["branch", "side"]);
        std::fs::write(root.join("a.txt"), "main edit\n").unwrap();
        git(root, &["commit", "-aqm", "main edit"]);
        git(root, &["switch", "-q", "side"]);
        std::fs::write(root.join("a.txt"), "side edit\n").unwrap();
        git(root, &["commit", "-aqm", "side edit"]);
        git(root, &["switch", "-q", "main"]);
        git(root, &["branch", "wt-branch"]);
        let outer = tempfile::tempdir().unwrap();
        let wt = outer.path().join("wt here");
        git(
            root,
            &["worktree", "add", &wt.display().to_string(), "wt-branch"],
        );

        let sessions = session::SessionState::default();
        let view = session::open(&sessions, &wt).unwrap();
        assert_eq!(list_view(&sessions).unwrap().len(), 2);
        let writes = WriteState::default();
        let merged = sequencer::merge_start(&writes, &sessions, view.version, "side").unwrap();
        assert_eq!(
            merged.outcome,
            Outcome::Conflicted,
            "msg: {}",
            merged.message
        );
        let snapshot = merged.snapshot.expect("in-flight snapshot");
        let operation = snapshot.operation.clone().expect("merge is in progress");
        assert_eq!(operation.kind, OperationKindView::Merge);
        assert!(operation.subject.contains("side"), "{}", operation.subject);

        // The marker lives in the linked worktree's private git dir only.
        let gitfile = std::fs::read_to_string(wt.join(".git")).unwrap();
        let linked_dir = gitfile.trim_end().strip_prefix("gitdir: ").unwrap();
        assert!(std::path::Path::new(linked_dir).join("MERGE_HEAD").exists());
        assert!(
            !root.join(".git").join("MERGE_HEAD").exists(),
            "the common dir must stay free of this worktree's marker"
        );
        // The main checkout, opened as its own session, sees a clean state.
        let main_sessions = session::SessionState::default();
        let main_view = session::open(&main_sessions, root).unwrap();
        assert!(main_view.operation.is_none());
        assert_eq!(
            std::fs::read_to_string(root.join("a.txt")).unwrap(),
            "main edit\n"
        );

        let aborted = sequencer::operation_abort(&writes, &sessions, snapshot.version).unwrap();
        assert_eq!(
            aborted.outcome,
            Outcome::Success,
            "msg: {}",
            aborted.message
        );
        let after = aborted.snapshot.expect("re-read");
        assert!(after.operation.is_none());
        assert_eq!(
            std::fs::read_to_string(wt.join("a.txt")).unwrap(),
            "main edit\n"
        );
        assert!(session::refresh(&main_sessions)
            .unwrap()
            .expect("still open")
            .operation
            .is_none());
    }
}
