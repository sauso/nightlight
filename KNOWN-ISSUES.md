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
when it was really observed. **One thing uses it so far:** since issue #493, a motion frame it *proves*
was a repeat is left out of the sleep timeline's per-minute frame count and average movement (see the next
section). Motion and sound decisions, alerts, bed transitions, the sleep numbers and every stored peak are
exactly as before. Later changes (listed in the roadmap) will each switch one more feature over to it, with
their own before/after comparison.

| Field | Meaning |
|---|---|
| `gen` / `path` | The detector's current ffmpeg run (a counter that only goes up while the app runs) and the stream it reads (`-sub` = the low-resolution stream). |
| `samples` | Motion frames or sound windows (0.2 s each) finalised in the last 15 minutes. |
| `real` | Motion: a genuinely new picture from the camera. |
| `fpsClone` | Motion: ffmpeg repeated an older picture because nothing new arrived in time (a camera stall). These still reach the motion detector, which sees them as "no movement". Since #493 they are left out of the stored per-minute frame count and averages (next section). |
| `cfrDup` / `cfrDrop` | Motion: a picture the output stage wrote twice / skipped. Inside a run of identical pictures only the net count is known. Nothing is counted across a lost timestamp line, or for a run counted in `runsCapped`: there the true count is unknown. |
| `runsCapped` | Motion: runs of identical pictures closed early because more than 64 were open at once, which only happens while pictures are not being matched to their timestamp lines. Their duplicates/drops are left out of `cfrDup`/`cfrDrop` rather than guessed. Normally 0. |
| `observed` / `silent` | Sound: windows placed on the audio's own clock; `silent` of them were digital silence (sampled, but with no loudness to analyse). Since issue #453 those windows are still recorded in the per-minute sound history, as quiet (0 over ambient): see "A muted or digitally silent microphone is recorded as a quiet room". Do not compare `silent` with a minute's sound-window count: `silent` counts windows the audio clock could place in the 15-minute period (it is 0 whenever that clock is unavailable), the history counts every window by the minute it arrived in. |
| `unknown` | Samples the evidence cannot place. This is a normal answer, not an error: it means a timestamp record was lost, the stream ended, or the order is in doubt. A lost timestamp line right before or after a run of identical pictures makes the whole run `unknown`: which picture is which can no longer be told. |
| `ambiguous` / `reordered` | The two commonest reasons for `unknown` on motion: a run of distinct frames that scaled to the same picture (about 1 in 9,000 measured), and input timestamps that went backwards. |
| `gaps` | Count / total time of real gaps in what arrived: motion input more than 0.4 s apart (more at a slow frame rate), sound that stayed more than 0.5 s behind its own clock for over a second. A sound gap cannot tell lost audio from audio held back and never caught up, so it is reported as a gap in *observation*, never as "audio lost". |
| `delayed` | Sound: a clump that fell behind by more than 0.25 s and then caught up. Shows how close this camera's network comes to the gap threshold. |
| `restarts` | Count / time between one ffmpeg run's last sample and the next run's first. The cameras here reboot daily, which reads as one ~64 s restart. |
| `cover` | Sampler / analysis coverage of the period: how much of the time was actually observed / actually analysed. |
| `age p50/p99` | How long after being observed a sample reached the detector. About 330 ms is normal for motion (ffmpeg holds each frame until the next arrives). |
| `compressed` / `clamps` / `uncertain` | Timestamps that had to be squeezed to stay in order: after a backlog longer than an hour, after an out-of-order stamp, or after the host clock went backwards. A non-zero `clamps` is worth reporting. |
| `wallSteps` | Times the host clock jumped (NTP). Logged as `WALL-STEP`, never as a gap. UTC for a sample never goes backwards within one run. |
| `side` | Whether the timestamp evidence could place **any** sample in **this** 15-minute period. It is judged afresh every period, so it goes back to `ok` as soon as samples are placed again. `ok`: at least one sample was placed. `unavailable`: every sample was `unknown`. That happens when ffmpeg's timestamp lines stopped arriving or parsing (for example after an ffmpeg upgrade changes their format), or arrive but cannot be used (for example without the line that gives their time base). It also happens on sound once one timestamp line is lost, because every later window of that ffmpeg run is `unknown`, and on motion when every picture was identical, as from a frozen camera (then `ambiguous` equals `unknown`). `pending`: no sample was finalised this period (`samples=0`), so there is nothing to judge. A *partial* loss leaves `side=ok` and shows in `unknown`. When a run's timestamp lines are unusable from its very start, a one-off `side-channel unavailable` line also says which of the first two causes it is. A failure later in a run shows only here. Detection carries on untouched; the samples are just `unknown`. |
| `warn` / `late` | Internal errors the observation code caught (should be 0), and data from an ffmpeg run that had already ended (dropped, never mixed into the next run). `warn` stays 0 on a stream that has stopped being usable: nothing threw, so that shows in `side`, not here. |

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

