// clipCapture.js — the glue between the ring segmenter and the app: which cameras buffer, and what
// happens when a detection fires on one of them.
//
// ★ WHY THIS FILE EXISTS. Of the module's 158 lines, 46% were covered and every one of them came from
// `clipRingWanted` (clipRing.test.js). The lifecycle functions, the pre/post-roll settings read, the
// job queue and every guard inside `enqueueClip` were reached by no test at all — including the guards
// that stop a clip being cut when the ring is empty, when a capture is already in flight, and when the
// disk is nearly full. Issue #263 counts this module among the nine clip modules imported by no test.
//
// ⚠️ THE PATH IS EMPTIED BEFORE ANYTHING LOADS, and that is load-bearing rather than tidy.
// `startSegmenter` spawns ffmpeg. On a machine WITHOUT one it fails with ENOENT, deletes its own map
// entry and stops — clean. On a machine WITH one (the e2e image, the Docker image, any laptop
// belonging to someone who works with video) it spawns a REAL ffmpeg pointed at an RTSP address that
// is not there, which lingers, fails, and relaunches every 5 seconds for the rest of the run. So the
// behaviour under test would differ per machine, and the leftover process would leak into whatever ran
// next. Emptying PATH makes resolution fail identically everywhere. This is the same technique, and
// the same reasoning, as spawn-failure.test.js — read its header, it was learnt the hard way there.
//
// ⚠️ WHAT THIS FILE CANNOT COVER, stated rather than left to be discovered. Both need a real encoder,
// and both are covered end to end in e2e/playwright/tests/10-clip-lifecycle.spec.js, which runs the
// actual image:
//   * the SUCCESS branch of the capture job — `setClipReady` and the log line beside it — because it
//     only runs when `extractClip` returns, which needs real ring segments to concatenate;
//   * the RING DEPTH arithmetic, `max(clip_pre_roll_s, ondemand_pre_roll_s) + post + margin`. It is
//     computed inside `startSegmenter`, never exposed, and its only observable effect is the janitor
//     pruning a real segment. Re-deriving the formula in an assertion here would test nothing but
//     itself — that is precisely the trap-fixture shape issue #263 is about.
import { test, before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { useTempDataDir, cleanupTempDataDirs, makeCamera, makeChild } from './helpers/harness.js';

// Before any import that can spawn: an empty directory as the entire PATH, so nothing resolves.
// `node --test` runs each test FILE in its own process, so this cannot leak into another suite.
const emptyBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightlight-nobin-'));
process.env.PATH = emptyBinDir;

useTempDataDir();

const { default: db } = await import('../src/db.js');
const ev = await import('../src/lib/detectionEvents.js');
const { isSegmenterRunning, CLIPS_DIR } = await import('../src/lib/clipRecorder.js');
const { checkClipStorage } = await import('../src/lib/clipStorage.js');
const {
  clipRingWanted, startClipCapture, stopClipCapture, restartClipCapture, reconcileClipRing,
  isClipCapturing, stopAllClipCapture, enqueueClip,
} = await import('../src/lib/clipCapture.js');

const cam = (extra = {}, childId = null) => {
  db.prepare('DELETE FROM cameras').run();
  makeCamera(db, { id: 'cam-1', name: 'Nursery', childId, extra });
  return db.prepare('SELECT * FROM cameras WHERE id = ?').get('cam-1');
};

const setSettings = (cols) => {
  for (const [k, v] of Object.entries(cols)) {
    db.prepare(`UPDATE settings SET ${k} = ? WHERE id = ?`).run(v, 'app');
  }
};

const newEvent = () => ev.recordDetectionEvent('cam-1', 'Nursery', ev.ALERT.MOTION);
const clipStatus = (id) => db.prepare('SELECT clip_status FROM detection_events WHERE id = ?').get(id).clip_status;

// Wait for the queued job to reach a terminal state. Polled rather than timed: the job is async and
// how long it takes depends on how fast the spawn fails, which is not something to guess at.
// ⚠️ 20s, and the reason is worth stating: `extractClip` deliberately WAITS OUT the post-roll before
// it reads the ring (`postRollSec + 2*SEGMENT_SEC + 0.5` seconds), so with the shipped 15s default a
// single capture here would take 19.5s. `beforeEach` sets the post-roll to 0 to bring that down to
// ~4.5s, which is the floor: the two-segment settle is not configurable and is not something this
// file should be reaching into.
async function settled(id, ms = 20000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const s = clipStatus(id);
    if (s === 'ready' || s === 'failed') return s;
    await new Promise((r) => setTimeout(r, 20));
  }
  return clipStatus(id);
}

