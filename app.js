"use strict";

// The page is served next to a proxy that forwards ws and live to Frigate, so
// its own origin and its own directory are the default: on the static host the
// page sits at /<slug>/ and the proxy sits beside it, not at the root.
// ?host=10.0.0.5:5000 talks to a Frigate directly instead.
//
// There is deliberately no fallback address. A file:// load with no ?host= has
// nothing to guess at, and a wrong guess costs more than an empty one: it looks
// like a broken app rather than an unconfigured one. Empty fails the URL parse
// below, which is already the "Check the Frigate address" path.
const DEFAULT_HOST = "";

const HOST_OVERRIDE = new URLSearchParams(location.search).get("host");
const SERVED =
  !HOST_OVERRIDE && /^https?:$/.test(location.protocol) && Boolean(location.host);

const HOST = HOST_OVERRIDE || (SERVED ? location.host : DEFAULT_HOST);
const BASE = SERVED ? location.pathname.replace(/\/[^/]*$/, "") : "";

/**
 * Where the two sockets live, as a scheme and an authority.
 *
 * Frigate's own TLS port (8971) is wss no matter what this page was loaded
 * over, and a page from file:// or from serve.py has no https to inherit, so
 * the scheme has to be sayable on its own: ?host=wss://frigate.example.com:8971
 * reaches Frigate directly, with nothing proxying in between.
 *
 * Without a scheme the page's own protocol decides, which is what a page
 * sitting next to a proxy wants, and is what every existing URL means.
 */
function wsBase(target, base) {
  const scheme = /^(wss?|https?):\/\//.exec(target);
  if (!scheme) {
    return (location.protocol === "https:" ? "wss://" : "ws://") + target + base;
  }

  // a trailing slash would double up against the /ws and /live/ that get
  // appended, and a path is kept: it is how a Frigate behind a reverse proxy
  // on a subpath is reachable
  const rest = target.slice(scheme[0].length).replace(/\/+$/, "");
  const secure = scheme[1] === "wss" || scheme[1] === "https";
  return `${secure ? "wss" : "ws"}://${rest}${base}`;
}

const WS_BASE = wsBase(HOST, BASE);

const BIRDSEYE = "birdseye";

// Codecs offered to go2rtc, narrowed to what this browser can actually play.
const CODECS = [
  "avc1.640029",
  "avc1.64002A",
  "avc1.640033",
  "hvc1.1.6.L153.B0",
  "mp4a.40.2",
  "mp4a.40.5",
  "flac",
  "opus",
].filter((c) =>
  MediaSource.isTypeSupported(
    `${c.startsWith("avc1") || c.startsWith("hvc1") ? "video" : "audio"}/mp4; codecs="${c}"`,
  ),
);

const video = document.getElementById("video");
const cameraVideo = document.getElementById("camera-video");
const placeholder = document.getElementById("placeholder");
const stage = document.getElementById("stage");
const highlight = document.getElementById("highlight");
const highlightLabel = document.getElementById("highlight-label");
const statusEl = document.getElementById("status");
const statusText = document.getElementById("status-text");
const spinner = document.getElementById("spinner");

const pretty = (name) => name.charAt(0).toUpperCase() + name.slice(1);

/* ------------------------------------------------------------------ status */

let statusTimer = null;

function setStatus(text, kind) {
  statusText.textContent = text;
  statusEl.className = `status show ${kind}`;
  clearTimeout(statusTimer);

  // a healthy state is worth confirming once, not worth keeping on a wall
  if (kind === "ok") {
    statusTimer = setTimeout(() => statusEl.classList.remove("show"), 2200);
  }
}

function clearStatus() {
  clearTimeout(statusTimer);
  statusEl.classList.remove("show");
}

/* ------------------------------------------------------------------ player */

/**
 * Plays a go2rtc stream into a video element over MSE, and keeps it playing:
 * a closed socket reconnects with backoff, and a picture that stops advancing
 * is treated the same way as a closed socket.
 */
class MsePlayer {
  constructor(el) {
    this.video = el;
    this.src = null;
    this.ws = null;
    this.media = null;
    this.retry = 0;
    this.reconnectTimer = null;
    this.lastProgress = 0;
    this.lastTime = -1;
    setInterval(() => this.checkProgress(), 2000);
  }

  play(src) {
    this.src = src;
    this.retry = 0;
    this.open();
  }

