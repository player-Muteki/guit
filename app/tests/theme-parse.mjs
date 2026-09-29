import assert from "node:assert/strict";
import test from "node:test";

import { parseThemeFragment } from "../src/themeParse.ts";

const rulesOf = (text) => parseThemeFragment(text).rules;
const findingsOf = (text) => parseThemeFragment(text).findings;
const kindsOf = (findings) => findings.map((one) => `${one.kind}/${one.because}`);

const styleRule = (text) => {
  const rules = rulesOf(text);
  assert.equal(rules.length, 1, JSON.stringify(rules));
  assert.equal(rules[0].kind, "style");
  return rules[0];
};

const declarations = (text) => styleRule(text).declarations;

test("a shorthand stays the one property the person wrote", () => {
  assert.deepEqual(declarations(".file-row { background: #222 }"), [
    { property: "background", value: "#222", important: false },
  ]);
});

test("the font shorthand is not a list of defaults", () => {
  // The reason this parser exists: the engine would hand back seventeen entries
  // here, most of them values nobody asked for.
  assert.deepEqual(declarations(".row { font: 12px/1.5 serif }"), [
    { property: "font", value: "12px/1.5 serif", important: false },
  ]);
});

test("a plain property name is read case-insensitively and a value is kept as written", () => {
  assert.deepEqual(declarations(".row { COLOR: Red }"), [
    { property: "color", value: "Red", important: false },
  ]);
});

test("a custom property keeps its own case", () => {
  assert.deepEqual(declarations(":root { --Surface-Code: #123 }"), [
    { property: "--Surface-Code", value: "#123", important: false },
  ]);
});

test("the important flag is separated from the value", () => {
  assert.deepEqual(declarations(".row { color: #fff !important }"), [
    { property: "color", value: "#fff", important: true },
  ]);
  assert.deepEqual(declarations(".row { color:#fff!important }"), [
    { property: "color", value: "#fff", important: true },
  ]);
  assert.deepEqual(declarations(".row { color: red ! important }"), [
    { property: "color", value: "red", important: true },
  ]);
});

test("text that only looks like the important flag stays in the value", () => {
  assert.deepEqual(declarations('.row { content: "!important" }'), [
    { property: "content", value: '"!important"', important: false },
  ]);
});

test("a semicolon inside a quoted value does not end the declaration", () => {
  assert.deepEqual(declarations('.row { content: "x;y"; color: red }'), [
    { property: "content", value: '"x;y"', important: false },
    { property: "color", value: "red", important: false },
  ]);
});

test("a semicolon or a colon inside parentheses does not split anything", () => {
  assert.deepEqual(declarations(".row { background-image: url(a;b.png) }"), [
    { property: "background-image", value: "url(a;b.png)", important: false },
  ]);
  assert.deepEqual(declarations(".row { background: url(https://x/y.png) }"), [
    { property: "background", value: "url(https://x/y.png)", important: false },
  ]);
  assert.deepEqual(declarations(".row { background: linear-gradient(red, blue) }"), [
    { property: "background", value: "linear-gradient(red, blue)", important: false },
  ]);
});

test("a brace inside a quoted value does not end the rule", () => {
  assert.deepEqual(declarations('.row { content: "}" }'), [
    { property: "content", value: '"}"', important: false },
  ]);
});

test("a comment is whitespace and does not become a declaration", () => {
  assert.deepEqual(declarations(".row { /* color: blue */ color: red }"), [
    { property: "color", value: "red", important: false },
  ]);
});

test("a comment that never closes has eaten the fragment", () => {
  const parsed = parseThemeFragment(".row { color: red } /* still open");
  assert.deepEqual(parsed.rules, []);
  assert.deepEqual(kindsOf(parsed.findings), ["unparsed/not-a-theme"]);
});

test("a rule that never closes refuses the fragment rather than half of it", () => {
  const parsed = parseThemeFragment(".row { color: red");
  assert.deepEqual(parsed.rules, []);
  assert.deepEqual(kindsOf(parsed.findings), ["unparsed/not-a-theme"]);
});

test("a stray brace refuses the fragment", () => {
  const parsed = parseThemeFragment(".row { color: red } }");
  assert.deepEqual(parsed.rules, []);
  assert.deepEqual(kindsOf(parsed.findings), ["unparsed/not-a-theme"]);
});

