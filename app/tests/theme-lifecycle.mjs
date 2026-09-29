// The custom theme's life cycle, with no renderer in sight.
//
// The clause these tests exist for is the one the plan calls a release blocker: 坏主题
// 无法恢复. Every case below is some way a fragment goes wrong and one question — is
// the built-in look still reachable, and does reaching it depend on the text that
// just failed?

import assert from "node:assert/strict";
import test from "node:test";
import {
  BUILT_IN,
  beginApply,
  finishApply,
  launchTheme,
  stopTheme,
  themeRecord,
} from "../src/themeLifecycle.ts";

const GOOD = ":root { --surface-app: #101014 }";
const BAD = ".rows { width: 40px }";
const HOSTILE = "* { display: none }";

const drawOf = (decision) => (decision.effect.kind === "draw" ? decision.effect.css : null);

test("a first launch with nothing stored draws the built-in look and says nothing", () => {
  const decision = launchTheme(themeRecord(BUILT_IN, true), false);
  assert.deepEqual(decision.effect, { kind: "clear" });
  assert.equal(decision.notice, null);
  assert.equal(decision.record.unverified, null);
});

test("a theme that was confirmed last time comes back on its own", () => {
  const applied = beginApply(themeRecord(BUILT_IN, true), GOOD);
  const confirmed = finishApply(applied.record, "verified", BUILT_IN);
  const decision = launchTheme(confirmed.record, false);
  assert.equal(drawOf(decision), GOOD);
  assert.equal(decision.notice, null, "the person's own saved theme needs no announcement");
});

test("a fragment that never reported back is off at the next launch, and its text is kept", () => {
  const inFlight = beginApply(themeRecord(BUILT_IN, true), HOSTILE);
  assert.equal(inFlight.record.unverified, HOSTILE, "the intent must be stored before the draw");
  const decision = launchTheme(inFlight.record, false);
  assert.deepEqual(decision.effect, { kind: "clear" });
  assert.equal(decision.record.enabled, false);
  assert.equal(decision.record.draft, HOSTILE, "their text is not the panel's to throw away");
  assert.equal(decision.notice, "unconfirmed");
});

test("an unconfirmed fragment is reported once, not on every start after it", () => {
  const crashed = launchTheme(beginApply(themeRecord(BUILT_IN, true), HOSTILE).record, false);
  const again = launchTheme(crashed.record, false);
  assert.equal(again.record.unverified, null);
  assert.equal(again.notice, null);
  assert.deepEqual(again.effect, { kind: "clear" });
});

test("a disabled theme stays off across restarts until the person turns it back on", () => {
  const off = launchTheme(launchTheme(beginApply(themeRecord(BUILT_IN, true), HOSTILE).record, false).record, false);
  assert.equal(off.record.enabled, false);
  assert.deepEqual(off.effect, { kind: "clear" });
  // The page's own way back is to apply the text its box holds, so that is what the
  // state machine is asked with — there is no entry that re-enables a draft the
  // caller did not name.
  const resumed = beginApply(off.record, off.record.draft);
  assert.equal(resumed.record.enabled, true);
  assert.equal(drawOf(resumed), HOSTILE);
});

test("an empty draft cannot be resumed into an enabled theme", () => {
  const resumed = beginApply(themeRecord(BUILT_IN, false), BUILT_IN);
  assert.equal(resumed.record.enabled, false);
  assert.deepEqual(resumed.effect, { kind: "clear" });
});

test("safe launch draws the built-in look and leaves the record as it was", () => {
  const record = themeRecord(GOOD, true);
  const decision = launchTheme(record, true);
  assert.deepEqual(decision.effect, { kind: "clear" });
  assert.equal(decision.notice, "disabled");
  assert.deepEqual(decision.record, record, "a temporary start must not rewrite a choice");
});

test("a refused apply goes back to what was on screen, not to a guess", () => {
  const first = finishApply(beginApply(themeRecord(BUILT_IN, true), GOOD).record, "verified", BUILT_IN);
  const second = beginApply(first.record, BAD);
  const failed = finishApply(second.record, "refused", first.record.draft);
  assert.equal(drawOf(failed), GOOD);
  assert.equal(failed.record.enabled, false);
  assert.equal(failed.notice, "reverted");
});

