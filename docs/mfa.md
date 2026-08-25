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

## One-off: re-enrolling after the 0.26.0 upgrade

Two-factor secrets created **before 0.26.0** were 80-bit. The OTP library was upgraded to a version
that enforces the RFC 4226 minimum of 128 bits, and it refuses shorter secrets outright — so an
authenticator enrolled before that upgrade will keep displaying codes that can never be accepted.

If that's you, the app says so at login rather than reporting a wrong code. To fix it:

1. Sign in with one of your **backup codes**.
2. **Account → Two-factor authentication → Turn off two-factor** (needs your password).
3. Turn it back on and scan the new QR code.

Out of backup codes as well? Use the recovery routes above — an admin reset, or the console failsafe.
This is a one-time step; secrets created from 0.26.0 onward are 160-bit and unaffected.

## Notes for operators

- The TOTP secret and the (hashed) backup codes live in the `users` table of the app database
  (`babymonitor.db` in the data volume). Treat that database as sensitive, as you already should
  (it also holds password hashes).
- Verification tolerates ±30s of clock drift. If codes are consistently rejected, check the server's
  clock/timezone against the phone running the authenticator.
- `GET /api/auth/me/mfa` returns `needs_reenrolment: true` for an account still on a pre-0.26.0
  secret, which is the quickest way to check without attempting a login.
