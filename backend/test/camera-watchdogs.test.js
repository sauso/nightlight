// The camera and audio watchdogs, driven through their REAL tick with fake deps and a fake clock (#451).
//
// Until #451 these loops lived inline in index.js, which cannot be imported (it spawns MediaMTX and a
// transcoder per camera at load), so their only test was a source-text tripwire. Codex's plan review
// (round 1, P1) asked for AC3 to be tested through the real logic, so the loop bodies moved to
// lib/cameraWatchdogs.js with every collaborator injected. No mock.module(): that corrupts coverage for
// the whole suite when the mocked file is also in test:core's include list.
//
// THE RULES UNDER TEST (owner decision, 2026-09-24). A MediaMTX API call that times out is UNKNOWN:
//   * restart decisions need an UNBROKEN run of CONFIRMED observations, so an unknown BREAKS the run
//     (main 30s, sub 30s, audio 2 consecutive stalls) and never causes a restart or a history event;
//   * the offline push counts from the first check that could not CONFIRM the camera was up, and an
//     unknown is such a check, so it counts toward the N minutes.
// And a check that a later tick SKIPPED while it was pending (Codex round 2, P0) holds stale readings,
// so it may not make or seed a continuity decision. Since the #451 fix round (Codex code review
// BLOCKER) the main and sub legs are separate checks with separate runners, so a slow one cannot skip,
// or starve, the other: W11, W16, W17.
//
// ⚠️ TIME IS THE FAKE CLOCK, NEVER THE WALL CLOCK. Every negative assertion here ("no restart at t35")
// stands on `deps.now`, which the test sets. `flush` drains event-loop turns so a deferred the test just
// settled can run to completion; it is not a duration.
import { test, describe, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupTempDataDirs, makeCamera } from './helpers/harness.js';

useTempDataDir();

const { logger } = await import('../src/lib/logger.js');
const { resetGuardRateLimit } = await import('../src/lib/processGuards.js');
const watchdogs = await import('../src/lib/cameraWatchdogs.js');
const { createCameraWatchdog, createAudioWatchdog } = watchdogs;
const { EVENT } = await import('../src/lib/cameraEvents.js');

const READY = Object.freeze({ ready: true, tracks: ['H264'] });
const NOT_READY = Object.freeze({ ready: false, tracks: [] });
const UNKNOWN = Object.freeze({ ready: false, tracks: [], unknown: true });
const WITH_AUDIO = Object.freeze({ ready: true, tracks: ['H264', 'Opus'] });

const deferred = () => {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
};
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};
const logged = (needle) => logger.getRecent().filter((l) => l.includes(needle)).length;

// A FIXED, realistic epoch for the fake clock, never 0. The watchdog seeds its timers with `if (!since)`,
// and a seed of 0 is falsy, so a clock starting at 0 silently re-seeds on the next tick and shifts every
// restart by one interval. That made the first run of the original W11 fail on the pre-fix code for that
// reason instead of the one it named. A real Date.now() is never 0, so the base below changes nothing but the artifact.
const EPOCH = Date.UTC(2026, 8, 24, 20, 0, 0);
const secondsOf = (ms) => (ms - EPOCH) / 1000;

const camera = (id, { name = `Cam ${id}`, sub = false, disabled = 0 } = {}) => ({
  id,
  name,
  mediamtx_path: `cam_${id}`,
  rtsp_url: `rtsp://192.0.2.10:554/${id}`,
  sub_rtsp_url: sub ? `rtsp://192.0.2.10:554/${id}-sub` : null,
  disabled,
});

