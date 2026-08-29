// A frame captured at each bed transition, and the query that finds the ones that are provably wrong.
//
// Why this exists: the detector records WHEN it thinks the bed changed, and until now there was no way
// to see what it was looking at when it decided. Measured on 2026-08-29 over 238 stored transitions,
// 147 (62%) are physically impossible on sequence alone — two `into_bed` in a row, or two `out_of_bed`.
// At least one of every such pair is wrong, so the table can already point at its own mistakes; the
// picture is what makes them diagnosable.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { useTempDataDir, cleanupTempDataDirs, makeCamera } from './helpers/harness.js';

const TMP = useTempDataDir();

const { default: db } = await import('../src/db.js');
const { recordBedTransition, getBedTransitions, getImpossibleTransitions, transitionSnapshotPath, TRANSITION } =
  await import('../src/lib/bedTransitions.js');

const CAM = 'cam-1';
const CAM2 = 'cam-2';

before(() => {
  makeCamera(db, { id: CAM, name: 'Renz Cam' });
  makeCamera(db, { id: CAM2, name: 'Raffa Room' });
});

beforeEach(() => {
  db.prepare('DELETE FROM bed_transitions').run();
});

after(() => {
  db.close();
  cleanupTempDataDirs();
});

// --- the column and the row ---------------------------------------------------------------------

test('a transition records without a snapshot rather than failing when the camera gives nothing', () => {
  // There is no camera and no ffmpeg in this suite, so the capture can only fail. That is the point:
  // the detector runs several times a second, and a transition with no picture must still be a
  // perfectly good transition. Anything else would make the sleep analysis depend on a camera
  // answering an HTTP request in time.
  const id = recordBedTransition(CAM, TRANSITION.INTO_BED, 0.12);
  assert.ok(Number.isInteger(Number(id)), 'the insert must return the new id');
  const row = db.prepare('SELECT * FROM bed_transitions WHERE id = ?').get(id);
  assert.equal(row.type, 'into_bed');
  assert.equal(row.peak, 0.12);
  assert.equal(row.snapshot, 0, 'no image captured, so the flag stays 0');
});

test('an unknown camera does not throw and still records the transition', () => {
  assert.doesNotThrow(() => recordBedTransition('no-such-camera', TRANSITION.OUT_OF_BED, 0.4));
  assert.equal(db.prepare('SELECT COUNT(*) c FROM bed_transitions').get().c, 1);
});

test('the peak is rounded, and null stays null', () => {
  const a = recordBedTransition(CAM, TRANSITION.INTO_BED, 0.123456);
  const b = recordBedTransition(CAM, TRANSITION.OUT_OF_BED, null);
  assert.equal(db.prepare('SELECT peak FROM bed_transitions WHERE id = ?').get(a).peak, 0.123);
  assert.equal(db.prepare('SELECT peak FROM bed_transitions WHERE id = ?').get(b).peak, null);
});

test('getBedTransitions returns the id and snapshot flag the detail view needs', () => {
  recordBedTransition(CAM, TRANSITION.INTO_BED, 0.2);
  const rows = getBedTransitions([CAM], '2000-01-01 00:00:00', '2999-01-01 00:00:00');
  assert.equal(rows.length, 1);
  for (const k of ['id', 'camera_id', 'type', 'created_at', 'peak', 'snapshot']) {
    assert.ok(k in rows[0], `missing ${k}`);
  }
});

// --- pruning ------------------------------------------------------------------------------------

test('an aged-out transition takes its image with it', () => {
  // The image is named by the row id, so deleting the rows first would leave a file nobody can name.
  // This is the ordering bug the implementation is written to avoid, pinned here.
  const id = recordBedTransition(CAM, TRANSITION.INTO_BED, 0.2);
  const file = path.join(TMP, 'transition-snapshots', `${id}.jpg`);
  fs.writeFileSync(file, Buffer.from([0xff, 0xd8, 0xff]));
  db.prepare("UPDATE bed_transitions SET snapshot = 1, created_at = datetime('now', '-90 days') WHERE id = ?").run(id);
  assert.ok(fs.existsSync(file));

  recordBedTransition(CAM, TRANSITION.OUT_OF_BED, 0.3); // any insert sweeps

  assert.equal(db.prepare('SELECT COUNT(*) c FROM bed_transitions WHERE id = ?').get(id).c, 0, 'row gone');
  assert.equal(fs.existsSync(file), false, 'image gone with it');
});

