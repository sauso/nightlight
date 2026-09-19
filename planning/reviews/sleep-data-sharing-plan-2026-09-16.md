# Opt-in anonymized sleep-data sharing, to improve the detection algorithm

## Context

The owner wants to understand whether households could voluntarily anonymize and send their
sleep-tracking data so the maintainer can improve the sleep-detection algorithm — and specifically
wants to see, concretely, how and where that data would travel. This is genuinely new territory for
this app: every existing outbound call (ntfy, Pushover, Gotify, Firebase push) goes to a service the
**household configures and owns the account for**, and the docs say so explicitly in three places —
`README.md:9` ("No cloud, no subscription, no account anywhere but your own network"),
`docker-hub-overview.md:3-5` (same line), `docs/README.md:77-78` ("nothing is shared through a
Nightlight cloud"). A feature that sends data to a server the **maintainer** runs is categorically
different — it would literally create the "Nightlight cloud" the docs currently say doesn't exist, for
an app whose data is a household's sleeping children. This plan treats that as the central constraint,
not an afterthought: the feature must be genuinely opt-in, checkable before it's trusted, and the three
existing claims must be edited so they stay true rather than silently become false.

Two research passes (schema/pattern) and one design-review pass (stress-testing the anonymization,
consent lifecycle, and phasing) grounded this plan in the actual codebase before writing it — findings
folded in throughout, not left as a separate appendix.

**Status: approved by the owner 2026-09-16, deliberately NOT scheduled to be built yet.** Referenced
from `planning/ROADMAP.md` §2. Do not start building any phase without a fresh explicit go-ahead.

## What already exists, verified

- **The richest ground-truth data is already curated and durable, without any new work.**
  `bed_transitions.verdict` (`backend/src/db.js:357`, `NULL`/`'correct'`/`'wrong'`/`'unclear'`, exported
  as `VERDICTS` in `backend/src/lib/bedTransitions.js:336`) marks a person's judgement on one event, and
  a verdicted row is **exempt from the 45-day prune forever** (`bedTransitions.js:75,79`, the
  `AGED_UNJUDGED` clause). `sleep_reviews` (`db.js:223-236`) holds the owner's manual
  `true_onset_at`/`true_wake_at` correction per night and is **deliberately never pruned**
  (`db.js:214-222`). Together these are exactly the labeled training pairs a model needs, and they're
  already the durable subset of the schema — nothing else needs new retention rules.
- **`quick_reversal_of`/`lingering_motion_minutes` are not stored columns.** They're computed at request
  time in `backend/src/lib/sleepReviews.js:161-169` by calling `findQuickReversals`/
  `findAllLingeringBedMotion` in `backend/src/lib/bedTransitionRules.js` (also exposed directly as
  `getQuickReversals`/`getLingeringBedMotion` in `bedTransitions.js`) — the same functions that drive
  the "Quick check-in?"/"Still moving?" prompts the owner actually answered. The export should call
  these same functions rather than re-derive the logic, so an exported flag always matches what the
  owner was actually shown.
- **The settings/route pattern to copy**: a new opt-in integration gets its own DB columns (guarded
  `ALTER TABLE`, `PRAGMA table_info` idiom, e.g. `db.js:438-445` for `ntfy_enabled`), its own route file
  with GET/PUT `/config` (`backend/src/routes/ntfy.js`), and its own settings page with a `Switch`
  (immediate-apply) vs. checkbox (save-on-submit) per `frontend/src/components/Switch.jsx`'s documented
  convention. `GET /settings` has a hard `PUBLIC_FIELDS`/`ADMIN_FIELDS` allow-list
  (`backend/src/routes/settings.js:29-63`) that exists **because of a real fixed CVE**
  (GHSA-qffc-965c-x74m, a deny-list that leaked provider tokens) — any new column must be deliberately
  allow-listed, never default-included.
- **`frontend/src/components/DiagnosticsCard.jsx` is the trust pattern to extend, not the field-selection
  code to copy.** Its comment: *"Nothing is uploaded from here — the download stays on their device so
  they can review it before sharing."* That UX shape (build locally, preview, nothing sent) is exactly
  right for this feature's first phase. **But its backing route, `backend/src/routes/diagnostics.js:110,
  185`, already leaks `children.name`/`birthday` into the "redacted" bundle** — a real, pre-existing gap,
  found while researching this plan, and a concrete demonstration of the failure mode this plan needs to
  avoid (a hand-picked field list that quietly goes stale relative to its own claim). **Not this plan's
  bug to fix** — flagged separately below as a related finding worth its own issue — but it's the reason
  this plan leans on schema-derived classification tests rather than a hand-typed field list (see Tests).
- **The outbound-call primitive**: `backend/src/lib/httpNotify.js`'s `postWithTimeout()` wraps the
  built-in `fetch` (Node 24, already the container's runtime — no new dependency) with an
  `AbortController` and a 10s timeout. All four existing notification sends are fire-and-forget with
  try/catch + `logger.error` + **no retry** — the established failure philosophy this plan follows.
- **The scheduling primitive**: `startSleepJob()` (`backend/src/lib/sleepAnalysis.js:1888-1893`) is the
  idiom — module-level timer, immediate run + interval, idempotent start guard, a matching `stop*()`
  wired into `index.js`'s startup (line 66) and grouped `shutdown()` (line 665, whose own comment
  explains a prior job was once invisibly missed by that sweep — so a new job MUST be added there, not
  just started). For an **async** callback specifically, `safeInterval(label, ms, fn)`
  (`backend/src/lib/processGuards.js:99-112`) catches both throws and rejected promises so one failed
  network tick can't kill the process — this, not a bare `setInterval`, is the right wrapper here.
- **Test precedents this plan leans on directly**: `backend/test/cameras-assign-exposure.test.js`'s
  PRAGMA-driven column classification + planted-marker sweep (the exact technique that would have caught
  the diagnostics.js leak above), and `backend/test/suite-exits-cleanly.test.js`'s derived `PERIODIC`
  array (`~line 163`) that catches a leaked interval on shutdown — its own comments describe getting
  exactly this "forgot to register the new job" mistake wrong three times already.

## The central design decision: minimize by attaching to a human label, not a time window

**Only export data tied to an explicit human judgement** — a `bed_transitions.verdict` or a
`sleep_reviews` correction — never a raw slice of `activity_samples` for its own sake. This is both the
more private choice (nothing about a night leaves the device unless a person specifically confirmed or
corrected something about it) and the more useful one (it's exactly the labeled pairs a model needs, not
an undifferentiated stream). Concretely, per exported record:

- **Timestamps become minutes-relative-to-that-night's `window_start`**, never absolute. This drops
  calendar date and time-of-day entirely and means `settings.timezone` never needs to be exported at
  all. Reuse `sleepAnalysis.js`'s existing DST-safe local-date helpers for the conversion — this repo has
  a documented incident (`CLAUDE.md`'s `04:00Z`-in-Melbourne bug) from exactly this arithmetic being
  reimplemented naively; don't repeat it.
- **Real `children.id`/`cameras.id` become a per-install HMAC pseudonym**: `HMAC-SHA256(localSalt,
  realId)`, truncated. The salt is generated once and persisted locally
  (`DATA_DIR/.sleep_share_salt`, mode 0600) — mirroring `middleware/auth.js:15-33`'s
  `loadOrCreateSecret()` pattern for `.jwt_secret` exactly — and **never transmitted**. This keeps a
  pseudonym stable *within* one household's own submissions (so multi-night-per-child trends and
  sibling cross-camera correlation, which this codebase's own sound-bleed work already relies on, stay
  analyzable) while being non-reversible and uncorrelatable *across* households.
- **Hard-excluded, no setting, no toggle, ever**: `children.name`/`birthday`/`photo`, `cameras.name`,
  `sleep_reviews.note` (free text — an owner could type anything, including another person's name; it
  cannot be safely auto-scrubbed), every credential field (`rtsp_url`, `onvif_*`, `talk_*`,
  `sub_rtsp_url`, `snapshot_url`), `settings.timezone` raw, every snapshot/clip/recording file or path
  (`transition-snapshots/`, `detection-snapshots/`, `CLIPS_DIR`), and the real UUIDs themselves.

**What gets exported, per verdicted transition or reviewed night**: transition `type`, `verdict`,
`out_peak`/`out_frames`, timing relative to that night's window start, and the same quick-reversal/
lingering-motion flags the owner was actually shown (recomputed via the existing pure functions, not
re-derived); per reviewed night, `true_onset_at`/`true_wake_at` vs. `computed_onset_at`/`computed_wake_at`
(both relativized), plus `wake_count`/`awake_minutes`/`asleep_minutes`/`longest_stretch_minutes` from
`sleep_nights`. `sleep_reviews.note` and calendar date are never included.

**Numeric context around a labeled event (Phase 1b, not 1a)**: a bounded window of `activity_samples`
numeric columns (motion/sound peak, mean, percentiles) around each labeled event gives the model real
surrounding signal instead of a bare label. **A real data-availability gap applies here, found during
design review**: `activity_samples` prunes unconditionally at 30 days (`activityTracker.js:13,154-159`,
no verdict exemption at all), while a transition can be verdicted well after that and survive forever, or
a `sleep_reviews` correction can be made months later — so the surrounding numeric context can already be
gone by the time an export runs, independent of how often the export job fires. Two ways to handle it,
and the second is rejected on purpose: **(a) best-effort/nullable** — the context field is simply absent
when the underlying rows are already pruned, never blocks the label itself; **(b) capture-at-verdict** —
freeze the window into a new table the moment a verdict lands, so it survives independently. **(b) is
rejected**: it quietly turns a capped 30-day surveillance stream into an indefinitely-retained one for
every verdicted event, a real retention-policy expansion this codebase's own 30/45-day discipline argues
against, smuggled in under a feature that's supposed to be about minimization. **(a) is the design**:
accept a documented, bounded completeness gap (`context: null` is an expected, tested value) rather than
grow retention to close it.

## Anonymization review — what was deliberately NOT added, and why

Differential privacy and formal k-anonymity were both considered and rejected, not overlooked:

- **Differential privacy** defends against an adversary with *repeated, interactive query access* to a
  live dataset, budgeted over many queries. There is no query interface here — a single opt-in batch
  upload from a self-selecting population. The real threats are a bug leaking raw PII into the payload,
  the maintainer's storage being breached, or legal compulsion — DP noise on the numeric fields defends
  against none of those while directly degrading the one thing the feature exists to produce.
- **K-anonymity** is designed to make rows indistinguishable *within one release*; a single household's
  batch is attributable to "some household" regardless of how many nights it contains, so batch size
  doesn't buy the property. A minimum-verdicted-nights gate before the first send is still worth having,
  but framed honestly as **signal-to-noise / not wasting a request on one test night**, not a privacy
  control — calling it k-anonymity would claim a property the mechanism doesn't provide.
- **What's added instead**: a defensive payload size cap in the builder (reject and log rather than
  silently send an unbounded body — rate/size limiting at the receiving endpoint is a separate, infra-side
  concern outside this repo).

**Residual, accepted, stated-not-solved risk**: cross-household correlation *within the maintainer's own
corpus* is inherent to the feature being useful at all (a household that submits many nights necessarily
builds a stable behavioral shape under its own pseudonym) — the only realistic re-identification path is
an *out-of-band* join, e.g. the same household separately files a GitHub issue or forum post around the
same time as a recognizably-shaped batch. No technical scheme defeats this; it belongs in the privacy doc
as a named, accepted limit, not implied away.

**The shared anti-abuse header/secret baked into the published image is not authentication** — anyone can
read it from the repo or extract it from the container. It exists purely to filter incidental internet
noise (bots hitting a random open endpoint) off a solo maintainer's low-value target, and the docs must
frame it that way rather than imply it's a security boundary.

## Consent and lifecycle — gaps found in design review, addressed here rather than left implicit

1. **Caregiver visibility.** The toggle itself is admin-write-only (matches every other integration
   setting), but `GET /settings` deliberately serves caregivers only `PUBLIC_FIELDS`
   (`settings.js:29-63`) and `Settings.jsx`'s `ADMIN_ITEMS` (line 55) gates the whole settings sub-page —
   so a caregiver/nanny with a non-admin login would have no way to discover that a child they help care
   for has sleep data leaving the network. Add a **caregiver-visible, read-only** status line (on the
   child's Sleep page or Account page — exact placement is a product call) stating on/off. Same
   GET-vs-PUT audience split `settings.js` already establishes; reuse it.
2. **Retroactive scope on first enable.** Because `sleep_reviews` is never pruned, turning the toggle on
   could sweep up a household's entire historical labeled dataset — possibly months — in the very first
   batch, not "share going forward" as a toggle usually implies. Make this an explicit, informed choice
   in the enable flow (share history too, yes/no), and have the Phase 1 preview show *how much* history
   is eligible today (count + earliest date) so the choice isn't abstract.
3. **Revocation.** There's no account to log into and delete against, by design — so the household needs
   (a) their own pseudonymous share ID visible/copyable somewhere in the app, to reference in a deletion
   request, and (b) a documented contact path for that request (reuse `SECURITY.md`'s private-reporting
   channel, or a dedicated one). State plainly what disabling the toggle does and does not do (stops
   future sends; does nothing to data already sent) — silence here is the same "claim needs stating"
   problem CLAUDE.md calls out for code, applied to policy.

## How the data actually travels, and where it would go

**How**: the exact shape of every existing notification send. A new `backend/src/lib/sleepShareUpload.js`
builds the payload (via the single shared builder below), POSTs JSON through `httpNotify.js`'s
`postWithTimeout()`, fire-and-forget with `logger.error` on failure and **no retry** — the next scheduled
tick just tries again with the same unsent batch, so the cursor only advances on confirmed success. No
compression: nothing in this backend uses gzip/zlib today, and a minimized, label-only payload is small
enough that introducing that convention isn't justified yet. Scheduling reuses `startSleepJob()`'s idiom
via `safeInterval` (async-safe), wired into `index.js` start/stop next to the other periodic jobs.

**One builder function, called from two places** — this is the load-bearing design choice for trust: the
Phase 1 preview route and the Phase 2 upload job call the *exact same* `buildSleepSharePayload()` in a
new `backend/src/lib/sleepShareExport.js`. What a household previewed and what actually gets sent can
never drift apart, because it's the same function either way (tested directly — see Tests).

**Where**: the destination is a **fixed constant the maintainer controls** (closer to how Pushover
hardcodes its own API host, `pushover.js:11`, than to how ntfy lets each household point at their own
server) — read from `process.env.SLEEP_SHARE_ENDPOINT` with **no baked-in default**, so the feature ships
inert (present in the code, like Pushover before a token is configured) until the maintainer actually
provisions and sets a real endpoint. That decouples *mergeable* (this plan's code, tested against a mock
endpoint) from *user-visible* (a real default URL, which is the maintainer's own infra decision, outside
this repo). Three concrete options for that endpoint, ranked:

1. **Recommended: a small Cloudflare Worker + R2 bucket**, storing each batch at
   `<pseudonym>/<batch-id>.json`. Serverless, near-zero ongoing maintenance for a solo maintainer, a
   generous free tier at this data volume, TLS/basic DDoS handled by Cloudflare. The Worker's only job is
   checking the anti-noise header and basic shape/size validation before writing to R2.
2. Presigned-URL variant (a function issues a short-lived signed PUT URL, Nightlight PUTs directly to
   storage) — technically avoids the Worker ever parsing untrusted JSON, but adds a second round-trip and
   a moving part for marginal benefit given sends are already fire-and-forget with no retry. Skip unless
   that specific property matters to the maintainer.
3. Committing batches into a private GitHub repo via the API — weakest option: rate-limited, awkward to
   query later, and commit history retains every version forever, which actively works against the
   revocation/deletion story above. Included for completeness, not recommended.

This is genuinely infrastructure outside this repo — this plan builds the app-side code against an env
var and a mock endpoint in tests; standing up the real Worker/bucket is a separate, later decision for
the maintainer once they're happy with what ships here.

## Phasing

**Phase 1a — label-only local preview, no context window, no network code, no settings column.**
`sleepShareExport.js`'s `buildSleepSharePayload()` (verdicted transitions + reviewed nights, minimized
and relativized per above) plus `sleepShareId.js` (the local HMAC salt). New route
`GET /sleep-share/preview` (admin-gated, same `requireAuth`/`requireAdmin` shape as every other admin
route) returns the bundle. Frontend: `SleepShareCard.jsx` clones `DiagnosticsCard.jsx`'s download-state
machine exactly (idle/busy/done, native file-export handling) — **its UX shape, never its field-selection
code**, plus new copy stating what's excluded and why. New settings sub-page,
`SettingsSleepShare.jsx`, added to `Settings.jsx`'s `ADMIN_ITEMS` and `App.jsx`'s routes the same way
`/settings/logs` is. **No settings column needed at this phase** — nothing leaves the device, so there's
no "was this exported" question yet to answer durably; adding one now would be a migration in service of
a question nobody can ask yet.

**Phase 1b — add the numeric context window.** Bounded `activity_samples` window (motion/sound
peak/mean/percentiles) around each labeled event, `null` when already pruned per the data-availability
gap above — its own boundary tests, reuses 1a's harness and route. Kept separate from 1a so each ships as
a small, fully reviewable increment, not because it needs a different infra story.

**Phase 2 — the actual opt-in upload.** `settings.sleep_share_enabled` (guarded `ALTER TABLE`, default
0, the same off-by-default convention every outward-facing toggle in this schema already follows). A new
send-log table (batch id, sent-at, night/transition counts, ok/fail) rather than cramming cursor state
into `settings` — this single table serves as the cursor, the "what has actually been sent" record a
household can see, and the anchor for a revocation request. The enable flow asks the retroactive-history
question explicitly. `sleepShareUpload.js`'s `startSleepShareJob()`/`stopSleepShareJob()` via
`safeInterval`, wired into `index.js` alongside `startSleepJob()`/`stopSleepJob()` and into the grouped
`shutdown()` list. Docs land here (see below), since this is the phase where the "no cloud" claims
actually need qualifying — 1a/1b never send anything, so those claims stay true through them.

**Deliberately not in this plan**: actually provisioning the Cloudflare Worker/R2 bucket (or whichever
option is chosen) — real infrastructure outside this repo, for the maintainer to set up once ready;
fixing `routes/diagnostics.js`'s existing `children.name`/`birthday` leak (real, pre-existing, unrelated
bug — worth its own issue, not folded in here); differential privacy / k-anonymity (rejected above);
picking a Phase 2 upload interval/cadence beyond "reuse `startSleepJob`'s idiom" (a tuning question once
there's a real endpoint to tune against).

## Tests

Two existing patterns in this repo do almost all of the work here — reuse them directly rather than
inventing new mechanisms:

1. **Schema-derived classification, all seven touched tables** (`children`, `cameras`, `settings`,
   `bed_transitions`, `sleep_reviews`, `sleep_nights`, `activity_samples`): `PRAGMA table_info()`,
   regex-flag any column matching `/pass|secret|token|cred|auth|url|user|name|photo|note|email|phone|
   birthday/i`, require every flagged column to be in an explicit `SEND_ALLOWED` (with a one-line reason)
   or `SEND_BLOCKED` set — anything unclassified fails the test. This is the exact mechanism that would
   have caught `diagnostics.js`'s leak, and the one guard that survives a future migration nobody
   remembers to update this export for.
2. **Planted-marker whole-payload sweep**, `cameras-assign-exposure.test.js`'s technique: seed a fixture
   household where every excluded field carries a distinct `LEAK-<field>` marker (names, birthday, photo,
   camera name, every credential column, `sub_rtsp_url`, `snapshot_url`, `timezone`, `sleep_reviews.note`)
   plus real (non-marker) UUIDs. Build the real payload, stringify it, assert no marker and no real UUID
   substring appears anywhere — one aggregate assertion plus per-field ones. Also plant a
   `transition-snapshots`/`detection-snapshots`-path-shaped marker to prove no file path is ever
   serialized.
3. **Minimization-boundary tests with a mutation check**: N verdicted + M unverdicted transitions →
   payload count is exactly N; a night with full `activity_samples` coverage but no verdict/review nearby
   → zero rows from it appear. Per CLAUDE.md's own rule, mutate the builder to include
   `activity_samples` unconditionally and confirm the test fails — proves "never raw continuous data for
   its own sake" rather than just asserting it.
4. **1b boundary tests**: the context window's edge enforced exactly (a row at the boundary excluded, one
   minute inside included — this repo has a documented off-by-one history in exactly this shape); a
   `sleep_reviews` row whose `true_onset_transition_id` points at an already-pruned `bed_transitions.id`
   (a real reachable state given how the two retention rules interact) → the builder omits it gracefully,
   doesn't crash the batch.
5. **Anonymization unit tests**: HMAC pseudonym deterministic for (id, salt); two different
   locally-generated salts on the same real id produce uncorrelatable pseudonyms; the raw salt never
   appears in the stringified payload (same plant-and-sweep technique); timestamp relativization tested
   across a DST-observing non-UTC timezone (not just Melbourne/UTC), reusing `sleepAnalysis.js`'s
   existing DST-safe helpers rather than reimplemented arithmetic — this repo's own `04:00Z`-in-Melbourne
   incident is exactly this bug class.
6. **Structural sweep**: recursively walk the built payload and assert no string value matches an
   ISO-8601 date/datetime pattern anywhere — the one test here that's forward-compatible in CLAUDE.md's
   specific sense (it catches a future field carrying an absolute timestamp even with no marker written
   for it).
7. **Route-level (1a)**: `GET /sleep-share/preview` is admin-gated; a test stubs/spies `global.fetch` and
   asserts it is **never called** — a structural proof Phase 1 cannot leak over the network even by
   accident, not just a comment saying so.
8. **Lifecycle (Phase 2)**: add the new job to `suite-exits-cleanly.test.js`'s `PERIODIC` array (~line
   163) — the single most likely thing to be forgotten, per that file's own history of exactly this
   miss three times already.
9. **Failure handling (Phase 2)**: mock the POST to reject/timeout; assert `logger.error` not a throw,
   process doesn't crash, and — critically — the send-log cursor is **not** advanced on failure, so the
   next tick retries the same batch.
10. **Preview/upload parity (Phase 2)**: intercept the real outbound call and assert the posted bytes
    equal `JSON.stringify()` of what the Phase 1 preview route returns for the same DB state — the actual
    proof that preview and upload can't drift apart, not an assertion of it.
11. **Coverage**: add `sleepShareExport.js` (and `sleepShareUpload.js` once it exists) to
    `backend/package.json`'s `test:core` include list — this is now one of the most privacy-sensitive
    modules in the repo and belongs at the same bar as `sleepAnalysis.js`/`bedTransitionRules.js`.
12. **State the negative space in the PR**, per CLAUDE.md: this suite proves the payload the *code*
    builds is clean; it proves nothing about how the maintainer's receiving infrastructure handles it
    once uploaded — that's outside this repo's test boundary, and the PR should say so rather than imply
    otherwise.

## Docs (Phase 2, when data can actually leave the device)

- New `docs/sleep-data-sharing.md`, modeled on `docs/notifications.md`'s per-topic "Privacy note"
  structure: a table of what's collected vs. excluded, how to preview before enabling, the
  retroactive-history choice, what disabling does and doesn't do, how to request deletion, and the
  honest "anti-abuse, not authentication" framing of the shared header.
- Edit the three existing "no cloud" claims so they stay true rather than silently false:
  `README.md:9`, `docker-hub-overview.md:3-5`, `docs/README.md:77-78` — qualify each to name this one
  explicit, off-by-default, previewable-before-enabling exception, matching the parenthetical shape
  `docs/README.md:77-78` already uses for the existing push providers.
- `SECURITY.md`: add `.sleep_share_salt` to the "never paste this" list and the credential-rotation
  section (mirrors the existing `.jwt_secret` entries exactly — rotating it breaks the link between
  future and past batches, same idea as JWT rotation invalidating sessions).
- `CHANGELOG.md`: Phase 1a/1b entries under `### Added` note this is local-only, nothing uploaded; the
  Phase 2 entry is the one that needs the most care in wording, since it's the one that actually changes
  what leaves the network.

## Verification

1. `cd backend && node --experimental-test-module-mocks --test test/sleepShareExport.test.js` (1a/1b) —
   new tests pass, including the planted-marker sweep and the mutation check described above.
2. `cd backend && node --experimental-test-module-mocks --test test/*.test.js` — full suite green,
   including the edited `suite-exits-cleanly.test.js` (Phase 2).
3. `cd backend && npm run test:core` — coverage gate, with `sleepShareExport.js` added to the include
   list.
4. `node scripts/mutate.mjs --only="sleep share"` — new mutants killed, especially around the
   minimization boundary and the HMAC pseudonymization.
5. `node scripts/check-changelog.mjs` passes.
6. Manual: hit `GET /sleep-share/preview` against a real seeded dev DB with a mix of verdicted/
   unverdicted transitions and reviewed/unreviewed nights, and actually read the returned JSON —
   the same "look at the picture before theorising" discipline this repo already applies to bed zones
   applies here to a payload about to leave someone's home.
7. This touches `db.js`, and (Phase 2) a new periodic network job — both core-logic-adjacent. The
   standing adversarial pre-merge review (Codex + a parallel Claude subagent) is mandatory before merging
   any phase to `dev`, per `CLAUDE.md`, and should be pointed explicitly at the anonymization claims by
   name (per CLAUDE.md's "a claim is a hypothesis until a test fails without it" — falsify each excluded-
   field claim specifically, don't let a generic review read them as given context).
8. Phase 2 additionally needs the maintainer to decide and provision a real destination (see "How the
   data actually travels, and where it would go") before the feature is user-visible — the code ships
   inert (env var unset) until then, same posture as Pushover before a token is configured.

### Critical files
- `backend/src/lib/sleepShareExport.js` (new) — the shared payload builder
- `backend/src/lib/sleepShareId.js` (new) — local HMAC salt, mirrors `middleware/auth.js:15-33`
- `backend/src/routes/sleepShare.js` (new) — `GET /sleep-share/preview` (1a), `/config` (Phase 2)
- `backend/src/lib/sleepShareUpload.js` (new, Phase 2) — `startSleepShareJob`/`stopSleepShareJob`
- `backend/src/db.js` — new guarded migration block (Phase 2: `sleep_share_enabled`, send-log table)
- `backend/src/index.js` — Phase 2 job start/stop wiring
- `backend/test/sleepShareExport.test.js`, `backend/test/sleepShare-route.test.js` (new)
- `backend/test/suite-exits-cleanly.test.js` — edited (Phase 2, `PERIODIC` array)
- `backend/test/cameras-assign-exposure.test.js` — pattern reference, not edited
- `frontend/src/components/SleepShareCard.jsx` (new) — clones `DiagnosticsCard.jsx`'s UX shape
- `frontend/src/pages/SettingsSleepShare.jsx` (new), `Settings.jsx`/`App.jsx` — edited (routing)
- `docs/sleep-data-sharing.md` (new, Phase 2); `README.md`, `docker-hub-overview.md`, `docs/README.md`,
  `SECURITY.md` — edited (Phase 2)
