//! Remote configuration. The remote list is read from
//! `git remote` plus a per-name `git remote get-url [--push]`, and every URL
//! that leaves this module is redacted — a URL can embed a token and the
//! frontend must never see the raw form. Names and URLs are validated by
//! guit's own gates before Git is asked (measured on Git 2.53: `git remote
//! add` stores `ext::sh -c ...` happily and only a later fetch fails, so the
//! dangerous shapes must be refused on the way in). Removal is destructive —
//! `git remote remove` also deletes the remote-tracking refs — and runs
//! behind the same one-time ticket as the other data-losing operations.

use crate::probe::{redact, ProbeError};
use crate::repo::RepoIdentity;
use crate::write::{self, OperationKind, OperationResult, Outcome, PreviewResult, WriteState};
use crate::{branches, refs, session};
use serde::Serialize;
use std::path::{Path, PathBuf};

/// Read-only listings run outside the write lane and never participate in
/// cancellation; they execute against this permanently-unset flag.
static NO_CANCEL: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

const MAX_NAME_LEN: usize = 100;
const MAX_URL_LEN: usize = 4096;
/// Remote-tracking ref names shown in a removal preview beyond this count
/// collapse into a total; the ticket always binds the full set.
const PREVIEW_REF_LIMIT: usize = 20;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteView {
    /// Display form of the name; `addressable` says whether the bytes
    /// round-trip losslessly, which every operation except display needs.
    pub name: String,
    /// Redacted fetch URL; None when Git cannot read the configuration.
    pub fetch_url: Option<String>,
    /// Redacted push URL, present only when it differs from the fetch URL.
    pub push_url: Option<String>,
    pub addressable: bool,
}

pub(crate) fn session_directory(sessions: &session::SessionState) -> Result<PathBuf, ProbeError> {
    let identity = sessions
        .current_identity()
        .ok_or_else(|| ProbeError::new("remote_no_session", "No repository is open."))?;
    bare_or_work_dir(&identity)
}

/// Config reads resolve in a bare repository from its git dir; writes are
/// separately gated through `commit_context`, which refuses bare sessions.
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

/// guit's own name gate. Git itself rejects spaces and `.` but accepts
/// leading dashes only because they then parse as switches — validation
/// must never depend on Git's argument parser to stay safe.
pub(crate) fn validate_remote_name(name: &str) -> Result<(), ProbeError> {
    let rejected = name.is_empty()
        || name.len() > MAX_NAME_LEN
        || name.starts_with('-')
        || name.contains(char::is_whitespace)
        || name.contains(['"', '\'', '[', ']', '\\', '{'])
        || name.chars().any(|c| (c as u32) < 0x20 || c as u32 == 0x7f);
    if rejected {
        return Err(ProbeError::new(
            "remote_name_invalid",
            "The remote name is not usable: 1-100 bytes, no whitespace, quotes, backslash, \
             braces or brackets, no leading dash, no control characters.",
        ));
    }
    Ok(())
}

/// guit's own URL gate (measured 2026-09-24 on Git 2.53): `remote add`
/// accepts `ext::sh -c ...` with rc=0 and only the later fetch fails with
/// "transport 'ext' not allowed", so refusing the `<token>::` transport
/// prefix here is the only place that can keep a booby-trapped remote out
/// of the configuration.
fn validate_remote_url(url: &str) -> Result<(), ProbeError> {
    let rejected = url.is_empty()
        || url.len() > MAX_URL_LEN
        || url.starts_with('-')
        || url.contains(char::is_whitespace)
        || url.chars().any(|c| (c as u32) < 0x20 || c as u32 == 0x7f);
    if rejected {
        return Err(ProbeError::new(
            "remote_url_invalid",
            "The remote URL is not usable: non-empty, no whitespace or control characters, \
             no leading dash.",
        ));
    }
    if let Some(position) = url.find("::") {
        // A transport prefix is a token with no path separator in front of
        // `::`; IPv6 hosts (`http://[::1]/x`) keep the slashes and stay legal.
        if !url[..position].contains('/') {
            return Err(ProbeError::new(
                "remote_url_transport_refused",
                "Extended transport URLs (ext:: and similar) are refused: they make Git run \
                 arbitrary commands.",
            ));
        }
    }
    if let Some(position) = url.find("://") {
        const ALLOWED: [&str; 7] = ["http", "https", "ssh", "git", "ftp", "ftps", "file"];
        let scheme = url[..position].to_ascii_lowercase();
        if !ALLOWED.contains(&scheme.as_str()) {
            return Err(ProbeError::new(
                "remote_url_scheme_unsupported",
                format!(
                    "URL scheme \"{scheme}\" is not supported; guit accepts http, https, ssh, \
                     git, ftp, ftps and file (or an scp-style host:path or a local path)."
                ),
            ));
        }
    }
    Ok(())
}

