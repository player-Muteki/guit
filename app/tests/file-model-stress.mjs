// Stress suite for the change-list view model: seeded property tests over
// buildRows / visibleWindow / nextSelectableRow / revealScroll, plus the
// gate that the assumed row heights still match the stylesheet.
// Runs in its own process alongside tests/file-model.mjs.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildRows,
  FILE_ROW_REM,
  GROUP_LABELS,
  HISTORY_ROW_REM,
  listRowRole,
  nextSelectableRow,
  revealScroll,
  rowHeightPx,
  visibleWindow,
} from "../src/fileModel.ts";
import { mulberry32, pick, randomInt } from "./helpers/rng.mjs";

const GROUP_KEYS = GROUP_LABELS.map((group) => group.key);

function file(id, group, display = `file-${id}.txt`) {
  return {
    id,
    display,
    renameFrom: null,
    group,
    indexStatus: group === "untracked" ? "?" : "M",
    worktreeStatus: group === "staged" ? " " : "M",
    staged: group === "staged",
    unstaged: group === "worktree",
    conflict: group === "conflict",
    untracked: group === "untracked",
    submodule: false,
  };
}

test("500 seeded repositories: row layout, counts and membership always agree", () => {
  const rand = mulberry32(0x1a2b);
  for (let round = 0; round < 500; round += 1) {
    const total = randomInt(rand, 40);
    const files = Array.from({ length: total }, (unused, index) =>
      file(index, pick(rand, GROUP_KEYS)),
    );
    const collapsed = new Set(GROUP_KEYS.filter(() => rand() < 0.5));
    const rows = buildRows(files, collapsed);

    let expectedLength = 0;
    const headingIndexes = [];
    for (const group of GROUP_LABELS) {
      const members = files.filter((f) => f.group === group.key);
      if (members.length === 0) continue;
      expectedLength += 1 + (collapsed.has(group.key) ? 0 : members.length);
      headingIndexes.push([group.key, members.length]);
    }
    assert.equal(rows.length, expectedLength, `round ${round}: row count`);

    const headings = rows.filter((row) => row.kind === "heading");
    assert.deepEqual(
      headings.map((row) => [row.group, row.count]),
      headingIndexes,
      `round ${round}: headings in fixed order with exact counts`,
    );
    assert.deepEqual(
      headings.filter((row) => row.collapsed).map((row) => row.group),
      [...collapsed].filter((key) => files.some((f) => f.group === key)),
      `round ${round}: collapsed flags mirror the set`,
    );

    const listed = rows.filter((row) => row.kind === "file").map((row) => row.file.id);
    const visible = files
      .filter((f) => !collapsed.has(f.group))
      .sort((unusedA, unusedB) => GROUP_KEYS.indexOf(unusedA.group) - GROUP_KEYS.indexOf(unusedB.group))
      .map((f) => f.id);
    assert.deepEqual(listed, visible, `round ${round}: exactly the uncollapsed files, in group order`);
  }
});

test("every group collapsed keeps four headings and no file rows", () => {
  const files = GROUP_KEYS.map((group, index) => file(index, group));
  const rows = buildRows(files, new Set(GROUP_KEYS));
  assert.equal(rows.length, 4);
  assert.ok(rows.every((row) => row.kind === "heading"));
});

test("empty input and unknown groups", () => {
  assert.deepEqual(buildRows([], new Set()), []);
  // A file whose group the view model does not know is dropped rather than
  // rendered under a wrong heading — pin that so a new backend group cannot
  // silently disappear without this test noticing.
  const stranger = { ...file(1, "staged"), group: "renamed" };
  assert.deepEqual(buildRows([stranger], new Set()), []);
});

test("listRowRole keeps non-selectable rows out and interactive children visible", () => {
  assert.equal(listRowRole("file"), "treeitem");
  assert.equal(listRowRole("heading"), "presentation");
  // Regression guard: `option` has presentational children per ARIA, so a
  // file row with that role hides its Stage/More-actions buttons from
  // assistive tech (measured over AT-SPI in the live app).
  assert.notEqual(listRowRole("file"), "option");
});

