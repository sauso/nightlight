// #904: the faulty-microphone guard, end to end through computeNight. The pure rule (the four numbers and their
// boundaries) is tested in micGuard.test.js; this file tests what it does to a NIGHT, and the paths a night takes
// afterwards (the stored row, a parent's correction, the detail route).
//
// Why each test exists, in one line each (the claims the PR names):
//   - the incident's shape: a microphone spiking every minute from 21:00 ends the night at 21:00 without the
//     guard, and with it the night reports only the real stir;
//   - a motionless, intermittent cry (spike-only in shape) still counts: persistence, not shape, protects it;
//   - a real cry and a sustained noise (raised p75) inside a faulty stretch still count;
//   - recovery: once the fault stops, sound counts again;
//   - never `empty` because of the guard (a final `empty` deletes a night's frames);
//   - the post-window minutes take part (a fault that qualifies only through them);
//   - the onset/grace view reads the discount too;
//   - an ordinary night, even one shaped like the worst ordinary night Phase 0 found, is unchanged;
//   - a night in progress gets no discount until 480 minutes of its timeline exist;
//   - the new key: on the detail route, nulled by "no one was in the bed", kept by a time correction, and never
//     stored (no column).
//
// ★ THE "OLD RULE" TWIN. Several tests compare a night with the SAME night where every `sound_p75` is NULL. A NULL
// p75 is never spike-only (micGuard.js), so the guard cannot fire and the night is worked out exactly as the code
// before #904 did (every discount is false, and the classification is then the old one term for term; the golden
// literals in scoring-context.test.js and scoring-context-replay.test.js, captured on the pre-#904 source, still
// match apart from the added key). This is a stand-in for the old source, not the old source: the pre-merge A/B
// runs the real old code on both databases.
//
// ★ HOSTILE FIXTURE. Every row is written through a column list read from the schema (PRAGMA), and every column the
// analysis does NOT read carries a decoy that says the opposite of the scenario (a spike-only minute carries a high
// mean and p90 and a flat sd, a real cry the reverse). A guard that read the wrong sound column would invert its
// verdicts and fail here. A column added to activity_samples later fails the builder until it is classified.
//
// ⚠️ The camera and child fixtures are neutral on purpose: the repo is public.

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, signToken, mountRouter, call } from './helpers/harness.js';

useTempDataDir();

const { default: db } = await import('../src/db.js');
const { computeNight, computeAndStoreNight } = await import('../src/lib/sleepAnalysis.js');
const { applyCorrection } = await import('../src/lib/sleepReviews.js');
const { TRANSITION } = await import('../src/lib/bedTransitions.js');
const { default: childrenRouter } = await import('../src/routes/children.js');

const CHILD = 'fm-child';
const CAM = 'fm-cam';
const DATE = '2026-07-01';
const TZ = 'Australia/Melbourne'; // UTC+10 in July, no DST edge near the fixture night
const TZ_OFF = 10 * 3600 * 1000;

const at = (h, m, dayShift = 0, s = 0) => new Date(Date.UTC(2026, 6, 1 + dayShift, h, m, s) - TZ_OFF);
const sqlTime = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
const hhmm = (u) =>
  u ? new Date(u.replace(' ', 'T') + 'Z').toLocaleString('en-AU', { timeZone: TZ, hour12: false, hour: '2-digit', minute: '2-digit' }) : null;
const json = (v) => JSON.parse(JSON.stringify(v));
const without = (o, ...keys) => { const c = { ...o }; for (const k of keys) delete c[k]; return c; };
const noon = () => at(12, 0, 1).getTime(); // the next day's noon: past the 3 h evidence horizon, so the night is final

// Sleep-analysis fixture levels (sleepAnalysis.test.js explains them): an occupied still bed sits above
// OCCUPANCY_MIN_PEAK and under MOTION_ACTIVE; an empty one under both.
const STILL_OCCUPIED = 0.004;
const STILL_EMPTY = 0.0002;
// The sound of a minute, as [sound_peak, sound_p75]. FAULT is the 2026-10-29 shape (one loud spike, p75 at the
// floor); LOW_CRY is a child calling out for under 15 s a minute (also spike-only in shape); REAL is a sustained cry
// or noise (p75 raised); QUIET is an ordinary quiet minute.
const FAULT = [15, 0.5];
const LOW_CRY = [20, 1.5];
const REAL = [25, 12];
const QUIET = [0.5, 0.2];

