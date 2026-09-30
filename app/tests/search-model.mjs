import assert from "node:assert/strict";
import test from "node:test";
import {
  bestHit,
  canAskAgain,
  closedLane,
  dropReason,
  fieldText,
  hasRows,
  highlight,
  isSettled,
  locateCommit,
  locateRef,
  mergePage,
  messageParts,
  nextQueryId,
  nothingMatched,
  otherFields,
  outcomeOf,
  refsUsable,
  segments,
  unansweredNames,
  STOP_SCAN_CAP,
} from "../src/searchModel.ts";

// A full object id, because every offset the model carries describes a record
// the backend read, not a string this file invented.
const oid = (letter) => letter.repeat(40);
const HEAD = oid("a");
const OTHER = oid("b");

const commitHit = (id, overrides = {}) => ({
  oid: id,
  message: "Refactor the graph lane",
  subjectEndBytes: 23,
  subjectEndUnits: 23,
  authorName: "Kys",
  commitDate: "2026-09-29",
  offset: 0,
  hits: [],
  ...overrides,
});

const refHit = (name, overrides = {}) => ({
  kind: "branch",
  name,
  commitOid: HEAD,
  head: false,
  reachedFromHead: true,
  tier: "prefix",
  fragments: [{ byteStart: 0, byteEnd: name.length, unitStart: 0, unitEnd: name.length }],
  ...overrides,
});

const window = (overrides = {}) => ({
  cursor: 0,
  scanned: 1000,
  complete: false,
  stoppedBy: null,
  nextCursor: 1000,
  hitsTruncated: false,
  commits: [],
  refs: [],
  ...overrides,
});

const page = (overrides = {}) => ({
  queryId: 1,
  head: HEAD,
  refsGeneration: 3,
  window: window(),
  ...overrides,
});

// The echo, not the request: an answer carries the context it was bound under.
const read = (sessionId, generation, value) => ({ context: { sessionId, generation }, value });

const graphContext = (sessionId, generation) => ({ sessionId, generation });

// A search whose first window has come back, already holding one row.
const answered = (sessionId, queryId, overrides = {}) => {
  const lane = { sessionId, queryId };
  const asked = graphContext(sessionId, 7);
  const result = mergePage(null, lane, asked, read(sessionId, 7, page({ queryId, ...overrides })));
  return { lane, asked, result: result.result };
};

test("a new session restarts the query numbering, one session counts on", () => {
  const first = nextQueryId(closedLane(1), 1);
  assert.equal(first.queryId, 1);
  const second = nextQueryId(first.lane, 1);
  assert.equal(second.queryId, 2);
  // Opening another repository must not inherit the first one's count: the
  // backend keys its lane on the pair, so a second session starting at 1 is the
  // only numbering that outranks a scan still walking the first repository.
  const other = nextQueryId(second.lane, 2);
  assert.equal(other.queryId, 1);
  assert.equal(other.lane.sessionId, 2);
});

test("an answer to a question the reader replaced is dropped", () => {
  const { lane, asked } = answered(1, 5);
  const late = dropReason(lane, asked, read(1, 7, page({ queryId: 4 })));
  assert.equal(late, "query");
  assert.equal(dropReason(lane, asked, read(1, 7, page({ queryId: 5 }))), null);
});

test("an answer from another repository session is dropped", () => {
  const { lane, asked } = answered(1, 2);
  // Two clones of one project agree on the head and every commit, so nothing in
  // the rows says which repository they came from. Only the session does.
  assert.equal(dropReason(lane, asked, read(9, 7, page({ queryId: 2 }))), "session");
});

test("an answer whose graph generation moved is dropped, not failed", () => {
  const { lane, asked } = answered(1, 2);
  // The panel mirrors what the backend already refuses: a read bound to one
  // generation that arrives after another has been published has no screen left
  // to be drawn on.
  assert.equal(dropReason(lane, asked, read(1, 8, page({ queryId: 2 }))), "generation");
  assert.equal(dropReason(lane, asked, read(1, 7, page({ queryId: 2 }))), null);
});

