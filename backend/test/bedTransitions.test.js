// bed_transitions: the durable record of a child leaving or being put into the bed.
//
// EXTENDS `bed-transition-snapshots.test.js`, which already covers recording, the snapshot lifecycle
// and the age sweep. This file adds the parts that were NOT covered: report ordering and its limit,
// verdicts, the judged-row exemption, and the path-traversal guard. Fixing a bug in this module will
// usually mean looking at both files.
//
// Why it matters more than its size suggests: sleepAnalysis.js reads these rows to correct sleep onset
// and morning wake, and `getImpossibleTransitions` is the report the detector gets judged by. A defect
// here is invisible in the app and corrupts the measurement everything else is scored against — which
// is exactly what happened (see the ordering test below).
//
// Invariants worth pinning hard:
//   * `getImpossibleTransitions` must be newest-first ACROSS CAMERAS, or the limit hides a whole child.
//   * A pair is only a pair WITHIN one camera. Two children are not evidence about each other.
//   * A JUDGED transition is exempt from the age sweep — a human label is the scarce thing here.
//   * Snapshot paths are derived from an integer id only, so no row can escape the snapshot directory.
import { test, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { useTempDataDir, cleanupTempDataDirs, makeCamera } from './helpers/harness.js';

useTempDataDir();

const { default: db } = await import('../src/db.js');
const bt = await import('../src/lib/bedTransitions.js');
const { logger } = await import('../src/lib/logger.js');

const SNAPSHOT_DIR = path.join(process.env.DATA_DIR, 'transition-snapshots');

// Insert a row directly so the test controls `created_at` — recordBedTransition() stamps "now", which
// cannot express "this happened five days ago".
function seed(cameraId, type, createdAt, { peak = null, verdict = null, snapshot = 0 } = {}) {
  return db
    .prepare(
      `INSERT INTO bed_transitions (camera_id, type, created_at, peak, verdict, snapshot)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(cameraId, type, createdAt, peak, verdict, snapshot).lastInsertRowid;
}

const insertActivity = db.prepare(
  `INSERT INTO activity_samples (camera_id, bucket_start, motion_level, motion_peak, sound_level,
     sound_peak, motion_frames, sound_windows) VALUES (?, ?, ?, ?, 0, 0, 1, 0)`
);
function seedActivity(cameraId, bucketStart, motionPeak = 0.02) {
  insertActivity.run(cameraId, bucketStart, motionPeak, motionPeak);
}

const daysAgo = (n) =>
  new Date(Date.now() - n * 86400e3).toISOString().slice(0, 19).replace('T', ' ');

before(() => {
  makeCamera(db, { id: 'cam-a', name: 'Camera A' });
  makeCamera(db, { id: 'cam-b', name: 'Camera B' });
});
after(() => { db.close(); cleanupTempDataDirs(); });
beforeEach(() => {
  db.prepare('DELETE FROM bed_transitions').run();
  db.prepare('DELETE FROM activity_samples').run();
});

// --- recording --------------------------------------------------------------------------------

test('recordBedTransition stores the row and returns its id', () => {
  const id = bt.recordBedTransition('cam-a', bt.TRANSITION.OUT_OF_BED, 0.25);
  assert.ok(Number.isInteger(Number(id)) && Number(id) > 0);
  const row = db.prepare('SELECT * FROM bed_transitions WHERE id = ?').get(id);
  assert.equal(row.camera_id, 'cam-a');
  assert.equal(row.type, 'out_of_bed');
  assert.equal(row.verdict, null, 'a new transition carries no human judgement');
});

test('peak is rounded to three decimals, and null stays null', () => {
  const a = bt.recordBedTransition('cam-a', bt.TRANSITION.INTO_BED, 0.123456);
  assert.equal(db.prepare('SELECT peak FROM bed_transitions WHERE id = ?').get(a).peak, 0.123);
  const b = bt.recordBedTransition('cam-a', bt.TRANSITION.INTO_BED, null);
  assert.equal(db.prepare('SELECT peak FROM bed_transitions WHERE id = ?').get(b).peak, null);
});

test('outPeak/outFrames (ROADMAP §1.2 item 2 evidence) round-trip, rounded the same way peak is', () => {
  const id = bt.recordBedTransition('cam-a', bt.TRANSITION.OUT_OF_BED, 0.25, {
    outPeak: 0.057123, outFrames: 4.6,
  });
  const row = db.prepare('SELECT out_peak, out_frames FROM bed_transitions WHERE id = ?').get(id);
  assert.equal(row.out_peak, 0.057, 'rounded to three decimals like peak');
  assert.equal(row.out_frames, 5, 'frame counts round to whole frames');
});

test('omitting the evidence options object stores NULL, same as before this column existed', () => {
  const id = bt.recordBedTransition('cam-a', bt.TRANSITION.INTO_BED, 0.1);
  const row = db.prepare('SELECT out_peak, out_frames FROM bed_transitions WHERE id = ?').get(id);
  assert.equal(row.out_peak, null);
  assert.equal(row.out_frames, null);
});

test('a failed insert returns null instead of throwing into the detector', () => {
  // recordBedTransition is called from the frame loop several times a second. Whatever goes wrong, it
  // must degrade to "no transition recorded" rather than take the detector down with it.
  assert.equal(bt.recordBedTransition({ not: 'a camera id' }, bt.TRANSITION.INTO_BED, 0.1), null);
});

test('snapshot capture never breaks the transition it belongs to', async () => {
  // Deliberately fire-and-forget: a camera that is slow or unreachable must not delay the detector,
  // and a transition with no picture is still a perfectly good transition.
  makeCamera(db, { id: 'cam-dead', name: 'Unreachable', extra: { snapshot_url: 'http://127.0.0.1:9/none' } });
  const id = bt.recordBedTransition('cam-dead', bt.TRANSITION.OUT_OF_BED, 0.2);
  assert.ok(id, 'the row is written even though the image cannot be fetched');
  await new Promise((r) => setTimeout(r, 120)); // let the un-awaited capture settle
  assert.equal(db.prepare('SELECT snapshot FROM bed_transitions WHERE id = ?').get(id).snapshot, 0);
});

test('a reachable camera URL attaches the frame and marks the row', async () => {
  // The whole point of capturing: the detector says WHEN it thinks the bed changed, and the frame is
  // the only way to see what it was looking at when it decided.
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'image/jpeg' });
    res.end(Buffer.from('fake-jpeg-bytes'));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  makeCamera(db, { id: 'cam-http', name: 'Snapshotter', extra: { snapshot_url: `http://127.0.0.1:${port}/snap` } });

  const id = bt.recordBedTransition('cam-http', bt.TRANSITION.OUT_OF_BED, 0.4);
  for (let i = 0; i < 40 && !db.prepare('SELECT snapshot FROM bed_transitions WHERE id = ?').get(id).snapshot; i++) {
    await new Promise((r) => setTimeout(r, 25));
  }
  await new Promise((r) => server.close(r));

  assert.equal(db.prepare('SELECT snapshot FROM bed_transitions WHERE id = ?').get(id).snapshot, 1);
  assert.equal(fs.readFileSync(path.join(SNAPSHOT_DIR, `${id}.jpg`), 'utf8'), 'fake-jpeg-bytes');
  assert.equal(bt.transitionSnapshotPath(id), path.join(SNAPSHOT_DIR, `${id}.jpg`));
});

test('a camera with only a stream path records the transition and ends with no snapshot', async () => {
  // ⚠️ This does NOT discriminate the ffmpeg fallback itself. `captureSnapshot` only ever RESOLVES
  // (never rejects), and there is no stream or ffmpeg here, so deleting the fallback line entirely
  // produces the same observable result: snapshot stays 0. Verifying that the fallback is actually
  // attempted needs an injection seam this module does not have — noted rather than faked, since a
  // test that cannot fail is worse than no test.
  makeCamera(db, { id: 'cam-mtx', name: 'Stream only', path: 'cam-mtx-path' });
  const id = bt.recordBedTransition('cam-mtx', bt.TRANSITION.INTO_BED, 0.5);
  assert.ok(id, 'the transition is recorded regardless');
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(db.prepare('SELECT snapshot FROM bed_transitions WHERE id = ?').get(id).snapshot, 0);
});

test('a transition for an unknown camera skips the snapshot cleanly, without throwing', async () => {
  // The `if (!cam) return` guard is what makes this clean. Without it, `cam.snapshot_url` throws a
  // TypeError that the outer catch swallows and LOGS — same snapshot=0 either way, so asserting only
  // on the row would pass with the guard removed. Watching the log is what separates "skipped" from
  // "threw and was swallowed".
  const failures = [];
  const spy = mock.method(logger, 'info', (msg) => { failures.push(String(msg)); });
  try {
    const id = bt.recordBedTransition('cam-does-not-exist', bt.TRANSITION.INTO_BED, 0.3);
    assert.ok(id);
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(db.prepare('SELECT snapshot FROM bed_transitions WHERE id = ?').get(id).snapshot, 0);
    assert.equal(
      failures.filter((m) => /snapshot for transition .* failed/.test(m)).length,
      0,
      'nothing failed — the unknown camera was recognised and skipped, not blundered into'
    );
  } finally {
    spy.mock.restore();
  }
});

// --- reading a window -------------------------------------------------------------------------

test('getBedTransitions is empty for no cameras', () => {
  assert.deepEqual(bt.getBedTransitions([], '2026-01-01 00:00:00', '2026-01-02 00:00:00'), []);
  assert.deepEqual(bt.getBedTransitions(null, '2026-01-01 00:00:00', '2026-01-02 00:00:00'), []);
});

test('getBedTransitions is half-open [start, end) and ascending', () => {
  seed('cam-a', 'into_bed', '2026-03-01 09:59:59');   // before the window
  const atStart = seed('cam-a', 'out_of_bed', '2026-03-01 10:00:00'); // included
  const mid = seed('cam-a', 'into_bed', '2026-03-01 11:00:00');
  seed('cam-a', 'out_of_bed', '2026-03-01 12:00:00'); // == end, excluded
  const rows = bt.getBedTransitions(['cam-a'], '2026-03-01 10:00:00', '2026-03-01 12:00:00');
  assert.deepEqual(rows.map((r) => r.id), [atStart, mid]);
});

test('getBedTransitions surfaces the outside-evidence columns', () => {
  const id = bt.recordBedTransition('cam-a', bt.TRANSITION.OUT_OF_BED, 0.2, { outPeak: 0.06, outFrames: 3 });
  const [row] = bt.getBedTransitions(['cam-a'], '2000-01-01 00:00:00', '2100-01-01 00:00:00');
  assert.equal(row.id, id);
  assert.equal(row.out_peak, 0.06);
  assert.equal(row.out_frames, 3);
});

test('getBedTransitions spans several cameras but not others', () => {
  seed('cam-a', 'into_bed', '2026-03-01 10:00:00');
  seed('cam-b', 'into_bed', '2026-03-01 10:30:00');
  const both = bt.getBedTransitions(['cam-a', 'cam-b'], '2026-03-01 00:00:00', '2026-03-02 00:00:00');
  assert.equal(both.length, 2);
  const onlyA = bt.getBedTransitions(['cam-a'], '2026-03-01 00:00:00', '2026-03-02 00:00:00');
  assert.deepEqual(onlyA.map((r) => r.camera_id), ['cam-a']);
});

// --- impossible pairs -------------------------------------------------------------------------

test('an impossible pair is the same type twice in a row, and names what it contradicts', () => {
  const first = seed('cam-a', 'into_bed', '2026-03-01 10:00:00');
  const second = seed('cam-a', 'into_bed', '2026-03-01 10:05:00');
  const rows = bt.getImpossibleTransitions();
  assert.equal(rows.length, 1, 'the SECOND of the pair is reported, not both');
  assert.equal(rows[0].id, second);
  assert.equal(rows[0].contradicts, first);
  assert.equal(rows[0].contradicts_at, '2026-03-01 10:00:00');
  assert.equal(rows[0].camera_name, 'Camera A', 'the report is read by a human, so it carries the name');
});

test('alternating types are possible and are never reported', () => {
  seed('cam-a', 'into_bed', '2026-03-01 10:00:00');
  seed('cam-a', 'out_of_bed', '2026-03-01 10:05:00');
  seed('cam-a', 'into_bed', '2026-03-01 10:10:00');
  assert.deepEqual(bt.getImpossibleTransitions(), []);
});

test('two cameras are never paired with each other', () => {
  // Same type, adjacent in time, but different rooms — one child being put down says nothing about
  // the other. If the scan ignored camera_id this would read as an impossible pair.
  seed('cam-a', 'into_bed', '2026-03-01 10:00:00');
  seed('cam-b', 'into_bed', '2026-03-01 10:01:00');
  assert.deepEqual(bt.getImpossibleTransitions(), []);
});

// ★ THE REGRESSION TEST. Before the fix this function ordered by (camera_id, created_at), reversed,
// then sliced — so the slice removed whole CAMERAS instead of old rows. With the limit reached, one
// child vanished from the report entirely. Measured at ~197 pairs against a limit of 200 on
// 2026-08-31, i.e. days from happening for real, and it would have silently corrupted the day-10
// scoring of the zone repaint. This test fails against the old implementation on BOTH assertions.
test('impossible pairs are newest-first ACROSS cameras, so the limit never hides a child', () => {
  // cam-b sorts first by camera_id and owns the two OLDER pairs; cam-a owns the single NEWEST one.
  //
  // cam-a is seeded FIRST on purpose, so its row carries the LOWEST id while holding the LATEST
  // timestamp. That makes id order and time order disagree, which kills a plausible wrong fix —
  // sorting by id instead of created_at looks identical on live data (ids are handed out in time
  // order) and is wrong the moment rows are backfilled or a clock moves.
  seed('cam-a', 'into_bed', '2026-03-01 11:00:00');
  const aNewest = seed('cam-a', 'into_bed', '2026-03-01 11:05:00');
  seed('cam-b', 'out_of_bed', '2026-03-01 10:00:00');
  const bOld = seed('cam-b', 'out_of_bed', '2026-03-01 10:05:00');
  const bNew = seed('cam-b', 'out_of_bed', '2026-03-01 10:10:00');

  const limited = bt.getImpossibleTransitions({ limit: 2 });
  assert.equal(limited.length, 2);
  assert.equal(limited[0].id, aNewest, 'the newest pair overall must come first, whichever camera it is');
  assert.ok(
    limited.some((r) => r.camera_id === 'cam-a'),
    'a camera must never be dropped wholesale just because another camera filled the limit'
  );

  // Unlimited, the order is strictly newest-first over the whole set rather than grouped by camera.
  const all = bt.getImpossibleTransitions();
  assert.deepEqual(all.map((r) => r.id), [aNewest, bNew, bOld]);
});

test('rows sharing a timestamp are ordered by id, newest first', () => {
  // Two cameras can fire inside the same second. Without a tie-break the sort is not total and the
  // page order can shift between calls on identical data, which makes a paged report untrustworthy.
  seed('cam-a', 'into_bed', '2026-03-01 10:00:00');
  const a = seed('cam-a', 'into_bed', '2026-03-01 10:05:00');
  seed('cam-b', 'out_of_bed', '2026-03-01 10:00:00');
  const b = seed('cam-b', 'out_of_bed', '2026-03-01 10:05:00');
  assert.ok(b > a, 'cam-b was seeded second, so it holds the higher id');
  assert.deepEqual(bt.getImpossibleTransitions().map((r) => r.id), [b, a]);
});

test('limit has a floor of 1', () => {
  for (let i = 0; i < 4; i++) seed('cam-a', 'into_bed', `2026-03-01 10:0${i}:00`);
  assert.equal(bt.getImpossibleTransitions({ limit: 0 }).length, 1, '0 would otherwise return nothing');
  assert.equal(bt.getImpossibleTransitions({ limit: -5 }).length, 1);
});

test('limit is capped at 500 however many pairs exist, and however large the ask', () => {
  // Seeded past the cap on purpose. The previous version of this test named the 500 cap while seeding
  // three pairs, so `Math.min(500, …)` could be widened to 5000 and it still passed — the test asserted
  // "there are only 3", which says nothing about the cap. That is the same defect this repo has shipped
  // before: a test whose NAME states the invariant while its fixture cannot reach it.
  const insert = db.prepare(
    `INSERT INTO bed_transitions (camera_id, type, created_at) VALUES ('cam-a', 'into_bed', ?)`
  );
  db.transaction(() => {
    // 520 identical-type rows in a row => 519 impossible pairs, comfortably past the cap.
    for (let i = 0; i < 520; i++) {
      insert.run(`2026-04-01 ${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00`);
    }
  })();
  assert.equal(bt.getImpossibleTransitions({ limit: 9999 }).length, 500, 'the ask is capped at 500');
  assert.equal(bt.getImpossibleTransitions({ limit: 400 }).length, 400, 'a smaller ask is honoured');
});

// --- quick reversals (into_bed immediately undone by out_of_bed) --------------------------------
//
// Measured 2026-09-13: 86 of 1053 stored transitions match this shape, and both a visual snapshot
// sample and the bed zone's own subsequent motion point the same way — a parent's presence, not a
// child getting straight back up. See getQuickReversals's own comment for the full evidence. This is
// a query only; nothing acts on it yet.

test('an into_bed immediately followed by an out_of_bed, same camera, is reported', () => {
  const ib = seed('cam-a', 'into_bed', '2026-03-01 19:51:00');
  const oob = seed('cam-a', 'out_of_bed', '2026-03-01 19:51:14');
  const rows = bt.getQuickReversals();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].into_bed.id, ib);
  assert.equal(rows[0].out_of_bed.id, oob);
  assert.equal(rows[0].gap_ms, 14000);
});

