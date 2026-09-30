// The changes area's two wiring promises, gated over the sources.
//
// Both are facts about where code sits rather than what it computes, so they
// cannot be checked where the models are pure: the commit draft is a textarea a
// document owns, and a row's action menu is built inside a virtual list that only
// exists on screen. Each is a way the panel could quietly start lying about what
// it will do to your repository — a draft that survives a switch of repository is
// a message about A that commits into B, and a "Delete" on an untracked row that
// asks the whole-repository clean removes files nobody clicked.
//
// The rules those two depend on are tested as computation, not as text:
// `file-model.mjs` for which row a verb may be offered for and how a renewed
// ticket turns names back into ids, and the Rust suite for what a bound ticket
// agrees to remove.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");

const changes = source("views/changes.ts");
const preview = source("dialogs/preview.ts");

// --- the commit draft ---

test("a new repository session clears the commit draft, a refresh does not", () => {
  // The draft is keyed to the session the backend minted, which moves on every
  // open and never on a refresh. A guard on any other field — head, branch,
  // version — would either wipe a draft on a routine refresh or keep one across
  // a switch of repository.
  const guard = changes.match(
    /const sessionId = snapshot\?\.sessionId \?\? null;\s*if \(sessionId !== draftSession\)[\s\S]*?\n\s*\}/,
  );
  assert.ok(guard, "render() must compare the session the draft was written for against the session on screen");
  assert.match(guard[0], /commitMessage\.value = "";/, "a draft from another repository is cleared, not kept");
  assert.match(guard[0], /commitAmend\.checked = false;/, "and the amend tick with it — it belongs to the other HEAD");
  // Nothing else in the view may write the box: every other path that touches it
  // is a refresh, and a refresh must leave the user's text alone.
  const writes = changes.match(/commitMessage\.value\s*=/g) ?? [];
  assert.equal(writes.length, 2, "the draft is written only by the session guard and by a commit that succeeded");
  assert.match(changes, /if \(result\.outcome === "success"\)[\s\S]{0,120}commitMessage\.value = "";/,
    "a refused or failed commit keeps the text, which is input the user owns");
});

test("the session identity is declared as one that never moves on a refresh", () => {
  // The clearing rule is only safe because of what `sessionId` is. If that
  // promise in the type ever changed, this gate is where it has to be re-read.
  const types = source("types.ts");
  const snapshot = types.match(/export type SnapshotView = \{[\s\S]*?\n\};/);
  assert.ok(snapshot, "the snapshot view model is one declared block");
  assert.match(snapshot[0], /sessionId: number;/, "and it carries the session it was published under");
  assert.match(snapshot[0], /never on a refresh/, "and says so where the field is declared");
});

// --- a row's removal verb ---

test("an untracked row is offered a delete, and it asks for that path alone", () => {
  // `Delete` must be the scoped clean: a file ids list holding this row's id.
  const scoped = changes.match(
    /if \(cleanEligible\(file\)\)\s*\{[\s\S]*?requestClean\(\[file\.id\]\), danger: true/,
  );
  assert.ok(scoped, "an untracked row's menu must offer the delete that names only itself");
  assert.match(scoped[0], /danger: true/, "a removal is marked as one");
  // The whole-group entry asks for everything untracked instead, which is the
  // one shape a row cannot ask for.
  assert.match(changes, /button\("Clean…", \(\) => requestClean\(\[\]\)/,
    "the untracked group heading asks for the repository-wide clean");
  // An untracked file is never a discard: it has nothing to revert to.
  assert.doesNotMatch(changes, /if \(file\.untracked\)[\s\S]{0,80}requestDiscard/,
    "a discard must not be offered for an untracked path");
});

test("both clean shapes hand the live file list to the ticket that needs it", () => {
  // A renewal re-addresses a scoped ticket by name, and names only mean
  // something against the file list they were read from.
  const request = changes.match(/const requestClean = \(fileIds: number\[\]\): void => \{[\s\S]*?\};/);
  assert.ok(request, "the view owns one requestClean");
  assert.match(request[0], /preview\.request\("clean", \{ fileIds \}, currentFiles\)/,
    "it passes the snapshot's rows along, or a renewal has nothing to match names against");
});

test("a renewed clean restates its own shape rather than guessing from the list", () => {
  // One untracked file in the repository and one file clicked both come back as
  // a single name; the ticket has to remember which promise was made.
  assert.match(preview, /pending\.allUntracked \? \[\] : idsForNames\(files, pending\.names, cleanEligible\)/,
    "the whole-repository promise renews as no file ids, a scoped one renews by its names");
  // And the shape is remembered across the renewal, not recomputed from it.
  assert.match(preview, /case "clean": return \{ kind: "clean", names, dropped, nonce, allUntracked: pending\.allUntracked \};/);
  // The ticket's shape comes from what was asked, not from what Git returned:
  // a scoped clean of three files that only two of them owns is still scoped.
  assert.match(preview, /allUntracked: !Array\.isArray\(args\.fileIds\) \|\| args\.fileIds\.length === 0/);
});

test("a clean that skips a path says why in a clean's words", () => {
  // The scoped ask can name a tracked file, an ignored one or a repository of
  // its own. The dialog has one fallback line, and it explains a skip as a
  // work-tree fact — true of a discard, false of a clean.
  assert.match(preview, /clean: \{[\s\S]*?droppedLabel: "[^"]*"/,
    "the clean copy must carry its own skipped-rows label");
  const label = preview.match(/clean: \{[\s\S]*?droppedLabel: "([^"]*)"/)[1];
  assert.doesNotMatch(label, /work-tree|working copy/i, "a clean's skip is not a work-tree statement");
});

test("the verbs of one row are decided in one place", () => {
  // The menu offers a verb by a predicate and the renewal re-derives ids by the
  // same one. Two copies of that rule is how a delete starts asking about a file
  // the row never offered.
  for (const name of ["discardEligible", "cleanEligible", "idsForNames"]) {
    assert.match(preview, new RegExp(`import \\{[^}]*\\b${name}\\b[^}]*\\} from "../fileModel"`),
      `preview.ts must take ${name} from the model`);
    assert.doesNotMatch(changes, new RegExp(`(function|const) ${name} =? ?\\(?file`),
      `changes.ts must not keep its own ${name}`);
  }
  const model = source("fileModel.ts");
  for (const name of ["discardEligible", "cleanEligible", "idsForNames"]) {
    assert.match(model, new RegExp(`export function ${name}\\(`), `${name} must live in the pure model`);
  }
});
