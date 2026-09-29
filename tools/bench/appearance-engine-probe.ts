// Engine probe for the appearance record: what the panel actually stores, applies
// and restores, asked of the renderer it runs in.
//
// The fixture suite decides the record's rules against a `Storage` it builds
// itself. That is the right place to decide them and the wrong place to assume two
// mechanisms: whether WebKitGTK gives a page a localStorage at all over
// `http://127.0.0.1`, and whether a number written out of that record really moves
// the root font size that every `rem` in the stylesheet follows. A record that
// restores a value the document never renders is a setting that survived a restart
// in the test and not on the screen.
//
// This file is run by webkit-engine-probe.py, which bundles it against the panel's
// own source, serves the panel's stylesheets beside it and prints what comes back.
// It is not panel code and nothing in the panel imports it.

import { applyFontPx, applyTheme, currentFontPx, currentTheme, startAppearance } from "../../app/src/font";
import { LEGACY_KEYS, PREFERENCES_KEY, loadPreferences } from "../../app/src/preferencesModel";
import type { Preferences } from "../../app/src/preferencesModel";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const checks: Check[] = [];

function check(name: string, ok: boolean, detail: unknown): void {
  checks.push({ name, ok, detail: typeof detail === "string" ? detail : JSON.stringify(detail) });
}

/** The keys this probe's own panel would defer to, read the way `font.ts` reads
 * them. Duplicated rather than imported because the list lives in a module that
 * touches the document; a test in the fixture suite compares the two texts. */
const DEFERRED: (keyof typeof LEGACY_KEYS)[] = ["split", "interval"];

function stored(): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (key !== null) out[key] = String(localStorage.getItem(key));
  }
  return out;
}

function record(): Partial<Preferences> | null {
  const raw = localStorage.getItem(PREFERENCES_KEY);
  return raw === null ? null : (JSON.parse(raw) as Partial<Preferences>);
}

function rootFontSize(): string {
  return getComputedStyle(document.documentElement).fontSize;
}

function startAfter(values: Record<string, string> = {}): void {
  localStorage.clear();
  for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value);
  startAppearance();
}

(globalThis as unknown as Record<string, unknown>).__probe = () => {
  // A machine that has only ever used the pre-versioned keys: one the panel now
  // owns, one another module still writes.
  startAfter({
    [LEGACY_KEYS.fontPx]: "18",
    [LEGACY_KEYS.theme]: "dark",
    [LEGACY_KEYS.split]: "70",
  });
  check(
    "the zoom in the old key is the size the document draws at",
    rootFontSize() === "18px",
    { computed: rootFontSize(), keys: stored() },
  );
  check(
    "the theme in the old key is on the document",
    document.documentElement.getAttribute("data-theme") === "dark",
    document.documentElement.getAttribute("data-theme"),
  );
  check(
    "a key whose owner moved onto the record is gone",
    localStorage.getItem(LEGACY_KEYS.fontPx) === null && localStorage.getItem(LEGACY_KEYS.theme) === null,
    stored(),
  );
  check(
    "a key another module still writes survives the migration",
    localStorage.getItem(LEGACY_KEYS.split) === "70",
    stored(),
  );
  check(
    "the record itself states both migrated values",
    record()?.fontPx === 18 && record()?.theme === "dark",
    record(),
  );

  // The theme attribute is only worth storing if the real cascade reads it. A row
  // has no background of its own, so the token behind one is what switches.
  const token = (name: string): string => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const dark = token("--surface-app");
  applyTheme("light");
  const light = token("--surface-app");
  check("the stored theme switches the tokens a row is painted from", dark !== light, { dark, light });
  check("and the row shows the theme the record chose", currentTheme() === "light", currentTheme());
  applyTheme("dark");

  // A change made through the panel, read back the way the next start reads it.
  applyFontPx(21);
  applyTheme("system");
  check("the zoom row reads back what was applied", currentFontPx() === 21, currentFontPx());
  check("the applied zoom is on the document", rootFontSize() === "21px", rootFontSize());
  check(
    "system turns the attribute off so the desktop decides",
    document.documentElement.getAttribute("data-theme") === null,
    document.documentElement.getAttribute("data-theme"),
  );

  const restarted = loadPreferences(localStorage, DEFERRED);
  check(
    "a restart restores the zoom and the theme from one key",
    restarted.prefs.fontPx === 21 && restarted.prefs.theme === "system" && restarted.persisted,
    restarted.prefs,
  );
  check("and still reads the live split key over the record", restarted.prefs.split === 70, restarted.prefs.split);

  // The other owner writes its key while the panel is open. The next save has to
  // carry that value rather than the one this session happened to load first.
  localStorage.setItem(LEGACY_KEYS.split, "40");
  loadPreferences(localStorage, DEFERRED);
  applyTheme("dark");
  check("an unrelated save carries the value the live key holds", record()?.split === 40, record());

  // A stored value the panel cannot draw is corrected on the way in, and the
  // document ends up at the number the record says — not at either input.
  startAfter({ [LEGACY_KEYS.fontPx]: "400" });
  check("an impossible stored zoom lands on the bound", currentFontPx() === 24, currentFontPx());
  check("and the document is at that bound", rootFontSize() === "24px", rootFontSize());
  check("the record stores the bound, not the impossible number", record()?.fontPx === 24, record());

  // A first run is the case that must write nothing: defaults are not a choice.
  startAfter();
  check("a first run leaves storage empty", Object.keys(stored()).length === 0, stored());
  check("and the document is at the default size", rootFontSize() === "16px", rootFontSize());

  return JSON.stringify({ engine: navigator.userAgent, checks });
};
