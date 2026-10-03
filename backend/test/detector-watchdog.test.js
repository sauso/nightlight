// #369: the DETECTOR watchdog, the restart-request mailbox, and the camera watchdog consuming that mailbox, all
// driven through their REAL logic (lib/cameraWatchdogs.js) with fake collaborators and a fake MONOTONIC clock.
//
// WHAT #369 IS. On staging one camera's motion detector received zero frames for 285 and 523 minutes while its
// ffmpeg stayed alive, its path stayed ready and its sound detector kept working; nothing noticed, and only the
// daily 10:00 camera reboot ended it. The detector watchdog reads each detector's stdout freshness (as AGES,
// from the detector module) and restarts what has gone dark, escalating by attempt count. Plan v5 (approved
// 2026-09-27) lists 20 claims; each test below names the claim it pins (`Cn`), and scripts/mutants.json holds
// the `#369 M…` mutant that proves it discriminates.
//
// The detector-side half (the real stamps, the real restart lever against a fake ffmpeg, the sound strike rule,
// the 5 s relaunch) is in detector-watchdog-levers.test.js; the video probe is in audio-liveness.test.js.
//
// ⚠️ TIME IS THE FAKE CLOCK, NEVER THE WALL CLOCK. Every "no action at t=75" stands on `deps.now` and on the
// ages the fake health getters compute from it. The clock starts at a fixed, NON-ZERO monotonic value (a
// performance.now() reading is never 0 in a running process, and a zero start hides `if (!since)` bugs).
// No mock.module(): cameraWatchdogs.js is in test:core's include list, and mocking an included module corrupts
// coverage for the whole suite.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { useTempDataDir, cleanupTempDataDirs, makeCamera } from './helpers/harness.js';
import { stripCommentsOnly } from './helpers/sourceScan.js';

useTempDataDir();

const { logger } = await import('../src/lib/logger.js');
const guards = await import('../src/lib/processGuards.js');
const wd = await import('../src/lib/cameraWatchdogs.js');
const { EVENT } = await import('../src/lib/cameraEvents.js');
const {
  createDetectorWatchdog, createRestartRequests, createCameraWatchdog,
  DETECTOR_CHECK_INTERVAL_MS, DETECTOR_STALE_MS, DETECTOR_STARTUP_GRACE_MS, DETECTOR_EPISODE_STALL_MS,
  DETECTOR_RESTART_FLOOR_MS, DETECTOR_RESTART_CAP_MS, DETECTOR_RECOVERED_MS, RESTART_REQUEST_TTL_MS, MIN_KILL_AGE_MS,
} = wd;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.resolve(HERE, '..');

after(() => cleanupTempDataDirs());

const READY = Object.freeze({ ready: true, readers: 2, tracks: ['H264', 'Opus'] });
const NOT_READY = Object.freeze({ ready: false, tracks: [] });
const UNKNOWN = Object.freeze({ ready: false, tracks: [], unknown: true });

const T0 = 5_000_000; // the fake monotonic clock's "t = 0 s", in ms
const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
};
const logged = (needle) => logger.getRecent().filter((l) => l.includes(needle)).length;
const deferred = () => {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
};

const cam = (id, { sub = true, sound = 0, disabled = 0 } = {}) => ({
  id,
  name: `Cam ${id}`,
  mediamtx_path: `cam_${id}`,
  rtsp_url: `rtsp://192.0.2.10:554/${id}`,
  sub_rtsp_url: sub ? `rtsp://192.0.2.10:554/${id}-sub` : null,
  disabled,
  detect_sound_enabled: sound,
});

// A fake detector leg, in the shape getMotionDetectorHealth/getSoundDetectorHealth return, with AGES computed
// from the fake clock at the moment of the call, exactly as processGuards.detectorHealthOf does.
function healthFrom(leg, clock) {
  if (leg == null) return null;
  if (leg.waiting) return { waiting: true };
  return {
    path: leg.path,
    spawnedMono: leg.spawnedAt,
    lastDataMono: leg.lastDataAt,
    spawnAgeMs: clock - leg.spawnedAt,
    dataAgeMs: leg.lastDataAt == null ? null : clock - leg.lastDataAt,
    inputRecordAgeMs: leg.inputAt == null ? null : clock - leg.inputAt,
  };
}

// One detector watchdog, every collaborator faked and recorded in `calls` IN ORDER, so a test can assert the
// exact sequence an action produced. Times in the records are seconds after T0.
function detectorHarness(cameras, { withMailbox = true } = {}) {
  const h = {
    clock: T0,
    legs: { motion: new Map(), sound: new Map() },
    status: () => READY,
    probe: () => true,
    audioProbe: () => true,
    wanted: () => true,
    onKill: null,
    calls: [],
    kills: [],
    events: [],
    posted: [],
    cancelled: [],
  };
  h.sec = () => (h.clock - T0) / 1000;
  h.ms = (s) => T0 + s * 1000;
  // A running process: spawned at `spawned` s, last stdout byte at `data` s (null: none yet).
  h.run = (leg, id, { path: p, spawned, data = null, input = null }) =>
    h.legs[leg].set(id, { path: p, spawnedAt: h.ms(spawned), lastDataAt: data == null ? null : h.ms(data), inputAt: input == null ? null : h.ms(input) });
  h.gap = (leg, id) => h.legs[leg].set(id, null); // the 5 s relaunch gap: no entry at all
  h.waiting = (leg, id) => h.legs[leg].set(id, { waiting: true }); // an entry still picking a ready path
  h.feed = (leg, id, s = h.sec()) => {
    h.legs[leg].get(id).lastDataAt = h.ms(s);
  };
  h.mailbox = createRestartRequests({ now: () => h.clock });
  const restartRequests = {
    post: (id, kind, reason) => {
      h.calls.push('post');
      h.posted.push({ at: h.sec(), id, kind, reason });
      h.mailbox.post(id, kind, reason);
    },
    take: (id, kind) => h.mailbox.take(id, kind),
    cancel: (id) => {
      h.cancelled.push({ at: h.sec(), id });
      h.mailbox.cancel(id);
    },
  };
  const kill = (leg) => (id, expect) => {
    h.calls.push(`kill:${leg}`);
    h.kills.push({ at: h.sec(), leg, id, expect });
    return h.onKill ? h.onKill(leg, id, expect) : true;
  };
  h.deps = {
    listCameras: () => cameras,
    getPathStatus: (p) => {
      h.calls.push('status');
      return Promise.resolve(h.status(p));
    },
    subPathName: (p) => `${p}-sub`,
    motionLegWanted: (c) => h.wanted(c),
    getMotionDetectorHealth: (id) => healthFrom(h.legs.motion.get(id), h.clock),
    getSoundDetectorHealth: (id) => healthFrom(h.legs.sound.get(id), h.clock),
    restartMotionDetector: kill('motion'),
    restartSoundDetector: kill('sound'),
    probeVideoFlowing: (p) => {
      h.calls.push('probe:video');
      return h.probe(p);
    },
    probeAudioFlowing: (p) => {
      h.calls.push('probe:audio');
      return h.audioProbe(p);
    },
    recordCameraEvent: (id, name, type, detail) => {
      h.calls.push('event');
      h.events.push({ at: h.sec(), id, type, detail });
    },
    now: () => h.clock,
    ...(withMailbox ? { restartRequests } : {}),
  };
  h.wd = createDetectorWatchdog(h.deps);
  h.tickAtMs = async (ms) => {
    h.clock = ms;
    await h.wd.tick();
  };
  h.tickAt = (s) => h.tickAtMs(h.ms(s));
  // Tick on every `step` s from `from` to `to`, calling `before(s)` first so a test can move its fake legs.
  h.ticks = async (from, to, before, step = 15) => {
    for (let s = from; s <= to; s += step) {
      before?.(s);
      await h.tickAt(s);
    }
  };
  h.killTimes = (leg = 'motion') => h.kills.filter((k) => k.leg === leg).map((k) => k.at);
  h.postTimes = () => h.posted.map((p) => p.at);
  return h;
}

// ---------------------------------------------------------------------------------------------------------
describe('C1/C2: the clocks', () => {
  test('C1: the default clock works when called BARE, and a real tick with the default deps and a camera resolves', async () => {
    // perTargetRunner calls `now()` unbound, before its try: an unbound performance.now throws in Node 24, which
    // would make every tick reject (Opus R1, CRITICAL). So call it exactly the way the runner does.
    const now = wd.DEFAULT_DETECTOR_WATCHDOG_DEPS.now;
    const reading = now();
    assert.equal(typeof reading, 'number');
    assert.ok(Number.isFinite(reading), 'the default clock returned a non-finite number');

    const { default: db } = await import('../src/db.js');
    makeCamera(db, { id: 'c1-cam', name: 'C1', extra: { detect_motion_enabled: 1, detect_source: 'framediff', detect_sound_enabled: 1 } });
    guards.resetGuardRateLimit();
    const before = logged('[guard:detector-watchdog');
    await createDetectorWatchdog().tick(); // rejects if the runner's bare now() throws
    assert.equal(logged('[guard:detector-watchdog'), before, 'a real tick with the default deps reported a failure');
  });

  test('C2: the CAMERA watchdog keeps Date.now, so a recovered-camera push measures the outage in wall-clock time', async () => {
    // It stores offlineSince with its own `now` and notifyCameraRecovered subtracts it from Date.now(): a
    // monotonic clock injected there printed "29,841,119 minutes offline" during planning. `now` is NOT
    // overridden below, so this is the production binding.
    assert.equal(wd.DEFAULT_CAMERA_WATCHDOG_DEPS.now, Date.now);
    const c = cam('c2', { sub: false });
    let ready = false;
    const recovered = [];
    const w = createCameraWatchdog({
      listCameras: () => [c],
      offlineAlertConfig: () => ({ enabled: 1, minutes: 0 }),
      getPathStatus: async () => (ready ? READY : NOT_READY),
      startTranscoder: async () => {},
      startSubStream: async () => {},
      subConfigured: () => false,
      subPathName: (p) => `${p}-sub`,
      recordCameraEvent: () => {},
      notifyCameraOffline: () => {},
      notifyCameraRecovered: (_cam, since) => recovered.push(since),
    });
    const before = Date.now();
    await w.tick(); // not ready: the outage starts, and the 0-minute alert fires
    ready = true;
    await w.tick(); // ready: the recovery push, with the outage start
    assert.equal(recovered.length, 1, 'precondition: the recovery push did not fire');
    const outageMs = Date.now() - recovered[0];
    assert.ok(recovered[0] >= before && outageMs >= 0 && outageMs < 60_000,
      `the outage start is not a Date.now() stamp: ${recovered[0]} (outage ${outageMs} ms)`);
  });
});

