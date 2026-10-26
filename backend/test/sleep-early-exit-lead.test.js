// #700: an exit far earlier than this child ever gets up must not end the whole night on its own.
//
// The bug (measured, one house, prod and staging agree): on 4 of 84 recomputable nights a single false
// `out_of_bed` followed by a still child passed every clause of the departure scan and ended the night 3 to
// 10.5 hours early ("asleep 58 min" pushed for a 10.5-hour night). A sleeping child and an empty bed read the
// same to the bed zone, so nothing about the BED separates them; the exit's LEAD (how long before the
// night's window end it happened) against the same child's earlier nights does. See LEAD_FACTOR in
// sleepAnalysis.js for the measurement and every limit, and docs/sleep-tracking.md for the user-facing text.
//
// Every fixture here is a SYNTHETIC per-minute timeline plus planted bed_transitions and planted earlier
// sleep_nights rows (the "history"). The night under test is 2026-07-15, Australia/Melbourne (UTC+10 in July,
// no DST edge), window 19:30-07:00, so its window_end is 07:00 local the next morning (21:00 UTC). A history
// row for night d has window_end 07:00 local the morning after d and wake_at = window_end - lead.
//
// RED ON THE OLD CODE: every test that asserts a skip (or `wake_unconfirmed`) fails on dev before #700, where
// the early exit is accepted. Tests that assert an UNCHANGED outcome (the exit still ends the night, or a
// genuine morning exit is still taken) also assert `wake_unconfirmed === null`, a key that did not exist
// before #700, and that is what makes them fail on the old code; their other assertions pin that the rule
// leaves those nights alone.

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, signToken, mountRouter, call } from './helpers/harness.js';

useTempDataDir();

const { default: db } = await import('../src/db.js');
const {
  computeNight, computeAndStoreNight, runNightlySleepJob, priorWakeLeadReadsForTest, SCORING_ALGO, zonedToUtc,
} = await import('../src/lib/sleepAnalysis.js');
const { logger } = await import('../src/lib/logger.js');
const { saveNightReview, getNightReview } = await import('../src/lib/sleepReviews.js');
const { default: childrenRouter } = await import('../src/routes/children.js');

const CHILD = 'lead-child';
const CAM = 'lead-cam';
const CAM2 = 'lead-cam-2';
const DATE = '2026-07-15';
const TZ = 'Australia/Melbourne';
const TZ_OFF = 10 * 3600 * 1000;

// A local wall-clock time on the night of DATE (dayShift 1 = the following morning) as a UTC Date.
const at = (h, m, dayShift = 0, s = 0) => new Date(Date.UTC(2026, 6, 15 + dayShift, h, m, s) - TZ_OFF);
const sqlTime = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
const hhmm = (u) =>
  u ? new Date(u.replace(' ', 'T') + 'Z').toLocaleString('en-AU', { timeZone: TZ, hour12: false, hour: '2-digit', minute: '2-digit' }) : null;

// The in-bed reading of a still minute. STILL_OCCUPIED (a still sleeper's micro-motion, below MOTION_ACTIVE)
// is the default because the false exits this rule exists for are followed by a child who IS in the bed;
// STILL_EMPTY is a bed nobody is in. Both read as "quiet" to the departure scan, which is the whole problem.
const STILL_OCCUPIED = 0.004;
const STILL_EMPTY = 0.0002;

const insertSample = db.prepare(
  `INSERT INTO activity_samples (camera_id, bucket_start, motion_level, motion_peak, sound_level, sound_peak,
     motion_out_peak, motion_frames, sound_windows) VALUES (?, ?, ?, ?, 0, ?, ?, 1, 0)`
);
const insertTransition = db.prepare('INSERT INTO bed_transitions (camera_id, type, peak, out_frames, created_at) VALUES (?, ?, ?, ?, ?)');

// One sample per minute over [from, to).
//   bed:   [from, to, peak?] in-bed movement (default 0.4, real movement).
//   room:  [from, to] somebody in the room: movement OUTSIDE the bed zone (0.2) and a clear noise (12 dB).
//   gaps:  [from, to] no row at all (a camera outage).
//   still: [[when, value], ...] the still reading from `when` on (default STILL_OCCUPIED).
function layNight({ cam = CAM, bed = [], room = [], gaps = [], still = [], from = at(19, 0), to = at(7, 0, 1) } = {}) {
  db.exec('BEGIN');
  for (let t = from; t < to; t = new Date(t.getTime() + 60000)) {
    if (gaps.some(([a, b]) => t >= a && t < b)) continue;
    const moving = bed.find(([a, b]) => t >= a && t < b);
    let quiet = STILL_OCCUPIED;
    for (const [when, v] of still) if (t >= when) quiet = v;
    const inRoom = room.some(([a, b]) => t >= a && t < b);
    const peak = moving ? (moving[2] ?? 0.4) : quiet;
    insertSample.run(cam, sqlTime(t), peak, peak, inRoom ? 12 : 0, inRoom ? 0.2 : 0);
  }
  db.exec('COMMIT');
}
const exit = (when, { cam = CAM, peak = 0.04, frames = 4 } = {}) => insertTransition.run(cam, 'out_of_bed', peak, frames, sqlTime(when));

// THE SHAPE THIS FIXES: settling 19:30-19:40 (real movement, so the night is plainly occupied and stays `ok`,
// see EMPTY_BED_MAX_PEAK), one stir and an out_of_bed at 20:30:20, then a still child until the window closes.
// Its lead is 07:00 - 20:30 = 630 minutes, the largest measured lead (the "asleep 58 min" night was 630 too).
// `stir` is the in-bed movement of the exit itself: a WEAK one-frame exit by default.
function layFalseExitNight({ stir = [[at(20, 30), at(20, 31), 0.02]], peak = 0.02, frames = 1, extraBed = [], gaps = [], still = [] } = {}) {
  layNight({ bed: [[at(19, 30), at(19, 40)], ...stir, ...extraBed], gaps, still });
  exit(at(20, 30, 0, 20), { peak, frames });
}
const FALSE_EXIT_AT = '2026-07-15 10:30:20'; // 20:30:20 local, as stored

// A genuine exit at local h:m on the morning after: a two-minute stir, the out_of_bed 10 s into the minute,
// and an empty bed from then on.
function layMorningExitNight(h, m) {
  layNight({ bed: [[at(19, 30), at(19, 40)], [at(h, m - 1, 1), at(h, m + 1, 1)]], still: [[at(h, m + 1, 1), STILL_EMPTY]] });
  exit(at(h, m, 1, 10));
}

// Earlier stored nights for `childId`, newest first: leads[0] is the night before DATE, leads[1] the one
// before that, and so on. Each row is a scored night with a wake, `lead` minutes before its own window end.
// `skipped` plants instead a night whose departure candidate the lead test SKIPPED, `lead` minutes before its
// window end: `wake_unconfirmed_at` set (20 s into the minute, as an exit's time is), `wake_at` NULL (a quiet
// room: no later wake) unless `wakeAt` gives one.
const insertNight = db.prepare(
  `INSERT INTO sleep_nights (child_id, night_date, window_start, window_end, status, wake_at, scoring_context,
     wake_unconfirmed_at, computed_at)
   VALUES (@child_id, @night_date, @window_start, @window_end, @status, @wake_at, @scoring_context,
     @wake_unconfirmed_at, @computed_at)`
);
const dateOf = (dayShift) => new Date(Date.UTC(2026, 6, 15 + dayShift)).toISOString().slice(0, 10);
function plantNight(dayShift, lead, { childId = CHILD, status = 'ok', endHm = [7, 0], wakeAt, context = null, skipped = false } = {}) {
  const windowEnd = at(endHm[0], endHm[1], dayShift + 1);
  const leadAt = new Date(windowEnd.getTime() - lead * 60000);
  insertNight.run({
    child_id: childId,
    night_date: dateOf(dayShift),
    window_start: sqlTime(at(19, 30, dayShift)),
    window_end: sqlTime(windowEnd),
    status,
    wake_at: wakeAt !== undefined ? wakeAt : skipped ? null : sqlTime(leadAt),
    scoring_context: context,
    wake_unconfirmed_at: skipped ? sqlTime(new Date(leadAt.getTime() + 20000)) : null,
    computed_at: sqlTime(windowEnd),
  });
}
function plantHistory(leads, opts = {}) {
  leads.forEach((lead, i) => plantNight(-(i + 1), lead, opts));
}
// A child who is usually up 5-55 minutes before the window closes: p75 (index floor(0.75 x 14) = 10 of the
// sorted list) is 40, so the threshold is 2 x max(40, 30) = 80 minutes.
const NORMAL = [5, 10, 15, 20, 20, 25, 30, 30, 35, 40, 40, 45, 50, 55];
const LONG = 600; // an earlier night that was itself ended by a false exit

