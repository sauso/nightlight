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
| **Continue set-up** | Asks for your **account password**, then shows the **same** QR code and key again. The entry already in your authenticator keeps working; just enter its code. If the set-up was discarded meanwhile (an admin reset two-factor, or your password was changed on another device), the panel says "There was no set-up to continue, so this is a new key": add that one and delete the old entry. |
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
  over, a reset, or another set-up started at the same moment), you get "Two-factor is already on…" or "The set-up was changed meanwhile, on this or
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
"Adding caregivers" in the [full reference](caregivers.md)), and the app itself refuses any change that would leave zero. But
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

### Confirming a set-up has limits of its own

Entering the 6-digit code that confirms a new set-up (**Turn on** in the set-up dialog,
`POST /api/auth/me/mfa/enable`) is limited separately from everything above, and **only wrong codes count**:

| Limit | Value | Counted per | What happens |
|---|---|---|---|
| Wrong codes against one pending set-up | **10** | the account and that set-up's key | The 10th wrong code **cancels the set-up**: the key is discarded, and the answer (HTTP 400) is "Too many wrong codes, so this set-up was cancelled. Choose Continue set-up or Start over to get a new key (also check your phone's clock)." Both buttons ask for your password and now make a **new** key (after a reload the card shows **Set up two-factor** instead); delete the old entry from your authenticator. **Continue set-up** on a key that is still pending does **not** start the count again; **Start over** (a new key) does. |
| Wrong codes per account | **30 per 15 minutes** | the account alone, whatever the source address | Over it, every confirmation is refused (HTTP 429, "Too many attempts - please wait a few minutes and try again."), even one with the right code, until the 15 minutes are up or the password is changed. |

What does **not** count: a correct code, and a refusal that needed no guess ("Start setup first." when nothing is
pending, "Two-factor is already on.").

**Why.** The confirmation route takes a signed-in session but not the password, so it limits wrong codes, like
the other confirmation routes. Every set-up asks for the password, so after a cancel a device without it cannot
start another one: it gets at most 10 guesses at any one key, odds of about 10 × 3 / 1,000,000 = **0.003%**. The 10
bounds the guesses per key; the 30 bounds them across keys, because each time you start over such a device gets 10
more against the new key, so it is held to 30 per 15 minutes in all (and so is someone who has the password and
starts over every 9 wrong codes). Both numbers are judgements, not measurements: 10 is far more wrong codes than a
typo or a phone clock that is off costs a real person before they start over, and 30 matches the per-user limit on
the sign-in second step.

How this differs from the routes beside it:

| | Confirming a set-up (**Turn on**) | Set-up, turning two-factor off, changing your password | Sign-in second step |
|---|---|---|---|
| What counts | wrong codes only | every attempt | every attempt, except the per-user limit, which counts failed attempts only |
| Per source address | **no limit** | 20 per 15 minutes per source and account (one budget shared by the three), and 100 per source | 20 per 15 minutes per source and account, and 100 per source |
| Per account, any source | 30 wrong codes per 15 minutes | 30 wrong passwords, then a growing wait ([Password guesses](#password-guesses-553)) | 30 failed attempts per 15 minutes |
| A key that gets too many wrong codes | the set-up is cancelled at 10 | not applicable | nothing is cancelled |

The per-account count here is **separate** from the sign-in second step's: wrong codes while setting up never count
against your first sign-in with the new authenticator. No limit on this route is keyed on an address, so people
behind one proxy address share nothing here: each account has its own count. There are no settings for these
numbers.

**Known limits:**

- A device that is signed in to your account without the password can **cancel your pending set-up** (10 wrong
  codes) each time you start over, and across those start-overs use up the 30, after which even the right code is
  refused (HTTP 429) for the rest of the 15 minutes. It blocks nothing else. **Change your password**: that empties the count at once, and the same step discards the pending set-up
  and signs every other device out; then set up again. An admin setting a new password for you does the same.
  Signing that device out (**Account → Signed in on → Sign out** beside it) stops it, but does **not** empty the
  count: the right code is still refused until the 15 minutes are up.
- The per-account limit counts a confirmation when it arrives and gives it back when it is answered, so 30
  confirmations in progress **at the same moment** (even ones that will not count) can make a right code that
  arrives among them a 429 for that moment; it clears as soon as they have been answered.
- The counts are kept in memory, so a **restart of the container resets them** (as it resets every limit on this
  page). An admin resetting two-factor for the account also empties them, as it discards the pending set-up.

## Password guesses (#553)

Signing in, changing your password, and turning two-factor on or off all ask for a password. As well as the
per-address limits above, each of them is now limited **per account**, whatever address a request claims to
come from. Without that, a program running inside the container that can reach Nightlight on `127.0.0.1` could
name a different address in every request (see `TRUST_PROXY` in [remote access](remote-access.md)) and guess
without limit.

| What | Default | Counted per | What happens |
|---|---|---|---|
| Wrong passwords | **30**, then a growing wait | the account alone, whatever the source address | After 30 wrong passwords, the next guess has to wait **1 minute**. Each further wrong guess doubles the wait, up to **15 minutes**. While a wait runs, every attempt on that account, **even with the right password**, is refused (HTTP 429, "Too many attempts - please wait a few minutes and try again.", with a `Retry-After` header). A refused attempt counts as nothing, so trying again does not lengthen the wait. |
| Forgiven | **one wrong password per 15 minutes** | the account | Each 15 minutes without a wrong password forgives one, so old typos fade and there is no moment to wait for that hands back a whole fresh 30. Whatever the pacing, a guesser gets the first 30 and then at most **one guess per 15 minutes**: about 126 in the first day, about 96 a day after. A correct password resets the count at once. An account with 30 on record is back to none after about 7½ hours. |

30 sits above the per-address limit (20 per 15 minutes), so one device mistyping meets its own limit first. To
reach 30 you would need a long run of wrong passwords (more than one 15-minute window, or two devices at once),
so an ordinary mistyped password does not get there. This is aimed at a guesser who spreads attempts over many, or
made-up, addresses.

- **Sign-in** is counted by the username exactly as typed, which is how the account is looked up (sign-in is
  case-sensitive). A name that does not exist is counted and answered exactly like one that does, so the
  answer never says which names are real. A retyped name such as `Alice` for `alice` reaches no account, so it
  neither spends nor refills `alice`'s guesses.
- **Signed in, asked for your current password** (change password, set up two-factor, turn two-factor off):
  one count for the three together, per account. It is separate from the sign-in count, and signing in does
  **not** reset it, so a signed-in device cannot refill its own guesses by signing in again.
- **The sign-in second step** (the 6-digit code) has its own per-account limit, described above.
- There are no settings for these numbers. They are judgements for a household, not measurements.

**The trade-off, on purpose:** anyone who can reach your sign-in page can use up an account's 30 guesses and so
**slow that person's own sign-in**, and can do it again each time the wait ends, so the slowdown lasts as long
as they keep at it. They cannot guess any faster. Ways out:

- Wait. The wait never exceeds 15 minutes.
- **Change the password** from a device that is still signed in (**Account**), or ask an admin
  (**Settings → Caregivers**). That empties the count at once.
- Restart the container. The counts are kept in memory, so a restart resets them (as it resets every limit on
  this page).

**Known limits:**

- Real accounts always have their own count, and nothing sent to the sign-in page can refuse, evict or reset it.
  Made-up usernames (which match no account) are tracked in a separate table of at most 10,000, so that a
  made-up name is slowed like a real one and the answer does not say which names exist. That cannot be perfect
  at a fixed amount of memory: an attacker who sends about **10,000 requests with fresh made-up names** can push
  a made-up name's count out of that table (a real account's count stays), and so test whether one name is real.
  Usernames are not treated as secret here, and each such test costs the attacker those 10,000 requests.
- Sign-in is looked up by the exact name, so two accounts whose names differ only by capital letters are two
  accounts with separate counts.

## Notes for operators

- The TOTP secret and the (hashed) backup codes live in the `users` table of the app database
  (`babymonitor.db` in the data volume). Treat that database as sensitive, as you already should
  (it also holds password hashes).
- Verification tolerates ±30s of clock drift. If codes are consistently rejected, check the server's
  clock/timezone against the phone running the authenticator.
