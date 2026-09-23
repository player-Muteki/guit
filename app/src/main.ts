import { invoke } from "@tauri-apps/api/core";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import {
  buildRows,
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

const app = document.querySelector<HTMLElement>("#app");
if (!app) throw new Error("Application root is missing");

app.innerHTML = `
  <header><strong>guit</strong><span>Git desktop client · read-only workbench</span></header>
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
    <h2>Changes</h2>
    <div id="file-list" class="files" role="list" aria-label="Changed files">
      <div id="file-virtual" class="virtual"><div id="file-rows" class="virtual-rows"></div></div>
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

const ROW_HEIGHT = 30;
const OVERSCAN = 6;
let listRows: ListRow[] = [];
let currentFiles: FileView[] = [];
const collapsedGroups = new Set<FileGroupKey>();
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
  repoSummary.textContent = "";
  if (!snapshot) {
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
  renderFileRows();
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
    fragment.append(createRow(listRows[index]));
  }
  fileRows.replaceChildren(fragment);
}

function createRow(row: ListRow): HTMLElement {
  const element = document.createElement("div");
  element.setAttribute("role", "listitem");
  if (row.kind === "heading") {
    element.className = "file-row group-heading";
    element.textContent = `${row.collapsed ? "▸" : "▾"} ${row.label} (${row.count})`;
    element.addEventListener("click", () => toggleGroup(row.group));
    return element;
  }
  element.className = "file-row";
  const file = row.file;
  const name = file.renameFrom ? `${file.renameFrom} → ${file.display}` : file.display;
  element.title = name;
  const status = document.createElement("span");
  status.className = "file-status";
  status.textContent = `${file.indexStatus}${file.worktreeStatus}`;
  const label = document.createElement("span");
  label.textContent = name;
  element.append(status, label);
  return element;
}

function toggleGroup(group: FileGroupKey): void {
  if (collapsedGroups.has(group)) collapsedGroups.delete(group);
  else collapsedGroups.add(group);
  listRows = buildRows(currentFiles, collapsedGroups);
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

async function openRepository(path: string): Promise<void> {
  openRepoButton.disabled = true;
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

openRepoButton.addEventListener("click", async () => {
  try {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === "string") await openRepository(selected);
  } catch (error) {
    showError(error);
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
