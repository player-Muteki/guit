// The smallest host a panel view can be built against.
//
// A view module reaches for the window it lives in as soon as it is imported — the
// Settings page asks for the current window's label so the size controls can talk to
// it later. Under an engine probe there is no host, and one undefined global turns the
// whole probe into a module-evaluation error rather than a measurement. So the probe
// supplies what those calls read, and answers every request with a null the callers
// already treat as "the host did not say".
//
// Nothing in the panel imports this file. It is for probes only, and it must be the
// first import of a probe that builds a view, because an ES module is evaluated before
// the module that imports it reads anything.

interface ProbeInternals {
  metadata: { currentWindow: { label: string } };
  invoke(request: unknown): Promise<unknown>;
  transformCallback(callback?: (value: unknown) => void): number;
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: ProbeInternals;
  }
}

const callbacks = new Map<number, (value: unknown) => void>();
let nextId = 1;

window.__TAURI_INTERNALS__ = {
  metadata: { currentWindow: { label: "main" } },
  // A command the panel would normally await is answered with the same value the
  // frontend reads when the backend has nothing to report, so the view takes its
  // existing no-answer path instead of a rejection.
  invoke: async () => null,
  transformCallback: (callback?: (value: unknown) => void) => {
    const id = nextId;
    nextId += 1;
    if (callback) callbacks.set(id, callback);
    return id;
  },
};

export {};
