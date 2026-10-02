// Engine probe for the unified search: what one field draws over the page, and
// what the page underneath it does while the layer is up, asked of the renderer
// the panel displays through.
//
// The fixture suite already decides every judgement behind these numbers — which
// answer is still an answer, what the footer may claim, how many rows one window
// draws, where a highlight may cut. This file measures what no Node run can see:
// whether the layer is really drawn *over* the history rather than inserted into
// it, whether the rows below keep their boxes and their commits when a search
// opens, when it closes and when one of its rows is picked, whether a page read
// from a commit that is not the head says so on the line above the rows, and what
// drawing a full window costs in the engine that has to lay it out.
//
// The harness runs `__probe()` once, in one turn, 250 ms after the page loads.
// That shapes the whole file, and it is the thing a reader should know before
// trusting a check: nothing started inside `__probe()` can settle there, so every
// read whose *answer* is measured is triggered during module setup and given the
// harness's own window to arrive. What `__probe()` may then assert synchronously is
// what a view does on a keystroke, a click, a focus or a repaint, and the count of
// the commands those cost.
//
// Timers are queued rather than run, as the commit-bubble probe does, and each page
// holds its own queue: a check that says "nothing has been asked yet" is only worth
// taking if some other page's wait cannot be drained into it. The delay the field is
// holding is compared against `SEARCH_DEBOUNCE_MS` rather than a number typed here,
// because a budget measured from the keystroke is honest only if the wait inside it
// is the wait the panel actually takes.
//
// Reads are answered by a table that echoes the context it was asked with, the way
// the backend publishes, and every command is counted — so "the layer costs one read"
// and "a pick that is already on screen costs none" are numbers in the report.
//
// One limit belongs in the open: the offscreen window is 900x700, so a CSS *viewport*
// media query is answered for that, not for the frame a page is built in. This file
// therefore asserts that the layer respects the cap the page actually computed, and
// never which token a real 340x400 window would have selected. That half of the claim
// needs a browser and is recorded as open work.
//
// The same is true of this engine's clock: a single draw reads as a whole number of
// milliseconds, so the render figure worth recording is the one taken across a batch,
// and neither reading is the keystroke-to-candidate budget. That budget also contains
// the Git read behind the answer, which a stub cannot supply; what is measured here is
// only the half the renderer owns.

import "./probe-tauri-stub";
import {
  DRAWN_COMMITS,
  SEARCH_DEBOUNCE_MS,
  type CommitHit,
  type RefHit,
  type SearchPage,
} from "../../app/src/searchModel";
import { applySnapshot } from "../../app/src/state";
import { createChangesView } from "../../app/src/views/changes";
import { createHistoryView } from "../../app/src/views/history";
import { createMainPanel } from "../../app/src/views/mainPanel";
import { createSearchView } from "../../app/src/views/search";
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

// --- the clocks -----------------------------------------------------------
// One queue per page. Installing a page's queue is what makes `window.setTimeout`
// mean "this page's next wait", so draining one page cannot answer another.

interface Pending {
  run: () => void;
  delay: number;
}

const makeClock = () => {
  const queue = new Map<number, Pending>();
  let next = 1;
  return {
    queue,
    install: () => {
      window.setTimeout = ((handler: () => void, delay?: number): number => {
        const id = next;
        next += 1;
        queue.set(id, { run: handler, delay: delay ?? 0 });
        return id;
      }) as unknown as typeof window.setTimeout;
      window.clearTimeout = ((id?: number): void => {
        if (id !== undefined) queue.delete(id);
      }) as unknown as typeof window.clearTimeout;
    },
    held: (): number[] => [...queue.values()].map((one) => one.delay),
    drain: (): void => {
      const due = [...queue.values()];
      queue.clear();
      for (const one of due) one.run();
    },
  };
};

// --- the history the graph draws ------------------------------------------
// Forty commits, newest first. The page read from an anchor carries a different
// set, so "the rows underneath did not change" is a comparison over the commits
// drawn rather than over a count alone.

const loadedRows = 40;

const oid = (n: number): string => `${n.toString(16)}${"0".repeat(40)}`.slice(0, 40);

