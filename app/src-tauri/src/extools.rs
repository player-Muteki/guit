use crate::probe::ProbeError;
use crate::write::{first_stderr_line, Outcome};
use crate::{repo, runner, session, write};
use serde::Serialize;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

/// External tools never occupy the write queue: `git difftool` blocks until
/// the user closes the editor, and staging or committing must stay available
/// while a diff window is open. This separate single slot only serializes
/// tools against each other.
#[derive(Debug, Default)]
pub struct ToolState {
    busy: AtomicBool,
    cancelled: AtomicBool,
    op_counter: AtomicU64,
}

impl ToolState {
    fn begin(&self) -> Result<u64, ProbeError> {
        self.busy
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map_err(|_| ProbeError::new("tool_busy", "Another external tool is still running."))?;
        self.cancelled.store(false, Ordering::SeqCst);
        Ok(self.op_counter.fetch_add(1, Ordering::SeqCst) + 1)
    }

    fn finish(&self) {
        self.busy.store(false, Ordering::SeqCst);
    }

    pub(crate) fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ToolPurpose {
    OpenFile,
    DiffWorktree,
    DiffStaged,
    /// Diff of one commit against its first parent (or the empty tree for
    /// a root commit). Addressed by object id, not by snapshot file id.
    DiffCommit,
}

/// Same contract shape as write operations: an outcome, redacted details and
/// the re-read snapshot, so the frontend keeps one version guard.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolResult {
    pub operation_id: u64,
    pub purpose: ToolPurpose,
    pub outcome: Outcome,
    pub exit_code: Option<i32>,
    pub message: String,
    pub details: Option<String>,
    pub snapshot: Option<session::SnapshotView>,
}

pub(crate) fn execute(
    state: &ToolState,
    sessions: &session::SessionState,
    snapshot_version: u64,
    file_id: u32,
    purpose: ToolPurpose,
) -> Result<ToolResult, ProbeError> {
    let operation_id = state.begin()?;
    let result = run(state, sessions, snapshot_version, file_id, purpose);
    state.finish();
    result.map(|mut result| {
        result.operation_id = operation_id;
        result
    })
}

/// Assumes the tool slot is held; tests call this directly to pre-arm
/// cancellation deterministically, mirroring `write::run_write`.
pub(crate) fn run(
    state: &ToolState,
    sessions: &session::SessionState,
    snapshot_version: u64,
    file_id: u32,
    purpose: ToolPurpose,
) -> Result<ToolResult, ProbeError> {
    let (outcome, exit_code, message, details) =
        match sessions.resolve_files(snapshot_version, &[file_id]) {
            Err(error) => (Outcome::Rejected, None, error.message, None),
            Ok((work_root, targets)) => match targets.first() {
                None => (
                    Outcome::Rejected,
                    None,
                    "No file was selected.".into(),
                    None,
                ),
                Some(raw) => dispatch(state, sessions, snapshot_version, purpose, &work_root, raw)?,
            },
        };
    // Every tool outcome ends with a re-read: the user may have saved files
    // in the opened editor, and the diff may have raced with the watcher.
    let snapshot = session::refresh(sessions)?;
    Ok(ToolResult {
        operation_id: 0,
        purpose,
        outcome,
        exit_code,
        message,
        details,
        snapshot,
    })
}

type Dispatched = (Outcome, Option<i32>, String, Option<String>);

/// Commit-wide diff: one slot in the tool lane, then the same
/// execute → run → always-refresh contract as the file-scoped tools.
pub fn execute_commit_diff(
    state: &ToolState,
    sessions: &session::SessionState,
    oid: &str,
) -> Result<ToolResult, ProbeError> {
    let operation_id = state.begin()?;
    let result = run_commit_diff(state, sessions, oid);
    state.finish();
    result.map(|mut result| {
        result.operation_id = operation_id;
        result
    })
}

