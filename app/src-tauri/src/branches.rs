//! Branch create / switch / rename / delete. Every
//! operation runs through the repository write queue, validates user-typed
//! names with the user's own Git (`check-ref-format`), and ends with a forced
//! re-read of the real state. Deletion is destructive: it requires the
//! preview → recheck → confirm ticket flow, safe `-d` first, and `-D` only
//! behind a separately confirmed force preview bound to the same object id.

use crate::probe::{Code, ProbeError};
use crate::write::{OperationKind, OperationResult, Outcome, PreviewResult, WriteState};
use crate::{history, refs, repo, runner, session};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

pub(crate) const MAX_NAME_LEN: usize = 200;

/// Rust-side guardrails that hold before Git is consulted: reject option-like
/// leading dashes so a name can never reach argv as a flag, reject `@{...}`
/// because `check-ref-format --branch` *expands* that shorthand instead of
/// rejecting it (a validated name could otherwise act on a different ref),
/// and reject control characters, which are illegal in ref names anyway.
pub(crate) fn precheck_name(name: &str) -> Result<(), ProbeError> {
    let unusable = name.is_empty()
        || name.len() > MAX_NAME_LEN
        || name.starts_with('-')
        || name.contains("@{")
        || name.chars().any(|c| (c as u32) < 0x20 || c as u32 == 0x7f);
    if unusable {
        return Err(ProbeError::new(
            "branch_name_invalid",
            "The branch name is not usable: no leading dashes, no @{...}, no control characters.",
        ));
    }
    Ok(())
}

/// Server-side rule: the user's Git must accept the name *and echo it back
/// unchanged*, so no normalization or shorthand expansion can turn the
/// validated string into a different target than the one Git will act on.
pub(crate) fn validate_branch_name(work_root: &Path, name: &str) -> Result<(), ProbeError> {
    precheck_name(name)?;
    let mut command = repo::user_git_command(work_root);
    command.args(["check-ref-format", "--branch", name]);
    let output = runner::run_with_limit(
        command,
        &AtomicBool::new(false),
        Duration::ZERO,
        Duration::from_secs(10),
        runner::DEFAULT_OUTPUT_LIMIT,
        |_, _| {},
    )?;
    let echoed = String::from_utf8_lossy(&output.stdout)
        .trim_end_matches('\n')
        .to_owned();
    if !output.status.success() || echoed != name {
        return Err(ProbeError::new(
            "branch_name_invalid",
            "Git rejected this branch name (check-ref-format).",
        ));
    }
    Ok(())
}

/// Looks a branch up in a fresh listing by display name. More than one row
/// can carry the same lossy display name (non-UTF8 bytes collide with a
/// literal U+FFFD), so a name must match exactly one *addressable* branch or
/// the operation refuses — guit never guesses which ref was meant.
fn unique_branch<'a>(
    listing: &'a refs::RefListing,
    name: &str,
) -> Result<&'a refs::BranchRef, ProbeError> {
    let mut matches = listing.branches.iter().filter(|b| b.name == name);
    let found = matches.next().ok_or_else(|| {
        ProbeError::new(
            "branch_missing",
            "That branch no longer exists in this repository.",
        )
    })?;
    if matches.next().is_some() {
        return Err(ProbeError::new(
            "branch_ambiguous",
            "Several branches display under this name; the request was refused.",
        ));
    }
    if !found.addressable {
        return Err(ProbeError::new(
            "branch_not_addressable",
            "That branch name is not byte-round-trippable; guit refuses to target it.",
        ));
    }
    Ok(found)
}

fn branch_exists(listing: &refs::RefListing, name: &str) -> bool {
    listing.branches.iter().any(|b| b.name == name)
}

pub(crate) fn run_git(
    work_root: &Path,
    args: &[&str],
    cancelled: &AtomicBool,
) -> Result<runner::CapturedOutput, ProbeError> {
    repo::git(work_root, repo::GitRun::read(args, cancelled))
}

enum BranchOp<'a> {
    Create {
        name: String,
        start_oid: Option<&'a str>,
    },
    Switch {
        name: String,
    },
    Rename {
        old: String,
        new: String,
    },
}

