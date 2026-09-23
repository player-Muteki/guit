use crate::probe::ProbeError;
use std::io::Read;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{sync_channel, SyncSender};
use std::thread;
use std::time::{Duration, Instant};

const OUTPUT_LIMIT: usize = 64 * 1024;

pub struct CapturedOutput {
    pub status: ExitStatus,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub truncated: bool,
}

enum Chunk {
    Data(bool, Vec<u8>),
    Error(String),
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

fn terminate(child: &mut Child) -> Result<(), ProbeError> {
    #[cfg(unix)]
    unsafe {
        libc::kill(-(child.id() as i32), libc::SIGKILL);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .current_dir(std::env::temp_dir())
            .creation_flags(0x08000000)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = child.kill();
    child
        .wait()
        .map(|_| ())
        .map_err(|error| ProbeError::new("process_reap_failed", error.to_string()))
}

pub fn run(
    mut command: Command,
    cancelled: &AtomicBool,
    close_stdin_after: Duration,
    timeout: Duration,
    progress: impl Fn(usize),
) -> Result<CapturedOutput, ProbeError> {
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
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| ProbeError::new("process_start_failed", error.to_string()))?;
    let mut stdin = child.stdin.take();
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    let (sender, receiver) = sync_channel(16);
    let stdout_sender = sender.clone();
    let stdout_reader = thread::spawn(move || drain(stdout, false, stdout_sender));
    let stderr_reader = thread::spawn(move || drain(stderr, true, sender));
    let started = Instant::now();
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut truncated = false;
    let mut status = None;
    let result = loop {
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
        match receiver.recv_timeout(Duration::from_millis(20)) {
            Ok(Chunk::Data(is_stderr, bytes)) => {
                if is_stderr {
                    progress(bytes.len());
                }
                let destination = if is_stderr { &mut stderr } else { &mut stdout };
                let remaining = OUTPUT_LIMIT.saturating_sub(destination.len());
                truncated |= bytes.len() > remaining;
                destination.extend_from_slice(&bytes[..bytes.len().min(remaining)]);
            }
            Ok(Chunk::Error(message)) => {
                break Err(ProbeError::new("process_read_failed", message))
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                if status.is_some() {
                    break Ok(());
                }
                thread::sleep(Duration::from_millis(20));
            }
            _ => {}
        }
        if status.is_none() {
            match child.try_wait() {
                Ok(value) => status = value,
                Err(error) => break Err(ProbeError::new("process_wait_failed", error.to_string())),
            }
        }
    };
    let cleanup = if result.is_err() {
        terminate(&mut child)
    } else {
        Ok(())
    };
    drop(receiver);
    let _ = stdout_reader.join();
    let _ = stderr_reader.join();
    cleanup?;
    result?;
    Ok(CapturedOutput {
        status: status.expect("completed child"),
        stdout,
        stderr,
        truncated,
    })
}