// ---- the hostile row builder ---------------------------------------------------------------------------------
const SAMPLE_COLUMNS = db.prepare('PRAGMA table_info(activity_samples)').all().map((c) => c.name);
const AUTO_COLUMNS = new Set(['id', 'created_at']);
// What computeNight reads, from the scenario.
const READ_COLUMNS = new Set(['camera_id', 'bucket_start', 'motion_peak', 'motion_out_peak', 'sound_peak', 'sound_p75', 'motion_frames']);
// What it does not read: each a decoy (see the header).
const DECOY_COLUMNS = new Set(['motion_level', 'motion_out_level', 'sound_level', 'sound_p90', 'sound_sd', 'sound_windows']);
const unclassified = SAMPLE_COLUMNS.filter((c) => !AUTO_COLUMNS.has(c) && !READ_COLUMNS.has(c) && !DECOY_COLUMNS.has(c));
assert.deepEqual(unclassified, [], `activity_samples has column(s) this fixture has not classified: ${unclassified.join(', ')}`);
const WRITTEN = SAMPLE_COLUMNS.filter((c) => !AUTO_COLUMNS.has(c));
const insertRow = db.prepare(
  `INSERT INTO activity_samples (${WRITTEN.join(', ')}) VALUES (${WRITTEN.map((c) => `@${c}`).join(', ')})`
);
function writeMinute(t, { move = false, sound = QUIET, p75Null = false, still = STILL_OCCUPIED, frames = 300 }) {
  const [peak, p75] = sound;
  const spiky = peak > 6 && p75 <= 4;
  insertRow.run({
    camera_id: CAM,
    bucket_start: sqlTime(t),
    motion_peak: move ? 0.4 : still,
    motion_out_peak: 0.0004,
    sound_peak: peak,
    sound_p75: p75Null ? null : p75,
    motion_frames: frames, // 0 = no video in the minute (an UNWATCHED row: sleepAnalysis.js motionSeen)
    // Decoys: the opposite of the truth for every sound statistic the guard must NOT use, and a mean motion that
    // would read a still minute as moving.
    motion_level: move ? 0 : 0.5,
    motion_out_level: 0.5,
    sound_level: spiky ? 20 : 0,
    sound_p90: spiky ? 30 : 0,
    sound_sd: spiky ? 0 : 20,
    sound_windows: 300,
  });
}
const inAny = (t, ranges) => ranges.some(([a, b]) => t >= a && t < b);
// One row per minute across [from, to). `sound` is a list of [range, [peak, p75]] (first match wins); `p75Null`
// makes every p75 NULL (the old-rule twin), or only inside the ranges it lists. `unwatched` lists ranges whose rows
// are written with motion_frames = 0: the row exists and carries its sound, but the camera delivered no video.
function layNight({ from = at(16, 30), to = at(10, 0, 1), move = [], sound = [], p75Null = false, still = () => STILL_OCCUPIED, unwatched = [] } = {}) {
  for (let t = from; t < to; t = new Date(t.getTime() + 60000)) {
    const hit = sound.find(([[a, b]]) => t >= a && t < b);
    writeMinute(t, {
      move: inAny(t, move),
      sound: hit ? hit[1] : QUIET,
      p75Null: p75Null === true || (Array.isArray(p75Null) && inAny(t, p75Null)),
      still: still(t),
      frames: inAny(t, unwatched) ? 0 : 300,
    });
  }
}
const clearNight = () => {
  for (const t of ['activity_samples', 'bed_transitions', 'sleep_nights', 'sleep_reviews']) db.prepare(`DELETE FROM ${t}`).run();
};
const insertTransition = (type, when) =>
  db.prepare('INSERT INTO bed_transitions (camera_id, type, peak, created_at) VALUES (?, ?, 0.4, ?)').run(CAM, type, sqlTime(when));

