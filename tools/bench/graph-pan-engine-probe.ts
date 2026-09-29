// Engine probe for the graph's horizontal reach: what the gutter draws, and
// what moves it, asked of the renderer the panel displays through.
//
// The fixture suite decides the pan's rules on the model — `graphPan` clamps,
// `rowGeometry` shifts one origin into every row. That is where the arithmetic
// belongs and not where two mechanisms get assumed: whether the panel's own
// wheel and arrow-key handlers really move the drawn columns by a lane, whether
// the gutter keeps one width under a pan so the subject text cannot slide, and
// whether the line above the list names the columns the document is showing.
// Those are facts about a constructed view in a laid-out page.
//
// This file is run by webkit-engine-probe.py, which bundles it against the
// panel's own source and serves the shipped stylesheet beside it.
// `probe-tauri-stub.ts` is the first import because a view module reaches for
// the host as soon as it is loaded; this probe then replaces the stub's
// `invoke` with a table that answers the two reads the graph is built from,
// each echoing the context it was asked with — an answer that fails the panel's
// own session check is dropped, and a probe whose payload is always dropped
// measures an empty list and calls it a pass.
//
// Two stages are built side by side, because a page has to be *loaded* to be
// measured and a load answers in a microtask: one session whose history opens
// twelve columns, past the gutter's ceiling, and a second whose six fit inside
// it. They are two sessions rather than one page swapped over, so both reads are
// asked at load time and answered from the context they were asked with.

import "./probe-tauri-stub";
import { graphGutterMaxPx, graphLanePx } from "../../app/src/historyModel";
import { currentFontPx } from "../../app/src/font";
import { applySnapshot } from "../../app/src/state";
import { createHistoryView } from "../../app/src/views/history";
import type { CommitView, GraphRow, ReadContext, SnapshotView } from "../../app/src/types";
import type { PreviewController } from "../../app/src/dialogs/preview";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const checks: Check[] = [];

function check(name: string, ok: boolean, detail: unknown): void {
  checks.push({ name, ok, detail: typeof detail === "string" ? detail : JSON.stringify(detail) });
}

declare global {
  interface Window {
    __probe?: () => string;
  }
}

// --- the fixtures ---------------------------------------------------------
// One page of history with eleven side branches open at once: the top row fans
// them out of a merge, four rows carry them, the rest of the page runs the
// mainline alone. Twelve columns is wider than the gutter's eight-lane ceiling
// and inside the twenty-four the backend still draws, which is exactly the case
// the pan exists for. The second page keeps six columns, which fits, and is what
// says the pan is not offered for nothing.
const wideColumns = 12;
const narrowColumns = 6;
const wideSession = 1;
const narrowSession = 2;

const oid = (n: number): string => String(n).padStart(40, "0");

