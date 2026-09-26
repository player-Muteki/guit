use std::path::Path;
use std::sync::{Condvar, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

/// Compares two filesystem paths through canonicalization. Returns `None`
/// when either side cannot be resolved, so callers can distinguish "same",
/// "different" and "unknown" instead of guessing.
pub fn same_path(a: &Path, b: &Path) -> Option<bool> {
    let (Ok(a), Ok(b)) = (a.canonicalize(), b.canonicalize()) else {
        return None;
    };
    #[cfg(windows)]
    return Some(a.eq_ignore_ascii_case(&b));
    #[cfg(not(windows))]
    return Some(a == b);
}

/// Borrows the data behind a mutex, including after another thread panicked
/// while holding it.
///
/// Unwrapping a poisoned lock instead turns one failure into a permanent
/// second one: every later request that touches the same state dies with "a
/// lock was poisoned", which names neither the data nor the panic the user
/// already saw. The state behind these locks is either replaced wholesale (the
/// published snapshot, the watcher handle, the event ring) or keyed by an
/// identifier a failed request can no longer match (a one-time preview ticket),
/// so a holder that unwound leaves it usable — possibly one refresh stale,
/// which guit's version rechecks already refuse to act on.
pub(crate) fn guard<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Waits for a notification, returning whether the timeout struck first.
///
/// Same reason as [`guard`]: a panic in the notifying thread must not become a
/// panic in the waiting one.
pub(crate) fn wait<'a, T>(
    condvar: &Condvar,
    held: MutexGuard<'a, T>,
    timeout: Duration,
) -> (MutexGuard<'a, T>, bool) {
    let (held, outcome) = condvar
        .wait_timeout(held, timeout)
        .unwrap_or_else(PoisonError::into_inner);
    (held, outcome.timed_out())
}
