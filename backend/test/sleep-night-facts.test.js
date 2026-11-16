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
const { computeNight, computeAndStoreNight, runNightlySleepJob, parseSummaryFacts, lastCompletedNightDate, currentNightDate, SLEEP_THRESHOLDS } =
  await import('../src/lib/sleepAnalysis.js');
const { applyCorrection, saveNightReview, correctionSnapshot } = await import('../src/lib/sleepReviews.js');
const { refreshCorrectionSnapshots, _resetCorrectionSnapshotAttemptsForTests } = await import('../src/lib/sleepReviews.js');
const { logger } = await import('../src/lib/logger.js');
const { correctedSpanFigures } = await import('../src/lib/correctedSpan.js');
const { scoreNight, toScoringInput } = await import('../src/lib/sleepScore.js');
const { sleepBaseline } = await import('../src/lib/sleepBaseline.js');
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
const putReview = (body) => call(`${server.url}/api/children/${CHILD}/review/${DATE}`, { method: 'PUT', token: adminToken, body });

before(async () => {
  db.prepare(`INSERT INTO settings (id, timezone) VALUES ('app', ?)
              ON CONFLICT(id) DO UPDATE SET timezone = excluded.timezone`).run(TZ);
  const admin = makeUser(db, { id: 'u-a', username: 'admin', role: 'admin' });
  adminToken = signToken({ sub: admin.id, sid: makeSession(db, admin.id), role: 'admin', username: 'admin' });
  server = await mountRouter('/api/children', childrenRouter);
});

