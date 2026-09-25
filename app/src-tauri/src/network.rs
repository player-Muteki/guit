//! Remote synchronization (plan/04 网络、认证和取消, M5-02). Fetch and
//! upstream binding ride the same serialized write lane as every other
//! repository mutation: `git fetch` rewrites remote-tracking refs, which is
//! repository state, so it can never overlap a local commit or a worktree
//! removal. The queue slot is held for the whole operation, the external
//! tool timeout budget (3600 s) covers slow transfers, progress lines are
//! streamed redacted over `sync-progress` events, and every outcome ends
//! with the mandatory re-read so ahead/behind badges reflect the truth.
//!
//! The client names a remote only as `"all"` or `{"remote": <name>}` — a
//! remote literally called "all" cannot hijack the broadcast form because
//! the two arrive as distinct JSON shapes — and the backend re-lists
//! `git remote` server-side and refuses anything not present. No refspec,
//! URL or path ever arrives from the frontend.

use crate::probe::ProbeError;
use crate::repo;
use crate::runner;
use crate::write::{self, OperationKind, OperationResult, Outcome, WriteState};
use crate::{branches, history, refs, remotes, sequencer, session, submodules};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

/// Streaming fetches can take far longer than any local write; the
/// external-tool budget applies, with Stop (the queue's cancel flag)
/// reaching the running Git process.
const FETCH_TIMEOUT: Duration = Duration::from_secs(3600);
const FETCH_OUTPUT_LIMIT: usize = 256 * 1024;

/// Externally tagged so `"all"` and `{"remote": "origin"}` are two
/// different wire shapes; a remote literally named "all" still addresses
/// exactly itself through the newtype form.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub enum FetchTarget {
    All,
    Remote(String),
}

pub(crate) fn fetch(
    state: &WriteState,
    sessions: &session::SessionState,
    snapshot_version: u64,
    target: FetchTarget,
    emit: &mut dyn FnMut(u64, &str),
) -> Result<OperationResult, ProbeError> {
    let operation_id = state.begin()?;
    let result = run_fetch(state, sessions, snapshot_version, target, &mut |line| {
        emit(operation_id, line)
    });
    state.finish();
    result.map(|mut result| {
        result.operation_id = operation_id;
        result
    })
}

struct Plan {
    names: Vec<String>,
    /// Configured remotes the sweep could not address (non-UTF-8 names);
    /// the final message reports them instead of hiding them.
    skipped: usize,
}

/// Resolves the requested target against a fresh `git remote` listing.
/// Every refusal here happens before any process starts.
fn plan_remotes(work_root: &Path, target: &FetchTarget) -> Result<Plan, ProbeError> {
    match target {
        FetchTarget::Remote(name) => {
            remotes::validate_remote_name(name)?;
            let raws = remotes::raw_names(work_root)?;
            if !raws.iter().any(|raw| raw.as_slice() == name.as_bytes()) {
                return Err(ProbeError::new(
                    "remote_missing",
                    format!("No remote named \"{name}\" is configured; refresh the list."),
                ));
            }
            Ok(Plan {
                names: vec![name.clone()],
                skipped: 0,
            })
        }
        FetchTarget::All => {
            let raws = remotes::raw_names(work_root)?;
            // A non-UTF-8 name cannot be passed as a &str argv slot; it is
            // counted as skipped and reported honestly.
            let names: Vec<String> = raws
                .iter()
                .filter_map(|raw| std::str::from_utf8(raw).ok().map(str::to_owned))
                .collect();
            if names.is_empty() {
                return Err(ProbeError::new(
                    "remote_none",
                    if raws.is_empty() {
                        "No remotes are configured to fetch from.".to_string()
                    } else {
                        "None of the configured remotes can be addressed losslessly; the fetch \
                         was refused."
                            .into()
                    },
                ));
            }
            let skipped = raws.len() - names.len();
            Ok(Plan { names, skipped })
        }
    }
}

/// Outcome of a fetch sweep over one or more remotes. A cancelled remote
/// counts as neither fetched nor failed, and the sweep stops there.
struct Sweep {
    fetched: Vec<String>,
    failed: Vec<String>,
    /// (exit code, first redacted stderr line) of the first failure.
    first_failure: Option<(i32, String)>,
    cancelled: bool,
}

/// Runs `git fetch --prune --progress` for each named remote inside the
/// already-held queue slot. The broadcast sweep keeps going after one
/// remote fails — each remote gets its own chance — and the caller reports
/// exactly which side of that line holds.
fn sweep_fetch(
    state: &WriteState,
    work_root: &Path,
    names: &[String],
    on_line: &mut dyn FnMut(&str),
) -> Result<Sweep, ProbeError> {
    let mut sweep = Sweep {
        fetched: Vec::new(),
        failed: Vec::new(),
        first_failure: None,
        cancelled: false,
    };
    for name in names {
        if state.cancel_flag().load(Ordering::SeqCst) {
            sweep.cancelled = true;
            break;
        }
        let mut command = repo::user_git_command(work_root);
        command.args(["fetch", "--prune", "--progress", name]);
        let mut buffer: Vec<u8> = Vec::new();
        let mut collect = |_: bool, bytes: &[u8]| {
            submodules::take_progress_bytes(&mut buffer, bytes, on_line);
        };
        match runner::run_with_limit(
            command,
            state.cancel_flag(),
            Duration::ZERO,
            FETCH_TIMEOUT,
            FETCH_OUTPUT_LIMIT,
            &mut collect,
        ) {
            Ok(output) => {
                if !buffer.is_empty() {
                    let remainder = std::mem::take(&mut buffer);
                    submodules::emit_line(&remainder, on_line);
                }
                if output.status.success() && !output.truncated {
                    sweep.fetched.push(name.clone());
                } else {
                    sweep.failed.push(name.clone());
                    if sweep.first_failure.is_none() {
                        sweep.first_failure = Some((
                            output.status.code().unwrap_or(-1),
                            write::first_stderr_line(&output.stderr),
                        ));
                    }
                }
            }
            Err(error) if error.code == "process_cancelled" => {
                // Stop landed mid-transfer for this remote: it is neither
                // fetched nor failed, and the sweep stops.
                sweep.cancelled = true;
                break;
            }
            Err(error) => return Err(error),
        }
    }
    Ok(sweep)
}
/// Assumes the queue slot is held; tests call this directly to pre-arm
/// cancellation, mirroring the other runners.
fn run_fetch(
    state: &WriteState,
    sessions: &session::SessionState,
    snapshot_version: u64,
    target: FetchTarget,
    on_line: &mut dyn FnMut(&str),
) -> Result<OperationResult, ProbeError> {
    let broadcast = matches!(target, FetchTarget::All);
    let gates = match sessions.commit_context(snapshot_version) {
        Err(error) => Err(error.message),
        Ok((work_root, _unborn)) => match plan_remotes(&work_root, &target) {
            Err(error) => Err(error.message),
            Ok(plan) => {
                if state.cancel_flag().load(Ordering::SeqCst) {
                    let snapshot = session::refresh(sessions)?;
                    return Ok(OperationResult {
                        operation_id: 0,
                        kind: OperationKind::Fetch,
                        outcome: Outcome::Cancelled,
                        exit_code: None,
                        message: "Cancelled before Git ran; no remote was contacted.".into(),
                        details: None,
                        snapshot,
                    });
                }
                Ok((work_root, plan))
            }
        },
    };
    let outcome;
    let exit_code;
    let message;
    let mut details = None;
    match gates {
        Err(refusal) => {
            outcome = Outcome::Rejected;
            exit_code = None;
            message = refusal;
        }
        Ok((work_root, plan)) => {
            let Plan { names, skipped } = plan;
            let sweep = sweep_fetch(state, &work_root, &names, on_line)?;
            let skipped_note = if skipped > 0 {
                format!(" {skipped} remote(s) could not be addressed and were skipped.")
            } else {
                String::new()
            };
            details = sweep.first_failure.as_ref().map(|(_, line)| line.clone());
            exit_code = sweep.first_failure.as_ref().map(|(code, _)| *code);
            if sweep.cancelled {
                outcome = Outcome::Cancelled;
                message = format!(
                    "Cancelled while fetching; {}.{}",
                    if sweep.fetched.is_empty() {
                        "no remote completed".to_string()
                    } else {
                        format!("completed: {}", quoted(&sweep.fetched))
                    },
                    skipped_note
                );
            } else if sweep.failed.is_empty() {
                outcome = Outcome::Success;
                message = if broadcast {
                    format!(
                        "Fetched all {} remote(s).{}",
                        sweep.fetched.len(),
                        skipped_note
                    )
                } else {
                    format!("Fetched from \"{}\".", sweep.fetched[0])
                };
            } else {
                outcome = Outcome::Failed;
                message = if broadcast {
                    format!(
                        "Fetched {} of {} remotes; {} reported a failure.{} What did arrive is \
                         kept — the tracking refs show it.",
                        sweep.fetched.len(),
                        sweep.fetched.len() + sweep.failed.len(),
                        quoted(&sweep.failed),
                        skipped_note
                    )
                } else {
                    format!("git fetch on \"{}\" reported a failure.", sweep.failed[0])
                };
            }
        }
    }
    let snapshot = session::refresh(sessions)?;
    Ok(OperationResult {
        operation_id: 0,
        kind: OperationKind::Fetch,
        outcome,
        exit_code,
        message,
        details,
        snapshot,
    })
}

