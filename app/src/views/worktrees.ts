// Worktrees & Submodules view: two independent lists under one header.
//
// Worktree rows are addressed by list position only; the backend re-reads
// `git worktree list --porcelain` and binds a single-use removal ticket to
// the entry's HEAD oid, so neither a path nor ref syntax typed by a client
// can reach Git. guit never forces a removal: a dirty or current worktree
// is refused by Git itself and reported verbatim. The add target comes from
// the branch/commit field; the new folder comes from an OS directory dialog.
//
// Submodule rows are addressed the same way: the backend re-reads the index
// (mode-160000 records are authoritative) and reports the recorded and
// checked-out commit for each gitlink. The list is read-only — initialising
// or updating a submodule would download objects, so guit shows the state it
// finds and leaves the download to the user's own `git` in a terminal.

import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { button, el, icon } from "../dom";
import {
  applySnapshot,
  currentSnapshot,
  isSessionActive,
  isWriteRunning,
  setStatus,
  setWriteRunning,
  snapshotVersion,
} from "../state";
import { SUBMODULE_STATE_LABELS } from "../types";
import type { OperationResult, SubmoduleView, WorktreeView } from "../types";
import type { PreviewController } from "../dialogs/preview";


export interface WorktreesDeps {
  preview: PreviewController;
  onError(error: unknown): void;
}

export interface WorktreesView {
  element: HTMLElement;
  sync(): void;
  render(): void;
}

