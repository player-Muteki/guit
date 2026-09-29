// The report a refused theme fragment becomes.
//
// Loading this file at all is the first check: `themeFindings.ts` carries an
// `import type` of a shape from `themeCssModel.ts`, and Node must erase it. The
// rest is about the three failures this layer exists to prevent — a reason with no
// words, a fragment with two hundred refusals, and a screen that changed under someone
// with nothing said about why.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { reviewThemeCss } from "../src/themeCssModel.ts";
import { FINDING_LIMIT, THEME_RECOVERY_KEYS, describeFindings, describeFinding, describeTheme, describeThemeNotice } from "../src/themeFindings.ts";

const style = (selector, ...declarations) => ({
  kind: "style",
  selector,
  declarations: declarations.map((pair) => ({ property: pair[0], value: pair[1] })),
});

// Kinds that speak about a whole rule rather than about one name inside it.
const RULE_LEVEL = new Set(["empty", "unparsed"]);

// One fragment that fails for every reason the reviewer has. Each refusal below is
// the cheapest one that reaches that reason, so a new reason with no case in this
// fragment shows up as a missing row in the set assertion.
const everything = reviewThemeCss([
  style(".badge", ["background-image", "url(https://fonts.example/x.woff2)"]),
  style(".rows", ["width", "40px"]),
  style(".banner", ["display", "none"]),
  style(":root", ["--row-height", "80"]),
  style(".card", ["background", "#1b1b20"]),
  style(".file-row", ["cursor", "pointer"]),
  {
    kind: "style",
    selector: ".head",
    declarations: [{ property: "color", value: "#fff", important: true }],
  },
  { kind: "style", selector: "[data-owner-id]", declarations: [{ property: "color", value: "red" }] },
  {
    kind: "media",
    selector: "(prefers-color-scheme: dark)",
    nested: [{ kind: "style", selector: ".badge", declarations: [{ property: "content", value: '"x"' }] }],
  },
]);

const declaredReasons = () => {
  const source = readFileSync(new URL("../src/themeCssModel.ts", import.meta.url), "utf8");
  const clause = /because:\s*([\s\S]*?);/.exec(source);
  assert.ok(clause, "the finding type must declare its reasons as a closed union");
  return [...clause[1].matchAll(/"([a-z-]+)"/g)].map((one) => one[1]);
};

// `not-readable` is not a decision of the subset: it is what the engine says when
// `themeCss.ts` hands it an accepted name and value and the value does not survive
// the write. No fragment reaches it through the pure review, and no fixture should
// pretend one does.
const ENGINE_ONLY = new Set(["not-readable"]);

