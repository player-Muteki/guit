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
  applyActivity,
  applySnapshot,
  currentSnapshot,
  isSessionActive,
  isWriteRunning,
  pushToast,
  setActiveView,
  setStatus,
  setWatchMode,
  setWatchFailed,
  setWriteRunning,
  statusLine,
  subscribe,
  VIEW_ORDER,
} from "./state";
import type { ActivityView, OperationResult, SnapshotView } from "./types";
import { createShell, type Shell } from "./shell";
import { disposeAll, onDispose } from "./lifecycle";
import { publishSnapshot, subscribeToDomain } from "./snapshotBus";
import { createPreviewController } from "./dialogs/preview";
import { createToastLayer } from "./dialogs/toast";
import { startAppearance, currentFontPx, applyFontPx, FONT_DEFAULT } from "./font";
import { disableTheme, startTheme, verifyThemeLaunch } from "./theme";
import { closeWindow, installWindowHooks, minimizeWindow, restoreWindowState, setAlwaysOnTop, toggleMaximized } from "./window";
import { createChangesView } from "./views/changes";
import { createHistoryView } from "./views/history";
import { createBranchesView } from "./views/branches";
import { createSettingsView } from "./views/settings";
import { createWelcomeView } from "./views/welcome";
import { createMainPanel } from "./views/mainPanel";

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

const preview = createPreviewController(showError, () => shell.focusTabs());
const toasts = createToastLayer();
document.body.append(toasts.element);

// --- shared cross-view state the branches view needs (branch/tag from commit) ---
let branchStartOid: string | null = null;
let tagStartOid: string | null = null;

// --- session lifecycle ---
let refreshingSession = false;

async function refreshSession(silent: boolean): Promise<void> {
  if (!isSessionActive() || refreshingSession) return;
  refreshingSession = true;
  try {
    applySnapshot(await invoke<SnapshotView | null>("refresh_repository"));
    setWatchFailed(false);
  } catch (error) {
    setWatchFailed(true);
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
    setActiveView("main");
    shell.openOverlay();
    branches.focusCreateField();
    setStatus(`New branch will start at ${oid.slice(0, 10)} — enter a name and press Create branch.`);
  },
  onTagFromCommit(oid) {
    tagStartOid = oid;
    setActiveView("main");
    shell.openOverlay();
    branches.focusCreateField();
    setStatus(`New tag will point at ${oid.slice(0, 10)} — enter a name and press Create tag.`);
  },
});
// The interval row is the one setting this page does not keep: the timer it
// changes lives with the age line, so asking the changes view is what keeps the
// panel to a single repeating timer no matter how often the row is used.
const settings = createSettingsView({
  onError: showError,
  currentInterval: () => changes.currentInterval(),
  applyInterval: (requested) => changes.applyInterval(requested),
});

// --- shell ---
shell = createShell({
  openRepository: () => void pickRepository(),
  refresh: () => void refreshSession(false),
  closeRepository: () => void closeRepository(),
  commit: () => shell.focusCommit(),
  cancelWrite: () => void invoke("cancel_write"),
  cancelTool: () => void invoke("cancel_exttool"),
  // The four window actions are awaited and a refusal is shown as the failure it is;
  // `window.ts` announces whatever the desktop actually agreed to, and the shell repaints
  // from that announcement. So a pin the desktop refused is reported as a refusal and
  // reads as unpinned, in the same breath.
  setOnTop: (value) => {
    void setAlwaysOnTop(value).catch(showError);
  },
  minimize: () => {
    void minimizeWindow().catch(showError);
  },
  toggleMaximize: () => {
    void toggleMaximized().catch(showError);
  },
  closeWindow: () => {
    void closeWindow().catch(showError);
  },
});

// The main panel and the branch overlay are the only two places a repository
// view goes: the files and the graph share one page, the picker covers it.
shell.registerView({ id: "welcome", element: welcome.element });
shell.registerView(createMainPanel(changes.element, history.element));
shell.registerView(settings.descriptor);
// The picker reads the names on the way in, which is what lets a snapshot pass
// over it while it is closed.
shell.registerOverlay(branches.element, () => branches.sync());

