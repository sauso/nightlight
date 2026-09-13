# Plan v6: fold in round 5's textual findings — BUILD-READY

Status: **build-ready, no further review round planned.** Round 5 (v5, commit 4d1e1f6) was reviewed by
Codex (`gpt-6-astra`) and, independently, a Sonnet subagent that wrote its own scratch harness
transcribing v5's §2 pseudocode verbatim and executed it against constructed fixtures — the same method
that caught v4's bug. Both independently confirmed: the exclusive-both-ends quiet range (v5 §0.1)
closes the bug that let v4 pass only by accident of clock alignment; the corrected worked example
(v5 §0.2) is now genuinely correct; dropping the inverted cross-reference check (v5 §0.3) was the right
call, with neither reviewer finding a cheap correct alternative. **Neither reviewer found anything
requiring a change to §2's algorithm.** Both gave an explicit, calibrated "ready to build from" verdict,
contingent only on five small textual findings — folded in below as §0.9–§0.13. Everything else in this
document is v5's text, unchanged; §§1–9 are renumbered only where a cross-reference needed updating.

## 0. What v5 got wrong, and what changed (§0.1–§0.8 are v5's; §0.9–§0.13 are new this round)

### 0.1 [BLOCKING, both reviewers; Sonnet proved it by execution] the quiet range still admits the wrong minutes — the named incident only passed by luck

v4's must-be-quiet range was `(txIdx(exit), txIdx(entry)]` — excluding the exit's own minute but
**including** the entry's own minute. A reviewer ran v4's exact pseudocode against a constructed
genuine 8-minute out-of-bed (exit 02:00:10, climb back in 02:08:20, real bed motion landing in the
02:08 bucket) and got **zero episodes** — the entry's own minute legitimately carries the return's
motion, so `cribActExt[entryIdx] === true` fails the check. Then, critically, that reviewer checked
*why* the named incident had passed at all: its return (`20:43:57`) landed three seconds before the
minute rolled over, so the return's own motion registered in bucket `20:44`, not `20:43` — the incident
passed **by accident of clock alignment**, not because the range was correct. Move the same real event
forty seconds earlier in the same minute and v4 produces nothing. v4 §0.1 cited the incident's quiet
20:43 as *evidence the range was right*; it was evidence of luck. This is the third round running a
range boundary was the actual bug (v3's off-by-one, v2's pairing-skip, now this) — the pattern itself is
worth naming: a range described in prose sounds right until it is run.

**Fix**: both ends **exclusive**, and require the resulting range to be **non-empty**:

```
must-be-quiet range: { i : exitIdx < i < entryIdx }   // strictly between, both endpoints excluded
require: entryIdx - exitIdx >= 2                       // otherwise no minute exists to check at all
```

