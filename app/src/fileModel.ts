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

// Only a file is selectable, so only a file is a treeitem in the tree. An
// `option` would flatten the row: ARIA gives `option` presentational children,
// so WebKit hides the Stage and More-actions buttons from assistive tech. A
// group heading stays visible and clickable, but announcing it as a row would
// put a non-treeitem child inside a tree.
export function listRowRole(kind: ListRow["kind"]): "treeitem" | "presentation" {
  return kind === "file" ? "treeitem" : "presentation";
}

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

// A fixed-height virtual list is only correct when the height it assumes is
// the height the stylesheet actually gives a row. Rows are sized in rem and
// interface zoom changes the root font size, so the assumed height has to be
// derived from that same number: a hard-coded pixel constant silently drifts
// out of step with the rows, which shows up as scroll-positioned rows sliding
// under the viewport and selection landing on the wrong file.
//
// `FILE_ROW_REM` and `HISTORY_ROW_REM` must match `--row-height` and
// `--row-height-history` in style/tokens.css; `row-heights-track-the-css`
// below is the gate that fails when they do not.
export const FILE_ROW_REM = 1.5;
export const HISTORY_ROW_REM = 1.5;

export function rowHeightPx(baseFontPx: number, rowRem: number): number {
  return baseFontPx * rowRem;
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

// Row movement for keyboard navigation: headings are skipped, moving past
// either end keeps the current selection.
export function nextSelectableRow(
  rows: readonly ListRow[],
  from: number,
  delta: number,
): number {
  const step = delta > 0 ? 1 : delta < 0 ? -1 : 0;
  if (step === 0) {
    return from;
  }
  let index = from;
  for (;;) {
    index += step;
    if (index < 0 || index >= rows.length) {
      return from;
    }
    if (rows[index].kind === "file") {
      return index;
    }
  }
}

// Scroll position that brings a fixed-height row fully into view.
export function revealScroll(
  scrollTop: number,
  viewportHeight: number,
  index: number,
  rowHeight: number,
): number {
  const top = index * rowHeight;
  if (top < scrollTop) {
    return top;
  }
  if (top + rowHeight > scrollTop + viewportHeight) {
    return top + rowHeight - viewportHeight;
  }
  return scrollTop;
}

// A discard reverts a work-tree change, so it owns only a file whose work tree
// differs from the index. A conflict has its own verbs and an untracked file has
// no HEAD side to revert to, so neither is discardable.
export function discardEligible(file: FileView): boolean {
  return file.unstaged && !file.conflict && !file.untracked;
}

// A clean removes an untracked path. Which untracked paths Git itself agrees to
// remove — ignored files and nested repositories among them — is the backend's
// answer, not this one; this predicate only says which row can be asked.
export function cleanEligible(file: FileView): boolean {
  return file.untracked;
}

// The file ids a renewed ticket has to ask for, rebuilt from the names it showed
// the user. A ticket is issued against one snapshot and its ids die with it, so
// a renewal can only re-address the same set by name.
//
// Returns null — "this ticket cannot be renewed" — when a name matches no
// eligible row or matches more than one. Both are the same failure seen from
// different sides: the list on the screen is no longer a list the new snapshot
// can act on, and any subset of it would be a different promise than the one the
// user read. A display name is lossy (it is produced from raw path bytes that
// may not survive the round trip), so more than one row can carry the same text;
// that is why a duplicate is checked for rather than assumed impossible.
export function idsForNames(
  files: readonly FileView[],
  names: readonly string[],
  eligible: (file: FileView) => boolean,
): number[] | null {
  const ids: number[] = [];
  for (const name of names) {
    let found: number | null = null;
    for (const file of files) {
      if (file.display !== name || !eligible(file)) continue;
      if (found !== null) return null;
      found = file.id;
    }
    if (found === null) return null;
    ids.push(found);
  }
  return ids;
}
