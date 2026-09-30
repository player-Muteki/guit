// Engine probe for the commit bubble: what a row answers when it is rested on
// or walked to, asked of the renderer the panel displays through.
//
// The fixture suite decides the placement arithmetic on the model — `placeBubble`
// caps, flips and clamps a box it is handed. That is where the numbers belong and
// not where the mechanism gets assumed. Whether the view really waits a quarter of
// a second before it draws anything, whether a key press opens the same box on the
// key with no wait and no Git process, whether the box lands flush against a row
// that is laid out by a real font engine, and whether it stays inside a pane that
// is 340 CSS px wide — those are facts about a constructed view in a laid-out page.
//
// This file is run by webkit-engine-probe.py, which bundles it against the panel's
// own source and serves the shipped stylesheet beside it. `probe-tauri-stub.ts` is
// the first import because a view module reaches for the host as soon as it is
// loaded; this probe then replaces the stub's `invoke` with a table that answers
// the reads the graph is built from and counts every command it is asked for, so
// the cost of walking a history is a number rather than a reading of the source.
//
// The timers are replaced too, and that is the one thing here a reader should
// distrust on purpose: a probe that waits real time is a probe that times out.
// `window.setTimeout` is queued rather than run, which lets the probe say "nothing
// is drawn while the only thing pending is a quarter-second timer" and then fire it
// and say what appeared. The delay is compared against the model's own constant, so
// a check that passes because someone typed 250 in two places is impossible.
//
// Two stages are built: one at the panel's own comfortable width and one at the
// 340 CSS px minimum window, because the claim that a box carrying a 40-character
// id stays inside its pane is only interesting at the narrow end.

import "./probe-tauri-stub";
import { BUBBLE_HOVER_MS, bubbleInsetPx } from "../../app/src/historyModel";
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

// --- the clock ------------------------------------------------------------

interface Pending {
  run: () => void;
  delay: number;
}

const pending = new Map<number, Pending>();
let nextTimer = 1;

window.setTimeout = ((handler: () => void, delay?: number): number => {
  const id = nextTimer;
  nextTimer += 1;
  pending.set(id, { run: handler, delay: delay ?? 0 });
  return id;
}) as unknown as typeof window.setTimeout;

window.clearTimeout = ((id?: number): void => {
  if (id !== undefined) pending.delete(id);
}) as unknown as typeof window.clearTimeout;

/** Every timer the view is holding, oldest first — without running any. */
const held = (): number[] => [...pending.values()].map((one) => one.delay);

/** Run what is pending. Anything a callback schedules is left for the next call. */
const runPending = (): void => {
  const due = [...pending.values()];
  pending.clear();
  for (const one of due) one.run();
};

// --- the fixture ----------------------------------------------------------
// Forty plain mainline commits, deep enough that the pane has to scroll to
// follow a walk down it, and each carrying a body the row never draws. The
// bubble's whole reason to exist is that body, so the probe measures it
// reaching the screen rather than reaching the `CommitView`.
//
// The id puts its own number first, because a bubble that names a commit has to
// be told apart from the row it hangs off: the row shows seven characters and
// the bubble the whole forty, and an id padded with zeroes at the front would
// make those seven identical for every commit on the page.

const rows = 40;
const bodyLine = "the body no row draws";

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

const commit = (n: number): CommitView => ({
  oid: oid(n),
  parents: n === 0 ? [] : [oid(n - 1)],
  subject: `subject of commit ${n}`,
  message: `subject of commit ${n}\n\n${bodyLine} for commit ${n}.\n`,
  authorName: "dev",
  authorEmail: "dev@example.com",
  authorDate: "2026-09-01T10:11:12+08:00",
  committerName: "dev",
  commitDate: "2026-09-01T10:11:12+08:00",
  graph: graphRow(n === rows - 1),
});

const history: CommitView[] = Array.from({ length: rows }, (_, index) => commit(index));

const branch = (name: string, at: number): Record<string, unknown> => ({
  name,
  oid: oid(at),
  head: name === "main",
  upstream: null,
  ahead: null,
  behind: null,
  upstreamGone: false,
  addressable: true,
});

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

const preview = {
  renew: () => undefined,
  open: () => undefined,
  close: () => undefined,
} as unknown as PreviewController;

// --- the host, and what it is asked for -----------------------------------
// The reads the graph is built from are answered as the backend answers them —
// wrapped in the context they were asked with — and every command is counted, so
// "a hover costs nothing" is a number in the report rather than a promise.

const launches: Record<string, number> = {};

const internals = (
  window as unknown as {
    __TAURI_INTERNALS__?: { invoke(cmd: string, args: unknown): Promise<unknown> };
  }
).__TAURI_INTERNALS__;
if (internals === undefined) throw new Error("the host stub did not install");

