//! Reset (M4-04): three modes at two risk levels. Soft and mixed moves
//! HEAD (and the index) but never touches file contents, so they ride the
//! ordinary write queue with the same target discipline as the sequencer:
//! a full commit id or one exact local branch name, never a revspec
//! string. `--hard` additionally overwrites the working copy and drops
//! commits; it has its own command that only consumes a single-use
//! preview ticket, and the ticket's whole promise is re-checked at
//! confirm time — the tracked-dirty file set, HEAD and the target commit.
//! Any drift refuses the operation before Git is touched; the hard entry
//! is never a default button.

use crate::probe::ProbeError;
use crate::status::StatusEntry;
use crate::write::{self, OperationKind, OperationResult, Outcome, PreviewResult, WriteState};
use crate::{branches, history, model, sequencer, session};
use serde::Deserialize;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

/// The wire-level mode of a plain reset. `hard` is deliberately not
/// expressible here: it exists only as the ticketed `reset_hard`
/// command, so no serialized request can reach it by accident.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ModeArg {
    Soft,
    Mixed,
}

impl ModeArg {
    fn flag(self) -> &'static str {
        match self {
            ModeArg::Soft => "--soft",
            ModeArg::Mixed => "--mixed",
        }
    }

    fn label(self) -> &'static str {
        match self {
            ModeArg::Soft => "soft",
            ModeArg::Mixed => "mixed",
        }
    }
}

