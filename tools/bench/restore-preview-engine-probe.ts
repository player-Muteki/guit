// Engine probe for the changes area's clean-restore entry: what the dialog says
// about a restore, what a refresh costs it, and what one confirmation asks for,
// asked of the renderer the panel displays through.
//
// The fixture suite decides the grouping and the wording on the model —
// `restoreReading` gives each class of path its own heading and drops the empty
// ones, `ConfirmNames` makes "a restore is read out in sections" structural, and
// `changes-wiring.mjs` reads the reset row's handlers out of the source. That is
// where those rules belong and not where the mechanism gets assumed. Whether a
// constructed changes area really draws six labelled groups out of one preview,
// whether a name arrives in the DOM as text rather than as markup, whether the
// ticket then renews itself on a refresh that leaves the field and the focus
// alone, whether Enter opens a confirmation instead of running a write, and
// whether a long list stays inside the window — those are facts about a dialog in
// a laid-out page, with a modal, a focus chain and a scroll container.
//
// This file is run by webkit-engine-probe.py, which bundles it against the panel's
// own source and serves the shipped stylesheet beside it. `probe-tauri-stub.ts` is
// the first import because a view module reaches for the host as soon as it is
// loaded. The probe then replaces the stub's `invoke` with a table that answers the
// one read this area asks — `preview_restore`, whose reply carries the six lists
// and a fresh snapshot — and records every command name it is handed, so "this
// entry never reached for a file id, a diff or a second write" is a count over the
// run rather than a reading of the source. An abbreviation that names more than one
// commit is refused by the table the way Git refuses it: by the text it was handed.
//
// The confirmation is not answered on the table's own schedule: `restore_clean`
// hands back a promise the probe settles by hand, which is the only way to look at
// the panel while the write is in flight — the lane held, the row locked, the
// ticket already spent — and to settle it afterwards with the snapshot whose head
// moved.
//
// The publishing is the app's own, mirrored rather than invented: a snapshot of a
// version not seen before is published once and the open ticket is renewed against
// it, then every view is repainted. The confirm routing mirrors the restore arm of
// `main.ts`'s table, which sends the nonce and nothing else.

import "./probe-tauri-stub";
import {
  applySnapshot,
  currentSnapshot,
  isWriteRunning,
  pendingPreview,
  setStatus,
  setWriteRunning,
  statusLine,
  subscribe,
} from "../../app/src/state";
import { publishSnapshot } from "../../app/src/snapshotBus";
import { createChangesView } from "../../app/src/views/changes";
import { createPreviewController } from "../../app/src/dialogs/preview";
import { applyFontPx } from "../../app/src/font";
import { FONT_DEFAULT, FONT_MAX } from "../../app/src/preferencesModel";
import type { BranchView, OperationResult, RestorePreviewResult, SnapshotView } from "../../app/src/types";

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
// Five sessions, because the entry answers a different question in each: a restore
// that touches all six classes, one whose preview a refresh renews, one that
// touches none, one with a list too long for the dialog, and one whose target no
// longer names a single commit.
const GROUPED = 1;
const RENEW = 2;
const EMPTY = 3;
const MANY = 4;
const AMBIGUOUS_SESSION = 5;

// What the user types is what Git is handed: seven characters that stand for one
// commit in this fixture and for nothing in the panel, which never expands them.
const TYPED = "9f3c1a2";
const AMBIGUOUS = "abc";

// The number first, so an id read out of a heading can be told from another.
const oid = (n: number): string => `${n}${"0".repeat(39)}`.slice(0, 40);

const HEAD_OID = oid(9);
const TARGET_OID = oid(3);

const branch = (name: string, at: string): BranchView => ({
  name,
  headState: "branch",
  oid: at,
  upstream: null,
  ahead: null,
  behind: null,
});

const HEADS: Record<number, BranchView> = {
  [GROUPED]: branch("main", HEAD_OID),
  [RENEW]: branch("live", HEAD_OID),
  [EMPTY]: branch("solo", HEAD_OID),
  [MANY]: branch("wide", HEAD_OID),
  [AMBIGUOUS_SESSION]: branch("late", HEAD_OID),
};

