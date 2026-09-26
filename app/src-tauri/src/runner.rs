use crate::perf;
use crate::probe::ProbeError;
use std::ffi::OsStr;
use std::io::Read;
use std::process::{Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{sync_channel, SyncSender};
use std::thread;
use std::time::{Duration, Instant};

pub const DEFAULT_OUTPUT_LIMIT: usize = 64 * 1024;
/// `status --porcelain=v2` for very large repositories can exceed the default
/// capture limit; parsing a truncated record would misreport the repository as
/// clean, so status reads use this larger bound instead.
pub const STATUS_OUTPUT_LIMIT: usize = 32 * 1024 * 1024;

pub struct CapturedOutput {
    pub status: ExitStatus,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub truncated: bool,
}

enum Chunk {
    Data(bool, Vec<u8>),
    Error(String),
    Exit(Result<ExitStatus, String>),
}

fn drain(mut pipe: impl Read, stderr: bool, sender: SyncSender<Chunk>) {
    let mut buffer = [0; 4096];
    loop {
        match pipe.read(&mut buffer) {
            Ok(0) => break,
            Ok(count) => {
                if sender
                    .send(Chunk::Data(stderr, buffer[..count].to_vec()))
                    .is_err()
                {
                    break;
                }
            }
            Err(error) => {
                let _ = sender.send(Chunk::Error(error.to_string()));
                break;
            }
        }
    }
}

/// Kills the whole process group by id; the reaper thread's blocking
/// `Child::wait` returns as soon as the group dies, so no caller ever waits
/// on the killed child directly.
fn terminate(pid: u32) {
    #[cfg(unix)]
    unsafe {
        libc::kill(-(pid as i32), libc::SIGKILL);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .current_dir(std::env::temp_dir())
            .creation_flags(0x08000000)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

pub fn run(
    command: Command,
    cancelled: &AtomicBool,
    close_stdin_after: Duration,
    timeout: Duration,
    progress: impl FnMut(bool, &[u8]),
) -> Result<CapturedOutput, ProbeError> {
    run_with_limit(
        command,
        cancelled,
        close_stdin_after,
        timeout,
        DEFAULT_OUTPUT_LIMIT,
        progress,
    )
}

pub fn run_with_limit(
    mut command: Command,
    cancelled: &AtomicBool,
    close_stdin_after: Duration,
    timeout: Duration,
    output_limit: usize,
    mut progress: impl FnMut(bool, &[u8]),
) -> Result<CapturedOutput, ProbeError> {
    let label = command_label(&command);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000200);
    }
    let launched = Instant::now();
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            // An unresolvable executable is the "not installed / not on
            // PATH" failure the user can actually act on, so it must not
            // hide behind the generic start failure (plan decision 10).
            // Git is named honestly; any other program is reported under
            // its own name so a missing external tool is not blamed on Git.
            if error.kind() == std::io::ErrorKind::NotFound {
                let program = std::path::Path::new(command.get_program())
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_else(|| command.get_program().to_string_lossy().into_owned());
                if program.starts_with("git") {
                    ProbeError::new(
                        "git_not_found",
                        "Git executable not found; install Git or fix your PATH.",
                    )
                } else {
                    ProbeError::new(
                        "tool_not_found",
                        format!("Executable '{program}' was not found; check PATH and tool configuration."),
                    )
                }
            } else {
                ProbeError::new("process_start_failed", error.to_string())
            }
        })?;
    let pid = child.id();
    let mut stdin = child.stdin.take();
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    let (sender, receiver) = sync_channel(16);
    let stdout_sender = sender.clone();
    let stderr_sender = sender.clone();
    let exit_sender = sender.clone();
    drop(sender);
    let stdout_reader = thread::spawn(move || drain(stdout, false, stdout_sender));
    let stderr_reader = thread::spawn(move || drain(stderr, true, stderr_sender));
    // A dedicated thread blocks on wait(): the exit status arrives as an
    // event, so the loop below never sleeps to discover a finished child.
    // On kill paths the group death unblocks it immediately.
    thread::spawn(move || {
        let status = child.wait().map_err(|error| error.to_string());
        let _ = exit_sender.send(Chunk::Exit(status));
    });
    let started = Instant::now();
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut truncated = false;
    let mut status = None;
    let mut pipes_closed = false;
    let result: Result<(), ProbeError> = loop {
        if cancelled.load(Ordering::SeqCst) {
            break Err(ProbeError::new(
                "process_cancelled",
                "Git process cancellation requested.",
            ));
        }
        if started.elapsed() >= timeout {
            break Err(ProbeError::new(
                "probe_timeout",
                "Git process exceeded its timeout.",
            ));
        }
        if started.elapsed() >= close_stdin_after {
            drop(stdin.take());
        }
        if pipes_closed && status.is_some() {
            break Ok(());
        }
        match receiver.recv_timeout(Duration::from_millis(20)) {
            Ok(Chunk::Data(is_stderr, bytes)) => {
                progress(is_stderr, &bytes);
                let destination = if is_stderr { &mut stderr } else { &mut stdout };
                let remaining = output_limit.saturating_sub(destination.len());
                truncated |= bytes.len() > remaining;
                destination.extend_from_slice(&bytes[..bytes.len().min(remaining)]);
            }
            Ok(Chunk::Error(message)) => {
                break Err(ProbeError::new("process_read_failed", message))
            }
            Ok(Chunk::Exit(value)) => match value {
                Ok(value) => status = Some(value),
                Err(message) => break Err(ProbeError::new("process_wait_failed", message)),
            },
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                pipes_closed = true;
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
        }
    };
    if result.is_err() {
        terminate(pid);
    }
    drop(receiver);
    let _ = stdout_reader.join();
    let _ = stderr_reader.join();
    perf::mark(&label, launched.elapsed());
    result?;
    Ok(CapturedOutput {
        status: status.expect("completed child"),
        stdout,
        stderr,
        truncated,
    })
}