// One watchdog, every collaborator faked and recorded. `reading(path)` decides what MediaMTX "says" for a
// path on this call; it may return a status or a promise (a check the test holds open).
// `mainRestartSec` / `subRestartSec` make a restart take that long ON THE FAKE CLOCK: the promise settles
// only when `runTo` walks the clock past it. A real restart stops ffmpeg (up to a 3s force-kill), probes
// the camera (up to 9s) and asks MediaMTX about the path (up to 5s each way), so 16s is reachable.
function cameraHarness(cameras, { offline = { enabled: 0, minutes: 5 }, mainRestartSec = 0, subRestartSec = 0 } = {}) {
  const h = {
    clock: EPOCH,
    reading: () => READY,
    status: [],
    restarts: [],
    subRestarts: [],
    events: [],
    offline: [],
    recovered: [],
  };
  const at = () => secondsOf(h.clock);
  const slow = [];
  const takes = (sec) =>
    sec ? new Promise((resolve) => slow.push({ due: h.clock + sec * 1000, resolve })) : Promise.resolve();
  h.deps = {
    listCameras: () => cameras,
    offlineAlertConfig: () => offline,
    getPathStatus: (p) => {
      h.status.push(p);
      return Promise.resolve(h.reading(p));
    },
    startTranscoder: async (id) => {
      h.restarts.push({ at: at(), id });
      await takes(mainRestartSec);
    },
    startSubStream: async (cam) => {
      h.subRestarts.push({ at: at(), id: cam.id });
      await takes(subRestartSec);
    },
    subConfigured: (cam) => !!cam.sub_rtsp_url,
    subPathName: (p) => `${p}-sub`,
    recordCameraEvent: (id, name, type) => h.events.push({ at: at(), id, type }),
    notifyCameraOffline: (cam, minutes) => h.offline.push({ at: at(), id: cam.id, minutes }),
    notifyCameraRecovered: (cam, since) => h.recovered.push({ at: at(), id: cam.id, since: secondsOf(since) }),
    now: () => h.clock,
  };
  h.wd = createCameraWatchdog(h.deps);
  // Start a tick `sec` seconds after EPOCH on the fake clock. Returns its promise: await it for a tick
  // whose checks all settle, keep it for one the test is holding open.
  h.tickAt = (sec) => {
    h.clock = EPOCH + sec * 1000;
    return h.wd.tick();
  };
  // Walk the fake clock one second at a time from `fromSec` to `endSec`: settle every slow restart that is
  // due, then tick on every 15s boundary as safeInterval would. Ticks are NOT awaited, because a tick
  // holding a slow restart stays pending while later ticks run, exactly as in production.
  h.runTo = async (endSec, fromSec = 0) => {
    for (let s = fromSec; s <= endSec; s++) {
      h.clock = EPOCH + s * 1000;
      for (const op of slow.filter((o) => o.due <= h.clock)) {
        slow.splice(slow.indexOf(op), 1);
        op.resolve();
      }
      await flush();
      if (s % 15 === 0) {
        h.wd.tick();
        await flush();
      }
    }
  };
  return h;
}

function audioHarness(cameras) {
  const h = { clock: EPOCH, reading: () => WITH_AUDIO, probe: () => true, status: [], probes: [], restarts: [], events: [] };
  const at = () => secondsOf(h.clock);
  h.deps = {
    listCameras: () => cameras,
    getPathStatus: (p) => {
      h.status.push(p);
      return Promise.resolve(h.reading(p));
    },
    probeAudioFlowing: (p) => {
      h.probes.push({ at: at(), p });
      return Promise.resolve(h.probe(p));
    },
    startTranscoder: async (id) => { h.restarts.push({ at: at(), id }); },
    recordCameraEvent: (id, name, type) => h.events.push({ at: at(), id, type }),
    now: () => h.clock,
  };
  h.wd = createAudioWatchdog(h.deps);
  h.tickAt = (sec) => {
    h.clock = EPOCH + sec * 1000;
    return h.wd.tick();
  };
  return h;
}

beforeEach(() => {
  // Round 2, P2: per-label rate-limit state and the process-wide log ring must not leak between cases.
  resetGuardRateLimit();
});
afterEach(() => {
  logger.clear();
});
after(() => {
  cleanupTempDataDirs();
});