fn quoted(names: &[String]) -> String {
    let listed: Vec<String> = names.iter().map(|name| format!("\"{name}\"")).collect();
    listed.join(", ")
}

/// Strategy picked from the Pull menu. `default` defers to the user's own
/// `pull.rebase`/`pull.ff`, exactly as reported by [`pull_default`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PullStrategy {
    Default,
    FfOnly,
    Merge,
    Rebase,
}

/// The integration lane a pull actually runs once the config is read.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Rule {
    Merge,
    MergeNoFf,
    FfOnly,
    Rebase,
}

impl Rule {
    /// Display form for the effective-rule report.
    fn word(self) -> &'static str {
        match self {
            Rule::Merge => "merge",
            Rule::MergeNoFf => "merge, no fast-forward",
            Rule::FfOnly => "fast-forward only",
            Rule::Rebase => "rebase",
        }
    }

    /// Past tense inside the pull's own success message.
    fn verb(self) -> &'static str {
        match self {
            Rule::Merge | Rule::MergeNoFf => "merged",
            Rule::FfOnly => "fast-forward",
            Rule::Rebase => "rebased",
        }
    }
}

/// One configured value with the scope it came from, so the UI can show
/// "repository says X" versus "user config says X" instead of a bare value.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Configured {
    pub value: String,
    pub scope: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullDefault {
    pub rebase: Option<Configured>,
    pub ff: Option<Configured>,
    /// The rule the `default` strategy actually integrates with.
    pub effective: String,
    /// How an unusual config value is treated; shown honestly.
    pub note: Option<String>,
}

/// Git-config boolean words (`git config --bool` semantics), plus the
/// valueless form which means true for a boolean key.
fn bool_value(value: &str) -> Option<bool> {
    match value.trim().to_ascii_lowercase().as_str() {
        "true" | "yes" | "on" | "1" => Some(true),
        "false" | "no" | "off" | "0" => Some(false),
        _ => None,
    }
}

/// Reads one config key the way Git resolves it: last value wins. Measured
/// on Git 2.53: `config --get --show-scope` prints `<scope>\t<value>`,
/// rc=1 when the key is unset, and rc=0 with an empty value for the
/// valueless boolean form.
fn read_config(work_root: &Path, key: &str) -> Result<Option<Configured>, ProbeError> {
    let output = branches::run_git(
        work_root,
        &["config", "--get", "--show-scope", key],
        &AtomicBool::new(false),
    )?;
    if output.truncated {
        return Err(ProbeError::new(
            "pull_config_too_large",
            format!("Reading {key} produced more output than guit accepts."),
        ));
    }
    if !output.status.success() {
        if output.status.code() == Some(1) {
            return Ok(None);
        }
        return Err(ProbeError::new(
            "pull_config_failed",
            format!(
                "Reading {key} failed: {}",
                write::first_stderr_line(&output.stderr)
            ),
        ));
    }
    let line = String::from_utf8_lossy(&output.stdout)
        .trim_end_matches(['\r', '\n'])
        .to_owned();
    let Some((scope, value)) = line.split_once('\t') else {
        return Err(ProbeError::new(
            "pull_config_protocol",
            format!("git config answered {key} in an unexpected shape; refusing to guess."),
        ));
    };
    Ok(Some(Configured {
        value: value.to_owned(),
        scope: scope.to_owned(),
    }))
}

/// Maps resolved pull.rebase / pull.ff values onto one lane, with an
/// honest note whenever a value asks for something guit does not
/// reproduce (`--rebase=merges`/`interactive` fall back to a plain merge).
fn resolve_rule(rebase: Option<&Configured>, ff: Option<&Configured>) -> (Rule, Option<String>) {
    if let Some(configured) = rebase {
        let value = configured.value.trim().to_ascii_lowercase();
        if value.is_empty() || bool_value(&value) == Some(true) {
            return (Rule::Rebase, None);
        }
        if bool_value(&value) != Some(false) {
            let note = if value == "merges" || value == "interactive" {
                format!(
                    "pull.rebase={value} asks Git for a conditional or interactive rebase; guit \
                     integrates with a plain merge instead."
                )
            } else {
                format!(
                    "pull.rebase=\"{}\" is not a value guit understands; the integration is a \
                     plain merge.",
                    configured.value
                )
            };
            return (Rule::Merge, Some(note));
        }
        // pull.rebase=false: fall through to the pull.ff decision, as Git does.
    }
    let Some(ff) = ff else {
        return (Rule::Merge, None);
    };
    let value = ff.value.trim().to_ascii_lowercase();
    if value == "only" {
        return (Rule::FfOnly, None);
    }
    if value.is_empty() || bool_value(&value) == Some(true) {
        return (Rule::Merge, None);
    }
    if bool_value(&value) == Some(false) {
        return (Rule::MergeNoFf, None);
    }
    (
        Rule::Merge,
        Some(format!(
            "pull.ff=\"{}\" is not a value guit understands; the integration is a plain merge.",
            ff.value
        )),
    )
}

/// The effective default rule, read from the user's own configuration.
/// A read-only report: it starts no fetch and changes nothing.
pub(crate) fn pull_default(sessions: &session::SessionState) -> Result<PullDefault, ProbeError> {
    let dir = remotes::session_directory(sessions)?;
    let rebase = read_config(&dir, "pull.rebase")?;
    let ff = read_config(&dir, "pull.ff")?;
    let (rule, note) = resolve_rule(rebase.as_ref(), ff.as_ref());
    Ok(PullDefault {
        rebase,
        ff,
        effective: rule.word().to_owned(),
        note,
    })
}

/// Pull is exactly one queue unit: the fetch leg, then the integration leg
/// chosen by strategy (or by the user's own pull.* config for `default`).
/// Nothing is integrated unless the fetch succeeded, and an integration
/// that stops on conflicts hands over to the banner lane unchanged.
pub(crate) fn pull(
    state: &WriteState,
    sessions: &session::SessionState,
    snapshot_version: u64,
    strategy: PullStrategy,
    emit: &mut dyn FnMut(u64, &str),
) -> Result<OperationResult, ProbeError> {
    let operation_id = state.begin()?;
    let result = run_pull(state, sessions, snapshot_version, strategy, &mut |line| {
        emit(operation_id, line)
    });
    state.finish();
    result.map(|mut result| {
        result.operation_id = operation_id;
        result
    })
}

