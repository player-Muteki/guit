// The write half of the versioned preferences record: what reaches storage,
// what does not, and what the caller is allowed to claim about either.

import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_PREFERENCES,
  LEGACY_KEYS,
  PREFERENCES_KEY,
  PREFERENCES_SCHEMA_VERSION,
  discardRecord,
  loadPreferences,
  resetPreferences,
  storeThemeRecord,
  themeRecordOf,
  updatePreferences,
  withThemeRecord,
} from "../src/preferencesModel.ts";
import { beginApply, finishApply, launchTheme, stopTheme } from "../src/themeLifecycle.ts";

/** A Storage that can be told to misbehave in the two ways a real one does: it
 * throws, or it accepts the write and keeps nothing. */
function storageOf({ initial = {}, throwOn = null, swallow = false } = {}) {
  const map = new Map(Object.entries(initial));
  const attempts = { set: 0, remove: 0 };
  const guard = (kind) => {
    if (throwOn === kind) throw new Error(`storage ${kind}`);
  };
  return {
    attempts,
    keys: () => [...map.keys()].sort(),
    peek: (key) => (map.has(key) ? map.get(key) : null),
    getItem(key) {
      guard("read");
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      guard("write");
      attempts.set += 1;
      if (swallow) return;
      map.set(key, value);
    },
    removeItem(key) {
      guard("remove");
      attempts.remove += 1;
      map.delete(key);
    },
  };
}

const legacy = (values) => ({ ...values });

test("a first run decides nothing and stores nothing", () => {
  const store = storageOf();
  const state = loadPreferences(store);
  assert.equal(state.sealed, null);
  assert.equal(state.persisted, true, "nothing is owed to storage, so nothing is unsaved");
  assert.equal(store.attempts.set, 0);
  assert.deepEqual(store.keys(), [], "defaults are not a choice worth recording");
});

test("a change reaches storage and comes back on the next start", () => {
  const store = storageOf();
  const changed = updatePreferences(store, loadPreferences(store), { fontPx: 20, theme: "dark" });
  assert.equal(changed.persisted, true);
  assert.equal(changed.sealed, null);
  const reloaded = loadPreferences(store);
  assert.equal(reloaded.prefs.fontPx, 20);
  assert.equal(reloaded.prefs.theme, "dark");
  assert.deepEqual(reloaded.corrected, []);
});

test("the pre-versioned keys become one record, and only then disappear", () => {
  const store = storageOf({
    initial: legacy({
      [LEGACY_KEYS.fontPx]: "18",
      [LEGACY_KEYS.theme]: "light",
      [LEGACY_KEYS.split]: "62",
      [LEGACY_KEYS.interval]: "9",
    }),
  });
  const state = loadPreferences(store);
  assert.equal(state.migrated, true);
  assert.equal(state.persisted, true);
  assert.equal(state.prefs.fontPx, 18);
  assert.equal(state.prefs.theme, "light");
  assert.equal(state.prefs.split, 62);
  assert.equal(state.prefs.intervalSeconds, 9);
  assert.deepEqual(store.keys(), [PREFERENCES_KEY], "the record replaces the keys it read");
});

test("a migrated value out of range is corrected in the open", () => {
  const store = storageOf({ initial: legacy({ [LEGACY_KEYS.fontPx]: "400", [LEGACY_KEYS.interval]: "0" }) });
  const state = loadPreferences(store);
  assert.deepEqual(state.corrected, ["fontPx", "intervalSeconds"].sort());
  assert.equal(state.prefs.fontPx, 24);
  assert.equal(state.prefs.intervalSeconds, 1);
});

test("a write storage refuses leaves the old keys where they are", () => {
  const store = storageOf({ initial: legacy({ [LEGACY_KEYS.fontPx]: "18" }), throwOn: "write" });
  const state = loadPreferences(store);
  assert.equal(state.migrated, true);
  assert.equal(state.persisted, false, "this run is not saved, and says so");
  assert.equal(state.prefs.fontPx, 18, "the session still uses the value it read");
  assert.equal(store.peek(LEGACY_KEYS.fontPx), "18", "nothing may be dropped before the record exists");
});

