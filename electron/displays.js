"use strict";

/**
 * Pick the monitor the wall should open on.
 *
 * Windows renumbers displays across reboots, driver updates and replugs, so a
 * saved display id is worthless. Match on the things that tend to stay put,
 * and give up to the primary rather than opening the window at coordinates no
 * monitor covers, which on a wall looks exactly like a crash.
 *
 * Takes the display list rather than reaching for electron's screen module, so
 * the fallback chain can be exercised without a running app.
 */
function findDisplay(displays, saved, primary) {
  if (!displays.length) return primary;
  if (!saved) return primary;

  return (
    (saved.label && displays.find((d) => d.label === saved.label)) ||
    displays.find(
      (d) => d.bounds.x === saved.originX && d.bounds.y === saved.originY,
    ) ||
    displays[saved.index] ||
    primary
  );
}

/** What to remember about a monitor so it can be found again later. */
function describeDisplay(displays, display) {
  const index = displays.findIndex((d) => d.id === display.id);
  return {
    label: display.label,
    index: Math.max(index, 0),
    originX: display.bounds.x,
    originY: display.bounds.y,
  };
}

module.exports = { findDisplay, describeDisplay };
