# Test rig: stock Frigate, five public streams

A throwaway Frigate that the wall can be pointed at, running the **stock**
upstream image rather than the patched build the home lab NVR runs. It exists to
answer one question honestly: does the wall work against a Frigate that nobody
has modified?

```
docker compose up -d          # on the docker host
http://<host>:5005/           # Frigate's own UI, to see what it thinks
```

Five cameras, because five is the interesting number: it is odd, so the layout
cannot be a tidy 2x2, and it lands on upstream's packer in the case that shows
off how much canvas it leaves empty.

| Camera | Source | Size | Why |
|---|---|---|---|
| `bipbop` | Apple HLS example | 640x360 | burns a timecode into the picture, so it is the easiest tile to identify |
| `bigbuckbunny` | Mux test stream | 512x288 | 16:9 but a different size to the rest |
| `tearsofsteel` | Unified Streaming demo | 784x350 | 2.24:1, deliberately not 16:9 |
| `redbull` | Red Bull TV | 640x360 | live, 24/7 |
| `tagesschau` | ARD tagesschau | 640x360 | live, 24/7 |

Public streams rather than a looping local file, so the rig behaves like cameras
that are actually running, and so nothing has to be shipped alongside it. The
three that are recordings are looped with `-stream_loop -1`; the two live ones
never end.

## What it costs

About 35% of one core and 1 GB on a 4 vCPU VM, with no detection and no
recording. There is no GPU anywhere in this, and there does not need to be.

## What it established

Run against this rig, the wall behaves exactly as it does against the fork:

- Stock Frigate publishes `birdseye_layout` with the same
  `{camera: {x, y, width, height}}` payload. The fork changes where tiles land,
  not the protocol.
- Five cameras pack into three across and two down, filling **56.9%** of a
  1920x1080 canvas. Two fifths of the wall is black. That is the packer this
  project's Frigate fork exists to replace, and it is worth seeing once.
- Clicking that empty area does nothing, which is correct. `Layout.at()` returns
  null when a point is inside no rectangle.
- Clicking a tile opens that camera full screen.
- `tearsofsteel` at 2.24:1 is normalised to a 2:1 tile and letterboxed inside it,
  which is upstream's `get_standard_aspect_ratio` doing its job.

## The one prerequisite this rig found

Frigate restreams **birdseye** through go2rtc by itself when
`birdseye.restream: true`. It does **not** do that for the cameras. A camera is
only in go2rtc if it is named under `go2rtc.streams`, and the wall opens
`live/mse/api/ws?src=<camera>` when a tile is clicked.

Without that block the wall looks like it works: the canvas plays, tiles
highlight on hover, and then a click leads to a black screen with no error. The
first version of this rig had exactly that bug. Anyone deploying the wall needs
`go2rtc.streams` for every camera they want to be able to click.

## Notes

- `mqtt.enabled: false` on purpose. The real NVR publishes to the home broker and
  this one must stay silent.
- `detect.enabled: false`. Birdseye still gets frames from the detect stream, it
  just does not run a detector over them. Leaving detection on would put a CPU
  detector on five streams for no reason.
- The default `ffmpeg.input_args` is `preset-rtsp-generic`, which passes
  `-rtsp_transport` and dies on an http input. The config spells out the http
  equivalents instead.
- `birdseye.mode: continuous`. `online` is a fork mode and stock Frigate rejects
  it, which is the sort of thing this rig is here to catch.
- If a stream URL rots, resolve a new variant from its master playlist. The
  chosen ones carry no tokens, so they are stable as long as the source is.
