// Teardown is the part of a component that no render shows.
//
// A resize observer, a document key handler and a one-shot timer all look the
// same while the window is open and all behave differently once it is not. The
// panel registers each of them here, so these cases pin the three properties the
// close path depends on: everything runs, one broken component cannot stop the
// others, and a component that already let go is not asked to.

import assert from "node:assert/strict";
import test from "node:test";
import { disposeAll, onDispose, pendingTeardowns } from "../src/lifecycle.ts";

test("every registered teardown runs, newest attached first", () => {
  const order = [];
  onDispose(() => order.push("first"));
  onDispose(() => order.push("second"));
  onDispose(() => order.push("third"));
  assert.equal(pendingTeardowns(), 3);
  disposeAll();
  assert.deepEqual(order, ["third", "second", "first"]);
  assert.equal(pendingTeardowns(), 0);
});

test("one component failing to let go does not decide who else gets to", () => {
  const ran = [];
  onDispose(() => ran.push("after"));
  onDispose(() => { throw new Error("the observer was already disconnected"); });
  onDispose(() => ran.push("before"));
  disposeAll();
  assert.deepEqual(ran.sort(), ["after", "before"]);
  assert.equal(pendingTeardowns(), 0, "a throwing teardown is not left registered");
});

test("a component that came and went is not asked again", () => {
  let closed = 0;
  const stop = onDispose(() => { closed += 1; });
  stop();
  assert.equal(pendingTeardowns(), 0);
  disposeAll();
  assert.equal(closed, 0);
});

test("the same function registered twice lets go once", () => {
  // Entries are keyed by what they do, not by who registered them: a component
  // that rebuilds and re-registers the same `disconnect` cannot stack a second
  // copy of it every time.
  let calls = 0;
  const task = () => { calls += 1; };
  onDispose(task);
  onDispose(task);
  assert.equal(pendingTeardowns(), 1);
  disposeAll();
  assert.equal(calls, 1);
});

test("registering during teardown runs in the next round, not this one", () => {
  let added = 0;
  onDispose(() => {
    onDispose(() => { added += 1; });
  });
  disposeAll();
  assert.equal(added, 0, "the close pass never runs a teardown that was added by a teardown");
  assert.equal(pendingTeardowns(), 1);
  disposeAll();
  assert.equal(added, 1);
});
