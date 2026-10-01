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
  // Which repository session produced this snapshot. It changes on every open,
  // even reopening the same path, and never on a refresh: two clones of one
  // project agree on the head, the branch name and every commit, so no field
  // drawn from Git can carry the identity. These three numbers do.
  sessionId: number;
  // How many times the head this session's graph is drawn from has moved.
  historyGeneration: number;
  // How many times a refresh could have changed the names in the repository.
  refsGeneration: number;
  repo: RepoView;
  branch: BranchView | null;
  files: FileView[];
  operation: OperationView | null;
};

// What a read was asked against, minted by the backend and shipped inside every
// snapshot. The frontend only carries and compares it — it never derives an
// identity from the fields it renders. `generation` is null for a listing that
// no refresh domain owns, which binds it to the session alone.
export type ReadContext = {
  sessionId: number;
  generation: number | null;
};

// A session-scoped read and the exact context it was answered under. The echo
// is what closes the hole the request alone cannot: a read that started
// legitimately for one repository can finish after the user opened another,
// and its rows are then indistinguishable by content.
export type SessionRead<T> = {
  context: ReadContext;
  value: T;
};

// --- working-tree activity ----------------------------------------
// What the panel claims about the last file the disk touched. This is a push
// beside the snapshot, never a field of it: an age is a wall-clock difference
// that moves with no repository change at all, so folding it into the snapshot
// would make every tick look like new Git news.
export type ActivityState = "ready" | "empty" | "partial" | "unavailable";

export type ActivityReason =
  | "readFailed"
  | "outputLimit"
  | "unreadablePaths"
  | "refreshFailed"
  | "sessionClosed";

export type ActivityView = {
  // The session this was measured for, minted by the backend and taken from the
  // snapshot published in the same round. `null` is the identity-free form and
  // is only ever a clear: it claims nothing about any repository, which is why
  // it may be accepted whatever is on screen.
  sessionId: number | null;
  // Counts measurements of this index, not refreshes of the snapshot.
  generation: number;
  state: ActivityState;
  // Epoch milliseconds, not a formatted string: an age is recomputed, never parsed.
  latestModifiedAt: number | null;
  observedAt: number;
  // Lossy display name of the file behind `latestModifiedAt`. It is not a path
  // and nothing may treat it as one.
  displayName: string | null;
  reason: ActivityReason | null;
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
    | "merge"
    | "rebase"
    | "cherrypick"
    | "revert"
    | "continue"
    | "abort"
    | "skip"
    | "reset"
    | "restore";
  outcome: "success" | "failed" | "cancelled" | "rejected" | "conflicted" | "partial";
  exitCode: number | null;
  message: string;
  details: string | null;
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

// A clean restore is two Git processes, so its preview cannot be one candidate
// list: it names each class of path the two steps touch under its own verb. See
// `restoreModel.ts` for how these lists are read out.
export type RestorePreviewResult = {
  nonce: string;
  /** Both ids as Git resolved them, never the text that was typed. */
  targetOid: string;
  headOid: string;
  /** Tracked paths the current commit and the target disagree about. */
  changed: string[];
  /** Local edits the restore drops. */
  discarded: string[];
  /** Untracked paths the restore writes. */
  overwritten: string[];
  /** Ignored paths the target holds anyway — the one class a rule does not set aside. */
  ignoredWritten: string[];
  /** Untracked paths the second step removes. */
  removed: string[];
  /** Untracked paths neither step touches. */
  leftBehind: string[];
  snapshot: SnapshotView;
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
  /** The object the ref points at: the tag object for an annotated tag. */
  oid: string;
  /** Git's word for what the tag stands for once peeled: `commit`, `tree`,
   * `blob`. A tag is not assumed to name a commit, because it may not. */
  targetType: string;
  /** The commit this tag names, when it names one — the id a label joins a
   * history row on. */
  commitOid: string | null;
  annotated: boolean;
  addressable: boolean;
};

export type RefListing = { branches: BranchRef[]; remotes: RemoteRef[]; tags: TagRef[] };

export type TagDetail = {
  name: string;
  oid: string;
  targetType: string;
  commitOid: string | null;
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

// A row of the loaded history: what Git says about the commit, and where the
// backend laid it in the graph. Deliberately absent: any name the commit
// carries. Which refs point here is a fact about the references, read and
// invalidated with them (`RefListing`), so a tag added after a page was laid
// out can arrive without the page being read a second time.
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
  graph: GraphRow;
};

export type HistoryPage = { start: number; commits: CommitView[]; hasMore: boolean };

export type CommitFileView = { status: string; path: string; oldPath: string | null };

// --- destructive-operation tickets --

export type PreviewKindKey =
  | "discard"
  | "clean"
  | "branch"
  | "tag"
  | "restore";

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
