// The engine half of a pasted theme fragment: hand the reviewed declarations to
// the renderer's own property setter, and hand back the stylesheet text the
// renderer wrote.
//
// Three rules shape this file.
//
// The decisions are not here. `themeParse.ts` reads what the person wrote and
// `themeCssModel.ts` decides, declaration by declaration; this file only writes
// what it is told to write. A second copy of the policy would drift, and the drift
// would show up as a preview that described one fragment while the panel applied
// another.
//
// The names come from the author, not from the engine. Measured on WebKitGTK
// (2.52.6), asking CSSOM for a rule's properties returns longhands: `font:
// 12px/1.5 serif` arrives as seventeen entries including `font-weight: normal`,
// none of them named `font`. Reviewing that list would refuse the shorthand by
// never seeing it, apply the defaults it stood for, and tell the person about
// thirteen properties they never typed.
//
// The text applied is never assembled here. Each declaration is written with
// `setProperty`, which takes the name and the value as separate arguments, and what
// survives is read back as `cssText` — the engine's own serialization, which by
// construction parses again into what it came from. A fragment whose value contained
// a brace, a semicolon or an escape could produce text that means something else on
// the way back in, and that is how a theme becomes a stylesheet nobody reviewed.

import type { ThemeDeclaration, ThemeFinding, ThemeRule } from "./themeCssModel";
import { reviewThemeCss } from "./themeCssModel";
import { parseThemeFragment } from "./themeParse";

export interface ThemeFragment {
  /** One entry per surviving rule, in the order the fragment stated them. */
  rules: string[];
  findings: ThemeFinding[];
  /** Nothing survived, so the caller keeps the theme that is working. */
  empty: boolean;
}

/** Anything the engine will accept new rules into: a sheet, or a grouping rule. */
interface Container {
  insertRule(text: string, index: number): number;
  deleteRule(index: number): void;
  readonly cssRules: CSSRuleList;
}

/** Review a fragment and return the stylesheet text to apply. A fragment that
 * cannot be read is reported, never treated as an empty theme the user may as well
 * accept. */
export function reviewThemeFragment(text: string): ThemeFragment {
  const parsed = parseThemeFragment(text);
  const review = reviewThemeCss(parsed.rules);
  const findings: ThemeFinding[] = [...parsed.findings, ...review.findings];
  if (review.empty) return { rules: [], findings, empty: true };

  let sheet: CSSStyleSheet;
  try {
    sheet = new CSSStyleSheet();
    sheet.replaceSync("");
  } catch {
    findings.push({ kind: "unparsed", at: "the fragment", item: "the pasted text", because: "not-a-theme" });
    return { rules: [], findings, empty: true };
  }

  const rules: string[] = [];
  for (const rule of review.allowed) {
    const written = writeRule(sheet, rule, findings, sheet.cssRules.length);
    if (written !== null) rules.push(written);
  }
  return { rules, findings, empty: rules.length === 0 };
}

/** Write the reviewed fragment into the element that holds the applied theme.
 *
 * `textContent` only: the fragment is stylesheet text, never markup, and the panel
 * has no path from a user's paste to an element.
 */
export function writeThemeStyle(host: HTMLElement, css: string): void {
  host.textContent = css;
}

/** Returns the engine's text for the rule, or null when it was refused — and a
 * refused rule is gone from the container, so nothing half-written can be applied. */
function writeRule(container: Container, rule: ThemeRule, findings: ThemeFinding[], index: number): string | null {
  const place = rule.selector ?? rule.prelude ?? "the fragment";
  const inserted = insertEmpty(container, rule, index, findings, place);
  if (inserted === null) return null;

  if (rule.kind === "style") {
    const written = writeDeclarations((inserted.rule as CSSStyleRule).style, rule.declarations, findings, place);
    if (written === 0) {
      container.deleteRule(inserted.index);
      return null;
    }
    return inserted.rule.cssText;
  }

  const group = inserted.rule as CSSGroupingRule;
  let kept = 0;
  for (const nested of rule.nested ?? []) {
    const text = writeRule(into(group), nested, findings, group.cssRules.length);
    if (text !== null) kept++;
  }
  if (kept === 0) {
    container.deleteRule(inserted.index);
    return null;
  }
  return group.cssText;
}

/** The same three methods, aimed at the inside of a grouping rule. */
function into(group: CSSGroupingRule): Container {
  return {
    insertRule: (text: string, index: number) => group.insertRule(text, index),
    deleteRule: (index: number) => group.deleteRule(index),
    cssRules: group.cssRules,
  };
}

interface Inserted {
  rule: CSSRule;
  index: number;
}

/** Make the rule's own shell, with nothing in it. The text handed to the engine is
 * the at-rule's prelude or the selector, both of which the review constrained to
 * brace-free and readable forms; the values never enter this string. */
function insertEmpty(
  container: Container,
  rule: ThemeRule,
  index: number,
  findings: ThemeFinding[],
  place: string,
): Inserted | null {
  const shell = rule.kind === "style" ? `${rule.selector ?? ""} {}` : `${rule.prelude ?? ""} {}`;
  try {
    container.insertRule(shell, index);
  } catch {
    findings.push({ kind: "unparsed", at: place, item: shell, because: "not-a-theme" });
    return null;
  }
  const read = container.cssRules[index] as CSSStyleRule | CSSGroupingRule | undefined;
  if (read === undefined) {
    findings.push({ kind: "unparsed", at: place, item: shell, because: "not-a-theme" });
    return null;
  }
  if (rule.kind === "style" && (read as CSSStyleRule).selectorText !== rule.selector) {
    // The engine read a different rule than the one that was reviewed, so the
    // review says nothing about what would be applied.
    container.deleteRule(index);
    findings.push({ kind: "unparsed", at: place, item: shell, because: "not-a-theme" });
    return null;
  }
  return { rule: read, index };
}

function writeDeclarations(
  style: CSSStyleDeclaration,
  declarations: ThemeDeclaration[],
  findings: ThemeFinding[],
  place: string,
): number {
  let kept = 0;
  for (const declaration of declarations) {
    try {
      style.setProperty(declaration.property, declaration.value, declaration.important ? "important" : "");
    } catch {
      findings.push({ kind: "value", at: place, item: declaration.property, because: "not-readable" });
      continue;
    }
    if (style.getPropertyValue(declaration.property) === "") {
      // The renderer was given the name and the value separately and still has
      // nothing for it: the value is not one this engine reads.
      findings.push({ kind: "value", at: place, item: declaration.property, because: "not-readable" });
      continue;
    }
    kept++;
  }
  return kept;
}