Neither endpoint's own bucket can ever answer "was the bed empty" — both necessarily carry the
transition that generated their own marker. Re-traced every scenario from the v3/v4 review rounds
under this range: the named incident still fires (quiet range `{20:42}` only, one minute, still
`false` in real data; marked-awake span is unaffected — still `[exitIdx, entryIdx]` inclusive both
ends, `{20:41, 20:42, 20:43}`); the genuine 8-minute case now fires correctly; a 65-second excursion is
correctly rejected (adjacent buckets, empty range, nothing to check — an honest "we have no evidence
either way" rather than a false accept). None of the false positives found in round 4 or since are
affected by this change — it narrows admission, it does not widen it. **Independently re-confirmed by
execution in round 5** (both directions: the named incident, and the genuine-episode case that broke
v4).

**Side effect, stated explicitly rather than left implicit**: because evidence is minute-bucketed, only
gaps whose exit and entry buckets are at least two apart can ever produce a non-empty range — a real,
quiet, corroborated excursion of (for example) 70 seconds straddling only two adjacent buckets will be
silently rejected for lack of a bucket to check, even though nothing about it was actually
disqualifying. This is a conservative, false-negative-direction side effect (consistent with this
file's stated safe-failure convention) and is named here rather than discovered later.

### 0.1c [new, round 5, resolves a flagged-unverified claim] the named incident's corroboration is not a new assumption — it is already validated, shipped behavior

The prior draft flagged `cribActExt[41]`'s real value as unverified and, separately, left
`bedOccupiedFrom(entryIdx=43)`'s truthiness for the named incident as an implicit assumption — and a
round-5 reviewer traced that this second value is in fact **more consequential** than the first: a
false `bedOccupiedFrom(43)` would produce zero episodes for the whole motivating incident, the same
catastrophic-failure shape that killed v1 and v3. This is not, however, an open question: **this exact
call is already made today, unconditionally, by the shipped `settlingTail` guard** for this exact
incident (`sleepAnalysis.js:1013-1017`), and the comment immediately above it (~918-1001) states
plainly: *"Measured, prod 2026-09-09 (the owner reported it)... Proved by ablation on a prod
snapshot — deleting that one row alone moves the night to 05:17 and 9h51m."* That ablation is direct
evidence `bedOccupiedFrom(43)` already evaluates true on real prod data today, in already-shipped code.
This plan's episode-detection pass calls the identical primitive on the identical index — it is
reusing an already-validated fact, not introducing a new one. `cribActExt[41]`'s exact value remains
genuinely unqueried and is still an action item (below), but it no longer carries the "could this whole
incident be built on an unchecked assumption" doubt v5 left open.

**Action before implementation, unchanged from v5**: query real `activity_samples` for camera
`dce8157e`, bucket 20:41, 2026-09-09, and state the real `motion_peak` value.

### 0.2 [BLOCKING, Codex; confirmed wrong by execution] the worked example for the adult-visit residual risk didn't survive the plan's own new guard

v4's original counterexample (two adult visits 4:30 apart, 30-second legs) was traced against the
backward guard and found to **not survive**: the corroboration that makes the example's episode "work"
(`bedOccupiedFrom` reads true because the child never left) is exactly what the backward guard uses to
reject the first exit as settling-cluster noise — zero episodes, not the claimed one. The plan's own
test plan then specified a test asserting the wrong outcome — the same class of defect named back in
v3 (§0.10, "a test asserting a property instead of testing it").

**Fix**: replace the example with one whose legs clear `JITTER_REENTRY_MS` (60s), so the backward guard
does not fire:

```
in@03:00:00 (parent visit 1 starts)  out@03:01:30 (parent leaves, 90s later)
in@03:06:30 (parent visit 2 starts)  out@03:08:00 (parent leaves, 90s later)
```

**Independently re-executed in round 5, exactly as specified**: produces `{start: 1, end: 6}` (minute
indices, relative to a 03:00:00 origin) — a **6-minute** span (indices 1 through 6 inclusive: 03:01
through 03:06), not "5 minutes" as an earlier draft stated (corrected — §0.12's inclusive-both-ends
convention gives `6 - 1 + 1 = 6`, matching how every other span in this document is counted). Kept in
the plan not as something this mechanism catches, but as the honest demonstration of the residual risk
named in §4: an adult-visit-bracketed quiet gap is indistinguishable, by anything in this mechanism,
from a real child episode. The test asserts an episode **is** produced, with a comment stating plainly
this is a known, undetected false-positive shape, not a bug in the test.

### 0.3 [BLOCKING, round 4; independently re-confirmed round 5] the proposed pre-ship mitigation is inverted and cannot help

Cross-referencing every new episode against `getQuickReversals()` (a 60-second window) before trusting
it was proposed as a pre-ship check. Run directly against the named incident: **it flags the incident's
own entry transition** (`into_bed 20:43:57 → out_of_bed 20:44:36`, a 39-second gap — exactly the shape
`getQuickReversals` looks for) as a "quick reversal" needing manual review — the mechanism's own
motivating true positive comes back flagged as suspicious. And it misses the demonstrated false-positive
shape (§0.2's 90-second legs), since 90s sits outside the 60-second window. **Round 5 independently
re-verified this is structurally unfixable, not just unlucky with the current window**: checked directly
against `findQuickReversals` (`bedTransitionRules.js:113-132`) that no choice of window (either
bookend, any width) can both catch §0.2's counterexample and not flag the named incident, because
§0.2's counterexample was deliberately built with legs long enough to clear whatever window would also
need to admit the incident's own 39-second entry gap.

**Fix**: drop the cross-reference check entirely. The residual risk it was meant to catch
(adult-visit-bracketed gaps, §0.2) is named plainly in §4 as unmitigated and left to ROADMAP §1.2
item 3, and to the discipline this codebase already relies on for every classifier change: **read the
actual nights that flip** during the 44-night scoring pass (§7, broadened — see §0.9 below).

### 0.4 [HIGH, round 4] `bedOccupiedFrom` is now called in the direction its own contract explicitly forbids

`sleepAnalysis.js:836-841`'s comment is explicit: *"its only caller uses a true result to REJECT
something, so it returns FALSE when it cannot tell"* — a false `true` is a safe false-negative for
every existing caller (`reversedBy`, `settlingTail`). This plan's mechanism calls it in the **admit**
direction (`if (!bedOccupiedFrom(entryIdx)) continue` — a true result lets the episode through). A
false `true` becomes a false positive: a child genuinely leaves and never returns; a spurious `into_bed`
fires minutes later; a parent strips the now-empty bed 90+ minutes after that, inside
`bedOccupiedFrom`'s 150-minute witness window — the parent's own motion corroborates a return that
never happened, and a fake episode is created from a bed nobody was in.

**Round 5 addition**: the same root cause — `OCCUPANCY_WITNESS_MIN`'s 150-minute window being wide
enough to reach evidence from an unrelated, much-later event — has a second, distinct manifestation
beyond fabricating an episode from nothing. Constructed: `out@0 (real exit) → in@2:00 (spurious,
uncorroborated on its own) → out@2:30 (re-opens) → in@10:00 (the real, corroborated return)`. Traced:
the real exit at `0` is abandoned because its literal next transition (`in@2:00`) fails corroboration
*in isolation* — but `bedOccupiedFrom`'s 150-minute window reaches all the way forward to the real
return's own occupancy evidence at `10:00`, so the spurious `in@2:00` gets *falsely* corroborated too,
producing a truncated, wrong-boundary episode `{0, 2}` while the real return at `10:00` is silently
never reached by anything. Same root cause as the fabricate-from-nothing case, different failure shape
(truncation and lost tracking of the true return, not pure fabrication) — same severity tier, now named
alongside it.

**Fix, unchanged**: name this explicitly as an accepted, documented residual risk (§4), not a mechanism
change this round — the alternative (a genuinely new, asymmetric occupancy primitive) is a real
redesign, not a surgical fix, and the existing `bedOccupiedFrom`-as-corroboration approach is inherited
directly from the already-shipped, already-scored `reversedBy` pattern. **Required in the same commit
as implementation**: update `bedOccupiedFrom`'s comment at :836-841 — it already has **two**
reject-direction callers today (`reversedBy`, `settlingTail`); this plan adds a **third call site**, the
first to use a true result to *admit* rather than reject (corrected from "a second caller" — the
comment's blanket claim about "its only caller" needs a full rewrite, not a one-word patch).

### 0.5 [HIGH, round 4] the backward guard can suppress a genuine departure

Demonstrated: a real 8-minute out-of-bed episode, preceded by one spurious `into_bed` 30 seconds
earlier that happens to be corroborated by the *child's own later occupancy* (i.e., the child really is
in the bed both before and after — the spurious marker is just noise), is silently dropped: the
backward guard sees a corroborated `into_bed` within `JITTER_REENTRY_MS` before the real exit and
treats it as settling-cluster noise. With 62% of transitions on record provably wrong (same type twice
in a row, `bedTransitionRules.js:39-41`), a stray marker in a 60-second window ahead of a real exit is
this classifier's documented normal case, not a contrived one.

**Fix, unchanged**: name this explicitly (§4) rather than add a `settlingFallback`-equivalent (which
the existing `settlingTail` guard has, precisely because suppressing the *terminal* wake entirely would
report "still asleep" for a child plainly up — a much worse claim than this pass silently producing no
mid-night episode). A missed mid-night episode is a false negative in the safe direction this file
already treats as acceptable elsewhere. No fallback is added, and the reasoning for not adding one is
stated here rather than left as a silent gap.

### 0.6 [HIGH, round 4] a false settling tail beyond 60 seconds still manufactures an episode

Demonstrated: `out@23:00:00 → in@23:00:20 (settled) → out@23:01:30 (70s after the in — past
JITTER_REENTRY_MS) → in@23:08:00` produces a fake episode, because the 70-second tail clears the
backward guard's 60-second window. Not a new discovery about the *world* — `JITTER_REENTRY_MS`'s own
existing comment in `sleepAnalysis.js` already states the false-tail and real-exit populations
**overlap** and *"no window would"* separate them cleanly. This plan inherits that already-accepted
limitation rather than introduces a new one. Named in §4, citing `JITTER_REENTRY_MS`'s own comment as
the reason no window-widening fix is attempted.

### 0.7 [HIGH, round 4; broadened round 5] a bad intervening transition can suppress an episode entirely, not just shorten it — and the cause is broader than same-type clusters

The prior draft characterized this as "a consecutive-exit cluster starts the episode late" — a
same-type cluster (`out, out, in`) skips the first, earlier exit and pairs the second, later one,
under-durationing but not losing the episode. **Round 5 found this is both worse and broader than
that.** Two independently constructed cases:

- `out@23:00:00 (real exit) → out@23:04:00 (spurious second marker) → in@23:04:30 (the real return,
  only 30s after the spurious marker)`: the first exit's next transition isn't an `into_bed`, so it's
  skipped; the second exit's gap to the real return is 30s, ≤`JITTER_REENTRY_MS`, so it's treated as an
  instant settle. **Zero episodes** for a genuine ~4.5-minute absence — not shortened, gone entirely.
- A *different-type* intervening transition, not a same-type cluster: `out@0 (real exit) → in@2:00
  (spurious, uncorroborated on its own) → out@2:30 (re-opens) → in@10:00 (the real, corroborated
  return)`. This is the same construction as §0.4's second manifestation — it both drops the real
  return *and* fabricates a truncated episode at the wrong boundary. The root cause here is
  `bedOccupiedFrom`'s wide window (§0.4), but the *symptom* — the positional, no-retry pairing rule
  giving up on the true exit rather than trying the transition after the one that failed — is the same
  shape as the same-type case above.

**Fix**: broaden the named limitation (§4) from "a same-type cluster under-durations an episode" to "any
intervening transition whose own gap, type, or corroboration check fails can cause the pairing rule to
either under-duration an episode or, in some arrangements, drop it entirely" — textual only, no
algorithm change. A multi-hop pairing rule that retries past a failed candidate to find the "real" exit
is a genuine mechanism extension, not a surgical fix, and is explicitly left for a future round if the
44-night scoring pass shows this shape matters in practice on real data (both constructions here are
adversarial constructions, not yet observed in real transitions).

### 0.8 Housekeeping (unchanged from v5)

- `txMs` is an explicit parameter to the extracted function (it is a `computeNight`-local at line 600
  today, not in scope for a genuinely standalone function).
- The call site (§2) explicitly gates on `USE_TRANSITION_WAKE_EPISODES` (§5), alongside a note on its
  interaction with `USE_TRANSITION_TIMES`: reverting wake **times** alone does not revert wake
  **counts** if the episodes lever stays on — the two are independent switches, and a revert of one
  without the other is a real, documented configuration, not an oversight.
- §0.12's stated expected output for the named incident adds `longest_stretch_minutes: 609 → 545` (the
  quiet run splits at the episode).
- `bedOccupiedFrom`'s comment fix (§0.4) is required in the same commit.
- The tie-break precedent is `findQuickReversals`'s internal sort (`bedTransitionRules.js`, confirmed
  ascending) — not `bedTransitions.js:191`/`234-238`, which are confirmed **descending**-id sorts for
  newest-first lists, a different convention for a different purpose.
- One comment, not a code change: the positional pairing rule is only safe because `scoreCams` is
  exactly one camera per call (`sleepAnalysis.js:467-471`, confirmed `mainCam ? [mainCam.id] : []`) —
  state this assumption explicitly since `findQuickReversals`'s own documentation warns transitions can
  span cameras in other contexts.
- §8's boundary test for an episode entry landing at `sleepEnd - 1` states the concrete resulting
  `wakes[]` row it must produce, not a vague "confirm no bad interaction."
- The backward guard's `<=` vs. the tie-break's `id ASC` can disagree at an identical-second boundary —
  this is intentional and matches `settlingTail`'s own stated reasoning (`sleepAnalysis.js:1009-1012`)
  for using `<=` rather than `<`; stated here so it reads as a deliberate choice, not confusion between
  two orderings.

### 0.9 [round 5, Codex + independently confirmed] the scoring review trigger misses episodes that only extend an existing wake

§7 (below) proposed reviewing every night whose `wake_count` changes by eye before trusting it.
Constructed and confirmed by execution: an existing activity-based wake run (say, minutes 98-102,
`wake_count=1`, `awake=5`) plus a new episode spanning `{95, 108}` (bed-motion-quiet 96-107, the
existing activity run still true 98-102) **merges into one contiguous run** 95-108 under
`accumulateMetrics`'s simple edge-counting. Result: `awake_minutes` 5→14, but `wake_count` stays at
**1** — the exact change this mechanism exists to surface happens, and the proposed review trigger
never fires.

**Fix**: broaden §7's review trigger from "`wake_count` changes" to "`wake_count`, `awake_minutes`, or
`longest_stretch_minutes` changes" — a textual scoring-process fix, no mechanism change.

### 0.10 [round 5] `bedOccupiedFrom`'s comment needs a fuller rewrite than "second caller"

Folded into §0.4 above (the comment already had two reject-direction callers before this plan; this
plan adds a third call site, the first in the admit direction) — listed here only so it isn't missed as
a separate housekeeping item when implementing §0.4's required comment update.

## 1. The problem (unchanged)

Raffa, 2026-09-09, prod, camera `dce8157e`: `out_of_bed 20:41:30 → into_bed 20:43:57 → out_of_bed
20:44:36`. Three active minutes (20:41, 20:44, 20:45) against `WAKE_ACTIVE_MIN = 5`.

## 2. The mechanism (unchanged from v5 — no algorithm change this round)

```
function detectMidnightEpisodes(transitions, cribActExt, bedOccupiedFrom, txIdx, txMs, onset, sleepEnd) {
  const sorted = transitions.slice().sort((a, b) =>
    a.created_at === b.created_at ? a.id - b.id
    : a.created_at < b.created_at ? -1 : 1);

  const episodes = [];
  for (let k = 0; k < sorted.length; k++) {
    const exit = sorted[k];
    if (exit.type !== OUT_OF_BED) continue;
    const exitIdx = txIdx(exit.created_at);
    if (exitIdx < onset || exitIdx >= sleepEnd) continue;

    // backward settling-cluster guard — named limitation at §0.5/§0.6/§0.7
    const settlingBack = sorted.find(back =>
      back.type === INTO_BED
      && txMs(back.created_at) <= txMs(exit.created_at)
      && txMs(exit.created_at) - txMs(back.created_at) <= JITTER_REENTRY_MS
      && bedOccupiedFrom(txIdx(back.created_at)));
    if (settlingBack) continue;

    const entry = sorted[k + 1];
    if (!entry || entry.type !== INTO_BED) continue;          // named limitation §0.7
    const entryIdx = txIdx(entry.created_at);
    if (entryIdx >= sleepEnd) continue;

    const gapMs = txMs(entry.created_at) - txMs(exit.created_at);
    if (gapMs <= JITTER_REENTRY_MS) continue;
    if (gapMs > MORNING_ABSENCE_MIN * 60000) continue;

    if (!bedOccupiedFrom(entryIdx)) continue;                  // named limitation §0.4

    // §0.1 — BOTH ends excluded, and the range must be non-empty
    if (entryIdx - exitIdx < 2) continue;
    let quiet = true;
    for (let i = exitIdx + 1; i < entryIdx; i++) {
      if (cribActExt[i] !== false) { quiet = false; break; }
    }
    if (!quiet) continue;

    episodes.push({ start: exitIdx, end: entryIdx });          // marked-awake span, inclusive
  }
  return episodes;
}
```

Applied once, guarded by both `!inProgress` and `USE_TRANSITION_WAKE_EPISODES` (§0.8), at the same
single fixed point (immediately after `sleepAnalysis.js:1227`, before line 1229):

```
if (!inProgress && USE_TRANSITION_WAKE_EPISODES) {
  for (const { start, end } of detectMidnightEpisodes(transitions, cribActExt, bedOccupiedFrom, txIdx, txMs, onset, sleepEnd)) {
    for (let i = start; i <= end; i++) inWake[i] = true;
  }
  ({ asleep, awake, wakeCount, longest } = accumulateMetrics(inWake, onset, sleepEnd));
}
```

## 3. Item 3 — unchanged deferral

## 4. What is NOT attempted — the full, current list

Excursions >20min, in-progress nights, the `empty`-status ordering interaction, no wake clip for a new
wake, the Renz/Raffa asymmetry (all unchanged from earlier rounds), plus:

- An adult visit bracketing a quiet gap is indistinguishable from a real child episode (§0.2) — item
  3's job, unmitigated this round.
- `bedOccupiedFrom` used in the admit direction can be fooled by an unrelated later occupied reading —
  either fabricating an episode from nothing, or truncating a real one and losing track of its true
  return (§0.4, both manifestations).
- The backward guard can suppress a genuine mid-night departure when an unrelated spurious `into_bed`
  is itself corroborated by later occupancy (§0.5) — a false negative, the safe direction, no fallback,
  reasoning stated.
- A settling tail beyond `JITTER_REENTRY_MS` still manufactures an episode (§0.6) — inherits a
  limitation this file's own `JITTER_REENTRY_MS` comment already documents as unfixable by any window.
- Any intervening transition that fails its own check can cause the pairing rule to under-duration or,
  in some arrangements, entirely drop a real episode (§0.7, broadened this round).

This list has grown across rounds, not shrunk to zero. That is the honest result of running the
mechanism against constructed adversarial data rather than reasoning about it in prose — every item is
either a false-negative (this file's stated safe direction) or a narrow, named false-positive shape
explicitly deferred to item 3, none a silent gap. Two independent reviewers, across two separate rounds
of direct execution against real fixtures, judged this an acceptable, honestly-scoped state to build
from rather than a sign the mechanism needs simplifying further.

## 5. Revert lever

`USE_TRANSITION_WAKE_EPISODES`, wired into §2's call site (§0.8).

## 6. Docs and changelog

`README.md`'s two affected bullets, `CHANGELOG.md` `[Unreleased]`, `planning/ROADMAP.md` §1.5 Gap B
closes (§1.2 item 3 stays open, its scope restated per §0.2/§0.3's honest limits), plus
`bedOccupiedFrom`'s comment update (§0.4) — all in the same commit as the code.

## 7. Scoring

Unchanged hard gates (byte-identical onset/final-wake on all 44 scored nights) and positive gate (a
bounded non-zero number of nights change, named incident included). **§0.3's cross-reference check is
dropped.** **§0.9's fix applied**: review every night whose `wake_count`, `awake_minutes`, **or**
`longest_stretch_minutes` changes — not `wake_count` alone. `wake_count`-decrease gate and
`bed_transitions.verdict` query unchanged.

## 8. Test plan

- The named-incident fixture's must-be-quiet assertion checks `{20:42}` only (one minute, both
  endpoints excluded). Query real prod `activity_samples` for camera `dce8157e`, bucket 20:41,
  2026-09-09 before writing the fixture, and build `cribActExt[41]`'s value from what's actually
  measured rather than assumed (§0.1c).
- A genuine-episode fixture where the return's motion lands in the entry's own bucket — assert an
  episode **is** produced (the case that broke the prior round's range).
- A 65-second-gap fixture with adjacent buckets — assert no episode (empty range, not a false accept).
- The corrected 90-second-legs adult-visit example (§0.2) — assert an episode **is** produced (6
  minutes, indices 1-6), with a comment stating this is a known, accepted false-positive shape.
- Add `longest_stretch_minutes` to the named-incident fixture's assertions (609→545).
- Add explicit test cases for each of §0.4 (both manifestations), §0.5, §0.6, and §0.7 (both
  constructions) — each documents the accepted, named behavior; none asserts it away.
- The `sleepEnd - 1` boundary test states the concrete resulting `wakes[]` row.
- Mutation-test the quiet range's two boundaries specifically — this exact range has been the actual
  bug in three of five rounds.

## 9. Open questions for this round

None outstanding that block implementation. The two open questions from the prior round were resolved:
whether "read every flipped night by eye" is adequate (yes, per round 5's confirmation there is no
cheap correct alternative to the cross-reference check that was dropped, combined with §0.9's fix
widening what counts as "flipped"); and whether the growing §4 list indicates the mechanism needs
simplifying (no, per both round-5 reviewers' explicit judgment that the list reflects thorough testing
finding narrow, named, false-negative-direction edges — not a sign the core design is unsound).
