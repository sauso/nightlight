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
const PROVE_MS = 9000;      // well past the 5s deadline, so a missed cancellation shows up
// Backstop for enterRestartGap, NOT a deadline being asserted. It costs nothing on a passing run
// (the poll returns the moment the exit is seen) and it cannot mask a regression: the thing it guards
// is a PRECONDITION — "the fake ffmpeg really spawned and died" — so a genuinely broken spawn still
// fails the test, just later. Deliberately generous because the fake ffmpeg on Windows is a COPY OF
// NODE, and spawning those is expensive under contention: at `--test-concurrency=32` on a 6-core box,
// 10s was not always enough and this case timed out in 3 runs out of 10.
const GAP_CAP_MS = 30_000;

// ⚠️ GETTING INTO THE GAP IS POLLED; PROVING NOTHING HAPPENS IS STILL A REAL WAIT. The two are not the
// same kind of thing and only one of them was ever a timing assertion (issue #278).
//
// Every case here began `await sleep(1800)` and then asserted the precondition
// `restartsFor(path) >= 1` — "the fake ffmpeg really exited, so we are genuinely mid-restart". That is
// a POSITIVE condition, and 1800ms was a guess about how fast the machine could spawn and reap a
// process. Under CI contention (2 cores, ~32 test files running concurrently) it wasn't enough, and the
// suite went red on a commit that changed nothing — twice, on #277 and #280, with
// "ffmpeg never exited — the test would prove nothing" as the failure. Reproduced locally at
// `--test-concurrency=32`.
//
// ★ Waiting for the exit instead of guessing at it is STRICTLY STRONGER: the old code hoped the
// precondition had come true, this proves it before continuing. The cap is generous because it is a
// backstop for a genuinely broken spawn, not a deadline being asserted.
//
// ⚠️ PROVE_MS IS NOT TOUCHED, deliberately. Proving a relaunch did NOT happen means outliving the 5s
// deadline it would have fired at, so that one has to be a real elapsed wait. Shortening it — the
// obvious way to make this file faster — would silently stop it catching the bug it exists for.
async function enterRestartGap(path, capMs = GAP_CAP_MS) {
  const deadline = Date.now() + capMs;
  while (Date.now() < deadline) {
    if (restartsFor(path) >= 1) return;
    await sleep(25);
  }
  assert.fail(`ffmpeg never exited within ${capMs}ms — the test would prove nothing`);
}

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

    // Precondition, not decoration: prove we are actually IN the gap. Without it this test could pass
    // by never having spawned — which is exactly how an earlier version passed with the fix removed.
    await enterRestartGap(PATH);
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
    await enterRestartGap(cam.mediamtx_path);

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
    await enterRestartGap(cam.mediamtx_path);

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
// ⚠️ SERIAL, and this one MUST NOT be made concurrent again (issue #278). `stopAllTranscoders()` in
// the first case stops EVERY transcoder in the module, including `cam-relaunch-1` belonging to the
// case below it. Run concurrently, the global stop can land while the sibling is still waiting for its
// first ffmpeg exit — which then never arrives, because its transcoder was stopped and its pending
// relaunch cancelled by the other test.
//
// ★ This is the finding that corrected my own diagnosis. I assumed CI load was STARVING these cases
// and that waiting longer would fix it; raising the wait from 10s to 30s changed nothing — same case,
// same failure, 4 runs in 10 — which is what proved it was not a timing problem at all. Load only
// shifts the interleaving that exposes it. A wait cannot fix a test that another test has sabotaged.
describe('shutdown and restart while a relaunch is pending', { concurrency: false }, () => {
  test('stopAllTranscoders disarms a camera sitting in the restart gap', async () => {
    const CAM = 'cam-stopall-1';
    const PATH = 'path_stopall_1';
    await startTranscoder(CAM, 'rtsp://192.0.2.10:554/ch0', PATH, 'StopAll Cam');

    // In the gap: no live process, so this camera is in pendingRestarts ONLY. Iterating `processes`
    // alone at shutdown would miss it entirely — which is the case this test exists for.
    await enterRestartGap(PATH);
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
    await enterRestartGap(PATH);

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
