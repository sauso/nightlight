// Two features share one camera's ring, and before #255 they could not both hold it.
//
// `entry.holdFromMs` was a single field: `holdRing` overwrote it unconditionally and `releaseRing`
// cleared it unconditionally, with no idea who had set it. On-demand Record (recordings.js) and
// automatic wake clips (wakeWatcher.js) both use it. The sequence that loses data is ordinary: a child
// wakes, the wake watcher holds so the opening survives the ~63s ring, a parent watching on their
// phone presses Record — and the Record hold replaces the wake watcher's. When the manual recording
// finishes, its release clears protection the wake watcher still needed, and the janitor prunes the
// wake clip's pre-roll on its next 2s tick. Both features are correct as written; the resource could
// not represent two holders.
//
// These cases drive the registry directly. That is deliberate and it is why the registry is its own
// module: since PR #274 a segmenter that cannot spawn ffmpeg correctly DELETES its own map entry, and
// a test environment has no ffmpeg by design — so there is no live segmenter to hang a hold off
// without racing a ~5ms window.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupTempDataDirs } from './helpers/harness.js';

useTempDataDir();

import {
  addHold,
  removeHold,
  effectiveHold,
  clearHolds,
  holdOwners,
  RING_OWNER,
} from '../src/lib/ringHolds.js';
const { holdRing, releaseRing, startSegmenter, stopSegmenter } = await import('../src/lib/clipRecorder.js');
const fsMod = await import('node:fs');
const indexSrcRing = fsMod.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');

const CAM = 'cam-1';
const OTHER = 'cam-2';

// Wall-clock-ish values, deepest first. Naming them makes the ordering assertions readable.
const DEEP = 1_000_000; // the wake watcher's hold: further back in time
const SHALLOW = 1_005_000; // a later Record: 5s more recent

beforeEach(() => {
  clearHolds(CAM);
  clearHolds(OTHER);
});

