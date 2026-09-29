// The age of the newest file the working tree holds, turned into text.
//
// Pure: no DOM, no clock, no Git. `now` is injected by the module that holds the
// tick (see `views/changes.ts`), which is what lets a Node run assert a band
// boundary the moment it is crossed instead of waiting for one. Every value here
// comes from the activity channel; nothing in this file asks Git a question, so
// a clock advancing costs no read at all.

import type { ActivityReason, ActivityView } from "./types";

// --- the interval that recomputes this text ---
//
// A display preference, not a Git cadence: it decides how often the words are
// re-derived from a number the backend already sent. The watcher's own debounce,
// maximum wait and poll interval stay backend constants and are not connected to
// this, so setting 60 seconds never leaves the file list 60 seconds stale and
// setting 1 never costs a Git read per second.
export const INTERVAL_DEFAULT = 5;
export const INTERVAL_MIN = 1;
export const INTERVAL_MAX = 60;

export function clampInterval(value: number): number {
  if (!Number.isFinite(value)) return INTERVAL_DEFAULT;
  return Math.min(INTERVAL_MAX, Math.max(INTERVAL_MIN, Math.round(value)));
}

// A stored value is only used after the clamp: a number written by an older
// build, or edited by hand, cannot leave the panel counting seconds it never
// agreed to. Anything that is not a whole number is not a preference this build
// understands, so it starts from the default rather than from a guess.
export function readStoredInterval(raw: string | null): number {
  if (raw === null || raw.trim() === "") return INTERVAL_DEFAULT;
  const parsed = Number(raw);
  return Number.isInteger(parsed) ? clampInterval(parsed) : INTERVAL_DEFAULT;
}

// What the panel will run on after a request to change that value, and how the
// row should say so. The two shapes of bad input go opposite ways:
//
// A field that was cleared, or filled with something that is not a number, is
// refused and the value already in force is kept. Overwriting a chosen interval
// with the default would be the panel changing a setting nobody asked it to
// change — and an empty text field is not far from no field at all.
//
// A *number* outside the range is corrected to the bound instead. It is a legible
// choice about wanting it faster or slower, and the bound is the fastest or
// slowest this display can be trusted with; `corrected` is what lets the row say
// which number is actually in force rather than leaving the field to lie.
export interface IntervalChoice {
  /** The period to run on, whether or not it is the one that was asked for. */
  seconds: number;
  /** The request was not a number, so nothing changes. */
  refused: boolean;
  /** The request was a number outside the range, and `seconds` is its bound. */
  corrected: boolean;
  /** `seconds` differs from what is in force, so a timer has to be re-armed. */
  changed: boolean;
}

const refusedInterval = (current: number): IntervalChoice => ({
  seconds: current,
  refused: true,
  corrected: false,
  changed: false,
});

// The same, after the panel tried to keep it. `persisted === false` means the
// period is in force for this session and storage did not take it, so the next
// start will not know about it — a fact the row has to say rather than imply.
// A refused request owes storage nothing, so it reports as persisted.
export interface IntervalApplied extends IntervalChoice {
  persisted: boolean;
}

export function chooseInterval(raw: string | number, current: number): IntervalChoice {
  const asNumber = typeof raw === "number" ? raw : Number(raw.trim());
  // `Number("")` is `0`, which would read as "one second" from an emptied field.
  if (typeof raw === "string" && raw.trim() === "") return refusedInterval(current);
  if (!Number.isFinite(asNumber)) return refusedInterval(current);
  const seconds = clampInterval(asNumber);
  return { seconds, refused: false, corrected: seconds !== asNumber, changed: seconds !== current };
}

// --- the age bands ---
//
// Exported because they are the boundary the text changes at: a test asserts one
// step either side of each, and moving a boundary has to move that test.
export const AGE_MINUTE_MS = 60_000;
export const AGE_HOUR_MS = 60 * AGE_MINUTE_MS;
export const AGE_DAY_MS = 24 * AGE_HOUR_MS;
export const AGE_MONTH_MS = 30 * AGE_DAY_MS;
export const AGE_YEAR_MS = 12 * AGE_MONTH_MS;

const count = (delta: number, unit: number): string => {
  const whole = Math.floor(delta / unit);
  const name = whole === 1 ? unitName(unit) : `${unitName(unit)}s`;
  return `${whole} ${name} ago`;
};