// ---------------------------------------------------------------------------------------------------------
describe('C3/C4: stale legs are restarted, healthy ones never', () => {
  test('C3a: a motion leg silent since t=0 (process alive, path ready) is restarted once, at t=75 (STALE + one tick)', async () => {
    const c = cam('c3a');
    const h = detectorHarness([c]);
    h.run('motion', c.id, { path: 'cam_c3a-sub', spawned: -600, data: 0 });
    await h.ticks(15, 120);
    assert.deepEqual(h.killTimes(), [75], 'not exactly one detector restart at t=75');
    assert.deepEqual(h.kills[0].expect, { expectSpawn: h.ms(-600), expectLastData: h.ms(0) }, 'the lever got the wrong tokens');
    assert.deepEqual(h.postTimes(), [], 'the first action asked for a publisher restart');
    assert.equal(h.events.length, 1);
    assert.equal(h.events[0].type, EVENT.RESTART);
    assert.match(h.events[0].detail, /motion detector getting no frames \(no data for 75s\) - motion detector restarted by the detector watchdog/);
  });

  test('C3b: the boundary: data exactly STALE old is still healthy, 1 ms older is not', async () => {
    const c = cam('c3b');
    const h = detectorHarness([c]);
    h.run('motion', c.id, { path: 'cam_c3b-sub', spawned: -600, data: 0 });
    await h.tickAtMs(h.ms(0) + DETECTOR_STALE_MS);
    assert.deepEqual(h.kills, [], 'a leg whose last byte is exactly STALE old was restarted');
    await h.tickAtMs(h.ms(0) + DETECTOR_STALE_MS + 1);
    assert.equal(h.kills.length, 1, 'a leg 1 ms past STALE was not restarted');
  });

  test('C3c: the constants are the documented numbers (the values, not only the names)', () => {
    assert.equal(DETECTOR_CHECK_INTERVAL_MS, 15_000);
    assert.equal(DETECTOR_STALE_MS, 60_000);
    assert.equal(DETECTOR_STARTUP_GRACE_MS, 90_000);
    assert.equal(DETECTOR_EPISODE_STALL_MS, 180_000);
    assert.equal(DETECTOR_RESTART_FLOOR_MS, 60_000);
    assert.equal(DETECTOR_RESTART_CAP_MS, 1_800_000);
    assert.equal(DETECTOR_RECOVERED_MS, 300_000);
    assert.equal(RESTART_REQUEST_TTL_MS, 60_000);
    assert.equal(MIN_KILL_AGE_MS, 10_000);
  });

  test('C4: healthy legs (a byte every 200 ms) are never touched: two hours of ticks, no restart, no probe, no path call', async () => {
    const c = cam('c4', { sound: 1 });
    const h = detectorHarness([c]);
    h.run('motion', c.id, { path: 'cam_c4-sub', spawned: -10, data: 0 });
    h.run('sound', c.id, { path: 'cam_c4', spawned: -10, data: 0 });
    await h.ticks(15, 7200, (s) => {
      h.feed('motion', c.id, s - 0.2);
      h.feed('sound', c.id, s - 0.2);
    });
    assert.deepEqual(h.calls, [], `a healthy leg was acted on: ${h.calls.join(', ')}`);
  });
});

// ---------------------------------------------------------------------------------------------------------
describe('C5: startup, waiting and the relaunch gap', () => {
  test('C5a: a process with no byte yet is left alone through its 90 s grace (75 s and 90 s), then restarted', async () => {
    const c = cam('c5a');
    const h = detectorHarness([c]);
    h.run('motion', c.id, { path: 'cam_c5a-sub', spawned: 0 });
    await h.ticks(15, 90);
    assert.deepEqual(h.kills, [], 'a process inside its startup grace was restarted');
    await h.tickAtMs(h.ms(0) + DETECTOR_STARTUP_GRACE_MS + 1);
    assert.equal(h.kills.length, 1, 'a process past its grace with no byte ever was not restarted');
    assert.match(h.events[0].detail, /no data in the 90s since it started/);
  });

  test('C5b: `waiting` (no process yet) and the relaunch gap (no entry) are never acted on, for hours', async () => {
    const c = cam('c5b');
    const d = cam('c5b2');
    const h = detectorHarness([c, d]);
    h.waiting('motion', c.id);
    h.gap('motion', d.id);
    await h.ticks(15, 3 * 3600);
    assert.deepEqual(h.calls, [], `acted on a leg with no process: ${h.calls.join(', ')}`);
  });

  test('C5c: the ordering pin: STARTUP_GRACE > STALE, STARTUP_GRACE > MIN_KILL_AGE >= 10 s (the sound strike window)', () => {
    assert.ok(DETECTOR_STARTUP_GRACE_MS > DETECTOR_STALE_MS, 'a new process would be judged faster than a running one');
    assert.ok(DETECTOR_STARTUP_GRACE_MS > MIN_KILL_AGE_MS, 'the grace would let the watchdog judge a process the lever refuses to kill');
    assert.ok(MIN_KILL_AGE_MS >= 10_000, 'a kill younger than the sound leg\'s 10 s strike window could read as "no microphone"');
    assert.equal(MIN_KILL_AGE_MS, guards.MIN_KILL_AGE_MS, 'cameraWatchdogs.js re-exports a different MIN_KILL_AGE_MS than the lever enforces');
  });

  test('C5d: a crash loop escalates to a REQUEST, and the young replacement inside its own grace is NOT killed', async () => {
    // Astra R2: episode escalation must never bypass a replacement's startup grace. (c) authorises only the
    // request; a kill needs the CURRENT entry to be entry-stalled.
    const c = cam('c5d');
    const h = detectorHarness([c]);
    const P = 'cam_c5d-sub';
    h.run('motion', c.id, { path: P, spawned: -600, data: 0 });
    await h.ticks(15, 75); // L1 at 75
    await h.ticks(90, 285, (s) => {
      // Replacements that never deliver: G1 85-125, G2 130-170, G3 175-215, G4 from 250 (young at 270/285).
      if (s === 90) h.run('motion', c.id, { path: P, spawned: 85 });
      if (s === 135) h.run('motion', c.id, { path: P, spawned: 130 });
      if (s === 180) h.run('motion', c.id, { path: P, spawned: 175 });
      if (s === 225) h.gap('motion', c.id);
      if (s === 255) h.run('motion', c.id, { path: P, spawned: 250 });
    });
    assert.deepEqual(h.killTimes(), [75], 'a replacement inside its own startup grace was killed');
    assert.deepEqual(h.postTimes(), [270], 'the crash loop did not escalate to a publisher request once, at t=270');
    assert.equal(h.posted[0].kind, 'sub');
  });

  test('C5e: hours offline, then ONE slow replacement (40 s to its first frame): no kill and no episode escalation', async () => {
    const c = cam('c5e');
    const h = detectorHarness([c]);
    const P = 'cam_c5e-sub';
    h.run('motion', c.id, { path: P, spawned: -600, data: 0 });
    await h.ticks(15, 75); // L1 at 75
    h.gap('motion', c.id);
    await h.tickAt(90);
    h.waiting('motion', c.id); // the path went away: pickReadyPath waits for hours
    await h.ticks(105, 3 * 3600);
    const back = 3 * 3600 + 5;
    h.run('motion', c.id, { path: P, spawned: back });
    await h.ticks(back + 10, back + 70, (s) => {
      if (s >= back + 40) h.feed('motion', c.id, s);
    });
    assert.deepEqual(h.killTimes(), [75], 'the slow replacement was killed');
    assert.deepEqual(h.postTimes(), [], 'one slow replacement triggered episode escalation');
  });
});

// ---------------------------------------------------------------------------------------------------------
describe('C6: path readiness (#451)', () => {
  test('C6a: not ready, then UNKNOWN, for ten minutes each: no probe, no action; then READY: an action', async () => {
    const c = cam('c6a');
    const h = detectorHarness([c]);
    h.run('motion', c.id, { path: 'cam_c6a-sub', spawned: -600, data: 0 });
    h.status = () => NOT_READY;
    await h.ticks(15, 600);
    h.status = () => UNKNOWN;
    await h.ticks(615, 1200);
    assert.deepEqual(h.calls.filter((x) => x !== 'status'), [], `acted or probed on a path that is not ready: ${h.calls.join(', ')}`);
    h.status = () => READY;
    await h.tickAt(1215);
    assert.deepEqual(h.killTimes(), [1215]);
  });

  test('C6b: the path drops DURING the probe: no action, until a tick where it holds throughout', async () => {
    const c = cam('c6b');
    const h = detectorHarness([c]);
    h.run('motion', c.id, { path: 'cam_c6b-sub', spawned: -600, data: 0 });
    let reads = 0;
    h.status = () => (++reads === 2 ? NOT_READY : READY); // ready before the probe, gone after it
    await h.tickAt(75);
    assert.deepEqual(h.kills, [], 'acted although the path dropped while the probe ran');
    assert.deepEqual(h.events, []);
    await h.tickAt(90);
    assert.deepEqual(h.killTimes(), [90]);
  });
});

// ---------------------------------------------------------------------------------------------------------
describe('C7: the ladder is by attempt count, and the probe never vetoes it', () => {
  // Per action, the exact sequence of collaborator calls: path, probe, path again, [request], kill, event.
  // The event is LAST since #578: it records what the lever achieved, so it can only be written once the lever
  // has answered (before, it came first and said "restarted" for a kill the lever had refused). C12b and C21a
  // pin that the attempt COUNTS when the lever threw or refused. They do not pin where the commit sits relative
  // to the lever: the lever is synchronous, so moving the commit to just after it is an equivalent mutation
  // (observable only through a lever that re-enters the watchdog, which nothing does).
  const L1 = ['status', 'probe:video', 'status', 'kill:motion', 'event'];
  const L2 = ['status', 'probe:video', 'status', 'post', 'kill:motion', 'event'];
  for (const probe of [true, 'video-missing', null]) {
    test(`C7: probe=${JSON.stringify(probe)}: attempt 1 restarts the detector only; attempts 2 and 3 also request the publisher`, async () => {
      const c = cam(`c7-${probe}`);
      const h = detectorHarness([c]);
      h.probe = () => Promise.resolve(probe);
      // The kill does not help (the same process stays stale): repeated L1 failures, whatever the probe says.
      h.run('motion', c.id, { path: `cam_c7-${probe}-sub`, spawned: -600, data: 0 });
      const perTick = [];
      for (let s = 15; s <= 300; s += 15) {
        const before = h.calls.length;
        await h.tickAt(s);
        if (h.calls.length > before) perTick.push({ s, calls: h.calls.slice(before) });
      }
      assert.deepEqual(perTick, [{ s: 75, calls: L1 }, { s: 135, calls: L2 }, { s: 255, calls: L2 }]);
      assert.deepEqual(h.posted.map((p) => p.kind), ['sub', 'sub']);
    });
  }

  test('C7b: a detector reading the MAIN path escalates to a MAIN request; a path that is neither gets no request', async () => {
    const c = cam('c7b');
    const d = cam('c7b2');
    const h = detectorHarness([c, d]);
    h.run('motion', c.id, { path: 'cam_c7b', spawned: -600, data: 0 });
    h.run('motion', d.id, { path: 'somewhere_else', spawned: -600, data: 0 });
    await h.ticks(15, 135);
    assert.deepEqual(h.posted.map((p) => [p.id, p.kind, p.at]), [['c7b', 'main', 135]]);
    assert.deepEqual(h.kills.filter((k) => k.id === 'c7b2').map((k) => k.at), [75, 135], 'the unmatched path lost its L1');
  });

  test('C7c: without a mailbox (a mis-wiring), the ladder degrades to detector restarts and never throws', async () => {
    const c = cam('c7c');
    const h = detectorHarness([c], { withMailbox: false });
    h.run('motion', c.id, { path: 'cam_c7c-sub', spawned: -600, data: 0 });
    await h.ticks(15, 135);
    assert.deepEqual(h.killTimes(), [75, 135]);
  });
});