test('the reverse order (out_of_bed then into_bed) is never reported — only a real entry can be undone', () => {
  seed('cam-a', 'out_of_bed', '2026-03-01 05:40:00');
  seed('cam-a', 'into_bed', '2026-03-01 05:40:10');
  assert.deepEqual(bt.getQuickReversals(), []);
});

test('two of the same type in a row is never reported — that is getImpossibleTransitions territory', () => {
  seed('cam-a', 'into_bed', '2026-03-01 19:51:00');
  seed('cam-a', 'into_bed', '2026-03-01 19:51:10');
  assert.deepEqual(bt.getQuickReversals(), []);
});

test('the default 60s window: inclusive at the boundary, excluded just past it', () => {
  seed('cam-a', 'into_bed', '2026-03-01 10:00:00');
  const atBoundary = seed('cam-a', 'out_of_bed', '2026-03-01 10:01:00'); // exactly 60000ms
  assert.deepEqual(bt.getQuickReversals().map((r) => r.out_of_bed.id), [atBoundary]);

  db.prepare('DELETE FROM bed_transitions').run();
  seed('cam-a', 'into_bed', '2026-03-01 10:00:00');
  seed('cam-a', 'out_of_bed', '2026-03-01 10:01:01'); // 61000ms — one second past
  assert.deepEqual(bt.getQuickReversals(), []);
});

