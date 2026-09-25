//! M5-06 end-to-end for the askpass bridge's *client* half.
//!
//! The unit tests in `src/askpass.rs` exercise the server half in-process;
//! the client half only exists inside `main()`'s launch interception, and
//! the bin crate has no lib target, so nothing but an integration test
//! that runs the real binary can prove the interception works. These
//! tests spawn `env!("CARGO_BIN_EXE_guit")` exactly the way Git 2.53
//! spawns `GIT_ASKPASS` (measured in prompt.c: argv `{program, prompt}`),
//! against an in-test Unix socket pretending to be the bridge, and drive
//! one real `git ls-remote` over a loopback 401 server so the sentinels
//! must travel Git → helper → socket → HTTP `Authorization` header.
//! Everything stays on 127.0.0.1 with fake tokens: no real network and no
//! real credentials are involved.

#![cfg(unix)]

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::os::unix::net::UnixListener;
use std::path::Path;
use std::process::{Command, Output};
use std::sync::mpsc::{self, TryRecvError};
use std::thread;
use std::time::{Duration, Instant};

const USER: &str = "guit-e2e-user";
const PASSWORD: &str = "s3ntinel-pass";
const TOKEN: &str = "e2e-one-time-token";
const DEADLINE: Duration = Duration::from_secs(20);

fn base64(data: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in data.chunks(3) {
        let pad = |index: usize| chunk.get(index).copied().unwrap_or(0);
        let n = ((chunk[0] as u32) << 16) | ((pad(1) as u32) << 8) | pad(2) as u32;
        out.push(TABLE[((n >> 18) & 63) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            TABLE[((n >> 6) & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}

/// The answer a bridge would give for this prompt shape.
fn answer_for(prompt: &str) -> Option<&'static str> {
    if prompt.starts_with("Username for ") {
        Some(USER)
    } else if prompt.starts_with("Password for ") {
        Some(PASSWORD)
    } else {
        None
    }
}

/// Stands in for the Rust bridge: speaks the wire protocol on a Unix
/// socket, serves up to `max` token-valid prompts and reports which ones
/// arrived. Polls with a deadline so no test can wedge.
fn serve_bridge_prompts(
    socket: &Path,
    max: usize,
) -> (thread::JoinHandle<Vec<String>>, mpsc::Sender<()>) {
    let listener = UnixListener::bind(socket).expect("bind fake bridge socket");
    listener
        .set_nonblocking(true)
        .expect("nonblocking fake bridge");
    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    let handle = thread::spawn(move || {
        let started = Instant::now();
        let mut prompts = Vec::new();
        while prompts.len() < max && started.elapsed() < DEADLINE {
            match listener.accept() {
                Ok((stream, _)) => {
                    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
                    let mut reader = BufReader::new(&stream);
                    let mut greeting = String::new();
                    let mut prompt = String::new();
                    if reader.read_line(&mut greeting).unwrap_or(0) == 0 {
                        continue;
                    }
                    if reader.read_line(&mut prompt).unwrap_or(0) == 0 {
                        continue;
                    }
                    greeting.trim_newlines();
                    prompt.trim_newlines();
                    if greeting != TOKEN {
                        continue;
                    }
                    if let Some(answer) = answer_for(&prompt) {
                        let mut writer = &stream;
                        let _ = writer
                            .write_all(answer.as_bytes())
                            .and_then(|()| writer.write_all(b"\n"))
                            .and_then(|()| writer.flush());
                    }
                    prompts.push(prompt);
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    match stop_rx.try_recv() {
                        Ok(()) | Err(TryRecvError::Disconnected) => break,
                        Err(TryRecvError::Empty) => thread::sleep(Duration::from_millis(5)),
                    }
                }
                Err(_) => break,
            }
        }
        prompts
    });
    (handle, stop_tx)
}

trait TrimNewlines {
    fn trim_newlines(&mut self);
}
impl TrimNewlines for String {
    fn trim_newlines(&mut self) {
        while self.ends_with('\n') || self.ends_with('\r') {
            self.pop();
        }
    }
}

/// Answers 401 until an `Authorization` header arrives, captures it, then
/// refuses with 403 so Git fails its own way; returns the captured header.
fn serve_401(listener: TcpListener) -> thread::JoinHandle<Option<String>> {
    thread::spawn(move || {
        let started = Instant::now();
        while started.elapsed() < DEADLINE {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
                    let mut buffer = [0u8; 8192];
                    let read = stream.read(&mut buffer).unwrap_or(0);
                    let request = String::from_utf8_lossy(&buffer[..read]).into_owned();
                    let header = request.lines().find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.trim()
                            .eq_ignore_ascii_case("authorization")
                            .then(|| value.trim().to_owned())
                    });
                    let response = match header {
                        Some(value) => {
                            let reply = "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
                            let _ = stream.write_all(reply.as_bytes());
                            let _ = stream.flush();
                            return Some(value);
                        }
                        None => {
                            "HTTP/1.1 401 Unauthorized\r\n\
                             WWW-Authenticate: Basic realm=\"guit-test\"\r\n\
                             Content-Length: 0\r\nConnection: close\r\n\r\n"
                        }
                    };
                    let _ = stream.write_all(response.as_bytes());
                    let _ = stream.flush();
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(5));
                }
                Err(_) => break,
            }
        }
        None
    })
}

