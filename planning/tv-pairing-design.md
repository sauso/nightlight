# Signing in a TV by code and QR: design (phase 2 of the Android TV app)

Status: **DESIGN v3, not built.** Written 2026-11-28 for issue #1237 (phase 2), revised twice the same day: after a first read-only
review by Codex, and after a second by Codex and an Opus agent in parallel (both logged in §14). The owner decided §12 (all six as
recommended). No code is written until the owner says go. The Connect and Discovery architecture document (§8.5, not in this repo)
parked "sign-in by scanning a code" because "it is an authentication bypass if done carelessly" and "needs its own design and
full-rigor review". This is that design.

Words: **"view-only" here means watch and listen.** The TV plays the room's video **and audio**; it cannot change anything or read
anything else.

Who reads this: the owner (the decisions in §12), and the build reviewers (to attack §3 to §9).

## 1. Goal and non-goals

**Goal.** A TV (the Android TV screen, `/tv`) gets a signed-in session **without anybody typing a password on the TV**. The TV
shows a short code and a QR code; a person already signed in to Nightlight on their phone or computer approves it; the TV
then shows the cameras.

**Not goals.**
- Not "sign in on a phone by scanning" (the reverse direction of §8.5 of the Connect document). Not passwordless login in general.
- The password form stays, but a password typed on a TV also gets a **view-only** TV session (§6.3), never an ordinary one.
- The QR carries **no secret**. It carries a short, single-purpose, expiring, non-credential code (§4.2).
- No new account type. The TV signs in **as the person who approved it**, with fewer powers (§6).

## 2. The flow (device-code flow, after RFC 8628)

```
TV (not signed in)                          Server                         Phone / browser (signed in)
 |  POST /api/auth/device/start  ---------->|                                      |
 |  { label }                               | creates a pending pairing            |
 |<-----  device_code (secret, TV only),    |                                      |
 |        user_code, expires_in, interval   |                                      |
 |  shows: QR + "BCDF-GHJK"                 |                                      |
 |                                          |<--- POST /api/auth/device/pending { user_code }
 |                                          |       (shows label and time)          |
 |                                          |<--- POST /api/auth/device/approve { user_code }
 |  POST /api/auth/device/poll ------------>|       (or /deny)  the approver TYPED the code
 |   { device_code }   (every `interval`)   | approved? re-check the approver AND     |
 |<----- pending | denied | expired |       | the approving session, create the      |
 |       approved + session token           | session, return it ONCE                |
 |  stores the token like a login; opens /tv|                                      |
```

Two ways to give the phone the code:
- **QR.** `<origin>/#/pair`, where `<origin>` is the address the TV itself uses for the server. **The QR carries no code at all**
  (nothing reads one: pre-filling is forbidden, §3 row 1). It only **opens the approval page**; the approver must **type the code**
  shown on the TV. Works when the phone can reach that address (same Wi-Fi, or the same tailnet). A **signed-out** phone does not
  get a sign-in form on that page (the TV chose the address, and a relayed QR must not teach people to type a password into
  whatever it opens): it says "Open Nightlight at your usual address, sign in, then Settings, Connect a TV".
- **Typed.** Settings → **Connect a TV** on the phone's own, already-working Nightlight address, then type the code. This is the
  path for a phone on cellular, for a TV that was set up with a LAN address the phone cannot reach, and for a person who cannot scan.
  The TV screen says so in one line under the QR.

The TV also offers "Sign in with a password instead", which opens the existing form (and still yields a view-only session, §6.3).

## 3. What an attacker can try, and the answer to each

