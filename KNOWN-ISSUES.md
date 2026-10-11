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
`[obs] … side-channel unavailable (no tap records) …`, or, on a sound detector, a warning (once per camera
per 15-minute period at most) such as `[obs] "Nursery Cam" sound gen=2 timestamp sequence broke (a record
failed to parse): the rest of this ffmpeg run's windows are reported UNKNOWN. This is the timestamp
measurement only; …` (see "A sound line that reads `side=unavailable` does not, by itself, mean the sampler is dead", below).

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
| `side` | Whether the timestamp evidence could place **any** sample in **this** 15-minute period. It is judged afresh every period, so it goes back to `ok` as soon as samples are placed again. `ok`: at least one sample was placed. `unavailable`: every sample was `unknown`. That happens when ffmpeg's timestamp lines stopped arriving or parsing (for example after an ffmpeg upgrade changes their format), or arrive but cannot be used (for example without the line that gives their time base). It also happens on sound once one timestamp line is truly lost (since issue #573 a *torn* sound timestamp line, one with another message glued onto its unused tail, is recovered and no longer does this), because every later window of that ffmpeg run is `unknown`, and on motion when every picture was identical, as from a frozen camera (then `ambiguous` equals `unknown`). `pending`: no sample was finalised this period (`samples=0`), so there is nothing to judge. A *partial* loss leaves `side=ok` and shows in `unknown`. When a run's timestamp lines are unusable from its very start, a one-off `side-channel unavailable` line also says which of the first two causes it is. A failure later in a run shows only here. Detection carries on untouched; the samples are just `unknown`. |
| `warn` / `late` | Internal errors the observation code caught (should be 0), and data from an ffmpeg run that had already ended (dropped, never mixed into the next run). `warn` stays 0 on a stream that has stopped being usable: nothing threw, so that shows in `side`, not here. |

