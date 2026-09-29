// The snapshot fan-out decides which component may go back to Git.
//
// It is the one place the panel trades a refresh for reads, so both directions
// of the mistake are expensive in opposite ways: fire on everything and a live
// repository pays six Git reads per refresh again; fire on nothing and the
// branch picker shows names that no longer exist. These tests pin the exact
// field each domain follows, the one state that is not a change at all (a newer
// version of the same content), and the one that is not a read (a session that
// has closed).

import assert from "node:assert/strict";
import test from "node:test";
import {
  domainSubscriptions,
  publishSnapshot,
  SNAPSHOT_DOMAINS,
  subscribeToDomain,
} from "../src/snapshotBus.ts";

const branch = (over) => ({
  name: "main",
  headState: "branch",
  oid: "a".repeat(40),
  upstream: "origin/main",
  ahead: 0,
  behind: 0,
  ...over,
});

const snapshot = (over = {}) => ({
  version: 1,
  repo: { openPath: "/tmp/one", root: "/tmp/one", gitDir: "/tmp/one/.git", bare: false, linkedWorktree: false },
  branch: branch({}),
  files: [],
  operation: null,
  ...over,
});

// Every case starts from a closed session, which is also how the module forgets
// what it has already seen.
const fresh = () => {
  publishSnapshot(null);
  const calls = { graph: 0, refs: 0 };
  const detach = SNAPSHOT_DOMAINS.map((domain) =>
    subscribeToDomain(domain, () => { calls[domain] += 1; }),
  );
  return { calls, stop: () => detach.forEach((fn) => fn()) };
};

test("a newer version of the same content asks for nothing", () => {
  const { calls, stop } = fresh();
  publishSnapshot(snapshot({ version: 1 }));
  assert.deepEqual([calls.graph, calls.refs], [1, 1]);
  publishSnapshot(snapshot({ version: 2 }));
  publishSnapshot(snapshot({ version: 3 }));
  assert.deepEqual([calls.graph, calls.refs], [1, 1], "the version alone is not a change");
  stop();
});

test("the graph follows the branch it draws, and nothing else", () => {
  const { calls, stop } = fresh();
  publishSnapshot(snapshot({}));
  calls.graph = 0;
  calls.refs = 0;
  publishSnapshot(snapshot({ files: [{ id: 1 }], branch: branch({ ahead: 4 }) }));
  assert.equal(calls.graph, 0, "a detached head is not a different head");
  publishSnapshot(snapshot({ branch: branch({ oid: "b".repeat(40) }) }));
  assert.equal(calls.graph, 1);
  stop();
});

test("the ref listing answers the head and the operation, not a repaint", () => {
  const { calls, stop } = fresh();
  publishSnapshot(snapshot({}));
  calls.graph = 0;
  calls.refs = 0;
  publishSnapshot(snapshot({ operation: { kind: "merge", subject: "x", step: null, total: null } }));
  assert.deepEqual([calls.graph, calls.refs], [0, 1], "a merge in progress moves names");
  publishSnapshot(snapshot({ branch: branch({ behind: 2 }) }));
  assert.deepEqual([calls.graph, calls.refs], [0, 2], "the counts beside a name are part of the listing");
  publishSnapshot(snapshot({ branch: branch({ headState: "detached", name: null }) }));
  assert.equal(calls.refs, 3);
  stop();
});

test("opening another repository re-reads every domain", () => {
  const { calls, stop } = fresh();
  publishSnapshot(snapshot({}));
  calls.graph = 0;
  calls.refs = 0;
  // The same branch name at the same commit in a different repository is a
  // different set of refs, so the path has to be part of what is remembered.
  publishSnapshot(snapshot({ repo: { ...snapshot().repo, openPath: "/tmp/two" } }));
  assert.deepEqual([calls.graph, calls.refs], [1, 1]);
  stop();
});

test("a closed session is told to every domain, and forgets what it had seen", () => {
  const { calls, stop } = fresh();
  publishSnapshot(snapshot({}));
  calls.graph = 0;
  calls.refs = 0;
  const seen = { graph: "unset", refs: "unset" };
  const clear = SNAPSHOT_DOMAINS.map((domain) =>
    subscribeToDomain(domain, (value) => { seen[domain] = value === null ? "null" : "snapshot"; }),
  );
  publishSnapshot(null);
  assert.deepEqual([calls.graph, calls.refs], [1, 1], "a component has to be told to stop showing it");
  assert.deepEqual([seen.graph, seen.refs], ["null", "null"], "what it is told is that there is nothing");
  clear.forEach((detach) => detach());
  calls.graph = 0;
  calls.refs = 0;
  publishSnapshot(snapshot({}));
  assert.deepEqual([calls.graph, calls.refs], [1, 1], "reopening the same repository is a fresh start");
  stop();
});

test("the same function subscribed twice is one subscription", () => {
  publishSnapshot(null);
  let hits = 0;
  const handler = () => { hits += 1; };
  subscribeToDomain("graph", handler);
  subscribeToDomain("graph", handler);
  assert.equal(domainSubscriptions("graph"), 1);
  publishSnapshot(snapshot({}));
  assert.equal(hits, 1);
  subscribeToDomain("graph", handler)();
  publishSnapshot(snapshot({ branch: branch({ oid: "c".repeat(40) }) }));
  assert.equal(hits, 1, "one detach removes the shared subscription");
  assert.equal(domainSubscriptions("graph"), 0);
});

test("a page coming and going leaves the subscription count where it was", () => {
  publishSnapshot(null);
  const before = domainSubscriptions();
  const detaches = [];
  for (let round = 0; round < 25; round++) {
    detaches.push(subscribeToDomain("refs", () => {}));
    subscribeToDomain("graph", () => {})();
  }
  detaches.forEach((detach) => detach());
  assert.equal(domainSubscriptions(), before, "round trips cannot accumulate handlers");
});

test("a bare repository is a state of its own, not an empty name", () => {
  const { calls, stop } = fresh();
  publishSnapshot(snapshot({ branch: null }));
  calls.graph = 0;
  calls.refs = 0;
  publishSnapshot(snapshot({ branch: branch({ name: null, headState: "unborn", oid: null }) }));
  assert.deepEqual([calls.graph, calls.refs], [1, 1]);
  publishSnapshot(snapshot({ branch: branch({ name: null, headState: "unborn", oid: null }) }));
  assert.deepEqual([calls.graph, calls.refs], [1, 1], "an unborn head repeated is not a change");
  stop();
});
