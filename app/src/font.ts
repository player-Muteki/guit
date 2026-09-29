// Interface zoom, the three font families and theme — the appearance choices kept
// as they were applied but stored in one versioned place.
//
// Every rem-based size in the stylesheet follows `documentElement.fontSize`, so a
// zoom change repaints the window: the shell's readout and the row heights the
// virtual lists assume are both derived from this one number. The two font
// properties are written here rather than left to the sheet for the same reason the
// zoom is: `--font-mono` in `tokens.css` is a request, and on this engine a family
// the host does not have is answered with a substituted face, so the sheet's own
// default draws an object ID proportionally. This module asks the engine and writes
// an answer that lines the column up. Theme is a `data-theme` attribute on `<html>`;
// "system" leaves it off so that `prefers-color-scheme` decides.
//
// This module is the appearance half of the record's only writer, which is why a
// view reads the value back through `currentFontPx`, `currentTheme` and
// `currentFonts` instead of remembering what it asked for. The two can disagree: a
// patch is clamped, storage can refuse the write, and a record from a newer build
// seals every field for this session while still honouring the choice in memory.

import { notifyLayoutChange } from "./state";
import { fontStackProperties } from "./fontStack";
import { resolveMonoStack } from "./fontResolve";
import {
  FAMILY_MAX,
  FONT_DEFAULT,
  FONT_MAX,
  FONT_MIN,
  loadPreferences,
  updatePreferences,
} from "./preferencesModel";
import type { LegacyName, PreferenceStorage, Preferences, PreferencesState, Theme } from "./preferencesModel";

export { FAMILY_MAX, FONT_DEFAULT, FONT_MAX, FONT_MIN };

/** The two stack values the panel has written, and the one fact a stylesheet cannot
 * state: whether this engine drew the family the mono field names. */
export interface AppliedFonts {
  ui: string;
  mono: string;
  /** False when the named code font is not what the engine draws with, which is the
   * panel overriding a choice rather than applying it. */
  monoHonoured: boolean;
}

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
  const fonts = currentFonts();
  document.documentElement.style.setProperty("--font-ui", fonts.ui);
  document.documentElement.style.setProperty("--font-mono", fonts.mono);
}

/** The measured answer is kept against the name it was measured for. Asking the
 * engine costs a dozen laid-out glyphs, and a zoom click repaints the appearance as
 * a whole, so measuring per paint would turn a font question into per-keystroke
 * work. */
let measured: { named: string; stack: string; honoured: boolean } | null = null;

function monoFor(named: string): { stack: string; honoured: boolean } {
  if (measured === null || measured.named !== named) measured = { named, ...resolveMonoStack(named) };
  return measured;
}

export function currentFonts(): AppliedFonts {
  const prefs = preferences().prefs;
  // The pairing of stack to custom property is stated once, in `fontStack.ts`, with
  // this module's measured answer handed to it as the resolver — so the value the
  // panel writes and the value a view reports cannot come from different places.
  const properties = fontStackProperties(prefs, (named) => monoFor(named).stack);
  return {
    ui: properties["--font-ui"],
    mono: properties["--font-mono"],
    monoHonoured: monoFor(prefs.monoFont).honoured,
  };
}

function change(patch: Partial<Record<keyof Preferences, unknown>>): void {
  const before = currentFonts();
  record = updatePreferences(panelStorage(), preferences(), patch);
  paint();
  const after = currentFonts();
  // The zoom moves a metric every list measures. A stack does too: an object ID
  // column, a path and an ellipsis are all sized in glyph advances, so a list that
  // keeps its old measurement after a family change scrolls to the wrong row.
  if (
    patch.fontPx !== undefined ||
    after.ui !== before.ui ||
    after.mono !== before.mono ||
    after.monoHonoured !== before.monoHonoured
  ) {
    notifyLayoutChange();
  }
}

export function currentFontPx(): number {
  return preferences().prefs.fontPx;
}

export function currentTheme(): Theme {
  return preferences().prefs.theme;
}

/** The three family names as the record holds them — the names to show in the
 * boxes, as opposed to `currentFonts`, which is what the panel draws with. */
export function currentFamilies(): { latinFont: string; cjkFont: string; monoFont: string } {
  const prefs = preferences().prefs;
  return { latinFont: prefs.latinFont, cjkFont: prefs.cjkFont, monoFont: prefs.monoFont };
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

/** Store the three families and apply them.
 *
 * The names the record took come back, because a family it will not have is written
 * back to its box rather than left there: a row reading a name the panel is not
 * drawing with is a row that has started lying. `monoHonoured` is a different
 * refusal — the name is stored and drawn with some other face by the engine, so the
 * record is right and the *alignment* is what needs saying. `persisted` is the
 * third and least visible answer: the choice is drawn for this session whether or
 * not storage took it. */
export function applyFamilies(patch: {
  latinFont?: string;
  cjkFont?: string;
  monoFont?: string;
}): {
  latinFont: string;
  cjkFont: string;
  monoFont: string;
  monoHonoured: boolean;
  persisted: boolean;
} {
  change(patch);
  const state = preferences();
  return {
    latinFont: state.prefs.latinFont,
    cjkFont: state.prefs.cjkFont,
    monoFont: state.prefs.monoFont,
    monoHonoured: currentFonts().monoHonoured,
    persisted: state.persisted,
  };
}

/** Restore the stored appearance, once, before the shell is built. */
export function startAppearance(): void {
  record = loadPreferences(panelStorage(), OWNED_ELSEWHERE);
  paint();
  notifyLayoutChange();
}
