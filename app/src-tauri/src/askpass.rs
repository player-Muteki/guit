//! Controlled credential prompting.
//! The default posture stays non-interactive: every Git process runs with
//! `GIT_TERMINAL_PROMPT=0` and no `GIT_ASKPASS`, so a credential-protected
//! remote fails fast and the network-failure classifier says why. The only
//! way a secret reaches guit is the explicit "Retry with credentials" path:
//! the network command arrives with `interactive: true`, which starts a
//! bridge living exactly as long as that queued operation.
//!
//! The bridge is a Unix socket (mode 0600) in a fresh 0700 directory under
//! `$XDG_RUNTIME_DIR` (the temp dir when unset) guarded by a per-bridge
//! nonce. Interactive commands inject only `GIT_ASKPASS=<own executable>`,
//! `GUIT_ASKPASS_ADDR` and `GUIT_ASKPASS_TOKEN` into the Git child. Git
//! execs `GIT_ASKPASS` as a single argv program with the prompt as its one
//! argument (measured on 2.53: `prompt.c::do_askpass`), so the executable
//! recognises its helper role either from the hidden `--guit-askpass
//! <prompt>` form or from that exact spawn shape plus the two `GUIT_`
//! variables; it forwards the prompt over the socket and prints exactly one
//! answer line, or exits non-zero and lets Git report its own failure.
//!
//! The rules this module exists to enforce:
//! - Only `Username for …` / `Password for …` prompts quoting an http(s)
//!   URL are ever answered. SSH passphrases and anything else are refused
//!   so ssh-agent stays the sanctioned path.
//! - Events carry categorised metadata only — kind, scheme+host and the
//!   bare user part — never the raw prompt and never the secret.
//! - Secrets live only in the in-memory channel between `submit_askpass`
//!   and the blocked prompt, and every prompt expires after a timeout.
//! - The bridge is torn down with its operation; nothing is persisted.

use crate::probe::{self, ProbeError};
use crate::write;
use crate::{branches, remotes, session};
use serde::Serialize;
use std::collections::BTreeMap;
use std::ffi::{OsStr, OsString};
use std::io::{BufRead, BufReader, Read, Write};
#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

static NO_CANCEL: AtomicBool = AtomicBool::new(false);

/// How long one prompt waits for the user before the answer channel dies.
pub(crate) const DEFAULT_TIMEOUT: Duration = Duration::from_secs(120);
/// A connected client must speak within this budget so `Bridge::stop` can
/// always join its worker; a stalled local socket cannot hold the lane.
const CONNECT_READ_TIMEOUT: Duration = Duration::from_secs(10);
/// Slightly above the server-side timeout so the bridge normally closes
/// the exchange, not the helper.
const CLIENT_READ_TIMEOUT: Duration = Duration::from_secs(150);
const MAX_REQUEST_BYTES: u64 = 4096;
const MAX_REPLY_BYTES: u64 = 65536;
/// Operation slot value meaning "the queue slot was not yet attached".
const UNATTACHED: u64 = u64::MAX;

/// Declared to the frontend by `credential_status` so the policy is not a
/// legend the UI has to keep in sync by hand.
pub(crate) const POLICY: &str = "Git runs with GIT_TERMINAL_PROMPT=0 and no GIT_ASKPASS by \
                                 default; guit asks for HTTP(S) credentials only through the \
                                 explicit Retry with credentials dialog, keeps them in memory \
                                 for one operation and never writes them anywhere. SSH key \
                                 passphrases are not bridged: unlock keys through ssh-agent \
                                 (or the desktop keychain) instead.";

#[derive(Debug, PartialEq, Eq)]
struct Request {
    kind: &'static str,
    target: String,
    user: Option<String>,
}

/// Git 2.53 asks for HTTP credentials in exactly two English shapes under
/// guit's `LC_ALL=C` (measured; prompt.c passes the translated string to
/// the askpass program):
///   `Username for '<scheme>://<host>[:<port>]': `
///   `Password for '<scheme>://<user>@<host>[:<port>]': `
/// Anything else — including `Enter passphrase for key …` — is refused.
fn classify_prompt(prompt: &str) -> Option<Request> {
    let (kind, rest) = prompt
        .strip_prefix("Username for ")
        .map(|rest| ("username", rest))
        .or_else(|| {
            prompt
                .strip_prefix("Password for ")
                .map(|rest| ("password", rest))
        })?;
    let url = quoted_span(rest)?;
    let (scheme, user, host) = split_http_authority(url)?;
    let target = format!("{scheme}://{host}");
    // The displayed target must be its own redaction fixed point, so it
    // can never carry userinfo, query or fragment material.
    if probe::redact(&target) != target {
        return None;
    }
    Some(Request {
        kind,
        target,
        user: user
            .filter(|user| is_displayable_user(user))
            .map(str::to_owned),
    })
}

fn quoted_span(text: &str) -> Option<&str> {
    let start = text.find('\'')?;
    let rest = &text[start + 1..];
    Some(&rest[..rest.find('\'')?])
}

fn split_http_authority(url: &str) -> Option<(String, Option<&str>, String)> {
    let (scheme, tail) = url.split_once("://")?;
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return None;
    }
    let authority = tail.split(['/', '?', '#']).next()?;
    let (user, host) = match authority.rsplit_once('@') {
        Some((user, host)) => {
            // A raw ':' in the userinfo of a Git-authored prompt means the
            // remote URL smuggled an embedded credential; refusing the
            // whole request is safer than guessing which half to show.
            if user.contains(':') {
                return None;
            }
            (Some(user), host)
        }
        None => (None, authority),
    };
    if host.is_empty() {
        return None;
    }
    Some((scheme, user, host.to_owned()))
}

