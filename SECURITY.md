# Security policy

Nightlight is a self-hosted baby monitor. It stores camera credentials, a JWT signing secret,
notification-provider tokens, and recordings/snapshots of your home and family. Please report
security issues privately, not as a public GitHub issue.

## Supported versions

Nightlight is pre-1.0 and released continuously. Only the **most recently released version**
(the `:latest` Docker tag / the newest `vX.Y.Z` GitHub release) receives security fixes — older
tags are not backported to. If you're on an older version, the fix is to upgrade: pull the new
image (`docker compose pull && docker compose up -d`, or the Unraid "Check for Updates") and
restart the container.

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
redact passwords and stay on your device until you choose to share them. **Redaction covers
passwords, not everything a particular camera's firmware might put in an error message or log
line** — open and read either file before attaching it anywhere public. If you find a secret in
one that shouldn't be there, that's itself worth a private report under "Reporting a
vulnerability" above, rather than a public issue.

**Never paste any of the following into a public issue, PR, or discussion:**

- Camera usernames/passwords or RTSP/ONVIF URLs containing credentials
- The contents of `.jwt_secret`, or any session/JWT token value
- Firebase service-account JSON or any push-provider API key/token
- MQTT broker credentials
- TOTP secrets or MFA backup codes
- Recordings, snapshots, or clips you aren't comfortable making public — these can show your
  child and your home

## If you suspect a credential was exposed

Rotate it — Nightlight doesn't have a way to know a credential was compromised, so this is
manual:

- **Camera password**: change it on the camera itself, then update it in Nightlight (Cameras →
  edit camera).
- **Admin/caregiver account password**: sign in and change it (Account → Change password), or
  have an admin reset another account's.
- **JWT signing secret** (`.jwt_secret` in the data volume): deleting it and restarting the
  container generates a new one and signs everyone out, forcing a fresh login everywhere.
- **Notification-provider tokens** (Pushover, Firebase, Gotify, ntfy): regenerate/revoke the
  token or key at the provider and re-enter it in Settings → Push notifications.
- **MQTT broker credentials**: rotate on the broker and update the camera's MQTT settings.

## Scope

This policy covers the `nightlight` (this repo) and `nightlight-mobile` codebases and their
published Docker images. It does not cover third-party camera firmware, MediaMTX/FFmpeg
upstream, or notification-provider services themselves — report those to their own maintainers.
