# Signing in a TV by code and QR: design (phase 2 of the Android TV app)

Status: **DESIGN, not built.** Written 2026-11-28 for issue #1237 (phase 2), revised the same day after a first read-only review by
Codex (§14). No code is written until the owner has decided §12 and said go, and until a second plan review has run (Codex and an
Opus agent in parallel: this is authentication). The Connect and Discovery architecture document (§8.5) parked "sign-in by
scanning a code" because "it is an authentication bypass if done carelessly" and "needs its own design and full-rigor review".
This is that design.

Who reads this: the owner (to decide the open points in §12), and the plan reviewers (to attack §3 to §9).

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
 |                                          |<--- GET  /api/auth/device/pending?code=BCDF-GHJK
 |                                          |       (shows label and time)          |
 |                                          |<--- POST /api/auth/device/approve { user_code }
 |  POST /api/auth/device/poll ------------>|       (or /deny)  the approver TYPED the code
 |   { device_code }   (every `interval`)   | approved? re-check the approver AND     |
 |<----- pending | denied | expired |       | the approving session, create the      |
 |       approved + session token           | session, return it ONCE                |
 |  stores the token like a login; opens /tv|                                      |
```

Two ways to give the phone the code:
- **QR.** `<origin>/#/pair?c=BCDF-GHJK`, where `<origin>` is the address the TV itself uses for the server. The code is in the URL
  **fragment**, which a browser never sends to the server and a proxy never logs (the invite pattern, `lib/inviteToken.js`). The QR
  only **opens the approval page**; the approver must still **type the code** shown on the TV (§3 row 1). Works when the phone can
  reach that address (same Wi-Fi, or the same tailnet).
- **Typed.** Settings → **Connect a TV** on the phone's own, already-working Nightlight address, then type the code. This is the
  path for a phone on cellular, for a TV that was set up with a LAN address the phone cannot reach, and for a person who cannot scan.
  The TV screen says so in one line under the QR.

The TV also offers "Sign in with a password instead", which opens the existing form (and still yields a view-only session, §6.3).

## 3. What an attacker can try, and the answer to each

