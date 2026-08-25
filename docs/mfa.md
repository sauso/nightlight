# Two-factor authentication (TOTP)

Nightlight supports optional **time-based one-time password (TOTP)** two-factor auth — the standard
6-digit codes from an authenticator app (Google Authenticator, Authy, 1Password, etc.). It's
per-account and opt-in; password login is unchanged for anyone who doesn't turn it on.

TOTP works everywhere Nightlight does — LAN IP over http, a remote HTTPS domain, and inside the
Android/iOS app — because it needs no browser crypto. (Passkeys/WebAuthn, which *do* require HTTPS +
a domain, are a separate planned feature.)

## Turning it on

**Settings → Account → Two-factor authentication → Set up two-factor.**

1. Scan the QR code with an authenticator app, or type in the manual key.
2. Enter the current 6-digit code to confirm.
3. **Save the backup codes shown.** There are 10, each usable **once**, for signing in if you lose
   your authenticator. They're shown only at this moment and only their hashes are stored — Nightlight
   can't show them again.

At the next login you'll enter your password, then the 6-digit code. A backup code can be entered in
the same field instead of an app code.

## Turning it off

**Account → Two-factor authentication → Turn off two-factor**, confirmed with your password.

## Recovery

Lost your authenticator? Use a **backup code** at login. If you're also out of backup codes:

- **Any admin** can clear another user's two-factor: **Settings → Caregivers → (that user) → Reset
  two-factor**. Their next login is password-only, and they can set it up again.

- **Locked-out admin (no other admin to help): console failsafe.** Run the reset script against the
  running container over SSH/console. It edits the same database directly:

  ```sh
  # List who currently has two-factor enabled
  docker exec nightlight node src/scripts/reset-mfa.js --list

  # Turn two-factor off for one account
  docker exec nightlight node src/scripts/reset-mfa.js <username>

  # Turn it off for everyone (last resort)
  docker exec nightlight node src/scripts/reset-mfa.js --all
  ```

  The container keeps running (the database is opened in WAL mode, so the concurrent write is safe).
  The affected user can then sign in with just their password. Replace `nightlight` with
  `nightlight-dev` for the staging container.

## Optional: strengthening a pre-0.26.0 secret

Two-factor secrets created **before 0.26.0** were 80-bit. From 0.26.0 they're 160-bit, matching the
RFC 4226 recommendation of at least 128 bits.

**Nothing breaks if you do nothing** — an older secret keeps working exactly as before, and your
authenticator app needs no attention. If you'd like the stronger secret, re-enrol at your convenience:

1. **Account → Two-factor authentication → Turn off two-factor** (needs your password).
2. Turn it back on and scan the new QR code.

`GET /api/auth/me/mfa` reports `needs_reenrolment: true` for an account still on an older secret,
which is the quickest way to check.

## Notes for operators

- The TOTP secret and the (hashed) backup codes live in the `users` table of the app database
  (`babymonitor.db` in the data volume). Treat that database as sensitive, as you already should
  (it also holds password hashes).
- Verification tolerates ±30s of clock drift. If codes are consistently rejected, check the server's
  clock/timezone against the phone running the authenticator.
