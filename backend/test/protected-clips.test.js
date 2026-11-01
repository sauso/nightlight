// #932: real rows and media files exercise every automatic and direct deletion boundary.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, signToken, mountRouter, call } from './helpers/harness.js';

useTempDataDir();
const { default: db } = await import('../src/db.js');
const ev = await import('../src/lib/detectionEvents.js');
const { CLIPS_DIR } = await import('../src/lib/clipRecorder.js');
const { checkClipStorage, sweepClips, clipStorageStats } = await import('../src/lib/clipStorage.js');
const { previewClipRetention } = await import('../src/lib/clipRetentionPreview.js');
const { pruneWakeClips, protectedWakeClipStats, wakeClipStats, listChildWakeClips } = await import('../src/lib/recordings.js');
const { default: camerasRouter } = await import('../src/routes/cameras.js');
const { default: recordingsRouter } = await import('../src/routes/recordings.js');
const { default: settingsRouter } = await import('../src/routes/settings.js');
const { enqueueClip } = await import('../src/lib/clipCapture.js');
const { extractClip } = await import('../src/lib/clipRecorder.js');

const root = path.resolve(CLIPS_DIR);
const GB = 1024 ** 3;
const row = (id) => db.prepare('SELECT * FROM detection_events WHERE id = ?').get(id);
const rec = (id) => db.prepare('SELECT * FROM recordings WHERE id = ?').get(id);
let cameras;
let recordings;
let settings;
let admin;
let caregiver;

function alert(name, { age = 0, bytes = 100, protectedClip = false, camera = 'cam-a' } = {}) {
  const id = ev.recordDetectionEvent(camera, 'Test camera', ev.ALERT.MOTION);
  const rel = path.join(camera, `${id}-${name}.mp4`);
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'clip');
  fs.writeFileSync(file.replace(/\.mp4$/, '.jpg'), 'thumb');
  ev.setClipReady(id, rel, 6, bytes);
  ev.saveEventSnapshot(id, Buffer.from('snapshot'));
  if (age) db.prepare("UPDATE detection_events SET created_at = datetime('now', ?) WHERE id = ?").run(`-${age} days`, id);
  if (protectedClip) db.prepare('UPDATE detection_events SET protected = 1 WHERE id = ?').run(id);
  return { id, file, thumb: file.replace(/\.mp4$/, '.jpg'), snapshot: path.join(ev.DETECTION_SNAPSHOT_DIR, `${id}.jpg`) };
}

function wake(name, { age = 0, protectedClip = false, kind = 'wake', status = 'ready' } = {}) {
  const rel = path.join('cam-a', `${name}.mp4`);
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'wake');
  const thumb = file.replace(/\.mp4$/, '.jpg');
  fs.writeFileSync(thumb, 'thumb');
  const id = db.prepare(`INSERT INTO recordings (camera_id, child_id, kind, status, started_at,
    path, thumb_path, duration_s, bytes, protected, created_at)
    VALUES ('cam-a', 'child-a', ?, ?, datetime('now'), ?, ?, 6, 123, ?, datetime('now', ?))`)
    .run(kind, status, rel, rel.replace(/\.mp4$/, '.jpg'), Number(protectedClip), `-${age} days`).lastInsertRowid;
  return { id, file, thumb };
}

before(async () => {
  cameras = await mountRouter('/api/cameras', camerasRouter);
  recordings = await mountRouter('/api/recordings', recordingsRouter);
  settings = await mountRouter('/api/settings', settingsRouter);
  const a = makeUser(db, { id: 'protection-admin', username: 'protection-admin', role: 'admin' });
  const c = makeUser(db, { id: 'protection-caregiver', username: 'protection-caregiver', role: 'caregiver' });
  admin = signToken({ sub: a.id, role: a.role, sid: makeSession(db, a.id) });
  caregiver = signToken({ sub: c.id, role: c.role, sid: makeSession(db, c.id) });
});
after(async () => { await cameras?.close(); await recordings?.close(); await settings?.close(); db.close(); cleanupTempDataDirs(); });
beforeEach(() => {
  db.prepare('DELETE FROM detection_events').run();
  db.prepare('DELETE FROM recordings').run();
  fs.rmSync(path.join(root, 'cam-a'), { recursive: true, force: true });
  fs.rmSync(path.join(root, 'cam-b'), { recursive: true, force: true });
  db.prepare('UPDATE settings SET clip_retention_days = 14, clip_retention_max_gb = 5, wake_clip_retention_days = 14 WHERE id = ?').run('app');
  checkClipStorage({ mounts: `/dev/sda1 / ext4 rw 0 0\n/dev/sdb1 ${root} xfs rw 0 0\n` });
});

