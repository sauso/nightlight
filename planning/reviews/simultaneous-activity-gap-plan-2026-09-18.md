# Fixing ROADMAP §1.2 item 3's simultaneous-activity gap in `motionDetector.js`

**Status: two mechanism designs reviewed and REJECTED 2026-09-18. Diagnosis independently verified
against real prod + staging data the same day. Referenced from `planning/ROADMAP.md` §1.2 item 3.
Do not start a third mechanism design without reading this in full — both rejected designs' failure
modes are non-obvious and each took a full adversarial review round to surface.**

## Context

Three real incidents (Raffa 09-15, Raffa 09-16 — an identical recurrence, third night running — and
Renz 09-16's `wake_at` NULL) are attributed in `planning/ROADMAP.md` §1.2 item 3 to the same code-level
gap: the out-of-bed (OOB) candidate-open condition (`motionDetector.js:366`,
`outActive && !cribActive && cribLastActive > 0`) and its into-bed (IB) mirror (`:420`) both require the
*origin* channel to be inactive in the same frame the *destination* channel is active. When a real
climb-out isn't cleanly sequenced — both channels active in the same frame — no candidate opens, and
because the near-miss log line is nested inside the same `if`, nothing is logged either. A fourth
incident (Renz 09-17, a 3.5-hour onset miss) is attributed to the same root cause on the entry side.

The owner approved starting this work 2026-09-18. This plan went through two full rounds of adversarial
design review (Opus, standing in for Codex, which was rate-limited that day) before any code was
written, per this repo's standing rule for classifier changes. **Both rounds found the proposed
live-code mechanism unsafe**, for different, non-overlapping reasons each time.

## What two rounds of adversarial review found

**Round 1** (attacking the first design — relax both open conditions, add a per-side "tolerate overlap
then confirm" state): found the design was **actively harmful** on its own motivating incident. Both
OOB-open and IB-open become simultaneously satisfiable on a co-active frame (since `cribLastActive`/
`outLastActive` are both stamped `now` before either block runs), so a real exit could also fabricate a
spurious `into_bed` ~60s later — which trips `sleepAnalysis.js`'s existing `reversedBy` guard
(`:1074-1085`, no fallback) and **vetoes the real exit**, reproducing the exact `wake_at = null` symptom
the fix was meant to cure. Also found: the proposed abandon-timeout was a no-op (it reset every frame,
so it could never actually elapse); the tolerance window admitted exactly the 100-700ms jitter
population that ROADMAP §1.2 item 2's own Renz 2026-09-11 analysis says today's code correctly rejects;
and the proposed validation gate (the three existing diagnostics, `getImpossibleTransitions` /
`getQuickReversals` / `getLingeringBedMotion`) would have **improved** while the classifier got worse,
because the fabricated transition happens to remove an "impossible pair" and blind the lingering-motion
check — the gate was gameable by the exact defect it existed to catch.

**Round 2** (attacking a redesign that added belief-gated arbitration — only one side may open on a
co-active frame, chosen by `believedOccupied` — plus a re-arm latch on abandon): found the fabrication
still happens, one frame later and through a narrower door — the arbitrated side opens via the new
co-active path, then the *opposite* side's ordinary **clean** path (unaffected by arbitration, since
clean-path opening was never mutually exclusive by construction once the origin-channel exclusion was
touched) fires on literally the next 200ms frame if the destination channel happens to dip. Worse: the
arbitration signal (`believedOccupied`) is itself flipped by the fix's own confirms, so a confirmed exit
*arms* the opposite side's candidate a few minutes later — traced against the ROADMAP's own 09-16 data
(a "parent-check burst" 9 minutes after the exit) to reproduce the same wrong-wake outcome. The abandon
latch was shown to be dead on the exact negative case it exists to protect: the Renz 09-17 loud-routine
incident's own recorded symptom (three false `out_of_bed` events, each requiring 6+ continuous seconds
of bed-quiet to confirm under *today's* rules) proves that window already contains multiple genuine
quiet moments — so the latch clears immediately and repeatedly, and the unprotected clean path, not
anything this fix adds, is what's actually live in that window.

**Most importantly, round 2 found the root-cause diagnosis itself was unverified at the resolution that
matters** — settled the same day, see "Verification" below.

Also found, not yet resolved by any design: a `believedOccupied === null` state (real after any
mid-sleep restart) makes any belief-gated mechanism self-locking on exactly the incident class it's
meant to fix; the new candidate path inherits item 2's own documented, still-open "fast link has no
magnitude floor" gap, with a direct tension (adding the floor would reject the 09-15 incident itself,
since its outside peak of 0.035-0.069 is below the existing 0.05 slow-link floor); a plausible **new**
onset regression on the Renz 09-17 night via the early-put-down-anchor path was traced and has since
been confirmed live (see Verification); and a badly-drawn zone (the documented real case for Renz — a
zone that includes a moving curtain and cuts through the bed) turns co-active frames from the exception
into the norm, which neither design addresses.