fn wait_with_deadline(mut child: std::process::Child, label: &str) -> Output {
    let started = Instant::now();
    loop {
        if child.try_wait().expect("try_wait").is_some() {
            return child.wait_with_output().expect("collect output");
        }
        assert!(
            started.elapsed() < DEADLINE,
            "{label} outlived its deadline"
        );
        thread::sleep(Duration::from_millis(50));
    }
}

/// Launches the real guit binary in its helper role the way Git does.
fn launch_helper(args: &[&str], addr: Option<&Path>, token: Option<&str>) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_guit"));
    command
        .args(args)
        .env_remove("GUIT_ASKPASS_ADDR")
        .env_remove("GUIT_ASKPASS_TOKEN");
    if let Some(addr) = addr {
        command.env("GUIT_ASKPASS_ADDR", addr);
    }
    if let Some(token) = token {
        command.env("GUIT_ASKPASS_TOKEN", token);
    }
    let child = command
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .expect("launch helper");
    wait_with_deadline(child, "helper launch")
}

#[test]
fn the_flag_launch_without_a_bridge_refuses_fast() {
    let output = launch_helper(
        &["--guit-askpass", "Username for 'http://127.0.0.1:9': "],
        None,
        None,
    );
    assert!(!output.status.success(), "no bridge must mean a refusal");
    assert_eq!(output.stdout, b"", "a refusal must not print a credential");
}

#[test]
fn the_flag_launch_against_a_dead_address_refuses() {
    let output = launch_helper(
        &["--guit-askpass", "Username for 'http://127.0.0.1:9': "],
        Some(Path::new("/nonexistent-guit-e2e/bridge.sock")),
        Some(TOKEN),
    );
    assert!(!output.status.success(), "a dead bridge must not block");
}

#[test]
fn the_measured_git_spawn_shape_receives_the_answer_on_stdout() {
    // Measured (prompt.c): Git execs GIT_ASKPASS as argv {program, prompt}.
    // The same process must answer under both accepted launch shapes.
    let root = tempfile::tempdir().expect("temp dir");
    let socket = root.path().join("bridge.sock");
    let (server, _stop) = serve_bridge_prompts(&socket, 2);
    let flag = launch_helper(
        &["--guit-askpass", "Username for 'http://127.0.0.1:9': "],
        Some(&socket),
        Some(TOKEN),
    );
    assert!(flag.status.success(), "the flag shape must answer");
    assert_eq!(flag.stdout, format!("{USER}\n").into_bytes());
    let spawn = launch_helper(
        &["Password for 'http://guit-e2e-user@127.0.0.1:9': "],
        Some(&socket),
        Some(TOKEN),
    );
    assert!(spawn.status.success(), "the Git spawn shape must answer");
    assert_eq!(spawn.stdout, format!("{PASSWORD}\n").into_bytes());
    let prompts = server.join().expect("bridge thread");
    assert_eq!(prompts.len(), 2, "both prompts reached the bridge");
}

#[test]
fn a_wrong_token_exits_nonzero_and_reaches_no_answer() {
    let root = tempfile::tempdir().expect("temp dir");
    let socket = root.path().join("bridge.sock");
    let (server, stop) = serve_bridge_prompts(&socket, 1);
    let output = launch_helper(
        &["--guit-askpass", "Username for 'http://127.0.0.1:9': "],
        Some(&socket),
        Some("not-the-token"),
    );
    assert!(!output.status.success(), "a wrong token is a refusal");
    assert_eq!(output.stdout, b"");
    drop(stop); // the refused connection is all the server will ever see
    let prompts = server.join().expect("bridge thread");
    assert!(prompts.is_empty(), "a refused token must not even announce");
}

#[test]
fn a_real_git_http_fetch_pulls_both_credentials_through_the_helper() {
    let http = TcpListener::bind("127.0.0.1:0").expect("loopback port");
    let http_addr = http.local_addr().expect("local addr");
    http.set_nonblocking(true).expect("nonblocking http");
    let root = tempfile::tempdir().expect("temp dir");
    let socket = root.path().join("bridge.sock");
    let (bridge, _stop) = serve_bridge_prompts(&socket, 2);
    let server = serve_401(http);
    let output = Command::new("git")
        .args(["ls-remote", &format!("http://{http_addr}/repo.git")])
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/nonexistent-guit-test-config")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C")
        .env("GIT_ASKPASS", env!("CARGO_BIN_EXE_guit"))
        .env("GUIT_ASKPASS_ADDR", &socket)
        .env("GUIT_ASKPASS_TOKEN", TOKEN)
        .output()
        .expect("git runs");
    let authorization = server.join().expect("http thread");
    let prompts = bridge.join().expect("bridge thread");
    assert!(!output.status.success(), "the fake server never authorized");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        !stderr.contains(PASSWORD),
        "the password sentinel leaked into Git's own output: {stderr}"
    );
    assert_eq!(
        prompts,
        vec![
            format!("Username for 'http://{http_addr}': "),
            format!("Password for 'http://{USER}@{http_addr}': "),
        ],
        "Git's measured two-call credential dance, via the launched helper"
    );
    assert_eq!(
        authorization.as_deref(),
        Some(format!("Basic {}", base64(format!("{USER}:{PASSWORD}").as_bytes())).as_str()),
        "the sentinels must arrive exactly as Git would send the entered pair"
    );
}
