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
import {
  addHold,
  removeHold,
  effectiveHold,
  clearHolds,
  holdOwners,
  RING_OWNER,
} from '../src/lib/ringHolds.js';

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
    // A typo'd owner string in a RELEASE would silently leak a hold — the ring then grows until the
    // segmenter restarts, with nothing logged and nothing failing. Constants are the guard.
    assert.notEqual(RING_OWNER.WAKE, RING_OWNER.ONDEMAND);
    assert.equal(typeof RING_OWNER.WAKE, 'string');
    assert.equal(typeof RING_OWNER.ONDEMAND, 'string');
  });
});