fn pull_result(
    outcome: Outcome,
    exit_code: Option<i32>,
    message: String,
    details: Option<String>,
    snapshot: Option<session::SnapshotView>,
) -> OperationResult {
    OperationResult {
        operation_id: 0,
        kind: OperationKind::Pull,
        outcome,
        exit_code,
        message,
        details,
        snapshot,
    }
}

struct PullPlan {
    /// Display form of the tracking ref, e.g. `origin/main`.
    upstream: String,
    remote: String,
}

/// Derives branch, upstream and remote from one fresh listing: the client
/// names none of them. Every refusal here happens before any process runs.
fn plan_pull(work_root: &Path, unborn: bool) -> Result<PullPlan, ProbeError> {
    if unborn {
        return Err(ProbeError::new(
            "pull_unborn",
            "Cannot pull before the first commit.",
        ));
    }
    let listing = refs::list(work_root)?;
    let mut heads = listing.branches.iter().filter(|branch| branch.head);
    let (Some(branch), None) = (heads.next(), heads.next()) else {
        return Err(ProbeError::new(
            "pull_no_branch",
            "Pull updates the checked-out branch; HEAD is not attached to one.",
        ));
    };
    if !branch.addressable {
        return Err(ProbeError::new(
            "branch_not_addressable",
            "That branch name does not round-trip byte-exactly; guit refuses to guess which \
             branch was meant.",
        ));
    }
    let Some(upstream) = branch.upstream.clone() else {
        return Err(ProbeError::new(
            "pull_no_upstream",
            format!(
                "\"{}\" has no upstream branch; publish it to a remote (or set an upstream) \
                 first.",
                branch.name
            ),
        ));
    };
    let remote = match upstream.split_once('/') {
        Some((remote, _)) => remote.to_owned(),
        None => {
            return Err(ProbeError::new(
                "pull_protocol",
                format!("The upstream {upstream} is not shaped like <remote>/<branch>."),
            ))
        }
    };
    remotes::validate_remote_name(&remote)?;
    let raws = remotes::raw_names(work_root)?;
    if !raws.iter().any(|raw| raw.as_slice() == remote.as_bytes()) {
        return Err(ProbeError::new(
            "pull_remote_missing",
            format!(
                "The upstream {upstream} names remote \"{remote}\", which is no longer \
                 configured."
            ),
        ));
    }
    if listing
        .remotes
        .iter()
        .any(|seen| seen.name == upstream && !seen.addressable)
    {
        return Err(ProbeError::new(
            "upstream_not_addressable",
            "That upstream name cannot be addressed losslessly; the pull was refused.",
        ));
    }
    Ok(PullPlan { upstream, remote })
}

/// The integration target is re-read from the tracking ref after the
/// fetch — never from anything the client still holds.
fn resolve_upstream_oid(work_root: &Path, upstream: &str) -> Result<String, ProbeError> {
    let spec = format!("refs/remotes/{upstream}^{{commit}}");
    let output = branches::run_git(
        work_root,
        &["rev-parse", "--verify", "--quiet", &spec],
        &AtomicBool::new(false),
    )?;
    let oid = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    if output.status.success() && !output.truncated && history::valid_oid(&oid) {
        Ok(oid)
    } else {
        Err(ProbeError::new(
            "pull_upstream_unresolved",
            format!("The upstream {upstream} did not resolve to a commit even after the fetch."),
        ))
    }
}

/// ff-only never creates a merge commit, so it can neither stop on
/// conflicts nor need an editor: the standalone command fast-forwards or
/// fails outright.
fn integrate_ff_only(
    state: &WriteState,
    sessions: &session::SessionState,
    work_root: &Path,
    target: &str,
    upstream: &str,
) -> Result<OperationResult, ProbeError> {
    if state.cancel_flag().load(Ordering::SeqCst) {
        let snapshot = session::refresh(sessions)?;
        return Ok(pull_result(
            Outcome::Cancelled,
            None,
            "Cancelled after the fetch; the fast-forward never started.".into(),
            None,
            snapshot,
        ));
    }
    match sequencer::run_git(work_root, false, &["merge", "--ff-only", target], state) {
        Ok(output) => {
            let exit_code = output.status.code();
            let snapshot = session::refresh(sessions)?;
            Ok(if output.status.success() && !output.truncated {
                pull_result(
                    Outcome::Success,
                    exit_code,
                    format!("Pulled {upstream} ({}).", Rule::FfOnly.verb()),
                    None,
                    snapshot,
                )
            } else {
                pull_result(
                    Outcome::Failed,
                    exit_code,
                    "git merge --ff-only reported a failure.".into(),
                    Some(write::first_stderr_line(&output.stderr)),
                    snapshot,
                )
            })
        }
        Err(error) if error.code == "process_cancelled" => {
            let snapshot = session::refresh(sessions)?;
            Ok(pull_result(
                Outcome::Cancelled,
                None,
                "Cancelled while Git ran; the fast-forward did not complete.".into(),
                None,
                snapshot,
            ))
        }
        Err(error) => Err(error),
    }
}

/// Assumes the queue slot is held; tests call this directly to pre-arm
/// cancellation, mirroring the other runners.
fn run_pull(
    state: &WriteState,
    sessions: &session::SessionState,
    snapshot_version: u64,
    strategy: PullStrategy,
    on_line: &mut dyn FnMut(&str),
) -> Result<OperationResult, ProbeError> {
    let gates = match sessions.commit_context(snapshot_version) {
        Err(error) => Err(error.message),
        Ok((work_root, unborn)) => match plan_pull(&work_root, unborn) {
            Err(error) => Err(error.message),
            Ok(plan) => {
                if state.cancel_flag().load(Ordering::SeqCst) {
                    let snapshot = session::refresh(sessions)?;
                    return Ok(pull_result(
                        Outcome::Cancelled,
                        None,
                        "Cancelled before Git ran; no remote was contacted.".into(),
                        None,
                        snapshot,
                    ));
                }
                Ok((work_root, plan))
            }
        },
    };
    match gates {
        Err(refusal) => {
            let snapshot = session::refresh(sessions)?;
            Ok(pull_result(
                Outcome::Rejected,
                None,
                refusal,
                None,
                snapshot,
            ))
        }
        Ok((work_root, plan)) => {
            let sweep = sweep_fetch(
                state,
                &work_root,
                std::slice::from_ref(&plan.remote),
                on_line,
            )?;
            if sweep.cancelled {
                let snapshot = session::refresh(sessions)?;
                return Ok(pull_result(
                    Outcome::Cancelled,
                    None,
                    format!(
                        "Cancelled during the fetch from \"{}\"; nothing was integrated.",
                        plan.remote
                    ),
                    None,
                    snapshot,
                ));
            }
            if !sweep.failed.is_empty() {
                let snapshot = session::refresh(sessions)?;
                return Ok(pull_result(
                    Outcome::Failed,
                    sweep.first_failure.as_ref().map(|(code, _)| *code),
                    format!(
                        "git fetch from \"{}\" reported a failure; nothing was integrated.",
                        plan.remote
                    ),
                    sweep.first_failure.map(|(_, line)| line),
                    snapshot,
                ));
            }
            let target = match resolve_upstream_oid(&work_root, &plan.upstream) {
                Err(error) => {
                    let snapshot = session::refresh(sessions)?;
                    return Ok(pull_result(
                        Outcome::Rejected,
                        None,
                        error.message,
                        None,
                        snapshot,
                    ));
                }
                Ok(oid) => oid,
            };
            let (rule, note) = match strategy {
                PullStrategy::Default => {
                    let rebase = read_config(&work_root, "pull.rebase")?;
                    let ff = read_config(&work_root, "pull.ff")?;
                    resolve_rule(rebase.as_ref(), ff.as_ref())
                }
                PullStrategy::FfOnly => (Rule::FfOnly, None),
                PullStrategy::Merge => (Rule::Merge, None),
                PullStrategy::Rebase => (Rule::Rebase, None),
            };
            let mut result = if rule == Rule::FfOnly {
                integrate_ff_only(state, sessions, &work_root, &target, &plan.upstream)?
            } else {
                let mode = match rule {
                    Rule::Merge => sequencer::Start::Merge,
                    Rule::MergeNoFf => sequencer::Start::MergeNoFf,
                    Rule::Rebase => sequencer::Start::Rebase,
                    Rule::FfOnly => unreachable!("handled above"),
                };
                // One set of merge/rebase semantics: the sequencer's own
                // gates (in-flight refusal, target validation, conflict
                // detection) run inside this same queue slot.
                let mut integrated =
                    sequencer::start_in_slot(state, sessions, snapshot_version, &target, mode)?;
                if integrated.outcome == Outcome::Success {
                    integrated.message = format!("Pulled {} ({}).", plan.upstream, rule.verb());
                }
                integrated.kind = OperationKind::Pull;
                integrated
            };
            if let Some(note) = note {
                result.details = Some(match result.details.take() {
                    Some(existing) => format!("{existing} {note}"),
                    None => note,
                });
            }
            Ok(result)
        }
    }
}

