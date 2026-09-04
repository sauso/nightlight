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
so the two tend to appear together.

**What to do:** if it appears once or twice around a camera restart, ignore it — the next tick
(15-30 seconds later) retries on its own. If the *same* guard line repeats steadily for many minutes,
something is genuinely stuck: check the log above it for what that camera or the streaming server was
doing, and restart the container if cameras are not recovering.

> Nightlight deliberately keeps running after an unexpected error rather than exiting, because it is
> normally left unattended overnight — a monitor that is degraded is more useful at 3am than one that
> has quit. The trade-off is that these lines are worth reading rather than assuming the app is fine
> just because it is still up.

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
recordings have no automatic retention, so it stays until you do. *(Before 0.30.0 these were hidden
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
