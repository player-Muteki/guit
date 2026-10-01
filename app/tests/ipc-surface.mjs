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
//
// And a third direction, added when guit became local-only: the commands that
// left the product are pinned as absent. Hiding the button is not removing the
// endpoint — `invoke("push")` from any script in the window would still have
// reached Git with network arguments. So a name on that list may be neither
// registered nor named by the frontend, and this file is where "exited" is
// recorded rather than remembered.

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

  assert.ok(names.length > 40, `only ${names.length} commands parsed; the parser is wrong`);
  const seen = new Set();
  for (const name of names) {
    assert.ok(!seen.has(name), `${name} is registered twice`);
    seen.add(name);
  }
  return names;
}

// Each command's own declaration: its parameter list and its return type. The
// binding rules below are read off the real signature rather than off a list of
// names, because the thing worth catching is a command whose *implementation*
// stopped checking what the frontend still assumes it checks.
//
// Anything that stops looking like `#[tauri::command]` followed by `fn name(` is
// reported instead of skipped: a command that hides from this parser also hides
// from every assertion that uses it.
function commandSignatures() {
  const source = readMain();
  const marker = "#[tauri::command]";
  const signatures = new Map();
  let at = source.indexOf(marker);
  while (at !== -1) {
    const head = /^\s*(?:pub(?:\(crate\))?\s+)?(?:async\s+)?fn\s+([a-z_][a-z0-9_]*)\s*\(/
      .exec(source.slice(at + marker.length, at + marker.length + 200));
    assert.ok(
      head !== null,
      `a #[tauri::command] at offset ${at} is not followed by ` +
        "`fn name(` — this parser cannot see it, so nothing here checks its binding",
    );
    const open = at + marker.length + head[0].length - 1;
    let depth = 0;
    let params = "";
    let i = open;
    for (; i < source.length; i += 1) {
      const char = source[i];
      if (char === "(") depth += 1;
      else if (char === ")") {
        depth -= 1;
        if (depth === 0) { i += 1; break; }
      }
      params += char;
    }
    let returns = "";
    for (; i < source.length; i += 1) {
      if (source[i] === "{") break;
      returns += source[i];
    }
    assert.ok(
      !signatures.has(head[1]),
      `${head[1]} is declared twice; the binding rules can only read one of them`,
    );
    signatures.set(head[1], {
      params: params.replace(/\s+/g, " ").trim(),
      returns: returns.replace(/\s+/g, " ").trim(),
    });
    at = source.indexOf(marker, i);
  }
  assert.ok(signatures.size > 40, `only ${signatures.size} signatures parsed; the parser is wrong`);
  return signatures;
}

function frontendFiles(dir) {  const out = [];
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

// The argument object literal of every `invoke("name", { … })` in the frontend,
// brace-matched so a nested object cannot end the scan early. An invoke with no
// second argument at all reports empty args, which is what a bound command has
// to fail on.
function invokeArgs(name) {
  const out = [];
  const call = new RegExp(`invoke(?:<[^()]*>)?\\(\\s*["']${name}["']\\s*,\\s*`, "g");
  for (const [path, text] of live) {
    for (const match of text.matchAll(call)) {
      const start = match.index + match[0].length;
      if (text[start] !== "{") {
        out.push({ path, args: "" });
        continue;
      }
      let depth = 0;
      let body = "";
      for (let i = start; i < text.length; i += 1) {
        const char = text[i];
        if (char === "{") depth += 1;
        else if (char === "}") {
          depth -= 1;
          if (depth === 0) break;
        }
        body += char;
      }
      out.push({ path, args: body.replace(/\s+/g, " ") });
    }
  }
  return out;
}

// Every one of these could reach the network: cloning, fetching, pulling,
// pushing (plain, forced, publishing a new branch), administering remotes and
// their branches, the credential bridge those operations prompted into, the
// submodule download that clones what it finds uninitialised, and the probe
// that ran a real `git clone` to exercise the transport. guit is local-only,
// so what left the product is the endpoint as well as the entry point — a
// hidden button still leaves `invoke("push")` one keystroke away for anything
// that can run script in the window.
const EXITED_COMMANDS = [
  "clone_repository",
  "cancel_clone",
  "fetch",
  "pull",
  "pull_default",
  "push",
  "publish",
  "force_push",
  "preview_force_push",
  "delete_remote_branch",
  "preview_delete_remote_branch",
  "list_remotes",
  "add_remote",
  "set_remote_url",
  "preview_remove_remote",
  "remove_remote",
  "set_upstream",
  "submit_askpass",
  "submodule_init_update",
  "run_transfer_probe",
];

test("the registry parser sees the real command list", () => {
  const names = registeredCommands();
  assert.ok(names.includes("stage_files"));
  assert.ok(names.includes("list_refs"));
  assert.ok(names.includes("export_diagnostics"));
  // The list is only meaningful if a name can be lost from it silently, so the
  // exited set has to be non-empty and specific before its absence proves
  // anything.
  assert.ok(EXITED_COMMANDS.length >= 20, "the exited set itself has been emptied");
  for (const representative of ["push", "clone_repository", "submit_askpass", "list_remotes"]) {
    assert.ok(EXITED_COMMANDS.includes(representative), `the exited set lost ${representative}`);
  }
});

test("an exited command is not registered, and no frontend source names it", () => {
  const registered = new Set(registeredCommands());
  const stillRegistered = EXITED_COMMANDS.filter((name) => registered.has(name));
  assert.deepEqual(
    stillRegistered,
    [],
    `still callable from the window: ${stillRegistered.join(", ")} — unregister it and remove its implementation`,
  );
  const stillNamed = EXITED_COMMANDS.filter((name) => corpus.includes(`"${name}"`));
  assert.deepEqual(
    stillNamed,
    [],
    `still named by a frontend literal: ${stillNamed.join(", ")} — a view, dialog or background path still asks for it`,
  );
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

// --- what each command is bound to ---
//
// A command that reads Git has to be able to tell whether the answer it is about
// to return still describes the repository on screen. Two clones of one
// repository share a branch name, a head object id and a commit graph, so no
// field drawn from Git can make that decision: the backend stamps an identity of
// its own onto every snapshot and repeats it in every answer, and the numbers
// below are that identity travelling through the interface.
//
// So each registered command has to belong to exactly one of four groups, and
// the group decides what its signature must contain. The fourth group is a
// written list rather than a rule of thumb, because "it obviously does not need
// one" is exactly how an endpoint that reads a repository ends up with no
// answer to give about which repository it read.

// Reads of a repository that is already open: bound by session and by the
// per-domain generation the backend counts, asked with a `context` and answered
// with the same one echoed back.
const BOUND_READS = [
  "history_page",
  "search_repository",
  "commit_files",
  "open_commit_diff",
  "list_refs",
  "show_tag",
  "stash_list",
  "list_worktrees",
  "submodule_status",
];

// Writes and previews: bound by the snapshot they were decided from. The version
// is counted across the whole application rather than per session, so the number
// an old session carried can never be accepted by a new one.
const SNAPSHOT_BOUND = [
  "stage_files",
  "unstage_files",
  "commit_changes",
  "preview_discard",
  "preview_clean",
  "open_external_tool",
  "create_branch",
  "switch_branch",
  "rename_branch",
  "preview_delete_branch",
  "create_tag",
  "preview_delete_tag",
  "stash_save",
  "stash_apply",
  "preview_stash_pop",
  "preview_stash_drop",
  "merge_start",
  "rebase_start",
  "operation_continue",
  "operation_abort",
  "operation_skip",
  "pick_commit",
  "revert_commit",
  "reset",
  "preview_restore",
  "add_worktree",
  "preview_remove_worktree",
  "prune_worktrees",
];

// The confirming half of a destructive operation: bound by the single-use ticket
// the preview handed out, which is removed before anything is checked.
const TICKET_BOUND = [
  "discard_files",
  "clean_files",
  "delete_branch",
  "delete_tag",
  "stash_pop",
  "stash_drop",
  "restore_clean",
  "remove_worktree",
];

// Everything else, listed by why it is exempt: these commands open, close,
// refresh or report on the session rather than read inside one, so the session
// they belong to is the one they are creating or ending. Cancelling a lane and
// saving window geometry carry no repository state at all.
const NOT_SESSION_BOUND = [
  "open_repository",
  "restore_repository",
  "refresh_repository",
  "close_repository",
  "list_recent_repositories",
  "save_window_settings",
  "restore_window_settings",
  "probe_git",
  "probe_external_tools",
  "run_process_probe",
  "cancel_process_probe",
  "cancel_write",
  "cancel_exttool",
  "cancel_search",
  "export_diagnostics",
];

test("the four binding groups cover the registry, and each other", () => {
  const registered = new Set(registeredCommands());
  const declared = [...BOUND_READS, ...SNAPSHOT_BOUND, ...TICKET_BOUND, ...NOT_SESSION_BOUND];
  assert.ok(
    BOUND_READS.length >= 5 && NOT_SESSION_BOUND.length >= 10,
    "a group has been emptied; the coverage check below would pass on nothing",
  );
  const missing = [...registered].filter((name) => !declared.includes(name));
  const unknown = declared.filter((name) => !registered.has(name));
  assert.deepEqual(missing, [], `registered with no declared binding: ${missing.join(", ")}`);
  assert.deepEqual(unknown, [], `declared but not registered: ${unknown.join(", ")}`);
  const seen = new Set();
  for (const name of declared) {
    assert.ok(!seen.has(name), `${name} is declared in two groups at once`);
    seen.add(name);
  }
});

test("a bound read is asked with a context and answers with one", () => {
  const signatures = commandSignatures();
  for (const name of BOUND_READS) {
    const signature = signatures.get(name);
    assert.ok(
      /\bcontext: session::ReadContext\b/.test(signature.params),
      `${name} is a bound read but no longer takes a context: ${signature.params}`,
    );
    assert.ok(
      /->\s*Result<session::SessionRead</.test(signature.returns),
      `${name} is a bound read but does not echo a context in its answer: ${signature.returns}`,
    );
    const calls = invokeArgs(name);
    assert.ok(calls.length > 0, `${name} is registered but no literal invoke names it`);
    for (const call of calls) {
      assert.match(
        call.args,
        /\bcontext:/,
        `${name} is invoked without a context in ${call.path}: { ${call.args} }`,
      );
    }
  }
});

test("a write is bound to a snapshot, a confirmation to a ticket", () => {
  const signatures = commandSignatures();
  for (const name of SNAPSHOT_BOUND) {
    assert.match(
      signatures.get(name).params,
      /\bsnapshot_version: u64\b/,
      `${name} is a write but stopped checking the snapshot it came from`,
    );
  }
  for (const name of TICKET_BOUND) {
    assert.match(
      signatures.get(name).params,
      /\bnonce: String\b/,
      `${name} is destructive but no longer consumes a single-use ticket`,
    );
  }
});

test("an exempt command does not quietly take on a per-repository read", () => {
  const signatures = commandSignatures();
  for (const name of NOT_SESSION_BOUND) {
    const signature = signatures.get(name);
    assert.ok(
      !/\bcontext: session::ReadContext\b/.test(signature.params),
      `${name} is on the exempt list but now reads as a session; move it to the bound reads`,
    );
  }
});
