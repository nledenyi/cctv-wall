"use strict";

const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  globalShortcut,
  ipcMain,
  powerSaveBlocker,
  screen,
  session,
} = require("electron");
const path = require("path");
const { pathToFileURL } = require("url");

const configStore = require("./config");
const { describe: describeUpdate } = require("./updates");

let config = null;
let win = null;
let settingsWin = null;
let tray = null;
let blockerId = null;
let reloadTimer = null;
let placeTimer = null;
let placed = null;
let quitting = false;
let escaped = false;
let hotkeyOk = true;
let updateState = { status: "idle" };
let updater = null;

/* ----------------------------------------------------------------- displays */

const {
  findDisplay: pickDisplay,
  describeDisplay: describe,
} = require("./displays");

const findDisplay = (saved) =>
  pickDisplay(screen.getAllDisplays(), saved, screen.getPrimaryDisplay());

const describeDisplay = (display) => describe(screen.getAllDisplays(), display);

/* ------------------------------------------------------------------ window */

function rendererUrl() {
  const url = pathToFileURL(path.join(__dirname, "..", "index.html"));
  url.search = new URLSearchParams({
    host: config.frigateHost,
    idle: String(config.idleReturnSeconds),
  }).toString();
  return url.href;
}

// the host as a certificate would name it: the setting may carry a scheme
// (wss://host:8971) and may carry a path, and neither is part of the identity
// being trusted below
const frigateAuthority = () =>
  String(config?.frigateHost ?? "")
    .replace(/^(wss?|https?):\/\//, "")
    .replace(/\/.*$/, "");

// the escape shortcut drops out of full screen without touching the saved
// mode, so an unattended wall goes back to kiosk on its next start rather
// than staying however someone left it
const effectiveMode = () => (escaped ? "window" : config.windowMode);
const isKiosk = () => effectiveMode() === "kiosk";
const isImmersive = () => effectiveMode() !== "window";

// a plain window belongs inside the work area, or it sits with its title bar
// against the top edge and its bottom behind the taskbar
const windowBounds = (display) =>
  isImmersive() ? display.bounds : display.workArea;

const windowState = (display) =>
  [display.id, effectiveMode(), config.alwaysOnTop].join("|");

/**
 * Windows rebuilds the taskbar button when the window enters full screen and
 * when it is shown, so asking once does not hold. It is re-asserted after
 * every transition that resets it, and the constructor is given the same
 * answer so the button is never created in the first place.
 */
function applyTaskbarButton() {
  if (!win || win.isDestroyed()) return;
  win.setSkipTaskbar(isKiosk());
}

function applyWindowSettings() {
  if (!win || win.isDestroyed()) return;

  // a queued placement is about to fight this one, and its display was
  // resolved from a monitor list that has since changed
  clearTimeout(placeTimer);
  placeTimer = null;

  const display = findDisplay(config.display);

  // Six things call this, including every settings save and all three screen
  // events. Without this guard each one is a full exit and re-enter of kiosk,
  // so saving an unrelated setting cycles the wall and the startup pass shows
  // it as a bordered window for the length of the transition.
  if (
    placed === windowState(display) &&
    screen.getDisplayMatching(win.getBounds()).id === display.id
  ) {
    return;
  }

  const wasImmersive = win.isKiosk() || win.isFullScreen();

  // a fullscreen window cannot be moved, so it has to come out first
  win.setKiosk(false);
  win.setFullScreen(false);
  win.setAlwaysOnTop(config.alwaysOnTop, "screen-saver");

  const place = () => {
    placeTimer = null;
    if (!win || win.isDestroyed()) return;

    // resolved again rather than captured: a monitor that was still settling
    // when this was queued reports different bounds by the time it runs
    const target = findDisplay(config.display);
    win.setBounds(windowBounds(target));

    if (isKiosk()) {
      win.setKiosk(true);
    } else if (isImmersive()) {
      win.setFullScreen(true);
    }

    applyTaskbarButton();
    placed = windowState(target);
    raiseSettings();
  };

  // leaving fullscreen is not instant on Windows, and a move issued in the
  // same tick is dropped, which is how a window ends up on the wrong monitor
  if (wasImmersive) placeTimer = setTimeout(place, 150);
  else place();
}

function createWindow() {
  const display = findDisplay(config.display);

  win = new BrowserWindow({
    ...windowBounds(display),
    backgroundColor: "#07080a",
    autoHideMenuBar: true,
    show: false,
    skipTaskbar: isKiosk(),
    icon: path.join(__dirname, "icon.png"),
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  // entering full screen is one of the transitions that puts the button back
  win.on("enter-full-screen", applyTaskbarButton);

  win.once("ready-to-show", () => {
    applyWindowSettings();
    win.show();
    // showing is the other transition that puts the button back
    applyTaskbarButton();
    raiseSettings();
  });

  // a dead renderer takes the wall down with it, so bring it back
  win.webContents.on("render-process-gone", () => {
    if (win && !win.isDestroyed()) win.reload();
  });

  // reload() reloads whatever the window is currently showing, so anything
  // that navigates it once, a file dropped on the kiosk being the realistic
  // one, becomes the thing the twelve hour timer keeps restoring
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  // Alt+F4 would otherwise take the wall down for good, since there is nothing
  // to restart it. Quitting from the tray or the shortcut still works, because
  // both go through app.quit(), which sets quitting first.
  win.on("close", (event) => {
    if (isKiosk() && !quitting) event.preventDefault();
  });

  win.on("closed", () => {
    win = null;
  });

  loadRenderer();
}

/**
 * Load the wall, logging in first if it is pointed at Frigate's TLS port.
 *
 * Awaited rather than fired alongside: the renderer opens its sockets as soon
 * as it parses, and a cookie that arrives after that is a cookie the handshake
 * did not carry.
 */
async function loadRenderer() {
  await loginToFrigate();
  if (win && !win.isDestroyed()) win.loadURL(rendererUrl());
}

/* ---------------------------------------------------------------- settings */

function applyPowerSave() {
  const wanted = config.keepDisplayAwake;

  if (wanted && blockerId === null) {
    blockerId = powerSaveBlocker.start("prevent-display-sleep");
  } else if (!wanted && blockerId !== null) {
    powerSaveBlocker.stop(blockerId);
    blockerId = null;
  }
}

function applyAutoStart() {
  // not meaningful unpackaged, and would register the electron binary itself
  if (!app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: config.autoStart });
}

function toggleEscape() {
  escaped = !escaped;
  applyWindowSettings();
  buildTrayMenu();
}

function applyHotkey() {
  globalShortcut.unregisterAll();
  hotkeyOk = true;
  if (!config.escapeHotkey) return true;

  try {
    hotkeyOk = globalShortcut.register(config.escapeHotkey, toggleEscape);
  } catch (err) {
    // an accelerator electron cannot parse throws out of register rather than
    // returning false, and this runs inside applyAll, so letting it escape
    // takes the reload timer and the screen listeners down with it
    console.warn(
      `escape shortcut ${config.escapeHotkey} is not valid:`,
      err.message,
    );
    hotkeyOk = false;
    return false;
  }

  if (!hotkeyOk) {
    // another application got there first, which is silent unless it is said
    // somewhere: the settings window reads this back
    console.warn(`escape shortcut ${config.escapeHotkey} is already taken`);
  }
  return hotkeyOk;
}

function applyReloadTimer() {
  clearInterval(reloadTimer);
  reloadTimer = null;

  // setInterval clamps a delay over about 24.8 days to 1ms, which would turn
  // a large hours value into a continuous reload rather than never
  const hours = Math.min(
    Math.max(Number(config.reloadHours) || 0, 0),
    configStore.MAX_RELOAD_HOURS,
  );
  if (!hours) return;

  // a page that runs for months leaks somewhere; reloading it is cheap
  reloadTimer = setInterval(
    () => {
      // loadRenderer rather than reload: this is also the only thing that runs
      // on a wall left alone for weeks, so it is where an expired Frigate
      // session gets renewed
      if (win && !win.isDestroyed()) loadRenderer();
    },
    hours * 60 * 60 * 1000,
  );
}

function applyAll({ reloadRenderer } = {}) {
  applyWindowSettings();
  applyPowerSave();
  applyAutoStart();
  const hotkeyOk = applyHotkey();
  applyReloadTimer();
  buildTrayMenu();

  if (reloadRenderer && win && !win.isDestroyed()) loadRenderer();

  return hotkeyOk;
}

/* -------------------------------------------------------------------- tray */

function buildTrayMenu() {
  if (!tray) return;

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Settings", click: openSettings },
      {
        label: "Reload",
        click: () => win && !win.isDestroyed() && win.reload(),
      },
      // the shortcut can be taken by another application, so this is the
      // route out of kiosk that cannot fail to register
      ...(config.windowMode === "window"
        ? []
        : [
            {
              label: escaped ? "Back to full screen" : "Leave full screen",
              click: toggleEscape,
            },
          ]),
      {
        label: "Always on top",
        type: "checkbox",
        checked: config.alwaysOnTop,
        click: (item) => {
          config.alwaysOnTop = item.checked;
          configStore.save(config);
          applyWindowSettings();
        },
      },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() },
    ]),
  );
}