const ask = (cmd: string): number => launches[cmd] ?? 0;

internals.invoke = (cmd: string, args: unknown): Promise<unknown> => {
  launches[cmd] = (launches[cmd] ?? 0) + 1;
  const asked = (args ?? {}) as { context?: ReadContext };
  const context = asked.context ?? null;
  if (cmd === "history_page") {
    return Promise.resolve({
      context,
      value: { start: 0, commits: history.slice(), hasMore: false },
    });
  }
  if (cmd === "list_refs") {
    return Promise.resolve({
      context,
      value: { branches: [branch("main", 9), branch("release-1.0", 3)], remotes: [], tags: [] },
    });
  }
  if (cmd === "commit_files") {
    return Promise.resolve({
      context,
      value: [{ status: "M", path: "src/some/file.c", oldPath: null }],
    });
  }
  return Promise.resolve(null);
};

// --- a stage --------------------------------------------------------------
// The view, in a box the size the panel can be. `position: absolute` on the
// bubble is only meaningful against a containing block, so the stage gives the
// view a real frame rather than letting it hang off the document body.

interface Boxes {
  bubble: DOMRect;
  row: DOMRect;
  pane: DOMRect;
  inset: number;
}

interface Stage {
  element: HTMLElement;
  remove(): void;
  list: HTMLElement;
  bubble: HTMLElement;
  rowCount: () => number;
  row: (index: number) => HTMLElement | null;
  /** The four lines, as the page shows them. */
  said: () => { message: string; author: string; oid: string; refs: string };
  side: () => string;
  hidden: () => boolean;
  press: (key: string) => void;
  enter: (index: number) => void;
  leave: (index: number) => void;
  click: (index: number) => void;
  scroll: () => void;
  boxes: (index: number) => Boxes | null;
}

const stage = (width: number, height: number, sessionId: number, version: number): Stage => {
  const frame = document.createElement("div");
  frame.style.cssText = `position:absolute;left:0;top:0;width:${width}px;height:${height}px;display:flex;flex-direction:column;`;
  const view = createHistoryView({
    preview,
    onBranchFromCommit: () => undefined,
    onTagFromCommit: () => undefined,
    onError: (error: unknown) => check("the view reported no error", false, String(error)),
  });
  frame.append(view.element);
  document.body.append(frame);
  applySnapshot(snapshot(version, sessionId));
  view.sync();

  const pick = <T extends Element>(selector: string): T | null =>
    view.element.querySelector<T>(selector);
  const list = (): HTMLElement => pick<HTMLElement>(".history-list") as HTMLElement;
  const bubble = (): HTMLElement => pick<HTMLElement>(".commit-bubble") as HTMLElement;
  const line = (selector: string): string => pick<HTMLElement>(selector)?.textContent ?? "";
  return {
    element: view.element,
    remove: () => frame.remove(),
    list: list(),
    bubble: bubble(),
    rowCount: () => view.element.querySelectorAll(".commit-row").length,
    row: (index: number) => pick<HTMLElement>(`#commit-row-${index}`),
    said: () => ({
      message: line(".bubble-message"),
      author: line(".bubble-line"),
      oid: line(".bubble-oid"),
      refs:
        [...view.element.querySelectorAll<HTMLElement>(".bubble-line")]
          .map((one) => one.textContent ?? "")
          .pop() ?? "",
    }),
    side: () => bubble().dataset.side ?? "",
    hidden: () => bubble().hidden,
    press: (key: string) => {
      list().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    },
    enter: (index: number) => {
      pick<HTMLElement>(`#commit-row-${index}`)?.dispatchEvent(new Event("pointerenter"));
    },
    leave: (index: number) => {
      pick<HTMLElement>(`#commit-row-${index}`)?.dispatchEvent(new Event("pointerleave"));
    },
    click: (index: number) => {
      pick<HTMLElement>(`#commit-row-${index}`)?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    },
    scroll: () => {
      list().dispatchEvent(new Event("scroll"));
    },
    boxes: (index: number) => {
      const row = pick<HTMLElement>(`#commit-row-${index}`);
      if (row === null) return null;
      return {
        bubble: bubble().getBoundingClientRect(),
        row: row.getBoundingClientRect(),
        pane: list().getBoundingClientRect(),
        inset: bubbleInsetPx(currentFontPx()),
      };
    },
  };
};

// --- the claims -----------------------------------------------------------

const wide = stage(720, 640, 1, 1);
const narrow = stage(340, 400, 2, 2);

// Half a pixel is the tolerance a laid-out page needs: the boxes are measured
// after a real font engine has rounded the text it was given, and a placement
// that is exact in the model can still land a fraction off the edge the browser
// drew.
const tolerance = 0.75;