/// Binds (or clears) the upstream of one local branch. This only rewrites
/// branch configuration — no commit, ref or file moves — so it rides the
/// write lane without a ticket, but the branch and the upstream target are
/// verified against a fresh ref listing before Git runs, never trusted
/// from the client's view.
pub(crate) fn set_upstream(
    state: &WriteState,
    sessions: &session::SessionState,
    snapshot_version: u64,
    branch: String,
    upstream: Option<String>,
) -> Result<OperationResult, ProbeError> {
    let operation_id = state.begin()?;
    let result = run_set_upstream(
        state,
        sessions,
        snapshot_version,
        &branch,
        upstream.as_deref(),
    );
    state.finish();
    result.map(|mut result| {
        result.operation_id = operation_id;
        result
    })
}

/// Assumes the queue slot is held. Every refusal (stale version, bare
/// session, listing mismatch) happens before the process starts and still
/// ends in the forced re-read.
fn run_set_upstream(
    state: &WriteState,
    sessions: &session::SessionState,
    snapshot_version: u64,
    branch: &str,
    upstream: Option<&str>,
) -> Result<OperationResult, ProbeError> {
    let mut outcome = Outcome::Success;
    let mut exit_code = None;
    let message;
    let mut details = None;
    let gates = match sessions.commit_context(snapshot_version) {
        Err(error) => Err(error.message),
        Ok((work_root, _unborn)) => match build_upstream_args(&work_root, branch, upstream) {
            Err(error) => Err(error.message),
            Ok(args) => {
                if state.cancel_flag().load(Ordering::SeqCst) {
                    let snapshot = session::refresh(sessions)?;
                    return Ok(OperationResult {
                        operation_id: 0,
                        kind: OperationKind::SetUpstream,
                        outcome: Outcome::Cancelled,
                        exit_code: None,
                        message: "Cancelled before Git ran; no configuration changed.".into(),
                        details: None,
                        snapshot,
                    });
                }
                Ok((work_root, args))
            }
        },
    };
    match gates {
        Err(refusal) => {
            outcome = Outcome::Rejected;
            message = refusal;
        }
        Ok((work_root, args)) => {
            let argv: Vec<&str> = args.iter().map(String::as_str).collect();
            match branches::run_git(&work_root, &argv, state.cancel_flag()) {
                Ok(output) => {
                    exit_code = output.status.code();
                    if output.status.success() && !output.truncated {
                        message = match upstream {
                            Some(target) => format!("\"{branch}\" now tracks {target}."),
                            None => format!("Upstream of \"{branch}\" cleared."),
                        };
                    } else {
                        outcome = Outcome::Failed;
                        message = "git branch reported a failure.".into();
                        details = Some(write::first_stderr_line(&output.stderr));
                    }
                }
                Err(error) if error.code == "process_cancelled" => {
                    outcome = Outcome::Cancelled;
                    message =
                        "Cancelled while Git ran; the branch config may be half-changed.".into();
                }
                Err(error) => return Err(error),
            }
        }
    }
    let snapshot = session::refresh(sessions)?;
    Ok(OperationResult {
        operation_id: 0,
        kind: OperationKind::SetUpstream,
        outcome,
        exit_code,
        message,
        details,
        snapshot,
    })
}

