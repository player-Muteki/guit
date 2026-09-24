import { invoke } from "@tauri-apps/api/core";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import {
  buildRows,
  nextSelectableRow,
  revealScroll,
  visibleWindow,
  type FileGroupKey,
  type FileView,
  type ListRow,
} from "./fileModel";
import "./style.css";

type GitProbe = {
  available: boolean;
  version: string | null;
  executable: string | null;
  supported: boolean;
  hasRestore: boolean;
  message: string;
};

type ToolProbe = {
  difftool: string | null;
  mergetool: string | null;
  opener: string;
};

type WindowSettings = {
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

type RepoView = {
  openPath: string;
  root: string | null;
  gitDir: string;
  bare: boolean;
  linkedWorktree: boolean;
};

type BranchView = {
  name: string | null;
  headState: "branch" | "detached" | "unborn";
  oid: string | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
};

type SnapshotView = {
  version: number;
  repo: RepoView;
  branch: BranchView | null;
  files: FileView[];
};

type CloneResult = {
  target: string;
  success: boolean;
  cancelled: boolean;
  message: string;
  residue: string | null;
};

type OperationResult = {
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
    | "branchdelete";
  outcome: "success" | "failed" | "cancelled" | "rejected";
  exitCode: number | null;
  message: string;
  details: string | null;
  snapshot: SnapshotView | null;
};

type PreviewResult = {
  nonce: string;
  candidates: string[];
  dropped: string[];
  snapshot: SnapshotView;
  targetOid: string | null;
};

type ToolPurpose = "openFile" | "diffWorktree" | "diffStaged" | "diffCommit";

type ToolResult = {
  operationId: number;
  purpose: ToolPurpose;
  outcome: "success" | "failed" | "cancelled" | "rejected";
  exitCode: number | null;
  message: string;
  details: string | null;
  snapshot: SnapshotView | null;
};

const app = document.querySelector<HTMLElement>("#app");
if (!app) throw new Error("Application root is missing");

app.innerHTML = `
  <header><strong>guit</strong><span>Git desktop client · commit workbench</span></header>
  <section class="card">
    <h1>Repository</h1>
    <div id="repo-summary" class="session">No repository open. Choose a folder that is inside a Git working copy.</div>
    <div class="actions">
      <button id="open-repo">Open repository…</button>
      <button id="refresh-repo" disabled>Refresh status</button>
      <button id="close-repo" disabled>Close session</button>
    </div>
    <h2>Recent</h2>
    <ul id="recent-list" class="recent"><li>None yet.</li></ul>
    <h2>Clone</h2>
    <div class="actions">
      <input id="clone-source" type="text" placeholder="Repository URL or local path" aria-label="Repository to clone" />
      <button id="clone-pick-dir">Into folder…</button>
      <button id="clone-start" disabled>Clone</button>
      <button id="clone-cancel" disabled>Cancel</button>
    </div>
    <p id="clone-status" role="status">Choose a destination folder to clone a repository.</p>
    <h2>Changes</h2>
    <div id="file-list" class="files" role="list" aria-label="Changed files" tabindex="0">
      <div id="file-virtual" class="virtual"><div id="file-rows" class="virtual-rows"></div></div>
    </div>
    <p id="write-status" role="status"></p>
    <div id="confirm-preview" class="preview" role="alertdialog" aria-label="Confirm destructive operation" hidden>
      <p id="preview-warning" class="preview-warning"></p>
      <ul id="preview-candidates" class="preview-list"></ul>
      <p id="preview-dropped" class="preview-note" hidden></p>
      <div class="actions">
        <button id="preview-confirm" class="danger">Confirm</button>
        <button id="preview-keep">Cancel</button>
      </div>
    </div>
    <div class="actions"><button id="tool-cancel" disabled>Stop external tool</button></div>
    <h2>Commit</h2>
    <div class="commit-box">
      <textarea id="commit-message" rows="3" placeholder="Commit message — Ctrl+Enter commits" aria-label="Commit message" disabled></textarea>
      <div class="actions">
        <label><input id="commit-amend" type="checkbox" disabled /> Amend last commit</label>
        <button id="commit-button" disabled>Commit</button>
        <button id="commit-cancel" disabled>Cancel</button>
      </div>
    </div>
  </section>
  <section class="card">
    <h1>References</h1>
    <div class="actions">
      <input id="branch-name" type="text" placeholder="New branch name" aria-label="New branch name" disabled />
      <button id="branch-create" disabled>Create branch</button>
      <button id="branch-force" class="danger" hidden>Force delete…</button>
    </div>
    <div id="ref-list" class="refs" role="list" aria-label="Branches and tags">
      <div class="file-row placeholder">Open a repository to list its branches and tags.</div>
    </div>
    <p id="ref-status" role="status"></p>
  </section>
  <section class="card">
    <h1>History</h1>
    <div id="history-list" class="history" role="list" aria-label="Commit history">
      <div class="file-row placeholder">Open a repository to browse its history.</div>
    </div>
    <div class="actions">
      <button id="history-more" disabled>Load older</button>
    </div>
    <p id="history-status" role="status"></p>
    <div id="commit-detail" class="detail" hidden>
      <dl id="detail-meta"></dl>
      <pre id="detail-message" class="commit-message"></pre>
      <ul id="detail-files" class="detail-files"></ul>
      <div class="actions">
        <button id="copy-oid">Copy OID</button>
        <button id="diff-commit">Diff commit</button>
        <button id="branch-from-commit">Branch from commit…</button>
      </div>
    </div>
  </section>
  <section class="card">
    <h1>Environment check</h1>
    <p>M0 probes kept for regression checking; repository work happens in the card above.</p>
    <dl>
      <dt>Git</dt><dd id="git-result">Checking…</dd>
      <dt>External tools</dt><dd id="tools-result">Checking…</dd>
      <dt>Window</dt><dd id="window-result">Checking…</dd>
      <dt>Folder picker</dt><dd id="folder-result">Not tested</dd>
    </dl>
    <div class="actions">
      <button id="refresh">Check again</button>
      <button id="choose-folder">Choose folder</button>
      <button id="compact-window">Test compact window</button>
      <button id="restore-window" disabled>Restore window size</button>
      <label><input id="on-top" type="checkbox" /> Always on top</label>
    </div>
  </section>
  <section class="card">
    <h2>Process probe</h2>
    <p>Starts a cancellable Git command to verify that the window stays responsive.</p>
    <div class="actions"><button id="run-probe">Run probe</button><button id="cancel-probe" disabled>Cancel</button></div>
    <p id="probe-result" role="status">Idle</p>
    <button id="transfer-probe">Test Git progress</button>
    <p id="transfer-result" role="status">Uses a disposable local clone.</p>
  </section>
  <p id="error" role="alert" hidden></p>
`;

const gitResult = document.querySelector<HTMLElement>("#git-result")!;
const toolsResult = document.querySelector<HTMLElement>("#tools-result")!;
const windowResult = document.querySelector<HTMLElement>("#window-result")!;
const folderResult = document.querySelector<HTMLElement>("#folder-result")!;
const probeResult = document.querySelector<HTMLElement>("#probe-result")!;
const errorElement = document.querySelector<HTMLElement>("#error")!;
const onTop = document.querySelector<HTMLInputElement>("#on-top")!;
const runProbe = document.querySelector<HTMLButtonElement>("#run-probe")!;
const cancelProbe = document.querySelector<HTMLButtonElement>("#cancel-probe")!;
const currentWindow = getCurrentWindow();
let saveTimer: number | undefined;
let saveQueue = Promise.resolve();
let previousSize: LogicalSize | undefined;
let previouslyMaximized = false;
let lastNormalBounds: Pick<WindowSettings, "width" | "height" | "frameWidth" | "frameHeight" | "x" | "y"> | undefined;

const repoSummary = document.querySelector<HTMLElement>("#repo-summary")!;
const recentList = document.querySelector<HTMLElement>("#recent-list")!;
const fileScroll = document.querySelector<HTMLElement>("#file-list")!;
const fileVirtual = document.querySelector<HTMLElement>("#file-virtual")!;
const fileRows = document.querySelector<HTMLElement>("#file-rows")!;
const openRepoButton = document.querySelector<HTMLButtonElement>("#open-repo")!;
const refreshRepoButton = document.querySelector<HTMLButtonElement>("#refresh-repo")!;
const closeRepoButton = document.querySelector<HTMLButtonElement>("#close-repo")!;
const writeStatus = document.querySelector<HTMLElement>("#write-status")!;
const commitMessage = document.querySelector<HTMLTextAreaElement>("#commit-message")!;
const commitAmend = document.querySelector<HTMLInputElement>("#commit-amend")!;
const commitButton = document.querySelector<HTMLButtonElement>("#commit-button")!;
const commitCancelButton = document.querySelector<HTMLButtonElement>("#commit-cancel")!;
const toolCancelButton = document.querySelector<HTMLButtonElement>("#tool-cancel")!;
const confirmPanel = document.querySelector<HTMLElement>("#confirm-preview")!;
const previewWarning = document.querySelector<HTMLElement>("#preview-warning")!;
const previewCandidates = document.querySelector<HTMLElement>("#preview-candidates")!;
const previewDropped = document.querySelector<HTMLElement>("#preview-dropped")!;
const previewConfirmButton = document.querySelector<HTMLButtonElement>("#preview-confirm")!;
const previewKeepButton = document.querySelector<HTMLButtonElement>("#preview-keep")!;

const ROW_HEIGHT = 30;
const OVERSCAN = 6;
let listRows: ListRow[] = [];
let currentFiles: FileView[] = [];
const collapsedGroups = new Set<FileGroupKey>();
let selectedRow = -1;
let selectedFileId: number | null = null;
let sessionActive = false;
let currentSnapshot: SnapshotView | null = null;
let watchMode = "none";
let refreshingSession = false;

// Backend snapshots carry a monotonic version; an older one must never
// replace a newer rendered snapshot (file IDs are per-snapshot).
function applySnapshot(snapshot: SnapshotView | null): void {
  if (snapshot && currentSnapshot && snapshot.version <= currentSnapshot.version) {
    return;
  }
  currentSnapshot = snapshot;
  renderSnapshot(snapshot);
  // An open confirmation panel is bound to the snapshot that produced it; a
  // newer snapshot invalidates its file IDs, so recompute the preview.
  if (snapshot) void renewPreviewPanel();
}

async function refreshSession(silent: boolean): Promise<void> {
  if (!sessionActive || refreshingSession) return;
  refreshingSession = true;
  try {
    applySnapshot(await invoke<SnapshotView | null>("refresh_repository"));
  } catch (error) {
    if (!silent) showError(error);
  } finally {
    refreshingSession = false;
    refreshRepoButton.disabled = !sessionActive;
  }
}

void listen<SnapshotView>("repo-refreshed", ({ payload }) => applySnapshot(payload));
void listen<{ mode: string }>("watch-status", ({ payload }) => {
  watchMode = payload.mode;
  renderSnapshot(currentSnapshot);
});

function describeBranch(branch: BranchView | null): string {
  if (!branch) return "bare repository — status unavailable";
  if (branch.headState === "detached") {
    return `detached HEAD at ${branch.oid?.slice(0, 8) ?? "unknown"}`;
  }
  const name = branch.name ?? "unknown";
  if (branch.headState === "unborn") return `${name} (no commits yet)`;
  if (!branch.upstream) return name;
  return `${name} · ${branch.upstream} ↑${branch.ahead} ↓${branch.behind}`;
}

function renderSnapshot(snapshot: SnapshotView | null): void {
  sessionActive = snapshot !== null;
  syncHistoryWithSnapshot();
  syncRefsWithSnapshot();
  closeRepoButton.disabled = !sessionActive;
  refreshRepoButton.disabled = !sessionActive;
  syncCommitControls();
  repoSummary.textContent = "";
  if (!snapshot) {
    commitMessage.value = "";
    commitAmend.checked = false;
    closePreviewPanel();
    recentList.replaceChildren();
    renderRecentPlaceholder("None yet.");
    renderFilesPlaceholder("Open a repository to list its working copy status.");
    return;
  }
  const addLine = (label: string, value: string) => {
    const line = document.createElement("div");
    const strong = document.createElement("strong");
    strong.textContent = label;
    line.append(strong, document.createTextNode(value));
    repoSummary.append(line);
  };
  addLine("Branch: ", describeBranch(snapshot.branch));
  addLine("Path: ", snapshot.repo.root ?? snapshot.repo.gitDir);
  if (snapshot.repo.linkedWorktree) addLine("", "Linked worktree");
  if (watchMode !== "none") addLine("Monitor: ", watchMode === "poll" ? "polling" : "filesystem events");
  renderFileList(snapshot.files);
}

function renderRecentPlaceholder(message: string): void {
  const item = document.createElement("li");
  item.textContent = message;
  recentList.replaceChildren(item);
}

function renderRecent(paths: string[]): void {
  if (paths.length === 0) {
    renderRecentPlaceholder("None yet.");
    return;
  }
  const items = paths.map((path) => {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.className = "recent-entry";
    button.textContent = path;
    button.addEventListener("click", () => void openRepository(path));
    item.append(button);
    return item;
  });
  recentList.replaceChildren(...items);
}

function renderFilesPlaceholder(message: string): void {
  currentFiles = [];
  listRows = [];
  selectedRow = -1;
  selectedFileId = null;
  fileVirtual.style.height = "0px";
  fileRows.style.transform = "translateY(0px)";
  const item = document.createElement("div");
  item.className = "file-row placeholder";
  item.textContent = message;
  fileRows.replaceChildren(item);
}

function renderFileList(files: FileView[]): void {
  if (files.length === 0) {
    renderFilesPlaceholder("Working copy is clean.");
    return;
  }
  currentFiles = files;
  listRows = buildRows(files, collapsedGroups);
  syncSelection();
  renderFileRows();
}

// Selection survives refreshes and collapsing through the stable file ID.
function syncSelection(): void {
  if (selectedFileId === null) {
    selectedRow = -1;
    return;
  }
  selectedRow = listRows.findIndex(
    (row) => row.kind === "file" && row.file.id === selectedFileId,
  );
  if (selectedRow < 0) selectedFileId = null;
}

// Fixed-height virtual list: only the rows intersecting the viewport (plus
// overscan) exist in the DOM, so a repository with tens of thousands of
// changed files costs the same as one with dozens.
function renderFileRows(): void {
  const viewport = fileScroll.clientHeight || 320;
  const slice = visibleWindow(
    listRows.length,
    fileScroll.scrollTop,
    viewport,
    ROW_HEIGHT,
    OVERSCAN,
  );
  fileVirtual.style.height = `${slice.totalHeight}px`;
  fileRows.style.transform = `translateY(${slice.offsetY}px)`;
  const fragment = document.createDocumentFragment();
  for (let index = slice.startIndex; index < slice.endIndex; index++) {
    fragment.append(createRow(listRows[index], index));
  }
  fileRows.replaceChildren(fragment);
  if (selectedRow >= slice.startIndex && selectedRow < slice.endIndex) {
    fileScroll.setAttribute("aria-activedescendant", `file-row-${selectedRow}`);
  } else {
    fileScroll.removeAttribute("aria-activedescendant");
  }
}

function createRow(row: ListRow, index: number): HTMLElement {
  const element = document.createElement("div");
  element.id = `file-row-${index}`;
  element.setAttribute("role", "listitem");
  if (row.kind === "heading") {
    element.className = "file-row group-heading";
    element.textContent = `${row.collapsed ? "▸" : "▾"} ${row.label} (${row.count})`;
    element.addEventListener("click", () => toggleGroup(row.group));
    const batchAction: "stage" | "unstage" | null =
      row.group === "conflict" ? null : row.group === "staged" ? "unstage" : "stage";
    if (batchAction) {
      const button = document.createElement("button");
      button.className = "row-action batch";
      button.textContent = batchAction === "stage" ? "Stage all" : "Unstage all";
      button.disabled = writeRunning;
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        // IDs come from the live snapshot; the backend rejects the whole
        // batch if any one of them has gone stale.
        const ids = currentFiles
          .filter((file) => file.group === row.group)
          .map((file) => file.id);
        if (ids.length > 0) {
          void runWrite(batchAction === "stage" ? "stage_files" : "unstage_files", ids);
        }
      });
      element.append(button);
    }
    if (row.group === "worktree") {
      const discardAll = document.createElement("button");
      discardAll.className = "row-action batch danger";
      discardAll.textContent = "Discard all";
      discardAll.disabled = writeRunning || pendingPreview !== null;
      discardAll.addEventListener("click", (event) => {
        event.stopPropagation();
        const ids = currentFiles
          .filter((file) => file.group === "worktree" && discardEligible(file))
          .map((file) => file.id);
        if (ids.length > 0) {
          void requestDiscard(ids);
        }
      });
      element.append(discardAll);
    }
    if (row.group === "untracked") {
      const cleanButton = document.createElement("button");
      cleanButton.className = "row-action batch danger";
      cleanButton.textContent = "Clean…";
      cleanButton.disabled = writeRunning || pendingPreview !== null;
      cleanButton.addEventListener("click", (event) => {
        event.stopPropagation();
        void requestClean();
      });
      element.append(cleanButton);
    }
    return element;
  }
  const selected = index === selectedRow;
  element.className = "file-row" + (selected ? " selected" : "");
  element.setAttribute("aria-selected", String(selected));
  const file = row.file;
  const name = file.renameFrom ? `${file.renameFrom} → ${file.display}` : file.display;
  element.title = name;
  const status = document.createElement("span");
  status.className = "file-status";
  status.textContent = `${file.indexStatus}${file.worktreeStatus}`;
  const label = document.createElement("span");
  label.className = "file-name";
  label.textContent = name;
  element.append(status, label);
  const action = fileRowAction(file);
  if (action) {
    const button = document.createElement("button");
    button.className = "row-action";
    button.textContent = action === "stage" ? "Stage" : "Unstage";
    button.setAttribute("aria-label", `${button.textContent} ${file.display}`);
    button.disabled = writeRunning;
    button.addEventListener("click", () =>
      void runWrite(action === "stage" ? "stage_files" : "unstage_files", [file.id]),
    );
    element.append(button);
  }
  if (discardEligible(file)) {
    const button = document.createElement("button");
    button.className = "row-action danger";
    button.textContent = "Discard";
    button.setAttribute("aria-label", `Discard ${file.display}`);
    button.disabled = writeRunning || pendingPreview !== null;
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      void requestDiscard([file.id]);
    });
    element.append(button);
  }
  const toolActions: Array<{ label: string; purpose: ToolPurpose }> = [
    { label: "Open", purpose: "openFile" },
  ];
  // Untracked files have no HEAD-side counterpart, so difftool skips them;
  // the staged side only exists once the file is in the index.
  if (!file.untracked) toolActions.push({ label: "Diff", purpose: "diffWorktree" });
  if (file.staged) toolActions.push({ label: "Diff staged", purpose: "diffStaged" });
  for (const tool of toolActions) {
    const button = document.createElement("button");
    button.className = "row-action tool";
    button.textContent = tool.label;
    button.setAttribute("aria-label", `${tool.label} ${file.display}`);
    button.disabled = toolRunning;
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      void runTool(tool.purpose, file.id);
    });
    element.append(button);
  }
  return element;
}