| # | Attack | Answer |
|---|---|---|
| 1 | **Relay / phishing.** The attacker starts a pairing on their own device and gets a victim (signed in) to approve the attacker's code. The attacker's device is then signed in as the victim. | This is the real risk of every device-code flow, so it gets the most weight: (a) the TV session is **view-only** (§6), so the blast radius is "can watch the cameras", not "can change settings, read history or remove users"; (b) **the approver must always type the full code**, never just tap (a QR or link only opens the page; nothing is pre-filled into the approval), so approving means reading a code from a screen and entering it, which is the deliberate step a relayed link does not give; (c) the approval page shows what is being approved (the label the device sent and when), and says "Only approve if the code matches the one on your TV"; (d) there is **no "same network" signal**: the address bucket (`clientBucketKey`) is not a network (two LAN devices have different buckets; a reverse proxy without `TRUST_PROXY` shares one for everybody; Tailscale peers are bucketed by account slot), so it could say "different" at home and "same" for a remote attacker. Address information is never shown as a safety signal; (e) the session is listed under Sessions as a TV and is revocable (§8); (f) optional notice to admins (§12). Documented as a known limit. |
| 2 | **Guess a `user_code`** to approve someone's pending TV into the attacker's own account (a signed-in caregiver). | The code only works for a **signed-in** approver; 20 symbols x 8 characters = about 34 bits; a bounded number of pending pairings (§3 row 6); a failures-only limiter per user and per client (§5). Effect if it ever succeeded: the victim's TV shows the **attacker's** (view-only) session, which the attacker could already watch. Low value, not zero, so it is limited anyway. |
| 3 | **Steal the `device_code`** to collect the session. | 256-bit random, held only by the TV in memory until claimed, sent only in a POST **body** (never a URL, never a log), stored **hashed** (sha256, as invites). The QR and the screen show only the `user_code`, which is not a credential. |
| 4 | **Poll with a guessed `device_code`.** | 256 bits: not guessable. Unknown, expired and consumed codes answer the same `expired`. A per-client limiter anyway. |
| 5 | **Collect the session twice** (replay, or a double poll). | Claim is a compare-and-swap that must change exactly one row, inside one synchronous transaction with the approver check and the session insert (§4.4), then the row is deleted. The token is delivered once. A lost response means the TV pairs again (§12.4). |
| 6 | **Flood `/device/start`** (no authentication on it) to fill the database or to deny the owner a slot. | Per-client limit on starts (own `MemoryStore`, own budget, so junk does not use the login budget, the `inviteLimiter` precedent); **at most 3 pending rows per client bucket** inside a **global cap of 20**; at the global cap a start from a bucket with no pending row **evicts the oldest unapproved row of the fullest bucket** instead of answering 429, so one flooder cannot lock the owner out (many buckets can, which is the limit: the same LAN neighbour can already flood the login form); 10-minute expiry; a sweeper beside `purgeOldInvites`; a tiny body limit; `label` clamped to 40 characters of plain text. |
| 7 | **Approve as a disabled, removed or demoted user**, or **approve and then be logged out, revoked or have the password changed**. | The approve route is `requireAuth`, so a disabled approver is already refused. The pairing stores **`approved_by_session`** (the approving session's id). At **claim**, both the approver row (`accountDisabledOrGone`, `password_set = 1`) and that session (`isLiveSessionId`) are re-read, with **no `await` between those checks and `createSession`**, exactly as `/login/mfa` does after #1233. A logout, a revoke, a password change or reset (which delete sessions today) therefore cancel an approved pairing without a hook in each path. The disable transaction also deletes the user's pending pairings, and `user_id` has `ON DELETE CASCADE`. |
| 8 | **A stolen TV session** (TV resold, local malware). | View-only allowlist (§6); revocable (§8); it dies with the account (disable and remove already delete sessions); standard lifetime (§7). Restoring a database backup revives its sessions (§13). |
| 9 | **MFA bypass.** | Pairing mints a session only from an **already signed-in** session, which has already passed MFA at sign-in. No password or code is ever typed on the TV for this path. The password fallback keeps its existing MFA step (§6.3). (There is no step-up concept in the app today; see §12.2.) |
| 10 | **Cross-site request forgery on approve.** | The API takes the `Authorization: Bearer` header from `localStorage`, not a cookie, so a foreign page cannot ride the session. The approve call needs the typed code in its body. |
| 11 | **Enumeration.** | `/device/start` reveals nothing about accounts. `/device/pending` and `/approve` answer an unknown or expired `user_code` with one uniform 404 `pair_invalid`. |
| 12 | **Secrets in logs.** | `device_code` and the session token are never logged. The `user_code` may be (it is not a credential). The QR fragment never reaches the server. |
| 13 | **The TV session reaching a clip, a snapshot, the talk-back microphone or another admin-only response.** | §6: deny by default for every Express guard, an explicit rejection in the WebSocket handshake, the **effective role is `caregiver`** even for an admin approver, and response projections are tested (§6.4). |

## 4. Data

### 4.1 One new table, `tv_pairings` (hand-written, idempotent, inside the existing transaction in `db.js`)

| column | notes |
|---|---|
| `id` | uuid |
| `device_hash` | `sha256(device_code)` hex, `UNIQUE`. The code itself is never stored. |
| `user_code` | the displayed code, upper case without the dash, `UNIQUE`. Not a secret (it needs a signed-in approver who types it). |
| `label` | what the TV called itself, clamped, shown as **text only** (never HTML). Untrusted. |
| `client_bucket` | `clientBucketKey(req)` at start, for the limiter and the per-bucket cap only. Never shown. |
| `created_at`, `expires_at` | UTC text like the rest (`utcText`), 10 minutes. |
| `user_id` | `NULL` until approved; `REFERENCES users(id) ON DELETE CASCADE`. |
| `approved_by_session` | the session id that approved (no FK: sessions are deleted by several paths; the claim checks it is still live). |
| `approved_at`, `denied_at`, `claimed_at` | the state machine: pending, approved, claimed, denied, expired. |

`secrets-never-returned.test.js` plants a marker in `device_hash` (it reads the schema) and asks every GET route for it, as it does
for `user_invites.token_hash`.

### 4.2 Codes

- `device_code`: `randomBytes(32).toString('base64url')` (43 characters), as invites.
- `user_code`: 8 characters from the 20 symbols `BCDFGHJKMNPQRSTVWXYZ` (no vowels, so no words; no digits and no `L`, so no `0/O/1/I/L`
  confusion), drawn with rejection sampling from `crypto.randomInt`, shown `BCDF-GHJK`, accepted in any case and with or without the
  dash (normalised to upper case without the dash before any lookup or storage, so `bcdf ghjk` and `BCDFGHJK` are one code).
- Expiry **10 minutes**; the TV shows a countdown and starts a new pairing on its own when it ends (a new `device_code`, a new `user_code`).
- `interval` 3 seconds. A poll faster than 2 seconds from the same `device_hash` answers 429 `slow_down` (RFC 8628's rule), so a stuck
  TV cannot hammer the server.

### 4.3 Sessions get two columns

`sessions.kind TEXT NOT NULL DEFAULT 'user'` and `sessions.label TEXT` (guarded `ALTER TABLE`, sentinel on the last column; no
`user_version`). Existing rows stay `'user'`. `createSession(userId, userAgent, { kind, label })`; every existing caller is unchanged.
`toPublicSession` gains `kind` and `label` (additive only: an old client ignores them).

### 4.4 The state machine, and why it cannot be raced

better-sqlite3 transactions are synchronous, so each transition is one transaction with one guarded `UPDATE` that must change exactly
one row:

| Transition | Guard (all in the `WHERE`) |
|---|---|
| approve | `approved_at IS NULL AND denied_at IS NULL AND claimed_at IS NULL AND expires_at > now`, sets `user_id`, `approved_by_session`, `approved_at` |
| deny | the same guard, sets `denied_at` |
| claim | `approved_at IS NOT NULL AND denied_at IS NULL AND claimed_at IS NULL AND expires_at > now`, sets `claimed_at` |

Approve and deny are therefore mutually exclusive (whichever commits first wins; the other changes zero rows and answers the uniform
404). The claim transaction is: guarded `UPDATE` (1 row), re-read the approver row and `isLiveSessionId(approved_by_session)`,
`createSession(..., { kind: 'tv', label })`, delete the pairing row. The clock is read **inside** the transaction. Any failure throws
and rolls the whole thing back, so a refused claim leaves the pairing as it was (and it expires on its own).

## 5. Endpoints (all new; `route-permissions.test.js` gets a row for each)

| Route | Gate | Notes |
|---|---|---|
| `POST /api/auth/device/start` | PUBLIC, own limiter | `{ label? }` -> `{ device_code, user_code, expires_in, interval }`. Caps as §3 row 6. |
| `POST /api/auth/device/poll` | PUBLIC, own limiter | `{ device_code }` -> `{ status: 'pending' }` / `denied` / `expired` / `{ status: 'approved', token, user }` (the same `user` shape `/login` returns). `slow_down` as §4.2. |
| `GET /api/auth/device/pending?code=` | SIGNED_IN | what the approver is shown: `{ label, created_at }`. Failure-only limiter per user. A TV session cannot call it (§6). |
| `POST /api/auth/device/approve` | SIGNED_IN | `{ user_code }` typed by the approver. Guarded `UPDATE` as §4.4. |
| `POST /api/auth/device/deny` | SIGNED_IN | `{ user_code }`. |

- Limiters copy the `inviteLimiter` shape (`MemoryStore` of their own, `clientBucketKey`/`ipKeyGenerator` keys,
  `skipSuccessfulRequests` where it is about failures), with the same stated limit: they are **in memory** (a restart empties them)
  and behind a reverse proxy without `TRUST_PROXY` everyone shares one client key. `docs/operations.md` already says both of those
  things for the login limiters; this adds a line.
- The demo (`demoMode`) blocks all five; its test table gets them.
- `device/start` and `device/poll` use `clientBucketKey`, so the Tailscale loopback case is handled the way login handles it.

## 6. The view-only session

**Why.** A TV is a shared, always-on, hard-to-lock device. Whatever signs in on it should be able to do the one thing it is for.

### 6.1 The Express guards

`sessionWithUser` already joins `sessions` to `users` and reads `role` live (issue #261). It also selects `s.kind`.
`requireAuth` and `requireAuthQueryOrHeader` put `kind` on `req.user`, **force the effective role to `caregiver` when `kind = 'tv'`**
(so an admin approver's TV session can never reach an admin route, a second wall behind the allowlist), and **after** the session is
found: `if (kind === 'tv' && !tvAllowed(req)) return 403 { code: 'TV_SESSION_RESTRICTED' }`. No `kind` claim is put in the JWT and none
is trusted; it is read from the row, like the role.

`tvAllowed(req)` is **an allowlist of exact method plus exact full path**, with no pattern more permissive than a fixed prefix plus
one path segment. Express strips the mount prefix inside `/live` and `/hls` (`req.path` is then relative), so the helper rebuilds the full path from
`req.baseUrl + req.path` and **refuses** (403, no normalising) any path with a doubled slash, a dot segment, an encoded slash, an
encoded dot or a backslash, before comparing. Methods are compared exactly (`HEAD` counts as `GET` only for an allowed `GET`
path; no method-override header is honoured anywhere). It never uses `originalUrl` without stripping the query string.

No new middleware is mounted and the guard functions stay the same function objects, so `ROUTE_GATES` and `APP_REGISTRATIONS` in
`route-permissions.test.js` stay valid.

### 6.2 What is NOT an Express guard

- **The talk-back WebSocket** (`/api/talk`, `index.js` upgrade handler, `lib/talkSocket.js`) calls `verifyToken(token, { purpose: 'media' })`
  with no Express `req`. It must **reject `kind = 'tv'` explicitly**, in the handshake **and** in its 15-second revalidation
  (`liveSession` returns the kind; the socket closes the call). A TV has no microphone path anyway; a test connects with a TV media token.
- **The media token.** A TV's `?token=` media token inherits the session. The `?token=` routes (snapshots, clips, timelapses,
  recordings) go through `requireAuthQueryOrHeader`, so the same allowlist applies: a TV media token reaches `/hls/<path>-hls/*` and nothing else.
- **The WebRTC reconcile sweep** (`isLiveSessionId`, every 15 s) already handles any session id; a TV session is kicked on revoke like any other.
- **`optionalAuth` routes** (`GET /api/settings`): the TV is treated as a signed-in caregiver there (§6.1), and §6.4 pins what it gets.
- **Public routes** (`/api/auth/status`, `/api/auth/login`, the five pairing routes, `/api/health`, `GET /api/push/snapshot/:id`) never reach
  these guards, so a TV token does not change them; the TV test does not expect a 403 there.

### 6.3 A password typed on a TV is also a TV session

`POST /api/auth/login` (and `/login/mfa`, which carries it through the `mfaToken`'s payload) accepts an optional `{ tv: true, label }`;
the session it creates is then `kind = 'tv'`. A client can only ask for **less** power for itself, so there is nothing to abuse.
The TV's password form sends it; the web and phone forms do not. Otherwise "sign in with a password instead" would leave an
unrestricted token on a shared TV, which is the thing this section exists to prevent.

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
(`/api/push/*`), `/api/talk`, `remote-access`, diagnostics, logs, and the five pairing routes except `poll`/`start` (public).

**What the allowed routes return is part of the boundary.** `GET /api/cameras` and `GET /api/settings` return more fields to an admin
(RTSP host, path and username; admin configuration). Because a TV's effective role is `caregiver` (§6.1) it gets the caregiver
projection. A test pins it from the schema: as a TV session approved by an **admin**, `GET /api/cameras` and `GET /api/settings`
contain none of the admin-only fields (derived from the admin response minus the caregiver response, not from a literal list).

**Two things the web side must do** so a TV session still works (both are frontend changes for the build):
- The TV screen's `CamerasProvider` currently also fetches `GET /api/children` every 15 s; on `/tv` it must not (a 403 every 15 s
  is noise, and the children list is exactly what a TV should not read).
- `initPushNotifications` and `syncTailscaleEndpoint` run for any signed-in user from `App.jsx`; on a TV they must not run.
  A 403 must **not** sign the app out (`api.js` signs out on 401 only; a test pins this).

**Tests.** A new test beside `route-permissions.test.js` enumerates the **same route table**, calls every **protected** route as a TV
session and asserts 403 everywhere except the allowlist (which it asserts is reachable). Separate cases cover what that table does not
execute: the `/live` and `/hls` proxies (including the path forms `tvAllowed` refuses), the `/api/talk` handshake and revalidation, and
the `?token=` media routes. A route added later without a row fails the existing test; a route added with a row fails the new one unless
a TV is denied.

## 7. Lifetime

A TV session uses the **standard session lifetime** (`SESSION_TTL_DAYS`, default 30, range 7 to 30, absolute from creation, no
refresh; `SECURITY.md`, "How long a sign-in lasts"). A TV that is always on simply shows the pairing screen again on day 30, or the
day an admin revokes it, or the day its owner is disabled. A shorter TV lifetime would mean a per-kind branch in
`sessionAgeCondition`, which has six call sites; it is **not** in this design (open point §12.3).

The token is kept in the WebView's `localStorage`, as on a phone (`SECURITY.md`, "where it is kept"). No new storage.

## 8. Seeing and revoking a TV

- Settings → Sessions (and Account) already list sessions with `device`, `created_at`, `last_seen_at`. A TV row shows its `label`
  and "TV" instead of a browser string. Revoking it is the existing `DELETE /api/auth/sessions/:id`.
- On its next request the TV gets 401, which today sends the app to the sign-in form. On a TV (`isTelevision`, or `?tv=1`) it must go
  to the **pairing screen** instead. `AuthContext` already owns that redirect.
- An admin can see and revoke every TV (`GET /api/auth/sessions/all`, as for any session).
- Disabling or removing the approver deletes the TV's session with the rest (#1233, unchanged).
- A password change or an admin password reset already deletes the person's sessions (verified in `routes/auth.js`); a TV session is one of them.

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
- A card with a code box (the typed code is always required; `#/pair?c=` only opens the page, and does **not** fill the box). A signed-out
  phone is sent to sign in first and returned to `/pair` (a flag is stashed in `sessionStorage` before the redirect, as
  `captureInviteTokenFromLocation` does for invites).
- After the code is entered the page shows the TV's label and "requested N minutes ago" and the sentence "Only approve if this is
  your TV and the code on its screen is BCDF-GHJK". **Approve** and **Deny**.
- On success: "Your TV is connected. You can disconnect it any time under Sessions."

## 10. Tests and review (full rigor: authentication and sessions)

Each claim names the test that fails without it; hostile fixtures; one mutant per behaviour (not a quota).

| Claim | Test |
|---|---|
| `device_code` is hashed at rest and never returned by any GET | `secrets-never-returned` (schema-driven marker in `device_hash`) |
| Single use; two simultaneous polls give one session | race test with two overlapping claims |
| Approve and deny are mutually exclusive; claim refuses a denied pairing | race/ordering tests on the three guarded `UPDATE`s |
| Expiry: an expired pairing cannot be approved, polled to a token, or claimed | clock-driven tests at the boundary (a second before / after) |
| A disabled or removed approver gets no session, including one disabled between approve and claim | extends `account-disable.test.js` |
| **A logout, revoke, password change or reset of the approving session cancels an approved pairing** | one test per path, then a claim |
| The disable transaction deletes pending pairings; user delete cascades | schema and behaviour tests |
| A TV session is refused everywhere except the allowlist; a TV session approved by an **admin** gets the caregiver projections | the route-walking test and the projection test in §6.4 |
| The talk-back handshake and its revalidation refuse a TV session | `talk-socket.test.js` |
| `tvAllowed` refuses doubled slashes, dot segments, encoded slashes, wrong methods | table-driven unit test on the helper plus proxy cases |
| A password typed on a TV (with and without MFA) yields a `kind = 'tv'` session | `account-*` login tests |
| A 403 for a TV does not sign the app out | frontend test on `api.js` |
| Start limiter, per-bucket cap, global cap and eviction, poll `slow_down`, approve failure limiter | limiter tests with injected clocks |
| Code alphabet, length, normalisation (case, dash, spaces); no two live pairings share a code | unit tests; a collision retry test |
| The approval page never pre-fills the code and requires typing | frontend test |
| Uniform 404 for unknown / expired / consumed codes | route tests |
| The QR and the screen never contain the `device_code` | frontend test |

Process: written design (this) -> owner decides §12 -> **plan review by Codex `gpt-6-sol` AND an Opus agent in parallel** -> build in
two PRs (1: table, sessions columns, the five endpoints, the TV login flag, the allowlist guard and the WebSocket rule, backend tests and
mutants, docs; 2: the TV pairing screen, the approval page and card, the frontend gates in §6.4, docs) -> Opus builds the backend, Sonnet
the screens -> code review by Codex and Opus -> mutants after every fix round -> staging -> the owner's check on the real TV and a
phone. Any finding that is a security property is a **private draft advisory**, never a public issue.

## 11. Docs to write with the code

`SECURITY.md` new section "Pairing a TV" (after "Caregiver invite links"): what a TV session can and cannot do, the lifetime, how to
revoke, the known limits of §13. `docs/architecture.md` a "TV pairing" subsection beside "Caregiver invites" and the `sessions.kind`
note in the Auth overview. `docs/mobile.md` ("Android TV": the lines that say pairing is "planned, not built", and "Anyone signed in
can use it"). `docs/caregivers.md` (who can pair a TV, how to disconnect one). `docs/operations.md` (the new limiters are in memory).
`CHANGELOG.md` under the existing `### Added`. The Connect document §8.5 gets a pointer to this design (that document says the
v1 QR "must not grow into" sign-in; the pairing QR here is a separate mechanism and carries no credential).

## 12. Decisions (owner, 2026-11-28: all six as recommended)

The owner accepted every recommendation below, so these are decided, not open. The alternatives stay written down for the reviewers.

1. **Who may approve?** *Recommended: any signed-in user, and the TV signs in as that user* (a caregiver can pair the living-room TV).
   The TV session is view-only with the effective role `caregiver` whoever approved it. Alternative: admins only (smaller exposure; a
   caregiver cannot set up a TV).
2. **Re-authentication on approve?** *Recommended: none.* The approver is already signed in (and past MFA) and must type the code; the TV is
   view-only and revocable. Alternative: ask for the password (or a TOTP) on every approval, which also covers "a signed-in phone left
   unlocked". The app has no step-up today, so this is new code (`throttledPasswordCheck` exists for the password case).
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
- A signed-in phone left unlocked can pair a TV (as it can do anything else that account can do), unless §12.2 is chosen otherwise.
- The limiters are in memory and share one key behind a reverse proxy without `TRUST_PROXY` (as the login limiters do). Many client
  buckets (a script on the LAN, tailnet account slots) can still hold every pending slot for ten minutes and delay a pairing; the
  password form is the fallback.
- A TV session lives up to 30 days and is **not** refreshed.
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

The owner decided §12 on 2026-11-28 (all six as recommended). A second review (Codex and Opus in parallel) is still to run before any code.
