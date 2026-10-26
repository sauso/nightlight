# What you need, and what has been tested

This page says what Nightlight needs, what it starts for each camera and feature, and what has actually been tried. It is deliberately plain about the gaps. **Nobody has measured how much CPU, memory or disk Nightlight uses per camera, so there is no minimum spec and no recommended camera count here.** Any figure on this page comes from the code, the CI workflows or another guide, and says where.

If you have run Nightlight on small hardware, see [Help fill the gaps](#help-fill-the-gaps).

## What you need

- **An always-on Linux machine running Docker, on the same network as your cameras.** The published images are built for `linux/amd64` and `linux/arm64` (64-bit ARM, such as a Raspberry Pi running a 64-bit system). No other build is published, so 32-bit ARM is not covered. [Installation](installation.md) has the steps.
- **A camera that offers an RTSP stream.** ONVIF is optional. See [Which cameras work](cameras.md#which-cameras-work).
- **Somewhere to keep the data and, if you use recording, the video.** Both default to folders under the data volume you map; recordings can go elsewhere. See [Where recordings are stored](recording.md#where-recordings-are-stored).
- **A browser or app to watch with.** See [Browsers and apps](#browsers-and-apps).

## What each camera starts

Nightlight does not set a limit on cameras or viewers. What a camera costs depends on what you switch on, so this is the shape of the work, not its size. Everything is an FFmpeg process unless it says otherwise, and the backend and one MediaMTX process are shared by all cameras.

| What | When it runs | What it does |
|---|---|---|
| **Live stream** | Every enabled camera, always | Pulls the camera's RTSP stream once. The video is **copied, not re-encoded**, into both outputs. For Low latency the camera's own audio is copied (an AAC source is converted to G711 µ-law instead). For Compatibility, audio is **always encoded to AAC** at 64 kbit/s. |
| **Low-quality stream** | Only if the camera has a second stream (sub-stream) address set | A second copy of the same job, so a second connection to the camera. |
| **Motion analysis** | A camera with frame-comparison motion alerts on (all day), or a camera assigned to a child around that child's sleep window (it starts 3 hours before the window opens and stops 3 hours after it closes) | Reads the stream from inside the container, using the low-quality stream when there is one. It decodes the video and shrinks it to 320 × 180 greyscale at 5 frames a second. |
| **Sound analysis** | A camera with sound detection switched on | Reads the stream from inside the container and decodes only the audio, to 8 kHz mono. |
| **Recording buffer** | A camera that wants one: on a default install that is every camera, because the Record button is on by default. Also cameras with automatic clips on, or a child's camera with wake clips on | Copies the stream, with no re-encode, into a rolling buffer of 2-second segments under `clips/.ring/`, about a minute deep at the default settings. Old segments are deleted as it goes. |
| **Short jobs** | When something happens | A one-frame snapshot (alerts, timelapse). Cutting a clip, which **re-encodes** it (video with x264 `veryfast`, audio to AAC) so it is exactly the length you set; detection clips are cut at most two at a time. Assembling a night's timelapse, also x264 `veryfast`, scaled down to at most 1280 pixels wide. |

What follows from that:

- **The camera sees one connection per stream.** Everything else reads the copy inside the container. A camera with a low-quality stream set sees two, so check how many connections yours allows at once.
- **Watching does not start more FFmpeg work.** Viewers connect to MediaMTX. MediaMTX only builds the Compatibility (HLS) packaging while someone is watching that way (`hlsAlwaysRemux: no`).
- **Not measured:** the CPU, memory and network cost of any row above, or of each extra viewer.

## Disk

The retention rules and defaults are in [Recording](recording.md#retention-and-what-deleting-removes); in short:

- **Automatic clips:** kept 14 days or until they reach 5 GB (both configurable).
- **Wake clips:** kept 14 days (configurable).
- **On-demand recordings:** kept until you delete them.
- **Timelapse frames:** about 30 MB a night while a sleep window is open (the figure in the recording guide), deleted once that night's timelapse is made. Each child keeps their 30 most recent timelapse videos.

Not measured: how large a clip or timelapse video is for your camera (it depends on its resolution and bitrate), how fast the recording buffer writes, and what that continuous writing does to a small flash card.

## What has been tested

### Automatically

- **Both images are built and a start-check runs on arm64.** `linux/amd64` and `linux/arm64` are built together on every publish (the arm64 half under emulation). The weekly rebuild then tests the new image before moving the `latest` and `dev` tags: on **amd64** it runs the end-to-end check (a synthetic camera goes live and playable HLS frames come out) and checks the HLS path carries AAC audio. On **arm64** it only checks that FFmpeg and MediaMTX run and the database driver opens a database, about 30 seconds' worth. **No video is streamed on arm64 in any automated check**, because there is no arm64 runner.
- **The end-to-end suite uses a synthetic camera.** It is a generated test pattern and tone, not real hardware. It checks that a live HLS playlist is served, not that a browser decodes it. It is not a load test.
- **The browser suite runs in desktop Chromium only** (Playwright's "Desktop Chrome" profile). Safari, Firefox, Edge, Samsung Internet and the native apps have no automated coverage, and no list of tested browser versions is kept.

### By hand

Playback on real devices is **not** automated. Before a release that touches streaming, a person works through a short checklist on the staging server: start playback on a phone and on a desktop browser, disconnect and reconnect a camera and confirm video and audio come back, and check picture-in-picture, pinch-zoom and a camera tile in the Android app ([the checklist](../planning/deploy-runbook.md), section 1.6). It names no device models or browser versions.

### Cameras and sleep tracking

The recommended cameras are open-firmware Thingino ones, described as fully tested in [Which cameras work](cameras.md#which-cameras-work); other ONVIF cameras vary by firmware and model. The sleep-detection thresholds were calibrated on real cameras in one household (the [demo guide](demo-mode.md) says the same), so treat them as a starting point for any other room. The limits are listed under [Sleep tracking: known limits](sleep-tracking.md#known-limits).

## Browsers and apps

- **Two ways to watch.** Each camera tile can use **Low latency** (WebRTC) or **Compatibility** (HLS). The Compatibility player library (hls.js) is only loaded on a browser without built-in HLS. Safari and iOS use their own HLS support ([architecture](architecture.md)).
- **No minimum browser version is stated.** The frontend sets no `browserslist` and no explicit build target, so it uses the build tool's defaults, and none of those versions has been tested.
- **Low latency needs a network path for WebRTC.** On your own network this works with the default setup; away from home it needs a UDP port forwarded. See [Networking](networking.md).
- **Compatibility over plain `http://` is a known issue.** It does not play; use Low latency or serve Nightlight over HTTPS. See [Known issues](../KNOWN-ISSUES.md).
- **Home-screen install and native apps.** Installing the web app, and what each platform does with it, is in [Your home screen and the mobile apps](mobile.md#installing-to-your-home-screen). The Android and iOS apps are installed from GitHub rather than an app store (the iOS app is sideloaded). Background listening works in both modes on Android; on iOS a camera must be in Low latency mode ([Known issues](../KNOWN-ISSUES.md)).

## Help fill the gaps

The measured profiles (CPU, memory and disk per camera, on named hardware) are still missing; they are tracked in [issue #408](https://github.com/sauso/nightlight/issues/408). Until they exist, add cameras one at a time and watch the host's CPU as you switch features on. If you have measured something, a note on that issue helps: your host, how many cameras, which features were on, and what you saw. Please leave out addresses, camera names and anything else that identifies your home.
