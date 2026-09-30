// Pure view-model for the unified search, so `node --test` can import it with no
// build step and no DOM, the way `historyModel.ts` is imported.
//
// Everything that knows Git stays in `search.rs`: which commit a scan walks, how
// far it has walked, why it stopped, and which bytes of which string each match
// covers. What is left here is the part only the screen can decide, and it is
// small but not trivial — whether an answer that has arrived is still an answer
// to the question the screen is asking, and what the screen is allowed to claim
// about the search when it is.
//
// Three things can make an answer unwanted, and they are checked in the order
// that says most: an answer from another repository session (its rows are
// indistinguishable by content, which is why the id exists), an answer to a
// question the reader has already replaced, and an answer whose session context
// has been superseded by a refresh. Dropping is not failing. A dropped answer
// leaves the screen alone; the notification that caused it asks again.
//
// The other rule here is about wording. A scan that has not finished is not a
// scan that found nothing, and a scan that stopped at a ceiling is not one that
// reached the end of the history. Only one combination of the backend's own
// fields may be drawn as "nothing matched", so that combination is decided here,
// once, rather than in a view that has the whole string.

import type { ReadContext, SessionRead } from "./types";

/// The same pairing `snapshotBus.ts::contextMatches` applies in a view: session
/// first, then the generation the read was bound to. It is written out again
/// here rather than imported because a pure model may carry types but not values
/// — `node --test` loads this file with no bundler, and a value import of another
/// module is an extensionless path it cannot resolve. These are one rule, and the
/// harness is the only reason there are two copies of it: a change to either
/// belongs to both.
const sameReadContext = (asked: ReadContext, answered: ReadContext): boolean =>
  asked.sessionId === answered.sessionId && asked.generation === answered.generation;

// --- the wire shapes, mirroring `search.rs` -------------------------

/// Which field of a commit one match was found in.
export type HitField = "oid" | "subject" | "body" | "author";

/// How good a match was, in the matcher's own words.
export type Tier = "exact" | "prefix" | "contiguous" | "subsequence";

/// Which sort of name matched. `remote` is a remote-tracking ref: local
/// metadata about a remote, never current remote state.
export type RefKind = "branch" | "tag" | "remote";

/// One piece of a matched string. The byte offsets address the Rust string the
/// backend sliced; the unit offsets address the JavaScript string this row is
/// drawn from, and the two differ for every astral character — an emoji in a
/// subject line is not rare. Only the units are used here.
export interface Fragment {
  byteStart: number;
  byteEnd: number;
  unitStart: number;
  unitEnd: number;
}

export interface SearchHit {
  field: HitField;
  tier: Tier;
  fragments: Fragment[];
}

export interface CommitHit {
  oid: string;
  message: string;
  subjectEndBytes: number;
  subjectEndUnits: number;
  authorName: string;
  commitDate: string;
  /// Position back from the commit the scan stood on, newest at 0. The search
  /// walks by recency and the graph is laid out topologically, so this counts
  /// records of the scan, never rows of the graph.
  offset: number;
  hits: SearchHit[];
}

export interface RefHit {
  kind: RefKind;
  name: string;
  commitOid: string | null;
  head: boolean;
  /// Only `false` may be worded as being outside the current history, and only
  /// because a probe ran and answered. `null` means nothing was asked of it.
  reachedFromHead: boolean | null;
  tier: Tier;
  fragments: Fragment[];
}

export interface SearchWindow {
  cursor: number;
  scanned: number;
  complete: boolean;
  stoppedBy: string | null;
  nextCursor: number | null;
  hitsTruncated: boolean;
  commits: CommitHit[];
  /// Names, carried by the first window only — the listing does not move while
  /// the history is walked.
  refs: RefHit[];
}

export interface SearchPage {
  queryId: number;
  /// The commit every `offset` in this page counts back from.
  head: string;
  /// The names generation the listing was taken under, read before the listing.
  refsGeneration: number;
  window: SearchWindow;
}

/// Why a scan stopped before the history ended. Its absence together with
/// `complete: false` means only that another window exists.
export const STOP_SCAN_CAP = "search_scan_capped";

