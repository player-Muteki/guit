import { el, icon } from "./dom";
import { onDispose } from "./lifecycle";
import {
  activeView,
  currentSnapshot,
  isSessionActive,
  isToolRunning,
  isWatchFailed,
  isWriteRunning,
  setActiveView,
  statusLine,
  VIEW_ORDER,
  watchStatus,
  type ViewId,
} from "./state";
import { branchLabel } from "./headModel";
import { railHint, VIEW_TITLES } from "./railModel";
import { VIEW_HINTS } from "./viewHints";
import { isAlwaysOnTop, isMaximized, onAlwaysOnTopChange, onMaximizedChange } from "./window";

export interface ViewDescriptor {
  id: ViewId;
  element: HTMLElement;
}

export interface ShellActions {
  openRepository(): void;
  refresh(): void;
  closeRepository(): void;
  openRecent(path: string): void;
  cancelWrite(): void;
  cancelTool(): void;
  setOnTop(value: boolean): void;
  minimize(): void;
  toggleMaximize(): void;
  closeWindow(): void;
}

export interface Shell {
  readonly appbar: HTMLElement;
  readonly statusbar: HTMLElement;
  readonly stage: HTMLElement;
  registerView(descriptor: ViewDescriptor | { id: "welcome"; element: HTMLElement }): void;
  /**
   * Puts the one page-sized overlay's content into the shell. The branch
   * picker is a temporary layer inside Main rather than a third tab, so the
   * shell hosts it and decides when it is on screen; it never reads it.
   *
   * `onShow` runs every time the layer becomes visible, including the first
   * time. It is how a layer gets fresh content on being opened without the
   * shell knowing anything about what that content is.
   */
  registerOverlay(content: HTMLElement, onShow?: () => void): void;
  openOverlay(): void;
  closeOverlay(): void;
  /** Whether the layer is on screen right now. */
  isOverlayOpen(): boolean;
  focusCommit(): void;
  /**
   * Focuses the tab item for the page on screen. This is where the confirm
   * dialog sends focus when the button that opened it was rebuilt while the
   * dialog was up: the tab strip is chrome, so it is never replaced, and it
   * is a place the user can navigate from.
   */
  focusTabs(): void;
  /** Repaints only the status bar. See `main.ts`: a streamed progress line
   * must not cost a render of every view. */
  renderRecents(paths: string[]): void;
  renderStatus(): void;
  render(): void;
  dispose(): void;
}