  stop() {
    this.src = null;
    this.teardown();
    // both players write to the one status element, so a red chip from the
    // camera would otherwise stay pinned to a healthy wall
    clearStatus();
  }

  open() {
    this.teardown();

    const src = this.src;
    let ws;

    try {
      ws = new WebSocket(
        `${WS_BASE}/live/mse/api/ws?src=${encodeURIComponent(src)}`,
      );
    } catch (err) {
      // a host the URL parser rejects throws here, and this runs at module
      // scope, so letting it out leaves a page with no listeners at all
      console.warn("could not open stream socket", err.message);
      setStatus("Check the Frigate address", "bad");
      return this.reconnect();
    }

    ws.binaryType = "arraybuffer";
    this.ws = ws;

    let sourceBuffer = null;
    const queue = [];

    const drain = () => {
      if (!sourceBuffer || sourceBuffer.updating || !queue.length) return;
      try {
        sourceBuffer.appendBuffer(queue.shift());
      } catch (err) {
        console.warn("appendBuffer failed", err);
      }
    };

    // the media source is only opened once the socket is, so the codecs it
    // asks for cannot be sent before there is something to send them on
    ws.onopen = () => {
      const media = new MediaSource();
      this.media = media;

      media.addEventListener(
        "sourceopen",
        () => {
          URL.revokeObjectURL(this.video.src);
          ws.send(JSON.stringify({ type: "mse", value: CODECS.join() }));
        },
        { once: true },
      );

      this.video.src = URL.createObjectURL(media);
      this.video.play().catch(() => {});
    };

    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") {
        queue.push(ev.data);
        drain();
        return;
      }

      const msg = JSON.parse(ev.data);

      // go2rtc answers an unknown stream with {"type":"error"} and then says
      // nothing at all. Dropping it here is what made the documented
      // prerequisite look like a broken app: Frigate restreams birdseye by
      // itself but never the cameras, so a tile stays black with no error
      // until its go2rtc.streams entry exists. Say which, and stop: a missing
      // config entry does not appear by retrying.
      if (msg.type === "error") {
        console.warn("stream error", msg.value);
        this.fail(
          /not found/i.test(msg.value || "")
            ? `${pretty(src === BIRDSEYE ? "wall" : src)} is not restreamed by go2rtc. Add it to go2rtc.streams in the Frigate config`
            : `${pretty(src === BIRDSEYE ? "wall" : src)}: ${msg.value}`,
        );
        return;
      }

      if (msg.type !== "mse" || sourceBuffer || !this.media) return;

      const media = this.media;
      sourceBuffer = media.addSourceBuffer(msg.value);
      sourceBuffer.mode = "segments";
      sourceBuffer.addEventListener("updateend", () => {
        drain();
        this.trim(sourceBuffer, media);
      });
      this.retry = 0;
      setStatus(`${pretty(src === BIRDSEYE ? "wall" : src)} connected`, "ok");
    };

    ws.onclose = () => this.reconnect();
    ws.onerror = () => ws.close();
  }

  /** Drop what has been played and stay near the live edge. */
  trim(sourceBuffer, media) {
    if (sourceBuffer.updating || !sourceBuffer.buffered.length) return;

    const start = sourceBuffer.buffered.start(0);
    const end = sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1);

    if (end - start > 15) {
      try {
        sourceBuffer.remove(start, end - 15);
        media.setLiveSeekableRange(end - 15, end);
      } catch (err) {
        console.warn("remove failed", err);
      }
    }

    // A tab that was hidden, or a decoder that could not keep up, leaves the
    // picture behind. Skipping to the edge would starve it again straight
    // away, so leave a second of buffer to play out of.
    if (end - this.video.currentTime > 5) {
      this.video.currentTime = end - 1;
    }
  }

  checkProgress() {
    if (!this.src || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const now = Date.now();
    if (this.video.currentTime !== this.lastTime) {
      this.lastTime = this.video.currentTime;
      this.lastProgress = now;
      return;
    }

    if (this.lastProgress && now - this.lastProgress > 6000) {
      console.warn("stream stalled, reconnecting");
      setStatus("Stream stalled", "warn");
      this.ws.close();
    }
  }

  /**
   * Stop for a reason that will not fix itself, and leave the reason on screen.
   *
   * Separate from reconnect() on purpose: the retry countdown overwrites the
   * status every couple of seconds, so a configuration error announced through
   * that path is unreadable within moments of being correct.
   */
  fail(message) {
    this.src = null;
    this.teardown();
    setStatus(message, "bad");
  }

  reconnect() {
    if (this.reconnectTimer) return;

    const wait = Math.min(1000 * 2 ** this.retry++, 10000);
    setStatus(`Reconnecting in ${Math.round(wait / 1000)}s`, "bad");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, wait);
  }

  teardown() {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.lastProgress = 0;
    this.lastTime = -1;

    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      this.ws.onopen = null;
      this.ws.close();
      this.ws = null;
    }

    // an abandoned media source holds on to its decoder, so switching between
    // streams without closing it out leaves the picture starved of one
    if (this.media) {
      try {
        if (this.media.readyState === "open") this.media.endOfStream();
      } catch (err) {
        console.warn("endOfStream failed", err);
      }
      this.media = null;
      this.video.removeAttribute("src");
      this.video.load();
    }
  }
}

