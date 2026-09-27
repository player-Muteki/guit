// Wire types shared across the shell, the views and the dialogs. Every shape
// here mirrors a Tauri command's serde output in `src-tauri/src`; the frontend
// never constructs these payloads itself.

import type { FileView } from "./fileModel";

// The file row shape is pure view logic rather than a wire type, but it is
// part of every snapshot the backend sends, so it is re-exported here as one
// name the rest of the app imports from.
export type { FileView };

export type GitProbe = {
  available: boolean;
  version: string | null;
  executable: string | null;
  supported: boolean;
  hasRestore: boolean;
  message: string;
};

export type ToolProbe = {
  difftool: string | null;
  mergetool: string | null;
  opener: string;
};

export type WindowSettings = {
  schemaVersion: number;
  width: number;
  height: number;
  frameWidth: number;
  frameHeight: number;
  x: number;
  y: number;
  alwaysOnTop: boolean;
  maximized: boolean;
};

export type RepoView = {
  openPath: string;
  root: string | null;
  gitDir: string;
  bare: boolean;
  linkedWorktree: boolean;
};

export type BranchView = {
  name: string | null;
  headState: "branch" | "detached" | "unborn";
  oid: string | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
};

export type OperationView = {
  kind: "merge" | "rebase" | "cherryPick" | "revert" | "unknown";
  subject: string;
  step: number | null;
  total: number | null;
};

export type SnapshotView = {
  version: number;
  repo: RepoView;
  branch: BranchView | null;
  files: FileView[];
  operation: OperationView | null;
};

// Heuristic cause of a failed network operation, decided in Rust; the
// frontend only displays it, never re-derives it from text.
export type NetCategory =
  | "auth"
  | "network"
  | "nonfastforward"
  | "protectedbranch"
  | "remotehookrejected"
  | "stalelease"
  | "notfound"
  | "other";

export type CloneResult = {
  target: string;
  success: boolean;
  cancelled: boolean;
  message: string;
  category: NetCategory | null;
  suggestion: string | null;
  residue: string | null;
};

export type OperationResult = {
  operationId: number;
  kind:
    | "stage"
    | "unstage"
    | "commit"
    | "discard"
    | "clean"
    | "branchcreate"
    | "branchswitch"
    | "branchrename"
    | "branchdelete"
    | "tagcreate"
    | "tagdelete"
    | "stashsave"
    | "stashapply"
    | "stashpop"
    | "stashdrop"
    | "merge"
    | "rebase"
    | "cherrypick"
    | "revert"
    | "continue"
    | "abort"
    | "skip"
    | "reset"
    | "resethard"
    | "worktreeadd"
    | "worktreeremove"
    | "worktreeprune"
    | "submoduleupdate"
    | "remoteadd"
    | "remoteseturl"
    | "removeremote"
    | "fetch"
    | "setupstream"
    | "pull"
    | "push"
    | "publish"
    | "deleteremotebranch"
    | "forcepush";
  outcome: "success" | "failed" | "cancelled" | "rejected" | "conflicted";
  exitCode: number | null;
  message: string;
  details: string | null;
  category: NetCategory | null;
  suggestion: string | null;
  snapshot: SnapshotView | null;
};

export type PreviewResult = {
  nonce: string;
  candidates: string[];
  dropped: string[];
  snapshot: SnapshotView;
  targetOid: string | null;
};

export type ToolPurpose = "openFile" | "diffWorktree" | "diffStaged" | "diffCommit" | "mergeFile";

export type ToolResult = {
  operationId: number;
  purpose: ToolPurpose;
  outcome: "success" | "failed" | "cancelled" | "rejected" | "conflicted";
  exitCode: number | null;
  message: string;
  details: string | null;
  snapshot: SnapshotView | null;
};

// --- references ---------------------------------------------------

export type BranchRef = {
  name: string;
  oid: string;
  head: boolean;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  upstreamGone: boolean;
  addressable: boolean;
};

