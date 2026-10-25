# Security policy

Nightlight is a self-hosted baby monitor. It stores camera credentials, a JWT signing secret,
notification-provider tokens, and recordings/snapshots of your home and family. Please report
security issues privately, not as a public GitHub issue.

Those secrets sit in the data directory in plaintext; at rest they are protected by file
permissions, so keep that directory private to the container. The database, `.jwt_secret`, the
Firebase files, the snapshots and the backups are in its `private/` folder, which is always owner-only
(`700`); everything else is owner-only by default (`UMASK`). See
[Who can read the data directory](docs/operations.md#who-can-read-the-data-directory).

## Supported versions

Nightlight is pre-1.0 and released continuously. Only the **most recently released version**
(the `:latest` Docker tag / the newest `vX.Y.Z` GitHub release) receives security fixes — older
tags are not backported to. If you're on an older version, the fix is to upgrade — see
[docs/operations.md](docs/operations.md) for the procedure.

## Reporting a vulnerability

**Do not open a public GitHub issue for a security report.** Use one of these private channels
instead:

- **Preferred: [GitHub Security Advisories](https://github.com/sauso/nightlight/security/advisories/new)** — lets you report
  privately to the maintainer, include proof-of-concept details safely, and (if applicable)
  coordinate a disclosure timeline and CVE.
- If you can't use GitHub Security Advisories for some reason, open a normal issue that says only
  "I have a security report" with no details, and ask for another private channel.

Please include: the affected version/commit, a description of the issue and its impact, and
reproduction steps if you have them. This is a solo-maintained project — reports are
acknowledged and triaged on a best-effort basis, typically within a few days, not under a formal
SLA.

## Safe diagnostic handling

The in-app **diagnostics bundle** (Settings → Logs) and **camera report** (Add camera screen,
when a camera won't connect) are both designed to be attached to a public GitHub issue: they
redact URL passwords and query values and stay on your device until you choose to share them.
Diagnostic camera paths omit query strings and fragments entirely. **Redaction cannot identify
every secret a particular camera's firmware might put into arbitrary error prose or log lines** —
open and read either file before attaching it anywhere public. If you find a secret in one that
shouldn't be there, that's itself worth a private report under "Reporting a vulnerability" above,
rather than a public issue.

### What the diagnostics bundle replaces, and what it keeps (#547)

The bundle is for a public issue, so it does not carry who your household is:

| In the bundle | Shown as |
|---|---|
| Each child's name | `Child 1`, `Child 2` … (in the order the children were added) |
| Each child's birthday | left out (`birthday` is always `null`) |
| Camera names, wherever they appear: the camera list, the history, the log lines | `Camera 1`, `Camera 2` … (in the order of the live grid); a camera removed since is `Camera (removed) 1` |
| Account usernames, first and last names (where they appear in log lines) | `User 1`, `User 2` … (in the order accounts were created); an account renamed or deleted since is `User (former) 1` |
| The app name, when you changed it | `(customised)` |

The same alias is used everywhere in one bundle, so `Camera 2` can be followed from the camera list
into the history and the logs. A child's name and a camera's name that are the same text show as
`Child 1 / Camera 1`.

**Still included, on purpose:** camera and MQTT host addresses (often private LAN addresses),
MQTT topics, the camera's own login name (not its password), your timezone, and the time of every
event. Support needs the addresses and timezone to diagnose a connection or a bedtime that is off by an
hour, and the times **are** the diagnosis, but they also show when a child slept and woke. Read the file
before attaching it.

**Known limits.** The replacement looks for the names stored right now, plus every camera name and
username the history remembers. It does **not** find: (1) a name in an in-memory log line that you
have since changed (a child or account renamed after the line was logged: **Clear log** in Settings →
Logs empties that buffer, and a restart does too); (2) a name shorter than 3 characters inside free
text (it is still replaced in the child and camera lists, but "Jo" is not searched for in log lines,
because that would rewrite ordinary words); (3) a name written in an MQTT topic or a camera's address
in a form other than as typed or percent-encoded. (A name containing a line break or another control
character is also found in the escaped form the log writes it in, for example `Name\nTwo`, #539. Two
names that differ only by a real line break versus a typed backslash-n look the same there and may share
one alias. A camera password that itself contains a line break is not recognised as part of its address
and could appear in a log line; the app's single-line fields make that practically unreachable.) The
reverse also holds: (4) a name that is an
ordinary word (a child called "Max", "Motion" or "Sound") is replaced wherever that word appears in
the log text and in a camera's own settings, so a line can read "Child 1 detected" or a
`detect_source` can read "Camera 1" (and an id that happens to contain such a word is rewritten, the
same way everywhere, so it still correlates); the timezone setting, the version and the system section
are never rewritten. If the bundle ever contains a name after the replacement, the download is refused
with a "privacy check" error and nothing is sent; please report it.

**Never paste any of the following into a public issue, PR, or discussion:**

- Camera usernames/passwords or RTSP/ONVIF URLs containing credentials
- The contents of `.jwt_secret`, or any session/JWT token value
- Firebase service-account JSON or any push-provider API key/token
- MQTT broker credentials
- TOTP secrets or MFA backup codes
- Recordings, snapshots, or clips you aren't comfortable making public — these can show your
  child and your home

## How long a sign-in lasts, and where it is kept

> **⚠️ A sign-in ends at a fixed time, and the app's own push alerts stop with it, without warning.**
> A sign-in lasts `SESSION_TTL_DAYS` days (default **30**) counted from the moment you signed in, not
> from when you last used the app. A phone is therefore signed out at the **same time of day** it signed
> in, that many days later, even in the middle of the night. From that moment the Nightlight app on that
> phone gets **no push alerts**, a live view or background audio that is playing stops (within about 15
> seconds in Low latency mode, at its next request in Compatibility mode), and nothing on the phone says
> so until someone opens the app and sees the sign-in screen. Signing in again restores everything. The
> session lists (Account, and Settings → Caregivers for an admin) show when each device was last active,
> **not** when it signed in or when it will be signed out, so if you rely on a phone's alerts, sign in
> on it again at a time of day that suits you, before its lifetime runs out. Pushover, ntfy and Gotify
> are not tied to a sign-in and are not affected.

| Setting | Default | Range | Anything else |
|---|---|---|---|
| `SESSION_TTL_DAYS` | `30` (blank or unset means 30) | `7`-`30`, whole days | Ignored with one warning in the log, and 30 is used. A bad value never stops the app starting. |

A value other than the default is logged at start (`[auth] sign-ins last 7 days ...`). It is read at
start, so a change needs a restart. It can only **shorten** the lifetime: 30 is the most, as before
this setting existed. 7 is the least on purpose: because the end is silent for alerts, a one-day
lifetime would stop a parent's alerts at the same hour every night.

**Lowering it signs out every sign-in older than the new value, at that device's next request**, push
and live views included: they all check the same rule. **Raising it does not lengthen sign-ins already
made**: each sign-in's token carries the lifetime in force when it was issued, so a sign-in made while the
setting was 7 still ends on its 7th day after you raise it to 30; only sign-ins made after the change get
the longer lifetime. Nor does raising it bring a signed-out device back; that device signs in again.

**What else to know:**

- **There is no idle sign-out.** A device that is never used stays signed in until its lifetime ends; a
  device in constant use is still signed out when it ends.
- **The sign-in token is kept in the browser's `localStorage`** (in the Android app, the app's own web
  storage), for as long as the lifetime. Anything that can run script on the Nightlight page could read
  it, so a cross-site scripting bug would be a stolen sign-in. The page's Content Security Policy is
  enforcing (no inline scripts, no `eval`) to make that hard, and a stolen token is only as good as its
  session: it is checked against the server on **every** request, so ending the session (below) ends it.
- **Every sign-in can be ended from the server, at once:** sign out (on that device, or that device's
  **Sign out** in your Account's session list), an admin signing out any device (Settings → Caregivers),
  removing the account, or changing your password (signs out your other devices). Changing someone's role
  takes effect at their next request without signing them out.
- **The 12-hour media token ends with its sign-in.** Video, snapshot, clip and talk URLs carry a separate
  short-lived token (never the sign-in token). Since #562 it stops working when its sign-in ends, even if
  its own 12 hours have not run out; before, it could outlive the sign-in by up to 12 hours.

## If you suspect a credential was exposed

Rotate it — Nightlight doesn't have a way to know a credential was compromised, so this is
manual:

- **Camera password**: change it on the camera itself, then update it in Nightlight (Cameras →
  edit camera).
- **Admin/caregiver account password**: sign in and change it (Account → Change password), or
  have an admin reset another account's.
- **JWT signing secret** (`private/.jwt_secret` in the data volume): deleting it and restarting the
  container generates a new one and signs everyone out, forcing a fresh login everywhere.
- **Notification-provider tokens** (Pushover, Firebase, Gotify, ntfy): regenerate/revoke the
  token or key at the provider and re-enter it in Settings → Push notifications.
- **MQTT broker credentials**: rotate on the broker and update the camera's MQTT settings.

## Scope

This policy covers the `nightlight` (this repo) and `nightlight-mobile` codebases and their
published Docker images. It does not cover third-party camera firmware, MediaMTX/FFmpeg
upstream, or notification-provider services themselves — report those to their own maintainers.
