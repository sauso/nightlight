// The night's stored facts: `stir_minutes` and `summary_facts` (sleep score plan, phase 1a).
//
// Why they exist: a later sleep score and night summary need two things that can only be worked out from the
// per-minute samples, and those are deleted after 30 days. So they are counted when the night is computed and stored
// with it (sleepAnalysis.js, "THE NIGHT'S STORED FACTS"). Nothing reads them yet.
//
// What this file pins, one line per claim the PR makes:
//   - a stir minute is IN-BED movement only: a noise, or movement elsewhere in the room, is not one, although the
//     detail view still draws both as a 'stir' segment (that label is broader, and unchanged);
//   - a minute inside a counted wake, an unwatched minute and the first 30 minutes after onset are not counted;
//   - `summary_facts.sleep.wakes` is the COUNTED wakes, so its length is always `wake_count`, also where the detail
//     view's own list is longer (the morning-wake row) or stretches its last row;
//   - `room_activity_wakes` counts the wakes with movement outside the bed within 3 minutes of them;
//   - `climate` is the night's temperature range, null members when there was no reading;
//   - both are stored, re-stored, and read back through the routes with the names and values a fresh compute has;
//   - "no one was in the bed" clears the stir count and the sleep facts and keeps the temperature range; a night a
//     parent promoted from `empty` has none; a time correction leaves both as the detector measured them;
//   - ★ NO EXISTING FIGURE MOVED: every other key of computeNight's result, in order, and every other stored column,
//     is byte for byte what the code before this change produced for the same nights (GOLDEN, below).
//
// ★ HOSTILE FIXTURE (the builder is sleep-faulty-mic.test.js's): every row is written through a column list read
// from the schema, and every column the analysis does NOT read carries a decoy saying the opposite of the scenario
// (a still minute carries a high MEAN motion). A stir count that read the wrong motion column would count every
// still minute and fail here. A column added to activity_samples later fails the builder until it is classified.
//
// ⚠️ The camera and child fixtures are neutral on purpose: the repo is public.

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, signToken, mountRouter, call } from './helpers/harness.js';

useTempDataDir();

const { default: db } = await import('../src/db.js');
const { computeNight, computeAndStoreNight, parseSummaryFacts, lastCompletedNightDate, currentNightDate } =
  await import('../src/lib/sleepAnalysis.js');
const { applyCorrection, saveNightReview } = await import('../src/lib/sleepReviews.js');
const { TRANSITION } = await import('../src/lib/bedTransitions.js');
const { default: childrenRouter } = await import('../src/routes/children.js');

const CHILD = 'nf-child';
const CAM = 'nf-cam';
const DATE = '2026-07-01';
const TZ = 'Australia/Melbourne'; // UTC+10 in July, no DST edge near the fixture night
const TZ_OFF = 10 * 3600 * 1000;

const at = (h, m, dayShift = 0, s = 0) => new Date(Date.UTC(2026, 6, 1 + dayShift, h, m, s) - TZ_OFF);
const sqlTime = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
const hhmm = (u) =>
  u ? new Date(u.replace(' ', 'T') + 'Z').toLocaleString('en-AU', { timeZone: TZ, hour12: false, hour: '2-digit', minute: '2-digit' }) : null;
const json = (v) => JSON.parse(JSON.stringify(v)); // what a client actually receives
const omit = (o, ...keys) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));
const noon = () => at(12, 0, 1).getTime(); // the next day's noon: past the 3 h evidence horizon, so the night is final
const minute = (h, m, dayShift = 0) => [at(h, m, dayShift), at(h, m + 1, dayShift)];

const NEW_KEYS = ['stir_minutes', 'summary_facts'];

// Sleep-analysis fixture levels (sleepAnalysis.test.js explains them): an occupied still bed sits above
// OCCUPANCY_MIN_PEAK and under MOTION_ACTIVE (0.01); an empty one under both.
const STILL_OCCUPIED = 0.004;
const STILL_EMPTY = 0.0002;
const BED_MOVE = 0.4; // in-bed peak, far over MOTION_ACTIVE
const ROOM_MOVE = 0.3; // outside-the-bed peak, far over MOTION_OUT_ACTIVE (0.03)
const ROOM_STILL = 0.0004;
const NOISE = [25, 12]; // [sound_peak, sound_p75]: a sustained, real sound (p75 raised), over SOUND_ACTIVE (6)
const QUIET = [0.5, 0.2];