test('a recent transition and its image are left alone', () => {
  const id = recordBedTransition(CAM, TRANSITION.INTO_BED, 0.2);
  const file = path.join(TMP, 'transition-snapshots', `${id}.jpg`);
  fs.writeFileSync(file, Buffer.from([0xff, 0xd8, 0xff]));
  db.prepare('UPDATE bed_transitions SET snapshot = 1 WHERE id = ?').run(id);

  recordBedTransition(CAM, TRANSITION.OUT_OF_BED, 0.3);

  assert.ok(db.prepare('SELECT 1 FROM bed_transitions WHERE id = ?').get(id));
  assert.ok(fs.existsSync(file));
});

test('a path can never escape the snapshot directory', () => {
  for (const bad of ['../../etc/passwd', '1; rm -rf /', -1, 0, 1.5, 'abc', null]) {
    assert.equal(transitionSnapshotPath(bad), null, `${bad} must not resolve`);
  }
});

// --- the impossible-sequence query --------------------------------------------------------------

test('two into_bed in a row is reported as impossible', () => {
  // You cannot get into a bed you are already in.
  const first = recordBedTransition(CAM, TRANSITION.INTO_BED, 0.2);
  db.prepare("UPDATE bed_transitions SET created_at = datetime('now','-10 minutes') WHERE id = ?").run(first);
  const second = recordBedTransition(CAM, TRANSITION.INTO_BED, 0.3);

  const bad = getImpossibleTransitions();
  assert.equal(bad.length, 1);
  assert.equal(bad[0].id, second, 'the SECOND of the pair is the one flagged');
  assert.equal(bad[0].contradicts, first, 'and it names the one it contradicts');
  assert.equal(bad[0].camera_name, 'Renz Cam');
});

test('a normal alternating sequence reports nothing', () => {
  let t = 0;
  for (const type of [TRANSITION.INTO_BED, TRANSITION.OUT_OF_BED, TRANSITION.INTO_BED, TRANSITION.OUT_OF_BED]) {
    const id = recordBedTransition(CAM, type, 0.2);
    db.prepare("UPDATE bed_transitions SET created_at = datetime('now', ?) WHERE id = ?").run(`-${100 - t} minutes`, id);
    t += 10;
  }
  assert.deepEqual(getImpossibleTransitions(), []);
});

test('the sequence is tracked PER CAMERA, not across all of them', () => {
  // Two children being put to bed one after the other is two into_bed events in a row globally, and
  // is entirely normal. Interleaving them must not manufacture a fault.
  const a = recordBedTransition(CAM, TRANSITION.INTO_BED, 0.2);
  db.prepare("UPDATE bed_transitions SET created_at = datetime('now','-10 minutes') WHERE id = ?").run(a);
  recordBedTransition(CAM2, TRANSITION.INTO_BED, 0.2);

  assert.deepEqual(getImpossibleTransitions(), [], 'different cameras cannot contradict each other');
});

test('a run of three flags two contradictions, not one', () => {
  let t = 30;
  for (let i = 0; i < 3; i++) {
    const id = recordBedTransition(CAM, TRANSITION.OUT_OF_BED, 0.2);
    db.prepare("UPDATE bed_transitions SET created_at = datetime('now', ?) WHERE id = ?").run(`-${t} minutes`, id);
    t -= 10;
  }
  assert.equal(getImpossibleTransitions().length, 2, 'each event after the first contradicts its predecessor');
});

test('the limit is clamped rather than trusted', () => {
  let t = 60;
  for (let i = 0; i < 6; i++) {
    const id = recordBedTransition(CAM, TRANSITION.INTO_BED, 0.2);
    db.prepare("UPDATE bed_transitions SET created_at = datetime('now', ?) WHERE id = ?").run(`-${t} minutes`, id);
    t -= 5;
  }
  assert.equal(getImpossibleTransitions({ limit: 2 }).length, 2);
  assert.ok(getImpossibleTransitions({ limit: 0 }).length >= 1, 'zero must not blank the list');
  assert.ok(getImpossibleTransitions({ limit: 99999 }).length <= 500, 'and an absurd value is capped');
});
