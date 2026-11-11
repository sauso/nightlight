# Sleep Score and Night summary: plan

**Status: approved 2026-11-11. Phases 0 to 3 are in progress; phases 4 onward wait until the score has
been used on staging.** Roadmap entry: [`ROADMAP.md`](ROADMAP.md) §1.8.

## What this is

A nightly Sleep Score (0-100) for each child and a short plain-language summary of the night, shown on
the child's sleep card and the sleep detail page. The score compares a night with the child's own
recent nights; the summary describes what was measured and nothing more.

A first draft of this plan was read by four reviewers and a revised draft by a fifth. Their findings
changed the design substantially; "Review record" at the end lists what changed and why, so the
discarded designs are not proposed again.

Paths below are relative to the repository root. Line numbers were checked against `dev` at
`f9b7ea47` and will drift; the function names are the durable reference.

## Decisions already made

These were settled by the maintainer before the design was written and are not open for review.

- Scope is the child's sleep card and sleep detail page only. A wider redesign of the other screens
  is a separate item (roadmap §3, F1).
- Nights only, no naps. Crying is ignored for now. Movement, and possibly sound, are the inputs.
- Components for v1: duration, continuity, settling, restlessness, consistency. Room conditions,
  "disruptions" and self-settling rate are NOT scored in v1.
- Baseline: the child's own history; comparisons start at 7 nights and the window grows to 14. Age is
  only a fallback before a baseline exists.
- Parent corrections change the score. The score carries a formula version.
- Labels "Great", "Good", "Fair" for the upper bands; the lowest band shows the number with no word.
- No score while a night is in progress. The "so far" summary is live.
- Summary is built from a phrase library. An LLM is one later, optional phase; its first form is a
  user-supplied Ollama/OpenAI-compatible endpoint, not a bundled model.
- Name: "Night summary". Descriptive only: no causes, no advice.
- Never claim REM, deep or light sleep. No emoji in the UI (the app uses `lucide-react` icons).
- Start building and tune on staging as we go.

## What already exists

- **Stored per night** (`sleep_nights`, `backend/src/db.js:258` plus later `ALTER`s): `in_bed_at`,
  `onset_at`, `wake_at`, `asleep_minutes`, `awake_minutes`, `unknown_minutes` (unwatched minutes
  inside the sleep span), `wake_count`, `longest_stretch_minutes`, `coverage_minutes`,
  `avg_temperature`, `avg_humidity`, `wake_unconfirmed_at`, `status`, and `scoring_context`
  (camera, timezone, window and rules version the night was scored with).
- **Corrections** live in `sleep_reviews`, overlaid at read time by `applyCorrection`
  (`backend/src/lib/sleepReviews.js:721`). A time correction re-derives `asleep_minutes` only. A
  detector-"empty" night given two times by the parent is promoted to `ok` with wakes 0 and longest
  stretch equal to the span (`asScoredFromEmpty`, `:810`): figures that were not measured.
- **Stirring** is only a detail-view label (`backend/src/lib/sleepAnalysis.js:3173`): an active minute
  inside the sleep span that is not part of a counted wake. "Active" includes movement outside the bed
  and sound (`isActiveRow`, `:1550`). It is not stored.
- **Raw data is short-lived**: `activity_samples` 30 days; unlabelled `bed_transitions` 45 days.
- **A night keeps changing for 3 hours after its window** (`runNightlySleepJob`,
  `sleepAnalysis.js:3947`; the wake time has been measured drifting by 160 minutes in that time).
  A corrected night is locked and never re-stored (`nightIsLocked`, `:3563`).
- **`in_bed_at` is often absent**: it exists only when an into-bed event fell within 45 minutes
  before sleep onset. The frontend hides it in some corrected cases (`frontend/src/lib/inBed.js`).
- **Child age**: `children.birthday`, optional; a future date is accepted. No sleep code reads it.
- **No baseline helper exists.** Closest patterns: `earlyExitThresholdMin` (`sleepAnalysis.js:1116`),
  `sleepInsights` (`:3804`).
- **Routes** (`backend/src/routes/children.js`): `/sleep/live`, `/sleep?nights=N`, `/sleep/:date`.
- **UI**: `SleepSummaryCard.jsx` (child card) reads the stored night, or a fresh compute for up to 30
  minutes after the window before the job has stored it. `SleepDetail.jsx` recomputes the night and
  can switch to "today's settings". The timeline already has a stirring state, a room-activity strip,
  into/out-of-bed markers, "so far" wording, coverage % and "Measured from <camera>". There is no ring
  component and no good/fair colour token. The child card is a fixed dark gradient in both themes,
  and is a single `<button>` whose `aria-label` hides its contents from screen readers.
