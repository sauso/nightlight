// Tranche A of the sleepAnalysis.js coverage work: the three functions that had never been executed
// by a test at all — `sleepInsights`, `pearson` (through it) and `runNightlySleepJob`.
//
// These are not "coverage tests". Each one exists because the function it covers can fail in a way
// nobody would notice: sleepInsights puts a number in front of the user and a divide-by-zero there
// shows up as NaN, and runNightlySleepJob is the only thing that ever WRITES a stored night — if it
// stops after the first child, the second child simply has no sleep history and nothing says so.
//
// DATA_DIR is pointed at a throwaway directory BEFORE sleepAnalysis is imported, because db.js opens
// the database at module load. Hence the dynamic import below.

import { test, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nightlight-insights-'));
process.env.DATA_DIR = TMP;

const { sleepInsights, runNightlySleepJob, lastCompletedNightDate, currentNightDate,
  childWindowActiveNow, childSamplingActiveNow, startSleepJob, getStoredNights } =
  await import('../src/lib/sleepAnalysis.js');
const { default: db } = await import('../src/db.js');

const KID = 'insight-child';
const KID2 = 'insight-child-2';
const TZ = 'Australia/Melbourne';

const insertNight = db.prepare(
  `INSERT INTO sleep_nights (child_id, night_date, window_start, window_end, status, onset_at, wake_at,
     asleep_minutes, awake_minutes, wake_count, longest_stretch_minutes, coverage_minutes,
     computed_at, avg_temperature, avg_humidity)
   VALUES (?, ?, '2026-07-01 09:00:00', '2026-07-01 21:00:00', 'ok', NULL, NULL, ?, 0, ?, ?, 700,
     '2026-07-02 00:00:00', ?, ?)`
);

// n nights whose temperature and wake-count move together, so there is a real correlation to find.
function layNights(childId, specs) {
  specs.forEach(([temp, wakes, asleep, humidity], i) => {
    const d = String(i + 1).padStart(2, '0');
    insertNight.run(childId, `2026-06-${d}`, asleep, wakes, asleep, temp, humidity ?? null);
  });
}

// --- A camera + real activity data, used only by the issue #351 (provisional report) tests below.
// Everything else in this file computes a night with no camera at all ('no_data'), which is enough for
// most of these job tests — but a 'no_data' row still carries a real window_end, which is all
// isEvidenceFinal needs, and it's what most of the #351 tests below use too. Only the one test that
// needs to show the report's actual CONTENT changing (not just an internal recompute) needs real data.
const CAM3 = 'insight-cam';
const NIGHT_DATE = '2026-07-01';
const TZ_OFF3 = 10 * 3600 * 1000; // Australia/Melbourne, July: UTC+10, no DST edge to reason about
const at3 = (h, m, dayShift = 0, s = 0) => new Date(Date.UTC(2026, 6, 1 + dayShift, h, m, s) - TZ_OFF3);
const sqlTime3 = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
const hhmm3 = (u) =>
  u ? new Date(u.replace(' ', 'T') + 'Z').toLocaleString('en-AU', { timeZone: TZ, hour12: false, hour: '2-digit', minute: '2-digit' }) : null;
const insertSample3 = db.prepare(
  `INSERT INTO activity_samples (camera_id, bucket_start, motion_level, motion_peak, sound_level,
     sound_peak, motion_frames, sound_windows) VALUES (?, ?, ?, ?, 0, 0, 1, 0)`
);
const insertTransition3 = db.prepare(
  `INSERT INTO bed_transitions (camera_id, type, peak, created_at) VALUES (?, ?, ?, ?)`
);
// One sample per minute across [19:00, to). Minutes inside an `active` range carry real movement.
function layNight3(activeRanges, to) {
  for (let t = at3(19, 0); t < to; t = new Date(t.getTime() + 60000)) {
    const moving = activeRanges.some(([a, b]) => t >= a && t < b);
    insertSample3.run(CAM3, sqlTime3(t), moving ? 0.4 : 0.0002, moving ? 0.6 : 0.0002);
  }
}

before(() => {
  db.prepare(`INSERT INTO settings (id, timezone) VALUES ('app', ?)
              ON CONFLICT(id) DO UPDATE SET timezone = excluded.timezone`).run(TZ);
  db.prepare(`INSERT INTO children (id, name, track_sleep, sleep_window_start, sleep_window_end)
              VALUES (?, 'Insight Kid', 1, '19:00', '07:00')`).run(KID);
  db.prepare(`INSERT INTO cameras (id, name, rtsp_url, child_id, mediamtx_path)
              VALUES (?, 'Insight Cam', 'rtsp://example/stream', ?, 'insightcam')`).run(CAM3, KID);
});

beforeEach(() => {
  db.prepare('DELETE FROM sleep_nights').run();
  db.prepare('DELETE FROM children WHERE id = ?').run(KID2);
  db.prepare('UPDATE children SET track_sleep = 1 WHERE id = ?').run(KID);
  db.prepare('DELETE FROM activity_samples WHERE camera_id = ?').run(CAM3);
  db.prepare('DELETE FROM bed_transitions WHERE camera_id = ?').run(CAM3);
});

after(() => {
  db.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

// --- sleepInsights: the states the UI has to render -------------------------------------------------

test('a child with sleep tracking off gets no insights at all', () => {
  db.prepare('UPDATE children SET track_sleep = 0 WHERE id = ?').run(KID);
  assert.equal(sleepInsights(KID).status, 'off');
});

test('too few nights reports insufficient, and says how many are needed', () => {
  layNights(KID, [[20, 1, 600], [21, 2, 590], [22, 1, 610]]); // 3 < the 5-night minimum
  const r = sleepInsights(KID);
  assert.equal(r.status, 'insufficient');
  assert.equal(r.nights_analyzed, 3);
  assert.ok(r.min_nights > r.nights_analyzed, 'the UI needs the target to write "keep tracking"');
});

test('nights with no temperature reading are not counted towards the minimum', () => {
  // Six nights, but only three carry a temperature — the correlation is against temperature, so the
  // other three cannot contribute and must not make the sample look big enough to trust.
  layNights(KID, [[20, 1, 600], [21, 2, 590], [22, 1, 610]]);
  for (const d of ['10', '11', '12']) {
    db.prepare(
      `INSERT INTO sleep_nights (child_id, night_date, window_start, window_end, status,
         asleep_minutes, awake_minutes, wake_count, coverage_minutes, computed_at, avg_temperature)
       VALUES (?, ?, '2026-07-01 09:00:00', '2026-07-01 21:00:00', 'ok', 600, 0, 1, 700,
         '2026-07-02 00:00:00', NULL)`).run(KID, `2026-06-${d}`);
  }
  assert.equal(sleepInsights(KID).status, 'insufficient');
});

test('a warm room linked to more waking is reported as such', () => {
  // Temperature and wake-ups rise together — a strong positive correlation.
  layNights(KID, [[17, 0, 660], [18, 1, 640], [19, 1, 630], [21, 3, 590], [22, 4, 570], [23, 5, 540]]);
  const r = sleepInsights(KID);
  assert.equal(r.status, 'ok');
  assert.equal(r.verdict, 'warm_more_wakes');
  assert.ok(r.temp_wake_r > 0.35, `expected a strong positive r, got ${r.temp_wake_r}`);
  assert.equal(r.nights_analyzed, 6);
  // The median split has to put nights on both sides, or the UI has nothing to compare.
  assert.ok(r.cooler && r.warmer, 'both halves must be populated');
  assert.ok(r.warmer.avg_temp > r.cooler.avg_temp);
  assert.ok(r.warmer.avg_wakes > r.cooler.avg_wakes);
});

test('the opposite link is reported as the opposite, not as "no link"', () => {
  layNights(KID, [[17, 5, 540], [18, 4, 570], [19, 3, 590], [21, 1, 630], [22, 1, 640], [23, 0, 660]]);
  const r = sleepInsights(KID);
  assert.equal(r.verdict, 'warm_fewer_wakes');
  assert.ok(r.temp_wake_r < -0.35);
});

test('a room that barely changed temperature says so instead of finding a pattern', () => {
  // Under a degree of spread across the nights: any r here is an artefact of three data points.
  layNights(KID, [[20.0, 0, 660], [20.2, 1, 650], [20.3, 2, 640], [20.5, 3, 630], [20.6, 4, 620]]);
  const r = sleepInsights(KID);
  assert.equal(r.status, 'ok');
  assert.equal(r.verdict, 'flat', 'a flat room must not be reported as a discovery');
  assert.ok(r.temp_spread < 1);
});

test('an identical temperature every night yields no correlation rather than NaN', () => {
  // THE divide-by-zero: with zero variance the Pearson denominator is 0. Returning NaN here would put
  // "NaN" on the insights card; the guard has to return null and the verdict has to stay honest.
  layNights(KID, [[20, 0, 660], [20, 1, 650], [20, 2, 640], [20, 3, 630], [20, 4, 620]]);
  const r = sleepInsights(KID);
  assert.equal(r.status, 'ok');
  assert.equal(r.temp_wake_r, null, 'zero temperature variance must give null, never NaN');
  assert.equal(r.temp_asleep_r, null);
  assert.equal(r.verdict, 'flat');
  assert.equal(r.temp_spread, 0);
});

test('an identical wake count every night also yields no correlation', () => {
  // The same divide-by-zero from the other side: the temperature varies, the outcome does not.
  layNights(KID, [[17, 2, 600], [19, 2, 600], [21, 2, 600], [23, 2, 600], [25, 2, 600]]);
  const r = sleepInsights(KID);
  assert.equal(r.temp_wake_r, null, 'zero wake variance must give null, never NaN');
  assert.equal(r.verdict, 'none', 'temperature DID vary, so this is "no link found", not "too flat"');
});

test('humidity is averaged only over the nights that recorded it', () => {
  // Three nights with humidity, two without. Averaging over all five (treating null as 0) would report
  // a humidity nobody measured.
  layNights(KID, [[17, 0, 660, 50], [19, 1, 650, 60], [21, 2, 640, 70], [23, 3, 630, null], [25, 4, 620, null]]);
  const r = sleepInsights(KID);
  assert.equal(r.overall.avg_humidity, 60, 'must average 50/60/70, not dilute with the two nulls');
});

test('with no humidity recorded at all, humidity is null rather than zero', () => {
  layNights(KID, [[17, 0, 660], [19, 1, 650], [21, 2, 640], [23, 3, 630], [25, 4, 620]]);
  assert.equal(sleepInsights(KID).overall.avg_humidity, null);
});

test('only nights that scored ok are analysed', () => {
  // An empty or no_data night has no meaningful wake count; including it would corrupt the correlation.
  layNights(KID, [[17, 0, 660], [19, 1, 650], [21, 2, 640], [23, 3, 630], [25, 4, 620]]);
  db.prepare(
    `INSERT INTO sleep_nights (child_id, night_date, window_start, window_end, status,
       asleep_minutes, awake_minutes, wake_count, coverage_minutes, computed_at, avg_temperature)
     VALUES (?, '2026-06-20', '2026-07-01 09:00:00', '2026-07-01 21:00:00', 'empty',
       NULL, NULL, NULL, 700, '2026-07-02 00:00:00', 30)`).run(KID);
  const r = sleepInsights(KID);
  assert.equal(r.nights_analyzed, 5, 'the empty night must not be counted');
  assert.equal(r.overall.max_temp, 25, 'nor drag the temperature range to its 30C');
});

test('another child\'s nights never leak into these insights', () => {
  db.prepare(`INSERT INTO children (id, name, track_sleep, sleep_window_start, sleep_window_end)
              VALUES (?, 'Other', 1, '19:00', '07:00')`).run(KID2);
  layNights(KID, [[17, 0, 660], [19, 1, 650], [21, 2, 640], [23, 3, 630], [25, 4, 620]]);
  layNights(KID2, [[40, 9, 100]]);
  const r = sleepInsights(KID);
  assert.equal(r.nights_analyzed, 5);
  assert.equal(r.overall.max_temp, 25);
});

test('the nights limit is clamped rather than trusted', () => {
  layNights(KID, [[17, 0, 660], [19, 1, 650], [21, 2, 640], [23, 3, 630], [25, 4, 620]]);
  // 0 and a negative would make LIMIT return nothing; a huge value would scan without bound.
  for (const n of [0, -5, 9999]) {
    assert.ok(['ok', 'insufficient'].includes(sleepInsights(KID, { nights: n }).status),
      `nights=${n} must not throw or return garbage`);
  }
  assert.equal(sleepInsights(KID, { nights: 9999 }).nights_analyzed, 5);
});

// --- runNightlySleepJob: the only thing that ever writes a stored night ------------------------------

test('the nightly job stores the last completed night for a tracked child', () => {
  const before = db.prepare('SELECT COUNT(*) c FROM sleep_nights WHERE child_id = ?').get(KID).c;
  assert.equal(before, 0);
  runNightlySleepJob();
  const row = db.prepare('SELECT * FROM sleep_nights WHERE child_id = ?').get(KID);
  assert.ok(row, 'the job must write a row even when there is no activity data (as no_data)');
  assert.equal(row.night_date, lastCompletedNightDate(KID));
});

test('the nightly job is idempotent: running it twice does not rewrite the night', () => {
  runNightlySleepJob();
  const first = db.prepare('SELECT computed_at FROM sleep_nights WHERE child_id = ?').get(KID);
  runNightlySleepJob();
  const rows = db.prepare('SELECT * FROM sleep_nights WHERE child_id = ?').all(KID);
  assert.equal(rows.length, 1, 'a second run must not insert a duplicate night');
  assert.equal(rows[0].computed_at, first.computed_at, 'nor recompute the one already stored');
});

test('a child with sleep tracking off is skipped by the nightly job', () => {
  db.prepare('UPDATE children SET track_sleep = 0 WHERE id = ?').run(KID);
  runNightlySleepJob();
  assert.equal(db.prepare('SELECT COUNT(*) c FROM sleep_nights WHERE child_id = ?').get(KID).c, 0);
});

test('every tracked child gets a night, not just the first', () => {
  // The failure this guards: one child throwing, or an early return, silently leaves the others with
  // no sleep history at all — and nothing in the UI distinguishes "no night stored" from "slept badly".
  db.prepare(`INSERT INTO children (id, name, track_sleep, sleep_window_start, sleep_window_end)
              VALUES (?, 'Second Kid', 1, '18:30', '06:30')`).run(KID2);
  runNightlySleepJob();
  for (const id of [KID, KID2]) {
    assert.ok(db.prepare('SELECT 1 FROM sleep_nights WHERE child_id = ?').get(id), `${id} was skipped`);
  }
});

test('each child is computed on their OWN window, not a shared one', () => {
  // KID sleeps 19:00-07:00 and KID2 18:30-06:30, so their stored windows must differ. Sharing one
  // child's window would silently score the other against the wrong hours.
  db.prepare(`INSERT INTO children (id, name, track_sleep, sleep_window_start, sleep_window_end)
              VALUES (?, 'Second Kid', 1, '18:30', '06:30')`).run(KID2);
  runNightlySleepJob();
  const a = db.prepare('SELECT window_start FROM sleep_nights WHERE child_id = ?').get(KID);
  const b = db.prepare('SELECT window_start FROM sleep_nights WHERE child_id = ?').get(KID2);
  assert.notEqual(a.window_start, b.window_start, 'the two children must not share a window');
});

test('an unparseable sleep window falls back to a default instead of crashing the job', () => {
  // Renamed after coverage caught this test passing for the wrong reason. It was called "the nightly
  // job swallows a failure", asserting doesNotThrow — but parseHm defaults a garbage window to 19:00,
  // so nothing ever threw and the catch-all it claimed to cover never ran. What it DOES verify is
  // worth keeping: bad config degrades to the default window rather than taking the night down.
  //
  // The job's outer try/catch is still unexercised (sleepAnalysis.js:1216-1218). Reaching it needs a
  // failure inside better-sqlite3 itself, which is not worth contorting a real database to fake — so
  // it is knowingly uncovered rather than covered by a test that proves nothing. Noted in ROADMAP 2.3.
  db.prepare('UPDATE children SET sleep_window_start = ? WHERE id = ?').run('not-a-time', KID);
  assert.doesNotThrow(() => runNightlySleepJob());
  const row = db.prepare('SELECT window_start FROM sleep_nights WHERE child_id = ?').get(KID);
  assert.ok(row, 'the night is still computed, on the fallback window');
  db.prepare('UPDATE children SET sleep_window_start = ? WHERE id = ?').run('19:00', KID);
});

test('a night already stored is left alone even if it was stored as no_data', () => {
  // The guard checks the EXISTING row's OWN `computed_at` against isEvidenceFinal — NOT bare `existing`,
  // and NOT the current time either (issue #351, refined by adversarial review: see the comment above
  // the gate in runNightlySleepJob for why checking "now" instead of the row's own computed_at silently
  // skips the one job tick that could ever complete a marginal night's evidence). `computed_at` here is
  // pinned to one second past this night's own evidence horizon (window_end + 3h = '2026-07-02
  // 00:00:00'), so the fixture is genuinely final BY THE MECHANISM ITSELF, not just by real-world old
  // age — a non-parseable sentinel like the literal string 'PINNED' would (correctly, now) never compare
  // as final and would defeat this exact test. `existing.status === "ok"` is still not the guard either
  // way: re-running a final night must never overwrite it, because activity_samples age out and a
  // recompute of an aged-out night would replace a good row with no_data. See the sibling test right
  // below for the other half — a STILL-PROVISIONAL row, which this same guard DOES allow to be rewritten.
  const nightDate = lastCompletedNightDate(KID);
  db.prepare(
    `INSERT INTO sleep_nights (child_id, night_date, window_start, window_end, status,
       asleep_minutes, awake_minutes, wake_count, coverage_minutes, computed_at)
     VALUES (?, ?, '2026-07-01 09:00:00', '2026-07-01 21:00:00', 'ok', 612, 8, 2, 700, '2026-07-02 00:00:01')`
  ).run(KID, nightDate);
  runNightlySleepJob();
  const row = db.prepare('SELECT * FROM sleep_nights WHERE child_id = ? AND night_date = ?').get(KID, nightDate);
  assert.equal(row.computed_at, '2026-07-02 00:00:01', 'an existing FINAL night must never be recomputed by the job');
  assert.equal(row.asleep_minutes, 612);
});

// --- runNightlySleepJob keeps a provisional night updating within its evidence window (issue #351) --
//
// Before this, a stored night was written once and never touched again (`if (existing) continue`). A
// night whose departure hadn't been confirmed yet (issue #350) would freeze at whatever the FIRST job
// run happened to see — permanently, even once the real evidence became available a few hours later.
// isEvidenceFinal (window_end + WAKE_LOOKAHEAD_MS, the SAME horizon issue #350's departure scan itself
// is bounded by) is what now decides whether a stored row is still allowed to change.

test('...but a still-provisional row (the window only just closed) IS rewritten by a later run', (t) => {
  // Same shape as the test above, except BOTH window_end and computed_at are set from the MOCKED "now"
  // itself, just past close — nowhere near the 3h evidence horizon — so this is the sibling case that
  // guard must allow. computed_at = window close itself (well before window_end + 3h), matching a row
  // that was written the moment the window closed, exactly like the fixture right above but genuinely
  // still-provisional instead of genuinely final.
  //
  // A real, ordinary occupied night — NOT the no-camera default this file mostly uses — because with
  // allowDowngrade:false (issue #351 adversarial review), a recompute that found no camera at all would
  // legitimately come back `no_data`, and refusing to downgrade an existing `ok` row over that is now
  // CORRECT behavior, not something this test should be fighting.
  layNight3([[at3(19, 0), at3(19, 10)], [at3(23, 0), at3(23, 6)], [at3(1, 0, 1), at3(1, 9, 1)]], at3(7, 0, 1));
  t.mock.timers.enable({ apis: ['Date'], now: at3(7, 5, 1).getTime() });
  const nightDate = lastCompletedNightDate(KID);
  db.prepare(
    `INSERT INTO sleep_nights (child_id, night_date, window_start, window_end, status,
       asleep_minutes, awake_minutes, wake_count, coverage_minutes, computed_at)
     VALUES (?, ?, ?, ?, 'ok', 612, 8, 2, 700, ?)`
  ).run(KID, nightDate, sqlTime3(at3(19, 0)), sqlTime3(at3(7, 0, 1)), sqlTime3(at3(7, 0, 1)));
  runNightlySleepJob();
  const row = db.prepare('SELECT computed_at FROM sleep_nights WHERE child_id = ? AND night_date = ?').get(KID, nightDate);
  assert.notEqual(row.computed_at, sqlTime3(at3(7, 0, 1)), 'a still-provisional night must be recomputed, not left alone');
});

test('a provisional report keeps updating as its evidence window fills', async (t) => {
  // A real departure that falls entirely AFTER window close (07:00) — the same shape used in
  // sleepAnalysis.test.js's own issue #352 tests. Quiet from the exit through 07:40 gives 20+ real
  // minutes to corroborate it (MORNING_ABSENCE_MIN).
  layNight3([[at3(19, 0), at3(19, 10)], [at3(23, 0), at3(23, 6)], [at3(6, 50, 1), at3(7, 15, 1)]], at3(7, 40, 1));
  insertTransition3.run(CAM3, 'out_of_bed', 0.4, sqlTime3(at3(7, 15, 1, 30)));

  // Just after window close: nowhere near enough real time has elapsed to confirm the departure, so the
  // report can only fall back to the movement-only figure — the active run reaching window close itself.
  t.mock.timers.enable({ apis: ['Date'], now: at3(7, 5, 1).getTime() });
  runNightlySleepJob();
  let row = db.prepare('SELECT wake_at FROM sleep_nights WHERE child_id = ? AND night_date = ?').get(KID, NIGHT_DATE);
  assert.equal(hhmm3(row.wake_at), '06:50', 'too little real time has elapsed to confirm the real departure yet');

  // Enough real time has now elapsed to corroborate the departure (20+ minutes of confirmed quiet after
  // 07:15:30) — but deliberately NOT all the way to the 3h evidence horizon (10:00). If the job only
  // ever recomputed once evidence goes fully final, it would never catch this: `existing` would already
  // be set and isEvidenceFinal(window_end, now) TRUE by 10:00, so a run right at that boundary SKIPS
  // recomputing rather than performing it — the SAME stored night must already have caught up on one of
  // the ordinary 30-minute ticks well before then.
  t.mock.timers.tick(at3(8, 0, 1).getTime() - at3(7, 5, 1).getTime());
  runNightlySleepJob();
  row = db.prepare('SELECT wake_at FROM sleep_nights WHERE child_id = ? AND night_date = ?').get(KID, NIGHT_DATE);
  assert.equal(hhmm3(row.wake_at), '07:15', 'the provisional report must update once the real departure is confirmable');
});

test('★ a departure confirmable only in the LAST 30-minute tick before the horizon is still caught (adversarial review finding)', async (t) => {
  // Found by adversarial review, not by this suite. The naive gate — skip once `isEvidenceFinal(window_
  // end, now)` — looks right but skips exactly the wrong tick: computeNight bounds its OWN lookahead by
  // `min(now, horizon)`, so the tick that FIRST reaches the horizon is the ONLY tick that could ever see
  // the full 3h of evidence — and the naive gate treats that same instant as "already final, skip".
  // Exit at 09:35 (window_end+2h35m) needing 20 real minutes of confirming quiet resolves at 09:55 —
  // comfortably inside the 3h horizon (10:00) in principle, but NOT YET visible at the tick before it
  // (09:30, evidenceCutoffMs capped there, before the exit has even happened) — so the ONLY tick that
  // can ever see the confirming quiet is the one landing exactly AT the horizon itself. Demonstrated to
  // freeze at `wake_at = null` FOREVER under the naive gate — see this PR's own history for the repro.
  layNight3([[at3(19, 0), at3(19, 10)], [at3(23, 0), at3(23, 6)], [at3(9, 25, 1), at3(9, 35, 1)]], at3(10, 0, 1));
  insertTransition3.run(CAM3, 'out_of_bed', 0.4, sqlTime3(at3(9, 35, 1, 30)));

  t.mock.timers.enable({ apis: ['Date'], now: at3(7, 5, 1).getTime() }); // first write
  runNightlySleepJob();
  t.mock.timers.tick(at3(9, 30, 1).getTime() - at3(7, 5, 1).getTime()); // exit hasn't happened yet
  runNightlySleepJob();
  let row = db.prepare('SELECT wake_at FROM sleep_nights WHERE child_id = ? AND night_date = ?').get(KID, NIGHT_DATE);
  assert.equal(row.wake_at, null, 'sanity: not yet confirmable this early');

  t.mock.timers.tick(at3(10, 0, 1).getTime() - at3(9, 30, 1).getTime()); // exactly the 3h horizon
  runNightlySleepJob();
  row = db.prepare('SELECT wake_at FROM sleep_nights WHERE child_id = ? AND night_date = ?').get(KID, NIGHT_DATE);
  assert.equal(hhmm3(row.wake_at), '09:35', 'the tick exactly at the horizon must still be allowed to run once');

  t.mock.timers.tick(30 * 60 * 1000); // well past — must stay exactly as it was captured
  runNightlySleepJob();
  row = db.prepare('SELECT wake_at FROM sleep_nights WHERE child_id = ? AND night_date = ?').get(KID, NIGHT_DATE);
  assert.equal(hhmm3(row.wake_at), '09:35', 'stable after — frozen the moment a write happened at-or-after the horizon');
});

test('★ a camera removed mid-provisional-window must not downgrade an already-scored night (adversarial review finding)', (t) => {
  // Found by adversarial review, not by this suite. Before this fix, computeAndStoreNight's default
  // allowDowngrade:true meant a SECOND provisional pass that happened to see less data than the first —
  // e.g. the camera was unassigned/deleted, or reassigned to a different child, mid-window — could
  // silently overwrite an already-good `ok` result with `no_data`. Combined with the computed_at-based
  // finality check above, that bad no_data row would then freeze there forever once evidence went final.
  t.after(() => {
    // Restore the shared fixture camera other tests in this file depend on.
    db.prepare(`INSERT INTO cameras (id, name, rtsp_url, child_id, mediamtx_path)
                VALUES (?, 'Insight Cam', 'rtsp://example/stream', ?, 'insightcam')
                ON CONFLICT(id) DO NOTHING`).run(CAM3, KID);
  });
  // An ordinary, fully-observed night — scores 'ok' on the very first pass, no departure confirmation
  // needed (the point here is the provisional-refresh mechanism's safety, not #350's own scan).
  layNight3([[at3(19, 0), at3(19, 10)], [at3(23, 0), at3(23, 6)], [at3(1, 0, 1), at3(1, 9, 1)]], at3(7, 0, 1));

  t.mock.timers.enable({ apis: ['Date'], now: at3(7, 5, 1).getTime() });
  runNightlySleepJob();
  let row = db.prepare('SELECT status, asleep_minutes FROM sleep_nights WHERE child_id = ? AND night_date = ?').get(KID, NIGHT_DATE);
  assert.equal(row.status, 'ok', 'sanity: the first pass scores a real night normally');
  const firstAsleep = row.asleep_minutes;

  db.prepare('DELETE FROM cameras WHERE id = ?').run(CAM3); // e.g. a hardware swap mid-window

  t.mock.timers.tick(60 * 60 * 1000); // 1h later, still well within the 3h provisional window
  runNightlySleepJob();
  row = db.prepare('SELECT status, asleep_minutes FROM sleep_nights WHERE child_id = ? AND night_date = ?').get(KID, NIGHT_DATE);
  assert.equal(row.status, 'ok', 'a real scored night must not downgrade to no_data just because a camera was later removed');
  assert.equal(row.asleep_minutes, firstAsleep, 'the original good numbers must be preserved, not overwritten with no_data');
});

test('initial insufficient data recovers once real samples arrive, while still provisional', (t) => {
  // Nothing recorded yet (e.g. the sampler hasn't backfilled this stretch) — just after window close.
  t.mock.timers.enable({ apis: ['Date'], now: at3(7, 5, 1).getTime() });
  runNightlySleepJob();
  let row = db.prepare('SELECT status FROM sleep_nights WHERE child_id = ? AND night_date = ?').get(KID, NIGHT_DATE);
  assert.equal(row.status, 'no_data', 'nothing was recorded yet');

  // The night's samples arrive — quiet throughout, an empty bed. Still well within the evidence horizon.
  layNight3([], at3(7, 0, 1));
  t.mock.timers.tick(30 * 60 * 1000);
  runNightlySleepJob();
  row = db.prepare('SELECT status FROM sleep_nights WHERE child_id = ? AND night_date = ?').get(KID, NIGHT_DATE);
  assert.equal(row.status, 'empty', 'a provisional no_data row must recover once real coverage exists');
});

test('no duplicate timelapse/notification pass while a night is still provisional', async (t) => {
  // Notification fires once on first write; timelapse assembly fires once on the first SCORED pass (see
  // the comments above that block in runNightlySleepJob — a `no_data` pass defers it rather than firing
  // wastefully, issue #351 adversarial review) — either way, a provisional refresh must not repeat it.
  // assembleTimelapse is reached via a dynamic import, so it can be swapped out here without touching the
  // module sleepAnalysis.js itself already resolved at file-load time (a static import of the same
  // module could not be intercepted this late — see codex-as-second-reviewer memory on mock.module's
  // timing requirements). A real occupied night (not the no-camera default) so the first pass is
  // genuinely SCORED and actually reaches the timelapse decision at all.
  layNight3([[at3(19, 0), at3(19, 10)], [at3(23, 0), at3(23, 6)], [at3(1, 0, 1), at3(1, 9, 1)]], at3(7, 0, 1));
  const assembleCalls = t.mock.fn();
  t.mock.module('../src/lib/timelapse.js', {
    namedExports: { assembleTimelapse: assembleCalls, discardTimelapseFrames: t.mock.fn() },
  });
  const flush = () => new Promise((r) => setImmediate(r));

  t.mock.timers.enable({ apis: ['Date'], now: at3(7, 5, 1).getTime() }); // provisional: window just closed
  runNightlySleepJob();
  await flush();
  assert.equal(assembleCalls.mock.callCount(), 1, 'the first write must trigger exactly one timelapse pass');

  t.mock.timers.tick(30 * 60 * 1000); // still provisional — well under the 3h evidence horizon
  runNightlySleepJob();
  await flush();
  assert.equal(assembleCalls.mock.callCount(), 1, 'a provisional refresh must not trigger a second pass');
});

test('★ a no_data first pass must not waste a timelapse assembly — it waits for the first SCORED pass (adversarial review finding)', async (t) => {
  // Found by adversarial review, not by this suite. Before this fix, the timelapse/frame decision fired
  // on the first pass EVER, regardless of status — so a night that was `no_data` on its first look (the
  // sampler hasn't backfilled yet, exactly the scenario the "initial insufficient data recovers" test
  // above exercises) would immediately call assembleTimelapse for a night with no real evidence yet, and
  // — the more serious direction — a night that looked `empty` on an early pass would have its frames
  // irreversibly destroyed by discardTimelapseFrames before a later pass could ever discover it was
  // really occupied. Waiting for the first SCORED (ok/empty) pass fixes the demonstrated no_data case
  // directly; see the comment above the gate in runNightlySleepJob for the narrower empty->ok case this
  // does NOT cover (filed as a separate follow-up).
  const assembleCalls = t.mock.fn();
  const discardCalls = t.mock.fn();
  t.mock.module('../src/lib/timelapse.js', {
    namedExports: { assembleTimelapse: assembleCalls, discardTimelapseFrames: discardCalls },
  });
  const flush = () => new Promise((r) => setImmediate(r));

  // Nothing recorded yet — the first pass is genuinely no_data.
  t.mock.timers.enable({ apis: ['Date'], now: at3(7, 5, 1).getTime() });
  runNightlySleepJob();
  await flush();
  assert.equal(assembleCalls.mock.callCount(), 0, 'a no_data first pass must not waste a timelapse assembly pass');
  assert.equal(discardCalls.mock.callCount(), 0);

  // The night's real samples arrive — an ordinary occupied night. Still well within the evidence horizon.
  layNight3([[at3(19, 0), at3(19, 10)], [at3(23, 0), at3(23, 6)], [at3(1, 0, 1), at3(1, 9, 1)]], at3(7, 0, 1));
  t.mock.timers.tick(30 * 60 * 1000);
  runNightlySleepJob();
  await flush();
  assert.equal(assembleCalls.mock.callCount(), 1, 'the first SCORED pass must trigger exactly one timelapse pass');

  // A further provisional refresh of an already-scored night must not repeat it.
  t.mock.timers.tick(30 * 60 * 1000);
  runNightlySleepJob();
  await flush();
  assert.equal(assembleCalls.mock.callCount(), 1, 'a provisional refresh of an already-scored night must not trigger a second pass');
});

test('a night stays exactly as finalized across repeated runs (e.g. a process restart)', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: at3(10, 30, 1).getTime() }); // safely past the 3h evidence horizon
  runNightlySleepJob();
  const nightDate = lastCompletedNightDate(KID);
  db.prepare('UPDATE sleep_nights SET wake_at = ? WHERE child_id = ? AND night_date = ?').run('PINNED-FINAL', KID, nightDate);

  runNightlySleepJob(); // e.g. the job firing again right after a restart
  let row = db.prepare('SELECT wake_at FROM sleep_nights WHERE child_id = ? AND night_date = ?').get(KID, nightDate);
  assert.equal(row.wake_at, 'PINNED-FINAL', 'a run immediately after another must not rewrite an already-final night');

  runNightlySleepJob(); // and a third — repetition must not matter once a night is final
  row = db.prepare('SELECT wake_at FROM sleep_nights WHERE child_id = ? AND night_date = ?').get(KID, nightDate);
  assert.equal(row.wake_at, 'PINNED-FINAL', 'still stable — finalization is permanent, not a one-run fluke');
});

