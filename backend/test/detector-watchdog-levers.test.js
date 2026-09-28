// #369, the DETECTOR side: the freshness stamps, the health getters and the restart levers of the REAL motion
// and sound detectors, driven against a fake ffmpeg. The watchdog that reads them is tested through its real
// logic in detector-watchdog.test.js; this file proves the detectors give it what it assumes:
//   C4   a silent room still delivers bytes, so it reads as fresh;
//   C13  a watchdog kill leaves exactly ONE lineage, lands only on the process that was judged, never on a young
//        one, and a process that ignores SIGTERM is SIGKILLed 3 s later (one that obeys is signalled once);
//   C14  a watchdog kill is never a sound "no microphone" strike, even across a backward WALL-clock step, while
//        an ordinary quick crash still is one;
//   C15  stop* inside the 5 s relaunch gap after a watchdog kill cancels the relaunch, and the kill is logged at
//        INFO with the "restarting in 5s" phrase restart-cancellation.test.js counts;
//   C17  the stamp comes from performance.now() on each stdout 'data' event (not stderr, not the observation
//        clock's receipt), and only the leg's INPUT tap sets the input-record stamp.
//
// HOW (the detector-observation-wiring.test.js pattern, sharing its fakes from helpers/fakeFfmpeg.js):
//   * ffmpeg is faked by mocking `node:child_process` ONLY (not in test:core's include list: mocking an included
//     module corrupts coverage suite-wide). A `WedgedFfmpeg` ignores SIGTERM.
//   * MediaMTX is a real local HTTP server that reports every path ready.
//   * THE MONOTONIC CLOCK is `performance.now()` shifted by `monoOffset`, which only ever grows, so a process can be
//     aged past the lever's 10 s minimum without waiting for it. The detectors, detectorHealthOf and killStalledDetector all
//     read performance.now(), so they all see the same shifted clock. Real time still passes underneath it.
//   * THE WALL CLOCK is mocked (`Date` only), so the sound strike rule's `Date.now() - startedAt` is a planted
//     value and a backward step is exact. setTimeout stays REAL: the 5 s relaunch and the 3 s SIGKILL fallback
//     run for real, which is what this file costs in wall time (~20 s, the slow cases run concurrently).
//   * The observation clock is PLANTED with a receipt whose `mono` is absurd, so a stamp taken from it would show.
import { test, mock, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupTempDataDirs } from './helpers/harness.js';
import { FakeFfmpeg, WedgedFfmpeg, startFakeMediamtx } from './helpers/fakeFfmpeg.js';

useTempDataDir();

// ⚠️ ORDER MATTERS: mediamtx.js reads MEDIAMTX_API at module load (see helpers/fakeFfmpeg.js).
const mediamtx = await startFakeMediamtx();

const realNow = performance.now.bind(performance);
let monoOffset = 0;
performance.now = () => realNow() + monoOffset;

const WALL0 = Date.UTC(2026, 8, 27, 1, 0, 0);
mock.timers.enable({ apis: ['Date'], now: WALL0 });

const procs = [];
const wedged = new Set(); // input URLs whose NEXT detector spawn ignores SIGTERM
const pidless = new Set(); // input URLs whose NEXT detector spawn never really started (no pid, #257)
mock.module('node:child_process', {
  exports: {
    spawn(command, args) {
      const isDetector = args.includes('rawvideo') || args.includes('s16le');
      const url = args[args.indexOf('-i') + 1];
      const proc = isDetector && wedged.delete(url) ? new WedgedFfmpeg(command, args) : new FakeFfmpeg(command, args);
      if (isDetector && pidless.delete(url)) proc.pid = undefined;
      if (isDetector) procs.push(proc);
      else proc.finish(1); // snapshot grabs and the like: fail at once, no network
      return proc;
    },
  },
});

