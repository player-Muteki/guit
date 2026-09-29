// The versioned record of everything the user chose about how the panel looks
// and behaves: interface size, the three font families, theme, the theme CSS
// fragment, the text-refresh interval and the Main panel's split share.
//
// Pure: no DOM, no Git, no stylesheet, no storage. The caller reads and writes
// the stored string; everything that decides whether a stored record is *usable*
// is here, so a Node run can check it without a window to draw in.
//
// Two rules shape the whole module. A value that is out of range is corrected
// rather than trusted — a number written by an older build, or edited by hand,
// must not put the panel into a state it cannot draw. And a record this build
// cannot understand is never rewritten: refusing to read it and then writing
// defaults over it would destroy the newer choice, which is the one failure the
// persistence layer is not allowed to have.

// Type-only, because a value import between two modules Node loads directly cannot
// be written in a form both Node and tsc accept; the mapping below needs the shape,
// not the module.
import type { ThemeRecord } from "./themeLifecycle";

export const PREFERENCES_SCHEMA_VERSION = 1;

// Interface size bounds. The stylesheet's rem everything else is derived from
// is the same number, so these bounds are the whole product's zoom range.
export const FONT_MIN = 12;
export const FONT_MAX = 24;
export const FONT_DEFAULT = 16;

// Text-refresh interval. It only decides how often the relative-time sentence
// is recomputed; it is never a Git polling rate, so the upper bound is about
// readable text, not about load.
export const INTERVAL_MIN = 1;
export const INTERVAL_MAX = 60;
export const INTERVAL_DEFAULT = 5;

// A font family name is handed straight into a CSS font stack, so it is checked
// by shape rather than by length alone: letters and digits (in any script),
// spaces, and the few punctuation marks real family names contain. That rejects
// the quotes, commas, semicolons, braces, parentheses and backslashes that would
// let one value start a new declaration or reach the network. It is not a claim
// to parse CSS — the fragment field goes through a real parser elsewhere.
const FAMILY_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u;
export const FAMILY_MAX = 64;

// An empty family means "use the built-in stack", which is a distinct choice
// from a name, so it is legal and never corrected into something else.
export const FAMILY_DEFAULT = "";

// The theme fragment is pasted text. It is stored as written and parsed before
// it is applied, so the cap here is only "is this absurd"; a fragment over it is
// refused whole, because half a stylesheet is neither valid nor recoverable.
export const CSS_MAX = 131072;

export const THEME_VALUES = ["system", "light", "dark"] as const;
export type Theme = (typeof THEME_VALUES)[number];
export const THEME_DEFAULT: Theme = "system";

// The split share bounds are stated here rather than imported from the module
// that measures the panel: a value import between two modules that Node loads
// directly cannot be written in a form both tsc and Node accept (tsc rejects a
// ".ts" specifier, Node requires one), and every cross-module import in this
// layer is a type-only one for exactly that reason. The numbers are therefore
// duplicated and gated, which is how the row-height constants already work —
// one statement per side and a test that refuses to let them drift.
export const SPLIT_MIN = 15;
export const SPLIT_MAX = 85;
export const SPLIT_DEFAULT = 45;

export interface Preferences {
  fontPx: number;
  latinFont: string;
  cjkFont: string;
  monoFont: string;
  theme: Theme;
  css: string;
  /** Whether the fragment in `css` may be drawn. A failed or unconfirmed theme
   * leaves this false, which is what stops a bad fragment from coming back on the
   * next start by itself. */
  cssEnabled: boolean;
  /** Text that was drawn and never confirmed. Non-null at launch means the session
   * that drew it ended before it could report, which counts as a failure. */
  cssUnverified: string | null;
  intervalSeconds: number;
  split: number;
}

export const DEFAULT_PREFERENCES: Preferences = {
  fontPx: FONT_DEFAULT,
  latinFont: FAMILY_DEFAULT,
  cjkFont: FAMILY_DEFAULT,
  monoFont: FAMILY_DEFAULT,
  theme: THEME_DEFAULT,
  css: "",
  cssEnabled: true,
  cssUnverified: null,
  intervalSeconds: INTERVAL_DEFAULT,
  split: SPLIT_DEFAULT,
};