// --- the window-date helpers the job depends on ------------------------------------------------------

test('the last completed night is never in the future, and is a real date', () => {
  const d = lastCompletedNightDate(KID);
  assert.match(d, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(d <= new Date().toISOString().slice(0, 10));
});

test('currentNightDate is either null or the date of a window containing now', () => {
  const d = currentNightDate(KID);
  if (d !== null) {
    assert.match(d, /^\d{4}-\d{2}-\d{2}$/);
    assert.notEqual(d, lastCompletedNightDate(KID), 'an in-progress night cannot also be completed');
  }
});

// --- daylight saving ---------------------------------------------------------------------------------
//
// A day is not 86,400,000 ms twice a year, and these helpers walk BACKWARDS through candidate dates. The
// old implementation shifted an instant by that many ms and read the local date off the result, which
// skipped a date on the spring-forward and repeated one on the fall-back. Melbourne 2026: DST starts
// 2026-10-04 02:00 (clocks -> 03:00) and ends 2026-04-05 03:00 (clocks -> 02:00).

// Freeze the clock at a UTC instant, run fn, restore.
const atInstant = (utcMs, fn) => {
  mock.timers.enable({ apis: ['Date'], now: utcMs });
  try { return fn(); } finally { mock.timers.reset(); }
};

test('the in-progress night survives the morning after the clocks go forward', () => {
  // 2026-10-05 00:30 Melbourne (AEDT, +11) — inside the night that began 2026-10-04 19:00.
  // The old code asked for "yesterday", got 2026-10-03, and so never considered 10-04 at all:
  // currentNightDate returned null and the live "tonight so far" view vanished for a full hour.
  const d = atInstant(Date.UTC(2026, 9, 4, 13, 30), () => currentNightDate(KID));
  assert.equal(d, '2026-10-04', 'the night in progress must still be found across the DST change');
});

test('the night before the clocks go forward is still reachable an hour later', () => {
  // 23:30 on 2026-10-04, i.e. before local midnight — the same night, one hour earlier. This one
  // worked before the fix too; it is here so the test above cannot pass for a trivial reason.
  const d = atInstant(Date.UTC(2026, 9, 4, 12, 30), () => currentNightDate(KID));
  assert.equal(d, '2026-10-04');
});

// The two below PIN behaviour rather than prove the fix — measured, they pass against the old
// implementation too, and the reason is worth knowing: lastCompletedNightDate walks FOUR candidate
// dates (0..-3) so a skipped or repeated one still leaves a correct date in range, while
// currentNightDate walks only TWO (0..-1) and a single bad candidate is fatal. That asymmetry is the
// whole difference between a latent oddity and the vanished "tonight so far" view above, and it means
// widening either loop is not a safe substitute for the date arithmetic being right.
test('the last completed night does not skip a day when the clocks go forward', () => {
  // Same instant. The night that began 2026-10-03 ended at 07:00 on 10-04, so it IS complete; the
  // 10-04 night is still running.
  const d = atInstant(Date.UTC(2026, 9, 4, 13, 30), () => lastCompletedNightDate(KID));
  assert.equal(d, '2026-10-03');
});

test('the last completed night does not repeat a day when the clocks go back', () => {
  // 2026-04-05 23:30 Melbourne (AEST, +10, DST just ended). The old "yesterday" returned 2026-04-05 —
  // today again — burning a candidate slot; the loop had a spare and still landed right.
  const d = atInstant(Date.UTC(2026, 3, 5, 13, 30), () => lastCompletedNightDate(KID));
  assert.equal(d, '2026-04-04', 'the completed night is the one that ended this morning');
});

test('an ordinary night with no DST anywhere near it is unaffected', () => {
  // The control. 2026-08-29 00:30 Melbourne, mid-winter, no transition within months.
  assert.equal(atInstant(Date.UTC(2026, 7, 28, 14, 30), () => currentNightDate(KID)), '2026-08-28');
  assert.equal(atInstant(Date.UTC(2026, 7, 28, 14, 30), () => lastCompletedNightDate(KID)), '2026-08-27');
});

// --- the window gates the samplers ask about ---------------------------------------------------------

test('the window is open mid-night and shut in the middle of the afternoon', () => {
  // KID sleeps 19:00-07:00. 23:00 is plainly inside; 14:00 is plainly outside. These two gate whether
  // the detector's sampling leg runs at all, so "always false" would silently stop all data collection
  // and "always true" would burn detector CPU around the clock.
  assert.equal(atInstant(Date.UTC(2026, 7, 28, 13, 0), () => childWindowActiveNow(KID)), true, '23:00 local');
  assert.equal(atInstant(Date.UTC(2026, 7, 29, 4, 0), () => childWindowActiveNow(KID)), false, '14:00 local');
});

test('sampling opens earlier than the window itself, by the lookbehind', () => {
  // 17:00 local — two hours before the 19:00 window. Sampling MUST already be running or an early
  // bedtime has no data behind it to find, which is the whole point of the lookbehind.
  const at17 = Date.UTC(2026, 7, 28, 7, 0);
  assert.equal(atInstant(at17, () => childWindowActiveNow(KID)), false, 'the window proper is still shut');
  assert.equal(atInstant(at17, () => childSamplingActiveNow(KID)), true, 'but sampling has started');
});

test('a child with sleep tracking off is never sampled', () => {
  db.prepare('UPDATE children SET track_sleep = 0 WHERE id = ?').run(KID);
  const midnight = Date.UTC(2026, 7, 28, 14, 0);
  assert.equal(atInstant(midnight, () => childWindowActiveNow(KID)), false);
  assert.equal(atInstant(midnight, () => childSamplingActiveNow(KID)), false);
});

test('an unknown child is not sampled rather than throwing', () => {
  assert.equal(childWindowActiveNow('no-such-child'), false);
  assert.equal(childSamplingActiveNow('no-such-child'), false);
});

// --- the scheduler ------------------------------------------------------------------------------------

test('starting the job runs it once immediately and then schedules it', () => {
  // The immediate run is the boot backfill — without it, a restart just after a window closed would
  // leave that night uncomputed until the next half-hourly tick.
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    startSleepJob();
    assert.ok(db.prepare('SELECT 1 FROM sleep_nights WHERE child_id = ?').get(KID),
      'startSleepJob must backfill the last completed night on boot');
  } finally {
    mock.timers.reset();
  }
});