// ---------------------------------------------------------------------------------------------------------
describe('C8: the sound leg', () => {
  const soundHarness = (id, audioProbe) => {
    const c = cam(id, { sound: 1 });
    const h = detectorHarness([c]);
    h.wanted = () => false; // this camera runs no motion leg
    h.audioProbePaths = [];
    h.audioProbe = (p) => {
      h.audioProbePaths.push(p);
      return audioProbe(p);
    };
    h.run('sound', c.id, { path: c.mediamtx_path, spawned: -600, data: 0 });
    return { c, h };
  };

  test('C8a: stalled + audio flowing: the SOUND detector is restarted, and never a request, even at attempt 3', async () => {
    const { c, h } = soundHarness('c8a', () => true);
    await h.ticks(15, 300);
    assert.deepEqual(h.killTimes('sound'), [75, 135, 255]);
    assert.deepEqual(h.killTimes('motion'), []);
    assert.deepEqual(h.posted, [], 'the sound leg asked for a publisher restart');
    assert.ok(!h.calls.includes('probe:video'), 'the sound leg ran the video probe');
    assert.deepEqual([...new Set(h.audioProbePaths)], [c.mediamtx_path], 'the audio probe did not read the main path');
    assert.match(h.events[0].detail, /^sound detector getting no audio data \(no data for 75s\) - sound detector restarted by the detector watchdog$/);
  });

  test('C8b: stalled + NO audio on the path (a DTX camera in a quiet room): left to the audio watchdog, for ten minutes', async () => {
    const { h } = soundHarness('c8b', () => false);
    await h.ticks(15, 600);
    assert.deepEqual(h.kills, []);
    assert.deepEqual(h.events, []);
  });

  test('C8c: a persistently INCONCLUSIVE probe cannot disable recovery: it acts on the second eligible tick', async () => {
    const { h } = soundHarness('c8c', () => null);
    await h.ticks(15, 180);
    // 75 = first inconclusive (wait), 90 = second (act); after the action the memory restarts: 150 wait, 165 act.
    assert.deepEqual(h.killTimes('sound'), [90, 165]);
  });

  test('C8d: a healthy tick between two inconclusive ones restarts the count', async () => {
    const { c, h } = soundHarness('c8d', () => null);
    await h.tickAt(75); // inconclusive #1
    h.feed('sound', c.id, 89);
    await h.tickAt(90); // healthy
    await h.ticks(105, 165); // stale again from 150: 150 is the first inconclusive, 165 the second
    assert.deepEqual(h.killTimes('sound'), [165]);
  });

  test('C8e: `false` between two inconclusive answers also restarts the count', async () => {
    let answer = null;
    const { h } = soundHarness('c8e', () => answer);
    await h.tickAt(75); // null #1
    answer = false;
    await h.tickAt(90); // false: skip, and forget the null
    answer = null;
    await h.tickAt(105); // null: the FIRST again
    assert.deepEqual(h.kills, []);
    await h.tickAt(120);
    assert.deepEqual(h.killTimes('sound'), [120]);
  });

  test('C8g: a deleted camera\'s inconclusive-probe memory goes with it: re-added, it starts from the first inconclusive tick', async () => {
    const c = cam('c8g', { sound: 1 });
    const list = [c];
    const h = detectorHarness(list);
    h.wanted = () => false;
    h.audioProbe = () => null;
    h.run('sound', c.id, { path: c.mediamtx_path, spawned: -600, data: 0 });
    await h.tickAt(75); // inconclusive #1: remembered
    list.length = 0;
    await h.tickAt(90); // deleted
    list.push(c);
    await h.tickAt(105); // back: the FIRST inconclusive tick again
    assert.deepEqual(h.kills, [], 'a deleted camera\'s probe memory survived its deletion');
    await h.tickAt(120);
    assert.deepEqual(h.killTimes('sound'), [120]);
  });

  test('C8f: a sound leg whose sound detection is switched off is forgotten, and a probe that THROWS is inconclusive', async () => {
    const { c, h } = soundHarness('c8f', () => { throw new Error('ffprobe exploded'); });
    await h.ticks(15, 90);
    assert.deepEqual(h.killTimes('sound'), [90], 'a throwing probe blocked the sound leg for good');
    c.detect_sound_enabled = 0;
    await h.tickAt(105);
    assert.equal(h.wd.episodeOf(c.id, 'sound'), null, 'switching sound detection off kept its episode');
  });
});

// ---------------------------------------------------------------------------------------------------------
describe('C9: the episode survives the gaps, and escalates on a crash loop', () => {
  test('C9a: act, relaunch gap, waiting, a new process that works then stalls: the SECOND action escalates', async () => {
    const c = cam('c9a');
    const h = detectorHarness([c]);
    const P = 'cam_c9a-sub';
    h.run('motion', c.id, { path: P, spawned: -600, data: 0 });
    await h.ticks(15, 75); // L1
    h.gap('motion', c.id);
    await h.tickAt(90);
    h.waiting('motion', c.id); // held in waiting PAST the backoff floor (75 + 60 = 135)
    await h.ticks(105, 150);
    h.run('motion', c.id, { path: P, spawned: 155 });
    // It delivers from the tick at 165 to the one at 195 (last byte 195: 60 s old at 255, 75 s at 270).
    await h.ticks(165, 300, (s) => {
      if (s <= 200) h.feed('motion', c.id, s);
    });
    assert.deepEqual(h.killTimes(), [75, 270], 'a process was killed while waiting, or the stall after the gap was missed');
    assert.deepEqual(h.postTimes(), [270], 'the gap and waiting cost the leg its attempt count: no escalation');
  });

  test('C9b: a crash loop posts its request at the first tick PAST EPISODE_STALL, not at it', async () => {
    const c = cam('c9b');
    const h = detectorHarness([c]);
    const P = 'cam_c9b-sub';
    h.run('motion', c.id, { path: P, spawned: -600, data: 0 });
    await h.ticks(15, 75); // action at 75
    await h.ticks(90, 300, (s) => {
      // A new process every 30 s, none of which ever delivers (each dies inside its grace).
      if (s % 30 === 0) h.run('motion', c.id, { path: P, spawned: s - 2 });
      else h.gap('motion', c.id);
    });
    // 75 + 180 = 255 is AT the limit; the first tick past it is 270.
    assert.deepEqual(h.postTimes(), [270]);
    assert.deepEqual(h.killTimes(), [75]);
    // `attempt(s)`, not `restart(s)` (#578): the count includes a refused kill, so it is not a count of restarts.
    assert.match(h.events[1].detail, /no data through 1 attempt\(s\)/);
    assert.doesNotMatch(h.events[1].detail, /restart\(s\)/);
  });

  test('C9d: an action resets the generation count: after an escalation, ONE more replacement is not a crash loop', async () => {
    const c = cam('c9d');
    const h = detectorHarness([c]);
    const P = 'cam_c9d-sub';
    h.run('motion', c.id, { path: P, spawned: -600, data: 0 });
    await h.ticks(15, 75);
    await h.ticks(90, 285, (s) => {
      if (s % 30 === 0) h.run('motion', c.id, { path: P, spawned: s - 2 });
      else h.gap('motion', c.id);
    });
    assert.deepEqual(h.postTimes(), [270], 'precondition: the crash loop did not escalate at 270');
    h.run('motion', c.id, { path: P, spawned: 298 }); // one more replacement, then the path's publisher never returns
    await h.tickAt(300);
    h.waiting('motion', c.id);
    await h.ticks(315, 900);
    assert.deepEqual(h.postTimes(), [270], 'the generations counted before the escalation were counted again');
  });

  test('C9e: the process an action judged is not a REPLACEMENT: if it outlives the kill, ONE real replacement is still not a crash loop', async () => {
    const c = cam('c9e');
    const h = detectorHarness([c]);
    const P = 'cam_c9e-sub';
    h.run('motion', c.id, { path: P, spawned: -600, data: 0 });
    await h.ticks(15, 75); // L1 at 75; the fake kill does nothing, so the SAME process is still there at 90
    await h.tickAt(90);
    h.gap('motion', c.id);
    await h.tickAt(105);
    h.run('motion', c.id, { path: P, spawned: 118 }); // the one real replacement, which dies young
    await h.tickAt(120);
    h.gap('motion', c.id);
    await h.tickAt(135);
    h.waiting('motion', c.id);
    await h.ticks(150, 450);
    assert.deepEqual(h.killTimes(), [75]);
    assert.deepEqual(h.postTimes(), [], 'the killed process itself was counted as a replacement generation');
  });

  test('C9c: recovery, then a crash loop: a healthy tick after the action blocks episode escalation', async () => {
    const c = cam('c9c');
    const h = detectorHarness([c]);
    const P = 'cam_c9c-sub';
    h.run('motion', c.id, { path: P, spawned: -600, data: 0 });
    await h.ticks(15, 75);
    h.run('motion', c.id, { path: P, spawned: 85 });
    await h.ticks(90, 150, (s) => h.feed('motion', c.id, s)); // healthy 90..150 (less than RECOVERED_MS)
    await h.ticks(165, 420, (s) => {
      if (s % 30 === 0) h.run('motion', c.id, { path: P, spawned: s - 2 });
      else h.gap('motion', c.id);
    });
    assert.deepEqual(h.postTimes(), [], 'a leg that had a healthy tick since the action was escalated as a crash loop');
    assert.deepEqual(h.killTimes(), [75]);
  });

  // INTENDED, AND PINNED (#369 review fix round, 2026-09-28, review claim 7). A crash loop escalates from its EPISODE
  // bookkeeping alone (generations without data, time since the last action, no healthy tick since), never from the
  // CURRENT tick's reading: in a crash loop each replacement dies inside its own grace, so the tick that crosses
  // EPISODE_STALL can just as well land in the 5 s relaunch gap (null) or on `waiting`. A review asked whether that
  // is a bug. It is not, for two reasons these tests hold in place: the verdict can only ever POST A REQUEST (a kill
  // needs an entry-stalled current process, and a null one has no spawn token to aim a kill at), and the E5 re-read
  // after the probe still governs it. #369 M09h/M09i/M09j.
  const crashLoopUntil255 = async (h, c, P) => {
    h.run('motion', c.id, { path: P, spawned: -600, data: 0 });
    await h.ticks(15, 75); // L1 at 75
    // A replacement every 30 s that never delivers (each dies inside its grace), the relaunch gap between: six
    // generations by 255, which is AT EPISODE_STALL (75 + 180), not past it.
    await h.ticks(90, 255, (s) => {
      if (s % 30 === 0) h.run('motion', c.id, { path: P, spawned: s - 2 });
      else h.gap('motion', c.id);
    });
    assert.deepEqual(h.postTimes(), [], 'precondition: escalated at or before EPISODE_STALL');
    const ep = h.wd.episodeOf(c.id, 'motion');
    assert.ok(ep.gensWithoutData >= 2 && ep.lastHealthyMono == null, `precondition: not a crash loop: ${JSON.stringify(ep)}`);
  };

  for (const [label, darken] of [
    ['the relaunch gap (null)', (h, id) => h.gap('motion', id)],
    ['`waiting`', (h, id) => h.waiting('motion', id)],
  ]) {
    test(`C9f: a crash loop escalates on a tick whose CURRENT reading is ${label}: exactly one publisher request, never a kill, through the E5 re-check`, async () => {
      const c = cam(`c9f-${label.replace(/\W/g, '')}`);
      const h = detectorHarness([c]);
      const P = `${c.mediamtx_path}-sub`;
      await crashLoopUntil255(h, c, P);
      darken(h, c.id);
      guards.resetGuardRateLimit();
      const threw = logged('[guard:detector-watchdog');
      const from = h.calls.length;
      await h.tickAt(270); // 195 s after the action: the first tick past EPISODE_STALL
      // E3 (status), the probe, the E5 re-read (status), then the request and the event. No kill:motion. The
      // request comes BEFORE the event since #578 (the event is written last, after whatever lever ran; here
      // none did, so the order is the request's own position, ahead of that).
      assert.deepEqual(h.calls.slice(from), ['status', 'probe:video', 'status', 'post', 'event'],
        `the escalation did not go status -> probe -> status -> post -> event: ${h.calls.slice(from).join(', ')}`);
      assert.deepEqual(h.posted.map((p) => [p.at, p.kind]), [[270, 'sub']]);
      assert.deepEqual(h.killTimes(), [75], 'a crash-loop escalation killed a detector');
      // A kill aimed at a null reading would throw on its missing spawn token, inside the runner's catch.
      assert.equal(logged('[guard:detector-watchdog'), threw, 'the escalation tick threw');
      assert.match(h.events.at(-1).detail,
        /^motion detector getting no frames \(no data through 1 attempt\(s\) and the relaunches since\) - sub-stream \(Low\) restart requested by the detector watchdog$/);
      // No kill was attempted here (#578), so the line must not mention one: nothing appended after `lever:`.
      const last = logger.getRecent().filter((l) => l.includes(`[detector-watchdog] "${c.name}"`)).at(-1);
      assert.ok(last.includes('[WARN]') && last.endsWith('attempt 2; lever: sub publisher'), `a request-only line mentions a kill: ${last}`);
      const ep = h.wd.episodeOf(c.id, 'motion');
      assert.deepEqual([ep.attempts, ep.lastActionMono, ep.gensWithoutData], [2, h.ms(270), 0], 'the escalation was not committed as attempt 2');
    });
  }

  test('C9g: the same escalation ABORTS when the replacement delivers during the probe: the E5 re-read governs it too', async () => {
    const c = cam('c9g');
    const h = detectorHarness([c]);
    const P = `${c.mediamtx_path}-sub`;
    await crashLoopUntil255(h, c, P);
    h.gap('motion', c.id);
    // The momentary null was only the relaunch gap: the next process is up and delivering by the time the probe ends.
    h.probe = () => {
      h.run('motion', c.id, { path: P, spawned: 266, data: 270 });
      return Promise.resolve(true);
    };
    const from = h.calls.length;
    await h.tickAt(270);
    assert.deepEqual(h.calls.slice(from), ['status', 'probe:video', 'status'], 'acted on a leg that recovered during the probe');
    assert.deepEqual(h.postTimes(), []);
    assert.deepEqual(h.killTimes(), [75]);
    assert.equal(h.events.length, 1, 'an aborted escalation recorded an event');
    const ep = h.wd.episodeOf(c.id, 'motion');
    assert.deepEqual([ep.attempts, ep.lastActionMono], [1, h.ms(75)], 'an aborted escalation changed the episode');
  });
});

