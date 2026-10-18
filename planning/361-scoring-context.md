# #361 — Preserve the scoring context of a stored night (design)

Status: design only. No code, schema or changelog in this PR. Tier T0 for the doc; the
implementation it describes is **T2** (stored sleep numbers, schema, ordering).
Related: #675 (let signed-in users reorder the live grid again).

Citations are `file:line` against `origin/dev` at the time of writing (v0.40.0 package, commit
`992fa75`). Anything I did not trace end to end is marked **(unverified)**.

## 1. The problem in one paragraph

A stored `sleep_nights` row records the *answer* (times, minutes, status) but not the *question*:
which camera, which window, which timezone, which algorithm produced it. Every later read that
re-runs the analysis uses whatever those are *today*. #361's observed case — a stored `ok` night turning
into `no_data` after its only camera was disabled while its samples still exist — is a symptom of that.
Only the first four are stored nowhere; the fifth (the input samples) simply ages out.

## 2. What decides a night's score today

`computeNight(childId, nightDate)` (`backend/src/lib/sleepAnalysis.js:729`) reads, on every call:

| Input | Where it is read | Can it change after the night? |
|---|---|---|
| App timezone | `appSettings().timezone`, default `'UTC'` (`sleepAnalysis.js:317-321`, used `:730`) | Yes — a global setting. |
| Child's window start/end and `track_sleep` | `childSleepConfig` (`:326-333`), defaults 19:00 / 07:00 | Yes — per-child setting. |
| Window → UTC bounds | `windowBoundsUtc` (`:456`), DST-safe | Follows the two rows above. |
| Which camera is scored | `primaryCameraRowFor(childId, { tieBreak: 'id' })` (`:777`, `lib/primaryCamera.js`): the admin-named `children.primary_camera_id` while that camera is still the child's and enabled, else the enabled camera with the lowest `sort_order`, ties by `id` | Yes, four ways: reassign the camera to another child; disable it; change the primary; drag a tile (`sort_order`) for a child on Automatic. |
| Context cameras (climate only) | `SELECT id FROM cameras WHERE child_id = ?` (`:775`) | Yes (reassignment). Affects `avg_temperature`/`avg_humidity`, not times. |
| Input samples | `activity_samples` for the one camera, from `window_start - 3h` to `min(now, window_end + 3h)` (`:207`, `:128`, query at `:~830`) | They are *pruned after 30 days* (`lib/activityTracker.js:57`, `:576-583`). |
| Bed transitions | `bed_transitions`, keyed by camera id; unjudged rows age out (`lib/bedTransitions.js:~72`, comment says 45 days **(unverified: constant not re-read)**) | Pruned; reviewed rows are exempt. |
| Thresholds / algorithm | module constants (`sleepAnalysis.js:24-347`) | Yes — every release. No version is recorded anywhere (grep `ALGO_VERSION`/`algorithm` finds nothing). |
| The clock | `Date.now()` caps an open night (`:735-741`); the departure scan looks `WAKE_LOOKAHEAD_MS` (3 h, `:128`) past `window_end` | By design: evidence is "final" at `window_end + 3h` (`isEvidenceFinal`, `:491`). |

The code is explicit that this is currently *deliberate*: the comment at `sleepAnalysis.js:761-764` says
re-scoring on a camera change "re-scores any night that is computed again" and that "`sleep_nights` does not
record which camera that was (`analysis_camera_*` below is on the computed result only)".

### Who re-computes a stored night (and so can silently use a new context)

* The nightly job re-stores the last completed night until the row's own `computed_at` passes the evidence
  horizon (`runNightlySleepJob`, `:2598`; gate `:~2655`). After that the row is frozen.
* `storeNightBeforeCorrection` (`:2452`), only for the last completed night, before a parent's correction.
* The admin "Recompute" route (`routes/children.js:306-440`, `?store=1`).
* Every **fresh read** that is not `?stored=1`: the detail page (`routes/children.js:342`), `/sleep/live`
  (`:254`), the morning review (`:284`). These do not write, but they *show* a number that differs from the
  stored row, which is the #361 symptom.
* A night a parent has corrected is locked (`nightIsLocked`, `:~2262-2300`); the overlay in
  `lib/sleepReviews.js` reads `sleep_nights`, never recomputes it.