test('starting the job twice does not schedule it twice', () => {
  // Two intervals would mean two concurrent passes over every child, racing on the same rows.
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    startSleepJob();
    assert.doesNotThrow(() => startSleepJob(), 'a second start must be a no-op, not a second timer');
  } finally {
    mock.timers.reset();
  }
});

// --- getStoredNights: what the summary card and the date picker read -----------------------------------

test('stored nights come back newest first', () => {
  layNights(KID, [[20, 1, 600], [21, 2, 590], [22, 3, 580]]); // 2026-06-01 .. 06-03
  const rows = getStoredNights(KID);
  assert.deepEqual(rows.map((r) => r.night_date), ['2026-06-03', '2026-06-02', '2026-06-01']);
});

test('the stored-nights limit is clamped at both ends', () => {
  layNights(KID, [[20, 1, 600], [21, 2, 590], [22, 3, 580]]);
  // Clamped to [1, 60]. A raw 0 or negative would reach SQLite as `LIMIT 0` / `LIMIT -1` and return
  // nothing or everything; an unbounded value would scan the whole table behind a card showing 14.
  assert.equal(getStoredNights(KID, 0).length, 1, 'a zero limit floors to one night, never to none');
  assert.equal(getStoredNights(KID, -1).length, 1);
  assert.equal(getStoredNights(KID, 2).length, 2, 'a real limit is still honoured');
  assert.ok(getStoredNights(KID, 100000).length <= 60, 'and an absurd one is capped at 60');
});

test('stored nights are scoped to one child', () => {
  db.prepare(`INSERT INTO children (id, name, track_sleep, sleep_window_start, sleep_window_end)
              VALUES (?, 'Other', 1, '19:00', '07:00')`).run(KID2);
  layNights(KID, [[20, 1, 600]]);
  layNights(KID2, [[20, 9, 100]]);
  const rows = getStoredNights(KID);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].wake_count, 1);
});

test('a child with no history gets an empty list, not an error', () => {
  assert.deepEqual(getStoredNights('no-such-child'), []);
});