impl BranchOp<'_> {
    fn kind(&self) -> OperationKind {
        match self {
            BranchOp::Create { .. } => OperationKind::BranchCreate,
            BranchOp::Switch { .. } => OperationKind::BranchSwitch,
            BranchOp::Rename { .. } => OperationKind::BranchRename,
        }
    }

    fn names(&self) -> Vec<&str> {
        match self {
            BranchOp::Create { name, .. } => vec![name],
            BranchOp::Switch { name } => vec![name],
            BranchOp::Rename { old, new } => vec![old, new],
        }
    }
}

pub(crate) fn create_branch(
    state: &WriteState,
    sessions: &session::SessionState,
    snapshot_version: u64,
    name: &str,
    start_oid: Option<&str>,
) -> Result<OperationResult, ProbeError> {
    execute(
        state,
        sessions,
        snapshot_version,
        BranchOp::Create {
            name: name.to_owned(),
            start_oid,
        },
    )
}

pub(crate) fn switch_branch(
    state: &WriteState,
    sessions: &session::SessionState,
    snapshot_version: u64,
    name: &str,
) -> Result<OperationResult, ProbeError> {
    execute(
        state,
        sessions,
        snapshot_version,
        BranchOp::Switch {
            name: name.to_owned(),
        },
    )
}

pub(crate) fn rename_branch(
    state: &WriteState,
    sessions: &session::SessionState,
    snapshot_version: u64,
    old: &str,
    new: &str,
) -> Result<OperationResult, ProbeError> {
    execute(
        state,
        sessions,
        snapshot_version,
        BranchOp::Rename {
            old: old.to_owned(),
            new: new.to_owned(),
        },
    )
}

fn execute(
    state: &WriteState,
    sessions: &session::SessionState,
    snapshot_version: u64,
    op: BranchOp<'_>,
) -> Result<OperationResult, ProbeError> {
    let kind = op.kind();
    let operation_id = state.begin()?;
    let result = run(state, sessions, snapshot_version, &op, kind);
    state.finish();
    result.map(|mut result| {
        result.operation_id = operation_id;
        result
    })
}

/// Assumes the queue slot is held; tests call this directly to pre-arm
/// cancellation. Refusals before Git runs are Rejected; success, failure and
/// cancellation all end with `session::refresh` re-reading the real state.
fn run(
    state: &WriteState,
    sessions: &session::SessionState,
    snapshot_version: u64,
    op: &BranchOp<'_>,
    kind: OperationKind,
) -> Result<OperationResult, ProbeError> {
    // Session/version/bare gates, identical to commit-style writes.
    let (work_root, _unborn) = match sessions.commit_context(snapshot_version) {
        Ok(context) => context,
        Err(error) => {
            return crate::write::plain(sessions, kind, Outcome::Rejected, &error.message)
        }
    };
    if state.cancel_flag().load(Ordering::SeqCst) {
        return crate::write::plain(
            sessions,
            kind,
            Outcome::Cancelled,
            "Cancelled before Git ran.",
        );
    }
    let args = match prepare(&work_root, op) {
        Ok(args) => args,
        // A clean refusal the user must see; the message never contains a
        // filesystem path.
        Err(PrepareError::Rejected(error)) => {
            return crate::write::plain(sessions, kind, Outcome::Rejected, &error.message)
        }
        Err(PrepareError::Failed(error)) => return Err(error),
    };
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    let verb = args[0].to_owned();
    crate::write::run_and_report(
        sessions,
        kind,
        run_git(&work_root, &args, state.cancel_flag()),
        crate::write::Wording {
            ok: match kind {
                OperationKind::BranchCreate => "Branch created.".to_owned(),
                OperationKind::BranchSwitch => "Switched branch.".to_owned(),
                _ => "Branch renamed.".to_owned(),
            },
            failed: format!("{verb} reported a failure."),
            cancelled: "Cancelled while the Git process was running.".to_owned(),
        },
    )
}

/// Everything that must hold before a branch Git process may start: name
/// validation against the user's Git, plus existence checks against a
/// freshly re-listed ref catalog — never the client's view. `Rejected` is a
/// refusal the user should see as the outcome of their request; `Failed` is
/// an infrastructure problem (a recheck that could not run), which must
/// surface as a command error rather than a clean-looking refusal.
pub(crate) enum PrepareError {
    Rejected(ProbeError),
    Failed(ProbeError),
}

