// A binary that cannot be executed must degrade one camera, not kill the backend.
//
// Node's ChildProcess emits 'error' when the process could not be spawned at all, and an EventEmitter
// that emits 'error' with no listener THROWS. Five spawn sites had no listener — transcoder.js,
// motionDetector.js, soundDetector.js, clipRecorder.js's segmenter and mediamtxProcess.js — so a
// missing or unrunnable ffmpeg took the whole process down. On a baby monitor that is an outage, and
// it converts a diagnosable "ffmpeg not found" into an opaque crash loop. See issue #257.
//
// ⚠️ Node emits 'error' INSTEAD OF 'exit' for a spawn failure, which is the part that makes this more
// than an unhandled-warning fix: the exit handler never runs, so nothing clears the map entry either.
// Without that cleanup the camera stays registered to a process that never existed, isRunning() keeps
// reporting true, and the 5-minute reconcile pass skips it as healthy — permanently dead but invisible.
// Both halves are asserted below.
//
// The trigger is free to reproduce: there is no ffmpeg on a typical dev machine or in CI, so ENOENT is
// simply what happens. This file deliberately does NOT put a fake one on PATH (unlike
// restart-cancellation.test.js, which needs one that starts).
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'http';
import { useTempDataDir, cleanupTempDataDirs } from './helpers/harness.js';

useTempDataDir();

// Same ordering requirement as restart-cancellation.test.js: mediamtx.js reads MEDIAMTX_API at module
// load, and the detectors will not spawn until a path reports ready — with a dead port they would sit
// in pickReadyPath forever and never reach the spawn this file is about.
const mediamtx = createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url.includes('/v3/paths/get/')) return res.end(JSON.stringify({ ready: true, name: 'x' }));
  if (req.url.includes('/v3/config/paths/get/')) return res.end(JSON.stringify({ source: 'publisher' }));
  res.end('{}');
});
await new Promise((r) => mediamtx.listen(0, '127.0.0.1', r));
process.env.MEDIAMTX_API = `http://127.0.0.1:${mediamtx.address().port}`;

const { startTranscoder, stopTranscoder, isRunning } = await import('../src/lib/transcoder.js');
const { startMotionDetector, stopMotionDetector, isDetecting } = await import('../src/lib/motionDetector.js');
const { startSoundDetector, stopSoundDetector, isSoundDetecting } = await import('../src/lib/soundDetector.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fail loudly if anything slips through: without a handler the emitter's throw surfaces here rather
// than as a silent pass. A test that merely "did not crash" would be indistinguishable from one where
// the module never spawned at all, so every case also asserts the cleanup.
const escaped = [];
before(() => {
  process.on('uncaughtException', (e) => escaped.push(e));
  process.on('unhandledRejection', (e) => escaped.push(e));
});

after(async () => {
  await new Promise((r) => mediamtx.close(r));
  cleanupTempDataDirs();
});

const camera = (id) => ({
  id,
  name: `Cam ${id}`,
  mediamtx_path: `path_${id}`,
  sub_rtsp_url: null,
  rtsp_url: 'rtsp://192.0.2.10:554/ch0',
  disabled: 0,
  child_id: 'kid-1',
  detect_motion_enabled: 1,
  detect_sensitivity: 50,
  detect_confirm_s: 3,
  detect_cooldown_s: 60,
  detect_zone: null,
  detect_source: 'framediff',
  detect_sound_enabled: 1,
  sound_sensitivity: 50,
  sound_confirm_s: 4,
  sound_cooldown_s: 120,
});

describe('ffmpeg cannot be spawned', () => {
  test('the transcoder survives it and releases the camera', async () => {
    const CAM = 'cam-enoent-1';
    await startTranscoder(CAM, 'rtsp://192.0.2.10:554/ch0', 'path_enoent_1', 'ENOENT Cam');
    await sleep(500);

    assert.deepEqual(escaped, [], `a spawn failure escaped: ${escaped[0]?.message}`);
    // The half that matters for recovery: reconcile only restarts a camera whose transcoder is NOT
    // running, so a leg left claimed by a process that never existed would never be retried.
    assert.equal(isRunning(CAM), false, 'camera still registered after a failed spawn — reconcile will skip it');
    await stopTranscoder(CAM);
  });

  test('the motion detector survives it and releases the camera', async () => {
    const cam = camera('cam-enoent-2');
    await startMotionDetector(cam);
    await sleep(700);

    assert.deepEqual(escaped, [], `a spawn failure escaped: ${escaped[0]?.message}`);
    assert.equal(isDetecting(cam.id), false, 'detector still registered after a failed spawn');
    await stopMotionDetector(cam.id);
  });

  test('the sound detector survives it and releases the camera', async () => {
    const cam = camera('cam-enoent-3');
    await startSoundDetector(cam);
    await sleep(700);

    assert.deepEqual(escaped, [], `a spawn failure escaped: ${escaped[0]?.message}`);
    assert.equal(isSoundDetecting(cam.id), false, 'sound detector still registered after a failed spawn');
    await stopSoundDetector(cam.id);
  });

  test('a failed spawn does not wedge a later start', async () => {
    // The point of releasing the entry: once the binary is available again, an ordinary start works.
    // Nothing here can make ffmpeg appear, so this asserts the weaker half — that a second start is
    // accepted and still leaves the leg unclaimed, rather than throwing or being refused because the
    // camera is still recorded as running.
    const CAM = 'cam-enoent-4';
    await startTranscoder(CAM, 'rtsp://192.0.2.10:554/ch0', 'path_enoent_4', 'ENOENT Cam 4');
    await sleep(400);
    await startTranscoder(CAM, 'rtsp://192.0.2.10:554/ch0', 'path_enoent_4', 'ENOENT Cam 4');
    await sleep(400);

    assert.deepEqual(escaped, [], `a spawn failure escaped: ${escaped[0]?.message}`);
    assert.equal(isRunning(CAM), false);
    await stopTranscoder(CAM);
  });
});