describe('ring holds', () => {
  test('THE #255 SCENARIO: a manual Record finishing must not drop the wake watcher’s hold', () => {
    // 1. a wake begins — the watcher protects the opening
    addHold(CAM, RING_OWNER.WAKE, DEEP);
    // 2. a parent presses Record while watching that same wake
    addHold(CAM, RING_OWNER.ONDEMAND, SHALLOW);
    // 3. the manual recording finishes and releases ITS hold
    removeHold(CAM, RING_OWNER.ONDEMAND);

    assert.equal(
      effectiveHold(CAM),
      DEEP,
      'the wake watcher’s protection was cleared by an unrelated release — its pre-roll is now prunable'
    );
    assert.deepEqual(holdOwners(CAM), [RING_OWNER.WAKE]);
  });

  test('the DEEPEST hold wins while both are held, not the most recent writer', () => {
    // The other half of the single-slot bug: a later, shallower hold silently shortened a deeper one,
    // so the wake clip kept its protection in name but lost the part it needed.
    addHold(CAM, RING_OWNER.WAKE, DEEP);
    addHold(CAM, RING_OWNER.ONDEMAND, SHALLOW);
    assert.equal(effectiveHold(CAM), DEEP, 'a shallower second hold shortened a deeper first one');

    // ...and in the other order, so this is not an artefact of insertion sequence.
    clearHolds(CAM);
    addHold(CAM, RING_OWNER.ONDEMAND, SHALLOW);
    addHold(CAM, RING_OWNER.WAKE, DEEP);
    assert.equal(effectiveHold(CAM), DEEP);
  });

  test('an owner re-holding replaces only its own value', () => {
    // Record extends its own hold as a long recording runs; that must move only its entry.
    addHold(CAM, RING_OWNER.WAKE, DEEP);
    addHold(CAM, RING_OWNER.ONDEMAND, SHALLOW);
    addHold(CAM, RING_OWNER.ONDEMAND, SHALLOW + 2000);

    assert.deepEqual(holdOwners(CAM).sort(), [RING_OWNER.ONDEMAND, RING_OWNER.WAKE]);
    assert.equal(effectiveHold(CAM), DEEP);
  });

  test('releasing the LAST holder returns the ring to normal depth-based pruning', () => {
    addHold(CAM, RING_OWNER.WAKE, DEEP);
    removeHold(CAM, RING_OWNER.WAKE);
    assert.equal(effectiveHold(CAM), null, 'a hold survived its only owner releasing — the ring grows forever');
    assert.deepEqual(holdOwners(CAM), []);
  });

  test('releasing an owner that never held is a no-op, NOT a clear-all', () => {
    // The old releaseRing cleared the slot whoever called it. This is that bug in miniature.
    addHold(CAM, RING_OWNER.WAKE, DEEP);
    removeHold(CAM, RING_OWNER.ONDEMAND);
    removeHold(CAM, 'some-future-feature');

    assert.equal(effectiveHold(CAM), DEEP, 'an unrelated release cleared a hold it did not own');
  });

  test('holds are per camera', () => {
    addHold(CAM, RING_OWNER.WAKE, DEEP);
    addHold(OTHER, RING_OWNER.ONDEMAND, SHALLOW);

    assert.equal(effectiveHold(CAM), DEEP);
    assert.equal(effectiveHold(OTHER), SHALLOW);

    clearHolds(CAM);
    assert.equal(effectiveHold(CAM), null);
    assert.equal(effectiveHold(OTHER), SHALLOW, 'tearing down one camera dropped another camera’s hold');
  });

  test('a camera nobody holds reports null, and unknown cameras do not throw', () => {
    assert.equal(effectiveHold('never-seen'), null);
    assert.deepEqual(holdOwners('never-seen'), []);
    removeHold('never-seen', RING_OWNER.WAKE);
    clearHolds('never-seen');
  });

  test('the two real owners are distinct constants', () => {
    // (see below for the wiring cases — the registry being right is only half of it)
    // A typo'd owner string in a RELEASE would silently leak a hold — the ring then grows until the
    // segmenter restarts, with nothing logged and nothing failing. Constants are the guard.
    assert.notEqual(RING_OWNER.WAKE, RING_OWNER.ONDEMAND);
    assert.equal(typeof RING_OWNER.WAKE, 'string');
    assert.equal(typeof RING_OWNER.ONDEMAND, 'string');
  });
});