export type RemoteRef = {
  name: string;
  oid: string;
  symref: string | null;
  addressable: boolean;
};

export type TagRef = {
  name: string;
  oid: string;
  targetOid: string | null;
  annotated: boolean;
  addressable: boolean;
};

export type RefListing = { branches: BranchRef[]; remotes: RemoteRef[]; tags: TagRef[] };

export type TagDetail = {
  name: string;
  oid: string;
  targetOid: string;
  annotated: boolean;
  message: string;
};

// --- history ------------------------------------------------------

// One row of the commit graph, computed by the backend. `node` is the column
// of this commit's dot; `lanes` are the other columns a line crosses on this
// row; `branches` are the extra parent lanes that start at this node. A
// renderer needs no other row to draw this one.
export type GraphRow = {
  node: number;
  entry: boolean;
  exit: boolean;
  merge: boolean;
  root: boolean;
  lanes: number[];
  branches: number[];
  incoming: number[];
  dangling: boolean;
  folded: boolean;
};

export type CommitView = {
  oid: string;
  parents: string[];
  subject: string;
  message: string;
  authorName: string;
  authorEmail: string;
  authorDate: string;
  committerName: string;
  commitDate: string;
  refs: string[];
  graph: GraphRow;
};

export type HistoryPage = { start: number; commits: CommitView[]; hasMore: boolean };

export type CommitFileView = { status: string; path: string; oldPath: string | null };

// --- stash --------------------------------------------------------

export type StashEntry = { index: number; date: string; subject: string };

// --- worktrees / submodules -------------------------------

export type WorktreeView = {
  index: number;
  path: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
  orphan: boolean;
  bare: boolean;
  locked: boolean;
  prunable: boolean;
  addressable: boolean;
};

export type SubmoduleView = {
  index: number;
  path: string;
  name: string | null;
  url: string | null;
  recordedOid: string;
  checkedOutOid: string | null;
  state: "upToDate" | "uninitialized" | "outOfSync" | "conflicted" | "unmapped";
};

export const SUBMODULE_STATE_LABELS: Readonly<Record<SubmoduleView["state"], string>> = {
  upToDate: "up to date",
  uninitialized: "not initialized",
  outOfSync: "checked-out commit differs from the index",
  conflicted: "conflicted",
  unmapped: "no .gitmodules mapping",
};

// --- remotes --------------------------------------------------

export type RemoteView = {
  name: string;
  fetchUrl: string | null;
  pushUrl: string | null;
  addressable: boolean;
};

export type SyncProgress = { operationId: number; line: string };

export type PullDefault = {
  rebase: { value: string; scope: string } | null;
  ff: { value: string; scope: string } | null;
  effective: string;
  note: string | null;
};

export type PublishTarget = { name: string; url: string | null };

// --- askpass ------------------------------------------------------

// The payload of one `askpass-request` event: categorised prompt material
// only. The Rust side has already stripped everything else and can prove
// the target survives URL redaction, so displaying it is safe.
export type AskPassRequest = {
  operationId: number;
  kind: "username" | "password";
  target: string;
  user: string | null;
};

// --- destructive-operation tickets --

export type PreviewKindKey =
  | "discard"
  | "clean"
  | "branch"
  | "tag"
  | "stashDrop"
  | "stashPop"
  | "resetHard"
  | "worktreeRemove"
  | "remoteRemove"
  | "remoteBranchDelete"
  | "forcePush";

export type PreviewCopy = {
  warning: string;
  confirm: string;
  cancel: string;
  droppedLabel?: string;
};

// --- shell feedback -------------------------------------------------------

export type StatusKind = "idle" | "info" | "progress" | "error" | "success";

export type StatusLine = { kind: StatusKind; message: string };

export type ToastAction = { label: string; run: () => void };

export type ToastLevel = "error" | "warning" | "info";

export type Toast = {
  id: number;
  level: ToastLevel;
  message: string;
  actions?: ToastAction[];
};