/// Perf label for one process launch: program file name plus the leading
/// non-flag argument (the Git subcommand word). Never paths, flag values,
/// arguments beyond the subcommand, URLs or output.
fn command_label(command: &Command) -> String {
    fn word(value: &OsStr) -> String {
        value
            .to_string_lossy()
            .chars()
            .take(32)
            .filter(|c| c.is_alphanumeric() || matches!(c, '.' | '-' | '_'))
            .collect()
    }
    let program = std::path::Path::new(command.get_program())
        .file_name()
        .map(word)
        .unwrap_or_else(|| "?".to_string());
    let subcommand = command
        .get_args()
        .find(|arg| !arg.is_empty() && arg.as_encoded_bytes()[0] != b'-')
        .map(word)
        .unwrap_or_default();
    format!("{program}.{subcommand}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn missing(program: &str) -> ProbeError {
        let mut command = Command::new(program);
        command.current_dir(std::env::temp_dir());
        match run_with_limit(
            command,
            &AtomicBool::new(false),
            Duration::from_millis(50),
            Duration::from_secs(2),
            DEFAULT_OUTPUT_LIMIT,
            |_, _| {},
        ) {
            Err(error) => error,
            Ok(_) => panic!("a missing executable cannot start"),
        }
    }

    #[test]
    fn missing_executable_reports_as_git_not_found() {
        assert_eq!(missing("git-not-on-path-7e2b").code, "git_not_found");
    }

    #[test]
    fn a_missing_external_tool_is_not_blamed_on_git() {
        let error = missing("guit-definitely-not-on-path-9f3a");
        assert_eq!(error.code, "tool_not_found");
        assert!(error.message.contains("guit-definitely-not-on-path-9f3a"));
        assert!(!error.message.to_lowercase().contains("git executable"));
    }

    #[test]
    fn labels_keep_only_program_and_subcommand_words() {
        let mut command = Command::new("/usr/bin/git");
        command.args(["--git-dir=/secret/path", "status", "-uall"]);
        assert_eq!(command_label(&command), "git.status");
    }
}

#[cfg(all(test, unix))]
mod stress {
    use super::*;
    use std::sync::atomic::AtomicBool;

    fn sh(script: &str) -> Command {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", script]);
        command.current_dir(std::env::temp_dir());
        command
    }

    fn collect(
        command: Command,
        cancelled: &AtomicBool,
        close_stdin_after: Duration,
        timeout: Duration,
        output_limit: usize,
        progress: impl FnMut(bool, &[u8]),
    ) -> Result<CapturedOutput, ProbeError> {
        run_with_limit(
            command,
            cancelled,
            close_stdin_after,
            timeout,
            output_limit,
            progress,
        )
    }

