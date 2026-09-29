// Single state layer for the shell, the views and the dialogs.
//
// The backend already orders snapshots with a monotonic `version`; this
// module owns the frontend mirror of that invariant: an older snapshot must
// never replace a newer one, and every accepted change notifies the
// renderer once. Busy lanes (`writeRunning`, `toolRunning`), the pending
// preview ticket, the active view, the status line and the toast stack live
// here so the shell and the views never keep divergent copies.

import type {
  SnapshotView,
  StatusKind,
  StatusLine,
  Toast,
} from "./types";

// The panel has exactly two top-level destinations. Everything else that
// looks like a page — the repository entry, the branch overlay, a confirm
// dialog — is a state inside one of these two, never a third tab.
export type ViewId = "main" | "settings";

export const VIEW_ORDER: readonly ViewId[] = ["main", "settings"];

export type PendingPreview =
  | {
      kind: "discard" | "clean";
      names: string[];
      dropped: string[];
      nonce: string;
      branch?: undefined;
      tag?: undefined;
      stash?: undefined;
      reset?: undefined;
      worktree?: undefined;
    }
  | {
      kind: "branch";
      names: string[];
      dropped: string[];
      nonce: string;
      branch: { name: string; force: boolean; targetOid: string | null };
      tag?: undefined;
      stash?: undefined;
      reset?: undefined;
      worktree?: undefined;
    }
  | {
      kind: "tag";
      names: string[];
      dropped: string[];
      nonce: string;
      branch?: undefined;
      tag: { name: string; targetOid: string | null };
      stash?: undefined;
      reset?: undefined;
      worktree?: undefined;
    }
  | {
      kind: "stashDrop" | "stashPop";
      names: string[];
      dropped: string[];
      nonce: string;
      branch?: undefined;
      tag?: undefined;
      stash: { index: number; targetOid: string | null };
      reset?: undefined;
      worktree?: undefined;
    }
  | {
      kind: "resetHard";
      names: string[];
      dropped: string[];
      nonce: string;
      branch?: undefined;
      tag?: undefined;
      stash?: undefined;
      reset: { target: string };
      worktree?: undefined;
    }
  | {
      kind: "worktreeRemove";
      names: string[];
      dropped: string[];
      nonce: string;
      branch?: undefined;
      tag?: undefined;
      stash?: undefined;
      reset?: undefined;
      worktree: { index: number; targetOid: string | null };
    };

let sessionActive = false;
let snapshot: SnapshotView | null = null;
let write = false;
let tool = false;
let preview: PendingPreview | null = null;
let view: ViewId = "main";
let watchMode: "none" | "poll" | "events" = "none";
let watchFailed = false;
let status: StatusLine = { kind: "idle", message: "" };
let nextToastId = 1;
let toasts: Toast[] = [];

type Listener = (change: ChangeKind) => void;
const listeners = new Set<Listener>();

// `status` repaints the status bar only; `render` repaints the whole window.
// A running write can emit dozens of progress lines per second, and each one
// used to cost a render of every view, hidden or not.
export type ChangeKind = "status" | "render";

function notify(change: ChangeKind): void {
  for (const listener of listeners) listener(change);
}

const renderNow = (): void => notify("render");

// Returns the way to stop listening, so a caller that only exists for as long
// as a dialog is open cannot leave a listener behind.
export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const isSessionActive = (): boolean => sessionActive;
export const currentSnapshot = (): SnapshotView | null => snapshot;
export const snapshotVersion = (): number => snapshot === null ? -1 : snapshot.version;
export const isWriteRunning = (): boolean => write;
export const isToolRunning = (): boolean => tool;
export const pendingPreview = (): PendingPreview | null => preview;
export const activeView = (): ViewId => view;
export const watchStatus = (): "none" | "poll" | "events" => watchMode;
export const isWatchFailed = (): boolean => watchFailed;
export const statusLine = (): StatusLine => status;
export const toastStack = (): readonly Toast[] => toasts;

// Accepts a snapshot only when it is strictly newer than the one on screen
// (file IDs are per-snapshot, so an older one would address the wrong paths).
// Returns true when the snapshot was accepted.
export function applySnapshot(next: SnapshotView | null): boolean {
  if (next && snapshot && next.version <= snapshot.version) return false;
  snapshot = next;
  sessionActive = next !== null;
  renderNow();
  return true;
}

export function setWriteRunning(value: boolean): void {
  if (write === value) return;
  write = value;
  renderNow();
}

export function setToolRunning(value: boolean): void {
  if (tool === value) return;
  tool = value;
  renderNow();
}

export function setPendingPreview(next: PendingPreview | null): void {
  if (preview === next) return;
  preview = next;
  renderNow();
}

export function setActiveView(next: ViewId): void {
  if (view === next) return;
  view = next;
  renderNow();
}

// Both of these only ever repaint the status bar, so they are the two places
// a `status` change comes from.
export function setWatchMode(mode: "none" | "poll" | "events"): void {
  if (watchMode === mode) return;
  watchMode = mode;
  notify("status");
}

export function setWatchFailed(value: boolean): void {
  if (watchFailed === value) return;
  watchFailed = value;
  notify("status");
}

export function setStatus(message: string, kind: StatusKind = "info"): void {
  if (status.kind === kind && status.message === message) return;
  status = { kind, message };
  notify("status");
}

export function pushToast(toast: Omit<Toast, "id">): number {
  const id = nextToastId++;
  toasts = [...toasts, { ...toast, id }].slice(-4);
  renderNow();
  return id;
}

export function dismissToast(id: number): void {
  const next = toasts.filter((toast) => toast.id !== id);
  if (next.length === toasts.length) return;
  toasts = next;
  renderNow();
}

// Interface zoom repaints everything: the virtual lists derive their row height
// from the root font size, so a stale render would scroll against the wrong
// geometry, and Settings' own size readout only updates on a repaint.
export function notifyLayoutChange(): void {
  renderNow();
}
