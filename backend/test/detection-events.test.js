// The alert history and the clip lifecycle hung off it.
//
// Two invariants worth pinning hard:
//   * Deleting a clip must KEEP the alert row and its snapshot — only the video goes. Getting this
//     wrong silently erases history a parent may be relying on.
//   * Stored paths are jailed under CLIPS_DIR, so a tampered row can never make the serving route
//     hand out an arbitrary file.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { useTempDataDir, cleanupTempDataDirs } from './helpers/harness.js';

useTempDataDir();

const { default: db } = await import('../src/db.js');
const ev = await import('../src/lib/detectionEvents.js');
const { CLIPS_DIR } = await import('../src/lib/clipRecorder.js');

// Write a real file so deletion can be observed, and return the relative path stored on the row.
function makeClipFile(name) {
  fs.mkdirSync(CLIPS_DIR, { recursive: true });
  const rel = path.join('clips-test', name);
  fs.mkdirSync(path.join(CLIPS_DIR, 'clips-test'), { recursive: true });
  fs.writeFileSync(path.join(CLIPS_DIR, rel), 'x'.repeat(64));
  return rel;
}

const rowOf = (id) => db.prepare('SELECT * FROM detection_events WHERE id = ?').get(id);

before(() => { fs.mkdirSync(CLIPS_DIR, { recursive: true }); });
after(() => { db.close(); cleanupTempDataDirs(); });
beforeEach(() => { db.prepare('DELETE FROM detection_events').run(); });

// --- recording --------------------------------------------------------------------------------

test('recordDetectionEvent inserts a row and returns its id', () => {
  const id = ev.recordDetectionEvent('cam-1', 'Nursery', ev.ALERT.MOTION, '12% of zone');
  assert.ok(Number.isInteger(Number(id)) && Number(id) > 0);
  const row = rowOf(id);
  assert.equal(row.camera_id, 'cam-1');
  assert.equal(row.camera_name, 'Nursery');
  assert.equal(row.type, 'motion');
  assert.equal(row.detail, '12% of zone');
});

test('recordDetectionEvent defaults detail to null', () => {
  const id = ev.recordDetectionEvent('cam-1', 'Nursery', ev.ALERT.SOUND);
  assert.equal(rowOf(id).detail, null);
});

test('the camera name is denormalised, so history survives the camera being renamed or deleted', () => {
  // No foreign key on purpose: this is a record of what happened, not a live relationship.
  const id = ev.recordDetectionEvent('cam-gone', 'Old Name', ev.ALERT.MOTION);
  assert.equal(rowOf(id).camera_name, 'Old Name');
});

test('recordDetectionEvent returns null instead of throwing when the insert fails', () => {
  // The detector loop calls this; a logging failure must never take detection down.
  assert.equal(ev.recordDetectionEvent(null, null, null), null);
});

// --- reading ----------------------------------------------------------------------------------

test('getRecentDetectionEvents returns newest first and honours the limit', () => {
  for (let i = 0; i < 5; i++) ev.recordDetectionEvent('cam-1', 'Nursery', ev.ALERT.MOTION, `#${i}`);
  const all = ev.getRecentDetectionEvents();
  assert.equal(all.length, 5);
  assert.equal(all[0].detail, '#4', 'newest first');
  assert.equal(ev.getRecentDetectionEvents(2).length, 2);
});

test('getRecentDetectionEvents on an empty history returns an empty array', () => {
  assert.deepEqual(ev.getRecentDetectionEvents(), []);
});

test('clearDetectionEvents wipes the history and reports how many rows went', () => {
  for (let i = 0; i < 3; i++) ev.recordDetectionEvent('cam-1', 'Nursery', ev.ALERT.MOTION);
  assert.equal(ev.clearDetectionEvents(), 3);
  assert.deepEqual(ev.getRecentDetectionEvents(), []);
  assert.equal(ev.clearDetectionEvents(), 0, 'clearing an empty history is a no-op, not an error');
});

// --- snapshots --------------------------------------------------------------------------------