app.replaceChildren(
  el("div", { class: "shell" }, [
    shell.appbar,
    el("div", { class: "shell-body" }, [shell.stage]),
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
    // One snapshot, published once: only the domains of it that actually moved
    // are asked for anything, and a re-render of the same version never touches
    // Git at all.
    publishSnapshot(snapshot);
    if (snapshot !== null) void preview.renew();
  }
  shell.render();
  changes.render();
  history.render();
  branches.render();
  settings.render();
  toasts.render();
}

// The two reads the panel has a place on screen for: the history of the branch
// it is drawing, and the names the picker lists while the picker is up. The
// changed files need no read of their own — they are already in the snapshot.
onDispose(subscribeToDomain("graph", () => history.sync()));
onDispose(subscribeToDomain("refs", () => {
  if (shell.isOverlayOpen()) branches.sync();
}));

// A status-line change — including every streamed progress line of a running
// write — repaints the status bar only. Everything else repaints the window.
onDispose(
  subscribe((change) => {
    if (change === "status") shell.renderStatus();
    else render();
  }),
);

// --- destructive ticket confirmation routing ---
preview.onConfirm((pending) => {
  void (async () => {
    const { kind, nonce } = pending;
    switch (kind) {
      case "discard": return confirmTicket("discard_files", nonce, "Discarding work-tree changes…");
      case "clean": return confirmTicket("clean_files", nonce, "Deleting untracked files…");
      case "branch": return confirmTicket("delete_branch", nonce, "Deleting branch…", pending.branch.name);
      case "tag": return confirmTicket("delete_tag", nonce, "Deleting tag…");
      case "stashDrop": return confirmTicket("stash_drop", nonce, "Deleting stash entry…");
      case "stashPop": return confirmTicket("stash_pop", nonce, "Popping stash entry…");
      case "resetHard": return confirmTicket("reset_hard", nonce, "Hard resetting…");
      case "worktreeRemove": return confirmTicket("remove_worktree", nonce, "Removing worktree…");
    }
  })();
});

async function confirmTicket(
  command: string,
  nonce: string,
  running: string,
  branchName: string | null = null,
): Promise<void> {
  if (isWriteRunning()) return;
  setWriteRunning(true);
  setStatus(running, "progress");
  try {
    const result = await invoke<OperationResult>(command, { nonce });
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
    setWriteRunning(false);
  }
}

// --- closing ---
// guit does not kill a Git process on the way out. Cancelling is the operation's
// own kill path — it takes the process group down and reports what died — and it
// is a choice the user made, in the status line, about an operation they started.
// Nothing on the exit path can make that choice for them: a `git clean` cut off
// halfway can leave files deleted and no report of it, and a commit stopped
// between its object write and its ref update leaves an index lock behind. So an
// operation in flight is left running, and the close that would have stranded it
// is refused until it is *deliberately* accepted through the named button, which
// is the only thing that can release the hold.
let closeAccepted = false;

const vetoClose = (): boolean => {
  // Taken off the table whatever happens next: an acceptance is good for the one
  // press that asked for it, never for a later operation.
  const accepted = closeAccepted;
  closeAccepted = false;
  if (accepted || !isWriteRunning()) return false;
  pushToast({
    level: "warning",
    message: `${statusLine().message} is still running, and guit does not stop a Git operation to close its window. ` +
      "Cancel it in the status line, or close with it still running.",
    actions: [
      {
        label: "Close anyway",
        run: () => {
          closeAccepted = true;
          void closeWindow().catch(showError);
        },
      },
    ],
  });
  return true;
};

// --- events ---
// The backend pushes these for as long as the session lives, so the way to
// stop them is kept rather than dropped.
void listen<SnapshotView>("repo-refreshed", ({ payload }) => applySnapshot(payload)).then(
  (unlisten) => { onDispose(unlisten); },
);
void listen<{ mode: string; failed: boolean }>("watch-status", ({ payload }) => {
  setWatchMode(payload.mode === "poll" ? "poll" : payload.mode === "none" ? "none" : "events");
  setWatchFailed(payload.failed);
}).then((unlisten) => { onDispose(unlisten); });
// The age of the newest touched file is pushed beside the snapshot, never
// inside it, and it carries the session that measured it. Only the line it
// belongs to is repainted — the files and the graph have already answered the
// snapshot that came with it.
void listen<ActivityView>("activity-updated", ({ payload }) => {
  if (applyActivity(payload)) changes.renderActivity();
}).then((unlisten) => { onDispose(unlisten); });

// --- keyboard ---
// The stored appearance is applied before the first paint of the shell. The custom
// theme goes on the same path for the same reason: a person with a working fragment
// should not watch the built-in look flash past it. Whatever a start had to decide on
// the person's behalf is a sentence for the Settings row, and `null` is a start with
// nothing to say.
startAppearance();
settings.noteTheme(startTheme());

window.addEventListener("keydown", (event) => {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
  const key = event.key.toLowerCase();
  if (key === "r") {
    event.preventDefault();
    if (isSessionActive()) void refreshSession(false);
  } else if (key === "o") {
    event.preventDefault();
    void pickRepository();
  } else if (key === "1" || key === "2") {
    event.preventDefault();
    // Both pages answer the shortcut from a cold start: Main is the empty
    // state with nothing to open, Settings never needed a repository.
    setActiveView(VIEW_ORDER[Number(key) - 1]);
  } else if (key === "=" || key === "+") {
    event.preventDefault();
    applyFontPx(currentFontPx() + 1);
  } else if (key === "-") {
    event.preventDefault();
    applyFontPx(currentFontPx() - 1);
  } else if (key === "0") {
    event.preventDefault();
    applyFontPx(FONT_DEFAULT);
  } else if (key === "t" && event.shiftKey) {
    // The one recovery entry a theme cannot take away: a listener on the window is
    // installed before any fragment is drawn and is not a node a stylesheet can hide.
    // It is the same action as the button on the Settings page, so the row that
    // explains the screen gets the same report either way.
    event.preventDefault();
    settings.noteTheme(disableTheme());
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
      vetoClose,
      onClosing: () => disposeAll(),
      onError: showError,
    });
  } catch (error) {
    showError(error);
  }
  // The other half of the theme start, before this page is first drawn: the check
  // needs a laid-out shell, which it has been since the shell was mounted, and the
  // Settings row is filled by `render()` straight after, so a revert here is what that
  // row ends up saying. A boot that never reaches this line leaves its marker in
  // storage, and the next start draws no theme.
  settings.noteTheme(verifyThemeLaunch());
  render();
})();
