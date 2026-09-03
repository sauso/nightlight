// Stopping a camera must actually stop it — including during the 5s gap between an ffmpeg exit and
// the scheduled relaunch.
//
// transcoder.js, motionDetector.js and soundDetector.js all removed the camera from their map in the
// exit handler and THEN armed a setTimeout to relaunch. `entry.stopped` was the only brake on that
// relaunch and it was reachable only through the map, so inside the gap stop() found nothing, returned
// early, and the relaunch fired anyway. The timer handle was stored nowhere, so nothing could cancel
// it. A camera deleted or disabled mid-restart went on respawning ffmpeg every 5s for the life of the
// container — and because it was absent from the map, isRunning()/isDetecting() reported false
// throughout, so no watchdog or reconcile pass could see it or heal it. See issue #253.
//
// A flapping camera restarts every 5s, so this window is effectively always open for exactly the
// camera an operator would want to stop.
//
// ⚠️ HOW THIS IS OBSERVED, because the obvious way is wrong. The first version of this file polled
// isRunning()/isDetecting() and PASSED WITH THE FIX REMOVED. The fake ffmpeg dies in ~50ms, so a
// relaunched process is alive for a sliver of each 5s cycle and a 500ms poll steps over it — and that
// is the bug's own shape: a zombie is invisible to exactly those functions. Each relaunch does leave
// one durable trace, a "restarting in 5s" line in the logger's ring buffer, so that is counted here.
// Every assertion below is paired with a precondition proving the camera really entered the gap, so a
// test can't pass by never having started.
//
// None of these three modules had any test at all before this file.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, copyFileSync, chmodSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createServer } from 'http';
import { useTempDataDir, cleanupTempDataDirs } from './helpers/harness.js';

useTempDataDir();

// ⚠️ ORDER MATTERS. mediamtx.js reads MEDIAMTX_API at MODULE LOAD, so the fake server has to exist and
// the env var has to be set BEFORE these dynamic imports. Doing this in before() instead left the
// detectors polling the default port 9997 forever: they never spawned, never exited, and their cases
// passed while testing nothing.
const mediamtx = createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url.includes('/v3/paths/get/')) return res.end(JSON.stringify({ ready: true, name: 'x' }));
  if (req.url.includes('/v3/config/paths/get/')) return res.end(JSON.stringify({ source: 'publisher' }));
  res.end('{}');
});
await new Promise((r) => mediamtx.listen(0, '127.0.0.1', r));
process.env.MEDIAMTX_API = `http://127.0.0.1:${mediamtx.address().port}`;

const { logger } = await import('../src/lib/logger.js');
const { startTranscoder, stopTranscoder, stopAllTranscoders, isRunning } = await import('../src/lib/transcoder.js');
const { startMotionDetector, stopMotionDetector } = await import('../src/lib/motionDetector.js');
const { startSoundDetector, stopSoundDetector } = await import('../src/lib/soundDetector.js');

// The modules spawn the bare name `ffmpeg`, so a fake one earlier on PATH is what lets this test drive
// the real restart logic. It must START successfully — an unstartable binary is a different failure,
// that is issue #257 — and then EXIT immediately, which is the flapping camera we care about.
let fakeBinDir;

function installFakeFfmpeg() {
  fakeBinDir = mkdtempSync(join(tmpdir(), 'nl-fakebin-'));
  if (process.platform === 'win32') {
    // CreateProcess searches PATH for .exe only (a .cmd would need a shell), so the fake has to be a
    // real executable. A copy of node handed ffmpeg's arguments rejects the first one during CLI
    // parsing and exits non-zero within milliseconds: starts, then dies, which is what we want.
    copyFileSync(process.execPath, join(fakeBinDir, 'ffmpeg.exe'));
  } else {
    const p = join(fakeBinDir, 'ffmpeg');
    writeFileSync(p, '#!/bin/sh\nexit 1\n');
    chmodSync(p, 0o755);
  }
  process.env.PATH = `${fakeBinDir}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`;
}

// One line per exit-then-relaunch cycle, for this camera's path only, so the three cases can't count
// each other's restarts.
const restartsFor = (path) =>
  logger.getRecent().filter((l) => l.includes(path) && l.includes('restarting in 5s')).length;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The detectors refuse to spawn until MediaMTX reports the path ready (pickReadyPath polls forever),
// so a dead port makes their cases pass VACUOUSLY — no spawn, no exit, no relaunch, and "nothing
// relaunched" holds for the wrong reason. The fake server above is what makes the real cycle run.
before(() => {
  installFakeFfmpeg();
});

after(async () => {
  if (fakeBinDir) rmSync(fakeBinDir, { recursive: true, force: true });
  if (mediamtx) await new Promise((r) => mediamtx.close(r));
  cleanupTempDataDirs();
});

// Long by unit-test standards, and unavoidably so: RESTART_DELAY_MS is 5000, and proving a relaunch
// did NOT happen means outliving the deadline it would have fired at.
const GAP_WAIT_MS = 1800;   // into the 5s window: the first process has exited, the relaunch is armed
const PROVE_MS = 9000;      // well past the 5s deadline, so a missed cancellation shows up

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

