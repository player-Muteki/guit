// Window behaviour: always-on-top, bounds persistence (viewport pixels plus
// measured frame, which is what survives a scale change), focus refresh, the
// compact/restore size test used by Settings, and the four actions behind the
// app bar's window buttons. Every native action is awaited: a control that
// shows the state it asked for, whatever the desktop made of the request, is a
// control that can be trusted when it says the window is pinned.

import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { CheckMenuItem, Menu, MenuItem } from "@tauri-apps/api/menu";
import { invoke } from "@tauri-apps/api/core";
import { el } from "./dom";
import type { WindowSettings } from "./types";

const currentWindow = getCurrentWindow();

let saveTimer: number | undefined;
let saveQueue: Promise<void> = Promise.resolve();
let lastNormalBounds: Pick<WindowSettings, "width" | "height" | "frameWidth" | "frameHeight" | "x" | "y"> | undefined;
let alwaysOnTop = false;
let previousSize: LogicalSize | undefined;
let previouslyMaximized = false;
let restoreEnabled = false;

export const isAlwaysOnTop = (): boolean => alwaysOnTop;
export const isRestoreEnabled = (): boolean => restoreEnabled;

export async function persistWindowSettings(): Promise<void> {
  saveQueue = saveQueue.then(async () => {
    try {
      const [scale, position, maximized, outer] = await Promise.all([
        currentWindow.scaleFactor(),
        currentWindow.outerPosition(),
        currentWindow.isMaximized(),
        currentWindow.outerSize(),
      ]);
      const size = { width: Math.round(window.innerWidth * scale), height: Math.round(window.innerHeight * scale) };
      const frame = {
        frameWidth: Math.max(0, outer.width - size.width),
        frameHeight: Math.max(0, outer.height - size.height),
      };
      if (!maximized) {
        lastNormalBounds = { ...size, ...frame, x: position.x, y: position.y };
      }
      const bounds = lastNormalBounds ?? { ...size, ...frame, x: position.x, y: position.y };
      await invoke("save_window_settings", {
        settings: {
          ...bounds,
          schemaVersion: 1,
          alwaysOnTop,
          maximized,
        } satisfies WindowSettings,
      });
    } catch {
      // A failed save must never block the app; the next resize retries.
    }
  });
  return saveQueue;
}

export function scheduleWindowSave(): void {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void persistWindowSettings(), 400);
}

export async function setAlwaysOnTop(value: boolean): Promise<void> {
  const previous = alwaysOnTop;
  try {
    await currentWindow.setAlwaysOnTop(value);
    setTopmost(value);
    scheduleWindowSave();
  } catch (error) {
    // The window kept the state it was in, which is the one thing this module can say
    // without asking the desktop: every request to change it came from the flag. So the
    // flag goes back too, and the button reports the refusal rather than the wish.
    setTopmost(previous);
    throw error;
  }
}

const topmostListeners = new Set<(value: boolean) => void>();

// Both the app-bar button and the Settings checkbox answer for the same fact, and
// `restoreWindowState` writes it at boot before either of them has drawn. So the flag is
// announced wherever it changes rather than read by whoever is holding a click.
function setTopmost(value: boolean): void {
  if (alwaysOnTop === value) return;
  alwaysOnTop = value;
  for (const listener of Array.from(topmostListeners)) listener(value);
}

export function onAlwaysOnTopChange(listener: (value: boolean) => void): () => void {
  topmostListeners.add(listener);
  return () => topmostListeners.delete(listener);
}

let maximized = false;
const maximizeListeners = new Set<(value: boolean) => void>();

/** The last answer this module got, for a render that cannot wait. */
export const isMaximized = (): boolean => maximized;

/** Ask the window what it is. Every way into the maximised state but this module's own
 * button — a double-click on the native title bar, `Alt+Space`, a desktop shortcut, a
 * refused maximise — is a change this file never saw, so the label is read rather than
 * remembered. */
export async function syncMaximized(): Promise<boolean> {
  try {
    setMaximized(await currentWindow.isMaximized());
  } catch {
    // A window that will not say leaves the button offering the action it offered
    // before. The state is what is at risk here, not the ability to act.
  }
  return maximized;
}

