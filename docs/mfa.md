# Two-factor authentication (TOTP)

Nightlight supports optional **time-based one-time password (TOTP)** two-factor auth — the standard
6-digit codes from an authenticator app (Google Authenticator, Authy, 1Password, etc.). It's
per-account and opt-in; password login is unchanged for anyone who doesn't turn it on.

TOTP works everywhere Nightlight does — LAN IP over http, a remote HTTPS domain, and inside the
Android/iOS app — because it needs no browser crypto. (Passkeys/WebAuthn, which *do* require HTTPS +
a domain, are a separate planned feature.)

## Turning it on

**Settings → Account → Two-factor authentication → Set up two-factor.**

1. Enter your **account password** (see "Why every set-up asks for your password" below).
2. Scan the QR code with an authenticator app, or type in the manual key.
3. Enter the current 6-digit code to confirm.
4. **Save the backup codes shown.** There are 10, each usable **once**, for signing in if you lose
   your authenticator. They're shown only at this moment and only their hashes are stored — Nightlight
   can't show them again. Because of that, this dialog can only be closed with its **I've saved them**
   button: tapping outside it or pressing Escape does nothing, and it has no ✕ (unlike Nightlight's other
   dialogs, so a stray tap can't throw the codes away). Use **Copy codes** to put them on the clipboard before you close it.

### Setting up on a phone

On a phone the authenticator is on the same device as the page, so you switch apps in the middle of set-up.

- **The page stays on the setup screen while you switch apps.** Normally Nightlight reloads itself when you
  come back after more than 15 seconds away; while the set-up dialog is open it does not, so the key and the
  code you were typing are still there. (Closing the dialog, confirming, or leaving the page lifts this.)
- On a touch screen in the browser, **Open in your authenticator app** under the QR code hands the key to the
  authenticator directly. It is not shown inside the Android/iOS app.
- If the page is reloaded anyway (the browser discarded the tab, or you reloaded it), set-up is still
  **pending** on the server and the card shows two buttons:

| Button | What it does |
|---|---|
| **Continue set-up** | Asks for your **account password**, then shows the **same** QR code and key again. The entry already in your authenticator keeps working; just enter its code. |
| **Start over** | Asks for your **account password**, then makes a **new** key. The entry you already added stops matching, so delete it from your authenticator and add the new one. |

**Why every set-up asks for your password.** **Set up two-factor**, **Continue set-up** and **Start over**
all ask for it first. Because a set-up can now be continued, any device signed in to your account (a
borrowed, unlocked phone, a browser you forgot to sign out of) could otherwise either *read* your pending key
or *plant* one it knows (by starting or restarting a set-up, so that your next **Continue set-up** shows its
key and you confirm it). Either way that device could later make valid codes for your second factor.
Turning two-factor off asks for the password for the same reason. A wrong password is shown beside the field
(HTTP 400, `Password is incorrect`); it does **not** sign you out, and no key is in the answer. Set-up
attempts count against the same limit as changing your password and turning two-factor off: **20 per 15
minutes per source address and account** (and the per-source 100), shared by all three.

For API clients: `POST /api/auth/me/mfa/setup` now needs `{ "password": "…" }` in the body (with
`"restart": true` added for a start-over). Without it the answer is 400 `Password is incorrect`, where it used
to start a set-up.

A pending set-up has no expiry: it stays until you finish it, start over, turn two-factor off, **change your
password** (or an admin sets a new one for you), or an admin (or the console reset script, `--all`
included) resets two-factor; each of these discards it. A password change discards it because it is what
you do when a signed-in device is lost, and that device may have seen the key; start the set-up again
afterwards. A password change never touches two-factor that is already **on**. Asking to set up again never
replaces the pending key unless you choose **Start over**. Pending is not on: sign-in still asks only for the
password until a code is confirmed.

Two less common cases:

- A set-up left pending by a version **before 0.26.0** holds an older, weaker (80-bit) key. It is not
  offered for continuing: the card shows **Set up two-factor**, which makes a new 160-bit key.
- If the set-up changes on another device while yours is being prepared (two-factor switched on, a start
  over, a reset), you get "Two-factor is already on…" or "The set-up was changed meanwhile, on this or
  another device. Try again." instead of a key that would no longer work, and a key that is already on is
  never replaced.

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
2. Turn it back on (your password again) and scan the new QR code.

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

What the per-user limit leaves a distributed guesser: 30 guesses per 15 minutes against a 6-digit code
that is valid in three 30-second steps at once, so odds of about 30 × 3 / 1,000,000 = **0.009% per
window**, which over a day (96 windows, 2,880 guesses) is about **0.86%**.

**Known limit:** someone who already has the password can use up the per-user budget from many
addresses and so block that person's second step (backup codes share the budget), and they can do it
again in every 15-minute window, so the block lasts **for as long as they keep doing it**. Waiting does
not end it. **Changing the password does**: without it no new sign-in token can be obtained, and the
budget comes back when its 15 minutes are up (a sign-in token already issued stays usable for up to 5
minutes). The password can be changed from a device that is still signed in (Account) or by an admin
(Settings → Caregivers). An admin resetting two-factor for the account also empties the budget at once,
and so does a restart of the container (the limits are held in memory); neither stops someone who still
has the password from using it up again. ⚠️ **Never reset two-factor on its own in this situation:** a
reset turns two-factor **off**, so someone who has the password could then sign in with the password
alone and set up their own authenticator. Reset it only together with a password change, and change the
password first; then reset two-factor if it is still needed. The console reset script (`reset-mfa.js`) runs
in its own process and does not clear the budget. They have beaten the first factor already; the alternative, no
per-account limit, left the 6-digit code open to a guesser with many addresses. There are no settings to
change these numbers.

Starting a new set-up, turning two-factor off, or an admin or console reset clears the remembered step,
so a new authenticator's first code is never refused because of an old one.

## Notes for operators

- The TOTP secret and the (hashed) backup codes live in the `users` table of the app database
  (`babymonitor.db` in the data volume). Treat that database as sensitive, as you already should
  (it also holds password hashes).
- Verification tolerates ±30s of clock drift. If codes are consistently rejected, check the server's
  clock/timezone against the phone running the authenticator.
