// Sleep-analysis tests. Run with `npm test` in backend/ — Node's built-in runner, no dependencies.
//
// These cover the paths that REAL DATA CANNOT REACH. Every stored night can be replayed against the
// live database, but no night on record has an early bedtime or an empty bed, so those branches would
// otherwise ship unverified — which is exactly how the first early-bedtime implementation went out
// silently inert (it searched the lookbehind for "the first quiet run", and since an unsampled minute
// counts as quiet, it always matched the start of the data gap instead of a real bedtime).
//
// DATA_DIR is pointed at a throwaway directory BEFORE sleepAnalysis is imported, because db.js opens
// the database at module load. Hence the dynamic import below.

import { test, before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nightlight-test-'));
process.env.DATA_DIR = TMP;

const { computeNight } = await import('../src/lib/sleepAnalysis.js');
const { default: db } = await import('../src/db.js');

const CHILD = 'test-child';
const CAM = 'test-cam';
const DATE = '2026-07-01';
const TZ = 'Australia/Melbourne'; // UTC+10 in July, no DST edge to reason about
const TZ_OFF = 10 * 3600 * 1000;

// A local wall-clock time on the night of DATE (dayShift 1 = the following morning) as a UTC Date.
// `s` exists for bed transitions only — see the note on sqlTime below.
const at = (h, m, dayShift = 0, s = 0) => new Date(Date.UTC(2026, 6, 1 + dayShift, h, m, s) - TZ_OFF);

// ⚠️ THIS USED TO ZERO THE SECONDS, and that made it one of the four trap fixtures named in issue
// #263. The two tables it writes are not alike:
//   * `activity_samples.bucket_start` is genuinely always `:00` — activityTracker's minuteBucketUtc
//     writes minute buckets, so forcing it changed nothing there.
//   * `bed_transitions.created_at` carries the REAL SECOND of the event, and that is the only input
//     that distinguishes rounding a transition to the nearest minute from flooring it. Zeroing it
//     erased the discriminating input from every transition this file inserts, which is why the
//     defect in issue #260 is invisible to a 690-test suite (see the known-gap test at the end).
// It now preserves whatever `at()` was given, which is still `:00` unless a test asks otherwise — so
// every existing fixture is byte-identical, and a test that cares about seconds can now express it.
const sqlTime = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
const utcMs = (u) => new Date(u.replace(' ', 'T') + 'Z').getTime();
const hhmm = (u) =>
  u ? new Date(u.replace(' ', 'T') + 'Z').toLocaleString('en-AU', { timeZone: TZ, hour12: false, hour: '2-digit', minute: '2-digit' }) : null;

const insertSample = db.prepare(
  `INSERT INTO activity_samples (camera_id, bucket_start, motion_level, motion_peak, sound_level,
     sound_peak, motion_frames, sound_windows) VALUES (?, ?, ?, ?, 0, 0, 1, 0)`
);
const insertTransition = db.prepare(
  `INSERT INTO bed_transitions (camera_id, type, peak, created_at) VALUES (?, ?, ?, ?)`
);

// One sample per minute across [from, to). Minutes inside an `active` range carry real movement; the
// rest are the near-zero readings a quiet room produces.
// `still` is the in-bed peak on a minute with nothing happening, and it is NOT a throwaway number: it
// is the whole difference between a motionless child and an empty bed (see OCCUPANCY_MIN_PEAK).
// Measured over the 14 nights on record, max in-bed peak in the 150 min after onset: 0.0045 for the
// stillest genuine bedtime, 0.0001 for the empty room that was misreported as one. STILL_OCCUPIED sits
// between them — quiet enough to stay under MOTION_ACTIVE, alive enough to prove somebody is there.
const STILL_OCCUPIED = 0.004;
const STILL_EMPTY = 0.0002;

// Default is STILL_EMPTY, because the empty-bed tests below depend on this floor. A test asserting a
// child is actually IN the bed across a still stretch has to pass STILL_OCCUPIED and mean it.
function laySamples(from, to, activeRanges = [], still = STILL_EMPTY) {
  for (let t = from; t < to; t = new Date(t.getTime() + 60000)) {
    const moving = activeRanges.some(([a, b]) => t >= a && t < b);
    insertSample.run(CAM, sqlTime(t), moving ? 0.4 : still, moving ? 0.6 : still);
  }
}

before(() => {
  db.prepare(`INSERT INTO settings (id, timezone) VALUES ('app', ?)
              ON CONFLICT(id) DO UPDATE SET timezone = excluded.timezone`).run(TZ);
  db.prepare(`INSERT INTO children (id, name, track_sleep, sleep_window_start, sleep_window_end)
              VALUES (?, 'Test', 1, '19:30', '07:00')`).run(CHILD);
  db.prepare(`INSERT INTO cameras (id, name, rtsp_url, child_id, mediamtx_path)
              VALUES (?, 'Test Cam', 'rtsp://example/stream', ?, 'testcam')`).run(CAM, CHILD);
});

beforeEach(() => {
  db.prepare('DELETE FROM activity_samples WHERE camera_id = ?').run(CAM);
  db.prepare('DELETE FROM bed_transitions WHERE camera_id = ?').run(CAM);
});

after(() => {
  db.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('early bedtime: sleep starting before the window is measured from when it started', () => {
  // Put down at 18:38, 52 minutes before the 19:30 window opens; sleeps through, stirs once at 02:00.
  // STILL_OCCUPIED, not the default floor: the child IS in this bed, and an early bedtime now has to
  // show it (an empty room satisfies every other early-bedtime guard — that is the 2026-08-28 bug).
  laySamples(at(18, 20), at(7, 0, 1), [[at(2, 0, 1), at(2, 8, 1)]], STILL_OCCUPIED);
  insertTransition.run(CAM, 'into_bed', 0.5, sqlTime(at(18, 38)));

  const night = computeNight(CHILD, DATE);
  assert.equal(night.status, 'ok');
  // The room is already quiet when the put-down lands, so the settle IS the put-down minute.
  assert.equal(hhmm(night.onset_at), '18:38');
  assert.ok(night.onset_at < night.window_start, 'onset must precede the configured window start');
  // The counted night runs from the real onset to the window end — longer than the 690-minute window.
  const expected = Math.round((at(7, 0, 1).getTime() - new Date(night.onset_at.replace(' ', 'T') + 'Z').getTime()) / 60000);
  assert.equal(night.asleep_minutes + night.awake_minutes, expected);
  assert.ok(expected > 690, 'an early night must count MORE minutes than the window itself');
});

test('early bedtime is ignored without a put-down: a quiet room is not a sleeping child', () => {
  // Identical to the night above, minus the into_bed. Quiet alone must never move onset earlier —
  // this is the guard that stops an empty room reading as an early bedtime.
  laySamples(at(18, 20), at(7, 0, 1), [[at(2, 0, 1), at(2, 8, 1)]]);

  const night = computeNight(CHILD, DATE);
  assert.equal(hhmm(night.onset_at), '19:30', 'onset should clamp to the window start');
});

test('a nap the child woke from is not mistaken for the start of the night', () => {
  // Down at 16:45 — deliberately INSIDE the 3h lookbehind, so the nap is a real candidate that guard 2
  // has to reject, rather than one that falls out of range and passes for the wrong reason. Up again at
  // 17:30 (a qualifying awakening before the window), then the real bedtime inside the window. The
  // 02:00 stirring keeps this an ordinary occupied night — without some in-window movement the whole
  // night reads as an empty bed and onset is null, which would fail this assertion for an unrelated reason.
  laySamples(at(16, 0), at(7, 0, 1), [
    [at(17, 30), at(17, 45)],
    [at(19, 0), at(19, 25)],
    [at(2, 0, 1), at(2, 9, 1)],
  ]);
  insertTransition.run(CAM, 'into_bed', 0.5, sqlTime(at(16, 45)));

  const night = computeNight(CHILD, DATE);
  assert.equal(night.status, 'ok');
  assert.ok(night.onset_at >= night.window_start, 'the nap must not be adopted as onset');
});

test('early bedtime is ignored when those minutes were never observed', () => {
  // A put-down before the window, but sampling only starts once the window opens — so the "sleep"
  // before it is a data gap, not an observation. Unsampled minutes read as quiet, so without this
  // guard the gap itself would be claimed as sleep.
  laySamples(at(19, 30), at(7, 0, 1), [[at(19, 35), at(19, 42)], [at(2, 0, 1), at(2, 9, 1)]]);
  insertTransition.run(CAM, 'into_bed', 0.5, sqlTime(at(18, 30)));

  const night = computeNight(CHILD, DATE);
  assert.ok(night.onset_at >= night.window_start, 'must not claim sleep across an unsampled stretch');
});

test('empty bed: a night nobody slept in is reported as empty, not as perfect sleep', () => {
  // The regression this exists for: with a child away, this night scored `ok` with 11h06m asleep and
  // zero wake-ups, because an empty room is quiet and quiet reads as sleep.
  laySamples(at(19, 30), at(7, 0, 1), []);

  const night = computeNight(CHILD, DATE);
  assert.equal(night.status, 'empty');
  assert.equal(night.asleep_minutes, null, 'an empty bed must not report a duration');
  assert.equal(night.onset_at, null);
  assert.equal(night.wake_at, null);
  // Distinct from no_data: we DID watch. Coverage proves it, and drives the wording in the UI.
  assert.ok(night.coverage_minutes > 600, 'coverage must survive so empty reads differently from no_data');
});

test('empty bed does not fire for an occupied night', () => {
  // A real child stirs. The quietest occupied night on record still peaked at 0.2883 with one
  // awakening and 10 awake minutes; all three empty-bed conditions must fail here.
  laySamples(at(19, 30), at(7, 0, 1), [
    [at(19, 35), at(19, 42)],
    [at(1, 0, 1), at(1, 9, 1)],
    [at(6, 30, 1), at(7, 0, 1)],
  ]);

  const night = computeNight(CHILD, DATE);
  assert.equal(night.status, 'ok');
  assert.ok(night.wake_count > 0);
  assert.ok(night.asleep_minutes > 0);
});

// --- Promotion of the transition-derived times to authoritative -------------------------------
//
// The shape below is the real 2026-08-25 night: the child got out of bed at 05:09 and never went back,
// but a parent handled the bed later in the morning, and the movement-only rule read that as the wake.
// Ground truth confirmed 05:09, so the movement-only answer was 89 minutes late.
function layDepartureNight({ withTransition }) {
  laySamples(at(19, 30), at(7, 0, 1), [
    [at(19, 30), at(19, 40)], // settling
    [at(23, 0), at(23, 6)], // a real awakening
    [at(2, 0, 1), at(2, 8, 1)], // another
    [at(5, 0, 1), at(5, 9, 1)], // stirs, then gets out of bed
    [at(6, 45, 1), at(7, 0, 1)], // a parent handling the empty bed afterwards
  ]);
  if (withTransition) insertTransition.run(CAM, 'out_of_bed', 0.4, sqlTime(at(5, 9, 1)));
}

test('a corroborated departure becomes the authoritative wake time', () => {
  layDepartureNight({ withTransition: true });

  const night = computeNight(CHILD, DATE);
  assert.equal(night.status, 'ok');
  assert.equal(hhmm(night.wake_at), '05:09', 'the real departure, not the later bed-handling');
  // The movement-only figure is kept so the two methods stay comparable night by night.
  assert.equal(hhmm(night.wake_at_algo), '06:45');
  assert.equal(hhmm(night.wake_at_shadow), '05:09');
});

test('adopting the departure also shortens the recorded sleep', () => {
  // The point of computing the adoption BEFORE the metrics: promoting only the displayed time would
  // leave "asleep" still counting the 96 minutes after the child had already left the bed.
  layDepartureNight({ withTransition: true });
  const promoted = computeNight(CHILD, DATE);

  db.prepare('DELETE FROM bed_transitions WHERE camera_id = ?').run(CAM);
  const movementOnly = computeNight(CHILD, DATE);

  assert.ok(
    promoted.asleep_minutes < movementOnly.asleep_minutes,
    `promoted (${promoted.asleep_minutes}) must be shorter than movement-only (${movementOnly.asleep_minutes})`
  );
  // Both onset and the counted awakenings are unchanged; only the end of the night moved.
  assert.equal(promoted.onset_at, movementOnly.onset_at);
  assert.equal(promoted.wake_count, movementOnly.wake_count);
  const span = Math.round((utcMs(promoted.wake_at) - utcMs(promoted.onset_at)) / 60000);
  assert.equal(promoted.asleep_minutes + promoted.awake_minutes, span);
});

test('with nothing corroborating it, the wake falls back to the movement-only value', () => {
  // Adoption is safe by construction: no transition means exactly the old behaviour.
  layDepartureNight({ withTransition: false });

  const night = computeNight(CHILD, DATE);
  assert.equal(hhmm(night.wake_at), '06:45');
  assert.equal(night.wake_at, night.wake_at_algo, 'must be identical to the movement-only figure');
});

// --- A parent's arm in an empty bed must not hide the departure ------------------------------------
//
// The real 2026-08-29 morning (Raffa, prod). He was up for the day at 06:00 and the bed then read
// EXACTLY 0.0000 for 47 minutes — broken by two lone minutes, 06:14 at 0.018 and 06:33 at 0.449, an
// adult reaching in. Those two minutes chopped the one real absence into runs of 13, 18 and 9, none of
// them reaching MORNING_ABSENCE_MIN, so the true departure was never even offered as a candidate and
// the wake was reported at 06:47 — 47 minutes late — on the next gap long enough to qualify.
function layBlippedDepartureNight() {
  // Occupied until 06:00, empty after: one still level across a departure would assert a bed that is
  // simultaneously empty and warm, which is the fixture bug that hid this for so long.
  laySamples(at(19, 30), at(6, 0, 1), [[at(19, 30), at(19, 40)]], STILL_OCCUPIED);
  laySamples(at(6, 0, 1), at(7, 30, 1), [
    [at(6, 0, 1), at(6, 1, 1)], // getting him out
    [at(6, 14, 1), at(6, 15, 1)], // a lone reach into the empty bed
    [at(6, 33, 1), at(6, 34, 1)], // and another
    [at(6, 43, 1), at(6, 48, 1)], // stripping the bed — five minutes, not a blip
  ], STILL_EMPTY);
  insertTransition.run(CAM, 'out_of_bed', 0.4, sqlTime(at(6, 0, 1))); // the real departure
  insertTransition.run(CAM, 'out_of_bed', 0.4, sqlTime(at(6, 47, 1))); // the parent, 47 min later
}

test('a lone minute of a parent reaching in does not break the morning absence', () => {
  layBlippedDepartureNight();

  const night = computeNight(CHILD, DATE);
  assert.equal(night.status, 'ok');
  assert.equal(hhmm(night.wake_at), '06:00', 'the departure, not the bed-stripping 47 minutes later');
});

// --- An exit that is reversed was not the morning departure -----------------------------------
//
// ★ THE HOLDOUT'S BIGGEST FINDING (10 nights scored, 2026-09-09). Raffa's wake was reported HOURS
// early on four of ten nights: -121, -158, -102 and -30 minutes. The shape below is 2026-09-07.
//
// He stirred at 03:11, it registered as an out_of_bed, and he was back in bed a minute later — then
// slept so still that the bed read EMPTY (`MOTION_ACTIVE` = 0.01) right through to the real exit at
// 05:49. The gap test fired on the 03:11 exit and the night was reported as ending there.
//
// ⚠️ Measured, so nobody re-derives it: across those four false gaps the bed is 80-84% of minutes
// below 0.0005 and only 3-7% above 0.01, while Renz's spans run 21-24% above 0.01. Raffa is the
// stiller sleeper, which is why it hit him on four nights and Renz on none. Lowering the empty-bed
// threshold to OCCUPANCY_MIN_PEAK does NOT separate them — micro-motion is 13-15% of Raffa's false
// gaps and 13-18% of Renz's correct ones.
//
// What DOES separate them is already in the data and was being ignored: the into_bed one to three
// minutes later. The bound is not a new constant — MORNING_ABSENCE_MIN is the absence the rule
// requires, so a return inside it contradicts the very claim being made. On the real nights the false
// returns were 1-3 minutes and the true exit's next into_bed was 69.
// ⚠️ STILL_OCCUPIED until the real exit, and it is load-bearing, not decoration. The child IS in this
// bed from the stir until 05:49, so the bed carries occupancy-level micro-motion — which is precisely
// what the guard demands before it will believe the return. A fixture using the empty-bed floor would
// describe a bed nobody is in and would (correctly) not be treated as a reversal at all.
function layReversedExitNight() {
  laySamples(at(19, 30), at(5, 52, 1), [
    [at(19, 30), at(19, 40)], // settling
    [at(3, 11, 1), at(3, 13, 1)], // the stir: out of bed and straight back in
    [at(5, 49, 1), at(5, 52, 1)], // the real morning exit
  ], STILL_OCCUPIED);
  laySamples(at(5, 52, 1), at(7, 0, 1), [], STILL_EMPTY); // gone: the bed reads empty afterwards
  insertTransition.run(CAM, 'out_of_bed', 0.045, sqlTime(at(3, 11, 1)));
  insertTransition.run(CAM, 'into_bed', 0.023, sqlTime(at(3, 12, 1))); // back in bed one minute later
  insertTransition.run(CAM, 'out_of_bed', 0.039, sqlTime(at(5, 49, 1))); // the real departure
}

test('★ an exit reversed a minute later is not the morning departure', () => {
  layReversedExitNight();

  const night = computeNight(CHILD, DATE);
  assert.equal(night.status, 'ok');
  assert.equal(hhmm(night.wake_at), '05:49', 'the real exit, not the 03:11 stir he came straight back from');
});

test('★★ a spurious into_bed over an EMPTY bed does not cancel a real departure', () => {
  // ★★★ THE ADVERSARIAL REVIEW'S FINDING, and the reason the guard demands corroboration.
  //
  // The first version trusted the bare transition row. This night is a genuine 05:09 departure — bed
  // empty for the rest of the window — followed by a classifier-invented into_bed six minutes later
  // with NO occupancy behind it. Trusting it rejected the real departure, the scan found no later
  // candidate, and the night reported wake_at = NULL: "still asleep" for a child who had plainly got
  // up. That is worse than the bug the guard exists to fix, which at least produced a wrong time.
  //
  // 62% of this classifier's transitions are provably wrong (same type twice running), so an
  // uncorroborated into_bed is its documented failure mode rather than a contrived input.
  laySamples(at(19, 30), at(5, 9, 1), [[at(19, 30), at(19, 40)], [at(5, 0, 1), at(5, 9, 1)]], STILL_OCCUPIED);
  laySamples(at(5, 9, 1), at(7, 0, 1), [], STILL_EMPTY); // gone, and the bed reads empty
  insertTransition.run(CAM, 'out_of_bed', 0.04, sqlTime(at(5, 9, 1))); // the real departure
  insertTransition.run(CAM, 'into_bed', 0.02, sqlTime(at(5, 15, 1))); // noise: nobody actually returned

  const night = computeNight(CHILD, DATE);
  assert.equal(night.status, 'ok');
  assert.equal(hhmm(night.wake_at), '05:09', 'an into_bed with an empty bed behind it is not a return');
  assert.ok(night.wake_at, 'and the night must not come back as "still asleep"');
});

// ★★ THE BOUNDARY ITSELF, both sides. The adversarial review found the guard's window had no test
// anywhere between 20 and 69 minutes: a mutant widening it to 50 minutes survived a green suite, as
// did narrowing it to 2. MORNING_ABSENCE_MIN is shared with the absence-length threshold and has
// already been retuned once (10 -> 20), so a future retune would silently move this window with
// nothing catching it. These two pin the edge rather than a comfortable distance from it.
const layReturnAfter = (mins) => {
  laySamples(at(19, 30), at(5, 52, 1), [
    [at(19, 30), at(19, 40)],
    [at(3, 11, 1), at(3, 13, 1)],
    [at(5, 49, 1), at(5, 52, 1)],
  ], STILL_OCCUPIED);
  laySamples(at(5, 52, 1), at(7, 0, 1), [], STILL_EMPTY);
  insertTransition.run(CAM, 'out_of_bed', 0.045, sqlTime(at(3, 11, 1)));
  insertTransition.run(CAM, 'into_bed', 0.023, sqlTime(at(3, 11 + mins, 1)));
  insertTransition.run(CAM, 'out_of_bed', 0.039, sqlTime(at(5, 49, 1)));
};

test('★★ a return at exactly MORNING_ABSENCE_MIN still cancels the exit', () => {
  layReturnAfter(20); // 20 minutes exactly — the boundary is inclusive
  assert.equal(hhmm(computeNight(CHILD, DATE).wake_at), '05:49');
});

test('★★ a return one minute past it does not', () => {
  layReturnAfter(21); // 21 minutes — outside the absence being claimed, so the exit stands
  assert.equal(hhmm(computeNight(CHILD, DATE).wake_at), '03:11');
});

test('★★ the occupancy witness window is CAPPED, not open to the end of the night', () => {
  // ⚠️ A review found that removing `Math.min(from + OCCUPANCY_WITNESS_MIN, totalMinExt)` — letting the
  // window run to the end of the timeline — survived the whole suite. Nothing pinned the cap, which is
  // the same boundary the index-convention defect lived on.
  //
  // Here the child stirs at 03:11 and does NOT come back: the bed is empty from 03:13 onwards, and the
  // only occupancy in the night sits far past the witness window, in the morning after a parent puts
  // him down again. Uncapped, that distant occupancy would corroborate the 03:12 return and cancel a
  // departure that really happened.
  laySamples(at(19, 30), at(3, 13, 1), [[at(19, 30), at(19, 40)], [at(3, 11, 1), at(3, 13, 1)]], STILL_OCCUPIED);
  laySamples(at(3, 13, 1), at(6, 30, 1), [], STILL_EMPTY); // gone — and 197 min is well past the 150-min window
  laySamples(at(6, 30, 1), at(7, 30, 1), [], STILL_OCCUPIED); // put back down long afterwards
  insertTransition.run(CAM, 'out_of_bed', 0.045, sqlTime(at(3, 11, 1)));
  insertTransition.run(CAM, 'into_bed', 0.023, sqlTime(at(3, 12, 1)));

  const night = computeNight(CHILD, DATE);
  assert.equal(hhmm(night.wake_at), '03:11', 'occupancy 197 minutes later must not vouch for the return');
});

test('★ but an exit is NOT disqualified by a return long afterwards', () => {
  // The guard must not eat the correct answer. On the same real night an into_bed followed the true
  // 05:49 exit at 06:58 — 69 minutes later, comfortably outside the absence the rule requires. A rule
  // that rejected any exit with a later into_bed anywhere in the quiet run would break this night
  // while "fixing" the one above, so both directions are pinned.
  laySamples(at(19, 30), at(7, 30, 1), [
    [at(19, 30), at(19, 40)],
    [at(5, 49, 1), at(5, 52, 1)], // the real exit
    [at(6, 58, 1), at(7, 2, 1)], // put back down for a morning nap, over an hour later
  ]);
  insertTransition.run(CAM, 'out_of_bed', 0.039, sqlTime(at(5, 49, 1)));
  insertTransition.run(CAM, 'into_bed', 0.09, sqlTime(at(6, 58, 1)));

  const night = computeNight(CHILD, DATE);
  assert.equal(night.status, 'ok');
  assert.equal(hhmm(night.wake_at), '05:49', 'a return 69 minutes later says nothing about the 05:49 exit');
});

// --- ...and the exit AFTER that return is the same movement, not a second departure ---------------
//
// ★★★ The guard above tests ONE transition, but the classifier's failure arrives as a CLUSTER. Real,
// prod, 2026-09-09 — the owner reported it ("he got out but went back to bed a few minutes later"):
//
//     out_of_bed 20:41:30 | into_bed 20:43:57 | out_of_bed 20:44:36 | (nothing until 05:17)
//
// The guard above correctly rejects 20:41:30. Then 20:44:36 — 39 seconds after the return, and
// reversed by nothing, because nothing follows it — corroborates the very gap the return falsified.
// Raffa's bed reads EXACTLY 0.0000 for the eleven hours after, so the gap passes every length test on
// its own terms. Reported: **wake 20:41, asleep 1h15m.** The guard above bought three minutes.
//
// Proved by ablation on a prod snapshot: deleting that one 20:44:36 row and nothing else moves the
// night to 05:17 and 9h51m.
//
// ⚠️ The fixture below is the real transition stream to the second, because THE SECONDS ARE THE INPUT.
// A fixture on whole minutes would put the return and its tail in the same minute bucket and could not
// express the gap this rule measures at all.
function laySettlingTailNight(tailSeconds) {
  laySamples(at(19, 30), at(5, 52, 1), [
    [at(19, 30), at(19, 40)], // settling — the put-down
    [at(20, 41), at(20, 46)], // ONE movement: out of bed and straight back in
    [at(5, 49, 1), at(5, 52, 1)], // the real morning exit
  ], STILL_OCCUPIED); // he is IN this bed all night, just very still — see STILL_OCCUPIED
  laySamples(at(5, 52, 1), at(7, 0, 1), [], STILL_EMPTY); // gone: the bed reads empty afterwards
  insertTransition.run(CAM, 'out_of_bed', 0.041, sqlTime(at(20, 41, 0, 30)));
  insertTransition.run(CAM, 'into_bed', 0.07, sqlTime(at(20, 43, 0, 57))); // the return, 2m27s later
  // The tail. `tailSeconds` is measured from the RETURN, so a test can sit either side of the bound.
  insertTransition.run(CAM, 'out_of_bed', 0.048, sqlTime(new Date(at(20, 43, 0, 57).getTime() + tailSeconds * 1000)));
  insertTransition.run(CAM, 'out_of_bed', 0.039, sqlTime(at(5, 49, 1))); // the real departure
}

test('★★★ the exit 39 seconds after a return is the same movement — prod 2026-09-09', () => {
  laySettlingTailNight(39);

  const night = computeNight(CHILD, DATE);
  assert.equal(night.status, 'ok');
  assert.equal(hhmm(night.wake_at), '05:49', 'the real exit, not the tail of him climbing back in');
  // The number the owner actually sees. Without the fix this night reports 75 minutes of sleep, and
  // asserting only on wake_at would let a change that fixes the time but not the night pass.
  assert.ok(night.asleep_minutes > 500, `a full night, not an evening: got ${night.asleep_minutes} min`);
});

// ★★ THE BOUNDARY, both sides, one second apart. JITTER_REENTRY_MS is 60s because that is the
// resolution of every observation that could contradict it — activity_samples is bucketed per minute.
// ⚠️ These two are the only thing pinning that bound: a mutant widening it to 10 minutes would
// otherwise sail through, and widening it is exactly what breaks the 2026-08-31 Renz night (a REAL
// exit 34 seconds after a return — see the constant's own comment: the populations overlap).
test('★★ a tail at exactly JITTER_REENTRY_MS is still the same movement', () => {
  laySettlingTailNight(60); // 60s exactly — the boundary is inclusive
  assert.equal(hhmm(computeNight(CHILD, DATE).wake_at), '05:49');
});

test('★★ one second past it, the exit stands', () => {
  laySettlingTailNight(61); // 61s — outside the bound, so this is a departure like any other
  assert.equal(hhmm(computeNight(CHILD, DATE).wake_at), '20:44');
});

test('★★ a spurious into_bed does NOT let this guard eat a real departure', () => {
  // ★★★ The same corroboration lesson as the guard above, and the same reason: without it, this rule
  // is a NEW way to report `wake_at = null` — "still asleep" for a child who plainly got up — which is
  // worse than the wrong time it exists to fix. 62% of this classifier's transitions are provably
  // wrong, so an invented into_bed is its documented failure mode, not a contrived input.
  //
  // Here the child genuinely leaves at 05:50, and the classifier emits an into_bed 30 seconds earlier
  // with NOTHING behind it — the bed is empty from 05:50 onward, so only one minute in the witness
  // window carries occupancy, under OCCUPANCY_MIN_MINUTES. The return is not believed, and the exit
  // stands. There is deliberately no later out_of_bed: if the guard fired, the scan would find no
  // other candidate and the night would come back as "still asleep".
  laySamples(at(19, 30), at(5, 49, 1), [[at(19, 30), at(19, 40)]], STILL_OCCUPIED);
  laySamples(at(5, 49, 1), at(5, 50, 1), [[at(5, 49, 1), at(5, 50, 1)]], STILL_OCCUPIED); // climbing out
  laySamples(at(5, 50, 1), at(7, 0, 1), [], STILL_EMPTY); // gone, and the bed reads empty
  insertTransition.run(CAM, 'into_bed', 0.02, sqlTime(at(5, 49, 1, 40))); // noise: nobody returned
  insertTransition.run(CAM, 'out_of_bed', 0.04, sqlTime(at(5, 50, 1, 10))); // the real departure

  const night = computeNight(CHILD, DATE);
  assert.equal(night.status, 'ok');
  assert.ok(night.wake_at, 'the night must not come back as "still asleep"');
  assert.equal(hhmm(night.wake_at), '05:50', 'an into_bed with an empty bed behind it is not a return');
});

test('a run of active minutes is NOT bridged — only isolated ones are', () => {
  // The counterpart to the test above, and the reason bridging is safe: TWO consecutive minutes of
  // movement is a person at the bed, not a passing arm, and must still end an absence.
  //
  // Deliberately sitting one minute under the threshold rather than comfortably clear of it. An earlier
  // version of this test used a five-minute run against a thirteen-minute absence — an eight-minute
  // margin — and an implementation that happily bridged runs of two, three or FOUR consecutive minutes
  // passed it, along with every other test in the repo. The invariant the whole change rests on had no
  // coverage at all. Here the absence from 06:01 is 19 minutes against a threshold of 20, so bridging
  // the pair at 06:20 is the difference between reporting 06:00 and reporting 06:22.
  laySamples(at(19, 30), at(6, 0, 1), [[at(19, 30), at(19, 40)]], STILL_OCCUPIED);
  laySamples(at(6, 0, 1), at(7, 30, 1), [
    [at(6, 0, 1), at(6, 1, 1)], // getting him out
    [at(6, 20, 1), at(6, 22, 1)], // exactly two consecutive minutes: a person, not a blip
  ], STILL_EMPTY);
  insertTransition.run(CAM, 'out_of_bed', 0.4, sqlTime(at(6, 0, 1)));
  insertTransition.run(CAM, 'out_of_bed', 0.4, sqlTime(at(6, 22, 1)));

  assert.equal(hhmm(computeNight(CHILD, DATE).wake_at), '06:22', 'the 19-minute absence must not qualify');
});

test('the last minute of the timeline cannot pad an absence to length', () => {
  // `bridged` looks at both neighbours, and at the final minute of the extended timeline the right-hand
  // one does not exist. Reading past the end yields undefined, which is falsy — so without a bounds
  // guard that last minute counts as isolated, gets bridged, and a 19-minute absence measures 20.
  // MORNING_ABSENCE_MIN is then cleared on a minute of evidence that was never observed.
  //
  // The window is 19:30-07:00 and the scan runs three hours past it, so the timeline's last minute is
  // 09:59. The room is busy from 06:30 to 09:40, which disqualifies the real 06:00 departure on trailing
  // activity; then exactly 19 quiet minutes, then that final active minute.
  laySamples(at(19, 30), at(6, 0, 1), [[at(19, 30), at(19, 40)]], STILL_OCCUPIED);
  laySamples(at(6, 0, 1), at(10, 0, 1), [
    [at(6, 0, 1), at(6, 1, 1)],
    [at(6, 30, 1), at(9, 40, 1)], // a busy morning room
    [at(9, 59, 1), at(10, 0, 1)], // the very last minute of the timeline
  ], STILL_EMPTY);
  insertTransition.run(CAM, 'out_of_bed', 0.4, sqlTime(at(6, 0, 1)));
  insertTransition.run(CAM, 'out_of_bed', 0.4, sqlTime(at(9, 40, 1)));

  const night = computeNight(CHILD, DATE);
  assert.equal(
    night.wake_at, night.wake_at_algo,
    'nothing corroborated: the wake must fall back to the movement-only figure, not adopt 09:40'
  );
});

test('a departure INSIDE a bridged absence is still found', () => {
  // Bridging makes absences longer, and a longer absence can contain a later, better candidate. The
  // scan therefore reconsiders every minute the bed falls quiet rather than stepping over a whole
  // absence once it has looked at its start. Measured 2026-08-25 on prod data: without this, bridging
  // joined the night into one 431-minute absence from 23:57 that swallowed the true 05:09 departure
  // whole, and the wake came back at 07:09 — two hours late.
  //
  // Here the isolated blip at 02:00 joins the sleeping hours into one long absence; the real departure
  // at 05:09 sits inside it and must still win.
  laySamples(at(19, 30), at(5, 9, 1), [
    [at(19, 30), at(19, 40)],
    [at(2, 0, 1), at(2, 1, 1)], // one isolated minute mid-sleep
  ], STILL_OCCUPIED);
  laySamples(at(5, 9, 1), at(7, 30, 1), [[at(5, 9, 1), at(5, 10, 1)]], STILL_EMPTY);
  insertTransition.run(CAM, 'out_of_bed', 0.4, sqlTime(at(5, 9, 1)));

  assert.equal(hhmm(computeNight(CHILD, DATE).wake_at), '05:09');
});

test('a night with too few samples is no_data, not empty', () => {
  // Coverage gates confidence and is checked first: "we could not see" must never be reported as
  // "nobody was in the bed".
  laySamples(at(19, 30), at(21, 0), []);

  const night = computeNight(CHILD, DATE);
  assert.equal(night.status, 'no_data');
});

// --- Household noise vs. the child's own stillness -------------------------------------------------
//
// A bedroom mic hears the whole house, and bedtime is the loudest part of the evening. Sound travels
// through walls; movement does not. These cover the rule that falls out of that (see
// ONSET_SOUND_MOTION_WITHIN_MIN) and, just as importantly, the two places it must NOT reach.

const insertFull = db.prepare(
  `INSERT INTO activity_samples (camera_id, bucket_start, motion_level, motion_peak, sound_level,
     sound_peak, motion_frames, sound_windows, motion_out_level, motion_out_peak)
   VALUES (?, ?, ?, ?, 0, ?, 1, 1, 0, ?)`
);

// One sample per minute across [from, to), driving each channel independently — which `laySamples`
// can't do, since it moves motion and sound together and every interesting case here pulls them apart.
//   move  = real movement in the bed        noise = a clear sound with NOTHING moving
//   out   = movement outside the bed (someone in the room, or the child out of it)
function layNight(from, to, { move = [], noise = [], out = [], still = STILL_OCCUPIED } = {}) {
  const within = (t, ranges) => ranges.some(([a, b]) => t >= a && t < b);
  for (let t = from; t < to; t = new Date(t.getTime() + 60000)) {
    insertFull.run(
      CAM, sqlTime(t),
      within(t, move) ? 0.4 : still,
      within(t, move) ? 0.4 : still,
      within(t, noise) ? 20 : 0.5,
      within(t, out) ? 0.3 : 0.0004
    );
  }
}

test('a still child in a noisy house is asleep once a put-down proves they are in bed', () => {
  // The real 2026-08-26 night: down at 18:38, then motionless while the house stays loud for another
  // hour (the other child's bedtime, through the wall). Owner-confirmed asleep from the put-down; the
  // movement-only rule reported onset an hour late because it counted every one of those minutes awake.
  layNight(at(18, 20), at(7, 0, 1), { noise: [[at(18, 40), at(19, 40)]] });
  insertTransition.run(CAM, 'into_bed', 0.5, sqlTime(at(18, 38)));

  const night = computeNight(CHILD, DATE);
  assert.equal(night.status, 'ok');
  assert.equal(hhmm(night.onset_at), '18:38', 'noise with nothing moving must not hold onset back');
});

test('household noise alone cannot invent a bedtime without a put-down', () => {
  // The same stillness-plus-noise, but no into_bed — and someone is plainly in the room at 20:00.
  // Discounting sound here would call the child asleep at 19:30, before they were even in the bed.
  // (Renz, 2026-08-21: movement in the room until ~20:00; an earlier cut of this change said 19:00.)
  // This is why the discount is scoped to the put-down-anchored search: quiet is not evidence of a
  // child, which is the same lesson EMPTY_BED_MAX_PEAK exists for.
  layNight(at(18, 20), at(7, 0, 1), {
    noise: [[at(19, 30), at(20, 0)]],
    move: [[at(20, 0), at(20, 5)]],
  });

  const night = computeNight(CHILD, DATE);
  assert.equal(hhmm(night.onset_at), '20:05', 'onset must wait for the room to actually settle');
});

test('a child who cries without moving still counts as an awakening', () => {
  // The discount is deliberately confined to onset. Mid-night the house is quiet, so noise in a bedroom
  // is most likely the child's own — and a cry with no movement is precisely the wake-up a parent wants
  // counted. If this ever fails, the rule has leaked out of the onset search into wake detection.
  layNight(at(18, 20), at(7, 0, 1), { noise: [[at(2, 0, 1), at(2, 10, 1)]] });
  insertTransition.run(CAM, 'into_bed', 0.5, sqlTime(at(18, 38)));

  const night = computeNight(CHILD, DATE);
  assert.equal(night.wake_count, 1, 'a sound-only cry is still a wake-up');
  assert.ok(night.awake_minutes >= 10);
});

// --- What the timeline is allowed to claim ---------------------------------------------------------

// A night with the shape real ones have: settling, a few stirs, a departure at 05:09, then a parent
// handling the empty bed. Stirring matters — a bed with NO in-bed movement at all is an empty bed, and
// the morning departure needs a sustained empty gap to sit at the end of.
function layTimelineNight({ out = [] } = {}) {
  layNight(at(18, 20), at(7, 0, 1), {
    move: [
      [at(19, 30), at(19, 40)],
      [at(23, 0), at(23, 6)],
      [at(2, 0, 1), at(2, 8, 1)],
      [at(5, 0, 1), at(5, 9, 1)],
      [at(6, 45, 1), at(7, 0, 1)],
    ],
    out,
  });
  insertTransition.run(CAM, 'into_bed', 0.5, sqlTime(at(18, 38)));
  insertTransition.run(CAM, 'out_of_bed', 0.4, sqlTime(at(5, 9, 1)));
}

test('the timeline draws only the two transitions the analysis adopted', () => {
  // A child rolling over reads as an arrival to the frame-diff classifier, so a normal night produces a
  // stream of them: on 2026-08-26 Renz's timeline showed FOUR "got into bed" markers with no "got out of
  // bed" between any of them — impossible — on a night nobody entered his room. Only the put-down that
  // began the sleep and the corroborated morning exit may be drawn.
  layTimelineNight();
  for (const h of [22, 23]) insertTransition.run(CAM, 'into_bed', 0.03, sqlTime(at(h, 12)));
  for (const h of [1, 2]) insertTransition.run(CAM, 'into_bed', 0.03, sqlTime(at(h, 12, 1)));

  const night = computeNight(CHILD, DATE, { includeTimeline: true });
  assert.equal(night.transitions.length, 2, 'exactly one put-down and one departure');
  assert.deepEqual(night.transitions.map((t) => t.type), ['into_bed', 'out_of_bed']);
  assert.equal(hhmm(night.transitions[0].at), '18:38', 'the put-down that started the sleep');
  assert.equal(hhmm(night.transitions[1].at), '05:09', 'the corroborated departure');
});

test('the timeline is drawn over the sleep, not over the configured window', () => {
  // Bedtimes move nightly and nobody is going to edit the setting each evening, so a night that began
  // before the window must still be shown whole. Raffa, 2026-08-26: put down at 19:11, window opens
  // 19:30 — the put-down and his mother leaving the room were both detected, then clipped off the left
  // edge of a bar that started at the setting.
  layTimelineNight({ out: [[at(18, 38), at(18, 48)]] });

  const night = computeNight(CHILD, DATE, { includeTimeline: true });
  assert.equal(hhmm(night.display_start), '18:38', 'the bar starts at the put-down');
  assert.ok(night.display_start < night.window_start, 'and therefore before the window opens');
  assert.equal(night.segments[0].from_at, night.display_start, 'segments must cover the bar');
  assert.ok(
    night.visits.some((v) => hhmm(v.start_at) === '18:38'),
    'the parent settling them, before the window, must be shown rather than clipped'
  );
});

test('movement while the child is in bed is not reported as the child being out of bed', () => {
  // Two blocks of outside-the-bed movement: a parent in the room mid-sleep, and the child themselves
  // after the morning departure. Only the second is the child out of bed — the camera cannot tell who is
  // moving, so in between it may only say that something moved.
  layTimelineNight({ out: [[at(1, 0, 1), at(1, 5, 1)], [at(6, 0, 1), at(6, 5, 1)]] });

  const night = computeNight(CHILD, DATE, { includeTimeline: true });
  const typeAt = (hm) => night.visits.find((v) => hhmm(v.start_at) === hm)?.type;
  assert.equal(typeAt('01:00'), 'room', 'mid-sleep movement must not be attributed to the child');
  assert.equal(typeAt('06:00'), 'child_out', 'after the departure it really is the child');
});

test('the parent walking away at bedtime is not the morning departure', () => {
  // Found on production within the hour 0.26.0 shipped, on a camera whose bed registers very little
  // movement overnight. Raffa was put down at 19:11, his mother left at 19:20, he was asleep by 19:23 —
  // and the empty-bed gap that opens AT onset was corroborated by that three-minutes-EARLIER out_of_bed,
  // which sits inside the snap window. The night came back "woke 19:20, slept 0h00m".
  //
  // Reproducing it needs the same shape: so little in-bed motion that the gap starting at onset passes
  // the trailing-activity test, and an out_of_bed just before onset. The gap already had to begin at or
  // after onset; the snap window reaching backwards past it was the hole.
  layNight(at(18, 20), at(7, 0, 1), {
    move: [[at(5, 0, 1), at(5, 9, 1)]],
    out: [[at(18, 38), at(18, 48)]],
  });
  insertTransition.run(CAM, 'into_bed', 0.5, sqlTime(at(18, 38)));
  insertTransition.run(CAM, 'out_of_bed', 0.4, sqlTime(at(18, 47))); // the parent leaving, NOT a wake
  insertTransition.run(CAM, 'out_of_bed', 0.4, sqlTime(at(5, 9, 1))); // the real morning departure

  const night = computeNight(CHILD, DATE);
  assert.equal(hhmm(night.onset_at), '18:48');
  assert.equal(hhmm(night.wake_at), '05:09', 'the morning exit, not the parent leaving at bedtime');
  assert.ok(night.asleep_minutes > 500, `a full night, not ${night.asleep_minutes} minutes`);
});

// --- Bedtime after the window opens (the ordinary case) ---------------------------------------------

// `layNight` drives the outside channel at 0.3 — plainly a person. `layNightOut` is the same but lets a
// test pick the magnitude, so the marginal readings that produced false "movement outside the bed"
// blocks can be reproduced.
function layNightOut(from, to, { move = [], noise = [], out = [], still = STILL_OCCUPIED } = {}, outPeak = 0.3) {
  const within = (t, ranges) => ranges.some(([a, b]) => t >= a && t < b);
  for (let t = from; t < to; t = new Date(t.getTime() + 60000)) {
    insertFull.run(
      CAM, sqlTime(t),
      within(t, move) ? 0.4 : still,
      within(t, move) ? 0.4 : still,
      within(t, noise) ? 20 : 0.5,
      within(t, out) ? outPeak : 0.0004
    );
  }
}

test('a put-down AFTER the window opens still gets the benefit of the sound rule', () => {
  // The bug this exists for: the sound-witness rule was only ever reachable from the early-bedtime
  // path, which required the child to have settled BEFORE the window opened. Every ordinary bedtime —
  // window 19:30, asleep 19:41 — fell through to the raw search and was held back by household noise.
  // Prod 2026-08-27: Renz went down at 19:13 and was reported asleep at 19:52, 39 minutes late.
  //
  // Down at 19:38, still by 19:41, and the house loud until 20:25 with NOTHING moving in his room.
  layNightOut(at(18, 20), at(7, 0, 1), {
    move: [[at(19, 38), at(19, 41)]],
    noise: [[at(19, 45), at(20, 25)]],
  });
  insertTransition.run(CAM, 'into_bed', 0.5, sqlTime(at(19, 38)));

  const night = computeNight(CHILD, DATE);
  assert.equal(night.status, 'ok');
  assert.equal(hhmm(night.onset_at), '19:41', 'onset must follow the put-down, not the end of the noise');
});

test('a mid-night re-settle can never become the night bedtime', () => {
  // The put-down anchor walks every into_bed, so a 2am re-settle has a qualifying quiet run after it
  // just as the evening one does. Only the "earlier than the plain search" test stops it being adopted
  // as the night's onset — without it, a night whose evening put-down failed its guards would report
  // bedtime at 2am.
  layNightOut(at(18, 20), at(7, 0, 1), {
    move: [[at(19, 20), at(20, 5)], [at(2, 0, 1), at(2, 5, 1)]],
  });
  insertTransition.run(CAM, 'into_bed', 0.5, sqlTime(at(2, 5, 1)));

  const night = computeNight(CHILD, DATE);
  assert.equal(hhmm(night.onset_at), '20:05', 'the evening settle, not the 2am re-settle');
});

test('household noise just after bedtime is not the first awakening', () => {
  // The seam between the two rules. Once onset correctly ignores the other child's bedtime next door,
  // the very same sound-only minutes get picked up moments later as this child's first wake-up —
  // measured on prod 2026-08-27, where fixing Renz's onset invented a 10-minute "wake" at 19:21.
  // Nothing moved in this room at all; the noise is through the wall.
  layNightOut(at(18, 20), at(7, 0, 1), {
    move: [[at(19, 38), at(19, 41)]],
    noise: [[at(20, 0), at(20, 12)]],
  });
  insertTransition.run(CAM, 'into_bed', 0.5, sqlTime(at(19, 38)));

  const night = computeNight(CHILD, DATE);
  assert.equal(hhmm(night.onset_at), '19:41');
  assert.equal(night.wake_count, 0, 'noise with nothing moving, minutes after falling asleep, is not a wake');
});

test('the grace is a grace, not a licence: the same noise later IS a wake', () => {
  // Guard on the test above. Past POST_ONSET_SOUND_WITNESS_MIN the plain rule returns, because
  // mid-night the house is quiet and a noise in a bedroom is most likely the child's own.
  layNightOut(at(18, 20), at(7, 0, 1), {
    move: [[at(19, 38), at(19, 41)]],
    noise: [[at(21, 0), at(21, 12)]],
  });
  insertTransition.run(CAM, 'into_bed', 0.5, sqlTime(at(19, 38)));

  const night = computeNight(CHILD, DATE);
  assert.equal(night.wake_count, 1, 'a cry an hour later is a wake-up, discount or no discount');
});

test('the onset marker is the START of the settling episode, not the last re-settle', () => {
  // A child put down, fussing, and re-settled logs an into_bed each time. The bedtime a parent would
  // name is when that episode began. Drawing the last one reported 19:19 for a 19:10 put-down
  // (2026-08-26 Raffa — and 19:19 was actually his mother leaving, misread as an arrival); drawing the
  // earliest that passes the onset guards reported the first attempt on a night with several.
  layNightOut(at(18, 20), at(7, 0, 1), { move: [[at(19, 20), at(19, 41)]] });
  insertTransition.run(CAM, 'into_bed', 0.5, sqlTime(at(17, 0))); // hours earlier — a different episode
  insertTransition.run(CAM, 'into_bed', 0.5, sqlTime(at(19, 20)));
  insertTransition.run(CAM, 'into_bed', 0.5, sqlTime(at(19, 26)));
  insertTransition.run(CAM, 'into_bed', 0.5, sqlTime(at(19, 33)));

  const night = computeNight(CHILD, DATE, { includeTimeline: true });
  const into = night.transitions.filter((t) => t.type === 'into_bed');
  assert.equal(into.length, 1, 'exactly one put-down marker is drawn');
  assert.equal(hhmm(into[0].at), '19:20', 'the start of the episode');
});

test('a marginal outside reading is not reported as movement outside the bed', () => {
  // Every false "movement outside the bed" block on record came from a reading barely over the old
  // 0.01: 0.010-0.023 on nights the owner confirmed nobody entered either room, against 0.07-1.0 for
  // real events. The outside area is most of the frame, so it collects far more incidental change
  // (IR gain, a shadow) than the small bed rectangle does.
  layNightOut(at(18, 20), at(7, 0, 1), {
    move: [[at(19, 38), at(19, 41)]],
    out: [[at(1, 0, 1), at(1, 3, 1)]],
  }, 0.02);
  insertTransition.run(CAM, 'into_bed', 0.5, sqlTime(at(19, 38)));

  const night = computeNight(CHILD, DATE, { includeTimeline: true });
  assert.equal(night.visits.length, 0, 'a 0.02 outside reading is noise, not someone in the room');
});

test('a real outside reading still is', () => {
  // Guard on the test above — the floor must not silence the channel it exists to clean up.
  layNightOut(at(18, 20), at(7, 0, 1), {
    move: [[at(19, 38), at(19, 41)]],
    out: [[at(1, 0, 1), at(1, 3, 1)]],
  }, 0.10);
  insertTransition.run(CAM, 'into_bed', 0.5, sqlTime(at(19, 38)));

  const night = computeNight(CHILD, DATE, { includeTimeline: true });
  assert.equal(night.visits.length, 1);
  assert.equal(hhmm(night.visits[0].start_at), '01:00');
});

test('a stray put-down over an empty bed cannot become the bedtime', () => {
  // Raffa, 2026-08-28, reported asleep at 16:56 when he actually went to bed at 19:51 — 2h55m early.
  // A stray into_bed at 16:52 was undone by an out_of_bed 23 seconds later and the room then sat empty
  // until his real bedtime. Every existing guard passed, and passed for the same reason: an empty room
  // is quiet, an empty room never wakes, and an empty room still yields samples. The household noise
  // that would have broken the quiet run was discounted by ONSET_SOUND_MOTION_WITHIN_MIN — which is
  // correct behaviour once a put-down proves the child is in the bed, and is exactly why a FALSE
  // put-down disables every safeguard at once. Only positive evidence of occupancy separates them.
  layNight(at(16, 30), at(19, 51), { noise: [[at(17, 0), at(19, 30)]], still: STILL_EMPTY });
  layNight(at(19, 51), at(7, 0, 1), { move: [[at(19, 51), at(19, 58)]], still: STILL_OCCUPIED });
  insertTransition.run(CAM, 'into_bed', 0.076, sqlTime(at(16, 52)));
  insertTransition.run(CAM, 'out_of_bed', 0.016, sqlTime(at(16, 53)));
  insertTransition.run(CAM, 'into_bed', 0.121, sqlTime(at(19, 51)));

  const night = computeNight(CHILD, DATE);
  assert.equal(night.status, 'ok');
  assert.ok(
    hhmm(night.onset_at) >= '19:30',
    `onset ${hhmm(night.onset_at)} came from the stray afternoon put-down, not the real bedtime`
  );
});

test('a genuinely still child is still occupied: the empty-bed guard must not eat a real bedtime', () => {
  // The other side of the guard above, and the reason its floor is 0.002 rather than something safer-
  // sounding. Raffa under a blanket is the stillest bed on record — max in-bed peak 0.0045 across the
  // 150 minutes after onset. A guard set anywhere above that would report NO bedtime on a real night.
  layNight(at(18, 20), at(7, 0, 1), { move: [[at(19, 30), at(19, 40)]], still: 0.0045 });
  insertTransition.run(CAM, 'into_bed', 0.121, sqlTime(at(19, 38)));

  const night = computeNight(CHILD, DATE);
  assert.equal(night.status, 'ok');
  assert.equal(hhmm(night.onset_at), '19:40', 'the stillest real bed on record must still read as occupied');
});

test('a single blip in an empty room is not evidence the bed is occupied', () => {
  // THE PROD ESCAPE, 2026-08-29. The first cut of the empty-bed guard thresholded the MAXIMUM in-bed
  // peak over the window. It passed its tests and an A/B over 26 staging nights, shipped in 0.27.0, and
  // did nothing at all on prod: the same empty room had recorded ONE minute at 0.0045 — a shadow, or
  // the night-vision adjusting — which cleared a maximum-based bar on its own.
  //
  // Staging and prod run independent detectors against the same cameras, so they are not the same data.
  // The rule now counts MINUTES of movement, because an empty room blips and an occupied one keeps
  // moving. Here: one blip in an otherwise dead room must not rescue the stray 16:52 put-down.
  layNight(at(16, 30), at(19, 51), { noise: [[at(17, 0), at(19, 30)]], still: STILL_EMPTY });
  insertFull.run(CAM, sqlTime(at(17, 30)), 0.0045, 0.0045, 0.5, 0.0004); // the one blip
  layNight(at(19, 51), at(7, 0, 1), { move: [[at(19, 51), at(19, 58)]], still: STILL_OCCUPIED });
  insertTransition.run(CAM, 'into_bed', 0.076, sqlTime(at(16, 52)));
  insertTransition.run(CAM, 'out_of_bed', 0.016, sqlTime(at(16, 53)));
  insertTransition.run(CAM, 'into_bed', 0.121, sqlTime(at(19, 51)));

  const night = computeNight(CHILD, DATE);
  assert.equal(night.status, 'ok');
  assert.ok(
    hhmm(night.onset_at) >= '19:30',
    `onset ${hhmm(night.onset_at)} — one blip in an empty room was treated as an occupied bed`
  );
});

test('a child who moves just three times in two and a half hours still counts as present', () => {
  // The other edge, and why the threshold is 3 rather than something more comfortable. The quietest
  // genuine bedtime on record (Raffa, under a blanket) shows only 5 qualifying minutes in the window;
  // a guard set much higher would report NO bedtime on a real night. Three movements must be enough.
  layNight(at(18, 20), at(7, 0, 1), { move: [[at(19, 30), at(19, 40)]], still: STILL_EMPTY });
  for (const m of [55, 70, 95]) {
    insertFull.run(CAM, sqlTime(new Date(at(19, 40).getTime() + m * 60000)), 0.001, 0.001, 0.5, 0.0004);
  }
  insertTransition.run(CAM, 'into_bed', 0.121, sqlTime(at(19, 38)));

  const night = computeNight(CHILD, DATE);
  assert.equal(night.status, 'ok');
  assert.equal(hhmm(night.onset_at), '19:40', 'three small movements is a child, not an empty bed');
});

// -------------------------------------------------------------------------------------------
describe('⚠️ seconds on a bed transition — the trap fixture, and the gap it was hiding (#260, #263)', () => {
  // `sqlTime` above used to force `:00` onto every timestamp it wrote. For activity_samples that was
  // harmless (they really are minute buckets); for bed_transitions it erased the real second of the
  // event — the ONLY input that can tell rounding a transition to the nearest minute from flooring it.
  // That is trap #4 of the four named in issue #263, and the reason issue #260 is invisible to this
  // suite: the fix for #260 is a single word (`Math.round` -> `Math.floor` in `txIdx`) and applying it
  // leaves every other test in this file green.
  //
  // The fixture is repaired here. The DEFECT is deliberately NOT fixed in this PR: it moves reported
  // bedtimes by a minute, and the detection holdout running to ~2026-09-09 is scoring exactly those
  // times against ground truth. So the current behaviour is pinned instead, loudly, and the test that
  // WILL fail when #260 lands is written out below ready to swap in.
  const onsetForPutDownAt = (seconds) => {
    db.prepare('DELETE FROM activity_samples WHERE camera_id = ?').run(CAM);
    db.prepare('DELETE FROM bed_transitions WHERE camera_id = ?').run(CAM);
    // The same night as the early-bedtime test above: quiet from 18:20, one stir at 02:00. The room is
    // already still when the put-down lands, so onset IS the put-down minute — which makes the minute
    // index the transition resolves to directly observable in the reported time.
    laySamples(at(18, 20), at(7, 0, 1), [[at(2, 0, 1), at(2, 8, 1)]], STILL_OCCUPIED);
    insertTransition.run(CAM, 'into_bed', 0.5, sqlTime(at(18, 38, 0, seconds)));
    return hhmm(computeNight(CHILD, DATE).onset_at);
  };

  test('the fixture can now carry a real second — without this the rest of the block is untestable', () => {
    // Asserted rather than assumed: if sqlTime ever goes back to zeroing seconds, this fails FIRST and
    // says why, instead of the tests below quietly passing for the wrong reason.
    assert.equal(sqlTime(at(18, 38, 0, 31)), '2026-07-01 08:38:31', 'sqlTime is discarding the seconds again');
    assert.equal(sqlTime(at(18, 38)), '2026-07-01 08:38:00', 'the default is still a whole minute');
  });

  test('a put-down at :29 and one at :31 are in the SAME minute', () => {
    // The control for the pin below. Both timestamps are 18:38 by every reading a person would make;
    // if these ever stop being the same wall-clock minute the pin is meaningless.
    assert.equal(sqlTime(at(18, 38, 0, 29)).slice(0, 16), sqlTime(at(18, 38, 0, 31)).slice(0, 16));
  });

  test('★ STILL NOT FIXED (#260): the second half of a minute reports a minute late', () => {
    // ⚠️ WHEN #260 IS FIXED THIS TEST FAILS, AND THAT IS ITS JOB. Replace it with:
    //
    //     assert.equal(onsetForPutDownAt(31), onsetForPutDownAt(29),
    //       'the reported bedtime must not depend on which half of the minute the put-down fell in');
    //
    // ...and delete this comment. The error is one-directional — rounding only ever pushes up — so
    // bedtime is late, never early, on roughly half of all nights, and asleep_minutes is short by one.
    assert.equal(onsetForPutDownAt(29), '18:38', 'the first half of the minute already reports late');
    assert.equal(
      onsetForPutDownAt(31),
      '18:39',
      'a put-down at :31 no longer reports a minute late — #260 appears to be FIXED. ' +
        'Swap this test for the equality assertion in the comment above and close the issue.'
    );
  });
});
