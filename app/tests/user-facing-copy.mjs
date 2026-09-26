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

import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync } from "node:fs";
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

const targets = [
  ...["README.md", "README-en.md", "README-zh.md", "CHANGELOG.md"].map((name) => join(root, name)),
  ...readdirSync(join(root, "docs"))
    .filter((name) => name.endsWith(".md"))
    .map((name) => join(root, "docs", name)),
  ...filesIn(join(root, "app/src"), [".ts", ".css", ".html"]),
  ...filesIn(join(root, "app/src-tauri/src"), [".rs"]),
  ...filesIn(join(root, "app/src-tauri/capabilities"), [".json"]),
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
