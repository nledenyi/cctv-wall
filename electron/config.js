"use strict";

const fs = require("fs");
const path = require("path");
const { app } = require("electron");

const DEFAULTS = {
  // empty on purpose: it is how first run is recognised, see main.js
  frigateHost: "",
  // only needed for Frigate's TLS port, which requires a login on a stock
  // install. Stored as typed, in a plain file: see the note in settings.html
  frigateUser: "",
  frigatePassword: "",
  alwaysOnTop: true,
  // window | fullscreen | kiosk, in increasing order of how stuck you are
  windowMode: "fullscreen",
  autoStart: false,
  keepDisplayAwake: true,
  escapeHotkey: "Control+Shift+Q",
  idleReturnSeconds: 60,
  reloadHours: 12,
  // what the chosen monitor looked like, not its id: see main.js findDisplay
  display: null,
};

// setInterval clamps a delay over about 24.8 days to 1ms, so an hours value
// with nothing holding it down turns into a continuous reload loop
const MAX_RELOAD_HOURS = 168;
const MAX_IDLE_SECONDS = 86400;

const file = () => path.join(app.getPath("userData"), "config.json");

const clamp = (value, max) =>
  Math.min(Math.max(Math.round(Number(value) || 0), 0), max);

const MODES = ["window", "fullscreen", "kiosk"];

/**
 * Fold the old fullscreen and kiosk booleans into one mode.
 *
 * They overlapped: kiosk forced full screen, so "kiosk on, full screen off"
 * was a state you could save that meant nothing. Kiosk wins, which is what
 * the code did with them anyway.
 */
function migrate(saved, config) {
  // read the saved file, not the merged result: the defaults always supply a
  // valid windowMode, so merging first hides the fact that the file had none
  if (!MODES.includes(saved.windowMode)) {
    config.windowMode = saved.kiosk
      ? "kiosk"
      : saved.fullscreen === false
        ? "window"
        : "fullscreen";
  }

  // it stopped quitting and started letting you out of kiosk, so the name
  // was describing something it no longer did
  if (typeof saved.escapeHotkey !== "string" && saved.quitHotkey) {
    config.escapeHotkey = saved.quitHotkey;
  }

  delete config.kiosk;
  delete config.fullscreen;
  delete config.quitHotkey;
  return config;
}

function load() {
  try {
    const saved = JSON.parse(fs.readFileSync(file(), "utf8"));
    const config = migrate(saved, { ...DEFAULTS, ...saved });

    // the settings window is not the only way these get set: the file is
    // editable by hand, and out of range numbers matter here
    config.reloadHours = clamp(config.reloadHours, MAX_RELOAD_HOURS);
    config.idleReturnSeconds = clamp(
      config.idleReturnSeconds,
      MAX_IDLE_SECONDS,
    );

    return config;
  } catch {
    // a missing or unreadable config is not worth refusing to start over
    return { ...DEFAULTS };
  }
}

function save(config) {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(config, null, 2));
}

module.exports = { load, save, MAX_RELOAD_HOURS, MAX_IDLE_SECONDS };
