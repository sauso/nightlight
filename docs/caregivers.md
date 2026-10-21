# Adding caregivers

Add a login for someone you trust without giving them control over every setting. Once signed in
as admin, go to **Settings → Caregivers** to create additional logins (e.g. for a partner or babysitter).

The rule (owner decision, 2026-10-10): **a caregiver can watch and act in the moment, but cannot
destroy or reconfigure.**

## What caregivers and admins can do

| Capability | Caregiver | Admin |
|---|:---:|:---:|
| View live cameras; watch and download alert clips, recordings, wake clips and timelapses | Yes | Yes |
| Record, move a PTZ camera, talk through a camera | Yes | Yes |
| Restart, reboot, or snooze camera alerts (recorded with your username; see [Camera history](#camera-history-and-permissions)) | Yes | Yes |
| Reorder cameras on the live grid | Yes, except a move that would change which camera a child's sleep is measured from (the app refuses that one and says why; see [Rearranging the live grid](#rearranging-the-live-grid)) | Yes |
| Assign a camera to a child | No | Yes |
| Add / edit / enable / delete a camera | No | Yes |
| Change a child's name, birthday, colour and photo | Yes | Yes |
| Add a child; turn a child's sleep tracking on or off; change their bedtime and wake time; choose the camera their sleep is measured from | No | Yes |
| Answer the morning sleep review (the review shows who last answered it) | Yes | Yes |
| Delete an alert clip, a recording or a wake clip | No | Yes |
| Delete a timelapse | No | Yes |
| Delete a child and everything recorded for them (nights, reviews, bed transitions, recordings, timelapses) | No | Yes |
| Change global settings (detection, notifications, providers, recording retention) | No | Yes |
| Manage caregiver/admin accounts and sessions | No | Yes |

Deleting by hand is not the same as **retention**: the automatic sweep of old alert clips and wake clips
(Settings → Recording, admin only to configure) runs on a timer on every install, whoever is signed in.

### Rearranging the live grid

Anyone signed in can drag the camera tiles, and the order is shared by everyone who views the grid. For a
child whose sleep camera is on **Automatic** (the default, and every child set up before the setting
existed), the first camera that is turned on in that order is the one their sleep is measured from and
their nightly timelapse is taken from. So a **caregiver's** move that would change that camera, for any
child whose sleep tracking is on, is refused: the tiles go back to where they were, a message above the
grid says why, and nothing is saved.

**On a child set to Automatic with two or more turned-on cameras, a caregiver cannot put another of
that child's turned-on cameras ahead of the one measuring now** until an admin chooses a main camera for
the child (**Camera used for this child's sleep**, in the child's settings; it has to be a camera that is
turned on). In a home with one child and two cameras, both theirs and both on, that means no tile can be
moved at all until then. Once a main camera that is on is chosen, the tiles can be rearranged freely. An admin's
moves are never refused. Details, and what the check does not cover:
[One camera does the measuring](sleep-tracking.md#one-camera-does-the-measuring).

### Camera history and permissions

**Who did it is recorded.** Silencing a camera's alerts, un-silencing them, restarting its stream and
rebooting it each add a row to **Camera history** naming the account by its **username** (the login name
an admin sets, never the first name, which anyone can change on their own account); a restart or reboot
that failed is recorded too. While a camera is silenced, its tile shows who silenced it, to everyone. The
morning review shows who last answered it (see [the capability table](#what-caregivers-and-admins-can-do)). Details, including what happens when the history
cannot be written, are in [docs/camera-controls.md](camera-controls.md#silencing-a-cameras-alerts-and-who-did-what).
If a camera's alerts are kept silenced, on and off, for a long time (more than an hour by default, short gaps
between renewals included), the admins are sent one notification for it, which names no one; on Pushover, ntfy
and Gotify everyone on them gets it too. See [Long-silence alerts](camera-controls.md#long-silence-alerts).

On a caregiver's screen the admin-only controls are not shown (sleep tracking, the window and the sleep
camera are shown, greyed out, with a note); the server refuses them too, so a page opened before an update that changed a
permission gets a refusal rather than a change.

The **Settings** hub itself is visible to caregivers too — its admin-only pages (general,
camera controls, recording, MQTT, push providers, users, logs, clip storage) are simply hidden
for them rather than the whole screen being off-limits.

**Changing someone’s role takes effect immediately** — on their very next action, on every device
they’re signed in on. Demoting an admin to caregiver does *not* sign them out: they keep browsing as
a caregiver and simply lose the admin-only screens. Deleting an account, by contrast, ends its
sessions at once and signs that person out everywhere.

## `SESSION_TTL_DAYS` — how long a sign-in lasts

> **⚠️ A sign-in ends at the same time of day it began, and the app's push alerts stop with it, without
> warning.** The lifetime is counted from sign-in, not from the last use: a phone that signed in at 02:00
> is signed out at 02:00, `SESSION_TTL_DAYS` days later. From then until someone opens the app (which
> shows the sign-in screen), that phone gets no Nightlight push alerts, and a live view or background
> audio playing on it stops. Pushover, ntfy and Gotify are not affected. The session lists show when each
> device was last active, not when it will be signed out: if you rely on a phone's alerts, sign in on it
> again at a time that suits you before its lifetime runs out.

| Variable | Default | Range | What it does |
|---|---|---|---|
| `SESSION_TTL_DAYS` | `30` (blank = 30) | `7`-`30` whole days | How many days a sign-in lasts, counted from sign-in. Anything else is ignored with a warning in the log and 30 is used. |

- **It can only shorten.** 30 is the most, as before this setting existed; 7 is the least, because a shorter,
  silent end would stop alerts at the same hour every few nights.
- **Lowering it signs out every sign-in older than the new value at that device's next request**, push and
  live views included (they check the same rule). **Raising it does not lengthen sign-ins already made**: a
  sign-in's token carries the lifetime in force when it was issued, so one made at 7 still ends on its 7th
  day after you raise it to 30. A changed value needs a restart, and one other than 30 is logged at start.
- **There is no idle sign-out**: an unused device stays signed in until its lifetime ends.
- The sign-in token is kept in the browser's (or the Android app's) `localStorage`, and every sign-in can be
  ended from the server at once (sign out a device, remove an account, change a password). Since this
  setting, the 12-hour token in video and snapshot URLs also stops when its sign-in ends. What this means
  for security: [SECURITY.md](../SECURITY.md#how-long-a-sign-in-lasts-and-where-it-is-kept).

## Keep an admin and recover access

**There must always be at least one admin.** The only admin on an install can't be changed to
caregiver until another account is made an admin first, and no account can ever delete itself —
another admin has to remove it. Both are enforced by the server, not just hidden in the UI: the Role
field explains it up front when it applies, and a request that tries anyway gets a clear error rather
than a partial change. If an install somehow already has no admin (a database edited by hand, or
from before this was enforced), see **[docs/mfa.md](mfa.md)**'s recovery section for the console
command that fixes it — it's documented there alongside the equivalent two-factor recovery, not
because it's about two-factor, but because it's the same kind of last-resort console fix.

Any account can also turn on **two-factor authentication** for its own login — see
**[docs/mfa.md](mfa.md)** for enrolling, one-time backup codes, and how to recover if an
admin loses their authenticator.
