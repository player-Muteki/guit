// Every registered command has a caller; every literal call has a command.
//
// The Tauri command layer is the one place where the two halves of guit are
// joined by a string. `invoke("stage_files")` is not checked by the compiler
// against `fn stage_files`, and a rename on either side compiles perfectly
// and fails at the moment the user clicks. With ~80 commands that is ~80
// chances to ship a button that quietly does nothing, and there is no other
// test standing behind it: the command bodies are mechanical
// `spawn_blocking + state + map_err` boilerplate, so the interesting part of
// a command is exactly the part a line-coverage number cannot see.
//
// Two dead endpoints were already found by hand this way — a window-settings
// reader and a credential report that the backend called internally and no
// view ever asked for. Both were removed rather than allowlisted: an endpoint
// with no caller is surface, and surface is what this file exists to keep
// minimal.
//
// The reverse direction matters just as much. A view that invokes a name the
// backend does not register fails at runtime with a bare "command not found",
// which is the least actionable message the app can produce.

import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..");
const mainRs = join(appRoot, "src-tauri", "src", "main.rs");
const frontendRoot = join(appRoot, "src");

function readMain() {
  return readFileSync(mainRs, "utf8");
}

// The registry is one macro argument list. Anything that stops looking like
// that — a reformat, a second handler, a `#[cfg]` block — has to fail here
// rather than quietly yield an empty list, because an empty list makes every
// assertion below pass.
function registeredCommands() {
  const source = readMain();
  const start = source.indexOf("generate_handler![");
  assert.notEqual(start, -1, "main.rs no longer registers commands via generate_handler![]");

  const rest = source.slice(start + "generate_handler![".length);
  const end = rest.indexOf("])");
  assert.notEqual(end, -1, "the generate_handler![] argument list is not terminated by `])`");

  const body = rest.slice(0, end);
  const names = [];
  for (const raw of body.split("\n")) {
    const line = raw.replace(/\/\/.*$/, "").trim();
    if (line === "") continue;
    const entry = /^([a-z_][a-z0-9_]*)\s*,?$/.exec(line);
    assert.ok(
      entry !== null,
      `unrecognised entry in generate_handler![]: ${JSON.stringify(raw)} — update this parser`,
    );
    names.push(entry[1]);
  }

  assert.ok(names.length > 50, `only ${names.length} commands parsed; the parser is wrong`);
  const seen = new Set();
  for (const name of names) {
    assert.ok(!seen.has(name), `${name} is registered twice`);
    seen.add(name);
  }
  return names;
}

function frontendFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...frontendFiles(path));
    else if (extname(entry.name) === ".ts") out.push(path);
  }
  return out;
}

// Comments are stripped on purpose. A command name that survives only in a
// `//` comment satisfies a naive grep and satisfies nothing at runtime, which
// is the exact failure this gate exists to catch. Block comments are handled
// first so a `//` inside one does not cut the line short.
function liveSource(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

const files = frontendFiles(frontendRoot);
const live = new Map(files.map((path) => [path, liveSource(readFileSync(path, "utf8"))]));
const corpus = [...live.values()].join("\n");

test("the registry parser sees the real command list", () => {
  const names = registeredCommands();
  assert.ok(names.includes("stage_files"));
  assert.ok(names.includes("preview_force_push"));
  assert.ok(names.includes("export_diagnostics"));
});

test("every registered command is named somewhere in the frontend", () => {
  const orphans = registeredCommands().filter(
    (name) => !corpus.includes(`"${name}"`) && !corpus.includes(`'${name}'`),
  );
  assert.deepEqual(
    orphans,
    [],
    `registered with no caller: ${orphans.join(", ")} — either the view is missing ` +
      "or the endpoint should not be registered",
  );
});

test("no frontend invoke names a command the backend does not register", () => {
  const known = new Set(registeredCommands());
  const unknown = new Map();
  // Only a literal first argument is checked. A view that threads the name
  // through a variable is resolved by the test above, which requires the
  // literal to exist somewhere; a dynamic name that no literal backs is
  // outside what a text scan can decide.
  const call = /invoke(?:<[^>()]*>)?\(\s*(["'])([a-z_][a-z0-9_]*)\1/g;
  for (const [path, text] of live) {
    for (const match of text.matchAll(call)) {
      const name = match[2];
      if (!known.has(name) && !unknown.has(name)) unknown.set(name, path);
    }
  }
  assert.deepEqual(
    [...unknown].map(([name, path]) => `${name} (${path})`),
    [],
    "the frontend invokes commands that are not registered",
  );
});

test("the registry is registered once", () => {
  const count = readMain().split("generate_handler![").length - 1;
  assert.equal(count, 1, "more than one command registry; this test only reads the first");
});