const { logger } = await import('../src/lib/logger.js');
const motion = await import('../src/lib/motionDetector.js');
const sound = await import('../src/lib/soundDetector.js');
// The documented minimum age before the lever may kill is 10 s. These are LITERALS on purpose: an age computed
// from the imported MIN_KILL_AGE_MS follows a mutated value, and the lever tests then pass for any value (that
// is how #369 M05d first survived). detector-watchdog.test.js C3c pins the constant itself.
const TOO_YOUNG_MS = 9_000;
const OLD_ENOUGH_MS = 11_000;
const { _setObservationClockFactoryForTests, _resetObservationClocksForTests } = await import('../src/lib/observationClock.js');

const PLANTED_RX = Object.freeze({ mono: -777_777, wall: -888_888 });
const quiet = () => ({ onRecord() {}, onConfig() {}, onParseError() {}, onSample() {}, end() {} });
_setObservationClockFactoryForTests(() => ({ receipt: () => PLANTED_RX, beginGeneration: quiet }));

after(async () => {
  await motion.stopAllMotionDetectors();
  await sound.stopAllSoundDetectors();
  _resetObservationClocksForTests();
  mock.timers.reset();
  delete performance.now; // back to Performance.prototype.now
  await mediamtx.close();
  cleanupTempDataDirs();
});

// --- helpers ------------------------------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Poll on the REAL monotonic clock: Date is frozen and performance.now is shifted.
async function waitFor(pred, what, capMs = 25_000) {
  const deadline = realNow() + capMs;
  while (!pred()) {
    if (realNow() > deadline) assert.fail(`timed out waiting for ${what}`);
    await sleep(10);
  }
}
const urlOf = (p) => `rtsp://127.0.0.1:8554/${p}`;
const procsFor = (p) => procs.filter((x) => x.args.includes(urlOf(p)));
const liveFor = (p) => procsFor(p).filter((x) => !x.ended);
const linesFor = (needle) => logger.getRecent().filter((l) => l.includes(needle));
// Age the current process to at least `ms` on the shifted monotonic clock. The offset only grows, so this can
// age OTHER tests' processes too, which is harmless: they are only ever asserted "old enough".
function ageTo(health, ms) {
  monoOffset += Math.max(0, ms - health.spawnAgeMs);
}
const tokens = (h) => ({ expectSpawn: h.spawnedMono, expectLastData: h.lastDataMono });

