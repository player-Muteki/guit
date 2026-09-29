import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  clampSplit as panelClampSplit,
  SPLIT_DEFAULT as panelSPLIT_DEFAULT,
  SPLIT_MAX as panelSPLIT_MAX,
  SPLIT_MIN as panelSPLIT_MIN,
} from "../src/splitModel.ts";
import {
  CSS_MAX,
  DEFAULT_PREFERENCES,
  FAMILY_MAX,
  FONT_DEFAULT,
  FONT_MAX,
  FONT_MIN,
  INTERVAL_DEFAULT,
  INTERVAL_MAX,
  INTERVAL_MIN,
  LEGACY_KEYS,
  PREFERENCES_SCHEMA_VERSION,
  SPLIT_DEFAULT,
  SPLIT_MAX,
  SPLIT_MIN,
  clampFontPx,
  clampInterval,
  clampStoredSplit,
  isFontFamily,
  migrateLegacy,
  parsePreferences,
  serializePreferences,
} from "../src/preferencesModel.ts";

const doc = (fields) => JSON.stringify({ schemaVersion: PREFERENCES_SCHEMA_VERSION, ...fields });

test("no stored record is a first run that writes nothing", () => {
  for (const raw of [null, "", "   "]) {
    const parsed = parsePreferences(raw);
    assert.deepEqual(parsed.prefs, DEFAULT_PREFERENCES);
    assert.equal(parsed.sealed, null);
    assert.equal(parsed.needsWrite, false, `absent record ${JSON.stringify(raw)} must not schedule a write`);
    assert.deepEqual(parsed.corrected, []);
  }
});

test("a record this build cannot understand is refused and left alone", () => {
  // Two different failures, because the answer to a user differs: text that is
  // not JSON at all, and JSON that is well-formed but is not a preferences
  // record. Both seal the write; only one of them is a torn file.
  for (const raw of ["{ not json", doc({ theme: "dark" }) + "trailing"]) {
    const parsed = parsePreferences(raw);
    assert.equal(parsed.sealed, "unreadable", `${raw.slice(0, 18)} is not JSON at all`);
    assert.equal(parsed.needsWrite, false, "a refused record must never be rewritten");
    assert.deepEqual(parsed.prefs, DEFAULT_PREFERENCES);
  }
  for (const raw of ["null", "[]", '"a string"', "7"]) {
    const parsed = parsePreferences(raw);
    assert.equal(parsed.sealed, "malformed", `${raw} parses but is not a record`);
    assert.equal(parsed.needsWrite, false);
  }
});

test("a record with no usable version is not treated as this build's version", () => {
  for (const raw of ['{"fontPx":20}', '{"schemaVersion":"1","fontPx":20}', '{"schemaVersion":1.5,"fontPx":20}']) {
    const parsed = parsePreferences(raw);
    assert.equal(parsed.sealed, "malformed", raw);
    assert.equal(parsed.needsWrite, false);
  }
});

test("a future record is refused rather than reinterpreted", () => {
  const future = '{"schemaVersion":2,"fontPx":20,"theme":"dark","newField":"keep me"}';
  const parsed = parsePreferences(future);
  assert.equal(parsed.sealed, "future");
  assert.deepEqual(parsed.prefs, DEFAULT_PREFERENCES, "the newer choices must not be guessed at");
  assert.equal(parsed.needsWrite, false, "the whole point: an older build does not overwrite it");
  assert.deepEqual(parsed.extras, {});
});

test("every numeric field is corrected to a drawable range and says so", () => {
  const wild = parsePreferences(
    doc({ fontPx: 200, intervalSeconds: 0, split: 100 })
  );
  assert.equal(wild.prefs.fontPx, FONT_MAX);
  assert.equal(wild.prefs.intervalSeconds, INTERVAL_MIN);
  assert.equal(wild.prefs.split, SPLIT_MAX);
  assert.deepEqual(wild.corrected.sort(), ["fontPx", "intervalSeconds", "split"]);
  assert.equal(wild.sealed, null, "a bad number is one field, not a lost record");

  // 1e999 is Infinity through JSON.parse and there is no NaN in JSON, so an
  // unbounded number can arrive from a hand-edited value.
  const poisoned = parsePreferences(doc({ fontPx: 1e999, intervalSeconds: -1e999 }));
  assert.equal(poisoned.prefs.fontPx, FONT_DEFAULT);
  assert.equal(poisoned.prefs.intervalSeconds, INTERVAL_DEFAULT);
  assert.ok(Number.isFinite(poisoned.prefs.fontPx));
});

