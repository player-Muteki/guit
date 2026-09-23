import assert from "node:assert/strict";
import test from "node:test";
import { buildRows, visibleWindow } from "../src/fileModel.ts";

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

test("buildRows emits one heading per non-empty group in fixed order", () => {
  const files = [
    file(1, "untracked"),
    file(2, "worktree"),
    file(3, "conflict"),
    file(4, "staged"),
    file(5, "staged"),
  ];
  const rows = buildRows(files, new Set());
  const headings = rows.filter((row) => row.kind === "heading");
  assert.deepEqual(
    headings.map((row) => [row.group, row.count]),
    [
      ["conflict", 1],
      ["staged", 2],
      ["worktree", 1],
      ["untracked", 1],
    ],
  );
  assert.equal(rows.length, files.length + headings.length);
});

test("collapsed groups keep their heading and hide their file rows", () => {
  const files = [file(1, "staged"), file(2, "staged"), file(3, "worktree")];
  const rows = buildRows(files, new Set(["staged"]));
  const staged = rows.find((row) => row.kind === "heading" && row.group === "staged");
  assert.equal(staged.collapsed, true);
  assert.equal(staged.count, 2);
  assert.equal(
    rows.filter((row) => row.kind === "file" && row.file.group === "staged").length,
    0,
  );
  // The expanded group is untouched.
  assert.equal(rows.filter((row) => row.kind === "file" && row.file.group === "worktree").length, 1);
});

test("visibleWindow covers the viewport and clamps at both ends", () => {
  const top = visibleWindow(1000, 0, 300, 30, 2);
  assert.equal(top.startIndex, 0);
  assert.equal(top.endIndex, 12);
  assert.equal(top.offsetY, 0);
  assert.equal(top.totalHeight, 30000);

  const middle = visibleWindow(1000, 6000, 300, 30, 2);
  assert.equal(middle.startIndex, 198);
  assert.equal(middle.offsetY, 198 * 30);
  assert.ok(middle.endIndex <= 1000);

  const bottom = visibleWindow(1000, 1000 * 30, 300, 30, 2);
  assert.equal(bottom.endIndex, 1000);
  assert.ok(bottom.startIndex < 1000);

  const empty = visibleWindow(0, 0, 300, 30, 2);
  assert.deepEqual(empty, { startIndex: 0, endIndex: 0, offsetY: 0, totalHeight: 0 });
});

test("a 50k-file repository renders a bounded slice", () => {
  const files = Array.from({ length: 50000 }, (_, index) =>
    file(index, index % 2 === 0 ? "worktree" : "untracked"),
  );
  const rows = buildRows(files, new Set());
  assert.equal(rows.length, 50002); // 50k files + worktree and untracked headings
  const slice = visibleWindow(rows.length, 25000 * 30, 600, 30, 6);
  assert.ok(slice.endIndex - slice.startIndex <= Math.ceil(600 / 30) + 2 * 6 + 1);
});