const camera = (id) => ({
  id,
  name: `Lever ${id}`,
  mediamtx_path: `path_${id}`,
  sub_rtsp_url: null,
  rtsp_url: 'rtsp://192.0.2.10:554/ch0',
  disabled: 0,
  child_id: null,
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

async function startMotion(id) {
  const cam = camera(id);
  await motion.startMotionDetector(cam);
  await waitFor(() => liveFor(cam.mediamtx_path).length === 1, `the ${id} motion ffmpeg to spawn`);
  return { cam, proc: liveFor(cam.mediamtx_path)[0] };
}
async function startSound(id) {
  const cam = camera(id);
  await sound.startSoundDetector(cam);
  await waitFor(() => liveFor(cam.mediamtx_path).length === 1, `the ${id} sound ffmpeg to spawn`);
  return { cam, proc: liveFor(cam.mediamtx_path)[0] };
}

// Laid out exactly as ffmpeg 8.1.2 prints them (copied from detector-observation-wiring.test.js).
const MOTION_IN_RECORD = '[showinfo@in @ 0x7f00000a0000] [info] n:   0 pts:      0 pts_time:0       duration:  18000 duration_time:0.2     fmt:yuv420p cl:left sar:1/1 s:640x360 i:P iskey:0 type:P ';
const MOTION_OUT_RECORD = '[showinfo@out @ 0x7f00000b0000] [info] n:   0 pts:      0 pts_time:0       duration:      1 duration_time:0.2     fmt:gray cl:unspecified sar:1/1 s:320x180 i:P iskey:0 type:P checksum:0000ABCD plane_checksum:[0000ABCD] mean:[60] stdev:[40.0]';
const SOUND_RECORD = '[Parsed_ashowinfo_0 @ 0x7f00000c0000] [info] n:0 pts:0 pts_time:0 fmt:s16 channels:1 chlayout:mono rate:8000 nb_samples:1600 checksum:0000ABCD plane_checksums: [ 0000ABCD ]';
const ERROR_LINE = '[rtsp @ 0x7f0000001000] [error] method DESCRIBE failed: 404 Not Found';
const stderr = (proc, line) => proc.stderr.emit('data', Buffer.from(`${line}\n`));

// ---------------------------------------------------------------------------------------------------------------
// SERIAL: these read ages and stamps to the millisecond, so nothing may move the shared offset under them.
describe('the stamps and the lever guards', { concurrency: false }, () => {
  test('C17a: the motion stamp is performance.now() at each stdout data event: not stderr, not the receipt clock', async () => {
    const { cam, proc } = await startMotion('lv-stamp-m');
    const h0 = motion.getMotionDetectorHealth(cam.id);
    assert.equal(h0.path, cam.mediamtx_path);
    assert.equal(h0.dataAgeMs, null, 'a fresh process already has data');
    assert.ok(h0.spawnAgeMs >= 0 && h0.spawnAgeMs < 5_000, `spawn age ${h0.spawnAgeMs}`);
    stderr(proc, ERROR_LINE);
    stderr(proc, MOTION_OUT_RECORD);
    assert.equal(motion.getMotionDetectorHealth(cam.id).dataAgeMs, null, 'stderr stamped the DATA freshness');

    // Stamps from here on are > 100 s. In a freshly started test process performance.now() itself is under a
    // second, so "age < 1 s" could not tell an age from a raw stamp (#369 M17h first survived that way).
    monoOffset += 100_000;
    const before = performance.now();
    proc.stdout.emit('data', Buffer.alloc(100));
    const h1 = motion.getMotionDetectorHealth(cam.id);
    assert.ok(h1.lastDataMono >= before && h1.lastDataMono <= performance.now(),
      `the stamp ${h1.lastDataMono} is not performance.now() at the event (planted receipt mono ${PLANTED_RX.mono}, wall ${WALL0})`);
    monoOffset += 5_000;
    const aged = motion.getMotionDetectorHealth(cam.id).dataAgeMs;
    assert.ok(aged >= 5_000 && aged < 6_000, `the data age is not "now - stamp": ${aged}`);

    proc.stdout.emit('data', Buffer.alloc(100));
    const h2 = motion.getMotionDetectorHealth(cam.id);
    assert.ok(h2.lastDataMono >= h1.lastDataMono + 5_000, 'a second data event did not move the stamp');
    await motion.stopMotionDetector(cam.id);
    assert.equal(motion.getMotionDetectorHealth(cam.id), null, 'a stopped detector still reports health');
  });

  test('C17b: only the motion INPUT tap (`in`) stamps the input record; its absence reads as null', async () => {
    const { cam, proc } = await startMotion('lv-tap-m');
    monoOffset += 100_000; // stamps > 100 s: see C17a
    stderr(proc, MOTION_OUT_RECORD);
    stderr(proc, ERROR_LINE);
    assert.equal(motion.getMotionDetectorHealth(cam.id).inputRecordAgeMs, null, 'the OUTPUT tap or an error line set the input stamp');
    stderr(proc, MOTION_IN_RECORD);
    monoOffset += 5_000;
    const age = motion.getMotionDetectorHealth(cam.id).inputRecordAgeMs;
    assert.ok(age != null && age >= 5_000 && age < 6_000, `the input tap did not stamp, or its age is not "now - stamp" (${age})`);
    await motion.stopMotionDetector(cam.id);
  });

  test('C17c/C4: sound: DIGITAL SILENCE still stamps (bytes, not readings); only the `audio` tap stamps the input record', async () => {
    const { cam, proc } = await startSound('lv-stamp-s');
    monoOffset += 100_000; // stamps > 100 s: see C17a
    stderr(proc, ERROR_LINE);
    stderr(proc, MOTION_IN_RECORD); // not this leg's tap
    const h0 = sound.getSoundDetectorHealth(cam.id);
    assert.equal(h0.dataAgeMs, null);
    assert.equal(h0.inputRecordAgeMs, null, 'a line that is not the sound tap set the input stamp');
    const before = performance.now();
    proc.stdout.emit('data', Buffer.alloc(3200)); // one 200 ms window of s16le zeros: no reading at all
    const h1 = sound.getSoundDetectorHealth(cam.id);
    assert.ok(h1.lastDataMono >= before && h1.lastDataMono <= performance.now(), 'a silent window did not stamp the leg as fresh');
    stderr(proc, SOUND_RECORD);
    monoOffset += 5_000;
    const h2 = sound.getSoundDetectorHealth(cam.id);
    assert.ok(h2.dataAgeMs >= 5_000 && h2.dataAgeMs < 6_000, `the sound data age is not "now - stamp": ${h2.dataAgeMs}`);
    assert.ok(h2.inputRecordAgeMs != null && h2.inputRecordAgeMs >= 5_000 && h2.inputRecordAgeMs < 6_000,
      `the sound tap did not stamp, or its age is not "now - stamp" (${h2.inputRecordAgeMs})`);
    await sound.stopSoundDetector(cam.id);
  });

  test('C13b: the lever refuses a process younger than MIN_KILL_AGE, a stale spawn token, and data newer than judged', async () => {
    const { cam, proc } = await startMotion('lv-guard');
    const h = motion.getMotionDetectorHealth(cam.id);
    assert.equal(motion.restartMotionDetector(cam.id, tokens(h)), false, 'a just-spawned process was killed');
    ageTo(h, TOO_YOUNG_MS);
    assert.equal(motion.restartMotionDetector(cam.id, tokens(motion.getMotionDetectorHealth(cam.id))), false, 'a 9 s old process was killed');
    ageTo(motion.getMotionDetectorHealth(cam.id), OLD_ENOUGH_MS);
    const judged = motion.getMotionDetectorHealth(cam.id);
    assert.equal(motion.restartMotionDetector(cam.id, { ...tokens(judged), expectSpawn: judged.spawnedMono + 1 }), false,
      'a kill judged on ANOTHER generation landed on this one');
    proc.stdout.emit('data', Buffer.alloc(10)); // it recovered after it was judged (Astra R1)
    assert.equal(motion.restartMotionDetector(cam.id, tokens(judged)), false, 'a process that delivered since it was judged was killed');
    const again = motion.getMotionDetectorHealth(cam.id);
    monoOffset += 1;
    proc.stdout.emit('data', Buffer.alloc(10));
    assert.equal(motion.restartMotionDetector(cam.id, tokens(again)), false, 'data newer than the judged stamp did not stop the kill');
    assert.deepEqual(proc.signals, [], 'a refused kill still signalled');
    assert.equal(motion.restartMotionDetector('no-such-camera', tokens(again)), false);
    assert.equal(motion.restartMotionDetector(cam.id, tokens(motion.getMotionDetectorHealth(cam.id))), true, 'control: a valid kill was refused');
    assert.deepEqual(proc.signals, ['SIGTERM']);
    await waitFor(() => linesFor(`[detect:${cam.mediamtx_path}] stopped by the detector watchdog`).length === 1, 'the exit handler');
    await motion.stopMotionDetector(cam.id); // inside the 5 s gap: no relaunch (C15 proves that part)
  });
});

// ---------------------------------------------------------------------------------------------------------------
// CONCURRENT: each waits for a real 5 s relaunch or a 3 s SIGKILL fallback, on its own camera and path.
describe('kills, relaunches and strikes', { concurrency: true }, () => {
  test('C13a: after a watchdog kill there is exactly ONE live detector process, and an obeying process got SIGTERM only', async () => {
    const { cam, proc } = await startMotion('lv-one');
    proc.stdout.emit('data', Buffer.alloc(10));
    ageTo(motion.getMotionDetectorHealth(cam.id), OLD_ENOUGH_MS);
    assert.equal(motion.restartMotionDetector(cam.id, tokens(motion.getMotionDetectorHealth(cam.id))), true);
    await waitFor(() => procsFor(cam.mediamtx_path).length === 2, 'the relaunch');
    assert.equal(liveFor(cam.mediamtx_path).length, 1, 'more than one live detector process after a watchdog kill');
    // The relaunch comes 5 s after the exit, past the 3 s SIGKILL deadline: an obeying process was signalled ONCE.
    assert.deepEqual(proc.signals, ['SIGTERM'], 'the SIGKILL fallback was not cleared when the process obeyed SIGTERM');
    const fresh = motion.getMotionDetectorHealth(cam.id);
    assert.equal(fresh.dataAgeMs, null, 'the replacement inherited the old process\'s data stamp');
    assert.notEqual(fresh.spawnedMono, undefined);
    await motion.stopMotionDetector(cam.id);
  });

  test('C13c: a WEDGED process that ignores SIGTERM is SIGKILLed after 3 s, once, and a second call while it dies is a no-op', async () => {
    const path = 'path_lv-wedge';
    wedged.add(urlOf(path));
    const { cam, proc } = await startMotion('lv-wedge');
    assert.ok(proc instanceof WedgedFfmpeg, 'test bug: the process is not the wedged fake');
    ageTo(motion.getMotionDetectorHealth(cam.id), OLD_ENOUGH_MS);
    const judged = motion.getMotionDetectorHealth(cam.id);
    const t0 = realNow();
    assert.equal(motion.restartMotionDetector(cam.id, tokens(judged)), true);
    assert.equal(motion.restartMotionDetector(cam.id, tokens(judged)), false, 'a second kill was armed while the first was in flight');
    assert.deepEqual(proc.signals, ['SIGTERM']);
    await waitFor(() => proc.ended, 'the SIGKILL fallback', 10_000);
    assert.ok(realNow() - t0 >= 2_900, `SIGKILL came after ${Math.round(realNow() - t0)} ms, not ~3 s`);
    assert.deepEqual(proc.signals, ['SIGTERM', 'SIGKILL']);
    await waitFor(() => procsFor(path).length === 2, 'the relaunch after the SIGKILL');
    assert.equal(liveFor(path).length, 1);
    await motion.stopMotionDetector(cam.id);
  });

  test('C14a: watchdog kills are NEVER no-microphone strikes, even when the WALL clock steps backward', async () => {
    // Without the skip, `Date.now() - startedAt` is negative after a backward step, so each kill of a leg that
    // never produced a reading counts as a quick exit and the third stops sound detection for good (Astra R2).
    const { cam } = await startSound('lv-strike');
    for (let k = 1; k <= 3; k++) {
      const current = liveFor(cam.mediamtx_path)[0];
      mock.timers.setTime(WALL0 - k * 3_600_000); // a backward wall-clock step between spawn and exit
      ageTo(sound.getSoundDetectorHealth(cam.id), OLD_ENOUGH_MS);
      assert.equal(sound.restartSoundDetector(cam.id, tokens(sound.getSoundDetectorHealth(cam.id))), true, `kill ${k} refused`);
      await waitFor(() => current.ended, `kill ${k} to land`);
      await waitFor(() => procsFor(cam.mediamtx_path).length === k + 1, `the relaunch after kill ${k}`);
    }
    assert.equal(linesFor(`[sound:${cam.mediamtx_path}] no audio readings`).length, 0, 'a watchdog kill was counted as a strike');
    assert.equal(linesFor(`[sound:${cam.mediamtx_path}] stopped by the detector watchdog (no audio data), restarting in 5s`).length, 3);
    await sound.stopSoundDetector(cam.id);
  });

  test('C13d: a process that never really spawned (no pid) is not signalled, and the lever says so and stays usable', async () => {
    const path = 'path_lv-nopid';
    pidless.add(urlOf(path));
    const { cam, proc } = await startMotion('lv-nopid');
    assert.equal(proc.pid, undefined, 'test bug: the process has a pid');
    ageTo(motion.getMotionDetectorHealth(cam.id), OLD_ENOUGH_MS);
    const judged = motion.getMotionDetectorHealth(cam.id);
    assert.equal(motion.restartMotionDetector(cam.id, tokens(judged)), false, 'the lever claimed to signal a process with no pid');
    assert.equal(motion.restartMotionDetector(cam.id, tokens(judged)), false);
    assert.deepEqual(proc.signals, []);
    proc.pid = 41999; // it turns out to be real after all: the lever must not be stuck "in flight"
    assert.equal(motion.restartMotionDetector(cam.id, tokens(judged)), true, 'a refused kill left the entry marked as killed');
    await waitFor(() => proc.ended, 'the kill');
    await motion.stopMotionDetector(cam.id);
  });

  test('C14c: a watchdog kill RESETS the strike count (it is a long-lived exit): 2 quick crashes, a kill, a crash: still running', async () => {
    const { cam } = await startSound('lv-reset');
    const p = cam.mediamtx_path;
    for (let k = 1; k <= 2; k++) {
      procsFor(p)[k - 1].finish(1); // an ordinary quick exit: strike k
      await waitFor(() => procsFor(p).length === k + 1, `the relaunch after crash ${k}`);
    }
    ageTo(sound.getSoundDetectorHealth(cam.id), OLD_ENOUGH_MS);
    assert.equal(sound.restartSoundDetector(cam.id, tokens(sound.getSoundDetectorHealth(cam.id))), true);
    await waitFor(() => procsFor(p).length === 4, 'the relaunch after the watchdog kill');
    procsFor(p)[3].finish(1); // strike 1 again if the kill reset the count; strike 3 (stop) if it did not
    await waitFor(() => procsFor(p).length === 5, 'the relaunch after the crash that follows the kill');
    assert.equal(linesFor(`[sound:${p}] no audio readings`).length, 0);
    await sound.stopSoundDetector(cam.id);
  });

  test('C14b (control): an ORDINARY quick exit with no reading still counts; the third stops sound detection', async () => {
    const { cam } = await startSound('lv-crash');
    for (let k = 1; k <= 3; k++) {
      await waitFor(() => procsFor(cam.mediamtx_path).length === k, `spawn ${k}`);
      procsFor(cam.mediamtx_path)[k - 1].finish(1);
      if (k < 3) await waitFor(() => procsFor(cam.mediamtx_path).length === k + 1, `the relaunch after crash ${k}`);
    }
    await waitFor(() => linesFor(`[sound:${cam.mediamtx_path}] no audio readings after 3 tries`).length === 1, 'the no-microphone verdict');
    await sleep(6_500);
    assert.equal(procsFor(cam.mediamtx_path).length, 3, 'sound detection relaunched after the third strike');
  });

  for (const leg of ['motion', 'sound']) {
    test(`C15 ${leg}: the watchdog kill is logged at INFO with "restarting in 5s", and stop inside that gap cancels the relaunch`, async () => {
      const id = `lv-gap-${leg}`;
      const { cam, proc } = leg === 'motion' ? await startMotion(id) : await startSound(id);
      const mod = leg === 'motion' ? motion : sound;
      const getHealth = leg === 'motion' ? mod.getMotionDetectorHealth : mod.getSoundDetectorHealth;
      const restart = leg === 'motion' ? mod.restartMotionDetector : mod.restartSoundDetector;
      const stop = leg === 'motion' ? mod.stopMotionDetector : mod.stopSoundDetector;
      ageTo(getHealth(cam.id), OLD_ENOUGH_MS);
      assert.equal(restart(cam.id, tokens(getHealth(cam.id))), true);
      await waitFor(() => proc.ended, 'the kill');
      const tag = leg === 'motion' ? `detect:${cam.mediamtx_path}` : `sound:${cam.mediamtx_path}`;
      const lines = linesFor(`[${tag}] stopped by the detector watchdog`);
      assert.equal(lines.length, 1);
      assert.match(lines[0], /\[INFO\] \[(detect|sound):[^\]]+\] stopped by the detector watchdog \(no (frames|audio data)\), restarting in 5s$/);
      assert.equal(getHealth(cam.id), null, 'precondition: not in the relaunch gap');
      await stop(cam.id);
      await sleep(9_000); // well past the 5 s relaunch deadline
      assert.equal(procsFor(cam.mediamtx_path).length, 1, `stop inside the gap did not cancel the ${leg} relaunch`);
    });
  }
});