- **Push report** wording is pinned by tests and quoted in the UI and docs (`sleepReportAlert.js:70`).
- **Roadmap**: idea A1 (weekly digest) is replaced by phase 5 below; A2 (climate correlations) has
  shipped; §2.2 cry classification is specced, not built.

## Design

### 1. The score is computed on read, not stored

```
night object an endpoint is about to return   (stored row + correction overlay, or a fresh compute)
        |
        +--> sleepBaseline(child, this night)      pure read over stored nights
        |
        v
scoreNight(night, baseline, ageMonths)             pure function, versioned config
        |
        v
selectSummary(night, baseline, score)              pure function
        |
        v
response gains { score, summary }
```

Every endpoint scores the exact night object it returns. Consequences:

- The score always matches the numbers shown beside it, on the card, on the detail page, and under
  "today's settings".
- A parent who opens the app five minutes after the window closes gets a score.
- A corrected night is rescored on the next read. A correction to an older night flows into later
  nights' baselines on the next read. A tuned formula applies to every night at once. None of these
  needs a write hook, a backfill or a transaction.
- A past night's score can change when the formula is tuned. That is intended while tuning on
  staging. A frozen history table is deferred to the trends phase, if it is wanted then.

**One normalised input.** A stored row and a fresh compute have different shapes (a stored row has
`scoring_context` and `wake_unconfirmed_at`; a fresh compute has `analysis_camera_id` and
`wake_unconfirmed`). `toScoringInput(night)` in `sleepScore.js` turns either into one object: the
figures, the context the night was actually computed with (camera, timezone, window), whether the
wake is confirmed, what was corrected, and whether it came from the stored row. A replay's context
is never guessed from today's settings.

**One eligibility rule per metric.** `toScoringInput` also decides, per metric, whether the value is
usable (for example: stir rate and longest stretch are not usable when a correction changed the
span; settling is not usable when the UI would hide the in-bed time). The SAME function feeds both
the night being scored and every night that contributes to the baseline, so a figure rejected for
scoring can never enter a baseline.

**Old nights on the detail page.** When the detail page's recompute returns `no_data` because the
raw samples have expired but a stored row exists, the score and summary come from the stored row and
the page says the timeline is no longer available.

### 2. Two new stored fields (the only schema change, and the urgent part)

Raw samples are deleted after 30 days, so anything the score or summary needs from them must be
saved when the night is stored. Every night before this ships loses them for good.

- `sleep_nights.stir_minutes` (nullable integer): minutes inside the sleep span with in-bed movement
  that were not part of a counted wake. In-bed movement only: no sound-only minutes, no movement
  outside the bed, nothing in the 30-minute post-onset grace. (Household noise must not read as a
  restless child.)
- `sleep_nights.summary_facts` (nullable JSON) with two separate parts:
  `climate` (temperature min and max) and `sleep` (the start and length of each COUNTED wake, so the
  list always agrees with `wake_count` and excludes the morning-wake row the detail view adds; and
  the number of those wakes with room activity around them).

Both are computed in `computeNight` and written by `upsertNight`. Correction rules:

- "Nobody in bed": `stir_minutes` and `summary_facts.sleep` are nulled (both join the nulling list
  in `sleepReviews.js`; the schema-driven shape test enforces the column). `climate` survives.
- A time correction: wakes outside the corrected span are filtered out before the summary sees them.
- A corrected night is locked and never re-stored, so its facts stay as the detector measured them.

No existing output changes.

### 3. Baseline (`backend/src/lib/sleepBaseline.js`, new)

`sleepBaseline(childId, night)` uses the newest 14 stored nights strictly before the night, within
28 days, corrections overlaid, that are `ok`, not "nobody in bed", not promoted from "empty", with
at least 80% window coverage, **and whose `scoring_context` camera and sleep window match the night
being scored**. A camera or window change therefore restarts the baseline. Rows stored before
`scoring_context` existed (NULL) do not qualify.

It returns, for each metric, a median and the number of nights behind it: asleep minutes, wake
count, awake minutes, longest stretch, settling minutes, stir minutes per hour asleep, and onset and
wake clock time. Details:

- **Readiness is per metric: a median needs at least 7 usable values of that metric.** Seven
  qualifying nights of which one has `stir_minutes` do not make a restlessness baseline. So after
  phase 1a ships, restlessness becomes available about a week later, not at once. When the duration
  median is not ready, duration falls back to the age figure, or the score is withheld.
- Nights with no confirmed wake (`wake_at` null or `wake_unconfirmed_at` set), or with more than 15
  unwatched minutes, are left out of the usual duration: the first counts an empty bed as sleep, the
  second under-counts it.
