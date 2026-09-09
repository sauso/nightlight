// A recording that failed must be VISIBLE, and must still be unservable.
//
// Issue #276, the visible half of #256. Two things now mark a recording 'failed': stopRecording's own
// catch when the extraction throws, and reconcileStaleRecordings on the next boot after a restart
// interrupted one. Both were invisible, because listChildRecordings filtered on status='ready'. So the
// user pressed Record, the button behaved, and then nothing ever appeared — no error, no entry, and
// indistinguishable from the app having ignored the press. That is the worst possible outcome: a
// silence the person cannot act on or even name.
//
// The two halves pull in opposite directions and both are asserted here, because fixing one by
// breaking the other is the obvious wrong turn:
//   1. the row must appear in the list, so the failure can be seen and explained
//   2. its media must STILL refuse to be served — 'failed' means the file is missing or truncated
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { useTempDataDir, cleanupTempDataDirs } from './helpers/harness.js';

useTempDataDir();

const { default: db } = await import('../src/db.js');
const { listChildRecordings, getRecordingVideoFile, getRecordingThumbFile } = await import(
  '../src/lib/recordings.js'
);
const { CLIPS_DIR } = await import('../src/lib/clipRecorder.js');

const CHILD = 'kid-visible';
const CAM = 'cam-visible';
const OTHER_CHILD = 'kid-other';

// Every status the column can hold, derived from the code that writes it rather than a list typed
// here: 'recording' (startRecording INSERT), 'pending' (stopRecording), 'ready' and 'failed'
// (stopRecording's success/catch, and reconcileStaleRecordings).
const ALL_STATUSES = ['recording', 'pending', 'ready', 'failed'];
const VISIBLE = ['ready', 'failed'];

// `recordings.id` is INTEGER PRIMARY KEY, so the ids have to be numbers — a string id fails the
// column's type with SQLITE_MISMATCH rather than being coerced.
const ID = { recording: 901, pending: 902, ready: 903, failed: 904, wake: 905, otherChild: 906 };

function seed() {
  db.prepare('DELETE FROM recordings').run();
  db.prepare('INSERT OR REPLACE INTO children (id, name) VALUES (?, ?)').run(CHILD, 'Visible Kid');
  db.prepare(
    `INSERT OR REPLACE INTO cameras (id, name, rtsp_url, mediamtx_path, child_id)
     VALUES (?, ?, ?, ?, ?)`
  ).run(CAM, 'Visible Cam', 'rtsp://192.0.2.1/x', 'path_visible', CHILD);

  for (const status of ALL_STATUSES) {
    db.prepare(
      `INSERT INTO recordings (id, camera_id, child_id, kind, status, started_at, duration_s, path, thumb_path)
       VALUES (@id, @cam, @child, 'manual', @status, '2026-09-04 10:00:00', 12, @path, @thumb)`
    ).run({
      id: ID[status],
      cam: CAM,
      child: CHILD,
      status,
      // Deliberately non-null even for the failed row: a 'failed' recording can absolutely have a
      // stale path written before the failure, and a serving guard that keyed off "path is null"
      // rather than off the STATUS would pass a weaker fixture while still serving a broken file.
      path: `${CAM}/rec-${status}.mp4`,
      thumb: `${CAM}/rec-${status}.jpg`,
    });
  }

  // ★ THE FILES ARE REALLY CREATED, FOR EVERY STATUS INCLUDING 'failed'. Without this the
  // "a failed recording is refused" cases pass for the WRONG REASON: getRecordingVideoFile ends in
  // jailedFile(), which also returns null when the file simply is not there — so with no files on disk
  // they would stay green even if the status guard were deleted outright. The control case below
  // ('a ready one is still served') is what exposed that, by failing.
  const camDir = path.join(CLIPS_DIR, CAM);
  fs.mkdirSync(camDir, { recursive: true });
  for (const status of ALL_STATUSES) {
    fs.writeFileSync(path.join(camDir, `rec-${status}.mp4`), 'not really video');
    fs.writeFileSync(path.join(camDir, `rec-${status}.jpg`), 'not really a jpeg');
  }

  // ★ THE FIXTURE MUST VARY MORE THAN `status`, and its first version did not — adversarial review of
  // #276 showed both `AND r.kind = 'manual'` and `WHERE r.child_id = ?` could be DELETED with the whole
  // suite green, because every seeded row was a manual recording belonging to one child. Those two
  // clauses are load-bearing: `kind` is the only thing keeping WAKE clips out of the manual Recordings
  // card (and #276 widened the status set, so failed wake clips too), and `child_id` is what stops one
  // child's recordings appearing on another's page in an app organised entirely by child.
  db.prepare('INSERT OR REPLACE INTO children (id, name) VALUES (?, ?)').run(OTHER_CHILD, 'Other Kid');
  db.prepare(
    `INSERT INTO recordings (id, camera_id, child_id, kind, status, started_at, duration_s)
     VALUES (@id, @cam, @child, @kind, 'failed', '2026-09-04 11:00:00', 9)`
  ).run({ id: ID.wake, cam: CAM, child: CHILD, kind: 'wake' });
  db.prepare(
    `INSERT INTO recordings (id, camera_id, child_id, kind, status, started_at, duration_s)
     VALUES (@id, @cam, @child, @kind, 'failed', '2026-09-04 11:00:00', 9)`
  ).run({ id: ID.otherChild, cam: CAM, child: OTHER_CHILD, kind: 'manual' });
}

