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

test("a pointer position becomes a share of the panel", () => {
  assert.equal(splitFromPointer(450, 1000), 45);
  assert.equal(splitFromPointer(0, 1000), SPLIT_MIN);
  assert.equal(splitFromPointer(-20, 1000), SPLIT_MIN);
  assert.equal(splitFromPointer(1000, 1000), SPLIT_MAX);
  assert.equal(splitFromPointer(900, 1000), SPLIT_MAX);
});

test("an unmeasured panel keeps the default rather than inventing a share", () => {
  assert.equal(splitFromPointer(100, 0), SPLIT_DEFAULT);
  assert.equal(splitFromPointer(100, Number.NaN), SPLIT_DEFAULT);
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
