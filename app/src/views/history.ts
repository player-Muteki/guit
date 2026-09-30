// History view: a virtualised commit list above a draggable detail pane.
//
// Rows come from the backend's fixed-field log protocol; commits are
// addressed only by full object ids and the frontend never builds Git
// arguments or parses Git output itself. The snapshot fan-out decides when a
// different history is on screen, and this view decides whether a page that
// arrives still belongs to it.

import { invoke } from "@tauri-apps/api/core";
import { button, el, icon, openMenu, plural, type MenuItem } from "../dom";
import { branchChoices, branchLabel } from "../headModel";
import { onDispose } from "../lifecycle";
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
  historyPageStart,
  includedInLine,
  indexNames,
  namesAt,
  placeBubble,
  refsIncluding,
  rowGeometry,
  unknownNames,
  BUBBLE_HOVER_MS,
  type GraphPan,
  type NameIndex,
  type Rect,
  type RefSummary,
} from "../historyModel";
import { revealScroll, rowHeightPx, visibleWindow, HISTORY_ROW_REM } from "../fileModel";
import { currentFontPx } from "../font";
import { locateCommit } from "../searchModel";
import { readRefListing } from "../refsStore";
import { contextMatches, readContextFor, subscribeToDomain } from "../snapshotBus";
import {
  applySnapshot,
  currentSnapshot,
  isSessionActive,
  isToolRunning,
  isWriteRunning,
  setStatus,
  setToolRunning,
  setWriteRunning,
} from "../state";
import type {
  CommitFileView,
  CommitView,
  HistoryPage,
  OperationResult,
  ReadContext,
  RefListing,
  SessionRead,
  ToolResult,
} from "../types";
import type { PreviewController } from "../dialogs/preview";

// The assumed row height must be the height the stylesheet gives a commit row
// (`--row-height-history`, rem-based), so it follows interface zoom.
const rowHeight = (): number => rowHeightPx(currentFontPx(), HISTORY_ROW_REM);
const OVERSCAN = 6;

export interface HistoryDeps {
  preview: PreviewController;
  onBranchFromCommit(oid: string): void;
  onTagFromCommit(oid: string): void;
  onError(error: unknown): void;
}

export type RevealRoute =
  /// The commit was already among the rows drawn: the list scrolled to it.
  | "loaded"
  /// It was not, so a page was read starting at that commit and the head line
  /// now says so.
  | "anchored";

export interface HistoryView {
  element: HTMLElement;
  sync(): void;
  render(): void;
  /**
   * Puts one commit on screen and answers which way it got there.
   *
   * A search hit is named by its object id alone, and the search's own position
   * in its walk is not a row index in this graph: the two orders coincide only
   * at the newest end. So the honest read is either "this page already has it"
   * or "read the page that starts at it", and the second one changes what the
   * head line is claiming about the rows below it.
   */
  reveal(oid: string): RevealRoute;
}