// ---------------------------------------------------------------------------------------------------------
describe('C10: backoff, recovery and forgetting', () => {
  test('C10a: a leg that never recovers is acted on at 75, 135, 255, 495, 975, 1935, 3735, 5535 (doubling, capped at 30 min)', async () => {
    const c = cam('c10a');
    const h = detectorHarness([c]);
    h.run('motion', c.id, { path: 'cam_c10a-sub', spawned: -600, data: 0 });
    await h.ticks(15, 6000);
    assert.deepEqual(h.killTimes(), [75, 135, 255, 495, 975, 1935, 3735, 5535]);
    assert.deepEqual(h.postTimes(), [135, 255, 495, 975, 1935, 3735, 5535]);
    assert.equal(wd.detectorRestartFloorMs(0), 0);
    assert.equal(wd.detectorRestartFloorMs(40), DETECTOR_RESTART_CAP_MS, 'a large attempt count escaped the cap');
  });

  test('C10b: one byte after a restart resets nothing: the next stall is attempt 2', async () => {
    const c = cam('c10b');
    const h = detectorHarness([c]);
    h.run('motion', c.id, { path: 'cam_c10b-sub', spawned: -600, data: 0 });
    await h.ticks(15, 75);
    h.feed('motion', c.id, 80);
    await h.ticks(90, 150);
    assert.deepEqual(h.killTimes(), [75, 150]);
    assert.deepEqual(h.postTimes(), [150]);
  });

  test('C10c: RECOVERED_MS of unbroken health ends the episode, at exactly 300 s: the next stall is attempt 1 again', async () => {
    const c = cam('c10c');
    const h = detectorHarness([c]);
    h.run('motion', c.id, { path: 'cam_c10c-sub', spawned: -600, data: 0 });
    await h.ticks(15, 75);
    // Healthy from the tick at 90 to the tick at 390 (last byte at 330: 60 s old at 390, 75 s at 405), so the
    // tick at 390 is the LAST healthy one: exactly 300 s after the first.
    await h.ticks(90, 390, (s) => { if (s <= 330) h.feed('motion', c.id, s); });
    assert.equal(h.wd.episodeOf(c.id, 'motion'), null, 'five minutes of health did not end the episode');
    await h.tickAt(405);
    assert.deepEqual(h.killTimes(), [75, 405]);
    assert.deepEqual(h.postTimes(), [], 'a recovered leg kept its attempt count');
  });

  test('C10d: any non-healthy tick restarts the recovery clock', async () => {
    const c = cam('c10d');
    const h = detectorHarness([c]);
    const P = 'cam_c10d-sub';
    h.run('motion', c.id, { path: P, spawned: -600, data: 0 });
    await h.ticks(15, 75);
    h.run('motion', c.id, { path: P, spawned: 85, data: 86 });
    await h.ticks(90, 240, (s) => h.feed('motion', c.id, s));
    h.gap('motion', c.id); // one tick in the relaunch gap
    await h.tickAt(255);
    h.run('motion', c.id, { path: P, spawned: 258, data: 259 });
    // Healthy 270..555: 285 s, never 300 unbroken. Without the reset, 90 -> 390 would have ended the episode.
    await h.ticks(270, 570, (s) => { if (s <= 505) h.feed('motion', c.id, s); });
    assert.deepEqual(h.killTimes(), [75, 570]);
    assert.deepEqual(h.postTimes(), [570], 'the episode ended although its healthy run was broken');
  });

  for (const [name, change, restore] of [
    ['removed from listCameras (deleted)', (h, c, list) => { list.length = 0; }, (h, c, list) => { list.push(c); }],
    ['disabled', (h, c) => { c.disabled = 1; }, (h, c) => { c.disabled = 0; }],
    ['no longer wanted (detection off / window closed)', (h) => { h.wanted = () => false; }, (h) => { h.wanted = () => true; }],
  ]) {
    test(`C10e: a leg ${name} for one tick forgets its episode and cancels its requests: the next stall is attempt 1`, async () => {
      const c = cam(`c10e-${name.length}`);
      const list = [c];
      const h = detectorHarness(list);
      h.run('motion', c.id, { path: `${c.mediamtx_path}-sub`, spawned: -600, data: 0 });
      await h.ticks(15, 75);
      change(h, c, list);
      await h.tickAt(90);
      assert.ok(h.cancelled.some((x) => x.id === c.id && x.at === 90), 'its restart requests were not cancelled');
      restore(h, c, list);
      await h.tickAt(105);
      assert.deepEqual(h.killTimes(), [75, 105], 'the forgotten leg was still inside the old backoff');
      assert.deepEqual(h.postTimes(), [], 'the forgotten leg kept its attempt count');
    });
  }
});

