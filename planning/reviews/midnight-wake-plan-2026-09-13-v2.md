# Plan v2: a corroborated short mid-night reversal counts as a wake

Status: DRAFT — for Codex (`gpt-6-astra`) + an independent Opus subagent review before any code is
written. v1 (`midnight-wake-plan-2026-09-13.md`, commit d2d909c) was reviewed by both Codex and a
parallel Opus subagent; both independently found the mechanism fatally broken — it would not have
fixed its own motivating incident. This version is a substantially narrower, redesigned plan, not a
patch of v1. Section 0 maps every v1 finding to what changed.

## 0. What v1 got wrong, and what changed — read this first

Both reviewers independently traced the named incident (Raffa, 2026-09-09: `out_of_bed 20:41:30 →
into_bed 20:43:57 → out_of_bed 20:44:36`) through the real code and found:

1. **v1's core mechanism was self-contradictory.** It proposed reusing the existing "reversal guard"
   (which *rejects* an `out_of_bed` when a corroborated `into_bed` follows within `MORNING_ABSENCE_MIN`)
   as a pre-filter, then pairing whatever survived. But a real mid-night episode *is* exactly what the
   reversal guard rejects — both reviewers proved the named incident's first exit is rejected by that
   guard and its second exit is separately rejected by the settling-tail guard, leaving zero episodes.
   **v2 does not filter through the reversal guard at all.** It implements the same corroboration
   *standard* (see §2) as an independent, standalone walk over `transitions`, using the same primitive
   (`bedOccupiedFrom`) and the same two already-calibrated constants (`JITTER_REENTRY_MS`,
   `MORNING_ABSENCE_MIN`) — no new numbers, and no attempt to reuse the departure-scan's own loop
   structure, which both reviewers separately noted is not actually extractable without a real refactor
   of the most adversarially-hardened code in the file.
2. **v1's "OR it into `markWakeRuns`" did not bypass `WAKE_ACTIVE_MIN`.** Opus did the exact
   minute-by-minute arithmetic on the named incident and found it lands on 4 or 5 active minutes
   depending on an interval convention v1 never specified — sitting exactly on the boundary it needed
   to clear, by accident at best. **v2 treats a corroborated transition episode as sufficient evidence
   on its own**, bypassing the activity-run threshold entirely for that specific span, exactly the way
   `USE_TRANSITION_TIMES` already treats a corroborated transition as authoritative for wake *time*.
3. **v1 broke the protected `wake_at_algo` shadow value**, because it fed new evidence into the same
   `markWakeRuns` call that produces it, contradicting its own claim and the file's own comment ("do not
   derive `wake_at_algo` from `inWake` after this point"). **v2 is modeled explicitly on the existing
   issue #352 pattern**: the shadow value is captured first, completely untouched; a transition-episode
   mask is combined in only as a distinct, final step (§4).
4. **v1 ignored the second `markWakeRuns` call site** (the post-window metrics extension), which
   wholesale-replaces `inWake` and would have silently dropped every transition-derived episode on any
   night whose departure lands past the window — the common case for the exact child the named incident
   belongs to. **v2's final combination step runs once, after whichever of the two existing branches
   ran**, so it does not need to intercept either call site individually (§4).
