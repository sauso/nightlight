// Recomputing a stored night — the admin "Recompute" control on the sleep detail view.
//
// Stored sleep_nights rows are never recomputed by the nightly job (`if (existing) continue`), so every
// change to the sleep algorithm leaves already-recorded nights showing the old answer forever while the
// detail view — which recomputes live — shows the new one. The card and the page then disagree and
// never converge. That happened again on 2026-08-29: prod's stored row said Child B fell asleep at 16:56
// while the detail view correctly said 20:15.
//
// ⚠️ THE DANGEROUS HALF IS THE GUARD, NOT THE BUTTON. `activity_samples` are kept 30 days and the date
// picker offers exactly 30 days, so the oldest night a user can browse sits ON the retention boundary.
// Recompute it and the minutes behind it are already gone: it comes back `no_data` and overwrites a
// good scored row that is kept forever, with no way back. Nothing could reach that path until a person
// could ask for a recompute — the control is what makes it reachable.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, signToken, mountRouter, call } from './helpers/harness.js';

useTempDataDir();

const { default: db } = await import('../src/db.js');
const { computeAndStoreNight, runNightlySleepJob } = await import('../src/lib/sleepAnalysis.js');
const { default: childrenRouter } = await import('../src/routes/children.js');
const { logger } = await import('../src/lib/logger.js');

const CHILD = 'rc-child';
const CAM = 'rc-cam';
const DATE = '2026-07-01';
const TZ = 'Australia/Melbourne';
const TZ_OFF = 10 * 3600 * 1000;

const at = (h, m, dayShift = 0) => new Date(Date.UTC(2026, 6, 1 + dayShift, h, m) - TZ_OFF);
const sqlTime = (d) => d.toISOString().slice(0, 19).replace('T', ' ').replace(/:\d\d$/, ':00');

let server;
let adminToken;
let caregiverToken;

const insertSample = db.prepare(
  `INSERT INTO activity_samples (camera_id, bucket_start, motion_level, motion_peak, sound_level,
     sound_peak, motion_frames, sound_windows) VALUES (?, ?, ?, ?, 0, 0, 1, 0)`
);

// A night with enough coverage to score `ok`: quiet but plainly occupied, someone in the room until
// 19:40, up at 06:00.
function laySamples() {
  for (let t = at(18, 20); t < at(7, 0, 1); t = new Date(t.getTime() + 60000)) {
    const moving = (t >= at(19, 30) && t < at(19, 40)) || (t >= at(6, 0, 1) && t < at(6, 20, 1));
    insertSample.run(CAM, sqlTime(t), moving ? 0.4 : 0.004, moving ? 0.4 : 0.004);
  }
}

before(async () => {
  db.prepare(`INSERT INTO settings (id, timezone) VALUES ('app', ?)
              ON CONFLICT(id) DO UPDATE SET timezone = excluded.timezone`).run(TZ);
  const admin = makeUser(db, { id: 'u-a', username: 'admin', role: 'admin' });
  const care = makeUser(db, { id: 'u-c', username: 'carer', role: 'caregiver' });
  const aSid = makeSession(db, admin.id);
  const cSid = makeSession(db, care.id);
  adminToken = signToken({ sub: admin.id, sid: aSid, role: 'admin', username: 'admin' });
  caregiverToken = signToken({ sub: care.id, sid: cSid, role: 'caregiver', username: 'carer' });
  server = await mountRouter('/api/children', childrenRouter);
});

beforeEach(() => {
  db.prepare('DELETE FROM sleep_nights').run();
  db.prepare('DELETE FROM activity_samples').run();
  db.prepare('DELETE FROM cameras').run();
  db.prepare('DELETE FROM children').run();
  db.prepare(`INSERT INTO children (id, name, track_sleep, sleep_window_start, sleep_window_end)
              VALUES (?, 'Recompute Kid', 1, '19:30', '07:00')`).run(CHILD);
  db.prepare(`INSERT INTO cameras (id, name, rtsp_url, child_id, mediamtx_path, sort_order, disabled)
              VALUES (?, 'Cot cam', 'rtsp://example/x', ?, 'p', 0, 0)`).run(CAM, CHILD);
});