## Verification (run 2026-09-18, against prod AND staging — independent detectors, same cameras)

**Q1 — does the diagnosis hold?** Round 2's central open question: does `motion_out_peak` stay active
when the bed goes quiet in the Raffa 09-15 incident? If so, today's existing clean path (`since ≈ 0` on
the fast link, no magnitude floor) should already have fired, and the theory is aimed at the wrong
cause. Checked directly against `activity_samples` on both environments: at 20:19 UTC (06:19 local, the
minute `motion_peak` drops to exactly 0), `motion_out_peak` ALSO drops to baseline (~0.0003-0.0009,
matching the pre-activity 20:14 baseline of ~0.0003-0.0005) — on both prod and staging. **Bed and
outside quiet together. The theory is not falsified by this check.**

Prod, camera `dce8157e-e80f-4eb1-919f-8aca00d10444`:
```
20:14  motion_peak=0.0133  motion_out_peak=0.00046   (baseline)
20:15  motion_peak=0.157   motion_out_peak=0.056      (both active)
20:16  motion_peak=0.155   motion_out_peak=0.044
20:17  motion_peak=0.157   motion_out_peak=0.043
20:18  motion_peak=0.169   motion_out_peak=0.056
20:19  motion_peak=0       motion_out_peak=0.00038   (both quiet)
20:20-20:27  motion_peak=0, motion_out_peak ~0.0003  (both stay quiet — real departure)
20:28  motion_peak=0.143   motion_out_peak=0.039      (both active again — a later check)
```
Staging, camera `96f35fdc-f12f-4a6b-9c82-887be7e95108`: same shape, slightly higher magnitudes
(0.16-0.20 bed, 0.03-0.07 outside during the co-active window, both to ~0.0003-0.0009 at 20:19).

**Q2 — what does the overnight transition record actually show for 09-16→17?** Both environments: the
last transition before the gap is the bedtime `into_bed` at 09:13:52 UTC (19:13:52 local) — then
**nothing recorded for ~7.5 hours** until `out_of_bed` at 20:43:11 UTC (06:43:11 local) and again at
20:46:24 UTC, both owner-verdicted `wrong` on staging. This matches the ROADMAP's "computed 06:46 (31
min late)" description exactly. **New finding**: on staging, the bedtime `into_bed` at 19:13:52 —
the transition that would anchor any belief-gated mechanism's occupancy prior heading into the 06:15
gap — is itself owner-verdicted `wrong`, along with four of the six bedtime-routine transitions before
it. Even "last recorded transition" as an occupancy signal would be anchored on a transition already
known to be false. A further, independent caution against belief-gated arbitration as a design
direction, beyond what round 2 already found.

**Q3 — is the Renz 09-17→18 onset-regression risk real?** Round 2 traced but could not verify (no DB
access) that a belief-gated design fabricating an early `into_bed` during the 18:58-19:23 loud routine
could pass `bedOccupiedAfter`'s guard (3 minutes of `motion_peak >= 0.0005` somewhere in the following
150 minutes) and move onset from the already-wrong 20:04 to an even-more-wrong ~19:23. Checked directly:
**26 minutes (prod) / 28 minutes (staging)** with `motion_peak >= 0.0005` in that window — far past the
3-minute bar. **Confirmed live, not just plausible.**

## What this means for scope

Two independent hard reviews finding two independently-broken mechanisms, on a diagnosis that itself
needed (and passed) independent verification, is itself informative: this is a harder problem than
"delete a boolean check." The repo's own established discipline for exactly this situation (ROADMAP
§1.2 items 1 and 2 both shipped log-only/record-only after their first "obvious" fix failed retrospective
validation) is the right template.

**Do not build the candidate-open mechanism without a fresh design round.** What's safe and useful
regardless of which mechanism eventually ships:

### 1. Extract `motionDetector.js`'s state machine into a testable module

