// GET /api/children/:id/sleep/:date — the `transition_frames` list (#907).
//
// Why it exists: the sleep detail page can now open the frame the camera saved at a bed transition, from the Room
// activity rows. The page needs to know WHICH saved frames exist for the night, and the night's own `transitions`
// cannot say: it holds only the two adopted markers, with no id. So the route adds `transition_frames`
// [{ id, type, at }] (lib/bedTransitions.js, framesForNight). These tests pin the route half: when the key is
// there, when it is not, what a night with nothing to show gets, and that adding it changed nothing else in the
// payload (an open client, or the mobile app, reads the same response).
//
// What is NOT here: the filtering itself (camera, snapshot flag, file on disk, range, order). That is the unit
// tests in bedTransitions.test.js, where the fixture can be hostile on every axis. Here one wrong-camera row and
// one missing-file row ride along as a check that the route uses that function and not its own query.
//
// Pictures are generated placeholder bytes, never a photograph.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, signToken, mountRouter, call } from './helpers/harness.js';

useTempDataDir();

const { default: db } = await import('../src/db.js');
const { computeNightForDisplay } = await import('../src/lib/sleepAnalysis.js');
const { applyCorrection } = await import('../src/lib/sleepReviews.js');
const { default: childrenRouter } = await import('../src/routes/children.js');

const CHILD = 'frames-child';
const CAM = 'frames-cam';
const DATE = '2026-07-01'; // a night the fixture makes plainly occupied (`ok`)
const NO_DATA_DATE = '2026-07-05'; // no samples at all
const TZ = 'Australia/Melbourne';
const TZ_OFF = 10 * 3600 * 1000; // Melbourne in July: UTC+10, no DST edge anywhere near
const SNAPSHOT_DIR = path.join(process.env.DATA_DIR, 'private', 'transition-snapshots');

const at = (h, m, dayShift = 0) => new Date(Date.UTC(2026, 6, 1 + dayShift, h, m) - TZ_OFF);
const sqlTime = (d) => d.toISOString().slice(0, 19).replace('T', ' ').replace(/:\d\d$/, ':00');
const json = (v) => JSON.parse(JSON.stringify(v)); // what a client actually receives

let server;
let adminToken;

const insertSample = db.prepare(
  `INSERT INTO activity_samples (camera_id, bucket_start, motion_level, motion_peak, sound_level,
     sound_peak, motion_frames, sound_windows) VALUES (?, ?, ?, ?, 0, 0, 1, 0)`
);

// A night that scores `ok`: settling until 19:40, up from 06:00 (nobody-in-bed.test.js's layOkNight).
function layOkNight() {
  for (let t = at(18, 20); t < at(7, 0, 1); t = new Date(t.getTime() + 60000)) {
    const moving = (t >= at(19, 30) && t < at(19, 40)) || (t >= at(6, 0, 1) && t < at(7, 0, 1));
    insertSample.run(CAM, sqlTime(t), moving ? 0.4 : 0.004, moving ? 0.4 : 0.004);
  }
}

