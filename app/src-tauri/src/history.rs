use crate::probe::{redact, ProbeError};
use crate::{repo, runner};
use serde::Serialize;
use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::time::Duration;

/// Field separator inside one log record (ASCII unit separator).
const FIELD_SEP: u8 = 0x1f;
/// Record separator emitted by `git log -z` (NUL). Git itself refuses to
/// create a commit whose message contains NUL ("a NUL byte in commit log
/// message not allowed"), so NUL is a reliable entry boundary; `%x1f` can
/// appear inside messages, which is why the message is the final field and
/// records are split with a field-count limit.
const RECORD_SEP: u8 = 0x00;
const FIELD_COUNT: usize = 10;
const LOG_FORMAT: &str = "%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%cn%x1f%ce%x1f%cI%x1f%D%x1f%B";
/// 100 commits with long messages can exceed the default capture bound.
const LOG_OUTPUT_LIMIT: usize = 8 * 1024 * 1024;
pub const PAGE_SIZE: u64 = 50;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitView {
    pub oid: String,
    pub parents: Vec<String>,
    pub subject: String,
    /// Full message, newlines preserved; rendered with textContent only.
    pub message: String,
    pub author_name: String,
    pub author_email: String,
    pub author_date: String,
    pub committer_name: String,
    pub commit_date: String,
    /// Raw `%D` decoration tokens ("HEAD -> main", "tag: v1", "origin/main").
    pub refs: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPage {
    pub start: u64,
    pub commits: Vec<CommitView>,
    pub has_more: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitFileView {
    /// Raw status token ("M", "A", "R100" — the score stays attached).
    pub status: String,
    /// Display name of the new-side path; never convertible back to bytes.
    pub path: String,
    /// Rename/copy source, display name only.
    pub old_path: Option<String>,
}

/// Accepts only full object ids, so a frontend value can never be a revspec
/// expression, option or path. Branch/tag listings hand out these ids.
pub(crate) fn valid_oid(candidate: &str) -> bool {
    (candidate.len() == 40 || candidate.len() == 64)
        && candidate.bytes().all(|b| b.is_ascii_hexdigit())
        && candidate.bytes().all(|b| !b.is_ascii_uppercase())
}

fn lossy(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// Parses the byte stream produced by `LOG_FORMAT` with `-z` (verified on
/// Git 2.53: fields separated by 0x1f, each record terminated by 0x00,
/// `%B` trailing newline included).
pub fn parse(bytes: &[u8]) -> Result<Vec<CommitView>, ProbeError> {
    let mut commits = Vec::new();
    for record in bytes.split(|b| *b == RECORD_SEP) {
        if record.is_empty() {
            continue;
        }
        let fields: Vec<&[u8]> = record
            .splitn(FIELD_COUNT, |byte| *byte == FIELD_SEP)
            .collect();
        if fields.len() != FIELD_COUNT {
            // Never guess around a partial record: a wrong field could be
            // rendered as a commit message or, worse, fed back as an argument.
            return Err(ProbeError::new(
                "history_protocol_error",
                "Git returned history in an unexpected format; refusing to parse it.",
            ));
        }
        let message = {
            let raw = fields[9];
            match raw.split_last() {
                Some((b'\n', rest)) => rest,
                _ => raw,
            }
        };
        let message = lossy(message);
        let subject = match message.lines().next() {
            Some(line) => crate::model::display_name(line.as_bytes()),
            None => String::new(),
        };
        commits.push(CommitView {
            oid: lossy(fields[0]),
            parents: lossy(fields[1])
                .split(' ')
                .filter(|p| !p.is_empty())
                .map(str::to_owned)
                .collect(),
            subject,
            author_name: lossy(fields[2]),
            author_email: lossy(fields[3]),
            author_date: lossy(fields[4]),
            committer_name: lossy(fields[5]),
            commit_date: lossy(fields[7]),
            refs: lossy(fields[8])
                .split(", ")
                .filter(|t| !t.is_empty())
                .map(str::to_owned)
                .collect(),
            message,
        });
    }
    Ok(commits)
}

/// One deterministic page of history. `--topo-order` keeps the sequence
/// stable for a fixed commit graph, and `--skip`/`-n` on the caller's
/// `start` cursor reproduces earlier pages byte for byte.
pub fn page(
    directory: &Path,
    start: u64,
    target: Option<&str>,
    limit: u64,
) -> Result<HistoryPage, ProbeError> {
    let mut command = repo::user_git_command(directory);
    command.args([
        "log",
        "--no-color",
        "-z",
        "--topo-order",
        &format!("--format={LOG_FORMAT}"),
        "-n",
        &limit.saturating_add(1).to_string(),
        "--skip",
        &start.to_string(),
    ]);
    if let Some(rev) = target {
        command.arg(rev);
    }
    command.arg("--");
    let output = runner::run_with_limit(
        command,
        &AtomicBool::new(false),
        Duration::ZERO,
        Duration::from_secs(30),
        LOG_OUTPUT_LIMIT,
        |_, _| {},
    )?;
    if output.truncated {
        return Err(ProbeError::new(
            "history_truncated",
            "The history page exceeded the capture bound; nothing was parsed.",
        ));
    }
    if !output.status.success() {
        let detail = redact(&String::from_utf8_lossy(&output.stderr));
        let first_line = detail.lines().next().unwrap_or("").to_owned();
        return Err(ProbeError::new("history_page_failed", first_line));
    }
    let mut commits = parse(&output.stdout)?;
    let has_more = commits.len() as u64 > limit;
    if has_more {
        commits.truncate(limit as usize);
    }
    Ok(HistoryPage {
        start,
        commits,
        has_more,
    })
}

/// Parses `diff-tree -z --name-status` output: alternating status and path
/// tokens, with rename/copy records carrying two paths (source first). The
/// stream ends with NUL, so exactly one trailing empty token is expected.
pub fn parse_files(bytes: &[u8]) -> Result<Vec<CommitFileView>, ProbeError> {
    fn malformed() -> ProbeError {
        ProbeError::new(
            "history_protocol_error",
            "Git returned a commit file list in an unexpected format; refusing to parse it.",
        )
    }
    let mut tokens = bytes.split(|b| *b == RECORD_SEP).peekable();
    let mut files = Vec::new();
    while let Some(status) = tokens.next() {
        if status.is_empty() {
            if tokens.peek().is_none() {
                break;
            }
            return Err(malformed());
        }
        let (kind, score) = status.split_first().expect("non-empty status");
        let two_paths = match kind {
            b'A' | b'D' | b'M' | b'T' | b'U' | b'X' | b'B' => {
                if !score.is_empty() {
                    return Err(malformed());
                }
                false
            }
            b'R' | b'C' => {
                if score.is_empty() || !score.iter().all(u8::is_ascii_digit) {
                    return Err(malformed());
                }
                true
            }
            _ => return Err(malformed()),
        };
        let first = tokens
            .next()
            .filter(|t| !t.is_empty())
            .ok_or_else(malformed)?;
        let (old_path, path) = if two_paths {
            let second = tokens
                .next()
                .filter(|t| !t.is_empty())
                .ok_or_else(malformed)?;
            (Some(crate::model::display_name(first)), second)
        } else {
            (None, first)
        };
        files.push(CommitFileView {
            status: lossy(status),
            path: crate::model::display_name(path),
            old_path,
        });
    }
    Ok(files)
}

/// Files changed by one commit. `--root` includes the initial commit,
/// `-M` surfaces renames, and first-parent diff semantics keep merges
/// readable: what the merge brought into the line it continued.
pub fn commit_files(directory: &Path, oid: &str) -> Result<Vec<CommitFileView>, ProbeError> {
    let mut command = repo::user_git_command(directory);
    command.args([
        "diff-tree",
        "-r",
        "-z",
        "--no-commit-id",
        "--name-status",
        "-M",
        "--root",
        "--diff-merges=first-parent",
        oid,
        "--",
    ]);
    let output = runner::run_with_limit(
        command,
        &AtomicBool::new(false),
        Duration::ZERO,
        Duration::from_secs(30),
        LOG_OUTPUT_LIMIT,
        |_, _| {},
    )?;
    if output.truncated {
        return Err(ProbeError::new(
            "history_truncated",
            "The commit file list exceeded the capture bound; nothing was parsed.",
        ));
    }
    if !output.status.success() {
        let detail = redact(&String::from_utf8_lossy(&output.stderr));
        let first_line = detail.lines().next().unwrap_or("").to_owned();
        return Err(ProbeError::new("commit_files_failed", first_line));
    }
    parse_files(&output.stdout)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    fn git(dir: &Path, args: &[&str]) {
        crate::repo::git_with(
            dir,
            &[
                "-c",
                "user.name=guit test",
                "-c",
                "user.email=guit@example.invalid",
            ],
            args,
        );
    }

    fn fixture() -> (tempfile::TempDir, PathBuf) {
        let root = tempfile::tempdir().unwrap();
        let repo = root.path().join("repo");
        std::fs::create_dir(&repo).unwrap();
        git(&repo, &["init", "--quiet", "--initial-branch=main"]);
        (root, repo)
    }

    fn commit(repo: &Path, message: &str) -> String {
        git(
            repo,
            &[
                "commit",
                "-q",
                "--allow-empty",
                "--no-verify",
                "-m",
                message,
            ],
        );
        oid(repo, "HEAD")
    }

    fn oid(repo: &Path, rev: &str) -> String {
        let output = std::process::Command::new("git")
            .arg("-c")
            .arg("core.autocrlf=false")
            .arg("-C")
            .arg(repo)
            .args(["rev-parse", rev])
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/nonexistent-guit-test-config")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("LC_ALL", "C")
            .output()
            .expect("git");
        assert!(output.status.success());
        String::from_utf8(output.stdout).unwrap().trim().to_owned()
    }

    #[test]
    fn multiline_messages_survive_the_protocol_byte_exact() {
        let (_root, repo) = fixture();
        // Includes a literal field separator, fake decoration-looking lines
        // and blank lines — none of which may split or truncate the record.
        let body = "subject line\nsecond \u{1f} separator line\nOn branch main\n\nlast line";
        git(
            &repo,
            &["commit", "-q", "--allow-empty", "--no-verify", "-m", body],
        );
        let page = page(&repo, 0, None, 10).unwrap();
        assert_eq!(page.commits.len(), 1);
        assert_eq!(page.commits[0].message, body);
        assert_eq!(page.commits[0].subject, "subject line");
        assert_eq!(page.commits[0].author_name, "guit test");
        assert!(page.commits[0].author_date.contains('T'));
        assert!(page.commits[0].refs.iter().any(|t| t.contains("main")));
    }

    #[test]
    fn pagination_walks_the_whole_history_without_gaps_or_overlap() {
        let (_root, repo) = fixture();
        let mut expected = Vec::new();
        for index in 0..7 {
            let oid = commit(&repo, &format!("c{index}"));
            expected.push(oid);
        }
        expected.reverse(); // newest first
        let mut collected = Vec::new();
        let mut start = 0;
        loop {
            let page = page(&repo, start, None, 3).unwrap();
            assert_eq!(page.start, start);
            collected.extend(page.commits.iter().map(|c| c.oid.clone()));
            if !page.has_more {
                break;
            }
            start += page.commits.len() as u64;
        }
        assert_eq!(collected, expected);
        // A second pass over the same cursor returns identical pages.
        let again = page(&repo, 3, None, 3).unwrap();
        assert_eq!(again.commits.len(), 3);
        assert_eq!(again.commits[0].oid, expected[3]);
    }

    #[test]
    fn merges_are_ordered_topologically_between_branch_and_mainline() {
        let (_root, repo) = fixture();
        let base = commit(&repo, "base");
        git(&repo, &["branch", "side"]);
        let main_line = commit(&repo, "on main");
        git(&repo, &["switch", "-q", "side"]);
        let side = commit(&repo, "on side");
        git(&repo, &["switch", "-q", "main"]);
        git(
            &repo,
            &["merge", "--no-ff", "-q", "-m", "the merge", "side"],
        );
        let page = page(&repo, 0, None, 10).unwrap();
        let order: Vec<&str> = page.commits.iter().map(|c| c.oid.as_str()).collect();
        let merge = &page.commits[0];
        assert_eq!(merge.subject, "the merge");
        assert_eq!(merge.parents, vec![main_line.clone(), side.clone()]);
        // Every commit appears after its parents in topo order.
        for (index, entry) in page.commits.iter().enumerate() {
            for parent in &entry.parents {
                let at = order.iter().position(|o| *o == parent).expect("parent");
                assert!(at > index, "parent listed before child");
            }
        }
        // The base commit is reachable and listed exactly once.
        assert_eq!(page.commits.iter().filter(|c| c.oid == base).count(), 1);
    }

    #[test]
    fn parsing_rejects_short_records_instead_of_guessing() {
        let broken = b"abc\x1fdef"; // fewer than FIELD_COUNT fields
        let error = parse(broken).unwrap_err();
        assert_eq!(error.code, "history_protocol_error");
        // Empty input and trailing separators parse to zero commits.
        assert_eq!(parse(&[]).unwrap().len(), 0);
        assert_eq!(parse(b"\x00").unwrap().len(), 0);
    }

    #[test]
    fn unknown_target_and_empty_repository_are_structured_failures() {
        let (_root, repo) = fixture();
        let error = page(
            &repo,
            0,
            Some("deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"),
            10,
        )
        .unwrap_err();
        assert_eq!(error.code, "history_page_failed");
        assert!(!error.message.is_empty());
        // Unborn HEAD: the caller gates on the session branch state, the
        // raw page surfaces Git's refusal without pretending to be empty.
        let error = page(&repo, 0, None, 10).unwrap_err();
        assert_eq!(error.code, "history_page_failed");
    }

    #[test]
    fn oid_validation_admits_only_full_lowercase_hex() {
        assert!(valid_oid(&"a".repeat(40)));
        assert!(valid_oid(&"0123456789abcdef".repeat(4) /* 64 */));
        assert!(!valid_oid("HEAD"));
        assert!(!valid_oid(&"a".repeat(39)));
        assert!(!valid_oid(&"A".repeat(40)));
        assert!(!valid_oid(&format!("--{}", "a".repeat(38))));
        assert!(!valid_oid("refs/heads/main"));
        assert!(!valid_oid(&"z".repeat(40)));
    }

    #[test]
    fn decorations_carry_branches_tags_and_remotes() {
        let (_root, repo) = fixture();
        let oid = commit(&repo, "tagged");
        git(&repo, &["tag", "v1"]);
        git(&repo, &["branch", "keep"]);
        let page = page(&repo, 0, Some(&oid), 10).unwrap();
        let refs = &page.commits[0].refs;
        assert!(refs.iter().any(|t| t == "tag: v1"), "{refs:?}");
        assert!(refs.iter().any(|t| t.contains("main")), "{refs:?}");
        assert!(refs.iter().any(|t| t == "keep"), "{refs:?}");
    }

    fn touch(repo: &Path, name: &str, content: &str) {
        std::fs::write(repo.join(name), content).unwrap();
    }

    fn commit_worktree(repo: &Path, message: &str) -> String {
        git(repo, &["add", "--all"]);
        commit(repo, message);
        oid(repo, "HEAD")
    }

    #[test]
    fn file_listing_covers_root_adds_and_later_modifications() {
        let (_root, repo) = fixture();
        touch(&repo, "a.txt", "one\n");
        touch(&repo, "中文 文件.txt", "one\n");
        let root_commit = commit_worktree(&repo, "initial");
        let files = commit_files(&repo, &root_commit).unwrap();
        // `--root` makes the initial commit listable; order is Git's.
        let mut names: Vec<(&str, &str)> = files
            .iter()
            .map(|f| (f.status.as_str(), f.path.as_str()))
            .collect();
        names.sort_unstable();
        assert_eq!(
            names,
            vec![("A", "a.txt"), ("A", "中文 文件.txt")],
            "--root must include the initial commit"
        );
        touch(&repo, "a.txt", "two\n");
        let second = commit_worktree(&repo, "modify");
        let files = commit_files(&repo, &second).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(
            (files[0].status.as_str(), files[0].path.as_str()),
            ("M", "a.txt")
        );
        assert_eq!(files[0].old_path, None);
    }

    #[test]
    fn rename_records_carry_both_paths() {
        let (_root, repo) = fixture();
        touch(&repo, "old name.txt", "one\n");
        commit_worktree(&repo, "before rename");
        git(&repo, &["mv", "old name.txt", "新名.txt"]);
        let renamed = commit_worktree(&repo, "rename");
        let files = commit_files(&repo, &renamed).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "新名.txt");
        assert_eq!(files[0].old_path.as_deref(), Some("old name.txt"));
        assert_eq!(
            files[0].status, "R100",
            "score stays attached to the status token"
        );
    }

    #[test]
    fn merge_listing_shows_only_the_first_parent_difference() {
        let (_root, repo) = fixture();
        touch(&repo, "base.txt", "one\n");
        commit_worktree(&repo, "base");
        git(&repo, &["switch", "-q", "-c", "side"]);
        touch(&repo, "side.txt", "side\n");
        commit_worktree(&repo, "side work");
        git(&repo, &["switch", "-q", "main"]);
        touch(&repo, "main.txt", "main\n");
        commit_worktree(&repo, "main work");
        git(
            &repo,
            &["merge", "--no-ff", "-q", "-m", "the merge", "side"],
        );
        let merge = oid(&repo, "HEAD");
        let files = commit_files(&repo, &merge).unwrap();
        // Against the first parent (the mainline), only the merged-in file
        // is new; main.txt was already there and base.txt is unchanged.
        let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, vec!["side.txt"]);
    }

    #[test]
    fn unknown_commit_is_a_structured_failure() {
        let (_root, repo) = fixture();
        touch(&repo, "a.txt", "one\n");
        commit_worktree(&repo, "only");
        let error = commit_files(&repo, &"f".repeat(40)).unwrap_err();
        assert_eq!(error.code, "commit_files_failed");
        assert!(!error.message.is_empty());
    }

    #[test]
    fn parse_files_rejects_malformed_streams_instead_of_guessing() {
        assert!(parse_files(&[]).unwrap().is_empty());
        // A bare NUL is not a stream diff-tree can produce: records always
        // pair a status with at least one path.
        assert_eq!(
            parse_files(b"\x00").unwrap_err().code,
            "history_protocol_error"
        );
        let one = parse_files(b"M\x00a.txt\x00").unwrap();
        assert_eq!(one.len(), 1);
        assert_eq!(
            (one[0].status.as_str(), one[0].path.as_str()),
            ("M", "a.txt")
        );
        for broken in [
            &b"M\x00"[..],               // status without a path
            &b"R100\x00from\x00"[..],    // rename missing its new path
            &b"\x00\x00file"[..],        // empty token mid-stream
            &b"Mbogus\x00a.txt\x00"[..], // modifiers only exist for R/C
            &b"Q\x00a.txt\x00"[..],      // unknown status letter
            &b"M\x00\x00a"[..],          // empty path token
        ] {
            let error = parse_files(broken).unwrap_err();
            assert_eq!(error.code, "history_protocol_error", "input: {broken:?}");
        }
    }
}
