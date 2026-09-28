use serde::Serialize;
use std::ffi::OsStr;
use std::fmt;
use std::path::Path;
use std::process::Command;
use std::sync::atomic::AtomicBool;
use std::time::Duration;

/// A machine-readable error code. It is a string on the wire, in the log and
/// in the diagnostics ring, and a typed value in the code: a small set of
/// named constants for the codes that actually drive a decision, so those
/// decision points cannot drift or misspell. Codes that are only ever
/// displayed keep passing a plain string, which becomes a `Code` through
/// `From` and is byte-for-byte what it always was.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(transparent)]
pub struct Code(&'static str);

impl Code {
    /// The cancellation code the runner raises when a write is cancelled.
    /// Every cancellation gate in the write lane matches on this constant.
    pub const PROCESS_CANCELLED: Code = Code("process_cancelled");
    pub const PROBE_TIMEOUT: Code = Code("probe_timeout");
    pub const GIT_NOT_FOUND: Code = Code("git_not_found");
    pub const TOOL_NOT_FOUND: Code = Code("tool_not_found");
    pub const BRANCH_NAME_INVALID: Code = Code("branch_name_invalid");
    pub const TAG_NAME_INVALID: Code = Code("tag_name_invalid");
    /// The three refusals that mean "this is not an openable repository".
    /// Session recovery treats them as "clear and start over" rather than as
    /// an error the user must dismiss.
    pub const REPO_PATH_MISSING: Code = Code("repo_path_missing");
    pub const NOT_A_REPOSITORY: Code = Code("not_a_repository");
    pub const REPO_WORKTREE_MISSING: Code = Code("repo_worktree_missing");

    /// The code as it appears in logs, diagnostics and the wire.
    pub const fn as_str(&self) -> &'static str {
        self.0
    }
}

impl From<&'static str> for Code {
    fn from(code: &'static str) -> Self {
        Code(code)
    }
}

impl fmt::Display for Code {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.0)
    }
}

#[derive(Debug, Serialize)]
pub struct ProbeError {
    pub code: Code,
    pub message: String,
}

impl ProbeError {
    pub fn new(code: impl Into<Code>, message: impl Into<String>) -> Self {
        let code = code.into();
        let message = redact(&message.into());
        eprintln!("guit [{code}]: {message}");
        crate::diagnostics::error(code.as_str(), &message);
        Self { code, message }
    }
}

