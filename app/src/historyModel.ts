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
export const GRAPH_LANE_REM = 0.8125;
// The dot has to be findable at a glance down a long list without shouting
// over the line it sits on, and it has to leave room for the ring a merge
// draws around it: two rings in neighbouring lanes must not touch, so the dot
// plus half the ring's stroke stays inside half a lane.
export const GRAPH_NODE_REM = 0.34375;

export function graphLanePx(baseFontPx: number): number {
  return baseFontPx * GRAPH_LANE_REM;
}

export function graphNodePx(baseFontPx: number): number {
  return baseFontPx * GRAPH_NODE_REM;
}

// The drawn width the gutter asks of any row, in rem, however wide the loaded
// history gets. Without a ceiling a single deep fan far down the history
// repays its width in every row on screen: the subject text slides right as
// soon as "Load older" reaches it. Rows that exceed the ceiling still draw
// every lane they have — the view fades the over-wide part at the right edge
// instead of pretending it is not there. The ceiling is eight lanes, about
// what a merge-heavy history opens at most before the backend folds it.
export const GRAPH_GUTTER_MAX_REM = 6.5;

export function graphGutterMaxPx(baseFontPx: number): number {
  return baseFontPx * GRAPH_GUTTER_MAX_REM;
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
export type GraphPart =
  // A vertical line in one lane. `lane` is the column, so the view can colour
  // a lane the same way everywhere it appears.
  | { kind: "line"; lane: number; x: number; y1: number; y2: number; dashed: boolean }
  // The commit's own dot. `shape` is the fact the dot carries, so colour is
  // never the only thing telling a merge from a plain commit.
  | { kind: "node"; lane: number; cx: number; cy: number; r: number; shape: "normal" | "merge" | "root" }
  // The one non-orthogonal line in the graph: a branch leaving a commit and
  // running down to the next row in its own lane, and the mirror of it, a set
  // of lanes folding back into the commit they all share.
  | { kind: "branch"; lane: number; path: string };

export interface RowGeometry {
  width: number;
  height: number;
  // True when this row draws further right than the drawn width, so the view
  // can fade its over-wide lanes at the edge instead of ending them at a
  // hard vertical line.
  clipped: boolean;
  parts: GraphPart[];
}

/// The drawing of one commit row. Every coordinate is in pixels measured from
/// the top-left of the row's own gutter, so the result is a self-contained
/// picture of this row and nothing else. `maxGutterWidth` is the ceiling the
/// gutter shows — a display policy, not neighbour data, so the row stays
/// independent while the drawn width stops tracking the deepest fan.
export function rowGeometry(
  graph: GraphRow,
  columns: number,
  laneWidth: number,
  rowHeight: number,
  nodeRadius: number,
  maxGutterWidth: number,
): RowGeometry {
  const mid = rowHeight / 2;
  const at = (column: number): number => (column + 0.5) * laneWidth;
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
    });
  }
  // A line that changes column is one cubic curve: it leaves the node
  // horizontally, where the dot hides the joint, and meets the row's edge
  // vertically, so it joins the next row's straight lane without a kink. The
  // virtual list depends on that vertical arrival — a row drawn at an angle to
  // its edge would show a seam the moment its neighbour scrolled in.
  //
  // The curve's control offset is bounded by how far the line has to travel
  // and by the room the row gives it, not by the distance to the *next*
  // column: a lane three columns away turns as softly as one a single column
  // away, and spends the extra width as a straight run rather than as a
  // shallower slope. That is why a fan reads as several lines rather than as
  // one line smeared wide.
  //
  // A turn only has to stay between the two columns it joins, so the offset
  // may be the whole gap rather than half of it — that is what lets a hop to a
  // neighbouring lane turn as roundly as a hop to a distant one, instead of
  // every corner in the graph being pinned tight by the narrowest case in it.
  // The row is the outer limit, because a turn taller than half a row would
  // leave no straight run to arrive on.
  const turn = (gap: number): number => Math.min(gap, rowHeight * 0.42, rowHeight / 2);
  for (const lane of graph.branches) {
    const target = at(lane);
    const radius = turn(Math.abs(target - at(graph.node)));
    parts.push({
      kind: "branch",
      lane,
      // Out of the node level with its centre, curving down to arrive at the
      // lane vertical; the second control point shares the target's column,
      // which is what makes the arrival vertical.
      path:
        `M ${at(graph.node)} ${mid} ` +
        `C ${at(graph.node) + radius} ${mid} ${target} ${rowHeight - radius} ${target} ${rowHeight}`,
    });
  }
  for (const lane of graph.incoming) {
    const source = at(lane);
    const radius = turn(Math.abs(source - at(graph.node)));
    parts.push({
      kind: "branch",
      lane,
      // The mirror: leaving the row's edge vertical down the lane, curving to
      // level into the node from its own side. Each lane arrives from its own
      // column, so a set of them folding into one commit stays legible
      // instead of piling onto it.
      path:
        `M ${source} 0 C ${source} ${radius} ${at(graph.node) + radius} ${mid} ${at(graph.node)} ${mid}`,
    });
  }
  // The node's own column: a line arrives from above and one leaves below,
  // with the dot bridging the two.
  if (graph.entry) {
    parts.push({ kind: "line", lane: graph.node, x: at(graph.node), y1: 0, y2: mid, dashed: false });
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
    });
  }
  parts.push({
    kind: "node",
    lane: graph.node,
    cx: at(graph.node),
    cy: mid,
    r: nodeRadius,
    shape: graph.root ? "root" : graph.merge ? "merge" : "normal",
  });
  // A merge is drawn as a ring with a filled dot inside it, so it reads as a
  // join rather than as a plain commit that happens to be drawn hollow. The
  // inner dot is a second part so the shape lives in the drawing rather than
  // in a stylesheet that would have to know what a merge is.
  if (graph.merge) {
    parts.push({
      kind: "node",
      lane: graph.node,
      cx: at(graph.node),
      cy: mid,
      r: nodeRadius * 0.42,
      shape: "normal",
    });
  }
  const drawn = Math.min(columns * laneWidth, maxGutterWidth);
  const width = Math.max(laneWidth, drawn);
  // Whether this row's own drawing reaches past the drawn width. The lanes
  // beyond it are still generated and still coloured; only the gutter gets
  // narrower, and the view fades the part that hangs off the edge.
  let widestColumn = graph.node;
  for (const lane of graph.lanes) if (lane > widestColumn) widestColumn = lane;
  for (const lane of graph.branches) if (lane > widestColumn) widestColumn = lane;
  for (const lane of graph.incoming) if (lane > widestColumn) widestColumn = lane;
  const clipped = at(widestColumn) >= width;
  return { width, height: rowHeight, clipped, parts };
}

