// routes/recordings.js — the on-demand ("Record" button) recordings a person chose to keep.
//
// ★ WHY THIS FILE EXISTS. The route module was imported by NO test at all: it did not appear in a
// coverage report even as a 0, because Node only reports files it loaded. Issue #263 counts it among
// the twelve route modules nothing imports. What sat untested was every 404, both auth modes, and a
// DELETE that removes files from disk.
//
// The lib functions underneath are covered from the other side in recordings-visibility.test.js
// (which status is listable, which is servable). This file is about the seam: does the ROUTE ask the
// right question, and does it answer with the right status code — the client/server seam that unit
// tests on either half cannot span.
import { test, before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, signToken, makeChild, makeCamera,
  mountRouter, call,
} from './helpers/harness.js';

useTempDataDir();

const { default: db } = await import('../src/db.js');
const { default: recordingsRouter } = await import('../src/routes/recordings.js');
const { CLIPS_DIR } = await import('../src/lib/clipRecorder.js');
const { deleteRecording, getRecordingVideoFile } = await import('../src/lib/recordings.js');

const ABS = path.resolve(CLIPS_DIR);
const CHILD = 'kid-1';
const CAM = 'cam-1';

let server;
let token;
let caregiverToken;
let mediaSid; // a live session the media-scoped tokens below hang off

// A recording row plus the files it points at. `kind` defaults to 'manual', which is what the listing
// filters on; the wake-clip case passes it explicitly.
function makeRecording({ status = 'ready', kind = 'manual', childId = CHILD, withFiles = true } = {}) {
  const rel = path.join(CAM, `rec-${Math.random().toString(36).slice(2, 8)}.mp4`);
  const thumbRel = rel.replace(/\.mp4$/, '.jpg');
  const info = db
    .prepare(
      `INSERT INTO recordings (camera_id, child_id, status, kind, started_at, ended_at, duration_s, bytes, path, thumb_path)
       VALUES (?, ?, ?, ?, datetime('now'), datetime('now'), 12, 4096, ?, ?)`
    )
    .run(CAM, childId, status, kind, rel, thumbRel);
  if (withFiles) {
    fs.mkdirSync(path.join(ABS, CAM), { recursive: true });
    fs.writeFileSync(path.join(ABS, rel), 'mp4 bytes');
    fs.writeFileSync(path.join(ABS, thumbRel), 'jpg bytes');
  }
  return { id: info.lastInsertRowid, rel, thumbRel, abs: path.join(ABS, rel), thumbAbs: path.join(ABS, thumbRel) };
}

const url = (p) => `${server.url}/api/recordings${p}`;

before(async () => {
  server = await mountRouter('/api/recordings', recordingsRouter);
  makeChild(db, { id: CHILD, name: 'Kid' });
  makeCamera(db, { id: CAM, name: 'Nursery', childId: CHILD });
  const admin = makeUser(db, { id: 'u-a', username: 'admin', role: 'admin' });
  const care = makeUser(db, { id: 'u-c', username: 'nanny', role: 'caregiver' });
  token = signToken({ id: admin.id, username: admin.username, role: 'admin', sid: makeSession(db, admin.id) });
  mediaSid = makeSession(db, admin.id);
  caregiverToken = signToken({ id: care.id, username: care.username, role: 'caregiver', sid: makeSession(db, care.id) });
});

after(async () => {
  await server?.close();
  db.close();
  cleanupTempDataDirs();
});

beforeEach(() => {
  db.prepare('DELETE FROM recordings').run();
  fs.rmSync(path.join(ABS, CAM), { recursive: true, force: true });
});

describe('GET /child/:childId', () => {
  test('lists a child’s finished recordings with the camera name joined in', async () => {
    const r = makeRecording();
    const res = await call(url(`/child/${CHILD}`), { token });
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 1);
    assert.equal(res.body[0].id, r.id);
    assert.equal(res.body[0].camera_name, 'Nursery', 'the card cannot say which camera without this');
  });

  test('★ automatic wake clips are not in the manual list', async () => {
    // They share the table and are kept for a different length of time, so mixing them would put clips
    // nobody asked for into a list of keepsakes — and make the retention story unexplainable.
    makeRecording({ kind: 'wake' });
    const res = await call(url(`/child/${CHILD}`), { token });
    assert.deepEqual(res.body, []);
  });

  test('a child with nothing recorded gets an empty list, not a 404', async () => {
    makeChild(db, { id: 'kid-2', name: 'Other' });
    const res = await call(url('/child/kid-2'), { token });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, []);
  });

  test('an unknown child id is an empty list too — never an error', async () => {
    // The page requests this on load; a 404 here would render as a broken screen for a child that was
    // deleted in another tab.
    const res = await call(url('/child/nobody'), { token });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, []);
  });

  test('★ it requires a signed-in user, and a caregiver counts as one', async () => {
    makeRecording();
    assert.equal((await call(url(`/child/${CHILD}`))).status, 401, 'the list was readable signed out');
    assert.equal(
      (await call(url(`/child/${CHILD}`), { token: caregiverToken })).status, 200,
      'a caregiver was refused their own household’s recordings'
    );
  });
});

