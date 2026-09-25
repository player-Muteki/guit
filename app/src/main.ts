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

type OperationView = {
  kind: "merge" | "rebase" | "cherryPick" | "revert" | "unknown";
  subject: string;
  step: number | null;
  total: number | null;
};

type SnapshotView = {
  version: number;
  repo: RepoView;
  branch: BranchView | null;
  files: FileView[];
  operation: OperationView | null;
};

// Heuristic cause of a failed network operation, decided in Rust; the
// frontend only displays it, never re-derives it from text.
type NetCategory =
  | "auth"
  | "network"
  | "nonfastforward"
  | "protectedbranch"
  | "remotehookrejected"
  | "stalelease"
  | "notfound"
  | "other";

type CloneResult = {
  target: string;
  success: boolean;
  cancelled: boolean;
  message: string;
  category: NetCategory | null;
  suggestion: string | null;
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

type PreviewResult = {
  nonce: string;
  candidates: string[];
  dropped: string[];
  snapshot: SnapshotView;
  targetOid: string | null;
};

type ToolPurpose = "openFile" | "diffWorktree" | "diffStaged" | "diffCommit" | "mergeFile";

type ToolResult = {
  operationId: number;
  purpose: ToolPurpose;
  outcome: "success" | "failed" | "cancelled" | "rejected" | "conflicted";
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
    <div id="operation-banner" class="preview" role="alert" hidden>
      <p id="operation-summary"></p>
      <div class="actions">
        <button id="operation-continue">Continue</button>
        <button id="operation-skip">Skip</button>
        <button id="operation-abort" class="danger">Abort</button>
      </div>
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
    <div class="actions">
      <input id="tag-name" type="text" placeholder="New tag name" aria-label="New tag name" disabled />
      <input id="tag-message" type="text" placeholder="Annotation — blank makes a lightweight tag" aria-label="Tag annotation (optional)" disabled />
      <button id="tag-create" disabled>Create tag</button>
    </div>
    <div id="ref-list" class="refs" role="list" aria-label="Branches and tags">
      <div class="file-row placeholder">Open a repository to list its branches and tags.</div>
    </div>
    <p id="ref-status" role="status"></p>
    <div id="tag-detail" class="detail" hidden>
      <dl id="tag-detail-meta"></dl>
      <pre id="tag-detail-message" class="commit-message"></pre>
      <div class="actions">
        <button id="tag-detail-close">Close</button>
      </div>
    </div>
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
        <button id="tag-from-commit">Tag from commit…</button>
        <button id="cherry-pick-commit" title="Apply this commit onto the current branch">Cherry-pick</button>
        <button id="revert-commit" title="Create a new commit undoing this one on the current branch">Revert</button>
        <button id="reset-soft" title="Move the branch to this commit; keep the index and all file contents">Reset soft</button>
        <button id="reset-mixed" title="Move the branch and index to this commit; keep file contents">Reset mixed</button>
        <button id="reset-hard" class="danger" title="Move the branch to this commit and overwrite working-copy changes (with confirmation)">Reset hard…</button>
      </div>
    </div>
  </section>
  <section class="card">
    <h2>Stash</h2>
    <div class="actions">
      <input id="stash-message" type="text" placeholder="Stash message — blank uses Git's default WIP subject" aria-label="Stash message" disabled />
      <button id="stash-save" disabled title="Stashes tracked-file changes only; untracked files stay in place">Stash changes</button>
    </div>
    <div id="stash-list" class="refs" role="list" aria-label="Stashed changes">
      <div class="file-row placeholder">Open a repository to list its stashes.</div>
    </div>
    <p id="stash-status" role="status"></p>
  </section>
  <section class="card">
    <h2>Worktrees</h2>
    <div class="actions">
      <input id="worktree-target" type="text" placeholder="Local branch name or full commit id" aria-label="Worktree target" disabled />
      <button id="worktree-add" disabled title="Choose a folder, then register a new linked worktree">Add worktree…</button>
      <button id="worktree-prune" disabled title="Forget Git's records of worktree folders that no longer exist">Prune stale</button>
    </div>
    <div id="worktree-list" class="refs" role="list" aria-label="Linked worktrees">
      <div class="file-row placeholder">Open a repository to list its worktrees.</div>
    </div>
    <p id="worktree-status" role="status"></p>
  </section>
  <section class="card">
    <h2>Submodules</h2>
    <div class="actions">
      <button id="submodule-update-all" disabled title="Initialize and update every listed submodule (git submodule update --init --recursive)">Init &amp; update all</button>
    </div>
    <div id="submodule-list" class="refs" role="list" aria-label="Submodules">
      <div class="file-row placeholder">Open a repository to list its submodules.</div>
    </div>
    <p id="submodule-status" role="status"></p>
  </section>
  <section class="card">
    <h2>Remotes</h2>
    <div class="actions">
      <input id="remote-name" type="text" placeholder="Remote name" aria-label="New remote name" disabled />
      <input id="remote-url" type="text" placeholder="Remote URL or local path" aria-label="New remote URL" disabled />
      <button id="remote-add" disabled title="Register a new remote (git remote add)">Add remote</button>
      <button id="remote-fetch-all" disabled title="Fetch every configured remote (git fetch --prune)">Fetch all</button>
      <select id="pull-strategy" aria-label="Pull strategy" disabled title="How the fetched upstream is integrated into the current branch">
        <option value="default">Git default</option>
        <option value="merge">Merge</option>
        <option value="ffonly">Fast-forward only</option>
        <option value="rebase">Rebase</option>
      </select>
      <button id="remote-pull" disabled title="Fetch the current branch's upstream, then integrate it per the strategy">Pull</button>
      <button id="remote-push" disabled title="Send the current branch to its upstream's remote (git push); never forces">Push</button>
      <select id="publish-remote" aria-label="Publish target remote" disabled title="Remote to create the current branch on"></select>
      <button id="remote-publish" disabled title="First push of the current branch: creates it on the chosen remote and sets it as the upstream (git push --set-upstream)">Publish</button>
      <button id="remote-force-push" disabled hidden title="Preview what overwriting the upstream under --force-with-lease would erase on the remote">Preview force push…</button>
      <button id="remote-auth-retry" disabled hidden title="Retry this operation once, answering Git's credential prompts in this window">Retry with credentials</button>
    </div>
    <div id="remote-list" class="refs" role="list" aria-label="Remotes">
      <div class="file-row placeholder">Open a repository to list its remotes.</div>
    </div>
    <div id="askpass-dialog" class="askpass" hidden role="group" aria-labelledby="askpass-prompt">
      <p id="askpass-prompt"></p>
      <input id="askpass-secret" type="text" autocomplete="off" spellcheck="false" aria-label="Credential" />
      <div class="actions">
        <button id="askpass-submit">Submit</button>
        <button id="askpass-cancel">Cancel</button>
      </div>
    </div>
    <p id="remote-status" role="status"></p>
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
const operationBanner = document.querySelector<HTMLElement>("#operation-banner")!;
const operationSummary = document.querySelector<HTMLElement>("#operation-summary")!;
const operationContinueButton = document.querySelector<HTMLButtonElement>("#operation-continue")!;
const operationSkipButton = document.querySelector<HTMLButtonElement>("#operation-skip")!;
const operationAbortButton = document.querySelector<HTMLButtonElement>("#operation-abort")!;

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
  const counts: string[] = [];
  if (branch.ahead !== null) counts.push(`↑${branch.ahead}`);
  if (branch.behind !== null) counts.push(`↓${branch.behind}`);
  return counts.length
    ? `${name} · ${branch.upstream} ${counts.join(" ")}`
    : `${name} · ${branch.upstream}`;
}

function renderSnapshot(snapshot: SnapshotView | null): void {
  sessionActive = snapshot !== null;
  syncHistoryWithSnapshot();
  syncRefsWithSnapshot();
  syncStashWithSnapshot();
  syncWorktreesWithSnapshot();
  syncSubmodulesWithSnapshot();
  syncRemotesWithSnapshot();
  renderOperationBanner(snapshot);
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
  if (file.conflict) toolActions.push({ label: "Resolve", purpose: "mergeFile" });
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

// Conflicts resolve through the per-row mergetool button, not staging;
// every other group has exactly one sensible per-file write.
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
  syncStashControls();
  syncWorktreeControls();
  syncSubmoduleControls();
  syncRemoteControls();
  syncOperationControls();
}

// --- in-flight operation banner (M4-02) ------------------------------------
// The banner renders solely from the snapshot's `operation` field: which
// command continue/abort/skip maps to is decided by the backend re-reading
// Git's own markers, so the UI never claims a capability it did not detect.
function renderOperationBanner(snapshot: SnapshotView | null): void {
  const operation = snapshot?.operation ?? null;
  operationBanner.hidden = operation === null;
  if (!operation) return;
  const step =
    operation.step !== null && operation.total !== null
      ? ` (step ${operation.step} of ${operation.total})`
      : "";
  operationSummary.textContent = `${operation.subject}${step}`;
  const skipAvailable =
    operation.kind === "rebase" ||
    operation.kind === "cherryPick" ||
    operation.kind === "revert";
  const known = operation.kind !== "unknown";
  operationContinueButton.hidden = !known;
  operationAbortButton.hidden = !known;
  operationSkipButton.hidden = !known || !skipAvailable;
  syncOperationControls();
}

function syncOperationControls(): void {
  for (const button of [operationContinueButton, operationSkipButton, operationAbortButton]) {
    button.disabled = writeRunning || pendingPreview !== null;
  }
}

async function runOperationStep(
  command: "operation_continue" | "operation_abort" | "operation_skip",
  running: string,
): Promise<void> {
  if (!currentSnapshot || writeRunning || pendingPreview) return;
  writeRunning = true;
  syncCommitControls();
  writeStatus.textContent = running;
  try {
    const result = await invoke<OperationResult>(command, {
      snapshotVersion: currentSnapshot.version,
    });
    applySnapshot(result.snapshot);
    writeStatus.textContent = result.details
      ? `${result.message} ${result.details}`
      : result.message;
  } catch (error) {
    showError(error);
    writeStatus.textContent = "The operation step did not run.";
  } finally {
    writeRunning = false;
    syncCommitControls();
  }
}

operationContinueButton.addEventListener("click", () =>
  void runOperationStep("operation_continue", "Continuing the operation…"),
);
operationSkipButton.addEventListener("click", () =>
  void runOperationStep("operation_skip", "Skipping the current step…"),
);
operationAbortButton.addEventListener("click", () =>
  void runOperationStep("operation_abort", "Aborting the operation…"),
);

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
      : purpose === "mergeFile"
        ? "Waiting for the merge tool to close…"
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
// One panel serves discard (work-tree restore), clean (untracked removal),
// branch delete, tag delete and stash pop/drop; all bind a single-use
// server nonce that the backend re-checks against a fresh Git read at
// every step.

type PreviewKindKey = "discard" | "clean" | "branch" | "tag" | "stashDrop" | "stashPop" | "resetHard" | "worktreeRemove" | "remoteRemove" | "remoteBranchDelete" | "forcePush";

const previewCopy: Record<
  PreviewKindKey,
  { warning: string; confirm: string; cancel: string; droppedLabel?: string }
> = {
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
    warning:
      "Deleting removes this branch name. Commits it points at stay reachable only through other refs; once unreachable, Git may garbage-collect them. This cannot be undone from guit.",
    confirm: "Delete branch",
    cancel: "Keep branch",
  },
  tag: {
    warning:
      "Deleting removes this tag name. If the tagged commit is reachable from no branch or other ref, Git may garbage-collect it. This cannot be undone from guit.",
    confirm: "Delete tag",
    cancel: "Keep tag",
  },
  stashDrop: {
    warning:
      "Deleting discards this stashed snapshot permanently. Its commits become unreachable and Git may garbage-collect them. This cannot be undone from guit.",
    confirm: "Delete stash",
    cancel: "Keep stash",
  },
  stashPop: {
    warning:
      "Popping re-applies these changes to the working copy and discards the stash entry. If the apply conflicts, Git keeps the entry and reports a failure.",
    confirm: "Pop stash",
    cancel: "Keep entry",
  },
  resetHard: {
    warning:
      "Hard reset overwrites the listed working-copy changes with the selected commit's contents and moves the branch back. Staged-only files may be deleted from disk, and the commits left behind become unreachable; Git may garbage-collect them. This cannot be undone from guit.",
    confirm: "Reset hard",
    cancel: "Keep everything",
    droppedLabel: "Commits left behind",
  },
  worktreeRemove: {
    warning:
      "Removing unregisters this linked worktree and deletes its Git metadata link. guit never forces: if the worktree has uncommitted work, Git itself refuses and nothing is removed.",
    confirm: "Remove worktree",
    cancel: "Keep worktree",
  },
  remoteRemove: {
    warning:
      "Removing this remote deletes its configuration and every remote-tracking ref listed below. Nothing on the remote itself changes; a later fetch can bring the tracking refs back.",
    confirm: "Remove remote",
    cancel: "Keep remote",
  },
  remoteBranchDelete: {
    warning:
      "Deleting removes this branch on the remote for everyone who pulls from it. Its commits become unreachable on the remote once it garbage-collects; this cannot be undone from guit.",
    confirm: "Delete remote branch",
    cancel: "Keep remote branch",
  },
  forcePush: {
    warning:
      "The lines below are what a force push erases: the remote branch named first is overwritten by the local one, the listed remote-only commits become unreachable on the remote, and anyone who already fetched them must repair their clones. guit pushes under --force-with-lease, so a remote that moved since this preview refuses.",
    confirm: "Force push",
    cancel: "Keep remote history",
  },
};

