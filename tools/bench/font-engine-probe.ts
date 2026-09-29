// Engine probe for the font preferences: what the panel's own renderer makes of
// the stacks and the rem metrics the settings can change.
//
// The fixture tests check the stack builders and the row-height tokens in Node,
// where there is no font engine. Deciding that a refusal is a refusal belongs
// there; deciding whether the result actually lines a commit object ID up, holds
// mixed Chinese-and-Latin text inside one row and survives a zoom change belongs
// to WebKitGTK, the only engine guit displays through. This asks it.
//
// Run it against the sheet the panel ships, so the tokens measured are the tokens
// shipped:
//
//   webkit-engine-probe.py font-engine-probe.ts src/style.css
//
// Two of the checks below state what this engine does with a family name the host
// has never heard of, rather than what the stack asked for. They are expected to
// fail on a host that behaves differently, and the user agent is printed with the
// results, so a failure there is a fact about a new platform and not a flake.
//
// It is not panel code and nothing in the panel imports it.

import { FILE_ROW_REM, HISTORY_ROW_REM } from "../../app/src/fileModel";
import { MONO_TAIL, UI_TAIL, buildMonoStack, buildUiStack } from "../../app/src/fontStack";
import { GENERIC_MONO, monoAligns, resolveMonoStack } from "../../app/src/fontResolve";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const checks: Check[] = [];

function check(name: string, ok: boolean, detail: unknown): void {
  checks.push({ name, ok, detail: typeof detail === "string" ? detail : JSON.stringify(detail) });
}

const root = document.documentElement;
const saved = { fontSize: root.style.fontSize, ui: root.style.getPropertyValue("--font-ui"), mono: root.style.getPropertyValue("--font-mono") };

/** The root font size the panel runs at, as the engine resolved it. Every rem
 * metric in the stylesheet is a multiple of this one number. */
function rootPx(): number {
  return Number.parseFloat(getComputedStyle(root).fontSize);
}

/** Width per character of a long run, so a check is not fighting the rounding of
 * one glyph. */
function advance(text: string, stack: string, px: number): number {
  const probe = document.createElement("span");
  probe.textContent = text.repeat(40);
  probe.style.position = "absolute";
  probe.style.whiteSpace = "nowrap";
  probe.style.setProperty("font", `${px}px ${stack}`);
  document.body.appendChild(probe);
  const width = probe.getBoundingClientRect().width / 40;
  probe.remove();
  return Math.round(width * 100) / 100;
}

/** The spread between the widest and narrowest of the characters an object ID is
 * made of. Zero means the columns line up. */
const SAMPLE = "0123456789abcdef";

/** How far the advance of one hex character drifts from another. Zero means the
 * object ID column lines up; anything else means it does not, and the character
 * named is the one that gave it away. */
function oidSpread(stack: string): { spread: number; narrow: string; wide: string } {
  const widths = [...SAMPLE].map((one) => [one, advance(one, stack, 12)] as const);
  const least = widths.reduce((a, b) => (b[1] < a[1] ? b : a));
  const most = widths.reduce((a, b) => (b[1] > a[1] ? b : a));
  return {
    spread: Math.round((most[1] - least[1]) * 100) / 100,
    narrow: `${least[0]}:${least[1]}`,
    wide: `${most[0]}:${most[1]}`,
  };
}

/** Rows of pixels the same engine paints the panel with. Two different characters
 * drawing identically means neither was drawn — one is a fallback box for the
 * other, and the resolved font holds no glyph for either. */
function drawn(text: string, stack: string): string {
  const canvas = document.createElement("canvas");
  canvas.width = 48;
  canvas.height = 48;
  const context = canvas.getContext("2d");
  if (context === null) return "no-2d-context";
  context.font = `32px ${stack}`;
  context.textBaseline = "top";
  context.fillStyle = "#000";
  context.fillText(text, 4, 4);
  return Array.from(context.getImageData(0, 0, 48, 48).data)
    .filter((_, one) => one % 4 === 3)
    .join(",");
}

function measuredHeight(className: string): number {
  const row = document.createElement("div");
  row.className = className;
  document.body.appendChild(row);
  const height = row.getBoundingClientRect().height;
  row.remove();
  return height;
}

