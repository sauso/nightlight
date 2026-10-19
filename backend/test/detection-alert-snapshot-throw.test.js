// #743: even a snapshot fetch that breaks its own best-effort contract must not drop an alert.
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupTempDataDirs, makeCamera } from './helpers/harness.js';

useTempDataDir();
after(cleanupTempDataDirs);
mock.module('../src/lib/snapshot.js', {
  namedExports: {
    fetchHttpSnapshot: async () => { throw new Error('secret should never be logged'); },
    captureSnapshot: async () => null,
  },
});

const { default: db } = await import('../src/db.js');
const { logger } = await import('../src/lib/logger.js');
const { fireDetectionAlert } = await import('../src/lib/detectionAlert.js');
const { ALERT, getRecentDetectionEvents } = await import('../src/lib/detectionEvents.js');

test('an unexpected snapshot throw falls back and warns once without credentials', async (t) => {
  const warnings = [];
  t.mock.method(logger, 'warn', (line) => warnings.push(line));
  makeCamera(db, { id: 'cam-throw', extra: { snapshot_url: 'http://user:secret@camera.invalid/snap' } });
  const cam = db.prepare('SELECT * FROM cameras WHERE id = ?').get('cam-throw');
  await assert.doesNotReject(fireDetectionAlert(cam, ALERT.MOTION, 'first'));
  await assert.doesNotReject(fireDetectionAlert(cam, ALERT.MOTION, 'second'));
  assert.equal(getRecentDetectionEvents().length, 2);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /snapshot fetch threw/);
  assert.doesNotMatch(warnings[0], /secret|camera\.invalid/);
});