const branchForceCopy: {
  warning: string;
  confirm: string;
  cancel: string;
  droppedLabel?: string;
} = {
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
      tag?: undefined;
      stash?: undefined;
      reset?: undefined;
      worktree?: undefined;
      remote?: undefined;
    }
  | {
      kind: "branch";
      names: string[];
      dropped: string[];
      nonce: string;
      branch: { name: string; force: boolean; targetOid: string | null };
      tag?: undefined;
      stash?: undefined;
      reset?: undefined;
      worktree?: undefined;
      remote?: undefined;
    }
  | {
      kind: "tag";
      names: string[];
      dropped: string[];
      nonce: string;
      branch?: undefined;
      tag: { name: string; targetOid: string | null };
      stash?: undefined;
      reset?: undefined;
      worktree?: undefined;
      remote?: undefined;
    }
  | {
      kind: "stashDrop" | "stashPop";
      names: string[];
      dropped: string[];
      nonce: string;
      branch?: undefined;
      tag?: undefined;
      stash: { index: number; targetOid: string | null };
      reset?: undefined;
      worktree?: undefined;
      remote?: undefined;
    }
  | {
      kind: "resetHard";
      names: string[];
      dropped: string[];
      nonce: string;
      branch?: undefined;
      tag?: undefined;
      stash?: undefined;
      reset: { targetOid: string | null };
      worktree?: undefined;
      remote?: undefined;
    }
  | {
      kind: "worktreeRemove";
      names: string[];
      dropped: string[];
      nonce: string;
      branch?: undefined;
      tag?: undefined;
      stash?: undefined;
      reset?: undefined;
      worktree: { index: number; targetOid: string | null };
      remote?: undefined;
    }
  | {
      kind: "remoteRemove";
      names: string[];
      dropped: string[];
      nonce: string;
      branch?: undefined;
      tag?: undefined;
      stash?: undefined;
      reset?: undefined;
      worktree?: undefined;
      remote: { name: string };
    }
  | {
      kind: "remoteBranchDelete";
      names: string[];
      dropped: string[];
      nonce: string;
      branch?: undefined;
      tag?: undefined;
      stash?: undefined;
      reset?: undefined;
      worktree?: undefined;
      remote?: undefined;
      remoteBranch: { target: string; targetOid: string | null };
    }
  | {
      kind: "forcePush";
      names: string[];
      dropped: string[];
      nonce: string;
      branch?: undefined;
      tag?: undefined;
      stash?: undefined;
      reset?: undefined;
      worktree?: undefined;
      remote?: undefined;
      remoteBranch?: undefined;
    };

let pendingPreview: PendingPreview | null = null;
let previewRenewing = false;

