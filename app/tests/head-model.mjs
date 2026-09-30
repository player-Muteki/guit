import assert from "node:assert/strict";
import test from "node:test";
import { aheadBehind, branchChoices, branchDetail, branchLabel } from "../src/headModel.ts";

const branch = (overrides = {}) => ({
  name: "main",
  headState: "branch",
  oid: "1".repeat(40),
  upstream: null,
  ahead: null,
  behind: null,
  ...overrides,
});

const ref = (overrides = {}) => ({
  name: "main",
  oid: "1".repeat(40),
  head: false,
  upstream: null,
  ahead: null,
  behind: null,
  upstreamGone: false,
  addressable: true,
  ...overrides,
});

// The acceptance the header selector is built on: a reader must be able to tell
// the three head states apart from the words alone, so no state may be described
// by an absent field.
test("the three head states are three sentences", () => {
  const named = branchLabel(branch());
  const detached = branchLabel(branch({ headState: "detached", name: null, oid: "abcdef0123".padEnd(40, "0") }));
  const unborn = branchLabel(branch({ headState: "unborn", oid: null }));
  assert.equal(named, "main");
  assert.equal(detached, "detached at abcdef01");
  assert.equal(unborn, "main (no commits yet)");
  for (const label of [named, detached, unborn]) {
    assert.notEqual(label, "", "a state is never drawn as nothing at all");
  }
  assert.equal(new Set([named, detached, unborn]).size, 3);
});

test("a state with no name says so rather than lying with a space", () => {
  // The backend sets `name` to null for a detached HEAD and `oid` to null for an
  // unborn one, so each state has exactly one field missing. Neither may make the
  // other's sentence read as an empty branch.
  assert.match(branchLabel(branch({ headState: "detached", name: null, oid: null })), /^detached at /);
  assert.match(branchLabel(branch({ headState: "unborn", name: null })), /no commits yet/);
  assert.equal(branchLabel(null), "bare repository");
});

test("the counts are only said when there is something to count against", () => {
  assert.equal(aheadBehind(branch()), "");
  assert.equal(aheadBehind(branch({ upstream: "origin/main" })), "", "no counts read as nothing");
  assert.equal(aheadBehind(branch({ upstream: "origin/main", ahead: 2, behind: 1 })), " ↑2 ↓1");
  assert.equal(aheadBehind(branch({ upstream: "origin/main", ahead: 0, behind: 0 })), " ↑0 ↓0");
});

test("a listing row says where it tracks and whether that is gone", () => {
  assert.equal(branchDetail(ref()), "");
  assert.equal(branchDetail(ref({ upstream: "origin/dev", ahead: 3 })), "→ origin/dev  ↑3");
  assert.equal(
    branchDetail(ref({ upstream: "origin/dev", upstreamGone: true })),
    "→ origin/dev  upstream gone",
  );
});

test("the checked-out branch is shown and is not a target", () => {
  const choices = branchChoices([ref({ name: "main", head: true }), ref({ name: "dev" })], branch());
  assert.deepEqual(choices.map((one) => [one.name, one.current, one.runnable]), [
    ["main", true, false],
    ["dev", false, true],
  ]);
  assert.equal(choices[0].reason, null, "being here is not a refusal");
});

// The marker and the head answer two different counters, so a row either of them
// calls the current one is a row this panel will not switch to.
test("the two signals are believed together", () => {
  const staleListing = branchChoices([ref({ name: "main", head: true }), ref({ name: "dev" })], branch({ name: "dev" }));
  assert.deepEqual(staleListing.filter((one) => one.current).map((one) => one.name), ["main", "dev"]);
  const freshHead = branchChoices([ref({ name: "dev" })], branch({ name: "dev" }));
  assert.equal(freshHead[0].current, true);
});

test("a detached HEAD marks no row, because no branch carries it", () => {
  const choices = branchChoices(
    [ref({ name: "main" }), ref({ name: "dev" })],
    branch({ headState: "detached", name: null }),
  );
  assert.deepEqual(choices.filter((one) => one.current), [], "every branch is a way back to a named HEAD");
  assert.ok(choices.every((one) => one.runnable));
});

test("an unborn branch is not the row it will never have", () => {
  // A branch with no commits has no ref to list, so the unborn name appears in
  // no row: the header still has to be asked of Git, which is what answers it.
  const choices = branchChoices([ref({ name: "dev" })], branch({ headState: "unborn", oid: null }));
  assert.deepEqual(choices.map((one) => one.name), ["dev"]);
  assert.ok(choices.every((one) => one.current === false));
});

test("a name that cannot go back to Git is said, not hidden", () => {
  const choices = branchChoices([ref({ name: "bad\uFFFDname", addressable: false }), ref({ name: "dev" })], branch());
  assert.equal(choices[0].runnable, false);
  assert.match(choices[0].reason ?? "", /not byte-round-trippable/);
  assert.equal(choices[1].reason, null, "the branch beside it is still switchable");
});

test("the list keeps Git's own order", () => {
  const listed = [ref({ name: "zzz" }), ref({ name: "aaa" }), ref({ name: "main", head: true })];
  assert.deepEqual(branchChoices(listed, branch({ name: "main" })).map((one) => one.name), ["zzz", "aaa", "main"]);
});
