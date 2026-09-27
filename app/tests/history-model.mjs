import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildHistoryRows,
  graphColumns,
  graphLanePx,
  graphNodePx,
  graphWidth,
  historyPageStart,
  rowGeometry,
  GRAPH_LANE_REM,
  GRAPH_NODE_REM,
} from "../src/historyModel.ts";
import { visibleWindow } from "../src/fileModel.ts";

const stylesheet = (path) =>
  readFileSync(fileURLToPath(new URL(`../src/${path}`, import.meta.url)), "utf8");

const cssRem = (name) => {
  const match = stylesheet("style/tokens.css").match(new RegExp(`--${name}:\\s*([0-9.]+)rem`));
  assert.ok(match, `--${name} must be declared in style/tokens.css`);
  return Number(match[1]);
};

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
  // A straight first-parent line, so a test that is not about the graph still
  // has a graph to carry.
  graph: {
    node: 0,
    entry: n > 0,
    exit: true,
    merge: false,
    root: false,
    lanes: [],
    branches: [],
    incoming: [],
    dangling: false,
    folded: false,
  },
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

// --- the graph -----------------------------------------------------

const graph = (extra) => ({
  node: 0,
  entry: false,
  exit: true,
  merge: false,
  root: false,
  lanes: [],
  branches: [],
  incoming: [],
  dangling: false,
  folded: false,
  ...extra,
});

test("a lane's rem size is the size the stylesheet gives it", () => {
  // A hard-coded pixel lane would drift out of step with the CSS under
  // interface zoom, the same way a hard-coded row height would.
  assert.equal(GRAPH_LANE_REM, cssRem("graph-lane"), "lanes follow --graph-lane");
  assert.equal(GRAPH_NODE_REM, cssRem("graph-node"), "the dot follows --graph-node");
  assert.equal(graphLanePx(20), 20 * GRAPH_LANE_REM);
  assert.equal(graphNodePx(20), 20 * GRAPH_NODE_REM);
});

test("the gutter is as wide as the widest lane in the loaded history", () => {
  // Sizing to the visible rows instead would slide the subject text sideways
  // every time a wider part of the history scrolled into view.
  assert.equal(graphColumns([]), 1, "an empty history still has a line's width");
  assert.equal(graphColumns([commit(1)]), 1);
  assert.equal(
    graphColumns([commit(1, { graph: graph({ lanes: [2] }) }), commit(2, { graph: graph({ node: 3 }) })]),
    4,
    "the widest column, in either a lane or the node, sets the width",
  );
  assert.equal(graphWidth(3, 10), 30);
  assert.equal(graphWidth(0, 10), 10, "never narrower than one lane");
});

test("a straight line enters from above, leaves below, and joins at the dot", () => {
  const { parts } = rowGeometry(
    graph({ entry: true, exit: true }),
    1,
    10,
    28,
    3,
  );
  const above = parts.find((part) => part.kind === "line" && part.y1 === 0);
  const below = parts.find((part) => part.kind === "line" && part.y2 === 28);
  const dot = parts.find((part) => part.kind === "node");
  assert.ok(above && below && dot, "an entered line is drawn above, below and at a dot");
  assert.equal(above.y2, dot.cy, "the upper line reaches the dot");
  assert.equal(below.y1, dot.cy, "the lower line starts at the dot");
  assert.equal(above.x, dot.cx, "both halves share the node's column");
  assert.equal(dot.cy, 14, "the dot sits halfway down the row");
});

test("the top of the history has nothing above it and a root nothing below", () => {
  const top = rowGeometry(graph({ entry: false, exit: true }), 1, 10, 28, 3);
  assert.equal(top.parts.filter((part) => part.kind === "line" && part.y1 === 0).length, 0);
  const root = rowGeometry(graph({ entry: true, exit: false, root: true }), 1, 10, 28, 3);
  assert.equal(root.parts.filter((part) => part.kind === "line" && part.y2 === 28).length, 0);
  assert.equal(root.parts.find((part) => part.kind === "node").shape, "root");
});

