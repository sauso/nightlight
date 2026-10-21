// #564: exercise bulk clip deletion through the real camera router, database and files.
// The helper's own lifecycle is tested elsewhere; these requests pin which ids the route acts on.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, signToken, mountRouter, call,
} from './helpers/harness.js';

useTempDataDir();

const { default: db } = await import('../src/db.js');
const { default: camerasRouter } = await import('../src/routes/cameras.js');
const { CLIPS_DIR } = await import('../src/lib/clipRecorder.js');
const { recordDetectionEvent, setClipReady, ALERT } = await import('../src/lib/detectionEvents.js');

let server;
let adminToken;
let caregiverToken;

const post = (body, token = adminToken) =>
  call(`${server.url}/api/cameras/clips/delete`, { method: 'POST', token, body });
const row = (id) => db.prepare('SELECT * FROM detection_events WHERE id = ?').get(id);

function makeEvent() {
  return recordDetectionEvent('cam-test', 'Test Camera', ALERT.MOTION, 'test event');
}

function makeClip(name) {
  const id = makeEvent();
  const rel = path.join('route-test', `${id}-${name}.mp4`);
  const file = path.join(CLIPS_DIR, rel);
  const thumb = file.replace(/\.mp4$/i, '.jpg');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'clip data');
  fs.writeFileSync(thumb, 'thumbnail data');
  setClipReady(id, rel, 8, 512);
  return { id, file, thumb };
}

function assertClipCleared(clip) {
  assert.equal(fs.existsSync(clip.file), false, 'MP4 remains');
  assert.equal(fs.existsSync(clip.thumb), false, 'thumbnail remains');
  const after = row(clip.id);
  assert.ok(after, 'event row must remain');
  assert.equal(after.clip_status, null);
  assert.equal(after.clip_path, null);
  assert.equal(after.clip_duration_s, null);
  assert.equal(after.clip_bytes, null);
}

before(async () => {
  server = await mountRouter('/api/cameras', camerasRouter);
  const admin = makeUser(db, { id: 'clips-admin', username: 'clips-admin', role: 'admin' });
  const caregiver = makeUser(db, { id: 'clips-caregiver', username: 'clips-caregiver', role: 'caregiver' });
  adminToken = signToken({ sub: admin.id, role: admin.role, sid: makeSession(db, admin.id) });
  caregiverToken = signToken({ sub: caregiver.id, role: caregiver.role, sid: makeSession(db, caregiver.id) });
});

after(async () => {
  await server?.close();
  db.close();
  cleanupTempDataDirs();
});

test('mixed ids remove exactly two clips and keep all event rows', async () => {
  const first = makeClip('first');
  const second = makeClip('second');
  const unrelated = makeClip('unrelated');
  const noClipId = makeEvent();
  const noClipBefore = row(noClipId);
  const unrelatedBefore = row(unrelated.id);

  const result = await post({ ids: [first.id, 999999999, noClipId, 'garbage', second.id, first.id] });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { deleted: 2 });
  assertClipCleared(first);
  assertClipCleared(second);
  assert.equal(fs.existsSync(unrelated.file), true);
  assert.equal(fs.existsSync(unrelated.thumb), true);
  assert.deepEqual(row(unrelated.id), unrelatedBefore);
  assert.deepEqual(row(noClipId), noClipBefore);
});

test('a caregiver refusal leaves the clip and its row untouched', async () => {
  const clip = makeClip('refused');
  const beforeRow = row(clip.id);

  const result = await post({ ids: [clip.id] }, caregiverToken);
  assert.equal(result.status, 403);
  assert.equal(fs.existsSync(clip.file), true);
  assert.equal(fs.existsSync(clip.thumb), true);
  assert.deepEqual(row(clip.id), beforeRow);
});

test('missing, non-array and empty ids are no-ops', async () => {
  const clip = makeClip('no-op');
  const beforeRow = row(clip.id);

  for (const body of [
    {},
    { ids: 'x' },
    { ids: String(clip.id) },
    { ids: { 0: String(clip.id) } },
    { ids: [] },
  ]) {
    const result = await post(body);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { deleted: 0 });
    assert.equal(fs.existsSync(clip.file), true);
    assert.equal(fs.existsSync(clip.thumb), true);
    assert.deepEqual(row(clip.id), beforeRow);
  }
});

test('a stored traversal path cannot delete a file in a sibling directory', async () => {
  // The outside file must exist: an absent target would let a broken containment check pass.
  const sibling = `${CLIPS_DIR}-outside`;
  const outsideFile = path.join(sibling, 'keep.mp4');
  const outsideThumb = path.join(sibling, 'keep.jpg');
  fs.mkdirSync(sibling, { recursive: true });
  fs.writeFileSync(outsideFile, 'outside clip');
  fs.writeFileSync(outsideThumb, 'outside thumbnail');
  const id = makeEvent();
  setClipReady(id, path.join('..', path.basename(sibling), 'keep.mp4'), 8, 512);

  const result = await post({ ids: [id] });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { deleted: 1 });
  assert.equal(fs.readFileSync(outsideFile, 'utf8'), 'outside clip');
  assert.equal(fs.readFileSync(outsideThumb, 'utf8'), 'outside thumbnail');
  assert.ok(row(id), 'event row must remain');
  assert.equal(row(id).clip_path, null);
});
