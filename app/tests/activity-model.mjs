// The age line is arithmetic on a number someone else measured, so every rule
// in it is testable without a window, a clock or Git.
//
// `activityModel.ts` is imported directly for the same reason `fileModel.ts` is:
// the boundaries it exports are the wording's boundaries, and a test that only
// checked the middle of a band would let a boundary move unnoticed. The injected
// `now` is what makes the exact moment a band changes assertable at all — no run
// here waits for anything.
//
// Two families of assertions matter more than the wording:
//
//   * a number never reaches the screen when the panel has no trustworthy one.
//     A stamp ahead of the clock that reads it is not "just now" — saying so
//     would vouch for a change nobody saw, and `NaN` in a sentence is worse.
//   * each state says something different. `empty`, `unavailable` and "no
//     measurement for this session" are three facts, and `partial` must not read
//     as a complete answer, because a smaller maximum is exactly what a
//     half-read listing produces.

import assert from "node:assert/strict";
import test from "node:test";

const {
  advancesWithClock,
  AGE_DAY_MS,
  AGE_HOUR_MS,
  AGE_MINUTE_MS,
  AGE_MONTH_MS,
  AGE_YEAR_MS,
  clampInterval,
  describeActivity,
  INTERVAL_DEFAULT,
  INTERVAL_MAX,
  INTERVAL_MIN,
  readStoredInterval,
} = await import("../src/activityModel.ts");

const NOW = 1_700_000_000_000;

const view = (overrides) => ({
  sessionId: 1,
  generation: 1,
  state: "ready",
  latestModifiedAt: NOW - 60_000,
  observedAt: NOW,
  displayName: "notes.txt",
  reason: null,
  ...overrides,
});

// --- the bands, at their boundaries ---

test("each band changes wording at its own exported boundary", () => {
  const at = (delta) => describeActivity(view({ latestModifiedAt: NOW - delta }), NOW).text;
  assert.equal(at(AGE_MINUTE_MS - 1), "Last modified just now");
  assert.equal(at(AGE_MINUTE_MS), "Last modified 1 minute ago");
  assert.equal(at(AGE_HOUR_MS - 1), "Last modified 59 minutes ago");
  assert.equal(at(AGE_HOUR_MS), "Last modified 1 hour ago");
  assert.equal(at(AGE_DAY_MS - 1), "Last modified 23 hours ago");
  assert.equal(at(AGE_DAY_MS), "Last modified 1 day ago");
  assert.equal(at(AGE_MONTH_MS - 1), "Last modified 29 days ago");
  assert.equal(at(AGE_MONTH_MS), "Last modified 1 month ago");
  assert.equal(at(AGE_YEAR_MS - 1), "Last modified 11 months ago");
  assert.equal(at(AGE_YEAR_MS), "Last modified 1 year ago");
  assert.equal(at(AGE_YEAR_MS * 3 + AGE_DAY_MS), "Last modified 3 years ago");
});

test("an ageing repository moves through the bands without anyone touching it", () => {
  const stamp = NOW - 55_000;
  const shown = (later) => describeActivity(view({ latestModifiedAt: stamp }), stamp + later).text;
  assert.equal(shown(55_000), "Last modified just now");
  assert.equal(shown(120_000), "Last modified 2 minutes ago");
  assert.equal(shown(7_200_000), "Last modified 2 hours ago");
});

// --- the states, each with its own answer ---

test("a complete measurement names the file behind the number", () => {
  const display = describeActivity(view(), NOW);
  assert.equal(display.kind, "age");
  assert.equal(display.text, "Last modified 1 minute ago");
  assert.equal(display.file, "notes.txt");
});

test("a partial measurement keeps its number and says what is missing", () => {
  const display = describeActivity(view({ state: "partial", reason: "unreadablePaths" }), NOW);
  assert.equal(display.kind, "age");
  assert.match(display.text, /^Last modified at least 1 minute ago — /);
  assert.doesNotMatch(display.text, /^Last modified 1 minute ago$/);
});

test("a partial measurement never claims to be the whole repository", () => {
  for (const [reason, cause] of [
    ["unreadablePaths", "some files could not be read"],
    ["outputLimit", "the file listing was cut short"],
  ]) {
    const display = describeActivity(view({ state: "partial", reason }), NOW);
    assert.ok(display.text.includes(cause), `${reason} does not say why it is short`);
    assert.ok(display.text.includes("at least"), `${reason} reads as an exact age`);
  }
});

test("an empty repository is not a repository with no changes", () => {
  const display = describeActivity(
    view({ state: "empty", latestModifiedAt: null, displayName: null }),
    NOW,
  );
  assert.equal(display.kind, "note");
  assert.equal(display.text, "No working-tree files to measure");
});

test("unavailable says which answer is missing, and never shows a number", () => {
  const texts = new Set();
  for (const reason of ["readFailed", "outputLimit", "refreshFailed", "unreadablePaths"]) {
    const display = describeActivity(
      view({ state: "unavailable", reason, latestModifiedAt: null, displayName: null }),
      NOW,
    );
    assert.equal(display.kind, "note");
    assert.doesNotMatch(display.text, /\d/, `${reason} reached the screen as an age`);
    assert.ok(display.text.startsWith("Last modification unknown — "), reason);
    texts.add(display.text);
  }
  // Four different causes cannot collapse into one sentence and one blank.
  assert.equal(texts.size, 4);
  const noCause = describeActivity(view({ state: "unavailable", reason: null }), NOW);
  assert.equal(noCause.text, "Last modification unknown");
});

