// The font stack a user can build, and the parts of it they cannot.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  MONO_TAIL,
  UI_TAIL,
  buildMonoStack,
  buildUiStack,
  fontStackProperties,
  isSafeFamilyName,
} from "../src/fontStack.ts";
import { FAMILY_MAX, isFontFamily } from "../src/preferencesModel.ts";

const NAMES = [
  "Arial",
  "Noto Sans CJK SC",
  "微软雅黑",
  "Inconsolata",
  "IBM Plex Mono",
  "",
];

test("no family chosen is the built-in stack, exactly", () => {
  assert.equal(buildUiStack("", ""), UI_TAIL);
  assert.equal(buildMonoStack(""), MONO_TAIL);
  // Clearing a family must not restyle the panel, so the untouched default here is
  // the same string the stylesheet already states.
  const tokens = readFileSync(new URL("../src/style/tokens.css", import.meta.url), "utf8");
  assert.match(tokens, new RegExp(`--font-ui: ${UI_TAIL};`), "the UI default differs from the stylesheet");
  assert.match(tokens, new RegExp(`--font-mono: ${MONO_TAIL};`), "the mono default differs from the stylesheet");
});

test("named families come first, in per-character fallback order", () => {
  const stack = buildUiStack("Arial", "微软雅黑");
  assert.equal(stack, '"Arial", "微软雅黑", ' + UI_TAIL);
  assert.ok(stack.indexOf('"Arial"') < stack.indexOf('"微软雅黑"'), "Latin is asked first");
  assert.ok(stack.endsWith("sans-serif"), "the generic keyword stays last");
});

test("a name that looks like a keyword cannot become one", () => {
  for (const name of ["inherit", "initial", "unset", "revert", "sans-serif", "monospace", "none"]) {
    for (const [stack, tail] of [
      [buildUiStack(name, ""), UI_TAIL],
      [buildMonoStack(name), MONO_TAIL],
    ]) {
      assert.ok(stack.includes(`"${name}"`), `${name} is written as a name`);
      // Remove what the user contributed and only the authored tail is left: their
      // word appears nowhere unquoted, so nothing in the stack is a keyword they
      // supplied.
      assert.equal(stack.replace(/"[^"]*",\s*/, ""), tail, `${name} reached the stack unquoted`);
    }
  }
});

test("a name that is not a name is dropped, whole", () => {
  for (const hostile of [
    'Arial; color: red',
    "Arial}",
    "Arial{",
    'Ai"rial',
    "-oops",
    "Arial\nbody",
    "@Arial",
    "x".repeat(FAMILY_MAX + 1),
  ]) {
    assert.equal(isSafeFamilyName(hostile), false, `${hostile} is not a family name`);
    const stack = buildUiStack(hostile, "Arial");
    assert.equal(stack, '"Arial", ' + UI_TAIL, `${hostile} must not appear at all`);
    assert.equal(buildMonoStack(hostile), MONO_TAIL);
  }
});

test("no stack this builds can end a declaration or open a rule", () => {
  for (const latin of [...NAMES, "Arial; }", 'A"B', "A,B", "A:B"]) {
    for (const cjk of [...NAMES, "宋体}", "A;B"]) {
      const stack = buildUiStack(latin, cjk);
      assert.equal(/[{};<>]/.test(stack), false, `${stack} carries a structural character`);
      assert.equal(buildMonoStack(latin).includes(";"), false);
    }
  }
});

test("the stack agrees with the record about what a name is", () => {
  // Two modules cannot share the check — a Node-loaded file cannot take a value
  // from another — so the shapes are compared instead, over the ones that decide
  // whether a family is written or dropped.
  const corpus = [...NAMES, " Arial ", "Arial  ", "1Aria", "Arial.", "Arial_-1", 'A"B', "A;B", "", "   ", "@x", "-x", "x".repeat(FAMILY_MAX), "x".repeat(FAMILY_MAX + 1), "宋体", "ＡＢ"];
  for (const value of corpus) {
    assert.equal(
      isSafeFamilyName(value),
      isFontFamily(value.trim()),
      `${JSON.stringify(value)}: the writer and the record disagree`,
    );
  }
});

test("the properties written are the stacks built", () => {
  const props = fontStackProperties({ latinFont: "Arial", cjkFont: "", monoFont: "Menlo" });
  assert.deepEqual(Object.keys(props), ["--font-ui", "--font-mono"]);
  assert.equal(props["--font-ui"], buildUiStack("Arial", ""));
  assert.equal(props["--font-mono"], buildMonoStack("Menlo"));
  // The preview and the applied value ask the same function, so what the settings
  // page shows is not a description of what the panel does.
  assert.equal(fontStackProperties({ latinFont: "", cjkFont: "", monoFont: "" })["--font-ui"], UI_TAIL);
});
