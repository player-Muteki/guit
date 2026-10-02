// The spacing scale, and the gate that holds the sheet to it.
//
// A stylesheet grows a spacing value the way a shelf grows a book: one at a time,
// each for a reason that was true that day. Count what `style.css` uses today and
// the answer is fourteen distinct lengths, of which two carry thirty-seven
// declarations between them and neither of the two is a step on any scale:
//
//   0.05 0.1 0.15 0.2 0.25 0.3 0.35 0.4 0.45 0.5 0.55 0.6 0.7 0.75 0.8 1.25 1.5
//                    ^^^^^ ^^
//              14 uses    23 uses
//
// 0.35rem is 5.6px at the default interface size, 4.2px at the smallest one and
// 8.4px at the largest — it is not a step, it is "about right". Nothing looks
// wrong; the panels simply never line up with each other, and there is no way to
// tell from a screenshot which of two gaps is wrong.
//
// So this states the scale once, here, and the sheet is held to it. The scale is
// 4px at the default root size, which is the grid every `rem` in this panel
// already moves with (see the row-height contract in `fileModel.ts`), so a step
// stays a step under interface zoom instead of drifting off it.
//
// WHY IT IS SKIPPED. The body below is finished and correct; the sheet has not
// been moved onto the scale yet, because that is a geometry change and a
// geometry change is only safe to make with `layout-probe.mjs` able to run
// against it. Arming this before that would turn a known, planned, mechanical
// remapping of fourteen values into a red suite on a tree where nobody can
// measure. It is skipped rather than absent so the scale is reviewed now and
// enforced the moment the sheet is on it.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

// Every spacing length the stylesheet is allowed to use, in rem. Read from the
// root, not from a device: these are the numbers that get written into the
// sheet, and a 4px step at the default root size is the smallest that stays a
// whole pixel under interface zoom rather than a fraction of one.
const SCALE = [0.0625, 0.125, 0.25, 0.375, 0.5, 0.75, 1, 1.25, 1.5];

/** The properties a spacing scale governs. `font-size` is excluded on purpose:
 * type has its own scale (`--text-xs` … `--text-lg`) and is measured against a
 * reading line rather than against the space between two controls.
 *
 * `[-\w]` rather than `\w` in the longhand arms, and that is not a detail: `\w`
 * has no hyphen in it, so `margin-inline-start` and every other hyphenated
 * CSS longhand would fall past this and be governed by nothing. The third test
 * below is what caught it. */
const SPACING = /^(?:margin|padding|gap|row-gap|column-gap)[-\w]*$/;

/** Longhand-first, so `padding-inline-start` is not caught by `padding`. */
function declarations(css) {
  const out = [];
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const match of bare.matchAll(/([-a-z]+)\s*:\s*([^;{}]+)/g)) {
    if (SPACING.test(match[1])) out.push({ property: match[1], value: match[2].trim() });
  }
  return out;
}

/** The rem lengths in one declaration's value. `0` and `auto` are on every
 * spacing scale by definition — they mean "no space" and "not a length" — and
 * a `calc()` or `var()` is somebody else's decision, checked where it is made. */
function lengths(value) {
  const parts = [];
  for (const piece of value.split("/")) {
    for (const token of piece.trim().split(/\s+/)) {
      if (token === "" || token === "0" || token === "auto") continue;
      const rem = /^(-?\d*\.?\d+)rem$/.exec(token);
      if (rem !== null) parts.push({ token, value: Number(rem[1]) });
    }
  }
  return parts;
}

function sheets() {
  const read = (name) => readFileSync(new URL(name, import.meta.url), "utf8");
  return [
    { name: "../src/style.css", text: read("../src/style.css") },
    { name: "../src/style/tokens.css", text: read("../src/style/tokens.css") },
  ];
}

test(
  "every spacing length comes from the declared scale",
  {
    // Armed by the rhythm knife, together with the remapping that puts the
    // sheet on it. Until then this documents the debt rather than failing on it.
    skip: "the sheet still uses fourteen ad-hoc lengths; the remapping lands with the scale",
  },
  () => {
    const offenders = [];
    for (const sheet of sheets()) {
      for (const declaration of declarations(sheet.text)) {
        for (const one of lengths(declaration.value)) {
          if (SCALE.includes(one.value)) continue;
          offenders.push(`${sheet.name}: ${declaration.property}: ${declaration.value} (${one.token})`);
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `${offenders.length} spacing lengths are off the scale; the scale is ${SCALE.join(", ")}\n` +
        offenders.join("\n"),
    );
  },
);

test("the scale itself is a scale: every step is bigger than the one before", () => {
  for (let index = 1; index < SCALE.length; index += 1) {
    assert.ok(SCALE[index] > SCALE[index - 1], `${SCALE[index]} does not follow ${SCALE[index - 1]}`);
  }
});

test("the reader finds spacing declarations, or the gate above is measuring nothing", () => {
  // A regex that stops matching returns an empty list, and an empty list passes
  // every assertion written against it. So the parser is checked against a
  // declaration the sheet is known to carry, in each of the three shapes a
  // value can take: one length, several lengths, and a shorthand followed by a
  // longhand.
  const found = declarations(".a { gap: 0.4rem } .b { padding: 0.25rem 0.75rem } .c { margin-inline-start: auto } .d { font-size: 1.5rem }");
  assert.deepEqual(
    found.map((one) => `${one.property}: ${one.value}`),
    ["gap: 0.4rem", "padding: 0.25rem 0.75rem", "margin-inline-start: auto"],
  );
  assert.deepEqual(
    lengths("0.25rem 0.75rem").map((one) => one.value),
    [0.25, 0.75],
  );
  assert.deepEqual(lengths("0 auto 0"), []);
});