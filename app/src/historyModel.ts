// Pure view-model for the commit list, mirroring `fileModel.ts` so
// `node --test` can import it directly. The History view virtualises this
// list: the M6-02/03 measurements showed a full-list rebuild per "Load
// older" click cost 129 ms at 500 rows and 1664 ms at 3000, so rows are
// windowed exactly like the file list.

import type { CommitView } from "./types";

export type HistoryRow =
  | { kind: "commit"; commit: CommitView }
  | { kind: "placeholder"; message: string };

export function buildHistoryRows(commits: readonly CommitView[]): HistoryRow[] {
  return commits.map((commit) => ({ kind: "commit", commit }) as const);
}

export function historyRowLabel(commit: CommitView): string {
  const refs = commit.refs.length > 0 ? `  ${commit.refs.join(" · ")}` : "";
  return `${commit.subject}  ·  ${commit.oid.slice(0, 8)}${refs}`;
}