function discardEligible(file: FileView): boolean {
  // Untracked files go through clean; conflicts through the mergetool
  // button; only work-tree-side changes can be discarded.
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
  const oid =
    pending.kind === "branch"
      ? pending.branch.targetOid
      : pending.kind === "tag"
        ? pending.tag.targetOid
        : pending.kind === "stashDrop" || pending.kind === "stashPop"
          ? pending.stash.targetOid
          : pending.kind === "worktreeRemove"
            ? pending.worktree.targetOid
            : pending.kind === "remoteBranchDelete"
              ? pending.remoteBranch.targetOid
              : null;
  previewCandidates.replaceChildren(
    ...pending.names.map((name) => {
      const item = document.createElement("li");
      item.textContent = oid ? `${name} · at ${oid.slice(0, 10)}` : name;
      return item;
    }),
  );
  previewDropped.hidden = pending.dropped.length === 0;
  previewDropped.textContent =
    `${copy.droppedLabel ?? "Skipped (no work-tree changes)"}: ${pending.dropped.join(", ")}`;
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
  if (pending.kind === "tag") {
    request.name = pending.tag.name;
  }
  if (pending.kind === "stashDrop" || pending.kind === "stashPop") {
    request.index = pending.stash.index;
  }
  if (pending.kind === "worktreeRemove") {
    request.index = pending.worktree.index;
  }
  if (pending.kind === "remoteRemove") {
    request.name = pending.remote.name;
  }
  if (pending.kind === "remoteBranchDelete") {
    request.target = pending.remoteBranch.target;
  }
  previewRenewing = true;
  try {
    const command =
      pending.kind === "discard"
        ? "preview_discard"
        : pending.kind === "clean"
          ? "preview_clean"
          : pending.kind === "branch"
            ? "preview_delete_branch"
            : pending.kind === "tag"
              ? "preview_delete_tag"
              : pending.kind === "stashDrop"
                ? "preview_stash_drop"
                : pending.kind === "stashPop"
                  ? "preview_stash_pop"
                  : pending.kind === "worktreeRemove"
                    ? "preview_remove_worktree"
                    : pending.kind === "remoteBranchDelete"
                      ? "preview_delete_remote_branch"
                      : pending.kind === "forcePush"
                        ? "preview_force_push"
                        : "preview_remove_remote";
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
        : pending.kind === "tag"
          ? {
              ...pending,
              names: preview.candidates,
              dropped: preview.dropped,
              nonce: preview.nonce,
              tag: { ...pending.tag, targetOid: preview.targetOid },
            }
          : pending.kind === "stashDrop" || pending.kind === "stashPop"
            ? {
                ...pending,
                names: preview.candidates,
                dropped: preview.dropped,
                nonce: preview.nonce,
                stash: { ...pending.stash, targetOid: preview.targetOid },
              }
            : pending.kind === "worktreeRemove"
              ? {
                  ...pending,
                  names: preview.candidates,
                  dropped: preview.dropped,
                  nonce: preview.nonce,
                  worktree: { ...pending.worktree, targetOid: preview.targetOid },
                }
              : pending.kind === "remoteBranchDelete"
                ? {
                    ...pending,
                    names: preview.candidates,
                    dropped: preview.dropped,
                    nonce: preview.nonce,
                    remoteBranch: {
                      ...pending.remoteBranch,
                      targetOid: preview.targetOid,
                    },
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
  clearCredentialRetry();
  writeRunning = true;
  syncCommitControls();
  renderFileRows();
  writeStatus.textContent =
    kind === "discard"
      ? "Discarding work-tree changes…"
      : kind === "clean"
        ? "Deleting untracked files…"
        : kind === "branch"
          ? "Deleting branch…"
          : kind === "stashDrop"
            ? "Deleting stash entry…"
            : kind === "stashPop"
              ? "Popping stash entry…"
              : kind === "resetHard"
                ? "Hard resetting…"
                : kind === "worktreeRemove"
                  ? "Removing worktree…"
                  : kind === "remoteRemove"
                    ? "Removing remote…"
                    : kind === "remoteBranchDelete"
                      ? "Deleting remote branch…"
                      : kind === "forcePush"
                        ? "Force-pushing…"
                        : "Deleting tag…";
  // The two remote-writing confirms ride the same streamed push lane as
  // fetch and pull; the local ones keep the static status text.
  let unlisten: (() => void) | undefined;
  if (kind === "remoteBranchDelete" || kind === "forcePush") {
    unlisten = await listen<SyncProgress>("sync-progress", ({ payload }) => {
      writeStatus.textContent = payload.line;
    });
  }
  try {
    const result = await invoke<OperationResult>(
      kind === "discard"
        ? "discard_files"
        : kind === "clean"
          ? "clean_files"
          : kind === "branch"
            ? "delete_branch"
            : kind === "stashDrop"
              ? "stash_drop"
              : kind === "stashPop"
                ? "stash_pop"
                : kind === "resetHard"
                  ? "reset_hard"
                  : kind === "worktreeRemove"
                    ? "remove_worktree"
                    : kind === "remoteRemove"
                      ? "remove_remote"
                      : kind === "remoteBranchDelete"
                        ? "delete_remote_branch"
                        : kind === "forcePush"
                          ? "force_push"
                          : "delete_tag",
      // Every ticket-confirm runs non-interactively; the credential path
      // exists for the four plain sync commands only.
      { nonce, interactive: false },
    );
    // Consume the panel before applying the snapshot so the version guard
    // does not schedule a renew for an operation that already ran.
    pendingPreview = null;
    renderPreviewPanel();
    applySnapshot(result.snapshot);
    writeStatus.textContent =
      kind === "remoteBranchDelete" || kind === "forcePush"
        ? networkStatusLine(result)
        : result.details
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
    // A completed force push leaves no pending danger behind: the entry
    // appears again only after the next rejected push.
    if (kind === "forcePush" && result.outcome === "success") {
      forcePushPreviewButton.hidden = true;
    }
  } catch (error) {
    showError(error);
    writeStatus.textContent = "The operation did not run.";
  } finally {
    unlisten?.();
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
// DOM rows form a prefix of historyCommits and are only ever appended:
// deep-paging measured a full-list rebuild of already-loaded pages as an
// O(loaded) cost per click (129 ms at 500 rows → 1664 ms at 3000).
let historyRows: HTMLElement[] = [];
const historyRowByOid = new Map<string, HTMLElement>();
let historySelectedRow: HTMLElement | null = null;

function historyPlaceholder(message: string): void {
  historyCommits = [];
  historyRows = [];
  historyRowByOid.clear();
  historySelectedRow = null;
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
  for (let i = historyRows.length; i < historyCommits.length; i += 1) {
    const commit = historyCommits[i];
    const row = document.createElement("div");
    row.className = "file-row";
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
    historyList.append(row);
    historyRows.push(row);
    historyRowByOid.set(commit.oid, row);
  }
  const wanted = selectedCommit
    ? historyRowByOid.get(selectedCommit.oid) ?? null
    : null;
  if (wanted !== historySelectedRow) {
    historySelectedRow?.classList.remove("selected");
    historySelectedRow = wanted;
    historySelectedRow?.classList.add("selected");
  }
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

type RemoteRef = {
  name: string;
  oid: string;
  symref: string | null;
  addressable: boolean;
};

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
const tagNameInput = document.querySelector<HTMLInputElement>("#tag-name")!;
const tagMessageInput = document.querySelector<HTMLInputElement>("#tag-message")!;
const tagCreateButton = document.querySelector<HTMLButtonElement>("#tag-create")!;
const tagFromCommitButton = document.querySelector<HTMLButtonElement>("#tag-from-commit")!;
const cherryPickCommitButton = document.querySelector<HTMLButtonElement>("#cherry-pick-commit")!;
const revertCommitButton = document.querySelector<HTMLButtonElement>("#revert-commit")!;
const resetSoftButton = document.querySelector<HTMLButtonElement>("#reset-soft")!;
const resetMixedButton = document.querySelector<HTMLButtonElement>("#reset-mixed")!;
const resetHardButton = document.querySelector<HTMLButtonElement>("#reset-hard")!;
const tagDetailPanel = document.querySelector<HTMLElement>("#tag-detail")!;
const tagDetailMeta = document.querySelector<HTMLElement>("#tag-detail-meta")!;
const tagDetailMessage = document.querySelector<HTMLElement>("#tag-detail-message")!;
const tagDetailCloseButton = document.querySelector<HTMLButtonElement>("#tag-detail-close")!;

let refsRequestSeq = 0;
let refsSnapshotVersion = -1;
let lastRefs: RefListing | null = null;
let renamingBranch: string | null = null;
// M5-02: the branch whose "Set upstream…" picker is open, if any.
let upstreamPickerFor: string | null = null;
let branchStartOid: string | null = null;
let branchForceTarget: string | null = null;
let tagStartOid: string | null = null;

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
  upstreamPickerFor = null;
  branchStartOid = null;
  tagStartOid = null;
  hideBranchForce();
  hideTagDetail();
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

// Branch and tag writes share the backend write queue, so they ride the
// same writeRunning lane as staging and committing; the fresh snapshot
// returned by the backend flows through the standard version guard.
async function runBranch(
  command:
    | "create_branch"
    | "switch_branch"
    | "rename_branch"
    | "create_tag"
    | "merge_start"
    | "rebase_start"
    | "set_upstream",
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
    refStatus.textContent = "The reference operation did not run.";
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
tagNameInput.addEventListener("input", () => syncBranchControls());
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
  cherryPickCommitButton.disabled = !sessionActive || writeRunning || selectedCommit === null;
  revertCommitButton.disabled = !sessionActive || writeRunning || selectedCommit === null;
  resetSoftButton.disabled = !sessionActive || writeRunning || selectedCommit === null;
  resetMixedButton.disabled = !sessionActive || writeRunning || selectedCommit === null;
  resetHardButton.disabled = !sessionActive || writeRunning || selectedCommit === null;
  tagNameInput.disabled = !sessionActive || writeRunning;
  tagMessageInput.disabled = !sessionActive || writeRunning;
  tagCreateButton.disabled =
    !sessionActive || writeRunning || tagNameInput.value.trim() === "";
  tagFromCommitButton.disabled = !sessionActive || writeRunning || selectedCommit === null;
}

// --- Tags (M3-05): create / view / delete -----------------------------------
// A blank annotation box is an explicit lightweight tag; annotation text
// travels to Git through a 0600 temp file on the Rust side and never appears
// in results or logs. Deletion rides the same single-use nonce panel as
// branch delete, bound to the object id captured at preview time.

async function createTagFromInput(): Promise<void> {
  const name = tagNameInput.value.trim();
  if (!name || !currentSnapshot || writeRunning) return;
  const annotation = tagMessageInput.value.trim();
  const result = await runBranch(
    "create_tag",
    { name, targetOid: tagStartOid, message: annotation === "" ? null : annotation },
    `Creating tag ${name}…`,
  );
  if (result?.outcome === "success") {
    tagNameInput.value = "";
    tagMessageInput.value = "";
    tagStartOid = null;
  }
}

tagCreateButton.addEventListener("click", () => void createTagFromInput());
tagNameInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    void createTagFromInput();
  }
});
tagMessageInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    void createTagFromInput();
  }
});
tagFromCommitButton.addEventListener("click", () => {
  if (!selectedCommit) return;
  tagStartOid = selectedCommit.oid;
  tagNameInput.focus();
  refStatus.textContent = `New tag will point at ${selectedCommit.oid.slice(0, 10)} — `
    + "enter a name and press Create tag.";
});

// Cherry-pick, revert and soft/mixed reset ride the same backend write
// queue as the branch operations, but report on the history status line
// the button sits on. Only full commit ids (never paths or revspecs)
// leave the frontend.
async function runCommitWrite(
  command: "pick_commit" | "revert_commit" | "reset",
  args: Record<string, unknown>,
  running: string,
): Promise<void> {
  if (!currentSnapshot || writeRunning) return;
  writeRunning = true;
  syncCommitControls();
  historyStatus.textContent = running;
  try {
    const result = await invoke<OperationResult>(command, {
      snapshotVersion: currentSnapshot.version,
      ...args,
    });
    applySnapshot(result.snapshot);
    historyStatus.textContent = result.details
      ? `${result.message} ${result.details}`
      : result.message;
  } catch (error) {
    showError(error);
    historyStatus.textContent = "The commit operation did not run.";
  } finally {
    writeRunning = false;
    syncCommitControls();
  }
}

cherryPickCommitButton.addEventListener("click", () => {
  if (!selectedCommit) return;
  const oid = selectedCommit.oid;
  void runCommitWrite("pick_commit", { oid }, `Cherry-picking ${oid.slice(0, 10)}…`);
});
revertCommitButton.addEventListener("click", () => {
  if (!selectedCommit) return;
  const oid = selectedCommit.oid;
  void runCommitWrite("revert_commit", { oid }, `Reverting ${oid.slice(0, 10)}…`);
});