- Clock times are local minutes since 12:00 noon, computed in **each night's own stored timezone**
  with the DST-safe helpers in `sleepAnalysis.js`.
- Medians, not means: one unusual night must not move the baseline.

### 4. Score (`backend/src/lib/sleepScore.js`, new)

`scoreNight(night, baseline, ageMonths)` returns `{ score, band, version, provisional,
low_confidence, capped_by, components: [{ key, score, weight, available, reason, value, usual }] }`,
or `{ score: null, reason }`.

| Component | Weight | Measured from | Reference |
|---|---|---|---|
| Duration | 35 | `asleep_minutes` | Baseline median when ready; before that, a night-sleep figure for the child's age |
| Continuity | 30 | efficiency (asleep / (asleep + awake)), `wake_count`, longest stretch as a share of the span | Absolute curves from 12 months; under 12 months, the child's own baseline only |
| Settling | 15 | `onset_at - in_bed_at` | Absolute curve |
| Restlessness | 15 | `stir_minutes` per hour asleep | Excess over max(child's usual, a floor); baseline only |
| Consistency | 5 | onset and wake clock time | Baseline only |

Rules:

- **Gradual curves.** Each component is piecewise-linear through a few anchors (duration: 100 at or
  above target, 50 at 90 minutes under, 0 at 4 hours under). No steps. All anchors, weights and band
  edges sit in one exported config object with a `SCORE_VERSION`.
- **Weakest-link cap.** The final score cannot exceed the continuity score plus 40, nor the
  restlessness score plus 40 when available. Without this, a night with six wake-ups and two hours
  awake still reads "Good", and constant stirring still reads "Great". `capped_by` names the
  component so the breakdown can say so.
- **Unavailable components are dropped and the rest rescaled.** Known limit, stated in the docs: a
  night where the put-down was not detected is not judged on settling, so it can score higher than
  the same night with a slow, detected settle. The evidence script (phase 1b) reports how often
  `in_bed_at` is missing; if it is common, phase 1b adds a lower-bound settle time instead.
- **No score** (with a reason the UI can show) when: the night is not `ok`; it is in progress; it was
  promoted from "empty" by a correction (its continuity figures were never measured); duration has
  no reference (no baseline and no birthday); or the child is under 12 months with no baseline.
- **Early estimate.** Until the baseline is ready the score is shown with no band word, marked
  "early estimate". This also softens the step when the reference switches from age to baseline.
- **Provisional.** A stored night is final when its own `computed_at` is at least 3 hours past the
  window end (the test the nightly job already uses, `isEvidenceFinal(window_end, computed_at)`),
  not merely when the clock has passed that point: the last refresh may still be owed. A fresh
  compute is final when it runs after that point. A corrected (locked) night is final. Otherwise
  `provisional` is true and the UI says the score may still change.
- **Low confidence** when window coverage is under 80%, `unknown_minutes` exceeds 15, or the wake is
  unconfirmed. Duration is ALWAYS scored on measured `asleep_minutes`, the same quantity the
  baseline uses; unwatched minutes are never credited as sleep (crediting them above a threshold
  would make losing one more minute of evidence raise the score). With more than 15 unwatched
  minutes the longest-stretch term is dropped, because a dropout resets it, and the breakdown says
  how many minutes were not observed.
- **Corrected times.** Handled by the per-metric eligibility rule in section 1: settling follows the
  UI's in-bed rule (mirrored from `inBed.js`); when a correction changed the span, the
  longest-stretch term and restlessness are dropped and longest stretch is clamped to the asleep
  total for display.
- **Age** is the child's age on the night's date; a negative age is treated as no birthday. Fallback
  figures must be NIGHT sleep, because common recommendations (AASM, NSF) are per 24 hours including
  naps. Phase 1b transcribes night-sleep figures by age from a published source (candidate:
  Iglowstein et al. 2003), checks that the source measures the same quantity as `asleep_minutes`,
  and cites it in the code and docs. Nothing is typed from memory.
- **Bands.** 85+ "Great", 70-84 "Good", 55-69 "Fair", under 55 no word.
- **Every number here is a starting value** tuned on two cameras in one house; comments and docs
  say so.

### 5. Night summary

- `backend/src/lib/nightSummary.js` picks a headline class and 2 to 4 observations in priority
  order and returns `{ headline: { key }, observations: [{ key, params }], seed }` with raw params
  (minutes, UTC timestamps, absolute degrees C, never a temperature difference).
- `frontend/src/lib/nightSummaryPhrases.js` holds the phrase library. It picks a variant with
  `hash(seed + key) % variants.length`, skips any key it does not know (a tab left open across a
  deploy), and formats with `lib/homeTime.js`, so the home timezone, 12/24-hour clocks, Fahrenheit
  and a renamed child all work.
- Observations in the first version: total sleep, total sleep vs usual, wake-ups, wake-ups vs usual,
  longest stretch, longest stretch vs usual, settling time, wake-up clustering, room activity around
  wake-ups, temperature range, reduced coverage, "still building a baseline", "no sleep detected".
  The last four come from `summary_facts` and are simply absent for older nights.
- Headline class (settled / typical / mixed / unsettled) is derived from the component scores, so a
  headline cannot contradict the score. The components are computed for this purpose even when the
  "Show sleep score" switch is off.
- **Nights with no score get a neutral headline** ("Last night's sleep", "Tonight so far") and only
  plain measured facts. A night promoted from "empty" says the times were entered by the parent and
  never says "settled" or "no wake-ups": its zero wakes were not measured. A night in progress never
  gets a whole-night judgement.
- Guardrail tests over the whole phrase library: no banned term (ideal, safe, healthy, badly, poor,
  because, parent, mum, dad, deep sleep, REM, light sleep, should); every placeholder is a declared
  param; an observation with a null param is never selected; new copy never contains the phrase
  "night timeline" (the docs screenshot run matches that text).
- The in-progress night gets the "so far" variants and no score.
- **Deferred decision:** the LLM phase needs wording on the server. When that phase is planned, the
  phrase library moves to a JSON file both sides read. Not done now.

### 6. API

Additive only: `/sleep/live`, `/sleep?nights=N` and every shape of `/sleep/:date` attach `score` and
`summary` (or `null`). When the child's "Show sleep score" switch is off, the server omits `score`.

### 7. UI

- **`ScoreRing.jsx`** (new): presentational inline SVG, one colour, no mount animation,
  `tabular-nums`, sizes from the design-language type scale. On `.card`: `--accent-line` on a
  `--border` track. On the dark child card: literal light indigo on a translucent white track
  (`--accent-line` is about 2:1 there in the light theme).
- **Child card**: small ring beside the duration line; the summary headline as one line; the score
  goes into the button's `aria-label` ("Sleep detail. Score 82, Good"). "Last night" stays.
- **Detail page**: a "Night summary" card under the date navigator, modelled on `.sleep-insight`.
  The ring sits in the summary card inside a real `<button>` of at least 44px with the visible text
  "How this is scored"; it opens a `Modal.jsx` sheet with the component bars (value and usual),
  the reason for each missing component, any cap, the provisional or low-confidence note, and an
  "About the sleep score" paragraph. A plain "No score yet" line gives the reason when there is none.
- **Per-child switch** "Show sleep score", default on, admin-only, beside the sleep-report switches
  (`children.show_sleep_score`, `CHILD_FLAGS`, `DRAFT_FIELDS`). Off hides the ring and breakdown; the
  night summary stays.
- **Wording**: the existing "Estimated from movement & sound... not a medical measurement" line is
  extended to cover the score.
- **Push report: unchanged in v1.** Its wording is pinned and the score is provisional when it fires.

### 8. Docs

`docs/sleep-tracking.md` gains a "Sleep score" section: what is measured, weights, bands, the cap,
what "usual" means, when there is no score, and every known limit below.

## Phases

One pull request per phase, each reviewed at its tier, merged to `dev` and deployed to staging.
Phases 4 onward start only after the score has been used on staging.

| # | Phase | Contents | Review tier |
|---|---|---|---|
| 0 | Documents | Roadmap tidy; this plan in `planning/`; roadmap entries | T0 (docs-only) |
| 1a | Save the raw facts | `stir_minutes`, `summary_facts`; nulling list; old-vs-new on both databases showing no existing figure moves. **Ship first and alone: every night without it loses restlessness for good.** | T2 (schema, `sleepAnalysis.js`) |
| 1b | Scoring maths | `sleepBaseline.js`, `sleepScore.js`, age table with citation, tests, and the evidence script. No schema, nothing user-visible. | T2 (a reported number) |
| 1c | API | attach `score` on read; `docs/sleep-tracking.md` | T1 |
| 2 | Score UI | `ScoreRing`; ring on card and detail; breakdown sheet; per-child switch; screenshots | T2 by rule (adds a `children` column); one reviewer |
| 3 | Night summary | selection on the server; phrase library and card in the browser; guardrail tests | T1 |
| 4 | Live night | "so far" summary; a true current state ("awake since") from the latest segment | T2 (`sleepAnalysis.js` output) |
| 5 | Trends | 7/14/30-day score and component trends; replaces roadmap idea A1; decide here whether a frozen `sleep_scores` table is wanted | T1 or T2 on that decision |
| 6 | Tappable timeline | tap a segment or dot for the event and its clip. Independent of the score; can be done at any time. | T1 |
| 7 | Optional LLM rewording | user-supplied endpoint rewrites the selected facts; validated; template fallback | separate plan |
| later | Needs new detection | cry classification (roadmap §2.2) and a reliable caregiver signal unlock "disruptions" and self-settling rate; score in the push report once it is stable | separate plans |

**Phase 1b evidence script**: scores every stored night on snapshots of the production and staging
databases (computed locally, on copies) and prints score, components, caps and inputs per night, plus
how often each component is unavailable and how widely the scores spread. The maintainer reads it
against what is remembered of those nights. Note: both databases hold the same two children and
cameras, so this is one household's evidence, not two independent samples.

## Known limits

These also go into the user docs (`docs/sleep-tracking.md`) with the feature.

- A parent's visit can be counted as the child's wake (roadmap §1.2 item 3).
- Sound from another room can be counted as a wake (roadmap §1.3).
- Scores are not comparable between children or rooms.
- A night with no detected put-down is not judged on settling.
- After a time correction, wake count and awake minutes are still the detector's.
- Nights stored before phase 1a have no restlessness, and never will.
- A camera or sleep-window change restarts the baseline: seven nights of "early estimate".
- Nothing validates that the painted zone sits on the bed.
- Naps are not tracked.
- A night with no sleep detected has no score at all.
- All weights and curves were tuned on two cameras in one house.

## Review record

Four reviewers read the first draft: Codex `gpt-6-sol`, agy, Opus, Sonnet. Changes made:

| Finding (who) | Change |
|---|---|
| Stored score beside recomputed numbers; no score for 30 minutes after the window; stale later scores; mixed formula versions; write could lag the night (all four) | Score computed on read; `sleep_scores` table, write hooks and backfill removed |
| Promoted "empty" night scores 100 (Codex, Sonnet, Opus) | No score for those nights; excluded from the baseline |
| Time correction leaves mismatched inputs; settle time the UI already hides (Codex, agy, Opus) | Span-dependent terms dropped; shared in-bed predicate; clamp |
| Broken or constantly stirring night still "Good"/"Great" (Codex, Opus) | Weakest-link cap |
| Stir includes sound and room movement; zero baseline divides by zero (Sonnet, Opus) | In-bed movement only; excess over max(usual, floor) |
| Camera dropout lowers the score (agy, Opus, Codex) | Unwatched minutes trigger low confidence and drop the longest-stretch term |
| Score drifts for 3 hours; push would carry a stale number (Sonnet, Opus, agy) | `provisional` flag; no score in the push in v1 |
| Baseline mixes cameras, windows, timezones, unconfirmed wakes (Codex, Sonnet, Opus) | Baseline filters on `scoring_context`; per-night timezone; unconfirmed wakes excluded |
| Infants scored on adult-shaped curves; week-one gap and jump; negative age (Sonnet, Opus, agy) | Under-12-months rule; "early estimate" with no band word; "No score yet" with a reason |
| Summary facts not on the stored row (Codex, agy) | `summary_facts` saved in phase 1a |
| Variant index breaks on library change or open tab (Codex, Sonnet, agy) | Variant chosen in the browser by hash; unknown keys skipped |
| Ring unreadable to screen readers; low contrast on the dark card (Sonnet, agy) | Score in `aria-label`; real button on detail; literal colours |
| Phase 1 too large; `stir_minutes` is urgent; switch needs a column (Sonnet, Opus) | Phases 1a/1b/1c; phase 2 tier corrected |
| Archive splits sections that comments cite (Sonnet) | Stubs at every moved heading |
| "41% vs 19%" was a sound figure from a fixed bug (Sonnet) | Removed as evidence |

Fifth review, Codex `gpt-6-astra`, on the revised draft. All eight findings adopted: per-metric
baseline readiness; one eligibility rule shared by scoring and baseline; correction rules for
`summary_facts` and counted wakes only; a normalised scoring input for stored and fresh nights;
duration always on measured minutes (no threshold credit); finality from the stored row's
`computed_at`; stored-row score for old nights on the detail page; neutral headlines for nights
with no score.

Not adopted: rescoring later nights on a correction (unnecessary once the score is computed on
read); a lower-bound settle time for nights with no put-down (deferred to the phase 1b evidence).
One review cited two things that were not in the draft (a 60/40 baseline/age blend and a 30-day
score chip); those points were ignored.
