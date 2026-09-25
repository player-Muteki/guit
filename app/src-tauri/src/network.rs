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
use crate::{branches, refs, remotes, session, submodules};
use serde::Deserialize;
use std::path::Path;
use std::sync::atomic::Ordering;
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

/// Assumes the queue slot is held; tests call this directly to pre-arm
/// cancellation, mirroring the other runners. The broadcast form keeps
/// going after one remote fails — each remote gets its own chance — and
/// the final message lists exactly which side of that line holds.
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
            let mut fetched: Vec<String> = Vec::new();
            let mut failed: Vec<String> = Vec::new();
            let mut first_failure: Option<(i32, String)> = None;
            let mut cancelled = false;
            for name in &names {
                if state.cancel_flag().load(Ordering::SeqCst) {
                    cancelled = true;
                    break;
                }
                let mut command = repo::user_git_command(&work_root);
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
                            fetched.push(name.clone());
                        } else {
                            failed.push(name.clone());
                            if first_failure.is_none() {
                                first_failure = Some((
                                    output.status.code().unwrap_or(-1),
                                    write::first_stderr_line(&output.stderr),
                                ));
                            }
                        }
                    }
                    Err(error) if error.code == "process_cancelled" => {
                        // Stop landed mid-transfer for this remote: it is
                        // neither fetched nor failed, and the sweep stops.
                        cancelled = true;
                        break;
                    }
                    Err(error) => return Err(error),
                }
            }
            let skipped_note = if skipped > 0 {
                format!(" {skipped} remote(s) could not be addressed and were skipped.")
            } else {
                String::new()
            };
            details = first_failure.as_ref().map(|(_, line)| line.clone());
            exit_code = first_failure.as_ref().map(|(code, _)| *code);
            if cancelled {
                outcome = Outcome::Cancelled;
                message = format!(
                    "Cancelled while fetching; {}.{}",
                    if fetched.is_empty() {
                        "no remote completed".to_string()
                    } else {
                        format!("completed: {}", quoted(&fetched))
                    },
                    skipped_note
                );
            } else if failed.is_empty() {
                outcome = Outcome::Success;
                message = if broadcast {
                    format!("Fetched all {} remote(s).{}", fetched.len(), skipped_note)
                } else {
                    format!("Fetched from \"{}\".", fetched[0])
                };
            } else {
                outcome = Outcome::Failed;
                message = if broadcast {
                    format!(
                        "Fetched {} of {} remotes; {} reported a failure.{} What did arrive is \
                         kept — the tracking refs show it.",
                        fetched.len(),
                        fetched.len() + failed.len(),
                        quoted(&failed),
                        skipped_note
                    )
                } else {
                    format!("git fetch on \"{}\" reported a failure.", failed[0])
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
                if &remote.name == name {
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

    /// Working repo `work` pushing to bare `origin`.
    fn mirrored() -> (tempfile::TempDir, std::path::PathBuf) {
        let root = tempfile::tempdir().unwrap();
        let bare = root.path().join("origin.git");
        std::fs::create_dir(&bare).unwrap();
        git(&bare, &["init", "-q", "--bare", "--initial-branch=main"]);
        let work = root.path().join("work");
        std::fs::create_dir(&work).unwrap();
        git(&work, &["init", "-q", "--initial-branch=main"]);
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
}