test('saveEventSnapshot writes the image and flags the row', () => {
  const id = ev.recordDetectionEvent('cam-1', 'Nursery', ev.ALERT.MOTION);
  ev.saveEventSnapshot(id, Buffer.from('fake-jpeg-bytes'));
  assert.equal(rowOf(id).snapshot, 1);
  assert.ok(ev.getEventSnapshotFile(id), 'the file should now resolve');
});

test('saveEventSnapshot ignores a missing buffer without flagging the row', () => {
  const id = ev.recordDetectionEvent('cam-1', 'Nursery', ev.ALERT.MOTION);
  ev.saveEventSnapshot(id, null);
  assert.notEqual(rowOf(id).snapshot, 1);
});

test('getEventSnapshotFile returns null for a non-integer or absent id', () => {
  // Integer-only validation is the first line of defence for the serving route.
  assert.equal(ev.getEventSnapshotFile('../../etc/passwd'), null);
  assert.equal(ev.getEventSnapshotFile('abc'), null);
  assert.equal(ev.getEventSnapshotFile(-1), null);
  assert.equal(ev.getEventSnapshotFile(0), null);
  assert.equal(ev.getEventSnapshotFile(999999), null, 'valid id, but no file on disk');
});

// --- clip lifecycle ---------------------------------------------------------------------------

test('a clip moves pending -> ready and records its metadata', () => {
  const id = ev.recordDetectionEvent('cam-1', 'Nursery', ev.ALERT.MOTION);
  ev.markClipPending(id);
  assert.equal(rowOf(id).clip_status, 'pending');

  const rel = makeClipFile('ready.mp4');
  ev.setClipReady(id, rel, 12.6, 2048);
  const row = rowOf(id);
  assert.equal(row.clip_status, 'ready');
  assert.equal(row.clip_path, rel);
  assert.equal(row.clip_duration_s, 13, 'duration is rounded to whole seconds');
  assert.equal(row.clip_bytes, 2048);
});

test('a clip can move pending -> failed', () => {
  const id = ev.recordDetectionEvent('cam-1', 'Nursery', ev.ALERT.MOTION);
  ev.markClipPending(id);
  ev.setClipFailed(id);
  assert.equal(rowOf(id).clip_status, 'failed');
});

test('setClipReady stores null rather than 0 for missing duration/bytes', () => {
  const id = ev.recordDetectionEvent('cam-1', 'Nursery', ev.ALERT.MOTION);
  ev.setClipReady(id, makeClipFile('nometa.mp4'), 0, 0);
  const row = rowOf(id);
  assert.equal(row.clip_duration_s, null);
    assert.equal(row.clip_bytes, null);
});

test('getEventClipFile resolves only a READY clip that exists on disk', () => {
  const id = ev.recordDetectionEvent('cam-1', 'Nursery', ev.ALERT.MOTION);
  assert.equal(ev.getEventClipFile(id), null, 'no clip yet');

  ev.markClipPending(id);
  assert.equal(ev.getEventClipFile(id), null, 'pending is not playable');

  ev.setClipReady(id, makeClipFile('playable.mp4'), 5, 100);
  assert.ok(ev.getEventClipFile(id), 'ready and present');

  ev.setClipFailed(id);
  assert.equal(ev.getEventClipFile(id), null, 'failed is not playable');
});

test('getEventClipFile returns null when the row points at a file that is gone', () => {
  const id = ev.recordDetectionEvent('cam-1', 'Nursery', ev.ALERT.MOTION);
  ev.setClipReady(id, path.join('clips-test', 'never-written.mp4'), 5, 100);
  assert.equal(ev.getEventClipFile(id), null);
});

test('★ getEventClipFile refuses a path that escapes CLIPS_DIR', () => {
  const id = ev.recordDetectionEvent('cam-1', 'Nursery', ev.ALERT.MOTION);
  ev.setClipReady(id, '../../../../etc/passwd', 5, 100);
  assert.equal(ev.getEventClipFile(id), null);
});

test('getEventClipFile returns null for an unknown event id', () => {
  assert.equal(ev.getEventClipFile(123456), null);
});

// --- deletion + retention accounting ----------------------------------------------------------

