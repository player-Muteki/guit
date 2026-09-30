use crate::probe::{redact, Code, ProbeError};
use crate::status::StatusEntry;
use crate::{repo, runner, session, status};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime};

/// Exactly the facts one confirmation is bound to. Each variant holds what
/// its own confirm re-checks before Git runs, so a ticket can never carry a
/// fact the operation does not verify, and adding an operation adds a
/// variant rather than a new meaning for an existing field.
#[derive(Debug)]
pub(crate) enum Bound {
    /// Revert these tracked work-tree edits.
    Discard { paths: Vec<Vec<u8>> },
    /// Remove exactly these untracked items. `all_untracked` records *which*
    /// promise the user confirmed, and no field of `paths` can show it: an
    /// `true` ticket promises "everything Git reports as untracked", so one
    /// new untracked file afterwards invalidates it; a `false` ticket promises
    /// "these paths and only these", so a file appearing elsewhere in the
    /// repository is none of its business.
    Clean {
        paths: Vec<Vec<u8>>,
        all_untracked: bool,
    },
    /// Delete a branch or a tag. `target` keeps a branch ticket from ever
    /// authorizing a tag deletion (and vice versa): they share a shape but
    /// never a confirmation. `force` records the explicit, separately
    /// confirmed `-D` for a branch; a tag delete has no force path.
    RefDelete {
        target: RefTarget,
        name: String,
        oid: String,
        force: bool,
    },
    /// A `stash@{N}` entry, bound to the commit oid that selector resolved to.
    /// `action` keeps a drop confirmation from ever authorizing a pop: the two
    /// share a shape but never a confirmation, because one discards the
    /// changes and the other applies them.
    StashEntry {
        action: StashAction,
        selector: String,
        oid: String,
    },
    /// Reset hard: the target commit, the observed HEAD and the exact
    /// tracked-dirty set; all three must still match at confirm.
    ResetHard {
        dirty: Vec<Vec<u8>>,
        target_oid: String,
        head_oid: String,
    },
    /// A clean restore: the whole computed plan, not a display list. The
    /// preview may show these sets grouped and paginated, but every one of
    /// them is a fact the confirmation re-reads — the target and HEAD, the
    /// paths the two trees disagree about, the edits dropped, the untracked
    /// paths removed and written over, and the repositories that must still
    /// not be in the way. A plan read out of a ticket can therefore never be
    /// narrower than the plan that was shown.
    Restore {
        #[allow(dead_code)] // read by the confirmation this ticket is staged for
        plan: crate::reset::Restoration,
    },
    /// Remove a worktree bound to the HEAD it had when previewed.
    WorktreeRemove { path: String, head: String },
}

#[derive(Debug)]
pub(crate) struct Preview {
    pub(crate) work_root: PathBuf,
    pub(crate) bound: Bound,
}

/// Which ref a `RefDelete` ticket names. A branch and a tag are deleted by
/// different Git commands and confirmed separately, so a ticket carries which
/// one it is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RefTarget {
    Branch,
    Tag,
}

/// Which end of a stash entry a `StashEntry` ticket is for. Dropping and
/// popping are confirmed separately: pop re-applies the entry, drop throws it
/// away, so one confirmation must never authorize the other.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum StashAction {
    Drop,
    Pop,
}

/// Serializes every Git write in the repository, strictly in order.
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
        crate::util::guard(&self.previews).insert(nonce.clone(), ticket);
        nonce
    }

    /// One-time confirmation ticket for a ref deletion (branch or tag),
    /// bound to the name and the object id observed at preview time.
    pub(crate) fn stage_ref_delete(
        &self,
        target: RefTarget,
        work_root: PathBuf,
        name: String,
        oid: String,
        force: bool,
    ) -> String {
        self.stage_preview(Preview {
            work_root,
            bound: Bound::RefDelete {
                target,
                name,
                oid,
                force,
            },
        })
    }

    /// Ticket for a stash entry, bound to the commit its selector resolved
    /// to at preview time.
    pub(crate) fn stage_stash_entry(
        &self,
        action: StashAction,
        work_root: PathBuf,
        selector: String,
        oid: String,
    ) -> String {
        self.stage_preview(Preview {
            work_root,
            bound: Bound::StashEntry {
                action,
                selector,
                oid,
            },
        })
    }

    /// Everything a hard reset confirmation is bound to: the target commit,
    /// the HEAD observed at preview time and the exact tracked-dirty set.
    /// Hard reset is the only operation that may silently drop committed
    /// work, so `reset_hard` re-checks all three before Git runs.
    pub(crate) fn stage_reset_hard(
        &self,
        work_root: PathBuf,
        dirty: Vec<Vec<u8>>,
        target_oid: String,
        head_oid: String,
    ) -> String {
        self.stage_preview(Preview {
            work_root,
            bound: Bound::ResetHard {
                dirty,
                target_oid,
                head_oid,
            },
        })
    }

    /// Ticket for a clean restore, bound to the whole affected plan. Nothing is
    /// narrowed here: the plan that was computed is the plan that is re-read,
    /// so a preview cannot promise a set the confirmation stops checking.
    pub(crate) fn stage_restore(
        &self,
        work_root: PathBuf,
        plan: crate::reset::Restoration,
    ) -> String {
        self.stage_preview(Preview {
            work_root,
            bound: Bound::Restore { plan },
        })
    }

    /// Ticket for removing a worktree, bound to the path and the HEAD oid
    /// it carried when previewed.
    pub(crate) fn stage_worktree_remove(
        &self,
        work_root: PathBuf,
        path: String,
        head: String,
    ) -> String {
        self.stage_preview(Preview {
            work_root,
            bound: Bound::WorktreeRemove { path, head },
        })
    }

    /// Removes and returns the ticket for `nonce`, whatever operation staged
    /// it. This is the single-use gate: the ticket is gone from here on, so
    /// even a re-check that goes on to refuse still forces a fresh preview.
    /// Every caller narrows the returned [`Bound`] to the one variant it
    /// staged, so a nonce belonging to another operation reads as `None`
    /// rather than being reinterpreted.
    pub(crate) fn take_bound(&self, nonce: &str) -> Option<Preview> {
        crate::util::guard(&self.previews).remove(nonce)
    }

    pub(crate) fn clear_previews(&self) {
        crate::util::guard(&self.previews).clear();
    }
}

