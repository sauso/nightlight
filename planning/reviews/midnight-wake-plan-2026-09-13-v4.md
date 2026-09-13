# Plan v4: fix v3's off-by-one, resolve its placement trilemma, close the settling-cluster gap

Status: DRAFT — for Codex (`gpt-6-astra`) + an independent Opus subagent review before any code is
written. Both v3 reviews (Codex `gpt-6-astra`, an independent Opus subagent) confirmed the v2→v3
mechanism direction is sound but found v3 itself does not fix its own motivating incident as written,
plus a real structural placement problem and a genuinely new false-positive shape neither v1 nor v2
review caught. All findings below are grounded against the real, current
`backend/src/lib/sleepAnalysis.js` — every line reference was re-verified directly (not taken on
either reviewer's word) while writing this draft.

## 0. What v3 got wrong, and what changed

### 0.1 [BLOCKING, both reviewers independently] v3 produces ZERO episodes for the named incident

v3 §0.2's pseudocode checked the gap `[txIdx(exit), txIdx(entry))` for confirmed-active minutes, but
its own prod verification (the `verify-incident.cjs` run cited in v3) measured a *different* range —
the two whole minutes **between** the transitions (20:42, 20:43). `txIdx` **floors**
(`sleepAnalysis.js:609`: `Math.floor((txMs(t) - analysisStartUtc) / 60000)`), so for `out 20:41:30 →
in 20:43:57`, `txIdx(exit) = 41` and `txIdx(entry) = 43` — the range `[41, 43)` is `{41, 42}`, which
**includes minute 41, the exit's own minute**, where the child's own departure movement lives (20:41 is
one of the ROADMAP's three active minutes, `ROADMAP.md:514`). That minute reads active by
construction — a departure requires movement to register at all — so v3's check as literally written
rejects the incident it exists to fix. This is v1's failure mode recurring in a new form: a plausible
mechanism that, traced through real code, does not do what it claims.

**v4 fix**: two genuinely different ranges, not one reused for both jobs:

- **Must-be-quiet range** (the departure's absence): `(txIdx(exit), txIdx(entry)]` — i.e.
  `txIdx(exit)+1` through `txIdx(entry)` inclusive. This deliberately **excludes** the exit's own
  minute (which necessarily shows the exit movement) and **includes** the entry's own minute (verified
  quiet on the real incident: both 20:42 and 20:43 read `motion_peak = 0`).
- **Marked-awake span** (what becomes part of the wake): `[txIdx(exit), txIdx(entry)]` inclusive both
  ends — the child is "up" from the moment they leave to the moment they're back.

For the named incident this makes the must-be-quiet range exactly `{42, 43}` — precisely what the
verification script measured — and the marked-awake span `{41, 42, 43}`, three minutes, not two (v2's
and v3's own text both said "awake_minutes 0→2"; corrected here, see §0.11).

### 0.2 [BLOCKING, Codex + Opus independently, structural] v3's placement is not implementable as specified

v3 §0.5 required the pass to run *inside* the `!inProgress` block (`sleepAnalysis.js:783-1057`,
re-verified this draft) so it could reuse `cribActExt`/`bedOccupiedFrom`, but also required it to be
bounded by the *final* `onset`/`sleepEnd`/`transitionExitIdx` — all of which are computed **after**
that block closes: `onset` is reassigned from `transitionOnset` at line 1062 (inside the block, only
`algoOnset` exists — a looser, pre-adjustment value); `transitionExitIdx` at 1059-1060;
`algoSleepEnd`/first `sleepEnd` at 1132/1144; and `sleepEnd` can be extended again by the
`metricsEnd` step at 1202-1227. You cannot be inside a block and see values computed 75-170 lines after
it closes. v3's own open question #2 asked whether this was actually implementable; both reviewers
answered no, and Opus additionally found the premise of the question was wrong in a different way — the
block itself (`:783-1057`) contains **no early returns at all** (confirmed: the only `return`s in that
span are `bedOccupiedFrom`'s own, at 846/848); the `status: 'empty'` return that actually matters is at
line 1189, **132 lines after the block closes**, so it was never the obstacle control-flow made it look
like. The real obstacle is variable scope, not control flow.

**v4 fix**: hoist `cribActExt`, `cribOccExt`, and the `bedOccupiedFrom` closure to `let` bindings
declared alongside `totalMinExt` (line 782 — **already hoisted out of this same block today, for the
same reason**: issue #352's metrics extension needs it after the block closes. This is not a new
pattern; it is the block's own existing precedent, applied to two more of its locals):

```
let totalMinExt = totalMin;
let cribActExt = null, cribOccExt = null, bedOccupiedFrom = null;
if (!inProgress) {
  // ...existing body unchanged, except the three `const` declarations for cribActExt, cribOccExt,
  // and bedOccupiedFrom become plain assignments to the hoisted bindings above...
}
```

The new episode-detection pass itself becomes a plain, separately callable function (see §2), invoked
**once**, unconditionally guarded by its own `if (!inProgress)` check, at a single fixed point after
line 1227 (see §0.4) — not nested inside the departure-scan block at all. This also means the
`in_progress` exclusion is no longer "structural by placement" (since the primitives now survive past
the block) — it is instead an explicit, visible guard at the call site, which is written down here
rather than left implicit.

### 0.3 [BLOCKING, Opus, new bug not found in either prior round] the settling-cluster shape breaks v3's forward-only rule

v3's pairing rule (§0.1/§2 from v3) checks only *forward* — is the next transition after `exit` a
qualifying `into_bed`. The existing departure scan has **two** symmetric guards for exactly this
reason: `reversedBy` looking forward (`sleepAnalysis.js:977-988`) and `settlingTail` looking *backward*
(`:1013-1017`) — because the classifier documented at line 991 emits `out → in → out` for a single
climb-back-in, and the **third** marker of that cluster is not itself reversed by anything (nothing
follows it soon enough), so a forward-only check treats it as a fresh departure. Concrete break,
verified against v3's exact pseudocode:

```
out@00:00:00  →  in@00:00:30 (settled, ≤60s, correctly no episode)  →  out@00:00:45  →  in@00:10:00
```

`out@00:00:45` is the trailing marker of the same climb-back-in that just settled. v3's rule has no way
to know that — it looks only forward, finds `in@00:10:00` nine minutes later, and (if that return is
corroborated and the gap reads quiet, both easily true for a child who never actually left) manufactures
a fake ~9-minute episode from one settling wobble. The named incident's own third marker (`out
20:44:36`, 39 seconds after the 20:43:57 return) is this exact shape — v3 escapes it only because
nothing follows it for eight and a half hours. Move that same marker ten minutes earlier in a different
night and v3 invents an episode on the very pattern it was designed around.

**v4 fix**: before treating any `out_of_bed` as a candidate exit, apply a backward check mirroring
`settlingTail` exactly — reuses the same primitives, no new constant:

```
if there exists an into_bed `back` with txMs(back) <= txMs(candidate)
   and txMs(candidate) - txMs(back) <= JITTER_REENTRY_MS
   and bedOccupiedFrom(txIdx(back)):
  this candidate is settling-cluster noise, not a fresh departure — skip it entirely,
  do not pair it forward
```

Traced against the counterexample above: `out@00:00:45` fails this check (there's a corroborated
`in@00:00:30` fifteen seconds before it) and is skipped outright — it never reaches the forward-pairing
step, so it cannot manufacture the fake episode.

### 0.4 [Codex + Opus, pins v3's vague wording to an exact line] where the combination step must run

v3 §0.5 said the application point was "after the block's existing logic has already produced
`algoSleepEnd`/`wake_at_algo`/`sleepEnd`" — which permits a placement as early as line 1152, before the
`metricsEnd` extension (lines 1202-1227) has decided whether `sleepEnd` extends further. Verified: line
1222 does `inWake = new Array(metricsEnd).fill(false)` — a **wholesale replacement**, not a merge. Any
episode OR'd into `inWake` before that line is silently destroyed on any night where the extension
fires (confirmed real: `layPostWindowExitNight` in the test suite exercises exactly this branch).

**v4 fix, pinned to an exact line**: the combination step runs **once**, unconditionally, immediately
after line 1227 (i.e., right after the `if (USE_TRANSITION_TIMES && transitionExitIdx != null) { ... }`
extension block closes, whether or not it actually extended anything) and strictly before line 1229
(the `algoWakeAt` calculation). At that point `sleepEnd`, `onset`, and `inWake` are all in their final
form for whichever of the two branches ran — this is the one point in the function where that is
uniformly true.

### 0.5 [Codex + Opus independently] an all-`null` (unobserved) gap must not pass as "verified quiet"

v3 §0.2 disqualified only on `cribActExt[i] === true`, treating `null` (no sample — an outage, or real
time not yet elapsed) as passing. That inverts this file's own hardened, commented convention for the
identical class of question: the departure scan's absence-run test requires strict `=== false`
(`sleepAnalysis.js:927`, comment at 923-926: *"an unobserved minute... must stop a candidate run exactly
like a confirmed active one does"*) — because an unobserved minute is a data gap, not evidence of
emptiness, and treating it as emptiness lets a camera outage or a lag in flushing manufacture a wake
with zero positive evidence. This is the fail-**open**-toward-*creating* an episode direction, which is
the wrong one — v3's own text (its answer to open question #1) says a false negative is this file's
safe failure direction; a false positive from missing data is the opposite of that.

**v4 fix**: require `cribActExt[i] === false` for **every** minute in the must-be-quiet range (§0.1),
not merely "no minute reads `=== true`". Costs nothing on the named incident — both required minutes
are confirmed `false` in the real data.

### 0.6 [Opus, real but scoped down rather than solved] the empty-gap check does not remove the goodnight-kiss population, and v3 overclaimed that it did

v3 §0.2/§3 claimed the new gap-quiet check "removes" the false-positive population identified in
`bedTransitions.js:195-217` (`getQuickReversals` — 60% of 86 "quick reversal" `into_bed→out_of_bed`
pairs show the bed continuing normal motion in the following hour, meaning a parent's presence, not the
child leaving). That measurement is about motion **after** a reversal; v3's check only examines the
**gap itself**, a different window answering a different question. Counterexample: two consecutive
parent visits with the child never leaving —

```
in@03:00:00 (parent leans in)  out@03:00:30 (parent leaves)
in@03:05:00 (parent returns)   out@03:05:30 (parent leaves)
```

`out@03:00:30` pairs with `in@03:05:00`: gap 4m30s (in range), corroborated (the child is still there,
so `bedOccupiedFrom` is trivially true), and the gap itself can easily be quiet if the child sleeps
through it — exactly the premise this whole file already relies on (`sleepAnalysis.js:998`: "reads
EXACTLY 0.0000 for the eleven hours"). This produces a fake episode from two adult visits with the
child never out of bed at all — a different failure shape from §0.3's settling cluster, not fixed by
that guard.

**v4 fix: scope the claim down instead of building a third guard.** The within-gap quiet check (§0.1,
now correctly ranged) still has real value — it rejects the specific case where the bed keeps showing
genuine activity during the purported absence, which is real evidence against a departure. It is
**not** claimed to separate a parent's visit from a child's, because it structurally cannot: that is
ROADMAP §1.2 item 3's job, unchanged and still deferred (§3 below). This is now stated as a named,
tracked residual risk rather than an assumption: **before shipping, cross-reference every episode this
mechanism creates against `getQuickReversals()`'s own output** (`bedTransitions.js:218-239`, already
built and running) for the same night/camera — if either bounding transition of a new episode
coincides with a quick-reversal pair already on record, pull its snapshot and eyeball it before
trusting the episode (§7 makes this an explicit pre-ship check, not a scoring statistic to skim).

### 0.7 [Codex + Opus independently] the render-consistency fix (§0.3 of v3) is unchanged and still confirmed correct

Both v3 reviews independently re-verified this part of v3 holds, given the placement fix in §0.4:
`algoSleepEnd` (:1144), `sleepEnd` (:1132/:1151/:1225), `transitionExitIdx` (:1059), and `algoWakeAt`
(:1232) are all plain numbers, fixed before the new combination step's placement (§0.4). Nothing
downstream re-derives any of them from `inWake`. `out.timeline` (:1306), `out.wakes[]` (:1311-1318),
and segment `label()` (:1424) all read `inWake` directly, so replacing it in place (not maintaining a
parallel `inWakeFinal`) genuinely fixes the render-consistency gap v2 shipped with. **Unchanged from
v3, reconfirmed, not redesigned.**

### 0.8 [Opus] a nondeterministic tie-break in "the literal next transition"

`getBedTransitions` (`bedTransitions.js:142-153`) orders `ORDER BY created_at ASC` with **no** id
tie-break, and `created_at` has one-second resolution. v3's rule is positional ("the transition
immediately following"), so two transitions in the same second resolve in whatever order SQLite
happens to return them — a recompute of the same night could disagree with itself. The existing
guards avoid this because they are window-based (`reversedBy`/`settlingTail` search by time range, not
position), so a same-second swap doesn't change their outcome; v3's rule is the first thing in this
file to depend on transition *order* rather than time.

**v4 fix**: before the walk, sort a local copy of the relevant transitions with an explicit tie-break —
`created_at ASC, id ASC` — matching the convention already used for exactly this reason in
`bedTransitions.js:191` and `:234-238`. No behavior change on the vast majority of nights (same-second
transition pairs are rare), but the walk's result stops depending on undefined SQL ordering.

### 0.9 [Opus] unit and boundary errors in v3's own pseudocode

v3's §2 mixed millisecond deltas with the minute constant `MORNING_ABSENCE_MIN` (`sleepAnalysis.js:63`
is `20`, used elsewhere only as `MORNING_ABSENCE_MIN * 60000`) and compared an epoch-ms transition time
directly against a minute-index `sleepEnd`. Fixed in this draft's §2: every time comparison is in
milliseconds; every range/bound comparison against `onset`/`sleepEnd` goes through `txIdx` first.

### 0.10 [Opus] the adversarial test case in v3 §8 asserted the wrong outcome

v3 required `out@0 → in@35s → out@14min → in@19min` to produce **zero** episodes. Traced correctly
(and unaffected by any v4 fix — the backward guard in §0.3 does not reject `out@14min`, since the only
prior `into_bed` is 13m25s earlier, well outside `JITTER_REENTRY_MS`): `out@0` settles against `in@35s`
(no episode, correct); `out@14min` pairs with `in@19min`, a 5-minute gap, clears every check — this
**should** produce a real episode `[14min, 19min)`. The test's own purpose (proving the pairing rule
doesn't fabricate a fake span `[0min, 19min)` by improperly bridging the skipped `in@35s`) is satisfied
by asserting **no episode spans `[0, 19min)`** and a **separate, real** episode `[14min, 19min)` is
produced — not that nothing happens at all. Corrected in §8.

### 0.11 [Opus] v3's own worked numbers were off by one

v3 (following v2's original text) stated `awake_minutes 0→2` for the named incident. With the corrected
inclusive-both-ends marked-awake span (§0.1: `{41, 42, 43}`), the real answer is **0→3**. Stated
explicitly in §0.12/§8 rather than repeated uncorrected a third time.

### 0.12 The named incident's expected output, stated explicitly (v3 left this unstated — I10)

Exit `20:41:30` → entry `20:43:57`. Must-be-quiet range `{20:42, 20:43}` — confirmed `false` in real
data (verified). Marked-awake span `{20:41, 20:42, 20:43}` — three minutes. Result: `wake_count 0→1`,
`awake_minutes 0→3`, one wake row `20:41–20:44` (end-exclusive, matching the file's existing
`wakes[]` convention). Minutes `20:44`/`20:45` remain outside any wake run — they were part of the
*original* activity-run that failed `WAKE_ACTIVE_MIN` as a whole, and nothing in this mechanism
re-evaluates them; they stay classified as ordinary sub-threshold stirring, the same category this file
already treats every other small blip as. This is a visible, slightly surprising property (the reported
wake ends before the last real movement) — stated here so it is a documented, agreed design property,
not something discovered after the fact in a code review.

## 1. The problem (unchanged from v3 §1)

Raffa, 2026-09-09, prod, camera `dce8157e`: `out_of_bed 20:41:30 → into_bed 20:43:57 → out_of_bed
20:44:36`. Real alerts fired on both flanks. Three active minutes (20:41, 20:44, 20:45) against
`WAKE_ACTIVE_MIN = 5` — the run is real and two minutes short.

## 2. The mechanism (v4, corrected)

Runs as a separate, plain function (extractable, unit-testable without a spawned process — matching
this file's own stated reasoning for keeping `bedTransitionRules.js`-style logic pure), called **once**
immediately after line 1227 closes and before line 1229, guarded by its own `!inProgress` check (§0.2),
over the transitions list sorted with an explicit tie-break (§0.8):

```
function detectMidnightEpisodes(transitions, cribActExt, bedOccupiedFrom, txIdx, onset, sleepEnd) {
  const sorted = transitions.slice().sort((a, b) =>
    a.created_at === b.created_at ? a.id - b.id
    : a.created_at < b.created_at ? -1 : 1);

  const episodes = [];
  for (let k = 0; k < sorted.length; k++) {
    const exit = sorted[k];
    if (exit.type !== OUT_OF_BED) continue;
    const exitIdx = txIdx(exit.created_at);
    if (exitIdx < onset || exitIdx >= sleepEnd) continue;   // stay inside the decided range

    // §0.3 — backward guard: is `exit` itself the trailing marker of a settling cluster?
    const settlingBack = sorted.find(back =>
      back.type === INTO_BED
      && txMs(back.created_at) <= txMs(exit.created_at)
      && txMs(exit.created_at) - txMs(back.created_at) <= JITTER_REENTRY_MS
      && bedOccupiedFrom(txIdx(back.created_at)));
    if (settlingBack) continue;   // noise from an already-resolved settle, not a fresh departure

    // §0.8 — the literal next transition, nothing searched past
    const entry = sorted[k + 1];
    if (!entry || entry.type !== INTO_BED) continue;
    const entryIdx = txIdx(entry.created_at);
    if (entryIdx >= sleepEnd) continue;                     // stay inside the decided range

    const gapMs = txMs(entry.created_at) - txMs(exit.created_at);
    if (gapMs <= JITTER_REENTRY_MS) continue;                // settled — do not search further
    if (gapMs > MORNING_ABSENCE_MIN * 60000) continue;        // out of scope for this pass

    if (!bedOccupiedFrom(entryIdx)) continue;                 // uncorroborated return

    // §0.1/§0.5 — must-be-quiet range EXCLUDES the exit's own minute, INCLUDES the entry's
    let quiet = true;
    for (let i = exitIdx + 1; i <= entryIdx; i++) {
      if (cribActExt[i] !== false) { quiet = false; break; }  // strict === false — a null gap fails too
    }
    if (!quiet) continue;

    episodes.push({ start: exitIdx, end: entryIdx });          // §0.1 — marked-awake span, inclusive
  }
  return episodes;
}
```

Applied once, at the single fixed point (§0.4):

```
if (!inProgress) {
  for (const { start, end } of detectMidnightEpisodes(transitions, cribActExt, bedOccupiedFrom, txIdx, onset, sleepEnd)) {
    for (let i = start; i <= end; i++) inWake[i] = true;
  }
  ({ asleep, awake, wakeCount, longest } = accumulateMetrics(inWake, onset, sleepEnd));
}
```

`cribActExt`/`cribOccExt`/`bedOccupiedFrom` are the hoisted bindings from §0.2 (non-null only when
`!inProgress`, matching the guard here).

## 3. Item 3 — unchanged deferral, claim scoped down (§0.6)

Still deferred. §0.6 above removes v3's overclaim that the empty-gap check substitutes for it — it does
not, and item 3 (telling a parent's handling of the bed from a child's own movement) remains its own,
separate measurement task.

## 4. What is NOT attempted (unchanged from v3 §4, plus §0.6's residual risk named explicitly)

- Excursions longer than `MORNING_ABSENCE_MIN`, `in_progress` nights (now an explicit guard, §0.2, not
  structural-by-placement), the `empty`-status early-return ordering interaction (still before this
  pass; still not fixed, per Opus's original "leave it, document it" — unaffected by any v4 change since
  the application point in §0.4 is still after line 1189), no wake clip for a newly-counted wake, the
  Renz/Raffa per-installation asymmetry — all unchanged from v3.
- **New, named here**: the mechanism cannot distinguish an adult's bed visit from the child's own
  movement (§0.6) — the within-gap quiet check filters continued-activity cases but not a quiet gap
  bracketed by two adult-caused transitions. Mitigated only by the pre-ship cross-reference check in
  §7, not solved.

## 5. Revert lever (unchanged from v3 §5)

`USE_TRANSITION_WAKE_EPISODES`, module constant, code-edit-and-redeploy, same convention as
`USE_TRANSITION_TIMES`.

## 6. Docs and changelog (unchanged from v3 §6)

`README.md`'s two bullets, `CHANGELOG.md` `[Unreleased]`, `planning/ROADMAP.md` §1.5 Gap B closes, §1.2
item 3 stays open with a note on what §0.1's quiet check does and does not cover.

## 7. Scoring

Unchanged hard gates (byte-identical onset/final-wake on all 44 scored nights) and positive gate (a
bounded non-zero number of nights change, named incident included) from v3. Added this round:

- **The `getQuickReversals` cross-reference (§0.6)**: for every night in the scored set where this
  mechanism creates an episode, check whether either bounding transition also appears in that night's
  `getQuickReversals()` output. Any overlap gets its snapshot pulled and reviewed by eye before that
  night counts toward "shipped correctly" — this is the concrete form of the residual risk in §0.6,
  not a statistic to skim.
- `wake_count`-decrease gate (unchanged from v3 §0.4/v2 finding): expect zero, any non-zero blocks
  shipping until understood.
- Query `bed_transitions.verdict` directly (not from memory) for every transition this pass's real-data
  run would use as evidence — any already-verdicted `wrong` is a demonstrable false positive today.

## 8. Test plan

- `detectMidnightEpisodes` as a pure function (now genuinely extractable — §2's design has no closure
  dependency beyond its explicit parameters).
- Boundary tests at exactly `JITTER_REENTRY_MS` (excluded, settled) and `+1ms` (included, evaluated
  further); exactly `MORNING_ABSENCE_MIN*60000` (included) and `+1ms` (excluded).
- **The settling-cluster sequence (§0.3)**: `out@0 → in@30s → out@45s → in@10min`. Assert **zero**
  episodes — `out@45s` must never reach the forward-pairing step at all (assert this directly if the
  function exposes which candidates were skipped by the backward guard, not just the final episode
  list).
- **The corrected jitter-cluster case (§0.10)**: `out@0 → in@35s → out@14min → in@19min`. Assert no
  episode spans `[0min, 19min)`, and a real episode `[14min, 19min)` is produced.
- **The all-null gap (§0.5)**: a fixture where the must-be-quiet range has `cribActExt[i] === null` for
  every `i` (simulating an outage/unflushed data). Assert no episode — the veto must fire on missing
  data, not only on confirmed activity.
- **The goodnight-kiss counterexample (§0.6)**: two adult visits, child never leaves, built with
  genuinely different occupancy values for the "gap" vs. the "corroboration window" (not the same flat
  fill value — a fixture where everything reads one constant cannot discriminate). Document the
  expected outcome honestly: this mechanism as designed **will** produce an episode here (§0.6 is a
  named limitation, not a fix) — the test exists to confirm the behavior is understood and unchanged by
  accident in a future edit, not to assert it's absent.
- **The named incident, exact real data (§0.12)**: transitions and activity samples as verified against
  prod. Required assertions: `wake_count 0→1`, `awake_minutes 0→3`, wake row `20:41–20:44`. **Must be
  run and confirmed to FAIL against unmodified `dev` first.**
- **The `laySettlingTailNight` trap (§0.11/M14 from the Opus review)**: that existing fixture
  (`sleepAnalysis.test.js:~675`) already passes on unmodified `dev` with a continuous 5-active-minute
  pattern — a new regression test reusing its name or timestamps without the genuinely sparse pattern
  (41 active / 42-43 quiet / 44-45 active) proves nothing. State this explicitly in the test file
  itself as a comment, not just in this plan.
- A boundary test where the episode's entry lands exactly at `sleepEnd - 1` (the last valid minute) —
  confirm this does not interact badly with the `wakes[]` morning-row merge logic
  (`sleepAnalysis.js:~1365`, `lastRunEnd === sleepEnd`), which was flagged as unchecked in the v3 review.
- Both `markWakeRuns`/`accumulateMetrics` call sites (main + `metricsEnd`-extended): confirm the single
  post-:1227 combination step produces correct `wake_count` in both, including a night where the
  extension fires (reuse `layPostWindowExitNight`'s shape).
- The `wake_count`-decrease case (unchanged from v3 §8/v2 finding).
- Same-second tie-break (§0.8): two transitions with identical `created_at`, differing `id` — confirm
  the walk's result is deterministic and matches the `id ASC` convention.
- Mutation-test the backward guard's window comparison and the must-be-quiet range's off-by-one boundary
  specifically — these are exactly the two places this plan itself just got wrong once.
- Standard adversarial review (Codex + a parallel subagent) before merge, same as every other PR here.

## 9. Open questions for this round

1. §2's backward guard (§0.3) reuses `bedOccupiedFrom` exactly as `settlingTail` does. Is there a
   sequence where the backward guard incorrectly rejects a genuine fresh departure — e.g., a real exit
   that happens to follow, more than `JITTER_REENTRY_MS` but still within the same broad settling
   period, a corroborated return from an *earlier*, unrelated settle? (The window is short — 60s — so
   this seems unlikely, but it wasn't checked against real multi-transition nights beyond the one named
   incident and the constructed counterexamples.)
2. §0.6 is a scoped-down claim plus a manual pre-ship check, not a code fix. Is that an acceptable
   resolution for this round, or does the goodnight-kiss overlap risk need an actual code-level guard
   before this ships (which would mean pulling in some form of item 3 after all, which v3 and v4 both
   deliberately avoided)?
3. Anything in §2's corrected pseudocode that still doesn't hold against the real code once traced
   line-by-line, the way both prior rounds found real problems in text that looked correct on a first
   read.