// ---- the hostile row builder ---------------------------------------------------------------------------------
const SAMPLE_COLUMNS = db.prepare('PRAGMA table_info(activity_samples)').all().map((c) => c.name);
const AUTO_COLUMNS = new Set(['id', 'created_at']);
// What computeNight reads, from the scenario.
const READ_COLUMNS = new Set(['camera_id', 'bucket_start', 'motion_peak', 'motion_out_peak', 'sound_peak', 'sound_p75', 'motion_frames']);
// What it does not read: each a decoy.
const DECOY_COLUMNS = new Set(['motion_level', 'motion_out_level', 'sound_level', 'sound_p90', 'sound_sd', 'sound_windows']);
const unclassified = SAMPLE_COLUMNS.filter((c) => !AUTO_COLUMNS.has(c) && !READ_COLUMNS.has(c) && !DECOY_COLUMNS.has(c));
assert.deepEqual(unclassified, [], `activity_samples has column(s) this fixture has not classified: ${unclassified.join(', ')}`);
const WRITTEN = SAMPLE_COLUMNS.filter((c) => !AUTO_COLUMNS.has(c));
const insertRow = db.prepare(
  `INSERT INTO activity_samples (${WRITTEN.join(', ')}) VALUES (${WRITTEN.map((c) => `@${c}`).join(', ')})`
);
// One row. `bed`: in-bed movement. `room`: movement outside the bed. `noise`: a real sound. `frames: 0` is an
// UNWATCHED row (sleepAnalysis.js motionSeen): it exists, and the camera delivered no video in it.
function writeMinute(t, { bed = false, room = false, noise = false, still = STILL_OCCUPIED, frames = 300 } = {}) {
  const [peak, p75] = noise ? NOISE : QUIET;
  insertRow.run({
    camera_id: CAM,
    bucket_start: sqlTime(t),
    motion_peak: bed ? BED_MOVE : still,
    motion_out_peak: room ? ROOM_MOVE : ROOM_STILL,
    sound_peak: peak,
    sound_p75: p75,
    motion_frames: frames,
    // Decoys: a still minute carries a high MEAN in both motion channels and a loud mean sound, a moving or noisy
    // one the reverse.
    motion_level: bed ? 0 : 0.5,
    motion_out_level: room ? 0 : 0.5,
    sound_level: noise ? 0 : 20,
    sound_p90: noise ? 0 : 30,
    sound_sd: noise ? 0 : 20,
    sound_windows: 300,
  });
}
const inAny = (t, ranges) => ranges.some(([a, b]) => t >= a && t < b);
// One row per minute across [from, to). Each of bed / room / noise / unwatched is a list of [start, end) ranges.
function layNight({ from = at(16, 30), to = at(10, 0, 1), bed = [], room = [], noise = [], unwatched = [], still = () => STILL_OCCUPIED } = {}) {
  for (let t = from; t < to; t = new Date(t.getTime() + 60000)) {
    writeMinute(t, {
      bed: inAny(t, bed), room: inAny(t, room), noise: inAny(t, noise),
      frames: inAny(t, unwatched) ? 0 : 300, still: still(t),
    });
  }
}
const insertTransition = (type, when) =>
  db.prepare('INSERT INTO bed_transitions (camera_id, type, peak, created_at) VALUES (?, ?, 0.4, ?)').run(CAM, type, sqlTime(when));
const insertReading = (temperature, humidity, when) =>
  db.prepare('INSERT INTO sensor_readings (camera_id, temperature, humidity, created_at) VALUES (?, ?, ?, ?)')
    .run(CAM, temperature, humidity, sqlTime(when));
const clearNight = () => {
  for (const t of ['activity_samples', 'bed_transitions', 'sensor_readings', 'sleep_nights', 'sleep_reviews']) db.prepare(`DELETE FROM ${t}`).run();
};
const storedRow = (date = DATE) => db.prepare('SELECT * FROM sleep_nights WHERE child_id = ? AND night_date = ?').get(CHILD, date);

// The plain night every stir test starts from: settled 19:40 (so the 30-minute grace ends 20:10), up from 06:00 with
// the movement running to the window's close. Nothing in between, so its stir count is 0 and each test adds one thing.
const PUT_DOWN = [at(19, 30), at(19, 40)];
const MORNING = [at(6, 0, 1), at(7, 0, 1)];
const WAKE_23 = [at(23, 0), at(23, 6)]; // six minutes of in-bed movement: a counted wake
const WAKE_02 = [at(2, 0, 1), at(2, 8, 1)]; // eight: another

// nightWith is called several times in one test, and a test's clock can only be mocked once.
const frozen = new WeakSet();
function nightWith(t, opts = {}, { includeTimeline = false } = {}) {
  if (!frozen.has(t)) {
    t.mock.timers.enable({ apis: ['Date'], now: noon() });
    frozen.add(t);
  }
  clearNight();
  layNight({ ...opts, bed: [PUT_DOWN, MORNING, ...(opts.bed || [])] });
  const night = computeNight(CHILD, DATE, { includeTimeline });
  assert.equal(night.status, 'ok', 'precondition: a scored night');
  assert.equal(hhmm(night.onset_at), '19:40', 'precondition: settled at 19:40, so the grace ends at 20:10');
  return night;
}
const facts = (night) => {
  const parsed = parseSummaryFacts(night.summary_facts);
  assert.ok(parsed, `summary_facts must parse: ${JSON.stringify(night.summary_facts)}`);
  return parsed;
};
// The detail view's label for one minute, from its run-length segments.
const segmentAt = (night, when) => {
  const s = sqlTime(when);
  return night.segments.find((g) => g.from_at <= s && s < g.to_at)?.state;
};

let server;
let adminToken;
const get = (path) => call(`${server.url}/api/children/${CHILD}${path}`, { token: adminToken });

before(async () => {
  db.prepare(`INSERT INTO settings (id, timezone) VALUES ('app', ?)
              ON CONFLICT(id) DO UPDATE SET timezone = excluded.timezone`).run(TZ);
  const admin = makeUser(db, { id: 'u-a', username: 'admin', role: 'admin' });
  adminToken = signToken({ sub: admin.id, sid: makeSession(db, admin.id), role: 'admin', username: 'admin' });
  server = await mountRouter('/api/children', childrenRouter);
});
beforeEach(() => {
  clearNight();
  for (const t of ['cameras', 'children']) db.prepare(`DELETE FROM ${t}`).run();
  db.prepare(`INSERT INTO children (id, name, track_sleep, sleep_window_start, sleep_window_end)
              VALUES (?, 'Facts Kid', 1, '19:30', '07:00')`).run(CHILD);
  db.prepare(`INSERT INTO cameras (id, name, rtsp_url, child_id, mediamtx_path, sort_order, disabled)
              VALUES (?, 'Bed cam', 'rtsp://example/x', ?, 'p', 0, 0)`).run(CAM, CHILD);
});
after(async () => {
  await server?.close();
  db.close();
  cleanupTempDataDirs();
});

