use crate::probe::{redact, ProbeError};
use crate::status::StatusEntry;
use crate::{repo, runner, session, status};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime};

/// What a stored confirmation permits. Discard reverts tracked work-tree
/// edits; Clean removes untracked items; DeleteBranch removes a ref whose
/// object id was captured at preview time. All share the one-time ticket flow.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PreviewKind {
    Discard,
    Clean,
    DeleteBranch,
    DeleteTag,
}

#[derive(Debug)]
struct Preview {
    work_root: PathBuf,
    kind: PreviewKind,
    paths: Vec<Vec<u8>>,
    /// Object id the branch pointed at when the delete was previewed.
    oid: Option<String>,
    /// -d refuses unmerged branches; the force flag records an explicit,
    /// separately confirmed second stage (never a silent -D).
    force: bool,
}

/// Serializes every Git write in the repository (plan/03: 同仓库写入严格串行).
/// One operation holds the slot at a time; a second submitter is refused with
/// `write_queue_busy` instead of queueing invisibly. Cancellation shares the
/// runner's atomic flag so a running Git process is killed by its group.
#[derive(Debug, Default)]
pub struct WriteState {
    busy: AtomicBool,
    cancelled: AtomicBool,
    op_counter: AtomicU64,
    previews: Mutex<HashMap<String, Preview>>,
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

    /// The live cancel flag of the held operation; branch writers pass it to
    /// the runner (process-group kill) and poll it before starting Git.
    pub(crate) fn cancel_flag(&self) -> &AtomicBool {
        &self.cancelled
    }

    fn stage_preview(&self, ticket: Preview) -> String {
        let nonce = new_nonce();
        self.previews.lock().unwrap().insert(nonce.clone(), ticket);
        nonce
    }

    /// One-time confirmation ticket for a ref deletion (branch or tag),
    /// bound to the name and the object id observed at preview time.
    pub(crate) fn stage_ref_delete(
        &self,
        kind: PreviewKind,
        work_root: PathBuf,
        name: String,
        oid: String,
        force: bool,
    ) -> String {
        self.stage_preview(Preview {
            work_root,
            kind,
            paths: vec![name.into_bytes()],
            oid: Some(oid),
            force,
        })
    }

    /// Consumes a delete ticket; the ref must still point at the stored
    /// oid before Git runs, so any drift forces a fresh preview.
    pub(crate) fn take_ref_delete(
        &self,
        nonce: &str,
        kind: PreviewKind,
    ) -> Option<(PathBuf, String, String, bool)> {
        let ticket = self.take_preview(nonce, kind)?;
        let name = String::from_utf8(ticket.paths.first()?.clone()).ok()?;
        let oid = ticket.oid?;
        Some((ticket.work_root, name, oid, ticket.force))
    }

    /// Confirmation nonces are single-use: the take removes them even when
    /// the follow-up check then refuses, forcing a fresh preview.
    fn take_preview(&self, nonce: &str, kind: PreviewKind) -> Option<Preview> {
        let removed = self.previews.lock().unwrap().remove(nonce);
        match removed {
            Some(ticket) if ticket.kind == kind => Some(ticket),
            Some(_) => None,
            None => None,
        }
    }

    pub(crate) fn clear_previews(&self) {
        self.previews.lock().unwrap().clear();
    }
}

/// Unguessable one-time token. `RandomState` draws fresh SipHash keys from
/// system entropy per instance, so two finishes are 128 bits of unpredictable
/// data — enough to bind a confirm click to the preview that produced it
/// without pulling in a cryptography dependency.
fn new_nonce() -> String {
    use std::hash::{BuildHasher, Hasher};
    let first = std::collections::hash_map::RandomState::new()
        .build_hasher()
        .finish();
    let second = std::collections::hash_map::RandomState::new()
        .build_hasher()
        .finish();
    let time = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|since| since.subsec_nanos() as u64)
        .unwrap_or(0);
    let counter = WRITE_COUNTER
        .get_or_init(|| AtomicU64::new(0))
        .fetch_add(1, Ordering::SeqCst);
    format!("{first:016x}{:016x}", second ^ time ^ counter)
}

static WRITE_COUNTER: OnceLock<AtomicU64> = OnceLock::new();

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum OperationKind {
    Stage,
    Unstage,
    Commit,
    Discard,
    Clean,
    BranchCreate,
    BranchSwitch,
    BranchRename,
    BranchDelete,
    TagCreate,
    TagDelete,
}