// ---------------------------------------------------------------------------------------------------------
describe('C11/C12: the recheck after the probe, and commit-before-mutate', () => {
  test('C11: the leg recovers WHILE the probe runs: no kill, no event, no request, no episode change', async () => {
    const c = cam('c11');
    const h = detectorHarness([c]);
    const P = 'cam_c11-sub';
    h.run('motion', c.id, { path: P, spawned: -600, data: 0 });
    await h.ticks(15, 75); // attempt 1, so a recovery would otherwise have been an escalation
    const before = h.wd.episodeOf(c.id, 'motion');
    const probe = deferred();
    h.probe = () => probe.promise;
    h.clock = h.ms(135);
    const tick = h.wd.tick();
    await flush();
    assert.equal(h.calls.at(-1), 'probe:video', 'precondition: the check is not waiting on the probe');
    h.clock = h.ms(140);
    h.feed('motion', c.id, 140); // the SAME process delivers again
    probe.resolve(true);
    await tick;
    assert.deepEqual(h.killTimes(), [75], 'the recovered process was killed');
    assert.equal(h.events.length, 1);
    assert.deepEqual(h.posted, []);
    assert.deepEqual(h.wd.episodeOf(c.id, 'motion'), before, 'an aborted check changed the episode');
  });

  test('C11b: the detector moves to ANOTHER path while the probe runs: nothing is asked of the old path\'s publisher', async () => {
    const c = cam('c11b');
    const h = detectorHarness([c]);
    const P = 'cam_c11b-sub';
    h.run('motion', c.id, { path: P, spawned: -600, data: 0 });
    await h.ticks(15, 75);
    await h.ticks(90, 255, (s) => {
      if (s % 30 === 0) h.run('motion', c.id, { path: P, spawned: s - 2 });
      else h.gap('motion', c.id);
    });
    h.run('motion', c.id, { path: P, spawned: 268 }); // the crash loop is escalation-ready at 270
    const probe = deferred();
    h.probe = () => probe.promise;
    h.clock = h.ms(270);
    const tick = h.wd.tick();
    await flush();
    assert.equal(h.calls.at(-1), 'probe:video', 'precondition: the check is not waiting on the probe');
    h.run('motion', c.id, { path: c.mediamtx_path, spawned: 272 }); // relaunched onto MAIN meanwhile
    h.clock = h.ms(278);
    probe.resolve(true);
    await tick;
    assert.deepEqual(h.posted.filter((p) => p.kind === 'sub'), [], 'a restart of the SUB publisher was requested for a detector now reading main');
  });

  test('C11c: the process is REPLACED while the probe runs (same path, a young one): the replacement is not killed', async () => {
    // The verdict must come from the health read AFTER the probe: the one read before it described a process
    // that no longer exists, and the kill would land on its young replacement (whose tokens are the fresh ones).
    const c = cam('c11c');
    const h = detectorHarness([c]);
    const P = 'cam_c11c-sub';
    h.run('motion', c.id, { path: P, spawned: -600, data: 0 });
    const probe = deferred();
    h.probe = () => probe.promise;
    h.clock = h.ms(75);
    const tick = h.wd.tick();
    await flush();
    assert.equal(h.calls.at(-1), 'probe:video', 'precondition: the check is not waiting on the probe');
    h.run('motion', c.id, { path: P, spawned: 78 }); // it exited on its own and relaunched meanwhile
    h.clock = h.ms(83);
    probe.resolve(true);
    await tick;
    assert.deepEqual(h.kills, [], 'the young replacement was killed on its predecessor\'s verdict');
    assert.deepEqual(h.events, []);
    assert.equal(h.wd.episodeOf(c.id, 'motion'), null, 'an aborted check created an episode');
  });

  test('C12a: a lever that empties the entry (the real exit path): the attempt is counted once, then the gap is skipped', async () => {
    const c = cam('c12a');
    const h = detectorHarness([c]);
    h.onKill = (leg, id) => { h.gap(leg, id); return true; };
    h.run('motion', c.id, { path: 'cam_c12a-sub', spawned: -600, data: 0 });
    const lines = () => logged('[detector-watchdog] "Cam c12a"');
    await h.ticks(15, 300);
    assert.deepEqual(h.killTimes(), [75]);
    assert.equal(h.events.length, 1);
    assert.equal(lines(), 1, 'the diagnosis line was not written exactly once');
    assert.equal(h.wd.episodeOf(c.id, 'motion').attempts, 1);
  });

  test('C12b: a lever that THROWS: no row (nothing was restarted), one INFO line, the throw still reaches the guard, the attempt counted, no retry inside the floor', async () => {
    // E7 (the attempt is committed BEFORE the lever) is pinned here: with the commit moved after the lever, or
    // rolled back on a throw, the throwing lever would be called again inside the floor. Since #578 the row is
    // written AFTER the lever and says only what acted, so a lever that threw writes none (it used to write
    // "detector restarted" first).
    const c = cam('c12b');
    const h = detectorHarness([c]);
    h.onKill = () => { throw new Error('lever exploded (planted)'); };
    h.run('motion', c.id, { path: 'cam_c12b-sub', spawned: -600, data: 0 });
    guards.resetGuardRateLimit();
    await h.ticks(15, 120);
    assert.deepEqual(h.killTimes(), [75], 'the throwing lever was retried inside the backoff floor');
    assert.deepEqual(h.events, [], 'a lever that threw was recorded as a restart');
    assert.equal(logged('[detector-watchdog] "Cam c12b"'), 1);
    const first = logger.getRecent().filter((l) => l.includes('[detector-watchdog] "Cam c12b"'));
    assert.ok(first[0].includes('[INFO]') && first[0].includes('lever threw'), `not an INFO "lever threw" line: ${first[0]}`);
    assert.equal(logged('[guard:detector-watchdog:Cam c12b:motion]'), 1, 'the throw was not reported under the leg\'s own guard label');
    assert.equal(h.wd.episodeOf(c.id, 'motion').attempts, 1);

    // Attempt 2 (t=135): the request is posted and the lever throws again. The row is worded for the request
    // ONLY, the throw still reaches the guard (a second report, once its rate limit is cleared), and the attempt
    // is counted.
    guards.resetGuardRateLimit();
    await h.tickAt(135);
    assert.deepEqual(h.killTimes(), [75, 135]);
    assert.deepEqual(h.postTimes(), [135], 'a lever that threw swallowed the publisher request');
    assert.equal(h.events.length, 1);
    assert.equal(h.events[0].detail,
      'motion detector getting no frames (no data for 135s) - sub-stream (Low) restart requested by the detector watchdog');
    const second = logger.getRecent().filter((l) => l.includes('[detector-watchdog] "Cam c12b"')).at(-1);
    assert.ok(second.includes('[WARN]') && second.endsWith('attempt 2; lever: sub publisher; detector kill threw'), second);
    assert.equal(logged('[guard:detector-watchdog:Cam c12b:motion]'), 2, 'the second throw was swallowed instead of reaching the guard');
    assert.equal(h.wd.episodeOf(c.id, 'motion').attempts, 2);
  });

  test('C12b2: a lever that throws a FALSY value (`throw undefined`) is still a throw: worded as one, reaches the guard, no row, the attempt counted', async () => {
    // JavaScript can throw anything. A check on the caught VALUE (`if (err)`) would read `throw undefined` as a
    // plain refusal: no "threw" wording and, worse, the throw swallowed instead of reaching the guard.
    const c = cam('c12b2');
    const h = detectorHarness([c]);
    h.onKill = () => { throw undefined; }; // eslint-disable-line no-throw-literal
    h.run('motion', c.id, { path: 'cam_c12b2-sub', spawned: -600, data: 0 });
    guards.resetGuardRateLimit();
    await h.ticks(15, 120);
    assert.deepEqual(h.killTimes(), [75], 'the throwing lever was retried inside the backoff floor');
    assert.deepEqual(h.events, [], 'a lever that threw was recorded as a restart');
    const lines = logger.getRecent().filter((l) => l.includes('[detector-watchdog] "Cam c12b2"'));
    assert.equal(lines.length, 1);
    assert.ok(lines[0].includes('[INFO]') && lines[0].includes('lever threw') && !lines[0].includes('lever refused'), lines[0]);
    assert.equal(logged('[guard:detector-watchdog:Cam c12b2:motion]'), 1, 'a falsy throw was swallowed instead of reaching the guard');
    assert.equal(h.wd.episodeOf(c.id, 'motion').attempts, 1);
  });

  test('C12c/C17: the diagnosis line carries path, path status, probe, input-tap age (INCONCLUSIVE when absent), attempt, lever', async () => {
    const c = cam('c12c');
    const h = detectorHarness([c]);
    h.probe = () => 'video-missing';
    h.run('motion', c.id, { path: 'cam_c12c-sub', spawned: -600, data: 0 });
    await h.ticks(15, 75);
    h.legs.motion.get(c.id).inputAt = h.ms(130);
    await h.ticks(90, 135);
    const lines = logger.getRecent().filter((l) => l.includes('[detector-watchdog] "Cam c12c"'));
    assert.equal(lines.length, 2);
    assert.match(lines[0], /\[WARN\] \[detector-watchdog\] "Cam c12c" motion on cam_c12c-sub: no data for 75s; path ready, 2 reader\(s\), tracks H264\+Opus; probe: audio but NO video packets; input tap: no record \(inconclusive\); attempt 1; lever: detector$/);
    assert.match(lines[1], /no data for 135s; .*input tap: last record 5s ago; attempt 2; lever: detector \+ sub publisher$/);
  });
});