/* ------------------------------------------------------------------ layout */

/**
 * Keeps the birdseye layout Frigate publishes: which camera is drawn into
 * which rectangle of the composed canvas.
 */
class LayoutFeed {
  constructor(onChange) {
    this.onChange = onChange;
    this.cells = {};
    this.retry = 0;
    this.open();
  }

  retryLater() {
    setTimeout(() => this.open(), Math.min(1000 * 2 ** this.retry++, 10000));
  }

  open() {
    // nothing configured to connect to: see the wiring at the bottom, which
    // says so once rather than retrying an address that does not exist
    if (!HOST) return;

    let ws;

    try {
      ws = new WebSocket(`${WS_BASE}/ws`);
    } catch (err) {
      // constructed at module scope, so a host the URL parser rejects would
      // take the rest of the page down with it
      console.warn("could not open layout socket", err.message);
      return this.retryLater();
    }

    ws.onopen = () => {
      // the layout is only pushed when it changes, so ask for the current one
      ws.send(JSON.stringify({ topic: "birdseyeLayout" }));
    };

    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.topic !== "birdseye_layout") return;

      const payload =
        typeof msg.payload === "string" ? JSON.parse(msg.payload) : msg.payload;
      if (!payload) return;

      // reset on real data, not on the handshake: Frigate accepts and then
      // drops connections while it restarts, which would peg the backoff at
      // its first step and open one socket a second for the whole outage
      this.retry = 0;
      this.cells = payload;
      this.onChange(payload);
    };

    ws.onerror = () => ws.close();
    ws.onclose = () => this.retryLater();
  }

  /** The camera drawn at a point in canvas pixels, if any. */
  at(x, y) {
    for (const [camera, cell] of Object.entries(this.cells)) {
      if (
        x >= cell.x &&
        x < cell.x + cell.width &&
        y >= cell.y &&
        y < cell.y + cell.height
      ) {
        return camera;
      }
    }
    return null;
  }
}

/* -------------------------------------------------------------- projection */

/**
 * The video is letterboxed by object-fit: contain, so the picture is not the
 * element. Everything below converts between the two.
 */
function projection() {
  const rect = video.getBoundingClientRect();
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return null;

  const scale = Math.min(rect.width / vw, rect.height / vh);
  return {
    scale,
    left: rect.left + (rect.width - vw * scale) / 2,
    top: rect.top + (rect.height - vh * scale) / 2,
    width: vw,
    height: vh,
  };
}

function toCanvas(clientX, clientY) {
  const p = projection();
  if (!p) return null;

  const x = (clientX - p.left) / p.scale;
  const y = (clientY - p.top) / p.scale;
  if (x < 0 || y < 0 || x >= p.width || y >= p.height) return null;

  return { x, y };
}

function placeHighlight(cell) {
  const p = projection();
  if (!p) return;

  highlight.style.left = `${p.left + cell.x * p.scale}px`;
  highlight.style.top = `${p.top + cell.y * p.scale}px`;
  highlight.style.width = `${cell.width * p.scale}px`;
  highlight.style.height = `${cell.height * p.scale}px`;
}

/* ------------------------------------------------------------------ wiring */

// The wall runs for as long as the page does, so going back to it is a
// visibility change rather than a reconnect. A camera gets its own player.
const wall = new MsePlayer(video);
const camera = new MsePlayer(cameraVideo);