test("a write storage swallows is reported as unsaved", () => {
  const store = storageOf({ swallow: true });
  const state = updatePreferences(store, loadPreferences(store), { theme: "dark" });
  assert.equal(state.prefs.theme, "dark");
  assert.equal(state.persisted, false, "an accepted call is not a stored value");
  assert.equal(store.peek(PREFERENCES_KEY), null);
});

test("storage that throws on read is absent storage, not a corrupt record", () => {
  const store = storageOf({ throwOn: "read" });
  const state = loadPreferences(store);
  assert.equal(state.sealed, null, "nothing was there to misunderstand");
  assert.equal(state.prefs.fontPx, 16);
  const later = updatePreferences(store, state, { fontPx: 22 });
  assert.equal(later.prefs.fontPx, 22, "the window still works for this session");
  assert.equal(later.persisted, false);
});

test("a record from a newer build survives every later call", () => {
  const future = JSON.stringify({ schemaVersion: 99, fontPx: 13, theme: "dark", somethingElse: true });
  const store = storageOf({ initial: { [PREFERENCES_KEY]: future } });
  const state = loadPreferences(store);
  assert.equal(state.sealed, "future");
  assert.equal(state.persisted, false);
  const changed = updatePreferences(store, state, { fontPx: 21 });
  assert.equal(changed.prefs.fontPx, 21, "the user still gets the session they asked for");
  assert.equal(changed.persisted, false);
  resetPreferences(store, changed);
  assert.equal(store.peek(PREFERENCES_KEY), future, "and the newer text is untouched, byte for byte");
  assert.equal(store.attempts.set, 0, "a sealed record is never even offered a write");
});

test("discarding the record is the only way past a seal, and it works", () => {
  const store = storageOf({ initial: { [PREFERENCES_KEY]: "not json at all" } });
  assert.equal(loadPreferences(store).sealed, "unreadable");
  const fresh = discardRecord(store);
  assert.equal(fresh.sealed, null);
  assert.equal(fresh.prefs.fontPx, 16);
  assert.equal(store.peek(PREFERENCES_KEY), null);
  const saved = updatePreferences(store, fresh, { theme: "light" });
  assert.equal(saved.persisted, true, "the way back is a working session, not a dead end");
});

test("a corrupt record does not hide the choice still in the old keys", () => {
  const store = storageOf({
    initial: { [PREFERENCES_KEY]: "[1,2,3]", [LEGACY_KEYS.theme]: "dark" },
  });
  const state = loadPreferences(store);
  assert.equal(state.sealed, "malformed");
  assert.equal(state.prefs.theme, "dark");
  assert.equal(store.peek(PREFERENCES_KEY), "[1,2,3]", "reading it must not rewrite it");
});

test("a record that names only some fields leaves the rest unchosen", () => {
  const store = storageOf({
    initial: { [PREFERENCES_KEY]: JSON.stringify({ schemaVersion: 1, fontPx: 14 }) },
  });
  const state = loadPreferences(store);
  assert.equal(state.prefs.fontPx, 14);
  assert.equal(state.prefs.theme, "system");
  assert.deepEqual(state.corrected, [], "an absent field is not a field that fell back");
  assert.equal(state.persisted, true);
  assert.equal(store.attempts.set, 0, "and a record this build agrees with is not rewritten");
});

test("a fragment over the cap does not replace the one in force", () => {
  const store = storageOf();
  let state = updatePreferences(store, loadPreferences(store), { css: ".badge { color: red }" });
  state = updatePreferences(store, state, { css: "x".repeat(200000) });
  assert.equal(state.prefs.css, ".badge { color: red }", "half a stylesheet is not an improvement");
  assert.ok(state.corrected.includes("css"));
  assert.equal(loadPreferences(store).prefs.css, ".badge { color: red }");
});