test("the second window extends the first instead of replacing it", () => {
  const sessionId = 1;
  const lane = { sessionId, queryId: 3 };
  const asked = graphContext(sessionId, 7);
  const started = mergePage(
    null,
    lane,
    asked,
    read(
      sessionId,
      7,
      page({
        queryId: 3,
        window: window({ cursor: 0, scanned: 1000, nextCursor: 1000, commits: [commitHit(HEAD)], refs: [refHit("main")] }),
      }),
    ),
  ).result;
  const extended = mergePage(
    started,
    lane,
    asked,
    read(
      sessionId,
      7,
      page({
        queryId: 3,
        refsGeneration: 9,
        head: OTHER,
        window: window({
          cursor: 1000,
          scanned: 40,
          complete: true,
          nextCursor: null,
          commits: [commitHit(OTHER, { offset: 1040 })],
        }),
      }),
    ),
  ).result;
  assert.equal(extended.scanned, 1040);
  assert.deepEqual(
    extended.commits.map((commit) => commit.oid),
    [HEAD, OTHER],
  );
  // Names come from the first window only, so the second leaves them alone.
  assert.equal(extended.refs.length, 1);
  assert.equal(extended.complete, true);
  assert.equal(extended.nextCursor, null);
  // The head and the names generation belong to the whole search, so the answer
  // keeps the ones it started with rather than adopting a continuation's.
  assert.equal(extended.head, HEAD);
  assert.equal(extended.refsGeneration, 3);
});

test("one result answers one question, so two queries never share rows", () => {
  const first = answered(1, 2, { window: window({ commits: [commitHit(HEAD)] }) });
  // The reader typed again and the lane moved to query 3; the view still holds
  // the rows it drew for query 2. The page that arrives is wanted — it matches
  // the lane — and it must not be merged into an answer to the previous
  // question, because the two rows would then be one list of two searches.
  const third = nextQueryId(first.lane, 1);
  const merged = mergePage(
    first.result,
    third.lane,
    graphContext(1, 7),
    read(1, 7, page({ queryId: 3, window: window({ commits: [commitHit(OTHER)] }) })),
  );
  assert.equal(merged.rejected, "window");
  assert.equal(merged.result.queryId, 2);
  assert.deepEqual(
    merged.result.commits.map((commit) => commit.oid),
    [HEAD],
  );
});

test("a window that dropped matches keeps saying so after a quieter one", () => {
  const { lane, asked, result } = answered(1, 1, {
    window: window({ hitsTruncated: true, commits: [commitHit(HEAD)] }),
  });
  const second = mergePage(
    result,
    lane,
    asked,
    read(1, 7, page({ queryId: 1, window: window({ hitsTruncated: false }) })),
  ).result;
  assert.equal(second.hitsTruncated, true);
});

test("only a finished scan with no rows may be worded as nothing matching", () => {
  const empty = (overrides) => answered(1, 1, overrides).result;

  // A query nothing in the first window matches is not an empty answer: the
  // history has not been covered yet.
  assert.equal(nothingMatched(empty({ window: window({ scanned: 0, nextCursor: 1000 }) })), false);
  assert.equal(canAskAgain(empty({ window: window({ scanned: 0, nextCursor: 1000 }) })), true);
  assert.equal(nothingMatched(empty({ window: window({ complete: true, scanned: 0, nextCursor: null }) })), true);

  // Reaching the ceiling is its own answer, and the only one that names why.
  const capped = empty({
    window: window({ scanned: 100000, stoppedBy: STOP_SCAN_CAP, nextCursor: null }),
  });
  assert.equal(nothingMatched(capped), false);
  assert.equal(canAskAgain(capped), false);
  assert.equal(isSettled(capped), true);
  assert.equal(capped.stoppedBy, STOP_SCAN_CAP);
  assert.equal(capped.scanned, 100000);

  // A completed scan that found rows is not a nothing-matching answer either.
  const found = answered(1, 1, {
    window: window({ complete: true, nextCursor: null, commits: [commitHit(HEAD)] }),
  }).result;
  assert.equal(nothingMatched(found), false);
  assert.equal(hasRows(found), true);
  assert.equal(isSettled(found), true);
});

test("an answer with nothing merged yet has no rows to draw", () => {
  assert.equal(hasRows(null), false);
  assert.equal(hasRows(answered(1, 1).result), false);
  assert.equal(
    hasRows(answered(1, 1, { window: window({ refs: [refHit("main")] }) }).result),
    true,
  );
});

