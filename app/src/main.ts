// guit frontend bootstrap.
//
// `main.ts` wires the shell, the views and the dialogs together and owns
// the process-level wiring (events, keyboard, window hooks, the Tauri
// command bridge). All state lives in `state.ts`; every view and dialog
// receives the snapshot through it. The frontend never builds Git
// commands: every action is a semantic invoke of a Rust command.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import "./style.css";
import { el } from "./dom";
import {
  applySnapshot,
  currentSnapshot,
  isSessionActive,
  isWriteRunning,
  pushToast,
  setActiveView,
  setStatus,
  setWatchMode,
  setWriteRunning,
  subscribe,
  VIEW_ORDER,
} from "./state";
import type { OperationResult, SnapshotView, SyncProgress } from "./types";
import { createShell, type Shell } from "./shell";
import { createPreviewController } from "./dialogs/preview";
import { createAskpassDialog } from "./dialogs/askpass";
import { createToastLayer } from "./dialogs/toast";
import { initFontPx, currentFontPx, applyFontPx, FONT_DEFAULT } from "./font";
import { installWindowHooks, restoreWindowState, setAlwaysOnTop } from "./window";
import { createChangesView } from "./views/changes";
import { createHistoryView } from "./views/history";
import { createBranchesView } from "./views/branches";
import { createStashView } from "./views/stash";
import { createRemotesView } from "./views/remotes";
import { createWorktreesView } from "./views/worktrees";
import { createSettingsView } from "./views/settings";
import { createWelcomeView } from "./views/welcome";

const app = document.querySelector<HTMLElement>("#app");
if (!app) throw new Error("Application root is missing");

const showError = (error: unknown): void => {
  const message =
    error && typeof error === "object" && "message" in error
      ? String((error as { message: unknown }).message)
      : typeof error === "string"
        ? error
        : String(error);
  // A failure persists until the user closes it or retries; it is never
  // replaced by the next watcher refresh.
  pushToast({ level: "error", message });
};

// Declared here so the preview controller can name a focus fallback; the
// closure only runs once a dialog closes, long after `createShell` returns.
let shell: Shell;

const preview = createPreviewController(showError, () => shell.focusRail());
const askpass = createAskpassDialog(showError);
const toasts = createToastLayer();
document.body.append(askpass.element, toasts.element);

// --- shared cross-view state the branches view needs (branch/tag from commit) ---
let branchStartOid: string | null = null;
let tagStartOid: string | null = null;

// --- session lifecycle ---
let refreshingSession = false;
let sessionListeners: Array<(snapshot: SnapshotView | null) => void> = [];

async function refreshSession(silent: boolean): Promise<void> {
  if (!isSessionActive() || refreshingSession) return;
  refreshingSession = true;
  try {
    applySnapshot(await invoke<SnapshotView | null>("refresh_repository"));
  } catch (error) {
    if (!silent) showError(error);
  } finally {
    refreshingSession = false;
  }
}

async function openRepository(path: string): Promise<void> {
  // A pending confirmation ticket belongs to the closing session; the
  // backend would refuse it anyway, so drop the dialog up front.
  preview.close();
  try {
    const snapshot = await invoke<SnapshotView>("open_repository", { path });
    applySnapshot(snapshot);
    await renderRecent();
  } catch (error) {
    showError(error);
  }
}

async function pickRepository(): Promise<void> {
  try {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === "string") await openRepository(selected);
  } catch (error) {
    showError(error);
  }
}

async function closeRepository(): Promise<void> {
  try {
    await invoke("close_repository");
    applySnapshot(null);
  } catch (error) {
    showError(error);
  }
}

async function renderRecent(): Promise<void> {
  try {
    welcome.renderRecents(await invoke<string[]>("list_recent_repositories"));
  } catch (error) {
    showError(error);
    welcome.renderRecents([]);
  }
}

// --- views ---
const welcome = createWelcomeView({ openRepository, onError: showError });
const changes = createChangesView({ preview, onError: showError });
const branches = createBranchesView({
  preview,
  onError: showError,
  getBranchStartOid: () => branchStartOid,
  getTagStartOid: () => tagStartOid,
  clearBranchStartOid: () => { branchStartOid = null; },
  clearTagStartOid: () => { tagStartOid = null; },
});
const history = createHistoryView({
  preview,
  onError: showError,
  onBranchFromCommit(oid) {
    branchStartOid = oid;
    setActiveView("branches");
    branches.focusCreateField();
    setStatus(`New branch will start at ${oid.slice(0, 10)} — enter a name and press Create branch.`);
  },
  onTagFromCommit(oid) {
    tagStartOid = oid;
    setActiveView("branches");
    branches.focusCreateField();
    setStatus(`New tag will point at ${oid.slice(0, 10)} — enter a name and press Create tag.`);
  },
});
const stash = createStashView({ preview, onError: showError });
const remotes = createRemotesView({ preview, onError: showError });
const worktrees = createWorktreesView({ preview, onError: showError });
const settings = createSettingsView({ onError: showError });

// --- shell ---
shell = createShell({
  openRepository: () => void pickRepository(),
  refresh: () => void refreshSession(false),
  closeRepository: () => void closeRepository(),
  clone: () => {
    setActiveView("changes");
    setStatus("Use the welcome view to clone a repository.");
  },
  commit: () => shell.focusCommit(),
  cancelWrite: () => void invoke("cancel_write"),
  cancelTool: () => void invoke("cancel_exttool"),
  setOnTop: (value) => {
    void setAlwaysOnTop(value).catch(showError);
  },
  sync: (action) => remotes.run(action),
});

shell.registerView({ id: "welcome", element: welcome.element });
for (const view of [changes, history, branches, stash, remotes, worktrees]) {
  shell.registerView(view.descriptor);
}
shell.registerView(settings.descriptor);