// The six lists one preview answers with, in the order the restore does its work.
interface Lists {
  changed: string[];
  discarded: string[];
  overwritten: string[];
  ignoredWritten: string[];
  removed: string[];
  leftBehind: string[];
}

const ALL_SIX: Lists = {
  changed: ["src/app.rs", "docs/notes.md", 'weird "quoted"<b>.txt'],
  discarded: ["src/app.rs", "README.md"],
  overwritten: ["scratch/plan.txt"],
  ignoredWritten: ["build/output.js"],
  removed: ["tmp/one.txt", "tmp/two.txt"],
  leftBehind: ["vendor/nested/.git"],
};

const NOTHING: Lists = {
  changed: [],
  discarded: [],
  overwritten: [],
  ignoredWritten: [],
  removed: [],
  leftBehind: [],
};

const FIRST: Lists = { ...NOTHING, changed: ["src/a.ts"] };
const SECOND: Lists = { ...NOTHING, changed: ["src/a.ts", "src/b.ts"], removed: ["tmp/arrived.txt"] };

const MANY_PATHS: Lists = {
  ...NOTHING,
  changed: Array.from({ length: 40 }, (_, at) => `src/module-${String(at).padStart(2, "0")}.ts`),
};

// The six headings as a reader has to tell them apart, in the order the two Git
// steps do the work. The wording is the model's contract; what this probe owns is
// that all six verbs are on screen at once, each above its own paths.
const VERBS = [
  "Tracked paths the target's version changes",
  "Local changes this throws away",
  "Untracked paths the restore writes over",
  "Ignored paths the target holds anyway",
  "Untracked paths deleted after the restore",
  "Untracked paths that stay",
];

const countsOf = (lists: Lists): number[] => [
  lists.changed.length,
  lists.discarded.length,
  lists.overwritten.length,
  lists.ignoredWritten.length,
  lists.removed.length,
  lists.leftBehind.length,
];

// One answer per ask, in order; the last one is what a further ask keeps being
// given, because these fixtures are about the shape of a reply, not its count.
const PLAN: Record<number, Lists[]> = {
  [GROUPED]: [ALL_SIX],
  [RENEW]: [FIRST, SECOND],
  [EMPTY]: [NOTHING],
  [MANY]: [MANY_PATHS],
  [AMBIGUOUS_SESSION]: [ALL_SIX],
};

const replies = new Map<number, number>();

// --- the host the view is built against ----------------------------------
// One version counter for the whole run, so every snapshot the panel is handed is
// newer than the one before it, as the backend's are. Each snapshot is filed by its
// own version, because `preview_restore` is bound to a `snapshotVersion` and
// carries no session of its own — the version on screen is the only handle the
// probe has for which repository a preview was asked in.
let nextVersion = 1;
const sessionOfVersion = new Map<number, number>();

const snapshot = (sessionId: number, head: BranchView | null): SnapshotView => {
  const built: SnapshotView = {
    version: nextVersion++,
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
    branch: head,
    // One dirty row, so the area is drawn the way the working panel draws it
    // rather than as an empty list with a footer standing on its own.
    files: [
      {
        id: nextVersion,
        display: "src/app.rs",
        renameFrom: null,
        group: "worktree",
        indexStatus: " ",
        worktreeStatus: "M",
        staged: false,
        unstaged: true,
        conflict: false,
        untracked: false,
        submodule: false,
      },
    ],
    operation: null,
  };
  sessionOfVersion.set(built.version, sessionId);
  return built;
};

const previewFor = (sessionId: number): RestorePreviewResult => {
  const queued = PLAN[sessionId];
  const at = Math.min(replies.get(sessionId) ?? 0, queued.length - 1);
  replies.set(sessionId, at + 1);
  return {
    nonce: `nonce-${sessionId}-${at + 1}`,
    targetOid: TARGET_OID,
    headOid: HEAD_OID,
    ...queued[at],
    snapshot: snapshot(sessionId, HEADS[sessionId]),
  };
};

