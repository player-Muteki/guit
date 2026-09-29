// The DOM half of a pasted theme fragment: read it with the engine's parser, in a
// document the panel's own cascade cannot be reached from; ask the pure reviewer
// about every declaration the parser found; and hand back stylesheet text that the
// engine wrote.
//
// Two rules shape this file, and both come from what it is for.
//
// The decisions are not here. `themeCssModel.ts` decides, declaration by
// declaration, and this file asks it the same question for the same declaration.
// A second copy of the policy would drift, and the drift would show up as a
// preview that described one fragment while the panel applied another.
//
// The text applied is never assembled here. Declarations are removed from the
// parsed rule, and what survives is read back as `cssText` — the engine's own
// serialization, which by construction parses again into what it came from. A
// fragment whose value contained a brace, a semicolon or an escape could produce
// text that means something else on the way back in, and that is how a theme
// becomes a stylesheet the reviewer never approved.

import type { ThemeDeclaration, ThemeFinding, ThemeRule } from "./themeCssModel";
import { isThemeSelector, judgeDeclaration } from "./themeCssModel";

export interface ThemeFragment {
  /** One entry per surviving rule, in the order the fragment stated them. */
  rules: string[];
  findings: ThemeFinding[];
  /** Nothing survived, so the caller keeps the theme that is working. */
  empty: boolean;
}

const FRAME_STYLE = "position:absolute;width:0;height:0;border:0;visibility:hidden";

/** Parse, review and harvest a fragment. Returns nothing usable if the fragment
 * could not be read as a stylesheet at all — a parse failure is reported, never
 * treated as an empty theme the user may as well accept. */
export function reviewThemeFragment(text: string): ThemeFragment {
  const findings: ThemeFinding[] = [];
  const sheet = parseSheet(text, findings);
  if (sheet === null) return { rules: [], findings, empty: true };
  const host: RuleHost = { rules: () => sheet.cssRules, remove: (index) => sheet.deleteRule(index) };
  prune(host, [], findings);
  const rules: string[] = [];
  collect(host.rules(), rules);
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

/** The frame document's `about:blank` is same-origin and its stylesheet is parsed
 * synchronously, so a detached-enough frame is the one mechanism that needs nothing
 * measured on the shipping engine first. A constructed `CSSStyleSheet` would be
 * neater and is not assumed: what it takes to make that the only path is a run on
 * WebKitGTK, and a reviewer that silently had no rules to review is worse than a
 * frame nobody can see. */
function parseSheet(text: string, findings: ThemeFinding[]): CSSStyleSheet | null {
  const frame = document.createElement("iframe");
  frame.setAttribute("hidden", "");
  frame.setAttribute("aria-hidden", "true");
  frame.setAttribute("title", "");
  frame.setAttribute("sandbox", "");
  frame.setAttribute("style", FRAME_STYLE);
  document.body.appendChild(frame);
  try {
    const doc = frame.contentDocument;
    if (doc === null) throw new Error("no parse document");
    const style = doc.createElement("style");
    style.textContent = text;
    doc.head.appendChild(style);
    const sheet = style.sheet as CSSStyleSheet | null;
    if (sheet === null) throw new Error("no parse sheet");
    // Touch the rule list here: a sheet that cannot answer is refused while the
    // frame is still in hand, rather than at the first rule the caller reads.
    void sheet.cssRules.length;
    return sheet;
  } catch {
    findings.push({
      kind: "unparsed",
      at: "the fragment",
      item: "the pasted text",
      because: "not-a-theme",
    });
    return null;
  } finally {
    frame.remove();
  }
}

function kindOf(rule: CSSRule): ThemeRule["kind"] {
  // Named by constructor rather than by the legacy numeric `type`, which reports a
  // CSSFontFaceRule as a STYLE_RULE on some engines — and a font face read as a
  // style rule is a remote resource applied as a colour.
  const name = rule.constructor.name;
  if (name === "CSSMediaRule") return "media";
  if (name === "CSSSupportsRule") return "supports";
  if (name === "CSSImportRule") return "import";
  if (name === "CSSFontFaceRule") return "font-face";
  if (name === "CSSKeyframesRule") return "keyframes";
  if (name === "CSSStyleRule") return "style";
  return "other";
}

/** Where a rule lives and how it is taken out of it.
 *
 * A `CSSRuleList` is read-only: removal belongs to the sheet or the grouping rule
 * that owns it. Carrying the owner along is what makes one traversal work for both,
 * rather than two similar ones that can drift apart on a nested rule. */
interface RuleHost {
  rules(): CSSRuleList;
  remove(index: number): void;
}

function prune(host: RuleHost, trail: string[], findings: ThemeFinding[]): void {
  const rules = host.rules();
  // Descending, because deleting shifts everything after the index.
  for (let index = rules.length - 1; index >= 0; index--) {
    const rule = rules[index];
    const kind = kindOf(rule);
    const styleRule = rule as CSSStyleRule;
    const grouped = rule as CSSGroupingRule;
    const label = kind === "style" ? styleRule.selectorText : `@${kind}`;
    const here = [...trail, label];

    if (kind !== "style" && kind !== "media" && kind !== "supports") {
      findings.push({
        kind: "at-rule",
        at: trailLabel(trail),
        item: `@${kind}`,
        because: kind === "keyframes" ? "layout" : "not-a-theme",
      });
      host.remove(index);
      continue;
    }

    if (kind === "style" && !isThemeSelector(styleRule.selectorText)) {
      findings.push({
        kind: "selector",
        at: trailLabel(trail),
        item: styleRule.selectorText,
        because: "hides-controls",
      });
      host.remove(index);
      continue;
    }

    if (kind === "style") {
      pruneDeclarations(styleRule, here, findings, () => host.remove(index));
      continue;
    }

    prune(
      { rules: () => grouped.cssRules, remove: (nested: number) => grouped.deleteRule(nested) },
      here,
      findings,
    );
    if (grouped.cssRules.length === 0) host.remove(index);
  }
}

function pruneDeclarations(
  rule: CSSStyleRule,
  trail: string[],
  findings: ThemeFinding[],
  removeRule: () => void,
): void {
  const style = rule.style;
  const names: string[] = [];
  for (let position = 0; position < style.length; position++) {
    const name = style.item(position);
    if (name !== null) names.push(name);
  }
  let substantive = 0;
  for (const name of names) {
    const value = style.getPropertyValue(name);
    const declaration: ThemeDeclaration = {
      property: name,
      value,
      important: style.getPropertyPriority(name) === "important",
    };
    if (declaration.property.trim() !== "" && declaration.value.trim() !== "") substantive++;
    if (judgeDeclaration(declaration, trail, findings) === null) style.removeProperty(name);
  }
  // The same notice the pure review gives: the rule said something and all of it
  // was refused, so the findings above are read as the reason for its absence.
  if (style.length === 0 && substantive > 0) {
    findings.push({
      kind: "empty",
      at: trailLabel(trail),
      item: rule.selectorText,
      because: "not-a-theme",
    });
    removeRule();
  }
}

function collect(rules: CSSRuleList, into: string[]): void {
  for (let index = 0; index < rules.length; index++) {
    const rule = rules[index];
    into.push(rule.cssText);
  }
}

function trailLabel(trail: string[]): string {
  return trail.length === 0 ? "the fragment" : trail.join(" → ");
}