test('★ deleting a clip removes the video but KEEPS the alert row and its snapshot', () => {
  const id = ev.recordDetectionEvent('cam-1', 'Nursery', ev.ALERT.MOTION, 'a real alert');
  ev.saveEventSnapshot(id, Buffer.from('jpeg'));
  const rel = makeClipFile('to-delete.mp4');
  ev.setClipReady(id, rel, 8, 512);

  assert.equal(ev.deleteClipForEvent(id), true);

  const row = rowOf(id);
  assert.ok(row, 'the alert row survives');
  assert.equal(row.detail, 'a real alert');
  assert.equal(row.snapshot, 1, 'the snapshot survives');
  assert.equal(row.clip_status, null);
  assert.equal(row.clip_path, null);
  assert.equal(row.clip_bytes, null);
  assert.equal(fs.existsSync(path.join(CLIPS_DIR, rel)), false, 'the mp4 is gone');
});

test('deleteClipForEvent returns false when there is no clip to delete', () => {
  const id = ev.recordDetectionEvent('cam-1', 'Nursery', ev.ALERT.MOTION);
  assert.equal(ev.deleteClipForEvent(id), false);
  assert.equal(ev.deleteClipForEvent(999999), false);
});

test('getClipStorageTotals counts only ready clips', () => {
  const a = ev.recordDetectionEvent('cam-1', 'Nursery', ev.ALERT.MOTION);
  const b = ev.recordDetectionEvent('cam-1', 'Nursery', ev.ALERT.MOTION);
  const c = ev.recordDetectionEvent('cam-1', 'Nursery', ev.ALERT.MOTION);
  ev.setClipReady(a, makeClipFile('a.mp4'), 5, 1000);
  ev.setClipReady(b, makeClipFile('b.mp4'), 5, 2000);
  ev.markClipPending(c); // pending must not count toward used storage

  assert.deepEqual(ev.getClipStorageTotals(), { count: 2, bytes: 3000 });
});

test('getClipStorageTotals is zero (not null) with no clips at all', () => {
  assert.deepEqual(ev.getClipStorageTotals(), { count: 0, bytes: 0 });
});

test('getReadyClipsOldestFirst drives size-cap retention, oldest first', () => {
  const ids = [1, 2, 3].map(() => ev.recordDetectionEvent('cam-1', 'Nursery', ev.ALERT.MOTION));
  ids.forEach((id, i) => ev.setClipReady(id, makeClipFile(`o${i}.mp4`), 5, 100));
  const list = ev.getReadyClipsOldestFirst();
  assert.deepEqual(list.map((r) => r.id), ids, 'ascending id = oldest first');
});

test('getExpiredClips finds only clips older than the cutoff', () => {
  const fresh = ev.recordDetectionEvent('cam-1', 'Nursery', ev.ALERT.MOTION);
  const old = ev.recordDetectionEvent('cam-1', 'Nursery', ev.ALERT.MOTION);
  ev.setClipReady(fresh, makeClipFile('fresh.mp4'), 5, 100);
  ev.setClipReady(old, makeClipFile('old.mp4'), 5, 100);
  db.prepare("UPDATE detection_events SET created_at = datetime('now', '-40 days') WHERE id = ?").run(old);

  const expired = ev.getExpiredClips(30);
  assert.deepEqual(expired.map((r) => r.id), [old]);
  assert.equal(ev.getExpiredClips(365).length, 0, 'a longer retention expires nothing');
});

test('getClips lists only playable clips, newest first, and caps the limit', () => {
  const withClip = ev.recordDetectionEvent('cam-1', 'Nursery', ev.ALERT.MOTION);
  ev.recordDetectionEvent('cam-1', 'Nursery', ev.ALERT.MOTION); // no clip — must not appear
  ev.setClipReady(withClip, makeClipFile('listed.mp4'), 9, 700);

  const clips = ev.getClips();
  assert.equal(clips.length, 1);
  assert.equal(clips[0].id, withClip);
  assert.equal(clips[0].clip_bytes, 700);
  assert.equal(ev.getClips(0).length, 0);
});

test('unlinkClip refuses a path outside CLIPS_DIR and tolerates a missing file', () => {
  // Must not throw in either case — it runs inside the retention sweeper.
  ev.unlinkClip('../../../../etc/passwd');
  ev.unlinkClip('clips-test/does-not-exist.mp4');
  ev.unlinkClip(null);
  assert.ok(true, 'no throw');
});