    #[test]
    fn a_group_timeout_kills_grandchildren_that_hold_the_pipes_open() {
        // The child backgrounds a grandchild that keeps stdout open, then
        // exits itself. Without killing the process group the reader thread
        // would block on the pipe forever even though `sh` finished.
        let started = Instant::now();
        let outcome = collect(
            sh("sleep 30 >/dev/null & echo spawned; exit 0"),
            &AtomicBool::new(false),
            Duration::from_millis(50),
            Duration::from_millis(400),
            DEFAULT_OUTPUT_LIMIT,
            |_, _| {},
        );
        let error = match outcome {
            Err(error) => error,
            Ok(_) => panic!("the sleep outruns the timeout"),
        };
        assert_eq!(error.code, "probe_timeout");
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "killed, not waited out"
        );
    }

    #[test]
    fn cancelling_drops_the_result_and_kills_the_group() {
        let cancelled = std::sync::Arc::new(AtomicBool::new(false));
        let flag = std::sync::Arc::clone(&cancelled);
        let killer = thread::spawn(move || {
            thread::sleep(Duration::from_millis(150));
            flag.store(true, Ordering::SeqCst);
        });
        let outcome = collect(
            sh("sleep 30"),
            &cancelled,
            Duration::from_millis(50),
            Duration::from_secs(20),
            DEFAULT_OUTPUT_LIMIT,
            |_, _| {},
        );
        killer.join().unwrap();
        let error = match outcome {
            Err(error) => error,
            Ok(_) => panic!("cancellation must end the run"),
        };
        assert_eq!(error.code, "process_cancelled");
    }

    #[test]
    fn stdin_is_closed_so_a_filter_like_cat_completes() {
        // `cat` only exits when its stdin reaches EOF: the close_stdin_after
        // path is what stops every piped Git command from hanging.
        let output = collect(
            sh("cat"),
            &AtomicBool::new(false),
            Duration::from_millis(100),
            Duration::from_secs(5),
            DEFAULT_OUTPUT_LIMIT,
            |_, _| {},
        )
        .expect("cat exits once stdin closes");
        assert!(output.status.success());
        assert!(output.stdout.is_empty());
    }

    #[test]
    fn output_beyond_the_limit_is_cut_but_flagged_and_still_streamed_in_full() {
        let mut streamed = 0usize;
        let output = collect(
            sh("head -c 200000 /dev/zero"),
            &AtomicBool::new(false),
            Duration::from_millis(50),
            Duration::from_secs(10),
            1000,
            |_, bytes| streamed += bytes.len(),
        )
        .expect("command completes");
        assert_eq!(
            output.stdout.len(),
            1000,
            "capture stops exactly at the limit"
        );
        assert!(output.truncated, "and the reader is told");
        assert_eq!(
            streamed, 200000,
            "progress sees every byte, truncated or not"
        );
    }

    #[test]
    fn a_zero_limit_keeps_nothing_and_still_terminates_cleanly() {
        let output = collect(
            sh("printf abc"),
            &AtomicBool::new(false),
            Duration::from_millis(50),
            Duration::from_secs(5),
            0,
            |_, _| {},
        )
        .expect("a zero limit is a cap, not an error");
        assert!(output.stdout.is_empty());
        assert!(output.truncated);
        assert!(output.status.success());
    }

    #[test]
    fn exit_before_pipe_drain_still_captures_the_full_output() {
        // 40 KiB written and the process exiting immediately races the
        // 4 KiB pipe reads: the loop must keep draining after Chunk::Exit.
        let output = collect(
            sh("head -c 40000 /dev/zero | tr '\\0' 'x'"),
            &AtomicBool::new(false),
            Duration::from_millis(50),
            Duration::from_secs(10),
            DEFAULT_OUTPUT_LIMIT,
            |_, _| {},
        )
        .expect("fast exit");
        assert_eq!(output.stdout.len(), 40000);
        assert!(!output.truncated);
    }

    #[test]
    fn both_streams_are_tagged_for_progress_and_kept_apart() {
        let seen = std::sync::Mutex::new((0usize, 0usize));
        let output = collect(
            sh("printf out; printf err 1>&2"),
            &AtomicBool::new(false),
            Duration::from_millis(50),
            Duration::from_secs(5),
            DEFAULT_OUTPUT_LIMIT,
            |is_stderr, bytes| {
                let mut guard = seen.lock().unwrap();
                if is_stderr {
                    guard.1 += bytes.len()
                } else {
                    guard.0 += bytes.len()
                }
            },
        )
        .expect("both streams close");
        assert_eq!(output.stdout, b"out");
        assert_eq!(output.stderr, b"err");
        let (out, err) = *seen.lock().unwrap();
        assert_eq!((out, err), (3, 3));
    }

    #[test]
    fn a_failing_exit_status_is_reported_not_raised() {
        let output = collect(
            sh("printf done; exit 3"),
            &AtomicBool::new(false),
            Duration::from_millis(50),
            Duration::from_secs(5),
            DEFAULT_OUTPUT_LIMIT,
            |_, _| {},
        )
        .expect("non-zero exit is data");
        assert!(!output.status.success());
        assert_eq!(output.status.code(), Some(3));
        assert_eq!(output.stdout, b"done");
    }

    #[test]
    fn labels_survive_hostile_arguments() {
        let mut command = Command::new("/usr/bin/git");
        command.args(["", "-x"]);
        assert_eq!(command_label(&command), "git.", "no usable subcommand word");
        let mut command = Command::new("weird\x01name");
        command.arg("status");
        let label = command_label(&command);
        assert!(
            !label.contains('\u{1}'),
            "control bytes are filtered out: {label}"
        );
        let mut command = Command::new("/usr/bin/git");
        command.args(vec!["-"; 4000]);
        assert_eq!(
            command_label(&command),
            "git.",
            "4000 flags yield no subcommand"
        );
    }
}
