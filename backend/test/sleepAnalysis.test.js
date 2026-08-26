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

import { test, before, after, beforeEach } from 'node:test';
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
const at = (h, m, dayShift = 0) => new Date(Date.UTC(2026, 6, 1 + dayShift, h, m) - TZ_OFF);
const sqlTime = (d) => d.toISOString().slice(0, 19).replace('T', ' ').replace(/:\d\d$/, ':00');
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
function laySamples(from, to, activeRanges = []) {
  for (let t = from; t < to; t = new Date(t.getTime() + 60000)) {
    const moving = activeRanges.some(([a, b]) => t >= a && t < b);
    insertSample.run(CAM, sqlTime(t), moving ? 0.4 : 0.0002, moving ? 0.6 : 0.0004);
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
  laySamples(at(18, 20), at(7, 0, 1), [[at(2, 0, 1), at(2, 8, 1)]]);
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
function layNight(from, to, { move = [], noise = [], out = [] } = {}) {
  const within = (t, ranges) => ranges.some(([a, b]) => t >= a && t < b);
  for (let t = from; t < to; t = new Date(t.getTime() + 60000)) {
    insertFull.run(
      CAM, sqlTime(t),
      within(t, move) ? 0.4 : 0.0002,
      within(t, move) ? 0.4 : 0.0002,
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
