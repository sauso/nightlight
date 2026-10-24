// Timelapse listing and deletion, over real HTTP against the real router.
//
// The delete route shipped BROKEN and this suite is why it was caught: it was declared as
// `router.delete('/:id', requireAdmin, ...)`, and unlike cameras.js this router has no
// `router.use(requireAuth)`, so requireAdmin read an unpopulated req.user and returned 403 to
// everyone — admins included. The feature was completely dead and looked fine in review.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, makeChild, signToken, mountRouter, call,
} from './helpers/harness.js';

const DATA_DIR = useTempDataDir();

const { default: db } = await import('../src/db.js');
const { default: timelapseRouter } = await import('../src/routes/timelapses.js');
const { CLIPS_DIR } = await import('../src/lib/clipRecorder.js');
const { listChildTimelapses } = await import('../src/lib/timelapse.js');

let server;
let admin;
let caregiver;
let adminToken;
let caregiverToken;
const child = { id: 'kid-1' };

// A timelapse row plus the files it points at, so delete can be observed removing both.
function makeTimelapse({ id, nightDate, withFiles = true }) {
  const rel = path.join('timelapses', child.id, `${nightDate}.mp4`);
  const relThumb = path.join('timelapses', child.id, `${nightDate}.jpg`);
  if (withFiles) {
    fs.mkdirSync(path.join(CLIPS_DIR, 'timelapses', child.id), { recursive: true });
    fs.writeFileSync(path.join(CLIPS_DIR, rel), 'not-really-an-mp4');
    fs.writeFileSync(path.join(CLIPS_DIR, relThumb), 'not-really-a-jpg');
  }
  db.prepare(
    `INSERT INTO timelapses (id, child_id, night_date, status, path, thumb_path, frame_count, duration_s, bytes)
     VALUES (?, ?, ?, 'ready', ?, ?, 120, 12, 4096)`
  ).run(id, child.id, nightDate, rel, relThumb);
  return { id, rel, relThumb };
}

before(async () => {
  server = await mountRouter('/api/timelapses', timelapseRouter);
});

after(async () => {
  await server?.close();
  db.close();
  cleanupTempDataDirs();
});

beforeEach(() => {
  db.prepare('DELETE FROM timelapses').run();
  db.prepare('DELETE FROM sleep_nights').run();
  db.prepare('DELETE FROM sleep_reviews').run();
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM users').run();
  db.prepare('DELETE FROM children').run();
  makeChild(db, { id: child.id, name: 'Kid' });
  admin = makeUser(db, { id: 'u-a', username: 'admin', role: 'admin' });
  caregiver = makeUser(db, { id: 'u-c', username: 'nanny', role: 'caregiver' });
  adminToken = signToken({ id: admin.id, username: admin.username, role: 'admin', sid: makeSession(db, admin.id) });
  caregiverToken = signToken({ id: caregiver.id, username: caregiver.username, role: 'caregiver', sid: makeSession(db, caregiver.id) });
});

// --- listing ----------------------------------------------------------------------------------

test('GET /child/:id returns that child\'s ready timelapses, newest first', async () => {
  makeTimelapse({ id: 1, nightDate: '2026-07-01' });
  makeTimelapse({ id: 2, nightDate: '2026-07-03' });
  makeTimelapse({ id: 3, nightDate: '2026-07-02' });

  const r = await call(`${server.url}/api/timelapses/child/${child.id}`, { token: adminToken });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.map((t) => t.night_date), ['2026-07-03', '2026-07-02', '2026-07-01']);
});

test('GET /child/:id returns an empty list for a child with none', async () => {
  const r = await call(`${server.url}/api/timelapses/child/nobody`, { token: adminToken });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, []);
});

test('GET /child/:id requires authentication', async () => {
  const r = await call(`${server.url}/api/timelapses/child/${child.id}`);
  assert.equal(r.status, 401);
});

test('a caregiver CAN list timelapses (viewing is not admin-only)', async () => {
  makeTimelapse({ id: 1, nightDate: '2026-07-01' });
  const r = await call(`${server.url}/api/timelapses/child/${child.id}`, { token: caregiverToken });
  assert.equal(r.status, 200);
  assert.equal(r.body.length, 1);
});

