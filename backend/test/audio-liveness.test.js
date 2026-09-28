// lib/audioLiveness.js: the two ffprobe liveness probes, driven through a mocked `node:child_process`.
//
// #369 added `probeVideoFlowing`, the detector watchdog's DIAGNOSTIC probe, and put this module into test:core's
// coverage include list. Until then `probeAudioFlowing` had no direct test at all (plan v5, verified facts), so
// its existing behaviour is pinned here too, as a characterization: nothing about it changed in #369.
//
// HOW: `node:child_process` is the only thing mocked. It is not in test:core's include list, so mocking it is
// safe; mock.module() of an INCLUDED module (this one, or processGuards.js) would corrupt coverage for the whole
// suite. The fake process is the shared one from helpers/fakeFfmpeg.js. Timers are mocked per test only where a
// test is about a timer.
import { test, mock, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { FakeFfmpeg } from './helpers/fakeFfmpeg.js';
import { useTempDataDir, cleanupTempDataDirs } from './helpers/harness.js';

// A5 drives the REAL audio watchdog, whose module loads db.js: point it at a throwaway data dir first.
useTempDataDir();
after(() => cleanupTempDataDirs());

// What each spawn does is up to the test: `onSpawn(proc)` runs synchronously after the fake is built, and may
// throw to simulate spawn() itself throwing.
let onSpawn = () => {};
const spawned = [];
mock.module('node:child_process', {
  exports: {
    spawn(command, args, opts) {
      const proc = new FakeFfmpeg(command, args);
      proc.opts = opts;
      spawned.push(proc);
      onSpawn(proc);
      return proc;
    },
  },
});

const { probeVideoFlowing, probeAudioFlowing, tracksHaveAudio } = await import('../src/lib/audioLiveness.js');
const { createAudioWatchdog } = await import('../src/lib/cameraWatchdogs.js');

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};
// ffprobe's csv output, one codec_type per packet line.
const lines = (...types) => Buffer.from(types.map((t) => `${t}\n`).join(''));
// Resolve the probe while reporting whether it had settled at each step.
function track(promise) {
  const s = { settled: false, value: undefined };
  promise.then((v) => { s.settled = true; s.value = v; });
  return s;
}
// A clean ffprobe run: print, then exit 0 the way Node orders it ('exit', stream ends, 'close').
async function runProbe(stdoutChunks, { code = 0 } = {}) {
  onSpawn = (proc) => {
    queueMicrotask(() => {
      for (const c of stdoutChunks) proc.stdout.emit('data', c);
      proc.finish(code);
    });
  };
  return probeVideoFlowing('cam_v-sub');
}

beforeEach(() => {
  spawned.length = 0;
  onSpawn = () => {};
});