/// The displayed user must be bare username material. A `:` means the URL
/// carried an embedded credential (`user:token@host`), and refusing the
/// whole request is safer than guessing which half to show.
fn is_displayable_user(user: &str) -> bool {
    !user.is_empty()
        && user.len() <= 64
        && !user.contains(':')
        && user
            .chars()
            .all(|c| !c.is_whitespace() && (c as u32) >= 0x20 && (c as u32) != 0x7f)
}

struct Pending {
    operation_id: u64,
    token: String,
    tx: Sender<String>,
}

/// Managed state: at most one operation can hold an open prompt, mirroring
/// the single write-lane slot it is attached to.
#[derive(Default)]
pub(crate) struct AskPassManager {
    slot: Arc<Mutex<Option<Pending>>>,
}

impl AskPassManager {
    /// Routes a dialog answer into the blocked prompt. `false` means no
    /// prompt of that operation is waiting (answered, expired, or gone).
    /// The secret is consumed here and never echoed back.
    pub(crate) fn submit(&self, operation_id: u64, secret: String) -> bool {
        let mut guard = crate::util::guard(&self.slot);
        match guard.as_mut() {
            Some(pending) if pending.operation_id == operation_id => {
                pending.tx.send(secret).is_ok()
            }
            _ => false,
        }
    }
}

/// The bridge for one interactive network operation. Lives on the stack of
/// the command handler that created it; `Drop` closes the socket, wakes any
/// blocked prompt as a refusal and removes the private directory.
#[cfg(unix)]
pub(crate) struct Bridge {
    dir: PathBuf,
    socket: PathBuf,
    token: String,
    operation: Arc<AtomicU64>,
    slot: Arc<Mutex<Option<Pending>>>,
    shutdown: Option<Sender<()>>,
    worker: Option<JoinHandle<()>>,
}

#[cfg(unix)]
impl Bridge {
    /// Binds the private socket and registers the answer route. The
    /// operation id is attached separately once the write lane hands one
    /// out, so a bridge created before `begin` refuses prompts until its
    /// operation truly owns the queue slot.
    pub(crate) fn start(
        manager: &AskPassManager,
        timeout: Duration,
        mut emit: Box<dyn FnMut(serde_json::Value) + Send>,
    ) -> Result<Bridge, ProbeError> {
        let dir = socket_dir()?;
        let socket = dir.join("pipe");
        let listener = std::os::unix::net::UnixListener::bind(&socket).map_err(|error| {
            ProbeError::new(
                "askpass_socket_failed",
                format!("guit could not listen for credential answers: {error}"),
            )
        })?;
        std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600)).map_err(
            |error| {
                ProbeError::new(
                    "askpass_socket_failed",
                    format!("guit could not protect the credential socket: {error}"),
                )
            },
        )?;
        let _ = listener.set_nonblocking(true);
        let token = write::new_nonce();
        let operation = Arc::new(AtomicU64::new(UNATTACHED));
        let (tx, rx) = mpsc::channel::<String>();
        *crate::util::guard(&manager.slot) = Some(Pending {
            operation_id: UNATTACHED,
            token: token.clone(),
            tx,
        });
        let (shutdown_tx, shutdown_rx) = mpsc::channel::<()>();
        let worker = {
            let operation = operation.clone();
            let worker_token = token.clone();
            std::thread::spawn(move || {
                accept_loop(
                    listener,
                    rx,
                    shutdown_rx,
                    worker_token,
                    operation,
                    timeout,
                    &mut emit,
                )
            })
        };
        Ok(Bridge {
            dir,
            socket,
            token,
            operation,
            slot: manager.slot.clone(),
            shutdown: Some(shutdown_tx),
            worker: Some(worker),
        })
    }

    /// Binds this bridge to the queue slot that is about to run the Git
    /// child. Prompts arriving before this call are refused outright.
    pub(crate) fn attach_operation(&self, operation_id: u64) {
        self.operation.store(operation_id, Ordering::SeqCst);
        let mut guard = crate::util::guard(&self.slot);
        if guard
            .as_ref()
            .is_some_and(|pending| pending.token == self.token)
        {
            guard.as_mut().expect("checked above").operation_id = operation_id;
        }
    }

    /// Injects exactly the three variables that turn the own executable
    /// into the bridge client for this Git child. Must be called *after*
    /// `repo::user_git_command` (which strips every inherited `GIT_*`).
    pub(crate) fn apply_env(&self, command: &mut Command) {
        let Ok(executable) = std::env::current_exe() else {
            return;
        };
        command.env("GIT_ASKPASS", executable);
        command.env("GUIT_ASKPASS_ADDR", &self.socket);
        command.env("GUIT_ASKPASS_TOKEN", &self.token);
    }

    fn teardown(&mut self) {
        // Retire the answer route first: dropping the only sender wakes a
        // blocked prompt as a refusal so the worker join cannot stall.
        {
            let mut guard = crate::util::guard(&self.slot);
            if guard
                .as_ref()
                .is_some_and(|pending| pending.token == self.token)
            {
                *guard = None;
            }
        }
        drop(self.shutdown.take());
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

#[cfg(unix)]
impl Drop for Bridge {
    fn drop(&mut self) {
        self.teardown();
    }
}

#[cfg(unix)]
fn socket_dir() -> Result<PathBuf, ProbeError> {
    let base = std::env::var_os("XDG_RUNTIME_DIR")
        .filter(|raw| !raw.is_empty())
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .unwrap_or_else(std::env::temp_dir);
    let dir = base.join(format!("guit-askpass-{}", write::new_nonce()));
    std::fs::DirBuilder::new()
        .mode(0o700)
        .create(&dir)
        .map_err(|error| {
            ProbeError::new(
                "askpass_socket_failed",
                format!(
                    "guit could not create a private directory for credential answers: {error}"
                ),
            )
        })?;
    Ok(dir)
}

/// Bridge directories are removed by `Bridge::drop`, but a kill -9 leaves
/// them behind. At startup, probe every `guit-askpass-*` directory: a socket
/// that refuses connection (or is gone) has no live listener and the whole
/// private directory is deleted; a socket that accepts belongs to a running
/// instance and is left alone. The connect probe is race-safe without a
/// single-instance lock — deleting a directory whose owner just died is
/// harmless, never deleting a live one is the requirement.
#[cfg(unix)]
pub(crate) fn sweep_stale_bridges() -> usize {
    let mut bases: Vec<PathBuf> = Vec::new();
    if let Some(runtime) = std::env::var_os("XDG_RUNTIME_DIR")
        .filter(|raw| !raw.is_empty())
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
    {
        bases.push(runtime);
    }
    bases.push(std::env::temp_dir());
    sweep_stale_bridges_in(&bases)
}

#[cfg(unix)]
fn sweep_stale_bridges_in(bases: &[PathBuf]) -> usize {
    let mut removed = 0;
    for base in bases {
        let Ok(entries) = std::fs::read_dir(base) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            if !name.to_string_lossy().starts_with("guit-askpass-") {
                continue;
            }
            let dir = entry.path();
            if !dir.is_dir() {
                continue;
            }
            let socket = dir.join("pipe");
            let stale = std::os::unix::net::UnixStream::connect(&socket).is_err();
            if !stale {
                continue;
            }
            // A sweep that cannot remove what it judged stale would otherwise
            // be indistinguishable from "nothing was there": the counter is
            // the only thing startup reports, so a silent failure here reads as
            // a clean run while the directory is still on disk.
            match std::fs::remove_dir_all(&dir) {
                Ok(()) => removed += 1,
                Err(error) => eprintln!("guit [sweep]: {} left in place: {error}", dir.display()),
            }
        }
    }
    removed
}