test('maxGapMs is configurable', () => {
  seed('cam-a', 'into_bed', '2026-03-01 10:00:00');
  seed('cam-a', 'out_of_bed', '2026-03-01 10:00:05'); // 5s later
  assert.equal(bt.getQuickReversals({ maxGapMs: 3000 }).length, 0, 'narrower than the actual gap');
  assert.equal(bt.getQuickReversals({ maxGapMs: 10000 }).length, 1, 'wider than the actual gap');
});

test('two cameras are never paired with each other', () => {
  seed('cam-a', 'into_bed', '2026-03-01 10:00:00');
  seed('cam-b', 'out_of_bed', '2026-03-01 10:00:05');
  assert.deepEqual(bt.getQuickReversals(), []);
});

test('a non-adjacent into_bed/out_of_bed pair (something else happened between them) is not reported', () => {
  seed('cam-a', 'into_bed', '2026-03-01 10:00:00');
  seed('cam-a', 'out_of_bed', '2026-03-01 10:00:05');
  seed('cam-a', 'into_bed', '2026-03-01 10:00:10'); // now the PREVIOUS row is out_of_bed, not into_bed
  const rows = bt.getQuickReversals();
  assert.equal(rows.length, 1, 'only the genuine adjacent pair counts');
});

test('reversals are newest-first ACROSS cameras, and the limit never drops a whole camera', () => {
  // Mirrors getImpossibleTransitions' own regression test SHAPE, not just its cast: cam-a (sorts
  // first, and is scanned first since the SQL orders by camera_id) holds THREE older pairs; cam-b
  // (scanned second) holds the single NEWEST pair. This is deliberately NOT "one pair each" — an
  // earlier version of this test used one pair per camera, and because the alphabetically-first
  // camera happened to also hold the chronologically newer pair, it kept passing even with the
  // anti-camera-drop `.sort()` deleted entirely (found in adversarial review, 2026-09-13: the test
  // proved nothing about the property it was named for). With cam-a holding MULTIPLE older pairs,
  // the raw per-camera scan order is [cam-a-old×3, cam-b-newest] — slicing THAT directly at limit 2
  // returns two cam-a rows and drops cam-b, the camera holding the actual newest pair, wholesale.
  seed('cam-a', 'into_bed', '2026-03-01 09:00:00');
  const aOld1 = seed('cam-a', 'out_of_bed', '2026-03-01 09:00:05');
  seed('cam-a', 'into_bed', '2026-03-01 09:10:00');
  const aOld2 = seed('cam-a', 'out_of_bed', '2026-03-01 09:10:05');
  seed('cam-a', 'into_bed', '2026-03-01 09:20:00');
  const aOld3 = seed('cam-a', 'out_of_bed', '2026-03-01 09:20:05');
  seed('cam-b', 'into_bed', '2026-03-01 11:00:00');
  const bNewest = seed('cam-b', 'out_of_bed', '2026-03-01 11:00:05');

  const limited = bt.getQuickReversals({ limit: 2 });
  assert.equal(limited.length, 2);
  assert.equal(limited[0].out_of_bed.id, bNewest, 'the newest reversal overall must come first');
  assert.ok(
    limited.some((r) => r.out_of_bed.camera_id === 'cam-b'),
    'a camera must never be dropped wholesale just because another camera filled the limit'
  );

  const all = bt.getQuickReversals();
  assert.deepEqual(all.map((r) => r.out_of_bed.id), [bNewest, aOld3, aOld2, aOld1]);
});

