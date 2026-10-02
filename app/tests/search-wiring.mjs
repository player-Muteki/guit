// The unified search's wiring promises, gated over the sources.
//
// Each of these is a fact about where code sits rather than what it computes, and
// each is a way the panel could quietly start saying something untrue: a search
// field that reaches a write lane would make G03's "no Git side effects" a claim
// nobody checked, a second input box that filters the graph would redraw a
// branch as the handful of commits that matched, and a debounce written in the
// view instead of the model would hide the longest part of the read budget from
// the number that is supposed to include it.
//
// The behaviour these shapes make possible — which answer is still an answer,
// what the footer may claim, how a match is drawn — is tested as computation in
// `search-model.mjs`. There is no DOM here to test against.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");

const search = source("views/search.ts");
const history = source("views/history.ts");
const panel = source("views/mainPanel.ts");
const main = source("main.ts");
const css = source("style.css");

// --- the one read, and no other ---

test("the search field asks one bound read, cancels at most, and reaches nothing else", () => {
  // The import of `invoke` is a bare word, so anything that calls it is
  // immediately followed by its generic argument or by the name itself.
  const calls = search.match(/\binvoke[<(]/g) ?? [];
  // One bound read, plus the cancellation that stops a scan the reader has
  // stopped waiting for. A cancellation is neither a read nor a write: it names
  // a question by the two numbers that identify it and changes no repository
  // state. Anything a third call would be is something this view may not do.
  assert.equal(calls.length, 2, "the view owns one read and at most the cancellation");
  const ask = search.match(/invoke<SessionRead<SearchPage>>\("search_repository", \{[\s\S]*?\}\)/);
  assert.ok(ask, "and one of them is the search read");
  assert.match(search, /invoke\("cancel_search", \{ sessionId: lane\.sessionId, queryId: lane\.queryId \}\)/,
    "the other is the cancellation, naming the question by the pair the lane is keyed on");
  // The bound-read gate in `ipc-surface.mjs` reads the frontend literals for
  // every command it classifies; this is the same rule stated where a search
  // answer could otherwise be read as belonging to no session at all.
  assert.match(ask[0], /context: asked,/, "asked with the context the screen is on");
  // A write carries the snapshot version it was bound to. Nothing in this file
  // may mention one, because nothing in this file may write.
  assert.doesNotMatch(search, /snapshot_version|snapshotVersion/, "a search never names a snapshot to write against");
});

test("an emptied field and a closing session stop the scan, not just the next question", () => {
  // A fresh query displaces the one before it by itself — the backend stops the
  // lane when a newer question claims it. What nothing displaces is a scan whose
  // question the reader has taken away: an emptied field, a closed repository and
  // a view that goes away. Without a cancellation in those three, the walk under
  // way is run to its window's end for an answer nobody is waiting for.
  assert.match(search, /const stopScan = \(\): void => \{[\s\S]*?invoke\("cancel_search"/,
    "the view has one way to stop a scan");
  const callers = search.match(/stopScan\(\)/g) ?? [];
  // Three call sites: the emptied field, the closed session, and the disposal.
  assert.equal(callers.length, 3, "stopScan is called from the emptied field, the closed session and the disposal");
});

test("the layer is its own, not the shell's single overlay slot", () => {
  // `registerOverlay` stores one content and one `onShow`, and the branch
  // picker holds that slot. Two page-level floats sharing it would turn the
  // escape stack's "menu, then overlay, then dialog" into a sentence about a
  // layer that is not there.
  assert.doesNotMatch(search, /registerOverlay|escapeStack|openMenu/, "the view opens nothing the shell owns");
  const layer = css.match(/\.search-results \{[^}]*\}/);
  assert.ok(layer, "the layer is styled");
  assert.match(layer[0], /z-index: 40/, "at the same elevation a menu is, because it is the same kind of thing");
  // A bare vh here is caught by the responsive gate; what is checked here is
  // that the height is a token at all, so a short window has an answer for it.
  assert.match(layer[0], /max-height: var\(--search-cap\)/, "capped by a token, so a short window restates it");
});

// --- where it sits ---

test("the field is a region of the Main page, not a fourth tab and not the app bar", () => {
  // The app bar's row is measured per zoom step by stage G's probes; adding a
  // flexible input to it would re-measure that whole ladder to fit a control
  // that only ever means something while a repository is open.
  assert.match(
    panel,
    /export function createMainPanel\(\s*search: HTMLElement,\s*changes: HTMLElement,\s*history: HTMLElement,\s*activity\?: HTMLElement,?\s*\)/,
  );
  assert.match(panel, /class: "main-toolbar".*\[search, activity\]/);
  assert.match(panel, /el\("section", \{ class: "main-panel" \}, \[toolbar, changes, splitter, history\]\)/,
    "the search and activity toolbar precedes the regions whose height is adjustable");
  assert.match(main, /createMainPanel\(search\.element, changes\.element, history\.element, changes\.activityElement\)/);
  // It is chrome of the panel, not a page: the panel is still what is registered.
  assert.doesNotMatch(main, /registerView\(search/, "the search view is never registered as a view of its own");
  // And it goes away with the session rather than sitting empty above it.
  assert.match(search, /element\.hidden = snapshot === null;/, "no session, no field");
});

// --- timing belongs to the model ---

test("the wait before a scan is asked for is the model's number", () => {
  // The read budget counts from the keystroke. A wait written into the view
  // would let the panel meet it by spending 400ms of silence no measurement
  // attributes to anything, so the number lives where a test can read it.
  assert.doesNotMatch(search, /SEARCH_DEBOUNCE_MS/, "the view does not repeat the wait it is timed by");
  assert.match(search, /typing = typed\(field\.value, composing, now\(\)\)/, "it asks the model what the field now means");
  assert.match(search, /}, Math\.max\(0, state\.askAt - now\(\)\)\);/, "and arms its timer at the deadline it was given");
});

test("a composition is one question, and none of its pieces is sent", () => {
  const start = search.match(/addEventListener\("compositionstart", \(\) => \{[\s\S]*?\}\);/);
  assert.ok(start, "the view listens for a composition opening");
  assert.match(start[0], /composing = true;/);
  assert.doesNotMatch(start[0], /\binvoke|void send\(/, "opening one asks nothing");
  const end = search.match(/addEventListener\("compositionend", \(\) => \{[\s\S]*?\}\);/);
  assert.ok(end, "and it listens for one ending");
  assert.match(end[0], /composing = false;/);
  assert.match(end[0], /onInput\(\);/, "the text that landed is fed back as an ordinary keystroke, which restarts the count");
  // The only path that sends a new question is the armed timer.
  assert.match(search, /void send\(query, 0, true\);/);
  assert.equal(search.match(/send\([^)]*, true\)/g)?.length, 1, "one route asks a fresh question");
});

// --- picking, and what the graph may become ---

test("a picked hit asks the graph to show it and decides nothing about how", () => {
  assert.match(search, /deps\.revealCommit\(oid\);/);
  // Which of the two routes a commit takes — scroll to a row already drawn, or
  // read the page that starts at it — needs the graph's own row list, so only
  // the history view may ask the model. The search view cannot, and would guess.
  assert.doesNotMatch(search, /locateCommit/, "the search never locates anything in the graph itself");
  // Neither view keeps a second list of rows: the rows a page carries are the
  // rows it draws, and there is no filtered copy of the history anywhere.
  assert.doesNotMatch(search, /\.visible\b|filterCommits/, "and never touches the rows below it");
  assert.doesNotMatch(history, /\bvisible\s*[:=]|filterCommits/,
    "the graph has no filtered second list to draw");
  const reveal = history.match(/const reveal = \(oid: string\): RevealRoute => \{[\s\S]*?\n  \};/);
  assert.ok(reveal, "the history view owns one reveal");
  assert.match(reveal[0], /locateCommit\(oid, commits\.map\(\(commit\) => commit\.oid\)\)/,
    "against the oids it has actually drawn, which are the ones it loaded");
  assert.doesNotMatch(reveal[0], /filterCommits/, "a reveal filters nothing");
});

test("an anchored page says it is not the branch, and leaves a way back", () => {
  // The scan walks by recency and the graph is laid out topologically, so an old
  // hit has no row to scroll to: the honest move is to read the page that starts
  // at it. Those rows are that commit's ancestry, and a head line that still
  // showed only the branch name would be describing a different history.
  assert.match(history, /oid: anchored,/, "the page is read from the anchor, the parameter Git was given in stage D");
  const notice = history.match(/const renderAnchor = \(\): void => \{[\s\S]*?\n  \};/);
  assert.ok(notice, "one function decides what the head line claims about the anchor");
  assert.match(notice[0], /not the branch head\./);
  assert.match(notice[0], /anchorClear\.hidden = !shown;/, "the way back appears with the claim, not before it");
  assert.match(history, /button\("Branch head"/);
  // Every other route to a new page starts from the head again.
  const sync = history.match(/const sync = \(\): void => \{[\s\S]*?\n  \};/);
  assert.ok(sync, "the view owns one sync");
  assert.match(sync[0], /anchorOid = null;/, "a refresh is the branch's own history again");
});

// --- the one field, and the one key that reaches it ---

test("the page has one search field, and the box that filtered the graph is gone", () => {
  // The outline counts one input box for *which commit*. The branch picker's
  // filter asks a different question of a list it already has in memory, so it
  // is not a second field of this kind — but the three areas of Main are, and
  // only one of them may hold a box.
  for (const path of ["views/changes.ts", "views/history.ts", "views/mainPanel.ts"]) {
    assert.doesNotMatch(source(path), /type: "search"/, `${path} must not build a second search field`);
  }
  assert.match(search, /type: "search"/, "the one that exists is the unified field");
  // The filter itself, and the list it produced, are not merely unused here.
  const model = source("historyModel.ts");
  assert.doesNotMatch(model, /filterCommits|commitMatches|FindQuery/,
    "the graph's model offers no filtering at all");
  assert.doesNotMatch(history, /find-mod|find-step|history-find|find-count/,
    "nor does the view still build the box, its two toggles or its two steps");
  assert.doesNotMatch(css, /\.history-find|\.find-count|\.btn-quiet\.active/,
    "and nothing is left styled for a box that no longer exists — the toggles " +
      "were `.btn-quiet.active`, and that rule only ever had this box to style");
});

test("one key reaches the field from anywhere on the page, and never from inside a box", () => {
  // A shortcut that only works while the list holds focus is a shortcut the
  // reader has to be in the right place to know about, so the listener sits on
  // the window — where the recovery chord for a bad theme already sits.
  const slash = main.match(/event\.key !== "\/"[\s\S]*?search\.focusField\(\);/);
  assert.ok(slash, "the window answers `/` with the field");
  assert.match(slash[0], /!isSessionActive\(\) \|\| activeView\(\) !== "main"/,
    "it answers only where the field is, and only with a repository open");
  assert.match(slash[0], /closest\("input, textarea, select"\)/,
    "and a `/` inside a box is text the reader is writing, not a request to leave it");
  // The key is bare, and every chord above it is modified: two handlers, no
  // overlap, and neither one reaching into the other's key.
  assert.match(main, /if \(!\(event\.ctrlKey \|\| event\.metaKey\) \|\| event\.altKey\) return;/);
  assert.doesNotMatch(history, /case "\/"/, "the list no longer owns the key");
});

test("the layer closes on its own terms and not on a repaint", () => {
  // Two flags, because one cannot do both jobs: what the reader asked for, and
  // whether there is anything to show. A single `open` recomputed by a paint
  // would re-open a layer that Escape had just closed.
  assert.match(search, /let wanted = false;/);
  assert.match(search, /results\.hidden = !\(wanted && shown\)/);
  const escape = search.match(/case "Escape":[\s\S]*?\n      default:/);
  assert.ok(escape, "the field answers Escape");
  assert.match(escape[0], /if \(!results\.hidden\)/, "only while the layer is up");
  assert.match(escape[0], /event\.stopPropagation\(\);/, "and it stops there — the layer is the topmost thing this page drew");
});
