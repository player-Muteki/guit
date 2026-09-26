// One-line description of each view, shown under its title in the view head.

import type { ViewId } from "./state";

export const VIEW_HINTS: Record<ViewId, string> = {
  changes: "Staged, unstaged and untracked files; commit here",
  history: "Commits of the current branch",
  branches: "Local branches, remote branches and tags",
  stash: "Stashed snapshots",
  remotes: "Remotes and branch synchronisation",
  worktrees: "Linked worktrees and submodules",
  settings: "Appearance, tools, environment and diagnostics",
};