function createTray() {
  tray = new Tray(path.join(__dirname, "tray.png"));
  tray.setToolTip("CCTV Wall");
  tray.on("double-click", () => win && !win.isDestroyed() && win.show());
  buildTrayMenu();
}

/* --------------------------------------------------------- settings window */

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) return settingsWin.focus();

  // open on whichever screen the wall is on, and never taller than that
  // screen: the settings are worth nothing if half of them are off the bottom
  const on =
    win && !win.isDestroyed()
      ? screen.getDisplayMatching(win.getBounds())
      : screen.getPrimaryDisplay();

  const width = 560;
  const height = Math.min(800, on.workAreaSize.height - 80);

  settingsWin = new BrowserWindow({
    width,
    height,
    // without these the window is centered on the primary display, so its
    // height would be computed for one monitor and shown on another
    x: Math.round(on.workArea.x + (on.workArea.width - width) / 2),
    y: Math.round(on.workArea.y + (on.workArea.height - height) / 2),
    useContentSize: true,
    title: "CCTV Wall settings",
    backgroundColor: "#0f1216",
    autoHideMenuBar: true,
    // above a kiosk window, or it opens behind the thing you want to fix
    alwaysOnTop: true,
    icon: path.join(__dirname, "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  settingsWin.on("closed", () => {
    settingsWin = null;
  });

  settingsWin.loadFile(path.join(__dirname, "settings.html"));
}