// Soft and mixed reset change no file contents, so they act directly;
// hard reset goes through the single-use preview ticket like every other
// destructive entry and is never a default button.
function runResetMode(mode: "soft" | "mixed"): void {
  if (!selectedCommit) return;
  const target = selectedCommit.oid;
  void runCommitWrite("reset", { mode, target }, `Resetting (${mode}) to ${target.slice(0, 10)}…`);
}
resetSoftButton.addEventListener("click", () => runResetMode("soft"));
resetMixedButton.addEventListener("click", () => runResetMode("mixed"));

async function requestResetHard(): Promise<void> {
  if (!currentSnapshot || writeRunning || pendingPreview || !selectedCommit) return;
  const target = selectedCommit.oid;
  historyStatus.textContent = "Checking what a hard reset would discard…";
  try {
    const preview = await invoke<PreviewResult>("preview_reset_hard", {
      snapshotVersion: currentSnapshot.version,
      target,
    });
    applySnapshot(preview.snapshot);
    pendingPreview = {
      kind: "resetHard",
      names: preview.candidates,
      dropped: preview.dropped,
      nonce: preview.nonce,
      reset: { targetOid: preview.targetOid },
    };
    renderPreviewPanel();
    previewConfirmButton.focus();
  } catch (error) {
    showError(error);
    historyStatus.textContent = "The hard reset was refused before anything changed.";
  }
}
resetHardButton.addEventListener("click", () => void requestResetHard());

async function requestTagDelete(name: string): Promise<void> {
  if (!currentSnapshot || writeRunning || pendingPreview) return;
  refStatus.textContent = `Checking what deleting tag ${name} would remove…`;
  try {
    const preview = await invoke<PreviewResult>("preview_delete_tag", {
      snapshotVersion: currentSnapshot.version,
      name,
    });
    applySnapshot(preview.snapshot);
    pendingPreview = {
      kind: "tag",
      names: preview.candidates,
      dropped: preview.dropped,
      nonce: preview.nonce,
      tag: { name, targetOid: preview.targetOid },
    };
    renderPreviewPanel();
    previewConfirmButton.focus();
  } catch (error) {
    showError(error);
    refStatus.textContent = "The tag deletion was refused before anything changed.";
  }
}

type TagDetail = {
  name: string;
  oid: string;
  targetOid: string;
  annotated: boolean;
  message: string;
};

function hideTagDetail(): void {
  tagDetailPanel.hidden = true;
  tagDetailMeta.replaceChildren();
  tagDetailMessage.textContent = "";
}

function showTagDetail(name: string): void {
  void (async () => {
    refStatus.textContent = `Reading tag ${name}…`;
    try {
      const detail = await invoke<TagDetail>("show_tag", { name });
      const dlRow = (term: string, value: string): HTMLElement[] => {
        const dt = document.createElement("dt");
        dt.textContent = term;
        const dd = document.createElement("dd");
        dd.textContent = value;
        return [dt, dd];
      };
      tagDetailMeta.replaceChildren(
        ...dlRow("Tag", detail.name),
        ...dlRow("Type", detail.annotated ? "annotated" : "lightweight"),
        ...dlRow("Tag object", detail.oid),
        ...dlRow("Commit", detail.targetOid),
      );
      tagDetailMessage.textContent = detail.annotated
        ? detail.message
        : "Lightweight tag — it names the commit directly and carries no annotation.";
      tagDetailPanel.hidden = false;
      refStatus.textContent = `Tag ${detail.name} (${detail.annotated ? "annotated" : "lightweight"}).`;
    } catch (error) {
      showError(error);
      refStatus.textContent = "The tag could not be read.";
    }
  })();
}

tagDetailCloseButton.addEventListener("click", hideTagDetail);

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
          // Merges never touch the source branch and rebases are explicit
          // per-click actions; the backend still refuses both while any
          // operation is in progress.
          refRowButton("Merge", `Merge ${branch.name} into the current branch`, () =>
            void runBranch(
              "merge_start",
              { target: branch.name },
              `Merging ${branch.name}…`,
            ),
          ),
          refRowButton(
            "Rebase onto",
            `Rewrite the current branch onto ${branch.name}`,
            () =>
              void runBranch(
                "rebase_start",
                { target: branch.name },
                `Rebasing the current branch onto ${branch.name}…`,
              ),
            true,
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
      // Upstream binding is a plain config write, but its candidates come
      // from the freshly listed remote-tracking refs, never from typing.
      el.append(
        refRowButton("Set upstream…", `Set the upstream of ${branch.name}`, () => {
          upstreamPickerFor = upstreamPickerFor === branch.name ? null : branch.name;
          if (lastRefs) renderRefs(lastRefs);
        }),
      );
    }
    rows.push(el);
    if (upstreamPickerFor === branch.name) rows.push(buildUpstreamPicker(branch));
  }
  rows.push(heading(`Remote branches (${listing.remotes.length})`));
  for (const remote of listing.remotes) {
    const meta = remote.symref ? `symref → ${remote.symref}` : remote.oid.slice(0, 8);
    const el = row("", remote.name, meta, remote.addressable);
    // Deletable targets are real remote branches only: the symbolic
    // default-branch marker and irreversibly named refs stay read-only.
    if (remote.addressable && remote.symref === null) {
      el.append(
        refRowButton(
          "Delete…",
          `Delete ${remote.name} on its remote`,
          () => void requestRemoteBranchDelete(remote.name),
          true,
        ),
      );
    }
    rows.push(el);
  }
  rows.push(heading(`Tags (${listing.tags.length})`));
  for (const tag of listing.tags) {
    const target = tag.targetOid ?? tag.oid;
    const el = row(
      tag.annotated ? "T" : "",
      tag.name,
      `${tag.annotated ? "annotated" : "lightweight"} → ${target.slice(0, 8)}`,
      tag.addressable,
    );
    // View reads the annotation through the backend's exact-ref query;
    // delete goes through the same preview ticket flow as branches (tags
    // have no force stage — `git tag -d` only removes the name).
    if (tag.addressable) {
      el.append(
        refRowButton("View", `View tag ${tag.name}`, () => showTagDetail(tag.name)),
        refRowButton(
          "Delete",
          `Delete tag ${tag.name}`,
          () => void requestTagDelete(tag.name),
          true,
        ),
      );
    }
    rows.push(el);
  }
  refList.replaceChildren(...rows);
}

// M5-02: the picker lists only addressable, non-symbolic remote-tracking
// refs from the last read listing; the backend re-verifies both sides of
// the binding against its own fresh listing before Git runs.
function buildUpstreamPicker(branch: BranchRef): HTMLElement {
  const el = document.createElement("div");
  el.className = "file-row ref-row upstream-picker";
  el.setAttribute("role", "group");
  el.setAttribute("aria-label", `Choose upstream for ${branch.name}`);
  const label = document.createElement("span");
  label.className = "ref-name";
  label.textContent = `Upstream for ${branch.name}:`;
  el.append(label);
  const candidates = (lastRefs?.remotes ?? []).filter(
    (remote) => remote.addressable && remote.symref === null,
  );
  if (candidates.length === 0) {
    const note = document.createElement("span");
    note.className = "ref-meta";
    note.textContent = "no fetched remote branches — run a fetch first";
    el.append(note);
  }
  for (const remote of candidates) {
    el.append(
      refRowButton(remote.name, `Track ${remote.name} from ${branch.name}`, () =>
        void runSetUpstream(branch.name, remote.name),
      ),
    );
  }
  if (branch.upstream) {
    el.append(
      refRowButton("No upstream", `Clear the upstream of ${branch.name}`, () =>
        void runSetUpstream(branch.name, null),
      ),
    );
  }
  el.append(
    refRowButton("Cancel", `Cancel choosing the upstream of ${branch.name}`, () => {
      upstreamPickerFor = null;
      if (lastRefs) renderRefs(lastRefs);
    }),
  );
  return el;
}

async function runSetUpstream(branch: string, upstream: string | null): Promise<void> {
  const result = await runBranch(
    "set_upstream",
    { branch, upstream },
    upstream ? `Setting upstream of ${branch}…` : `Clearing upstream of ${branch}…`,
  );
  if (result) upstreamPickerFor = null;
  if (lastRefs) renderRefs(lastRefs);
}

// --- Stash (M4-01): save / apply / pop / drop ------------------------------
// Entries are addressed by their list position only; the backend turns a
// position into the stash@{N} selector, so no ref syntax typed by a client
// can ever reach Git. Pop and drop ride the same single-use ticket panel as
// tag/branch deletion, bound to the entry's commit oid. Git's default stash
// covers tracked files only — the UI says so and untracked work stays put.

type StashEntry = { index: number; date: string; subject: string };

const stashMessage = document.querySelector<HTMLInputElement>("#stash-message")!;
const stashSaveButton = document.querySelector<HTMLButtonElement>("#stash-save")!;
const stashListElement = document.querySelector<HTMLElement>("#stash-list")!;
const stashStatus = document.querySelector<HTMLElement>("#stash-status")!;

let stashEntries: StashEntry[] = [];
let stashRequestSeq = 0;
let stashSnapshotVersion = -1;

function stashPlaceholder(message: string): void {
  stashSnapshotVersion = -1;
  stashEntries = [];
  stashStatus.textContent = "";
  const row = document.createElement("div");
  row.className = "file-row placeholder";
  row.textContent = message;
  stashListElement.replaceChildren(row);
}

// Driven from renderSnapshot: every newly accepted snapshot version
// re-reads the stash list once (save/apply/pop/drop all flow through the
// shared version guard); a re-render of the same version never touches Git.
function syncStashWithSnapshot(): void {
  if (!currentSnapshot) {
    if (stashSnapshotVersion !== -1) stashPlaceholder("Open a repository to list its stashes.");
    return;
  }
  if (currentSnapshot.version === stashSnapshotVersion) return;
  stashSnapshotVersion = currentSnapshot.version;
  void loadStashes();
}