export function createShell(actions: ShellActions): Shell {
  const repoLabel = el("span", { class: "appbar-repo-name", text: "Open repository" });
  const repoButton = el("button", {
    class: "appbar-repo", type: "button", "aria-label": "Repository menu",
    "aria-haspopup": "menu", "aria-expanded": "false", "aria-controls": "repository-menu",
  }, [icon("folder"), repoLabel, el("span", { class: "repo-chevron", text: "▾", "aria-hidden": "true" })]);
  const repoInfo = el("div", { class: "repository-info" });
  const recentGroup = el("div", { role: "group", "aria-label": "Recent repositories", hidden: true });
  const recentItems = el("div", { class: "repository-recents" });
  recentGroup.append(el("div", { class: "repository-heading", text: "Recent repositories" }), recentItems);
  const repositoryMenu = el("div", {
    id: "repository-menu", class: "menu repository-menu", role: "menu", "aria-label": "Repository", hidden: true,
  });
  const menuButton = (label: string, run: () => void): HTMLButtonElement => {
    const entry = el("button", { class: "menu-item", type: "button", role: "menuitem", text: label, "aria-label": label.replace(/…$/, ""), tabIndex: -1 });
    entry.addEventListener("click", () => { closeMenus(); run(); });
    return entry;
  };
  const openButton = menuButton("Open repository…", actions.openRepository);
  const refreshButton = menuButton("Refresh status", actions.refresh);
  const closeButton = menuButton("Close session", actions.closeRepository);
  const branchesButton = menuButton("Branches and tags…", () => {
    setActiveView("main");
    openOverlay();
  });
  repositoryMenu.append(repoInfo, openButton, recentGroup, refreshButton, branchesButton, closeButton);
  const pinButton = el("button", {
    class: "icon-btn", type: "button", "aria-label": "Always on top", title: "Always on top",
  }, [icon("pin")]);
  const minimizeButton = el("button", {
    class: "icon-btn", type: "button", "aria-label": "Minimise", title: "Minimise",
  }, [icon("minimize")]);
  const maximizeButton = el("button", { class: "icon-btn", type: "button" }, [icon("maximize")]);
  const quitButton = el("button", {
    class: "icon-btn window-close", type: "button", "aria-label": "Close guit", title: "Close guit",
  }, [icon("close")]);
  const windowControls = el("div", {
    class: "window-controls",
    role: "group",
    "aria-label": "Window",
  });
  windowControls.append(pinButton, minimizeButton, maximizeButton, quitButton);
  const paintMaximize = (value: boolean): void => {
    maximizeButton.setAttribute("aria-label", value ? "Restore window" : "Maximise window");
    maximizeButton.title = value ? "Restore" : "Maximise";
    maximizeButton.replaceChildren(icon(value ? "restore" : "maximize"));
  };
  paintMaximize(isMaximized());
  onDispose(onMaximizedChange(paintMaximize));
  onDispose(onAlwaysOnTopChange(() => render()));
  const appbar = el("header", { class: "appbar" }, [
    repoButton,
    el("div", { class: "window-drag-region", "aria-hidden": "true" }),
    repositoryMenu,
  ]);
  function closeMenus(restoreFocus = true): void {
    if (repositoryMenu.hidden) return;
    repositoryMenu.hidden = true;
    repoButton.setAttribute("aria-expanded", "false");
    if (restoreFocus) repoButton.focus({ preventScroll: true });
  }
  function menuEntries(): HTMLButtonElement[] {
    return Array.from(repositoryMenu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
  }
  function openMenu(last = false): void {
    repositoryMenu.hidden = false;
    repoButton.setAttribute("aria-expanded", "true");
    const entries = menuEntries();
    (last ? entries.at(-1) : entries[0])?.focus({ preventScroll: true });
  }
  repoButton.addEventListener("click", () => {
    if (repositoryMenu.hidden) openMenu();
    else closeMenus();
  });
  repoButton.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    openMenu(event.key === "ArrowUp");
  });
  repositoryMenu.addEventListener("keydown", (event) => {
    const entries = menuEntries();
    const position = entries.indexOf(document.activeElement as HTMLButtonElement);
    let next: number;
    if (event.key === "ArrowDown") next = (position + 1) % entries.length;
    else if (event.key === "ArrowUp") next = (position + entries.length - 1) % entries.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = entries.length - 1;
    else if (event.key === "Tab") { closeMenus(); return; }
    else return;
    event.preventDefault();
    entries[next]?.focus();
  });
  const dismissMenus = (event: Event): void => {
    const target = event.target as Node;
    if (!repositoryMenu.contains(target) && !repoButton.contains(target)) closeMenus(false);
  };
  const escapeStack = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    if (!repositoryMenu.hidden) {
      event.preventDefault();
      event.stopPropagation();
      closeMenus();
    } else closeOverlay();
  };
  document.addEventListener("click", dismissMenus);
  document.addEventListener("focusin", dismissMenus);
  document.addEventListener("keydown", escapeStack);
  onDispose(() => {
    document.removeEventListener("click", dismissMenus);
    document.removeEventListener("focusin", dismissMenus);
    document.removeEventListener("keydown", escapeStack);
  });
  const windowAction = (run: () => void): void => { closeMenus(false); run(); };
  pinButton.addEventListener("click", () => windowAction(() => actions.setOnTop(!isAlwaysOnTop())));
  minimizeButton.addEventListener("click", () => windowAction(() => actions.minimize()));
  maximizeButton.addEventListener("click", () => windowAction(() => actions.toggleMaximize()));
  quitButton.addEventListener("click", () => windowAction(() => actions.closeWindow()));
  const renderRecents = (paths: string[]): void => {
    const focused = recentItems.contains(document.activeElement);
    recentItems.replaceChildren(...paths.map((path) => {
      const entry = menuButton(path, () => actions.openRecent(path));
      entry.title = path;
      return entry;
    }));
    recentGroup.hidden = paths.length === 0;
    if (focused) openButton.focus();
  };

  // --- tabs ---
  // Exactly two pages, both reachable from a cold start: Main is the panel
  // (and the repository entry while no repository is open), Settings is the
  // application. A tab is a button carrying `aria-current="page"`, which is
  // how a screen reader and the harness both tell which page is on screen.
  //
  // The hint is static, so it is written once here rather than recomputed on
  // every render: a live repository repaints many times a minute and the tab
  // strip never changes with it.
  const tabs = el("nav", { class: "tabs", "aria-label": "Pages" });
  const tabButtons = new Map<ViewId, HTMLButtonElement>();
  const badge = el("span", { class: "tab-badge", hidden: true });
  for (const id of VIEW_ORDER) {
    const children: Array<HTMLElement | SVGSVGElement> = [
      el("span", { class: "tab-label", text: VIEW_TITLES[id] }),
    ];
    if (id === "main") children.push(badge);
    const item = el("button", {
      class: "tab-item",
      type: "button",
      "aria-label": VIEW_TITLES[id],
      title: railHint(id, VIEW_ORDER),
      // A custom theme is asked whether the way out of it is still on the screen, and
      // the tabs are the part of that way that is on every screen: Settings is where a
      // theme is turned off, so the button that reaches it has to survive the draw.
      "data-recovery": "tab",
    }, children);
    item.addEventListener("click", () => setActiveView(id));
    tabButtons.set(id, item);
    tabs.append(item);
  }
  appbar.append(tabs);
  appbar.append(windowControls);
  const measureBar = (): void => {
    const font = parseFloat(getComputedStyle(document.documentElement).fontSize);
    const required = tabs.getBoundingClientRect().width + windowControls.getBoundingClientRect().width + font * 10;
    appbar.classList.toggle("two-rows", appbar.clientWidth < required);
  };
  const barObserver = new ResizeObserver(measureBar);
  for (const node of [appbar, tabs, windowControls]) barObserver.observe(node);
  onDispose(() => barObserver.disconnect());

  // --- overlay ---
  // The one layer that covers the stage: the branch picker opens here. It is
  // not a page, so it has no tab, and it is not a dialog, because the user
  // can still reach the tab strip while it is up.
  const overlay = el("div", { class: "overlay", tabIndex: -1, hidden: true });
  let overlayShown: (() => void) | null = null;
  const closeOverlay = (): void => {
    if (overlay.hidden) return;
    overlay.hidden = true;
    focusTabs();
  };
  const openOverlay = (): void => {
    const opening = overlay.hidden;
    overlay.hidden = false;
    overlay.focus();
    // Reading happens on the way in rather than on every snapshot: a picker
    // that is closed has nothing to keep current.
    if (opening) overlayShown?.();
  };

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
  // Interface zoom lives in Settings → General, and the keyboard shortcuts in
  // main.ts still reach it. A permanent cluster of four controls in the status
  // bar duplicated a setting touched twice a year and spent the width that a
  // streaming progress line needs on exactly the narrow windows where that
  // line has the least of it.
  const statusbar = el("footer", { class: "statusbar" }, [
    statusText,
    cancelButton,
    el("div", { class: "spacer" }),
    monitorLabel,
  ]);
  cancelButton.addEventListener("click", () => {
    if (isToolRunning()) actions.cancelTool();
    else actions.cancelWrite();
  });

  // --- view containers ---
  // "welcome" is a pseudo-view: it has no tab and is the empty state of Main,
  // never a page of its own. `settings` is the one real view that does not
  // need a repository (theme, zoom, external tools, environment and
  // diagnostics are all application-level), so it stays reachable in the
  // empty state.
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
    const monitor = watch === "none" ? "" : isWatchFailed()
      ? "Monitor: refresh failed — use Refresh status"
      : `Monitor: ${watch === "poll" ? "polling" : "filesystem events"}`;
    if (monitorLabel.textContent !== monitor) monitorLabel.textContent = monitor;
  };

  const render = (): void => {
    const snapshot = currentSnapshot();
    const active = activeView();
    const session = isSessionActive();
    const name = snapshot?.repo.displayName ?? "Open repository";
    const path = snapshot?.repo.root ?? snapshot?.repo.gitDir ?? "";
    if (repoLabel.textContent !== name) repoLabel.textContent = name;
    repoButton.title = path || "Open a local repository";
    const info = session ? path + "\n" + branchLabel(snapshot?.branch ?? null) : "No repository open";
    if (repoInfo.textContent !== info) repoInfo.textContent = info;
    refreshButton.disabled = !session;
    closeButton.disabled = !session;
    branchesButton.disabled = !session;
    pinButton.classList.toggle("active", isAlwaysOnTop());
    pinButton.setAttribute("aria-pressed", String(isAlwaysOnTop()));

    const pending = snapshot?.files.filter((file) => file.unstaged || file.untracked).length ?? 0;
    badge.hidden = pending === 0;
    badge.textContent = pending > 99 ? "99+" : String(pending);
    badge.setAttribute("aria-label", String(pending) + " unstaged or untracked files");

    for (const [id, item] of tabButtons) {
      const selected = id === active;
      item.classList.toggle("selected", selected);
      item.setAttribute("aria-current", selected ? "page" : "false");
    }
    for (const [id, view] of views) {
      // The main panel is the one page with nothing to show before a
      // repository is open, and the welcome state shows in its place.
      view.element.hidden = id !== active || (id === "main" && !session);
    }
    if (welcomeElement !== null) welcomeElement.hidden = session || active !== "main";
    // Leaving Main leaves the layer that belongs to Main behind: a picker for
    // a page that is not on screen must not cover Settings.
    if (active !== "main") overlay.hidden = true;

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
    descriptor.element.classList.add("view");
    descriptor.element.setAttribute("aria-label", title);
    // Only Settings wears a page heading. The main panel fills its page with
    // two regions that each name themselves, and repeating the tab's word
    // above them costs a row the narrow window does not have.
    if (descriptor.id === "settings") {
      descriptor.element.prepend(
        el("header", { class: "view-head" }, [
          el("h1", { class: "view-title", text: title }),
          el("p", { class: "view-subtitle", text: VIEW_HINTS[descriptor.id] }),
        ]),
      );
    }
    stage.append(descriptor.element);
    views.set(descriptor.id, descriptor);
  };

  const registerOverlay = (content: HTMLElement, onShow?: () => void): void => {
    content.hidden = false;
    overlayShown = onShow ?? null;
    overlay.append(content);
    stage.append(overlay);
  };

  const isOverlayOpen = (): boolean => !overlay.hidden;

  const focusCommit = (): void => {
    setActiveView("main");
    const box = views.get("main")?.element.querySelector<HTMLTextAreaElement>("#commit-message");
    box?.focus();
  };

  const focusTabs = (): void => {
    const current = activeView();
    const item = tabButtons.get(current) ?? tabButtons.get("main");
    item?.focus();
  };

  return {
    appbar,
    statusbar,
    stage,
    registerView,
    registerOverlay,
    openOverlay,
    closeOverlay,
    isOverlayOpen,
    focusCommit,
    focusTabs,
    renderRecents,
    renderStatus,
    render,
    dispose() { closeMenus(); },
  };
}
