// An author-level read of a pasted fragment: which rules the person wrote, and
// which property names they wrote them with.
//
// The engine's own parser cannot answer that. Measured on WebKitGTK (2.52.6), a
// written `font: 12px/1.5 serif` arrives at CSSOM as seventeen longhand entries —
// the family and size, yes, and also `font-style: normal`, `font-weight: normal`
// and the other defaults the shorthand states — and none of them is named `font`.
// Judged one by one, most are refused and the survivors are applied, so a theme
// the reviewer rejected would still reset the panel's bold text. Removing the
// shorthand afterwards takes its longhands with it, which is the right shape but
// the wrong order: by then the reviewer has already been asked about the wrong
// names. So the names here are the ones that were typed, and the engine is asked
// only what it is good at: whether a value it can read survives the write.
//
// Anything this parser cannot make sense of is refused, not guessed at. A fragment
// with an unbalanced brace, a stray `}` or a declaration with no name is reported
// and dropped whole; a half-read stylesheet applied as a theme is the failure this
// file exists to prevent.
//
// Pure: no DOM, no engine, no stylesheet object. `themeCss.ts` writes what this
// returns and reads the text back.

import type { ThemeDeclaration, ThemeFinding, ThemeRule } from "./themeCssModel";

export interface ParsedFragment {
  rules: ThemeRule[];
  findings: ThemeFinding[];
}

/** How much of the offender is echoed back to the person who pasted it. Long
 * enough to recognise, short enough not to flood a settings row. */
const ECHO = 40;

const GROUPING: Readonly<Record<string, "media" | "supports">> = {
  "@media": "media",
  "@supports": "supports",
};

const NAMED: Readonly<Record<string, "import" | "font-face" | "keyframes">> = {
  "@import": "import",
  "@font-face": "font-face",
  "@keyframes": "keyframes",
};

export function parseThemeFragment(text: string): ParsedFragment {
  const findings: ThemeFinding[] = [];
  const source = stripComments(text, findings);
  if (source === null) return { rules: [], findings };
  return { rules: readRules(source, findings, "") ?? [], findings };
}

function unparsed(at: string, item: string): ThemeFinding {
  return { kind: "unparsed", at, item: echo(item), because: "not-a-theme" };
}

function echo(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > ECHO ? `${trimmed.slice(0, ECHO)}…` : trimmed;
}

function refuse(findings: ThemeFinding[], at: string, item: string): null {
  findings.push(unparsed(at, item));
  return null;
}

/** Comments are whitespace to CSS, and an unterminated one has eaten the rest of
 * the fragment, so it is the whole fragment that is refused rather than a rule. */
function stripComments(text: string, findings: ThemeFinding[]): string | null {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const open = text.indexOf("/*", index);
    if (open < 0) {
      out += text.slice(index);
      break;
    }
    const close = text.indexOf("*/", open + 2);
    if (close < 0) return refuse(findings, "the fragment", text.slice(open));
    out += text.slice(index, open) + " ";
    index = close + 2;
  }
  return out;
}

/** The index of the next delimiter at this nesting level, or -1 for none.
 *
 * Quotes and parentheses are tracked because `content: "}"`, `url(a)b` and a value
 * with a `;` inside a string all read differently to someone who is only looking
 * for the first of those characters. */
function nextDelimiter(text: string, from: number, targets: string): number {
  let parens = 0;
  let quote: string | null = null;
  for (let index = from; index < text.length; index++) {
    const char = text[index];
    if (quote !== null) {
      if (char === "\\") index++;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "(" || char === "[") {
      parens++;
      continue;
    }
    if (char === ")" || char === "]") {
      parens = Math.max(0, parens - 1);
      continue;
    }
    if (parens === 0 && targets.includes(char)) return index;
  }
  return -1;
}

/** The index just past the `}` matching the `{` at `open`, or -1 if there is none. */
function matchBlock(text: string, open: number): number {
  let braces = 0;
  let parens = 0;
  let quote: string | null = null;
  for (let index = open; index < text.length; index++) {
    const char = text[index];
    if (quote !== null) {
      if (char === "\\") index++;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "(" || char === "[") {
      parens++;
      continue;
    }
    if (char === ")" || char === "]") {
      parens = Math.max(0, parens - 1);
      continue;
    }
    if (parens > 0) continue;
    if (char === "{") braces++;
    else if (char === "}") {
      braces--;
      if (braces === 0) return index + 1;
    }
  }
  return -1;
}

