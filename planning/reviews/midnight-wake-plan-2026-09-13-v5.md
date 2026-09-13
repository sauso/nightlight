# Plan v5: exclusive-both-ends quiet range, a corrected worked example, drop the inverted cross-check

Status: DRAFT — for Codex (`gpt-6-astra`) + an independent Opus subagent review before any code is
written. Round 4 (v4, commit 484d6cb) was reviewed by Codex and, independently, by an Opus subagent
that additionally **executed** v4's own pseudocode against real `computeNight` fixtures rather than
only reasoning about it. Both reviewers converged: the mechanism direction is now sound and should not
be redesigned again, but one range was still wrong — the third round in a row where a range boundary,
not the mechanism, was the actual defect. This draft makes three precise, surgical fixes and documents
five more findings as named, accepted limitations rather than building more guards to chase them —
per both reviewers' own explicit calibration that a fourth full redesign is not warranted.

## 0. What v4 got wrong, and what changed

### 0.1 [BLOCKING, both reviewers; Opus proved it by execution] the quiet range still admits the wrong minutes — the named incident only passed by luck

v4's must-be-quiet range was `(txIdx(exit), txIdx(entry)]` — excluding the exit's own minute but
**including** the entry's own minute. Opus ran v4's exact pseudocode against a constructed genuine
8-minute out-of-bed (exit 02:00:10, climb back in 02:08:20, real bed motion landing in the 02:08
bucket) and got **zero episodes** — the entry's own minute legitimately carries the return's motion,
so `cribActExt[entryIdx] === true` fails the check. Then, critically, Opus checked *why* the named
incident had passed at all: its return (`20:43:57`) landed three seconds before the minute rolled over,
so the return's own motion registered in bucket `20:44`, not `20:43` — the incident passed **by
accident of clock alignment**, not because the range was correct. Move the same real event forty
seconds earlier in the same minute and v4 produces nothing. v4 §0.1 cited the incident's quiet 20:43 as
*evidence the range was right*; it was evidence of luck. This is the third round running a range
boundary was the actual bug (v3's off-by-one, v2's pairing-skip, now this) — the pattern itself is
worth naming: a range described in prose sounds right until it is run.

**v5 fix**: both ends **exclusive**, and require the resulting range to be **non-empty**:

```
must-be-quiet range: { i : exitIdx < i < entryIdx }   // strictly between, both endpoints excluded
require: entryIdx - exitIdx >= 2                       // otherwise no minute exists to check at all
```

Neither endpoint's own bucket can ever answer "was the bed empty" — both necessarily carry the
transition that generated their own marker. Re-traced every scenario from the v3/v4 review rounds
under this range: the named incident still fires (quiet range `{20:42}` only, one minute, still
`false` in real data; marked-awake span is unaffected — still `[exitIdx, entryIdx]` inclusive both
ends, `{20:41, 20:42, 20:43}`, unchanged from v4 §0.1/§0.11/§0.12); Opus's genuine 8-minute case now
fires correctly; a 65-second excursion is correctly rejected (adjacent buckets, empty range, nothing to
check — an honest "we have no evidence either way" rather than a false accept). None of the false
positives found in this round or the last are affected by this change — it narrows admission, it does
not widen it.

**Side effect, stated explicitly rather than left implicit**: because evidence is minute-bucketed, only
gaps whose exit and entry buckets are at least two apart can ever produce a non-empty range — a real,
quiet, corroborated excursion of (for example) 70 seconds straddling only two adjacent buckets will be
silently rejected for lack of a bucket to check, even though nothing about it was actually
disqualifying. This is a conservative, false-negative-direction side effect (consistent with this
file's stated safe-failure convention) and is named here rather than discovered later.

**Unverified claim flagged rather than repeated a third time**: Opus separately noted that whether
minute 20:41 (the exit's own bucket) is *actually* `cribActExt === true` in real prod data has never
been directly queried — the ROADMAP's "three active minutes" figure comes from `isActiveRow` (motion OR
sound OR outside-motion), a broader test than `cribActExt`'s narrower bed-motion-only threshold, and
`oobLinkKind`'s own `OOB_LINK_SLOW_MS` window means the exit's bed motion can legitimately land in the
*previous* bucket instead. This does not change v5's fix (both endpoints are excluded regardless of
which way that resolves), but the narrative in §0.1 rested on an assumption that was never queried.
**Action before implementation**: query real `activity_samples` for camera `dce8157e`, bucket 20:41,
2026-09-09, and state the real `motion_peak` value — cheap, and this file's own standing rule is that a
claim escalated to blocking severity gets measured, not assumed.

