// The theme fragment reviewer: what a pasted stylesheet may say, and what the
// user is told about the parts it may not.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PROTECTED_TOKENS, isThemeSelector, judgeDeclaration, reviewThemeCss } from "../src/themeCssModel.ts";

const style = (selector, ...declarations) => ({
  kind: "style",
  selector,
  declarations: declarations.map((pair) => ({ property: pair[0], value: pair[1] })),
});

const rule = (text) => style(".badge", ["color", text]);

const becauseOf = (review, item) => review.findings.filter((one) => one.item === item).map((one) => one.because);

test("a palette token and a component colour both survive, unchanged", () => {
  const review = reviewThemeCss([
    style(":root", ["--surface-app", "#101014"]),
    style(".file-row", ["color", "#e8e8ea"], ["background-color", "#1b1b20"]),
  ]);
  assert.deepEqual(review.findings, []);
  assert.equal(review.empty, false);
  assert.equal(review.allowed.length, 2);
  assert.deepEqual(
    review.allowed[1].declarations.map((one) => one.property),
    ["color", "background-color"],
  );
  assert.deepEqual(review.allowed[1].declarations[0], { property: "color", value: "#e8e8ea" });
});

test("a resource named anywhere in a value is refused as reaching out", () => {
  for (const value of [
    'url("https://example.com/tile.png")',
    "url(/etc/passwd)",
    'linear-gradient(red, url("x.png"))',
    "@import url(other.css)",
    "expression(alert(1))",
  ]) {
    const review = reviewThemeCss([rule(value)]);
    assert.equal(review.allowed.length, 0, `nothing of ${value} may be applied`);
    assert.deepEqual(becauseOf(review, `color: ${value}`), ["network"]);
  }
});

test("@import and a remote font face are refused by kind", () => {
  const review = reviewThemeCss([
    { kind: "import", selector: null, declarations: [] },
    { kind: "font-face", selector: null, declarations: [{ property: "src", value: "url(a.woff2)" }] },
    { kind: "keyframes", selector: "spin", declarations: [] },
  ]);
  assert.equal(review.allowed.length, 0);
  assert.deepEqual(review.findings.map((one) => one.item), ["@import", "@font-face", "@keyframes"]);
  assert.deepEqual(review.findings.map((one) => one.because), ["not-a-theme", "not-a-theme", "layout"]);
});

test("a media condition keeps the rules it holds and drops the ones it does not", () => {
  const review = reviewThemeCss([
    {
      kind: "media",
      selector: null,
      declarations: [],
      nested: [style(".badge", ["color", "red"]), style("button", ["display", "none"])],
    },
  ]);
  assert.equal(review.allowed.length, 1);
  assert.equal(review.allowed[0].nested.length, 1);
  assert.equal(review.allowed[0].nested[0].selector, ".badge");
  assert.deepEqual(review.findings.map((one) => one.because), ["hides-controls"]);
});

test("an empty grouping rule is not applied as a rule of its own", () => {
  const review = reviewThemeCss([
    { kind: "supports", selector: null, declarations: [], nested: [style(".badge", ["position", "fixed"])] },
  ]);
  assert.equal(review.allowed.length, 0);
  assert.equal(review.empty, true);
});

test("selectors that could name a control the panel must keep are refused", () => {
  for (const selector of [
    "button",
    "*",
    "#settings-on-top",
    ".confirm-dialog button",
    ".toolbar [data-action=close]",
    ".badge::before",
    ".list > *:first-child",
    ".rows .file-row:nth-child(2)",
    ".view:has(.dialog)",
  ]) {
    assert.equal(isThemeSelector(selector), false, `${selector} is out of range`);
    const review = reviewThemeCss([style(selector, ["color", "red"])]);
    assert.equal(review.allowed.length, 0, `${selector} must not be applied at all`);
  }
});

test("class compounds, their states and their combinations are in range", () => {
  for (const selector of [
    ".badge",
    ".changes .file-row",
    ".btn.tiny:hover",
    ".input:focus-visible",
    ".rows, .history",
    ".branch-selector > .branch-item.active",
  ]) {
    assert.equal(isThemeSelector(selector), true, `${selector} is a component`);
  }
  assert.equal(isThemeSelector(":root"), true);
  assert.equal(isThemeSelector(null), false);
  assert.equal(isThemeSelector("   "), false);
});

test("hiding a control is answered as hiding a control, not as an unknown property", () => {
  for (const property of ["display", "visibility", "position", "pointer-events"]) {
    const review = reviewThemeCss([style(".dialog", [property, property === "position" ? "fixed" : "none"])]);
    assert.deepEqual(becauseOf(review, property), ["hides-controls"]);
  }
});

test("geometry is refused by name, including the sizes the lists measure from", () => {
  for (const property of ["line-height", "font-size", "width", "padding", "z-index"]) {
    const review = reviewThemeCss([style(".file-row", [property, "40px"])]);
    assert.deepEqual(becauseOf(review, property), ["layout"]);
  }
});

test("a shorthand that can carry more than colour is refused as itself, not as geometry", () => {
  for (const property of ["background", "background-image"]) {
    const review = reviewThemeCss([style(".file-row", [property, "#1b1b20"])]);
    assert.deepEqual(becauseOf(review, property), ["too-wide"]);
  }
  // The specific properties the same person wants are the ones that survive.
  const kept = reviewThemeCss([
    style(".file-row", ["background-color", "#1b1b20"], ["color", "#e8e8ea"]),
  ]);
  assert.deepEqual(kept.findings, []);
});

test("a property that changes no painting and no metric is refused as not a theme", () => {
  for (const property of ["cursor", "user-select"]) {
    const review = reviewThemeCss([style(".file-row", [property, "pointer"])]);
    assert.deepEqual(becauseOf(review, property), ["not-a-theme"]);
  }
});

