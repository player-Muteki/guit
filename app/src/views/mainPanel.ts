// The main panel: the changes area and the commit history of the current
// branch, on one page, visible together.
//
// It composes the two regions instead of owning any of their behaviour — the
// regions stay independently testable, and neither is a page of its own any
// more. A page for the files and a page for the graph would make the panel
// two tabs, and the panel is one: the point of the layout is that staging a
// file and reading the graph happen in the same glance.

import { el } from "../dom";
import type { ViewDescriptor } from "../shell";

export function createMainPanel(changes: HTMLElement, history: HTMLElement): ViewDescriptor {
  const element = el("section", { class: "main-panel" }, [changes, history]);
  return { id: "main", element };
}