/**
 * Put the settings window back above the wall.
 *
 * Both windows ask for always-on-top, so between them the order is decided by
 * whichever was raised last, and the wall is raised on a schedule of its own:
 * ready-to-show waits for the renderer, which waits for a Frigate login, and
 * applyWindowSettings runs again every time a monitor settles. Raising the
 * settings window once when it opens is therefore not enough - on a first run
 * it opens first and is buried a moment later. Every path that raises the wall
 * calls this after it.
 */
function raiseSettings() {
  if (!settingsWin || settingsWin.isDestroyed()) return;
  // moveTop for the z-order, focus for the keyboard: a window can be visible
  // and still not be where typing goes
  settingsWin.moveTop();
  settingsWin.focus();
}

/* ----------------------------------------------------------------- updates */

const updateView = () =>
  describeUpdate({ ...updateState, packaged: app.isPackaged });

function setUpdateState(patch) {
  updateState = { ...updateState, ...patch };
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.webContents.send("update:state", updateView());
  }
}

/**
 * electron-updater, or null when there is nothing it could do.
 *
 * Required here rather than at the top, and only once, because an unpackaged
 * run has no feed to read and no installer to run: loading it at all would be
 * to set up an updater for an app that cannot be updated.
 *
 * Both autos are off, which is the entire policy. The wall runs unattended in
 * front of a screen nobody is sitting at, so an update that downloads itself
 * or installs itself on quit is an update that takes the cameras away at a
 * moment nobody chose. Every step below is a press.
 */
function getUpdater() {
  if (!app.isPackaged) return null;
  if (updater) return updater;

  updater = require("electron-updater").autoUpdater;
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;

  updater.on("update-available", (info) =>
    setUpdateState({ status: "available", version: info?.version }),
  );
  updater.on("update-not-available", () => setUpdateState({ status: "current" }));
  updater.on("download-progress", (progress) =>
    setUpdateState({ status: "downloading", percent: progress?.percent }),
  );
  updater.on("update-downloaded", (info) =>
    setUpdateState({ status: "ready", version: info?.version }),
  );
  updater.on("error", (err) =>
    setUpdateState({ status: "error", message: String(err?.message || err) }),
  );

  return updater;
}

ipcMain.handle("update:state", () => updateView());

ipcMain.handle("update:act", async (_event, action) => {
  const auto = getUpdater();
  if (!auto) return updateView();

  try {
    if (action === "check") {
      setUpdateState({ status: "checking" });
      await auto.checkForUpdates();
    } else if (action === "download") {
      setUpdateState({ status: "downloading", percent: 0 });
      await auto.downloadUpdate();
    } else if (action === "install") {
      // silent, because an installer waiting to be clicked through on a wall
      // display is an app that never comes back, and relaunched, because
      // start-with-Windows is the only other thing that would start it and it
      // is off by default
      auto.quitAndInstall(true, true);
    }
  } catch (err) {
    // these reject and emit error, so this is usually the second one to say
    // so. It is here for the one that only rejects.
    setUpdateState({ status: "error", message: String(err?.message || err) });
  }

  return updateView();
});

