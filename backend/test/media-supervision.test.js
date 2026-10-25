// #553 phase 1: what the supervisors do with the two new ways a child can fail under media isolation.
//
//   127 AT ONCE  A wrapped child whose program (or whose switch to the media user) cannot run is spawned fine and then
//                exits 127 within milliseconds: an 'exit', not an 'error' (#553 spike). MediaMTX (3 s), the transcoder
//                (5 s) and the clip segmenter (5 s) relaunched on that forever, one log line each time. Now each backs
//                off, doubling from its own delay (to a 60 s cap), with ONE line for the run; any other exit relaunches
//                after the same delay as before (m1, t1, s1).
//   KILL EPERM   Node reports a signal it could not deliver on the child's 'error' event, the same event a failed spawn
//                uses. Read as a failed spawn, MediaMTX started a SECOND MediaMTX beside the live one (m2), the
//                transcoder dropped a live camera from its map and a stop resolved while the old ffmpeg still ran (t2),
//                and runFfmpeg reported "could not run" instead of its deadline (r1). The segmenter's case can only show
//                in its log line today: the one kill it sends comes after its own deregistration (s2).
// HOW. `node:child_process` is mocked (NOT a test:core module; processGuards.js and clipRecorder.js are, and are real),
// with fakes from helpers/fakeFfmpeg.js: Exec127Ffmpeg exits 127 in a microtask, as a wrapper that could not exec does;
// KillEpermFfmpeg's kill() emits 'error' with the shape Node gives it ({ code: 'EPERM', syscall: 'kill' }) and returns
// false. The transcoder's probe, MediaMTX API and event log are faked as in transcoder-start-chain.test.js. Timers are
// node:test's mock setTimeout, so every delay is exact; "at once" is read on the real monotonic clock, where a microtask
// is well under the 5 s window. The detectors' EPERM cases are in detector-kill-eperm.test.js (they need the real
// MediaMTX client).
import { test, mock, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupTempDataDirs } from './helpers/harness.js';
import { FakeFfmpeg } from './helpers/fakeFfmpeg.js';

useTempDataDir();

const killEperm = () => Object.assign(new Error('kill EPERM'), { errno: -1, code: 'EPERM', syscall: 'kill' });
class Exec127Ffmpeg extends FakeFfmpeg {
  constructor(command, args) {
    super(command, args);
    this.finish(127);
  }
}
class KillEpermFfmpeg extends FakeFfmpeg {
  kill(signal) {
    this.signals.push(signal);
    this.emit('error', killEperm());
    return false;
  }
}

const spawned = [];
let SpawnAs = FakeFfmpeg;
mock.module('node:child_process', {
  exports: {
    spawn(command, args) {
      const proc = new SpawnAs(command, args);
      spawned.push(proc);
      return proc;
    },
  },
});
mock.module('../src/lib/rtspProbe.js', { exports: { ffprobeAudioCodec: async () => null } });
mock.module('../src/lib/mediamtx.js', {
  exports: {
    hlsPathName: (p) => `${p}-hls`,
    upsertPath: async () => {},
    isPathConfiguredCorrectly: async () => true,
  },
});
// The transcoder's RESTART rows (review of PR #869: one per back-off relaunch was unbounded), recorded per camera.
const cameraEvents = [];
mock.module('../src/lib/cameraEvents.js', {
  exports: { recordCameraEvent: (id, _name, type, detail) => cameraEvents.push({ id, type, detail }), EVENT: { RESTART: 'restart' } },
});

const { logger } = await import('../src/lib/logger.js');
const { startMediaMTX, stopMediaMTX, restartMediaMTX } = await import('../src/lib/mediamtxProcess.js');
const { startTranscoder, stopTranscoder, isRunning, stopAllTranscoders } = await import('../src/lib/transcoder.js');
const { startSegmenter, stopSegmenter, stopAllSegmenters, runFfmpeg } = await import('../src/lib/clipRecorder.js');

const settle = () => new Promise((resolve) => setImmediate(resolve)); // real setImmediate: only setTimeout is mocked
const lines = (needle) => logger.getRecent().filter((l) => l.includes(needle));
const spawnsFor = (needle) => spawned.filter((p) => p.args.some((a) => String(a).includes(needle)));
function track(promise) {
  const s = { settled: false, ok: undefined, error: undefined };
  promise.then(() => Object.assign(s, { settled: true, ok: true }), (error) => Object.assign(s, { settled: true, ok: false, error }));
  return s;
}

afterEach(async () => {
  mock.timers.reset();
  SpawnAs = FakeFfmpeg;
});
after(async () => {
  stopMediaMTX();
  await stopAllTranscoders();
  // Also on a failed case: a segmenter's janitor is a REAL interval, and one left running keeps this file's process
  // alive, so a failing assertion turned into a 5-minute HANG instead of a failure (seen in the first mutation run).
  stopAllSegmenters();
  cleanupTempDataDirs();
});