// =====================================================================================================
describe('stir_minutes: in-bed movement in the sleep span, outside a counted wake', () => {
  test('a quiet night has none; in-bed movement short of a wake is counted minute by minute', (t) => {
    // Fails if the count reads the MEAN motion column (the decoy: every still minute would count), or only counts
    // isolated minutes, or treats any run of movement as a wake.
    assert.equal(nightWith(t).stir_minutes, 0, 'the plain night: 0, a number and not null');
    assert.equal(nightWith(t, { bed: [minute(2, 0, 1)] }).stir_minutes, 1);
    // Four moving minutes in a row: under WAKE_ACTIVE_MIN (5), so stirring and not a wake.
    const run = nightWith(t, { bed: [[at(2, 0, 1), at(2, 4, 1)]] });
    assert.equal(run.wake_count, 0, 'precondition: four minutes is not a wake');
    assert.equal(run.stir_minutes, 4);
  });

  test('a sound-only minute is NOT a stir, though the detail view still labels it one', (t) => {
    // Fails if the criterion is widened to "any active minute" (the detail label's rule): that counts 1 here.
    const night = nightWith(t, { noise: [minute(2, 0, 1)] }, { includeTimeline: true });
    assert.equal(segmentAt(night, at(2, 0, 1)), 'stir', 'precondition: the minute IS active, and the timeline says so (label unchanged)');
    assert.equal(night.stir_minutes, 0, 'household noise must not read as a restless child');
  });

  test('a minute with movement only OUTSIDE the bed is NOT a stir, though the detail view still labels it one', (t) => {
    // Fails if the criterion takes in the outside channel (`motionAt`, "real movement in the bed or not").
    const night = nightWith(t, { room: [minute(2, 0, 1)] }, { includeTimeline: true });
    assert.equal(segmentAt(night, at(2, 0, 1)), 'stir', 'precondition: the minute IS active, and the timeline says so (label unchanged)');
    assert.equal(night.stir_minutes, 0, 'someone walking through the room is not the child stirring');
  });

  test('in-bed movement counts whatever else the minute held', (t) => {
    const night = nightWith(t, { bed: [minute(2, 0, 1)], room: [minute(2, 0, 1)], noise: [minute(2, 0, 1)] });
    assert.equal(night.stir_minutes, 1);
  });

  test('minutes inside a counted wake are not stirs', (t) => {
    // Fails if the wake test is dropped from the count: the six moving minutes would be six stirs as well.
    const night = nightWith(t, { bed: [WAKE_23] });
    assert.deepEqual([night.wake_count, night.awake_minutes], [1, 6], 'precondition: one wake of six minutes');
    assert.equal(night.stir_minutes, 0, 'its six moving minutes are awake time, not stirring as well');
  });

  test('movement after the child is up is not a stir: the count stops where the sleep ends', (t) => {
    // Awake from 06:30, out of the bed at 06:45, and one more movement in the bed at 06:55 (someone straightening
    // it). That minute is after the wake and in no counted wake. Fails if the count runs to the window's end.
    t.mock.timers.enable({ apis: ['Date'], now: noon() });
    layNight({ bed: [PUT_DOWN, [at(6, 30, 1), at(6, 45, 1)], minute(6, 55, 1)], still: (m) => (m >= at(6, 45, 1) ? STILL_EMPTY : STILL_OCCUPIED) });
    insertTransition(TRANSITION.OUT_OF_BED, at(6, 45, 1, 20));
    const night = computeNight(CHILD, DATE);
    assert.equal(hhmm(night.wake_at), '06:45', 'precondition: the departure is the wake, so 06:55 is after the sleep');
    assert.equal(night.stir_minutes, 0);
  });

  test('an unwatched minute is not a stir, whatever its row says', (t) => {
    // The row exists and carries an in-bed peak of 0.4, but the camera delivered no video in it (motion_frames 0),
    // so nothing was seen: it is an unknown minute, never movement.
    const night = nightWith(t, { bed: [minute(2, 0, 1)], unwatched: [minute(2, 0, 1)] });
    assert.equal(night.unknown_minutes, 1, 'precondition: the minute is unwatched');
    assert.equal(night.stir_minutes, 0);
  });

  test('the 30 minutes after onset are not counted: 20:09 is inside the grace, 20:10 is the first minute outside', (t) => {
    // Onset 19:40, so the grace covers 19:40 to 20:09 inclusive. The literal 30 is the point: the expected minutes
    // are written out here, not derived from the constant the code reuses.
    assert.equal(nightWith(t, { bed: [minute(20, 9)] }).stir_minutes, 0, 'the last minute of the grace');
    assert.equal(nightWith(t, { bed: [minute(20, 10)] }).stir_minutes, 1, 'the first minute after it');
  });

  test('a stir after the window, before a late departure, is counted (the post-window span)', (t) => {
    // The child sleeps past 07:00, stirs at 07:05, moves from 07:40 and is out at 07:50: the metrics span runs to
    // 07:50 (issue #352), and the stir at 07:05 lies in the part read by the second query.
    t.mock.timers.enable({ apis: ['Date'], now: noon() });
    const late = (extra, unwatched = []) => {
      clearNight();
      layNight({ bed: [PUT_DOWN, [at(7, 40, 1), at(7, 50, 1)], ...extra], unwatched });
      insertTransition(TRANSITION.OUT_OF_BED, at(7, 50, 1, 30));
      const night = computeNight(CHILD, DATE);
      assert.equal(hhmm(night.wake_at), '07:50', 'precondition: the post-window departure is the wake');
      return night;
    };
    assert.equal(late([]).stir_minutes, 0);
    assert.equal(late([minute(7, 5, 1)]).stir_minutes, 1);
    assert.equal(late([minute(7, 5, 1)], [minute(7, 5, 1)]).stir_minutes, 0, 'and an unwatched row there is not one, as inside the window');
  });

});

