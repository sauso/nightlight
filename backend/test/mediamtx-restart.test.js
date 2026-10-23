// #479: restartMediaMTX() signals the MediaMTX child and lets the exit handler relaunch it.
//
// WHAT MUST HOLD (found by the plan review of #479):
//  * The SIGKILL fallback is aimed at THE CHILD THAT WAS SIGNALLED, never at whatever `proc` is when the timer fires.
//    RESTART_DELAY_MS is 3 s and the fallback is 5 s, so a child that obeys SIGTERM is replaced before the timer fires, and
//    a timer that read `proc` would kill the NEW MediaMTX (case r1).
//  * A child that ignores SIGTERM is SIGKILLed after 5 s and then relaunched (r2); one that survives even that is not
//    abandoned silently: a second restart signals it again (r3).
//  * Nothing is signalled or relaunched once stopMediaMTX() has run (r4, ordered LAST: `stopped` latches for the life of
//    the module).
//
// HOW THIS IS OBSERVED. child_process is faked, as webrtc-udp-port-launch.test.js does (mediamtxProcess.js and childEnv.js
// are not in test:core's include list, so mock.module is safe). Each fake records the signals it receives; its 'exit' is
// emitted in a microtask, like a real child's, so every step that ends a child is followed by `settle()` before the clock
// moves. Timers are the mock clock after the first launch, which never waits for a network address when the machine has one.
import { test, describe, after, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupTempDataDirs } from './helpers/harness.js';
import { FakeFfmpeg, WedgedFfmpeg, UnkillableFfmpeg } from './helpers/fakeFfmpeg.js';

useTempDataDir();

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

const { startMediaMTX, stopMediaMTX, restartMediaMTX } = await import('../src/lib/mediamtxProcess.js');

const RESTART_DELAY_MS = 3000;
const FORCE_KILL_MS = 5000;
const AFTER_RELAUNCH_MS = 1500;
const settle = () => new Promise((resolve) => setImmediate(resolve)); // real setImmediate: only setTimeout is mocked

let started = false;
async function launchOnce() {
  if (!started) {
    await startMediaMTX('mediamtx.yml');
    started = true;
  }
}

// Restart whatever is running and let the exit handler relaunch it as `Kind`: the way to get a wedged child running.
async function relaunchAs(Kind) {
  SpawnAs = Kind;
  restartMediaMTX();
  await settle();
  mock.timers.tick(FORCE_KILL_MS); // an obedient child is relaunched inside this tick; a wedged one is SIGKILLed at its end
  await settle();
  mock.timers.tick(RESTART_DELAY_MS);
  const fresh = spawned.at(-1);
  assert.ok(fresh instanceof Kind, `precondition: the relaunched child is a ${Kind.name}`);
  return fresh;
}

beforeEach(() => {
  spawned.length = 0;
  SpawnAs = FakeFfmpeg;
});
afterEach(() => {
  mock.timers.reset();
});
after(() => {
  stopMediaMTX();
  cleanupTempDataDirs();
});