test('reversals sharing a timestamp are ordered by id, newest first', () => {
  seed('cam-a', 'into_bed', '2026-03-01 10:00:00');
  const a = seed('cam-a', 'out_of_bed', '2026-03-01 10:00:05');
  seed('cam-b', 'into_bed', '2026-03-01 10:00:00');
  const b = seed('cam-b', 'out_of_bed', '2026-03-01 10:00:05');
  assert.ok(b > a);
  assert.deepEqual(bt.getQuickReversals().map((r) => r.out_of_bed.id), [b, a]);
});

test('limit has a floor of 1', () => {
  assert.equal(bt.getQuickReversals({ limit: 0 }).length, 0, 'no data seeded yet — floor does not invent rows');
  seed('cam-a', 'into_bed', '2026-03-01 10:00:00');
  seed('cam-a', 'out_of_bed', '2026-03-01 10:00:05');
  assert.equal(bt.getQuickReversals({ limit: 0 }).length, 1, '0 would otherwise return nothing');
  assert.equal(bt.getQuickReversals({ limit: -5 }).length, 1);
  assert.equal(bt.getQuickReversals({ limit: 9999 }).length, 1, 'never asks for more than exist');
});

test('a deleted camera does not silently drop its historical reversals — found in adversarial review', () => {
  makeCamera(db, { id: 'cam-gone', name: 'Gone Camera' });
  seed('cam-gone', 'into_bed', '2026-03-01 10:00:00');
  const oob = seed('cam-gone', 'out_of_bed', '2026-03-01 10:00:05');
  db.prepare('DELETE FROM cameras WHERE id = ?').run('cam-gone');

  const rows = bt.getQuickReversals();
  assert.equal(rows.length, 1, 'the row must not vanish just because its camera was deleted');
  assert.equal(rows[0].out_of_bed.id, oob);
  assert.equal(rows[0].out_of_bed.camera_name, 'cam-gone', 'falls back to the raw id with no camera row to name it');
});