test("names older than the screen are dropped while the commits stay", () => {
  const result = answered(
    1,
    1,
    {
      refsGeneration: 4,
      window: window({ refs: [refHit("main")], commits: [commitHit(HEAD)] }),
    },
  ).result;
  assert.equal(refsUsable(result, 4), true);
  // A branch renamed mid-scan: the generation was read before the listing, so
  // this answer looks older than it is, and the safe reading is to drop the
  // names rather than merge in a branch that has since moved.
  assert.equal(refsUsable(result, 5), false);
  // The commits are bound to the graph generation by the read's own context, not
  // to this number, so a stale listing costs a row of names and no history.
  assert.equal(result.commits.length, 1);
  assert.equal(result.refs.length, 1);
});

test("a name the probe budget never reached is not an answered name", () => {
  const result = answered(
    1,
    1,
    { window: window({ refs: [refHit("tag-1", { reachedFromHead: null }), refHit("main")] }) },
  ).result;
  assert.equal(unansweredNames(result), 1);
});

test("a hit locates by identity, never by the scan's offset", () => {
  const loaded = [HEAD, OTHER];
  assert.deepEqual(locateCommit(OTHER, loaded), { kind: "loaded", index: 1 });
  assert.deepEqual(locateCommit(oid("c"), loaded), { kind: "history", oid: oid("c") });
  // The scan walks history by recency and the graph is laid out topologically, so
  // a search offset counts records of one walk and not rows of the other. The
  // model is not handed the offset at all: the object id is the only fact the two
  // walks share, and a commit that is already drawn needs no read whatever its
  // offset says.
  const hit = commitHit(OTHER, { offset: 900 });
  assert.deepEqual(locateCommit(hit.oid, loaded), { kind: "loaded", index: 1 });
});

test("a name on no commit is not offered a jump", () => {
  const loaded = [HEAD];
  assert.deepEqual(locateRef(refHit("v1", { commitOid: HEAD }), loaded), { kind: "loaded", index: 0 });
  // A tag on a tree or a blob is a real name with no row to sit on: a fact about
  // the tag, not a read that failed.
  assert.equal(locateRef(refHit("tree-tag", { commitOid: null }), loaded), null);
});

test("the subject and the body are two slices of the one addressed text", () => {
  const commit = commitHit(HEAD, {
    message: "Refactor the graph lane\n\nclose the seam",
    subjectEndBytes: 23,
    subjectEndUnits: 23,
  });
  const parts = messageParts(commit);
  assert.equal(parts.subject, "Refactor the graph lane");
  // The body starts at the line break rather than being trimmed: a fragment
  // found in the body indexes `message`, and a second coordinate system for the
  // same text is how a highlight lands on the wrong letters.
  assert.equal(parts.body, "\n\nclose the seam");
  // A subject-only message has no body at all.
  assert.equal(messageParts(commitHit(HEAD)).body, "");
});

test("a boundary counted in units survives an astral character", () => {
  // The guitar pick is one cluster: four UTF-8 bytes and two UTF-16 units, so
  // this subject is 23 bytes and 21 units of the same string, and the two
  // addressings of one fragment in it are different numbers.
  const commit = commitHit(HEAD, {
    message: "🎸 fix the graph lane",
    subjectEndBytes: 23,
    subjectEndUnits: 21,
  });
  const bytes = new TextEncoder().encode(commit.message).length;
  assert.equal(bytes, 23);
  assert.equal(commit.message.length, 21);
  assert.equal(messageParts(commit).subject, "🎸 fix the graph lane");

  const fragment = { byteStart: 5, byteEnd: 8, unitStart: 3, unitEnd: 6 };
  const hit = { field: "subject", tier: "contiguous", fragments: [fragment] };
  assert.deepEqual(highlight(hit, commit), [
    { text: "🎸 ", marked: false },
    { text: "fix", marked: true },
    { text: " the graph lane", marked: false },
  ]);
  // The fixture is self-consistent, which is the whole point of writing it out:
  // the run's unit start is four bytes into the message because the cluster it
  // follows is two units wide and four bytes wide, and only the units index the
  // string a row is drawn from.
  assert.notEqual(fragment.unitStart, fragment.byteStart);
  assert.equal(
    new TextEncoder().encode(commit.message.slice(0, fragment.unitStart)).length,
    fragment.byteStart,
  );
});

test("a string is cut into plain and marked runs in field order", () => {
  const fragment = (unitStart, unitEnd) => ({ byteStart: unitStart, byteEnd: unitEnd, unitStart, unitEnd });
  assert.deepEqual(segments("fix the graph", [fragment(0, 3), fragment(8, 13)]), [
    { text: "fix", marked: true },
    { text: " the ", marked: false },
    { text: "graph", marked: true },
  ]);
  // No fragments means one plain run, not an empty list a view would draw as
  // nothing at all.
  assert.deepEqual(segments("fix the graph", []), [{ text: "fix the graph", marked: false }]);
  assert.deepEqual(segments("", []), []);
});

