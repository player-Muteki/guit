// Engine probe for the graph header's branch selector: what the header says
// about the head, what its menu offers, and what one pick costs, asked of the
// renderer the panel displays through.
//
// The fixture suite decides the wording and the eligibility rules on the model —
// `branchLabel` names the three head states, `branchChoices` marks a row current
// from either signal and refuses a name that cannot be handed back. That is where
// those rules belong and not where the mechanism gets assumed. Whether the header
// of a constructed view really carries that sentence, whether opening a menu costs
// a Git read, whether a pick is one write bound to the snapshot on screen, whether
// the graph then reloads once instead of twice, and whether the write lane is held
// and given back — those are facts about a view in a laid-out page, with timers and
// promises the panel actually waits on.
//
// This file is run by webkit-engine-probe.py, which bundles it against the panel's
// own source and serves the shipped stylesheet beside it. `probe-tauri-stub.ts` is
// the first import because a view module reaches for the host as soon as it is
// loaded. The probe then replaces the stub's `invoke` with a table that answers the
// two reads a graph is built from, each echoing the context it was asked with, and
// records every command name it is handed — so "no stash, force or fetch was ever
// asked" is a count over the run rather than a reading of the source.
//
// A write is not answered on the table's own schedule: `switch_branch` hands back a
// promise the probe settles by hand. That is the only way to look at the panel while
// a write is in flight — the header locked, the lane held, the page not yet re-read —
// and to settle it afterwards with whichever of the three endings the case needs: a
// snapshot whose head moved, a refusal whose head did not, or a backend that would
// not start the write at all.
//
// The publishing is the app's own, mirrored rather than invented: a state change
// repaints every live view, and a snapshot of a version not seen before is published
// once, so the graph domain moves exactly as far as the backend counted it. A picker
// that reloaded on its own would show up here as two page reads where the head moved
// once.

import "./probe-tauri-stub";
import { applySnapshot, currentSnapshot, isWriteRunning, statusLine, subscribe } from "../../app/src/state";
import { publishSnapshot, subscribeToDomain } from "../../app/src/snapshotBus";
import { createHistoryView } from "../../app/src/views/history";
import type { HistoryView } from "../../app/src/views/history";
import type {
  BranchRef,
  BranchView,
  CommitView,
  GraphRow,
  OperationResult,
  ReadContext,
  RefListing,
  SnapshotView,
} from "../../app/src/types";
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
// Six sessions, because the header answers a different question in each: a
// branch of its own, a detached head, a branch with no commits, a bare
// repository, a names read that failed, and a name too long for a header.
const NAMED = 1;
const DETACHED = 2;
const UNBORN = 3;
const BARE = 4;
const NAMES_FAIL = 5;
const LONG = 6;

// The number first, so an id read out of a header can be told from another.
const oid = (n: number): string => `${n}${"0".repeat(39)}`.slice(0, 40);

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

const PAGE: CommitView[] = [
  commit(0, row({})),
  commit(1, row({})),
  commit(2, row({ entry: false, root: true })),
];

const ref = (name: string, extra: Partial<BranchRef> = {}): BranchRef => ({
  name,
  oid: oid(0),
  head: false,
  upstream: null,
  ahead: null,
  behind: null,
  upstreamGone: false,
  addressable: true,
  ...extra,
});

const LONG_NAME = "feature/a-branch-name-that-keeps-going-and-going-past-any-header";

const LISTINGS: Record<number, RefListing> = {
  [NAMED]: {
    branches: [
      ref("main", { head: true }),
      ref("dev", { oid: oid(2), upstream: "origin/dev", ahead: 2, behind: 1 }),
      ref("weird", { addressable: false }),
      ref("topic", { oid: oid(3) }),
    ],
    // Neither of these is a branch, and neither may appear in a list to switch to:
    // a remote-tracking name is not checked out with `switch`, and a tag detaches.
    remotes: [{ name: "origin/dev", oid: oid(2), symref: null, addressable: true }],
    tags: [
      { name: "v1.0", oid: oid(0), targetType: "commit", commitOid: oid(0), annotated: false, addressable: true },
    ],
  },
  [DETACHED]: { branches: [ref("alpha"), ref("beta", { oid: oid(4) })], remotes: [], tags: [] },
  // The listing does not flag this row as the head, because Git's own flag comes
  // from HEAD and an unborn branch has no HEAD to match — the head in the snapshot
  // is the other half of the answer.
  [UNBORN]: { branches: [ref("fresh", { oid: "" })], remotes: [], tags: [] },
  [BARE]: { branches: [], remotes: [], tags: [] },
  [NAMES_FAIL]: { branches: [ref("solo")], remotes: [], tags: [] },
  [LONG]: { branches: [ref(LONG_NAME, { head: true })], remotes: [], tags: [] },
};