test("text at the top level that is not a rule refuses the fragment", () => {
  const parsed = parseThemeFragment("color: red; .row { color: blue }");
  assert.deepEqual(parsed.rules, []);
  assert.deepEqual(kindsOf(parsed.findings), ["unparsed/not-a-theme"]);
});

test("one unreadable declaration is dropped and its neighbours survive", () => {
  const rule = styleRule(".row { color: red; nonsense }");
  assert.deepEqual(rule.declarations, [{ property: "color", value: "red", important: false }]);
  assert.deepEqual(kindsOf(findingsOf(".row { color: red; nonsense }")), ["unparsed/not-a-theme"]);
});

test("a name with a space in it is not a property", () => {
  const parsed = parseThemeFragment(".row { font weight: bold }");
  assert.deepEqual(parsed.rules[0].declarations, []);
  assert.deepEqual(kindsOf(parsed.findings), ["unparsed/not-a-theme"]);
});

test("a value that is only the important flag is not a value", () => {
  const parsed = parseThemeFragment(".row { color: !important }");
  assert.deepEqual(parsed.rules[0].declarations, []);
  assert.deepEqual(kindsOf(parsed.findings), ["unparsed/not-a-theme"]);
});

test("an empty value is reported, not passed on as a declaration", () => {
  const parsed = parseThemeFragment(".row { color: }");
  assert.deepEqual(parsed.rules[0].declarations, []);
  assert.deepEqual(kindsOf(parsed.findings), ["unparsed/not-a-theme"]);
});

test("a selector is kept exactly as written, including a comma list", () => {
  const rule = styleRule(".file-row, .history-row { color: red }");
  assert.equal(rule.selector, ".file-row, .history-row");
});

test("a grouping rule keeps its own text and the rules inside it", () => {
  const [media] = rulesOf("@media (prefers-color-scheme: dark) { .dialog { color: #eee } }");
  assert.equal(media.kind, "media");
  assert.equal(media.prelude, "@media (prefers-color-scheme: dark)");
  assert.equal(media.nested.length, 1);
  assert.deepEqual(media.nested[0].declarations, [{ property: "color", value: "#eee", important: false }]);
});

test("grouping rules nest and each keeps its own text", () => {
  const [media] = rulesOf("@media all { @supports (color: red) { .dialog { color: #eee } } }");
  const [supports] = media.nested;
  assert.equal(supports.kind, "supports");
  assert.equal(supports.prelude, "@supports (color: red)");
  assert.equal(supports.nested[0].selector, ".dialog");
});

test("an at-rule that is not a theme is classified and its inside is not read", () => {
  const [keyframes] = rulesOf("@keyframes spin { from { transform: rotate(1turn) } }");
  assert.equal(keyframes.kind, "keyframes");
  assert.deepEqual(keyframes.declarations, []);
  assert.deepEqual(findingsOf("@keyframes spin { from { transform: rotate(1turn) } }"), []);
});

test("a statement at-rule is a rule with no block", () => {
  const [imported] = rulesOf('@import "theme.css";');
  assert.equal(imported.kind, "import");
  assert.equal(imported.prelude, '@import "theme.css"');
});

test("an unknown at-rule is still a rule the reviewer can refuse", () => {
  const [other] = rulesOf("@property --x { syntax: '*' }");
  assert.equal(other.kind, "other");
});

test("nothing at all is not a failure", () => {
  assert.deepEqual(parseThemeFragment("   \n  "), { rules: [], findings: [] });
  assert.deepEqual(parseThemeFragment(""), { rules: [], findings: [] });
});

test("several rules survive in the order they were written", () => {
  const rules = rulesOf(".a { color: red } .b { color: blue } .c { color: lime }");
  assert.deepEqual(rules.map((one) => one.selector), [".a", ".b", ".c"]);
});

test("a refusal inside a grouping rule refuses the fragment, not the group", () => {
  const parsed = parseThemeFragment("@media all { .dialog { color: red");
  assert.deepEqual(parsed.rules, []);
  assert.deepEqual(kindsOf(parsed.findings), ["unparsed/not-a-theme"]);
});
