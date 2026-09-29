// What a pasted theme fragment is allowed to say.
//
// This module decides; it does not parse. Parsing is the engine's job — a theme
// fragment is read into a stylesheet and every rule and declaration in it is
// handed here as already-understood structure, because a set of regular expressions
// over stylesheet text cannot claim to isolate CSS: a comment, a string, an escape
// or a nested block defeats any of them, and the whole point of the exercise is
// that the fragment is pasted by someone who did not read this file.
//
// The subset is the one a theme actually needs: palette tokens and the colour,
// background, border and typeface of the panel's own components. Everything that
// would reach the network, redraw the layout, or take a control away from the user
// is refused with a reason, and the reasons are shown *before* anything is applied.
//
// Pure: no DOM, no stylesheet, no storage, no Git.

export type RuleKind = "style" | "media" | "supports" | "import" | "font-face" | "keyframes" | "other";

export interface ThemeDeclaration {
  property: string;
  value: string;
  /** The `!important` flag. It is a claim about precedence, not a colour, so a
   * fragment that needs it is trying to beat a declaration the panel chose for
   * legibility. */
  important?: boolean;
}

/** One rule of a parsed fragment. `nested` holds the rules inside an at-rule that
 * groups others; `selector` is null for a rule that has none. `prelude` is the
 * at-rule's own text as it was written, kept because a grouping rule cannot be
 * handed back to the engine without it — `@media` on its own says nothing about
 * which condition was asked for. */
export interface ThemeRule {
  kind: RuleKind;
  selector: string | null;
  declarations: ThemeDeclaration[];
  nested?: ThemeRule[];
  prelude?: string;
}

export type ProblemKind =
  | "at-rule"
  | "selector"
  | "property"
  | "value"
  | "token"
  | "priority"
  | "unparsed"
  | "empty";

export interface ThemeFinding {
  kind: ProblemKind;
  /** Where the problem is, phrased so it can be shown next to the text the user
   * pasted. A rule index is meaningless to someone reading their own fragment. */
  at: string;
  /** The name that was refused, so the fragment can be edited rather than
   * rewritten from scratch. */
  item: string;
  /** Why it was refused. These are the answers the user can act on. The last one
   * is not decided here: `themeCss.ts` writes an accepted value with the engine's
   * own setter and asks whether it survived, so "the renderer could not read it"
   * is a fact about this engine rather than a rule of the subset. */
  because:
    | "network"
    | "layout"
    | "hides-controls"
    | "overrides-panel"
    | "too-wide"
    | "not-a-theme"
    | "not-readable";
}

export interface ThemeReview {
  /** The rules that survived, in the order they arrived. This is what gets
   * applied; a refused declaration is absent from it rather than rewritten, so
   * what the preview shows is exactly what the panel will hold. */
  allowed: ThemeRule[];
  findings: ThemeFinding[];
  /** True when nothing at all survived, which the caller treats as "do not
   * replace the theme that is working" rather than as an empty theme. */
  empty: boolean;
}

// Declarations a theme may make. Colour and typeface only; every name here was
// chosen because changing it cannot move a row, a column or a control.
const ALLOWED_PROPERTIES: readonly string[] = [
  "color",
  "background-color",
  "opacity",
  "border-color",
  "border-top-color",
  "border-right-color",
  "border-bottom-color",
  "border-left-color",
  "outline-color",
  "text-decoration-color",
  "fill",
  "stroke",
  "caret-color",
  "accent-color",
  "font-family",
  "font-weight",
  "font-style",
  "font-variant",
  "text-transform",
  "letter-spacing",
  "text-shadow",
  "box-shadow",
];

// Refused by name before any value is looked at, each because it would move the
// layout the virtual lists and the graph are measured against, or take a control
// out of reach. Listing them separately from "not allowed" keeps the answer to the
// user specific: "this changes geometry" is actionable, "unknown property" is not.
const LAYOUT_PROPERTIES: Readonly<Set<string>> = new Set([
  "position",
  "inset",
  "top",
  "right",
  "bottom",
  "left",
  "z-index",
  "display",
  "visibility",
  "content",
  "pointer-events",
  "overflow",
  "overflow-x",
  "overflow-y",
  "width",
  "height",
  "min-width",
  "min-height",
  "max-width",
  "max-height",
  "margin",
  "padding",
  "gap",
  "row-gap",
  "column-gap",
  "flex",
  "flex-direction",
  "flex-basis",
  "flex-grow",
  "flex-shrink",
  "grid",
  "grid-template-columns",
  "grid-template-rows",
  "transform",
  "transition",
  "animation",
  "font-size",
  "line-height",
  "border",
  "border-width",
  "border-style",
]);

