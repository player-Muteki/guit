// The development schedule is not a user-facing concept.
//
// guit was built in numbered rounds, and the labels of those rounds leaked
// into the artifacts people actually read: a tooltip that quoted a round
// number instead of what the button does, a capability description naming an
// early probe, changelog prose that describes a schedule rather than a
// behaviour. Those rounds are over and their definitions are no longer in the
// repository, so a label that survives is now a citation to nothing — and it
// was never worth reading in the first place.
//
// This scans what ships: the documents, the packaged metadata, the frontend
// source and the backend source. Comments are included on purpose; a comment
// that only makes sense next to a deleted plan file is a comment that
// misleads the next reader.
//
// It also scans `tauri.conf.json`, because the bundle's `shortDescription` and
// `longDescription` reach the .deb metadata and whatever package manager reads
// it — user-facing text that lives outside `app/src/` and so was missed when
// the READMEs changed.

import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");

const SCHEDULE_LABELS = [
  // M7, M7-03, M6-11: a round number, optionally a task within it.
  { pattern: /\bM[0-9](?:-[0-9]{1,2})?\b/g, name: "milestone label" },
  // Citations into the development plan, which is no longer shipped.
  { pattern: /plan\/[\w.-]+/g, name: "plan file citation" },
  { pattern: /\bdecision \d+/gi, name: "plan decision citation" },
];

// Claims the project has measured and does not make. Each one was true-sounding
// prose that the numbers did not support, so it was retired from the shipped
// text — and retired claims creep back, which is what this catches.
//
// Only the phrase is forbidden, never the bare English or Chinese word.
// "lightweight" and "轻量" name a real Git object (a lightweight tag), and this
// repository legitimately says both; "low-resource" and "低占用" are only ever
// a claim about how much memory the panel takes.
//
// A changelog has to be able to name the wording it retired, so a phrase quoted
// in prose is excused: the record may say the panel used to read
// "A low-resource Git client", but nothing may assert it.
//
// The test is a real word before the opening quote on the same line — that is
// prose quoting an example. A string literal is not: `text: "A low-resource…"`
// and `"shortDescription": "low-resource…"` are the claim itself wearing quotes,
// and the punctuation in front of them (`:` or `,`) must not read as prose. The
// character class therefore excludes punctuation, and requiring a word also
// closes the dodge of parking "retired" next to the phrase.
const PROSE_QUOTE = /[A-Za-z0-9]\s+["“][^"”\n]*?(?:low[- ]resource|低占用)/;

const RETIRED_CLAIMS = [
  { pattern: /low[- ]resource/gi, name: "retired claim: low-resource" },
  { pattern: /低占用/g, name: "retired claim: 低占用" },
];

// An icon is SVG path data, and a path starts with a move-to command: `M2 4h5`
// reads as a round label from here. Only an array whose first entry is shaped
// like path data is excused; a sentence that quotes a label is not.
const PATH_DATA_TABLE = /^\s*\w+: \["M[0-9]/;

function* filesIn(directory, extensions) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* filesIn(path, extensions);
    else if (extensions.some((extension) => entry.name.endsWith(extension))) yield path;
  }
}

// The documents are whatever the repository ships today: a directory that is
// not there has no text to name the schedule, and the rule is about text, not
// about one fixed path surviving forever.
const documents = (directory) =>
  existsSync(directory)
    ? readdirSync(directory).filter((name) => name.endsWith(".md")).map((name) => join(directory, name))
    : [];

const targets = [
  ...["README.md", "README-en.md", "README-zh.md", "CHANGELOG.md"].map((name) => join(root, name)),
  ...documents(join(root, "docs")),
  ...filesIn(join(root, "app/src"), [".ts", ".css", ".html"]),
  ...filesIn(join(root, "app/src-tauri/src"), [".rs"]),
  ...filesIn(join(root, "app/src-tauri/capabilities"), [".json"]),
  // The packaged descriptions a user reads without installing anything.
  join(root, "app/src-tauri/tauri.conf.json"),
];

test("shipped text names behaviour, never the development schedule", () => {
  const offenders = [];
  for (const path of targets) {
    const lines = readFileSync(path, "utf8").split("\n");
    lines.forEach((line, index) => {
      if (PATH_DATA_TABLE.test(line)) return;
      for (const { pattern, name } of SCHEDULE_LABELS) {
        pattern.lastIndex = 0;
        if (!pattern.test(line)) continue;
        offenders.push(
          `${path.slice(root.length + 1)}:${index + 1} ${name}: ${line.trim().slice(0, 90)}`,
        );
      }
    });
  }
  assert.deepEqual(offenders, [], `${offenders.length} schedule labels remain:\n${offenders.join("\n")}`);
});

test("shipped text makes no claim the measurements do not support", () => {
  const offenders = [];
  for (const path of targets) {
    const lines = readFileSync(path, "utf8").split("\n");
    lines.forEach((line, index) => {
      if (PROSE_QUOTE.test(line)) return;
      for (const { pattern, name } of RETIRED_CLAIMS) {
        pattern.lastIndex = 0;
        if (!pattern.test(line)) continue;
        offenders.push(
          `${path.slice(root.length + 1)}:${index + 1} ${name}: ${line.trim().slice(0, 90)}`,
        );
      }
    });
  }
  assert.deepEqual(
    offenders,
    [],
    `${offenders.length} retired claims remain:\n${offenders.join("\n")}`,
  );
});

test("the scanned surface covers the packaged descriptions too", () => {
  // A scan that quietly stops covering a file is how a claim drifts into the
  // one surface nobody re-reads: the .deb description and the welcome screen
  // both kept saying "low-resource" after the READMEs had stopped.
  const scanned = targets.map((path) => path.slice(root.length + 1));
  for (const required of [
    "app/src-tauri/tauri.conf.json",
    "README.md",
    "README-en.md",
    "README-zh.md",
    "CHANGELOG.md",
  ]) {
    assert.ok(scanned.includes(required), `${required} is no longer scanned`);
  }
});