// --- #850: a night the detector now stores as `empty` is not listed (and not deleted) -----------------
// A night first stored `ok` has its video made; a later provisional pass can store it `empty`. The listing leaves it
// out while the stored row says so, and a Recompute that makes it `ok` again brings it back, which is why the video
// is hidden rather than deleted (plan review: Recompute can re-store any night of the last 30 days).

function storeNight(childId, nightDate, status) {
  db.prepare(
    `INSERT INTO sleep_nights (child_id, night_date, window_start, window_end, status, computed_at)
     VALUES (?, ?, '2026-07-01 09:00:00', '2026-07-01 21:00:00', ?, '2026-07-02 00:00:00')
     ON CONFLICT(child_id, night_date) DO UPDATE SET status = excluded.status`
  ).run(childId, nightDate, status);
}
const listedNights = async () =>
  (await call(`${server.url}/api/timelapses/child/${child.id}`, { token: adminToken })).body.map((t) => t.night_date);

test('#850: a night stored `empty` is left out of the list; `ok`, and a night with no stored row, are listed', async () => {
  makeTimelapse({ id: 1, nightDate: '2026-07-01' }); // stored ok
  makeTimelapse({ id: 2, nightDate: '2026-07-02' }); // stored empty
  makeTimelapse({ id: 3, nightDate: '2026-07-03' }); // no sleep_nights row at all (demo / pre-sleep-tracking nights)
  storeNight(child.id, '2026-07-01', 'ok');
  storeNight(child.id, '2026-07-02', 'empty');
  assert.deepEqual(await listedNights(), ['2026-07-03', '2026-07-01']);
});

test('#850: the hidden video is not deleted, and a Recompute that stores the night `ok` lists it again', async () => {
  const { rel, relThumb } = makeTimelapse({ id: 4, nightDate: '2026-07-02' });
  storeNight(child.id, '2026-07-02', 'empty');
  assert.deepEqual(await listedNights(), []);
  assert.ok(fs.existsSync(path.join(CLIPS_DIR, rel)) && fs.existsSync(path.join(CLIPS_DIR, relThumb)), 'files are untouched');
  assert.ok(db.prepare('SELECT 1 FROM timelapses WHERE id = 4').get(), 'the row is untouched');
  storeNight(child.id, '2026-07-02', 'ok'); // what an admin's Recompute does once the zone is fixed
  assert.deepEqual(await listedNights(), ['2026-07-02']);
});

test('#850: hostile neighbours: another child\'s `empty` row for the same date, and a night that is only a parent\'s "nobody in the bed" mark, do not hide this one', async () => {
  makeChild(db, { id: 'kid-2', name: 'Other' });
  makeTimelapse({ id: 5, nightDate: '2026-07-02' });
  makeTimelapse({ id: 6, nightDate: '2026-07-03' });
  storeNight('kid-2', '2026-07-02', 'empty'); // same night_date, different child
  storeNight(child.id, '2026-07-03', 'ok'); // the detector saw the child...
  db.prepare('INSERT INTO sleep_reviews (child_id, night_date, nobody_in_bed) VALUES (?, ?, 1)').run(child.id, '2026-07-03'); // ...the parent said nobody
  assert.deepEqual(await listedNights(), ['2026-07-03', '2026-07-02']);
});

test('#850: hidden nights do not use up the page limit', () => {
  for (const [i, d] of ['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-04'].entries()) {
    makeTimelapse({ id: 10 + i, nightDate: d });
  }
  storeNight(child.id, '2026-07-04', 'empty');
  storeNight(child.id, '2026-07-03', 'empty');
  assert.deepEqual(listChildTimelapses(child.id, 2).map((t) => t.night_date), ['2026-07-02', '2026-07-01']);
});

// --- deletion ---------------------------------------------------------------------------------

