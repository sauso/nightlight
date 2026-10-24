// #471: a wake clip being cut kept its ring footage only through its RUN's ring hold (the single RING_OWNER.WAKE
// slot), and wakeWatcher's endRun releases that hold whenever the run ends, captured or not. Every way a run ends
// while its capture is still extracting therefore let the ring janitor delete the very segments the cut was about
// to read: the sleep window closing or the camera being disabled (reset), a quiet gap longer than WAKE_GAP_MIN, the
// 20-minute stale-run sweep, the watcher stopping, and the two clock-step triggers #448 added (an older label ends
// the run; an active label far ahead ends it and the NEW run takes over the single WAKE slot). The capture now
// takes its own lease (ringHolds.wakeCaptureHoldOwner, one key per capture) before it starts, released only by the
// capture's own `.finally`, whatever happened to the run meanwhile.
//
// HOW THIS IS DRIVEN, and why not a stub: recordings.js is in test:core's coverage include list, so it must not be
// mock.module()d (that corrupts coverage for the whole suite), and wakeWatcher calls the real captureWakeClip. So
// everything is real except the processes and the clock: spawn is a FakeFfmpeg (the segmenter stays alive across
// awaits, and each extraction child exits only when the test says), and setTimeout/setInterval are node:test mock
// timers, so the capture's 5 s segment settle and the ring janitor's 2 s prune tick run when the test ticks them.
// Date is NOT mocked: the janitor compares real mtimes with the real clock. The footage is a planted .mkv dated a
// moment after the wake's anchor, like everything else in these labels (about 200 minutes in the past), so only a
// hold reaching back to the clip's cover start keeps it from the janitor.
// ⚠️ The other owners (an on-demand recording and a detection clip) are HOSTILE on purpose: present throughout, and
// shallow (they protect only the last second), so they cannot be what keeps the wake's footage, and a release that
// took them with it would show.
//
// What "the cut fails" means here: the extraction ffmpeg exits non-zero, so captureWakeClip marks the row failed and
// RESOLVES null. A real rejection of captureWakeClip cannot be produced without a stub: its wrapper turns every error
// into null (#309), and the watcher's own `.catch()` before the `.finally` is belt and braces for that.
import { test, mock, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { useTempDataDir, cleanupTempDataDirs, makeChild, makeCamera } from './helpers/harness.js';
import { FakeFfmpeg } from './helpers/fakeFfmpeg.js';

useTempDataDir();
// Mocked before any import that can spawn, and `node:child_process` only (see fakeFfmpeg.js).
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

const { default: db } = await import('../src/db.js');
const { SLEEP_THRESHOLDS } = await import('../src/lib/sleepAnalysis.js');
const { startSegmenter, stopSegmenter, stopAllSegmenters, holdRing, clipCoverStartMs, CLIPS_DIR } =
  await import('../src/lib/clipRecorder.js');
const { holdOwners, effectiveHold, clearHolds, RING_OWNER, ondemandHoldOwner, clipHoldOwner } =
  await import('../src/lib/ringHolds.js');
const { WAKE_CLIP_LEAD_SEC } = await import('../src/lib/recordings.js');
const { handleMinute, stopWakeWatcher, sweepStaleRuns, _state } = await import('../src/lib/wakeWatcher.js');

const { MOTION_ACTIVE, ONSET_QUIET_MIN, WAKE_ACTIVE_MIN, WAKE_GAP_MIN } = SLEEP_THRESHOLDS;

const CHILD = 'child-471';
const CAM = 'cam-471';
const RING_DIR = path.join(CLIPS_DIR, '.ring', CAM);

// The watcher only runs inside a tracked child's sleep window, resolved on the REAL clock in UTC (the app's
// timezone setting is 'UTC' on a fresh database): see wake-watcher.test.js windowAroundNow.
const hhmm = (ms) => {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
};
const setWindow = (fromMs, toMs) =>
  db.prepare('UPDATE children SET sleep_window_start = ?, sleep_window_end = ? WHERE id = ?').run(hhmm(fromMs), hhmm(toMs), CHILD);
const windowAroundNow = () => setWindow(Date.now() - 6 * 3_600_000, Date.now() + 6 * 3_600_000);
const windowExcludingNow = () => setWindow(Date.now() + 7 * 3_600_000, Date.now() + 8 * 3_600_000);

// Minute labels from ONE minute-aligned instant, as wake-watcher.test.js does (#448: the watcher reads the distance
// between labels as elapsed time, so a label built from Date.now() at each call could gain a phantom hole).
const BASE_MS = Math.floor(Date.now() / 60_000) * 60_000;
let clock = 0;
const labelStartMs = (idx) => BASE_MS - (200 - idx) * 60_000;
function labelFor(idx) {
  const t = new Date(labelStartMs(idx));
  const p = (x) => String(x).padStart(2, '0');
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:00`;
}
const minute = (motion) => handleMinute({ cameraId: CAM, bucketStart: labelFor(clock++), motionPeak: motion, soundPeak: 0 });
const quiet = () => minute(0);
const moving = () => minute(MOTION_ACTIVE + 0.05);
const skip = (n) => { clock += n; };
const stateOf = () => _state().get(CAM);

// Hostile owners: see the header. Shallow on purpose (the last second only).
const HOSTILE = [ondemandHoldOwner(990), clipHoldOwner(991)];
// Every owner that is neither the run's WAKE hold nor a hostile one: the capture leases, whatever they are called.
// Not matched on the lease's name, so a lease keyed as RING_OWNER.WAKE (the single slot this exists to avoid) is
// counted as no lease at all.
const leases = () => holdOwners(CAM).filter((o) => o !== RING_OWNER.WAKE && !HOSTILE.includes(o));

const flush = () => new Promise((resolve) => setImmediate(resolve));
async function until(pred, what) {
  for (let i = 0; i < 100; i++) {
    if (pred()) return;
    await flush();
  }
  assert.fail(`never happened: ${what}`);
}

const rowStatus = (id) => db.prepare('SELECT status FROM recordings WHERE id = ?').get(id)?.status;
const wakeRowIds = () => db.prepare("SELECT id FROM recordings WHERE kind = 'wake' ORDER BY id").all().map((r) => r.id);
// The extraction's first ffmpeg (the concat + trim), found by its list file: clipRecorder names it after outBase.
const concatProc = (id) => spawned.find((p) => p.args.includes('concat') && p.args.some((a) => String(a).endsWith(`concat-wake-${id}.txt`)));

function plantSegment(mtimeMs, name) {
  fs.mkdirSync(RING_DIR, { recursive: true });
  const p = path.join(RING_DIR, name);
  fs.writeFileSync(p, 'footage');
  fs.utimesSync(p, mtimeMs / 1000, mtimeMs / 1000);
  return p;
}

function armSegmenter() {
  const camera = db.prepare('SELECT * FROM cameras WHERE id = ?').get(CAM);
  startSegmenter(CAM, camera.mediamtx_path, { preRollSec: 5, postRollSec: 15 });
  holdRing(CAM, HOSTILE[0], Date.now() - 1000);
  holdRing(CAM, HOSTILE[1], Date.now() - 500);
}

// Settle, then WAKE_ACTIVE_MIN active minutes: the 5th one captures. Returns the capture's run, its anchor, its
// recordings row and the planted footage the cut needs.
function wakeThatCaptures(segName = 'seg-1.mkv') {
  for (let i = 0; i < ONSET_QUIET_MIN; i++) quiet();
  assert.equal(stateOf().asleep, true, 'precondition: the watcher armed');
  let fired = null;
  for (let i = 0; i < WAKE_ACTIVE_MIN; i++) fired = moving() || fired;
  assert.ok(fired?.captured, 'precondition: the wake captured');
  const run = stateOf().run;
  assert.equal(run.holding, true, 'precondition: the run held the ring');
  const id = wakeRowIds().at(-1);
  assert.equal(rowStatus(id), 'pending', 'precondition: the capture is in flight');
  // A closed segment 2 s after the anchor: inside the cut's window, and older than the ring's nominal depth, so
  // only a hold reaching back to clipCoverStartMs(anchor) keeps it.
  const seg = plantSegment(fired.startMs + 2000, segName);
  return { run, startMs: fired.startMs, id, seg };
}

// The rest of a SUCCESSFUL extraction after the concat child: the thumbnail, then ffprobe with a real-looking answer.
async function succeed(id) {
  concatProc(id).finish(0);
  const thumb = () => spawned.find((p) => p.args.includes('-frames:v') && p.args.some((a) => String(a).endsWith(`wake-${id}.mp4`)));
  await until(thumb, 'the thumbnail ffmpeg');
  thumb().finish(0);
  const probe = () => spawned.find((p) => p.command === 'ffprobe' && String(p.args.at(-1)).endsWith(`wake-${id}.mp4`));
  await until(probe, 'the ffprobe of the clip');
  probe().stdout.emit('data', Buffer.from(JSON.stringify({ format: { duration: '33.0', size: '4096' }, streams: [] })));
  probe().finish(0);
}

before(() => {
  makeChild(db, { id: CHILD, name: 'A child', track: 1 });
  makeCamera(db, { id: CAM, name: 'Bedroom', childId: CHILD });
  db.prepare("UPDATE settings SET wake_clips_enabled = 1 WHERE id = 'app'").run();
});

after(() => {
  stopWakeWatcher();
  stopAllSegmenters();
  db.close();
  cleanupTempDataDirs();
});

beforeEach(() => {
  // BEFORE the segmenter starts, so its janitor interval is a mocked one, created and cleared under the mock.
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  stopWakeWatcher();
  stopAllSegmenters();
  clearHolds(CAM); // a capture a failed test left pending must not leave its lease to the next test
  _state().clear();
  clock = 0;
  spawned.length = 0;
  db.prepare('DELETE FROM recordings').run();
  fs.rmSync(RING_DIR, { recursive: true, force: true });
  windowAroundNow();
});

afterEach(() => {
  stopWakeWatcher();
  stopAllSegmenters();
  mock.timers.reset();
});

// Each way a run can end while its capture is still extracting. `ended` checks the trigger really happened.
const TRIGGERS = [
  ['the sleep window closes (reset)', () => {
    windowExcludingNow();
    quiet();
    assert.equal(stateOf().run, null);
  }],
  // #589: the window closes while the camera sends nothing, so only the sweep timer can notice. It releases the run's
  // WAKE hold through reset(); the capture's own lease must still protect the footage being cut.
  ['the sleep window closes while the camera is silent (the sweep, #589)', ({ run }) => {
    windowExcludingNow();
    assert.equal(sweepStaleRuns(run.lastActiveMs + 1000), 0, 'not stale: the window close is what ends the run');
    assert.equal(stateOf().run, null);
  }],
  [`a quiet gap longer than ${WAKE_GAP_MIN} minutes (endRun on the bridge)`, () => {
    for (let g = 0; g <= WAKE_GAP_MIN; g++) quiet();
    assert.equal(stateOf().run, null);
  }],
  ['the 20-minute stale-run sweep', ({ run }) => {
    assert.equal(sweepStaleRuns(run.lastActiveMs + 60 * 60_000), 1);
    assert.equal(stateOf().run, null);
  }],
  ['the watcher stops (stopWakeWatcher)', () => {
    stopWakeWatcher();
    assert.equal(_state().size, 0);
  }],
  ['an OLDER label (the clock steps back, #448)', () => {
    clock -= 60;
    quiet();
    assert.equal(stateOf().run, null);
  }],
  ['an active label an hour ahead (#448: a NEW run takes the single WAKE slot)', ({ run }) => {
    skip(60);
    moving();
    assert.notEqual(stateOf().run, run);
    assert.equal(stateOf().run.holding, true, 'precondition: the new run holds the ring under RING_OWNER.WAKE');
  }],
];

describe('#471: a wake clip being cut keeps its ring footage when its run ends', { concurrency: false }, () => {
  for (const [trigger, fire] of TRIGGERS) {
    for (const outcome of ['the cut succeeds', 'the cut fails']) {
      test(`${trigger}; ${outcome}: the capture's lease holds the footage until the cut settles, then goes`, async () => {
        armSegmenter();
        const ctx = wakeThatCaptures();
        const holdFrom = clipCoverStartMs(ctx.startMs, WAKE_CLIP_LEAD_SEC);
        // Control: a janitor tick while the run is still open keeps the footage (the fixture can tell held from not).
        mock.timers.tick(2000);
        assert.equal(fs.existsSync(ctx.seg), true, 'precondition: a held ring keeps the footage through a janitor tick');

        fire(ctx);
        const newRunHolds = stateOf()?.run?.holding === true; // only the jump-ahead trigger starts one

        // The janitor's first tick after the run ended. Before #471 nothing held the clip's footage any more.
        mock.timers.tick(2000);
        assert.equal(fs.existsSync(ctx.seg), true, 'the janitor pruned the footage the clip being cut still needs');
        assert.equal(effectiveHold(CAM), holdFrom, 'the ring is no longer held back to the clip\'s cover start');
        assert.equal(leases().length, 1, `one capture lease expected, owners: ${JSON.stringify(holdOwners(CAM))}`);
        assert.equal(holdOwners(CAM).includes(RING_OWNER.WAKE), newRunHolds, 'the ended run\'s WAKE hold is released as before (a new run holds its own)');

        // The 5 s settle ends (it began at the capture); the extraction reads the ring and starts its ffmpeg.
        // Still pending, still leased.
        mock.timers.tick(1000);
        await until(() => concatProc(ctx.id), 'the extraction ffmpeg (an empty selection means the footage was gone)');
        assert.equal(rowStatus(ctx.id), 'pending');
        assert.equal(leases().length, 1, 'the lease was released while the clip was still being cut');

        if (outcome === 'the cut succeeds') await succeed(ctx.id);
        else concatProc(ctx.id).finish(1);
        await until(() => rowStatus(ctx.id) !== 'pending', 'the capture to settle');
        await flush();

        assert.equal(rowStatus(ctx.id), outcome === 'the cut succeeds' ? 'ready' : 'failed');
        assert.deepEqual(leases(), [], 'the lease outlived its capture (a leak: the ring would grow until the segmenter restarts)');
        assert.deepEqual(holdOwners(CAM).filter((o) => HOSTILE.includes(o)), HOSTILE, 'another owner\'s hold was released with the lease');
        assert.equal(holdOwners(CAM).includes(RING_OWNER.WAKE), newRunHolds, 'the old capture\'s settle touched the NEW run\'s WAKE hold');
      });
    }
  }

  // #773: before runFfmpeg had a deadline, a cut whose ffmpeg never exited kept its capture pending, and so this
  // lease, forever (the ring then grows until a restart). The lease is released by the capture's own `.finally`
  // (wakeWatcher.js), so it is enough that the capture now SETTLES. 120 s is the stall window for a child that has
  // reported nothing (clipRecorder.STALL_WINDOW_BASE_MS); written out so a change to it has to be made here too.
  test('#773: a cut whose ffmpeg never exits nor reports progress is given up on after the stall window; the row fails and the lease goes', async () => {
    armSegmenter();
    const ctx = wakeThatCaptures();
    mock.timers.tick(5000); // the capture's 5 s segment settle
    await until(() => concatProc(ctx.id), 'the extraction ffmpeg');
    assert.equal(leases().length, 1, 'precondition: the capture holds its lease');
    mock.timers.tick(119_000);
    await flush();
    assert.equal(rowStatus(ctx.id), 'pending', 'given up on before the stall window ran out');
    assert.equal(leases().length, 1);
    mock.timers.tick(1_000);
    await until(() => rowStatus(ctx.id) !== 'pending', 'the stalled cut to be given up on');
    await flush();
    assert.equal(rowStatus(ctx.id), 'failed');
    assert.deepEqual(concatProc(ctx.id).signals, ['SIGKILL']);
    assert.deepEqual(leases(), [], 'the given-up cut still holds its lease');
    assert.deepEqual(holdOwners(CAM).filter((o) => HOSTILE.includes(o)), HOSTILE, 'another owner\'s hold was released with the lease');
  });

  test('two captures in flight on one camera keep two independent leases; each release frees only its own', async () => {
    armSegmenter();
    const first = wakeThatCaptures('seg-1.mkv');
    // An active label an hour ahead ends the first run and starts a second, which captures in its turn.
    skip(60);
    let fired = null;
    for (let i = 0; i < WAKE_ACTIVE_MIN; i++) fired = moving() || fired;
    assert.ok(fired?.captured, 'precondition: the second wake captured');
    const secondRun = stateOf().run;
    const secondId = wakeRowIds().at(-1);
    assert.notEqual(secondId, first.id);
    const secondSeg = plantSegment(fired.startMs + 2000, 'seg-2.mkv');
    assert.equal(leases().length, 2, `two leases expected, owners: ${JSON.stringify(holdOwners(CAM))}`);

    mock.timers.tick(5000);
    await until(() => concatProc(first.id) && concatProc(secondId), 'both extractions');
    assert.equal(fs.existsSync(first.seg), true, 'the first clip\'s footage was pruned once the second run took the WAKE slot');
    assert.equal(fs.existsSync(secondSeg), true);

    // The SECOND settles first: its lease and (its run is current) its run's WAKE hold go; the first lease stays.
    await succeed(secondId);
    await until(() => rowStatus(secondId) === 'ready', 'the second capture to settle');
    await flush();
    // Exactly one: none would mean the second release took the first lease too, two that it released nothing.
    assert.equal(leases().length, 1, `only the first capture's lease should remain, owners: ${JSON.stringify(holdOwners(CAM))}`);
    assert.equal(secondRun.holding, false);
    assert.equal(holdOwners(CAM).includes(RING_OWNER.WAKE), false);
    assert.equal(effectiveHold(CAM), clipCoverStartMs(first.startMs, WAKE_CLIP_LEAD_SEC), 'the first clip lost its hold point');
    mock.timers.tick(2000);
    assert.equal(fs.existsSync(first.seg), true, 'the first clip\'s footage was pruned after the second capture settled');

    concatProc(first.id).finish(1);
    await until(() => rowStatus(first.id) === 'failed', 'the first capture to settle');
    await flush();
    assert.deepEqual(leases(), []);
    assert.deepEqual(holdOwners(CAM), HOSTILE, 'only the hostile owners remain, untouched');
  });

  test('no segmenter by the time the wake qualifies: no lease, nothing thrown, nothing left behind', async () => {
    armSegmenter();
    for (let i = 0; i < ONSET_QUIET_MIN; i++) quiet();
    moving();
    assert.equal(stateOf().run.holding, true, 'precondition: the run took its WAKE hold while the ring ran');
    // The ring is torn down mid-run (an admin turns recording off, the camera's legs stop): clearHolds takes every
    // owner with it, and `run.holding` is now stale. holdRing returns false for the lease.
    stopSegmenter(CAM);
    assert.deepEqual(holdOwners(CAM), []);
    let fired = null;
    for (let i = 1; i < WAKE_ACTIVE_MIN; i++) fired = moving() || fired;
    assert.ok(fired?.captured, 'precondition: the wake still qualifies and attempts its capture');
    assert.deepEqual(holdOwners(CAM), [], 'a lease was recorded for a ring that is not running');

    await flush();
    await flush();
    assert.deepEqual(holdOwners(CAM), []);
    assert.deepEqual(wakeRowIds(), [], 'captureWakeClip should have skipped: no segmenter');
    assert.equal(stateOf().run.holding, false, 'the capture\'s settle should have cleared the stale holding flag');
  });
});
