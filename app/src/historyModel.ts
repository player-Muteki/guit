// Pure view-model for the commit list, mirroring `fileModel.ts` so
// `node --test` can import it directly. The History view virtualises this
// list because rebuilding the whole list on every "Load older" click measured
// at 129 ms for 500 rows and 1664 ms for 3000, so rows are windowed exactly
// like the file list.

import type { CommitView } from "./types";

export type HistoryRow = { kind: "commit"; commit: CommitView };

// The offset asked of the backend for the next page. A reset re-reads page
// zero of a *new* HEAD, so it must not reuse the number of commits the old
// HEAD had loaded: that many commits were skipped after every branch switch.
export function historyPageStart(loaded: number, reset: boolean): number {
  return reset ? 0 : loaded;
}

export function buildHistoryRows(commits: readonly CommitView[]): HistoryRow[] {
  return commits.map((commit) => ({ kind: "commit", commit } as const));
}