impl OperationKind {
    /// Git argument prefix plus the past-tense verb for the result message.
    /// Commit, discard, clean and the branch kinds run through their own
    /// runners, never this plan.
    fn plan(self) -> (&'static [&'static str], &'static str) {
        match self {
            OperationKind::Stage => (&["add"], "Staged"),
            OperationKind::Unstage => (&["restore", "--staged"], "Unstaged"),
            OperationKind::Commit => (&[], "Committed"),
            OperationKind::Discard => (&["restore", "--worktree"], "Discarded"),
            OperationKind::Clean => (&[], "Cleaned"),
            OperationKind::BranchCreate => (&[], "Created"),
            OperationKind::BranchSwitch => (&[], "Switched"),
            OperationKind::BranchRename => (&[], "Renamed"),
            OperationKind::BranchDelete => (&[], "Deleted"),
            OperationKind::TagCreate => (&[], "Created"),
            OperationKind::TagDelete => (&[], "Deleted"),
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

/// Commit the staged index. The message travels to Git only through a
/// private 0600 temp file (`-F`), removed as soon as Git exits; it never
/// appears in the result, in `details`, or in any log line this module
/// writes. Hooks and signing configuration belong to the user and run
/// untouched — no `--no-verify`, no forced GPG flags.
pub(crate) fn execute_commit(
    state: &WriteState,
    sessions: &session::SessionState,
    snapshot_version: u64,
    message: String,
    amend: bool,
) -> Result<OperationResult, ProbeError> {
    let operation_id = state.begin()?;
    let result = run_commit(state, sessions, snapshot_version, &message, amend);
    state.finish();
    result.map(|mut result| {
        result.operation_id = operation_id;
        result
    })
}

pub(crate) fn run_commit(
    state: &WriteState,
    sessions: &session::SessionState,
    snapshot_version: u64,
    message: &str,
    amend: bool,
) -> Result<OperationResult, ProbeError> {
    let mut outcome = Outcome::Success;
    let mut exit_code = None;
    let result_message;
    let mut details = None;
    if message.trim().is_empty() {
        outcome = Outcome::Rejected;
        result_message = "Commit message is empty.".into();
    } else {
        match sessions.commit_context(snapshot_version) {
            Err(error) => {
                outcome = Outcome::Rejected;
                result_message = error.message;
            }
            Ok((work_root, unborn)) => {
                if amend && unborn {
                    outcome = Outcome::Rejected;
                    result_message = "This branch has no commit to amend yet.".into();
                } else if state.cancelled.load(Ordering::SeqCst) {
                    outcome = Outcome::Cancelled;
                    result_message = "Cancelled before Git ran.".into();
                } else {
                    let message_file = tempfile::NamedTempFile::new().map_err(|error| {
                        ProbeError::new("commit_temp_failed", error.to_string())
                    })?;
                    let mut written = message_file.reopen().map_err(|error| {
                        ProbeError::new("commit_temp_failed", error.to_string())
                    })?;
                    use std::io::Write;
                    written.write_all(message.as_bytes()).map_err(|error| {
                        ProbeError::new("commit_temp_failed", error.to_string())
                    })?;
                    written
                        .write_all(b"\n")
                        .and_then(|_| written.sync_all())
                        .map_err(|error| {
                            ProbeError::new("commit_temp_failed", error.to_string())
                        })?;
                    drop(written);
                    let mut command = repo::user_git_command(&work_root);
                    command.args(["commit", "-F"]);
                    command.arg(message_file.path());
                    if amend {
                        command.arg("--amend");
                    }
                    match runner::run_with_limit(
                        command,
                        &state.cancelled,
                        Duration::ZERO,
                        Duration::from_secs(600),
                        runner::DEFAULT_OUTPUT_LIMIT,
                        |_, _| {},
                    ) {
                        Ok(output) => {
                            exit_code = output.status.code();
                            if output.status.success() {
                                result_message = if amend {
                                    "Amended the last commit.".into()
                                } else {
                                    "Commit completed.".into()
                                };
                            } else {
                                outcome = Outcome::Failed;
                                result_message = "git commit reported a failure.".into();
                                details = Some(first_stderr_line(&output.stderr));
                            }
                        }
                        Err(error) if error.code == "process_cancelled" => {
                            outcome = Outcome::Cancelled;
                            result_message = "Cancelled while the Git process was running.".into();
                        }
                        Err(error) => return Err(error),
                    }
                    // message_file drops here, after Git has read it.
                }
            }
        }
    }
    let snapshot = session::refresh(sessions)?;
    Ok(OperationResult {
        operation_id: 0,
        kind: OperationKind::Commit,
        outcome,
        exit_code,
        message: result_message,
        details,
        snapshot,
    })
}

/// What a discard confirmation covers: display names only (the frontend
/// never learns real paths), plus the fresh snapshot the preview re-read.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewResult {
    pub nonce: String,
    pub candidates: Vec<String>,
    pub dropped: Vec<String>,
    pub snapshot: session::SnapshotView,
    /// For a branch deletion, the object id the branch pointed at; None for
    /// discard/clean so the frontend never mistakes it for a file path.
    pub target_oid: Option<String>,
}

/// Recompute what a discard would touch, from a fresh Git read — never from
/// the client's list — and store it under a single-use nonce.
pub(crate) fn preview_discard(
    state: &WriteState,
    sessions: &session::SessionState,
    snapshot_version: u64,
    file_ids: &[u32],
) -> Result<PreviewResult, ProbeError> {
    let (work_root, requested) = sessions.resolve_files(snapshot_version, file_ids)?;
    let snapshot = session::refresh(sessions)?
        .ok_or_else(|| ProbeError::new("write_no_session", "No repository session is open."))?;
    let entries = status_index(sessions)?;
    let mut candidates = Vec::new();
    let mut dropped = Vec::new();
    for raw in requested {
        match entries.get(&raw) {
            Some(StatusEntry::Untracked { .. }) => {
                return Err(ProbeError::new(
                    "discard_untracked",
                    "Untracked files are removed by clean, not discarded; the request was refused.",
                ));
            }
            Some(StatusEntry::Unmerged { .. }) => {
                return Err(ProbeError::new(
                    "discard_conflict",
                    "Conflicted files must be resolved through a merge tool; discard refuses them.",
                ));
            }
            Some(entry) if worktree_dirty(entry) => candidates.push(raw),
            Some(_) | None => dropped.push(crate::model::display_name(&raw)),
        }
    }
    if candidates.is_empty() {
        return Err(ProbeError::new(
            "discard_nothing",
            "None of the selected files have work-tree changes to discard.",
        ));
    }
    let nonce = state.stage_preview(Preview {
        work_root,
        kind: PreviewKind::Discard,
        paths: candidates.clone(),
        oid: None,
        force: false,
    });
    Ok(PreviewResult {
        nonce,
        candidates: candidates
            .iter()
            .map(|raw| crate::model::display_name(raw))
            .collect(),
        dropped,
        snapshot,
        target_oid: None,
    })
}

pub(crate) fn discard_files(
    state: &WriteState,
    sessions: &session::SessionState,
    nonce: String,
) -> Result<OperationResult, ProbeError> {
    let operation_id = state.begin()?;
    let result = run_discard(state, sessions, &nonce);
    state.finish();
    result.map(|mut result| {
        result.operation_id = operation_id;
        result
    })
}

/// Assumes the queue slot is held; tests call this directly. The nonce is
/// consumed either way; a candidate-set mismatch refuses the write and tells
/// the UI to preview again (plan/04: 候选集变化即拒绝重确认).
pub(crate) fn run_discard(
    state: &WriteState,
    sessions: &session::SessionState,
    nonce: &str,
) -> Result<OperationResult, ProbeError> {
    let mut outcome = Outcome::Success;
    let mut exit_code = None;
    let message;
    let mut details = None;
    let Some(preview) = state.take_preview(nonce, PreviewKind::Discard) else {
        let snapshot = session::refresh(sessions)?;
        return Ok(OperationResult {
            operation_id: 0,
            kind: OperationKind::Discard,
            outcome: Outcome::Rejected,
            exit_code: None,
            message: "That confirmation has expired; preview the discard again.".into(),
            details: None,
            snapshot,
        });
    };
    let same_repo = sessions
        .current_identity()
        .is_some_and(|identity| identity.work_root.as_deref() == Some(preview.work_root.as_path()));
    if !same_repo {
        outcome = Outcome::Rejected;
        message = "The repository session changed after the preview; nothing was discarded.".into();
    } else if !restore_supported(&preview.work_root) {
        outcome = Outcome::Rejected;
        message = "This Git is too old for discarding; guit needs git restore (2.23+).".into();
    } else {
        match status_index(sessions) {
            Err(error) => return Err(error),
            Ok(entries) => {
                let unchanged = preview
                    .paths
                    .iter()
                    .all(|raw| entries.get(raw).is_some_and(worktree_dirty));
                if !unchanged {
                    outcome = Outcome::Rejected;
                    message =
                        "Files changed after the preview; nothing was discarded. Confirm again."
                            .into();
                } else if state.cancelled.load(Ordering::SeqCst) {
                    outcome = Outcome::Cancelled;
                    message = "Cancelled before Git ran.".into();
                } else {
                    match run_git_paths(
                        &preview.work_root,
                        &["restore", "--worktree"],
                        &preview.paths,
                        &state.cancelled,
                    ) {
                        Ok(output) => {
                            exit_code = output.status.code();
                            if output.status.success() && !output.truncated {
                                message = format!(
                                    "Discarded work-tree changes in {} file(s).",
                                    preview.paths.len()
                                );
                            } else {
                                outcome = Outcome::Failed;
                                message = "restore reported a failure.".into();
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
    }
    let snapshot = session::refresh(sessions)?;
    Ok(OperationResult {
        operation_id: 0,
        kind: OperationKind::Discard,
        outcome,
        exit_code,
        message,
        details,
        snapshot,
    })
}

/// Fresh porcelain-v2 read keyed by raw path bytes, used to recompute
/// destructive candidates independently of any client state.
fn status_index(
    sessions: &session::SessionState,
) -> Result<BTreeMap<Vec<u8>, StatusEntry>, ProbeError> {
    let identity = sessions
        .current_identity()
        .ok_or_else(|| ProbeError::new("write_no_session", "No repository session is open."))?;
    let raw = repo::status_output(&identity, true)?;
    let parsed = status::parse(&raw)?;
    Ok(parsed
        .entries
        .into_iter()
        .map(|entry| (entry.raw_path().clone(), entry))
        .collect())
}

fn worktree_dirty(entry: &StatusEntry) -> bool {
    match entry {
        StatusEntry::Tracked(entry) => entry.worktree_status != '.',
        StatusEntry::Rename(entry) => entry.tracked.worktree_status != '.',
        StatusEntry::Unmerged(_) | StatusEntry::Untracked { .. } => false,
    }
}

/// `git clean` rejects `-z`, so candidates come from `git clean -nd` lines,
/// which read "Would remove <path>" under `LC_ALL=C` (a directory entry ends
/// in `/`, reported as the directory itself). A line that does not parse is
/// an error, never a silently skipped item — a broken listing must not read
/// as "nothing to clean" (AGENTS: 绝不把解析失败呈现为干净仓库).
fn clean_candidates(work_root: &Path) -> Result<Vec<(Vec<u8>, bool)>, ProbeError> {
    let mut command = repo::user_git_command(work_root);
    command.args(["clean", "-nd"]);
    let output = runner::run_with_limit(
        command,
        &AtomicBool::new(false),
        Duration::ZERO,
        Duration::from_secs(60),
        runner::DEFAULT_OUTPUT_LIMIT,
        |_, _| {},
    )?;
    if !output.status.success() || output.truncated {
        return Err(ProbeError::new(
            "clean_preview_failed",
            "git clean could not list the untracked files.",
        ));
    }
    let mut candidates = Vec::new();
    for line in output
        .stdout
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
    {
        let Some(rest) = line.strip_prefix(b"Would remove ".as_slice()) else {
            return Err(ProbeError::new(
                "clean_preview_failed",
                "The untracked-file listing used an unknown format; nothing was cleaned.",
            ));
        };
        let directory = rest.strip_suffix(b"/".as_slice()).unwrap_or(rest);
        candidates.push((directory.to_vec(), directory.len() != rest.len()));
    }
    Ok(candidates)
}

/// Clean's preview: the full untracked set as reported by a fresh
/// `git clean -nd` (ignored files excluded), stored under a one-time nonce.
pub(crate) fn preview_clean(
    state: &WriteState,
    sessions: &session::SessionState,
    snapshot_version: u64,
) -> Result<PreviewResult, ProbeError> {
    let (work_root, _) = sessions.commit_context(snapshot_version)?;
    let found = clean_candidates(&work_root)?;
    if found.is_empty() {
        return Err(ProbeError::new(
            "clean_nothing",
            "There are no untracked files to remove.",
        ));
    }
    let snapshot = session::refresh(sessions)?
        .ok_or_else(|| ProbeError::new("write_no_session", "No repository session is open."))?;
    let mut paths = Vec::with_capacity(found.len());
    let mut candidates = Vec::with_capacity(found.len());
    for (raw, directory) in found {
        let mut name = crate::model::display_name(&raw);
        if directory {
            name.push('/');
        }
        candidates.push(name);
        paths.push(raw);
    }
    let nonce = state.stage_preview(Preview {
        work_root,
        kind: PreviewKind::Clean,
        paths,
        oid: None,
        force: false,
    });
    Ok(PreviewResult {
        nonce,
        candidates,
        dropped: Vec::new(),
        snapshot,
        target_oid: None,
    })
}

pub(crate) fn clean_files(
    state: &WriteState,
    sessions: &session::SessionState,
    nonce: String,
) -> Result<OperationResult, ProbeError> {
    let operation_id = state.begin()?;
    let result = run_clean(state, sessions, &nonce);
    state.finish();
    result.map(|mut result| {
        result.operation_id = operation_id;
        result
    })
}

/// Assumes the queue slot is held; tests call this directly. The stored
/// candidate set and a fresh `git clean -nd` must contain exactly the same
/// paths before Git runs; a match then deletes by explicit pathspec so the
/// execution can never touch anything the user did not confirm (plan/04).
pub(crate) fn run_clean(
    state: &WriteState,
    sessions: &session::SessionState,
    nonce: &str,
) -> Result<OperationResult, ProbeError> {
    let mut outcome = Outcome::Success;
    let mut exit_code = None;
    let message;
    let mut details = None;
    let Some(preview) = state.take_preview(nonce, PreviewKind::Clean) else {
        let snapshot = session::refresh(sessions)?;
        return Ok(OperationResult {
            operation_id: 0,
            kind: OperationKind::Clean,
            outcome: Outcome::Rejected,
            exit_code: None,
            message: "That confirmation has expired; preview the clean again.".into(),
            details: None,
            snapshot,
        });
    };
    let same_repo = sessions
        .current_identity()
        .is_some_and(|identity| identity.work_root.as_deref() == Some(preview.work_root.as_path()));
    if !same_repo {
        outcome = Outcome::Rejected;
        message = "The repository session changed after the preview; nothing was removed.".into();
    } else if state.cancelled.load(Ordering::SeqCst) {
        outcome = Outcome::Cancelled;
        message = "Cancelled before Git ran.".into();
    } else {
        let mut fresh = match clean_candidates(&preview.work_root) {
            Ok(found) => found.into_iter().map(|(raw, _)| raw).collect::<Vec<_>>(),
            Err(error) => return Err(error),
        };
        let mut expected = preview.paths.clone();
        fresh.sort();
        expected.sort();
        if fresh != expected {
            outcome = Outcome::Rejected;
            message =
                "Untracked files changed after the preview; nothing was removed. Confirm again."
                    .into();
        } else {
            match run_git_paths(
                &preview.work_root,
                &["clean", "-fd"],
                &preview.paths,
                &state.cancelled,
            ) {
                Ok(output) => {
                    exit_code = output.status.code();
                    if output.status.success() && !output.truncated {
                        message = format!("Removed {} untracked item(s).", preview.paths.len());
                    } else {
                        outcome = Outcome::Failed;
                        message = "git clean reported a failure.".into();
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
    let snapshot = session::refresh(sessions)?;
    Ok(OperationResult {
        operation_id: 0,
        kind: OperationKind::Clean,
        outcome,
        exit_code,
        message,
        details,
        snapshot,
    })
}

/// Cheap pre-flight for restore-based operations: `git --version` parsed with
/// the same gate the environment probe reports as `hasRestore`.
pub(crate) fn restore_supported(work_root: &Path) -> bool {
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

pub(crate) fn first_stderr_line(stderr: &[u8]) -> String {
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

    /// The write path uses the user's Git and their repository configuration,
    /// so tests pin identity and shadow a global `core.hooksPath` repo-locally.
    fn configure_commit_repo(root: &Path) {
        repo::git_with(root, &[], &["config", "user.name", "guit test"]);
        repo::git_with(root, &[], &["config", "user.email", "test@example.invalid"]);
        repo::git_with(root, &[], &["config", "core.hooksPath", ".git/hooks"]);
    }

    fn git_stdout(root: &Path, args: &[&str]) -> String {
        let output = std::process::Command::new("git")
            .args(args)
            .current_dir(root)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/nonexistent-guit-test-config")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("LC_ALL", "C")
            .output()
            .expect("git");
        assert!(output.status.success(), "git {args:?} failed");
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    }

    fn commit_count(root: &Path) -> usize {
        git_stdout(root, &["rev-list", "--count", "HEAD"])
            .parse()
            .expect("numeric count")
    }

    fn head_subject(root: &Path) -> String {
        git_stdout(root, &["log", "-1", "--format=%s"])
    }

    #[test]
    fn commit_success_creates_head_and_clears_the_staged_file() {
        let repository = init_repo();
        let root = repository.path();
        configure_commit_repo(root);
        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        let sessions = session::SessionState::default();
        let view = session::open(&sessions, root).unwrap();
        let writes = WriteState::default();
        execute_stage(
            &writes,
            &sessions,
            view.version,
            vec![file_id(&view, "a.txt")],
        )
        .unwrap();
        let staged = session::refresh(&sessions).unwrap().expect("snapshot");

        let result = execute_commit(
            &writes,
            &sessions,
            staged.version,
            "feature: one\n\nbody text".into(),
            false,
        )
        .unwrap();
        assert_eq!(
            (result.outcome, result.exit_code, result.kind),
            (Outcome::Success, Some(0), OperationKind::Commit)
        );
        assert_eq!(result.message, "Commit completed.");
        assert_eq!(commit_count(root), 1);
        assert_eq!(head_subject(root), "feature: one");
        let snapshot = result.snapshot.expect("re-read");
        assert!(snapshot.files.is_empty(), "commit leaves no changes");
    }

    #[test]
    fn empty_message_is_rejected_without_running_git() {
        let repository = init_repo();
        let root = repository.path();
        configure_commit_repo(root);
        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        repo::git_with(root, COMMIT_ID, &["add", "--", "a.txt"]);
        let sessions = session::SessionState::default();
        let view = session::open(&sessions, root).unwrap();
        let writes = WriteState::default();

        let result =
            execute_commit(&writes, &sessions, view.version, "  \n".into(), false).unwrap();
        assert_eq!(result.outcome, Outcome::Rejected);
        assert_eq!(result.exit_code, None);
        assert!(result.message.contains("empty"));
        // Rejection happened before Git ran: HEAD is still unborn and the
        // staged file waits for a real message.
        let snapshot = result.snapshot.expect("re-read");
        assert_eq!(is_staged(&snapshot, "a.txt"), Some("A"));
    }

    #[cfg(unix)]
    #[test]
    fn hook_rejection_fails_without_leaking_the_message() {
        use std::os::unix::fs::PermissionsExt;
        let repository = init_repo();
        let root = repository.path();
        configure_commit_repo(root);
        std::fs::write(root.join("base.txt"), "one\n").unwrap();
        repo::git_with(root, COMMIT_ID, &["add", "--", "base.txt"]);
        repo::git_with(root, COMMIT_ID, &["commit", "-q", "-m", "base"]);
        std::fs::write(root.join("a.txt"), "two\n").unwrap();
        repo::git_with(root, COMMIT_ID, &["add", "--", "a.txt"]);
        let hook = root.join(".git/hooks/pre-commit");
        std::fs::write(&hook, b"#!/bin/sh\necho 'hook declined' >&2\nexit 1\n").unwrap();
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();

        let sessions = session::SessionState::default();
        let view = session::open(&sessions, root).unwrap();
        let writes = WriteState::default();
        let result = execute_commit(
            &writes,
            &sessions,
            view.version,
            "hook-secret-勿泄密".into(),
            false,
        )
        .unwrap();
        assert_eq!(result.outcome, Outcome::Failed);
        assert_eq!(result.exit_code, Some(1));
        assert_eq!(commit_count(root), 1, "the hook must keep its veto");
        let serialized = serde_json::to_string(&result).unwrap();
        assert!(
            !serialized.contains("hook-secret"),
            "the message must never reach the result: {serialized}"
        );
        // The staged index survives so the user can fix and retry.
        let snapshot = result.snapshot.expect("re-read");
        assert_eq!(is_staged(&snapshot, "a.txt"), Some("A"));
    }

    #[cfg(unix)]
    #[test]
    fn signing_failure_is_reported_not_bypassed() {
        use std::os::unix::fs::PermissionsExt;
        let repository = init_repo();
        let root = repository.path();
        configure_commit_repo(root);
        let gpg = root.join("failing-gpg");
        std::fs::write(&gpg, b"#!/bin/sh\nexit 2\n").unwrap();
        std::fs::set_permissions(&gpg, std::fs::Permissions::from_mode(0o755)).unwrap();
        repo::git_with(root, &[], &["config", "commit.gpgsign", "true"]);
        repo::git_with(
            root,
            &[],
            &["config", "user.signingkey", "guit-nonexistent"],
        );
        repo::git_with(
            root,
            &[],
            &["config", "gpg.program", &gpg.to_string_lossy()],
        );
        const UNSIGNED_COMMIT: &[&str] = &[
            "-c",
            "commit.gpgsign=false",
            "-c",
            "user.name=guit test",
            "-c",
            "user.email=test@example.invalid",
        ];
        std::fs::write(root.join("base.txt"), "one\n").unwrap();
        repo::git_with(root, UNSIGNED_COMMIT, &["add", "--", "base.txt"]);
        repo::git_with(root, UNSIGNED_COMMIT, &["commit", "-q", "-m", "base"]);
        std::fs::write(root.join("a.txt"), "two\n").unwrap();
        repo::git_with(root, COMMIT_ID, &["add", "--", "a.txt"]);

        let sessions = session::SessionState::default();
        let view = session::open(&sessions, root).unwrap();
        let writes = WriteState::default();
        let result =
            execute_commit(&writes, &sessions, view.version, "signed".into(), false).unwrap();
        assert_eq!(result.outcome, Outcome::Failed);
        assert!(result.details.is_some(), "Git's reason must be preserved");
        assert_eq!(commit_count(root), 1, "no unsigned commit was smuggled in");
        let snapshot = result.snapshot.expect("re-read");
        assert_eq!(is_staged(&snapshot, "a.txt"), Some("A"));
    }

    #[test]
    fn amend_replaces_the_head_subject() {
        let repository = init_repo();
        let root = repository.path();
        configure_commit_repo(root);
        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        repo::git_with(root, COMMIT_ID, &["add", "--", "a.txt"]);
        repo::git_with(root, COMMIT_ID, &["commit", "-q", "-m", "first subject"]);

        let sessions = session::SessionState::default();
        let view = session::open(&sessions, root).unwrap();
        let writes = WriteState::default();
        let result = execute_commit(
            &writes,
            &sessions,
            view.version,
            "rewritten subject".into(),
            true,
        )
        .unwrap();
        assert_eq!(result.outcome, Outcome::Success);
        assert_eq!(result.message, "Amended the last commit.");
        assert_eq!(commit_count(root), 1, "amend replaces, never adds");
        assert_eq!(head_subject(root), "rewritten subject");
    }

    #[test]
    fn cancelled_commit_never_reaches_git_and_still_refreshes() {
        let repository = init_repo();
        let root = repository.path();
        configure_commit_repo(root);
        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        repo::git_with(root, COMMIT_ID, &["add", "--", "a.txt"]);
        let sessions = session::SessionState::default();
        let view = session::open(&sessions, root).unwrap();
        let writes = WriteState::default();
        writes.begin().unwrap();
        writes.cancel();

        let result =
            run_commit(&writes, &sessions, view.version, "cancelled intent", false).unwrap();
        writes.finish();
        assert_eq!(result.outcome, Outcome::Cancelled);
        assert_eq!(result.exit_code, None);
        // Nothing reached Git: the repository is still unborn.
        let snapshot = result.snapshot.expect("state re-read after cancel");
        assert_eq!(is_staged(&snapshot, "a.txt"), Some("A"));
    }

    #[test]
    fn unborn_head_allows_initial_commit_but_not_amend() {
        let repository = init_repo();
        let root = repository.path();
        configure_commit_repo(root);
        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        repo::git_with(root, COMMIT_ID, &["add", "--", "a.txt"]);
        let sessions = session::SessionState::default();
        let view = session::open(&sessions, root).unwrap();
        let writes = WriteState::default();

        let rejected =
            execute_commit(&writes, &sessions, view.version, "oops".into(), true).unwrap();
        assert_eq!(rejected.outcome, Outcome::Rejected);
        assert!(rejected.message.contains("amend"));
        assert_eq!(rejected.exit_code, None);

        let fresh = rejected.snapshot.expect("re-read");
        let initial = execute_commit(
            &writes,
            &sessions,
            fresh.version,
            "initial commit".into(),
            false,
        )
        .unwrap();
        assert_eq!(initial.outcome, Outcome::Success);
        assert_eq!(commit_count(root), 1);
    }

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

    /// Repository with one base commit containing `files` at their committed
    /// content, so discard tests start from tracked-clean state.
    fn repo_with_base(files: &[(&str, &str)]) -> tempfile::TempDir {
        let repository = init_repo();
        let root = repository.path().to_path_buf();
        for (name, content) in files {
            std::fs::write(root.join(name), content).unwrap();
            repo::git_with(&root, COMMIT_ID, &["add", "--", name]);
        }
        repo::git_with(&root, COMMIT_ID, &["commit", "-q", "-m", "base"]);
        repository
    }

    fn file_state(view: &session::SnapshotView, display: &str) -> (String, String) {
        view.files
            .iter()
            .find(|file| file.display == display)
            .map(|file| (file.index_status.clone(), file.worktree_status.clone()))
            .unwrap_or_default()
    }

    #[test]
    fn discard_round_trip_restores_only_the_worktree_side() {
        let repository = repo_with_base(&[("a.txt", "one\n")]);
        let root = repository.path();
        // Staged change followed by a further work-tree edit: discard must
        // revert the work tree to the INDEX version, keeping the staged entry.
        std::fs::write(root.join("a.txt"), "staged\n").unwrap();
        repo::git_with(root, COMMIT_ID, &["add", "--", "a.txt"]);
        std::fs::write(root.join("a.txt"), "unstaged\n").unwrap();

        let sessions = session::SessionState::default();
        let view = session::open(&sessions, root).unwrap();
        let writes = WriteState::default();
        let preview =
            preview_discard(&writes, &sessions, view.version, &[file_id(&view, "a.txt")]).unwrap();
        assert_eq!(preview.candidates, vec!["a.txt".to_string()]);
        assert!(preview.dropped.is_empty());

        let result = discard_files(&writes, &sessions, preview.nonce).unwrap();
        assert_eq!(
            (result.outcome, result.kind, result.exit_code),
            (Outcome::Success, OperationKind::Discard, Some(0))
        );
        assert_eq!(result.operation_id, 1);
        assert_eq!(
            std::fs::read_to_string(root.join("a.txt")).unwrap(),
            "staged\n",
            "restore --worktree reverts to the index, not HEAD"
        );
        let snapshot = result.snapshot.expect("state re-read after discard");
        assert_eq!(file_state(&snapshot, "a.txt"), ("M".into(), ".".into()));
    }

    #[test]
    fn discard_refuses_when_a_candidate_changed_after_the_preview() {
        let repository = repo_with_base(&[("a.txt", "one\n"), ("b.txt", "one\n")]);
        let root = repository.path();
        std::fs::write(root.join("a.txt"), "a dirty\n").unwrap();
        std::fs::write(root.join("b.txt"), "b dirty\n").unwrap();

        let sessions = session::SessionState::default();
        let view = session::open(&sessions, root).unwrap();
        let writes = WriteState::default();
        let ids = vec![file_id(&view, "a.txt"), file_id(&view, "b.txt")];
        let preview = preview_discard(&writes, &sessions, view.version, &ids).unwrap();
        assert_eq!(preview.candidates.len(), 2);

        // Outside influence cleans one candidate before the confirm click.
        repo::git_with(root, &[], &["restore", "--worktree", "--", "a.txt"]);
        let result = discard_files(&writes, &sessions, preview.nonce).unwrap();
        assert_eq!(result.outcome, Outcome::Rejected);
        assert!(result.message.contains("changed after the preview"));
        assert_eq!(result.exit_code, None, "Git never ran for the batch");
        assert_eq!(
            std::fs::read_to_string(root.join("b.txt")).unwrap(),
            "b dirty\n",
            "a refused confirmation must not discard anything"
        );
        let snapshot = result.snapshot.expect("re-read");
        assert_eq!(file_state(&snapshot, "b.txt"), (".".into(), "M".into()));
    }

    #[test]
    fn discard_nonce_is_consumed_by_the_first_confirmation() {
        let repository = repo_with_base(&[("a.txt", "one\n")]);
        let root = repository.path();
        std::fs::write(root.join("a.txt"), "a dirty\n").unwrap();

        let sessions = session::SessionState::default();
        let view = session::open(&sessions, root).unwrap();
        let writes = WriteState::default();
        let preview =
            preview_discard(&writes, &sessions, view.version, &[file_id(&view, "a.txt")]).unwrap();

        let first = discard_files(&writes, &sessions, preview.nonce.clone()).unwrap();
        assert_eq!(first.outcome, Outcome::Success);
        let snapshot = first.snapshot.expect("re-read");
        assert_eq!(
            file_state(&snapshot, "a.txt"),
            (String::new(), String::new())
        );

        // Replaying the same nonce cannot re-run the discard.
        let replay = discard_files(&writes, &sessions, preview.nonce).unwrap();
        assert_eq!(replay.outcome, Outcome::Rejected);
        assert!(replay.message.contains("expired"));
        std::fs::write(root.join("a.txt"), "a dirty again\n").unwrap();
        let after_replay = session::refresh(&sessions).unwrap().expect("session");
        assert_eq!(file_state(&after_replay, "a.txt"), (".".into(), "M".into()));
    }

    #[test]
    fn discard_preview_refuses_untracked_files_before_touching_anything() {
        let repository = repo_with_base(&[("a.txt", "one\n")]);
        let root = repository.path();
        std::fs::write(root.join("a.txt"), "a dirty\n").unwrap();
        std::fs::write(root.join("u.txt"), "untracked\n").unwrap();

        let sessions = session::SessionState::default();
        let view = session::open(&sessions, root).unwrap();
        let writes = WriteState::default();
        let ids = vec![file_id(&view, "a.txt"), file_id(&view, "u.txt")];
        let error = preview_discard(&writes, &sessions, view.version, &ids).unwrap_err();
        assert_eq!(error.code, "discard_untracked");
        // The refusal happens before staging a ticket or running Git.
        assert_eq!(
            std::fs::read_to_string(root.join("a.txt")).unwrap(),
            "a dirty\n"
        );
        assert!(writes.take_preview("any", PreviewKind::Discard).is_none());
    }

    #[test]
    fn staged_only_changes_are_dropped_from_the_discard_candidate_set() {
        let repository = repo_with_base(&[("a.txt", "one\n"), ("b.txt", "one\n")]);
        let root = repository.path();
        // a.txt: staged only (clean work tree); b.txt: work-tree dirty.
        std::fs::write(root.join("a.txt"), "staged\n").unwrap();
        repo::git_with(root, COMMIT_ID, &["add", "--", "a.txt"]);
        std::fs::write(root.join("b.txt"), "b dirty\n").unwrap();

        let sessions = session::SessionState::default();
        let view = session::open(&sessions, root).unwrap();
        let writes = WriteState::default();
        let ids = vec![file_id(&view, "a.txt"), file_id(&view, "b.txt")];
        let preview = preview_discard(&writes, &sessions, view.version, &ids).unwrap();
        assert_eq!(preview.candidates, vec!["b.txt".to_string()]);
        assert_eq!(preview.dropped, vec!["a.txt".to_string()]);

        let result = discard_files(&writes, &sessions, preview.nonce).unwrap();
        assert_eq!(result.outcome, Outcome::Success);
        let snapshot = result.snapshot.expect("re-read");
        // Only b.txt was restored; a.txt keeps its staged index entry.
        assert_eq!(file_state(&snapshot, "a.txt"), ("M".into(), ".".into()));
        assert_eq!(
            file_state(&snapshot, "b.txt"),
            (String::new(), String::new())
        );
        assert_eq!(
            std::fs::read_to_string(root.join("a.txt")).unwrap(),
            "staged\n",
            "discard never touches the index side"
        );
    }

    #[test]
    fn clean_preview_lists_files_and_directories_and_removes_exactly_those() {
        let repository = repo_with_base(&[("base.txt", "one\n"), (".gitignore", "i.txt\n")]);
        let root = repository.path();
        std::fs::write(root.join("u1.txt"), "untracked\n").unwrap();
        std::fs::create_dir(root.join("nested")).unwrap();
        std::fs::write(root.join("nested/u2.txt"), "deep\n").unwrap();
        std::fs::write(root.join("i.txt"), "ignored\n").unwrap();
        std::fs::write(root.join("base.txt"), "dirty tracked\n").unwrap();

        let sessions = session::SessionState::default();
        let view = session::open(&sessions, root).unwrap();
        let writes = WriteState::default();
        let preview = preview_clean(&writes, &sessions, view.version).unwrap();
        assert!(
            preview.candidates.contains(&"u1.txt".to_string()),
            "{:?}",
            preview.candidates
        );
        assert!(
            preview.candidates.contains(&"nested/".to_string()),
            "directories are reported as the directory itself"
        );
        assert!(
            !preview
                .candidates
                .iter()
                .any(|name| name == "i.txt" || name == "base.txt" || name == ".gitignore"),
            "ignored and tracked files must never be clean candidates: {:?}",
            preview.candidates
        );

        let result = clean_files(&writes, &sessions, preview.nonce).unwrap();
        assert_eq!(
            (result.outcome, result.kind, result.exit_code),
            (Outcome::Success, OperationKind::Clean, Some(0))
        );
        assert!(!root.join("u1.txt").exists());
        assert!(!root.join("nested").exists());
        assert_eq!(
            std::fs::read_to_string(root.join("i.txt")).unwrap(),
            "ignored\n",
            "clean without -x never removes ignored files"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("base.txt")).unwrap(),
            "dirty tracked\n",
            "clean never touches tracked files"
        );
        let snapshot = result.snapshot.expect("state re-read after clean");
        assert_eq!(
            file_state(&snapshot, "u1.txt"),
            (String::new(), String::new())
        );
        assert_eq!(file_state(&snapshot, "base.txt"), (".".into(), "M".into()));
    }

    #[test]
    fn clean_refuses_when_untracked_files_grow_after_the_preview() {
        let repository = repo_with_base(&[("base.txt", "one\n")]);
        let root = repository.path();
        std::fs::write(root.join("u1.txt"), "untracked\n").unwrap();

        let sessions = session::SessionState::default();
        let view = session::open(&sessions, root).unwrap();
        let writes = WriteState::default();
        let preview = preview_clean(&writes, &sessions, view.version).unwrap();

        // A new untracked file appears between preview and confirmation.
        std::fs::write(root.join("u2.txt"), "arrived later\n").unwrap();
        let result = clean_files(&writes, &sessions, preview.nonce).unwrap();
        assert_eq!(result.outcome, Outcome::Rejected);
        assert!(result.message.contains("changed after the preview"));
        assert_eq!(result.exit_code, None, "git clean never ran");
        assert_eq!(
            std::fs::read_to_string(root.join("u1.txt")).unwrap(),
            "untracked\n",
            "a refused clean deletes nothing"
        );
        assert!(root.join("u2.txt").exists());
    }

    #[test]
    fn clean_nonce_is_consumed_by_the_first_confirmation() {
        let repository = repo_with_base(&[("base.txt", "one\n")]);
        let root = repository.path();
        std::fs::write(root.join("u1.txt"), "untracked\n").unwrap();

        let sessions = session::SessionState::default();
        let view = session::open(&sessions, root).unwrap();
        let writes = WriteState::default();
        let preview = preview_clean(&writes, &sessions, view.version).unwrap();
        let first = clean_files(&writes, &sessions, preview.nonce.clone()).unwrap();
        assert_eq!(first.outcome, Outcome::Success);

        let replay = clean_files(&writes, &sessions, preview.nonce).unwrap();
        assert_eq!(replay.outcome, Outcome::Rejected);
        assert!(replay.message.contains("expired"));
    }

    #[test]
    fn clean_preview_gates_on_snapshot_version_and_non_empty_candidates() {
        let repository = repo_with_base(&[("base.txt", "one\n")]);
        let root = repository.path();
        std::fs::write(root.join("u1.txt"), "untracked\n").unwrap();
        let sessions = session::SessionState::default();
        let view = session::open(&sessions, root).unwrap();
        let writes = WriteState::default();

        // A superseded snapshot cannot even start a preview.
        session::refresh(&sessions).unwrap().expect("fresh version");
        let error = preview_clean(&writes, &sessions, view.version).unwrap_err();
        assert_eq!(error.code, "write_stale_snapshot");

        // A repository without untracked files reports nothing to clean
        // instead of staging an empty confirmation.
        let live = session::refresh(&sessions).unwrap().expect("session");
        std::fs::remove_file(root.join("u1.txt")).unwrap();
        let error = preview_clean(&writes, &sessions, live.version).unwrap_err();
        assert_eq!(error.code, "clean_nothing");
    }
}
