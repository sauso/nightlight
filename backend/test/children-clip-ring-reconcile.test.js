// The route-level wiring that arms/disarms a WAKE-ONLY clip ring immediately, rather than waiting up
// to 5 minutes for the periodic reconcile (issue #387, the 2026-09-11 Codex review's R3).
//
// clipRing.test.js pins the PREDICATE (clipRingWanted now accounts for wake clips) and
// clip-capture.test.js pins that startClipCapture/stopClipCapture actually produce a real segmenter
// for that predicate. Neither exercises the two ROUTE call sites this file is for:
//   * PUT /api/children/:id — reconcileChildLegs, when "Track sleep" changes.
//   * PUT /api/settings — the wakeClipsChanged re-arm, when the global wake-clip switch changes.
// A regression here looks exactly like children-route.test.js's own documented gap: nothing crashes,
// nothing errors, the setting just silently doesn't take effect until the next reconcile (or, before
// this fix existed at all, never).
//
// ⚠️ PATH IS EMPTIED BEFORE ANY IMPORT, same reasoning as clip-capture.test.js: startClipCapture spawns
// real ffmpeg on a machine that has one. Emptying PATH makes the spawn fail identically everywhere.
//
// ⚠️ WHY "STARTED" IS CHECKED VIA THE RING DIRECTORY, NOT isSegmenterRunning, BUT "STOPPED" IS CHECKED
// VIA isSegmenterRunning. Asymmetric on purpose:
//   * stopSegmenter deletes the live-process map entry SYNCHRONOUSLY and never touches the ring
//     directory on disk — so after an awaited stop, isSegmenterRunning===false is exact, and checking
//     the directory would be wrong (it deliberately survives a stop, ready for the next start).
//   * startSegmenter writes the map entry SYNCHRONOUSLY too, but the spawn's ENOENT failure clears it
//     back out ASYNCHRONOUSLY — and a real HTTP round trip through mountRouter's server is enough real
//     event-loop time for that async teardown to win the race. The first version of this file asserted
//     isSegmenterRunning after every `await put...(...)` and failed 4 of 6 tests against CORRECT code,
//     for exactly that reason. `fs.mkdirSync(ringDir, ...)`, by contrast, runs synchronously inside
//     startSegmenter before the spawn even happens and is never undone by a failed spawn — so its
//     presence (or a marker file surviving inside it) is a reliable, non-racy proof that startSegmenter
//     ran, matching the technique clip-capture.test.js already uses ("starting twice does not restart
//     it", "restart really restarts").
import { test, before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, makeChild, makeCamera, signToken,
  mountRouter, call,
} from './helpers/harness.js';

const emptyBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightlight-nobin-'));
process.env.PATH = emptyBinDir;

useTempDataDir();

const { default: db } = await import('../src/db.js');
const { default: childrenRouter, reconcileChildLegs } = await import('../src/routes/children.js');
const { default: settingsRouter } = await import('../src/routes/settings.js');
const { CLIPS_DIR, isSegmenterRunning } = await import('../src/lib/clipRecorder.js');
const { checkClipStorage } = await import('../src/lib/clipStorage.js');
const { startClipCapture, stopAllClipCapture } = await import('../src/lib/clipCapture.js');

const MOUNTED = `/dev/sda1 / ext4 rw 0 0\n/dev/sdb1 ${path.resolve(CLIPS_DIR)} xfs rw 0 0\n`;

let childrenServer, settingsServer, token;
const KID = 'kid-1';

const putChild = (body) => call(`${childrenServer.url}/api/children/${KID}`, { method: 'PUT', token, body });
const putSettings = (body) => call(`${settingsServer.url}/api/settings`, { method: 'PUT', token, body });
const camRow = () => db.prepare('SELECT * FROM cameras WHERE id = ?').get('cam-1');
const ringDir = () => path.join(CLIPS_DIR, '.ring', 'cam-1');
const markerPath = () => path.join(ringDir(), 'marker.mkv');
const plantMarker = () => fs.writeFileSync(markerPath(), 'x');

before(async () => {
  fs.mkdirSync(CLIPS_DIR, { recursive: true });
  const st = checkClipStorage({ mounts: MOUNTED });
  assert.equal(st.ok, true, `clip storage did not come up ready (${st.reason}) — every test here would be vacuous`);
  childrenServer = await mountRouter('/api/children', childrenRouter);
  settingsServer = await mountRouter('/api/settings', settingsRouter);
  const admin = makeUser(db, { id: 'u-a', username: 'admin', role: 'admin' });
  token = signToken({ id: admin.id, sub: admin.id, username: admin.username, role: 'admin', sid: makeSession(db, admin.id) });
});

