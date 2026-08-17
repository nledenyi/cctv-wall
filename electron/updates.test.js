"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { describe } = require("./updates");

const packaged = (state) => describe({ packaged: true, ...state });

test("an idle install offers a check and nothing else", () => {
  const view = packaged({ status: "idle" });
  assert.equal(view.action, "check");
  assert.equal(view.label, "Check for updates");
});

test("a state nobody set is treated as idle", () => {
  assert.equal(packaged({}).action, "check");
});

test("an available update is downloaded on purpose, not on arrival", () => {
  const view = packaged({ status: "available", version: "0.3.0" });
  assert.equal(view.action, "download");
  assert.match(view.text, /0\.3\.0/);
});

test("a downloaded update installs on a second press, not the first", () => {
  const view = packaged({ status: "ready", version: "0.3.0" });
  assert.equal(view.action, "install");
  assert.equal(view.label, "Restart and install");
});

test("nothing is pressable while the app is busy", () => {
  assert.equal(packaged({ status: "checking" }).action, null);
  assert.equal(packaged({ status: "downloading", percent: 10 }).action, null);
});

test("progress is a whole number of percent", () => {
  assert.match(packaged({ status: "downloading", percent: 42.7 }).text, /43%/);
});

test("progress that is not a number reads as zero rather than NaN", () => {
  assert.match(packaged({ status: "downloading" }).text, /0%/);
  assert.match(
    packaged({ status: "downloading", percent: null }).text,
    /0%/,
  );
});

test("progress cannot leave the bar", () => {
  assert.match(packaged({ status: "downloading", percent: 130 }).text, /100%/);
  assert.match(packaged({ status: "downloading", percent: -5 }).text, /0%/);
});

test("being up to date still leaves a way to ask again", () => {
  const view = packaged({ status: "current" });
  assert.equal(view.action, "check");
  assert.match(view.text, /newest/);
});

test("an error is shown and is retryable", () => {
  const view = packaged({ status: "error", message: "net::ERR_FAILED" });
  assert.equal(view.action, "check");
  assert.equal(view.text, "net::ERR_FAILED");
});

test("an error with nothing to say still says something", () => {
  const view = packaged({ status: "error" });
  assert.ok(view.text.length > 0);
  assert.equal(view.action, "check");
});

test("an unpackaged run cannot update, whatever state it is in", () => {
  // running from source has no feed and no installer, and every state has to
  // say so: a Check button that throws is worse than one that explains
  for (const status of ["idle", "available", "ready", "error"]) {
    const view = describe({ packaged: false, status, version: "0.3.0" });
    assert.equal(view.action, null);
    assert.match(view.text, /installed app/);
  }
});