Related, already built: `sleep_reviews.computed_onset_at / computed_wake_at` record what the app *said* when a
night was judged (`db.js:232-239`). That is the same idea for the review table; this design is its
counterpart for `sleep_nights`.

## 3. What to store per night

One new nullable `TEXT` column on `sleep_nights`, `scoring_context`, holding small versioned JSON written
by `upsertNight` (`sleepAnalysis.js:2212`):

```json
{ "v": 1,
  "camera_id": "<analysis camera id>",
  "camera_source": "primary|auto",
  "tz": "Europe/London",
  "window": { "start": "19:00", "end": "07:00" },
  "algo": "<algorithm tag>",
  "evidence_cutoff": "2026-10-05 10:00:00",
  "scored_at": "2026-10-05 10:03:11" }
```

* `camera_id` is the *identifier only* — the already-computed `analysis_camera_id` (`:~800`). The name can
  change and is looked up live; storing it adds a copy that can drift.
* `tz` and `window` are stored because the UTC bounds are already in `window_start/window_end`, but the
  *intent* (so a replay can rebuild the bounds, and a UI can say "scored with 19:00-07:00") is not.
* `algo`: a short tag bumped by hand when a threshold or rule changes the output of `computeNight`. Not the
  app version (which changes without touching the algorithm). Needs an owner decision, see §8.
* `evidence_cutoff` is derivable from `window_end` (`isEvidenceFinal` comment, `:487-490`: deliberately *no*
  stored flag, to avoid a second source of truth). Keep it out of the JSON in v1 unless a reason appears.
  Likewise `scored_at` duplicates `computed_at`. **Recommended v1 payload: `v`, `camera_id`, `tz`, `window`,
  `algo`.**

**What NOT to store**

* Camera name, stream URLs or any credential (public-repo and secret rules; names can identify a household).
* The samples themselves in this column. Retention of replayable inputs is a separate question (§7).
* Per-threshold values. They are code, versioned by `algo`; copying 40 constants invites drift.
* A child's name or any household detail.
* Review/verdict data (already in `sleep_reviews`).

## 4. How recompute should use it

Rule: **recomputing a night that has a `scoring_context` uses that context, unless the caller asks for the
current one.**

* Add an optional `context` argument to `computeNight`, defaulting to "resolve now" (today's behaviour, and
  the behaviour for any row with NULL).
* `computeAndStoreNight`/nightly job: a *provisional* night (inside its 3 h evidence window) keeps resolving
  the context live — the existing "a provisional row may improve" behaviour — and writes the context it used.
  Once final, the row is frozen anyway.
* The admin Recompute route gets an explicit choice: "re-score with the settings this night used" (default for
  a night that has a context) vs "re-score with current settings" (the existing behaviour, and the only
  option for a NULL row). The response says which was used and, additively, returns the stored context next to
  the current one so the UI can show "originally scored from <camera>, current is <camera>".
* Fresh reads (`/sleep/:date`) keep today's behaviour in PR 1 and are only switched in a later PR, because
  they feed user-visible numbers and are the product decision #361 itself flags ("partly deliberate").
* If the stored camera no longer exists or has no samples left: say so (`status: 'no_data'` plus a reason),
  never fall back silently.

## 5. The additive migration

Same pattern as every other column (`db.js:856-922`): `PRAGMA table_info(sleep_nights)` then a guarded
`ALTER TABLE sleep_nights ADD COLUMN scoring_context TEXT`. Idempotent; existing rows get `NULL`; `NULL` means
"unknown provenance" and every code path treats it as today. No backfill (we cannot know the old camera —
inventing one would be worse than NULL). New `upsertNight` writes always populate it; the `ON CONFLICT` list
(`:2222-2233`) gains the column.

Also required by the repo's own guards: the sleep-claim classification test in `lib/sleepReviews.js:756-760`
fails on an unclassified new `sleep_nights` column — classify it as "not a sleep claim".

## 6. What it unblocks

* **#675.** The live grid reorder is admin-only because dragging a tile can change which camera a stored
  number comes from (`routes/cameras.js:728-737`, comment). Once a stored night carries its camera, a drag can
  no longer change what an *existing* row means; it can still change what an *open* night resolves to, so the
  narrow rule in #675 (refuse a reorder that changes the first enabled camera of an Automatic child) is
  still needed for the in-progress night. This design makes that restriction defensible and reduces its
  blast radius; it does not remove it.
