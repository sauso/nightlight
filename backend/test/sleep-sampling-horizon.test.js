// #353: an ACTIVITY-ONLY camera (motion alerts off, or MQTT/ONVIF motion) is sampled by a leg gated on
// childSamplingActiveNow. That gate had two defects, both reproduced on dev 11236d7 before the fix:
//
//   1. TAIL. It closed 5 minutes after the window end, but computeNight reads the morning departure
//      evidence up to window end + WAKE_LOOKAHEAD_MS (the departure scan, the bed-transition read, the
//      metrics extension; isEvidenceFinal and reportableSpanMs close at the same instant). For a camera
//      with no other source of samples the last 2 h 55 min of that horizon was never observed, so the
//      morning wake was never found. Reproduced: sampling false at 07:06 and 09:59 for a 19:00-07:00 window.
//   2. HEAD. windowOpenNow tried only today's and yesterday's night. A window opening 00:00-02:59 local has
//      its 3 h lookbehind on the PREVIOUS calendar day, i.e. it belongs to TOMORROW's night, never tried.
//
// This file pins the PREDICATE by assertion (the reconcile path that acts on it is motion-leg-reconcile.test.js).
//
// ⚠️ HOSTILE FIXTURES. Every expected instant below is an explicit UTC literal worked out by hand from the
// local time in the comment next to it. None is derived from the function under test or from zonedToUtc,
// so a wrong boundary in the code cannot also move the expectation. The two places that DO read a value
// back from the app (reportableSpanMs, and the reconcile margin read from where childWindowActiveNow's own
// tail flips) say so, and are checked against a literal as well.
//
// ⚠️ NOT MELBOURNE-SHAPED. The DST cases use Australia/Melbourne because it has both transitions on known
// dates, but the same predicate is also asserted under the default 'UTC' and under Asia/Kolkata (UTC+5:30,
// no DST, a half-hour offset) so that no offset, zone or whole-hour assumption can hide in the code.
//
// Date is frozen with mock.timers (apis: ['Date'] only, never the real timers) and ALWAYS reset in finally.
import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupTempDataDirs } from './helpers/harness.js';

// DATA_DIR must be set before db.js is first imported (it opens the database at module load).
useTempDataDir();

const { childWindowActiveNow, childSamplingActiveNow, reportableSpanMs, isEvidenceFinal } =
  await import('../src/lib/sleepAnalysis.js');
const { default: db } = await import('../src/db.js');

const KID = 'kid-353';
const KID_OFF = 'kid-353-off';
const MEL = 'Australia/Melbourne';

const Z = (iso) => Date.parse(iso); // an explicit UTC literal, e.g. Z('2026-08-27T21:00:00Z')
const MS = 1; // readability: Z(...) - MS is "1 ms before"

const atInstant = (utcMs, fn) => {
  mock.timers.enable({ apis: ['Date'], now: utcMs });
  try { return fn(); } finally { mock.timers.reset(); }
};
const sampling = (utcMs, id = KID) => atInstant(utcMs, () => childSamplingActiveNow(id));
const windowActive = (utcMs, id = KID) => atInstant(utcMs, () => childWindowActiveNow(id));

function setup({ tz, start, end }) {
  db.prepare('UPDATE settings SET timezone = ? WHERE id = ?').run(tz, 'app');
  db.prepare('UPDATE children SET sleep_window_start = ?, sleep_window_end = ?, track_sleep = 1 WHERE id = ?')
    .run(start, end, KID);
}

// The reconcile margin, READ from where childWindowActiveNow's own tail flips (that gate is unchanged by #353,
// so its tail is the existing WINDOW_MARGIN_MS). Bisects the first millisecond after the window end at which
// it is false; asserts the bracket first so a gate that never flips fails loudly instead of looping.
// (It is 5 minutes today. The number is deliberately not typed here: the test follows the constant.)
function reconcileMargin(windowEndMs) {
  let lo = windowEndMs;
  let hi = windowEndMs + 60 * 60 * 1000;
  assert.equal(windowActive(lo), true, 'the window gate must still be open at the window end (inside its tail)');
  assert.equal(windowActive(hi), false, 'the window gate must have closed an hour after the window end');
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (windowActive(mid)) lo = mid; else hi = mid;
  }
  return hi - windowEndMs;
}

