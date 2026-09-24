//! Sequencer operations (M4-02/M4-03): starting merges and rebases and
//! finishing whatever is in progress with continue/abort/skip. Which
//! operation is in flight is never taken from the client — every
//! continue/abort/skip re-detects the kind from the repository's own
//! markers (see [`crate::inflight`]) and dispatches accordingly, so a stale
//! or hostile UI cannot drive the wrong Git command. A run that stops on
//! conflicts is reported as `Outcome::Conflicted` with the in-flight
//! snapshot attached; the banner — not an error dialog — offers the next
//! step. Start commands refuse to run while any operation is in progress.

use crate::probe::ProbeError;
use crate::runner;
use crate::write::{self, OperationKind, OperationResult, Outcome, WriteState};
use crate::{branches, history, inflight, model::FileGroup, repo, session};
use std::path::Path;
use std::sync::atomic::Ordering;
use std::time::Duration;

/// Sequencer steps can rewrite whole histories; allow far longer than the
/// 60 s read budget while keeping the shared output limit.
const SEQUENCE_TIMEOUT: Duration = Duration::from_secs(600);

pub(crate) fn run_git(
    work_root: &Path,
    noninteractive: bool,
    args: &[&str],
    state: &WriteState,
) -> Result<runner::CapturedOutput, ProbeError> {
    let mut command = if noninteractive {
        repo::user_git_command_noninteractive(work_root)
    } else {
        repo::user_git_command(work_root)
    };
    command.args(args);
    runner::run_with_limit(
        command,
        state.cancel_flag(),
        Duration::ZERO,
        SEQUENCE_TIMEOUT,
        runner::DEFAULT_OUTPUT_LIMIT,
        |_, _| {},
    )
}

/// A merge/rebase target is either a full object id or the name of a
/// branch refs::list reports; revspec strings (`HEAD~1`, `@{u}`) are never
/// passed through to Git.
pub(crate) fn validate_target(work_root: &Path, target: &str) -> bool {
    if target.is_empty() || target.len() > branches::MAX_NAME_LEN {
        return false;
    }
    if history::valid_oid(target) {
        return true;
    }
    match branches::run_git(
        work_root,
        &["for-each-ref", "--format=%(refname)", "refs/heads/"],
        &std::sync::atomic::AtomicBool::new(false),
    ) {
        Ok(output) => String::from_utf8_lossy(&output.stdout)
            .lines()
            .any(|line| line.strip_prefix("refs/heads/") == Some(target)),
        Err(_) => false,
    }
}

/// cherry-pick/revert targets must additionally resolve to a real commit:
/// the History button sends an oid it just read, so a vanished commit is a
/// bug or a race, not something to hand to Git as an argument.
fn validate_start_target(work_root: &Path, mode: Start, target: &str) -> bool {
    if mode.accepts_branch_names() {
        return validate_target(work_root, target);
    }
    history::valid_oid(target)
        && branches::run_git(
            work_root,
            &[
                "rev-parse",
                "--verify",
                "--quiet",
                &format!("{target}^{{commit}}"),
            ],
            &std::sync::atomic::AtomicBool::new(false),
        )
        .map(|output| output.status.success() && !output.truncated)
        .unwrap_or(false)
}

/// True when the re-read snapshot still shows an operation or conflicts —
/// the difference between "Git stopped on conflicts" and "Git failed".
fn still_stuck(snapshot: &Option<session::SnapshotView>) -> bool {
    snapshot.as_ref().is_some_and(|view| {
        view.operation.is_some()
            || view
                .files
                .iter()
                .any(|file| file.group == FileGroup::Conflict)
    })
}

#[derive(Clone, Copy)]
enum Step {
    Continue,
    Abort,
    Skip,
}

impl Step {
    fn flag(self) -> &'static str {
        match self {
            Step::Continue => "--continue",
            Step::Abort => "--abort",
            Step::Skip => "--skip",
        }
    }

    fn verb(self) -> &'static str {
        match self {
            Step::Continue => "Continued",
            Step::Abort => "Aborted",
            Step::Skip => "Skipped",
        }
    }

    fn result_kind(self) -> OperationKind {
        match self {
            Step::Continue => OperationKind::Continue,
            Step::Abort => OperationKind::Abort,
            Step::Skip => OperationKind::Skip,
        }
    }
}

