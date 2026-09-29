// Engine probe for the appearance preferences: what the panel's own renderer does
// with the code that decides how a pasted theme looks.
//
// The fixture tests run the theme reviewer's decisions in Node, where there is no
// stylesheet parser at all. That is the right place to decide policy and the wrong
// place to assume a mechanism: whether a constructed `CSSStyleSheet` parses, whether
// writing a `<style>` changes computed style and can be undone, and whether a
// fragment the reviewer refused leaves the panel's rows alone are facts about
// WebKitGTK, and WebKitGTK is the only engine guit displays through.
//
// This file is run by webkit-engine-probe.py, which bundles it, loads it in an
// offscreen WebKitWebView and prints what comes back. It is not panel code and
// nothing in the panel imports it.

import { reviewThemeFragment } from "../../app/src/themeCss";
import { parseThemeFragment } from "../../app/src/themeParse";
import { reviewThemeCss } from "../../app/src/themeCssModel";
import type { ThemeFinding, ThemeRule } from "../../app/src/themeCssModel";

interface Case {
  name: string;
  fragment: string;
  /** The same fragment as the hand-written structure the pure review is given, so
   * a disagreement says the DOM path and the decided path differ. */
  rules: ThemeRule[];
  /** Set when the answer is not the pure review's: text that is not a stylesheet
   * at all, or a value only the renderer can reject. */
  expect?: string[];
}

function style(selector: string, ...pairs: [string, string][]): ThemeRule {
  return {
    kind: "style",
    selector,
    declarations: pairs.map(([property, value]) => ({
      property,
      value,
      important: value.trim().endsWith("!important"),
    })),
  };
}

function at(kind: ThemeRule["kind"], ...nested: ThemeRule[]): ThemeRule {
  return { kind, selector: null, declarations: [], nested };
}

const CASES: Case[] = [
  {
    name: "a colour a row can take",
    fragment: ".file-row { color: #e6e6e6 }",
    rules: [style(".file-row", ["color", "#e6e6e6"])],
  },
  {
    name: "a control-hiding selector",
    fragment: "body { display: none }",
    rules: [style("body", ["display", "none"])],
  },
  {
    name: "a colour that hides by beating the panel",
    fragment: ".file-row { color: #fff !important }",
    rules: [
      {
        kind: "style",
        selector: ".file-row",
        declarations: [{ property: "color", value: "#fff", important: true }],
      },
    ],
  },
  {
    name: "a remote image",
    fragment: ".dialog { background-image: url(https://example.invalid/x.png) }",
    rules: [style(".dialog", ["background-image", "url(https://example.invalid/x.png)"])],
  },
  {
    name: "the row height itself",
    fragment: ":root { --row-height: 80 }",
    rules: [style(":root", ["--row-height", "80"])],
  },
  {
    name: "a shorthand wider than it looks",
    fragment: ".file-row { background: #222 }",
    rules: [style(".file-row", ["background", "#222"])],
  },
  {
    name: "a cursor, which is not a colour",
    fragment: ".file-row { cursor: pointer }",
    rules: [style(".file-row", ["cursor", "pointer"])],
  },
  {
    name: "a border shorthand, whose colour is allowed on its own",
    fragment: ".dialog { border: 1px solid #f00 }",
    rules: [style(".dialog", ["border", "1px solid #f00"])],
  },
  {
    name: "a font shorthand, whose family is allowed on its own",
    fragment: ".dialog { font: 12px/1.5 serif }",
    rules: [style(".dialog", ["font", "12px/1.5 serif"])],
  },
  {
    name: "an outline shorthand",
    fragment: ".dialog { outline: 2px solid #0f0 }",
    rules: [style(".dialog", ["outline", "2px solid #0f0"])],
  },
  {
    name: "a kept colour next to a refused shorthand",
    fragment: ".dialog { color: #eee; border: 1px solid #f00 }",
    rules: [style(".dialog", ["color", "#eee"], ["border", "1px solid #f00"])],
  },
  {
    name: "a colour kept inside a media query",
    fragment: "@media (prefers-color-scheme: dark) { .dialog { color: #f0f0f0 } }",
    rules: [at("media", style(".dialog", ["color", "#f0f0f0"]))],
  },
  {
    name: "a selector refused inside a media query",
    fragment: "@media (min-width: 1px) { .titlebar button { display: none } }",
    rules: [at("media", style(".titlebar button", ["display", "none"]))],
  },
  {
    name: "an at-rule that is not a theme",
    fragment: "@font-face { font-family: X; src: url(https://example.invalid/x.woff) }",
    rules: [at("font-face")],
  },
  {
    name: "an animation",
    fragment: "@keyframes spin { to { transform: rotate(1turn) } }",
    rules: [at("keyframes")],
  },
  {
    name: "a value with a slash and a function",
    fragment: ".file-row { color: rgb(0 0 0 / var(--x)) }",
    rules: [style(".file-row", ["color", "rgb(0 0 0 / var(--x))"])],
  },
  {
    name: "text that is not a stylesheet",
    fragment: "};--;;{{",
    rules: [],
    expect: ["unparsed/not-a-theme"],
  },
  {
    name: "a colour the renderer cannot read",
    fragment: ".file-row { color: #zzz }",
    rules: [style(".file-row", ["color", "#zzz"])],
    expect: ["value/not-readable"],
  },
  {
    name: "a palette token that is not protected",
    fragment: ":root { --surface-code: #123 }",
    rules: [],
    expect: [],
  },
];