const tableReasons = () => {
  const source = readFileSync(new URL("../src/themeFindings.ts", import.meta.url), "utf8");
  const block = /const REASONS[^{]*\{([\s\S]*?)\n\}/.exec(source);
  assert.ok(block, "the wording table must be a literal object");
  return [...block[1].matchAll(/^ {2}"?([a-z-]+)"?:/gm)].map((one) => one[1]);
};

test("the reasons the reviewer can give, the reasons the table has words for and the reasons a fragment can reach are one set", () => {
  const declared = new Set(declaredReasons());
  const table = new Set(tableReasons());
  const reached = new Set(
    everything.findings.filter((one) => !RULE_LEVEL.has(one.kind)).map((one) => one.because),
  );
  assert.deepEqual([...table].sort(), [...declared].sort());
  const reachable = new Set([...reached, ...ENGINE_ONLY]);
  assert.deepEqual([...reachable].sort(), [...declared].sort());
  for (const reason of ENGINE_ONLY) assert.equal(declared.has(reason), true, `${reason} must stay declared`);
  for (const finding of everything.findings) {
    assert.equal(ENGINE_ONLY.has(finding.because), false, `the pure review reached ${finding.because}`);
  }
});

test("every reason renders as a sentence, not a blank or a placeholder", () => {
  for (const finding of everything.findings) {
    const row = describeFinding(finding);
    const reason = row.slice(row.lastIndexOf("—") + 1).trim();
    assert.ok(reason.length > 8, `${finding.because} must say something: ${JSON.stringify(row)}`);
    for (const missing of ["undefined", "unknown", "null"]) {
      assert.ok(!row.toLowerCase().includes(missing), `${missing} leaked into ${JSON.stringify(row)}`);
    }
  }
});

test("a row names where the fragment failed and what was refused there", () => {
  const width = everything.findings.find((one) => one.item === "width");
  assert.equal(describeFinding(width), ".rows: width — moves what the panel measures its rows by");
  const token = everything.findings.find((one) => one.item === "--row-height");
  assert.equal(describeFinding(token), ":root: --row-height — moves what the panel measures its rows by");
  const shorthand = everything.findings.find((one) => one.item === "background");
  assert.equal(
    describeFinding(shorthand),
    ".card: background — can set more than it says, so write the specific property instead",
  );
});

test("a refusal that repeats the place it belongs to is not said twice", () => {
  const selector = everything.findings.find((one) => one.kind === "selector");
  assert.equal(selector.item, selector.at);
  assert.equal(describeFinding(selector), "[data-owner-id] — would take a control you need to get back here");
});

test("a rule that kept nothing is reported about the rule, not about a name", () => {
  const review = reviewThemeCss([style(".rows", ["width", "40px"])]);
  assert.deepEqual(describeFindings(review.findings, 10).rows, [
    ".rows: width — moves what the panel measures its rows by",
    ".rows — nothing in it is a colour or a typeface, so nothing was kept",
  ]);
});

test("text the engine would not parse is reported as one line about the fragment", () => {
  assert.equal(
    describeFinding({ kind: "unparsed", at: "the fragment", item: "the pasted text", because: "not-a-theme" }),
    "the fragment — could not be read as a stylesheet, so none of it was kept",
  );
});

test("a value quoted into a row is bounded by the review, not by the fragment", () => {
  const rowFor = (zeros) => {
    const review = reviewThemeCss([style(".badge", ["background-image", `url(https://e.test/${"0".repeat(zeros)}`])]);
    return describeFinding(review.findings.find((one) => one.because === "network"));
  };
  assert.equal(rowFor(4000), rowFor(30), "a longer value must not make a longer row");
  assert.ok(!/0{40}/.test(rowFor(4000)), rowFor(4000));
  assert.ok(rowFor(4000).length < 200, `the row is ${rowFor(4000).length} chars for any fragment`);
});

test("a repeated statement is reported once", () => {
  const review = reviewThemeCss([
    style(".a", ["width", "1px"]),
    style(".a", ["width", "2px"]),
  ]);
  assert.equal(review.findings.length, 4);
  const report = describeFindings(review.findings, 10);
  assert.deepEqual(report.rows, [
    ".a: width — moves what the panel measures its rows by",
    ".a — nothing in it is a colour or a typeface, so nothing was kept",
  ]);
  assert.equal(report.omitted, 0);
});

test("a long fragment is answered with a bounded number of lines and a count of the rest", () => {
  const findings = [];
  for (let i = 0; i < 200; i += 1) {
    const review = reviewThemeCss([style(`.c${i}`, ["width", `${i}px`])]);
    findings.push(...review.findings);
  }
  assert.equal(findings.length, 400);
  const report = describeFindings(findings);
  assert.equal(report.rows.length, FINDING_LIMIT);
  assert.equal(report.omitted, 400 - FINDING_LIMIT);
});

test("the report keeps the order the fragment failed in", () => {
  const review = reviewThemeCss([
    style(".first", ["width", "1px"]),
    style(".second", ["display", "none"]),
    style(".third", ["cursor", "pointer"]),
  ]);
  assert.deepEqual(describeFindings(review.findings, 10).rows, [
    ".first: width — moves what the panel measures its rows by",
    ".first — nothing in it is a colour or a typeface, so nothing was kept",
    ".second: display — would take a control you need to get back here",
    ".second — nothing in it is a colour or a typeface, so nothing was kept",
    ".third: cursor — is neither a colour nor a typeface",
    ".third — nothing in it is a colour or a typeface, so nothing was kept",
  ]);
});

test("a clean fragment is reported as no lines and no omissions", () => {
  assert.deepEqual(describeFindings([]), { rows: [], omitted: 0 });
});

test("the rows are shipped text", () => {
  const rows = describeFindings(everything.findings, 100).rows;
  assert.ok(rows.length > 4);
  for (const row of rows) {
    assert.doesNotMatch(row, /\bM[0-9](-\d{1,2})?\b/, row);
    assert.doesNotMatch(row, /\bplan\/[a-z0-9-]+\.md\b/i, row);
    assert.doesNotMatch(row, /\bdecision \d+\b/i, row);
  }
});

// The notices: one sentence per way the screen can change under a theme. These are
// read *after* something has already gone wrong, which is when a missing or vague
// sentence costs the person the way out.

/** The codes the life cycle can decide to report, read from its own type. A code with
 * no sentence here would render as an empty row at exactly the moment the panel has
 * done something on the person's behalf, so the list is not repeated in this file. */
const NOTICE_CODES = (() => {
  const source = readFileSync(new URL("../src/themeLifecycle.ts", import.meta.url), "utf8");
  const union = source.match(/export type ThemeNotice =([\s\S]*?);/);
  assert.ok(union, "themeLifecycle.ts must name its notices in one union");
  const codes = [...union[1].matchAll(/"([a-z-]+)"/g)].map(([, code]) => code);
  assert.ok(codes.length >= 4, "the union was not read as written");
  return codes;
})();

test("every notice the life cycle can give has a sentence", () => {
  for (const code of NOTICE_CODES) {
    const sentence = describeThemeNotice(code);
    assert.notEqual(sentence, null, `"${code}" has no sentence`);
    assert.match(sentence, /[.]$/s, `"${code}" is not a finished sentence`);
    assert.doesNotMatch(sentence, /\bM[0-9](-\d{1,2})?\b|\bplan\/[a-z0-9-]+\.md\b|\bdecision \d+\b/i, code);
  }
});

test("a change with nothing to say is no text at all", () => {
  // The person's own saved theme loaded, and the notice is not for that. A reassurance
  // nobody asked for teaches them to ignore the row that carries the others.
  assert.equal(describeThemeNotice(null), null);
  assert.equal(describeTheme({ notice: null, persisted: true, findings: { rows: [], omitted: 0 } }), "");
});

test("the sentence about hidden controls gives the keys that still work", () => {
  // The one failure where the page may be unusable: whatever the row is written into,
  // the escape has to be in it.
  const sentence = describeThemeNotice("hidden-controls");
  assert.ok(sentence.includes(THEME_RECOVERY_KEYS), sentence);
  assert.match(sentence, /off/i, sentence);
});

test("a report says what it decided, what it left out, and what will survive", () => {
  const report = describeTheme({
    notice: "reverted",
    persisted: false,
    findings: { rows: ["a row"], omitted: 3 },
  });
  assert.ok(report.startsWith("Nothing in it could be drawn"), report);
  assert.ok(report.includes("3 more rules were refused than these lines show."), report);
  assert.ok(report.includes("guit could not save this, so the next start will not do it."), report);
  assert.ok(
    describeTheme({ notice: "confirmed", persisted: true, findings: { rows: [], omitted: 1 } })
      .includes("1 more rule was refused"),
    "one line held back is named in the singular",
  );
});
