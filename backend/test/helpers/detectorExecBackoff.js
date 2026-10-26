// #553 phase 1 (review of PR #869): the shared body of motion-exec-backoff.test.js and sound-exec-backoff.test.js.
//
// Under media isolation a child that cannot run its program exits 126/127 at once (setpriv's exec-failure statuses),
// an ordinary 'exit' to Node. Both detectors relaunched on it every 5 s with an error line each time: ~720 lines an
// hour per camera into logger.js's 1000-line ring. Pinned, for the one leg a file names:
//   - one line for a run of such exits, and relaunches at 5 s, 10 s, 20 s (the shared execFailureBackoff);
//   - after four of them (one more than the sound leg's no-microphone limit of 3) nothing says "no microphone": an exec
//     failure is not a strike (a strike would stop the sound leg for good, with the wrong diagnosis);
//   - an ordinary exit afterwards is logged and relaunched after 5 s exactly as before.
// HOW: `node:child_process` mocked (not a test:core module); a fake ffmpeg that exits 127 in a microtask, as a wrapper
// that could not exec does; a real local fake MediaMTX API reporting every path ready; node:test's mock setTimeout, so
// the delays are exact. Each relaunch re-checks readiness over real local HTTP, so a spawn is awaited by polling on
// setImmediate (not mocked) against a real-clock deadline.
// ONE LEG PER FILE, i.e. per process, on purpose: run one after the other in the same process, the second leg's first
// readiness request was never answered (the HTTP client keeps state across the mocked clock; seen while writing this).
import { test, mock, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupTempDataDirs } from './harness.js';
import { FakeFfmpeg, startFakeMediamtx } from './fakeFfmpeg.js';

class Exec127Ffmpeg extends FakeFfmpeg {
  constructor(command, args) {
    super(command, args);
    this.finish(127);
  }
}

export async function detectorExecBackoffSuite(legName) {
  useTempDataDir();
  // ⚠️ ORDER MATTERS: mediamtx.js reads MEDIAMTX_API at module load (see fakeFfmpeg.js).
  const mediamtx = await startFakeMediamtx();

  let DetectorAs = Exec127Ffmpeg;
  const procs = [];
  mock.module('node:child_process', {
    exports: {
      spawn(command, args) {
        const isDetector = args.includes('rawvideo') || args.includes('s16le');
        const proc = isDetector ? new DetectorAs(command, args) : new FakeFfmpeg(command, args);
        if (isDetector) procs.push(proc);
        else proc.finish(1); // snapshot grabs and the like: fail at once, no network
        return proc;
      },
    },
  });

  const { logger } = await import('../../src/lib/logger.js');
  const leg = legName === 'motion'
    ? await import('../../src/lib/motionDetector.js').then((m) => ({ tag: 'detect', start: m.startMotionDetector, stop: m.stopMotionDetector }))
    : await import('../../src/lib/soundDetector.js').then((m) => ({ tag: 'sound', start: m.startSoundDetector, stop: m.stopSoundDetector }));

  before(() => mock.timers.enable({ apis: ['setTimeout'] }));
  after(async () => {
    mock.timers.reset();
    await mediamtx.close();
    cleanupTempDataDirs();
  });

  const turn = () => new Promise((r) => setImmediate(r));
  async function until(pred, what, capMs = 10_000) {
    const deadline = Date.now() + capMs;
    while (!pred()) {
      if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
      await turn();
    }
    for (let i = 0; i < 5; i++) await turn(); // and let its 'exit' (a microtask) and handler run
  }
  const settle = async () => { for (let i = 0; i < 5; i++) await turn(); };
  const lines = (needle) => logger.getRecent().filter((l) => l.includes(needle));
  const cam = {
    id: `backoff-${legName}`,
    name: `Backoff ${legName}`,
    mediamtx_path: `path_backoff-${legName}`,
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
  };

  describe(`#553 the ${legName} detector backs off when ffmpeg cannot be run`, () => {
    test(`${legName}: one line for a run of 127s, relaunches at 5, 10, 20 s; an ordinary exit is 5 s again`, async () => {
      const mine = () => procs.filter((p) => p.args.includes(`rtsp://127.0.0.1:8554/${cam.mediamtx_path}`));
      const count = () => mine().length;
      const prefix = `[${leg.tag}:${cam.mediamtx_path}]`;
      DetectorAs = Exec127Ffmpeg;
      logger.clear();
      try {
        await leg.start(cam);
        await until(() => count() === 1, 'the first launch');
        assert.equal(lines(`${prefix} ffmpeg could not be run`).length, 1, 'the first failure of the run is said once');
        for (const [delay, n] of [[5_000, 2], [10_000, 3], [20_000, 4]]) {
          mock.timers.tick(delay - 1);
          await settle();
          assert.equal(count(), n - 1, `relaunched before ${delay / 1000} s: no back-off`);
          mock.timers.tick(1);
          await until(() => count() === n, `launch ${n}`);
        }
        assert.equal(lines(`${prefix} ffmpeg could not be run`).length, 1, 'the run must be quiet after its first line');
        assert.equal(lines(`${prefix} exited (code 127)`).length, 0, 'the every-5-s line is back');
        assert.equal(lines('does this camera have a microphone').length, 0, 'an exec failure was counted as "no microphone"');

        // It can run again: an ORDINARY exit then relaunches after 5 s, logged as before.
        DetectorAs = FakeFfmpeg;
        mock.timers.tick(40_000);
        await until(() => count() === 5, 'the launch that runs');
        mine().at(-1).finish(1);
        await settle();
        assert.equal(lines(`${prefix} exited (code 1), restarting in 5s`).length, 1);
        mock.timers.tick(4_999);
        await settle();
        assert.equal(count(), 5);
        mock.timers.tick(1);
        await until(() => count() === 6, 'the relaunch after an ordinary exit');
      } finally {
        await leg.stop(cam.id);
      }
    });
  });
}