// The names that can set more than they look like they set. `background: #1b1b20`
// reads as a colour statement and is one, but the same property also carries an
// image, a position and a size, so the panel cannot say what a value it has not
// parsed would move. Refused by name, answered differently from `width` and from
// `cursor`: the actionable reply is to write the specific property instead.
const SHAPE_SHORTHANDS: ReadonlySet<string> = new Set(["background", "background-image"]);

// The layout names that specifically take a control out of reach. They are answered
// differently from `width`: "this hides something you need" is a warning the user
// acts on, "this moves something" is a note about the measurement.
const HIDING_PROPERTIES: ReadonlySet<string> = new Set([
  "display",
  "visibility",
  "position",
  "pointer-events",
]);

// The custom properties the panel's geometry and text metrics are stated in terms
// of. A fragment that could set these would change what a row costs, or what a
// glyph costs, without the row-height agreement gate or the font fallback ever
// seeing it — which is how a virtual list starts drawing rows over each other and
// how an OID stops being readable. Colours remain open: every other `--*` name is
// a palette token.
//
// The names here are the ones the stylesheet defines, and a test reads the
// stylesheet to keep them that way: a protected name that no longer exists protects
// nothing, and the fragment that sets the real one is applied.
export const PROTECTED_TOKENS: ReadonlySet<string> = new Set([
  "--row-height",
  "--row-height-history",
  "--splitter-size",
  "--main-list-floor",
  "--main-graph-floor",
  "--font-ui",
  "--font-mono",
]);

// At-rules that only group other rules. Their children are reviewed by the same
// rules, so a colour choice that is correct for one scheme is allowed without
// handing the fragment a way to describe a different document.
const GROUPING_KINDS: ReadonlySet<RuleKind> = new Set<RuleKind>(["media", "supports"]);