after(async () => {
  await server?.close();
  db.close();
  cleanupTempDataDirs();
});

// --- the guard ----------------------------------------------------------------------------------

test('a recompute never turns a scored night into an unscored one', () => {
  // THE regression test. A night was scored months ago; its activity_samples have since aged out, so
  // recomputing produces no_data. Without the guard that no_data is written straight over the top and
  // the original — which is kept forever — is gone, irreversibly.
  laySamples();
  const first = computeAndStoreNight(CHILD, DATE);
  assert.equal(first.status, 'ok');
  assert.ok(first.asleep_minutes > 0);

  db.prepare('DELETE FROM activity_samples').run(); // the samples age out

  const again = computeAndStoreNight(CHILD, DATE, { allowDowngrade: false });
  assert.equal(again.stored, false, 'the write must be refused');
  assert.equal(again.refused, 'would_downgrade');

  const row = db.prepare('SELECT * FROM sleep_nights WHERE child_id = ? AND night_date = ?').get(CHILD, DATE);
  assert.equal(row.status, 'ok', 'the stored night must be untouched');
  assert.equal(row.asleep_minutes, first.asleep_minutes);
});

test('the nightly job keeps writing a first-time no_data', () => {
  // The guard is about OVERWRITING a scored row, not about refusing to record that a night had no
  // data. With no existing row there is nothing to protect and the write must go through, or a child
  // whose camera was offline would simply have no night at all rather than one marked no_data.
  const summary = computeAndStoreNight(CHILD, DATE, { allowDowngrade: false });
  assert.equal(summary.status, 'no_data');
  assert.equal(summary.stored, true);
  assert.ok(db.prepare('SELECT 1 FROM sleep_nights WHERE child_id = ?').get(CHILD));
});

test('a recompute that still scores the night is written', () => {
  // The point of the feature: the numbers must actually be allowed to change.
  laySamples();
  computeAndStoreNight(CHILD, DATE);
  db.prepare('UPDATE sleep_nights SET onset_at = ?, asleep_minutes = 1 WHERE child_id = ?')
    .run('2026-07-01 06:56:00', CHILD); // a stale row from the old algorithm

  const again = computeAndStoreNight(CHILD, DATE, { allowDowngrade: false });
  assert.equal(again.stored, true);
  const row = db.prepare('SELECT * FROM sleep_nights WHERE child_id = ?').get(CHILD);
  assert.notEqual(row.onset_at, '2026-07-01 06:56:00', 'the stale time must be replaced');
  assert.ok(row.asleep_minutes > 1);
});

test('★★ unknown_minutes round-trips through storage (issue #442)', () => {
  // The persistence half of #442's fix: applyCorrection() (sleepReviews.js) needs this column to
  // avoid re-counting an outage as sleep once a parent corrects a night — found by adversarial
  // review. sleepAnalysis.test.js already covers computeNight()'s in-memory computation of this
  // figure exhaustively; the narrow slice that leaves untested is whether it actually survives a
  // real computeAndStoreNight → SQLite → SELECT round trip, not just live in memory.
  for (let t = at(19, 30); t < at(20, 0); t = new Date(t.getTime() + 60000)) {
    // A brief active burst first (else the empty-bed guard fires instead of scoring the night 'ok'),
    // then 25 real quiet minutes, which establishes onset.
    const moving = t < at(19, 35);
    insertSample.run(CAM, sqlTime(t), moving ? 0.4 : 0.004, moving ? 0.4 : 0.004);
  }
  // deliberately no samples 20:00–20:30 — a genuine 30-minute outage
  for (let t = at(20, 30); t < at(7, 0, 1); t = new Date(t.getTime() + 60000)) {
    insertSample.run(CAM, sqlTime(t), 0.004, 0.004); // real quiet the rest of the night
  }

  const summary = computeAndStoreNight(CHILD, DATE);
  assert.equal(summary.status, 'ok');
  assert.equal(summary.unknown_minutes, 30, 'sanity: computeNight itself must see the outage');

  const row = db.prepare('SELECT unknown_minutes FROM sleep_nights WHERE child_id = ? AND night_date = ?').get(CHILD, DATE);
  assert.equal(row.unknown_minutes, 30, 'the value must survive the round trip through SQLite, not just live in memory');
});

