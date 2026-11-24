// scripts/replay-nights.mjs: the backend's own sleep scoring replayed over a COPY of a database snapshot, to see what a
// scoring change moved (compare), where the card and the detail page disagree (drift), one night in detail (night),
// and the admin "Update past nights" action end to end on the copy (rewrite).
//
// ⚠️ IT LIVES HERE BECAUSE THIS IS THE ONLY TEST HARNESS IN THE REPO (same reason as scoreboard.test.js): the module
// under test is repo-root tooling (`scripts/`). The fixture and the child-process approach follow scoreboard.test.js.
//
// What is claimed, and which test fails when it is false (each checked by changing scripts/replay-nights.mjs; see the PR):
//   bad arguments are refused with exit 2 and nothing on stdout ........... "usage errors ..."
//   a time prints in the zone asked for, not the machine's ................. "localTime ..."
//   the snapshot (and its folder) is never written ......................... "read-only: ..."
//   compare lists a night only when old and new differ, with the parent's
//     time beside it, in the zone asked for ................................ "compare shows ..."
//   identical backends differ nowhere ...................................... "compare of a backend with itself ..."
//   children are labelled by creation order and no name is ever printed ..... "child labels ..."
//   drift compares the STORED row with a FRESH recompute, by --threshold .... "drift ..."
//   night prints that night's fields and rejects an unknown child ........... "night ..."
//   rewrite previews twice (same hash, nothing written) and says what it
//     skipped; a backend without Update past nights is refused ............. "rewrite ..."
//   the clock is frozen (timings still work: performance.now, not Date) ..... "rewrite ..." (a real run prints a duration)
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { useTempDataDir, cleanupTempDataDirs } from './helpers/harness.js';

// DATA_DIR must be set before db.js is first imported (it opens the database at module load).
useTempDataDir();

const RN = await import(new URL('../../scripts/replay-nights.mjs', import.meta.url).href);
const SCRIPT = fileURLToPath(new URL('../../scripts/replay-nights.mjs', import.meta.url));
const REAL_BACKEND = fileURLToPath(new URL('..', import.meta.url));
const { default: db } = await import('../src/db.js');

const tmpDirs = [];
const mkTmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); tmpDirs.push(d); return d; };
after(() => {
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* temp */ } }
  try { db.close(); } catch { /* already closed */ }
  cleanupTempDataDirs();
});

const MARK = 'Zq9-marker';
const KID_FIRST = { id: 'zz-created-first', name: `${MARK}-child-one`, created: '2026-01-01 00:00:00', cam: 'rn-cam-1' };
// Its id sorts BEFORE the first child's: a script that ordered by id would swap the labels.
const KID_SECOND = { id: 'aa-created-second', name: `${MARK}-child-two`, created: '2026-02-01 00:00:00', cam: 'rn-cam-2' };
const CLOCK = '2026-07-05T02:45:00Z';
const T = (date, h, m) => Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10), h, m);
const sqlTime = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const insertSample = db.prepare(
  `INSERT INTO activity_samples (camera_id, bucket_start, motion_level, motion_peak, sound_level,
     sound_peak, motion_frames, sound_windows) VALUES (?, ?, ?, ?, 0, 0, 1, 0)`,
);
const insertTransition = db.prepare('INSERT INTO bed_transitions (camera_id, type, peak, created_at) VALUES (?, ?, ?, ?)');
// A real night shape (see scoreboard.test.js): settling 19:30-19:40, awakenings, out of bed at 05:09, a parent from 06:45.
function layNight(cam, date) {
  const day = 86400000;
  const active = [
    [T(date, 19, 30), T(date, 19, 40)], [T(date, 23, 0), T(date, 23, 6)],
    [T(date, 2, 0) + day, T(date, 2, 8) + day], [T(date, 5, 0) + day, T(date, 5, 9) + day],
    [T(date, 6, 45) + day, T(date, 7, 0) + day],
  ];
  for (let t = T(date, 18, 20); t < T(date, 7, 0) + day; t += 60000) {
    const moving = active.some(([a, b]) => t >= a && t < b);
    insertSample.run(cam, sqlTime(t), moving ? 0.4 : 0.0002, moving ? 0.6 : 0.0002);
  }
  insertTransition.run(cam, 'into_bed', 0.5, sqlTime(T(date, 19, 31)));
  insertTransition.run(cam, 'out_of_bed', 0.4, sqlTime(T(date, 5, 9) + day));
}