export type SealReason = "unreadable" | "malformed" | "future";

export interface ParsedPreferences {
  prefs: Preferences;
  /** Fields that were present but not usable, so the view can say which choice
   * fell back instead of silently showing a different one. */
  corrected: (keyof Preferences)[];
  /** Set when the stored text must be left exactly as it is. The caller writes
   * only when this is absent. */
  sealed: SealReason | null;
  /** True when the record is worth writing back: a migration or a bump that this
   * build performed, not merely "the user has preferences". */
  needsWrite: boolean;
  /** Keys this build does not know about, kept verbatim so a later build of the
   * same generation still finds them. */
  extras: Record<string, unknown>;
}

export function defaultPreferences(): Preferences {
  return { ...DEFAULT_PREFERENCES };
}

export function clampFontPx(value: number): number {
  return Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(value)));
}

export function clampInterval(value: number): number {
  return Math.min(INTERVAL_MAX, Math.max(INTERVAL_MIN, Math.round(value)));
}

// Named apart from the panel's own clamp on purpose: this one decides what a
// stored number is allowed to mean, that one decides what a drag is allowed to
// do. Both are gated to the same bounds.
export function clampStoredSplit(value: number): number {
  if (!Number.isFinite(value)) return SPLIT_DEFAULT;
  return Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, value));
}

export function isFontFamily(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (value === FAMILY_DEFAULT) return true;
  return value.length <= FAMILY_MAX && FAMILY_PATTERN.test(value.normalize("NFC"));
}

function numberField(raw: unknown, fallback: number, clamp: (value: number) => number): { value: number; ok: boolean } {
  // An absent field is not a wrong field: it is a choice the user never made, and
  // reporting it would have the view say something fell back when nothing did.
  if (raw === undefined) return { value: fallback, ok: true };
  // 1e999 parses to Infinity and JSON carries no NaN, so finite-ness has to be
  // checked rather than assumed; a non-finite number would poison every
  // arithmetic that follows it.
  if (typeof raw !== "number" || !Number.isFinite(raw)) return { value: fallback, ok: false };
  const clamped = clamp(raw);
  return { value: clamped, ok: clamped === raw };
}

function familyField(raw: unknown, fallback: string): { value: string; ok: boolean } {
  // The fallback is the value the caller already has, not the built-in stack: a
  // control that sends something unusable must not quietly undo the family the
  // user is currently looking at.
  if (raw === undefined) return { value: fallback, ok: true };
  if (typeof raw !== "string") return { value: fallback, ok: false };
  const trimmed = raw.trim();
  return isFontFamily(trimmed) ? { value: trimmed, ok: true } : { value: fallback, ok: false };
}

function themeField(raw: unknown, fallback: Theme): { value: Theme; ok: boolean } {
  if (raw === undefined) return { value: fallback, ok: true };
  // An unrecognised value is corrected and reported, never folded into the
  // default as if it had been chosen: "system" is itself a selection, so
  // silently mapping junk onto it hides the fact that something went wrong.
  if (typeof raw === "string" && (THEME_VALUES as readonly string[]).includes(raw)) {
    return { value: raw as Theme, ok: true };
  }
  return { value: fallback, ok: false };
}

function cssField(raw: unknown, fallback: string): { value: string; ok: boolean } {
  // A fragment over the cap is refused whole, so the previous fragment stays
  // applied rather than a truncated one being drawn.
  if (raw === undefined) return { value: fallback, ok: true };
  if (typeof raw !== "string") return { value: fallback, ok: false };
  if (raw.length > CSS_MAX) return { value: fallback, ok: false };
  return { value: raw, ok: true };
}