describe('probeVideoFlowing (#369 claim 19): a diagnosis, never proof', () => {
  test('V1: runs ffprobe over ALL streams, time-bounded, printing one codec_type per packet (no -select_streams)', async () => {
    await runProbe([]);
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].command, 'ffprobe');
    // The exact argument list the plan specifies. A copy of the audio probe's `-select_streams a:0` would make
    // 'video-missing' unobservable, and a packet-count interval (`%+#20`) would not be time-bounded.
    assert.deepEqual(spawned[0].args, [
      '-v', 'error',
      '-rtsp_transport', 'tcp',
      '-read_intervals', '%+5',
      '-show_entries', 'packet=codec_type',
      '-of', 'csv=p=0',
      '-i', 'rtsp://127.0.0.1:8554/cam_v-sub',
    ]);
    assert.deepEqual(spawned[0].opts, { stdio: ['ignore', 'pipe', 'ignore'] });
  });

  test('V2: at least one VIDEO packet => true, whatever else arrived', async () => {
    assert.equal(await runProbe([lines('audio', 'audio', 'video', 'audio')]), true);
    assert.equal(await runProbe([lines('video')]), true, 'a single video packet is enough');
  });

  test('V3: audio packets and NO video packet => "video-missing" (the observed #369 failure)', async () => {
    assert.equal(await runProbe([lines('audio', 'audio', 'audio')]), 'video-missing');
    assert.equal(await runProbe([lines('audio')]), 'video-missing', 'a single audio packet is enough');
    // Any other packet type (a data or subtitle stream) is neither: it can not stand in for audio or video.
    assert.equal(await runProbe([lines('data', 'audio', 'subtitle')]), 'video-missing');
  });

  test('V4: nothing at all => null (a probe cannot prove a negative)', async () => {
    assert.equal(await runProbe([]), null);
    assert.equal(await runProbe([lines('data', 'subtitle')]), null, 'only non-audio, non-video packets');
    assert.equal(await runProbe([Buffer.from('\n\n  \n')]), null, 'blank lines are not packets');
  });

  test('V5: a non-zero exit => null, even after it printed video packets', async () => {
    assert.equal(await runProbe([lines('video', 'video')], { code: 1 }), null);
    assert.equal(await runProbe([lines('audio')], { code: 1 }), null);
    // Killed by someone else: exit code null.
    assert.equal(await runProbe([lines('video')], { code: null }), null);
  });

  test('V6: a spawn failure => null, whether spawn() throws or the child emits error', async () => {
    onSpawn = () => { throw new Error('spawn EAGAIN'); };
    assert.equal(await probeVideoFlowing('cam_v'), null, 'spawn() threw');

    onSpawn = (proc) => {
      proc.pid = undefined; // a child that never started has no pid
      queueMicrotask(() => proc.emit('error', Object.assign(new Error('spawn ffprobe ENOENT'), { code: 'ENOENT' })));
    };
    const s = track(probeVideoFlowing('cam_v'));
    await flush();
    assert.deepEqual(s, { settled: true, value: null }, 'the error event did not resolve null');
  });

  test('V7: the 8 s kill timer fires: SIGKILL, and null even though a video line had been printed', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    // A stalled RTSP setup: the probe never exits by itself. It did print one video line (an unflushed buffer
    // would usually hold none; this is the hostile case), which a timed-out probe must NOT report as flowing.
    onSpawn = (proc) => queueMicrotask(() => proc.stdout.emit('data', lines('video')));
    const s = track(probeVideoFlowing('cam_v'));
    await flush();
    t.mock.timers.tick(7_999);
    await flush();
    assert.equal(s.settled, false, 'the probe gave up before 8 s');
    assert.deepEqual(spawned[0].signals, [], 'killed before 8 s');
    t.mock.timers.tick(1);
    await flush();
    assert.deepEqual(spawned[0].signals, ['SIGKILL'], 'the timer did not kill the probe');
    assert.deepEqual(s, { settled: true, value: null });
  });

  test('V8: packets drained AFTER exit are counted: it classifies on close, not exit', async () => {
    // Node can deliver a child's last stdout after 'exit' (processOutput.js), and a block-buffered ffprobe
    // writes everything at the end, so this is the normal shape of a real run, not an edge.
    onSpawn = (proc) => queueMicrotask(() => {
      proc.ended = true;
      proc.emit('exit', 0, null);
      proc.stdout.emit('data', lines('audio', 'video'));
      proc.stdout.emit('end');
      proc.emit('close', 0, null);
    });
    assert.equal(await probeVideoFlowing('cam_v'), true);
  });

  test('V9: lines are counted whole, however stdout is chunked, including a last line with no newline', async () => {
    assert.equal(await runProbe([Buffer.from('aud'), Buffer.from('io\nau'), Buffer.from('dio')]), 'video-missing');
    assert.equal(await runProbe([Buffer.from('audio\nvid'), Buffer.from('eo')]), true, 'the unterminated last line');
    // A line split across two chunks is still a video packet: two fragments ('vi', 'deo') would be neither.
    assert.equal(await runProbe([Buffer.from('vi'), Buffer.from('deo\n')]), true);
  });
});