const unitName = (unit: number): string =>
  unit === AGE_MINUTE_MS ? "minute"
    : unit === AGE_HOUR_MS ? "hour"
      : unit === AGE_DAY_MS ? "day"
        : unit === AGE_MONTH_MS ? "month"
          : "year";

// An age is a wall-clock difference, so a file genuinely gets older while nobody
// touches it. A stamp ahead of the clock that reads it is a different fact and
// does not get a number: saying "just now" would vouch for a change nobody saw.
function band(delta: number): string {
  if (delta < AGE_MINUTE_MS) return "just now";
  if (delta < AGE_HOUR_MS) return count(delta, AGE_MINUTE_MS);
  if (delta < AGE_DAY_MS) return count(delta, AGE_HOUR_MS);
  if (delta < AGE_MONTH_MS) return count(delta, AGE_DAY_MS);
  if (delta < AGE_YEAR_MS) return count(delta, AGE_MONTH_MS);
  return count(delta, AGE_YEAR_MS);
}

// The three shapes the line can take. A caller cannot mix them up: only `age`
// carries a number, and only `age` may be re-read every tick.
export type ActivityDisplay =
  | { kind: "age"; text: string; file: string | null }
  | { kind: "note"; text: string }
  | { kind: "untrusted"; text: string };

const PARTIAL_CAUSE: Readonly<Record<ActivityReason, string>> = {
  readFailed: "Git could not be read",
  outputLimit: "the file listing was cut short",
  unreadablePaths: "some files could not be read",
  refreshFailed: "the repository could not be re-read",
  sessionClosed: "the repository was closed",
};

const NO_NUMBER = "Last modification unknown";

// A reason word arrives over a channel no compiler spans: one this build has
// never heard of leaves the sentence without a cause rather than printing
// `undefined` where an explanation should be.
function causeOf(reason: ActivityReason | null): string | null {
  if (reason === null) return null;
  return PARTIAL_CAUSE[reason as ActivityReason] ?? null;
}

// Whether the text depends on the clock. `scanning`, `empty` and `unavailable`
// say the same thing whatever time it is, so a tick that finds one of them has
// nothing to recompute.
export function advancesWithClock(view: ActivityView | null): boolean {
  return view !== null && (view.state === "ready" || view.state === "partial");
}

// The first decision is which fields the state even has a use for: a missing
// `latestModifiedAt` is a property of certain states, never a clue to work one
// out from. An unrecognised state is reported as unavailable rather than folded
// into a neighbouring one — "I received this and cannot read it" is not "all is
// well", and the age of a repository nobody measured is not a fact the panel owns.
//
// `null` is the held value after a push that named no session, which is the one
// form the channel uses to say "no answer, for any repository": the line shows
// that it has no number, and never the number the previous session left behind.
export function describeActivity(view: ActivityView | null, now: number): ActivityDisplay {
  if (view === null) return { kind: "note", text: NO_NUMBER };
  switch (view.state) {
    case "ready":
    case "partial": {
      const latest = view.latestModifiedAt;
      if (latest === null || !Number.isFinite(latest) || !Number.isFinite(now)) {
        return { kind: "untrusted", text: `${NO_NUMBER} — the measurement carries no readable time` };
      }
      // Either the stamp is ahead of the clock that reads it, or it is ahead of
      // the measurement that reported it, which the payload cannot both assert
      // and disprove.
      if (latest > now || latest > view.observedAt) {
        return {
          kind: "untrusted",
          text: "Last modification unknown — file timestamps are ahead of the panel clock",
        };
      }
      const age = band(now - latest);
      if (view.state === "partial") {
        const cause = causeOf(view.reason) ?? "the answer covers only part of the repository";
        return {
          kind: "age",
          text: `Last modified at least ${age} — ${cause}`,
          file: view.displayName,
        };
      }
      return { kind: "age", text: `Last modified ${age}`, file: view.displayName };
    }
    case "empty":
      return { kind: "note", text: "No working-tree files to measure" };
    case "unavailable": {
      const cause = causeOf(view.reason);
      return { kind: "note", text: cause === null ? NO_NUMBER : `${NO_NUMBER} — ${cause}` };
    }
    default:
      return { kind: "note", text: NO_NUMBER };
  }
}