## A stalled camera's repeated pictures are left out of the per-minute motion count

**What you see:** nothing in the app. For each camera and minute, the sleep timeline (`activity_samples`,
also returned by `GET /api/cameras/:id/activity-history`) stores how many motion frames were analysed
(`motion_frames`) and the average movement in and outside the bed (`motion_level`, `motion_out_level`).
Since issue #493, those three leave out every frame the `[obs]` measurement above *proved* was a repeat: an
`fpsClone`, or a `cfrDup` it could label one by one. No screen shows these three numbers directly. Since
issue #508 the sleep numbers read `motion_frames` to decide whether a minute was watched at all (see "Minutes
with no video are unknown in the sleep numbers").

**Why:** when a camera stalls, ffmpeg keeps five frames a second going by repeating the last picture, and
the motion detector reads each repeat as a perfectly still room. A 3-second stall makes about 15 of them. A
camera that is slower than 5 fps makes some every second (2 in every 5 frames at 3 fps). Counting them made
a minute look more closely watched, and stiller on average, than it really was. Leaving a repeat out can
only raise a minute's average, never lower it, because a repeat's movement is always exactly zero.

**Differs from the neighbouring numbers** — this is the part that is easy to get wrong:

| Stored or decided | Proven repeats |
|---|---|
| `motion_frames`, `motion_level`, `motion_out_level` | Left out |
| `motion_peak`, `motion_out_peak` (what every sleep threshold reads) | Unchanged. A peak is the minute's largest movement, and a repeat never moves anything |
| Whether a minute is stored at all, and the live wake check | Unchanged: every analysed frame still counts, as before |
| Motion alerts, in/out-of-bed transitions | Unchanged: decided the moment a frame arrives, before `[obs]` can judge it (issue #452) |

A minute in which *every* analysed frame was a proven repeat is still stored: `motion_frames` 0 and an
empty `motion_level`, beside a `motion_peak` of 0, exactly as it was stored before. Since issue #508 the sleep
numbers treat such a minute as **unwatched** (unknown), not as a still room.

**Limits, stated rather than hidden:**
- **Only proven repeats are left out, never `unknown` frames.** A genuinely still room, or one lost
  timestamp line, can make a *real* frame `unknown` as well. So when the timestamps are unavailable
  (`side=unavailable` on the `[obs]` line), nothing is left out and the numbers are what they were before
  #493.
- **A camera that keeps stalling can still leave some repeats counted.** `[obs]` judges a frame about 5
  seconds after it arrives, but only once more video has arrived after it. Since issue #447 each minute is
  stored 7 seconds after it ends (next section), so on a camera that keeps delivering video every repeat is
  judged in time: none of a steady 3 fps camera's repeats stay counted, where 8.3% (the ones in a minute's
  last 5 seconds) did before #447. A camera that stalls, sends a second or two of video and then stalls
  again is judged only when its video comes back: in the tested case (a 3-second stall, 1.5 seconds of video,
  a 20-second stall) the first stall's 15 repeats were judged 21 seconds late, after their minute was stored.
  Those stay counted, and the `[activity]` log line counts them (next section). A stored minute is never
  corrected afterwards.
