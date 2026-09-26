// Stress suite for the commit-list view model: paging arithmetic, large
// lists, and label formatting corner cases. Runs in its own process
// alongside tests/history-model.mjs.

import assert from "node:assert/strict";
import test from "node:test";
import {
  buildHistoryRows,
  historyPageStart,
  historyRowLabel,
} from "../src/historyModel.ts";
import { mulberry32, randomInt } from "./helpers/rng.mjs";
import { visibleWindow } from "../src/fileModel.ts";

const commit = (n, extra = {}) => ({
  oid: String(n).padStart(40, "0"),
  parents: [],
  subject: `commit ${n}`,
  message: `commit ${n}\n`,
  authorName: "a",
  authorEmail: "a@b",
  authorDate: "2026-09-25T10:00:00Z",
  committerName: "a",
  commitDate: "2026-09-25T10:00:00Z",
  refs: [],
  ...extra,
});

test("historyPageStart: a reset re-reads page zero, a continuation continues", () => {
  assert.equal(historyPageStart(0, false), 0);
  assert.equal(historyPageStart(300, false), 300);
  // The regression this guards: after a branch switch the view had 300 rows
  // of the OLD head loaded; skipping that many commits of the NEW head hid
  // its history.
  assert.equal(historyPageStart(300, true), 0);
  assert.equal(historyPageStart(100000, true), 0);
});

test("buildHistoryRows keeps one row per commit, in order, without copying", () => {
  const commits = Array.from({ length: 100000 }, (unused, index) => commit(index));
  const rows = buildHistoryRows(commits);
  assert.equal(rows.length, 100000);
  assert.ok(rows.every((row) => row.kind === "commit"));
  assert.equal(rows[0].commit, commits[0], "the row references the snapshot commit");
  assert.equal(rows[99999].commit, commits[99999]);
});

test("buildHistoryRows on empty and single-element lists", () => {
  assert.deepEqual(buildHistoryRows([]), []);
  assert.equal(buildHistoryRows([commit(1)]).length, 1);
});

test("historyRowLabel: exact format with and without decorations", () => {
  const plain = commit(0, { oid: "abcdef1234567890".repeat(2) + "ab" });
  assert.equal(historyRowLabel(plain), "commit 0  ·  abcdef12");
  const decorated = commit(1, { oid: "beefcafe" + "0".repeat(32), refs: ["HEAD -> main", "origin/main", "v1.0"] });
  assert.equal(
    historyRowLabel(decorated),
    "commit 1  ·  beefcafe  HEAD -> main · origin/main · v1.0",
  );
});

test("historyRowLabel: hostile but possible subjects survive verbatim", () => {
  const cases = [
    ["", ""],
    ["   ", "   "],
    ["trailing spaces   ", "trailing spaces   "],
    ["ünïcödé 中文 🎸", "ünïcödé 中文 🎸"],
    ["contains · separator", "contains · separator"],
    ["<img src=x onerror=alert(1)>", "<img src=x onerror=alert(1)>"],
    ["0123456789".repeat(30), "0123456789".repeat(30)],
  ];
  for (const [subject, expected] of cases) {
    const line = historyRowLabel(commit(2, { subject }));
    assert.ok(line.startsWith(`${expected}  ·  `), `subject ${JSON.stringify(subject)} must be verbatim`);
  }
});

test("historyRowLabel: short oids do not crash", () => {
  assert.equal(historyRowLabel(commit(0, { oid: "abc" })), "commit 0  ·  abc");
  assert.equal(historyRowLabel(commit(0, { oid: "" })), "commit 0  ·  ");
});

test("10k labels and a bounded window across a paging session", () => {
  const rand = mulberry32(0x9a9e);
  const rowHeight = 28;
  const allCommits = [];
  for (let page = 0; page < 20; page += 1) {
    const start = historyPageStart(allCommits.length, false);
    assert.equal(start, allCommits.length);
    const commits = Array.from({ length: 500 }, (unused, index) =>
      commit(start + index, { refs: randomInt(rand, 10) === 0 ? ["HEAD -> main"] : [] }),
    );
    allCommits.push(...commits);
    const rows = buildHistoryRows(allCommits);
    assert.equal(rows.length, allCommits.length);
    const scrollTop = randomInt(rand, Math.max(1, rows.length - 20)) * rowHeight;
    const w = visibleWindow(rows.length, scrollTop, 600, rowHeight, 6);
    assert.ok(w.endIndex - w.startIndex <= Math.ceil(600 / rowHeight) + 2 * 6 + 1);
    assert.equal(w.totalHeight, rows.length * rowHeight);
    rows.forEach((row) => assert.ok(historyRowLabel(row.commit).length > 0));
  }
});
