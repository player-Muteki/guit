// Engine probe for the custom theme's life: what the panel's own renderer does with a
// pasted fragment, from the first draw to the way back out.
//
// The fixture suite decides the life cycle in Node, where the record is a `Storage`
// someone handed it and there is no screen at all. That is the right place to decide
// what may be drawn and the wrong place to assume three mechanisms this file can only
// measure: whether the text a review kept is text WebKitGTK paints, whether a button
// the shipped sheet styles really has a box a hiding check can notice, and whether a
// marker written before a draw survives the window it was meant for.
//
// The failure this probe manufactures on purpose is one the review is designed to make
// unreachable by a fragment: a control with no box. The panel cannot tell that from a
// theme that took the box away, and the promise worth measuring is what happens next —
// the previous look drawn back, the text kept for editing, the next start asked to stay
// off the fragment. That the review refuses the declarations that could cause it is a
// separate promise, held by the fixture tests.
//
// This file is run by webkit-engine-probe.py, which bundles it against the panel's own
// source, serves the panel's stylesheets beside it and prints what comes back. The page
// it builds is the Settings page, for real, because a module that applies a fragment and
// a row that reports it are two different pieces of the product. That page asks the host
// for its window as soon as it is imported, so `probe-tauri-stub.ts` answers. It is not
// panel code and nothing in the panel imports either file.

import "./probe-tauri-stub";
import { reloadAppearanceRecord } from "../../app/src/appearanceStore";
import { PREFERENCES_KEY } from "../../app/src/preferencesModel";
import { applyThemeFragment, disableTheme, startTheme, verifyThemeLaunch } from "../../app/src/theme";
import type { ThemeReport } from "../../app/src/theme";
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

/** The key the panel's own safe-start sentinel lives under. Duplicated rather than
 * imported because the name is a module-private constant in code that touches the
 * document; a gate in the fixture suite holds the key to the action it asks for. */
const SAFE_START_KEY = "guit.themeSafeStart";

/** A colour the review keeps and the row can take, and a second one that differs from
 * it in the only way the checks below care about. */
const FIRST = ".file-row { color: rgb(200, 30, 30) }";
const SECOND = ".file-row { color: rgb(30, 200, 30) }";
/** Text a person can paste that states nothing guit may draw. */
const NOISE = "};--;;{{";
/** A colour the review has no rule against and the renderer has no value for. */
const UNREADABLE = ".file-row { color: #zzz }";

const RED = "rgb(200, 30, 30)";
const GREEN = "rgb(30, 200, 30)";

function rowColor(): string {
  return getComputedStyle(row).color;
}

let row: HTMLDivElement;
let builtInColor = "";

function hostText(): string | null {
  const node = document.getElementById("guit-theme");
  return node === null ? null : String(node.textContent);
}

function record(): Record<string, unknown> | null {
  const raw = localStorage.getItem(PREFERENCES_KEY);
  return raw === null ? null : (JSON.parse(raw) as Record<string, unknown>);
}

/** The theme fields, read out of storage rather than out of the copy the module holds:
 * every promise below is a promise about what the next start will find. */
function storedTheme(): Record<string, unknown> {
  const all = record();
  if (all === null) return {};
  return { css: all.css, cssEnabled: all.cssEnabled, cssUnverified: all.cssUnverified };
}

/** A new window: the storages it would be handed, and the load it would do. */
function startFrom(theme: Record<string, unknown> | null): void {
  localStorage.clear();
  sessionStorage.clear();
  if (theme !== null) localStorage.setItem(PREFERENCES_KEY, JSON.stringify({ schemaVersion: 1, ...theme }));
  reloadAppearanceRecord();
}

/** A recovery control with no box, which is the state the reachability check exists to
 * notice. The `hidden` attribute is not used: the panel passes those over as its own
 * doing, so an inline `display: none` is the only way to ask the question. */
function addUnreachableRecovery(): HTMLElement {
  const node = document.createElement("button");
  node.type = "button";
  node.setAttribute("data-recovery", "probe");
  node.style.display = "none";
  document.body.append(node);
  return node;
}