function becauseSet(findings: ThemeFinding[]): string[] {
  return findings.map((finding) => `${finding.kind}/${finding.because}`).sort();
}

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const checks: Check[] = [];

function check(name: string, ok: boolean, detail: unknown): void {
  checks.push({ name, ok, detail: typeof detail === "string" ? detail : JSON.stringify(detail) });
}

function runCase(test: Case): void {
  const fragment = reviewThemeFragment(test.fragment);
  const expected = test.expect ?? becauseSet(reviewThemeCss(test.rules).findings);
  check(
    `review agrees: ${test.name}`,
    becauseSet(fragment.findings).join("|") === expected.join("|"),
    { applied: fragment.rules, engine: becauseSet(fragment.findings), expected },
  );
}

(globalThis as unknown as Record<string, unknown>).__probe = () => {
  const row = document.createElement("div");
  row.className = "file-row";
  document.body.appendChild(row);

  // The mechanism the reviewer depends on, measured rather than assumed: a
  // constructed sheet parses on its own, and a frame sandboxed against the panel's
  // origin cannot be read at all — which is why the review does not use one.
  const frame = document.createElement("iframe");
  frame.setAttribute("hidden", "");
  frame.setAttribute("sandbox", "");
  document.body.appendChild(frame);
  const sandboxedFrame = frame.contentDocument === null ? "unreadable" : "readable";
  frame.remove();

  let constructed = "no";
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(".a { color: red }");
    constructed = `yes-${sheet.cssRules.length}`;
  } catch (error) {
    constructed = `no:${error instanceof Error ? error.name : "?"}`;
  }
  check("a constructed stylesheet parses", constructed.startsWith("yes"), constructed);
  check("a sandboxed frame is not the parse path", sandboxedFrame === "unreadable", sandboxedFrame);

  // Reviewing must not be applying.
  const beforeReview = getComputedStyle(row).color;
  reviewThemeFragment(".file-row { color: rgb(9, 9, 9) }");
  check(
    "reviewing a fragment does not restyle the panel",
    getComputedStyle(row).color === beforeReview,
    { before: beforeReview, after: getComputedStyle(row).color },
  );

  // Writing and clearing the applied theme, the two moves the settings view makes.
  const host = document.createElement("style");
  document.head.appendChild(host);
  host.textContent = ".file-row { color: rgb(1, 2, 3) }";
  const applied = getComputedStyle(row).color;
  host.textContent = "";
  const cleared = getComputedStyle(row).color;
  host.remove();
  check("a written theme changes what the panel paints", applied !== beforeReview, { beforeReview, applied });
  check("emptying the host restores it", cleared === beforeReview, { applied, cleared });

  // The parser must not be the engine's longhand list.
  const font = parseThemeFragment(".row { font: 12px/1.5 serif }").rules[0];
  check(
    "a shorthand is kept as the one property written",
    font.declarations.length === 1 && font.declarations[0].property === "font",
    font.declarations,
  );

  for (const test of CASES) runCase(test);

  row.remove();
  return JSON.stringify({ engine: navigator.userAgent, checks });
};
