// Nothing a user pastes, names or stores is ever given to the document as markup
// or as code.
//
// This is one of the failures the project treats as release-blocking rather than
// untidy: the panel reads paths, names and text out of repositories a stranger may
// have written, and the settings page takes stylesheet text from whoever is using
// it. A renderer that parses that text as HTML, or runs it, makes the repository
// and the fragment into code the app executes. So the sinks are scanned for across
// every source file, in this suite that runs before a build, because the safe
// alternative — `textContent`, `createTextNode`, and the engine's own stylesheet
// parser — is only safe while nobody reaches past it.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const FORBIDDEN = [
  { pattern: /\binnerHTML\b/, why: "parses a string as markup" },
  { pattern: /\bouterHTML\b/, why: "reads a node back as markup and writes it elsewhere" },
  { pattern: /\binsertAdjacentHTML\s*\(/, why: "parses a string as markup at a position" },
  { pattern: /\bdocument\.write\s*\(/, why: "parses a string into the live document" },
  { pattern: /\beval\s*\(/, why: "runs a string as script" },
  { pattern: /\bnew\s+Function\s*\(/, why: "runs a string as script" },
];

function sources(dir, into = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    // `join` rather than string concatenation, and a real filesystem path
    // rather than `URL.pathname`: on Windows the latter is `/D:/a/...`, which
    // readdirSync rejects with a doubled drive prefix.
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sources(path, into);
    else if (entry.name.endsWith(".ts")) into.push(path);
  }
  return into;
}

test("no source file gives the document a string to parse", () => {
  const hits = [];
  for (const file of sources(fileURLToPath(new URL("../src", import.meta.url)))) {
    readFileSync(file, "utf8").split("\n").forEach((line, index) => {
      for (const { pattern, why } of FORBIDDEN) {
        if (pattern.test(line)) hits.push(`${file}:${index + 1} ${pattern.source} — ${why}`);
      }
    });
  }
  assert.deepEqual(hits, [], "a sink that parses user text is a feature the panel does not have");
});
