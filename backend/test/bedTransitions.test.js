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

const daysAgo = (n) =>
  new Date(Date.now() - n * 86400e3).toISOString().slice(0, 19).replace('T', ' ');

before(() => {
  makeCamera(db, { id: 'cam-a', name: 'Camera A' });
  makeCamera(db, { id: 'cam-b', name: 'Camera B' });
});
after(() => { db.close(); cleanupTempDataDirs(); });
beforeEach(() => { db.prepare('DELETE FROM bed_transitions').run(); });

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