- **A frame that registered any movement is never left out**, whatever `[obs]` says about it. A true repeat
  never registers movement, so this only guards against a wrong verdict.

**What to do:** nothing.

## The sleep timeline's minutes are the minutes the samples arrived in

**What you see:** usually nothing. The sleep timeline (`activity_samples`, also returned by
`GET /api/cameras/:id/activity-history`) stores one row per camera per minute of motion and sound. Since
issue #447 a row labelled 19:01 holds exactly what that camera's motion and sound detectors received from
19:01:00 to 19:01:59, and it is stored about 7 seconds after 19:02:00. The labels are UTC minutes, like every
other time in the database, whatever timezone the app is set to. In the log, at most once per camera every
15 minutes and only when there is something to count, a line like

```
[INFO] [activity] cam_…: 3 clone verdict(s) arrived after their minute was stored (left counted), 0 sample(s) moved to the next minute after a small clock step
```

and, only if the server's clock jumps, a `[WARN] [activity] …` line saying so.

**Why:** before #447 the rows were written by a timer that fired once a minute, counted from whenever
Nightlight started, and each row was labelled with the minute the timer fired in. That second-within-the-
minute changed on every restart, so a row labelled 19:01 held 19:00:35 to 19:01:35 on one boot and 19:00:10
to 19:01:10 on the next, and a late timer blended a longer stretch into one row. Now each sample is filed by
when its video or audio reached Nightlight, read once per chunk, so a frame's in-bed and out-of-bed readings,
and all the sound readings from one chunk, always land in the same minute.

**Differs from before** — the part that is easy to get wrong:

| | Since #447 | Before |
|---|---|---|
| A row's minute (`bucket_start`) | The UTC minute its samples arrived in | The minute a timer fired in, 0-60 s after the samples, different after every restart |
| When the row is stored | 7 s after the minute ends: the `[obs]` measurement needs 5 s to judge a minute's last frames, plus 2 s of margin | Once a minute, at the timer |
| When the live wake check hears a minute | Within 1 s of the minute ending | 0-60 s after it |
| Where a wake clip starts | 3 s before the END of the wake's first active minute | 3 s before the old row label: a restart-dependent point inside that minute, on average 30 s earlier |
| Thresholds, peaks, what counts as active | Unchanged | |

The wake-clip anchor is deliberate. The recording ring a clip is cut from is only as deep as the clip
settings make it: 63 seconds with on-demand Record on, 38 with it off, 23 at the smallest clip settings.
Anchoring on the true start of the minute would ask the ring for footage a minute older than it keeps, and
lose the clip's opening on the smaller rings. Starting the clip at the first moving frame instead is issue
#412.

**Sleep numbers can move on a borderline night.** Each row moves by less than a minute, but the sleep rules
have sharp edges (15 quiet minutes to fall asleep, 20 minutes away from the bed to be up for the morning), so
the same movement cut into minutes differently can move a computed bedtime or wake time by much more than a
minute on a night that was already borderline. Nights already stored keep the times computed before the
update, and a night recomputed later reads whatever rows it has: rows written before the update keep their
old labels until the 30-day retention removes them.

**Limits, stated rather than hidden:**
- **A restart loses the minute being received**, up to 60 seconds, as before. A minute that had ended and was
  waiting its 7 seconds is now stored on the way out instead of being lost with it.
