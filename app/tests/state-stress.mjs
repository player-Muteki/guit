// Stress suite for the single frontend state layer: snapshot monotonicity,
// listener plumbing, change-dedup guards, and the bounded toast stack.
// Owned by the test effort; runs alongside tests/state.mjs in its own
// process, so module-level state is not shared between them.

import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import {
  activeView,
  applySnapshot,
  currentSnapshot,
  dismissToast,
  isSessionActive,
  isToolRunning,
  isWriteRunning,
  notifyLayoutChange,
  pendingPreview,
  pushToast,
  setActiveView,
  setPendingPreview,
  setStatus,
  setToolRunning,
  setWatchMode,
  setWriteRunning,
  snapshotVersion,
  statusLine,
  subscribe,
  toastStack,
  VIEW_ORDER,
  watchStatus,
} from "../src/state.ts";
import { mulberry32, pick, randomInt } from "./helpers/rng.mjs";

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

// state.ts is module-level mutable state shared by every test in this file;
// each test starts from a known-clean mirror of a cold app.
function resetState() {
  applySnapshot(null);
  for (const toast of [...toastStack()]) dismissToast(toast.id);
  setWriteRunning(false);
  setToolRunning(false);
  setPendingPreview(null);
  setActiveView("main");
  setWatchMode("none");
  setStatus("", "idle");
}

beforeEach(resetState);