fn build_upstream_args(
    work_root: &Path,
    branch: &str,
    upstream: Option<&str>,
) -> Result<Vec<String>, ProbeError> {
    let listing = refs::list(work_root)?;
    let mut matches = listing.branches.iter().filter(|seen| seen.name == branch);
    let target =
        match (matches.next(), matches.next()) {
            (Some(found), None) if found.addressable => found,
            (Some(_), _) => return Err(ProbeError::new(
                "branch_not_addressable",
                "That branch name does not round-trip byte-exactly; guit refuses to guess which \
                 branch was meant.",
            )),
            (None, _) => {
                return Err(ProbeError::new(
                    "branch_missing",
                    format!("No local branch \"{branch}\" is listed; refresh the view."),
                ))
            }
        };
    let mut args: Vec<String> = vec!["branch".into()];
    match upstream {
        None => {
            if target.upstream.is_none() {
                return Err(ProbeError::new(
                    "upstream_unset",
                    format!("\"{branch}\" has no upstream to clear."),
                ));
            }
            args.push("--unset-upstream".into());
        }
        Some(name) => {
            let mut found = None;
            for remote in &listing.remotes {
                if remote.name == *name {
                    found = Some(remote);
                }
            }
            let Some(remote) = found else {
                return Err(ProbeError::new(
                    "upstream_missing",
                    format!(
                        "\"{name}\" is not a fetched remote-tracking ref; run a fetch or pick a \
                         listed branch."
                    ),
                ));
            };
            if !remote.addressable {
                return Err(ProbeError::new(
                    "upstream_not_addressable",
                    "That remote-tracking name cannot be addressed losslessly; the binding was \
                     refused.",
                ));
            }
            args.push(format!("--set-upstream-to=refs/remotes/{name}"));
        }
    }
    args.extend(["--".into(), branch.into()]);
    Ok(args)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::HeadState;
    use std::path::Path;

    fn git(dir: &Path, args: &[&str]) {
        repo::git_with(dir, &[], args);
    }

    fn commit(dir: &Path, message: &str) {
        repo::git_with(
            dir,
            &[
                "-c",
                "user.name=guit test",
                "-c",
                "user.email=guit@example.invalid",
            ],
            &["commit", "-q", "--allow-empty", "-m", message],
        );
    }

    /// Working repo `work` pushing to bare `origin`. Identity lives in the
    /// repo's own config so guit-run merges and rebases never depend on
    /// the ambient environment.
    fn mirrored() -> (tempfile::TempDir, std::path::PathBuf) {
        let root = tempfile::tempdir().unwrap();
        let bare = root.path().join("origin.git");
        std::fs::create_dir(&bare).unwrap();
        git(&bare, &["init", "-q", "--bare", "--initial-branch=main"]);
        let work = root.path().join("work");
        std::fs::create_dir(&work).unwrap();
        git(&work, &["init", "-q", "--initial-branch=main"]);
        git(&work, &["config", "user.name", "guit test"]);
        git(&work, &["config", "user.email", "guit@example.invalid"]);
        std::fs::write(work.join("a.txt"), "base\n").unwrap();
        git(&work, &["add", "--", "a.txt"]);
        commit(&work, "base");
        git(&work, &["remote", "add", "origin", &bare.to_string_lossy()]);
        git(&work, &["push", "-q", "origin", "main"]);
        git(
            &work,
            &[
                "branch",
                "--set-upstream-to=refs/remotes/origin/main",
                "--",
                "main",
            ],
        );
        (root, work)
    }

    /// A second clone pushes into the shared bare, so remote-side
    /// movement never depends on guit's own (nonexistent yet) push paths.
    fn advance_via_peer(root: &Path, message: &str) {
        let peer = root.join("peer");
        repo::git_with(
            root,
            &[],
            &[
                "clone",
                "-q",
                "--",
                &root.join("origin.git").to_string_lossy(),
                &peer.to_string_lossy(),
            ],
        );
        commit(&peer, message);
        git(&peer, &["push", "-q", "origin", "main"]);
    }

    fn branch_of(work: &Path, name: &str) -> refs::BranchRef {
        refs::list(work)
            .unwrap()
            .branches
            .into_iter()
            .find(|seen| seen.name == name)
            .unwrap_or_else(|| panic!("{name} not listed"))
    }

    fn read(dir: &Path, args: &[&str]) -> String {
        let output = branches::run_git(dir, args, &AtomicBool::new(false)).unwrap();
        assert!(output.status.success());
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    }

    fn commit_paths(dir: &Path, files: &[(&str, &str)], message: &str) {
        let mut add: Vec<&str> = vec!["add", "--"];
        for (name, body) in files {
            std::fs::write(dir.join(name), body).unwrap();
            add.push(name);
        }
        git(dir, &add);
        repo::git_with(
            dir,
            &[
                "-c",
                "user.name=guit test",
                "-c",
                "user.email=guit@example.invalid",
            ],
            &["commit", "-q", "-m", message],
        );
    }

    /// The shared peer clone commits the given files and pushes, so
    /// divergence is created without guit's own (future) push paths.
    fn peer_commits(root: &Path, files: &[(&str, &str)], message: &str) {
        let peer = root.join("peer");
        if !peer.exists() {
            repo::git_with(
                root,
                &[],
                &[
                    "clone",
                    "-q",
                    "--",
                    &root.join("origin.git").to_string_lossy(),
                    &peer.to_string_lossy(),
                ],
            );
        }
        commit_paths(&peer, files, message);
        git(&peer, &["push", "-q", "origin", "main"]);
    }

    /// Local and peer each add their own file on top of the shared base.
    /// Returns (local head after its own commit, remote main tip).
    fn diverged(root: &Path, work: &Path) -> (String, String) {
        commit_paths(work, &[("local.txt", "local\n")], "local work");
        let local_tip = branch_of(work, "main").oid;
        peer_commits(root, &[("peer.txt", "peer\n")], "peer work");
        let bare_tip = read(&root.join("origin.git"), &["rev-parse", "main"]);
        (local_tip, bare_tip)
    }

    #[test]
    fn fetch_advances_tracking_and_the_refresh_reports_behind() {
        let (root, work) = mirrored();
        advance_via_peer(root.path(), "from peer");
        let sessions = session::SessionState::default();
        let view = session::open(&sessions, &work).unwrap();
        assert_eq!(branch_of(&work, "main").behind, None);

        let state = WriteState::default();
        let result = fetch(
            &state,
            &sessions,
            view.version,
            FetchTarget::Remote("origin".into()),
            &mut |_, _| {},
        )
        .unwrap();
        assert_eq!(result.outcome, Outcome::Success, "{}", result.message);
        assert!(result.operation_id > 0, "the wrapper stamps the id");
        let snapshot = result.snapshot.as_ref().expect("forced re-read");
        let main = snapshot.branch.as_ref().expect("checked-out branch view");
        assert_eq!(main.head_state, HeadState::Branch);
        assert_eq!(main.upstream.as_deref(), Some("origin/main"));
        assert_eq!(
            (main.ahead, main.behind),
            (Some(0), Some(1)),
            "the re-read must carry the fresh counts (status reports zeros explicitly)"
        );
    }

    #[test]
    fn prune_marks_tracking_deleted_by_the_remote_gone() {
        let (root, work) = mirrored();
        git(&work, &["push", "-q", "origin", "main:temp"]);
        assert!(refs::list(&work)
            .unwrap()
            .remotes
            .iter()
            .any(|seen| seen.name == "origin/temp"));
        git(
            &root.path().join("origin.git"),
            &["update-ref", "-d", "refs/heads/temp"],
        );
        let sessions = session::SessionState::default();
        let view = session::open(&sessions, &work).unwrap();
        let state = WriteState::default();
        let mut lines: Vec<String> = Vec::new();
        let result = run_fetch(
            &state,
            &sessions,
            view.version,
            FetchTarget::Remote("origin".into()),
            &mut |line| lines.push(line.to_owned()),
        )
        .unwrap();
        assert_eq!(result.outcome, Outcome::Success, "{}", result.message);
        // Measured wording, Git 2.53: the pruning is announced on stderr.
        assert!(
            lines
                .iter()
                .any(|line| line.contains("[deleted]") && line.contains("origin/temp")),
            "progress lines were {lines:?}"
        );
        assert!(!refs::list(&work)
            .unwrap()
            .remotes
            .iter()
            .any(|seen| seen.name == "origin/temp"));
    }

    #[test]
    fn ghost_and_illegal_remote_names_are_refused_before_git() {
        let (_root, work) = mirrored();
        let sessions = session::SessionState::default();
        let view = session::open(&sessions, &work).unwrap();
        let state = WriteState::default();
        let mut version = view.version;
        for (target, want) in [
            (FetchTarget::Remote("nope".into()), "No remote named"),
            (FetchTarget::Remote("-x".into()), "name"),
            (FetchTarget::Remote("or igin".into()), "name"),
        ] {
            let result = run_fetch(&state, &sessions, version, target, &mut |_| {}).unwrap();
            assert_eq!(result.outcome, Outcome::Rejected, "msg: {}", result.message);
            assert!(result.message.contains(want), "msg: {}", result.message);
            assert_eq!(result.exit_code, None, "Git must not have been invoked");
            version = result.snapshot.as_ref().expect("re-read").version;
            assert!(version > view.version);
        }
    }

    #[test]
    fn all_fetches_every_remote_and_lists_the_failures_honestly() {
        let (root, work) = mirrored();
        // A second healthy remote and one whose URL no longer resolves.
        let spare = root.path().join("spare.git");
        std::fs::create_dir(&spare).unwrap();
        git(&spare, &["init", "-q", "--bare", "--initial-branch=main"]);
        git(&work, &["remote", "add", "spare", &spare.to_string_lossy()]);
        git(&work, &["push", "-q", "spare", "main"]);
        git(
            &work,
            &[
                "remote",
                "add",
                "broken",
                &root.path().join("nowhere.git").to_string_lossy(),
            ],
        );
        advance_via_peer(root.path(), "from peer");
        let sessions = session::SessionState::default();
        let view = session::open(&sessions, &work).unwrap();
        let state = WriteState::default();
        let result = run_fetch(
            &state,
            &sessions,
            view.version,
            FetchTarget::All,
            &mut |_| {},
        )
        .unwrap();
        assert_eq!(result.outcome, Outcome::Failed, "{}", result.message);
        assert!(
            result.message.contains("Fetched 2 of 3"),
            "msg: {}",
            result.message
        );
        assert!(
            result.message.contains("\"broken\""),
            "msg: {}",
            result.message
        );
        assert!(result.details.is_some(), "Git's own refusal survives");
        assert!(result.exit_code.is_some(), "the failing exit code is kept");
        // The healthy legs still moved: behind=1 against origin shows in
        // the fresh listing, and spare's tracking refs arrived too.
        assert_eq!(branch_of(&work, "main").behind, Some(1));
        assert!(refs::list(&work)
            .unwrap()
            .remotes
            .iter()
            .any(|seen| seen.name == "spare/main"));
    }

    #[test]
    fn all_without_any_remote_is_a_pre_git_refusal() {
        let root = tempfile::tempdir().unwrap();
        let work = root.path().join("solo");
        std::fs::create_dir(&work).unwrap();
        git(&work, &["init", "-q", "--initial-branch=main"]);
        commit(&work, "one");
        let sessions = session::SessionState::default();
        let view = session::open(&sessions, &work).unwrap();
        let state = WriteState::default();
        let result = run_fetch(
            &state,
            &sessions,
            view.version,
            FetchTarget::All,
            &mut |_| {},
        )
        .unwrap();
        assert_eq!(result.outcome, Outcome::Rejected);
        assert_eq!(result.exit_code, None);
        assert!(result.message.contains("No remotes are configured"));
    }

    #[test]
    fn pre_cancelled_fetch_never_reaches_git_but_still_refreshes() {
        let (_root, work) = mirrored();
        let sessions = session::SessionState::default();
        let view = session::open(&sessions, &work).unwrap();
        let state = WriteState::default();
        let holder = state.begin().unwrap();
        state.cancel_flag().store(true, Ordering::SeqCst);
        let result = run_fetch(
            &state,
            &sessions,
            view.version,
            FetchTarget::Remote("origin".into()),
            &mut |_| {},
        )
        .unwrap();
        state.finish();
        let _ = holder;
        assert_eq!(result.outcome, Outcome::Cancelled);
        assert_eq!(result.exit_code, None);
        assert_eq!(
            result.operation_id, 0,
            "inner path leaves stamping to the wrapper"
        );
        assert!(result.snapshot.unwrap().version > view.version);
    }

    #[test]
    fn set_upstream_binds_a_listed_ref_and_unsetting_clears_it() {
        let (root, work) = mirrored();
        git(&work, &["branch", "side"]);
        advance_via_peer(root.path(), "peer tip");
        let state = WriteState::default();
        let sessions = session::SessionState::default();
        let view = session::open(&sessions, &work).unwrap();
        // side has no remote branch of its own yet; bind it to origin/main.
        let result = set_upstream(
            &state,
            &sessions,
            view.version,
            "side".into(),
            Some("origin/main".into()),
        )
        .unwrap();
        assert_eq!(result.outcome, Outcome::Success, "{}", result.message);
        let version = result.snapshot.as_ref().unwrap().version;
        assert_eq!(
            branch_of(&work, "side").upstream.as_deref(),
            Some("origin/main")
        );

        let result = run_set_upstream(&state, &sessions, version, "side", None).unwrap();
        assert_eq!(result.outcome, Outcome::Success, "{}", result.message);
        assert_eq!(branch_of(&work, "side").upstream, None);
        // Clearing twice is refused pre-flight, not by a second Git run:
        // Git itself would say "has no upstream information".
        let version = result.snapshot.unwrap().version;
        let result = run_set_upstream(&state, &sessions, version, "side", None).unwrap();
        assert_eq!(result.outcome, Outcome::Rejected);
        assert_eq!(result.exit_code, None);
        assert!(result.message.contains("no upstream to clear"));
    }

    #[test]
    fn set_upstream_refuses_targets_the_fresh_listing_does_not_hold() {
        let (_root, work) = mirrored();
        let state = WriteState::default();
        let sessions = session::SessionState::default();
        let view = session::open(&sessions, &work).unwrap();
        // Ghost upstream: not fetched, so not bindable — Git never runs.
        let result = set_upstream(
            &state,
            &sessions,
            view.version,
            "main".into(),
            Some("origin/nosuch".into()),
        )
        .unwrap();
        assert_eq!(result.outcome, Outcome::Rejected, "{}", result.message);
        assert_eq!(result.exit_code, None);
        assert!(result.message.contains("not a fetched remote-tracking ref"));
        let version = result.snapshot.unwrap().version;
        // Ghost branch.
        let result =
            run_set_upstream(&state, &sessions, version, "nosuch", Some("origin/main")).unwrap();
        assert_eq!(result.outcome, Outcome::Rejected);
        assert_eq!(result.exit_code, None);
        assert!(result.message.contains("No local branch"));
        // Stale versions refuse too.
        let version = result.snapshot.unwrap().version;
        let result = run_set_upstream(&state, &sessions, version + 7, "main", None).unwrap();
        assert_eq!(result.outcome, Outcome::Rejected);
        assert_eq!(result.exit_code, None);
    }

    #[cfg(unix)]
    #[test]
    fn unaddressable_branch_names_are_refused_not_guessed() {
        use std::ffi::OsStr;
        use std::os::unix::ffi::OsStrExt;
        let (_root, work) = mirrored();
        let oid = branch_of(&work, "main").oid;
        // One non-UTF-8 raw name: its lossy display form cannot be turned
        // back into the exact bytes, so binding it must be refused.
        let status = std::process::Command::new("git")
            .arg("-C")
            .arg(&work)
            .args(["branch", "--"])
            .arg(OsStr::from_bytes(b"odd\xff"))
            .arg(&oid)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/nonexistent-guit-test-config")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("LC_ALL", "C")
            .status()
            .expect("git");
        assert!(status.success());
        let state = WriteState::default();
        let sessions = session::SessionState::default();
        let view = session::open(&sessions, &work).unwrap();
        let odd = branch_of(&work, "odd\u{fffd}");
        assert!(!odd.addressable);
        let result = run_set_upstream(
            &state,
            &sessions,
            view.version,
            &odd.name,
            Some("origin/main"),
        )
        .unwrap();
        assert_eq!(result.outcome, Outcome::Rejected, "{}", result.message);
        assert_eq!(result.exit_code, None, "Git must not have been invoked");
        assert!(result.message.contains("byte-exact"));
    }

    #[test]
    fn fetch_wire_shape_distinguishes_all_from_a_remote_named_all() {
        let broadcast: FetchTarget = serde_json::from_str("\"all\"").unwrap();
        assert_eq!(broadcast, FetchTarget::All);
        let named: FetchTarget = serde_json::from_str("{\"remote\":\"all\"}").unwrap();
        assert_eq!(named, FetchTarget::Remote("all".into()));
        // Anything else — unknown fields, arrays, numbers — fails at the
        // command boundary, never as a silent fetch.
        assert!(serde_json::from_str::<FetchTarget>(r#"{"remote":"a","x":1}"#).is_err());
        assert!(serde_json::from_str::<FetchTarget>(r#"["all"]"#).is_err());
        assert!(serde_json::from_str::<FetchTarget>("42").is_err());
    }

    fn pull_env(work: &Path) -> (WriteState, session::SessionState, u64) {
        let state = WriteState::default();
        let sessions = session::SessionState::default();
        let view = session::open(&sessions, work).unwrap();
        (state, sessions, view.version)
    }

    fn second_parent_exists(work: &Path) -> bool {
        branches::run_git(
            work,
            &["rev-parse", "--verify", "--quiet", "HEAD^2"],
            &AtomicBool::new(false),
        )
        .unwrap()
        .status
        .success()
    }

    #[test]
    fn pull_default_reports_the_effective_rule_and_its_scope() {
        let (_root, work) = mirrored();
        let sessions = session::SessionState::default();
        session::open(&sessions, &work).unwrap();
        let plain = pull_default(&sessions).unwrap();
        assert_eq!((plain.rebase.as_ref(), plain.ff.as_ref()), (None, None));
        assert_eq!(plain.effective, "merge");
        assert_eq!(plain.note, None);

        git(&work, &["config", "pull.rebase", "merges"]);
        let configured = pull_default(&sessions).unwrap();
        let rebase = configured.rebase.expect("local value");
        assert_eq!(
            (rebase.value.as_str(), rebase.scope.as_str()),
            ("merges", "local")
        );
        // Measured mapping (plan decision 8): merges rides the merge lane
        // and says so.
        assert_eq!(configured.effective, "merge");
        assert!(
            configured.note.expect("note").contains("merges"),
            "the mapping is said out loud"
        );

        git(&work, &["config", "--unset-all", "pull.rebase"]);
        git(&work, &["config", "pull.ff", "only"]);
        let ff_only = pull_default(&sessions).unwrap();
        assert_eq!(ff_only.ff.expect("value").value, "only");
        assert_eq!(ff_only.effective, "fast-forward only");
    }

    #[test]
    fn pull_fast_forwards_a_behind_branch_inside_one_queue_unit() {
        let (root, work) = mirrored();
        advance_via_peer(root.path(), "from peer");
        let remote_tip = read(&root.path().join("origin.git"), &["rev-parse", "main"]);
        let (state, sessions, version) = pull_env(&work);
        let result = pull(
            &state,
            &sessions,
            version,
            PullStrategy::Default,
            &mut |_, _| {},
        )
        .unwrap();
        assert_eq!(result.outcome, Outcome::Success, "{}", result.message);
        assert_eq!(result.kind, OperationKind::Pull);
        assert_eq!(result.message, "Pulled origin/main (merged).");
        assert!(result.operation_id > 0, "the wrapper stamps the id");
        assert_eq!(branch_of(&work, "main").oid, remote_tip);
        assert!(
            !second_parent_exists(&work),
            "a behind-only pull fast-forwards, it does not merge"
        );
        assert_eq!(
            read(&work, &["rev-parse", "origin/main"]),
            remote_tip,
            "the fetch leg moved the tracking ref in the same slot"
        );
    }

    #[test]
    fn pull_diverged_default_creates_a_merge_commit() {
        let (root, work) = mirrored();
        let (local_tip, bare_tip) = diverged(root.path(), &work);
        let (state, sessions, version) = pull_env(&work);
        let result = pull(
            &state,
            &sessions,
            version,
            PullStrategy::Default,
            &mut |_, _| {},
        )
        .unwrap();
        assert_eq!(result.outcome, Outcome::Success, "{}", result.message);
        assert_eq!(read(&work, &["rev-parse", "HEAD^1"]), local_tip);
        assert_eq!(read(&work, &["rev-parse", "HEAD^2"]), bare_tip);
        // A pull integrates; it never answers back.
        assert_eq!(
            read(&root.path().join("origin.git"), &["rev-parse", "main"]),
            bare_tip
        );
    }

    #[test]
    fn pull_rebase_strategy_rewrites_local_commits_and_leaves_remote() {
        let (root, work) = mirrored();
        let (_local_tip, bare_tip) = diverged(root.path(), &work);
        let (state, sessions, version) = pull_env(&work);
        let result = pull(
            &state,
            &sessions,
            version,
            PullStrategy::Rebase,
            &mut |_, _| {},
        )
        .unwrap();
        assert_eq!(result.outcome, Outcome::Success, "{}", result.message);
        assert_eq!(result.message, "Pulled origin/main (rebased).");
        assert_eq!(
            read(&work, &["rev-parse", "HEAD^1"]),
            bare_tip,
            "replayed onto the remote tip"
        );
        assert_eq!(
            read(&work, &["rev-list", "--count", "origin/main..HEAD"]),
            "1"
        );
        assert_eq!(read(&work, &["log", "-1", "--format=%s"]), "local work");
        assert_eq!(
            read(&root.path().join("origin.git"), &["rev-parse", "main"]),
            bare_tip
        );
    }

    #[test]
    fn pull_ffonly_refuses_divergence_without_moving_anything() {
        let (root, work) = mirrored();
        let (local_tip, _bare_tip) = diverged(root.path(), &work);
        let (state, sessions, version) = pull_env(&work);
        let result = pull(
            &state,
            &sessions,
            version,
            PullStrategy::FfOnly,
            &mut |_, _| {},
        )
        .unwrap();
        assert_eq!(result.outcome, Outcome::Failed, "{}", result.message);
        // Measured on Git 2.53: rc 128 with the hint block first on stderr.
        assert_eq!(result.exit_code, Some(128));
        assert_eq!(result.message, "git merge --ff-only reported a failure.");
        assert!(result
            .details
            .as_deref()
            .expect("git's refusal")
            .contains("fast-forward"));
        assert_eq!(branch_of(&work, "main").oid, local_tip);
        assert!(result.snapshot.expect("re-read").operation.is_none());
    }

    #[test]
    fn pull_default_rebases_when_pull_rebase_is_true() {
        let (root, work) = mirrored();
        git(&work, &["config", "pull.rebase", "true"]);
        advance_via_peer(root.path(), "from peer");
        let remote_tip = read(&root.path().join("origin.git"), &["rev-parse", "main"]);
        let (state, sessions, version) = pull_env(&work);
        let result = pull(
            &state,
            &sessions,
            version,
            PullStrategy::Default,
            &mut |_, _| {},
        )
        .unwrap();
        assert_eq!(result.outcome, Outcome::Success, "{}", result.message);
        assert_eq!(result.message, "Pulled origin/main (rebased).");
        assert_eq!(branch_of(&work, "main").oid, remote_tip);
    }

    #[test]
    fn pull_default_honours_pull_ff_only_and_ff_false() {
        // ff=only with a clean behind: the standalone lane fast-forwards.
        let (root, work) = mirrored();
        git(&work, &["config", "pull.ff", "only"]);
        advance_via_peer(root.path(), "from peer");
        let (state, sessions, version) = pull_env(&work);
        let result = pull(
            &state,
            &sessions,
            version,
            PullStrategy::Default,
            &mut |_, _| {},
        )
        .unwrap();
        assert_eq!(result.outcome, Outcome::Success, "{}", result.message);
        assert_eq!(result.message, "Pulled origin/main (fast-forward).");
        assert!(!second_parent_exists(&work));

        // ff=false with a clean behind: the no-ff merge lane commits.
        let (root, work) = mirrored();
        git(&work, &["config", "pull.ff", "false"]);
        advance_via_peer(root.path(), "from peer");
        let local_tip = branch_of(&work, "main").oid;
        let (state, sessions, version) = pull_env(&work);
        let result = pull(
            &state,
            &sessions,
            version,
            PullStrategy::Default,
            &mut |_, _| {},
        )
        .unwrap();
        assert_eq!(result.outcome, Outcome::Success, "{}", result.message);
        assert_eq!(
            read(&work, &["rev-parse", "HEAD^1"]),
            local_tip,
            "pull.ff=false must not silently fast-forward"
        );
        assert!(second_parent_exists(&work));
    }

    #[test]
    fn pull_without_upstream_is_refused_with_a_publish_hint() {
        let root = tempfile::tempdir().unwrap();
        let work = root.path().join("solo");
        std::fs::create_dir(&work).unwrap();
        git(&work, &["init", "-q", "--initial-branch=main"]);
        commit(&work, "one");
        let (state, sessions, version) = pull_env(&work);
        let result = pull(
            &state,
            &sessions,
            version,
            PullStrategy::Default,
            &mut |_, _| {},
        )
        .unwrap();
        assert_eq!(result.outcome, Outcome::Rejected, "{}", result.message);
        assert_eq!(result.exit_code, None, "Git must not have been invoked");
        assert!(result.message.contains("no upstream"));
        assert!(result.message.contains("publish"));
    }

    #[test]
    fn pull_conflict_hands_off_to_the_banner_lane() {
        let (root, work) = mirrored();
        commit_paths(&work, &[("a.txt", "local\n")], "local change");
        peer_commits(root.path(), &[("a.txt", "remote\n")], "peer change");
        let (state, sessions, version) = pull_env(&work);
        let result = pull(
            &state,
            &sessions,
            version,
            PullStrategy::Default,
            &mut |_, _| {},
        )
        .unwrap();
        assert_eq!(result.outcome, Outcome::Conflicted, "{}", result.message);
        assert_eq!(result.kind, OperationKind::Pull);
        let view = result.snapshot.expect("in-flight state");
        let operation = view.operation.expect("merge detected");
        assert_eq!(operation.kind, crate::inflight::OperationKindView::Merge);
        // The existing banner lane finishes what pull started.
        let aborted = sequencer::operation_abort(&state, &sessions, view.version).unwrap();
        assert_eq!(aborted.outcome, Outcome::Success, "{}", aborted.message);
        let after = aborted.snapshot.expect("re-read");
        assert!(after.operation.is_none());
        assert!(after.files.is_empty(), "abort must restore a clean tree");
    }

    #[test]
    fn pull_stops_when_the_fetch_leg_fails() {
        let (root, work) = mirrored();
        let head_before = branch_of(&work, "main").oid;
        git(
            &work,
            &[
                "remote",
                "set-url",
                "origin",
                &root.path().join("nowhere.git").to_string_lossy(),
            ],
        );
        let (state, sessions, version) = pull_env(&work);
        let result = pull(
            &state,
            &sessions,
            version,
            PullStrategy::Default,
            &mut |_, _| {},
        )
        .unwrap();
        assert_eq!(result.outcome, Outcome::Failed, "{}", result.message);
        assert!(
            result.message.contains("nothing was integrated"),
            "msg: {}",
            result.message
        );
        assert!(
            result.exit_code.is_some(),
            "the fetch failure code survives"
        );
        assert!(result.details.is_some(), "git's redacted refusal survives");
        assert_eq!(branch_of(&work, "main").oid, head_before);
    }

    #[test]
    fn pull_a_dangling_remote_in_the_upstream_config_surfaces_as_no_upstream() {
        let (_root, work) = mirrored();
        // Measured on Git 2.53: with branch.main.remote pointing at a remote
        // that is not configured, for-each-ref elides %(upstream) entirely,
        // so guit sees "no upstream" rather than a remote name to refuse.
        // plan_pull's pull_remote_missing branch stays as defense-in-depth
        // (and `git remote remove` deletes branch.<name>.* config outright).
        git(&work, &["config", "branch.main.remote", "ghost"]);
        git(&work, &["config", "branch.main.merge", "refs/heads/main"]);
        let (state, sessions, version) = pull_env(&work);
        let result = pull(
            &state,
            &sessions,
            version,
            PullStrategy::Default,
            &mut |_, _| {},
        )
        .unwrap();
        assert_eq!(result.outcome, Outcome::Rejected, "{}", result.message);
        assert_eq!(result.exit_code, None, "Git must not have been invoked");
        assert!(
            result.message.contains("no upstream"),
            "msg: {}",
            result.message
        );
    }

    #[test]
    fn stale_version_and_pre_cancel_pulls_never_reach_git_but_still_refresh() {
        let (_root, work) = mirrored();
        let (state, sessions, version) = pull_env(&work);
        let view_version = version;
        let stale = run_pull(
            &state,
            &sessions,
            version + 5,
            PullStrategy::Default,
            &mut |_| {},
        )
        .unwrap();
        assert_eq!(stale.outcome, Outcome::Rejected);
        assert_eq!(stale.exit_code, None);
        let version = stale.snapshot.expect("re-read").version;
        assert!(version > view_version);

        let holder = state.begin().unwrap();
        state.cancel_flag().store(true, Ordering::SeqCst);
        let cancelled = run_pull(
            &state,
            &sessions,
            version,
            PullStrategy::Default,
            &mut |_| {},
        )
        .unwrap();
        state.finish();
        let _ = holder;
        assert_eq!(
            cancelled.outcome,
            Outcome::Cancelled,
            "{}",
            cancelled.message
        );
        assert_eq!(cancelled.exit_code, None);
        assert_eq!(
            cancelled.operation_id, 0,
            "inner path leaves stamping to the wrapper"
        );
        assert!(cancelled.message.contains("no remote was contacted"));
    }

    #[cfg(unix)]
    #[test]
    fn pull_a_non_utf8_merge_config_never_reaches_git_and_the_listing_survives() {
        use std::ffi::OsStr;
        use std::os::unix::ffi::OsStrExt;
        let (_root, work) = mirrored();
        let oid = branch_of(&work, "main").oid;
        // Measured on Git 2.53: a merge= config carrying raw non-UTF-8
        // bytes makes for-each-ref elide %(upstream), so guit reports
        // "no upstream" instead of guessing a lossy target. The snapshot
        // that pull_env builds already proves refs::list survives the raw
        // tracking ref; plan_pull's upstream_not_addressable branch stays
        // as defense-in-depth.
        let status = std::process::Command::new("git")
            .arg("-C")
            .arg(&work)
            .arg("update-ref")
            .arg(OsStr::from_bytes(b"refs/remotes/origin/odd\xff"))
            .arg(&oid)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/nonexistent-guit-test-config")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("LC_ALL", "C")
            .status()
            .expect("git");
        assert!(status.success(), "update-ref failed");
        // The upstream must point at that ref. `--set-upstream-to` would
        // refuse (the lossy name does not exist as a real ref), so raw
        // bytes go straight into the branch's merge config.
        let status = std::process::Command::new("git")
            .arg("-C")
            .arg(&work)
            .arg("config")
            .arg("branch.main.merge")
            .arg(OsStr::from_bytes(b"refs/remotes/origin/odd\xff"))
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/nonexistent-guit-test-config")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("LC_ALL", "C")
            .status()
            .expect("git");
        assert!(status.success(), "config failed");
        let (state, sessions, version) = pull_env(&work);
        let result = run_pull(
            &state,
            &sessions,
            version,
            PullStrategy::Default,
            &mut |_| {},
        )
        .unwrap();
        assert_eq!(result.outcome, Outcome::Rejected, "{}", result.message);
        assert_eq!(result.exit_code, None, "Git must not have been invoked");
        assert!(
            result.message.contains("no upstream"),
            "msg: {}",
            result.message
        );
        assert!(
            result.snapshot.is_some(),
            "a refusal must still hand back a fresh snapshot"
        );
    }

    #[test]
    fn pull_wire_shape_pins_the_strategy_words() {
        for (word, want) in [
            (r#""default""#, PullStrategy::Default),
            (r#""ffonly""#, PullStrategy::FfOnly),
            (r#""merge""#, PullStrategy::Merge),
            (r#""rebase""#, PullStrategy::Rebase),
        ] {
            assert_eq!(serde_json::from_str::<PullStrategy>(word).unwrap(), want);
        }
        assert!(serde_json::from_str::<PullStrategy>(r#""ffOnly""#).is_err());
        assert!(serde_json::from_str::<PullStrategy>(r#""DEFAULT""#).is_err());
        assert!(serde_json::from_str::<PullStrategy>("42").is_err());
        assert!(serde_json::from_str::<PullStrategy>(r#"{"nope":null}"#).is_err());
    }
}
