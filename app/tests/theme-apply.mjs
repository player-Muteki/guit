// The wiring of a custom theme into a live window.
//
// The decisions a fragment makes are tested where they are pure — `theme-lifecycle.mjs`
// for what may be drawn, `theme-css-model.mjs` for what a fragment may say,
// `theme-findings.mjs` for what is said back. What cannot be tested without a document
// is still testable as a claim about the sources, and these are the four that break
// silently: the escape route whose keys are named in one place and bound in another,
// the controls a theme is judged against that stop existing, the draw that runs before
// its marker is stored, and the review a person reads that is not the review the apply
// path runs. Each is a gate over text, because every one of them is a fact about where
// code sits rather than about what it computes.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { THEME_RECOVERY_KEYS } from "../src/themeFindings.ts";

const source = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");

// --- the recovery entry ---

test("the keys the panel names are the keys the window binds", () => {
  // A sentence that tells someone how to escape a theme is the only place those keys
  // are written down for them; the binding is in a different module and cannot say the
  // same thing twice. So the string is parsed and required to match the handler.
  const parts = THEME_RECOVERY_KEYS.split("+").map((part) => part.trim());
  assert.equal(parts[0], "Ctrl/Cmd", "the recovery entry is a window listener, so it needs a modifier");
  const letter = parts[parts.length - 1];
  assert.match(letter, /^[A-Z]$/, "the last part of the shortcut is a key");
  const main = source("main.ts");
  // One guard for every shortcut in the window: the modifier the string names, and no
  // Alt — a branch that accepted Alt would answer a different shortcut than the row
  // describes.
  assert.match(main, /if \(!\(event\.ctrlKey \|\| event\.metaKey\) \|\| event\.altKey\) return;/);
  const shift = parts.slice(1, -1).includes("Shift") ? " && event.shiftKey" : "";
  assert.ok(main.includes(`key === "${letter.toLowerCase()}"${shift}`), `main.ts must bind ${THEME_RECOVERY_KEYS}`);
});

test("the recovery key press runs the same action as the page's button", () => {
  // Two entries, one behaviour: the key press that works when the page is unusable and
  // the row that explains it must not be two different operations.
  const main = source("main.ts");
  const settings = source("views/settings.ts");
  assert.match(main, /key === "t"[\s\S]{0,400}disableTheme\(\)/);
  assert.match(settings, /"Use built-in look"[\s\S]{0,200}disableTheme\(\)/);
});

test("a theme start is drawn early and judged late, in that order", () => {
  // The draw has to precede the first paint or the person watches the built-in look
  // flash past their own; the judgement needs laid-out nodes, so it cannot. The failure
  // this gate is about is one of the two calls going missing in a refactor, which leaves
  // either a flash or a fragment nobody ever confirmed.
  const main = source("main.ts");
  const drawn = main.indexOf("startTheme()");
  const judged = main.indexOf("verifyThemeLaunch()");
  assert.ok(drawn >= 0 && judged >= 0, "main.ts must both start and verify the theme");
  assert.ok(drawn < judged, "the draw precedes the judgement");
  assert.ok(judged < main.indexOf("render();\n})"), "the judgement precedes the first draw of the rows that report it");
  for (const name of ["startTheme", "verifyThemeLaunch", "disableTheme"]) {
    assert.ok(main.includes(`settings.noteTheme(${name}())`), `${name} has no reader`);
  }
});

// --- the controls a theme is judged against ---

test("the controls a theme is asked about are the ones on the screen", () => {
  // `recoveryReachable` reads `[data-recovery]`. If no source marks a node, the check
  // asks nothing and passes every fragment, which is the one guarantee the draw path is
  // supposed to give. The tab strip is marked because it is on every screen, and the
  // Settings button because it is the way out the person can see.
  const marked = [["shell.ts", "tab"], ["views/settings.ts", "theme"]];
  for (const [file, value] of marked) {
    const text = source(file);
    assert.ok(
      text.includes(`"data-recovery": "${value}"`) || text.includes(`dataset.recovery = "${value}"`),
      `${file} must mark its recovery control`,
    );
  }
});

test("the control that turns a theme off is never taken away by the panel itself", () => {
  // The review refuses `display: none` for a reason, and the matching failure on this
  // side is code disabling the only labelled way out because it decided no theme is
  // drawn. That is the panel hiding the exit and then reporting the fragment for it.
  const settings = source("views/settings.ts");
  assert.doesNotMatch(settings, /disableThemeButton\.disabled\s*=/);
  assert.doesNotMatch(settings, /disableThemeButton[\s\S]{0,80}\bdisabled:/);
});

// --- the order of a draw and its marker ---

test("the fragment is stored before it is drawn", () => {
  // A fragment that takes the window down never reports back, so the next start's only
  // evidence is the marker written before the draw. Reversing the two gives a theme that
  // can break the panel twice and describe itself as having worked once.
  const theme = source("theme.ts");
  const body = theme.match(/function attempt\([\s\S]*?\n\}/);
  assert.ok(body, "theme.ts must run one apply flow for every entry point");
  const stored = body[0].indexOf("persistTheme(");
  const drawn = body[0].indexOf("apply(decision.effect.css)");
  assert.ok(stored >= 0 && drawn >= 0);
  assert.ok(stored < drawn, "storage first, screen second");
});

test("the panel owns exactly one stylesheet element", () => {
  // The theme is one element the panel created. A second one, or an id already used by
  // the page, makes "clear the theme" mean whatever the last writer left there.
  const theme = source("theme.ts");
  assert.equal([...theme.matchAll(/createElement\("style"\)/g)].length, 1);
  assert.match(theme, /created\.id = "guit-theme"/);
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.doesNotMatch(html, /guit-theme/, "index.html must not hold the panel's theme element");
});

// --- the review a person reads ---

test("the settings page reviews with the same call the apply path uses", () => {
  // `theme.ts` re-reviews on the way in, so a preview built by a second, similar
  // implementation would show one thing and hold another. The page is only allowed to
  // ask, never to judge.
  const settings = source("views/settings.ts");
  assert.match(settings, /previewThemeFragment\(/);
  assert.match(settings, /applyThemeFragment\(cssBox\.value\)/);
  assert.doesNotMatch(settings, /\b(reviewTheme|judgeDeclaration|isThemeSelector|writeThemeStyle)\b/);
});

test("no view writes a stylesheet", () => {
  // The draw is the module that then looks at the screen it produced. A view that wrote
  // styles itself would change what is on the screen without anybody checking that the
  // way out survived it.
  const offenders = ["views/settings.ts", "views/mainPanel.ts", "views/changes.ts", "shell.ts"].filter(
    (file) => /document\.head|createElement\("style"\)|writeThemeStyle|\.sheet\b/.test(source(file)),
  );
  assert.deepEqual(offenders, [], "only theme.ts may touch the panel's own stylesheet");
});
