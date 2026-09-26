//! Opt-in phase timing for performance work. The marks ship in
//! release builds but stay silent unless `GUIT_PERF=1` is set in the
//! environment; when disabled a mark costs one process-wide check. Labels
//! carry phase names only — never paths, arguments, URLs or output.

use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

/// 0 = unknown yet, 1 = off, 2 = on.
static STATE: AtomicU8 = AtomicU8::new(0);
static START: OnceLock<Instant> = OnceLock::new();

fn enabled() -> bool {
    match STATE.load(Ordering::Relaxed) {
        1 => false,
        2 => true,
        _ => {
            let on = std::env::var("GUIT_PERF")
                .map(|value| value == "1")
                .unwrap_or(false);
            STATE.store(if on { 2 } else { 1 }, Ordering::Relaxed);
            on
        }
    }
}

/// Records the process start milestone. Called once at the top of `main()`;
/// `since_start` works even without it (the first call anchors the clock).
pub fn init() {
    START.get_or_init(Instant::now);
    enabled();
}

/// Mirrors one `[perf]` line to stderr when enabled. The diagnostics ring
/// always receives the mark; `GUIT_PERF` only gates the mirror.
pub fn mark(phase: &str, elapsed: Duration) {
    crate::diagnostics::perf_mark(phase, elapsed);
    if enabled() {
        eprintln!(
            "[perf] phase={phase} ms={:.1}",
            elapsed.as_secs_f64() * 1000.0
        );
    }
}

/// Time since `init()` (or since this first use).
pub fn since_start() -> Duration {
    START.get_or_init(Instant::now).elapsed()
}

/// Marks an elapsed-since-process-start milestone, e.g. startup phases.
pub fn mark_since_start(phase: &str) {
    mark(phase, since_start());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_mark_is_always_harmless_and_the_clock_is_monotonic() {
        init();
        init();
        let first = since_start();
        std::thread::sleep(Duration::from_millis(5));
        assert!(since_start() > first);
        mark("test_phase", Duration::from_millis(1));
    }

    #[test]
    fn labels_never_depend_on_environment_state_for_correctness() {
        // Whether GUIT_PERF is set is host state; marks must not change the
        // returned values anywhere, so calling enabled() twice is idempotent.
        assert_eq!(enabled(), enabled());
    }
}