pub(crate) fn redact(message: &str) -> String {
    message
        .split_inclusive(char::is_whitespace)
        .map(|word| {
            let Some(scheme) = word.find("://") else {
                return word.to_owned();
            };
            let authority_start = scheme + 3;
            let authority_end = word[authority_start..]
                .find(['/', '?', '#'])
                .map_or(word.len(), |offset| authority_start + offset);
            let mut sanitized = word.to_owned();
            if let Some(offset) = word[authority_start..authority_end].rfind('@') {
                sanitized.replace_range(authority_start..authority_start + offset, "[redacted]");
            }
            if let Some(query) = sanitized.find(['?', '#']) {
                let whitespace = sanitized.trim_end().len();
                sanitized.replace_range(query..whitespace, "?[redacted]");
            }
            sanitized
        })
        .collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitProbe {
    pub available: bool,
    pub version: Option<String>,
    pub executable: Option<String>,
    pub supported: bool,
    /// `git restore` arrived in 2.23; unstage and discard depend on it.
    pub has_restore: bool,
    pub message: String,
}

#[derive(Serialize)]
pub struct ToolProbe {
    pub difftool: Option<String>,
    pub mergetool: Option<String>,
    pub opener: &'static str,
}

pub fn git() -> Result<GitProbe, ProbeError> {
    git_at(OsStr::new("git"))
}

/// How long a Git is given to answer a probe. A `git` that cannot do this —
/// a stalled network home, a wrapper script waiting on something — must
/// report itself, not freeze the view that asked.
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

/// One bounded, isolated Git command: argv only, the user's `GIT_*`
/// environment removed, running in `directory` with no stdin to wait on.
fn run_bounded(
    executable: &OsStr,
    directory: &Path,
    args: &[&str],
    timeout: Duration,
) -> Result<crate::runner::CapturedOutput, ProbeError> {
    let mut command = isolated_git(executable, directory);
    command.args(args);
    crate::runner::run(
        command,
        &AtomicBool::new(false),
        Duration::ZERO,
        timeout,
        |_, _| {},
    )
}

fn git_at(executable: &OsStr) -> Result<GitProbe, ProbeError> {
    git_at_within(executable, PROBE_TIMEOUT)
}

fn git_at_within(executable: &OsStr, timeout: Duration) -> Result<GitProbe, ProbeError> {
    let version_output =
        match run_bounded(executable, &std::env::temp_dir(), &["--version"], timeout) {
            Ok(output) => output,
            // Either spelling of "this program is not on PATH" means the same
            // thing for a probe: the Git we were asked about is not installed.
            Err(error) if matches!(error.code, Code::GIT_NOT_FOUND | Code::TOOL_NOT_FOUND) => {
                return Ok(GitProbe {
                    available: false,
                    version: None,
                    executable: None,
                    supported: false,
                    has_restore: false,
                    message: "Git was not found. Install Git or add it to PATH.".into(),
                });
            }
            Err(error) if error.code == Code::PROBE_TIMEOUT => {
                return Err(ProbeError::new(
                    "git_unresponsive",
                    format!(
                        "Git did not answer within {} seconds. Check that `git` starts on its own.",
                        timeout.as_secs_f64()
                    ),
                ))
            }
            Err(error) => return Err(error),
        };
    if !version_output.status.success() {
        return Err(ProbeError::new(
            "git_version_failed",
            "Git started but could not report its version.",
        ));
    }
    let version = String::from_utf8_lossy(&version_output.stdout)
        .trim()
        .to_owned();
    let supported = status_capability(executable, timeout)?;
    Ok(GitProbe {
        available: true,
        has_restore: version_at_least(&version, (2, 23)),
        version: Some(version),
        executable: Some("git (PATH)".into()),
        supported,
        message: if supported {
            "All the Git commands guit needs are available.".into()
        } else {
            "This Git cannot report the state of a repository the way guit needs. \
             Install a newer Git."
                .into()
        },
    })
}

/// Capability gate for subcommands added after the porcelain-v2 baseline.
/// Old Git reports unknown subcommands with exit 1 and new Git uses exit 129
/// for usage errors, which is too close to tell apart; the advertised version
/// is the reliable signal. Unparseable versions are treated as unsupported.
pub(crate) fn version_at_least(version: &str, minimum: (u32, u32)) -> bool {
    let Some(core) = version
        .split_whitespace()
        .find(|token| token.chars().next().is_some_and(|c| c.is_ascii_digit()))
    else {
        return false;
    };
    let mut parts = core.split('.');
    let major = parts.next().unwrap_or("0").parse().unwrap_or(0);
    let minor = parts.next().unwrap_or("0").parse().unwrap_or(0);
    (major, minor) >= minimum
}

fn status_capability(executable: &OsStr, timeout: Duration) -> Result<bool, ProbeError> {
    let directory = tempfile::Builder::new()
        .prefix("guit-probe-")
        .tempdir()
        .map_err(|error| ProbeError::new("temp_dir_failed", error.to_string()))?;
    let path = directory.path();
    let init = run_bounded(executable, path, &["init", "--quiet"], timeout);
    match init {
        Ok(output) if output.status.success() => {}
        // A Git that starts for `--version` and then fails to initialise a
        // repository is simply too old, which the guidance below says.
        Ok(_) => return Ok(false),
        Err(error) if error.code == Code::PROBE_TIMEOUT => return Ok(false),
        Err(error) => return Err(error),
    }
    let status = run_bounded(
        executable,
        path,
        &["status", "--porcelain=v2", "-z", "--branch"],
        timeout,
    )?;
    Ok(status.status.success() && status.stdout.starts_with(b"# branch.oid "))
}

fn isolated_git(executable: &OsStr, path: &Path) -> Command {
    let mut command = Command::new(executable);
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("GIT_") {
            command.env_remove(key);
        }
    }
    command
        .current_dir(path)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", path.join("isolated-global-config"))
        .env("GIT_TERMINAL_PROMPT", "0");
    command
}