async function loadStashes(): Promise<void> {
  const seq = ++stashRequestSeq;
  stashStatus.textContent = "Loading stashes…";
  try {
    const entries = await invoke<StashEntry[]>("stash_list");
    if (seq !== stashRequestSeq) return; // a newer request took over
    renderStashes(entries);
    stashStatus.textContent = entries.length === 0
      ? "No stash entries."
      : `${entries.length} stash ${entries.length === 1 ? "entry" : "entries"}.`;
  } catch (error) {
    if (seq !== stashRequestSeq) return;
    showError(error);
    stashStatus.textContent = "The stash list could not be loaded.";
  }
}

function renderStashes(entries: StashEntry[]): void {
  stashEntries = entries;
  if (entries.length === 0) {
    const row = document.createElement("div");
    row.className = "file-row placeholder";
    row.textContent = "No stash entries.";
    stashListElement.replaceChildren(row);
    return;
  }
  const rows = entries.map((entry) => {
    const el = document.createElement("div");
    el.className = "file-row ref-row";
    el.setAttribute("role", "listitem");
    const badge = document.createElement("span");
    badge.className = "file-status";
    badge.textContent = `#${entry.index}`;
    const label = document.createElement("span");
    label.className = "ref-name";
    label.textContent = entry.subject;
    label.title = entry.subject;
    const when = document.createElement("span");
    when.className = "ref-meta";
    when.textContent = entry.date.slice(0, 10);
    el.append(
      badge,
      label,
      when,
      refRowButton("Apply", `Apply stash ${entry.index}`, () =>
        void runStashWrite(
          "stash_apply",
          { index: entry.index },
          `Applying stash #${entry.index}…`,
        )),
      refRowButton("Pop…", `Pop stash ${entry.index} after confirmation`, () =>
        void requestStashTicket("stashPop", entry.index)),
      refRowButton(
        "Delete…",
        `Delete stash ${entry.index} after confirmation`,
        () => void requestStashTicket("stashDrop", entry.index),
        true,
      ),
    );
    return el;
  });
  stashListElement.replaceChildren(...rows);
}

// Save and apply are ordinary queued writes (apply keeps the entry), so
// they ride the shared write lane; the backend re-reads and the returned
// snapshot refreshes the list through syncStashWithSnapshot.
async function runStashWrite(
  command: "stash_save" | "stash_apply",
  args: Record<string, unknown>,
  running: string,
): Promise<void> {
  if (!currentSnapshot || writeRunning || pendingPreview) return;
  writeRunning = true;
  syncCommitControls();
  renderStashes(stashEntries);
  stashStatus.textContent = running;
  try {
    const result = await invoke<OperationResult>(command, {
      snapshotVersion: currentSnapshot.version,
      ...args,
    });
    applySnapshot(result.snapshot);
    stashStatus.textContent = result.details
      ? `${result.message} ${result.details}`
      : result.message;
    if (command === "stash_save" && result.outcome === "success") {
      stashMessage.value = "";
    }
  } catch (error) {
    showError(error);
    stashStatus.textContent = "The stash operation did not run.";
  } finally {
    writeRunning = false;
    syncCommitControls();
    renderStashes(stashEntries);
  }
}

async function saveStash(): Promise<void> {
  await runStashWrite(
    "stash_save",
    { message: stashMessage.value },
    "Stashing tracked changes… untracked files stay in place.",
  );
}

stashSaveButton.addEventListener("click", () => void saveStash());
stashMessage.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    void saveStash();
  }
});

async function requestStashTicket(kind: "stashDrop" | "stashPop", index: number): Promise<void> {
  if (!currentSnapshot || writeRunning || pendingPreview) return;
  stashStatus.textContent =
    kind === "stashDrop"
      ? `Checking what deleting stash #${index} would discard…`
      : `Checking what popping stash #${index} would do…`;
  try {
    const preview = await invoke<PreviewResult>(
      kind === "stashDrop" ? "preview_stash_drop" : "preview_stash_pop",
      { snapshotVersion: currentSnapshot.version, index },
    );
    applySnapshot(preview.snapshot);
    pendingPreview = {
      kind,
      names: preview.candidates,
      dropped: preview.dropped,
      nonce: preview.nonce,
      stash: { index, targetOid: preview.targetOid },
    };
    renderPreviewPanel();
    previewConfirmButton.focus();
  } catch (error) {
    showError(error);
    stashStatus.textContent = "The stash operation was refused before anything changed.";
  }
}

function syncStashControls(): void {
  const locked = !sessionActive || writeRunning;
  stashMessage.disabled = locked;
  stashSaveButton.disabled = locked;
}

// --- Worktrees (M4-06): list / add / remove / prune ------------------------
// Rows are addressed by their list position only; the backend re-reads
// `git worktree list --porcelain` and binds a single-use removal ticket to
// the entry's HEAD oid, so neither a path nor ref syntax typed by the
// client can reach Git. guit never forces a removal: a dirty or current
// worktree is refused by Git itself and reported verbatim. The add target
// comes from the branch/commit field; the new folder comes from an OS
// directory dialog, matching the clone precedent.

type WorktreeView = {
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

const worktreeTarget = document.querySelector<HTMLInputElement>("#worktree-target")!;
const worktreeAddButton = document.querySelector<HTMLButtonElement>("#worktree-add")!;
const worktreePruneButton = document.querySelector<HTMLButtonElement>("#worktree-prune")!;
const worktreeListElement = document.querySelector<HTMLElement>("#worktree-list")!;
const worktreeStatus = document.querySelector<HTMLElement>("#worktree-status")!;

let worktreeEntries: WorktreeView[] = [];
let worktreeRequestSeq = 0;
let worktreeSnapshotVersion = -1;

function worktreePlaceholder(message: string): void {
  worktreeSnapshotVersion = -1;
  worktreeEntries = [];
  worktreeStatus.textContent = "";
  const row = document.createElement("div");
  row.className = "file-row placeholder";
  row.textContent = message;
  worktreeListElement.replaceChildren(row);
}

function syncWorktreesWithSnapshot(): void {
  if (!currentSnapshot) {
    if (worktreeSnapshotVersion !== -1)
      worktreePlaceholder("Open a repository to list its worktrees.");
    return;
  }
  if (currentSnapshot.version === worktreeSnapshotVersion) return;
  worktreeSnapshotVersion = currentSnapshot.version;
  void loadWorktrees();
}

async function loadWorktrees(): Promise<void> {
  const seq = ++worktreeRequestSeq;
  worktreeStatus.textContent = "Loading worktrees…";
  try {
    const entries = await invoke<WorktreeView[]>("list_worktrees");
    if (seq !== worktreeRequestSeq) return; // a newer request took over
    renderWorktrees(entries);
    worktreeStatus.textContent = entries.length === 0
      ? "No worktrees."
      : `${entries.length} worktree ${entries.length === 1 ? "entry" : "entries"}.`;
  } catch (error) {
    if (seq !== worktreeRequestSeq) return;
    showError(error);
    worktreeStatus.textContent = "The worktree list could not be loaded.";
  }
}

function renderWorktrees(entries: WorktreeView[]): void {
  worktreeEntries = entries;
  if (entries.length === 0) {
    const row = document.createElement("div");
    row.className = "file-row placeholder";
    row.textContent = "No worktrees.";
    worktreeListElement.replaceChildren(row);
    return;
  }
  const rows = entries.map((entry) => {
    const el = document.createElement("div");
    el.className = "file-row ref-row";
    el.setAttribute("role", "listitem");
    const badge = document.createElement("span");
    badge.className = "file-status";
    badge.textContent = `#${entry.index}`;
    const label = document.createElement("span");
    label.className = "ref-name";
    label.textContent = entry.path;
    label.title = entry.path;
    const notes: string[] = [];
    if (entry.branch) notes.push(entry.branch);
    if (entry.detached) notes.push("detached");
    if (entry.orphan) notes.push("orphan");
    if (entry.bare) notes.push("bare");
    if (entry.locked) notes.push("locked");
    if (entry.prunable) notes.push("stale");
    const meta = document.createElement("span");
    meta.className = "ref-meta";
    meta.textContent = notes.join(" · ");
    el.append(badge, label, meta);
    // Removal needs a stable HEAD oid and a round-trippable (UTF-8) path;
    // bare, orphan and non-addressable entries are shown read-only.
    if (!entry.bare && !entry.orphan && entry.addressable) {
      el.append(
        refRowButton(
          "Remove…",
          `Remove worktree ${entry.index} after confirmation`,
          () => void requestWorktreeRemove(entry.index),
          true,
        ),
      );
    }
    return el;
  });
  worktreeListElement.replaceChildren(...rows);
}

// Add and prune are ordinary queued writes; the backend re-reads and the
// returned snapshot refreshes the list through syncWorktreesWithSnapshot.
async function runWorktreeWrite(
  command: "add_worktree" | "prune_worktrees",
  args: Record<string, unknown>,
  running: string,
): Promise<void> {
  if (!currentSnapshot || writeRunning || pendingPreview) return;
  writeRunning = true;
  syncCommitControls();
  renderWorktrees(worktreeEntries);
  worktreeStatus.textContent = running;
  try {
    const result = await invoke<OperationResult>(command, {
      snapshotVersion: currentSnapshot.version,
      ...args,
    });
    applySnapshot(result.snapshot);
    worktreeStatus.textContent = result.details
      ? `${result.message} ${result.details}`
      : result.message;
    if (command === "add_worktree" && result.outcome === "success") {
      worktreeTarget.value = "";
    }
  } catch (error) {
    showError(error);
    worktreeStatus.textContent = "The worktree operation did not run.";
  } finally {
    writeRunning = false;
    syncCommitControls();
    renderWorktrees(worktreeEntries);
  }
}

async function addWorktree(): Promise<void> {
  if (!currentSnapshot || writeRunning || pendingPreview) return;
  const target = worktreeTarget.value.trim();
  if (target === "") {
    worktreeStatus.textContent =
      "Enter a local branch name or full commit id to check out.";
    return;
  }
  let selected: unknown;
  try {
    selected = await open({ directory: true, multiple: false });
  } catch (error) {
    showError(error);
    worktreeStatus.textContent = "The folder chooser could not be opened.";
    return;
  }
  if (typeof selected !== "string") return; // dialog cancelled
  await runWorktreeWrite(
    "add_worktree",
    { path: selected, target },
    "Creating the linked worktree…",
  );
}

worktreeAddButton.addEventListener("click", () => void addWorktree());
worktreePruneButton.addEventListener("click", () =>
  void runWorktreeWrite(
    "prune_worktrees",
    {},
    "Forgetting worktree folders that no longer exist…",
  ),
);
worktreeTarget.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    void addWorktree();
  }
});

