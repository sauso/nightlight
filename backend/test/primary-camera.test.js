// An explicit primary camera per child (#655): lib/primaryCamera.js, and the night scored from it.
//
// ★ WHY THIS FILE EXISTS. Before #655 a child's night was scored from "the first enabled camera in
// sort_order", and sort_order is the order of the Live tiles, so dragging a tile silently changed which
// camera a stored sleep number came from. A child can now name one (children.primary_camera_id). Two
// properties carry the whole change, and each has a test here that fails without it:
//   1. NULL (the default, every pre-#655 child) is BYTE-IDENTICAL to the old rule, tie-break included.
//      The scoring query broke a sort_order tie by `id` and the timelapse sampler by `rowid`; unifying
//      them would quietly move one. Hence the tie fixtures below, whose id order and rowid order DISAGREE
//      (a fixture where they agree cannot tell the two apart).
//   2. A named camera counts only while it is still THIS child's and still enabled. The hostile fixture
//      points a child at another child's camera; the resolver must never hand it back.
//
// ⚠️ NOT validated against real data here: the A/B (old code vs new on the prod and staging snapshots,
// fixed clock, primary NULL) is run separately before merge; see the PR. These tests are what kills a
// regression in CI.
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nightlight-primarycam-'));
process.env.DATA_DIR = TMP;

const { computeNight } = await import('../src/lib/sleepAnalysis.js');
const { primaryCameraRowFor } = await import('../src/lib/primaryCamera.js');
const { default: db } = await import('../src/db.js');

const CHILD = 'pc-child';
const OTHER = 'pc-other-child';
const DATE = '2026-07-01';
const TZ = 'Australia/Melbourne'; // UTC+10 in July, no DST edge to reason about (any zone would do)
const TZ_OFF = 10 * 3600 * 1000;

const at = (h, m, dayShift = 0) => new Date(Date.UTC(2026, 6, 1 + dayShift, h, m) - TZ_OFF);
const sqlTime = (d) => d.toISOString().slice(0, 19).replace('T', ' ').replace(/:\d\d$/, ':00');

const insertFull = db.prepare(
  `INSERT INTO activity_samples (camera_id, bucket_start, motion_level, motion_peak, sound_level,
     sound_peak, motion_frames, sound_windows, motion_out_level, motion_out_peak)
   VALUES (?, ?, ?, ?, 0, ?, 1, 1, 0, ?)`
);
const insertTransition = db.prepare(
  'INSERT INTO bed_transitions (camera_id, type, peak, created_at) VALUES (?, ?, ?, ?)'
);
const addCam = (id, name, sortOrder, { child = CHILD, disabled = 0 } = {}) =>
  db.prepare(
    `INSERT INTO cameras (id, name, rtsp_url, child_id, mediamtx_path, sort_order, disabled)
     VALUES (?, ?, 'rtsp://example/x', ?, ?, ?, ?)`
  ).run(id, name, child, `path_${id}`, sortOrder, disabled);
const setPrimary = (camId, child = CHILD) =>
  db.prepare('UPDATE children SET primary_camera_id = ? WHERE id = ?').run(camId, child);

const STILL = 0.004; // quiet, but plainly an occupied bed (see OCCUPANCY_MIN_PEAK)

function lay(cam, from, to, move) {
  const within = (t) => move.some(([a, b]) => t >= a && t < b);
  for (let t = from; t < to; t = new Date(t.getTime() + 60000)) {
    insertFull.run(cam, sqlTime(t), within(t) ? 0.4 : STILL, within(t) ? 0.4 : STILL, 0.5, 0.0004);
  }
}
// Two DIFFERENT nights, one per camera, so a test can tell from the numbers alone which camera scored.
// Camera "early": settles 19:40. Camera "late": busy until 21:10, then settles.
function earlyNightOn(cam) {
  lay(cam, at(18, 20), at(7, 0, 1), [[at(19, 30), at(19, 40)], [at(6, 0, 1), at(6, 20, 1)]]);
  insertTransition.run(cam, 'into_bed', 0.12, sqlTime(at(19, 38)));
}
function lateNightOn(cam) {
  lay(cam, at(18, 20), at(7, 0, 1), [[at(19, 30), at(21, 10)], [at(6, 0, 1), at(6, 20, 1)]]);
  insertTransition.run(cam, 'into_bed', 0.12, sqlTime(at(21, 8)));
}
const METRICS = ['status', 'onset_at', 'wake_at', 'in_bed_at', 'asleep_minutes', 'awake_minutes',
  'unknown_minutes', 'wake_count', 'longest_stretch_minutes', 'coverage_minutes', 'analysis_camera_id',
  'analysis_camera_name'];