/// `git remote` prints one name per line, raw bytes.
fn parse_names(stdout: &[u8]) -> Vec<Vec<u8>> {
    stdout
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
        .map(|line| line.to_vec())
        .collect()
}

pub(crate) fn raw_names(dir: &Path) -> Result<Vec<Vec<u8>>, ProbeError> {
    let output = branches::run_git(dir, &["remote"], &NO_CANCEL)?;
    if output.truncated {
        return Err(ProbeError::new(
            "remote_list_too_large",
            "The remote listing exceeded the read limit.",
        ));
    }
    Ok(parse_names(&output.stdout))
}

fn get_url(dir: &Path, name: &str, push: bool) -> Result<Option<String>, ProbeError> {
    let mut args: Vec<&str> = vec!["remote", "get-url"];
    if push {
        args.push("--push");
    }
    args.push(name);
    let output = branches::run_git(dir, &args, &NO_CANCEL)?;
    if output.truncated {
        return Err(ProbeError::new(
            "remote_url_too_large",
            "The URL Git reported exceeded the read limit.",
        ));
    }
    if !output.status.success() {
        // A configured remote without a URL is broken, not fatal to display.
        return Ok(None);
    }
    let url = String::from_utf8_lossy(&output.stdout)
        .trim_end()
        .to_owned();
    Ok(Some(url))
}

fn view_from_raw(dir: &Path, raw: &[u8]) -> RemoteView {
    let addressable = std::str::from_utf8(raw).is_ok();
    let name = String::from_utf8_lossy(raw).into_owned();
    let (mut fetch_url, mut push_url) = (None, None);
    if addressable {
        // Read failures degrade to None rather than poisoning the listing:
        // an entry guit cannot fully understand is still shown as it is.
        fetch_url = get_url(dir, &name, false)
            .ok()
            .flatten()
            .map(|url| redact(&url));
        let push = get_url(dir, &name, true).ok().flatten();
        push_url = push.filter(|url| Some(redact(url)) != fetch_url);
    }
    RemoteView {
        name,
        fetch_url,
        push_url,
        addressable,
    }
}

pub(crate) fn list_view(sessions: &session::SessionState) -> Result<Vec<RemoteView>, ProbeError> {
    let dir = session_directory(sessions)?;
    let raws = raw_names(&dir)?;
    Ok(raws.iter().map(|raw| view_from_raw(&dir, raw)).collect())
}

/// Re-read the config state a remove ticket is bound to: existence, fetch
/// URL and the remote-tracking ref set of one remote.
fn tracking_refs(dir: &Path, name: &str) -> Result<Vec<String>, ProbeError> {
    let listing = refs::list(dir)?;
    let prefix = format!("{name}/");
    Ok(listing
        .remotes
        .iter()
        .filter(|remote| remote.name.starts_with(&prefix))
        .map(|remote| remote.name.clone())
        .collect())
}