/// The three things a rejected search read can mean, kept apart because each
/// owes the screen a different sentence.
///
/// * `overtaken` — the answer was still arriving when the reader typed again, or
///   when a refresh moved the history it was bound to. Nothing on screen is
///   wrong: the rows are still the answer to the question the panel is asking.
/// * `closed` — the session it belonged to has ended, so those rows describe a
///   repository that is no longer open and nothing may be kept.
/// * `refused` — the search itself did not happen: no commit to walk from, a
///   capture that came back cut, a stream that is not what the format promised.
///
/// None of the three is "no results". That one state is earned by a finished scan
/// with nothing in it, which `nothingMatched` is the only judge of.
export type SearchOutcome = "overtaken" | "closed" | "refused";

const OVERTAKEN = new Set(["search_superseded", "read_stale_context", "process_cancelled"]);
const CLOSED = new Set(["read_no_session"]);

/// Which of the three a rejection is. An unknown code is a refusal, never a quiet
/// drop: a failure this file has not been told about still says nothing about the
/// history, and a view that read it as "the reader moved on" would keep rows that
/// were never produced.
export function outcomeOf(code: string): SearchOutcome {
  if (OVERTAKEN.has(code)) return "overtaken";
  if (CLOSED.has(code)) return "closed";
  return "refused";
}

// --- which question an answer belongs to ----------------------------

/// The newest search the screen still acknowledges, and the session its
/// numbering belongs to. `queryId` restarts in a new session, which is safe
/// because the session travels with it — the backend's lane is keyed on both, so
/// the first keystroke in a second repository outranks a scan still running in
/// the first one.
export interface SearchLane {
  sessionId: number;
  queryId: number;
}

/// A session with nothing asked in it yet.
export const closedLane = (sessionId: number): SearchLane => ({ sessionId, queryId: 0 });

/// The id to ask the next search with, and the lane as it stands once asked.
/// Called once per keystroke the reader actually meant — a view that debounces
/// or waits for a composition to end calls it when it sends, not when a key goes
/// down, so an unanswered half-typed query never takes the lane.
export function nextQueryId(lane: SearchLane, sessionId: number): { lane: SearchLane; queryId: number } {
  if (lane.sessionId !== sessionId) return { lane: { sessionId, queryId: 1 }, queryId: 1 };
  const queryId = lane.queryId + 1;
  return { lane: { sessionId, queryId }, queryId };
}

/// Why an answer is unwanted, or `null` when the screen still wants it.
///
/// The session is named first because it is the fact nothing in the rows can
/// recover: two clones of one repository agree on the head, the branch and every
/// commit, so an answer from a closed session is indistinguishable by content
/// from the one still wanted. A superseded query and a superseded generation are
/// both "the screen moved", and both leave the rows already drawn alone.
export function dropReason(
  lane: SearchLane,
  asked: ReadContext,
  read: SessionRead<SearchPage>,
): "session" | "query" | "generation" | null {
  const answered = read.context;
  if (answered.sessionId !== lane.sessionId || asked.sessionId !== lane.sessionId) return "session";
  if (read.value.queryId !== lane.queryId) return "query";
  if (!sameReadContext(asked, answered)) return "generation";
  return null;
}

// --- what the screen holds ------------------------------------------

/// The rows a search has produced so far, in the order the scan found them:
/// newest first, with each later window appended after the ones before it.
///
/// It is kept alongside the fields the wording depends on, so a view cannot draw
/// "no results" from a list that happens to be empty without also having the
/// `complete` that entitles it to say so.
export interface SearchResult {
  sessionId: number;
  queryId: number;
  asked: ReadContext;
  head: string;
  refsGeneration: number;
  /// Records walked by every window accepted so far.
  scanned: number;
  complete: boolean;
  stoppedBy: string | null;
  nextCursor: number | null;
  /// Sticky: once one window has reported that more matched than it returned,
  /// the answer as a whole showed fewer than there were, whatever later windows
  /// say about themselves.
  hitsTruncated: boolean;
  commits: CommitHit[];
  refs: RefHit[];
}

