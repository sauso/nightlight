# Nightlight — self-hosted baby monitor

A mobile-friendly web app for watching multiple RTSP cameras, grouped by child, over your
home network. Live video uses WebRTC (via [MediaMTX](https://github.com/bluenviron/mediamtx))
for sub-second latency — much lower than a typical HLS-based viewer. Use it in any browser,
install it to your home screen as a PWA, or run the companion **native apps for Android and
iOS** ([nightlight-mobile](https://github.com/sauso/nightlight-mobile)) for reliable
background audio and picture-in-picture (see [Mobile apps](#mobile-apps-android--ios)
below). No cloud, no subscription, no account anywhere but your own network.

> **⚠️ Not a safety device.** Nightlight is a convenience tool, not a safety device. It is
> not a medical device, is not certified for safety monitoring of any kind, and must never
> be used as a substitute for adult supervision. Streams can drop, apps can be killed by
> the operating system, networks fail — never rely on this software to alert you to a
> child in distress.

## Screenshots

See the [visual walkthrough](docs/README.md) for a tour of the main screens (sign-in, the
nursery dashboard, adding a camera, and settings). Those images are generated automatically
by the end-to-end test suite, so they stay in sync with the actual UI.

## How it works

- **FFmpeg** pulls each camera's RTSP stream, copies the video through untouched, and
  transcodes just the audio to AAC (many IP cameras send audio as G711, a codec HLS can't
  carry at all — WebRTC can, which is why this only matters for Compatibility/HLS mode).
  The result is published into MediaMTX.
- **MediaMTX** re-publishes that as WebRTC (WHEP) and HLS, which browsers can play
  natively — RTSP itself cannot be played in a browser, so this bridge is required either way.
- **Backend** (Node/Express + SQLite) stores children, cameras, and caregiver accounts,
  and manages both MediaMTX and one FFmpeg process per camera as child processes —
  starting them, restarting on crash, and stopping them when a camera's removed.
- **Frontend** (React) is a mobile-first, installable app: a live dashboard grouped by
  child, plus screens to manage children, cameras, and caregiver accounts. Cameras can be
  added by IP over **ONVIF** (auto-filling the stream details), and PTZ (pan/tilt) cameras
  get on-screen controls — see [Managing cameras](#managing-cameras).

Everything above runs in a **single Docker container**, which needs its own routable IP on your LAN so
WebRTC connects without NAT/ICE headaches (MediaMTX advertises that IP to browsers). The simple default
is **host networking** — the container shares the host's IP — used by the quick start and the Unraid
template. If host mode doesn't suit you (e.g. a port clash with another service), you can instead give
the container its **own dedicated LAN IP**; see [Networking modes](#networking-modes) below.

This is designed for **local network use by default** — see "Remote / internet access"
below if you want it reachable from outside your home too.

## Quick start

Pull and run directly from Docker Hub:

```bash
docker run -d \
  --name nightlight \
  --network host \
  --restart unless-stopped \
  --log-opt max-size=10m \
  --log-opt max-file=3 \
  --stop-timeout 30 \
  -e PUID=99 \
  -e PGID=100 \
  -e TZ=UTC \
  -v /path/to/your/data:/app/data \
  sauso/nightlight:latest
```

Nightlight records video three ways — **automatic clips** attached to motion/sound alerts (opt-in per
camera), **wake clips** saved silently when your child wakes up, and **on-demand recordings** you
capture with the Record button. They have different retention rules, so see
[docs/recording.md](docs/recording.md) for all of it and for every setting under *Settings →
Recording*. Video defaults to `<data dir>/clips`; you can point it at your array instead with a
`/recordings` mount + `CLIPS_DIR`.

PUID/PGID control which user/group owns files this container creates in your data
directory - the defaults above (99/100) match Unraid's own "nobody"/"users" convention,
so they're usually already correct there. On another system, find your own with
`id your_username`. TZ (e.g. `Australia/Melbourne`) affects log timestamps only -
[full list of values](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones).

The `--log-opt` flags cap Docker's own log storage at 10MB × 3 files - without them,
logs default to growing unbounded, which can be a real problem on Unraid specifically
since Docker's storage there is a fixed-size image that can break the whole Docker
service if it fills up.

`--stop-timeout 30` gives Nightlight enough time to stop cleanly. It needs a few seconds
on the way down — an on-demand recording is assembled from the buffer at that point, and
being killed part-way through loses it. Stopping normally takes **1-5 seconds**, so 30 is
deliberately generous — and costs nothing, because the container exits as soon as it's
finished rather than waiting out the timeout. Don't rely on Docker's own default here:
recent versions don't document one, and it has been measured killing the container after
about 4 seconds, which was enough to lose the recording. **If you deployed before this
was added**, add `--stop-timeout 30` yourself (or `stop_grace_period: 30s` under the
service in Compose, or the Unraid template's "Extra Parameters" field). Nothing else breaks
without it — a recording lost this way is marked failed rather than disappearing silently.

Or with Docker Compose:

```bash
cp .env.example .env
# optionally edit .env - see comments in the file; the defaults are fine to start
docker compose up -d
```

Then, from any phone/laptop on the same network, visit `http://<server-ip>:4000`. The
first time you visit, you'll be asked to create the admin account — do this first, from a
trusted device. Then add your children (Children tab), add your cameras (Cameras tab — by
IP via ONVIF, or by RTSP details; see [Managing cameras](#managing-cameras)), and assign
cameras to children.

### Requirements

- Any always-on Linux box on the same network as your cameras (a Raspberry Pi, an Unraid
  server, anything running Docker). Both `amd64` and `arm64` are supported.
- Cameras that expose an RTSP stream (almost all "dumb" IP cameras and most smart cameras
  with a local RTSP option do — check the camera's manual for the RTSP path, usually
  something like `/stream1`).
- **ONVIF is optional but handy**: if a camera supports it, Nightlight can fetch the stream
  details from just its IP, and enable pan/tilt controls on cameras that report PTZ.

## Running on Unraid

Nightlight is on the **Community Applications** store. Open the **Apps** tab, search
"nightlight", and click **Install** — every field (network mode, data path, optional
variables) comes pre-filled; double check the **Data Directory** path if you want something
other than the default (`/mnt/user/appdata/nightlight`), then **Apply**.

Prefer to install manually, or want the template before Community Applications' cache picks
up a change? Add it straight from this repo instead:

1. Open the Unraid **Terminal** (or SSH in), then run:
   ```bash
   mkdir -p /boot/config/plugins/dockerMan/templates-user
   wget -O /boot/config/plugins/dockerMan/templates-user/my-nightlight.xml \
     https://raw.githubusercontent.com/sauso/nightlight/main/unraid-template.xml
   ```
2. Docker tab → **Add Container** → **Template** dropdown → select **nightlight**. Every
   field (network mode, data path, optional variables) is pre-filled from the template —
   double check the **Data Directory** path if you want something other than the default
   (`/mnt/user/appdata/nightlight`), then **Apply**.

Either way, this is a single container — no extra plugins needed, Unraid's normal Docker UI
handles it directly.

**Already installed from an older copy of the template?** Check that **Extra Parameters**
(Advanced view, on the container's edit page) contains `--stop-timeout 30`, and add it if
not. Unraid builds the container from the saved template, so a template downloaded before
this was added keeps the old value until you edit it — and without it a recording that was
in progress when the container restarts can be cut short. See the note under
[Quick start](#quick-start) for what it does.

## Networking modes

Nightlight needs its own routable IP on your LAN so WebRTC has no NAT/ICE trouble — MediaMTX advertises
that IP to browsers. There are two supported ways to provide one:

- **Host networking (default, simplest).** The container shares the host's IP (`--network host`, or
  `<Network>host</Network>` in the Unraid template). Nothing to configure — it's what the quick start and
  the template use. The trade-off is that it binds its ports (4000, plus MediaMTX's) directly on the host,
  which clashes if something else there already uses them.
- **A dedicated LAN IP (ipvlan / macvlan).** Put the container on a Docker `ipvlan`/`macvlan` network so it
  gets its **own** address on your LAN, separate from the host. Nightlight auto-detects the container's IP
  and has MediaMTX advertise it, so WebRTC works on the LAN with **no extra configuration** (no `PUBLIC_HOST`
  needed for local viewing). Use this to avoid host-mode port conflicts, or just to keep the app on a tidy
  fixed IP of its own.
  - **On Unraid:** create a custom Docker network on your NIC (e.g. `br0`, or a VLAN like `br0.10`), then in
    the container template set the **Network Type** to that network and give it a fixed IP.
  - **macvlan caveat:** with plain `macvlan`, the **host itself usually can't reach the container** (a Linux
    kernel limitation) — which matters if your reverse proxy (e.g. SWAG) runs on that same host. Use
    **`ipvlan`** (or add a macvlan shim interface) so the host can reach it.

| | Host networking | ipvlan | macvlan |
|---|---|---|---|
| Setup | None — the default | Custom Docker network + fixed IP | Custom Docker network + fixed IP |
| Port collisions with other containers | Possible — shares the host's ports | None — has its own IP | None — has its own IP |
| Host itself can reach the container | Yes (it *is* the host) | Yes | **No** (Linux kernel limitation) — use ipvlan instead if a reverse proxy runs on the host |
| Multiple instances on one host | Awkward — only one can hold port 4000 | Easy — each gets its own IP | Easy — each gets its own IP |

Either way, the app is still served on port **4000** (change it with the `PORT` env var if you need to).
For **remote / internet** access, see "Remote / internet access" below — that part is the same in both
modes.

### Running more than one instance (e.g. staging + production)

Running two copies on one host is easiest with the **dedicated LAN IP** mode above: give each its own IP
and they can keep the same internal ports without clashing (host networking can't — two host-mode
containers would both try to grab port 4000). Set a different `PORT` on an instance if you'd rather change
its HTTP port instead.

Watching **both remotely in Low latency (WebRTC)** takes one extra step, because each instance's WebRTC
media needs its own UDP port forwarded **1:1** — the port a browser must reach has to match the port
MediaMTX advertises, so a router that *remaps* the port breaks WebRTC:

1. Give each instance a **distinct WebRTC UDP port**: leave one at the default `8189` and set the other
   with the `WEBRTC_UDP_PORT` setting (a bare number between 1 and 65535, **no colon**; blank = `8189`),
   e.g. `WEBRTC_UDP_PORT=8190`. On Unraid it is the **WebRTC UDP Port** field in the container's
   advanced view. An invalid value is ignored with a warning in the log and `8189` is used. (The raw
   MediaMTX override `MTX_WEBRTCLOCALUDPADDRESS` still works for a bind address a bare port cannot
   express and wins if both are set, but you should not need it.)
2. **Forward each 1:1** on your router — external UDP `8189` → instance A's `8189`, external UDP `8190` →
   instance B's `8190` (same number in and out).
3. Set `PUBLIC_HOST` (your public IP or DDNS) on **both**.
4. Put each behind its **own subdomain** in SWAG (e.g. `nursery.example.com`, `nursery-dev.example.com`);
   the HTTP and the WebRTC signalling both ride 443, so the only per-instance forwards are those two UDP
   media ports.

**Compatibility (HLS)** needs none of this — it's all HTTP over 443, so both instances work remotely with
no extra port forwarding.

## Managing cameras

Cameras are added and edited from the **Cameras** tab (admin only). A camera's address is
entered as separate fields — **IP address**, **RTSP port** (usually 554), **stream path**,
and the camera's **username / password**. Nightlight assembles the `rtsp://` URL from those
itself, so the password never appears in a URL on screen.

**Supported cameras** — Nightlight works with **ONVIF / RTSP** cameras in general: video, audio, and —
on ONVIF cameras — pan/tilt and two-way audio. The fully tested and **recommended** option is
**open-firmware [Thingino](https://thingino.com/) cameras** (inexpensive, ONVIF, pan/tilt, two-way
audio); on those, set the camera's audio codec to **G711 (a-law)** for reliable sound (some builds
default to AAC, which not all of them stream well — see `KNOWN-ISSUES.md`). Most other ONVIF cameras
work too, and Hikvision two-way audio (ISAPI) is supported. If a camera won't connect, the **Add
camera** screen can generate a redacted **camera report** to help add support for it. The report is
a JSON file that stays on your device — it holds the camera's address, username, ONVIF result and
stream codecs, with any password replaced by `***`. It is meant to be attached to a GitHub issue, so
it is worth opening and reading before you post it: the redaction covers passwords, not everything a
particular camera's firmware might put in an error message. If you find something sensitive that
shouldn't be there, see [SECURITY.md](SECURITY.md) for how to report it privately instead.

**Adding a camera**

- **Via ONVIF (easiest):** type the camera's IP and press **Fetch port & path from ONVIF**.
  Nightlight queries the camera and fills in the port and stream path for you, and detects
  whether it supports pan/tilt and two-way audio. Most cameras answer this without a login;
  if yours needs one, fill in the username/password first. Then make sure the login is
  entered and Save.
- **Manually:** type the IP, port, path, and login yourself (see the camera's manual for its
  RTSP path, e.g. `/stream1`).
- On **Save**, Nightlight briefly tests the stream first and won't store a camera it can't
  reach (wrong login, path, or IP) — it tells you why. If the camera just happens to be
  offline right then, you can choose **Save anyway**.

**Capability badges** — cameras added via ONVIF show badges in the list: **PTZ** and
**Two-way Audio**, green when supported, red when not. (Manually-added cameras show neither,
since their capabilities aren't probed.)

**Pan/tilt (PTZ)** — on cameras that report PTZ, a move button appears on the camera tile
(next to the stream-quality gear). Tap it for an on-screen D-pad: each press nudges the
camera a fixed amount, and holding an arrow keeps it moving; it stops on release and can't
run past the limit.

**Two-way audio (talk-back)** — on cameras that support it, a talk button appears on the tile: hold it
to speak through the camera's speaker. Works with **Hikvision** (over ISAPI — enter the camera's *web*
login when adding) and with **any ONVIF camera that has an audio backchannel** (e.g. Thingino/Sonoff),
which is set up automatically from the ONVIF probe using the camera's own stream login.

**Editing** — Edit shows the same fields. Leave the **password blank to keep the existing
one** — it's never sent back to your browser. Changing the address re-tests the stream, the
same as adding.

**Removing** — Remove asks for confirmation, then stops the stream and deletes the camera.
You can always add it again.

**Assigning to a child** — use the "Assigned to" dropdown on each camera (admin only; a caregiver
sees the assignment as text). It is more than grouping: a camera's nights are tracked only while it is
assigned to a child who has sleep tracking on, so unassigning a camera stops its tracking just as
turning tracking off does.

### Where to put the camera

Nightlight works from **any** camera position: put the camera wherever it fits and you will still get
sleep tracking and motion alerts. A good position makes them **more reliable**, and nothing more than that.
These are suggestions from testing in one household, not guarantees, and not a measured result (a proper
comparison of positions has not been done yet).

- **The suggested view:** looking down at the bed from above, at about **45 degrees**, the way most baby
  monitors are mounted. Have the **whole bed in frame**, and the **doorway or room entry in view as well**
  if you can: seeing who comes in and goes out makes an entry or exit easier to tell from other movement.
- **What to avoid:**
  - **A light that flashes, flickers or changes brightness in view of the bed** (a blinking charger or
    night light, a screen, a light that cycles). Every change lights up pixels in the bed, which can break
    the empty-bed check into short pieces, and a correct morning wake can then read wrong or be missed.
    Cover or move the light, or point the camera so it is out of frame.
  - **A bed zone that overlaps where a parent stands or leans** (for example a camera so low or side-on
    that a person at the bedside covers the bed in the picture). Their movement then counts as movement in
    the bed.
  - **The bed being a tiny part of the frame.** With few pixels on the bed, a real movement is a smaller
    share of the zone and is easier to miss. Fill the frame with the bed, within reason.
- **If you move a camera, paint the bed zone again.** The bed zone (the area the camera watches for
  movement in the bed) is drawn on one particular picture, so after a move it no longer sits on the bed.
  Nothing checks that the zone is on the bed, so look at it over a live picture after any move. Sleep
  nights before and after a move are **not directly comparable**: the zone and the camera's idea of a quiet
  room both change, so a difference in the figures may come from the move, not from the sleep.

## Sleep tracking

Nightlight can estimate each child's overnight sleep from what their cameras already see and
hear — no wearables, no extra hardware. It's a **sleep-pattern guide, not a medical
measurement**, and (like everything here) never a safety device — see the warning at the top.

- **Turn it on per child.** Each child has a **Track sleep** toggle in their settings, with
  their own **bedtime** and **wake time**. Turning tracking off stops it entirely. Only an
  **admin** can turn tracking on or off or change those times (a caregiver sees them, greyed out).
  A child can have more than one camera; the night is measured from one of them (see "One camera
  does the measuring" below).
- **Bedtime is a guide, not a boundary.** Real bedtimes move night to night, and you shouldn't
  have to edit the setting each evening. The bedtime that gets reported is the one the camera
  actually saw — the **put-down**, and the child settling after it — whether that happens before
  the window opens or an hour into it. If your child was already asleep **before** the window,
  that sleep is counted and the night's timeline starts at the real bedtime rather than at the
  setting. Either way it only happens when the camera saw the child actually **put into bed** —
  a quiet room on its own is never read as a sleeping child, and neither is a *put-down* on its
  own: the bed also has to go on showing signs of being occupied afterwards. A sleeping child is
  never perfectly still for hours — they move a little, repeatedly — so a bed that stirs once and
  then nothing is an empty one, and the bedtime it seemed to start is discarded. The same applies at the other end: a morning wake
  is still found if it comes after the configured wake time.
- **One camera does the measuring.** If a child has several cameras, sleep is worked out from their
  **main camera** — the first one in the order an admin has arranged them on the live grid (drag the
  tiles; only an admin can, for this reason), skipping any that are turned off.
  The others carry on streaming, alerting and recording as normal; they just don't affect the numbers.
  This is deliberate: if every camera were combined, the *noisiest* one would decide the night — a
  camera facing the doorway would push bedtime later and add wake-ups that never happened, with nothing
  saying which camera was responsible. The night's detail view names the camera it measured from. Room
  temperature and humidity are the exception and still come from every sensor in the room, because
  those are averaged rather than combined.
- **How it estimates.** Across the night it builds a per-minute movement + sound timeline from
  the child's main camera: falling still for a sustained stretch reads as falling asleep,
  sustained movement or noise reads as an awakening (brief stirs don't count). On a completed
  night, a short recorded exit-and-return can also count as an awakening even when it's too brief
  to show up as sustained movement on its own — as long as the bed is confirmed quiet in between
  and later bed movement supports the return. This only applies to trips of one to twenty minutes,
  with at least a minute of quiet bed time in between; it updates wake-ups, awake time, and the
  longest sleep stretch, but live figures and wake-clip recording still use the plain movement rule
  above. If you've painted
  a **bed zone** on the camera — the same area that scopes motion alerts — it also tracks
  movement **outside** the bed and lists it separately, which catches a morning wake where the
  child has already left the bed. Draw the zone so it comfortably contains the child **including
  where their head ends up** — a zone that cuts through a sleeping child makes their own rolling
  over register as movement outside the bed, and can stop a real climb-out being recognised.
  Only clearly-outside-the-bed movement is listed; faint changes (a shadow, the camera's
  night-vision adjusting) are ignored rather than reported as someone in the room.
- **When the motion camera samples.** The movement timeline comes from a frame-by-frame motion leg that
  reads the camera's low-resolution stream. When it runs depends on how the camera's motion is set up:

  | Camera | When the leg runs |
  |---|---|
  | Frame-diff source with motion alerts on | around the clock (it is alerting anyway) |
  | Motion alerts off, or motion from MQTT or ONVIF, on a camera assigned to a child who tracks sleep | only from **3 hours before the sleep window opens to 3 hours after it closes** |
  | Not assigned to a child, or the child's sleep tracking is off | not at all (unless it alerts) |

  The 3 + 3 hours are the same distance either side that the detector widens the window by (asleep times
  are looked for from 3 hours before the window opens, wake-ups up to 3 hours after it closes). A camera
  that stopped sampling sooner would never see a morning departure that comes after the window, and a
  window that opens shortly after midnight (00:00 to 02:59) is sampled from the previous evening. The leg
  starts and stops on the server's 5-minute check, so it begins up to 5 minutes after the 3-hour mark and
  lingers 5 to 10 minutes after the closing one.
  - **The cost:** about 3 hours more a day of one low-resolution video decode per such camera (15 hours a
    day becomes 18 for a 19:00-07:00 window). That is a relative figure; the extra CPU was not measured.
    A frame-diff camera with motion alerts on already runs all day and costs nothing extra.
  - **What is not widened:** none of these is widened to 3 hours. The timelapse records only inside the
    sleep window itself. The live wake watcher (which also decides wake clips) uses the window plus 5
    minutes either side.
  - **Known limits:** a departure later than 3 hours after the window closes is not seen by any camera, and
    for a camera of this kind the morning review has no recorded *got out / into bed* events after about
    3 hours past the window's end, because nothing past that point feeds the night's numbers.
- **Getting up for the day.** The morning wake is the point the bed empties and stays empty, rather
  than the last movement seen in it — otherwise a parent stripping the bed an hour later would be
  reported as the child waking. A single stray minute of movement in an otherwise still bed (an adult
  reaching in for a toy or a blanket) does not restart that count; several minutes together do, because
  that is a person at the bed rather than a passing arm. The wake is only accepted where a recorded
  **got out of bed** backs it up, so a quiet spell alone can never end the night early.
- **A child who gets out and climbs straight back in has not got up.** If a *got into bed* follows a
  *got out of bed* shortly after, the night carries on rather than ending there — and so does a second
  *got out of bed* logged within a minute of that return, because climbing back into a bed and leaving
  it again inside a minute is one movement being read twice, not two trips. This matters most for a
  very still sleeper: once they settle, their bed can look identical to an empty one for hours, so a
  false exit shortly after bedtime would otherwise be reported as the end of the night.
  That second *got out of bed* is only set aside when the bed then shows a **still sleeper**: at least 6
  minutes of the slight movement a sleeping child makes (too small to count as the child moving) in the
  2½ hours after the return. Bigger movement at the bed does not count, because after a child has
  really got up that is a parent stripping the bed, tidying or reaching in: counting it once turned a
  real early-morning wake into one more than two hours later.
  A qualifying short trip can still be counted as a wake-up within that same continuing night — see
  "How it estimates" above. It can miss a trip that's interrupted by a data gap or a stray reading,
  and it cannot tell an adult's visit to the bed from the child's own trip out of it.
  **Known limit:** a genuine departure less than a minute after a *got into bed* is read the same way
  when the bed then shows a still sleeper (6 or more of those minutes), because the two are not
  distinguishable from what the cameras record. Where that is the only *got out of bed* of the night it
  is still used, so the night is never left with no wake time at all; where a later one exists, the
  later one is reported instead. A genuine departure followed only by a parent at the bed (bigger
  movement) is no longer set aside: it is found.
  **Known limit:** a child who climbs back in and then lies stiller than that (fewer than 6 minutes of
  slight movement in those 2½ hours), or a camera whose detection zone only ever registers bigger
  movement, is treated as having left at that second *got out of bed*: the wake is reported too
  **early**, never left blank. The 6 was measured on two cameras in one house, where the second exits
  that were the real wake showed 0-3 such minutes and the ones a review confirmed were not showed 10 or
  more; see KNOWN-ISSUES.
- **Tell it when it got a night wrong.** The morning after, the child's page offers **Was last night
  right?** — confirm the times or correct them, and mark any recorded *got into / out of bed* event as
  right, wrong, or "can't tell" against the still frame it was decided from. It appears once per night
  and goes for good once answered **or dismissed**; nothing is asked about nights with no times to
  confirm. Either an admin or a caregiver can answer, deliberately — the person who was in the room at
  5am is the one who knows. The review then shows who last answered it (**Answered by** and their
  username): a save with a time, "no one was in the bed", a note or an event answer counts, and so does
  saving someone else's answers again unchanged; dismissing the prompt does not, nor does a save that
  only empties fields, and both leave the name as it was. Reviews saved before this was recorded show no
  name. Type times on your own clock; they are
  recorded against the timezone in Settings, the same one the sleep card displays.
  - **Confirming that a night was right is worth as much as correcting one** — it is what makes a
    future change to sleep detection provable rather than arguable. Confirming and correcting are
    separate buttons on purpose: the times we guessed are never one stray tap from being recorded as
    fact.
  - **In bed and asleep are two different answers.** The form has three times: **In bed** (when they
    were put down), **Fell asleep** and **Got up for the day**. On a night with a bedtime story they can
    be half an hour apart, and you can give both. "In bed" is optional: leave it empty and nothing about
    the put-down is recorded. It can't be later than "Fell asleep" (a picked frame may be up to a minute
    after a typed asleep time, since a frame keeps its seconds and a typed time doesn't); the save is
    refused with a message if it is. If your review is left with an in-bed time but no asleep time
    (you gave "In bed" on its own, or emptied "Fell asleep"), the in-bed time is checked against the
    asleep time the app already has for the night instead, since that is the one it will be shown next
    to. In the same way "Fell asleep" can't be later than "Got up for the day" (again with a minute of
    slack for a picked frame), and an asleep time saved with no wake-up time is checked against the
    wake-up time the app already has. All of these are checked against what you saved before as well as
    what you are saving now, and a refused save stores nothing, event answers included. They are checked
    only when a save gives or empties one of those times: a note, an event answer or a dismissal is
    never refused because the app's own night changed after you answered.
  - **The times wait for your timezone setting.** Right after the page opens, the app may not have
    loaded the timezone set in Settings yet, and until it has, the times on the page can be shown in the
    wrong zone (and saved that way). So **That's right**, **Not quite…**, the time fields and the frame
    buttons stay greyed out, with a line saying why, until it has loaded (usually a moment). Event
    answers, **Save just the event answers** and **No one was in the bed** don't involve a time and work
    straight away. If the setting can't be loaded at all, the line becomes an error saying so and the
    times stay greyed out for that visit: reload the page. Every time on this page, shown or typed, is
    in your **home** time (the timezone set in Settings), never the time zone of the phone or browser
    you are using.
  - **Point at the picture instead of typing.** Tap the frame that shows the real moment and the time is
    taken from it, exact to the second rather than rounded from memory. Typing a time by hand instead
    clears the picked frame, so only one of them is ever the answer.

    | On a recorded… | Button | Fills |
    |---|---|---|
    | *got into bed* | **Put down here** | **In bed** only. It never changes "Fell asleep". |
    | *got into bed* | **Asleep here** | **Fell asleep** |
    | *got out of bed* | **Up for the day here** | **Got up for the day** |

    Reading a story first? Mark both: **Put down here** on the put-down, **Asleep here** on the event
    closest to when they settled (or type the asleep time).
    - This is **not** the same as marking an event *correct*. An exit can be perfectly real and
      still not be the end of the night — a child who gets out at 5:45, goes back, and gets up
      again at 6:00 had two genuine exits and only one of them ended the night.
    - **Before this version** there was only one button on a *got into bed* event, **Put down here**,
      and it set the *asleep* time. Reviews saved that way are kept exactly as they are: there is no way
      to tell which stored asleep times came from that button, so none is reinterpreted as "in bed". If
      one of yours is wrong, open the night and correct it. A page that was already open when the app
      updated keeps the old button until it is reloaded, and saves the old way until then.
  - **Saying "No" can say what it really was.** In the full event list, answering **No** offers an
    optional follow-up: **Me or another adult**, **They moved in bed**, or **Someone walking by /
    nothing**. A plain "No" can't tell a parent leaving after a story from a child rolling over, and
    telling those apart is what future detection work needs. Skipping the follow-up is fine: a "No"
    with nothing else is still a complete answer. Changing the answer away from "No" removes the
    follow-up too. The **Quick check-in?** and **Still moving?** cards don't ask it, because their own
    buttons ("That was me", "No, still in bed") already say what happened. Those events also appear
    in the full list with your answer shown, but without the follow-up. **That was me** is saved as
    **Me or another adult** without asking; **No, still in bed** is saved with no follow-up.
  - **Afternoon events are grouped out of the way.** Events recorded before **16:00** on the night's
    date, in the timezone set in Settings, are collected at the top of the full list as **Before
    bedtime (N)**, collapsed. They are usually someone walking across the bed zone. **None of these
    were a bedtime event** marks them all **No** in one tap. The button stays greyed out until you
    have opened the group at least once, so a real nap can't be marked "No" before anyone has looked
    at it. Closing the group again doesn't lock it. It never overwrites an answer you've
    already given, and it leaves out any event that has its own Quick check-in or Still moving card.
    Open the group to change any single one before you save, for example to mark a real afternoon
    nap as **Yes**. 16:00 is a first guess, not a measured value, and it's the same for every house.
    If your child's night really starts before 16:00, don't use the button: it would mark their
    real bedtime "No". A night with no bedtime information at all (no put-down, no sleep time, no
    frame picked, no bedtime you typed in) shows the list ungrouped. The list is also ungrouped until
    the app has loaded your timezone setting. That is usually a moment after the page opens, but it
    lasts the whole visit if the settings can't be loaded. Grouping by a guessed timezone could put
    a real evening bedtime in the afternoon group, where the button would mark it "No".
  - **Your times become the ones shown.** Once you correct a night, the child's card, the history list
    and the sleep detail page all show *your* times, marked **You corrected this**, with the total
    sleep recalculated to match wherever an asleep or wake-up time you saved differs from the one that
    screen had (a time that is the same keeps that screen's own total). This is different from
    **Recompute this night**, which re-runs the detector: correcting records what *you* know,
    recomputing re-asks the *app*.
    - A corrected **In bed** only moves the "in bed" time. Saving the form also records the asleep and
      wake-up times it shows, as your confirmation. Where those are the times a screen was already
      showing, nothing about the sleep changes there: the total asleep, the wake-ups and the longest
      stretch stay what that screen had. The total is recalculated only where a time you saved differs
      from that screen's own, which is normally only when you changed it (but not always: see the known
      limit below about the review page and the card starting from different versions of the night).
      Tapping a picked frame's button a second time undoes the pick and puts the field back
      the way it was (un-pressing a put-down that was already saved removes it). When you give an in-bed
      time, the card and the detail page show it next to the asleep time even if you corrected that too
      (they hide the *detector's* put-down beside a corrected asleep time, because it may belong to the
      bedtime you overruled). Either way it only shows when it is at least a minute before "asleep".
  - **A night you have corrected is locked.** Once any correction is saved (an in-bed, asleep or wake
    time, "No one was in the bed", or a plain **That's right**), the night's saved summary is complete:
    the nightly update stops refining it and **Recompute this night** refuses it (the dialog says the
    night is locked). Answering only the per-event questions (**Save just the event answers**) or
    dismissing the card is not a correction and locks nothing. A note isn't a correction either, but the
    review form always saves the asleep and wake-up times it shows along with it (as your confirmation,
    see above), so **a note saved from the form does lock the night**. Only a note sent on its own through
    the API locks nothing. This is the same for every child and every install.

    | | Before you correct a night | After |
    |---|---|---|
    | Nightly update (the ~3 hours after the window closes) | keeps refining the saved summary | leaves it alone |
    | **Recompute this night** (admins) | can re-save it | refused: "locked because you corrected it" |
    | Follow-up "Sleep report updated" push | can be sent once, within about 3 hours of the window closing | not sent |
    | Sleep detail page | worked out fresh each time | still worked out fresh each time, with your times laid over it |
    | Editing or removing your correction | — | always allowed |

    - **What gets locked is the night as it is when you save.** If last night's saved summary was still
      being refined (the first ~3 hours after the window closes), saving your correction first stores the
      night freshly worked out at that moment, then locks it, so an early rough pass isn't what gets kept.
      Any other night — an older one, or one whose summary had already settled — is locked as it is:
      correcting it never re-scores it (only an admin's Recompute does that, and only on an unlocked
      night). Later saves on a night that is already locked (changing your times, a note, an event
      answer) never re-work it either.
    - **Removing your last correction unlocks the night.** While it is still "last night", the nightly
      update then refines it once more if it had not finished doing so before you corrected it. Past the
      ~3 hours that pass only updates the saved summary: no "Sleep report updated" push goes out that late.
    - **Known limits, all documented rather than fixed:**
      - A night corrected early (say 07:15, when the window closed at 07:00) keeps any time you did
        *not* correct at the value it had then. A detected wake-up that would have settled from 06:50
        to 07:15 an hour later stays at 06:50. Correct the wake too if it matters.
      - "Freshly worked out at that moment" is the moment you press save, not the moment you opened the
        page. A detected wake-up keeps moving until about 10:00 as the morning's activity is taken into
        account, so on a page left open for a while the saved night can differ a little from what the
        page showed you. That saved version is the one that locks. (What the page showed is still
        recorded with your answer.)
      - A night corrected before its first summary was saved (possible from the sleep detail page in
        the first half hour after the window closes), or while that summary was still "no data", locks
        at the first real summary the nightly update saves after your correction. That update still
        sends the usual first sleep report and makes the night's timelapse. (Saving the correction does
        not save that summary itself, on purpose: the nightly update's first pass is the one that sends
        the report and makes the timelapse.) If that first summary says "no one in the bed" where a later
        one would have found your child, it stays that way under your times; remove your correction
        (while it is still last night) to let the nightly update look again. In the same way, if that
        first summary has no wake-up time yet (the morning's departure was still being confirmed when it
        was saved), the night keeps showing no wake-up time until you add one to your review.
      - The sleep detail page always works the night out fresh and lays your times over it, so its
        total asleep and wake-ups can differ a little from the locked summary on the child's card.
      - The review page starts from the night worked out fresh when you open it, while the child's card
        and history show the night as it was saved. When those differ (a page left open while the
        detected wake-up moved on, or an older night saved by an earlier version of the detector), the
        asleep and wake-up times you save unchanged are the review page's, so the card shows those and
        recalculates its total to fit them, even if you only marked **In bed**. The sleep detail page,
        which works the night out fresh, may keep its own total instead. Each screen's total always fits
        the times it shows; they just aren't always the same total.
      - A corrected total still subtracts every unwatched minute the detector counted for the night,
        even ones outside your corrected times (the camera-outage limit under "Minutes with no video are
        unknown" in [KNOWN-ISSUES.md](KNOWN-ISSUES.md)). Locking makes that figure stop changing; it
        does not make it exact.
      - Nights corrected **before this version** are locked from the moment you update, as they were
        last saved.
      - The sleep ↔ temperature averages read the detector's saved figures and never apply time
        corrections, locked or not (a night marked "No one was in the bed" is left out of them).
      - The app's own asleep and wake-up times, saved unchanged (**That's right**, or the form with those
        fields left as the app had them), are saved as exactly the time the page showed, as long as it is
        a time the app could have worked out for that night. That means inside the child's sleep window
        widened the way the detector widens it: asleep times are looked for from 3 hours before the
        window opens, wake-ups up to 3 hours after it closes. The app's own times always are, unless the
        window was changed in Settings, or the app's timezone was, while the page was open. Any other time, including every **In
        bed** time, is dated by the clock alone: before 12:00 is the morning after the night's date, 12:00
        or later is the night's own evening. That is right for most nights, but not for a time that really
        belongs on the other side of that line: a wake-up you correct to after midday (a detected one can
        be, when the sleep window ends after 09:00), an asleep time you correct to before midnight on a
        window that opens just after midnight, or any time on a sleep window that crosses local midday
        (for example a night-shift family's 10:00 to 18:00). Typed, such a time lands on the wrong day,
        which shows up as "In bed can't be after Fell asleep" or "Fell asleep can't be after Got up for
        the day". That includes a time from an earlier save that the form shows again, because only the
        app's own times are matched. So once the app no longer has a night's after-midday wake-up itself,
        re-saving the form for that night is refused if your review also has an asleep time (and without
        one, the wake-up is saved again a day early: see the unchecked wake-up time below). That is always
        the case on a night older than 30 days, whose minute-by-minute data is gone so the app has no times
        of its own for it, and on a newer night if the app's own wake-up has moved since you saved yours.
      - On the night the clocks go back, the hour that happens twice can't be told apart as an HH:MM. The
        app's own time in it, saved unchanged, keeps the occurrence the page showed. A time you type in
        that hour is read as whichever occurrence the timezone arithmetic lands on, which depends on the
        timezone: the second one at or east of UTC (Europe, Australia, New Zealand), the first one west of
        it (the Americas). Only a time inside that one hour, one night a year.
      - The checks against the times the app already has for the night (see "In bed and asleep are two
        different answers") use the night as it was saved when you press save. If last night's summary
        was still being refined, saving then stores it freshly worked out (see above), and in the rare
        case that moves the app's asleep time earlier than an in-bed time you gave without an asleep
        time (or its wake-up time earlier than an asleep time you gave without a wake-up time), the save
        still goes through, and the card then hides your in-bed time (or shows asleep after up). Giving
        both times avoids it.
      - A wake-up time saved while your review has no asleep time is not checked against the app's
        asleep time. A wake-up typed earlier than that (with "Fell asleep" left empty) is saved, and the
        screens then show a night that ends before it starts. Give the asleep time too.
      - Through the API only: a save that empties just the wake-up time, beside an asleep time already in
        your review, is not checked against the app's wake-up time, so an asleep time after it can be left
        standing. The review form always sends its asleep time along with the wake-up time, and that save
        is checked.
      - Only just after updating: a review page that was already open before the update has no **In
        bed** field. If it saves an asleep time earlier than an in-bed time someone else has since saved
        from an updated page, the save is refused ("In bed can't be after Fell asleep") and that old page
        has no way to show or change the in-bed time. Reload the page.
  - **The detector's own answer is kept underneath, not overwritten.** That is deliberate — it is what
    a future improvement gets scored against. Nothing you enter here changes how sleep is detected.
  - **"No one was in the bed" says the whole night was wrong, not just a time.** Next to the usual times
    is a button for the case those don't fit at all — a night the detector scored as sleep, or as a wake
    or two, when nobody was actually there. It changes the child's card and the sleep detail page to say
    "You said no one was in the bed", the same way a time correction already shows your own times
    instead of the detector's, and it is per night and per child — there's no house- or timezone-specific
    assumption in it. **Someone was in the bed** undoes it and brings the detector's own night back.
    - **What does and doesn't come back.** Undoing restores the detector's answer, but **not** any time
      you had typed before you flagged the night — flagging clears those, and they are gone for good.
      If you undo without typing anything new, the morning card then shows neither "ask" nor "done" for
      that night: this is a known limit of the undo, not a bug, and the way past it is to type the real
      times in again.
    - **Unlike a night the detector itself scores empty, nothing is deleted.** That night's timelapse and
      any recorded transition frames are kept exactly as they would be for any other night. The flag is
      reversible, and a tap on this screen should never destroy video that undoing the tap could not
      bring back.
    - **Excluded from the sleep ↔ temperature averages** on the sleep detail page, so a night that never
      happened can't drag those numbers around. A push notification already sent before you flag the
      night cannot be recalled, but the automatic follow-up telling you when they got up is skipped once
      you have.
  - **The card confirms it.** After you answer, the prompt becomes a short receipt showing what you
    recorded, and tapping it lets you change your mind.
  - **Any night can be reviewed, not just last night.** The sleep detail page has **Was this night
    right?** for whichever night you are looking at — that is how you correct a night you already
    answered, since the card only ever offers nights you haven't. Saving from there keeps you on that
    night and shows the receipt in place, so working back through a run of nights doesn't send you to
    re-pick the date each time.
  - **Reviews are kept forever** — unlike the sleep minute-data behind them (30 days) or the recorded
    events (45 days). They are a few hundred bytes a night, and their whole value is being comparable
    years later. A recorded event you have **judged** is also kept past the usual 45 days, along with
    its frame, so a labelled picture is never deleted on a timer.
- **Noise on its own doesn't delay bedtime.** A bedroom microphone hears the whole house, and
  bedtime is usually its loudest hour — a sibling being settled, a TV, adults talking. So when
  working out **when your child fell asleep**, a noisy minute counts as awake only if that room
  also *moved* at around the same time. The same holds for the **first half hour** after they
  fall asleep, so the tail of the household's evening isn't reported as their first wake-up.
  After that the rule stops: mid-night the house is quiet, so a cry with no movement counts as a
  wake-up as you'd expect.
- **Re-working out a night (admins).** A night's summary is worked out once, the morning after, and
  then kept as it is — so if sleep detection is improved later, an already-recorded night keeps showing
  the old answer while the detail view, which works the night out fresh each time you open it, shows the
  new one. **Recompute this night** on the sleep detail page reconciles them. It compares what is
  *saved* — the summary on the child's page — against what the recorded movement now says, and shows
  you exactly what would change (bedtime, wake time, how long they slept, how many wake-ups) *before*
  anything is saved. You can cancel. Admins only. **A night someone has corrected in the morning review
  is locked and is not recomputed** — the dialog says so, and the API answers `409` with
  `reason: "reviewed"`. Remove the correction first if the night really should be re-scored.
  **It can never make a night worse:** the minute-by-minute data behind a night is only kept for 30
  days — the same span the date picker offers — so the oldest night you can browse sits right on that
  edge. If its data has aged out, the recompute is refused and the saved summary is left alone, rather
  than being replaced with "no data". The same refusal protects a night saved before a detection change
  that would now come out "no data" for another reason — for example most of it had sound but no video.
  (The page only offers Recompute on a night that still scores, so in practice that refusal is only seen
  through the API; its 409 says which reason applied — `reason`, `status`, `coverage_minutes` — see
  [KNOWN-ISSUES.md](KNOWN-ISSUES.md), "Minutes with no video are unknown in the sleep numbers".)
- **In bed, then asleep.** On a night where your child was put down a while before they fell asleep
  (a bedtime story, a slow settle), the card and the detail page show both: **In bed** is the
  put-down the camera recorded, and **Asleep** is when the room went quiet. That's the same time the
  app has always reported as bedtime. The extra time appears only when "in bed" is at least a minute
  before "asleep", so most nights still show one time. If you corrected a night's asleep time, the
  camera's "In bed" is hidden and only your time is shown: the recorded put-down belongs to the bedtime
  you corrected, so it may not match yours. Correcting only the wake-up time keeps it. If you gave the
  **In bed** time yourself in the morning review, yours is shown, beside your asleep time too. A night
  saved before this update has no "in bed" time on the child's card until it's recomputed, and a night
  you corrected in the morning review is locked against that until the correction is removed (or give
  its **In bed** time yourself in the review). The detail page works the night out fresh each time, so
  it shows the time straight away.
- **At a glance, and live.** Each child's page summarises last night — total sleep, wake-ups,
  longest stretch — and while a night is in progress it updates as **"Tonight · so far"**, so an
  early-morning wake appears within a minute or two rather than only after the window closes.
  Treat those live figures as provisional: a night in progress is judged only on what has
  happened so far, so a bedtime can be revised later in the evening and the morning wake isn't
  looked for at all until the night is complete. The settled numbers are the ones on the card the
  following day.
- **The detail view.** Tap the sleep summary for the full **night timeline**: a to-scale bar of
  asleep / stirring / awake stretches on a real time axis, every wake-up listed with its time
  and length, a **movement outside the bed** list, and a date picker to step back through
  roughly the last month of nights. Two moment markers sit on the bar — **got into bed** and
  **got out of bed** — and they are deliberately the only two shown: they're the put-down and
  the morning departure the night's times were actually derived from. A single camera can see
  that something crossed the edge of the bed, but not *who*, so movement in between is reported
  as exactly that and never attributed to a person. A stretch the camera has no data for at
  all — a detector restart, a dead connection — shows as its own striped **"No data"** segment
  rather than being folded into asleep or awake; it isn't counted toward the reported sleep
  duration either, and a night with a long enough gap can come back with less sleep counted, or
  occasionally no clear sleep detected, than the raw hours between bedtime and waking would
  suggest. **A stretch with sound but no video counts as "No data" too:** a minute is only
  counted as watched if the camera's video actually delivered a picture in it (at least one real
  frame — any frame rate), and the sound of an unwatched minute is not used, because a bedroom
  microphone hears the whole house. So if the video stalls over bedtime, the reported bedtime is
  the first quiet minute after the video came back, and a cry during a stall is not shown as a
  wake-up from the noise alone. A night more than half unwatched is "no data", and a night is only
  ever reported as **"no one was in the bed"** when at least **90%** of it was watched (a fixed
  first estimate, not a setting; on a night still in progress, 90% of the part so far), because
  that answer also discards the night's timelapse. A
  frozen picture still counts as watched — see
  [KNOWN-ISSUES.md](KNOWN-ISSUES.md), "Minutes with no video are unknown in the sleep numbers".
- **Room temperature (optional).** If a camera reports temperature/humidity over **MQTT** (set
  up under **Settings → MQTT**, e.g. via Zigbee2MQTT — the readings also show on the camera
  tile), the sleep detail overlays the night's room temperature beneath the timeline, aligned to
  the same time axis. After a handful of tracked nights, a **"Sleep & room temperature"** card
  compares wake-ups on the child's warmer vs cooler nights, so you can spot whether a warm room
  tends to mean more waking — a pattern, not a cause.

## Adding caregivers

Once signed in as admin, go to **Settings → Caregivers** to create additional logins (e.g. for a
partner or babysitter).

The rule (owner decision, 2026-10-10): **a caregiver can watch and act in the moment, but cannot
destroy or reconfigure.**

| Capability | Caregiver | Admin |
|---|:---:|:---:|
| View live cameras; watch and download alert clips, recordings, wake clips and timelapses | Yes | Yes |
| Record, move a PTZ camera, talk through a camera | Yes | Yes |
| Restart, reboot, or snooze camera alerts (recorded with your username; see below) | Yes | Yes |
| Reorder cameras on the live grid (the order also picks each child's measuring camera) | No | Yes |
| Assign a camera to a child | No | Yes |
| Add / edit / enable / delete a camera | No | Yes |
| Change a child's name, birthday, colour and photo | Yes | Yes |
| Add a child; turn a child's sleep tracking on or off; change their bedtime and wake time | No | Yes |
| Answer the morning sleep review (the review shows who last answered it) | Yes | Yes |
| Delete an alert clip, a recording or a wake clip | No | Yes |
| Delete a timelapse | No | Yes |
| Delete a child and its media | No | Yes |
| Change global settings (detection, notifications, providers, recording retention) | No | Yes |
| Manage caregiver/admin accounts and sessions | No | Yes |

Deleting by hand is not the same as **retention**: the automatic sweep of old alert clips and wake clips
(Settings → Recording, admin only to configure) runs on a timer on every install, whoever is signed in.

**Who did it is recorded.** Silencing a camera's alerts, un-silencing them, restarting its stream and
rebooting it each add a row to **Camera history** naming the account by its **username** (the login name
an admin sets, never the first name, which anyone can change on their own account); a restart or reboot
that failed is recorded too. While a camera is silenced, its tile shows who silenced it, to everyone. The
morning review shows who last answered it (above). Details, including what happens when the history
cannot be written, are in [docs/camera-controls.md](docs/camera-controls.md#silencing-a-cameras-alerts-and-who-did-what).

On a caregiver's screen the admin-only controls are not shown (sleep tracking and the window are shown,
greyed out, with a note); the server refuses them too, so a page opened before an update that changed a
permission gets a refusal rather than a change.

The **Settings** hub itself is visible to caregivers too — its admin-only pages (general,
camera controls, recording, MQTT, push providers, users, logs, clip storage) are simply hidden
for them rather than the whole screen being off-limits.

**Changing someone’s role takes effect immediately** — on their very next action, on every device
they’re signed in on. Demoting an admin to caregiver does *not* sign them out: they keep browsing as
a caregiver and simply lose the admin-only screens. Deleting an account, by contrast, ends its
sessions at once and signs that person out everywhere.

**There must always be at least one admin.** The only admin on an install can't be changed to
caregiver until another account is made an admin first, and no account can ever delete itself —
another admin has to remove it. Both are enforced by the server, not just hidden in the UI: the Role
field explains it up front when it applies, and a request that tries anyway gets a clear error rather
than a partial change. If an install somehow already has no admin (a database edited by hand, or
from before this was enforced), see **[docs/mfa.md](docs/mfa.md)**'s recovery section for the console
command that fixes it — it's documented there alongside the equivalent two-factor recovery, not
because it's about two-factor, but because it's the same kind of last-resort console fix.

Any account can also turn on **two-factor authentication** for its own login — see
**[docs/mfa.md](docs/mfa.md)** for enrolling, one-time backup codes, and how to recover if an
admin loses their authenticator.

## Running behind a reverse proxy (e.g. SWAG on Unraid)

A ready-to-use config is in `reverse-proxy/nightlight.subdomain.conf`. Copy it to
`swag/config/nginx/proxy-confs/nightlight.subdomain.conf` and replace `UNRAID_LAN_IP`
with the container's LAN IP — the **host's IP** in host mode, or the container's **own
dedicated IP** if you gave it one (see [Networking modes](#networking-modes)). Either way SWAG
reaches it by that IP, not by container name.

> **macvlan note:** if you put Nightlight on its own IP with plain `macvlan`, SWAG running on the
> *same host* won't be able to reach it (the host↔macvlan-container limitation noted above) — use
> `ipvlan`, or run SWAG on a different host.

Everything is proxied through a single port (4000): the app, login, all pages, and the
video signaling handshake — no extra ports to open on your router for this part.

### `TRUST_PROXY` — telling Nightlight your real client addresses

| Variable | Default | What it does |
|---|---|---|
| `TRUST_PROXY` | `loopback` | Which upstream addresses may set `X-Forwarded-For`. Accepts an IP or CIDR (`10.0.0.20`, `172.18.0.0/16`), a comma-separated list, a hop count (`1`), or a named range. |

Behind a proxy, every request arrives from the **proxy's** address unless you tell Nightlight to trust
it. The default (`loopback`) only trusts a proxy on `127.0.0.1` — and SWAG reaches Nightlight by its
LAN IP, so with the setup above **it is not trusted and every remote visitor looks like one client**.

Set it to the address your proxy connects *from*:

```bash
-e TRUST_PROXY=10.0.0.20        # SWAG's own LAN IP
```

> **⚠️ Only set this to an address you control.** Whatever you trust here is allowed to declare a
> client's IP. Too broad a value — or `true`, which trusts *every* upstream — lets anyone forge
> `X-Forwarded-For` and slip the login rate limit entirely, which is worse than leaving it unset. If
> you are not sure, leave it alone.

A value Nightlight can't make sense of is **ignored, with a warning in the log**, and the safe default
is used instead — a typo here will never stop the app starting.

**You do not have to set it.** Login attempts are limited per account *and* per source, so even with
every remote user sharing the proxy's address, one person mistyping their password cannot lock anyone
else out. Setting `TRUST_PROXY` makes the per-source half meaningful as well.

## Remote / internet access (watching from outside your home network)

By default this is LAN-only. There are two ways to watch remotely, and each camera tile
has a toggle to switch between them ("Low latency" / "Compatibility"):

**Low latency (WebRTC)** — near-instant video, same as at home. This requires:
1. Set up SWAG as described above (HTTPS for the app itself).
2. Set `PUBLIC_HOST` to your public IP or a DDNS hostname. ⚠️ It must **not** be a
   Cloudflare-proxied (orange cloud) name: Cloudflare's proxy carries only HTTP(S), never the UDP
   media, so remote Low latency would never connect while the page itself loads fine. Use a
   separate DNS-only (grey cloud) record, e.g. `rtc.example.com`, for `PUBLIC_HOST` and keep the
   proxied name for the web page.
3. Forward **UDP port 8189** (or your `WEBRTC_UDP_PORT`, see "Running more than one instance" above) on your router to your server's
   LAN IP.

This is a hard requirement of WebRTC, not a workaround — the actual audio/video always
travels over UDP between your browser and MediaMTX, no matter what. A TURN relay server
doesn't change this (it only changes how the *signaling* connects, not the media itself),
so there's no way to get the low-latency mode down to zero UDP ports. This single UDP
port forward is all you need, unless you're behind CGNAT.

**Compatibility (HLS)** — a few seconds of delay, but pure HTTP/TCP, so it rides through
the same port 443 as everything else with **no extra port forwarding at all**. Use this if
you'd rather not forward a UDP port, or if you're ever watching from a network that blocks
outbound UDP (some corporate/public Wi-Fi).

> **iOS background audio:** On iPhone/iPad, background listening (screen off / app minimised) works
> in **Low latency** mode only — its WebRTC audio lets Nightlight fully own the lock screen (camera
> name, artwork, Pause/Play). **Compatibility** is HLS, which iOS runs its own native lock-screen
> session for that we can't reliably control, so Background isn't offered for a Compatibility camera
> on iOS (it was tried and removed for being inconsistent — see [KNOWN-ISSUES.md](KNOWN-ISSUES.md)).
> Compatibility still works for live viewing. Android is unaffected — its background-listening
> service keeps both modes alive.

Both modes work automatically once SWAG + `PUBLIC_HOST` are set up — Compatibility mode
needs nothing further, since it's already proxied through the app's normal port.

## Installing to your home screen

The app has a web app manifest and icons for a full-screen, native-app-like home-screen
experience — no browser address bar. **It has no service worker**, so this is an install
shortcut, not an offline mode: the app still needs to reach your server over the network every
time, same as opening it in a tab.

What you actually get depends on the platform and whether the site is served over **HTTPS**
(via the reverse-proxy setup above) or plain `http://` on your LAN:

| Platform | Over HTTPS | Over plain `http://` |
|---|---|---|
| Android — Chrome / Samsung Internet | Installable PWA (full-screen, own icon, install prompt) | Usually a browser-badged **shortcut** that still opens inside the browser, not a true standalone install — Chromium's installability criteria require HTTPS (or `localhost`) |
| iOS — Safari | Add to Home Screen (full-screen, own icon) | Add to Home Screen works the same over plain HTTP — iOS doesn't gate it on HTTPS the way Chromium does |
| Desktop browser | Installable as a windowed app (Chrome/Edge) | Same shortcut limitation as Android Chrome |

- **Android, HTTPS**: browser menu → "Add to Home screen" / "Install app" (or the automatic
  install banner).
- **Android, plain HTTP**: same menu item still adds something to your home screen, but expect
  a shortcut that opens in the browser rather than a standalone window.
- **iOS**: Share button → "Add to Home Screen" — works the same either way.

If you want the full installed experience on Android specifically, the reverse-proxy/HTTPS
setup above is worth doing; otherwise the **native Android app** (below) gives you a true
standalone app without needing HTTPS at all.

## Mobile apps (Android & iOS)

Beyond the PWA, there are companion **native apps** in a separate repo,
[nightlight-mobile](https://github.com/sauso/nightlight-mobile). They're thin native
shells around this same web UI — the app loads the interface **live from your own server**
rather than bundling it, so any server update applies to the apps automatically with no
reinstall. On first launch you just enter your server's address (like the Home Assistant
app); a "Change server" menu item switches later.

What the native apps add over the browser/PWA:

- **Reliable background listening** — keep hearing a camera with the screen off or the app
  minimised. Android uses a foreground service (with a wake/wifi lock and a battery-
  optimisation exemption); iOS uses a background audio session. Plain in-browser background
  audio is unreliable by comparison. **On iOS this requires a camera in Low latency mode** —
  Compatibility (HLS) can't do reliable background audio on iOS (iOS runs its own native
  lock-screen session for it), so Background is only offered for Low-latency cameras there; see the
  Low latency / Compatibility notes above and [KNOWN-ISSUES.md](KNOWN-ISSUES.md).
- **Pause/Resume from the system controls** — Android's notification and iOS's Now Playing
  (Control Center / lock screen), plus a Stop on Android.
- **Picture-in-Picture** — float a camera in a small always-on-top window while you use
  other apps (Android; the browser has its own PiP too).
- **Battery-friendly** — minimising the app disconnects streams unless a camera is in
  Background mode, so nothing keeps pulling video in the background.
- **Push notifications** — a phone alert when a camera sees motion, even with the app closed
  (Android only for now). See below.

### Push notifications (motion alerts)

Get a **phone notification** when a camera with motion detection sees movement — even when the app is
closed. It's off by default, and the in-app **Recent alerts** list — on each child's page, or the
combined view under **Settings → Logs** (admin only) — works with or without it. There are two
ways to set it up (pick one), both configured under **Settings → Push notifications**:

**Pushover (recommended — simplest, and works on iOS).** A small notification service (the same one
Sonarr/Radarr use). No Firebase project, no Apple Developer account.

1. Install the **Pushover** app on your phone and note your **User Key** (or make a Delivery Group to
   alert several caregivers).
2. Create a Pushover application at [pushover.net/apps/build](https://pushover.net/apps/build) and copy
   its **API Token**.
3. In **Settings → Push notifications → Pushover**, paste the token + your user/group key, **Enable**,
   **Save** (it verifies with Pushover), and **Send test**. Then enable **Motion detection** on a
   camera. Alerts arrive with a **snapshot** of what triggered them.

**Firebase / FCM (Android app only).** Delivers straight to the Nightlight Android app via your own
Firebase project: drop `google-services.json` + a `firebase-service-account.json` service-account key
into your data dir (e.g. `/mnt/user/appdata/nightlight`, keep the key `chmod 600`), then enable it
under **Settings → Push notifications**. Each phone opts in under **Account → Notifications**.

Full walkthrough for both, with troubleshooting: **[docs/notifications.md](docs/notifications.md)**.

**Getting them:**
- **Android** — download the signed APK from the
  [nightlight-mobile Releases](https://github.com/sauso/nightlight-mobile/releases) page and
  sideload it (built and signed automatically in CI on each release).
- **iOS** — no App Store build yet; it's installed by sideloading (e.g. AltStore/Sideloadly
  with a free Apple ID). See the nightlight-mobile repo for the current status and steps.

Both apps are built entirely in GitHub Actions — see the nightlight-mobile repo for how,
and its own `CHANGELOG.md` for per-release notes.

## Logs

Both the app and MediaMTX log to stdout, captured by Docker in the normal way:

```bash
docker logs -f nightlight
```

Docker's own log rotation (already configured in the `docker run`/Compose examples
above, and in the Unraid template's extra parameters) caps total log storage at 10MB × 3
files, so this doesn't grow unbounded - this matters particularly on Unraid, where
Docker's storage is a fixed-size image that can break the whole Docker service if it
fills up. If you deployed before this was added, add `--log-opt max-size=10m --log-opt
max-file=3` yourself (or the Unraid template's "Extra Parameters" field) to get the
same protection.

Timestamps use your container's local time (see the `TZ` variable above) rather than
UTC, so they line up with when you actually remember something happening.

## Troubleshooting

- **Camera shows "No signal"**: double check the RTSP URL works with a tool like VLC
  (Media → Open Network Stream) first — if VLC can't play it, the app won't either.
- **Video won't connect from a phone but the pages load fine**: confirm the device is on
  the same LAN (for Low latency mode) — see "Remote / internet access" above if it's
  actually a different network.
- **A camera shows disconnected for a few seconds after opening the app and doesn't come
  back**: this is usually a stale WebRTC connection on the phone itself, not the camera or
  server — the video connection can get "wedged" after the phone sleeps, switches networks,
  or hands off Wi-Fi/cellular, and won't always re-establish on its own. **Pull down on the
  camera dashboard to reconnect** — this works in the browser and in the mobile apps, and
  rebuilds the connection without a full restart. If a camera is *actually* down, every
  device sees it, not just one — check the Camera history panel (Settings) or the logs
  (below) to tell the two apart.
- **Background listening stops after a while (Android app)**: Android's battery optimisation
  (Doze) will eventually freeze the app and cut its network unless it's exempt. The app asks
  for the exemption the first time you enable Background mode — if you declined, grant it
  manually under Settings → Apps → Nightlight → Battery → Unrestricted. (Background audio is
  a feature of the native apps, not the browser/PWA — see [Mobile apps](#mobile-apps-android--ios).)
- **A camera says "No signal" only in Compatibility mode**: usually the camera sending bad
  audio timestamps, which can stall the HLS pipeline. Nightlight resamples/rewrites camera
  timestamps to ride through this, but if it persists, power-cycle or update that camera's
  firmware. See [`KNOWN-ISSUES.md`](KNOWN-ISSUES.md).
- **Checking whether MediaMTX has registered your cameras**: its API is loopback-only (not
  reachable directly from a browser), so check it from inside the container:
  ```bash
  docker exec nightlight wget -qO- http://127.0.0.1:9997/v3/paths/list
  ```
  An empty `"items":[]` with cameras added in the app means MediaMTX and the app's database
  have drifted apart — restarting the container re-syncs them automatically (see the
  startup log line "Reconciled N camera path(s)...").
- **Checking logs**: see the "Logs" section above — `docker logs -f nightlight`.

For a catalogue of understood quirks (camera glitches, WebRTC reconnects, the watchdog's
recovery window) with what each one means and whether it needs any action, see
[`KNOWN-ISSUES.md`](KNOWN-ISSUES.md).

## Building from source

```bash
git clone https://github.com/sauso/nightlight.git
cd nightlight
docker build -t nightlight .
docker run -d --name nightlight --network host --stop-timeout 30 \
  -e PUID=99 -e PGID=100 -v ./data:/app/data nightlight
```

## Project layout

```
backend/          Express API + SQLite storage + process supervision for MediaMTX/FFmpeg
frontend/          React mobile-first UI (built into the image at build time)
mediamtx/          Default MediaMTX config (baked into the image - see src/index.js for why)
reverse-proxy/     Example SWAG config for running behind HTTPS
Dockerfile         Single combined image (app + MediaMTX + FFmpeg)
unraid-template.xml   Unraid Community Applications template
docker-compose.yml
```

## License

MIT — see `LICENSE`.