#[derive(Clone, Copy)]
enum Start {
    Merge,
    Rebase,
    CherryPick,
    Revert,
}

impl Start {
    fn verb(self) -> &'static str {
        match self {
            Start::Merge => "merge",
            Start::Rebase => "rebase",
            Start::CherryPick => "cherry-pick",
            Start::Revert => "revert",
        }
    }

    fn result_kind(self) -> OperationKind {
        match self {
            Start::Merge => OperationKind::Merge,
            Start::Rebase => OperationKind::Rebase,
            Start::CherryPick => OperationKind::CherryPick,
            Start::Revert => OperationKind::Revert,
        }
    }

    /// Merge and rebase may target a local branch name; cherry-pick and
    /// revert ride the History detail buttons and accept only a full
    /// commit id, so a stale list row can never silently retarget.
    fn accepts_branch_names(self) -> bool {
        matches!(self, Start::Merge | Start::Rebase)
    }
}

pub(crate) fn merge_start(
    state: &WriteState,
    sessions: &session::SessionState,
    snapshot_version: u64,
    target: &str,
) -> Result<OperationResult, ProbeError> {
    let operation_id = state.begin()?;
    let result = run_start(state, sessions, snapshot_version, target, Start::Merge);
    state.finish();
    result.map(|mut result| {
        result.operation_id = operation_id;
        result
    })
}

pub(crate) fn rebase_start(
    state: &WriteState,
    sessions: &session::SessionState,
    snapshot_version: u64,
    target: &str,
) -> Result<OperationResult, ProbeError> {
    let operation_id = state.begin()?;
    let result = run_start(state, sessions, snapshot_version, target, Start::Rebase);
    state.finish();
    result.map(|mut result| {
        result.operation_id = operation_id;
        result
    })
}

pub(crate) fn pick_commit(
    state: &WriteState,
    sessions: &session::SessionState,
    snapshot_version: u64,
    oid: &str,
) -> Result<OperationResult, ProbeError> {
    let operation_id = state.begin()?;
    let result = run_start(state, sessions, snapshot_version, oid, Start::CherryPick);
    state.finish();
    result.map(|mut result| {
        result.operation_id = operation_id;
        result
    })
}

pub(crate) fn revert_commit(
    state: &WriteState,
    sessions: &session::SessionState,
    snapshot_version: u64,
    oid: &str,
) -> Result<OperationResult, ProbeError> {
    let operation_id = state.begin()?;
    let result = run_start(state, sessions, snapshot_version, oid, Start::Revert);
    state.finish();
    result.map(|mut result| {
        result.operation_id = operation_id;
        result
    })
}

