//! Stash operations. The frontend addresses
//! entries only by their list position (`u32`); this module is the sole
//! place that turns a position into a `stash@{N}` selector string, so no
//! ref-syntax typed by a client ever reaches Git. Apply keeps the entry,
//! so it is version-gated only; pop and drop consume the same one-time
//! confirmation tickets as tag/branch deletion, bound to the entry's
//! commit oid captured at preview time.

use crate::probe::ProbeError;
use crate::repo::RepoIdentity;
use crate::status::StatusEntry;
use crate::write::{
    self, OperationKind, OperationResult, Outcome, PreviewKind, PreviewResult, WriteState,
};
use crate::{branches, history, session};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

/// Read-only helpers never participate in write cancellation; they run
/// against this permanently-unset flag instead of borrowing a queue slot.
static NO_CANCEL: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StashEntry {
    pub index: u32,
    pub date: String,
    pub subject: String,
}

fn selector(index: u32) -> String {
    format!("stash@{{{index}}}")
}

fn protocol_error() -> ProbeError {
    ProbeError::new(
        "stash_protocol_error",
        "The stash listing did not match Git's expected format; refusing to guess.",
    )
}

/// `git stash list` is a log-family command: `%gd` prints the entry's
/// selector, `%cI` the commit timestamp and `%s` the subject (Git folds
/// newlines in subjects, so records cannot span output lines). Git 2.53
/// does not interpret `%1f` — the separator must be requested as the
/// literal control byte via `%x1f`. The subject is taken as everything
/// after the second separator, so a message containing raw 0x1f bytes
/// survives; any other shape (out-of-order selectors, missing fields) is
/// a protocol error, never a skipped entry.
pub(crate) fn parse_list_bytes(stdout: &[u8]) -> Result<Vec<StashEntry>, ProbeError> {
    let mut entries = Vec::new();
    for line in stdout
        .split(|byte| *byte == b'\n')
        .filter(|l| !l.is_empty())
    {
        let first = line
            .iter()
            .position(|byte| *byte == 0x1f)
            .ok_or_else(protocol_error)?;
        let (raw_selector, rest) = line.split_at(first);
        let rest = &rest[1..];
        let second = rest
            .iter()
            .position(|byte| *byte == 0x1f)
            .ok_or_else(protocol_error)?;
        let (raw_date, raw_subject) = rest.split_at(second);
        let raw_subject = &raw_subject[1..];
        let selector = std::str::from_utf8(raw_selector).map_err(|_| protocol_error())?;
        let date = std::str::from_utf8(raw_date)
            .map_err(|_| protocol_error())?
            .to_owned();
        let index = u32::try_from(entries.len()).map_err(|_| protocol_error())?;
        if selector != self::selector(index) {
            return Err(protocol_error());
        }
        entries.push(StashEntry {
            index,
            date,
            subject: String::from_utf8_lossy(raw_subject).into_owned(),
        });
    }
    Ok(entries)
}

pub(crate) fn stash_list(work_root: &Path) -> Result<Vec<StashEntry>, ProbeError> {
    let output = branches::run_git(
        work_root,
        &["stash", "list", "--format=%gd%x1f%cI%x1f%s"],
        &NO_CANCEL,
    )?;
    if output.truncated {
        return Err(ProbeError::new(
            "stash_list_too_large",
            "The stash listing exceeded the read limit.",
        ));
    }
    parse_list_bytes(&output.stdout)
}

/// Commit oid of `stash@{N}`, or None when the entry does not exist.
fn stash_oid(work_root: &Path, selector: &str) -> Result<Option<String>, ProbeError> {
    let output = branches::run_git(
        work_root,
        &["rev-parse", "--verify", "--quiet", selector],
        &NO_CANCEL,
    )?;
    if !output.status.success() {
        return Ok(None);
    }
    let oid = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    if !history::valid_oid(&oid) {
        return Err(protocol_error());
    }
    Ok(Some(oid))
}

fn session_directory(sessions: &session::SessionState) -> Result<PathBuf, ProbeError> {
    let identity = sessions
        .current_identity()
        .ok_or_else(|| ProbeError::new("stash_no_session", "No repository is open."))?;
    bare_or_work_dir(&identity)
}