/** Type into the box the way the page expects: `input` is what tells the page a person
 * is holding text of their own, and without it the next render puts the stored draft
 * back. A probe that only fires `change` is not typing; it is asking the page to show
 * what it already has. */
function typeInto(box: HTMLTextAreaElement, text: string): void {
  box.value = text;
  box.dispatchEvent(new Event("input"));
  box.dispatchEvent(new Event("change"));
}

function reportSummary(report: ThemeReport | null): Record<string, unknown> {
  if (report === null) return { report: null };
  return {
    notice: report.notice,
    applied: report.applied,
    rows: report.findings.rows,
    persisted: report.persisted,
  };
}

(globalThis as unknown as Record<string, unknown>).__probe = () => {
  row = document.createElement("div");
  row.className = "file-row";
  row.textContent = "an ordinary row";
  document.body.append(row);
  builtInColor = rowColor();

  // --- the first start, with nothing stored ---
  startFrom(null);
  const first = startTheme();
  check("a first start has nothing to say", first === null, reportSummary(first));
  check("and writes no stylesheet into the document", hostText() === null, {
    host: hostText(),
    styles: document.querySelectorAll("style").length,
  });

  // The page a person would use, mounted for real: the row that reports the theme, the
  // box that holds the text, and the button that is the way back out.
  const view = createSettingsView({
    onError: () => undefined,
    currentInterval: () => 5,
    applyInterval: (requested) => ({ ...chooseInterval(requested, 5), persisted: true }),
  });
  const page = view.descriptor.element;
  document.body.append(page);
  view.render();

  const out = page.querySelector<HTMLElement>('[data-recovery="theme"]');
  check(
    "the page carries the recovery control, and it has a box in the shipped sheet",
    out !== null && out.getClientRects().length > 0 && out.disabled === false,
    { found: out !== null, rects: out?.getClientRects().length, disabled: out?.disabled },
  );
  const stateRow = page.querySelector<HTMLElement>('[data-note="theme-state"]');
  check("the row says there is no custom theme", stateRow?.textContent === "No custom theme", stateRow?.textContent);

  const cssBox = page.querySelector<HTMLTextAreaElement>('textarea[aria-label="Custom theme CSS"]');
  const applyButton = Array.from(page.querySelectorAll<HTMLButtonElement>("button")).find(
    (one) => one.textContent === "Apply theme",
  );
  const disableButton = Array.from(page.querySelectorAll<HTMLButtonElement>("button")).find(
    (one) => one.textContent === "Use built-in look",
  );
  check(
    "the page carries the box and both buttons",
    cssBox !== undefined && applyButton !== undefined && disableButton !== undefined,
    {
      box: cssBox !== undefined,
      apply: applyButton?.textContent,
      disable: disableButton?.textContent,
    },
  );

  if (cssBox === undefined || applyButton === undefined || disableButton === undefined) {
    check("the rest of the probe needs the page", false, "no settings controls to drive");
    return JSON.stringify({ engine: navigator.userAgent, checks });
  }

  // --- a fragment asked for through the page ---
  // Reviewing is not applying: the row that shows the cut-down text must leave the
  // screen alone, which only a run with a real stylesheet can show.
  typeInto(cssBox, FIRST);
  view.render();
  const preview = page.querySelector<HTMLElement>(".theme-preview");
  const painted = rowColor();
  check(
    "the preview names the text that would be drawn, without drawing it",
    preview !== null && preview.hidden === false && preview.textContent.includes(".file-row") && painted === builtInColor,
    { preview: preview?.textContent, painted },
  );

  applyButton.click();
  view.render();
  check(
    "applying it paints the row with the colour the text asked for",
    rowColor() === RED,
    { color: rowColor(), host: hostText() },
  );
  check("the panel owns exactly one stylesheet element", document.querySelectorAll("#guit-theme").length === 1, {
    count: document.querySelectorAll("#guit-theme").length,
    text: hostText(),
  });
  check(
    "the row reports the theme as in use, and the record says the same",
    stateRow.textContent === "Saved and in use" &&
      storedTheme().css === FIRST &&
      storedTheme().cssEnabled === true &&
      storedTheme().cssUnverified === null,
    { state: stateRow.textContent, stored: storedTheme() },
  );
  check(
    "the way out still has a box, and the note says it worked",
    out.getClientRects().length > 0 && disableButton.disabled === false,
    { rects: out.getClientRects().length, disabled: disableButton.disabled },
  );
  const note = page.querySelector<HTMLElement>('[data-note="theme"]');
  check("and the page says why the screen changed", (note?.textContent ?? "").length > 0, note?.textContent);

  // --- text that states nothing guit may draw ---
  // Neither half of this is a guess: the sentence comes from the same review the apply
  // path runs, and keeping the working theme is the one promise a paste cannot break.
  typeInto(cssBox, NOISE);
  check(
    "text with nothing drawable in it is named before it is applied",
    (note?.textContent ?? "").includes("Nothing in this text is something guit may draw"),
    note?.textContent,
  );
  applyButton.click();
  view.render();
  check(
    "and applying it leaves the theme that works on the screen and in storage",
    rowColor() === RED && storedTheme().css === FIRST && storedTheme().cssEnabled === true,
    { color: rowColor(), stored: storedTheme() },
  );

  // --- a theme that takes the way out with it ---
  const unreachable = addUnreachableRecovery();
  const hidden = applyThemeFragment(SECOND);
  unreachable.remove();
  view.render();
  check(
    "the failure is reported as the loss of the way out",
    hidden.notice === "hidden-controls" && hidden.persisted === true,
    reportSummary(hidden),
  );
  check(
    "the look that was reachable is drawn back, not the built-in one",
    rowColor() === RED,
    { color: rowColor(), applied: hidden.applied, host: hostText() },
  );
  check(
    "the text is kept so it can be edited, and the theme is off",
    storedTheme().css === SECOND && storedTheme().cssEnabled === false && storedTheme().cssUnverified === null,
    storedTheme(),
  );
  check(
    "the next start of this window is asked to stay off the fragment",
    sessionStorage.getItem(SAFE_START_KEY) === "1",
    { sentinel: sessionStorage.getItem(SAFE_START_KEY) },
  );

  // --- the recovery key press: one start with no custom theme ---
  // The promise is a start that draws nothing and changes nothing. The fragment is still
  // the person's, and the start after it behaves as the record says.
  startFrom({ css: FIRST, cssEnabled: true });
  sessionStorage.setItem(SAFE_START_KEY, "1");
  const safe = startTheme();
  check(
    "a safe start says why the theme it was asked to skip is missing",
    safe !== null && safe.notice === "disabled",
    reportSummary(safe),
  );
  check("and the row is painted as though there were no theme", rowColor() === builtInColor, {
    color: rowColor(),
    host: hostText(),
  });
  check(
    "the sentinel is consumed, and the record is left exactly as it was",
    sessionStorage.getItem(SAFE_START_KEY) === null &&
      storedTheme().css === FIRST &&
      storedTheme().cssEnabled === true &&
      storedTheme().cssUnverified === null,
    { sentinel: sessionStorage.getItem(SAFE_START_KEY), stored: storedTheme() },
  );

  const redrawn = startTheme();
  check("the ordinary start after it draws the theme", redrawn === null && rowColor() === RED, {
    report: reportSummary(redrawn),
    color: rowColor(),
  });
  check(
    "the marker is in storage before the draw it vouches for",
    storedTheme().cssUnverified === FIRST,
    storedTheme(),
  );
  const confirmed = verifyThemeLaunch();
  check(
    "and a start that reached verification says nothing, because nothing was decided for the person",
    confirmed !== null && confirmed.notice === null && confirmed.persisted === true && storedTheme().cssUnverified === null,
    { report: reportSummary(confirmed), stored: storedTheme() },
  );

  // --- a launch whose theme takes the way out, found only once the shell is on screen ---
  startFrom({ css: FIRST, cssEnabled: true });
  const unreachableLaunch = addUnreachableRecovery();
  const launched = startTheme();
  check(
    "the draw at launch is quiet, because verification has not happened yet",
    launched === null && rowColor() === RED && storedTheme().cssUnverified === FIRST,
    { report: reportSummary(launched), color: rowColor(), stored: storedTheme() },
  );
  const lostWay = verifyThemeLaunch();
  unreachableLaunch.remove();
  view.render();
  check(
    "the start that looks at the screen takes the fragment back off",
    lostWay !== null && lostWay.notice === "hidden-controls" && rowColor() === builtInColor,
    { report: reportSummary(lostWay), color: rowColor() },
  );
  check(
    "the record says the fragment is off, and the next start is asked for safety",
    storedTheme().cssEnabled === false && sessionStorage.getItem(SAFE_START_KEY) === "1",
    { stored: storedTheme(), sentinel: sessionStorage.getItem(SAFE_START_KEY) },
  );

  // --- a fragment the renderer will not read ---
  // The review has no rule against this text; only the engine can say it has no value
  // for it. A rule that keeps nothing is an empty fragment, and an empty fragment must
  // not be applied as though it were a theme.
  startFrom({ css: UNREADABLE, cssEnabled: true });
  const refused = startTheme();
  check(
    "a colour this engine has no value for is refused at the start",
    refused !== null && refused.notice === "reverted" && refused.findings.rows.length > 0,
    reportSummary(refused),
  );
  check("nothing is drawn for it", rowColor() === builtInColor && (hostText() ?? "") === "", {
    color: rowColor(),
    host: hostText(),
  });
  check(
    "the text is kept, the theme is off, and no safe start is owed for a refusal",
    storedTheme().css === UNREADABLE &&
      storedTheme().cssEnabled === false &&
      sessionStorage.getItem(SAFE_START_KEY) === null,
    { stored: storedTheme(), sentinel: sessionStorage.getItem(SAFE_START_KEY) },
  );

  // --- a start that never reported back ---
  // The whole reason the marker is written before the draw: a window that died mid-launch
  // leaves evidence the next one can act on, and the evidence is cleared on the way.
  startFrom({ css: FIRST, cssEnabled: true });
  startTheme();
  const died = startTheme();
  check(
    "a fragment that never reported back is disabled, and told",
    died !== null && died.notice === "unconfirmed" && storedTheme().cssEnabled === false && storedTheme().cssUnverified === null,
    { report: reportSummary(died), stored: storedTheme() },
  );
  check("and the row is painted with no theme", rowColor() === builtInColor, { color: rowColor(), host: hostText() });

  // --- the person's own way back ---
  // Drawn again, then turned off by the control on the page — the action the key press
  // runs, with a label on it. It has to work without reading the fragment at all.
  startFrom({ css: FIRST, cssEnabled: true });
  startTheme();
  verifyThemeLaunch();
  check("the theme is on the screen before the button is used", rowColor() === RED, {
    color: rowColor(),
    host: hostText(),
  });
  disableButton.click();
  view.render();
  const stopped = disableTheme();
  check(
    "the built-in look comes back, and the record keeps the text with the theme off",
    rowColor() === builtInColor &&
      stopped.notice === "disabled" &&
      storedTheme().css === FIRST &&
      storedTheme().cssEnabled === false,
    { color: rowColor(), report: reportSummary(stopped), stored: storedTheme(), host: hostText() },
  );
  check(
    "the row reports it as saved and off, and the way out is never disabled",
    stateRow.textContent === "Saved, off" && disableButton.disabled === false,
    { state: stateRow.textContent, disabled: disableButton.disabled },
  );
  check(
    "a start after the button finds no theme to draw and says nothing",
    (() => {
      startFrom({ css: FIRST, cssEnabled: false });
      return startTheme() === null && rowColor() === builtInColor;
    })(),
    { color: rowColor(), stored: storedTheme() },
  );

  check(
    "the document still holds one stylesheet element, empty",
    document.querySelectorAll("#guit-theme").length === 1 && (hostText() ?? "") === "",
    { count: document.querySelectorAll("#guit-theme").length, text: hostText() },
  );

  page.remove();
  row.remove();
  return JSON.stringify({ engine: navigator.userAgent, checks });
};
