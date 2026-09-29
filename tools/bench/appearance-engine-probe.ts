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
// The last section builds the Settings page itself, because a module that applies a
// family and a row that reports it are two different pieces of the product; that page
// asks the host for its window as soon as it is imported, so `probe-tauri-stub.ts`
// answers. It is not panel code and nothing in the panel imports either file.

import "./probe-tauri-stub";
import { applyFamilies, applyFontPx, applyTheme, currentFamilies, currentFontPx, currentFonts, currentTheme, startAppearance } from "../../app/src/font";
import { GENERIC_MONO, monoAligns } from "../../app/src/fontResolve";
import { LEGACY_KEYS, PREFERENCES_KEY, loadPreferences } from "../../app/src/preferencesModel";
import type { Preferences } from "../../app/src/preferencesModel";
import { chooseInterval } from "../../app/src/activityModel";
import { createSettingsView } from "../../app/src/views/settings";

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

/** How far the advance of one hex character drifts from another inside a real row of
 * the shipped sheet. The row is `font-family: var(--font-mono)`, so this measures the
 * property the panel wrote rather than the stack it was built from — which is the
 * difference between a builder that is right and a column that lines up. */
function oidSpreadIn(className: string): { spread: number; narrow: string; wide: string } {
  const probe = document.createElement("span");
  probe.className = className;
  document.body.appendChild(probe);
  const widths = [..."0123456789abcdef"].map((one) => {
    probe.textContent = one.repeat(40);
    return probe.getBoundingClientRect().width / 40;
  });
  probe.remove();
  let least = 0;
  let most = 0;
  for (const [index, width] of widths.entries()) {
    if (width < widths[least]) least = index;
    if (width > widths[most]) most = index;
  }
  return {
    spread: Math.round((widths[most] - widths[least]) * 100) / 100,
    narrow: `${"0123456789abcdef"[least]}:${Math.round(widths[least] * 100) / 100}`,
    wide: `${"0123456789abcdef"[most]}:${Math.round(widths[most] * 100) / 100}`,
  };
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

  // --- the three families ---
  // The record can name families and the panel can write them; none of that is the
  // point. The point is that a history row drawn from what the record says still
  // lines an object ID up, on the engine, through the shipped sheet. So this starts
  // from a stored record naming a family no host has.
  startAfter({
    [PREFERENCES_KEY]: JSON.stringify({
      schemaVersion: 1,
      latinFont: "Noto Sans",
      cjkFont: "Source Han Sans",
      monoFont: "Not A Real Family 9x9",
    }),
  });
  check(
    "the stored text families are what the document is written with",
    token("--font-ui").startsWith('"Noto Sans", "Source Han Sans", ') && token("--font-ui") === currentFonts().ui,
    token("--font-ui"),
  );
  check(
    "the written code stack lines an object ID up in a real history row",
    monoAligns(token("--font-mono")) && token("--font-mono") === currentFonts().mono && oidSpreadIn("commit-short").spread < 0.05,
    { written: token("--font-mono"), row: oidSpreadIn("commit-short") },
  );
  // A statement about this engine rather than about the record, in the same company
  // as the two checks the font probe labels the same way: a host that skips a name it
  // lacks would honour it, and the alignment check above is the one that still has to
  // hold.
  check(
    "and a code font this host lacks is substituted, so the panel says it overrode it",
    token("--font-mono") === GENERIC_MONO && currentFonts().monoHonoured === false,
    { written: token("--font-mono"), honoured: currentFonts().monoHonoured },
  );

  // The boxes: a name the record will not take leaves the family being looked at
  // where it was rather than falling to the default, and a name it does take is
  // stored and written in the same step.
  const refused = applyFamilies({ latinFont: '"; color: red', monoFont: "Liberation Mono" });
  check(
    "a refused family stays at the one in force, not at the default",
    refused.latinFont === "Noto Sans" && currentFamilies().latinFont === "Noto Sans",
    refused,
  );
  check("and the code name that was taken is stored", record()?.monoFont === "Liberation Mono", record());
  check(
    "the document is written from the same answer the panel reports",
    token("--font-mono") === currentFonts().mono && monoAligns(token("--font-mono")),
    { written: token("--font-mono"), honoured: currentFonts().monoHonoured },
  );

  // Clearing every box is a choice with a visible result: the built-in stacks come
  // back, which is what makes a stored name and an empty field two different things.
  applyFamilies({ latinFont: "", cjkFont: "", monoFont: "" });
  check(
    "clearing the families writes the built-in stacks",
    currentFamilies().latinFont === "" && token("--font-ui").endsWith("sans-serif") && record()?.latinFont === "",
    { ui: token("--font-ui"), record: record() },
  );

  // A first run is the case that must write nothing: defaults are not a choice.
  startAfter();
  check("a first run leaves storage empty", Object.keys(stored()).length === 0, stored());
  check("and the document is at the default size", rootFontSize() === "16px", rootFontSize());

  // --- the page the choice is made on ---
  // The Settings view is built for real, because the boxes, the sample lines under
  // them and the sentence that explains a refusal are what a person actually uses. A
  // module that applies a family correctly and a row that reports a different one are
  // two different bugs, and only this run can tell them apart. The Tauri host is
  // stubbed: the view asks the window for its label the moment it is imported.
  startAfter({
    [PREFERENCES_KEY]: JSON.stringify({
      schemaVersion: 1,
      latinFont: "Noto Sans",
      cjkFont: "Source Han Sans",
      monoFont: "Not A Real Family 9x9",
    }),
  });
  const view = createSettingsView({
    onError: () => undefined,
    currentInterval: () => 5,
    applyInterval: (requested) => ({ ...chooseInterval(requested, 5), persisted: true }),
  });
  const page = view.descriptor.element;
  document.body.append(page);
  view.render();
  const boxes = Array.from(page.querySelectorAll<HTMLInputElement>('input[type="text"]'));
  const named = (label: string): HTMLInputElement | undefined =>
    boxes.find((one) => one.getAttribute("aria-label") === label);
  check(
    "the page carries the three family boxes, named and filled from the record",
    boxes.length === 3 &&
      named("Latin text font")?.value === "Noto Sans" &&
      named("Chinese text font")?.value === "Source Han Sans" &&
      named("Code font")?.value === "Not A Real Family 9x9",
    { labels: boxes.map((one) => one.getAttribute("aria-label")), values: boxes.map((one) => one.value) },
  );
  const samples = Array.from(page.querySelectorAll<HTMLElement>(".font-preview"));
  check("and two sample lines, the second one in the code stack", samples.length === 2, samples.length);
  check(
    "the code sample on the page is one width per character",
    samples.length === 2 && oidSpreadIn("font-preview code").spread < 0.05,
    oidSpreadIn("font-preview code"),
  );

  // Typing a name that is not a name: the box goes back to the family in force and
  // the row says so, and neither the record nor the document moves.
  const codeBox = named("Code font");
  if (codeBox !== undefined) {
    codeBox.value = 'Arial; color: red';
    codeBox.dispatchEvent(new Event("change"));
    const note = page.querySelector<HTMLElement>('[data-note="fonts"]');
    check(
      "a name that is not a name goes back to the family in force",
      codeBox.value === "Not A Real Family 9x9" && record()?.monoFont === "Not A Real Family 9x9",
      { box: codeBox.value, record: record() },
    );
    check(
      "and the row says what happened",
      note !== null && note.textContent.includes("is not a name guit can write"),
      note?.textContent,
    );
    check(
      "the document is still written with a stack that lines up",
      monoAligns(token("--font-mono")) && token("--font-mono") === currentFonts().mono,
      token("--font-mono"),
    );

    // A name the record takes is stored, applied and shown in the same step, and the
    // row that replaces it keeps the same alignment.
    codeBox.value = "Liberation Mono";
    codeBox.dispatchEvent(new Event("change"));
    check(
      "a family that is stored is the family the document is written with",
      codeBox.value === "Liberation Mono" && record()?.monoFont === "Liberation Mono" && token("--font-mono") === currentFonts().mono,
      { box: codeBox.value, written: token("--font-mono"), honoured: currentFonts().monoHonoured },
    );
    check(
      "and the object ID row drawn from it still lines up",
      oidSpreadIn("commit-short").spread < 0.05 && monoAligns(token("--font-mono")),
      { written: token("--font-mono"), row: oidSpreadIn("commit-short") },
    );
    check("the refusal sentence is cleared once the field is usable", note.textContent === "", note.textContent);
  } else {
    check("the page carries a code family box", false, 'no box labelled "Code font"');
  }

  page.remove();

  return JSON.stringify({ engine: navigator.userAgent, checks });
};