// ⚠️ ORDERED: stopMediaMTX() latches the module for good, so the MediaMTX cases share one start and stop in after().
describe('#553 MediaMTX', () => {
  before(async () => {
    await startMediaMTX('mediamtx.yml'); // real timers here: the network wait, then one live FakeFfmpeg
    assert.equal(spawnsFor('mediamtx.yml').length, 1, 'precondition: MediaMTX was launched');
  });

  test('m1: 127 at once backs off 3, 6, 12 s with one line; an ordinary exit relaunches after 3 s again', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    logger.clear();
    const count = () => spawnsFor('mediamtx.yml').length;
    const start = count();
    SpawnAs = Exec127Ffmpeg;
    assert.equal(restartMediaMTX(), true); // the live one exits on SIGTERM: an ordinary exit, relaunched after 3 s
    await settle();
    mock.timers.tick(3_000);
    assert.equal(count(), start + 1, 'precondition: relaunched as a child that cannot run');
    await settle();
    assert.equal(lines('MediaMTX could not be run').length, 1, 'the first failure of the run is said once');
    mock.timers.tick(2_999);
    assert.equal(count(), start + 1, 'relaunched before the first back-off (3 s) was up');
    mock.timers.tick(1);
    assert.equal(count(), start + 2);
    await settle();
    mock.timers.tick(5_999);
    assert.equal(count(), start + 2, 'the second relaunch did not wait 6 s: no back-off');
    mock.timers.tick(1);
    assert.equal(count(), start + 3);
    await settle();
    assert.equal(lines('MediaMTX could not be run').length, 1, 'repeated: the run must be quiet after its first line');
    assert.equal(lines('[mediamtx] exited (code 127)').length, 0, 'the every-3-s line is back');
    // It can run again: an ORDINARY exit then relaunches after 3 s, as before #553.
    SpawnAs = FakeFfmpeg;
    mock.timers.tick(12_000);
    assert.equal(count(), start + 4);
    spawned.at(-1).finish(1);
    await settle();
    assert.equal(lines('[mediamtx] exited (code 1), restarting in 3s').length, 1);
    mock.timers.tick(2_999);
    assert.equal(count(), start + 4);
    mock.timers.tick(1);
    assert.equal(count(), start + 5, 'an ordinary exit after a run of 127s still relaunches after 3 s');
  });

  test('m2: a SIGTERM MediaMTX refuses (EPERM) is not a failed spawn: no second MediaMTX is started', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    SpawnAs = KillEpermFfmpeg;
    restartMediaMTX(); // the live FakeFfmpeg exits; the relaunch is the one that will refuse signals
    await settle();
    mock.timers.tick(3_000);
    const stubborn = spawned.at(-1);
    assert.ok(stubborn instanceof KillEpermFfmpeg, 'precondition');
    const count = spawnsFor('mediamtx.yml').length;
    logger.clear();
    assert.equal(restartMediaMTX(), false, 'nothing was signalled');
    assert.deepEqual(stubborn.signals, ['SIGTERM']);
    assert.equal(lines('[mediamtx] could not signal MediaMTX').length, 1);
    assert.equal(lines('[mediamtx] could not start').length, 0, 'read as a failed spawn');
    mock.timers.tick(60_000);
    assert.equal(spawnsFor('mediamtx.yml').length, count, 'a second MediaMTX was started next to the one that refused the signal');
    assert.equal(stubborn.ended, false);
  });
});