### 0.2 [BLOCKING, Codex; confirmed wrong by Opus's execution] §0.6's worked example doesn't survive v4's own new guard

v4 §0.6 proposed two adult visits 4:30 apart, each leg 30 seconds, as a counterexample the mechanism
would wrongly accept. Both reviewers traced it against v4's *own* §0.3 backward guard and found it
**doesn't survive**: the corroboration that makes the example's episode "work" (`bedOccupiedFrom` reads
true because the child never left) is exactly what the backward guard uses to reject the first exit as
settling-cluster noise. Opus ran it: zero episodes, not the claimed one. v4 §8 then specified a test
asserting the wrong outcome — the same class of defect named in v3 (§0.10, "a test asserting a property
instead of testing it").

**v5 fix**: replace the example with Codex's, independently confirmed by Opus's execution — legs long
enough (90s each) to clear `JITTER_REENTRY_MS` (60s), so the backward guard does not fire:

```
in@03:00:00 (parent visit 1 starts)  out@03:01:30 (parent leaves, 90s later)
in@03:06:30 (parent visit 2 starts)  out@03:08:00 (parent leaves, 90s later)
```

This **does** produce a real episode (`03:01:30 → 03:06:30`, 5 minutes) under both v4's and v5's
ranges — confirmed by execution. It is kept in the plan not as something this mechanism catches, but as
the honest demonstration of the residual risk named in §0.6/§4: an adult-visit-bracketed quiet gap is
indistinguishable, by anything in this mechanism, from a real child episode. §8's test is corrected to
assert an episode **is** produced here, with a comment stating plainly that this is a known,
undetected false-positive shape, not a bug in the test.

### 0.3 [BLOCKING, Opus; proved by running it against the incident itself] the proposed pre-ship mitigation is inverted and cannot help

v4 §7 proposed cross-referencing every new episode against `getQuickReversals()` (a 60-second window)
before trusting it. Opus ran this directly: **it flags the named incident's own entry transition**
(`into_bed 20:43:57 → out_of_bed 20:44:36`, a 39-second gap, exactly the shape `getQuickReversals`
looks for) as a "quick reversal" needing manual review — the mechanism's own motivating true positive
comes back flagged as suspicious. And it misses both of this round's demonstrated false-positive shapes
(§0.2's 90-second legs, and §0.6-of-v4's other case), since both sit outside the 60-second window.
Structurally this cannot be fixed by widening the window: any `(into_bed, out_of_bed)` pair inside 60s
that is corroborated is *already* rejected by §0.3's backward guard before it can become part of an
episode at all — so the only pairs left for a cross-reference check to examine are exactly the ones the
backward guard already declined to flag, which skews toward the population most likely to be genuine.

**v5 fix**: drop the cross-reference check entirely rather than attempt to repair a mechanism proven to
point the wrong way. The residual risk it was meant to catch (§0.2/§0.6, adult-visit-bracketed gaps) is
named plainly in §4 as unmitigated and left to ROADMAP §1.2 item 3, and to the existing, already-honest
mitigation this codebase already relies on for every classifier change: **read the actual nights that
flip** during the 44-night scoring pass (§7) rather than trust a mechanical proxy check that has now
been shown not to work.

### 0.4 [HIGH, Opus, new] `bedOccupiedFrom` is now called in the direction its own contract explicitly forbids

`sleepAnalysis.js:836-841`'s comment is explicit: *"its only caller uses a true result to REJECT
something, so it returns FALSE when it cannot tell"* — a false `true` is a safe false-negative for
every existing caller (`reversedBy`, `settlingTail`). v5's §2 (unchanged from v4 here) calls it in the
**admit** direction (`if (!bedOccupiedFrom(entryIdx)) continue` — a true result lets the episode
through). Opus demonstrated a false `true` becoming a false positive: a child genuinely leaves and never
returns; a spurious `into_bed` fires minutes later; a parent strips the now-empty bed 90+ minutes
after that, inside `bedOccupiedFrom`'s 150-minute witness window — the parent's own motion corroborates
a return that never happened, and a 6-minute fake episode is created from a bed nobody was in.

**v5 fix**: name this explicitly as an accepted, documented residual risk (§4), not a mechanism change
this round — both reviewers agree the alternative (a genuinely new, asymmetric occupancy primitive)
is a real redesign, not a surgical fix, and the existing `bedOccupiedFrom`-as-corroboration approach is
inherited directly from the already-shipped, already-scored `reversedBy` pattern. **Required in the
same commit as implementation**: update `bedOccupiedFrom`'s comment at :836-841 — it now has a second
caller that uses a true result to *admit* rather than reject, and the comment's blanket claim about
"its only caller" is no longer accurate.

### 0.5 [HIGH, Opus, new — answers v4's own open question #1] the backward guard can suppress a genuine departure

Demonstrated by execution: a real 8-minute out-of-bed episode, preceded by one spurious `into_bed` 30
seconds earlier that happens to be corroborated by the *child's own later occupancy* (i.e., the child
really is in the bed both before and after — the spurious marker is just noise), is silently dropped:
the backward guard (§0.3 of v4, unchanged in v5) sees a corroborated `into_bed` within
`JITTER_REENTRY_MS` before the real exit and treats it as settling-cluster noise. With 62% of
transitions on record provably wrong (same type twice in a row, `bedTransitionRules.js:39-41`), a
stray marker in a 60-second window ahead of a real exit is this classifier's documented normal case,
not a contrived one.