// =====================================================================================================
describe('summary_facts.sleep: the counted wakes', () => {
  test('wakes are the counted ones, with their start and length: wakes.length === wake_count, not the detail list', (t) => {
    const night = nightWith(t, { bed: [WAKE_23, WAKE_02] }, { includeTimeline: true });
    assert.equal(night.wake_count, 2);
    assert.deepEqual(facts(night).sleep.wakes, [
      { start_at: sqlTime(at(23, 0)), minutes: 6 },
      { start_at: sqlTime(at(2, 0, 1)), minutes: 8 },
    ]);
    // The detail view's own list adds a row for the morning wake (06:00 to the window's end), so it is one longer.
    // Persisting THAT list would store three wakes beside a wake_count of two.
    assert.equal(night.wakes.length, 3, 'precondition: the detail list has the morning-wake row');
    assert.equal(hhmm(night.wakes[2].start_at), '06:00');
    assert.equal(facts(night).sleep.wakes.length, night.wake_count);
  });

  test('the base compute carries the same facts as the detail compute', (t) => {
    const detail = nightWith(t, { bed: [WAKE_23, WAKE_02], room: [WAKE_02] }, { includeTimeline: true });
    const plain = computeNight(CHILD, DATE);
    // Fails if the facts are built inside the detail-only block (the card and the nightly store use the base compute).
    assert.equal(facts(detail).sleep.wakes.length, 2, 'precondition: there are facts to carry');
    assert.equal(plain.summary_facts, detail.summary_facts);
  });

  test('bridged wake gaps: an on-and-off wake is ONE entry, as long as the wake that was counted', (t) => {
    const night = nightWith(t, { bed: [[at(23, 0), at(23, 2)], [at(23, 4), at(23, 7)]] });
    assert.equal(night.wake_count, 1);
    assert.deepEqual(facts(night).sleep.wakes, [{ start_at: sqlTime(at(23, 0)), minutes: 7 }]);
    assert.equal(facts(night).sleep.wakes[0].minutes, night.awake_minutes);
  });

  test('a wake that runs up to the departure is stored at its counted length, not the stretched detail row', (t) => {
    // Awake from 06:30, out of the bed at 06:45, the room quiet afterwards. The counted wake is 06:30 to 06:45
    // (15 minutes, inside the sleep span). The detail list stretches that same row to the window's end so an alert
    // at the moment of getting up has a row to attach to.
    t.mock.timers.enable({ apis: ['Date'], now: noon() });
    layNight({ bed: [PUT_DOWN, [at(6, 30, 1), at(6, 45, 1)]], still: (m) => (m >= at(6, 45, 1) ? STILL_EMPTY : STILL_OCCUPIED) });
    insertTransition(TRANSITION.OUT_OF_BED, at(6, 45, 1, 20));
    const night = computeNight(CHILD, DATE, { includeTimeline: true });
    assert.equal(hhmm(night.wake_at), '06:45', 'precondition: the departure is the wake');
    assert.equal(night.wake_count, 1);
    assert.deepEqual(facts(night).sleep.wakes, [{ start_at: sqlTime(at(6, 30, 1)), minutes: 15 }]);
    assert.equal(night.wakes.length, 1, 'precondition: the detail list merged the morning into this row');
    assert.equal(night.wakes[0].minutes, 30, 'precondition: and stretched it to the window end');
  });

  test('a midnight episode (out of the bed and back, bridged into a wake) is in the list like any counted wake', (t) => {
    // sleepAnalysis.test.js "midnight episode integration": out at 20:41:30, back at 20:43:57, out again 20:44:36.
    t.mock.timers.enable({ apis: ['Date'], now: at(10, 0, 1).getTime() });
    const wake = at(5, 49, 1);
    layNight({ from: at(19, 30), to: wake, bed: [PUT_DOWN, [at(20, 44), at(20, 46)], [new Date(wake.getTime() - 60000), wake]] });
    layNight({ from: wake, to: at(10, 0, 1), still: () => STILL_EMPTY });
    insertTransition(TRANSITION.OUT_OF_BED, wake);
    const before = computeNight(CHILD, DATE);
    assert.equal(before.wake_count, 0, 'precondition: without the transitions there is no wake');
    assert.deepEqual(facts(before).sleep.wakes, []);
    insertTransition(TRANSITION.OUT_OF_BED, at(20, 41, 0, 30));
    insertTransition(TRANSITION.INTO_BED, at(20, 43, 0, 57));
    insertTransition(TRANSITION.OUT_OF_BED, at(20, 44, 0, 36));
    const night = computeNight(CHILD, DATE);
    assert.equal(night.wake_count, 1, 'precondition: the episode is a counted wake');
    assert.equal(facts(night).sleep.wakes.length, 1);
    assert.equal(facts(night).sleep.wakes[0].start_at, sqlTime(at(20, 41)));
    assert.equal(facts(night).sleep.wakes[0].minutes, night.awake_minutes);
  });
});

