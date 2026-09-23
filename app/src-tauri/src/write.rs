use crate::probe::{redact, ProbeError};
use crate::{repo, runner, session};
use serde::Serialize;
use std::ffi::OsString;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

/// Serializes every Git write in the repository (plan/03: 同仓库写入严格串行).
/// One operation holds the slot at a time; a second submitter is refused with
/// `write_queue_busy` instead of queueing invisibly. Cancellation shares the
/// runner's atomic flag so a running Git process is killed by its group.
#[derive(Debug, Default)]
pub struct WriteState {
    busy: AtomicBool,
    cancelled: AtomicBool,
    op_counter: AtomicU64,
}

impl WriteState {
    /// Takes the single queue slot and returns the operation ID. Every write
    /// command enters through here, which is also the double-submit guard.
    pub(crate) fn begin(&self) -> Result<u64, ProbeError> {
        self.busy
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map_err(|_| ProbeError::new("write_queue_busy", "Another write is still running."))?;
        self.cancelled.store(false, Ordering::SeqCst);
        Ok(self.op_counter.fetch_add(1, Ordering::SeqCst) + 1)
    }

    pub(crate) fn finish(&self) {
        self.busy.store(false, Ordering::SeqCst);
    }

    pub(crate) fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum OperationKind {
    Stage,
    Unstage,
}

impl OperationKind {
    /// Git argument prefix plus the past-tense verb for the result message.
    fn plan(self) -> (&'static [&'static str], &'static str) {
        match self {
            OperationKind::Stage => (&["add"], "Staged"),
            OperationKind::Unstage => (&["restore", "--staged"], "Unstaged"),
        }
    }

    /// `git restore` only exists from 2.23; staging works on any supported Git.
    fn needs_restore(self) -> bool {
        matches!(self, OperationKind::Unstage)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Outcome {
    Success,
    Failed,
    Cancelled,
    /// Refused before touching Git (stale snapshot, unknown file, bare repo).
    Rejected,
}

/// Uniform answer for write operations (plan/03 数据契约). The embedded
/// snapshot is Git's actual state re-read after success, failure or
/// cancellation; the frontend applies it through the version guard.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationResult {
    pub operation_id: u64,
    pub kind: OperationKind,
    pub outcome: Outcome,
    pub exit_code: Option<i32>,
    pub message: String,
    /// Redacted first line of Git's stderr on failure; never raw output.
    pub details: Option<String>,
    pub snapshot: Option<session::SnapshotView>,
}

pub(crate) fn execute(
    state: &WriteState,
    sessions: &session::SessionState,
    snapshot_version: u64,
    file_ids: Vec<u32>,
    kind: OperationKind,
) -> Result<OperationResult, ProbeError> {
    let operation_id = state.begin()?;
    let result = run_write(state, sessions, snapshot_version, file_ids, kind);
    state.finish();
    result.map(|mut result| {
        result.operation_id = operation_id;
        result
    })
}

/// Runs one path-scoped write for the resolved files. Assumes the queue slot
/// is held; tests call this directly to pre-arm cancellation deterministically.
pub(crate) fn run_write(
    state: &WriteState,
    sessions: &session::SessionState,
    snapshot_version: u64,
    file_ids: Vec<u32>,
    kind: OperationKind,
) -> Result<OperationResult, ProbeError> {
    let (git_prefix, verb) = kind.plan();
    let mut outcome = Outcome::Success;
    let mut exit_code = None;
    let message;
    let mut details = None;
    match sessions.resolve_files(snapshot_version, &file_ids) {
        Err(error) => {
            outcome = Outcome::Rejected;
            message = error.message;
        }
        Ok((work_root, targets)) => {
            if kind.needs_restore() && !restore_supported(&work_root) {
                outcome = Outcome::Rejected;
                message =
                    "This Git is too old for unstaging; guit needs git restore (2.23+).".into();
            } else if state.cancelled.load(Ordering::SeqCst) {
                outcome = Outcome::Cancelled;
                message = "Cancelled before Git ran.".into();
            } else {
                match run_git_paths(&work_root, git_prefix, &targets, &state.cancelled) {
                    Ok(output) => {
                        exit_code = output.status.code();
                        if output.status.success() && !output.truncated {
                            message = format!("{} {} file(s).", verb, targets.len());
                        } else {
                            outcome = Outcome::Failed;
                            message = format!("{} reported a failure.", git_prefix[0]);
                            details = Some(first_stderr_line(&output.stderr));
                        }
                    }
                    Err(error) if error.code == "process_cancelled" => {
                        outcome = Outcome::Cancelled;
                        message = "Cancelled while the Git process was running.".into();
                    }
                    Err(error) => return Err(error),
                }
            }
        }
    }
    // Success, failure and cancellation all end with a re-read of the real
    // Git state; the result is wrong if that read fails.
    let snapshot = session::refresh(sessions)?;
    Ok(OperationResult {
        // Assigned by the queue wrapper so every entry point reports it.
        operation_id: 0,
        kind,
        outcome,
        exit_code,
        message,
        details,
        snapshot,
    })
}

/// Cheap pre-flight for restore-based operations: `git --version` parsed with
/// the same gate the environment probe reports as `hasRestore`.
fn restore_supported(work_root: &Path) -> bool {
    let mut command = repo::user_git_command(work_root);
    command.arg("--version");
    match runner::run(
        command,
        &AtomicBool::new(false),
        Duration::ZERO,
        Duration::from_secs(10),
        |_, _| {},
    ) {
        Ok(output) if output.status.success() => {
            crate::probe::version_at_least(&String::from_utf8_lossy(&output.stdout), (2, 23))
        }
        _ => false,
    }
}

/// `git <args…> -- <paths…>` with argument arrays only — paths arrive as the
/// exact bytes Git reported, so no shell or display-name round trip.
fn run_git_paths(
    work_root: &Path,
    git_prefix: &[&str],
    targets: &[Vec<u8>],
    cancelled: &AtomicBool,
) -> Result<runner::CapturedOutput, ProbeError> {
    let mut command = repo::user_git_command(work_root);
    command.args(git_prefix);
    command.arg("--");
    command.args(
        targets
            .iter()
            .map(|target| raw_to_os(target))
            .collect::<Result<Vec<OsString>, ProbeError>>()?,
    );
    runner::run_with_limit(
        command,
        cancelled,
        Duration::ZERO,
        Duration::from_secs(120),
        runner::DEFAULT_OUTPUT_LIMIT,
        |_, _| {},
    )
}

pub(crate) fn raw_to_os(raw: &[u8]) -> Result<OsString, ProbeError> {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStringExt;
        return Ok(OsString::from_vec(raw.to_vec()));
    }
    #[cfg(not(unix))]
    {
        String::from_utf8(raw.to_vec())
            .map(OsString::from)
            .map_err(|_| {
                ProbeError::new(
                    "write_path_unrepresentable",
                    "A file path cannot be represented on this platform; the write was refused.",
                )
            })
    }
}