const HEADS: Record<number, BranchView | null> = {
  [NAMED]: { name: "main", headState: "branch", oid: oid(0), upstream: null, ahead: null, behind: null },
  [DETACHED]: { name: null, headState: "detached", oid: oid(9), upstream: null, ahead: null, behind: null },
  [UNBORN]: { name: "fresh", headState: "unborn", oid: null, upstream: null, ahead: null, behind: null },
  [BARE]: null,
  [NAMES_FAIL]: { name: "solo", headState: "branch", oid: oid(0), upstream: null, ahead: null, behind: null },
  [LONG]: {
    name: LONG_NAME,
    headState: "branch",
    oid: oid(0),
    upstream: null,
    ahead: null,
    behind: null,
  },
};

// --- the host the view is built against ----------------------------------
// One version counter for the whole run, so every snapshot the panel is handed is
// newer than the one before it, as the backend's are.
let nextVersion = 1;

const snapshot = (
  sessionId: number,
  head: BranchView | null,
  historyGeneration = 0,
  refsGeneration = 0,
): SnapshotView => ({
  version: nextVersion++,
  sessionId,
  historyGeneration,
  refsGeneration,
  repo: {
    displayName: "project",
    openPath: "/home/dev/project",
    root: "/home/dev/project",
    gitDir: "/home/dev/project/.git",
    bare: false,
    linkedWorktree: false,
  },
  branch: head,
  files: [],
  operation: null,
});

const result = (
  outcome: OperationResult["outcome"],
  message: string,
  details: string | null,
  body: SnapshotView,
): OperationResult => ({
  operationId: nextVersion,
  kind: "branchswitch",
  outcome,
  exitCode: outcome === "success" ? 0 : 1,
  message,
  details,
  suggestion: null,
  snapshot: body,
});

interface Ask {
  cmd: string;
  args: Record<string, unknown>;
}

const asks: Ask[] = [];

// A write the probe settles by hand, so the panel can be looked at mid-flight.
interface Held {
  args: Record<string, unknown>;
  settle: (body: OperationResult | null, failure: unknown) => void;
}

const inFlight: Held[] = [];

const internals = (
  window as unknown as {
    __TAURI_INTERNALS__?: { invoke(cmd: string, args: unknown): Promise<unknown> };
  }
).__TAURI_INTERNALS__;
if (internals === undefined) throw new Error("the host stub did not install");
internals.invoke = (cmd: string, args: unknown): Promise<unknown> => {
  const asked = (args ?? {}) as Record<string, unknown>;
  asks.push({ cmd, args: asked });
  const context = (asked.context ?? null) as ReadContext | null;
  if (cmd === "history_page" && context !== null) {
    return Promise.resolve({ context, value: { start: 0, commits: PAGE.slice(), hasMore: false } });
  }
  if (cmd === "list_refs" && context !== null) {
    if (context.sessionId === NAMES_FAIL) return Promise.reject(new Error("the names read was refused"));
    return Promise.resolve({ context, value: LISTINGS[context.sessionId] });
  }
  if (cmd === "switch_branch") {
    return new Promise((resolve, reject) => {
      inFlight.push({
        args: asked,
        settle: (body, failure) => {
          if (failure === undefined || failure === null) resolve(body);
          else reject(failure);
        },
      });
    });
  }
  return Promise.resolve(null);
};

const preview = {
  renew: () => undefined,
  open: () => undefined,
  close: () => undefined,
} as unknown as PreviewController;