/// What an operation's Git invocation reports back: the outcome and the
/// wording shown, carried through into the shared result.
pub(crate) struct Ran {
    pub outcome: Outcome,
    pub message: String,
    pub details: Option<String>,
    pub exit_code: Option<i32>,
    pub suggestion: Option<String>,
}

impl Ran {
    /// A Git process that ran and reported success. `exit_code` is kept even
    /// on success: the frontend shows it as the operation's exit status.
    pub(crate) fn ok(message: impl Into<String>, exit_code: Option<i32>) -> Self {
        Self {
            outcome: Outcome::Success,
            message: message.into(),
            details: None,
            exit_code,
            suggestion: None,
        }
    }

    /// A Git process that ran and reported failure. `exit_code` and the
    /// redacted first stderr line are preserved; a truncated capture is
    /// never reported as success, because a partial read proves nothing.
    pub(crate) fn failed(message: impl Into<String>, output: &runner::CapturedOutput) -> Self {
        Self {
            outcome: Outcome::Failed,
            message: message.into(),
            details: Some(first_stderr_line(&output.stderr)),
            exit_code: output.status.code(),
            suggestion: None,
        }
    }

    /// Cancellation observed while the Git process was running.
    pub(crate) fn cancelled(message: impl Into<String>) -> Self {
        Self {
            outcome: Outcome::Cancelled,
            message: message.into(),
            details: None,
            exit_code: None,
            suggestion: None,
        }
    }
}

/// An operation's re-check: `Ok(Ok(()))` the bound facts still hold,
/// `Ok(Err(message))` they drifted, `Err` the re-check itself could not read
/// Git. A read failure is never treated as a clean answer.
pub(crate) type Recheck = Result<Result<(), String>, ProbeError>;

/// The three ways a local Git invocation can end, with the wording shown for
/// each. Grouped so an operation states all of its user-facing text in one
/// place, at the point that runs Git.
pub(crate) struct Wording {
    /// Shown when Git ran and reported success. Computed before Git starts,
    /// so it can be a plain string.
    pub ok: String,
    /// Shown when Git ran and reported failure. Git's own refusal is the
    /// authoritative reason, so this is a short label and the redacted first
    /// stderr line carries the detail.
    pub failed: String,
    /// Shown when cancellation arrived while Git was running. An operation
    /// that may have been left half-applied says so here rather than
    /// reporting a clean stop.
    pub cancelled: String,
}

/// Runs a captured local Git command and reports how it ended. A success is
/// only ever reported from a complete capture: a truncated read cannot prove
/// Git finished, so it is reported as a failure, never as success.
pub(crate) fn ran_from(
    output: Result<runner::CapturedOutput, ProbeError>,
    wording: Wording,
) -> Result<Ran, ProbeError> {
    match output {
        Ok(output) => {
            if output.status.success() && !output.truncated {
                Ok(Ran::ok(wording.ok, output.status.code()))
            } else {
                Ok(Ran::failed(wording.failed, &output))
            }
        }
        Err(error) if error.code == Code::PROCESS_CANCELLED => {
            Ok(Ran::cancelled(wording.cancelled))
        }
        Err(error) => Err(error),
    }
}

/// The two refusals every confirm reports, in each operation's own words.
/// They are supplied rather than fixed because they name what did *not*
/// happen — "no branch was deleted" is more use to the reader than a single
/// generic sentence, and that wording is part of the product.
pub(crate) struct Refusals {
    /// The confirmation is missing, already spent, or was issued for a
    /// different operation. The ticket is consumed either way.
    pub expired: &'static str,
    /// The ticket names a repository that is no longer the one open.
    pub session_changed: &'static str,
    /// Cancellation was already requested when the ticket was confirmed, so
    /// Git never started.
    pub cancelled_before_git: &'static str,
}

/// The one confirm flow, shared by every ticketed destructive operation.
///
/// Everything that must not vary between operations is decided here, once:
/// the ticket is consumed whether or not the answer is a refusal; a missing
/// or mis-shaped nonce reports the standard expired confirmation; a ticket
/// whose repository is no longer the open one is refused; the operation's own
/// bound facts are re-verified; a cancellation that arrived before Git ran is
/// reported as cancelled; and every answer — refusal, cancellation, failure
/// or success — carries a freshly re-read snapshot.
///
/// An operation supplies three closures and nothing else: which bound facts
/// its ticket holds, how to re-verify them, and how to run Git once they hold.
/// That is the whole per-operation interface.
///
/// The seam is this function rather than a `trait`: Git is a single adapter
/// (the user's own `git`), so a port over it would be indirection with nothing
/// behind it. `B` is the operation's own bound-facts type, chosen at the call
/// site, so a ticket staged for one operation can never be read as another's.
// The last three arguments are the operation's whole contribution: what its
/// ticket holds, how to re-verify it, and how to run Git. They are separate
// closures rather than one bundle so the call site reads as the flow itself.
#[allow(clippy::too_many_arguments)]
pub(crate) fn confirm<B>(
    state: &WriteState,
    sessions: &session::SessionState,
    kind: OperationKind,
    nonce: &str,
    refusals: Refusals,
    facts: impl FnOnce(Preview) -> Option<(PathBuf, B)>,
    recheck: impl FnOnce(&Path, &B) -> Recheck,
    run: impl FnOnce(&Path, &B) -> Result<Ran, ProbeError>,
) -> Result<OperationResult, ProbeError> {
    // The ticket is consumed here whether or not the answer is a refusal, so
    // a replayed or mis-shaped confirm can never be reused.
    let Some((work_root, bound)) = state.take_bound(nonce).and_then(facts) else {
        return plain(sessions, kind, Outcome::Rejected, refusals.expired);
    };
    // The repository a ticket was staged against must still be the one open.
    let same_repo = sessions
        .current_identity()
        .is_some_and(|identity| identity.work_root.as_deref() == Some(work_root.as_path()));
    if !same_repo {
        return plain(sessions, kind, Outcome::Rejected, refusals.session_changed);
    }
    match recheck(&work_root, &bound)? {
        Ok(()) => {}
        Err(message) => return plain(sessions, kind, Outcome::Rejected, &message),
    }
    if state.cancelled.load(Ordering::SeqCst) {
        return plain(
            sessions,
            kind,
            Outcome::Cancelled,
            refusals.cancelled_before_git,
        );
    }
    let ran = run(&work_root, &bound)?;
    Ok(OperationResult {
        suggestion: ran.suggestion,
        operation_id: 0,
        kind,
        outcome: ran.outcome,
        exit_code: ran.exit_code,
        message: ran.message,
        details: ran.details,
        snapshot: session::refresh(sessions)?,
    })
}