// A whole night `day` days after DATE (0 is DATE itself): settling 19:30-19:40, a still child, and a GENUINE exit
// at local `exitHm` the next morning, the bed empty after it. `room` adds somebody in the room from `room[0]` to
// `room[1]` (local [h, m] the next morning): movement outside the bed and a clear noise.
function layRoutineNight(day, exitHm, { room = null } = {}) {
  const [h, m] = exitHm;
  layNight({
    from: at(19, 0, day),
    to: at(7, 0, day + 1),
    bed: [[at(19, 30, day), at(19, 40, day)], [at(h, m - 1, day + 1), at(h, m + 1, day + 1)]],
    still: [[at(h, m + 1, day + 1), STILL_EMPTY]],
    room: room ? [[at(room[0][0], room[0][1], day + 1), at(room[1][0], room[1][1], day + 1)]] : [],
  });
  exit(at(h, m, day + 1, 10));
}

const storedRow = (date = DATE) => db.prepare('SELECT * FROM sleep_nights WHERE child_id = ? AND night_date = ?').get(CHILD, date);
const storedFigures = (r) => ({
  status: r.status, wake_at: r.wake_at, asleep_minutes: r.asleep_minutes, awake_minutes: r.awake_minutes,
  unknown_minutes: r.unknown_minutes, wake_count: r.wake_count, longest_stretch_minutes: r.longest_stretch_minutes,
});
// How many times computeNight read the history while running `fn` (the test seam in sleepAnalysis.js).
function historyReadsDuring(fn) {
  const before = priorWakeLeadReadsForTest();
  const out = fn();
  return { out, reads: priorWakeLeadReadsForTest() - before };
}

let server;
let adminToken;

before(async () => {
  db.prepare(`INSERT INTO settings (id, timezone) VALUES ('app', ?)
              ON CONFLICT(id) DO UPDATE SET timezone = excluded.timezone`).run(TZ);
  const admin = makeUser(db, { id: 'u-lead', username: 'admin', role: 'admin' });
  adminToken = signToken({ sub: admin.id, sid: makeSession(db, admin.id), role: 'admin', username: 'admin' });
  server = await mountRouter('/api/children', childrenRouter);
});