/// Atomic config writes land through `tempfile` siblings named
/// `<name>.tmpXXXXXX`. A kill mid-write leaves such a sibling behind; it is
/// never read back, and after an hour no in-flight write can still own it.
/// The suffix shape (exactly six alphanumerics) keeps unrelated user files
/// that merely end in `.tmp` out of reach. Returns the number removed.
pub(crate) fn sweep_stale_config_temps(config_dir: &Path) -> usize {
    const OWNED: [&str; 3] = ["recent.json", "session.json", "window.json"];
    let Ok(entries) = std::fs::read_dir(config_dir) else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some((base, suffix)) = name.split_once(".tmp") else {
            continue;
        };
        if !OWNED.contains(&base)
            || suffix.len() != 6
            || !suffix.chars().all(|c| c.is_ascii_alphanumeric())
        {
            continue;
        }
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        let older_than_an_hour = meta
            .modified()
            .ok()
            .and_then(|when| when.elapsed().ok())
            .is_some_and(|age| age > std::time::Duration::from_secs(3600));
        if older_than_an_hour && std::fs::remove_file(entry.path()).is_ok() {
            removed += 1;
        }
    }
    removed
}

#[cfg(unix)]
#[allow(clippy::type_complexity)]
fn accept_loop(
    listener: std::os::unix::net::UnixListener,
    rx: Receiver<String>,
    shutdown: Receiver<()>,
    token: String,
    operation: Arc<AtomicU64>,
    timeout: Duration,
    emit: &mut dyn FnMut(serde_json::Value),
) {
    loop {
        match listener.accept() {
            Ok((stream, _)) => {
                handle_connection(stream, &rx, &operation, &token, timeout, emit);
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                if !matches!(
                    shutdown.recv_timeout(Duration::from_millis(100)),
                    Err(RecvTimeoutError::Timeout)
                ) {
                    break;
                }
            }
            Err(_) => break,
        }
    }
}

#[cfg(unix)]
fn handle_connection(
    stream: std::os::unix::net::UnixStream,
    rx: &Receiver<String>,
    operation: &AtomicU64,
    token: &str,
    timeout: Duration,
    emit: &mut dyn FnMut(serde_json::Value),
) {
    use std::io::Read;
    let _ = stream.set_read_timeout(Some(CONNECT_READ_TIMEOUT));
    let mut reader = BufReader::new(&stream).take(MAX_REQUEST_BYTES);
    let mut greeting = String::new();
    if reader.read_line(&mut greeting).unwrap_or(0) == 0 {
        return;
    }
    let mut prompt = String::new();
    if reader.read_line(&mut prompt).unwrap_or(0) == 0 {
        return;
    }
    trim_newlines(&mut greeting);
    trim_newlines(&mut prompt);
    if greeting != token {
        return;
    }
    let Some(request) = classify_prompt(&prompt) else {
        return;
    };
    let operation_id = operation.load(Ordering::SeqCst);
    if operation_id == UNATTACHED {
        return;
    }
    // A double-submitted answer must never queue up for the *next* prompt
    // of the same operation: anything not consumed by now is spent.
    while rx.try_recv().is_ok() {}
    emit(serde_json::json!({
        "operationId": operation_id,
        "kind": request.kind,
        "target": request.target,
        "user": request.user,
    }));
    if let Ok(secret) = rx.recv_timeout(timeout) {
        let mut writer = &stream;
        let _ = writer
            .write_all(secret.as_bytes())
            .and_then(|()| writer.write_all(b"\n"))
            .and_then(|()| writer.flush());
    }
}

