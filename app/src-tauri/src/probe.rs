use serde::Serialize;
use std::ffi::OsStr;
use std::path::Path;
use std::process::Command;
use std::sync::atomic::AtomicBool;
use std::time::Duration;

#[derive(Debug, Serialize)]
pub struct ProbeError {
    pub code: &'static str,
    pub message: String,
}

impl ProbeError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        let message = redact(&message.into());
        eprintln!("guit [{code}]: {message}");
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
pub struct GitProbe {
    pub available: bool,
    pub version: Option<String>,
    pub executable: Option<String>,
    pub supported: bool,
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

fn git_at(executable: &OsStr) -> Result<GitProbe, ProbeError> {
    let version_output = match Command::new(executable)
        .arg("--version")
        .current_dir(std::env::temp_dir())
        .output()
    {
        Ok(output) => output,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(GitProbe {
                available: false,
                version: None,
                executable: None,
                supported: false,
                message: "Git was not found. Install Git or add it to PATH.".into(),
            });
        }
        Err(error) => return Err(ProbeError::new("git_start_failed", error.to_string())),
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
    let supported = status_capability(executable)?;
    Ok(GitProbe {
        available: true,
        version: Some(version),
        executable: Some("git (PATH)".into()),
        supported,
        message: if supported {
            "M0 status command is available.".into()
        } else {
            "This Git cannot run the porcelain v2 status command required by guit. Update Git."
                .into()
        },
    })
}

fn status_capability(executable: &OsStr) -> Result<bool, ProbeError> {
    let directory = tempfile::Builder::new()
        .prefix("guit-probe-")
        .tempdir()
        .map_err(|error| ProbeError::new("temp_dir_failed", error.to_string()))?;
    let path = directory.path();
    let isolated = || isolated_git(executable, path);
    let init = isolated()
        .args(["init", "--quiet"])
        .output()
        .map_err(|error| ProbeError::new("git_init_failed", error.to_string()))?;
    if !init.status.success() {
        return Ok(false);
    }
    let status = isolated()
        .args(["status", "--porcelain=v2", "-z", "--branch"])
        .output()
        .map_err(|error| ProbeError::new("git_status_failed", error.to_string()))?;
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

fn configured_tool(key: &str) -> Result<Option<String>, ProbeError> {
    let output = Command::new("git")
        .args(["config", "--get", key])
        .current_dir(std::env::temp_dir())
        .output()
        .map_err(|error| ProbeError::new("git_config_failed", error.to_string()))?;
    if output.status.code() == Some(1) {
        return Ok(None);
    }
    if !output.status.success() {
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
        Err(error) if error.code == "process_cancelled" => {
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
        let mut command = Command::new(executable);
        command.current_dir(directory.path());
        let started = std::time::Instant::now();
        let result = crate::runner::run(
            command,
            &AtomicBool::new(false),
            Duration::ZERO,
            Duration::from_millis(100),
            |_, _| {},
        );
        assert!(matches!(result, Err(error) if error.code == "probe_timeout"));
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
        let result = git_at(executable.as_os_str()).unwrap();
        assert!(result.available);
        assert!(!result.supported);
        assert!(result.message.contains("Update Git"));
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
    }

    #[test]
    fn process_probe_can_be_cancelled() {
        let cancelled = AtomicBool::new(true);
        assert!(process(&cancelled).unwrap().contains("cancelled"));
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
        assert_eq!(result.unwrap_err().code, "probe_timeout");
    }
}