fn run_start(
    state: &WriteState,
    sessions: &session::SessionState,
    snapshot_version: u64,
    target: &str,
    mode: Start,
) -> Result<OperationResult, ProbeError> {
    let kind = mode.result_kind();
    let verb = mode.verb();
    let mut outcome = Outcome::Success;
    let mut exit_code = None;
    let message;
    let mut details = None;
    match sessions.commit_context(snapshot_version) {
        Err(error) => {
            outcome = Outcome::Rejected;
            message = error.message;
        }
        Ok((work_root, unborn)) => {
            let in_progress = in_progress_message(sessions)?;
            if unborn {
                outcome = Outcome::Rejected;
                message = format!("Cannot {verb} before the first commit.");
            } else if let Some(refusal) = in_progress {
                outcome = Outcome::Rejected;
                message = refusal;
            } else if !validate_start_target(&work_root, mode, target) {
                outcome = Outcome::Rejected;
                message = if mode.accepts_branch_names() {
                    "The target must be a full commit id or an existing local branch name.".into()
                } else {
                    "The target must be a full commit id of an existing commit.".into()
                };
            } else if state.cancel_flag().load(Ordering::SeqCst) {
                outcome = Outcome::Cancelled;
                message = "Cancelled before Git ran.".into();
            } else {
                // `--no-edit` keeps Git from demanding a commit-message
                // editor; cherry-pick and a plain rebase need nothing
                // (measured on Git 2.53, plan/04).
                let args: Vec<&str> = match mode {
                    Start::Merge => vec!["merge", "--no-edit", target],
                    Start::Rebase => vec!["rebase", target],
                    Start::CherryPick => vec!["cherry-pick", target],
                    Start::Revert => vec!["revert", "--no-edit", target],
                };
                match run_git(&work_root, false, &args, state) {
                    Ok(output) => {
                        exit_code = output.status.code();
                        let snapshot = session::refresh(sessions)?;
                        if output.status.success() && !output.truncated {
                            message = match mode {
                                Start::Merge => format!("Merged {target}."),
                                Start::Rebase => format!("Rebased onto {target}."),
                                Start::CherryPick => format!("Cherry-picked {target}."),
                                Start::Revert => format!("Reverted {target}."),
                            };
                            return Ok(OperationResult {
                                operation_id: 0,
                                kind,
                                outcome,
                                exit_code,
                                message,
                                details,
                                snapshot,
                            });
                        }
                        if still_stuck(&snapshot) {
                            outcome = Outcome::Conflicted;
                            message = format!(
                                "{verb} stopped on conflicts; resolve them, then continue, skip or abort."
                            );
                        } else {
                            outcome = Outcome::Failed;
                            message = format!("git {verb} reported a failure.");
                            details = Some(write::first_stderr_line(&output.stderr));
                        }
                        return Ok(OperationResult {
                            operation_id: 0,
                            kind,
                            outcome,
                            exit_code,
                            message,
                            details,
                            snapshot,
                        });
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
        operation_id: 0,
        kind,
        outcome,
        exit_code,
        message,
        details,
        snapshot,
    })
}

pub(crate) fn in_progress_message(
    sessions: &session::SessionState,
) -> Result<Option<String>, ProbeError> {
    let Some(identity) = sessions.current_identity() else {
        return Ok(Some("No repository is open.".into()));
    };
    Ok(inflight::detect_from_identity(&identity)?.map(|view| {
        format!(
            "Another operation is already in progress ({}). Finish it from the banner first.",
            view.subject
        )
    }))
}

pub(crate) fn operation_continue(
    state: &WriteState,
    sessions: &session::SessionState,
    snapshot_version: u64,
) -> Result<OperationResult, ProbeError> {
    run_step(state, sessions, snapshot_version, Step::Continue)
}

pub(crate) fn operation_abort(
    state: &WriteState,
    sessions: &session::SessionState,
    snapshot_version: u64,
) -> Result<OperationResult, ProbeError> {
    run_step(state, sessions, snapshot_version, Step::Abort)
}

pub(crate) fn operation_skip(
    state: &WriteState,
    sessions: &session::SessionState,
    snapshot_version: u64,
) -> Result<OperationResult, ProbeError> {
    run_step(state, sessions, snapshot_version, Step::Skip)
}

fn run_step(
    state: &WriteState,
    sessions: &session::SessionState,
    snapshot_version: u64,
    step: Step,
) -> Result<OperationResult, ProbeError> {
    let operation_id = state.begin()?;
    let result = run_step_inner(state, sessions, snapshot_version, step);
    state.finish();
    result.map(|mut result| {
        result.operation_id = operation_id;
        result
    })
}

/// The dispatcher: command words come only from the detected kind, never
/// from the request. Err carries the honest refusal message.
fn decide_step(
    detected: Option<inflight::OperationView>,
    step: Step,
) -> Result<(&'static str, bool), String> {
    let view = detected.ok_or_else(|| {
        "No Git operation is in progress; nothing to continue, abort or skip.".to_owned()
    })?;
    if view.kind == inflight::OperationKindView::Unknown {
        return Err(
            "Git's state is ambiguous; guit will not guess which command finishes it.".into(),
        );
    }
    if matches!(step, Step::Skip) && view.kind == inflight::OperationKindView::Merge {
        return Err("There is nothing to skip in a merge.".into());
    }
    let word = match view.kind {
        inflight::OperationKindView::Merge => "merge",
        inflight::OperationKindView::Rebase => "rebase",
        inflight::OperationKindView::CherryPick => "cherry-pick",
        inflight::OperationKindView::Revert => "revert",
        inflight::OperationKindView::Unknown => unreachable!("filtered above"),
    };
    // Measured on Git 2.53: only `merge --continue` and `rebase --continue`
    // invoke the commit-message editor; plan/04 records the GIT_EDITOR=:
    // deviation for those two paths.
    let needs_editor = matches!(step, Step::Continue)
        && matches!(
            view.kind,
            inflight::OperationKindView::Merge | inflight::OperationKindView::Rebase
        );
    Ok((word, needs_editor))
}

fn run_step_inner(
    state: &WriteState,
    sessions: &session::SessionState,
    snapshot_version: u64,
    step: Step,
) -> Result<OperationResult, ProbeError> {
    let kind = step.result_kind();
    let mut outcome = Outcome::Success;
    let mut exit_code = None;
    let message;
    let details = None;
    match sessions.commit_context(snapshot_version) {
        Err(error) => {
            outcome = Outcome::Rejected;
            message = error.message;
        }
        Ok((work_root, _unborn)) => {
            let identity = sessions
                .current_identity()
                .ok_or_else(|| ProbeError::new("sequencer_no_session", "No repository is open."))?;
            let detected = inflight::detect_from_identity(&identity)?;
            match decide_step(detected, step) {
                Err(refusal) => {
                    outcome = Outcome::Rejected;
                    message = refusal;
                }
                Ok((word, needs_editor)) => {
                    if state.cancel_flag().load(Ordering::SeqCst) {
                        outcome = Outcome::Cancelled;
                        message = "Cancelled before Git ran.".into();
                    } else {
                        let args = [word, step.flag()];
                        match run_git(&work_root, needs_editor, &args, state) {
                            Ok(output) => {
                                exit_code = output.status.code();
                                let snapshot = session::refresh(sessions)?;
                                if output.status.success() && !output.truncated {
                                    return Ok(OperationResult {
                                        operation_id: 0,
                                        kind,
                                        outcome,
                                        exit_code,
                                        message: format!("{} the {word}.", step.verb()),
                                        details: None,
                                        snapshot,
                                    });
                                }
                                // A failed abort is a plain failure with the
                                // snapshot left honestly showing the
                                // operation; a continue/skip that stops
                                // again is conflict progress.
                                let conflicted =
                                    !matches!(step, Step::Abort) && still_stuck(&snapshot);
                                let (outcome, message, details) = if conflicted {
                                    (
                                        Outcome::Conflicted,
                                        format!("{word} stopped again; more conflicts remain."),
                                        None,
                                    )
                                } else {
                                    (
                                        Outcome::Failed,
                                        format!("git {word} {} reported a failure.", step.flag()),
                                        Some(write::first_stderr_line(&output.stderr)),
                                    )
                                };
                                return Ok(OperationResult {
                                    operation_id: 0,
                                    kind,
                                    outcome,
                                    exit_code,
                                    message,
                                    details,
                                    snapshot,
                                });
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
pub(crate) mod tests {
    use super::*;
    use crate::inflight::OperationKindView;
    use std::sync::atomic::AtomicBool;

    fn git(dir: &Path, args: &[&str]) {
        repo::git_with(
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

    /// main/side diverge on the same line of a.txt so merging them always
    /// conflicts; on separate files so a clean merge still makes a commit.
    pub(crate) fn diverged_repo(clean: bool) -> tempfile::TempDir {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path();
        git(dir, &["init", "--quiet", "--initial-branch=main"]);
        // Persist identity in the repo's own config: sequencer commits run
        // through the user's Git environment and must not depend on it.
        git(dir, &["config", "user.name", "guit test"]);
        git(dir, &["config", "user.email", "test@example.invalid"]);
        std::fs::write(dir.join("base.txt"), "base\n").unwrap();
        git(dir, &["add", "."]);
        git(dir, &["commit", "-m", "base"]);
        git(dir, &["checkout", "-q", "-b", "side"]);
        if clean {
            std::fs::write(dir.join("side.txt"), "side\n").unwrap();
        } else {
            std::fs::write(dir.join("base.txt"), "side change\n").unwrap();
        }
        git(dir, &["add", "."]);
        git(dir, &["commit", "-m", "side work"]);
        git(dir, &["checkout", "-q", "main"]);
        if clean {
            std::fs::write(dir.join("main.txt"), "main\n").unwrap();
        } else {
            std::fs::write(dir.join("base.txt"), "main change\n").unwrap();
        }
        git(dir, &["add", "."]);
        git(dir, &["commit", "-m", "main work"]);
        root
    }

    fn merge_state_and_session(dir: &Path) -> (WriteState, session::SessionState, u64) {
        let writes = WriteState::default();
        let sessions = session::SessionState::default();
        let view = session::open(&sessions, dir).unwrap();
        (writes, sessions, view.version)
    }

    #[test]
    fn clean_divergent_merge_creates_a_merge_commit() {
        let root = diverged_repo(true);
        let dir = root.path();
        let (writes, sessions, version) = merge_state_and_session(dir);
        let result = merge_start(&writes, &sessions, version, "side").unwrap();
        assert_eq!(result.outcome, Outcome::Success, "{}", result.message);
        assert!(result.message.contains("Merged side"));
        let snapshot = result.snapshot.expect("re-read");
        assert!(snapshot.operation.is_none());
        // Two parents pin that this is a merge commit, not a fast-forward.
        assert!(history::valid_oid(&read(dir, &["rev-parse", "HEAD^2"])));
    }

    #[test]
    fn conflict_is_not_a_failure_and_abort_restores() {
        let root = diverged_repo(false);
        let dir = root.path();
        let (writes, sessions, version) = merge_state_and_session(dir);
        let result = merge_start(&writes, &sessions, version, "side").unwrap();
        assert_eq!(result.outcome, Outcome::Conflicted);
        assert_eq!(result.exit_code, Some(1));
        let view = result.snapshot.expect("in-flight state");
        let operation = view.operation.expect("merge detected");
        assert_eq!(operation.kind, OperationKindView::Merge);
        assert_eq!(operation.subject, "Merge branch 'side'");
        assert!(view
            .files
            .iter()
            .any(|file| file.group == FileGroup::Conflict));

        let aborted = operation_abort(&writes, &sessions, view.version).unwrap();
        assert_eq!(aborted.outcome, Outcome::Success);
        let after = aborted.snapshot.expect("re-read");
        assert!(after.operation.is_none());
        assert!(after.files.is_empty(), "abort must restore a clean tree");
    }

    #[test]
    fn externally_resolved_conflict_continues_to_a_commit() {
        let root = diverged_repo(false);
        let dir = root.path();
        let (writes, sessions, version) = merge_state_and_session(dir);
        let conflicted = merge_start(&writes, &sessions, version, "side").unwrap();
        let view = conflicted.snapshot.expect("in-flight");

        // The user resolves outside guit (editor or mergetool), then stages.
        std::fs::write(dir.join("base.txt"), "resolved\n").unwrap();
        git(dir, &["add", "base.txt"]);

        let continued = operation_continue(&writes, &sessions, view.version).unwrap();
        assert_eq!(continued.outcome, Outcome::Success, "{}", continued.message);
        let after = continued.snapshot.expect("re-read");
        assert!(after.operation.is_none());
        assert!(history::valid_oid(&read(dir, &["rev-parse", "HEAD^2"])));
        assert_eq!(
            read(dir, &["log", "-1", "--format=%s"]),
            "Merge branch 'side'"
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("base.txt")).unwrap(),
            "resolved\n"
        );
    }

    #[test]
    fn rebase_conflict_reports_steps_and_skip_and_abort_work() {
        let root = diverged_repo(false);
        let dir = root.path();
        let (writes, sessions, version) = merge_state_and_session(dir);
        git(dir, &["checkout", "-q", "side"]);
        let version = session::refresh(&sessions)
            .unwrap()
            .map(|v| v.version)
            .unwrap_or(version);
        let result = rebase_start(&writes, &sessions, version, "main").unwrap();
        assert_eq!(result.outcome, Outcome::Conflicted, "{}", result.message);
        let view = result.snapshot.expect("in-flight");
        let operation = view.operation.expect("rebase detected");
        assert_eq!(operation.kind, OperationKindView::Rebase);
        assert_eq!(operation.subject, "Rebasing side");
        assert_eq!((operation.step, operation.total), (Some(1), Some(1)));

        // Skipping the only conflicting patch finishes the sequence.
        let skipped = operation_skip(&writes, &sessions, view.version).unwrap();
        assert_eq!(skipped.outcome, Outcome::Success, "{}", skipped.message);
        let after = skipped.snapshot.expect("re-read");
        assert!(after.operation.is_none());
        assert_eq!(
            read(dir, &["rev-parse", "HEAD"]),
            read(dir, &["rev-parse", "main"]),
            "skipping every patch leaves side at the upstream head"
        );
    }

    #[test]
    fn rebase_abort_restores_the_original_commit() {
        let root = diverged_repo(false);
        let dir = root.path();
        let (writes, sessions, _version) = merge_state_and_session(dir);
        git(dir, &["checkout", "-q", "side"]);
        let version = session::refresh(&sessions)
            .unwrap()
            .map(|v| v.version)
            .unwrap();
        let original = read(dir, &["rev-parse", "side"]);
        let conflicted = rebase_start(&writes, &sessions, version, "main").unwrap();
        assert_eq!(conflicted.outcome, Outcome::Conflicted);
        let view = conflicted.snapshot.expect("in-flight");
        let aborted = operation_abort(&writes, &sessions, view.version).unwrap();
        assert_eq!(aborted.outcome, Outcome::Success);
        assert!(aborted.snapshot.expect("re-read").operation.is_none());
        assert_eq!(read(dir, &["rev-parse", "side"]), original);
    }

    #[test]
    fn starts_refuse_while_an_operation_is_in_progress() {
        let root = diverged_repo(false);
        let dir = root.path();
        let (writes, sessions, version) = merge_state_and_session(dir);
        let conflicted = merge_start(&writes, &sessions, version, "side").unwrap();
        let view = conflicted.snapshot.expect("in-flight");
        let second = merge_start(&writes, &sessions, view.version, "main").unwrap();
        assert_eq!(second.outcome, Outcome::Rejected);
        assert!(second.message.contains("already in progress"));
        assert_eq!(second.exit_code, None, "refusal must not reach git");
        // The pending merge is untouched.
        assert!(view.version > 0);
        operation_abort(&writes, &sessions, second.snapshot.expect("state").version).unwrap();
    }

    #[test]
    fn revspec_and_unknown_targets_are_refused_before_git() {
        let root = diverged_repo(true);
        let dir = root.path();
        let (writes, sessions, version) = merge_state_and_session(dir);
        for bad in [
            "HEAD~1",
            "@{u}",
            "nosuchbranch",
            "origin/main",
            "",
            "side extra",
        ] {
            let result = merge_start(&writes, &sessions, version, bad).unwrap();
            assert_eq!(result.outcome, Outcome::Rejected, "{bad:?} was accepted");
            assert_eq!(result.exit_code, None, "{bad:?} reached git");
        }
        // Still exactly two commits: no merge happened.
        assert_eq!(read(dir, &["rev-list", "--count", "HEAD"]), "2");
    }

    #[test]
    fn stale_versions_and_idle_repository_are_refused() {
        let root = diverged_repo(true);
        let dir = root.path();
        let (writes, sessions, version) = merge_state_and_session(dir);
        // Idle: finish commands have nothing to drive.
        let idle = operation_continue(&writes, &sessions, version).unwrap();
        assert_eq!(idle.outcome, Outcome::Rejected);
        assert!(idle.message.contains("No Git operation"));
        // Stale snapshot: refused without reading markers. Every outcome
        // re-reads state, so chain from the refusal's fresh version.
        let current = idle.snapshot.expect("re-read").version;
        let stale = merge_start(&writes, &sessions, current + 1, "side").unwrap();
        assert_eq!(stale.outcome, Outcome::Rejected);
        assert!(stale.message.contains("rejected"));
    }

    #[test]
    fn clean_cherry_pick_replays_the_commit_and_keeps_its_message() {
        let root = diverged_repo(true);
        let dir = root.path();
        let (writes, sessions, version) = merge_state_and_session(dir);
        let side_oid = read(dir, &["rev-parse", "side"]);
        let before = read(dir, &["rev-list", "--count", "HEAD"]);
        let result = pick_commit(&writes, &sessions, version, &side_oid).unwrap();
        assert_eq!(result.outcome, Outcome::Success, "{}", result.message);
        assert!(result.message.contains("Cherry-picked"));
        let after = result.snapshot.expect("re-read");
        assert!(after.operation.is_none());
        assert_eq!(
            read(dir, &["rev-list", "--count", "HEAD"]),
            (before.parse::<u32>().unwrap() + 1).to_string()
        );
        // The replayed commit keeps the original subject and touches only
        // its own file; the side branch itself did not move.
        assert_eq!(read(dir, &["log", "-1", "--format=%s"]), "side work");
        assert_eq!(read(dir, &["rev-parse", "side"]), side_oid);
        assert!(dir.join("side.txt").exists());
    }

    #[test]
    fn conflicting_pick_becomes_a_cherry_pick_operation_and_abort_restores() {
        let root = diverged_repo(false);
        let dir = root.path();
        let (writes, sessions, version) = merge_state_and_session(dir);
        let side_oid = read(dir, &["rev-parse", "side"]);
        let head_before = read(dir, &["rev-parse", "HEAD"]);
        let result = pick_commit(&writes, &sessions, version, &side_oid).unwrap();
        assert_eq!(result.outcome, Outcome::Conflicted, "{}", result.message);
        let view = result.snapshot.expect("in-flight");
        let operation = view.operation.expect("cherry-pick detected");
        assert_eq!(operation.kind, OperationKindView::CherryPick);
        assert_eq!(operation.subject, format!("Cherry-picking {side_oid}…"));
        assert!(view
            .files
            .iter()
            .any(|file| file.group == FileGroup::Conflict));

        let aborted = operation_abort(&writes, &sessions, view.version).unwrap();
        assert_eq!(aborted.outcome, Outcome::Success, "{}", aborted.message);
        let after = aborted.snapshot.expect("re-read");
        assert!(after.operation.is_none());
        assert!(after.files.is_empty());
        assert_eq!(read(dir, &["rev-parse", "HEAD"]), head_before);
    }

    #[test]
    fn externally_resolved_pick_continues_without_an_editor() {
        let root = diverged_repo(false);
        let dir = root.path();
        let (writes, sessions, version) = merge_state_and_session(dir);
        let side_oid = read(dir, &["rev-parse", "side"]);
        let conflicted = pick_commit(&writes, &sessions, version, &side_oid).unwrap();
        let view = conflicted.snapshot.expect("in-flight");

        std::fs::write(dir.join("base.txt"), "picked resolution\n").unwrap();
        git(dir, &["add", "base.txt"]);
        let continued = operation_continue(&writes, &sessions, view.version).unwrap();
        assert_eq!(continued.outcome, Outcome::Success, "{}", continued.message);
        assert!(continued.snapshot.expect("re-read").operation.is_none());
        // Git's own cherry-pick message names the original commit.
        assert!(read(dir, &["log", "-1", "--format=%s"]).starts_with("side work"));
    }

    #[test]
    fn revert_creates_an_inverting_commit_without_an_editor() {
        let root = diverged_repo(true);
        let dir = root.path();
        let (writes, sessions, version) = merge_state_and_session(dir);
        let head_oid = read(dir, &["rev-parse", "HEAD"]);
        let result = revert_commit(&writes, &sessions, version, &head_oid).unwrap();
        assert_eq!(result.outcome, Outcome::Success, "{}", result.message);
        assert!(result.message.contains("Reverted"));
        assert!(result.snapshot.expect("re-read").operation.is_none());
        assert_eq!(
            read(dir, &["log", "-1", "--format=%s"]),
            "Revert \"main work\""
        );
        assert!(
            !dir.join("main.txt").exists(),
            "the revert must undo the commit's own file"
        );
    }

    #[test]
    fn pick_and_revert_refuse_branch_names_and_missing_commits() {
        let root = diverged_repo(true);
        let dir = root.path();
        let (writes, sessions, version) = merge_state_and_session(dir);
        // Well-formed but nonexistent: refused by the rev-parse gate.
        let ghost = "deadbeef".repeat(5);
        let mut version = version;
        for (command, target) in [
            ("pick", "side".to_owned()),
            ("pick", ghost.clone()),
            ("revert", "side".to_owned()),
            ("revert", ghost),
        ] {
            let result = if command == "pick" {
                pick_commit(&writes, &sessions, version, &target).unwrap()
            } else {
                revert_commit(&writes, &sessions, version, &target).unwrap()
            };
            assert_eq!(
                result.outcome,
                Outcome::Rejected,
                "{command} {target:?} accepted"
            );
            assert_eq!(result.exit_code, None, "{command} {target:?} reached git");
            assert!(result.message.contains("full commit id"));
            // Every outcome re-read state; the next attempt needs the new version.
            version = result.snapshot.expect("re-read").version;
        }
        // Nothing moved.
        assert_eq!(read(dir, &["rev-list", "--count", "HEAD"]), "2");
    }
}
