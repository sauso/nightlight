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
   can't show them again. Because of that, this dialog can only be closed with its **I've saved them**
   button: tapping outside it or pressing Escape does nothing, and it has no ✕ (unlike Nightlight's other
   dialogs, so a stray tap can't throw the codes away). Use **Copy codes** to put them on the clipboard before you close it.

At the next login you'll enter your password, then the 6-digit code. A backup code can be entered in
the same field instead of an app code.

## Turning it off

**Account → Two-factor authentication → Turn off two-factor**, confirmed with your password.

A wrong password is refused with a message in the dialog (HTTP 400) and two-factor stays on. A wrong password
here does **not** sign you out (#697). A 401 means the sign-in itself is over, or a sign-in step failed (a
wrong password or code on the sign-in screen).

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

## Related: no admin account left at all

A different, rarer failsafe for a different problem — there must always be at least one admin (see
"Adding caregivers" in the README), and the app itself refuses any change that would leave zero. But
an install that got into that state before that protection existed, or one whose database was edited
by hand, has no admin to sign in as and no admin route it can reach to fix itself — and first-run
setup (`/setup`) refuses to run again once any user exists.

The console failsafe is the same shape as the two-factor one above, over SSH/console against the
running container:

```sh
# List every account and its role
docker exec nightlight node src/scripts/promote-admin.js

# Make one account an admin
docker exec nightlight node src/scripts/promote-admin.js <username>

# Same, if <username> itself starts with "-" (e.g. an account literally named "-h")
docker exec nightlight node src/scripts/promote-admin.js -- <username>
```

It never picks an account on its own — there is no "promote whoever was created first" option — an
operator has to name the specific account being trusted with admin.

## Optional: strengthening a pre-0.26.0 secret

Two-factor secrets created **before 0.26.0** were 80-bit. From 0.26.0 they're 160-bit, matching the
RFC 4226 recommendation of at least 128 bits.

**Nothing breaks if you do nothing** — an older secret keeps working exactly as before, and your
authenticator app needs no attention. If you'd like the stronger secret, re-enrol at your convenience:

1. **Account → Two-factor authentication → Turn off two-factor** (needs your password).
2. Turn it back on and scan the new QR code.

`GET /api/auth/me/mfa` reports `needs_reenrolment: true` for an account still on an older secret,
which is the quickest way to check.

## Replayed codes, and limits on guessing (#550)

| | Authenticator code | Backup code |
|---|---|---|
| Can be used again | **No.** Each code works **once**: the server remembers the newest 30-second step it has accepted for the account and refuses any code from that step or an earlier one. A code that was shown a moment ago cannot be re-used, and neither can one copied from over a shoulder or out of a log. | **No.** Consumed on use (unchanged). |
| What a refused repeat looks like | The same **"Incorrect code"** (HTTP 401) as a wrong code, so a refusal does not reveal that the code was once valid. | Same. |
| Counts toward the guess limits | Yes | Yes |

Practical effect: if you sign in, sign out and want to sign in again within the same 30 seconds, wait for
the app to show the **next** code. Codes from an earlier step than the one last used are refused too
(the 30-second tolerance for clock drift still applies to the first use of a code).

The second step is limited in three ways, and a request has to pass all of them:

| Limit | Default | Counted per | Why |
|---|---|---|---|
| Per source and account | 20 per 15 minutes | source address + account | Stops one device guessing at one account. Unchanged. |
| Per source | 100 per 15 minutes | source address, all accounts | Stops one device spraying many accounts. Unchanged. |
| **Per user (new)** | **30 failed attempts per 15 minutes** | the account alone, whatever the source address | A guesser who spreads attempts over many addresses gets a fresh budget at each address from the two limits above; this one adds them up. **Only failed attempts count**, so signing in correctly never spends it. 30 sits above the per-source 20, so one device always hits its own limit first and this only ever stops a **distributed** guesser. |

Over the limit, the answer is the usual "Too many attempts - please wait a few minutes and try again."
(HTTP 429). The per-user count only starts from a sign-in token the server itself issued after the
password was accepted; a made-up token is counted against its source address and cannot be used to run
down someone else's budget.

**Known limit:** someone who already has the password can still use up the per-user budget from many
addresses and so block that person's second step for the rest of the 15 minutes (backup codes share the
budget). They have beaten the first factor already; the alternative, no per-account limit, left the
6-digit code open to a guesser with many addresses. Waiting 15 minutes, or an admin resetting
two-factor, clears it. The limits are held in memory, so a restart of the container also clears them.
There are no settings to change these numbers.

Starting a new set-up, turning two-factor off, or an admin or console reset clears the remembered step,
so a new authenticator's first code is never refused because of an old one.

## Notes for operators

- The TOTP secret and the (hashed) backup codes live in the `users` table of the app database
  (`babymonitor.db` in the data volume). Treat that database as sensitive, as you already should
  (it also holds password hashes).
- Verification tolerates ±30s of clock drift. If codes are consistently rejected, check the server's
  clock/timezone against the phone running the authenticator.