/// A result with no Git outcome to report — a refusal, an expiry or a
/// cancellation — carrying a freshly re-read snapshot. Also the answer for a
/// non-ticketed write that was refused before Git ran.
pub(crate) fn plain(
    sessions: &session::SessionState,
    kind: OperationKind,
    outcome: Outcome,
    message: &str,
) -> Result<OperationResult, ProbeError> {
    Ok(OperationResult {
        suggestion: None,
        operation_id: 0,
        kind,
        outcome,
        exit_code: None,
        message: message.to_owned(),
        details: None,
        snapshot: session::refresh(sessions)?,
    })
}

/// The answer the frontend applies, built from a completed Git run: a freshly
/// re-read snapshot plus whatever the run reported. The non-ticketed half of
/// the write lane uses this; the ticketed half reaches the same result
/// through [`confirm`], so the snapshot re-read and the outcome wording are
/// decided in one place.
pub(crate) fn report(
    sessions: &session::SessionState,
    kind: OperationKind,
    ran: Ran,
) -> Result<OperationResult, ProbeError> {
    Ok(OperationResult {
        suggestion: ran.suggestion,
        operation_id: 0,
        kind,
        outcome: ran.outcome,
        exit_code: ran.exit_code,
        message: ran.message,
        details: ran.details,
        snapshot: session::refresh(sessions)?,
    })
}

/// Runs a Git command and reports how it ended as the whole answer. This is
/// the shape most writes need once their gates have passed: one call owns
/// the run→outcome rule, so a truncated capture is never success and a
/// cancellation is never a failure.
pub(crate) fn run_and_report(
    sessions: &session::SessionState,
    kind: OperationKind,
    output: Result<runner::CapturedOutput, ProbeError>,
    wording: Wording,
) -> Result<OperationResult, ProbeError> {
    report(sessions, kind, ran_from(output, wording)?)
}

/// Unguessable one-time token. `RandomState` draws fresh SipHash keys from
/// system entropy per instance, so two finishes are 128 bits of unpredictable
/// data — enough to bind a confirm click to the preview that produced it
/// without pulling in a cryptography dependency.
pub(crate) fn new_nonce() -> String {
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
    StashSave,
    StashApply,
    StashPop,
    StashDrop,
    Merge,
    Rebase,
    CherryPick,
    Revert,
    Continue,
    Abort,
    Skip,
    Reset,
    ResetHard,
    /// A clean restore: the two-step write — `reset --hard` to the target and a
    /// bounded `clean` over the paths the ticket named. It is its own kind
    /// rather than `ResetHard` with a longer message, because the answer it
    /// reports is about two Git processes and not one.
    Restore,
    WorktreeAdd,
    WorktreeRemove,
    WorktreePrune,
}

/// The write kinds that run as a bare path-scoped `git <prefix> -- <paths>`.
///
/// This set is deliberately its own type rather than a match over
/// `OperationKind` returning an empty prefix for the kinds that own their own
/// runners. A prefix table that maps 27 kinds to `&[]` compiles fine and then
/// runs `git` with no subcommand if a kind is ever routed through it, so the
/// routing decision is made once, here, where adding a variant forces the
/// author to supply a real prefix or pick a different runner.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PathWrite {
    Stage,
    Unstage,
}

impl PathWrite {
    /// Git argument prefix plus the past-tense verb for the result message.
    fn plan(self) -> (&'static [&'static str], &'static str) {
        match self {
            PathWrite::Stage => (&["add"], "Staged"),
            PathWrite::Unstage => (&["restore", "--staged"], "Unstaged"),
        }
    }

    /// The kind reported back to the frontend, which is the vocabulary it
    /// already knows; the path-scoped lane is an implementation detail of it.
    fn kind(self) -> OperationKind {
        match self {
            PathWrite::Stage => OperationKind::Stage,
            PathWrite::Unstage => OperationKind::Unstage,
        }
    }

    /// `git restore` only exists from 2.23; staging works on any supported Git.
    fn needs_restore(self) -> bool {
        matches!(self, PathWrite::Unstage)
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
    /// Git stopped with conflicts (merge/rebase/cherry-pick/revert). A
    /// conflict is progress in a sequence, not an ordinary failure; the
    /// snapshot's `operation` field drives the continue/abort affordances.
    Conflicted,
    /// An operation that is more than one Git process, where one ran and the
    /// promise was not kept. Neither a failure — the first step is not undone by
    /// the second one — nor a success. Only the clean restore answers with it.
    Partial,
}

