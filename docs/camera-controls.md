# Camera controls

**Settings → Camera controls** (admin only) holds three groups of global settings that apply across
every camera (the pan/tilt step, camera-offline alerts and long-silence alerts) — not per-camera
detection settings, which live on each camera's own **Cameras → edit → Motion detection** page.

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

## Long-silence alerts

| Setting | Default | Range |
|---|---|---|
| Notify admins when a camera's alerts stay silenced for a long time | **On** | — |
| Silenced for longer than (minutes) | **60** | **1–719** |

Anyone signed in can silence a camera's alerts from its tile (see
[Silencing a camera's alerts](#silencing-a-cameras-alerts-and-who-did-what) below). This tells the
admins when one camera's alerts are **kept** silenced, on and off, for longer than the threshold, so a
camera that has been silenced again and again does not go unnoticed.

- **What counts as one silence.** Silences of the same camera count as one when each is set no more
  than **30 minutes** after the previous one ended (ran out, or was un-muted). The length runs from
  the start of the first to the end of the latest, so **those short gaps count toward it too**, even
  though alerts were on during them: three 15-minute silences, each set 30 minutes after the last one
  ran out, count as 1 h 45 min, of which 45 minutes were silenced. That is why the notification says
  "on and off", not "in a row". Un-muting and silencing again within the 30 minutes does not reset the
  count. If the server's clock is set back to before the silence began, the next silence starts a new
  count.
- **When it is sent.** At the moment a silence is set that takes the total past the threshold —
  strictly *more than* it — not when that much time has passed. So at the default 60, one press of the
  tile's longest button (1 hour) never notifies, and silencing it again within 30 minutes of that
  hour ending does, at once. A single silence longer than the threshold (from the tile, that needs a
  threshold under 60; the API accepts up to 720 minutes) notifies as soon as it is set, and un-muting
  it early does not take the notification back.
- **One notification per silence.** Renewing the same silence again does not send another. A new
  silence, after a break of more than 30 minutes, can notify again.
- **What it says.** `Alerts silenced on <camera>`, then `Alerts from "<camera>" have been silenced on
  and off for 2 h 5 min. Camera history shows who set each silence.` A length of time, never a clock
  time. **It names no one**, on any channel: Pushover, ntfy (the public ntfy.sh unless you run your
  own) and Gotify are services outside your house, and Nightlight keeps login names out of anything
  that leaves it. Who set a silence is on the camera's tile while it lasts (`Muted until <time> by
  <username>`) and in Camera history (admin only), below. The server log notes the notification
  without any name either.
- **Not affected by the camera's alert schedule** (quiet hours): it is about the camera's alerts being
  off, not an alert from the camera.
- **Why the range stops at 719.** One silence can be at most 720 minutes, and the notification needs
  *more than* the threshold, so 719 is the highest value at which the longest single silence still
  notifies. There is no 0: the switch is how to turn it off. The threshold must be a whole number
  (`59.5`, `1e3` or `60abc` is refused, not rounded), and the switch only takes on or off (`true`,
  `false`, `1`, `0`); this is stricter than the older settings on this page, on purpose.

**Who receives it depends on the channel** (the providers are set up under **Settings → Push
notifications**):

| Channel | Who gets it |
|---|---|
| The Nightlight app (Firebase) | The devices of every account that is an admin when it is sent and is still signed in on that device, **except the person who set the silence**. A caregiver's devices never get it. |
| Pushover | Whoever holds the one configured user or group key. |
| ntfy | Everyone subscribed to the configured topic. |
| Gotify | Every client of the configured application. |

Pushover, ntfy and Gotify have no way to address one person, so **everyone on them gets it, caregivers
and the person who set the silence included**. On the Nightlight app a later notification for the same
camera replaces the earlier one in the notification tray; the other three show each one (with one
notification per silence, they repeat only across separate silences).

**How it differs from the camera-offline alert above**, which people mix up: the offline alert is
**off** by default, counts minutes of an outage (range 1–1440), goes to everyone on every channel,
and is about the camera; this one is **on** by default, counts minutes of silence that a person set
(range 1–719), is meant for the admins, and is about what someone did.

Known limits:

- **The 30-minute gap is a starting guess, not a measurement** from any house. If your silences are
  usually renewed more than 30 minutes after the previous one ended, each counts on its own, so
  repeated silences that are each at or under the threshold **never** notify. Camera history still
  records every silence and who set it.
- **Without the Nightlight app's push (Firebase) set up**, the notification goes only to Pushover, ntfy
  and Gotify, which reach everyone on them, the person who set the silence included. With Firebase
  only, and the person who set the silence the only admin, nobody receives it.
- A silence already running when you upgrade to this version is not counted: the count starts with
  the next silence set on that camera.

## Silencing a camera's alerts, and who did what

Not a setting: this is a control on every camera tile, described here because it sits beside the
alerts above. In a tile's menu (the gear button), **Silence alerts** mutes every alert from that one
camera (motion, sound, ONVIF and MQTT) for 15 minutes, 30 minutes or an hour, and the same button then
un-mutes it early. Anyone signed in can use it, caregivers included. The server accepts at most 720
minutes (12 hours) for one silence; the tile only offers up to an hour. Keeping a camera silenced, on
and off, for longer than the admins' threshold (an hour by default, so by renewing it) tells the
admins: see [Long-silence alerts](#long-silence-alerts) above.

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
| Silence or un-mute alerts | **Nothing happens.** The camera keeps (or stays in) its previous state and the tile does not change. Not muting is the safe direction: a silence is the one action here that can hide something from everyone else. The same holds if the record the long-silence alert counts from cannot be written: a silence that cannot be counted is not applied. (The long-silence *notification* itself is different: it is sent only after the silence has been saved, so a silence that fails to save sends none, and if sending it fails the silence still stands.) |
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
