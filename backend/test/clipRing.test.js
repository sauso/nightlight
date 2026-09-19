// clipRingWanted — which cameras should be buffering, and why the answer is not "the ones with
// detection clips turned on".
//
// ★ WHAT THIS LOCKS AND WHAT IT CANNOT. The ring feeds two independent features, and the defect this
// file exists for was that most of the places that start it tested only the FIRST of them
// (`detect_record_clips`, which defaults to 0) — so on a default install the second, on-demand
// recording, never got a ring and the tile's Record button never appeared. Of the five call sites on
// `dev`: THREE pre-gated on `detect_record_clips` (reconcile in index.js, re-enabling a camera, and
// saving detection settings), ONE was missing entirely (adding a camera), and TWO had the rule right
// (`PUT /:id` and the global settings save — whose comment even spells it out: "Every enabled camera,
// not just the clip-recording ones"). The condition had been duplicated at each call site and the
// copies drifted apart; pulling it into one predicate is the fix, and these tests stop it drifting
// again.
//
// ⚠️ HONEST LIMIT, because the distinction matters: these tests lock the RULE, not the CALL SITES. The
// bug was never in the rule — `startClipCapture` had it right all along — it was in four callers
// deciding for themselves before calling. Reaching those callers means adding a camera, restarting the
// app or saving detection settings, each of which spawns FFmpeg and talks to MediaMTX, so no test in
// this suite can reach them; that is exactly why 331 backend tests never saw this. The behaviour is
// covered in e2e/playwright/tests/10-clip-lifecycle.spec.js, which asserts a freshly added camera can
// record without anyone editing it first — and which fails against the code as it was.
import { test, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupTempDataDirs, makeCamera, makeChild } from './helpers/harness.js';

useTempDataDir();

const { default: db } = await import('../src/db.js');
const { clipRingWanted } = await import('../src/lib/clipCapture.js');

// The global on-demand switch lives in the settings row: `ondemand_enabled INTEGER NOT NULL DEFAULT 1`
// (db.js). So a fresh install has it ON, from the schema — not from getOndemandSettings' `== null`
// fallback, which only covers a settings row that doesn't exist at all. Reset to the schema default
// between tests rather than to NULL, which the column rejects.
const setOndemand = (v) => db.prepare('UPDATE settings SET ondemand_enabled = ? WHERE id = ?').run(v, 'app');
// wake_clips_enabled ships `NOT NULL DEFAULT 1` (db.js) — same reasoning as setOndemand above: reset to
// the schema default between tests, not to NULL, which the column rejects.
const setWakeClips = (v) => db.prepare('UPDATE settings SET wake_clips_enabled = ? WHERE id = ?').run(v, 'app');

beforeEach(() => {
  db.prepare('DELETE FROM cameras').run();
  db.prepare('DELETE FROM children').run();
  setOndemand(1);
  setWakeClips(1);
});

after(() => {
  db.close();
  cleanupTempDataDirs();
});

const cam = (extra = {}) => db.prepare('SELECT * FROM cameras WHERE id = ?').get(
  makeCamera(db, { id: 'cam-ring', extra }).id
);

