# Nightlight — Roadmap

The single list of **open** work. If something isn't here, it's either shipped (see `CHANGELOG.md`,
and [`ROADMAP-archive.md`](ROADMAP-archive.md) for the diagnosis and measurements behind it) or a
deliberate non-goal (§6).

**Ground rule:** this file tracks *intent*. `CHANGELOG.md` is the record of what actually shipped —
when the two disagree, the changelog is right. Update this file in the same commit that changes the
plan, and **move an item to [`ROADMAP-archive.md`](ROADMAP-archive.md) the moment it ships** — cutting a
release is the checkpoint where that gets verified (see the `release` skill's roadmap gate). The moved
text keeps its section number and sub-headings ("item 1", "Gap A", "Phase 1") in the archive, and
**a one-line stub stays here** naming the version it shipped in, because code and test comments cite
`ROADMAP §x` as text: a citation resolves either to a heading or stub in this file, or to the same
section in the archive. A section that shipped in part keeps its open remainder here, shortened. An
item that turns out not to be worth building goes to §4 *with the evidence*, so it doesn't get
re-proposed later.

> **History note:** `planning/` previously held 12 per-feature scope docs, most describing work that had
> already shipped — several still headed "Not started" months after release, and one
> (`ux-refresh-v2-scope.md`) specifying a nav that was built and then abandoned. They were deleted in
> favour of this file (2026-08-24), and `on-demand-recording-scope.md` followed once that feature
> shipped in 0.25.0. The full text of each remains in git history if the design reasoning is ever needed.

**Status vocabulary:** `NEXT` (agreed, ready to start) · `IN PROGRESS` (being built now) ·
`SPECCED` (design settled, unbuilt) · `IDEA` (worth doing, not committed) · `HELD` (blocked or waiting
on something). On stubs and in §4: `SHIPPED` / `DONE` (released; the stub names the version) ·
`CLOSED` (finished or decided, nothing left to build) · `SHELVED` (parked, the reason recorded) ·
`ABANDONED` (tried and dropped, with the evidence).

---

## 1. Next up

> **The holdout scorecard (closed and scored 2026-09-09)** that used to open this section is in
> [ROADMAP-archive.md §1](ROADMAP-archive.md#1-next-up): ten nights per child against recorded ground
> truth, the early-wake fix shipped in 0.30.1 (PR #327 + PR #342), the zone repaint that failed its
> pre-registered criterion, and the three integrity problems to fix before the next measurement run.

### 1.1 Fix Child B's bed-zone discrimination — `CLOSED`
Shipped in 0.27.0, closed 2026-08-29. The diagnosis (the worked example of "moving a camera without
redrawing the zone makes detection worse, not better") is in ROADMAP-archive.md §1.1.

### 1.2 Harden the bed-transition classifier — `NEXT`
**Most of this shipped (0.27.0 to 0.31.0). What remains is the open half of items 1, 2 and 3 below.**
The full history, every measurement and both rejected designs are in ROADMAP-archive.md §1.2, under
the same item numbers. Read it before changing the classifier: it records what was already tried.

⚠️ Every figure measured before 2026-08-30 describes the OLD bed zones (both were redrawn over real
frames that day) and is historical. All figures come from two cameras in one house.

- **Step 0 (repaint the zones) — `DONE` 2026-08-30.** Archive §1.2.
- **1b. Warn when a zone looks wrong — open.** Nothing tells anyone their zone excludes the bed; it
  fails silently and looks like a detector problem. Candidates: flag a zone whose area overlaps little
  of where in-bed motion actually occurs, or show the zone over a recent frame in settings. This is
  the generalisable half: every installation paints its own zone.
- **Item 1. Track believed occupancy.** Log-only implementation `SHIPPED` (0.31.0): `believedOccupied`
  is tracked and a contradiction is logged, every transition is still recorded. The missed-entry
  near-miss log, `getImpossibleTransitions()`, `getQuickReversals()` and the "Quick check-in?" review
  prompt shipped with it. **Still open: an actual gate.** Suppressing a same-direction repeat was
  measured unsafe (a repeat proves one of the pair is wrong, never which; 22 owner-verdicted-correct
  transitions would have been dropped). It needs a safe retroactive rule that never touches a
  verdicted row, or a preference at the analysis layer. Revisit once item 2 lowers the
  false-transition rate. Target: whatever `getImpossibleTransitions()` returns when re-run.
- **Item 2. Outside-channel evidence.** Recording half `SHIPPED` (0.31.0): `bed_transitions.out_peak` /
  `out_frames` on every transition, record-only. A peak-only floor was checked against 468 reviewed
  verdicts and does not separate correct from wrong in either direction. **Still open, exit side:**
  pick a duration threshold from accumulated `out_frames` data and gate confirmation on it (the fast
  link, `OOB_LINK_MS`, has no minimum outside magnitude at all). Score it on the reviewed nights before
  shipping; Child A's wake is the best number in the system and a naive fix risks regressing it.
- **Item 3. Separate "parent leaves" from "child exits" — open, and the most valuable item.**
  - *Figures the code cites* (`bedTransitionRules.js`, measured 2026-09-13, both cameras, about three
    weeks): an `into_bed` followed within 60 s by an `out_of_bed` is about 8% of recorded entries
    (86 of 1053 transitions). In the hour after the trailing `out_of_bed`, **60% (52/86) kept showing
    4+ active minutes** of normal stirring in the bed zone (`motion_peak` > `MOTION_ACTIVE`), which is
    essentially impossible if the child had left; only **9 of 86 went fully silent** for the hour, the
    one signature consistent with a real departure. The measurement reports "4+" and "fully silent"
    only, not a distribution across 1/2/3/4+ minutes.
  - **Phase 1 `SHIPPED` (0.31.0):** `getLingeringBedMotion()` generalises that check to every
    `out_of_bed` (4+ DISTINCT active minutes, no `into_bed` before them). Measured on staging
    2026-09-14: 62 of 758 flagged (8.2%); 2 of 37 owner-verdicted-correct exits flagged (5.4%, small
    sample). Query only.
  - **Phase 2 `SHIPPED` (0.31.0):** the morning review asks "Still moving?" for those exits. Ground-truth
    collection only: no gating, no change to `wake_count` or `awake_minutes`.
  - **The simultaneous-activity gap (added 2026-09-18) — open.** A climb-out or put-down where the bed
    and outside channels are active in the same frame opens no candidate and logs nothing. Two
    mechanism designs were rejected in review before anything was built. Steps (1) and (2) `SHIPPED`
    (0.31.0): the state machine extracted to `bedTransitionTracker.js` with tests, and the `[coactive]`
    diagnostic log. **Step (3), a third mechanism design, is not started**: start from the fix list in
    the archive, not from either rejected design, and check it against the recorded incidents there.
  - Also open: an analysis-layer discount for quick reversals (option (b)), once verdicts accumulate.
- **Item 4. Log-driven tuning.** The exit rule logs rejected links (`[oob] … link rejected`) with the
  actual gap and outside magnitude. Read a week of them before moving `OOB_LINK_SLOW_MS` or
  `OOB_SLOW_OUT_MIN`.

**Done when** a night's per-event markers are trustworthy enough to draw again, i.e. no impossible
sequences across a week and the put-down/departure pair still matches ground truth.

### 1.3 Sound is not a per-room signal — `IDEA`
Fallout from the same night. A bedroom mic hears the whole house: 16 of the 19 sound-active minutes
that were holding Child A's onset an hour late were simultaneously loud in his brother's room, while his
own bed never moved. 0.26.0 handles this for **onset** only (a sound-only minute counts as awake only
once a put-down proves the child is in the bed, and only if that room also moved nearby).

The first half hour after onset uses the same witness rule: `SHIPPED` in 0.27.0 (ROADMAP-archive.md §1.3).

What is still open is the **rest of the night** — deliberately left alone, because mid-night the house
is quiet and a cry with no movement is exactly the wake-up a parent wants counted. Worth measuring
before touching: across all nights on record, how many counted wakes are sound-only *and* simultaneous
with noise in the sibling's room? If that number is large, the wake rule needs the same treatment. If
it's small, leave it alone. **Measure first.**

---

### 1.4 The ambient sound baseline — freeze `SHIPPED`, statistic mismatch `NEXT`

**The freeze — `SHIPPED` in 0.30.0.** A steady level in the band between half the alert margin and the
margin is now absorbed into the baseline after five minutes. The mechanism, the production evidence,
the outage regression the fix first shipped with, and the extraction of `lib/soundBaseline.js` (the
prerequisite, done) are in ROADMAP-archive.md §1.4.

**Phase 1 (instrumentation) — `SHIPPED` in 0.31.0.** `activity_samples` records `sound_p75`,
`sound_p90` and `sound_sd` per minute; nothing reads them yet. Detail in ROADMAP-archive.md §1.4.

**⏳ STILL OPEN — and it is the bigger half: the statistic mismatch.** Everything in the archive under
"THE ROOT CAUSE IS DEEPER THAN THE FREEZE" is untouched. `sound_peak` is still the per-minute **maximum** of ~300
windows measured against a floor that tracks a **central tendency**, so the 6 dB `SOUND_ACTIVE`
threshold is still really a statement about the room's variance. The measurement that sizes the work
stands: the affected room would still read ~41% of minutes active against 19% for the other, even with
a perfectly healthy baseline.

**Phase 2 remains open, gated on real accumulated data:** choose the statistic and threshold, then
cut over `SOUND_ACTIVE` in a separate change. Analysis will query SQLite directly against a DB snapshot;
the fixed `/activity-history` SELECT does not expose these diagnostics. Only the existing mean and
the recorded p75/p90/sd will be available for that comparison. A different, unrecorded percentile cannot
be recovered from these summaries and would require a fresh collection window.

**Data cutoff (issue #453):** digitally silent windows (every sample zero) used to be DROPPED; from the first
release after 0.34.0 (0.35.0, the one whose CHANGELOG lists #453) each is stored as an excursion of 0. So for a camera
that delivers digital silence, `sound_level`, `sound_p75`, `sound_p90`, `sound_sd` and `sound_windows` from
before and after that release are different populations, and a minute of nothing but silence that stored no
sound (NULL, or no row at all) now stores `sound_peak` 0. Do not mix the two sides of that release in the
Phase 2 analysis. (`sound_peak` itself only changes from NULL to 0, which no `SOUND_ACTIVE` comparison can
tell apart.) On the cameras measured so far (G711 A-law) digital silence does not occur, so their rows are
unaffected; check `[obs] silent=` per camera before relying on that.

### 1.5 A wake-up the parent can actually see — Gaps A and B `SHIPPED` (0.31.0), replay + audit `NEXT`

Two display gaps between the alert feed and the Wake-ups list. Full text, measurements and the
"what is NOT wrong" note are in ROADMAP-archive.md §1.5, under the same sub-headings.

- **Gap A — the morning wake is not a row — `SHIPPED` in 0.31.0** (PR #420). Archive §1.5 Gap A.
- **Gap B — an out-and-back-in episode below the activity threshold was not a wake — `SHIPPED` in
  0.31.0** (PR #429, `detectMidnightEpisodes`). Archive §1.5 Gap B. **Still open before this closes:**
  the production replay and the verdict audit (the shipped replay was on staging's stored nights).
  Its named, accepted limits are listed in the archive; the largest is that it cannot tell an adult's
  bed visit from the child's own trip (§1.2 item 3).
- **Why the two children differ at all**, and **what this assumes about someone else's house**:
  measured and settled, not to be re-litigated. Archive §1.5.

### 1.6 Sleep report notification is a fixed-clock snapshot, not evidence-based — option 1 `SHIPPED` (0.31.0), narrowed scope

The sleep report fires once, on the first job tick after the sleep window closes, whether or not the
child's wake has been observed. Full analysis and the design-review history: ROADMAP-archive.md §1.6.

- **Option 1 — a follow-up when a later recompute changes the picture — `SHIPPED` in 0.31.0, narrowed:**
  a follow-up is sent only when a wake time that was unknown becomes known (null to real), never on a
  real-to-real change. It replaces the original in the tray via a notification tag.
- **Not fixed by it:** a night whose `wake_at` stays null for the whole 3-hour refinement gets no
  follow-up. Closing that needs §1.2 item 3 or a distinct "still unclear" notification.
- **Option 2 — delay the first notification** until a confirmed final wake exists or a capped delay
  passes (for example 60-90 minutes past the window end) — not built.
- **Option 3 — a rolling expected wake time per child from history**, holding the report until about
  then — not built; real design work (how much history, an unusual night, a new install).

### 1.7 Observation time and coverage (#373) — instrument `SHIPPED` (0.34.0), consumers `SHIPPED` (0.35.0), Stage B + owed runs `NEXT`

The observation clock (`lib/observationClock.js`) and each consumer that switched over to it are
described in ROADMAP-archive.md §1.7, issue by issue. Shipped in 0.35.0: #493 (no fabricated frames in
the motion detector), #447 Stage A (activity rows keyed by receipt minute), #452 scope A (confirmation
restarts after a gap in the video), #448, #508 (zero-frame minutes are unwatched), #588 and #369 (the
detector watchdog). Every threshold in it came from one house's runs.

**Open follow-ups those changes left** (detail in the archive):
- **#447 Stage B:** key activity by the PTS-derived observation time, and name sampler or analysis
  coverage. Needs samples held for `FINALIZE_MS` and a sound-leg hook that does not exist.
- **#452:** scope B (clone-gated confirmation), #500 pending-candidate refusal, a backward-step
  cooldown clamp, and a restart cap or maximum wait for chronic gaps.
- **#508:** `bedTransitions.getActivitySamples` / `bedTransitionRules` still read `motion_peak` alone;
  `applyCorrection` subtracts the aggregate unknown count; a sparse-minute threshold and a
  frozen-picture (encoder wedge) detector both need data first.

**Owed from the #373 plan's Verification section** (the 24 hours on staging are done, 2026-09-28):
- still owed: the soak-box runs with an image built from the branch (3 s and 12 s DROPs, a 3 s HOLD and
  a 3 s Node block through the stall proxy, `[obs]` checked against the proxy's own log, a clean 30
  minutes at `unknown=0`, CPU before/after);
- still owed: the worst-case load run (4 fakecam cameras at 30 fps, main stream only, event-loop lag p99
  and CPU with the clock on and off — the build's microbenchmark is a simulation, not this).

**Open after 0.45.0 (2026-11-01):**
- **ESPHome radar sensor, promotion decision (#917) — `HELD`.** 0.45.0 stores a shadow wake (`wake_at_sensor`,
  `sensor_rejects`) beside each completed night and changes nothing shown. Promote it only with at least 15
  reviewed nights, at least 5 of them with an adult at the bed right after a real exit, and none made worse
  (the bar is in `docs/esphome.md`, "The sleep shadow"). Waits on nights and on the owner's morning reviews.
- **Camera placement trial (#644) — `HELD`.** The docs half shipped in 0.36.0. The trial compares transition
  accuracy and the empty-bed scan before and after a camera moves to the top-down view; both cameras of the
  one install moved on 2026-10-29, so the earliest useful read is about three weeks later. A bed zone and the
  room baselines change with a move, so before and after are not directly comparable: state that in the result.
- **Late or missing morning wake (#700, #618 follow-ups) — `HELD`** until the shadow nights and reviews above exist.
- **A sleep window of almost 24 hours never closes the wake watcher's gate (#922) — `IDEA`,** low priority.

### 1.8 Sleep Score and Night summary — `IN PROGRESS`

Approved 2026-11-11. Full plan: [`sleep-score-plan.md`](sleep-score-plan.md).

A nightly Sleep Score (0-100) for each child and a short "Night summary" in plain language, on the
child's sleep card and the sleep detail page. Nights only, no naps. The score is **computed on read**
from the night an endpoint is about to return, so it always matches the figures beside it and a
correction or a tuned formula applies at once; it is not stored. Five components: duration,
continuity, settling, restlessness, consistency, compared with the child's own last 7 to 14 nights
(age is only a fallback), with a weakest-link cap. Bands "Great", "Good", "Fair"; the lowest band
shows the number alone. No score for a night in progress or one with no measured sleep. The summary
is built from a phrase library, descriptive only: no causes, no advice, never a sleep-stage or medical
claim. Every weight and curve is a starting value tuned on two cameras in one house.

| # | Phase | Review tier | Status |
|---|---|---|---|
| 0 | Documents: this entry, the plan, the roadmap archive | T0 | `DONE` on `dev` (#1038) |
| 1a | Save the raw facts (`stir_minutes`, `summary_facts`). Ships first and alone: raw samples are deleted after 30 days, so every night stored without it loses restlessness for good | T2 | `DONE` on `dev` (#1039) |
| 1b | Scoring maths: baseline, score, age table with citation, evidence script | T2 | `DONE` on `dev` (#1040) |
| 1c | API: attach `score` on read; `docs/sleep-tracking.md`. Also the wake half of #1041 and the 15-minute correction rule (owner decision 2026-11-12) | T1 | `DONE` on `dev` (#1042) |
| 2 | Score UI: ring on the card and detail page, breakdown sheet, per-child "Show sleep score" switch (default on). The docs screenshots are refreshed at release, not here | T2 | `IN PROGRESS` (this pull request) |
| 3 | Night summary: selection on the server, phrase library in the browser | T1 | `NEXT` |
| 4 | Live night: "so far" summary, current state | T2 | `HELD` until the score has been used on staging |
| 5 | Trends over 7/14/30 days (replaces idea A1) | T1 or T2 | `HELD` |
| 6 | Tappable timeline (independent of the score) | T1 | `HELD` |
| 7 | Optional LLM rewording through a user-supplied endpoint | separate plan | `IDEA` |
| later | "Disruptions" and self-settling rate; needs cry classification (§2.2) and a reliable caregiver signal | separate plans | `IDEA` |

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

**In the gate today: 41 modules** (count the `--test-coverage-include` flags in `backend/package.json`'s
`test:core` script; that list is the source of truth, not this line). Thresholds: 95% lines, 90%
functions, 80% branches. For today's measured figures read the CI `unit` check, which runs it.

⚠️ **THE THRESHOLDS ARE AGGREGATES ACROSS THE WHOLE LIST, not per file.** A module below the bar can
sit under a green gate. That is not a flaw to fix by adding per-file gates; it is the reason the
include list must keep growing, and the reason to read a module's own row
(`npm run test:core 2>&1 | grep -E '^ℹ +<file>\.js'`) rather than the summary line.

**Shipped history, in ROADMAP-archive.md §2.3:** the gate as it stood at 21 modules; Tranche A and
Tranche B of the `sleepAnalysis.js` coverage work (`DONE`); the "Recompute this night" control and its
`allowDowngrade` guard (0.28.0); `routes/auth.js` (`DONE` 2026-09-05, branches 2026-09-25) and
`lib/clipStorage.js` with the clip modules (`DONE` 2026-09-06); the four "trap tests"; and the
daylight-saving date bug (found and fixed 2026-08-29).

**Still to bring up to the bar and add to the list**, in priority order:
- `routes/cameras.js` (1,036 lines) — the biggest surface, and the one with real authz branching.
  **The last big one left.**
- `lib/motionDetector.js` — zone-mask maths

**★ COVERAGE MEASURES EXECUTION; MUTATION TESTING MEASURES DISCRIMINATION.** `node scripts/mutate.mjs`
breaks the source one way at a time from a catalogue (`scripts/mutants.json`, **2,766 entries** on
2026-11-11) and reports any the tests fail to kill. The whole catalogue runs weekly in CI, sharded, and
by label on demand (`.github/workflows/mutation.yml`, since 0.40.0); never on a pull request. Locally,
always restrict it with `--only=<label substring>`. The catalogue is a tool for finding missing tests,
not a quota (`docs/mutation-testing.md`). The original note, from when it held 84 mutants and was not
in CI, is in ROADMAP-archive.md §2.3.

**Deliberately NOT in the gate:** the I/O glue — FFmpeg spawning, ONVIF SOAP, MQTT, the four push
senders, RTSP probing. Testing those means asserting that mocks were called with the right arguments,
which passes forever and catches nothing; their real failure mode is "the camera answered with
something odd", which only the e2e stack reproduces.

- **Phase 4 — build the image from the commit under test — `SHIPPED`** (2026-08-26; CI only, so
  no release carries it). ROADMAP-archive.md §2.3.
- **Phase 5 — front-end testing — `SHIPPED`** (2026-09-02; likewise CI): the frontend coverage gate.
  ROADMAP-archive.md §2.3.
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
shared through a Nightlight cloud" — the README's "Privacy and safety" section, `docker-hub-overview.md:3-5` and `docs/networking.md`).
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
three: **C1**, **B2**, **C3** (A1 is now phase 5 of §1.8; A2 shipped). For *maintenance* rather than features, see **§E** — those are agreed
and unblocked, and are the right thing to reach for in a gap.

### A. Builds on the shipped sleep + climate + clips data
- **A1. Weekly sleep digest** — `IDEA` · *small*. Aggregate the existing per-night summaries per child:
  total/avg sleep, avg wake count, best/worst night, trend vs prior 7 days. Delivered as a "This week"
  card on the child page plus an optional Sunday-night push. No schema change (aggregate on read).
  **Replaced by phase 5 (Trends) of the sleep-score plan** (§1.8, [`sleep-score-plan.md`](sleep-score-plan.md)):
  do not build this separately.
- **A2. Auto-surfaced climate correlations — `SHIPPED`** as the "Sleep & room temperature" card (0.19.0;
  the minimum of 10 nights per group in 0.41.0). Issue #365 (present temperature insights as fragile,
  exploratory summaries) is still open. Original text: ROADMAP-archive.md §3 A2.

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

### F. Interface
- **F1. Wider UI refresh** — `IDEA`. A refresh of the settings, cameras, live and caregivers screens,
  explored in an external prototype. Explicitly out of scope of the sleep-score plan (§1.8), which
  touches only the child's sleep card and the sleep detail page.

---

## 4. Deferred / shelved

Recorded so they don't get re-litigated. Each was considered and consciously parked.

- **Bed occupancy via camera vision** — `ABANDONED 2026-09-10` (owner's call). Was §2.5: a frozen
  MobileNetV3 backbone shipped once, plus a ~1,154-parameter per-install head fitted on ~20-60 frames
  the owner labels himself, vetoing bed-transition calls the motion detector gets wrong (Child B sleeps
  under a blanket, Child A in a sleep suit — often only a head is visible, which motion-only detection
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
     flow; shipping one head trained on Child A and Child B "as-is" would be exactly the "built only for this
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
- **otplib 12 → 13 (Dependabot #128)** — `DONE in 0.25.2` (ported to the v13 API rather than merged).
  The two traps worth remembering are in ROADMAP-archive.md §4.
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