// Conflicts resolve through mergetool (M4), not staging; every other group
// has exactly one sensible per-file write in M2's first loop.
function fileRowAction(file: FileView): "stage" | "unstage" | null {
  if (file.group === "conflict") return null;
  return file.group === "staged" ? "unstage" : "stage";
}

let writeRunning = false;
let toolRunning = false;

// The backend re-reads Git after every write and returns the fresh snapshot;
// it flows through the same version guard as watcher refreshes.
async function runWrite(
  command: "stage_files" | "unstage_files",
  fileIds: number[],
): Promise<void> {
  if (!currentSnapshot || writeRunning) return;
  writeRunning = true;
  syncCommitControls();
  writeStatus.textContent = `${command === "stage_files" ? "Staging" : "Unstaging"} ${fileIds.length} file(s)…`;
  renderFileRows();
  try {
    const result = await invoke<OperationResult>(command, {
      snapshotVersion: currentSnapshot.version,
      fileIds,
    });
    applySnapshot(result.snapshot);
    writeStatus.textContent = result.details
      ? `${result.message} ${result.details}`
      : result.message;
  } catch (error) {
    showError(error);
    writeStatus.textContent = "The write did not run.";
  } finally {
    writeRunning = false;
    syncCommitControls();
    renderFileRows();
  }
}