test("a field that is simply absent is not reported as broken", () => {
  const partial = parsePreferences(doc({ theme: "dark" }));
  assert.deepEqual(partial.corrected, [], "the user never chose the others; nothing fell back");
  assert.equal(partial.prefs.fontPx, FONT_DEFAULT);
  assert.equal(partial.prefs.theme, "dark");
});

test("an unrecognised theme is corrected, never folded into the default choice", () => {
  for (const raw of [doc({ theme: "blue" }), doc({ theme: null }), doc({ theme: "" }), doc({ theme: "SYSTEM" })]) {
    const parsed = parsePreferences(raw);
    assert.equal(parsed.prefs.theme, "system");
    assert.deepEqual(parsed.corrected, ["theme"], `${raw}: a wrong value has to be visible, not quiet`);
  }
});

test("a font family reaches CSS by shape only", () => {
  for (const good of ["Inter", "Noto Sans CJK SC", "SimSun", "JetBrains Mono 2", "等宽黑体", "IBM_Plex", "Roboto-Flex", "Segoe UI Semibold"]) {
    assert.ok(isFontFamily(good), good);
  }
  for (const bad of [
    '"; background: url(http://example.invalid/',
    "Arial, sans-serif",
    "A{color:red}",
    "url(x)",
    "back\\slash",
    "quote\"name",
    "new\nline",
    "tab\tname",
    "-leading hyphen",
    " ".repeat(FAMILY_MAX + 1),
    "x".repeat(FAMILY_MAX + 1),
  ]) {
    assert.ok(!isFontFamily(bad), `rejected: ${JSON.stringify(bad.slice(0, 24))}`);
  }
  // An empty family is "use the built-in stack", a real choice rather than a gap.
  assert.ok(isFontFamily(""));
  const parsed = parsePreferences(doc({ latinFont: '"; color: red' }));
  assert.equal(parsed.prefs.latinFont, "");
  assert.deepEqual(parsed.corrected, ["latinFont"]);
});

test("an over-long theme fragment is refused whole, never cut", () => {
  const atLimit = parsePreferences(doc({ css: "a".repeat(CSS_MAX) }));
  assert.equal(atLimit.prefs.css.length, CSS_MAX);
  assert.deepEqual(atLimit.corrected, []);

  const over = parsePreferences(doc({ css: "a".repeat(CSS_MAX + 1) }));
  assert.equal(over.prefs.css, "", "half a stylesheet is neither valid nor recoverable");
  assert.deepEqual(over.corrected, ["css"]);
});

test("keys this build does not know are carried back out untouched", () => {
  const withExtras = '{"schemaVersion":1,"fontPx":18,"betaPinLayout":"v2","__proto__":"nope"}';
  const parsed = parsePreferences(withExtras);
  assert.equal(parsed.prefs.fontPx, 18);
  assert.deepEqual(parsed.extras, { betaPinLayout: "v2" }, "the prototype hook must not be handed back out");
  const written = serializePreferences(parsed);
  assert.match(written, /"betaPinLayout":"v2"/, "a newer field survives a round trip through an older build");
  assert.ok(!written.includes("__proto__"));
});