test('limit is capped at 500 however many reversals exist, and however large the ask', () => {
  // Same standard getImpossibleTransitions holds itself to (see its own cap test above): the fixture
  // must actually pass the cap, not just assert a number small enough that Math.min(500, …) was never
  // exercised. 520 alternating into_bed/out_of_bed pairs, each 5s apart within its own minute so none
  // crosses the default 60s window into the NEXT pair.
  const insert = db.prepare(
    `INSERT INTO bed_transitions (camera_id, type, created_at) VALUES ('cam-a', ?, ?)`
  );
  db.transaction(() => {
    for (let i = 0; i < 520; i++) {
      const m = String(Math.floor(i / 60)).padStart(2, '0');
      const s = String(i % 60).padStart(2, '0');
      insert.run('into_bed', `2026-04-01 ${m}:${s}:00`);
      insert.run('out_of_bed', `2026-04-01 ${m}:${s}:05`);
    }
  })();
  assert.equal(bt.getQuickReversals({ limit: 9999 }).length, 500, 'the ask is capped at 500');
  assert.equal(bt.getQuickReversals({ limit: 400 }).length, 400, 'a smaller ask is honoured');
});

// --- lingering bed motion after out_of_bed -------------------------------------------------------

const seedActiveMinutes = (cameraId, ...bucketStarts) => {
  for (const bucketStart of bucketStarts) seedActivity(cameraId, bucketStart);
};

test('four distinct active minutes after an exit with no recorded return are reported', () => {
  const exit = seed('cam-a', 'out_of_bed', '2026-03-01 10:00:30');
  seedActiveMinutes('cam-a',
    '2026-03-01 10:01:00', '2026-03-01 10:02:00',
    '2026-03-01 10:03:00', '2026-03-01 10:04:00');
  const rows = bt.getLingeringBedMotion();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].out_of_bed.id, exit);
  assert.equal(rows[0].active_minutes, 4);
});

test('fewer than four active minutes are never reported', () => {
  seed('cam-a', 'out_of_bed', '2026-03-01 10:00:30');
  seedActiveMinutes('cam-a', '2026-03-01 10:01:00', '2026-03-01 10:02:00', '2026-03-01 10:03:00');
  assert.deepEqual(bt.getLingeringBedMotion(), []);
});

test('four duplicate activity rows for one minute do not produce a report', () => {
  seed('cam-a', 'out_of_bed', '2026-03-01 10:00:30');
  for (let i = 0; i < 4; i++) seedActivity('cam-a', '2026-03-01 10:01:00');
  assert.deepEqual(bt.getLingeringBedMotion(), [], 'four rows still describe only one active minute');
});

test('a real into_bed before enough active minutes accumulate suppresses the report', () => {
  seed('cam-a', 'out_of_bed', '2026-03-01 10:00:30');
  seed('cam-a', 'into_bed', '2026-03-01 10:04:30');
  seedActiveMinutes('cam-a',
    '2026-03-01 10:01:00', '2026-03-01 10:02:00', '2026-03-01 10:03:00',
    '2026-03-01 10:04:00', '2026-03-01 10:05:00', '2026-03-01 10:06:00');
  assert.deepEqual(bt.getLingeringBedMotion(), []);
});

test('quiet activity samples never trigger a lingering-motion report', () => {
  seed('cam-a', 'out_of_bed', '2026-03-01 10:00:30');
  for (let minute = 1; minute <= 6; minute++) {
    seedActivity('cam-a', `2026-03-01 10:0${minute}:00`, minute === 3 ? 0.01 : 0.001);
  }
  assert.deepEqual(bt.getLingeringBedMotion(), []);
});

test('the default sixty-minute window includes its boundary and excludes the minute after', () => {
  seed('cam-a', 'out_of_bed', '2026-03-01 10:00:00');
  seedActiveMinutes('cam-a',
    '2026-03-01 10:57:00', '2026-03-01 10:58:00', '2026-03-01 10:59:00',
    '2026-03-01 11:00:00', '2026-03-01 11:01:00');
  const [row] = bt.getLingeringBedMotion();
  assert.equal(row.active_minutes, 4, 'the exact boundary counts, while one minute past it does not');
});

test('windowMs is configurable through the database wrapper', () => {
  seed('cam-a', 'out_of_bed', '2026-03-01 10:00:00');
  seedActiveMinutes('cam-a',
    '2026-03-01 10:01:00', '2026-03-01 10:02:00',
    '2026-03-01 10:03:00', '2026-03-01 10:04:00');
  assert.deepEqual(bt.getLingeringBedMotion({ windowMs: 3 * 60000 }), []);
  assert.equal(bt.getLingeringBedMotion({ windowMs: 4 * 60000 }).length, 1);
});

test('minActiveMinutes is configurable through the database wrapper', () => {
  seed('cam-a', 'out_of_bed', '2026-03-01 10:00:30');
  seedActiveMinutes('cam-a', '2026-03-01 10:01:00', '2026-03-01 10:02:00', '2026-03-01 10:03:00');
  assert.deepEqual(bt.getLingeringBedMotion(), [], 'the default requires four distinct minutes');
  assert.equal(bt.getLingeringBedMotion({ minActiveMinutes: 3 })[0].active_minutes, 3);
});

test('a camera with no activity samples is simply not reported', () => {
  seed('cam-a', 'out_of_bed', '2026-03-01 10:00:30');
  assert.deepEqual(bt.getLingeringBedMotion(), []);
});