(globalThis as unknown as Record<string, unknown>).__probe = () => {
  const uiStack = getComputedStyle(root).getPropertyValue("--font-ui").trim();
  const monoStack = getComputedStyle(root).getPropertyValue("--font-mono").trim();

  // Without the shipped sheet every number below is a measurement of nothing.
  check("the shipped sheet is loaded", uiStack.length > 0 && monoStack.length > 0, { uiStack, monoStack });
  if (uiStack.length === 0 || monoStack.length === 0) {
    return JSON.stringify({ engine: navigator.userAgent, checks });
  }

  // The stacks the builders default to are the stacks in the sheet. A default that
  // differs between the two is a panel that changes appearance when a field is
  // cleared.
  check(
    "the authored stacks are the ones in the sheet",
    uiStack === UI_TAIL && monoStack === MONO_TAIL,
    { sheetUi: uiStack, sheetMono: monoStack },
  );

  // A row is the height the model says it is, at the size the engine resolved.
  const start = rootPx();
  const fileRow = measuredHeight("file-row");
  check(
    "a file row measures FILE_ROW_REM times the root font size",
    Math.abs(fileRow - FILE_ROW_REM * start) < 0.5,
    { fileRow, rem: FILE_ROW_REM, rootPx: start },
  );
  const commitRow = measuredHeight("commit-row");
  check(
    "a commit row measures HISTORY_ROW_REM times the root font size",
    Math.abs(commitRow - HISTORY_ROW_REM * start) < 0.5,
    { commitRow, rem: HISTORY_ROW_REM, rootPx: start },
  );

  // Interface zoom: the layout follows one number, and the tokens do not move
  // under it. This is why a hard-coded pixel row height is a bug.
  const zoomed: Record<string, number> = {};
  for (const px of [12, 16, 24]) {
    root.style.fontSize = `${px}px`;
    zoomed[`${px}`] = measuredHeight("file-row");
  }
  check(
    "the row follows the root font size, not a pixel constant",
    [12, 16, 24].every((px) => Math.abs(zoomed[`${px}`] - FILE_ROW_REM * px) < 0.5),
    zoomed,
  );
  root.style.fontSize = `${start}px`;

  // Mixed text must not grow the row: the row height is fixed, so Chinese beside
  // Latin is drawn inside it or clipped, never pushing the list below.
  const row = document.createElement("div");
  row.className = "file-row";
  const label = document.createElement("span");
  label.textContent = "重构 src/index.ts 的提交图";
  row.appendChild(label);
  document.body.appendChild(row);
  const box = label.getBoundingClientRect();
  const rowBox = row.getBoundingClientRect();
  check("mixed Chinese and Latin stays inside one row", Math.abs(rowBox.height - fileRow) < 0.5, {
    row: rowBox.height,
    text: Math.round(box.height * 100) / 100,
    width: Math.round(box.width * 100) / 100,
  });
  check("the mixed text does not wrap to a second line", box.height <= rowBox.height + 0.5, {
    text: box.height,
    row: rowBox.height,
  });
  row.remove();

  // A glyph that is actually drawn rather than a fallback box.
  const distinct = drawn("a", uiStack) !== drawn("b", uiStack);
  check("the drawing comparison can tell two glyphs apart", distinct, "canvas alpha against a and b");
  check(
    "Chinese text resolves to a font that draws it",
    distinct && drawn("中", uiStack) !== drawn("文", uiStack),
    { stack: uiStack },
  );

  // The claim the whole mono setting exists for.
  const generic = oidSpread("monospace");
  check("the generic keyword lines an object ID up", generic.spread === 0, generic);
  const authored = oidSpread(monoStack);
  check(
    "the sheet's own mono default does not, because a name the host lacks is substituted, not skipped",
    authored.spread > 0,
    { stack: monoStack, ...authored, generic: generic.spread },
  );
  const absent = oidSpread(buildMonoStack("Not A Real Family 9x9"));
  check(
    "a family the person typed that this host lacks is substituted too",
    !monoAligns(buildMonoStack("Not A Real Family 9x9")),
    absent,
  );

  // So the panel asks, and the answer is always a stack that lines up — and the
  // apply path is checked through the property it writes, because a builder that is
  // right and a panel that writes the other half of the answer are two different
  // bugs.
  for (const named of ["", "Not A Real Family 9x9", "JetBrains Mono", "Courier New", "inherit", "Liberation Mono"]) {
    const wanted = buildMonoStack(named);
    const resolved = resolveMonoStack(named);
    const label = named === "" ? "no name" : `"${named}"`;
    check(
      `the resolver keeps an object ID aligned for ${label}`,
      monoAligns(resolved.stack) &&
        (resolved.honoured ? resolved.stack === wanted : resolved.stack === GENERIC_MONO),
      { wanted, written: resolved.stack, honoured: resolved.honoured, wantedAligned: monoAligns(wanted) },
    );
    root.style.setProperty("--font-mono", resolved.stack);
    const read = getComputedStyle(root).getPropertyValue("--font-mono").trim();
    check(`the engine draws ${label} from the written property with one width`, read === resolved.stack && oidSpread(read).spread === 0, { read, ...oidSpread(read) });
  }

  // The apply path for the text stacks: what the panel writes is what the engine
  // reads back, so a preview and the applied panel cannot be showing different
  // stacks.
  const written = { "--font-ui": buildUiStack("Noto Sans", "Source Han Sans"), "--font-mono": resolveMonoStack("Liberation Mono").stack };
  for (const [property, value] of Object.entries(written)) {
    root.style.setProperty(property, value);
    const read = getComputedStyle(root).getPropertyValue(property).trim();
    check(`the engine reads back ${property}`, read === value, { wrote: value, read });
  }

  root.style.fontSize = saved.fontSize;
  root.style.setProperty("--font-ui", saved.ui);
  root.style.setProperty("--font-mono", saved.mono);

  return JSON.stringify({ engine: navigator.userAgent, checks });
};