**v5 fix**: name this explicitly (§4) rather than add a `settlingFallback`-equivalent (which the
existing `settlingTail` guard has, precisely because suppressing the *terminal* wake entirely would
report "still asleep" for a child plainly up — a much worse claim than this pass silently producing no
mid-night episode). A missed mid-night episode is a false negative in the safe direction this file
already treats as acceptable elsewhere; a fallback here would reintroduce exactly the kind of
last-resort override both prior rounds worked to keep narrow and well-bounded. No fallback is added,
and the reasoning for not adding one is stated here rather than left as a silent gap.

### 0.6 [HIGH, Opus, new] a false settling tail beyond 60 seconds still manufactures an episode

Demonstrated: `out@23:00:00 → in@23:00:20 (settled) → out@23:01:30 (70s after the in — past
JITTER_REENTRY_MS) → in@23:08:00` produces a fake 6.5-minute episode, because the 70-second tail clears
the backward guard's 60-second window. This is not a new discovery about the *world* — `JITTER_REENTRY_MS`'s
own existing comment in `sleepAnalysis.js` already states the false-tail and real-exit populations
**overlap** and *"no window would"* separate them cleanly. v5 inherits that already-accepted limitation
rather than introduces a new one.

**v5 fix**: add to §4's named-limitations list, citing `JITTER_REENTRY_MS`'s own comment as the reason
no window-widening fix is attempted.

### 0.7 [HIGH, Opus, new] a consecutive-exit cluster starts the episode late

