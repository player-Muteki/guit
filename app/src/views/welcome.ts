// Welcome view: the no-repository state. Offers Open, Clone and the recent
// repository list. The clone form streams `clone-progress`, can be
// cancelled, and never removes a failed run's residue — the user decides.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { button, el, icon } from "../dom";
import { setActiveView, setStatus } from "../state";
import type { CloneResult } from "../types";

export interface WelcomeDeps {
  openRepository(path: string): Promise<void>;
  onError(error: unknown): void;
}

export function createWelcomeView(deps: WelcomeDeps): { element: HTMLElement; renderRecents(paths: string[]): void } {
  const element = el("section", { class: "view-body welcome-view" });

  const headline = el("h2", { class: "welcome-headline", text: "guit" });
  const tagline = el("p", {
    class: "welcome-tagline",
    text: "A low-resource Git client. Files and diffs open in your own tools.",
  });
  // The no-repository instruction, and the one string the AT-SPI harness has
  // matched since 0.1.0 to recognise the empty state: keep it verbatim.
  const status = el("p", {
    class: "welcome-status",
    text: "Open a repository to list its working copy status.",
  });
  const openButton = button("Open repository…", () => void pickRepository(), { class: "btn btn-primary" });

  const recentList = el("ul", { class: "recent-list", "aria-label": "Recent repositories" });
  const recentBlock = el("div", { class: "welcome-block" }, [
    el("h3", { class: "welcome-label", text: "Recent" }),
    recentList,
  ]);

  const cloneSource = el("input", {
    class: "input",
    type: "text",
    placeholder: "Repository URL or local path",
    "aria-label": "Repository to clone",
  });
  const clonePickDir = el("button", { class: "btn", type: "button", text: "Into folder…" });
  const cloneStart = el("button", { class: "btn btn-primary", type: "button", text: "Clone", disabled: true });
  const cloneCancel = el("button", { class: "btn", type: "button", text: "Cancel clone", disabled: true });
  const cloneStatus = el("p", { class: "welcome-clone-status", role: "status", text: "Choose a destination folder to clone a repository." });
  const cloneBlock = el("div", { class: "welcome-block" }, [
    el("h3", { class: "welcome-label" }, [icon("clone"), el("span", { text: "Clone" })]),
    el("div", { class: "clone-row" }, [cloneSource, clonePickDir, cloneStart, cloneCancel]),
    cloneStatus,
  ]);

  element.append(
    headline,
    tagline,
    status,
    el("div", { class: "welcome-actions" }, [openButton]),
    recentBlock,
    cloneBlock,
  );

  let cloneParent: string | undefined;

  async function pickRepository(): Promise<void> {
    try {
      const selected = await open({ directory: true, multiple: false });
      if (typeof selected === "string") await deps.openRepository(selected);
    } catch (error) {
      deps.onError(error);
    }
  }

  clonePickDir.addEventListener("click", async () => {
    try {
      const selected = await open({ directory: true, multiple: false });
      if (typeof selected === "string") {
        cloneParent = selected;
        cloneStart.disabled = cloneSource.value.trim() === "";
        cloneStatus.textContent = `Destination: ${selected}`;
      }
    } catch (error) {
      deps.onError(error);
    }
  });
  cloneSource.addEventListener("input", () => {
    cloneStart.disabled = cloneParent === undefined || cloneSource.value.trim() === "";
  });
  cloneCancel.addEventListener("click", async () => {
    try {
      await invoke("cancel_clone");
      cloneStatus.textContent = "Cancellation requested; stopping Git…";
    } catch (error) {
      deps.onError(error);
    }
  });
  cloneStart.addEventListener("click", async () => {
    if (cloneParent === undefined) return;
    const source = cloneSource.value.trim();
    cloneStart.disabled = true;
    clonePickDir.disabled = true;
    cloneSource.disabled = true;
    cloneCancel.disabled = false;
    cloneStatus.textContent = "Cloning…";
    let unlisten: (() => void) | undefined;
    try {
      unlisten = await listen<string>("clone-progress", ({ payload }) => {
        cloneStatus.textContent = payload;
      });
      const result = await invoke<CloneResult>("clone_repository", { source, parent: cloneParent });
      if (result.success) {
        cloneStatus.textContent = `${result.message} Opening ${result.target}…`;
        await deps.openRepository(result.target);
        setActiveView("changes");
      } else {
        cloneStatus.textContent = result.suggestion ? `${result.message} ${result.suggestion}` : result.message;
        if (result.residue) {
          // guit never deletes anything: the user decides what to do with it.
          deps.onError(
            result.cancelled
              ? `The cancelled clone left a partial folder at ${result.residue}. guit will not remove it automatically.`
              : `The failed clone left a folder at ${result.residue}. guit will not remove it automatically.`,
          );
        }
      }
      cloneSource.value = "";
      setStatus("");
    } catch (error) {
      deps.onError(error);
      cloneStatus.textContent = "Clone failed.";
      setStatus("Clone failed.", "error");
    } finally {
      unlisten?.();
      clonePickDir.disabled = false;
      cloneSource.disabled = false;
      cloneCancel.disabled = true;
      cloneStart.disabled = cloneSource.value.trim() === "";
    }
  });

  const renderRecents = (paths: string[]): void => {
    recentBlock.hidden = paths.length === 0;
    if (paths.length === 0) {
      recentList.replaceChildren();
      return;
    }
    recentList.replaceChildren(
      ...paths.map((path) => {
        const item = el("li");
        item.append(
          button(path, () => void deps.openRepository(path), {
            class: "recent-entry",
            title: path,
            ariaLabel: `Open ${path}`,
          }),
        );
        return item;
      }),
    );
  };

  return { element, renderRecents };
}
