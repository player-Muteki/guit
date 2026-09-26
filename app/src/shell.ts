// The application shell: app bar (repo, branch chip, sync menu, commit,
// pin), the activity rail that switches views, and the status bar (running
// operation, watch mode, interface zoom). The shell owns no Git semantics —
// every action is injected by `main.ts` so the views stay the only place
// that talks to the backend.

import { el, icon } from "./dom";
import {
  activeView,
  currentSnapshot,
  isSessionActive,
  isToolRunning,
  isWriteRunning,
  setActiveView,
  statusLine,
  VIEW_ORDER,
  watchStatus,
  type ViewId,
} from "./state";
import type { BranchView } from "./types";
import { railHint, VIEW_ICONS, VIEW_TITLES } from "./railModel";
import { VIEW_HINTS } from "./viewHints";
import { currentFontPx, applyFontPx, FONT_DEFAULT } from "./font";
import { isAlwaysOnTop, setAlwaysOnTop } from "./window";

export interface ViewDescriptor {
  id: ViewId;
  element: HTMLElement;
}

export type SyncAction =
  | "fetchAll"
  | "push"
  | "publish"
  | { pull: true; strategy: "default" | "ffonly" | "merge" | "rebase" };

export interface ShellActions {
  openRepository(): void;
  refresh(): void;
  closeRepository(): void;
  clone(): void;
  commit(): void;
  cancelWrite(): void;
  cancelTool(): void;
  setOnTop(value: boolean): void;
  sync(action: SyncAction): void;
}

export interface Shell {
  readonly appbar: HTMLElement;
  readonly rail: HTMLElement;
  readonly statusbar: HTMLElement;
  readonly stage: HTMLElement;
  registerView(descriptor: ViewDescriptor | { id: "welcome"; element: HTMLElement }): void;
  focusCommit(): void;
  /**
   * Focuses the activity-rail item for the view on screen. This is where the
   * confirm dialog sends focus when the button that opened it was rebuilt
   * while the dialog was up: the rail is chrome, so it is never replaced, and
   * it is a place the user can navigate from.
   */
  focusRail(): void;
  /** Repaints only the status bar. See `main.ts`: a streamed progress line
   * must not cost a render of every view. */
  renderStatus(): void;
  render(): void;
  dispose(): void;
}

function repoName(): string | null {
  const snapshot = currentSnapshot();
  if (!snapshot) return null;
  return snapshot.repo.root ?? snapshot.repo.gitDir;
}

function branchLabel(branch: BranchView | null): string {
  if (!branch) return "bare repository";
  if (branch.headState === "detached") return `detached at ${branch.oid?.slice(0, 8) ?? "?"}`;
  if (branch.headState === "unborn") return `${branch.name ?? "?"} (no commits yet)`;
  return branch.name ?? "?";
}

function aheadBehind(branch: BranchView | null): string {
  if (!branch || !branch.upstream) return "";
  const parts: string[] = [];
  if (branch.ahead !== null) parts.push(`↑${branch.ahead}`);
  if (branch.behind !== null) parts.push(`↓${branch.behind}`);
  return parts.length ? ` ${parts.join(" ")}` : "";
}