- **The server's clock stepping back.** After a small step back (an NTP correction, a resumed virtual
  machine), samples that would fall in a minute already handed on go into the minute still being received
  instead, and the `[activity]` line counts them as moved. That minute then holds everything received until
  the clock reaches its end. "Small" means a step of at most 2 minutes plus however far into the current
  minute it happens (so 2 to 3 minutes), and one row then holds at most about 4 minutes of samples (measured:
  3.9 minutes at worst, across steps of 5 seconds to 5 minutes made at every point in a minute). A bigger
  step is not lumped: it is taken as given, the minutes the clock passes through again are stored a second
  time (two rows for the same camera and minute, which the sleep analysis merges), and a warning is logged,
  either `the wall clock went back …` or, for a step of roughly 2 to 3 minutes, `activity was filed under
  minutes ahead of the clock …`. While the server keeps running, a second row for a minute is written only
  after one of those two warnings (a clock that went back while Nightlight was restarting leaves no warning,
  as before). A minute already handed to the wake check is never added to afterwards: if the clock walks back
  into it, it is stored as it stood and the repeat gets a row of its own, which the wake check hears too.
- **The server's clock jumping ahead and back.** Minutes read while the clock was ahead are stored under
  those future labels. They are written as soon as the clock comes back, not an hour later.
- **Measured on one house.** The 7-second wait fits cameras whose low-resolution stream runs at 10 to 15
  frames a second, because `[obs]` judges a frame once the next one arrives. A much slower camera, or one that
  keeps stalling, will show late clone verdicts on the `[activity]` line (previous section). The wake-clip
  anchor fits the ring depths above.
- **A minute is when the data arrived, not when the camera captured it.** The two are normally a fraction of
  a second apart, but a stalled camera delivers a burst late. Filing by capture time is deferred (issue #447,
  Stage B).

**What to do:** nothing. If one camera's `[activity]` line reports late clone verdicts every 15 minutes, its
stream keeps stalling: check the same camera's `[obs]` line.

## Minutes with no video are unknown in the sleep numbers

**What you see:** on a night where the camera's video stalled but its sound kept running, the sleep detail
shows the stall as a striped **"No data"** stretch, the night's coverage is lower, and the sleep counted is
less than the hours between bedtime and waking. A night that is mostly stalled reads "no data".