test('an empty night counts as scored and is protected too', () => {
  // `empty` is a real measurement — "we watched, and nobody was in the bed". Losing it to a no_data
  // would be the same data loss as losing an `ok`.
  db.prepare(
    `INSERT INTO sleep_nights (child_id, night_date, window_start, window_end, status, coverage_minutes,
       computed_at) VALUES (?, ?, '2026-07-01 09:00:00', '2026-07-01 21:00:00', 'empty', 700, 'PINNED')`
  ).run(CHILD, DATE);
  const again = computeAndStoreNight(CHILD, DATE, { allowDowngrade: false });
  assert.equal(again.stored, false);
  assert.equal(db.prepare('SELECT computed_at FROM sleep_nights WHERE child_id = ?').get(CHILD).computed_at, 'PINNED');
});

// --- the route ----------------------------------------------------------------------------------

test('an admin can store a recompute', async () => {
  laySamples();
  const res = await call(`${server.url}/api/children/${CHILD}/sleep/${DATE}?store=1`, { token: adminToken });
  assert.equal(res.status, 200);
  assert.equal(res.body.stored, true);
  assert.equal(db.prepare('SELECT status FROM sleep_nights WHERE child_id = ?').get(CHILD).status, 'ok');
});

test('a caregiver gets the computed night but cannot store it', async () => {
  // Role gating is the thing that hides bugs in this app — an admin-only route that 403'd everyone
  // shipped invisibly once. Here the failure would be the opposite and quieter: a caregiver silently
  // rewriting stored history. `store=1` must simply not apply to them.
  laySamples();
  const res = await call(`${server.url}/api/children/${CHILD}/sleep/${DATE}?store=1`, { token: caregiverToken });
  assert.equal(res.status, 200, 'they still get to SEE the night');
  assert.equal(res.body.stored, undefined, 'but nothing was stored');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM sleep_nights WHERE child_id = ?').get(CHILD).c, 0);
});

test('a refused recompute answers 4xx with a readable reason', async () => {
  // Deliberately not a 5xx: Cloudflare strips 5xx bodies, so the user would see an empty error and no
  // explanation of why their night could not be re-scored.
  laySamples();
  computeAndStoreNight(CHILD, DATE);
  db.prepare('DELETE FROM activity_samples').run();

  const res = await call(`${server.url}/api/children/${CHILD}/sleep/${DATE}?store=1`, { token: adminToken });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /aged out/i, 'the message has to say WHY');
  // #508: with nothing left to read (coverage 0) the reason IS aging out, and the machine-readable field
  // says so. Pinned so the coverage wording below can never become the only message.
  assert.equal(res.body.reason, 'aged_out');
  assert.equal(res.body.coverage_minutes, 0);
  assert.match(res.body.error, /data has aged out \(kept 30 days\)/);
  assert.equal(db.prepare('SELECT status FROM sleep_nights WHERE child_id = ?').get(CHILD).status, 'ok');
});

// --- #508: a refusal because too little was WATCHED, not because the data aged out ---------------------
//
// Since #508 a minute the video never saw (motion_frames 0: the sound detector kept writing while the
// motion detector delivered nothing) is not coverage. A night stored `ok` before #508 whose video stalled
// for over half the window now computes `no_data`, and the allowDowngrade guard refuses it — deliberately
// kept (see computeAndStoreNight). What must not happen is the refusal claiming the data "aged out": it
// is right there.