test('★ an admin can delete a timelapse, and its files go with it', async () => {
  // The regression test for the shipped-broken route: this returned 403 to admins.
  const { rel, relThumb } = makeTimelapse({ id: 7, nightDate: '2026-07-04' });
  assert.ok(fs.existsSync(path.join(CLIPS_DIR, rel)));

  const r = await call(`${server.url}/api/timelapses/7`, { method: 'DELETE', token: adminToken });
  assert.equal(r.status, 200, `expected 200, got ${r.status} ${JSON.stringify(r.body)}`);
  assert.deepEqual(r.body, { ok: true });

  assert.equal(db.prepare('SELECT COUNT(*) c FROM timelapses WHERE id = 7').get().c, 0, 'row removed');
  assert.equal(fs.existsSync(path.join(CLIPS_DIR, rel)), false, 'mp4 removed');
  assert.equal(fs.existsSync(path.join(CLIPS_DIR, relThumb)), false, 'thumbnail removed');
});

test('a caregiver cannot delete a timelapse', async () => {
  makeTimelapse({ id: 8, nightDate: '2026-07-05' });
  const r = await call(`${server.url}/api/timelapses/8`, { method: 'DELETE', token: caregiverToken });
  assert.equal(r.status, 403);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM timelapses WHERE id = 8').get().c, 1, 'row survives');
});

test('deleting without a token is refused', async () => {
  makeTimelapse({ id: 9, nightDate: '2026-07-06' });
  const r = await call(`${server.url}/api/timelapses/9`, { method: 'DELETE' });
  assert.equal(r.status, 401);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM timelapses WHERE id = 9').get().c, 1);
});

test('deleting an id that does not exist is a 404, not a crash', async () => {
  const r = await call(`${server.url}/api/timelapses/4242`, { method: 'DELETE', token: adminToken });
  assert.equal(r.status, 404);
  assert.match(r.body.error, /No timelapse/);
});

test('deleting a row whose files are already gone still removes the row', async () => {
  // Disk and DB can drift (a manual cleanup, a restored backup). Delete must be idempotent enough to
  // finish the job rather than throwing on a missing file.
  makeTimelapse({ id: 10, nightDate: '2026-07-07', withFiles: false });
  const r = await call(`${server.url}/api/timelapses/10`, { method: 'DELETE', token: adminToken });
  assert.equal(r.status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM timelapses WHERE id = 10').get().c, 0);
});

test('deleting one timelapse leaves the others alone', async () => {
  makeTimelapse({ id: 11, nightDate: '2026-07-08' });
  const keep = makeTimelapse({ id: 12, nightDate: '2026-07-09' });
  await call(`${server.url}/api/timelapses/11`, { method: 'DELETE', token: adminToken });
  assert.equal(db.prepare('SELECT COUNT(*) c FROM timelapses WHERE id = 12').get().c, 1);
  assert.ok(fs.existsSync(path.join(CLIPS_DIR, keep.rel)), 'the other timelapse keeps its file');
});

// --- video / thumbnail streaming --------------------------------------------------------------

test('video and thumbnail 404 for an unknown id', async () => {
  const v = await call(`${server.url}/api/timelapses/999/video`, { token: adminToken });
  const t = await call(`${server.url}/api/timelapses/999/thumb`, { token: adminToken });
  assert.equal(v.status, 404);
  assert.equal(t.status, 404);
});

test('video and thumbnail require a token', async () => {
  makeTimelapse({ id: 13, nightDate: '2026-07-10' });
  assert.equal((await call(`${server.url}/api/timelapses/13/video`)).status, 401);
  assert.equal((await call(`${server.url}/api/timelapses/13/thumb`)).status, 401);
});

test('a path-escaping stored path is refused rather than serving an arbitrary file', async () => {
  // Defence in depth: the stored path is jailed under CLIPS_DIR, so a tampered row can't read
  // /etc/passwd or the SQLite file itself.
  db.prepare(
    `INSERT INTO timelapses (id, child_id, night_date, status, path, thumb_path)
     VALUES (14, ?, '2026-07-11', 'ready', ?, ?)`
  ).run(child.id, '../../../../etc/passwd', '../../../../etc/passwd');
  const r = await call(`${server.url}/api/timelapses/14/video`, { token: adminToken });
  assert.equal(r.status, 404);
});

// Keep the temp dir out of the way even if the runner exits abnormally.
process.on('exit', () => { try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ } });
