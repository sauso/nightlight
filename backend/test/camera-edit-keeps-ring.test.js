// #490: saving a camera (`PUT /api/cameras/:id`, a rename included) used to STOP and RESTART its clip ring
// (routes/cameras.js: stopClipCapture then startClipCapture). stopSegmenter clears every ring hold and
// startSegmenter deletes every .mkv in the ring, so renaming a camera lost an on-demand recording in progress, a
// detection clip's post-roll, a wake clip being cut, and the pre-roll every later clip draws on. The PUT now
// reconciles the ring instead (clipCapture.reconcileClipRing): resized in place while it is still wanted, started
// if it is wanted and not running, and, when the save makes it unwanted, stopped only once nothing holds it.
//
// ⚠️ WHY THE FIXTURE LOOKS LIKE THIS (plan review, Codex, 2026-10-19). The obvious model,
// camera-delete-cooldown-maps.test.js, uses DISABLED cameras and never makes clip storage ready: the PUT then skips
// the ring block entirely and startClipCapture refuses to start, so a copy of it passes on the old code for the
// wrong reason. Here the camera is ENABLED and wants the ring, storage is made ready (the platform-independent
// mounts fixture from clip-capture.test.js), and spawn is a FakeFfmpeg that stays alive across the awaited
// request (with PATH emptied instead, the entry deletes itself within ~5 ms and nothing would be running by the
// time the PUT arrives). The segmenter is asserted running BEFORE the PUT. "Still running" after it is not enough
// on its own: the old code stops the entry and starts a new one straight away, so `isSegmenterRunning` says true
// either way; the test also counts segmenter spawns.
//
// NOT covered here: a real ffmpeg writing real segments (the .mkv is planted), an address change (it restarts the
// transcoder, not the ring; the segmenter's own exit handler relaunches it without deleting segments), and a
// stalled segmenter that the old restart happened to heal (nothing designed that, and the 5-minute reconcile never
// did it either; stated in the PR).
import { test, mock, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import {
  useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, makeCamera, makeChild, signToken, mountRouter, call,
} from './helpers/harness.js';
import { FakeFfmpeg } from './helpers/fakeFfmpeg.js';

useTempDataDir();
// Every process the code under test starts, in order. Mocked before ANY import that can spawn (the router imports
// clipRecorder), and `node:child_process` only: it is not in test:core's coverage include list (fakeFfmpeg.js).
const spawned = [];
mock.module('node:child_process', {
  exports: {
    spawn(command, args) {
      const proc = new FakeFfmpeg(command, args);
      spawned.push(proc);
      if (command === 'ffprobe') proc.finish(1);
      return proc;
    },
  },
});
const mediamtx = createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end('{}'); });
await new Promise((r) => mediamtx.listen(0, '127.0.0.1', r));
process.env.MEDIAMTX_API = `http://127.0.0.1:${mediamtx.address().port}`;

const { default: db } = await import('../src/db.js');
const { default: camerasRouter } = await import('../src/routes/cameras.js');
const { isSegmenterRunning, holdRing, CLIPS_DIR } = await import('../src/lib/clipRecorder.js');
const { checkClipStorage } = await import('../src/lib/clipStorage.js');
const { holdOwners, ondemandHoldOwner, clipHoldOwner } = await import('../src/lib/ringHolds.js');
const { startClipCapture, stopAllClipCapture } = await import('../src/lib/clipCapture.js');

const CAM = 'cam-490';
const CHILD = 'child-490';
const RING_DIR = path.join(CLIPS_DIR, '.ring', CAM);
// clipRecorder.segmenterArgs is the only spawn here with `-f segment`; the sub-stream and detector legs are off.
const segmenterSpawns = () => spawned.filter((p) => p.args.includes('segment')).length;

// Same reasoning as clip-capture.test.js: a /proc/mounts that maps CLIPS_DIR as its own mountpoint, supplied rather
// than read, because Windows has none and on a Linux runner a temp directory sits under "/".
const MOUNTED = `/dev/sda1 / ext4 rw 0 0\n/dev/sdb1 ${path.resolve(CLIPS_DIR)} xfs rw 0 0\n`;

let server;
let token;

before(async () => {
  fs.mkdirSync(CLIPS_DIR, { recursive: true });
  // ⚠️ REQUIRED: startClipCapture returns early unless storage is ready, and its status starts as "not checked".
  const st = checkClipStorage({ mounts: MOUNTED });
  assert.equal(st.ok, true, `clip storage did not come up ready (${st.reason}): every test here would be vacuous`);
  server = await mountRouter('/api/cameras', camerasRouter);
  const admin = makeUser(db, { id: 'u-admin', username: 'admin', role: 'admin' });
  token = signToken({ sub: admin.id, role: 'admin', sid: makeSession(db, admin.id) });
  makeChild(db, { id: CHILD, name: 'A child', track: 1 });
});