function syncCommitControls(): void {
  const locked = !sessionActive || writeRunning;
  commitMessage.disabled = locked;
  commitAmend.disabled = locked;
  commitButton.disabled = locked;
  commitCancelButton.disabled = !writeRunning;
  toolCancelButton.disabled = !toolRunning;
  diffCommitButton.disabled = toolRunning || selectedCommit === null;
  previewConfirmButton.disabled = writeRunning || pendingPreview === null;
  previewKeepButton.disabled = writeRunning;
  syncBranchControls();
}

// A difftool call stays pending until the user closes the diff window, so
// the lane has its own busy flag; staging and committing remain available
// while a tool runs because the backend keeps them in separate slots.
async function runTool(purpose: ToolPurpose, fileId: number): Promise<void> {
  if (!currentSnapshot || toolRunning) return;
  toolRunning = true;
  syncCommitControls();
  renderFileRows();
  writeStatus.textContent =
    purpose === "openFile"
      ? "Opening file…"
      : "Waiting for the diff tool to close…";
  try {
    const result = await invoke<ToolResult>("open_external_tool", {
      snapshotVersion: currentSnapshot.version,
      fileId,
      purpose,
    });
    applySnapshot(result.snapshot);
    writeStatus.textContent = result.details
      ? `${result.message} ${result.details}`
      : result.message;
  } catch (error) {
    showError(error);
    writeStatus.textContent = "The external tool did not run.";
  } finally {
    toolRunning = false;
    syncCommitControls();
    renderFileRows();
  }
}

toolCancelButton.addEventListener("click", () => void invoke("cancel_exttool"));

// On failure, cancellation or rejection the textarea keeps its content: the
// user's message is input they own, and guit never swallows it.
async function commitNow(): Promise<void> {
  if (!currentSnapshot || writeRunning) return;
  const message = commitMessage.value;
  const amend = commitAmend.checked;
  writeRunning = true;
  syncCommitControls();
  renderFileRows();
  writeStatus.textContent = amend ? "Amending the last commit…" : "Committing…";
  try {
    const result = await invoke<OperationResult>("commit_changes", {
      snapshotVersion: currentSnapshot.version,
      message,
      amend,
    });
    applySnapshot(result.snapshot);
    writeStatus.textContent = result.details
      ? `${result.message} ${result.details}`
      : result.message;
    if (result.outcome === "success") {
      commitMessage.value = "";
      commitAmend.checked = false;
    }
  } catch (error) {
    showError(error);
    writeStatus.textContent = "The commit did not run.";
  } finally {
    writeRunning = false;
    syncCommitControls();
    renderFileRows();
  }
}

commitButton.addEventListener("click", () => void commitNow());
commitCancelButton.addEventListener("click", () => void invoke("cancel_write"));
commitMessage.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    void commitNow();
  }
});

// --- destructive operations: preview → recheck → confirm (plan/04 协议) ---
// One panel serves discard (work-tree restore), clean (untracked removal)
// and branch delete; all bind a single-use server nonce that the backend
// re-checks against a fresh Git read at every step.

type PreviewKindKey = "discard" | "clean" | "branch";

const previewCopy: Record<PreviewKindKey, { warning: string; confirm: string; cancel: string }> = {
  discard: {
    warning: "Discarding reverts these files in the working copy. The uncommitted work-tree changes cannot be recovered.",
    confirm: "Discard",
    cancel: "Keep changes",
  },
  clean: {
    warning: "These untracked files and folders will be deleted from disk. They are not in Git and cannot be recovered.",
    confirm: "Delete untracked",
    cancel: "Keep files",
  },
  branch: {
    warning: "Deleting removes this branch name. Commits it points at stay reachable only through other refs; once unreachable, Git may garbage-collect them. This cannot be undone from guit.",
    confirm: "Delete branch",
    cancel: "Keep branch",
  },
};

