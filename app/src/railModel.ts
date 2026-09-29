// Pure view-model for the tab strip's accessible names, mirroring
// `fileModel.ts` so `node --test` can import it directly.
//
// A tab's `aria-label` is its stable name — it never changes with the
// repository state, so a screen reader does not re-announce every refresh —
// while `title` is the hover hint, and the hint's only extra job is to name
// the shortcut that reaches the page.
//
// Both tabs carry the same hint shape because both are always reachable:
// Main shows the repository entry when no repository is open, so there is no
// greyed-out tab left to explain.

import type { ViewId } from "./state";
import type { IconName } from "./dom";

export const VIEW_TITLES: Record<ViewId, string> = {
  main: "Main",
  settings: "Settings",
};

export const VIEW_ICONS: Record<ViewId, IconName> = {
  main: "main",
  settings: "settings",
};

const viewShortcut = (id: ViewId, order: readonly ViewId[]): string =>
  `Ctrl+${order.indexOf(id) + 1}`;

export function railHint(id: ViewId, order: readonly ViewId[]): string {
  return `${VIEW_TITLES[id]} (${viewShortcut(id, order)})`;
}