test("the fresh state matches a cold start", () => {
  assert.equal(currentSnapshot(), null);
  assert.equal(snapshotVersion(), -1);
  assert.equal(isSessionActive(), false);
  assert.equal(isWriteRunning(), false);
  assert.equal(isToolRunning(), false);
  assert.equal(pendingPreview(), null);
  assert.equal(activeView(), "main");
  assert.equal(watchStatus(), "none");
  assert.deepEqual(statusLine(), { kind: "idle", message: "" });
  assert.deepEqual(toastStack(), []);
  assert.equal(VIEW_ORDER.length, 2);
  assert.equal(new Set(VIEW_ORDER).size, 2, "view ids are unique");
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

test("5000 snapshots arriving out of order only ever accept a strict increase", () => {
  const rand = mulberry32(0x5eed);
  let acceptedHighest = -Infinity;
  for (let i = 0; i < 5000; i += 1) {
    const candidate = randomInt(rand, 10000);
    const accepted = applySnapshot(snapshot(candidate));
    assert.equal(accepted, candidate > acceptedHighest, `version ${candidate} after ${acceptedHighest}`);
    if (accepted) acceptedHighest = candidate;
    assert.equal(snapshotVersion(), acceptedHighest);
    assert.equal(isSessionActive(), true);
  }
});

test("closing the session accepts any later snapshot, even a lower version", () => {
  assert.equal(applySnapshot(snapshot(9)), true);
  assert.equal(applySnapshot(null), true);
  assert.equal(isSessionActive(), false);
  assert.equal(snapshotVersion(), -1);
  // A new repository starts its own version counter; a stale high water mark
  // from the old one must not veto the new session's page-zero snapshot.
  assert.equal(applySnapshot(snapshot(1)), true);
  assert.equal(snapshotVersion(), 1);
});

test("render changes notify listeners as render, status changes as status", () => {
  const seen = [];
  const stop = subscribe((change) => seen.push(change));
  applySnapshot(snapshot(2));
  assert.deepEqual(seen, ["render"]);
  setStatus("working", "progress");
  assert.deepEqual(seen, ["render", "status"]);
  setWatchMode("events");
  assert.deepEqual(seen, ["render", "status", "status"]);
  stop();
  setStatus("after unsubscribe", "info");
  assert.equal(seen.length, 3, "an unsubscribed listener hears nothing");
});

test("every setter that repaints the window is guarded against no-op writes", () => {
  const kinds = [];
  const stop = subscribe((change) => kinds.push(change));
  setWriteRunning(false); // already false
  setToolRunning(false);
  setWatchMode("none");
  setStatus("", "idle");
  setActiveView("main");
  setPendingPreview(null);
  assert.deepEqual(kinds, [], "no-ops must not notify");
  setWriteRunning(true);
  setToolRunning(true);
  assert.deepEqual(kinds, ["render", "render"]);
  setWriteRunning(true);
  setToolRunning(true);
  assert.equal(kinds.length, 2, "setting the same value twice notifies once");
  stop();
});

test("a preview ticket set twice with the same object notifies once, a fresh object notifies again", () => {
  const preview = { kind: "discard", names: ["a.txt"], dropped: [], nonce: "n1" };
  setPendingPreview(preview);
  assert.equal(pendingPreview(), preview);
  const kinds = [];
  const stop = subscribe((change) => kinds.push(change));
  setPendingPreview(preview);
  assert.deepEqual(kinds, []);
  const sameButNew = { ...preview };
  setPendingPreview(sameButNew);
  assert.deepEqual(kinds, ["render"], "identity, not deep equality, guards the ticket");
  stop();
});

test("notifyLayoutChange repaints unconditionally", () => {
  const kinds = [];
  const stop = subscribe((change) => kinds.push(change));
  notifyLayoutChange();
  notifyLayoutChange();
  assert.deepEqual(kinds, ["render", "render"]);
  stop();
});

test("subscribing the same listener twice registers it once", () => {
  let calls = 0;
  const listener = () => { calls += 1; };
  const stop1 = subscribe(listener);
  subscribe(listener);
  notifyLayoutChange();
  assert.equal(calls, 1, "the listener set must not double-fire");
  stop1();
  notifyLayoutChange();
  assert.equal(calls, 1, "one unsubscribe removes the single registration");
});

test("listeners do not leak across 200 subscribe/unsubscribe cycles", () => {
  let calls = 0;
  notifyLayoutChange();
  for (let i = 0; i < 200; i += 1) {
    const stop = subscribe(() => { calls += 1; });
    stop();
  }
  calls = 0;
  notifyLayoutChange();
  assert.equal(calls, 0, "every temporary listener is gone");
});

test("1000 interleaved pushes and dismissals keep the stack bounded and ids unique", () => {
  const rand = mulberry32(0xb33f);
  const live = new Set();
  const issued = new Set();
  for (let i = 0; i < 1000; i += 1) {
    if (live.size === 0 || rand() < 0.6) {
      const id = pushToast({ level: pick(rand, ["error", "info", "warn"]), message: `m${i}` });
      assert.ok(!issued.has(id), "toast ids are never reused");
      issued.add(id);
      live.add(id);
    } else {
      const ids = [...live];
      const id = pick(rand, ids);
      dismissToast(id);
      live.delete(id);
    }
    const stack = toastStack();
    assert.ok(stack.length <= 4, "the stack stays capped at four");
    const ids = stack.map((t) => t.id);
    assert.equal(new Set(ids).size, ids.length, "no duplicate ids on the stack");
    assert.deepEqual(ids, [...ids].sort((a, b) => a - b), "the stack stays in push order");
  }
});

test("the cap drops the oldest and the newest four survive", () => {
  for (let i = 0; i < 6; i += 1) pushToast({ level: "error", message: `failure ${i}` });
  assert.deepEqual(
    toastStack().map((t) => t.message),
    ["failure 2", "failure 3", "failure 4", "failure 5"],
  );
});

test("dismissToast does not mutate the array handed out before it", () => {
  const id = pushToast({ level: "error", message: "gone" });
  const before = toastStack();
  dismissToast(id);
  assert.equal(before.length, 1, "a snapshot of the stack stays stable");
  assert.equal(toastStack().length, 0);
});

test("dismissing an absent id is silent", () => {
  const id = pushToast({ level: "error", message: "here" });
  const kinds = [];
  const stop = subscribe((change) => kinds.push(change));
  dismissToast(id + 9999);
  assert.deepEqual(kinds, [], "a no-op dismissal does not repaint");
  dismissToast(id);
  assert.deepEqual(kinds, ["render"]);
  stop();
});

test("setStatus repaints when only the kind changes", () => {
  setStatus("same words", "info");
  const kinds = [];
  const stop = subscribe((change) => kinds.push(change));
  setStatus("same words", "error");
  assert.deepEqual(kinds, ["status"]);
  assert.deepEqual(statusLine(), { kind: "error", message: "same words" });
  stop();
});

test("setStatus documents the live line object it hands out", () => {
  setStatus("held", "info");
  const line = statusLine();
  assert.equal(line.message, "held");
  // The getter exposes the internal object; a later setStatus replaces it
  // wholesale, so mutating the old reference cannot corrupt the new state.
  line.message = "tampered";
  setStatus("next", "info");
  assert.deepEqual(statusLine(), { kind: "info", message: "next" });
});
