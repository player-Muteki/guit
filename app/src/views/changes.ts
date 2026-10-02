// Changes view: the operation banner, the four collapsed file groups
// (conflicts / staged / worktree / untracked) on the shared virtual list, and
// the fixed commit footer. Row actions follow one density rule: Stage and
// Unstage stay visible because they are the everyday verbs; Open, Diff,
// Diff staged, Resolve, Discard and Delete live in a per-row `⋯` menu. Group
// headings keep the batch actions (Stage all / Unstage all / Discard all /
// Clean…) because they act on a whole group, not one row.

import { invoke } from "@tauri-apps/api/core";
import {
  buildRows,
  cleanEligible,
  discardEligible,
  listRowRole,
  nextSelectableRow,
  revealScroll,
  rowHeightPx,
  visibleWindow,
  FILE_ROW_REM,
  type FileGroupKey,
  type FileView,
  type ListRow,
} from "../fileModel";
import {
  advancesWithClock,
  chooseInterval,
  describeActivity,
  readStoredInterval,
  type IntervalApplied,
} from "../activityModel";
import { button, el, icon, openMenu, plural } from "../dom";
import { currentFontPx } from "../font";
import { onDispose } from "../lifecycle";
import {
  applySnapshot,
  currentActivity,
  currentSnapshot,
  isSessionActive,
  isToolRunning,
  isWriteRunning,
  pendingPreview,
  setStatus,
  setToolRunning,
  setWriteRunning,
} from "../state";
import type { OperationResult, ToolPurpose, ToolResult } from "../types";
import type { PreviewController } from "../dialogs/preview";

// A fixed-height virtual list must assume exactly the height the stylesheet
// gives a row, so the assumption follows interface zoom (`--row-height` in
// style/tokens.css is `FILE_ROW_REM` rem of the same root font size).
const rowHeight = (): number => rowHeightPx(currentFontPx(), FILE_ROW_REM);
const OVERSCAN = 6;

export interface ChangesDeps {
  preview: PreviewController;
  onError(error: unknown): void;
}

// The changed files arrive inside every snapshot, so this view never asks Git
// for them a second time: it has one job on a repaint and nothing to let go of
// except the watcher that re-measures its rows and the one interval that keeps
// the age line honest.
export interface ChangesView {
  element: HTMLElement;
  activityElement: HTMLElement;
  render(): void;
  renderActivity(): void;
  /** The period the age line is currently being recomputed on. */
  currentInterval(): number;
  /** Re-arm that one timer on a new period, and remember it. */
  applyInterval(requested: string | number): IntervalApplied;
}

// How often the age text is re-derived from the number the backend sent. The
// panel holds exactly one such timer, in this file; see `activityModel.ts` for
// why it is a display preference and not a Git cadence.
const ACTIVITY_INTERVAL_KEY = "guit.activityInterval";