/// Read-only stash views resolve in a bare repository from its git dir,
/// mirroring the tag detail command.
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

pub(crate) fn list_view(sessions: &session::SessionState) -> Result<Vec<StashEntry>, ProbeError> {
    stash_list(&session_directory(sessions)?)
}

fn tracked_dirty(entry: &StatusEntry) -> bool {
    match entry {
        StatusEntry::Tracked(entry) => entry.index_status != '.' || entry.worktree_status != '.',
        StatusEntry::Rename(entry) => {
            entry.tracked.index_status != '.' || entry.tracked.worktree_status != '.'
        }
        StatusEntry::Unmerged(_) | StatusEntry::Untracked { .. } => false,
    }
}

/// Guards that run before `git stash push`. Git 2.53 exits 0 with
/// "No local changes to save" on a clean tree, so an unchecked success
/// would be indistinguishable from a real stash; the dirty set must be
/// recomputed from a fresh status read instead of trusting Git's answer.
fn stash_preconditions(sessions: &session::SessionState) -> Result<(), ProbeError> {
    let entries = write::status_index(sessions)?;
    if entries
        .values()
        .any(|entry| matches!(entry, StatusEntry::Unmerged { .. }))
    {
        return Err(ProbeError::new(
            "stash_conflict",
            "Conflicted files must be resolved before stashing.",
        ));
    }
    if !entries.values().any(tracked_dirty) {
        return Err(ProbeError::new(
            "stash_nothing",
            "No local changes to save; nothing was stashed.",
        ));
    }
    Ok(())
}

pub(crate) fn stash_save(
    state: &WriteState,
    sessions: &session::SessionState,
    snapshot_version: u64,
    message: &str,
) -> Result<OperationResult, ProbeError> {
    let operation_id = state.begin()?;
    let result = run_save(state, sessions, snapshot_version, message);
    state.finish();
    result.map(|mut result| {
        result.operation_id = operation_id;
        result
    })
}

/// Assumes the queue slot is held; tests call this directly to pre-arm
/// cancellation.
fn run_save(
    state: &WriteState,
    sessions: &session::SessionState,
    snapshot_version: u64,
    message: &str,
) -> Result<OperationResult, ProbeError> {
    let mut outcome = Outcome::Success;
    let mut exit_code = None;
    let result_message;
    let mut details = None;
    match sessions.commit_context(snapshot_version) {
        Err(error) => {
            outcome = Outcome::Rejected;
            result_message = error.message;
        }
        Ok((work_root, unborn)) => {
            if unborn {
                outcome = Outcome::Rejected;
                result_message = "Cannot stash before the first commit.".into();
            } else if state.cancel_flag().load(Ordering::SeqCst) {
                outcome = Outcome::Cancelled;
                result_message = "Cancelled before Git ran.".into();
            } else if let Err(refusal) = stash_preconditions(sessions) {
                outcome = Outcome::Rejected;
                result_message = refusal.message;
            } else {
                // The message travels as one argv element — never through a
                // shell, never into logs or the serialized result body.
                let mut args: Vec<&str> = vec!["stash", "push"];
                let named = !message.trim().is_empty();
                if named {
                    args.extend(["-m", message]);
                }
                match branches::run_git(&work_root, &args, state.cancel_flag()) {
                    Ok(output) => {
                        exit_code = output.status.code();
                        if output.status.success() && !output.truncated {
                            result_message = "Local changes stashed.".into();
                        } else {
                            outcome = Outcome::Failed;
                            result_message = "git stash reported a failure.".into();
                            details = Some(write::first_stderr_line(&output.stderr));
                        }
                    }
                    Err(error) if error.code == "process_cancelled" => {
                        outcome = Outcome::Cancelled;
                        result_message = "Cancelled while the Git process was running.".into();
                    }
                    Err(error) => return Err(error),
                }
            }
        }
    }
    let snapshot = session::refresh(sessions)?;
    Ok(OperationResult {
        category: None,
        suggestion: None,
        operation_id: 0,
        kind: OperationKind::StashSave,
        outcome,
        exit_code,
        message: result_message,
        details,
        snapshot,
    })
}