function setMaximized(value: boolean): void {
  if (maximized === value) return;
  maximized = value;
  for (const listener of Array.from(maximizeListeners)) listener(value);
}

export function onMaximizedChange(listener: (value: boolean) => void): () => void {
  maximizeListeners.add(listener);
  return () => maximizeListeners.delete(listener);
}

export async function minimizeWindow(): Promise<void> {
  await currentWindow.minimize();
}

/** The one control that means two opposite things, so it reads the window's state at
 * the moment it is asked rather than trusting the last label it was drawn with. */
export async function toggleMaximized(): Promise<void> {
  if (await syncMaximized()) await currentWindow.unmaximize();
  else await currentWindow.maximize();
  await syncMaximized();
  scheduleWindowSave();
}

/** The request, not the destruction: `close` is what the hook at the bottom of this file
 * answers, and that hook is the only path that lets every component go, writes the
 * geometry down and then destroys the window. A button that called `destroy()` itself
 * would close the window and lose the size it was asked to keep. */
export async function closeWindow(): Promise<void> {
  await currentWindow.close();
}

export function installWindowChrome(appbar: HTMLElement, onError: (error: unknown) => void): () => void {
  let disposed = false;
  const attempt = (action: () => Promise<void>): void => { void action().catch(onError); };
  let menuPromise: Promise<{ menu: Menu; pin: CheckMenuItem; maximize: MenuItem; items: Array<MenuItem | CheckMenuItem> }> | null = null;
  const showMenu = async (position: LogicalPosition): Promise<void> => {
    menuPromise ??= (async () => {
      const pin = await CheckMenuItem.new({ text: "Always on top", checked: isAlwaysOnTop(), action: () => attempt(() => setAlwaysOnTop(!isAlwaysOnTop())) });
      const minimize = await MenuItem.new({ text: "Minimise", action: () => attempt(minimizeWindow) });
      const maximize = await MenuItem.new({ text: "Maximise", action: () => attempt(toggleMaximized) });
      const close = await MenuItem.new({ text: "Close guit", action: () => attempt(closeWindow) });
      const items = [pin, minimize, maximize, close];
      const menu = await Menu.new({ items });
      return { menu, pin, maximize, items };
    })().catch((error) => { menuPromise = null; throw error; });
    const { menu, pin, maximize } = await menuPromise;
    if (disposed) return;
    await pin.setChecked(isAlwaysOnTop());
    await maximize.setText(await syncMaximized() ? "Restore window" : "Maximise window");
    await menu.popup(position);
  };
  const isDragTarget = (target: EventTarget | null): boolean => target instanceof Element
    && !target.closest("button, input, textarea, select, a, [role=menu]");
  const drag = (event: MouseEvent): void => {
    if (event.button !== 0 || !isDragTarget(event.target)) return;
    event.preventDefault();
    attempt(event.detail === 2 ? toggleMaximized : () => currentWindow.startDragging());
  };
  const context = (event: MouseEvent): void => {
    if (!isDragTarget(event.target)) return;
    event.preventDefault();
    attempt(() => showMenu(new LogicalPosition(event.clientX, event.clientY)));
  };
  const keys = (event: KeyboardEvent): void => {
    if (!event.altKey || event.ctrlKey || event.metaKey || event.code !== "Space") return;
    event.preventDefault();
    attempt(() => showMenu(new LogicalPosition(8, appbar.offsetHeight)));
  };
  appbar.addEventListener("mousedown", drag);
  appbar.addEventListener("contextmenu", context);
  document.addEventListener("keydown", keys);
  const directions = ["North", "South", "East", "West", "NorthEast", "NorthWest", "SouthEast", "SouthWest"] as const;
  const handles = directions.map((direction) => {
    const handle = el("div", { class: "window-resize", "data-direction": direction, "aria-hidden": "true", hidden: isMaximized() });
    handle.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      attempt(() => currentWindow.startResizeDragging(direction));
    });
    document.body.append(handle);
    return handle;
  });
  const unlisten = onMaximizedChange((value) => handles.forEach((handle) => { handle.hidden = value; }));
  return () => {
    disposed = true;
    appbar.removeEventListener("mousedown", drag);
    appbar.removeEventListener("contextmenu", context);
    document.removeEventListener("keydown", keys);
    unlisten();
    handles.forEach((handle) => handle.remove());
    void menuPromise?.then(async ({ menu, items }) => {
      await menu.close();
      await Promise.all(items.map((item) => item.close()));
    }).catch(onError);
  };
}