/// The write-lane shell around every remote configuration change: the
/// `build` closure runs the gates (name/URL/existence) inside the session's
/// work root and returns the argv for Git; rejections never reach the
/// process, and every outcome ends with the mandatory re-read.
fn run_config_op(
    state: &WriteState,
    sessions: &session::SessionState,
    snapshot_version: u64,
    kind: OperationKind,
    verb: &str,
    build: &dyn Fn(&Path) -> Result<Vec<String>, ProbeError>,
    success: &dyn Fn() -> String,
) -> Result<OperationResult, ProbeError> {
    let mut outcome = Outcome::Success;
    let mut exit_code = None;
    let message;
    let mut details = None;
    match sessions
        .commit_context(snapshot_version)
        .and_then(|(work_root, _unborn)| build(&work_root).map(|args| (work_root, args)))
    {
        Err(error) => {
            outcome = Outcome::Rejected;
            message = error.message;
        }
        Ok((work_root, args)) => {
            if state
                .cancel_flag()
                .load(std::sync::atomic::Ordering::SeqCst)
            {
                outcome = Outcome::Cancelled;
                message = "Cancelled before Git ran.".into();
            } else {
                let argv: Vec<&str> = args.iter().map(String::as_str).collect();
                match branches::run_git(&work_root, &argv, state.cancel_flag()) {
                    Ok(output) => {
                        exit_code = output.status.code();
                        if output.status.success() && !output.truncated {
                            message = success();
                        } else {
                            outcome = Outcome::Failed;
                            message = format!("git remote {verb} reported a failure.");
                            details = Some(write::first_stderr_line(&output.stderr));
                        }
                    }
                    Err(error) if error.code == "process_cancelled" => {
                        outcome = Outcome::Cancelled;
                        message = "Cancelled while the Git process was running; the config may \
                             be half-changed."
                            .into();
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
        kind,
        outcome,
        exit_code,
        message,
        details,
        snapshot,
    })
}

pub(crate) fn remote_add(
    state: &WriteState,
    sessions: &session::SessionState,
    snapshot_version: u64,
    name: String,
    url: String,
) -> Result<OperationResult, ProbeError> {
    let operation_id = state.begin()?;
    let result = run_config_op(
        state,
        sessions,
        snapshot_version,
        OperationKind::RemoteAdd,
        "add",
        &|work_root| {
            validate_remote_name(&name)?;
            validate_remote_url(&url)?;
            if exists(work_root, &name)? {
                return Err(ProbeError::new(
                    "remote_exists",
                    format!("A remote named \"{name}\" already exists; set its URL instead."),
                ));
            }
            Ok(vec![
                "remote".into(),
                "add".into(),
                name.clone(),
                url.clone(),
            ])
        },
        &|| format!("Remote \"{name}\" added."),
    );
    state.finish();
    result.map(|mut result| {
        result.operation_id = operation_id;
        result
    })
}

pub(crate) fn remote_set_url(
    state: &WriteState,
    sessions: &session::SessionState,
    snapshot_version: u64,
    name: String,
    url: String,
    push: bool,
) -> Result<OperationResult, ProbeError> {
    let operation_id = state.begin()?;
    let result = run_config_op(
        state,
        sessions,
        snapshot_version,
        OperationKind::RemoteSetUrl,
        "set-url",
        &|work_root| {
            validate_remote_name(&name)?;
            validate_remote_url(&url)?;
            if !exists(work_root, &name)? {
                return Err(ProbeError::new(
                    "remote_missing",
                    format!("No remote named \"{name}\" is configured; refresh the list."),
                ));
            }
            let mut args = vec!["remote".to_string(), "set-url".to_string()];
            if push {
                args.push("--push".into());
            }
            args.push(name.clone());
            args.push(url.clone());
            Ok(args)
        },
        &|| format!("URL of remote \"{name}\" updated."),
    );
    state.finish();
    result.map(|mut result| {
        result.operation_id = operation_id;
        result
    })
}

/// Exact byte-level membership: only names that round-trip losslessly can
/// be addressed, and the server never trusts the client's view.
fn exists(dir: &Path, name: &str) -> Result<bool, ProbeError> {
    Ok(raw_names(dir)?.iter().any(|raw| raw == name.as_bytes()))
}

pub(crate) fn preview_remove_remote(
    state: &WriteState,
    sessions: &session::SessionState,
    snapshot_version: u64,
    name: String,
) -> Result<PreviewResult, ProbeError> {
    let (work_root, _unborn) = sessions.commit_context(snapshot_version)?;
    validate_remote_name(&name)?;
    if !exists(&work_root, &name)? {
        return Err(ProbeError::new(
            "remote_missing",
            format!("No remote named \"{name}\" is configured; refresh the list."),
        ));
    }
    let raw_url = get_url(&work_root, &name, false)?.unwrap_or_default();
    let tracking = tracking_refs(&work_root, &name)?;
    let nonce = state.stage_remote_remove(
        work_root.clone(),
        name.clone(),
        raw_url.clone(),
        tracking.clone(),
    );
    let snapshot = session::refresh(sessions)?
        .ok_or_else(|| ProbeError::new("write_no_session", "No repository session is open."))?;
    let mut candidates = Vec::new();
    if raw_url.is_empty() {
        candidates.push("URL: (unreadable)".into());
    } else {
        // The preview shows only the redacted form; the raw URL stays in the
        // ticket, where it serves as the drift binding.
        candidates.push(format!("URL: {}", redact(&raw_url)));
    }
    let shown = tracking.len().min(PREVIEW_REF_LIMIT);
    candidates.extend(tracking.iter().take(shown).cloned());
    if tracking.len() > shown {
        candidates.push(format!("... and {} more", tracking.len() - shown));
    }
    Ok(PreviewResult {
        nonce,
        candidates,
        dropped: Vec::new(),
        snapshot,
        target_oid: None,
    })
}

pub(crate) fn remove_remote(
    state: &WriteState,
    sessions: &session::SessionState,
    nonce: String,
) -> Result<OperationResult, ProbeError> {
    let operation_id = state.begin()?;
    let result = run_remove(state, sessions, &nonce);
    state.finish();
    result.map(|mut result| {
        result.operation_id = operation_id;
        result
    })
}

fn run_remove(
    state: &WriteState,
    sessions: &session::SessionState,
    nonce: &str,
) -> Result<OperationResult, ProbeError> {
    let mut outcome = Outcome::Success;
    let mut exit_code = None;
    let message;
    let mut details = None;
    let Some((dir, name, url, tracking)) = state.take_remote_remove(nonce) else {
        let snapshot = session::refresh(sessions)?;
        return Ok(OperationResult {
            category: None,
            suggestion: None,
            operation_id: 0,
            kind: OperationKind::RemoteRemove,
            outcome: Outcome::Rejected,
            exit_code: None,
            message: "That confirmation has expired; preview the action again.".into(),
            details: None,
            snapshot,
        });
    };
    let same_repo = sessions
        .current_identity()
        .is_some_and(|identity| identity.work_root.as_deref() == Some(dir.as_path()));
    // Re-check everything the ticket bound: the remote must still exist,
    // still carry the same URL and the same remote-tracking ref set.
    let unchanged = same_repo
        && exists(&dir, &name)?
        && get_url(&dir, &name, false)?.unwrap_or_default() == url
        && tracking_refs(&dir, &name)? == tracking;
    if !unchanged {
        outcome = Outcome::Rejected;
        message = "The remote or its refs changed after the preview; nothing was removed.".into();
    } else if state
        .cancel_flag()
        .load(std::sync::atomic::Ordering::SeqCst)
    {
        outcome = Outcome::Cancelled;
        message = "Cancelled before Git ran.".into();
    } else {
        match branches::run_git(&dir, &["remote", "remove", &name], state.cancel_flag()) {
            Ok(output) => {
                exit_code = output.status.code();
                if output.status.success() && !output.truncated {
                    message = format!("Remote \"{name}\" and its remote-tracking refs removed.");
                } else {
                    outcome = Outcome::Failed;
                    message = "git remote remove reported a failure.".into();
                    details = Some(write::first_stderr_line(&output.stderr));
                }
            }
            Err(error) if error.code == "process_cancelled" => {
                outcome = Outcome::Cancelled;
                message = "Cancelled while Git ran; check the remote list.".into();
            }
            Err(error) => return Err(error),
        }
    }
    let snapshot = session::refresh(sessions)?;
    Ok(OperationResult {
        category: None,
        suggestion: None,
        operation_id: 0,
        kind: OperationKind::RemoteRemove,
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

    const COMMIT_ID: &[&str] = &[
        "-c",
        "user.name=guit test",
        "-c",
        "user.email=test@example.invalid",
    ];

    fn git(dir: &Path, args: &[&str]) {
        repo::git_with(dir, COMMIT_ID, args);
    }

    fn seeded_repo() -> tempfile::TempDir {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path();
        repo::git_with(dir, &[], &["init", "--quiet", "--initial-branch=main"]);
        std::fs::write(dir.join("a.txt"), "one\n").unwrap();
        git(dir, &["add", "--", "a.txt"]);
        git(dir, &["commit", "-q", "-m", "base"]);
        root
    }

    fn bare_repo(dir: &Path) {
        if !dir.exists() {
            std::fs::create_dir(dir).unwrap();
        }
        repo::git_with(
            dir,
            &[],
            &["init", "--bare", "--quiet", "--initial-branch=main"],
        );
    }

    #[test]
    fn name_gate_matrix() {
        let long = "x".repeat(MAX_NAME_LEN);
        for good in ["origin", "up.stream", "a-b_c", long.as_str()] {
            validate_remote_name(&good)
                .unwrap_or_else(|error| panic!("must accept {good}: {}", error.message));
        }
        for bad in [
            "",
            "  ",
            "-lead",
            "sp ace",
            "tab\there",
            "new\nline",
            "q\"uo",
            "s'in",
            "br[a]cket",
            "back\\slash",
            "curly{brace",
            &"x".repeat(MAX_NAME_LEN + 1),
            "ctrl\x01char",
        ] {
            assert_eq!(
                validate_remote_name(bad).map(|_| ()).unwrap_err().code,
                "remote_name_invalid",
                "must refuse {bad:?}"
            );
        }
    }

    #[test]
    fn url_gate_matrix_covers_measured_transport_hazards() {
        for good in [
            "https://example.invalid/repo.git",
            "http://[::1]:8080/repo",
            "ssh://git@example.invalid/repo.git",
            "git://example.invalid/repo.git",
            "file:///tmp/repo",
            "git@example.invalid:owner/repo.git", // scp-style
            "/srv/git/repo.git",                  // absolute local path
            "../relative/repo.git",
            "ftp://example.invalid/repo",
            "FTPS://example.invalid/repo", // scheme case is tolerated
        ] {
            validate_remote_url(good)
                .unwrap_or_else(|error| panic!("must accept {good}: {}", error.message));
        }
        // Git 2.53 stores ext:: remotes with rc=0 and only fails on fetch;
        // guit refuses them at the gate.
        for (bad, code) in [
            ("ext::sh -c touch% /tmp/pwned", "remote_url_invalid"), // contains a space
            ("ext::/bin/sh", "remote_url_transport_refused"),
            ("fd::1:2", "remote_url_transport_refused"),
            ("helper::x", "remote_url_transport_refused"),
            (
                "sftp://example.invalid/repo",
                "remote_url_scheme_unsupported",
            ),
            ("-u", "remote_url_invalid"),
            ("sp ace/x", "remote_url_invalid"),
            ("", "remote_url_invalid"),
            ("https://example.invalid/x\x01", "remote_url_invalid"),
        ] {
            assert_eq!(
                validate_remote_url(bad).map(|_| ()).unwrap_err().code,
                code,
                "must refuse {bad:?}"
            );
        }
    }

    #[test]
    fn names_parse_and_non_utf8_is_display_only() {
        let names = parse_names(b"origin\nup.stream\nk\xffy\n");
        assert_eq!(names.len(), 3);
        assert_eq!(names[0], b"origin");
        let views = names
            .iter()
            .map(|raw| {
                (
                    String::from_utf8_lossy(raw).into_owned(),
                    std::str::from_utf8(raw).is_ok(),
                )
            })
            .collect::<Vec<_>>();
        assert_eq!(views[2], ("k\u{fffd}y".into(), false));
    }

    #[test]
    fn listing_redacts_credentials_and_shows_the_push_url_when_split() {
        let repository = seeded_repo();
        let root = repository.path();
        let sessions = session::SessionState::default();
        session::open(&sessions, root).unwrap();
        git(
            root,
            &[
                "remote",
                "add",
                "origin",
                "https://example.invalid/origin.git",
            ],
        );
        git(
            root,
            &[
                "remote",
                "add",
                "tokened",
                "https://tokensecret@example.invalid/x.git",
            ],
        );
        git(
            root,
            &["remote", "set-url", "--push", "origin", "ssh://push/only"],
        );

        let list = list_view(&sessions).unwrap();
        let origin = list.iter().find(|r| r.name == "origin").unwrap();
        assert_eq!(
            origin.fetch_url.as_deref(),
            Some("https://example.invalid/origin.git")
        );
        assert_eq!(origin.push_url.as_deref(), Some("ssh://push/only"));
        let tokened = list.iter().find(|r| r.name == "tokened").unwrap();
        let shown = tokened.fetch_url.as_deref().unwrap();
        assert!(
            !shown.contains("tokensecret"),
            "credentials leaked: {shown}"
        );
        assert!(
            shown.contains("[redacted]"),
            "redaction marker missing: {shown}"
        );
        assert!(list.iter().all(|r| r.addressable));
    }

    #[test]
    fn add_list_remove_round_trip_through_the_ticket() {
        let repository = tempfile::tempdir().unwrap();
        let work = repository.path().join("repo");
        std::fs::create_dir(&work).unwrap();
        repo::git_with(&work, &[], &["init", "--quiet", "--initial-branch=main"]);
        std::fs::write(work.join("a.txt"), "one\n").unwrap();
        git(&work, &["add", "--", "a.txt"]);
        git(&work, &["commit", "-q", "-m", "base"]);
        let origin = repository.path().join("origin.git");
        bare_repo(&origin);
        let sessions = session::SessionState::default();
        let view = session::open(&sessions, &work).unwrap();
        let state = WriteState::default();
        let added = remote_add(
            &state,
            &sessions,
            view.version,
            "origin".into(),
            origin.to_string_lossy().into_owned(),
        )
        .unwrap();
        assert_eq!(added.outcome, Outcome::Success, "msg: {}", added.message);
        let version = added.snapshot.expect("re-read").version;
        let list = list_view(&sessions).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(
            list[0].fetch_url.as_deref(),
            Some(origin.to_string_lossy().as_ref())
        );
        let preview = preview_remove_remote(&state, &sessions, version, "origin".into()).unwrap();
        let removed = remove_remote(&state, &sessions, preview.nonce).unwrap();
        assert_eq!(
            removed.outcome,
            Outcome::Success,
            "msg: {}",
            removed.message
        );
        assert!(list_view(&sessions).unwrap().is_empty());
        assert!(
            removed.snapshot.is_some(),
            "every outcome re-reads the truth"
        );
    }

    #[test]
    fn remove_binds_url_and_tracking_refs_against_drift() {
        let repository = seeded_repo();
        let root = repository.path();
        let origin = repository.path().join("origin.git");
        bare_repo(&origin);
        git(
            root,
            &["remote", "add", "origin", &origin.to_string_lossy()],
        );
        git(root, &["fetch", "-q", "--prune", "origin"]);
        git(root, &["update-ref", "refs/remotes/origin/x", "HEAD"]);
        let sessions = session::SessionState::default();
        let view = session::open(&sessions, root).unwrap();
        let state = WriteState::default();

        let preview =
            preview_remove_remote(&state, &sessions, view.version, "origin".into()).unwrap();
        assert!(preview
            .candidates
            .iter()
            .any(|line| line.starts_with("URL: ")));
        assert!(preview.candidates.iter().any(|line| line == "origin/x"));

        // Drift: the URL moved out from under the ticket.
        git(root, &["remote", "set-url", "origin", "/tmp/elsewhere"]);
        let drift = remove_remote(&state, &sessions, preview.nonce).unwrap();
        assert_eq!(drift.outcome, Outcome::Rejected, "msg: {}", drift.message);
        assert!(drift.message.contains("changed after the preview"));
        assert_eq!(drift.exit_code, None, "Git must not have been invoked");
        assert!(exists(root, "origin").unwrap(), "the remote must survive");
        let version = drift.snapshot.expect("re-read").version;

        // Drift via the ref set alone (URL untouched): a new tracking ref.
        let preview = preview_remove_remote(&state, &sessions, version, "origin".into()).unwrap();
        let nonce = preview.nonce.clone();
        git(root, &["update-ref", "refs/remotes/origin/y", "HEAD"]);
        let drift = remove_remote(&state, &sessions, preview.nonce).unwrap();
        assert_eq!(drift.outcome, Outcome::Rejected, "msg: {}", drift.message);
        drift.snapshot.expect("re-read");

        // The refusal consumed the ticket; replaying it gives the expired
        // answer rather than a second drift check.
        let replay = remove_remote(&state, &sessions, nonce).unwrap();
        assert_eq!(replay.outcome, Outcome::Rejected);
        assert!(replay.message.contains("expired"));
        let version = replay.snapshot.expect("re-read").version;

        // A fresh chain confirms, and the remote-tracking refs go with it.
        let preview = preview_remove_remote(&state, &sessions, version, "origin".into()).unwrap();
        let removed = remove_remote(&state, &sessions, preview.nonce).unwrap();
        assert_eq!(
            removed.outcome,
            Outcome::Success,
            "msg: {}",
            removed.message
        );
        assert!(list_view(&sessions).unwrap().is_empty());
        assert!(
            refs::list(root).unwrap().remotes.is_empty(),
            "git remote remove takes the tracking refs with it"
        );
    }

    #[test]
    fn duplicate_names_are_refused_before_git_runs() {
        let repository = seeded_repo();
        let root = repository.path();
        git(root, &["remote", "add", "origin", "/srv/origin"]);
        let sessions = session::SessionState::default();
        let view = session::open(&sessions, root).unwrap();
        let state = WriteState::default();
        let duplicate = remote_add(
            &state,
            &sessions,
            view.version,
            "origin".into(),
            "/x".into(),
        )
        .unwrap();
        assert_eq!(duplicate.outcome, Outcome::Rejected);
        assert!(duplicate.message.contains("already exists"));
        assert_eq!(duplicate.exit_code, None, "Git must not have been invoked");
        assert_eq!(list_view(&sessions).unwrap().len(), 1);
    }

    #[test]
    fn set_url_targets_fetch_and_push_independently() {
        let repository = seeded_repo();
        let root = repository.path();
        git(
            root,
            &["remote", "add", "origin", "https://fetch.invalid/x"],
        );
        let sessions = session::SessionState::default();
        let view = session::open(&sessions, root).unwrap();
        let state = WriteState::default();
        let result = remote_set_url(
            &state,
            &sessions,
            view.version,
            "origin".into(),
            "https://fetch2.invalid/x".into(),
            false,
        )
        .unwrap();
        assert_eq!(result.outcome, Outcome::Success, "msg: {}", result.message);
        let version = result.snapshot.expect("re-read").version;
        let result = remote_set_url(
            &state,
            &sessions,
            version,
            "origin".into(),
            "ext::sh".into(),
            true,
        )
        .unwrap();
        assert_eq!(
            result.outcome,
            Outcome::Rejected,
            "the gate holds for set-url too"
        );
        let version = result.snapshot.expect("re-read").version;
        let ghost = remote_set_url(
            &state,
            &sessions,
            version,
            "ghost".into(),
            "/y".into(),
            true,
        )
        .unwrap();
        assert_eq!(ghost.outcome, Outcome::Rejected);
        assert!(ghost.message.contains("No remote"));
    }

    #[test]
    fn bare_sessions_list_remotes_but_refuse_writes() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        bare_repo(root);
        repo::git_with(root, &[], &["remote", "add", "origin", "/srv/origin"]);
        let sessions = session::SessionState::default();
        let view = session::open(&sessions, root).unwrap();
        let list = list_view(&sessions).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "origin");
        assert_eq!(list[0].fetch_url.as_deref(), Some("/srv/origin"));
        let state = WriteState::default();
        let result = remote_add(&state, &sessions, view.version, "x".into(), "/y".into()).unwrap();
        assert_eq!(result.outcome, Outcome::Rejected);
        // The rejection path re-reads like every other outcome; the fresh
        // version keeps the next gate on the bare guard, not the version one.
        let version = result.snapshot.expect("re-read").version;
        let error = preview_remove_remote(&state, &sessions, version, "origin".into()).unwrap_err();
        assert_eq!(error.code, "write_bare_repo");
    }

    #[test]
    fn pre_cancelled_add_never_reaches_git_but_still_refreshes() {
        let repository = seeded_repo();
        let root = repository.path();
        let sessions = session::SessionState::default();
        let view = session::open(&sessions, root).unwrap();
        let state = WriteState::default();
        let _gate = state.begin().unwrap();
        state.cancel();
        let result = run_config_op(
            &state,
            &sessions,
            view.version,
            OperationKind::RemoteAdd,
            "add",
            &|_work_root| {
                Ok(vec![
                    "remote".into(),
                    "add".into(),
                    "nope".into(),
                    "/x".into(),
                ])
            },
            &|| String::new(),
        )
        .unwrap();
        state.finish();
        assert_eq!(result.outcome, Outcome::Cancelled);
        assert!(result.snapshot.is_some());
        assert!(list_view(&sessions).unwrap().is_empty());
    }
}