test('retention age skips a protected clip on another camera; unprotecting an expired clip uses its original created_at', () => {
  const expired = alert('expired', { age: 20, camera: 'cam-b' });
  const locked = alert('locked', { age: 20, protectedClip: true });
  const young = alert('young', { age: 2 });
  const youngLocked = alert('young-locked', { age: 2, protectedClip: true });
  const preview = previewClipRetention({ days: 14, maxGb: 0 });
  assert.equal(preview.count, 1);
  db.prepare('UPDATE settings SET clip_retention_max_gb = 0 WHERE id = ?').run('app');
  sweepClips();
  assert.equal(row(expired.id).clip_path, null);
  assert.equal(fs.existsSync(expired.file), false);
  assert.ok(row(locked.id).clip_path);
  for (const p of [locked.file, locked.thumb, locked.snapshot, young.file,
    youngLocked.file, youngLocked.thumb, youngLocked.snapshot]) assert.ok(fs.existsSync(p));
  assert.equal(ev.setEventProtected(locked.id, false), true);
  sweepClips();
  assert.equal(row(locked.id).clip_path, null);
});

test('cap total and eviction exclude protected bytes and terminate when only protected bytes exceed cap', () => {
  const locked = alert('locked', { bytes: 2 * GB, protectedClip: true });
  const open = alert('open', { bytes: 0.8 * GB });
  const smallLocked = alert('small-locked', { bytes: 0.1 * GB, protectedClip: true });
  const smallOpen = alert('small-open', { bytes: 0.1 * GB });
  db.prepare('UPDATE settings SET clip_retention_days = 0, clip_retention_max_gb = 0.5 WHERE id = ?').run('app');
  assert.equal(ev.getClipStorageTotals().bytes, 0.9 * GB);
  assert.equal(previewClipRetention({ days: 0, maxGb: 0.5 }).count, 1);
  sweepClips();
  assert.equal(row(open.id).clip_path, null);
  assert.ok(row(locked.id).clip_path);
  assert.ok(row(smallOpen.id).clip_path);
  for (const p of [locked.file, locked.thumb, locked.snapshot,
    smallLocked.file, smallLocked.thumb, smallLocked.snapshot]) assert.ok(fs.existsSync(p));
  sweepClips();
  assert.equal(ev.getClipStorageTotals().bytes, 0.1 * GB);
  db.prepare('UPDATE settings SET clip_retention_max_gb = 0.05 WHERE id = ?').run('app');
  sweepClips();
  assert.equal(row(smallOpen.id).clip_path, null);
  assert.equal(ev.getClipStorageTotals().bytes, 0);
  assert.ok(fs.existsSync(locked.file));
  assert.ok(fs.existsSync(smallLocked.file));
});

test('backstop age keeps protected row, MP4, thumbnail and snapshot', () => {
  const open = alert('open', { age: 31 });
  const locked = alert('locked', { age: 31, protectedClip: true });
  const young = alert('young', { age: 1 });
  const youngLocked = alert('young-locked', { age: 1, protectedClip: true });
  ev.recordDetectionEvent('cam-a', 'Test camera', ev.ALERT.MOTION);
  assert.equal(row(open.id), undefined);
  assert.equal(fs.existsSync(open.file), false);
  assert.equal(fs.existsSync(open.thumb), false);
  assert.equal(row(locked.id).protected, 1);
  for (const p of [locked.file, locked.thumb, locked.snapshot, young.file,
    youngLocked.file, youngLocked.thumb, youngLocked.snapshot]) assert.ok(fs.existsSync(p));
});

