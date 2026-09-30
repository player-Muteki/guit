import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  anchorRow,
  buildHistoryRows,
  buildRefMap,
  bubbleInsetPx,
  graphColumns,
  graphGutterMaxPx,
  graphLanePx,
  graphNodePx,
  graphPan,
  graphWidth,
  historyPageStart,
  indexNames,
  includedInLine,
  namesAt,
  placeBubble,
  refsIncluding,
  rowGeometry,
  unknownNames,
  BUBBLE_INSET_REM,
  GRAPH_LANE_REM,
  GRAPH_NODE_REM,
  GRAPH_GUTTER_MAX_REM,
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
  // A row carries no name: what a commit is called is a fact about a
  // reference, and it arrives from the listing joined by `oid`.
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
  assert.equal(
    GRAPH_GUTTER_MAX_REM,
    cssRem("graph-gutter-max"),
    "the gutter ceiling follows --graph-gutter-max",
  );
  assert.ok(
    cssRem("graph-fade") <= GRAPH_GUTTER_MAX_REM,
    "the fade band fits inside the ceiling it lives at the end of",
  );
  assert.equal(graphLanePx(20), 20 * GRAPH_LANE_REM);
  assert.equal(graphNodePx(20), 20 * GRAPH_NODE_REM);
  assert.equal(graphGutterMaxPx(20), 20 * GRAPH_GUTTER_MAX_REM);
});

