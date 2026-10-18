// The dry run behind "this save will delete N clips" (#395).
//
// The one property that matters is AGREEMENT: the preview must name exactly the clips the real sweep then
// deletes. lib/clipRetentionPreview.js shares the sweep's queries but repeats its small decision loop, so
// these tests run both on the same rows and compare, instead of asserting numbers the fixture chose.
import { test, before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, signToken, mountRouter, call,
} from './helpers/harness.js';

useTempDataDir();

const { default: db } = await import('../src/db.js');
const { CLIPS_DIR } = await import('../src/lib/clipRecorder.js');
const ev = await import('../src/lib/detectionEvents.js');
const { checkClipStorage, sweepClips } = await import('../src/lib/clipStorage.js');
const { previewClipRetention } = await import('../src/lib/clipRetentionPreview.js');
const { default: settingsRouter } = await import('../src/routes/settings.js');

const ABS = path.resolve(CLIPS_DIR);
const GB = 1024 ** 3;
const MOUNTED = `proc /proc proc rw 0 0\n/dev/sda1 / ext4 rw 0 0\n/dev/sdb1 ${ABS} xfs rw 0 0\n`;
const UNMAPPED = 'proc /proc proc rw 0 0\n/dev/sda1 / ext4 rw 0 0\n';

function makeClip(name, { bytes, ageDays }) {
  const id = ev.recordDetectionEvent('cam-1', 'Nursery', ev.ALERT.MOTION);
  const rel = path.join('cam-1', name);
  fs.mkdirSync(path.join(ABS, 'cam-1'), { recursive: true });
  fs.writeFileSync(path.join(ABS, rel), 'x');
  ev.setClipReady(id, rel, 5, bytes);
  db.prepare("UPDATE detection_events SET created_at = datetime('now', ?) WHERE id = ?").run(`-${ageDays} days`, id);
  return id;
}
const liveIds = () =>
  db.prepare("SELECT id FROM detection_events WHERE clip_path IS NOT NULL ORDER BY id").all().map((r) => r.id);
const createdAt = (ids) =>
  ids.length ? db.prepare(`SELECT MIN(created_at) t FROM detection_events WHERE id IN (${ids.join(',')})`).get().t : null;
const setRetention = (days, gb) =>
  db.prepare('UPDATE settings SET clip_retention_days = ?, clip_retention_max_gb = ? WHERE id = ?').run(days, gb, 'app');

// Ages and sizes chosen so that every limit below exercises a different branch: some clips are only
// expired, some only count toward the size cap, and the oldest big one is in both groups.
function seed() {
  return [
    makeClip('a.mp4', { bytes: 0.9 * GB, ageDays: 40 }),
    makeClip('b.mp4', { bytes: 0.5 * GB, ageDays: 30 }),
    makeClip('c.mp4', { bytes: 0.7 * GB, ageDays: 10 }),
    makeClip('d.mp4', { bytes: 0.6 * GB, ageDays: 5 }),
    makeClip('e.mp4', { bytes: 0.8 * GB, ageDays: 1 }),
  ];
}

let server;
let adminToken;
let caregiverToken;

before(async () => {
  server = await mountRouter('/api/settings', settingsRouter);
});
after(async () => {
  await server?.close();
  db.close();
  cleanupTempDataDirs();
});
beforeEach(() => {
  db.prepare('DELETE FROM detection_events').run();
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM users').run();
  fs.rmSync(path.join(ABS, 'cam-1'), { recursive: true, force: true });
  checkClipStorage({ mounts: MOUNTED });
  const admin = makeUser(db, { id: 'u-a', username: 'admin', role: 'admin' });
  const care = makeUser(db, { id: 'u-c', username: 'nanny', role: 'caregiver' });
  adminToken = signToken({ id: admin.id, username: admin.username, role: 'admin', sid: makeSession(db, admin.id) });
  caregiverToken = signToken({ id: care.id, username: care.username, role: 'caregiver', sid: makeSession(db, care.id) });
});