test('backstop count excludes protected rows from the newest 2000', () => {
  const open = alert('open');
  const locked = alert('locked', { protectedClip: true });
  const insert = db.prepare("INSERT INTO detection_events (camera_id, camera_name, type) VALUES ('cam-a', 'Test camera', 'motion')");
  db.transaction(() => { for (let i = 0; i < 1999; i++) insert.run(); })();
  ev.recordDetectionEvent('cam-a', 'Test camera', ev.ALERT.MOTION);
  assert.equal(row(open.id), undefined);
  assert.equal(row(locked.id).protected, 1);
  for (const p of [locked.file, locked.thumb, locked.snapshot]) assert.ok(fs.existsSync(p));
});

test('clear history retains protected alert and snapshot', async () => {
  const open = alert('open');
  const locked = alert('locked', { protectedClip: true });
  const orphan = path.join(ev.DETECTION_SNAPSHOT_DIR, '999999.jpg');
  fs.writeFileSync(orphan, 'orphan');
  assert.equal(ev.clearDetectionEvents(), 1);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(row(open.id), undefined);
  assert.equal(fs.existsSync(open.snapshot), false);
  assert.equal(fs.existsSync(orphan), false);
  assert.equal(row(locked.id).protected, 1);
  for (const p of [locked.file, locked.thumb, locked.snapshot]) assert.ok(fs.existsSync(p));
});

test('wake retention deletes only unprotected old wake clips', () => {
  const open = wake('open', { age: 20 });
  const locked = wake('locked', { age: 20, protectedClip: true });
  const young = wake('young', { age: 2 });
  assert.equal(pruneWakeClips(), 1);
  assert.equal(rec(open.id), undefined);
  assert.equal(fs.existsSync(open.file), false);
  assert.equal(rec(locked.id).protected, 1);
  for (const p of [locked.file, locked.thumb, young.file]) assert.ok(fs.existsSync(p));
});

test('storage counts only unprotected alert bytes in the cap and reports protected alert and wake use', async () => {
  alert('open', { bytes: 100 });
  alert('locked', { bytes: 200, protectedClip: true });
  wake('wake', { protectedClip: true });
  const stats = clipStorageStats();
  assert.equal(stats.clipCount, 1);
  assert.equal(stats.usedBytes, 100);
  assert.equal(stats.protectedAlertClips, 1);
  assert.equal(stats.protectedAlertBytes, 200);
  assert.equal(stats.protectedWakeClips, 1);
  assert.equal(stats.protectedWakeBytes, 123);
  assert.deepEqual(protectedWakeClipStats(), { count: 1, bytes: 123 });
  assert.deepEqual(wakeClipStats(), { count: 1, bytes: 123 });
  const response = await call(`${settings.url}/api/settings/clip-storage`, { token: admin });
  assert.equal(response.status, 200);
  for (const key of ['usedBytes', 'clipCount', 'recordingCount', 'recordingBytes', 'wakeClips',
    'protectedAlertClips', 'protectedAlertBytes', 'protectedWakeClips', 'protectedWakeBytes']) assert.ok(key in response.body);
  assert.equal(response.body.wakeClips.count, 1);
  assert.equal(response.body.protectedWakeBytes, 123);
});

test('admin protect routes validate role, boolean, ready kind and existing file; direct deletes return 409', async () => {
  const a = alert('alert');
  const noClipId = ev.recordDetectionEvent('cam-a', 'Test camera', ev.ALERT.MOTION);
  const w = wake('wake');
  const manual = wake('manual', { kind: 'manual' });
  const failed = wake('failed', { status: 'failed' });
  for (const [base, id] of [[cameras.url + '/api/cameras/alerts', a.id], [recordings.url + '/api/recordings', w.id]]) {
    const url = `${base}/${id}/protected`;
    assert.equal((await call(url, { method: 'PUT', body: { protected: true } })).status, 401);
    assert.equal((await call(url, { method: 'PUT', token: caregiver, body: { protected: true } })).status, 403);
    assert.equal((await call(url, { method: 'PUT', token: admin, body: { protected: 1 } })).status, 400);
    assert.equal((await call(`${base}/999999/protected`, { method: 'PUT', token: admin, body: { protected: true } })).status, 404);
    assert.deepEqual((await call(url, { method: 'PUT', token: admin, body: { protected: true } })).body, { protected: true });
    const refused = await call(`${base}/${id}${base.includes('/alerts') ? '/clip' : ''}`, { method: 'DELETE', token: admin });
    assert.equal(refused.status, 409);
    assert.deepEqual(refused.body, { error: 'This clip is protected. Unprotect it first.' });
    assert.deepEqual((await call(url, { method: 'PUT', token: admin, body: { protected: false } })).body, { protected: false });
  }
  assert.ok(fs.existsSync(a.file));
  assert.ok(fs.existsSync(a.thumb));
  assert.equal((await call(`${cameras.url}/api/cameras/alerts/${noClipId}/protected`, { method: 'PUT', token: admin, body: { protected: true } })).status, 404);
  assert.equal((await call(`${recordings.url}/api/recordings/${manual.id}/protected`, { method: 'PUT', token: admin, body: { protected: true } })).status, 404);
  assert.equal((await call(`${recordings.url}/api/recordings/${failed.id}/protected`, { method: 'PUT', token: admin, body: { protected: true } })).status, 404);
  fs.rmSync(a.file);
  assert.equal((await call(`${cameras.url}/api/cameras/alerts/${a.id}/protected`, { method: 'PUT', token: admin, body: { protected: true } })).status, 404);
  fs.rmSync(w.file);
  assert.equal((await call(`${recordings.url}/api/recordings/${w.id}/protected`, { method: 'PUT', token: admin, body: { protected: true } })).status, 404);
});