test("migration reads the pre-versioned keys and claims completion only after a write", () => {
  const migrated = migrateLegacy({ fontPx: "20", theme: "dark", split: "60", interval: "30" });
  assert.equal(migrated.prefs.fontPx, 20);
  assert.equal(migrated.prefs.theme, "dark");
  assert.equal(migrated.prefs.split, 60);
  assert.equal(migrated.prefs.intervalSeconds, 30);
  assert.equal(migrated.needsWrite, true, "a migration is not finished until the record is stored");

  const wild = migrateLegacy({ fontPx: "999", theme: "chartreuse", split: "nonsense", interval: null });
  assert.equal(wild.prefs.fontPx, FONT_MAX, "an old out-of-range value is clamped, not dropped");
  assert.equal(wild.prefs.theme, "system", "a value that was never legal stays unset");
  assert.equal(wild.prefs.split, 45);
  assert.equal(wild.prefs.intervalSeconds, INTERVAL_DEFAULT);
});

test("writing the record back and reading it again is stable", () => {
  const first = parsePreferences(doc({ fontPx: 18, latinFont: "Inter", css: ".appbar { color: red }", split: 70 }));
  const second = parsePreferences(serializePreferences(first));
  assert.equal(second.sealed, null);
  assert.deepEqual(second.prefs, first.prefs);
  assert.deepEqual(second.corrected, [], "a value this build accepted must not come back corrected");
  assert.equal(second.needsWrite, false, "a current record needs no rewrite");
  assert.equal(serializePreferences(second), serializePreferences(first));
});

test("the split bounds agree with the module that measures the panel", () => {
  // Two statements of the same bounds are unavoidable here: this module decides
  // what a stored number may mean, splitModel decides what a drag may do, and a
  // value import between two modules Node loads directly cannot be written so
  // that tsc and Node both accept it. So the agreement is checked, not assumed.
  assert.equal(panelSPLIT_MIN, SPLIT_MIN);
  assert.equal(panelSPLIT_MAX, SPLIT_MAX);
  assert.equal(panelSPLIT_DEFAULT, SPLIT_DEFAULT);
  for (const value of [-10, 0, 7.5, 14, 15, 50, 85, 86, 100, 1e999]) {
    assert.equal(clampStoredSplit(value), panelClampSplit(value), `clamp disagrees at ${value}`);
  }
});

test("the zoom bounds agree with the module that applies them", () => {
  // font.ts cannot be imported for that check — it writes to the document and
  // reads localStorage, both of which a Node run lacks. So it is read as text:
  // either it states the same numbers, or it takes them from this module.
  const source = readFileSync(new URL("../src/font.ts", import.meta.url), "utf8");
  if (/from\s+"\.\/preferencesModel(\.ts)?"/.test(source)) return;
  const numbers = [...source.matchAll(/FONT_(MIN|MAX|DEFAULT)\s*=\s*(\d+)/g)];
  assert.equal(numbers.length, 3, "font.ts must state each bound or import it");
  const found = Object.fromEntries(numbers.map(([, name, value]) => [name, Number(value)]));
  assert.deepEqual(found, { MIN: FONT_MIN, MAX: FONT_MAX, DEFAULT: FONT_DEFAULT });
});

test("the ranges are ranges, not coincidences", () => {
  assert.ok(FONT_MIN < FONT_DEFAULT && FONT_DEFAULT < FONT_MAX);
  assert.ok(INTERVAL_MIN < INTERVAL_DEFAULT && INTERVAL_DEFAULT < INTERVAL_MAX);
  assert.equal(clampFontPx(FONT_MIN - 1), FONT_MIN);
  assert.equal(clampFontPx(FONT_MAX + 1), FONT_MAX);
  assert.equal(clampInterval(INTERVAL_MAX + 1), INTERVAL_MAX);
  // Fractional input arrives from a slider or a hand edit; a half-second or a
  // half-pixel setting has to land on a value the display can actually use.
  assert.equal(clampFontPx(17.6), 18);
  assert.equal(clampInterval(5.4), 5);
});

test("the interval bounds agree with the model that owns the timer", () => {
  // The same number is read twice: once to schedule the display refresh, once to
  // migrate what an older build stored. Two independent statements of it drift,
  // and the drift is a setting that resets itself for nobody.
  const source = readFileSync(new URL("../src/activityModel.ts", import.meta.url), "utf8");
  if (/from\s+"\.\/preferencesModel(\.ts)?"/.test(source)) return;
  const numbers = [...source.matchAll(/INTERVAL_(MIN|MAX|DEFAULT)\s*=\s*(\d+)/g)];
  assert.equal(numbers.length, 3, "activityModel.ts must state each bound or import it");
  const found = Object.fromEntries(numbers.map(([, name, value]) => [name, Number(value)]));
  assert.deepEqual(found, { MIN: INTERVAL_MIN, MAX: INTERVAL_MAX, DEFAULT: INTERVAL_DEFAULT });
});