pub fn transfer(mut progress: impl FnMut(usize)) -> Result<String, ProbeError> {
    let directory = tempfile::Builder::new()
        .prefix("guit-transfer-")
        .tempdir()
        .map_err(|error| ProbeError::new("temp_dir_failed", error.to_string()))?;
    let cancelled = AtomicBool::new(false);
    let mut execute = |args: &[&str]| -> Result<crate::runner::CapturedOutput, ProbeError> {
        let mut command = isolated_git(OsStr::new("git"), directory.path());
        command.args(args);
        let output = crate::runner::run(
            command,
            &cancelled,
            Duration::ZERO,
            Duration::from_secs(10),
            |is_stderr: bool, bytes| {
                if is_stderr {
                    progress(bytes.len());
                }
            },
        )?;
        if !output.status.success() || output.truncated {
            return Err(ProbeError::new(
                "transfer_probe_failed",
                String::from_utf8_lossy(&output.stderr),
            ));
        }
        Ok(output)
    };
    execute(&["init", "--quiet", "source"])?;
    execute(&[
        "-C",
        "source",
        "-c",
        "user.name=guit probe",
        "-c",
        "user.email=probe@example.invalid",
        "commit",
        "--quiet",
        "--allow-empty",
        "-m",
        "probe",
    ])?;
    let output = execute(&[
        "clone",
        "--progress",
        "--no-local",
        "--",
        "source",
        "destination",
    ])?;
    let status = execute(&["-C", "destination", "status", "--porcelain=v2", "-z"])?;
    if !status.stdout.is_empty() {
        return Err(ProbeError::new(
            "transfer_probe_failed",
            "The disposable clone has unexpected changes.",
        ));
    }
    Ok(format!(
        "Local clone completed; {} stderr bytes streamed; actual Git status is clean.",
        output.stderr.len()
    ))
}

/// Reads one user-configured tool name. This one deliberately keeps the
/// environment untouched: it is reporting the tools the user chose, so it must
/// read their real configuration — but it is still bounded, because a `git`
/// that hangs here would otherwise hang the settings view.
fn configured_tool(key: &str) -> Result<Option<String>, ProbeError> {
    let mut command = Command::new("git");
    command
        .args(["config", "--get", key])
        .current_dir(std::env::temp_dir());
    let output = crate::runner::run(
        command,
        &AtomicBool::new(false),
        Duration::ZERO,
        PROBE_TIMEOUT,
        |_, _| {},
    )?;
    if output.status.code() == Some(1) {
        return Ok(None);
    }
    if !output.status.success() || output.truncated {
        return Err(ProbeError::new(
            "git_config_failed",
            String::from_utf8_lossy(&output.stderr),
        ));
    }
    let value = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    Ok((!value.is_empty()).then_some(value))
}

pub fn external_tools() -> Result<ToolProbe, ProbeError> {
    let opener = if cfg!(target_os = "windows") {
        "Windows file association"
    } else if cfg!(target_os = "macos") {
        "macOS open"
    } else {
        "xdg-open (requires verification)"
    };
    Ok(ToolProbe {
        difftool: configured_tool("diff.tool")?,
        mergetool: configured_tool("merge.tool")?,
        opener,
    })
}

pub fn process(cancelled: &AtomicBool) -> Result<String, ProbeError> {
    process_with_deadlines(cancelled, Duration::from_secs(3), Duration::from_secs(5))
}

