# Camera controls

**Settings → Camera controls** (admin only) holds two global settings that apply across every
camera — not per-camera detection settings, which live on each camera's own **Cameras → edit →
Motion detection** page.

## Pan / tilt step size

| Setting | Default | Range |
|---|---|---|
| PTZ step size | 12 | 1–100 |

How far a camera moves per tap of the pan/tilt arrows in the live view. A larger number moves
further per tap. This only affects cameras that support precise relative positioning
(ONVIF `RelativeMove`) — cameras that don't move a fixed amount per tap regardless of this
setting. There's no single right value; it depends on the camera's own pan/tilt hardware and
gearing. 12 suits the common Sonoff pan/tilt cameras this was tuned against — if taps feel too
small or too jumpy on your camera, adjust it and see how it feels.

## Camera-offline alerts

| Setting | Default | Range |
|---|---|---|
| Notify when a camera goes offline | Off | — |
| Offline for longer than (minutes) | 5 | 1–1440 |

Sends a push notification (through whichever providers you've set up under **Settings → Push
notifications**) when a camera stops delivering video for longer than the threshold, and a
second notification when it recovers. A brief blip that clears on its own — shorter than the
threshold — never alerts, and each outage produces exactly one "went offline" notification, not
a repeat per minute it stays down.

The threshold is measured from the first check (every 15 seconds) that couldn't *confirm* the
camera was delivering video, and only a confirmed picture stops it. A check where the streaming
server inside Nightlight (MediaMTX) isn't answering at all counts as one that couldn't confirm it,
so that time counts toward the threshold too. This is different from the
automatic restart, which never fires while the streaming server isn't answering, because it only
acts on a confirmed "no video" (see [KNOWN-ISSUES.md](../KNOWN-ISSUES.md), "Cameras show
connecting/offline and the log has `[guard:mediamtx-api]` lines"). So if the streaming server gets
stuck, you still get this notification, even though nothing was restarted.

This is a global on/off with one global threshold: it applies to every camera the same way,
there's no per-camera override.

## Silencing a camera's alerts, and who did what

Not a setting: this is a control on every camera tile, described here because it sits beside the
alerts above. In a tile's menu (the gear button), **Silence alerts** mutes every alert from that one
camera (motion, sound, ONVIF and MQTT) for 15 minutes, 30 minutes or an hour, and the same button then
un-mutes it early. Anyone signed in can use it, caregivers included. The server accepts at most 720
minutes (12 hours) for one silence; the tile only offers up to an hour.

**Who did it is recorded, by username.** That is the login name an admin sets for each account, never
the first name, which anyone can change on their own account (so it cannot be used to put someone
else's name on what you did). It is copied at the time, so renaming or deleting the account later does
not change what was recorded.

- **On the tile, to everyone:** while a camera is silenced, the button reads `Muted until <time> by
  <username> · tap to un-mute`, and the muted-bell time in the tile's strip says the same on hover. The
  name goes away when the silence ends, whether it ran out or someone un-muted it.
- **In Camera history** (Settings → Logs, admin only): one row for each silence (`muted for 30 min`),
  each un-mute of a camera that was muted (`un-muted`), each stream restart (`stream restarted manually`, or `stream restart
  failed`) and each camera reboot (`camera reboot requested (ONVIF)`, or `…; the camera did not
  confirm`), each followed by `by <username>`. Silences are listed as **Silence alerts**. A silence that
  simply runs out adds no row: its length is in the row that started it. An un-mute of a camera that is
  not muted (never was, or its silence already ran out) changes nothing and adds no row either, so
  repeating it cannot push other cameras' rows out of the shared history (below). Rows the system writes
  itself (a watchdog restart, a camera going offline or coming back) have no name.

**The difference people get wrong: a silence needs its history row, a restart does not.**

| Action | If the Camera history row can't be written |
|---|---|
| Silence or un-mute alerts | **Nothing happens.** The camera keeps (or stays in) its previous state and the tile does not change. Not muting is the safe direction: a silence is the one action here that can hide something from everyone else. |
| Restart the stream, reboot the camera | **It still happens**, without a row. By the time the row is written the camera has already acted, and that cannot be undone. |

A failed restart or reboot is recorded too, because a failure can still have acted: a restart may have
stopped the old stream, and a camera may accept a reboot and drop the connection before it answers.

Known limits: Camera history keeps at most 2,000 rows and 30 days, shared by every camera, so an old
silence can be pruned away (by age, or by enough newer rows from any camera), and **Clear log** removes
every row. Silences, restarts and reboots from before this was recorded show no name. The diagnostics
bundle (Settings → Logs), which is meant to be attached to a public issue, keeps only whether each
history row was a *person* or the *system*, never the username.

**Going back to an older version is not safe for privacy.** An older version's diagnostics bundle
includes Camera history as stored, so after a downgrade it carries the username and account id of
everyone this version recorded, for as long as those rows are kept (up to 30 days). If you downgrade
and then share a diagnostics bundle, first clear Camera history (**Clear log**) or remove those fields
from the file.

## Related

- **[MQTT](mqtt.md)** — the broker connection and per-camera topics this doesn't cover.
- Per-camera motion/sound detection sensitivity, schedule, and detection source (Nightlight
  frame-diff / ONVIF / MQTT) are configured on each camera's own settings page, not here.