function cssFlagField(raw: unknown): { value: boolean; ok: boolean } {
  // Absent means a record from before a theme could fail, and a theme that had never
  // failed was enabled: defaulting to true is the only value that does not turn off a
  // working theme on upgrade. A *malformed* value is a different case and goes the
  // other way — a corrupt flag is not a licence to draw a fragment, so the field
  // reads as off and the person turns it back on.
  if (raw === undefined) return { value: true, ok: true };
  if (typeof raw === "boolean") return { value: raw, ok: true };
  return { value: false, ok: false };
}

function markerField(raw: unknown): { value: string | null; ok: boolean } {
  // The marker travels with a fragment it names, so the same absurd-length rule
  // applies to it. An unusable marker is dropped rather than corrected into some
  // other string: naming a fragment that was never drawn would disable a theme for
  // a reason nobody can see.
  if (raw === undefined || raw === null) return { value: null, ok: true };
  if (typeof raw !== "string" || raw === "" || raw.length > CSS_MAX) return { value: null, ok: false };
  return { value: raw, ok: true };
}

export function parsePreferences(raw: string | null): ParsedPreferences {
  if (raw === null || raw.trim() === "") {
    return {
      prefs: defaultPreferences(),
      corrected: [],
      sealed: null,
      needsWrite: false,
      extras: {},
    };
  }

  let loaded: unknown;
  try {
    loaded = JSON.parse(raw);
  } catch {
    return {
      prefs: defaultPreferences(),
      corrected: [],
      sealed: "unreadable",
      needsWrite: false,
      extras: {},
    };
  }

  if (typeof loaded !== "object" || loaded === null || Array.isArray(loaded)) {
    return {
      prefs: defaultPreferences(),
      corrected: [],
      sealed: "malformed",
      needsWrite: false,
      extras: {},
    };
  }

  const record = loaded as Record<string, unknown>;
  const version = record.schemaVersion;
  if (typeof version !== "number" || !Number.isInteger(version)) {
    // No usable version is not version 1: it is an unknown record, and unknown
    // records are left alone rather than reinterpreted.
    return {
      prefs: defaultPreferences(),
      corrected: [],
      sealed: "malformed",
      needsWrite: false,
      extras: {},
    };
  }
  if (version > PREFERENCES_SCHEMA_VERSION) {
    return {
      prefs: defaultPreferences(),
      corrected: [],
      sealed: "future",
      needsWrite: false,
      extras: {},
    };
  }

  const prefs = defaultPreferences();
  const corrected: (keyof Preferences)[] = [];

  const take = <K extends keyof Preferences>(key: K, field: { value: Preferences[K]; ok: boolean }) => {
    prefs[key] = field.value;
    if (!field.ok) corrected.push(key);
  };

  take("fontPx", numberField(record.fontPx, FONT_DEFAULT, clampFontPx));
  take("latinFont", familyField(record.latinFont, FAMILY_DEFAULT));
  take("cjkFont", familyField(record.cjkFont, FAMILY_DEFAULT));
  take("monoFont", familyField(record.monoFont, FAMILY_DEFAULT));
  take("theme", themeField(record.theme, THEME_DEFAULT));
  take("css", cssField(record.css, ""));
  take("cssEnabled", cssFlagField(record.cssEnabled));
  take("cssUnverified", markerField(record.cssUnverified));
  take("intervalSeconds", numberField(record.intervalSeconds, INTERVAL_DEFAULT, clampInterval));
  // A stored share outside the bounds would leave one region of Main with no
  // rows in it, so it is corrected rather than trusted.
  const split = numberField(record.split, SPLIT_DEFAULT, clampStoredSplit);
  take("split", split);

  const extras: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    if (key === "schemaVersion" || key in DEFAULT_PREFERENCES) continue;
    // Never carry a key back out that an object literal would treat as a
    // prototype hook instead of a property.
    if (key === "__proto__" || key === "prototype" || key === "constructor") continue;
    extras[key] = record[key];
  }

  return {
    prefs,
    corrected,
    sealed: null,
    // An older record becomes a current one, and that upgrade is the write the
    // caller owes: it is recorded once and the previous text is kept alongside it.
    needsWrite: version < PREFERENCES_SCHEMA_VERSION || corrected.length > 0,
    extras,
  };
}