describe('#553 the transcoder', () => {
  test('t1: 127 at once backs off 5, 10 s with one line; an ordinary exit relaunches after 5 s', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    logger.clear();
    SpawnAs = Exec127Ffmpeg;
    const count = () => spawnsFor('path_t1').length;
    await startTranscoder('cam-t1', 'rtsp://192.0.2.10:554/t1', 'path_t1', 'T1');
    await settle();
    assert.equal(count(), 1, 'precondition: launched');
    assert.equal(lines('[ffmpeg:path_t1] ffmpeg could not be run').length, 1);
    mock.timers.tick(4_999);
    assert.equal(count(), 1);
    mock.timers.tick(1);
    assert.equal(count(), 2);
    await settle();
    mock.timers.tick(9_999);
    assert.equal(count(), 2, 'the second relaunch did not wait 10 s: no back-off');
    mock.timers.tick(1);
    assert.equal(count(), 3);
    await settle();
    assert.equal(lines('[ffmpeg:path_t1] ffmpeg could not be run').length, 1, 'repeated');
    assert.equal(lines('[ffmpeg:path_t1] exited (code 127)').length, 0);
    // Three exec failures, ONE camera event row (the first of the run), as for the log line.
    const rows = () => cameraEvents.filter((e) => e.id === 'cam-t1');
    assert.deepEqual(rows(), [{ id: 'cam-t1', type: 'restart', detail: 'stream ended (exit code 127)' }]);
    SpawnAs = FakeFfmpeg;
    mock.timers.tick(20_000);
    assert.equal(count(), 4);
    spawned.at(-1).finish(1);
    await settle();
    assert.equal(lines('[ffmpeg:path_t1] exited (code 1), restarting in 5s').length, 1);
    assert.equal(rows().length, 2, 'an ordinary exit records its row, as before');
    mock.timers.tick(4_999);
    assert.equal(count(), 4);
    mock.timers.tick(1);
    assert.equal(count(), 5);
    const stop = stopTranscoder('cam-t1');
    await settle();
    await stop;
  });

  test('t2: an EPERM kill keeps a live camera registered, and its stop waits for the 3 s fallback', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    logger.clear();
    SpawnAs = KillEpermFfmpeg;
    await startTranscoder('cam-t2', 'rtsp://192.0.2.10:554/t2', 'path_t2', 'T2');
    const proc = spawnsFor('path_t2').at(-1);
    assert.ok(proc instanceof KillEpermFfmpeg, 'precondition');
    // The transcoder's own kill: a corrupt timestamp makes it SIGTERM its ffmpeg at once.
    proc.stderr.emit('data', Buffer.from('[mpegts] DTS discontinuity in stream 0\n'));
    assert.deepEqual(proc.signals, ['SIGTERM'], 'precondition: the discontinuity path signalled it');
    assert.equal(isRunning('cam-t2'), true, 'a live ffmpeg was dropped from the map: reconcile would start a second publisher');
    assert.equal(lines('[ffmpeg:path_t2] could not signal ffmpeg').length, 1);
    assert.equal(lines('[ffmpeg:path_t2] could not start ffmpeg').length, 0);
    // A stop whose SIGTERM is refused is not "gone": it waits for its SIGKILL fallback, as for a wedged ffmpeg.
    const stop = track(stopTranscoder('cam-t2'));
    await settle();
    await settle();
    assert.equal(stop.settled, false, 'the stop resolved while the ffmpeg was still running');
    mock.timers.tick(3_000);
    await settle();
    assert.equal(stop.settled, true);
    assert.deepEqual(proc.signals, ['SIGTERM', 'SIGTERM', 'SIGKILL']);
  });
});

describe('#553 the clip segmenter and runFfmpeg', () => {
  test('s1: 127 at once backs off 5, 10 s with one line; an ordinary exit keeps the old 5 s and its own log', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    logger.clear();
    SpawnAs = Exec127Ffmpeg;
    const count = () => spawnsFor('path_s1').length;
    startSegmenter('cam-s1', 'path_s1', { preRollSec: 5, postRollSec: 5 });
    await settle();
    assert.equal(count(), 1, 'precondition: launched');
    assert.equal(lines('[clipseg:path_s1] the segmenter (ffmpeg) could not be run').length, 1);
    mock.timers.tick(4_999);
    assert.equal(count(), 1);
    mock.timers.tick(1);
    assert.equal(count(), 2);
    await settle();
    mock.timers.tick(9_999);
    assert.equal(count(), 2, 'the second relaunch did not wait 10 s: no back-off');
    mock.timers.tick(1);
    assert.equal(count(), 3);
    await settle();
    assert.equal(lines('could not be run').length, 1, 'repeated');
    assert.equal(lines('[clipseg:path_s1] segmenter exited (code 127)').length, 0, 'the old fast-fail line for an exec failure');
    SpawnAs = FakeFfmpeg;
    mock.timers.tick(20_000);
    assert.equal(count(), 4);
    spawned.at(-1).finish(1);
    await settle();
    assert.equal(lines('[clipseg:path_s1] segmenter exited (code 1)').length, 1, 'an ordinary exit is logged as before');
    mock.timers.tick(4_999);
    assert.equal(count(), 4);
    mock.timers.tick(1);
    assert.equal(count(), 5);
    stopSegmenter('cam-s1');
  });

  test('s2: a refused SIGTERM on the segmenter is logged as that, not as a failed start', async () => {
    logger.clear();
    SpawnAs = KillEpermFfmpeg;
    startSegmenter('cam-s2', 'path_s2', { preRollSec: 5, postRollSec: 5 });
    stopSegmenter('cam-s2');
    assert.equal(lines('[clipseg:path_s2] could not signal the segmenter').length, 1);
    assert.equal(lines('[clipseg:path_s2] could not start ffmpeg').length, 0);
  });

  test('r1: runFfmpeg past its deadline with the kill refused rejects with the DEADLINE, not "could not run"', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    logger.clear();
    SpawnAs = KillEpermFfmpeg;
    const run = track(runFfmpeg(['-i', 'clip.mkv'], { deadlineMs: 1_000 }));
    mock.timers.tick(1_000);
    await settle();
    assert.equal(run.settled, true, 'the deadline did not settle it');
    assert.equal(run.ok, false);
    assert.match(run.error.message, /did not finish within 1\.0 s; killed it/);
    assert.doesNotMatch(run.error.message, /EPERM/);
    assert.equal(lines('could not signal ffmpeg').length, 1);
  });
});
