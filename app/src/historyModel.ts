// Pure view-model for the commit list and its graph, mirroring
// `fileModel.ts` so `node --test` can import it directly. The History view
// virtualises this list because rebuilding the whole list on every "Load
// older" click measured at 129 ms for 500 rows and 1664 ms for 3000, so rows
// are windowed exactly like the file list.
//
// The commit graph is laid out by the backend (`history.rs`): every commit
// arrives with the columns its line occupies, so deciding where a line goes
// never happens in the browser. This module only turns those columns into
// pixels, and the geometry is pure so the drawing can be asserted without a
// DOM. A row's drawing depends on no other row, which is what keeps the list
// virtual: a windowed row is drawn without consulting its neighbours.

import type { CommitView, GraphRow } from "./types";

export type HistoryRow = { kind: "commit"; commit: CommitView };

// The offset asked of the backend for the next page. A reset re-reads page
// zero of a *new* HEAD, so it must not reuse the number of commits the old
// HEAD had loaded: that many commits were skipped after every branch switch.
export function historyPageStart(loaded: number, reset: boolean): number {
  return reset ? 0 : loaded;
}

export function buildHistoryRows(commits: readonly CommitView[]): HistoryRow[] {
  return commits.map((commit) => ({ kind: "commit", commit } as const));
}

// --- the graph -----------------------------------------------------

// Horizontal distance between two lanes, and the dot radius, in rem. The
// first two must match `--graph-lane` and `--graph-node` in style/tokens.css;
// `graph-tracks-the-css` is the gate that fails when they drift. rem, not px,
// because the whole point of a zoomable interface is that the graph grows
// with it. The lane is a full rem wide so a curve leaving the mainline has
// somewhere to go before it settles into its own column.
export const GRAPH_LANE_REM = 1;
export const GRAPH_NODE_REM = 0.25;

export function graphLanePx(baseFontPx: number): number {
  return baseFontPx * GRAPH_LANE_REM;
}

export function graphNodePx(baseFontPx: number): number {
  return baseFontPx * GRAPH_NODE_REM;
}

// The gutter is as wide as the widest row in the whole loaded history, not
// the widest row on screen. Sizing it to what happens to be visible would
// make the subject text slide sideways every time a new lane scrolled in.
// One lane minimum, so a linear history still shows its line.
export function graphColumns(commits: readonly CommitView[]): number {
  let widest = 1;
  for (const commit of commits) {
    const graph = commit.graph;
    for (const column of graph.lanes) {
      if (column + 1 > widest) widest = column + 1;
    }
    for (const column of graph.branches) {
      if (column + 1 > widest) widest = column + 1;
    }
    if (graph.node + 1 > widest) widest = graph.node + 1;
  }
  return widest;
}

// One primitive of a row's drawing, in pixels. The view turns each into an
// SVG child; nothing here touches the DOM.
//
// `weight` is the line's thickness tier. A commit that is only carrying the
// mainline is drawn hairline-thin; one where a branch opens, closes or merges
// is drawn full. That difference is the whole rhythm of the gutter: scanning
// a long history, the eye should land on the rows where the shape of the work
// actually changed, not on every straight run between them.
export type GraphPart =
  // A vertical line in one lane. `lane` is the column, so the view can colour
  // a lane the same way everywhere it appears.
  | { kind: "line"; lane: number; x: number; y1: number; y2: number; dashed: boolean; weight: GraphWeight }
  // The commit's own dot. `shape` is the fact the dot carries, so colour is
  // never the only thing telling a merge from a plain commit.
  | { kind: "node"; lane: number; cx: number; cy: number; r: number; shape: "normal" | "merge" | "root"; weight: GraphWeight }
  // The one non-orthogonal line in the graph: a branch peeling out of its
  // merge and running down to the next row in its own lane, and the mirror of
  // it, a set of lanes folding back into the commit they all share. The
  // control points are pushed most of a row height from their ends, so the
  // curve is drawn in the space *between* two rows and reads as a slope
  // rather than as a right angle.
  | { kind: "branch"; lane: number; path: string; weight: GraphWeight };