const branchForceCopy = {
  warning: "This branch is not fully merged. Force-deleting makes its unique commits unreachable, and Git may garbage-collect them. This cannot be undone from guit.",
  confirm: "Force delete branch",
  cancel: "Keep branch",
};

type PendingPreview =
  | {
      kind: "discard" | "clean";
      names: string[];
      dropped: string[];
      nonce: string;
      branch?: undefined;
    }
  | {
      kind: "branch";
      names: string[];
      dropped: string[];
      nonce: string;
      branch: { name: string; force: boolean; targetOid: string | null };
    };

let pendingPreview: PendingPreview | null = null;
let previewRenewing = false;

function discardEligible(file: FileView): boolean {
  // Untracked files go through clean; conflicts through mergetool (M4);
  // only work-tree-side changes can be discarded.
  return file.unstaged && !file.conflict && !file.untracked;
}

function renderPreviewPanel(): void {
  if (!pendingPreview) {
    confirmPanel.hidden = true;
    return;
  }
  const pending = pendingPreview;
  const forced = pending.branch?.force === true;
  const copy = pending.kind === "branch" && forced ? branchForceCopy : previewCopy[pending.kind];
  confirmPanel.hidden = false;
  previewWarning.textContent = copy.warning;
  previewConfirmButton.textContent = copy.confirm;
  previewKeepButton.textContent = copy.cancel;
  const oid = pending.branch?.targetOid ?? null;
  previewCandidates.replaceChildren(
    ...pending.names.map((name) => {
      const item = document.createElement("li");
      item.textContent = oid ? `${name} · at ${oid.slice(0, 10)}` : name;
      return item;
    }),
  );
  previewDropped.hidden = pending.dropped.length === 0;
  previewDropped.textContent = `Skipped (no work-tree changes): ${pending.dropped.join(", ")}`;
  syncCommitControls();
}

async function requestDiscard(fileIds: number[]): Promise<void> {
  if (!currentSnapshot || writeRunning || pendingPreview) return;
  writeStatus.textContent = "Checking what a discard would revert…";
  try {
    const preview = await invoke<PreviewResult>("preview_discard", {
      snapshotVersion: currentSnapshot.version,
      fileIds,
    });
    // Apply the backend's re-read first (it published a newer version);
    // with no pending preview the renew hook stays quiet.
    applySnapshot(preview.snapshot);
    pendingPreview = { kind: "discard", names: preview.candidates, dropped: preview.dropped, nonce: preview.nonce };
    renderPreviewPanel();
    previewConfirmButton.focus();
  } catch (error) {
    showError(error);
    writeStatus.textContent = "The discard was refused before anything changed.";
  }
}

async function requestClean(): Promise<void> {
  if (!currentSnapshot || writeRunning || pendingPreview) return;
  writeStatus.textContent = "Listing what a clean would delete…";
  try {
    const preview = await invoke<PreviewResult>("preview_clean", {
      snapshotVersion: currentSnapshot.version,
    });
    applySnapshot(preview.snapshot);
    pendingPreview = { kind: "clean", names: preview.candidates, dropped: preview.dropped, nonce: preview.nonce };
    renderPreviewPanel();
    previewConfirmButton.focus();
  } catch (error) {
    showError(error);
    writeStatus.textContent = "The clean was refused before anything changed.";
  }
}

// The backend consumes the nonce and re-verifies candidates itself; this
// only recomputes what the preview request needs against the newest
// snapshot: discard file IDs are per-snapshot (mapped back by display name,
// ambiguous names force a fresh preview), clean has no IDs at all.
async function renewPreviewPanel(): Promise<void> {
  if (!pendingPreview || previewRenewing || !currentSnapshot) return;
  const pending = pendingPreview;
  const request: Record<string, unknown> = { snapshotVersion: currentSnapshot.version };
  if (pending.kind === "discard") {
    const ids: number[] = [];
    for (const name of pending.names) {
      const matches = currentFiles.filter((file) => file.display === name && discardEligible(file));
      if (matches.length !== 1) {
        closePreviewPanel("The changed files moved after the preview; ask again to confirm.");
        return;
      }
      ids.push(matches[0].id);
    }
    request.fileIds = ids;
  }
  if (pending.kind === "branch") {
    request.name = pending.branch.name;
    request.force = pending.branch.force;
  }
  previewRenewing = true;
  try {
    const command =
      pending.kind === "discard"
        ? "preview_discard"
        : pending.kind === "clean"
          ? "preview_clean"
          : "preview_delete_branch";
    const preview = await invoke<PreviewResult>(command, request);
    pendingPreview =
      pending.kind === "branch"
        ? {
            ...pending,
            names: preview.candidates,
            dropped: preview.dropped,
            nonce: preview.nonce,
            branch: { ...pending.branch, targetOid: preview.targetOid },
          }
        : { ...pending, names: preview.candidates, dropped: preview.dropped, nonce: preview.nonce };
    // The preview re-read Git and published a newer version; adopting it
    // would re-enter this function, which the flag above keeps suppressed.
    applySnapshot(preview.snapshot);
    renderPreviewPanel();
    writeStatus.textContent = "The status changed; the preview was recomputed.";
  } catch (error) {
    closePreviewPanel();
    showError(error);
    writeStatus.textContent = "The preview is no longer valid.";
  } finally {
    previewRenewing = false;
  }
}

function closePreviewPanel(message?: string): void {
  pendingPreview = null;
  renderPreviewPanel();
  if (message) writeStatus.textContent = message;
}

async function confirmPreview(): Promise<void> {
  if (!pendingPreview || writeRunning) return;
  const { kind, nonce } = pendingPreview;
  const branchName = pendingPreview.kind === "branch" ? pendingPreview.branch.name : null;
  writeRunning = true;
  syncCommitControls();
  renderFileRows();
  writeStatus.textContent =
    kind === "discard"
      ? "Discarding work-tree changes…"
      : kind === "clean"
        ? "Deleting untracked files…"
        : "Deleting branch…";
  try {
    const result = await invoke<OperationResult>(
      kind === "discard"
        ? "discard_files"
        : kind === "clean"
          ? "clean_files"
          : "delete_branch",
      { nonce },
    );
    // Consume the panel before applying the snapshot so the version guard
    // does not schedule a renew for an operation that already ran.
    pendingPreview = null;
    renderPreviewPanel();
    applySnapshot(result.snapshot);
    writeStatus.textContent = result.details
      ? `${result.message} ${result.details}`
      : result.message;
    // Git refused an unmerged branch with -d: force is a *separate*
    // confirmation with a stronger warning, never an automatic retry.
    if (
      kind === "branch" &&
      branchName &&
      result.outcome === "failed" &&
      result.details?.toLowerCase().includes("not fully merged")
    ) {
      offerBranchForceDelete(branchName);
    }
  } catch (error) {
    showError(error);
    writeStatus.textContent = "The operation did not run.";
  } finally {
    writeRunning = false;
    syncCommitControls();
    renderFileRows();
  }
}

previewConfirmButton.addEventListener("click", () => void confirmPreview());
previewKeepButton.addEventListener("click", () =>
  closePreviewPanel("Cancelled; nothing was changed."),
);

// --- History (M3-02): read-only commit browsing ---------------------------
// Rows come from the backend's fixed-field log protocol; commits are
// addressed only by full object ids and the frontend never builds Git
// arguments or parses Git output itself.

type CommitView = {
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
};

type HistoryPage = { start: number; commits: CommitView[]; hasMore: boolean };

type CommitFileView = { status: string; path: string; oldPath: string | null };