pub(crate) fn stash_apply(
    state: &WriteState,
    sessions: &session::SessionState,
    snapshot_version: u64,
    index: u32,
) -> Result<OperationResult, ProbeError> {
    let operation_id = state.begin()?;
    let result = run_apply(state, sessions, snapshot_version, index);
    state.finish();
    result.map(|mut result| {
        result.operation_id = operation_id;
        result
    })
}

/// Apply leaves the entry in the list, so it needs no ticket — but the
/// position may have shifted since the view was rendered; a re-resolved
/// missing entry is refused before Git runs.
fn run_apply(
    state: &WriteState,
    sessions: &session::SessionState,
    snapshot_version: u64,
    index: u32,
) -> Result<OperationResult, ProbeError> {
    let mut outcome = Outcome::Success;
    let mut exit_code = None;
    let message;
    let mut details = None;
    match sessions.commit_context(snapshot_version) {
        Err(error) => {
            outcome = Outcome::Rejected;
            message = error.message;
        }
        Ok((work_root, _unborn)) => {
            let sel = selector(index);
            let exists = match stash_oid(&work_root, &sel) {
                Ok(Some(_)) => true,
                Ok(None) => false,
                Err(error) => return Err(error),
            };
            if !exists {
                outcome = Outcome::Rejected;
                message =
                    "That stash entry no longer exists; refresh the list and try again.".into();
            } else if state.cancel_flag().load(Ordering::SeqCst) {
                outcome = Outcome::Cancelled;
                message = "Cancelled before Git ran.".into();
            } else {
                match branches::run_git(&work_root, &["stash", "apply", &sel], state.cancel_flag())
                {
                    Ok(output) => {
                        exit_code = output.status.code();
                        if output.status.success() && !output.truncated {
                            message = "Stash applied; the entry stays in the list.".into();
                        } else {
                            outcome = Outcome::Failed;
                            message = "git stash apply reported a failure.".into();
                            details = Some(write::first_stderr_line(&output.stderr));
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
    let snapshot = session::refresh(sessions)?;
    Ok(OperationResult {
        category: None,
        suggestion: None,
        operation_id: 0,
        kind: OperationKind::StashApply,
        outcome,
        exit_code,
        message,
        details,
        snapshot,
    })
}

pub(crate) fn preview_stash_drop(
    state: &WriteState,
    sessions: &session::SessionState,
    snapshot_version: u64,
    index: u32,
) -> Result<PreviewResult, ProbeError> {
    preview_stash(
        state,
        sessions,
        snapshot_version,
        index,
        PreviewKind::DropStash,
    )
}

pub(crate) fn preview_stash_pop(
    state: &WriteState,
    sessions: &session::SessionState,
    snapshot_version: u64,
    index: u32,
) -> Result<PreviewResult, ProbeError> {
    preview_stash(
        state,
        sessions,
        snapshot_version,
        index,
        PreviewKind::PopStash,
    )
}

fn preview_stash(
    state: &WriteState,
    sessions: &session::SessionState,
    snapshot_version: u64,
    index: u32,
    kind: PreviewKind,
) -> Result<PreviewResult, ProbeError> {
    let (work_root, _unborn) = sessions.commit_context(snapshot_version)?;
    let sel = selector(index);
    let oid = stash_oid(&work_root, &sel)?.ok_or_else(|| {
        ProbeError::new(
            "stash_missing",
            "That stash entry does not exist; refresh the list.",
        )
    })?;
    let subject = stash_list(&work_root)?
        .into_iter()
        .find(|entry| entry.index == index)
        .map(|entry| entry.subject)
        .ok_or_else(protocol_error)?;
    let nonce = state.stage_ref_delete(kind, work_root, sel, oid.clone(), false);
    let snapshot = session::refresh(sessions)?
        .ok_or_else(|| ProbeError::new("write_no_session", "No repository session is open."))?;
    Ok(PreviewResult {
        nonce,
        candidates: vec![subject],
        dropped: Vec::new(),
        snapshot,
        target_oid: Some(oid),
    })
}

pub(crate) fn stash_drop(
    state: &WriteState,
    sessions: &session::SessionState,
    nonce: String,
) -> Result<OperationResult, ProbeError> {
    let operation_id = state.begin()?;
    let result = run_ticketed(state, sessions, &nonce, PreviewKind::DropStash, "drop");
    state.finish();
    result.map(|mut result| {
        result.operation_id = operation_id;
        result
    })
}

pub(crate) fn stash_pop(
    state: &WriteState,
    sessions: &session::SessionState,
    nonce: String,
) -> Result<OperationResult, ProbeError> {
    let operation_id = state.begin()?;
    let result = run_ticketed(state, sessions, &nonce, PreviewKind::PopStash, "pop");
    state.finish();
    result.map(|mut result| {
        result.operation_id = operation_id;
        result
    })
}

/// Shared confirm-and-run for drop and pop. A pop that hits conflicts
/// exits non-zero and leaves the entry in the list — reported honestly
/// as a failure whose details say so, with the conflicted state visible
/// in the refreshed snapshot.
fn run_ticketed(
    state: &WriteState,
    sessions: &session::SessionState,
    nonce: &str,
    preview_kind: PreviewKind,
    verb: &'static str,
) -> Result<OperationResult, ProbeError> {
    let kind = match verb {
        "drop" => OperationKind::StashDrop,
        _ => OperationKind::StashPop,
    };
    let mut outcome = Outcome::Success;
    let mut exit_code = None;
    let message;
    let mut details = None;
    let Some((work_root, sel, oid, _force)) = state.take_ref_delete(nonce, preview_kind) else {
        let snapshot = session::refresh(sessions)?;
        return Ok(OperationResult {
            category: None,
            suggestion: None,
            operation_id: 0,
            kind,
            outcome: Outcome::Rejected,
            exit_code: None,
            message: "That confirmation has expired; preview the action again.".into(),
            details: None,
            snapshot,
        });
    };
    let same_repo = sessions
        .current_identity()
        .is_some_and(|identity| identity.work_root.as_deref() == Some(work_root.as_path()));
    if !same_repo {
        outcome = Outcome::Rejected;
        message =
            "The repository session changed after the preview; the stash was untouched.".into();
    } else {
        let unchanged = match stash_oid(&work_root, &sel) {
            Ok(current) => current.as_deref() == Some(oid.as_str()),
            Err(error) => return Err(error),
        };
        if !unchanged {
            outcome = Outcome::Rejected;
            message = format!(
                "The stash entry at that position changed after the preview; nothing was {verb}ped. Confirm again."
            );
        } else if state.cancel_flag().load(Ordering::SeqCst) {
            outcome = Outcome::Cancelled;
            message = "Cancelled before Git ran.".into();
        } else {
            match branches::run_git(&work_root, &["stash", verb, &sel], state.cancel_flag()) {
                Ok(output) => {
                    exit_code = output.status.code();
                    if output.status.success() && !output.truncated {
                        message = if verb == "drop" {
                            "Stash entry dropped.".into()
                        } else {
                            "Stash entry popped and dropped.".into()
                        };
                    } else {
                        outcome = Outcome::Failed;
                        message = format!("git stash {verb} reported a failure.");
                        details = Some(write::first_stderr_line(&output.stderr));
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
        category: None,
        suggestion: None,
        operation_id: 0,
        kind,
        outcome,
        exit_code,
        message,
        details,
        snapshot,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repo;

    fn git(dir: &Path, args: &[&str]) {
        repo::git_with(
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

    fn fixture() -> tempfile::TempDir {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path();
        git(dir, &["init", "--quiet", "--initial-branch=main"]);
        std::fs::write(dir.join("a.txt"), "one\n").unwrap();
        git(dir, &["add", "--", "a.txt"]);
        git(dir, &["commit", "-q", "-m", "base"]);
        root
    }

    fn dirty(dir: &Path) {
        std::fs::write(dir.join("a.txt"), "dirty\n").unwrap();
    }

    fn version_of(result: &OperationResult) -> u64 {
        result
            .snapshot
            .as_ref()
            .expect("every outcome re-reads the snapshot")
            .version
    }

    #[test]
    fn selector_cannot_be_typed_by_the_client() {
        // The command surface takes u32 positions; the selector literal is
        // assembled here and nowhere else.
        assert_eq!(selector(0), "stash@{0}");
        assert_eq!(selector(12), "stash@{12}");
        assert_eq!(selector(u32::MAX), format!("stash@{{{}}}", u32::MAX));
    }

    #[test]
    fn parse_is_fail_closed_on_shape_and_position() {
        let good = b"stash@{0}\x1f2026-01-02T03:04:05+08:00\x1fWIP on main: abc subject\n\
                     stash@{1}\x1f2026-01-02T03:04:06+08:00\x1fsecond \x1fentry\n";
        let entries = parse_list_bytes(good).unwrap();
        assert_eq!(entries.len(), 2);
        // Subject keeps everything after the second separator, raw
        // separators included.
        assert_eq!(entries[1].subject, "second \x1fentry");
        assert_eq!(entries[0].subject, "WIP on main: abc subject");
        for broken in [
            // missing fields
            &b"stash@{0}\x1fdate\n"[..],
            // out-of-order selectors
            &b"stash@{1}\x1fd\x1fs\nstash@{0}\x1fd\x1fs\n"[..],
            // non-utf8 selector
            &b"\xff\x1fd\x1fs\n"[..],
        ] {
            assert_eq!(
                parse_list_bytes(broken).unwrap_err().code,
                "stash_protocol_error",
                "input: {broken:?}"
            );
        }
    }

    #[test]
    fn save_requires_tracked_changes_and_a_born_head() {
        let root = fixture();
        let dir = root.path();
        let sessions = session::SessionState::default();
        let view = session::open(&sessions, dir).unwrap();
        let writes = WriteState::default();

        // Clean work tree: Git would exit 0 with "nothing to save" — the
        // pre-guard must refuse instead.
        let clean = stash_save(&writes, &sessions, view.version, "no-op").unwrap();
        assert_eq!(clean.outcome, Outcome::Rejected);
        assert!(clean.exit_code.is_none(), "Git ran on a clean tree");
        assert!(clean.message.contains("No local changes"));
        assert!(stash_list(dir).unwrap().is_empty());

        // Unborn HEAD: stash has nothing to base a WIP commit on.
        let empty = tempfile::tempdir().unwrap();
        git(empty.path(), &["init", "--quiet", "--initial-branch=main"]);
        std::fs::write(empty.path().join("x.txt"), "x\n").unwrap();
        let sessions2 = session::SessionState::default();
        let writes2 = WriteState::default();
        let unborn = session::open(&sessions2, empty.path()).unwrap();
        let result = stash_save(&writes2, &sessions2, unborn.version, "m").unwrap();
        assert_eq!(result.outcome, Outcome::Rejected);
        assert!(result.exit_code.is_none(), "Git ran on unborn HEAD");
        assert!(result.message.contains("first commit"));
    }

    #[test]
    fn save_apply_pop_round_trip_with_multiline_message() {
        let root = fixture();
        let dir = root.path();
        let sessions = session::SessionState::default();
        let view = session::open(&sessions, dir).unwrap();
        let writes = WriteState::default();
        dirty(dir);
        std::fs::write(dir.join("keep.txt"), "untracked survives\n").unwrap();

        let saved = stash_save(&writes, &sessions, view.version, "多行\n消息 body").unwrap();
        assert_eq!(saved.outcome, Outcome::Success);
        let snapshot = saved.snapshot.clone().unwrap();
        // Tracked changes are gone…
        assert!(!snapshot
            .files
            .iter()
            .any(|f| f.display == "a.txt" && !f.untracked));
        // …untracked files are not stashed by default and survive.
        assert!(snapshot.files.iter().any(|f| f.display == "keep.txt"));
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "one\n");

        let version = version_of(&saved);
        let entries = stash_list(dir).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].index, 0);
        assert!(
            entries[0].subject.contains("多行") && entries[0].subject.contains("消息 body"),
            "subject: {:?}",
            entries[0].subject
        );

        // Apply restores the changes but keeps the entry.
        let applied = stash_apply(&writes, &sessions, version, 0).unwrap();
        assert_eq!(applied.outcome, Outcome::Success);
        assert_eq!(
            std::fs::read_to_string(dir.join("a.txt")).unwrap(),
            "dirty\n"
        );
        assert_eq!(stash_list(dir).unwrap().len(), 1);

        // Pop consumes it — from a clean tree again, the way a user would
        // after inspecting the applied changes (a pop whose output would
        // overwrite local edits is a real Git failure, tested in M2 paths).
        std::fs::write(dir.join("a.txt"), "one\n").unwrap();
        let version = version_of(&applied);
        let preview = preview_stash_pop(&writes, &sessions, version, 0).unwrap();
        assert_eq!(preview.candidates[0], entries[0].subject);
        assert!(history::valid_oid(preview.target_oid.as_deref().unwrap()));
        let popped = stash_pop(&writes, &sessions, preview.nonce).unwrap();
        assert_eq!(popped.outcome, Outcome::Success);
        assert!(popped.message.contains("popped"));
        assert_eq!(
            std::fs::read_to_string(dir.join("a.txt")).unwrap(),
            "dirty\n"
        );
        assert!(stash_list(dir).unwrap().is_empty());
    }

    #[test]
    fn drop_ticket_is_single_use_and_kind_bound() {
        let root = fixture();
        let dir = root.path();
        let sessions = session::SessionState::default();
        let view = session::open(&sessions, dir).unwrap();
        let writes = WriteState::default();
        dirty(dir);
        let saved = stash_save(&writes, &sessions, view.version, "ticket").unwrap();

        let version = version_of(&saved);
        let preview = preview_stash_drop(&writes, &sessions, version, 0).unwrap();
        // A drop ticket never satisfies the pop command (kind mismatch
        // consumes the ticket — fail closed).
        let crossed = stash_pop(&writes, &sessions, preview.nonce.clone()).unwrap();
        assert_eq!(crossed.outcome, Outcome::Rejected);
        assert!(crossed.message.contains("expired"));
        // Re-preview, then replay after use is refused.
        let version = version_of(&crossed);
        let preview = preview_stash_drop(&writes, &sessions, version, 0).unwrap();
        let dropped = stash_drop(&writes, &sessions, preview.nonce.clone()).unwrap();
        assert_eq!(dropped.outcome, Outcome::Success);
        assert!(stash_list(dir).unwrap().is_empty());
        let replay = stash_drop(&writes, &sessions, preview.nonce).unwrap();
        assert_eq!(replay.outcome, Outcome::Rejected);
        assert!(replay.message.contains("expired"));
    }

    #[test]
    fn drift_at_the_same_position_forces_a_fresh_confirm() {
        let root = fixture();
        let dir = root.path();
        let sessions = session::SessionState::default();
        let view = session::open(&sessions, dir).unwrap();
        let writes = WriteState::default();
        dirty(dir);
        let first = stash_save(&writes, &sessions, view.version, "first").unwrap();

        // Preview dropping stash@{0}; then push another stash so the entry
        // at position 0 is a different commit.
        let version = version_of(&first);
        let preview = preview_stash_drop(&writes, &sessions, version, 0).unwrap();
        std::fs::write(dir.join("a.txt"), "one\nsecond dirty\n").unwrap();
        let version = preview.snapshot.version;
        let second = stash_save(&writes, &sessions, version, "second").unwrap();
        assert_eq!(second.outcome, Outcome::Success);
        let drifted = stash_drop(&writes, &sessions, preview.nonce).unwrap();
        assert_eq!(drifted.outcome, Outcome::Rejected);
        assert!(drifted.message.contains("changed after the preview"));
        assert_eq!(stash_list(dir).unwrap().len(), 2);

        // A fresh confirmation of the same position succeeds.
        let version = version_of(&drifted);
        let preview = preview_stash_drop(&writes, &sessions, version, 0).unwrap();
        let dropped = stash_drop(&writes, &sessions, preview.nonce).unwrap();
        assert_eq!(dropped.outcome, Outcome::Success);
        assert_eq!(stash_list(dir).unwrap().len(), 1);
    }

    #[test]
    fn out_of_range_and_stale_version_are_refused_before_git() {
        let root = fixture();
        let dir = root.path();
        let sessions = session::SessionState::default();
        let view = session::open(&sessions, dir).unwrap();
        let writes = WriteState::default();
        dirty(dir);
        let saved = stash_save(&writes, &sessions, view.version, "gates").unwrap();
        let version = version_of(&saved);

        let ghost = stash_apply(&writes, &sessions, version, 7).unwrap();
        assert_eq!(ghost.outcome, Outcome::Rejected);
        assert!(ghost.exit_code.is_none());
        assert!(ghost.message.contains("no longer exists"));

        let version = version_of(&ghost);
        let stale = stash_save(&writes, &sessions, version + 1, "late").unwrap();
        assert_eq!(stale.outcome, Outcome::Rejected);
        assert!(stale.message.contains("rejected"));
        // Stash state is untouched by the refusals.
        assert_eq!(stash_list(dir).unwrap().len(), 1);
    }

    #[test]
    fn conflict_files_refuse_save() {
        let root = fixture();
        let dir = root.path();
        // Build a real conflict: branch with a diverging edit, then merge.
        std::fs::write(dir.join("a.txt"), "one\nours\n").unwrap();
        git(dir, &["add", "--", "a.txt"]);
        git(dir, &["commit", "-q", "-m", "ours"]);
        git(dir, &["branch", "side", "HEAD~1"]);
        git(dir, &["checkout", "-q", "side"]);
        std::fs::write(dir.join("a.txt"), "one\ntheirs\n").unwrap();
        git(dir, &["commit", "-aq", "-m", "theirs"]);
        git(dir, &["checkout", "-q", "main"]);
        let sessions = session::SessionState::default();
        session::open(&sessions, dir).unwrap();
        let writes = WriteState::default();
        let merge = branches::run_git(dir, &["merge", "--no-edit", "side"], &NO_CANCEL).unwrap();
        assert!(!merge.status.success(), "fixture must conflict");
        let conflicted = session::refresh(&sessions).unwrap().unwrap();
        let result = stash_save(&writes, &sessions, conflicted.version, "nope").unwrap();
        assert_eq!(result.outcome, Outcome::Rejected);
        assert!(result.exit_code.is_none());
        assert!(result.message.contains("Conflicted"));
        assert!(stash_list(dir).unwrap().is_empty());
        branches::run_git(dir, &["merge", "--abort"], &NO_CANCEL).unwrap();
    }

    #[test]
    fn cancellation_before_git_still_refreshes_and_stashes_nothing() {
        let root = fixture();
        let dir = root.path();
        let sessions = session::SessionState::default();
        let view = session::open(&sessions, dir).unwrap();
        let writes = WriteState::default();
        dirty(dir);
        writes.cancel();
        let result = run_save(&writes, &sessions, view.version, "never").unwrap();
        assert_eq!(result.outcome, Outcome::Cancelled);
        assert!(result.snapshot.is_some());
        assert!(stash_list(dir).unwrap().is_empty());
        assert_eq!(
            std::fs::read_to_string(dir.join("a.txt")).unwrap(),
            "dirty\n"
        );
    }

    #[test]
    fn bare_repo_lists_empty_but_refuses_every_write() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path();
        git(dir, &["init", "--quiet", "--bare", "--initial-branch=main"]);
        let sessions = session::SessionState::default();
        let view = session::open(&sessions, dir).unwrap();
        assert!(list_view(&sessions).is_ok_and(|entries| entries.is_empty()));
        let writes = WriteState::default();
        let refused = stash_save(&writes, &sessions, view.version, "m").unwrap();
        assert_eq!(refused.outcome, Outcome::Rejected);
        assert!(refused.message.contains("bare"));
    }
}