**Why:** the motion and sound detectors are separate processes. When the motion detector stops receiving
video (issue #369), the sound detector keeps writing a row for every minute. Before issue #508 every such
row counted as a watched, quiet minute: on staging, stalls of 522 minutes (ending 2026-09-17 10:00) and 284 (ending 2026-09-27 10:00) reported
full coverage and zero unknown minutes. Measured by replaying every stored staging night with the old and the
new code (2026-09-30): 88 of 90 nights are identical, and the two that change are exactly the two stalls, by
the part inside the 19:00-07:00 window (342 and 104 minutes; the second changes only `coverage_minutes`,
because that stall lies after the analysed sleep span). Production was not measured. Now a minute
counts as watched only if the motion detector analysed at least one real frame in it (`motion_frames > 0`;
since #493 that count leaves out ffmpeg's proven repeated frames, so a minute of nothing but repeats is
unwatched too). An unwatched minute is handled exactly like a minute with no row at all (issue #442).

**Differs from the neighbouring rules** — the part that is easy to get wrong:

| | Minute with video (1 frame or more) | Minute with no video (0 frames) |
|---|---|---|
| Coverage, and the "no data" line (half the window) | Counts | Does not count |
| Asleep / awake / longest stretch | Counted normally | Unknown: not asleep, not awake, breaks the stretch |
| Its sound (a cry, household noise) | Used as before | **Not used**, even a loud minute |
| Its movement readings | Used as before | Not used (a stalled minute's readings are empty or repeats) |
| Bedtime search | Normal | Cannot be the bedtime; a stall over bedtime moves bedtime to the first quiet minute after the video returns |
| "No one was in the bed" | Needs at least **90%** of the window watched (default 0.9, `EMPTY_MIN_COVERAGE_FRAC`; a constant, not a setting; any value above the 0.5 "no data" line and up to 1 is coherent). Window minutes only, never the 3 hours before it; on a night still in progress, 90% of the part elapsed so far, the same basis as the "no data" line | Counts against that 90%; below it the night is "no data" |

**Why sound is not used in an unwatched minute:** a bedroom microphone hears the whole house, and a
noise nobody saw cannot be told apart from a sibling next door. The cost, stated: a child crying through a
video stall is not shown as awake from the noise alone. Sound **alerts** are a separate path and still fire.

**Why "no one was in the bed" needs 90%:** that answer sends the "no one was in the bed" report and
**deletes the night's timelapse frames**. Before #508 a night watched for exactly half the window, quiet in
that half, could read empty. 90% is a first estimate chosen so the ~1-minute daily camera reboot and
scattered dropped minutes can never block a genuinely empty night, while missing more than about an hour of
a 12-hour window does. It was not measured against stored nights when chosen. On a night still in progress
("Tonight") it applies to the part of the window elapsed so far, so the live card can say "no one in the
bed" early in the evening; that is only a display. The report and the frame deletion come only from the
nightly job, which only ever scores a night whose window has closed, against the whole window.

**Nights already stored** change only when recomputed (the nightly job's own passes in the ~3 hours after
the window closes, or **Recompute this night**). Recompute never turns a scored night into "no data", so a
night stored before this update whose video stalled for most of it keeps its old numbers. The refusal is
**API-only today**: the Sleep detail page shows no Recompute button on a night that now reads "no data" or
"no clear sleep", so no parent sees it. From the API (`GET /api/children/:id/sleep/:date?store=1`, admin),
the 409 no longer claims the data aged out when it did not: it adds `reason` (`aged_out` when nothing is
left to read; `too_little_watched` when the video was seen for too few minutes to score the night, or to
call it empty, and says how many; `no_longer_scored` when the night was watched but now reads, for example,
"no clear sleep"), `status` (what the recompute came out as) and `coverage_minutes`. `error` keeps its
closing sentence.

**Limits, stated rather than hidden:**
- **A frozen picture is still a watched, still room.** A camera whose encoder wedges keeps delivering many
  real, identical frames: frames above zero, no movement. Neither this rule nor any frame-count threshold
  can catch it.
- **Only zero frames counts as unwatched.** A minute with a handful of frames is watched, because a peak is
  the minute's largest movement and a few real frames still see real movement, and because the daily camera
  reboot leaves short runs of sparse minutes (measured on staging over 30 days: 36 runs, all a single minute,
  30 of them starting at the 10:00 reboot, so they fall outside a night's window; issue #508 said 21, which did
  not hold; the number on another install is unknown) that must not lose coverage.
  Whether sparse minutes mislead is not measured yet.
- **A minute is decided as a whole, from the in-bed frame count.** In a rare case a minute can store zero
  in-bed frames (every frame proven a repeat) while its movement *outside* the bed was real (the two are
  corrected separately, issue #493). That out-of-bed movement is then discarded with the rest of the minute.
  It needs the observation clock to call every frame of the minute a repeat while the picture outside the bed
  changed, which a true repeat cannot do, so it would take a clock misclassification. Measured on staging
  (2026-09-30): 0 such rows, but only about 14 hours of data exist since #493's clone correction reached it, so
  this is "not seen yet", not "cannot happen". If it ever shows up, a minute with any non-zero motion peak
  should count as watched (a repeat's change is exactly 0, so a non-zero peak proves a real frame).
- **Not yet applied to the live wake watcher or the bed-transition rules.** The live "is the child awake"
  check and the bed in/out rules still read the movement peak alone, so during a stall the live watcher can
  still call the room settled. Follow-up issues.
- **A parent's corrected night** subtracts the night's stored unknown minutes from the corrected span as
  one total (an existing limit of corrections). A recompute that adds many unknown minutes to a corrected
  night can therefore shrink its displayed sleep more than the stall alone explains. Since a corrected
  night's saved summary is locked (README, "A night you have corrected is locked"), that no longer happens
  to the child's card after the correction is saved; the figure stops changing but is not made exact. The
  sleep detail page works the night out fresh each time, so it can still show it.

**What to do:** nothing. If a night shows a long "No data" stretch while the camera was plainly on, check
the Camera history for a `[detector-watchdog]` restart (next section) around that time.

## A muted or digitally silent microphone is recorded as a quiet room

**What you see:** for a camera whose microphone delivers *digital silence* (every audio sample exactly zero),
the per-minute sound history (`activity_samples`) shows those minutes as quiet, 0 dB over ambient, instead of
having no sound at all, and the `[sound]` level line keeps printing every 15 seconds with `peak=?dB` (and
`ambient=?dB` until the camera has heard some real sound). Silence on its own never sets off a sound alert.

**Why:** each 200 ms window of audio is turned into a loudness level. A window of exact zeros has no
loudness at all (minus infinity in dB), and until issue #453 the sound detector threw such a window away as
if nothing had arrived. That made a muted or gated microphone look like no microphone: those minutes stored
no sound, a detector reconnecting during the silence could be stopped as "does this camera have a
microphone?", and, worst, the silence between separate noises was skipped, so a few short noises seconds
apart averaged out as one long loud sound and could send an alert (measured in a replay: a sound every 2
seconds with silence between alerted after ~32 seconds; the same sounds with ordinary quiet between them never
did). Now a silent window counts as **heard, and exactly at the room's learned ambient level**: the same as a
moment of perfect quiet. No setting or threshold was added or changed.

**Differs from the neighbouring cases** — the part that is easy to get wrong:

| | Digital silence (every sample 0) | A quiet room (real, faint sound) | No audio arriving at all |
|---|---|---|---|
| Per-minute history | Sound 0, every window counted; a row is written even with no movement | A small excursion around 0, every window counted | Nothing from sound (no row unless there was movement) |
| Alerts | Never on its own (it counts as quiet in the 4-second average) | When a noise rises past the margin | Never |
| Learns the room's ambient level | **No** (there is nothing to learn from) | Yes, continuously | No |
| A quick reconnect ("does this camera have a microphone?") | Not counted | Not counted | Counted; three in a row stop sound detection |
| Sleep numbers | Quiet, like a quiet room | Quiet unless a noise passes 6 dB over ambient | Decided by the video alone |

In every column a minute with no video is unknown in the sleep numbers, whatever its sound (previous
section).

**Limits, stated rather than hidden:**
- **Silence cannot teach the app the room's ambient level.** A detector that has only ever heard silence has
  nothing to measure against, so the first ~5 seconds of real sound it hears become the ambient level. If
  that first sound is a sustained cry (a microphone un-muted into a crying room), the cry *is* the ambient
  and that first cry is not alerted. Fixing it would mean guessing a floor level, which was rejected: a
  guessed floor makes every ordinary household noise after a silent spell read as loud.
- **Silence holds the ambient level where it is; it never brings it down.** Only real, quieter sound lowers
  it. And sounds heard between stretches of silence can raise it slowly through the ordinary ~20-second
  tracking: a sound too faint to alert, repeated with silence between, creeps the ambient toward its own
  level, as it would in a room whose quiet moments sat exactly at the ambient.
- **While the ambient is still being learned** (about the first 5 seconds after a start with no learned
  level), an audible window records nothing, but a silent one records 0.
- **Stored minutes before and after this change differ.** Before it, a minute of silence stored no sound
  (NULL) and a minute with some silence averaged only its audible windows; from the first release after
  0.34.0 a silent window is stored as 0 and included in the minute's sound average, `sound_p75`, `sound_p90`
  and `sound_sd`. Nights already stored are not changed. Anything that compares those columns across time
  (the planned sound-statistics work, ROADMAP §1.4 Phase 2) must not mix rows from before and after that
  release for a camera that delivers silence.
- **How often it happens depends on the camera.** On the install it was developed on, G711 A-law audio was
  never digitally silent in about 1.5 million windows (A-law cannot decode to exact zero), so there it
  changes nothing. Muted or gated microphones, and codecs that encode silence as zeros, can. The `[obs]` line's
  `silent=` count shows whether a camera does.

**What to do:** nothing. If a camera's history shows long stretches of exactly 0 sound and its level line
says `peak=?dB`, its microphone is delivering silence: check whether it is muted in the camera's own settings.

## A detector was restarted: `[detector-watchdog]` in the log and in Camera history

**What you see:** a `restart` in **Settings → Logs → Camera history** reading *motion detector getting no
frames (no data for 75s) - motion detector restarted by the detector watchdog* (or the same for *sound … no
audio data*), and in the log one line like

```
[WARN] [detector-watchdog] "Nursery Cam" motion on cam_…-sub: no data for 75s; path ready, 2 reader(s), tracks H264+Opus; probe: video packets arriving (packets, not frames); input tap: last record 74s ago; attempt 1; lever: detector
```

followed by `[INFO] [detect:…] stopped by the detector watchdog (no frames), restarting in 5s`. If it happens
again soon after, a later line says `lever: detector + sub publisher` (or `main publisher`), and the camera
watchdog logs `restarting its sub-stream (Low) at the detector watchdog's request`.

**Why:** each camera's motion and sound detectors are small ffmpeg processes reading the camera's stream.
One can stay alive and connected while receiving nothing at all. That happened on a real install for 4h45
and 8h43 in one month, silently, until the camera's daily reboot: the stream looked ready, audio kept
flowing, and nothing else was watching the detector itself (issue #369). The detector watchdog checks every
15 seconds whether each running detector's ffmpeg has written anything in the last minute. **It watches
bytes, not movement or sound**: a still, silent room still delivers frames and (silent) audio samples, so a
quiet night never trips it. When one has gone dark, it:

1. restarts **the detector** (it relaunches 5 s later, re-choosing the Low stream if that is available);
2. **motion only:** if that detector goes dark again, also asks the camera watchdog to restart **the stream
   it reads**: the Low sub-stream, or the main stream when the detector reads that (a camera with no
   sub-stream, or a detector that fell back to the main stream). **A main-stream restart briefly interrupts
   live view.** A sound detector is only ever restarted itself: its stream's audio is the audio watchdog's.
   The request is only acted on if the camera is still enabled, detection is still on, the stream is ready
   and the detector is still getting nothing, and it expires after 60 seconds. It is also dropped if the
   detector relaunched onto the other stream before the camera watchdog's next 15-second check reached it; if
   that stream fails too, the request for it comes at the next backoff step in point 3 (2 minutes after a
   second attempt, doubling to 30), not when the dropped one would have expired;
3. backs off between attempts: 1, 2, 4, 8, 16, then every 30 minutes, until the detector has been healthy
   for 5 unbroken minutes.

For a **sound** detector, the watchdog first checks whether audio is arriving on the stream. "No audio on the
stream" leaves the case to the audio watchdog. An inconclusive check (it could not run, or it failed; a failed
run counted as "no audio" before issue #515) is acted on at the second consecutive check, after which the
usual backoff above applies, so a check that keeps failing can cost a sound-detector restart at 1, 2, 4, 8 and
16 minutes and then every 30. The check reads the local MediaMTX and only runs on a stream just reported ready,
so it fails only when the stream drops in between; whether ffprobe exits non-zero when a session drops after
setup, rather than exiting 0 with no packets, has not been verified.

A detector that has not been started yet, is waiting for its stream to come up, or is between relaunches
is left alone, and a new one gets 90 seconds to deliver its first frame. A stream that is not ready (the
camera rebooting, MediaMTX down) is the camera watchdog's job, not this one's.

| Setting (fixed, not configurable) | Default | What it means |
|---|---|---|
| Check interval | 15 s | How often each detector is looked at. |
| Stale after | 60 s | No output for longer than this = dark. A healthy detector writes ~5 times a second. |
| Startup grace | 90 s | How long a new detector gets for its first output. |
| Backoff | 1 min doubling, capped at 30 min | Between two actions on the same detector. |
| Recovered after | 5 min | Unbroken health that forgets the attempt count. |
| Crash-loop escalation | 3 min | Stream restart asked for when two or more relaunched detectors in a row delivered nothing, with no healthy moment since the last action (the relaunch keeps dying before anyone can judge it). |
| Request expiry | 60 s | A stream-restart request not acted on by then is dropped. |
| Worst case to recover | ~90-105 s | From the last frame to fresh frames, for a stuck detector on the Low stream. Up to ~150 s if it was on the main stream, because a relaunched motion detector waits up to 45 s for the Low stream first. A stuck restream takes ~5-6 minutes (detector first, then the stream). |

**Differs from the neighbouring watchdogs**, which are easy to confuse with it in Camera history: the
**camera watchdog** restarts a stream MediaMTX reports as *not ready* for 30 s; the **audio watchdog**
restarts a camera whose *main stream's audio* stopped for two checks; the **detector watchdog** restarts a
*detector* that stopped receiving while its stream looks fine. Only the detector watchdog's rows say
"detector".

**What a restart resets:** on motion, the alert cooldown (so a motion alert can fire again sooner than the
cooldown after a restart: the existing behaviour of every detector relaunch, issue #454), a motion run
that was building up to an alert, and a pending bed-exit or bed-entry candidate. The motion detector's
belief about whether the child is in bed, and the sound detector's learned ambient level and cooldown, are
kept. A restarted motion detector also returns to the Low stream if it had fallen back to the main one
after a blip (#500); this does not help a detector that never goes dark.

**Limits, stated rather than hidden:**
- **The minutes before the restart are still lost.** Since issue #508 the sleep numbers report those dark
  minutes as unknown ("No data") rather than as quiet sleep (previous section), so a restart shortens a hole
  in the night; it does not fill it.
- **The numbers were chosen, not measured on many rooms.** A camera that delivers less than about one frame
  a minute would be restarted at the backoff cadence (no supported camera does). Nothing assumes a frame
  rate or 300 frames a minute.
- **Sound needs audio on the stream to be restarted.** Before restarting a sound detector, the watchdog
  checks the main stream for audio. A camera that sends no audio at all in a quiet room (G.711 voice
  activity detection, Opus DTX) is left alone, which is right for it. If the check itself fails twice in a
  row the detector is restarted anyway, so a broken check cannot switch this recovery off. A DTX camera that
  sends occasional comfort-noise packets can still pass the check: at most one pointless restart per 30
  minutes.
- **A detector that delivers a little in every minute but never five healthy minutes in a row** keeps its
  attempt count, so it settles at one restart every 30 minutes (one Camera history row each, out of 2,000
  shared by all cameras) instead of churning.
- **The stream check in the log line is a diagnosis, never a decision.** "Video packets arriving" means
  packets reached the stream, not that the detector could decode them, and "no video" cannot be proven by a
  short probe. Nothing is skipped or done because of what it says.
- **A stream restart that is already running when a camera is disabled can still finish**: the same, older
  limit as every other automatic restart (the camera watchdogs, reconcile and the camera settings routes do
  not yet take turns). The detector watchdog never STARTS one after a camera is disabled, detection is
  switched off or a sleep-sampling window closes: all three drop its requests.

**What to do:** nothing, it is self-healing. If one camera shows these rows regularly, include the
`[detector-watchdog]` lines when reporting it: the `path`, `probe` and `input tap` fields say where the
stream stopped (the detector's side, or the stream it reads), which nothing could tell before.

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