fn first_stderr_line(stderr: &[u8]) -> String {
    let text = String::from_utf8_lossy(stderr);
    let line = text.lines().next().unwrap_or("").trim();
    let mut bounded = String::new();
    for ch in redact(line).chars() {
        if bounded.len() + ch.len_utf8() > 500 {
            break;
        }
        bounded.push(ch);
    }
    bounded
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

    fn is_staged<'a>(view: &'a session::SnapshotView, display: &str) -> Option<&'a str> {
        view.files
            .iter()
            .find(|file| file.display == display)
            .map(|file| file.index_status.as_str())
    }

    fn execute_stage(
        state: &WriteState,
        sessions: &session::SessionState,
        version: u64,
        ids: Vec<u32>,
    ) -> Result<OperationResult, ProbeError> {
        execute(state, sessions, version, ids, OperationKind::Stage)
    }

    fn run_stage(
        state: &WriteState,
        sessions: &session::SessionState,
        version: u64,
        ids: Vec<u32>,
    ) -> Result<OperationResult, ProbeError> {
        run_write(state, sessions, version, ids, OperationKind::Stage)
    }

    #[test]
    fn stage_success_returns_fresher_snapshot_and_operation_id() {
        let repository = init_repo();
        std::fs::write(repository.path().join("a.txt"), "one\n").unwrap();
        let sessions = session::SessionState::default();
        let view = session::open(&sessions, repository.path()).unwrap();
        let writes = WriteState::default();

        let result = execute_stage(
            &writes,
            &sessions,
            view.version,
            vec![file_id(&view, "a.txt")],
        )
        .unwrap();
        assert_eq!(
            (result.outcome, result.exit_code),
            (Outcome::Success, Some(0))
        );
        assert_eq!(result.operation_id, 1);
        let snapshot = result.snapshot.expect("state re-read after write");
        assert!(snapshot.version > view.version);
        assert_eq!(is_staged(&snapshot, "a.txt"), Some("A"));
        // Second operation gets a new id from the same queue.
        let second = execute_stage(&writes, &sessions, view.version, vec![]).unwrap();
        assert_eq!(second.operation_id, 2);
        assert_eq!(second.outcome, Outcome::Rejected);
    }

    #[test]
    fn stale_snapshot_is_rejected_without_touching_git() {
        let repository = init_repo();
        std::fs::write(repository.path().join("a.txt"), "one\n").unwrap();
        let sessions = session::SessionState::default();
        let view = session::open(&sessions, repository.path()).unwrap();
        let fresh = session::refresh(&sessions).unwrap().expect("session open");
        let writes = WriteState::default();

        let result = execute_stage(
            &writes,
            &sessions,
            view.version,
            vec![file_id(&fresh, "a.txt")],
        )
        .unwrap();
        assert_eq!(result.outcome, Outcome::Rejected);
        assert!(result.message.contains("rejected"));
        assert!(result.exit_code.is_none());
        let snapshot = result.snapshot.expect("re-read even on rejection");
        assert_eq!(is_staged(&snapshot, "a.txt"), Some("?"));
    }

    #[test]
    fn unknown_file_id_rejects_the_whole_request() {
        let repository = init_repo();
        std::fs::write(repository.path().join("a.txt"), "one\n").unwrap();
        std::fs::write(repository.path().join("b.txt"), "two\n").unwrap();
        let sessions = session::SessionState::default();
        let view = session::open(&sessions, repository.path()).unwrap();
        let writes = WriteState::default();

        // A valid ID mixed with a stale one must not stage anything.
        let result = execute_stage(
            &writes,
            &sessions,
            view.version,
            vec![file_id(&view, "a.txt"), 9999],
        )
        .unwrap();
        assert_eq!(result.outcome, Outcome::Rejected);
        let snapshot = result.snapshot.expect("re-read");
        assert_eq!(is_staged(&snapshot, "a.txt"), Some("?"));
        assert_eq!(is_staged(&snapshot, "b.txt"), Some("?"));
    }

    #[test]
    fn batch_call_stages_all_ids_and_an_old_snapshot_batch_is_dead() {
        let repository = init_repo();
        let root = repository.path();
        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        std::fs::write(root.join("b.txt"), "two\n").unwrap();
        let sessions = session::SessionState::default();
        let view = session::open(&sessions, root).unwrap();
        let ids: Vec<u32> = view.files.iter().map(|file| file.id.0).collect();
        assert_eq!(ids.len(), 2);
        let writes = WriteState::default();

        let result = execute_stage(&writes, &sessions, view.version, ids.clone()).unwrap();
        assert_eq!(result.outcome, Outcome::Success);
        let snapshot = result.snapshot.expect("re-read");
        assert_eq!(is_staged(&snapshot, "a.txt"), Some("A"));
        assert_eq!(is_staged(&snapshot, "b.txt"), Some("A"));

        // File IDs restart from zero per snapshot, so a superseded batch
        // would numerically "fit" the new table — the version gate is what
        // makes old ID sets unusable, and nothing runs when it trips.
        let result = execute_stage(&writes, &sessions, view.version, ids).unwrap();
        assert_eq!(result.outcome, Outcome::Rejected);
        let snapshot = result.snapshot.expect("re-read");
        assert_eq!(is_staged(&snapshot, "a.txt"), Some("A"));
        assert_eq!(is_staged(&snapshot, "b.txt"), Some("A"));
    }

    #[test]
    fn queue_refuses_a_second_concurrent_write() {
        let writes = WriteState::default();
        let first = writes.begin().unwrap();
        assert_eq!(first, 1);
        let error = writes.begin().unwrap_err();
        assert_eq!(error.code, "write_queue_busy");
        writes.finish();
        assert_eq!(writes.begin().unwrap(), 2);
        writes.finish();
    }

    #[test]
    fn chinese_and_space_paths_stage_byte_exact() {
        let repository = init_repo();
        std::fs::write(repository.path().join("中文 文件.txt"), "one\n").unwrap();
        std::fs::write(repository.path().join("other.txt"), "two\n").unwrap();
        let sessions = session::SessionState::default();
        let view = session::open(&sessions, repository.path()).unwrap();
        let writes = WriteState::default();

        let result = execute_stage(
            &writes,
            &sessions,
            view.version,
            vec![file_id(&view, "中文 文件.txt")],
        )
        .unwrap();
        assert_eq!(result.outcome, Outcome::Success);
        let snapshot = result.snapshot.expect("re-read");
        assert_eq!(is_staged(&snapshot, "中文 文件.txt"), Some("A"));
        assert_eq!(is_staged(&snapshot, "other.txt"), Some("?"));
    }

    #[test]
    fn cancellation_reports_cancelled_and_still_rereads_state() {
        let repository = init_repo();
        std::fs::write(repository.path().join("a.txt"), "one\n").unwrap();
        let sessions = session::SessionState::default();
        let view = session::open(&sessions, repository.path()).unwrap();
        let writes = WriteState::default();
        writes.begin().unwrap();
        writes.cancel();

        let result = run_stage(
            &writes,
            &sessions,
            view.version,
            vec![file_id(&view, "a.txt")],
        )
        .unwrap();
        writes.finish();
        assert_eq!(result.outcome, Outcome::Cancelled);
        assert_eq!(result.exit_code, None);
        let snapshot = result.snapshot.expect("state re-read after cancel");
        assert_eq!(is_staged(&snapshot, "a.txt"), Some("?"));
    }

    #[test]
    fn bare_repository_writes_are_rejected() {
        let repository = tempfile::tempdir().unwrap();
        repo::git_with(
            repository.path(),
            &[],
            &["init", "--quiet", "--bare", "--initial-branch=main"],
        );
        let sessions = session::SessionState::default();
        let view = session::open(&sessions, repository.path()).unwrap();
        let writes = WriteState::default();

        let result = execute_stage(&writes, &sessions, view.version, vec![0]).unwrap();
        assert_eq!(result.outcome, Outcome::Rejected);
        assert!(result.message.contains("bare"));
    }

    const COMMIT_ID: &[&str] = &[
        "-c",
        "user.name=guit test",
        "-c",
        "user.email=test@example.invalid",
    ];

    #[test]
    fn unstage_reverts_only_the_index_side_of_a_both_sides_file() {
        let repository = init_repo();
        let root = repository.path();
        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        repo::git_with(root, COMMIT_ID, &["add", "--", "a.txt"]);
        repo::git_with(root, COMMIT_ID, &["commit", "-q", "-m", "base"]);
        std::fs::write(root.join("a.txt"), "two\n").unwrap();
        repo::git_with(root, COMMIT_ID, &["add", "--", "a.txt"]);
        std::fs::write(root.join("a.txt"), "three\n").unwrap();

        let sessions = session::SessionState::default();
        let view = session::open(&sessions, root).unwrap();
        let file = view
            .files
            .iter()
            .find(|file| file.display == "a.txt")
            .unwrap();
        assert!(file.staged && file.unstaged);
        let writes = WriteState::default();

        let result = execute(
            &writes,
            &sessions,
            view.version,
            vec![file.id.0],
            OperationKind::Unstage,
        )
        .unwrap();
        assert_eq!(
            (result.outcome, result.exit_code, result.kind),
            (Outcome::Success, Some(0), OperationKind::Unstage)
        );
        assert!(result.message.starts_with("Unstaged"));
        let snapshot = result.snapshot.expect("re-read");
        let file = snapshot
            .files
            .iter()
            .find(|file| file.display == "a.txt")
            .expect("still changed");
        assert_eq!(
            (file.index_status.as_str(), file.worktree_status.as_str()),
            (".", "M")
        );
        assert!(!file.staged && file.unstaged);

        // Re-staging the same (new) file ID moves the work-tree side in.
        let again = execute(
            &writes,
            &sessions,
            snapshot.version,
            vec![file.id.0],
            OperationKind::Stage,
        )
        .unwrap();
        assert_eq!(again.outcome, Outcome::Success);
        let final_snapshot = again.snapshot.expect("re-read");
        let file = final_snapshot
            .files
            .iter()
            .find(|file| file.display == "a.txt")
            .expect("still staged");
        assert_eq!(
            (file.index_status.as_str(), file.worktree_status.as_str()),
            ("M", ".")
        );
    }

    #[test]
    fn unstage_of_a_newly_added_file_returns_it_to_untracked() {
        let repository = init_repo();
        let root = repository.path();
        std::fs::write(root.join("base.txt"), "one\n").unwrap();
        repo::git_with(root, COMMIT_ID, &["add", "--", "base.txt"]);
        repo::git_with(root, COMMIT_ID, &["commit", "-q", "-m", "base"]);
        std::fs::write(root.join("新 文件.txt"), "new\n").unwrap();
        repo::git_with(root, COMMIT_ID, &["add", "--", "新 文件.txt"]);

        let sessions = session::SessionState::default();
        let view = session::open(&sessions, root).unwrap();
        let file = view
            .files
            .iter()
            .find(|file| file.display == "新 文件.txt")
            .expect("staged new file");
        assert!(file.staged);
        let writes = WriteState::default();

        let result = execute(
            &writes,
            &sessions,
            view.version,
            vec![file.id.0],
            OperationKind::Unstage,
        )
        .unwrap();
        assert_eq!(result.outcome, Outcome::Success);
        let snapshot = result.snapshot.expect("re-read");
        let file = snapshot
            .files
            .iter()
            .find(|file| file.display == "新 文件.txt")
            .expect("still listed");
        assert!(file.untracked);
        assert_eq!(file.index_status, "?");
        assert_eq!(
            std::fs::read_to_string(root.join("新 文件.txt")).unwrap(),
            "new\n",
            "unstage must never delete content"
        );
    }
}