test("the custom properties the row geometry is derived from cannot be set", () => {
  const review = reviewThemeCss([
    style(":root", ["--row-height", "80"], ["--row-height-history", "60"], ["--surface-code", "#222"]),
  ]);
  assert.deepEqual(becauseOf(review, "--row-height"), ["layout"]);
  assert.deepEqual(becauseOf(review, "--row-height-history"), ["layout"]);
  assert.equal(review.allowed[0].declarations.length, 1, "a palette token is still a palette token");
  assert.equal(review.allowed[0].declarations[0].property, "--surface-code");
});

test("a property that is neither colour nor typeface is refused as not a theme", () => {
  const review = reviewThemeCss([style(".badge", ["behavior", "block"], ["src", "x"])]);
  assert.equal(review.allowed.length, 0);
  assert.deepEqual(becauseOf(review, "behavior"), ["not-a-theme"]);
  assert.deepEqual(becauseOf(review, "src"), ["not-a-theme"]);
});

test("a rule whose every declaration was refused says so instead of vanishing", () => {
  const review = reviewThemeCss([style(".badge", ["display", "none"])]);
  assert.equal(review.allowed.length, 0);
  const kinds = review.findings.map((one) => one.kind);
  assert.ok(kinds.includes("property"), "the reason is named");
  assert.ok(kinds.includes("empty"), "and the user learns the rule carried nothing");
});

test("an accepted fragment holds exactly the declarations that were accepted", () => {
  const review = reviewThemeCss([
    style(".badge", ["color", "red"], ["display", "none"], ["outline-color", "green"]),
  ]);
  assert.equal(review.allowed.length, 1);
  assert.deepEqual(
    review.allowed[0].declarations.map((one) => one.property),
    ["color", "outline-color"],
  );
});

test("a fragment that says nothing usable is empty rather than applied as nothing", () => {
  const review = reviewThemeCss([]);
  assert.equal(review.empty, true);
  assert.deepEqual(review.findings, []);
  const junk = reviewThemeCss([style("html", ["display", "none"])]);
  assert.equal(junk.empty, true, "so the working theme is kept instead of replaced");
});

test("a finding names the place in the fragment, not an index", () => {
  const review = reviewThemeCss([
    {
      kind: "media",
      selector: null,
      declarations: [],
      nested: [style(".badge", ["line-height", "3"])],
    },
    style(".rows", ["width", "10px"]),
  ]);
  assert.deepEqual(
    [...new Set(review.findings.map((one) => one.at))],
    ["@media → .badge", ".rows"],
    "every finding, including the rule that carried nothing, names where it sits",
  );
  assert.equal(review.findings[0].item, "line-height");
});

test("a value with no declaration around it is left alone, not reported", () => {
  const review = reviewThemeCss([style(".badge", ["color", "   "], ["", "red"])]);
  assert.deepEqual(review.findings, []);
  assert.equal(review.allowed.length, 0);
});

test("a declaration that insists on beating the panel is refused as a precedence claim", () => {
  for (const property of ["color", "--surface-app"]) {
    const review = reviewThemeCss([
      { kind: "style", selector: ".badge", declarations: [{ property, value: "#ffffff", important: true }] },
    ]);
    assert.equal(review.allowed.length, 0, `${property} !important must not be applied`);
    assert.deepEqual(becauseOf(review, `${property}: #ffffff`), ["overrides-panel"]);
  }
});

test("the worse failure is the one reported, not the merely odd one", () => {
  // A hidden control is a worse outcome than the precedence it claims, so a
  // declaration that is both is answered as the hiding.
  const review = reviewThemeCss([
    { kind: "style", selector: ".badge", declarations: [{ property: "display", value: "none", important: true }] },
  ]);
  assert.deepEqual(becauseOf(review, "display"), ["hides-controls"]);
});

test("every protected token is one the stylesheet defines", () => {
  const css = readFileSync(new URL("../src/style/tokens.css", import.meta.url), "utf8");
  for (const name of PROTECTED_TOKENS) {
    assert.match(css, new RegExp(`${name}\\s*:`), `${name} is protected but nothing defines it`);
  }
  // The names the panel measures from, stated here rather than derived, in the same
  // way the row-height gate restates the stylesheet: if the reviewer stopped
  // protecting one of these, a fragment could move a row under the virtual list.
  for (const name of ["--row-height", "--row-height-history", "--splitter-size"]) {
    assert.ok(PROTECTED_TOKENS.has(name), `${name} decides geometry and must be protected`);
  }
});

test("the one-declaration question has the same answer as the whole review", () => {
  // The caller holding real stylesheet objects asks this question per declaration,
  // because it has to edit the rule it parsed. If that answer differed from the
  // review's, the preview would describe one fragment and apply another.
  for (const pair of [
    ["color", "#ffffff"],
    ["width", "10px"],
    ["display", "none"],
    ["behavior", "block"],
    ["color", "url(a.png)"],
    ["--row-height", "40"],
    ["font-family", "serif"],
  ]) {
    const findings = [];
    const kept = judgeDeclaration({ property: pair[0], value: pair[1] }, [".badge"], findings);
    const review = reviewThemeCss([style(".badge", pair)]);
    assert.deepEqual(kept, review.allowed[0]?.declarations[0] ?? null, `${pair[0]}: ${pair[1]} decision`);
    // The one thing the review adds is the rule-level note that the rule carried
    // nothing, which a single declaration cannot know about its neighbours.
    assert.deepEqual(
      findings,
      review.findings.filter((one) => one.kind !== "empty"),
      `${pair[0]}: ${pair[1]} explanation`,
    );
  }
});