describe('probeAudioFlowing (characterization: unchanged by #369, first direct test)', () => {
  test('A1: three audio packets => true at once, and the probe is killed rather than left running', async () => {
    onSpawn = (proc) => queueMicrotask(() => proc.stdout.emit('data', Buffer.from('0.02\n0.04\n0.06\n')));
    assert.equal(await probeAudioFlowing('cam_a'), true);
    assert.deepEqual(spawned[0].args.slice(0, 6), ['-v', 'error', '-rtsp_transport', 'tcp', '-select_streams', 'a:0']);
    assert.deepEqual(spawned[0].signals, ['SIGKILL']);
  });

  test('A2: it exits after ONE packet => true; after none => false (the verified one-packet behaviour)', async () => {
    onSpawn = (proc) => queueMicrotask(() => {
      proc.stdout.emit('data', Buffer.from('0.02\n'));
      proc.finish(0);
    });
    assert.equal(await probeAudioFlowing('cam_a'), true);
    onSpawn = (proc) => queueMicrotask(() => proc.finish(0));
    assert.equal(await probeAudioFlowing('cam_a'), false);
  });

  test('A3: spawn failures => null; the 6 s timeout => false with no packets, true with one', async (t) => {
    onSpawn = () => { throw new Error('spawn EAGAIN'); };
    assert.equal(await probeAudioFlowing('cam_a'), null);
    onSpawn = (proc) => queueMicrotask(() => proc.emit('error', new Error('ENOENT')));
    assert.equal(await probeAudioFlowing('cam_a'), null);

    t.mock.timers.enable({ apis: ['setTimeout'] });
    onSpawn = () => {};
    const silent = track(probeAudioFlowing('cam_a'));
    await flush();
    t.mock.timers.tick(6_000);
    await flush();
    assert.deepEqual(silent, { settled: true, value: false });

    onSpawn = (proc) => queueMicrotask(() => proc.stdout.emit('data', Buffer.from('0.02\n')));
    const one = track(probeAudioFlowing('cam_a'));
    await flush();
    t.mock.timers.tick(6_000);
    await flush();
    assert.deepEqual(one, { settled: true, value: true });
  });

  test('A4: tracksHaveAudio recognises MediaMTX audio codec names only', () => {
    assert.equal(tracksHaveAudio(['H264', 'G711']), true);
    assert.equal(tracksHaveAudio(['H264', 'MPEG-4 Audio']), true);
    assert.equal(tracksHaveAudio(['H264']), false);
    assert.equal(tracksHaveAudio([]), false);
    assert.equal(tracksHaveAudio(undefined), false);
  });

  test('A5: composed with the REAL audio watchdog, a probe that HANGS and prints nothing is a stall: two in a row restart the transcoder', async (t) => {
    // Why this is pinned end to end (#369 review fix round, 2026-09-28). A camera whose audio track is declared
    // but carries no data makes ffprobe hang, not exit: `-select_streams a:0 -read_intervals %+#20` counts
    // AUDIO packets only and live RTSP never ends, so only the 6 s timer ends it. And stdout is block-buffered,
    // so a killed probe has usually printed nothing. That timeout-with-zero-packets reading IS the audio
    // watchdog's stall signal, by design ("only a genuinely stalled one waits the full 6s timeout", above
    // AUDIO_CHECK_INTERVAL_MS in cameraWatchdogs.js). A3 pins the probe's half and camera-watchdogs.test.js W7
    // the watchdog's half, but nothing pinned the two together, so a review round proposed reading that timeout
    // as `null` ("inconclusive") believing this caller would not notice. It would: `null` resets the stall count
    // (W15), so this camera would never be restarted (verified: with that change this test fails, restarts []).
    // Changing it is a decision about the audio watchdog, not a probe fix.
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const cam = { id: 'a5', name: 'A5', mediamtx_path: 'cam_a5', rtsp_url: 'rtsp://192.0.2.10:554/a5', disabled: 0 };
    const restarts = [];
    let clock = Date.UTC(2026, 8, 28, 3, 0, 0);
    // Only the collaborators around the probe are faked: probeAudioFlowing and tracksHaveAudio are the real
    // defaults, the probe spawning through this file's mocked child_process.
    const w = createAudioWatchdog({
      listCameras: () => [cam],
      getPathStatus: async () => ({ ready: true, tracks: ['H264', 'G711'] }),
      startTranscoder: async (id) => { restarts.push(id); },
      recordCameraEvent: () => {},
      now: () => clock,
    });
    onSpawn = () => {}; // the hang: no stdout, never exits by itself
    const tickThroughTheTimeout = async () => {
      const done = w.tick();
      await flush();
      t.mock.timers.tick(6_000);
      await flush();
      await done;
    };
    await tickThroughTheTimeout();
    assert.equal(spawned.length, 1, 'precondition: the watchdog did not run the real probe');
    assert.deepEqual(spawned[0].signals, ['SIGKILL'], 'precondition: the probe was not ended by its own timeout');
    assert.deepEqual(restarts, [], 'one hung probe restarted the camera: the rule is two consecutive stalls');
    clock += 30_000;
    await tickThroughTheTimeout();
    assert.equal(spawned.length, 2, 'precondition: the second tick did not probe');
    assert.deepEqual(restarts, ['a5'], 'two consecutive hung, empty probes did not restart the transcoder');
  });
});