export function serializePreferences(parsed: ParsedPreferences): string {
  return JSON.stringify({
    schemaVersion: PREFERENCES_SCHEMA_VERSION,
    ...parsed.prefs,
    ...parsed.extras,
  });
}

/** The theme fields, as the life cycle sees them.
 *
 * This mapping is the whole contract between the two: a field the life cycle gains
 * without a place here would be silently dropped on write, and the theme would come
 * back enabled (or unconfirmed) after the run that decided otherwise. A test builds
 * a record with a sentinel in every one of its fields and requires each to change the
 * preferences, so the lists cannot drift apart. */
export function themeRecordOf(prefs: Preferences): ThemeRecord {
  return { draft: prefs.css, enabled: prefs.cssEnabled, unverified: prefs.cssUnverified };
}

export function withThemeRecord(prefs: Preferences, record: ThemeRecord): Preferences {
  return {
    ...prefs,
    css: record.draft,
    cssEnabled: record.enabled,
    cssUnverified: record.unverified,
  };
}

/** Store what the theme life cycle decided, and answer the only question the caller
 * needs before it draws: did the intent arrive?
 *
 * A fragment applied while storage refused the marker is a fragment the next start
 * cannot tell good from dead — it will draw it again, or worse, believe nothing was
 * in flight. So `persisted: false` here means do not draw, whatever the screen looks
 * like without it. */
export function storeThemeRecord(
  storage: PreferenceStorage | null,
  state: PreferencesState,
  record: ThemeRecord,
): { state: PreferencesState; persisted: boolean } {
  const next = updatePreferences(storage, state, withThemeRecord(state.prefs, record));
  return { state: next, persisted: next.persisted };
}

/** The keys written before this record existed. Migration reads them, and only
 * marks itself finished once the new record is actually stored, so a failed
 * write leaves the old values in place for the next start instead of losing
 * them. */
export interface LegacyValues {
  fontPx: string | null;
  theme: string | null;
  split: string | null;
  interval: string | null;
}

export function migrateLegacy(legacy: LegacyValues): ParsedPreferences {
  const prefs = defaultPreferences();
  const corrected: (keyof Preferences)[] = [];

  const theme = themeField(legacy.theme, THEME_DEFAULT);
  prefs.theme = theme.value;
  if (legacy.theme !== null && !theme.ok) corrected.push("theme");

  const size = Number(legacy.fontPx);
  if (legacy.fontPx !== null && legacy.fontPx.trim() !== "" && Number.isFinite(size)) {
    prefs.fontPx = clampFontPx(size);
    if (size !== prefs.fontPx) corrected.push("fontPx");
  }

  const split = Number(legacy.split);
  if (legacy.split !== null && legacy.split.trim() !== "" && Number.isFinite(split)) {
    prefs.split = clampStoredSplit(split);
    if (split !== prefs.split) corrected.push("split");
  }

  const interval = Number(legacy.interval);
  if (legacy.interval !== null && legacy.interval.trim() !== "" && Number.isFinite(interval)) {
    prefs.intervalSeconds = clampInterval(interval);
    if (interval !== prefs.intervalSeconds) corrected.push("intervalSeconds");
  }

  return { prefs, corrected, sealed: null, needsWrite: true, extras: {} };
}
// ---------------------------------------------------------------------------
// The stored record itself.
//
// Everything above decides what a string means; this decides when one may be
// written. Both live in this module because two modules that Node loads directly
// cannot hand a value to each other in a form tsc and Node both accept, so
// splitting the write rules from the read rules would have put the interesting
// failures — a migration that reports itself finished after storage refused, a
// future record overwritten anyway — in the one file no gate can run.
//
// There is no DOM here. The caller passes something shaped like Storage, and
// `null` for a window whose storage is unavailable: that session still works, it
// just never persists.