// The incident's shape: settled 19:40, one real stir at 23:00 (six minutes of movement), up from 06:00 with the
// movement running to the window's close, and a microphone spiking every minute from 21:00 to 10:00.
const PUT_DOWN = [at(19, 30), at(19, 40)];
const STIR = [at(23, 0), at(23, 6)];
const MORNING = [at(6, 0, 1), at(7, 0, 1)];
const FAULT_FROM_21 = [[at(21, 0), at(10, 0, 1)], FAULT];

let server;
let adminToken;

before(async () => {
  db.prepare(`INSERT INTO settings (id, timezone) VALUES ('app', ?)
              ON CONFLICT(id) DO UPDATE SET timezone = excluded.timezone`).run(TZ);
  db.prepare(`INSERT INTO children (id, name, track_sleep, sleep_window_start, sleep_window_end)
              VALUES (?, 'Mic Kid', 1, '19:30', '07:00')`).run(CHILD);
  db.prepare(`INSERT INTO cameras (id, name, rtsp_url, child_id, mediamtx_path, sort_order, disabled)
              VALUES (?, 'Bed cam', 'rtsp://example/x', ?, 'p', 0, 0)`).run(CAM, CHILD);
  const admin = makeUser(db, { id: 'u-a', username: 'admin', role: 'admin' });
  adminToken = signToken({ sub: admin.id, sid: makeSession(db, admin.id), role: 'admin', username: 'admin' });
  server = await mountRouter('/api/children', childrenRouter);
});
beforeEach(clearNight);
after(async () => {
  await server?.close();
  db.close();
  cleanupTempDataDirs();
});