fn refuse(error: ProbeError) -> PrepareError {
    PrepareError::Rejected(error)
}

/// A name-validation failure is a refusal only when Git (or the precheck)
/// said the *name* is bad; a broken process pipeline is not.
fn validate_prepared(work_root: &Path, name: &str) -> Result<(), PrepareError> {
    validate_branch_name(work_root, name).map_err(|error| {
        if error.code == Code::BRANCH_NAME_INVALID {
            PrepareError::Rejected(error)
        } else {
            PrepareError::Failed(error)
        }
    })
}

fn prepare(work_root: &Path, op: &BranchOp<'_>) -> Result<Vec<String>, PrepareError> {
    for name in op.names() {
        validate_prepared(work_root, name)?;
    }
    match op {
        BranchOp::Create { name, start_oid } => {
            if start_oid.is_some_and(|oid| !history::valid_oid(oid)) {
                return Err(refuse(ProbeError::new(
                    "branch_start_point_invalid",
                    "The start point must be a full commit id.",
                )));
            }
            let listing = refs::list(work_root).map_err(PrepareError::Failed)?;
            if branch_exists(&listing, name) {
                return Err(refuse(ProbeError::new(
                    "branch_exists",
                    "A branch with that name already exists in this repository.",
                )));
            }
            let mut args = vec!["branch".to_string(), name.clone()];
            if let Some(oid) = start_oid {
                args.push((*oid).to_string());
            }
            Ok(args)
        }
        BranchOp::Switch { name } => {
            // `git switch` shares the 2.23 boundary with `git restore`.
            if !crate::write::restore_supported(work_root) {
                return Err(refuse(ProbeError::new(
                    "git_too_old",
                    "This Git is too old for switching; guit needs git switch (2.23+).",
                )));
            }
            Ok(vec!["switch".to_string(), name.clone()])
        }
        BranchOp::Rename { old, new } => {
            if old == new {
                return Err(refuse(ProbeError::new(
                    "branch_name_invalid",
                    "The new name must differ from the current name.",
                )));
            }
            let listing = refs::list(work_root).map_err(PrepareError::Failed)?;
            // The old side must still be uniquely addressable; the new side
            // must not shadow any listed name (`-m` would refuse, but the
            // user gets the clean message before Git is consulted).
            unique_branch(&listing, old).map_err(refuse)?;
            if branch_exists(&listing, new) {
                return Err(refuse(ProbeError::new(
                    "branch_exists",
                    "A branch with the new name already exists.",
                )));
            }
            Ok(vec![
                "branch".to_string(),
                "-m".to_string(),
                old.clone(),
                new.clone(),
            ])
        }
    }
}

pub(crate) fn preview_delete_branch(
    state: &WriteState,
    sessions: &session::SessionState,
    snapshot_version: u64,
    name: &str,
    force: bool,
) -> Result<PreviewResult, ProbeError> {
    let (work_root, _) = sessions.commit_context(snapshot_version)?;
    validate_branch_name(&work_root, name)?;
    let listing = refs::list(&work_root)?;
    let branch = unique_branch(&listing, name)?;
    if branch.head {
        return Err(ProbeError::new(
            "branch_checked_out",
            "The checked-out branch cannot be deleted; switch elsewhere first.",
        ));
    }
    let nonce = state.stage_ref_delete(
        crate::write::RefTarget::Branch,
        work_root,
        name.to_owned(),
        branch.oid.clone(),
        force,
    );
    let snapshot = session::refresh(sessions)?
        .ok_or_else(|| ProbeError::new("write_no_session", "No repository session is open."))?;
    Ok(PreviewResult {
        nonce,
        candidates: vec![name.to_owned()],
        dropped: Vec::new(),
        snapshot,
        target_oid: Some(branch.oid.clone()),
    })
}

pub(crate) fn delete_branch(
    state: &WriteState,
    sessions: &session::SessionState,
    nonce: String,
) -> Result<OperationResult, ProbeError> {
    let operation_id = state.begin()?;
    let result = run_delete(state, sessions, &nonce);
    state.finish();
    result.map(|mut result| {
        result.operation_id = operation_id;
        result
    })
}