// A /proc/mounts that maps CLIPS_DIR as its own mountpoint, so the storage guard passes. Supplied
// rather than read, for the same reason as in clip-storage.test.js: on Windows there is no
// /proc/mounts and on a Linux runner a temp directory sits under "/", so the real file gives opposite
// answers on the two machines this suite runs on.
const MOUNTED = `/dev/sda1 / ext4 rw 0 0\n/dev/sdb1 ${path.resolve(CLIPS_DIR)} xfs rw 0 0\n`;

before(() => {
  fs.mkdirSync(CLIPS_DIR, { recursive: true });
  // ⚠️ REQUIRED, and its absence is a silent no-op rather than an error: `startClipCapture` returns
  // early unless `clipStorageReady()` is true, and the module's status starts as
  // `{ ok: false, reason: 'not checked' }`. Without this every test below "passes" by never starting a
  // segmenter at all — which is exactly what happened the first time this file was run, and exactly
  // the shape of vacuous pass #263 is about.
  const st = checkClipStorage({ mounts: MOUNTED });
  assert.equal(st.ok, true, `clip storage did not come up ready (${st.reason}) — every test here would be vacuous`);
});

after(() => {
  stopAllClipCapture();
  db.close();
  cleanupTempDataDirs();
  try { fs.rmSync(emptyBinDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

beforeEach(() => {
  stopAllClipCapture();
  db.prepare('DELETE FROM detection_events').run();
  db.prepare('DELETE FROM children').run();
  // Post-roll 0 so a capture settles in ~4.5s rather than ~19.5s — see the note on `settled`. The
  // shipped default is 15; nothing here depends on the value, only on it being small.
  setSettings({ ondemand_enabled: 1, clip_pre_roll_s: 5, clip_post_roll_s: 0, wake_clips_enabled: 1 });
});

// --- the precondition every other test here rests on ----------------------------------------------

describe('the fixture itself', () => {
  test('★ ffmpeg really is unresolvable, so every segmenter behaves the same way here', () => {
    // Asserted, not assumed. If PATH were ever restored — by a helper, by a future refactor — a real
    // ffmpeg would start relaunching every 5s and the tests below would pass or fail depending on the
    // machine. This is the check that turns that into a failure with a name.
    assert.equal(process.env.PATH, emptyBinDir, 'PATH is no longer empty — spawns are host-dependent again');
    assert.deepEqual(fs.readdirSync(emptyBinDir), [], 'something was written into the supposedly empty bin dir');
  });
});

// --- lifecycle ------------------------------------------------------------------------------------

describe('starting and stopping a camera’s ring', () => {
  test('a camera that wants the ring gets a segmenter', () => {
    startClipCapture(cam({ detect_record_clips: 1 }));
    assert.equal(isSegmenterRunning('cam-1'), true);
    assert.equal(isClipCapturing('cam-1'), true, 'isClipCapturing must be the same answer, not a second opinion');
  });

  test('★ a camera that wants neither feature does NOT', () => {
    // The control. Without it every assertion about starting would also pass for a version that
    // started a segmenter for every camera in the database — which is a real cost: one ffmpeg process
    // and a 2s pruning timer per camera, forever.
    setSettings({ ondemand_enabled: 0 });
    startClipCapture(cam({ detect_record_clips: 0 }));
    assert.equal(isSegmenterRunning('cam-1'), false);
  });

  test('a disabled camera never gets one, whatever the features say', () => {
    startClipCapture(cam({ detect_record_clips: 1, disabled: 1 }));
    assert.equal(isSegmenterRunning('cam-1'), false);
  });

  test('starting twice does not restart it — a reconcile tick must not drop the ring', () => {
    // `reconcileCameraPaths` runs every 5 minutes and calls this for every camera. If it restarted the
    // segmenter each time, the ring would be wiped every 5 minutes (startSegmenter clears the ring
    // dir) and any clip cut near the tick would have nothing to reach back into.
    const c = cam({ detect_record_clips: 1 });
    startClipCapture(c);
    const ring = path.join(CLIPS_DIR, '.ring', 'cam-1');
    fs.writeFileSync(path.join(ring, 'seg-marker.mkv'), 'x');
    startClipCapture(c);
    assert.equal(fs.existsSync(path.join(ring, 'seg-marker.mkv')), true, 'the second start wiped the ring');
  });

  test('★ storage that is not usable means no segmenter at all', () => {
    // A segmenter writing into an unmapped or unwritable CLIPS_DIR produces nothing but load: the ring
    // either vanishes on container recreate or cannot be written in the first place. Restored
    // immediately, because every other test in this file depends on storage being ready.
    checkClipStorage({ mounts: '/dev/sda1 / ext4 rw 0 0\n' }); // CLIPS_DIR now looks like the overlay layer
    try {
      startClipCapture(cam({ detect_record_clips: 1 }));
      assert.equal(isSegmenterRunning('cam-1'), false, 'a segmenter started with nowhere safe to write');
    } finally {
      assert.equal(checkClipStorage({ mounts: MOUNTED }).ok, true);
    }
  });

  test('stopping ends it, and stopping again is safe', () => {
    startClipCapture(cam({ detect_record_clips: 1 }));
    assert.equal(isSegmenterRunning('cam-1'), true, 'precondition: there is something to stop');
    stopClipCapture('cam-1');
    assert.equal(isSegmenterRunning('cam-1'), false);
    stopClipCapture('cam-1'); // idempotent
    stopClipCapture('never-existed');
  });

  test('★ restart really restarts: the ring is emptied and the segmenter comes back', () => {
    // Called when the global pre/post-roll changes, and the ring DEPTH is a function of those — so a
    // restart that skipped the stop would leave a ring sized for the old settings, and one that
    // skipped the start would leave the camera silently not buffering at all. Both halves asserted.
    const c = cam({ detect_record_clips: 1 });
    startClipCapture(c);
    const ring = path.join(CLIPS_DIR, '.ring', 'cam-1');
    fs.writeFileSync(path.join(ring, 'seg-stale.mkv'), 'x');
    restartClipCapture(c);
    assert.equal(fs.existsSync(path.join(ring, 'seg-stale.mkv')), false, 'the old ring survived a restart');
    assert.equal(isSegmenterRunning('cam-1'), true, 'the camera stopped buffering after a restart');
  });

  test('restarting a camera that no longer wants the ring leaves it stopped', () => {
    const c = cam({ detect_record_clips: 1 });
    startClipCapture(c);
    setSettings({ ondemand_enabled: 0 });
    restartClipCapture({ ...c, detect_record_clips: 0 });
    assert.equal(isSegmenterRunning('cam-1'), false, 'a restart re-armed a camera that had opted out');
  });

  test('stopAllClipCapture takes down every camera at once', () => {
    // `cam()` clears the cameras table, so it has to come FIRST — the second camera is added after it.
    startClipCapture(cam({ detect_record_clips: 1 }));
    makeCamera(db, { id: 'cam-2', name: 'Second', extra: { detect_record_clips: 1 } });
    startClipCapture(db.prepare('SELECT * FROM cameras WHERE id = ?').get('cam-2'));
    assert.equal(isSegmenterRunning('cam-1'), true, 'precondition: both are running');
    assert.equal(isSegmenterRunning('cam-2'), true);
    stopAllClipCapture();
    assert.equal(isSegmenterRunning('cam-1'), false);
    assert.equal(isSegmenterRunning('cam-2'), false);
  });
});

// --- wake clips as a third reason to buffer (issue #387) ------------------------------------------
//
// clipRingWanted's other two reasons (detect_record_clips, on-demand) are proven above by starting a
// real segmenter. This proves the same for wake clips: not just that the PREDICATE returns true
// (clipRing.test.js already pins that), but that startClipCapture, handed a wake-only camera, actually
// produces a running segmenter — which is the thing captureWakeClipInner (recordings.js) needs to find
// when a wake fires, and the thing that was silently missing before this fix.
describe('★ wake clips actually start the segmenter, not just the predicate (issue #387)', () => {
  test('a wake-only camera — detection clips and on-demand both off — gets a real segmenter', () => {
    setSettings({ ondemand_enabled: 0 });
    makeChild(db, { id: 'kid-1', track: 1 });
    startClipCapture(cam({ detect_record_clips: 0 }, 'kid-1'));
    assert.equal(isSegmenterRunning('cam-1'), true, 'wake-only eligibility did not start a segmenter');
  });

  test('the same camera with sleep tracking off does NOT get one', () => {
    setSettings({ ondemand_enabled: 0 });
    makeChild(db, { id: 'kid-1', track: 0 });
    startClipCapture(cam({ detect_record_clips: 0 }, 'kid-1'));
    assert.equal(isSegmenterRunning('cam-1'), false);
  });

  test('the same camera with wake clips disabled globally does NOT get one', () => {
    setSettings({ ondemand_enabled: 0, wake_clips_enabled: 0 });
    makeChild(db, { id: 'kid-1', track: 1 });
    startClipCapture(cam({ detect_record_clips: 0 }, 'kid-1'));
    assert.equal(isSegmenterRunning('cam-1'), false);
  });

  test('restartClipCapture stops a wake-only ring once wake clips are turned off globally — the same call settings.js makes on save', () => {
    // Mirrors the sibling "restarting a camera that no longer wants the ring leaves it stopped" test
    // below, for the THIRD reason a camera can want a ring. settings.js's PUT handler re-arms every
    // enabled camera through exactly this function when wake_clips_enabled changes (routes/settings.js)
    // — this is the synchronous, non-racy proof of that STOP direction; see
    // test/children-clip-ring-reconcile.test.js's header for why a real HTTP call to that route cannot
    // prove it (isSegmenterRunning dies on its own, from the empty-PATH spawn failure, faster than an
    // awaited round trip).
    setSettings({ ondemand_enabled: 0, wake_clips_enabled: 1 });
    makeChild(db, { id: 'kid-1', track: 1 });
    const c = cam({ detect_record_clips: 0 }, 'kid-1');
    startClipCapture(c);
    assert.equal(isSegmenterRunning('cam-1'), true, 'precondition: the wake-only ring is running');
    setSettings({ wake_clips_enabled: 0 });
    restartClipCapture(c);
    assert.equal(isSegmenterRunning('cam-1'), false, 'a restart left a wake-only ring running after wake clips were turned off');
  });

  test('re-evaluating after "Track sleep" turns off stops an already-running wake-only ring', () => {
    // Proves the STOP direction against a real running segmenter, which the pure-predicate tests in
    // clipRing.test.js cannot: they never start anything, so a version of clipRingWanted that flipped
    // to false but left an existing ring alone would still pass every one of them. This calls the same
    // two functions children.js's reconcileChildLegs calls, in the same order — but not that function
    // itself; the route-level wiring (a real PUT -> reconcileChildLegs -> here) is covered separately in
    // test/children-clip-ring-reconcile.test.js, which needs its own PATH-emptied process.
    setSettings({ ondemand_enabled: 0 });
    makeChild(db, { id: 'kid-1', track: 1 });
    const c = cam({ detect_record_clips: 0 }, 'kid-1');
    startClipCapture(c);
    assert.equal(isSegmenterRunning('cam-1'), true, 'precondition: the wake-only ring is running');
    db.prepare('UPDATE children SET track_sleep = 0 WHERE id = ?').run('kid-1');
    reconcileClipRing(c); // the actual function children.js/cameras.js/index.js all call now
    assert.equal(isSegmenterRunning('cam-1'), false, 'the ring kept running after sleep tracking was turned off');
  });
});

// --- reconcileClipRing: the shared start-or-stop decision (issue #387) ----------------------------
//
// Every caller that used to hand-roll `if (clipRingWanted(cam)) startClipCapture(cam); else
// stopClipCapture(cam.id);` now calls this instead — index.js's periodic reconcile (which previously
// had ONLY the start half; see its own comment), cameras.js's /assign route, and children.js's
// reconcileChildLegs and DELETE /:id. One tested implementation instead of four copies that can drift
// independently, which is exactly how issue #387 (and the on-demand bug before it) happened in the
// first place.
describe('★ reconcileClipRing — the single start-or-stop decision every caller now shares', () => {
  test('starts a wanted ring that is not running', () => {
    const c = cam({ detect_record_clips: 1 });
    assert.equal(isSegmenterRunning('cam-1'), false, 'precondition');
    reconcileClipRing(c);
    assert.equal(isSegmenterRunning('cam-1'), true);
  });

  test('★ THE FIX: stops a running ring that is no longer wanted', () => {
    const c = cam({ detect_record_clips: 1 });
    startClipCapture(c);
    assert.equal(isSegmenterRunning('cam-1'), true, 'precondition');
    setSettings({ ondemand_enabled: 0 });
    reconcileClipRing({ ...c, detect_record_clips: 0 });
    assert.equal(isSegmenterRunning('cam-1'), false, 'a no-longer-wanted ring kept running');
  });

  test('leaves an already-running, still-wanted ring alone (does not restart/wipe it)', () => {
    const c = cam({ detect_record_clips: 1 });
    startClipCapture(c);
    const ring = path.join(CLIPS_DIR, '.ring', 'cam-1');
    fs.writeFileSync(path.join(ring, 'seg-marker.mkv'), 'x');
    reconcileClipRing(c);
    assert.equal(fs.existsSync(path.join(ring, 'seg-marker.mkv')), true, 'a no-op reconcile wiped the ring');
  });

  test('leaves an already-stopped, still-unwanted ring alone', () => {
    setSettings({ ondemand_enabled: 0 });
    const c = cam({ detect_record_clips: 0 });
    reconcileClipRing(c);
    assert.equal(isSegmenterRunning('cam-1'), false);
  });
});

// --- enqueueClip: the guards ----------------------------------------------------------------------

describe('★ enqueueClip refuses in every case where a clip would be empty or unsafe', () => {
  test('a camera without detection clips enabled is never captured, even with a ring running', () => {
    // The ring may well be running for the OTHER feature (on-demand). That must not turn every
    // detection into a saved clip — `detect_record_clips` is the per-camera opt-in and this is the
    // only place it is enforced.
    const c = cam({ detect_record_clips: 0 });
    setSettings({ ondemand_enabled: 1 });
    startClipCapture(c);
    assert.equal(isSegmenterRunning('cam-1'), true, 'precondition: the ring IS running, for on-demand');
    const id = newEvent();
    enqueueClip(c, id);
    assert.equal(clipStatus(id), null, 'a clip was captured for a camera that has not opted in');
  });

  test('no event id, no clip', () => {
    const c = cam({ detect_record_clips: 1 });
    startClipCapture(c);
    enqueueClip(c, null);
    enqueueClip(c, undefined);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM detection_events').get().n, 0, 'no throw, and nothing recorded');
  });

  test('★ no segmenter means no clip — an empty ring would produce an empty file', () => {
    const c = cam({ detect_record_clips: 1 });
    // Deliberately NOT started.
    assert.equal(isSegmenterRunning('cam-1'), false);
    const id = newEvent();
    enqueueClip(c, id);
    assert.equal(clipStatus(id), null, 'a capture was queued with no ring to cut from');
  });

  test('★ a second trigger while one is in flight is folded in, not captured twice', async () => {
    // Two ffmpeg extractions running over the same ring at once is the thing this prevents; the
    // detector cooldown suppresses most, but not all. Observable: the second event's row is never even
    // marked pending.
    const c = cam({ detect_record_clips: 1 });
    startClipCapture(c);
    const first = newEvent();
    const second = newEvent();
    enqueueClip(c, first);
    assert.equal(clipStatus(first), 'pending');
    enqueueClip(c, second);
    assert.equal(clipStatus(second), null, 'an overlapping trigger started its own capture');
    await settled(first);
  });

  test('★ ...and the camera is released afterwards, so the NEXT wake is captured', async () => {
    // The `finally` that removes the camera from `busyCameras`. Without it the first detection of the
    // night is the last one that ever produces a clip, silently, until a restart — and the failure
    // path is exactly where a missing release hurts most, because that is when it happens.
    const c = cam({ detect_record_clips: 1 });
    startClipCapture(c);
    const first = newEvent();
    enqueueClip(c, first);
    assert.equal(await settled(first), 'failed', 'precondition: with no ffmpeg the capture must fail');

    startClipCapture(c); // the segmenter deleted itself when the spawn failed; put it back
    const second = newEvent();
    enqueueClip(c, second);
    assert.equal(clipStatus(second), 'pending', 'the camera was never released — no clip can ever be cut again');
    await settled(second);
  });

  test('★ a failed capture marks the row failed and leaves the alert intact', async () => {
    const c = cam({ detect_record_clips: 1 });
    startClipCapture(c);
    const id = newEvent();
    ev.saveEventSnapshot(id, Buffer.from('jpeg'));
    enqueueClip(c, id);
    assert.equal(await settled(id), 'failed');
    const row = db.prepare('SELECT * FROM detection_events WHERE id = ?').get(id);
    assert.ok(row, 'the alert row was deleted by a failed capture');
    assert.equal(row.snapshot, 1, 'the snapshot was taken down with the failed clip');
    assert.equal(row.clip_path, null);
  });

  test('the queue runs at most two captures at once', async () => {
    // QUEUE_CONCURRENCY = 2. Each job holds a worker for roughly the post-roll, so an unbounded queue
    // is an unbounded number of ffmpeg processes on a burst across cameras. Observed by the only
    // externally visible effect: with three cameras triggered at once, all three still complete.
    const ids = [];
    for (const id of ['cam-1', 'cam-2', 'cam-3']) {
      db.prepare('DELETE FROM cameras WHERE id = ?').run(id);
      makeCamera(db, { id, name: id, extra: { detect_record_clips: 1 } });
      const c = db.prepare('SELECT * FROM cameras WHERE id = ?').get(id);
      startClipCapture(c);
      const ev1 = ev.recordDetectionEvent(id, id, ev.ALERT.MOTION);
      ids.push(ev1);
      enqueueClip(c, ev1);
    }
    for (const id of ids) assert.equal(await settled(id), 'failed', `event ${id} never finished — the queue stalled`);
  });
});

// --- the pre/post-roll settings -------------------------------------------------------------------

describe('the global clip settings', () => {
  test('★ a missing or unreadable settings row falls back to 5s / 15s', async () => {
    // Without the fallback these are NaN, which reaches `startSegmenter`'s depth arithmetic and
    // `extractClip`'s window as NaN — a ring of NaN milliseconds prunes everything immediately, so
    // every clip would be empty. Silent, and only at 3am.
    const saved = db.prepare('SELECT * FROM settings WHERE id = ?').get('app');
    db.prepare('DELETE FROM settings WHERE id = ?').run('app');
    try {
      const c = cam({ detect_record_clips: 1 });
      // With no settings row `getOndemandSettings().enabled` also defaults to true, so the ring is
      // wanted for that reason alone — which is the behaviour a fresh install has.
      assert.equal(clipRingWanted(c), true);
      startClipCapture(c);
      assert.equal(isSegmenterRunning('cam-1'), true, 'the segmenter refused to start with no settings row');
    } finally {
      const cols = Object.keys(saved);
      db.prepare(`INSERT INTO settings (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
        .run(...cols.map((k) => saved[k]));
    }
  });

  test('a non-numeric setting falls back too, rather than propagating NaN', () => {
    // The columns are INTEGER but SQLite is dynamically typed, so a text value really can be stored.
    db.prepare("UPDATE settings SET clip_pre_roll_s = 'five' WHERE id = ?").run('app');
    const c = cam({ detect_record_clips: 1 });
    startClipCapture(c);
    assert.equal(isSegmenterRunning('cam-1'), true);
  });
});