test("an out-of-range record is corrected, stored, and keeps its unknown keys", () => {
  const store = storageOf({
    initial: { [PREFERENCES_KEY]: JSON.stringify({ schemaVersion: 1, fontPx: 99, split: -5, mystery: "keep" }) },
  });
  const state = loadPreferences(store);
  assert.deepEqual(state.corrected, ["fontPx", "split"].sort());
  assert.equal(state.prefs.fontPx, 24);
  assert.equal(state.prefs.split, 15);
  assert.equal(state.persisted, true, "the correction was written, not just noticed");
  assert.equal(state.upgraded, false, "storage now holds this build's record, so nothing is owed");
  const raw = JSON.parse(store.peek(PREFERENCES_KEY));
  assert.equal(raw.mystery, "keep", "a key this build does not know is not a key to delete");
  assert.equal(raw.fontPx, 24, "the corrected value is what gets stored, not the impossible one");
});

test("a patch value out of range is clamped the same way a stored one is", () => {
  const store = storageOf();
  const base = loadPreferences(store);
  const state = updatePreferences(store, base, { fontPx: 500, intervalSeconds: 0.4, split: 120 });
  assert.equal(state.prefs.fontPx, 24);
  assert.equal(state.prefs.intervalSeconds, 1);
  assert.equal(state.prefs.split, 85);
  assert.deepEqual(state.corrected, ["fontPx", "intervalSeconds", "split"].sort());
  const reloaded = loadPreferences(store);
  assert.equal(reloaded.prefs.split, 85, "the clamp is what survives a restart");
  assert.deepEqual(reloaded.corrected, [], "a value this build chose is not a value that fell back");
});

test("an unusable patch field keeps the current value rather than the default", () => {
  const store = storageOf();
  let state = updatePreferences(store, loadPreferences(store), { theme: "dark" });
  state = updatePreferences(store, state, { theme: "neon" });
  assert.equal(state.prefs.theme, "dark", "a control that sends junk must not reset the choice");
  assert.deepEqual(state.corrected, ["theme"]);
  assert.equal(loadPreferences(store).prefs.theme, "dark");
});

test("a font family the sheet cannot carry is refused by the write, not only by the read", () => {
  const store = storageOf();
  const base = loadPreferences(store);
  const state = updatePreferences(store, base, { cjkFont: 'Unic Sans"; position: fixed' });
  assert.equal(state.prefs.cjkFont, "");
  assert.ok(state.corrected.includes("cjkFont"));
  assert.doesNotMatch(store.peek(PREFERENCES_KEY), /position/, "the refused value must not be stored either");
});

test("reset returns every field to its default and stores that", () => {
  const store = storageOf();
  let state = updatePreferences(store, loadPreferences(store), { fontPx: 20, theme: "dark", split: 70 });
  state = resetPreferences(store, state);
  assert.equal(state.prefs.fontPx, 16);
  assert.equal(state.prefs.theme, "system");
  assert.equal(state.prefs.split, 45);
  assert.equal(state.persisted, true);
  assert.deepEqual(state.corrected, [], "a default chosen on purpose is not a fallback");
});

test("a session with no storage at all still holds its choices", () => {
  let state = loadPreferences(null);
  assert.equal(state.sealed, null);
  assert.equal(state.prefs.fontPx, 16);
  state = updatePreferences(null, state, { fontPx: 19 });
  assert.equal(state.prefs.fontPx, 19);
  assert.equal(state.persisted, false, "and it never claims to have saved");
});

// The custom theme's three fields, through real storage. What these cases hold the
// caller to is the order, not just the values: a fragment whose intent never reached
// storage must never be drawn, because the marker is the only thing that tells the
// next start that this one did not report back.

const GOOD = ":root { --surface-app: #101014 }";
const HOSTILE = "* { display: none }";

/** The write the caller owes before drawing: store the decision, and only draw what
 * storage took. */
function applyToStorage(store, state, decision) {
  return storeThemeRecord(store, state, decision.record);
}