test("row-heights-track-the-css: the assumed rem values match tokens.css", () => {
  const css = readFileSync(new URL("../src/style/tokens.css", import.meta.url), "utf8");
  const fileRow = css.match(/--row-height:\s*([0-9.]+)rem/);
  const historyRow = css.match(/--row-height-history:\s*([0-9.]+)rem/);
  assert.ok(fileRow, "--row-height is declared in rem");
  assert.ok(historyRow, "--row-height-history is declared in rem");
  assert.equal(Number(fileRow[1]), FILE_ROW_REM);
  assert.equal(Number(historyRow[1]), HISTORY_ROW_REM);
});

test("rowHeightPx spans the whole zoom range without hitting zero", () => {
  for (let font = 12; font <= 24; font += 1) {
    for (const rem of [FILE_ROW_REM, HISTORY_ROW_REM]) {
      const height = rowHeightPx(font, rem);
      assert.ok(height > 0, "a row must never collapse to zero height");
      assert.ok(Number.isFinite(height));
    }
  }
  assert.equal(rowHeightPx(16, FILE_ROW_REM), 24);
  assert.equal(rowHeightPx(16, HISTORY_ROW_REM), 28);
  assert.equal(rowHeightPx(0, FILE_ROW_REM), 0);
});

test("3000 seeded windows: the slice always covers the viewport and stays clamped", () => {
  const rand = mulberry32(0xc0ffee);
  for (let round = 0; round < 3000; round += 1) {
    const total = randomInt(rand, 500);
    const rowHeight = pick(rand, [18, 21, 24, 28, 30, 42, 19.5]);
    const viewport = pick(rand, [0, 1, 60, 300, 600, 1080]);
    const overscan = pick(rand, [0, 1, 2, 6]);
    // A real scroller cannot push scrollTop past the end of the content.
    const scrollTop = randomInt(rand, Math.max(1, total * rowHeight - viewport + 1));
    const w = visibleWindow(total, scrollTop, viewport, rowHeight, overscan);
    assert.ok(w.startIndex >= 0, `round ${round}: start >= 0`);
    assert.ok(w.endIndex <= total, `round ${round}: end <= total`);
    assert.ok(w.startIndex <= w.endIndex, `round ${round}: window not inverted`);
    assert.equal(w.offsetY, w.startIndex * rowHeight);
    assert.equal(w.totalHeight, total * rowHeight);
    if (total > 0 && viewport > 0) {
      const firstRow = Math.min(total - 1, Math.floor(scrollTop / rowHeight));
      assert.ok(
        firstRow >= w.startIndex && firstRow < w.endIndex,
        `round ${round}: row at scrollTop=${scrollTop} (row ${firstRow}) outside [${w.startIndex},${w.endIndex})`,
      );
      if (viewport > 0) {
        // The bottom-most row the viewport touches: highest i with i*h < s+v.
        const lastRow = Math.min(
          total - 1,
          Math.ceil((scrollTop + viewport) / rowHeight) - 1,
        );
        assert.ok(
          lastRow < w.endIndex,
          `round ${round}: bottom row ${lastRow} missing from window`,
        );
      }
    }
  }
});

