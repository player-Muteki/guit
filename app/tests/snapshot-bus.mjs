// The snapshot fan-out decides which component may go back to Git.
//
// It is the one place the panel trades a refresh for reads, so both directions
// of the mistake are expensive in opposite ways: fire on everything and a live
// repository pays six Git reads per refresh again; fire on nothing and the
// branch picker shows names that no longer exist.
//
// What used to be decided here — reading the branch name, the head state and
// the ahead/behind counts back out of each snapshot and calling a change what
// the difference looked like — is decided by the backend now. It ships one
// number per domain per session, and this file only compares numbers. That is
// not a loss of logic but the reason the logic works: two clones of one
// repository share a branch name, a head object id and a commit graph, so no
// field drawn from Git can tell a read asked for by one from a read asked for by
// the other. Only the session they were opened as can, and only the backend
// knows that number.
//
// The same two numbers travel with every asynchronous read, which is where the
// second half of the rule lives: an answer that comes back under a context the
// view no longer holds has left the screen it describes. These tests pin the
// comparison, the independence of the domains, and the one state that is not a
// read at all (a session that has closed).

import assert from "node:assert/strict";
import test from "node:test";
import {
  contextMatches,
  domainSubscriptions,
  publishSnapshot,
  readContextFor,
  sessionContext,
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

// The Git-shaped fields are deliberately separable from the identity: a case
// that wants "the same repository state, another session" changes only the
// numbers this file is about.
const snapshot = (over = {}) => ({
  version: 1,
  sessionId: 1,
  historyGeneration: 0,
  refsGeneration: 0,
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
  publishSnapshot(snapshot({ version: 3, files: [{ id: 1 }] }));
  assert.deepEqual([calls.graph, calls.refs], [1, 1], "the version alone is not a change");
  stop();
});

test("each domain answers its own number and not the other's", () => {
  const { calls, stop } = fresh();
  publishSnapshot(snapshot({}));
  calls.graph = 0;
  calls.refs = 0;
  publishSnapshot(snapshot({ refsGeneration: 1 }));
  assert.deepEqual([calls.graph, calls.refs], [0, 1], "names moved, the head did not");
  publishSnapshot(snapshot({ refsGeneration: 1, historyGeneration: 1 }));
  assert.deepEqual([calls.graph, calls.refs], [1, 1], "the head moved under a listing that stayed put");
  publishSnapshot(snapshot({ refsGeneration: 1, historyGeneration: 1, branch: branch({ oid: "b".repeat(40) }) }));
  assert.deepEqual([calls.graph, calls.refs], [1, 1], "a field this file no longer reads changes nothing");
  stop();
});

test("two clones of one repository never share a read", () => {
  const { calls, stop } = fresh();
  publishSnapshot(snapshot({ sessionId: 1 }));
  calls.graph = 0;
  calls.refs = 0;
  // Byte-for-byte the same branch, head object id and counts: this is the pair
  // no comparison of Git-shaped fields can tell apart, and the reason a
  // listing of the first clone must not be shown as the second.
  const first = snapshot({ sessionId: 1 });
  const second = snapshot({ sessionId: 2 });
  assert.deepEqual(
    { ...second, sessionId: first.sessionId },
    first,
    "the fixture stopped being the case it claims to be",
  );
  publishSnapshot(second);
  assert.deepEqual([calls.graph, calls.refs], [1, 1], "a new session starts both domains");
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

test("a read is asked as the domain it belongs to", () => {
  const current = snapshot({ sessionId: 7, historyGeneration: 3, refsGeneration: 5 });
  assert.deepEqual(readContextFor(current, "graph"), { sessionId: 7, generation: 3 });
  assert.deepEqual(readContextFor(current, "refs"), { sessionId: 7, generation: 5 });
  // A listing no domain owns is bound to the session alone: a refresh leaves it
  // valid, opening another repository does not.
  assert.deepEqual(sessionContext(current), { sessionId: 7, generation: null });
});

test("an answer only matches the context it was asked with", () => {
  const asked = { sessionId: 7, generation: 3 };
  assert.ok(contextMatches(asked, { sessionId: 7, generation: 3 }));
  assert.ok(!contextMatches(asked, { sessionId: 7, generation: 4 }), "the domain moved while the read was out");
  assert.ok(!contextMatches(asked, { sessionId: 8, generation: 3 }), "the same generation number in a new session is a different number");
  assert.ok(!contextMatches(asked, { sessionId: 8, generation: null }));
  // A session-only read has to be answered with no generation, and a
  // generation cannot be invented to satisfy it.
  assert.ok(contextMatches({ sessionId: 7, generation: null }, { sessionId: 7, generation: null }));
  assert.ok(!contextMatches({ sessionId: 7, generation: null }, { sessionId: 7, generation: 0 }));
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
  publishSnapshot(snapshot({ historyGeneration: 1 }));
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
  publishSnapshot(snapshot({ branch: null, historyGeneration: 1, refsGeneration: 1 }));
  assert.deepEqual([calls.graph, calls.refs], [1, 1], "the backend counts an unborn head as a moved domain");
  publishSnapshot(snapshot({ branch: null, historyGeneration: 1, refsGeneration: 1 }));
  assert.deepEqual([calls.graph, calls.refs], [1, 1], "the same numbers again are not a change");
  stop();
});
