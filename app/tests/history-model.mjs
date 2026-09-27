import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildHistoryRows,
  commitMatches,
  filterCommits,
  findError,
  graphColumns,
  graphLanePx,
  graphNodePx,
  graphWidth,
  historyPageStart,
  matchPosition,
  rowGeometry,
  stepMatch,
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
  labels: { branches: [], tags: [], remotes: [], head: false },
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

test("a merge is a ring and a branch turns once out of it into its own lane", () => {
  const { parts } = rowGeometry(
    graph({ entry: true, exit: true, merge: true, lanes: [1], branches: [1] }),
    2,
    10,
    28,
    3,
  );
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
  // The line leaves the node, runs straight across what is left of the gap,
  // turns once through a quarter-round, then runs straight down the lane to
  // the row's edge. It is vertical for most of the row and turns only once.
  assert.match(branch.path, /^M 5 14 L 5(\.\d+)? 14 A /, "out of the node, then one turn");
  assert.ok(branch.path.endsWith("L 15 28"), "and straight down to the row's edge");
  assert.equal(branch.path.match(/ A /g).length, 1, "exactly one corner");
  const radius = Number(branch.path.match(/A ([\d.]+)/)[1]);
  const gap = 10;
  assert.ok(radius <= gap, `the corner stays within the gap it crosses: ${radius} <= ${gap}`);
  assert.ok(radius <= 28 / 2, `and leaves a straight run to arrive on: ${radius}`);
  assert.ok(radius > 0, "and it is a real corner");
  // The branch lane must not also run full height: that would draw a stub up
  // to a column that was free above.
  assert.equal(
    parts.filter((part) => part.kind === "line" && part.lane === 1).length,
    0,
    "the opened lane is drawn by the turn, not by a vertical",
  );
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
    );
    return Number(parts.find((part) => part.kind === "branch").path.match(/A ([\d.]+)/)[1]);
  };
  const near = radiusFor(1);
  const far = radiusFor(3);
  assert.equal(near, far, "the same corner either way — the gap is not the limit");
  assert.ok(near > 0 && near <= ROW / 2, `bounded by the row instead: ${near}`);
  // And it is a real, generous round: a corner that is only a sliver of the
  // gap is what read as a hard mechanical elbow.
  assert.ok(near >= LANE * 0.5, `a turn is at least half a lane wide: ${near} vs ${LANE}`);
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
    const turn = parts.find((part) => part.kind === "branch" && part.lane === lane);
    assert.ok(turn, `lane ${lane} turns in to the node`);
    // The mirror of a branch leaving: straight down the lane, one tight
    // quarter-round, then level into the node. Each lane comes from its own
    // column and turns in on its own, so a set of them folding into one
    // commit stays legible instead of piling onto a single point.
    assert.ok(
      turn.path.startsWith(`M ${lane * 10 + 5} 0 L ${lane * 10 + 5} `),
      `lane ${lane} comes straight down its own column: ${turn.path}`,
    );
    assert.ok(turn.path.includes(" A "), `lane ${lane} turns with a corner`);
    assert.ok(turn.path.endsWith("L 5 14"), `lane ${lane} arrives at the node`);
    // Nothing may reach left of the node it joins — the bug this guards pulled
    // the line past the node and folded it back.
    const xs = [...turn.path.matchAll(/[MLA] (-?[\d.]+) (-?[\d.]+)/g)].map((m) => Number(m[1]));
    for (const x of xs) {
      assert.ok(x >= 5, `lane ${lane} never draws left of the node: x=${x}`);
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
    const { parts } = rowGeometry(graph({ entry: true, exit: true, ...extra }), 2, 10, 28, 3);
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

// --- finding a commit ---

const find = (text, extra = {}) => ({ text, regex: false, caseSensitive: false, ...extra });
const history = () => [
  commit(1, { subject: "Fix the parser", authorName: "Ada" }),
  commit(2, { subject: "add tests", authorName: "Grace" }),
  commit(3, { subject: "Fix the reader", authorName: "ada" }),
];

test("a find matches the subject, the author, the object id and the ref names", () => {
  assert.ok(commitMatches(history()[0], find("parser")));
  assert.ok(commitMatches(history()[0], find("Ada")), "an author matches");
  assert.ok(
    commitMatches(history()[0], find(history()[0].oid)),
    "an id pasted from a bug report finds its commit",
  );
  // Typing a branch or tag name finds the commit that name points at.
  const labelled = commit(9, { subject: "nothing alike", labels: { branches: ["release-1.0"], tags: [], remotes: [], head: false } });
  assert.ok(commitMatches(labelled, find("release-1.0")), "a branch name matches");
  assert.equal(commitMatches(history()[1], find("parser")), false);
});

test("a find is case-insensitive unless asked otherwise", () => {
  assert.ok(commitMatches(history()[2], find("ADA")));
  assert.equal(commitMatches(history()[2], find("ADA", { caseSensitive: true })), false);
  assert.ok(commitMatches(history()[2], find("ada", { caseSensitive: true })));
});

test("a regular expression find is a real regular expression", () => {
  assert.ok(commitMatches(history()[0], find("^Fix", { regex: true })));
  assert.equal(commitMatches(history()[1], find("^Fix", { regex: true })), false);
  assert.ok(commitMatches(history()[0], find("f(i|x)x", { regex: true })));
  // An expression that does not compile matches nothing and is reported,
  // rather than throwing at the reader mid-keystroke.
  const broken = find("Fix (", { regex: true });
  assert.equal(commitMatches(history()[0], broken), false);
  assert.equal(findError(broken), "Not a valid regular expression.");
  assert.equal(findError(find("Fix (")), null, "a substring is never a broken expression");
});

test("filtering keeps the loaded order, because a graph only reads downward", () => {
  const kept = filterCommits(history(), find("Fix"));
  assert.deepEqual(kept.map((c) => c.subject), ["Fix the parser", "Fix the reader"]);
  assert.equal(filterCommits(history(), find("")).length, 3, "an empty query keeps everything");
  assert.equal(filterCommits(history(), find("nothing here")).length, 0);
});

test("stepping through the matches wraps at both ends", () => {
  const commits = history();
  const query = find("Fix");
  // Stepping into an empty selection starts at the first match.
  assert.equal(stepMatch(commits, query, null, 1), commits[0].oid);
  assert.equal(stepMatch(commits, query, commits[0].oid, 1), commits[2].oid);
  assert.equal(stepMatch(commits, query, commits[2].oid, 1), commits[0].oid, "wraps forward");
  assert.equal(stepMatch(commits, query, commits[0].oid, -1), commits[2].oid, "wraps back");
  assert.equal(stepMatch(commits, find("absent"), null, 1), null, "no matches, no step");
  assert.deepEqual(matchPosition(commits, query, commits[2].oid), { index: 1, total: 2 });
  assert.deepEqual(matchPosition(commits, query, null), { index: -1, total: 2 });
});
