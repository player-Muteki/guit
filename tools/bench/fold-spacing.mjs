// One-off: fold every off-scale spacing length onto the declared 4px-base
// scale, touching only the properties the gate governs. Mirrors the gate's
// parser exactly (same SPACING regex, same comment-stripping, same token
// reader) so the remapping and the check that will judge it cannot disagree.
import { readFileSync, writeFileSync } from "node:fs";

const SCALE = [0.0625, 0.125, 0.25, 0.375, 0.5, 0.75, 1, 1.25, 1.5];
const SPACING = /^(?:margin|padding|gap|row-gap|column-gap)[-\w]*$/;

const MAP = new Map([
  ["0.05", "0.0625"], ["0.1", "0.125"], ["0.15", "0.125"], ["0.2", "0.25"],
  ["0.3", "0.25"], ["0.35", "0.375"], ["0.4", "0.375"], ["0.45", "0.5"],
  ["0.55", "0.5"], ["0.6", "0.5"], ["0.65", "0.75"], ["0.7", "0.75"],
  ["0.8", "0.75"], ["0.9", "1"], ["1.1", "1"],
]);

for (const name of process.argv.slice(2)) {
  let text = readFileSync(name, "utf8");
  const bare = text.replace(/\/\*[\s\S]*?\*\//g, "");
  // Find every spacing declaration span in the *original* text, then rebuild
  // only the value tokens. We work on the original (comment-bearing) text so
  // offsets line up, but we skip declarations whose match fell inside a comment.
  const commentRanges = [...text.matchAll(/\/\*[\s\S]*?\*\//g)].map((m) => [m.index, m.index + m[0].length]);
  const inComment = (i) => commentRanges.some(([a, b]) => i >= a && i < b);

  let changed = 0;
  const out = text.replace(
    /([-a-z]+)\s*:\s*([^;{}]+)/g,
    (whole, prop, value, offset) => {
      const start = offset + whole.length - value.length;
      if (!SPACING.test(prop)) return whole;
      if (inComment(start)) return whole;
      const next = value.replace(
        /(^|[\s/])(\d*\.?\d+)rem\b/g,
        (m, lead, num) => {
          const target = MAP.get(num);
          if (target === undefined) return m;
          changed += 1;
          return `${lead}${target}rem`;
        },
      );
      return whole.replace(value, next);
    },
  );
  writeFileSync(name, out);
  console.log(`${name}: ${changed} lengths folded`);
}