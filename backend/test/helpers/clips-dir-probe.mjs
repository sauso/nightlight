// Child-process probe for clips-dir-normalisation.test.js (#545). NOT a test file (no `.test.js`).
//
// CLIPS_DIR is read once, at module load, so each spelling of it has to be tried in a FRESH process —
// the same way the bug was reproduced. The parent sets DATA_DIR / CLIPS_DIR / cwd; this script uses the
// real modules and the real schema (nothing mocked), plants a clip, a recording and a timelapse under
// the exported CLIPS_DIR, and prints what the three serving guards and the deleting guard made of them.
import fs from 'node:fs';
import path from 'node:path';

const { default: db } = await import('../../src/db.js');
const ev = await import('../../src/lib/detectionEvents.js');
const rec = await import('../../src/lib/recordings.js');
const tl = await import('../../src/lib/timelapse.js');
const { CLIPS_DIR } = await import('../../src/lib/clipRecorder.js');

const plant = (rel) => {
  const abs = path.join(CLIPS_DIR, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, 'x'.repeat(64));
  return abs;
};

// A file in CLIPS_DIR's PARENT that a traversal must never reach (planted so it really exists: a
// guard that is missing would otherwise be hidden by fs.existsSync returning false).
const outside = path.join(path.dirname(CLIPS_DIR), 'outside-secret.mp4');
fs.mkdirSync(path.dirname(outside), { recursive: true });
fs.writeFileSync(outside, 'must not be served or deleted');
const outsideRel = path.join('..', 'outside-secret.mp4');

const clipAbs = plant(path.join('cam-1', 'clip.mp4'));
const evId = ev.recordDetectionEvent('cam-1', 'Cam', ev.ALERT.MOTION);
ev.setClipReady(evId, path.join('cam-1', 'clip.mp4'), 5, 64);

const recAbs = plant(path.join('cam-1', 'rec.mp4'));
const recId = db.prepare(
  "INSERT INTO recordings (camera_id, status, started_at, path) VALUES ('cam-1', 'ready', datetime('now'), ?)"
).run(path.join('cam-1', 'rec.mp4')).lastInsertRowid;

const tlAbs = plant(path.join('timelapse', 'child-1', 'night.mp4'));
const tlId = db.prepare(
  "INSERT INTO timelapses (child_id, night_date, status, path) VALUES ('child-1', '2026-01-01', 'ready', ?)"
).run(path.join('timelapse', 'child-1', 'night.mp4')).lastInsertRowid;

// Traversal rows: same tables, path escapes the jail.
const evEvil = ev.recordDetectionEvent('cam-1', 'Cam', ev.ALERT.MOTION);
ev.setClipReady(evEvil, outsideRel, 5, 64);
const recEvil = db.prepare(
  "INSERT INTO recordings (camera_id, status, started_at, path) VALUES ('cam-1', 'ready', datetime('now'), ?)"
).run(outsideRel).lastInsertRowid;
const tlEvil = db.prepare(
  "INSERT INTO timelapses (child_id, night_date, status, path) VALUES ('child-2', '2026-01-01', 'ready', ?)"
).run(outsideRel).lastInsertRowid;

const out = {
  clipsDir: CLIPS_DIR,
  servedClip: !!ev.getEventClipFile(evId),
  servedRecording: !!rec.getRecordingVideoFile(recId),
  servedTimelapse: !!tl.getTimelapseVideoFile(tlId),
  evilClip: ev.getEventClipFile(evEvil),
  evilRecording: rec.getRecordingVideoFile(recEvil),
  evilTimelapse: tl.getTimelapseVideoFile(tlEvil),
};
ev.deleteClipForEvent(evEvil); // the deleting guard must also leave the outside file alone
out.outsideSurvivedDelete = fs.existsSync(outside);
out.deleted = ev.deleteClipForEvent(evId);
out.clipFileGoneAfterDelete = !fs.existsSync(clipAbs);
out.recFileStillThere = fs.existsSync(recAbs);
out.tlFileStillThere = fs.existsSync(tlAbs);
db.close();
console.log('PROBE ' + JSON.stringify(out));