* Honest "this night was scored from X" in the UI, and the #361 replay scenarios (§7).
* Safer algorithm upgrades: a night scored by `algo` N can be shown as such after N+1 ships.

## 7. Tests that would prove it

Real DB, no mocks (`backend/test/helpers/harness.js`). Each should be watched failing first.

1. Migration: a database created without the column gains it; running twice is a no-op; existing rows read
   `NULL`; a `NULL` row recomputes exactly as before (golden compare against the current output).
2. A scored night stores `camera_id`, `tz`, `window`, `algo`; no camera name or credential appears in the
   column (plant a recognisable camera name and a password, assert absent).
3. After scoring: disable the camera → fresh read changes (today), "recompute with stored context" does not
   report `no_data` while the samples exist (the #361 case). Same for: reassign the camera, change the primary,
   reorder tiles, change the window, change the timezone. One test per trigger, asserting the *number*.
4. "Recompute with current settings" still gives today's answer (the explicit opt-in).
5. Stored camera deleted → explicit reason, no silent fallback.
6. A night whose context says algo N while the code is N+1 is labelled as such (no re-score in the read path).
7. Locked (corrected) nights stay untouched.
8. Mutants (T2, one per behaviour): "recompute honours stored camera"; "provisional night refreshes context".

Evaluation-retention part of #361 (exporting exact samples before the 30-day prune,
`activityTracker.js:576`) is **not** covered by the column and needs its own design: size per night,
whether to export on review or on demand, and where it lives (a table that is exempt from pruning, as
`bed_transitions` judged rows are, `bedTransitions.js:~72`). Out of scope for the first PRs.

## 8. Risks

* **Changes a stored number's meaning** — T2. A night "frozen" to an old camera can be *worse* than the
  fresh one if the old camera was mis-zoned; the UI must show provenance, not just freeze.
* **Provisional vs final**: freezing the context on the first (provisional) write would pin the wrong camera
  if the admin fixes it inside the 3 h window. Hence: context updates on every provisional write.
* **Ordering/concurrency**: the nightly job, `storeNightBeforeCorrection` and the admin route can each write
  the row; the context must be written in the same statement as the numbers, never separately.
* **Row size / privacy**: a few hundred bytes; ids only; public repo, so tests must not use real names.
* **Everyone else's install**: nothing here is calibrated to one house; `algo` is a label, not a threshold.
  Known limit: pre-migration rows stay NULL forever and cannot be replayed with certainty.
* **Docs drift**: `docs/architecture.md` and the sleep docs describe "recompute"; they need the new wording.

## 9. Implementation order (small PRs)

1. Column + migration + write `camera_id/tz/window/algo` in `upsertNight`; sleep-claim classification; docs
   line; tests 1-2. No behaviour change. (T2: schema.)
2. `computeNight` accepts an explicit context; nightly job passes none (unchanged). Tests 3-4 at the
   function level. (T2.)
3. Admin Recompute route: choose stored/current; additive response fields; route-permissions pin unchanged
   (same gate). UI shows original vs recomputed. Tests 5-6. (T2.)
4. Decide and (maybe) switch fresh reads to the stored context. Product decision first.
5. #675: the narrow reorder rule, built on top. (T2, its own issue.)
6. Separate track: retained evaluation sets (export before prune).

## 10. Questions only the owner can answer

1. **Should a final night's fresh read use its stored context by default?** (Fixes the #361 symptom; changes
   what the detail page shows after a camera change.) Or keep "always current" and only add provenance?
2. How is `algo` bumped — by hand per scoring change, or derived (hash of the constants)? Hand-bumped is
   simple but forgettable; a hash flags harmless edits.
3. Should the stored `tz`/window apply when a provisional night is recomputed after the user *intentionally*
   fixes the window mid-night? (Proposed: no, provisional nights re-resolve.)
4. Keep admin Recompute's current behaviour as the default and make "use stored context" opt-in, or the reverse?
5. Retention for replay fixtures: which nights, how long, stored where?
6. For #675: refuse the narrow reorder, or keep it admin-only until every multi-camera child has a primary?

## 11. Not verified

* The 45-day `bed_transitions` age constant and the exact line of the samples query.
* Behaviour of the morning review route beyond `routes/children.js:284`.
* That no other writer of `sleep_nights` exists outside the greps in `lib/` and `routes/` (a grep of
  `sleep_nights` shows `entityPurge.js:289` DELETE and `demoSeed.js` only).