describe('camera watchdog: an UNKNOWN status is not evidence (#451, owner decision 2026-09-24)', () => {
  test('W1: a camera that was online, then UNKNOWN for 60s: no history event, no restart', async () => {
    const h = cameraHarness([camera('c1')]);
    await h.tickAt(0); // seeds "online" silently
    h.reading = () => UNKNOWN;
    for (const s of [15, 30, 45, 60]) await h.tickAt(s);

    assert.equal(h.status.length, 5, 'precondition: every tick asked MediaMTX');
    assert.deepEqual(h.events, [], 'an unanswered API call was recorded as the camera going offline');
    assert.deepEqual(h.restarts, [], 'a working stream was restarted because the API did not answer');
  });

  test('W2: an UNKNOWN reading BREAKS the 30s run: the restart needs 30s more of confirmed not-ready', async () => {
    // Hostile: the unknown sits INSIDE a run that, read end to end, is 35s of "not ready" — over the
    // threshold. Holding the timer through the unknown would restart at t35.
    const h = cameraHarness([camera('c2')]);
    h.reading = () => NOT_READY;
    await h.tickAt(0);
    h.reading = () => UNKNOWN;
    await h.tickAt(15);
    h.reading = () => NOT_READY;
    for (const s of [35, 50, 65]) await h.tickAt(s);
    assert.deepEqual(h.restarts, [], 'restarted on a run of readings that an unknown had broken');

    await h.tickAt(80);
    assert.deepEqual(h.restarts, [{ at: 80, id: 'c2' }], 'the watchdog did not restart after 30s+ of confirmed not-ready');
  });

  test('W3: the offline PUSH still fires while the API is unknown, though nothing is restarted or recorded', async () => {
    // The deliberate asymmetry: the push clock starts at the first check that could not confirm the
    // camera was up, and an unknown is such a check, so a wedged MediaMTX still reaches the parent. A
    // restart needs confirmed evidence, so none happens.
    const h = cameraHarness([camera('c3')], { offline: { enabled: 1, minutes: 5 } });
    await h.tickAt(0);
    h.reading = () => UNKNOWN;
    for (let s = 15; s <= 330; s += 15) await h.tickAt(s);

    assert.deepEqual(
      h.offline,
      [{ at: 315, id: 'c3', minutes: 5 }],
      'the offline push did not fire exactly once, 5 minutes from the first check (t15) that could not confirm the camera was up'
    );
    assert.deepEqual(h.restarts, [], 'restarted on unknown readings');
    assert.deepEqual(h.events, [], 'recorded a history event on unknown readings');

    h.reading = () => READY;
    await h.tickAt(345);
    assert.deepEqual(h.recovered, [{ at: 345, id: 'c3', since: 15 }], 'the recovery push did not follow the next confirmed ready');
  });

  test('W4: the SUB leg UNKNOWN for 75s is never restarted', async () => {
    const h = cameraHarness([camera('c4', { sub: true })]);
    h.reading = (p) => (p.endsWith('-sub') ? UNKNOWN : READY);
    for (const s of [0, 15, 30, 45, 60, 75]) await h.tickAt(s);

    assert.equal(h.status.filter((p) => p === 'cam_c4-sub').length, 6, 'precondition: the sub path was asked every tick');
    assert.deepEqual(h.subRestarts, [], 'the sub-stream was restarted because the API did not answer');
    assert.deepEqual(h.restarts, [], 'control: the healthy main stream was restarted');
  });

  test('W5 (control): a CONFIRMED not-ready still records OFFLINE and restarts after 30s', async () => {
    // Without this, every case above passes against a watchdog that does nothing at all.
    const h = cameraHarness([camera('c5')]);
    await h.tickAt(0);
    h.reading = () => NOT_READY;
    for (const s of [15, 30, 45]) await h.tickAt(s);
    assert.deepEqual(h.restarts, [], 'restarted before the threshold');
    await h.tickAt(60);

    assert.deepEqual(h.restarts, [{ at: 60, id: 'c5' }]);
    assert.deepEqual(
      h.events.map((e) => [e.at, e.type]),
      [[15, EVENT.OFFLINE], [60, EVENT.RESTART]],
      'a confirmed outage was not recorded, or the restart was not'
    );
  });

  test('W6 (AC3): one camera whose status never comes does not stop another being checked and acted on', async () => {
    const h = cameraHarness([camera('a'), camera('b')]);
    h.reading = (p) => (p === 'cam_a' ? new Promise(() => {}) : NOT_READY);
    h.tickAt(0); // never settles: camera a is held open for the rest of the test
    await flush();
    assert.deepEqual(h.status, ['cam_a', 'cam_b'], 'camera b was not checked in the same tick as the stuck camera a');

    for (const s of [15, 30, 45]) await h.tickAt(s);
    assert.equal(h.status.filter((p) => p === 'cam_a').length, 1, "camera a's check was started again while the first was still pending");
    assert.equal(h.status.filter((p) => p === 'cam_b').length, 4, 'camera b was not checked on every tick');
    assert.deepEqual(h.restarts, [{ at: 45, id: 'b' }], 'camera b was checked but not acted on');
  });

  test('W8: guard labels are per camera, and the sub leg has its own', async () => {
    // Same labels as before #451, so KNOWN-ISSUES' `[guard:camera-watchdog:Nursery]` example stays true.
    const h = cameraHarness([camera('n', { name: 'Nursery', sub: true }), camera('o', { name: 'Other' })]);
    h.reading = (p) => {
      if (p === 'cam_n') throw new Error('w8-main-marker');
      return READY;
    };
    await h.tickAt(0);
    assert.equal(logged('[guard:camera-watchdog:Nursery]'), 1);
    assert.equal(logged('w8-main-marker'), 1);
    assert.ok(h.status.includes('cam_o'), 'a failing camera stopped its sibling being checked');

    h.reading = (p) => {
      if (p === 'cam_n-sub') throw new Error('w8-sub-marker');
      return NOT_READY;
    };
    await h.tickAt(15);
    await h.tickAt(50);
    assert.equal(logged('[guard:camera-watchdog:sub:Nursery]'), 1, 'a sub-leg failure was not reported under its own label');
    assert.ok(h.restarts.some((r) => r.id === 'n'), 'a sub-leg failure stopped the MAIN leg from being restarted');

    const a = audioHarness([camera('n', { name: 'Nursery' })]);
    a.reading = () => { throw new Error('w8-audio-marker'); };
    await a.tickAt(0);
    assert.equal(logged('[guard:audio-watchdog:Nursery]'), 1);
  });

  test('W9: a MAIN reading that straddled a skip neither restarts the camera nor seeds the timer', async () => {
    // Codex round 2, P0. The stall sits in the main leg's own READING, a later tick skips the leg while
    // it waits, and the reading then comes back not-ready. HOSTILE: notReadySince was seeded at t0 and the
    // reading lands at t50, so a check deciding on its pre-skip state would restart right there.
    const h = cameraHarness([camera('c9')]);
    h.reading = () => NOT_READY;
    await h.tickAt(0); // seeds notReadySince at t0

    const held = deferred();
    h.reading = () => held.promise;
    const stale = h.tickAt(35); // the main reading is held from here
    await flush();

    h.reading = () => NOT_READY;
    await h.tickAt(50); // skips c9's main leg: its t35 reading is still pending
    assert.equal(h.status.length, 2, 'precondition: the t50 tick skipped the pending main check');

    held.resolve(NOT_READY);
    await stale;
    assert.deepEqual(h.restarts, [], 'a skipped (stale) main check restarted the camera on pre-skip state');

    // The skip broke the run: the restart needs a FRESH seed (t65), so not before t110. A stale check that
    // wrote its t50 reading back as the seed would restart at t95; one whose skip left the t0 seed in
    // place would restart at t65.
    for (const s of [65, 80, 95]) await h.tickAt(s);
    assert.deepEqual(h.restarts, [], 'restarted on a run the skip had broken');
    await h.tickAt(110);
    assert.deepEqual(h.restarts, [{ at: 110, id: 'c9' }], 'the restart did not come after 30s+ of fresh confirmed not-ready');
  });

  test('W9b: the same for the SUB leg: a sub reading that straddled a skip neither restarts nor seeds', async () => {
    const h = cameraHarness([camera('c9b', { sub: true })]);
    h.reading = (p) => (p.endsWith('-sub') ? NOT_READY : READY);
    await h.tickAt(0); // seeds subNotReadySince at t0

    const held = deferred();
    h.reading = (p) => (p.endsWith('-sub') ? held.promise : READY);
    const stale = h.tickAt(35); // the sub reading is held from here
    await flush();
    h.reading = (p) => (p.endsWith('-sub') ? NOT_READY : READY);
    await h.tickAt(50); // skips c9b's sub leg
    assert.equal(h.status.filter((p) => p === 'cam_c9b-sub').length, 2, 'precondition: the t50 tick skipped the pending sub check');

    held.resolve(NOT_READY);
    await stale;
    assert.deepEqual(h.subRestarts, [], 'a skipped (stale) sub check restarted the sub-stream');

    for (const s of [65, 80, 95]) await h.tickAt(s);
    assert.deepEqual(h.subRestarts, [], 'the sub-stream restarted on a run the skip had broken');
    await h.tickAt(110);
    assert.deepEqual(h.subRestarts, [{ at: 110, id: 'c9b' }]);
  });

  test('W11: while a camera\'s SUB reading is held, its MAIN stream is still checked and restarted on schedule', async () => {
    // The two legs are independent since the #451 fix round: a slow sub-path answer cannot hold up, or
    // cause the skipping of, the main path's check.
    const h = cameraHarness([camera('c11', { sub: true })]);
    h.reading = (p) => (p.endsWith('-sub') ? READY : NOT_READY);
    await h.tickAt(0); // main seeded at t0

    const held = deferred();
    h.reading = (p) => (p.endsWith('-sub') ? held.promise : NOT_READY);
    const t15 = h.tickAt(15); // the sub reading is held from here to the end
    await flush();
    await h.tickAt(30);
    await h.tickAt(45);
    assert.equal(h.status.filter((p) => p === 'cam_c11').length, 4, 'the main path was not checked while the sub reading was held');
    assert.deepEqual(h.restarts, [{ at: 45, id: 'c11' }], 'the main restart waited on the sub leg');

    held.resolve(READY);
    await t15;
  });

  test('W16: a slow SUB restart does not stop the MAIN restart (fix round, Codex code review BLOCKER)', async () => {
    // The trace Codex found: both paths unready from t0, and each sub restart takes 16s. When one run did
    // both legs, the sub restart started at t45 held that run until t61, the t60 tick skipped the camera
    // and cleared BOTH timers, and the already-due main restart was discarded as stale at t61. The timers
    // reseeded at t75 and the cycle repeated at t120/t135: startTranscoder was never called, and the main
    // restart is the monitor's only recovery path. At 12s it does not starve; 16s is a real restart that
    // is slow on stopping ffmpeg and probing the camera, which a slow-but-answering MediaMTX makes likely.
    const h = cameraHarness([camera('c16', { sub: true })], { subRestartSec: 16 });
    h.reading = () => NOT_READY;
    await h.runTo(150);
    assert.equal(h.subRestarts[0]?.at, 45, 'precondition: the sub leg started its slow restart at t45');
    assert.deepEqual(h.restarts[0], { at: 45, id: 'c16' }, 'the main transcoder was not restarted once it had 30s+ of confirmed not-ready');
  });

  test('W17: a slow MAIN restart does not stop the SUB restart (the mirror case)', async () => {
    // The sub path goes unready at t30, while the main restart that starts at t45 takes 16s. When one run
    // did both legs, the t60 tick skipped the camera during that restart and cleared the SUB timer too,
    // so the sub restart due at t75 slipped to t120.
    const h = cameraHarness([camera('c17', { sub: true })], { mainRestartSec: 16 });
    h.reading = (p) => (p.endsWith('-sub') && secondsOf(h.clock) < 30 ? READY : NOT_READY);
    await h.runTo(150);
    assert.equal(h.restarts[0]?.at, 45, 'precondition: the main leg started its slow restart at t45');
    assert.deepEqual(h.subRestarts[0], { at: 75, id: 'c17' }, 'the sub-stream was not restarted once it had 30s+ of confirmed not-ready');
  });

  test('W13: a disabled camera is not asked about or restarted, and re-enabling it starts clean', async () => {
    // Moved behaviour, pinned now that it can be: a disabled camera has no path, so reading it would log
    // phantom outages, and its tracked state must not survive into the re-enable.
    const cam = camera('c13');
    const h = cameraHarness([cam]);
    await h.tickAt(0);
    h.reading = () => NOT_READY;
    await h.tickAt(15); // OFFLINE, and the restart timer starts at t15
    cam.disabled = 1;
    for (const s of [30, 45, 60]) await h.tickAt(s);
    assert.equal(h.status.length, 2, 'a disabled camera was asked about');
    assert.deepEqual(h.restarts, [], 'a disabled camera was restarted');

    cam.disabled = 0;
    for (const s of [75, 90, 105]) await h.tickAt(s);
    assert.deepEqual(h.restarts, [], 'the restart timer survived the disable (t15 + 30s would have fired)');
    assert.deepEqual(h.events.map((e) => [e.at, e.type]), [[15, EVENT.OFFLINE]], 're-enabling logged a second, phantom OFFLINE');
    await h.tickAt(120);
    assert.deepEqual(h.restarts, [{ at: 120, id: 'c13' }]);
  });

  test('W14: a CONFIRMED recovery records ONLINE, and clears the restart timer', async () => {
    const h = cameraHarness([camera('c14')]);
    await h.tickAt(0);
    h.reading = () => NOT_READY;
    await h.tickAt(15);
    h.reading = () => READY;
    await h.tickAt(30);
    h.reading = () => NOT_READY;
    for (const s of [45, 60, 75]) await h.tickAt(s);
    assert.deepEqual(
      h.events.map((e) => [e.at, e.type]),
      [[15, EVENT.OFFLINE], [30, EVENT.ONLINE], [45, EVENT.OFFLINE]],
    );
    assert.deepEqual(h.restarts, [], 'the ready reading at t30 did not reset the restart timer');
  });
});

