// Pure view-model for the activity rail's accessible names, mirroring
// `fileModel.ts` so `node --test` can import it directly.
//
// The rail item's `aria-label` is its stable name (it never changes with the
// repository state, so a screen reader does not re-announce every refresh)
// while `title` is the hover hint, and the hint must tell the truth: after a
// repository is open, "open a repository first" is no longer what the user
// needs to do.

import type { ViewId } from "./state";
import type { IconName } from "./dom";

export const VIEW_TITLES: Record<ViewId, string> = {
  changes: "Changes",
  history: "History",
  branches: "Branches & Tags",
  stash: "Stash",
  remotes: "Remotes",
  worktrees: "Worktrees & Submodules",
  settings: "Settings",
};

export const VIEW_ICONS: Record<ViewId, IconName> = {
  changes: "changes",
  history: "history",
  branches: "branches",
  stash: "stash",
  remotes: "remotes",
  worktrees: "worktrees",
  settings: "settings",
};

export const viewShortcut = (id: ViewId, order: readonly ViewId[]): string =>
  `Ctrl+${order.indexOf(id) + 1}`;

// A greyed rail item is the honest signal that its view has nothing to show
// yet, so only the repository-scoped views carry the "open a repository" note.
export function railHint(id: ViewId, order: readonly ViewId[], sessionActive: boolean): string {
  const base = `${VIEW_TITLES[id]} (${viewShortcut(id, order)})`;
  return sessionActive || id === "settings" ? base : `${base} — open a repository first`;
}