export function createHistoryView(deps: HistoryDeps): HistoryView {
  const element = el("section", { class: "view-body history-view" });

  // The mainline toggle sits in the list head, above the graph, because it
  // changes which history the graph is showing rather than where the window is
  // in it. The one control that asks *which commit* left this head for the
  // search field above: a filter that hides rows would redraw the graph with
  // the rows it hid still wired underneath it.
  const firstParentToggle = el("input", { type: "checkbox", id: "history-first-parent" }) as HTMLInputElement;
  const firstParentLabel = el("label", { class: "checkbox", for: "history-first-parent" }, [
    firstParentToggle, el("span", { text: "Mainline only" }),
  ]);
  firstParentLabel.title =
    "Follow only each commit's first parent: the straight line of the branch, with the branches it merged left out.";
  // The name of what the graph is drawing, and the way to draw another one. It
  // leads the head because it is the subject of the sentence the rest of the
  // line finishes; the toggle and the paging button both describe how that one
  // history is read.
  const branchButton = el("button", {
    class: "btn history-branch",
    type: "button",
    "aria-label": "Switch branch",
    "aria-haspopup": "menu",
  });
  branchButton.title = "The branch this history is drawn from. Pick another to read its history.";
  const moreButton = el("button", { class: "btn", type: "button", text: "Load older", disabled: true });
  const countLabel = el("span", { class: "history-count", role: "status" });
  // A names read Git refused leaves every row unlabelled, which is drawn
  // exactly like a repository with no branches or tags. The count line says
  // which of the two it is; this asks again without waiting for a refresh.
  const namesRetry = button("Names again", () => void readNames(true), {
    class: "btn btn-quiet",
    ariaLabel: "Read the branch and tag names again",
    title: "The names on these commits could not be read.",
  });
  namesRetry.hidden = true;
  // A page can be read from a commit other than the head — that is how a search
  // hit that no loaded row carries reaches the screen. The rows then describe
  // that commit's ancestry and not the branch's recent history, which is a
  // claim the head line has to make out loud. The button is the way back.
  const anchorNotice = el("span", { class: "history-anchored", role: "status", hidden: true });
  const anchorClear = button("Branch head", () => {
    anchorOid = null;
    void loadPage(true);
    render();
  }, { class: "btn btn-quiet", title: "Draw the history from the branch head again." });
  anchorClear.hidden = true;
  const listHead = el("div", { class: "history-list-head" }, [
    branchButton, anchorNotice, anchorClear, countLabel, namesRetry,
    el("div", { class: "spacer" }), firstParentLabel, moreButton,
  ]);

  const rowsHost = el("div", { class: "virtual-rows" });
  const virtual = el("div", { class: "virtual" }, [rowsHost]);
  const listPane = el("div", {
    class: "history-list",
    role: "listbox",
    "aria-label": "Commit history",
    tabIndex: 0,
  }, [virtual]);
  const emptyState = el("p", { class: "empty-state", hidden: true });

  const splitter = el("div", { class: "splitter", role: "separator", "aria-orientation": "horizontal", "aria-label": "Resize commit details" });

  const detail = el("div", { class: "history-detail", hidden: true });

  // The bubble that answers the row the pointer rests on or the keyboard
  // moved to. It is a child of the view rather than of a row: the rows are
  // replaced wholesale on every scroll, page and filter, so a layer inside one
  // would be destroyed by the paint it is supposed to survive. It carries no
  // controls — only text, so that the 40-character id can be selected.
  const bubbleMessage = el("pre", { class: "bubble-message" });
  const bubbleAuthor = el("p", { class: "bubble-line" });
  const bubbleOid = el("p", { class: "bubble-line bubble-oid" });
  const bubbleRefs = el("p", { class: "bubble-line" });
  const bubble = el("div", { class: "commit-bubble", "aria-hidden": "true", hidden: true }, [
    bubbleMessage, bubbleAuthor, bubbleOid, bubbleRefs,
  ]);

  // The view is the box the bubble is placed in and confined to.
  element.append(listHead, listPane, splitter, emptyState, detail, bubble);

  let commits: CommitView[] = [];
  let hasMore = false;
  let loading = false;
  // The gutter is as wide as the widest lane in the whole loaded history, so
  // it is measured from the loaded commits rather than from the rows on
  // screen: sizing it to what is visible would slide the subject text
  // sideways every time a wider part of the graph scrolled into view.
  let gutterColumns = 1;
  // The leftmost column the gutter draws. The ceiling is eight lanes and the
  // backend draws up to twenty-four before it folds, so a wide history has
  // columns past the edge; the pan is how the user reaches them. One value
  // shared by every row, because a lane that shifted per row would be a
  // different lane.
  let graphOrigin = 0;
  // The loaded history wired backwards, so a graph tooltip can answer where
  // a commit is included rather than only repeating what its row already
  // says. Rebuilt with every page, and answers cached per commit until then.
  let refMap = buildRefMap([]);
  const refSummaries = new Map<string, RefSummary>();
  // The names the rows carry, joined by the commit each one points at. They
  // come from their own read on their own counter, because a branch moving is
  // a change of names and not of history: the graph under a moved label is
  // the same graph, and re-reading a page of commits to move one chip would
  // claim otherwise.
  let refTips: NameIndex = unknownNames();
  // The listing on screen and the last request sent, kept apart so a refused
  // read is not asked again on every repaint while still being retried by the
  // reader or by the next move of the names.
  let namesContext: ReadContext | undefined;
  let namesAsked: ReadContext | undefined;
  // The listing the chips were joined from, kept for the one other thing that
  // answers from it: the header's list of branches to read. It travels with
  // `refTips` and never on its own, so the menu can never offer a branch the
  // rows are not already labelled with.
  let namesListing: RefListing | null = null;
  // Set when the backend had to draw the history first-parent because the
  // live lane count would not fit the gutter. It is said in words, because a
  // silently linearised graph would claim a shape the history does not have.
  let graphFolded = false;
  // The session and history generation the loaded pages belong to; undefined
  // while no repository is on screen. Both come from the backend, because a
  // page of commits for one repository is indistinguishable — commit for commit
  // — from a page for a copy of it.
  let graphContext: ReadContext | undefined;
  // The row the keyboard and the pointer are pointing at. This is a cursor,
  // not an open pane: moving it costs nothing, because looking is not a
  // request to work on the commit.
  let selected: CommitView | null = null;
  let selectedIndex = -1;
  // The commit the detail pane is describing, and the only thing the action
  // buttons act on. The pane opens on a click or on Enter and stays put while
  // the cursor moves on, so reading a file list is not undone by an arrow key.
  let opened: CommitView | null = null;
  // Where the bubble is open: the row it hangs off, and the commit that row
  // was naming when it opened. The index says where to look and the id says
  // whether what is there is still the thing being described.
  let bubbleAt: { index: number; oid: string } | null = null;
  let hoverTimer: number | undefined;
  let leaveTimer: number | undefined;
  // Set just before the view scrolls itself, so the scroll event that follows
  // is not mistaken for the reader wheeling away from the row.
  let internalScroll = false;
  onDispose(() => {
    window.clearTimeout(hoverTimer);
    window.clearTimeout(leaveTimer);
  });
  let detailHeight = 240;
  // Whether the page is the whole history or only each commit's first parent.
  // This is Git's own notion of a mainline, so the backend decides what it
  // means; the view only asks for one or the other.
  let firstParent = false;
  // The commit the loaded pages were read *from*, when that is not the head.
  // Only a reveal sets it, and only a reveal from a commit no loaded row
  // carries; every other route to a new page — a refresh, a branch switch, a
  // mainline change — starts from the head again and clears it.
  let anchorOid: string | null = null;
  // A row to flash on the next paint — used to show where a reveal or a write
  // landed in a long list. Cleared once applied.
  let flashIndex = -1;
  let flashTimer: number | undefined;
  onDispose(() => window.clearTimeout(flashTimer));

  const flashRowAt = (index: number): void => {
    flashIndex = index;
    renderRows();
  };

  // --- detail rendering ---
  const detailMessage = el("pre", { class: "commit-message" });
  const detailMeta = el("dl", { class: "detail-meta" });
  // The names row is the one row of the detail pane that is not a fact about
  // the commit, so it is filled from the listing rather than from the row and
  // refilled whenever a new listing arrives.
  const detailNames = el("dd", { class: "detail-names" });
  const detailFiles = el("ul", { class: "detail-files" });
  const closeDetail = button("Close", () => hideDetail(), { class: "btn" });
  const copyOid = button("Copy OID", () => void copyOidNow(), { class: "btn" });
  const diffCommit = button("Diff commit", () => {
    if (opened) void runCommitDiff(opened);
  }, { class: "btn" });
  const branchFrom = button("Branch from commit…", () => {
    if (opened) deps.onBranchFromCommit(opened.oid);
  }, { class: "btn" });
  const tagFrom = button("Tag from commit…", () => {
    if (opened) deps.onTagFromCommit(opened.oid);
  }, { class: "btn" });
  const cherryPick = button("Cherry-pick", () => {
    if (opened) void runCommitWrite("pick_commit", { oid: opened.oid }, `Cherry-picking ${opened.oid.slice(0, 10)}…`);
  }, { class: "btn", title: "Apply this commit onto the current branch" });
  const revert = button("Revert", () => {
    if (opened) void runCommitWrite("revert_commit", { oid: opened.oid }, `Reverting ${opened.oid.slice(0, 10)}…`);
  }, { class: "btn", title: "Create a new commit undoing this one on the current branch" });
  const resetSoft = button("Reset soft", () => {
    if (opened) void runCommitWrite("reset", { mode: "soft", target: opened.oid }, `Resetting (soft) to ${opened.oid.slice(0, 10)}…`);
  }, { class: "btn", title: "Move the branch to this commit; keep the index and all file contents" });
  const resetMixed = button("Reset mixed", () => {
    if (opened) void runCommitWrite("reset", { mode: "mixed", target: opened.oid }, `Resetting (mixed) to ${opened.oid.slice(0, 10)}…`);
  }, { class: "btn", title: "Move the branch and index to this commit; keep file contents" });
  const resetHard = button("Reset hard…", () => {
    if (opened) void deps.preview.request("resetHard", { target: opened.oid }, null);
  }, { class: "btn btn-danger", title: "Move the branch to this commit and overwrite working-copy changes (with confirmation)" });

  const actions = el("div", { class: "detail-actions" }, [
    copyOid, diffCommit, branchFrom, tagFrom, cherryPick, revert, resetSoft, resetMixed, resetHard,
    el("div", { class: "spacer" }), closeDetail,
  ]);
  detail.append(detailMessage, detailMeta, detailFiles, actions);

  // Moving the cursor. This repaints the rows and says nothing to the
  // backend: the pane that reads a commit's files is opened by `openDetail`,
  // because an arrow key is not a request to run a Git process per press.
  const setCursor = (commit: CommitView, index: number): void => {
    selected = commit;
    selectedIndex = index;
    renderRows();
  };

  // Opening the pane. A click and Enter are the two ways to ask to work on a
  // commit, so they are the two ways the files are read.
  const openDetail = (commit: CommitView, index: number): void => {
    closeBubble();
    setCursor(commit, index);
    opened = commit;
    void showDetail(commit);
  };

  const hideDetail = (): void => {
    opened = null;
    detail.hidden = true;
    renderActions();
  };

  // A commit nothing names and a names read that failed are two different
  // facts, and an empty row drawn for the second would hide the failure the
  // reader needs.
  const paintDetailNames = (): void => {
    if (opened === null) return;
    const chips = refTips.unknown ? null : namesAt(refTips, opened.oid);
    const lines =
      chips === null
        ? ["The names could not be read."]
        : chips.length === 0
          ? ["No branch or tag names this commit."]
          : chips.map((chip) => chip.name);
    detailNames.replaceChildren(
      ...lines.map((line) => el("span", { class: "detail-line", text: line })),
    );
  };

  const showDetail = async (commit: CommitView): Promise<void> => {
    detail.hidden = false;
    detail.style.height = `${detailHeight}px`;
    detailMessage.textContent = commit.message;
    const meta: Array<[string, string[]]> = [
      ["Commit", [commit.oid]],
      ["Author", [commit.authorName, `<${commit.authorEmail}>`, commit.authorDate]],
      ["Committer", [commit.committerName, commit.commitDate]],
    ];
    detailMeta.replaceChildren(
      ...meta.flatMap(([term, lines]) => {
        const dt = el("dt", { text: term });
        const dd = el("dd", {}, lines.map((line) => el("span", { class: "detail-line", text: line })));
        return [dt, dd];
      }),
      el("dt", { text: "Names" }),
      detailNames,
    );
    paintDetailNames();
    detailFiles.replaceChildren(el("li", { class: "muted", text: "Loading files…" }));
    renderActions();
    const asked = graphContext;
    if (asked === undefined) return;
    try {
      const read = await invoke<SessionRead<CommitFileView[]>>("commit_files", {
        context: asked,
        oid: commit.oid,
      });
      // The detail panel describes one row of one history. Files that arrive for
      // a head which has since moved, or for a copy of this repository opened
      // while the read ran, belong to no row on this screen.
      if (
        opened !== commit ||
        graphContext === undefined ||
        !contextMatches(asked, graphContext) ||
        !contextMatches(asked, read.context)
      )
        return;
      const files = read.value;
      if (files.length === 0) {
        detailFiles.replaceChildren(el("li", { class: "muted", text: "No files changed against its first parent." }));
      } else {
        detailFiles.replaceChildren(
          ...files.map((file) =>
            el("li", {}, [
              el("span", { class: "file-status", text: file.status }),
              el("span", { text: file.oldPath ? `${file.oldPath} → ${file.path}` : file.path }),
            ]),
          ),
        );
      }
    } catch (error) {
      if (opened !== commit) return;
      deps.onError(error);
      detailFiles.replaceChildren(el("li", { class: "muted", text: "The file list could not be loaded." }));
    }
  };

  const renderActions = (): void => {
    const locked = opened === null || isWriteRunning();
    copyOid.disabled = locked;
    diffCommit.disabled = locked || isToolRunning();
    branchFrom.disabled = locked;
    tagFrom.disabled = locked;
    cherryPick.disabled = locked;
    revert.disabled = locked;
    resetSoft.disabled = locked;
    resetMixed.disabled = locked;
    resetHard.disabled = locked;
  };

  const copyOidNow = async (): Promise<void> => {
    if (opened === null) return;
    const oid = opened.oid;
    try {
      await navigator.clipboard.writeText(oid);
      setStatus("Commit id copied.", "success");
    } catch {
      // Honest fallback: show the full id rather than claim a copy.
      setStatus(`Clipboard unavailable — commit id: ${oid}`, "error");
    }
  };

  // Shares the external-tool lane with file diffs: one blocking tool at a
  // time, while staging and committing stay available. The commit is a
  // parameter rather than a read of the selection, because a double-click is
  // aimed at the row under the pointer and the cursor may have moved on.
  const runCommitDiff = async (commit: CommitView): Promise<void> => {
    const asked = graphContext;
    if (asked === undefined || isToolRunning()) return;
    setToolRunning(true);
    setStatus("Waiting for the diff tool to close…", "progress");
    renderActions();
    try {
      const read = await invoke<SessionRead<ToolResult>>("open_commit_diff", {
        context: asked,
        oid: commit.oid,
      });
      // This answer is an action, not a read. The backend refused it if the row
      // had already left the screen when the tool was asked for; from then on
      // the result stands whatever the head moved to while the window was open,
      // because the tool ran against the repository the user was looking at.
      const result = read.value;
      applySnapshot(result.snapshot);
      setStatus(result.details ? `${result.message} ${result.details}` : result.message, result.outcome === "success" ? "success" : "error");
    } catch (error) {
      deps.onError(error);
      setStatus("The commit diff did not run.", "error");
    } finally {
      setToolRunning(false);
      renderActions();
    }
  };

  // Cherry-pick, revert and soft/mixed reset ride the same backend write
  // queue as the branch operations. Only full commit ids (never paths or
  // revspecs) leave the frontend.
  const runCommitWrite = async (
    command: "pick_commit" | "revert_commit" | "reset",
    args: Record<string, unknown>,
    running: string,
  ): Promise<void> => {
    const snapshot = currentSnapshot();
    if (snapshot === null || isWriteRunning()) return;
    setWriteRunning(true);
    setStatus(running, "progress");
    try {
      const result = await invoke<OperationResult>(command, { snapshotVersion: snapshot.version, ...args });
      applySnapshot(result.snapshot);
      setStatus(result.details ? `${result.message} ${result.details}` : result.message, result.outcome === "success" ? "success" : "error");
    } catch (error) {
      deps.onError(error);
      setStatus("The commit operation did not run.", "error");
    } finally {
      setWriteRunning(false);
      renderActions();
    }
  };

  // Scrolling a row into view only when the view itself asked for the scroll,
  // and telling the scroll handler so: the row the bubble hangs off moves with
  // the list, which is the opposite of the reader wheeling away from it.
  const revealRow = (index: number): void => {
    const before = listPane.scrollTop;
    const top = revealScroll(before, listPane.clientHeight || 240, index, rowHeight());
    if (top === before) return;
    internalScroll = true;
    listPane.scrollTop = top;
    // The browser clamps a target past the end of the content, and an
    // assignment that lands back where it started fires no scroll event at
    // all. Reading the value back is what says whether the flag above has an
    // event to explain; a flag left standing would let the reader's next wheel
    // movement pass for one the view asked for, and the bubble would outlive
    // the row it was answering.
    if (listPane.scrollTop === before) internalScroll = false;
  };

  // --- the bubble ---
  // Nothing here asks the backend. The full message, the full date and the
  // full id are in the page that is already on screen, and the one line the
  // row cannot answer — which loaded ref tips contain this commit — is walked
  // from the pages already loaded. A hover costs what a hover should: nothing.
  const summaryFor = (commit: CommitView): RefSummary => {
    // Nothing is cached while the names are unknown: the next listing changes
    // the answer, and a cached failure would keep the bubble silent about the
    // names that arrived since.
    let summary = refTips.unknown ? undefined : refSummaries.get(commit.oid);
    if (summary === undefined) {
      summary = refsIncluding(refMap, refTips, commit.oid);
      if (!refTips.unknown) refSummaries.set(commit.oid, summary);
    }
    return summary;
  };

  // Putting the bubble where its row is, inside the list pane. Both boxes are
  // measured in the view's own space, because the bubble is drawn into the
  // view: a viewport rectangle handed to `placeBubble` would land it somewhere
  // else whenever the panel is not at the top-left of the screen.
  const boxOf = (node: Element, origin: DOMRect): Rect => {
    const box = node.getBoundingClientRect();
    return { left: box.left - origin.left, top: box.top - origin.top, width: box.width, height: box.height };
  };

  const placeBubbleNow = (): void => {
    if (bubbleAt === null) return;
    const row = rowsHost.querySelector<HTMLElement>(`#commit-row-${bubbleAt.index}`);
    // The row is not on screen — the list scrolled it out between the paint
    // that anchored this bubble and this measure. The commit is still loaded;
    // the bubble is not, and following it to wherever the row used to be is a
    // box pointing at nothing.
    if (row === null) {
      closeBubble();
      return;
    }
    const origin = element.getBoundingClientRect();
    // Clear the size the last placement left behind, so the measurement is the
    // text's own box and not the box the pane forced on it last time.
    bubble.style.width = "";
    bubble.style.height = "";
    const placed = placeBubble(
      boxOf(row, origin),
      boxOf(listPane, origin),
      { width: bubble.offsetWidth, height: bubble.offsetHeight },
      bubbleInsetPx(currentFontPx()),
    );
    if (placed === null) {
      closeBubble();
      return;
    }
    bubble.style.left = `${placed.left}px`;
    bubble.style.top = `${placed.top}px`;
    bubble.style.width = `${placed.width}px`;
    bubble.style.height = `${placed.height}px`;
    bubble.dataset.side = placed.above ? "above" : "below";
  };

  const paintBubble = (commit: CommitView): void => {
    bubbleMessage.textContent = commit.message;
    bubbleAuthor.textContent = `${commit.authorName} — ${commit.authorDate}`;
    bubbleOid.textContent = commit.oid;
    bubbleRefs.textContent = `Included in: ${includedInLine(refTips, summaryFor(commit))}`;
    bubble.hidden = false;
    placeBubbleNow();
  };

  // Opening on a row the reader is pointing at or has just moved to by key.
  const openBubble = (commit: CommitView, index: number): void => {
    bubbleAt = { index, oid: commit.oid };
    paintBubble(commit);
  };

  const closeBubble = (): void => {
    window.clearTimeout(hoverTimer);
    hoverTimer = undefined;
    window.clearTimeout(leaveTimer);
    leaveTimer = undefined;
    bubbleAt = null;
    bubble.hidden = true;
  };

  const scheduleBubble = (commit: CommitView, index: number): void => {
    window.clearTimeout(leaveTimer);
    leaveTimer = undefined;
    if (bubbleAt !== null && (bubbleAt.index !== index || bubbleAt.oid !== commit.oid)) closeBubble();
    // Resting on the row the bubble already answers is not a new request.
    if (bubbleAt !== null) return;
    window.clearTimeout(hoverTimer);
    hoverTimer = window.setTimeout(() => {
      hoverTimer = undefined;
      openBubble(commit, index);
    }, BUBBLE_HOVER_MS);
  };

  // The pointer left the row. Whether that is "gone" or "moved into the
  // bubble" is not knowable from the event — the two boxes touch on purpose —
  // so the answer is read off the live tree on the next tick, once the hover
  // style has been recomputed.
  const retireBubble = (): void => {
    window.clearTimeout(hoverTimer);
    hoverTimer = undefined;
    if (bubbleAt === null) return;
    window.clearTimeout(leaveTimer);
    leaveTimer = window.setTimeout(() => {
      leaveTimer = undefined;
      if (!bubble.matches(":hover")) closeBubble();
    }, 0);
  };

  // --- list ---
  const SVG_NS = "http://www.w3.org/2000/svg";

  // Where the gutter's one fixed width sits over the loaded history, at the
  // size it is drawn. Derived rather than stored: the four numbers are a
  // function of the columns loaded, the ceiling and the requested origin, so
  // a kept copy would be one more thing to remember to refresh — and a line
  // above the list naming columns the drawing does not show is the pan
  // describing a graph it did not move.
  const graphWindow = (fontPx = currentFontPx()): GraphPan =>
    graphPan(gutterColumns, graphLanePx(fontPx), graphGutterMaxPx(fontPx), graphOrigin);

  /// Draws one row's graph. The geometry comes from the pure model, so this
  /// only turns parts into SVG nodes; a row is drawn from its own columns
  /// alone, which is what lets the list stay virtualised.
  ///
  /// Each stroke is laid down twice: first a wider underlay in the row's own
  /// background, then the coloured line on top. Where two branches cross,
  /// the underlay is what stops them fusing into one thick mark — the line
  /// that passes over gets a clean gap around it, so every crossing stays
  /// readable without any of them being dashed or faded.
  const graphSvg = (
    commit: CommitView,
    height: number,
    fontPx: number,
    origin: number,
  ): SVGSVGElement => {
    const geometry = rowGeometry(
      commit.graph,
      gutterColumns,
      graphLanePx(fontPx),
      height,
      graphNodePx(fontPx),
      graphGutterMaxPx(fontPx),
      origin,
    );
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "graph-gutter");
    svg.setAttribute("width", String(geometry.width));
    svg.setAttribute("height", String(geometry.height));
    svg.setAttribute("viewBox", `0 0 ${geometry.width} ${geometry.height}`);
    // A row whose lanes reach past the ceiling fades at the edge rather
    // than being cut by it; rows inside the ceiling carry no mask.
    if (geometry.clipped) svg.setAttribute("data-fade", "true");
    // The row's own text already names the commit and its kind; announcing
    // the drawing as well would say the same thing twice.
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");

    const element = (name: "line" | "path" | "circle"): SVGElement =>
      document.createElementNS(SVG_NS, name);
    // Column 0 is the mainline and keeps the quiet colour; every other column
    // is a side lane and cycles through the hues. The mapping is a function
    // of the column alone, so a lane keeps its hue down the whole history.
    const laneClass = (lane: number): string => (lane === 0 ? "0" : String(1 + ((lane - 1) % 5)));

    const shadows: SVGElement[] = [];
    const strokes: SVGElement[] = [];
    const dots: SVGElement[] = [];
    let seenNodes = 0;
    for (const part of geometry.parts) {
      if (part.kind === "line") {
        const shadow = element("line");
        shadow.setAttribute("class", "graph-shadow");
        shadow.setAttribute("x1", String(part.x));
        shadow.setAttribute("x2", String(part.x));
        shadow.setAttribute("y1", String(part.y1));
        shadow.setAttribute("y2", String(part.y2));
        shadows.push(shadow);
        const line = element("line");
        line.setAttribute("class", "graph-line");
        line.setAttribute("data-lane", laneClass(part.lane));
        line.setAttribute("x1", String(part.x));
        line.setAttribute("x2", String(part.x));
        line.setAttribute("y1", String(part.y1));
        line.setAttribute("y2", String(part.y2));
        if (part.dashed) line.setAttribute("data-dash", "true");
        strokes.push(line);
      } else if (part.kind === "branch") {
        const shadow = element("path");
        shadow.setAttribute("class", "graph-shadow");
        shadow.setAttribute("d", part.path);
        shadows.push(shadow);
        const path = element("path");
        path.setAttribute("class", "graph-line");
        path.setAttribute("data-lane", laneClass(part.lane));
        path.setAttribute("d", part.path);
        strokes.push(path);
      } else {
        const dot = element("circle");
        dot.setAttribute("class", "graph-node");
        dot.setAttribute("data-lane", laneClass(part.lane));
        dot.setAttribute("data-shape", part.shape);
        // A merge's second node is its inner dot; it stays small under the
        // pointer so the ring around it still reads as the join.
        if (part.kind === "node" && seenNodes++ > 0 && commit.graph.merge) {
          dot.setAttribute("data-inner", "true");
        }
        dot.setAttribute("cx", String(part.cx));
        dot.setAttribute("cy", String(part.cy));
        dot.setAttribute("r", String(part.r));
        dots.push(dot);
      }
    }
    // Underlays first, then the coloured strokes, then the nodes on top of
    // both, so a dot always sits cleanly over whatever lines meet at it.
    svg.append(...shadows, ...strokes, ...dots);
    return svg;
  };

  // The names sitting on a commit, each kind given its own shape so a branch,
  // a tag and a remote-tracking branch can be told apart at a glance. The
  // order is fixed (branch, tag, remote) so the column does not shuffle
  // between rows. While the names are unknown the column is simply empty —
  // the count line above the list says why, rather than every row claiming the
  // repository has no names.
  const refChips = (commit: CommitView): HTMLElement[] => {
    const chips: HTMLElement[] = [];
    for (const chip of namesAt(refTips, commit.oid)) {
      const label =
        chip.kind === "branch" ? `Branch ${chip.name}` : chip.kind === "tag" ? `Tag ${chip.name}` : `Remote branch ${chip.name}`;
      chips.push(
        el("span", {
          class: `commit-ref ref-${chip.kind}`,
          text: chip.name,
          title: label,
        }),
      );
    }
    return chips;
  };

  // A commit's kind is a fact about the history, not about the drawing, so it
  // is spelled out for anyone not looking at the gutter.
  const rowDescription = (commit: CommitView): string => {
    const kind = commit.graph.root
      ? "First commit. "
      : commit.graph.merge
        ? `Merge commit, ${commit.parents.length} parents. `
        : "";
    const head = commit.oid === (currentSnapshot()?.branch?.oid ?? null) ? "Checked out. " : "";
    const beyond = commit.graph.dangling ? " More history is below what is loaded." : "";
    return `${head}${kind}${commit.subject} — ${commit.authorName}, ${commit.authorDate.slice(0, 10)}.${beyond}`;
  };

  const placeholder = (message: string): void => {
    commits = [];
    hasMore = false;
    selected = null;
    selectedIndex = -1;
    opened = null;
    closeBubble();
    detail.hidden = true;
    moreButton.disabled = true;
    countLabel.textContent = "";
    virtual.style.height = "0px";
    rowsHost.style.transform = "translateY(0px)";
    // The rows go with the state they described. A hidden pane still holding the
    // previous repository's commits would be a listbox of ids nothing points at,
    // and the next paint would have to remember to overwrite them.
    rowsHost.replaceChildren();
    listPane.removeAttribute("aria-activedescendant");
    listPane.hidden = true;
    splitter.hidden = true;
    emptyState.hidden = false;
    emptyState.textContent = message;
  };

  // --- what the list says about itself ---
  // Whether a failed names read is on screen: before the first read there is
  // nothing to report, and while a re-read is in flight the rows still carry
  // the listing that described them.
  const namesUnknown = (): boolean => refTips.unknown && namesContext !== undefined;

  const countSentence = (): string => {
    const pan = graphWindow();
    return (
      plural(commits.length, "commit") +
      (hasMore ? " so far." : " — all loaded.") +
      (firstParent ? " on the mainline." : "") +
      // A folded graph is drawn on the first-parent line, so the shape on screen
      // is simpler than the history. Say which it is rather than let the drawing
      // imply a history with no branches in it.
      (graphFolded
        ? " Branches are not drawn: this history has more lines open at once than the graph has room for."
        : "") +
      // The fade at the gutter's edge says lanes stop there; only this line says
      // whether anything lies past it, how wide the view is and what moves it.
      (pan.over
        ? ` The graph shows columns ${pan.origin + 1}–${pan.origin + pan.shown} of ${pan.columns}; scroll sideways or use the arrow keys to move it.`
        : "") +
      // An unlabelled column of rows is also what a repository with no branches
      // or tags looks like, so the two have to be told apart somewhere.
      (namesUnknown() ? " The names could not be read, so no row is labelled." : "")
    );
  };

  const updateCount = (): void => {
    // A placeholder owns the line while the list itself is hidden.
    if (!listPane.hidden) countLabel.textContent = countSentence();
  };

  // Everything the listing is drawn into: the chips, the tooltip that answers
  // "included in", the detail row and the line that says why a column is empty.
  const renderNames = (): void => {
    refSummaries.clear();
    namesRetry.hidden = !namesUnknown();
    updateCount();
    paintDetailNames();
    if (commits.length > 0) renderRows();
  };

  // --- the branch this history is drawn from ---
  // The header answers with the names the rows already carry, so opening it
  // costs no read: the listing shown is the listing the chips were joined from,
  // and a menu that offered a branch the rows are not labelled with would be a
  // second answer to a question already answered.
  const branchMenu = (): MenuItem[] => {
    if (namesListing === null) {
      // The same two cases the line above the list tells apart, in its words.
      return [{ label: namesContext === undefined
        ? "The names have not been read yet."
        : "The names could not be read." }];
    }
    const items = branchChoices(namesListing.branches, currentSnapshot()?.branch ?? null).map(
      (choice): MenuItem => choice.current
        // Shown and inert: this is the row the graph is already on, and a
        // switch to it is a Git run that changes nothing.
        ? { label: choice.name, detail: "checked out" }
        : choice.runnable
          ? { label: choice.name, detail: choice.detail, run: () => void switchTo(choice.name) }
          : { label: choice.name, detail: "not switchable", hint: choice.reason ?? undefined },
    );
    if (items.length === 0) items.push({ label: "This repository has no other branch." });
    return items;
  };
  branchButton.addEventListener("click", () => openMenu(branchButton, branchMenu()));

  // The button answers with the head the snapshot publishes, so all three
  // states — a named branch, a detached HEAD, a branch with no commits — are
  // said in the same words the app bar uses for them.
  const renderBranchChoice = (): void => {
    const snapshot = currentSnapshot();
    branchButton.textContent = branchLabel(snapshot?.branch ?? null);
    branchButton.disabled = snapshot === null || isWriteRunning();
  };

  // What the head line claims about where these pages came from. It is drawn
  // with the rows it describes rather than with the click that asked for them,
  // so the sentence and the graph it is about always change together.
  const renderAnchor = (): void => {
    const anchored = anchorOid;
    const shown = anchored !== null && commits.length > 0;
    anchorNotice.hidden = !shown;
    anchorClear.hidden = !shown;
    if (anchored !== null) anchorNotice.textContent = `Drawn from ${anchored.slice(0, 10)} — not the branch head.`;
  };

  // One write, on the lane every write shares. A switch asks for no preview and
  // no ticket: it is not a destructive operation here, and what it cannot do
  // Git itself refuses with HEAD left where it was. The snapshot that refusal
  // carries is what keeps the graph honest — so nothing reloads from here,
  // because the head moving is exactly the event the graph domain is
  // subscribed to, and a second page read would be the same page read twice.
  const switchTo = async (name: string): Promise<void> => {
    const snapshot = currentSnapshot();
    if (snapshot === null || isWriteRunning()) return;
    setWriteRunning(true);
    setStatus(`Switching to ${name}…`, "progress");
    try {
      const result = await invoke<OperationResult>("switch_branch", {
        snapshotVersion: snapshot.version,
        name,
      });
      applySnapshot(result.snapshot);
      setStatus(
        result.details ? `${result.message} ${result.details}` : result.message,
        result.outcome === "success" ? "success" : "error",
      );
    } catch (error) {
      deps.onError(error);
      setStatus("The branch switch did not run.", "error");
    } finally {
      setWriteRunning(false);
      renderBranchChoice();
    }
  };

  // Moving the gutter by whole columns. One step answers both halves of the
  // gesture: the drawing shifts and the line above the list names the columns
  // now on screen. A pane with nothing off its edge has no pan to offer, so
  // the caller keeps its default handling — and while there are columns past
  // the edge the gesture belongs to the graph even at either end of the run,
  // where a scroll that fell through to the list would be a second meaning
  // for the same movement of the wheel.
  const shiftGraph = (by: number): boolean => {
    const before = graphWindow();
    if (!before.over) return false;
    graphOrigin = before.origin + by;
    const after = graphWindow();
    if (after.origin !== before.origin) renderRows();
    updateCount();
    return true;
  };

  const loadPage = async (reset: boolean): Promise<void> => {
    const asked = graphContext;
    if (loading || asked === undefined) return;
    if (!reset && !hasMore) return;
    loading = true;
    const anchored = anchorOid;
    moreButton.disabled = true;
    try {
      const read = await invoke<SessionRead<HistoryPage>>("history_page", {
        context: asked,
        start: historyPageStart(commits.length, reset),
        oid: anchored,
        firstParent,
      });
      // Two questions, and both have to answer yes: is the screen still the one
      // that asked, and did the backend answer the session that asked? A page
      // can arrive after a refresh moved the head, and it can arrive from a
      // repository opened while this request was already running.
      if (graphContext === undefined || !contextMatches(asked, graphContext)) return;
      if (!contextMatches(asked, read.context)) return;
      const page = read.value;
      commits = reset ? page.commits : commits.concat(page.commits);
      hasMore = page.hasMore;
      gutterColumns = graphColumns(commits);
      // A reset is a different history, not a longer one: it starts at its own
      // left edge rather than carrying over where the old one was panned to.
      if (reset) graphOrigin = 0;
      refMap = buildRefMap(commits);
      refSummaries.clear();
      graphFolded = commits.some((commit) => commit.graph.folded);
      listPane.hidden = false;
      splitter.hidden = false;
      emptyState.hidden = true;
      updateCount();
      renderAnchor();
      renderRows();
    } catch (error) {
      deps.onError(error);
      placeholder("History could not be loaded.");
    } finally {
      loading = false;
      moreButton.disabled = !hasMore;
      // A reveal that landed while this page was being read changed what the
      // page should have started from, and the rows above came from the old
      // one. Reading again is the only answer that matches the head line; the
      // second read captures the anchor it was asked with, so this runs once
      // per change rather than per retry.
      if (anchorOid !== anchored) void loadPage(true);
    }
  };

  // The names are read on their own counter and joined onto the rows already
  // drawn, so a tag created since the last capture lands on its commit without
  // a page of history being read again. A refusal is drawn as a refusal: the
  // rows keep their shape, the chips stay off, and the line above the list says
  // which of the two empty cases this is.
  const readNames = async (retry = false): Promise<void> => {
    const snapshot = currentSnapshot();
    if (snapshot === null) {
      namesAsked = undefined;
      namesContext = undefined;
      refTips = unknownNames();
      namesListing = null;
      renderNames();
      return;
    }
    const asked = readContextFor(snapshot, "refs");
    if (namesAsked !== undefined && namesAsked.sessionId !== asked.sessionId) {
      // Another repository: its commits can be identical, commit for commit, to
      // the ones just drawn, and its names cannot be assumed to be, so the
      // listing of the session that closed joins nothing here.
      namesContext = undefined;
      refTips = unknownNames();
      namesListing = null;
    }
    if (!retry && namesAsked !== undefined && contextMatches(namesAsked, asked)) return;
    namesAsked = asked;
    try {
      const read = await readRefListing(asked);
      if (namesAsked === undefined || !contextMatches(asked, namesAsked)) return;
      if (!contextMatches(asked, read.context)) return;
      namesContext = asked;
      refTips = indexNames(read.value);
      namesListing = read.value;
    } catch {
      if (namesAsked === undefined || !contextMatches(asked, namesAsked)) return;
      // The read was asked and nothing came of it. That is a fact about these
      // rows, and the line above the list says it: a toast would be the same
      // failure reported twice if the branch picker is open over this view.
      namesContext = asked;
      refTips = unknownNames();
      namesListing = null;
    }
    renderNames();
  };

  const renderRows = (): void => {
    if (commits.length === 0) return;
    const rows = buildHistoryRows(commits);
    const fontPx = currentFontPx();
    const pan = graphWindow(fontPx);
    const rowHeightNow = rowHeightPx(fontPx, HISTORY_ROW_REM);
    const viewport = listPane.clientHeight || 240;
    const slice = visibleWindow(rows.length, listPane.scrollTop, viewport, rowHeightNow, OVERSCAN);
    virtual.style.height = `${slice.totalHeight}px`;
    rowsHost.style.transform = `translateY(${slice.offsetY}px)`;
    const fragment = document.createDocumentFragment();
    const headOid = currentSnapshot()?.branch?.oid ?? null;
    for (let index = slice.startIndex; index < slice.endIndex; index++) {
      const commit = rows[index].commit;
      const element = el("div", {
        id: `commit-row-${index}`,
        class: `commit-row${index === selectedIndex ? " selected" : ""}${commit.oid === headOid ? " head" : ""}${index === flashIndex ? " flash" : ""}`,
        role: "option",
        "aria-selected": String(index === selectedIndex),
        "aria-label": rowDescription(commit),
      }, [
        // Each field is its own fixed-width cell and the subject takes what is
        // left, so the subject's left edge, the authors and the dates all line
        // up down the list. One reading eye can then scan a column instead of
        // re-finding where each row's text begins.
        el("span", { class: "commit-refs", "aria-hidden": "true" }, refChips(commit)),
        el("span", { class: "commit-subject", text: commit.subject }),
        el("span", { class: "commit-author", text: commit.authorName }),
        el("span", { class: "commit-date", text: commit.authorDate.slice(0, 10) }),
        // The short id is here so a commit can be named out loud from the
        // list; the full one is what the bubble answers with.
        el("span", { class: "commit-short", "aria-hidden": "true", text: commit.oid.slice(0, 7) }),
      ]);
      // The graph leads the row, so it is prepended last: `prepend` puts the
      // element at the very front, and the gutter belongs left of the refs
      // chips and the subject.
      element.prepend(graphSvg(commit, rowHeightNow, fontPx, pan.origin));
      element.addEventListener("click", () => openDetail(commit, index));
      element.addEventListener("dblclick", () => void runCommitDiff(commit));
      // Resting on a row asks what it is; the delay is what tells a rest from
      // a sweep down the list.
      element.addEventListener("pointerenter", () => scheduleBubble(commit, index));
      element.addEventListener("pointerleave", retireBubble);
      fragment.append(element);
    }
    rowsHost.replaceChildren(fragment);
    if (flashIndex >= 0) {
      // The flash is a one-shot: drop the class after it has played so a
      // later re-render (a scroll, a resize) does not replay it. Only one is
      // pending at a time — stepping through the matches can land on a new row
      // before the previous highlight has finished, and the older timer would
      // then be taking the class off a row that is no longer flashing.
      const flashed = flashIndex;
      flashIndex = -1;
      window.clearTimeout(flashTimer);
      flashTimer = window.setTimeout(() => {
        flashTimer = undefined;
        rowsHost.querySelector(`#commit-row-${flashed}`)?.classList.remove("flash");
      }, 950);
    }
    if (selectedIndex >= slice.startIndex && selectedIndex < slice.endIndex) {
      listPane.setAttribute("aria-activedescendant", `commit-row-${selectedIndex}`);
    } else {
      listPane.removeAttribute("aria-activedescendant");
    }
    // The rows are new, so the bubble's claim on its row is re-tried against
    // them: the same index must still carry the same commit, or the bubble
    // closes. Following the screen position onto a different commit is the one
    // thing a bubble may not do — it would read as one commit's message
    // wearing another one's id.
    if (bubbleAt !== null) {
      const still = anchorRow(commits, bubbleAt.index, bubbleAt.oid);
      if (still === null) closeBubble();
      else paintBubble(still);
    }
  };

  // --- splitter ---
  let dragging = false;
  splitter.addEventListener("pointerdown", (event) => {
    dragging = true;
    splitter.setPointerCapture(event.pointerId);
  });
  splitter.addEventListener("pointermove", (event) => {
    if (!dragging || opened === null) return;
    const rect = listPane.getBoundingClientRect();
    const next = Math.min(Math.max(120, rect.bottom - event.clientY), Math.max(120, rect.height - 100));
    detailHeight = next;
    detail.style.height = `${next}px`;
  });
  splitter.addEventListener("pointerup", (event) => {
    dragging = false;
    splitter.releasePointerCapture(event.pointerId);
  });

  // --- events ---
  moreButton.addEventListener("click", () => void loadPage(false));
  firstParentToggle.addEventListener("change", () => {
    firstParent = firstParentToggle.checked;
    // A different history entirely, so the pages loaded under the old
    // question no longer apply; page zero is read again.
    void loadPage(true);
  });
  listPane.addEventListener("scroll", () => {
    // A scroll the view asked for is the cursor moving to a row it can be seen
    // on; a scroll the reader made is the reader leaving the row the bubble is
    // answering, and the bubble goes with the row it was pointing at.
    if (internalScroll) internalScroll = false;
    else if (bubbleAt !== null) closeBubble();
    if (commits.length > 0) renderRows();
  }, { passive: true });
  // The bubble sits flush against its row so that the pointer can travel from
  // one to the other without crossing anything else, which is also what lets a
  // reader select the 40-character id. Resting inside it keeps it open;
  // leaving it retires it the same way leaving a row does.
  bubble.addEventListener("pointerenter", () => {
    window.clearTimeout(leaveTimer);
    leaveTimer = undefined;
  });
  bubble.addEventListener("pointerleave", retireBubble);
  // A wheel turned sideways, or one turned down under Shift, moves the graph
  // rather than the list: the pane cannot scroll horizontally — every row
  // shares one gutter width — so there is nothing else this gesture could be
  // asking for. It steps a column at a time because a column is the unit the
  // gutter is drawn and named in; a pan measured in pixels would leave the
  // line above the list naming columns that are only half on screen.
  listPane.addEventListener("wheel", (event) => {
    const sideways = Math.abs(event.deltaX) > Math.abs(event.deltaY);
    const by = sideways ? Math.sign(event.deltaX) : event.shiftKey ? Math.sign(event.deltaY) : 0;
    if (by === 0) return;
    if (shiftGraph(by)) event.preventDefault();
  }, { passive: false });
  // The graph is drawn row by row, so its geometry has to follow the height
  // the pane actually has. A resize observer on the scroller catches every
  // cause — the panel split being dragged, interface zoom, a narrower window —
  // that a `window` listener would miss.
  const rowWatcher = new ResizeObserver(() => {
    if (commits.length > 0) renderRows();
  });
  rowWatcher.observe(listPane);
  onDispose(() => rowWatcher.disconnect());
  listPane.addEventListener("keydown", (event) => {
    if (commits.length === 0) return;
    let target = -2;
    switch (event.key) {
      case "ArrowDown": target = selectedIndex < 0 ? 0 : Math.min(selectedIndex + 1, commits.length - 1); break;
      case "ArrowUp": target = selectedIndex < 0 ? 0 : Math.max(selectedIndex - 1, 0); break;
      case "Home": target = 0; break;
      case "End": target = commits.length - 1; break;
      case "ArrowLeft":
        // The sideways keys move the graph, not the selection: nothing here
        // scrolls horizontally, and the columns a pan reaches are the ones the
        // row keys cannot show at all.
        if (shiftGraph(-1)) event.preventDefault();
        return;
      case "ArrowRight":
        if (shiftGraph(1)) event.preventDefault();
        return;
      case "Enter":
        // The key that says *work on this one*: the row key only shows what
        // the row already knows, this one opens the pane that reads the files.
        if (selectedIndex >= 0) openDetail(commits[selectedIndex], selectedIndex);
        event.preventDefault();
        return;
      case "Escape":
        // The bubble is the topmost thing this view drew, so it goes first.
        if (bubbleAt !== null) closeBubble();
        return;
      default: return;
    }
    event.preventDefault();
    if (target < 0) return;
    revealRow(target);
    setCursor(commits[target], target);
    // A key press is already the decision to read this row, so the answer
    // comes on the key: no hover delay on the keyboard path, and no Git
    // process either — the pane stays where the last click left it.
    openBubble(commits[target], target);
  });
  // Leaving the list leaves the row the keyboard was reading. The check for
  // the pointer being inside the bubble is what keeps a selection of the id
  // alive: taking focus off the pane must not be a reason to lose the text.
  listPane.addEventListener("blur", () => {
    if (bubbleAt !== null && !bubble.matches(":hover")) closeBubble();
  });

  // --- putting one commit on screen ---
  // The search layer names a commit and stops there: which of the two honest
  // routes reaches it is decided here, because only this view knows which
  // commits it has drawn. Nothing about a search hit may narrow the graph — the
  // rows a page carries are the rows the backend laid out, all of them, and the
  // only thing a reveal changes is which page that is.
  const reveal = (oid: string): RevealRoute => {
    const locator = locateCommit(oid, commits.map((commit) => commit.oid));
    if (locator.kind === "loaded") {
      revealRow(locator.index);
      setCursor(commits[locator.index], locator.index);
      // The answer comes with the jump rather than waiting for the pointer,
      // same as every other route to a row.
      openBubble(commits[locator.index], locator.index);
      flashRowAt(locator.index);
      return "loaded";
    }
    // Not on screen. The search's position in its own walk is not an index into
    // this graph — the two orders coincide only at the newest end — so the
    // commit is read as the start of a page rather than as a row number, and
    // the head line says as much while those rows are up.
    anchorOid = oid;
    void loadPage(true);
    return "anchored";
  };

  // --- lifecycle ---
  // Whether the graph has to be read again is not this view's question to
  // answer: the snapshot fan-out only reaches the graph domain when the backend
  // says that domain's own generation moved. This answers what to do when it
  // does — drop the selection and the loaded pages, because both belonged to a
  // history that is no longer on screen.
  const sync = (): void => {
    const snapshot = currentSnapshot();
    if (snapshot === null) {
      // Nothing on screen owns a context any more, so a page that arrives for
      // the session that just closed has no screen to arrive on.
      graphContext = undefined;
      void readNames();
      placeholder("Open a repository to browse its history.");
      render();
      return;
    }
    const head = snapshot.branch?.oid ?? null;
    graphContext = readContextFor(snapshot, "graph");
    // A refresh is the branch's own history again, whatever page was on screen
    // before it, so the page that was read from a commit goes with the rows it
    // described.
    anchorOid = null;
    // The listing is asked for the same session the page is about to be read
    // for, so the rows are never drawn with the previous repository's names.
    void readNames();
    selected = null;
    selectedIndex = -1;
    opened = null;
    // A different history on screen retires both layers: neither has a row
    // this side of the refresh to hang off.
    closeBubble();
    detail.hidden = true;
    if (head === null) placeholder("No commits yet.");
    else void loadPage(true);
    render();
  };

  // The names are this view's own subscription, not the shell's: the labels are
  // a second read on a second counter, so a branch that moved repaints the
  // chips while the graph under them is the one already on screen.
  onDispose(subscribeToDomain("refs", () => void readNames()));

  const render = (): void => {
    const locked = !isSessionActive();
    moreButton.disabled = locked || !hasMore || loading;
    renderActions();
    renderBranchChoice();
    if (commits.length > 0) renderRows();
  };

  return { element, sync, render, reveal };
}