/** Inside the pane it belongs to, by the inset the model was given. */
function insidePane(at: Boxes): boolean {
  const { bubble, pane, inset } = at;
  return (
    bubble.left >= pane.left + inset - tolerance &&
    bubble.right <= pane.right - inset + tolerance &&
    bubble.top >= pane.top + inset - tolerance &&
    bubble.bottom <= pane.bottom - inset + tolerance
  );
}

/** Flush: the two boxes share an edge, so the pointer crosses nothing. */
function flushWithRow(at: Boxes): boolean {
  const { bubble, row } = at;
  return Math.abs(bubble.top - row.bottom) < tolerance || Math.abs(bubble.bottom - row.top) < tolerance;
}

// The one fallback the contract allows: when neither side of the row can hold
// the box, it sits against the larger side and stays inside the pane, covering
// the row it came from. That is still an answer attached to its row; a box
// touching neither edge of the row and not covering it is a box pointing at
// nothing.
function coversRow(at: Boxes): boolean {
  return at.bubble.top < at.row.bottom && at.bubble.bottom > at.row.top;
}

/** The row the box hangs off is the commit the box names. */
function namesItsRow(at: Stage, index: number): boolean {
  const short = at.row(index)?.querySelector<HTMLElement>(".commit-short")?.textContent ?? "";
  return short !== "" && at.said().oid.startsWith(short) && at.said().oid.length === 40;
}