Demonstrated: `out@23:00:10 → out@23:04:00 → in@23:06:00` (two `out_of_bed` markers in a row, the
62%-wrong classifier's own documented failure shape) produces an episode `23:04–23:06`, not
`23:00–23:06` — because the pairing rule requires the transition immediately following a candidate exit
to be an `into_bed`, so the first, earlier exit is skipped entirely and the second is used instead. Four
minutes of a real absence go uncounted.

**v5 fix**: named as an accepted scope limitation (§4) — the episode is still detected (not missed
entirely), just under-durationed. A multi-hop pairing rule that walks past a same-type repeat to find
the "real" first exit is a genuine mechanism extension, not a surgical fix, and is explicitly left for a
future round if the scoring pass shows this shape matters in practice.

### 0.8 Housekeeping (Codex #4, Opus M2-M6, L1-L3)

- `txMs` is added as an explicit parameter to the extracted function (it is a `computeNight`-local at
  line 600 today, not in scope for a genuinely standalone function — v4's pseudocode called it without
  declaring it).
- The call site (§2) explicitly gates on `USE_TRANSITION_WAKE_EPISODES` (§5's revert lever), stated
  alongside a note on its interaction with `USE_TRANSITION_TIMES`: reverting wake **times** alone does
  not revert wake **counts** if the episodes lever stays on — the two are independent switches and a
  revert of one without the other is a real, documented configuration, not an oversight.
- §0.12's stated expected output for the named incident adds `longest_stretch_minutes: 609 → 545`
  (confirmed by Opus's execution; the quiet run splits at the episode) — omitted from v4, now stated.
- `bedOccupiedFrom`'s comment fix (§0.4) is required in the same commit.
- The tie-break citation in v4 (§0.8 of v4) pointed at the wrong lines (`bedTransitions.js:191`/`234-238`
  are **descending**-id, newest-first list sorts) — the actual ascending precedent is
  `findQuickReversals`'s helper in `bedTransitionRules.js`. Corrected here.
- One comment, not a code change: the positional pairing rule is only safe because `scoreCams` is
  exactly one camera per call (`sleepAnalysis.js:452-471`) — state this assumption explicitly since
  `findQuickReversals`'s own documentation warns transitions can span cameras in other contexts.
- §8's boundary test for an episode entry landing at `sleepEnd - 1` states the concrete resulting
  `wakes[]` row it must produce (confirmed reachable by Opus's case 10), not a vague "confirm no bad
  interaction."
- The backward guard's `<=` vs. the tie-break's `id ASC` can disagree at an identical-second boundary
  (an `into_bed` at the same second as the candidate exit sorts after it positionally but still
  satisfies the guard's time-based `<=` check) — this is intentional and matches `settlingTail`'s own
  stated reasoning (`sleepAnalysis.js:1009-1012`) for using `<=` rather than `<`; stated here so it
  reads as a deliberate choice, not confusion between two orderings.

## 1. The problem (unchanged from v3 §1 / v4 §1)

Raffa, 2026-09-09, prod, camera `dce8157e`: `out_of_bed 20:41:30 → into_bed 20:43:57 → out_of_bed
20:44:36`. Three active minutes (20:41, 20:44, 20:45) against `WAKE_ACTIVE_MIN = 5`.

## 2. The mechanism (v5 — only the quiet-range check and the `txMs` parameter changed from v4)

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

    // backward settling-cluster guard (v4 §0.3, unchanged) — named limitation at §0.5/§0.6 above
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

    // v5 §0.1 — BOTH ends excluded, and the range must be non-empty
    if (entryIdx - exitIdx < 2) continue;
    let quiet = true;
    for (let i = exitIdx + 1; i < entryIdx; i++) {
      if (cribActExt[i] !== false) { quiet = false; break; }
    }
    if (!quiet) continue;

    episodes.push({ start: exitIdx, end: entryIdx });          // marked-awake span unchanged, inclusive
  }
  return episodes;
}
```

Applied once, guarded by both `!inProgress` and `USE_TRANSITION_WAKE_EPISODES` (§0.8), at the same
single fixed point as v4 (immediately after line 1227, before line 1229):

```
if (!inProgress && USE_TRANSITION_WAKE_EPISODES) {
  for (const { start, end } of detectMidnightEpisodes(transitions, cribActExt, bedOccupiedFrom, txIdx, txMs, onset, sleepEnd)) {
    for (let i = start; i <= end; i++) inWake[i] = true;
  }
  ({ asleep, awake, wakeCount, longest } = accumulateMetrics(inWake, onset, sleepEnd));
}
```

## 3. Item 3 — unchanged deferral (v4 §3); §0.2/§0.3's dropped mitigation makes the deferral's scope more honest, not smaller

## 4. What is NOT attempted — the full, current list

Unchanged from v4 §4 (excursions >20min, in-progress nights, the `empty`-status ordering interaction, no
wake clip for a new wake, the Renz/Raffa asymmetry), **plus, newly named this round**:

- An adult visit bracketing a quiet gap is indistinguishable from a real child episode (§0.2) — no
  mitigation attempted this round; item 3's job.
- `bedOccupiedFrom` used in the admit direction can be fooled by an unrelated later occupied reading,
  e.g. a parent handling an empty bed (§0.4).
- The backward guard can suppress a genuine mid-night departure when an unrelated spurious `into_bed`
  is itself corroborated by later occupancy (§0.5) — a false negative, the safe direction, no fallback
  added, reasoning stated.
- A settling tail beyond `JITTER_REENTRY_MS` still manufactures an episode (§0.6) — inherits a
  limitation this file's own `JITTER_REENTRY_MS` comment already documents as unfixable by any window.
- A consecutive same-type-exit cluster under-durations a real episode rather than missing it outright
  (§0.7).

This is a longer list than v4's. That is the honest result of running the mechanism against
constructed adversarial data rather than reasoning about it in prose — every item is either a
false-negative (safe direction) or a narrow, named false-positive shape explicitly deferred to item 3,
not a silent gap.

## 5. Revert lever

`USE_TRANSITION_WAKE_EPISODES` (unchanged from v4 §5), now explicitly wired into §2's call site (§0.8).

## 6. Docs and changelog

Unchanged from v4 §6, plus: `bedOccupiedFrom`'s comment update (§0.4) ships in the same commit.

## 7. Scoring

Unchanged hard gates and positive gate from v4 §7. **§0.3's cross-reference check is dropped** — replaced
by the existing, already-relied-on discipline: read every night whose `wake_count` changes in the
44-night scored set by eye before trusting the change, same as every other classifier change this
session. `wake_count`-decrease gate and `bed_transitions.verdict` query unchanged from v3/v4.

## 8. Test plan

Unchanged from v4 §8 except:
- The named-incident fixture's must-be-quiet assertion now checks `{20:42}` only (one minute, both
  endpoints excluded), not `{20:42, 20:43}`.
- A genuine-episode fixture where the return's motion lands in the entry's own bucket (Opus's case 12
  shape) — assert an episode **is** still produced (this is exactly the case v4 failed and v5 fixes).
- A 65-second-gap fixture with adjacent buckets — assert no episode (empty range, not a false accept).
- §0.6's test uses the corrected 90-second-legs example (§0.2 above) and asserts an episode **is**
  produced, with a comment stating this is a known, accepted false-positive shape.
- Add `longest_stretch_minutes` to the named-incident fixture's assertions (§0.8).
- Add the four newly-named-limitation cases (§0.4-§0.7) as explicit tests with comments citing this
  plan's section — each documents the accepted behavior, it does not assert it away.
- The `sleepEnd - 1` boundary test states the concrete resulting `wakes[]` row.
- Query real prod `activity_samples` for camera `dce8157e`, bucket 20:41, 2026-09-09 before writing the
  named-incident fixture — settle §0.1's flagged-unverified claim with a real number rather than an
  assumption, and build the fixture's `cribActExt[41]` value from what's actually measured.

## 9. Open questions for this round

1. Is dropping the pre-ship cross-reference check (§0.3) and relying on "read every flipped night by
   eye" during the 44-night scoring pass an adequate practical mitigation for the adult-visit false
   positive shape, or does it need a more concrete, checkable step stated here rather than deferred to
   scoring-time judgment?
2. Any remaining issue in v5's §2 pseudocode that four rounds of review, including two rounds of direct
   execution against real fixtures, still hasn't caught.
3. Given the list in §4 has grown this round (5 new named limitations) rather than shrunk to zero — is
   this a reasonable, honestly-scoped plan to build from, or does the accumulation itself indicate the
   mechanism needs to be simpler than "one more guard" can fix?
