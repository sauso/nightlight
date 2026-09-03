// A binary that cannot be executed must degrade one camera, not kill the backend.
//
// Node's ChildProcess emits 'error' when the process could not be spawned at all, and an EventEmitter
// that emits 'error' with no listener THROWS. Five spawn sites had no listener — transcoder.js,
// motionDetector.js, soundDetector.js, clipRecorder.js's segmenter and mediamtxProcess.js — so a
// missing or unrunnable ffmpeg took the whole process down. On a baby monitor that is an outage, and
// it converts a diagnosable "ffmpeg not found" into an opaque crash loop. See issue #257.
//
// ⚠️ Node emits 'error' INSTEAD OF 'exit' for a spawn failure, which is the part that makes this more
// than an unhandled-warning fix: the exit handler never runs, so nothing clears the module's map entry
// either. Without that cleanup the camera stays registered to a process that never existed, the
// module's own "is this covered?" predicate keeps reporting true, and the 5-minute reconcile pass skips
// it as healthy — permanently dead but invisible. Both halves are asserted below.
//
// ⚠️⚠️ HOW THE FAILURE IS TRIGGERED, and why it is NOT "there is no ffmpeg here".
// The first version of this file relied on ffmpeg being absent from PATH on a dev machine and in CI.
// An adversarial review broke that: with a fake ffmpeg on PATH that exits immediately, all four cases
// still passed while the new handler ran ZERO times — green for the wrong reason, via the ordinary exit
// path. With a fake that stays alive (what a real ffmpeg does while it blocks connecting to an
// unroutable address) all four FAILED. The runtime image HAS ffmpeg, so does the e2e image, and so does
// any machine belonging to someone who works with video. That is the house rule about not building for
// one machine, applied to a test.
// So the trigger is made deterministic instead: PATH is replaced with an empty directory before the
// modules load, which makes resolution of "ffmpeg" fail with ENOENT no matter what is installed. And
// every case additionally asserts a PRECONDITION — that the handler under test actually logged — so
// this can never again pass because the code path was skipped.
import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'http';
import { useTempDataDir, cleanupTempDataDirs } from './helpers/harness.js';

useTempDataDir();

// An empty directory as the entire PATH: nothing resolves, so every spawn in this file fails with
// ENOENT regardless of what the host has installed. Node reads PATH at spawn time, and `node --test`
// runs each test FILE in its own process, so this cannot leak into another suite.
const emptyBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightlight-nobin-'));
process.env.PATH = emptyBinDir;

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

const { logger } = await import('../src/lib/logger.js');
const { startTranscoder, stopTranscoder, isRunning } = await import('../src/lib/transcoder.js');
const { startMotionDetector, stopMotionDetector, isDetecting } = await import('../src/lib/motionDetector.js');
const { startSoundDetector, stopSoundDetector, isSoundDetecting } = await import('../src/lib/soundDetector.js');
const { startSegmenter, stopSegmenter, isSegmenterRunning } = await import('../src/lib/clipRecorder.js');
const { startMediaMTX, stopMediaMTX } = await import('../src/lib/mediamtxProcess.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The precondition. Counting the handler's own log line is the only observable that distinguishes "the
// handler ran and coped" from "the spawn never happened", and it is the same technique
// restart-cancellation.test.js uses for the same reason.
const logged = (needle) => logger.getRecent().filter((l) => l.includes(needle)).length;

// Fail loudly if anything slips through: without a handler the emitter's throw surfaces here rather
// than as a silent pass.
const escaped = [];
before(() => {
  process.on('uncaughtException', (e) => escaped.push(e));
  process.on('unhandledRejection', (e) => escaped.push(e));
});

// Per-case isolation. `escaped` and the log ring are process-wide, so without this a single broken leg
// reddened every later case with the FIRST case's error message — review of PR #274 hit exactly that
// while mutation-testing, and the misattributed message cost real time.
beforeEach(() => {
  escaped.length = 0;
  logger.clear();
});

after(async () => {
  await new Promise((r) => mediamtx.close(r));
  cleanupTempDataDirs();
  try { fs.rmSync(emptyBinDir, { recursive: true, force: true }); } catch { /* best effort */ }
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
    assert.equal(logged('[ffmpeg:path_enoent_1] could not start ffmpeg'), 1, 'the spawn-failure handler never ran — this case would pass vacuously');
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
    assert.equal(logged('could not start ffmpeg'), 1, 'the spawn-failure handler never ran — this case would pass vacuously');
    assert.equal(isDetecting(cam.id), false, 'detector still registered after a failed spawn');
    await stopMotionDetector(cam.id);
  });

  test('the sound detector survives it and releases the camera', async () => {
    const cam = camera('cam-enoent-3');
    await startSoundDetector(cam);
    await sleep(700);

    assert.deepEqual(escaped, [], `a spawn failure escaped: ${escaped[0]?.message}`);
    assert.equal(logged('could not start ffmpeg'), 1, 'the spawn-failure handler never ran — this case would pass vacuously');
    assert.equal(isSoundDetecting(cam.id), false, 'sound detector still registered after a failed spawn');
    await stopSoundDetector(cam.id);
  });

  test('the clip segmenter survives it and DEREGISTERS the camera', async () => {
    // Not a copy of the cases above: this one pins a defect the first version of the fix actually had.
    // The segmenter's handler nulled `entry.proc` and left the map entry in place — but every predicate
    // in clipRecorder is `segmenters.has(cameraId)` and none of them reads `entry.proc`. So the camera
    // read as covered forever: startClipCapture's guard skipped it, holdRing() returned true, and an
    // on-demand Record passed its gate and wrote a recordings row that could only fail ~20s later
    // inside extractClip. isSegmenterRunning() is therefore the assertion that matters here.
    const CAM = 'cam-enoent-clip';
    startSegmenter(CAM, 'path_enoent_clip', { preRollSec: 5, postRollSec: 5 });
    await sleep(500);

    assert.deepEqual(escaped, [], `a spawn failure escaped: ${escaped[0]?.message}`);
    assert.equal(logged('[clipseg:path_enoent_clip] could not start ffmpeg'), 1, 'the spawn-failure handler never ran — this case would pass vacuously');
    assert.equal(
      isSegmenterRunning(CAM),
      false,
      'segmenter still registered after a failed spawn — startClipCapture will skip it forever and holdRing() will lie to the recorder'
    );
    stopSegmenter(CAM); // must be a safe no-op once the entry is gone
  });

  test('a failed spawn does not wedge a later start', async () => {
    // The point of releasing the entry: once the binary is available again, an ordinary start works.
    // Nothing here can make ffmpeg appear, so this asserts the weaker half — that a second start is
    // accepted, reaches the spawn again (hence TWO handler log lines, not one) and still leaves the leg
    // unclaimed, rather than throwing or being refused because the camera is still recorded as running.
    const CAM = 'cam-enoent-4';
    await startTranscoder(CAM, 'rtsp://192.0.2.10:554/ch0', 'path_enoent_4', 'ENOENT Cam 4');
    await sleep(400);
    await startTranscoder(CAM, 'rtsp://192.0.2.10:554/ch0', 'path_enoent_4', 'ENOENT Cam 4');
    await sleep(400);

    assert.deepEqual(escaped, [], `a spawn failure escaped: ${escaped[0]?.message}`);
    assert.equal(logged('[ffmpeg:path_enoent_4] could not start ffmpeg'), 2, 'the second start did not reach the spawn — the leg was still claimed');
    assert.equal(isRunning(CAM), false);
    await stopTranscoder(CAM);
  });
});