export function createChangesView(deps: ChangesDeps): ChangesView {
  const element = el("section", { class: "view-body changes-view" });

  // --- activity line ---
  // Built here and never added later: the main panel measures what this region
  // has to keep showing, and a row that appears after that measurement is one
  // row the region's floor does not know about. Only its text and its `hidden`
  // attribute change after this point.
  const activityLine = el("p", { class: "activity-line", hidden: true });

  // --- operation banner ---
  const operationSummary = el("p", { class: "banner-summary" });
  const operationContinue = el("button", { class: "btn", type: "button", text: "Continue" });
  const operationSkip = el("button", { class: "btn", type: "button", text: "Skip" });
  const operationAbort = el("button", { class: "btn btn-danger", type: "button", text: "Abort" });
  const operationBanner = el("div", { class: "banner", role: "alert", hidden: true }, [
    operationSummary,
    el("div", { class: "banner-actions" }, [operationContinue, operationSkip, operationAbort]),
  ]);

  // --- file list ---
  const fileRowsHost = el("div", { class: "virtual-rows" });
  const fileVirtual = el("div", { class: "virtual" }, [fileRowsHost]);
  const fileList = el("div", {
    class: "file-list",
    role: "tree",
    "aria-label": "Changed files",
    tabIndex: 0,
  }, [fileVirtual]);
  const emptyState = el("p", { class: "empty-state", hidden: true });

  // --- commit footer ---
  const commitMessage = el("textarea", {
    id: "commit-message",
    class: "commit-input",
    rows: 2,
    placeholder: "Commit message — Ctrl+Enter commits",
    "aria-label": "Commit message",
  });
  const commitAmend = el("input", { id: "commit-amend", type: "checkbox" });
  const commitButton = el("button", { class: "btn btn-primary", id: "commit-button", type: "button", text: "Commit" });
  // The clean restore is asked about a commit the panel has never read: whatever
  // the user types is handed to Git, which decides whether it names one. The field
  // is therefore not a picker over the graph below it, and an abbreviation is not
  // expanded here — only Git resolves an id, and what comes back is the id it
  // resolved, never the text.
  const resetTarget = el("input", {
    id: "reset-target",
    class: "reset-input",
    type: "text",
    spellcheck: false,
    placeholder: "Commit to restore to — full id or a unique abbreviation",
    "aria-label": "Commit to restore to",
  });
  const resetButton = el("button", {
    class: "btn btn-danger",
    id: "reset-button",
    type: "button",
    text: "Reset to clean state…",
  });
  const commitFooter = el("div", { class: "commit-footer" }, [
    commitMessage,
    el("div", { class: "commit-actions" }, [
      el("label", { class: "checkbox" }, [commitAmend, el("span", { text: "Amend" })]),
      el("div", { class: "spacer" }),
      commitButton,
    ]),
    el("div", { class: "reset-row" }, [resetTarget, resetButton]),
  ]);

  element.append(operationBanner, fileList, emptyState, commitFooter);

  let listRows: ListRow[] = [];
  let currentFiles: FileView[] = [];
  const collapsedGroups = new Set<FileGroupKey>();
  let selectedRow = -1;
  let selectedFileId: number | null = null;
  // The session the commit draft on screen was written for. `null` is also the
  // value of "no repository open", so a closed session clears the draft just
  // like switching to another repository does.
  let draftSession: number | null = null;

  // --- helpers ---
  const syncSelection = (): void => {
    if (selectedFileId === null) {
      selectedRow = -1;
      return;
    }
    selectedRow = listRows.findIndex((row) => row.kind === "file" && row.file.id === selectedFileId);
    if (selectedRow < 0) selectedFileId = null;
  };

  // Fixed-height virtual list: only the rows intersecting the viewport (plus
  // overscan) exist in the DOM, so a repository with tens of thousands of
  // changed files costs the same as one with dozens.
  const renderFileRows = (): void => {
    const viewport = fileList.clientHeight || 320;
    const slice = visibleWindow(listRows.length, fileList.scrollTop, viewport, rowHeight(), OVERSCAN);
    fileVirtual.style.height = `${slice.totalHeight}px`;
    fileRowsHost.style.transform = `translateY(${slice.offsetY}px)`;
    const fragment = document.createDocumentFragment();
    for (let index = slice.startIndex; index < slice.endIndex; index++) {
      fragment.append(createRow(listRows[index], index));
    }
    fileRowsHost.replaceChildren(fragment);
    if (selectedRow >= slice.startIndex && selectedRow < slice.endIndex) {
      fileList.setAttribute("aria-activedescendant", `file-row-${selectedRow}`);
    } else {
      fileList.removeAttribute("aria-activedescendant");
    }
  };

  const fileRowAction = (file: FileView): "stage" | "unstage" | null => {
    if (file.group === "conflict") return null;
    return file.group === "staged" ? "unstage" : "stage";
  };

  const runWrite = async (command: "stage_files" | "unstage_files", fileIds: number[]): Promise<void> => {
    const snapshot = currentSnapshot();
    if (snapshot === null || isWriteRunning()) return;
    setWriteRunning(true);
    setStatus(`${command === "stage_files" ? "Staging" : "Unstaging"} ${plural(fileIds.length, "file")}…`, "progress");
    try {
      const result = await invoke<OperationResult>(command, {
        snapshotVersion: snapshot.version,
        fileIds,
      });
      applySnapshot(result.snapshot);
      setStatus(result.details ? `${result.message} ${result.details}` : result.message, result.outcome === "success" ? "success" : "error");
    } catch (error) {
      deps.onError(error);
      setStatus("The write did not run.", "error");
    } finally {
      setWriteRunning(false);
    }
  };

  const runTool = async (purpose: ToolPurpose, fileId: number): Promise<void> => {
    const snapshot = currentSnapshot();
    if (snapshot === null || isToolRunning()) return;
    setToolRunning(true);
    setStatus(
      purpose === "openFile"
        ? "Opening file…"
        : purpose === "mergeFile"
          ? "Waiting for the merge tool to close…"
          : "Waiting for the diff tool to close…",
      "progress",
    );
    try {
      const result = await invoke<ToolResult>("open_external_tool", {
        snapshotVersion: snapshot.version,
        fileId,
        purpose,
      });
      applySnapshot(result.snapshot);
      setStatus(result.details ? `${result.message} ${result.details}` : result.message, result.outcome === "success" ? "success" : "error");
    } catch (error) {
      deps.onError(error);
      setStatus("The external tool did not run.", "error");
    } finally {
      setToolRunning(false);
    }
  };

  const requestDiscard = (fileIds: number[]): void => {
    void deps.preview.request("discard", { fileIds }, currentFiles);
  };

  // A clean comes in two shapes. The group heading asks for everything
  // untracked, which is what an empty file-id list binds; a row asks for that
  // one path. Either way the live file list travels along, because a scoped
  // ticket is renewed by turning its names back into file ids, and those only
  // live in the snapshot that produced them.
  const requestClean = (fileIds: number[]): void => {
    void deps.preview.request("clean", { fileIds }, currentFiles);
  };

  // The restore is the one write in this area asked about a commit rather than
  // about the rows on screen, so it hands the preview nothing but the text — and no
  // live file list, because its ticket is renewed by that text and not by names.
  // Whether the text names one commit is Git's decision, never this view's.
  const requestRestore = (): void => {
    void deps.preview.request("restore", { target: resetTarget.value }, null);
  };

  const runOperationStep = async (
    command: "operation_continue" | "operation_abort" | "operation_skip",
    running: string,
  ): Promise<void> => {
    const snapshot = currentSnapshot();
    if (snapshot === null || isWriteRunning() || pendingPreview() !== null) return;
    setWriteRunning(true);
    setStatus(running, "progress");
    try {
      const result = await invoke<OperationResult>(command, { snapshotVersion: snapshot.version });
      applySnapshot(result.snapshot);
      setStatus(result.details ? `${result.message} ${result.details}` : result.message, result.outcome === "success" ? "success" : "error");
    } catch (error) {
      deps.onError(error);
      setStatus("The operation step did not run.", "error");
    } finally {
      setWriteRunning(false);
    }
  };

  // On failure, cancellation or rejection the textarea keeps its content:
  // the user's message is input they own, and guit never swallows it.
  const commitNow = async (): Promise<void> => {
    const snapshot = currentSnapshot();
    if (snapshot === null || isWriteRunning()) return;
    const message = commitMessage.value;
    const amend = commitAmend.checked;
    setWriteRunning(true);
    setStatus(amend ? "Amending the last commit…" : "Committing…", "progress");
    try {
      const result = await invoke<OperationResult>("commit_changes", {
        snapshotVersion: snapshot.version,
        message,
        amend,
      });
      applySnapshot(result.snapshot);
      setStatus(result.details ? `${result.message} ${result.details}` : result.message, result.outcome === "success" ? "success" : "error");
      if (result.outcome === "success") {
        commitMessage.value = "";
        commitAmend.checked = false;
      }
    } catch (error) {
      deps.onError(error);
      setStatus("The commit did not run.", "error");
    } finally {
      setWriteRunning(false);
    }
  };

  // --- row rendering ---
  const createRow = (row: ListRow, index: number): HTMLElement => {
    const rowElement = el("div", { id: `file-row-${index}`, role: listRowRole(row.kind) });
    if (row.kind === "heading") {
      rowElement.className = "file-row group-heading";
      const chevron = el("span", { class: "chevron", text: row.collapsed ? "▸" : "▾" });
      const label = el("span", { class: "group-label", text: `${row.label} (${row.count})` });
      rowElement.append(chevron, label);
      rowElement.addEventListener("click", () => toggleGroup(row.group));
      const batchAction: "stage" | "unstage" | null =
        row.group === "conflict" ? null : row.group === "staged" ? "unstage" : "stage";
      if (batchAction) {
        rowElement.append(
          button(batchAction === "stage" ? "Stage all" : "Unstage all", () => {
            // IDs come from the live snapshot; the backend rejects the whole
            // batch if any one of them has gone stale.
            const ids = currentFiles.filter((file) => file.group === row.group).map((file) => file.id);
            if (ids.length > 0) void runWrite(batchAction === "stage" ? "stage_files" : "unstage_files", ids);
          }, { class: "row-action", disabled: isWriteRunning() }),
        );
      }
      if (row.group === "worktree") {
        rowElement.append(
          button("Discard all", () => {
            const ids = currentFiles
              .filter((file) => file.group === "worktree" && discardEligible(file))
              .map((file) => file.id);
            if (ids.length > 0) requestDiscard(ids);
          }, { class: "row-action danger", disabled: isWriteRunning() || pendingPreview() !== null }),
        );
      }
      if (row.group === "untracked") {
        rowElement.append(
          button("Clean…", () => requestClean([]), {
            class: "row-action danger",
            title: "Delete untracked files after confirmation",
            disabled: isWriteRunning() || pendingPreview() !== null,
          }),
        );
      }
      return rowElement;
    }
    const selected = index === selectedRow;
    rowElement.className = `file-row${selected ? " selected" : ""}`;
    rowElement.setAttribute("aria-selected", String(selected));
    const file = row.file;
    const name = file.renameFrom ? `${file.renameFrom} → ${file.display}` : file.display;
    rowElement.title = name;
    // Signature element: the 2px status rail rides the row (left edge), and
    // the two-letter code beside it carries the same meaning without colour.
    rowElement.classList.add(`status-${groupTone(file.group)}`);
    const status = el("span", { class: "file-status", text: `${file.indexStatus}${file.worktreeStatus}` });
    const label = el("span", { class: "file-name", text: name });
    rowElement.append(status, label);
    const action = fileRowAction(file);
    if (action) {
      rowElement.append(
        button(action === "stage" ? "Stage" : "Unstage", () =>
          void runWrite(action === "stage" ? "stage_files" : "unstage_files", [file.id]), {
            class: "row-action",
            ariaLabel: `${action === "stage" ? "Stage" : "Unstage"} ${file.display}`,
            disabled: isWriteRunning(),
          }),
      );
    }
    // Untracked files have no HEAD-side counterpart, so difftool skips them;
    // the staged side only exists once the file is in the index.
    const menuItems: Array<{ label: string; run: () => void; danger?: boolean }> = [
      { label: "Open", run: () => void runTool("openFile", file.id) },
    ];
    if (!file.untracked) menuItems.push({ label: "Diff", run: () => void runTool("diffWorktree", file.id) });
    if (file.staged) menuItems.push({ label: "Diff staged", run: () => void runTool("diffStaged", file.id) });
    if (file.conflict) menuItems.push({ label: "Resolve", run: () => void runTool("mergeFile", file.id) });
    if (discardEligible(file)) {
      menuItems.push({ label: "Discard", run: () => requestDiscard([file.id]), danger: true });
    }
    // An untracked file has nothing to revert to, so its removal verb is the
    // scoped clean: the ticket binds this one path, and Git answers whether it
    // owns it at all.
    if (cleanEligible(file)) {
      menuItems.push({ label: "Delete", run: () => requestClean([file.id]), danger: true });
    }
    const more = el("button", {
      class: "row-more",
      type: "button",
      "aria-label": `More actions for ${file.display}`,
    }, [icon("more", 14)]);
    more.disabled = isToolRunning();
    more.addEventListener("click", (event) => {
      event.stopPropagation();
      openMenu(more, menuItems);
    });
    rowElement.append(more);
    return rowElement;
  };

  const groupTone = (group: FileGroupKey): string => {
    switch (group) {
      case "conflict": return "conflict";
      case "staged": return "staged";
      case "worktree": return "worktree";
      case "untracked": return "untracked";
    }
  };

  const toggleGroup = (group: FileGroupKey): void => {
    if (collapsedGroups.has(group)) collapsedGroups.delete(group);
    else collapsedGroups.add(group);
    listRows = buildRows(currentFiles, collapsedGroups);
    syncSelection();
    renderFileRows();
  };

  // --- rendering ---
  const renderFiles = (files: FileView[]): void => {    currentFiles = files;
    if (files.length === 0) {
      listRows = [];
      selectedRow = -1;
      selectedFileId = null;
      fileVirtual.style.height = "0px";
      fileRowsHost.style.transform = "translateY(0px)";
      fileRowsHost.replaceChildren();
      emptyState.hidden = false;
      // The shell hides every view while no repository is open and shows the
      // welcome view instead, so an empty list here can only mean a clean
      // working copy. The no-repository wording lives in `views/welcome.ts`.
      emptyState.textContent = "Working copy is clean.";
      return;
    }
    emptyState.hidden = true;
    listRows = buildRows(files, collapsedGroups);
    syncSelection();
    renderFileRows();
  };

  const renderOperationBanner = (): void => {
    const operation = currentSnapshot()?.operation ?? null;
    operationBanner.hidden = operation === null;
    if (!operation) return;
    const step =
      operation.step !== null && operation.total !== null
        ? ` (step ${operation.step} of ${operation.total})`
        : "";
    operationSummary.textContent = `${operation.subject}${step}`;
    const skipAvailable =
      operation.kind === "rebase" || operation.kind === "cherryPick" || operation.kind === "revert";
    const known = operation.kind !== "unknown";
    operationContinue.hidden = !known;
    operationAbort.hidden = !known;
    operationSkip.hidden = !known || !skipAvailable;
    const disabled = isWriteRunning() || pendingPreview() !== null;
    operationContinue.disabled = disabled;
    operationSkip.disabled = disabled;
    operationAbort.disabled = disabled;
  };

  // The age line answers to two things only: a push on the activity channel, and
  // the clock. It is never a third consumer of the snapshot — a refresh whose
  // files did not move still has to leave the list and the graph alone.
  //
  // Hidden while no repository is open, which also takes it out of the main
  // panel's measurement of what this region has to show: a part with no height
  // claims neither room nor a gap beside it.
  let activityText = "";
  const renderActivity = (): void => {
    const active = isSessionActive();
    activityLine.hidden = !active;
    if (!active) return;
    const display = describeActivity(currentActivity(), Date.now());
    if (display.text !== activityText) {
      activityText = display.text;
      activityLine.textContent = display.text;
    }
    const file = display.kind === "age" ? display.file : null;
    if (file === null) activityLine.removeAttribute("title");
    else activityLine.title = `${activityText} — ${file}`;
  };

  const render = (): void => {
    const snapshot = currentSnapshot();
    // A draft belongs to the repository it was typed in. A refresh never
    // touches it, and a refresh is exactly what never moves `sessionId`; a
    // session that changed is a different repository, and a box still holding
    // the previous one's half-written message would submit that message to it.
    const sessionId = snapshot?.sessionId ?? null;
    if (sessionId !== draftSession) {
      draftSession = sessionId;
      commitMessage.value = "";
      commitAmend.checked = false;
      // A target typed for one repository is a commit in that repository, and the
      // id means something else — or nothing — in the next one.
      resetTarget.value = "";
    }
    const locked = snapshot === null || isWriteRunning();
    commitMessage.disabled = locked;
    commitAmend.disabled = locked;
    commitButton.disabled = locked;
    // A dialog that is already open holds the one confirmation this button asks
    // for; a second click cannot ask for a second one.
    resetTarget.disabled = locked;
    resetButton.disabled = locked || pendingPreview() !== null;
    renderOperationBanner();
    renderFiles(snapshot?.files ?? []);
    renderActivity();
  };

  // --- events ---
  operationContinue.addEventListener("click", () => void runOperationStep("operation_continue", "Continuing the operation…"));
  operationSkip.addEventListener("click", () => void runOperationStep("operation_skip", "Skipping the current step…"));
  operationAbort.addEventListener("click", () => void runOperationStep("operation_abort", "Aborting the operation…"));
  commitButton.addEventListener("click", () => void commitNow());
  resetButton.addEventListener("click", requestRestore);
  // Enter asks for the preview, which is the only thing Enter can honestly do
  // here: the confirmation it opens is a separate press, and a restore that ran
  // straight from a keystroke would be a write with nothing in front of it.
  resetTarget.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      requestRestore();
    }
  });
  commitMessage.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      void commitNow();
    }
  });
  fileList.addEventListener("scroll", () => {
    if (listRows.length > 0) renderFileRows();
  }, { passive: true });
  // The window is not the only thing that resizes a list any more: the split
  // between this region and the history moves whenever the user drags it, and
  // the rows on screen have to be re-measured for the height they now have.
  // Watching the scroller itself covers every cause — a drag, a zoom, a
  // narrower window — without this view knowing about any of them.
  const listWatcher = new ResizeObserver(() => {
    if (listRows.length > 0) renderFileRows();
  });
  listWatcher.observe(fileList);
  onDispose(() => listWatcher.disconnect());
  // Keyboard navigation over the virtual list: arrows move between files
  // (headings skipped), Home/End jump, Enter toggles the selected file's group.
  fileList.addEventListener("keydown", (event) => {
    if (listRows.length === 0) return;
    if ((event.target as HTMLElement).closest(".row-action, .row-more")) return;
    const viewport = fileList.clientHeight || 320;
    const edge = (delta: number) => nextSelectableRow(listRows, delta > 0 ? -1 : listRows.length, delta);
    let target = -2;
    switch (event.key) {
      case "ArrowDown": target = selectedRow < 0 ? edge(1) : nextSelectableRow(listRows, selectedRow, 1); break;
      case "ArrowUp": target = selectedRow < 0 ? edge(-1) : nextSelectableRow(listRows, selectedRow, -1); break;
      case "Home": target = edge(1); break;
      case "End": target = edge(-1); break;
      case "Enter": {
        const row = listRows[selectedRow];
        if (row && row.kind === "file") toggleGroup(row.file.group);
        event.preventDefault();
        return;
      }
      default: return;
    }
    event.preventDefault();
    if (target < 0 || target === selectedRow) return;
    const row = listRows[target];
    selectedRow = target;
    selectedFileId = row.kind === "file" ? row.file.id : null;
    fileList.scrollTop = revealScroll(fileList.scrollTop, viewport, target, rowHeight());
    renderFileRows();
  });

  // The panel's only recurring timer, and the only place its period is decided.
  // It recomputes one line of text from a number the backend already sent, so it
  // never reads Git, never re-renders the list and never touches the graph.
  //
  // Registered beside the thing it lets go of: the panel outlives every repository
  // it shows, and a timer left running after the window closes would be a promise
  // about a window that no longer exists. A *changed* period is the same case one
  // step earlier — the old timer is cleared in the statement that arms the new one,
  // because turning a knob twice must not leave two timers recounting one sentence.
  let stored: string | null;
  try {
    stored = localStorage.getItem(ACTIVITY_INTERVAL_KEY);
  } catch {
    // Storage may be unavailable in private mode; the age line still counts.
    stored = null;
  }
  let intervalSeconds = readStoredInterval(stored);
  // A state whose wording contains no time is skipped rather than recomputed: the
  // tick has nothing new to say about it, and saying it anyway would be a repaint
  // with no reason. A push always repaints the line, because that is what changes
  // which state it is.
  const ageLineNeedsTheClock = (): void => {
    if (advancesWithClock(currentActivity())) renderActivity();
  };
  let activityTick = setInterval(ageLineNeedsTheClock, intervalSeconds * 1000);
  onDispose(() => clearInterval(activityTick));

  // The whole effect of the Settings row. Two things are deliberately absent here:
  // a Git read, and a repaint of anything but this line. The backend keeps
  // measuring the working tree on its own schedule, so sixty seconds of text
  // interval never means sixty seconds of staleness, and one second never buys
  // one read per second. `persisted` is false only when something is owed to
  // storage that storage did not take; a refused request owes nothing.
  const applyInterval = (requested: string | number): IntervalApplied => {
    const choice = chooseInterval(requested, intervalSeconds);
    if (choice.refused) return { ...choice, persisted: true };
    let persisted = true;
    try {
      localStorage.setItem(ACTIVITY_INTERVAL_KEY, String(choice.seconds));
    } catch {
      // The period still applies for this session; it just will not be there next
      // start, and the row says so instead of implying it was kept.
      persisted = false;
    }
    if (!choice.changed) return { ...choice, persisted };
    clearInterval(activityTick);
    intervalSeconds = choice.seconds;
    activityTick = setInterval(ageLineNeedsTheClock, intervalSeconds * 1000);
    // The line in front of the person is the thing the period changed, so it is
    // redrawn now rather than at the end of a wait they did not choose.
    renderActivity();
    return { ...choice, persisted };
  };

  return { element, activityElement: activityLine, render, renderActivity, currentInterval: () => intervalSeconds, applyInterval };
}
