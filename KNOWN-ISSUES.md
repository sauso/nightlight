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

**What to do:** **Low latency** is still the smoothest option on iOS, so prefer it when you can;
use Compatibility when a camera or network can't sustain WebRTC. Android is
unaffected — its foreground background-listening service keeps the whole process alive, so both
modes sustain background audio there regardless.

## Non-monotonic DTS spam in the logs

**What you see:** `docker logs` filling with `Non-monotonic DTS; previous: … current: …`
lines for a camera.

**Why:** Same camera-firmware timestamp glitch as above, at its most minor — FFmpeg is
correcting the timestamps in place and the stream keeps working. It's noisy but harmless.

**What to do:** Ignore it. It's log noise, not an error. (Docker's log rotation, set up in
the README, keeps it from filling the disk.)

---

## Confirmed bugs (fix pending)

_None currently tracked. When one is confirmed but not yet fixed, it goes here with the
symptom and, if known, a workaround — so it's not mistaken for one of the understood
behaviours above._