before(() => {
  db.prepare(`INSERT INTO settings (id, timezone) VALUES ('app', ?)
              ON CONFLICT(id) DO UPDATE SET timezone = excluded.timezone`).run(MEL);
  db.prepare(`INSERT INTO children (id, name, track_sleep, sleep_window_start, sleep_window_end)
              VALUES (?, 'Test Child', 1, '19:00', '07:00')`).run(KID);
  db.prepare(`INSERT INTO children (id, name, track_sleep, sleep_window_start, sleep_window_end)
              VALUES (?, 'Test Child Off', 0, '19:00', '07:00')`).run(KID_OFF);
});

after(() => {
  db.close();
  cleanupTempDataDirs();
});

// ---------------------------------------------------------------------------------------------------
// P1: the tail (defect 1), 19:00-07:00, Melbourne winter (AEST = UTC+10, no DST near)
// Night 2026-08-27: starts 19:00 on 08-27 = 2026-08-27T09:00Z, ends 07:00 on 08-28 = 2026-08-27T21:00Z.
// ---------------------------------------------------------------------------------------------------

test('#353 a 19:00-07:00 child is still sampled at 07:06 and 09:59 (kills: tail without WAKE_LOOKAHEAD_MS)', () => {
  setup({ tz: MEL, start: '19:00', end: '07:00' });
  // 07:06 local = 2026-08-27T21:06Z: one minute past the old 5-minute tail. Red on dev 11236d7 (false).
  assert.equal(sampling(Z('2026-08-27T21:06:00Z')), true, '07:06 local: the morning departure is still being looked for');
  // 09:59 local = 2026-08-27T23:59Z: the last minute before the inference horizon (window end + 3 h = 10:00).
  assert.equal(sampling(Z('2026-08-27T23:59:00Z')), true, '09:59 local: still inside the inference horizon');
  // and inside the window proper (control: this was true before the fix too, so the above cannot pass vacuously)
  assert.equal(sampling(Z('2026-08-27T20:59:00Z')), true, '06:59 local: inside the window');
});

test('#353 the sampling tail ends one reconcile margin after the inference horizon, to the millisecond (kills: tail without WINDOW_MARGIN_MS, tail doubled, end edge < -> <=)', () => {
  setup({ tz: MEL, start: '19:00', end: '07:00' });
  const windowEnd = Z('2026-08-27T21:00:00Z'); // 07:00 local on 08-28
  const horizon = reportableSpanMs(KID, '2026-08-27').toMs; // read back from the app...
  assert.equal(horizon, Z('2026-08-28T00:00:00Z'), '...and checked against a literal: 10:00 local = window end + 3 real hours');
  const margin = reconcileMargin(windowEnd);
  assert.ok(margin > 0 && margin < 30 * 60 * 1000, `the reconcile margin must be small and positive (got ${margin} ms)`);
  // (Sanity, not asserted: today this margin is 5 minutes, so the edge is 2026-08-28T00:05:00Z.)
  assert.equal(sampling(horizon + margin - MS), true, 'the last millisecond of the tail is sampled');
  assert.equal(sampling(horizon + margin), false, 'the tail is half-open: the margin millisecond itself is not sampled');
  assert.equal(sampling(horizon + margin + 60 * 1000), false, 'and it stays closed after that');
});

test('#353 the afternoon gap is not sampled, and the next lead opens exactly 3 h before bedtime (kills: lead = WINDOW_MARGIN_MS, start edge >= -> >, tail too long)', () => {
  setup({ tz: MEL, start: '19:00', end: '07:00' });
  // 15:00 local on 08-28 = 2026-08-28T05:00Z: after the tail (00:05Z) and before the next lead (06:00Z).
  // A tail that never closed (or ran to the next lead) would make a 19:00-07:00 camera sample all day.
  assert.equal(sampling(Z('2026-08-28T05:00:00Z')), false, '15:00 local: outside every extended window');
  // Next night's lead: 19:00 on 08-28 = 09:00Z, 3 real hours earlier = 06:00Z (16:00 local).
  assert.equal(sampling(Z('2026-08-28T06:00:00Z') - MS), false, '1 ms before the lead edge');
  assert.equal(sampling(Z('2026-08-28T06:00:00Z')), true, 'exactly at the lead edge (>=, inclusive)');
  // The same edge for night 08-27, via the app's own span: its fromMs IS the first sampled instant.
  const { fromMs } = reportableSpanMs(KID, '2026-08-27');
  assert.equal(fromMs, Z('2026-08-27T06:00:00Z'), '16:00 local on 08-27');
  assert.equal(sampling(fromMs - MS), false);
  assert.equal(sampling(fromMs), true);
});