const historyList = document.querySelector<HTMLElement>("#history-list")!;
const historyMoreButton = document.querySelector<HTMLButtonElement>("#history-more")!;
const historyStatus = document.querySelector<HTMLElement>("#history-status")!;
const commitDetail = document.querySelector<HTMLElement>("#commit-detail")!;
const detailMeta = document.querySelector<HTMLElement>("#detail-meta")!;
const detailMessage = document.querySelector<HTMLElement>("#detail-message")!;
const detailFiles = document.querySelector<HTMLElement>("#detail-files")!;
const copyOidButton = document.querySelector<HTMLButtonElement>("#copy-oid")!;
const diffCommitButton = document.querySelector<HTMLButtonElement>("#diff-commit")!;

let historyCommits: CommitView[] = [];
let historyHasMore = false;
let historyLoading = false;
// undefined = no session; null = session without commits (unborn HEAD or
// bare repo); a string = the HEAD oid the loaded pages belong to.
let historyRepoKey: string | null | undefined;
let selectedCommit: CommitView | null = null;

function historyPlaceholder(message: string): void {
  historyCommits = [];
  historyHasMore = false;
  historyMoreButton.disabled = true;
  historyStatus.textContent = "";
  const row = document.createElement("div");
  row.className = "file-row placeholder";
  row.textContent = message;
  historyList.replaceChildren(row);
}

// Driven from renderSnapshot: a moved HEAD (commit, switch, external write)
// re-reads page zero; a re-render of the same HEAD never touches Git.
function syncHistoryWithSnapshot(): void {
  const key = currentSnapshot ? currentSnapshot.branch?.oid ?? null : undefined;
  if (key === historyRepoKey) return;
  historyRepoKey = key;
  selectedCommit = null;
  commitDetail.hidden = true;
  if (key === undefined) historyPlaceholder("Open a repository to browse its history.");
  else if (key === null) historyPlaceholder("No commits yet.");
  else void loadHistory(true);
}

async function loadHistory(reset: boolean): Promise<void> {
  if (historyLoading || !currentSnapshot) return;
  if (!reset && !historyHasMore) return;
  if (reset) historyPlaceholder("Loading history…");
  historyLoading = true;
  historyMoreButton.disabled = true;
  try {
    const page = await invoke<HistoryPage>("history_page", {
      start: historyCommits.length,
      oid: null,
    });
    // The session may have closed or moved on while this request ran.
    if (historyRepoKey !== (currentSnapshot?.branch?.oid ?? null)) return;
    historyCommits = reset ? page.commits : historyCommits.concat(page.commits);
    historyHasMore = page.hasMore;
    historyStatus.textContent = `${historyCommits.length} commit(s)`
      + (historyHasMore ? " so far." : " — all loaded.");
    renderHistoryRows();
  } catch (error) {
    showError(error);
    historyPlaceholder("History could not be loaded.");
  } finally {
    historyLoading = false;
    historyMoreButton.disabled = !historyHasMore;
  }
}

function renderHistoryRows(): void {
  const rows = historyCommits.map((commit) => {
    const row = document.createElement("div");
    row.className = "file-row" + (selectedCommit?.oid === commit.oid ? " selected" : "");
    row.setAttribute("role", "listitem");
    const button = document.createElement("button");
    button.className = "history-select";
    button.textContent = `${commit.subject}  · ${commit.oid.slice(0, 8)}`;
    button.title = commit.oid;
    button.addEventListener("click", () => void selectCommit(commit));
    row.append(button);
    if (commit.refs.length > 0) {
      const badge = document.createElement("span");
      badge.className = "history-refs";
      badge.textContent = commit.refs.join(" · ");
      badge.title = commit.refs.join(" · ");
      row.append(badge);
    }
    const when = document.createElement("span");
    when.className = "history-date";
    when.textContent = commit.authorDate.slice(0, 10);
    row.append(when);
    return row;
  });
  historyList.replaceChildren(...rows);
}

function detailFileNote(message: string): HTMLElement {
  const item = document.createElement("li");
  item.textContent = message;
  return item;
}

async function selectCommit(commit: CommitView): Promise<void> {
  selectedCommit = commit;
  renderHistoryRows();
  commitDetail.hidden = false;
  detailMessage.textContent = commit.message;
  const meta: Array<[string, string]> = [
    ["Commit", commit.oid],
    ["Author", `${commit.authorName} <${commit.authorEmail}> · ${commit.authorDate}`],
    ["Committer", `${commit.committerName} · ${commit.commitDate}`],
  ];
  if (commit.refs.length > 0) meta.push(["Refs", commit.refs.join(", ")]);
  detailMeta.replaceChildren();
  for (const [term, value] of meta) {
    const dt = document.createElement("dt");
    dt.textContent = term;
    const dd = document.createElement("dd");
    dd.textContent = value;
    detailMeta.append(dt, dd);
  }
  detailFiles.replaceChildren(detailFileNote("Loading files…"));
  try {
    const files = await invoke<CommitFileView[]>("commit_files", { oid: commit.oid });
    if (selectedCommit !== commit) return;
    if (files.length === 0) {
      detailFiles.replaceChildren(
        detailFileNote("No files changed against its first parent."),
      );
    } else {
      detailFiles.replaceChildren(...files.map((file) => {
        const item = document.createElement("li");
        const status = document.createElement("span");
        status.className = "file-status";
        status.textContent = file.status;
        item.append(status, document.createTextNode(
          file.oldPath ? `${file.oldPath} → ${file.path}` : file.path,
        ));
        return item;
      }));
    }
  } catch (error) {
    if (selectedCommit !== commit) return;
    showError(error);
    detailFiles.replaceChildren(detailFileNote("The file list could not be loaded."));
  }
}

// Shares the external-tool lane with file diffs: one blocking tool at a
// time, while staging and committing stay available.
async function runCommitDiff(): Promise<void> {
  if (!selectedCommit || toolRunning) return;
  toolRunning = true;
  syncCommitControls();
  historyStatus.textContent = "Waiting for the diff tool to close…";
  try {
    const result = await invoke<ToolResult>("open_commit_diff", { oid: selectedCommit.oid });
    applySnapshot(result.snapshot);
    historyStatus.textContent = result.details
      ? `${result.message} ${result.details}`
      : result.message;
  } catch (error) {
    showError(error);
    historyStatus.textContent = "The diff tool did not run.";
  } finally {
    toolRunning = false;
    syncCommitControls();
  }
}

historyMoreButton.addEventListener("click", () => void loadHistory(false));
diffCommitButton.addEventListener("click", () => void runCommitDiff());
copyOidButton.addEventListener("click", () => {
  if (!selectedCommit) return;
  const oid = selectedCommit.oid;
  void navigator.clipboard.writeText(oid).then(
    () => {
      historyStatus.textContent = "Commit id copied.";
    },
    () => {
      // Honest fallback: show the full id rather than claim a copy.
      historyStatus.textContent = `Clipboard unavailable — commit id: ${oid}`;
    },
  );
});

// --- References (M3-03): read-only branch and tag listing -----------------
// Names come from the backend's fixed-field for-each-ref protocol. Refs
// whose raw bytes do not round-trip through the display form are listed
// but flagged non-addressable, so no write action can ever target a
// look-alike ref name.

type BranchRef = {
  name: string;
  oid: string;
  head: boolean;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  upstreamGone: boolean;
  addressable: boolean;
};

type RemoteRef = { name: string; oid: string; symref: string | null };

type TagRef = {
  name: string;
  oid: string;
  targetOid: string | null;
  annotated: boolean;
  addressable: boolean;
};

type RefListing = { branches: BranchRef[]; remotes: RemoteRef[]; tags: TagRef[] };

const refList = document.querySelector<HTMLElement>("#ref-list")!;
const refStatus = document.querySelector<HTMLElement>("#ref-status")!;
const branchNameInput = document.querySelector<HTMLInputElement>("#branch-name")!;
const branchCreateButton = document.querySelector<HTMLButtonElement>("#branch-create")!;
const branchForceButton = document.querySelector<HTMLButtonElement>("#branch-force")!;
const branchFromCommitButton = document.querySelector<HTMLButtonElement>("#branch-from-commit")!;