// =====================================================================================================
describe('summary_facts.sleep.room_activity_wakes', () => {
  test('counts the wakes with movement outside the bed during them, and only those', (t) => {
    assert.equal(facts(nightWith(t, { bed: [WAKE_23, WAKE_02] })).sleep.room_activity_wakes, 0, 'two wakes, nobody in the room');
    assert.equal(facts(nightWith(t, { bed: [WAKE_23, WAKE_02], room: [WAKE_02] })).sleep.room_activity_wakes, 1, 'one of the two');
    assert.equal(facts(nightWith(t, { bed: [WAKE_23, WAKE_02], room: [WAKE_23, WAKE_02] })).sleep.room_activity_wakes, 2, 'both');
  });

  test('room activity away from any wake is not counted', (t) => {
    // Someone in the room for four minutes at 04:00, three hours from the nearest wake: that is a visit on the
    // timeline, and no wake has room activity around it.
    const night = nightWith(t, { bed: [WAKE_23], room: [[at(4, 0, 1), at(4, 4, 1)]] });
    assert.equal(night.wake_count, 1, 'precondition: the visit did not become a wake');
    assert.equal(facts(night).sleep.room_activity_wakes, 0);
  });

  test('the margin: room activity up to 3 minutes before or after a wake counts, further away does not', (t) => {
    // An ordinary wake cannot show the margin: movement outside the bed is itself activity, so within 3 minutes of
    // a wake it is bridged INTO the wake (WAKE_GAP_MIN). A midnight episode's wake is set from the bed transitions
    // (20:41 to 20:44 here, three minutes) and is not grown by nearby activity, so the margin is visible on it.
    t.mock.timers.enable({ apis: ['Date'], now: at(10, 0, 1).getTime() });
    const wake = at(5, 49, 1);
    const episode = (room) => {
      clearNight();
      layNight({ from: at(19, 30), to: wake, bed: [PUT_DOWN, [at(20, 44), at(20, 46)], [new Date(wake.getTime() - 60000), wake]], room });
      layNight({ from: wake, to: at(10, 0, 1), still: () => STILL_EMPTY });
      insertTransition(TRANSITION.OUT_OF_BED, wake);
      insertTransition(TRANSITION.OUT_OF_BED, at(20, 41, 0, 30));
      insertTransition(TRANSITION.INTO_BED, at(20, 43, 0, 57));
      insertTransition(TRANSITION.OUT_OF_BED, at(20, 44, 0, 36));
      const night = computeNight(CHILD, DATE);
      assert.deepEqual(facts(night).sleep.wakes, [{ start_at: sqlTime(at(20, 41)), minutes: 3 }], `precondition: the wake is 20:41 to 20:44 (room ${JSON.stringify(room)})`);
      return facts(night).sleep.room_activity_wakes;
    };
    assert.equal(episode([]), 0, 'no room activity');
    assert.equal(episode([minute(20, 38)]), 1, 'three minutes before the wake starts: inside the margin');
    assert.equal(episode([minute(20, 37)]), 0, 'four minutes before: outside it');
    // The wake's last minute is 20:43, so the three minutes after it are 20:44, 20:45 and 20:46.
    assert.equal(episode([minute(20, 46)]), 1, 'the third minute after the wake ends: inside the margin');
    assert.equal(episode([minute(20, 47)]), 0, 'the fourth: outside it');
  });
});

// =====================================================================================================
describe('summary_facts.climate: the night\'s temperature range', () => {
  test('min and max in degrees C over the night\'s readings', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: noon() });
    layNight({ bed: [PUT_DOWN, MORNING] });
    insertReading(21.26, 48, at(21, 0));
    insertReading(18.94, 50, at(3, 0, 1));
    insertReading(20.1, 49, at(5, 0, 1));
    insertReading(30, 49, at(12, 0)); // before the window: not this night's
    const night = computeNight(CHILD, DATE);
    assert.deepEqual(facts(night).climate, { temp_min: 18.9, temp_max: 21.3 });
    assert.deepEqual([night.climate.temp_min, night.climate.temp_max], [18.9, 21.3], 'the same figures the night\'s climate reports');
  });

  test('no readings: both members null, and the sleep facts are still there', (t) => {
    const night = nightWith(t, { bed: [WAKE_23] });
    assert.equal(night.climate, null, 'precondition: no sensor');
    assert.deepEqual(facts(night), { v: 1, climate: { temp_min: null, temp_max: null }, sleep: { wakes: [{ start_at: sqlTime(at(23, 0)), minutes: 6 }], room_activity_wakes: 0 } });
  });

});

// =====================================================================================================
describe('parseSummaryFacts', () => {
  test('reads the stored text; anything it cannot vouch for is null', () => {
    const good = '{"v":1,"climate":{"temp_min":null,"temp_max":null},"sleep":null}';
    assert.deepEqual(parseSummaryFacts(good), { v: 1, climate: { temp_min: null, temp_max: null }, sleep: null });
    // null: a night stored before the column. Broken text and a JSON `null`: must not throw. Another version, or
    // none: a shape this code was not written for.
    for (const bad of [null, 'not json', 'null', '{"v":2,"sleep":null}', '{"sleep":null}']) {
      assert.equal(parseSummaryFacts(bad), null, JSON.stringify(bad));
    }
  });
});

