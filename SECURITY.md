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
- ESPHome Native API encryption keys
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
> session lists (Account, and Settings → Users for an admin) show when each device was last active,
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
  **One exception:** a TV that a sign-in [connected](#pairing-a-tv) has a sign-in of its own, and a plain sign-out
  does not end it (revoking does, below).
- **Every sign-in can be ended from the server, at once:** sign out (on that device, or that device's
  **Sign out** in your Account's session list), an admin signing out any device (Settings → Users),
  removing the account, disabling it (it is kept, and cannot sign in until an admin enables it again;
  enabling it brings no sign-in back), or changing your password (signs out your other devices). Signing a
  device out **from the session list** also signs out every TV it connected; signing out on the device itself
  does not ([Pairing a TV](#pairing-a-tv)). Changing
  someone's role takes effect at their next request without signing them out. Ending a sign-in stops the
  Nightlight app's push alerts on that device; it cannot stop Pushover, ntfy or Gotify, which are one
  destination for the whole household, so remove a person there yourself.
- **The 12-hour media token ends with its sign-in.** Video, snapshot, clip and talk URLs carry a separate
  short-lived token (never the sign-in token). Since #562 it stops working when its sign-in ends, even if
  its own 12 hours have not run out; before, it could outlive the sign-in by up to 12 hours.

## Caregiver invite links

An admin can create a caregiver's account without a password and send a one-time link instead (#1094). **The link
is a credential:** whoever opens it first can choose that account's password and sign in as that caregiver. That
means watching and listening to the cameras and talking through them, recording, changing children's names and
photos, answering the morning review, and the rest of what a caregiver can do
([docs/caregivers.md](docs/caregivers.md#what-caregivers-and-admins-can-do)). It is never an admin account: invites
make caregivers only, and an account waiting on its invite cannot be made an admin until it has a password. The link
works once, for 7 days. Send it only to the person it is for.

What protects it: the token is 256 random bits and only its sha256 is stored, so a copy of the database holds no usable
link; it is shown once, to the admin who made it, and is in no list, API answer or log line. Every unusable link gets
the same answer, a link whose account is disabled included. Until it is used, the account cannot sign in by any route. Known limits: anyone who sees the link (a
shared chat, a screenshot of the QR code) holds it until it is used or cancelled, and restoring a backup can make a used
or cancelled link work again until its 7 days are up, so cancel unexpected invites after a restore
([details](docs/caregivers.md#after-restoring-a-backup-or-going-back-to-an-older-version)).

## Pairing a TV

A TV (the Nightlight Android app on a television) can be signed in without typing a password on it (#1237). The TV
shows a code; someone already signed in on their phone or computer types that code and approves it; the TV is then
signed in **as that person**, with a **view-only** sign-in. This version has the server side; the screens for it (the
TV's pairing screen, the approval page) come in the next update.

**What a TV sign-in can do:** watch and listen to the live cameras, and nothing else. No settings, children, sleep,
recordings, clips, snapshots, accounts, sign-ins or alerts, and no talking back. It is a caregiver whichever account
approved it, so an admin's TV is not an admin. A password typed into the TV's own sign-in form (on the pairing screen)
makes the same kind of sign-in.

**How long it lasts:** like any sign-in (`SESSION_TTL_DAYS`, default 30 days from when the TV was connected, never
extended). The code on the TV works once, for 10 minutes.

**How to end it:** it is in the session lists (Account, and Settings → Users for an admin) like any sign-in; the next
update marks its row as a TV, with the device that approved it (as that device's browser described itself: see the
limits below). **Sign out** on its row ends it. Signing out the phone
or computer that approved it **from the session list** also ends the TV; signing out on that phone itself does not, so
signing out your phone does not switch off the living-room TV. Disabling or removing the account ends it, and so does
changing the password from another device.

**What protects it:** the code on the TV is not a password. It only lets a person who is **already signed in** choose to
connect that TV, and they must type it (a QR code only opens the page; nothing fills the code in). The TV's own half of
the pairing is 256 random bits that only the TV holds and the server stores only as a hash; it is in no log, list or
link. When the TV collects its sign-in, the approval is checked again: if the sign-in that approved it has ended since,
or the account was disabled, the TV is refused. An account can have at most 5 TVs, counting the ones it has approved
that have not connected yet. Each approval and each TV that signs in is written to the server log, with the account,
the TV's name and device, and the approving device.

**Known limits:**

- **Only approve a code you can see on your own TV.** Approving a code someone sent you gives them view-only access to
  your cameras until it is signed out. The approval page shows the TV's name in quotes beside its device; the name is
  whatever the TV chose to call itself, so a laptop can call itself "Living room TV".
- **The device strings are not proof of anything.** The TV's device on the approval page, and the approving device on
  the TV's row and in the log, are each read from what that device's own browser reports about itself (its User-Agent),
  so they can be made up, and different devices can look the same: a phone and an Android TV can both read "Chrome on
  Android". Treat them as a hint, never as a check that it is your TV or your phone.
- **A phone left unlocked and signed in, or a stolen sign-in, can connect a TV that outlives it.** Everything else that
  sign-in can do ends when it ends; a TV it connected lasts up to 30 days (a sign-in on its 29th day can connect a TV
  that lasts to day 59). Approving asks for no password or code. What ends that TV: signing out its row, signing out the
  sign-in that connected it **from the session list** (a plain sign-out does not), disabling or removing the account, or
  a password change made from another device. The approving sign-in may also be older than the account's two-factor:
  turning two-factor on signs nobody out.
- Changing your own password, or an admin resetting their own, keeps the device it was done from, so a TV that device
  connected stays connected. Sign it out from the list.
- The limits on pairing are kept in memory (a restart empties them), and behind a reverse proxy without `TRUST_PROXY`
  every remote device has the same address. **A TV that is not on your home network needs `TRUST_PROXY` set**
  ([remote access](docs/remote-access.md#trust_proxy--telling-nightlight-your-real-client-addresses)), or one internet
  client can keep remote pairing busy. Even with it set, at most 20 pairings wait at once, and when every address holds
  just one, a new start pushes out the oldest waiting pairing, which can be yours: someone with about 20 internet
  addresses (easy with IPv6), many devices on your network, or many Tailscale accounts can keep doing that and delay a
  pairing. The TV's password sign-in is the fallback.
- If the TV never receives its sign-in after it was approved (a dropped connection), the TV pairs again, and the unused
  TV sign-in stays in the list until it expires. Nobody holds it, so it is harmless; sign it out.
- A password typed on a TV in the ordinary sign-in page makes an ordinary sign-in; only the pairing and the pairing
  screen's own password form make a TV sign-in. A TV signed in by password before that screen arrives keeps its ordinary
  sign-in until it is signed out once.
- **Going back to an older version turns every TV sign-in into an ordinary one with the approver's real role** (older
  versions do not know the kind). Sign every TV out before going back.
- A clock moved backwards can make a code that has run out work again, until the real time passes its expiry.
- Restoring a database backup restores its sign-ins and any waiting pairings; a TV you signed out comes back with an old
  backup if the signing secret is restored too. Sign it out again.
- The TV's name is plain text, at most 40 characters, with line breaks, control and text-direction characters and
  characters that draw nothing (zero-width spaces, Hangul fillers and the like) taken out; a name with nothing visible
  left is no name. Nothing shows it as markup. Names in other alphabets are shown as typed.
- Not tried yet: a real TV remote with the pairing screen, a phone on mobile data scanning a QR code for a home-network
  address (it will not open; typing the code in Nightlight at your usual address works), a TV behind a reverse proxy.

## If you suspect a credential was exposed

Rotate it — Nightlight doesn't have a way to know a credential was compromised, so this is
manual:

- **Camera password**: change it on the camera itself, then update it in Nightlight (Cameras →
  edit camera).
- **Admin/caregiver account password**: sign in and change it (Account → Change password), or
  have an admin reset another account's.
- **A caregiver invite link** that went to the wrong place: an admin cancels the invite or makes a new one (the old
  link stops working at once). If it was already used by someone else, remove that account.
- **A TV you do not recognise** in a session list: sign it out there, and sign out the device it says approved it (from
  the list, so its TVs go too). See [Pairing a TV](#pairing-a-tv).
- **An account that should not have access for now** (while you find out what happened, say): an admin disables it (Settings → Users → the account → **Disable account**). It is signed out everywhere
  at once, its open live views close within about 15 seconds, and its invite link stops working; the account and
  its history are kept. With the right password the sign-in screen then says the account is disabled; a wrong
  password gets the usual answer, so this tells nothing to someone who does not know the password. Remove the
  person from Pushover, ntfy or Gotify too if they are subscribed
  ([details](docs/caregivers.md#disable-an-account-instead-of-removing-it)).
- **JWT signing secret** (`private/.jwt_secret` in the data volume): deleting it and restarting the
  container generates a new one and signs everyone out, forcing a fresh login everywhere.
- **Notification-provider tokens** (Pushover, Firebase, Gotify, ntfy): regenerate/revoke the
  token or key at the provider and re-enter it in Settings → Integrations → Push notifications.
- **MQTT broker credentials**: rotate on the broker and update the camera's MQTT settings.

## Camera streams are untrusted input (media isolation)

FFmpeg, ffprobe and MediaMTX parse whatever a camera sends. By default (#553) they run as a separate,
unprivileged user inside the container, with no Linux capabilities, so one that a camera takes over cannot read
the database, `.jwt_secret` or the app's environment. They are also given only a short allowlist of environment
variables. It is on unless `NIGHTLIGHT_MEDIA_ISOLATION=0`, and it turns itself off, with a warning in the log and
a line on Settings → About, on a host that cannot support it (rootless Docker or Podman, a share that ignores
`chmod`, NFS `root_squash`, `PUID` or `PGID` 1700, `PUID=0`, missing capabilities). The limits, stated plainly:
the app itself holds `CAP_SETUID`, `CAP_SETGID` and `CAP_KILL`, so a compromised app can become root inside the
container and, if the data share is not mounted `nosuid`, create setuid files; the media programs share one user, so
one can signal or inspect the others; MediaMTX's API on the container's loopback has no password and exposes the
cameras' credentials; and camera passwords are on FFmpeg's command line. Keep cameras on their own network. Detail
and the reasoning: [docs/operations.md](docs/operations.md#media-isolation) and
[docs/architecture.md](docs/architecture.md#media-isolation-the-layout-and-the-fence-553-phases-2b-and-4-on-by-default).

## Scope

This policy covers the `nightlight` (this repo) and `nightlight-mobile` codebases and their
published Docker images. It does not cover third-party camera firmware, MediaMTX/FFmpeg
upstream, or notification-provider services themselves — report those to their own maintainers.