5. **v1's item-3 fold-in reused `bedOccupiedFrom` at a call site (`from = the exit's own index`)
   its 150-minute window makes nearly vacuous**, and separately cannot reach item 3's own canonical
   example (a bedtime put-down, which happens *before* onset, outside this scan's range entirely).
   **v2 does not attempt item 3.** It is explicitly deferred (§6) — reusing `bedOccupiedFrom`'s existing
   window for a different question needs its own measurement, not a reused number, and neither reviewer
   found a version of this that worked in the time available. Shipping Gap B alone, correctly, is more
   valuable than shipping both half-broken.
6. **v1's episodes could span hours** (the four-night remeasurement found 225-minute and 584-minute
   "excursions"), with no positive requirement that the bed was actually empty throughout, in a
   classifier already measured to be wrong on the majority of `out_of_bed` events. **v2 bounds every
   episode to `(JITTER_REENTRY_MS, MORNING_ABSENCE_MIN]`** — the exact same window and corroboration
   standard the terminal-departure scan already trusts for the same judgment ("was this really a
   departure or did the child come back"). Longer excursions are explicitly out of scope (§6) — they
   need positive empty-bed-run evidence this plan does not build, and are a different, harder problem.
7. **This narrower scope also resolves §7's open question from v1 (can the new pass and the terminal
   scan disagree about the same span?) by construction**, not by a tie-break rule: anything within
   `MORNING_ABSENCE_MIN` that is `bedOccupiedFrom`-corroborated is, by the terminal scan's *own* existing
   logic, already rejected as a candidate departure — the terminal scan moves on to a later gap. The two
   mechanisms can never claim the same span, because v2 only ever looks where the terminal scan has
   already declined to look.
8. **Other findings incorporated directly, not narratively**: an explicit revert flag (§5, `Opus H7`/
   `no kill switch`), the `wakeWatcher.js` clip-drift disclosure (§6, `Opus H5`), the Renz/Raffa
   asymmetry named as a per-installation limit (§6, `Opus H6`), scoring against the 468 existing
   `bed_transitions.verdict` labels as a precision oracle (§7, `Opus H7`), the stored-row backfill gap
   (§6, `Opus H8`), `in_progress` nights out of scope (§6, `Opus H4`), and docs/changelog named in
   critical files (§9, `Opus H9`).

## 1. The problem (unchanged from v1, still real)

Raffa, 2026-09-09, prod: `out_of_bed 20:41:30 → into_bed 20:43:57 → out_of_bed 20:44:36`. Real sound and
motion alerts fired on both flanks (`detection_events`, already verified). Fresh-computed, the night
reports `wake_count: 0, awake_minutes: 0` — the wake-count path never looks at `bed_transitions`, only
at `activity_samples` against `WAKE_ACTIVE_MIN` (5 sustained active minutes), which this episode
structurally cannot reach (2 dead minutes bridge two 1-minute active readings into a 3-minute run against
a threshold of 5 — see `planning/ROADMAP.md` §1.5 Gap B for the exact per-minute breakdown).

**Checked this session, per Opus's own recommendation**: the four `wake_count: 0, awake_minutes: 0`
nights found in a broader ≥10-minute-gap remeasurement (2026-08-31, 09-02, 09-07, 09-10, all Raffa) have
*normal-sized* `asleep_minutes` (458, 606, 443, 628) — ruling out Opus's alternative hypothesis that
`sleepEnd` itself was dragged back to a false early exit on those nights. The counting window is a full,
normal night on all four; a real mid-night gap is genuinely invisible inside it. **This confirms the
underlying problem is real** — it does not confirm those specific four nights are safe to fix with this
plan's mechanism, since (per §0.6) they are all long excursions this version deliberately does not touch.

## 2. The mechanism

A standalone pass, independent of the terminal-departure scan, run once per night after `onset` and
`sleepEnd`/`transitionExitIdx` have already been decided (so it can never influence them — see §4):

```
for each out_of_bed transition `exit` in `transitions`, in order, at or after onset:
  if `exit` falls inside an already-claimed episode span, skip it (handles a cluster of false exits
    before one real return — see the worked example below)
  find the FIRST into_bed transition `entry` after `exit` such that:
    - entry.time - exit.time > JITTER_REENTRY_MS (60s)   — not settling noise, the same standard
      the settling-tail guard already uses for the mirror-image case
    - entry.time - exit.time <= MORNING_ABSENCE_MIN (20min) — the same window the reversal guard
      already uses to decide "was this really a departure"
    - bedOccupiedFrom(txIdx(entry.created_at)) is true — the SAME corroboration primitive and
      contract the reversal guard already trusts (fails open: an unreadable stretch means "cannot
      prove", so nothing is claimed, matching its existing safety direction)
  if found: this is a genuine mid-night episode. Record [txIdx(exit), txIdx(entry)) and continue the
    outer loop from `entry`'s index (claims the whole span, so nested/duplicate false exits inside it
    are skipped by the guard above, not double-counted).
  if not found: this `exit` is left alone entirely — it either becomes a candidate for the terminal
    scan (already handled, unmodified) or is simply not corroborated (also unmodified; this pass never
    creates new departures, only mid-night episodes).