// Turn the stored night's video off for everything from 21:00 on (430 of the 690 window minutes), leaving
// the rows themselves in place, exactly as a sound-only stall stores them.
function stallVideoFrom2100() {
  db.prepare('UPDATE activity_samples SET motion_frames = 0, motion_peak = NULL WHERE bucket_start >= ?')
    .run(sqlTime(at(21, 0)));
}

test('#508 T11a: a refused recompute of a mostly-unwatched night says so, and does not claim the data aged out', async () => {
  laySamples();
  computeAndStoreNight(CHILD, DATE);
  stallVideoFrom2100();

  const res = await call(`${server.url}/api/children/${CHILD}/sleep/${DATE}?store=1`, { token: adminToken });
  assert.equal(res.status, 409);
  assert.equal(res.body.reason, 'too_little_watched');
  assert.equal(res.body.coverage_minutes, 90, 'the 19:30-21:00 minutes were watched');
  assert.match(res.body.error, /video was only seen for 90 minutes/);
  assert.doesNotMatch(res.body.error, /data has aged out \(kept 30 days\)/, 'the data is right there; "aged out" would be false');
  assert.match(res.body.error, /left as it is/, 'still says nothing was changed (the e2e spec matches on this)');
  assert.equal(res.body.status, 'no_data', 'the refused status is returned too');
  assert.equal(db.prepare('SELECT status FROM sleep_nights WHERE child_id = ?').get(CHILD).status, 'ok');
});

// The refusal has THREE causes, and the route must branch on the refused STATUS, not on coverage alone
// (#508 code review, both reviewers): the first version of the split said "the video was only seen for 690
// minutes... missing for the rest" about a FULLY watched night that was refused for a different reason.
// Each test below fails under "branch on coverage only" and under "always aged out".

test('#508 T11a2: a refused recompute of a FULLY watched night that now reads no_sleep blames neither missing video nor age', async () => {
  laySamples();
  computeAndStoreNight(CHILD, DATE);
  // Every minute now moves: the night is fully watched (coverage 690) and has no quiet run to fall asleep
  // in, so it computes `no_sleep`, which the guard refuses over the stored `ok`.
  db.prepare('UPDATE activity_samples SET motion_peak = 0.4, motion_level = 0.4').run();

  const res = await call(`${server.url}/api/children/${CHILD}/sleep/${DATE}?store=1`, { token: adminToken });
  assert.equal(res.status, 409);
  assert.equal(res.body.status, 'no_sleep', 'sanity: this is the not-no_data refusal');
  assert.equal(res.body.coverage_minutes, 690, 'sanity: every window minute was watched');
  assert.equal(res.body.reason, 'no_longer_scored');
  assert.doesNotMatch(res.body.error, /video was only seen|missing for the rest/, 'nothing was missing');
  assert.doesNotMatch(res.body.error, /data has aged out \(kept 30 days\)/, 'and nothing aged out');
  assert.match(res.body.error, /no clear sleep/);
  assert.match(res.body.error, /left as it is/);
  assert.equal(db.prepare('SELECT status FROM sleep_nights WHERE child_id = ?').get(CHILD).status, 'ok');
});

test('#508 T11a3: a refused recompute of a stored EMPTY night that the 90% rule now makes no_data names the 90% line', async () => {
  // A quiet, empty-bed night, fully watched: stored `empty`. Then the video is dead from 05:15 (105 of
  // 690 minutes), leaving 585 watched (84.8%): above the 50% no_data gate, below the 90% `empty` line,
  // so it now computes `no_data` and is refused. "Too few to score" alone would be false here: 585
  // minutes is plenty to score a night that had a child in it.
  for (let t = at(18, 20); t < at(7, 0, 1); t = new Date(t.getTime() + 60000)) {
    insertSample.run(CAM, sqlTime(t), 0.0002, 0.0002);
  }
  assert.equal(computeAndStoreNight(CHILD, DATE).status, 'empty', 'sanity: stored as "no one in the bed"');
  db.prepare('UPDATE activity_samples SET motion_frames = 0, motion_peak = NULL WHERE bucket_start >= ?')
    .run(sqlTime(at(5, 15, 1)));

  const res = await call(`${server.url}/api/children/${CHILD}/sleep/${DATE}?store=1`, { token: adminToken });
  assert.equal(res.status, 409);
  assert.equal(res.body.status, 'no_data');
  assert.equal(res.body.coverage_minutes, 585);
  assert.equal(res.body.reason, 'too_little_watched');
  assert.match(res.body.error, /video was only seen for 585 minutes/);
  assert.match(res.body.error, /90% before it can be called "no one in the bed"/, 'the line this night actually missed');
  assert.match(res.body.error, /at least 50% of its window watched to be scored at all/);
  assert.doesNotMatch(res.body.error, /data has aged out \(kept 30 days\)/);
  assert.equal(db.prepare('SELECT status FROM sleep_nights WHERE child_id = ?').get(CHILD).status, 'empty');
});