export type GraphWeight = "hairline" | "lane" | "structural";

export interface RowGeometry {
  width: number;
  height: number;
  parts: GraphPart[];
}

// A row is only "structural" — worth full-strength ink — when something
// happens to the shape of the history at it: a branch opens, a set of lanes
// folds in, or the commit is a merge or the first one. Everything else is
// the mainline being carried, and is drawn quiet.
function rowWeight(graph: GraphRow): GraphWeight {
  if (
    graph.merge ||
    graph.root ||
    graph.branches.length > 0 ||
    graph.incoming.length > 0 ||
    graph.dangling
  ) {
    return "structural";
  }
  if (graph.lanes.length > 0) {
    return "lane";
  }
  return "hairline";
}

/// The drawing of one commit row. Every coordinate is in pixels measured from
/// the top-left of the row's own gutter, so the result is a self-contained
/// picture of this row and nothing else.
export function rowGeometry(
  graph: GraphRow,
  columns: number,
  laneWidth: number,
  rowHeight: number,
  nodeRadius: number,
): RowGeometry {
  const mid = rowHeight / 2;
  const at = (column: number): number => (column + 0.5) * laneWidth;
  const weight = rowWeight(graph);
  const parts: GraphPart[] = [];

  // A lane this row merely passes through runs the full height, so it joins
  // the identical lane in the rows above and below it. A lane this row
  // *opens* does not: its curve is the connection, and a vertical here too
  // would leave a stub running up to a lane that was free above.
  for (const lane of graph.lanes) {
    if (graph.branches.includes(lane)) continue;
    parts.push({
      kind: "line",
      lane,
      x: at(lane),
      y1: 0,
      y2: rowHeight,
      dashed: false,
      weight: "lane",
    });
  }
  // A curve that changes column is drawn in the space between the two rows it
  // joins: a branch leaves the node at the middle of this row and reaches its
  // lane at the bottom edge, where the next row's lane picks it up; a
  // converging lane enters at the top edge and arrives at the node. The
  // control points sit most of a row height from their ends, which is what
  // turns the step into a slope instead of a right angle.
  const reach = rowHeight * 0.8;
  const curve = (x1: number, y1: number, x2: number, y2: number): string => {
    const descending = y2 > y1;
    return `M ${x1} ${y1} C ${x1} ${y1 + (descending ? reach : -reach)} ${x2} ${y2 + (descending ? -reach : reach)} ${x2} ${y2}`;
  };
  for (const lane of graph.branches) {
    parts.push({
      kind: "branch",
      lane,
      path: curve(at(graph.node), mid, at(lane), rowHeight),
      weight: "structural",
    });
  }
  for (const lane of graph.incoming) {
    parts.push({
      kind: "branch",
      lane,
      path: curve(at(lane), 0, at(graph.node), mid),
      weight: "structural",
    });
  }
  // The node's own column: a line arrives from above and one leaves below,
  // with the dot bridging the two.
  if (graph.entry) {
    parts.push({ kind: "line", lane: graph.node, x: at(graph.node), y1: 0, y2: mid, dashed: false, weight });
  }
  if (graph.exit) {
    parts.push({
      kind: "line",
      lane: graph.node,
      x: at(graph.node),
      y1: mid,
      y2: rowHeight,
      // A line whose parent is below the loaded window is drawn dashed: it
      // leaves the list rather than ending as though the history stopped.
      dashed: graph.dangling,
      weight,
    });
  }
  parts.push({
    kind: "node",
    lane: graph.node,
    cx: at(graph.node),
    cy: mid,
    r: nodeRadius,
    shape: graph.root ? "root" : graph.merge ? "merge" : "normal",
    weight,
  });
  return { width: columns * laneWidth, height: rowHeight, parts };
}

// The window is as wide as the graph it draws, so a narrow window gives the
// text back the columns the lanes were using.
export function graphWidth(columns: number, laneWidth: number): number {
  return Math.max(columns, 1) * laneWidth;
}