export function createWorktreesView(deps: WorktreesDeps): WorktreesView {
  const element = el("section", { class: "view-body worktrees-view" });

  // --- worktrees ---
  const target = el("input", { class: "input", type: "text", placeholder: "Branch or commit id", "aria-label": "Worktree target" });
  const addButton = el("button", { class: "btn btn-primary", type: "button", text: "Add worktree…", title: "Choose a folder, then register a new linked worktree" });
  const pruneButton = el("button", { class: "btn", type: "button", text: "Prune stale", title: "Forget Git's records of worktree folders that no longer exist" });
  const worktreeTools = el("div", { class: "view-tools" }, [target, addButton, pruneButton]);
  const worktreeList = el("div", { class: "ref-list", role: "list", "aria-label": "Linked worktrees" });
  const worktreeStatus = el("span", { class: "view-status", role: "status" });
  const worktreeBlock = el("section", { class: "view-block" }, [
    el("h2", { class: "block-title" }, [icon("worktrees"), el("span", { text: "Worktrees" })]),
    worktreeTools,
    worktreeStatus,
    worktreeList,
  ]);

  // --- submodules ---
  const submoduleList = el("div", { class: "ref-list", role: "list", "aria-label": "Submodules" });
  const submoduleStatus = el("span", { class: "view-status", role: "status" });
  const submoduleBlock = el("section", { class: "view-block" }, [
    el("h2", { class: "block-title" }, [icon("branch"), el("span", { text: "Submodules" })]),
    submoduleStatus,
    submoduleList,
  ]);

  element.append(worktreeBlock, submoduleBlock);

  let worktrees: WorktreeView[] = [];
  let submodules: SubmoduleView[] = [];
  let worktreeSeq = 0;
  let submoduleSeq = 0;
  let syncedVersion = -1;

  // Add and prune are ordinary queued writes; the backend re-reads and the
  // returned snapshot refreshes the list.
  const runWorktreeWrite = async (
    command: "add_worktree" | "prune_worktrees",
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
      if (command === "add_worktree" && result.outcome === "success") target.value = "";
    } catch (error) {
      deps.onError(error);
      setStatus("The worktree operation did not run.", "error");
    } finally {
      setWriteRunning(false);
    }
  };

  const addWorktree = async (): Promise<void> => {
    if (currentSnapshot() === null || isWriteRunning()) return;
    const value = target.value.trim();
    if (value === "") {
      worktreeStatus.textContent = "Enter a local branch name or full commit id to check out.";
      return;
    }
    let selected: unknown;
    try {
      selected = await open({ directory: true, multiple: false });
    } catch (error) {
      deps.onError(error);
      worktreeStatus.textContent = "The folder chooser could not be opened.";
      return;
    }
    if (typeof selected !== "string") return; // dialog cancelled
    await runWorktreeWrite("add_worktree", { path: selected, target: value }, "Creating the linked worktree…");
  };

  const render = (): void => {
    const locked = !isSessionActive() || isWriteRunning();
    target.disabled = locked;
    addButton.disabled = locked;
    pruneButton.disabled = locked;
    if (worktrees.length === 0) {
      worktreeList.replaceChildren(el("div", { class: "file-row placeholder", text: "No worktrees." }));
    } else {
      worktreeList.replaceChildren(
        ...worktrees.map((entry) => {
          const notes: string[] = [];
          if (entry.branch) notes.push(entry.branch);
          if (entry.detached) notes.push("detached");
          if (entry.orphan) notes.push("orphan");
          if (entry.bare) notes.push("bare");
          if (entry.locked) notes.push("locked");
          if (entry.prunable) notes.push("stale");
          const element = el("div", { class: "file-row ref-row", role: "listitem" }, [
            el("span", { class: "file-status", text: `#${entry.index}` }),
            el("span", { class: "ref-name", text: entry.path, title: entry.path }),
            el("span", { class: "ref-meta", text: notes.join(" · ") }),
          ]);
          // Removal needs a stable HEAD oid and a round-trippable (UTF-8)
          // path; bare, orphan and non-addressable entries are read-only.
          if (!entry.bare && !entry.orphan && entry.addressable) {
            element.append(button("Remove…", () => void deps.preview.request("worktreeRemove", { index: entry.index }, null), {
              class: "row-action danger",
              disabled: isWriteRunning(),
              ariaLabel: `Remove worktree ${entry.index} after confirmation`,
            }));
          }
          return element;
        }),
      );
    }
    if (submodules.length === 0) {
      submoduleList.replaceChildren(el("div", { class: "file-row placeholder", text: "No submodules." }));
    } else {
      submoduleList.replaceChildren(
        ...submodules.map((entry) => {
          const notes: string[] = [SUBMODULE_STATE_LABELS[entry.state]];
          if (entry.name) notes.push(entry.name);
          const element = el("div", { class: "file-row ref-row", role: "listitem" }, [
            el("span", { class: "file-status", text: `#${entry.index}` }),
            el("span", { class: "ref-name", text: entry.path, title: entry.url ? `${entry.path} ← ${entry.url}` : entry.path }),
            el("span", { class: "ref-meta", text: notes.join(" · ") }),
          ]);
          return element;
        }),
      );
    }
  };

  const worktreePlaceholder = (message: string): void => {
    worktrees = [];
    worktreeStatus.textContent = "";
    worktreeList.replaceChildren(el("div", { class: "file-row placeholder", text: message }));
  };
  const submodulePlaceholder = (message: string): void => {
    submodules = [];
    submoduleStatus.textContent = "";
    submoduleList.replaceChildren(el("div", { class: "file-row placeholder", text: message }));
  };

  const loadWorktrees = async (): Promise<void> => {
    const seq = ++worktreeSeq;
    worktreeStatus.textContent = "Loading worktrees…";
    try {
      const result = await invoke<WorktreeView[]>("list_worktrees");
      if (seq !== worktreeSeq) return;
      worktrees = result;
      render();
      worktreeStatus.textContent = result.length === 0
        ? "No worktrees."
        : `${result.length} worktree ${result.length === 1 ? "entry" : "entries"}.`;
    } catch (error) {
      if (seq !== worktreeSeq) return;
      deps.onError(error);
      worktreePlaceholder("The worktree list could not be loaded.");
    }
  };

  const loadSubmodules = async (): Promise<void> => {
    const seq = ++submoduleSeq;
    submoduleStatus.textContent = "Loading submodules…";
    try {
      const result = await invoke<SubmoduleView[]>("submodule_status");
      if (seq !== submoduleSeq) return;
      submodules = result;
      render();
      submoduleStatus.textContent = result.length === 0
        ? "No submodules."
        : `${result.length} submodule ${result.length === 1 ? "entry" : "entries"}.`;
    } catch (error) {
      if (seq !== submoduleSeq) return;
      deps.onError(error);
      submodulePlaceholder("The submodule list could not be loaded.");
    }
  };

  const sync = (): void => {
    if (currentSnapshot() === null) {
      if (syncedVersion !== -1) {
        worktreePlaceholder("Open a repository to list its worktrees.");
        submodulePlaceholder("Open a repository to list its submodules.");
      }
      return;
    }
    if (snapshotVersion() === syncedVersion) {
      render();
      return;
    }
    syncedVersion = snapshotVersion();
    void loadWorktrees();
    void loadSubmodules();
  };

  addButton.addEventListener("click", () => void addWorktree());
  pruneButton.addEventListener("click", () => void runWorktreeWrite("prune_worktrees", {}, "Forgetting worktree folders that no longer exist…"));
  target.addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); void addWorktree(); }
  });

  return { element, sync, render };
}