// ---------------------------------------------------------------------------------------------------
// P2: the horizon IS the inference's, not a second copy of it
// ---------------------------------------------------------------------------------------------------

test("#353 the sampling horizon is the inference's own: it flips one margin after where isEvidenceFinal flips, and opens at reportableSpanMs.fromMs (kills: any tail/lead that drifts from the inference constants)", () => {
  setup({ tz: MEL, start: '19:00', end: '07:00' });
  const date = '2026-08-27';
  const windowEndSql = '2026-08-27 21:00:00'; // the sleep_nights.window_end for that night: 07:00 local = 21:00Z
  const { fromMs, toMs } = reportableSpanMs(KID, date);
  // isEvidenceFinal is the inference's "no later evidence can change this night" instant; toMs is where it flips.
  assert.equal(isEvidenceFinal(windowEndSql, toMs), true, 'final exactly at toMs');
  assert.equal(isEvidenceFinal(windowEndSql, toMs - MS), false, 'not final 1 ms earlier');
  const margin = reconcileMargin(Z('2026-08-27T21:00:00Z'));
  // Sampling must cover the whole of the inference's evidence span [fromMs, toMs) ...
  assert.equal(sampling(fromMs - MS), false);
  assert.equal(sampling(fromMs), true, 'sampling opens where the inference span opens');
  assert.equal(sampling(toMs - MS), true, 'sampling covers the last millisecond the inference reads');
  // ... and runs on for exactly the reconcile margin, no more (the margin is what flushes the final minute).
  assert.equal(sampling(toMs + margin - MS), true);
  assert.equal(sampling(toMs + margin), false);
});

// ---------------------------------------------------------------------------------------------------
// P3: the head (defect 2), a window opening 01:00, whose 3 h lookbehind is on the previous calendar day
// ---------------------------------------------------------------------------------------------------

test('#353 a 01:00 bedtime is sampled from 22:00 the previous evening (kills: next night +1 never tried)', () => {
  setup({ tz: MEL, start: '01:00', end: '07:00' });
  // Night 2026-08-28 starts 01:00 on 08-28 AEST = 2026-08-27T15:00Z. The lookbehind opens 3 real hours earlier:
  // 2026-08-27T12:00Z = 22:00 local on 08-27, the PREVIOUS calendar day, so at that instant "today" is 08-27 and
  // the night that covers it is tomorrow's (08-28). The old loop tried 08-27 and 08-26 only. Red on dev 11236d7.
  assert.equal(sampling(Z('2026-08-27T12:00:00Z') - MS), false, '21:59:59.999 local');
  assert.equal(sampling(Z('2026-08-27T12:00:00Z')), true, '22:00 local: the lookbehind opens');
  assert.equal(sampling(Z('2026-08-27T12:30:00Z')), true, '22:30 local: the issue\'s example instant');
});

test('#353 the +1 night also works across a year boundary (12-31 -> 01-01, Melbourne summer AEDT = UTC+11)', () => {
  setup({ tz: MEL, start: '01:00', end: '07:00' });
  // Night 2027-01-01 starts 01:00 on 01-01 AEDT = 2026-12-31T14:00Z. Lookbehind opens 11:00Z = 22:00 local on 12-31.
  // "Tomorrow" of 2026-12-31 is 2027-01-01: the date arithmetic must roll the year, not produce 2026-12-32.
  assert.equal(sampling(Z('2026-12-31T11:00:00Z') - MS), false, '21:59:59.999 local on 12-31');
  assert.equal(sampling(Z('2026-12-31T11:00:00Z')), true, '22:00 local on 12-31');
});

