import assert from "node:assert/strict";
import test from "node:test";
import { railHint, VIEW_ICONS, VIEW_TITLES } from "../src/railModel.ts";
import { VIEW_ORDER } from "../src/state.ts";

test("the panel has exactly two top-level pages", () => {
  assert.deepEqual([...VIEW_ORDER], ["main", "settings"]);
  assert.deepEqual(Object.keys(VIEW_TITLES), [...VIEW_ORDER]);
  assert.deepEqual(Object.keys(VIEW_ICONS), [...VIEW_ORDER]);
});

test("every tab names its page and the shortcut that reaches it", () => {
  VIEW_ORDER.forEach((id, index) => {
    const hint = railHint(id, VIEW_ORDER);
    assert.ok(hint.startsWith(VIEW_TITLES[id]), `${id} keeps its title in the hint`);
    assert.ok(hint.includes(`Ctrl+${index + 1}`), `${id} shows the shortcut that reaches it`);
  });
});

test("no tab waits for a repository", () => {
  // The rail this replaced greyed every repository-scoped item out until a
  // session opened. Main is now one of the two pages and shows the repository
  // entry as its own empty state, so a hint that told the user to open a
  // repository first would describe a page that does not exist.
  for (const id of VIEW_ORDER) {
    assert.ok(!railHint(id, VIEW_ORDER).includes("open a repository"), `${id} is reachable cold`);
  }
});

test("each page is told apart by its own icon", () => {
  const icons = VIEW_ORDER.map((id) => VIEW_ICONS[id]);
  assert.equal(new Set(icons).size, icons.length, "no two pages share an icon");
});
