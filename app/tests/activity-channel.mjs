// The activity channel is two halves joined by a string and a JSON shape.
//
// Nothing compiles across the boundary: `emit("activity-updated", view)` in Rust
// and `listen("activity-updated")` in TypeScript agree only because somebody
// remembered, and a rename on either side produces an application that runs,
// looks healthy and never shows an age. This file is the remembering, in both
// directions:
//
//   1. every event the backend pushes is listened to, and every event the
//      frontend listens for is pushed by something;
//   2. the field names and the enum words of the payload are the same on both
//      sides, derived from the Rust declaration rather than restated here.
//
// (2) is why this reads `activity.rs` instead of carrying a list: a second
// description of a shape can agree with the first by accident and disagree by
// silence, which is the failure mode the file exists to catch.
//
// The last group of assertions is the session rule in `state.ts`. The age of the
// newest file is not drawn from Git, so a value for one repository is
// indistinguishable by content from a value for the next one — two clones of one
// project have the same newest file and the same name for it. Only the session
// the backend measured under tells them apart, and the frontend consumes that
// identity rather than minting its own.

import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..");
const backendRoot = join(appRoot, "src-tauri", "src");
const frontendRoot = join(appRoot, "src");
const activityRs = join(backendRoot, "activity.rs");

// `//` and `///` comments name events without carrying them, so a scan that
// leaves them in passes for the wrong reason.
function liveSource(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function sources(dir, extension) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(path, extension));
    else if (extname(entry.name) === extension) out.push([path, liveSource(readFileSync(path, "utf8"))]);
  }
  return out;
}

