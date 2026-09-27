// History view: a virtualised commit list above a draggable detail pane.
//
// Rows come from the backend's fixed-field log protocol; commits are
// addressed only by full object ids and the frontend never builds Git
// arguments or parses Git output itself. The list is keyed by HEAD oid, so
// a re-render of the same HEAD never touches Git and a moved HEAD re-reads
// page zero.

import { invoke } from "@tauri-apps/api/core";
import { button, el, icon, plural } from "../dom";
import {
  buildHistoryRows,
  graphColumns,
  graphLanePx,
  graphNodePx,
  historyPageStart,
  rowGeometry,
} from "../historyModel";
import { revealScroll, rowHeightPx, visibleWindow, HISTORY_ROW_REM } from "../fileModel";
import { currentFontPx } from "../font";
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
import type { CommitFileView, CommitView, HistoryPage, OperationResult, ToolResult } from "../types";
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
  descriptor: { id: "history"; element: HTMLElement };
  sync(): void;
  render(): void;
}

export function createHistoryView(deps: HistoryDeps): HistoryView {
  const element = el("section", { class: "view-body history-view" });

  const moreButton = el("button", { class: "btn", type: "button", text: "Load older", disabled: true });
  const countLabel = el("span", { class: "history-count", role: "status" });
  const listHead = el("div", { class: "history-list-head" }, [countLabel, el("div", { class: "spacer" }), moreButton]);

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
  // Set when the backend had to draw the history first-parent because the
  // live lane count would not fit the gutter. It is said in words, because a
  // silently linearised graph would claim a shape the history does not have.
  let graphFolded = false;
  // undefined = no session; null = session without commits (unborn HEAD or
  // bare repo); a string = the HEAD oid the loaded pages belong to.
  let repoKey: string | null | undefined;
  let selected: CommitView | null = null;
  let selectedIndex = -1;
  let detailHeight = 240;

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
    try {
      const files = await invoke<CommitFileView[]>("commit_files", { oid: commit.oid });
      if (selected !== commit) return;
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
    if (selected === null || isToolRunning()) return;
    setToolRunning(true);
    setStatus("Waiting for the diff tool to close…", "progress");
    renderActions();
    try {
      const result = await invoke<ToolResult>("open_commit_diff", { oid: selected.oid });
      applySnapshot(result.snapshot);
      setStatus(result.details ? `${result.message} ${result.details}` : result.message, "success");
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
      setStatus(result.details ? `${result.message} ${result.details}` : result.message, "success");
    } catch (error) {
      deps.onError(error);
      setStatus("The commit operation did not run.", "error");
    } finally {
      setWriteRunning(false);
      renderActions();
    }
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
  const graphSvg = (commit: CommitView, height: number, fontPx: number): SVGSVGElement => {
    const geometry = rowGeometry(
      commit.graph,
      gutterColumns,
      graphLanePx(fontPx),
      height,
      graphNodePx(fontPx),
    );
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "graph-gutter");
    svg.setAttribute("width", String(geometry.width));
    svg.setAttribute("height", String(geometry.height));
    svg.setAttribute("viewBox", `0 0 ${geometry.width} ${geometry.height}`);
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
    for (const part of geometry.parts) {
      if (part.kind === "line") {
        const shadow = element("line");
        shadow.setAttribute("class", "graph-shadow");
        shadow.setAttribute("data-weight", part.weight);
        shadow.setAttribute("x1", String(part.x));
        shadow.setAttribute("x2", String(part.x));
        shadow.setAttribute("y1", String(part.y1));
        shadow.setAttribute("y2", String(part.y2));
        shadows.push(shadow);
        const line = element("line");
        line.setAttribute("class", "graph-line");
        line.setAttribute("data-lane", laneClass(part.lane));
        line.setAttribute("data-weight", part.weight);
        line.setAttribute("x1", String(part.x));
        line.setAttribute("x2", String(part.x));
        line.setAttribute("y1", String(part.y1));
        line.setAttribute("y2", String(part.y2));
        if (part.dashed) line.setAttribute("data-dash", "true");
        strokes.push(line);
      } else if (part.kind === "branch") {
        const shadow = element("path");
        shadow.setAttribute("class", "graph-shadow");
        shadow.setAttribute("data-weight", part.weight);
        shadow.setAttribute("d", part.path);
        shadows.push(shadow);
        const path = element("path");
        path.setAttribute("class", "graph-line");
        path.setAttribute("data-lane", laneClass(part.lane));
        path.setAttribute("data-weight", part.weight);
        path.setAttribute("d", part.path);
        strokes.push(path);
      } else {
        const dot = element("circle");
        dot.setAttribute("class", "graph-node");
        dot.setAttribute("data-lane", laneClass(part.lane));
        dot.setAttribute("data-shape", part.shape);
        dot.setAttribute("data-weight", part.weight);
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

  // A commit's kind is a fact about the history, not about the drawing, so it
  // is spelled out for anyone not looking at the gutter.
  const rowDescription = (commit: CommitView): string => {
    const kind = commit.graph.root
      ? "First commit. "
      : commit.graph.merge
        ? `Merge commit, ${commit.parents.length} parents. `
        : "";
    const beyond = commit.graph.dangling ? " More history is below what is loaded." : "";
    return `${kind}${commit.subject} — ${commit.authorName}, ${commit.authorDate.slice(0, 10)}.${beyond}`;
  };

  const placeholder = (message: string): void => {
    commits = [];
    hasMore = false;
    selected = null;
    selectedIndex = -1;
    detail.hidden = true;
    moreButton.disabled = true;
    countLabel.textContent = "";
    virtual.style.height = "0px";
    rowsHost.style.transform = "translateY(0px)";
    listPane.hidden = true;
    splitter.hidden = true;
    emptyState.hidden = false;
    emptyState.textContent = message;
  };

  const loadPage = async (reset: boolean): Promise<void> => {
    if (loading || currentSnapshot() === null) return;
    if (!reset && !hasMore) return;
    loading = true;
    moreButton.disabled = true;
    try {
      const page = await invoke<HistoryPage>("history_page", {
        start: historyPageStart(commits.length, reset),
        oid: null,
      });
      // The session may have closed or moved on while this request ran.
      if (repoKey !== (currentSnapshot()?.branch?.oid ?? null)) return;
      commits = reset ? page.commits : commits.concat(page.commits);
      hasMore = page.hasMore;
      gutterColumns = graphColumns(commits);
      graphFolded = commits.some((commit) => commit.graph.folded);
      listPane.hidden = false;
      splitter.hidden = false;
      emptyState.hidden = true;
      countLabel.textContent =
        plural(commits.length, "commit") +
        (hasMore ? " so far." : " — all loaded.") +
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
    if (commits.length === 0) return;
    const rows = buildHistoryRows(commits);
    const fontPx = currentFontPx();
    const rowHeightNow = rowHeightPx(fontPx, HISTORY_ROW_REM);
    const viewport = listPane.clientHeight || 240;
    const slice = visibleWindow(rows.length, listPane.scrollTop, viewport, rowHeightNow, OVERSCAN);
    virtual.style.height = `${slice.totalHeight}px`;
    rowsHost.style.transform = `translateY(${slice.offsetY}px)`;
    const fragment = document.createDocumentFragment();
    for (let index = slice.startIndex; index < slice.endIndex; index++) {
      const commit = rows[index].commit;
      const element = el("div", {
        id: `commit-row-${index}`,
        class: `commit-row${index === selectedIndex ? " selected" : ""}`,
        role: "option",
        "aria-selected": String(index === selectedIndex),
        "aria-label": rowDescription(commit),
      }, [
        el("span", { class: "commit-subject", text: commit.subject, title: commit.subject }),
        // Author and date are two fields, not one sentence: a separator between
        // them welded them into a phrase and cost the reader the fact that
        // they could be scanned apart.
        el("span", { class: "commit-meta" }, [
          el("span", { text: commit.authorName }),
          el("span", { class: "commit-date", text: commit.authorDate.slice(0, 10) }),
        ]),
      ]);
      if (commit.refs.length > 0) {
        element.prepend(el("span", { class: "commit-refs" },
          commit.refs.map((ref) => el("span", { class: "commit-ref", text: ref }))));
      }
      // The graph leads the row, so it is prepended last: `prepend` puts the
      // element at the very front, and the gutter belongs left of the refs
      // chips and the subject.
      element.prepend(graphSvg(commit, rowHeightNow, fontPx));
      element.addEventListener("click", () => setSelected(commit, index));
      element.addEventListener("dblclick", () => void runCommitDiff());
      fragment.append(element);
    }
    rowsHost.replaceChildren(fragment);
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
  listPane.addEventListener("scroll", () => {
    if (commits.length > 0) renderRows();
  }, { passive: true });
  window.addEventListener("resize", () => {
    if (commits.length > 0) renderRows();
  });
  listPane.addEventListener("keydown", (event) => {
    if (commits.length === 0) return;
    const viewport = listPane.clientHeight || 240;
    let target = -2;
    switch (event.key) {
      case "ArrowDown": target = selectedIndex < 0 ? 0 : Math.min(selectedIndex + 1, commits.length - 1); break;
      case "ArrowUp": target = selectedIndex < 0 ? 0 : Math.max(selectedIndex - 1, 0); break;
      case "Home": target = 0; break;
      case "End": target = commits.length - 1; break;
      case "Enter":
        if (selectedIndex >= 0) setSelected(commits[selectedIndex], selectedIndex);
        event.preventDefault();
        return;
      default: return;
    }
    event.preventDefault();
    if (target < 0) return;
    listPane.scrollTop = revealScroll(listPane.scrollTop, viewport, target, rowHeight());
    setSelected(commits[target], target);
  });

  // --- lifecycle ---
  // The list is keyed by HEAD oid: a moved HEAD re-reads page zero, a
  // re-render of the same HEAD never touches Git.
  const sync = (): void => {
    const snapshot = currentSnapshot();
    const key = snapshot === null ? undefined : snapshot.branch?.oid ?? null;
    if (key === repoKey) {
      render();
      return;
    }
    repoKey = key;
    selected = null;
    selectedIndex = -1;
    detail.hidden = true;
    if (key === undefined) placeholder("Open a repository to browse its history.");
    else if (key === null) placeholder("No commits yet.");
    else void loadPage(true);
    render();
  };

  const render = (): void => {
    const locked = !isSessionActive();
    moreButton.disabled = locked || !hasMore || loading;
    renderActions();
    if (commits.length > 0) renderRows();
  };

  return { descriptor: { id: "history", element }, sync, render };
}