export async function restoreWindowState(): Promise<boolean> {
  const settings = await invoke<WindowSettings | null>("restore_window_settings");
  // A run with nothing stored is a person who has never chosen, and the panel's whole
  // use is being visible while something else has the focus — so the unchosen default
  // is pinned. An explicit `false` in a stored record is the choice they did make, and
  // is honoured by the same sentence. The window agrees because `tauri.conf.json`
  // creates it pinned and the restore overwrites that with whatever it stored.
  setTopmost(settings?.alwaysOnTop ?? true);
  lastNormalBounds = settings
    ? {
        width: settings.width,
        height: settings.height,
        frameWidth: settings.frameWidth,
        frameHeight: settings.frameHeight,
        x: settings.x,
        y: settings.y,
      }
    : undefined;
  await syncMaximized();
  return alwaysOnTop;
}

export async function windowGeometry(): Promise<string> {
  const [inner, outer, scale, maximized] = await Promise.all([
    currentWindow.innerSize(),
    currentWindow.outerSize(),
    currentWindow.scaleFactor(),
    currentWindow.isMaximized(),
  ]);
  return (
    `Viewport ${window.innerWidth} × ${window.innerHeight} logical; ` +
    `API inner ${inner.width} × ${inner.height}; outer ${outer.width} × ${outer.height}; ` +
    `scale ${scale}; maximized ${maximized}`
  );
}

export async function compactWindow(): Promise<void> {
  previousSize = new LogicalSize(window.innerWidth, window.innerHeight);
  previouslyMaximized = await currentWindow.isMaximized();
  if (previouslyMaximized) await currentWindow.unmaximize();
  await currentWindow.setSize(new LogicalSize(340, 400));
  restoreEnabled = true;
}

export async function restoreWindowSize(): Promise<void> {
  if (!previousSize) return;
  if (previouslyMaximized) await currentWindow.maximize();
  else await currentWindow.setSize(previousSize);
  restoreEnabled = false;
}

export interface WindowHooks {
  onGeometryChange(text: string): void;
  onFocus(): void;
  /** Something is about to be thrown away, so a close is held. Every route onto
   * a close — the title bar, the app-bar button, a keyboard quit — is asked
   * before the window goes, and this module keeps no opinion about when one
   * should be held: it asks and does what the answer says. Whoever answers is
   * the only party that can also tell the user why, so the message belongs to
   * this call, not to the caller's return value. A held close leaves the window
   * exactly as it was, which is what makes a second, deliberate press a
   * decision rather than an accident. */
  vetoClose(): boolean;
  /** The window is going away for good. Each component lets go of what it
   * attached — watchers, timers, document handlers — before the size is
   * written down and the window is destroyed. */
  onClosing(): void;
  onError(error: unknown): void;
}

export async function installWindowHooks(hooks: WindowHooks): Promise<void> {
  try {
    await currentWindow.onResized(({ payload }) => {
      hooks.onGeometryChange(`Resized to ${payload.width} × ${payload.height} physical pixels`);
      // A resize is the only notice this module gets that the maximised state moved —
      // the desktop does not announce a title-bar double-click.
      void syncMaximized();
      scheduleWindowSave();
    });
    await currentWindow.onMoved(() => scheduleWindowSave());
    await currentWindow.onFocusChanged(({ payload }) => {
      if (payload) hooks.onFocus();
    });
    await currentWindow.onCloseRequested(async (event) => {
      event.preventDefault();
      // Asked first, before anything is written down or thrown away: a held
      // close must leave the panel exactly as the user left it.
      if (hooks.vetoClose()) return;
      window.clearTimeout(saveTimer);
      hooks.onClosing();
      await persistWindowSettings();
      try {
        await currentWindow.destroy();
      } catch (error) {
        hooks.onError(error);
      }
    });
    scheduleWindowSave();
  } catch (error) {
    hooks.onError(error);
  }
}