describe('#904 the faulty-microphone guard, through computeNight', () => {
  test('the incident: a microphone spiking every minute from 21:00 no longer ends the night at 21:00', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: noon() });
    layNight({ move: [PUT_DOWN, STIR, MORNING], sound: [FAULT_FROM_21], p75Null: true });
    const old = computeNight(CHILD, DATE);
    assert.equal(old.status, 'ok', 'precondition');
    assert.equal(hhmm(old.wake_at), '21:00', 'precondition: without the guard the fault reads as the child up from 21:00');
    assert.equal(old.asleep_minutes, 80);
    assert.equal(old.sound_discounted_minutes, 0, 'and nothing is discounted when no minute can be spike-only');

    clearNight();
    layNight({ move: [PUT_DOWN, STIR, MORNING], sound: [FAULT_FROM_21] });
    const night = computeNight(CHILD, DATE);
    assert.equal(night.status, 'ok');
    assert.equal(hhmm(night.onset_at), '19:40');
    assert.equal(hhmm(night.wake_at), '06:00', 'the wake is the morning movement, not the fault');
    assert.equal(night.wake_count, 1, 'the one real stir is still a wake-up: movement still counts');
    assert.equal(night.awake_minutes, 6);
    assert.equal(night.asleep_minutes, 614);
    // Every minute from 21:00 to the 06:00 wake was spike-only and inside a qualifying window, the six stir minutes
    // included (their sound was ignored; their movement was not).
    assert.equal(night.sound_discounted_minutes, 540);
  });

  test('a motionless, intermittent cry of 20 minutes (spike-only in shape) still counts as a wake-up', (t) => {
    // Expected: one wake-up of 20 minutes, nothing discounted. Every cry minute IS spike-only (peak 20 over
    // SOUND_ACTIVE, p75 1.5 under SPIKE_P75_MAX), so only persistence protects it: 20 minutes cannot fill 70% of
    // an 8-hour window. Fails if the window is made short (micGuard.js WINDOW_MIN).
    t.mock.timers.enable({ apis: ['Date'], now: noon() });
    layNight({ move: [PUT_DOWN, MORNING], sound: [[[at(2, 0, 1), at(2, 20, 1)], LOW_CRY]] });
    const night = computeNight(CHILD, DATE);
    assert.equal(night.status, 'ok');
    assert.equal(night.wake_count, 1);
    assert.equal(night.awake_minutes, 20);
    assert.equal(night.sound_discounted_minutes, 0);
  });

  test('a real cry (raised p75) inside a faulty stretch still counts', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: noon() });
    layNight({ move: [PUT_DOWN, STIR, MORNING], sound: [[[at(2, 0, 1), at(2, 10, 1)], REAL], FAULT_FROM_21] });
    const night = computeNight(CHILD, DATE);
    assert.equal(night.wake_count, 2, 'the stir, and the cry');
    assert.equal(night.awake_minutes, 16);
    assert.equal(night.sound_discounted_minutes, 530, 'the fault minutes around it, never the cry');
  });

  test('two rows for one minute: a real cry in either row keeps the minute\'s sound (the safe direction)', (t) => {
    // activity_samples can hold two rows for one minute (see the OR-merge note in sleepAnalysis.js). Here every cry
    // minute has a spike-only twin as well as the real cry: the minute is not spike-only, so the cry still counts.
    t.mock.timers.enable({ apis: ['Date'], now: noon() });
    layNight({ move: [PUT_DOWN, STIR, MORNING], sound: [[[at(2, 0, 1), at(2, 10, 1)], REAL], FAULT_FROM_21] });
    for (let m = at(2, 0, 1); m < at(2, 10, 1); m = new Date(m.getTime() + 60000)) writeMinute(m, { sound: FAULT });
    const night = computeNight(CHILD, DATE);
    assert.equal(night.wake_count, 2, 'the stir, and the cry');
    assert.equal(night.awake_minutes, 16);
    assert.equal(night.sound_discounted_minutes, 530);
  });

  test('a sustained noise of 40 minutes with no movement, inside a faulty stretch, is not discarded', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: noon() });
    layNight({ move: [PUT_DOWN, STIR, MORNING], sound: [[[at(1, 0, 1), at(1, 40, 1)], REAL], FAULT_FROM_21] });
    const night = computeNight(CHILD, DATE);
    assert.equal(night.wake_count, 2);
    assert.equal(night.awake_minutes, 46);
    assert.equal(night.sound_discounted_minutes, 500);
  });

  test('recovery: a fault that stops at 02:00 is discounted until then, and a cry at 05:00 counts again', (t) => {
    // The 05:00 cry is spike-only in shape (LOW_CRY), three hours after the fault stopped: every 8-hour window that
    // reaches it holds at most 309 spike-only minutes of 480, so it is not discounted (micGuard.js, recovery).
    t.mock.timers.enable({ apis: ['Date'], now: noon() });
    layNight({
      move: [PUT_DOWN, MORNING],
      sound: [[[at(5, 0, 1), at(5, 10, 1)], LOW_CRY], [[at(16, 30), at(2, 0, 1)], FAULT]],
    });
    const night = computeNight(CHILD, DATE);
    assert.equal(night.status, 'ok');
    assert.equal(hhmm(night.onset_at), '19:40', 'the evening fault no longer keeps the child "awake" past the put-down');
    assert.equal(night.wake_count, 1, 'the 05:00 cry');
    assert.equal(night.awake_minutes, 10);
    assert.equal(night.sound_discounted_minutes, 380, '19:40 to 02:00');
  });

  test('rows with no video (motion_frames 0) are not watched minutes: loud spikes in them are neither a fault nor discounted', (t) => {
    // 340 minutes (21:30-03:10) of rows that carry exactly the fault's sound but no video, among watched quiet minutes.
    // Counted as WATCHED spike-only minutes they fill 340/480 = 0.708 of an 8-hour window and the guard fires; read
    // as the unwatched minutes they are, the best window holds 140 watched minutes (under the 384 floor) and the
    // others hold none of them, so nothing is discounted and the night is the one with those rows absent. Fails if
    // the guard's per-minute loop drops its motionSeen check (sleepAnalysis.js, noteSound).
    const gap = [at(21, 30), at(3, 10, 1)];
    t.mock.timers.enable({ apis: ['Date'], now: noon() });

    // Precondition: the same rows WITH video are a fault, so the fixture can make the guard fire.
    layNight({ move: [PUT_DOWN, MORNING], sound: [[gap, FAULT]] });
    const watched = computeNight(CHILD, DATE);
    assert.equal(watched.status, 'ok');
    assert.equal(watched.sound_discounted_minutes, 340, 'precondition: with video the guard fires on these rows');

    clearNight();
    layNight({ move: [PUT_DOWN, MORNING], sound: [[gap, FAULT]], unwatched: [gap] });
    const night = computeNight(CHILD, DATE);
    assert.equal(night.status, 'ok');
    assert.equal(night.sound_discounted_minutes, 0, 'no video, no discount');

    // The same night with those rows absent altogether.
    db.prepare('DELETE FROM activity_samples WHERE bucket_start >= ? AND bucket_start < ?').run(sqlTime(gap[0]), sqlTime(gap[1]));
    const absent = computeNight(CHILD, DATE);
    assert.equal(absent.sound_discounted_minutes, 0);
    assert.equal(night.awake_minutes, absent.awake_minutes);
    assert.equal(night.wake_count, absent.wake_count);
    assert.equal(night.asleep_minutes, absent.asleep_minutes);
    assert.equal(hhmm(night.wake_at), hhmm(absent.wake_at));
  });

  test('a still child, a quiet zone and a faulty microphone stays ok: the guard never makes a night `empty`', (t) => {
    // The bed never moves over EMPTY_BED_MAX_PEAK (a quiet zone and a still child), so the only awake time the old
    // rule found was the fault's: a seven-hour "wake-up" from 21:00 to 04:00. With the guard that is gone, and
    // without the never-empty rule the night would be `empty`: "no one was in the bed", which also deletes the
    // night's frames once final.
    const fault = [[at(21, 0), at(4, 0, 1)], FAULT];
    t.mock.timers.enable({ apis: ['Date'], now: noon() });
    layNight({ sound: [fault], p75Null: true });
    const old = computeNight(CHILD, DATE);
    assert.equal(old.status, 'ok', 'precondition: the old rule kept this night ok, on the fault alone');
    assert.equal(old.wake_count, 1);
    assert.equal(old.awake_minutes, 420);

    clearNight();
    layNight({ sound: [fault] });
    const night = computeNight(CHILD, DATE);
    assert.equal(night.status, 'ok', 'never empty because of the guard');
    assert.equal(night.coverage_minutes, 690, 'precondition: fully watched, so nothing else stops `empty`');
    assert.equal(night.awake_minutes, 0);
    assert.equal(night.wake_count, 0);
    assert.equal(night.wake_at, null, 'still asleep at the window end');
    assert.equal(night.asleep_minutes, 690);
    assert.equal(night.sound_discounted_minutes, 420);

    // The control: the same quiet night with an ordinary microphone IS `empty` (nothing else keeps it ok).
    clearNight();
    layNight({});
    assert.equal(computeNight(CHILD, DATE).status, 'empty', 'control: the rule is what keeps the fault night ok');
  });

  test('KNOWN LIMIT (a deliberate decision): an EMPTY bed with a faulty microphone now reads as a night slept', (t) => {
    // The other side of the never-empty rule. A bed nobody is in, on a camera whose microphone is faulty, with the
    // fault running to the morning. The old rule read the fault as the child up from 21:00, measured no awake time
    // before it, and (the bed never moved) called the night `empty`: right, by accident. The guard turns the fault
    // quiet, the never-empty rule then refuses `empty` because minutes were discounted, and the night is `ok`, 690
    // minutes asleep. The rule prefers a wrong `ok` (reversible: frames kept, a parent can answer "no one was in the
    // bed") to a wrong `empty` (irreversible). Stated in KNOWN-ISSUES.md; pinned so a change to it is deliberate.
    t.mock.timers.enable({ apis: ['Date'], now: noon() });
    layNight({ sound: [FAULT_FROM_21], p75Null: true, still: () => STILL_EMPTY });
    assert.equal(computeNight(CHILD, DATE).status, 'empty', 'precondition: the old rule said nobody was there');
    clearNight();
    layNight({ sound: [FAULT_FROM_21], still: () => STILL_EMPTY });
    const night = computeNight(CHILD, DATE);
    assert.equal(night.status, 'ok');
    assert.equal(night.asleep_minutes, 690);
    assert.equal(night.sound_discounted_minutes, 600);
  });

  test('a fault that qualifies only through the post-window minutes: the extension and the window agree', (t) => {
    // Fault from 03:00 to 10:00 (4 h inside the window, 3 h after it), the child gets out at 09:30. Inside the window
    // alone the best 8-hour window holds 240 spike-only minutes (0.5); with the morning it holds 420 (0.875). So
    // the in-window minutes are discounted ONLY because the post-window ones are counted with them, which is the
    // one-pass rule (sleepAnalysis.js, the guard's wiring). Without it the in-window fault is a wake run reaching the
    // window end, the movement-only wake becomes 03:00, and #509 discards the real 09:30 exit behind the still bed.
    const lay = (p75Null) => {
      clearNight();
      layNight({
        move: [PUT_DOWN, [at(9, 20, 1), at(9, 30, 1)]],
        sound: [[[at(3, 0, 1), at(10, 0, 1)], FAULT]],
        p75Null,
        still: (m) => (m >= at(9, 30, 1) ? STILL_EMPTY : STILL_OCCUPIED),
      });
      insertTransition(TRANSITION.OUT_OF_BED, at(9, 30, 1, 30));
    };
    t.mock.timers.enable({ apis: ['Date'], now: noon() });

    lay(true);
    const old = computeNight(CHILD, DATE);
    assert.equal(hhmm(old.wake_at), '03:00', 'precondition: without the guard the fault is the wake');

    // The same night where only the POST-window minutes cannot be spike-only: the in-window fault alone does not
    // qualify, so the night reads as it did without the guard. This is the proof that the post-window minutes
    // decide it.
    lay([[at(7, 0, 1), at(10, 0, 1)]]);
    const windowOnly = computeNight(CHILD, DATE);
    assert.equal(hhmm(windowOnly.wake_at), '03:00');
    assert.equal(windowOnly.sound_discounted_minutes, 0);

    lay(false);
    const night = computeNight(CHILD, DATE);
    assert.equal(night.status, 'ok');
    assert.equal(hhmm(night.wake_at), '09:30', 'the real exit stands');
    assert.equal(hhmm(night.wake_at_algo), null, 'and the movement-only wake no longer comes from the fault');
    // The metrics run on past the window to the 09:30 exit (#352's extension). Its minutes are classified with the
    // same discount: only the ten minutes of movement before the exit are awake. If the extension counted the
    // fault's sound (its isActiveRow call losing the minute index), 07:00-09:30 would be one 150-minute wake.
    assert.equal(night.awake_minutes, 10);
    assert.equal(night.wake_count, 1);
    assert.equal(night.asleep_minutes, 820);
    assert.equal(night.sound_discounted_minutes, 390, '03:00 to the 09:30 wake, the extension included');

    // Evidence that has not arrived yet cannot count: at 07:30 the timeline ends then, the fault holds 270 minutes,
    // and nothing is discounted. The discounted set only grows as the morning's minutes arrive.
    t.mock.timers.reset();
    t.mock.timers.enable({ apis: ['Date'], now: at(7, 30, 1).getTime() });
    const early = computeNight(CHILD, DATE);
    assert.equal(early.sound_discounted_minutes, 0);
    assert.equal(hhmm(early.wake_at), '03:00');
  });

  test('the onset and post-onset view reads the discount too: a 3-minute stir in the first half hour is not a wake', (t) => {
    // In the 30 minutes after onset the analysis reads a noise as awake only when movement is within 2 minutes of it
    // (POST_ONSET_SOUND_WITNESS_MIN). A discounted spike is not a noise at all, so the 3-minute stir at 19:55 stays
    // a stir (under WAKE_ACTIVE_MIN). Were the spikes beside it still "heard", the movement would witness them and
    // the stir would grow into a 7-minute wake.
    t.mock.timers.enable({ apis: ['Date'], now: noon() });
    layNight({ move: [PUT_DOWN, [at(19, 55), at(19, 58)], MORNING], sound: [[[at(16, 30), at(10, 0, 1)], FAULT]] });
    const night = computeNight(CHILD, DATE);
    assert.equal(hhmm(night.onset_at), '19:40');
    assert.equal(night.wake_count, 0);
    assert.equal(night.awake_minutes, 0);
    assert.equal(hhmm(night.wake_at), '06:00');
  });

  test('a night that does not trigger is exactly the old rule\'s night, the whole detail payload, plus the 0', (t) => {
    // Ordinary household noise: a few spike-only minutes, a 30-minute burst of them, and a real cry.
    t.mock.timers.enable({ apis: ['Date'], now: noon() });
    const sound = [
      [[at(20, 15), at(20, 45)], FAULT],
      [[at(1, 0, 1), at(1, 8, 1)], REAL],
      [[at(3, 0, 1), at(3, 1, 1)], FAULT],
      [[at(4, 30, 1), at(4, 31, 1)], LOW_CRY],
    ];
    layNight({ move: [PUT_DOWN, STIR, MORNING], sound, p75Null: true });
    insertTransition(TRANSITION.INTO_BED, at(19, 31));
    const old = json(computeNight(CHILD, DATE, { includeTimeline: true }));
    clearNight();
    layNight({ move: [PUT_DOWN, STIR, MORNING], sound });
    insertTransition(TRANSITION.INTO_BED, at(19, 31));
    const night = json(computeNight(CHILD, DATE, { includeTimeline: true }));
    assert.equal(night.status, 'ok', 'precondition');
    assert.ok(night.timeline.length > 0 && night.segments.length > 0, 'precondition: the whole detail payload');
    assert.equal(night.sound_discounted_minutes, 0);
    assert.deepEqual(night, old);
  });

  test('the worst ordinary night Phase 0 found (82 spike-only minutes in a row, half of an 8-hour window) does not trigger', (t) => {
    // Shaped like the worst ordinary night Phase 0 measured (2026-10-08): noise from elsewhere in the home while the child slept, 82 consecutive
    // spike-only minutes and, with two more runs of 80, a worst 8-hour window of 242/480 = 0.504, the highest share
    // any ordinary night reached. It stays exactly as the old rule read it (three long wake-ups: the guard is not a
    // fix for that night, and must not change it).
    t.mock.timers.enable({ apis: ['Date'], now: noon() });
    const sound = [
      [[at(21, 0), at(22, 22)], FAULT],
      [[at(23, 0), at(0, 20, 1)], FAULT],
      [[at(1, 0, 1), at(2, 20, 1)], FAULT],
    ];
    layNight({ move: [PUT_DOWN, MORNING], sound, p75Null: true });
    const old = json(computeNight(CHILD, DATE, { includeTimeline: true }));
    clearNight();
    layNight({ move: [PUT_DOWN, MORNING], sound });
    const night = json(computeNight(CHILD, DATE, { includeTimeline: true }));
    assert.equal(night.sound_discounted_minutes, 0);
    assert.equal(night.wake_count, 3, 'precondition: the old rule reads the three runs as wake-ups');
    assert.deepEqual(night, old);
  });

  test('a night in progress gets no discount until 480 minutes of its timeline exist (5 h into a window, here)', (t) => {
    // The timeline starts 3 h before the 19:30 window: at 00:29 it holds 479 minutes, no 8-hour window fits, and the
    // fault reads as awake ("tonight so far" has no clear sleep); at 00:30 the first window fits and qualifies.
    layNight({ move: [PUT_DOWN], sound: [[[at(16, 30), at(10, 0, 1)], FAULT]] });
    t.mock.timers.enable({ apis: ['Date'], now: at(0, 29, 1).getTime() });
    const before = computeNight(CHILD, DATE);
    assert.equal(before.in_progress, true, 'precondition');
    assert.equal(before.status, 'no_sleep', 'the fault still reads as awake');
    assert.equal(before.sound_discounted_minutes, null, 'no span, so no count');
    t.mock.timers.reset();
    t.mock.timers.enable({ apis: ['Date'], now: at(0, 30, 1).getTime() });
    const after = computeNight(CHILD, DATE);
    assert.equal(after.status, 'ok');
    assert.equal(hhmm(after.onset_at), '19:40');
    assert.equal(after.sound_discounted_minutes, 290, '19:40 to 00:30');
  });
});

