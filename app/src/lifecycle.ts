// What a component attached, it has to be able to let go of.
//
// The panel builds its parts once and then runs for days: a resize observer
// watching a list, a document-level key handler, a timer that repaints one
// line of text. None of them are a problem while the window is open, and each
// one is a promise that the window still exists. This is the one place that
// promise is kept — a component registers its teardown at the moment it
// attaches something, instead of guessing which other module would like to
// know that the application is going away.

type Teardown = () => void;

// Keyed by what the entry does rather than by who registered it, so a component
// that rebuilds cannot stack a second copy of the same `disconnect` on every
// round.
const teardowns = new Set<Teardown>();

// Returns the way to unregister, so a component that comes and goes — an
// overlay, a dialog — can drop its own entry as well as the thing it attached.
export function onDispose(task: Teardown): () => void {
  teardowns.add(task);
  return () => {
    teardowns.delete(task);
  };
}

// How many teardowns are waiting. The layout and read-budget probes use this
// the way a leak check uses a handle count: switching pages repeatedly has to
// come back to the same number.
export const pendingTeardowns = (): number => teardowns.size;

// Runs every registered teardown, newest attached first. One component failing
// to let go is never a reason to skip the rest of them: after this point the
// window is destroyed either way, and a teardown that throws would otherwise
// decide which of the others get to run.
export function disposeAll(): void {
  const tasks = [...teardowns].reverse();
  teardowns.clear();
  for (const task of tasks) {
    try {
      task();
    } catch {
      // Reported by whatever the next refresh shows; never by stopping here.
    }
  }
}