/// Why a page was not merged, or `null` when it was. `dropped` names the same
/// reasons as `dropReason`; `window` says the page answers a different question
/// than the result holds, which the caller should have caught at the lane. It is
/// reported rather than silently ignored because "one result answers one
/// question" is a property of the data, not a favour the caller does.
export type MergeRejection = "session" | "query" | "generation" | "window";

export function mergePage(
  result: SearchResult | null,
  lane: SearchLane,
  asked: ReadContext,
  read: SessionRead<SearchPage>,
): { result: SearchResult | null; rejected: MergeRejection | null } {
  const reason = dropReason(lane, asked, read);
  if (reason !== null) return { result, rejected: reason };
  const page = read.value;
  if (result !== null && result.queryId !== page.queryId) return { result, rejected: "window" };
  if (result === null) return { result: startResult(lane, asked, page), rejected: null };
  const window = page.window;
  return {
    result: {
      ...result,
      // The head and the names generation belong to the whole search, so the
      // first window's are kept: a continuation that reported a different head
      // would be an answer about another history, and `dropReason` cannot see
      // that on its own.
      scanned: result.scanned + window.scanned,
      complete: window.complete,
      stoppedBy: window.stoppedBy,
      nextCursor: window.nextCursor,
      hitsTruncated: result.hitsTruncated || window.hitsTruncated,
      commits: result.commits.concat(window.commits),
      refs: result.refs.concat(window.refs),
    },
    rejected: null,
  };
}

const startResult = (lane: SearchLane, asked: ReadContext, page: SearchPage): SearchResult => ({
  sessionId: lane.sessionId,
  queryId: page.queryId,
  asked,
  head: page.head,
  refsGeneration: page.refsGeneration,
  scanned: page.window.scanned,
  complete: page.window.complete,
  stoppedBy: page.window.stoppedBy,
  nextCursor: page.window.nextCursor,
  hitsTruncated: page.window.hitsTruncated,
  commits: page.window.commits.slice(),
  refs: page.window.refs.slice(),
});

// --- what the screen may say ----------------------------------------

/// The only state that may be worded as nothing matching: a scan that finished,
/// stopped by nothing, and produced no rows. A query no window has reached yet
/// is not this, and neither is a scan that ran into its ceiling.
export function nothingMatched(result: SearchResult): boolean {
  return (
    result.complete &&
    result.stoppedBy === null &&
    result.commits.length === 0 &&
    result.refs.length === 0
  );
}

/// Whether another window may be asked for. A ceiling and an unfinished scan are
/// different facts: past the cap there is nothing further to read whatever the
/// history's size, so a view that offered "load more" there would be offering a
/// re-read of records already walked.
export function canAskAgain(result: SearchResult): boolean {
  return !result.complete && result.stoppedBy === null && result.nextCursor !== null;
}

/// Whether the scan has said its last word, by one route or the other.
export function isSettled(result: SearchResult): boolean {
  return result.complete || result.stoppedBy !== null;
}

/// Whether the rows are still worth drawing while the answer keeps arriving: a
/// query whose first window has not come back has nothing to show, and a view
/// that says "no results" at that moment is lying about a scan it has not run.
export function hasRows(result: SearchResult | null): boolean {
  return result !== null && (result.commits.length > 0 || result.refs.length > 0);
}

/// Whether the names in an answer are the names on screen. The listing is taken
/// during the scan and its generation is read *before* the listing, so an answer
/// whose names moved looks older than it is — and the safe reading of an answer
/// older than the screen is to drop its names and keep its commits, which are
/// bound to the graph generation instead.
export function refsUsable(result: SearchResult, screenRefsGeneration: number): boolean {
  return result.refsGeneration === screenRefsGeneration;
}

/// How many of the names the scan was willing to report did not reach the probe
/// budget. Names whose reachability was never asked are `reachedFromHead: null`,
/// and a view that has nothing to say about them must not say they are outside
/// the current history.
export function unansweredNames(result: SearchResult): number {
  let waiting = 0;
  for (const ref of result.refs) if (ref.reachedFromHead === null) waiting += 1;
  return waiting;
}

// --- locating a hit in the graph ------------------------------------

