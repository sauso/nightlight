# Known issues

Quirks that are understood and diagnosed, so nobody has to reverse-engineer them from
the logs twice. Each entry says what you'll see, why it happens, and what (if anything)
to do about it. Confirmed bugs with a fix pending live at the bottom.

> Reminder: Nightlight is **not a safety device** (see the README). None of the
> behaviours below should ever be relied on for safety-critical monitoring.

## A camera is offline on one phone but fine everywhere else

**What you see:** Open the app after it's been backgrounded/asleep and one camera tile
sits disconnected for more than a few seconds and won't recover on its own. Other
devices show the same camera streaming fine.

**Why:** The live video is WebRTC. A peer connection can get "wedged" when the phone
sleeps, changes networks, or hands off between Wi-Fi and cellular — the connection is
dead but the browser doesn't always tear it down and re-negotiate automatically. The
server and camera are healthy; only that one client's connection is stuck.

**What to do:** **Pull down** on the camera dashboard to reconnect — this works in the
browser *and* in the mobile apps, and rebuilds the stream connections without a full app
restart. (Closing and reopening the app also works, but you shouldn't need to.)

**Telling this apart from a real outage:** If a camera is genuinely down, *every* device
sees it offline, and the **Camera history** panel (Settings → admin) records an
`offline` event. A wedged-client problem shows nothing in that history because, from the
server's point of view, nothing happened. A planned self-healing reconnect on the client
is on the backlog but deliberately not built yet — it's easy to get wrong (false
reconnects, reconnect storms, dropping background audio mid-renegotiation) for a problem
a manual restart already fixes.

## A camera drops out for a few seconds and comes back on its own

**What you see:** A brief blip — a camera goes unready for a few seconds, then recovers
without anyone doing anything. In **Camera history** it shows as a `restart` (often
"corrupt timestamp" or "stream ended"), sometimes with no visible interruption at all.

**Why:** Some IP cameras occasionally glitch their RTSP feed — a corrupted timestamp
(non-monotonic DTS) or a dropped connection (RTSP "end of file"). This is the **camera's
firmware**, not Nightlight. FFmpeg detects the bad stream and Nightlight restarts that
camera's transcoder, which is the few-second blip.

**What to do:** Nothing — it's self-healing by design. If one specific camera does this
constantly, it's worth power-cycling that camera or checking its firmware; the app can
recover from it but can't stop the camera from doing it.

## A camera stays unready for ~30 seconds before recovering

**What you see:** A longer outage — up to about half a minute — before a camera comes
back, shown in **Camera history** as a `restart` with reason "watchdog".

**Why:** Beyond FFmpeg's own error handling, a watchdog independently checks whether each
camera is actually delivering frames and force-restarts one that's been stuck "not ready"
for over 30 seconds. The 30s threshold is deliberate: too aggressive and it would restart
cameras on momentary blips that would have self-healed faster on their own. So the
worst-case automatic recovery for a truly stuck stream is roughly 30s + a few seconds to
reconnect.

**What to do:** Nothing. If you don't want to wait out the ~30s, restarting the stream
(reopen the app, or toggle the camera's Low latency/Compatibility switch) forces it
sooner.

## Background listening on iOS requires Low latency (Compatibility isn't supported there)

**What you see:** On iPhone/iPad, the **Background** listening option is only offered for a camera
in **Low latency** mode. If a camera is set to **Compatibility**, it can't be put into Background
mode on iOS — switch it to Low latency to listen with the screen off. (On Android both modes still
do background audio.)

**Why:** This was tried and deliberately removed. Low latency's audio is WebRTC, which iOS does *not*
treat as a system media item, so Nightlight fully owns the lock screen there — the correct camera
name, the artwork, Pause/Play, and "Multiple Cameras" all work. Compatibility is HLS, and on iOS an
HLS stream *is* a native media item that iOS runs its own lock-screen session for. That session
ignored the name/artwork we set (falling back to the app name), didn't reliably route the
lock-screen Pause to our code (so pausing one camera left the others playing), and got confused with
several cameras or when switching modes. We shipped it briefly (0.6.2) and it was inconsistent enough
to cause more problems than it solved, so background audio on iOS is now Low-latency-only. There is
no reliable way to control an iOS native-HLS lock-screen session from the web layer, which is why we
don't support it rather than ship something flaky.

**What to do:** Use **Low latency** for any camera you want to listen to in the background on iOS.
Compatibility is still available for live viewing; it just can't run in the background there. Android
is unaffected — its foreground background-listening service keeps the process alive, so both modes
sustain background audio.

## Non-monotonic DTS spam in the logs

**What you see:** `docker logs` filling with `Non-monotonic DTS; previous: … current: …`
lines for a camera.

**Why:** Same camera-firmware timestamp glitch as above, at its most minor — FFmpeg is
correcting the timestamps in place and the stream keeps working. It's noisy but harmless.

**What to do:** Ignore it. It's log noise, not an error. (Docker's log rotation, set up in
the README, keeps it from filling the disk.)

