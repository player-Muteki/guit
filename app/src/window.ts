// Window behaviour: always-on-top, bounds persistence (viewport pixels plus
// measured frame, which is what survives a scale change), focus refresh, and
// the compact/restore size test used by Settings. The native title bar stays
// — this module never sets `decorations: false`.

import { LogicalSize } from "@tauri-apps/api/dpi";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
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
  try {
    await currentWindow.setAlwaysOnTop(value);
    alwaysOnTop = value;
    scheduleWindowSave();
  } catch (error) {
    alwaysOnTop = !value;
    throw error;
  }
}

export async function restoreWindowState(): Promise<boolean> {
  const settings = await invoke<WindowSettings | null>("restore_window_settings");
  alwaysOnTop = settings?.alwaysOnTop ?? false;
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
  onError(error: unknown): void;
}

export async function installWindowHooks(hooks: WindowHooks): Promise<void> {
  try {
    await currentWindow.onResized(({ payload }) => {
      hooks.onGeometryChange(`Resized to ${payload.width} × ${payload.height} physical pixels`);
      scheduleWindowSave();
    });
    await currentWindow.onMoved(() => scheduleWindowSave());
    await currentWindow.onFocusChanged(({ payload }) => {
      if (payload) hooks.onFocus();
    });
    await currentWindow.onCloseRequested(async (event) => {
      event.preventDefault();
      window.clearTimeout(saveTimer);
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
