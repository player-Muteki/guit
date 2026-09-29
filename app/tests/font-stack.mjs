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

test("the engine's answer replaces the code stack and nothing else", () => {
  // Measuring whether a stack lines an object ID up needs a document, so the answer
  // is handed in. What this checks is the seam: the resolver is asked the family that
  // was named, its answer goes under `--font-mono` and only there, and with no
  // resolver at all the pair is the plain built stacks a Node run can state.
  const asked = [];
  const props = fontStackProperties({ latinFont: "Arial", cjkFont: "宋体", monoFont: "Menlo" }, (mono) => {
    asked.push(mono);
    return "monospace";
  });
  assert.deepEqual(asked, ["Menlo"]);
  assert.equal(props["--font-mono"], "monospace");
  assert.equal(props["--font-ui"], buildUiStack("Arial", "宋体"), "the text stack is not the resolver's to change");
  assert.equal(
    fontStackProperties({ latinFont: "", cjkFont: "", monoFont: "Menlo" })["--font-mono"],
    buildMonoStack("Menlo"),
  );
});

test("the panel writes both properties from these builders", () => {
  // `font.ts` is the only caller and it cannot be imported here — reading the
  // stylesheet is its job — so the two halves of the wiring are read as text: the
  // values are written under the names this file states, and the code stack goes
  // through the engine rather than being written straight from the name.
  const source = readFileSync(new URL("../src/font.ts", import.meta.url), "utf8");
  assert.match(source, /setProperty\("--font-ui"/, "the text stack is never written");
  assert.match(source, /setProperty\("--font-mono"/, "the code stack is never written");
  assert.match(source, /fontStackProperties\(/, "the pairing is restated in font.ts instead of taken from here");
  assert.match(source, /resolveMonoStack\(/, "the code stack is written without asking the engine");
});

test("the settings sample is the sheet's own font property", () => {
  // A preview built by a second copy of the stack drifts from what the panel draws.
  // The sample lines are therefore styled in the sheet with the same two custom
  // properties everything else uses, so the view that shows them holds no font value
  // of its own to disagree with.
  const css = readFileSync(new URL("../src/style.css", import.meta.url), "utf8");
  assert.match(css, /\.font-preview\.code\s*\{[^}]*var\(--font-mono\)/, "the code sample is not in the written property");
  assert.match(css, /\.font-preview\s*\{/, "the text sample has no rule of its own");
  // An object ID is 40 characters at the widest a person may name, and a sample that
  // cannot break hands the page sideways scrolling.
  assert.match(css, /\.font-preview\s*\{[^}]*overflow-wrap:\s*anywhere/, "the sample line cannot give its width back");
  const view = readFileSync(new URL("../src/views/settings.ts", import.meta.url), "utf8");
  assert.equal(/font-family/.test(view), false, "the view names a family the panel does not write");
});