describe('restartMediaMTX', () => {
  test('r1: a child that obeys SIGTERM is relaunched after 3 s, and the 5 s fallback never touches the NEW child', async () => {
    await launchOnce();
    assert.equal(spawned.length, 1, 'launch() never reached spawn');
    const old = spawned[0];
    mock.timers.enable({ apis: ['setTimeout'] });
    const hooked = [];

    assert.equal(restartMediaMTX({ onRelaunched: () => hooked.push('recovery') }), true);
    assert.deepEqual(old.signals, ['SIGTERM']);
    assert.equal(old.ended, true, 'precondition: the fake child exited on SIGTERM');
    assert.deepEqual(hooked, [], 'the recovery ran at the SIGTERM, when it would ask the OLD MediaMTX');
    await settle();
    mock.timers.tick(RESTART_DELAY_MS);
    assert.equal(spawned.length, 2, 'the exit handler did not relaunch MediaMTX');
    const fresh = spawned[1];
    // The recovery waits for the NEW MediaMTX to open its API, not just to be spawned.
    mock.timers.tick(AFTER_RELAUNCH_MS - 1);
    assert.deepEqual(hooked, [], 'the recovery ran before the new MediaMTX had time to open its API');
    mock.timers.tick(1);
    assert.deepEqual(hooked, ['recovery']);
    mock.timers.tick(FORCE_KILL_MS + 1000);
    assert.deepEqual(hooked, ['recovery'], 'the recovery ran twice');
    // (Two guards stop the old child's SIGKILL reaching the new one: the timer targets the child it signalled, and it is
    // cleared when that child exits. Either alone suffices, so this pins them together.)
    assert.deepEqual(fresh.signals, [], 'the SIGKILL fallback of the OLD child killed the new MediaMTX');
    assert.deepEqual(old.signals, ['SIGTERM'], 'the old child, already gone, was signalled again');
  });

  test('r2: a child that ignores SIGTERM is SIGKILLed after 5 s (not before), then relaunched', async () => {
    await launchOnce();
    mock.timers.enable({ apis: ['setTimeout'] });
    const wedged = await relaunchAs(WedgedFfmpeg);
    const before = spawned.length;

    assert.equal(restartMediaMTX(), true);
    assert.deepEqual(wedged.signals, ['SIGTERM']);
    assert.equal(wedged.ended, false, 'precondition: it ignored SIGTERM');
    mock.timers.tick(FORCE_KILL_MS - 1);
    assert.deepEqual(wedged.signals, ['SIGTERM'], 'SIGKILL came early');
    mock.timers.tick(1);
    assert.deepEqual(wedged.signals, ['SIGTERM', 'SIGKILL']);
    assert.equal(wedged.ended, true);
    await settle();
    SpawnAs = FakeFfmpeg; // the relaunch below must not leave a wedged child for the next case
    mock.timers.tick(RESTART_DELAY_MS);
    assert.equal(spawned.length, before + 1, 'the exit handler did not relaunch after the SIGKILL');
  });

  test('r3: a child that survives even SIGKILL is signalled again by the next restart, and is not relaunched on top of itself', async () => {
    await launchOnce();
    mock.timers.enable({ apis: ['setTimeout'] });
    const stuck = await relaunchAs(UnkillableFfmpeg);
    const before = spawned.length;

    assert.equal(restartMediaMTX(), true);
    mock.timers.tick(FORCE_KILL_MS);
    assert.deepEqual(stuck.signals, ['SIGTERM', 'SIGKILL']);
    mock.timers.tick(RESTART_DELAY_MS * 3);
    assert.equal(spawned.length, before, 'a second MediaMTX was started beside one that has not exited');
    assert.equal(restartMediaMTX(), true);
    assert.deepEqual(stuck.signals, ['SIGTERM', 'SIGKILL', 'SIGTERM']);
    SpawnAs = FakeFfmpeg; // the relaunch below must not leave an unkillable child for the next case
    stuck.finish(null, 'SIGKILL'); // it finally exits: the handler relaunches
    await settle();
    mock.timers.tick(RESTART_DELAY_MS);
    assert.equal(spawned.length, before + 1);
  });

  test('r4: stopMediaMTX() after a restart: a child that dies on its own is not relaunched, its fallback kills nothing, and no restart is signalled', async () => {
    await launchOnce();
    mock.timers.enable({ apis: ['setTimeout'] });
    const wedged = await relaunchAs(WedgedFfmpeg);
    const before = spawned.length;
    const hooked = [];
    restartMediaMTX({ onRelaunched: () => hooked.push('recovery') }); // SIGTERM ignored, fallback armed
    wedged.finish(null, 'SIGTERM'); // it dies on its own before the fallback
    await settle();
    stopMediaMTX(); // `stopped` latches: nothing relaunches from here on
    mock.timers.tick(FORCE_KILL_MS + RESTART_DELAY_MS + AFTER_RELAUNCH_MS + 1000);
    assert.deepEqual(hooked, [], 'the recovery of a restart that never relaunched still ran');
    assert.ok(!wedged.signals.includes('SIGKILL'), 'the cleared fallback still fired');
    assert.equal(spawned.length, before, 'MediaMTX was relaunched after stopMediaMTX()');
    assert.equal(restartMediaMTX(), false, 'a restart was signalled after stopMediaMTX()');
  });
});