test("the node the pointer rests on grows, and only it", () => {
  // Hover feedback is a stylesheet fact about one size token; if the rule
  // or the token drifts apart, the graph stops answering the mouse and no
  // runtime test would notice.
  assert.ok(
    cssRem("graph-node-hover") > GRAPH_NODE_REM,
    "the hover size is really larger than the resting one",
  );
  const css = stylesheet("style.css");
  assert.match(
    css,
    /\.graph-gutter:hover \.graph-node:not\(\[data-inner\]\)\s*\{\s*r:\s*var\(--graph-node-hover\)/,
    "the hover rule grows nodes by the token, and spares a merge's inner dot",
  );
  assert.ok(
    !/\.graph-gutter:hover[^{]*\{[^}]*stroke/.test(css),
    "the hover rule touches no stroke — one width for the whole graph",
  );
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

test("an over-wide row is capped at the gutter ceiling and marked clipped", () => {
  // A deep fan repays its width in every row if the gutter follows it. The
  // drawn width stops at the ceiling instead, and the row says it hangs off
  // the edge so the view can fade rather than cut.
  const cap = 80;
  const wide = rowGeometry(
    graph({ entry: true, exit: true, merge: true, lanes: [10], incoming: [10] }),
    20,
    10,
    28,
    3,
    cap,
  );
  assert.equal(wide.width, cap, "the drawn width stops at the ceiling");
  assert.equal(wide.clipped, true, "a lane past the edge is announced");
  assert.ok(
    wide.parts.some((part) => part.kind === "line" && part.x > cap),
    "the over-wide lane is still generated, so only the display clipped it",
  );
  const narrow = rowGeometry(graph({ entry: true, exit: true }), 20, 10, 28, 3, cap);
  assert.equal(narrow.width, cap, "the gutter is still the loaded width while it fits");
  assert.equal(narrow.clipped, false, "a row inside the ceiling carries no fade");
  const tighter = rowGeometry(graph({ entry: true, exit: true, merge: true, lanes: [1] }), 2, 10, 28, 3, 5);
  assert.equal(tighter.width, 10, "never narrower than one lane, ceiling or not");
});

// The backend folds a window above this many live lanes; the gutter draws any
// graph up to that number and leaves the ones past its ceiling to the pan.
// Read out of the Rust so the two ends of one contract cannot drift apart in
// silence — a raised `MAX_LANES` is supposed to widen what the pan reaches.
const backendLaneCap = () => {
  const source = readFileSync(
    fileURLToPath(new URL("../src-tauri/src/history.rs", import.meta.url)),
    "utf8",
  );
  const match = source.match(/pub const MAX_LANES: Lane = (\d+);/);
  assert.ok(match, "the backend's lane cap is a declared constant");
  return Number(match[1]);
};

test("the ceiling leaves columns for the pan, and the pan reaches them", () => {
  const lane = graphLanePx(16);
  const cap = graphGutterMaxPx(16);
  const shown = Math.floor(cap / lane);
  assert.ok(
    shown < backendLaneCap(),
    "the gutter shows fewer columns than the backend draws, so a wide graph is panned, not folded",
  );
  const history = graphPan(backendLaneCap(), lane, cap, 0);
  assert.equal(history.shown, shown, "the pan counts the columns the drawn width has room for");
  assert.equal(history.columns, backendLaneCap());
  assert.equal(history.over, true, "columns past the edge are announced");
  assert.equal(history.origin, 0);
  // Panning stops where the history does: past the last column the gutter
  // would show empty width and claim it was the edge of a branch.
  const far = graphPan(backendLaneCap(), lane, cap, 999);
  assert.equal(far.origin, backendLaneCap() - shown, "the run ends with the last column drawn");
  assert.equal(graphPan(backendLaneCap(), lane, cap, -3).origin, 0, "and never before the first");
  const fits = graphPan(shown, lane, cap, 4);
  assert.equal(fits.over, false, "a history that fits has nothing to pan");
  assert.equal(fits.origin, 0, "and a stored overshoot is not a position it can be left at");
});

test("panning brings a far column into the box without moving the gutter", () => {
  const lane = 10;
  const cap = 80;
  const wide = graph({ entry: true, exit: true, lanes: [10] });
  const before = rowGeometry(wide, 20, lane, 28, 3, cap, 0);
  assert.equal(before.width, cap, "one width for every origin, so the subject text cannot slide");
  assert.equal(before.clipped, true, "the lane hangs off the edge");
  const after = rowGeometry(wide, 20, lane, 28, 3, cap, 10);
  assert.equal(after.width, cap, "the gutter does not follow the pan");
  const moved = after.parts.find((part) => part.kind === "line" && part.lane === 10);
  assert.equal(moved.x, 0.5 * lane, "column 10 is drawn in the gutter's first lane");
  assert.equal(after.clipped, false, "a row inside the box carries no fade");
  // Every column in the row moves by the same distance. A pan that shifted
  // the lanes and not the dots — or one row and not its neighbour — would
  // break a lane apart at the row boundary and draw a history that does not
  // connect.
  const place = (origin) => {
    const parts = rowGeometry(wide, 20, lane, 28, 3, cap, origin).parts;
    return [
      parts.find((part) => part.kind === "node").cx,
      parts.find((part) => part.kind === "line" && part.lane === 10).x,
    ];
  };
  const [dotRest, laneRest] = place(0);
  const [dotPanned, lanePanned] = place(10);
  assert.equal(dotRest - dotPanned, 10 * lane, "the dot moves ten columns left under the pan");
  assert.equal(
    laneRest - lanePanned,
    10 * lane,
    "and its lane by exactly the same, so a lane still meets its neighbours",
  );
});

test("a straight line enters from above, leaves below, and joins at the dot", () => {
  const { parts } = rowGeometry(
    graph({ entry: true, exit: true }),
    1,
    10,
    28,
    3,
  1e9);
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
  const top = rowGeometry(graph({ entry: false, exit: true }), 1, 10, 28, 3, 1e9);
  assert.equal(top.parts.filter((part) => part.kind === "line" && part.y1 === 0).length, 0);
  const root = rowGeometry(graph({ entry: true, exit: false, root: true }), 1, 10, 28, 3, 1e9);
  assert.equal(root.parts.filter((part) => part.kind === "line" && part.y2 === 28).length, 0);
  assert.equal(root.parts.find((part) => part.kind === "node").shape, "root");
});

test("a merge is a ring and a branch turns once out of it into its own lane", () => {
  const { parts } = rowGeometry(
    graph({ entry: true, exit: true, merge: true, lanes: [1], branches: [1] }),
    2,
    10,
    28,
    3,
  1e9);
  assert.equal(parts.find((part) => part.kind === "node").shape, "merge");
  // A merge is a ring with a filled dot inside it, so it reads as a join
  // rather than as a plain commit drawn hollow.
  const nodes = parts.filter((part) => part.kind === "node");
  assert.equal(nodes.length, 2, "the merge is a ring and a dot");
  assert.equal(nodes[0].shape, "merge");
  assert.equal(nodes[1].shape, "normal", "the inner dot is filled");
  assert.ok(
    nodes[1].r < nodes[0].r * 0.6,
    "the inner dot sits well inside the ring: ${nodes[1].r} vs ${nodes[0].r}",
  );
  assert.equal(nodes[1].cx, nodes[0].cx, "both are centred on the same point");
  assert.equal(nodes[1].cy, nodes[0].cy);

  const branch = parts.find((part) => part.kind === "branch");
  assert.ok(branch, "a merge draws the turn into the lane it opens");
  // The line leaves the node level with its centre, curves once, and meets
  // the row's edge vertically. One cubic, no arcs, no straight stubs.
  assert.match(branch.path, /^M 5 14 C 15 14 /, "out of the node, level at the dot");
  assert.ok(branch.path.endsWith(" 15 28"), "and vertical into the lane at the row's edge");
  assert.equal(branch.path.match(/ C /g).length, 1, "exactly one curve");
  assert.ok(!branch.path.includes(" A "), "a cubic, not a quarter-round arc");
  const offset = Number(branch.path.match(/C ([\d.]+)/)[1]) - 5;
  const gap = 10;
  assert.ok(offset <= gap, `the curve stays within the gap it crosses: ${offset} <= ${gap}`);
  assert.ok(offset <= 28 / 2, `and leaves a straight run to arrive on: ${offset}`);
  assert.ok(offset > 0, "and it is a real turn");
  // The branch lane must not also run full height: that would draw a stub up
  // to a column that was free above.
  assert.equal(
    parts.filter((part) => part.kind === "line" && part.lane === 1).length,
    0,
    "the opened lane is drawn by the turn, not by a vertical",
  );
});

test("a turn meets the row edges vertically so windowed rows join seamlessly", () => {
  // The virtual list draws each row on its own, so the only contract between
  // neighbours is where a curve touches the row's top and bottom edges. A
  // turn that arrived at an angle would kink against the next row's straight
  // lane the moment that neighbour scrolled in. Vertical arrival is exactly
  // what the first control points encode: they share their endpoint's column.
  const { parts } = rowGeometry(
    graph({ entry: true, exit: true, merge: true, branches: [1], incoming: [2] }),
    3,
    10,
    28,
    3,
  1e9);
  const nums = (path) => path.match(/-?[\d.]+/g).map(Number);
  const branch = nums(parts.find((part) => part.kind === "branch" && part.lane === 1).path);
  assert.equal(branch[0], 5, "the branch starts at the node's column");
  assert.equal(branch[1], 14, "at the node's height");
  assert.equal(branch[6], 15, "it ends on its own lane");
  assert.equal(branch[7], 28, "exactly at the row's bottom edge");
  assert.equal(branch[4], branch[6], "the last control point shares the endpoint's column: vertical arrival");
  const incoming = nums(parts.find((part) => part.kind === "branch" && part.lane === 2).path);
  assert.equal(incoming[0], 25, "the incoming lane starts on its own column");
  assert.equal(incoming[1], 0, "exactly at the row's top edge");
  assert.equal(incoming[2], incoming[0], "the first control point shares the start's column: vertical departure");
  assert.equal(incoming[6], 5, "it levels into the node's column");
  assert.equal(incoming[7], 14, "at the node's height");
});

test("a turn to a neighbouring lane is as round as one to a distant lane", () => {
  // The radius used to be capped at half the *narrowest* gap in the graph, so
  // every corner in every history was as tight as the tightest one. A turn
  // only has to stay between the two columns it joins, so a one-column hop may
  // be as roundy as a three-column one. Measured at the metrics that ship, so
  // this is the corner a reader actually sees.
  const LANE = 13;
  const ROW = 24;
  const radiusFor = (columns) => {
    const { parts } = rowGeometry(
      graph({ entry: true, exit: true, branches: [columns] }),
      columns + 1,
      LANE,
      ROW,
      3,
    1e9);
    return Number(parts.find((part) => part.kind === "branch").path.match(/C ([\d.]+)/)[1]) - 0.5 * LANE;
  };
  const near = radiusFor(1);
  const far = radiusFor(3);
  assert.equal(near, far, "the same turn either way — the gap is not the limit");
  assert.ok(near > 0 && near <= ROW / 2, `bounded by the row instead: ${near}`);
  // And it is a real, generous round: a turn that is only a sliver of the
  // gap is what read as a hard mechanical elbow.
  assert.ok(near >= LANE * 0.5, `a turn is at least half a lane wide: ${near} vs ${LANE}`);
});

test("a lane the row merely passes through runs the full height", () => {
  const { parts } = rowGeometry(graph({ entry: true, exit: true, lanes: [1] }), 2, 10, 28, 3, 1e9);
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
  1e9);
  for (const lane of [1, 2, 3]) {
    const turn = parts.find((part) => part.kind === "branch" && part.lane === lane);
    assert.ok(turn, `lane ${lane} turns in to the node`);
    // The mirror of a branch leaving: vertical down the lane from the row's
    // edge, one curve, then level into the node. Each lane comes from its own
    // column and turns in on its own, so a set of them folding into one
    // commit stays legible instead of piling onto a single point.
    assert.ok(
      turn.path.startsWith(`M ${lane * 10 + 5} 0 C ${lane * 10 + 5} `),
      `lane ${lane} leaves the row edge vertically down its own column: ${turn.path}`,
    );
    assert.equal(turn.path.match(/ C /g).length, 1, `lane ${lane} turns with one curve`);
    assert.ok(turn.path.endsWith(" 5 14"), `lane ${lane} arrives at the node`);
    // Nothing may reach left of the node it joins — the bug this guards pulled
    // the line past the node and folded it back. A cubic lives inside the
    // convex hull of its control points, so checking them checks the curve.
    const nums = turn.path.match(/-?[\d.]+/g).map(Number);
    for (let i = 0; i < nums.length; i += 2) {
      assert.ok(nums[i] >= 5, `lane ${lane} never draws left of the node: x=${nums[i]}`);
    }
    // No vertical stub: the turn is the whole connection.
    assert.equal(
      parts.filter((part) => part.kind === "line" && part.lane === lane).length,
      0,
      `lane ${lane} has no vertical of its own`,
    );
  }
  // None of them continues below: the node's own column is the only line out.
  assert.equal(parts.filter((part) => part.kind === "line" && part.y2 === 28).length, 1);
});

test("a line is drawn the same width however the row is doing", () => {
  // Line weight is a fact about a lane, not about the row it passes through.
  // When it varied, a straight run of the mainline swelled at every merge it
  // went near and a corner came out heavier than the straight run it joined —
  // the line stopped reading as one continuous stroke. So no part may carry a
  // weight at all: the stylesheet gives every line in the graph one width.
  const kinds = [
    ["a plain row", {}],
    ["a merge", { merge: true }],
    ["the first commit", { root: true }],
    ["a branch opening", { branches: [1] }],
    ["lanes folding in", { incoming: [1] }],
    ["a line leaving the window", { dangling: true }],
    ["a lane running past", { lanes: [1] }],
  ];
  for (const [name, extra] of kinds) {
    const { parts } = rowGeometry(graph({ entry: true, exit: true, ...extra }), 2, 10, 28, 3, 1e9);
    assert.ok(parts.length > 0, `${name} draws something`);
    for (const part of parts) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(part, "weight"),
        false,
        `${name}: a ${part.kind} carries no weight — one width for the whole graph`,
      );
    }
  }
  // And the stylesheet really does name a single width for the lines
  // themselves. The ring around a merge is a marker rather than a run of
  // line, so it is allowed its own, slightly finer, stroke.
  const css = stylesheet("style.css");
  const widthFor = (kind) => [
    ...new Set(
      [...css.matchAll(
        new RegExp(`\\.graph-gutter \\.graph-${kind}\\s*\\{[^}]*stroke-width:\\s*var\\((--[\\w-]+)\\)`, "g"),
      )].map((match) => match[1]),
    ),
  ];
  assert.deepEqual(
    widthFor("line"),
    ["--graph-stroke"],
    "every graph line shares one width token",
  );
  // A line and the underlay that backs it are two different things: the
  // underlay is deliberately wider so a crossing stays readable.
  assert.deepEqual(
    widthFor("shadow"),
    ["--graph-under"],
    "every underlay shares one width token",
  );

  // Every shape in the gutter must say what it fills. An SVG shape is filled
  // black by default, so a missing `fill: none` closes a line into a solid
  // wedge behind it — a bug that is invisible in a stylesheet review and
  // obvious on screen.
  const rules = [...css.matchAll(/\.graph-gutter \.graph-(\w+)\s*\{([^}]*)\}/g)];
  assert.ok(rules.length > 0, "the graph has rules to check");
  for (const [, name, body] of rules) {
    if (name === "node") continue; // a node is meant to be filled
    assert.match(body, /fill:\s*none/, `.graph-${name} must declare fill: none`);
    assert.match(body, /stroke:\s*/, `.graph-${name} must declare a stroke`);
  }
});

