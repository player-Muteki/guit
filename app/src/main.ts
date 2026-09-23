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
  kind: "stage" | "unstage" | "commit" | "discard";
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
};

type ToolPurpose = "openFile" | "diffWorktree" | "diffStaged";

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
    <div id="discard-preview" class="preview" role="alertdialog" aria-label="Confirm discard" hidden>
      <p class="preview-warning">Discarding reverts these files to the index or HEAD. The uncommitted work-tree changes cannot be recovered.</p>
      <ul id="discard-candidates" class="preview-list"></ul>
      <p id="discard-dropped" class="preview-note" hidden></p>
      <div class="actions">
        <button id="discard-confirm" class="danger">Discard</button>
        <button id="discard-keep">Keep changes</button>
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
const discardPanel = document.querySelector<HTMLElement>("#discard-preview")!;
const discardCandidates = document.querySelector<HTMLElement>("#discard-candidates")!;
const discardDropped = document.querySelector<HTMLElement>("#discard-dropped")!;
const discardConfirmButton = document.querySelector<HTMLButtonElement>("#discard-confirm")!;
const discardKeepButton = document.querySelector<HTMLButtonElement>("#discard-keep")!;

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
  // An open discard panel is bound to the snapshot that produced it; a
  // newer snapshot invalidates its file IDs, so recompute the preview.
  if (snapshot) void renewDiscardPreview();
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
  closeRepoButton.disabled = !sessionActive;
  refreshRepoButton.disabled = !sessionActive;
  syncCommitControls();
  repoSummary.textContent = "";
  if (!snapshot) {
    commitMessage.value = "";
    commitAmend.checked = false;
    closeDiscardPreview();
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
      discardAll.disabled = writeRunning || pendingDiscard !== null;
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
    button.disabled = writeRunning || pendingDiscard !== null;
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
  discardConfirmButton.disabled = writeRunning || pendingDiscard === null;
  discardKeepButton.disabled = writeRunning;
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

// --- discard: preview → recheck → confirm (plan/04 破坏性动作协议) ---

let pendingDiscard: { names: string[]; dropped: string[]; nonce: string } | null = null;
let discardRenewing = false;

function discardEligible(file: FileView): boolean {
  // Untracked files go through clean (M2-06); conflicts through mergetool
  // (M4); only work-tree-side changes can be discarded.
  return file.unstaged && !file.conflict && !file.untracked;
}

function renderDiscardPanel(): void {
  if (!pendingDiscard) {
    discardPanel.hidden = true;
    return;
  }
  discardPanel.hidden = false;
  discardCandidates.replaceChildren(
    ...pendingDiscard.names.map((name) => {
      const item = document.createElement("li");
      item.textContent = name;
      return item;
    }),
  );
  discardDropped.hidden = pendingDiscard.dropped.length === 0;
  discardDropped.textContent = `Skipped (no work-tree changes): ${pendingDiscard.dropped.join(", ")}`;
  syncCommitControls();
}

async function requestDiscard(fileIds: number[]): Promise<void> {
  if (!currentSnapshot || writeRunning || pendingDiscard) return;
  writeStatus.textContent = "Checking what a discard would revert…";
  try {
    const preview = await invoke<PreviewResult>("preview_discard", {
      snapshotVersion: currentSnapshot.version,
      fileIds,
    });
    // Apply the backend's re-read first (it published a newer version);
    // with no pending discard the renew hook stays quiet.
    applySnapshot(preview.snapshot);
    pendingDiscard = { names: preview.candidates, dropped: preview.dropped, nonce: preview.nonce };
    renderDiscardPanel();
    discardConfirmButton.focus();
  } catch (error) {
    showError(error);
    writeStatus.textContent = "The discard was refused before anything changed.";
  }
}

// The backend consumes the nonce and re-verifies the candidate set itself;
// this only recomputes file IDs against the newest snapshot, because IDs are
// per-snapshot. A candidate that vanished or multiplied forces a fresh
// preview instead of guessing which file the old ID pointed at.
async function renewDiscardPreview(): Promise<void> {
  if (!pendingDiscard || discardRenewing || !currentSnapshot) return;
  const ids: number[] = [];
  for (const name of pendingDiscard.names) {
    const matches = currentFiles.filter((file) => file.display === name && discardEligible(file));
    if (matches.length !== 1) {
      closeDiscardPreview("The changed files moved after the preview; ask for the discard again.");
      return;
    }
    ids.push(matches[0].id);
  }
  discardRenewing = true;
  try {
    const preview = await invoke<PreviewResult>("preview_discard", {
      snapshotVersion: currentSnapshot.version,
      fileIds: ids,
    });
    pendingDiscard = { names: preview.candidates, dropped: preview.dropped, nonce: preview.nonce };
    // The preview re-read Git and published a newer version; adopting it
    // would re-enter this function, which the flag above keeps suppressed.
    applySnapshot(preview.snapshot);
    renderDiscardPanel();
    writeStatus.textContent = "The status changed; the discard preview was recomputed.";
  } catch (error) {
    closeDiscardPreview();
    showError(error);
    writeStatus.textContent = "The discard preview is no longer valid.";
  } finally {
    discardRenewing = false;
  }
}

function closeDiscardPreview(message?: string): void {
  pendingDiscard = null;
  renderDiscardPanel();
  if (message) writeStatus.textContent = message;
}

async function confirmDiscard(): Promise<void> {
  if (!pendingDiscard || writeRunning) return;
  const nonce = pendingDiscard.nonce;
  writeRunning = true;
  syncCommitControls();
  renderFileRows();
  writeStatus.textContent = "Discarding work-tree changes…";
  try {
    const result = await invoke<OperationResult>("discard_files", { nonce });
    // Consume the panel before applying the snapshot so the version guard
    // does not schedule a renew for a discard that already ran.
    pendingDiscard = null;
    renderDiscardPanel();
    applySnapshot(result.snapshot);
    writeStatus.textContent = result.details
      ? `${result.message} ${result.details}`
      : result.message;
  } catch (error) {
    showError(error);
    writeStatus.textContent = "The discard did not run.";
  } finally {
    writeRunning = false;
    syncCommitControls();
    renderFileRows();
  }
}

discardConfirmButton.addEventListener("click", () => void confirmDiscard());
discardKeepButton.addEventListener("click", () =>
  closeDiscardPreview("Discard cancelled; nothing was reverted."),
);

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
  // A pending discard ticket belongs to the closing session; the backend
  // would refuse it anyway, so drop the panel up front.
  closeDiscardPreview();
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
