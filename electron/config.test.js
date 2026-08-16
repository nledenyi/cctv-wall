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

test("a mode that is not a mode falls back to the default", () => {
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

test("an unreadable config still starts the app", () => {
  fs.writeFileSync(path.join(dir, "config.json"), "{ not json");
  assert.equal(store.load().windowMode, "fullscreen");
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
