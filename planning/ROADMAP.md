# Nightlight — Roadmap

The single list of **open** work. If something isn't here, it's either shipped (see `CHANGELOG.md`)
or a deliberate non-goal (§6).

**Ground rule:** this file tracks *intent*. `CHANGELOG.md` is the record of what actually shipped —
when the two disagree, the changelog is right. Update this file in the same commit that changes the
plan, and **delete an item from here the moment it ships** — cutting a release is the checkpoint where
that gets verified (see the `release` skill's roadmap gate). An item that turns out not to be worth
building goes to §4 *with the evidence*, so it doesn't get re-proposed later.

> **History note:** `planning/` previously held 12 per-feature scope docs, most describing work that had
> already shipped — several still headed "Not started" months after release, and one
> (`ux-refresh-v2-scope.md`) specifying a nav that was built and then abandoned. They were deleted in
> favour of this file (2026-08-24), and `on-demand-recording-scope.md` followed once that feature
> shipped in 0.25.0. The full text of each remains in git history if the design reasoning is ever needed.

**Status vocabulary:** `NEXT` (agreed, ready to start) · `SPECCED` (design settled, unbuilt) ·
`IDEA` (worth doing, not committed) · `HELD` (blocked or waiting on something).

---

## 1. Next up

> **✅ THE HOLDOUT IS CLOSED AND SCORED — 2026-09-09.** Ten nights per child, scored against the
> owner's recorded ground truth. This section is no longer gated.
>
> **The scorecard.** Wake: Renz median **1 min** (his is the best number in the system); Raffa median
> 12 min but **catastrophic on four of ten nights** — −121, −158, −102 and −30. Onset: Raffa is late on
> **all ten** nights (+3 to +27, median +13 — a systematic bias, so correctable); Renz has two
> catastrophic outliers (−387, −164) and is otherwise good.
>
> ★ **Raffa's early wakes are diagnosed AND FIXED — shipped in 0.30.1 (PR #327 + PR #342).** He stirs,
> it registers as an `out_of_bed`, he is back in bed 1–3 minutes later, and then sleeps so still the bed
> reads *empty* at `MOTION_ACTIVE` for hours. The `into_bed` that falsifies the gap was already in the
> table and nothing looked at it. Measured: those false gaps are 80–84% of minutes below 0.0005 and only
> 3–7% above 0.01, against 21–24% for Renz — **Raffa is the stiller sleeper, which is why it hits him
> and not Renz.**
>
> ⚠️ **#327 alone was not enough, and the residual was worse than it looked.** Its guard tests ONE
> transition, but the classifier emits `out → in → out` for a single climb-back-in, and the third marker
> then corroborates the very gap the return falsified. On 2026-09-09 that reported Raffa as up for the
> day at 8:44pm with 1h18m of sleep. #342 reads an `out_of_bed` within a minute of a corroborated return
> as the tail of that one movement; the night reads 9h51m. **Re-scored across 44 child-nights (all 22
> reviewed nights × prod AND staging): wake mean-abs error 16.3 → 11.4 min on staging and 17.1 → 11.6 on
> prod, with no new null wakes.** Cost, stated: one Renz night regresses +3 → +27, because the false
> tails (13/26/39 s) and one REAL exit (34 s) overlap and no window separates them.
>
> ⚠️ **The zone repaint FAILED its pre-registered criterion.** Impossible repeats went 52.7% → **58.6%**
> (Raffa) and 65.1% → **65.8%** (Renz) while transitions nearly doubled on a smaller window. Tighter
> zones see the child more and the linking rule did not keep up. **More zone work is low-yield; the
> classifier is the limiter.** Renz's "bed exactly 0" rate did improve, 6.5% → 4.8%.
>
> ⚠️⚠️ **Three integrity problems to fix before the next measurement run**, or it will be as
> compromised as this one: ground truth was captured on **staging** while **prod** was the thing under
> test (morning review only reaches production in this release); Renz's production zone **changed
> mid-holdout** with no audit trail, detectable only by diffing against staging; and 19 of 20
> ground-truth wakes were **picked from the detector's own transitions**, so they cannot reveal a wake
> that produced none.
>
> ⚠️ **0.30.0 changes the inputs.** It ships the sound dead-band fix, which changes `activity_samples`.
> **Record the deploy timestamp as a cutoff**, exactly as `2026-08-30 07:40:00 UTC` was for the zone
> repaint. Any before/after comparison spanning it is invalid.

### 1.1 Fix Raffa's bed-zone discrimination — `CLOSED` (shipped in 0.27.0; kept for the diagnosis)
**Closed 2026-08-29.** Four consecutive owner-confirmed mornings on the re-aimed camera: 05:09
(08-25), 05:53 (08-27), 05:54 (08-28) and 05:20 (08-29), every one exact. The framing question is
settled — re-aiming plus redrawing `detect_zone` fixed it. ⚠️ The false `into_bed` events this section
originally blamed on Raffa's framing later appeared on **Renz's** camera too, so that failure mode was
never per-camera; it is tracked in 1.2 and its own cause (a bed zone cutting through a sleeping child)
was fixed by enlarging the zone. **Kept rather than deleted because the diagnosis below is the worked
example of "moving a camera without redrawing the zone makes detection worse, not better".**

**It was a camera-framing problem, not a code problem.**

On the night of 2026-08-24→25 there was **no `out_of_bed` transition anywhere near Raffa's real 06:10
exit** (the last one was 01:22), and the detector then logged three *false* `into_bed` events after he
was already out (06:33, 06:43, 06:56). Bed-zone motion kept registering until 07:02 despite the bed
being empty from 06:10. Transition peaks are also much weaker than Renz's (0.013–0.037 vs up to 0.2).

The zone covers ~19.5% of the frame, much of it bare wall, and misses most of the bed — so "inside the
bed" and "outside the bed" aren't actually distinguishable for that camera.

**Work:** re-aim the camera so the bed fills more of the frame and the floor beside it is visible, then
**redraw `detect_zone`** — it is stored as normalised frame fractions, so *moving the camera without
redrawing points the zone at the wrong things and makes out-of-bed detection worse, not better*. The
grid picker (paint the cells covering the bed) can follow a diagonal bed that the old rectangles
couldn't. Then review a few mornings against ground truth.

**Update 2026-08-27.** Second clean night in a row: Raffa's wake came out at **05:53, owner-confirmed
exact**, and his put-down at 19:11 matched an observed 19:10. The re-aim worked. But the false
`into_bed` events this section blamed on Raffa's framing turned up on **Renz's** camera the same night
(four of them), so that failure mode is **not** a per-camera framing problem — see 1.2. Close 1.1 on
the framing question; the classifier is tracked separately.

### 1.2 Harden the bed-transition classifier — `NEXT`
**Most of this shipped in 0.27.0. What remains is items 1 and 3 below.** 0.26.0 stopped the timeline
*claiming* things this detector can't support (only the two adopted transitions are drawn, everything
else is "movement outside the bed"). That was a containment; 0.27.0 fixed several of the underlying
causes — the slow-link exit rule, the outside-channel threshold, the settling-episode marker, and the
empty-bed onset guard.

**Measured after 0.27.1, against owner ground truth (2026-08-28):** Renz exact on both onset (20:17)
and wake (05:29); Raffa's marker exact (in@19:51), wake exact (05:20), wake count exact (0), onset 18
minutes after his mother left the room. That is the best the classifier has ever measured — but it is
two children on one night, which is why this stays `NEXT` rather than closing.

⚠️⚠️ **0.27.0 shipped the empty-bed guard BROKEN and the numbers above were staging-only.** The guard
thresholded the *maximum* in-bed peak; prod's samples for the same empty room held one 0.0045 blip and
cleared it, so prod still reported that night as 16:56. Fixed in 0.27.1 by counting *minutes* of
movement rather than magnitude. **Two rules came out of it and both are now standing practice: an A/B
must run against BOTH databases, because prod and staging run independent detectors against the same
cameras and their `activity_samples` are different data; and "is anyone in this bed" is a question
about how OFTEN it moves, never how hard.**

⚠️ **The remaining failure mode is the one no amount of threshold work fixes:** the detector cannot
tell a parent's hands leaving the bed from a child climbing out, because motion in two zones is all it
has. That is item 3. A camera-vision approach to closing it from the occupancy side was tried and
abandoned (§4, "Bed occupancy via camera vision") — item 3's retrospective-rule work below is now the
only active path, with a physical occupancy sensor as a possible future independent source.

