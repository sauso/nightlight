// What a caregiver can no longer destroy or rearrange (#538, #552; owner decision 2026-10-10: a caregiver
// can watch and act in the moment, but cannot destroy or reconfigure).
//
// route-permissions.test.js already proves each of these routes answers a caregiver with requireAdmin's
// 403. That is a status code. This file proves the CONSEQUENCE, over real HTTP against the real router:
// the thing a caregiver tried to destroy is still there afterwards, file on disk included, and an admin
// doing the same thing really does destroy it (so "still there" is not passing because the route never
// deletes anything at all).
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, signToken, mountRouter, call,
} from './helpers/harness.js';

useTempDataDir();

const { default: db } = await import('../src/db.js');
const { default: camerasRouter } = await import('../src/routes/cameras.js');
const events = await import('../src/lib/detectionEvents.js');
const { CLIPS_DIR } = await import('../src/lib/clipRecorder.js');

let server;
let adminToken;
let caregiverToken;

before(async () => {
  server = await mountRouter('/api/cameras', camerasRouter);
  const admin = makeUser(db, { id: 'u-a', username: 'admin', role: 'admin' });
  const carer = makeUser(db, { id: 'u-c', username: 'carer', role: 'caregiver' });
  adminToken = signToken({ id: admin.id, username: admin.username, role: 'admin', sid: makeSession(db, admin.id) });
  caregiverToken = signToken({ id: carer.id, username: carer.username, role: 'caregiver', sid: makeSession(db, carer.id) });
});

after(async () => {
  await server.close();
  db.close();
  cleanupTempDataDirs();
});

describe('DELETE /api/cameras/alerts/:id/clip (#538)', () => {
  // An alert with a ready clip: the row, its snapshot flag and a real mp4 on disk.
  function alertWithClip() {
    const id = events.recordDetectionEvent('cam-x', 'Test Cam', events.ALERT.MOTION, 'an alert');
    const rel = path.join('role-gates', `clip-${id}.mp4`);
    fs.mkdirSync(path.join(CLIPS_DIR, 'role-gates'), { recursive: true });
    fs.writeFileSync(path.join(CLIPS_DIR, rel), 'mp4 bytes');
    events.setClipReady(id, rel, 8, 9);
    return { id, rel, abs: path.join(CLIPS_DIR, rel) };
  }
  const clipRow = (id) => db.prepare('SELECT clip_status, clip_path FROM detection_events WHERE id = ?').get(id);
  const del = (id, token) => call(`${server.url}/api/cameras/alerts/${id}/clip`, { method: 'DELETE', token });

  beforeEach(() => db.prepare('DELETE FROM detection_events').run());

  test('a caregiver gets 403, and the clip, its row and its file are all still there', async () => {
    const clip = alertWithClip();
    const res = await del(clip.id, caregiverToken);
    assert.equal(res.status, 403);
    assert.deepEqual(res.body, { error: 'Admin access required' });
    assert.deepEqual(clipRow(clip.id), { clip_status: 'ready', clip_path: clip.rel });
    assert.equal(fs.existsSync(clip.abs), true, 'the mp4 was deleted for a caregiver');
  });

  test('a caregiver can still WATCH it (the GET is unchanged)', async () => {
    const clip = alertWithClip();
    const res = await call(`${server.url}/api/cameras/alerts/${clip.id}/clip`, { token: caregiverToken });
    assert.equal(res.status, 200);
    assert.equal(res.body, 'mp4 bytes');
  });

  test('an admin deletes it: 204, the file is gone, the alert row stays', async () => {
    const clip = alertWithClip();
    const res = await del(clip.id, adminToken);
    assert.equal(res.status, 204);
    assert.deepEqual(clipRow(clip.id), { clip_status: null, clip_path: null });
    assert.equal(fs.existsSync(clip.abs), false, 'the admin delete left the mp4 on disk');
  });
});