// A background is a colour, not an image: anything naming a resource is refused
// wherever it appears, including inside a value that otherwise looks harmless.
const RESOURCE_PATTERN = /url\s*\(|@\s*import|javascript:|expression\s*\(/i;

// A compound selector this reviewer accepts: one class, then any number of the
// panel's own state pseudo-classes. Tag, id, attribute and pseudo-element selectors
// are refused by construction rather than by a list, because each of them can name a
// node the fragment should not own — including the controls that must always stay
// reachable — and a structural pseudo-class picks a node by position rather than by
// what the component is.
// One compound: the component classes it carries, then any of the panel's own
// state pseudo-classes. Chained classes are a component narrowed by a second
// class, which is how the panel names a small button.
const COMPOUND = /^(?:\.[A-Za-z_][\w-]*)+(?::(?:hover|active|focus|focus-visible|checked|disabled|enabled|read-only))*$/;

/** Whether a selector may address the panel at all.
 *
 * In range: `:root` (palette tokens), and selectors built only from class compounds
 * joined by whitespace or a combinator. Comma-separated selectors are reviewed as one
 * rule and refused whole, because applying half of a rule would preview something
 * other than what the user pasted.
 */
export function isThemeSelector(selector: string | null): boolean {
  if (selector === null) return false;
  const text = selector.trim();
  if (text === "") return false;
  if (text === ":root") return true;
  for (const subject of text.split(",")) {
    const parts = subject.trim().split(/[\s>+~]+/).filter((part) => part !== "");
    if (parts.length === 0) return false;
    if (!parts.every((part) => COMPOUND.test(part))) return false;
  }
  return true;
}

export function reviewThemeCss(rules: ThemeRule[]): ThemeReview {
  const allowed: ThemeRule[] = [];
  const findings: ThemeFinding[] = [];
  walk(rules, allowed, findings, []);
  return { allowed, findings, empty: allowed.length === 0 };
}

function pathOf(trail: string[]): string {
  return trail.length === 0 ? "the fragment" : trail.join(" → ");
}

function walk(rules: ThemeRule[], allowed: ThemeRule[], findings: ThemeFinding[], trail: string[]): void {
  for (const rule of rules) {
    const label = rule.kind === "style" ? rule.selector ?? "a rule" : `@${rule.kind}`;
    const here = [...trail, label ?? "a rule"];

    if (rule.kind === "import" || rule.kind === "font-face" || rule.kind === "keyframes" || rule.kind === "other") {
      findings.push({
        kind: "at-rule",
        at: pathOf(trail),
        item: `@${rule.kind}`,
        because: rule.kind === "keyframes" ? "layout" : "not-a-theme",
      });
      continue;
    }

    if (GROUPING_KINDS.has(rule.kind)) {
      const kept: ThemeRule[] = [];
      walk(rule.nested ?? [], kept, findings, here);
      if (kept.length > 0) allowed.push({ ...rule, declarations: [], nested: kept });
      continue;
    }

    if (!isThemeSelector(rule.selector)) {
      // Reported at the rule's own place, like every other finding: a selector
      // refused inside `@media` has to say which one, not just which at-rule.
      findings.push({ kind: "selector", at: pathOf(here), item: rule.selector ?? "", because: "hides-controls" });
      continue;
    }

    const declarations: ThemeDeclaration[] = [];
    let refused = 0;
    for (const declaration of rule.declarations) {
      const kept = judgeDeclaration(declaration, here, findings);
      if (kept !== null) declarations.push(kept);
      else if (isSubstantive(declaration)) refused++;
    }
    if (declarations.length > 0) allowed.push({ kind: "style", selector: rule.selector, declarations });
    else if (refused > 0) {
      // The rule said something and every word of it was refused: worth saying
      // that the rule itself is not the problem, so the findings above are read
      // as the reason rather than as a mysterious drop. A declaration the parser
      // never understood is not "refused", and is left unreported — there is no
      // name to give the user to edit.
      findings.push({ kind: "empty", at: pathOf(here), item: rule.selector ?? "", because: "not-a-theme" });
    }
  }
}

function isSubstantive(declaration: ThemeDeclaration): boolean {
  return declaration.property.trim() !== "" && declaration.value.trim() !== "";
}

/** One declaration, decided.
 *
 * This is the whole policy, and the caller that holds real stylesheet objects asks
 * the same question of every declaration it can see, so what the preview reports
 * and what ends up applied are the same decision rather than two similar ones.
 */
export function judgeDeclaration(
  declaration: ThemeDeclaration,
  trail: string[],
  findings: ThemeFinding[],
): ThemeDeclaration | null {
  const property = declaration.property.trim().toLowerCase();
  const value = declaration.value;
  const report = (kind: ProblemKind, because: ThemeFinding["because"], item: string): null => {
    findings.push({ kind, at: pathOf(trail), item, because });
    return null;
  };

  if (property === "" || value.trim() === "") return null;
  if (RESOURCE_PATTERN.test(value)) {
    return report("value", "network", `${property}: ${value.trim().slice(0, 40)}`);
  }
  if (LAYOUT_PROPERTIES.has(property)) {
    // A name on this list is refused even on a selector that could not hide
    // anything, because the panel measures what a row costs from the same
    // properties the fragment would change.
    return report(
      "property",
      HIDING_PROPERTIES.has(property) ? "hides-controls" : "layout",
      property,
    );
  }
  if (property.startsWith("--")) {
    if (PROTECTED_TOKENS.has(property)) return report("token", "layout", property);
    return rejectPriority(declaration, property, value, trail, findings);
  }
  if (SHAPE_SHORTHANDS.has(property)) {
    return report("property", "too-wide", property);
  }
  if (!ALLOWED_PROPERTIES.includes(property)) {
    return report("property", "not-a-theme", property);
  }
  return rejectPriority(declaration, property, value, trail, findings);
}

function rejectPriority(
  declaration: ThemeDeclaration,
  property: string,
  value: string,
  trail: string[],
  findings: ThemeFinding[],
): ThemeDeclaration | null {
  if (declaration.important !== true) return { property, value };
  // The fragment's own colours already win over the panel's by order of writing,
  // so `!important` is only needed to beat a declaration the panel chose for
  // legibility. That is not a theme statement, and the panel keeps its own.
  findings.push({
    kind: "priority",
    at: pathOf(trail),
    item: `${property}: ${value.trim().slice(0, 40)}`,
    because: "overrides-panel",
  });
  return null;
}