const row = (extra: Partial<GraphRow>): GraphRow => ({
  node: 0,
  entry: true,
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

const commit = (n: number, graph: GraphRow): CommitView => ({
  oid: oid(n),
  parents: n === 0 ? [] : [oid(n - 1)],
  subject: `commit subject number ${n}`,
  message: `commit subject number ${n}\n`,
  authorName: "dev",
  authorEmail: "dev@example.com",
  authorDate: "2026-09-01T10:00:00+08:00",
  committerName: "dev",
  commitDate: "2026-09-01T10:00:00+08:00",
  graph,
});

// Every row's own dot sits in column 0; columns 1..(n-1) are opened by the merge
// at the top, run straight down the rows beneath it, and close.
const page = (columns: number): CommitView[] => {
  const side = Array.from({ length: columns - 1 }, (_, index) => index + 1);
  const rows: CommitView[] = [commit(0, row({ entry: false, merge: true, branches: side }))];
  for (let index = 1; index <= 4; index++) rows.push(commit(index, row({ lanes: side })));
  for (let index = 5; index < 9; index++) rows.push(commit(index, row()));
  rows.push(commit(9, row({ exit: false, root: true })));
  return rows;
};

const snapshot = (version: number, sessionId: number): SnapshotView => ({
  version,
  sessionId,
  historyGeneration: 0,
  refsGeneration: 0,
  repo: {
    openPath: "/home/dev/project",
    root: "/home/dev/project",
    gitDir: "/home/dev/project/.git",
    bare: false,
    linkedWorktree: false,
  },
  branch: {
    name: "main",
    headState: "branch",
    oid: oid(0),
    upstream: null,
    ahead: null,
    behind: null,
  },
  files: [],
  operation: null,
});

// The two reads the graph is built from, answered as the backend answers them:
// wrapped in the context they were asked with, and carrying a fresh value each
// time. Anything else the view asks for is the "the host did not say" a panel
// already has a path for.
const internals = (
  window as unknown as {
    __TAURI_INTERNALS__?: { invoke(cmd: string, args: unknown): Promise<unknown> };
  }
).__TAURI_INTERNALS__;
if (internals === undefined) throw new Error("the host stub did not install");
internals.invoke = (cmd: string, args: unknown): Promise<unknown> => {
  const asked = (args ?? {}) as { context?: ReadContext };
  const context = asked.context ?? null;
  const session = context === null ? 0 : context.sessionId;
  if (cmd === "history_page") {
    return Promise.resolve({
      context,
      value: {
        start: 0,
        commits: page(session === narrowSession ? narrowColumns : wideColumns).slice(),
        hasMore: false,
      },
    });
  }
  if (cmd === "list_refs") {
    return Promise.resolve({ context, value: { branches: [], remotes: [], tags: [] } });
  }
  return Promise.resolve(null);
};

const preview = {
  renew: () => undefined,
  open: () => undefined,
  close: () => undefined,
} as unknown as PreviewController;

// Where one row's drawing reaches, in the gutter's own pixels: the farthest
// vertical it draws, whether the row still says more follows, and the width the
// gutter gave it. A row whose lanes have all landed inside the box reports a
// line no wider than the box and no fade, which is the whole claim of a pan.
interface Reach {
  x: number;
  faded: boolean;
  width: number;
}

interface Stage {
  element: HTMLElement;
  rows: () => number;
  sentence: () => string;
  widths: () => Set<string>;
  subjectLeft: () => number;
  reach: (rowIndex: number) => Reach;
  press: (key: string) => boolean;
  wheel: (init: WheelEventInit) => { consumed: boolean; before: number; after: number };
}

const stage = (columns: number, sessionId: number, version: number): Stage => {
  const view = createHistoryView({
    preview,
    onBranchFromCommit: () => undefined,
    onTagFromCommit: () => undefined,
    onError: (error: unknown) => check("the view reported no error", false, String(error)),
  });
  document.body.append(view.element);
  applySnapshot(snapshot(version, sessionId));
  // The load goes through the view's own entry point: a snapshot arrives,
  // `sync()` reads the graph domain's context and asks for page zero.
  view.sync();
  const list = (): HTMLElement | null => view.element.querySelector<HTMLElement>(".history-list");
  const reach = (rowIndex: number): Reach => {
    const svg = view.element
      .querySelector<HTMLElement>(`#commit-row-${rowIndex}`)
      ?.querySelector<SVGSVGElement>(".graph-gutter");
    if (svg === null || svg === undefined) return { x: -1, faded: false, width: -1 };
    let x = -1;
    for (const line of svg.querySelectorAll<SVGLineElement>("line.graph-line")) {
      const at = Number(line.getAttribute("x1") ?? -1);
      if (at > x) x = at;
    }
    return { x, faded: svg.hasAttribute("data-fade"), width: Number(svg.getAttribute("width")) };
  };
  const send = (event: Event): boolean => {
    const host = list();
    return host !== null && host.dispatchEvent(event) === false;
  };
  return {
    element: view.element,
    rows: () => view.element.querySelectorAll(".commit-row").length,
    sentence: () => view.element.querySelector<HTMLElement>(".history-count")?.textContent ?? "",
    widths: () =>
      new Set(
        [...view.element.querySelectorAll<SVGSVGElement>(".graph-gutter")].map((svg) =>
          svg.getAttribute("width"),
        ),
      ),
    subjectLeft: () =>
      view.element.querySelector<HTMLElement>(".commit-subject")?.getBoundingClientRect().left ?? -1,
    reach,
    press: (key: string): boolean => send(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })),
    wheel: (init: WheelEventInit) => {
      const before = reach(1).x;
      const consumed = send(
        new WheelEvent("wheel", { ...init, bubbles: true, cancelable: true }),
      );
      return { consumed, before, after: reach(1).x };
    },
  };
};

const wide = stage(wideColumns, wideSession, 1);
const narrow = stage(narrowColumns, narrowSession, 2);

