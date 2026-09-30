import assert from "node:assert/strict";
import test from "node:test";
import { restoreReading, shortId } from "../src/restoreModel.ts";

const OID_A = "a".repeat(40);
const OID_B = "b".repeat(40);

const preview = (overrides = {}) => ({
  nonce: "n",
  targetOid: OID_B,
  headOid: OID_A,
  changed: [],
  discarded: [],
  overwritten: [],
  ignoredWritten: [],
  removed: [],
  leftBehind: [],
  snapshot: null,
  ...overrides,
});

// The preview is the whole promise, and six classes of path ride in it. Merged
// into one list they would read as one promise, so the grouping is the rule this
// model owns: one section per class, each called by what happens to it.
const ALL = preview({
  changed: ["src/main.rs", "docs/a.md"],
  discarded: ["notes.txt"],
  overwritten: ["build/out.js"],
  ignoredWritten: ["cache/index.bin"],
  removed: ["tmp/scratch.log"],
  leftBehind: ["vendor/other (repository)"],
});

test("each class of path is read out under the verb it deserves", () => {
  const reading = restoreReading(ALL);
  assert.equal(reading.sections.length, 6);
  const labels = reading.sections.map((section) => section.label);
  assert.equal(new Set(labels).size, 6, "no two classes share a heading");
  const byName = new Map(reading.sections.map((section) => [section.label, section.items]));
  assert.ok(byName.get(labels.find((label) => label.startsWith("Tracked paths"))).includes("src/main.rs"));
  assert.ok(byName.get(labels.find((label) => label.startsWith("Local changes"))).includes("notes.txt"));
  assert.ok(byName.get(labels.find((label) => label.startsWith("Untracked paths the restore writes"))).includes("build/out.js"));
  assert.ok(byName.get(labels.find((label) => label.startsWith("Ignored paths"))).includes("cache/index.bin"));
  assert.ok(byName.get(labels.find((label) => label.startsWith("Untracked paths deleted"))).includes("tmp/scratch.log"));
  assert.ok(byName.get(labels.find((label) => label.startsWith("Untracked paths that stay"))).includes("vendor/other (repository)"));
});

// A class that writes over a path and a class that stays are opposite answers, so
// they must not be told by the same heading — and the staying one owes its reason.
test("what is written over is never called what stays", () => {
  const reading = restoreReading(ALL);
  const writeOver = reading.sections.find((section) => section.items.includes("build/out.js"));
  const stays = reading.sections.find((section) => section.items.includes("vendor/other (repository)"));
  assert.notEqual(writeOver.label, stays.label);
  assert.match(stays.label, /does not enter another repository/);
  assert.doesNotMatch(writeOver.label, /delet/);
});

// The one class an ignore rule would otherwise hide: the restore writes it, so the
// preview owes it a line rather than letting the rule imply it was safe.
test("an ignored path the target holds is named before the write", () => {
  const reading = restoreReading(preview({ ignoredWritten: ["cache/index.bin"] }));
  assert.equal(reading.sections.length, 1);
  assert.match(reading.sections[0].label, /^Ignored paths/);
});

test("an empty class contributes no heading", () => {
  const reading = restoreReading(preview({ changed: ["only.txt"] }));
  assert.equal(reading.sections.length, 1);
  assert.match(reading.sections[0].label, /Tracked paths/);
});

// A restore that moves HEAD and touches nothing else is still a restore: the
// heading is the promise, and no section is invented to fill the space under it.
test("a preview with nothing to touch still says where HEAD goes", () => {
  const reading = restoreReading(preview());
  assert.deepEqual(reading.sections, []);
  assert.equal(reading.heading, `HEAD moves from ${shortId(OID_A)} to ${shortId(OID_B)}`);
});

test("sections come in the order the two steps do them", () => {
  const reading = restoreReading(ALL);
  const first = reading.sections.map((section) => section.label.split(" (")[0]);
  assert.deepEqual(first, [
    "Tracked paths the target's version changes",
    "Local changes this throws away",
    "Untracked paths the restore writes over",
    "Ignored paths the target holds anyway",
    "Untracked paths deleted after the restore",
    "Untracked paths that stay — guit does not enter another repository",
  ]);
});

test("a heading counts its own paths", () => {
  for (const section of restoreReading(ALL).sections) {
    const count = Number(section.label.match(/\((\d+)\)$/)[1]);
    assert.equal(count, section.items.length, `${section.label} counts wrong`);
  }
  const many = restoreReading(preview({ changed: Array.from({ length: 12 }, (_, index) => `p${index}.txt`) }));
  assert.match(many.sections[0].label, /\(12\)$/);
});

// The dialog shows the preview verbatim, and a name is the only handle a user has
// on a path — sorting, casing or shortening one here would be a second answer.
test("a name is passed through exactly as Git named it", () => {
  const odd = ["Zebra.txt", " a leading space ", "ign/nested/deep.txt", "café/ünïcode.txt"];
  const reading = restoreReading(preview({ changed: odd }));
  assert.deepEqual(reading.sections[0].items, odd);
});

test("an id is read out ten characters at a time", () => {
  assert.equal(shortId(OID_A), "aaaaaaaaaa");
  assert.equal(shortId("abc"), "abc", "a short id is not padded");
});
