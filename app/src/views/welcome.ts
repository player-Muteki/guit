// Welcome view: the no-repository state. It offers the repository picker and
// the recent list, and nothing else — guit opens repositories that already
// exist on disk.

import { open } from "@tauri-apps/plugin-dialog";
import { button, el } from "../dom";

export interface WelcomeDeps {
  openRepository(path: string): Promise<void>;
  onError(error: unknown): void;
}

export function createWelcomeView(deps: WelcomeDeps): { element: HTMLElement; renderRecents(paths: string[]): void } {
  const element = el("section", { class: "view-body welcome-view" });

  const headline = el("h2", { class: "welcome-headline", text: "guit" });
  const tagline = el("p", {
    class: "welcome-tagline",
    text: "A small Git client for local work. Files and diffs open in your own tools.",
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

  element.append(
    headline,
    tagline,
    status,
    el("div", { class: "welcome-actions" }, [openButton]),
    recentBlock,
  );

  async function pickRepository(): Promise<void> {
    try {
      const selected = await open({ directory: true, multiple: false });
      if (typeof selected === "string") await deps.openRepository(selected);
    } catch (error) {
      deps.onError(error);
    }
  }

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