describe('★ the preview agrees with the real sweep', () => {
  // [days, maxGb]: age only; size only; both, where the size pass must not count clips the day pass took;
  // a cap the day pass alone already satisfies; and nothing to delete.
  const CASES = [[14, 0], [0, 2], [14, 1], [60, 1.2], [60, 0], [0, 0], [1, 0.1]];

  for (const [days, maxGb] of CASES) {
    test(`days=${days} maxGb=${maxGb}: the same clips, the same bytes`, () => {
      seed();
      const before = liveIds();
      const bytesOf = new Map(
        db.prepare('SELECT id, clip_bytes b FROM detection_events WHERE clip_path IS NOT NULL').all().map((r) => [r.id, r.b])
      );
      const p = previewClipRetention({ days, maxGb });

      // The preview itself deletes nothing.
      assert.deepEqual(liveIds(), before, 'the preview removed a clip');

      setRetention(days, maxGb);
      sweepClips();
      const gone = before.filter((id) => !liveIds().includes(id));
      assert.equal(p.count, gone.length, 'preview and sweep disagree on how many clips');
      assert.equal(p.bytes, gone.reduce((n, id) => n + bytesOf.get(id), 0), 'preview and sweep disagree on how much');
      assert.equal(p.oldestAt, createdAt(gone), 'preview and sweep disagree on the oldest');
      assert.equal(p.byAge.count + p.bySize.count, p.count);
    });
  }

  test('the cases above really do cover both passes and the overlap', () => {
    // Guards the CASES list itself: if the fixture stopped producing a size-pass deletion after a day-pass one,
    // the agreement tests would still pass while no longer exercising the interplay.
    seed();
    const p = previewClipRetention({ days: 14, maxGb: 1 });
    assert.ok(p.byAge.count > 0 && p.bySize.count > 0, JSON.stringify(p));
  });
});

describe('what the preview reports', () => {
  test('no limits set means nothing to delete, and no oldest date', () => {
    seed();
    const p = previewClipRetention({ days: 0, maxGb: 0 });
    assert.equal(p.count, 0);
    assert.equal(p.bytes, 0);
    assert.equal(p.oldestAt, null);
  });

  test('says when storage is not ready, because then the sweep deletes nothing at all', () => {
    seed();
    checkClipStorage({ mounts: UNMAPPED });
    const before = liveIds();
    assert.equal(previewClipRetention({ days: 14, maxGb: 0 }).storageReady, false);
    setRetention(14, 0);
    sweepClips();
    assert.deepEqual(liveIds(), before, 'the sweep ran although the preview said storage is not ready');
  });
});

describe('GET /api/settings/clip-retention-preview', () => {
  const url = (q) => `${server.url}/api/settings/clip-retention-preview?${q}`;

  test('an admin gets counts, bytes and a date, and nothing that names a file', async () => {
    seed();
    const r = await call(url('days=14&max_gb=1'), { token: adminToken });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, previewClipRetention({ days: 14, maxGb: 1 }));
    const text = JSON.stringify(r.body);
    assert.ok(!text.includes('cam-1') && !text.includes('.mp4') && !text.includes(ABS), 'a path leaked');
  });

  test('a caregiver is refused and an anonymous caller is not let in', async () => {
    seed();
    assert.equal((await call(url('days=14&max_gb=1'), { token: caregiverToken })).status, 403);
    assert.equal((await call(url('days=14&max_gb=1'))).status, 401);
  });

  test('a value the save would refuse is refused here too, and nothing is deleted', async () => {
    seed();
    const before = liveIds();
    for (const q of ['days=-1&max_gb=1', 'days=366&max_gb=1', 'days=14&max_gb=2001', 'days=5abc&max_gb=1', 'days=14', 'max_gb=1', 'days=1.5&max_gb=1']) {
      const r = await call(url(q), { token: adminToken });
      assert.equal(r.status, 400, q);
    }
    assert.deepEqual(liveIds(), before);
  });

  test('the bounds themselves are accepted', async () => {
    assert.equal((await call(url('days=365&max_gb=2000'), { token: adminToken })).status, 200);
    assert.equal((await call(url('days=0&max_gb=0'), { token: adminToken })).status, 200);
  });
});