fn read_git(work_root: &Path, args: &[&str]) -> Option<String> {
    let output = branches::run_git(work_root, args, &AtomicBool::new(false)).ok()?;
    if !output.status.success() || output.truncated {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

/// Resolve a target (or HEAD) to the full commit id it names.
fn resolve_commit(work_root: &Path, spec: &str) -> Option<String> {
    read_git(
        work_root,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("{spec}^{{commit}}"),
        ],
    )
    .filter(|oid| history::valid_oid(oid))
}

/// Files a hard reset would overwrite: every tracked change (staged or
/// unstaged) plus conflict entries; untracked files survive a hard reset
/// untouched, so they are neither listed nor re-checked.
fn tracked_dirty_set(sessions: &session::SessionState) -> Result<Vec<Vec<u8>>, ProbeError> {
    let entries = write::status_index(sessions)?;
    Ok(entries
        .iter()
        .filter(|(_, entry)| match entry {
            StatusEntry::Tracked(e) => e.index_status != '.' || e.worktree_status != '.',
            StatusEntry::Rename(e) => {
                e.tracked.index_status != '.' || e.tracked.worktree_status != '.'
            }
            StatusEntry::Unmerged(_) => true,
            StatusEntry::Untracked { .. } => false,
        })
        .map(|(raw, _)| raw.clone())
        .collect())
}

/// The shared refusal path: everything rejected happens before Git runs,
/// with the actual state re-read and attached.
fn refused(
    sessions: &session::SessionState,
    kind: OperationKind,
    message: String,
) -> Result<OperationResult, ProbeError> {
    let snapshot = session::refresh(sessions)?;
    Ok(OperationResult {
        operation_id: 0,
        kind,
        outcome: Outcome::Rejected,
        exit_code: None,
        message,
        details: None,
        snapshot,
    })
}

pub(crate) fn reset(
    state: &WriteState,
    sessions: &session::SessionState,
    snapshot_version: u64,
    mode: ModeArg,
    target: &str,
) -> Result<OperationResult, ProbeError> {
    let operation_id = state.begin()?;
    let result = run_reset(state, sessions, snapshot_version, mode, target);
    state.finish();
    result.map(|mut result| {
        result.operation_id = operation_id;
        result
    })
}

fn run_reset(
    state: &WriteState,
    sessions: &session::SessionState,
    snapshot_version: u64,
    mode: ModeArg,
    target: &str,
) -> Result<OperationResult, ProbeError> {
    let kind = OperationKind::Reset;
    let (work_root, unborn) = match sessions.commit_context(snapshot_version) {
        Err(error) => return refused(sessions, kind, error.message),
        Ok(context) => context,
    };
    let in_progress = sequencer::in_progress_message(sessions)?;
    if unborn {
        return refused(
            sessions,
            kind,
            "Cannot reset before the first commit.".into(),
        );
    }
    if let Some(refusal) = in_progress {
        return refused(sessions, kind, refusal);
    }
    if !sequencer::validate_target(&work_root, target) {
        return refused(
            sessions,
            kind,
            "The target must be a full commit id or an existing local branch name.".into(),
        );
    }
    if state.cancel_flag().load(Ordering::SeqCst) {
        let snapshot = session::refresh(sessions)?;
        return Ok(OperationResult {
            operation_id: 0,
            kind,
            outcome: Outcome::Cancelled,
            exit_code: None,
            message: "Cancelled before Git ran.".into(),
            details: None,
            snapshot,
        });
    }
    let args = ["reset", mode.flag(), target];
    let outcome;
    let message;
    let mut exit_code = None;
    let mut details = None;
    match sequencer::run_git(&work_root, false, &args, state) {
        Ok(output) => {
            exit_code = output.status.code();
            if output.status.success() && !output.truncated {
                outcome = Outcome::Success;
                message = format!("Reset ({}) to {}.", mode.label(), target);
            } else {
                outcome = Outcome::Failed;
                message = format!("git reset {} reported a failure.", mode.flag());
                details = Some(write::first_stderr_line(&output.stderr));
            }
        }
        Err(error) if error.code == "process_cancelled" => {
            outcome = Outcome::Cancelled;
            message = "Cancelled while the Git process was running.".into();
        }
        Err(error) => return Err(error),
    }
    let snapshot = session::refresh(sessions)?;
    Ok(OperationResult {
        operation_id: 0,
        kind,
        outcome,
        exit_code,
        message,
        details,
        snapshot,
    })
}

/// Short display prefix for a full commit id in confirmation lists.
fn short(oid: &str) -> String {
    oid.chars().take(10).collect()
}

/// How many discarded commit subjects the panel lists before summarising.
const DROPPED_DISPLAY_LIMIT: usize = 20;

pub(crate) fn preview_reset_hard(
    state: &WriteState,
    sessions: &session::SessionState,
    snapshot_version: u64,
    target: &str,
) -> Result<PreviewResult, ProbeError> {
    let (work_root, unborn) = sessions.commit_context(snapshot_version)?;
    if unborn {
        return Err(ProbeError::new(
            "reset_unborn",
            "Cannot reset before the first commit.",
        ));
    }
    if let Some(refusal) = sequencer::in_progress_message(sessions)? {
        return Err(ProbeError::new("reset_in_progress", refusal));
    }
    if !sequencer::validate_target(&work_root, target) {
        return Err(ProbeError::new(
            "reset_target",
            "The target must be a full commit id or an existing local branch name.",
        ));
    }
    let target_oid = resolve_commit(&work_root, target).ok_or_else(|| {
        ProbeError::new(
            "reset_target_missing",
            "That commit does not exist in this repository; refresh the history.",
        )
    })?;
    let head_oid = resolve_commit(&work_root, "HEAD")
        .ok_or_else(|| ProbeError::new("reset_head", "HEAD does not name a commit."))?;
    let dirty = tracked_dirty_set(sessions)?;
    // What leaving HEAD where it is would drop, listed from the same
    // fresh read that produced the ids.
    let mut dropped = Vec::new();
    if head_oid != target_oid {
        let listed = read_git(
            &work_root,
            &[
                "rev-list",
                "--max-count",
                &(DROPPED_DISPLAY_LIMIT + 1).to_string(),
                &head_oid,
                &format!("^{target_oid}"),
            ],
        )
        .map(|stdout| stdout.lines().map(str::to_owned).collect::<Vec<_>>())
        .unwrap_or_default();
        if listed.len() > DROPPED_DISPLAY_LIMIT {
            let total = read_git(
                &work_root,
                &["rev-list", "--count", &head_oid, &format!("^{target_oid}")],
            )
            .and_then(|count| count.parse::<usize>().ok())
            .unwrap_or(listed.len());
            dropped.extend(listed[..DROPPED_DISPLAY_LIMIT].iter().map(|oid| short(oid)));
            dropped.push(format!("… {} commits in total", total));
        } else {
            dropped.extend(listed.iter().map(|oid| short(oid)));
        }
    }
    let nonce = state.stage_reset_hard(work_root, dirty.clone(), target_oid.clone(), head_oid);
    let snapshot = session::refresh(sessions)?
        .ok_or_else(|| ProbeError::new("write_no_session", "No repository session is open."))?;
    Ok(PreviewResult {
        nonce,
        candidates: dirty.iter().map(|raw| model::display_name(raw)).collect(),
        dropped,
        snapshot,
        target_oid: Some(target_oid),
    })
}

pub(crate) fn reset_hard(
    state: &WriteState,
    sessions: &session::SessionState,
    nonce: String,
) -> Result<OperationResult, ProbeError> {
    let operation_id = state.begin()?;
    let result = run_reset_hard(state, sessions, &nonce);
    state.finish();
    result.map(|mut result| {
        result.operation_id = operation_id;
        result
    })
}

fn run_reset_hard(
    state: &WriteState,
    sessions: &session::SessionState,
    nonce: &str,
) -> Result<OperationResult, ProbeError> {
    let kind = OperationKind::ResetHard;
    let Some((work_root, expected_dirty, target_oid, expected_head)) = state.take_reset_hard(nonce)
    else {
        return refused(
            sessions,
            kind,
            "That confirmation has expired; preview the action again.".into(),
        );
    };
    let same_repo = sessions
        .current_identity()
        .is_some_and(|identity| identity.work_root.as_deref() == Some(work_root.as_path()));
    if !same_repo {
        return refused(
            sessions,
            kind,
            "A different repository is open now; preview the reset again.".into(),
        );
    }
    if let Some(refusal) = sequencer::in_progress_message(sessions)? {
        return refused(sessions, kind, refusal);
    }
    // The ticket promised exactly this HEAD, this target and this dirty
    // set; anything else means the preview no longer describes reality.
    let Some(head_now) = resolve_commit(&work_root, "HEAD") else {
        return refused(
            sessions,
            kind,
            "HEAD no longer names a commit; preview the reset again.".into(),
        );
    };
    if head_now != expected_head {
        return refused(
            sessions,
            kind,
            "The branch moved since the preview; nothing was changed. Preview the reset again."
                .into(),
        );
    }
    if resolve_commit(&work_root, &target_oid).as_deref() != Some(target_oid.as_str()) {
        return refused(
            sessions,
            kind,
            "The target commit is no longer reachable; preview the reset again.".into(),
        );
    }
    let dirty_now = tracked_dirty_set(sessions)?;
    if dirty_now != expected_dirty {
        return refused(
            sessions,
            kind,
            "The working copy changed since the preview; nothing was changed. Preview the reset again."
                .into(),
        );
    }
    if state.cancel_flag().load(Ordering::SeqCst) {
        let snapshot = session::refresh(sessions)?;
        return Ok(OperationResult {
            operation_id: 0,
            kind,
            outcome: Outcome::Cancelled,
            exit_code: None,
            message: "Cancelled before Git ran.".into(),
            details: None,
            snapshot,
        });
    }
    let outcome;
    let message;
    let mut exit_code = None;
    let mut details = None;
    match sequencer::run_git(&work_root, false, &["reset", "--hard", &target_oid], state) {
        Ok(output) => {
            exit_code = output.status.code();
            if output.status.success() && !output.truncated {
                outcome = Outcome::Success;
                message = format!(
                    "Hard reset to {}. Discarded the working-copy changes listed in the preview.",
                    short(&target_oid)
                );
            } else {
                outcome = Outcome::Failed;
                message = "git reset --hard reported a failure.".into();
                details = Some(write::first_stderr_line(&output.stderr));
            }
        }
        Err(error) if error.code == "process_cancelled" => {
            outcome = Outcome::Cancelled;
            message = "Cancelled while the Git process was running. The reset may have partly applied; the refreshed snapshot shows the actual state.".into();
        }
        Err(error) => return Err(error),
    }
    let snapshot = session::refresh(sessions)?;
    Ok(OperationResult {
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

    fn git(dir: &Path, args: &[&str]) {
        crate::repo::git_with(
            dir,
            &[
                "-c",
                "user.name=guit test",
                "-c",
                "user.email=test@example.invalid",
            ],
            args,
        );
    }

    fn read(dir: &Path, args: &[&str]) -> String {
        let output = branches::run_git(dir, args, &AtomicBool::new(false)).unwrap();
        assert!(output.status.success());
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    }

    /// c2 on top of c1; the working copy then carries one unstaged edit
    /// (b.txt), one staged addition (c.txt) and one untracked file (u.txt).
    fn dirty_repo() -> tempfile::TempDir {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path();
        git(dir, &["init", "--quiet", "--initial-branch=main"]);
        git(dir, &["config", "user.name", "guit test"]);
        git(dir, &["config", "user.email", "test@example.invalid"]);
        std::fs::write(dir.join("a.txt"), "one\n").unwrap();
        std::fs::write(dir.join("b.txt"), "one\n").unwrap();
        git(dir, &["add", "."]);
        git(dir, &["commit", "-m", "first"]);
        std::fs::write(dir.join("a.txt"), "two\n").unwrap();
        git(dir, &["add", "a.txt"]);
        git(dir, &["commit", "-m", "second"]);
        std::fs::write(dir.join("b.txt"), "b changed\n").unwrap();
        std::fs::write(dir.join("c.txt"), "new\n").unwrap();
        git(dir, &["add", "c.txt"]);
        std::fs::write(dir.join("u.txt"), "untracked\n").unwrap();
        root
    }

    fn state_and_session(dir: &Path) -> (WriteState, session::SessionState, u64) {
        let writes = WriteState::default();
        let sessions = session::SessionState::default();
        let view = session::open(&sessions, dir).unwrap();
        (writes, sessions, view.version)
    }

    fn group_of(result: &OperationResult, name: &str) -> Option<model::FileGroup> {
        result
            .snapshot
            .as_ref()?
            .files
            .iter()
            .find_map(|file| file.display.ends_with(name).then_some(file.group))
    }

    #[test]
    fn soft_reset_moves_head_and_keeps_index_and_files() {
        let root = dirty_repo();
        let dir = root.path();
        let (writes, sessions, version) = state_and_session(dir);
        let c1 = read(dir, &["rev-parse", "HEAD~1"]);
        let result = reset(&writes, &sessions, version, ModeArg::Soft, &c1).unwrap();
        assert_eq!(result.outcome, Outcome::Success, "{}", result.message);
        assert_eq!(read(dir, &["rev-parse", "HEAD"]), c1);
        // Index untouched: the staged addition stays staged and the index
        // content of a.txt still says "two"; nothing on disk was written.
        assert_eq!(group_of(&result, "c.txt"), Some(model::FileGroup::Staged));
        assert_eq!(read(dir, &["show", ":a.txt"]), "two");
        assert_eq!(
            std::fs::read_to_string(dir.join("b.txt")).unwrap(),
            "b changed\n"
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("u.txt")).unwrap(),
            "untracked\n"
        );
    }

    #[test]
    fn mixed_reset_moves_head_and_index_but_not_files() {
        let root = dirty_repo();
        let dir = root.path();
        let (writes, sessions, version) = state_and_session(dir);
        let c1 = read(dir, &["rev-parse", "HEAD~1"]);
        let result = reset(&writes, &sessions, version, ModeArg::Mixed, &c1).unwrap();
        assert_eq!(result.outcome, Outcome::Success, "{}", result.message);
        assert_eq!(read(dir, &["rev-parse", "HEAD"]), c1);
        // Index back to HEAD: a.txt is an unstaged edit again and the
        // staged c.txt falls out of the index while its file stays on disk.
        assert_eq!(group_of(&result, "a.txt"), Some(model::FileGroup::Worktree));
        assert_eq!(
            group_of(&result, "c.txt"),
            Some(model::FileGroup::Untracked)
        );
        assert_eq!(std::fs::read_to_string(dir.join("c.txt")).unwrap(), "new\n");
    }

    #[test]
    fn hard_reset_lists_targets_and_only_then_applies() {
        let root = dirty_repo();
        let dir = root.path();
        let (writes, sessions, version) = state_and_session(dir);
        let c2 = read(dir, &["rev-parse", "HEAD"]);
        let c1 = read(dir, &["rev-parse", "HEAD~1"]);
        let preview = preview_reset_hard(&writes, &sessions, version, &c1).unwrap();
        assert_eq!(preview.target_oid.as_deref(), Some(c1.as_str()));
        // The promise: exactly the tracked-dirty files, and the commit
        // left behind. Untracked files survive a hard reset and so must
        // not appear in the list.
        let names = preview.candidates.join("|");
        assert!(
            names.contains("b.txt") && names.contains("c.txt"),
            "{names}"
        );
        assert!(
            !names.contains("u.txt"),
            "untracked files must not be listed"
        );
        assert_eq!(preview.dropped, vec![short(&c2)]);

        let result = reset_hard(&writes, &sessions, preview.nonce.clone()).unwrap();
        assert_eq!(result.outcome, Outcome::Success, "{}", result.message);
        assert_eq!(read(dir, &["rev-parse", "HEAD"]), c1);
        assert_eq!(std::fs::read_to_string(dir.join("b.txt")).unwrap(), "one\n");
        assert_eq!(read(dir, &["show", ":a.txt"]), "one");
        // c.txt was staged only, never committed — and a hard reset wipes
        // index-tracked state, so Git deletes the file itself. That is
        // precisely why the ticket lists it, while the purely untracked
        // u.txt was never in danger and must survive.
        assert!(!dir.join("c.txt").exists());
        assert_eq!(
            std::fs::read_to_string(dir.join("u.txt")).unwrap(),
            "untracked\n"
        );

        // The ticket is spent: replay is refused without touching Git.
        let replay = reset_hard(&writes, &sessions, preview.nonce).unwrap();
        assert_eq!(replay.outcome, Outcome::Rejected);
        assert!(replay.message.contains("expired"));
        assert_eq!(replay.exit_code, None);
    }

    #[test]
    fn dirty_set_drift_between_preview_and_confirm_is_refused() {
        let root = dirty_repo();
        let dir = root.path();
        let (writes, sessions, version) = state_and_session(dir);
        let c1 = read(dir, &["rev-parse", "HEAD~1"]);
        let head = read(dir, &["rev-parse", "HEAD"]);
        let preview = preview_reset_hard(&writes, &sessions, version, &c1).unwrap();
        // An external edit to a previously clean tracked file changes what
        // the reset would destroy — the preview no longer describes reality.
        std::fs::write(dir.join("a.txt"), "externally edited\n").unwrap();
        let refused = reset_hard(&writes, &sessions, preview.nonce).unwrap();
        assert_eq!(refused.outcome, Outcome::Rejected);
        assert!(refused.message.contains("working copy changed"));
        assert_eq!(refused.exit_code, None, "refusal must not reach git");
        assert_eq!(read(dir, &["rev-parse", "HEAD"]), head);
        assert_eq!(
            std::fs::read_to_string(dir.join("b.txt")).unwrap(),
            "b changed\n",
            "nothing may be restored on a refusal"
        );
    }

    #[test]
    fn head_drift_between_preview_and_confirm_is_refused() {
        let root = dirty_repo();
        let dir = root.path();
        let (writes, sessions, version) = state_and_session(dir);
        let c1 = read(dir, &["rev-parse", "HEAD~1"]);
        let preview = preview_reset_hard(&writes, &sessions, version, &c1).unwrap();
        // An external commit means the set of dropped commits changed.
        git(dir, &["commit", "--allow-empty", "-m", "external"]);
        let refused = reset_hard(&writes, &sessions, preview.nonce).unwrap();
        assert_eq!(refused.outcome, Outcome::Rejected);
        assert!(refused.message.contains("branch moved"));
        assert_eq!(refused.exit_code, None);
        assert_eq!(read(dir, &["log", "-1", "--format=%s"]), "external");
    }

    #[test]
    fn reset_targets_are_validated_before_git() {
        let root = dirty_repo();
        let dir = root.path();
        let (writes, sessions, version) = state_and_session(dir);
        let mut version = version;
        // Revspec strings and unknown names never reach git, in either
        // direction of the mode split.
        for bad in ["HEAD~1", "@{u}", "nosuchbranch", "main extra", ""] {
            let result = reset(&writes, &sessions, version, ModeArg::Soft, bad).unwrap();
            assert_eq!(result.outcome, Outcome::Rejected, "{bad:?} accepted");
            assert_eq!(result.exit_code, None, "{bad:?} reached git");
            // Each refusal re-read state, so the next attempt needs its version.
            version = result.snapshot.expect("re-read").version;
        }
        // A well-formed but nonexistent commit is caught at hard preview
        // (soft/mixed leave it to Git's own failure reporting).
        let ghost = "deadbeef".repeat(5);
        let error = preview_reset_hard(&writes, &sessions, version, &ghost).unwrap_err();
        assert_eq!(error.code, "reset_target_missing");
        // But a branch name is a legitimate hard target.
        let preview = preview_reset_hard(&writes, &sessions, version, "main").unwrap();
        assert_eq!(
            preview.target_oid.as_deref(),
            Some(read(dir, &["rev-parse", "main"]).as_str())
        );
    }

    #[test]
    fn in_progress_and_stale_versions_refuse_resets() {
        let root = crate::sequencer::tests::diverged_repo(false);
        let dir = root.path();
        let (writes, sessions, version) = state_and_session(dir);
        // A reset while a merge is conflicted would compound damage; the
        // sequencer exposes the fixture the refusal is checked against.
        let conflicted =
            crate::sequencer::merge_start(&writes, &sessions, version, "side").unwrap();
        let view = conflicted.snapshot.expect("in-flight");
        let refused = reset(&writes, &sessions, view.version, ModeArg::Mixed, "side").unwrap();
        assert_eq!(refused.outcome, Outcome::Rejected);
        assert!(refused.message.contains("already in progress"));
        // Stale versions are refused by the session gate itself.
        let fresh = refused.snapshot.expect("re-read").version;
        let stale = reset(&writes, &sessions, fresh + 7, ModeArg::Soft, "side").unwrap();
        assert_eq!(stale.outcome, Outcome::Rejected);
        assert!(stale.message.contains("rejected"));
    }
}