async function requestWorktreeRemove(index: number): Promise<void> {
  if (!currentSnapshot || writeRunning || pendingPreview) return;
  worktreeStatus.textContent = `Checking what removing worktree #${index} would do…`;
  try {
    const preview = await invoke<PreviewResult>("preview_remove_worktree", {
      snapshotVersion: currentSnapshot.version,
      index,
    });
    applySnapshot(preview.snapshot);
    pendingPreview = {
      kind: "worktreeRemove",
      names: preview.candidates,
      dropped: preview.dropped,
      nonce: preview.nonce,
      worktree: { index, targetOid: preview.targetOid },
    };
    renderPreviewPanel();
    previewConfirmButton.focus();
  } catch (error) {
    showError(error);
    worktreeStatus.textContent =
      "The worktree removal was refused before anything changed.";
  }
}

function syncWorktreeControls(): void {
  const locked = !sessionActive || writeRunning;
  worktreeTarget.disabled = locked;
  worktreeAddButton.disabled = locked;
  worktreePruneButton.disabled = locked;
}

// --- Submodules (M4-07): list / init & update ------------------------------
// Rows are addressed by their list position only; the backend re-reads the
// index (mode-160000 entries are authoritative) and reconstructs a literal
// pathspec itself, so neither a path nor ref syntax typed by the client can
// reach Git. Update clones can run for a long time: progress lines arrive
// redacted over the "submodule-progress" event and Stop (cancel_write)
// reaches the running Git process. A cancelled or failed update may leave
// the state incomplete — the backend message says so and the re-read list
// shows what actually survived.

type SubmoduleView = {
  index: number;
  path: string;
  name: string | null;
  url: string | null;
  recordedOid: string;
  checkedOutOid: string | null;
  state: "upToDate" | "uninitialized" | "outOfSync" | "conflicted" | "unmapped";
};

const submoduleStateLabels: Record<SubmoduleView["state"], string> = {
  upToDate: "up to date",
  uninitialized: "not initialized",
  outOfSync: "checked-out commit differs from the index",
  conflicted: "conflicted",
  unmapped: "no .gitmodules mapping",
};

const submoduleUpdateAllButton = document.querySelector<HTMLButtonElement>(
  "#submodule-update-all",
)!;
const submoduleListElement = document.querySelector<HTMLElement>("#submodule-list")!;
const submoduleStatus = document.querySelector<HTMLElement>("#submodule-status")!;

let submoduleEntries: SubmoduleView[] = [];
let submoduleRequestSeq = 0;
let submoduleSnapshotVersion = -1;

function submodulePlaceholder(message: string): void {
  submoduleSnapshotVersion = -1;
  submoduleEntries = [];
  submoduleStatus.textContent = "";
  const row = document.createElement("div");
  row.className = "file-row placeholder";
  row.textContent = message;
  submoduleListElement.replaceChildren(row);
}

function syncSubmodulesWithSnapshot(): void {
  if (!currentSnapshot) {
    if (submoduleSnapshotVersion !== -1)
      submodulePlaceholder("Open a repository to list its submodules.");
    return;
  }
  if (currentSnapshot.version === submoduleSnapshotVersion) return;
  submoduleSnapshotVersion = currentSnapshot.version;
  void loadSubmodules();
}

async function loadSubmodules(): Promise<void> {
  const seq = ++submoduleRequestSeq;
  submoduleStatus.textContent = "Loading submodules…";
  try {
    const entries = await invoke<SubmoduleView[]>("submodule_status");
    if (seq !== submoduleRequestSeq) return; // a newer request took over
    renderSubmodules(entries);
    submoduleStatus.textContent =
      entries.length === 0
        ? "No submodules."
        : `${entries.length} submodule ${entries.length === 1 ? "entry" : "entries"}.`;
  } catch (error) {
    if (seq !== submoduleRequestSeq) return;
    showError(error);
    submoduleStatus.textContent = "The submodule list could not be loaded.";
  }
}

function renderSubmodules(entries: SubmoduleView[]): void {
  submoduleEntries = entries;
  if (entries.length === 0) {
    const row = document.createElement("div");
    row.className = "file-row placeholder";
    row.textContent = "No submodules.";
    submoduleListElement.replaceChildren(row);
    return;
  }
  const rows = entries.map((entry) => {
    const el = document.createElement("div");
    el.className = "file-row ref-row";
    el.setAttribute("role", "listitem");
    const badge = document.createElement("span");
    badge.className = "file-status";
    badge.textContent = `#${entry.index}`;
    const label = document.createElement("span");
    label.className = "ref-name";
    label.textContent = entry.path;
    label.title = entry.url ? `${entry.path} ← ${entry.url}` : entry.path;
    const notes: string[] = [submoduleStateLabels[entry.state]];
    if (entry.name) notes.push(entry.name);
    const meta = document.createElement("span");
    meta.className = "ref-meta";
    meta.textContent = notes.join(" · ");
    el.append(badge, label, meta);
    el.append(
      refRowButton(
        "Init & update",
        `Initialize and update submodule ${entry.index}`,
        () => void runSubmoduleUpdate(entry.index),
      ),
    );
    return el;
  });
  submoduleListElement.replaceChildren(...rows);
}

async function runSubmoduleUpdate(index: number | null): Promise<void> {
  if (!currentSnapshot || writeRunning || pendingPreview) return;
  writeRunning = true;
  syncCommitControls();
  renderSubmodules(submoduleEntries);
  submoduleStatus.textContent = "Initializing and updating submodules…";
  let unlisten: (() => void) | undefined;
  try {
    unlisten = await listen<string>("submodule-progress", ({ payload }) => {
      submoduleStatus.textContent = payload;
    });
    const result = await invoke<OperationResult>("submodule_init_update", {
      snapshotVersion: currentSnapshot.version,
      index,
    });
    applySnapshot(result.snapshot);
    submoduleStatus.textContent = result.details
      ? `${result.message} ${result.details}`
      : result.message;
  } catch (error) {
    showError(error);
    submoduleStatus.textContent = "The submodule update did not run.";
  } finally {
    unlisten?.();
    writeRunning = false;
    syncCommitControls();
    renderSubmodules(submoduleEntries);
  }
}

submoduleUpdateAllButton.addEventListener("click", () =>
  void runSubmoduleUpdate(null),
);