#[cfg(unix)]
fn trim_newlines(text: &mut String) {
    while text.ends_with('\n') || text.ends_with('\r') {
        text.pop();
    }
}

/// Decides whether this process launch is Git calling the askpass helper,
/// and returns the prompt to answer. Both accepted shapes are measured:
/// the hidden `--guit-askpass <prompt>` form and Git's own single-argument
/// spawn of `GIT_ASKPASS` (prompt.c) carrying the two `GUIT_` variables.
#[cfg(unix)]
pub(crate) fn client_prompt_from_launch<F: FnMut(&str) -> Option<OsString>>(
    args: &[OsString],
    mut lookup: F,
) -> Option<String> {
    let mut armed = || {
        lookup("GUIT_ASKPASS_ADDR").filter(|value| !value.is_empty())?;
        lookup("GUIT_ASKPASS_TOKEN").filter(|value| !value.is_empty())
    };
    if args.len() == 3 && args[1] == "--guit-askpass" {
        return Some(args[2].to_string_lossy().into_owned());
    }
    if args.len() == 2 && armed().is_some() {
        return Some(args[1].to_string_lossy().into_owned());
    }
    None
}

/// The helper half of the bridge, run in-process for tests and by the
/// intercepted launch otherwise. Returns `None` for "no answer": the
/// caller must then exit non-zero and let Git report its own failure.
#[cfg(unix)]
pub(crate) fn client_reply(
    addr: impl AsRef<Path>,
    token: impl AsRef<OsStr>,
    prompt: &str,
) -> Option<String> {
    let stream = std::os::unix::net::UnixStream::connect(addr.as_ref()).ok()?;
    let _ = stream.set_read_timeout(Some(CLIENT_READ_TIMEOUT));
    let request = format!("{}\n{prompt}\n", token.as_ref().to_string_lossy());
    (&stream).write_all(request.as_bytes()).ok()?;
    (&stream).flush().ok()?;
    let mut reader = BufReader::new(&stream).take(MAX_REPLY_BYTES);
    let mut answer = String::new();
    match reader.read_line(&mut answer) {
        Ok(0) | Err(_) => None,
        Ok(_) => {
            trim_newlines(&mut answer);
            Some(answer)
        }
    }
}

/// Runs the helper role for an intercepted launch and reports the process
/// exit code. The answer goes to stdout exactly once (Git trims at the
/// first newline); an empty answer is a refusal, not a credential.
#[cfg(unix)]
pub(crate) fn run_client(prompt: &str) -> i32 {
    let Some(addr) = std::env::var_os("GUIT_ASKPASS_ADDR").filter(|value| !value.is_empty()) else {
        return 1;
    };
    let Some(token) = std::env::var_os("GUIT_ASKPASS_TOKEN").filter(|value| !value.is_empty())
    else {
        return 1;
    };
    match client_reply(Path::new(&addr), OsStr::new(&token), prompt) {
        Some(secret) if !secret.is_empty() => {
            let mut out = std::io::stdout().lock();
            out.write_all(secret.as_bytes())
                .and_then(|()| out.write_all(b"\n"))
                .and_then(|()| out.flush())
                .map(|()| 0)
                .unwrap_or(1)
        }
        _ => 1,
    }
}

/// Non-Unix stubs so every command handler compiles identically on all
/// platforms; interactive attempts fail with the documented gap instead of
/// silently pretending the bridge exists.
#[cfg(not(unix))]
pub(crate) struct Bridge;

#[cfg(not(unix))]
impl Bridge {
    #[allow(clippy::type_complexity)]
    pub(crate) fn start(
        _manager: &AskPassManager,
        _timeout: Duration,
        _emit: Box<dyn FnMut(serde_json::Value) + Send>,
    ) -> Result<Bridge, ProbeError> {
        Err(ProbeError::new(
            "askpass_unsupported",
            "Interactive credential entry is not implemented on this platform yet: run the \
             failing command in a terminal or configure a credential helper.",
        ))
    }

    pub(crate) fn attach_operation(&self, _operation_id: u64) {}

