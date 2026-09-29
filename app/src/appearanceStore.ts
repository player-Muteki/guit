// The one in-memory copy of the versioned appearance record, and the one place the
// panel touches the WebView's storage.
//
// `font.ts` paints the interface size, the scheme and the two font stacks; `theme.ts`
// paints a pasted fragment. Both owe their choice to the same stored record, and a
// write replaces the record *whole* — so two copies of it are two authorities, and the
// module that saved later would hand back the fields it happened to have read, undoing
// the other's change without being asked to. One module holds the copy, and both ask it
// to write.
//
// Nothing here decides what a stored value means. `preferencesModel.ts` does that, in
// pure code a Node run can test without a window; this file only reaches the storage a
// window may or may not hand out, and keeps what comes back.

import { loadPreferences, updatePreferences } from "./preferencesModel";
import type { LegacyName, PreferenceStorage, Preferences, PreferencesState, SealReason } from "./preferencesModel";
import type { ThemeRecord } from "./themeLifecycle";

/** The pre-versioned keys this layer does not own. The split drag and the age-line
 * interval still keep their own values, and naming them is what stops a migration from
 * deleting a key a live module is still writing. When one of those owners moves onto the
 * record it stops appearing here, and the name is deleted from `LEGACY_KEYS` in the same
 * change. */
const DEFERRED_OWNERS: LegacyName[] = ["split", "interval"];

/** The WebView's own storage, or `null` for a window that has none. Reading the
 * property is the step that throws in a frame blocked against its origin; the methods
 * throw in private mode. Either way the session still gets every choice, it just cannot
 * keep them. */
function panelStorage(): PreferenceStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

let record: PreferencesState | null = null;

/** Read once and keep. The load is lazy so that a view asking a question before the
 * window has painted gets a real answer rather than a default that was never looked
 * up. */
export function appearanceRecord(): PreferencesState {
  if (record === null) record = loadPreferences(panelStorage(), DEFERRED_OWNERS);
  return record;
}

/** Put the copy back to what storage holds — the start-of-run load. */
export function reloadAppearanceRecord(): PreferencesState {
  record = loadPreferences(panelStorage(), DEFERRED_OWNERS);
  return record;
}

/** Apply a change and return the state now in force.
 *
 * The `persisted` on the way out is the answer a caller owes its own report to: false
 * means storage was asked and did not take it, so the choice lives in this window and
 * will not be there next start.
 *
 * The patch values are what a control hands over — a `<select>` gives a string, a text
 * box gives text — and `updatePreferences` refuses anything its field would not accept
 * from storage, so a control cannot bypass the record's own bounds. */
export function patchAppearance(patch: Partial<Record<keyof Preferences, unknown>>): PreferencesState {
  record = updatePreferences(panelStorage(), appearanceRecord(), patch);
  return record;
}

/** Store what the theme life cycle decided.
 *
 * This is the only write that carries a question the screen has already acted on: a
 * fragment drawn while storage refused the `unverified` marker is a fragment the next
 * start cannot tell good from dead, so it will draw it again — or believe nothing was
 * in flight. `persisted: false` therefore means *do not draw*, whatever the screen
 * looks like without the fragment. */
export function persistTheme(theme: ThemeRecord): { persisted: boolean; sealed: SealReason | null } {
  // Only the three theme fields are named in the patch, although
  // `withThemeRecord` produces a whole record. The record is written back as it is
  // held, and a patch naming a field is the one thing that outranks a key this layer
  // deliberately leaves to its own owner — naming all of them would therefore write
  // this copy's possibly older split and interval values over the live ones.
  const next = patchAppearance({
    css: theme.draft,
    cssEnabled: theme.enabled,
    cssUnverified: theme.unverified,
  });
  return { persisted: next.persisted, sealed: next.sealed };
}
