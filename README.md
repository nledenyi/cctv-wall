# CCTV Wall

A single page that shows Frigate's Birdseye canvas full screen, and turns a
click on a tile into that camera full screen. Click anywhere, or press Escape,
to go back to the wall. Built for a Windows machine driving a display, with
Electron as the eventual wrapper.

```
npm start                      # the packaged app, against the saved config
python3 serve.py 8099          # just the page, http://<host>:8099/?host=…:5000
npm test                       # the monitor matching, which has real edge cases
npm run dist                   # a Windows installer, into release/
```

The same three files run in any browser, served from anywhere.

The page takes `?host=` and `?idle=` so it stays usable in a plain browser,
which is how it is quickest to debug. Electron passes both from the config.

`?host=` may carry a scheme, and `wss://` is the interesting one: it reaches
Frigate's own TLS port with nothing in between, whatever protocol the page
itself was loaded over.

```
?host=10.0.0.5:5000            # scheme follows the page, as before
?host=wss://10.0.0.5:8971      # Frigate's TLS port, from any page
```

## Windows app

`electron/main.js` owns everything the page cannot: which monitor, staying on
top, staying awake, starting with Windows, and getting out again. Settings live
in `%APPDATA%\cctv-wall\config.json` and are edited from the tray.

Installers are built by GitHub Actions on `windows-latest`, because
cross-building NSIS from Linux means wine. Push a `v*` tag for a release, or
run the workflow by hand for a downloadable artifact.

Two things worth knowing before changing that file:

- **Monitor identity is not stable.** Windows renumbers displays across
  reboots, driver updates and replugs, so the saved display id is worthless.
  `electron/displays.js` matches on name, then position, then index, then gives
  up to the primary, and `electron/displays.test.js` covers each of those. The
  failure it avoids is a window opening at coordinates no monitor covers, which
  looks exactly like a crash.
- **Kiosk plus always-on-top plus start-with-Windows composes into a machine
  you cannot easily leave.** The quit shortcut and the tray icon are both ways
  out, deliberately, and a shortcut that fails to register is logged rather
  than swallowed.

## What Frigate has to be configured with

Two things, and the second one is easy to miss:

- `birdseye.restream: true`, so the composed canvas is served over go2rtc.
- **`go2rtc.streams` for every camera you want to be able to click.** Frigate
  restreams birdseye by itself but not the cameras, and the wall opens
  `live/mse/api/ws?src=<camera>` on a click. Without it the wall looks fine until
  someone clicks a tile and gets a black screen with no error.

`testrig/` is a stock Frigate with five public streams that the wall can be
pointed at, and it is where that requirement was found.

## How it knows what is behind a tile

Frigate 0.18 publishes the composed layout itself. Connect to its websocket,
send `{"topic": "birdseyeLayout"}`, and it answers on topic `birdseye_layout`
with a rectangle per camera in canvas pixels:

```json
{ "driveway": { "x": 0, "y": 0, "width": 960, "height": 540 }, ... }
```

It is pushed again every time the layout changes, so a camera coming or going
does not have to be modelled here. Nothing else is fetched: the canvas size
comes from the video's own `videoWidth`/`videoHeight`, which is the same thing.

## Why there is no HTTP call

Everything the page needs arrives over two websockets, `ws` for the layout and
`live/mse/api/ws` for the picture, both relative to wherever the page is served
from. Websockets are not subject to CORS, so the page runs from any origin
without Frigate having to allow it.

The flip side is that a page loaded over https cannot open a `ws://` socket. That
used to mean something always had to bridge the two. It no longer does: Frigate's
integrated nginx serves both sockets over TLS on port 8971, so
`?host=wss://<frigate>:8971` needs no bridge at all.

What it needs instead is a certificate the client trusts. Frigate generates its
own, and a page cannot ask a `WebSocket` to overlook that - there is no such
flag, and the handshake fails with a bare `error` event that looks like a broken
app. Electron gets around it in `main.js`, for the configured host only.
Everything else wants a real certificate mounted at
`/etc/letsencrypt/live/frigate/`, or one manual click-through per browser
profile.

The other way round is to put a proxy next to the page, so both sockets are
same-origin and the page never has to reach Frigate itself. `deploy/` is that:
an nginx stack taking `FRIGATE_HOST` from the environment through an `envsubst`
template, forwarding `ws` and `live/` to Frigate and serving the page beside
them.

This is also why the page builds its socket URLs from **its own directory**
rather than from the root. It works unchanged at the root of a host of its own
or under a `/<something>/` subpath, which is what any per-page proxy arrangement
needs.

## Hit testing

`object-fit: contain` letterboxes the video, so the picture is not the element.
`projection()` works out the scale and the offset once, and everything else
converts through it: pointer to canvas pixels for the hit test, canvas
rectangle to screen pixels for the highlight.

## Why the switch feels instant

Two video elements, stacked. The wall plays for as long as the page is open and
is never torn down, so going back to it is a visibility change rather than a
reconnect: measured at 51ms, against several seconds to rebuild the stream.
Hidden, it keeps up on its own (1.10x realtime in testing, so it catches up
rather than falling behind) and is live when it comes back.

Going the other way there is nothing to show yet, so the tile that was clicked
is cropped straight out of the frame already on screen and held up full screen
while the camera loads. It costs no network and no wait, because that pixel
data is already decoded. It is one tile upscaled, so it is soft, and a small
blur makes that read as intent rather than as a broken picture. It is dropped
the moment the camera has a real frame, measured at 956ms.

## Staying up

- The stream socket reconnects with backoff, 1s doubling to 10s.
- A picture that stops advancing for 6s is treated as a dead socket and closed,
  which puts it through the same reconnect path.
- Switching streams closes the old `MediaSource` out with `endOfStream()` and
  releases the element, otherwise the abandoned decoder starves the new one.
- The buffer is trimmed to 15s, and playback that falls more than 5s behind the
  live edge is nudged forward to a second short of it.

## Known unknown

In headless Chromium on the PVE host, the 1920x1080 wall stream plays at
roughly 0.7x realtime and drops about half its frames, while Chrome sits at
0.3% CPU on an idle 20 core host. Camera substreams at 1024x576 play at exactly
1.00x in the same browser. Near zero CPU alongside heavy frame drops points at
the headless renderer throttling rather than at decode cost, but that is a
guess: it needs one run on the actual Windows target before it means anything.