describe('the mediamtx binary cannot be spawned', () => {
  // MediaMTX is the deliberate exception to the no-relaunch rule above: there is no reconcile pass for
  // it, so nothing else would ever bring it back and its handler DOES keep retrying every 3s. That
  // makes the flood the thing worth pinning — 1 line per 3s is ~1200/hour into logger.js's 1000-line
  // ring, which would evict every other line (including the per-camera ffmpeg failures that diagnose
  // the very same broken image) inside an hour.
  test('it survives, says so once, and does not flood the log ring', async () => {
    await startMediaMTX(path.join(emptyBinDir, 'mediamtx.yml'));
    await sleep(300);

    assert.deepEqual(escaped, [], `a spawn failure escaped: ${escaped[0]?.message}`);
    assert.equal(logged('[mediamtx] could not start'), 1, 'the spawn-failure handler never ran — this case would pass vacuously');

    // Past two retry intervals (3s each): still exactly one line. Rate limiting is the assertion.
    await sleep(7000);
    assert.equal(logged('[mediamtx] could not start'), 1, 'the retry loop is flooding the log ring');
    assert.deepEqual(escaped, [], `a retry crashed: ${escaped[0]?.message}`);

    // stopMediaMTX kills a process that never spawned — on win32 that throws EINVAL, so this line is
    // itself a regression test for the guard added to it.
    // ⚠️ What the next two lines do NOT prove: that stopMediaMTX() actually stops the retry loop.
    // Both `!stopped` guards can be deleted and this case stays green — verified, they are surviving
    // mutants. The reason is this fix's own doing: rate limiting means a relaunch after the first
    // failure logs NOTHING, so a relaunch and a correctly-suppressed relaunch are indistinguishable
    // from outside the module. Making them distinguishable would mean exporting a spawn counter purely
    // for the test, and a production seam that exists only for a test is not worth it here. Recorded as
    // a known gap in the PR rather than papered over with an assertion that reads like proof.
    stopMediaMTX();
    await sleep(3500);
    assert.equal(logged('[mediamtx] could not start'), 1, 'still exactly one line after a further retry interval');
  });

  // MUST run after the case above: stopMediaMTX() latches the module-level `stopped` flag, which would
  // otherwise suppress the retries that case asserts on.
  test('stopping inside the pre-error window does not throw', async (t) => {
    // The narrow window this pins: spawn() returns synchronously, but 'error' is emitted on a LATER
    // tick, and until then the child still holds a libuv handle with no OS process behind it. kill()
    // on that combination throws EINVAL on win32 — uncaught, during shutdown, which is exactly the
    // crash class this PR exists to remove. Once 'error' has fired the handle is nulled and kill() just
    // returns false, so a test that waits (as the case above does) CANNOT see this: removing the guard
    // leaves that one green. Verified by mutation — this case is the only thing that kills it.
    //
    // Staying in the window means NOT awaiting startMediaMTX: its network-wait loop only yields when
    // there is no routable IPv4 yet, so with one present launch() runs synchronously and stop lands in
    // the same tick as the spawn. Without one, the un-awaited call has not spawned yet and the case
    // would silently prove nothing — so skip it there rather than pass for the wrong reason.
    const routable = Object.values(os.networkInterfaces())
      .flatMap((l) => l || [])
      .some((a) => a.family === 'IPv4' && !a.internal);
    if (!routable) return t.skip('no routable IPv4 — cannot enter the pre-error window deterministically');

    startMediaMTX(path.join(emptyBinDir, 'mediamtx-window.yml')); // deliberately NOT awaited
    stopMediaMTX(); // throws EINVAL here without the guard, failing this test
    await sleep(200);
    assert.deepEqual(escaped, [], `stopping in the spawn window escaped: ${escaped[0]?.message}`);
  });
});
