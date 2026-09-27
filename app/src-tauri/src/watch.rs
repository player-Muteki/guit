use crate::perf;
use crate::repo::RepoIdentity;
use crate::session::{self, SessionState};
use notify::Watcher;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

/// Quiet period after the last filesystem event before a refresh runs.
const DEBOUNCE: Duration = Duration::from_millis(250);
/// Interval between refreshes when no event stream is available.
const POLL_INTERVAL: Duration = Duration::from_secs(5);
/// Maximum blocking wait per loop turn so shutdown stays responsive.
const HEARTBEAT: Duration = Duration::from_millis(1000);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Watch,
    Poll,
}

impl Mode {
    /// The word the status bar and the diagnostics report both show. These
    /// two strings are the only evidence a user gets that filesystem events
    /// are not being watched, so they are part of the contract rather than
    /// a debug print.
    fn label(self) -> &'static str {
        match self {
            Mode::Watch => "watch",
            Mode::Poll => "poll",
        }
    }

    fn from_code(code: u8) -> Option<Mode> {
        match code {
            1 => Some(Mode::Watch),
            2 => Some(Mode::Poll),
            _ => None,
        }
    }

    fn code(self) -> u8 {
        match self {
            Mode::Watch => 1,
            Mode::Poll => 2,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LoopExit {
    Shutdown,
    SessionGone,
    Disconnected,
}

/// Event-driven (Watch) or interval-driven (Poll) refresh loop with burst
/// debouncing. Pure with respect to its inputs so tests can drive it through
/// an injected channel and short timers. `fire` returns false once the
/// session it refreshes is gone.
#[allow(clippy::too_many_arguments)]
fn run_loop(
    trigger: &Receiver<()>,
    shutdown: &AtomicBool,
    mode: Mode,
    debounce: Duration,
    poll_interval: Duration,
    heartbeat: Duration,
    fire: &mut dyn FnMut() -> bool,
) -> LoopExit {
    let tick = heartbeat.min(poll_interval).max(Duration::from_millis(1));
    let mut next_poll = Instant::now() + poll_interval;
    loop {
        if shutdown.load(Ordering::SeqCst) {
            return LoopExit::Shutdown;
        }
        match trigger.recv_timeout(tick) {
            Ok(()) if mode == Mode::Watch => {
                let mut deadline = Instant::now() + debounce;
                loop {
                    let now = Instant::now();
                    if now >= deadline {
                        break;
                    }
                    match trigger.recv_timeout(deadline - now) {
                        Ok(()) => deadline = Instant::now() + debounce,
                        Err(RecvTimeoutError::Timeout) => break,
                        Err(RecvTimeoutError::Disconnected) => return LoopExit::Disconnected,
                    }
                }
                if shutdown.load(Ordering::SeqCst) {
                    return LoopExit::Shutdown;
                }
                if !fire() {
                    return LoopExit::SessionGone;
                }
            }
            Err(RecvTimeoutError::Disconnected) => return LoopExit::Disconnected,
            // Watch heartbeat, poll tick, or an event while polling.
            _ => {
                if mode == Mode::Poll && Instant::now() >= next_poll {
                    if shutdown.load(Ordering::SeqCst) {
                        return LoopExit::Shutdown;
                    }
                    if !fire() {
                        return LoopExit::SessionGone;
                    }
                    next_poll = Instant::now() + poll_interval;
                }
            }
        }
    }
}

/// Directories holding state that can change the status snapshot: the work
/// tree plus the per-worktree and shared metadata directories. Canonicalized
/// and deduplicated, skipping anything that no longer exists.
fn watch_targets(identity: &RepoIdentity) -> Vec<PathBuf> {
    let mut targets: Vec<PathBuf> = Vec::new();
    for candidate in [
        identity.work_root.clone(),
        Some(identity.git_dir.clone()),
        Some(identity.common_dir.clone()),
    ]
    .into_iter()
    .flatten()
    {
        let Ok(resolved) = candidate.canonicalize() else {
            continue;
        };
        if resolved.is_dir() && !targets.contains(&resolved) {
            targets.push(resolved);
        }
    }
    targets
}

/// notify's inotify mask includes IN_ACCESS, and every Git read guit performs
/// (HEAD, config, refs, objects) touches files. Treating accesses as changes
/// makes the refresh loop feed itself forever; an access never changes any
/// Git state, so it is dropped. All other kinds still trigger a refresh.
fn refresh_worthy(event: &notify::Event) -> bool {
    !matches!(event.kind, notify::EventKind::Access(_))
}

fn start_watcher(
    targets: &[PathBuf],
    tx: Sender<()>,
) -> Result<notify::RecommendedWatcher, notify::Error> {
    let events_tx = tx;
    let mut watcher =
        notify::recommended_watcher(move |result: Result<notify::Event, notify::Error>| {
            if let Ok(event) = result {
                if refresh_worthy(&event) {
                    let _ = events_tx.send(());
                }
            }
        })?;
    for target in targets {
        watcher.watch(target, notify::RecursiveMode::Recursive)?;
    }
    Ok(watcher)
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct WatchStatus {
    mode: &'static str,
    failed: bool,
}

/// Holds the shutdown flag of the one supervisor thread per application run.
/// An outgoing supervisor is never joined: it self-exits within a heartbeat,
/// and any overlap is absorbed by the session refresh gate.
#[derive(Default)]
pub struct WatchState {
    current: Mutex<Option<Arc<AtomicBool>>>,
}

/// 0 = no supervisor has announced a mode, 1 = watch, 2 = poll. Read by the
/// diagnostics exporter, which has no access to emitted events.
static LAST_MODE: std::sync::atomic::AtomicU8 = std::sync::atomic::AtomicU8::new(0);

pub(crate) fn last_mode() -> &'static str {
    match Mode::from_code(LAST_MODE.load(Ordering::Relaxed)) {
        Some(mode) => mode.label(),
        None => "none",
    }
}

/// Whether a created watcher will actually deliver events, or whether the
/// loop has to fall back to polling.
///
/// This is the honest-degradation decision the documentation promises, so it
/// is a function of the watcher's own result rather than something inlined
/// into the supervisor: the branch that decides "this user is not being
/// watched" is the one branch in this module that needs a test, and it can
/// only be tested if it is reachable without an application handle and a
/// background thread.
fn choose_mode(watcher: &Result<notify::RecommendedWatcher, notify::Error>) -> Mode {
    match watcher {
        Ok(_) => Mode::Watch,
        Err(error) => {
            eprintln!("guit [watch]: filesystem events unavailable ({error}); polling instead");
            Mode::Poll
        }
    }
}

fn supervisor(app: tauri::AppHandle, identity: RepoIdentity, shutdown: Arc<AtomicBool>) {
    let (tx, rx) = mpsc::channel();
    // Keeps the trigger channel open even when no watcher was created, so
    // poll mode times out instead of seeing a disconnect.
    let _poll_channel_keeper = tx.clone();
    let watcher = start_watcher(&watch_targets(&identity), tx);
    let mode = choose_mode(&watcher);
    let _ = app.emit(
        "watch-status",
        WatchStatus {
            mode: mode.label(),
            failed: false,
        },
    );
    LAST_MODE.store(mode.code(), Ordering::Relaxed);
    let emitter = app.clone();
    let mut refresh_failed = false;
    run_loop(
        &rx,
        &shutdown,
        mode,
        DEBOUNCE,
        POLL_INTERVAL,
        HEARTBEAT,
        &mut || {
            let started = Instant::now();
            let outcome = session::refresh(&emitter.state::<SessionState>());
            perf::mark("watch.refresh", started.elapsed());
            if shutdown.load(Ordering::SeqCst) {
                return false;
            }
            match outcome {
                Ok(Some(snapshot)) => {
                    let _ = emitter.emit("repo-refreshed", snapshot);
                    if refresh_failed {
                        refresh_failed = false;
                        let _ = emitter.emit(
                            "watch-status",
                            WatchStatus {
                                mode: mode.label(),
                                failed: false,
                            },
                        );
                    }
                    true
                }
                Ok(None) => false,
                Err(error) => {
                    eprintln!("guit [{}]: watcher refresh failed", error.code);
                    refresh_failed = true;
                    let _ = emitter.emit(
                        "watch-status",
                        WatchStatus {
                            mode: mode.label(),
                            failed: true,
                        },
                    );
                    true
                }
            }
        },
    );
}

/// Replaces the supervisor for the currently open session, if any.
pub fn restart(app: &tauri::AppHandle) {
    let state = app.state::<WatchState>();
    let shutdown = Arc::new(AtomicBool::new(false));
    let previous = crate::util::guard(&state.current).replace(shutdown.clone());
    if let Some(previous) = previous {
        previous.store(true, Ordering::SeqCst);
    }
    let Some(identity) = app.state::<SessionState>().current_identity() else {
        return;
    };
    let handle = app.clone();
    let thread_shutdown = shutdown.clone();
    if std::thread::Builder::new()
        .name("guit-watch".to_owned())
        .spawn(move || supervisor(handle, identity, thread_shutdown))
        .is_err()
    {
        crate::util::guard(&state.current).take();
    }
}

/// Stops the supervisor and tells the frontend to clear its status line.
pub fn stop(app: &tauri::AppHandle) {
    LAST_MODE.store(0, Ordering::Relaxed);
    let state = app.state::<WatchState>();
    if let Some(previous) = crate::util::guard(&state.current).take() {
        previous.store(true, Ordering::SeqCst);
    }
    let _ = app.emit(
        "watch-status",
        WatchStatus {
            mode: "none",
            failed: false,
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use std::sync::atomic::AtomicUsize;

    fn identity_for(dir: &Path) -> RepoIdentity {
        RepoIdentity {
            candidate: dir.to_path_buf(),
            work_root: Some(dir.to_path_buf()),
            git_dir: dir.join(".git"),
            common_dir: dir.join(".git"),
            is_bare: false,
            linked_worktree: false,
        }
    }

    #[test]
    fn watch_events_debounce_into_a_single_fire() {
        let (tx, rx) = mpsc::channel();
        let shutdown = Arc::new(AtomicBool::new(false));
        let fired = Arc::new(AtomicUsize::new(0));
        let thread_shutdown = shutdown.clone();
        let thread_fired = fired.clone();
        let worker = std::thread::spawn(move || {
            run_loop(
                &rx,
                &thread_shutdown,
                Mode::Watch,
                Duration::from_millis(80),
                Duration::from_secs(60),
                Duration::from_millis(20),
                &mut || {
                    thread_fired.fetch_add(1, Ordering::SeqCst);
                    true
                },
            )
        });
        for _ in 0..5 {
            tx.send(()).unwrap();
            std::thread::sleep(Duration::from_millis(20));
        }
        std::thread::sleep(Duration::from_millis(300));
        shutdown.store(true, Ordering::SeqCst);
        assert_eq!(worker.join().unwrap(), LoopExit::Shutdown);
        assert_eq!(fired.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn poll_mode_fires_without_any_events() {
        let (_tx, rx) = mpsc::channel();
        let shutdown = Arc::new(AtomicBool::new(false));
        let fired = Arc::new(AtomicUsize::new(0));
        let thread_shutdown = shutdown.clone();
        let thread_fired = fired.clone();
        let worker = std::thread::spawn(move || {
            run_loop(
                &rx,
                &thread_shutdown,
                Mode::Poll,
                Duration::from_millis(80),
                Duration::from_millis(60),
                Duration::from_millis(20),
                &mut || {
                    thread_fired.fetch_add(1, Ordering::SeqCst);
                    true
                },
            )
        });
        std::thread::sleep(Duration::from_millis(250));
        shutdown.store(true, Ordering::SeqCst);
        assert_eq!(worker.join().unwrap(), LoopExit::Shutdown);
        assert!(fired.load(Ordering::SeqCst) >= 2);
    }

    #[test]
    fn gone_session_stops_the_loop() {
        let (_tx, rx) = mpsc::channel();
        let shutdown = AtomicBool::new(false);
        let exit = run_loop(
            &rx,
            &shutdown,
            Mode::Poll,
            Duration::from_millis(10),
            Duration::from_millis(30),
            Duration::from_millis(10),
            &mut || false,
        );
        assert_eq!(exit, LoopExit::SessionGone);
    }

    #[test]
    fn shutdown_before_first_fire_runs_nothing() {
        let (_tx, rx) = mpsc::channel();
        let shutdown = AtomicBool::new(true);
        let fired = AtomicUsize::new(0);
        let exit = run_loop(
            &rx,
            &shutdown,
            Mode::Poll,
            Duration::from_millis(10),
            Duration::from_millis(30),
            Duration::from_millis(10),
            &mut || {
                fired.fetch_add(1, Ordering::SeqCst);
                true
            },
        );
        assert_eq!(exit, LoopExit::Shutdown);
        assert_eq!(fired.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn access_events_do_not_trigger_a_refresh() {
        let access = notify::Event::new(notify::EventKind::Access(notify::event::AccessKind::Read))
            .add_path(PathBuf::from("/repo/.git/HEAD"));
        assert!(!refresh_worthy(&access));
        let modify = notify::Event::new(notify::EventKind::Modify(
            notify::event::ModifyKind::Data(notify::event::DataChange::Content),
        ))
        .add_path(PathBuf::from("/repo/.git/index"));
        assert!(refresh_worthy(&modify));
        let remove = notify::Event::new(notify::EventKind::Remove(notify::event::RemoveKind::File))
            .add_path(PathBuf::from("/repo/notes.txt"));
        assert!(refresh_worthy(&remove));
    }

    #[test]
    fn watch_targets_dedupe_and_skip_missing() {
        let directory = tempfile::tempdir().unwrap();
        let targets = watch_targets(&identity_for(directory.path()));
        assert_eq!(targets, vec![directory.path().canonicalize().unwrap()]);
        let missing = watch_targets(&identity_for(Path::new("/nonexistent/guit-test")));
        assert!(missing.is_empty());
    }

    #[test]
    fn watcher_delivers_real_filesystem_events() {
        let directory = tempfile::tempdir().unwrap();
        let (tx, rx) = mpsc::channel();
        let watcher = start_watcher(&[directory.path().to_path_buf()], tx.clone()).unwrap();
        std::fs::write(directory.path().join("tracked.txt"), b"x").unwrap();
        assert!(rx.recv_timeout(Duration::from_secs(10)).is_ok());
        drop(watcher);
    }

    /// The promise in the known-limitations record is that a repository whose
    /// inotify watches are exhausted keeps working on a five-second poll
    /// rather than going quiet. That promise lives entirely in this branch:
    /// a watcher that exists but cannot be told to watch anything must become
    /// `Poll`, and the mode the user is shown must say so.
    #[test]
    fn a_watcher_that_cannot_watch_falls_back_to_polling() {
        // Asking notify to watch a path that does not exist is the portable
        // way to get the failure real backends produce when the watch limit
        // is spent; the branch under test is the same one either way. The
        // receiver is kept alive: dropping it would disconnect the channel
        // the watcher's callback writes to, which is a different failure.
        let (tx, _rx) = mpsc::channel();
        let failed = start_watcher(&[PathBuf::from("/nonexistent/guit-watch-target")], tx);
        assert!(failed.is_err(), "the fixture must fail to start watching");
        assert_eq!(choose_mode(&failed), Mode::Poll);
        assert_eq!(choose_mode(&failed).label(), "poll");
    }

    #[test]
    fn a_live_watcher_announces_watch_not_poll() {
        let directory = tempfile::tempdir().unwrap();
        let (tx, _rx) = mpsc::channel();
        let watcher = start_watcher(&[directory.path().to_path_buf()], tx).unwrap();
        assert_eq!(choose_mode(&Ok(watcher)), Mode::Watch);
        // A watcher with nothing to watch is still a watcher, and saying
        // "poll" here would report a degradation that is not happening.
        let (tx, _rx) = mpsc::channel();
        assert_eq!(
            choose_mode(&Ok(start_watcher(&[], tx).unwrap())).label(),
            "watch"
        );
    }

    /// The diagnostics exporter reads the mode through `last_mode`, which
    /// cannot see the emitted event. The numeric encoding and the word the
    /// user reads are two representations of one fact, so a change to either
    /// without the other would make the diagnostics report claim a mode the
    /// app never used.
    #[test]
    fn the_reported_mode_and_the_announced_mode_are_the_same_word() {
        for mode in [Mode::Watch, Mode::Poll] {
            assert_eq!(Mode::from_code(mode.code()), Some(mode));
            assert_eq!(
                mode.label(),
                match mode {
                    Mode::Watch => "watch",
                    Mode::Poll => "poll",
                }
            );
        }
        // 0 is the sentinel for "no supervisor", and must decode to no mode
        // rather than to watch: reporting a watch that never happened is the
        // failure this guards.
        assert_eq!(Mode::from_code(0), None);
        assert_eq!(Mode::from_code(3), None, "an unknown code is not a mode");
    }
}