describe('#904 sound_discounted_minutes after computeNight: the route, a correction, the stored row', () => {
  const layFaultNight = () => layNight({ move: [PUT_DOWN, STIR, MORNING], sound: [FAULT_FROM_21] });
  const insertReview = (cols) => db.prepare(
    `INSERT INTO sleep_reviews (child_id, night_date, ${Object.keys(cols).join(', ')}) VALUES (?, ?, ${Object.keys(cols).map(() => '?').join(', ')})`
  ).run(CHILD, DATE, ...Object.values(cols));

  test('the detail route carries it (an added key), and every other status carries null', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: noon() });
    layFaultNight();
    const res = await call(`${server.url}/api/children/${CHILD}/sleep/${DATE}?detail=1`, { token: adminToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.sound_discounted_minutes, 540);
    clearNight();
    const none = await call(`${server.url}/api/children/${CHILD}/sleep/${DATE}`, { token: adminToken });
    assert.equal(none.body.status, 'no_data', 'precondition');
    assert.ok('sound_discounted_minutes' in none.body, 'the key is on every status');
    assert.equal(none.body.sound_discounted_minutes, null);
  });

  test('"no one was in the bed" nulls it, like a detector-empty night; a time correction keeps it', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: noon() });
    layFaultNight();
    const fresh = computeNight(CHILD, DATE);
    assert.equal(fresh.sound_discounted_minutes, 540, 'precondition');
    insertReview({ nobody_in_bed: 1 });
    const flagged = applyCorrection(CHILD, fresh);
    assert.equal(flagged.status, 'empty', 'precondition: the parent overruled the night');
    assert.ok('sound_discounted_minutes' in flagged);
    assert.equal(flagged.sound_discounted_minutes, null, 'a night nobody slept in has no span to count');

    db.prepare('DELETE FROM sleep_reviews').run();
    insertReview({ true_wake_at: sqlTime(at(6, 30, 1)) });
    const corrected = applyCorrection(CHILD, fresh);
    assert.equal(corrected.corrected, true, 'precondition');
    assert.equal(corrected.sound_discounted_minutes, 540, 'kept as measured over the original span, like awake_minutes');
    // Not the corrected span's own count: a wake corrected to 06:30 would hold 570 discounted minutes (the fault runs on
    // to 10:00), and a night corrected to 19:40-20:30, wholly before the fault, would hold none. The count stays the
    // detector's (docs/sleep-tracking.md, "A microphone that looks faulty").
    db.prepare('DELETE FROM sleep_reviews').run();
    insertReview({ true_onset_at: sqlTime(at(19, 40)), true_wake_at: sqlTime(at(20, 30)) });
    const before = applyCorrection(CHILD, fresh);
    assert.equal(before.corrected, true, 'precondition');
    assert.equal(hhmm(before.wake_at), '20:30', 'precondition: the displayed span ends before the fault starts (21:00)');
    assert.equal(before.sound_discounted_minutes, 540, 'still the detector\'s count, over the span it worked out');
  });

  test('storing the night works and stores no count (there is no column); the stored row and its overlay never gain the key', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: noon() });
    layFaultNight();
    const summary = computeAndStoreNight(CHILD, DATE);
    assert.equal(summary.stored, true);
    assert.equal(summary.sound_discounted_minutes, 540, 'the answer carries it');
    const columns = db.prepare('PRAGMA table_info(sleep_nights)').all().map((c) => c.name);
    assert.ok(!columns.some((c) => c.includes('discount')), 'no column for it');
    const row = db.prepare('SELECT * FROM sleep_nights WHERE child_id = ? AND night_date = ?').get(CHILD, DATE);
    assert.equal(row.awake_minutes, 6, 'the stored figures are the guarded ones');
    assert.equal(row.wake_at, summary.wake_at);
    insertReview({ nobody_in_bed: 1 });
    assert.ok(!('sound_discounted_minutes' in applyCorrection(CHILD, row)), 'a stored row overlaid: no key is invented');
  });
});