    pub(crate) fn apply_env(&self, _command: &mut Command) {}
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemeGroup {
    pub scheme: String,
    pub remotes: Vec<String>,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialView {
    /// `git config --get-all credential.helper` lines as configured.
    pub helpers: Vec<String>,
    /// Whether `SSH_AUTH_SOCK` points at something (existence only).
    pub ssh_agent: bool,
    /// Configured remotes grouped by transport scheme (display only; the
    /// URLs themselves never leave the backend).
    pub schemes: Vec<SchemeGroup>,
    pub policy: String,
}

/// Read-only credential posture report for the open repository.
pub(crate) fn credential_status(
    sessions: &session::SessionState,
) -> Result<CredentialView, ProbeError> {
    let dir = remotes::session_directory(sessions)?;
    credential_snapshot(&dir)
}

fn credential_snapshot(dir: &Path) -> Result<CredentialView, ProbeError> {
    Ok(CredentialView {
        helpers: credential_helpers(dir)?,
        ssh_agent: detect_ssh_agent(std::env::var_os("SSH_AUTH_SOCK").as_deref()),
        schemes: scheme_distribution(dir)?,
        policy: POLICY.to_owned(),
    })
}

fn credential_helpers(dir: &Path) -> Result<Vec<String>, ProbeError> {
    let output = branches::run_git(
        dir,
        &["config", "--get-all", "credential.helper"],
        &NO_CANCEL,
    )?;
    if output.truncated {
        return Err(ProbeError::new(
            "credential_list_too_large",
            "The credential.helper listing exceeded the read limit.",
        ));
    }
    if !output.status.success() {
        // Exit code 1 simply means no helper is configured anywhere.
        return Ok(Vec::new());
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_owned)
        .collect())
}

fn detect_ssh_agent(sock: Option<&OsStr>) -> bool {
    sock.is_some_and(|sock| !sock.is_empty())
}

fn scheme_distribution(dir: &Path) -> Result<Vec<SchemeGroup>, ProbeError> {
    let mut groups: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for raw in remotes::raw_names(dir)? {
        let Ok(name) = std::str::from_utf8(&raw) else {
            groups
                .entry("unprintable".to_owned())
                .or_default()
                .push(String::from_utf8_lossy(&raw).into_owned());
            continue;
        };
        let scheme = match remote_url(dir, name) {
            Some(url) => url_scheme(&url),
            None => "unreadable".to_owned(),
        };
        groups.entry(scheme).or_default().push(name.to_owned());
    }
    Ok(groups
        .into_iter()
        .map(|(scheme, mut names)| {
            names.sort();
            SchemeGroup {
                scheme,
                remotes: names,
            }
        })
        .collect())
}

fn remote_url(dir: &Path, name: &str) -> Option<String> {
    let output = branches::run_git(dir, &["remote", "get-url", name], &NO_CANCEL).ok()?;
    if output.truncated || !output.status.success() {
        return None;
    }
    Some(
        String::from_utf8_lossy(&output.stdout)
            .trim_end()
            .to_owned(),
    )
}

/// Transport label for the report: real schemes win; otherwise an
/// scp-style `[user@]host:path` is ssh and everything left is a local
/// path. Deliberately coarse — this informs the user, it never routes.
fn url_scheme(url: &str) -> String {
    if let Some((scheme, _)) = url.split_once("://") {
        let lower = scheme.to_ascii_lowercase();
        let valid = !lower.is_empty()
            && lower.len() <= 16
            && lower.starts_with(|c: char| c.is_ascii_alphabetic())
            && lower
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'-' | b'.'));
        if valid {
            return lower;
        }
    }
    if looks_like_path(url) {
        return "path".to_owned();
    }
    let body = url.rsplit_once('@').map(|(_, host)| host).unwrap_or(url);
    if body.contains(':') {
        return "ssh".to_owned();
    }
    "path".to_owned()
}