const pick = (n) => Object.fromEntries(METRICS.map((k) => [k, n[k]]));

before(() => {
  db.prepare(`INSERT INTO settings (id, timezone) VALUES ('app', ?)
              ON CONFLICT(id) DO UPDATE SET timezone = excluded.timezone`).run(TZ);
  db.prepare(`INSERT INTO children (id, name, track_sleep, sleep_window_start, sleep_window_end)
              VALUES (?, 'A child', 1, '19:30', '07:00')`).run(CHILD);
  db.prepare(`INSERT INTO children (id, name, track_sleep, sleep_window_start, sleep_window_end)
              VALUES (?, 'Another child', 1, '19:30', '07:00')`).run(OTHER);
});

beforeEach(() => {
  db.prepare('DELETE FROM activity_samples').run();
  db.prepare('DELETE FROM bed_transitions').run();
  db.prepare('DELETE FROM cameras').run();
  db.prepare('UPDATE children SET primary_camera_id = NULL').run();
});

after(() => {
  db.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('primaryCameraRowFor: which camera is the primary', () => {
  test('NULL primary: the first enabled camera in sort_order (the pre-#655 rule)', () => {
    addCam('cam-b', 'Second', 1);
    addCam('cam-a', 'First', 0);
    assert.equal(primaryCameraRowFor(CHILD).id, 'cam-a');
  });

  test('a named primary wins over sort_order, and the full row comes back', () => {
    addCam('cam-a', 'First', 0);
    addCam('cam-b', 'Second', 1);
    setPrimary('cam-b');
    assert.deepEqual(primaryCameraRowFor(CHILD), {
      id: 'cam-b', name: 'Second', mediamtx_path: 'path_cam-b', snapshot_url: null,
    });
    assert.equal(primaryCameraRowFor(CHILD, { tieBreak: 'rowid' }).id, 'cam-b', 'both callers honour it');
  });

  test('★ a turned-off primary falls back, and turning it back on revives it (the pointer is kept)', () => {
    addCam('cam-a', 'First', 0);
    addCam('cam-b', 'Second', 1);
    setPrimary('cam-b');
    db.prepare("UPDATE cameras SET disabled = 1 WHERE id = 'cam-b'").run();
    assert.equal(primaryCameraRowFor(CHILD).id, 'cam-a', 'a disabled camera has no fresh samples');
    db.prepare("UPDATE cameras SET disabled = 0 WHERE id = 'cam-b'").run();
    assert.equal(primaryCameraRowFor(CHILD).id, 'cam-b', 're-enabling must revive the admin\'s choice');
  });

  test('a deleted primary falls back', () => {
    addCam('cam-a', 'First', 0);
    addCam('cam-b', 'Second', 1);
    setPrimary('cam-b');
    db.prepare("DELETE FROM cameras WHERE id = 'cam-b'").run();
    assert.equal(primaryCameraRowFor(CHILD).id, 'cam-a');
  });

  test('★ a primary moved to another child falls back, even with the pointer left behind', () => {
    // Written straight to the DB, as a restore of an old database or any path other than the camera
    // routes (which clear the pointer) would leave it.
    addCam('cam-a', 'First', 0);
    addCam('cam-b', 'Second', 1);
    setPrimary('cam-b');
    db.prepare("UPDATE cameras SET child_id = ? WHERE id = 'cam-b'").run(OTHER);
    assert.equal(primaryCameraRowFor(CHILD).id, 'cam-a');
  });

  test('★★ hostile: a child pointed at ANOTHER child\'s camera never gets it back', () => {
    // The other child's camera sorts first globally and is enabled, so a resolver that checked only
    // `disabled` (not `child_id`) would hand it back. This child's own camera sorts last on purpose.
    addCam('cam-theirs', 'Their camera', 0, { child: OTHER });
    addCam('cam-mine', 'My camera', 9);
    setPrimary('cam-theirs');
    assert.equal(primaryCameraRowFor(CHILD).id, 'cam-mine');
    // And with no camera of its own, null rather than the other child's.
    db.prepare("DELETE FROM cameras WHERE id = 'cam-mine'").run();
    assert.equal(primaryCameraRowFor(CHILD), null);
    // The other child is unaffected: it has no primary of its own and gets its camera by sort_order.
    assert.equal(primaryCameraRowFor(OTHER).id, 'cam-theirs');
  });

  test('a child with no enabled camera gets null, with or without a primary', () => {
    assert.equal(primaryCameraRowFor(CHILD), null);
    addCam('cam-a', 'First', 0, { disabled: 1 });
    setPrimary('cam-a');
    assert.equal(primaryCameraRowFor(CHILD), null);
  });

  test('★ a sort_order tie: scoring breaks it by id, the timelapse by rowid, as each did before #655', () => {
    // Inserted z first: rowid order is (z, a), id order is (a, z). They disagree, so each caller's
    // tie-break is visible.
    addCam('cam-z', 'Zed', 0);
    addCam('cam-a', 'Ay', 0);
    assert.equal(primaryCameraRowFor(CHILD, { tieBreak: 'id' }).id, 'cam-a');
    assert.equal(primaryCameraRowFor(CHILD, { tieBreak: 'rowid' }).id, 'cam-z');
    assert.equal(primaryCameraRowFor(CHILD).id, 'cam-a', 'the default is scoring\'s tie-break');
  });

  test('an unknown tie-break throws rather than picking some third order', () => {
    assert.throws(() => primaryCameraRowFor(CHILD, { tieBreak: 'created_at' }), /unknown tieBreak/);
  });
});

describe('the night is scored from the primary camera', () => {
  test('★★ THE ISSUE: with a primary set, swapping the tile order does not move the night', () => {
    // sort_order is written exactly as PUT /api/cameras/reorder writes it (one UPDATE per camera).
    addCam('cam-early', 'Early cam', 0);
    addCam('cam-late', 'Late cam', 1);
    earlyNightOn('cam-early');
    lateNightOn('cam-late');
    setPrimary('cam-late');

    const before = pick(computeNight(CHILD, DATE));
    db.prepare("UPDATE cameras SET sort_order = 1 WHERE id = 'cam-early'").run();
    db.prepare("UPDATE cameras SET sort_order = 0 WHERE id = 'cam-late'").run();
    const after = pick(computeNight(CHILD, DATE));

    assert.equal(before.status, 'ok');
    assert.equal(before.analysis_camera_id, 'cam-late');
    assert.deepEqual(after, before, 'the drag changed the night');
  });

  test('★ the control: with NO primary, the tile order still decides (unchanged pre-#655 behaviour)', () => {
    // Without this the test above would pass against a fixture where both cameras score alike.
    addCam('cam-early', 'Early cam', 0);
    addCam('cam-late', 'Late cam', 1);
    earlyNightOn('cam-early');
    lateNightOn('cam-late');

    const earlyFirst = pick(computeNight(CHILD, DATE));
    db.prepare("UPDATE cameras SET sort_order = 1 WHERE id = 'cam-early'").run();
    db.prepare("UPDATE cameras SET sort_order = 0 WHERE id = 'cam-late'").run();
    const lateFirst = pick(computeNight(CHILD, DATE));

    assert.equal(earlyFirst.analysis_camera_id, 'cam-early');
    assert.equal(lateFirst.analysis_camera_id, 'cam-late');
    assert.notEqual(earlyFirst.onset_at, lateFirst.onset_at, 'the two cameras must score differently');
  });

  test('a named primary scores exactly as that camera would alone', () => {
    // "Same numbers", stated directly: the primary's night with the other camera present equals the
    // night with only the primary assigned, so nothing from the other camera leaks in.
    addCam('cam-late', 'Late cam', 0);
    lateNightOn('cam-late');
    const alone = pick(computeNight(CHILD, DATE));

    addCam('cam-early', 'Early cam', -1); // sorts FIRST
    earlyNightOn('cam-early');
    setPrimary('cam-late');
    assert.deepEqual(pick(computeNight(CHILD, DATE)), alone);
  });

  test('★ a turned-off primary scores from the fallback, and so is not a night lost', () => {
    addCam('cam-early', 'Early cam', 0);
    addCam('cam-late', 'Late cam', 1, { disabled: 1 });
    earlyNightOn('cam-early');
    lateNightOn('cam-late');
    setPrimary('cam-late');
    const night = computeNight(CHILD, DATE);
    assert.equal(night.status, 'ok');
    assert.equal(night.analysis_camera_id, 'cam-early');
  });

  test('★ NULL primary, a sort_order tie: scoring still breaks it by id (byte-identical to pre-#655)', () => {
    // rowid order (z, a) disagrees with id order (a, z); see the resolver test above. Only cam-a has a
    // night, so a scorer that broke the tie by rowid would pick cam-z and report no_data.
    addCam('cam-z', 'Zed', 0);
    addCam('cam-a', 'Ay', 0);
    earlyNightOn('cam-a');
    const night = computeNight(CHILD, DATE);
    assert.equal(night.analysis_camera_id, 'cam-a');
    assert.equal(night.status, 'ok');
  });
});