ipcMain.handle("config:get", () => {
  const displays = screen.getAllDisplays();
  const resolved = findDisplay(config.display);

  return {
    config,
    version: app.getVersion(),
    // reported on open, not only after a save: a shortcut that never
    // registered is otherwise a key that silently does nothing
    hotkeyOk,
    escaped,
    // the window opens on whatever findDisplay picks, so the picker is told
    // that answer rather than restating the matching rules and drifting
    resolvedDisplayIndex: displays.findIndex((d) => d.id === resolved.id),
    displays: displays.map((d, index) => ({
      label: d.label,
      index,
      width: d.bounds.width,
      height: d.bounds.height,
      primary: d.id === screen.getPrimaryDisplay().id,
    })),
  };
});

ipcMain.handle("config:save", (_event, next) => {
  const hostChanged = next.frigateHost !== config.frigateHost;
  const idleChanged = next.idleReturnSeconds !== config.idleReturnSeconds;
  // new credentials are worth nothing until the renderer is reloaded with the
  // cookie they buy, and the reload is where the login happens
  const loginChanged =
    next.frigateUser !== config.frigateUser ||
    next.frigatePassword !== config.frigatePassword;

  config = { ...config, ...next };
  configStore.save(config);
  const hotkeyOk = applyAll({
    reloadRenderer: hostChanged || idleChanged || loginChanged,
  });

  // the settings window shows this next to the field, since a shortcut that
  // did not take is the difference between leaving kiosk and not
  return { config, hotkeyOk };
});

ipcMain.handle("config:pickDisplay", (_event, index) => {
  const displays = screen.getAllDisplays();
  config.display = displays[index] ? describeDisplay(displays[index]) : null;
  configStore.save(config);
  applyWindowSettings();
  return config.display;
});

/* ------------------------------------------------------------------- login */

/**
 * Log in to Frigate and put the session cookie where the renderer's sockets
 * will carry it.
 *
 * Only needed for Frigate's TLS port: a stock install has auth.enabled true and
 * guards /ws and /live/ behind it. Two details make this work where a browser
 * page cannot:
 *
 * - Frigate's CSRF check passes any request with no Origin header, which is
 *   what a request from here is. A page always sends one and never gets the
 *   preflight it would need.
 * - The renderer runs at file://, so a wss:// socket to Frigate is cross-site
 *   and Chromium would drop a cookie without an explicit SameSite. We own the
 *   cookie jar, so it is stored with sameSite "no_restriction".
 */
async function loginToFrigate() {
  const host = frigateAuthority();
  if (!host || !config.frigateUser || !config.frigatePassword) return;

  // the http port needs no login, and sending credentials to it in the clear
  // would be a worse default than not being logged in
  if (!/^(wss|https):\/\//i.test(config.frigateHost)) return;

  const body = JSON.stringify({
    user: config.frigateUser,
    password: config.frigatePassword,
  });

  const setCookie = await new Promise((resolve) => {
    const req = require("https").request(
      {
        host: host.split(":")[0],
        port: Number(host.split(":")[1]) || 443,
        path: "/api/login",
        method: "POST",
        timeout: 8000,
        rejectUnauthorized: false,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        res.resume();
        if (res.statusCode !== 200) {
          console.warn("frigate login rejected:", res.statusCode);
          return resolve(null);
        }
        resolve([].concat(res.headers["set-cookie"] || [])[0] || null);
      },
    );

    req.on("timeout", () => req.destroy());
    req.on("error", (err) => {
      console.warn("frigate login failed:", err.message);
      resolve(null);
    });
    req.end(body);
  });

  if (!setCookie) return;

  // the cookie name is configurable in Frigate (auth.cookie_name), so it is
  // read back off the response rather than assumed to be frigate_token
  const [pair] = setCookie.split(";");
  const index = pair.indexOf("=");
  if (index < 1) return;

  try {
    await session.defaultSession.cookies.set({
      url: `https://${host}`,
      name: pair.slice(0, index).trim(),
      value: pair.slice(index + 1).trim(),
      secure: true,
      httpOnly: true,
      sameSite: "no_restriction",
    });
  } catch (err) {
    console.warn("could not store the frigate cookie:", err.message);
  }
}

/* ------------------------------------------------------------------- probe */

// The two places a Frigate answers, in the order worth trying. 5000 is the
// unauthenticated http port; 8971 is TLS and, on a stock Frigate, wants a
// login. Both are published by the official compose file.
const CANDIDATES = [
  { scheme: "http", port: 5000, answer: (h) => `${h}:5000` },
  { scheme: "https", port: 8971, answer: (h) => `wss://${h}:8971` },
];

/**
 * Ask one candidate whether a Frigate is listening.
 *
 * Any HTTP reply counts, including 401: a stock Frigate requires auth on 8971,
 * so demanding a 200 would report the secure port as absent. What is being
 * tested is "is it there", not "may I in", and the certificate is not verified
 * because Frigate signs its own.
 */
function probeOne(host, candidate) {
  return new Promise((resolve) => {
    const lib = candidate.scheme === "https" ? require("https") : require("http");
    const req = lib.request(
      {
        host,
        port: candidate.port,
        path: "/api/version",
        method: "GET",
        timeout: 3000,
        rejectUnauthorized: false,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode > 0);
      },
    );

    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
    req.end();
  });
}

