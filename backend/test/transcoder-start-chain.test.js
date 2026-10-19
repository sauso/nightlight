// #478: startTranscoder runs one start at a time PER CAMERA, and a stop reaches a start that is queued or in flight.
//
// THE DEFECT. Two overlapping startTranscoder calls for one camera both stopped the old process, both awaited the
// probe and the MediaMTX checks, and both launched; the second `processes.set` overwrote the first, whose ffmpeg
// kept running, invisible to isRunning() and out of stopTranscoder()'s reach. A stop that landed while a start was
// part-way through found no process to stop, and the start then launched anyway. See lib/transcoder.js.
//
// HOW THIS IS OBSERVED. The four modules transcoder.js talks to are faked (none is in test:core's coverage include
// list, so mock.module() is safe; processGuards.js IS on that list and is NOT mocked). The fake ffmpeg
// (helpers/fakeFfmpeg.js) stays alive until it is killed, which is what a real one does while it streams. The
// probe and the MediaMTX config check can be HELD by the test, which is how a start is parked mid-flight.
// ⚠️ Every assertion is on the set of LIVE fake processes and the address each was spawned with, never on
// isRunning() (except the case that is about isRunning): an orphaned ffmpeg is invisible to isRunning by
// definition, which is the bug. Nothing here depends on how fast the machine is: the tests advance by
// event-loop turns, and every wait is a bounded poll for a condition.
//
// Which cases FAIL on the code before #478 (run against it before the fix landed): a, b (both orders), e, f, f2,
// g, h, i, j, k. Which PASS there by design, kept as guards against a broken chain: c (a rejection only ever
// reached its own caller before, since there was no chain to poison) and d (cameras never waited for each other
// before; a lock that is global instead of per camera fails it).
import { test, mock, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { FakeFfmpeg } from './helpers/fakeFfmpeg.js';

const spawned = [];
mock.module('node:child_process', {
  exports: {
    spawn(command, args) {
      const proc = new FakeFfmpeg(command, args);
      spawned.push(proc);
      return proc;
    },
  },
});

// One awaited step of a start that the test can hold. Not holding, it answers at once with its default. Holding, each
// call parks in `held` until the test releases it (with the default, or with a value of its own). `failOnce(err)`
// makes the next call reject, to drive a start that throws (the real functions never do, which is exactly why the
// chain must not depend on it).
class Step {
  constructor(value) {
    this.value = value;
    this.reset();
  }
  reset() {
    this.holding = false;
    this.held = [];
    this.calls = [];
    this.failures = [];
  }
  hold() {
    this.holding = true;
  }
  failOnce(err) {
    this.failures.push(err);
  }
  call(arg) {
    this.calls.push(arg);
    if (this.failures.length) return Promise.reject(this.failures.shift());
    if (!this.holding) return Promise.resolve(this.value);
    return new Promise((resolve) => {
      this.held.push({ arg, release: (v = this.value) => resolve(v) });
    });
  }
}

// null = "could not probe": transcoder.js then never caches the codec, so EVERY start calls the probe and can be held.
const probe = new Step(null);
const configCheck = new Step(true);
const upserts = [];
mock.module('../src/lib/rtspProbe.js', {
  exports: { ffprobeAudioCodec: (url) => probe.call(url) },
});
mock.module('../src/lib/mediamtx.js', {
  exports: {
    hlsPathName: (p) => `${p}-hls`,
    upsertPath: async (p) => { upserts.push(p); },
    isPathConfiguredCorrectly: (p) => configCheck.call(p),
  },
});
mock.module('../src/lib/cameraEvents.js', {
  exports: { recordCameraEvent: () => {}, EVENT: { RESTART: 'restart' } },
});

// Installed before anything runs: a start that rejected with nobody catching it lands here (case c).
const unhandled = [];
process.on('unhandledRejection', (reason) => unhandled.push(reason));

const transcoder = await import('../src/lib/transcoder.js');
const { startTranscoder, stopTranscoder, stopAllTranscoders, isRunning } = transcoder;

const URL1 = 'rtsp://192.0.2.10:554/first';
const URL2 = 'rtsp://192.0.2.10:554/second';

const turn = () => new Promise((r) => setImmediate(r));
const flush = async (n = 10) => {
  for (let i = 0; i < n; i++) await turn();
};
const live = () => spawned.filter((p) => !p.ended);
const urlOf = (proc) => proc.args[proc.args.indexOf('-i') + 1];
function track(promise) {
  const s = { settled: false, ok: undefined, value: undefined, error: undefined };
  promise.then(
    (value) => Object.assign(s, { settled: true, ok: true, value }),
    (error) => Object.assign(s, { settled: true, ok: false, error }),
  );
  return s;
}
// Bounded polls, never durations: a start that never gets there fails the test instead of hanging it.
async function untilHeld(step, n, what) {
  for (let i = 0; i < 500; i++) {
    if (step.held.length >= n) return;
    await turn();
  }
  assert.fail(`${what}: expected ${n} held call(s), have ${step.held.length}`);
}
// Release whatever is held, one call at a time with turns in between, until every tracked start has settled.
// `reverse` releases the newest held call first: on code with no chain, two starts are held at once, and releasing
// the second first is the order in which the OLD address launches last.
async function releaseUntilSettled(tracked, { steps = [probe, configCheck], reverse = false } = {}) {
  for (let i = 0; i < 500 && !tracked.every((t) => t.settled); i++) {
    await flush(2);
    for (const step of steps) {
      const batch = step.held.splice(0);
      if (reverse) batch.reverse();
      for (const h of batch) {
        h.release();
        await flush(2);
      }
    }
  }
  assert.ok(tracked.every((t) => t.settled), 'a start never settled');
}

afterEach(async () => {
  // Release anything a failed case left parked, then stop everything, so no case inherits a live process.
  probe.holding = false;
  configCheck.holding = false;
  for (const step of [probe, configCheck]) for (const h of step.held.splice(0)) h.release();
  await flush();
  await stopAllTranscoders();
  await flush();
  probe.reset();
  configCheck.reset();
  spawned.length = 0;
  upserts.length = 0;
  unhandled.length = 0;
});

describe('#478: one start at a time per camera', () => {
  test('a: two overlapping starts for one camera leave exactly ONE live ffmpeg, and the first is the one stopped', async () => {
    probe.hold();
    const a = track(startTranscoder('cam-a', URL1, 'path_a', 'A'));
    await untilHeld(probe, 1, 'the first start never reached its probe');
    // The first start is part-way through (past its own stop, waiting on the probe) when the second arrives.
    const b = track(startTranscoder('cam-a', URL1, 'path_a', 'A'));
    await releaseUntilSettled([a, b]);

    assert.equal(spawned.length, 2, `precondition: both starts launched (spawned ${spawned.length})`);
    assert.equal(live().length, 1, `${live().length} ffmpeg processes alive for one camera: one is orphaned`);
    assert.equal(spawned[0].ended, true, 'the first ffmpeg was never stopped');
    assert.deepEqual(spawned[0].signals, ['SIGTERM']);
    assert.equal(live()[0], spawned[1]);
  });

  for (const reverse of [false, true]) {
    test(`b: a second start with a DIFFERENT address ends with that address running (held calls released ${reverse ? 'newest first' : 'in order'})`, async () => {
      probe.hold();
      const a = track(startTranscoder('cam-b', URL1, 'path_b', 'B'));
      await untilHeld(probe, 1, 'the first start never reached its probe');
      const b = track(startTranscoder('cam-b', URL2, 'path_b', 'B'));
      await flush();
      await releaseUntilSettled([a, b], { reverse });

      assert.ok(a.ok && b.ok, 'a start rejected');
      assert.equal(live().length, 1, `${live().length} ffmpeg processes alive for one camera`);
      assert.equal(urlOf(live()[0]), URL2, 'the camera ended on the OLD address');
    });
  }

  test('c: a start that rejects rejects for its own caller only; the next start still launches, and nothing is unhandled', async () => {
    const marker = new Error('marker-478-config-check-threw');
    configCheck.failOnce(marker);
    probe.hold();
    const a = track(startTranscoder('cam-c', URL1, 'path_c', 'C'));
    await untilHeld(probe, 1, 'the first start never reached its probe');
    const b = track(startTranscoder('cam-c', URL2, 'path_c', 'C'));
    await releaseUntilSettled([a, b]);
    await flush();

    assert.equal(a.ok, false, 'the failing start resolved');
    assert.equal(a.error, marker, 'the failing start rejected with something else');
    assert.equal(b.ok, true, `the start queued behind a failure rejected too: ${b.error?.message}`);
    assert.equal(live().length, 1);
    assert.equal(urlOf(live()[0]), URL2);
    assert.deepEqual(unhandled, [], 'a rejection escaped as an unhandledRejection');
  });

  test('d: starts for DIFFERENT cameras run at the same time (the chain is per camera, not one global lock)', async () => {
    probe.hold();
    const a = track(startTranscoder('cam-d1', URL1, 'path_d1', 'D1'));
    const b = track(startTranscoder('cam-d2', URL2, 'path_d2', 'D2'));
    // Both are part-way through at once. Behind one global lock the second would not reach its probe at all.
    await untilHeld(probe, 2, 'the second camera waited for the first');
    await releaseUntilSettled([a, b]);

    assert.equal(live().length, 2);
    assert.deepEqual(live().map(urlOf).sort(), [URL1, URL2]);
  });

  test('e: the per-camera records are gone once their starts settle, whatever happened to them', async () => {
    assert.equal(typeof transcoder.startChainCountForTest, 'function', 'there is no per-camera chain to inspect');
    const records = () => transcoder.startChainCountForTest();

    // A start that rejects.
    configCheck.failOnce(new Error('marker-478-e'));
    await assert.rejects(startTranscoder('cam-e', URL1, 'path_e', 'E'), /marker-478-e/);
    assert.equal(records(), 0, 'a rejected start left its record behind');

    // A start that launches.
    await startTranscoder('cam-e', URL1, 'path_e', 'E');
    assert.equal(records(), 0, 'a start that launched left its record behind');

    // Two overlapping starts, the second queued behind the first, both stopped part-way.
    probe.hold();
    const a = track(startTranscoder('cam-e', URL1, 'path_e', 'E'));
    await untilHeld(probe, 1, 'the start never reached its probe');
    const b = track(startTranscoder('cam-e', URL2, 'path_e', 'E'));
    assert.equal(records(), 1, 'precondition: the overlapping starts share one record');
    await stopTranscoder('cam-e');
    await releaseUntilSettled([a, b]);
    assert.equal(records(), 0, 'stopped starts left their record behind');

    // A stop for a camera with no start pending creates nothing either.
    await stopTranscoder('cam-e-never-started');
    assert.equal(records(), 0, 'a stop with no start pending left a record behind');
  });
});

describe('#478: a stop reaches a start that is queued or in flight', () => {
  test('f, l: a stop while the start waits on MediaMTX leaves nothing running, and the stopped start RESOLVES', async () => {
    configCheck.hold();
    const raw = startTranscoder('cam-f', URL1, 'path_f', 'F');
    const a = track(raw);
    await untilHeld(configCheck, 1, 'the start never reached the -hls config check');
    // The camera is disabled now: there is no process yet, so before #478 this stopped nothing.
    await stopTranscoder('cam-f');
    await releaseUntilSettled([a]);

    assert.equal(spawned.length, 0, 'a stopped start launched ffmpeg');
    assert.equal(live().length, 0);
    // (l) Not a rejection: the restart route would answer 502, and reconcile would re-run its pass.
    await assert.doesNotReject(raw);
    assert.equal(a.ok, true);
  });

  test('f2: a stop while the start waits on MediaMTX does not re-create the -hls path afterwards', async () => {
    configCheck.hold();
    const a = track(startTranscoder('cam-f2', URL1, 'path_f2', 'F2'));
    await untilHeld(configCheck, 1, 'the start never reached the -hls config check');
    await stopTranscoder('cam-f2'); // e.g. DELETE, which then removes path_f2-hls
    configCheck.held.splice(0).forEach((h) => h.release(false)); // "missing": the start would write it
    await releaseUntilSettled([a]);

    assert.deepEqual(upserts, [], 'the -hls path of a stopped camera was written again');
    assert.equal(live().length, 0);
  });

  test('g: a stop while a start is QUEUED behind another launches neither (the generation is read at enqueue)', async () => {
    probe.hold();
    const a = track(startTranscoder('cam-g', URL1, 'path_g', 'G'));
    await untilHeld(probe, 1, 'the first start never reached its probe');
    const b = track(startTranscoder('cam-g', URL2, 'path_g', 'G')); // queued behind a
    await flush();
    // The disable lands while b is still waiting its turn. A b that read the generation only when it began would
    // see the post-disable one and launch a disabled camera, which nothing ever stops again (#253's shape).
    await stopTranscoder('cam-g');
    await releaseUntilSettled([a, b]);

    assert.ok(a.ok && b.ok, 'a stopped start rejected');
    assert.equal(spawned.length, 0, `${spawned.length} ffmpeg launched for a camera stopped before either start finished`);
    assert.deepEqual(probe.calls, [URL1], 'the queued start still probed the camera after it was stopped');
  });

  test('h: a start requested AFTER a stop does launch, with its own address', async () => {
    probe.hold();
    const a = track(startTranscoder('cam-h', URL1, 'path_h', 'H'));
    await untilHeld(probe, 1, 'the first start never reached its probe');
    await stopTranscoder('cam-h'); // disable...
    const b = track(startTranscoder('cam-h', URL2, 'path_h', 'H')); // ...then enable
    await releaseUntilSettled([a, b]);

    assert.equal(live().length, 1, `${live().length} ffmpeg alive for the camera switched back on, expected exactly its own`);
    assert.equal(urlOf(live()[0]), URL2);
    assert.equal(spawned.length, 1, 'the start stopped before it launched launched anyway');
  });

  test('i: stopAllTranscoders during a start that has no process yet leaves nothing running', async () => {
    probe.hold();
    const a = track(startTranscoder('cam-i', URL1, 'path_i', 'I'));
    await untilHeld(probe, 1, 'the start never reached its probe');
    // Not in `processes` (no process yet) and not in `pendingRestarts`: before #478 shutdown never saw it.
    await stopAllTranscoders();
    await releaseUntilSettled([a]);

    assert.equal(spawned.length, 0, 'a start launched ffmpeg after shutdown had stopped everything');
  });
});

describe('#478: isRunning and the dedupe of queued requests', () => {
  test('j: isRunning is true while a start is pending, and false right after a start that launched nothing settles', async () => {
    probe.hold();
    const raw = startTranscoder('cam-j', URL1, 'path_j', 'J');
    assert.equal(isRunning('cam-j'), true, 'a start just queued is reported as not running');
    await untilHeld(probe, 1, 'the start never reached its probe');
    // Between its own stop and its launch nothing is in `processes`. Reconcile reads isRunning here.
    assert.equal(isRunning('cam-j'), true, 'a start in flight is reported as not running, so reconcile would queue another');
    await stopTranscoder('cam-j');
    probe.held.splice(0).forEach((h) => h.release());
    await raw;
    // Synchronously, straight after the await: the start's own cleanup ran before its caller resumed.
    assert.equal(isRunning('cam-j'), false, 'still "running" right after a start that launched nothing');

    // Control: a start that did launch is running afterwards, and a stop ends that.
    probe.holding = false;
    await startTranscoder('cam-j', URL1, 'path_j', 'J');
    assert.equal(isRunning('cam-j'), true);
    await stopTranscoder('cam-j');
    assert.equal(isRunning('cam-j'), false);
  });

  test('k1: same arguments, same generation, still queued: one start shared; never the one in flight', async () => {
    probe.hold();
    const a = startTranscoder('cam-k', URL1, 'path_k', 'K');
    await untilHeld(probe, 1, 'the first start never reached its probe');
    const b = startTranscoder('cam-k', URL1, 'path_k', 'K');
    const c = startTranscoder('cam-k', URL1, 'path_k', 'K');
    assert.notEqual(b, a, 'a request joined the start already in flight');
    assert.equal(c, b, 'an identical request queued a second start behind an identical queued one');
    const tracked = [a, b].map(track);
    await releaseUntilSettled(tracked);

    assert.equal(spawned.length, 2, `${spawned.length} launches for one in-flight and one queued start`);
    assert.equal(live().length, 1, `${live().length} ffmpeg alive for one camera`);
  });

  test('k2: different arguments, or a request no longer last in line, get starts of their own, in order', async () => {
    probe.hold();
    const a = startTranscoder('cam-k2', URL1, 'path_k2', 'K2');
    await untilHeld(probe, 1, 'the first start never reached its probe');
    const b = startTranscoder('cam-k2', URL1, 'path_k2', 'K2');
    const c = startTranscoder('cam-k2', URL2, 'path_k2', 'K2'); // a new address
    const d = startTranscoder('cam-k2', URL1, 'path_k2', 'K2'); // same as b, but c is queued after b now
    assert.notEqual(c, b);
    assert.notEqual(d, b, 'joining b would run this request before c, and the camera would end on c\'s address');
    await releaseUntilSettled([a, b, c, d].map(track));

    assert.equal(spawned.length, 4);
    assert.deepEqual(spawned.map(urlOf), [URL1, URL1, URL2, URL1], 'the starts did not run in the order they were asked for');
    assert.equal(live().length, 1, `${live().length} ffmpeg alive for one camera`);
    assert.equal(urlOf(live()[0]), URL1);
  });

  test('k3: a stop between two identical requests separates them: disable then enable brings the camera back', async () => {
    probe.hold();
    const a = startTranscoder('cam-k3', URL1, 'path_k3', 'K3');
    await untilHeld(probe, 1, 'the first start never reached its probe');
    const b = startTranscoder('cam-k3', URL1, 'path_k3', 'K3'); // queued
    await stopTranscoder('cam-k3'); // disable: a and b are both stopped
    const c = startTranscoder('cam-k3', URL1, 'path_k3', 'K3'); // enable: identical arguments, new generation
    assert.notEqual(c, b, 'the enable joined a start the disable had stopped');
    await releaseUntilSettled([a, b, c].map(track));

    assert.equal(live().length, 1, `${live().length} ffmpeg alive after disable then enable (0 = enabled with no transcoder)`);
    assert.equal(spawned.length, 1);
  });
});