★ **Item 1 (no occupancy state) is still open, but the wake path no longer depends on it.** 0.30.1
(#327 + #342) defends against the `out → in → out` cluster *inside the morning-departure scan* rather
than in the classifier: a return cancels the exit before it, and an exit within a minute of a
corroborated return is read as the tail of that same movement. **That is a workaround, not the fix** —
the classifier still emits physically impossible sequences, and every other consumer of
`bed_transitions` still sees them. Item 1 closes when `motionDetector.js` carries the state.

**Two of the three causes below have since been addressed; item 2 has not.** The owner enlarged Renz's
bed zone on 2026-08-27 after spotting in the timelapse that he sleeps with his head outside it, and the
night of 2026-08-27 measured **zero** false `into_bed` events during sleep against four the night
before, with outside-only minutes going 0 → 8. A zone that cuts through the sleeping child was the
upstream cause of the false arrivals, not the classifier's thresholds. Separately the exit rule now has
a slow link window (see the entry under `[Unreleased]`), which fixes the missed unaided climb-out.
What remains is the occupancy state and telling a parent leaving from a child getting out.

⚠️⚠️ **EVERY FIGURE IN THIS SECTION IS PRE-REPAINT, AND IS THEREFORE HISTORICAL.** Both bed zones were
redrawn over real frames on 2026-08-30 (details at the end of the section), which changed the input to
every measurement below. The 62% impossible-pair rate, the 38.5% / 23.4% zone areas and the minute
counts all describe the **old** zones and must not be quoted as the current state. They are kept
because they are what motivated the work, and because they are the arithmetic the re-measurement will
repeat — not because they are still true. The holdout runs to ~2026-09-09; nothing here is re-measured
before then. (This warning used to sit *below* the numbers, which is not where a reader meets them.)

**What was wrong**, measured on 2026-08-26 against owner ground truth (nobody entered Renz's room all
night; Raffa put down 19:10, his mother out at 19:19):

- **No occupancy state.** `motionDetector.js` runs the out-of-bed and into-bed detectors as independent
  stateless twins, so nothing stops two arrivals in a row. Renz's night emitted **four consecutive
  `into_bed` with no `out_of_bed` between any of them** — physically impossible, and the cheapest
  possible check isn't there.
- **A child rolling over reads as an arrival.** The false events had bed peaks 0.020–0.042; Raffa's
  *genuine* put-down was 0.014. **Magnitude alone cannot separate them** — a naive floor would delete
  the true positives. What differs is the *outside* channel: a person entering produces a large,
  sustained out-of-zone signal, a stir produces essentially none. Today `into_bed` records only
  `ibPeakCrib` (the bed side), so the discriminating evidence is thrown away at the moment of capture.
- **A parent walking away is indistinguishable from a child climbing out.** Both are "bed moved, then
  outside moved, then bed went quiet". Renz's 18:50 `out_of_bed` was his father leaving the room, and it
  opened a child-out interval that ran until the first false arrival at 23:12.

★★ **MEASURED 2026-08-29, and item 1 now has a hard target.** Across the 238 transitions then stored
on prod **at that time**, **147 (62%) were the same type twice in a row** with nothing between — Raffa
Room 61 of 109 (56%), Renz Room 86 of 129 (67%). You cannot get into a bed you are already in, so at
least one of every pair is wrong. `getImpossibleTransitions()` in `lib/bedTransitions.js` returns them,
each naming the event it contradicts, per camera. **The durable thing here is the QUERY, not the 147:
it is re-runnable, and item 1 is scored against whatever it returns after the holdout.**

★★ **0.29.0 ships the missing evidence: a saved frame at every transition** (`bed_transitions.snapshot`
+ `transition-snapshots/`, 45-day retention in lockstep). Until now the detector recorded *when* it
thought the bed changed with no way to see what it was looking at when it decided. Combined with the
query above, the wrong events now collect themselves with a picture attached — which is both the way to
diagnose item 3 and, combined with owner verdicts, the ground truth a future occupancy sensor (§4) would
need to be scored against.

⚠️ These bad transitions do **not** currently corrupt reported sleep — the analysis uses episode grouping
and the occupancy guard rather than trusting raw event labels. They are why per-event markers still
cannot be drawn, which is exactly what "done when" below asks for.

★★★ **MEASURED 2026-08-30 — RENZ'S ZONE DOES NOT SIT ON HIS BED, AND NOTHING CHECKS THAT IT DOES.**
Drawn over a real transition snapshot, his painted `detect_zone` is a rough rectangle over the LEFT of
the room. It includes wall and **a curtain that moves**, and it stops at x=62% while the bed runs to
about x=80% — excluding the foot end past where the safety rail stops, which is the gap he climbs out
through. So his exits appear as motion *outside* the bed, the exit rule has no bed motion to link from,
and the curtain manufactures transitions that never happened.

| | body moving in the room (outside ≥ 0.05) | ...with the bed **exactly 0.0000** | linkable |
|---|---|---|---|
| Raffa | 308 min | **5 (2%)** | 97% |
| Renz | 636 min | **41 (6%)** | 77% |

2026-08-29: last bed motion 05:52, bed then **0.0000**, a plain body burst outside at 05:59 (0.070) —
seven minutes later, far outside even the slow window, so no candidate ever opened. Next recorded exit
**07:36** against an observed ~06:00.

⚠️⚠️ **His zone WAS 38.5% of frame — LARGER than Raffa's 23.4%. Every number said it was fine.** Area and
rect count prove nothing about whether a zone is in the right *place*. This was only visible by drawing
it over a frame, which the transition snapshots now make possible.

★★★ **UPDATE 2026-08-30 — step 0 below is DONE, and every measurement in this section above
is PRE-REPAINT.** Both zones were redrawn over real frames and mirrored prod → staging
(byte-identical: Raffa sha `22feeadf13ca7dc1`, Renz sha `cfa17b32a5368d7f`). Renz went 38.5% →
**22.57%** of frame, Raffa 23.4% → **13.02%**. A **10-day monitor phase runs to ~2026-09-09 as a
HOLDOUT** — those nights are deliberately not tuned on, and the tables above are re-measured at the
end with identical arithmetic. Until then treat the 62% / 38.5% / 23.4% figures and the minute
counts as **historical**, not as the current state.

**Two pieces of work, and the first is free:**
0. **Repaint the zone** to follow the mattress and exclude the curtain. No code. Do this first, then
   re-measure the table above before building anything — it may move most of the gap on its own.
1b. **Warn when a zone looks wrong.** Nothing today tells anyone their zone excludes the bed; it fails
   silently and looks like a detector problem. Candidates: flag a zone whose area overlaps little of
   where in-bed motion actually occurs, or simply show the zone over a recent frame in settings.
   ★ This is the generalisable half — every installation paints its own zone, and every one of them can
   be wrong in exactly this way.

**Work:**
1. Track believed occupancy; ignore an `into_bed` while already in bed and an `out_of_bed` while already
   out. (Alone this collapses the four arrivals to one.)
   ★ Target: whatever `getImpossibleTransitions()` returns when it is re-run after the holdout. It
   returned 147 pairs against the OLD zones — historical, see the warning at the top of this section.
   ★ This is *inferred* occupancy and needs no model — a camera-vision approach to the same fact was
   tried and abandoned (§4); a future physical occupancy sensor could supply it independently, but this
   item never depended on either.
   ✅ **LOG-ONLY IMPLEMENTATION SHIPPED 2026-09-12** — turned out NOT to be the "cheapest win" it
   looked like. A retrospective check against real owner-verdicted transitions (both environments)
   found that actually SUPPRESSING a same-direction repeat is unsafe on this classifier's current
   false-positive rate: a repeat only proves at least one of the pair is wrong, never which, and the
   naive rule always kept whichever confirmed FIRST. When a false transition slips through — the
   clear majority of `out_of_bed` events, per item 2's same-day peak/verdict measurement — it poisons
   belief and silently drops the REAL transition after it, until an opposite-direction event resets
   belief. Confirmed on Renz's actual 2026-09-11 night: a false 04:26 exit would have caused the real
   06:34 wake to be the one discarded. 22 owner-verdicted-CORRECT transitions across both environments
   would have been wrongly dropped. **So this ships log-only**: `believedOccupied` is tracked and a
   contradiction is logged, but every transition is still recorded exactly as before — zero data or
   detection-behavior change. See `bed-transition-classifier-flaws.md` for the full analysis.
   ⚠️ **STILL OPEN: an actual gate.** A "keep the last of a repeat, not the first" retrospective check
   fixed 19 of the 22 cases found above, but isn't a small tweak: the earlier transition is already a
   committed (sometimes human-labelled) row by the time the later one arrives, so this needs either a
   safe retroactive-invalidation rule (never touch a verdicted row) or a downstream preference at the
   analysis layer instead of a real-time gate. Revisit once item 2's evidence-based threshold reduces
   the false-transition rate — some of item 1's failure cases are literally false transitions item 2
   will eventually stop from being recorded at all, fixing the upstream cause instead of the symptom.
   ★ **Related finding, 2026-09-13: a missed ENTRY was completely silent, unlike a missed exit.** The
   OOB side has always logged a "near miss" when the bed goes active with no linkable outside burst
   (`OOB_NEARMISS_MS`); the IB side had no equivalent, so when a real bedtime fails to link, nothing
   says why. Real case: Renz's 2026-09-12 bedtime — staging recorded ZERO `into_bed` for the whole
   ~50-minute settling window (prod, an independent detector on the same camera, did eventually link
   one at 19:51, immediately followed 14s later by a low-evidence `out_of_bed` that likely erased it
   from the timeline anyway). **Fixed by adding the missing near-miss log**, mirroring exactly what the
   OOB side already checks (bed active, nothing linkable on the outside channel) — it does **not** cover
   every way an entry could go unrecorded: a placement where the bed and outside channels are active in
   the SAME frame (found in adversarial review, 2026-09-13) still opens no candidate and logs nothing,
   because neither this diagnostic nor the original candidate-open condition it mirrors handle
   simultaneous activity — a pre-existing gap in the candidate condition itself, not something this log
   line was ever positioned to catch. Left alone rather than expanding scope on a guess.
   ⚠️ Gated on `believedOccupied` (from item 1, above) rather than a time bound, AND on the bed having
   been quiet just before this frame (reusing `ACTIVE_GRACE_MS`, the same grace period the confirm logic
   already uses to decide a motion run hasn't ended) — **both conditions are needed, not just the
   first.** `believedOccupied` alone is not enough: it starts `null` after every restart and stays null
   until a transition confirms one way or the other, so on a restart that happens mid-sleep (real case:
   both containers restarted at 02:03 local on 2026-09-12) ordinary stirring by an already-sleeping,
   never-yet-confirmed child would otherwise re-log every `IB_NEARMISS_LOG_MS` for the rest of the
   night — caught in the same adversarial review, before it shipped. Requiring a fresh episode bounds
   this to "how often the child changes position", not a clock. Does not touch `IB_LINK_MS` or open the
   "slow window" question for entries — that stays deliberately unchanged pending real data on how often
   a genuine, quiet placement fails to link (which this new log line now makes measurable for the first
   time).
   ⚠️ **Separately measured 2026-09-13: an `into_bed` immediately followed (within 60s) by an
   `out_of_bed` on the same camera happens in ~8% of all recorded entries (86 of 1053 transitions,
   both cameras, ~3 weeks)** — and virtually none of these pairs have an owner verdict (1 of 86),
   because the morning review only surfaces events, it doesn't specifically ask about fast reversals.
   ★ **Owner's theory, unprompted, 2026-09-13**: "It seems to be when you go to kiss the child and
   leave the room it thinks they got out of bed" — leaning over the bed right after placing the child,
   then stepping back and leaving, is exactly the outside-then-quiet shape `out_of_bed` looks for, with
   no child movement involved. **This is item 3's exact gap** (telling a parent's motion from a
   child's), from the entry side rather than the exit side it was originally framed around.
   ✅ **CHECKED AGAINST DATA THE SAME DAY, two independent ways, both pointing the same direction:**
   - **Visual**: pulled the paired snapshots for a 9-case spread across both cameras and 3 weeks.
     Every case with anyone visible at all showed a parent in frame leaving via the door (4/9); the
     child was lying still in EVERY case, never once shown moving or sitting up. The exact pair this
     whole gap was diagnosed from (Renz, 2026-09-12 19:51:00→19:51:14) is the clearest example: the
     `into_bed` snapshot shows a parent leaning right over the bed; 14 seconds later the `out_of_bed`
     snapshot shows the same parent mid-stride, walking out the door, child undisturbed in bed.
   - **Independent, and scaling to the full 86**: the bed zone's own `motion_peak` in the hour AFTER
     the trailing `out_of_bed` (>`MOTION_ACTIVE`, sleepAnalysis.js's own calibrated per-minute test) —
     an empty bed should read close to silent, per the same assumption the empty-bed guard itself
     already relies on. **60% (52/86) kept showing 4+ active minutes of completely normal stirring**
     in that following hour — essentially impossible if the child had actually left. Only **9 of 86
     (all Raffa, none Renz) went fully silent for the whole hour** — the one signature actually
     consistent with a real departure.
   **Conclusion: most of these 86 are very likely a parent's presence being misread as a child's exit,
   not classifier noise with no physical cause and not a real child getting straight back up.**
   ✅ **Tooling shipped 2026-09-13**: `getQuickReversals()` in `bedTransitions.js`, mirroring
   `getImpossibleTransitions()`'s shape exactly (query-only, tested, same newest-first-across-cameras
   discipline). Query only — nothing acts on this yet; it needs owner-verdict ground truth on THIS
   specific pattern before anything downstream (surfacing in the morning review for labelling, or an
   analysis-layer discount on `wake_count`/`awake_minutes`) can safely be built, and there is almost
   none yet. This is what makes gathering that possible without guessing at a real-time gate.
   ✅ **DECIDED and SHIPPED 2026-09-13, option (a).** Owner chose to surface these for owner-verdict
   labelling rather than go straight to an analysis-layer discount on `wake_count` — same reasoning as
   items 1 and 2's own history: build the ground truth before building the rule. `NightReview.jsx` now
   shows a small, NOT-collapsed "Quick check-in?" prompt for any `into_bed`/`out_of_bed` pair the
   server flags via `quick_reversal_of` (deliberately separate from the full event list, which stays
   collapsed by default — the owner's own past words, "it's also flooded with in and out of bed", are
   exactly why relying on that list here would have buried the one question actually worth asking).
   Reuses the existing verdict mechanism unchanged (no new schema): "That was me" → `wrong`, "They got
   up" → `correct`, "Not sure" → `unclear`, stored on the `out_of_bed` row. Copy is deliberately
   neutral rather than suggesting "this was probably you" — leading the answer would poison the exact
   ground truth this exists to collect. Option (b) (the analysis-layer discount) is not built; revisit
   once verdicts actually accumulate on this pattern.
2. Record the outside channel's **peak and duration** alongside each transition — new columns on
   `bed_transitions` — and require substantial outside evidence for `into_bed`, symmetric for
   `out_of_bed`. — **RE-OPENED 2026-09-12, exit side only.** The earlier "lower priority, no longer
   urgent" call was right about `into_bed` and wrong to generalise to `out_of_bed` — nobody re-checked
   the exit side separately, and it is not fixed.
   ★★★ **Renz 2026-09-11: a confirmed `OUT OF BED` at 04:26 from a single frame of outside motion,
   owner-corrected same morning** (marked "wrong"; real wake 06:34, over 2h later). He had genuinely
   stirred and returned at 04:15–04:16 (both correct), then kept settling near the zone edge for ~10
   more minutes — ordinary jitter, logged as repeated candidates opening and cancelling within
   100–700ms. One of those bursts measured 5.7% outside motion, the bed then stayed quiet the
   required 6s, and the detector logged a real exit. Nothing contradicted it for 2h08m (true silence,
   verified in `activity_samples`), so the departure scan — correctly, by its own rules — trusted it.
   The real 06:34 wake measured ~20x the motion amplitude (peak 100%, outside 99%) of the false one.
   ⚠️ **Read from the code, not assumed: `OOB_SLOW_OUT_MIN` (5%) only gates the SLOW link (8–60s since
   last bed motion) — the FAST link (`OOB_LINK_MS`, ≤8s) that fired this exit has NO minimum
   outside-magnitude requirement at all**, only recency. For a marginal sleeper the fast path is the
   one actually exercised, and it currently has zero floor, not a low one.
   ⚠️ Neither item 1 nor item 3 would have caught this — checked against both before re-opening this
   one. Item 1 only suppresses a *repeated same-direction* transition; this was a single, correctly-
   ordered `into_bed` → `out_of_bed`, nothing repeats. Item 3's rule needs *continued in-bed
   micro-motion* after the exit to call it a parent; here the bed read genuinely, fully empty for
   2h08m — indistinguishable from a real departure by that rule. This gap is item 2's alone.
   ✅ **RECORDING half SHIPPED 2026-09-12** — `bed_transitions.out_peak`/`out_frames` now capture the
   outside channel's peak and duration on every future transition (both directions). Before writing
   any code, a peak-only floor was checked against 468 owner-reviewed verdicts already on staging:
   `out_of_bed` correct 1.3–16.4% vs wrong 1.2–31.1%, `into_bed` correct 1.4–17.5% vs wrong 1.2–33.4%
   — **peak alone does not separate them on either direction**, "wrong" has the higher ceiling on
   both, so no peak threshold would have helped. Recording is deliberately record-only, no gating:
   duration is the untested half and can't be evaluated until it has actually accumulated.
   ⚠️ **STILL OPEN: picking a duration threshold and gating confirmation on it.** Needs real
   `out_frames` data to accumulate across enough nights on both cameras, then the same
   two-populations-and-a-number-between-them argument as `OOB_SLOW_OUT_MIN`/`JITTER_REENTRY_MS`,
   scored on the 44-child-night set before shipping — Renz's wake is currently the best number in the
   system (median 1 min) and a naive fix risks regressing it. Do not close this item until that half
   ships too.
3. Separate "parent leaves" from "child exits". Retrospective is fine: the nightly job runs after the
   night, so an `out_of_bed` followed by continued in-bed micro-motion is a parent leaving. — **still
   open, and now the most valuable item.** Measured 2026-08-27: the real put-down at 19:14 was recorded
   as an `out_of_bed` (the parent's hands leaving the bed), so that night had no bedtime `into_bed` at
   all and the drawn marker was 40 minutes adrift. The reported bedtime survived it, but only because
   the sleep analysis no longer depends on the label being right.
   ★ **Gap B below shipped WITHOUT this** — the two were meant to be built together, but the mechanism
   that survived six review rounds only ever answers "was the bed empty during the gap", never "who
   caused the transitions". A quiet gap bracketed by two adult visits (a parent leaning in, leaving,
   returning, leaving again) still reads as a child's episode — named explicitly in Gap B's own known
   limits. This item is what would close that gap; it remains open and is now that mechanism's single
   biggest known blind spot, not merely an adjacent nice-to-have.
   ✅ **Tooling shipped 2026-09-14**: `getLingeringBedMotion()` in `bedTransitions.js` generalizes
   `getQuickReversals()`'s own second, data-driven check — the bed zone's own `motion_peak` showing
   4+ DISTINCT active minutes in the hour after a trailing `out_of_bed` — from quick-reversal pairs
   only to EVERY `out_of_bed` still within `activity_samples`' retention window, conditional on there
   being no `into_bed` recorded on the same camera before the qualifying minutes (an ordinary,
   already-corroborated return, exactly what `detectMidnightEpisodes` already treats as a real short
   awakening, is never flagged; same-direction repeats are reported once, not once per repeat).
   Requiring 4+ DISTINCT minutes (not 1, not 1 row) matters beyond matching the figure
   `planning/ROADMAP.md` itself reports: `activityTracker.js`'s minute flush is not phase-aligned to
   wall-clock minutes, so a single-minute threshold would flag an exit's OWN departure motion,
   mis-timed into the following bucket by flush lag, for roughly HALF of all exits — found reviewing
   this plan before it shipped, along with a second finding that `activity_samples` carries no
   uniqueness constraint on (camera_id, bucket_start), so counting ROWS instead of distinct minutes
   would have reopened the same hole via duplicate rows.
   ⚠️ **Generalizing the check MECHANICALLY is not the same claim as generalizing it
   STATISTICALLY** — the quick-reversal validation also leaned on an independent visual sample this
   broader population doesn't have, and its dominant case (a terminal/morning exit, with no `into_bed`
   until the next bedtime) is exactly where ordinary daytime room use could flag at a rate nobody had
   measured before shipping. **Measured against real staging data, 2026-09-14** (758 total
   `out_of_bed` transitions): **62 flagged, an 8.2% overall flag rate.** Against the 37 `out_of_bed`
   transitions the owner has verdicted `correct`, only **2 flagged — a 5.4% false-positive proxy**
   (small sample, 37 rows — a rough early signal, not a settled number). **Hour-of-day is
   reassuring**: 45% of all flags fall in the 18:00-19:59 local hour (evening bedtime routine) and
   another ~19% in 06:00-08:59 (morning wake) — the two sleep-transition-boundary windows this
   diagnostic actually targets — while 09:00-12:59 and 14:00 produced **zero** flags, so the
   ordinary-daytime-room-use flooding concern raised above did not materialize in this sample. A few
   flagged transitions already coincide with rows the owner independently marked `wrong` on
   2026-09-13. Query only, same posture as `getImpossibleTransitions` and `getQuickReversals`: nothing
   acts on this yet — no gating, no `wake_count` change, no UI. **Item 3 remains open**: this is Phase
   1 (surfacing the pattern, now measured on one house's two cameras); it still needs owner-verdict
   ground truth specifically on this broader population, and more nights of data, before any rule can
   be built on it, exactly as items 1-3's own history has required every time so far.
   **Phase 2 implemented 2026-09-14**: the morning review now surfaces "Still moving?" for
   lingering-motion exits, ahead of the collapsed event list, and records answers through the existing
   transition verdict. Quick check-in wins when both flags apply, so one event never gets two prompt
   cards. Queries cover this child's night plus one hour at both edges; a leading run that continues
   from before that fetch is suppressed because its true oldest anchor is unknown — found in adversarial
   plan review (Codex, gpt-6-astra): the naive bounded query could FABRICATE a flag the full-table rule
   never would (a same-direction run truncated at the fetch edge gets mis-anchored at its visible-but-
   not-true oldest member), not just miss one as first assumed. **Double-flag rate re-measured against
   real staging data at ship time, 2026-09-14** (773 total `out_of_bed` transitions): 97 quick-reversal
   flagged (12.6%), 63 lingering-motion flagged (8.2%), only **3 flagged by both** (4.8% of lingering
   flags) — consistent with the Phase 1 measurement a few hours earlier, confirming the overlap is real
   but small. ⚠️ **Known, accepted gap found in adversarial pre-merge review** (a Claude subagent,
   verified with a standalone reproduction): a run whose oldest and newest members straddle a review
   night's boundary by more than an hour can go unreported on BOTH adjacent nights — never a fabricated
   flag, only a real one the whole-table diagnostic would find but neither morning review shows. Not
   fixed this round; see the code comment in `sleepReviews.js` for why. This is still **Phase 2,
   ground-truth collection** — no gating attempted, no
   `wake_count`/`awake_minutes` or
   `detectMidnightEpisodes` change. Item 3 remains open pending real owner labels.
   ★★★ **A REAL, RECORDED INSTANCE OF THE SIMULTANEOUS-ACTIVITY GAP — 2026-09-16, Raffa, night_date
   `2026-09-15`, and a concrete regression-test candidate for whenever this item is next worked (owner:
   next week).** Owner-corrected `true_wake_at` = **06:15:00 local** (`sleep_reviews`, typed by hand —
   no transition to link to, `true_wake_transition_id IS NULL`). What the classifier actually recorded
   around it, **on two independent detectors** (prod camera `dce8157e…`, staging camera `96f35fdc…`,
   same child, same night): a confirmed `into_bed` at 06:10:02, then **nothing** until an `out_of_bed`
   at **07:11:09** — which the owner had already separately marked `verdict='wrong'` as a transition,
   independent of and before this being folded in here. Prod additionally shows the resulting impossible
   pair this gap produces: a stray `into_bed` at 06:44:10 with no `out_of_bed` before it, since believed
   occupancy never flipped.
   Raw `activity_samples` for the missed window (UTC `2026-09-15 20:15:00`–`20:18:00`, i.e. 06:15–06:18
   local): bed-zone `motion_peak` **0.157–0.203** for four straight minutes, simultaneously with
   outside-zone `motion_out_peak` **0.035–0.069** in the SAME minutes — then the bed reads exactly
   **0** from 06:19 through 06:27, the real departure's quiet signature. This is the exit-side mirror of
   the entry-side gap named above (2026-09-13 review): the candidate-open condition (`outActive &&
   !cribActive`, `motionDetector.js`) never fires when both channels are active in the same frame, so a
   climb-out that isn't cleanly sequenced — legs already over the rail while the torso is still moving in
   the bed zone — opens no candidate and logs nothing, not even a near-miss. **Test-case pointers for the
   fix**: child `c75ed329-de89-42ca-83aa-edaf692295b6` (Raffa), camera `96f35fdc-f12f-4a6b-9c82-
   887be7e95108` (staging) / `dce8157e-e80f-4eb1-919f-8aca00d10444` (prod), `night_date '2026-09-15'`,
   missed-exit window UTC `20:15:00`–`20:18:00`. Whatever fixes the simultaneous-activity gap should be
   checked against this exact incident before it's called done.
   ★★★ **2026-09-18 — owner reviewed two more nights (both kids) and it recurred a THIRD time, plus one
   genuinely new-shaped failure.** Cross-checked staging `sleep_reviews` (owner-entered true onset/wake)
   against `sleep_nights`/`bed_transitions`/`activity_samples` for night_date `2026-09-16` and
   `2026-09-17`, both children:
   - **Raffa 09-16→17: the identical 06:15 miss, third night running.** True wake 06:15, computed 06:46
     (31 min late). `activity_samples` is nearly a carbon copy of the 09-15 incident: bed-zone
     `motion_peak` 0.167–0.175 for four minutes (06:15–06:18) with `motion_out_peak` simultaneously at
     0.040–0.055 (same channel-linking gap), then a hard **0** from 06:19–06:27 (the real departure,
     unlinked), two more parent-check bursts with the same simultaneous signature (06:28, 06:41), and
     finally an unambiguous spike (`motion_peak`=1.0 at 06:43) that DOES trigger two `out_of_bed` events
     — both owner-marked `wrong`, since believed occupancy is thoroughly confused by then.
   - **Raffa 09-17→18: item 3's OTHER half — a correctly-caught wake, delayed by 73 minutes anyway.**
     True wake 06:04:07 matched an owner-`correct` transition exactly. But computed wake drifted to
     07:17 because a parent visited afterward (06:16 `into_bed`, 06:41 `out_of_bed`, 06:43 `into_bed` —
     mostly `wrong`) and the algorithm didn't declare "awake for good" until that noise stopped. Same
     root cause as the missed-exit half, just the delayed-settling symptom instead of the invisible one.
   - **Renz 09-16→17: `wake_at` NULL entirely** against a true wake of 07:10 — no transition anywhere
     near it, `wake_count=6`/`awake_minutes=83` from motion-based runs alone with nothing to anchor a
     final departure. Same family as the two above.
   - ★★★ **Renz 09-17→18: a 3.5-HOUR onset miss that does NOT match items 1/2/3 as currently written —
     a related but distinct symptom, worth its own line.** True onset 23:33:44 (owner-confirmed, matches
     a real `into_bed`); computed onset **20:04** — off by hours, not minutes. Traced in
     `activity_samples`: an active, loud bedtime routine 18:58–19:23 (`motion_peak`/`motion_out_peak`
     both hitting 0.3–1.0 together — lights on, parent in room) produced only three false `out_of_bed`
     events (all owner-marked `wrong`), because the SAME simultaneous-both-channel gap meant no
     `into_bed` could ever open during it. After 19:23 the room goes essentially silent for **four
     hours** — he was quiet but not yet actually in bed — until the real placement at 23:33. With no
     transition to anchor onset, the motion-only fallback grabbed the first sufficiently-long quiet run
     (20:04) and called it sleep onset, conflating **quiet** with **asleep** over an unusually long
     pre-bedtime wakeful stretch. Same upstream cause as item 3, but the failure shape — a multi-hour
     quiet-but-awake window read as onset — isn't described by items 1, 2, or 3's own wording; whoever
     fixes the simultaneous-activity gap should check whether closing it also closes this, or whether
     this needs its own onset-side guard (e.g. requiring SOME corroborating transition, even a rejected
     candidate's timestamp, before trusting a motion-only quiet run as onset on a night this late).
   **Test-case pointers for both new nights**: `night_date '2026-09-16'` and `'2026-09-17'`, same
   child/camera ids as the 09-15 entry above. Owner picking this up when their usage limit resets.
   ★★★ **2026-09-18 — two rounds of adversarial design review (Opus, standing in for a
   rate-limited Codex) both REJECTED a live-code fix before anything was built.** Full detail,
   including every verification query and its result, in
   `reviews/simultaneous-activity-gap-plan-2026-09-18.md`. Round 1 (relax both candidate-open conditions,
   tolerate-then-confirm): found the design **actively harmful** — a real exit could also fabricate
   a spurious `into_bed` minutes later, which trips the existing `reversedBy` guard
   (`sleepAnalysis.js:1074-1085`, no fallback) and vetoes the real exit, reproducing the exact
   `wake_at = null` symptom the fix was meant to cure; the proposed abandon-timeout was a no-op
   (reset every frame); the tolerance window admitted the exact 100-700ms jitter population item 2's
   Renz 2026-09-11 analysis says today's code correctly rejects; and the proposed validation gate
   (the three existing diagnostics) would have IMPROVED while the classifier got worse, since the
   fabricated transition happens to remove an "impossible pair" and blind the lingering-motion check.
   Round 2 (belief-gated arbitration — only one side may open on a co-active frame, chosen by
   `believedOccupied`, plus a re-arm latch): found the fabrication still happens, one frame later,
   through the OPPOSITE side's ordinary clean path (never made mutually exclusive with the new
   co-active path); found the arbitration signal is itself flipped by the fix's own confirms, so a
   confirmed exit *arms* the opposite side a few minutes later (traced against real 09-16 data — a
   parent-check burst 9 minutes after the exit — to reproduce the same wrong wake); and found the
   abandon latch is dead on the exact negative case (Renz 09-17) it exists to protect, since that
   window's own recorded symptom (three false `out_of_bed` events, each needing 6+ continuous seconds
   of bed-quiet under today's rules) proves it already contains multiple genuine quiet moments that
   clear the latch immediately.
   ★★★ **Verification queries run 2026-09-18, both prod AND staging (independent detectors,
   confirms this isn't one camera's artifact) — the diagnosis itself holds up.** Round 2's central
   open question was whether `motion_out_peak` stays active when the bed goes quiet in the 09-15
   incident (which would mean today's existing clean path should already have fired, and the whole
   theory is aimed at the wrong cause). Checked directly: at 20:19 UTC (06:19 local, when
   `motion_peak` drops to exactly 0), `motion_out_peak` ALSO drops to baseline (~0.0003-0.0009,
   identical to the pre-activity 20:14 baseline) on BOTH prod and staging — bed and outside quiet
   together, not outside-stays-active-while-bed-quiets. The theory is not falsified by this check.
   The Renz 09-17→18 onset-regression risk (a belief-gated design could fabricate an early
   `into_bed` during the 18:58-19:23 routine, which `bedOccupiedAfter`'s 3-minute/150-minute witness
   would then validate, moving onset from the already-wrong 20:04 to an even-more-wrong ~19:23) is
   CONFIRMED live, not just plausible: 26 (prod) / 28 (staging) minutes with `motion_peak >= 0.0005`
   in the 150-minute witness window — far past the 3-minute bar. New finding from this pass: on the
   09-16→17 night, the last transition recorded before the whole overnight gap (bedtime `into_bed`
   at 19:13:52 local) is on staging already owner-verdicted `wrong` — so even "last recorded
   transition" as an occupancy prior would anchor on a transition already known to be false, a
   further caution for any belief-gated design attempt.
   **Recommended next steps, in order**: (1) extract `motionDetector.js`'s OOB/IB state machine into
   a testable module (`bedTransitionTracker.js`, mirroring `soundBaseline.js`'s injectable-clock
   shape) — zero test coverage exists on this code today, and no mechanism design can be verified
   without it; (2) live diagnostic logging of time-from-co-active-open-to-first-quiet (not episode
   duration — round 2 corrected the statistic), to gather real calibration data before any constant
   is chosen; (3) only then attempt a third mechanism design, starting from round 2's fix list: break
   the double-pending-open hole, break the belief→eligibility feedback loop, and decide what
   `out_frames`/`peak` mean for a co-active-opened row before writing one. Neither rejected design's
   shape should be the starting point.
   ✅ **Recommended step (1) SHIPPED 2026-09-18** — `motionDetector.js`'s OOB/IB state machine extracted
   verbatim into `bedTransitionTracker.js` (mirroring `soundBaseline.js`'s injectable-clock shape),
   confirmed behavior-identical to the pre-extraction code via a 400k-synthetic-frame differential fuzz
   in adversarial review (zero divergence in logs, `recordBedTransition` calls, or `believedOccupied`).
   Now in `test:core` at 100% lines / 98.21% branches / 100% functions, with 30 tests — the first test
   coverage this state machine has ever had. First review pass found the test suite itself under-
   discriminated (47% mutation score, including a surviving `peak`/`outPeak` swap on the `into_bed`
   confirm payload — exactly the asymmetric-field corruption this file's own DB comment warns a refactor
   can introduce); fixed and reverified by hand-applying that exact mutant plus a `cribWasIdle`-guard
   deletion and confirming both now fail exactly one test each. **Recommended step (2) SHIPPED
   alongside it**: a rate-limited `[coactive]` diagnostic log line (see `planning/sleep-marker-review-
   runbook.md` §4), purely observational — logs time-to-first-quiet and which channel resolved first
   whenever both channels are active in the same frame, never touches `bed_transitions`. **Shipped to
   prod in 0.31.0 (2026-09-19)** — burn-in is still needed before its `CO_ACTIVE_LOG_COOLDOWN_MS`-censored
   duration data is enough to calibrate a real overlap-tolerance constant; nothing acts on the logged
   data yet. Step (3), a third mechanism design, remains not started — the whole point of steps (1)/(2)
   was to have real data before attempting it again.
4. **New: log-driven tuning is now possible.** The exit rule logs rejected links (`[oob] … link
   rejected`) with the actual gap and outside magnitude, so the real distribution can be read off a
   week of logs rather than guessed. Read it before moving `OOB_LINK_SLOW_MS` or `OOB_SLOW_OUT_MIN`.

**Tune it offline, don't guess.** `bed_transitions` retains 45 days and `activity_samples` 30, so there
is a real corpus already on staging. Add the evidence columns first, then let a week accumulate before
choosing thresholds — the same discipline that produced `EMPTY_BED_MAX_PEAK` and
`MAX_POST_EXIT_ACTIVE_MIN`.

**Done when** a night's per-event markers are trustworthy enough to draw again, i.e. no impossible
sequences across a week and the put-down/departure pair still matches ground truth.

### 1.3 Sound is not a per-room signal — `IDEA`
Fallout from the same night. A bedroom mic hears the whole house: 16 of the 19 sound-active minutes
that were holding Renz's onset an hour late were simultaneously loud in his brother's room, while his
own bed never moved. 0.26.0 handles this for **onset** only (a sound-only minute counts as awake only
once a put-down proves the child is in the bed, and only if that room also moved nearby).

**Partly closed — SHIPPED in 0.27.0.** The first *half hour* after onset now uses the same witness rule,
because
fixing bedtime moved the problem rather than removing it: the noise that had been delaying onset
reappeared immediately as the first wake-up. Across all stored nights that removed exactly three
counted wakes, every one of them 15–22 minutes after onset, and one of them owner-confirmed false
(2026-08-26 Renz, asleep and motionless, nobody in the room).

What is still open is the **rest of the night** — deliberately left alone, because mid-night the house
is quiet and a cry with no movement is exactly the wake-up a parent wants counted. Worth measuring
before touching: across all nights on record, how many counted wakes are sound-only *and* simultaneous
with noise in the sibling's room? If that number is large, the wake rule needs the same treatment. If
it's small, leave it alone. **Measure first.**

---

### 1.4 The ambient sound baseline — freeze `SHIPPED`, statistic mismatch `NEXT`

★★★ **VERIFIED 2026-08-31 in production logs, not inferred.** One camera’s ambient baseline sat at
exactly `-63.5 dB` for **1891 consecutive log lines — 7.9 unbroken hours** — while the room ran
8–12 dB above it. The working camera in the same house shows a dispersed cluster of baseline values
(an EMA hunting a floor); the stuck one shows an isolated spike with no adjacent values at all.

**The mechanism.** `soundDetector.js` takes exactly one of three paths per reading, keyed on `over`
(trailing-average loudness minus baseline), where `margin = marginDb(sound_sensitivity)`:

| `over` | what happens to the baseline |
|---|---|
| `< margin/2` | the EMA tracks the room |
| `[margin/2, margin)` | **nothing at all** |
| `>= margin`, held 45 s | absorbed into the baseline |

The middle band is an **absorbing state**: the only thing that lowers `over` is the baseline rising,
and the baseline only rises in the other two branches. The guard is also one-sided — a room *below*
the baseline always pulls it down — so the floor ratchets toward the quiet level and cannot climb
back. `loudSince` resets on any dip under `margin`, so a source hovering around the margin never
completes the 45 s clock. It is a **step response**: a slow ramp is absorbed fine, an instant step is
not — and a white-noise machine switched on at bedtime against a daytime baseline re-arms it nightly.

⚠⚠ **This is not one house.** The trap band sits *below* the alert margin and *above* sleep’s
`SOUND_ACTIVE`, so it produces no alert, no log line and no error while marking every minute active.
The shipped default `sound_sensitivity = 50` puts the band at 5.5–11.1 dB — squarely where a nursery
white-noise machine or fan lands. Turning sensitivity *down* to reduce alerts moves the band *up*.

★★★ **THE ROOT CAUSE IS DEEPER THAN THE FREEZE, and it decides the fix.** `sound_peak` is the
per-minute **MAXIMUM** of ~300 windows (`activityTracker.js`) measured against a floor that tracks a
**central tendency**, so `max - mean ≈ 2.9σ`: sleep’s 6 dB threshold is really a statement about the
room’s **variance**, not its loudness. Simulated on a stationary, silent room, share of minutes
reading “active”: at σ = 2.0, **36%** with a correctly-tracking EMA and **100%** with a p10 floor.
❌ **Do not just swap the floor** — a low-percentile floor under a MAX recorder is *worse*, and it
reproduces the corruption it was meant to remove. ✅ **Match the statistics**: record a percentile or
mean of the minute’s excursion rather than its max, or define the floor at whatever statistic the
recorder uses. That fixes the freeze and the variance problem together.

**Measured on the affected room**: even with a perfectly healthy baseline it would still read ~41% of
minutes active (against 19% for the other room), so fixing only the freeze is a partial fix.

**Prerequisite work.** `soundDetector.js` has **no tests** and is not in the `test:core` include
list; `handleReading` is a closure inside `launch()` inside `startSoundDetector`, so nothing is
reachable from a test. Extract the reading pipeline behind an injectable clock first.
⚠️ **Tests must discriminate, not merely pass.** “Step the level, assert it decays” is passed by a
2-minute window, by a median floor and by a p90 floor alike. The test that kills all three is
**“a 6-minute continuous cry must stay above `SOUND_ACTIVE`”**, plus asserting the floor’s exact
value at a known time after a known step (which is what pins the window length).

---

**✅ THE FREEZE IS FIXED — on `dev`, not yet in production.** A steady level sitting in the trap band
is now absorbed into the baseline after five minutes, so the absorbing state described above no longer
exists. The old workaround (raising that camera's `sound_sensitivity` to 90+) is no longer needed.

⚠️ **The fix itself shipped a regression that its first version did not catch**, and it is worth
keeping here because it is the shape to watch for: the new state was hoisted to module scope, so it
spanned an FFmpeg outage — the reader restarts a few seconds after any stream hiccup, and the level
learned before the outage was carried across it as though the room had been making the same noise
throughout. Fixed in the same PR; the second half of it (a first reading taken from five seconds of
audio rather than 0.2, and time off-stream not counting as time listening) is in the same changelog
entry. ★ **A grid-aligned fixture hid it**: every synthetic minute landed on a boundary, so the gap
the bug needed never occurred in the tests.

**⏳ STILL OPEN — and it is the bigger half: the statistic mismatch.** Everything above under "THE ROOT
CAUSE IS DEEPER THAN THE FREEZE" is untouched. `sound_peak` is still the per-minute **maximum** of ~300
windows measured against a floor that tracks a **central tendency**, so the 6 dB `SOUND_ACTIVE`
threshold is still really a statement about the room's variance. The measurement that sizes the work
stands: the affected room would still read ~41% of minutes active against 19% for the other, even with
a perfectly healthy baseline.

**Phase 1 instrumentation shipped:** `activityTracker.js:109` records `sound_p75`, `sound_p90` and
`sound_sd` from each minute's actual accepted, zero-clamped sound excursions, alongside the existing
mean and max. Nearest-rank p75 needs 76 elevated readings out of 300 (~15.2s); p90 needs 31 (~6.2s),
so p75 is more robust and p90 more sensitive to shorter bursts. Population sd records the spread for
checking the variance premise against real rooms; the zero-clamped stream is not a raw Gaussian.
The nullable migration is inside the schema transaction (`db.js:732`); historical rows stay NULL.
The monitor holdout closed 2026-09-09. This is instrumentation only: baseline tracking, motion,
`onMinuteFlushed`'s payload, all three `SOUND_ACTIVE` comparisons and reported sleep numbers are unchanged.

**Phase 2 remains open, gated on real accumulated data:** choose the statistic and threshold, then
cut over `SOUND_ACTIVE` in a separate change. Analysis will query SQLite directly against a DB snapshot;
the fixed `/activity-history` SELECT does not expose these diagnostics. Only the existing mean and
the recorded p75/p90/sd will be available for that comparison. A different, unrecorded percentile cannot
be recovered from these summaries and would require a fresh collection window.

**Prerequisite, and it is now DONE**: `soundDetector.js` was untestable (`handleReading` was a closure
inside `launch()` inside `startSoundDetector`). The reading pipeline was extracted behind an injectable
clock as `lib/soundBaseline.js`, which is in the `test:core` include list at 100% lines. The
discriminating test named above — *"a 6-minute continuous cry must stay above `SOUND_ACTIVE`"* — is in
`soundBaseline.test.js`.

### 1.5 A wake-up the parent can actually see — `NEXT`

Raised by the owner 2026-09-10: *"Renz's alerts appear in the wake-ups section but they don't for
Raffa"*, and separately *"he got up at 20:41 and was put back at 20:43 — why no wake-up and no alert?"*
Both reproduce on prod **and** staging. Neither is a detection failure: **the alerts fired, the
transitions were recorded, and the display has nowhere to put either.** Two independent gaps.

⚠️ **First, what is NOT wrong, so it does not get re-investigated.** `alertsInRange` (`SleepDetail.jsx`)
is camera-agnostic and symmetric — there is no per-child logic anywhere in the path. The alerts are
plainly visible on the child page because **"Recent alerts" is a flat `/cameras/alerts` feed with no
sleep logic in it at all**. The gap is only between the alert feed and the *Wake-ups* list.

#### Gap A — the morning wake is not a row, so an alert at the moment of waking cannot render — `SHIPPED` (PR #420, `bfa1b92`, 2026-09-12)

`sleepAnalysis.js` built the list as `for (let i = onset; i < sleepEnd; )`. **`sleepEnd` is the start
of the final wake**, so `wakes[]` held *only mid-night awakenings*; the morning wake was reported as
`wake_at` in the summary line instead. Alerts render only inside a wake row (`WakeItem`), so **an alert
at the exact minute the child woke had nothing to attach to.**

Measured over the last 14 nights on prod, using the UI's own ±3 min `ALERT_MARGIN_MS`:

| | renders (inside a mid-night wake) | at the morning wake, **cannot** render |
|---|---|---|
| Raffa | 12 | **9, on 7 of 14 nights** |
| Renz | 286 | 19, on 8 of 14 nights |

★ **One omission, wildly different cost per child**: the missing row was worth **+75%** on top of
everything Raffa displayed and **+6.6%** for Renz — not because the code treats them differently, but
because **Raffa's waking IS a morning event while Renz's is spread through the night.**
★ Display-only, as planned — it could not and did not move any number the holdout scores against.
Additive to the response shape (a running SPA is a client that cannot be updated).

**What shipped**: one more row, `[sleepEnd, morningEnd)` where `morningEnd = Math.max(totalMin,
sleepEnd)`, appended to `wakes[]` whenever `wake_at` is non-null — merged into the last mid-night run
when it leads straight into the departure (no gap), otherwise a standalone row. The alerts and wake-
clips queries were widened to the same bound, or a post-window alert was excluded from the response
before any row could claim it. Adversarial review (Codex + a parallel Claude subagent) caught two real
defects in the first version before merge: a departure confirmed after a real quiet gap got no row at
all, and two rows sharing an exact boundary instant could double-render one alert — both fixed and
mutation-tested. `wakes.length` (the detail page's live count) can now exceed the stored `wake_count`
by one on any night with a real wake_at — deliberate, they answer different questions; see the code
comment in `sleepAnalysis.js` if this needs revisiting.

#### Gap B — ✅ SHIPPED (code); production replay + verdict audit still pending before this closes

Raffa 2026-09-09: `846 20:41:30 out · 847 20:43:57 in · 848 20:44:36 out` — an unambiguous out/in pair.
Fresh compute on 0.30.1 reported `wake_count 0, awake_minutes 0`. Why: the only active minutes were
20:41, 20:44 and 20:45 (20:42–43 dead); the run walk bridged the 2-minute gap (`WAKE_GAP_MIN` 3) into
**one run of 3 active minutes**, against **`WAKE_ACTIVE_MIN = 5`**. Three is not five, so it was
classified a brief stir — despite real motion+sound alerts firing on both flanks.

★★★ **The wake-COUNT path read only per-minute activity and ignored `bed_transitions` entirely**, while
the wake-TIME path (`USE_TRANSITION_TIMES`) already treated them as authoritative. A child who climbs
out, is put back, and lies still was *structurally* incapable of reaching five active minutes.

**Fixed, not by lowering `WAKE_ACTIVE_MIN`** (it stops brief stirs counting, and 5→3 would have changed
every night in the corpus) — `detectMidnightEpisodes` in `sleepAnalysis.js` adds a standalone,
adversarially-reviewed pass: a corroborated `out_of_bed`→`into_bed` pair, 1–20 minutes apart, with the
bed confirmed quiet in every whole minute strictly between the two transitions, counts as an awakening
independent of the activity threshold. Marks both endpoint minutes plus everything between; unions with
the existing activity-based wake runs (can extend one, or merge two into one — `wake_count` can
therefore *decrease* even as `awake_minutes` increases). Runs once, after the departure scan, the
`empty`-night decision, and the post-window metrics extension have all already settled — an episode can
never move onset, the final wake time, or a night's `status`. `USE_TRANSITION_WAKE_EPISODES` reverts it
independently of `USE_TRANSITION_TIMES`.

Six rounds of adversarial review (Codex + an independent subagent each round — see
[the plan](reviews/midnight-wake-plan-2026-09-13-v6.md)) found real, code-verified defects in every
round through v4, including two that would have shipped the mechanism producing **zero** episodes for
its own motivating incident. **Named, accepted limits, not fixed this round:**
- Cannot tell an adult's bed visit from the child's own trip — a quiet gap bracketed by two adult
  transitions still counts (§1.2 item 3's job, still open, now the mechanism's single biggest blind
  spot — see item 3 above).
- The occupancy corroboration's 150-minute window can borrow unrelated later motion, inventing an
  episode or truncating a real one at a spurious earlier return.
- A spurious `into_bed` within 60 seconds before a real departure can suppress that episode outright
  (a false negative, the safe direction); a false settling tail past 60 seconds can still manufacture
  one — the same already-measured, admittedly-unseparable overlap `JITTER_REENTRY_MS` documents.
- A noisy intervening transition can shorten or entirely drop a real episode (positional pairing never
  retries a failed candidate).
- Excursions over 20 minutes and `in_progress` (live, tonight-so-far) nights are out of scope.

**✅ SHIPPED, dev `6be7c97` (PR #429) 2026-09-13, staging-verified — reached prod in 0.31.0
(2026-09-19).** Deployed to staging and replayed
against all 56 nights currently stored there (both children) — same code, `USE_TRANSITION_WAKE_EPISODES`
on vs off, isolating this change from every other sleep-analysis fix shipped since those nights were
last stored (comparing against the *stale stored rows* directly, without that isolation, produced 15
spurious "hard gate" failures — all accounted for by unrelated changes shipped in the intervening
weeks, none by this one). Isolated result: **onset/final-wake byte-identical on all 56 — zero hard-gate
failures.** Exactly 2 nights changed: Raffa 2026-09-09 (`wake_count 0→1`, `awake_minutes 0→3`) — **the
named motivating incident itself**, confirmed fixed on real data — and Renz 2026-09-09 (`wake_count
9→10`, `awake_minutes 146→151`, episode at 14:35-14:40 UTC). **Zero `wake_count` decreases.** Both
changed nights' evidence transitions (Raffa #846/#847/#848; Renz #891/#892/#893) are unverdicted
(`verdict IS NULL`) — no already-known-wrong transition was used as evidence for either.

Real prod `motion_peak` for camera `dce8157e`, local 2026-09-09 20:41: **0.0563** — confirmed active
(`> MOTION_ACTIVE`), settling the plan's flagged-unverified claim; both gap minutes (20:42, 20:43) read
`motion_peak = 0`, confirmed quiet, matching the shipped code's exact expectation.

#### Why the two children differ at all — measured, so it is not re-litigated

Classifying every in-window alert by the timeline segment it lands in, last 14 nights:

| segment | Raffa | Renz |
|---|---|---|
| settling (pre-onset) | 29.2% | 5.3% |
| asleep | 1.3% | 11.2% |
| stir (<5 active min) | 5.2% | 19.9% |
| **wake (the only one that renders)** | **6.5%** | **56.6%** |
| awake (after the final wake) | 57.8% | 7.0% |

Raffa: 18 wakes over 14 nights, **6 nights with an entirely empty Wake-ups section**; Renz: 94 wakes,
**0** empty nights. Underneath it he is simply the stiller sleeper (3–7% active minutes vs 21–24%,
corroborated independently by the zone baseline 15.6% vs 25.2%).

⚠️ The two cameras are also **configured differently, all four in the direction of Renz alerting more**:
`sound_sensitivity` 49 vs 70 (**+11.2 dB vs +8.2 dB** via `marginDb()` = `4 + 14*((100-s)/99)`;
~3 dB is a doubling of sound power), `detect_confirm_s` 3 s vs 2 s, `detect_start` 19:00 vs 19:30,
`detect_zone` 13.0% vs 22.7% of frame. **Raising Raffa's sensitivity to match is the wrong fix** —
Renz is at ~34 alerts/night, which is the alert-fatigue tradeoff, on a baby monitor, at 3 am.

#### What this assumes about someone else's house

Nothing child-specific: both gaps are about **where a child's waking falls in the night**, and a child
who sleeps through and wakes in the morning is the *common* case, not this house's. Gap A helps every
such install and costs nothing where it doesn't apply. ⚠️ The per-camera settings above are this
installation's, quoted only to explain the observed rates — **no threshold in either gap's fix may be
derived from them.**

### 1.6 Sleep report notification is a fixed-clock snapshot, not evidence-based — option 1 `SHIPPED` (0.31.0), narrowed scope

Raised by the owner 2026-09-18, prompted by Renz's night of 2026-09-16→17 (§1.2 item 3's evidence
above): "he slept until 7:10 yesterday which was unusual" — and the report/notification mechanism has no
way to represent that, structurally, not as a bug in the wake-time computation itself.

**How it actually works today** (`lib/sleepAnalysis.js`): `startSleepJob()` (`:1888-1893`) runs
`runNightlySleepJob()` immediately at boot and every 30 minutes after, phase-aligned to container start
time, not wall-clock. Each tick, per child, `lastCompletedNightDate()` (`:369-379`) checks only whether
that child's `sleep_window_end` (07:00 for both kids) has passed `now` — nothing about whether the child
has actually woken checks in at all. **The notification fires exactly once: on whichever tick first
creates that night's `sleep_nights` row** (`:1847-1851`, gated by `REPORT_FRESH_MS` = 2h, `:9`, only to
stop a restart re-notifying about an old night). The job keeps *recomputing* an existing row every 30
min until `isEvidenceFinal()` (`:328-330`, `window_end + WAKE_LOOKAHEAD_MS` = 3h, so ~10:00 for a 07:00
window) — but that later refinement **never re-notifies**. The notification is locked to the first,
often-provisional pass.

★★★ **Exactly this happened on Renz's 09-16→17 night, already on record in §1.2 item 3 above.** Window
closes 07:00; true wake was 07:10 — ten minutes past close, and the confirming quiet run
(`MORNING_ABSENCE_MIN` = 20 min) couldn't even complete until ~07:30 at the earliest. The
notification-eligible first pass ran within 30 minutes of 07:00, before any of that was observable. Worse:
because the underlying departure was never linked at all (the simultaneous-activity gap), `wake_at`
stayed **NULL even after three more hours of retrying** — so whatever report went out was not just early,
it was permanently wrong for that night, with no mechanism to ever say otherwise.

**Three options discussed, not yet built, roughly cheapest-to-biggest:**
1. **Re-notify (or send a follow-up) when a later recompute meaningfully changes the picture** — e.g.
   `wake_at` flips from null to a real time, or moves by more than a few minutes from what was already
   reported. Doesn't require predicting anything; directly fixes "a report can lock in a wrong answer
   forever," which is the sharper problem here than mere lateness.
2. **Delay the first notification** until either a confirmed final wake exists or a capped fallback delay
   passes (e.g. 60-90 min past window_end) — trades promptness for accuracy, and still doesn't help the
   case where evidence never resolves (option 1 is still needed for that).
3. **Derive a rolling expected-wake-time per child from history** (`sleep_nights` already has weeks of
   it) and hold the report until around that time rather than a fixed `window_end` — the most genuinely
   "dynamic" option, but real design work: what counts as enough history, how it handles an already-
   unusual night (the exact case that motivated this), and how it degrades for a new install with no
   history yet.

**Owner's call, 2026-09-18: start with option 1.** It's the cheapest, it's correct regardless of which
of the other two (if any) get built later, and it's the one that would have actually helped on the
09-16 night — a corrected/follow-up notification once evidence resolved, instead of silence.

⚠️ **Related to, but independently workable from, §1.2 item 3.** The Renz incident's ROOT cause (why
`wake_at` never resolved) is item 3's simultaneous-activity gap; THIS item is about what the app tells a
parent while that's true (or unresolved), which is a real gap even on a night the classifier gets right
but merely finishes late. Fixing item 3 would reduce how often option 1 has anything to report, not
replace the need for it.

✅ **SHIPPED to prod in 0.31.0 (2026-09-19), NARROWED from the owner's original wording.** Two rounds of adversarial
design review (Opus, standing in for a rate-limited Codex) found the literal "wake_at changes
meaningfully" trigger unsafe: a *measured* real incident (`morning-wake-parent-handles-bed.md`, Renz
2026-08-29, `05:51`→`08:31` between two recomputes of the SAME night) proves a later recompute is not
always more accurate, so a bidirectional trigger could send a wrong correction and burn the one-shot
follow-up budget doing it. **Shipped scope: notify a follow-up ONLY on null→real** (a wake time that was
unknown becomes known) — never on real→real drift in either direction. This still directly fixes "a
report can lock in a wrong answer forever" for the common shape (the Raffa-09-16-style night, where
`wake_at` eventually resolves) but, stated plainly, **does NOT correct the exact Renz 09-16 incident that
prompted this ticket** — its `wake_at` stayed null the whole 3-hour window, so there was never a
null→real transition to notify on. Closing that needs §1.2 item 3 (so a departure links more often) or a
distinct "still unclear" notification (closer to option 2/3's spirit) — not built here.

Also shipped: a notification tag (`android.notification.tag` + `apns-collapse-id`) so the follow-up
**replaces** the original in the tray rather than arriving as a second, contradictory message — except
when two tracked children's windows close in the same ~30-minute tick, in which case the original is one
combined, untagged message and the tag has nothing to collapse onto (named limit, stated in
`docs/notifications.md`, not silently accepted). A pre-existing bug found along the way: the admin
"Recompute this night" control could report success while saving nothing when the new guard refused a
write — fixed with a proper 409, same pattern as the existing "data aged out" refusal.

Full design-review history (why the literal wording was rejected, both rounds' findings) was not saved
as a separate durable doc this time — the plan file itself (now implemented) covered it; see the git
history on `backend/src/lib/sleepAnalysis.js`'s `runNightlySleepJob`/`computeAndStoreNight` and
`backend/src/lib/sleepReportAlert.js` for the shipped shape. **Options 2 and 3 remain not built.**

## 2. Specced, not built

### 2.1 Sub-stream sanity check — warn when "Low" isn't actually low — `SPECCED`
Nothing verifies that a configured `sub_rtsp_url` is actually *smaller* than the main stream. Found on
prod 2026-08-25: one camera's `/ch1` was serving **1920×1080 @ 15fps — identical to its main stream**.
Cause: **the camera's second encoder was disabled, and the firmware answered `/ch1` with the main
stream instead of refusing it.** Nothing anywhere reported a problem. Two silent consequences, neither
of which surfaced in the UI:

- The **Low** quality option delivers the same bitrate as High, so the feature does nothing for that
  camera while looking like it works.
- The motion detector prefers the sub path precisely because it's cheap to decode. Decoding 1080p
  instead of 360p cost **5.9% of a core vs 1.2%** — the single largest FFmpeg line in the container,
  ~5× what it should be.

**The check has to measure the actual stream, not read configuration back.** ONVIF reported
`Profile_1` = 640×360 mapped to `/ch1`, and the camera's own settings page agreed — both described a
substream that wasn't being produced. Only probing the RTSP endpoint revealed it. (This firmware also
reports an identical canned `fps=30, bitrate=5000` for every profile, matching no actual stream, so its
encoder figures can't be trusted as a live read either.)

**Proposal:** probe the sub's resolution when a camera is saved (ffprobe already runs there via
`validateRtspStream`) and store it alongside the main's. If the sub isn't meaningfully smaller, say so
on the camera's detail/diagnostics screen — "this sub-stream is delivering the same resolution as the
main stream; Low won't save bandwidth". A warning, not a block: the fix is on the camera, and refusing
to save would be unhelpful. Worth re-checking periodically rather than only at save time, since someone
can disable the camera's second encoder long after Nightlight was configured — which is exactly what
happened here.

### 2.2 Cry classification — `SPECCED`
Sound detection today alerts on **loudness** (FFmpeg `silencedetect`), not on what the noise *is*. The
agreed staging was always: prove motion+push → add sound presence → tune against real usage → *only
then* evaluate cry-specific classification, informed by how well plain sound detection performs.
Sound detection has been live since 0.12.0, so this is now genuinely evaluable.

Distinguishing a baby crying from a dog barking, a TV or a door slam is a real audio-classification
problem. A spare **USB Coral** may accelerate it, but it must stay **optional and runtime-detected**
with a CPU fallback — the app has to run fully without one, and everything shipped so far is
deliberately Node + FFmpeg only (no Python in the runtime image).

### 2.3 Testing — `IN PROGRESS`

**Target (owner, 2026-08-26): core logic at >= 95% line coverage, checked before promoting to
production. A TARGET, not a hard blocker** — breadth is still being built out, so an uncovered module
does not stop a release. What is enforced is a **ratchet**: `backend/package.json`'s `test:core` script
pins thresholds over an explicit include list, CI runs it on every push and PR
(`.github/workflows/test.yml`), and the `release` skill checks it. It fails only when coverage
*regresses* on a module already in the list. **That include list IS the definition of "core logic" —
extend it as each module reaches the bar, and never shrink it to make the check go green.**

In the gate today at **97.6% lines / 86.8% branches / 93.8% functions**, across 21 modules: `db.js`,
`middleware/auth.js`, **`routes/auth.js`**, `lib/mfa.js`, `lib/detectionEvents.js`,
`routes/timelapses.js`, `lib/wakeWatcher.js`, `lib/activityTracker.js`, `lib/bedTransitions.js`,
`lib/bedTransitionRules.js`, **`lib/sleepAnalysis.js`**, `lib/sleepReviews.js`, `lib/soundBaseline.js`,
`lib/processGuards.js`, `lib/ringHolds.js`, `lib/urlCredentials.js`, and the five clip modules
**`lib/clipStorage.js`, `lib/clipCapture.js`, `lib/clipRecorder.js`, `lib/recordings.js`,
`routes/recordings.js`** (added 2026-09-06).

⚠️ **THE THRESHOLDS ARE AGGREGATES ACROSS THE WHOLE LIST, not per file.** A module at 88% sits happily
under a green gate — `lib/clipRecorder.js` does, and so does `routes/auth.js` at 73% *branches*. That
is not a flaw to fix by adding per-file gates; it is the reason the include list must keep growing, and
the reason to read a module's own row (`npm run test:core 2>&1 | grep -E '^ℹ +<file>\.js'`) rather than
the summary line. Admitting the clip modules moved the aggregate 98.6 → 97.6, which is the gap becoming
visible rather than a regression.

**Tranche A of the sleepAnalysis work is DONE** (84.1% -> 99.5%): `sleepInsights` + `pearson`,
`runNightlySleepJob` + `startSleepJob`, `getStoredNights`, the window gates, and `nightClimate`'s
5-minute series. ★ It found a real bug on the way in — see "daylight saving" below. ★ It also found
the FIXTURES asserting a physical impossibility (a still in-bed minute at a motion peak below any
occupied bed on record, i.e. the empty-bed signature). **When a new guard breaks old tests, check the
fixture is physically possible before touching the code.**

**Tranche B is effectively CLOSED — Tranche A absorbed it.** Six uncovered lines remain and the gate is
met with headroom, so what is left is deliberate, not pending:
1. `lastCompletedNightDate`'s 4-day fallback — unreachable unless every candidate window is still open.
2. `firstQuietRunFrom` returning null (a night that never settles) and `hasAwakening` returning false.
3. **The nightly job's outer try/catch** — knowingly uncovered. Reaching it needs a failure inside
   better-sqlite3, which is not worth faking. ★ **Coverage caught a test of mine claiming to cover this
   and passing for the wrong reason**: it asserted `doesNotThrow` against a garbage sleep window, but
   `parseHm` defaults that to 19:00 so nothing ever threw. Renamed to what it actually verifies. **A
   green test is not evidence the branch ran — read the uncovered-line list, not the tick.**
4. The **multi-camera merge** is now covered incidentally (the climate tests use two cameras). §2.6 still
   deletes it — on design grounds, no longer on coverage grounds.

**Landed alongside this in 0.28.0:** the admin "Recompute this night" control and, more importantly,
the `allowDowngrade` guard in `computeAndStoreNight`. ★ That guard is the worked example of a hazard
that only exists once a feature makes it reachable: `activity_samples` retention (30 days) and the date
picker's range (30 days) are the same number, so the oldest browsable night sits ON the boundary and
recomputing it would have replaced a permanently-kept scored row with `no_data`. Nothing could reach
that path until a person could ask for a recompute. **When adding a control, look for the code path it
newly makes reachable.**

**Still to bring up to the bar and add to the list**, in priority order:
- `routes/cameras.js` (1,036 lines) — the biggest surface, and the one with real authz branching.
  **The last big one left.**
- `lib/motionDetector.js` — zone-mask maths
- ✅ `routes/auth.js` — **DONE 2026-09-05** (#295): 86.5 → 99.6% lines. ⚠️ Branches are **73%**, under
  the 80 bar and hidden by the aggregate; worth a deliberate pass rather than bolting on — tracked as
  **§3 E2**.
- ✅ `lib/clipStorage.js` — **DONE 2026-09-06** (#296), 100% lines, along with the other four clip
  modules. It had no test file at all, which is how `sweepClips(){ return; }` — deleting the entire
  retention sweeper — passed a green 389-test suite.

**★ COVERAGE MEASURES EXECUTION; MUTATION TESTING MEASURES DISCRIMINATION** — the lesson of #263, and
now a command rather than a memory. `node scripts/mutate.mjs` breaks the source one way at a time from
a catalogue (`scripts/mutants.json`, **84 mutants**) and reports any the tests fail to kill. It guards
the four ways such a run lies: a mutant that never applied, a restore that reverted uncommitted work, a
broken harness (a no-op control mutant must SURVIVE, or the whole run is declared void), and a
name-pattern that matched nothing. **Deliberately not in CI** — ~12 minutes, and this repo's own rule
is that a check people skim is worse than no check. Run it when adding tests to core logic, and add the
mutants your change should be killing.

⚠️ **Four "trap tests" were found and rewritten** in the same pass, all the same shape: *the test's
NAME stated the invariant, and its FIXTURE guaranteed the invariant could not be violated.* One
asserted `assert.ok(true, 'no throw')` for a containment guard that a successful escape also satisfies;
one asserted defaults its own `beforeEach` had just written; one derived every fixture, loop bound and
test name from the constants it was meant to pin. **Ask of every test: what value of the thing under
test would make this fail?**

**★ Daylight saving — FOUND AND FIXED 2026-08-29, and worth remembering as a pattern.** `localDateStr`
shifted days by adding 86,400,000 ms and reading the local date off the result. A day is not 24 hours
twice a year, so for Australia/Melbourne it returned the WRONG date for a full hour each time:
spring-forward (00:00-00:59 on 2026-10-05) **skipped** a day, fall-back (23:00-23:59 on 2026-04-05)
**repeated** one. It shipped as a bug in `currentNightDate` only — the live "tonight so far" view would
have vanished for that hour — and the reason is worth knowing: **`currentNightDate` walks only TWO
candidate dates (0..-1), so one bad candidate is fatal, while `lastCompletedNightDate` walks FOUR and
had a spare.** Widening a loop is therefore never a substitute for the date arithmetic being right.
Any future date-window code gets the same treatment: shift the local Y/M/D on the calendar, never the
instant. Both edges are now pinned by tests using `mock.timers`.

**Deliberately NOT in the gate:** the I/O glue — FFmpeg spawning, ONVIF SOAP, MQTT, the four push
senders, RTSP probing. Testing those means asserting that mocks were called with the right arguments,
which passes forever and catches nothing; their real failure mode is "the camera answered with
something odd", which only the e2e stack reproduces.

- **Phase 4 — build the image from the commit under test — `SHIPPED` (2026-08-26).** `e2e.yml` now
  builds `sauso/nightlight:dev` from the checked-out commit before bringing the stack up. Previously the
  suite ran whatever the published tag pointed at, so on a dev -> main PR a green run could be proving
  the PREVIOUS build. **The same applies locally**: `bash e2e/test.sh` on its own tests the last
  published image, not your working tree — build first.
- **Phase 5 — front-end testing — `SHIPPED` (2026-09-02).** The >= 80% target is met and **gated**:
  `vite.config.js` pins `{ lines: 80, functions: 80, branches: 75, statements: 80 }` and CI runs
  `npm run test:coverage`, so it ratchets exactly as the backend gate does. 36 component test files.
  `test/helpers/render.jsx` renders every screen as **both** an admin and a caregiver, which is the
  half that matters — role gating is real in the UI and is exactly where the timelapse-delete bug hid.
  ⚠️ **Raise the coverage; never lower the threshold or widen the exclude list** — the config says so
  at the line itself, because that is the failure mode for a ratchet.
  ★ The e2e half also grew, 6 → 49 specs, including the auth surface. **Unit tests cannot catch a
  client/server seam bug — only e2e can**, which is how the morning-review seam defect was found.
- **Phase 6 — Android instrumented tests (Espresso)** in `nightlight-mobile` — `SPECCED`, was Phase 5.
  Only the Capacitor scaffold stub exists. Local emulators were unusable (no nested virt) but **GitHub
  Linux runners have KVM**, so a CI emulator is realistic. Target the genuinely native bits: the
  foreground service surviving screen-off, and the notification Stop action.

Harder-to-fake features, deliberately deferred within the suite: **two-way audio** (Playwright can fake
a mic and assert the WebSocket connects and bytes flow, but never that the camera physically plays it)
and **PTZ/ONVIF** (needs a camera to respond). **The High/Low selector is testable** — give the
synthetic source a second path and assert the toggle swaps the stream.

---

### 2.6 Mark the main camera in the camera list — `IDEA` · *small*

All that is left of the old 2.6. **Single-camera sleep analysis shipped in 0.28.0**: sleep is scored
from the child's main camera (enabled, lowest `sort_order`), climate and the alert list stay
multi-camera because they average or list rather than combine, and the sleep detail view names the
camera it measured from.

What is still implicit is the *setting*: the camera list does not mark which camera is the main one, so
the choice lives silently in the drag order. Naming it on the detail view covers the case that matters
(tracing a wrong night to the camera that produced it), which is why this is an idea and not a defect.
⚠️ Only bites a household with two cameras on one child — nobody here has that, so it cannot be
observed locally.

### 2.7 Opt-in anonymized sleep-data sharing, to improve the algorithm — `SPECCED`, HELD (not scheduled)

Raised by the owner 2026-09-16: could households voluntarily anonymize and send their sleep-tracking
data so the maintainer can use it to improve the detection algorithm? Fully planned, two research passes
plus an adversarial design-review pass, **owner-approved 2026-09-16 — but deliberately not scheduled to
be built.** Full plan: [`reviews/sleep-data-sharing-plan-2026-09-16.md`](reviews/sleep-data-sharing-plan-2026-09-16.md).

The central tension: every existing outbound call (ntfy/Pushover/Gotify/Firebase) goes to a service the
household configures and owns, and the docs say so explicitly in three places ("no cloud... nothing is
shared through a Nightlight cloud" — `README.md:9`, `docker-hub-overview.md:3-5`, `docs/README.md:77-78`).
A feature sending data to a maintainer-run server is categorically new and would make those claims false
if shipped without qualifying them — the plan treats that as the central constraint, not an afterthought.

**Design, in brief** (full reasoning and file:line citations in the plan doc): export only data tied to
an explicit human label — a verdicted `bed_transitions` row or a `sleep_reviews` correction — never raw
`activity_samples` for its own sake; all timestamps become minutes-relative-to-window_start, never
absolute; real child/camera ids become a per-install HMAC pseudonym, salted by a locally-generated,
never-transmitted secret (mirrors `.jwt_secret`'s persistence pattern); direct PII (`children.name`/
`birthday`/`photo`, `cameras.name`, `sleep_reviews.note` free text, every credential field, every
snapshot/clip file) is hard-excluded with no toggle. Differential privacy and k-anonymity were
considered and explicitly rejected as the wrong tool for a single opt-in batch upload from a
self-selecting population — reasoning is in the plan, not left implicit.

**Phased**: 1a (local preview/download only, no network code, clones `DiagnosticsCard.jsx`'s "nothing
uploaded, stays on your device" pattern) → 1b (bounded numeric context window around each label) →
Phase 2 (the actual opt-in periodic upload, off by default, to an env-var-configured endpoint with no
baked-in default — inert until the maintainer provisions real infrastructure and sets it). **Where the
data would actually go is real infrastructure outside this repo** — recommended option is a small
Cloudflare Worker + R2 bucket, but that's a maintainer infra decision, not something this plan builds.

**HELD, not NEXT**: the owner approved the design but does not want it built now. Do not start any phase
without a fresh explicit go-ahead — re-read the plan doc first, since it also names a real pre-existing
bug found along the way (`routes/diagnostics.js` leaks `children.name`/`birthday` into the "redacted"
diagnostics bundle — not part of this item's scope, worth its own fix separately).

## 3. Idea backlog

Not committed — each is specced far enough to start, ordered by value-for-effort. Suggested first
three: **A1**, **A2**, **C1**. For *maintenance* rather than features, see **§E** — those are agreed
and unblocked, and are the right thing to reach for in a gap.

### A. Builds on the shipped sleep + climate + clips data
- **A1. Weekly sleep digest** — `IDEA` · *small*. Aggregate the existing per-night summaries per child:
  total/avg sleep, avg wake count, best/worst night, trend vs prior 7 days. Delivered as a "This week"
  card on the child page plus an optional Sunday-night push. No schema change (aggregate on read).
- **A2. Auto-surfaced climate correlations** — `IDEA` · *small–medium*. We already eyeball "do warm
  nights mean more wakes" by hand; `sensor_readings` + wake events make it a feature. Bucket nights by
  room temp and compare wake counts: *"Renz woke 3× on nights over 23 °C vs 0.8× otherwise."* Only
  render when the signal clears a minimum sample size and effect. Clearly labelled correlational —
  **never** a medical claim.

### B. Alert quality-of-life
- **B2. Alert escalation** — `IDEA` · *medium*. If an alert isn't acknowledged within N minutes,
  re-notify or notify a second caregiver (reuses caregivers + Pushover device targeting).
  "Acknowledge" = opening the alert / tapping the push, recorded on the event row.
  Needs `detection_events.acknowledged_at` + an escalation timer. **Open:** policy config, global vs
  per-child.

### C. Fits the self-hosted / Unraid / Home Assistant world
- **C1. Home Assistant integration (MQTT discovery)** — `IDEA` · *medium*. **Highest fit for this
  deployment.** Nightlight already speaks MQTT *inbound* for motion; publishing HA MQTT Discovery
  config + state topics outbound lets nursery automations react to Nightlight state: online/offline,
  last motion/sound, sleep status, room temp/humidity. Reuses the existing MQTT client.
  **Open:** one device per camera vs per child; whether to expose *controls* (arm/disarm) or sensors only.
- **C2. Remote lullaby / white-noise** — `IDEA` · *medium*. Two-way *talk* works; playing soothing audio
  out the camera speaker is the natural extension, over the same `OnvifBackchannelTalk` sink,
  transcoded to the camera's G711 backchannel codec. Only works on cameras with a working backchannel
  (Thingino ✓). **Open:** built-in sounds vs user-uploaded; loop/duration; scheduling.
- **C3. Nursery kiosk / wall-tablet mode** — `IDEA` · *small–medium, frontend only*. A dimmed,
  red-shifted, always-on route: one camera + clock + room temp, tap to wake to full brightness,
  auto-dim after inactivity, screen wake-lock.

### D. Access / sharing
- **D1. Time-limited babysitter link** — `IDEA` · *medium*. A scoped, expiring, read-only token granting
  live view of one camera/child until expiry, revocable anytime. Reuses the JWT + `sessions` row model
  with a new narrow scope; a `guest_grants` row checked in auth middleware. No settings, no history —
  just live. **Open:** almost certainly view-only (no talk).

### E. Maintenance and housekeeping
Not features — small, agreed, unblocked work with no dependency on the holdout. **This is the list to
pick from when there is a gap**, which is why it is one list rather than four notes in four places.

- **E1. Clear the `qs` and `uuid` advisories** — `NEXT` · *small*. `npm audit --omit=dev` on the backend
  reports **9 moderate** advisories: `qs` (array-limit bypass, DoS via attacker-controlled `isBuffer`)
  and `uuid` (missing buffer bounds check in v3/v5/v6). Both are **transitive through
  `gaxios`/`teeny-request`**, i.e. Firebase Admin, not direct dependencies. The frontend reports 0.
  - **Confirmed pre-existing, not introduced by the 2026-09-06 dependency batch** — that lockfile diff
    touches neither package (0 changed lines mentioning them).
  - `qs` has a **non-breaking** `npm audit fix`. `uuid` needs `--force`, which can move majors.
  - ⚠️ **Read what `--force` actually proposes before running it**, and re-run the suite plus a real
    image build after — `firebase-admin` is on the push path, and a broken push is silent until an
    alert fails to arrive.

- **E2. `routes/auth.js` branch coverage** — `NEXT` · *small*. **73%**, under the 80 bar, and invisible
  because the gate is an aggregate. Lines are 99.6% and functions 100%, so what is missing is the
  either-or paths, not whole functions. See §2.3, where it sits on the coverage list.

- **E3. Fix the third state in `02-add-camera`'s e2e wait** — `NEXT` · *small*. The spec clicks **Add
  camera**, then waits up to 8 s for the **Save anyway** button that appears when the pre-save stream
  validation fails against a cold synthetic source. Its `catch` treats "the button never appeared" as
  *"validated on the first try"* — but there is a third state: **validation failed AND the button was
  slower than 8 s**. The run then continues as though the camera had been saved and fails ~20 s later
  waiting for "Save changes", which points at the wrong thing entirely.
  - Observed 2026-09-06 on the dependency batch; the screenshot showed the app correctly reporting an
    unreachable camera. Re-run 3× on the identical image: 3/3 passed, so it is a flake, not a
    regression — but it costs an investigation every time it fires.
  - **Fix:** decide between the two outcomes explicitly rather than inferring from a timeout — wait for
    *either* "Save changes" *or* "Save anyway", and fail with a message naming which appeared.

- **E4. Move the soak stack into the repo as `e2e/soak/`** — `NEXT` · *small*. It currently lives
  outside the repo on the dev machine, which was the right call while it was unproven. **It has earned
  its place**: it validated #257 end to end, caught the #274 review's finding in a live container,
  proved #254's per-leg isolation, measured the shutdown-grace gap that became #279, and confirmed
  #297's fix under fault injection. None of that was reachable from a unit test.
  - Brings with it the two fault-injection recipes (hide `ffmpeg`; hide `mediamtx`) that are currently
    only in an agent's notes.
  - It already mounts `e2e/fakecam/mediamtx.yml` from the repo, so the move mostly means the compose
    file and a README. ⚠️ Keep the warning that it must never be pointed at a bedroom camera.

---

## 4. Deferred / shelved

Recorded so they don't get re-litigated. Each was considered and consciously parked.

- **Bed occupancy via camera vision** — `ABANDONED 2026-09-10` (owner's call). Was §2.5: a frozen
  MobileNetV3 backbone shipped once, plus a ~1,154-parameter per-install head fitted on ~20-60 frames
  the owner labels himself, vetoing bed-transition calls the motion detector gets wrong (Raffa sleeps
  under a blanket, Renz in a sleep suit — often only a head is visible, which motion-only detection
  can't resolve). Real, extensive work happened before it was parked: a VLM auto-labelling attempt
  (Qwen2.5-VL) failed outright (a leading prompt pre-authorised "occupied", scoring ~5% on known-empty
  frames); 867 frames across 28 nights were then hand-labelled instead, training a MobileNetV3 head.
  **Why it died, in order of weight:**
  1. **The measurement itself couldn't distinguish configurations.** An ablation meant to rank a few
     candidate training changes instead found ~30 points of run-to-run spread on an *identical* config
     (54.5%–93.9% worst-class accuracy across seeds) — every headline number this effort ever produced
     (59% → 62% → 66% → 58% → 91%) was drawn from that same noise, not a real trend.
  2. **The bar moved out from under it.** #327 + #342 (shipped in 0.30.1) made the wake-time detector
     near-exact on measured nights by working around the occupancy gap in the departure scan itself —
     so a vision veto now has to *beat* an already-good detector rather than replace a clearly-broken
     one, while its own reliability was simultaneously in question per point 1.
  3. **The product shape doesn't fit this project's own standing rule.** A per-install head needs the
     installer to hand-label dozens of frames of their own sleeping child with no designed labelling
     flow; shipping one head trained on Renz and Raffa "as-is" would be exactly the "built only for this
     house" failure `CLAUDE.md` forbids.
  **What survives, and is being reused rather than wasted:** the 867 hand-labelled frames (grabber kept
  running, 5×/day) and the 465 owner-verdicted `bed_transitions` snapshots both become ground truth to
  score whatever replaces this, vision or otherwise. **Decision: pursue a physical occupancy sensor
  instead** (a bed-presence mat or mmWave/radar module) over the MQTT motion source already in this
  codebase — optional hardware, a reliable signal instead of a probabilistic one, and it degrades
  honestly (simply absent) when nobody adds it, which fits an app other people install far better than a
  model fitted to two specific children. Not scoped as its own roadmap item yet — raise it again once
  there's hardware to design against.
- **Chromecast** — `HELD`. Requires `window.isSecureContext`, so it works only over the HTTPS domain,
  not LAN http; HLS-mode only. The web Cast SDK is **Chrome-browser-only** — it does not work in the
  app's WebView. Undecided: target the browser, or adopt the native Android Cast SDK. Ask before building.
- **Passkeys / WebAuthn** — `HELD`. Deferred behind the shipped TOTP 2FA. Browser-only: can't run over
  LAN-IP http or in the WebView, which is where this app is mostly used.
- **LL-HLS** — `SHELVED`. WebRTC is already sub-second, so the win is small; the cost (fMP4 + HTTP/2 +
  HTTPS-only + proxy work) isn't worth it. Compatibility-mode lag was instead cut by shortening
  MediaMTX segments and addressing camera GOP.
- **otplib 12 → 13 (Dependabot #128)** — `DONE in 0.25.2`, but **closed rather than merged**, because the
  bump alone would have taken the whole server down: v13 removes the `authenticator` singleton, so
  `lib/mfa.js`'s top-level `authenticator.options = {...}` threw a `TypeError` at import, and
  `index.js → routes/auth.js → lib/mfa.js` is the startup path. Ported to the v13 API instead (now
  13.5.0). Two traps worth remembering if this ever comes up again: `epochTolerance` is in **seconds**,
  not time steps (v12's `{window: 1}` is `epochTolerance: 30`), and `epoch` is in seconds too. v13
  enforces a 16-byte minimum secret where v12 generated 10-byte ones — legacy secrets keep working via
  `createGuardrails({ MIN_SECRET_BYTES: 10 })` on the verify path only, deliberately *not* forcing a
  re-enrolment, since locking someone out of their own monitor is worse than an 80-bit secret they
  already hold. New enrolments are 160-bit.
- **Adaptive stream quality, beyond the manual selector** — `CLOSED 2026-08-25, not building`. High/Low
  per tile, remembered per camera, is the finished feature. Both phases once planned on top of it are
  decided against: **on-demand sub-stream transcoders** (measured on prod — the motion detector holds
  the sub path open 24/7 regardless of viewers, so it saves nothing and could cost more; 72h of logs
  showed zero camera client-limit errors) and **automatic quality switching** (every switch costs a
  WebRTC reconnect — this app's worst existing failure mode — to solve a bandwidth problem that hasn't
  occurred on a LAN monitor). The sub-stream reasoning is repeated in `lib/subStream.js`, where anyone
  tempted to build it would actually hit it.

---

## 5. Operational runbooks

Not plans — living procedures, kept alongside this file:
- **`deploy-runbook.md`** — staging → release → production on Unraid, with the gate at each step and
  why it exists. Read it when something does not look right; the `/release` and `/deploy-staging`
  skills are the automation of the same steps. ★ Holds the two traps that mislead most: the guard
  script prints the **OCI revision label, which is empty on production** (use `NIGHTLIGHT_GIT_SHA`),
  and `--stop-timeout 30` in the DockerMan templates only takes effect on the next `update_container`.
- **`sleep-marker-review-runbook.md`** — pull a night's OOB / into-bed markers, `bed_transitions`, and
  shadow onset/wake off staging. Read-only. Note it deliberately warns that prod is a *different*
  database with different camera IDs — don't cross the two.
- **`comment-audit-runbook.md`** — the provably-complete pass over every reassurance-shaped comment
  ("never", "cannot", "handled"), checking each against the code beside it. ★ Driven by an
  **enumerated candidate list** so completeness is checkable — 441 candidates across 92 files, worked
  8 agents at a time, one at a time. Exists because this class of defect is invisible to the test
  suite: #297 hid behind a comment asserting a hazard was "verified on win32" in a Linux-only product.
  Holds the running ledger — start there to see what has been covered.

---

## 6. Explicit non-goals

### Breathing / roll-over / SIDS-style "safety" detection — **not building**
The obvious ask for a baby monitor, and deliberately declined. A self-hosted hobby app must not present
as a **medical or safety device**: false confidence is genuinely dangerous, and the accuracy and
liability bar is far beyond this project. Sleep tracking stays clearly labelled as *pattern inference*,
never a vitals or safety claim. If mmWave/respiration hardware were ever added, it would be a separate,
explicitly opt-in tier — and still not marketed as a safety guarantee.