// =====================================================================================================
describe('stored beside the night, and read back with the same names and values', () => {
  const layRich = () => {
    layNight({ bed: [PUT_DOWN, MORNING, WAKE_23, minute(2, 0, 1), minute(3, 0, 1)], room: [WAKE_23] });
    insertReading(21.5, 48, at(23, 0));
    insertReading(19, 50, at(4, 0, 1));
  };
  const RICH_FACTS = {
    v: 1,
    climate: { temp_min: 19, temp_max: 21.5 },
    sleep: { wakes: [{ start_at: sqlTime(at(23, 0)), minutes: 6 }], room_activity_wakes: 1 },
  };

  test('a store writes both columns as computed; a re-store replaces them', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: noon() });
    layRich();
    const fresh = computeNight(CHILD, DATE);
    assert.equal(fresh.stir_minutes, 2);
    assert.deepEqual(facts(fresh), RICH_FACTS);
    computeAndStoreNight(CHILD, DATE);
    const row = storedRow();
    assert.equal(row.stir_minutes, 2);
    assert.equal(row.summary_facts, fresh.summary_facts, 'the stored text IS the fresh compute\'s, byte for byte');

    // The night is computed again with more in it (a provisional night re-stored by the job): the ON CONFLICT half
    // must replace both, or the facts would describe an earlier pass than the numbers beside them.
    writeMinute(at(4, 30, 1), { bed: true });
    for (let m = at(1, 0, 1); m < at(1, 7, 1); m = new Date(m.getTime() + 60000)) writeMinute(m, { bed: true });
    const again = computeAndStoreNight(CHILD, DATE);
    assert.equal(again.stored, true);
    assert.equal(storedRow().stir_minutes, 3);
    assert.equal(storedRow().wake_count, 2);
    assert.deepEqual(JSON.parse(storedRow().summary_facts).sleep.wakes.map((w) => hhmm(w.start_at)), ['23:00', '01:00']);
  });

  test('a night with no measured sleep stores NULL stir (never 0), and facts only where the room was measured', (t) => {
    // Fails if the keys are missing from an early return (the store throws "Missing named parameter"), if a night
    // with no sleep stores 0 stirring (which would read as a perfectly still night), or if an empty night drops
    // the temperature range.
    t.mock.timers.enable({ apis: ['Date'], now: noon() });
    assert.equal(computeAndStoreNight(CHILD, DATE).status, 'no_data', 'precondition: no samples at all');
    assert.deepEqual([storedRow().stir_minutes, storedRow().summary_facts], [null, null]);
    layNight({ still: () => STILL_EMPTY });
    insertReading(19.5, 52, at(23, 0));
    assert.equal(computeAndStoreNight(CHILD, DATE).status, 'empty', 'precondition: watched all night, nobody in the bed');
    assert.equal(storedRow().stir_minutes, null);
    assert.deepEqual(JSON.parse(storedRow().summary_facts), { v: 1, climate: { temp_min: 19.5, temp_max: 19.5 }, sleep: null });
  });

  test('the routes return them: /sleep?nights, /sleep/:date (fresh and ?stored=1) and /sleep/live', async () => {
    layRich();
    const stored = computeAndStoreNight(CHILD, DATE);
    assert.equal(stored.status, 'ok', 'precondition');
    const check = (night, where) => {
      assert.equal(night.stir_minutes, 2, `${where}: stir_minutes`);
      assert.equal(typeof night.summary_facts, 'string', `${where}: summary_facts is the JSON text`);
      assert.deepEqual(JSON.parse(night.summary_facts), RICH_FACTS, `${where}: summary_facts`);
    };
    check((await get('/sleep?nights=14')).body.nights[0], '/sleep?nights (stored row)');
    check((await get(`/sleep/${DATE}?stored=1`)).body.night, '/sleep/:date?stored=1 (stored row)');
    check((await get(`/sleep/${DATE}`)).body, '/sleep/:date (fresh)');
    check((await get(`/sleep/${DATE}?detail=1`)).body, '/sleep/:date?detail=1 (fresh)');

    // /sleep/live answers "tonight so far" whenever the real clock is inside the child's window, and serves a saved
    // row only for the child's LAST COMPLETED night (#683). So, as nobody-in-bed.test.js does: move the window to
    // start two hours from now (no night in progress), and move the saved row onto the real last night's date.
    const hNow = Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
    const hh = (h) => `${String(h % 24).padStart(2, '0')}:00`;
    db.prepare('UPDATE children SET sleep_window_start = ?, sleep_window_end = ? WHERE id = ?').run(hh(hNow + 2), hh(hNow + 3), CHILD);
    assert.equal(currentNightDate(CHILD), null, 'precondition: no night in progress');
    db.prepare('UPDATE sleep_nights SET night_date = ? WHERE child_id = ? AND night_date = ?').run(lastCompletedNightDate(CHILD), CHILD, DATE);
    const live = (await get('/sleep/live')).body;
    assert.equal(live.scope, 'last');
    check(live.night, '/sleep/live (stored row)');
  });
});

