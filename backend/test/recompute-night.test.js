// Recomputing a stored night — the admin "Recompute" control on the sleep detail view.
//
// Stored sleep_nights rows are never recomputed by the nightly job (`if (existing) continue`), so every
// change to the sleep algorithm leaves already-recorded nights showing the old answer forever while the
// detail view — which recomputes live — shows the new one. The card and the page then disagree and
// never converge. That happened again on 2026-08-29: prod's stored row said Raffa fell asleep at 16:56
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
const { computeAndStoreNight } = await import('../src/lib/sleepAnalysis.js');
const { default: childrenRouter } = await import('../src/routes/children.js');

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
  assert.equal(db.prepare('SELECT status FROM sleep_nights WHERE child_id = ?').get(CHILD).status, 'ok');
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