// --- the app this view lives in ------------------------------------------
// `main.ts` publishes a snapshot of a version it has not seen, once, and repaints
// every view on a state change. The probe does the same and no more, so a reload
// the picker did for itself is counted rather than hidden.
const live: { view: HistoryView; element: HTMLElement; stop: () => void }[] = [];
let lastRepainted = -2;

const repaint = (): void => {
  const shown = currentSnapshot();
  const version = shown === null ? -1 : shown.version;
  if (version !== lastRepainted) {
    lastRepainted = version;
    publishSnapshot(shown);
  }
  for (const entry of [...live]) entry.view.render();
};

subscribe(() => repaint());

const openStage = (sessionId: number): HistoryView => {
  const view = createHistoryView({
    preview,
    onBranchFromCommit: () => undefined,
    onTagFromCommit: () => undefined,
    onError: (error: unknown) => errors.push(error),
  });
  const stop = subscribeToDomain("graph", () => view.sync());
  document.body.append(view.element);
  live.push({ view, element: view.element, stop });
  return view;
};

const errors: unknown[] = [];

const closeStage = (view: HistoryView): void => {
  const at = live.findIndex((entry) => entry.view === view);
  if (at < 0) return;
  live[at].stop();
  live[at].element.remove();
  live.splice(at, 1);
};

// --- the controls the probe reaches --------------------------------------
// A page's arrival, a write's answer and a repaint all settle on microtasks, so
// that is what the probe waits on: the harness reads the report a fixed quarter
// of a second after the page loads, and a scenario that spent its time in
// zero-delay timers clamped by the clock would report half a run.
const settle = async (ticks = 80): Promise<void> => {
  for (let at = 0; at < ticks; at++) await Promise.resolve();
};

// One thing does need the clock: a menu installs its outside-click listener on a
// timer, so closing one the way a reader does is only a real gesture a tick later.
const arm = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await settle();
};

const headerOf = (view: HistoryView): HTMLButtonElement => {
  const node = view.element.querySelector<HTMLButtonElement>(".history-branch");
  if (node === null) throw new Error("the graph header has no branch button");
  return node;
};

interface MenuRow {
  label: string;
  detail: string;
  disabled: boolean;
  hint: string;
}

const menuRows = (): MenuRow[] =>
  [...document.querySelectorAll<HTMLElement>(".menu.float .menu-item")].map((node) => {
    const button = node as HTMLButtonElement;
    return {
      label: node.querySelector<HTMLElement>(".menu-label")?.textContent ?? "",
      detail: node.querySelector<HTMLElement>(".menu-detail")?.textContent ?? "",
      disabled: button.disabled,
      hint: button.title,
    };
  });

const rowAt = (label: string): HTMLButtonElement | null => {
  for (const node of [...document.querySelectorAll<HTMLElement>(".menu.float .menu-item")]) {
    if (node.querySelector<HTMLElement>(".menu-label")?.textContent === label) return node as HTMLButtonElement;
  }
  return null;
};

const labels = (rows: MenuRow[]): string[] => rows.map((entry) => entry.label);

const openHeader = (view: HistoryView): void => {
  headerOf(view).click();
};

// An outside click is how a reader closes a menu, and it is the only exit that runs
// the popup's own cleanup — removing the node by hand would leave its listeners on
// the document and let the next check measure a menu that is already gone.
const clickOutside = (): void => {
  document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
};

const menuOpen = (): boolean => document.querySelector(".menu.float") !== null;

const countAsks = (cmd: string, sessionId?: number): number =>
  asks.filter((ask) => {
    if (ask.cmd !== cmd) return false;
    if (sessionId === undefined) return true;
    const context = ask.args.context as ReadContext | undefined;
    return context?.sessionId === sessionId;
  }).length;

const distinctCommands = (): string[] => [...new Set(asks.map((ask) => ask.cmd))].sort();

// --- the run --------------------------------------------------------------
let finished = false;