// bare "10.0.0.5" is what someone types; anything more specific is a decision
// they have already made and is left alone
const isBareHost = (value) => /^[a-z0-9.-]+$/i.test(value);

ipcMain.handle("frigate:test", async (_event, raw) => {
  const value = String(raw || "").trim();
  if (!value) return { ok: false, message: "Enter an address first" };

  if (!isBareHost(value)) {
    return { ok: false, message: "Enter just the host, without port or scheme" };
  }

  for (const candidate of CANDIDATES) {
    if (await probeOne(value, candidate)) {
      const answer = candidate.answer(value);
      return {
        ok: true,
        host: answer,
        message:
          candidate.port === 8971
            ? `Found Frigate on ${answer}. This port needs a login`
            : `Found Frigate on ${answer}`,
      };
    }
  }

  return { ok: false, message: `No Frigate on ${value}, ports 5000 or 8971` };
});

/* ------------------------------------------------------------------- start */

// a second copy would fight the first one for always-on-top
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win && !win.isDestroyed()) win.show();
    // the realistic second launch is someone double-clicking the shortcut
    // again because the first one looked like it did nothing, which is exactly
    // the first run this must not bury the settings window on
    raiseSettings();
  });

  // Frigate generates its own certificate for its TLS port, so wss:// to it
  // fails verification and the socket dies with nothing a page can catch.
  // The exception is granted to the configured host and to nothing else: a
  // blanket accept would cover every request this app ever makes, and the
  // point of pointing it at wss:// was to stop trusting the network.
  app.on("certificate-error", (event, _contents, url, _error, _cert, callback) => {
    let host;
    try {
      host = new URL(url).host;
    } catch {
      return callback(false);
    }

    if (host && host === frigateAuthority()) {
      event.preventDefault();
      return callback(true);
    }
    callback(false);
  });

  app
    .whenReady()
    .then(() => {
      config = configStore.load();

      // the default menu is installed unless one is set, and it keeps
      // Ctrl+Q, Ctrl+W, Ctrl+Shift+I and F11 live behind a hidden menu bar,
      // which is every way out of the kiosk the settings page says it closes
      Menu.setApplicationMenu(null);

      createWindow();
      createTray();

      // monitors can enumerate after the app is already up, DisplayLink
      // especially, so place the window again once things have settled.
      // Registered before applyAll so a bad setting cannot take them with it.
      screen.on("display-added", applyWindowSettings);
      screen.on("display-removed", applyWindowSettings);
      screen.on("display-metrics-changed", applyWindowSettings);
      setTimeout(applyWindowSettings, 4000);

      applyAll();

      // A first run has nowhere to connect to, and the wall's own answer for
      // that is a reconnect loop behind a "Check the Frigate address" line:
      // the right message in the wrong place, full screen and on top, with the
      // settings window it is asking for nowhere in sight. Open it.
      //
      // After applyAll, not before: both windows want always-on-top, so the
      // one raised last is the one you can actually reach. That is necessary
      // and not sufficient - the wall raises itself again later, from
      // ready-to-show and from every monitor change - so raiseSettings runs
      // after each of those too.
      if (!config.frigateHost) openSettings();
    })
    .catch((err) => {
      // a packaged windows app has no console, so an unhandled rejection here
      // is a wall that half started with nothing said about it
      console.error("startup failed:", err);
    });

  app.on("before-quit", () => {
    quitting = true;
  });

  app.on("window-all-closed", () => app.quit());

  app.on("will-quit", () => {
    globalShortcut.unregisterAll();
    clearInterval(reloadTimer);
    clearTimeout(placeTimer);
    if (blockerId !== null) powerSaveBlocker.stop(blockerId);
  });
}