beforeEach(() => {
  for (const t of ['sleep_reviews', 'sleep_nights', 'activity_samples', 'bed_transitions', 'cameras', 'children']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  db.prepare(`INSERT INTO children (id, name, track_sleep, sleep_window_start, sleep_window_end)
              VALUES (?, 'Lead Kid', 1, '19:30', '07:00')`).run(CHILD);
  db.prepare(`INSERT INTO cameras (id, name, rtsp_url, child_id, mediamtx_path, sort_order, disabled)
              VALUES (?, 'Bed cam', 'rtsp://example/x', ?, 'p1', 0, 0)`).run(CAM, CHILD);
});

after(async () => {
  await server?.close();
  db.close();
  cleanupTempDataDirs();
});

// --- 1-2. the false exit no longer ends the night, whatever its strength ------------------------------------

describe('#700 a far-early exit is not the night\'s departure', () => {
  test('#700 T1: a weak one-frame exit followed by hours of flat bed does not end the night', () => {
    plantHistory(NORMAL);
    layFalseExitNight();
    const night = computeNight(CHILD, DATE);
    // On dev before #700: ok, wake 20:30, asleep 50 minutes (the exit was taken).
    assert.equal(night.status, 'ok', 'the settling movement keeps the night occupied, not `empty`');
    assert.equal(night.wake_at, null, 'nothing later qualifies, so the movement-only wake stands: still asleep at the close');
    assert.deepEqual(night.wake_unconfirmed, { at: FALSE_EXIT_AT, lead_min: 630, threshold_min: 80 });
    assert.ok(night.wake_unconfirmed.lead_min > night.wake_unconfirmed.threshold_min);
    // The STORED row is what the card and the push read, so the stored fields are pinned exactly.
    computeAndStoreNight(CHILD, DATE, { allowDowngrade: false });
    assert.deepEqual(storedFigures(storedRow()), {
      status: 'ok', wake_at: null, asleep_minutes: 680, awake_minutes: 0, unknown_minutes: 0, wake_count: 0,
      longest_stretch_minutes: 680, // 19:40 to 07:00
    });
    assert.equal(storedRow().wake_unconfirmed_at, FALSE_EXIT_AT, 'the skip is stored: later nights read it as this night\'s departure');
  });

  test('#700 T2: a strong exit (14 frames, peak 0.1, three minutes of movement) is not taken either', () => {
    // The rule never reads the exit's strength: on the measured nights real exits were often WEAKER than the
    // false ones (see the reversal guard's comment), so strength cannot be what separates them.
    plantHistory(NORMAL);
    layFalseExitNight({ stir: [[at(20, 28), at(20, 31), 0.12]], peak: 0.1, frames: 14 });
    const night = computeNight(CHILD, DATE);
    assert.equal(night.wake_at, null);
    assert.deepEqual(night.wake_unconfirmed, { at: FALSE_EXIT_AT, lead_min: 630, threshold_min: 80 });
    assert.equal(night.asleep_minutes, 680);
  });

  test('#700 T2b: minutes missing after the skipped exit count as unknown, not asleep', () => {
    // Codex plan review: once the exit is skipped the sleep span runs to the close, so an outage after it is
    // now INSIDE the span. It is unknown (#442), and it breaks the longest stretch.
    plantHistory(NORMAL);
    layFalseExitNight({ gaps: [[at(2, 0, 1), at(3, 0, 1)]] });
    computeAndStoreNight(CHILD, DATE, { allowDowngrade: false });
    // On dev before #700: wake 20:30, asleep 50, unknown 0 (the outage lay after the accepted exit).
    assert.deepEqual(storedFigures(storedRow()), {
      status: 'ok', wake_at: null, asleep_minutes: 620, awake_minutes: 0, unknown_minutes: 60, wake_count: 0,
      longest_stretch_minutes: 380, // 19:40 to 02:00
    });
  });

  test('#700 T2c: of two skipped exits, the EARLIEST is reported, and the history is read once', () => {
    plantHistory(NORMAL);
    layFalseExitNight({ extraBed: [[at(23, 0), at(23, 1), 0.02]] });
    exit(at(23, 0, 0, 30)); // a second false exit, lead 480
    const { out: night, reads } = historyReadsDuring(() => computeNight(CHILD, DATE));
    assert.equal(night.wake_at, null);
    assert.equal(night.wake_unconfirmed.at, FALSE_EXIT_AT, 'the 20:30 exit, not the 23:00 one');
    assert.equal(reads, 1, 'two early exits, one read of the history');
  });
});

// --- 3. too little history: exactly as before -------------------------------------------------------------

describe('#700 history minimum', () => {
  test('#700 T3: with 9 earlier nights (one below the minimum) the exit still ends the night, as before', () => {
    plantHistory(NORMAL.slice(0, 9));
    layFalseExitNight();
    const night = computeNight(CHILD, DATE);
    assert.equal(hhmm(night.wake_at), '20:30', 'unchanged from dev: the exit is taken');
    assert.equal(night.asleep_minutes, 50);
    assert.equal(night.wake_unconfirmed, null, 'red on the old code: the key did not exist');
  });

  test('#700 T3b: with exactly 10 the rule applies (so back-filling ONE earlier night changes this one)', () => {
    // The other half of the boundary, and the causal-history hazard stated in SCORING_ALGO's comment: the
    // night's own samples and transitions are identical to T3's; only the number of earlier stored rows moved.
    plantHistory(NORMAL.slice(0, 10)); // p75 = 30 (index 7), so the threshold is the 60-minute floor
    layFalseExitNight();
    const night = computeNight(CHILD, DATE);
    assert.equal(night.wake_at, null);
    assert.deepEqual(night.wake_unconfirmed, { at: FALSE_EXIT_AT, lead_min: 630, threshold_min: 60 });
  });

  test('#700 T3c: earlier rows with no wake, or not scored `ok`, are not history', () => {
    // 9 real rows plus one `ok` night that read "still asleep" (wake_at NULL) plus one planted non-ok row that
    // carries a wake time anyway (the writer never stores one, but the query must not depend on that) plus one
    // `ok` row whose wake does not parse (a hand-edited database). None counts, so the child stays at 9: off.
    plantHistory(NORMAL.slice(0, 9));
    plantNight(-10, 0, { wakeAt: null });
    plantNight(-11, 20, { status: 'no_data' });
    plantNight(-12, 0, { wakeAt: 'not a time' });
    layFalseExitNight();
    const night = computeNight(CHILD, DATE);
    assert.equal(hhmm(night.wake_at), '20:30');
    assert.equal(night.wake_unconfirmed, null);
  });
});

// --- 4-6. the boundary, the floor, and the genuine morning --------------------------------------------------

describe('#700 the threshold', () => {
  test('#700 T4: a genuine morning exit is taken, and an ordinary morning never reads the history', () => {
    plantHistory(NORMAL);
    layMorningExitNight(6, 30); // lead 30, inside the child's usual 5-55
    const { out: night, reads } = historyReadsDuring(() => computeNight(CHILD, DATE));
    assert.equal(hhmm(night.wake_at), '06:30', 'unchanged from dev');
    assert.equal(night.asleep_minutes, 650);
    assert.equal(night.wake_unconfirmed, null, 'red on the old code: the key did not exist');
    assert.equal(reads, 0, 'a lead under LEAD_FACTOR x LEAD_FLOOR_MIN (60) can never trip, so no query');
  });

  // p75 = 45 (index 10 of the sorted 14), so the threshold is 2 x 45 = 90 minutes.
  const P45 = [5, 10, 15, 20, 25, 30, 35, 40, 40, 45, 45, 45, 50, 50];

  test('#700 T5: an exit exactly at the threshold is taken (lead 90, threshold 90)', () => {
    plantHistory(P45);
    layMorningExitNight(5, 30); // 05:30:10, truncated to 05:30: lead 90
    const night = computeNight(CHILD, DATE);
    assert.equal(hhmm(night.wake_at), '05:30');
    assert.equal(night.wake_unconfirmed, null);
  });

  test('#700 T5b: one minute above it is skipped (lead 91), so the test is a strict >', () => {
    plantHistory(P45);
    layMorningExitNight(5, 29); // 05:29:10: lead 91
    const night = computeNight(CHILD, DATE);
    // On dev before #700: wake 05:29, asleep 589.
    assert.equal(night.wake_at, null);
    assert.deepEqual(night.wake_unconfirmed, { at: '2026-07-15 19:29:10', lead_min: 91, threshold_min: 90 });
  });

  // A child who usually wakes at or after the close: p75 (index 10) is 15, under the floor.
  const TINY = [-30, -20, -10, 0, 0, 5, 5, 10, 10, 10, 15, 15, 15, 20];

  test('#700 T6: the floor: with a p75 of 15 the threshold is 60, not 30, so a lead of 45 is taken', () => {
    plantHistory(TINY);
    layMorningExitNight(6, 15); // lead 45: over 2 x 15, under the floor's 60
    const night = computeNight(CHILD, DATE);
    assert.equal(hhmm(night.wake_at), '06:15');
    assert.equal(night.wake_unconfirmed, null);
  });

  test('#700 T6b: ...and a lead of 61 is skipped against a threshold of 60', () => {
    plantHistory(TINY);
    layMorningExitNight(5, 59);
    const night = computeNight(CHILD, DATE);
    assert.equal(night.wake_at, null);
    assert.deepEqual(night.wake_unconfirmed, { at: '2026-07-15 19:59:10', lead_min: 61, threshold_min: 60 });
  });
});

// --- 7. a later genuine exit still wins ---------------------------------------------------------------------

describe('#700 the scan goes on', () => {
  test('#700 T7: a skipped early exit followed by a genuine morning exit in a later gap: the morning wins', () => {
    plantHistory(NORMAL);
    // The false exit at 20:30, a still child until a morning stir 06:34-06:40, the real exit at 06:40, gone.
    layFalseExitNight({ extraBed: [[at(6, 34, 1), at(6, 40, 1)]], still: [[at(6, 40, 1), STILL_EMPTY]] });
    exit(at(6, 40, 1, 5));
    const night = computeNight(CHILD, DATE);
    // On dev before #700: wake 20:30, asleep 50.
    assert.equal(hhmm(night.wake_at), '06:40', 'a distinct, later gap corroborated by its own exit');
    assert.equal(night.asleep_minutes, 654);
    assert.equal(night.wake_count, 1, 'the six-minute morning stir before it');
    assert.deepEqual(night.wake_unconfirmed, { at: FALSE_EXIT_AT, lead_min: 630, threshold_min: 80 },
      'still set: it says the earlier exit was not trusted');
  });

  test('#700 T7b: an exit the settling-tail guard would hand back is not handed back when it is far early', () => {
    // A stray into_bed 30 s before the false exit, over a still sleeper: the settling-tail guard sets the exit
    // aside, and with no later exit its fallback used to hand it back (dev before #700: wake 20:30, asleep 50).
    // Here the skip DID change the night (no `best` won, so the hand-back would have been the wake), so it is
    // recorded, unlike T7c's, where a later exit wins anyway.
    plantHistory(NORMAL);
    layFalseExitNight();
    insertTransition.run(CAM, 'into_bed', 0.02, 1, sqlTime(at(20, 29, 0, 50)));
    const night = computeNight(CHILD, DATE);
    assert.equal(night.wake_at, null);
    assert.deepEqual(night.wake_unconfirmed, { at: FALSE_EXIT_AT, lead_min: 630, threshold_min: 80 });
  });

  test('#700 T7c: a fallback-site skip is NOT recorded when a later exit wins anyway (the rule changed nothing)', () => {
    // PR #888 round 2 (Opus A5): the evening exit sits behind a stray into_bed, so the settling-tail guard has set
    // it aside already; the genuine 06:30 exit wins whether or not the rule exists. Recording a skip here would
    // teach later nights a 20:30 departure that never was. The night must be exactly the rule-off night.
    layFalseExitNight({ extraBed: [[at(6, 28, 1), at(6, 30, 1)]], still: [[at(6, 30, 1), STILL_EMPTY]] });
    insertTransition.run(CAM, 'into_bed', 0.02, 1, sqlTime(at(20, 29, 0, 50)));
    exit(at(6, 30, 1, 15));
    const ruleOff = computeNight(CHILD, DATE, { includeTimeline: true }); // no history: the rule cannot fire
    plantHistory(NORMAL);
    const { out: night, reads } = historyReadsDuring(() => computeNight(CHILD, DATE, { includeTimeline: true }));
    assert.equal(reads, 1, 'precondition: the rule did look at the evening exit');
    assert.equal(hhmm(night.wake_at), '06:30');
    assert.equal(night.wake_unconfirmed, null);
    assert.deepEqual(night, ruleOff, 'the whole night, timeline included, as with the rule off');
    computeAndStoreNight(CHILD, DATE, { allowDowngrade: false });
    assert.equal(storedRow().wake_unconfirmed_at, null, 'and nothing is stored for the history');
  });

  test('#700 T7d: four such nights do not switch the rule off: a plain false exit after them is still skipped', () => {
    // Opus A6: under the fix-round-1 disarm those four nights each stored a flag, so the fifth night's false exit
    // was taken. Now they store nothing and their history lead is their 06:30 wake (30), so the rule stands.
    plantHistory(NORMAL, {});
    for (let day = 0; day < 4; day++) {
      layNight({
        from: at(19, 0, day), to: at(7, 0, day + 1),
        bed: [[at(19, 30, day), at(19, 40, day)], [at(20, 30, day), at(20, 31, day), 0.02], [at(6, 28, day + 1), at(6, 30, day + 1)]],
        still: [[at(6, 30, day + 1), STILL_EMPTY]],
      });
      insertTransition.run(CAM, 'into_bed', 0.02, 1, sqlTime(at(20, 29, day, 50)));
      exit(at(20, 30, day, 20), { peak: 0.02, frames: 1 });
      exit(at(6, 30, day + 1, 15));
      const s = computeAndStoreNight(CHILD, dateOf(day), { allowDowngrade: false });
      assert.equal(hhmm(s.wake_at), '06:30', `night ${day}`);
      assert.equal(storedRow(dateOf(day)).wake_unconfirmed_at, null, `night ${day}`);
    }
    layNight({ from: at(19, 0, 4), to: at(7, 0, 5), bed: [[at(19, 30, 4), at(19, 40, 4)], [at(20, 30, 4), at(20, 31, 4), 0.02]] });
    exit(at(20, 30, 4, 20), { peak: 0.02, frames: 1 });
    const fifth = computeNight(CHILD, dateOf(4));
    assert.equal(fifth.wake_at, null, 'skipped');
    assert.equal(fifth.wake_unconfirmed?.lead_min, 630);
  });
});

// --- 8. the history is causal, and what pollutes it ---------------------------------------------------------

describe('#700 the history', () => {
  test('#700 T8: rows for this night and later nights are never read', () => {
    // 9 earlier nights (the rule is off), plus this night's own row and two later nights, all short leads.
    // Counted, any of the three would take the child to 10 and skip the exit.
    plantHistory(NORMAL.slice(0, 9));
    plantNight(0, 10);
    plantNight(1, 10);
    plantNight(2, 10);
    layFalseExitNight();
    const night = computeNight(CHILD, DATE);
    assert.equal(hhmm(night.wake_at), '20:30', 'still 9 earlier nights: the rule stays off');
    assert.equal(night.wake_unconfirmed, null);
    db.prepare('DELETE FROM sleep_nights WHERE night_date >= ?').run(DATE);
    assert.deepEqual(computeNight(CHILD, DATE), night, 'the same answer with those rows gone');
  });

  test('#700 T8b: one earlier wrong night (a very long lead) does not stop the rule', () => {
    plantHistory([...NORMAL.slice(0, 13), LONG]);
    layFalseExitNight();
    assert.equal(computeNight(CHILD, DATE).wake_unconfirmed?.threshold_min, 80);
  });

  // KNOWN LIMIT, pinned with the counts that move the percentile: p75 of n is the element at index
  // floor(0.75 n), so it moves once n - floor(0.75 n) rows are long. 14 rows: 3 long still fire, 4 do not.
  test('#700 T8c: of 14 earlier nights, 3 long ones leave the threshold alone', () => {
    plantHistory([...NORMAL.slice(0, 11), LONG, LONG, LONG]);
    layFalseExitNight();
    const night = computeNight(CHILD, DATE);
    assert.equal(night.wake_at, null);
    assert.equal(night.wake_unconfirmed.threshold_min, 80);
  });

  test('#700 T8d: KNOWN LIMIT: of 14 earlier nights, 4 long ones disable the rule for the next false exit', () => {
    // The four measured wrong nights fell inside 8 days for one child: a run of them is a real possibility.
    plantHistory([...NORMAL.slice(0, 10), LONG, LONG, LONG, LONG]);
    layFalseExitNight();
    const night = computeNight(CHILD, DATE);
    assert.equal(hhmm(night.wake_at), '20:30', 'threshold 1200: the exit is taken, as before #700');
    assert.equal(night.wake_unconfirmed, null);
  });

  test('#700 T8e: of 10 earlier nights, 2 long ones leave the threshold alone', () => {
    plantHistory([...NORMAL.slice(0, 8), LONG, LONG]);
    layFalseExitNight();
    assert.equal(computeNight(CHILD, DATE).wake_unconfirmed?.threshold_min, 60);
  });

  test('#700 T8f: KNOWN LIMIT: of 10 earlier nights, 3 long ones disable it', () => {
    plantHistory([...NORMAL.slice(0, 7), LONG, LONG, LONG]);
    layFalseExitNight();
    const night = computeNight(CHILD, DATE);
    assert.equal(hhmm(night.wake_at), '20:30');
    assert.equal(night.wake_unconfirmed, null);
  });

  test('#700 T8g: only the newest 14 earlier nights count', () => {
    // The newest 14 hold 3 long leads (the three OLDEST of them): the rule fires. A 15th, older still, is long
    // too. Counted (a limit of 15), or the oldest 14 taken instead of the newest, the long rows would be 4.
    plantHistory([...NORMAL.slice(0, 11), LONG, LONG, LONG, LONG]);
    layFalseExitNight();
    const night = computeNight(CHILD, DATE);
    assert.equal(night.wake_at, null);
    assert.equal(night.wake_unconfirmed.threshold_min, 80);
  });

  test('#700 T8h: earlier nights with ANOTHER window end are not history, so after a change the rule is off', () => {
    // THE WINDOW-END MATCH (PR #888 review). Fourteen nights saved with a window ending 05:00 (from another camera,
    // per their saved context), each up 10 minutes before it; this night's window ends 07:00. Counted, their leads
    // would say "this child is up just before 05:00" and skip an ordinary 05:00 wake that is 120 minutes before
    // 07:00. None of them matches, so the child has no history for this window and the night is worked out
    // exactly as before #700: the exit is taken.
    const context = JSON.stringify({ v: 1, camera_id: 'another-cam', tz: TZ, window: { start: '17:30', end: '05:00' }, algo: '1' });
    for (let i = 1; i <= 14; i++) plantNight(-i, 10, { endHm: [5, 0], context });
    layMorningExitNight(5, 0); // lead 120 on this night's window
    const { out: night, reads } = historyReadsDuring(() => computeNight(CHILD, DATE));
    assert.equal(reads, 1, 'precondition: the history was read');
    assert.equal(hhmm(night.wake_at), '05:00', 'as before #700');
    assert.equal(night.wake_unconfirmed, null);
  });

  test('#700 T8h2: the 14-night cap counts MATCHING nights, so older nights with this window end are found', () => {
    // The newest 10 earlier nights ended 05:00 (an old setting, or a test of one); the 14 before them ended 07:00
    // like this night. Capped before the match only 4 matching rows would be left (rule off); capped after it the
    // 14 are found and the rule applies.
    for (let i = 1; i <= 10; i++) plantNight(-i, 10, { endHm: [5, 0] });
    NORMAL.forEach((lead, i) => plantNight(-(i + 11), lead));
    layFalseExitNight();
    const night = computeNight(CHILD, DATE);
    assert.equal(night.wake_at, null);
    assert.deepEqual(night.wake_unconfirmed, { at: FALSE_EXIT_AT, lead_min: 630, threshold_min: 80 });
  });

  test('#700 T8j: a clock change inside the history does not exclude nights whose LOCAL window end is unchanged', () => {
    // Melbourne moves to UTC+11 at 02:00 on 2026-10-04. Fourteen earlier nights, 2026-09-28 to 10-11, all end at
    // 07:00 local, which is 21:00Z for the first five and 20:00Z after the change; this night (10-12) ends 20:00Z.
    // Matched on the LOCAL clock all fourteen count (threshold 80, the false exit is skipped); matched on UTC only
    // the nine after the change would, below the minimum, and the exit would be taken.
    const local = (d, h, m, s = 0) => new Date(zonedToUtc(2026, 9, d, h, m, TZ).getTime() + s * 1000);
    NORMAL.forEach((lead, i) => {
      const d = 11 - i; // night 2026-10-11 back to 2026-09-28 (day 0 of October is 30 September)
      const end = local(d + 1, 7, 0);
      insertNight.run({
        child_id: CHILD, night_date: new Date(Date.UTC(2026, 9, d)).toISOString().slice(0, 10),
        window_start: sqlTime(local(d, 19, 30)), window_end: sqlTime(end), status: 'ok',
        wake_at: sqlTime(new Date(end.getTime() - lead * 60000)), scoring_context: null, wake_unconfirmed_at: null,
        computed_at: sqlTime(end),
      });
    });
    const ends = db.prepare('SELECT DISTINCT substr(window_end, 12) AS t FROM sleep_nights ORDER BY t').all().map((r) => r.t);
    assert.deepEqual(ends, ['20:00:00', '21:00:00'], 'precondition: the UTC window ends really do differ');
    layNight({ from: local(12, 19, 0), to: local(13, 7, 0), bed: [[local(12, 19, 30), local(12, 19, 40)], [local(12, 20, 30), local(12, 20, 31), 0.02]] });
    exit(local(12, 20, 30, 20));
    const night = computeNight(CHILD, '2026-10-12');
    assert.equal(night.wake_at, null);
    assert.deepEqual(night.wake_unconfirmed, { at: sqlTime(local(12, 20, 30, 20)), lead_min: 630, threshold_min: 80 });
  });

  test('#700 T8k: the history is sorted by lead, not taken in the order it is read (newest first)', () => {
    // NORMAL reversed: the newest night has the longest lead, so the rows arrive in DESCENDING lead order. Sorted,
    // index 10 is 40 (threshold 80) and a lead-70 morning exit is taken; unsorted, index 10 would be 20
    // (threshold 60) and it would be skipped.
    plantHistory([...NORMAL].reverse());
    layMorningExitNight(5, 50); // lead 70
    const night = computeNight(CHILD, DATE);
    assert.equal(hhmm(night.wake_at), '05:50');
    assert.equal(night.wake_unconfirmed, null);
  });

  test('#700 T8l: the percentile index is floor(0.75 n): with 12 nights it is the 10th smallest', () => {
    // Nine 40-minute leads and three 600-minute ones. floor(0.75 x 12) = 9 picks a 600 (threshold 1200, the false
    // exit is taken); ceil(0.75 x 12) - 1 = 8 would pick a 40 (threshold 80, skipped). The two nearest-rank
    // conventions only differ when 0.75 n is a whole number, which 12 is.
    plantHistory([40, 40, 40, 40, 40, 40, 40, 40, 40, LONG, LONG, LONG]);
    layFalseExitNight();
    const night = computeNight(CHILD, DATE);
    assert.equal(hhmm(night.wake_at), '20:30');
    assert.equal(night.wake_unconfirmed, null);
  });

  test('#700 T8m: the window-end match is minute-exact: nights ending 07:00 are not history for a 07:30 end', () => {
    // PR #888 round 2 (Opus A8). The wake time moved from 07:00 to 07:30; a genuine 06:00 exit is 90 minutes before
    // the new end. Matched on the hour alone, the fourteen 07:00 nights (threshold 80) would skip it.
    db.prepare("UPDATE children SET sleep_window_end = '07:30' WHERE id = ?").run(CHILD);
    plantHistory(NORMAL); // window ends 07:00
    layNight({ to: at(7, 30, 1), bed: [[at(19, 30), at(19, 40)], [at(5, 59, 1), at(6, 1, 1)]], still: [[at(6, 1, 1), STILL_EMPTY]] });
    exit(at(6, 0, 1, 10));
    const night = computeNight(CHILD, DATE);
    assert.equal(hhmm(night.window_end), '07:30', 'precondition');
    assert.equal(hhmm(night.wake_at), '06:00', 'no matching history: taken, as before #700');
    assert.equal(night.wake_unconfirmed, null);
  });

  // A window ending 02:30 and Melbourne's spring-forward at 02:00 on 2026-10-04: that night's end does not exist and
  // resolves to 03:30 (zonedToUtc). `mel(d, h, m)` is local Melbourne time on day d of October 2026 (0 = 30 Sep).
  const mel = (d, h, m, s = 0) => new Date(zonedToUtc(2026, 9, d, h, m, TZ).getTime() + s * 1000);
  const octDate = (d) => new Date(Date.UTC(2026, 9, d)).toISOString().slice(0, 10);
  function plantOctNight(d, lead, end = mel(d + 1, 2, 30)) {
    insertNight.run({
      child_id: CHILD, night_date: octDate(d), window_start: sqlTime(mel(d, 20, 0)), window_end: sqlTime(end), status: 'ok',
      wake_at: sqlTime(new Date(end.getTime() - lead * 60000)), scoring_context: null, wake_unconfirmed_at: null,
      computed_at: sqlTime(end),
    });
  }
  // Settling at the window start, a weak false exit at 21:00 local, a still child to the end.
  function layOctFalseExit(d, end) {
    layNight({ from: mel(d, 19, 30), to: end, bed: [[mel(d, 20, 0), mel(d, 20, 10)], [mel(d, 21, 0), mel(d, 21, 1), 0.02]] });
    exit(mel(d, 21, 0, 20), { peak: 0.02, frames: 1 });
  }

  test('#700 T8n: on the night a clock change makes the window end not exist, there is no matching history: rule off', () => {
    db.prepare("UPDATE children SET sleep_window_start = '20:00', sleep_window_end = '02:30' WHERE id = ?").run(CHILD);
    NORMAL.forEach((lead, i) => plantOctNight(2 - i, lead)); // nights 2 Oct back to 19 Sep, each ending 02:30
    const end = mel(4, 2, 30);
    assert.equal(sqlTime(end), sqlTime(mel(4, 3, 30)), 'precondition: 02:30 on 4 October resolves to 03:30');
    layOctFalseExit(3, end);
    const { out: night, reads } = historyReadsDuring(() => computeNight(CHILD, octDate(3)));
    assert.equal(reads, 1, 'precondition: the history was read');
    assert.equal(hhmm(night.window_end), '03:30');
    assert.equal(hhmm(night.wake_at), '21:00', 'taken, as before #700');
    assert.equal(night.wake_unconfirmed, null);
  });

  test('#700 T8o: ...and that night\'s row then drops out of the next night\'s history', () => {
    // Nine nights ending 02:30 plus the clock-change night's row (its window_end reads 03:30). Counted, it would make
    // ten and turn the rule on for 4 October; left out, the child has nine and the false exit is taken.
    db.prepare("UPDATE children SET sleep_window_start = '20:00', sleep_window_end = '02:30' WHERE id = ?").run(CHILD);
    NORMAL.slice(0, 9).forEach((lead, i) => plantOctNight(2 - i, lead));
    plantOctNight(3, 10, mel(4, 2, 30)); // the 3 October row, ending at the resolved 03:30
    const end = mel(5, 2, 30);
    layOctFalseExit(4, end);
    const night = computeNight(CHILD, octDate(4));
    assert.equal(hhmm(night.window_end), '02:30', 'precondition: 02:30 exists again on 5 October');
    assert.equal(hhmm(night.wake_at), '21:00');
    assert.equal(night.wake_unconfirmed, null);
  });

  test('#700 T8i: the history is the child\'s own: another child\'s nights do not count', () => {
    db.prepare(`INSERT INTO children (id, name, track_sleep) VALUES ('other-child', 'Other', 1)`).run();
    plantHistory(NORMAL, { childId: 'other-child' });
    layFalseExitNight();
    const night = computeNight(CHILD, DATE);
    assert.equal(hhmm(night.wake_at), '20:30');
    assert.equal(night.wake_unconfirmed, null);
  });
});

// --- 9. genuine early wakes: the limit, pinned --------------------------------------------------------------

describe('#700 known limit: a genuine very early wake', () => {
  test('#700 T9: real exits 4, 5 and 6 hours before the close, with a person in the room after, are skipped too', () => {
    // KNOWN LIMIT, pinned so a future change to it is deliberate. A child really up for the day hours before
    // the window closes looks, to this rule, exactly like the false exits it exists for. A person in the room
    // after the exit (the parent at the bed for three minutes 30 minutes in, movement outside the bed and a
    // clear noise for 45 minutes) does NOT rescue it: the rule does not read sound or outside movement (sound
    // is confounded with "it is morning", see LEAD_FACTOR). That 45 minutes becomes one counted wake-up, and
    // because the room is quiet again before the close, the movement-only wake is null: the night reads
    // "still asleep" until 07:00. No such night is in the measured data.
    //
    // What dev before #700 stored for these (the exit taken; awake 2 = the stir just before it):
    //   03:00  wake 03:00, asleep 438, awake 2, wakes 1, longest 438
    //   02:00  wake 02:00, asleep 378, awake 2, wakes 1, longest 378
    //   01:00  wake 01:00, asleep 318, awake 2, wakes 1, longest 318
    const cases = [
      { h: 3, lead: 240, longest: 438, at: '2026-07-15 17:00:10' },
      { h: 2, lead: 300, longest: 378, at: '2026-07-15 16:00:10' },
      { h: 1, lead: 360, longest: 318, at: '2026-07-15 15:00:10' },
    ];
    for (const c of cases) {
      for (const tbl of ['sleep_nights', 'activity_samples', 'bed_transitions']) db.prepare(`DELETE FROM ${tbl}`).run();
      plantHistory(NORMAL);
      layNight({
        bed: [[at(19, 30), at(19, 40)], [at(c.h - 1, 58, 1), at(c.h, 0, 1)], [at(c.h, 30, 1), at(c.h, 33, 1)]],
        room: [[at(c.h, 0, 1), at(c.h, 45, 1)]],
        still: [[at(c.h, 0, 1), STILL_EMPTY]], // the child is gone: the bed is empty from the exit on
      });
      exit(at(c.h, 0, 1, 10), { peak: 0.05 });
      const summary = computeAndStoreNight(CHILD, DATE, { allowDowngrade: false });
      assert.deepEqual(summary.wake_unconfirmed, { at: c.at, lead_min: c.lead, threshold_min: 80 }, `${c.h}:00`);
      assert.deepEqual(storedFigures(storedRow()), {
        status: 'ok', wake_at: null, asleep_minutes: 633, awake_minutes: 47, unknown_minutes: 0, wake_count: 1,
        longest_stretch_minutes: c.longest,
      }, `${c.h}:00`);
    }
  });
});

// --- 10. additive, only its time stored, and the paths that carry it ----------------------------------------

describe('#700 wake_unconfirmed is an added key; only its time is stored', () => {
  test('#700 T10: on a night the rule reads but does not change, the whole answer is what it is with no history', () => {
    // Lead 70: over the 60 that makes the history worth reading, under this child's threshold of 80.
    layMorningExitNight(5, 50);
    const bare = computeNight(CHILD, DATE, { includeTimeline: true });
    plantHistory(NORMAL);
    const { out: withHistory, reads } = historyReadsDuring(() => computeNight(CHILD, DATE, { includeTimeline: true }));
    assert.equal(reads, 1, 'precondition: the rule did consider this exit');
    assert.equal(hhmm(withHistory.wake_at), '05:50');
    assert.deepEqual(withHistory, bare, 'every field, timeline included');
    assert.ok('wake_unconfirmed' in withHistory, 'the new key is there');
    assert.equal(withHistory.wake_unconfirmed, null);
  });

  test('#700 T10b: every status carries the key (it is in `base`)', () => {
    plantHistory(NORMAL);
    assert.equal(computeNight(CHILD, DATE).status, 'no_data', 'precondition: no samples');
    assert.ok('wake_unconfirmed' in computeNight(CHILD, DATE));
    layNight({}); // a whole night of a still, EMPTY room
    db.prepare('UPDATE activity_samples SET motion_peak = ?').run(STILL_EMPTY);
    const empty = computeNight(CHILD, DATE);
    assert.equal(empty.status, 'empty');
    assert.equal(empty.wake_unconfirmed, null);
    db.prepare('UPDATE children SET track_sleep = 0').run();
    const off = computeNight(CHILD, DATE);
    assert.equal(off.status, 'off');
    assert.equal(off.wake_unconfirmed, null);
  });

  test('#700 T10c: the stored row gains only wake_unconfirmed_at (the flag\'s time), and the saved context is unchanged', () => {
    plantHistory(NORMAL);
    layFalseExitNight();
    const summary = computeAndStoreNight(CHILD, DATE, { allowDowngrade: false });
    assert.equal(summary.stored, true);
    assert.ok(summary.wake_unconfirmed, 'precondition: the summary carries a skip');
    assert.ok(!('wake_unconfirmed_at' in summary), 'the column is bound by the store, never a key of the answer');
    const columns = db.prepare("PRAGMA table_info('sleep_nights')").all().map((c) => c.name);
    assert.ok(!columns.includes('wake_unconfirmed'), 'no column for the object itself');
    const row = storedRow();
    assert.ok(!('wake_unconfirmed' in row));
    assert.equal(row.wake_unconfirmed_at, FALSE_EXIT_AT, 'only its time, exactly as recorded');
    for (const c of columns) {
      if (typeof row[c] === 'string') assert.ok(!row[c].includes('lead_min'), `${c} does not carry the rest of the diagnostic`);
    }
    const ctx = JSON.parse(row.scoring_context);
    assert.deepEqual(Object.keys(ctx).sort(), ['algo', 'camera_id', 'tz', 'v', 'window']);
    assert.equal(ctx.algo, SCORING_ALGO);
  });

  test('#700 T10c2: a re-store that no longer flags anything CLEARS the stored flag', () => {
    // The nightly job re-stores a provisional night; a flag that a later pass no longer finds must not stay behind
    // and keep teaching later nights a departure no pass found. Written in the upsert's ON CONFLICT half for this.
    plantHistory(NORMAL);
    layFalseExitNight();
    computeAndStoreNight(CHILD, DATE, { allowDowngrade: false });
    assert.equal(storedRow().wake_unconfirmed_at, FALSE_EXIT_AT, 'precondition: flagged');
    db.prepare("DELETE FROM bed_transitions WHERE type = 'out_of_bed'").run();
    computeAndStoreNight(CHILD, DATE, { allowDowngrade: false });
    assert.equal(storedRow().wake_unconfirmed_at, null);
  });

  test('#700 T10d: the nightly job stores the null wake with no error, and the push says no "up" time', (t) => {
    // C (Codex plan review): a night FIRST computed after this change has no notified_wake_at, so the job
    // stores the new value. The push text is read from the job's own log line, which is built from the same
    // title and body every provider is sent (sleepReportAlert.js notifySleepReports).
    plantHistory(NORMAL);
    layFalseExitNight();
    t.mock.timers.enable({ apis: ['Date'], now: at(7, 30, 1).getTime() });
    const info = t.mock.method(logger, 'info');
    const errors = t.mock.method(logger, 'error');
    runNightlySleepJob();
    const sleepErrors = errors.mock.calls.map((c) => String(c.arguments[0])).filter((m) => m.startsWith('[sleep]'));
    assert.deepEqual(sleepErrors, [], 'the job stored the night without an error');
    assert.deepEqual(storedFigures(storedRow()), {
      status: 'ok', wake_at: null, asleep_minutes: 680, awake_minutes: 0, unknown_minutes: 0, wake_count: 0,
      longest_stretch_minutes: 680,
    });
    const line = info.mock.calls.map((c) => String(c.arguments[0])).find((m) => m.startsWith('[sleep-alert]'));
    // On dev before #700 this read "Lead Kid: asleep 0h50, 0 wakes, up 20:30".
    assert.equal(line, '[sleep-alert] Sleep report — Lead Kid: Lead Kid: asleep 11h20, 0 wakes');
    assert.ok(!line.includes('lead_min') && !line.includes('unconfirmed'), 'the diagnostic is not in the push');
  });

  test('#700 T10e: a night a parent was already told a wake time for is NOT blanked (guard unchanged)', async () => {
    // C (Codex plan review): the nights stored before this rule keep their figures once a wake was pushed.
    plantHistory(NORMAL);
    layFalseExitNight();
    const now = sqlTime(at(7, 30, 1));
    db.prepare(`INSERT INTO sleep_nights (child_id, night_date, window_start, window_end, status, wake_at, asleep_minutes,
                  notified_at, notified_wake_at, computed_at)
                VALUES (?, ?, ?, ?, 'ok', ?, 50, ?, ?, ?)`)
      .run(CHILD, DATE, sqlTime(at(19, 30)), sqlTime(at(7, 0, 1)), FALSE_EXIT_AT.slice(0, 16) + ':00', now, FALSE_EXIT_AT.slice(0, 16) + ':00', now);
    const before = storedRow();
    const res = computeAndStoreNight(CHILD, DATE, { allowDowngrade: false });
    assert.equal(res.refused, 'would_blank_notified_wake');
    assert.deepEqual(storedRow(), before, 'nothing written');
    const viaRoute = await call(`${server.url}/api/children/${CHILD}/sleep/${DATE}?store=1`, { method: 'GET', token: adminToken });
    assert.equal(viaRoute.status, 409, 'the Recompute button is refused the same way');
    assert.deepEqual(storedRow(), before);
  });

  test('#700 T10f: it reaches the detail, Recompute preview, store and last-night answers', async (t) => {
    plantHistory(NORMAL);
    layFalseExitNight();
    const expected = { at: FALSE_EXIT_AT, lead_min: 630, threshold_min: 80 };
    const get = (q) => call(`${server.url}/api/children/${CHILD}${q}`, { token: adminToken });
    assert.deepEqual((await get(`/sleep/${DATE}`)).body.wake_unconfirmed, expected, 'detail');
    assert.deepEqual((await get(`/sleep/${DATE}?detail=1`)).body.wake_unconfirmed, expected, 'detail with timeline');
    assert.deepEqual((await get(`/sleep/${DATE}?context=current&raw=1`)).body.wake_unconfirmed, expected, 'Recompute preview');
    // /sleep/live for the last completed night with no saved row yet: worked out fresh. The clock is frozen the
    // morning after so DATE is the last completed night and nothing is in progress.
    t.mock.timers.enable({ apis: ['Date'], now: at(8, 0, 1).getTime() });
    const live = (await get('/sleep/live')).body;
    assert.equal(live.scope, 'last');
    assert.deepEqual(live.night.wake_unconfirmed, expected, 'live, last night worked out fresh');
    t.mock.timers.reset();
    const stored = await get(`/sleep/${DATE}?store=1`);
    assert.equal(stored.status, 200);
    assert.deepEqual(stored.body.wake_unconfirmed, expected, 'the store answer');
    // ...but not the saved row, nor the morning review's `computed` (a whitelist, left alone).
    const savedRow = (await get(`/sleep/${DATE}?stored=1`)).body.night;
    assert.ok(!('wake_unconfirmed' in savedRow), 'saved row');
    // ...which instead carries the stored column as an ADDED key (the stored-night readers `SELECT *`).
    assert.equal(savedRow.wake_unconfirmed_at, FALSE_EXIT_AT, 'the saved row carries its own column');
    assert.equal((await get('/sleep?nights=14')).body.nights.find((n) => n.night_date === DATE).wake_unconfirmed_at, FALSE_EXIT_AT);
    assert.ok(!('wake_unconfirmed' in getNightReview(CHILD, DATE).computed), 'morning review');
  });

  test('#700 T10g: a night in progress never reads the history and never skips', (t) => {
    plantHistory(NORMAL);
    layFalseExitNight();
    t.mock.timers.enable({ apis: ['Date'], now: at(2, 0, 1).getTime() });
    const { out: night, reads } = historyReadsDuring(() => computeNight(CHILD, DATE));
    assert.equal(night.in_progress, true);
    assert.equal(night.wake_unconfirmed, null);
    assert.equal(reads, 0, 'no departure is looked for on a night in progress, so no history is read');
  });

  test('#700 T10h: "no one was in the bed" still reads as a valid empty night; the diagnostic rides along', async () => {
    // A decision (brief F): the overlay (sleepReviews.js asNobodyInBed) is left as it is. It nulls every sleep
    // CLAIM; `wake_unconfirmed` is a note about the detector's own exit, like the `algo_*` fields it keeps, so it
    // passes through unchanged. The night is still exactly an `empty` night in every claim.
    plantHistory(NORMAL);
    layFalseExitNight();
    saveNightReview(CHILD, DATE, { nobodyInBed: true });
    const shown = (await call(`${server.url}/api/children/${CHILD}/sleep/${DATE}`, { token: adminToken })).body;
    assert.equal(shown.status, 'empty');
    assert.equal(shown.nobody_in_bed, true);
    for (const k of ['onset_at', 'wake_at', 'in_bed_at', 'asleep_minutes', 'awake_minutes', 'unknown_minutes', 'wake_count', 'longest_stretch_minutes']) {
      assert.equal(shown[k], null, `${k} is cleared`);
    }
    assert.equal(shown.algo_status, 'ok');
    assert.deepEqual(shown.wake_unconfirmed, { at: FALSE_EXIT_AT, lead_min: 630, threshold_min: 80 });
  });

  test('#700 T10i: a second camera\'s exits are never candidates, so they are never skipped or reported', () => {
    // The night is scored from ONE camera (the primary, lowest sort_order). An early out_of_bed on the other
    // camera is not a candidate at all, before and after #700; the primary's genuine 06:30 exit is the wake.
    db.prepare(`INSERT INTO cameras (id, name, rtsp_url, child_id, mediamtx_path, sort_order, disabled)
                VALUES (?, 'Door cam', 'rtsp://example/y', ?, 'p2', 1, 0)`).run(CAM2, CHILD);
    plantHistory(NORMAL);
    layMorningExitNight(6, 30);
    layNight({ cam: CAM2, bed: [[at(20, 30), at(20, 31), 0.02]] });
    exit(at(20, 30, 0, 20), { cam: CAM2 });
    const { out: night, reads } = historyReadsDuring(() => computeNight(CHILD, DATE));
    assert.equal(night.analysis_camera_id, CAM);
    assert.equal(hhmm(night.wake_at), '06:30');
    assert.equal(night.wake_unconfirmed, null);
    assert.equal(reads, 0);
  });
});

// --- 11. false exits in the history: the measured run of 3 keeps the rule on, 4 switch it off -----------------
//
// HOW THE HISTORY LEARNS (sleepAnalysis.js, LEAD_FACTOR): a night whose false exit the rule SKIPPED contributes that
// exit's lead (its stored `wake_unconfirmed_at`), so false exits weigh on the p75 like stored early wakes do. These
// plant skipped nights (wake NULL, a 630-minute candidate) among NORMAL ones.

describe('#700 skipped false exits in the history', () => {
  test('#700 T11a: two earlier skipped false exits in the newest 14 still leave the rule on for the third', () => {
    // The measured child had three false exits inside eight days; the first two must not let the third through.
    NORMAL.slice(0, 12).forEach((lead, i) => plantNight(-(i + 1), lead));
    for (const d of [-13, -14]) plantNight(d, 630, { skipped: true });
    layFalseExitNight();
    const night = computeNight(CHILD, DATE);
    assert.equal(night.wake_at, null, 'skipped');
    assert.equal(night.wake_unconfirmed.threshold_min, 80);
  });

  test('#700 T11b: three of them still leave it on for the fourth', () => {
    NORMAL.slice(0, 11).forEach((lead, i) => plantNight(-(i + 1), lead));
    for (const d of [-12, -13, -14]) plantNight(d, 630, { skipped: true });
    layFalseExitNight();
    const night = computeNight(CHILD, DATE);
    assert.equal(night.wake_at, null);
    assert.equal(night.wake_unconfirmed.threshold_min, 80);
  });

  test('#700 T11c: KNOWN LIMIT: four skipped false exits in the newest 14 switch the rule off for the fifth', () => {
    // The other side, pinned: the p75 (11th smallest of 14) is then a 630, the threshold 1260, and the fifth false
    // exit is taken as before #700, until those nights age out of the newest 14.
    NORMAL.slice(0, 10).forEach((lead, i) => plantNight(-(i + 1), lead));
    for (const d of [-11, -12, -13, -14]) plantNight(d, 630, { skipped: true });
    layFalseExitNight();
    const night = computeNight(CHILD, DATE);
    assert.equal(hhmm(night.wake_at), '20:30');
    assert.equal(night.wake_unconfirmed, null);
  });
});

// --- 12. a changed routine is learnt by the history, over 21 consecutive nights -------------------------------

// Runs nights `0..plan.length-1` from DATE through computeAndStoreNight (what the nightly job does) and returns one
// word per night. `plan[day]` is 'early' (a genuine exit at 05:15), 'normal' (a genuine exit at 06:30, lead 30),
// 'empty' (the child is away: a still, empty bed all night) or 'no_data' (the camera recorded nothing).
//   'skipped'    the rule skipped the exit and the night stores no wake
//   'late HH:MM' the rule skipped it and a later movement-only wake was stored
//   'taken'      no skip, and the stored wake is the night's genuine exit
//   'empty' / 'no_data' the stored status
function runPlan(plan, { room = null } = {}) {
  const words = [];
  plan.forEach((kind, day) => {
    if (kind === 'early') layRoutineNight(day, [5, 15], { room });
    else if (kind === 'normal') layRoutineNight(day, [6, 30], { room });
    else if (kind === 'empty') layNight({ from: at(19, 0, day), to: at(7, 0, day + 1), still: [[at(19, 0, day), STILL_EMPTY]] });
    const s = computeAndStoreNight(CHILD, dateOf(day), { allowDowngrade: false });
    const row = storedRow(dateOf(day));
    assert.equal(row.wake_unconfirmed_at, s.wake_unconfirmed?.at ?? null, `night ${day}: the stored skip is the summary's`);
    if (kind === 'empty' || kind === 'no_data') {
      assert.equal(row.status, kind, `night ${day}: precondition`);
      words.push(kind);
      return;
    }
    const genuine = kind === 'early' ? '05:15' : '06:30';
    const wake = hhmm(row.wake_at);
    if (!s.wake_unconfirmed) words.push(wake === genuine ? 'taken' : `taken ${wake}`);
    else words.push(wake == null ? 'skipped' : `late ${wake}`);
  });
  return words;
}
const times = (n, w) => new Array(n).fill(w);

describe('#700 a changed routine is learnt, and does not lock the rule in', () => {
  test('#700 T12: a child now up at 05:15 every day: 4 nights skipped, then taken for good', () => {
    // The lock-in found in the PR #888 review (without the learning history all 21 nights were skipped). Each
    // skipped night stores its 05:15 exit as `wake_unconfirmed_at`, which the next night's history reads as a lead
    // of 105; once 4 of the newest 14 are 105 the p75 is 105, the threshold 210, and the rule stops firing. Nothing
    // flips back: every later night has more 105s, not fewer.
    plantHistory(NORMAL);
    assert.deepEqual(runPlan(times(21, 'early')), [...times(4, 'skipped'), ...times(17, 'taken')]);
  });

  test('#700 T12b: the same in a bedroom that hears the house wake at 06:40: 4 nights stored late, then taken', () => {
    // The other lock-in shape: a skipped night stores the movement-only wake, 06:40 (85 minutes late), whose short
    // lead would pull the threshold DOWN if it were the history's lead. The history takes the skipped exit instead.
    plantHistory(NORMAL);
    assert.deepEqual(runPlan(times(21, 'early'), { room: [[6, 40], [7, 0]] }), [...times(4, 'late 06:40'), ...times(17, 'taken')]);
  });

  test('#700 T12c: home 3 nights a week, away nights stored `empty`: learnt after the 4th home night', () => {
    // PR #888 round 2 (Opus A1): an `empty` night is not history at all, so it cannot dilute it. Under the fix-round-1
    // disarm (any status counted) this child stayed skipped for six weeks.
    plantHistory(NORMAL);
    const plan = Array.from({ length: 21 }, (_, d) => ([0, 2, 4].includes(d % 7) ? 'early' : 'empty'));
    const words = runPlan(plan);
    const home = words.filter((w) => w !== 'empty');
    assert.deepEqual(home, [...times(4, 'skipped'), ...times(home.length - 4, 'taken')]);
    assert.equal(home.length, 9, 'precondition: 9 home nights in the 21');
  });

  test('#700 T12d: a camera that records nothing every other night (`no_data`): learnt after the 4th night it records', () => {
    // Opus A4: the same for `no_data` nights.
    plantHistory(NORMAL);
    const plan = Array.from({ length: 21 }, (_, d) => (d % 2 === 0 ? 'early' : 'no_data'));
    const words = runPlan(plan);
    const seen = words.filter((w) => w !== 'no_data');
    assert.deepEqual(seen, [...times(4, 'skipped'), ...times(seen.length - 4, 'taken')]);
  });

  test('#700 T12e: early on 4 days of every 7: learnt after the 4th early night', () => {
    // Codex round 2: an early wake on SOME mornings. Here 4 of every 7 (and 8 of any 14 nights): the first four are
    // skipped, then the history holds 4 of them and every later early morning is taken.
    plantHistory(NORMAL);
    const plan = Array.from({ length: 21 }, (_, d) => (d % 7 < 4 ? 'early' : 'normal'));
    const words = runPlan(plan);
    assert.deepEqual(words.filter((_, d) => plan[d] === 'normal'), times(9, 'taken'), 'the 06:30 mornings are never touched');
    const early = words.filter((_, d) => plan[d] === 'early');
    assert.deepEqual(early, [...times(4, 'skipped'), ...times(early.length - 4, 'taken')]);
  });

  test('#700 T12f: KNOWN LIMIT: early on only 1 night in 5 (at most 3 of any 14): skipped every time', () => {
    // The limit, pinned: with 3 or fewer long leads among the newest 14 the p75 never moves, so a genuine early wake
    // this rare stays an outlier and is set aside every time (the night reads "still asleep"). The 06:30 mornings
    // between are taken as usual.
    plantHistory(NORMAL);
    const plan = Array.from({ length: 21 }, (_, d) => (d % 5 === 0 ? 'early' : 'normal'));
    const words = runPlan(plan);
    assert.deepEqual(words.filter((_, d) => plan[d] === 'early'), times(5, 'skipped'));
    assert.deepEqual(words.filter((_, d) => plan[d] === 'normal'), times(16, 'taken'));
  });
});

// --- 13. the reverse case: a skipped genuine exit can hand the night to a LATER one ------------------------

describe('#700 known limit: a later exit takes over', () => {
  test('#700 T13: a genuine 03:00 exit is skipped and a parent at the empty bed at 06:30 becomes the wake', () => {
    // KNOWN LIMIT (Codex review), pinned: the rule cannot tell a genuine early exit from a false one, and once it
    // has skipped one, any LATER qualifying exit wins as usual. Here the child really left at 03:00 (bed empty
    // after); a parent handles the empty bed for three minutes at 06:30 and an out_of_bed is logged as they step
    // away. That later gap qualifies (lead 27, under 60), so the night is reported up at 06:33, three and a half
    // hours late, instead of at 03:00 (dev before #700) or blank.
    plantHistory(NORMAL);
    layNight({
      bed: [[at(19, 30), at(19, 40)], [at(2, 58, 1), at(3, 0, 1)], [at(6, 30, 1), at(6, 33, 1)]],
      still: [[at(3, 0, 1), STILL_EMPTY]],
    });
    exit(at(3, 0, 1, 10));
    exit(at(6, 33, 1, 30));
    const night = computeNight(CHILD, DATE);
    assert.equal(hhmm(night.wake_at), '06:33');
    assert.deepEqual(night.wake_unconfirmed, { at: '2026-07-15 17:00:10', lead_min: 240, threshold_min: 80 });
  });
});
