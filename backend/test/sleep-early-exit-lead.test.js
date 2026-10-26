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
  computeNight, computeAndStoreNight, runNightlySleepJob, priorWakeLeadReadsForTest, SCORING_ALGO,
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
const insertNight = db.prepare(
  `INSERT INTO sleep_nights (child_id, night_date, window_start, window_end, status, wake_at, scoring_context, computed_at)
   VALUES (@child_id, @night_date, @window_start, @window_end, @status, @wake_at, @scoring_context, @computed_at)`
);
const dateOf = (dayShift) => new Date(Date.UTC(2026, 6, 15 + dayShift)).toISOString().slice(0, 10);
function plantNight(dayShift, lead, { childId = CHILD, status = 'ok', endHm = [7, 0], wakeAt, context = null } = {}) {
  const windowEnd = at(endHm[0], endHm[1], dayShift + 1);
  insertNight.run({
    child_id: childId,
    night_date: dateOf(dayShift),
    window_start: sqlTime(at(19, 30, dayShift)),
    window_end: sqlTime(windowEnd),
    status,
    wake_at: wakeAt !== undefined ? wakeAt : sqlTime(new Date(windowEnd.getTime() - lead * 60000)),
    scoring_context: context,
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
    plantHistory(NORMAL);
    layFalseExitNight();
    insertTransition.run(CAM, 'into_bed', 0.02, 1, sqlTime(at(20, 29, 0, 50)));
    const night = computeNight(CHILD, DATE);
    assert.equal(night.wake_at, null);
    assert.deepEqual(night.wake_unconfirmed, { at: FALSE_EXIT_AT, lead_min: 630, threshold_min: 80 });
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

  test('#700 T8h: earlier nights stored under another window and camera are measured against their OWN window', () => {
    // KNOWN LIMIT, stated: history is used as stored, whatever produced it. Fourteen nights saved with a window
    // ending 05:00 (and from another camera, per their saved context), each up 10 minutes before it. Their
    // leads are 10 (against their own 05:00), so p75 is 10 and the threshold is the floor's 60. Measured
    // against THIS night's 07:00 instead they would read 130 and the threshold would be 260, taking the exit.
    const context = JSON.stringify({ v: 1, camera_id: 'another-cam', tz: TZ, window: { start: '17:30', end: '05:00' }, algo: '1' });
    for (let i = 1; i <= 14; i++) plantNight(-i, 10, { endHm: [5, 0], context });
    layMorningExitNight(5, 0); // lead 120 on this night's window
    const night = computeNight(CHILD, DATE);
    assert.equal(night.wake_at, null);
    assert.deepEqual(night.wake_unconfirmed, { at: '2026-07-15 19:00:10', lead_min: 120, threshold_min: 60 });
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

// --- 10. additive, never stored, and the paths that carry it ------------------------------------------------

describe('#700 wake_unconfirmed is an added key, never stored', () => {
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

  test('#700 T10c: the stored row has no such column and the saved context is unchanged in shape', () => {
    plantHistory(NORMAL);
    layFalseExitNight();
    const summary = computeAndStoreNight(CHILD, DATE, { allowDowngrade: false });
    assert.equal(summary.stored, true);
    assert.ok(summary.wake_unconfirmed, 'precondition: the summary carries a skip');
    const columns = db.prepare("PRAGMA table_info('sleep_nights')").all().map((c) => c.name);
    assert.ok(!columns.includes('wake_unconfirmed'), 'no column (no migration)');
    const row = storedRow();
    assert.ok(!('wake_unconfirmed' in row));
    for (const c of columns) {
      if (typeof row[c] === 'string') assert.ok(!row[c].includes('lead_min'), `${c} does not carry the diagnostic`);
    }
    const ctx = JSON.parse(row.scoring_context);
    assert.deepEqual(Object.keys(ctx).sort(), ['algo', 'camera_id', 'tz', 'v', 'window']);
    assert.equal(ctx.algo, SCORING_ALGO);
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
    assert.ok(!('wake_unconfirmed' in (await get(`/sleep/${DATE}?stored=1`)).body.night), 'saved row');
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
