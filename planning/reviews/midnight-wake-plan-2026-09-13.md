# Plan: §1.5 Gap B + §1.2 item 3 — corroborated mid-night wake episodes from `bed_transitions`

Status: DRAFT — for Codex + Opus subagent review before any code is written. Nothing in this document
has been implemented. This plan itself is the first deliverable; the owner reviews the reviewed plan
before implementation starts.

## 1. The problem, already measured and named (not new today)

`sleepAnalysis.js`'s wake-COUNT path (`markWakeRuns`/`accumulateMetrics`) reads only per-minute
`activity_samples` (`motion_peak`/`sound_peak`/`motion_out_peak` against fixed thresholds). It never
looks at `bed_transitions`, even though the wake-**time** path (`USE_TRANSITION_TIMES`, the whole
morning-departure scan) treats transitions as authoritative for exactly the same question — "did the
child leave the bed". A child who climbs out, is put back, and lies still afterward is *structurally*
incapable of reaching `WAKE_ACTIVE_MIN` (5) sustained active minutes, so the episode is invisible: no
wake counted, no awake minutes, and (per the already-shipped Gap A work) no row for an alert to attach
to even though the alert fired.

**Named real incident** (`planning/ROADMAP.md` §1.5 Gap B, `sleep-analysis-next-steps.md`): Raffa,
2026-09-09, prod: `out_of_bed 20:41:30 → into_bed 20:43:57 → out_of_bed 20:44:36`, real sound+motion
alerts fired on both flanks, and the fresh-computed night reports `wake_count 0, awake_minutes 0`.

**Re-measured today (2026-09-13)**, broadening the search past that one incident: scanning all 54
stored `status='ok'` nights on prod for an `out_of_bed` → later `into_bed` pair with a gap ≥10 minutes
found **85 candidate excursions**. Four nights currently report `wake_count: 0, awake_minutes: 0`
despite carrying clear multi-transition evidence of time out of bed, including one **225-minute** and
one **584-minute** unaccounted absence (Raffa, 2026-08-31 and 2026-09-10). This is not a one-incident
edge case — it is systematic for whichever nights land in the "real but quiet" shape.

⚠️ **Constraint already given, twice, and binding**: do **not** fix this by lowering `WAKE_ACTIVE_MIN`.
It exists specifically to reject brief stirs, it was tuned against the real corpus, and 5→3 changes
every night in the corpus, not just the broken ones. The fix has to be a new, independent evidence
path, additive to the existing activity-based one.

## 2. What already exists in this file that the fix should reuse, not duplicate