function readRules(text: string, findings: ThemeFinding[], place: string): ThemeRule[] | null {
  const at = place === "" ? "the fragment" : place;
  const rules: ThemeRule[] = [];
  let index = 0;
  for (;;) {
    const here = skipSpace(text, index);
    if (here >= text.length) break;
    const next = nextDelimiter(text, here, "{};");
    if (next < 0) {
      const rest = text.slice(here);
      if (rest.trim() !== "") return refuse(findings, at, rest);
      break;
    }
    const char = text[next];
    if (char === "}") return refuse(findings, at, text.slice(here, next + 1));
    if (char === ";") {
      const statement = text.slice(here, next).trim();
      if (statement !== "") {
        const rule = readStatement(statement);
        if (rule === null) return refuse(findings, at, statement);
        rules.push(rule);
      }
      index = next + 1;
      continue;
    }
    const prelude = text.slice(here, next).trim();
    const end = matchBlock(text, next);
    if (end < 0) return refuse(findings, at, text.slice(here));
    const body = text.slice(next + 1, end - 1);
    const rule = readRule(prelude, body, findings);
    if (rule === null) return null;
    if (rule !== undefined) rules.push(rule);
    index = end;
  }
  return rules;
}

function skipSpace(text: string, from: number): number {
  let index = from;
  while (index < text.length && /\s/.test(text[index])) index++;
  return index;
}

/** `@import url(x);` — a statement, not a block. Refused as an at-rule by the
 * reviewer, which is what `kind` is for. */
function readStatement(statement: string): ThemeRule | null {
  if (!statement.startsWith("@")) return null;
  return { kind: atKind(statement), selector: null, declarations: [], prelude: statement };
}

function atKind(prelude: string): ThemeRule["kind"] {
  const keyword = prelude.slice(0, keywordLength(prelude)).toLowerCase();
  const grouped = GROUPING[keyword];
  if (grouped !== undefined) return grouped;
  const named = NAMED[keyword];
  if (named !== undefined) return named;
  return "other";
}

function keywordLength(prelude: string): number {
  const match = /^@[a-zA-Z-]+/.exec(prelude);
  return match === null ? 1 : match[0].length;
}

/** Returns undefined for a rule that was reported and dropped, null for a
 * fragment that cannot be trusted any further. */
function readRule(prelude: string, body: string, findings: ThemeFinding[]): ThemeRule | undefined | null {
  if (prelude === "") {
    findings.push(unparsed("the fragment", body));
    return undefined;
  }
  if (prelude.startsWith("@")) {
    const kind = atKind(prelude);
    if (kind !== "media" && kind !== "supports") {
      // Its inside is not read: `@keyframes` and `@font-face` are refused whole,
      // so parsing their bodies would only invent findings for text the person
      // will be told to remove.
      return { kind, selector: null, declarations: [], prelude };
    }
    const nested = readRules(body, findings, `@${kind}`);
    if (nested === null) return null;
    return { kind, selector: null, declarations: [], nested, prelude };
  }
  return { kind: "style", selector: prelude, declarations: readDeclarations(body, prelude, findings) };
}

function readDeclarations(body: string, place: string, findings: ThemeFinding[]): ThemeDeclaration[] {
  const out: ThemeDeclaration[] = [];
  let index = 0;
  for (;;) {
    const next = nextDelimiter(body, index, ";");
    const entry = next < 0 ? body.slice(index) : body.slice(index, next);
    if (entry.trim() !== "") {
      const declaration = readDeclaration(entry, place, findings);
      if (declaration !== undefined) out.push(declaration);
    }
    if (next < 0) break;
    index = next + 1;
  }
  return out;
}

function readDeclaration(entry: string, place: string, findings: ThemeFinding[]): ThemeDeclaration | undefined {
  const colon = nextDelimiter(entry, 0, ":");
  if (colon < 0) {
    findings.push(unparsed(place, entry));
    return undefined;
  }
  const written = entry.slice(0, colon).trim();
  // A custom property is case-sensitive and can hold almost anything; a plain one
  // is matched against the reviewer's lists, which are written in lower case.
  const property = written.startsWith("--") ? written : written.toLowerCase();
  if (property === "" || /[\s()]/.test(property)) {
    findings.push(unparsed(place, entry));
    return undefined;
  }
  let value = entry.slice(colon + 1).trim();
  // `#fff!important` with no space is as much a precedence claim as
  // `#fff !important`; a quoted value ends in its quote, so it cannot look like one.
  const important = /!\s*important$/i.exec(value);
  if (important !== null) {
    value = value.slice(0, important.index).trim();
  }
  if (value === "") {
    findings.push(unparsed(place, entry));
    return undefined;
  }
  return { property, value, important: important !== null };
}