// ---------------------------------------------------------------------------------------------------
// P4: the 5-minute slack of the helper was broken the same way (a start at 00:02)
// ---------------------------------------------------------------------------------------------------

test('#353 a 00:02 start is sampled from 21:02 the previous evening (kills: +1 never tried, lookbehind shorter than 3 h)', () => {
  setup({ tz: MEL, start: '00:02', end: '07:00' });
  // Night 2026-08-28 starts 00:02 on 08-28 AEST = 2026-08-27T14:02Z; lookbehind opens 3 real hours earlier
  // = 11:02Z = 21:02 local on 08-27 (previous calendar day).
  assert.equal(sampling(Z('2026-08-27T11:02:00Z') - MS), false, '21:01:59.999 local');
  assert.equal(sampling(Z('2026-08-27T11:02:00Z')), true, '21:02 local');
});

// ---------------------------------------------------------------------------------------------------
// P5: GUARD, childWindowActiveNow is UNCHANGED on purpose
// ---------------------------------------------------------------------------------------------------
// It gates the wake watcher and the timelapse. #353 widens SAMPLING only: the wake watcher has no second gate,
// so widening this one would have moved its input by up to 5 minutes for a window opening 00:00-00:04 in a
// core module, for no benefit to this issue (the leg itself is covered by the sampling gate's 3 h lead). The
// timelapse must keep recording the configured window, not the sampling horizon.

test('#353 childWindowActiveNow keeps its 5-minute tail and lead, and stays closed at 07:06 (kills: childWindowActiveNow trail = the sampling tail)', () => {
  setup({ tz: MEL, start: '19:00', end: '07:00' });
  assert.equal(windowActive(Z('2026-08-27T21:04:59.999Z')), true, '07:04:59.999 local: inside the 5-minute tail');
  assert.equal(windowActive(Z('2026-08-27T21:05:00Z')), false, '07:05 local: the tail is over');
  assert.equal(windowActive(Z('2026-08-27T21:06:00Z')), false, '07:06 local: NOT widened (sampling is, this is not)');
  assert.equal(windowActive(Z('2026-08-27T23:59:00Z')), false, '09:59 local: NOT widened');
  // Lead: 5 minutes before 19:00 on 08-27 (09:00Z) = 08:55Z, not 3 hours.
  assert.equal(windowActive(Z('2026-08-27T08:55:00Z') - MS), false);
  assert.equal(windowActive(Z('2026-08-27T08:55:00Z')), true);
  assert.equal(windowActive(Z('2026-08-27T06:00:00Z')), false, '16:00 local: where SAMPLING opens, this gate must not');
});

test('#353 childWindowActiveNow does not try the next night (kills: childWindowActiveNow also passes nextNight)', () => {
  setup({ tz: MEL, start: '00:02', end: '07:00' });
  // 23:58 local on 08-27 = 2026-08-27T13:58Z is 4 minutes before the 00:02 start, inside the 5-minute lead, if the
  // next night were a candidate. It is NOT: this gate keeps today's and yesterday's night only (a known, harmless
  // gap for a window opening 00:00-00:04: the wake watcher arms only once sleep has begun). Pinned as unchanged.
  assert.equal(windowActive(Z('2026-08-27T13:58:00Z')), false, '23:58 local: unchanged on purpose');
  // while the SAMPLING gate does cover that instant (control: the two gates really do differ here)
  assert.equal(sampling(Z('2026-08-27T13:58:00Z')), true, 'sampling covers it through its 3 h lead');
});

// ---------------------------------------------------------------------------------------------------
// P6: DST. The lead and the tail are 3 REAL hours (absolute ms added to real instants), as computeNight does.
// Melbourne 2026: DST starts 10-04 02:00 AEST -> 03:00 AEDT (= 2026-10-03T16:00:00Z) and ends 04-05 03:00 AEDT
// -> 02:00 AEST (= 2026-04-04T16:00:00Z). A "wall clock + 3 h" implementation differs from the real one by
// exactly an hour whenever the transition lies between the window edge and the lead/horizon.
// ---------------------------------------------------------------------------------------------------