The morning-departure scan (`computeNight`'s `!inProgress` block) already solves a closely related
problem for the **final** wake, and has been hardened by five separate adversarial-review rounds (see
`sleep-analysis-next-steps.md`'s dated history — #327, #342, and the F2/F3/F4 work). It already has:

- `cribActExt`/`cribOccExt` — tri-state (active / confirmed-quiet / unobserved) per-minute arrays at
  two sensitivities (`MOTION_ACTIVE` for "did anything happen", `OCCUPANCY_MIN_PEAK` — 20× more
  sensitive — for "is anyone in this bed at all").
- `bedOccupiedFrom(from)` — is the bed demonstrably occupied (≥`OCCUPANCY_MIN_MINUTES` occupancy-level
  minutes in the next `OCCUPANCY_WITNESS_MIN`)? Fails OPEN (returns `false`, i.e. "can't prove
  occupied") on missing data, because its only use is to REJECT a candidate.
- The **reversal guard**: an `out_of_bed` is not a real departure if a *corroborated* (`bedOccupiedFrom`)
  `into_bed` follows within `MORNING_ABSENCE_MIN` (20 min).
- The **settling-tail guard**: an `out_of_bed` within `JITTER_REENTRY_MS` (60 s) *after* a corroborated
  `into_bed` is the tail of that same movement, not a new departure. Deliberately asymmetric from the
  reversal guard (backward-looking hindsight can't prove occupancy the way forward-looking corroboration
  can) — this asymmetry cost a real adversarial-review-caught defect once already; the design note in
  `sleep-analysis-next-steps.md` ("a guard's two directions are not symmetric") is required reading
  before touching either guard.
- The rule that a guard may **skip** a candidate in favour of a later one, but must never **veto** a
  night into having no answer at all (a guard that can be the sole reason a night has no wake_at needs
  a fallback, not a stricter threshold).

**What that scan does NOT do, and must not be bent into doing**: it looks for the *first* gap after
which few active minutes remain for the *rest of the night* (`activeSuffix[i] <= MAX_POST_EXIT_ACTIVE_MIN`).
That test is specifically "is this really the end", which is the opposite of what a mid-night episode
finder needs — a real mid-night wake is *followed* by more sleep, so `activeSuffix` after it will
usually be large. **Do not generalize the departure scan itself (e.g. "keep scanning past the first
gap") — its stopping condition is answering a different question than Gap B asks.**

### Design decision this plan is making, flagged for review

Build mid-night episode detection as a **separate, simpler pass** that reuses the extracted primitives
above (`bedOccupiedFrom`, the reversal/settling-tail predicates) rather than the whole scan. For every
`out_of_bed` after onset that is not itself rejected by the existing reversal/settling-tail guards:

1. Find the next `into_bed` after it (if any) that is corroborated by `bedOccupiedFrom` at its own
   timestamp — i.e. a genuine return, not another false transition.
2. **Item 3 fold-in**: if the bed shows occupancy-level micro-motion (`cribOccExt`, `OCCUPANCY_MIN_PEAK`)
   *immediately* after the `out_of_bed` itself (before any real empty stretch accumulates), the exit
   never actually emptied the bed — this is a parent's hands leaving, not a child departure. Skip it
   entirely: it must not open a wake episode AND must not be available to Gap B's pairing at all. This
   reuses `bedOccupiedFrom` at the *exit's own* index rather than the return's index — same primitive,
   different call site.
3. If neither of those apply and a corroborated `into_bed` return exists, the span `[out_of_bed,
   into_bed)` is a genuine mid-night episode: mark its minutes `inWake = true` for `markWakeRuns`'s
   purposes (see §4 for what that does and does not touch).
4. If no later `into_bed` exists at all, this candidate is a departure with no return recorded — leave
   it alone. It either becomes the terminal wake (already handled by the existing scan) or is simply
   the tail of the night; this pass does not duplicate that logic.

This is deliberately **not** a duration-gated rule (no new "minimum excursion length" constant). The
existing guards already reject anything too brief to be real (settling-tail's 60 s window, the
reversal guard's occupancy corroboration) — anything that survives them by construction is already
"real enough" by the same standard the terminal-wake path already trusts. Introducing a second, new
minimum-duration number here would be exactly the kind of guessed constant this codebase's own standing
rule (`OOB_SLOW_OUT_MIN`, `JITTER_REENTRY_MS` — measured, not fitted) argues against, and the named
incident (a ~3-minute real episode) is shorter than any duration threshold that would plausibly get
proposed instinctively — a naive "must be at least 5/10/15 minutes" gate would exclude the one concrete
case that motivated this work.

**Open question for reviewers**: is skipping the whole `activeSuffix`/`MAX_POST_EXIT_ACTIVE_MIN`
machinery for this new pass actually safe, or is there a real scenario (not yet found) where a
mid-night excursion and a real terminal departure become ambiguous under this simpler rule set —
e.g. a night where the "mid-night" episode is itself never followed by any further sleep because the
night effectively ends there, making it BOTH a mid-night episode by this pass's rule AND the true
final wake by the existing scan? Need to confirm the two passes can't disagree about the same span, or
define which one wins if they do.

## 3. What "counts as a wake" changes, precisely

`markWakeRuns` currently derives its `active`/`activeForWake` input purely from `activity_samples`.
Proposed: build a second boolean array, `activeFromTransitions`, populated by the walk in §2, and feed
`markWakeRuns` the **OR** of the two (`active[i] || activeFromTransitions[i]`) — additive evidence, not
a replacement. A night with no transitions behaves byte-identically to today (matches the ROADMAP's own
"costs nothing on nights with no transitions" claim, made checkable rather than assumed).

⚠️ **Named, not hidden**: because `wake_count`, `awake_minutes`, and `longest_stretch_minutes` are all
derived from the same `inWake` array in `accumulateMetrics`, fixing `wake_count` on affected nights will
also change `awake_minutes` and `longest_stretch_minutes` on those same nights. This is very likely the
*correct* fix for all three (the Raffa 2026-08-31 night reporting `awake_minutes: 0` across a 225-minute
absence is wrong on its own terms, not just for wake_count) — but it is a wider blast radius than the
roadmap text's "wake_count 0" framing names explicitly, and should be scored and reported as such, not
discovered after shipping.

**Explicitly NOT touched by this plan**: `onset`, `onset_at_algo`, `wake_at_algo` (the movement-only
shadow figure the holdout scoring depends on comparing night-by-night — `sleepAnalysis.js`'s own
comment: "do not derive wake_at_algo from `inWake` after this point"), and the terminal `wake_at`/
`sleepEnd` logic. Checked: `sleep_nights` has no `wake_count_algo`/`wake_count_shadow` column, so unlike
onset/wake time there is no protected shadow value for wake_count to preserve — but there is also no
existing "before" figure to score against except by recomputing historically (see §5).

## 4. Item 3, specifically

ROADMAP §1.2 item 3 ("separate parent-handling from child-exits") is satisfied by step 2 in §2 above —
an exit immediately followed by continued bed occupancy never becomes a wake-episode candidate or a
departure candidate. This is the SAME evidence walk the roadmap says to share ("both read a corroborated
out_of_bed/into_bed pair as one event... doing them separately means writing the same evidence walk
twice") — item 3 is not a separate pass, it is the exclusion rule inside this one.

**Connection to today's separate, already-shipped work (PR #427/#428)**: the "quick reversal"
finding — an `into_bed` immediately undone by an `out_of_bed` within 60 s, now confirmed (visual +
bed-motion evidence) to be mostly a parent's presence — is a *different* shape (entry-then-exit) from
what this plan handles (exit-then-entry, or a bare unreturned exit). They are complementary, not the
same mechanism, and should not be conflated: #427/#428 is about a **fresh placement** being immediately
undone; this plan is about **any** exit's aftermath, at any point in the night, regardless of whether it
followed a recent entry. No code sharing is proposed between them beyond both reading `bed_transitions`.

## 5. Scoring — and the honest gap in what can be scored

The existing 44-child-night harness (staging's `sleep_reviews` as ground truth, scored against both
prod's and staging's `activity_samples` — see `sleep-analysis-next-steps.md`'s "HOW TO RE-SCORE ANY
FUTURE CHANGE") scores **onset and final wake TIME** against real owner-confirmed values. It does not,
and cannot as built, score wake **COUNT** — nobody has ever recorded "how many times did the child
really wake up" as ground truth, only the final onset/wake instants and per-transition correct/wrong/
unclear verdicts.

**What this plan can score directly**: onset must stay byte-identical (untouched by this change, and
checkable), and the final wake TIME/`sleepEnd` must also stay byte-identical on all 44 nights — if
either moves, something has leaked into logic this change was not supposed to touch. This is a hard
gate, not a nice-to-have: a wake_count fix that silently perturbs the one thing that IS scored would be
strictly worse than not shipping.

**What this plan can only score indirectly**:
- Run the new logic across ALL stored `status='ok'` nights (not just the 44), report the aggregate
  count/size of nights whose `wake_count`/`awake_minutes` change, and sanity-check the magnitude looks
  plausible (a handful of nights gaining 1-2 wakes and tens of minutes, not every night gaining ten).
- Check the named real incident specifically: does Raffa's 2026-09-09 night now report a wake around
  20:41-20:44, matching the independently-corroborating alerts that are known to have fired?
- Check the four `wake_count: 0`/`awake_minutes: 0`-despite-clear-excursions nights found in today's
  broader measurement (2026-08-31, 2026-09-02, 2026-09-07, 2026-09-10, all Raffa) — do they now report
  a non-zero, plausible count?
- Spot-check a sample of NEWLY-flagged episodes for the "parent, not child" exclusion (§2 step 2) by
  pulling their transition snapshots (same technique used for #427's visual sample today) and confirming
  by eye that excluded ones plausibly show a parent, and included ones plausibly show a real episode.

**Explicitly flagged, not glossed over**: this ships without a wake-count oracle. The same "ask the
owner" pattern used today for PR #428 (a targeted, un-collapsed morning-review prompt, reusing the
existing verdict mechanism) could eventually collect real ground truth for THIS pattern too — a night
with a newly-counted mid-night wake could get its own "we counted this as a wake — is that right?"
question. **Proposed as an explicit Phase 2, not blocking this ship**, matching the same phasing this
whole day's work has used (measure → build → ship the safe/additive part → collect the harder ground
truth → revisit). Whether to build that now or defer it is a question for the owner, not decided here.

## 6. Test plan

- Unit tests for the new pure primitives (the exclusion rule, the pairing rule), reusing the existing
  test harness's fixture style in `sleepAnalysis.test.js` — construct synthetic transition sequences
  mirroring the named real incident and the four newly-found nights, plus the boundary cases the
  existing guards already have tests for (adapted): an exit reversed by occupancy-corroborated return
  vs. an exit reversed by a bare uncorroborated `into_bed` (must NOT reject — the existing "62% wrong"
  lesson applies here too), a settling-tail exit vs. a genuine short episode at the same gap length,
  and the boundary of whatever window ends up governing "how soon after an exit does continued
  occupancy count as parent-handling" (needs its own measurement, not a guess — see open question below).
- The "zero behavior change on a night with no qualifying transitions" claim, tested directly (byte-
  identical `computeNight` output with the new logic disabled vs. a transition-free fixture), matching
  the pattern already used for PR #423's "record-only" claim.
- Mutation-test the new predicates by hand and via `scripts/mutate.mjs`, adding new entries to
  `scripts/mutants.json` (per the standing convention every prior sleep-analysis PR has followed).
- Full retrospective scoring per §5, both environments, gated behind an env var for a true A/B on one
  codebase (the established recipe), removed before merge.
- Standard adversarial review (Codex + a parallel Claude subagent, in isolated worktrees) before merge —
  this touches `sleepAnalysis.js`, which has had a real, previously-missed defect found by that process
  on every single prior PR that touched it this cycle (#418, #420, #327, #342). No reason to expect this
  one is different.

## 7. Open questions this plan is deliberately not resolving unilaterally

1. **The window for item 3's "continued occupancy = parent" exclusion** — how soon after an `out_of_bed`
   must occupancy-level motion appear to mean "the child never really left" vs. "the child left, and
   much later a parent came in to check/tidy" (which should NOT retroactively un-count a real
   departure)? `bedOccupiedFrom`'s own `OCCUPANCY_WITNESS_MIN` window exists for exactly this shape of
   question elsewhere in the file — reuse it, or does it need its own value? Needs measurement against
   the corpus before deciding, not a guess.
2. **Whether the two new passes (mid-night episode detection, terminal departure) can ever disagree
   about the same span** (§2's open question) — needs to be either proven impossible or given an
   explicit tie-break rule.
3. **Whether to build the Phase 2 verdict-collection UI now or defer it** — an owner call, not a
   technical one.
4. Whether `awake_minutes`/`longest_stretch_minutes` moving as a side effect (§3) is acceptable to ship
   in the same change, or whether the first ship should suppress that and touch `wake_count` alone
   (harder to do cleanly given they share `inWake`, and arguably wrong to do — see §3 — but named here
   as a real fork, not assumed away).

## Critical files
- `backend/src/lib/sleepAnalysis.js` (the whole of the work — `computeNight`, the morning-departure
  scan, `markWakeRuns`/`accumulateMetrics`)
- `backend/test/sleepAnalysis.test.js`
- `scripts/mutants.json`
- `planning/ROADMAP.md` §1.5 Gap B and §1.2 item 3 (to close out once shipped and scored)