test('#508 T11a4: a refused recompute with ONE watched minute is still "too little watched", not "aged out"', async () => {
  // The boundary of the coverage split: 1 is the smallest non-zero coverage, so `> 0` and `> 1` differ here.
  laySamples();
  computeAndStoreNight(CHILD, DATE);
  db.prepare('UPDATE activity_samples SET motion_frames = 0, motion_peak = NULL WHERE bucket_start != ?')
    .run(sqlTime(at(23, 0)));

  const res = await call(`${server.url}/api/children/${CHILD}/sleep/${DATE}?store=1`, { token: adminToken });
  assert.equal(res.status, 409);
  assert.equal(res.body.coverage_minutes, 1, 'sanity: exactly one watched window minute');
  assert.equal(res.body.reason, 'too_little_watched');
  assert.match(res.body.error, /video was only seen for 1 minute of it/);
});

test('#508 T11b: the nightly job retries a refused downgrade each tick, but only until the next night closes', (t) => {
  // TRACED, not assumed: a refusal writes nothing, so `computed_at` stays before the evidence horizon and
  // runNightlySleepJob recomputes the night on its next tick too. That is bounded because the job only
  // ever visits lastCompletedNightDate. This pins both halves: it IS retried while it is "last night"
  // (so a recovery would be picked up), and it is never visited again once the next night has closed.
  t.mock.timers.enable({ apis: ['Date'], now: at(7, 5, 1).getTime() });
  laySamples();
  computeAndStoreNight(CHILD, DATE); // stored `ok` at 07:05 local, as the job's first pass would
  const stored = db.prepare('SELECT status, computed_at, asleep_minutes FROM sleep_nights WHERE child_id = ? AND night_date = ?');
  const first = stored.get(CHILD, DATE);
  assert.equal(first.status, 'ok');
  stallVideoFrom2100();

  // Two ticks inside the evidence window: each recomputes (no_data) and is refused — nothing written.
  // "Nothing written" alone cannot tell a refused recompute from a SKIPPED one (#508 code review, Codex:
  // a job that skipped stored nights until the evidence horizon passed this loop, and the later recovery
  // below still caught it). So each tick must also show the compute HAPPENED: the job's own
  // "Computed N sleep summary(ies)" line counts every computeAndStoreNight call, refused or not, and this
  // file has exactly one child. Observed through the logger rather than a hook in production code.
  const info = t.mock.method(logger, 'info', () => {});
  for (const minutes of [30, 30]) {
    const seen = info.mock.callCount();
    t.mock.timers.tick(minutes * 60000);
    runNightlySleepJob();
    const lines = info.mock.calls.slice(seen).map((c) => String(c.arguments[0]));
    assert.ok(
      lines.some((l) => /\[sleep\] Computed 1 sleep summary/.test(l)),
      `the tick must RECOMPUTE the night (and be refused), not skip it; logged: ${JSON.stringify(lines)}`
    );
    assert.deepEqual(stored.get(CHILD, DATE), first, 'a refused downgrade leaves the stored night untouched');
  }
  info.mock.restore();

  // Still "last night" two hours later, past the 3 h horizon: the pre-horizon computed_at means it is
  // STILL recomputed. Proven by giving it something it WILL store: the video comes back.
  db.prepare('UPDATE activity_samples SET motion_frames = 1, motion_peak = motion_level').run();
  t.mock.timers.tick(3 * 60 * 60000);
  runNightlySleepJob();
  const recovered = stored.get(CHILD, DATE);
  assert.notEqual(recovered.computed_at, first.computed_at, 'while it is last night, the refused night is retried');

  // ...so put it back into the refused state with a fresh pre-horizon stamp, and move past the NEXT night's
  // window close. The job now visits 2026-07-02; DATE must never be recomputed again, even though a
  // recompute would now succeed and change the row (the video is back, the sentinel below is stale).
  db.prepare("UPDATE sleep_nights SET computed_at = '2026-07-01 21:05:00', asleep_minutes = 1 WHERE child_id = ? AND night_date = ?")
    .run(CHILD, DATE);
  t.mock.timers.tick(at(7, 5, 2).getTime() - Date.now());
  runNightlySleepJob();
  const after = stored.get(CHILD, DATE);
  assert.equal(after.computed_at, '2026-07-01 21:05:00', 'the retry is bounded: once the next night closes, this one is never visited');
  assert.equal(after.asleep_minutes, 1);
  assert.ok(
    db.prepare("SELECT 1 FROM sleep_nights WHERE child_id = ? AND night_date = '2026-07-02'").get(CHILD),
    'sanity: the job did run, and moved on to the next night'
  );
});