// ---------------------------------------------------------------------------------------------------------
// #578: the history says what HAPPENED. The lever (killStalledDetector) returns false when it refuses: no entry,
// a kill already in flight, a detector `returning` from main to the sub stream (#500), a replaced process, data
// that arrived meanwhile, a process too young, or nothing to signal. The watchdog used to write the camera_events
// RESTART row and the WARN line BEFORE calling the lever and to ignore its answer, so every one of those wrote
// "detector restarted" for a restart that never happened. The row and the line now follow the lever and name only
// what acted. The attempt is still COMMITTED first (E7): a refused kill counts, which is documented, not hidden.
// The detector-side half (the REAL lever refusing a `returning` entry) is in motion-return-to-sub.test.js.
describe('C21 (#578): a kill the lever refused is not recorded as a restart', () => {
  // Every line the watchdog wrote about this camera's legs (the diagnosis lines; the guard's own lines differ).
  const linesOf = (c) => logger.getRecent().filter((l) => l.includes(`[detector-watchdog] "${c.name}"`));
  const motionHarness = (id, onKill) => {
    const c = cam(id);
    const h = detectorHarness([c]);
    h.onKill = onKill;
    h.run('motion', c.id, { path: `${c.mediamtx_path}-sub`, spawned: -600, data: 0 });
    return { c, h };
  };

  test('C21a: motion, lever REFUSES: no row, exactly one INFO line saying so, no WARN, the attempt still counted (E7)', async () => {
    const { c, h } = motionHarness('c21a', () => false);
    await h.ticks(15, 120);
    assert.deepEqual(h.killTimes(), [75], 'the refused kill was retried inside the backoff floor (or never tried)');
    assert.deepEqual(h.events, [], 'a refused kill was recorded in Camera history as a restart');
    assert.deepEqual(h.postTimes(), [], 'the first action asked for a publisher restart');
    const lines = linesOf(c);
    assert.equal(lines.length, 1, `expected one diagnosis line, got ${lines.length}`);
    assert.ok(lines[0].includes('[INFO]') && lines[0].includes('lever refused'), `not an INFO "lever refused" line: ${lines[0]}`);
    assert.equal(lines.filter((l) => l.includes('[WARN]')).length, 0, 'a refused kill logged a WARN');
    assert.match(lines[0], /no data for 75s; path ready, 2 reader\(s\), tracks H264\+Opus; probe: video packets arriving \(packets, not frames\); input tap: no record \(inconclusive\); attempt 1; lever refused: /,
      'the INFO line lost the diagnosis the WARN carries');
    // E7: the attempt is counted although nothing was killed, so the backoff applies (the 60 s floor after t=75).
    assert.equal(h.wd.episodeOf(c.id, 'motion').attempts, 1);
    // ... and it expires: at t=135 the floor has elapsed and the lever is tried again.
    await h.tickAt(135);
    assert.deepEqual(h.killTimes(), [75, 135]);
  });

  test('C21b: CONTROL, motion, lever returns true: one row, one WARN naming the detector, no "refused" anywhere', async () => {
    const { c, h } = motionHarness('c21b', () => true);
    await h.ticks(15, 120);
    assert.deepEqual(h.killTimes(), [75]);
    assert.equal(h.events.length, 1);
    assert.match(h.events[0].detail, /^motion detector getting no frames \(no data for 75s\) - motion detector restarted by the detector watchdog$/);
    const lines = linesOf(c);
    assert.equal(lines.length, 1);
    assert.ok(lines[0].includes('[WARN]') && lines[0].endsWith('attempt 1; lever: detector'), lines[0]);
    assert.ok(!lines[0].includes('refused') && !lines[0].includes('threw'), lines[0]);
    assert.equal(h.wd.episodeOf(c.id, 'motion').attempts, 1);
  });

  test('C21c: SOUND leg, lever REFUSES: no row, exactly one INFO line, the attempt counted', async () => {
    const c = cam('c21c', { sound: 1 });
    const h = detectorHarness([c]);
    h.wanted = () => false; // this camera runs no motion leg
    h.onKill = (leg) => leg !== 'sound';
    h.run('sound', c.id, { path: c.mediamtx_path, spawned: -600, data: 0 });
    await h.ticks(15, 120);
    assert.deepEqual(h.killTimes('sound'), [75], 'the refused sound kill was retried inside the floor (or never tried)');
    assert.deepEqual(h.events, [], 'a refused SOUND kill was recorded in Camera history as a restart');
    const lines = linesOf(c);
    assert.equal(lines.length, 1);
    assert.ok(lines[0].includes('[INFO]') && lines[0].includes('lever refused'), lines[0]);
    assert.match(lines[0], /sound on cam_c21c: no data for 75s; .*probe: audio flowing; .*attempt 1; lever refused: /);
    assert.equal(h.wd.episodeOf(c.id, 'sound').attempts, 1);
  });

  test('C21d: motion, attempt 2: the kill is REFUSED but the publisher request is posted: the row names only the request, one WARN says the kill was refused', async () => {
    const { c, h } = motionHarness('c21d', () => false);
    await h.ticks(15, 120);
    assert.deepEqual(h.events, [], 'precondition: attempt 1 (refused) wrote a row');
    const from = h.calls.length;
    await h.tickAt(135);
    // The order inside an action: request, lever, then the row (written last, from what acted).
    assert.deepEqual(h.calls.slice(from), ['status', 'probe:video', 'status', 'post', 'kill:motion', 'event']);
    assert.deepEqual(h.postTimes(), [135], 'a refused kill swallowed the publisher request');
    assert.equal(h.events.length, 1);
    assert.equal(h.events[0].detail,
      'motion detector getting no frames (no data for 135s) - sub-stream (Low) restart requested by the detector watchdog');
    assert.ok(!h.events[0].detail.includes('detector restarted'), 'the row still says the detector was restarted');
    const lines = linesOf(c);
    assert.equal(lines.length, 2, 'a mixed outcome must be ONE line, not two');
    assert.ok(lines[0].includes('[INFO]') && lines[0].includes('lever refused'), lines[0]);
    assert.ok(lines[1].includes('[WARN]') && lines[1].endsWith('attempt 2; lever: sub publisher; detector kill refused'), lines[1]);
    assert.equal(h.wd.episodeOf(c.id, 'motion').attempts, 2);
  });

  // Only `=== true` is a restart. killStalledDetector returns a boolean, so anything else is a mis-wired lever,
  // and "did not demonstrably restart" must not be written down as "restarted". Truthy non-true values (1, {})
  // are in the loop so that a `!!result` or `result !== false` shortcut dies; the falsy ones so that a missing
  // return does.
  let n = 0;
  for (const result of [undefined, null, 0, false, 1, {}]) {
    test(`C21e: a lever that returned ${JSON.stringify(result) ?? 'undefined'} (${typeof result}) is a refusal: no row, one INFO line`, async () => {
      const { c, h } = motionHarness(`c21e-${n++}`, () => result);
      await h.ticks(15, 120);
      assert.deepEqual(h.killTimes(), [75], 'precondition: the lever was not called exactly once');
      assert.deepEqual(h.events, [], `a lever result of ${JSON.stringify(result)} was recorded as a restart`);
      const lines = linesOf(c);
      assert.equal(lines.length, 1);
      assert.ok(lines[0].includes('[INFO]') && lines[0].includes('lever refused'), lines[0]);
    });
  }
});

// ---------------------------------------------------------------------------------------------------------
// The mailbox, consumed by the REAL camera watchdog (claim 16). The camera watchdog's own clock is a separate
// fake here on purpose: the mailbox judges its TTL on ITS clock, and the two must never be compared.
function consumerHarness(c, { subRestartSec = 0 } = {}) {
  const h = {
    mono: T0, // the mailbox's clock
    wall: Date.UTC(2026, 8, 27, 3, 0, 0), // the camera watchdog's clock
    reading: () => READY,
    motion: null, // the fake motion detector leg (healthFrom shape), on the mono clock
    wanted: () => true,
    restarts: [],
    subRestarts: [],
    events: [],
    slow: [],
    subThrows: false,
  };
  h.mailbox = createRestartRequests({ now: () => h.mono });
  h.deps = {
    listCameras: () => [c],
    offlineAlertConfig: () => ({ enabled: 0, minutes: 5 }),
    getPathStatus: (p) => Promise.resolve(h.reading(p)),
    startTranscoder: async (id, url, p, name) => { h.restarts.push({ id, url, p, name }); },
    startSubStream: async (camera) => {
      h.subRestarts.push(camera.id);
      if (h.subThrows) throw new Error('startSubStream exploded (planted)');
      if (subRestartSec) await new Promise((resolve) => h.slow.push(resolve));
    },
    subConfigured: (camera) => !!camera.sub_rtsp_url,
    subPathName: (p) => `${p}-sub`,
    recordCameraEvent: (id, name, type, detail) => h.events.push({ id, type, detail }),
    notifyCameraOffline: () => {},
    notifyCameraRecovered: () => {},
    now: () => h.wall,
    restartRequests: h.mailbox,
    getMotionDetectorHealth: () => healthFrom(h.motion, h.mono),
    motionLegWanted: (camera) => h.wanted(camera),
  };
  h.wd = createCameraWatchdog(h.deps);
  h.tick = async () => {
    h.wall += 15_000;
    await h.wd.tick();
  };
  h.youngReplacement = (p) => { h.motion = { path: p, spawnedAt: h.mono - 5_000, lastDataAt: null }; };
  return h;
}