const result = (
  outcome: OperationResult["outcome"],
  message: string,
  details: string | null,
  body: SnapshotView,
): OperationResult => ({
  operationId: nextVersion,
  kind: "restore",
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
  if (cmd === "preview_restore") {
    const version = Number(asked.snapshotVersion);
    const sessionId = sessionOfVersion.get(version);
    if (sessionId === undefined) return Promise.reject(new Error(`write_stale_snapshot: ${version}`));
    const target = String(asked.target);
    if (target === AMBIGUOUS) return Promise.reject(new Error("reset_ambiguous_target: 'abc' names more than one commit"));
    if (target !== TYPED) return Promise.reject(new Error(`reset_bad_target: ${target}`));
    return Promise.resolve(previewFor(sessionId));
  }
  if (cmd === "restore_clean") {
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

// `@tauri-apps/api/core`'s `invoke` is a pass-through to the internals whose table
// was just replaced, so asking through them is the same request the panel makes —
// and this file cannot import that package, which lives under `app/`, from here.
const send = (cmd: string, args: Record<string, unknown>): Promise<OperationResult> =>
  internals.invoke(cmd, args) as Promise<OperationResult>;

const errors: unknown[] = [];
const onError = (error: unknown): void => {
  errors.push(error);
};

// --- the app this view lives in ------------------------------------------
// `main.ts` builds its parts once, publishes a snapshot of a version it has not
// seen exactly once, renews the open ticket against it, then repaints every view.
// The probe does the same and no more, so a second preview asked for one refresh is
// counted rather than hidden.
let focusFallback = 0;
const preview = createPreviewController(onError, () => {
  focusFallback += 1;
});

preview.onConfirm((pending) => {
  const { kind, nonce } = pending;
  void (async () => {
    // The restore arm of `main.ts`'s table. Any other kind here is a mistake in
    // this probe: it opens exactly one kind of ticket.
    if (kind !== "restore") throw new Error(`the probe never opens a ${kind} ticket`);
    if (isWriteRunning()) return;
    setWriteRunning(true);
    setStatus("Restoring to a clean state…", "progress");
    try {
      const body = await send("restore_clean", { nonce });
      applySnapshot(body.snapshot);
      setStatus(
        body.details ? `${body.message} ${body.details}` : body.message,
        body.outcome === "success" ? "success" : "error",
      );
    } catch (error) {
      onError(error);
      setStatus("The operation did not run.", "error");
    } finally {
      setWriteRunning(false);
    }
  })();
});

const changes = createChangesView({ preview, onError });
document.body.append(changes.element);

let lastRepainted = -2;
const repaint = (): void => {
  const shown = currentSnapshot();
  const version = shown === null ? -1 : shown.version;
  if (version !== lastRepainted) {
    lastRepainted = version;
    publishSnapshot(shown);
    if (shown !== null) void preview.renew();
  }
  changes.render();
};

subscribe((change) => {
  if (change !== "status") repaint();
});

// --- the controls the probe reaches --------------------------------------
// A preview's arrival, a write's answer and a repaint all settle on microtasks, so
// that is what the probe waits on: the harness reads the report a fixed quarter of
// a second after the page loads, and a scenario that spent its time in zero-delay
// timers clamped by the clock would report half a run.
const settle = async (ticks = 80): Promise<void> => {
  for (let at = 0; at < ticks; at++) await Promise.resolve();
};

// One thing does need the engine's own clock: the dialog re-asserts focus on its
// opener across animation frames, because WebKit puts focus back inside the dialog
// after the close. This waits for frames rather than microtasks, and reports how
// many actually came — a focus fact measured before the engine has drawn anything
// is a measurement of the wait, not of the repair.
const frames = (count: number, deadlineMs = 60): Promise<number> =>
  new Promise((resolve) => {
    let seen = 0;
    const tick = (): void => {
      seen += 1;
      if (seen >= count) resolve(seen);
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    setTimeout(() => resolve(seen), deadlineMs);
  });

const openStage = (sessionId: number): void => {
  applySnapshot(snapshot(sessionId, HEADS[sessionId]));
};

const field = (): HTMLInputElement => {
  const node = document.querySelector<HTMLInputElement>("#reset-target");
  if (node === null) throw new Error("the changes area has no reset field");
  return node;
};

const resetRow = (): HTMLButtonElement => {
  const node = document.querySelector<HTMLButtonElement>("#reset-button");
  if (node === null) throw new Error("the changes area has no reset button");
  return node;
};

const draft = (): HTMLTextAreaElement => {
  const node = document.querySelector<HTMLTextAreaElement>("#commit-message");
  if (node === null) throw new Error("the changes area has no commit draft");
  return node;
};

const dialog = (): HTMLDialogElement => preview.dialog.element;

const actionNamed = (label: string): HTMLButtonElement => {
  for (const node of [...document.querySelectorAll<HTMLButtonElement>(".dialog-actions button")]) {
    if (node.textContent === label) return node;
  }
  throw new Error(`the dialog has no ${label} button`);
};

// A programmatic click does not focus what it clicks, while a real gesture does,
// and the dialog hands focus back to whatever held it when the dialog opened. So
// the probe puts the focus where a pointer would have, then clicks.
const press = (node: HTMLElement): void => {
  node.focus();
  node.click();
};

const typeTarget = (text: string): void => {
  field().value = text;
};

const sections = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(".dialog-section")];

const sectionLabels = (): string[] =>
  sections().map((node) => node.querySelector<HTMLElement>(".dialog-section-label")?.textContent ?? "");

const sectionPaths = (): string[][] =>
  sections().map((node) => [...node.querySelectorAll("li")].map((item) => item.textContent ?? ""));

const allPaths = (): string[] => sectionPaths().flat();

const targetLine = (): string => document.querySelector<HTMLElement>(".dialog-target")?.textContent ?? "";

const namesHost = (): HTMLElement => {
  const node = document.querySelector<HTMLElement>(".dialog-names");
  if (node === null) throw new Error("the dialog has no name host");
  return node;
};

const asksSince = (from: number): Ask[] => asks.slice(from);

const countAsks = (cmd: string): number => asks.filter((ask) => ask.cmd === cmd).length;

const distinctCommands = (): string[] => [...new Set(asks.map((ask) => ask.cmd))].sort();

const describeFocus = (): string => {
  const node = document.activeElement;
  if (node === null || node === document.body) return "the page";
  const id = node instanceof HTMLElement && node.id === "" ? "" : `#${(node as HTMLElement).id}`;
  const cls =
    node instanceof HTMLElement && node.className !== "" ? `.${String(node.className).split(" ")[0]}` : "";
  return `${node.tagName.toLowerCase()}${id}${cls}`;
};

// --- the run --------------------------------------------------------------
let finished = false;

const run = async (): Promise<void> => {
  // --- one preview, read out as six classes --------------------------------
  openStage(GROUPED);
  await settle();
  const row = resetRow();
  check(
    "the changes area draws the reset row and asks nothing of Git for it",
    row.textContent === "Reset to clean state…" && row.disabled === false && asks.length === 0,
    asks.map((ask) => ask.cmd),
  );
  const resetRowHost = document.querySelector<HTMLElement>(".reset-row");
  const fieldBox = field().getBoundingClientRect();
  const rowBox = row.getBoundingClientRect();
  check(
    "the field and the button are laid out as one row, the field taking the spare width",
    resetRowHost !== null &&
      getComputedStyle(resetRowHost).display === "flex" &&
      fieldBox.height > 0 &&
      Math.abs(fieldBox.top - rowBox.top) < 1 &&
      fieldBox.width > rowBox.width,
    {
      display: resetRowHost === null ? null : getComputedStyle(resetRowHost).display,
      field: [fieldBox.width, fieldBox.top],
      button: [rowBox.width, rowBox.top],
    },
  );
  typeTarget(TYPED);
  const shownVersion = currentSnapshot()?.version ?? -1;
  const beforeAsk = asks.length;
  press(row);
  await settle();
  const asked = asksSince(beforeAsk);
  check(
    "the preview is bound to the snapshot that was on screen when the row was pressed, and to the text as it was typed",
    asked.length === 1 &&
      asked[0]?.cmd === "preview_restore" &&
      asked[0]?.args.target === TYPED &&
      asked[0]?.args.snapshotVersion === shownVersion,
    { asked, shownVersion, now: currentSnapshot()?.version },
  );
  check(
    "a restore is not asked about the rows on screen, so it carries no file id",
    Object.keys(asked[0]?.args ?? {}).sort().join(",") === "snapshotVersion,target",
    Object.keys(asked[0]?.args ?? {}),
  );
  check("the preview opens the dialog over the page", dialog().open === true && pendingPreview() !== null, {
    open: dialog().open,
    ticket: pendingPreview()?.kind,
  });
  check(
    "the heading says where HEAD moves, in the ids Git resolved rather than the text typed",
    targetLine() === `HEAD moves from ${HEAD_OID.slice(0, 10)} to ${TARGET_OID.slice(0, 10)}` &&
      !targetLine().includes(TYPED),
    targetLine(),
  );
  const labels = sectionLabels();
  const counts = countsOf(ALL_SIX);
  check(
    "every class the restore touches gets its own heading, naming its own verb and its own count",
    sections().length === 6 &&
      labels.every((label, at) => label.startsWith(VERBS[at]) && label.endsWith(` (${counts[at]})`)),
    labels,
  );
  check(
    "and the six are drawn in the order the two steps do them",
    new Set(labels).size === 6 && labels[2] !== labels[5] && labels[2]?.includes("writes over") === true && labels[5]?.includes("stay") === true,
    { third: labels[2], sixth: labels[5] },
  );
  const drawn = allPaths();
  const owed = [
    ...ALL_SIX.changed,
    ...ALL_SIX.discarded,
    ...ALL_SIX.overwritten,
    ...ALL_SIX.ignoredWritten,
    ...ALL_SIX.removed,
    ...ALL_SIX.leftBehind,
  ];
  check(
    "every path the backend named is on screen, in its own group and not in another's",
    drawn.length === owed.length &&
      sectionPaths()[0]?.join(",") === ALL_SIX.changed.join(",") &&
      sectionPaths()[5]?.join(",") === ALL_SIX.leftBehind.join(","),
    { drawn, owed },
  );
  check(
    "a name with markup in it stays a name, not markup",
    drawn.includes('weird "quoted"<b>.txt') && namesHost().innerHTML.includes("<b>") === false,
    { found: drawn.filter((name) => name.includes("<")), markup: namesHost().innerHTML },
  );
  check(
    "a restore's paths carry no object id, because the heading already named both",
    drawn.every((name) => !name.includes("· at")),
    drawn.filter((name) => name.includes("· at")),
  );
  check(
    "the two buttons say what the write does and what refuses it",
    [...document.querySelectorAll<HTMLButtonElement>(".dialog-actions button")].map((node) => node.textContent).join(",") ===
      "Keep everything,Restore to clean state",
    [...document.querySelectorAll<HTMLButtonElement>(".dialog-actions button")].map((node) => node.textContent),
  );
  const note = document.querySelector<HTMLElement>(".dialog-note");
  check("nothing was skipped, so the dialog says nothing about it", note !== null && note.hidden === true, note?.textContent);

  // --- a cancel: the ticket is gone and the row can be asked again ---
  press(actionNamed("Keep everything"));
  await settle();
  const framesSeen = await frames(3, 60);
  await settle();
  check(
    "a cancel closes the dialog, spends nothing and says the work was not done",
    dialog().open === false && pendingPreview() === null && statusLine().message === "Cancelled; nothing was changed.",
    { open: dialog().open, status: statusLine() },
  );
  check(
    "and puts focus back on the control that opened it",
    document.activeElement === row,
    { focus: describeFocus(), framesSeen },
  );
  check("with the field still holding the target that was typed", field().value === TYPED, field().value);
  check(
    "and the row is askable again, with no fallback focus needed",
    resetRow().disabled === false && focusFallback === 0,
    { disabled: resetRow().disabled, fallbacks: focusFallback },
  );

  // --- Enter: a preview, never a write ---
  const beforeEnter = asks.length;
  field().focus();
  field().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await settle();
  check(
    "Enter at the reset row opens the confirmation and runs no write",
    asksSince(beforeEnter).map((ask) => ask.cmd).join(",") === "preview_restore" &&
      countAsks("restore_clean") === 0 &&
      dialog().open === true,
    { asked: asksSince(beforeEnter).map((ask) => ask.cmd), open: dialog().open },
  );
  const beforeSecond = asks.length;
  const disabledNow = resetRow().disabled;
  resetRow().click();
  await settle();
  check(
    "a second ask cannot be made while the ticket and its dialog are open",
    disabledNow === true && asks.length === beforeSecond && dialog().open === true,
    { disabled: disabledNow, asked: asksSince(beforeSecond).map((ask) => ask.cmd) },
  );

  // The ticket a keystroke opened is closed the way a keystroke closes it.
  actionNamed("Keep everything").click();
  await settle();

  // --- a target typed for one repository is not carried into the next ---
  openStage(RENEW);
  await settle();
  check(
    "switching repositories clears a target typed for the one it was typed in",
    field().value === "" && pendingPreview() === null && dialog().open === false,
    { target: field().value, ticket: pendingPreview(), open: dialog().open },
  );

  // --- a refresh renews the ticket and touches nothing else ---
  typeTarget(TYPED);
  draft().value = "half a commit message";
  press(resetRow());
  await settle();
  check("the first preview is what the dialog shows", sectionPaths()[0]?.join(",") === FIRST.changed.join(","), sectionPaths());
  const beforeRefresh = countAsks("preview_restore");
  const refresh = snapshot(RENEW, HEADS[RENEW]);
  const onScreen = refresh.version;
  const heldBefore = describeFocus();
  applySnapshot(refresh);
  await settle();
  check(
    "a refresh of the same session renews the open ticket against the snapshot it just published",
    countAsks("preview_restore") - beforeRefresh === 1 &&
      asks.at(-1)?.cmd === "preview_restore" &&
      asks.at(-1)?.args.target === TYPED &&
      asks.at(-1)?.args.snapshotVersion === onScreen,
    { asked: asks.at(-1)?.args, total: countAsks("preview_restore") },
  );
  check("and the dialog then shows what the fresh preview found", sectionPaths()[0]?.join(",") === SECOND.changed.join(","), sectionPaths());
  check(
    "a refresh leaves the typed target and the commit draft where they were",
    field().value === TYPED && draft().value === "half a commit message",
    { target: field().value, draft: draft().value },
  );
  check("a refresh does not take focus out of the dialog it was asked in", dialog().open === true && describeFocus() === heldBefore, {
    before: heldBefore,
    after: describeFocus(),
  });
  check("and says the preview was recomputed", statusLine().message === "The status changed; the preview was recomputed.", statusLine());

  // --- the confirmation: one nonce, then the write it was bound to ---
  const nonce = pendingPreview()?.nonce ?? "";
  const beforeConfirm = asks.length;
  press(actionNamed("Restore to clean state"));
  await settle();
  const confirmed = asksSince(beforeConfirm);
  check(
    "Confirm sends the one-time ticket and nothing else",
    confirmed.length === 1 &&
      confirmed[0]?.cmd === "restore_clean" &&
      Object.keys(confirmed[0]?.args ?? {}).join(",") === "nonce" &&
      confirmed[0]?.args.nonce === nonce,
    { asked: confirmed, nonce },
  );
  check(
    "the ticket is spent the moment it is confirmed, before Git has answered",
    pendingPreview() === null && dialog().open === false,
    { ticket: pendingPreview(), open: dialog().open },
  );
  check(
    "the row is locked while the write holds the lane",
    isWriteRunning() === true && resetRow().disabled === true && statusLine().kind === "progress",
    { running: isWriteRunning(), disabled: resetRow().disabled, status: statusLine() },
  );
  const moved = snapshot(RENEW, branch("live", TARGET_OID));
  inFlight.shift()?.settle(result("success", "Restored to a clean state.", null, moved), undefined);
  await settle();
  check(
    "the finished write moves the head, unlocks the row and gives the lane back",
    isWriteRunning() === false &&
      resetRow().disabled === false &&
      statusLine().kind === "success" &&
      currentSnapshot()?.branch?.oid === TARGET_OID,
    { running: isWriteRunning(), status: statusLine(), head: currentSnapshot()?.branch?.oid },
  );
  check(
    "and leaves both drafts on screen — a result is a refresh, not a new session",
    field().value === TYPED && draft().value === "half a commit message",
    { target: field().value, draft: draft().value },
  );

  // --- a restore that would touch nothing still says where HEAD moves ---
  openStage(EMPTY);
  await settle();
  typeTarget(TYPED);
  press(resetRow());
  await settle();
  check(
    "an all-empty preview shows no heading for a class with nothing in it",
    dialog().open === true && sections().length === 0 && namesHost().querySelector("li") === null,
    { sections: sectionLabels(), host: namesHost().textContent },
  );
  check(
    "and still says where HEAD moves, so the write is never described as nothing",
    targetLine() === `HEAD moves from ${HEAD_OID.slice(0, 10)} to ${TARGET_OID.slice(0, 10)}`,
    targetLine(),
  );
  actionNamed("Keep everything").click();
  await settle();

  // --- a list too long for the dialog ---
  openStage(MANY);
  await settle();
  typeTarget(TYPED);
  press(resetRow());
  await settle();
  const host = namesHost();
  const rootPx = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
  const capped = getComputedStyle(host);
  const drawnDialog = getComputedStyle(dialog());
  check(
    "the shipped sheet caps the name host at twelve rem of the page's own root font",
    capped.maxHeight === `${12 * rootPx}px` && capped.overflowY === "auto",
    { maxHeight: capped.maxHeight, overflowY: capped.overflowY, rootPx, dialogDisplay: drawnDialog.display },
  );
  const box = dialog().getBoundingClientRect();
  const hostBox = host.getBoundingClientRect();
  check(
    "a long list scrolls inside the dialog instead of growing it past the window",
    host.scrollHeight > host.clientHeight &&
      box.top >= 0 &&
      box.left >= 0 &&
      box.right <= window.innerWidth + 1 &&
      box.bottom <= window.innerHeight + 1,
    {
      scroll: host.scrollHeight,
      client: host.clientHeight,
      box: [box.top, box.right, box.bottom, box.left],
      window: [window.innerWidth, window.innerHeight],
    },
  );
  check("and every one of its paths is asked for, none invented", sectionPaths()[0]?.length === 40, sectionPaths()[0]?.length);
  host.scrollTop = host.scrollHeight;
  await settle();
  const lastBox = host.querySelector("li:last-child")?.getBoundingClientRect();
  check(
    "and the last path is reachable by scrolling the list, not the page",
    lastBox !== undefined && lastBox.bottom <= hostBox.bottom + 1 && lastBox.top >= hostBox.top - 1,
    { last: host.querySelector("li:last-child")?.textContent, lastBox, hostBox: [hostBox.top, hostBox.bottom] },
  );
  // --- the ask against the height of the window it is drawn in ---
  // A modal is drawn in the top layer, so no window scrolls for it: the ask either
  // fits the window or scrolls itself, and the second case is where a name or a
  // button can end up under the bottom edge. Two of the panel's own forces decide
  // which case a user is in — the window's height, and the interface zoom, which
  // grows every `rem` in the sheet while `100vh` stays the window's — so this is
  // measured at the largest zoom the panel offers and phrased to hold whichever way
  // the two come out. The last detail says which case the run measured; a short
  // `--window` on the harness is how the other one is read.
  applyFontPx(FONT_MAX);
  await settle();
  const zoomRoot = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
  const cappedDialog = getComputedStyle(dialog());
  const zoomCap = window.innerHeight - 1.5 * zoomRoot;
  check(
    "the whole ask is capped against the window it is drawn in",
    cappedDialog.maxHeight === `${Math.round(zoomCap * 1000) / 1000}px` && cappedDialog.overflowY === "auto",
    {
      maxHeight: cappedDialog.maxHeight,
      overflowY: cappedDialog.overflowY,
      rootPx: zoomRoot,
      innerHeight: window.innerHeight,
    },
  );
  const tallBox = dialog().getBoundingClientRect();
  check(
    "so the ask is drawn inside the window instead of past its bottom edge",
    tallBox.top >= 0 && tallBox.bottom <= window.innerHeight + 1,
    { box: [tallBox.top, tallBox.right, tallBox.bottom, tallBox.left], window: [window.innerWidth, window.innerHeight] },
  );
  const zoomHost = namesHost();
  check(
    "the list keeps its own scroll, so the ask's cap does not swallow the names",
    zoomHost.scrollHeight > zoomHost.clientHeight && zoomHost.clientHeight > 0,
    { hostScroll: zoomHost.scrollHeight, hostClient: zoomHost.clientHeight },
  );
  const actions = dialog().querySelector(".dialog-actions") as HTMLElement | null;
  const askScrolls = actions !== null && actions.getBoundingClientRect().bottom > window.innerHeight + 1;
  dialog().scrollTop = dialog().scrollHeight;
  await settle();
  const reached = actions?.getBoundingClientRect();
  check(
    "and the buttons that confirm or refuse are reachable by scrolling the ask itself",
    reached !== undefined && reached.bottom <= window.innerHeight + 1 && reached.top >= tallBox.top - 1,
    {
      which: askScrolls ? "the ask scrolls, and its buttons come with the scroll" : "the ask fits this window",
      actionsBottom: reached?.bottom,
      scrollTop: dialog().scrollTop,
    },
  );
  dialog().scrollTop = 0;
  applyFontPx(FONT_DEFAULT);
  await settle();
  actionNamed("Keep everything").click();
  await settle();
  openStage(AMBIGUOUS_SESSION);
  await settle();
  typeTarget(AMBIGUOUS);
  const beforeRefused = asks.length;
  press(resetRow());
  await settle();
  check(
    "an abbreviation that names more than one commit is refused before anything changes",
    dialog().open === false &&
      pendingPreview() === null &&
      asksSince(beforeRefused).map((ask) => ask.cmd).join(",") === "preview_restore" &&
      countAsks("restore_clean") === 1,
    { asked: asksSince(beforeRefused).map((ask) => ask.cmd), writes: countAsks("restore_clean") },
  );
  check(
    "the refusal is handed to the error path, never drawn as an empty preview",
    errors.some((error) => String(error).includes("reset_ambiguous_target")) &&
      dialog().open === false &&
      pendingPreview() === null &&
      statusLine().message === "The clean restore was refused before anything changed.",
    { errors: errors.map(String), status: statusLine() },
  );
  check("and the text that was refused stays where it was typed", field().value === AMBIGUOUS, field().value);

  // --- what the whole run asked for ---
  const commands = distinctCommands();
  check(
    "the only two commands this entry ever asks for are the preview and its ticket",
    commands.join(",") === "preview_restore,restore_clean",
    commands,
  );
  check(
    "no ask carried a file id, and each carried exactly the arguments its own command binds",
    asks.every((ask) =>
      ask.cmd === "preview_restore"
        ? Object.keys(ask.args).sort().join(",") === "snapshotVersion,target"
        : Object.keys(ask.args).join(",") === "nonce",
    ),
    asks.map((ask) => `${ask.cmd}:${Object.keys(ask.args).sort().join("+")}`),
  );
  check(
    "and every ticket the run opened was closed or spent before the end",
    dialog().open === false && pendingPreview() === null,
    { open: dialog().open, ticket: pendingPreview() },
  );
  finished = true;
};

void run().catch((error: unknown) => check("the scenario ran to its last check", false, String(error)));

window.__probe = (): string =>
  JSON.stringify({
    engine: navigator.userAgent,
    checks: [
      { name: "the scenario ran to its last check", ok: finished, detail: `${checks.length} checks before the end` },
      ...checks,
    ],
  });