export function createShell(actions: ShellActions): Shell {
  // --- app bar ---
  const wordmark = el("span", { class: "appbar-wordmark", text: "guit" });
  const repoLabel = el("span", { class: "appbar-repo", text: "No repository" });
  const branchChip = el("button", {
    class: "appbar-branch",
    type: "button",
    "aria-label": "Switch branch",
  });
  const openButton = el("button", {
    class: "icon-btn",
    type: "button",
    "aria-label": "Open repository",
    title: "Open repository… (Ctrl+O)",
  }, [icon("folder")]);
  const refreshButton = el("button", {
    class: "icon-btn",
    type: "button",
    "aria-label": "Refresh status",
    title: "Refresh status (Ctrl+R)",
  }, [icon("refresh")]);
  const cloneButton = el("button", {
    class: "icon-btn",
    type: "button",
    "aria-label": "Clone repository",
    title: "Clone a repository…",
  }, [icon("clone")]);
  const closeButton = el("button", {
    class: "icon-btn",
    type: "button",
    "aria-label": "Close session",
    title: "Close the current session",
  }, [icon("close")]);
  const syncButton = el("button", {
    class: "icon-btn",
    type: "button",
    "aria-label": "Sync",
    title: "Fetch, pull or push",
  }, [icon("sync")]);
  const commitButton = el("button", {
    class: "btn btn-primary appbar-commit",
    type: "button",
    text: "Commit",
  });
  const pinButton = el("button", {
    class: "icon-btn",
    type: "button",
    "aria-label": "Always on top",
    title: "Always on top",
  }, [icon("pin")]);
  const moreButton = el("button", {
    class: "icon-btn",
    type: "button",
    "aria-label": "More repository actions",
  }, [icon("more")]);
  const moreMenu = el("div", { class: "menu", role: "menu", hidden: true });
  const moreItems: Array<{ label: string; run: () => void }> = [
    { label: "Open repository…", run: actions.openRepository },
    { label: "Clone repository…", run: actions.clone },
    { label: "Refresh status", run: actions.refresh },
    { label: "Close session", run: actions.closeRepository },
  ];
  for (const item of moreItems) {
    const entry = el("button", { class: "menu-item", type: "button", role: "menuitem", text: item.label });
    entry.addEventListener("click", () => {
      closeMenus();
      item.run();
    });
    moreMenu.append(entry);
  }

  const appbar = el("header", { class: "appbar" }, [
    wordmark,
    repoLabel,
    branchChip,
    openButton,
    refreshButton,
    cloneButton,
    closeButton,
    el("div", { class: "spacer" }),
    syncButton,
    commitButton,
    pinButton,
    moreButton,
    moreMenu,
  ]);

  // The app-bar menus are inline (not floating), so one Escape handler and one
  // outside-click handler close all of them. Opening a menu moves focus to its
  // first item, and every exit returns focus to the button that opened it.
  let menuOpener: HTMLElement | null = null;
  function closeMenus(): void {
    const opener = menuOpener;
    menuOpener = null;
    moreMenu.hidden = true;
    syncMenu.hidden = true;
    pullMenu.hidden = true;
    opener?.focus();
  }
  function openMenu(next: HTMLElement, opener: HTMLElement): void {
    const wasOpen = !next.hidden;
    closeMenus();
    if (wasOpen) return;
    next.hidden = false;
    menuOpener = opener;
    (next.firstElementChild as HTMLElement | null)?.focus();
  }

  document.addEventListener("click", (event) => {
    if (!(event.target as HTMLElement).closest(".appbar")) closeMenus();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeMenus();
  });

  moreButton.addEventListener("click", (event) => {
    event.stopPropagation();
    openMenu(moreMenu, moreButton);
  });
  syncButton.addEventListener("click", (event) => {
    event.stopPropagation();
    openMenu(syncMenu, syncButton);
    pullMenu.hidden = true;
  });
  openButton.addEventListener("click", () => actions.openRepository());
  refreshButton.addEventListener("click", () => actions.refresh());
  cloneButton.addEventListener("click", () => actions.clone());
  closeButton.addEventListener("click", () => actions.closeRepository());
  commitButton.addEventListener("click", () => actions.commit());
  pinButton.addEventListener("click", () => actions.setOnTop(!isAlwaysOnTop()));
  branchChip.addEventListener("click", () => setActiveView("branches"));

  // --- sync menu (fetch / pull / push / publish) ---
  const syncMenu = el("div", { class: "menu", role: "menu", hidden: true });
  const pullMenu = el("div", { class: "menu submenu", role: "menu", hidden: true });
  const syncItems: Array<{ label: string; run: () => void }> = [
    { label: "Fetch all remotes", run: () => actions.sync("fetchAll") },
    { label: "Pull…", run: () => { syncMenu.hidden = true; pullMenu.hidden = false; } },
    { label: "Push", run: () => actions.sync("push") },
    { label: "Publish branch…", run: () => actions.sync("publish") },
  ];
  for (const item of syncItems) {
    const entry = el("button", { class: "menu-item", type: "button", role: "menuitem", text: item.label });
    entry.addEventListener("click", () => {
      closeMenus();
      item.run();
    });
    syncMenu.append(entry);
  }
  const pullItems: Array<{ label: string; run: () => void }> = [
    { label: "Git default", run: () => actions.sync({ pull: true, strategy: "default" }) },
    { label: "Fast-forward only", run: () => actions.sync({ pull: true, strategy: "ffonly" }) },
    { label: "Merge", run: () => actions.sync({ pull: true, strategy: "merge" }) },
    { label: "Rebase", run: () => actions.sync({ pull: true, strategy: "rebase" }) },
  ];
  for (const item of pullItems) {
    const entry = el("button", { class: "menu-item", type: "button", role: "menuitem", text: item.label });
    entry.addEventListener("click", () => {
      closeMenus();
      item.run();
    });
    pullMenu.append(entry);
  }
  appbar.append(syncMenu, pullMenu);

  // --- rail ---
  // Every item is built by the same loop, so no view can end up with a hint
  // its siblings do not have (the first item had lost its shortcut marker).
  const rail = el("nav", { class: "rail", "aria-label": "Views" });
  const railButtons = new Map<ViewId, HTMLButtonElement>();
  const badge = el("span", { class: "rail-badge", hidden: true });
  for (const id of VIEW_ORDER) {
    const children: Array<HTMLElement | SVGSVGElement> = [icon(VIEW_ICONS[id])];
    if (id === "changes") children.push(badge);
    const item = el("button", {
      class: "rail-item",
      type: "button",
      "aria-label": VIEW_TITLES[id],
      title: railHint(id, VIEW_ORDER, isSessionActive()),
    }, children);
    item.addEventListener("click", () => setActiveView(id));
    railButtons.set(id, item);
    rail.append(item);
  }

  // --- status bar ---
  const statusText = el("span", { class: "status-text", role: "status" });
  const cancelButton = el("button", { class: "status-cancel", type: "button", hidden: true });
  // WebKitGTK builds no accessible object for a bare <span> whose text is set
  // from script, so without a role the watch mode would be invisible both to a
  // screen reader and to the harness that drives the real window. `status` is
  // also the honest role: the line appears when the watcher starts and changes
  // when it falls back to polling, and a user who cannot tell those two apart
  // cannot tell whether an outside edit will show up on its own.
  const monitorLabel = el("span", { class: "status-monitor", role: "status" });
  const zoomOut = el("button", { class: "icon-btn tiny", type: "button", "aria-label": "Zoom out" }, [icon("minus", 12)]);
  const zoomLevel = el("span", { class: "status-zoom", "aria-label": "Interface zoom" });
  const zoomIn = el("button", { class: "icon-btn tiny", type: "button", "aria-label": "Zoom in" }, [icon("plus", 12)]);
  const zoomReset = el("button", { class: "icon-btn tiny", type: "button", "aria-label": "Reset zoom" }, [icon("refresh", 12)]);
  const statusbar = el("footer", { class: "statusbar" }, [
    statusText,
    cancelButton,
    el("div", { class: "spacer" }),
    monitorLabel,
    zoomOut,
    zoomLevel,
    zoomIn,
    zoomReset,
  ]);
  cancelButton.addEventListener("click", () => {
    if (isToolRunning()) actions.cancelTool();
    else actions.cancelWrite();
  });
  zoomOut.addEventListener("click", () => applyFontPx(currentFontPx() - 1));
  zoomIn.addEventListener("click", () => applyFontPx(currentFontPx() + 1));
  zoomReset.addEventListener("click", () => applyFontPx(FONT_DEFAULT));

  // --- view containers ---
  // "welcome" is a pseudo-view: it has no rail slot and stands in for every
  // repository-scoped view while no repository is open. `settings` is the one
  // real view that does not need a repository (theme, zoom, external tools,
  // environment and diagnostics are all application-level), so it stays
  // reachable in the empty state.
  const stage = el("div", { class: "stage" });
  const views = new Map<ViewId, ViewDescriptor>();
  let welcomeElement: HTMLElement | null = null;

  const renderStatus = (): void => {
    const line = statusLine();
    if (statusText.textContent !== line.message) statusText.textContent = line.message;
    statusText.dataset.kind = line.kind;
    const busy = isWriteRunning() || isToolRunning();
    cancelButton.hidden = !busy;
    cancelButton.textContent = isToolRunning() ? "Stop external tool" : "Cancel";
    const watch = watchStatus();
    // Only touch the text when it changes: a live region re-announces on every
    // mutation, and this line runs for every streamed progress line.
    const monitor = watch === "none" ? "" : `Monitor: ${watch === "poll" ? "polling" : "filesystem events"}`;
    if (monitorLabel.textContent !== monitor) monitorLabel.textContent = monitor;
    const zoom = `${currentFontPx()}px`;
    if (zoomLevel.textContent !== zoom) zoomLevel.textContent = zoom;
  };

  const render = (): void => {
    const snapshot = currentSnapshot();
    const active = activeView();
    const session = isSessionActive();
    const name = repoName();
    repoLabel.textContent = name ?? "No repository";
    repoLabel.title = name ?? "";
    const branch = snapshot?.branch ?? null;
    branchChip.textContent = `${branchLabel(branch)}${aheadBehind(branch)}`;
    branchChip.title = name ? `${name}\n${branchLabel(branch)}` : "No repository open";
    branchChip.disabled = !session;
    refreshButton.disabled = !session;
    closeButton.disabled = !session;
    syncButton.disabled = !session || isWriteRunning();
    commitButton.disabled = !session || isWriteRunning();
    pinButton.classList.toggle("active", isAlwaysOnTop());
    pinButton.setAttribute("aria-pressed", String(isAlwaysOnTop()));

    const pending = snapshot?.files.filter((file) => file.unstaged || file.untracked).length ?? 0;
    badge.hidden = pending === 0;
    badge.textContent = pending > 99 ? "99+" : String(pending);

    for (const [id, item] of railButtons) {
      const selected = id === active;
      item.classList.toggle("selected", selected);
      item.setAttribute("aria-current", selected ? "page" : "false");
      // A greyed rail item is the honest signal that its view has nothing to
      // show yet; Settings is exempt because it is application-level. The
      // hint is recomputed from the model either way, so it never sticks to
      // an item after a repository is opened.
      if (id !== "settings") item.disabled = !session;
      item.title = railHint(id, VIEW_ORDER, session);
    }
    for (const [id, view] of views) {
      view.element.hidden = id !== active || (id !== "settings" && !session);
    }
    if (welcomeElement !== null) welcomeElement.hidden = session || active === "settings";

    renderStatus();
  };

  const registerView = (descriptor: ViewDescriptor | { id: "welcome"; element: HTMLElement }): void => {
    // Every view starts hidden: the first `render` decides which one shows,
    // so a view never flashes on screen before the shell has state.
    descriptor.element.hidden = true;
    if (descriptor.id === "welcome") {
      descriptor.element.classList.add("view", "welcome");
      welcomeElement = descriptor.element;
      stage.prepend(descriptor.element);
      return;
    }
    const title = VIEW_TITLES[descriptor.id];
    const head = el("header", { class: "view-head" }, [
      el("h1", { class: "view-title", text: title }),
      el("p", { class: "view-subtitle", text: VIEW_HINTS[descriptor.id] }),
    ]);
    descriptor.element.classList.add("view");
    descriptor.element.setAttribute("aria-label", title);
    descriptor.element.prepend(head);
    stage.append(descriptor.element);
    views.set(descriptor.id, descriptor);
  };

  const focusCommit = (): void => {
    setActiveView("changes");
    const box = views.get("changes")?.element.querySelector<HTMLTextAreaElement>("#commit-message");
    box?.focus();
  };

  const focusRail = (): void => {
    const current = activeView();
    const item = railButtons.get(current) ?? railButtons.get("changes");
    item?.focus();
  };

  return {
    appbar,
    rail,
    statusbar,
    stage,
    registerView,
    focusCommit,
    focusRail,
    renderStatus,
    render,
    dispose() { closeMenus(); },
  };
}
