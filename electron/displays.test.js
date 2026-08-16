"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { findDisplay, describeDisplay } = require("./displays");

const display = (id, label, x, y) => ({
  id,
  label,
  bounds: { x, y, width: 1920, height: 1080 },
});

const LAPTOP = display(1, "Built-in", 0, 0);
const WALL = display(2, "DELL U2723QE", 1920, 0);
const THIRD = display(3, "HP E243", -1920, 0);

const PRIMARY = LAPTOP;

test("no saved monitor means the primary", () => {
  assert.equal(findDisplay([LAPTOP, WALL], null, PRIMARY), PRIMARY);
});

test("the saved monitor is found by name", () => {
  const saved = { label: "DELL U2723QE", index: 1, originX: 1920, originY: 0 };
  assert.equal(findDisplay([LAPTOP, WALL], saved, PRIMARY), WALL);
});

test("a renumbered monitor is still found by name", () => {
  const saved = { label: "DELL U2723QE", index: 1, originX: 1920, originY: 0 };
  // same monitors, enumerated the other way round after a reboot
  assert.equal(findDisplay([WALL, LAPTOP], saved, PRIMARY), WALL);
});

test("a renamed monitor is found by where it sits", () => {
  const saved = { label: "gone", index: 9, originX: 1920, originY: 0 };
  assert.equal(findDisplay([LAPTOP, WALL], saved, PRIMARY), WALL);
});

test("a moved and renamed monitor falls back to its index", () => {
  const saved = { label: "gone", index: 1, originX: 5555, originY: 5555 };
  assert.equal(findDisplay([LAPTOP, WALL], saved, PRIMARY), WALL);
});

test("an unplugged monitor falls back to the primary", () => {
  const saved = { label: "gone", index: 7, originX: 5555, originY: 5555 };
  assert.equal(findDisplay([LAPTOP], saved, PRIMARY), PRIMARY);
});

test("a monitor to the left is matched on a negative origin", () => {
  const saved = { label: "gone", index: 9, originX: -1920, originY: 0 };
  assert.equal(findDisplay([LAPTOP, WALL, THIRD], saved, PRIMARY), THIRD);
});

test("an empty display list still returns something to open on", () => {
  const saved = { label: "DELL U2723QE", index: 1, originX: 1920, originY: 0 };
  assert.equal(findDisplay([], saved, PRIMARY), PRIMARY);
});

test("what is remembered is enough to find it again", () => {
  const displays = [LAPTOP, WALL];
  const saved = describeDisplay(displays, WALL);

  assert.deepEqual(saved, {
    label: "DELL U2723QE",
    index: 1,
    originX: 1920,
    originY: 0,
  });
  assert.equal(findDisplay(displays, saved, PRIMARY), WALL);
});
