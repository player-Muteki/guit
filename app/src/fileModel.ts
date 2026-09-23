// Pure view-model for the change list. Keep this module free of DOM and of
// non-erasable TypeScript so `node --test` can import it directly.

export type FileGroupKey = "conflict" | "staged" | "worktree" | "untracked";

export interface FileView {
  id: number;
  display: string;
  renameFrom: string | null;
  group: FileGroupKey;
  indexStatus: string;
  worktreeStatus: string;
  staged: boolean;
  unstaged: boolean;
  conflict: boolean;
  untracked: boolean;
  submodule: boolean;
}

export const GROUP_LABELS: ReadonlyArray<{ key: FileGroupKey; label: string }> = [
  { key: "conflict", label: "Conflicts" },
  { key: "staged", label: "Staged changes" },
  { key: "worktree", label: "Changes" },
  { key: "untracked", label: "Untracked files" },
];

export type ListRow =
  | { kind: "heading"; group: FileGroupKey; label: string; count: number; collapsed: boolean }
  | { kind: "file"; file: FileView };

export function buildRows(
  files: readonly FileView[],
  collapsed: ReadonlySet<FileGroupKey>,
): ListRow[] {
  const rows: ListRow[] = [];
  for (const group of GROUP_LABELS) {
    const members = files.filter((file) => file.group === group.key);
    if (members.length === 0) continue;
    const isCollapsed = collapsed.has(group.key);
    rows.push({
      kind: "heading",
      group: group.key,
      label: group.label,
      count: members.length,
      collapsed: isCollapsed,
    });
    if (!isCollapsed) {
      for (const file of members) {
        rows.push({ kind: "file", file });
      }
    }
  }
  return rows;
}

export interface VisibleWindow {
  startIndex: number;
  endIndex: number;
  offsetY: number;
  totalHeight: number;
}

/// Row slice a fixed-height virtual list must render for the current scroll
/// position. Rows outside the window are represented by total spacer height.
export function visibleWindow(
  totalRows: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  overscan: number,
): VisibleWindow {
  const first = Math.floor(scrollTop / rowHeight);
  const startIndex = Math.max(0, first - overscan);
  const endIndex = Math.min(
    totalRows,
    Math.ceil((scrollTop + viewportHeight) / rowHeight) + overscan,
  );
  return {
    startIndex,
    endIndex,
    offsetY: startIndex * rowHeight,
    totalHeight: totalRows * rowHeight,
  };
}