window.__probe = (): string => {
  const fontPx = currentFontPx();
  const lane = graphLanePx(fontPx);
  const cap = graphGutterMaxPx(fontPx);
  const shown = Math.floor(cap / lane);
  const name = (at: number): string =>
    `The graph shows columns ${at + 1}–${at + shown} of ${wideColumns}`;
  // Where the gestures have taken the gutter, counted here so every step is
  // predicted from where the row started. A view that moves two lanes and names
  // one would otherwise agree with itself by the third gesture.
  const endOrigin = wideColumns - shown;
  let origin = 0;
  const step = (by: number): void => {
    origin = Math.min(Math.max(origin + by, 0), endOrigin);
  };
  const same = (a: number, b: number): boolean => Math.abs(a - b) < 0.5;

  check("both histories are on the page", wide.rows() > 0 && narrow.rows() > 0, {
    wide: wide.rows(),
    narrow: narrow.rows(),
  });
  check(
    "the ceiling really is narrower than the wide history, and not than the narrow one",
    shown < wideColumns && narrowColumns <= shown,
    { lane, cap, shown, wideColumns, narrowColumns },
  );

  // One width, every row: the gutter is not sized to what is visible, or the
  // subject text would slide as a wider part of the graph scrolled in.
  check(
    "every row of the wide history is given the ceiling, and no row a different width",
    wide.widths().size === 1 && wide.widths().has(String(cap)),
    [...wide.widths()],
  );
  const rest = wide.reach(1);
  check(
    "a column past the edge is still drawn, and the row says more follows",
    rest.x > cap && rest.faded && rest.width === cap,
    rest,
  );
  check("the line above the list names the columns on screen", wide.sentence().includes(name(0)), wide.sentence());

  const textBefore = wide.subjectLeft();

  // Three gestures reach the columns off the edge — a sideways swipe, a wheel
  // turned down under Shift, the arrow keys — and each owes the same two
  // answers: the drawing moved one lane, and the sentence named the columns that
  // moved with it. An ordinary wheel down owes neither to the graph.
  const gesture = (label: string, consumed: boolean, after: number): void => {
    step(1);
    check(
      `${label} moves the graph one lane, names the new ones and takes the event`,
      consumed && same(after, rest.x - lane * origin) && wide.sentence().includes(name(origin)),
      { consumed, expected: rest.x - lane * origin, after, sentence: wide.sentence() },
    );
  };

  const swipe = wide.wheel({ deltaX: 120 });
  gesture("a sideways wheel", swipe.consumed, swipe.after);
  const shifted = wide.wheel({ deltaY: 120, shiftKey: true });
  gesture("Shift over a wheel down", shifted.consumed, shifted.after);
  const plain = wide.wheel({ deltaY: 120 });
  check(
    "a wheel down on its own neither moves a column nor is taken from the list",
    plain.consumed === false && same(plain.before, plain.after),
    plain,
  );
  const right = wide.press("ArrowRight");
  gesture("the right arrow", right, wide.reach(1).x);
  const left = wide.press("ArrowLeft");
  step(-1);
  check(
    "the left arrow gives a column back",
    left && same(wide.reach(1).x, rest.x - lane * origin) && wide.sentence().includes(name(origin)),
    { consumed: left, expected: rest.x - lane * origin, after: wide.reach(1).x, sentence: wide.sentence() },
  );

  // The end of the run. Past the last column there is nothing left to see, so
  // the gutter stops with the history's own edge instead of drawing empty width
  // that would read as a lane ending — and a row now inside the box stops
  // claiming with its fade that more follows.
  const consumedPast = Array.from({ length: endOrigin + 3 }, () => wide.press("ArrowRight"));
  consumedPast.forEach(() => step(1));
  const atEnd = wide.reach(1);
  check(
    "the run ends with the history's own edge, and nothing moves past it",
    origin === endOrigin &&
      consumedPast.every(Boolean) &&
      wide.sentence().includes(name(endOrigin)) &&
      same(atEnd.x, rest.x - lane * endOrigin) &&
      atEnd.x <= atEnd.width &&
      atEnd.faded === false,
    { origin, endOrigin, atEnd, sentence: wide.sentence() },
  );

  // The pan is the gutter's own business. The text column must not feel it.
  check(
    "the subject text does not move while the graph pans across twelve columns",
    same(wide.subjectLeft(), textBefore),
    { before: textBefore, after: wide.subjectLeft() },
  );

  // All the way back, where it began.
  for (let index = 0; index < endOrigin + 3; index++) {
    wide.press("ArrowLeft");
    step(-1);
  }
  check(
    "the other way reaches the first column and stops there",
    origin === 0 && wide.sentence().includes(name(0)) && same(wide.reach(1).x, rest.x),
    { origin, sentence: wide.sentence(), after: wide.reach(1).x, expected: rest.x },
  );

  // A history inside the box gets neither the sentence nor the gesture, and its
  // gutter is as wide as its own lanes and no wider.
  check(
    "a graph that fits offers no pan and takes no keys",
    narrow.sentence().includes("columns") === false && narrow.press("ArrowRight") === false,
    { sentence: narrow.sentence(), columns: narrowColumns, shown },
  );
  check(
    "its gutter is as wide as its own lanes and no wider",
    narrow.widths().size === 1 && narrow.widths().has(String(narrowColumns * lane)),
    { widths: [...narrow.widths()], expected: narrowColumns * lane, cap },
  );

  wide.element.remove();
  narrow.element.remove();
  return JSON.stringify({ engine: navigator.userAgent, checks });
};