test('#353 DST spring-forward: the horizon is 3 REAL hours after a 01:00 window end (kills: horizon computed in wall-clock, in the other direction)', () => {
  setup({ tz: MEL, start: '21:00', end: '01:00' });
  // Night 2026-10-03: starts 21:00 AEST 10-03 = 11:00Z; ends 01:00 AEST 10-04 = 2026-10-03T15:00Z, BEFORE the change.
  // The change (16:00Z) lies between the window end and the horizon. Horizon = end + 3 real hours = 18:00Z
  // (= 05:00 AEDT). A wall-clock horizon "01:00 + 3 h = 04:00 local" is 17:00Z (04:00 AEDT) and would be one
  // hour SHORT.
  const margin = reconcileMargin(Z('2026-10-03T15:00:00Z'));
  assert.equal(sampling(Z('2026-10-03T17:30:00Z')), true, '17:30Z = 04:30 AEDT: a wall-clock horizon (17:00Z) would already be closed');
  assert.equal(sampling(Z('2026-10-03T18:00:00Z') + margin - MS), true, 'last millisecond of the real tail');
  assert.equal(sampling(Z('2026-10-03T18:00:00Z') + margin), false, 'closed at horizon + margin');
  // (Sanity, not asserted: with today's 5-minute margin the edge is 18:05:00Z.)
});

test('#353 DST fall-back: the horizon is 3 REAL hours after a 01:00 window end (kills: horizon computed in wall-clock, in the other direction)', () => {
  setup({ tz: MEL, start: '21:00', end: '01:00' });
  // Night 2026-04-04: starts 21:00 AEDT 04-04 = 10:00Z; ends 01:00 AEDT 04-05 = 2026-04-04T14:00Z, BEFORE the change.
  // The change (16:00Z) lies between the window end and the horizon. Horizon = end + 3 real hours = 17:00Z
  // (= 03:00 AEST). A wall-clock horizon "01:00 + 3 h = 04:00 local" is 18:00Z (04:00 AEST), one hour LONG:
  // it would still be sampling at 17:30Z.
  const margin = reconcileMargin(Z('2026-04-04T14:00:00Z'));
  assert.equal(sampling(Z('2026-04-04T17:00:00Z') + margin - MS), true, 'last millisecond of the real tail');
  assert.equal(sampling(Z('2026-04-04T17:00:00Z') + margin), false, 'closed at horizon + margin');
  assert.equal(sampling(Z('2026-04-04T17:30:00Z')), false, '17:30Z: a wall-clock horizon (18:00Z) would still be open');
  // (Sanity, not asserted: with today's 5-minute margin the edge is 17:05:00Z.)
});

test('#353 DST spring-forward: a lookbehind that really crosses the change is 3 REAL hours (kills: lead computed in wall-clock)', () => {
  setup({ tz: MEL, start: '03:30', end: '09:00' });
  // Night 2026-10-04 starts 03:30 AEDT on 10-04 = 2026-10-03T16:30Z, AFTER the 02:00->03:00 change (16:00Z).
  // The lead opens 3 REAL hours earlier = 13:30Z (= 23:30 AEST on 10-03), which is BEFORE the change, so the
  // transition lies between the lead edge and the window start. A wall-clock "03:30 - 3 h" would be 00:30 local
  // on 10-04, a different instant altogether.
  assert.equal(sampling(Z('2026-10-03T13:30:00Z') - MS), false, '13:29:59.999Z');
  assert.equal(sampling(Z('2026-10-03T13:30:00Z')), true, '13:30:00Z: the real 3 h lead');
});

test('#353 DST fall-back: a lookbehind that really crosses the change is 3 REAL hours (kills: lead computed in wall-clock)', () => {
  setup({ tz: MEL, start: '04:00', end: '10:00' });
  // Night 2026-04-05 starts 04:00 AEST on 04-05 = 2026-04-04T18:00Z, AFTER the 03:00->02:00 change (16:00Z).
  // The lead opens 3 REAL hours earlier = 15:00Z (02:00 AEDT, still before the change). A wall-clock
  // "04:00 - 3 h = 01:00 local" is 01:00 AEDT = 14:00Z, an hour earlier than the real lead.
  assert.equal(sampling(Z('2026-04-04T14:00:00Z')), false, '14:00Z: where a wall-clock lead would already be open');
  assert.equal(sampling(Z('2026-04-04T15:00:00Z') - MS), false, '14:59:59.999Z');
  assert.equal(sampling(Z('2026-04-04T15:00:00Z')), true, '15:00:00Z: the real 3 h lead');
});