test("a fragment that hides the way back out is a failure even though it drew", () => {
  const failed = finishApply(beginApply(themeRecord(BUILT_IN, true), HOSTILE).record, "hid-recovery", BUILT_IN);
  assert.deepEqual(failed.effect, { kind: "clear" });
  assert.equal(failed.record.enabled, false);
  assert.equal(failed.notice, "hidden-controls");
});

test("no decision ever asks for an empty stylesheet to be drawn", () => {
  const records = [
    themeRecord(BUILT_IN, true),
    themeRecord(GOOD, true),
    themeRecord(HOSTILE, false),
    { draft: HOSTILE, enabled: true, unverified: HOSTILE },
  ];
  for (const record of records) {
    for (const decision of [
      launchTheme(record, false),
      launchTheme(record, true),
      beginApply(record, BUILT_IN),
      finishApply(record, "refused", BUILT_IN),
      finishApply(record, "hid-recovery", BUILT_IN),
      stopTheme(record),
      beginApply(record, record.draft),
    ]) {
      assert.notEqual(drawOf(decision), BUILT_IN, `a draw of "" is a clear wearing a mask: ${decision.notice}`);
      if (decision.effect.kind === "draw") assert.ok(decision.effect.css.length > 0);
    }
  }
});

test("the built-in look is reachable from every state without reading the fragment", () => {
  const hostile = { draft: HOSTILE, enabled: true, unverified: HOSTILE };
  const stopped = stopTheme(hostile);
  assert.deepEqual(stopped.effect, { kind: "clear" });
  assert.deepEqual(launchTheme(stopped.record, false).effect, { kind: "clear" });
  assert.deepEqual(launchTheme(stopped.record, true).effect, { kind: "clear" });
});

test("a whole session: good theme, bad edit, a crash, then a fix", () => {
  let state = launchTheme(themeRecord(BUILT_IN, true), false);
  assert.deepEqual(state.effect, { kind: "clear" });

  state = beginApply(state.record, GOOD);
  assert.equal(drawOf(state), GOOD);
  state = finishApply(state.record, "verified", BUILT_IN);
  assert.equal(state.notice, "confirmed");
  assert.equal(state.record.unverified, null);
  const good = state.record;

  state = beginApply(state.record, BAD);
  state = finishApply(state.record, "refused", good.draft);
  assert.equal(drawOf(state), GOOD);
  assert.equal(state.record.enabled, false);

  // The page's own way back on: apply the text the box still holds.
  state = beginApply(state.record, state.record.draft);
  assert.equal(state.record.enabled, true);
  assert.equal(state.record.unverified, BAD, "an edit that never verified is exactly the crash marker");

  // The person closes the window while that unverified fragment is on screen.
  const afterRestart = launchTheme(state.record, false);
  assert.deepEqual(afterRestart.effect, { kind: "clear" });
  assert.equal(afterRestart.notice, "unconfirmed");
  assert.equal(afterRestart.record.draft, BAD);

  const fixed = beginApply({ ...afterRestart.record, draft: GOOD, enabled: true }, GOOD);
  assert.equal(drawOf(fixed), GOOD);
  assert.equal(finishApply(fixed.record, "verified", BUILT_IN).notice, "confirmed");
});

test("a confirmed apply keeps the screen it already has", () => {
  const applied = beginApply(themeRecord(BUILT_IN, true), GOOD);
  const confirmed = finishApply(applied.record, "verified", BUILT_IN);
  assert.deepEqual(confirmed.effect, { kind: "keep" });
});

test("clearing the text box is the same as turning the theme off", () => {
  const cleared = beginApply(themeRecord(GOOD, true), BUILT_IN);
  assert.equal(cleared.record.draft, BUILT_IN);
  assert.equal(cleared.record.enabled, false);
  assert.deepEqual(cleared.effect, { kind: "clear" });
});
