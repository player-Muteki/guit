// The application shell: app bar (repo, branch chip, commit, the window cluster),
// the two-page tab strip, the overlay the branch picker borrows, and
// the status bar (running operation, watch mode, interface zoom). The shell
// owns no Git semantics — every action is injected by `main.ts` so the views
// stay the only place that talks to the backend. The window buttons are injected
// for the same reason: this file draws what the desktop reports back, and never
// asks the window for anything itself.

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
import { aheadBehind, branchLabel } from "./headModel";
import { railHint, VIEW_ICONS, VIEW_TITLES } from "./railModel";
import { VIEW_HINTS } from "./viewHints";
import { isAlwaysOnTop, isMaximized, onAlwaysOnTopChange, onMaximizedChange, setAlwaysOnTop } from "./window";

export interface ViewDescriptor {
  id: ViewId;
  element: HTMLElement;
}

export interface ShellActions {
  openRepository(): void;
  refresh(): void;
  closeRepository(): void;
  commit(): void;
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
  renderStatus(): void;
  render(): void;
  dispose(): void;
}

function repoName(): string | null {
  const snapshot = currentSnapshot();
  if (!snapshot) return null;
  return snapshot.repo.root ?? snapshot.repo.gitDir;
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
  // The three session buttons carry `appbar-session` because the More menu repeats them
  // by the same words, and at the minimum window one of the two copies has to go: see
  // `.window-controls` in the stylesheet.
  const openButton = el("button", {
    class: "icon-btn appbar-session",
    type: "button",
    "aria-label": "Open repository",
    title: "Open repository… (Ctrl+O)",
  }, [icon("folder")]);
  const refreshButton = el("button", {
    class: "icon-btn appbar-session",
    type: "button",
    "aria-label": "Refresh status",
    title: "Refresh status (Ctrl+R)",
  }, [icon("refresh")]);
  const closeButton = el("button", {
    class: "icon-btn appbar-session",
    type: "button",
    "aria-label": "Close session",
    title: "Close the current session",
  }, [icon("close")]);
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

  // --- window controls ---
  // The four actions the panel promises on both pages, in the order a title bar puts
  // them: pin, minimise, maximise or restore, close. They belong to the shell rather
  // than to a page, which is what makes them the same four on Settings as on Main.
  //
  // The native title bar is still there, so these are a second way onto the window's
  // own actions, and the shell only forwards the request: `main.ts` waits for the
  // desktop's answer, and what is painted below is the state the window reported, never
  // the state that was asked for. A pin the desktop refused therefore reads as unpinned.
  const windowControls = el("div", {
    class: "window-controls",
    role: "group",
    "aria-label": "Window",
  });
  const minimizeButton = el("button", {
    class: "icon-btn",
    type: "button",
    "aria-label": "Minimise",
    title: "Minimise",
  }, [icon("minimize")]);
  const maximizeButton = el("button", { class: "icon-btn", type: "button" }, [icon("maximize")]);
  const quitButton = el("button", {
    class: "icon-btn",
    type: "button",
    "aria-label": "Close guit",
    title: "Close guit — the window's size and the panel's choices are written down first",
  }, [icon("close")]);
  windowControls.append(pinButton, minimizeButton, maximizeButton, quitButton);

  // The maximise button is the one control here whose meaning depends on the state it
  // is in, and the state moves without this shell being told: a double-click on the
  // native title bar, `Alt+Space`, a refused maximise. So the label follows a listener
  // on the window's answer rather than the last thing the button did.
  //
  // The two names are the app-bar's own: Settings carries a button called "Restore window
  // size" that belongs to the compact-window test and means something else entirely, and
  // a harness that finds a control by name cannot tell two identical names apart.
  const paintMaximize = (value: boolean): void => {
    maximizeButton.setAttribute("aria-label", value ? "Restore window" : "Maximise window");
    maximizeButton.title = value ? "Restore" : "Maximise";
    maximizeButton.replaceChildren(icon(value ? "restore" : "maximize"));
  };
  paintMaximize(isMaximized());
  onDispose(onMaximizedChange(paintMaximize));
  // The pin is the other control whose look is a fact about the window rather than about
  // the last click: the stored preference is applied at boot by `restoreWindowState`, and
  // a refused change is rolled back by `window.ts`. Both say so here, and `render` reads
  // the answer into the button.
  onDispose(onAlwaysOnTopChange(() => render()));
  const moreMenu = el("div", { class: "menu", role: "menu", hidden: true });
  const moreItems: Array<{ label: string; run: () => void }> = [
    { label: "Open repository…", run: actions.openRepository },
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
    closeButton,
    el("div", { class: "spacer" }),
    commitButton,
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

  const dismissMenus = (event: MouseEvent): void => {
    if (!(event.target as HTMLElement).closest(".appbar")) closeMenus();
  };
  // Escape walks down the stack: an app-bar menu first, then the overlay,
  // and a modal dialog is never reached here because it cancels itself.
  const escapeStack = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    closeMenus();
    closeOverlay();
  };

  document.addEventListener("click", dismissMenus);
  document.addEventListener("keydown", escapeStack);
  onDispose(() => {
    document.removeEventListener("click", dismissMenus);
    document.removeEventListener("keydown", escapeStack);
  });

  moreButton.addEventListener("click", (event) => {
    event.stopPropagation();
    openMenu(moreMenu, moreButton);
  });
  openButton.addEventListener("click", () => actions.openRepository());
  refreshButton.addEventListener("click", () => actions.refresh());
  closeButton.addEventListener("click", () => actions.closeRepository());
  commitButton.addEventListener("click", () => actions.commit());
  // The app-bar menu is anchored to the bar's right edge, which is where this cluster
  // now sits, and a window action is not a way of answering the repository menu. So each
  // of the four takes the menu down with it rather than leaving it open over a window
  // that has just minimised. `closeMenus` returns focus to the button that opened the
  // menu, which is the exit a keyboard user already gets from Escape.
  const windowAction = (run: () => void): void => {
    closeMenus();
    run();
  };
  pinButton.addEventListener("click", () => windowAction(() => actions.setOnTop(!isAlwaysOnTop())));
  minimizeButton.addEventListener("click", () => windowAction(() => actions.minimize()));
  maximizeButton.addEventListener("click", () => windowAction(() => actions.toggleMaximize()));
  quitButton.addEventListener("click", () => windowAction(() => actions.closeWindow()));
  branchChip.addEventListener("click", () => {
    setActiveView("main");
    openOverlay();
  });

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
      icon(VIEW_ICONS[id]),
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
  // The window cluster is the last thing on the bar, so the four actions sit against the
  // top-right corner in the order a title bar puts them, on both pages. The native title
  // bar stays, which is also why there is no drag region here: moving the window and
  // double-clicking to maximise are already the decoration's job, and a second handler
  // for the same gesture in the page would undo the first.
  appbar.append(windowControls);

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
    const name = repoName();
    repoLabel.textContent = name ?? "No repository";
    repoLabel.title = name ?? "";
    const branch = snapshot?.branch ?? null;
    branchChip.textContent = `${branchLabel(branch)}${aheadBehind(branch)}`;
    branchChip.title = name ? `${name}\n${branchLabel(branch)}` : "No repository open";
    branchChip.disabled = !session;
    refreshButton.disabled = !session;
    closeButton.disabled = !session;
    commitButton.disabled = !session || isWriteRunning();
    pinButton.classList.toggle("active", isAlwaysOnTop());
    pinButton.setAttribute("aria-pressed", String(isAlwaysOnTop()));

    const pending = snapshot?.files.filter((file) => file.unstaged || file.untracked).length ?? 0;
    badge.hidden = pending === 0;
    badge.textContent = pending > 99 ? "99+" : String(pending);

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
    renderStatus,
    render,
    dispose() { closeMenus(); },
  };
}
