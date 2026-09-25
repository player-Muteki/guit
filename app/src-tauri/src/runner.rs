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
        .map_err(|error| ProbeError::new("process_start_failed", error.to_string()))?;
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