function syncSubmoduleControls(): void {
  submoduleUpdateAllButton.disabled = !sessionActive || writeRunning;
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
      cloneStatus.textContent = result.suggestion
        ? `${result.message} ${result.suggestion}`
        : result.message;
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

// --- Remotes (M5-01/02/03): list / add / set-url / remove / fetch / pull ----
// The backend reads `git remote` + `get-url` itself and hands over only
// redacted URLs — a URL can embed a credentials token, so the raw form
// never travels to this file. Removal is destructive (it takes the
// remote-tracking refs with it) and runs through the shared one-time
// ticket panel; adding and re-pointing URLs are ordinary queued writes.
// Fetch rides the same lane with the 3600 s network budget: progress lines
// arrive redacted over "sync-progress" and the mandatory re-read refreshes
// the ↑n ↓m badges in the branch header and References rows. Pull is one
// queue unit (fetch + integrate); the strategy select names the lane and
// its "Git default" entry shows the effective rule the backend read from
// the user's own pull.rebase/pull.ff config.

type RemoteView = {
  name: string;
  fetchUrl: string | null;
  pushUrl: string | null;
  addressable: boolean;
};

type SyncProgress = { operationId: number; line: string };

type PullDefault = {
  rebase: { value: string; scope: string } | null;
  ff: { value: string; scope: string } | null;
  effective: string;
  note: string | null;
};

const remoteNameInput = document.querySelector<HTMLInputElement>("#remote-name")!;
const remoteUrlInput = document.querySelector<HTMLInputElement>("#remote-url")!;
const remoteAddButton = document.querySelector<HTMLButtonElement>("#remote-add")!;
const remoteFetchAllButton = document.querySelector<HTMLButtonElement>("#remote-fetch-all")!;
const pullStrategySelect = document.querySelector<HTMLSelectElement>("#pull-strategy")!;
const remotePullButton = document.querySelector<HTMLButtonElement>("#remote-pull")!;
const remotePushButton = document.querySelector<HTMLButtonElement>("#remote-push")!;
const publishRemoteSelect = document.querySelector<HTMLSelectElement>("#publish-remote")!;
const remotePublishButton = document.querySelector<HTMLButtonElement>("#remote-publish")!;
const forcePushPreviewButton = document.querySelector<HTMLButtonElement>("#remote-force-push")!;
const remoteListElement = document.querySelector<HTMLElement>("#remote-list")!;
const remoteStatus = document.querySelector<HTMLElement>("#remote-status")!;
const authRetryButton = document.querySelector<HTMLButtonElement>("#remote-auth-retry")!;
const askpassDialog = document.querySelector<HTMLElement>("#askpass-dialog")!;
const askpassPrompt = document.querySelector<HTMLElement>("#askpass-prompt")!;
const askpassSecret = document.querySelector<HTMLInputElement>("#askpass-secret")!;
const askpassSubmitButton = document.querySelector<HTMLButtonElement>("#askpass-submit")!;
const askpassCancelButton = document.querySelector<HTMLButtonElement>("#askpass-cancel")!;

// The payload of one `askpass-request` event: categorised prompt material
// only. The Rust side has already stripped everything else and can prove
// the target survives URL redaction, so displaying it is safe.
type AskPassRequest = {
  operationId: number;
  kind: "username" | "password";
  target: string;
  user: string | null;
};

let askpassPending: AskPassRequest | null = null;
let authRetryAction: (() => void) | null = null;

function clearCredentialRetry(): void {
  authRetryAction = null;
  authRetryButton.hidden = true;
}

// Git itself decided the failure is about credentials; that is the only
// moment the explicit credential path appears, and one click spends it.
function offerCredentialRetry(result: OperationResult, retry: () => void): void {
  if (result.outcome === "failed" && result.category === "auth") {
    authRetryAction = retry;
    authRetryButton.hidden = false;
  } else {
    clearCredentialRetry();
  }
}

let remoteEntries: RemoteView[] = [];
let remoteRequestSeq = 0;
let remoteSnapshotVersion = -1;
let pullDefaultRequestSeq = 0;

function remotePlaceholder(message: string): void {
  remoteSnapshotVersion = -1;
  remoteEntries = [];
  remoteStatus.textContent = "";
  pullStrategySelect.options[0].textContent = "Git default";
  pullStrategySelect.options[0].title = "";
  renderPublishTargets([]);
  forcePushPreviewButton.hidden = true;
  clearCredentialRetry();
  closeAskpass();
  const row = document.createElement("div");
  row.className = "file-row placeholder";
  row.textContent = message;
  remoteListElement.replaceChildren(row);
}

function syncRemotesWithSnapshot(): void {
  if (!currentSnapshot) {
    if (remoteSnapshotVersion !== -1)
      remotePlaceholder("Open a repository to list its remotes.");
    return;
  }
  if (currentSnapshot.version === remoteSnapshotVersion) return;
  remoteSnapshotVersion = currentSnapshot.version;
  void loadRemotes();
}

async function loadRemotes(): Promise<void> {
  const seq = ++remoteRequestSeq;
  remoteStatus.textContent = "Loading remotes…";
  try {
    const entries = await invoke<RemoteView[]>("list_remotes");
    if (seq !== remoteRequestSeq) return; // a newer request took over
    renderRemotes(entries);
    remoteStatus.textContent =
      entries.length === 0
        ? "No remotes configured."
        : `${entries.length} remote${entries.length === 1 ? "" : "s"} configured.`;
    void loadPullDefault();
  } catch (error) {
    if (seq !== remoteRequestSeq) return;
    showError(error);
    remoteStatus.textContent = "The remote list could not be loaded.";
  }
}

function renderRemotes(entries: RemoteView[]): void {
  remoteEntries = entries;
  renderPublishTargets(entries);
  if (entries.length === 0) {
    const row = document.createElement("div");
    row.className = "file-row placeholder";
    row.textContent = "No remotes configured.";
    remoteListElement.replaceChildren(row);
    return;
  }
  const rows = entries.map((entry) => {
    const el = document.createElement("div");
    el.className = "file-row ref-row";
    el.setAttribute("role", "listitem");
    const badge = document.createElement("span");
    badge.className = "file-status";
    badge.textContent = "⇅";
    const label = document.createElement("span");
    label.className = "ref-name";
    label.textContent = entry.name;
    label.title = entry.fetchUrl ?? entry.name;
    const meta = document.createElement("span");
    meta.className = "ref-meta";
    const urls = [entry.fetchUrl ?? "(no URL)"];
    if (entry.pushUrl) urls.push(`push: ${entry.pushUrl}`);
    meta.textContent = urls.join(" · ");
    meta.title = meta.textContent;
    el.append(badge, label, meta);
    // The URL input doubles as the new-value field for Set URL; removal
    // needs a losslessly addressable name and goes through the ticket.
    if (entry.addressable) {
      el.append(
        refRowButton("Fetch", `Fetch from remote ${entry.name}`, () =>
          void runFetch({ remote: entry.name }, `Fetching ${entry.name}…`),
        ),
        refRowButton("Set URL", `Set fetch URL of remote ${entry.name}`, () =>
          void runRemoteSetUrl(entry.name, false),
        ),
      );
      if (entry.pushUrl !== null) {
        el.append(
          refRowButton("Set push URL", `Set push URL of remote ${entry.name}`, () =>
            void runRemoteSetUrl(entry.name, true),
          ),
        );
      }
      el.append(
        refRowButton(
          "Remove…",
          `Remove remote ${entry.name}`,
          () => void requestRemoteRemove(entry.name),
          true,
        ),
      );
    }
    return el;
  });
  remoteListElement.replaceChildren(...rows);
}

async function runRemoteWrite(
  command: "add_remote" | "set_remote_url",
  args: Record<string, unknown>,
  running: string,
): Promise<void> {
  if (!currentSnapshot || writeRunning || pendingPreview) return;
  clearCredentialRetry();
  writeRunning = true;
  syncCommitControls();
  renderRemotes(remoteEntries);
  remoteStatus.textContent = running;
  try {
    const result = await invoke<OperationResult>(command, {
      snapshotVersion: currentSnapshot.version,
      ...args,
    });
    applySnapshot(result.snapshot);
    remoteStatus.textContent = result.details
      ? `${result.message} ${result.details}`
      : result.message;
    if (result.outcome === "success" && command === "add_remote") {
      remoteNameInput.value = "";
      remoteUrlInput.value = "";
    }
  } catch (error) {
    showError(error);
    remoteStatus.textContent = "The remote operation did not run.";
  } finally {
    writeRunning = false;
    syncCommitControls();
    renderRemotes(remoteEntries);
  }
}

function addRemote(): void {
  const name = remoteNameInput.value.trim();
  const url = remoteUrlInput.value.trim();
  if (name === "" || url === "") {
    remoteStatus.textContent = "Enter both a remote name and a URL or local path.";
    return;
  }
  void runRemoteWrite("add_remote", { name, url }, "Adding the remote…");
}

// The status line for a network result: Git's message, its redacted
// verdict and, when the backend classified a failure, the fixed advice.
// The category and suggestion are decided in Rust; the frontend only
// displays them.
function networkStatusLine(result: OperationResult): string {
  const base = result.details
    ? `${result.message} ${result.details}`
    : result.message;
  return result.suggestion ? `${base} ${result.suggestion}` : base;
}

// The fetch target is the wire-shape the backend enum defines: "all" is
// the broadcast sweep, { remote } names exactly one entry — even one
// literally called "all".
async function runFetch(
  target: "all" | { remote: string },
  running: string,
  interactive = false,
): Promise<void> {
  if (!currentSnapshot || writeRunning || pendingPreview) return;
  clearCredentialRetry();
  writeRunning = true;
  syncCommitControls();
  renderRemotes(remoteEntries);
  remoteStatus.textContent = running;
  let unlisten: (() => void) | undefined;
  try {
    unlisten = await listen<SyncProgress>("sync-progress", ({ payload }) => {
      remoteStatus.textContent = payload.line;
    });
    const result = await invoke<OperationResult>("fetch", {
      snapshotVersion: currentSnapshot.version,
      target,
      interactive,
    });
    applySnapshot(result.snapshot);
    remoteStatus.textContent = networkStatusLine(result);
    offerCredentialRetry(result, () =>
      void runFetch(target, "Fetching with credentials…", true),
    );
  } catch (error) {
    showError(error);
    remoteStatus.textContent = "The fetch did not run.";
  } finally {
    unlisten?.();
    writeRunning = false;
    syncCommitControls();
    renderRemotes(remoteEntries);
  }
}

// The "default" strategy label carries the rule Git's own config would
// pick, so the user sees what a plain pull does before choosing it. The
// read is best-effort: a failure leaves the neutral "Git default" text.
async function loadPullDefault(): Promise<void> {
  const seq = ++pullDefaultRequestSeq;
  try {
    const view = await invoke<PullDefault>("pull_default");
    if (seq !== pullDefaultRequestSeq || !currentSnapshot) return;
    const option = pullStrategySelect.options[0];
    option.textContent = `Git default (${view.effective})`;
    const configured = [
      view.rebase ? `pull.rebase=${view.rebase.value || "true"} (${view.rebase.scope})` : null,
      view.ff ? `pull.ff=${view.ff.value || "true"} (${view.ff.scope})` : null,
    ].filter((entry): entry is string => entry !== null);
    option.title = [
      configured.length > 0
        ? `Your config: ${configured.join(", ")}; effective: ${view.effective}.`
        : `No pull.rebase or pull.ff configured; effective: ${view.effective}.`,
      view.note ?? "",
    ]
      .filter((part) => part !== "")
      .join(" ");
  } catch {
    if (seq === pullDefaultRequestSeq) {
      pullStrategySelect.options[0].textContent = "Git default";
    }
  }
}

// Pull is one queue unit end to end: the backend fetches the upstream's
// remote and integrates in the same slot, so the UI never offers a second
// write while the fetch leg runs. Conflicts arrive as `conflicted` with
// the banner already showing the sequencer state the snapshot re-read
// found; the next step belongs to the banner, not to a dialog.
async function runPull(interactive = false): Promise<void> {
  if (!currentSnapshot || writeRunning || pendingPreview) return;
  const strategy = pullStrategySelect.value as "default" | "ffonly" | "merge" | "rebase";
  clearCredentialRetry();
  writeRunning = true;
  syncCommitControls();
  renderRemotes(remoteEntries);
  remoteStatus.textContent = interactive ? "Pulling with credentials…" : "Pulling…";
  let unlisten: (() => void) | undefined;
  try {
    unlisten = await listen<SyncProgress>("sync-progress", ({ payload }) => {
      remoteStatus.textContent = payload.line;
    });
    const result = await invoke<OperationResult>("pull", {
      snapshotVersion: currentSnapshot.version,
      strategy,
      interactive,
    });
    applySnapshot(result.snapshot);
    remoteStatus.textContent = networkStatusLine(result);
    offerCredentialRetry(result, () => void runPull(true));
  } catch (error) {
    showError(error);
    remoteStatus.textContent = "The pull did not run.";
  } finally {
    unlisten?.();
    writeRunning = false;
    syncCommitControls();
    renderRemotes(remoteEntries);
  }
}

// Publish targets are exactly the losslessly addressable remotes; the
// backend re-checks the name against its own `remote list` before Git runs.
function renderPublishTargets(entries: RemoteView[]): void {
  const previous = publishRemoteSelect.value;
  const names = entries.filter((entry) => entry.addressable).map((entry) => entry.name);
  publishRemoteSelect.replaceChildren(
    ...names.map((name) => {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      return option;
    }),
  );
  if (names.includes(previous)) publishRemoteSelect.value = previous;
}

// Push names nothing: the backend derives branch, remote and target from a
// fresh listing, and never forces. The one-time force-push preview appears
// only after Git itself refused an update, and any newer push (or a
// session change) hides it again.
async function runPush(interactive = false): Promise<void> {
  if (!currentSnapshot || writeRunning || pendingPreview) return;
  forcePushPreviewButton.hidden = true;
  clearCredentialRetry();
  writeRunning = true;
  syncCommitControls();
  renderRemotes(remoteEntries);
  remoteStatus.textContent = interactive ? "Pushing with credentials…" : "Pushing…";
  let unlisten: (() => void) | undefined;
  try {
    unlisten = await listen<SyncProgress>("sync-progress", ({ payload }) => {
      remoteStatus.textContent = payload.line;
    });
    const result = await invoke<OperationResult>("push", {
      snapshotVersion: currentSnapshot.version,
      interactive,
    });
    applySnapshot(result.snapshot);
    remoteStatus.textContent = networkStatusLine(result);
    offerCredentialRetry(result, () => void runPush(true));
    if (
      result.outcome === "failed" &&
      (result.details?.includes("[rejected]") ||
        result.details?.includes("remote rejected"))
    ) {
      forcePushPreviewButton.hidden = false;
    }
  } catch (error) {
    showError(error);
    remoteStatus.textContent = "The push did not run.";
  } finally {
    unlisten?.();
    writeRunning = false;
    syncCommitControls();
    renderRemotes(remoteEntries);
  }
}

// Publish is the first push of a branch: it demands a remote picked from
// the listing and a branch without an upstream, and the backend refuses
// both mistakes instead of silently re-pointing a binding.
async function runPublish(interactive = false): Promise<void> {
  if (!currentSnapshot || writeRunning || pendingPreview) return;
  const remote = publishRemoteSelect.value;
  if (remote === "") {
    remoteStatus.textContent = "Add an addressable remote before publishing.";
    return;
  }
  clearCredentialRetry();
  writeRunning = true;
  syncCommitControls();
  renderRemotes(remoteEntries);
  remoteStatus.textContent = interactive
    ? `Publishing to ${remote} with credentials…`
    : `Publishing to ${remote}…`;
  let unlisten: (() => void) | undefined;
  try {
    unlisten = await listen<SyncProgress>("sync-progress", ({ payload }) => {
      remoteStatus.textContent = payload.line;
    });
    const result = await invoke<OperationResult>("publish", {
      snapshotVersion: currentSnapshot.version,
      remote,
      interactive,
    });
    applySnapshot(result.snapshot);
    remoteStatus.textContent = networkStatusLine(result);
    offerCredentialRetry(result, () => void runPublish(true));
  } catch (error) {
    showError(error);
    remoteStatus.textContent = "The publish did not run.";
  } finally {
    unlisten?.();
    writeRunning = false;
    syncCommitControls();
    renderRemotes(remoteEntries);
  }
}

async function requestForcePushPreview(): Promise<void> {
  if (!currentSnapshot || writeRunning || pendingPreview) return;
  remoteStatus.textContent = "Checking what a force push would erase on the remote…";
  try {
    const preview = await invoke<PreviewResult>("preview_force_push", {
      snapshotVersion: currentSnapshot.version,
    });
    applySnapshot(preview.snapshot);
    pendingPreview = {
      kind: "forcePush",
      names: preview.candidates,
      dropped: preview.dropped,
      nonce: preview.nonce,
    };
    renderPreviewPanel();
    previewConfirmButton.focus();
  } catch (error) {
    showError(error);
    remoteStatus.textContent =
      "The force push was refused before anything changed.";
  }
}

function runRemoteSetUrl(name: string, push: boolean): void {
  const url = remoteUrlInput.value.trim();
  if (url === "") {
    remoteStatus.textContent = "Type the new URL in the URL field first.";
    return;
  }
  void runRemoteWrite(
    "set_remote_url",
    { name, url, push },
    push ? `Re-pointing the push URL of ${name}…` : `Re-pointing the URL of ${name}…`,
  );
}

async function requestRemoteRemove(name: string): Promise<void> {
  if (!currentSnapshot || writeRunning || pendingPreview) return;
  remoteStatus.textContent = `Checking what removing ${name} would delete…`;
  try {
    const preview = await invoke<PreviewResult>("preview_remove_remote", {
      snapshotVersion: currentSnapshot.version,
      name,
    });
    applySnapshot(preview.snapshot);
    pendingPreview = {
      kind: "remoteRemove",
      names: preview.candidates,
      dropped: preview.dropped,
      nonce: preview.nonce,
      remote: { name },
    };
    renderPreviewPanel();
    previewConfirmButton.focus();
  } catch (error) {
    showError(error);
    remoteStatus.textContent =
      "The remote removal was refused before anything changed.";
  }
}

async function requestRemoteBranchDelete(target: string): Promise<void> {
  if (!currentSnapshot || writeRunning || pendingPreview) return;
  refStatus.textContent = `Checking what deleting ${target} would remove on the remote…`;
  try {
    const preview = await invoke<PreviewResult>("preview_delete_remote_branch", {
      snapshotVersion: currentSnapshot.version,
      target,
    });
    applySnapshot(preview.snapshot);
    pendingPreview = {
      kind: "remoteBranchDelete",
      names: preview.candidates,
      dropped: preview.dropped,
      nonce: preview.nonce,
      remoteBranch: { target, targetOid: preview.targetOid },
    };
    renderPreviewPanel();
    previewConfirmButton.focus();
  } catch (error) {
    showError(error);
    refStatus.textContent =
      "The remote branch deletion was refused before anything changed.";
  }
}

remoteAddButton.addEventListener("click", addRemote);
remoteFetchAllButton.addEventListener("click", () =>
  void runFetch("all", "Fetching every remote…"),
);
remotePullButton.addEventListener("click", () => void runPull());
remotePushButton.addEventListener("click", () => void runPush());
remotePublishButton.addEventListener("click", () => void runPublish());
forcePushPreviewButton.addEventListener("click", () => void requestForcePushPreview());
remoteUrlInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    addRemote();
  }
});
authRetryButton.addEventListener("click", () => {
  const action = authRetryAction;
  clearCredentialRetry();
  action?.();
});

