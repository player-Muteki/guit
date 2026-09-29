// Interface zoom and theme — the two appearance choices that existed before this
// record did, kept as they were applied but stored in one versioned place.
//
// Every rem-based size in the stylesheet follows `documentElement.fontSize`, so a
// zoom change repaints the window: the shell's readout and the row heights the
// virtual lists assume are both derived from this one number. Theme is a
// `data-theme` attribute on `<html>`; "system" leaves it off so that
// `prefers-color-scheme` decides.
//
// This module is the appearance half of the record's only writer, which is why a
// view reads the value back through `currentFontPx` and `currentTheme` instead of
// remembering what it asked for. The two can disagree: a patch is clamped, storage
// can refuse the write, and a record from a newer build seals every field for this
// session while still honouring the choice in memory.

import { notifyLayoutChange } from "./state";
import {
  FONT_DEFAULT,
  FONT_MAX,
  FONT_MIN,
  loadPreferences,
  updatePreferences,
} from "./preferencesModel";
import type { LegacyName, PreferenceStorage, Preferences, PreferencesState, Theme } from "./preferencesModel";

export { FONT_DEFAULT, FONT_MAX, FONT_MIN };

/** The pre-versioned keys this module does not write. The split drag and the
 * age-line interval still keep their own values, and naming them is what stops a
 * migration from deleting a key a live module is still writing. When one of those
 * owners moves onto the record it stops appearing here, and the name is deleted
 * from `LEGACY_KEYS` in the same change. */
const OWNED_ELSEWHERE: LegacyName[] = ["split", "interval"];

/** The WebView's own storage, or `null` for a window that has none. Reading the
 * property is the step that throws in a frame blocked against its origin; the
 * methods throw in private mode. Either way the session still gets every choice,
 * it just cannot keep them. */
function panelStorage(): PreferenceStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

let record: PreferencesState | null = null;

/** Read once and keep. Loading is lazy so that a view asking a question before
 * the window has painted gets a real answer rather than a default that was never
 * looked up. */
function preferences(): PreferencesState {
  if (record === null) record = loadPreferences(panelStorage(), OWNED_ELSEWHERE);
  return record;
}

/** Put the document into the state the record describes. */
function paint(): void {
  const prefs = preferences().prefs;
  document.documentElement.style.fontSize = `${prefs.fontPx}px`;
  if (prefs.theme === "system") {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.setAttribute("data-theme", prefs.theme);
  }
}

function change(patch: Partial<Record<keyof Preferences, unknown>>): void {
  record = updatePreferences(panelStorage(), preferences(), patch);
  paint();
  // Only the zoom moves a metric, so only the zoom owes a re-measure.
  if (patch.fontPx !== undefined) notifyLayoutChange();
}

export function currentFontPx(): number {
  return preferences().prefs.fontPx;
}

export function currentTheme(): Theme {
  return preferences().prefs.theme;
}

/** Store the zoom and apply it, clamped to the range the stylesheet can render. */
export function applyFontPx(px: number): void {
  change({ fontPx: px });
}

/** Store the theme and apply it. "system" leaves the attribute off so the
 * desktop's own scheme decides, and a value the record will not take leaves the
 * choice where it was — either way the applied theme comes back, so the row can
 * show what the panel is actually running on. */
export function applyTheme(choice: string): Theme {
  change({ theme: choice });
  return currentTheme();
}

/** Restore both choices, once, before the shell is built. */
export function startAppearance(): void {
  record = loadPreferences(panelStorage(), OWNED_ELSEWHERE);
  paint();
  notifyLayoutChange();
}