test('protected list is admin only, unbounded, newest first and includes playback fields', async () => {
  const first = alert('first', { protectedClip: true });
  const last = alert('last', { protectedClip: true });
  const w = wake('wake', { protectedClip: true });
  const url = `${cameras.url}/api/cameras/clips/protected`;
  assert.equal((await call(url)).status, 401);
  assert.equal((await call(url, { token: caregiver })).status, 403);
  const result = await call(url, { token: admin });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.alerts.map((x) => x.id), [last.id, first.id]);
  assert.equal(result.body.alerts[0].protected, 1);
  for (const key of ['camera_id', 'camera_name', 'created_at', 'clip_duration_s', 'clip_bytes', 'snapshot']) {
    assert.ok(key in result.body.alerts[0]);
  }
  assert.equal(result.body.wake[0].id, w.id);
  assert.equal(ev.getClips()[0].protected, 1);
  assert.equal(listChildWakeClips('child-a', '2000-01-01', '2099-01-01')[0].protected, 1);
  for (const key of ['camera_id', 'child_id', 'started_at', 'created_at', 'duration_s', 'bytes', 'camera_name', 'child_name']) {
    assert.ok(key in result.body.wake[0]);
  }
});

test('protected list reaches an old clip beyond the recent 200 and 2000 limits', async () => {
  const old = alert('old', { age: 40, protectedClip: true });
  const insert = db.prepare(`INSERT INTO detection_events
    (camera_id, camera_name, type, clip_status, clip_path, protected)
    VALUES ('cam-a', 'Test camera', 'motion', 'ready', ?, 1)`);
  // These rows share a real file only to exercise the list boundary without writing 2000 MP4s.
  db.transaction(() => { for (let i = 0; i < 2000; i++) insert.run(row(old.id).clip_path); })();
  const result = await call(`${cameras.url}/api/cameras/clips/protected`, { token: admin });
  assert.equal(result.status, 200);
  assert.equal(result.body.alerts.length, 2001);
  assert.equal(result.body.alerts.at(-1).id, old.id);
  assert.ok(fs.existsSync(old.file));
});

test('replayed extraction id leaves a protected clip and thumbnail untouched', async () => {
  const locked = alert('original', { protectedClip: true });
  const output = path.join(root, 'cam-a', `${locked.id}.mp4`);
  const thumb = output.replace(/\.mp4$/, '.jpg');
  fs.renameSync(locked.file, output);
  fs.renameSync(locked.thumb, thumb);
  db.prepare('UPDATE detection_events SET clip_path = ? WHERE id = ?').run(path.join('cam-a', `${locked.id}.mp4`), locked.id);
  enqueueClip({ id: 'cam-a', name: 'Test camera', detect_record_clips: 1 }, locked.id);
  assert.equal(row(locked.id).clip_status, 'ready');
  await assert.rejects(extractClip('cam-a', { outBase: String(locked.id), settleMs: 0 }), /protected clip output/);
  assert.ok(fs.existsSync(output));
  assert.ok(fs.existsSync(thumb));
});