// The askpass dialog is the whole credential UI: Git's categorised prompt
// arrived as {operationId, kind, target, user}, the answer goes straight
// into submit_askpass and lives nowhere else. Cancel just closes it — the
// blocked prompt then expires on the Rust side and Git fails on its own.
function closeAskpass(): void {
  askpassDialog.hidden = true;
  askpassSecret.value = "";
  askpassPending = null;
}

void listen<AskPassRequest>("askpass-request", ({ payload }) => {
  askpassPending = payload;
  askpassSecret.type = payload.kind === "password" ? "password" : "text";
  askpassSecret.value = "";
  askpassPrompt.textContent =
    payload.kind === "password" && payload.user !== null
      ? `Password for ${payload.target} as ${payload.user}:`
      : `${payload.kind === "password" ? "Password" : "Username"} for ${payload.target}:`;
  askpassDialog.hidden = false;
  askpassSecret.focus();
});
askpassSubmitButton.addEventListener("click", () => {
  const pending = askpassPending;
  const secret = askpassSecret.value;
  closeAskpass();
  if (!pending || secret === "") return;
  void invoke("submit_askpass", { operationId: pending.operationId, secret }).catch((error) => {
    showError(error);
    remoteStatus.textContent = "That credential prompt is no longer open.";
  });
});
askpassCancelButton.addEventListener("click", closeAskpass);
askpassSecret.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    askpassSubmitButton.click();
  }
});

function syncRemoteControls(): void {
  const locked = !sessionActive || writeRunning;
  remoteNameInput.disabled = locked;
  remoteUrlInput.disabled = locked;
  remoteAddButton.disabled = locked;
  remoteFetchAllButton.disabled = locked;
  pullStrategySelect.disabled = locked;
  remotePullButton.disabled = locked;
  remotePushButton.disabled = locked;
  publishRemoteSelect.disabled = locked;
  remotePublishButton.disabled = locked;
  authRetryButton.disabled = locked;
  forcePushPreviewButton.disabled = locked;
}