fn run_commit_diff(
    state: &ToolState,
    sessions: &session::SessionState,
    oid: &str,
) -> Result<ToolResult, ProbeError> {
    let (outcome, exit_code, message, details) = match commit_diff_baseline(sessions, oid) {
        Err(error) => (Outcome::Rejected, None, error.message, None),
        Ok((work_root, baseline)) => {
            if state.cancelled.load(Ordering::SeqCst) {
                (
                    Outcome::Cancelled,
                    None,
                    "Cancelled before the tool ran.".into(),
                    None,
                )
            } else {
                match run_commit_difftool(&work_root, &baseline, oid, &state.cancelled) {
                    Ok(output) => {
                        let exit_code = output.status.code();
                        if output.status.success() {
                            (
                                Outcome::Success,
                                exit_code,
                                "Diff tool closed.".into(),
                                None,
                            )
                        } else {
                            (
                                Outcome::Failed,
                                exit_code,
                                "The diff tool reported a failure.".into(),
                                Some(first_stderr_line(&output.stderr)),
                            )
                        }
                    }
                    Err(error) if error.code == "process_cancelled" => (
                        Outcome::Cancelled,
                        None,
                        "Cancelled while the diff tool was running.".into(),
                        None,
                    ),
                    Err(error) => return Err(error),
                }
            }
        }
    };
    let snapshot = session::refresh(sessions)?;
    Ok(ToolResult {
        operation_id: 0,
        purpose: ToolPurpose::DiffCommit,
        outcome,
        exit_code,
        message,
        details,
        snapshot,
    })
}

/// Resolves the live work root and the diff baseline at click time: the
/// first parent, or the empty tree for a root commit. A commit that vanished
/// since the history was rendered is rejected instead of diffing a
/// lookalike object.
fn commit_diff_baseline(
    sessions: &session::SessionState,
    oid: &str,
) -> Result<(std::path::PathBuf, String), ProbeError> {
    let identity = sessions
        .current_identity()
        .ok_or_else(|| ProbeError::new("write_no_session", "No repository session is open."))?;
    let work_root = identity.work_root.ok_or_else(|| {
        ProbeError::new(
            "write_bare_repo",
            "A bare repository has no working copy for external tools.",
        )
    })?;
    if rev_parse_verify(&work_root, &format!("{oid}^{{commit}}")).is_none() {
        return Err(ProbeError::new(
            "history_commit_missing",
            "That commit is no longer present in this repository.",
        ));
    }
    let baseline = match rev_parse_verify(&work_root, &format!("{oid}^")) {
        Some(parent) => parent,
        None => empty_tree(&work_root)?,
    };
    Ok((work_root, baseline))
}

fn rev_parse_verify(work_root: &Path, rev: &str) -> Option<String> {
    let mut command = repo::user_git_command(work_root);
    command.args(["rev-parse", "--verify", "-q", rev]);
    let output = runner::run_with_limit(
        command,
        &AtomicBool::new(false),
        Duration::ZERO,
        Duration::from_secs(10),
        runner::DEFAULT_OUTPUT_LIMIT,
        |_, _| {},
    )
    .ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    (!value.is_empty()).then_some(value)
}

/// `git mktree` with empty stdin writes and prints the repository's empty
/// tree object — SHA-1 or SHA-256, without hardcoding either hash.
fn empty_tree(work_root: &Path) -> Result<String, ProbeError> {
    let mut command = repo::user_git_command(work_root);
    command.arg("mktree");
    let output = runner::run_with_limit(
        command,
        &AtomicBool::new(false),
        Duration::ZERO,
        Duration::from_secs(10),
        runner::DEFAULT_OUTPUT_LIMIT,
        |_, _| {},
    )?;
    let hash = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    if !output.status.success() || !crate::history::valid_oid(&hash) {
        return Err(ProbeError::new(
            "external_tool_failed",
            "Could not establish an empty baseline for the root commit.",
        ));
    }
    Ok(hash)
}

fn run_commit_difftool(
    work_root: &Path,
    baseline: &str,
    oid: &str,
    cancelled: &AtomicBool,
) -> Result<runner::CapturedOutput, ProbeError> {
    let mut command = repo::user_git_command(work_root);
    command.args(["difftool", "-y", "--no-prompt", "--trust-exit-code"]);
    command.args([baseline, oid]).arg("--");
    runner::run_with_limit(
        command,
        cancelled,
        Duration::ZERO,
        Duration::from_secs(3600),
        runner::DEFAULT_OUTPUT_LIMIT,
        |_, _| {},
    )
}