after(async () => {
  stopAllClipCapture();
  await server?.close();
  await new Promise((r) => mediamtx.close(r));
  db.close();
  cleanupTempDataDirs();
});

beforeEach(() => {
  stopAllClipCapture(); // kills the fake segmenter and clears its holds
  spawned.length = 0;
  db.prepare('DELETE FROM cameras WHERE id = ?').run(CAM);
  db.prepare("UPDATE settings SET ondemand_enabled = 1, wake_clips_enabled = 1 WHERE id = 'app'").run();
});

// An ENABLED camera with motion, sound and the sub-stream off, so the ring is the only process the PUT can touch.
function enabledCamera(extra = {}, childId = null) {
  makeCamera(db, {
    id: CAM, name: 'Before', childId,
    extra: { disabled: 0, detect_motion_enabled: 0, detect_sound_enabled: 0, ...extra },
  });
  return db.prepare('SELECT * FROM cameras WHERE id = ?').get(CAM);
}

// A closed ring segment, as the segmenter would have written it a moment ago.
function plantSegment() {
  fs.mkdirSync(RING_DIR, { recursive: true });
  const p = path.join(RING_DIR, 'seg-20261019-010203.mkv');
  fs.writeFileSync(p, 'footage');
  return p;
}

function startRing(camera) {
  startClipCapture(camera);
  assert.equal(isSegmenterRunning(CAM), true, 'precondition: the ring is running before the PUT');
  assert.equal(segmenterSpawns(), 1, 'precondition: exactly one segmenter process so far');
}

const put = (body) => call(`${server.url}/api/cameras/${CAM}`, { method: 'PUT', token, body });

describe('#490: saving a camera no longer restarts its clip ring', { concurrency: false }, () => {
  test('a rename keeps the running ring: its holds, its footage and the same process (fails on the old stop-and-restart)', async () => {
    startRing(enabledCamera({ detect_record_clips: 1 }));
    // Hostile: two owners of different kinds, as an on-demand recording and a detection clip in flight hold them.
    holdRing(CAM, ondemandHoldOwner(901), Date.now() - 30_000);
    holdRing(CAM, clipHoldOwner(902), Date.now() - 10_000);
    const seg = plantSegment();

    const res = await put({ name: 'After' });

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.name, 'After', 'precondition: the rename was saved');
    assert.deepEqual(holdOwners(CAM), [ondemandHoldOwner(901), clipHoldOwner(902)], 'the rename dropped the ring holds of captures in flight');
    assert.equal(fs.existsSync(seg), true, 'the rename deleted the ring\'s footage');
    assert.equal(segmenterSpawns(), 1, 'the rename restarted the segmenter');
    assert.equal(isSegmenterRunning(CAM), true);
  });

  test('a save of a camera that wants the ring but is not buffering starts it (the documented "re-saving the camera brings it back")', async () => {
    enabledCamera({ detect_record_clips: 1 });
    assert.equal(isSegmenterRunning(CAM), false, 'precondition: nothing running yet');

    const res = await put({ name: 'After' });

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(isSegmenterRunning(CAM), true, 'the save did not start the ring the camera wants');
    assert.equal(segmenterSpawns(), 1);
  });

  describe('a save that makes the ring unwanted (the camera is unassigned from its sleep-tracked child)', () => {
    // On-demand Record and detection clips off, so the ring is wanted only for the child's wake clips.
    function wakeOnlyRing() {
      db.prepare("UPDATE settings SET ondemand_enabled = 0 WHERE id = 'app'").run();
      startRing(enabledCamera({ detect_record_clips: 0 }, CHILD));
    }

    test('keeps the ring running while a capture still holds it, holds untouched (the stop is deferred)', async () => {
      wakeOnlyRing();
      holdRing(CAM, clipHoldOwner(903), Date.now() - 10_000);
      const seg = plantSegment();

      const res = await put({ child_id: null });

      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.child_id ?? null, null, 'precondition: the camera was unassigned');
      assert.equal(isSegmenterRunning(CAM), true, 'a held ring was stopped out from under its capture');
      assert.deepEqual(holdOwners(CAM), [clipHoldOwner(903)]);
      assert.equal(fs.existsSync(seg), true);
      assert.equal(segmenterSpawns(), 1);
    });

    test('stops the ring when nothing holds it (control)', async () => {
      wakeOnlyRing();

      const res = await put({ child_id: null });

      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(isSegmenterRunning(CAM), false, 'an unwanted, unheld ring kept running');
      assert.equal(segmenterSpawns(), 1, 'and it was not started again');
    });
  });
});