let fixture;
const snapState = (dir, file) => ({
  sha: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
  mtimeMs: fs.statSync(file).mtimeMs,
  listing: fs.readdirSync(dir).sort(),
});
function run(args, opts = {}) {
  const env = { ...process.env };
  delete env.DATA_DIR; // the script must make its own, never inherit the test suite's
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env, ...opts });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

before(() => {
  db.prepare("INSERT INTO settings (id, timezone) VALUES ('app', 'UTC') ON CONFLICT(id) DO UPDATE SET timezone = 'UTC'").run();
  for (const k of [KID_FIRST, KID_SECOND]) {
    db.prepare(`INSERT INTO children (id, name, created_at, track_sleep, sleep_window_start, sleep_window_end)
                VALUES (?, ?, ?, 1, '19:30', '07:00')`).run(k.id, k.name, k.created);
    db.prepare(`INSERT INTO cameras (id, name, rtsp_url, child_id, mediamtx_path, sort_order, disabled)
                VALUES (?, ?, 'rtsp://example/x', ?, ?, 0, 0)`).run(k.cam, `${MARK}-cam-${k.id}`, k.id, `p-${k.cam}`);
  }
  for (const d of ['2026-07-01', '2026-07-02']) layNight(KID_FIRST.cam, d);
  // STORED rows that disagree with the fresh recompute (decoys): a script that read sleep_nights instead of
  // recomputing, or that compared stored with stored, would report no difference.
  for (const d of ['2026-07-01', '2026-07-02']) {
    db.prepare(`INSERT INTO sleep_nights (child_id, night_date, window_start, window_end, status, in_bed_at, onset_at, wake_at)
                VALUES (?, ?, '2026-01-01 00:00:00', '2026-01-01 01:00:00', 'ok', '2026-01-01 00:01:00', '2026-01-01 00:02:00', '2026-01-01 00:03:00')`).run(KID_FIRST.id, d);
  }
  // The parent's own times for night 07-01, typed: the wake is 06:00 UTC on the 2nd.
  db.prepare(`INSERT INTO sleep_reviews (child_id, night_date, true_in_bed_at, true_onset_at, true_wake_at,
        computed_onset_at, computed_wake_at, note, dismissed, nobody_in_bed, answered_by_username, reviewed_at)
     VALUES (?, '2026-07-01', '2026-07-01 19:31:00', '2026-07-01 19:40:00', '2026-07-02 06:00:00',
        '2026-01-01 00:02:00', '2026-01-01 00:03:00', ?, 0, 0, ?, '2026-07-10 08:00:00')`).run(KID_FIRST.id, `${MARK}-note`, `${MARK}-user`);

  // A clean snapshot of the finished database, named like the app's own file in a directory of its own: a script that
  // opened it IN PLACE (DATA_DIR = its directory) would migrate it and write -wal/-shm beside it.
  const snapDir = mkTmp('nightlight-rn-snap-');
  const snap = path.join(snapDir, 'babymonitor.db');
  db.prepare('VACUUM INTO ?').run(snap);
  // Make the snapshot NEED a migration: db.js recreates this index on open, so any run that opens the file in place
  // rewrites it. Without this a finished snapshot is a no-op to open and "never written" is a claim no test can fail.
  const raw = new Database(snap);
  raw.pragma('journal_mode = DELETE');
  raw.exec('DROP INDEX idx_bed_transitions_cam_time');
  raw.close();
  fixture = { snapDir, snap, pristine: snapState(snapDir, snap) };
});