describe('clipRingWanted', () => {
  test('a default camera on a default install wants the ring', () => {
    // ★ THE REGRESSION, stated as a rule. Both defaults come from the schema in db.js:
    // `detect_record_clips INTEGER NOT NULL DEFAULT 0` and `ondemand_enabled INTEGER NOT NULL
    // DEFAULT 1`. So this combination is what EVERY newly added camera looks like — and it is the one
    // the old call sites answered "no" to.
    assert.equal(clipRingWanted(cam()), true);
  });

  test('detection clips alone are enough, even with on-demand recording switched off', () => {
    setOndemand(0);
    assert.equal(clipRingWanted(cam({ detect_record_clips: 1 })), true);
  });

  test('on-demand recording alone is enough, with detection clips off', () => {
    setOndemand(1);
    assert.equal(clipRingWanted(cam({ detect_record_clips: 0 })), true);
  });

  test('neither feature wanting it is the only way to say no', () => {
    // The one case where a camera legitimately stops buffering. Worth pinning explicitly: it is what
    // makes "switching on-demand off also stops the per-camera buffering" (docs/recording.md) true,
    // and a predicate that always returned true would pass every test above.
    setOndemand(0);
    assert.equal(clipRingWanted(cam({ detect_record_clips: 0 })), false);
  });

  test('a disabled camera never buffers, however the features are set', () => {
    // A disabled camera has no MediaMTX path and no transcoder, so a segmenter would have nothing to
    // read. Checked for BOTH reasons a camera might otherwise want the ring, because the guard sits
    // before them and a version that only short-circuited one would still look correct in one test.
    setOndemand(1);
    assert.equal(clipRingWanted(cam({ detect_record_clips: 1, disabled: 1 })), false);
    db.prepare('DELETE FROM cameras').run();
    assert.equal(clipRingWanted(cam({ detect_record_clips: 0, disabled: 1 })), false);
  });

  test('no camera at all is false, not a crash', () => {
    // Reconcile iterates rows from the database and a route can be handed an id that no longer exists;
    // a predicate that throws there would take down the reconcile loop for every OTHER camera too.
    assert.equal(clipRingWanted(null), false);
    assert.equal(clipRingWanted(undefined), false);
  });
});

// ★★★ Issue #387 (the 2026-09-11 Codex review, F/R3): wake clips are a THIRD consumer of the ring, and
// clipRingWanted never checked for it — a camera with detection clips AND on-demand both off, serving a
// sleep-tracked child with wake clips on, silently never buffered. captureWakeClipInner (recordings.js)
// requires a running segmenter and just logs + returns null when there isn't one, so this failed
// completely silently: no error, no alert, just an empty morning.
describe('clipRingWanted — wake clips (issue #387)', () => {
  const camFor = (childId, extra = {}) => {
    db.prepare('DELETE FROM cameras').run(); // a fixed id, so a test calling this twice needs a clean slate
    return db.prepare('SELECT * FROM cameras WHERE id = ?').get(
      makeCamera(db, { id: 'cam-wake', childId, extra }).id
    );
  };

  test('★ THE REGRESSION: a wake-only camera — detection clips and on-demand both off — now wants the ring', () => {
    setOndemand(0);
    makeChild(db, { id: 'kid-1', track: 1 });
    assert.equal(clipRingWanted(camFor('kid-1', { detect_record_clips: 0 })), true);
  });

  test('a camera with no child assigned cannot want the ring for wake clips', () => {
    setOndemand(0);
    // No makeChild call at all — child_id stays null on the camera (makeCamera's default).
    assert.equal(clipRingWanted(camFor(null, { detect_record_clips: 0 })), false);
  });

  test('a child with sleep tracking OFF does not arm the ring for wake clips', () => {
    setOndemand(0);
    makeChild(db, { id: 'kid-1', track: 0 });
    assert.equal(clipRingWanted(camFor('kid-1', { detect_record_clips: 0 })), false);
  });

  test('wake clips disabled globally does not arm the ring, even for a tracked child', () => {
    setOndemand(0);
    setWakeClips(0);
    makeChild(db, { id: 'kid-1', track: 1 });
    assert.equal(clipRingWanted(camFor('kid-1', { detect_record_clips: 0 })), false);
  });

  test('a disabled camera stays false even when every other wake-clip condition is met', () => {
    setOndemand(0);
    makeChild(db, { id: 'kid-1', track: 1 });
    assert.equal(clipRingWanted(camFor('kid-1', { detect_record_clips: 0, disabled: 1 })), false);
  });

  test('detection clips or on-demand are still each independently sufficient, wake clips aside', () => {
    // The control: wake-clip eligibility is a THIRD reason, not a replacement for the first two — a
    // camera with no child at all must still want the ring for either of the original reasons.
    setWakeClips(0);
    setOndemand(0);
    assert.equal(clipRingWanted(camFor(null, { detect_record_clips: 1 })), true);
    setOndemand(1);
    assert.equal(clipRingWanted(camFor(null, { detect_record_clips: 0 })), true);
  });
});