const graphRow = (last: boolean): GraphRow => ({
  node: 0,
  entry: true,
  exit: !last,
  merge: false,
  root: last,
  lanes: [],
  branches: [],
  incoming: [],
  dangling: false,
  folded: false,
});

const commitView = (index: number, base: number): CommitView => ({
  oid: oid(base + index),
  parents: base + index === 0 ? [] : [oid(base + index + 1)],
  subject: `subject of commit ${base + index}`,
  message: `subject of commit ${base + index}\n\nthe body no row draws.\n`,
  authorName: "dev",
  authorEmail: "dev@example.com",
  authorDate: "2026-09-01T10:11:12+08:00",
  committerName: "dev",
  commitDate: "2026-09-01T10:11:12+08:00",
  graph: graphRow(index === loadedRows - 1),
});

const headPage: CommitView[] = Array.from({ length: loadedRows }, (_, index) => commitView(index, 0));
const anchorPage: CommitView[] = Array.from(
  { length: loadedRows },
  (_, index) => commitView(index, 517),
);

// --- the answer the field draws -------------------------------------------
// One hundred commit hits, so the layer is drawn at the limit the model sets and
// the footer has a real number of rows left out to talk about. The first hit is a
// commit the graph already has and the rest are not, which is what makes the two
// routes out of a pick two separate measurements instead of one claim.

const QUERY = "lane";
const subjectOf = (n: number): string => `${QUERY} ${n} reworks the graph lane`;
const messageOf = (n: number): string => `${subjectOf(n)}\n\nand the body mentions ${QUERY} again.\n`;

const commitHit = (n: number, id: string): CommitHit => ({
  oid: id,
  message: messageOf(n),
  subjectEndBytes: subjectOf(n).length,
  subjectEndUnits: subjectOf(n).length,
  authorName: "dev",
  commitDate: "2026-09-01T10:11:12+08:00",
  offset: n,
  hits: [
    {
      field: "subject",
      tier: "contiguous",
      fragments: [{ byteStart: 0, byteEnd: QUERY.length, unitStart: 0, unitEnd: QUERY.length }],
    },
    {
      field: "body",
      tier: "contiguous",
      fragments: [
        {
          byteStart: messageOf(n).indexOf(QUERY, subjectOf(n).length),
          byteEnd: messageOf(n).indexOf(QUERY, subjectOf(n).length) + QUERY.length,
          unitStart: messageOf(n).indexOf(QUERY, subjectOf(n).length),
          unitEnd: messageOf(n).indexOf(QUERY, subjectOf(n).length) + QUERY.length,
        },
      ],
    },
  ],
});

const refHit = (name: string, over: Partial<RefHit>): RefHit => ({
  kind: "branch",
  name,
  commitOid: oid(0),
  head: false,
  reachedFromHead: true,
  tier: "prefix",
  fragments: [{ byteStart: 0, byteEnd: QUERY.length, unitStart: 0, unitEnd: QUERY.length }],
  ...over,
});

const searchCommits: CommitHit[] = [
  commitHit(0, oid(3)),
  ...Array.from({ length: 99 }, (_, index) => commitHit(index + 1, oid(200 + index))),
];

const searchRefs: RefHit[] = [
  refHit(`${QUERY}-main`, { head: true }),
  refHit(`${QUERY}-object`, { kind: "tag", commitOid: null }),
  refHit(`origin/${QUERY}-old`, { kind: "remote", reachedFromHead: false }),
];

// --- the snapshot ----------------------------------------------------------