```

**Worked example, the actual data from Renz's 2026-09-12 bedtime settling** (used here only as a shape
check — not a claim this specific night should count as multiple wakes; it happened before onset and is
out of scope per its own timestamps): a cluster of `out_of_bed`/`into_bed` pairs 1-2 minutes apart would
each individually fail the `> JITTER_REENTRY_MS` floor and correctly produce zero episodes — the
mechanism does not manufacture noise from settling jitter.

**Why no new constant is needed**: the window is exactly `(JITTER_REENTRY_MS, MORNING_ABSENCE_MIN]` —
both bounds already exist, already measured, already load-bearing elsewhere in this exact file for the
same underlying question. This is the argument the file's own comments make for `OOB_SLOW_OUT_MIN` and
`JITTER_REENTRY_MS` themselves ("deriving a bound from the data model beats fitting one to the
failures") — reused here rather than restated.

## 3. Item 3's fold-in — explicitly NOT in this version

ROADMAP §1.2 item 3 ("parent leaves vs. child exits") is **not** addressed by this plan. Two independent
reasons, both found by review, neither resolved:
- Item 3's own canonical example (Renz, 2026-08-27: the real 19:14 put-down recorded as an `out_of_bed`)
  is a bedtime event, before `onset`. This pass only runs at/after onset and structurally cannot reach it.
- A parent-handling exclusion needs its own "was the bed occupied *immediately* after this exit"
  primitive with its own measured window — `bedOccupiedFrom`'s existing 150-minute
  (`OCCUPANCY_WITNESS_MIN`) window answers a different question (was the bed occupied *at some point* in
  the next 2.5 hours) and both reviewers found it would wrongly exclude real departures.

The ROADMAP's stated reason for combining them was to avoid "writing the same evidence walk twice" —
this version's walk is small enough (one primitive, two existing constants) that little is actually
duplicated by deferring item 3. Recommend closing Gap B on its own and reopening item 3 as its own
measurement task once real data exists to pick its window from — not guessed here.

## 4. Protecting the wake-time shadow — modeled on issue #352, not improvised

No change to the existing sequence: `markWakeRuns(activeForWake, onset, totalMin, inWake)` runs exactly
as today, `algoSleepEnd`/`wake_at_algo` are captured exactly as today, `transitionExitIdx`/`sleepEnd` are
decided exactly as today (both the `totalMin`-bounded case and the `metricsEnd`-extended case at
`:1202-1227` — neither branch is touched).

**New, single, final step, added after both of those branches have already run and produced whatever
`inWake`/`sleepEnd` (or `metricsEnd`) they were going to produce**:

1. Run §2's walk over `[onset, <the final end already decided by the existing logic>)`.
2. Build `inWakeFinal` = the existing `inWake` array OR the transition-episode minutes, clipped to the
   same range.
3. Re-run `accumulateMetrics(inWakeFinal, onset, <same end>)` to get the actual stored `wake_count`,
   `awake_minutes`, `longest_stretch_minutes`. This is the ONLY thing this step changes.

Because this runs after `sleepEnd`/`transitionExitIdx`/`algoSleepEnd`/`wake_at_algo` are already fixed
numbers, and never re-derives any of them, none of those values can move — checkable directly (they are
computed with no data-dependency on this new step at all, not merely "shouldn't move in practice").

⚠️ Named, not hidden: `asleep_minutes` and `longest_stretch_minutes` move together with `wake_count`
because `accumulateMetrics` derives all three from one array — this is very likely the *correct* joint
fix (an invisible 3-minute episode was always wrong on all three counts, not just one), but is a wider
change than "wake_count" alone and should be scored as such (§7).

## 5. A real kill switch

Add `USE_TRANSITION_WAKE_EPISODES` (boolean, default true once shipped), following the exact existing
`USE_TRANSITION_TIMES` convention and its own comment style ("flip this to false to revert to
movement-only"). Unlike v1's "gate behind an env var, remove before merge" (which Opus correctly flagged
as leaving no kill switch for a metric with no shadow column), this stays in the code permanently, the
same way its sibling flag does.

## 6. Explicit non-goals and known limits — stated, not discovered later

- **Long excursions (>20 min) are out of scope.** The four nights found in the broader remeasurement
  (§1) are not fixed by this version. They need positive empty-bed-run evidence (reusing
  `cribActExt`'s tri-state machinery properly, with an actual "was the bed empty throughout" check,
  not just a paired transition) — a materially bigger, separate piece of work, likely blocked on item
  2's own still-open duration-threshold measurement (`out_frames`, ROADMAP §1.2 item 2) to have any
  chance of discriminating real absences from the classifier's documented 62%-wrong rate at that
  duration. Not attempted here.
- **In-progress ("tonight so far") nights are out of scope.** Every primitive this plan reuses
  (`bedOccupiedFrom`, `cribOccExt`, `totalMinExt`) is already scoped to `!inProgress` in the existing
  code. A mid-night episode becomes visible once the night's window closes and the job re-computes, not
  live — the same latency the wake-*time* correction already has, stated explicitly rather than found
  as a surprise.
- **A newly-counted wake will have no wake clip.** `wakeWatcher.js` mirrors `SLEEP_THRESHOLDS` live and
  cannot retroactively know about a corroborating return that arrives minutes later. This is exactly the
  drift `sleepAnalysis.js`'s own comment warns about ("a shown wake has no clip"). Accepted and
  disclosed, not silently created — worth revisiting if it reads as confusing in practice (same posture
  already taken for the `wakes.length` vs `wake_count` off-by-one from PR #420).
- **Corroboration depends on the painted zone being accurate.** All four broken nights found are
  Raffa's; zero are Renz's. Renz's bed zone is independently documented (ROADMAP §1.1) to read exactly
  0.0000 on minutes with a body plainly moving in the room. Where a zone doesn't sit on the bed,
  `bedOccupiedFrom` cannot corroborate a real return and this fix will not fire — a per-installation
  limit inherited from an existing, already-documented problem, not a new one, but worth stating per
  CLAUDE.md's own standing question.
- **Stored `sleep_nights` rows are not backfilled.** Per the existing `runNightlySleepJob`/
  `isEvidenceFinal` behavior, only a fresh compute (the detail page, or a manual recompute) sees this
  fix. The four historical nights' child-card figures stay as they are unless recomputed by hand — an
  existing, already-documented characteristic of the system, named here so it isn't mistaken for this
  fix not having worked.

## 7. Scoring

**Hard gates, both environments, all 44 scored child-nights**: onset byte-identical; final `wake_at`/
`sleepEnd` byte-identical. If either moves, something has leaked past the boundary this plan draws in
§4, and that is a stop, not a tuning question.

**Precision, using ground truth that already exists and was overlooked in v1**: `bed_transitions` has
468 owner-reviewed `verdict` labels on staging. Before scoring anything else, check whether any `exit`
or `entry` this new pass would use as evidence is already verdicted `wrong` — any such case is a
demonstrable false positive, discoverable today with a query, not a new data-collection effort.

**What still has no oracle**: wake *count* correctness itself (nobody has recorded "how many times did
the child really wake" as ground truth). Indirect checks: run across all stored `status='ok'` nights
(not just the 44), report how many change and by how much (expect a handful, given the narrow window —
a night gaining ten wakes would indicate a bug, not a fix); confirm the named incident now reports a
wake around 20:41-20:44; confirm `sleepInsights`' temperature/wake-count correlation (which reads
`wake_count` over a 30-night rolling window) is treated as spanning a measurement-definition change,
the same way the 0.30.0 deploy is already treated as a cutoff for sleep figures.

## 8. Test plan

- Unit tests for the new pass as a pure function taking `(transitions, onset, endIdx, bedOccupiedFrom)`
  — extractable cleanly since, unlike `reversedBy`/`settlingTail`, it does not live inside the
  departure-scan's loop.
- Boundary tests at both edges of `(JITTER_REENTRY_MS, MORNING_ABSENCE_MIN]`: exactly at 60s (excluded),
  61s (included), exactly at 20min (included), 20min+1s (excluded) — mirroring this file's own existing
  boundary-test convention for `MORNING_ABSENCE_MIN`/`JITTER_REENTRY_MS` themselves.
- A cluster of false exits before one real corroborated return: confirm exactly one episode is recorded
  spanning the earliest exit to the return, not one per exit.
- An uncorroborated `into_bed` (no occupancy evidence after it): confirm no episode is recorded — this
  is the exact "62% wrong" failure mode every other guard in this file defends against, and it must be
  tested here too, not assumed safe by inheritance.
- The named incident, as a fixture built from its real transition timestamps, asserted to now produce
  a counted wake.
- `algoSleepEnd`/`wake_at_algo` byte-identical on a fixture where the new pass DOES find an episode —
  proving §4's separation, not just asserting it.
- Both `markWakeRuns` call sites (the `totalMin`-bounded case and the `metricsEnd`-extended case):
  confirm the final combination step runs after either one and neither path silently drops an episode.
- Mutation-test the boundary comparisons and the cluster-skipping logic by hand and via
  `scripts/mutate.mjs`, adding entries to `scripts/mutants.json`.
- Standard adversarial review (Codex + a parallel Claude or Opus subagent, isolated worktrees) before
  merge — non-negotiable for this file per its own unbroken track record this cycle.

## 9. Definition of done, named explicitly (missing from v1)

- **Docs**: `README.md` states the wake-detection rule in user-facing terms ("sustained movement or
  noise reads as an awakening — brief stirs don't count") — needs a line for the transition-corroborated
  path.
- **Changelog**: one `[Unreleased]` entry once shipped.
- **Critical files**, corrected from v1's list: `backend/src/lib/sleepAnalysis.js`,
  `backend/test/sleepAnalysis.test.js`, `scripts/mutants.json`, `README.md`, `CHANGELOG.md`,
  `planning/ROADMAP.md` §1.5 Gap B (close it) and §1.2 item 3 (leave open, note the deferral and why).
  `backend/src/lib/wakeWatcher.js` is NOT modified but is named here because §6's clip-drift disclosure
  concerns it directly.

## 10. Open questions for this round of review

1. Is `bedOccupiedFrom` genuinely safe to call as a bare, extracted function from outside the departure
   scan's block scope, or does extracting it (it currently closes over `cribOccExt`/`totalMinExt`,
   themselves built inside the `!inProgress` block) require passing those through explicitly, and does
   that change any of its behavior at the edges (e.g. its own `totalMinExt` bound vs. this pass's
   `onset..endIdx` bound)?
2. Section 2's loop skips a claimed episode's interior exits, but does not explicitly handle a exit
   whose *own* corroborated return also happens to be *another* exit's corroborated return (two
   different exits, same qualifying entry) — does the "claim and skip forward" rule fully prevent this,
   or is there a construction where it doesn't?
3. Is deferring item 3 entirely (§3) the right call, or is there a narrower version of it (e.g. only
   excluding the SPECIFIC exit inside an episode this pass already finds, using occupancy evidence
   scoped to just that episode's own window rather than `bedOccupiedFrom`'s wider one) that's safe to
   include now without its own new measurement?