test("a deleted camera's exit is still checked and reported", () => {
  makeCamera(db, { id: 'cam-lingering-gone', name: 'Lingering Gone' });
  const exit = seed('cam-lingering-gone', 'out_of_bed', '2026-03-01 10:00:30');
  seedActiveMinutes('cam-lingering-gone',
    '2026-03-01 10:01:00', '2026-03-01 10:02:00',
    '2026-03-01 10:03:00', '2026-03-01 10:04:00');
  db.prepare('DELETE FROM cameras WHERE id = ?').run('cam-lingering-gone');
  const [row] = bt.getLingeringBedMotion();
  assert.equal(row.out_of_bed.id, exit);
  assert.equal(row.out_of_bed.camera_name, 'cam-lingering-gone', 'the LEFT JOIN falls back to the historical camera id');
});

test("one camera's into_bed never closes another camera's exit", () => {
  const exit = seed('cam-a', 'out_of_bed', '2026-03-01 10:00:30');
  seed('cam-b', 'into_bed', '2026-03-01 10:02:30');
  seedActiveMinutes('cam-a',
    '2026-03-01 10:01:00', '2026-03-01 10:02:00',
    '2026-03-01 10:03:00', '2026-03-01 10:04:00');
  assert.deepEqual(bt.getLingeringBedMotion().map((r) => r.out_of_bed.id), [exit]);
});

test('same-direction exits share the real next into_bed as their occupancy boundary', () => {
  seed('cam-a', 'out_of_bed', '2026-03-01 10:00:30');
  const repeated = seed('cam-a', 'out_of_bed', '2026-03-01 10:02:30');
  seed('cam-a', 'into_bed', '2026-03-01 10:08:45');
  seedActiveMinutes('cam-a',
    '2026-03-01 10:03:00', '2026-03-01 10:04:00',
    '2026-03-01 10:05:00', '2026-03-01 10:06:00');
  const rows = bt.getLingeringBedMotion();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].out_of_bed.id, repeated, 'the run representative sees activity before the shared real return');

  db.prepare('DELETE FROM bed_transitions').run();
  db.prepare('DELETE FROM activity_samples').run();
  seed('cam-a', 'out_of_bed', '2026-03-01 11:00:30');
  seed('cam-a', 'out_of_bed', '2026-03-01 11:02:30');
  seed('cam-a', 'into_bed', '2026-03-01 11:06:45');
  seedActiveMinutes('cam-a',
    '2026-03-01 11:03:00', '2026-03-01 11:04:00', '2026-03-01 11:05:00',
    '2026-03-01 11:07:00');
  assert.deepEqual(
    bt.getLingeringBedMotion(),
    [],
    'three minutes before the shared return plus one after it cannot be combined into a flag'
  );
});

test('a run of repeated out_of_bed rows is reported once, for the newest exit', () => {
  seed('cam-a', 'out_of_bed', '2026-03-01 10:00:30');
  seed('cam-a', 'out_of_bed', '2026-03-01 10:01:30');
  const newest = seed('cam-a', 'out_of_bed', '2026-03-01 10:02:30');
  seedActiveMinutes('cam-a',
    '2026-03-01 10:03:00', '2026-03-01 10:04:00',
    '2026-03-01 10:05:00', '2026-03-01 10:06:00');
  const rows = bt.getLingeringBedMotion();
  assert.equal(rows.length, 1, 'one physical unoccupied stretch produces one row, not three');
  assert.equal(rows[0].out_of_bed.id, newest);
});

test('a run of repeated out_of_bed rows is not silently emptied when only the OLDEST member has qualifying motion', () => {
  // Regression test for a real bug an adversarial pre-merge review found (Codex AND a parallel Claude
  // subagent both independently reproduced it), 2026-09-14: the original run-collapsing logic only ever
  // evaluated the NEWEST exit's own post-exit window, so motion between an earlier run member and the
  // next repeated exit was never in range of any evaluated call — silently LOST, not deduplicated. Same-
  // direction repeats are 62% of stored transitions (item 1's own measurement), so this affected the
  // majority shape of the population this diagnostic exists to characterize. Fixed by anchoring the
  // exclusion/window start at the run's OLDEST member while still reporting under the newest one.
  seed('cam-a', 'out_of_bed', '2026-03-01 10:00:30');
  seedActiveMinutes('cam-a',
    '2026-03-01 10:01:00', '2026-03-01 10:02:00',
    '2026-03-01 10:03:00', '2026-03-01 10:04:00');
  // The repeated exit itself has NOTHING qualifying after it — under the buggy version, evaluating only
  // this row would find zero minutes and report nothing at all.
  const newest = seed('cam-a', 'out_of_bed', '2026-03-01 10:06:00');
  const rows = bt.getLingeringBedMotion();
  assert.equal(rows.length, 1, "the run is still reported once, not silently dropped");
  assert.equal(rows[0].out_of_bed.id, newest, 'reported under the newest exit, matching the existing "reported once" convention');
  assert.equal(rows[0].active_minutes, 4, "evidence from the run's oldest member is not lost");
});

test('a same-minute into_bed with nonzero seconds closes the database-backed window', () => {
  seed('cam-a', 'out_of_bed', '2026-03-01 10:00:30');
  seed('cam-a', 'into_bed', '2026-03-01 10:01:45');
  seedActiveMinutes('cam-a',
    '2026-03-01 10:01:00', '2026-03-01 10:02:00',
    '2026-03-01 10:03:00', '2026-03-01 10:04:00');
  assert.deepEqual(
    bt.getLingeringBedMotion({ minActiveMinutes: 1 }),
    [],
    'the 10:01 bucket is already the return minute'
  );
});