describe('GET /:id/video and /:id/thumb', () => {
  test('a ready recording streams, and so does its thumbnail', async () => {
    const r = makeRecording();
    const video = await call(url(`/${r.id}/video`), { token });
    assert.equal(video.status, 200);
    const thumb = await call(url(`/${r.id}/thumb`), { token });
    assert.equal(thumb.status, 200);
  });

  test('★ a MEDIA-scoped token may arrive in the QUERY STRING, because <video> cannot send a header', async () => {
    // This is the whole reason these two routes use a different middleware from the rest of the file.
    // Safari's native player fetches media itself, with no way to attach Authorization — so a
    // header-only guard here means the video simply never plays, on one browser, silently.
    const r = makeRecording();
    const media = signToken({ id: 'u-a', username: 'admin', role: 'admin', sid: mediaSid, purpose: 'media' });
    const res = await call(`${url(`/${r.id}/video`)}?token=${encodeURIComponent(media)}`);
    assert.equal(res.status, 200, 'a media token in the query string was refused — the player shows nothing');
    assert.equal(
      (await call(`${url(`/${r.id}/thumb`)}?token=${encodeURIComponent(media)}`)).status, 200,
      'the thumbnail route disagrees with the video route about the same token'
    );
  });

  test('★ ...but an ORDINARY session token in the URL is not enough', async () => {
    // The 0.25.0 hardening, pinned here because this is one of only two places a token may appear in
    // a URL at all. A media URL ends up in browser history, in a referrer, in a screenshot someone
    // sends you — so what it carries must be a video capability, never account access. Accepting the
    // PARAMETER is not the same as accepting anything in it.
    const r = makeRecording();
    assert.equal(
      (await call(`${url(`/${r.id}/video`)}?token=${encodeURIComponent(token)}`)).status, 401,
      'a full session token worked as a URL parameter — a leaked media link would be a login'
    );
    assert.equal((await call(`${url(`/${r.id}/video`)}?token=not-a-real-token`)).status, 401);
    assert.equal((await call(url(`/${r.id}/video`))).status, 401, 'no token at all was accepted');
  });

  test('a media token whose SESSION has been revoked stops working', async () => {
    // Purpose-scoping is not the only check: the session row still has to exist, which is what makes
    // "sign out this device" take effect on media URLs too rather than waiting for expiry.
    const r = makeRecording();
    const sid = makeSession(db, 'u-a');
    const media = signToken({ id: 'u-a', username: 'admin', role: 'admin', sid, purpose: 'media' });
    assert.equal((await call(`${url(`/${r.id}/video`)}?token=${encodeURIComponent(media)}`)).status, 200);
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sid);
    assert.equal(
      (await call(`${url(`/${r.id}/video`)}?token=${encodeURIComponent(media)}`)).status, 401,
      'a revoked session still served media'
    );
  });

  test('an unknown id is a 404 with a message, not a crash', async () => {
    const res = await call(url('/999999/video'), { token });
    assert.equal(res.status, 404);
    assert.match(res.body.error, /No recording/);
    assert.equal((await call(url('/999999/thumb'), { token })).status, 404);
  });

  test('a row whose file is missing is a 404, not an empty 200', async () => {
    // The row can outlive its file (a manual delete on the host, a volume remount). Serving a 200 with
    // nothing in it makes the player fail in a way nobody can diagnose.
    const r = makeRecording({ withFiles: false });
    assert.equal((await call(url(`/${r.id}/video`), { token })).status, 404);
    assert.equal((await call(url(`/${r.id}/thumb`), { token })).status, 404);
  });

  test('a recording with no thumbnail recorded is a 404 on /thumb but still plays', async () => {
    const r = makeRecording();
    fs.rmSync(r.thumbAbs, { force: true });
    db.prepare('UPDATE recordings SET thumb_path = NULL WHERE id = ?').run(r.id);
    assert.equal((await call(url(`/${r.id}/thumb`), { token })).status, 404);
    assert.equal((await call(url(`/${r.id}/video`), { token })).status, 200, 'a missing thumbnail broke playback');
  });
});

