"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cctv-config-"));

// config.js only wants a path out of electron, so it can be exercised without
// a running app
require.cache[require.resolve("electron")] = {
  exports: { app: { getPath: () => dir } },
};

const store = require("./config");

function loadWith(saved) {
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(saved));
  return store.load();
}

test("the old kiosk flag becomes kiosk mode", () => {
  assert.equal(loadWith({ fullscreen: true, kiosk: true }).windowMode, "kiosk");
});

test("the old fullscreen flag becomes fullscreen mode", () => {
  assert.equal(
    loadWith({ fullscreen: true, kiosk: false }).windowMode,
    "fullscreen",
  );
});

test("neither flag becomes window mode", () => {
  assert.equal(
    loadWith({ fullscreen: false, kiosk: false }).windowMode,
    "window",
  );
});

test("the combination that meant nothing resolves to kiosk", () => {
  // kiosk forced fullscreen, so this is what the old code did with it
  assert.equal(
    loadWith({ fullscreen: false, kiosk: true }).windowMode,
    "kiosk",
  );
});

test("a mode that is already set is left alone", () => {
  assert.equal(loadWith({ windowMode: "window" }).windowMode, "window");
});

test("a mode that is not a mode is read as an old config would be", () => {
  // fullscreen, not the first run default: an unusable mode means the file was
  // written before modes existed or by hand, and both are configured installs
  assert.equal(loadWith({ windowMode: "nonsense" }).windowMode, "fullscreen");
});

test("the old flags are not written back", () => {
  const config = loadWith({ fullscreen: false, kiosk: true });
  assert.ok(!("kiosk" in config));
  assert.ok(!("fullscreen" in config));
});

test("out of range numbers are clamped, not trusted", () => {
  const config = loadWith({ reloadHours: 720, idleReturnSeconds: -5 });
  assert.equal(config.reloadHours, store.MAX_RELOAD_HOURS);
  assert.equal(config.idleReturnSeconds, 0);
});

test("an unreadable config still starts the app, and starts it modestly", () => {
  // the same file held the Frigate host, so a config that cannot be read is a
  // first run whether or not it is the first one: there is nothing to show,
  // and the way out has to be reachable
  fs.writeFileSync(path.join(dir, "config.json"), "{ not json");
  const config = store.load();
  assert.equal(config.windowMode, "window");
  assert.equal(config.alwaysOnTop, false);
});

test("a first run is windowed and not pinned above everything", () => {
  fs.rmSync(path.join(dir, "config.json"), { force: true });
  const config = store.load();
  assert.equal(config.windowMode, "window");
  assert.equal(config.alwaysOnTop, false);
  // the pair that main.js reads as "nobody has configured this yet"
  assert.equal(config.frigateHost, "");
});

test("a saved config still decides, first run defaults do not leak into it", () => {
  const config = loadWith({
    frigateHost: "10.0.0.5:5000",
    windowMode: "kiosk",
    alwaysOnTop: true,
  });
  assert.equal(config.windowMode, "kiosk");
  assert.equal(config.alwaysOnTop, true);
});

test("the old quit shortcut becomes the escape shortcut", () => {
  const config = loadWith({ quitHotkey: "Control+Alt+K" });
  assert.equal(config.escapeHotkey, "Control+Alt+K");
  assert.ok(!("quitHotkey" in config));
});

test("an escape shortcut already set wins over the old key", () => {
  const config = loadWith({
    quitHotkey: "Control+Alt+K",
    escapeHotkey: "Control+Shift+E",
  });
  assert.equal(config.escapeHotkey, "Control+Shift+E");
});