test("a merge is a ring and a branch curves out of it into its own lane", () => {
  const { parts } = rowGeometry(
    graph({ entry: true, exit: true, merge: true, lanes: [1], branches: [1] }),
    2,
    10,
    28,
    3,
  );
  assert.equal(parts.find((part) => part.kind === "node").shape, "merge");
  const branch = parts.find((part) => part.kind === "branch");
  assert.ok(branch, "a merge draws the curve into the lane it opens");
  // The curve starts at the node's column and ends at the branch lane's.
  assert.match(branch.path, /^M 5 14 C /, "it leaves the node's own column");
  assert.match(branch.path, / 15 14$/, "and arrives at the branch lane");
  // The branch lane must not also run full height: that would draw a stub up
  // to a column that was free above.
  const branchLine = parts.find((part) => part.kind === "line" && part.lane === 1);
  assert.equal(branchLine.y1, 14, "the opened lane starts at the curve, not at the top");
  assert.equal(branchLine.y2, 28);
});

test("a lane the row merely passes through runs the full height", () => {
  const { parts } = rowGeometry(graph({ entry: true, exit: true, lanes: [1] }), 2, 10, 28, 3);
  const lane = parts.find((part) => part.kind === "line" && part.lane === 1);
  assert.equal(lane.y1, 0, "a lane that was already open continues from the top");
  assert.equal(lane.y2, 28);
});

test("lanes sharing one parent fold into it instead of running past it", () => {
  // The shape every set of topic branches cut from one base makes: three
  // lanes were all carrying this commit, and all three end on its row.
  const { parts } = rowGeometry(
    graph({ entry: true, exit: true, lanes: [], branches: [], incoming: [1, 2, 3] }),
    4,
    10,
    28,
    3,
  );
  for (const lane of [1, 2, 3]) {
    const arriving = parts.find((part) => part.kind === "line" && part.lane === lane);
    assert.equal(arriving.y1, 0, `lane ${lane} arrives from above`);
    assert.equal(arriving.y2, 14, `lane ${lane} stops at the node's height`);
    const curve = parts.find((part) => part.kind === "branch" && part.lane === lane);
    assert.ok(curve, `lane ${lane} bends into the node`);
    // The curve runs from the lane's own column back to the node's column 0.
    assert.match(curve.path, new RegExp(`^M ${lane * 10 + 5} 14 C `));
    assert.match(curve.path, / 5 14$/);
  }
  // None of them continues below: the node's own column is the only line out.
  assert.equal(parts.filter((part) => part.kind === "line" && part.y2 === 28).length, 1);
});

test("a line whose parent is below the loaded window is dashed, not ended", () => {
  const { parts } = rowGeometry(graph({ exit: true, dangling: true }), 1, 10, 28, 3);
  const below = parts.find((part) => part.kind === "line" && part.y2 === 28);
  assert.equal(below.dashed, true, "the line says it continues past what is loaded");
  const whole = rowGeometry(graph({ exit: true, dangling: false }), 1, 10, 28, 3);
  assert.equal(whole.parts.find((part) => part.kind === "line" && part.y2 === 28).dashed, false);
});

test("a folded row draws one straight line and no branches", () => {
  // An over-wide history is drawn first-parent: the drawing is the plain line,
  // and `folded` is what the view announces in words.
  const { parts } = rowGeometry(
    graph({ entry: true, exit: true, merge: true, folded: true }),
    1,
    10,
    28,
    3,
  );
  assert.equal(parts.filter((part) => part.kind === "branch").length, 0);
  assert.equal(parts.filter((part) => part.kind === "line" && part.lane === 0).length, 2);
  // The merge fact is still carried, so a folded graph does not quietly
  // become a linear history.
  assert.equal(parts.find((part) => part.kind === "node").shape, "merge");
});

test("a row is drawn from its own graph alone", () => {
  // The property the virtual list depends on: a windowed row needs nothing
  // from its neighbours, so scrolling cannot make a line jump a column.
  const rows = [graph({ entry: false, exit: true }), graph({ entry: true, exit: true, merge: true, lanes: [1], branches: [1] }), graph({ entry: true, exit: false, root: true })];
  const drawn = rows.map((row) => rowGeometry(row, 2, 10, 28, 3));
  assert.equal(drawn[0].width, 20);
  assert.equal(drawn[0].parts.length, 2, "an entry-less row is a line and a dot");
  for (const geometry of drawn) {
    assert.equal(geometry.width, 20);
    assert.equal(geometry.height, 28);
  }
});

test("buildHistoryRows carries the graph through without touching it", () => {
  const g = graph({ merge: true, lanes: [1], branches: [1], dangling: true });
  const [row] = buildHistoryRows([commit(1, { graph: g })]);
  assert.equal(row.commit.graph, g, "the row hands the backend's graph on unchanged");
});
