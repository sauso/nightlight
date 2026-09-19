# Plan v3: a corroborated, verified-empty short mid-night gap counts as a wake

Status: DRAFT — for Codex (`gpt-6-astra`) + an independent Opus subagent review before any code is
written. v2 (`midnight-wake-plan-2026-09-13-v2.md`, commit e131550) was reviewed by Codex and an
independent Opus subagent. Both **confirmed the redesigned mechanism now fixes its own motivating
incident** (v1 could not do this at all) — this round found concrete, fixable bugs in a sound design,
not a broken one. v3 fixes each, verified against real prod data where possible rather than re-argued
from first principles. Section 0 maps every v2 finding to what changed.

## 0. What v2 got wrong, and what changed

### 0.1 The pairing rule could manufacture an episode by skipping a disqualifying return

Both reviewers independently constructed adversarial sequences (Codex: `out@0s → in@30s → out@40s →
in@90s`; Opus: `out@0 → in@35s → out@14min → in@19min`) showing v2's "find the first entry satisfying
the >60s floor" rule **skips** a too-close return instead of being **settled** by it, then pairs the
original exit with a much later, unrelated return — manufacturing a fake episode spanning real
settling noise.

**v3 fix**: evaluate exactly ONE candidate per exit — its immediately next `into_bed`, full stop, never
searched past:

```
entry = the transition immediately following `exit` (any type check unnecessary — the classifier
         alternates types far more often than not, and if the very next transition is somehow another
         out_of_bed, there is nothing to pair with and this exit produces no episode)
if no entry exists: no episode
elif entry.time - exit.time <= JITTER_REENTRY_MS: settled (this is the tail of the same movement,
     not a new departure and not an episode) — exit produces no episode, and critically, the search
     does NOT continue to a later entry
elif entry.time - exit.time > MORNING_ABSENCE_MIN: out of scope for this pass (may or may not become
     the terminal departure via the EXISTING, unmodified scan; this pass does nothing here)
elif not bedOccupiedFrom(txIdx(entry)): uncorroborated return (62%-wrong-classifier caution applies
     the same way it does everywhere else in this file) — no episode, and no further search
elif the gap shows ANY confirmed-active (`cribActExt[i] === true`) minute (see §0.2): no episode
else: genuine episode [exit, entry). Claim it; resume the outer loop from entry's index.
```

Every exit gets exactly one verdict from exactly one candidate. There is no code path that searches
past a disqualified candidate to find a later one — the exact shape both reviews attacked is now
structurally absent, not just guarded against.

### 0.2 No positive requirement that the bed was actually empty during the gap

