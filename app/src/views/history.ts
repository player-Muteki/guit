// History view: a virtualised commit list above a draggable detail pane.
//
// Rows come from the backend's fixed-field log protocol; commits are
// addressed only by full object ids and the frontend never builds Git
// arguments or parses Git output itself. The snapshot fan-out decides when a
// different history is on screen, and this view decides whether a page that
// arrives still belongs to it.

import { invoke } from "@tauri-apps/api/core";
import { button, el, icon, plural } from "../dom";
import { onDispose } from "../lifecycle";
import {
  buildHistoryRows,
  buildRefMap,
  commitMatches,
  filterCommits,
  findError,
  graphColumns,
  graphGutterMaxPx,
  graphLanePx,
  graphNodePx,
  historyPageStart,
  matchPosition,
  refsIncluding,
  rowGeometry,
  stepMatch,
  type FindQuery,
  type RefSummary,
} from "../historyModel";
import { revealScroll, rowHeightPx, visibleWindow, HISTORY_ROW_REM } from "../fileModel";
import { currentFontPx } from "../font";
import { contextMatches, readContextFor } from "../snapshotBus";
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

export interface HistoryView {
  element: HTMLElement;
  sync(): void;
  render(): void;
}

export function createHistoryView(deps: HistoryDeps): HistoryView {
  const element = el("section", { class: "view-body history-view" });

  // The find box and the mainline toggle sit in the list head, above the
  // graph, because both change what the graph is showing rather than what the
  // window is.
  const findInput = el("input", {
    class: "history-find",
    type: "search",
    placeholder: "Find in loaded commits",
    "aria-label": "Find in loaded commits",
  }) as HTMLInputElement;
  const findCase = button("Aa", () => toggleFindCase(), {
    class: "btn btn-quiet find-mod",
    ariaLabel: "Match case",
    title: "Match case",
  });
  const findRegex = button(".*", () => toggleFindRegex(), {
    class: "btn btn-quiet find-mod",
    ariaLabel: "Use regular expression",
    title: "Use regular expression",
  });
  const findPrev = button("↑", () => void stepFind(-1), {
    class: "btn btn-quiet find-step",
    ariaLabel: "Previous match",
    title: "Previous match (Shift+Enter)",
  });
  const findNext = button("↓", () => void stepFind(1), {
    class: "btn btn-quiet find-step",
    ariaLabel: "Next match",
    title: "Next match (Enter)",
  });
  const findCount = el("span", { class: "find-count", role: "status" });
  const findBox = el("div", { class: "history-findbox", hidden: true }, [
    findInput, findCase, findRegex, findCount, findPrev, findNext,
  ]);
  const firstParentToggle = el("input", { type: "checkbox", id: "history-first-parent" }) as HTMLInputElement;
  const firstParentLabel = el("label", { class: "checkbox", for: "history-first-parent" }, [
    firstParentToggle, el("span", { text: "Mainline only" }),
  ]);
  firstParentLabel.title =
    "Follow only each commit's first parent: the straight line of the branch, with the branches it merged left out.";
  const moreButton = el("button", { class: "btn", type: "button", text: "Load older", disabled: true });
  const countLabel = el("span", { class: "history-count", role: "status" });
  const listHead = el("div", { class: "history-list-head" }, [
    countLabel, el("div", { class: "spacer" }), firstParentLabel, findBox, moreButton,
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

  element.append(listHead, listPane, splitter, emptyState, detail);

  let commits: CommitView[] = [];
  let hasMore = false;
  let loading = false;
  // The gutter is as wide as the widest lane in the whole loaded history, so
  // it is measured from the loaded commits rather than from the rows on
  // screen: sizing it to what is visible would slide the subject text
  // sideways every time a wider part of the graph scrolled into view.
  let gutterColumns = 1;
  // The loaded history wired backwards, so a graph tooltip can answer where
  // a commit is included rather than only repeating what its row already
  // says. Rebuilt with every page, and answers cached per commit until then.
  let refMap = buildRefMap([]);
  const refSummaries = new Map<string, RefSummary>();
  // Set when the backend had to draw the history first-parent because the
  // live lane count would not fit the gutter. It is said in words, because a
  // silently linearised graph would claim a shape the history does not have.
  let graphFolded = false;
  // The session and history generation the loaded pages belong to; undefined
  // while no repository is on screen. Both come from the backend, because a
  // page of commits for one repository is indistinguishable — commit for commit
  // — from a page for a copy of it.
  let graphContext: ReadContext | undefined;
  let selected: CommitView | null = null;
  let selectedIndex = -1;
  let detailHeight = 240;
  // Whether the page is the whole history or only each commit's first parent.
  // This is Git's own notion of a mainline, so the backend decides what it
  // means; the view only asks for one or the other.
  let firstParent = false;
  // The find box searches what is loaded and says so; it never claims to have
  // searched commits that were never fetched.
  let find: FindQuery = { text: "", regex: false, caseSensitive: false };
  // The commits actually shown: the loaded ones, filtered. The graph is laid
  // out by the backend over everything loaded, and filtering only hides rows,
  // so a hidden branch is still there in the graph when the box is cleared.
  let visible: CommitView[] = [];
  let findOpen = false;
  // A row to flash on the next paint — used to show where a find step or a
  // write landed in a long list. Cleared once applied.
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
  const detailFiles = el("ul", { class: "detail-files" });
  const closeDetail = button("Close", () => hideDetail(), { class: "btn" });
  const copyOid = button("Copy OID", () => void copyOidNow(), { class: "btn" });
  const diffCommit = button("Diff commit", () => void runCommitDiff(), { class: "btn" });
  const branchFrom = button("Branch from commit…", () => {
    if (selected) deps.onBranchFromCommit(selected.oid);
  }, { class: "btn" });
  const tagFrom = button("Tag from commit…", () => {
    if (selected) deps.onTagFromCommit(selected.oid);
  }, { class: "btn" });
  const cherryPick = button("Cherry-pick", () => {
    if (selected) void runCommitWrite("pick_commit", { oid: selected.oid }, `Cherry-picking ${selected.oid.slice(0, 10)}…`);
  }, { class: "btn", title: "Apply this commit onto the current branch" });
  const revert = button("Revert", () => {
    if (selected) void runCommitWrite("revert_commit", { oid: selected.oid }, `Reverting ${selected.oid.slice(0, 10)}…`);
  }, { class: "btn", title: "Create a new commit undoing this one on the current branch" });
  const resetSoft = button("Reset soft", () => {
    if (selected) void runCommitWrite("reset", { mode: "soft", target: selected.oid }, `Resetting (soft) to ${selected.oid.slice(0, 10)}…`);
  }, { class: "btn", title: "Move the branch to this commit; keep the index and all file contents" });
  const resetMixed = button("Reset mixed", () => {
    if (selected) void runCommitWrite("reset", { mode: "mixed", target: selected.oid }, `Resetting (mixed) to ${selected.oid.slice(0, 10)}…`);
  }, { class: "btn", title: "Move the branch and index to this commit; keep file contents" });
  const resetHard = button("Reset hard…", () => {
    if (selected) void deps.preview.request("resetHard", { target: selected.oid }, null);
  }, { class: "btn btn-danger", title: "Move the branch to this commit and overwrite working-copy changes (with confirmation)" });

  const actions = el("div", { class: "detail-actions" }, [
    copyOid, diffCommit, branchFrom, tagFrom, cherryPick, revert, resetSoft, resetMixed, resetHard,
    el("div", { class: "spacer" }), closeDetail,
  ]);
  detail.append(detailMessage, detailMeta, detailFiles, actions);

  const setSelected = (commit: CommitView, index: number): void => {
    selected = commit;
    selectedIndex = index;
    renderRows();
    void showDetail(commit);
  };

  const hideDetail = (): void => {
    selected = null;
    selectedIndex = -1;
    detail.hidden = true;
    renderRows();
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
    if (commit.refs.length > 0) meta.push(["Refs", commit.refs]);
    detailMeta.replaceChildren(
      ...meta.flatMap(([term, lines]) => {
        const dt = el("dt", { text: term });
        const dd = el("dd", {}, lines.map((line) => el("span", { class: "detail-line", text: line })));
        return [dt, dd];
      }),
    );
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
        selected !== commit ||
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
      if (selected !== commit) return;
      deps.onError(error);
      detailFiles.replaceChildren(el("li", { class: "muted", text: "The file list could not be loaded." }));
    }
  };

  const renderActions = (): void => {
    const locked = selected === null || isWriteRunning();
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
    if (selected === null) return;
    const oid = selected.oid;
    try {
      await navigator.clipboard.writeText(oid);
      setStatus("Commit id copied.", "success");
    } catch {
      // Honest fallback: show the full id rather than claim a copy.
      setStatus(`Clipboard unavailable — commit id: ${oid}`, "error");
    }
  };

  // Shares the external-tool lane with file diffs: one blocking tool at a
  // time, while staging and committing stay available.
  const runCommitDiff = async (): Promise<void> => {
    const asked = graphContext;
    if (selected === null || asked === undefined || isToolRunning()) return;
    setToolRunning(true);
    setStatus("Waiting for the diff tool to close…", "progress");
    renderActions();
    try {
      const read = await invoke<SessionRead<ToolResult>>("open_commit_diff", {
        context: asked,
        oid: selected.oid,
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

  // --- finding ---
  const applyFind = (): void => {
    visible = filterCommits(commits, find);
    const error = findError(find);
    if (error !== null) {
      findCount.textContent = error;
      findCount.dataset.state = "error";
    } else {
      const { index, total } = matchPosition(commits, find, selected?.oid ?? null);
      findCount.dataset.state = "ok";
      findCount.textContent =
        find.text === "" ? "" : total === 0 ? "No match" : `${index + 1} of ${total}`;
    }
    findCase.classList.toggle("active", find.caseSensitive);
    findRegex.classList.toggle("active", find.regex);
    // A search with no match is not an empty history, so the rows are kept
    // and the count is what says so.
    renderRows();
  };

  const toggleFindCase = (): void => {
    find = { ...find, caseSensitive: !find.caseSensitive };
    applyFind();
  };

  const toggleFindRegex = (): void => {
    find = { ...find, regex: !find.regex };
    applyFind();
  };

  const openFind = (): void => {
    findOpen = true;
    findBox.hidden = false;
    findInput.focus();
    findInput.select();
  };

  const closeFind = (): void => {
    findOpen = false;
    findBox.hidden = true;
    if (find.text !== "") {
      find = { ...find, text: "" };
      findInput.value = "";
      applyFind();
    }
    listPane.focus();
  };

  const stepFind = (delta: 1 | -1): void => {
    const next = stepMatch(commits, find, selected?.oid ?? null, delta);
    if (next === null) return;
    const index = visible.findIndex((commit) => commit.oid === next);
    if (index < 0) return;
    listPane.scrollTop = revealScroll(listPane.scrollTop, listPane.clientHeight || 240, index, rowHeight());
    setSelected(visible[index], index);
    // Each step flashes, so stepping through hits in a long list is visible
    // rather than a silent jump.
    flashRowAt(index);
  };

  // --- list ---
  const SVG_NS = "http://www.w3.org/2000/svg";

  /// Draws one row's graph. The geometry comes from the pure model, so this
  /// only turns parts into SVG nodes; a row is drawn from its own columns
  /// alone, which is what lets the list stay virtualised.
  ///
  /// Each stroke is laid down twice: first a wider underlay in the row's own
  /// background, then the coloured line on top. Where two branches cross,
  /// the underlay is what stops them fusing into one thick mark — the line
  /// that passes over gets a clean gap around it, so every crossing stays
  /// readable without any of them being dashed or faded.
  // The row already says who and what; the tooltip answers the one question
  // the row cannot — which loaded ref tips contain this commit. When none
  // do yet, it says so rather than leaving the line blank.
  const graphTooltip = (commit: CommitView): string => {
    let summary = refSummaries.get(commit.oid);
    if (summary === undefined) {
      summary = refsIncluding(refMap, commit.oid);
      refSummaries.set(commit.oid, summary);
    }
    const included =
      summary.names.length === 0
        ? "nothing loaded"
        : summary.names.join(", ") + (summary.truncated ? " …" : "");
    return `${commit.authorName} — ${commit.subject}\nIncluded in: ${included}`;
  };

  const graphSvg = (commit: CommitView, height: number, fontPx: number): SVGSVGElement => {
    const geometry = rowGeometry(
      commit.graph,
      gutterColumns,
      graphLanePx(fontPx),
      height,
      graphNodePx(fontPx),
      graphGutterMaxPx(fontPx),
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

    const element = (name: "line" | "path" | "circle" | "title"): SVGElement =>
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
        // A native tooltip on hover. The gutter is hidden from assistive
        // tech, so this is a convenience for a mouse, never the only way to
        // the fact.
        const title = element("title");
        title.textContent = graphTooltip(commit);
        dot.appendChild(title);
        dots.push(dot);
      }
    }
    // Underlays first, then the coloured strokes, then the nodes on top of
    // both, so a dot always sits cleanly over whatever lines meet at it.
    svg.append(...shadows, ...strokes, ...dots);
    return svg;
  };

  // The decorations on a commit, each kind given its own shape so a branch, a
  // tag and a remote-tracking branch can be told apart at a glance. Order is
  // fixed (branch, tag, remote) so the column does not shuffle between rows.
  const refChips = (commit: CommitView): HTMLElement[] => {
    const { labels } = commit;
    const chips: HTMLElement[] = [];
    for (const branch of labels.branches) {
      chips.push(el("span", { class: "commit-ref ref-branch", text: branch, title: `Branch ${branch}` }));
    }
    for (const tag of labels.tags) {
      chips.push(el("span", { class: "commit-ref ref-tag", text: tag, title: `Tag ${tag}` }));
    }
    for (const remote of labels.remotes) {
      chips.push(el("span", { class: "commit-ref ref-remote", text: remote, title: `Remote branch ${remote}` }));
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
    visible = [];
    hasMore = false;
    selected = null;
    selectedIndex = -1;
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

  const loadPage = async (reset: boolean): Promise<void> => {
    const asked = graphContext;
    if (loading || asked === undefined) return;
    if (!reset && !hasMore) return;
    loading = true;
    moreButton.disabled = true;
    try {
      const read = await invoke<SessionRead<HistoryPage>>("history_page", {
        context: asked,
        start: historyPageStart(commits.length, reset),
        oid: null,
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
      refMap = buildRefMap(commits);
      refSummaries.clear();
      graphFolded = commits.some((commit) => commit.graph.folded);
      visible = filterCommits(commits, find);
      listPane.hidden = false;
      splitter.hidden = false;
      emptyState.hidden = true;
      countLabel.textContent =
        plural(commits.length, "commit") +
        (hasMore ? " so far." : " — all loaded.") +
        (firstParent ? " on the mainline." : "") +
        // A folded graph is drawn on the first-parent line, so the shape on
        // screen is simpler than the history. Say which it is rather than let
        // the drawing imply a history with no branches in it.
        (graphFolded ? " Branches are not drawn: this history has more lines open at once than the graph has room for." : "");
      renderRows();
    } catch (error) {
      deps.onError(error);
      placeholder("History could not be loaded.");
    } finally {
      loading = false;
      moreButton.disabled = !hasMore;
    }
  };

  const renderRows = (): void => {
    if (visible.length === 0) return;
    const rows = buildHistoryRows(visible);
    const fontPx = currentFontPx();
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
        el("span", { class: "commit-subject", text: commit.subject, title: commit.subject }),
        el("span", { class: "commit-author", text: commit.authorName, title: commit.authorName }),
        el("span", { class: "commit-date", text: commit.authorDate.slice(0, 10) }),
        // The short id is here so a commit can be named out loud from the
        // list; the full one is a click away in the detail pane.
        el("span", { class: "commit-short", "aria-hidden": "true", text: commit.oid.slice(0, 7) }),
      ]);
      // The graph leads the row, so it is prepended last: `prepend` puts the
      // element at the very front, and the gutter belongs left of the refs
      // chips and the subject.
      element.prepend(graphSvg(commit, rowHeightNow, fontPx));
      element.addEventListener("click", () => setSelected(commit, index));
      element.addEventListener("dblclick", () => void runCommitDiff());
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
  };

  // --- splitter ---
  let dragging = false;
  splitter.addEventListener("pointerdown", (event) => {
    dragging = true;
    splitter.setPointerCapture(event.pointerId);
  });
  splitter.addEventListener("pointermove", (event) => {
    if (!dragging || selected === null) return;
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
  findInput.addEventListener("input", () => {
    find = { ...find, text: findInput.value };
    applyFind();
  });
  findInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      stepFind(event.shiftKey ? -1 : 1);
      event.preventDefault();
    } else if (event.key === "Escape") {
      closeFind();
      event.preventDefault();
    }
  });
  listPane.addEventListener("scroll", () => {
    if (visible.length > 0) renderRows();
  }, { passive: true });
  // The graph is drawn row by row, so its geometry has to follow the height
  // the pane actually has. A resize observer on the scroller catches every
  // cause — the panel split being dragged, interface zoom, a narrower window —
  // that a `window` listener would miss.
  const rowWatcher = new ResizeObserver(() => {
    if (visible.length > 0) renderRows();
  });
  rowWatcher.observe(listPane);
  onDispose(() => rowWatcher.disconnect());
  listPane.addEventListener("keydown", (event) => {
    if (visible.length === 0) return;
    const viewport = listPane.clientHeight || 240;
    let target = -2;
    switch (event.key) {
      case "ArrowDown": target = selectedIndex < 0 ? 0 : Math.min(selectedIndex + 1, visible.length - 1); break;
      case "ArrowUp": target = selectedIndex < 0 ? 0 : Math.max(selectedIndex - 1, 0); break;
      case "Home": target = 0; break;
      case "End": target = visible.length - 1; break;
      case "Enter":
        if (selectedIndex >= 0) setSelected(visible[selectedIndex], selectedIndex);
        event.preventDefault();
        return;
      case "/":
        openFind();
        event.preventDefault();
        return;
      case "Escape":
        if (findOpen) closeFind();
        return;
      default: return;
    }
    event.preventDefault();
    if (target < 0) return;
    listPane.scrollTop = revealScroll(listPane.scrollTop, viewport, target, rowHeight());
    setSelected(visible[target], target);
  });

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
      placeholder("Open a repository to browse its history.");
      render();
      return;
    }
    const head = snapshot.branch?.oid ?? null;
    graphContext = readContextFor(snapshot, "graph");
    selected = null;
    selectedIndex = -1;
    detail.hidden = true;
    if (head === null) placeholder("No commits yet.");
    else void loadPage(true);
    render();
  };

  const render = (): void => {
    const locked = !isSessionActive();
    moreButton.disabled = locked || !hasMore || loading;
    renderActions();
    if (commits.length > 0) renderRows();
  };

  return { element, sync, render };
}