describe('#355 corrected span figures', () => {
  test('real detector basis clips earlier wake and keeps exact totals and bounded longest', (t) => {
    const night = nightWith(t, { bed: [WAKE_23], unwatched: [[at(2, 0, 1), at(2, 10, 1)]] }, { includeTimeline: true });
    const wake = sqlTime(at(5, 0, 1));
    const f = correctedSpanFigures(night.span_basis, night.onset_at, wake);
    assert.equal(f.asleep_minutes + f.awake_minutes + f.unknown_minutes,
      (Date.parse(`${wake.replace(' ', 'T')}Z`) - Date.parse(`${night.onset_at.replace(' ', 'T')}Z`)) / 60000);
    assert.ok(f.longest_stretch_minutes <= f.asleep_minutes);
    assert.ok(f.wake_count <= f.awake_minutes);
    assert.ok(f.unknown_minutes >= 10);
    assert.equal(f.wakes.length, f.wake_count);
  });

  test('later onset skips an early wake; onset clipping keeps awake minutes but no new wake-up', (t) => {
    const night = nightWith(t, { bed: [WAKE_23] }, { includeTimeline: true });
    const basis = night.span_basis;
    const before = correctedSpanFigures(basis, night.onset_at, night.wake_at);
    const cut = correctedSpanFigures(basis, sqlTime(at(23, 2)), night.wake_at);
    const skipped = correctedSpanFigures(basis, sqlTime(at(23, 7)), night.wake_at);
    assert.ok(cut.awake_minutes > skipped.awake_minutes);
    assert.equal(cut.wake_count, skipped.wake_count, 'a run cut at onset is awake, not a wake-up');
    assert.ok(before.wake_count > skipped.wake_count);
  });

  test('wake-end clipping counts five minutes but not a shorter stir', (t) => {
    assert.equal(SLEEP_THRESHOLDS.WAKE_ACTIVE_MIN, 5, '#355 pure clip rule must match the detector minimum');
    const night = nightWith(t, { bed: [WAKE_23] }, { includeTimeline: true });
    const short = correctedSpanFigures(night.span_basis, night.onset_at, sqlTime(at(23, 3)));
    const enough = correctedSpanFigures(night.span_basis, night.onset_at, sqlTime(at(23, 5)));
    assert.equal(short.wake_count, 0);
    assert.ok(short.awake_minutes > 0);
    assert.equal(enough.wake_count, 1);
  });

  test('a corrected span wholly inside a wake has no asleep stretch or counted wake-up', (t) => {
    const night = nightWith(t, { bed: [WAKE_23] }, { includeTimeline: true });
    const f = correctedSpanFigures(night.span_basis, sqlTime(at(23, 1)), sqlTime(at(23, 4)));
    assert.equal(f.asleep_minutes, 0);
    assert.equal(f.awake_minutes, 3);
    assert.equal(f.wake_count, 0);
    assert.equal(f.longest_stretch_minutes, 0);
  });

  test('unknown covers an actual gap and both outside-basis directions; seconds floor exactly', (t) => {
    const night = nightWith(t, { unwatched: [[at(2, 0, 1), at(2, 10, 1)]] }, { includeTimeline: true });
    const basis = night.span_basis;
    const start = sqlTime(new Date(Date.parse(`${basis.start_at.replace(' ', 'T')}Z`) - 10 * 60000));
    const end = sqlTime(new Date(Date.parse(`${basis.end_at.replace(' ', 'T')}Z`) + 10 * 60000));
    const full = correctedSpanFigures(basis, start, end);
    assert.ok(full.unknown_minutes >= 30);
    const seconds = correctedSpanFigures(basis, `${night.onset_at.slice(0, 17)}37`, `${night.wake_at.slice(0, 17)}59`);
    const floored = correctedSpanFigures(basis, night.onset_at, night.wake_at);
    assert.deepEqual(seconds, floored);
  });

  test('post-window wake uses extension arrays; a later corrected wake includes morning awake', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: noon() });
    layNight({ bed: [PUT_DOWN, [at(7, 40, 1), at(7, 50, 1)]] });
    insertTransition(TRANSITION.OUT_OF_BED, at(7, 50, 1, 30));
    const night = computeNight(CHILD, DATE, { includeTimeline: true });
    assert.equal(hhmm(night.wake_at), '07:50');
    assert.ok(night.span_basis.end_at > night.window_end);
    assert.equal(night.timeline.at(-1).t < night.span_basis.end_at, true);
    const f = correctedSpanFigures(night.span_basis, night.onset_at, night.wake_at);
    assert.ok(f.awake_minutes >= 10);
    const later = correctedSpanFigures(night.span_basis, night.onset_at, sqlTime(at(7, 55, 1)));
    assert.ok(later.unknown_minutes >= f.unknown_minutes + 5);
  });

  test('a wake later than the detector includes its morning run as awake time', (t) => {
    const night = nightWith(t, { bed: [WAKE_23] }, { includeTimeline: true });
    const earlier = correctedSpanFigures(night.span_basis, night.onset_at, night.wake_at);
    const later = correctedSpanFigures(night.span_basis, night.onset_at, sqlTime(at(6, 45, 1)));
    assert.ok(later.awake_minutes > earlier.awake_minutes);
    assert.equal(later.wake_count, earlier.wake_count + 1);
  });

  test('random spans on one real basis preserve all figure invariants', (t) => {
    const night = nightWith(t, { bed: [WAKE_23, WAKE_02], unwatched: [[at(1, 0, 1), at(1, 7, 1)]] }, { includeTimeline: true });
    const base = Date.parse(`${night.span_basis.start_at.replace(' ', 'T')}Z`);
    let seed = 355;
    for (let j = 0; j < 120; j++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const a = seed % 1100;
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const b = a + 1 + (seed % 200);
      const f = correctedSpanFigures(night.span_basis, sqlTime(new Date(base + a * 60000)), sqlTime(new Date(base + b * 60000)));
      assert.equal(f.asleep_minutes + f.awake_minutes + f.unknown_minutes, b - a);
      assert.ok(f.longest_stretch_minutes <= f.asleep_minutes);
      assert.ok(f.wake_count <= f.awake_minutes);
      assert.ok(f.wakes.reduce((sum, w) => sum + w.minutes, 0) <= f.awake_minutes);
    }
  });

  test('over the detector\'s own span the figures equal the detector\'s', (t) => {
    // #355 review (Opus L5): correctedSpanFigures re-expresses accumulateMetrics' counting rule over runs rather
    // than sharing it. On real nights (one wake, two wakes and an unwatched gap, a still night) the two must give
    // the same five figures over the detector's own span, or a correction could move a figure nobody touched.
    for (const opts of [{ bed: [WAKE_23] }, { bed: [WAKE_23, WAKE_02], unwatched: [[at(1, 0, 1), at(1, 7, 1)]] }, {}]) {
      const night = nightWith(t, opts, { includeTimeline: true });
      const f = correctedSpanFigures(night.span_basis, night.onset_at, night.wake_at);
      assert.deepEqual(
        [f.asleep_minutes, f.awake_minutes, f.unknown_minutes, f.wake_count, f.longest_stretch_minutes],
        [night.asleep_minutes, night.awake_minutes, night.unknown_minutes, night.wake_count, night.longest_stretch_minutes],
        JSON.stringify(opts));
    }
  });

  test('a run cut by the detector\'s own wake stays a wake-up, also after an onset-only correction', (t) => {
    // Fix round 2 (Opus M1, its probe): in-bed movement 06:26-06:31 and an exit at 06:30:30, so the detector
    // adopts 06:30 and counts the four minutes before it as a wake-up. The short-piece rule is for a wake a
    // parent moved EARLIER; applied at the detector's own wake it dropped that wake-up (1 became 0).
    t.mock.timers.enable({ apis: ['Date'], now: noon() });
    layNight({ bed: [PUT_DOWN, [at(6, 26, 1), at(6, 31, 1)]] });
    insertTransition(TRANSITION.OUT_OF_BED, at(6, 30, 1, 30));
    const night = computeNight(CHILD, DATE, { includeTimeline: true });
    assert.equal(hhmm(night.wake_at), '06:30', 'precondition: the exit is adopted');
    assert.equal(night.wake_count, 1, 'precondition: the detector counts the cut run');
    const own = correctedSpanFigures(night.span_basis, night.onset_at, night.wake_at);
    assert.deepEqual(
      [own.asleep_minutes, own.awake_minutes, own.unknown_minutes, own.wake_count, own.longest_stretch_minutes],
      [night.asleep_minutes, night.awake_minutes, night.unknown_minutes, night.wake_count, night.longest_stretch_minutes]);
    computeAndStoreNight(CHILD, DATE);
    saveNightReview(CHILD, DATE, { trueOnsetAt: sqlTime(at(19, 50)) });
    assert.equal(applyCorrection(CHILD, storedRow()).wake_count, 1, 'an onset-only correction keeps it');
    // A wake the parent moved EARLIER, cutting the same run to three minutes, still leaves a stir.
    assert.equal(correctedSpanFigures(night.span_basis, night.onset_at, sqlTime(at(6, 29, 1))).wake_count, 0);
  });

  test('snapshot agrees on stored and fresh reads, invalidates on time or detector revision, and backfills', async (t) => {
    nightWith(t, { bed: [WAKE_23] });
    computeAndStoreNight(CHILD, DATE);
    const first = sqlTime(at(5, 0, 1));
    saveNightReview(CHILD, DATE, { trueWakeAt: first });
    const review = db.prepare('SELECT * FROM sleep_reviews WHERE child_id = ? AND night_date = ?').get(CHILD, DATE);
    assert.ok(review.span_figures);
    const snapshot = JSON.parse(review.span_figures);
    const stored = applyCorrection(CHILD, storedRow());
    const fresh = applyCorrection(CHILD, computeNight(CHILD, DATE, { includeTimeline: true }));
    for (const key of ['asleep_minutes', 'awake_minutes', 'unknown_minutes', 'wake_count', 'longest_stretch_minutes']) {
      assert.equal(stored[key], snapshot[key], `snapshot must be the authority for ${key}`);
      assert.equal(fresh[key], stored[key], key);
    }
    assert.ok(fresh.segments.length > 0 && fresh.wakes.length > 0);
    assert.equal(fresh.wakes.at(-1).start_at, first, 'morning row begins at the corrected wake');
    assert.equal(segmentAt(fresh, at(4, 59, 1)), 'asleep');
    assert.equal(segmentAt(fresh, at(5, 0, 1)), 'awake');
    db.prepare('UPDATE sleep_reviews SET span_figures = json_set(span_figures, ? , ?) WHERE child_id = ? AND night_date = ?')
      .run('$.wake_at', sqlTime(at(4, 0, 1)), CHILD, DATE);
    assert.equal(applyCorrection(CHILD, storedRow()).wake_count, storedRow().wake_count);
    assert.equal(await refreshCorrectionSnapshots(noon()), 1);
    assert.equal(applyCorrection(CHILD, storedRow()).wake_count, stored.wake_count);
    db.prepare('UPDATE sleep_nights SET computed_at = ? WHERE child_id = ? AND night_date = ?')
      .run(sqlTime(at(12, 5, 1)), CHILD, DATE);
    assert.equal(applyCorrection(CHILD, storedRow()).wake_count, storedRow().wake_count);
    assert.equal(await refreshCorrectionSnapshots(noon()), 1);
    assert.equal(applyCorrection(CHILD, storedRow()).wake_count, stored.wake_count);
    saveNightReview(CHILD, DATE, { trueWakeAt: null });
    assert.equal(db.prepare('SELECT span_figures FROM sleep_reviews WHERE child_id = ? AND night_date = ?').get(CHILD, DATE).span_figures, null);
  });

  test('no snapshot keeps detector wake figures and the old score except for the stretch cap', (t) => {
    // #355 review, amendment A: a correction with no valid snapshot reads as it did before #355 (the real-data
    // run showed nulling its wake figures would drop old corrected nights' scores by half), with only the
    // longest stretch capped at the asleep total. The score capped it already, so no score moves.
    nightWith(t, { bed: [WAKE_23] });
    computeAndStoreNight(CHILD, DATE);
    saveNightReview(CHILD, DATE, { trueWakeAt: sqlTime(at(5, 0, 1)) });
    db.prepare('UPDATE sleep_reviews SET span_figures = NULL WHERE child_id = ? AND night_date = ?').run(CHILD, DATE);
    const overlaid = applyCorrection(CHILD, storedRow());
    assert.equal(overlaid.awake_minutes, storedRow().awake_minutes);
    assert.equal(overlaid.wake_count, storedRow().wake_count);
    assert.equal(overlaid.longest_stretch_minutes, Math.min(storedRow().longest_stretch_minutes, overlaid.asleep_minutes));
    const rawDetail = computeNight(CHILD, DATE, { includeTimeline: true });
    const unavailableDetail = applyCorrection(CHILD, rawDetail);
    assert.deepEqual(unavailableDetail.wakes, rawDetail.wakes);
    assert.deepEqual(unavailableDetail.segments, rawDetail.segments);
    const span = (Date.parse(`${overlaid.wake_at.replace(' ', 'T')}Z`)
      - Date.parse(`${overlaid.onset_at.replace(' ', 'T')}Z`)) / 60000;
    assert.equal(overlaid.asleep_minutes,
      Math.max(0, span - (storedRow().awake_minutes ?? 0) - (storedRow().unknown_minutes ?? 0)));
    const input = toScoringInput(overlaid);
    assert.equal(input.metrics.awake_minutes.usable, true);
    const baseline = sleepBaseline(CHILD, overlaid);
    const result = scoreNight(overlaid, baseline, 24);
    const oldOverlay = { ...overlaid, longest_stretch_minutes: storedRow().longest_stretch_minutes };
    assert.equal(result.score, scoreNight(oldOverlay, baseline, 24).score, 'the same score as the overlay before #355');
    if (result.score != null) assert.ok(Number.isFinite(result.score));
    for (const value of Object.values(baseline.metrics)) {
      if (value.median != null) assert.ok(Number.isFinite(value.median));
    }
    saveNightReview(CHILD, DATE, { trueWakeAt: sqlTime(at(21, 0)) });
    db.prepare('UPDATE sleep_reviews SET span_figures = NULL WHERE child_id = ? AND night_date = ?').run(CHILD, DATE);
    const short = applyCorrection(CHILD, storedRow());
    assert.ok(storedRow().longest_stretch_minutes > short.asleep_minutes, 'precondition: the cap bites');
    assert.equal(short.longest_stretch_minutes, short.asleep_minutes,
      'the detector stretch cannot exceed a short corrected sleep total');
    const shortBaseline = sleepBaseline(CHILD, short);
    assert.equal(scoreNight(short, shortBaseline, 24).score,
      scoreNight({ ...short, longest_stretch_minutes: storedRow().longest_stretch_minutes }, shortBaseline, 24).score,
      'even where the cap bites the score is unchanged: sleepScore.js already capped the stretch it scores');
  });

  test('active minutes before detector onset break an earlier corrected stretch', (t) => {
    // #355 review (Opus M1). The real shape: in-bed movement from 19:30 to the detector's 19:40 put-down, and a
    // parent who says the child was asleep at 19:20, earlier than both. The detector's wake walk starts at 19:40,
    // so no wake run covers the movement; without active_runs the longest stretch ran straight through it.
    const night = nightWith(t, {}, { includeTimeline: true });
    const earlier = sqlTime(at(19, 20));
    const figures = correctedSpanFigures(night.span_basis, earlier, night.wake_at);
    assert.ok(night.span_basis.active_runs.some((r) => r.start_at <= sqlTime(at(19, 30)) && r.end_at >= sqlTime(at(19, 40))));
    assert.equal(figures.awake_minutes, 10, 'the ten moving minutes before the put-down are awake');
    assert.equal(figures.wake_count, 0, 'pre-onset movement never makes a wake-up');
    assert.equal(figures.longest_stretch_minutes, figures.asleep_minutes - 10,
      'the stretch restarts after the movement: the ten quiet minutes before it are their own stretch');
  });

  test('overlapping and duplicate runs count as one wake', (t) => {
    const night = nightWith(t, { bed: [WAKE_23] }, { includeTimeline: true });
    const run = night.span_basis.wake_runs.find((r) => r.start_at === sqlTime(at(23, 0)));
    assert.ok(run);
    const basis = { ...night.span_basis, wake_runs: [run, run, ...night.span_basis.wake_runs].reverse() };
    const figures = correctedSpanFigures(basis, night.onset_at, night.wake_at);
    assert.ok(figures.wake_count <= figures.awake_minutes);
    assert.equal(figures.wake_count, correctedSpanFigures(night.span_basis, night.onset_at, night.wake_at).wake_count);
    // #355 review (Codex L3): ten copies of a six-minute run, and a run overlapping it by three minutes, are one
    // wake of nine minutes: wake_count <= awake_minutes for any input, not only the detector's disjoint runs.
    const shifted = { start_at: sqlTime(at(23, 3)), end_at: sqlTime(at(23, 9)) };
    const many = correctedSpanFigures({ ...night.span_basis, wake_runs: [...Array(10).fill(run), shifted] },
      night.onset_at, night.wake_at);
    assert.deepEqual([many.wake_count, many.awake_minutes], [1, 9]);
  });

  test('snapshot freezes the uncorrected endpoint when a fresh detail compute drifts', (t) => {
    nightWith(t, { bed: [WAKE_23] });
    computeAndStoreNight(CHILD, DATE);
    saveNightReview(CHILD, DATE, { trueWakeAt: sqlTime(at(5, 0, 1)) });
    const card = applyCorrection(CHILD, storedRow());
    const fresh = computeNight(CHILD, DATE, { includeTimeline: true });
    // The fresh compute has drifted on the onset and on the put-down (fix round 2, Opus L2).
    const drifted = { ...fresh, onset_at: sqlTime(at(19, 43)), in_bed_at: sqlTime(at(19, 35)) };
    const detail = applyCorrection(CHILD, drifted);
    for (const key of ['onset_at', 'wake_at', 'in_bed_at', 'asleep_minutes', 'awake_minutes', 'unknown_minutes', 'wake_count', 'longest_stretch_minutes'])
      assert.equal(detail[key], card[key], key);
    // The detector times beside them come from the same stored row, so the detail page does not read the
    // drifted onset as one the parent corrected (the score's and inBed.js's `onset_at !== algo_onset_at`).
    assert.deepEqual([detail.algo_onset_at, detail.algo_wake_at, detail.algo_in_bed_at],
      [card.algo_onset_at, card.algo_wake_at, card.algo_in_bed_at]);
    assert.equal(detail.onset_at !== detail.algo_onset_at, false, 'the onset nobody corrected is not read as corrected');
    assert.equal(toScoringInput(detail).span_moved_minutes, toScoringInput(card).span_moved_minutes);
    assert.deepEqual(toScoringInput(detail).metrics.settle_minutes, toScoringInput(card).metrics.settle_minutes,
      'the settling term pairs the same put-down with the same onset on both pages');
  });

  test('a later save that re-sends a frame-picked wake as HH:MM keeps the snapshot after samples expire', async (t) => {
    // Fix round 2 (Opus M2). A wake picked from a bed-transition frame carries seconds; the review page re-sends
    // the time it shows as HH:MM with every later save (NightReview.jsx), here with a note, the real client's body.
    nightWith(t, { bed: [WAKE_23] });
    computeAndStoreNight(CHILD, DATE);
    saveNightReview(CHILD, DATE, { trueWakeAt: sqlTime(at(5, 0, 1, 37)) });
    const saved = db.prepare('SELECT span_figures FROM sleep_reviews WHERE child_id = ? AND night_date = ?').get(CHILD, DATE).span_figures;
    assert.equal(JSON.parse(saved).wake_at, sqlTime(at(5, 0, 1, 37)), 'precondition: the snapshot carries the seconds');
    const card = applyCorrection(CHILD, storedRow());
    db.prepare('DELETE FROM activity_samples').run();
    const res = await putReview({ true_wake_local: '05:00', note: 'A cold' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.review.true_wake_at, sqlTime(at(5, 0, 1)), 'precondition: the seconds were dropped');
    assert.equal(res.body.review.span_figures, saved, 'the same minute keeps the measurement');
    const after = applyCorrection(CHILD, storedRow());
    for (const key of ['asleep_minutes', 'awake_minutes', 'unknown_minutes', 'wake_count', 'longest_stretch_minutes']) {
      assert.equal(after[key], card[key], key);
    }
  });

  test('PUT stores, replaces and clears the correction snapshot in the review row', async (t) => {
    nightWith(t, { bed: [WAKE_23] });
    computeAndStoreNight(CHILD, DATE);
    const first = await putReview({ true_wake_local: '05:00' });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const one = JSON.parse(first.body.review.span_figures);
    assert.equal(one.wake_at, sqlTime(at(5, 0, 1)));
    const second = await putReview({ true_wake_local: '04:00' });
    assert.equal(second.status, 200, JSON.stringify(second.body));
    const two = JSON.parse(second.body.review.span_figures);
    assert.equal(two.wake_at, sqlTime(at(4, 0, 1)));
    assert.notEqual(two.asleep_minutes, one.asleep_minutes);
    const cleared = await putReview({ true_wake_local: null });
    assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
    assert.equal(cleared.body.review.span_figures, null);
    const unchanged = await putReview({ true_wake_local: hhmm(storedRow().wake_at) });
    assert.equal(unchanged.status, 200, JSON.stringify(unchanged.body));
    assert.equal(unchanged.body.review.span_figures, null);
  });

  test('a later PUT saves its review when snapshot recomputation throws', async (t) => {
    nightWith(t, { bed: [WAKE_23] });
    computeAndStoreNight(CHILD, DATE);
    assert.equal((await putReview({ true_wake_local: '05:00' })).status, 200);
    const realPrepare = db.prepare.bind(db);
    const mock = t.mock.method(db, 'prepare', (source) => {
      if (source === 'SELECT id FROM cameras WHERE child_id = ?') throw new Error('snapshot compute failed');
      return realPrepare(source);
    });
    const result = await putReview({ true_wake_local: '04:00', note: 'Later answer' });
    mock.mock.restore();
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.review.true_wake_at, sqlTime(at(4, 0, 1)));
    assert.equal(result.body.review.span_figures, null, 'the old snapshot no longer matches the changed time');
  });

  test('nightly refresh fills an unscored correction and skips an old date', async (t) => {
    nightWith(t, { bed: [WAKE_23] });
    saveNightReview(CHILD, DATE, { trueWakeAt: sqlTime(at(5, 0, 1)) });
    assert.equal(db.prepare('SELECT span_figures FROM sleep_reviews WHERE child_id = ? AND night_date = ?').get(CHILD, DATE).span_figures, null);
    computeAndStoreNight(CHILD, DATE);
    // The night's date is DATE; noon() is the next day. 29 days later the night is 30 calendar days back (kept);
    // 30 days later it is 31 back (skipped). A 29- or 31-day window fails one of the two.
    assert.equal(await refreshCorrectionSnapshots(noon() + 30 * 86400000), 0);
    assert.equal(await refreshCorrectionSnapshots(noon() + 29 * 86400000), 1,
      'the inclusive boundary keeps day 30 but excludes day 31');
    assert.ok(db.prepare('SELECT span_figures FROM sleep_reviews WHERE child_id = ? AND night_date = ?').get(CHILD, DATE).span_figures);
    assert.equal(await refreshCorrectionSnapshots(noon()), 0);
  });

  test('nightly job fills a missing snapshot after storing the night', async (t) => {
    nightWith(t, { bed: [WAKE_23] });
    computeAndStoreNight(CHILD, DATE);
    saveNightReview(CHILD, DATE, { trueWakeAt: sqlTime(at(5, 0, 1)) });
    db.prepare('UPDATE sleep_reviews SET span_figures = NULL WHERE child_id = ? AND night_date = ?').run(CHILD, DATE);
    runNightlySleepJob();
    for (let i = 0; i < 20; i++) {
      if (db.prepare('SELECT span_figures FROM sleep_reviews WHERE child_id = ? AND night_date = ?').get(CHILD, DATE).span_figures) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(db.prepare('SELECT span_figures FROM sleep_reviews WHERE child_id = ? AND night_date = ?').get(CHILD, DATE).span_figures);
  });

  test('unrebuildable correction is tried once per review in this process', async (t) => {
    nightWith(t, { bed: [WAKE_23] });
    computeAndStoreNight(CHILD, DATE);
    saveNightReview(CHILD, DATE, { trueWakeAt: sqlTime(at(5, 0, 1)) });
    db.prepare('UPDATE sleep_reviews SET span_figures = NULL WHERE child_id = ? AND night_date = ?').run(CHILD, DATE);
    db.prepare('DELETE FROM activity_samples').run();
    assert.equal(await refreshCorrectionSnapshots(noon()), 0);
    layNight({ bed: [PUT_DOWN, MORNING, WAKE_23] });
    assert.equal(await refreshCorrectionSnapshots(noon()), 0,
      'the same reviewed-at candidate is not recomputed on the next tick');
  });

  // Two corrected nights in a row with their snapshots missing, both finished. Returns the reader of a night's
  // span_figures. The second night is laid like the first, one day later.
  const NEXT = '2026-07-02';
  function twoCorrectedNights(t) {
    nightWith(t, { bed: [WAKE_23] });
    layNight({ from: at(16, 30, 1), to: at(10, 0, 2), bed: [[at(19, 30, 1), at(19, 40, 1)], [at(6, 0, 2), at(7, 0, 2)]] });
    t.mock.timers.setTime(at(12, 0, 2).getTime()); // both windows closed more than 3 hours ago
    computeAndStoreNight(CHILD, DATE);
    computeAndStoreNight(CHILD, NEXT);
    assert.equal(storedRow(NEXT).status, 'ok', 'precondition: the second night is scored');
    saveNightReview(CHILD, DATE, { trueWakeAt: sqlTime(at(5, 0, 1)) });
    saveNightReview(CHILD, NEXT, { trueWakeAt: sqlTime(at(5, 0, 2)) });
    db.prepare('UPDATE sleep_reviews SET span_figures = NULL').run();
    return (date) => db.prepare('SELECT span_figures FROM sleep_reviews WHERE child_id = ? AND night_date = ?')
      .get(CHILD, date).span_figures;
  }

  test('a night the nightly step cannot write does not stop the next night, and is not retried', async (t) => {
    // #355 review (Opus M4): one bad night must not end the refresh for every night after it. The failure is
    // real, not mocked: a trigger makes the database refuse the first night's write, as a full disk would.
    const figures = twoCorrectedNights(t);
    const errors = t.mock.method(logger, 'error', () => {});
    db.exec(`CREATE TRIGGER nf_refuse_snapshot BEFORE UPDATE OF span_figures ON sleep_reviews
             WHEN NEW.night_date = '${DATE}' BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END`);
    // computeNight's first statement, prepared per call: counting it counts computes (as in the lock tests).
    const prepare = t.mock.method(db, 'prepare');
    const computes = () => prepare.mock.calls.filter((c) => c.arguments[0] === 'SELECT id FROM cameras WHERE child_id = ?').length;
    try {
      assert.equal(await refreshCorrectionSnapshots(Date.now()), 1);
      const before = computes();
      assert.equal(await refreshCorrectionSnapshots(Date.now()), 0);
      // Fix round 2 (Opus L3): the night whose write threw is remembered, so the next tick does not pay
      // another computeNight for it (the log line alone could not show that: it is also once per night).
      assert.equal(computes(), before, 'the failed night is not recomputed on the next tick');
    } finally {
      db.exec('DROP TRIGGER nf_refuse_snapshot');
    }
    assert.equal(figures(DATE), null);
    assert.ok(figures(NEXT), 'the night after the failure was still filled');
    assert.equal(errors.mock.calls.filter((c) => String(c.arguments[0]).includes('correction snapshot')).length, 1,
      'two ticks, one log line');
  });

  test('the nightly refresh yields between nights and reads each night after its yield', async (t) => {
    // Fix round 2 (Opus L4): one night per turn of the event loop, so the first tick after an upgrade cannot
    // hold the server for a month of computes. And a save landing between two nights must not be overwritten
    // by a snapshot measured from the review as it was before that save.
    const figures = twoCorrectedNights(t);
    const filled = () => [DATE, NEXT].filter((d) => figures(d)).length;
    const run = refreshCorrectionSnapshots(Date.now());
    assert.equal(filled(), 0, 'nothing is computed before the first yield');
    const seen = await new Promise((resolve) => setImmediate(() => resolve(filled())));
    assert.equal(seen, 1, 'one night per turn of the event loop');
    const pending = [DATE, NEXT].find((d) => !figures(d));
    const wake = pending === DATE ? sqlTime(at(4, 0, 1)) : sqlTime(at(4, 0, 2));
    saveNightReview(CHILD, pending, { trueWakeAt: wake }); // a parent's save between the two nights
    assert.equal(await run, 1, 'the refresh leaves the night the save already measured');
    assert.equal(JSON.parse(figures(pending)).wake_at, wake, 'the save\'s own snapshot survives');
  });

  test('saved correction figures still reach the detail page after raw samples expire', async (t) => {
    nightWith(t, { bed: [WAKE_23] });
    computeAndStoreNight(CHILD, DATE);
    saveNightReview(CHILD, DATE, { trueWakeAt: sqlTime(at(5, 0, 1)) });
    const card = applyCorrection(CHILD, storedRow());
    db.prepare('DELETE FROM activity_samples').run();
    // #355 review (Opus H1): later saves that change no time keep the snapshot. Recomputing here would find no
    // samples and write null, losing the only measurement this night can ever have.
    const noteSave = await putReview({ note: 'Saved after samples expired' });
    assert.equal(noteSave.status, 200, JSON.stringify(noteSave.body));
    assert.ok(noteSave.body.review.span_figures, 'note-only save keeps the valid snapshot');
    const dismissSave = await putReview({ dismissed: true });
    assert.equal(dismissSave.status, 200, JSON.stringify(dismissSave.body));
    assert.equal(dismissSave.body.review.span_figures, noteSave.body.review.span_figures, 'so does a dismissal');
    const cardAfter = applyCorrection(CHILD, storedRow());
    for (const key of ['onset_at', 'wake_at', 'asleep_minutes', 'awake_minutes', 'unknown_minutes', 'wake_count', 'longest_stretch_minutes']) {
      assert.equal(cardAfter[key], card[key], `card ${key} after the later saves`);
    }
    const detail = await get(`/sleep/${DATE}?detail=1`);
    assert.equal(detail.status, 200, JSON.stringify(detail.body));
    assert.equal(detail.body.status, 'ok');
    for (const key of ['asleep_minutes', 'awake_minutes', 'unknown_minutes', 'wake_count', 'longest_stretch_minutes']) {
      assert.equal(detail.body[key], card[key], key);
    }
    assert.equal(detail.body.timeline, undefined, 'timestamps alone do not manufacture a timeline');
    assert.equal(detail.body.score_source, 'stored');
  });

  test('fresh empty detail uses a valid saved corrected night, also when the parent\'s two times promote it', async (t) => {
    // #355 review (Opus L1). Both times corrected, so the overlay PROMOTES the fresh `empty` night to `ok`
    // (asScoredFromEmpty, span taken as given). Deciding on the overlaid status, the route then served those
    // promoted figures beside a card reading the snapshot's. It must decide on the fresh detector night.
    nightWith(t, { bed: [WAKE_23] });
    computeAndStoreNight(CHILD, DATE);
    saveNightReview(CHILD, DATE, { trueOnsetAt: sqlTime(at(19, 50)), trueWakeAt: sqlTime(at(5, 0, 1)) });
    const card = applyCorrection(CHILD, storedRow());
    db.prepare('DELETE FROM activity_samples').run();
    layNight({ still: () => STILL_EMPTY });
    const promoted = applyCorrection(CHILD, computeNight(CHILD, DATE, { includeTimeline: true }));
    assert.deepEqual([promoted.status, promoted.algo_status], ['ok', 'empty'], 'precondition: the overlay promotes it');
    assert.notEqual(promoted.asleep_minutes, card.asleep_minutes, 'precondition: the promoted figures differ');
    const detail = await get(`/sleep/${DATE}?detail=1`);
    assert.equal(detail.status, 200, JSON.stringify(detail.body));
    assert.equal(detail.body.status, 'ok');
    for (const key of ['onset_at', 'wake_at', 'asleep_minutes', 'awake_minutes', 'unknown_minutes', 'wake_count', 'longest_stretch_minutes']) {
      assert.equal(detail.body[key], card[key], key);
    }
  });

  test('second-carrying corrected times merge the morning row and keep segments on the minute', (t) => {
    // #355 review (Opus L3, probe P3): a time picked from a bed-transition frame carries seconds. The wake run
    // ends at 23:06:00, so a corrected wake at 23:06:37 must merge the morning row into it, as the detector does.
    nightWith(t, { bed: [WAKE_23] });
    computeAndStoreNight(CHILD, DATE);
    saveNightReview(CHILD, DATE, { trueWakeAt: sqlTime(at(23, 6, 0, 37)) });
    const detail = applyCorrection(CHILD, computeNight(CHILD, DATE, { includeTimeline: true }));
    assert.equal(detail.wakes.at(-1).start_at, sqlTime(at(23, 0)));
    assert.equal(detail.segments.reduce((sum, segment) => sum + segment.minutes, 0),
      (Date.parse(`${detail.display_end.replace(' ', 'T')}Z`) - Date.parse(`${detail.display_start.replace(' ', 'T')}Z`)) / 60000);
    // And an onset with seconds before the page's own start: every segment still starts and ends on a minute,
    // so each finds its timeline row.
    saveNightReview(CHILD, DATE, { trueOnsetAt: sqlTime(at(18, 0, 0, 37)) });
    const early = applyCorrection(CHILD, computeNight(CHILD, DATE, { includeTimeline: true }));
    assert.equal(early.display_start, sqlTime(at(18, 0)), 'the page starts at the corrected onset\'s minute');
    for (const segment of early.segments) {
      assert.ok(segment.from_at.endsWith(':00') && segment.to_at.endsWith(':00'), JSON.stringify(segment));
    }
  });

  test('detail wake list drops a wake before the corrected onset', (t) => {
    nightWith(t, { bed: [WAKE_23] });
    computeAndStoreNight(CHILD, DATE);
    saveNightReview(CHILD, DATE, { trueOnsetAt: sqlTime(at(23, 7)) });
    const detail = applyCorrection(CHILD, computeNight(CHILD, DATE, { includeTimeline: true }));
    assert.equal(detail.wake_count, 0);
    assert.equal(detail.wakes.length, 1, 'only the morning row remains');
    assert.equal(detail.wakes[0].start_at, detail.wake_at);
  });

  test('no snapshot is made for empty, no-data, open or basis-free nights', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: noon() });
    const review = { true_wake_at: sqlTime(at(5, 0, 1)) };
    layNight({ still: () => STILL_EMPTY });
    computeAndStoreNight(CHILD, DATE);
    assert.equal(correctionSnapshot(CHILD, DATE, review), null, 'empty');
    clearNight();
    computeAndStoreNight(CHILD, DATE);
    assert.equal(correctionSnapshot(CHILD, DATE, review), null, 'no data');
    clearNight();
    layNight({ bed: [PUT_DOWN, MORNING, WAKE_23] });
    computeAndStoreNight(CHILD, DATE);
    db.prepare('UPDATE sleep_nights SET window_end = ? WHERE child_id = ? AND night_date = ?')
      .run(sqlTime(at(13, 0, 1)), CHILD, DATE);
    assert.equal(correctionSnapshot(CHILD, DATE, review), null, 'window still open');
    db.prepare('UPDATE sleep_nights SET window_end = ? WHERE child_id = ? AND night_date = ?')
      .run(sqlTime(at(7, 0, 1)), CHILD, DATE);
    db.prepare('DELETE FROM activity_samples').run();
    assert.equal(correctionSnapshot(CHILD, DATE, review), null, 'no minute basis');
  });
});
beforeEach(() => {
  clearNight();
  // The nightly step remembers, per process, which corrections it could not rebuild; these tests reuse one
  // child and night, so a failure remembered by one test must not skip the next test's candidate.
  _resetCorrectionSnapshotAttemptsForTests();
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
      detail_sha256: createHash('sha256').update(JSON.stringify(omit(detail, ...NEW_KEYS, 'span_basis'))).digest('hex'),
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