## A camera set to AAC audio has no sound, or won't play in Compatibility mode

**What you see:** On a camera configured to stream **AAC** audio, Compatibility (HLS) mode may not play
at all, Low latency may have no sound, and the camera can flap (repeated ~30s "watchdog" restarts).
This shows up on open-firmware cameras (**Thingino / sonoff-hack**) where you can pick the audio codec.

**Why:** Two things. (1) Some camera firmwares advertise AAC but don't actually deliver it under a
sustained pull — they send no audio packets and unstable video, which stalls the stream into the
watchdog loop. (2) Nightlight emits two audio tracks (one for WebRTC/Low-latency, one for HLS); when
the source is *already* AAC, both tracks are AAC and MediaMTX's HLS muxer rejects more than one audio
track (`the MPEG-TS variant of HLS supports a single audio track only`). Nightlight now handles (2)
automatically — for an AAC source it builds the Low-latency track as G711 so HLS gets a single valid
track — but it can't fix (1), a camera that simply won't stream AAC.

**What to do:** **If the camera supports it, set its audio codec to G711 (a-law / "G711A").** G711 is
Nightlight's native path: it streams reliably and gives sound in both Low latency and Compatibility.
This is how the Sonoff/Thingino cameras are happiest — flip AAC → G711A in the camera's web UI.

## A `[guard:…]` error in the log, and Nightlight keeps running

**What you see:** a line like
`[guard:camera-watchdog:Nursery] background task failed (continuing): TypeError: fetch failed …`,
followed by the app carrying on normally.

**Why:** background jobs — the 15-second camera watchdog, the 30-second audio check, the 5-minute
reconcile, the timelapse sampler — are wrapped so that a failure in one of them is reported and
skipped instead of taking the whole app down. The commonest cause is the streaming server (MediaMTX)
being briefly unavailable, which is also exactly what makes a camera look unready in the first place,
so the two tend to appear together. In both watchdogs each camera's check runs independently (up to
four cameras at once), and a camera's main stream and its Low-quality sub-stream are checked
separately, so one camera's failure or stall doesn't hold up the others, nor one stream the other.
A check whose previous run is still going when the next tick comes round is skipped, not queued
behind it. With more than four cameras, if four checks are stuck at once the rest wait for one of
them to finish, which every check does within a bounded time. A check that has been running for over
two minutes is reported as `[guard:camera-watchdog:stale:<name>]` (or `camera-watchdog:sub:stale:`,
`audio-watchdog:stale:`), which shouldn't happen and is worth reading if it does.

**What to do:** if it appears once or twice around a camera restart, ignore it — the next tick
(15-30 seconds later) retries on its own. If the *same* guard line repeats steadily for many minutes,
something is genuinely stuck: check the log above it for what that camera or the streaming server was
doing, and restart the container if cameras are not recovering.

> Nightlight deliberately keeps running after an unexpected error rather than exiting, because it is
> normally left unattended overnight — a monitor that is degraded is more useful at 3am than one that
> has quit. The trade-off is that these lines are worth reading rather than assuming the app is fine
> just because it is still up.

## Cameras show connecting/offline and the log has `[guard:mediamtx-api]` lines

**What you see:** camera tiles go to "connecting" and then "offline", and the log shows a line like
`[guard:mediamtx-api] background task failed (continuing): MediamtxTimeoutError: MediaMTX API did not
answer GET /v3/paths/get/cam_… within 5s`, about once a minute however many cameras are affected.
There is **no** watchdog restart and **nothing** in Camera history. If you turned on camera-offline
alerts, you still get the "No video from … for N+ minutes" notification after N minutes.

**Why:** Nightlight asks the streaming server (MediaMTX) whether each camera is delivering video
through MediaMTX's local API, and every one of those requests has a fixed **5-second** deadline. It
isn't configurable: in the published image MediaMTX runs inside the same container and answers in
milliseconds, so 5 seconds without an answer means it is stuck, not slow. When it doesn't answer,
Nightlight treats the camera's state as **unknown**, and the two automatic behaviours treat unknown
differently on purpose:

| | Needs | While the API isn't answering |
|---|---|---|
| Watchdog restart | 30s of *confirmed* not-ready (audio: 2 *confirmed* stalls in a row) | No restart, no history event. The unknown also resets the 30s, so a restart needs 30 fresh seconds of confirmed not-ready once it answers again. |
| Camera-offline notification | N minutes from the first check that couldn't *confirm* the camera was up (only a confirmed "up" stops the clock) | An unanswered check counts as one that couldn't confirm it, so the clock starts or keeps running and the notification fires as usual. |

Restarting a camera can't fix a streaming server that isn't answering, and might drop a stream that
was actually fine. A parent still needs to hear that video has stopped, though. For the same reason,
while the API isn't answering Nightlight **won't rewrite MediaMTX's path configuration**. The
5-minute reconcile skips the write and asks again next time, because a write reloads the path and
could disconnect a stream that was still working.

**What to do:** check the streaming server from inside the container (the same check as in the
README's troubleshooting section):
```bash
docker exec nightlight wget -qO- http://127.0.0.1:9997/v3/paths/list
```
If that hangs too, MediaMTX is wedged: restart the container. **Known limit:** Nightlight restarts
MediaMTX when its process exits, but not when the process stays alive with an API that has stopped
answering. If the check answers, the stall was temporary: everything recovers on its own at the next
check, and nothing needs restarting.

## Video comes back before Record does, after a restart

**What you see:** a camera's picture returns a minute or so after a restart or a glitch, but pressing
**Record** still says *"This camera isn't buffering yet — it may be offline."* for a few minutes more.

**Why:** two different mechanisms heal them. The live stream is watched every 15 seconds and restarted
quickly; the recording buffer is restored by a housekeeping pass that runs every 5 minutes. So there is
a window where the picture is healthy and there is nothing yet to cut a clip from. Measured on a test
container: picture back after ~60 seconds, recording available on the next 5-minute pass.

**What to do:** wait for the next few minutes and try again. Nothing is wrong, and no action is needed.

---

## An interrupted recording shows as failed rather than disappearing

**What you see:** an entry reading *Couldn't be saved* in the Recordings card, for a recording that was
in progress when Nightlight restarted (a deploy, a reboot, a power cut).

**Why:** a clip is assembled from the buffer *after* you press stop, and a restart during that step
loses it. Nightlight now marks such a recording as failed when it next starts, rather than leaving it
stuck half-finished forever. It tries to finish the clip first, but only for up to 6 seconds — a fixed
limit that allowing your container longer to stop does **not** extend — so a long recording may still
be lost.

**What to do:** re-record if you still need it, then tap the entry and choose **Remove** to clear it —
recordings have no automatic retention, so it stays until you do. *(Older versions hid these
entirely: the recording simply never appeared, with nothing explaining why. If you are on an older
version, a recording that vanished after a restart was almost certainly this.)*

⚠️ **Check your container actually grants that time**, especially on an install created before this
was added. Nightlight needs a few seconds to stop cleanly and it declares that as `--stop-timeout 30` /
`stop_grace_period: 30s`; **Docker's own default is not a reliable substitute** — recent versions
document none, and it has been measured killing the container after about 4 seconds — enough to lose
the recording it was in the middle of saving. Verify with `docker inspect -f '{{.Config.StopTimeout}}' nightlight`:
`30` is right; `<nil>` means nothing is set and Docker will decide for you. See
[Quick start](README.md#quick-start) for where to add it.

---

## The `[obs]` line: what the motion and sound detectors actually observed

**What you see:** every 15 minutes, one line per camera and detector (motion, sound), for example

```
[obs] "Nursery Cam" motion gen=3 path=cam_…-sub samples=4500 real=4497 fpsClone=1 cfrDup=0 cfrDrop=0 runsCapped=0 unknown=2 ambiguous=0 reordered=0 gaps=0/0.0s restarts=1/64.2s cover=99.9%/99.9% age p50/p99=335/378ms compressed=0 clamps=0 uncertain=0 wallSteps=0 side=ok warn=0 late=0
[obs] "Nursery Cam" sound gen=2 path=cam_… samples=4500 observed=4500 silent=0 unknown=0 gaps=0/0.0s delayed=1 restarts=0/0.0s cover=99.9%/99.9% age p50/p99=210/260ms compressed=0 clamps=0 uncertain=0 wallSteps=0 side=ok warn=0 late=0
```

and, occasionally, `[obs] … WALL-STEP +900ms (host clock stepped; not a gap)` or
`[obs] … side-channel unavailable (no tap records) …`.

**Why:** the detectors read a tiny copy of each camera's stream and judge movement and noise from it.
That copy is not a perfect record of time: when a camera stalls, ffmpeg repeats the last picture to keep
five frames a second going, and Node can receive a burst of samples late. Since issue #373, each detector
also reads ffmpeg's own per-frame timestamps and works out, for every sample, how it was produced and
when it was really observed. **Nothing uses this yet.** Motion and sound decisions, alerts, the sleep
timeline and every stored number are exactly as before; the line only reports. Later changes (listed in
the roadmap) will each switch one feature over to it, with their own before/after comparison.

| Field | Meaning |
|---|---|
| `gen` / `path` | The detector's current ffmpeg run (a counter that only goes up while the app runs) and the stream it reads (`-sub` = the low-resolution stream). |
| `samples` | Motion frames or sound windows (0.2 s each) finalised in the last 15 minutes. |
| `real` | Motion: a genuinely new picture from the camera. |
| `fpsClone` | Motion: ffmpeg repeated an older picture because nothing new arrived in time (a camera stall). These still reach the motion detector, which sees them as "no movement". |
| `cfrDup` / `cfrDrop` | Motion: a picture the output stage wrote twice / skipped. Inside a run of identical pictures only the net count is known. Nothing is counted across a lost timestamp line, or for a run counted in `runsCapped`: there the true count is unknown. |
| `runsCapped` | Motion: runs of identical pictures closed early because more than 64 were open at once, which only happens while pictures are not being matched to their timestamp lines. Their duplicates/drops are left out of `cfrDup`/`cfrDrop` rather than guessed. Normally 0. |
| `observed` / `silent` | Sound: windows placed on the audio's own clock; `silent` of them were digital silence (sampled, but not analysed). |
| `unknown` | Samples the evidence cannot place. This is a normal answer, not an error: it means a timestamp record was lost, the stream ended, or the order is in doubt. A lost timestamp line right before or after a run of identical pictures makes the whole run `unknown`: which picture is which can no longer be told. |
| `ambiguous` / `reordered` | The two commonest reasons for `unknown` on motion: a run of distinct frames that scaled to the same picture (about 1 in 9,000 measured), and input timestamps that went backwards. |
| `gaps` | Count / total time of real gaps in what arrived: motion input more than 0.4 s apart (more at a slow frame rate), sound that stayed more than 0.5 s behind its own clock for over a second. A sound gap cannot tell lost audio from audio held back and never caught up, so it is reported as a gap in *observation*, never as "audio lost". |
| `delayed` | Sound: a clump that fell behind by more than 0.25 s and then caught up. Shows how close this camera's network comes to the gap threshold. |
| `restarts` | Count / time between one ffmpeg run's last sample and the next run's first. The cameras here reboot daily, which reads as one ~64 s restart. |
| `cover` | Sampler / analysis coverage of the period: how much of the time was actually observed / actually analysed. |
| `age p50/p99` | How long after being observed a sample reached the detector. About 330 ms is normal for motion (ffmpeg holds each frame until the next arrives). |
| `compressed` / `clamps` / `uncertain` | Timestamps that had to be squeezed to stay in order: after a backlog longer than an hour, after an out-of-order stamp, or after the host clock went backwards. A non-zero `clamps` is worth reporting. |
| `wallSteps` | Times the host clock jumped (NTP). Logged as `WALL-STEP`, never as a gap. UTC for a sample never goes backwards within one run. |
| `side` | `ok`, or `unavailable` if ffmpeg's timestamp lines stopped parsing (for example after an ffmpeg upgrade changes their format) or arrive but cannot be used (for example without the line that gives their time base). A one-off `side-channel unavailable` line says which. Detection carries on untouched; the samples are just `unknown`. |
| `warn` / `late` | Internal errors the observation code caught (should be 0), and data from an ffmpeg run that had already ended (dropped, never mixed into the next run). |

**Differs from the detectors' other log lines:** the `[sound]` level line and the `[oob]`/`[intobed]` lines
describe decisions; `[obs]` describes the input those decisions were made from. The two can disagree —
for example a motion minute full of `fpsClone` samples was "quiet" to the detector because nobody
observed it.

**Limits, stated rather than hidden:**
- **Absolute capture lag is unmeasurable.** The server stamps each frame when it *arrives*, so a delay
  inside the camera looks like a gap followed by a clump, not like late frames.
- **Every threshold was measured on one house**: two Thingino cameras (10 fps sub stream, 15 fps main,
  G711 audio), a fake camera and four measurement runs. A camera or network that jitters more will show
  more `delayed`, `unknown` and `gaps`; AAC audio was only tested with synthetic files. A lost stretch of
  sound shorter than 0.5 s is absorbed rather than reported.
- **A long camera stall keeps its evidence.** ffmpeg writes each picture only once the next one exists,
  so the picture before a stall reaches the detector a whole stall later. Its timestamp line is kept
  until then, however long the stall, and dropped 30 s after the next line has arrived.
- **Everything the observation code keeps is capped**, so a broken stream cannot grow memory: 4,000 input
  and 4,000 output timestamp lines, 256 spans of possibly-lost input frames, 256 out-of-order spans, 256
  sound gaps not yet settled, 10,000 coverage intervals, 8,192 entries per running minimum. In normal
  operation none comes near its cap. The one known way to reach them is a frozen picture: every frame
  identical, as from an encoder stuck on one image, while pictures are not being matched to their
  timestamp lines. Then about 13 minutes of lines are held at 5 fps, and older samples become `unknown`.
  Hitting a cap can only turn an answer into `unknown`, never into a wrong one. On sound, windows older
  than the 256 most recent gaps read `unknown` once that list is full, which only happens when the
  detector's audio output stalls while the timestamp lines keep coming.
- **Timing is exact to within stated bounds, not perfectly.** The 60-second minimum that sound gaps are
  measured against is exact at up to ~136 timestamp lines a second (real cameras send 25-50). The one-hour
  minimum that anchors all times is capped at 8,192 entries. Under a smooth, steady rise of more than
  8,192 entries in an hour, such as a backlog growing for an hour at 10+ lines a second, it can read low
  by the rise between two merged entries, so times come out slightly early, never later than the sample
  arrived. Coverage joins intervals less than a millionth of a millisecond apart, so it can over-state
  the truth by at most that much per join: invisible at the 0.1% printed.
- **A detector process that never finishes** (no known way: Node always reports it) holds back every
  restart that followed it, as unresolved, until it does. The restarts that observed something are all
  kept. Past 16, restarts that failed at once are dropped, and only their exit reason is lost.
- **Cost per camera**: each detector's ffmpeg now prints its timestamps, ~30 lines a second for a 10 fps
  sub stream and ~40 for 15 fps (about 70 for a 30 fps camera with no sub stream), all parsed and
  dropped. The ffmpeg side costs 1-2% more CPU.
- **ffmpeg errors are still logged exactly as before**, with one addition: a burst of identical errors
  is collapsed into `Last message repeated N times` by Nightlight itself, and if ffmpeg's output ever
  floods (more than 50 unrecognised lines at once, then 10 a second), the excess is summarised as
  `[obs] N ffmpeg stderr line(s) not shown (rate limit); last: …`.

**What to do:** nothing — it is diagnostic. If a camera's line shows a steady non-zero `unknown`, `clamps`
or `warn`, or `side=unavailable`, include the line when reporting a detection problem.

---

## Confirmed bugs (fix pending)

### Compatibility (HLS) mode doesn't play when the app is served over plain HTTP

**What you see:** A camera set to **Compatibility** never shows video (the tile sits on
"Connecting…" then "No signal") when you're reaching Nightlight over an **`http://`** URL —
typically a LAN address like `http://<server-lan-ip>` with no reverse proxy / TLS in front.
**Low latency** (WebRTC) mode on the same camera works fine, and Compatibility works fine once
the app is served over **HTTPS**.

**Why:** MediaMTX's HLS server does a cookie-based check on the playlist request and sets that
cookie with the `Secure` attribute. Browsers refuse to store a `Secure` cookie on an insecure
(`http://`) origin, so the check never completes and every HLS request fails. WebRTC doesn't use
that cookie, so Low latency is unaffected. This surfaced while building the end-to-end tests,
where the same thing broke in-browser HLS until the test stack was served over TLS.

**What to do:** Use **Low latency** on a plain-HTTP LAN setup, or put the app behind HTTPS (a
reverse proxy such as SWAG — see the README's "Running behind a reverse proxy" section), after
which Compatibility works. A proper fix (e.g. having the app strip `Secure` from that cookie when
it's serving over HTTP) is not yet implemented.