// =====================================================================================================
describe('corrections', () => {
  const layRich = () => {
    layNight({ bed: [PUT_DOWN, MORNING, WAKE_23, minute(2, 0, 1)] });
    insertReading(21.5, 48, at(23, 0));
  };

  test('"no one was in the bed": the stir count and the sleep facts are cleared, the temperature range is kept', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: noon() });
    layRich();
    computeAndStoreNight(CHILD, DATE);
    const row = storedRow();
    assert.equal(row.stir_minutes, 1, 'precondition: there is a count to clear');
    assert.equal(JSON.parse(row.summary_facts).sleep.wakes.length, 1, 'precondition: and a wake to clear');
    saveNightReview(CHILD, DATE, { nobodyInBed: true });

    for (const [where, night] of [['the stored row', storedRow()], ['a fresh compute', computeNight(CHILD, DATE)]]) {
      const shown = applyCorrection(CHILD, night);
      assert.equal(shown.status, 'empty', where);
      assert.equal(shown.stir_minutes, null, `${where}: stir_minutes`);
      assert.deepEqual(JSON.parse(shown.summary_facts), { v: 1, climate: { temp_min: 21.5, temp_max: 21.5 }, sleep: null }, `${where}: summary_facts`);
    }
    assert.deepEqual(storedRow(), row, 'and the stored row itself is untouched: the overlay only');
  });

  test('"no one was in the bed" on facts that cannot be read gives null, never the unread text', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: noon() });
    saveNightReview(CHILD, DATE, { nobodyInBed: true });
    const base = { night_date: DATE, status: 'ok', window_end: '2026-07-01 21:00:00', onset_at: 'x' };
    for (const raw of ['{"v":1,"sleep":{"wakes":[{"start_at":"LEAK"', '{"v":99,"sleep":{"wakes":[{"start_at":"LEAK","minutes":5}]}}']) {
      assert.equal(applyCorrection(CHILD, { ...base, summary_facts: raw }).summary_facts, null, String(raw));
    }
    // A member this code does not know is kept (it is not under `sleep`), so a later addition is not dropped here.
    const future = applyCorrection(CHILD, { ...base, summary_facts: '{"v":1,"climate":{"temp_min":1,"temp_max":2},"sleep":{"wakes":[]},"extra":7}' });
    assert.deepEqual(JSON.parse(future.summary_facts), { v: 1, climate: { temp_min: 1, temp_max: 2 }, sleep: null, extra: 7 });
    // And a night object with no such key does not gain one.
    assert.ok(!('summary_facts' in applyCorrection(CHILD, base)));
  });

  test('a night promoted from `empty` by a parent\'s two times has no stir count and no sleep facts: nothing was measured', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: noon() });
    layNight({ still: () => STILL_EMPTY });
    insertReading(19.5, 52, at(23, 0));
    assert.equal(computeAndStoreNight(CHILD, DATE).status, 'empty', 'precondition: the detector saw an empty bed');
    saveNightReview(CHILD, DATE, { trueOnsetAt: sqlTime(at(20, 0)), trueWakeAt: sqlTime(at(6, 0, 1)) });

    for (const [where, night] of [['the stored row', storedRow()], ['a fresh compute', computeNight(CHILD, DATE)]]) {
      const shown = applyCorrection(CHILD, night);
      assert.equal(shown.status, 'ok', `${where}: precondition, promoted`);
      assert.equal(shown.wake_count, 0, `${where}: precondition, the promoted figures`);
      assert.equal(shown.stir_minutes, null, `${where}: null, not 0: no stirring was measured`);
      assert.deepEqual(JSON.parse(shown.summary_facts), { v: 1, climate: { temp_min: 19.5, temp_max: 19.5 }, sleep: null }, where);
    }
  });

  test('a time correction leaves both exactly as the detector measured them', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: noon() });
    layRich();
    computeAndStoreNight(CHILD, DATE);
    const row = storedRow();
    saveNightReview(CHILD, DATE, { trueOnsetAt: sqlTime(at(23, 30)), trueWakeAt: sqlTime(at(5, 0, 1)), trueInBedAt: sqlTime(at(23, 20)) });
    const shown = applyCorrection(CHILD, storedRow());
    assert.equal(shown.corrected, true, 'precondition: the correction is applied');
    assert.notEqual(shown.asleep_minutes, row.asleep_minutes, 'precondition: and it re-derived the total');
    assert.equal(shown.stir_minutes, row.stir_minutes);
    assert.equal(shown.summary_facts, row.summary_facts, 'the wake at 23:00 is still listed although the corrected night starts 23:30: a later phase filters');
  });
});