after(async () => {
  stopAllClipCapture();
  await childrenServer.close();
  await settingsServer.close();
  db.close();
  cleanupTempDataDirs();
  try { fs.rmSync(emptyBinDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

beforeEach(() => {
  stopAllClipCapture();
  fs.rmSync(path.join(CLIPS_DIR, '.ring'), { recursive: true, force: true }); // clean slate for the dir-existence checks
  db.prepare('DELETE FROM children').run();
  db.prepare('DELETE FROM cameras').run();
  db.prepare(
    'UPDATE settings SET ondemand_enabled = 0, wake_clips_enabled = 1 WHERE id = ?'
  ).run('app'); // isolate wake clips as the ONLY reason a camera in this file could want a ring
  makeChild(db, { id: KID, track: 1 });
  makeCamera(db, { id: 'cam-1', name: 'Nursery', childId: KID });
});

describe('★ children.js: reconcileChildLegs arms/disarms the wake-only ring immediately', () => {
  test('turning "Track sleep" ON starts the ring right away, without a separate reconcile tick', async () => {
    db.prepare('UPDATE children SET track_sleep = 0 WHERE id = ?').run(KID);
    assert.equal(fs.existsSync(ringDir()), false, 'precondition: no ring directory — nothing should be buffering');
    const res = await putChild({ track_sleep: true });
    assert.equal(res.status, 200);
    assert.equal(fs.existsSync(ringDir()), true, 'PUT track_sleep:true did not start a segmenter for the wake-only camera');
  });

  // ⚠️ Called DIRECTLY, not through the route: the ON-direction test above already proves the route
  // reaches reconcileChildLegs at all (nothing else in the handler could have started a segmenter for
  // this camera), and both directions share that one call site — `if (newTrack !== existing.track_sleep
  // ...) reconcileChildLegs(...)`. What a real HTTP round trip CANNOT prove is the STOP direction: see
  // the file header — isSegmenterRunning dies on its own within ~10-20ms of the empty-PATH spawn
  // failure, faster than the round trip itself, so an awaited PUT reads false whether or not this
  // function's stop branch ever ran. A same-tick call is the only way to discriminate it.
  test('reconcileChildLegs stops an already-running wake-only ring once "Track sleep" is off', () => {
    startClipCapture(camRow()); // seed the running state as if it had started while tracking was still on (fixture default: track_sleep=1)
    assert.equal(isSegmenterRunning('cam-1'), true, 'precondition: the wake-only ring is running');
    db.prepare('UPDATE children SET track_sleep = 0 WHERE id = ?').run(KID); // now flip it off, same as a PUT would
    reconcileChildLegs(KID);
    assert.equal(isSegmenterRunning('cam-1'), false, 'reconcileChildLegs left the segmenter running for a non-tracked child');
  });

  test('a change unrelated to tracking/window does not restart (and so does not wipe) the ring', async () => {
    startClipCapture(camRow());
    plantMarker(); // startSegmenter empties the ring dir on every (re)start — this proves whether one happened
    assert.equal(fs.existsSync(markerPath()), true, 'precondition: the marker is there to begin with');
    const res = await putChild({ name: 'Renamed', track_sleep: true }); // track_sleep unchanged: 1 -> 1
    assert.equal(res.status, 200);
    assert.equal(fs.existsSync(markerPath()), true, 'an unrelated field change restarted (and wiped) the ring');
  });
});

describe('★ settings.js: the global wake-clip switch re-arms every camera immediately', () => {
  test('turning wake clips ON starts an eligible camera\'s ring right away', async () => {
    db.prepare('UPDATE settings SET wake_clips_enabled = 0 WHERE id = ?').run('app');
    assert.equal(fs.existsSync(ringDir()), false, 'precondition: wake clips are off globally, nothing buffering');
    const res = await putSettings({ wake_clips_enabled: true });
    assert.equal(res.status, 200);
    assert.equal(fs.existsSync(ringDir()), true, 'PUT wake_clips_enabled:true did not re-arm the ring');
  });

  // The STOP direction for THIS route is not provable through a real HTTP call either, for the same
  // isSegmenterRunning-dies-first reason documented at the top of this file — and unlike children.js's
  // reconcileChildLegs, this route's re-arm loop has no separate function to call directly; it just
  // calls the already-exported restartClipCapture, which clip-capture.test.js's "restarting a camera
  // that no longer wants the ring leaves it stopped" test already exercises synchronously. The wake-
  // clips-specific case (a camera whose ONLY reason to buffer was wake clips) is added there alongside
  // it, rather than duplicated here against a route that cannot reliably prove it.

  test('a settings save that does not touch wake clips does not restart (and so does not wipe) the ring', async () => {
    startClipCapture(camRow());
    plantMarker();
    assert.equal(fs.existsSync(markerPath()), true, 'precondition: the marker is there to begin with');
    const res = await putSettings({ app_name: 'Casa' });
    assert.equal(res.status, 200);
    assert.equal(fs.existsSync(markerPath()), true, 'an unrelated settings save restarted (and wiped) the ring');
  });
});