before(seed);
after(() => cleanupTempDataDirs());

const listed = () => listChildRecordings(CHILD).map((r) => r.status).sort();

describe('listChildRecordings', () => {
  test('shows a FAILED recording — the whole point of #276', () => {
    const rows = listChildRecordings(CHILD);
    const failed = rows.find((r) => r.id === ID.failed);
    assert.ok(failed, 'a failed recording is still invisible — the user gets silence instead of an explanation');
    assert.equal(failed.status, 'failed', 'the status must reach the client, or it cannot render differently');
  });

  test('still shows ready recordings, and shows BOTH — not one instead of the other', () => {
    assert.deepEqual(listed(), VISIBLE.slice().sort());
  });

  test('hides the two LIVE statuses, which resolve within seconds', () => {
    // 'recording' and 'pending' are in-flight: showing them would put a row on screen that is about to
    // change under the reader, and a pending row has no media yet either. This is the half that keeps
    // the fix from becoming "show everything".
    const shown = listed();
    for (const live of ['recording', 'pending']) {
      assert.ok(!shown.includes(live), `a live '${live}' row is being shown as if it were finished`);
    }
  });

  test('a failed WAKE clip stays out of the manual Recordings card', () => {
    // kind='manual' is the only thing keeping it out, and #276 widened the status set, so a failed wake
    // clip would otherwise land here. Wake clips have their own surface on the sleep detail page.
    const ids = listChildRecordings(CHILD).map((r) => r.id);
    assert.ok(!ids.includes(ID.wake), 'a wake clip is showing in the manual recordings card');
  });

  test('another child’s failed recording does not appear on this child’s page', () => {
    const ids = listChildRecordings(CHILD).map((r) => r.id);
    assert.ok(!ids.includes(ID.otherChild), 'recordings are leaking across children');
    // ...and it IS visible on its own child's page, so this is scoping and not a blanket exclusion.
    assert.deepEqual(listChildRecordings(OTHER_CHILD).map((r) => r.id), [ID.otherChild]);
  });

  test('the row carries what the card needs to explain itself', () => {
    // Without these the UI can only say "something failed" with no when or which — see #276: the
    // complaint is precisely that the user is told nothing.
    const failed = listChildRecordings(CHILD).find((r) => r.id === ID.failed);
    assert.equal(failed.started_at, '2026-09-04 10:00:00');
    assert.equal(failed.camera_name, 'Visible Cam', 'the join no longer supplies the camera name');
  });
});

describe('a failed recording is shown but NOT servable', () => {
  // ⚠️ THE HALF THAT MUST NOT REGRESS. Widening the list query is one character away from widening
  // these too, and that would hand out a path to a file that is missing or truncated. The issue calls
  // this out explicitly: "that guard must stay".
  test('its video is refused EVEN THOUGH the file is sitting right there', () => {
    // The file exists on disk (see seed) precisely so this cannot pass by accident: what refuses it is
    // the status, not a missing file.
    assert.ok(fs.existsSync(path.join(CLIPS_DIR, CAM, 'rec-failed.mp4')), 'the fixture file is missing — this proves nothing');
    assert.equal(getRecordingVideoFile(ID.failed), null, 'a failed recording is being served as video');
  });

  test('its thumbnail is refused, and that file is really there too', () => {
    // ⚠️ THE SAME TRIPWIRE AS THE VIDEO CASE, and its absence was a real gap: adversarial review of #276
    // removed the .jpg fixture writes AND deleted the status guard from getRecordingThumbFile, and this
    // case still passed — jailedFile() returns null for a missing file just as it does for a bad status.
    // The video half had this assertion from the start; it simply was not carried one function across.
    assert.ok(fs.existsSync(path.join(CLIPS_DIR, CAM, 'rec-failed.jpg')), 'the fixture file is missing — this proves nothing');
    assert.equal(getRecordingThumbFile(ID.failed), null, 'a failed recording is being served as a thumbnail');
  });

  test('a READY thumbnail IS still served — the control the thumb guard was missing', () => {
    // ★ Without this, getRecordingThumbFile could be made to return null for EVERYTHING — every
    // thumbnail on the strip 404s — and all 490 tests passed. Demonstrated by review of #276. The video
    // half had its control; this one did not, so the guard was pinned in one direction only.
    assert.ok(getRecordingThumbFile(ID.ready), 'a READY thumbnail is no longer servable — the strip would show nothing');
  });

  test('and so are the live ones, while a ready one is still served', () => {
    // The control: if 'ready' were refused too, the guards would be passing for the wrong reason and
    // these tests would look green while the feature was broken.
    for (const status of ['recording', 'pending']) {
      assert.equal(getRecordingVideoFile(ID[status]), null, `'${status}' is being served`);
    }
    assert.ok(getRecordingVideoFile(ID.ready), 'a READY recording is no longer servable — the guard is too tight');
  });
});
