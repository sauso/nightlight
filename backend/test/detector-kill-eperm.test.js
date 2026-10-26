// #553 phase 1: a signal the motion or sound detector could not deliver (EPERM) is not a failed spawn.
//
// Node reports an undelivered signal on the child's 'error' event, the event a failed spawn uses. Both detectors read
// every 'error' as "ffmpeg never started": they dropped the camera from their map while its ffmpeg was still running
// (reconcile would then start a second one), and a stop resolved at once instead of waiting for its SIGKILL fallback.
// With media isolation the children belong to another uid, so a kill fails this way whenever the app lacks CAP_KILL.
// Pinned here, for each detector:
//   - a kill error on the live process leaves the detector registered, and says "could not signal", not "could not start";
//   - a stop whose SIGTERM is refused waits for the 3 s fallback rather than resolving at once.
// HOW: the detector-watchdog-levers.test.js pattern. `node:child_process` mocked (not a test:core module), a real local
// fake MediaMTX API reporting every path ready, REAL timers (the 3 s fallback runs for real: ~7 s for this file). The
// kill error has the shape Node gives it ({ code: 'EPERM', syscall: 'kill' }).
import { test, mock, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupTempDataDirs } from './helpers/harness.js';
import { FakeFfmpeg, startFakeMediamtx } from './helpers/fakeFfmpeg.js';

useTempDataDir();

// ⚠️ ORDER MATTERS: mediamtx.js reads MEDIAMTX_API at module load (see helpers/fakeFfmpeg.js).
const mediamtx = await startFakeMediamtx();

const killEperm = () => Object.assign(new Error('kill EPERM'), { errno: -1, code: 'EPERM', syscall: 'kill' });
class KillEpermFfmpeg extends FakeFfmpeg {
  kill(signal) {
    this.signals.push(signal);
    this.emit('error', killEperm());
    return false;
  }
}

const procs = [];
mock.module('node:child_process', {
  exports: {
    spawn(command, args) {
      const isDetector = args.includes('rawvideo') || args.includes('s16le');
      const proc = isDetector ? new KillEpermFfmpeg(command, args) : new FakeFfmpeg(command, args);
      if (isDetector) procs.push(proc);
      else proc.finish(1); // snapshot grabs and the like: fail at once, no network
      return proc;
    },
  },
});

const { logger } = await import('../src/lib/logger.js');
const motion = await import('../src/lib/motionDetector.js');
const sound = await import('../src/lib/soundDetector.js');

after(async () => {
  await mediamtx.close();
  cleanupTempDataDirs();
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, what, capMs = 15_000) {
  const deadline = Date.now() + capMs;
  while (!pred()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await sleep(10);
  }
}
const lines = (needle) => logger.getRecent().filter((l) => l.includes(needle));
const liveFor = (p) => procs.filter((x) => !x.ended && x.args.includes(`rtsp://127.0.0.1:8554/${p}`));
const camera = (id) => ({
  id,
  name: `Eperm ${id}`,
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

const LEGS = [
  { name: 'motion', tag: 'detect', start: motion.startMotionDetector, stop: motion.stopMotionDetector, running: motion.isDetecting },
  { name: 'sound', tag: 'sound', start: sound.startSoundDetector, stop: sound.stopSoundDetector, running: sound.isSoundDetecting },
];

describe('#553 a refused signal is not a failed spawn, in both detectors', () => {
  for (const leg of LEGS) {
    test(`${leg.name}: a kill error keeps the detector registered, and its stop waits for the fallback`, async () => {
      const cam = camera(`eperm-${leg.name}`);
      logger.clear();
      await leg.start(cam);
      await waitFor(() => liveFor(cam.mediamtx_path).length === 1, `the ${leg.name} ffmpeg`);
      const proc = liveFor(cam.mediamtx_path)[0];

      proc.emit('error', killEperm()); // what Node emits when a kill() on this process fails with EPERM
      assert.equal(leg.running(cam.id), true, 'a live ffmpeg was dropped from the map: reconcile would start a second one');
      assert.equal(lines(`[${leg.tag}:${cam.mediamtx_path}] could not signal ffmpeg`).length, 1);
      assert.equal(lines(`[${leg.tag}:${cam.mediamtx_path}] could not start ffmpeg`).length, 0);

      let settled = false;
      const t0 = Date.now();
      const stop = leg.stop(cam.id).then(() => { settled = true; });
      await sleep(300);
      assert.equal(settled, false, 'the stop resolved at once while the ffmpeg was still running');
      await stop;
      assert.ok(Date.now() - t0 >= 2_500, `the stop ended after ${Date.now() - t0} ms, before the 3 s fallback`);
      assert.deepEqual(proc.signals, ['SIGTERM', 'SIGKILL']);
    });
  }
});