fn dispatch(
    state: &ToolState,
    sessions: &session::SessionState,
    snapshot_version: u64,
    purpose: ToolPurpose,
    work_root: &Path,
    raw: &[u8],
) -> Result<Dispatched, ProbeError> {
    let path = match write::raw_to_os(raw) {
        Ok(path) => work_root.join(path),
        Err(error) => return Ok((Outcome::Rejected, None, error.message, None)),
    };
    if state.cancelled.load(Ordering::SeqCst) {
        return Ok((
            Outcome::Cancelled,
            None,
            "Cancelled before the tool ran.".into(),
            None,
        ));
    }
    match purpose {
        // A commit diff is addressed by object id, not by snapshot file id;
        // it has its own entry point below and cannot be expressed here.
        ToolPurpose::DiffCommit => Ok((
            Outcome::Rejected,
            None,
            "Commit diffs are requested by object id, not by file.".into(),
            None,
        )),
        ToolPurpose::OpenFile => match open_file(&path) {
            Ok(()) => Ok((
                Outcome::Success,
                None,
                "File handed to the system opener.".into(),
                None,
            )),
            Err(error) => Ok((
                Outcome::Failed,
                None,
                "The system opener could not start.".into(),
                Some(error.message),
            )),
        },
        ToolPurpose::DiffWorktree | ToolPurpose::DiffStaged => {
            if purpose == ToolPurpose::DiffStaged {
                // commit_context applies the same version gate; only its
                // unborn answer matters here.
                match sessions.commit_context(snapshot_version) {
                    Ok((_, true)) => {
                        return Ok((
                            Outcome::Rejected,
                            None,
                            "This branch has no commits yet to diff staged files.".into(),
                            None,
                        ))
                    }
                    Err(error) => return Ok((Outcome::Rejected, None, error.message, None)),
                    Ok(_) => {}
                }
            }
            Ok(
                match run_difftool(work_root, &path, purpose, &state.cancelled) {
                    Ok(output) => {
                        let exit_code = output.status.code();
                        if output.status.success() {
                            (
                                Outcome::Success,
                                exit_code,
                                "Diff tool closed.".into(),
                                None,
                            )
                        } else {
                            (
                                Outcome::Failed,
                                exit_code,
                                "The diff tool reported a failure.".into(),
                                Some(first_stderr_line(&output.stderr)),
                            )
                        }
                    }
                    Err(error) if error.code == "process_cancelled" => (
                        Outcome::Cancelled,
                        None,
                        "Cancelled while the diff tool was running.".into(),
                        None,
                    ),
                    Err(error) => return Err(error),
                },
            )
        }
    }
}

/// Hands the absolute path to the OS opener without waiting for the launched
/// application. The intermediate launcher (xdg-open/open) exits quickly; the
/// reaper thread keeps the process table clean.
fn open_file(path: &Path) -> Result<(), ProbeError> {
    spawn_detached(opener_program(), path)
}

fn opener_program() -> &'static str {
    if cfg!(target_os = "macos") {
        "open"
    } else if cfg!(target_os = "windows") {
        // explorer.exe detaches by itself; never verified on Windows.
        "explorer.exe"
    } else {
        "xdg-open"
    }
}