describe('stopping a camera inside the restart window', { concurrency: true }, () => {
  test('transcoder: the pending relaunch is cancelled, not left respawning', async () => {
    const CAM = 'cam-restart-1';
    const PATH = 'path_restart_1';
    await startTranscoder(CAM, 'rtsp://192.0.2.10:554/ch0', PATH, 'Restart Cam');

    await sleep(GAP_WAIT_MS);
    // Precondition, not decoration: prove we are actually IN the gap. Without it this test could pass
    // by never having spawned — which is exactly how an earlier version passed with the fix removed.
    assert.ok(restartsFor(PATH) >= 1, 'ffmpeg never exited — the test would prove nothing');
    assert.equal(isRunning(CAM), false, 'expected no live process while mid-restart');

    await stopTranscoder(CAM);
    const before = restartsFor(PATH);
    await sleep(PROVE_MS);
    assert.equal(
      restartsFor(PATH), before,
      `${restartsFor(PATH) - before} relaunch(es) happened in the ${PROVE_MS}ms after stopTranscoder()`
    );
  });

  test('a camera stopped while running stays stopped', async () => {
    // The already-working path, kept as a control: if this ever fails, the case above is passing for
    // the wrong reason (e.g. the fake ffmpeg stopped spawning at all).
    const CAM = 'cam-restart-2';
    await startTranscoder(CAM, 'rtsp://192.0.2.10:554/ch0', 'path_restart_2', 'Restart Cam 2');
    await stopTranscoder(CAM);
    await sleep(7000);
    assert.equal(isRunning(CAM), false);
  });

  test('stopping a camera that was never started is a no-op, not a throw', async () => {
    await stopTranscoder('cam-never-started');
    assert.equal(isRunning('cam-never-started'), false);
  });
});

// The same defect existed in all three modules and the same fix was applied to each. Asserting that
// "the other two are fixed too" is the habit these tests exist to break, so both are driven here.
describe('the same window in the two detectors', { concurrency: true }, () => {
  test('motion: the pending relaunch is cancelled', async () => {
    const cam = camera('cam-motion-1');
    await startMotionDetector(cam);
    await sleep(GAP_WAIT_MS);
    assert.ok(restartsFor(cam.mediamtx_path) >= 1, 'motion detector never exited — nothing is being tested');

    await stopMotionDetector(cam.id);
    const before = restartsFor(cam.mediamtx_path);
    await sleep(PROVE_MS);
    assert.equal(
      restartsFor(cam.mediamtx_path), before,
      `motion detector relaunched ${restartsFor(cam.mediamtx_path) - before} time(s) after stop`
    );
  });

  test('sound: the pending relaunch is cancelled', async () => {
    const cam = camera('cam-sound-1');
    await startSoundDetector(cam);
    await sleep(GAP_WAIT_MS);
    assert.ok(restartsFor(cam.mediamtx_path) >= 1, 'sound detector never exited — nothing is being tested');

    await stopSoundDetector(cam.id);
    const before = restartsFor(cam.mediamtx_path);
    await sleep(PROVE_MS);
    assert.equal(
      restartsFor(cam.mediamtx_path), before,
      `sound detector relaunched ${restartsFor(cam.mediamtx_path) - before} time(s) after stop`
    );
  });
});

// Shutdown and restart-into-the-gap. Both were claims in the PR that no test covered: stopAll* iterates
// the union of the process map and pendingRestarts, and startTranscoder awaits stopTranscoder first,
// so a re-start inside the gap should adopt the pending relaunch rather than race it. Asserting that
// without driving it is the habit these tests exist to break.
describe('shutdown and restart while a relaunch is pending', { concurrency: true }, () => {
  test('stopAllTranscoders disarms a camera sitting in the restart gap', async () => {
    const CAM = 'cam-stopall-1';
    const PATH = 'path_stopall_1';
    await startTranscoder(CAM, 'rtsp://192.0.2.10:554/ch0', PATH, 'StopAll Cam');

    await sleep(GAP_WAIT_MS);
    // In the gap: no live process, so this camera is in pendingRestarts ONLY. Iterating `processes`
    // alone at shutdown would miss it entirely — which is the case this test exists for.
    assert.ok(restartsFor(PATH) >= 1, 'ffmpeg never exited — the test would prove nothing');
    assert.equal(isRunning(CAM), false, 'expected to be mid-restart, absent from `processes`');

    await stopAllTranscoders();
    const before = restartsFor(PATH);
    await sleep(PROVE_MS);
    assert.equal(
      restartsFor(PATH), before,
      `stopAllTranscoders left ${restartsFor(PATH) - before} relaunch(es) armed`
    );
  });

  test('re-starting inside the gap does not leave a second lineage running', async () => {
    // The original comment warns that two lineages publishing to one MediaMTX path kick each other off
    // forever — a real incident, 901 restarts in 2.5 hours. startTranscoder awaits stopTranscoder, which
    // now cancels the pending timer, so the old relaunch must not survive the new start.
    const CAM = 'cam-relaunch-1';
    const PATH = 'path_relaunch_1';
    await startTranscoder(CAM, 'rtsp://192.0.2.10:554/ch0', PATH, 'Relaunch Cam');
    await sleep(GAP_WAIT_MS);
    assert.ok(restartsFor(PATH) >= 1, 'ffmpeg never exited — the test would prove nothing');

    // Start again while the first lineage's relaunch is still armed, then stop for good.
    await startTranscoder(CAM, 'rtsp://192.0.2.10:554/ch0', PATH, 'Relaunch Cam');
    await stopTranscoder(CAM);

    const before = restartsFor(PATH);
    await sleep(PROVE_MS);
    assert.equal(
      restartsFor(PATH), before,
      `a relaunch survived the re-start + stop: ${restartsFor(PATH) - before} extra`
    );
    assert.equal(isRunning(CAM), false);
  });
});