let refsRequestSeq = 0;
let refsSnapshotVersion = -1;
let lastRefs: RefListing | null = null;
let renamingBranch: string | null = null;
let branchStartOid: string | null = null;
let branchForceTarget: string | null = null;

function refPlaceholderRow(message: string): HTMLElement {
  const row = document.createElement("div");
  row.className = "file-row placeholder";
  row.textContent = message;
  return row;
}

function refPlaceholder(message: string): void {
  refsSnapshotVersion = -1;
  lastRefs = null;
  renamingBranch = null;
  branchStartOid = null;
  hideBranchForce();
  refStatus.textContent = "";
  refList.replaceChildren(refPlaceholderRow(message));
}

// Driven from renderSnapshot: every newly accepted snapshot version
// re-reads refs once (writes, watcher and focus refreshes all flow through
// there); a re-render of the same version never touches Git.
function syncRefsWithSnapshot(): void {
  if (!currentSnapshot) {
    if (refsSnapshotVersion !== -1) {
      refPlaceholder("Open a repository to list its branches and tags.");
    }
    return;
  }
  if (currentSnapshot.version === refsSnapshotVersion) return;
  refsSnapshotVersion = currentSnapshot.version;
  void loadRefs();
}

async function loadRefs(): Promise<void> {
  const seq = ++refsRequestSeq;
  refStatus.textContent = "Loading references…";
  try {
    const listing = await invoke<RefListing>("list_refs");
    if (seq !== refsRequestSeq) return; // a newer request took over
    renderRefs(listing);
    refStatus.textContent = `${listing.branches.length} branch(es), `
      + `${listing.remotes.length} remote ref(s), ${listing.tags.length} tag(s).`;
  } catch (error) {
    if (seq !== refsRequestSeq) return;
    showError(error);
    refStatus.textContent = "The ref listing could not be loaded.";
  }
}

// Branch writes share the backend write queue, so they ride the same
// writeRunning lane as staging and committing; the fresh snapshot returned
// by the backend flows through the standard version guard.
async function runBranch(
  command: "create_branch" | "switch_branch" | "rename_branch",
  args: Record<string, unknown>,
  running: string,
): Promise<OperationResult | null> {
  if (!currentSnapshot || writeRunning) return null;
  writeRunning = true;
  syncCommitControls();
  if (lastRefs) renderRefs(lastRefs);
  refStatus.textContent = running;
  try {
    const result = await invoke<OperationResult>(command, {
      snapshotVersion: currentSnapshot.version,
      ...args,
    });
    applySnapshot(result.snapshot);
    refStatus.textContent = result.details
      ? `${result.message} ${result.details}`
      : result.message;
    return result;
  } catch (error) {
    showError(error);
    refStatus.textContent = "The branch operation did not run.";
    return null;
  } finally {
    writeRunning = false;
    syncCommitControls();
    if (lastRefs) renderRefs(lastRefs);
  }
}

function offerBranchForceDelete(name: string): void {
  branchForceTarget = name;
  branchForceButton.hidden = false;
  branchForceButton.textContent = `Force delete "${name}"…`;
}

function hideBranchForce(): void {
  branchForceTarget = null;
  branchForceButton.hidden = true;
}

branchForceButton.addEventListener("click", () => {
  if (!branchForceTarget) return;
  const name = branchForceTarget;
  hideBranchForce();
  void requestBranchDelete(name, true);
});

async function requestBranchDelete(name: string, force: boolean): Promise<void> {
  if (!currentSnapshot || writeRunning || pendingPreview) return;
  hideBranchForce();
  refStatus.textContent = `Checking what deleting ${name} would remove…`;
  try {
    const preview = await invoke<PreviewResult>("preview_delete_branch", {
      snapshotVersion: currentSnapshot.version,
      name,
      force,
    });
    applySnapshot(preview.snapshot);
    pendingPreview = {
      kind: "branch",
      names: preview.candidates,
      dropped: preview.dropped,
      nonce: preview.nonce,
      branch: { name, force, targetOid: preview.targetOid },
    };
    renderPreviewPanel();
    previewConfirmButton.focus();
  } catch (error) {
    showError(error);
    refStatus.textContent = "The branch deletion was refused before anything changed.";
  }
}

async function createBranchFromInput(): Promise<void> {
  const name = branchNameInput.value.trim();
  if (!name || !currentSnapshot || writeRunning) return;
  const startOid = branchStartOid;
  const result = await runBranch(
    "create_branch",
    startOid ? { name, startOid } : { name },
    `Creating branch ${name}…`,
  );
  if (result?.outcome === "success") {
    branchNameInput.value = "";
    branchStartOid = null;
  }
}

branchCreateButton.addEventListener("click", () => void createBranchFromInput());
branchNameInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    void createBranchFromInput();
  }
});
branchNameInput.addEventListener("input", () => syncBranchControls());
branchFromCommitButton.addEventListener("click", () => {
  if (!selectedCommit) return;
  branchStartOid = selectedCommit.oid;
  branchNameInput.focus();
  refStatus.textContent = `New branch will start at ${selectedCommit.oid.slice(0, 10)} — `
    + "enter a name and press Create branch.";
});

function syncBranchControls(): void {
  branchNameInput.disabled = !sessionActive || writeRunning;
  branchCreateButton.disabled =
    !sessionActive || writeRunning || branchNameInput.value.trim() === "";
  branchFromCommitButton.disabled = !sessionActive || writeRunning || selectedCommit === null;
}

function refRowButton(
  label: string,
  aria: string,
  handler: () => void,
  danger = false,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = "row-action" + (danger ? " danger" : "");
  button.textContent = label;
  button.setAttribute("aria-label", aria);
  button.disabled = writeRunning;
  button.addEventListener("click", handler);
  return button;
}

async function renameBranchThrough(oldName: string, newName: string): Promise<void> {
  const result = await runBranch(
    "rename_branch",
    { old: oldName, new: newName },
    `Renaming ${oldName}…`,
  );
  if (result) renamingBranch = null;
  if (lastRefs) renderRefs(lastRefs);
}

function renderRefs(listing: RefListing): void {
  lastRefs = listing;
  const rows: HTMLElement[] = [];
  const heading = (text: string) => {
    const el = document.createElement("div");
    el.className = "ref-heading";
    el.textContent = text;
    return el;
  };
  const row = (marker: string, name: string, meta: string, addressable: boolean) => {
    const el = document.createElement("div");
    el.className = "file-row ref-row";
    el.setAttribute("role", "listitem");
    const badge = document.createElement("span");
    badge.className = "file-status";
    badge.textContent = marker;
    const label = document.createElement("span");
    label.className = "ref-name";
    label.textContent = name;
    el.append(badge, label);
    if (!addressable) {
      label.classList.add("inert-ref");
      label.title = "This ref name is not byte-round-trippable; shown read-only.";
    }
    if (meta) {
      const metaEl = document.createElement("span");
      metaEl.className = "ref-meta";
      metaEl.textContent = meta;
      el.append(metaEl);
    }
    return el;
  };
  rows.push(heading(`Branches (${listing.branches.length})`));
  for (const branch of listing.branches) {
    const parts: string[] = [];
    if (branch.upstream) parts.push(`→ ${branch.upstream}`);
    if (branch.upstreamGone) parts.push("upstream gone");
    if (branch.ahead !== null) parts.push(`↑${branch.ahead}`);
    if (branch.behind !== null) parts.push(`↓${branch.behind}`);
    const el = row(branch.head ? "*" : "", branch.name, parts.join("  "), branch.addressable);
    // Only byte-round-trippable names can be write targets (plan/04); the
    // checked-out branch can be renamed but never switched away or deleted.
    if (branch.addressable && renamingBranch === branch.name) {
      el.classList.add("renaming");
      const input = document.createElement("input");
      input.type = "text";
      input.className = "ref-rename";
      input.value = branch.name;
      input.disabled = writeRunning;
      input.setAttribute("aria-label", `New name for ${branch.name}`);
      const cancel = refRowButton("Cancel", `Cancel renaming ${branch.name}`, () => {
        renamingBranch = null;
        if (lastRefs) renderRefs(lastRefs);
      });
      const save = refRowButton("Save", `Rename ${branch.name} to the entered name`, () => {
        const next = input.value.trim();
        if (!next || next === branch.name) {
          renamingBranch = null;
          if (lastRefs) renderRefs(lastRefs);
          return;
        }
        void renameBranchThrough(branch.name, next);
      });
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          save.click();
        } else if (event.key === "Escape") {
          event.preventDefault();
          cancel.click();
        }
      });
      el.append(input, save, cancel);
    } else if (branch.addressable) {
      if (!branch.head) {
        el.append(
          refRowButton("Switch", `Switch to ${branch.name}`, () =>
            void runBranch("switch_branch", { name: branch.name }, `Switching to ${branch.name}…`),
          ),
        );
      }
      el.append(
        refRowButton("Rename", `Rename branch ${branch.name}`, () => {
          renamingBranch = branch.name;
          if (lastRefs) renderRefs(lastRefs);
        }),
      );
      if (!branch.head) {
        el.append(
          refRowButton(
            "Delete",
            `Delete branch ${branch.name}`,
            () => void requestBranchDelete(branch.name, false),
            true,
          ),
        );
      }
    }
    rows.push(el);
  }
  rows.push(heading(`Remote branches (${listing.remotes.length})`));
  for (const remote of listing.remotes) {
    const meta = remote.symref ? `symref → ${remote.symref}` : remote.oid.slice(0, 8);
    rows.push(row("", remote.name, meta, true));
  }
  rows.push(heading(`Tags (${listing.tags.length})`));
  for (const tag of listing.tags) {
    const target = tag.targetOid ?? tag.oid;
    rows.push(
      row(
        tag.annotated ? "T" : "",
        tag.name,
        `${tag.annotated ? "annotated" : "lightweight"} → ${target.slice(0, 8)}`,
        tag.addressable,
      ),
    );
  }
  refList.replaceChildren(...rows);
}