window.__probe = (): string => {
  // --- the wait ----------------------------------------------------------
  check("the row the pointer rests on is on the page", wide.row(3) !== null, {
    rows: wide.rowCount(),
  });
  wide.enter(3);
  check(
    "resting on a row draws nothing while its timer has not run",
    wide.hidden() && wide.rowCount() > 0,
    { hidden: wide.hidden(), pending: held() },
  );
  check(
    "what it waits for is the model's own hover delay",
    held().length === 1 && held()[0] === BUBBLE_HOVER_MS,
    { held: held(), constant: BUBBLE_HOVER_MS },
  );
  runPending();
  const hovered = wide.boxes(3);
  check(
    "and the answer appears once that delay has passed, flush against its row and inside the pane",
    !wide.hidden() && hovered !== null && insidePane(hovered) && flushWithRow(hovered),
    {
      side: wide.side(),
      hidden: wide.hidden(),
      inside: hovered === null ? null : insidePane(hovered),
      flush: hovered === null ? null : flushWithRow(hovered),
    },
  );
  const saidHover = wide.said();
  check(
    "it answers with the message no row shows, the whole id and one date",
    saidHover.message.includes(bodyLine) &&
      saidHover.oid === oid(3) &&
      saidHover.author.includes("2026-09-01T10:11:12+08:00"),
    saidHover,
  );
  check(
    "and it carries no file list and no control, so a hover costs nothing",
    !saidHover.message.includes("src/some/file") &&
      wide.bubble.querySelector("button") === null &&
      ask("commit_files") === 0,
    { message: saidHover.message.slice(0, 80), commitFiles: ask("commit_files") },
  );
  check(
    "the line the node's native tooltip used to carry is now the bubble's",
    saidHover.refs.includes("release-1.0") && saidHover.refs.startsWith("Included in:"),
    saidHover.refs,
  );
  check(
    "the bubble is not what a screen reader reads twice",
    wide.bubble.getAttribute("aria-hidden") === "true",
    wide.bubble.getAttribute("aria-hidden"),
  );

  // --- the native tooltips it replaced -----------------------------------
  const subject = wide.row(3)?.querySelector<HTMLElement>(".commit-subject");
  check(
    "no native tooltip is left on the row or the graph, so no fact is said twice",
    subject?.getAttribute("title") === null &&
      wide.element.querySelector(".graph-gutter title") === null &&
      // …except the one that answers a different question: what kind of name
      // this chip is.
      (wide.element.querySelector<HTMLElement>(".commit-ref")?.getAttribute("title") ?? "").startsWith(
        "Branch",
      ),
    {
      subjectTitle: subject?.getAttribute("title") ?? null,
      nodeTitle: wide.element.querySelector(".graph-gutter title") !== null,
      chipTitle: wide.element.querySelector<HTMLElement>(".commit-ref")?.getAttribute("title") ?? null,
    },
  );

  // --- leaving, and the two scrolls --------------------------------------
  wide.leave(3);
  runPending();
  check("leaving the row retires the answer", wide.hidden(), { hidden: wide.hidden(), pending: held() });

  wide.enter(3);
  runPending();
  wide.scroll();
  check(
    "a scroll the reader made closes it, because that row is no longer being read",
    wide.hidden(),
    { hidden: wide.hidden() },
  );
  pending.clear();

  // --- the keyboard walk -------------------------------------------------
  // The row the key is on when it is on the first one, then one row per press:
  // the bubble must be on the row the cursor reached, so every step is checked
  // at its own index rather than at the one the loop number happens to say.
  narrow.press("Home");
  const sides = new Set<string>();
  let outsideAt = -1;
  let detachedAt = -1;
  let wrongRowAt = -1;
  let missingAt = -1;
  let covering = 0;
  for (let index = 0; index < 20; index++) {
    if (index > 0) narrow.press("ArrowDown");
    const boxes = narrow.boxes(index);
    if (boxes === null) {
      if (missingAt < 0) missingAt = index;
      continue;
    }
    sides.add(narrow.side());
    if (!insidePane(boxes) && outsideAt < 0) outsideAt = index;
    if (!flushWithRow(boxes)) {
      if (!coversRow(boxes) && detachedAt < 0) detachedAt = index;
      else covering += 1;
    }
    if (!namesItsRow(narrow, index) && wrongRowAt < 0) wrongRowAt = index;
  }
  check(
    "every walked row was on the screen when the key reached it",
    missingAt < 0,
    { missingAt, rows: narrow.rowCount() },
  );
  check(
    "twenty rows walked by key asked for no file list and left the detail pane shut",
    ask("commit_files") === 0 && narrow.element.querySelector(".history-detail")?.hidden === true,
    { commitFiles: ask("commit_files") },
  );
  check(
    "a key press answers on the key, with nothing left waiting",
    !narrow.hidden() && held().length === 0,
    { hidden: narrow.hidden(), pending: held() },
  );
  check(
    "every box that appeared stayed inside the pane at 340 CSS px, on its own row",
    outsideAt < 0 && wrongRowAt < 0,
    { outsideAt, wrongRowAt, inset: bubbleInsetPx(currentFontPx()) },
  );
  check(
    "each one was flush with its row, or the fallback that covers it — never detached",
    detachedAt < 0,
    { detachedAt, covering, sides: [...sides] },
  );
  check(
    "the walk met the flip as well as the landing below",
    sides.has("below") && sides.has("above"),
    [...sides],
  );
  check(
    "and the id it names is the whole one, selectable in a box that has room for it",
    narrow.said().oid === oid(19) && narrow.said().oid.length === 40,
    { oid: narrow.said().oid, width: narrow.boxes(19)?.bubble.width ?? -1 },
  );

  // The scroll the view asked for is the cursor moving, not the reader
  // leaving: the answer follows the row it was opened for.
  narrow.scroll();
  check(
    "the reveal a key caused keeps the answer it was keeping",
    !narrow.hidden() && namesItsRow(narrow, 19),
    { hidden: narrow.hidden() },
  );
  narrow.scroll();
  check("the next one, which can only be the reader, closes it", narrow.hidden(), {
    hidden: narrow.hidden(),
  });

  // --- the row that is gone ----------------------------------------------
  // The route that used to empty the rows under an open bubble was the page's
  // own find box, and that box is gone: a filter drew a graph out of the rows
  // it left standing, which is the one thing this panel refuses to do. What
  // remains of the claim — that a bubble closes rather than following its index
  // onto a different commit — is pinned as computation in `anchorRow` and its
  // fixtures, and nothing here re-measures it.
  pending.clear();

  // --- paying for the pane -----------------------------------------------
  wide.press("Home");
  wide.click(2);
  check(
    "a click is the question that costs a read: the pane opens and asks once",
    ask("commit_files") === 1 && wide.element.querySelector(".history-detail")?.hidden === false,
    { commitFiles: ask("commit_files") },
  );
  const beforeKeys = ask("commit_files");
  wide.press("ArrowDown");
  wide.press("ArrowDown");
  check(
    "and walking on past it stops the row from owning the buttons",
    ask("commit_files") === beforeKeys,
    { beforeKeys, after: ask("commit_files") },
  );
  const detailOid = wide.element.querySelector<HTMLElement>(".detail-meta")?.textContent ?? "";
  check(
    "the pane still describes the commit it was opened for, not the cursor",
    detailOid.includes(oid(2)) && !detailOid.includes(oid(4)),
    detailOid.slice(0, 160),
  );
  const afterEnter = ask("commit_files");
  wide.press("Enter");
  check(
    "Enter is the other way to pay, and the only other one",
    ask("commit_files") === afterEnter + 1,
    { before: afterEnter, after: ask("commit_files") },
  );

  wide.remove();
  narrow.remove();
  return JSON.stringify({ engine: navigator.userAgent, checks, asks: launches });
};