| # | Attack | Answer |
|---|---|---|
| 1 | **Relay / phishing.** The attacker starts a pairing on their own device and gets a victim (signed in) to approve the attacker's code. The attacker's device is then signed in as the victim. | This is the real risk of every device-code flow, so it gets the most weight: (a) the TV session is **view-only** (§6), so the blast radius is "can watch the cameras", not "can change settings, read history or remove users"; (b) **the approver must always type the full code**, never just tap (a QR or link only opens the page; nothing is pre-filled into the approval), so approving means reading a code from a screen and entering it, which is the deliberate step a relayed link does not give; (c) the approval page shows what is being approved (the label the device sent and when), and says "Only approve if the code matches the one on your TV"; (d) there is **no "same network" signal**: the address bucket (`clientBucketKey`) is not a network (two LAN devices have different buckets; a reverse proxy without `TRUST_PROXY` shares one for everybody; Tailscale peers are bucketed by account slot), so it could say "different" at home and "same" for a remote attacker. Address information is never shown as a safety signal; (e) the session is listed under Sessions as a TV, shows **where it was paired from** and is revocable (§8); (f) no admin notice in v1 (§12.5), but approve and claim each write an **audit log line** (§8); (g) the label is attacker-controlled, so the approval page shows it **in quotes, next to the TV's own browser/device string** (`describeDevice` of the start request's user agent), with control and bidi characters stripped, so a laptop calling itself "Living room TV" is visible as a laptop. Documented as a known limit. |
| 2 | **Guess a `user_code`** to approve someone's pending TV into the attacker's own account (a signed-in caregiver). | The code only works for a **signed-in** approver; 20 symbols x 8 characters = about 34 bits; a bounded number of pending pairings (§3 row 6); a failures-only limiter per user and per client (§5). Effect if it ever succeeded: the victim's TV shows the **attacker's** (view-only) session, which the attacker could already watch. Low value, not zero, so it is limited anyway. |
| 3 | **Steal the `device_code`** to collect the session. | 256-bit random, held only by the TV in memory until claimed, sent only in a POST **body** (never a URL, never a log), stored **hashed** (sha256, as invites). The QR and the screen show only the `user_code`, which is not a credential. |
| 4 | **Poll with a guessed `device_code`.** | 256 bits: not guessable. Unknown, expired and consumed codes answer the same `expired`. A per-client limiter anyway. |
| 5 | **Collect the session twice** (replay, or a double poll). | Claim is a compare-and-swap that must change exactly one row, inside one synchronous transaction with the approver check and the session insert (§4.4), then the row is deleted. The token is delivered once. A lost response means the TV pairs again (§12.4). |
| 6 | **Flood `/device/start`** (no authentication on it) to fill the database or to deny the owner a slot. | Per-client limit on starts, keyed on the **socket address** (`clientKey`) exactly as `inviteLimiter` is (#961: `clientBucketKey` trusts a header a local process can forge), with its own `MemoryStore` and budget so junk does not use the login budget. **Only live rows count toward any cap**: a row is live while `expires_at > now` and `denied_at IS NULL`; every `start` first **deletes the expired and denied rows** in its own transaction (a daily sweeper is far too slow for a 10-minute cap; the sweeper beside `purgeOldInvites` stays only as a backstop). **At most 3 live rows per client bucket** (`clientBucketKey`) inside a **global cap of 20**. At its own bucket cap a start **evicts that bucket's oldest unapproved row** (so a TV that reloaded and orphaned a row, or two TVs, recover by themselves); at the global cap a start from a bucket with no live row **evicts the oldest unapproved row of the fullest bucket** instead of answering 429. Approved-but-unclaimed rows count toward the global 20 and are never evicted (they last at most 10 minutes). Many buckets can still lock the owner out, and **behind a reverse proxy without `TRUST_PROXY` every remote client shares one bucket**, so one internet client can keep remote pairing busy: remote TVs need `TRUST_PROXY` (§13). A handler-side clamp (no per-route body parser: the app-level `express.json()` has already read the body): `label` is at most 40 characters of plain text. |
| 7 | **Approve as a disabled, removed or demoted user**, or **approve and then be logged out, revoked or have the password changed**. | The approve route is `requireAuth`, so a disabled approver is already refused. The pairing stores **`approved_by_session`** (the approving session's id). At **claim** the guarantee is **`isLiveSessionId(approved_by_session)`** (it already requires the session row to exist, the account to exist and `disabled = 0`) plus `password_set = 1`, read inside the claim transaction, so there is no `await` between the check and `createSession` (the same shape as `/login/mfa` after #1233). A logout, a revoke, a disable, a removal, or a password change **made from another session** (which delete sessions today) therefore cancel an approved pairing without a hook in each path. **Exception, stated:** a self-service password change and an admin resetting their own password **keep the requesting session** (`PUT /me/password`, `PUT /users/:id`), so an approval given by that session survives it. The disable transaction also deletes the user's pairings, and `user_id` has `ON DELETE CASCADE`. |
| 8 | **A stolen TV session** (TV resold, local malware). | View-only allowlist (§6); revocable (§8); it dies with the account (disable and remove already delete sessions); standard lifetime (§7). Restoring a database backup revives its sessions (§13). |
| 9 | **MFA bypass.** | Pairing mints a session only from an **already signed-in** session. A session created **before** MFA was turned on never passed it (`/me/mfa/enable` signs nobody out), so the claim is only "as strong as the approving session"; stated in §13. No password or code is ever typed on the TV for this path. The password fallback keeps its existing MFA step (§6.3). There is no step-up concept in the app today (§12.2). |
| 10 | **Cross-site request forgery on approve.** | The API takes the `Authorization: Bearer` header from `localStorage`, not a cookie, so a foreign page cannot ride the session. The approve call needs the typed code in its body. |
| 11 | **Enumeration.** | `/device/start` reveals nothing about accounts. `/device/pending` and `/approve` answer an unknown or expired `user_code` with one uniform 404 `pair_invalid`. |
| 12 | **Secrets in logs.** | `device_code` and the session token are never logged. The `user_code` may be (it is not a credential). The QR fragment never reaches the server. |
| 13 | **The TV session reaching a clip, a snapshot, the talk-back microphone or another admin-only response.** | §6: deny by default for every Express guard, an explicit rejection in the WebSocket handshake, the **effective role is `caregiver`** even for an admin approver, and response projections are tested (§6.4). |
| 14 | **A paired TV outlives the session that approved it.** Someone with an unlocked phone, or a stolen caregiver token, types their own code and gets up to 30 days of watching and listening that "Sign out this device" on the stolen phone would not end (every other thing a caregiver session can do ends with that session). | The design accepts the decision (any signed-in user, no re-authentication) and **narrows the consequence**: (a) the TV session row stores **`paired_by_session`** and **`paired_from`** (the approving device, as text); **revoking a session also ends the TV sessions it paired** (`DELETE /sessions/:id`; a plain logout of the pairing session does not, so signing out a phone does not kill the living-room TV); (b) the Sessions screen shows "Connected from Chrome on Android, 28 Nov 21:14" on the TV row; (c) approve and claim write one audit log line each (§8); (d) **at most 5 live TV sessions per user** (approve answers 409 `tv_limit` beyond it). Still stated in §13: a stolen session can pair a TV that lives on until someone revokes the TV row, the pairing session, or changes the password from another session. |

## 4. Data

### 4.1 One new table, `tv_pairings` (hand-written, idempotent, inside the existing transaction in `db.js`)

| column | notes |
|---|---|
| `id` | uuid |
| `device_hash` | `sha256(device_code)` hex, `UNIQUE`. The code itself is never stored. |
| `user_code` | the displayed code, upper case without the dash, `UNIQUE`. Not a secret (it needs a signed-in approver who types it). |
| `label` | what the TV called itself, clamped, shown as **text only** (never HTML). Untrusted. |
| `client_bucket` | `clientBucketKey(req)` at start, for the per-bucket cap only. Never shown. |
| `device` | `describeDevice(user-agent)` of the start request: shown beside the label on the approval page (§3 row 1 g). |
| `last_poll_at` | the `slow_down` state lives **in the row**, not in a `Map` keyed by whatever `device_hash` a client sends. |
| `created_at`, `expires_at` | UTC text like the rest (`utcText`), 10 minutes. |
| `user_id` | `NULL` until approved; `REFERENCES users(id) ON DELETE CASCADE`. |
| `approved_by_session` | the session id that approved (no FK: sessions are deleted by several paths; the claim checks it is still live). |
| `approved_from` | `describeDevice` of the approving request, copied onto the TV session as `paired_from`. |
| `approved_at`, `denied_at` | the state machine: pending, approved, denied, expired. **Claimed is not a column**: the claim deletes the row in the same transaction, so a `claimed_at` would never be observable and the delete is the single-use guard. |

`secrets-never-returned.test.js` plants a marker in `device_hash` (it reads the schema) and asks every GET route for it, as it does
for `user_invites.token_hash`.

### 4.2 Codes

- `device_code`: `randomBytes(32).toString('base64url')` (43 characters), as invites.
- `user_code`: 8 characters from the 20 symbols `BCDFGHJKMNPQRSTVWXYZ` (no vowels, so no words; no digits and no `L`, so no `0/O/1/I/L`
  confusion), drawn with rejection sampling from `crypto.randomInt`, shown `BCDF-GHJK`, accepted in any case and with or without the
  dash (normalised to upper case without the dash before any lookup or storage, so `bcdf ghjk` and `BCDFGHJK` are one code).
- Expiry **10 minutes**; the TV shows a countdown and starts a new pairing on its own when it ends (a new `device_code`, a new `user_code`).
- `interval` 3 seconds. A poll faster than 2 seconds after `last_poll_at` answers `slow_down` (RFC 8628's rule), so a stuck TV cannot
  hammer the server. **The TV client obeys it**: on `slow_down` it adds 5 seconds to its interval for the rest of that pairing, and on
  a network error or a limiter 429 it backs off the same way, never faster than `interval`. A legitimate TV makes about 200 polls
  in ten minutes, so the poll limiter's budget is **600 per 10 minutes per client key** (room for three TVs behind one address; a
  chosen number, not a measured one).

### 4.3 Sessions get two columns

`sessions.kind TEXT NOT NULL DEFAULT 'user'`, `sessions.label TEXT`, `sessions.paired_by_session TEXT` and `sessions.paired_from TEXT`
(guarded `ALTER TABLE`s, sentinel on the last column; no `user_version`). Existing rows stay `'user'`.
`createSession(userId, userAgent, { kind, label, pairedBySession, pairedFrom })`; every existing caller is unchanged.
`toPublicSession` gains `kind`, `label` and `paired_from` (additive only: an old client ignores them).

**A TV signed in with a password today has an ordinary session** (phase 1 had no other way), which stays until it expires or is
revoked: after this ships, sign the TV out once (CHANGELOG and `docs/mobile.md` say so).

### 4.4 The state machine, and why it cannot be raced

better-sqlite3 transactions are synchronous, so each transition is one transaction with one guarded `UPDATE` that must change exactly
one row:

| Transition | Guard (all in the `WHERE`) |
|---|---|
| approve | `approved_at IS NULL AND denied_at IS NULL AND expires_at > now`, sets `user_id`, `approved_by_session`, `approved_from`, `approved_at` |
| deny | the same guard, sets `denied_at` |
| claim | `DELETE ... WHERE approved_at IS NOT NULL AND denied_at IS NULL AND expires_at > now` must remove exactly one row |

Approve and deny are therefore mutually exclusive (whichever commits first wins; the other changes zero rows and answers the uniform
404). The claim transaction is: the guarded `DELETE` (1 row, which is also the single-use guard), `isLiveSessionId(approved_by_session)`
and `password_set = 1` on the approver, the live-TV-session cap, then `createSession(..., { kind: 'tv', label, pairedBySession,
pairedFrom })`. Expiry and "now" use the **JavaScript clock** (`utcText(Date.now())`, as invites do), read inside the transaction;
SQLite's `datetime('now')` is not used (a clock rollback can make an expired row eligible again: stated in §13, tested).

**A refused claim** (the approving session or account is gone, or the TV cap is hit) rolls the transaction back and then, in a
**separate committed write**, marks the row `denied_at`, so the TV is told `denied` at once and not "pending" for ten minutes
while the approver was told "Your TV is connected". Everything else throws and rolls back; the row expires on its own.

## 5. Endpoints (all new; `route-permissions.test.js` gets a row for each)

| Route | Gate | Notes |
|---|---|---|
| `POST /api/auth/device/start` | PUBLIC, own limiter | `{ label? }` -> `{ device_code, user_code, expires_in, interval }`. Caps as §3 row 6. |
| `POST /api/auth/device/poll` | PUBLIC, own limiter | `{ device_code }`. **Always HTTP 200** for every pairing answer: `{ status: 'pending' }`, `{ status: 'slow_down' }`, `denied`, `expired`, or `{ status: 'approved', token, user }`. Never a 401 (`api.js` turns a 401 into a redirect to `#/login`, which would pull the TV off the pairing screen); the limiter's own 429 is the only error. `user` is the `/login` shape with the **effective** role (`caregiver`) and `kind: 'tv'`. |
| `POST /api/auth/device/pending` | SIGNED_IN | `{ user_code }` in the **body** (a code in a URL is logged by proxies; `/invite/check` does the same) -> `{ label, device, created_at }` for the approval page. Failure-only limiter per user. A TV session is refused (§6). |
| `POST /api/auth/device/approve` | SIGNED_IN | `{ user_code }` typed by the approver. Guarded `UPDATE` as §4.4; 409 `tv_limit` past 5 live TV sessions. |
| `POST /api/auth/device/deny` | SIGNED_IN | `{ user_code }`. |

- Limiters copy the `inviteLimiter` shape (`MemoryStore` of their own, keys from `clientKey`/`ipKeyGenerator`,
  `skipSuccessfulRequests` where it is about failures), with the same stated limit: they are **in memory** (a restart empties them)
  and behind a reverse proxy without `TRUST_PROXY` everyone shares one client key. The login limiters' limits are written in
  `docs/mfa.md` and `docs/remote-access.md` (not `operations.md`); this adds a line there.
- The demo (`demoMode`) blocks all four POSTs automatically; `pending` is also a POST, so no GET blocklist entry is needed.
- `device/start` records the bucket with `clientBucketKey`, so the Tailscale loopback case is handled the way login handles it; the
  limiter itself keys on the socket address (§3 row 6).

## 6. The view-only session

**Why.** A TV is a shared, always-on, hard-to-lock device. Whatever signs in on it should be able to do the one thing it is for.

### 6.1 The Express guards

`sessionWithUser` already joins `sessions` to `users` and reads `role` live (issue #261). It selects `s.kind` and **forces the effective
role there**: `CASE WHEN s.kind = 'tv' THEN 'caregiver' ELSE u.role END`. Every consumer of a session reads it through that one
function (`requireAuth`, `requireAuthQueryOrHeader`, `verifyToken`, and with it `optionalAuth`, the talk socket and the Tailscale
re-verify), so an admin approver's TV session is a caregiver **everywhere**, not only on the two Express guards (the first draft put the
override on the guards and left `GET /api/settings` and `/api/auth/me` returning the admin's real role). `/api/auth/me` and the poll
answer return that effective role and `kind: 'tv'`, so the frontend's `user.role` gates do not show a TV admin screens.
`requireAuth` and `requireAuthQueryOrHeader` put `kind` on `req.user` and, **after** the session is found:
`if (kind === 'tv' && !tvAllowed(req)) return 403 { code: 'TV_SESSION_RESTRICTED' }`. No `kind` claim is put in the JWT and none is
trusted; it is read from the row, like the role.

`tvAllowed(req)` is **an allowlist of exact method plus exact path**. The path is the **path part of `originalUrl`** (the query string
cut off), **not `req.baseUrl + req.path`**: on a router-root route Express gives `baseUrl = /api/cameras` and `path = /`, which rebuilds
`/api/cameras/` and would refuse the TV its own core routes (verified by running Express 5.3). It **refuses** (403, no normalising) any
path with a doubled slash, a dot segment, an encoded slash, an encoded dot or a backslash, before comparing (Express 5.3 already
answers 404 to `//` paths; case and trailing-slash variants reach a handler, and an exact compare refuses them, the safe direction).
Methods are compared exactly (`HEAD` counts as `GET` only for an allowed `GET` path; no method-override header is honoured anywhere).
Entries are exact strings except **one**: HLS, `/hls/<one segment>-hls/<one file segment>`, matched by a small function with its own
table-driven test (so "no pattern beyond an exact path" has one named exception).

No new middleware is mounted and the guard functions stay the same function objects, so `ROUTE_GATES` and `APP_REGISTRATIONS` in
`route-permissions.test.js` stay valid.

### 6.2 What is NOT an Express guard

- **The talk-back WebSocket** (`/api/talk`, `index.js` upgrade handler, `lib/talkSocket.js`) calls `verifyToken(token, { purpose: 'media' })`
  with no Express `req`. **`verifyToken` refuses `kind = 'tv'` itself when `purpose === 'media'`.** Its only two media callers are the
  handshake (`index.js`) and the 15-second revalidation (`talkSocket.js`); HLS does not use it. One rule in one function, so it is
  unit-testable: the handshake lives in `index.js`, which no test can import, and a check only in the revalidation would let a TV
  talk for up to 15 seconds. A TV has no microphone path anyway.
- **The media token.** A TV's `?token=` media token inherits the session. The `?token=` routes (snapshots, clips, timelapses,
  recordings) go through `requireAuthQueryOrHeader`, so the same allowlist applies: a TV media token reaches `/hls/<path>-hls/*` and nothing else.
- **The WebRTC reconcile sweep** (`isLiveSessionId`, every 15 s) already handles any session id; a TV session is kicked on revoke like any other.
- **`optionalAuth` routes** (`GET /api/settings`): the TV is a signed-in caregiver there because the role is forced in `sessionWithUser`
  (§6.1), and §6.4 pins what it gets.
- **Public routes** (`/api/auth/status`, `/api/auth/login`, `device/start`, `device/poll`, `/api/health`, `GET /api/push/snapshot/:id`) never
  reach these guards, so a TV token does not change them. `device/pending`, `approve` and `deny` are SIGNED_IN, so a TV session **is
  refused** there (the TV test expects a 403).

### 6.3 A password typed on a TV is also a TV session

`POST /api/auth/login` (and `/login/mfa`, which carries it through the `mfaToken`'s payload) accepts an optional `{ tv: true, label }`;
the session it creates is then `kind = 'tv'`. A client can only ask for **less** power for itself, so there is nothing to abuse.
**The flag is asserted by the client, and it is tied to the route, not to detection:** `isTelevision()` answers false on its 1.5-second
timeout, on an old shell, or on any unexpected answer, and `/login` drops `?tv=1`. So the password form lives **on `/tv/pair`** (a small
form of its own that always sends `tv: true`), not on the shared `/login` page. A person who signs in on a TV's ordinary browser
through `/login` gets an ordinary session (stated in §13). Otherwise "sign in with a password instead" would leave an unrestricted
token on a shared TV, which is the thing this section exists to prevent. This part, with its form, ships in the frontend PR (§10).

### 6.4 The allowlist, and what the allowed routes return

**Allowed for a TV session** (read from what `/tv` calls; **must be re-checked against the code at build time**):

| Route | Why |
|---|---|
| `GET /api/auth/me`, `POST /api/auth/media-token`, `POST /api/auth/logout` | sign-in state, the media token, a sign-out |
| `GET /api/about`, `GET /api/settings` | stun servers and the app name |
| `GET /api/cameras` (the list and status the tiles poll) | the tiles |
| `POST /live/<path>/whep`, `DELETE /live/<path>/whep/<id>` | WebRTC viewing (`whepOnlyGuard` already limits that proxy to those two) |
| `GET /hls/<path>-hls/*` with the media token | the HLS fallback |

**Not allowed, on purpose:** everything else, notably every write, `GET /api/children` and every sleep route (a TV session cannot read a
child's name or birthday), recordings, clips, snapshots, users and sessions (a TV cannot list or revoke anything), push
(`/api/push/*`), `/api/talk`, `remote-access`, diagnostics, logs, and the pairing routes `pending`, `approve` and `deny` (`start` and `poll` are public and never reach these guards).

**What the allowed routes return is part of the boundary.** "Caregiver projection" is not small enough: `publicCamera` spreads every
camera column except seven credential fields, so a caregiver (and so a TV) also gets `onvif_device_url` (the camera's LAN address),
`detect_zone`, `child_id`, MQTT readings, `nightlight_sensors` and `alerts_snoozed_by` (a username), and camera names are very often a
child's name. So a TV gets **its own small projection**: `GET /api/cameras` returns, for a TV session, only what `TvMonitor` reads
(`id`, `name`, `mediamtx_path`, `disabled` and the status fields the tiles show; the exact list is read from `TvMonitor.jsx` at
build time), and `GET /api/about` returns only `stunServers`. `GET /api/settings` returns the caregiver projection (the role is forced,
§6.1). **The projection test pins an independent field allowlist** against a fixture with populated hostile values in every other
camera and settings column (derived from `PRAGMA table_info`); it does not compute "admin response minus caregiver response", which
loses its oracle the day an admin-only field leaks into both.

**What the web side must do** so a TV session still works (frontend changes for the build, not noise):
- The TV screen's `CamerasProvider` fetches `GET /api/children` **inside the same `Promise.all`** as the cameras, so a 403 there fails
  the whole load and the TV would never show a camera. On `/tv` it must not fetch children at all.
- `initPushNotifications` and `syncTailscaleEndpoint` run for any signed-in user from `App.jsx`; on a TV they must not run.
  A 403 must **not** sign the app out (`api.js` signs out on 401 only; a test pins this).

**Tests.** A new test enumerates the route table and calls every **protected** route as a TV session, asserting 403 everywhere except the
allowlist (which it asserts is reachable: "reachable" means *not* `403 TV_SESSION_RESTRICTED`). It is harder than it looks, so the
build plans it: `route-permissions.test.js` mounts its sentinel probes under `/p<i>` (so `tvAllowed` would refuse every one) and
`ROUTE_GATES` is not exported, so the pin moves into a shared helper and the **real routers are mounted at their real paths**; its
real-router section runs real handlers, so `POST /logout` runs **last** (it deletes the TV session for every later call). Separate cases
cover what that table does not execute: the `/live` and `/hls` proxies (including the path forms `tvAllowed` refuses), the `verifyToken`
media rule, and the `?token=` media routes. A route added later without a row fails the existing test; a route added with a row fails
the new one unless a TV is denied.

## 7. Lifetime

A TV session uses the **standard session lifetime** (`SESSION_TTL_DAYS`, default 30, range 7 to 30, absolute from creation, no
refresh; `SECURITY.md`, "How long a sign-in lasts"). A TV that is always on simply shows the pairing screen again on day 30, or the
day an admin revokes it, or the day its owner is disabled. A shorter TV lifetime would mean a per-kind branch in
`sessionAgeCondition`, which has six call sites; it is **not** in this design (open point §12.3).

The token is kept in the WebView's `localStorage`, as on a phone (`SECURITY.md`, "where it is kept"). No new storage.

**A lost response** (§12.4) leaves a valid TV session that nobody holds, listed under Sessions for up to 30 days. It is harmless
(nobody has the token) and the list shows it; it is stated so nobody is surprised by a TV row for a TV that never connected.

## 8. Seeing and revoking a TV

- Settings → Sessions (and Account) already list sessions with `device`, `created_at`, `last_seen_at`. A TV row shows its `label`
  and "TV" instead of a browser string, plus "Connected from <approving device>, <time>" (`paired_from`). Revoking it is the existing
  `DELETE /api/auth/sessions/:id`.
- **Revoking a session also deletes the TV sessions it paired** (`WHERE paired_by_session = :id`, in the same transaction). A plain
  logout does not (signing out a phone must not switch off the living-room TV). The revoke confirmation says it.
- **Audit log.** One log line at approve and one at claim: the username, the sanitised label, the approving device and the TV session
  id. **Never** the `device_code`, the `user_code`'s approver input beyond the code itself, or the token.
- On its next request the TV gets 401, which today sends the app to the sign-in form. On a TV (`isTelevision`, or `?tv=1`) it must go
  to the **pairing screen** instead. That redirect lives in `api.js` and in `Protected` (`App.jsx`), not in `AuthContext`: both change.
- An admin can see and revoke every TV (`GET /api/auth/sessions/all`, as for any session).
- Disabling or removing the approver deletes the TV's session with the rest (#1233, unchanged).
- A password change or an admin password reset deletes the person's **other** sessions (verified in `routes/auth.js`), TV sessions
  among them. The session that made the change is kept (so is a TV paired by it unless it is also revoked).

## 9. The screens

**TV, not signed in** (new `/tv/pair`; the TV's `Protected` redirect goes here instead of `/login`):
- the QR (the existing vendored `QrCode.jsx`, rendered in the browser; nothing leaves the page) and the code in very large type;
- one line: "On your phone, open Nightlight and go to Settings, then Connect a TV, and enter this code" and a second small line
  "or scan this, then enter the code";
- a countdown, a status line ("Waiting for approval"), and a focusable "Sign in with a password instead";
- on `approved` it stores the token as the login form does, then opens `/tv`; on `denied` it says so and starts again; on `expired` it
  starts a new pairing by itself.
- It must work with the remote only (focus on the one button), at TV type sizes (the `.tv-*` rules in `design-language.md`).

**Phone or browser, signed in** (new `/pair` route and a Settings card "Connect a TV"):
- A card with a code box (the typed code is always required; the QR opens the page and fills nothing). A signed-out phone sees
  the one-line instruction of §2, not a sign-in form.
- After the code is entered the page shows the TV's label **in quotes with its device string beside it**, "requested N minutes ago"
  and the sentence "Only approve if this is your TV and the code on its screen is BCDF-GHJK". **Approve** and **Deny**.
- On success: "Your TV is connected. You can disconnect it any time under Sessions."

## 10. Tests and review (full rigor: authentication and sessions)

Each claim names the test that fails without it; hostile fixtures; one mutant per behaviour (not a quota).

| Claim | Test |
|---|---|
| `device_code` is hashed at rest and never returned by any GET | `secrets-never-returned` (schema-driven marker in `device_hash`) |
| Single use: a second poll with the same `device_code` gets no session | **sequential replay** (the handler is synchronous, so two "simultaneous" requests serialise and a naive check-then-write would pass: a race test cannot fail); a mutant on the `DELETE` row-count guard |
| Approve and deny are mutually exclusive; claim refuses a denied pairing | sequential tests (approve then deny, deny then approve, claim after deny); **one mutant per guard term** of the three statements |
| Expiry: an expired pairing cannot be approved, polled to a token, or claimed | boundary tests (a second before / after) on the **JavaScript clock** (`utcText(Date.now())`; mock timers cannot move SQLite's `datetime('now')`), and a clock-rollback case |
| **The one guarantee at claim is `isLiveSessionId(approved_by_session)` + `password_set`.** A session that is gone, or an account disabled/removed, gets no TV session | a fixture that sets `disabled = 1` **directly and leaves the session and the pairing in place** (going through the disable route deletes both first, so it cannot isolate the claim-time check); the same for a deleted session row. No test is claimed for a separate `accountDisabledOrGone` check: it is redundant with `isLiveSessionId` and its mutant would survive by construction |
| **A logout, revoke, or a password change or reset made from ANOTHER session cancels an approved pairing**; the same change made from the approving session does **not** (stated exception) | one test per path, each followed by a claim, and one for the exception |
| Revoking a session deletes the TV sessions it paired; a plain logout does not; 5 live TV sessions per user | behaviour tests |
| A refused claim answers `denied` at once and leaves the row marked | route test |
| The poll answers 200 for every pairing state (never 401) | route test |
| The disable transaction deletes pending pairings; user delete cascades | schema and behaviour tests |
| A TV session is refused everywhere except the allowlist; a TV session approved by an **admin** gets the pinned TV projections and effective role `caregiver` on `/api/auth/me`, `/api/settings` and the poll | the route-walking test and the projection test in §6.4 (independent allowlist, hostile values) |
| `verifyToken` refuses a TV session for `purpose: 'media'` (handshake and revalidation share it) | `verifyToken` unit test; the talk socket test with a TV media token |
| `tvAllowed` accepts `GET /api/cameras` (router-root path) and refuses doubled slashes, dot segments, encoded slashes, wrong methods | table-driven unit test on the helper (`originalUrl` path) plus proxy cases |
| A password typed on a TV (with and without MFA) yields a `kind = 'tv'` session | `account-*` login tests; frontend test that the `/tv/pair` form sends the flag |
| The approval page shows the quoted label and device string, with control and bidi characters stripped | frontend test |
| A 403 for a TV does not sign the app out | frontend test on `api.js` |
| Start limiter, per-bucket cap counting only live rows, own-bucket eviction, global cap and eviction, poll `slow_down` kept in the row, approve failure limiter | limiter tests with injected clocks; a TV that reloads three times in ten minutes can still start |
| Code alphabet, length, normalisation (case, dash, spaces); no two live pairings share a code | unit tests; a collision retry test |
| The approval page never pre-fills the code and requires typing | frontend test |
| Uniform 404 for unknown / expired / consumed codes | route tests |
| The QR and the screen never contain the `device_code` | frontend test |

Process: written design (this) -> owner decided §12 -> two plan reviews done (§14) -> build in **three PRs** -> Opus builds the backend,
Sonnet the screens -> code review by Codex and Opus -> mutants after every fix round -> staging -> the owner's check on the real TV and a
phone. Any finding that is a security property is a **private draft advisory**, never a public issue. The three PRs:
- **1a, the restricted session** (inert on its own: nothing mints a TV session yet, so it is tested with hand-made TV sessions and
  can be reverted alone): the `kind`/`label`/`paired_*` columns, the `sessions` role override in `sessionWithUser`, the `tvAllowed`
  guard with the `originalUrl` rule, the `verifyToken` media rule, the TV projection of the camera list and `/api/about`, the revoke
  cascade, the route-walking test, docs, mutants.
- **1b, the pairing protocol:** `tv_pairings`, the four endpoints plus `start`, the limiters, the claim transaction, the audit lines,
  the demo entries, the `tv: true` login flag on the backend, tests, mutants, docs.
- **2, the screens:** `/tv/pair` (with its password form that sends `tv: true`), the approval page and the Settings card, the frontend
  gates in §6.4, the Sessions TV row, the 401 redirect on a TV, docs.

## 11. Docs to write with the code

`SECURITY.md` new section "Pairing a TV" (after "Caregiver invite links"): what a TV session can and cannot do, the lifetime, how to
revoke, the known limits of §13. `docs/architecture.md` a "TV pairing" subsection beside "Caregiver invites" and the `sessions.kind`
note in the Auth overview. `docs/mobile.md` ("Android TV": the lines that say pairing is "planned, not built", and "Anyone signed in
can use it"). `docs/caregivers.md` (who can pair a TV, how to disconnect one). `docs/mfa.md` and `docs/remote-access.md` (where the login limiters'
limits are written: the new limiters are in memory and share one key behind a proxy without `TRUST_PROXY`). **`SECURITY.md` lines
that say "a stolen token is only as good as its session … ending the session ends it" get the pairing exception** (a TV paired from
a session outlives a plain sign-out of it; §3 row 14). `CHANGELOG.md` under the existing `### Added`, with "sign a TV that you signed in
by password out once". The Connect document §8.5 is not in this repo; if it lives elsewhere it gets a pointer to this design (it says
the v1 QR "must not grow into" sign-in; the pairing QR here is a separate mechanism and carries no credential).

## 12. Decisions (owner, 2026-11-28: all six as recommended)

The owner accepted every recommendation below, so these are decided, not open. The alternatives stay written down for the reviewers.

1. **Who may approve?** *Recommended: any signed-in user, and the TV signs in as that user* (a caregiver can pair the living-room TV).
   The TV session is view-only with the effective role `caregiver` whoever approved it. Alternative: admins only (smaller exposure; a
   caregiver cannot set up a TV).
2. **Re-authentication on approve?** *Recommended: none.* The approver is already signed in and must type the code; the TV is
   watch-and-listen only and revocable. Alternative: ask for the password (or a TOTP) on every approval, which also covers "a signed-in phone left
   unlocked". The app has no step-up today, so this is new code (`throttledPasswordCheck` exists for the password case), and
   `/me/mfa/setup` and `/me/mfa/disable` do ask for the password for exactly the borrowed-device case. **Consequence the second review
   found, and what the design does about it (§3 row 14):** the TV outlives the session that approved it, so a stolen or unlocked
   session can leave a 30-day watch-and-listen foothold. The decision stands; the answer is the revoke cascade, the visible "connected
   from", the audit lines and the cap of 5, and the limit is written in §13. If the owner wants the foothold closed, re-authentication
   is the way, and it is a small addition, not a redesign.
3. **TV session lifetime.** *Recommended: the standard one (30 days at most).* Alternative: a shorter, per-kind lifetime (a branch in
   `sessionAgeCondition`).
4. **A lost response** (the TV never receives the token after it was approved): *recommended: strict, pair again.* Alternative: let the
   same `device_code` re-claim within 30 seconds (more complexity, a wider window for a stolen `device_code`).
5. **Tell the admins when a TV is paired?** *Recommended: not in v1* (the session list is the record). Alternative: a push to admins,
   which would answer the relay attack (§3 row 1) in minutes instead of "when someone looks".
6. **Allowlist includes snapshots?** *Recommended: no.* A TV tile uses live video only.

## 13. Known limits (to state in `SECURITY.md`)

- The relay attack (§3 row 1) is reduced, not removed: a person who approves a code they did not see on their own TV gives a stranger
  view-only access to the cameras until it is revoked.
- **A signed-in phone left unlocked, or a stolen session, can pair a TV that outlives it.** This is **not** the same as "anything else
  that account can do": everything else a caregiver session can do ends when that session ends, but a TV paired from it lives up to
  30 days. A session on day 29 can pair a TV that lasts to day 59. What ends it: revoking the TV row, **revoking** the session that
  paired it (a plain sign-out does not), disabling or removing the account, or a password change from another session (§3 row 14).
  The session may also predate MFA: `/me/mfa/enable` signs nobody out, so "the approver passed MFA" is only true for sessions created after it.
- The limiters are in memory and share one key behind a reverse proxy without `TRUST_PROXY` (as the login limiters do). **A TV that is
  not on the home network needs `TRUST_PROXY` set, or one internet client can keep every remote pairing slot busy.** Many client
  buckets (a script on the LAN, tailnet account slots) can still hold every live slot for ten minutes and delay a pairing; the
  password form is the fallback.
- A TV session lives up to 30 days and is **not** refreshed. A lost response (the TV never got its token) leaves an orphan TV row in the
  list for that time.
- **A password typed on a TV's ordinary browser through `/login` gets an ordinary session**: only the pairing screen's form and the
  pairing flow produce a TV session. A TV signed in by password before this ships keeps its ordinary session until signed out.
- **Going back to an older server version turns every TV session into an ordinary session with the approver's real role** (older code
  ignores `kind`). Before rolling back, sign every TV out (the same shape as the invite-link downgrade note in `SECURITY.md`).
- A self-service password change, or an admin resetting their own password, keeps the requesting session, so a TV that session paired
  survives it unless revoked.
- A clock moved backwards can make an expired pairing eligible again until the real time passes its expiry (the clock is the host's).
- **Restoring a database backup restores its sessions and any pending pairings** (as `docs/operations.md` says for sessions today); a
  revoked TV session returns with an old backup if the signing secret is restored too. Revoke it again.
- The TV's label is plain text, clamped; nothing renders it as markup. Non-Latin labels are shown as typed.
- Untested until built: the Android TV remote with the pairing screen, a phone on cellular scanning a LAN-address QR (it will not
  open; the typed path is the answer), a TV behind a reverse proxy.

## 14. Review log

First review, Codex `gpt-6-sol`, read-only, against the code (2026-11-28). What it found and where this version answers it:

| Finding | Severity | Answer |
|---|---|---|
| An approved pairing could outlive a revoked or logged-out approving session; password change/reset not covered | High | `approved_by_session`, re-checked at claim with `isLiveSessionId` (§3 row 7, §4.1, §4.4); verified that both password paths delete sessions |
| "Same network" hint cannot safely enable tap-to-approve (`clientBucketKey` is not a network) | High | hint dropped; the approver always types the code (§3 row 1, §9) |
| The WebSocket is outside the Express path guard | High | explicit rejection in the handshake and its revalidation (§6.2) |
| The password fallback made an unrestricted session on the TV | High | the TV password login yields a `tv` session (§6.3) |
| Allowed routes return admin fields for an admin approver | Medium | effective role forced to `caregiver`, projections pinned by a test (§6.1, §6.4) |
| Approve and deny not mutually exclusive | Medium | all three transitions guarded on all three timestamps (§4.4) |
| The global cap of 20 is an availability target | Medium | per-bucket cap and eviction; the residual limit is stated (§3 row 6, §13) |
| Restore can revive a revoked TV session | Low | stated limit (§13) |
| Test plan: `route-permissions` does not run the proxies or the WebSocket; path normalisation unspecified | correction | separate proxy/WebSocket/media-route cases; exact path rules in §6.1; tests in §10 |
| Code alphabet contained `L`; the sample code used characters outside it | correction | alphabet and samples corrected (§4.2) |

The owner decided §12 on 2026-11-28 (all six as recommended).

Second review, Codex `gpt-6-sol` and an Opus agent in parallel, read-only, against the code (2026-11-28). Findings and where this
version (v3) answers them. Both agreed the state machine is sound (one synchronous transaction, no gap before `createSession`) and
found no route outside the guards; the design had mechanism errors and one unstated consequence.

| Finding | Severity | Answer |
|---|---|---|
| A TV outlives the session that approved it; a stolen session extends its reach by up to 30 days; "anything else that account can do" was false (Opus H1, Codex 2) | High | §3 row 14, §8: `paired_by_session`/`paired_from`, revoke cascade, audit lines, cap of 5, §13 stated plainly; §12.2 says re-authentication would close it |
| `kind` and the forced role did not reach `verifyToken` / `optionalAuth` / `/api/auth/me` (Codex 1, Opus M2, A12) | High | the role is forced in `sessionWithUser` (§6.1); `/me` and the poll return the effective role |
| The talk-back rule was untestable in `index.js` or leaky for 15 s in the revalidation (Opus M1) | Medium | `verifyToken` itself refuses a TV for `purpose: 'media'` (§6.2) |
| `req.baseUrl + req.path` rebuilds `/api/cameras/` and would refuse the TV its core routes (Opus M3, verified by running Express 5.3) | Medium | `tvAllowed` compares the path part of `originalUrl` (§6.1) |
| One shared bucket can block pairing; the caps counted expired rows and the sweeper is daily; a reload orphans a row (Codex 3, Opus M4, M5) | Medium | caps count live rows, `start` deletes expired rows itself, own-bucket oldest-row eviction, `TRUST_PROXY` limit stated (§3 row 6, §13) |
| "Camera list is live cameras only" was overstated: LAN address, detect zone, child id, a username (Opus M8) | Medium | a TV-specific projection and a trimmed `/api/about`; "watch and listen" wording (§6.4) |
| The password-change cancellation was overstated: the changing session is kept (Codex 4, Opus T3) | Medium | narrowed in §3 row 7 and §8, the exception tested (§10) |
| The projection test lost its oracle (Codex 5) | Medium | an independent pinned allowlist with hostile values (§6.4) |
| Downgrade turns TV sessions into full sessions; phase-1 TVs keep full sessions; the `tv:true` flag is client-asserted (Opus M6, M7) | Medium | §13; the password form moves onto `/tv/pair` (§6.3); sign the TV out once (§4.3) |
| The poll's answers and a refused claim were unspecified; a 401 would pull the TV off the pairing screen (Opus L1) | Low-medium | always 200, refused claim marks `denied` in a separate write (§4.4, §5) |
| Label impersonation; the QR path ends at a password prompt on a page the TV chose; `c=` unused (Opus L2, L3) | Low-medium | label quoted with the device string and control/bidi stripped; signed-out `/pair` gives instructions, no form; `c=` dropped (§2, §3 row 1) |
| Tests that cannot fail: the "simultaneous polls" race, the redundant `accountDisabledOrGone` check, boundaries on SQLite's clock; the route-walking harness (Opus T1 to T5) | Testability | §10 rewritten: sequential replays plus one mutant per guard term, the one claim-time guarantee named, JS clock, harness plan in §6.4 |
| Accuracy: "five public routes", `inviteLimiter` keys on `clientKey`, children fetch in `Promise.all`, redirect lives in `api.js`/`Protected`, limiter docs location, per-route body limit, code in a GET URL, `claimed_at` unobservable, `/hls` wildcard, the Connect doc is not in this repo (Opus A1 to A11, A13) | Accuracy | each corrected where it appeared (§5, §6, §8, §11) |
| Poll budget, TV-side `slow_down` handling, approved rows vs the global cap, `Login` return path (Codex 6) | Low | §4.2 (600 per 10 minutes, +5 s), §3 row 6, §2 (no sign-in form on `/pair`) |
| Build split | advice | three PRs: 1a restricted session, 1b protocol, 2 screens (§10) |

The design is ready for the owner's go to build.