describe('the wiring in clipRecorder', () => {
  // ★ THE CASES ABOVE ARE NOT ENOUGH, and adversarial review of PR #277 proved it: with only those,
  // `releaseRing` could be changed back to `clearHolds(cameraId)` — reintroducing #255 VERBATIM — and
  // the whole suite stayed green, because nothing referenced the functions the rest of the app calls.
  // A registry that is perfect but wired up wrong is the exact failure mode here.

  test('releaseRing releases ONLY its own owner — the #255 defect, through the real API', () => {
    // The scenario again, but driven through the function recordings.js actually calls.
    addHold(CAM, RING_OWNER.WAKE, DEEP);
    addHold(CAM, RING_OWNER.ONDEMAND, SHALLOW);

    releaseRing(CAM, RING_OWNER.ONDEMAND);

    assert.equal(effectiveHold(CAM), DEEP, 'releaseRing cleared a hold belonging to another owner');
    assert.deepEqual(holdOwners(CAM), [RING_OWNER.WAKE]);
  });

  test('releaseRing on a camera with no segmenter does not throw', () => {
    // It deliberately does NOT require a live segmenter: a recording that fails must be able to let go
    // of its hold even after the segmenter died underneath it.
    releaseRing('no-such-camera', RING_OWNER.ONDEMAND);
  });

  test('holdRing records the hold under its owner, and refuses when nothing is buffering', () => {
    // ⚠️ Two halves, and the ordering is what makes this testable at all. There is no ffmpeg in a test
    // environment, and since #274 a segmenter that cannot spawn DELETES its own map entry — but it does
    // so on a LATER TICK, because 'error' is emitted asynchronously. Everything here is synchronous, so
    // it runs inside the window where the entry legitimately exists. No sleep, no race.
    assert.equal(holdRing('never-started', RING_OWNER.WAKE, DEEP), false, 'holdRing claimed to hold a ring that does not exist');
    assert.deepEqual(holdOwners('never-started'), [], 'it recorded a hold anyway');

    const CAM_LIVE = 'cam-live-hold';
    startSegmenter(CAM_LIVE, 'path_live_hold', { preRollSec: 2, postRollSec: 2 });
    try {
      assert.equal(holdRing(CAM_LIVE, RING_OWNER.WAKE, DEEP), true, 'holdRing refused a running segmenter');
      assert.deepEqual(holdOwners(CAM_LIVE), [RING_OWNER.WAKE], 'holdRing did not record the hold');
      assert.equal(effectiveHold(CAM_LIVE), DEEP);
    } finally {
      stopSegmenter(CAM_LIVE);
    }
  });

  test('stopSegmenter drops that camera’s holds — the ring goes with it', () => {
    const CAM_LIVE = 'cam-live-stop';
    startSegmenter(CAM_LIVE, 'path_live_stop', { preRollSec: 2, postRollSec: 2 });
    holdRing(CAM_LIVE, RING_OWNER.ONDEMAND, SHALLOW);
    addHold(OTHER, RING_OWNER.WAKE, DEEP); // a bystander, to prove the teardown is not a clear-all

    stopSegmenter(CAM_LIVE);

    assert.deepEqual(holdOwners(CAM_LIVE), [], 'a hold outlived the segmenter it was protecting');
    assert.equal(effectiveHold(OTHER), DEEP, 'tearing down one camera dropped another camera’s hold');
  });

  test('the janitor is given the effective hold, not a constant', () => {
    // The one line that connects the registry to actual pruning. It cannot be driven without a live
    // ffmpeg (the janitor dies with the segmenter entry when the spawn fails), so this reads the source
    // — a mutant passing `null` there disables the entire feature while every other case stays green.
    const src = fsMod.readFileSync(new URL('../src/lib/clipRecorder.js', import.meta.url), 'utf8');
    assert.match(
      src,
      /pruneRing\(ringDir, entry\.ringDepthMs, effectiveHold\(cameraId\)\)/,
      'the ring janitor no longer consults the hold registry'
    );
    assert.ok(!/entry\.holdFromMs/.test(src), 'a reference to the removed single-slot field is back');
  });
});

describe('the wiring in the callers', () => {
  // Owner identity is the whole mechanism: releasing as the WRONG owner reintroduces #255 exactly, and
  // review of #277 showed those mutants surviving at all three call sites.
  const read = (rel) => fsMod.readFileSync(new URL(rel, import.meta.url), 'utf8');

  test('on-demand Record holds and releases as ONDEMAND', () => {
    const src = read('../src/lib/recordings.js');
    assert.match(src, /holdRing\(camera\.id, RING_OWNER\.ONDEMAND,/, 'Record no longer holds as ONDEMAND');
    assert.match(src, /releaseRing\(cameraId, RING_OWNER\.ONDEMAND\)/, 'Record no longer releases as ONDEMAND');
    assert.ok(!/RING_OWNER\.WAKE/.test(src), 'recordings.js touches the wake watcher’s hold');
  });

  test('the wake watcher holds and releases as WAKE', () => {
    const src = read('../src/lib/wakeWatcher.js');
    assert.match(src, /holdRing\(cameraId, RING_OWNER\.WAKE,/, 'the wake watcher no longer holds as WAKE');
    assert.equal(
      (src.match(/releaseRing\(cameraId, RING_OWNER\.WAKE\)/g) || []).length,
      2,
      'both wake-watcher release sites must release as WAKE'
    );
    assert.ok(!/RING_OWNER\.ONDEMAND/.test(src), 'wakeWatcher.js touches Record’s hold');
  });

  test('no caller still uses the old single-argument form', () => {
    for (const f of ['../src/lib/recordings.js', '../src/lib/wakeWatcher.js']) {
      const src = read(f);
      assert.ok(!/releaseRing\([A-Za-z.]+\)\s*;/.test(src), `${f} still calls releaseRing without an owner`);
    }
  });
});
