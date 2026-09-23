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
}