test("the crash marker is stored before the draw it describes", () => {
  const store = storageOf();
  const staged = applyToStorage(store, loadPreferences(store), beginApply(themeRecordOf(DEFAULT_PREFERENCES), HOSTILE));
  assert.equal(staged.persisted, true);
  assert.equal(
    launchTheme(themeRecordOf(loadPreferences(store).prefs), false).notice,
    "unconfirmed",
    "the window died after the draw; the next start has to say so",
  );
});

test("a draw storage will not carry for does not happen", () => {
  const store = storageOf({ throwOn: "write" });
  const state = loadPreferences(store);
  const staged = applyToStorage(store, state, beginApply(themeRecordOf(state.prefs), HOSTILE));
  assert.equal(staged.persisted, false, "a write that failed is not a save, and this is the draw guard");
  assert.equal(store.peek(PREFERENCES_KEY), null, "storage was never told about the fragment");
  assert.equal(staged.state.prefs.cssUnverified, HOSTILE, "the in-memory choice still stands, as for any field");
});

test("a record this build may not rewrite also blocks the draw", () => {
  const store = storageOf({
    initial: { [PREFERENCES_KEY]: JSON.stringify({ schemaVersion: PREFERENCES_SCHEMA_VERSION + 1, css: GOOD }) },
  });
  const state = loadPreferences(store);
  assert.notEqual(state.sealed, null);
  const staged = applyToStorage(store, state, beginApply(themeRecordOf(state.prefs), HOSTILE));
  assert.equal(staged.persisted, false);
  assert.ok(!store.peek(PREFERENCES_KEY).includes(HOSTILE), "the sealed text is still untouched");
});

test("a confirmed theme comes back through storage as the fragment it drew", () => {
  const store = storageOf();
  let state = loadPreferences(store);

  const applied = beginApply(themeRecordOf(state.prefs), GOOD);
  state = applyToStorage(store, state, applied).state;
  const confirmed = finishApply(applied.record, "verified", "");
  state = applyToStorage(store, state, confirmed).state;
  assert.equal(themeRecordOf(loadPreferences(store).prefs).unverified, null);

  const nextStart = launchTheme(themeRecordOf(loadPreferences(store).prefs), false);
  assert.equal(nextStart.notice, null);
  assert.equal(nextStart.effect.kind === "draw" ? nextStart.effect.css : null, GOOD);
});

test("a theme the person stopped is still stopped after a restart, with its text kept", () => {
  const store = storageOf();
  let state = applyToStorage(store, loadPreferences(store), beginApply(themeRecordOf(DEFAULT_PREFERENCES), GOOD)).state;
  state = applyToStorage(store, state, stopTheme(themeRecordOf(state.prefs))).state;
  const reloaded = loadPreferences(store);
  assert.equal(reloaded.prefs.css, GOOD, "off is not deleted");
  assert.equal(reloaded.prefs.cssEnabled, false);
  assert.deepEqual(launchTheme(themeRecordOf(reloaded.prefs), false).effect, { kind: "clear" });
});

test("resetting the preferences clears an in-flight marker as well as the theme", () => {
  const store = storageOf();
  const staged = applyToStorage(store, loadPreferences(store), beginApply(themeRecordOf(DEFAULT_PREFERENCES), HOSTILE));
  const fresh = resetPreferences(store, staged.state);
  assert.equal(fresh.prefs.cssUnverified, null);
  assert.equal(fresh.prefs.cssEnabled, true);
  assert.equal(launchTheme(themeRecordOf(fresh.prefs), false).notice, null);
});

test("every field of the life cycle's record has a place in the stored record", () => {
  const probes = { draft: "PROBE", enabled: false, unverified: "PROBE" };
  const base = themeRecordOf(DEFAULT_PREFERENCES);
  assert.deepEqual(Object.keys(base).sort(), Object.keys(probes).sort());
  for (const field of Object.keys(probes)) {
    const mapped = withThemeRecord(DEFAULT_PREFERENCES, { ...base, [field]: probes[field] });
    assert.notDeepEqual(mapped, DEFAULT_PREFERENCES, `${field} has no field to be written to`);
    assert.equal(themeRecordOf(mapped)[field], probes[field], `${field} does not survive the round trip`);
  }
});