// =====================================================================================================
// ★ NO EXISTING FIGURE MOVED.
//
// GOLDEN (test/fixtures/sleep-night-facts-golden.json) was captured by running THIS test, with the fixtures below, on
// the source before the change (origin/dev f9b7ea47, in a scratch copy of that commit with this file copied in and
// NIGHT_FACTS_GOLDEN_OUT pointing at the file to write). For each night it holds:
//   - `plain`: computeNight's result as JSON text, key order included;
//   - `detail_sha256`: the sha256 of the same with includeTimeline (timeline, segments, wakes, visits and all);
//   - `row`: the stored row as JSON text, without `id`.
// The test removes the two new keys from today's output and requires the rest to be the SAME TEXT. So an existing
// value that changed, a key that moved, or a key that disappeared all fail it; only the two added keys may differ.
// The fixtures reach the paths the new code sits beside: an ordinary night with wakes, stirs, noise, room activity,
// an unwatched stretch and both bed transitions; a wake after the window (the metrics extension and its second
// query); a midnight episode (the bridged wake array); an empty bed; a night never asleep; and no data.
// If a deliberate scoring change moves this, re-capture it on the commit before that change's own additions, and
// bump SCORING_ALGO: this change did not, because nothing here moved.
const GOLDEN_FILE = fileURLToPath(new URL('./fixtures/sleep-night-facts-golden.json', import.meta.url));
const GOLDEN_NIGHTS = {
  'an ordinary night': () => {
    layNight({
      bed: [PUT_DOWN, MORNING, WAKE_23, [at(2, 0, 1), at(2, 2, 1)], minute(4, 0, 1), [at(20, 5), at(20, 7)]],
      room: [[at(19, 30), at(19, 38)], [at(23, 2), at(23, 5)], [at(3, 0, 1), at(3, 3, 1)]],
      noise: [[at(1, 0, 1), at(1, 7, 1)], minute(4, 30, 1)],
      unwatched: [[at(0, 10, 1), at(0, 25, 1)]],
    });
    insertTransition(TRANSITION.INTO_BED, at(19, 31, 0, 12));
    insertTransition(TRANSITION.OUT_OF_BED, at(6, 2, 1, 40));
    insertReading(21.26, 48, at(21, 0));
    insertReading(18.94, 50, at(3, 0, 1));
  },
  'a wake after the window': () => {
    layNight({ bed: [PUT_DOWN, WAKE_23, minute(7, 5, 1), [at(7, 12, 1), at(7, 19, 1)], [at(7, 40, 1), at(7, 50, 1)]], room: [[at(7, 45, 1), at(8, 5, 1)]] });
    insertTransition(TRANSITION.OUT_OF_BED, at(7, 50, 1, 30));
    insertReading(20, 45, at(22, 0));
  },
  'a midnight episode': () => {
    const wake = at(5, 49, 1);
    layNight({ from: at(19, 30), to: wake, bed: [PUT_DOWN, [at(20, 44), at(20, 46)], [new Date(wake.getTime() - 60000), wake]], room: [minute(20, 38)] });
    layNight({ from: wake, to: at(10, 0, 1), still: () => STILL_EMPTY });
    insertTransition(TRANSITION.OUT_OF_BED, wake);
    insertTransition(TRANSITION.OUT_OF_BED, at(20, 41, 0, 30));
    insertTransition(TRANSITION.INTO_BED, at(20, 43, 0, 57));
    insertTransition(TRANSITION.OUT_OF_BED, at(20, 44, 0, 36));
  },
  'an empty bed': () => {
    layNight({ still: () => STILL_EMPTY });
    insertReading(19.5, 52, at(23, 0));
  },
  'never asleep': () => {
    layNight({ bed: [[at(16, 30), at(10, 0, 1)]] });
  },
  'no data': () => {},
};

function captureGoldenNights(t) {
  t.mock.timers.enable({ apis: ['Date'], now: noon() });
  const out = {};
  for (const [name, lay] of Object.entries(GOLDEN_NIGHTS)) {
    clearNight();
    lay();
    const plain = json(computeNight(CHILD, DATE));
    const detail = json(computeNight(CHILD, DATE, { includeTimeline: true }));
    computeAndStoreNight(CHILD, DATE);
    out[name] = {
      status: plain.status,
      plain: JSON.stringify(omit(plain, ...NEW_KEYS)),
      detail_sha256: createHash('sha256').update(JSON.stringify(omit(detail, ...NEW_KEYS))).digest('hex'),
      row: JSON.stringify(omit(storedRow(), 'id', ...NEW_KEYS)),
    };
  }
  return out;
}

describe('★ no existing figure moved', () => {
  test('every other key of computeNight and every other stored column is byte for byte what the code before produced', (t) => {
    const now = captureGoldenNights(t);
    if (process.env.NIGHT_FACTS_GOLDEN_OUT) {
      // Capture mode (see above): run on the PREVIOUS source only. Never set in CI or in an ordinary run.
      fs.writeFileSync(process.env.NIGHT_FACTS_GOLDEN_OUT, `${JSON.stringify(now, null, 2)}\n`);
      return;
    }
    const golden = JSON.parse(fs.readFileSync(GOLDEN_FILE, 'utf8'));
    assert.deepEqual(Object.keys(now), Object.keys(golden), 'the same nights as the capture');
    // Not vacuous: the capture covers every status the change touches, and the scored nights have real figures.
    assert.deepEqual(Object.values(golden).map((g) => g.status), ['ok', 'ok', 'ok', 'empty', 'no_sleep', 'no_data']);
    for (const [name, g] of Object.entries(golden)) {
      assert.equal(now[name].plain, g.plain, `${name}: computeNight`);
      assert.equal(now[name].detail_sha256, g.detail_sha256, `${name}: computeNight with the timeline`);
      assert.equal(now[name].row, g.row, `${name}: the stored row`);
    }
  });

  test('on every one of those nights wakes.length === wake_count, and the nights are not all empty of facts', (t) => {
    // The invariant across every path (plain, post-window, episode, and the nights with no sleep facts at all), and a
    // guard on the golden itself: nights with nothing to count would prove little about the code that counts.
    t.mock.timers.enable({ apis: ['Date'], now: noon() });
    const seen = {};
    for (const [name, lay] of Object.entries(GOLDEN_NIGHTS)) {
      clearNight();
      lay();
      const night = computeNight(CHILD, DATE);
      const f = parseSummaryFacts(night.summary_facts);
      seen[name] = [night.stir_minutes, f?.sleep ? f.sleep.wakes.length : null, f?.sleep ? f.sleep.room_activity_wakes : null, night.wake_count];
    }
    for (const [name, [, wakes, , wakeCount]] of Object.entries(seen)) assert.equal(wakes, wakeCount, `${name}: wakes.length === wake_count`);
    assert.ok(seen['an ordinary night'][0] > 0 && seen['an ordinary night'][1] > 0 && seen['an ordinary night'][2] > 0, JSON.stringify(seen));
    assert.ok(seen['a wake after the window'][0] > 0, JSON.stringify(seen));
    assert.ok(seen['a midnight episode'][1] > 0 && seen['a midnight episode'][2] > 0, JSON.stringify(seen));
  });
});
