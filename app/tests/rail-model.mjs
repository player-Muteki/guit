import assert from "node:assert/strict";
import test from "node:test";
import { railHint, VIEW_ICONS, VIEW_TITLES } from "../src/railModel.ts";
import { VIEW_ORDER } from "../src/state.ts";

test("every rail item names its view and its shortcut", () => {
  VIEW_ORDER.forEach((id, index) => {
    const hint = railHint(id, VIEW_ORDER, true);
    assert.ok(hint.startsWith(VIEW_TITLES[id]), `${id} keeps its title in the hint`);
    assert.ok(hint.includes(`Ctrl+${index + 1}`), `${id} shows the shortcut that reaches it`);
  });
});

test("an unavailable view says what to do, and Settings never does", () => {
  for (const id of VIEW_ORDER) {
    const hint = railHint(id, VIEW_ORDER, false);
    if (id === "settings") {
      assert.ok(!hint.includes("open a repository"), "Settings is reachable from a cold start");
    } else {
      assert.ok(hint.includes("open a repository first"), `${id} explains why it is greyed out`);
    }
  }
});

test("the hint follows the session instead of sticking to the item", () => {
  const before = railHint("changes", VIEW_ORDER, false);
  const after = railHint("changes", VIEW_ORDER, true);
  // The bug this guards: opening a repository re-assigned the same string, so
  // "open a repository first" stayed on every item for the rest of the session.
  assert.ok(before.includes("open a repository first"));
  assert.ok(!after.includes("open a repository"), "a hint written for the empty state is not kept");
  assert.equal(after, `${VIEW_TITLES.changes} (Ctrl+1)`);
});

test("each view is told apart by its own icon", () => {
  const icons = VIEW_ORDER.map((id) => VIEW_ICONS[id]);
  assert.equal(new Set(icons).size, icons.length, "no two views share an icon");
});