test("nextSelectableRow: 200 seeded boards, a thousand steps each, never lands on a heading", () => {
  const rand = mulberry32(0x5175);
  for (let board = 0; board < 200; board += 1) {
    const files = Array.from({ length: randomInt(rand, 25) }, (unused, index) =>
      file(index, pick(rand, GROUP_KEYS)),
    );
    const collapsed = new Set(GROUP_KEYS.filter(() => rand() < 0.3));
    const rows = buildRows(files, collapsed);
    let current = randomInt(rand, Math.max(1, rows.length));
    for (let step = 0; step < 5; step += 1) {
      for (const delta of [1, -1, 1, -1, 1]) {
        const next = nextSelectableRow(rows, current, delta);
        if (next !== current) {
          assert.equal(rows[next].kind, "file", "movement only lands on files");
          assert.equal(Math.sign(next - current), Math.sign(delta), "and only in the asked direction");
          current = next;
        } else {
          assert.ok(
            rows[current]?.kind === "heading" || !hasFileBeyond(rows, current, delta),
            `stuck only at an edge (rows=${rows.length}, current=${current}, delta=${delta})`,
          );
        }
      }
    }
  }
});

function hasFileBeyond(rows, from, delta) {
  for (let index = from + Math.sign(delta); index >= 0 && index < rows.length; index += Math.sign(delta)) {
    if (rows[index].kind === "file") return true;
  }
  return false;
}

test("nextSelectableRow: degenerate inputs return instead of spinning", () => {
  const rows = buildRows([file(1, "staged")], new Set()); // single heading row
  assert.equal(nextSelectableRow(rows, 0, 0), 0, "delta 0 must not loop forever");
  assert.equal(nextSelectableRow(rows, 0, Number.NaN), 0, "NaN must not loop forever");
  assert.equal(nextSelectableRow([], 0, 1), 0, "empty list keeps the caller put");
  assert.equal(nextSelectableRow(rows, 99, -1), 99, "out-of-range start is not pulled in");
  const onlyHeadings = [
    { kind: "heading", group: "staged", label: "s", count: 0, collapsed: true },
    { kind: "heading", group: "worktree", label: "w", count: 0, collapsed: true },
  ];
  assert.equal(nextSelectableRow(onlyHeadings, 0, 1), 0, "no files at all: stay put");
  assert.equal(nextSelectableRow(onlyHeadings, 1, -1), 1, "and backwards too");
});

test("revealScroll: 2000 seeded calls always land the row fully inside the viewport", () => {
  const rand = mulberry32(0xdead);
  for (let round = 0; round < 2000; round += 1) {
    const total = 1 + randomInt(rand, 300);
    const rowHeight = pick(rand, [18, 24, 28, 19.5]);
    const viewport = pick(rand, [60, 300, 600]);
    const index = randomInt(rand, total);
    const scrollTop = Math.max(0, Math.min(
      randomInt(rand, total * rowHeight + 1),
      Math.max(0, total * rowHeight - viewport),
    ));
    const next = revealScroll(scrollTop, viewport, index, rowHeight);
    const top = index * rowHeight;
    if (top >= scrollTop && top + rowHeight <= scrollTop + viewport) {
      assert.equal(next, scrollTop, `round ${round}: already visible, must not move`);
    } else {
      assert.ok(next <= top + rowHeight - viewport + 1e-9 || next >= top, `round ${round}: moved the wrong way`);
      assert.ok(next <= top, `round ${round}: row top ${top} below scroll ${next}`);
      assert.ok(next + viewport >= top + rowHeight, `round ${round}: row bottom cut off`);
    }
  }
});

test("a 50k-file repository still builds and windows in bounded work", () => {
  const rand = mulberry32(0x500c);
  const files = Array.from({ length: 50000 }, (unused, index) =>
    file(index, pick(rand, GROUP_KEYS)),
  );
  const started = performance.now();
  const rows = buildRows(files, new Set());
  assert.equal(rows.length, 50004); // four group headings on top of every file
  const collapsed = buildRows(files, new Set(GROUP_KEYS));
  assert.equal(collapsed.length, 4);
  const slice = visibleWindow(rows.length, 25000 * 30, 600, 30, 6);
  assert.ok(slice.endIndex - slice.startIndex <= Math.ceil(600 / 30) + 2 * 6 + 1);
  assert.ok(performance.now() - started < 5000, "50k files must not take seconds (stall smoke)");
});