test("a line whose parent is below the loaded window is dashed, not ended", () => {
  const { parts } = rowGeometry(graph({ exit: true, dangling: true }), 1, 10, 28, 3, 1e9);
  const below = parts.find((part) => part.kind === "line" && part.y2 === 28);
  assert.equal(below.dashed, true, "the line says it continues past what is loaded");
  const whole = rowGeometry(graph({ exit: true, dangling: false }), 1, 10, 28, 3, 1e9);
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
  1e9);
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
  const drawn = rows.map((row) => rowGeometry(row, 2, 10, 28, 3, 1e9));
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

// --- which names sit on a commit ---

const oid = (n) => String(n).padStart(40, "0");

// The listing the names read answers with, in the shape the backend sends it:
// every name carrying the object it points at. A tag peels to a commit unless
// it names something else, which is the third element of its triple.
const listing = ({ branches = [], tags = [], remotes = [] } = {}) =>
  indexNames({
    branches: branches.map(([name, n]) => ({
      name,
      oid: oid(n),
      head: false,
      upstream: null,
      ahead: null,
      behind: null,
      upstreamGone: false,
      addressable: true,
    })),
    tags: tags.map(([name, n, type = "commit"]) => ({
      name,
      oid: oid(n),
      targetType: type,
      commitOid: type === "commit" ? oid(n) : null,
      annotated: false,
      addressable: true,
    })),
    remotes: remotes.map(([name, n]) => ({
      name,
      oid: oid(n),
      symref: null,
      addressable: true,
    })),
  });

const noNames = listing();

test("the ref map names the loaded refs that contain a commit", () => {
  // 1 is the shared base; 2 and 3 are topic tips; 4 is the merge that
  // carries them into main. The pages arrive newest first, exactly as the
  // backend loads them.
  const loaded = [
    commit(4, { parents: [oid(2), oid(3)] }),
    commit(2, { parents: [oid(1)] }),
    commit(3, { parents: [oid(1)] }),
    commit(1, { parents: [] }),
  ];
  const names = listing({ branches: [["main", 4], ["feature-a", 2], ["feature-b", 3]] });
  const map = buildRefMap(loaded);
  assert.deepEqual(
    refsIncluding(map, names, oid(1)).names,
    ["feature-a", "feature-b", "main"],
    "the base is named by every tip above it, nearer tips first",
  );
  assert.deepEqual(refsIncluding(map, names, oid(4)).names, ["main"], "a tip names itself");
  assert.deepEqual(
    refsIncluding(map, names, oid(2)).names,
    ["feature-a", "main"],
    "a descendant's name does not leak down onto an ancestor",
  );
  assert.deepEqual(
    refsIncluding(map, names, oid(99)).names,
    [],
    "an oid that is not loaded has no answer, not a wrong one",
  );
  assert.equal(refsIncluding(map, names, oid(99)).truncated, false);
});

test("ref names deduplicate and truncate rather than rambling", () => {
  // A chain whose two lowest commits both carry `shared` — the same ref seen
  // twice on one walk — plus a branch and a remote above them.
  const loaded = [
    commit(3, { parents: [oid(2)] }),
    commit(2, { parents: [oid(1)] }),
    commit(1, { parents: [oid(0)] }),
    commit(0, { parents: [] }),
  ];
  const names = listing({
    branches: [["main", 2], ["shared", 1], ["shared", 0]],
    remotes: [["origin/main", 3]],
  });
  const map = buildRefMap(loaded);
  const summary = refsIncluding(map, names, oid(0));
  assert.deepEqual(summary.names, ["shared", "main", "origin/main"], "each name once");
  const capped = refsIncluding(map, names, oid(0), 2);
  assert.deepEqual(capped.names, ["shared", "main"]);
  assert.equal(capped.truncated, true, "the cap says there was more");
  assert.equal(refsIncluding(map, names, oid(0), 3).truncated, false, "no more, no ellipsis");
});

test("a name moves with the commit it points at, and the history stays put", () => {
  // The whole reason the labels are a second read: `main` moving from one
  // loaded commit to another changes nothing about the commits themselves, so
  // the rows are joined again rather than read again.
  const loaded = [commit(2, { parents: [oid(1)] }), commit(1, { parents: [oid(0)] }), commit(0)];
  const map = buildRefMap(loaded);
  const before = listing({ branches: [["main", 2]] });
  const after = listing({ branches: [["main", 1]] });
  assert.deepEqual(namesAt(before, oid(2)).map((chip) => chip.name), ["main"]);
  assert.deepEqual(namesAt(after, oid(2)), [], "the moved name left the row it was on");
  assert.deepEqual(namesAt(after, oid(1)).map((chip) => chip.name), ["main"]);
  assert.equal(map.byOid.size, loaded.length, "the walk is the topology alone; a listing never enters it");
  assert.deepEqual(refsIncluding(map, after, oid(0)).names, ["main"], "and the same walk answers both");
});

test("a tag that names no commit is a name with no row to sit on", () => {
  const loaded = [commit(1, { parents: [oid(0)] }), commit(0)];
  const names = listing({ branches: [["main", 1]], tags: [["v1", 1, "tree"], ["v2", 0]] });
  assert.deepEqual(
    namesAt(names, oid(1)).map((chip) => chip.kind),
    ["branch"],
    "the branch is on the commit; the tag naming a tree is not",
  );
  assert.deepEqual(
    namesAt(names, oid(0)).map((chip) => chip.kind),
    ["tag"],
    "a tag that does name a commit is joined through the peel",
  );
  assert.deepEqual(
    refsIncluding(buildRefMap(loaded), names, oid(0)).names,
    ["v2", "main"],
    "the tag on the commit is found first, and the tag on the tree never",
  );
});

test("a namespace that could not be read is not an empty one", () => {
  const loaded = [commit(1, { parents: [oid(0)] }), commit(0)];
  const map = buildRefMap(loaded);
  const some = listing({ branches: [["main", 1]] });
  assert.equal(some.unknown, false, "a listing that arrived is known, however short");
  assert.equal(noNames.unknown, false, "a repository with no names at all is a fact");
  const unknown = unknownNames();
  assert.equal(unknown.unknown, true);
  assert.deepEqual(namesAt(unknown, oid(1)), []);
  assert.deepEqual(refsIncluding(map, unknown, oid(1)), { names: [], truncated: false });
});

// --- the bubble over a hovered or focused row ---

// The pane is the list at the minimum window (340 CSS px wide) and the font is
// the interface default, so the inset the calls below pass is the one the model
// computes rather than a number the test picked.
const pane = { left: 0, top: 0, width: 340, height: 400 };
const inset = bubbleInsetPx(16);
const row = (top) => ({ left: 8, top, width: 324, height: 24 });

test("a bubble lands under its row, flush against it", () => {
  const placed = placeBubble(row(100), pane, { width: 200, height: 60 }, inset);
  assert.ok(placed !== null);
  assert.equal(placed.left, 8, "the row's own left edge");
  assert.equal(placed.top, 124, "the row's bottom edge, with no gap between them");
  assert.equal(placed.above, false);
  assert.ok(placed.top >= 124, "and it is clear of the row it answers");
  assert.equal(placed.width, 200);
  assert.equal(placed.height, 60);
  // Flipping up has to be flush too. The pointer travels between the two boxes
  // and the bubble closes when the pointer is on neither, so a gap of even a
  // few pixels is a gap the reader falls through — the reason there is no gap
  // parameter on the call above.
  const flipped = placeBubble(row(380), pane, { width: 200, height: 60 }, inset);
  assert.equal(flipped.above, true);
  assert.equal(flipped.top + flipped.height, 380, "the box ends where the row starts");
});

test("a bubble takes the room the pane has, not more", () => {
  const wide = placeBubble(row(100), pane, { width: 4000, height: 60 }, inset);
  assert.equal(wide.width, pane.width - 2 * inset, "capped to the pane's inner box");
  assert.equal(wide.left, inset, "and therefore pushed off the row's left edge to stay inside");
  const tall = placeBubble(row(100), pane, { width: 200, height: 4000 }, inset);
  assert.equal(tall.height, pane.height - 2 * inset);
  assert.ok(tall.top < 124 && tall.top + tall.height > 100, "a box as tall as the pane covers the row it came from");
});

test("with room on neither side the bubble picks the larger and stays in the pane", () => {
  // A 300px box in a 400px pane, over a row 150px down: 220px of room below,
  // 144px above. Neither holds it, so it goes below — against the pane's
  // bottom edge — covering the row it came from rather than leaving the pane
  // to avoid it.
  const placed = placeBubble(row(150), pane, { width: 200, height: 300 }, inset);
  assert.equal(placed.above, false);
  assert.equal(placed.top + placed.height, pane.height - inset, "flush with the pane's inner bottom");
  assert.ok(placed.top < 174, "and over the row");
  // The mirror: the same box over a row with more room above it than below.
  const up = placeBubble(row(200), pane, { width: 200, height: 300 }, inset);
  assert.equal(up.above, true);
  assert.equal(up.top, inset, "flush with the pane's inner top");
});

test("a bubble is inside its pane however its row sits", () => {
  // The invariant the whole avoidance rule exists for, checked over rows from
  // the top of the list to the bottom and boxes from short to taller than the
  // pane, rather than over the handful of cases a reader would think to name.
  for (const top of [0, 1, 24, 100, 250, 375, 376, 399]) {
    for (const size of [[120, 40], [328, 200], [400, 460], [60, 8]]) {
      const anchor = { left: 4, top, width: 332, height: 24 };
      const placed = placeBubble(anchor, pane, { width: size[0], height: size[1] }, inset);
      assert.ok(placed !== null, `a drawn row at ${top} places something`);
      assert.ok(placed.left >= pane.left + inset - 1e-9, `left inside at ${top}/${size[0]}`);
      assert.ok(placed.top >= pane.top + inset - 1e-9, `top inside at ${top}/${size[1]}`);
      assert.ok(placed.left + placed.width <= pane.left + pane.width - inset + 1e-9);
      assert.ok(placed.top + placed.height <= pane.top + pane.height - inset + 1e-9);
      assert.ok(placed.width <= pane.width - 2 * inset + 1e-9);
      assert.ok(placed.height <= pane.height - 2 * inset + 1e-9);
    }
  }
});

test("a row that is not drawn has no bubble", () => {
  // Hiding the page is what makes these boxes empty: an element in a hidden
  // subtree measures zero on both axes. A bubble placed against those numbers
  // would land at the origin of the view and describe a commit nobody can see,
  // so the answer is that there is nothing to place on.
  assert.equal(placeBubble({ left: 0, top: 0, width: 0, height: 0 }, pane, { width: 200, height: 60 }, inset), null);
  assert.equal(placeBubble(row(100), { left: 0, top: 0, width: 340, height: 0 }, { width: 200, height: 60 }, inset), null);
  assert.equal(placeBubble(row(100), pane, { width: 0, height: 0 }, inset).width, 0, "an empty box is still a placeable one");
});

test("the anchored row is the bubble's only claim on a commit", () => {
  const loaded = [commit(1), commit(2), commit(3)];
  assert.equal(anchorRow(loaded, 1, loaded[1].oid), loaded[1], "the row still names it");
  // Scrolling, a new page and a filter all rebuild rows by index. The number
  // says where to look; only the id says whether what is there is still the
  // thing being described — and if it is not, the bubble closes rather than
  // following the position onto a different commit.
  assert.equal(anchorRow(loaded, 1, loaded[2].oid), null, "the row moved out from under it");
  // A list rebuilt around the same commit — a refresh handing the view a new
  // object for the id it is already describing — is still that commit.
  const rebuilt = anchorRow([commit(9), commit(2), commit(3)], 1, loaded[1].oid);
  assert.equal(rebuilt?.oid, loaded[1].oid, "an id is worth more than a slot");
  assert.equal(anchorRow(loaded, 3, loaded[2].oid), null, "past the end");
  assert.equal(anchorRow(loaded, -1, loaded[0].oid), null, "before the start");
  assert.equal(anchorRow([], 0, loaded[0].oid), null, "a list that has gone");
});

test("the containment line tells a refused names read from a commit nothing names", () => {
  const loaded = [commit(1), commit(2, { parents: [oid(1)] })];
  const map = buildRefMap(loaded);
  const names = listing({ branches: [["main", 2], ["side", 2]] });
  const summary = refsIncluding(map, names, oid(1));
  assert.equal(includedInLine(names, summary), "main, side");
  assert.equal(includedInLine(names, refsIncluding(map, names, oid(2))), "main, side");
  // Nothing loaded contains it — a fact about this history, and drawn as one.
  assert.equal(includedInLine(names, { names: [], truncated: false }), "nothing loaded");
  // Git refused the names read. That is not "nothing loaded": the same empty
  // list drawn as the second would turn a failure into a claim about the
  // repository, which is why the line asks the index rather than the summary.
  assert.equal(includedInLine(unknownNames(), { names: [], truncated: false }), "the names could not be read");
  assert.equal(includedInLine(unknownNames(), summary), "the names could not be read");
  // The cap is on the list, not on the search, so more names says so.
  const many = listing({ branches: Array.from({ length: 12 }, (_, i) => [`b${i}`, 2]) });
  assert.equal(includedInLine(many, refsIncluding(map, many, oid(1), 10)), "b0, b1, b2, b3, b4, b5, b6, b7, b8, b9 …");
  assert.equal(includedInLine(many, refsIncluding(map, many, oid(1), 20)), Array.from({ length: 12 }, (_, i) => `b${i}`).join(", "));
});