/// Where a commit row goes when the reader picks it.
///
/// The search walks history by recency and the graph is laid out topologically,
/// so an offset counts records of one walk and not rows of the other: it can
/// never be used as a graph index, and the honest read is the one that starts at
/// the commit itself. Only the identity of the commit is shared between the two.
export type CommitLocator =
  /// Already drawn: the index of the row in the history the graph holds.
  | { kind: "loaded"; index: number }
  /// Read the page that starts at this commit, so the graph draws the hit and
  /// the ancestry it is reached from rather than a position counted from a head.
  | { kind: "history"; oid: string };

export function locateCommit(oid: string, loadedOids: readonly string[]): CommitLocator {
  const index = loadedOids.indexOf(oid);
  return index < 0 ? { kind: "history", oid } : { kind: "loaded", index };
}

/// The commit a name row is about. A tag on a tree or a blob names no commit —
/// that is a fact about the name, not a read that failed — and `null` here is
/// what stops a view from offering a jump it cannot make.
export function locateRef(hit: RefHit, loadedOids: readonly string[]): CommitLocator | null {
  return hit.commitOid === null ? null : locateCommit(hit.commitOid, loadedOids);
}

// --- drawing a match ------------------------------------------------

/// The string one hit's fragments index. Offsets describe exactly one text, and
/// which one is decided by the field the backend named, never by a view that
/// happens to be showing a different string in the same column.
export function fieldText(hit: SearchHit, commit: CommitHit): string {
  switch (hit.field) {
    case "oid":
      return commit.oid;
    case "author":
      return commit.authorName;
    case "subject":
    case "body":
      return commit.message;
  }
}

/// The first line of a message, and the rest of it, addressed by the boundary
/// the backend reported in UTF-16 units. A row that titles itself with the first
/// line and a renderer that highlights the whole message then agree without
/// either computing where a line ends — and an escaped copy of the subject would
/// be a string the fragments no longer described.
export function messageParts(commit: CommitHit): { subject: string; body: string } {
  const end = Math.min(Math.max(0, commit.subjectEndUnits), commit.message.length);
  return { subject: commit.message.slice(0, end), body: commit.message.slice(end) };
}

/// One run of a string, marked or not, in the order the fragments arrived.
export interface Segment {
  text: string;
  marked: boolean;
}

/// A string cut into plain and marked runs. Fragments never overlap or touch in
/// the field they came from, so the runs are already in order and need no
/// sorting; anything outside them is copied through unchanged.
///
/// A fragment that does not fit the string it indexes is dropped rather than
/// clamped, and a fragment that would mark nothing is never emitted: a highlight
/// that covers no letter is a marker on the wrong side of a character, and a
/// reader cannot tell that apart from a highlight on the right one.
export function segments(text: string, fragments: readonly Fragment[]): Segment[] {
  const out: Segment[] = [];
  const push = (start: number, end: number, marked: boolean): void => {
    if (end <= start) return;
    out.push({ text: text.slice(start, end), marked });
  };
  let at = 0;
  for (const fragment of fragments) {
    const start = fragment.unitStart;
    const end = fragment.unitEnd;
    if (start < at || end <= start || end > text.length || start > text.length) continue;
    push(at, start, false);
    push(start, end, true);
    at = end;
  }
  push(at, text.length, false);
  return out;
}

/// The segments to draw for one hit, in the text the hit actually indexes. This
/// is the only place a field and its fragments are put together, so a highlight
/// below the visible line — a body match under a subject-only row — is explained
/// by the same function that draws it.
export function highlight(hit: SearchHit, commit: CommitHit): Segment[] {
  return segments(fieldText(hit, commit), hit.fragments);
}

/// The best hit on a commit row, which is the first one: the backend orders a
/// row's fields by the ladder (`oid` before `subject` before `body` before
/// `author`) and each field's own matches by the matcher's key. A row highlights
/// its best match and reports the rest rather than blending them, because two
/// fields' fragments index two different strings and a merged list would mark
/// arbitrary letters in whichever text it was drawn into.
export function bestHit(commit: CommitHit): SearchHit | null {
  return commit.hits.length === 0 ? null : commit.hits[0];
}

/// How many of a commit's fields matched beyond the one a row highlights.
export function otherFields(commit: CommitHit): number {
  return Math.max(0, commit.hits.length - 1);
}