function toggleGroup(group: FileGroupKey): void {
  if (collapsedGroups.has(group)) collapsedGroups.delete(group);
  else collapsedGroups.add(group);
  listRows = buildRows(currentFiles, collapsedGroups);
  syncSelection();
  renderFileRows();
}

fileScroll.addEventListener(
  "scroll",
  () => {
    if (listRows.length > 0) renderFileRows();
  },
  { passive: true },
);
window.addEventListener("resize", () => {
  if (listRows.length > 0) renderFileRows();
});

// Keyboard navigation over the virtual list: arrows move between files
// (headings skipped), Home/End jump, Enter toggles the selected file's group.
fileScroll.addEventListener("keydown", (event) => {
  if (listRows.length === 0) return;
  // A focused row button handles its own keys (Enter/Space activate it).
  if ((event.target as HTMLElement).closest(".row-action")) return;
  const viewport = fileScroll.clientHeight || 320;
  const edge = (delta: number) => nextSelectableRow(listRows, delta > 0 ? -1 : listRows.length, delta);
  let target = -2;
  switch (event.key) {
    case "ArrowDown":
      target = selectedRow < 0 ? edge(1) : nextSelectableRow(listRows, selectedRow, 1);
      break;
    case "ArrowUp":
      target = selectedRow < 0 ? edge(-1) : nextSelectableRow(listRows, selectedRow, -1);
      break;
    case "Home":
      target = edge(1);
      break;
    case "End":
      target = edge(-1);
      break;
    case "Enter": {
      const row = listRows[selectedRow];
      if (row && row.kind === "file") toggleGroup(row.file.group);
      event.preventDefault();
      return;
    }
    default:
      return;
  }
  event.preventDefault();
  if (target < 0 || target === selectedRow) return;
  const row = listRows[target];
  selectedRow = target;
  selectedFileId = row.kind === "file" ? row.file.id : null;
  fileScroll.scrollTop = revealScroll(fileScroll.scrollTop, viewport, target, ROW_HEIGHT);
  renderFileRows();
});

async function openRepository(path: string): Promise<void> {
  openRepoButton.disabled = true;
  // A pending confirmation ticket belongs to the closing session; the
  // backend would refuse it anyway, so drop the panel up front.
  closePreviewPanel();
  try {
    const snapshot = await invoke<SnapshotView>("open_repository", { path });
    currentSnapshot = snapshot;
    renderSnapshot(snapshot);
    renderRecent(await invoke<string[]>("list_recent_repositories"));
  } catch (error) {
    showError(error);
    // The backend keeps the previous session untouched; redraw it unchanged.
    renderSnapshot(currentSnapshot);
  } finally {
    openRepoButton.disabled = false;
  }
}

async function pickRepository(): Promise<void> {
  try {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === "string") await openRepository(selected);
  } catch (error) {
    showError(error);
  }
}

openRepoButton.addEventListener("click", () => void pickRepository());

// Font scaling drives every rem-based size in the stylesheet; the choice is
// persisted in the WebView's localStorage and restored on startup.
const FONT_KEY = "guit.fontPx";
const FONT_MIN = 12;
const FONT_MAX = 24;
const FONT_DEFAULT = 16;

function currentFontPx(): number {
  const stored = Number(localStorage.getItem(FONT_KEY));
  return stored >= FONT_MIN && stored <= FONT_MAX ? stored : FONT_DEFAULT;
}

function applyFontPx(px: number): void {
  const clamped = Math.min(FONT_MAX, Math.max(FONT_MIN, px));
  document.documentElement.style.fontSize = `${clamped}px`;
  try {
    localStorage.setItem(FONT_KEY, String(clamped));
  } catch {
    // Storage may be unavailable in private mode; scaling still applies.
  }
}

applyFontPx(currentFontPx());

window.addEventListener("keydown", (event) => {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
  const key = event.key.toLowerCase();
  if (key === "r") {
    event.preventDefault();
    if (sessionActive) void refreshSession(false);
  } else if (key === "o") {
    event.preventDefault();
    void pickRepository();
  } else if (key === "=" || key === "+") {
    event.preventDefault();
    applyFontPx(currentFontPx() + 1);
  } else if (key === "-") {
    event.preventDefault();
    applyFontPx(currentFontPx() - 1);
  } else if (key === "0") {
    event.preventDefault();
    applyFontPx(FONT_DEFAULT);
  }
});

refreshRepoButton.addEventListener("click", async () => {
  refreshRepoButton.disabled = true;
  await refreshSession(false);
});

closeRepoButton.addEventListener("click", async () => {
  try {
    await invoke("close_repository");
    currentSnapshot = null;
    renderSnapshot(null);
  } catch (error) {
    showError(error);
  }
});

const cloneSource = document.querySelector<HTMLInputElement>("#clone-source")!;
const clonePickDir = document.querySelector<HTMLButtonElement>("#clone-pick-dir")!;
const cloneStart = document.querySelector<HTMLButtonElement>("#clone-start")!;
const cloneCancel = document.querySelector<HTMLButtonElement>("#clone-cancel")!;
const cloneStatus = document.querySelector<HTMLElement>("#clone-status")!;
let cloneParent: string | undefined;

clonePickDir.addEventListener("click", async () => {
  try {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === "string") {
      cloneParent = selected;
      cloneStart.disabled = cloneSource.value.trim() === "";
      cloneStatus.textContent = `Destination: ${selected}`;
    }
  } catch (error) {
    showError(error);
  }
});

cloneSource.addEventListener("input", () => {
  cloneStart.disabled =
    cloneParent === undefined || cloneSource.value.trim() === "";
});

cloneCancel.addEventListener("click", async () => {
  try {
    await invoke("cancel_clone");
    cloneStatus.textContent = "Cancellation requested; stopping Git…";
  } catch (error) {
    showError(error);
  }
});

