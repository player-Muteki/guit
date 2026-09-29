import assert from "node:assert/strict";
import test from "node:test";
import {
  applySnapshot,
  currentSnapshot,
  dismissToast,
  pushToast,
  setPendingPreview,
  setStatus,
  setWatchMode,
  setWriteRunning,
  subscribe,
  toastStack,
  isWriteRunning,
  watchStatus,
  statusLine,
  snapshotVersion,
} from "../src/state.ts";

const snapshot = (version) => ({
  version,
  sessionId: 1,
  historyGeneration: 0,
  refsGeneration: 0,
  repo: { openPath: "/tmp/r", root: "/tmp/r", gitDir: "/tmp/r/.git", bare: false, linkedWorktree: false },
  branch: { name: "main", headState: "branch", oid: "a".repeat(40), upstream: null, ahead: null, behind: null },
  files: [],
  operation: null,
  inflight: [],
});

test("a snapshot only moves forward", () => {
  assert.equal(applySnapshot(snapshot(5)), true);
  assert.equal(snapshotVersion(), 5);
  // An older snapshot addresses the wrong per-snapshot file ids, so it is
  // refused rather than rendered.
  assert.equal(applySnapshot(snapshot(4)), false);
  assert.equal(snapshotVersion(), 5);
  assert.equal(applySnapshot(snapshot(5)), false);
  assert.equal(applySnapshot(snapshot(6)), true);
  assert.equal(snapshotVersion(), 6);
});

test("toasts append and never replace an earlier failure", () => {
  for (const id of [...toastStack()].map((toast) => toast.id)) dismissToast(id);
  const first = pushToast({ level: "error", message: "first failure" });
  const second = pushToast({ level: "error", message: "second failure" });
  const messages = toastStack().map((toast) => toast.message);
  assert.deepEqual(messages, ["first failure", "second failure"]);
  assert.ok(first !== second, "each toast gets its own id");

  dismissToast(first);
  assert.deepEqual(toastStack().map((toast) => toast.message), ["second failure"]);
  // Dismissing an id that is no longer on the stack changes nothing.
  dismissToast(first);
  assert.equal(toastStack().length, 1);
});

test("the toast stack is capped and drops the oldest entry", () => {
  for (const id of [...toastStack()].map((toast) => toast.id)) dismissToast(id);
  for (let index = 0; index < 6; index += 1) {
    pushToast({ level: "error", message: `failure ${index}` });
  }
  const messages = toastStack().map((toast) => toast.message);
  assert.equal(messages.length, 4, "the stack is capped at four");
  assert.deepEqual(messages, ["failure 2", "failure 3", "failure 4", "failure 5"]);
});

test("the busy lanes, watch mode and status line are readable", () => {
  setWriteRunning(true);
  assert.equal(isWriteRunning(), true);
  setWriteRunning(false);
  assert.equal(isWriteRunning(), false);

  setWatchMode("poll");
  assert.equal(watchStatus(), "poll");
  setWatchMode("events");
  assert.equal(watchStatus(), "events");

  setStatus("Deleting branch…", "progress");
  assert.deepEqual(statusLine(), { kind: "progress", message: "Deleting branch…" });
  setStatus("");
  assert.equal(statusLine().message, "");

  setPendingPreview(null);
  assert.equal(currentSnapshot() === null, false, "a snapshot is still the live one");
});

test("a progress line repaints the status bar, not the whole window", () => {
  const changes = [];
  const unsubscribe = subscribe((change) => changes.push(change));
  try {
    setStatus("Cleaning files: 40%", "progress");
    assert.deepEqual(changes, ["status"], "one streamed line must not cost a window render");
    setWatchMode("poll");
    assert.deepEqual(changes, ["status", "status"], "the monitor line lives in the status bar");
    setWriteRunning(true);
    assert.deepEqual(changes.slice(2), ["render"], "a busy lane repaints the window");
  } finally {
    unsubscribe();
    setWriteRunning(false);
    setStatus("", "idle");
  }
});

test("a subscriber can stop listening", () => {
  const changes = [];
  const unsubscribe = subscribe((change) => changes.push(change));
  unsubscribe();
  setStatus("nobody is listening", "info");
  assert.deepEqual(changes, []);
  setStatus("", "idle");
});
