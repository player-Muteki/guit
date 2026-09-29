// The one question a code font has to survive: does this engine line an object ID
// up?
//
// `fontStack.ts` states the fallback the panel asks for, and the ask is reasonable
// — name a family, keep a generic keyword at the end. What the renderer actually
// does with it is not reasonable, and was measured rather than reasoned about: on
// WebKitGTK a family name that is not installed does not step aside for the next
// entry. The font configuration hands back some other face for it, the list stops
// there, and the `monospace` at the end is never consulted. The face it handed back
// for the panel's own default stack was proportional — an object ID's `a` and `f`
// measured 6.756px and 3.858px apart at 12px, where the generic keyword measured
// one advance for every character.
//
// So the panel does not assume the tail works. It asks the engine to draw a short
// object ID with the stack it is about to write, and if the columns do not line up
// it writes the generic keyword instead, which the engine has to honour. The cost of
// a name this host has never heard of is then the look, exactly as it was meant to
// be; the alignment is not paid for it.
//
// This reads the layout, so it is not importable from `node --test` and the pure
// builders stay in `fontStack.ts`. `tools/bench/font-engine-probe.ts` runs it on the
// engine and reports which answer came out.

import { buildMonoStack } from "./fontStack";

/** The value the engine is required to resolve to a fixed-pitch face. */
const GENERIC_MONO = "monospace";

/** Every character an object ID is made of. A stack that gives these one advance
 * lines up the whole column, which is the only reason the panel sets them in a
 * monospace font at all. Ten of them are not enough to tell: the digits of the face
 * the panel's own default resolved to were all the same width, and it was `f` that
 * came out 3.86px against 6.66px. */
const SAMPLE = "0123456789abcdef";

/** Width per character of a run long enough that the renderer's rounding of the
 * total does not decide the answer. */
function advance(text: string, stack: string): number {
  const probe = document.createElement("span");
  probe.textContent = text.repeat(8);
  probe.style.position = "absolute";
  probe.style.whiteSpace = "nowrap";
  probe.style.setProperty("font", `12px ${stack}`);
  document.body.appendChild(probe);
  const width = probe.getBoundingClientRect().width / 8;
  probe.remove();
  return width;
}

/** Whether the engine would draw an object ID with one advance per character under
 * this stack. Compared with a tolerance rather than to zero: the renderer rounds,
 * and a stack that is aligned does not drift by a thousandth of a pixel either. */
export function monoAligns(stack: string): boolean {
  const widths = [...SAMPLE].map((one) => advance(one, stack));
  return Math.max(...widths) - Math.min(...widths) < 0.05;
}

/** The mono stack to write for the family the user named — the stack they asked
 * for when this engine lines it up, and the generic keyword when it does not.
 *
 * One measurement per apply, on a handful of glyphs, never per row and never per
 * frame: this runs when a family field changes or the panel starts up, and the
 * answer decides a stylesheet value rather than a layout. */
export function resolveMonoStack(named: string): string {
  const wanted = buildMonoStack(named);
  return monoAligns(wanted) ? wanted : GENERIC_MONO;
}