// A fake backend directory: computeNight answers a constant, the database stub answers the three queries `compare`
// makes. If --old were ignored the numbers would be the real tree's and the night below would not differ as stated.
function fakeBackend() {
  const tree = mkTmp('nightlight-rn-fake-');
  const lib = path.join(tree, 'backend', 'src', 'lib');
  fs.mkdirSync(lib, { recursive: true });
  fs.mkdirSync(path.join(tree, 'backend', 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(tree, 'backend', 'package.json'), '{"type":"module"}\n');
  fs.writeFileSync(path.join(lib, 'sleepAnalysis.js'),
    "export function computeNight() { return { status: 'ok', in_bed_at: '2026-07-01 19:00:00', onset_at: '2026-07-01 19:10:00', wake_at: '2026-07-02 05:00:00', asleep_minutes: 500, awake_minutes: 10, wake_count: 2 }; }\n");
  fs.writeFileSync(path.join(tree, 'backend', 'src', 'db.js'), [
    `const nights = [{ child_id: '${KID_FIRST.id}', night_date: '2026-07-01' }];`,
    `const kids = [{ id: '${KID_FIRST.id}' }, { id: '${KID_SECOND.id}' }];`,
    `const reviews = [{ child_id: '${KID_FIRST.id}', night_date: '2026-07-01', in_bed: '2026-07-01 19:31:00', onset: '2026-07-01 19:40:00', wake: '2026-07-02 06:00:00' }];`,
    'export default {',
    '  prepare(sql) {',
    '    return { all: () => (/FROM children/.test(sql) ? kids : /sleep_reviews/.test(sql) ? reviews : /sleep_nights/.test(sql) ? nights : []) };',
    '  },',
    '  close() {},',
    '};',
    '',
  ].join('\n'));
  return path.join(tree, 'backend');
}

describe('arguments and time', () => {
  test('usage errors exit 2 with nothing on stdout', () => {
    const cases = [
      [], ['bogus', 'a', 'b'], ['compare', 'a', 'b'], ['drift', 'a'], ['night', 'a', 'b', 'notadate'],
      ['drift', 'a', 'b', '--tz=Not/AZone'], ['drift', 'a', 'b', '--threshold=x'], ['drift', 'a', 'b', '--nope'],
      ['drift', REAL_BACKEND, path.join(fixture.snapDir, 'missing.db')],
    ];
    for (const args of cases) {
      const r = run(args);
      assert.equal(r.code, 2, `${args.join(' ')}: ${r.stderr}`);
      assert.equal(r.stdout, '');
      assert.ok(r.stderr.length > 0);
    }
    assert.throws(() => RN.parseArgs(['night', 'a', 'b', '2026-07-01', '--child=0']), /--child/);
  });

  test('localTime prints in the zone asked for, and "--" for no time', () => {
    assert.equal(RN.localTime('2026-07-01 19:40:00', 'UTC'), '07-01 19:40');
    // Melbourne is UTC+10 in July: the same instant is the next morning there. A hard-coded offset or the machine's zone fails this.
    assert.equal(RN.localTime('2026-07-01 19:40:00', 'Australia/Melbourne'), '07-02 05:40');
    assert.equal(RN.localTime('2026-07-01 19:40:00', 'America/Los_Angeles'), '07-01 12:40');
    assert.equal(RN.localTime(null, 'UTC'), '--');
  });
});

describe('scripts/replay-nights.mjs on a real database', () => {
  test('compare of a backend with itself differs nowhere, and the snapshot is only read', () => {
    const r = run(['compare', REAL_BACKEND, REAL_BACKEND, fixture.snap, `--clock=${CLOCK}`]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /nights compared: 2; changed: 0/);
    assert.deepEqual(snapState(fixture.snapDir, fixture.snap), fixture.pristine, 'the snapshot or its folder was written');
  });

  test('compare shows a night only where old and new differ, with the parent\'s time, in the zone asked for', () => {
    const fake = fakeBackend();
    const r = run(['compare', fake, REAL_BACKEND, fixture.snap, `--clock=${CLOCK}`, '--tz=Australia/Melbourne']);
    assert.equal(r.code, 0, r.stderr);
    const lines = r.stdout.trim().split('\n');
    const row = JSON.parse(lines[0]);
    assert.equal(row.night, '2026-07-01');
    assert.equal(row.child, 'child 1');
    // The fake says wake 05:00 UTC on the 2nd = 15:00 Melbourne; the real tree scores the 05:09 exit: 15:09 there.
    assert.equal(row.old.wake, '07-02 15:00');
    assert.notEqual(row.new.wake, row.old.wake);
    assert.match(row.new.wake, /^07-02 \d\d:\d\d$/);
    // The parent's typed times (19:31, 19:40 and 06:00 UTC) in Melbourne (UTC+10 in July).
    assert.deepEqual(row.parent, { in_bed: '07-02 05:31', onset: '07-02 05:40', wake: '07-02 16:00' });
    assert.match(lines.at(-1), /times printed in Australia\/Melbourne; nights compared: 1; changed: 1/);
  });

  test('--whole names the keys that differ and flags a night where something differs but onset did not move', () => {
    const fake = fakeBackend();
    const r = run(['compare', fake, REAL_BACKEND, fixture.snap, `--clock=${CLOCK}`, '--whole']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /child 1 2026-07-01 differs in: .*wake_at/);
    assert.match(r.stdout, /nights whose onset and in-bed time did NOT move but something else did: \d+/);
    assert.match(r.stdout, /keys differing on nights that moved: \{/);
  });

  test('child labels follow creation order and no name reaches any output', () => {
    const outputs = [
      run(['drift', REAL_BACKEND, fixture.snap, `--clock=${CLOCK}`]),
      run(['night', REAL_BACKEND, fixture.snap, '2026-07-01', `--clock=${CLOCK}`]),
      run(['compare', fakeBackend(), REAL_BACKEND, fixture.snap, `--clock=${CLOCK}`]),
      run(['rewrite', REAL_BACKEND, fixture.snap, `--clock=${CLOCK}`]),
    ];
    for (const r of outputs) {
      assert.equal(r.code, 0, r.stderr);
      assert.ok(!(r.stdout + r.stderr).includes(MARK), 'a name, a note or a user name reached the output');
      assert.ok(!/zz-created-first|aa-created-second/.test(r.stdout), 'an id reached the output');
    }
    // child 1 is the FIRST CREATED child (its id sorts last): the stored decoy nights belong to it.
    assert.match(outputs[0].stdout, /child 1 2026-07-01/);
  });

  test('drift compares the stored row with a fresh recompute, by --threshold', () => {
    const r = run(['drift', REAL_BACKEND, fixture.snap, `--clock=${CLOCK}`, '--tz=UTC']);
    assert.equal(r.code, 0, r.stderr);
    // Two stored decoy nights, both far from what the backend recomputes.
    assert.match(r.stdout, /stored ok nights recomputed: 2; fresh wake differs from stored by more than 10 min on 2; fresh onset on 2/);
    assert.match(r.stdout, /child 1 2026-07-01: wake stored 01-01 00:03 fresh 07-02 \d\d:\d\d \(\+\d+\)/);
    assert.match(r.stdout, /parent 07-02 06:00/);
    const wide = run(['drift', REAL_BACKEND, fixture.snap, `--clock=${CLOCK}`, '--threshold=1000000', '--limit=0']);
    // (The decoy stored nights are in January and the replay lands in July: about 260,000 minutes apart.)
    assert.match(wide.stdout, /on 0; fresh onset on 0/);
    assert.equal(wide.stdout.trim().split('\n').length, 1, '--limit=0 must print no night lines');
  });

  test('night prints that night\'s fields and rejects a child that does not exist', () => {
    const r = run(['night', REAL_BACKEND, fixture.snap, '2026-07-01', `--clock=${CLOCK}`, '--child=1']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^child 1, night 2026-07-01 \(times in UTC\)/);
    assert.match(r.stdout, /"status":"ok"/);
    assert.match(r.stdout, /stored transitions inside the night's window: 07-01 19:31 into_bed/);
    const none = run(['night', REAL_BACKEND, fixture.snap, '2026-07-01', '--child=3']);
    assert.equal(none.code, 2);
    assert.match(none.stderr, /2 child\(ren\); --child=3 does not exist/);
  });

  test('rewrite previews twice with the same hash and nothing written, and says what it skipped', () => {
    const r = run(['rewrite', REAL_BACKEND, fixture.snap, `--clock=${CLOCK}`]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /preview \d+ ms; same hash twice: true; the preview wrote nothing: true/);
    // The two stored decoy nights have no saved settings (NULL scoring_context): skipped, not rewritten.
    assert.match(r.stdout, /child 1: changed 0, unchanged 0, skipped \{"no_saved_settings":2\}/);
    assert.match(r.stdout, /nothing was changed, so there is nothing to undo/);
    assert.deepEqual(snapState(fixture.snapDir, fixture.snap), fixture.pristine);
  });

  test('rewrite refuses a backend that predates Update past nights, and a path that is not a backend', () => {
    // fakeBackend() has no src/lib/sleepRewrite.js, like a release before "Update past nights".
    const r = run(['rewrite', fakeBackend(), fixture.snap, `--clock=${CLOCK}`]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /predates "Update past nights"/);
    const nope = run(['drift', path.join(fixture.snapDir, 'not-a-backend'), fixture.snap]);
    assert.equal(nope.code, 2);
    assert.match(nope.stderr, /not a backend directory/);
  });
});