fn process_with_deadlines(
    cancelled: &AtomicBool,
    completion_after: Duration,
    timeout_after: Duration,
) -> Result<String, ProbeError> {
    let mut command = Command::new("git");
    command
        .args(["hash-object", "--stdin"])
        .current_dir(std::env::temp_dir());
    let output = match crate::runner::run(
        command,
        cancelled,
        completion_after,
        timeout_after,
        |_, _| {},
    ) {
        Err(error) if error.code == Code::PROCESS_CANCELLED => {
            return Ok("Git process cancelled and reaped.".into())
        }
        result => result?,
    };
    if !output.status.success() || output.truncated {
        return Err(ProbeError::new(
            "probe_exit_failed",
            String::from_utf8_lossy(&output.stderr),
        ));
    }
    let hash = String::from_utf8(output.stdout)
        .map_err(|error| ProbeError::new("probe_output_invalid", error.to_string()))?;
    let hash = hash.trim();
    if !matches!(hash.len(), 40 | 64) || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(ProbeError::new(
            "probe_output_invalid",
            "Git returned an invalid object ID.",
        ));
    }
    Ok("Git process completed and stdout was read.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Runs a stand-in executable this test has just written.
    ///
    /// `git_at` execs the path it is handed, and these fixtures write a script
    /// moments earlier. `Command::current_dir` makes the standard library fork
    /// rather than posix_spawn, so with the whole test binary running in
    /// parallel the child can reach `execve` while the freshly written inode
    /// still carries a write path, and Linux answers ETXTBSY ("Text file
    /// busy"). Observed roughly once in ten full-suite runs, never when the
    /// test runs alone.
    ///
    /// The tolerance lives here and not in `git_at` on purpose: guit execs the
    /// user's `git`, which it never wrote, so a retry in product code would
    /// only hide a genuine "text busy" for a real executable. Retrying a spawn
    /// that never happened cannot mask anything either — a fixture that really
    /// fails to start still fails once the attempts run out.
    fn retry_transient_spawn<T, E>(mut attempt_once: impl FnMut() -> Result<T, E>) -> Result<T, E> {
        const ATTEMPTS: usize = 5;
        let mut attempt = 0;
        loop {
            match attempt_once() {
                Ok(value) => return Ok(value),
                Err(_) if attempt + 1 < ATTEMPTS => {
                    std::thread::sleep(Duration::from_millis(20 * (attempt as u64 + 1)));
                    attempt += 1;
                }
                Err(error) => return Err(error),
            }
        }
    }

    fn git_at_freshly_written(executable: &OsStr) -> Result<GitProbe, ProbeError> {
        // Any failure to spawn is retried, which is only ever a spawn that did
        // not happen: once the script runs, `git_at` reports a misbehaving one
        // as `git_version_failed` or `git_unresponsive`, so a real problem
        // still fails the test.
        retry_transient_spawn(|| git_at(executable))
    }

    #[test]
    fn output_is_drained_and_bounded_for_large_git_output() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join("empty"), b"").unwrap();
        std::fs::write(
            directory.path().join("large"),
            "changed line\n".repeat(20000),
        )
        .unwrap();
        let mut command = isolated_git(OsStr::new("git"), directory.path());
        command.args(["diff", "--no-index", "--", "empty", "large"]);
        let result = crate::runner::run(
            command,
            &AtomicBool::new(false),
            Duration::ZERO,
            Duration::from_secs(5),
            |_, _| {},
        )
        .unwrap();
        assert_eq!(result.status.code(), Some(1));
        assert!(result.truncated);
        assert_eq!(result.stdout.len(), 64 * 1024);
    }

    #[test]
    fn cancellation_interrupts_an_already_running_process() {
        let cancelled = std::sync::Arc::new(AtomicBool::new(false));
        let signal = cancelled.clone();
        let trigger = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            signal.store(true, std::sync::atomic::Ordering::SeqCst);
        });
        let started = std::time::Instant::now();
        assert!(process(&cancelled).unwrap().contains("cancelled"));
        trigger.join().unwrap();
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[cfg(unix)]
    #[test]
    fn timeout_terminates_descendants_holding_output_pipes() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let executable = directory.path().join("process-tree");
        std::fs::write(&executable, b"#!/bin/sh\nsleep 30 &\nwait\n").unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        let started = std::time::Instant::now();
        // Same write-then-exec shape as `git_at_freshly_written`, and the same
        // tolerance: a spawn that never happened is not the outcome under test,
        // and a script that really fails to start still fails every attempt.
        let result = retry_transient_spawn(|| {
            let mut command = Command::new(&executable);
            command.current_dir(directory.path());
            crate::runner::run(
                command,
                &AtomicBool::new(false),
                Duration::ZERO,
                Duration::from_millis(100),
                |_, _| {},
            )
        });
        assert!(matches!(result, Err(error) if error.code == Code::PROBE_TIMEOUT));
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[cfg(unix)]
    #[test]
    fn unsupported_git_reports_update_guidance() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let executable = directory.path().join("old-git");
        std::fs::write(&executable, b"#!/bin/sh\nif [ \"$1\" = --version ]; then echo 'git version test-old'; exit 0; fi\nexit 129\n").unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        let result = git_at_freshly_written(executable.as_os_str()).unwrap();
        assert!(result.available);
        assert!(!result.supported);
        assert!(!result.has_restore);
        assert!(result.message.contains("newer Git"));
        assert!(result.message.contains("Install"));
        assert!(!carries_developer_label(&result.message));
    }

    /// A `git` that starts and then never answers must report itself as
    /// unresponsive instead of blocking the view that asked. The probe runs on
    /// its own thread with a bounded wait so that a regression to an unbounded
    /// `.output()` fails this test rather than hanging the whole suite.
    #[cfg(unix)]
    #[test]
    fn a_git_that_never_answers_reports_instead_of_hanging() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let executable = directory.path().join("silent-git");
        std::fs::write(&executable, b"#!/bin/sh\nsleep 30\n").unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut outcome = None;
            for attempt in 0..5 {
                match git_at_within(executable.as_os_str(), Duration::from_millis(200)) {
                    // The fixture was written moments ago; a spawn that never
                    // happened is not the outcome under test.
                    Err(error) if error.code.as_str() == "process_start_failed" => {
                        std::thread::sleep(Duration::from_millis(20 * (attempt + 1)));
                    }
                    answer => {
                        outcome = Some(answer.map(|_| ()).map_err(|error| error.code.as_str()))
                    }
                }
            }
            let _ = sender.send(outcome);
            drop(directory);
        });
        let answer = receiver
            .recv_timeout(Duration::from_secs(10))
            .expect("the probe reports on its own deadline")
            .expect("the probe reached a verdict");
        assert_eq!(
            answer.err(),
            Some("git_unresponsive"),
            "a hung git must report the fault, not a version"
        );
    }

    #[test]
    fn the_supported_probe_sentence_is_advice_a_user_can_act_on() {
        // Shown verbatim in the settings view, so it must name what is true
        // without leaking how the work was scheduled.
        let supported = git().unwrap();
        assert!(
            supported.message.contains("available"),
            "{}",
            supported.message
        );
        assert!(
            !carries_developer_label(&supported.message),
            "{}",
            supported.message
        );
    }

    /// A round label or a path into the deleted development plan belongs to
    /// the development log, not to a sentence shown in the user's settings.
    fn carries_developer_label(text: &str) -> bool {
        let bytes = text.as_bytes();
        bytes
            .windows(2)
            .any(|pair| pair[0] == b'M' && pair[1].is_ascii_digit())
            || text.contains("plan/")
            || text.contains("decision")
    }

    #[test]
    fn restore_capability_tracks_advertised_version() {
        assert!(version_at_least("git version 2.53.0", (2, 23)));
        assert!(version_at_least("git version 2.23.0", (2, 23)));
        assert!(version_at_least("git version 2.47.1.windows.2", (2, 23)));
        assert!(!version_at_least("git version 2.22.0", (2, 23)));
        assert!(!version_at_least("git version 1.9.5", (2, 23)));
        assert!(!version_at_least("git version test-old", (2, 23)));
        assert!(!version_at_least("", (2, 23)));
    }

    #[test]
    fn clone_progress_is_streamed_and_result_is_refreshed() {
        let bytes = std::sync::atomic::AtomicUsize::new(0);
        let result = transfer(|count| {
            bytes.fetch_add(count, std::sync::atomic::Ordering::SeqCst);
        })
        .unwrap();
        assert!(bytes.load(std::sync::atomic::Ordering::SeqCst) > 0);
        assert!(result.contains("actual Git status is clean"));
    }

    #[test]
    fn errors_redact_url_credentials_and_query_before_serialization() {
        let error = ProbeError::new(
            "test_error",
            "failed https://user:secret@example.com/repo?token=secret\ntry again",
        );
        assert_eq!(
            error.message,
            "failed https://[redacted]@example.com/repo?[redacted]\ntry again"
        );
        assert!(!serde_json::to_string(&error).unwrap().contains("secret"));
    }

    #[test]
    fn missing_git_is_reported() {
        let result = git_at(OsStr::new("guit-nonexistent-git-executable")).unwrap();
        assert!(!result.available);
        assert!(!result.supported);
    }

    #[test]
    fn installed_git_supports_status_probe() {
        let result = git().unwrap();
        assert!(result.available);
        assert!(result.supported);
        assert!(result.has_restore);
    }

    #[test]
    fn process_probe_can_be_cancelled() {
        let cancelled = AtomicBool::new(true);
        assert!(process(&cancelled).unwrap().contains("cancelled"));
    }

    /// A `Code` is a string on the wire, in the log and in the diagnostics
    /// ring. The constants exist so the decision points that match on them
    /// cannot misspell, but the *value* must stay the exact string the rest
    /// of the system (and every recorded diagnostic) already uses, so this
    /// pins both the constants' text and the transparent serialization.
    #[test]
    fn the_code_constants_serialize_to_their_exact_strings() {
        for (code, expected) in [
            (Code::PROCESS_CANCELLED, "process_cancelled"),
            (Code::PROBE_TIMEOUT, "probe_timeout"),
            (Code::GIT_NOT_FOUND, "git_not_found"),
            (Code::TOOL_NOT_FOUND, "tool_not_found"),
            (Code::BRANCH_NAME_INVALID, "branch_name_invalid"),
            (Code::TAG_NAME_INVALID, "tag_name_invalid"),
            (Code::REPO_PATH_MISSING, "repo_path_missing"),
            (Code::NOT_A_REPOSITORY, "not_a_repository"),
            (Code::REPO_WORKTREE_MISSING, "repo_worktree_missing"),
        ] {
            assert_eq!(code.as_str(), expected);
            assert_eq!(
                serde_json::to_string(&code).unwrap(),
                format!("\"{expected}\"")
            );
            assert_eq!(code.to_string(), expected);
        }
    }

    /// A code built from a plain string is the same value as the matching
    /// constant, so a display-only site and a matching site can never
    /// disagree about the spelling.
    #[test]
    fn a_plain_string_becomes_the_same_code_as_the_constant() {
        let error = ProbeError::new("process_cancelled", "cancelled by the test");
        assert_eq!(error.code, Code::PROCESS_CANCELLED);
        assert_eq!(
            serde_json::to_string(&error.code).unwrap(),
            "\"process_cancelled\""
        );
    }

    #[test]
    fn process_probe_reads_git_output() {
        let cancelled = AtomicBool::new(false);
        let result = process_with_deadlines(
            &cancelled,
            Duration::from_millis(10),
            Duration::from_secs(5),
        );
        assert!(result.unwrap().contains("stdout was read"));
    }

    #[test]
    fn process_probe_times_out() {
        let cancelled = AtomicBool::new(false);
        let result = process_with_deadlines(&cancelled, Duration::from_secs(3), Duration::ZERO);
        assert_eq!(result.unwrap_err().code.as_str(), "probe_timeout");
    }
}
