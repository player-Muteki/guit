use crate::activity;
use crate::perf;
use crate::repo::RepoIdentity;
use crate::session::{self, SessionState};
use notify::Watcher;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, RecvTimeoutError, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

/// Quiet period after the last filesystem event before a refresh runs.
const DEBOUNCE: Duration = Duration::from_millis(250);
/// Ceiling on that quiet period, counted from the *first* event of a burst.
/// Without it, a writer that touches a file faster than `DEBOUNCE` never lets a
/// refresh happen: every event pushes the deadline out by the full quiet period,
/// so the loop's wait is a function of how busy the disk is rather than of how
/// stale the panel may become.
const MAX_WAIT: Duration = Duration::from_secs(1);
/// Interval between refreshes when no event stream is available. Watch mode uses
/// it too, as the ceiling on staleness when events have stopped arriving for a
/// reason nobody can see: an inotify stream can die without reporting it.
const POLL_INTERVAL: Duration = Duration::from_secs(5);
/// Maximum blocking wait per loop turn so shutdown stays responsive.
const HEARTBEAT: Duration = Duration::from_millis(1000);
/// Pending filesystem notes. The callback thread must never block on a full
/// queue — blocking would push backpressure into the kernel's own event queue,
/// which is a worse failure than losing detail — so overflow sets a flag instead.
/// Sized for a `MAX_WAIT` window at the measured burst rate of file creation.
const EVENT_CAP: usize = 1024;
/// Deduplicated paths per window. Past this the merged set is discarded rather
/// than kept partial: a set that is missing paths and says so is worth exactly
/// as much as an empty one, and the empty one is cheaper.
const PATH_CAP: usize = 1024;

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

/// One filesystem fact, reduced to what a refresh can use: which path, and
/// whether that path is known to be gone. Carrying the kind as a single bit is
/// what lets a window evict the name that no longer exists instead of
/// accumulating names that were only ever transient.
#[derive(Debug, Clone, PartialEq, Eq)]
struct EventNote {
    path: PathBuf,
    removed: bool,
}

/// What one debounced window learned about the filesystem.
///
/// The two sets are paired rather than merged: a name that appeared and then
/// disappeared — an editor's temporary file — cancels itself out and belongs in
/// neither, while a name that only disappeared is a real deletion that the
/// mtime index has to stop trusting. Keeping one set would either accumulate
/// names that no longer exist or lose those deletions, and both are wrong in
/// opposite directions.
///
/// `incomplete` is not a confidence level. It means the detail was lost, so the
/// only safe conclusion is to re-check everything — which is also why an
/// overflowed window is never read as an empty one. An empty pair of sets is a
/// provable statement that nothing moved; `incomplete` is the statement that
/// this loop no longer knows.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Window {
    changed: HashSet<PathBuf>,
    removed: HashSet<PathBuf>,
    incomplete: bool,
}

impl Window {
    /// A window that knows nothing about which paths moved: what a poll tick and
    /// a watch fallback both are.
    fn full_rescan() -> Self {
        Self {
            incomplete: true,
            ..Default::default()
        }
    }

    fn absorb(&mut self, note: EventNote, saturated: &AtomicBool) {
        // Once the window has been declared untrustworthy it stays that way until
        // it is handed over: refilling the sets would spend memory on detail this
        // refresh has already given up on.
        if self.incomplete
            || saturated.load(Ordering::SeqCst)
            || self.changed.len() + self.removed.len() >= PATH_CAP
        {
            self.discarded();
            return;
        }
        if note.removed {
            // A deletion of something this same window had already reported as
            // changed was never a change to the tree; it was a name in transit.
            if !self.changed.remove(&note.path) {
                self.removed.insert(note.path);
            }
            return;
        }
        // And the converse: a name that came back is not a deletion any more.
        self.removed.remove(&note.path);
        self.changed.insert(note.path);
    }

    /// Detail is gone: say so once, and stop spending memory on a set that has
    /// already been declared untrustworthy.
    fn discarded(&mut self) {
        self.incomplete = true;
        self.changed.clear();
        self.removed.clear();
    }

    /// The three read-only ends of a window, for the one consumer that acts on
    /// paths rather than treating every fire as a whole re-capture.
    pub(crate) fn is_incomplete(&self) -> bool {
        self.incomplete
    }

    pub(crate) fn changed(&self) -> &HashSet<PathBuf> {
        &self.changed
    }

    pub(crate) fn removed(&self) -> &HashSet<PathBuf> {
        &self.removed
    }

    /// The two shapes a consumer of paths has to be able to be handed, built
    /// without running the loop that normally produces them.
    #[cfg(test)]
    pub(crate) fn naming(changed: &[PathBuf], removed: &[PathBuf]) -> Window {
        Window {
            changed: changed.iter().cloned().collect(),
            removed: removed.iter().cloned().collect(),
            incomplete: false,
        }
    }

    #[cfg(test)]
    pub(crate) fn without_detail() -> Window {
        Window::full_rescan()
    }
}