describe('audio watchdog', () => {
  test('W7: stall, UNKNOWN, stall is not two consecutive stalls: the unknown reset the count', async () => {
    const a = audioHarness([camera('a7')]);
    a.probe = () => false;
    await a.tickAt(0);
    a.reading = () => UNKNOWN;
    await a.tickAt(30);
    a.reading = () => WITH_AUDIO;
    await a.tickAt(60);
    assert.deepEqual(a.restarts, [], 'an unknown between two stalls was counted as a stall');
    assert.deepEqual(a.probes.map((p) => p.at), [0, 60], 'the audio was probed while the path status was unknown');

    await a.tickAt(90);
    assert.deepEqual(a.restarts, [{ at: 90, id: 'a7' }], 'control: two real consecutive stalls did not restart');
  });

  test('W10: a skipped audio check does not count its stale stall', async () => {
    // HOSTILE: one stall is already counted, so a stale check adding its own would reach 2 and restart.
    const a = audioHarness([camera('a10')]);
    a.probe = () => false;
    await a.tickAt(0); // stall #1

    const held = deferred();
    a.probe = () => held.promise;
    const stale = a.tickAt(30);
    await flush();
    a.probe = () => false;
    await a.tickAt(60); // skips a10: its t30 probe is still pending
    assert.equal(a.probes.length, 2, 'precondition: the t60 tick skipped the pending check');

    held.resolve(false);
    await stale;
    assert.deepEqual(a.restarts, [], 'a skipped (stale) probe was counted as the second consecutive stall');

    await a.tickAt(90); // the skip broke the run: this is stall #1 again
    assert.deepEqual(a.restarts, [], 'a stall from before the skip was still counted');
    await a.tickAt(120);
    assert.deepEqual(a.restarts, [{ at: 120, id: 'a10' }], 'control: two fresh consecutive stalls did not restart');
  });

  test('W15: flowing audio, an inconclusive probe, a stream with no audio track and a disabled camera all reset the count', async () => {
    // Moved behaviour: only two CONSECUTIVE confirmed stalls restart. Each reset below sits between two
    // stalls, so a reset that stopped resetting would restart at the second one.
    const cam = camera('a15');
    const a = audioHarness([cam]);
    const stallThen = async (sec, between) => {
      a.probe = () => false;
      await a.tickAt(sec);
      between();
      await a.tickAt(sec + 30);
      a.reading = () => WITH_AUDIO;
      cam.disabled = 0;
    };
    await stallThen(0, () => { a.probe = () => true; }); // flowing
    await stallThen(60, () => { a.probe = () => null; }); // could not tell
    await stallThen(120, () => { a.reading = () => ({ ready: true, tracks: ['H264'] }); }); // no audio track
    await stallThen(180, () => { cam.disabled = 1; });
    a.probe = () => false;
    await a.tickAt(240);
    assert.deepEqual(a.restarts, [], 'a reset between two stalls did not reset');
    assert.ok(!a.probes.some((p) => p.at === 150 || p.at === 210), 'a stream with no audio track, or a disabled camera, was probed');

    await a.tickAt(270);
    assert.deepEqual(a.restarts, [{ at: 270, id: 'a15' }], 'control: two consecutive stalls did not restart');
  });
});