/** The pre-versioned keys and the source that still writes each one.
 *
 * When a writer moves onto the versioned record it stops writing its legacy name,
 * and that row is deleted from this list in the same change — the key stays a
 * migration source for stored values, but it is no longer a live name. The paired
 * gate below reads the record's own list of deferred keys, so a row deleted here
 * without moving the writer (or the other way round) fails. */
const writers = {
  split: "../src/views/mainPanel.ts",
  interval: "../src/views/changes.ts",
};

test("each legacy key is still the name some source writes", () => {
  // A migration that reads a name nobody writes any more reports a finished
  // migration and loses the setting, which is the one failure every other test
  // in this file would still pass through. So the names are read from the writers.
  for (const [field, url] of Object.entries(writers)) {
    const source = readFileSync(new URL(url, import.meta.url), "utf8");
    const key = LEGACY_KEYS[field];
    const literal = new RegExp(`"${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`);
    assert.match(source, literal, `${url} no longer writes "${key}"`);
  }
});

test("the keys the panel refuses to clear are exactly the live writers", () => {
  // `font.ts` hands `loadPreferences` the list of keys to leave alone and to read
  // over the record. Either half drifting is a lost setting: a name left on the
  // list after its owner moved keeps a stale key authoritative over the module
  // that stopped looking at it, and a name dropped while its owner still writes
  // deletes that key on the first migration, which is the failure the list exists
  // to prevent. So the two lists are required to be the same list.
  const source = readFileSync(new URL("../src/font.ts", import.meta.url), "utf8");
  const listed = source.match(/OWNED_ELSEWHERE[^=]*=\s*\[([\s\S]*?)\]/);
  assert.ok(listed, "font.ts must name the keys it does not own");
  const deferred = [...listed[1].matchAll(/"([a-zA-Z]+)"/g)].map(([, name]) => name).sort();
  assert.deepEqual(deferred, Object.keys(writers).sort());
});

// The theme's two safety fields. They decide whether a fragment that failed last
// run is drawn again this run, so a record that cannot say them has to be read in
// the one direction that cannot repeat a failure.

test("a record from before a theme could fail is read as enabled, with nothing owed", () => {
  const parsed = parsePreferences(doc({ css: ":root { --surface-app: #101014 }" }));
  assert.equal(parsed.prefs.cssEnabled, true);
  assert.equal(parsed.prefs.cssUnverified, null);
  assert.deepEqual(parsed.corrected, [], "an absent field is a choice never made, not a wrong one");
  assert.equal(parsed.needsWrite, false);
});

test("a malformed enable flag reads as off, not as the default", () => {
  for (const raw of ["true", 1, null, {}, []]) {
    const parsed = parsePreferences(doc({ css: ".rows { color: red }", cssEnabled: raw }));
    assert.equal(parsed.prefs.cssEnabled, false, `${JSON.stringify(raw)} must not licence a draw`);
    assert.deepEqual(parsed.corrected, ["cssEnabled"]);
  }
});

test("an unusable crash marker is dropped and said, never renamed to another fragment", () => {
  for (const raw of ["", 7, {}, "x".repeat(CSS_MAX + 1)]) {
    const parsed = parsePreferences(doc({ cssEnabled: false, cssUnverified: raw }));
    assert.equal(parsed.prefs.cssUnverified, null, `${JSON.stringify(raw)} is not a marker`);
    assert.deepEqual(parsed.corrected, ["cssUnverified"]);
  }
  const kept = parsePreferences(doc({ css: ".rows { color: red }", cssUnverified: ".rows { color: red }" }));
  assert.equal(kept.prefs.cssUnverified, ".rows { color: red }");
  assert.deepEqual(kept.corrected, []);
});