export const PREFERENCES_KEY = "guit.preferences";

/** The keys written before a versioned record existed. A test reads the source
 * that writes each one, because migrating a name nobody uses any more reads as a
 * successful migration and silently drops the value. The same list is what a
 * caller names in `loadPreferences` when only some of its owners have moved onto
 * the record: see `PreferencesState.legacyOwned`. */
export const LEGACY_KEYS = {
  fontPx: "guit.fontPx",
  theme: "guit.theme",
  split: "guit.mainSplit",
  interval: "guit.activityInterval",
} as const;

export type LegacyName = keyof typeof LEGACY_KEYS;

const ALL_LEGACY_NAMES = Object.keys(LEGACY_KEYS) as LegacyName[];

/** Where each pre-versioned value lives once the record owns it. */
const LEGACY_FIELD: Record<LegacyName, keyof Preferences> = {
  fontPx: "fontPx",
  theme: "theme",
  split: "split",
  interval: "intervalSeconds",
};

export interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** The current values and what storage holds about them. `persisted` is not "no
 * error happened": false means something is owed to storage that storage did not
 * take, so a view can keep saying *not saved* instead of implying the choice
 * will be there next start. */
export interface PreferencesState {
  prefs: Preferences;
  corrected: (keyof Preferences)[];
  sealed: SealReason | null;
  persisted: boolean;
  /** True when this run merged pre-versioned keys, whatever the write did. */
  migrated: boolean;
  /** True while a record older than this build is still what storage holds. */
  upgraded: boolean;
  /** The pre-versioned keys whose owner has not moved onto this record yet.
   * While a name is listed, the value stored under it *is* that field's current
   * value — read over whatever the record says, written back into the record on
   * every save, and never deleted. Both halves matter: clearing a key some module
   * still writes leaves that module writing into a name nothing reads any more,
   * and the record keeps the single value the migration happened to catch.
   * `resetPreferences` is the one call that clears them anyway. */
  legacyOwned: LegacyName[];
  extras: Record<string, unknown>;
}