// ---------------------------------------------------------------------------------------------------
// P7: guards and other houses
// ---------------------------------------------------------------------------------------------------

test('#353 a 24-hour window (07:00-07:00) is sampled at every probe across the DST change (kills: a candidate-night range that leaves a hole)', () => {
  setup({ tz: MEL, start: '07:00', end: '07:00' }); // end <= start wraps: the window is the whole day
  // Probe every 37 minutes (coprime with an hour, so the probes land on every minute of the hour over the sweep)
  // from 2026-10-01 to 2026-10-08, which includes the 10-04 spring-forward in Melbourne.
  const from = Z('2026-10-01T00:00:00Z');
  const to = Z('2026-10-08T00:00:00Z');
  let probes = 0;
  for (let t = from; t < to; t += 37 * 60 * 1000) {
    probes++;
    assert.equal(sampling(t), true, `${new Date(t).toISOString()} must be sampled`);
  }
  assert.ok(probes > 250, `the sweep must really probe the week (${probes} probes)`);
});

test('#353 a child with tracking off, and an unknown child, are never sampled even inside an extended window', () => {
  setup({ tz: MEL, start: '19:00', end: '07:00' });
  const t = Z('2026-08-27T23:59:00Z'); // 09:59 local: inside KID's extended window (control below)
  assert.equal(sampling(t, KID), true, 'control: the same instant IS sampled for a tracking child');
  assert.equal(sampling(t, KID_OFF), false, 'tracking off');
  assert.equal(sampling(t, 'no-such-child-353'), false, 'unknown child');
});

test('#353 under the default UTC timezone the horizon and the lead are the same 3 h + margin (nothing is Melbourne-shaped)', () => {
  setup({ tz: 'UTC', start: '19:00', end: '07:00' });
  // Night 2026-08-27: ends 07:00Z on 08-28; horizon = 10:00Z; lead opens 16:00Z on 08-27.
  const margin = reconcileMargin(Z('2026-08-28T07:00:00Z'));
  assert.equal(sampling(Z('2026-08-28T07:06:00Z')), true);
  assert.equal(sampling(Z('2026-08-28T10:00:00Z') + margin - MS), true);
  assert.equal(sampling(Z('2026-08-28T10:00:00Z') + margin), false);
  assert.equal(sampling(Z('2026-08-27T16:00:00Z') - MS), false);
  assert.equal(sampling(Z('2026-08-27T16:00:00Z')), true);
  // and the head (+1) in UTC: a 01:00 start has its lookbehind at 22:00Z the day before
  setup({ tz: 'UTC', start: '01:00', end: '07:00' });
  assert.equal(sampling(Z('2026-08-27T22:00:00Z') - MS), false);
  assert.equal(sampling(Z('2026-08-27T22:00:00Z')), true);
});

test('#353 a half-hour-offset zone (Asia/Kolkata, UTC+5:30, no DST) gets the same lead and horizon', () => {
  setup({ tz: 'Asia/Kolkata', start: '22:00', end: '06:00' });
  // Night 2026-08-27: starts 22:00 IST = 16:30Z on 08-27; lead opens 19:00 local = 13:30Z on 08-27.
  // Ends 06:00 IST on 08-28 = 00:30Z; horizon = 03:30Z on 08-28.
  const margin = reconcileMargin(Z('2026-08-28T00:30:00Z'));
  assert.equal(sampling(Z('2026-08-27T13:30:00Z') - MS), false, '18:59:59.999 IST');
  assert.equal(sampling(Z('2026-08-27T13:30:00Z')), true, '19:00 IST');
  assert.equal(sampling(Z('2026-08-28T03:30:00Z') + margin - MS), true);
  assert.equal(sampling(Z('2026-08-28T03:30:00Z') + margin), false);
});
