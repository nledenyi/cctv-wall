"use strict";

/**
 * What the settings page shows for an update, as one button and one line.
 *
 * The renderer cannot require anything, so main describes the state and the
 * page paints it: `action` is what a press means and `label` is what the
 * button says, which are not the same thing in either direction. A state with
 * no action is one where pressing would mean nothing, and the button is
 * disabled rather than removed so the row does not move while you look at it.
 *
 * Nothing here starts anything. Every transition below is something the user
 * pressed, which is the whole point: the wall runs unattended, so an updater
 * that acts on its own is an updater that reboots a camera wall at a time
 * nobody chose.
 */

const clampPercent = (value) =>
  Math.min(Math.max(Math.round(Number(value) || 0), 0), 100);

function describe(state) {
  // an unpackaged run has no update feed to read and no installer to run, and
  // saying so is kinder than the raw "dev-app-update.yml not found"
  if (!state.packaged) {
    return {
      text: "Updates are only available in the installed app.",
      action: null,
      label: "Check for updates",
    };
  }

  switch (state.status) {
    case "checking":
      return { text: "Checking...", action: null, label: "Checking..." };

    case "available":
      return {
        text: `Version ${state.version} is available.`,
        action: "download",
        label: "Update now",
      };

    case "downloading":
      return {
        text: `Downloading... ${clampPercent(state.percent)}%`,
        action: null,
        label: "Downloading...",
      };

    case "ready":
      return {
        text: `Version ${state.version} is downloaded. The wall closes and comes back on the new version.`,
        action: "install",
        label: "Restart and install",
      };

    case "current":
      return {
        text: "This is the newest version.",
        action: "check",
        label: "Check for updates",
      };

    // the message is whatever electron-updater said, which is not always
    // readable, but a wrong-looking message beats a button that did nothing
    case "error":
      return {
        text: state.message || "The check failed.",
        action: "check",
        label: "Check again",
      };

    default:
      return { text: "", action: "check", label: "Check for updates" };
  }
}

module.exports = { describe };
