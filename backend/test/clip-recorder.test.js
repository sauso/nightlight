// clipRecorder.js — the ring: a continuous segmenter per camera, a janitor that prunes it, and the
// extraction that cuts a clip out of it.
//
// ★ WHAT THIS COVERS AND WHAT IT DELIBERATELY DOES NOT. Everything here runs with ffmpeg unresolvable
// (see the PATH note below), so it covers the parts that are *not* encoding: the path guards, the ring
// bookkeeping, the pruning arithmetic, the hold interaction, and every way extraction refuses before
// it would spawn anything. The encode itself — concat, trim, faststart, AAC — is e2e's job, because
// asserting it needs a real encoder and a real stream, and asserting it against a fake would be
// asserting the fake.
//
// ⚠️ PATH IS EMPTIED BEFORE ANY IMPORT. Same reason as clip-capture.test.js: with a real ffmpeg
// present, `startSegmenter` spawns one against an RTSP address that is not there, which lingers and
// relaunches every 5 seconds for the rest of the run — so the tests would behave differently on a
// machine that has ffmpeg (the Docker image, the e2e stack, any video person's laptop) than on one
// that does not. spawn-failure.test.js learnt this the hard way; its header is worth reading.
import { test, before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { useTempDataDir, cleanupTempDataDirs } from './helpers/harness.js';

const emptyBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightlight-nobin-'));
process.env.PATH = emptyBinDir;

useTempDataDir();

const { default: db } = await import('../src/db.js');
const {
  CLIPS_DIR, startSegmenter, stopSegmenter, stopAllSegmenters, isSegmenterRunning,
  holdRing, releaseRing, extractClip, probeClip, ringOldestStartMs, ringHasFootageFor,
} = await import('../src/lib/clipRecorder.js');
const { RING_OWNER, effectiveHold, holdOwners, clearHolds } = await import('../src/lib/ringHolds.js');

const CAM = 'cam-1';
const ringDir = (id = CAM) => path.join(path.resolve(CLIPS_DIR), '.ring', id);

// The ring depth startSegmenter computes: (pre + post + 4*SEGMENT_SEC + 10) seconds, SEGMENT_SEC = 2.
// Restated here only to build fixtures either side of it; nothing asserts the formula, which would be
// re-implementing the code under test rather than checking it.
const DEPTH_MS = (5 + 15 + 8 + 10) * 1000;

// A ring segment with a chosen age. mtime is what selection and pruning both use — the filename is
// only for humans.
function segment(name, ageMs, id = CAM) {
  const dir = ringDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, 'segment');
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(p, t, t);
  return p;
}

const ringFiles = (id = CAM) => (fs.existsSync(ringDir(id)) ? fs.readdirSync(ringDir(id)).sort() : []);

before(() => { fs.mkdirSync(path.resolve(CLIPS_DIR), { recursive: true }); });