// `emit` with a wrapped argument list is the common shape here, so `\s` spans
// the newline rather than the regex being written per line.
const EMIT = /\.emit\(\s*"([a-z0-9][a-z0-9-]*)"/g;
// `listen` is always generic (`listen<T>("name", …)`), and the generic argument
// never contains parentheses.
const LISTEN = /listen(?:<[^()]*>)?\(\s*"([a-z0-9][a-z0-9-]*)"/g;

const namesMatched = (pattern, corpus) => {
  const found = new Set();
  for (const match of corpus.matchAll(pattern)) found.add(match[1]);
  return found;
};

const sorted = (set) => [...set].sort();

test("pushed events and listened events are the same names", () => {
  const pushed = namesMatched(
    EMIT,
    sources(backendRoot, ".rs").map(([, text]) => text).join("\n"),
  );
  const listened = namesMatched(
    LISTEN,
    sources(frontendRoot, ".ts").map(([, text]) => text).join("\n"),
  );
  // The set has to be able to be wrong before being empty is worth anything.
  assert.ok(pushed.has("repo-refreshed"), "the parser lost the snapshot push");
  assert.ok(pushed.size >= 2, `only ${pushed.size} push parsed; the parser is wrong`);
  assert.deepEqual(
    sorted(pushed),
    sorted(listened),
    "an event is pushed with no listener, or listened for with no pusher",
  );
});

// --- the payload, read off the Rust declaration ---

// The body of one `pub struct` / `pub enum`, up to its matching brace.
function rustBody(source, header) {
  const start = source.indexOf(header);
  assert.notEqual(start, -1, `${header} is no longer in activity.rs`);
  const open = source.indexOf("{", start + header.length);
  let depth = 0;
  let body = "";
  for (let i = open; i < source.length; i += 1) {
    const char = source[i];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
    body += char;
  }
  return body;
}

const toCamel = (name) =>
  name.replace(/_([a-z0-9])/g, (_, char) => char.toUpperCase());

// serde's `rename_all = "camelCase"` on the field, and the same attribute on the
// enum turns `Ready` into `ready` and `ReadFailed` into `readFailed`.
const toLowerCamel = (name) => name.charAt(0).toLowerCase() + name.slice(1);

const rustFields = () =>
  [...rustBody(readFileSync(activityRs, "utf8"), "pub struct ActivityView").matchAll(/pub\s+([a-z_][a-z0-9_]*)\s*:/g)]
    .map((match) => toCamel(match[1]));

const rustVariants = (header) =>
  [...rustBody(readFileSync(activityRs, "utf8"), header).matchAll(/^\s*([A-Z][A-Za-z0-9]*)\s*,?$/gm)]
    .map((match) => toLowerCamel(match[1]));

// The TypeScript side is a type alias of object-literal shape: field names at
// their own indentation, and unions of string literals.
const typesTs = () => liveSource(readFileSync(join(frontendRoot, "types.ts"), "utf8"));

function tsFields(name) {
  const source = typesTs();
  const start = source.indexOf(`export type ${name} = {`);
  assert.notEqual(start, -1, `types.ts no longer declares ${name}`);
  const end = source.indexOf("};", start);
  return [...source.slice(start, end).matchAll(/^ {2}([a-zA-Z][a-zA-Z0-9]*)\??:/gm)].map(
    (match) => match[1],
  );
}

function tsUnion(name) {
  const source = typesTs();
  const start = source.indexOf(`export type ${name} =`);
  assert.notEqual(start, -1, `types.ts no longer declares ${name}`);
  const end = source.indexOf(";", start);
  return [...source.slice(start, end).matchAll(/"([a-zA-Z][a-zA-Z0-9]*)"/g)].map((match) => match[1]);
}

test("the activity payload has the same fields on both sides", () => {
  const declared = rustFields();
  assert.ok(declared.length >= 7, `only ${declared.length} fields parsed; the parser is wrong`);
  assert.ok(declared.includes("latestModifiedAt"), "the parser dropped a multi-word field");
  assert.deepEqual(
    sorted(declared),
    sorted(tsFields("ActivityView")),
    "the pushed shape and the rendered shape are not the same shape",
  );
});

test("the state and reason words are the same words on both sides", () => {
  for (const [header, type] of [
    ["pub enum ActivityState", "ActivityState"],
    ["pub enum ActivityReason", "ActivityReason"],
  ]) {
    const declared = rustVariants(header);
    assert.ok(
      declared.length >= 2,
      `only ${declared.length} variants parsed for ${header} — the parser is wrong`,
    );
    // A silent parser reads both sides as empty and every comparison below
    // passes; the variant check above is the only thing standing between that
    // and a renamed enum word.
    assert.ok(
      tsUnion(type).length === declared.length,
      `${type} has ${tsUnion(type).length} words in types.ts, activity.rs declares ${declared.length}`,
    );
    assert.deepEqual(
      sorted(declared),
      sorted(tsUnion(type)),
      `${type} is spelled differently on the two sides of the channel`,
    );
  }
});

// --- the session rule ---

const { applyActivity, applySnapshot, currentActivity } = await import("../src/state.ts");

const snapshot = (sessionId, version) => ({
  version,
  sessionId,
  historyGeneration: 0,
  refsGeneration: 0,
  repo: { openPath: "/tmp/r", root: "/tmp/r", gitDir: "/tmp/r/.git", bare: false, linkedWorktree: false },
  branch: { name: "main", headState: "branch", oid: "a".repeat(40), upstream: null, ahead: null, behind: null },
  files: [],
  operation: null,
});

const activity = (overrides) => ({
  sessionId: 1,
  generation: 1,
  state: "ready",
  latestModifiedAt: 1_700_000_000_000,
  observedAt: 1_700_000_060_000,
  displayName: "notes.txt",
  reason: null,
  ...overrides,
});

test("a value is held only for the session that is on screen", () => {
  applySnapshot(null);
  assert.equal(applyActivity(activity({ sessionId: 4 })), false, "held with no session at all");
  assert.equal(currentActivity(), null);
  applySnapshot(snapshot(4, 1));
  assert.equal(applyActivity(activity({ sessionId: 4, generation: 1 })), true);
  assert.equal(currentActivity()?.generation, 1);
  assert.equal(
    applyActivity(activity({ sessionId: 5, generation: 2 })),
    false,
    "another session's measurement replaced what is on screen",
  );
  assert.equal(currentActivity()?.generation, 1);
});

test("a clear is accepted whatever is showing", () => {
  applySnapshot(snapshot(4, 2));
  applyActivity(activity({ sessionId: 4, generation: 3 }));
  assert.equal(applyActivity(activity({ sessionId: null, generation: 0, state: "unavailable", latestModifiedAt: null, displayName: null, reason: "sessionClosed" })), true);
  assert.equal(currentActivity(), null);
  // A clear with nothing to clear is still an answer, not a rejected message:
  // refusing it would make the close of a session depend on what it held.
  assert.equal(applyActivity(activity({ sessionId: null })), true);
});

test("a lower generation of the same session does not replace the answer", () => {
  applySnapshot(snapshot(6, 3));
  applyActivity(activity({ sessionId: 6, generation: 5 }));
  assert.equal(applyActivity(activity({ sessionId: 6, generation: 4, displayName: "old.txt" })), false);
  assert.equal(currentActivity()?.displayName, "notes.txt");
  assert.equal(applyActivity(activity({ sessionId: 6, generation: 6, displayName: "new.txt" })), true);
  assert.equal(currentActivity()?.displayName, "new.txt");
});

// The failure this whole binding exists to prevent: reopening a repository —
// or opening a second clone of one — restarts the measurement count, and the
// new session's first answer is smaller than the number still held for the old
// one. Comparing generations across sessions would then refuse every value from
// the new repository forever, showing the previous repository's age on screen.
test("a new session restarts the count instead of being outranked by the old one", () => {
  applySnapshot(snapshot(7, 4));
  applyActivity(activity({ sessionId: 7, generation: 9 }));
  applySnapshot(null);
  applySnapshot(snapshot(8, 5));
  assert.equal(currentActivity(), null, "a closed session still owned the age line");
  assert.equal(
    applyActivity(activity({ sessionId: 8, generation: 1, displayName: "other.txt" })),
    true,
    "the first measurement of a new session lost to a number from the last one",
  );
  assert.equal(currentActivity()?.displayName, "other.txt");
});

test("closing the session drops the age without waiting for a push", () => {
  applySnapshot(snapshot(9, 6));
  applyActivity(activity({ sessionId: 9 }));
  assert.notEqual(currentActivity(), null);
  applySnapshot(null);
  assert.equal(
    currentActivity(),
    null,
    "the panel kept an age for a repository it is no longer looking at",
  );
  // An older snapshot never replaces a newer one, and must not clear anything
  // that the newer one owns either.
  applySnapshot(snapshot(10, 7));
  applyActivity(activity({ sessionId: 10 }));
  applySnapshot(snapshot(10, 1));
  assert.notEqual(currentActivity(), null, "a refused snapshot dropped the activity line");
});