/// Uniform answer for write operations. The embedded
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
    /// Fixed advice text for an operation that needs to offer one; `None`
    /// for every local write, which reports Git's own outcome only.
    pub suggestion: Option<String>,
    pub snapshot: Option<session::SnapshotView>,
}

/// Takes the queue slot and runs one path-scoped write. The only two
/// operations that reach this lane are staging and unstaging; everything else
/// has its own runner because it needs a preview ticket, a sequencer or a
/// network leg.
pub(crate) fn execute(
    state: &WriteState,
    sessions: &session::SessionState,
    snapshot_version: u64,
    file_ids: Vec<u32>,
    write: PathWrite,
) -> Result<OperationResult, ProbeError> {
    let operation_id = state.begin()?;
    let result = run_write(state, sessions, snapshot_version, file_ids, write);
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
    write: PathWrite,
) -> Result<OperationResult, ProbeError> {
    let kind = write.kind();
    let (git_prefix, verb) = write.plan();
    let (work_root, targets) = match sessions.resolve_files(snapshot_version, &file_ids) {
        Ok(resolved) => resolved,
        Err(error) => return plain(sessions, kind, Outcome::Rejected, &error.message),
    };
    if write.needs_restore() && !restore_supported(&work_root) {
        return plain(
            sessions,
            kind,
            Outcome::Rejected,
            "This Git is too old for unstaging; guit needs git restore (2.23+).",
        );
    }
    if state.cancelled.load(Ordering::SeqCst) {
        return plain(
            sessions,
            kind,
            Outcome::Cancelled,
            "Cancelled before Git ran.",
        );
    }
    run_and_report(
        sessions,
        kind,
        run_git_paths(&work_root, git_prefix, &targets, &state.cancelled),
        Wording {
            ok: format!("{verb} {} file(s).", targets.len()),
            failed: format!("{} reported a failure.", git_prefix[0]),
            cancelled: "Cancelled while the Git process was running.".to_owned(),
        },
    )
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
    let kind = OperationKind::Commit;
    if message.trim().is_empty() {
        return plain(
            sessions,
            kind,
            Outcome::Rejected,
            "Commit message is empty.",
        );
    }
    let (work_root, unborn) = match sessions.commit_context(snapshot_version) {
        Ok(context) => context,
        Err(error) => return plain(sessions, kind, Outcome::Rejected, &error.message),
    };
    if amend && unborn {
        return plain(
            sessions,
            kind,
            Outcome::Rejected,
            "This branch has no commit to amend yet.",
        );
    }
    if state.cancelled.load(Ordering::SeqCst) {
        return plain(
            sessions,
            kind,
            Outcome::Cancelled,
            "Cancelled before Git ran.",
        );
    }
    let message_file = tempfile::NamedTempFile::new()
        .map_err(|error| ProbeError::new("commit_temp_failed", error.to_string()))?;
    let mut written = message_file
        .reopen()
        .map_err(|error| ProbeError::new("commit_temp_failed", error.to_string()))?;
    use std::io::Write;
    written
        .write_all(message.as_bytes())
        .map_err(|error| ProbeError::new("commit_temp_failed", error.to_string()))?;
    written
        .write_all(b"\n")
        .and_then(|_| written.sync_all())
        .map_err(|error| ProbeError::new("commit_temp_failed", error.to_string()))?;
    drop(written);
    let mut command = repo::user_git_command(&work_root);
    command.args(["commit", "-F"]);
    command.arg(message_file.path());
    if amend {
        command.arg("--amend");
    }
    run_and_report(
        sessions,
        kind,
        runner::run_with_limit(
            command,
            &state.cancelled,
            Duration::ZERO,
            Duration::from_secs(600),
            runner::DEFAULT_OUTPUT_LIMIT,
            |_, _| {},
        ),
        Wording {
            ok: if amend {
                "Amended the last commit.".to_owned()
            } else {
                "Commit completed.".to_owned()
            },
            failed: "git commit reported a failure.".to_owned(),
            cancelled: "Cancelled while the Git process was running.".to_owned(),
        },
    )
    // message_file drops here, after Git has read it.
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
        bound: Bound::Discard {
            paths: candidates.clone(),
        },
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
/// the UI to preview again: a changed candidate set refuses re-confirmation.
pub(crate) fn run_discard(
    state: &WriteState,
    sessions: &session::SessionState,
    nonce: &str,
) -> Result<OperationResult, ProbeError> {
    confirm(
        state,
        sessions,
        OperationKind::Discard,
        nonce,
        Refusals {
            expired: "That confirmation has expired; preview the discard again.",
            session_changed:
                "The repository session changed after the preview; nothing was discarded.",
            cancelled_before_git: "Cancelled before Git ran.",
        },
        |preview| match preview.bound {
            Bound::Discard { paths } => Some((preview.work_root, paths)),
            _ => None,
        },
        |work_root, paths| {
            if !restore_supported(work_root) {
                return Ok(Err(
                    "This Git is too old for discarding; guit needs git restore (2.23+)."
                        .to_owned(),
                ));
            }
            let entries = status_index(sessions)?;
            let unchanged = paths
                .iter()
                .all(|raw| entries.get(raw).is_some_and(worktree_dirty));
            Ok(if unchanged {
                Ok(())
            } else {
                Err(
                    "Files changed after the preview; nothing was discarded. Confirm again."
                        .to_owned(),
                )
            })
        },
        |work_root, paths| {
            ran_from(
                run_git_paths(
                    work_root,
                    &["restore", "--worktree"],
                    paths,
                    &state.cancelled,
                ),
                Wording {
                    ok: format!("Discarded work-tree changes in {} file(s).", paths.len()),
                    failed: "restore reported a failure.".to_owned(),
                    cancelled: "Cancelled while the Git process was running.".to_owned(),
                },
            )
        },
    )
}

/// Fresh porcelain-v2 read keyed by raw path bytes, used to recompute
/// destructive candidates independently of any client state.
pub(crate) fn status_index(
    sessions: &session::SessionState,
) -> Result<BTreeMap<Vec<u8>, StatusEntry>, ProbeError> {
    let identity = sessions
        .current_identity()
        .ok_or_else(|| ProbeError::new("write_no_session", "No repository session is open."))?;
    let read = repo::status_output(&identity, true)?;
    // A destructive candidate set computed from a listing Git could not finish
    // reading is not a bound fact. The preview would show fewer paths than the
    // operation touches, so the recheck refuses rather than proceeding with a
    // warning: a wrong hard reset is not recoverable, a refused one is.
    if read.warned {
        return Err(ProbeError::new(
            "write_incomplete_read",
            "Git could not read part of the repository; the operation was refused.",
        ));
    }
    let raw = read.stdout;
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
///
/// A non-empty `scope` limits the listing to those exact paths, which is also
/// how a request for one file inside an untracked directory gets the answer
/// `Would remove dir/a.txt` instead of the collapsed `dir/` (measured on Git
/// 2.53). Paths quoted this way can only name themselves; Git will not list an
/// ignored file or a nested repository through them at all, so a request for
/// either comes back empty rather than forceful.
pub(crate) fn clean_candidates(
    work_root: &Path,
    scope: &[Vec<u8>],
) -> Result<Vec<(Vec<u8>, bool)>, ProbeError> {
    let mut command = repo::user_git_command(work_root);
    command.args(["clean", "-nd"]);
    if !scope.is_empty() {
        let specs = scope
            .iter()
            .map(|raw| raw_to_os(&quote_pathspec(raw)))
            .collect::<Result<Vec<OsString>, ProbeError>>()?;
        command.arg("--");
        command.args(specs);
    }
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

/// Clean's preview, in the two shapes the panel can ask for. With no file ids
/// it binds everything a fresh `git clean -nd` reports (ignored files
/// excluded). With file ids it binds only the requested paths Git itself
/// agrees to remove and reports the rest as dropped. Either way the exact set
/// goes under a one-time nonce, so removing one file is never the whole-repo
/// clean wearing a shorter list.
pub(crate) fn preview_clean(
    state: &WriteState,
    sessions: &session::SessionState,
    snapshot_version: u64,
    file_ids: &[u32],
) -> Result<PreviewResult, ProbeError> {
    let (work_root, scope) = if file_ids.is_empty() {
        (sessions.commit_context(snapshot_version)?.0, Vec::new())
    } else {
        sessions.resolve_files(snapshot_version, file_ids)?
    };
    let all_untracked = scope.is_empty();
    let found = clean_candidates(&work_root, &scope)?;
    if found.is_empty() {
        return Err(ProbeError::new(
            "clean_nothing",
            if all_untracked {
                "There are no untracked files to remove."
            } else {
                "None of the selected items can be removed: a clean takes untracked files that are not ignored and not a separate Git repository."
            },
        ));
    }
    let snapshot = session::refresh(sessions)?
        .ok_or_else(|| ProbeError::new("write_no_session", "No repository session is open."))?;
    // A requested path Git did not list is reported as skipped rather than
    // explained: tracked, ignored, gone and "a repository of its own" all read
    // the same from here, and a clean cannot tell them apart.
    let dropped = scope
        .iter()
        .filter(|raw| !found.iter().any(|(cleaned, _)| cleaned == *raw))
        .map(|raw| crate::model::display_name(raw))
        .collect();
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
        bound: Bound::Clean {
            paths,
            all_untracked,
        },
    });
    Ok(PreviewResult {
        nonce,
        candidates,
        dropped,
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

/// Assumes the queue slot is held; tests call this directly. The paths a fresh
/// `git clean -nd` still agrees to remove — asked the same scoped question the
/// preview asked — must be exactly the set the ticket bound; a match then
/// deletes by literal pathspec so the execution can never touch anything the
/// user did not confirm.
pub(crate) fn run_clean(
    state: &WriteState,
    sessions: &session::SessionState,
    nonce: &str,
) -> Result<OperationResult, ProbeError> {
    confirm(
        state,
        sessions,
        OperationKind::Clean,
        nonce,
        Refusals {
            expired: "That confirmation has expired; preview the clean again.",
            session_changed:
                "The repository session changed after the preview; nothing was removed.",
            cancelled_before_git: "Cancelled before Git ran.",
        },
        |preview| match preview.bound {
            Bound::Clean {
                paths,
                all_untracked,
            } => Some((preview.work_root, (paths, all_untracked))),
            _ => None,
        },
        |work_root, (paths, all_untracked)| {
            let scope = if *all_untracked {
                Vec::new()
            } else {
                paths.clone()
            };
            let mut fresh = clean_candidates(work_root, &scope)?
                .into_iter()
                .map(|(raw, _)| raw)
                .collect::<Vec<_>>();
            let mut expected = paths.clone();
            fresh.sort();
            expected.sort();
            Ok(if fresh == expected {
                Ok(())
            } else {
                Err(
                    "Untracked files changed after the preview; nothing was removed. Confirm again."
                        .to_owned(),
                )
            })
        },
        |work_root, (paths, _)| {
            ran_from(
                run_git_paths(work_root, &["clean", "-fd"], paths, &state.cancelled),
                Wording {
                    ok: format!("Removed {} untracked item(s).", paths.len()),
                    failed: "git clean reported a failure.".to_owned(),
                    cancelled: "Cancelled while the Git process was running.".to_owned(),
                },
            )
        },
    )
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

/// Git reads a pathspec as a pattern unless it carries this magic prefix, so
/// an unquoted `s*.txt` matches `s1.txt` too. Every path a ticket binds came
/// out of Git's own listing, so it is a name, never a pattern: quoting it is
/// what makes "the files the user confirmed" and "the files Git touches" the
/// same set by construction. Measured on Git 2.53 with `restore`, `add` and
/// `clean`; the prefix itself is older than every Git version guit supports.
const PATHSPEC_LITERAL: &[u8] = b":(literal)";

fn quote_pathspec(raw: &[u8]) -> Vec<u8> {
    let mut quoted = Vec::with_capacity(PATHSPEC_LITERAL.len() + raw.len());
    quoted.extend_from_slice(PATHSPEC_LITERAL);
    quoted.extend_from_slice(raw);
    quoted
}

/// `git <args…> -- <paths…>` with argument arrays only — paths arrive as the
/// exact bytes Git reported, quoted as literal pathspecs, converted to OS
/// arguments and placed behind a `--` separator, so no shell or display-name
/// round trip happens and no name is read as a pattern.
pub(crate) fn run_git_paths(
    work_root: &Path,
    git_prefix: &[&str],
    targets: &[Vec<u8>],
    cancelled: &AtomicBool,
) -> Result<runner::CapturedOutput, ProbeError> {
    let paths = targets
        .iter()
        .map(|target| raw_to_os(&quote_pathspec(target)))
        .collect::<Result<Vec<OsString>, ProbeError>>()?;
    repo::git(
        work_root,
        repo::GitRun::paths(git_prefix, &paths, cancelled),
    )
}

pub(crate) fn raw_to_os(raw: &[u8]) -> Result<OsString, ProbeError> {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStringExt;
        // The `use` above means this block cannot be a tail expression, so the
        // `return` is what makes the unix build return `Result` (the
        // `not(unix)` arm is compiled out here). Removing it fails to compile
        // on unix; clippy's `needless_return` does not model the cfg split.
        #[allow(clippy::needless_return)]
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
        execute(state, sessions, version, ids, PathWrite::Stage)
    }

    fn run_stage(
        state: &WriteState,
        sessions: &session::SessionState,
        version: u64,
        ids: Vec<u32>,
    ) -> Result<OperationResult, ProbeError> {
        run_write(state, sessions, version, ids, PathWrite::Stage)
    }

    #[test]
    fn tickets_never_resurrect_across_a_process_restart() {
        // A ticket staged before a kill -9 must be worthless afterwards:
        // WriteState lives in memory only, so the new process refuses the
        // old nonce and the destructive command cannot run without a fresh
        // preview.
        let staged = WriteState::default().stage_ref_delete(
            RefTarget::Branch,
            PathBuf::from("/repository"),
            "topic".to_owned(),
            "0".repeat(40),
            false,
        );
        let after_restart = WriteState::default();
        assert!(after_restart.take_bound(&staged).is_none());
        // The same nonce is single-use within one process too, and a ticket
        // staged for one operation is never readable as another.
        let state = WriteState::default();
        let nonce = state.stage_ref_delete(
            RefTarget::Branch,
            PathBuf::from("/repository"),
            "topic".to_owned(),
            "0".repeat(40),
            false,
        );
        assert!(matches!(
            state.take_bound(&nonce).map(|ticket| ticket.bound),
            Some(Bound::RefDelete { .. })
        ));
        assert!(state.take_bound(&nonce).is_none());
    }

    /// The two operations that share a ticket shape still never share a
    /// confirmation: a branch ticket and a tag ticket are both
    /// `RefDelete`, discriminated only by `target`, and a drop ticket and a
    /// pop ticket are both `StashEntry`, discriminated only by `action`.
    /// Each reader must reject the other's ticket as "not mine", which the
    /// confirm flow turns into a consumed-and-expired refusal.
    #[test]
    fn a_ticket_is_readable_only_by_the_operation_that_staged_it() {
        // Reading helpers mirroring each confirm call site's `facts` arm.
        fn read_branch(ticket: Preview) -> bool {
            matches!(
                ticket.bound,
                Bound::RefDelete {
                    target: RefTarget::Branch,
                    ..
                }
            )
        }
        fn read_tag(ticket: Preview) -> bool {
            matches!(
                ticket.bound,
                Bound::RefDelete {
                    target: RefTarget::Tag,
                    ..
                }
            )
        }
        fn read_pop(ticket: Preview) -> bool {
            matches!(
                ticket.bound,
                Bound::StashEntry {
                    action: StashAction::Pop,
                    ..
                }
            )
        }
        let root = PathBuf::from("/repository");
        let oid = "0".repeat(40);

        let branch = WriteState::default().stage_ref_delete(
            RefTarget::Branch,
            root.clone(),
            "topic".to_owned(),
            oid.clone(),
            false,
        );
        let state = WriteState::default();
        let branch_nonce = state.stage_ref_delete(
            RefTarget::Branch,
            root.clone(),
            "topic".to_owned(),
            oid.clone(),
            false,
        );
        // A branch ticket is not a tag ticket and not a pop ticket.
        assert!(read_branch(state.take_bound(&branch_nonce).unwrap()));
        // The dispatcher matches each ticket to exactly one reader.
        let _ = branch; // keeps the standalone staging exercised

        let tag_state = WriteState::default();
        let tag_nonce = tag_state.stage_ref_delete(
            RefTarget::Tag,
            root.clone(),
            "v1".to_owned(),
            oid.clone(),
            false,
        );
        assert!(read_tag(tag_state.take_bound(&tag_nonce).unwrap()));
        assert!(!read_branch(Preview {
            work_root: root.clone(),
            bound: Bound::RefDelete {
                target: RefTarget::Tag,
                name: "v1".to_owned(),
                oid: oid.clone(),
                force: false,
            }
        }));

        // A pop ticket is not a drop ticket.
        let pop_state = WriteState::default();
        let pop_nonce = pop_state.stage_stash_entry(
            StashAction::Pop,
            root.clone(),
            "stash@{0}".to_owned(),
            oid.clone(),
        );
        let pop_ticket = pop_state.take_bound(&pop_nonce).unwrap();
        assert!(read_pop(pop_ticket));
        assert!(!read_pop(Preview {
            work_root: root,
            bound: Bound::StashEntry {
                action: StashAction::Drop,
                selector: "stash@{0}".to_owned(),
                oid,
            }
        }));
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
        assert_eq!(error.code.as_str(), "write_queue_busy");
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
            PathWrite::Unstage,
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
            PathWrite::Stage,
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
            PathWrite::Unstage,
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

    /// The whole-repository form of the clean preview: no file ids, so every
    /// path Git reports as untracked is bound.
    fn preview_clean_all(
        writes: &WriteState,
        sessions: &session::SessionState,
        version: u64,
    ) -> Result<PreviewResult, ProbeError> {
        preview_clean(writes, sessions, version, &[])
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
        assert_eq!(error.code.as_str(), "discard_untracked");
        // The refusal happens before staging a ticket or running Git.
        assert_eq!(
            std::fs::read_to_string(root.join("a.txt")).unwrap(),
            "a dirty\n"
        );
        assert!(writes.take_bound("any").is_none());
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

    /// Git reads a bare pathspec as a pattern, so `git restore --worktree
    /// -- 's*.txt'` reverts every dirty file whose name fits (measured on Git
    /// 2.53). One confirmed file then discards a family nobody confirmed, and
    /// the preview — which lists paths, never patterns — cannot show it.
    #[test]
    fn discarding_one_file_never_reverts_a_file_whose_name_its_pattern_matches() {
        let repository = repo_with_base(&[("s*.txt", "star\n"), ("s1.txt", "one\n")]);
        let root = repository.path();
        std::fs::write(root.join("s*.txt"), "star dirty\n").unwrap();
        std::fs::write(root.join("s1.txt"), "one dirty\n").unwrap();

        let sessions = session::SessionState::default();
        let view = session::open(&sessions, root).unwrap();
        let writes = WriteState::default();
        let preview = preview_discard(
            &writes,
            &sessions,
            view.version,
            &[file_id(&view, "s*.txt")],
        )
        .unwrap();
        assert_eq!(
            preview.candidates,
            vec!["s*.txt".to_string()],
            "the ticket is bound to the one selected file"
        );

        let result = discard_files(&writes, &sessions, preview.nonce).unwrap();
        assert_eq!(result.outcome, Outcome::Success);
        assert_eq!(
            std::fs::read_to_string(root.join("s*.txt")).unwrap(),
            "star\n",
            "the selected file is reverted"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("s1.txt")).unwrap(),
            "one dirty\n",
            "a file nobody selected keeps its work-tree changes"
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
        let preview = preview_clean_all(&writes, &sessions, view.version).unwrap();
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
        let preview = preview_clean_all(&writes, &sessions, view.version).unwrap();

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
        let preview = preview_clean_all(&writes, &sessions, view.version).unwrap();
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
        let error = preview_clean_all(&writes, &sessions, view.version).unwrap_err();
        assert_eq!(error.code.as_str(), "write_stale_snapshot");

        // A repository without untracked files reports nothing to clean
        // instead of staging an empty confirmation.
        let live = session::refresh(&sessions).unwrap().expect("session");
        std::fs::remove_file(root.join("u1.txt")).unwrap();
        let error = preview_clean_all(&writes, &sessions, live.version).unwrap_err();
        assert_eq!(error.code.as_str(), "clean_nothing");
    }

    /// One row's own menu asks for one path. Git decides whether that path is
    /// something a clean can remove, and the ticket binds exactly the answer —
    /// never the directory it would otherwise collapse into, and never the
    /// neighbours that share a name pattern with it.
    #[test]
    fn scoped_clean_binds_one_file_inside_an_untracked_directory() {
        let repository = repo_with_base(&[("base.txt", "one\n")]);
        let root = repository.path();
        std::fs::write(root.join("u1.txt"), "untracked\n").unwrap();
        std::fs::create_dir(root.join("nested")).unwrap();
        std::fs::write(root.join("nested/a.txt"), "a\n").unwrap();
        std::fs::write(root.join("nested/b.txt"), "b\n").unwrap();

        let sessions = session::SessionState::default();
        let view = session::open(&sessions, root).unwrap();
        let writes = WriteState::default();
        let preview = preview_clean(
            &writes,
            &sessions,
            view.version,
            &[file_id(&view, "nested/a.txt")],
        )
        .unwrap();
        assert_eq!(
            preview.candidates,
            vec!["nested/a.txt".to_string()],
            "a path-scoped listing names the file rather than collapsing it into `nested/`"
        );
        assert!(preview.dropped.is_empty(), "{:?}", preview.dropped);

        let result = clean_files(&writes, &sessions, preview.nonce).unwrap();
        assert_eq!(result.outcome, Outcome::Success);
        assert!(!root.join("nested/a.txt").exists());
        assert_eq!(
            std::fs::read_to_string(root.join("nested/b.txt")).unwrap(),
            "b\n",
            "the sibling nobody selected stays on disk"
        );
        assert!(
            root.join("nested").is_dir(),
            "a directory is kept while it still holds something"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("u1.txt")).unwrap(),
            "untracked\n",
            "an untracked file outside the selection is untouched"
        );
    }

    /// The hazard a glob-shaped file name carries: unquoted, `clean -fd --
    /// 's*.txt'` removes every untracked file whose name fits. Measured on Git
    /// 2.53, and the same quoting covers `restore` and `add`.
    #[test]
    fn a_file_name_that_is_also_a_pattern_cleans_only_itself() {
        let repository = repo_with_base(&[("base.txt", "one\n")]);
        let root = repository.path();
        std::fs::write(root.join("s*.txt"), "star\n").unwrap();
        std::fs::write(root.join("s1.txt"), "one untracked\n").unwrap();
        std::fs::write(root.join("s2.txt"), "two untracked\n").unwrap();

        let sessions = session::SessionState::default();
        let view = session::open(&sessions, root).unwrap();
        let writes = WriteState::default();
        let preview = preview_clean(
            &writes,
            &sessions,
            view.version,
            &[file_id(&view, "s*.txt")],
        )
        .unwrap();
        assert_eq!(preview.candidates, vec!["s*.txt".to_string()]);

        let result = clean_files(&writes, &sessions, preview.nonce).unwrap();
        assert_eq!(result.outcome, Outcome::Success);
        assert!(!root.join("s*.txt").exists());
        for name in ["s1.txt", "s2.txt"] {
            assert!(
                root.join(name).exists(),
                "{name} matches the pattern but nobody confirmed it"
            );
        }
    }

    /// A ticket for one path promises only that path, so work appearing
    /// elsewhere in the repository afterwards is none of its business — which
    /// is the one way a scoped clean differs from a `Clean…` of the whole
    /// untracked group, and the reason the promise is stored rather than
    /// inferred from how many paths the ticket holds.
    #[test]
    fn a_scoped_clean_is_not_undone_by_an_unrelated_file_that_arrives_afterwards() {
        let repository = repo_with_base(&[("base.txt", "one\n")]);
        let root = repository.path();
        std::fs::write(root.join("u1.txt"), "one\n").unwrap();
        std::fs::write(root.join("u2.txt"), "two\n").unwrap();

        let sessions = session::SessionState::default();
        let view = session::open(&sessions, root).unwrap();
        let writes = WriteState::default();
        let preview = preview_clean(
            &writes,
            &sessions,
            view.version,
            &[file_id(&view, "u1.txt")],
        )
        .unwrap();

        std::fs::write(root.join("u3.txt"), "arrived later\n").unwrap();
        let result = clean_files(&writes, &sessions, preview.nonce).unwrap();
        assert_eq!(result.outcome, Outcome::Success, "{}", result.message);
        assert!(!root.join("u1.txt").exists());
        assert!(root.join("u2.txt").exists());
        assert!(root.join("u3.txt").exists());
    }

    /// A selection can name things a clean does not own. Git's own listing is
    /// the authority: whatever it refuses to report is shown as skipped and
    /// never enters the ticket, so the confirmed list and the deleted set stay
    /// the same set.
    #[test]
    fn a_scoped_clean_reports_a_path_git_will_not_remove_as_skipped() {
        let repository = repo_with_base(&[("base.txt", "one\n")]);
        let root = repository.path();
        std::fs::write(root.join("base.txt"), "dirty tracked\n").unwrap();
        std::fs::write(root.join("u1.txt"), "untracked\n").unwrap();

        let sessions = session::SessionState::default();
        let view = session::open(&sessions, root).unwrap();
        let writes = WriteState::default();
        let preview = preview_clean(
            &writes,
            &sessions,
            view.version,
            &[file_id(&view, "base.txt"), file_id(&view, "u1.txt")],
        )
        .unwrap();
        assert_eq!(preview.candidates, vec!["u1.txt".to_string()]);
        assert_eq!(preview.dropped, vec!["base.txt".to_string()]);

        let result = clean_files(&writes, &sessions, preview.nonce).unwrap();
        assert_eq!(result.outcome, Outcome::Success);
        assert!(!root.join("u1.txt").exists());
        assert_eq!(
            std::fs::read_to_string(root.join("base.txt")).unwrap(),
            "dirty tracked\n",
            "a tracked file named in the selection keeps its work-tree edit"
        );

        // And when nothing in the selection is removable, there is no ticket.
        let live = session::refresh(&sessions).unwrap().expect("session");
        let error = preview_clean(
            &writes,
            &sessions,
            live.version,
            &[file_id(&live, "base.txt")],
        )
        .unwrap_err();
        assert_eq!(error.code.as_str(), "clean_nothing");
        assert!(writes.take_bound("any").is_none());
    }

    /// An untracked directory holding another Git repository is a row like any
    /// other, but removing it takes Git's second force and guit never applies
    /// it. Git will not even list such a path, so it lands in `dropped` and a
    /// selection of nothing else is refused outright.
    #[test]
    fn a_nested_repository_is_never_cleaned_and_never_promised() {
        let repository = repo_with_base(&[("base.txt", "one\n")]);
        let root = repository.path();
        std::fs::create_dir(root.join("inner")).unwrap();
        std::fs::write(root.join("inner/x.txt"), "x\n").unwrap();
        std::fs::write(root.join("u1.txt"), "untracked\n").unwrap();
        repo::git_with(root, &[], &["init", "-q", "--initial-branch=main", "inner"]);

        let sessions = session::SessionState::default();
        let view = session::open(&sessions, root).unwrap();
        // `file_id` panics when the display name is not in the snapshot: an
        // untracked directory holding another repository arrives as one row.
        let inner = file_id(&view, "inner/");
        let writes = WriteState::default();
        let error = preview_clean(&writes, &sessions, view.version, &[inner]).unwrap_err();
        assert_eq!(error.code.as_str(), "clean_nothing");
        assert!(
            root.join("inner/x.txt").exists(),
            "refusing a preview deletes nothing"
        );

        // The whole-repository form leaves it out of the promise too.
        let preview = preview_clean_all(&writes, &sessions, view.version).unwrap();
        assert!(
            !preview.candidates.iter().any(|name| name == "inner/"),
            "{:?}",
            preview.candidates
        );
        let result = clean_files(&writes, &sessions, preview.nonce).unwrap();
        assert_eq!(result.outcome, Outcome::Success);
        assert!(
            root.join("inner/x.txt").exists(),
            "git clean without -ff keeps another repository"
        );
    }
}