after(() => {
  stopAllSegmenters();
  db.close();
  cleanupTempDataDirs();
  try { fs.rmSync(emptyBinDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

beforeEach(() => {
  stopAllSegmenters();
  clearHolds(CAM);
  fs.rmSync(path.join(path.resolve(CLIPS_DIR), '.ring'), { recursive: true, force: true });
});

// --- the path guards ------------------------------------------------------------------------------

describe('★ camera ids and clip basenames become PATH SEGMENTS, and are validated as such', () => {
  // Both values are server-generated today (a camera UUID, an integer event id), so nothing malicious
  // reaches them. The guard is insurance against a future caller that passes something unchecked —
  // and insurance nothing exercises is indistinguishable from no insurance.
  const bad = ['..', '.', 'a/b', 'a\\b', '', 'x y', 'a/../../etc'];

  test('an unsafe camera id is refused rather than made into a directory', () => {
    for (const id of bad) {
      assert.throws(() => startSegmenter(id, 'somepath'), /unsafe cameraId/, `startSegmenter accepted ${JSON.stringify(id)}`);
    }
    // ...and nothing was created outside the ring root on the way to refusing.
    assert.equal(fs.existsSync(path.join(path.resolve(CLIPS_DIR), 'b')), false);
  });

  test('a safe id IS accepted — the control', () => {
    startSegmenter('cam_1-A.b', 'somepath');
    assert.equal(isSegmenterRunning('cam_1-A.b'), true);
    stopSegmenter('cam_1-A.b');
  });

  test('★ an unsafe clip basename is refused by extractClip', async () => {
    startSegmenter(CAM, 'somepath');
    segment('seg-a.mkv', 4000);
    segment('seg-b.mkv', 2000);
    await assert.rejects(
      () => extractClip(CAM, { at: Date.now() - 3000, outBase: '../escape', settleMs: 0 }),
      /unsafe outBase/
    );
  });
});

// --- ring bookkeeping ------------------------------------------------------------------------------

describe('starting and stopping the ring', () => {
  test('the ring directory is created, and a stale ring is cleared first', () => {
    // startSegmenter is also the restart path. A segment left from a previous run has a wall-clock
    // mtime from before the gap and would be silently concatenated into the next clip.
    segment('seg-stale.mkv', 60_000);
    fs.writeFileSync(path.join(ringDir(), 'concat-old.txt'), 'stale list');
    fs.writeFileSync(path.join(ringDir(), 'keep-me.txt'), 'not a segment');

    startSegmenter(CAM, 'somepath');
    assert.deepEqual(ringFiles(), ['keep-me.txt'], 'the stale ring was not cleared (or too much was)');
  });

  test('isSegmenterRunning flips both ways', () => {
    assert.equal(isSegmenterRunning(CAM), false);
    startSegmenter(CAM, 'somepath');
    assert.equal(isSegmenterRunning(CAM), true);
    stopSegmenter(CAM);
    assert.equal(isSegmenterRunning(CAM), false);
  });

  test('stopping one that was never started is safe', () => {
    stopSegmenter('never-existed');
    assert.equal(isSegmenterRunning('never-existed'), false);
  });

  test('stopAllSegmenters takes down every camera', () => {
    startSegmenter(CAM, 'a');
    startSegmenter('cam-2', 'b');
    stopAllSegmenters();
    assert.equal(isSegmenterRunning(CAM), false);
    assert.equal(isSegmenterRunning('cam-2'), false);
  });
});

// --- holds -----------------------------------------------------------------------------------------

describe('holding the ring open', () => {
  test('★ a hold is refused when there is no ring to hold', () => {
    // The caller uses this answer to decide whether to start a recording at all: returning true here
    // would let an on-demand Record write a row and only discover ~20s later that it has nothing to
    // cut. Asserted alongside the registry, so "returned false" and "recorded a hold anyway" are told
    // apart.
    assert.equal(holdRing(CAM, RING_OWNER.ONDEMAND, Date.now()), false);
    assert.deepEqual(holdOwners(CAM), []);
  });

  test('a hold is accepted while one is running, and released on request', () => {
    startSegmenter(CAM, 'somepath');
    const from = Date.now() - 30_000;
    assert.equal(holdRing(CAM, RING_OWNER.WAKE, from), true);
    assert.equal(effectiveHold(CAM), from);
    releaseRing(CAM, RING_OWNER.WAKE);
    assert.equal(effectiveHold(CAM), null);
  });

  test('★ stopping the segmenter drops every hold on it', () => {
    // The ring is about to be deleted, so a surviving hold would silently apply to the NEXT one —
    // protecting segments from a different recording and letting it grow without bound.
    startSegmenter(CAM, 'somepath');
    holdRing(CAM, RING_OWNER.WAKE, Date.now() - 30_000);
    holdRing(CAM, RING_OWNER.ONDEMAND, Date.now() - 10_000);
    stopSegmenter(CAM);
    assert.deepEqual(holdOwners(CAM), [], 'a hold outlived the ring it was protecting');
  });
});

// --- the janitor ------------------------------------------------------------------------------------

describe('★ the janitor prunes the ring, and a hold stops it', () => {
  test('segments older than the ring depth are deleted; newer ones are not', (t) => {
    // The ring is the only thing bounding disk use while a camera buffers 24/7. A janitor that pruned
    // nothing fills the volume; one that pruned everything leaves no pre-roll to reach back into.
    t.mock.timers.enable({ apis: ['setInterval'] });
    startSegmenter(CAM, 'somepath');
    segment('seg-old.mkv', DEPTH_MS + 30_000);
    segment('seg-new.mkv', 5_000);
    fs.writeFileSync(path.join(ringDir(), 'concat-list.txt'), 'not a segment');

    t.mock.timers.tick(2000); // SEGMENT_SEC
    const left = ringFiles();
    assert.ok(!left.includes('seg-old.mkv'), 'an expired segment survived the janitor');
    assert.ok(left.includes('seg-new.mkv'), 'a segment inside the ring depth was pruned');
    assert.ok(left.includes('concat-list.txt'), 'the janitor deleted something that is not a segment');
  });

  test('★ a hold reaching further back than the depth keeps the older segments', (t) => {
    // The #255 case from the ring's side: a 2-minute manual recording against a ring sized for a ~20s
    // alert clip would have its own opening pruned out from under it before the extraction runs.
    t.mock.timers.enable({ apis: ['setInterval'] });
    startSegmenter(CAM, 'somepath');
    const old = segment('seg-old.mkv', DEPTH_MS + 30_000);
    holdRing(CAM, RING_OWNER.ONDEMAND, Date.now() - (DEPTH_MS + 60_000));
    t.mock.timers.tick(2000);
    assert.equal(fs.existsSync(old), true, 'a held segment was pruned — the recording loses its opening');

    // ...and releasing the hold lets the next tick collect it, so a hold cannot leak into forever.
    releaseRing(CAM, RING_OWNER.ONDEMAND);
    t.mock.timers.tick(2000);
    assert.equal(fs.existsSync(old), false, 'the segment stayed protected after its hold was released');
  });

  test('the janitor stops when the segmenter does', (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    startSegmenter(CAM, 'somepath');
    stopSegmenter(CAM);
    const old = segment('seg-old.mkv', DEPTH_MS + 30_000);
    t.mock.timers.tick(10_000);
    assert.equal(fs.existsSync(old), true, 'the janitor outlived its segmenter and pruned a dead ring');
  });

  test('a ring directory that has vanished is survived, not thrown from', (t) => {
    // A volume remount, or somebody clearing /recordings by hand. The janitor runs on a timer with no
    // error handling of its own, so a throw here is an unhandled exception every 2 seconds.
    t.mock.timers.enable({ apis: ['setInterval'] });
    startSegmenter(CAM, 'somepath');
    fs.rmSync(ringDir(), { recursive: true, force: true });
    t.mock.timers.tick(2000);
    assert.ok(true, 'no throw');
  });
});

// --- extraction refusals ----------------------------------------------------------------------------

describe('extractClip refuses before it spawns anything', () => {
  test('★ no segmenter for the camera', async () => {
    await assert.rejects(() => extractClip(CAM, { settleMs: 0 }), /no segmenter running/);
  });

  test('★ a ring with nothing in it', async () => {
    startSegmenter(CAM, 'somepath');
    await assert.rejects(() => extractClip(CAM, { settleMs: 0 }), /no ring segments/);
  });

  test('★ segments that exist but do not cover the requested window', async () => {
    // Selection is by mtime, not by "there is a file here". An hour-old segment cannot contain a clip
    // of something that happened a moment ago, and concatenating it would produce a clip of the wrong
    // time — worse than no clip, because it looks like evidence.
    startSegmenter(CAM, 'somepath');
    segment('seg-ancient.mkv', 60 * 60 * 1000);
    await assert.rejects(
      () => extractClip(CAM, { at: Date.now(), preRollSec: 5, postRollSec: 15, settleMs: 0 }),
      /no ring segments/
    );
  });

  test('★ the segment still being written is skipped', async () => {
    // Its mtime is within ~700ms of now, meaning ffmpeg has not closed it. Concatenating a half-written
    // segment truncates the clip. Here it is the ONLY candidate, so skipping it leaves nothing.
    startSegmenter(CAM, 'somepath');
    segment('seg-open.mkv', 0);
    await assert.rejects(() => extractClip(CAM, { at: Date.now(), settleMs: 0 }), /no ring segments/);
  });

  test('a closed segment covering the window IS selected — the control', async () => {
    // It gets past selection and fails at the ffmpeg spawn instead, which is the next thing that
    // happens and is unavailable here by design. Without this control, every rejection above would
    // also pass for an extractClip that selected nothing, ever.
    startSegmenter(CAM, 'somepath');
    segment('seg-usable.mkv', 3000);
    await assert.rejects(
      () => extractClip(CAM, { at: Date.now() - 4000, preRollSec: 5, postRollSec: 15, settleMs: 0 }),
      (err) => {
        assert.doesNotMatch(err.message, /no ring segments/, 'the segment covering the window was not selected');
        return true;
      }
    );
  });

  test('the concat list is cleaned up even when the cut fails', async () => {
    // It is written into the ring directory, so a leaked one is both clutter and a file the next
    // startSegmenter has to know to clear.
    startSegmenter(CAM, 'somepath');
    segment('seg-usable.mkv', 3000);
    await extractClip(CAM, { at: Date.now() - 4000, outBase: 'ev1', settleMs: 0 }).catch(() => {});
    assert.deepEqual(
      ringFiles().filter((f) => f.startsWith('concat-')), [],
      'a concat list was left behind by a failed extraction'
    );
  });
});

// --- ringOldestStartMs (#412) -------------------------------------------------------------------------
// The wake watcher clamps a clip's anchor to where the ring's footage really begins, because a clip that
// opens before it has an EMPTY selection and fails. These pin the function against the same files and the
// same "closed segment" rule extractClip's selection uses, so the clamp and the cut cannot disagree.
describe('★ #412 ringOldestStartMs: where the ring\'s footage really starts', () => {
  const mtimeOf = (p) => fs.statSync(p).mtimeMs;
  const SEG_MS = 2000; // SEGMENT_SEC, restated only to build the expectation (a segment's content starts SEG before its mtime)

  test('null when no segmenter runs for the camera, even if segment files are lying in its ring dir', () => {
    segment('seg-orphan.mkv', 10_000);
    assert.equal(isSegmenterRunning(CAM), false, 'precondition');
    assert.equal(ringOldestStartMs(CAM), null);
  });

  test('null for an empty ring (a freshly started one)', () => {
    startSegmenter(CAM, 'somepath');
    assert.equal(ringOldestStartMs(CAM), null);
  });

  test('null when the only segment is still being written (younger than SEGMENT_OPEN_MS)', () => {
    startSegmenter(CAM, 'somepath');
    segment('seg-open.mkv', 0);
    assert.equal(ringOldestStartMs(CAM), null, 'a half-written tail is not footage a clip can be cut from');
  });

  test('the OLDEST closed segment\'s mtime minus one segment length, whatever the file names say', () => {
    startSegmenter(CAM, 'somepath');
    // Names deliberately in the opposite order to the mtimes: only the mtime may decide.
    const oldest = segment('seg-z.mkv', 12_000);
    segment('seg-m.mkv', 8_000);
    segment('seg-a.mkv', 4_000);
    segment('seg-open.mkv', 0);
    assert.equal(ringOldestStartMs(CAM), mtimeOf(oldest) - SEG_MS);
  });

  test('ignores concat lists and anything that is not a .mkv segment (a leftover list is older than the footage)', () => {
    startSegmenter(CAM, 'somepath');
    const usable = segment('seg-usable.mkv', 5_000);
    const list = path.join(ringDir(), 'concat-ev1.txt');
    fs.writeFileSync(list, 'file x');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(list, old, old);
    const note = path.join(ringDir(), 'keep-me.txt');
    fs.writeFileSync(note, 'x');
    fs.utimesSync(note, old, old);
    assert.equal(ringOldestStartMs(CAM), mtimeOf(usable) - SEG_MS);
  });

  test('a segment that disappears between listing and stat is skipped, not thrown from', () => {
    startSegmenter(CAM, 'somepath');
    const usable = segment('seg-usable.mkv', 5_000);
    // A dangling symlink lists but cannot be stat-ed: statMtime returns null for it.
    try {
      fs.symlinkSync(path.join(ringDir(), 'does-not-exist'), path.join(ringDir(), 'seg-gone.mkv'));
    } catch {
      return; // no symlink right on this machine (Windows without developer mode): the branch is not reachable here
    }
    assert.equal(ringOldestStartMs(CAM), mtimeOf(usable) - SEG_MS);
  });

  test('uses the SAME closed-segment test as extractClip\'s selection: a segment extractClip would skip is not footage here either', async () => {
    // Ages well either side of the ~700 ms boundary (a value near it would flake on a slow machine).
    for (const [ageMs, closed] of [[0, false], [300, false], [1500, true], [3000, true]]) {
      stopAllSegmenters();
      fs.rmSync(path.join(path.resolve(CLIPS_DIR), '.ring'), { recursive: true, force: true });
      startSegmenter(CAM, 'somepath');
      segment('seg-only.mkv', ageMs);
      const oldest = ringOldestStartMs(CAM);
      let selected = true;
      await extractClip(CAM, { at: Date.now(), preRollSec: 5, postRollSec: 15, settleMs: 0 }).catch((err) => {
        if (/no ring segments covered/.test(err.message)) selected = false;
      });
      assert.equal(selected, closed, `precondition: extractClip's own verdict for a ${ageMs} ms old segment`);
      assert.equal(oldest !== null, selected, `ringOldestStartMs and extractClip disagree for a ${ageMs} ms old segment`);
    }
  });
});

// --- ringHasFootageFor (#412) --------------------------------------------------------------------------
// The wake watcher keeps an anchor EARLIER than today's only when the cut at it would find footage; a ring with
// a hole after its oldest segment reaches back past the first frame yet covers nothing there (code review).
describe('★ #412 ringHasFootageFor: would extractClip find any footage for a clip here', () => {
  const clip = { preRollSec: 5, postRollSec: 15 };

  test('false when no segmenter runs for the camera, even with segment files lying in its ring dir', () => {
    segment('seg-orphan.mkv', 10_000);
    assert.equal(ringHasFootageFor(CAM, { at: Date.now(), ...clip }), false);
  });

  test('false for an empty ring; true with a closed segment inside the window', () => {
    startSegmenter(CAM, 'somepath');
    assert.equal(ringHasFootageFor(CAM, { at: Date.now(), ...clip }), false);
    segment('seg-in.mkv', 5_000);
    assert.equal(ringHasFootageFor(CAM, { at: Date.now(), ...clip }), true);
  });

  test('false when the only footage is OLDER than the window or LATER than it', () => {
    startSegmenter(CAM, 'somepath');
    segment('seg-old.mkv', 30_000); // mtime now - 30 s; the window for a clip at `now` starts 13 s before it
    assert.equal(ringHasFootageFor(CAM, { at: Date.now(), ...clip }), false, 'older than the window');
    // The same segment is footage for a clip that happened back then, and not for one that happens long after.
    assert.equal(ringHasFootageFor(CAM, { at: Date.now() - 30_000, ...clip }), true);
    assert.equal(ringHasFootageFor(CAM, { at: Date.now() - 120_000, ...clip }), false, 'the window ended before the segment began');
  });

  test('agrees with extractClip\'s own verdict (same selection) on windows either side of every boundary', async () => {
    startSegmenter(CAM, 'somepath');
    segment('seg-a.mkv', 20_000);
    segment('seg-b.mkv', 8_000);
    segment('seg-open.mkv', 0); // still being written: not footage
    for (const age of [0, 5_000, 12_000, 25_000, 40_000, 90_000]) {
      const at = Date.now() - age;
      let selected = true;
      await extractClip(CAM, { at, ...clip, settleMs: 0 }).catch((err) => {
        if (/no ring segments covered/.test(err.message)) selected = false;
      });
      assert.equal(ringHasFootageFor(CAM, { at, ...clip }), selected, `disagree for a clip ${age} ms ago`);
    }
  });
});

describe('probeClip', () => {
  test('rejects rather than returning a half-built summary when ffprobe cannot run', async () => {
    // The caller writes clip_duration_s and clip_bytes from this. A resolved-but-empty result would
    // record a clip as ready with null metadata, which the UI renders as a playable zero-second video.
    await assert.rejects(() => probeClip(path.join(path.resolve(CLIPS_DIR), 'nope.mp4')));
  });
});