describe('production bindings', () => {
  test('W12: every default dep is the real function it names, so a missing or swapped binding fails here, not on staging', async () => {
    const mediamtx = await import('../src/lib/mediamtx.js');
    const transcoder = await import('../src/lib/transcoder.js');
    const subStream = await import('../src/lib/subStream.js');
    const cameraEvents = await import('../src/lib/cameraEvents.js');
    const statusAlert = await import('../src/lib/cameraStatusAlert.js');
    const audio = await import('../src/lib/audioLiveness.js');

    const expectedCamera = {
      listCameras: watchdogs.listCameras,
      offlineAlertConfig: watchdogs.readOfflineAlertConfig,
      getPathStatus: mediamtx.getPathStatus,
      startTranscoder: transcoder.startTranscoder,
      startSubStream: subStream.startSubStream,
      subConfigured: subStream.subConfigured,
      subPathName: mediamtx.subPathName,
      recordCameraEvent: cameraEvents.recordCameraEvent,
      notifyCameraOffline: statusAlert.notifyCameraOffline,
      notifyCameraRecovered: statusAlert.notifyCameraRecovered,
      now: Date.now,
    };
    const expectedAudio = {
      listCameras: watchdogs.listCameras,
      getPathStatus: mediamtx.getPathStatus,
      tracksHaveAudio: audio.tracksHaveAudio,
      probeAudioFlowing: audio.probeAudioFlowing,
      startTranscoder: transcoder.startTranscoder,
      recordCameraEvent: cameraEvents.recordCameraEvent,
      now: Date.now,
    };
    for (const [name, actual, expected] of [
      ['DEFAULT_CAMERA_WATCHDOG_DEPS', watchdogs.DEFAULT_CAMERA_WATCHDOG_DEPS, expectedCamera],
      ['DEFAULT_AUDIO_WATCHDOG_DEPS', watchdogs.DEFAULT_AUDIO_WATCHDOG_DEPS, expectedAudio],
    ]) {
      assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), `${name} has a missing or extra dep`);
      for (const key of Object.keys(expected)) {
        assert.equal(typeof expected[key], 'function', `test bug: the real ${key} is not a function`);
        assert.equal(actual[key], expected[key], `${name}.${key} is not the real ${key}`);
      }
    }

    // The two DB readers live in the module itself, so check what they READ, against the temp database.
    const { default: db } = await import('../src/db.js');
    makeCamera(db, { id: 'w12-cam', name: 'W12' });
    assert.ok(watchdogs.listCameras().some((c) => c.id === 'w12-cam'), 'listCameras does not read the cameras table');
    db.prepare("UPDATE settings SET camera_offline_alert_enabled = 1, camera_offline_alert_minutes = 7 WHERE id = 'app'").run();
    assert.deepEqual({ ...watchdogs.readOfflineAlertConfig() }, { enabled: 1, minutes: 7 }, 'readOfflineAlertConfig reads the wrong columns');
  });
});
