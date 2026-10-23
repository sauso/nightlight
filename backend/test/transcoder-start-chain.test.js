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
// g, h, i, i2, s, j, k. Which PASS there by design, kept as guards against a broken chain: c (a rejection only ever
// reached its own caller before, since there was no chain to poison) and d (cameras never waited for each other
// before; a lock that is global instead of per camera fails it). Two were added by the code review of the first
// version of #478: s failed on that version (a start overtook a stop still in progress), and i2 passed on it but
// kills a stopAllTranscoders that skips a camera with more than one start pending, which survived every other case.
// Round 2 added s2, which failed on the round-1 version (shutdown did not wait for a stop already in progress), and
// s3, which kills a stop record that is never deleted (it survived every other case).
import { test, mock, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { FakeFfmpeg, WedgedFfmpeg } from './helpers/fakeFfmpeg.js';

const spawned = [];
// Which fake the next spawn builds. WedgedFfmpeg ignores SIGTERM and dies only on SIGKILL (case s).
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
const removals = [];
// #806: a caller's own pre-launch step (startTranscoder's `prepare`), held the same way.
const prepareStep = new Step(undefined);
mock.module('../src/lib/rtspProbe.js', {
  exports: { ffprobeAudioCodec: (url) => probe.call(url) },
});
mock.module('../src/lib/mediamtx.js', {
  exports: {
    hlsPathName: (p) => `${p}-hls`,
    // subPathName / removePath: subStream.js (the real one, used by the #806 cases) imports them too.
    subPathName: (p) => `${p}-sub`,
    removePath: async (p) => { removals.push(p); },
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
const { startSubStream, stopSubStream } = await import('../src/lib/subStream.js');

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
  prepareStep.holding = false;
  for (const step of [probe, configCheck, prepareStep]) for (const h of step.held.splice(0)) h.release();
  await flush();
  await stopAllTranscoders();
  await flush();
  probe.reset();
  configCheck.reset();
  prepareStep.reset();
  SpawnAs = FakeFfmpeg;
  spawned.length = 0;
  upserts.length = 0;
  removals.length = 0;
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

  test('i2: stopAllTranscoders with one start in flight AND one queued behind it launches neither', async () => {
    // Every camera with a chain record must be stopped, however many starts it holds (#478 code review: a union
    // that took a camera only when ONE start was pending passed every other case here).
    probe.hold();
    const a = track(startTranscoder('cam-i2', URL1, 'path_i2', 'I2'));
    await untilHeld(probe, 1, 'the first start never reached its probe');
    const b = track(startTranscoder('cam-i2', URL2, 'path_i2', 'I2')); // queued behind a
    await stopAllTranscoders();
    await releaseUntilSettled([a, b]);

    assert.ok(a.ok && b.ok, 'a stopped start rejected');
    assert.equal(spawned.length, 0, `${spawned.length} ffmpeg launched after shutdown had stopped everything`);
  });

  test('s: a start waits for a stop still in progress, up to its SIGKILL fallback, even when the old ffmpeg ignores SIGTERM', async (t) => {
    // #478 code review (Codex): a stop deletes the camera from the map at once and then waits up to 3 s for the
    // process to exit. A start in that window found nothing to stop and launched next to the dying process.
    // The 3 s is the SIGKILL fallback (FORCE_KILL_TIMEOUT_MS); mocked, so it is ticked, not waited.
    // NOT covered, by design (round 2): the wait ends when SIGKILL is SENT, and this fake dies at once on it. A real
    // process is gone a moment later, so the start can spawn while it is still exiting; see stopProcess.
    t.mock.timers.enable({ apis: ['setTimeout'] });
    SpawnAs = WedgedFfmpeg;
    await startTranscoder('cam-s', URL1, 'path_s', 'S');
    SpawnAs = FakeFfmpeg;
    const old = spawned[0];
    assert.equal(live().length, 1, 'precondition: the first ffmpeg is running');

    const s = track(stopTranscoder('cam-s')); // e.g. a disable: SIGTERM, which this process ignores
    const c = track(startTranscoder('cam-s', URL2, 'path_s', 'S')); // e.g. the enable, straight after
    await flush(20);
    try {
      assert.deepEqual(old.signals, ['SIGTERM'], 'precondition: the old ffmpeg was sent SIGTERM and is still alive');
      assert.equal(live().length, 1, `${live().length} ffmpeg alive: the start launched next to a process still being stopped`);
      assert.equal(c.settled, false, 'the start finished while the stop was still in progress');
    } finally {
      // Even when an assertion above fails: the SIGKILL must still fire, or the wedged fake outlives this test
      // with a stop that never settles, and afterEach's stopAllTranscoders would wait on it forever.
      t.mock.timers.tick(3000);
      await flush(20);
    }
    assert.deepEqual(old.signals, ['SIGTERM', 'SIGKILL'], 'the stop did not fall back to SIGKILL');
    assert.ok(s.settled, 'the stop never settled');
    assert.ok(c.settled && c.ok, 'the start never launched once the old process was gone');
    assert.equal(live().length, 1);
    assert.equal(urlOf(live()[0]), URL2);
  });

  test('s2: stopAllTranscoders does not settle while an earlier stop is still waiting on its ffmpeg', async (t) => {
    // #478 code review, round 2 (Codex): a process an earlier stop is waiting on is in no map but
    // `stopsInProgress`, so a shutdown that iterated only the other three settled while it was still alive.
    t.mock.timers.enable({ apis: ['setTimeout'] });
    SpawnAs = WedgedFfmpeg;
    await startTranscoder('cam-s2', URL1, 'path_s2', 'S2');
    SpawnAs = FakeFfmpeg;
    const old = spawned[0];

    const s = track(stopTranscoder('cam-s2')); // a disable: SIGTERM, ignored
    const all = track(stopAllTranscoders()); // shutdown while that stop still waits
    await flush(20);
    try {
      assert.equal(all.settled, false, 'shutdown settled while an earlier stop was still waiting on a live ffmpeg');
    } finally {
      // As in s: the SIGKILL must fire even when the assertion fails, or the stop never settles.
      t.mock.timers.tick(3000);
      await flush(20);
    }
    assert.deepEqual(old.signals, ['SIGTERM', 'SIGKILL']);
    assert.ok(s.settled && all.settled, 'shutdown never settled after the SIGKILL fallback');
  });

  test('s3: a stop that has settled leaves no record behind', async () => {
    await startTranscoder('cam-s3', URL1, 'path_s3', 'S3');
    await stopTranscoder('cam-s3');
    assert.equal(transcoder.stopsInProgressCountForTest(), 0, 'a settled stop kept its record');
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

// #806: the stop generation covers the work a caller does BEFORE it can launch, if that work runs inside the start.
// startSubStream used to await its MediaMTX path check first and call startTranscoder afterwards: during that
// round trip no start was queued, so a disable's stopSubStream bumped nothing and the start that followed
// launched a sub transcoder for a camera that was already disabled. Now the check is startTranscoder's `prepare`.
// Which of these FAIL on the code before #806: p1, p2 (no `prepare` option: the held step is never called), r1 and
// r2 (the real startSubStream awaits first). Guards that pass there too: p3 (a rejection only reaches its own caller).
const SUB_CAM = { id: 'cam-r', name: 'R', mediamtx_path: 'path_r', sub_rtsp_url: URL2 };
const SUB_PATH = 'path_r-sub';

describe('#806: a pending sub-stream start is covered by the stop generation', () => {
  test('p1: a stop while a start\'s `prepare` is running abandons the start before it probes or launches', async () => {
    prepareStep.hold();
    const raw = startTranscoder('cam-p1', URL1, 'path_p1', 'P1', { prepare: (stopped) => prepareStep.call(stopped) });
    const a = track(raw);
    await untilHeld(prepareStep, 1, 'the start never reached its prepare step');
    assert.equal(typeof prepareStep.held[0].arg, 'function', 'prepare is handed stopped()');
    assert.equal(prepareStep.held[0].arg(), false, 'stopped() reported a stop that has not happened');
    await stopTranscoder('cam-p1');
    assert.equal(prepareStep.held[0].arg(), true, 'stopped() did not see the stop');
    await releaseUntilSettled([a], { steps: [probe, configCheck, prepareStep] });

    assert.equal(spawned.length, 0, 'a start stopped during its prepare step launched ffmpeg');
    assert.equal(probe.calls.length, 0, 'the stopped start went on to probe the camera');
    await assert.doesNotReject(raw);
  });

  test('p2: without a stop the start waits for its prepare step, then launches once', async () => {
    prepareStep.hold();
    const a = track(startTranscoder('cam-p2', URL1, 'path_p2', 'P2', { prepare: (stopped) => prepareStep.call(stopped) }));
    await untilHeld(prepareStep, 1, 'the start never reached its prepare step');
    await flush();
    assert.equal(spawned.length, 0, 'the start launched before its prepare step finished');
    await releaseUntilSettled([a], { steps: [probe, configCheck, prepareStep] });
    assert.equal(live().length, 1);
    assert.equal(urlOf(live()[0]), URL1);
  });

  test('p3: a prepare step that rejects rejects for its own caller only; the next start still launches', async () => {
    const marker = new Error('marker-806-prepare-threw');
    const a = track(startTranscoder('cam-p3', URL1, 'path_p3', 'P3', { prepare: async () => { throw marker; } }));
    const b = track(startTranscoder('cam-p3', URL2, 'path_p3', 'P3'));
    await releaseUntilSettled([a, b]);
    await flush();

    assert.equal(a.ok, false);
    assert.equal(a.error, marker);
    assert.equal(b.ok, true, `the start queued behind a failed prepare rejected too: ${b.error?.message}`);
    assert.equal(urlOf(live()[0]), URL2);
    assert.deepEqual(unhandled, []);
  });

  test('r1: startSubStream, then the stop a disable issues while its path check is in flight: no sub ffmpeg, no path written', async () => {
    configCheck.hold();
    const start = track(startSubStream(SUB_CAM));
    await untilHeld(configCheck, 1, 'startSubStream never reached its path check');
    assert.equal(configCheck.held[0].arg, SUB_PATH, 'the held check is the sub path\'s');
    const stop = track(stopSubStream(SUB_CAM)); // what PUT /:id/enabled { enabled: false } does
    configCheck.held.splice(0).forEach((h) => h.release(false)); // "missing": the start would write it
    await releaseUntilSettled([start, stop]);

    assert.equal(live().length, 0, 'a sub transcoder launched for a camera that was disabled meanwhile');
    assert.deepEqual(upserts, [], 'the sub path was written back after the stop removed it');
    assert.equal(probe.calls.length, 0, 'the stopped start went on to probe the camera');
  });

  test('r2: control, no stop: the same start writes the missing sub path and launches exactly one sub ffmpeg', async () => {
    configCheck.hold();
    const start = track(startSubStream(SUB_CAM));
    await untilHeld(configCheck, 1, 'startSubStream never reached its path check');
    configCheck.held.splice(0).forEach((h) => h.release(false));
    await releaseUntilSettled([start]);

    assert.deepEqual(upserts.filter((p) => p === SUB_PATH), [SUB_PATH], 'the missing sub path was not written exactly once');
    assert.equal(live().length, 1);
    assert.equal(urlOf(live()[0]), URL2);
  });
});
