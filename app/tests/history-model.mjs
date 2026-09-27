import assert from "node:assert/strict";
import test from "node:test";
import { buildHistoryRows, historyPageStart } from "../src/historyModel.ts";
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

test("buildHistoryRows maps every commit to one row", () => {
  const rows = buildHistoryRows([commit(1), commit(2)]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].kind, "commit");
  assert.equal(rows[0].commit.subject, "commit 1");
});

test("buildHistoryRows on an empty list is empty", () => {
  assert.deepEqual(buildHistoryRows([]), []);
});

test("a subject is carried through verbatim, whatever Git put in it", () => {
  // The view model must not trim, re-case or re-punctuate a subject. The DOM
  // then writes it with `textContent`, so escaping is the platform's job and
  // there is no formatting function left here for a hostile subject to escape
  // through.
  for (const subject of [
    "",
    "   ",
    "trailing spaces   ",
    "ünïcödé 中文 🎸",
    "contains · separator",
    "<img src=x onerror=alert(1)>",
    "0123456789".repeat(30),
  ]) {
    const [row] = buildHistoryRows([commit(2, { subject })]);
    assert.equal(row.commit.subject, subject, `subject ${JSON.stringify(subject)} must be verbatim`);
  }
});

test("a 10k-commit list windows to a bounded DOM slice", () => {
  const rows = buildHistoryRows(Array.from({ length: 10000 }, (_, i) => commit(i)));
  assert.equal(rows.length, 10000);
  const slice = visibleWindow(rows.length, 5000 * 28, 600, 28, 6);
  assert.ok(slice.endIndex - slice.startIndex <= Math.ceil(600 / 28) + 2 * 6 + 1);
  assert.equal(slice.totalHeight, 10000 * 28);
});

test("a reset re-reads page zero instead of skipping the old HEAD's count", () => {
  assert.equal(historyPageStart(0, true), 0);
  // The bug this guards: after a branch switch the view still held 137 commits
  // of the previous HEAD, asked for page 137 of the new one, and stayed
  // silent about the 137 newest commits.
  assert.equal(historyPageStart(137, true), 0);
  assert.equal(historyPageStart(137, false), 137);
  assert.equal(historyPageStart(50, false), 50);
});