const layout = new LayoutFeed(() => {
  if (current === BIRDSEYE) hideHighlight();
});

let current = BIRDSEYE;
let hovered = null;

function hideHighlight() {
  hovered = null;
  highlight.classList.remove("on");
}

/**
 * Hold up the tile that was clicked, taken straight out of the frame already
 * on screen, so the wait for the camera is not spent looking at black.
 */
function holdTile(cell) {
  if (!video.videoWidth) return;

  placeholder.width = cell.width;
  placeholder.height = cell.height;
  placeholder
    .getContext("2d")
    .drawImage(
      video,
      cell.x,
      cell.y,
      cell.width,
      cell.height,
      0,
      0,
      cell.width,
      cell.height,
    );
  placeholder.classList.add("on");
}

function show(name) {
  if (name === current) return;
  current = name;
  hideHighlight();

  if (name === BIRDSEYE) {
    camera.stop();
    cameraVideo.classList.remove("on");
    placeholder.classList.remove("on");
    spinner.classList.remove("on");
    clearTimeout(returnTimer);
    return;
  }

  const cell = layout.cells[name];
  if (cell) holdTile(cell);

  cameraVideo.classList.remove("on");
  spinner.classList.add("on");
  camera.play(name);
  bumpIdleReturn();
}

// the held tile is only dropped once there is a real frame behind it
cameraVideo.addEventListener("loadeddata", () => {
  if (current === BIRDSEYE) return;
  cameraVideo.classList.add("on");
  placeholder.classList.remove("on");
  spinner.classList.remove("on");
});

// A reconnect strips the source, and the element is opaque, so it would sit
// there as a black rectangle over the wall for the whole backoff. Uncovering
// the wall shows the same camera live in its tile, which beats both a black
// screen and the stale frame the placeholder is holding.
cameraVideo.addEventListener("emptied", () => {
  if (current === BIRDSEYE) return;
  cameraVideo.classList.remove("on");
  spinner.classList.add("on");
});

stage.addEventListener("mousemove", (e) => {
  activity();
  if (current !== BIRDSEYE) return;

  const point = toCanvas(e.clientX, e.clientY);
  const under = point && layout.at(point.x, point.y);

  if (!under) return hideHighlight();

  if (under !== hovered) {
    hovered = under;
    highlightLabel.textContent = pretty(under);
    highlight.classList.add("on");
  }
  placeHighlight(layout.cells[under]);
});

stage.addEventListener("mouseleave", hideHighlight);

stage.addEventListener("click", (e) => {
  if (current !== BIRDSEYE) return show(BIRDSEYE);

  const point = toCanvas(e.clientX, e.clientY);
  const under = point && layout.at(point.x, point.y);
  if (under) show(under);
});

document.addEventListener("keydown", (e) => {
  activity();
  if (e.key === "Escape" && current !== BIRDSEYE) show(BIRDSEYE);
  if (e.key === "f") document.documentElement.requestFullscreen?.();
});

// the highlight is placed in screen pixels, so it has to follow the video
window.addEventListener("resize", () => {
  if (hovered && layout.cells[hovered]) placeHighlight(layout.cells[hovered]);
});

// a wall display should not show a cursor sitting in the middle of it
let idleTimer = null;
function idle(on) {
  stage.classList.toggle("idle", on);
  if (on) return;
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => idle(true), 3000);
}

// Someone opens a camera, gets distracted, and the wall shows one corner of
// the property until a human touches the mouse again. Go back on our own.
const IDLE_RETURN =
  Number(new URLSearchParams(location.search).get("idle")) || 0;

let returnTimer = null;

function bumpIdleReturn() {
  clearTimeout(returnTimer);
  if (!IDLE_RETURN || current === BIRDSEYE) return;
  returnTimer = setTimeout(() => show(BIRDSEYE), IDLE_RETURN * 1000);
}

function activity() {
  idle(false);
  bumpIdleReturn();
}
idle(false);

if (HOST) {
  wall.play(BIRDSEYE);
} else {
  // Nothing is configured, which is not a failure and must not be treated as
  // one: the reconnect loop would replace this with a countdown every few
  // seconds and retry an address that cannot start existing on its own.
  // Electron opens its settings window for this case; a plain page can only
  // say what it needs.
  setStatus("No Frigate address. Add ?host=<host:port> to the URL", "bad");
}