test("a fragment that does not fit its string is dropped, not clamped", () => {
  const fragment = (unitStart, unitEnd) => ({ byteStart: unitStart, byteEnd: unitEnd, unitStart, unitEnd });
  const plain = [{ text: "short", marked: false }];
  // Past the end: clamping it would mark the last letters of a word the query
  // never matched.
  assert.deepEqual(segments("short", [fragment(5, 9)]), plain);
  // Covering no letters: a marker on the wrong side of a character is
  // indistinguishable from one on the right side.
  assert.deepEqual(segments("short", [fragment(1, 1)]), plain);
  // Starting before the accepted run ended describes no field this string has,
  // so the second fragment goes and the first stands.
  assert.deepEqual(segments("short", [fragment(0, 2), fragment(1, 4)]), [
    { text: "sh", marked: true },
    { text: "ort", marked: false },
  ]);
  // The units are what the string is cut by, whatever the bytes beside them
  // claim: this fragment's byte pair is off the end of the message entirely.
  assert.deepEqual(segments("short", [{ byteStart: 99, byteEnd: 99, unitStart: 1, unitEnd: 4 }]), [
    { text: "s", marked: false },
    { text: "hor", marked: true },
    { text: "t", marked: false },
  ]);
});

test("offsets index the field the backend named", () => {
  const commit = commitHit(HEAD, { oid: oid("c"), authorName: "Kys", message: "Refactor the graph lane" });
  assert.equal(fieldText({ field: "oid", tier: "exact", fragments: [] }, commit), oid("c"));
  assert.equal(fieldText({ field: "author", tier: "exact", fragments: [] }, commit), "Kys");
  assert.equal(fieldText({ field: "subject", tier: "exact", fragments: [] }, commit), commit.message);
  assert.equal(fieldText({ field: "body", tier: "exact", fragments: [] }, commit), commit.message);
});

test("a row highlights its best field and reports the rest", () => {
  const one = commitHit(HEAD, { hits: [{ field: "subject", tier: "prefix", fragments: [] }] });
  assert.equal(bestHit(one), one.hits[0]);
  assert.equal(otherFields(one), 0);
  const both = commitHit(HEAD, {
    hits: [
      { field: "subject", tier: "prefix", fragments: [] },
      { field: "body", tier: "subsequence", fragments: [] },
    ],
  });
  assert.equal(bestHit(both).field, "subject");
  assert.equal(otherFields(both), 1);
  // A commit that matched nothing has no best hit: no view is handed a fragment
  // list to draw over a row it cannot explain.
  assert.equal(bestHit(commitHit(HEAD)), null);
  assert.equal(otherFields(commitHit(HEAD)), 0);
});

test("being overtaken is not the search failing", () => {
  // The reader's keystroke stopped this scan: its rows are still the answer to
  // the question on screen, so the overlay keeps them.
  assert.equal(outcomeOf("search_superseded"), "overtaken");
  // A head that moved under a bound read is the same kind of news — the window
  // was answering a question the panel has already replaced.
  assert.equal(outcomeOf("read_stale_context"), "overtaken");
  // The process was stopped by the flag the newer query set: the runner's own
  // word for it, and the one a walk answers with most often.
  assert.equal(outcomeOf("process_cancelled"), "overtaken");
  // The session that owned the scan has closed, so there is no question left on
  // screen for its rows to answer.
  assert.equal(outcomeOf("read_no_session"), "closed");
  // Everything else says that no search happened, and says it as its own reason
  // rather than as an empty history.
  assert.equal(outcomeOf("search_head_unresolved"), "refused");
  assert.equal(outcomeOf("search_target_invalid"), "refused");
  assert.equal(outcomeOf("search_protocol_error"), "refused");
  assert.equal(outcomeOf("search_truncated"), "refused");
  // A Git read that failed on its own is reported as a read failure.
  assert.equal(outcomeOf("git_status_incomplete"), "refused");
  // A code this file has not been told about is a refusal too: an unrecognised
  // rejection may not be read as "the reader moved on" and keep its rows.
  assert.equal(outcomeOf("a_code_this_file_has_not_met"), "refused");
});