test("an unrecognised state is reported as unknown, not folded into a neighbour", () => {
  // The payload a future backend sends is not this build's union. Folding it into
  // the closest known word is how "I received this and cannot read it" ends up
  // rendered as a healthy answer.
  for (const state of ["scanning", "stale", "", "READY"]) {
    const display = describeActivity(view({ state, latestModifiedAt: NOW - 90_000 }), NOW);
    assert.equal(display.kind, "note", `${state} was read as a number`);
    assert.equal(display.text, "Last modification unknown");
  }
});

test("a session with no measurement on screen shows no leftover number", () => {
  const display = describeActivity(null, NOW);
  assert.equal(display.kind, "note");
  assert.equal(display.text, "Last modification unknown");
  assert.doesNotMatch(display.text, /\d/, "a cleared line still reads as an age");
});

test("a reason word this build does not know leaves the sentence whole", () => {
  const partial = describeActivity(view({ state: "partial", reason: "somethingNew" }), NOW);
  assert.equal(partial.kind, "age");
  assert.match(partial.text, /^Last modified at least 1 minute ago — /);
  assert.doesNotMatch(partial.text, /undefined|null/, "an unknown word was printed as the cause");
  // Without a cause this build can name, the answer is still "unknown" — never
  // the neighbouring state's sentence.
  const unavailable = describeActivity(
    view({ state: "unavailable", reason: "somethingNew", latestModifiedAt: null }),
    NOW,
  );
  assert.equal(unavailable.text, "Last modification unknown");
});

// --- a clock that does not agree with the files ---

test("a stamp ahead of the panel clock is its own answer, not the smallest band", () => {
  const future = describeActivity(view({ latestModifiedAt: NOW + 3_600_000 }), NOW);
  assert.equal(future.kind, "untrusted");
  assert.doesNotMatch(future.text, /just now|minute|hour|day ago/, "a negative age was clamped into a band");
  assert.doesNotMatch(future.text, /-[\d.]/, "a negative number reached the wording");

  // The payload can also contradict itself: a stamp later than the measurement
  // that reported it needs no clock at all to disbelieve.
  const inconsistent = describeActivity(view({ latestModifiedAt: NOW, observedAt: NOW - 10 }), NOW);
  assert.equal(inconsistent.kind, "untrusted");
});

test("a missing or unreadable time never becomes NaN on screen", () => {
  for (const latest of [null, Number.NaN, Number.POSITIVE_INFINITY]) {
    const display = describeActivity(view({ latestModifiedAt: latest }), NOW);
    assert.doesNotMatch(display.text, /NaN|Infinity|-\d/, `the number ${String(latest)} was rendered`);
    assert.equal(display.kind, "untrusted");
  }
  assert.equal(describeActivity(view(), Number.NaN).kind, "untrusted");
});

// --- which states the clock is allowed to recompute ---

test("only a state with a number is recomputed every tick", () => {
  assert.equal(advancesWithClock(view()), true);
  assert.equal(advancesWithClock(view({ state: "partial", reason: "unreadablePaths" })), true);
  for (const value of [
    null,
    view({ state: "empty", latestModifiedAt: null }),
    view({ state: "unavailable", latestModifiedAt: null }),
  ]) {
    assert.equal(advancesWithClock(value), false, "a tick recomputed wording that cannot change");
  }
});

// --- the interval that drives the tick ---

test("the interval is a whole number of seconds inside its bounds", () => {
  assert.equal(INTERVAL_DEFAULT, 5);
  assert.equal(clampInterval(0), INTERVAL_MIN);
  assert.equal(clampInterval(INTERVAL_MIN), INTERVAL_MIN);
  assert.equal(clampInterval(INTERVAL_MAX), INTERVAL_MAX);
  assert.equal(clampInterval(INTERVAL_MAX + 1), INTERVAL_MAX);
  assert.equal(clampInterval(-12), INTERVAL_MIN);
  assert.equal(clampInterval(Number.NaN), INTERVAL_DEFAULT);
  assert.equal(clampInterval(4.6), 5);
});

test("a stored interval is clamped before it is used, or dropped", () => {
  assert.equal(readStoredInterval(null), INTERVAL_DEFAULT);
  assert.equal(readStoredInterval(""), INTERVAL_DEFAULT);
  assert.equal(readStoredInterval("   "), INTERVAL_DEFAULT);
  assert.equal(readStoredInterval("fast"), INTERVAL_DEFAULT);
  assert.equal(readStoredInterval("5.5"), INTERVAL_DEFAULT, "a fraction is not a preference this build wrote");
  assert.equal(readStoredInterval("Infinity"), INTERVAL_DEFAULT);
  assert.equal(readStoredInterval("0"), INTERVAL_MIN);
  assert.equal(readStoredInterval("600"), INTERVAL_MAX);
  assert.equal(readStoredInterval("12"), 12);
});