// Inserted directly (a night months old is past recordBedTransition's 45-day sweep), with a placeholder file when
// asked. Returns the id.
function layFrame(cameraId, type, when, { file = true } = {}) {
  const id = Number(
    db.prepare('INSERT INTO bed_transitions (camera_id, type, peak, created_at, snapshot) VALUES (?, ?, 0.4, ?, 1)')
      .run(cameraId, type, when).lastInsertRowid
  );
  if (file) fs.writeFileSync(path.join(SNAPSHOT_DIR, `${id}.jpg`), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  return id;
}

const get = (query, date = DATE, token = adminToken) =>
  call(`${server.url}/api/children/${CHILD}/sleep/${date}${query}`, { token });

before(async () => {
  db.prepare(`INSERT INTO settings (id, timezone) VALUES ('app', ?)
              ON CONFLICT(id) DO UPDATE SET timezone = excluded.timezone`).run(TZ);
  const admin = makeUser(db, { id: 'u-a', username: 'admin', role: 'admin' });
  adminToken = signToken({ sub: admin.id, sid: makeSession(db, admin.id), role: 'admin', username: 'admin' });
  server = await mountRouter('/api/children', childrenRouter);
});

beforeEach(() => {
  for (const t of ['sleep_reviews', 'sleep_nights', 'activity_samples', 'sensor_readings', 'bed_transitions', 'cameras', 'children']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
  // Ids restart once the table is empty: a file left by an earlier test would make a missing-file row look present.
  for (const f of fs.readdirSync(SNAPSHOT_DIR)) fs.rmSync(path.join(SNAPSHOT_DIR, f), { force: true });
  db.prepare(`INSERT INTO children (id, name, track_sleep, sleep_window_start, sleep_window_end)
              VALUES (?, 'Frame Kid', 1, '19:30', '07:00')`).run(CHILD);
  db.prepare(`INSERT INTO cameras (id, name, rtsp_url, child_id, mediamtx_path, sort_order, disabled)
              VALUES (?, 'Bed cam', 'rtsp://example/x', ?, 'p', 0, 0)`).run(CAM, CHILD);
});

after(async () => {
  await server?.close();
  db.close();
  cleanupTempDataDirs();
});

test('★ detail=1 and debug=1 carry the frames of the night; a plain read does not carry the key at all', async () => {
  layOkNight();
  const first = layFrame(CAM, 'out_of_bed', sqlTime(at(2, 0, 1)));
  const second = layFrame(CAM, 'into_bed', sqlTime(at(2, 5, 1)));
  layFrame('some-other-camera', 'out_of_bed', sqlTime(at(2, 1, 1))); // another camera, same hours
  layFrame(CAM, 'out_of_bed', sqlTime(at(3, 0, 1)), { file: false }); // flagged, but the file is gone

  const expected = [
    { id: first, type: 'out_of_bed', at: sqlTime(at(2, 0, 1)) },
    { id: second, type: 'into_bed', at: sqlTime(at(2, 5, 1)) },
  ];
  for (const q of ['?detail=1', '?detail=1&context=auto', '?debug=1']) {
    const res = await get(q);
    assert.equal(res.status, 200, q);
    assert.equal(res.body.status, 'ok', `${q}: precondition`);
    assert.deepEqual(res.body.transition_frames, expected, q);
  }

  // The key rides with the timeline only: the live card and the lists must not grow.
  for (const q of ['', '?context=auto']) {
    const plain = (await get(q)).body;
    assert.equal(plain.status, 'ok', `${q || 'plain'}: precondition`);
    assert.equal(Object.hasOwn(plain, 'transition_frames'), false, `${q || 'plain'} read has no transition_frames`);
  }
});

test('★ a night that was not scored gets [] with detail=1, whatever frames exist: off, no data, and "no one was in the bed"', async () => {
  layOkNight();
  layFrame(CAM, 'out_of_bed', sqlTime(at(2, 0, 1)));
  layFrame(CAM, 'out_of_bed', sqlTime(at(2, 0, 4))); // also inside the no-data night's window
  assert.equal((await get('?detail=1')).body.transition_frames.length, 1, 'precondition: the ok night does list its frame');

  const noData = await get('?detail=1', NO_DATA_DATE);
  assert.equal(noData.body.status, 'no_data', 'precondition');
  assert.deepEqual(noData.body.transition_frames, []);

  // A parent's "no one was in the bed" removes the timeline from the night, so its rows are not drawn either.
  db.prepare('INSERT INTO sleep_reviews (child_id, night_date, nobody_in_bed) VALUES (?, ?, 1)').run(CHILD, DATE);
  const flagged = await get('?detail=1');
  assert.equal(flagged.body.nobody_in_bed, true, 'precondition');
  assert.deepEqual(flagged.body.transition_frames, []);
  db.prepare('DELETE FROM sleep_reviews').run();

  db.prepare('UPDATE children SET track_sleep = 0 WHERE id = ?').run(CHILD);
  const off = await get('?detail=1');
  assert.equal(off.body.status, 'off', 'precondition');
  assert.deepEqual(off.body.transition_frames, []);
});

test('★ the field is ADDED: every other key of the payload is exactly what the same night had without it', async () => {
  layOkNight();
  layFrame(CAM, 'out_of_bed', sqlTime(at(2, 0, 1)));
  // The detail page's own computation, with the correction laid over it as the route does. If adding the key had
  // renamed, dropped or reshaped anything (`transitions` above all: the two adopted markers), this differs.
  const before = json(applyCorrection(CHILD, computeNightForDisplay(CHILD, DATE, { includeTimeline: true, mode: 'current' })));
  assert.equal(before.status, 'ok', 'precondition');
  assert.ok(Array.isArray(before.transitions), 'precondition: the night has its adopted markers');

  const { transition_frames, ...rest } = (await get('?detail=1')).body;
  assert.ok(Array.isArray(transition_frames));
  assert.deepEqual(rest, before);
});