fn spawn_detached(program: &str, path: &Path) -> Result<(), ProbeError> {
    let mut child = std::process::Command::new(program)
        .arg(path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|error| {
            ProbeError::new(
                "external_tool_failed",
                format!("Could not start {program}: {error}"),
            )
        })?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

/// `git difftool -y --no-prompt --trust-exit-code [--staged] -- <path>`:
/// one file at a time, the user's configured tool, and Git's exit code wired
/// to the tool result instead of always reporting success.
fn run_difftool(
    work_root: &Path,
    path: &Path,
    purpose: ToolPurpose,
    cancelled: &AtomicBool,
) -> Result<runner::CapturedOutput, ProbeError> {
    let mut command = repo::user_git_command(work_root);
    command.args(["difftool", "-y", "--no-prompt", "--trust-exit-code"]);
    if purpose == ToolPurpose::DiffStaged {
        command.arg("--staged");
    }
    command.arg("--").arg(path);
    runner::run_with_limit(
        command,
        cancelled,
        Duration::ZERO,
        Duration::from_secs(3600),
        runner::DEFAULT_OUTPUT_LIMIT,
        |_, _| {},
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn init_repo() -> tempfile::TempDir {
        let directory = tempfile::tempdir().unwrap();
        repo::git_with(
            directory.path(),
            &[],
            &["init", "--quiet", "--initial-branch=main"],
        );
        directory
    }

    fn file_id(view: &session::SnapshotView, display: &str) -> u32 {
        view.files
            .iter()
            .find(|file| file.display == display)
            .unwrap_or_else(|| panic!("{display} missing from snapshot"))
            .id
            .0
    }

    const COMMIT_ID: &[&str] = &[
        "-c",
        "user.name=guit test",
        "-c",
        "user.email=test@example.invalid",
    ];

    #[test]
    fn difftool_success_and_failure_follow_the_tool_exit_code() {
        let repository = init_repo();
        let root = repository.path();
        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        repo::git_with(root, COMMIT_ID, &["add", "--", "a.txt"]);
        repo::git_with(root, COMMIT_ID, &["commit", "-q", "-m", "base"]);
        // difftool only offers tracked modifications, not untracked files.
        std::fs::write(root.join("a.txt"), "two\n").unwrap();
        repo::git_with(root, &[], &["config", "diff.tool", "guitfake"]);
        repo::git_with(root, &[], &["config", "difftool.guitfake.cmd", "true"]);
        let sessions = session::SessionState::default();
        let view = session::open(&sessions, root).unwrap();
        let tools = ToolState::default();

        let result = execute(
            &tools,
            &sessions,
            view.version,
            file_id(&view, "a.txt"),
            ToolPurpose::DiffWorktree,
        )
        .unwrap();
        assert_eq!(
            (result.outcome, result.exit_code),
            (Outcome::Success, Some(0)),
            "details: {:?}",
            result.details
        );
        assert!(result.snapshot.is_some());

        repo::git_with(
            root,
            &[],
            &["config", "difftool.guitfake.cmd", "echo nope >&2; exit 3"],
        );
        let fresh = session::refresh(&sessions).unwrap().expect("snapshot");
        let result = execute(
            &tools,
            &sessions,
            fresh.version,
            file_id(&fresh, "a.txt"),
            ToolPurpose::DiffWorktree,
        )
        .unwrap();
        assert_eq!(result.outcome, Outcome::Failed);
        // Git turns any non-zero tool exit into its own fatal 128; the
        // tool's stderr is still preserved as the first details line.
        assert_eq!(result.exit_code, Some(128));
        assert_eq!(result.details.as_deref(), Some("nope"));
    }

    #[test]
    fn staged_diff_requires_head_and_stale_ids_are_rejected() {
        let repository = init_repo();
        let root = repository.path();
        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        let sessions = session::SessionState::default();
        let view = session::open(&sessions, root).unwrap();
        let tools = ToolState::default();

        let result = execute(
            &tools,
            &sessions,
            view.version,
            file_id(&view, "a.txt"),
            ToolPurpose::DiffStaged,
        )
        .unwrap();
        assert_eq!(result.outcome, Outcome::Rejected);
        assert!(result.message.contains("no commits"));
        assert_eq!(result.exit_code, None);

        // The rejection above re-read status, so the original view is now
        // stale; a tool request against it must not reach Git.
        let result = execute(
            &tools,
            &sessions,
            view.version,
            0,
            ToolPurpose::DiffWorktree,
        )
        .unwrap();
        assert_eq!(result.outcome, Outcome::Rejected);
        assert!(result.message.contains("rejected"));
    }

    #[test]
    fn cancellation_reports_cancelled_without_running_git() {
        let repository = init_repo();
        let root = repository.path();
        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        let sessions = session::SessionState::default();
        let view = session::open(&sessions, root).unwrap();
        let tools = ToolState::default();
        tools.begin().unwrap();
        tools.cancel();

        let result = run(
            &tools,
            &sessions,
            view.version,
            file_id(&view, "a.txt"),
            ToolPurpose::DiffWorktree,
        )
        .unwrap();
        tools.finish();
        assert_eq!(result.outcome, Outcome::Cancelled);
        assert_eq!(result.exit_code, None);
        assert!(result.snapshot.is_some(), "state is re-read after cancel");
    }

    #[test]
    fn queue_refuses_a_second_concurrent_tool() {
        let tools = ToolState::default();
        assert_eq!(tools.begin().unwrap(), 1);
        let error = tools.begin().unwrap_err();
        assert_eq!(error.code, "tool_busy");
        tools.finish();
        assert_eq!(tools.begin().unwrap(), 2);
        tools.finish();
    }

    #[test]
    fn opener_spawn_failure_is_reported_without_killing_the_call() {
        let directory = init_repo();
        let path = directory.path().join("a.txt");
        let error = spawn_detached("guit-nonexistent-opener", &path).unwrap_err();
        assert_eq!(error.code, "external_tool_failed");
        assert!(error.message.contains("guit-nonexistent-opener"));
    }

    #[cfg(unix)]
    #[test]
    fn opener_detaches_on_a_happy_spawn() {
        let directory = init_repo();
        let path = directory.path().join("a.txt");
        std::fs::write(&path, "one\n").unwrap();
        // `true` exits immediately; the reaper thread must not block the call.
        assert!(spawn_detached("/bin/true", &path).is_ok());
    }

    #[test]
    fn difftool_path_selection_reaches_the_named_file_byte_exact() {
        // The fake tool only runs if Git matched the pathspec, so a
        // tool-reported exit code proves the non-ASCII name survived the
        // round trip; `$1` is empty because difftool passes $LOCAL/$REMOTE
        // placeholders, not the pathspec, to the tool command.
        let repository = init_repo();
        let root = repository.path();
        std::fs::write(root.join("中文 文件.txt"), "one\n").unwrap();
        repo::git_with(root, COMMIT_ID, &["add", "--", "中文 文件.txt"]);
        repo::git_with(root, COMMIT_ID, &["commit", "-q", "-m", "base"]);
        std::fs::write(root.join("中文 文件.txt"), "two\n").unwrap();
        repo::git_with(root, &[], &["config", "diff.tool", "guitfake"]);
        repo::git_with(
            root,
            &[],
            &["config", "difftool.guitfake.cmd", "echo saw >&2; exit 4"],
        );
        let sessions = session::SessionState::default();
        let view = session::open(&sessions, root).unwrap();
        let tools = ToolState::default();

        let result = execute(
            &tools,
            &sessions,
            view.version,
            file_id(&view, "中文 文件.txt"),
            ToolPurpose::DiffWorktree,
        )
        .unwrap();
        assert_eq!(
            (result.outcome, result.exit_code),
            (Outcome::Failed, Some(128))
        );
        assert_eq!(
            result.details.as_deref(),
            Some("saw"),
            "the fake tool must have been launched for the named file"
        );
    }

    fn configure_fake_tool(root: &Path, script: &str) {
        repo::git_with(root, &[], &["config", "diff.tool", "guitfake"]);
        repo::git_with(root, &[], &["config", "difftool.guitfake.cmd", script]);
    }

    #[test]
    fn commit_diff_reaches_the_tool_even_for_a_root_commit() {
        let repository = init_repo();
        let root = repository.path();
        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        repo::git_with(root, COMMIT_ID, &["add", "--", "a.txt"]);
        repo::git_with(root, COMMIT_ID, &["commit", "-q", "-m", "initial"]);
        let output = std::process::Command::new("git")
            .arg("-c")
            .arg("core.autocrlf=false")
            .arg("-C")
            .arg(root)
            .args(["rev-parse", "HEAD"])
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/nonexistent-guit-test-config")
            .env("LC_ALL", "C")
            .output()
            .unwrap();
        let commit = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        assert!(crate::history::valid_oid(&commit));
        // A failing tool proves the whole chain ran: if the empty-tree
        // baseline were wrong, Git itself would fail before the tool.
        configure_fake_tool(root, "echo launched >&2; exit 4");
        let sessions = session::SessionState::default();
        session::open(&sessions, root).unwrap();
        let tools = ToolState::default();

        let result = execute_commit_diff(&tools, &sessions, &commit).unwrap();
        assert_eq!(
            (result.outcome, result.exit_code),
            (Outcome::Failed, Some(128)),
            "details: {:?}",
            result.details
        );
        assert_eq!(result.details.as_deref(), Some("launched"));
        assert_eq!(result.purpose, ToolPurpose::DiffCommit);
        assert!(result.snapshot.is_some());
    }

    #[test]
    fn commit_diff_refuses_without_a_session_or_a_live_commit() {
        let repository = init_repo();
        let root = repository.path();
        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        let tools = ToolState::default();
        let sessions = session::SessionState::default();

        let result = execute_commit_diff(&tools, &sessions, &"f".repeat(40)).unwrap();
        assert_eq!(result.outcome, Outcome::Rejected);
        assert!(result.message.contains("No repository session"));

        let view = session::open(&sessions, root).unwrap();
        let result = execute_commit_diff(&tools, &sessions, &"f".repeat(40)).unwrap();
        assert_eq!(result.outcome, Outcome::Rejected);
        assert!(result.message.contains("no longer present"));
        // The rejection re-read status like every other tool outcome.
        assert!(result.snapshot.is_some());
        let _ = view;
    }

    #[test]
    fn file_scoped_entry_rejects_the_commit_purpose() {
        let repository = init_repo();
        let root = repository.path();
        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        let sessions = session::SessionState::default();
        let view = session::open(&sessions, root).unwrap();
        let tools = ToolState::default();

        let result = execute(
            &tools,
            &sessions,
            view.version,
            file_id(&view, "a.txt"),
            ToolPurpose::DiffCommit,
        )
        .unwrap();
        assert_eq!(result.outcome, Outcome::Rejected);
        assert!(result.message.contains("object id"));
    }
}