fn looks_like_path(url: &str) -> bool {
    url.starts_with('/')
        || url.starts_with("./")
        || url.starts_with("../")
        || url.starts_with('~')
        || (url.len() >= 2 && url.as_bytes()[0].is_ascii_alphabetic() && url.as_bytes()[1] == b':')
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::repo;
    use std::collections::HashMap;

    fn started(timeout: Duration) -> (AskPassManager, Bridge, Receiver<serde_json::Value>) {
        let manager = AskPassManager::default();
        let (ex, events) = mpsc::channel();
        let bridge = Bridge::start(
            &manager,
            timeout,
            Box::new(move |payload| {
                let _ = ex.send(payload);
            }),
        )
        .expect("the bridge binds");
        bridge.attach_operation(7);
        (manager, bridge, events)
    }

    #[test]
    fn prompts_classify_by_the_measured_git_shapes() {
        let username = classify_prompt("Username for 'http://127.0.0.1:8123': ").expect("shape");
        assert_eq!(username.kind, "username");
        assert_eq!(username.target, "http://127.0.0.1:8123");
        assert_eq!(username.user, None);
        let password = classify_prompt("Password for 'https://alice@github.com': ").expect("shape");
        assert_eq!(password.kind, "password");
        assert_eq!(password.target, "https://github.com");
        assert_eq!(password.user.as_deref(), Some("alice"));
        // Measured refusal: the bridge never touches SSH passphrases.
        assert!(classify_prompt("Enter passphrase for key '/home/u/.ssh/id_ed25519': ").is_none());
        assert!(classify_prompt("Username for 'ftp://host/x': ").is_none());
        assert!(classify_prompt("Password for 'https://alice@github.com'").is_some());
        assert!(classify_prompt("").is_none());
    }

    #[test]
    fn an_embedded_credential_in_the_prompt_is_refused_whole() {
        // A remote URL that smuggled user:token@ must not surface either
        // half as display material.
        assert!(classify_prompt("Password for 'https://alice:s3cret@github.com': ").is_none());
    }

    #[test]
    fn the_roundtrip_answers_one_prompt_and_emits_only_categorised_text() {
        let (manager, bridge, events) = started(DEFAULT_TIMEOUT);
        let socket = bridge.socket.clone();
        let token: OsString = bridge.token.clone().into();
        let client = std::thread::spawn(move || {
            client_reply(&socket, &token, "Username for 'http://127.0.0.1:9': ")
        });
        let event = events
            .recv_timeout(Duration::from_secs(5))
            .expect("the prompt is announced");
        assert_eq!(event["operationId"], serde_json::json!(7));
        assert_eq!(event["kind"], "username");
        assert_eq!(event["target"], "http://127.0.0.1:9");
        assert_eq!(event["user"], serde_json::Value::Null);
        let serialized = event.to_string();
        assert!(
            !serialized.contains("Username for"),
            "raw prompt leaked: {serialized}"
        );
        assert!(manager.submit(7, "alice".to_owned()));
        assert_eq!(
            client.join().expect("client thread"),
            Some("alice".to_owned())
        );
        // The same route answers the next prompt of the same operation,
        // which is exactly the measured two-call username→password flow.
        let socket = bridge.socket.clone();
        let token: OsString = bridge.token.clone().into();
        let client = std::thread::spawn(move || {
            client_reply(&socket, &token, "Password for 'http://alice@127.0.0.1:9': ")
        });
        let event = events
            .recv_timeout(Duration::from_secs(5))
            .expect("the password prompt is announced");
        assert_eq!(event["kind"], "password");
        assert_eq!(event["user"], "alice");
        assert_eq!(event["target"], "http://127.0.0.1:9");
        assert!(!event.to_string().contains("alice@127"), "userinfo leaked");
        assert!(manager.submit(7, "hunter2".to_owned()));
        assert_eq!(
            client.join().expect("client thread"),
            Some("hunter2".to_owned())
        );
        // Nothing in any serialization mentions the password; the bare
        // user on a password prompt is deliberate display material.
        let json = serde_json::to_string(&event).expect("events serialize");
        assert!(!json.contains("hunter2"), "{json}");
    }

    #[test]
    fn a_stale_answer_never_reaches_the_next_prompt() {
        let (manager, bridge, events) = started(DEFAULT_TIMEOUT);
        let socket = bridge.socket.clone();
        let token: OsString = bridge.token.clone().into();
        let client = std::thread::spawn(move || {
            client_reply(&socket, &token, "Username for 'http://127.0.0.1:9': ")
        });
        events
            .recv_timeout(Duration::from_secs(5))
            .expect("the prompt is announced");
        assert!(manager.submit(7, "first".to_owned()));
        assert_eq!(
            client.join().expect("client thread"),
            Some("first".to_owned())
        );
        // A late duplicate submit (a double-click) lands in the channel…
        assert!(manager.submit(7, "stale".to_owned()));
        // …but the next prompt drains it and only ever shows the fresh one.
        let socket = bridge.socket.clone();
        let token: OsString = bridge.token.clone().into();
        let client = std::thread::spawn(move || {
            client_reply(&socket, &token, "Password for 'http://alice@127.0.0.1:9': ")
        });
        events
            .recv_timeout(Duration::from_secs(5))
            .expect("the second prompt is announced");
        assert!(manager.submit(7, "second".to_owned()));
        assert_eq!(
            client.join().expect("client thread"),
            Some("second".to_owned())
        );
    }

    #[test]
    fn a_wrong_token_is_refused_without_a_prompt_event() {
        let (_manager, bridge, events) = started(DEFAULT_TIMEOUT);
        let socket = bridge.socket.clone();
        let answer = client_reply(
            &socket,
            OsStr::new("not-the-token"),
            "Username for 'http://127.0.0.1:9': ",
        );
        assert_eq!(answer, None);
        assert!(
            events.try_recv().is_err(),
            "a refused connection must not announce"
        );
    }

    #[test]
    fn a_passphrase_prompt_is_refused_without_a_prompt_event() {
        let (_manager, bridge, events) = started(DEFAULT_TIMEOUT);
        let socket = bridge.socket.clone();
        let token: OsString = bridge.token.clone().into();
        let answer = client_reply(
            &socket,
            &token,
            "Enter passphrase for key '/home/u/.ssh/id_ed25519': ",
        );
        assert_eq!(answer, None);
        assert!(events.try_recv().is_err());
    }

    #[test]
    fn an_unattached_bridge_refuses_before_the_queue_slot_exists() {
        let manager = AskPassManager::default();
        let (ex, events) = mpsc::channel();
        let bridge = Bridge::start(
            &manager,
            DEFAULT_TIMEOUT,
            Box::new(move |payload| {
                let _ = ex.send(payload);
            }),
        )
        .expect("the bridge binds");
        let socket = bridge.socket.clone();
        let token: OsString = bridge.token.clone().into();
        assert_eq!(
            client_reply(&socket, &token, "Username for 'http://127.0.0.1:9': "),
            None
        );
        assert!(events.try_recv().is_err());
        bridge.attach_operation(11);
        assert!(manager.submit(11, "later".to_owned()));
    }

    #[test]
    fn an_unanswered_prompt_expires_and_refuses() {
        let (_manager, bridge, events) = started(Duration::from_millis(300));
        let socket = bridge.socket.clone();
        let token: OsString = bridge.token.clone().into();
        let client = std::thread::spawn(move || {
            client_reply(&socket, &token, "Username for 'http://127.0.0.1:9': ")
        });
        events
            .recv_timeout(Duration::from_secs(5))
            .expect("the prompt is announced");
        assert_eq!(client.join().expect("client thread"), None);
    }

    #[test]
    fn stopping_the_bridge_fails_a_waiting_helper_at_once() {
        let (manager, bridge, events) = started(DEFAULT_TIMEOUT);
        let socket = bridge.socket.clone();
        let token: OsString = bridge.token.clone().into();
        let client = std::thread::spawn(move || {
            client_reply(&socket, &token, "Username for 'http://127.0.0.1:9': ")
        });
        events
            .recv_timeout(Duration::from_secs(5))
            .expect("the prompt is announced");
        let started_at = std::time::Instant::now();
        drop(bridge);
        assert_eq!(client.join().expect("client thread"), None);
        assert!(
            started_at.elapsed() < Duration::from_secs(5),
            "the operation's end must not wait out the prompt timeout"
        );
        assert!(!manager.submit(7, "too late".to_owned()));
    }

    #[test]
    fn only_the_three_bridge_variables_are_injected() {
        let (_manager, bridge, _events) = started(DEFAULT_TIMEOUT);
        let mut command = repo::user_git_command(Path::new("/"));
        bridge.apply_env(&mut command);
        let envs: HashMap<_, _> = command
            .get_envs()
            .filter_map(|(key, value)| Some((key.to_string_lossy().into_owned(), value?)))
            .map(|(key, value)| (key, value.to_string_lossy().into_owned()))
            .collect();
        assert_eq!(
            envs.get("GIT_ASKPASS").map(PathBuf::from),
            Some(std::env::current_exe().expect("exe"))
        );
        assert_eq!(
            envs.get("GUIT_ASKPASS_ADDR").map(PathBuf::from),
            Some(bridge.socket.clone())
        );
        assert_eq!(
            envs.get("GUIT_ASKPASS_TOKEN").map(String::as_str),
            Some(bridge.token.as_str())
        );
        assert!(!bridge.token.is_empty());
    }

    #[test]
    fn a_plain_command_carries_no_askpass_at_all() {
        let command = repo::user_git_command(Path::new("/"));
        let injected: Vec<_> = command
            .get_envs()
            .filter(|(_, value)| value.is_some())
            .map(|(key, _)| key.to_string_lossy().into_owned())
            .collect();
        assert!(
            !injected.contains(&"GIT_ASKPASS".to_owned()),
            "interactive=false must not touch GIT_ASKPASS: {injected:?}"
        );
    }

    #[test]
    fn the_helper_role_is_recognised_in_both_launch_shapes() {
        let mut envs = HashMap::new();
        envs.insert("GUIT_ASKPASS_ADDR".to_owned(), OsString::from("/tmp/s"));
        envs.insert("GUIT_ASKPASS_TOKEN".to_owned(), OsString::from("t"));
        let lookup = |key: &str| envs.get(key).cloned();
        let os = |values: &[&str]| -> Vec<OsString> { values.iter().map(OsString::from).collect() };
        assert_eq!(
            client_prompt_from_launch(
                &os(&["guit", "--guit-askpass", "Username for 'x': "]),
                lookup
            ),
            Some("Username for 'x': ".to_owned())
        );
        assert_eq!(
            client_prompt_from_launch(&os(&["guit", "Username for 'x': "]), lookup),
            Some("Username for 'x': ".to_owned())
        );
        // The plain GUI launch (no helper variables) never enters the client.
        let empty_lookup = |_: &str| None;
        assert_eq!(client_prompt_from_launch(&os(&["guit"]), lookup), None);
        assert_eq!(
            client_prompt_from_launch(&os(&["guit", "Username for 'x': "]), empty_lookup),
            None
        );
    }

    #[test]
    fn transport_labels_are_coarse_but_never_wrong() {
        assert_eq!(url_scheme("https://github.com/a/b.git"), "https");
        assert_eq!(url_scheme("HTTP://host/x"), "http");
        assert_eq!(url_scheme("git@github.com:p/o.git"), "ssh");
        assert_eq!(url_scheme("ssh://git@host:2222/p/o"), "ssh");
        assert_eq!(url_scheme("/srv/git/repo.git"), "path");
        assert_eq!(url_scheme("./relative/repo"), "path");
        assert_eq!(url_scheme("C:\\repos\\guit"), "path");
        assert_eq!(url_scheme("ftps://host/x"), "ftps");
    }

    #[test]
    fn a_submit_without_any_open_bridge_is_reported_as_expired() {
        let manager = AskPassManager::default();
        assert!(!manager.submit(1, "x".to_owned()));
    }

    fn temp_repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("temp dir");
        let run = |args: &[&str]| {
            let output = Command::new("git")
                .current_dir(dir.path())
                .args(args)
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("GIT_CONFIG_GLOBAL", "/nonexistent-guit-test-config")
                .env("GIT_TERMINAL_PROMPT", "0")
                .env("LC_ALL", "C")
                .output()
                .expect("git runs");
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        };
        run(&["init", "-q"]);
        run(&[
            "remote",
            "add",
            "origin",
            "https://github.com/acme/guit.git",
        ]);
        run(&[
            "remote",
            "add",
            "mirror",
            "git@mirror.example:acme/guit.git",
        ]);
        run(&["remote", "add", "local", "/srv/git/guit.git"]);
        run(&["config", "credential.helper", "store"]);
        dir
    }

    #[test]
    fn credential_snapshot_reports_helpers_and_scheme_groups() {
        let root = temp_repo();
        let view = credential_snapshot(root.path()).expect("snapshot reads");
        assert!(
            view.helpers.iter().any(|helper| helper == "store"),
            "the local helper must appear: {:?}",
            view.helpers
        );
        let groups: BTreeMap<_, _> = view
            .schemes
            .iter()
            .map(|group| (group.scheme.as_str(), group.remotes.clone()))
            .collect();
        assert_eq!(groups.get("https"), Some(&vec!["origin".to_owned()]));
        assert_eq!(groups.get("ssh"), Some(&vec!["mirror".to_owned()]));
        assert_eq!(groups.get("path"), Some(&vec!["local".to_owned()]));
        assert_eq!(view.policy, POLICY);
        assert!(!view.policy.contains("http://") && !view.policy.contains("@"));
    }

    #[test]
    fn a_repository_without_remotes_reads_without_error() {
        let root = tempfile::tempdir().expect("temp dir");
        Command::new("git")
            .current_dir(root.path())
            .args(["init", "-q"])
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/nonexistent-guit-test-config")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("LC_ALL", "C")
            .output()
            .expect("git runs");
        // The read path deliberately uses the user's own Git config (the
        // bridge honors their setup), so the helper list is whatever this
        // machine says; what is fixed is that an empty repository reads as
        // empty scheme groups with the declared policy, not as an error.
        let view = credential_snapshot(root.path()).expect("snapshot reads");
        assert!(view.schemes.is_empty());
        assert_eq!(view.policy, POLICY);
    }

    #[test]
    fn ssh_agent_detection_only_checks_existence() {
        assert!(detect_ssh_agent(Some(OsStr::new("/run/user/1000/s.g"))));
        assert!(!detect_ssh_agent(Some(OsStr::new(""))));
        assert!(!detect_ssh_agent(None));
    }

    #[test]
    fn the_credential_socket_directory_is_private() {
        let dir = socket_dir().expect("a private directory");
        let mode = std::fs::metadata(&dir)
            .expect("the directory exists")
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o700);
        std::fs::remove_dir_all(&dir).expect("cleaned");
    }

    fn stale_dir(base: &std::path::Path, tag: &str) -> PathBuf {
        let dir = base.join(format!("guit-askpass-{tag}"));
        std::fs::create_dir(&dir).expect("directory");
        dir
    }

    #[test]
    fn the_bridge_sweep_keeps_live_listeners_and_drops_the_rest() {
        let base = tempfile::tempdir().expect("temp base");
        let live = stale_dir(base.path(), "live");
        let dead = stale_dir(base.path(), "dead");
        let empty = stale_dir(base.path(), "empty");
        let listener = std::os::unix::net::UnixListener::bind(live.join("pipe")).expect("bind");
        std::fs::write(dead.join("pipe"), b"not a socket").expect("file");
        let foreign = base.path().join("guit-not-a-bridge");
        std::fs::create_dir(&foreign).expect("foreign directory");
        let removed = sweep_stale_bridges_in(&[base.path().to_path_buf()]);
        assert_eq!(removed, 2, "dead socket and pipeless directory go");
        assert!(live.exists() && listener.local_addr().is_ok(), "live stays");
        assert!(!dead.exists() && !empty.exists(), "stale directories go");
        assert!(foreign.exists(), "the sweep only touches its own shape");
    }

    #[test]
    fn the_bridge_sweep_removes_a_socket_file_left_by_a_dead_listener() {
        let base = tempfile::tempdir().expect("temp base");
        let dir = stale_dir(base.path(), "dropped");
        drop(std::os::unix::net::UnixListener::bind(dir.join("pipe")).expect("bind then drop"));
        assert!(dir.join("pipe").exists(), "std leaves the socket file");
        assert_eq!(sweep_stale_bridges_in(&[base.path().to_path_buf()]), 1);
        assert!(!dir.exists(), "a refused connect is a dead bridge");
    }

    #[test]
    fn the_config_sweep_removes_only_old_tempfile_siblings_of_owned_names() {
        let dir = tempfile::tempdir().expect("config dir");
        std::fs::write(dir.path().join("session.json.tmpAb1cD2"), b"x").expect("fresh owned");
        std::fs::write(dir.path().join("notes.tmp"), b"x").expect("foreign suffix");
        std::fs::write(dir.path().join("session.json.tmpZZ"), b"x").expect("short suffix");
        std::fs::write(dir.path().join("window.json.tmp123456"), b"x").expect("old owned");
        std::fs::write(dir.path().join("recent.json.tmpABC123"), b"x").expect("old owned");
        let old_output = std::process::Command::new("touch")
            .args(["-d", "3 hours ago"])
            .arg(dir.path().join("window.json.tmp123456"))
            .arg(dir.path().join("recent.json.tmpABC123"))
            .status()
            .expect("touch runs");
        assert!(old_output.success());
        assert_eq!(sweep_stale_config_temps(dir.path()), 2);
        assert!(dir.path().join("session.json.tmpAb1cD2").exists(), "fresh");
        assert!(dir.path().join("notes.tmp").exists(), "foreign name");
        assert!(
            dir.path().join("session.json.tmpZZ").exists(),
            "suffix shape"
        );
        assert!(
            !dir.path().join("window.json.tmp123456").exists(),
            "old owned"
        );
        assert!(
            !dir.path().join("recent.json.tmpABC123").exists(),
            "old owned"
        );
    }

    #[test]
    fn the_config_sweep_survives_a_missing_directory() {
        assert_eq!(
            sweep_stale_config_temps(std::path::Path::new("/nonexistent/guit-x")),
            0
        );
    }
}