describe('C16: the restart-request mailbox, consumed by the real camera watchdog', () => {
  test('C16a: the TTL is the MAILBOX\'s clock: 1 ms under it is taken, exactly at it is dropped', () => {
    // The documented 60 s as a LITERAL: moving the clock by the imported constant follows a mutated value
    // (that is how #369 M16b first survived). C3c pins the constant itself.
    const TTL = 60_000;
    let clock = T0;
    const m = createRestartRequests({ now: () => clock });
    m.post('a', 'sub', 'r1');
    clock += TTL - 1;
    assert.deepEqual(m.take('a', 'sub'), { reason: 'r1', postedMono: T0 });
    assert.equal(m.take('a', 'sub'), null, 'a taken request was still there');
    m.post('a', 'sub', 'r2');
    clock += TTL;
    assert.equal(m.take('a', 'sub'), null, 'a request exactly TTL old was taken');
    assert.equal(m.size, 0, 'an expired request was left in the mailbox');
    // Kinds and cameras are separate; cancel removes both kinds of one camera only.
    m.post('a', 'sub', 's');
    m.post('a', 'main', 'm');
    m.post('b', 'sub', 'other');
    m.cancel('a');
    assert.equal(m.take('a', 'sub'), null);
    assert.equal(m.take('a', 'main'), null);
    assert.equal(m.take('b', 'sub').reason, 'other');
    // Nobody takes a deleted camera's request: the next post sweeps it.
    m.post('gone', 'sub', 'x');
    clock += TTL;
    m.post('c', 'main', 'y');
    assert.equal(m.size, 1, 'an expired, never-taken request was not swept');
  });

  test('C16a2: the default mailbox clock is monotonic and callable (no injected clock)', () => {
    const m = createRestartRequests();
    m.post('x', 'sub', 'r');
    const r = m.take('x', 'sub');
    assert.ok(r && Number.isFinite(r.postedMono) && r.postedMono <= performance.now());
  });

  test('C16b: a request for a young replacement that has not delivered yet IS honoured, once, with an event naming the detector (v4 bug)', async () => {
    const c = cam('c16b');
    const h = consumerHarness(c);
    h.youngReplacement('cam_c16b-sub');
    h.mailbox.post(c.id, 'sub', 'motion detector on cam_c16b-sub: no data for 75s');
    await h.tick();
    assert.deepEqual(h.subRestarts, [c.id]);
    assert.deepEqual(h.events.map((e) => [e.type, e.detail]), [[EVENT.RESTART, 'sub-stream (Low) restarted at the detector watchdog\'s request (motion detector getting no frames)']]);
    await h.tick();
    await h.tick();
    assert.deepEqual(h.subRestarts, [c.id], 'the request ran more than once');
  });

  test('C16c: the relaunch gap and `waiting` are dark too: honoured', async () => {
    for (const [label, leg] of [['gap', null], ['waiting', { waiting: true }]]) {
      const c = cam(`c16c-${label}`);
      const h = consumerHarness(c);
      h.motion = leg;
      h.mailbox.post(c.id, 'sub', 'r');
      await h.tick();
      assert.deepEqual(h.subRestarts, [c.id], `a request during ${label} was dropped`);
    }
  });

  test('C16d: a MAIN request is consumed by the main leg, with the transcoder\'s own arguments', async () => {
    const c = cam('c16d', { sub: false });
    const h = consumerHarness(c);
    h.youngReplacement(c.mediamtx_path);
    h.mailbox.post(c.id, 'main', 'r');
    await h.tick();
    assert.deepEqual(h.restarts, [{ id: c.id, url: c.rtsp_url, p: c.mediamtx_path, name: c.name }]);
    assert.match(h.events[0].detail, /^transcoder restarted at the detector watchdog's request/);
  });

  for (const [name, setup, why] of [
    ['disabled in the fresh snapshot', (h, c) => { c.disabled = 1; }, 'a disabled camera'],
    ['whose motion leg is no longer wanted', (h) => { h.wanted = () => false; }, 'detection switched off'],
    ['whose path is not ready', (h) => { h.reading = () => NOT_READY; }, 'a not-ready path'],
    ['whose path status is UNKNOWN', (h) => { h.reading = () => UNKNOWN; }, 'an unknown path'],
    ['whose detector has genuinely recovered', (h, c) => { h.motion = { path: `${c.mediamtx_path}-sub`, spawnedAt: h.mono - 60_000, lastDataAt: h.mono - 200 }; }, 'a recovered leg'],
    ['whose detector now reads the OTHER path', (h, c) => { h.youngReplacement(c.mediamtx_path); }, 'another path'],
  ]) {
    test(`C16e: a request ${name} is DROPPED without acting, and is not left for a later tick`, async () => {
      const c = cam(`c16e-${why.replace(/\W/g, '')}`);
      const h = consumerHarness(c);
      h.youngReplacement(`${c.mediamtx_path}-sub`);
      setup(h, c);
      h.mailbox.post(c.id, 'sub', 'r');
      await h.tick();
      assert.deepEqual(h.subRestarts, [], `a request for ${why} ran`);
      assert.equal(h.mailbox.size, 0, `a request for ${why} was left in the mailbox`);
      // Everything back to a state that WOULD honour it: nothing is left to honour.
      c.disabled = 0;
      h.wanted = () => true;
      h.reading = () => READY;
      h.youngReplacement(`${c.mediamtx_path}-sub`);
      await h.tick();
      assert.deepEqual(h.subRestarts, [], `a request dropped for ${why} ran on a later tick`);
    });
  }

  test('C16f: a request older than the TTL on the MAILBOX clock is dropped, however little the camera watchdog\'s clock moved', async () => {
    const c = cam('c16f');
    const h = consumerHarness(c);
    h.youngReplacement(`${c.mediamtx_path}-sub`);
    h.mailbox.post(c.id, 'sub', 'r');
    h.mono += 60_000; // the documented TTL, as a literal (see C16a)
    h.youngReplacement(`${c.mediamtx_path}-sub`);
    await h.tick();
    assert.deepEqual(h.subRestarts, []);
  });

  test('C16g: deleted BEFORE the awaited restart: a slow (16 s) or throwing restart never re-fires, even while the leg stays dark', async () => {
    const c = cam('c16g');
    const slow = consumerHarness(c, { subRestartSec: 16 });
    slow.youngReplacement(`${c.mediamtx_path}-sub`);
    slow.mailbox.post(c.id, 'sub', 'r');
    const first = slow.wd.tick(); // held open by the slow restart
    await flush();
    assert.deepEqual(slow.subRestarts, [c.id], 'precondition: the restart did not start');
    assert.equal(slow.mailbox.size, 0, 'the request was still in the mailbox during the awaited restart');
    slow.wall += 15_000;
    await slow.wd.tick(); // the sub leg is still in flight: skipped
    slow.slow.shift()();
    await first;
    await slow.tick();
    await slow.tick();
    assert.deepEqual(slow.subRestarts, [c.id], 'the slow restart re-fired');

    const d = cam('c16g2');
    const throwing = consumerHarness(d);
    throwing.subThrows = true;
    throwing.youngReplacement(`${d.mediamtx_path}-sub`);
    throwing.mailbox.post(d.id, 'sub', 'r');
    guards.resetGuardRateLimit();
    await throwing.tick();
    await throwing.tick();
    await throwing.tick();
    assert.deepEqual(throwing.subRestarts, [d.id], 'the throwing restart re-fired');
  });

  test('C16h: a check SKIPPED while pending drops its request (its reading is stale)', async () => {
    const c = cam('c16h');
    const h = consumerHarness(c);
    h.youngReplacement(`${c.mediamtx_path}-sub`);
    const held = deferred();
    h.reading = (p) => (p.endsWith('-sub') ? held.promise : READY);
    h.mailbox.post(c.id, 'sub', 'r');
    const first = h.wd.tick();
    await flush();
    h.wall += 15_000;
    await h.wd.tick(); // skips the pending sub check
    held.resolve(READY);
    await first;
    h.reading = () => READY;
    await h.tick();
    assert.deepEqual(h.subRestarts, []);
  });

  // THE MAIN LEG'S MIRROR of C16e and C16h (#369 review fix round, 2026-09-28). checkMain takes its request as its
  // very first statement, exactly like checkSub, but only the SUB leg's take was pinned: moving checkMain's take
  // into its ready branch (a "lazy take", which only fetches a request once it is about to honour it) passed every
  // test in this file, and camera-watchdogs.test.js too. A lazy take leaves a request queued through a disabled,
  // not-ready, unknown or skipped check, and a LATER tick then honours a request the earlier one should have
  // dropped. These cameras have a sub stream, so "the OTHER path" is the build note D5 case: a detector that
  // relaunched onto sub after a main stall must not cost the live view a main restart. #369 M16o/M16p.
  for (const [name, setup, why] of [
    ['disabled in the fresh snapshot', (h, c) => { c.disabled = 1; }, 'a disabled camera'],
    ['whose motion leg is no longer wanted', (h) => { h.wanted = () => false; }, 'detection switched off'],
    ['whose path is not ready', (h) => { h.reading = () => NOT_READY; }, 'a not-ready path'],
    ['whose path status is UNKNOWN', (h) => { h.reading = () => UNKNOWN; }, 'an unknown path'],
    ['whose detector has genuinely recovered', (h, c) => { h.motion = { path: c.mediamtx_path, spawnedAt: h.mono - 60_000, lastDataAt: h.mono - 200 }; }, 'a recovered leg'],
    ['whose detector now reads the OTHER path', (h, c) => { h.youngReplacement(`${c.mediamtx_path}-sub`); }, 'another path'],
  ]) {
    test(`C16j: a MAIN request ${name} is DROPPED without acting, and is not left for a later tick`, async () => {
      const c = cam(`c16j-${why.replace(/\W/g, '')}`);
      const h = consumerHarness(c);
      h.youngReplacement(c.mediamtx_path);
      setup(h, c);
      h.mailbox.post(c.id, 'main', 'r');
      await h.tick();
      assert.deepEqual(h.restarts, [], `a main request for ${why} ran`);
      assert.equal(h.mailbox.size, 0, `a main request for ${why} was left in the mailbox`);
      // Everything back to a state that WOULD honour it: nothing is left to honour.
      c.disabled = 0;
      h.wanted = () => true;
      h.reading = () => READY;
      h.youngReplacement(c.mediamtx_path);
      await h.tick();
      assert.deepEqual(h.restarts, [], `a main request dropped for ${why} ran on a later tick`);
      assert.deepEqual(h.subRestarts, [], 'a MAIN request restarted the sub publisher');
    });
  }

  test('C16k: a MAIN check SKIPPED while pending drops its request (its reading is stale)', async () => {
    const c = cam('c16k');
    const h = consumerHarness(c);
    h.youngReplacement(c.mediamtx_path);
    const held = deferred();
    h.reading = (p) => (p.endsWith('-sub') ? READY : held.promise);
    h.mailbox.post(c.id, 'main', 'r');
    const first = h.wd.tick();
    await flush();
    h.wall += 15_000;
    await h.wd.tick(); // skips the pending main check
    held.resolve(READY);
    await first;
    assert.equal(h.mailbox.size, 0, 'the skipped main check left its request in the mailbox');
    h.reading = () => READY;
    await h.tick();
    assert.deepEqual(h.restarts, [], 'a request a skipped check should have dropped ran on a later tick');
  });

  test('C16l: after a path flip drops a request (C16e/C16j), the next request is for the NEW path, one backoff step later, not a TTL later', async () => {
    // The detector-side half of the documented bound (KNOWN-ISSUES.md, "A detector was restarted", point 2). The
    // detector watchdog never learns that the camera watchdog dropped its request: it asks again only at its next
    // ladder step, which the backoff floor gates (2 min after the second attempt), and for the stream the detector
    // reads by then. Nothing re-posts when the dropped request would have expired (135 + TTL + one check = 210).
    const c = cam('c16l');
    const h = detectorHarness([c]);
    h.run('motion', c.id, { path: `${c.mediamtx_path}-sub`, spawned: -600, data: 0 });
    await h.ticks(15, 135); // L1 at 75; L2 at 135 posts the SUB request
    assert.deepEqual(h.posted.map((p) => [p.at, p.kind]), [[135, 'sub']], 'precondition: no sub request at 135');
    // The kill relaunches the detector onto the MAIN stream, where it gets nothing either.
    h.run('motion', c.id, { path: c.mediamtx_path, spawned: 140 });
    await h.ticks(150, 300);
    assert.deepEqual(h.posted.map((p) => [p.at, p.kind]), [[135, 'sub'], [255, 'main']],
      'the next request did not come one backoff step (120 s) after the dropped one, for the path the detector now reads');
  });

  // THE TWO-WATCHDOG SIMULATION (Sol R2, P1): both watchdogs on one fake clock, in every relative timer phase,
  // with the video probe's 8 s and the detector's 5 s relaunch. The sub publisher is wedged until restarted, so
  // detector restarts alone cannot help: recovery REQUIRES the request to be posted, consumed and acted on.
  for (const subRestartSec of [0, 16]) {
    test(`C16i: two watchdogs, every timer phase, restart taking ${subRestartSec}s: the request is consumed exactly once and the publisher restarted`, async () => {
      for (let phase = 0; phase < 15; phase++) {
        const r = await simulate({ phase, subRestartSec });
        assert.deepEqual(r.posted.length, 1, `phase ${phase}: ${r.posted.length} requests posted`);
        assert.deepEqual(r.subRestarts.length, 1, `phase ${phase}: the publisher was restarted ${r.subRestarts.length} times`);
        assert.equal(r.camEvents.filter((e) => e.includes('detector watchdog')).length, 1, `phase ${phase}: consumer events`);
        assert.ok(r.healthyAtEnd, `phase ${phase}: the leg never recovered`);
        assert.ok(r.subRestarts[0] - r.posted[0] < RESTART_REQUEST_TTL_MS / 1000, `phase ${phase}: consumed after the TTL`);
      }
    });
  }
});

async function simulate({ phase, subRestartSec }) {
  const c = cam('sim');
  const P = 'cam_sim-sub';
  let clock = T0;
  const sec = () => (clock - T0) / 1000;
  const timers = [];
  const after = (s) => new Promise((resolve) => timers.push({ due: clock + s * 1000, resolve }));
  // The detector: the current process (or null in the relaunch gap), and whether the sub publisher works.
  let restreamOk = false;
  let gen = { spawnedAt: T0 - 600_000, lastDataAt: T0 };
  let relaunchAt = null;
  const exitAndRelaunch = () => { gen = null; relaunchAt = clock + 5_000; };
  const model = () => {
    if (relaunchAt != null && clock >= relaunchAt) { gen = { spawnedAt: clock, lastDataAt: null }; relaunchAt = null; }
    if (gen && restreamOk && clock - gen.spawnedAt >= 2_000) gen.lastDataAt = clock;
  };
  const health = () => healthFrom(gen && { path: P, ...gen }, clock);
  const r = { posted: [], subRestarts: [], camEvents: [] };
  const mailbox = createRestartRequests({ now: () => clock });
  const restartRequests = {
    post: (...a) => { r.posted.push(sec()); mailbox.post(...a); },
    take: mailbox.take,
    cancel: mailbox.cancel,
  };
  const detector = createDetectorWatchdog({
    listCameras: () => [c],
    getPathStatus: async () => READY,
    subPathName: (p) => `${p}-sub`,
    motionLegWanted: () => true,
    getMotionDetectorHealth: health,
    getSoundDetectorHealth: () => null,
    restartMotionDetector: (_id, expect) => {
      if (gen && gen.spawnedAt === expect.expectSpawn) exitAndRelaunch();
      return true;
    },
    restartSoundDetector: () => false,
    probeVideoFlowing: async () => { await after(8); return true; },
    probeAudioFlowing: async () => true,
    recordCameraEvent: () => {},
    now: () => clock,
    restartRequests,
  });
  const camera = createCameraWatchdog({
    listCameras: () => [c],
    offlineAlertConfig: () => ({ enabled: 0, minutes: 5 }),
    getPathStatus: async () => READY,
    startTranscoder: async () => {},
    startSubStream: async () => {
      r.subRestarts.push(sec());
      if (gen) exitAndRelaunch(); // the detector's input ends with the publisher
      if (subRestartSec) await after(subRestartSec);
      restreamOk = true;
    },
    subConfigured: () => true,
    subPathName: (p) => `${p}-sub`,
    recordCameraEvent: (_id, _name, _type, detail) => r.camEvents.push(detail),
    notifyCameraOffline: () => {},
    notifyCameraRecovered: () => {},
    now: () => clock,
    restartRequests,
    getMotionDetectorHealth: health,
    motionLegWanted: () => true,
  });
  for (let s = 0; s <= 900; s++) {
    clock = T0 + s * 1000;
    model();
    for (const t of timers.filter((x) => x.due <= clock)) {
      timers.splice(timers.indexOf(t), 1);
      t.resolve();
    }
    await flush();
    model();
    // Ticks are NOT awaited: a tick holding a probe or a slow restart stays pending while later ticks run, as
    // with safeInterval in production.
    if (s % 15 === 0) { detector.tick(); await flush(); }
    if (s >= phase && (s - phase) % 15 === 0) { camera.tick(); await flush(); }
  }
  r.healthyAtEnd = wd.detectorLegHealthy(health());
  return r;
}

// ---------------------------------------------------------------------------------------------------------
describe('C18/C20: production wiring', () => {
  test('C18a: every detector-watchdog dep IS the real function it names, except `now` (a wrapper by necessity)', async () => {
    const mediamtx = await import('../src/lib/mediamtx.js');
    const cameraEvents = await import('../src/lib/cameraEvents.js');
    const audio = await import('../src/lib/audioLiveness.js');
    const motion = await import('../src/lib/motionDetector.js');
    const sound = await import('../src/lib/soundDetector.js');
    const expected = {
      listCameras: wd.listCameras,
      getPathStatus: mediamtx.getPathStatus,
      subPathName: mediamtx.subPathName,
      motionLegWanted: motion.motionLegWanted,
      getMotionDetectorHealth: motion.getMotionDetectorHealth,
      getSoundDetectorHealth: sound.getSoundDetectorHealth,
      restartMotionDetector: motion.restartMotionDetector,
      restartSoundDetector: sound.restartSoundDetector,
      probeVideoFlowing: audio.probeVideoFlowing,
      probeAudioFlowing: audio.probeAudioFlowing,
      recordCameraEvent: cameraEvents.recordCameraEvent,
    };
    const actual = wd.DEFAULT_DETECTOR_WATCHDOG_DEPS;
    assert.deepEqual(Object.keys(actual).sort(), [...Object.keys(expected), 'now'].sort(), 'DEFAULT_DETECTOR_WATCHDOG_DEPS has a missing or extra dep');
    for (const key of Object.keys(expected)) {
      assert.equal(typeof expected[key], 'function', `test bug: the real ${key} is not a function`);
      assert.equal(actual[key], expected[key], `DEFAULT_DETECTOR_WATCHDOG_DEPS.${key} is not the real ${key}`);
    }
    const consumer = wd.DEFAULT_RESTART_REQUEST_CONSUMER_DEPS;
    assert.deepEqual(Object.keys(consumer).sort(), ['getMotionDetectorHealth', 'motionLegWanted']);
    assert.equal(consumer.getMotionDetectorHealth, motion.getMotionDetectorHealth);
    assert.equal(consumer.motionLegWanted, motion.motionLegWanted);
  });

  test('C18b: index.js builds ONE mailbox and hands it, and each watchdog\'s TICK, to safeInterval', () => {
    const code = stripCommentsOnly(fs.readFileSync(path.join(BACKEND, 'src', 'index.js'), 'utf8'));
    assert.equal((code.match(/createRestartRequests\(/g) || []).length, 1, 'index.js does not build exactly one mailbox');
    assert.match(code, /const restartRequests = createRestartRequests\(\);/);
    assert.match(code, /safeInterval\(\s*'camera-watchdog'\s*,\s*WATCHDOG_INTERVAL_MS\s*,\s*createCameraWatchdog\(\{\s*restartRequests\s*\}\)\.tick\s*\)/,
      'the camera watchdog does not get the shared mailbox (it would never consume a request)');
    assert.match(code, /safeInterval\(\s*'detector-watchdog'\s*,\s*DETECTOR_CHECK_INTERVAL_MS\s*,\s*createDetectorWatchdog\(\{\s*restartRequests\s*\}\)\.tick\s*\)/,
      'the detector watchdog is not wired: safeInterval(\'detector-watchdog\', DETECTOR_CHECK_INTERVAL_MS, createDetectorWatchdog({ restartRequests }).tick)');
    assert.match(code, /import\s*\{[^}]*\bcreateDetectorWatchdog\b[^}]*\bcreateRestartRequests\b[^}]*\bDETECTOR_CHECK_INTERVAL_MS\b[^}]*\}\s*from\s*'\.\/lib\/cameraWatchdogs\.js'/,
      'the detector watchdog pieces are used in index.js but not imported from lib/cameraWatchdogs.js');
  });

  test('C20: the detector watchdog NEVER starts a publisher: only the two older watchdogs and their bindings name one, nothing the detector watchdog reaches does, and its deps carry none', () => {
    // WHY THE WHOLE FILE (#369 review fix round, 2026-09-28). This used to scan only from the section marker to
    // EOF, so a module-level helper declared ABOVE the marker that called startTranscoder, and was called by the
    // detector watchdog, passed it (verified by planting one). The scan now covers every top-level declaration.
    const src = fs.readFileSync(path.join(BACKEND, 'src', 'lib', 'cameraWatchdogs.js'), 'utf8');
    const marker = src.indexOf('// #369: THE DETECTOR WATCHDOG');
    assert.ok(marker > 0, 'the detector watchdog section marker moved: re-point this tripwire');
    assert.ok(src.indexOf('export function createDetectorWatchdog(') > marker, 'test bug: the detector watchdog is not declared inside its section');
    // Comments out, STRINGS KEPT: blanking strings would hide `deps['startTranscoder']`, and stripCommentsAndStrings
    // blanks a whole template literal, `${...}` calls included (sourceScan.js explains the same trap for timers).
    const code = stripCommentsOnly(src);
    // Top-level statements, split at every line that starts in column 0 with anything but a closing bracket. In
    // this file every nested line is indented and each top-level block ends on a column-0 `}` or `});`, so one
    // chunk can never swallow the declaration after it. A statement with no declared name gets a label that is
    // on no list below, so a publisher named in one fails closed.
    const starts = [...code.matchAll(/^(?=[^\s})\]])/gm)].map((m) => m.index);
    const decls = starts.map((at, i) => {
      const body = code.slice(at, starts[i + 1] ?? code.length);
      const m = /^(?:export\s+)?(?:async\s+)?(?:function\s*\*?\s*|class\s+|(?:const|let|var)\s+)([A-Za-z_$][\w$]*)/.exec(body);
      return { name: /^import\b/.test(body) ? 'import' : m ? m[1] : `(statement: ${body.slice(0, 40).trim()})`, body };
    });
    const namesPublisher = (body) => /\b(?:startTranscoder|startSubStream)\b/.test(body);

    // 1. The ONLY declarations allowed to name a publisher starter: the imports that bind them, the two older
    // watchdogs' production bindings, and the two older watchdogs themselves (checkMain/checkSub restart the main
    // and sub publishers, checkAudio the main one). Exact, so the scan provably SEES the legitimate callers: a
    // chunking bug that found nothing would fail here instead of passing vacuously.
    const PERMITTED = ['DEFAULT_AUDIO_WATCHDOG_DEPS', 'DEFAULT_CAMERA_WATCHDOG_DEPS', 'createAudioWatchdog', 'createCameraWatchdog', 'import'];
    const naming = [...new Set(decls.filter((d) => namesPublisher(d.body)).map((d) => d.name))].sort();
    assert.deepEqual(naming.filter((n) => !PERMITTED.includes(n)), [],
      'a publisher starter is named outside the two older watchdogs and their bindings: if it is a new legitimate caller, add it to PERMITTED here AND check the detector watchdog cannot reach it');
    assert.deepEqual(naming, PERMITTED, 'test bug: the scan no longer sees one of the legitimate callers (the chunking broke?)');

    // 2. Nothing the detector watchdog REACHES, through any chain of top-level names, is one of those. This is
    // what closes the hole a marker-based scan left open: a helper can live anywhere in the file.
    const byName = new Map(decls.filter((d) => d.name !== 'import' && !d.name.startsWith('(')).map((d) => [d.name, d]));
    const reach = new Set(['createDetectorWatchdog']);
    for (const queue = ['createDetectorWatchdog']; queue.length;) {
      for (const id of byName.get(queue.shift()).body.match(/[A-Za-z_$][\w$]*/g) ?? []) {
        if (byName.has(id) && !reach.has(id)) {
          reach.add(id);
          queue.push(id);
        }
      }
    }
    // Test-bug guards: the walk follows references, and crosses the marker (listCameras is declared above it).
    for (const n of ['DEFAULT_DETECTOR_WATCHDOG_DEPS', 'detectorLegHealthy', 'detectorRestartFloorMs', 'darkFor', 'listCameras']) {
      assert.ok(reach.has(n), `test bug: the reachability walk did not reach ${n}`);
    }
    assert.deepEqual([...reach].filter((n) => PERMITTED.includes(n) || namesPublisher(byName.get(n).body)), [],
      'the detector watchdog reaches a declaration that starts a publisher');

    // 3. And its production bindings carry neither.
    for (const name of ['startSubStream', 'startTranscoder']) {
      assert.ok(!(name in wd.DEFAULT_DETECTOR_WATCHDOG_DEPS), `DEFAULT_DETECTOR_WATCHDOG_DEPS carries ${name}`);
    }
  });
});