const snapshot = (version: number, sessionId: number): SnapshotView => ({
  version,
  sessionId,
  historyGeneration: 0,
  refsGeneration: 0,
  repo: {
    displayName: "project",
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

const preview = {
  renew: () => undefined,
  open: () => undefined,
  close: () => undefined,
} as unknown as PreviewController;

// --- the host, and what it is asked for ------------------------------------

const asks = new Map<string, number>();
const lastSearchArgs: Record<string, unknown>[] = [];
const lastPageArgs: Record<string, unknown>[] = [];

const ask = (cmd: string): number => asks.get(cmd) ?? 0;

const internals = (
  window as unknown as {
    __TAURI_INTERNALS__?: { invoke(cmd: string, args: unknown): Promise<unknown> };
  }
).__TAURI_INTERNALS__;
if (internals === undefined) throw new Error("the host stub did not install");

internals.invoke = (cmd: string, raw: unknown): Promise<unknown> => {
  const args = (raw ?? {}) as Record<string, unknown>;
  asks.set(cmd, (asks.get(cmd) ?? 0) + 1);
  const context = (args.context ?? null) as ReadContext | null;
  if (cmd === "history_page") {
    lastPageArgs.push(args);
    const commits = typeof args.oid === "string" ? anchorPage : headPage;
    return Promise.resolve({ context, value: { start: 0, commits: commits.slice(), hasMore: false } });
  }
  if (cmd === "list_refs") {
    return Promise.resolve({
      context,
      value: { branches: [], remotes: [], tags: [] },
    });
  }
  if (cmd === "commit_files") {
    return Promise.resolve({ context, value: [] });
  }
  if (cmd === "search_repository") {
    lastSearchArgs.push(args);
    const page: SearchPage = {
      queryId: Number(args.queryId ?? 1),
      head: oid(0),
      refsGeneration: 0,
      window: {
        cursor: Number(args.cursor ?? 0),
        scanned: 1000,
        complete: false,
        stoppedBy: null,
        nextCursor: 1000,
        hitsTruncated: true,
        commits: searchCommits.slice(),
        refs: searchRefs.slice(),
      },
    };
    return Promise.resolve({ context, value: page });
  }
  return Promise.resolve(null);
};

// --- a page -----------------------------------------------------------------
// The real panel, in a frame the size the window can be. The layer is positioned
// absolutely against `.search-view`, so it needs the containing block the page gives
// it, and the claim that it covers the history rather than pushing it needs the
// history, the changes area and the splitter that sizes them, all of which are here.

interface Boxes {
  layer: DOMRect;
  graph: DOMRect;
  changes: DOMRect;
  panel: DOMRect;
  field: DOMRect;
}

interface Page {
  clock: ReturnType<typeof makeClock>;
  element: HTMLElement;
  frame: HTMLElement;
  type(text: string): void;
  compose(text: string): void;
  press(key: string): void;
  focusField(): void;
  clickOutside(): void;
  render(): void;
  rows(): { all: number; commits: number; refs: number };
  marks(): number;
  summary(): string;
  hint(): string;
  expanded(): string;
  activeRow(): string;
  drawnOids(): string[];
  visible(): boolean;
  layerMaxHeight(): number;
  boxes(): Boxes;
  searchRow(index: number): HTMLButtonElement | null;
  pick(index: number): void;
  anchorNotice(): { text: string; hidden: boolean };
  anchorClear(): HTMLElement | null;
  revealFromAnchor(oidValue: string): void;
}

let version = 0;

const build = (width: number, height: number, sessionId: number): Page => {
  version += 1;
  const clock = makeClock();
  clock.install();
  const frame = document.createElement("div");
  frame.style.cssText = `position:absolute;left:0;top:0;width:${width}px;height:${height}px;overflow:hidden;`;

  let self = null as unknown as Page;
  const search = createSearchView({
    onError: (error: unknown) => check("the search view reported no error", false, String(error)),
    // The composition the app itself installs: the field names a commit, the graph
    // decides how to put it on screen.
    revealCommit: (oidValue: string) => self.revealFromAnchor(oidValue),
  });
  const changes = createChangesView({
    preview,
    onError: (error: unknown) => check("the changes view reported no error", false, String(error)),
  });
  const history = createHistoryView({
    preview,
    onBranchFromCommit: () => undefined,
    onTagFromCommit: () => undefined,
    onError: (error: unknown) => check("the history view reported no error", false, String(error)),
  });
  const panel = createMainPanel(search.element, changes.element, history.element);
  frame.append(panel.element);
  document.body.append(frame);
  applySnapshot(snapshot(version, sessionId));
  changes.render();
  history.sync();
  search.sync();

  const pick = <T extends Element>(selector: string): T | null =>
    panel.element.querySelector<T>(selector);
  const field = () => pick<HTMLInputElement>(".search-field") as HTMLInputElement;
  const layer = () => pick<HTMLElement>(".search-results") as HTMLElement;

  self = {
    clock,
    element: panel.element,
    frame,
    // Installing this page's queue is what makes `window.setTimeout` mean *this*
    // page's next wait, so five pages built one after another still answer for the
    // keystroke each of them was given.
    type: (text: string) => {
      clock.install();
      field().value = text;
      field().dispatchEvent(new Event("input"));
    },
    compose: (text: string) => {
      clock.install();
      field().value = text;
      field().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      field().dispatchEvent(new Event("input"));
    },
    press: (key: string) => {
      clock.install();
      field().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    },
    focusField: () => {
      clock.install();
      field().dispatchEvent(new Event("focus"));
    },
    clickOutside: () => {
      clock.install();
      document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    },
    render: () => {
      search.render();
      // The cost being measured is the cost of a page the reader looks at, so the
      // layout is forced inside the timing rather than left for a later frame.
      layer().getBoundingClientRect();
    },
    rows: () => ({
      all: panel.element.querySelectorAll(".search-row").length,
      commits: panel.element.querySelectorAll(".search-row:not(.search-ref)").length,
      refs: panel.element.querySelectorAll(".search-ref").length,
    }),
    marks: () => panel.element.querySelectorAll(".search-mark").length,
    summary: () => pick<HTMLElement>(".search-summary")?.textContent ?? "",
    hint: () => pick<HTMLElement>(".search-hint")?.textContent ?? "",
    expanded: () => field().getAttribute("aria-expanded") ?? "",
    activeRow: () => field().getAttribute("aria-activedescendant") ?? "",
    // The graph's own rows, named where they live: `.commit-row` is also the class
    // of the commit box's row in the changes area, and only the list pane carries
    // the commits this page is about.
    drawnOids: () =>
      Array.from(panel.element.querySelectorAll<HTMLElement>(".history-list .commit-row")).map(
        (row) => row.querySelector<HTMLElement>(".commit-short")?.textContent ?? "",
      ),
    visible: () => !layer().hidden,
    layerMaxHeight: () => Number.parseFloat(getComputedStyle(layer()).maxHeight) || 0,
    boxes: () => ({
      layer: layer().getBoundingClientRect(),
      graph: pick<HTMLElement>(".history-list")!.getBoundingClientRect(),
      changes: pick<HTMLElement>(".changes-view")!.getBoundingClientRect(),
      panel: panel.element.getBoundingClientRect(),
      field: field().getBoundingClientRect(),
    }),
    searchRow: (index: number) => pick<HTMLButtonElement>(`#search-row-${index}`),
    pick: (index: number) => {
      pick<HTMLElement>(`#search-row-${index}`)?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    },
    anchorNotice: () => {
      const notice = pick<HTMLElement>(".history-anchored");
      return { text: notice?.textContent ?? "", hidden: notice?.hidden !== false };
    },
    anchorClear: () =>
      Array.from(panel.element.querySelectorAll<HTMLElement>("button")).find(
        (one) => one.textContent === "Branch head" && one.closest(".history-list-head") !== null,
      ) ?? null,
    revealFromAnchor: (oidValue: string) => {
      history.reveal(oidValue);
      search.render();
    },
  };
  return self;
};

const same = (a: DOMRect, b: DOMRect): boolean =>
  ["top", "left", "bottom", "right", "width", "height"].every(
    (key) =>
      Math.abs(((a as unknown as Record<string, number>)[key] ?? 0) -
        ((b as unknown as Record<string, number>)[key] ?? 0)) < 0.75,
  );

const sameList = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((one, index) => one === b[index]);

// --- the five pages ---------------------------------------------------------
// Built in one fixture, so a comparison between two of them is a comparison between
// two drawings of one page. Each keeps its own clock: the page that is meant to have
// asked nothing cannot be answered by another page draining its wait.
const settled = build(900, 700, 1);
const waiting = build(900, 700, 2);
const writing = build(900, 700, 3);
const narrow = build(340, 400, 4);
const deep = build(900, 700, 5);

settled.type(QUERY);
settled.clock.drain();
writing.compose(`${QUERY}在`);
writing.clock.drain();
narrow.type(QUERY);
narrow.clock.drain();
deep.type(QUERY);
deep.clock.drain();
// The anchored route, taken the way a pick takes it. It lands while the first page
// is still on its way, which is the case the graph's own re-read in `loadPage` is
// written for; the settled state measured below is the one after that second read.
deep.revealFromAnchor(oid(517));
deep.revealFromAnchor(oid(517));
// `waiting` is typed into last and left with its wait unrun on purpose: it is the
// page that answers "what has the field asked before the model's wait has elapsed",
// and the queue holding that wait has to be its own.
waiting.type(QUERY);

const ANCHOR_SHORT = oid(517).slice(0, 7);

// --- the claims -------------------------------------------------------------

window.__probe = (): string => {
  // --- the wait, and the composition inside it ---
  check(
    "a keystroke holds the model's own wait and asks nothing yet",
    waiting.clock.held().length === 1 &&
      waiting.clock.held()[0] === SEARCH_DEBOUNCE_MS &&
      ask("search_repository") === 3,
    { held: waiting.clock.held(), asks: ask("search_repository"), constant: SEARCH_DEBOUNCE_MS },
  );
  check(
    "and nothing is drawn under the field while the answer is on its way",
    !waiting.visible() && waiting.expanded() === "false" && waiting.hint() === "",
    { visible: waiting.visible(), expanded: waiting.expanded(), hint: waiting.hint() },
  );
  check(
    "a string in the middle of an input method is not a question, even once its wait elapses",
    !writing.visible() && ask("search_repository") === 3,
    { held: writing.clock.held(), asks: ask("search_repository") },
  );

  // --- where the layer is, and what it did to the page under it ---
  const up = settled.boxes();
  // `waiting` is the same page with the layer never opened: its wait was deliberately
  // left unrun, so nothing it draws is an answer to a search.
  const flat = waiting.boxes();
  check(
    "the field is the first thing on the page, above both areas it searches",
    up.field.top <= up.changes.top + 0.75 && up.changes.top < up.graph.top,
    { field: up.field.top, changes: up.changes.top, graph: up.graph.top },
  );
  check(
    "the rows underneath are still the commits the graph loaded, in its own order",
    settled.drawnOids().length > 0 && sameList(settled.drawnOids(), waiting.drawnOids()),
    { drawn: settled.drawnOids().length, as: sameList(settled.drawnOids(), waiting.drawnOids()) },
  );
  check(
    "opening the layer moves neither area it covers",
    same(up.graph, flat.graph) && same(up.changes, flat.changes),
    {
      graph: [flat.graph.top, up.graph.top],
      changes: [flat.changes.top, up.changes.top],
    },
  );
  check(
    "and it is drawn over them, inside the panel it was given",
    up.layer.top >= up.field.bottom - 0.75 &&
      up.layer.bottom > up.changes.top &&
      up.layer.left >= up.panel.left - 0.75 &&
      up.layer.right <= up.panel.right + 0.75,
    { layer: [up.layer.top, up.layer.bottom], changes: [up.changes.top, up.changes.bottom] },
  );
  check(
    "the layer keeps the cap this page computed for it",
    up.layer.height <= settled.layerMaxHeight() + 0.75 && up.layer.height > 0,
    { height: up.layer.height, cap: settled.layerMaxHeight() },
  );

  // --- the narrow page, measured before anything closes a layer ---
  // An outside click is answered by every field on the document, so a claim that a
  // layer is drawn has to be taken before the claims about how one closes. This is
  // the panel at its minimum: 340x400, where the layer's cap is the short-window one.
  const tight = narrow.boxes();
  check(
    "at the panel's minimum width the layer still fits the frame it was drawn in",
    narrow.visible() &&
      tight.layer.left >= tight.panel.left - 0.75 &&
      tight.layer.right <= tight.panel.right + 0.75 &&
      tight.layer.bottom <= narrow.frame.getBoundingClientRect().bottom + 0.75,
    {
      layer: [tight.layer.top, tight.layer.bottom],
      panel: [tight.panel.left, tight.panel.right],
      frame: narrow.frame.getBoundingClientRect().bottom,
      cap: narrow.layerMaxHeight(),
      // The cap is a `vh` figure and the engine answers viewport units for its own
      // window, not for this frame, so the short-window restatement is not what is
      // measured here — the fit inside 340x400 is.
      window: [innerWidth, innerHeight],
      rows: narrow.rows(),
    },
  );

  // --- what one window says about itself ---
  const drawn = settled.rows();
  check(
    "one window draws the limit the model sets, and names the rows it left out",
    drawn.commits === DRAWN_COMMITS &&
      settled.summary().includes(`${99 + 1 - DRAWN_COMMITS} more not listed`) &&
      settled.summary().includes("more matched than this window returned"),
    { drawn, summary: settled.summary() },
  );
  check(
    "the names are drawn beside the commits, each as the kind it is",
    drawn.refs === searchRefs.length &&
      settled.summary().includes("3 names matched"),
    { refs: drawn.refs, summary: settled.summary() },
  );
  const inert = searchRefs
    .map((one, index) => ({ name: one.name, index: DRAWN_COMMITS + index }))
    .find((one) => one.name === `${QUERY}-object`);
  const inertRow = inert === undefined ? null : settled.searchRow(inert.index);
  check(
    "a name that names no commit is shown as that fact, and cannot be picked",
    inertRow !== null &&
      inertRow.disabled === true &&
      (inertRow.textContent ?? "").includes("names no commit"),
    { text: inertRow?.textContent ?? null, disabled: inertRow?.disabled ?? null },
  );
  const remote = searchRefs
    .map((one, index) => ({ name: one.name, index: DRAWN_COMMITS + index }))
    .find((one) => one.name === `origin/${QUERY}-old`);
  const remoteRow = remote === undefined ? null : settled.searchRow(remote.index);
  check(
    "a remote-tracking name says it is what Git last recorded, not what the remote holds",
    (remoteRow?.getAttribute("title") ?? "").startsWith("A remote-tracking ref"),
    remoteRow?.getAttribute("title") ?? null,
  );
  check(
    "the mark is drawn inside the row's own text, which does not move",
    settled.marks() > 0 &&
      (settled.searchRow(1)?.textContent ?? "").startsWith(`${QUERY} 1 reworks the graph lane`),
    { marks: settled.marks(), row: settled.searchRow(1)?.textContent ?? null },
  );

  // --- the reader closing it, and the repaint that must not reopen it ---
  settled.press("Escape");
  const afterEscape = settled.visible();
  settled.render();
  check(
    "Escape closes the layer, keeps the text, and a repaint does not bring the box back",
    !afterEscape && !settled.visible() && QUERY_LENGTH(settled),
    { afterEscape, visibleAgain: settled.visible() },
  );
  settled.focusField();
  check(
    "the field's own focus is the way back to what it already had",
    settled.visible() && settled.rows().all === drawn.all,
    { visible: settled.visible(), rows: settled.rows().all },
  );
  settled.press("ArrowDown");
  check(
    "an arrow moves to a row and names it, without redrawing the list",
    settled.activeRow() === "search-row-0" &&
      settled.searchRow(0)?.classList.contains("active") === true &&
      settled.rows().all === drawn.all,
    { active: settled.activeRow(), rows: settled.rows().all },
  );
  settled.clickOutside();
  check("a click outside closes it", !settled.visible(), settled.visible());
  settled.focusField();

  // --- picking, both ways ---
  const beforePick = {
    search: ask("search_repository"),
    page: ask("history_page"),
    oids: settled.drawnOids(),
  };
  settled.pick(0);
  const afterLoaded = settled.drawnOids();
  check(
    "a hit the page already has costs no read, flashes the row it landed on and changes no other row",
    ask("history_page") === beforePick.page &&
      settled.element.querySelector(".history-list .commit-row.flash") !== null &&
      sameList(afterLoaded, beforePick.oids) &&
      !settled.visible(),
    {
      pageAsks: ask("history_page") - beforePick.page,
      flashed: settled.element.querySelector(".history-list .commit-row.flash") !== null,
      rows: afterLoaded.length,
    },
  );
  const deepOid = oid(200);
  const beforeAnchor = ask("history_page");
  settled.focusField();
  settled.pick(1);
  const anchorAsk = lastPageArgs[lastPageArgs.length - 1] ?? {};
  check(
    "a hit it does not have is read as the page that starts at that commit",
    ask("history_page") === beforeAnchor + 1 &&
      anchorAsk.oid === deepOid &&
      anchorAsk.start === 0,
    {
      asked: anchorAsk.oid,
      start: anchorAsk.start,
      pageAsks: ask("history_page") - beforeAnchor,
    },
  );

  // --- the page read from an anchor, and the way back off it ---
  const notice = deep.anchorNotice();
  const clear = deep.anchorClear();
  check(
    "an anchored page says its rows are not the branch head, and shows the way back",
    !notice.hidden &&
      notice.text.includes(oid(517).slice(0, 10)) &&
      notice.text.includes("not the branch head.") &&
      clear !== null &&
      !clear.hidden,
    { text: notice.text, clear: clear?.textContent ?? null },
  );
  check(
    "and the rows it drew are that commit's ancestry, not the branch's recent history",
    deep.drawnOids()[0] === ANCHOR_SHORT &&
      !sameList(deep.drawnOids(), settled.drawnOids()),
    { first: deep.drawnOids()[0], head: settled.drawnOids()[0] },
  );
  const beforeClear = ask("history_page");
  const beforeClearRows = deep.drawnOids();
  clear?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  check(
    "one click on the way back asks for the branch's own page, once",
    ask("history_page") === beforeClear + 1 &&
      (lastPageArgs[lastPageArgs.length - 1] ?? {}).oid === null,
    {
      asked: (lastPageArgs[lastPageArgs.length - 1] ?? {}).oid,
      pageAsks: ask("history_page") - beforeClear,
    },
  );
  // The head line belongs to the rows it describes rather than to the click that
  // asked for new ones (the app draws the two together, in the read's own
  // completion), so an anchored page keeps its sentence while its rows are still
  // what is on screen. This channel cannot see the read arrive, and does not claim
  // to: what it measures is that the click retires no claim it still holds.
  check(
    "and the head line outlives the click, until the rows it described are gone",
    sameList(deep.drawnOids(), beforeClearRows) && !deep.anchorNotice().hidden,
    {
      rows: deep.drawnOids().length,
      notice: deep.anchorNotice().text,
    },
  );

  check(
    "every command the field reached was one of the reads a page is drawn from",
    [...asks.keys()].every((one) =>
      ["history_page", "list_refs", "commit_files", "search_repository"].includes(one),
    ),
    Object.fromEntries(asks),
  );

  // --- the cost of drawing one window, in the engine that lays it out ---
  // This channel's clock is coarse (every single-render figure lands on a whole
  // millisecond), so the number worth keeping is the one taken across a batch:
  // twenty draws measured as one interval. The per-draw spread is reported as what
  // it is, and neither is read as the keystroke-to-candidate budget — that one also
  // contains the Git read, which no stub can supply.
  const costs: number[] = [];
  const batchStart = performance.now();
  for (let index = 0; index < 20; index += 1) {
    const start = performance.now();
    settled.render();
    costs.push(performance.now() - start);
  }
  const batch = performance.now() - batchStart;
  costs.sort((a, b) => a - b);
  const p50 = costs[Math.floor(costs.length / 2)] ?? 0;
  const p95 = costs[Math.ceil(costs.length * 0.95) - 1] ?? 0;
  check(
    "drawing a full window is a fraction of the wait the field already spent on it",
    batch > 0 && batch / 20 < SEARCH_DEBOUNCE_MS,
    {
      batch: batch.toFixed(3),
      each: (batch / 20).toFixed(3),
      perDrawP50: p50.toFixed(3),
      perDrawP95: p95.toFixed(3),
      wait: SEARCH_DEBOUNCE_MS,
    },
  );

  return JSON.stringify({
    engine: navigator.userAgent,
    checks,
    asks: Object.fromEntries(asks),
    render: { batch, each: batch / 20 },
  });
};

// The visible length of the text still in the field. Written as a function rather
// than inline so the check above reads as the claim it is making.
const QUERY_LENGTH = (page: Page): boolean => {
  const input = page.element.querySelector<HTMLInputElement>(".search-field");
  return input !== null && input.value === QUERY;
};