app.replaceChildren(
  el("div", { class: "shell" }, [
    shell.appbar,
    el("div", { class: "shell-body" }, [shell.rail, shell.stage]),
    shell.statusbar,
  ]),
);

// --- rendering ---
let lastRenderedVersion = -2;

function render(): void {
  const snapshot = currentSnapshot();
  const version = snapshot === null ? -1 : snapshot.version;
  if (version !== lastRenderedVersion) {
    lastRenderedVersion = version;
    // Every view re-reads its own list once per accepted snapshot version;
    // a re-render of the same version never touches Git.
    for (const listener of sessionListeners) listener(snapshot);
    if (snapshot !== null) void preview.renew();
  }
  shell.render();
  changes.render();
  history.render();
  branches.render();
  stash.render();
  remotes.render();
  worktrees.render();
  settings.render();
  toasts.render();
}

// Register the per-view snapshot listeners.
for (const view of [changes, history, branches, stash, remotes, worktrees]) {
  sessionListeners.push(() => view.sync());
}
// A status-line change — including every streamed progress line of a fetch or
// push — repaints the status bar only. Everything else repaints the window.
subscribe((change) => {
  if (change === "status") shell.renderStatus();
  else render();
});

// --- destructive ticket confirmation routing ---
preview.onConfirm((pending) => {
  void (async () => {
    const { kind, nonce } = pending;
    switch (kind) {
      case "discard": return confirmTicket("discard_files", nonce, "Discarding work-tree changes…");
      case "clean": return confirmTicket("clean_files", nonce, "Deleting untracked files…");
      case "branch": return confirmTicket("delete_branch", nonce, "Deleting branch…", false, pending.branch.name);
      case "tag": return confirmTicket("delete_tag", nonce, "Deleting tag…");
      case "stashDrop": return confirmTicket("stash_drop", nonce, "Deleting stash entry…");
      case "stashPop": return confirmTicket("stash_pop", nonce, "Popping stash entry…");
      case "resetHard": return confirmTicket("reset_hard", nonce, "Hard resetting…");
      case "worktreeRemove": return confirmTicket("remove_worktree", nonce, "Removing worktree…");
      case "remoteRemove": return confirmTicket("remove_remote", nonce, "Removing remote…");
      case "remoteBranchDelete": return confirmTicket("delete_remote_branch", nonce, "Deleting remote branch…", true);
      case "forcePush": return confirmTicket("force_push", nonce, "Force-pushing…", true);
    }
  })();
});

async function confirmTicket(
  command: string,
  nonce: string,
  running: string,
  streamed = false,
  branchName: string | null = null,
): Promise<void> {
  if (isWriteRunning()) return;
  setWriteRunning(true);
  setStatus(running, "progress");
  let unlisten: (() => void) | undefined;
  if (streamed) {
    unlisten = await listen<SyncProgress>("sync-progress", ({ payload }) => setStatus(payload.line, "progress"));
  }
  try {
    const result = await invoke<OperationResult>(command, { nonce, interactive: false });
    applySnapshot(result.snapshot);
    setStatus(
      result.details ? `${result.message} ${result.details}` : result.message,
      result.outcome === "success" ? "success" : "error",
    );
    // Git refused an unmerged branch with -d: force is a *separate*
    // confirmation with a stronger warning, never an automatic retry.
    if (
      branchName !== null &&
      result.outcome === "failed" &&
      result.details?.toLowerCase().includes("not fully merged")
    ) {
      branches.offerForceDelete(branchName);
    }
  } catch (error) {
    showError(error);
    setStatus("The operation did not run.", "error");
  } finally {
    unlisten?.();
    setWriteRunning(false);
  }
}

// --- events ---
void listen<SnapshotView>("repo-refreshed", ({ payload }) => applySnapshot(payload));
void listen<{ mode: string }>("watch-status", ({ payload }) => {
  setWatchMode(payload.mode === "poll" ? "poll" : payload.mode === "none" ? "none" : "events");
});

// --- keyboard ---
// Zoom and theme are restored before the first paint of the shell.
initFontPx();

window.addEventListener("keydown", (event) => {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
  const key = event.key.toLowerCase();
  if (key === "r") {
    event.preventDefault();
    if (isSessionActive()) void refreshSession(false);
  } else if (key === "o") {
    event.preventDefault();
    void pickRepository();
  } else if (key >= "1" && key <= "7") {
    event.preventDefault();
    const next = VIEW_ORDER[Number(key) - 1];
    // Only Settings is meaningful before a repository is open; the rail
    // greys the rest out, so the shortcut must not jump past that.
    if (next === "settings" || isSessionActive()) setActiveView(next);
  } else if (key === "=" || key === "+") {
    event.preventDefault();
    applyFontPx(currentFontPx() + 1);
  } else if (key === "-") {
    event.preventDefault();
    applyFontPx(currentFontPx() - 1);
  } else if (key === "0") {
    event.preventDefault();
    applyFontPx(FONT_DEFAULT);
  }
});

// --- boot ---
void (async () => {
  try {
    const restored = await invoke<SnapshotView | null>("restore_repository");
    applySnapshot(restored);
  } catch (error) {
    // A refused session (future schema, unreadable file) must still leave
    // the full empty-state interface on screen, not a half-rendered shell.
    showError(error);
    applySnapshot(null);
  }
  await renderRecent();
  try {
    await restoreWindowState();
  } catch (error) {
    showError(error);
  }
  try {
    await installWindowHooks({
      onGeometryChange: (text) => settings.noteGeometry(text),
      onFocus: () => void refreshSession(true),
      onError: showError,
    });
  } catch (error) {
    showError(error);
  }
  render();
})();