test('lingering reports are newest-first across cameras and the limit never drops a camera', () => {
  const exits = [];
  for (const [time, minutes] of [
    ['09:00:30', ['09:01:00', '09:02:00', '09:03:00', '09:04:00']],
    ['09:20:30', ['09:21:00', '09:22:00', '09:23:00', '09:24:00']],
    ['09:40:30', ['09:41:00', '09:42:00', '09:43:00', '09:44:00']],
  ]) {
    exits.push(seed('cam-a', 'out_of_bed', `2026-03-01 ${time}`));
    seedActiveMinutes('cam-a', ...minutes.map((t) => `2026-03-01 ${t}`));
    seed('cam-a', 'into_bed', `2026-03-01 09:${String(Number(time.slice(3, 5)) + 10).padStart(2, '0')}:30`);
  }
  const bNewest = seed('cam-b', 'out_of_bed', '2026-03-01 11:00:30');
  seedActiveMinutes('cam-b',
    '2026-03-01 11:01:00', '2026-03-01 11:02:00',
    '2026-03-01 11:03:00', '2026-03-01 11:04:00');

  const limited = bt.getLingeringBedMotion({ limit: 2 });
  assert.equal(limited[0].out_of_bed.id, bNewest);
  assert.ok(limited.some((r) => r.out_of_bed.camera_id === 'cam-b'), 'the newest camera is not dropped by camera-grouped scan order');
  assert.deepEqual(bt.getLingeringBedMotion().map((r) => r.out_of_bed.id), [bNewest, ...exits.reverse()]);
});

test('lingering reports sharing a timestamp are ordered by id, newest first', () => {
  const a = seed('cam-a', 'out_of_bed', '2026-03-01 10:00:30');
  const b = seed('cam-b', 'out_of_bed', '2026-03-01 10:00:30');
  for (const cameraId of ['cam-a', 'cam-b']) {
    seedActiveMinutes(cameraId,
      '2026-03-01 10:01:00', '2026-03-01 10:02:00',
      '2026-03-01 10:03:00', '2026-03-01 10:04:00');
  }
  assert.ok(b > a);
  assert.deepEqual(bt.getLingeringBedMotion().map((r) => r.out_of_bed.id), [b, a]);
});

test('lingering-report limit has a floor of one and is capped at five hundred', () => {
  const base = Date.parse('2026-01-01T00:00:00Z');
  const sql = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
  db.transaction(() => {
    for (let i = 0; i < 520; i++) {
      const start = base + i * 2 * 60 * 60 * 1000;
      seed('cam-a', 'out_of_bed', sql(start));
      for (let minute = 1; minute <= 4; minute++) seedActivity('cam-a', sql(start + minute * 60000));
      seed('cam-a', 'into_bed', sql(start + 10 * 60000));
    }
  })();
  assert.equal(bt.getLingeringBedMotion({ limit: 0 }).length, 1, 'zero is floored to one');
  assert.equal(bt.getLingeringBedMotion({ limit: -5 }).length, 1, 'negative limits are also floored');
  assert.equal(bt.getLingeringBedMotion({ limit: 9999 }).length, 500, 'the ask is capped at 500');
  assert.equal(bt.getLingeringBedMotion({ limit: 400 }).length, 400, 'a smaller ask is honoured');
});

test('the lingering-motion threshold stays equal to sleep analysis MOTION_ACTIVE', async () => {
  // A real, unmocked import — this file already runs against a real (temp) DATA_DIR via
  // useTempDataDir(), so sleepAnalysis.js's own db-backed collaborators open safely here. Deliberately
  // NOT done in bedTransitionLink.test.js (the pure-function file): node:test's mock.module(), when
  // used there to stand in for db.js/bedTransitions.js so THIS constant could be read without opening
  // sleepAnalysis's real collaborators, was found to corrupt those modules' --experimental-test-
  // coverage attribution for the WHOLE suite (not just that one process) even after immediately
  // restoring the mocks — a real node:test mock+coverage interaction bug, found while verifying this
  // plan's own implementation, 2026-09-14. This file needs no mock at all to reach the constant safely.
  const { SLEEP_THRESHOLDS } = await import('../src/lib/sleepAnalysis.js');
  const { LINGERING_MOTION_ACTIVE } = await import('../src/lib/bedTransitionRules.js');
  assert.equal(SLEEP_THRESHOLDS.MOTION_ACTIVE, LINGERING_MOTION_ACTIVE);
});

// --- verdicts ---------------------------------------------------------------------------------

test('a verdict may be set, changed and cleared', () => {
  const id = seed('cam-a', 'into_bed', '2026-03-01 10:00:00');
  const verdictOf = () => db.prepare('SELECT verdict FROM bed_transitions WHERE id = ?').get(id).verdict;
  for (const v of bt.VERDICTS) {
    assert.equal(bt.setTransitionVerdict(id, v), true);
    assert.equal(verdictOf(), v);
  }
  assert.equal(bt.setTransitionVerdict(id, null), true, 'null clears it again');
  assert.equal(verdictOf(), null);
});

test('an unknown verdict is rejected rather than stored', () => {
  const id = seed('cam-a', 'into_bed', '2026-03-01 10:00:00');
  // A typo'd label is worse than a missing one: everything else gets measured against these values.
  for (const bad of ['Correct', 'CORRECT', 'right', '', 'true', 0, 1, {}, []]) {
    assert.equal(bt.setTransitionVerdict(id, bad), false, `rejected: ${JSON.stringify(bad)}`);
  }
  assert.equal(db.prepare('SELECT verdict FROM bed_transitions WHERE id = ?').get(id).verdict, null);
});

test('a malformed or missing id updates nothing', () => {
  for (const bad of ['abc', 0, -1, 1.5, null, undefined, '1; DROP TABLE bed_transitions']) {
    assert.equal(bt.setTransitionVerdict(bad, 'correct'), false);
  }
  assert.equal(bt.setTransitionVerdict(999999, 'correct'), false, 'no such row');
  assert.ok(db.prepare('SELECT COUNT(*) n FROM bed_transitions').get().n >= 0, 'table still exists');
});

// --- who it was, on a 'wrong' answer ------------------------------------------------------------

const reasonOf = (id) => db.prepare('SELECT wrong_reason FROM bed_transitions WHERE id = ?').get(id).wrong_reason;