// The window is as wide as the graph it draws, so a narrow window gives the
// text back the columns the lanes were using.
export function graphWidth(columns: number, laneWidth: number): number {
  return Math.max(columns, 1) * laneWidth;
}

// --- which refs contain a commit -----------------------------------

// The answer to "where does this commit appear": the ref names sitting on
// this commit or on any descendant of it that is loaded. A commit cannot be
// reached from a ref that has not been loaded yet, so the list is honest
// about its edge by being offered only while the page is on screen.
export interface RefSummary {
  names: string[];
  truncated: boolean;
}

// The loaded history wired backwards: which loaded commits name this one as
// a parent. Walking it from a commit visits exactly that commit's loaded
// descendants, so the ref tips that contain it — including itself — are all
// the walk ever needs to find.
export interface RefMap {
  byOid: Map<string, CommitView>;
  children: Map<string, CommitView[]>;
}

export function buildRefMap(commits: readonly CommitView[]): RefMap {
  const byOid = new Map<string, CommitView>();
  const children = new Map<string, CommitView[]>();
  for (const commit of commits) {
    byOid.set(commit.oid, commit);
  }
  for (const commit of commits) {
    for (const parent of commit.parents) {
      const list = children.get(parent);
      if (list === undefined) children.set(parent, [commit]);
      else list.push(commit);
    }
  }
  return { byOid, children };
}

