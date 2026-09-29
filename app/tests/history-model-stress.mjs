// Stress suite for the commit-list view model: paging arithmetic, large
// lists, and label formatting corner cases. Runs in its own process
// alongside tests/history-model.mjs.

import assert from "node:assert/strict";
import test from "node:test";
import {
  buildHistoryRows,
  historyPageStart,
  indexNames,
  namesAt,
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

test("buildHistoryRows: hostile but possible subjects survive verbatim", () => {
  // The row is written with `textContent`, so escaping is the platform's job;
  // what this module owns is that it does not touch the string on the way.
  const cases = [
    "",
    "   ",
    "trailing spaces   ",
    "ünïcödé 中文 🎸",
    "contains · separator",
    "<img src=x onerror=alert(1)>",
    "0123456789".repeat(30),
  ];
  for (const subject of cases) {
    const [row] = buildHistoryRows([commit(2, { subject })]);
    assert.equal(row.commit.subject, subject, `subject ${JSON.stringify(subject)} must be verbatim`);
  }
});

test("buildHistoryRows: a short or empty oid is carried, not repaired", () => {
  const [short] = buildHistoryRows([commit(0, { oid: "abc" })]);
  assert.equal(short.commit.oid, "abc");
  const [empty] = buildHistoryRows([commit(0, { oid: "" })]);
  assert.equal(empty.commit.oid, "");
});

test("10k names and a bounded window across a paging session", () => {
  const rand = mulberry32(0x9a9e);
  const rowHeight = 28;
  const allCommits = [];
  const tips = [];
  for (let page = 0; page < 20; page += 1) {
    const start = historyPageStart(allCommits.length, false);
    assert.equal(start, allCommits.length);
    const commits = Array.from({ length: 500 }, (unused, index) => commit(start + index));
    allCommits.push(...commits);
    // A branch naming one commit in every ten, so the window is built with a
    // column of names joined onto it rather than with nothing on screen.
    for (let index = start; index < start + 500; index += 10) {
      tips.push({
        name: `b${index}`,
        oid: commit(index).oid,
        head: false,
        upstream: null,
        ahead: null,
        behind: null,
        upstreamGone: false,
        addressable: true,
      });
    }
    const names = indexNames({ branches: tips, tags: [], remotes: [] });
    assert.equal(namesAt(names, commit(start).oid).length, 1, "the page on screen is labelled");
    const rows = buildHistoryRows(allCommits);
    assert.equal(rows.length, allCommits.length);
    const scrollTop = randomInt(rand, Math.max(1, rows.length - 20)) * rowHeight;
    const w = visibleWindow(rows.length, scrollTop, 600, rowHeight, 6);
    assert.ok(w.endIndex - w.startIndex <= Math.ceil(600 / rowHeight) + 2 * 6 + 1);
    assert.equal(w.totalHeight, rows.length * rowHeight);
    rows.forEach((row) => assert.ok(row.commit.subject.length + row.commit.oid.length > 0));
  }
});