`motionDetector.js`'s OOB/IB candidate state machine has **zero test coverage today** and no
dependency-injection seam (`spawn` imported directly, `handleFrame`/`launch` not exported) — confirmed
by both review rounds and by direct reading. No mechanism design, however careful, can be verified
without this. Extract into a new `backend/src/lib/bedTransitionTracker.js`, mirroring
`soundBaseline.js`'s `createSoundAnalyser` shape exactly (a stateful, closure-based, injectable-clock
factory — the established precedent in this repo for "logic that shipped inside an untestable detector
closure"), not `bedTransitionRules.js`'s shape (that file is deliberately pure/stateless).

- Move the **current, still-buggy** state machine verbatim first — zero behavior change. A regression
  fixture proves the bug survives extraction untouched (sustained co-activity still produces no
  candidate on either side).
- Verify behavior preservation by capturing the tuple stream the state machine actually consumes
  (`now`, `fraction`, `outFraction`, `threshold` — not raw frames, which would be ~1GB/hour and is the
  wrong capture boundary anyway) for a short real window, and replaying it through pre- and
  post-extraction code offline, diffing the emitted events.
- Add `bedTransitionTracker.js` to `backend/package.json`'s `test:core` include list once real tests
  exist against it, at the same 95/90/80 thresholds as `bedTransitionRules.js`/`bedTransitions.js`.

### 2. Live diagnostic logging, calibrated to the statistic that actually matters

Both rounds agreed a live instrument is needed since retrospective per-minute data can't resolve
frame-level questions, but round 2 corrected the statistic: log **time from a would-be co-active-open
to the first subsequent frame where the origin channel goes quiet** (not "episode duration," which
doesn't correspond to what any timeout in either rejected design actually needed to bound). One log
line per episode (start immediately, resolve with the duration once quiet is observed or a cap is hit),
rate-limited independently of the existing near-miss constants. Runs for several weeks before any
constant is chosen from it — same discipline as `OOB_SLOW_OUT_MIN`'s original calibration.

## Minimum needed before a third design attempt (from round 2, preserved verbatim as the starting point)

1. Fix the double-pending open: the clean paths must be suppressed while the opposite side holds a
   co-active candidate, or the co-active candidate must be dropped the instant the opposite side opens.
2. Break the belief→eligibility feedback loop: either exclude co-active-opened transitions from
   `reversedBy`/`settlingTail` corroboration entirely, or impose a refractory period longer than
   `MORNING_ABSENCE_MIN` after any confirm before the opposite side becomes eligible again.
3. Write synthetic tests (not replay — replay only proves preservation on the branches real data
   reaches) for: co-active open, the null-belief deadlock, latch set/clear, double-pending, and the
   pre-quiet tolerance boundary, before extending the extracted tracker with new logic.
4. Decide what `out_frames`/`peak` mean for a co-active-opened row before any such row is written — the
   accumulator currently mixes pre-quiet (both-channels-active) evidence with post-quiet evidence, which
   would silently contaminate item 2's still-in-flight duration-threshold dataset.
5. Do not use "last recorded transition" as an occupancy prior without accounting for the possibility
   that transition is itself already owner-verdicted `wrong` (new finding from this verification pass).

## What is explicitly NOT in scope here

- **The Renz 09-17 onset-miss (incident #4)** was already established, independent of any of the above,
  to need its own separate onset-side guard in `sleepAnalysis.js` (the real `into_bed` already exists in
  `bed_transitions` and is excluded only by `transitionOnset`'s 45-minute bound relative to an
  unwitnessed `algoOnset`) — this is unaffected by the candidate-open work either way and stays a
  separate, not-yet-started item.

### Critical files
- `backend/src/lib/motionDetector.js` — extraction source, `handleFrame` lines ~290-490
- `backend/src/lib/bedTransitionTracker.js` (new) — the extracted, testable tracker
- `backend/src/lib/bedTransitionRules.js` — pure functions the tracker imports, unchanged
- `backend/src/lib/soundBaseline.js` — the extraction shape precedent (`createSoundAnalyser`)
- `backend/src/lib/sleepAnalysis.js` — downstream consumer, unchanged; `reversedBy` (`:1074-1085`),
  `settlingTail` (`:1110-1139`), `transitionOnset` (`:840-848`), `bedOccupiedAfter` (`:814`) are all
  load-bearing for whichever mechanism is designed next
- `backend/test/bedTransitionTracker.test.js` (new)
- `backend/package.json` — `test:core` include list
- `planning/ROADMAP.md` §1.2 item 3