/// Event-driven (Watch) or interval-driven (Poll) refresh loop with burst
/// debouncing, a ceiling on that debouncing, a bounded path set and a rhythm for
/// re-attaching the watch.
///
/// Pure with respect to its inputs so tests can drive it through an injected
/// channel and short timers. `fire` returns false once the session it refreshes
/// is gone. Every fire hands over the window it collected: in watch mode that is
/// the merged notes, in poll mode and on the watch fallback it is a full rescan.
///
/// `rearm` is asked for on the heartbeat in watch mode only — the loop holds no
/// watcher itself, and in poll mode there is no watch to re-attach.
#[allow(clippy::too_many_arguments)]
fn run_loop(
    trigger: &Receiver<EventNote>,
    saturated: &AtomicBool,
    shutdown: &AtomicBool,
    mode: Mode,
    debounce: Duration,
    max_wait: Duration,
    poll_interval: Duration,
    heartbeat: Duration,
    rearm: &mut dyn FnMut(),
    fire: &mut dyn FnMut(Window) -> bool,
) -> LoopExit {
    let tick = heartbeat.min(poll_interval).max(Duration::from_millis(1));
    let mut next_fallback = Instant::now() + poll_interval;
    let mut next_rearm = Instant::now() + heartbeat;
    let mut window = Window::default();
    let mut quiet_deadline: Option<Instant> = None;
    let mut hard_deadline: Option<Instant> = None;
    loop {
        if shutdown.load(Ordering::SeqCst) {
            return LoopExit::Shutdown;
        }
        let now = Instant::now();
        // Block no longer than the next thing that has to happen, whatever it is.
        let mut wait = tick;
        for deadline in [
            Some(next_fallback),
            Some(next_rearm),
            quiet_deadline,
            hard_deadline,
            Some(now + tick),
        ]
        .into_iter()
        .flatten()
        {
            wait = wait.min(deadline.saturating_duration_since(now));
        }
        match trigger.recv_timeout(wait) {
            Ok(note) if mode == Mode::Watch => {
                // The ceiling is measured from the first event of the burst, so
                // a steady writer slows the panel down without stopping it.
                let hard = *hard_deadline.get_or_insert(now + max_wait);
                quiet_deadline = Some((now + debounce).min(hard));
                window.absorb(note, saturated);
            }
            Ok(_) => {
                // Polling: the timer is the rhythm and the queue is left to
                // overflow, which is the same conclusion polling already reaches.
            }
            Err(RecvTimeoutError::Disconnected) => return LoopExit::Disconnected,
            Err(RecvTimeoutError::Timeout) => {
                let now = Instant::now();
                // A watch root that is deleted goes silent with no error, and its
                // own recreation is invisible to the watcher because the parent is
                // not in the watch set. Re-issuing the watch is the only repair, it
                // is idempotent, and nothing has to have happened to be worth it.
                if mode == Mode::Watch && now >= next_rearm {
                    next_rearm = now + heartbeat;
                    rearm();
                }
                let due = [quiet_deadline, hard_deadline]
                    .into_iter()
                    .flatten()
                    .any(|deadline| now >= deadline);
                if !due && now < next_fallback {
                    continue;
                }
                // Take everything already queued before deciding, so events that
                // arrived during the last refresh are not left for a later burst.
                let mut drained = false;
                while let Ok(note) = trigger.try_recv() {
                    if mode == Mode::Watch {
                        window.absorb(note, saturated);
                        drained = true;
                    }
                }
                // The queue is empty now, so the pressure that set the flag is
                // over and the next window may keep detail again. Clearing it here
                // rather than never is what stops one burst from marking every
                // later refresh as a guess.
                if saturated.swap(false, Ordering::SeqCst) {
                    window.discarded();
                }
                // A clock tick that turned up notes is not a clock tick: those
                // paths are real detail, and dropping them would leave the panel
                // waiting for a fallback that has already run.
                let outcome = if due || drained {
                    std::mem::take(&mut window)
                } else {
                    Window::full_rescan()
                };
                quiet_deadline = None;
                hard_deadline = None;
                next_fallback = now + poll_interval;
                if shutdown.load(Ordering::SeqCst) {
                    return LoopExit::Shutdown;
                }
                if !fire(outcome) {
                    return LoopExit::SessionGone;
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

/// Re-attach every watch target that currently exists.
///
/// Three facts make this the right repair and not a cleanup: a deleted watch root
/// goes silent — measured zero events and no `Err` — and its recreation cannot be
/// seen at all, because its parent is not in the watch set; `watch` on a path
/// already watched is deduplicated by notify, so re-issuing it does not double the
/// events of a live root; `unwatch` is the one call that fails on exactly the
/// entries that have already died in the kernel, so a "clear then re-add" version
/// of this would be worse than doing nothing.
///
/// A target that is still missing returns an error and is tried again on the next
/// turn, which is why nothing is reported here: an answer would be a claim about a
/// repository that may come back a second later.
fn rearm(watcher: &mut notify::RecommendedWatcher, identity: &RepoIdentity) {
    for target in watch_targets(identity) {
        let _ = watcher.watch(&target, notify::RecursiveMode::Recursive);
    }
}

/// notify's inotify mask includes IN_ACCESS, and every Git read guit performs
/// (HEAD, config, refs, objects) touches files. Treating accesses as changes
/// makes the refresh loop feed itself forever; an access never changes any
/// Git state, so it is dropped. All other kinds still trigger a refresh.
fn refresh_worthy(event: &notify::Event) -> bool {
    !matches!(event.kind, notify::EventKind::Access(_))
}

/// Reduce one event to the paths it leaves behind and whether each is known to be
/// gone.
///
/// A rename is the case this exists for: an editor saves by writing a temporary
/// file and renaming it over the target, which notify reports as the old name
/// disappearing and the new one arriving. Reporting both paths as "changed" is
/// what would fill a bounded set with names that had already stopped existing by
/// the time the window closed, so the side that is definitely gone is marked here
/// and cancels itself against the set.
///
/// Only three kinds say "gone" without asking: a removal, a rename that reports
/// its source alone, and the first path of a rename that reports both. Every
/// other name change leaves existence to be checked by whoever consumes the
/// window, because dropping a live path from the index on a guess costs a full
/// re-enumeration to undo, while re-checking a dead one costs one stat call.
fn notes_from(event: &notify::Event) -> Vec<EventNote> {
    use notify::event::{ModifyKind, RenameMode};
    if !refresh_worthy(event) {
        return Vec::new();
    }
    let mut removed_first = match event.kind {
        notify::EventKind::Remove(_) => event.paths.len(),
        // Both paths of a rename arrive in one event, source first.
        notify::EventKind::Modify(ModifyKind::Name(RenameMode::Both)) => 1,
        notify::EventKind::Modify(ModifyKind::Name(RenameMode::From)) => event.paths.len(),
        _ => 0,
    };
    // A removed directory is reported as the one path it names: everything under
    // it is gone too, and no per-path note can say so. The consumer evicts by
    // prefix, which is the only reading that does not require a walk here.
    event
        .paths
        .iter()
        .map(|path| {
            let removed = removed_first > 0;
            removed_first = removed_first.saturating_sub(1);
            EventNote {
                path: path.clone(),
                removed,
            }
        })
        .collect()
}

/// Hand one event to the loop without ever blocking the callback thread.
///
/// Split out from the watcher closure so that the two outcomes worth telling
/// apart can be tested: a full queue is this window's detail being lost, while a
/// disconnected one is the session ending. Today's `let _ =` swallows both.
fn deliver(
    tx: &SyncSender<EventNote>,
    saturated: &AtomicBool,
    event: &notify::Event,
) -> Result<(), ()> {
    for note in notes_from(event) {
        match tx.try_send(note) {
            Ok(()) => {}
            Err(TrySendError::Full(_)) => {
                saturated.store(true, Ordering::SeqCst);
                return Ok(());
            }
            Err(TrySendError::Disconnected(_)) => return Err(()),
        }
    }
    Ok(())
}

fn start_watcher(
    targets: &[PathBuf],
    tx: SyncSender<EventNote>,
    saturated: Arc<AtomicBool>,
) -> Result<notify::RecommendedWatcher, notify::Error> {
    let mut watcher =
        notify::recommended_watcher(move |result: Result<notify::Event, notify::Error>| {
            match result {
                Ok(event) => {
                    let _ = deliver(&tx, &saturated, &event);
                }
                // A stream that errors may keep delivering nothing at all, and there
                // is no way to tell that apart from a quiet repository. The watchdog
                // tick is what bounds this, so the line is recorded and not acted on.
                Err(error) => eprintln!("guit [watch]: event stream error ({error})"),
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
    let (tx, rx) = sync_channel(EVENT_CAP);
    // Keeps the trigger channel open even when no watcher was created, so
    // poll mode times out instead of seeing a disconnect.
    let _poll_channel_keeper = tx.clone();
    let saturated = Arc::new(AtomicBool::new(false));
    let mut watcher = start_watcher(&watch_targets(&identity), tx, saturated.clone());
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
    let mut rearm = || {
        if let Ok(live) = watcher.as_mut() {
            rearm(live, &identity);
        }
    };
    let mut refresh_failed = false;
    // The activity index belongs to this thread: one owner, no lock, and it
    // dies with the session it measured. Nothing else reads it, so nothing else
    // needs to exist.
    let mut tracker = activity::ActivityTracker::default();
    run_loop(
        &rx,
        &saturated,
        &shutdown,
        mode,
        DEBOUNCE,
        MAX_WAIT,
        POLL_INTERVAL,
        HEARTBEAT,
        &mut rearm,
        // The window's paths are consumed by the activity index, which is the
        // one read that can answer a burst by measuring the files it names
        // instead of asking Git what the whole repository looks like. The
        // snapshot is still a whole re-capture: it has no per-path form.
        &mut |window: Window| {
            let started = Instant::now();
            let outcome = session::refresh(&emitter.state::<SessionState>());
            perf::mark("watch.refresh", started.elapsed());
            if shutdown.load(Ordering::SeqCst) {
                return false;
            }
            match outcome {
                Ok(Some(snapshot)) => {
                    // Read before the emit moves it: the activity line is
                    // published under the session this snapshot was published
                    // under, so the frontend never has to decide whether an age
                    // belongs to the repository it is looking at.
                    let session_id = snapshot.session_id;
                    let _ = emitter.emit("repo-refreshed", snapshot);
                    let view = tracker.apply(&window, &identity, session_id, &shutdown);
                    let _ = emitter.emit("activity-updated", view);
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
                    // Silence here would leave the last good age on screen and
                    // growing, which reads as an idle repository rather than a
                    // broken refresh. A failed round is an answer.
                    let _ = emitter.emit(
                        "activity-updated",
                        tracker.unavailable(activity::ActivityReason::RefreshFailed),
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
    // The age line stops with the session, not with the last number it saw. A
    // clear carries no session so the frontend may accept it whatever it is
    // currently showing; a stale age left on screen after close is the failure
    // this channel exists to make impossible.
    let _ = app.emit(
        "activity-updated",
        activity::ActivityView::cleared(activity::ActivityReason::SessionClosed),
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

    /// A queue small enough that the second note cannot fit, so the overflow path
    /// can be reached without filling a kilobyte-scale buffer.
    fn note(path: &str) -> EventNote {
        EventNote {
            path: PathBuf::from(path),
            removed: false,
        }
    }

    fn kept(path: &str) -> EventNote {
        EventNote {
            path: PathBuf::from(path),
            removed: false,
        }
    }

    fn lost(path: &str) -> EventNote {
        EventNote {
            path: PathBuf::from(path),
            removed: true,
        }
    }

    fn event(paths: &[&str], kind: notify::EventKind) -> notify::Event {
        let mut event = notify::Event::new(kind);
        for path in paths {
            event = event.add_path(PathBuf::from(path));
        }
        event
    }

    #[test]
    fn watch_events_debounce_into_a_single_fire() {
        let (tx, rx) = sync_channel(EVENT_CAP);
        let saturated = Arc::new(AtomicBool::new(false));
        let thread_saturated = saturated.clone();
        let shutdown = Arc::new(AtomicBool::new(false));
        let fired = Arc::new(AtomicUsize::new(0));
        let thread_shutdown = shutdown.clone();
        let thread_fired = fired.clone();
        let worker = std::thread::spawn(move || {
            run_loop(
                &rx,
                &thread_saturated,
                &thread_shutdown,
                Mode::Watch,
                Duration::from_millis(80),
                Duration::from_secs(60),
                Duration::from_secs(60),
                Duration::from_millis(20),
                &mut || {},
                &mut |_window: Window| {
                    thread_fired.fetch_add(1, Ordering::SeqCst);
                    true
                },
            )
        });
        for _ in 0..5 {
            tx.send(note("/repo/notes.txt")).unwrap();
            std::thread::sleep(Duration::from_millis(20));
        }
        std::thread::sleep(Duration::from_millis(300));
        shutdown.store(true, Ordering::SeqCst);
        assert_eq!(worker.join().unwrap(), LoopExit::Shutdown);
        assert_eq!(fired.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn poll_mode_fires_without_any_events() {
        let (_tx, rx) = sync_channel(EVENT_CAP);
        let saturated = Arc::new(AtomicBool::new(false));
        let thread_saturated = saturated.clone();
        let shutdown = Arc::new(AtomicBool::new(false));
        let fired = Arc::new(AtomicUsize::new(0));
        let thread_shutdown = shutdown.clone();
        let thread_fired = fired.clone();
        let worker = std::thread::spawn(move || {
            run_loop(
                &rx,
                &thread_saturated,
                &thread_shutdown,
                Mode::Poll,
                Duration::from_millis(80),
                Duration::from_secs(60),
                Duration::from_millis(60),
                Duration::from_millis(20),
                &mut || {},
                &mut |_window: Window| {
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
        let (_tx, rx) = sync_channel(EVENT_CAP);
        let saturated = AtomicBool::new(false);
        let shutdown = AtomicBool::new(false);
        let mut rearmed = 0;
        let exit = run_loop(
            &rx,
            &saturated,
            &shutdown,
            Mode::Poll,
            Duration::from_millis(10),
            Duration::from_secs(10),
            Duration::from_millis(30),
            Duration::from_millis(10),
            &mut || {
                rearmed += 1;
            },
            &mut |_window: Window| false,
        );
        assert_eq!(exit, LoopExit::SessionGone);
        // Poll mode has no watch to re-attach: asking would be a claim that this
        // repository is being watched when it is known not to be.
        assert_eq!(rearmed, 0, "a poll-mode loop re-attached a watch");
    }

    #[test]
    fn shutdown_before_first_fire_runs_nothing() {
        let (_tx, rx) = sync_channel(EVENT_CAP);
        let saturated = AtomicBool::new(false);
        let shutdown = AtomicBool::new(true);
        let fired = AtomicUsize::new(0);
        let exit = run_loop(
            &rx,
            &saturated,
            &shutdown,
            Mode::Poll,
            Duration::from_millis(10),
            Duration::from_secs(10),
            Duration::from_millis(30),
            Duration::from_millis(10),
            &mut || {},
            &mut |_window: Window| {
                fired.fetch_add(1, Ordering::SeqCst);
                true
            },
        );
        assert_eq!(exit, LoopExit::Shutdown);
        assert_eq!(fired.load(Ordering::SeqCst), 0);
    }

    /// Debouncing without a ceiling is a way of switching the panel off: an
    /// event every ten milliseconds pushes the quiet deadline out by the whole
    /// debounce period forever. The max-wait deadline is the only thing that
    /// makes a busy repository still refresh, and it has to be reached *while
    /// the burst is still going* — a fire after the writer stopped would prove
    /// nothing about starvation.
    #[test]
    fn a_steady_writer_cannot_starve_the_refresh() {
        let (tx, rx) = sync_channel(EVENT_CAP);
        let saturated = Arc::new(AtomicBool::new(false));
        let thread_saturated = saturated.clone();
        let shutdown = Arc::new(AtomicBool::new(false));
        let thread_shutdown = shutdown.clone();
        let fired = Arc::new(AtomicUsize::new(0));
        let thread_fired = fired.clone();
        let worker = std::thread::spawn(move || {
            run_loop(
                &rx,
                &thread_saturated,
                &thread_shutdown,
                Mode::Watch,
                Duration::from_millis(80),
                Duration::from_millis(60),
                Duration::from_secs(60),
                Duration::from_millis(20),
                &mut || {},
                &mut |_window: Window| {
                    thread_fired.fetch_add(1, Ordering::SeqCst);
                    true
                },
            )
        });
        // 300ms of activity is five max-wait periods and only just over three
        // debounce periods: with the ceiling removed this loop never fires.
        for _ in 0..30 {
            tx.send(note("/repo/notes.txt")).unwrap();
            std::thread::sleep(Duration::from_millis(10));
        }
        let during_burst = fired.load(Ordering::SeqCst);
        shutdown.store(true, Ordering::SeqCst);
        let _ = worker.join();
        assert!(
            during_burst >= 2,
            "a burst faster than the debounce produced {during_burst} refreshes"
        );
    }

    /// Watch mode is not a promise that events arrive: an inotify stream can
    /// die quietly, and a repository nobody touches is indistinguishable from
    /// one whose watcher is gone. The poll interval is therefore also the
    /// ceiling on staleness in watch mode, and the window it hands over must
    /// say that nothing is known about which paths moved.
    #[test]
    fn watch_mode_falls_back_without_any_events() {
        let (_tx, rx) = sync_channel(EVENT_CAP);
        let saturated = Arc::new(AtomicBool::new(false));
        let thread_saturated = saturated.clone();
        let shutdown = Arc::new(AtomicBool::new(false));
        let thread_shutdown = shutdown.clone();
        let windows = Arc::new(Mutex::new(Vec::new()));
        let thread_windows = windows.clone();
        let rearms = Arc::new(AtomicUsize::new(0));
        let thread_rearms = rearms.clone();
        let worker = std::thread::spawn(move || {
            run_loop(
                &rx,
                &thread_saturated,
                &thread_shutdown,
                Mode::Watch,
                Duration::from_millis(80),
                Duration::from_secs(60),
                Duration::from_millis(60),
                Duration::from_millis(20),
                &mut || {
                    thread_rearms.fetch_add(1, Ordering::SeqCst);
                },
                &mut |window: Window| {
                    crate::util::guard(&thread_windows).push(window);
                    true
                },
            )
        });
        std::thread::sleep(Duration::from_millis(250));
        shutdown.store(true, Ordering::SeqCst);
        let _ = worker.join();
        let windows = crate::util::guard(&windows);
        assert!(windows.len() >= 2, "the fallback never fired");
        assert!(
            windows.iter().all(|window| window.incomplete),
            "a tick with no events claimed to know which paths moved"
        );
        assert!(
            rearms.load(Ordering::SeqCst) >= windows.len(),
            "a quiet watch loop refreshed but never re-attached the watch"
        );
    }

    #[test]
    fn access_events_do_not_trigger_a_refresh() {
        let access = notify::Event::new(notify::EventKind::Access(notify::event::AccessKind::Read))
            .add_path(PathBuf::from("/repo/.git/HEAD"));
        assert!(!refresh_worthy(&access));
        assert!(
            notes_from(&access).is_empty(),
            "an access still left a note for the window"
        );
        let modify = notify::Event::new(notify::EventKind::Modify(
            notify::event::ModifyKind::Data(notify::event::DataChange::Content),
        ))
        .add_path(PathBuf::from("/repo/.git/index"));
        assert!(refresh_worthy(&modify));
        let remove = notify::Event::new(notify::EventKind::Remove(notify::event::RemoveKind::File))
            .add_path(PathBuf::from("/repo/notes.txt"));
        assert!(refresh_worthy(&remove));
    }

    /// An editor save is a rename, and notify reports both sides in one event.
    /// Marking only the destination as changed is what let a bounded set fill
    /// with names that had already stopped existing; the source has to arrive as
    /// a removal so the window can cancel it.
    #[test]
    fn a_rename_notes_its_source_as_removed_and_its_target_as_kept() {
        use notify::event::{DataChange, ModifyKind, RenameMode};
        let both = event(
            &["/repo/notes.txt", "/repo/.notes.txt.swp"],
            notify::EventKind::Modify(ModifyKind::Name(RenameMode::Both)),
        );
        assert_eq!(
            notes_from(&both),
            vec![lost("/repo/notes.txt"), kept("/repo/.notes.txt.swp")]
        );
        // A rename that reports only its destination names a path that exists, so
        // claiming it is gone would drop a live file from the index on a guess.
        let target = event(
            &["/repo/notes.txt"],
            notify::EventKind::Modify(ModifyKind::Name(RenameMode::To)),
        );
        assert_eq!(notes_from(&target), vec![kept("/repo/notes.txt")]);
        // The source alone is the mirror case: that name is definitively gone.
        let source = event(
            &["/repo/.notes.txt.swp"],
            notify::EventKind::Modify(ModifyKind::Name(RenameMode::From)),
        );
        assert_eq!(notes_from(&source), vec![lost("/repo/.notes.txt.swp")]);
        // A removal marks every path it names, and a content change marks none.
        let gone = event(
            &["/repo/a.txt", "/repo/b.txt"],
            notify::EventKind::Remove(notify::event::RemoveKind::File),
        );
        assert_eq!(
            notes_from(&gone),
            vec![lost("/repo/a.txt"), lost("/repo/b.txt")]
        );
        // A content change is neither present nor absent.
        let content = event(
            &["/repo/notes.txt"],
            notify::EventKind::Modify(ModifyKind::Data(DataChange::Content)),
        );
        assert_eq!(notes_from(&content), vec![kept("/repo/notes.txt")]);
        assert!(notes_from(&event(
            &["/repo/notes.txt"],
            notify::EventKind::Access(notify::event::AccessKind::Read)
        ))
        .is_empty());
    }

    /// The pair of sets is the whole point of the window: the merge has to prove
    /// both that a transient name left nothing behind and that a real deletion
    /// is not silently read as "nothing moved".
    #[test]
    fn a_name_that_appears_and_disappears_cancels_itself() {
        let free = AtomicBool::new(false);
        let mut window = Window::default();
        window.absorb(kept("/repo/.notes.txt.swp"), &free);
        window.absorb(lost("/repo/.notes.txt.swp"), &free);
        assert!(window.changed.is_empty() && window.removed.is_empty());
        assert!(
            !window.incomplete,
            "a self-cancelling name is detail kept, not detail lost"
        );
        // The reverse order is a file that came back: still nothing to report,
        // and the deletion must not survive in the other set either.
        let mut window = Window::default();
        window.absorb(lost("/repo/notes.txt"), &free);
        window.absorb(kept("/repo/notes.txt"), &free);
        assert!(window.changed == [PathBuf::from("/repo/notes.txt")].into());
        assert!(window.removed.is_empty());
        // A deletion nobody re-created is the case a single merged set loses.
        let mut window = Window::default();
        window.absorb(lost("/repo/deleted.txt"), &free);
        assert!(window.changed.is_empty());
        assert!(window.removed == [PathBuf::from("/repo/deleted.txt")].into());
    }

    /// Overflow and saturation are the two ways detail is lost, and both have to
    /// end in the same word: this window does not know. Reading either as the
    /// empty window they collapse into is the failure that would report a quiet
    /// repository while the queue was dropping events.
    #[test]
    fn losing_detail_is_never_read_as_nothing_happened() {
        let free = AtomicBool::new(false);
        let mut window = Window::default();
        for index in 0..PATH_CAP * 2 {
            window.absorb(kept(&format!("/repo/file-{index}")), &free);
        }
        assert!(window.incomplete, "the path cap was absorbed away");
        assert!(
            window.changed.is_empty() && window.removed.is_empty(),
            "a discarded window keeps paying for a set it no longer trusts"
        );

        let saturated = AtomicBool::new(true);
        let mut window = Window::default();
        window.absorb(kept("/repo/one.txt"), &saturated);
        assert!(window.incomplete);
        assert!(window.changed.is_empty());
        // A window that gave up stays given up until it is handed over: the
        // notes that arrive after the flag is cleared must not be quietly
        // re-collected into a set this refresh already disowned.
        let free = AtomicBool::new(false);
        window.absorb(kept("/repo/two.txt"), &free);
        assert!(window.changed.is_empty() && window.removed.is_empty());
        assert!(window.incomplete);

        // A poll tick and a watch fallback both know nothing, which is the same
        // conclusion as the two above and must not be spelled as an empty set.
        let window = Window::full_rescan();
        assert!(window.incomplete);
    }

    /// A full queue is dropped, not waited on: blocking here would put
    /// backpressure into the kernel's own event queue, which is the worse
    /// failure. The flag is the only news, and it must be set by the first note
    /// that does not fit.
    #[test]
    fn a_full_queue_is_flagged_and_the_callback_thread_never_blocks() {
        let (tx, rx) = sync_channel(1);
        let saturated = AtomicBool::new(false);
        use notify::event::{DataChange, ModifyKind};
        use std::sync::mpsc::TryRecvError;
        let changed = event(
            &["/repo/one.txt"],
            notify::EventKind::Modify(ModifyKind::Data(DataChange::Content)),
        );
        let started = Instant::now();
        assert_eq!(deliver(&tx, &saturated, &changed), Ok(()));
        assert_eq!(deliver(&tx, &saturated, &changed), Ok(()));
        assert_eq!(deliver(&tx, &saturated, &changed), Ok(()));
        assert!(
            started.elapsed() < Duration::from_millis(500),
            "the callback thread waited for room in the queue"
        );
        assert!(saturated.load(Ordering::SeqCst));
        assert_eq!(
            rx.try_recv(),
            Ok(kept("/repo/one.txt")),
            "the note that fit was lost anyway"
        );
        assert_eq!(
            rx.try_recv(),
            Err(TryRecvError::Empty),
            "the queue held more than it was sized for"
        );
    }

    /// A disconnected channel is the session ending, which is a different fact
    /// from a queue being full and the one case `deliver` reports upward.
    #[test]
    fn a_disconnected_channel_is_reported_as_such() {
        let (tx, rx) = sync_channel(1);
        let saturated = AtomicBool::new(false);
        drop(rx);
        use notify::event::{DataChange, ModifyKind};
        let changed = event(
            &["/repo/one.txt"],
            notify::EventKind::Modify(ModifyKind::Data(DataChange::Content)),
        );
        assert_eq!(deliver(&tx, &saturated, &changed), Err(()));
        assert!(
            !saturated.load(Ordering::SeqCst),
            "a dead session is not an overflow"
        );
    }

    /// The saturated flag describes one window's queue, not the process's life:
    /// left set, every later refresh would be a full rescan forever, which is
    /// the degradation this stage exists to avoid.
    #[test]
    fn the_saturation_flag_is_cleared_when_the_queue_is_drained() {
        let (tx, rx) = sync_channel(EVENT_CAP);
        let saturated = AtomicBool::new(true);
        tx.send(kept("/repo/one.txt")).unwrap();
        let exit = run_loop(
            &rx,
            &saturated,
            &AtomicBool::new(false),
            Mode::Watch,
            Duration::from_millis(10),
            Duration::from_millis(30),
            Duration::from_secs(10),
            Duration::from_millis(10),
            &mut || {},
            &mut |_window: Window| false,
        );
        assert_eq!(exit, LoopExit::SessionGone);
        assert!(
            !saturated.load(Ordering::SeqCst),
            "the flag outlived the window it described"
        );
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
        let (tx, rx) = sync_channel(EVENT_CAP);
        let saturated = Arc::new(AtomicBool::new(false));
        let watcher = start_watcher(&[directory.path().to_path_buf()], tx, saturated).unwrap();
        std::fs::write(directory.path().join("tracked.txt"), b"x").unwrap();
        assert!(rx.recv_timeout(Duration::from_secs(10)).is_ok());
        drop(watcher);
    }

    /// A deleted watch root is silent, and its own recreation is invisible to the
    /// watcher that was watching it: the parent is not in the watch set. Re-issuing
    /// the watch is the only repair, so this pins both halves of it — a target that
    /// is still missing must not stop the call, and the same call must make the
    /// recreated target deliver again.
    #[test]
    fn rearming_replaces_a_deleted_watch_root() {
        let directory = tempfile::tempdir().unwrap();
        let identity = identity_for(directory.path());
        let (tx, rx) = sync_channel(EVENT_CAP);
        let mut watcher = start_watcher(
            &watch_targets(&identity),
            tx,
            Arc::new(AtomicBool::new(false)),
        )
        .unwrap();
        std::fs::remove_dir_all(directory.path()).unwrap();
        // Nothing exists yet: the turn that asks again a second later is the
        // design, so this must neither panic nor report a verdict.
        rearm(&mut watcher, &identity);
        std::fs::create_dir_all(directory.path()).unwrap();
        rearm(&mut watcher, &identity);
        std::fs::write(directory.path().join("after.txt"), b"x").unwrap();
        assert!(
            rx.recv_timeout(Duration::from_secs(10)).is_ok(),
            "a re-attached root still delivered nothing"
        );
    }

    /// The repair above has to be reached without a user touching anything, which
    /// is what a heartbeat re-arm buys: the repository is deleted and recreated
    /// while the loop runs, and the write that follows is seen even though no
    /// refresh was asked for in between. Hanging the re-arm off the refresh instead
    /// would wait for an event that a silent root cannot produce.
    #[test]
    fn the_loop_re_attaches_a_root_that_came_back() {
        let directory = tempfile::tempdir().unwrap();
        let identity = identity_for(directory.path());
        let (tx, rx) = sync_channel(EVENT_CAP);
        let saturated = Arc::new(AtomicBool::new(false));
        let thread_saturated = saturated.clone();
        let mut watcher =
            start_watcher(&watch_targets(&identity), tx, thread_saturated.clone()).unwrap();
        let shutdown = Arc::new(AtomicBool::new(false));
        let thread_shutdown = shutdown.clone();
        let seen = Arc::new(Mutex::new(Vec::<PathBuf>::new()));
        let thread_seen = seen.clone();
        let worker = std::thread::spawn(move || {
            let mut reattach = || rearm(&mut watcher, &identity);
            run_loop(
                &rx,
                &thread_saturated,
                &thread_shutdown,
                Mode::Watch,
                Duration::from_millis(20),
                Duration::from_secs(10),
                Duration::from_secs(10),
                Duration::from_millis(50),
                &mut reattach,
                &mut |window: Window| {
                    crate::util::guard(&thread_seen).extend(window.changed.iter().cloned());
                    true
                },
            )
        });
        std::fs::write(directory.path().join("seed.txt"), b"x").unwrap();
        std::thread::sleep(Duration::from_millis(200));
        std::fs::remove_dir_all(directory.path()).unwrap();
        std::thread::sleep(Duration::from_millis(200));
        std::fs::create_dir_all(directory.path()).unwrap();
        // The measured window in which a recursive watch on a recreated directory is
        // not yet established; writing inside it would test the kernel's timing
        // rather than this loop's re-arm.
        std::thread::sleep(Duration::from_millis(500));
        std::fs::write(directory.path().join("fresh.txt"), b"y").unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        let seen_fresh = loop {
            if crate::util::guard(&seen)
                .iter()
                .any(|path| path.ends_with("fresh.txt"))
            {
                break true;
            }
            if Instant::now() >= deadline {
                break false;
            }
            std::thread::sleep(Duration::from_millis(50));
        };
        shutdown.store(true, Ordering::SeqCst);
        let _ = worker.join();
        assert!(seen_fresh, "a recreated watch root stayed silent");
    }

    /// The two write shapes a real editor produces, driven through the actual
    /// watcher rather than an injected channel: appending to one file every 40 ms
    /// never leaves a quiet period, and an atomic save — write a temporary name,
    /// rename it over the target — reports five or six events of which some point
    /// at a name that has already stopped existing by the time the window closes.
    ///
    /// The quiet period here is deliberately much longer than one save, so a save
    /// cannot be split across two windows: that makes "no temporary name was ever
    /// handed over as a changed path" a statement about the eviction rule instead
    /// of about kernel timing. Starvation under the same cadence is pinned by the
    /// injected fixture, which can hold the deadlines tighter than a clock can.
    #[test]
    fn a_real_editors_cadence_evicts_the_names_that_already_moved() {
        let directory = tempfile::tempdir().unwrap();
        let identity = identity_for(directory.path());
        let (tx, rx) = sync_channel(EVENT_CAP);
        let saturated = Arc::new(AtomicBool::new(false));
        let thread_saturated = saturated.clone();
        let watcher = start_watcher(&watch_targets(&identity), tx, saturated).unwrap();
        let shutdown = Arc::new(AtomicBool::new(false));
        let thread_shutdown = shutdown.clone();
        let windows = Arc::new(Mutex::new(Vec::<Window>::new()));
        let thread_windows = windows.clone();
        let worker = std::thread::spawn(move || {
            run_loop(
                &rx,
                &thread_saturated,
                &thread_shutdown,
                Mode::Watch,
                Duration::from_millis(500),
                Duration::from_secs(5),
                Duration::from_secs(60),
                Duration::from_millis(50),
                &mut || {},
                &mut |window: Window| {
                    crate::util::guard(&thread_windows).push(window);
                    true
                },
            )
        });
        let target = directory.path().join("target.txt");
        let staging = directory.path().join("target.tmp");
        let log = directory.path().join("log.txt");
        for round in 0..15 {
            use std::io::Write;
            std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&log)
                .unwrap()
                .write_all(b"line\n")
                .unwrap();
            std::fs::write(&staging, format!("round {round}")).unwrap();
            std::fs::rename(&staging, &target).unwrap();
            std::thread::sleep(Duration::from_millis(40));
        }
        std::thread::sleep(Duration::from_millis(900));
        shutdown.store(true, Ordering::SeqCst);
        let _ = worker.join();
        drop(watcher);
        let windows = crate::util::guard(&windows);
        assert!(!windows.is_empty(), "a busy work tree produced no refresh");
        let mut changed: Vec<PathBuf> = Vec::new();
        for window in windows.iter() {
            assert!(
                !window.incomplete,
                "a real burst overflowed the queue or the path cap"
            );
            for path in &window.changed {
                assert!(
                    !path.ends_with("target.tmp"),
                    "a renamed-away name was handed over as a path to re-check: {}",
                    path.display()
                );
            }
            changed.extend(window.changed.iter().cloned());
        }
        assert!(
            changed.iter().any(|path| path.ends_with("target.txt")),
            "the renamed target was never reported"
        );
        assert!(
            changed.iter().any(|path| path.ends_with("log.txt")),
            "the appended file was never reported"
        );
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
        let (tx, _rx) = sync_channel(EVENT_CAP);
        let failed = start_watcher(
            &[PathBuf::from("/nonexistent/guit-watch-target")],
            tx,
            Arc::new(AtomicBool::new(false)),
        );
        assert!(failed.is_err(), "the fixture must fail to start watching");
        assert_eq!(choose_mode(&failed), Mode::Poll);
        assert_eq!(choose_mode(&failed).label(), "poll");
    }

    #[test]
    fn a_live_watcher_announces_watch_not_poll() {
        let directory = tempfile::tempdir().unwrap();
        let (tx, _rx) = sync_channel(EVENT_CAP);
        let watcher = start_watcher(
            &[directory.path().to_path_buf()],
            tx,
            Arc::new(AtomicBool::new(false)),
        )
        .unwrap();
        assert_eq!(choose_mode(&Ok(watcher)), Mode::Watch);
        // A watcher with nothing to watch is still a watcher, and saying
        // "poll" here would report a degradation that is not happening.
        let (tx, _rx) = sync_channel(EVENT_CAP);
        assert_eq!(
            choose_mode(&Ok(start_watcher(
                &[],
                tx,
                Arc::new(AtomicBool::new(false))
            )
            .unwrap()))
            .label(),
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