test('WRONG_REASONS is its own frozen list and shares no value with VERDICTS', () => {
  // Folding "who" into the verdict would silently change what 'wrong' counts everywhere it is read.
  assert.deepEqual([...bt.WRONG_REASONS], ['adult', 'child_moved', 'other']);
  assert.ok(Object.isFrozen(bt.WRONG_REASONS));
  for (const r of bt.WRONG_REASONS) assert.ok(!bt.VERDICTS.includes(r), `${r} must not double as a verdict`);
});

test('every reason may be set, changed and cleared', () => {
  // Pairing a reason with a 'wrong' verdict is applyVerdicts' job (morning-review.test.js pins it);
  // this is the lib's value validation only.
  const id = seed('cam-a', 'out_of_bed', '2026-03-01 10:00:00', { verdict: 'wrong' });
  for (const r of bt.WRONG_REASONS) {
    assert.equal(bt.setTransitionReason(id, r), true);
    assert.equal(reasonOf(id), r);
  }
  assert.equal(bt.setTransitionReason(id, null), true, 'null clears it again');
  assert.equal(reasonOf(id), null);
});

test('an unknown reason or a malformed id is rejected rather than stored', () => {
  const id = seed('cam-a', 'out_of_bed', '2026-03-01 10:00:00', { verdict: 'wrong' });
  for (const bad of ['Adult', 'parent', 'wrong', '', 0, {}, []]) {
    assert.equal(bt.setTransitionReason(id, bad), false, `rejected: ${JSON.stringify(bad)}`);
  }
  assert.equal(reasonOf(id), null);
  for (const badId of ['abc', 0, -1, 1.5, null, undefined]) {
    assert.equal(bt.setTransitionReason(badId, 'adult'), false);
  }
});

test('changing the verdict away from wrong clears the reason in the same write', () => {
  // The protection an already-open older tab relies on: it never sends `reasons`, so the only thing
  // standing between its verdict change and a stale 'adult' is this statement.
  for (const next of ['correct', 'unclear', null]) {
    const id = seed('cam-a', 'out_of_bed', '2026-03-01 10:00:00', { verdict: 'wrong' });
    bt.setTransitionReason(id, 'adult');
    assert.equal(bt.setTransitionVerdict(id, next), true);
    assert.equal(reasonOf(id), null, `verdict -> ${next} must clear the reason`);
  }
  // …and re-affirming 'wrong' must NOT wipe the reason the person already gave.
  const id = seed('cam-a', 'out_of_bed', '2026-03-01 10:00:00', { verdict: 'wrong' });
  bt.setTransitionReason(id, 'child_moved');
  assert.equal(bt.setTransitionVerdict(id, 'wrong'), true);
  assert.equal(reasonOf(id), 'child_moved');
});

// --- retention --------------------------------------------------------------------------------

test('the age sweep cuts at 45 days, and snapshots go with the rows', () => {
  // The keeper sits at 44 days, one day INSIDE the window, so the fixture brackets the constant from
  // both sides. With a 1-day-old keeper the 45 could be lowered to 30 and this still passed — the
  // documented 45-day retention (deliberately longer than activity_samples' 30) was only bounded
  // from above.
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
  const old = seed('cam-a', 'into_bed', daysAgo(46), { snapshot: 1 });
  const file = path.join(SNAPSHOT_DIR, `${old}.jpg`);
  fs.writeFileSync(file, 'jpeg-bytes');
  const fresh = seed('cam-a', 'out_of_bed', daysAgo(44));

  bt.recordBedTransition('cam-a', bt.TRANSITION.INTO_BED, 0.1); // the insert drives the sweep

  const ids = db.prepare('SELECT id FROM bed_transitions').all().map((r) => r.id);
  assert.ok(!ids.includes(old), 'the aged row is gone');
  assert.ok(ids.includes(fresh), 'a recent row is untouched');
  assert.equal(fs.existsSync(file), false, 'the image goes with the row, never orphaned on disk');
});

test('a JUDGED transition is exempt from the age sweep however old it is', () => {
  // Deliberate: the 45-day window exists to bound machine-generated guesses. A frame a person has
  // labelled is the opposite — it is the ground truth an occupancy check gets measured against, and it
  // accrues a handful a night. Dropping those on a timer would defeat the point of collecting them.
  const judged = seed('cam-a', 'into_bed', daysAgo(400), { verdict: 'wrong' });
  const unjudged = seed('cam-a', 'out_of_bed', daysAgo(400));

  bt.recordBedTransition('cam-a', bt.TRANSITION.INTO_BED, 0.1);

  const ids = db.prepare('SELECT id FROM bed_transitions').all().map((r) => r.id);
  assert.ok(ids.includes(judged), 'a human verdict survives any age');
  assert.ok(!ids.includes(unjudged), 'an unlabelled row of the same age does not');
});

// --- snapshot paths ---------------------------------------------------------------------------

test('transitionSnapshotPath returns a path only when the file is really there', () => {
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
  const id = seed('cam-a', 'into_bed', '2026-03-01 10:00:00', { snapshot: 1 });
  assert.equal(bt.transitionSnapshotPath(id), null, 'a snapshot=1 row with no file on disk is still null');
  fs.writeFileSync(path.join(SNAPSHOT_DIR, `${id}.jpg`), 'x');
  assert.equal(bt.transitionSnapshotPath(id), path.join(SNAPSHOT_DIR, `${id}.jpg`));
});

test('a snapshot path can never escape the snapshot directory', () => {
  // The id names the file, so anything that is not a POSITIVE integer must resolve to nothing.
  //
  // The files below exist on purpose. Without them, `0` and `-1` returned null only because
  // fs.existsSync was false — so dropping the `n <= 0` half of the guard left the test green. Putting
  // real files where those ids would point is what makes the guard, rather than the filesystem, the
  // thing being tested.
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
  for (const name of ['0.jpg', '-1.jpg']) fs.writeFileSync(path.join(SNAPSHOT_DIR, name), 'x');

  for (const bad of ['../../etc/passwd', '..', 0, -1, '-1', 1.5, 'abc', null, undefined, '1/../../x']) {
    assert.equal(bt.transitionSnapshotPath(bad), null, `rejected: ${JSON.stringify(bad)}`);
  }
});
