// #478: ffprobeAudioCodec settles at its 9 s deadline even if the killed child never reports 'exit'.
//
// WHY IT MATTERS NOW. The transcoder awaits this probe inside its per-camera start chain (lib/transcoder.js), so
// a probe that never settles holds that camera's every later start, restarts and edits included, forever. Before
// #478 it resolved only on 'exit', which normally follows the SIGKILL at once, so it was bounded in practice
// only. A process stuck in an uninterruptible wait does not exit when killed.
//
// HOW: `node:child_process` is the only thing mocked (not in test:core's include list). The fake ignores every
// signal, so it never exits by itself; timers are mocked, so the 9 s is ticked, not waited.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { FakeFfmpeg } from './helpers/fakeFfmpeg.js';

// A probe that records the signals it is sent and never exits.
class StuckProbe extends FakeFfmpeg {
  kill(signal) {
    this.signals.push(signal);
    return true;
  }
}

const spawned = [];
mock.module('node:child_process', {
  exports: {
    spawn(command, args) {
      const proc = new StuckProbe(command, args);
      spawned.push(proc);
      return proc;
    },
  },
});

const { ffprobeAudioCodec } = await import('../src/lib/rtspProbe.js');

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};
function track(promise) {
  const s = { settled: false, value: undefined };
  promise.then((v) => Object.assign(s, { settled: true, value: v }));
  return s;
}

test('a probe whose child never exits after SIGKILL still resolves null at 9 s', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const s = track(ffprobeAudioCodec('rtsp://192.0.2.10:554/ch0'));
  await flush();
  assert.equal(spawned.length, 1, 'precondition: ffprobe was spawned');

  t.mock.timers.tick(8_999);
  await flush();
  assert.equal(s.settled, false, 'the probe gave up before its 9 s deadline');
  assert.deepEqual(spawned[0].signals, []);

  t.mock.timers.tick(1);
  await flush();
  assert.deepEqual(spawned[0].signals, ['SIGKILL'], 'the deadline did not kill the probe');
  assert.deepEqual(s, { settled: true, value: null }, 'a killed probe that never reported exit never settled');
});

test('control: a probe that exits normally still reports its codec', async () => {
  const p = ffprobeAudioCodec('rtsp://192.0.2.10:554/ch0');
  const proc = spawned.at(-1);
  proc.stdout.emit('data', Buffer.from('aac\n'));
  proc.finish(0);
  assert.equal(await p, 'aac');
});