test('reading a night without store=1 never writes anything', async () => {
  // The detail view hits this endpoint on every page view. If it stored, simply LOOKING at an old
  // night would overwrite it.
  laySamples();
  const res = await call(`${server.url}/api/children/${CHILD}/sleep/${DATE}?detail=1`, { token: adminToken });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'ok');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM sleep_nights WHERE child_id = ?').get(CHILD).c, 0);
});

// --- ?stored=1: the baseline the dialog compares against ------------------------------------------

test('stored=1 returns the SAVED row, not a fresh computation', () => {
  // This is the endpoint the recompute dialog reads for its "before" column, and the distinction is the
  // whole feature: everything else on this route recomputes, so comparing against any of them compares
  // a recompute with a recompute and can never differ. That shipped once and made the button inert.
  return (async () => {
    laySamples();
    computeAndStoreNight(CHILD, DATE);
    // Now make the SAVED row disagree with what a fresh computation would produce.
    db.prepare('UPDATE sleep_nights SET onset_at = ?, asleep_minutes = 1, wake_count = 9 WHERE child_id = ?')
      .run('2026-07-01 06:56:00', CHILD);

    const stored = await call(`${server.url}/api/children/${CHILD}/sleep/${DATE}?stored=1`, { token: adminToken });
    assert.equal(stored.status, 200);
    assert.equal(stored.body.night.onset_at, '2026-07-01 06:56:00', 'must be the saved row, verbatim');
    assert.equal(stored.body.night.wake_count, 9);

    const fresh = await call(`${server.url}/api/children/${CHILD}/sleep/${DATE}`, { token: adminToken });
    assert.notEqual(fresh.body.onset_at, stored.body.night.onset_at,
      'the fresh computation must differ — otherwise this test proves nothing');
  })();
});

test('stored=1 returns null for a night that was never saved', () => {
  return (async () => {
    laySamples();
    const res = await call(`${server.url}/api/children/${CHILD}/sleep/${DATE}?stored=1`, { token: adminToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.night, null, 'no row yet is null, not an error');
  })();
});

test('stored=1 never writes anything', () => {
  return (async () => {
    laySamples();
    await call(`${server.url}/api/children/${CHILD}/sleep/${DATE}?stored=1&store=1`, { token: adminToken });
    assert.equal(db.prepare('SELECT COUNT(*) c FROM sleep_nights WHERE child_id = ?').get(CHILD).c, 0,
      'reading the saved row must not create one, even with store=1 also set');
  })();
});