cloneStart.addEventListener("click", async () => {
  if (cloneParent === undefined) return;
  const source = cloneSource.value.trim();
  cloneStart.disabled = true;
  clonePickDir.disabled = true;
  cloneSource.disabled = true;
  cloneCancel.disabled = false;
  cloneStatus.textContent = "Cloning…";
  let unlisten: (() => void) | undefined;
  try {
    unlisten = await listen<string>("clone-progress", ({ payload }) => {
      cloneStatus.textContent = payload;
    });
    const result = await invoke<CloneResult>("clone_repository", {
      source,
      parent: cloneParent,
    });
    if (result.success) {
      cloneStatus.textContent = `${result.message} Opening ${result.target}…`;
      await openRepository(result.target);
    } else {
      cloneStatus.textContent = result.message;
      if (result.residue) {
        // guit never deletes anything: the user decides what to do with it.
        showError(
          result.cancelled
            ? `The cancelled clone left a partial folder at ${result.residue}. guit will not remove it automatically.`
            : `The failed clone left a folder at ${result.residue}. guit will not remove it automatically.`,
        );
      }
    }
    cloneSource.value = "";
  } catch (error) {
    showError(error);
    cloneStatus.textContent = "Clone failed.";
  } finally {
    unlisten?.();
    clonePickDir.disabled = false;
    cloneSource.disabled = false;
    cloneCancel.disabled = true;
    cloneStart.disabled = cloneSource.value.trim() === "";
  }
});


function saveWindowSettings(): Promise<void> {
  saveQueue = saveQueue.then(persistWindowSettings);
  return saveQueue;
}

async function persistWindowSettings(): Promise<void> {
  try {
    const [scale, position, maximized, outer] = await Promise.all([
      currentWindow.scaleFactor(),
      currentWindow.outerPosition(),
      currentWindow.isMaximized(),
      currentWindow.outerSize(),
    ]);
    const size = { width: Math.round(window.innerWidth * scale), height: Math.round(window.innerHeight * scale) };
    const frame = { frameWidth: Math.max(0, outer.width - size.width), frameHeight: Math.max(0, outer.height - size.height) };
    if (!maximized) {
      lastNormalBounds = { ...size, ...frame, x: position.x, y: position.y };
    }
    const bounds = lastNormalBounds ?? { ...size, ...frame, x: position.x, y: position.y };
    await invoke("save_window_settings", {
      settings: {
        ...bounds,
        schemaVersion: 1,
        alwaysOnTop: onTop.checked,
        maximized,
      } satisfies WindowSettings,
    });
  } catch (error) {
    showError(error);
  }
}

function scheduleWindowSave(): void {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void saveWindowSettings(), 400);
}

function showError(error: unknown): void {
  if (error && typeof error === "object" && "message" in error) {
    errorElement.textContent = String(error.message);
  } else {
    errorElement.textContent = typeof error === "string" ? error : String(error);
  }
  errorElement.hidden = false;
}

async function refresh(): Promise<void> {
  const results = await Promise.allSettled([
    invoke<GitProbe>("probe_git"),
    invoke<ToolProbe>("probe_external_tools"),
    Promise.all([
      currentWindow.innerSize(),
      currentWindow.outerSize(),
      currentWindow.scaleFactor(),
      currentWindow.isMaximized(),
    ]),
  ]);
  const [git, tools, size] = results;
  if (git.status === "fulfilled") {
    const value = git.value;
    gitResult.textContent = value.available
      ? `${value.version} · ${value.supported ? "required commands available" : value.message}`
      : value.message;
  } else showError(git.reason);
  if (tools.status === "fulfilled") {
    toolsResult.textContent = `Diff: ${tools.value.difftool ?? "not configured"}; Merge: ${tools.value.mergetool ?? "not configured"}; File opener: ${tools.value.opener}`;
  } else showError(tools.reason);
  if (size.status === "fulfilled") {
    const [inner, outer, scale, maximized] = size.value;
    windowResult.textContent = `Viewport ${window.innerWidth} × ${window.innerHeight} logical; API inner ${inner.width} × ${inner.height}; outer ${outer.width} × ${outer.height}; scale ${scale}; maximized ${maximized}`;
  } else showError(size.reason);
}

document.querySelector<HTMLButtonElement>("#refresh")!.addEventListener("click", () => {
  errorElement.hidden = true;
  void refresh();
});
document.querySelector<HTMLButtonElement>("#choose-folder")!.addEventListener("click", async () => {
  try {
    const selected = await open({ directory: true, multiple: false });
    folderResult.textContent = selected ?? "Selection cancelled";
  } catch (error) {
    showError(error);
  }
});
const restoreWindow = document.querySelector<HTMLButtonElement>("#restore-window")!;
document.querySelector<HTMLButtonElement>("#compact-window")!.addEventListener("click", async () => {
  try {
    previousSize = new LogicalSize(window.innerWidth, window.innerHeight);
    previouslyMaximized = await currentWindow.isMaximized();
    if (previouslyMaximized) await currentWindow.unmaximize();
    await currentWindow.setSize(new LogicalSize(340, 400));
    restoreWindow.disabled = false;
    await refresh();
  } catch (error) {
    showError(error);
  }
});
restoreWindow.addEventListener("click", async () => {
  if (!previousSize) return;
  try {
    if (previouslyMaximized) await currentWindow.maximize();
    else await currentWindow.setSize(previousSize);
    restoreWindow.disabled = true;
    await refresh();
  } catch (error) {
    showError(error);
  }
});
onTop.addEventListener("change", async () => {
  try {
    await currentWindow.setAlwaysOnTop(onTop.checked);
    windowResult.textContent = `Always on top: ${onTop.checked ? "on" : "off"}`;
    scheduleWindowSave();
  } catch (error) {
    onTop.checked = !onTop.checked;
    showError(error);
  }
});

runProbe.addEventListener("click", async () => {
  runProbe.disabled = true;
  cancelProbe.disabled = false;
  probeResult.textContent = "Running…";
  try {
    probeResult.textContent = await invoke<string>("run_process_probe");
  } catch (error) {
    showError(error);
    probeResult.textContent = "Probe failed";
  } finally {
    runProbe.disabled = false;
    cancelProbe.disabled = true;
  }
});

cancelProbe.addEventListener("click", async () => {
  try {
    await invoke("cancel_process_probe");
    probeResult.textContent = "Cancellation requested; checking final state…";
  } catch (error) {
    showError(error);
  }
});

const transferProbe = document.querySelector<HTMLButtonElement>("#transfer-probe")!;
const transferResult = document.querySelector<HTMLElement>("#transfer-result")!;
transferProbe.addEventListener("click", async () => {
  transferProbe.disabled = true;
  let bytes = 0;
  let unlisten: (() => void) | undefined;
  try {
    unlisten = await listen<number>("probe-progress", ({ payload }) => {
      bytes += payload;
      transferResult.textContent = `Receiving Git progress: ${bytes} bytes`;
    });
    transferResult.textContent = await invoke<string>("run_transfer_probe");
  } catch (error) {
    showError(error);
    transferResult.textContent = "Progress probe failed";
  } finally {
    unlisten?.();
    transferProbe.disabled = false;
  }
});

void (async () => {
  try {
    const restored = await invoke<SnapshotView | null>("restore_repository");
    currentSnapshot = restored;
    renderSnapshot(restored);
    renderRecent(await invoke<string[]>("list_recent_repositories"));
  } catch (error) {
    showError(error);
  }
  try {
    const settings = await invoke<WindowSettings | null>("restore_window_settings");
    onTop.checked = settings?.alwaysOnTop ?? false;
    lastNormalBounds = settings
      ? { width: settings.width, height: settings.height, frameWidth: settings.frameWidth, frameHeight: settings.frameHeight, x: settings.x, y: settings.y }
      : undefined;
  } catch (error) {
    showError(error);
  }
  try {
    await currentWindow.onResized(({ payload }) => {
      windowResult.textContent = `Resized to ${payload.width} × ${payload.height} physical pixels`;
      scheduleWindowSave();
    });
    await currentWindow.onMoved(scheduleWindowSave);
    await currentWindow.onFocusChanged(({ payload }) => {
      if (payload) void refreshSession(true);
    });
    await currentWindow.onCloseRequested(async (event) => {
      event.preventDefault();
      window.clearTimeout(saveTimer);
      await saveWindowSettings();
      try {
        await currentWindow.destroy();
      } catch (error) {
        showError(error);
      }
    });
    scheduleWindowSave();
  } catch (error) {
    showError(error);
  }
  await refresh();
})();