Opus connected this directly to evidence already in the repo: PR #427/#428's own measurement found
**60% of 86 "quick reversal" pairs (an `into_bed` immediately undone by an `out_of_bed`) show the bed
continuing normal `motion_peak > MOTION_ACTIVE` activity in the following hour** — meaning the bed
never actually emptied; the leading theory is a parent leaning in and leaving (a goodnight kiss),
misread as a departure with no child movement at all (`bedTransitions.js`'s own comment on
`getQuickReversals`). v2's only evidence check was "was the return corroborated" — nothing checked
whether the bed was actually empty *during* the gap, so this exact population (short, and — per v0.1's
own bound — squarely inside v3's 1-20 minute acceptance window) would have been converted into fake
wakes, worse than in v1 because the window is *shorter*, closer to a kiss's actual duration.

**v3 fix**: require the gap `[exit, entry)` to show **zero confirmed-active minutes** in `cribActExt`
(the same tri-state array, same `MOTION_ACTIVE` threshold, already used elsewhere in this exact file
to decide "is the bed empty"). Tri-state handling matches the existing convention: an unobserved
(`null`) minute neither confirms nor denies — only a confirmed-active (`=== true`) minute disqualifies.
No new constant; reuses the file's own existing empty-bed evidence exactly as-is.

**Verified against the real named incident** (query run on prod, 2026-09-13): both sampled minutes in
the gap (20:42, 20:43 local) read `motion_peak = 0`, confirmed quiet — the new requirement does not
exclude the incident this plan exists to fix. Also verified: the return at 20:43:57 is genuinely
corroborated (11 of 150 following minutes clear `OCCUPANCY_MIN_PEAK`, well past the 3-minute bar) —
this was inferred, not measured, in v2; it is now measured.

### 0.3 The fix changed stored numbers but not what the detail page renders

Both reviewers found the same gap: v2's final step re-ran `accumulateMetrics` on a new `inWakeFinal`
array but never said `inWake` itself gets replaced — so `wake_count`/`awake_minutes` (read by the child
card) would disagree with the timeline, the `wakes[]` list, and segment labels (all of which read
`inWake` directly), recreating in mirror image the exact "why no wake-up row" complaint that produced
Gap A.

**v3 fix, stated explicitly this time**: `inWake` **is reassigned in place** to the OR'd result. This
is safe specifically because `algoSleepEnd`, `wake_at_algo`, `sleepEnd`, and `transitionExitIdx` are all
already captured as plain numbers before this reassignment runs (Opus independently verified this
ordering holds and cannot be perturbed, given the reassignment happens strictly after all four
captures) — nothing downstream of the reassignment re-derives any of those four values from `inWake`
again. `wakes.length` may now exceed the stored `wake_count` by more than the existing +1 documented
for PR #420's morning row; state this plainly rather than silently changing an existing invariant's
meaning (matching the posture already taken for that +1 itself).

### 0.4 `wake_count` can decrease, not just increase

Opus's concrete construction: two activity-based wake runs 4+ minutes apart (already possible — that's
why they weren't bridged by `WAKE_GAP_MIN`), with a corroborated transition-episode spanning the gap
between them, merge into ONE run under `accumulateMetrics`'s simple edge-counting (`!prevWake →
wakeCount++`) — `wake_count` drops from 2 to 1 while `awake_minutes` rises. Plausible real shape: a
child cries, is lifted out, returned, cries again — arguably TWO real wakes, now reported as one.

**v3 fix**: not a code change (merging is not obviously wrong — a single continuous "up and unsettled"
period could legitimately be one wake) but an explicit scoring requirement (§7): **report every night
where `wake_count` decreases, expect zero, treat any non-zero as a stop requiring inspection of that
specific night** before shipping, not an assumption that "additive evidence" only ever adds.

### 0.5 `bedOccupiedFrom`/`cribActExt` are scoped where the fix needs to run from outside

Both reviewers noted `bedOccupiedFrom`, `cribActExt`, `cribOccExt`, and `totalMinExt` are declared
inside the `!inProgress` block (`:783-1057`), while v2's final step was described as running "after"
that block closes — making direct reuse impossible without either hoisting these primitives out of a
block that has been adversarially hardened five separate times, or restructuring.

**v3 fix**: the episode-detection walk itself runs **inside** the `!inProgress` block, where every
primitive it needs is already in scope — it becomes one more pass alongside the existing
morning-departure scan, not a foreign function called from outside it. Its OUTPUT (a plain list of
`{startIdx, endIdx}` spans) is a hoisted `let`, computed inside the block, and only *applied* (the
`inWake` reassignment from §0.3) after the block's existing logic has already produced
`algoSleepEnd`/`wake_at_algo`/`sleepEnd`. This also makes the `in_progress`-night exclusion structural
(the walk simply cannot run outside the block it needs) rather than a stated convention to remember.

### 0.6 The boundary-straddle question (v2 §10, open) is resolved, not just answered "probably fine"

Opus proved algebraically that when a corroborated departure exists (`transitionExitIdx != null`), no
episode this pass finds can ever be the same span the terminal scan calls `wake_at` — every qualifying
`(exit, entry)` pair is a strict subset of what the terminal scan's own `reversedBy` check already
rejects as "not a departure" (same 20-minute bound, no lower bound, same corroboration; a proof, not an
assertion, since a departure `D` strictly between `exit` and `entry` would itself be reversed by
`entry` and therefore never selectable as `transitionExitMs`).

**The residual case, now closed rather than left open**: when NO corroborated departure exists (a
movement-only `sleepEnd`), an exit before `sleepEnd` could theoretically pair with an entry after it.
**v3 fix**: bound candidate `exit`/`entry` pairs to `[onset, sleepEnd)` explicitly — require **both**
endpoints inside that range, not just the exit. This closes the residual case with an explicit check
rather than an accepted-but-unfixed edge.

### 0.7 §1's own arithmetic was wrong, and would have produced the wrong test fixture

v2 said "2 dead minutes bridge two 1-minute active readings into a 3-minute run against a threshold of
5." Per the ROADMAP's own numbers, there are **three** active minutes (20:41, 20:44, 20:45), not two,
and "3" is the *count* `markWakeRuns` compares (`count >= WAKE_ACTIVE_MIN`), not a span length. Restated
correctly here and in §8's fixture spec, since a fixture built from the wrong arithmetic risks passing
against unmodified code for the wrong reason (see §8).

### 0.8 Naming corrections

"Kill switch" (v2 §5) overstated what `USE_TRANSITION_TIMES`-style constants actually are: a module
constant requiring a code edit and redeploy to flip, not a live toggle. Restated as "revert lever",
matching the actual mechanism. `bedOccupiedFrom`'s existing comment (`:836-841`) documents its safety
argument in terms of "used to reject" — once this plan adds a second caller that uses a `true` result to
*create* an episode rather than reject a candidate, that comment needs a line added in the same commit
(the fail-open direction is still safe for the new caller, but the comment no longer describes both
callers).

### 0.9 README contradicts the shipped behavior if only the "how it estimates" bullet is touched

`README.md` currently states: *"A child who gets out and climbs straight back in has not got up... the
night carries on rather than ending there."* This plan makes exactly that pattern **count as a wake**
(while the night still correctly continues rather than ending). Both the "how it estimates" bullet and
this one need updating in the same commit, or the docs actively contradict what ships.

## 1. The problem (unchanged, now measured rather than inferred)

Raffa, 2026-09-09, prod, camera `dce8157e`: `out_of_bed 20:41:30 → into_bed 20:43:57 → out_of_bed
20:44:36`. Real detection alerts fired on both flanks. The wake-count path ignores `bed_transitions`
entirely; per the ROADMAP's measured minutes, the run is 3 active minutes (20:41, 20:44, 20:45) against
`WAKE_ACTIVE_MIN = 5` — two short, not "close to" five, exactly.

## 2. The mechanism (v3)

See §0.1 and §0.5 for the corrected pairing rule and where it runs. In full, inside the `!inProgress`
block, after the existing morning-departure scan's own logic has run and produced `algoSleepEnd`,
`wake_at_algo`, `sleepEnd`, `transitionExitIdx` (all untouched by this new pass):

```
episodes = []
for each out_of_bed transition `exit` in transitions, at/after onset, at/before sleepEnd,
          not already inside a claimed episode:
  entry = the transition immediately following `exit` in the full transitions list
  if !entry or entry.type !== into_bed: continue        // nothing to pair with
  if entry.time >= sleepEnd: continue                    // §0.6 — stay inside the decided range
  gap = entry.time - exit.time
  if gap <= JITTER_REENTRY_MS: continue                  // settled, not searched further
  if gap > MORNING_ABSENCE_MIN: continue                 // out of scope for this pass
  if !bedOccupiedFrom(txIdx(entry.created_at)): continue // uncorroborated return
  if any cribActExt[i] === true for i in [txIdx(exit), txIdx(entry)): continue  // §0.2 — bed
                                                          // wasn't actually empty during the gap
  episodes.push({ start: txIdx(exit), end: txIdx(entry) })
  // resume scanning from entry's index — handled by the outer loop's "not already claimed" check
```

Then, as the one and only place this plan touches existing state (§0.3): `inWake` is reassigned to
itself OR'd with every episode's span, and `accumulateMetrics` is re-run over the (now-final) `inWake`
for whichever range (`[onset, sleepEnd)` or the `metricsEnd`-extended range) the existing logic already
decided — covering both call sites uniformly, since both leave `inWake` and the final range as
resolvable values by the time this step runs (Opus's V2 finding: this part of v2's design already held
correctly and is unchanged in v3).

## 3. Item 3 — still deferred, but the deferral is now narrower and stated honestly

§0.2's new empty-gap requirement removes the *specific* false-positive population this session's own
PR #427/#428 measured (continued bed motion after a supposedly-reversed exit) — which was Opus's
strongest objection to deferring item 3 in v2. What remains deferred is item 3's actual canonical
example (a bedtime put-down, pre-onset, structurally outside this pass's range) and the general
question of parent-vs-child classification for cases §0.2's check doesn't cover. Recommend still
closing Gap B on its own; item 3 remains its own measurement task, now with less riding on it than v2
implied, since its most damaging failure mode against `wake_count` specifically is what §0.2 fixes.

## 4. What is NOT attempted, stated plainly

- Excursions longer than `MORNING_ABSENCE_MIN` (the 225/584-minute nights from the broader
  remeasurement) — unchanged from v2, still deferred, still needs its own positive empty-run design.
- `in_progress` (live, tonight-so-far) nights — structurally excluded by §0.5's placement, not just by
  convention.
- The interaction with the `empty`-night early return (`maxBedPeak < EMPTY_BED_MAX_PEAK && wakeCount
  === 0 && awake === 0`, which runs *before* this pass and could theoretically classify a night `empty`
  before a genuinely corroborated episode is ever considered). Both reviewers found this; neither
  recommended fixing it now — moving the check earlier risks the `status` field flipping in ways issue
  #351's notification-timing logic depends on not happening. **Documented as a known, narrow-band
  limitation** (the peak range where this could occur is `[OCCUPANCY_MIN_PEAK, EMPTY_BED_MAX_PEAK)` —
  200× wide, but both bounds are already this file's own calibrated numbers, not new ones), not silently
  left unmentioned.
- A newly-counted wake has no wake clip (`wakeWatcher.js` cannot retroactively know about a
  corroborating return minutes in the future) — unchanged from v2, still disclosed, not fixed.
- The Renz/Raffa per-installation asymmetry (all four broader-remeasurement nights are Raffa's; Renz's
  documented zone-reading problem would likely mean this fix doesn't fire for him at all) — unchanged
  from v2, still a named, accepted limit.

## 5. A revert lever (renamed from v2's "kill switch")

`USE_TRANSITION_WAKE_EPISODES` (boolean module constant, default `true` once shipped), exactly matching
`USE_TRANSITION_TIMES`'s existing convention and its own comment style. Flipping it requires a code
change and redeploy, same as its sibling — stated accurately this time (§0.8).

## 6. Docs and changelog (unchanged scope from v2, now with the missed bullet named — §0.9)

`README.md`: both the "how it estimates" bullet and the "climbs straight back in" bullet need updating
in the same commit. `CHANGELOG.md`: one `[Unreleased]` entry. `planning/ROADMAP.md` §1.5 Gap B closes;
§1.2 item 3 stays open with a note on what §0.2 already covers.

## 7. Scoring

**Hard gates, unchanged and still necessary but (per Opus) not sufficient alone**: onset and final
`wake_at`/`sleepEnd` byte-identical on all 44 scored child-nights, both environments. Paired now with a
**positive gate**: some non-zero, bounded number of nights must change, and the named incident must be
among them — a gate that passes identically on a no-op implementation is not a gate.

**New this round**: report every night where `wake_count` DECREASES (§0.4) — expect zero on the scored
set; any non-zero blocks shipping until that specific night is understood. Report every night whose
`status` sits in the narrow `empty`-adjacent peak band named in §4, so the interaction is visible even
though it isn't fixed.

**Precision, using the oracle that already exists**: query `bed_transitions.verdict` directly (not
cited from memory) for every exit/entry pair this pass's real-data run would use as evidence; any
transition already verdicted `wrong` is a demonstrable false positive today.

**What still has no oracle**: wake count correctness itself, as in v2 — same indirect validation
(aggregate size-of-change sanity check across all stored `status='ok'` nights, the named incident
specifically, `sleepInsights`' rolling correlation treated as spanning a measurement-definition change
the same way the 0.30.0 deploy already is).

## 8. Test plan

- The pairing state machine (§0.1) as a pure function, extractable cleanly since it no longer lives
  inside the departure-scan's own loop (unlike `reversedBy`/`settlingTail`, which stay untouched).
- Boundary tests at exactly `JITTER_REENTRY_MS` (excluded) and `+1s` (included); exactly
  `MORNING_ABSENCE_MIN` (included) and `+1s` (excluded).
- **The adversarial jitter-cluster sequence both reviews constructed** (`out@0 → in@35s → out@14min →
  in@19min`): assert **zero** episodes, not the fake 19-minute one v2 would have produced.
- **The §0.2 empty-gap requirement**, with a fixture where the gap shows real bed activity despite a
  corroborated return — assert no episode, using a *different* activity level than the corroboration
  fixture uses for its own micro-motion (Opus's specific warning: reusing one flat "occupied" fill value
  for both the gap and the post-return window makes the corroboration check pass for the wrong reason —
  every index in the fixture reads occupied, so nothing is actually discriminating "empty during the
  gap" from "occupied after the return").
- **The named incident, built from its corrected arithmetic (§0.7)**: 3 active minutes (20:41, 20:44,
  20:45), 2 confirmed-dead minutes (20:42, 20:43), the real transition timestamps, corroboration
  present. Two required assertions, not one: **the test must first be run and confirmed to FAIL against
  unmodified `dev`** (proving it discriminates), *then* pass once the fix lands.
- A fixture where the corroborating micro-motion is absent (a genuinely uncorroborated `into_bed`):
  assert no episode — the "62% wrong" guard, tested here explicitly rather than assumed inherited.
- Confirm the fixture doesn't accidentally land on `status: 'empty'` before the assertion is even
  reached (Opus's specific trap: a too-sparse fixture trips the unrelated early return).
- `algoSleepEnd`/`wake_at_algo` byte-identical on a fixture where the episode's span **abuts the end of
  the analysis window** — not a mid-night fixture, which cannot discriminate a broken implementation
  that ORs episodes in before the shadow capture from a correct one (Opus's specific finding: a mid-night
  fixture passes either way).
- Both `markWakeRuns`/`accumulateMetrics` call sites (`totalMin`-bounded and `metricsEnd`-extended):
  confirm the single final combination step (§0.3) produces correct, consistent `wake_count` in both.
- The decrease case (§0.4): two activity-based wakes with a qualifying episode spanning the gap between
  them — assert the merge happens and is visible in the test output, not hidden.
- Mutation-test the boundary comparisons and the "settled, don't search further" branch specifically
  (this is exactly the logic both reviews broke), via `scripts/mutate.mjs`, added to
  `scripts/mutants.json`.
- Standard adversarial review (Codex + a parallel Opus or Claude subagent, isolated worktrees) before
  merge.

## 9. Open questions for this round

1. §2's walk treats "the transition immediately following `exit`" as the only candidate, with no type
   check beyond confirming it's an `into_bed`. Is there a realistic sequence where the classifier's own
   noise (a same-type-repeat, the 62%-wrong population `getImpossibleTransitions` already tracks) sits
   between a real exit and its real return, such that "the very next transition" is itself a spurious
   `out_of_bed`, making this exit's candidate search terminate at `continue` (no entry found where one
   really exists a step later)? If so, is that an acceptable false-negative (an episode simply not
   counted, which is always the safe failure direction in this file) or does it need handling?
2. Does moving the episode-detection walk inside the `!inProgress` block (§0.5) actually integrate
   cleanly given the block's existing control flow (multiple early returns, e.g. `status: 'empty'` at
   `:1189` before the walk would run) without needing to duplicate or restructure surrounding code more
   than this plan describes?