/// The names found on the commit and its loaded descendants, nearest tips
/// first, deduplicated. `limit` caps the list rather than the search, so
/// `truncated` says there were more names, not that there might have been.
export function refsIncluding(map: RefMap, oid: string, limit = 10): RefSummary {
  const names: string[] = [];
  const seen = new Set<string>();
  const start = map.byOid.get(oid);
  if (start === undefined) return { names, truncated: false };
  const queue = [start];
  const walked = new Set<string>([oid]);
  for (let head = 0; head < queue.length; head++) {
    const commit = queue[head];
    for (const name of [...commit.labels.branches, ...commit.labels.tags, ...commit.labels.remotes]) {
      if (!seen.has(name)) {
        seen.add(name);
        names.push(name);
      }
    }
    for (const child of map.children.get(commit.oid) ?? []) {
      if (!walked.has(child.oid)) {
        walked.add(child.oid);
        queue.push(child);
      }
    }
  }
  return { names: names.slice(0, limit), truncated: names.length > limit };
}

// --- finding a commit in what is loaded ---

// What the find box matches against, and how. A plain string is matched as a
// substring, case-insensitively; a `/.../ ` turns on a real regular
// expression, because "find the commit that mentions ^Fix" is a thing people
// actually want and a substring search cannot answer it.
export interface FindQuery {
  text: string;
  regex: boolean;
  caseSensitive: boolean;
}

/// Whether one commit matches. The subject, the author, the object id and
/// the names of the refs sitting on it are all searched, because a reader
/// typing a branch name wants the commits that name points at, and a reader
/// pasting an id from a bug report wants that commit.
export function commitMatches(commit: CommitView, query: FindQuery): boolean {
  if (query.text === "") return true;
  const needle = query.caseSensitive ? query.text : query.text.toLowerCase();
  const haystacks = [
    commit.subject,
    commit.authorName,
    commit.oid,
    ...commit.labels.branches,
    ...commit.labels.tags,
    ...commit.labels.remotes,
  ];
  if (query.regex) {
    let pattern: RegExp;
    try {
      pattern = new RegExp(query.text, query.caseSensitive ? "" : "i");
    } catch {
      // An expression that does not compile matches nothing rather than
      // throwing at the reader mid-keystroke; the box reports it separately.
      return false;
    }
    return haystacks.some((field) => pattern.test(field));
  }
  return haystacks.some((field) =>
    (query.caseSensitive ? field : field.toLowerCase()).includes(needle),
  );
}

/// The commits a query keeps, in the order they were loaded. Filtering never
/// reorders: the graph only makes sense top to bottom.
export function filterCommits(commits: readonly CommitView[], query: FindQuery): CommitView[] {
  return commits.filter((commit) => commitMatches(commit, query));
}

/// Whether a query is one the reader could have got wrong — a regular
/// expression that does not compile — so the box can say so instead of
/// silently matching nothing.
export function findError(query: FindQuery): string | null {
  if (!query.regex || query.text === "") return null;
  try {
    new RegExp(query.text);
  } catch {
    return "Not a valid regular expression.";
  }
  return null;
}

/// Where the reader is among the matches: the index of the current one, and
/// how many there are. `current` is -1 when nothing matches yet.
export function matchPosition(commits: readonly CommitView[], query: FindQuery, currentOid: string | null): { index: number; total: number } {
  const matches = filterCommits(commits, query);
  const index = currentOid === null ? -1 : matches.findIndex((commit) => commit.oid === currentOid);
  return { index, total: matches.length };
}

/// The next match's object id, wrapping at both ends, or null when there are
/// none. Stepping past the end comes back to the first, so holding the key
/// cycles rather than sticking.
export function stepMatch(
  commits: readonly CommitView[],
  query: FindQuery,
  currentOid: string | null,
  delta: 1 | -1,
): string | null {
  const matches = filterCommits(commits, query);
  if (matches.length === 0) return null;
  const at = currentOid === null ? -1 : matches.findIndex((commit) => commit.oid === currentOid);
  const next = (at + delta + matches.length) % matches.length;
  return matches[at === -1 ? (delta === 1 ? 0 : matches.length - 1) : next].oid;
}