function readStored(storage: PreferenceStorage | null, key: string): string | null {
  if (storage === null) return null;
  // A storage that throws on read — a blocked frame, a WebView whose data
  // directory is gone — is absent storage, not corrupt storage. The distinction
  // matters: absent leaves the next start free to write, corrupt seals it.
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function readLegacy(storage: PreferenceStorage | null, names: LegacyName[] = ALL_LEGACY_NAMES): LegacyValues {
  const values: LegacyValues = { fontPx: null, theme: null, split: null, interval: null };
  for (const name of names) values[name] = readStored(storage, LEGACY_KEYS[name]);
  return values;
}

/** Read the keys whose owners have not moved yet over the record's own values.
 * Absent is not zero: a key that is gone leaves the record alone, because the
 * module that used to write it may simply have never been used this lifetime.
 *
 * `except` names the fields the caller is writing on purpose. The deferred key is
 * the authority while its owner still writes it, but a patch that names the field
 * itself is a newer decision than whatever is stored, and overwriting it would
 * make the record's own API unable to set one of its fields. */
function applyLegacyOwners(
  storage: PreferenceStorage | null,
  state: PreferencesState,
  except: readonly (keyof Preferences)[] = [],
): PreferencesState {
  const names = state.legacyOwned;
  if (storage === null || names.length === 0) return state;
  const values = readLegacy(storage, names);
  const legacy = migrateLegacy(values);
  const prefs = { ...state.prefs };
  const slots: Record<keyof Preferences, Preferences[keyof Preferences]> = prefs;
  const corrected = [...state.corrected];
  for (const name of names) {
    const raw = values[name];
    if (raw === null || raw.trim() === "") continue;
    const field = LEGACY_FIELD[name];
    if (except.includes(field)) continue;
    slots[field] = legacy.prefs[field];
    if (legacy.corrected.includes(field) && !corrected.includes(field)) corrected.push(field);
  }
  return { ...state, prefs, corrected };
}

function legacyPresent(storage: PreferenceStorage | null): boolean {
  return ALL_LEGACY_NAMES.some((name) => {
    const value = readStored(storage, LEGACY_KEYS[name]);
    return value !== null && value.trim() !== "";
  });
}

function clearLegacy(storage: PreferenceStorage | null, stillOwned: LegacyName[]): void {
  if (storage === null) return;
  for (const name of ALL_LEGACY_NAMES) {
    if (stillOwned.includes(name)) continue;
    try {
      storage.removeItem(LEGACY_KEYS[name]);
    } catch {
      // A leftover key loses to the record on the next read, so this is not a
      // reason to report the migration as unfinished.
    }
  }
}

/** Write these values and believe it only if storage hands the same text back.
 * A quota error can surface as a throw and a silently dropped `setItem` surfaces
 * as neither, so the read-back is what lets `persisted` mean something. */
function writeRecord(storage: PreferenceStorage | null, state: PreferencesState): boolean {
  if (storage === null || state.sealed !== null) return false;
  const data = serializePreferences({
    prefs: state.prefs,
    corrected: [],
    sealed: null,
    needsWrite: false,
    extras: state.extras,
  });
  try {
    storage.setItem(PREFERENCES_KEY, data);
    return storage.getItem(PREFERENCES_KEY) === data;
  } catch {
    return false;
  }
}

/** The one place a write is owed and reported. A migration's keys go away only
 * once the record that replaces them is back from storage, which is what makes
 * a refused write cost the user nothing but the persistence. */
function commit(storage: PreferenceStorage | null, state: PreferencesState, owesWrite: boolean): PreferencesState {
  const next = { ...state };
  if (next.sealed !== null) next.persisted = false;
  else if (!owesWrite) next.persisted = true;
  else {
    next.persisted = writeRecord(storage, next);
    if (next.persisted && next.upgraded) next.upgraded = false;
  }
  if (next.migrated && next.persisted) clearLegacy(storage, next.legacyOwned);
  return next;
}

export function loadPreferences(
  storage: PreferenceStorage | null,
  legacyOwned: LegacyName[] = [],
): PreferencesState {
  const stored = readStored(storage, PREFERENCES_KEY);
  const parsed = parsePreferences(stored);
  const base: PreferencesState = {
    prefs: parsed.prefs,
    corrected: parsed.corrected,
    sealed: parsed.sealed,
    persisted: false,
    migrated: false,
    upgraded: parsed.needsWrite,
    legacyOwned,
    extras: parsed.extras,
  };
  if (parsed.sealed !== null) {
    // The unreadable record says nothing about the choice the user last actually
    // made, and that choice may still be in the pre-versioned keys. It may drive
    // this session; nothing is written, because the sealed text has to survive
    // untouched and a half-migrated record would be worse than either.
    if (!legacyPresent(storage)) return base;
    const legacy = migrateLegacy(readLegacy(storage));
    return { ...base, prefs: legacy.prefs, corrected: legacy.corrected };
  }
  if (stored === null && legacyPresent(storage)) {
    const legacy = migrateLegacy(readLegacy(storage));
    return commit(storage, { ...base, prefs: legacy.prefs, corrected: legacy.corrected, migrated: true }, true);
  }
  // Nothing stored and nothing to migrate is a first run, and a first run writes
  // nothing: defaults are not a choice, and storing them turns every later change
  // of default into a value the user appears to have picked.
  return commit(storage, applyLegacyOwners(storage, base), parsed.needsWrite);
}

/** Apply a change, clamping every field exactly as a stored value is clamped, so
 * a control and a hand-edited record cannot mean different things. The in-memory
 * value changes even when the write is refused or fails: the user chose it, and
 * taking it back would be a second lie on top of the first.
 *
 * The patch values are `unknown` rather than the record's own field types because
 * that is what a control hands over — a `<select>` gives a string, a number input
 * gives text — and refusing anything the field would not accept from storage is
 * the same decision made in the one place it is tested.
 *
 * A field another module still owns is re-read from that module's key before the
 * write, since it may have moved since this session loaded it; the exception is a
 * patch that names that field itself, which is the newer decision. */
export function updatePreferences(
  storage: PreferenceStorage | null,
  state: PreferencesState,
  patch: Partial<Record<keyof Preferences, unknown>>,
): PreferencesState {
  const merged: Preferences = { ...state.prefs };
  // The record holds booleans and a nullable marker as well as strings and numbers,
  // so the one widened view of it is the union of its own field types rather than a
  // list of two of them: the loop writes through a key without eight copies of the
  // statement above it, and every value it can put in a slot is one the record
  // already declares.
  const slots: Record<keyof Preferences, Preferences[keyof Preferences]> = merged;
  const corrected = [...state.corrected];
  for (const key of Object.keys(patch) as (keyof Preferences)[]) {
    const field = normalizeField(key, patch[key], merged[key]);
    slots[key] = field.value;
    if (!field.ok && !corrected.includes(key)) corrected.push(key);
  }
  const next: PreferencesState = { ...state, prefs: merged, corrected, migrated: false, upgraded: false };
  // A field another module still owns is read from that module's key on the way
  // out, because it may have moved since this session loaded: the divider drag
  // writes its own value, and an unrelated save must not carry the older one the
  // record happened to hold. A patch that names the field is the one thing that
  // outranks the key, so it is left out of the read.
  return commit(storage, applyLegacyOwners(storage, next, Object.keys(patch) as (keyof Preferences)[]), true);
}

/** Reset the values, which is an ordinary write unless the record is sealed. */
export function resetPreferences(
  storage: PreferenceStorage | null,
  state: PreferencesState,
): PreferencesState {
  const fresh: PreferencesState = {
    prefs: defaultPreferences(),
    corrected: [],
    sealed: state.sealed,
    persisted: false,
    migrated: false,
    upgraded: false,
    legacyOwned: state.legacyOwned,
    extras: state.extras,
  };
  const next = commit(storage, fresh, true);
  // The one call that reaches a key it does not own. The person asked for every
  // default, including the values another module still keeps on its own terms, and
  // leaving those keys standing would put them back the moment the next start read
  // them. It happens only once the reset itself is stored.
  if (next.persisted) clearLegacy(storage, []);
  return next;
}

/** The way out of a sealed record: drop the text this build cannot read, then
 * load as if it had never been there. It is an explicit action rather than a
 * fallback inside `loadPreferences` because the text it destroys is the only
 * evidence of a choice some other build was allowed to make. */
export function discardRecord(
  storage: PreferenceStorage | null,
  legacyOwned: LegacyName[] = [],
): PreferencesState {
  if (storage !== null) {
    try {
      storage.removeItem(PREFERENCES_KEY);
    } catch {
      // The load below reports whether a record came back.
    }
  }
  return loadPreferences(storage, legacyOwned);
}

function normalizeField(
  key: keyof Preferences,
  raw: unknown,
  fallback: Preferences[keyof Preferences],
): { value: Preferences[keyof Preferences]; ok: boolean } {
  // Deliberately without a default branch: adding a field to the record makes this
  // switch non-exhaustive and the build stops until the field knows how to clamp
  // itself. A patch that quietly accepted anything for a new field would be the
  // first thing a hand-edited record got away with.
  switch (key) {
    case "fontPx":
      return numberField(raw, fallback as number, clampFontPx);
    case "intervalSeconds":
      return numberField(raw, fallback as number, clampInterval);
    case "split":
      return numberField(raw, fallback as number, clampStoredSplit);
    case "latinFont":
    case "cjkFont":
    case "monoFont":
      return familyField(raw, fallback as string);
    case "theme":
      return themeField(raw, fallback as Theme);
    case "css":
      return cssField(raw, fallback as string);
    case "cssEnabled":
      return cssFlagField(raw);
    case "cssUnverified":
      return markerField(raw);
  }
}
