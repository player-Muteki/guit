// Stash view: save a message, list entries, and act on them. Entries are
// addressed by list position only; the backend turns a position into the
// stash@{N} selector, so no ref syntax typed by a client can ever reach
// Git. Pop and drop ride the shared single-use ticket panel, bound to the
// entry's commit oid. Git's default stash covers tracked files only — the
// UI says so and untracked work stays put.

import { invoke } from "@tauri-apps/api/core";
import { el, icon, openMenu } from "../dom";
import { contextMatches, sessionContext } from "../snapshotBus";
import {
  applySnapshot,
  currentSnapshot,
  isSessionActive,
  isWriteRunning,
  setStatus,
  setWriteRunning,
} from "../state";
import type { OperationResult, ReadContext, SessionRead, StashEntry } from "../types";
import type { PreviewController } from "../dialogs/preview";

export interface StashDeps {
  preview: PreviewController;
  onError(error: unknown): void;
}

export interface StashView {
  element: HTMLElement;
  sync(): void;
  render(): void;
}

export function createStashView(deps: StashDeps): StashView {
  const element = el("section", { class: "view-body stash-view" });

  const message = el("input", {
    class: "input",
    type: "text",
    placeholder: "Stash message — blank uses Git's default WIP subject",
    "aria-label": "Stash message",
  });
  const saveButton = el("button", { class: "btn btn-primary", type: "button", text: "Stash changes" });
  const tools = el("div", { class: "view-tools" }, [message, saveButton]);
  const list = el("div", { class: "ref-list", role: "list", "aria-label": "Stashed changes" });
  const status = el("span", { class: "view-status", role: "status" });
  element.append(tools, status, list);

  let entries: StashEntry[] = [];
  let requestSeq = 0;
  let syncedVersion = -1;
  // The stash list is not one of the two counted domains, so its read is bound
  // to the session alone. Nothing about a refresh tells this list apart from
  // the last one, so the view keeps re-asking per version and lets only the
  // session number decide whether an answer still has a view to belong to.
  let askedContext: ReadContext | null = null;

  // Save and apply are ordinary queued writes (apply keeps the entry), so
  // they ride the shared write lane; the backend re-reads and the returned
  // snapshot refreshes the list.
  const runWrite = async (
    command: "stash_save" | "stash_apply",
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
      if (command === "stash_save" && result.outcome === "success") message.value = "";
    } catch (error) {
      deps.onError(error);
      setStatus("The stash operation did not run.", "error");
    } finally {
      setWriteRunning(false);
    }
  };

  const render = (): void => {
    const locked = !isSessionActive() || isWriteRunning();
    message.disabled = locked;
    saveButton.disabled = locked;
    if (entries.length === 0) {
      list.replaceChildren(el("div", { class: "file-row placeholder", text: "No stash entries." }));
      return;
    }
    const rows = entries.map((entry) => {
      const element = el("div", { class: "file-row ref-row", role: "listitem" }, [
        el("span", { class: "file-status", text: `#${entry.index}` }),
        el("span", { class: "ref-name", text: entry.subject, title: entry.subject }),
        el("span", { class: "ref-meta", text: entry.date.slice(0, 10) }),
      ]);
      const more = el("button", { class: "row-more", type: "button", "aria-label": `More actions for stash ${entry.index}` }, [icon("more", 14)]);
      more.disabled = isWriteRunning();
      more.addEventListener("click", (event) => {
        event.stopPropagation();
        openMenu(more, [
          { label: "Apply", run: () => void runWrite("stash_apply", { index: entry.index }, `Applying stash #${entry.index}…`) },
          { label: "Pop…", run: () => void deps.preview.request("stashPop", { index: entry.index }, null) },
          { label: "Delete…", run: () => void deps.preview.request("stashDrop", { index: entry.index }, null), danger: true },
        ]);
      });
      element.append(more);
      return element;
    });
    list.replaceChildren(...rows);
  };

  const placeholder = (message: string): void => {
    entries = [];
    status.textContent = "";
    list.replaceChildren(el("div", { class: "file-row placeholder", text: message }));
  };

  const load = async (asked: ReadContext): Promise<void> => {
    const seq = ++requestSeq;
    status.textContent = "Loading stashes…";
    try {
      const read = await invoke<SessionRead<StashEntry[]>>("stash_list", { context: asked });
      if (seq !== requestSeq) return;
      if (askedContext === null || !contextMatches(asked, askedContext)) return;
      if (!contextMatches(asked, read.context)) return;
      const result = read.value;
      entries = result;
      render();
      status.textContent = result.length === 0
        ? "No stash entries."
        : `${result.length} stash ${result.length === 1 ? "entry" : "entries"}.`;
    } catch (error) {
      if (seq !== requestSeq) return;
      if (askedContext === null || !contextMatches(asked, askedContext)) return;
      deps.onError(error);
      placeholder("The stash list could not be loaded.");
    }
  };

  // Driven from renderSnapshot: every newly accepted snapshot version
  // re-reads the stash list once; a re-render of the same version never
  // touches Git.
  const sync = (): void => {
    const snapshot = currentSnapshot();
    if (snapshot === null) {
      if (askedContext !== null) placeholder("Open a repository to list its stashes.");
      askedContext = null;
      syncedVersion = -1;
      return;
    }
    if (snapshot.version === syncedVersion) return;
    syncedVersion = snapshot.version;
    askedContext = sessionContext(snapshot);
    void load(askedContext);
  };

  saveButton.addEventListener("click", () => {
    void runWrite("stash_save", { message: message.value }, "Stashing tracked changes… untracked files stay in place.");
  });
  message.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void runWrite("stash_save", { message: message.value }, "Stashing tracked changes… untracked files stay in place.");
    }
  });

  return { element, sync, render };
}