**A sound line that reads `side=unavailable` does not, by itself, mean the sampler is dead.** A period such as
`observed=0 unknown=4500 side=unavailable cover=0.0%/0.0%` means the timestamp *measurement* is blind. The
loudness readings the sound detector decides from come from the audio itself, a separate path, so the
`[sound] "<camera>" ambient=…` lines keep printing and alerts keep firing. To check, look at the stored
history: `activity_samples.sound_windows` is about 300 per minute (one 200 ms window each) while the
detector is sampling. It happens when one sound timestamp record is truly lost: the clock cannot know how
many samples that record held, does not guess, and reports every later window of that ffmpeg run as
`unknown`. When a run goes blind the warning line above says so and why (`a record failed to parse`,
`n jumped A -> B` or `the first record was n=N`), once when the run goes blind (and at most once per camera
per 15-minute period): it is not repeated in later periods of the same run, so for a run that has been blind
for hours look for it in the container log (`docker logs`), not only in the app's recent-lines view.
**What to do:** nothing. The measurement comes back by itself at the next ffmpeg restart (a reconnect, or a
camera's daily reboot); nothing is restarted for it, because that would cost seconds of real detection to
repair a measurement no decision reads yet. Include the warning line when reporting a sound problem. The
one exception: if EVERY sound run reports `side=unavailable` from its first period, together with the
one-off `side-channel unavailable (no tap records)` line, the timestamp lines have stopped parsing (for
example after an ffmpeg upgrade). That is worth reporting, with those lines.
*History, stated plainly:* before issue #573 the usual cause was a torn record. ffmpeg prints one timestamp
record in several pieces, and another message (the muxer's `Application provided invalid, non monotonically
increasing dts`) can land between them, which the parser then counted as a lost record. On a two-camera
staging install that happened about once per camera per day, and it was also seen on a production install,
for hours at a time. No stored number was affected: nothing reads the sound side of `[obs]` yet, so it
only changed this display. Since #573 a torn record whose first half is intact is recovered (the
message is still logged exactly as before), and the warning is how a genuine loss is told apart from a
dead sampler.

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
- **Only a torn *sound* timestamp line is recovered (issue #573).** A torn *motion* timestamp line is still
  treated as lost, as before: the motion clock handles that locally (a few samples `unknown`, 174 of 6.17
  million on the two staging cameras measured) and recovering it would change which frames the clone filter
  labels, which is a separate change. The sound recovery relies on ffmpeg printing a record's timestamp
  fields in one piece: that is read from ffmpeg 8.1.2's source and matches all 18 torn records found in the
  saved staging and production logs, but it has not been tested against a real ffmpeg run. A different
  ffmpeg that splits them differently would show as the one-off `side-channel unavailable (no tap records)`
  line (if no record ever parses) or as the warning above (if a later record opens a hole), not as a wrong
  timestamp.
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
or `warn`, or `side=unavailable`, include the line when reporting a detection problem. For a sound line
reading `side=unavailable`, also include the `timestamp sequence broke` warning, and see the paragraph above
before concluding the microphone stopped.

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
| Motion alerts, in/out-of-bed transitions | Not corrected by `[obs]`: decided the moment a frame arrives, before it can judge it. A stall's repeats are not what stops them, a **gap in the arriving frames** is (issue #452, next section) |

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

## A motion alert or a bed exit/entry is not confirmed across a gap in the video (`confirmation restarted` in the log)

**What you see:** usually nothing. In the log, only when something was waiting to be confirmed and the camera's
video stopped arriving for a moment, one of

```
[INFO] [oob] "Nursery Cam" confirmation restarted — no frames for 3060ms (needs 6000ms of received quiet from here)
[INFO] [intobed] "Nursery Cam" confirmation restarted — no frames for 3060ms (needs 6000ms of received quiet from here)
[INFO] [detect] "Nursery Cam" motion run restarted — no frames for 3060ms
```

(`system clock stepped back 500ms` replaces `no frames for …` if the server's clock was set back.) A healthy
camera at its normal rate never prints them; a cold slow camera prints a few `motion run restarted` lines while
its window warms up (see "What counts as a gap").

**Why:** a motion alert (the *Motion confirm* setting) and a bed exit/entry (6 seconds of quiet) used to measure
the *time elapsed* since they began, not how much video had actually arrived in it. A motion run that was
active, then silent for 20 seconds, then active again was alerted on at once as "sustained", and a single quiet
frame arriving after a long hole confirmed a bed exit as if 6 quiet seconds had been watched (issue #452).
Both now count **video that arrived**: a frame that reaches Nightlight after a gap restarts the count, and a
confirmation then needs its full time of frames received *after* the gap.

**Differs from the neighbouring numbers** — the part that is easy to get wrong:

| Stored or decided | After a gap in the video |
|---|---|
| A motion alert (*Motion confirm*) | The run restarts at the first frame after the gap. `Motion confirm` 0 still alerts on that frame (0 s is a legal setting: there is nothing to confirm) |
| A pending bed exit or entry | The 6 s of quiet restarts at the first frame after the gap. It is **not cancelled** (a real exit whose outside motion ended during the outage must still be recorded) and the quiet seen **before** the gap is **not** carried over |
| A pending exit or entry that sees *activity* on the first frame after the gap | Cancelled, as before: activity needs no continuity |
| Opening a bed exit/entry candidate, and how far back the bed/outside links reach | Unchanged: a gap does not stop a candidate opening, nor shorten the 8 s / 60 s links (see limits) |
| The alert cooldown | Unchanged: real time, not video |
| `activity_samples` counts and peaks | Unchanged |
| A stored `out_of_bed` / `into_bed` row | Its time is the moment it was **confirmed**, so after a gap it is later than before. Its `peak`, `out_peak` and `out_frames` can differ, because a restarted wait collects more evidence. The sleep numbers do not read those three fields. A candidate never confirms earlier than it would have before this change, but that holds **per candidate**, not per stored row: a delayed confirmation can escape the wall-clock cooldown that would have suppressed the next one, so a second stored exit can land earlier than before (2 of 12,000 simulated gappy comparisons; the new rule never confirmed more transitions than the old one) |

**What counts as a gap:** the time between two consecutive frames' arrival is longer than the larger of 1.5 s
(the same grace that already says a motion run has not ended) and 5 times the camera's typical frame interval.
The typical interval is read from the camera's last 16 intervals longer than 50 ms (frames delivered together
are one arrival and are not intervals), **but only once at least 9 of them are held**: until then the 1.5 s floor
alone counts, and from then on it is the 9th longest of the held intervals (with all 16 held, their median).
So fewer than 9 long intervals can never widen the bound. That is deliberate: right after a start-up one stall
would otherwise be the whole window, and widen the bound for the very next frame (found in code review: frames
at 0 s, 20 s and 50 s let a single quiet frame after a 30 s outage confirm a bed exit, and a motion run active
at 0.2 s, 2.2 s and 9.2 s alerted). At 5 frames a second the bound is the 1.5 s floor. A camera slower than
about 0.67 frames a second delivers its frames in bursts further apart than that, so the bound widens with it
(10 s at 0.5 frames a second) instead of treating every burst as a gap and never confirming anything.
**The cost of a cold slow camera:** until 9 of its slow intervals are held every burst is a gap. After each
detector (re)launch, a **cold** camera that delivers every 2 s (or in clumps with one receipt time per 2 s)
therefore restarts a pending bed exit or entry about 9 times: a candidate pending in the first ~18 s after the
launch confirms at about **launch + 24 s** whatever its own open time (opening at 4 s: 20 s later, 7 restarts;
at 6 s: 18 s, 6; at 10 s: 14 s, 4; at 16 s: 8 s, 1; at 20 s or later: the usual 6 s, none). The motion alert
pays the same: with sustained motion the first alert comes at about launch + 24 s with 9 `motion run restarted`
lines, up to ~18 s later than before this change (a **warm** camera, one whose window already holds 9 slow
intervals, alerts at 6 s exactly as before; intermittent motion that did not alert before still does not).
Once the window has learned the camera it behaves as before. These figures are from simulations with realistic
clumps, reasoned and not measured on a real camera. A camera that slows down mid-stream is treated as gappy
for about 9 of its slow intervals in the same way, until the window has caught up.

**The mirror image, after a slow phase:** the window needs 9 of its last 16 intervals to be long, so after a
slow phase (9 or more recorded long intervals of S) the bound stays at about 5 x S until 8 fast frames have
arrived once the camera speeds up (about 1.6 s at 5 frames a second). A stall of up to 5 x S arriving inside that
window is **not** seen as a gap, and a quiet frame after it can confirm (verified: 13 intervals of 5 s, 3 fast
frames, then a 20 s stall passes unseen; after 8 fast frames it is a gap; pinned by a test so a change is deliberate). Shortening this would re-open the
starvation of a slow camera, so it is left as an owner design call; reasoned, not measured. It applies equally to
the motion alert, which uses the same helper.

**Limits, stated rather than hidden:**
- **The numbers were chosen, not measured.** 1.5 s, the factor 5, the 16-interval window and the 50 ms minimum
  are reasoned, not fitted: no record of the real distribution of arrival gaps existed when they were set (the
  `[obs]` line measures the camera's timestamps, not when frames reach Nightlight). For another install they are a
  hypothesis. The only evidence is one house's saved staging logs: 428 of about 455 motion periods had no gap over
  0.5 s, and the bad ones had 7 to 49 gaps per 15 minutes averaging 0.6 to 2.1 s (two mornings, one camera, the
  wake window), so the rule **will fire in production exactly when exits are pending**.
- **It makes confirmation slower on a gappy camera. On a badly gappy one a pending exit or entry can fail to
  confirm for a long time.** Gaps that recur more often than once per about 6 s of received video mean the
  pending candidate rarely gets its full 6 s of quiet, and **no cap on restarts exists** (a design decision,
  filed as a follow-up issue). If gaps of 2 to 3 s arrive at random (a Poisson process) at a rate of L per second
  of received video, the expected wait is (e^(6L) − 1) / L **seconds of received video**: about 7 s at 3.3 gaps
  a minute (the evidence above), about 38 s at 30 gaps a minute and about 400 s at 60 gaps a minute. In wall
  time, which also contains the gaps, a simulation gives about 8 s, roughly 75-90 s and roughly 1100-1400 s (the
  60-a-minute figure only makes sense per minute of received video). A 30 s *Motion confirm* (the setting's
  maximum) waits about 76 s of received video on a camera with 3.3 gaps a minute. A stored exit or entry after a
  gap is stamped later.
- **A cold slow camera is slower to alert, and to confirm an exit or entry, after each (re)launch.** On a camera
  delivering every 2 s (or in clumps with one receipt time per 2 s) with *sustained* motion, the first alert
  came about 6 s after the launch before this change and now comes at about 24 s, after 9 `motion run
  restarted` lines (verified by running old and new code in review round 2). A camera whose window has already
  learned its cadence behaves exactly as before (6 s), and intermittent motion that did not alert before still
  does not alert. See "The cost of a cold slow camera" above. This is a regression for that case, accepted
  because the alternative (a bound that widens after the first slow interval) lets one stall confirm anything.
- **A stall that ffmpeg fills with repeats as it happens is not caught.** The rule looks at when frames
  arrive. When the camera stalls, ffmpeg normally holds back and then releases a clump of repeats at once (a gap,
  caught); a stall filled continuously keeps frames arriving and passes. Gating confirmations on the `[obs]`
  proven repeats would catch it, but its verdicts land about 5 s after a frame, inside the 6 s window, and the
  clock is documented as possibly absent: a separate follow-up.
- **Opening a candidate across a gap is kept on purpose.** A real exit during an outage is the case worth
  keeping, and the issue's criteria are about confirmation. It is **not** conservative: a change that built up
  during the stall can open an exit candidate, which 6 s of received quiet then confirms.
- **A clump after a stall drains quickly only because the detector watchdog caps a stall at about 75 s** (60 s
  of silence plus a 15 s check, roughly 375 repeats; see "A detector was restarted" below, issue #369).
- **Sound alerts are not covered.** The sound analyser already drops its window on a gap longer than its own
  confirm window (4 s at the default), so a shorter hole can still be bridged. Unchanged.
- **Returning to the Low stream (see "Motion detection reads the Low stream" below) can still lose a pending exit** on a main stream
  that keeps stalling: its quiet period assumes an exit confirms 6 s after it opens, which a restart now
  lengthens. Suspected, not measured; refusing the switch while a candidate is pending is a follow-up.
- **The wake watcher (#448) had the same "active, outage, active" shape; it is fixed separately.** See "A wake
  recording does not bridge a gap in the readings" below.
- A backward clock step of S seconds still suppresses a bed exit or entry (their 2-minute pause) and an ONVIF
  or MQTT motion alert for up to S plus the cooldown (pre-existing, filed separately, #582). The **frame-diff**
  motion alert is different since #454: after a one-way backward step its cooldown is clamped to the new time,
  so it is silent for at most one cooldown, not S plus the cooldown. It has its own limit ("What a restart
  keeps", below).

**What to do:** nothing. To see how often it fires, count the `restarted` lines per night.

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
| Where a wake clip starts | 3 s before the wake's first moving or noisy frame, or at the oldest footage the buffer still holds if that is later (#412; between #447 and #412 it was 3 s before the END of the first active minute, up to 57 s after the first frame) | 3 s before the old row label: a restart-dependent point inside that minute |
| Thresholds, peaks, what counts as active | Unchanged | |

**Where a wake clip starts, and why it can start late (#447, resolved by #412).** The recording ring a clip is
cut from is only as deep as the clip settings make it: 63 seconds with on-demand Record on, 38 with it off,
23 at the smallest clip settings (clip pre-roll and post-roll, and on-demand pre-roll, size it). #447 anchored
the clip at the END of the wake's first active minute so the ring still held the hold point, which made every
clip start up to 57 seconds (about 27 on average) after the first moving or noisy frame. #412 anchors the clip
at that first frame instead (the first frame over the same motion or sound threshold that makes a minute
active; the clip opens 3 s before it) and clamps the anchor to the oldest footage the buffer actually holds,
read from its files, because a clip that opens before the buffer's oldest footage has nothing to cut and
fails. So the clip starts at the first moving or noisy frame (3 s before it), or at the oldest footage the
buffer still holds if that is later.

- **How late, by buffer depth.** A continuous buffer of about 70 seconds or more reaches the first frame. With
  less, the clip starts up to roughly a minute minus the buffer depth after it: about 22 seconds after the first
  frame with a 38 second buffer, about 37 with a 23 second one (the same figure the log line below prints, on the
  day). As an example, a 63 second buffer (on-demand Record on) is nearly exact. If the buffer has a gap so
  that NO footage at all falls in the clip's window (the motion check can read a different stream from the one
  that is buffered), the clip falls back to the old start, the end of the first active minute; footage that
  resumes later inside the window keeps the early start, and the cut then begins where the footage does.
  Changing the wake clips' "Clip length" setting while a wake is still being detected can, on such a buffer, leave the early start
  with an empty window and fail that one clip. These are
  derived, not measured, and approximate to about 4 seconds (a 2 second segment plus the 2 second tick that
  prunes the buffer). When the buffer cost the opening, the log says so once per wake: `[wake] "<camera>" the
  buffer reaches back only to N s after the first movement: the clip starts there`. A deeper buffer for wake
  clips is not built; this line is how to tell whether anyone needs one.
- **The clip's start time can precede the wake's minute.** A clip's recorded start is its planned first frame,
  3 s before the first active frame (with an almost empty buffer, whose oldest footage is less than 3 s
  before the end of the minute, the cut begins at that footage and the recorded start is up to 3 s earlier
  than it), so for a movement in the first seconds of a minute it can be a few
  seconds before the wake's minute on the timeline. The review page still pairs the clip with its wake (it
  matches within 3 minutes).
- **Measured once, on a synthetic stream only.** How a frame's arrival time at the detector lines up with the
  footage in the buffer was measured on a scripted 15 fps test stream with a 2 second keyframe interval (a
  white box flickering from a known instant, three wakes started at different seconds of the minute, real
  ffmpeg, the real app): the first flickering frame was 1.7, 1.9 and 2.1 seconds into the clip, against the 3
  seconds intended, so about 1 to 1.3 seconds of the 3 second lead-in is lost and the clip still opens before
  the first frame. The 3 second lead was kept. A real camera's encoder and network delay differ and were not
  measured. **Unverified:** that a camera with a keyframe interval over 2 seconds starts its buffer segments no
  later than 2 seconds apart.
- **A payload without the first-frame information** (nothing sends one today) keeps the old anchor, the end
  of the minute; its buffer hold now reaches back 7 seconds before it instead of 15, the same margin the cut
  itself reads.
- **Not covered by this change:** a settings save or camera edit restarts the buffer and drops the hold, which
  can still fail a wake clip that is being cut (#413, #490).

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
| Live wake watcher (wake clips), since issue #588 | Read normally | A minute it did not see: no progress toward starting to watch, not activity even when loud, and bridged inside a wake like any minute without activity (at most 3 in a row). Only on a camera that has delivered video since the server started; a camera with no video at all keeps its sound (next section, and the limits below) |

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
- **Applied to the live wake watcher since issue #588, not yet to the bed-transition rules.** The live
  watcher that records wake clips now treats a minute with sound but no video, on a camera that had delivered
  video, as a minute it did not see (next section). The bed in/out rules still read the movement peak alone, so
  during a stall they can still read the bed as still: a follow-up issue. The live watcher decides each minute
  when it ends, from the frames the motion detector *received*, so it differs from this rule in two shapes. A
  minute whose every frame is later proven a repeat (stored with 0 frames, so unwatched here) still counts as
  watched live: measured on 2026-10-05 over every stored minute of two cameras in one house, there is no such
  minute (0 of 87,271 rows on the production database, 0 of 86,227 on the staging one), so that shape is left to
  this nightly rule and is not handled live. And a camera that has delivered no video since the server started
  (for example one with no video feed at all) keeps its sound in the live watcher, while this rule counts its
  minutes as unwatched.
- **A parent's corrected night** subtracts the night's stored unknown minutes from the corrected span as
  one total (an existing limit of corrections). A recompute that adds many unknown minutes to a corrected
  night can therefore shrink its displayed sleep more than the stall alone explains. Since a corrected
  night's saved summary is locked (README, "A night you have corrected is locked"), that no longer happens
  to the child's card after the correction is saved; the figure stops changing but is not made exact. The
  sleep detail page works the night out fresh each time, so it can still show it.

**What to do:** nothing. If a night shows a long "No data" stretch while the camera was plainly on, check
the Camera history for a `[detector-watchdog]` restart (next section) around that time.

## A wake recording does not bridge a gap in the readings, and settling needs 15 unbroken minutes

**What you see:** wake clips (README, "Wake clips") are recorded by the live wake watcher, which only
records and never alerts. Three things about when it decides:

- **Two qualifying bursts of activity (each at least 5 active minutes once short gaps are bridged) with a
  hole in the camera's readings longer than 3 minutes between them are two wakes, and two clips.** Two single
  active minutes with a hole between them are no wake at all. A "hole" is a minute the watcher did not see:
  one for which the camera reported nothing at all (the video or sound feed was down; no motion frame and no
  sound window arrived), or, since issue #588, one with sound but no video on a camera that had delivered video
  since the server started (its video stalled while its microphone kept working).
  Before issue #448 the watcher counted readings, not minutes, so five active minutes spread over about forty
  minutes of mostly missing readings could be recorded as one wake,
  while the sleep timeline (which has always counted minutes) showed no wake at all.
- **The watcher starts watching only after 15 consecutive quiet minutes that were actually read.** A hole
  restarts that count. So after an outage in the evening the watcher can start watching later than the
  sleep timeline's bedtime, and a wake in between has no clip.
- **A video stall is a hole even while the sound keeps arriving (issue #588).** Before #588 the watcher read
  such a minute as watched: a quiet one counted toward the 15 minutes, so the watcher could start watching a
  child nobody could see, and a loud one counted as activity, so a noise during a stall could complete a wake
  that the sleep timeline (which has called these minutes unknown since issue #508) does not show. Now such a
  minute is no progress toward starting to watch, is not activity even when loud, and inside a wake is a gap
  like any other: up to 3 in a row are bridged, and a run in progress ends at the 4th minute without activity,
  the same minute 4 quiet minutes would end it (not later, when the video comes back).

**The rule, in one place:** a run of active minutes bridges at most `WAKE_GAP_MIN` = **3** minutes with no
active reading, whether those minutes were read as quiet or not read at all, and is a wake once it holds
`WAKE_ACTIVE_MIN` = **5** active minutes. A gap of 4 or more minutes ends the run; the next active minute
starts a new one. This is the sleep timeline's own rule (`markWakeRuns`), read from the same constants, so the
clips and the timeline agree on where a wake is. An armed watcher is **not** disarmed by a hole: only the
progress toward arming restarts, so a wake that follows a camera reconnect is still recorded.

**Differs from the neighbouring rule** — the part that is easy to get wrong:

| | Sleep timeline (nightly job) | Live wake watcher |
|---|---|---|
| A minute with no reading in a wake | Not active; bridged up to 3 in a row | The same |
| A minute with sound but no video (a video stall) | Unknown: not active, its sound not used even when loud; bridged up to 3 in a row | The same since issue #588 (a hole; before #588 it was read as watched). Only on a camera that has delivered video since the server started |
| Deciding the child has settled | 15-minute window with no active minute and at least 8 minutes actually read quiet | **15 consecutive minutes read quiet**; one missing minute, or one minute of a video stall, starts the count again |
| Settled, then a hole | n/a | Stays watching |

The live rule is stricter on purpose: its only job is to keep bedtime settling out of the recorder, so the
safe mistake is to start late (a missed clip, never an alert). The cost, stated: **a camera that drops a
minute more often than about every 15 minutes never starts watching and records no wake clips.** Any hole
restarts the count, even a single missing minute. On the saved 30 days of the two cameras of one house there
were roughly 20-25 holes per camera per month on one database and 45-50 on the other, most of them single
missing minutes. What shows a night is rarely delayed is replaying those 30 days with the old and the new
rule: the start of watching differed on exactly one night in four camera-months (8 minutes later). The rate
on another install is unknown. The nightly job uses the looser rule because requiring a fully read window made
flaky cameras lose whole nights (issue #442).

**The numbers were tuned on two cameras in one house and not validated anywhere else.** 3, 5 and 15 are the
nightly job's own constants (`sleepAnalysis.js`), shared by reference with the live watcher, so a retune of
one moves both. They are constants, not settings, so there is no default to change or range to set.

**Known limits:**

- **A video stall is recognised only on a camera that has delivered video since the server started**
  (issue #588). The watcher learns that a camera has video from its first frame, and nothing in the settings
  says a camera is audio-only. So a camera already stalled when the server starts is read like a camera with
  no video at all (its sound counts, quiet minutes help it start watching) until its first frame arrives; and a
  camera whose motion detector is stopped on purpose while its sound detector keeps running reads as stalled
  for as long as that lasts. Inside a tracked child's sleep window the motion detector runs for the whole
  window, so that takes a settings change in the middle of the night. A narrower case of the same limit: if the
  server's clock steps back to before the camera's first frame since the server started, the minutes it re-lives
  before that time are not recognised as a stall while the camera stays stalled (once any frame arrives after the
  step, the minutes after it are). That can only happen within about the depth of the step after the server
  starts: a step back of one hour, say, in the server's first hour.
- **How often a stall with live sound happened, before #588 changed it**: over every stored minute of the two
  cameras of one house (measured 2026-10-05; about 30 days, inside the sleep window or not), minutes with sound
  but no video on a camera that had had video before: 263 in the production database, all on one camera (97 of
  them louder than 6 dB over ambient, the threshold that makes a minute active, on 2 calendar days in UTC), and
  807 in the staging one (806 on one camera, 251 of them loud, on 2 days, and 1 on the other). The watcher read
  each as watched: a quiet one counted toward the 15 minutes, a loud one as activity. That count reads the stored
  rows, not what the watcher saw live, though both decide from the same input: a stored minute has no movement
  reading exactly when no frame at all arrived in it, which is what the watcher checks. They can differ in two
  ways. "Had video before" in the count looks back over all stored days, while the watcher forgets at every
  server restart, so a stall that was already going on when the server restarted (a deploy, for example) is in
  the count but not flagged live until the camera's first frame. And a minute of nothing but repeated frames is
  unwatched in the stored rows but watched live (next point; none measured). Unknown on any other install.
- **A minute made only of repeated frames still counts as watched live.** When a camera stalls, ffmpeg fills
  the gap by repeating the last real frame, and the sleep timeline leaves out frames that are later proven to be
  repeats (a minute of nothing but repeats is unwatched there). The live watcher decides when the minute ends,
  before those proofs arrive, and counts every frame it received, so such a minute is watched for it, and so is
  a minute whose video returned only in its last seconds (the sleep timeline agrees on that one). Measured
  2026-10-05 over every stored minute of the two cameras: no minute of nothing but repeats (0 of 87,271 rows and
  0 of 86,227). Unknown elsewhere; the sleep timeline is unaffected either way.
- **A frozen picture is still watched.** A camera whose encoder wedges keeps sending real, identical frames, so
  neither the watcher nor the sleep timeline can tell it from a still room (the same limit as in "Minutes with
  no video are unknown in the sleep numbers").
- **A child crying through a video stall is not recorded as a wake**, the same as on the sleep timeline: a
  bedroom microphone hears the whole house, so a noise nobody saw is not taken as the child. Sound **alerts** are
  a separate path and still fire.
- **The bed in/out rules are not changed by #588** and still read a stalled minute's movement as before (a
  separate follow-up).
- **A backward clock step of more than about 2 minutes ends the run in progress.** Smaller steps (every
  ordinary clock correction) are absorbed before they reach the watcher and change nothing. A watcher still
  settling also restarts its count; one that is already armed stays armed. The sleep timeline merges the
  repeated minutes; the watcher does not, so it can lose at most the one run (and a clip) that a step of the
  server's clock interrupted. Since issue #588 the step also ends the run when the first minute that shows it is
  a minute with sound but no video (a stall), with the same log line (`run ended (the clock went back)`); the
  settling count is restarted by the next minute that was actually read, as before.
- **A clock step can release the ring hold of a clip still being cut.** The run ended by an older label, or
  replaced by an active label that jumps far forward, gives up its ring hold even if its clip is still being
  extracted. It needs a step of more than about 2 minutes within about a minute of a wake's 5th active
  minute; a per-capture hold is the separate issue #471.
- **An armed watcher whose camera sends nothing between two nights stays armed.** It is reset by the first
  reading outside the sleep window, so the next evening's settling can be recorded as a wake if the camera
  was silent for the whole day.
- **The 20-minute sweep is only a backstop.** A camera that goes silent in the middle of a run keeps its ring
  hold until the sweep ends the run, up to about 20 minutes after its last active minute. A run that keeps
  receiving readings is ended by the rule above, not by the sweep. Since issue #588 that includes a camera whose
  video stalled while its sound kept arriving: each such minute still applies the rule, so the run and its ring
  hold end at the 4th minute without activity, exactly when 4 quiet minutes would have ended them, not when the
  video returns or the sweep runs; and if the server's clock steps back during the stall, at the first such
  minute that shows the step (the sweep could not: after a backward step the run's last active minute lies in
  the future of the clock).

**What to do:** nothing. In the log, `[wake] "<camera>" settled — watching for wakes` marks the start of
watching. No such line all night means either that the camera never had 15 unbroken minutes, or that the
watcher was still armed from the previous night (it settles only once, so it logs nothing the second time).
To narrow it down, look for the line a hole writes while the watcher is still settling:
`[wake] "<camera>" settling restarted: readings N min apart after M quiet minute(s)`. N is the distance in minutes
between the two OBSERVED readings around the hole (a minute with sound but no video is not an observed reading, so
the minutes of a video stall are part of N) and M is how many quiet minutes it threw away (a forward jump of the
server's clock looks the same as a dropout, so the line says "readings apart", not "outage"). It is written only when
the hole cost real progress and the minute after it was quiet: a hole followed by an active minute, and a
backward clock step with progress, also send the count back to zero, but silently (a hole before any quiet
minute has nothing to lose). It never changes when the watcher starts watching; it only reports. **It differs
from the `settled` line, which is written once when the watcher starts watching: this one can repeat while
settling is failing**, at most once per camera per 15 minutes of the camera's own minute labels, so a forward
jump or a backward step of the server's clock can put two lines closer together in real time (a backward step
lets one more through, unless its label equals the last line's exactly, which is held back). Restarts held
back by that limit are counted onto the next line (`; K more since the last such line, the longest after M
quiet minute(s)`), but a count still pending when the camera starts watching, or when its sleep window closes, is
never printed. How to read a night: restart lines repeating about every 15 minutes with no `settled` line
after them mean holes keep sending that camera's count back to zero. Read the M values, not only whether lines
appear: M close to 15 means one missing minute each time was all that stood between the camera and watching
(the strict rule is what is in the way), while small M values say little on their own, because a restless
child with active minutes in between would not have settled with every hole filled either. No restart line
and no `settled` line means the child never had 15 quiet minutes, the watcher was still armed from the night
before, or only the silent cases above applied. A
run dropped at a gap logs `run ended (readings N min apart)` when that run had taken a ring hold (N is the
distance between the two readings, which is also what a forward jump of the server's clock looks like); a run
ended by a video stall logs `run ended (video not observed; readings N min apart)` instead (since issue #588; N is
the distance in minutes between the last observed reading and the stalled minute that ended the run; it says what
is known and no more, because a forward jump of the server's clock looks the same as a stall that long); a run
that already captured a clip logs nothing when it ends, and neither does a run that never took a ring hold.

## A muted or digitally silent microphone is recorded as a quiet room

**What you see:** for a camera whose microphone delivers *digital silence* (every audio sample exactly zero),
the per-minute sound history (`activity_samples`) shows those minutes as quiet, 0 dB over ambient, instead of
having no sound at all, and the `[sound]` level line keeps printing every 15 seconds with `peak=?dB` (and
`ambient=?dB` until the camera has learned the room's level from real sound: see the first limit below).
Silence on its own never sets off a sound alert.

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
| Alerts | Never on its own (it counts as quiet in the alert's average over the **Sound confirm** time: 4 s by default, 0–30 s) | When a noise rises past the margin | Never |
| Changes the room's ambient level | **No**: silence never lowers it and never teaches it a level (one bounded exception: a long loud sound that ends just before the 45-second rule can still be absorbed a moment into the silence, below) | Yes, continuously | No |
| A quick reconnect ("does this camera have a microphone?") | Not counted | Not counted | Counted; three in a row stop sound detection |
| Sleep numbers | Quiet, like a quiet room | Quiet unless a noise passes 6 dB over ambient | Decided by the video alone |

In every column a minute with no video is unknown in the sleep numbers, whatever its sound (previous
section).

**Limits, stated rather than hidden:**
- **Silence cannot teach the app the room's ambient level, and can stop it learning one.** The level is
  learned from 25 windows (about 5 seconds) of real sound, taken as their median. A detector that has only
  ever heard silence has nothing to measure against, so its first 25 real windows become the ambient level:
  if that first sound is a sustained cry (a microphone un-muted into a crying room), the cry *is* the
  ambient and that first cry is not alerted. And while no level has been learned, a silence longer than the
  **Sound confirm** time (4 s by default; 0.6 s at the shortest setting) is treated like a break in the
  stream and starts the learning over, so real sound that only ever comes in bursts shorter than ~5 seconds,
  with longer silences between, may never teach it a level at all: measured in a replay, a cold start
  followed by 9 minutes of 4-second bursts at -30 dBFS with 5 seconds of silence between learned nothing and
  sent no alert. Until a level exists, the loud windows are not stored (there is nothing to measure them
  against) and the silent ones are stored as 0, so those minutes read as quiet ("heard, nothing above
  ambient") although they held loud sound. No sleep number or alert moves because of it (a minute counts as
  noisy only above 6 dB over ambient), and the same stream never taught a level before this change either
  (its silences were breaks in the stream then too); what is new is that its silent windows are stored.
  Storing 0 for silence before any level exists, rather than nothing, is the current design. Fixing the
  learning would mean guessing a floor level, which was rejected: a guessed floor makes every ordinary
  household noise after a silent spell read as loud.
- **Silence never lowers the ambient level.** A silent window counts as a moment exactly at the ambient, so
  the ordinary ~20-second tracking moves the level by exactly nothing on it; only real, quieter sound lowers
  it. Sounds heard between stretches of silence can therefore only raise it: each sound under half the
  margin closes about 1% of the gap to its own level, as any reading does, and nothing pulls it back down in
  between. Measured in a replay: a sound 8 dB over the ambient every 2 seconds, with silence between, for 10
  minutes, moved the ambient from -60 to -52.4 dBFS.
- **A long loud sound can still be absorbed just after it stops.** A sound that stays over the alert margin
  for 45 seconds is folded into the ambient level (the 45-second rule, docs/notifications.md). For a moment
  after a loud sound stops, the alert's average over the Sound confirm time still holds it, so if the sound
  had been over the margin for almost 45 seconds when the silence began, the 45 seconds complete during the
  silence and the sound is absorbed then, raising the ambient to its level: a later cry no louder than it is
  not alerted. Measured in a replay: a sound 30 dB over the ambient for 46 seconds, then silence, was
  absorbed 0.6 seconds into the silence, and a cry 20 dB over the old ambient 10 seconds later sent no
  alert; before this change it did (the silence was a break in the stream, which dropped the loud run). Only
  a sound whose time over the margin ended within about 2 seconds of the 45 is affected (a sound 30 dB over;
  under half a second for one 15 dB over).
- **A sound in the "5 minutes" band can be kept from ever being learned.** A steady sound between half and
  all of the margin is learned after 5 minutes. If silent windows interrupt it and every one of them is
  followed at once by a louder window, each silence that pulls the average under half the margin restarts the
  5 minutes (exactly as a moment at the ambient would), so the sound may never be learned and keeps being
  measured against the old level; before this change the silence was invisible and the sound was learned.
  Seen only in a constructed replay (8.6 minutes, never learned): it needs that exact pattern, every time,
  for 5 minutes.
- **While no ambient level has been learned yet** (normally about the first 5 seconds after a start; see the
  first point), an audible window records nothing, but a silent one records 0.
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

**A row and a `[WARN]` line are written only for what actually happened.** The watchdog asks for the
detector to be stopped, and the request can be refused: the detector is already being stopped, is on its way
back from the main stream to the Low one (#500), or had nothing to signal. Then the history shows **no
restart**, and the log has one line at `[INFO]` instead of `[WARN]`:

```
[INFO] [detector-watchdog] "Nursery Cam" motion on cam_…-sub: no data for 75s; path ready, 2 reader(s), tracks H264+Opus; probe: video packets arriving (packets, not frames); input tap: last record 74s ago; attempt 1; lever refused: the detector was already being stopped, returning to the sub stream, or nothing could be signalled
```

It has the same diagnosis as the `[WARN]` one. The log does not say which of the reasons applied. If the
stream restart was requested in the same step, the row says only that (*sub-stream (Low) restart requested*,
never *detector restarted*) and the one `[WARN]` line ends `lever: sub publisher; detector kill refused`.
Before issue #578 a refused kill was recorded as a restart anyway. If the detector's stop request raised an
error (a bug, not a refusal), the `[INFO]` line says `lever threw` instead (in the mixed case above, the
`[WARN]` line ends `detector kill threw`), and the error is reported separately under
`[guard:detector-watchdog:…]` as before.

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
| Backoff | 1 min doubling, capped at 30 min | Between two attempts on the same detector. An attempt whose stop request was refused counts too (limits, below), so not every attempt has a Camera history row. |
| Recovered after | 5 min | Unbroken health that forgets the attempt count. |
| Crash-loop escalation | 3 min | Stream restart asked for when two or more relaunched detectors in a row delivered nothing, with no healthy moment since the last action (the relaunch keeps dying before anyone can judge it). |
| Request expiry | 60 s | A stream-restart request not acted on by then is dropped. |
| Worst case to recover | ~90-105 s | From the last frame to fresh frames, for a stuck detector on the Low stream. Up to ~150 s if it was on the main stream, because a relaunched motion detector waits up to 45 s for the Low stream first. A stuck restream takes ~5-6 minutes (detector first, then the stream). |

**Differs from the neighbouring watchdogs**, which are easy to confuse with it in Camera history: the
**camera watchdog** restarts a stream MediaMTX reports as *not ready* for 30 s; the **audio watchdog**
restarts a camera whose *main stream's audio* stopped for two checks; the **detector watchdog** restarts a
*detector* that stopped receiving while its stream looks fine. Only the detector watchdog's rows say
"detector".

**What a restart resets:** on motion, a motion run that was building up to an alert, and a pending bed-exit
or bed-entry candidate (with the 2-minute pause after a logged exit or entry, so a restart can record a second
exit or entry within 2 minutes of one just logged: a duplicate, not a lost one). The motion detector's belief
about whether the child is in bed, the sound detector's learned ambient level and cooldown, and the motion
alert cooldown (below) are kept. A restarted motion detector also returns to the Low stream if it had fallen
back to the main one after a blip; since #500 a detector on the main stream goes back by itself when the Low
stream is up and the room is quiet (the next section), so this no longer depends on a restart.

**What a restart keeps: the motion alert cooldown (issue #454).** Before #454 every relaunch of the motion
detector started its alert cooldown from zero, so sustained motion could alert again sooner than **Motion
cooldown** after the previous alert. Now the time of the last motion alert is kept per camera, and a motion
alert cannot fire sooner than **Motion cooldown** after it, whatever happened to the detector in between:
- **Kept through:** a camera reconnect or "stream ended", a transport restart, the detector watchdog's kill,
  the return to the Low stream (next section), and the detector being started again by a detection-settings
  save, any camera edit (a rename too), assigning or unassigning the camera, or switching it off and on.
- **Lost when the server (the container) restarts.** Nothing is stored. For a container that restarts every
  night the cost is at most one extra motion alert per camera per restart, and only if motion is sustained
  within **Motion cooldown** of the last alert before it.
- **Which causes mattered at which cooldown.** An ffmpeg exit (a reconnect, "stream ended") and the detector being
  started again (a settings save, a camera edit, assigning, an enable/disable) re-armed the cooldown at **any**
  setting, the default 60 s included. The detector watchdog waits for 60 s of silence before it restarts
  anything, and the return to the Low stream waits for 90 s of quiet, so those two only mattered with a longer
  cooldown (above about 70 s and 95 s). Across 30 days of one house's saved data
  no motion alert pair was closer than the cooldown and no relaunch fell within 60 s after an alert: this is a
  correctness fix, and no stored alert, sleep number or detection event changes because of it.
- **Changing the setting:** the last alert's time is compared with the *current* **Motion cooldown**, so
  lowering it applies from the next frame and raising it extends the wait. **To test motion alerts right after
  changing motion settings, wait out the cooldown (60 s by default) or set a short one**: a settings save no
  longer re-arms an alert (it did, before).
- **An alert that was silenced** (outside the alert schedule, or by snoozing the camera) does not start a
  cooldown, so one can fire as soon as the schedule opens or the snooze ends (unchanged).
- **A backward step of the server's clock** (a time-sync correction) silences the frame-diff alert for at most
  one cooldown, counted from the first video frame analysed after the step (at 5 frames a second that is
  immediate; if frames stop for ten minutes after the step it starts at the next frame). The ONVIF and MQTT
  motion alerts and the bed-exit rules still wait the step plus a cooldown (see the gap section above, #582).
  **Known limit:** this is only for a ONE-WAY step. If the clock steps back and is later corrected *forward*,
  the stored time stays at the stepped-back value and the first motion after the correction can alert once
  inside the cooldown; a clock that jumps by hours between consecutive frames can alert repeatedly. Real
  time-sync corrections do not behave like that, so it was left. A monotonic companion time would fix it; not
  done (#582).
- **The sound cooldown is not the same.** It already survived an ffmpeg relaunch (it lives in the sound
  analyser), and still starts again when the sound detector is started afresh by a settings save, a camera edit
  or an enable/disable; the motion cooldown now survives those too. The **ONVIF** and **MQTT** motion sources
  keep their own cooldowns, unchanged.
- **Deleting a camera forgets its cooldown.** A frame still arriving from the stopped detector in that instant
  can store one stray time for the deleted camera (a number, nothing else); not guarded.

**Limits, stated rather than hidden:**
- **A refused stop request still counts as an attempt (issue #578).** The attempt and its backoff are counted
  before the request is made, so that a request that errors or hangs can never cause a retry without backoff.
  A refusal is counted the same way, which has three consequences. (1) Every refusal in a row doubles the
  backoff (1, 2, 4 ... 30 minutes), so a detector that cannot be signalled (one stuck "being stopped" or
  "returning") can delay the first real restart by up to 30 minutes. (2) On a motion detector the second
  attempt also asks for the stream restart, **even though no detector restart happened**, so a refusal can
  bring that request one step earlier than a real restart would; on a camera whose detector reads the main
  stream that restarts the transcoder and briefly interrupts live view, and it repeats at the later backoff
  steps. (3) A **sound** detector's refused attempt writes no Camera history row at all (before #578 it wrote
  a false one), so a sound detector that is repeatedly refused leaves only the `[INFO]` lines. A refusal that
  should not feed the backoff would need a different retry rule; not done, filed as #585.
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
`[detector-watchdog]` lines when reporting it (both `[WARN]` and `[INFO]` ones: a camera with `lever refused`
lines and no rows is being refused, not left alone, and Camera history will not show it): the `path`, `probe` and `input tap` fields say where the
stream stopped (the detector's side, or the stream it reads), which nothing could tell before.

---

## Motion detection reads the Low stream, and goes back to it after an outage (`reading the MAIN stream` in the log)

**What you see:** two lines in the log, minutes apart, after a camera has been off for a while (its scheduled
reboot, a Wi-Fi drop, a server restart):

```
[WARN] [detect:cam_…] "Nursery Cam": sub stream cam_…-sub not ready, reading the MAIN stream (more CPU; the motion thresholds were calibrated on the sub); will return to the sub once it is ready
[INFO] [detect:cam_…] "Nursery Cam": sub stream cam_…-sub ready again (3 checks, quiet 95s), returning the motion detector from main to sub (a relaunch: ~5s gap; the bed-transition state resets, the alert cooldown carries over)
```

**Which stream motion detection reads:** the camera's **Low (sub) stream** when it has one and it is up,
because it is far cheaper to decode and it is the stream every motion threshold in Nightlight was measured
on. A camera with no Low stream always reads the main stream, and none of this applies to it. The **sound**
detector always reads the main stream (that is where the audio is).

**What happens when the Low stream is not up:** a motion detector that (re)starts waits up to 45 seconds for
the Low stream, then settles for the main one. The streams of a camera that was off for longer than that come
back within about a second of each other, and the main one is usually first, so this is a race that happens
after any outage longer than 45 seconds, on any install. Before this was fixed (#500) the detector then
stayed on the main stream until its ffmpeg next exited, which could be a day or more, and nothing said so. Main is a different
measurement (a different frame rate, encoder and noise; 15 fps against 10 fps on the cameras the numbers were
calibrated on) and costs more CPU.

**Now:** a detector on the main stream checks the Low stream every 20 seconds, and **switches back when**

| Condition (fixed, not configurable) | Value | Why |
|---|---|---|
| The Low stream was ready on 3 checks in a row | 3 x 20 s | A stream that is up for a moment, or the second it lags the main one after a reboot, must not trigger a relaunch. A check that could not be answered (MediaMTX timed out) counts as not ready. |
| The room has been quiet | 90 s | See the limit below: derived from the bed-exit rules, not typed. |
| At most one switch per | 10 min | A Low stream that keeps dropping must not cost a relaunch every time it comes back. |

The switch is a **normal detector relaunch** (the same one a dropped stream causes): about 5 seconds with no
motion samples, which the sleep numbers show as "No data" for those minutes like any other gap. The bed
transition rules start afresh (a half-seen bed exit or entry is forgotten, and so are "when the bed last
moved" and the 2-minute pause after a logged exit or entry, so an exit or entry that happens within 2
minutes of one logged just before the switch can be recorded where an uninterrupted detector would have
suppressed it). The motion **alert cooldown is kept** (issue #454): a switch does not let a motion alert fire
sooner than the cooldown after the last one, which it did before. The detector's belief about whether the
child is in bed is kept. The relaunch follows the same stop rules as any other: switching detection off, or disabling or
deleting the camera, cancels it.

**Limits, stated rather than hidden:**
- **The room must go quiet first.** The switch waits until neither the bed nor the area outside it has moved
  for 90 seconds (a quiet period longer than the 60 s the exit rules look back for a bed that has just moved,
  plus the 6 s they need to confirm an exit, plus a margin), so a relaunch cannot lose a bed exit. A room
  that never goes quiet (a child playing, a TV in shot) stays on the main stream, as it did before.
- **A half-seen bed exit is not carried over if the camera stops sending frames.** An exit is confirmed by
  the next quiet frame, so a detector that receives nothing for 90 seconds could be switched with one still
  open. A detector that receives nothing is restarted by the detector watchdog (previous section) after 60
  seconds anyway, which discards the same state; this has not been measured on a real stall.
- **The numbers were chosen, not measured.** 20 s, 3 checks and 10 minutes were picked from one house's 64
  second daily camera reboot; for another install they are a hypothesis. None of them is a detection
  threshold, and none changes a number computed on a given stream.
- **Readiness is sampled, not watched.** A Low stream that drops and returns between two checks still counts
  as ready.
- **A switch can land back on the main stream.** If the Low stream drops again in the 5 seconds before the
  relaunch, the detector waits up to 45 s for it again and may settle for the main stream, then tries again
  at least 10 minutes after the last switch. Worst case, a flapping Low stream costs one gap of up to about
  50 seconds per 10 minutes.
- **The 10-minute limit is per start.** Saving the camera's settings, or the 5-minute check finding a
  detector in its relaunch gap, starts the detector afresh and forgets when it last switched.
- **Which stream each minute used is not stored.** The log is the only record; the sleep numbers do not
  say which stream a night's motion came from.

**What to do:** nothing, it is self-healing. If a camera keeps showing the first line and never the second,
its Low stream is not coming back: check the camera's Low-quality stream path in **Cameras → edit**.

---

## Bed exits and entries use one fixed threshold, calibrated in one house (the motion sensitivity slider no longer moves them)

**What you see:** nothing in the log or the screen. The effect is in the sleep numbers: after upgrading to
the version that fixed #368, the number of recorded "out of bed" and "into bed" events on a camera can
change, if its **Motion sensitivity** was not 90.

**Why:** the frame-by-frame motion leg decides "did the bed move" and "did the area outside it move" by
comparing the changed fraction of the picture with a threshold. Until #368 that was the same number the
motion **alert** used, so turning the sensitivity slider (to get more or fewer notifications) also changed
which exits and entries were stored, and a camera that only feeds sleep tracking (MQTT or ONVIF motion, or
motion detection switched off) used a sensitivity whose slider the screen does not even show. Now the alert
keeps the slider and exits and entries use a **fixed 1.19% of the zone** (the value the slider gives at 90).
Sleep analysis reads those rows as the authoritative bedtime and wake evidence, so they must not move when
someone retunes notifications.

**What it changes, stated rather than guessed:**
- **1.19% is calibrated in one house.** Every rule the exits and entries follow (the link windows, the
  6 s confirmations, the 2 minute pause) was calibrated with the threshold at that value (by the setting the
  cameras were on; the setting's history is not stored), on two cameras. The
  saved settings of all the cameras in that house are sensitivity 90, and none of its 4295 stored
  rows has a peak below it, which is consistent with, but does not prove, that they always were. It is not
  derived from your room, and nothing checks it against your camera.
- **Below 90 (the default is 50, 5.15%) the threshold goes down:** movements the old threshold ignored now
  count, which can add exits and entries and can also cancel a pending exit (a movement of 1-5% of the zone,
  such as a child settling, now cancels it, as it does in the calibrated house). The totals can move in
  either direction (a pending exit that used to confirm can now be cancelled, and open an entry instead). **Whether that
  makes your reported sleep better or worse is not known:** nobody has measured an install at the default.
  Even in the calibrated house most of the transitions a person reviewed were judged wrong (sleep analysis
  reduces their effect by grouping them into episodes and checking occupancy), so a different threshold is
  not a step away from a known-good one.
- **Above 90 (up to 100, 0.2%) the threshold goes up**, and transitions can change in either direction
  (for example, a false exit that is recorded holds off a real one for the 2 minute pause).
- **Stored history is not rewritten**, and neither are sleep nights already computed.
- **A noisy room can no longer be quieted for sleep tracking by lowering the sensitivity.** A fan, a
  curtain or infrared noise in the picture used to be tamed that way. Now only the detection zone helps
  (**Cameras → edit → detection zone**), and 1.19% of a small outside area is only a handful of pixels, so
  a zone that leaves little outside the bed gives little protection.
- **The relaunch quiet gate follows both numbers.** The wait before a detector returns to the Low stream
  (previous section) counts movement as the exit rules do, and, on a camera that alerts, also as the alert
  does. At the default sensitivity (50) "quiet" now means under 1.19% in both channels instead of under
  5.15%, so a picture with 1.19-5.15% noise (a fan, a curtain, infrared noise) keeps the detector on the main
  stream for as long as that noise lasts (the return has no forced timeout). A camera with no bed zone that
  alerts keeps only the alert's definition.
- **The alert itself is unchanged:** it fires exactly as before at every sensitivity.

**What to do:** if exits and entries look wrong on a camera, check the detection zone first (draw it over a
real picture and look at what it covers). There is no setting for this threshold. Making it per-room, derived
from the room or exposed, needs real frames to evaluate and is a separate piece of work.

---

## A camera with motion alerts off (or MQTT/ONVIF motion) samples for 3 hours past the sleep window, and no further

**What you see:** nothing on screen. In the sleep numbers, a child whose camera has motion alerts off, or
takes its motion from MQTT or ONVIF, now gets a morning wake found up to 3 hours after the window closes
(before issue #353 its sampling stopped 5 minutes after the window, so the morning departure was never
seen). The server's CPU shows one more low-resolution video decode for 3 hours more each day on that
camera.

**Why:** the motion leg of such a camera runs only to feed sleep tracking, and only while the sleep
window, widened by 3 hours before it and 3 hours after it, is open. That 3 + 3 hours is the sleep
detector's own span (the lookbehind for an early bedtime and the lookahead for a late wake), not a number
chosen for this: the morning departure is searched for, and the night's saved summary is refined, up to
3 hours after the window closes, and nothing past that point can change the night.

**What it changes, stated rather than guessed:**
- **A departure later than 3 hours after the window closes is not seen by any camera.** That is the
  detector's existing limit, not new. Lengthening it is a separate decision that would move numbers on
  every install.
- **The morning review has no *got out / into bed* events past about 3 hours after the window's end for
  such a camera.** The review looks from local noon to noon (plus an hour of lingering-movement evidence
  either side), and the sampling stops before the end of that range. It does not change the night's wake
  time, which is capped at the same 3 hours. A frame-diff camera with motion alerts on samples around the clock and does not
  have this gap.
- **The extra CPU is a relative figure, not measured.** 3 more hours a day (15 hours becomes 18 for a
  19:00-07:00 window) of one ffmpeg reading the low-resolution stream at 5 frames a second. Frame-diff
  cameras with motion alerts on already run all day.
- **The leg starts up to 5 minutes after the 3-hour lead edge** (there is no slack on the start edge; the
  server checks every 5 minutes) and lingers 5 to 10 minutes after the closing edge, so the last minute is
  written.
- **Calibrated in one house.** The 3 hours are the detector's, which were measured on two cameras in one
  house. A child who stays in bed more than 3 hours after the window closes is not measured on any install.
- **The timelapse, wake watcher and wake clips are not widened to 3 hours.** The timelapse records only
  inside the sleep window itself; the live wake watcher (which also decides wake clips) uses the window plus
  5 minutes either side. For a window that opens between 00:00 and 00:04, the wake watcher's 5-minute lead
  does not cover the minutes before midnight; this is harmless (the watcher arms only after sleep has begun)
  and the motion leg itself is covered by its own 3-hour lead.

**What to do:** nothing. There is no setting for this span. The only ways to avoid the extra decode are to
switch the child's sleep tracking off or to unassign the camera from the child. Turning motion alerts on
does not avoid it: only a frame-diff camera with alerts on runs all day (more decoding, not less), and a
camera with MQTT or ONVIF motion stays activity-only with alerts on, so the span stays.

---

## A wake reported too early after a child climbed back into bed (a very still sleeper, or a camera that sees only big movement)

**What you see:** a wake time earlier than the child really got up, at a *got out of bed* that came
within a minute of a *got into bed*. After upgrading to the version that fixed #598, some past nights' wake
times, wake counts and sleep totals also come out differently when they are worked out again.

**Why:** the bed classifier often logs one climb back into bed as *got out → got into → got out*. The last
marker, seconds after the return, is the same movement read twice, so sleep analysis sets it aside, but only
when something shows the child really is back in the bed. Until #598 that was any 3 minutes of movement in
the bed in the 2½ hours after the return. Now it is **6 minutes of slight movement**: a reading at or above
0.0005 and not above 0.01 (the level at which a minute counts as the child moving), which is what a still
sleeper produces. Bigger movement no longer counts. After a child has got up for the day it is usually a
parent at the bed (stripping it, tidying, reaching in), and counting it let a parent's visit an hour after a
real 07:12 exit set that exit aside, so the night reported 09:27 instead.

**What it changes, stated rather than guessed:**
- **6 is measured on two cameras in one house.** Over every stored night of both children there (two
  databases, 200 nights), the second exits that really were the wake had 0-3 such minutes in the 2½ hours
  and the ones a review confirmed were not had 10 or more. (One unreviewed case sits between, at 7-8, and its
  result is the same for any threshold from 4 to 11.) Any threshold from 4 to 10 gives identical results
  there; 6 sits in the middle. Scaling every reading by a third to three times (a tighter or looser detection zone)
  kept those groups at 5 or fewer and 7 or more, so the zone's size matters only a little. Nothing checks
  the number against your camera.
- **A very still sleeper loses the benefit.** A child who climbs back in and then lies so still that the bed
  shows fewer than 6 such minutes in 2½ hours is treated as having left at that last marker: the wake is too
  early. In that house, a 2½-hour stretch of real sleep showed fewer than 6 in about 1-5% of stretches,
  depending on the child.
- **A child who climbs back in and then really gets up within about two hours** has not had time to show 6:
  the wake lands on the *got out of bed* seconds after the return, not on the later real exit, which the old
  rule did find. On the night this rule was built for, the sixth slight movement came 133 minutes after the
  return.
- **A camera that only ever sees big movement** (its bed readings are either over 0.01 or close to zero,
  for example a zone that does not cover where the child lies) never shows a still sleeper, so this rule
  never sets a marker aside there: the same early wake. Draw the zone over a real picture of the child
  asleep and look at what it covers.
- **It never leaves a night without a wake.** If no later *got out of bed* backs up a departure, the marker
  that was set aside is still used, as before. The result is a wrong time at worst, never "still asleep".
- **Possible regression, unconfirmed:** on one production night (2026-09-05) the wake moved 46 minutes
  earlier, 07:20 to 06:34. The later time had been accepted in the morning review rather than corrected, and
  the bed then shows no slight movement at all for 45 minutes, which fits an empty bed as well as a very
  still sleeper, so which is right is not known.
- **The opposite camera: an empty bed that reads faint noise.** If the camera's picture of an EMPTY bed
  flickers between 0.0005 and 0.01 (infrared noise, a moving shadow), the empty bed looks like a still
  sleeper, so the stray return is believed as it was before and this fix does not help on that camera. It is
  never worse than before the change there: the old rule would have believed the same return.
- **Wake times can move either way, and wake counts and asleep/awake minutes move with them.** On the
  measured nights every night that changed moved earlier, and the stretch after the new wake stopped counting
  as sleep (on production nights the wake count went from 8 to 5, 6 to 4 and 3 to 1). That is not a rule: a
  night can also move later, when a real exit the old rule set aside is now found and the old answer was an
  earlier one (for example an evening marker handed back because the real morning exit had been set aside too).
- **Not fixed: an early wake with no stray marker at all.** If the child stirs, only a *got out of bed* is
  logged and the bed then reads empty because the child lies still, the night still ends at that stir. Telling
  that apart needs a way to tell an adult's movement from a child's, which the detector does not have.
- **The same check before a mid-night trip is unchanged.** A *got out of bed* within a minute of a *got into
  bed* is also set aside when counting short trips out of bed during the night, and there any 3 minutes of
  movement still count. It probably has the same weakness (a missed trip, not a wrong morning); that is to be
  measured before it is changed. Nor does the other morning check change: a *got into bed* within 20 minutes
  after a *got out of bed* still cancels that exit on any 3 minutes of movement, because "came back and
  stayed" is a different question and #598 did not measure it.
- **Saved nights keep their old answer** on the child's page; the detail view works a night out afresh, so
  for the nights this changes the two can differ until an admin uses **Recompute this night** (README,
  "Re-working out a night").

**What to do:** nothing, there is no setting for this. If a reported wake looks too early on a night like
this, correct it in the morning review ("Was last night right?"): that is what the threshold was checked
against.

---

## A morning wake that changed by itself as the morning went on (#509)

**What you saw:** a night's wake time that read one thing early in the morning and a different, later one
an hour or so after. The change came at a fixed moment, about 20 minutes after the last "got out of bed"
the bed classifier logged, not because anything new happened in the room.

**Why:** the wake is "the start of the last stretch of activity" (movement in the bed or out of it, or
sound) unless a *got out of bed* confirms an empty-bed stretch of 20 minutes or more, in which case that exit
is the wake. A child's real exit often leaves no *got out of bed* (movement in the bed zone and outside it at
the same moment), and the exits that are logged later belong to a parent handling the bed. Once the last of
those had 20 quiet minutes after it, it confirmed a gap and replaced the earlier wake. The two nights this
was built around, one child, both on staging and production: 2026-10-05 (true exit 06:19-06:20, shown as
06:25 until about 08:11 and then 07:51) and 2026-09-27 (true 05:49, shown as 05:49 and then, once the later
exit had its 20 quiet minutes, 07:22 on staging and 07:36 on production). It is not only those two: replaying
the 60 nights on record at eight clocks from 10 minutes to 5 hours after the window, the rule changes the
wake on 10 nights on staging and 9 on production, for both children, and several of those also moved with
the clock before.

**What it does now:** a confirmed exit that comes **later** than the start of the last stretch of activity is
set aside when the bed read **strictly quiet for 20 minutes or more** in between and the bed was then not
quiet for **at most 20 minutes** before that exit's own gap began. "Strictly quiet" means every one of those
minutes was observed and under the movement threshold: **a single minute of movement, or a single minute with
no reading, breaks the stretch** (unlike the empty-bed scan, which bridges one isolated minute: this rule
removes an exit, so it asks for stricter evidence). The wake is then the start of the activity; the exit that
was set aside is still stored in the night's shadow wake. Nothing is set aside on a night where no run of
activity reaches the end of the window (a child already quiet then keeps the exit), on a night still in
progress, when the exit is earlier than the start of the activity, or on a night the bed barely moved
(peak under 0.1: those are the empty-bed check's, and discarding the exit there would turn a real wake into
"nobody slept here").

**Limits, stated rather than hidden:**
- **Calibrated in one house.** The rule was chosen and checked on the same 60 nights of two cameras in two
  rooms, with the owner's corrections on staging as the only truth, and **there is no untouched validation
  set**: the next real mornings are the first out-of-sample test. Staging and production watch the same two
  rooms, so agreement between them is a consistency check, not independent evidence.
- **A microphone that hears the whole house (sound is not per room, and rooms are adjacent) makes the wake
  EARLY**: the "activity" can start with noise from elsewhere, and the later, correct exit is then set
  aside; the wake lands on that first activity, never on no wake at all. A child who fusses, falls back
  asleep for 20 minutes or more and is carried out later is reported at the fuss. So is a child who got out
  of bed, was logged back in (a *got into bed*) and left again later: the scan's own check would refuse the
  first absence because the child came back, but this rule does not look for the return, and that was not
  measured, so it was not guessed at (#618). **Sensitivity matters the same way:** a bed zone that is large, or a
  camera that reads a child stirring in bed as under the movement threshold, produces strictly quiet
  stretches while the child is still there. The one night on record that is exactly this pattern (2026-10-03,
  one child, production: the bed read 0.002 to 0.0098 against a threshold of 0.01 while the child was in it,
  and the real exit was at 07:16) keeps its correct exit only because three isolated minutes in the
  stretch read 0.014 to 0.029. The opposite fault, a bed zone painted so that it never reads quiet while the
  child is away, leaves the rule with nothing to act on: the later exit stands, exactly as before this
  change.
- **Not fixed by this:** a night where the right time is the early one but the bed shows no strictly quiet
  stretch of 20 minutes between it and the later exit (2026-09-16, one child: 06:15 was right, the exit at
  06:46 stands); a stray early exit that a later night's evidence corrects (#610); a night with no confirmed
  exit yet, which still shows no wake until 20 quiet minutes have passed.
- **Nights already stored are mostly not recomputed.** The nightly job keeps re-working a night out until
  its evidence is final (about 3 hours after the window closes), so a night still in that period picks the
  new rule up; after that a stored night keeps the wake it was saved with, and a night a parent has
  corrected is locked from the start. The new rule applies to nights worked out after the update and to a
  recompute. A night that has been worked out again reads the wake from the evidence it has *now*: rows
  older than the 30-day retention are gone.
- **The rule makes the wake clock-independent for one selected exit, not for the whole scan.** The empty-bed
  scan itself can switch to a different gap as the morning goes on (a gap is dropped once more than 20
  minutes of bed activity follow it, and the count grows with the clock), and the rule then judges the new
  gap. The switch is inherited and not fixed, **and the rule does not leave it as it was**: where the scan
  moved from an early exit to a later one, the rule can turn that into the start of the activity and then the
  later exit's own time (a larger move, in the other direction; #618). Replayed over the 60 nights, the share whose
  wake still moved by more than 15 minutes with the clock fell from 12 to 5 on staging and from 17 to 10 on
  production; it did not fall to none, and nights that gain a wake only later (none at first) are counted
  separately and unchanged. Examples on production: 2026-10-01 (one child: 06:09, then 06:55, then 06:09
  again) and 2026-09-19 (the other: 06:34, then 05:49).
- **Where it shows:** the "Woke <earlier time> <later time>" comparison on a night's detail page appears
  only when the two differ, so it disappears on a night where the exit was set aside; the "got out of bed"
  marker is not drawn for it; the child counts as out of the bed from the start of the activity, so a parent
  at the bed afterwards is drawn as the child being out rather than someone in the room; and the morning
  row of the detail page ends at the window end, so an alert or a wake clip between the window end and the
  exit that was set aside is no longer listed there.
- **The window end matters.** The start of the activity can never be later than the window end, and an exit
  is looked for up to 3 hours past it, so the same night can read differently under a 07:00 and a 07:30
  window.

## The Bed area editor's picture says it couldn't grab a frame, and keeps saying so (`[snapshot] still frame` in the log)

**What you see:** On one camera's **Bed area** editor, *Couldn't grab a frame* every time, including after
**Try again** or **Refresh frame**, while the camera streams normally. The log has one line like
`[snapshot] still frame for "<camera>": the last ffmpeg grab was stopped but has not exited yet ...`.

**Why:** Requests for a camera's still frame share one grab at a time (#552; see
[The picture behind the Bed area editor](docs/notifications.md#the-picture-behind-the-bed-area-editor)), and
a grab counts as finished only once its ffmpeg has **exited**, not when it was told to stop. The ffmpeg part
of a grab is killed after 8 seconds (with an **Alert image URL** set, it comes after up to 5 seconds of trying
that address, so one grab can last about 13 seconds), and a killed ffmpeg normally exits within moments; until
it does, requests get the killed grab's answer (no frame) rather than starting a second ffmpeg beside it. If it never exits (a process
stuck inside the operating system, which a kill cannot end; not seen so far), that camera's frame stays
unavailable. The log line is written once per stuck grab, the first time a request is turned away by it. A
line followed by a working frame a moment later was only the normal short wait for the exit.

**What to do:** Restart the container. Alert images, the bed exit and entry frames and timelapse frames do not
go through this shared grab, so it does not hold them up, and other cameras' frames are not affected.

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