/// The ticket is consumed either way. `-D` only ever runs for a ticket whose
/// preview was created with the explicit force flag; a re-listed branch whose
/// object id drifted from the previewed one is refused without Git running.
fn run_delete(
    state: &WriteState,
    sessions: &session::SessionState,
    nonce: &str,
) -> Result<OperationResult, ProbeError> {
    crate::write::confirm(
        state,
        sessions,
        OperationKind::BranchDelete,
        nonce,
        crate::write::Refusals {
            expired: "That confirmation has expired; preview the deletion again.",
            session_changed:
                "The repository session changed after the preview; no branch was deleted.",
            cancelled_before_git: "Cancelled before Git ran.",
        },
        |preview| match preview.bound {
            crate::write::Bound::RefDelete {
                target: crate::write::RefTarget::Branch,
                name,
                oid,
                force,
            } => Some((preview.work_root, (name, oid, force))),
            _ => None,
        },
        |work_root, (name, oid, _)| {
            let listing = refs::list(work_root)?;
            let unchanged = match unique_branch(&listing, name) {
                Ok(branch) => branch.oid == *oid && !branch.head,
                Err(_) => false,
            };
            Ok(if unchanged {
                Ok(())
            } else {
                Err(
                    "The branch changed after the preview; nothing was deleted. Confirm again."
                        .to_owned(),
                )
            })
        },
        |work_root, (name, _, force)| {
            let mode = if *force { "-D" } else { "-d" };
            crate::write::ran_from(
                run_git(work_root, &["branch", mode, name], state.cancel_flag()),
                crate::write::Wording {
                    ok: "Branch deleted.".to_owned(),
                    failed: "branch reported a failure.".to_owned(),
                    cancelled: "Cancelled while the Git process was running.".to_owned(),
                },
            )
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

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

    /// One page of history, asked the way the command layer asks it: with the
    /// context the live session published rather than an invented one, and with
    /// a graph cache. A test here reads a page and no more, so the cache is the
    /// fresh one a first page gets — the route that reads the whole prefix, and
    /// the only route a single page can take.
    fn read_page(
        dir: &Path,
        sessions: &session::SessionState,
    ) -> Result<history::HistoryPage, ProbeError> {
        let view = sessions
            .current_view()
            .expect("these tests open a session before reading history");
        history::page(
            dir,
            session::ReadContext {
                session_id: view.session_id,
                generation: Some(view.history_generation),
            },
            0,
            None,
            history::PAGE_SIZE,
            false,
            &history::GraphCache::default(),
        )
    }

    fn head(dir: &Path) -> String {
        let output = std::process::Command::new("git")
            .arg("-c")
            .arg("core.autocrlf=false")
            .arg("-C")
            .arg(dir)
            .args(["rev-parse", "HEAD"])
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/nonexistent-guit-test-config")
            .env("LC_ALL", "C")
            .output()
            .unwrap();
        String::from_utf8(output.stdout).unwrap().trim().to_owned()
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

    fn branch_names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = refs::list(dir)
            .unwrap()
            .branches
            .iter()
            .map(|b| b.name.clone())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn create_switch_and_rename_round_trip_through_the_queue() {
        let root = fixture();
        let dir = root.path();
        let sessions = session::SessionState::default();
        let view = session::open(&sessions, dir).unwrap();
        let writes = WriteState::default();

        let created = create_branch(&writes, &sessions, view.version, "dev", None).unwrap();
        assert_eq!(created.outcome, Outcome::Success);
        assert_eq!(created.operation_id, 1);
        let snapshot = created.snapshot.expect("state re-read after branch write");
        assert_eq!(
            snapshot.branch.as_ref().and_then(|b| b.name.as_deref()),
            Some("main")
        );
        assert_eq!(branch_names(dir), vec!["dev", "main"]);

        let renamed =
            rename_branch(&writes, &sessions, snapshot.version, "dev", "feature").unwrap();
        assert_eq!(renamed.outcome, Outcome::Success);
        let snapshot = renamed.snapshot.expect("re-read");
        assert_eq!(branch_names(dir), vec!["feature", "main"]);

        let switched = switch_branch(&writes, &sessions, snapshot.version, "feature").unwrap();
        assert_eq!(switched.outcome, Outcome::Success);
        assert_eq!(switched.operation_id, 3);
        let snapshot = switched.snapshot.expect("re-read");
        assert_eq!(
            snapshot.branch.as_ref().and_then(|b| b.name.as_deref()),
            Some("feature")
        );
        let listing = refs::list(dir).unwrap();
        assert!(listing
            .branches
            .iter()
            .any(|b| b.name == "feature" && b.head));
    }

    #[test]
    fn dangerous_names_are_refused_before_git() {
        let root = fixture();
        let dir = root.path();
        let sessions = session::SessionState::default();
        let view = session::open(&sessions, dir).unwrap();
        let writes = WriteState::default();
        for bad in [
            "",
            "with space",
            "-b",
            "@{u}",
            "x@{1}",
            "HEAD",
            "x~1",
            "tab\there",
            &"r".repeat(MAX_NAME_LEN + 1),
        ] {
            let result = create_branch(&writes, &sessions, view.version, bad, None).unwrap();
            assert_eq!(result.outcome, Outcome::Rejected, "{bad:?} was accepted");
            assert!(result.exit_code.is_none(), "{bad:?} reached Git");
        }
        assert_eq!(branch_names(dir), vec!["main"]);
    }

    #[test]
    fn stale_versions_duplicates_and_bad_start_points_are_refused() {
        let root = fixture();
        let dir = root.path();
        let sessions = session::SessionState::default();
        let view = session::open(&sessions, dir).unwrap();
        let writes = WriteState::default();

        // Every outcome — rejections included — re-reads the repository and
        // bumps the version, so each call must use the preceding snapshot.
        let stale = create_branch(&writes, &sessions, view.version + 1, "dev", None).unwrap();
        assert_eq!(stale.outcome, Outcome::Rejected);
        assert!(stale.message.contains("rejected"));

        let version = stale.snapshot.expect("re-read on rejection").version;
        let duplicate = create_branch(&writes, &sessions, version, "main", None).unwrap();
        assert_eq!(duplicate.outcome, Outcome::Rejected);
        assert!(duplicate.message.contains("already exists"));

        let version = duplicate.snapshot.expect("re-read").version;
        let shorthand = create_branch(&writes, &sessions, version, "dev", Some("HEAD~1")).unwrap();
        assert_eq!(shorthand.outcome, Outcome::Rejected);
        assert!(shorthand.message.contains("full commit id"));

        // A syntactically valid but absent start point fails inside Git —
        // Failed (not Rejected), with the redacted refusal as details.
        let ghost = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
        let version = shorthand.snapshot.expect("re-read").version;
        let missing = create_branch(&writes, &sessions, version, "ghost", Some(ghost)).unwrap();
        assert_eq!(missing.outcome, Outcome::Failed);
        assert!(missing.details.is_some());
        assert_eq!(branch_names(dir), vec!["main"]);
    }

    #[test]
    fn dirty_switch_is_refused_by_git_and_head_stays_put() {
        let root = fixture();
        let dir = root.path();
        let sessions = session::SessionState::default();
        let view = session::open(&sessions, dir).unwrap();
        let writes = WriteState::default();

        let created = create_branch(&writes, &sessions, view.version, "dev", None).unwrap();
        let snapshot = created.snapshot.expect("re-read");
        let switched = switch_branch(&writes, &sessions, snapshot.version, "dev").unwrap();
        assert_eq!(switched.outcome, Outcome::Success);
        let snapshot = switched.snapshot.expect("re-read");
        // Commit a change to a.txt on dev through the outside (simulated peer).
        std::fs::write(dir.join("a.txt"), "dev version\n").unwrap();
        git(dir, &["add", "--", "a.txt"]);
        git(dir, &["commit", "-q", "-m", "dev work"]);
        let back = switch_branch(&writes, &sessions, snapshot.version, "main").unwrap();
        assert_eq!(back.outcome, Outcome::Success);
        let snapshot = back.snapshot.expect("re-read");
        assert_eq!(
            snapshot.branch.as_ref().and_then(|b| b.name.as_deref()),
            Some("main")
        );

        std::fs::write(dir.join("a.txt"), "uncommitted local edit\n").unwrap();
        let refused = switch_branch(&writes, &sessions, snapshot.version, "dev").unwrap();
        assert_eq!(refused.outcome, Outcome::Failed);
        let details = refused.details.expect("Git's refusal is kept");
        assert!(details.contains("overwritten"), "{details}");
        // HEAD never moved and the local edit is intact.
        let snapshot = refused.snapshot.expect("re-read after failure");
        assert_eq!(
            snapshot.branch.as_ref().and_then(|b| b.name.as_deref()),
            Some("main")
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("a.txt")).unwrap(),
            "uncommitted local edit\n"
        );
    }

    #[test]
    fn delete_follows_preview_recheck_and_the_ticket_is_single_use() {
        let root = fixture();
        let dir = root.path();
        let sessions = session::SessionState::default();
        let view = session::open(&sessions, dir).unwrap();
        let writes = WriteState::default();

        let checked_out = preview_delete_branch(&writes, &sessions, view.version, "main", false);
        assert_eq!(checked_out.unwrap_err().code.as_str(), "branch_checked_out");

        let created = create_branch(&writes, &sessions, view.version, "side", None).unwrap();
        let snapshot = created.snapshot.expect("re-read");
        let preview =
            preview_delete_branch(&writes, &sessions, snapshot.version, "side", false).unwrap();
        assert_eq!(preview.candidates, vec!["side".to_owned()]);
        assert_eq!(preview.target_oid.as_deref(), Some(head(dir)).as_deref());

        // The branch moves after the preview → the confirmation refuses and
        // the (now different) branch survives untouched.
        git(dir, &["commit", "-q", "--allow-empty", "-m", "second"]);
        git(dir, &["branch", "-f", "side"]);
        let drifted = delete_branch(&writes, &sessions, preview.nonce.clone()).unwrap();
        assert_eq!(drifted.outcome, Outcome::Rejected);
        assert!(drifted.message.contains("after the preview"));
        assert!(branch_names(dir).contains(&"side".to_owned()));
        // The nonce was consumed by the refusal — replays expire too.
        let replay = delete_branch(&writes, &sessions, preview.nonce).unwrap();
        assert_eq!(replay.outcome, Outcome::Rejected);
        assert!(replay.message.contains("expired"));

        // A fresh preview against the current state deletes successfully.
        let snapshot = replay.snapshot.expect("re-read on expiry");
        let preview =
            preview_delete_branch(&writes, &sessions, snapshot.version, "side", false).unwrap();
        let deleted = delete_branch(&writes, &sessions, preview.nonce).unwrap();
        assert_eq!(deleted.outcome, Outcome::Success);
        assert_eq!(deleted.message, "Branch deleted.");
        assert_eq!(branch_names(dir), vec!["main"]);
    }

    #[test]
    fn unmerged_branch_needs_the_separately_confirmed_force_stage() {
        let root = fixture();
        let dir = root.path();
        let sessions = session::SessionState::default();
        let view = session::open(&sessions, dir).unwrap();
        let writes = WriteState::default();

        let created = create_branch(&writes, &sessions, view.version, "solo", None).unwrap();
        let snapshot = created.snapshot.expect("re-read");
        // Give solo a commit main does not contain (via the outside peer).
        git(dir, &["switch", "-q", "solo"]);
        git(dir, &["commit", "-q", "--allow-empty", "-m", "solo only"]);
        git(dir, &["switch", "-q", "main"]);

        let preview =
            preview_delete_branch(&writes, &sessions, snapshot.version, "solo", false).unwrap();
        let refused = delete_branch(&writes, &sessions, preview.nonce).unwrap();
        assert_eq!(refused.outcome, Outcome::Failed);
        let details = refused.details.expect("Git's unmerged refusal is kept");
        assert!(details.contains("not fully merged"), "{details}");
        assert!(branch_names(dir).contains(&"solo".to_owned()));

        // Force is only honored when the *preview* was created with it —
        // the user confirmed the stronger warning on purpose.
        let snapshot = refused.snapshot.expect("re-read after failure");
        let preview =
            preview_delete_branch(&writes, &sessions, snapshot.version, "solo", true).unwrap();
        let deleted = delete_branch(&writes, &sessions, preview.nonce).unwrap();
        assert_eq!(deleted.outcome, Outcome::Success);
        assert_eq!(branch_names(dir), vec!["main"]);
    }

    #[test]
    fn rename_refuses_same_existing_and_missing_names() {
        let root = fixture();
        let dir = root.path();
        let sessions = session::SessionState::default();
        let view = session::open(&sessions, dir).unwrap();
        let writes = WriteState::default();
        create_branch(&writes, &sessions, view.version, "dev", None).unwrap();
        let created = create_branch(&writes, &sessions, view.version, "dev", None).unwrap();
        let version = created.snapshot.expect("re-read").version;

        let same = rename_branch(&writes, &sessions, version, "dev", "dev").unwrap();
        assert_eq!(same.outcome, Outcome::Rejected);
        let version = same.snapshot.expect("re-read on refusal").version;
        let clash = rename_branch(&writes, &sessions, version, "dev", "main").unwrap();
        assert_eq!(clash.outcome, Outcome::Rejected);
        assert!(clash.message.contains("already exists"));
        let version = clash.snapshot.expect("re-read on refusal").version;
        let ghost = rename_branch(&writes, &sessions, version, "ghost", "ok").unwrap();
        assert_eq!(ghost.outcome, Outcome::Rejected);
        assert!(ghost.message.contains("no longer exists"));
        assert_eq!(branch_names(dir), vec!["dev", "main"]);
    }

    #[test]
    fn detached_head_keeps_refs_history_and_writes_consistent() {
        use crate::model::HeadState;
        let root = fixture();
        let dir = root.path();
        git(dir, &["commit", "-q", "--allow-empty", "-m", "second"]);
        git(dir, &["branch", "side"]);
        git(dir, &["switch", "-q", "--detach"]);
        let sessions = session::SessionState::default();
        let view = session::open(&sessions, dir).unwrap();
        let branch = view.branch.clone().unwrap();
        assert_eq!(branch.head_state, HeadState::Detached);
        assert!(branch.name.is_none() && branch.oid.is_some());

        // No branch carries the head marker while HEAD is detached, so even
        // "main" may be previewed for deletion — the ticket flow, not a
        // checked-out guard, is what protects it there.
        let listing = refs::list(dir).unwrap();
        assert!(listing.branches.iter().all(|b| !b.head));
        let writes = WriteState::default();
        let preview = preview_delete_branch(&writes, &sessions, view.version, "main", false)
            .expect("detached HEAD checks out no branch");
        assert_eq!(preview.candidates, vec!["main".to_owned()]);

        // History follows the detached HEAD, not any branch.
        let page = read_page(dir, &sessions).unwrap();
        assert_eq!(page.commits.len(), 2);
        assert_eq!(page.commits[0].oid, head(dir));

        // Re-attaching: a fresh branch lands on the detached commit, and a
        // switch restores a named HEAD with the marker moved along.
        let created =
            create_branch(&writes, &sessions, preview.snapshot.version, "rescue", None).unwrap();
        assert_eq!(created.outcome, Outcome::Success);
        let switched = switch_branch(
            &writes,
            &sessions,
            created.snapshot.unwrap().version,
            "side",
        )
        .unwrap();
        assert_eq!(switched.outcome, Outcome::Success);
        let snapshot = switched.snapshot.unwrap();
        let branch = snapshot.branch.clone().unwrap();
        assert_eq!(branch.head_state, HeadState::Branch);
        assert_eq!(branch.name.as_deref(), Some("side"));
        let listing = refs::list(dir).unwrap();
        assert!(listing.branches.iter().any(|b| b.name == "side" && b.head));
        assert!(listing.branches.iter().all(|b| b.name != "main" || !b.head));
    }

    #[test]
    fn unborn_head_refuses_writes_and_an_external_first_commit_unlocks_them() {
        use crate::model::HeadState;
        let root = tempfile::tempdir().unwrap();
        let dir = root.path();
        git(dir, &["init", "--quiet", "--initial-branch=main"]);
        let sessions = session::SessionState::default();
        let view = session::open(&sessions, dir).unwrap();
        assert_eq!(view.branch.clone().unwrap().head_state, HeadState::Unborn);
        let writes = WriteState::default();

        // Without any commit there is nothing to point a new branch at:
        // Git itself refuses, so the outcome is Failed (kept details), not a
        // clean-looking rejection, and the state is re-read either way.
        let created = create_branch(&writes, &sessions, view.version, "dev", None).unwrap();
        assert_eq!(created.outcome, Outcome::Failed);
        assert!(created.details.is_some());
        let version = created.snapshot.expect("re-read").version;
        let switched = switch_branch(&writes, &sessions, version, "main").unwrap();
        assert_eq!(switched.outcome, Outcome::Failed);
        let version = switched.snapshot.expect("re-read").version;
        let preview = preview_delete_branch(&writes, &sessions, version, "main", false);
        assert_eq!(preview.unwrap_err().code.as_str(), "branch_missing");
        // `git log` would error on an unborn HEAD. guit's command layer gates
        // this on head_state; deeper in, a page has to name the commit it is
        // about before asking Git anything, and an unborn HEAD names none — so
        // the refusal is the pin failing, never a history that looks empty.
        let error = read_page(dir, &sessions).unwrap_err();
        assert_eq!(error.code.as_str(), "history_head_unresolved");

        // A commit made in an external terminal must flip the snapshot and
        // make every read path meaningful without reopening the repository.
        std::fs::write(dir.join("a.txt"), "one\n").unwrap();
        git(dir, &["add", "--", "a.txt"]);
        git(dir, &["commit", "-q", "-m", "first from terminal"]);
        let after = session::refresh(&sessions)
            .unwrap()
            .expect("session still open");
        assert!(after.version > version);
        assert_eq!(after.branch.clone().unwrap().head_state, HeadState::Branch);
        let page = read_page(dir, &sessions).unwrap();
        assert_eq!(page.commits.len(), 1);
        let listing = refs::list(dir).unwrap();
        assert!(listing.branches.iter().any(|b| b.name == "main" && b.head));
    }

    #[test]
    fn external_terminal_moves_are_observed_by_writes_history_and_refs() {
        let root = fixture();
        let dir = root.path();
        let sessions = session::SessionState::default();
        let view = session::open(&sessions, dir).unwrap();
        let writes = WriteState::default();
        let created = create_branch(&writes, &sessions, view.version, "feature", None).unwrap();
        let version = created.snapshot.expect("re-read").version;

        // Outside the app: feature is renamed away and main gains a commit.
        git(dir, &["branch", "-m", "feature", "gone"]);
        git(
            dir,
            &["commit", "-q", "--allow-empty", "-m", "external work"],
        );

        // The client never crashes on the vanished name: Git's own refusal
        // is kept as a Failed outcome with the re-read riding along.
        let ghost = switch_branch(&writes, &sessions, version, "feature").unwrap();
        assert_eq!(ghost.outcome, Outcome::Failed);
        assert!(ghost
            .details
            .as_deref()
            .is_some_and(|line| !line.is_empty()));
        let version = ghost.snapshot.expect("re-read").version;

        // The renamed branch and the external commit are now visible.
        let switched = switch_branch(&writes, &sessions, version, "gone").unwrap();
        assert_eq!(switched.outcome, Outcome::Success);
        let snapshot = switched.snapshot.expect("re-read");
        assert_eq!(
            snapshot.branch.as_ref().unwrap().name.as_deref(),
            Some("gone")
        );
        // History follows the branch just switched to — "gone" still sits
        // on the base commit while main carries the external work.
        let listing = refs::list(dir).unwrap();
        let gone = listing.branches.iter().find(|b| b.name == "gone").unwrap();
        let main = listing.branches.iter().find(|b| b.name == "main").unwrap();
        assert_ne!(gone.oid, main.oid);
        assert!(gone.head && !main.head);
        assert!(!listing.branches.iter().any(|b| b.name == "feature"));
        let page = read_page(dir, &sessions).unwrap();
        assert_eq!(page.commits.len(), 1);
        assert_eq!(page.commits[0].oid, gone.oid);
    }

    #[test]
    fn cancelled_branch_write_never_reaches_git_and_still_refreshes() {
        let root = fixture();
        let dir = root.path();
        let sessions = session::SessionState::default();
        let view = session::open(&sessions, dir).unwrap();
        let writes = WriteState::default();
        // Hold the slot with cancellation armed, like cancel_write would.
        writes.begin().unwrap();
        writes.cancel();
        let result = run(
            &writes,
            &sessions,
            view.version,
            &BranchOp::Create {
                name: "dev".to_owned(),
                start_oid: None,
            },
            OperationKind::BranchCreate,
        )
        .unwrap();
        writes.finish();
        assert_eq!(result.outcome, Outcome::Cancelled);
        assert!(result.exit_code.is_none());
        assert!(result.snapshot.is_some());
        assert_eq!(branch_names(dir), vec!["main"]);
    }
}
