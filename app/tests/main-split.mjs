import assert from "node:assert/strict";
import test from "node:test";
import {
  clampSplit,
  readStoredSplit,
  SPLIT_DEFAULT,
  SPLIT_MAX,
  SPLIT_MIN,
  splitFromPointer,
  stepSplit,
} from "../src/splitModel.ts";

test("both regions keep a readable share at every bound", () => {
  assert.ok(SPLIT_MIN <= SPLIT_DEFAULT && SPLIT_DEFAULT <= SPLIT_MAX);
  // The lower region is whatever the upper one does not take, so the bounds
  // have to leave the same floor on the other side or a drag could empty it.
  assert.ok(100 - SPLIT_MAX >= SPLIT_MIN);
  assert.ok(100 - SPLIT_MIN >= SPLIT_MAX);
});

test("a share outside the range is clamped, not dropped", () => {
  assert.equal(clampSplit(0), SPLIT_MIN);
  assert.equal(clampSplit(-40), SPLIT_MIN);
  assert.equal(clampSplit(100), SPLIT_MAX);
  assert.equal(clampSplit(60), 60);
});

test("a share that is not a number falls back to the default", () => {
  assert.equal(clampSplit(Number.NaN), SPLIT_DEFAULT);
  assert.equal(clampSplit(Number.POSITIVE_INFINITY), SPLIT_DEFAULT);
});

test("a stored share is only trusted after the clamp", () => {
  assert.equal(readStoredSplit(null), SPLIT_DEFAULT);
  assert.equal(readStoredSplit(""), SPLIT_DEFAULT);
  assert.equal(readStoredSplit("  "), SPLIT_DEFAULT);
  assert.equal(readStoredSplit("not a number"), SPLIT_DEFAULT);
  assert.equal(readStoredSplit("62"), 62);
  assert.equal(readStoredSplit("0"), SPLIT_MIN);
  assert.equal(readStoredSplit("140"), SPLIT_MAX);
});

test("a pointer position becomes a share of the two regions", () => {
  const geometry = { changesTop: 0, regionsHeight: 1000, grabOffset: 0 };
  assert.equal(splitFromPointer(450, geometry), 45);
  assert.equal(splitFromPointer(0, geometry), SPLIT_MIN);
  assert.equal(splitFromPointer(-20, geometry), SPLIT_MIN);
  assert.equal(splitFromPointer(1000, geometry), SPLIT_MAX);
  assert.equal(splitFromPointer(900, geometry), SPLIT_MAX);
});

test("an unmeasured panel keeps the default rather than inventing a share", () => {
  for (const regionsHeight of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(splitFromPointer(100, { changesTop: 0, regionsHeight, grabOffset: 0 }), SPLIT_DEFAULT);
  }
});

test("the search bar and app bar do not count toward a dragged region's height", () => {
  const geometry = { changesTop: 130, regionsHeight: 600, grabOffset: 2.5 };
  assert.equal(splitFromPointer(402.5, geometry), 45);
  assert.ok(Math.abs(splitFromPointer(462.5, geometry) - 55) < 1e-9);
});

test("grabbing either edge of the handle leaves the split in place", () => {
  for (const grabOffset of [-4, 0, 2.5, 9]) {
    const geometry = { changesTop: 130, regionsHeight: 600, grabOffset };
    assert.equal(splitFromPointer(400 + grabOffset, geometry), 45);
  }
});

test("scrolling the panel keeps the pointer and regions in the same coordinates", () => {
  const geometry = { changesTop: -70, regionsHeight: 600, grabOffset: 2.5 };
  assert.equal(splitFromPointer(202.5, geometry), 45);
  assert.equal(splitFromPointer(142.5, geometry), 35);
});

test("dragging away from a content floor starts at the rendered height", () => {
  const geometry = { changesTop: 90, regionsHeight: 400, grabOffset: 2.5 };
  assert.equal(splitFromPointer(352.5, geometry), 65);
  assert.equal(splitFromPointer(372.5, geometry), 70);
});

test("keyboard steps stop at the same bounds as the pointer", () => {
  let value = SPLIT_DEFAULT;
  for (let i = 0; i < 100; i++) value = stepSplit(value, 2);
  assert.equal(value, SPLIT_MAX);
  value = SPLIT_DEFAULT;
  for (let i = 0; i < 100; i++) value = stepSplit(value, -2);
  assert.equal(value, SPLIT_MIN);
  assert.equal(stepSplit(SPLIT_DEFAULT, 0), SPLIT_DEFAULT);
});