const run = async (): Promise<void> => {
  // --- a branch of its own: what the header says and what the menu offers ---
  const named = openStage(NAMED);
  applySnapshot(snapshot(NAMED, HEADS[NAMED]));
  repaint();
  await settle();
  check("the header names the branch the graph is drawn from", headerOf(named).textContent === "main", {
    header: headerOf(named).textContent,
  });
  check(
    "the header says it is a menu, not a label",
    headerOf(named).getAttribute("aria-haspopup") === "menu" &&
      headerOf(named).getAttribute("aria-label") === "Switch branch",
    {
      haspopup: headerOf(named).getAttribute("aria-haspopup"),
      label: headerOf(named).getAttribute("aria-label"),
    },
  );
  check("the history it heads is on the page", named.element.querySelectorAll(".commit-row").length === PAGE.length,
    named.element.querySelectorAll(".commit-row").length);

  const beforeOpen = asks.length;
  openHeader(named);
  await settle();
  check("opening the header asks nothing of Git", asks.length === beforeOpen, asks.slice(beforeOpen));
  const rows = menuRows();
  check(
    "the menu is the repository's own local branches, in the order Git listed them",
    labels(rows).join(",") === "main,dev,weird,topic",
    labels(rows),
  );
  check(
    "no remote-tracking name and no tag is offered as a branch to switch to",
    rows.every((entry) => entry.label !== "origin/dev" && entry.label !== "v1.0"),
    labels(rows),
  );
  check(
    "the branch already checked out is shown, and not pickable",
    rows[0]?.disabled === true && rows[0]?.detail === "checked out",
    rows[0],
  );
  check(
    "a switchable branch carries where it tracks and how far apart they are",
    rows[1]?.disabled === false &&
      rows[1]?.detail.includes("origin/dev") &&
      rows[1]?.detail.includes("↑2") &&
      rows[1]?.detail.includes("↓1"),
    rows[1],
  );
  check(
    "a name that cannot be handed back to Git is said, not hidden",
    rows[2]?.disabled === true && rows[2]?.detail === "not switchable" && rows[2]?.hint.includes("switched to"),
    rows[2],
  );
  const beforeInert = asks.length;
  rowAt("weird")?.click();
  await settle();
  check(
    "an inert row asks for nothing and stays open to be read",
    countAsks("switch_branch") === 0 && asks.length === beforeInert && menuOpen(),
    { asked: asks.slice(beforeInert), open: menuOpen() },
  );
  await arm();
  clickOutside();
  await settle();
  check("the menu closes on a click outside it", menuOpen() === false, menuOpen());

  // --- one pick, from the click to the page it costs ---
  const beforeReload = countAsks("history_page");
  const refsBefore = countAsks("list_refs");
  const beforePick = asks.length;
  openHeader(named);
  await settle();
  rowAt("dev")?.click();
  await settle();
  const picked = asks.slice(beforePick);
  check("a pick asks exactly one write, and it is a switch", picked.map((ask) => ask.cmd).join(",") === "switch_branch", picked);
  check(
    "the switch is bound to the snapshot on screen",
    picked[0]?.args.name === "dev" && picked[0]?.args.snapshotVersion === currentSnapshot()?.version,
    picked[0]?.args,
  );
  check("the menu is gone the moment the pick is taken", menuOpen() === false, menuOpen());
  check(
    "the header goes quiet while the write holds the lane",
    isWriteRunning() === true && headerOf(named).disabled === true,
    { running: isWriteRunning(), disabled: headerOf(named).disabled },
  );
  check("the status line says which branch is being switched to", statusLine().kind === "progress" && statusLine().message.includes("dev"), statusLine());
  const beforeLocked = asks.length;
  openHeader(named);
  await settle();
  check(
    "a second pick cannot be asked while the first holds the lane",
    menuOpen() === false && asks.length === beforeLocked,
    { open: menuOpen(), asked: asks.slice(beforeLocked) },
  );

  const moved = snapshot(
    NAMED,
    { name: "dev", headState: "branch", oid: oid(2), upstream: "origin/dev", ahead: 2, behind: 1 },
    1,
    0,
  );
  inFlight.shift()?.settle(result("success", "Switched to dev.", null, moved), undefined);
  await settle();
  check(
    "the head moving costs exactly one page read, and no second one from the picker",
    countAsks("history_page") - beforeReload === 1,
    { before: beforeReload, after: countAsks("history_page") },
  );
  check(
    "the names are not read a second time for a head that moved",
    countAsks("list_refs") === refsBefore,
    { before: refsBefore, after: countAsks("list_refs") },
  );
  check("the header follows the head the write left it on", headerOf(named).textContent === "dev", headerOf(named).textContent);
  check("a successful switch is said in the status line", statusLine().kind === "success" && statusLine().message.includes("Switched"), statusLine());
  check(
    "the lane is given back and the header can be asked again",
    isWriteRunning() === false && headerOf(named).disabled === false,
    { running: isWriteRunning(), disabled: headerOf(named).disabled },
  );

  // --- a refusal: the head stayed, so nothing downstream moved ---
  openHeader(named);
  await settle();
  const beforeRefused = countAsks("history_page");
  rowAt("topic")?.click();
  await settle();
  const stillDev = snapshot(NAMED, moved.branch, 1, 0);
  inFlight.shift()?.settle(
    result("failed", "The branch switch did not happen.", "error: your local changes would be overwritten by checkout", stillDev),
    undefined,
  );
  await settle();
  check(
    "a refusal leaves the header on the branch it was on",
    headerOf(named).textContent === "dev",
    headerOf(named).textContent,
  );
  check(
    "a refusal says Git's own reason rather than a silent no",
    statusLine().kind === "error" && statusLine().message.includes("local changes"),
    statusLine(),
  );
  check(
    "a refusal that left the head alone asks for no page",
    countAsks("history_page") === beforeRefused,
    { before: beforeRefused, after: countAsks("history_page") },
  );

  // --- a write the backend would not start at all ---
  openHeader(named);
  await settle();
  const beforeStale = countAsks("history_page");
  rowAt("topic")?.click();
  await settle();
  inFlight.shift()?.settle(null, new Error("write_stale_snapshot"));
  await settle();
  check(
    "a write refused before it ran is handed to the error path",
    errors.length === 1 && String(errors[0]).includes("stale"),
    errors.map(String),
  );
  check(
    "and the status line says nothing moved",
    statusLine().kind === "error" && statusLine().message === "The branch switch did not run.",
    statusLine(),
  );
  check(
    "with the header still on the same branch and no page re-read",
    headerOf(named).textContent === "dev" && countAsks("history_page") === beforeStale,
    { header: headerOf(named).textContent, pages: countAsks("history_page") },
  );
  closeStage(named);

  // --- a detached head ---
  const detached = openStage(DETACHED);
  applySnapshot(snapshot(DETACHED, HEADS[DETACHED]));
  repaint();
  await settle();
  check(
    "a detached head is named as one, with the object it sits on",
    headerOf(detached).textContent === `detached at ${oid(9).slice(0, 8)}`,
    headerOf(detached).textContent,
  );
  openHeader(detached);
  await settle();
  const freeRows = menuRows();
  check(
    "detached marks no row as checked out, and leaves every local branch pickable",
    freeRows.length === 2 && freeRows.every((entry) => entry.disabled === false) && freeRows.every((entry) => entry.detail !== "checked out"),
    freeRows,
  );
  const detachedReload = countAsks("history_page", DETACHED);
  rowAt("beta")?.click();
  await settle();
  inFlight.shift()?.settle(
    result(
      "success",
      "Switched to beta.",
      null,
      snapshot(DETACHED, { name: "beta", headState: "branch", oid: oid(4), upstream: null, ahead: null, behind: null }, 1, 0),
    ),
    undefined,
  );
  await settle();
  check(
    "a detached head is not a dead end: one pick, one reload, and the header follows",
    countAsks("history_page", DETACHED) - detachedReload === 1 &&
      headerOf(detached).textContent === "beta" &&
      statusLine().kind === "success",
    { pages: countAsks("history_page", DETACHED), header: headerOf(detached).textContent, status: statusLine() },
  );
  closeStage(detached);

  // --- a branch with no commits yet ---
  const unborn = openStage(UNBORN);
  applySnapshot(snapshot(UNBORN, HEADS[UNBORN]));
  repaint();
  await settle();
  check(
    "a branch with no commits is said as one, not left blank",
    headerOf(unborn).textContent === "fresh (no commits yet)",
    headerOf(unborn).textContent,
  );
  openHeader(unborn);
  await settle();
  const unbornRows = menuRows();
  check(
    "the head in the snapshot marks its own row, where the listing's flag could not",
    unbornRows.length === 1 && unbornRows[0]?.label === "fresh" && unbornRows[0]?.detail === "checked out" && unbornRows[0]?.disabled === true,
    unbornRows,
  );
  check(
    "an unborn head draws no page, before or after the menu was opened",
    countAsks("history_page", UNBORN) === 0,
    countAsks("history_page", UNBORN),
  );
  await arm();
  clickOutside();
  closeStage(unborn);

  // --- a repository with no head at all ---
  const bare = openStage(BARE);
  applySnapshot(snapshot(BARE, HEADS[BARE]));
  repaint();
  await settle();
  check("a repository with no head says so in the header", headerOf(bare).textContent === "bare repository", headerOf(bare).textContent);
  openHeader(bare);
  await settle();
  const bareRows = menuRows();
  check(
    "a repository with no other branch says that, rather than opening an empty menu",
    bareRows.length === 1 && bareRows[0]?.label === "This repository has no other branch." && bareRows[0]?.disabled === true,
    bareRows,
  );
  await arm();
  clickOutside();
  closeStage(bare);

  // --- a names read that failed ---
  const blind = openStage(NAMES_FAIL);
  applySnapshot(snapshot(NAMES_FAIL, HEADS[NAMES_FAIL]));
  repaint();
  await settle();
  check(
    "a head keeps its name when the names could not be read",
    headerOf(blind).textContent === "solo",
    headerOf(blind).textContent,
  );
  check("the failed names read was asked, and failed", countAsks("list_refs", NAMES_FAIL) === 1, countAsks("list_refs", NAMES_FAIL));
  openHeader(blind);
  await settle();
  const blindRows = menuRows();
  check(
    "a failed names read is said in the menu instead of an empty list",
    blindRows.length === 1 && blindRows[0]?.label === "The names could not be read." && blindRows[0]?.disabled === true,
    blindRows,
  );
  await arm();
  clickOutside();
  closeStage(blind);

  // --- a name longer than the header ---
  const verbose = openStage(LONG);
  applySnapshot(snapshot(LONG, HEADS[LONG]));
  repaint();
  await settle();
  const wide = headerOf(verbose);
  // The cap is the stylesheet's own, measured at the root font size this page
  // actually renders with rather than the one a preference remembers.
  const rootPx = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
  const cap = 11 * rootPx;
  check(
    "a name longer than the header loses its tail, not its neighbours",
    wide.scrollWidth > wide.clientWidth &&
      wide.clientWidth <= cap + 1 &&
      getComputedStyle(wide).textOverflow === "ellipsis",
    { scroll: wide.scrollWidth, client: wide.clientWidth, cap, overflow: getComputedStyle(wide).textOverflow },
  );
  check(
    "and the header still carries the whole name, so the tail can be read back",
    wide.textContent === LONG_NAME,
    wide.textContent,
  );
  closeStage(verbose);

  // --- what the whole run asked for ---
  const commands = distinctCommands();
  check(
    "the only write a branch header ever asked for is the switch",
    commands.join(",") === "history_page,list_refs,switch_branch",
    commands,
  );
  check(
    "no stash, force, fetch, push or preview was ever asked",
    commands.every((cmd) => /stash|force|fetch|push|pull|clone|preview|reset|merge|rebase/i.test(cmd) === false),
    commands,
  );
  finished = true;
};

void run().catch((error: unknown) => check("the scenario ran without throwing", false, String(error)));

window.__probe = (): string =>
  JSON.stringify({
    engine: navigator.userAgent,
    checks: [{ name: "the scenario ran to its last check", ok: finished, detail: `${checks.length} checks before the end` }, ...checks],
  });