describe('★ path containment on the serving routes', () => {
  // A stored path is data, and a route that hands `res.sendFile` whatever is in the column would serve
  // any file on the volume to any signed-in user. Guarded in the lib (resolve under CLIPS_DIR) AND by
  // Express's own `{ root }` — both, because either alone is one refactor from being the only one.
  test('a row pointing above CLIPS_DIR is refused', async () => {
    const outside = path.join(path.dirname(ABS), 'secret.mp4');
    fs.writeFileSync(outside, 'must not be served');
    const r = makeRecording();
    db.prepare('UPDATE recordings SET path = ? WHERE id = ?').run(path.join('..', 'secret.mp4'), r.id);

    assert.equal(getRecordingVideoFile(r.id), null, 'the lib resolved a path outside the jail');
    const res = await call(url(`/${r.id}/video`), { token });
    assert.equal(res.status, 404, 'a file outside CLIPS_DIR was served');
    assert.equal(fs.existsSync(outside), true);
  });

  test('and so is an absolute path', async () => {
    const outside = path.join(path.dirname(ABS), 'absolute.mp4');
    fs.writeFileSync(outside, 'must not be served');
    const r = makeRecording();
    db.prepare('UPDATE recordings SET thumb_path = ? WHERE id = ?').run(outside, r.id);
    assert.equal((await call(url(`/${r.id}/thumb`), { token })).status, 404);
  });
});

describe('DELETE /:id', () => {
  test('★ removes the row AND both files', async () => {
    // These have no automatic retention — a manual delete is the only way the space is ever reclaimed,
    // so a delete that clears the row and leaves the mp4 is a disk that fills up with orphans nothing
    // can find.
    const r = makeRecording();
    const res = await call(url(`/${r.id}`), { method: 'DELETE', token });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true });
    assert.equal(db.prepare('SELECT 1 FROM recordings WHERE id = ?').get(r.id), undefined);
    assert.equal(fs.existsSync(r.abs), false, 'the video was left on disk');
    assert.equal(fs.existsSync(r.thumbAbs), false, 'the thumbnail was left on disk');
  });

  test('a caregiver can delete too — one household, one trust level', async () => {
    const r = makeRecording();
    assert.equal((await call(url(`/${r.id}`), { method: 'DELETE', token: caregiverToken })).status, 200);
  });

  test('signed out cannot', async () => {
    const r = makeRecording();
    assert.equal((await call(url(`/${r.id}`), { method: 'DELETE' })).status, 401);
    assert.ok(db.prepare('SELECT 1 FROM recordings WHERE id = ?').get(r.id), 'the row was deleted anyway');
  });

  test('★ an unknown id is a 404 — the route looks the row up rather than reporting success blindly', async () => {
    const res = await call(url('/999999'), { method: 'DELETE', token });
    assert.equal(res.status, 404);
    assert.match(res.body.error, /No recording/);
  });

  test('deleting one leaves the others alone', async () => {
    const a = makeRecording();
    const b = makeRecording();
    await call(url(`/${a.id}`), { method: 'DELETE', token });
    assert.ok(db.prepare('SELECT 1 FROM recordings WHERE id = ?').get(b.id));
    assert.equal(fs.existsSync(b.abs), true);
  });

  test('★ a row pointing outside CLIPS_DIR deletes the ROW but not the file', async () => {
    // Deliberate, and worth pinning in both directions: the row must go (otherwise a tampered row is
    // undeletable), and the file outside the jail must not (otherwise the delete button is an
    // arbitrary-file-removal primitive for anyone who can write to that column).
    const outside = path.join(path.dirname(ABS), 'not-ours.mp4');
    fs.writeFileSync(outside, 'must survive');
    const r = makeRecording({ withFiles: false });
    db.prepare('UPDATE recordings SET path = ?, thumb_path = NULL WHERE id = ?')
      .run(path.join('..', 'not-ours.mp4'), r.id);

    assert.equal(deleteRecording(r.id), true);
    assert.equal(db.prepare('SELECT 1 FROM recordings WHERE id = ?').get(r.id), undefined);
    assert.equal(fs.existsSync(outside), true, 'a delete reached outside CLIPS_DIR');
  });

  test('deleteRecording reports false for an id that is not there', () => {
    assert.equal(deleteRecording(999999), false);
  });
});
