// #851 (and the frames half of #846): no timelapse frame folder outlives its night by more than about a month.
//
// THE DEFECT. Raw frames (about 30 MB a night) were deleted only when a night was assembled or, since #419, when its stored
// verdict was a final `empty`. A night stored no_data / no_sleep / insufficient / off, a night with no row at all, and an
// `ok` night whose assembly the retry gave up on (#846: 3 tries per process, reset by every restart) kept its frames until
// the child was removed. lib/timelapse.js discardExpiredFrames now deletes any frame folder whose night date is before
// the UTC date of (now - 32 days); its comment derives the 32 (30-day activity retention, a daily prune, and the latest a
// night's window can sit relative to its own date).
//
// HOW THIS IS OBSERVED. The real DB, the real frame folders, the real assembler, the real retry and the real nightly job;
// child_process is faked (helpers/fakeFfmpeg.js) so an assembly is a process the test holds open and finishes. The clock
// is mocked in EVERY test: the rule reads nothing but the clock, so a test on the real clock would change meaning as the
// calendar moves (timelapse-retry.test.js g1 was frozen for the same reason).
//
// Which cases FAIL on the code before #851: all of them (discardExpiredFrames did not exist, so every direct call throws,
// and j1's tick never deletes the folder). The cases that assert a folder is KEPT also pass on a rule without the guard
// they name, so each guard has an entry in scripts/mutants.json (`#851 M*`): the margin (m1), the in-flight skip (i1), the
// link guard (l1) and the tick call (j1).
import { test, before, after, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { useTempDataDir, cleanupTempDataDirs, makeChild } from './helpers/harness.js';
import { FakeFfmpeg } from './helpers/fakeFfmpeg.js';

useTempDataDir();
const spawned = [];
mock.module('node:child_process', {
  exports: {
    spawn(command, args) {
      const proc = new FakeFfmpeg(command, args);
      spawned.push(proc);
      return proc;
    },
  },
});

const { default: db } = await import('../src/db.js');
const { CLIPS_DIR } = await import('../src/lib/clipRecorder.js');
const { checkClipStorage } = await import('../src/lib/clipStorage.js');
const { logger } = await import('../src/lib/logger.js');
const {
  assembleTimelapse, discardExpiredFrames, retryStrandedTimelapses, resetRetryStateForTest, frameDir,
} = await import('../src/lib/timelapse.js');
const { runNightlySleepJob, reportableSpanMs, zonedToUtc } = await import('../src/lib/sleepAnalysis.js');

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const FRAMES_ROOT = path.join(CLIPS_DIR, '.timelapse-frames');
const OUTSIDE = path.join(CLIPS_DIR, 'outside-851'); // a link target: never inside the frames tree

// Night D = 2026-10-01 is deleted from D+33 00:00 UTC (2026-11-03), the first instant at which the UTC date of
// (now - 32 days) is past D. The US clocks go back on 2026-11-01 and New Zealand is on daylight time (UTC+13), so a rule
// that read the app timezone, or added local days, would move this instant in b2.
const NIGHT = '2026-10-01';
const DELETE_FROM = Date.UTC(2026, 10, 3);

const U = 'child-851'; // none of this file's children is tracked: the nightly job's own loop never scores them
const OTHER = 'child-851-b';
const GONE = 'child-gone-851'; // frames whose child no longer exists

const framesOf = (child, night) => {
  const d = path.join(FRAMES_ROOT, child, night);
  return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => /^f-\d+\.jpg$/.test(f)).length : 0;
};
const putFrames = (child, night, n = 30, root = FRAMES_ROOT) => {
  const d = path.join(root, child, night);
  fs.mkdirSync(d, { recursive: true });
  for (let i = 0; i < n; i++) fs.writeFileSync(path.join(d, `f-${1000 + i}.jpg`), 'frame');
  return d;
};
const gone = (child, night) => !fs.existsSync(path.join(FRAMES_ROOT, child, night));
const storeNight = (child, night, status) =>
  db.prepare(`INSERT OR REPLACE INTO sleep_nights (child_id, night_date, window_start, window_end, status, computed_at)
              VALUES (?, ?, ?, ?, ?, ?)`).run(child, night, `${night} 19:00:00`, `${night} 23:00:00`, status, `${night} 23:30:00`);
const setTimezone = (tz) =>
  db.prepare(`INSERT INTO settings (id, timezone) VALUES ('app', ?)
              ON CONFLICT(id) DO UPDATE SET timezone = excluded.timezone`).run(tz);

const flush = () => new Promise((resolve) => setImmediate(resolve));
async function until(pred, what) {
  for (let i = 0; i < 500; i++) {
    if (pred()) return;
    await flush();
  }
  assert.fail(`timed out waiting for ${what}`);
}
async function settle() {
  for (let i = 0; i < 20; i++) await flush();
}
const outFile = (child, night) => path.join(CLIPS_DIR, 'timelapse', child, `${night}.mp4`);
const assemblyOf = (child, night) => spawned.filter((p) => p.args.at(-1) === outFile(child, night));

before(() => {
  makeChild(db, { id: U, track: 0 });
  makeChild(db, { id: OTHER, track: 0 });
});
after(() => {
  db.close();
  cleanupTempDataDirs();
});
beforeEach(() => {
  spawned.length = 0;
  logger.clear();
  resetRetryStateForTest();
  checkClipStorage({ mounts: null });
  setTimezone('UTC');
  for (const table of ['sleep_nights', 'timelapses']) db.prepare(`DELETE FROM ${table}`).run();
  // Links first, so the recursive removes below can never reach a link target through them.
  for (const child of fs.existsSync(FRAMES_ROOT) ? fs.readdirSync(FRAMES_ROOT) : []) {
    const p = path.join(FRAMES_ROOT, child);
    if (fs.lstatSync(p).isSymbolicLink()) fs.unlinkSync(p);
  }
  fs.rmSync(FRAMES_ROOT, { recursive: true, force: true });
  fs.rmSync(OUTSIDE, { recursive: true, force: true });
  fs.rmSync(path.join(CLIPS_DIR, 'timelapse'), { recursive: true, force: true });
});
afterEach(async () => {
  for (const proc of spawned) proc.finish(1);
  await settle();
  mock.timers.reset();
});
const at = (ms) => mock.timers.enable({ apis: ['Date', 'setTimeout'], now: ms });
// A directory link that needs no privilege on Windows (a junction; the type is ignored elsewhere).
const linkDir = (target, linkPath) => {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  fs.symlinkSync(target, linkPath, 'junction');
};

// --- the age rule ---------------------------------------------------------------------------------------------------

test('b1: folders more than 32 days old go, younger ones stay; hostile neighbours (another child, a child that no longer exists, the cutoff date itself)', () => {
  at(Date.UTC(2026, 10, 10, 12)); // the UTC date of (now - 32 days) is 2026-10-09
  putFrames(U, '2026-10-01'); // 40 days old, no stored night
  putFrames(U, '2026-10-08'); // the last date before the cutoff
  putFrames(U, '2026-10-09'); // the cutoff date: kept
  putFrames(U, '2026-10-16'); // 25 days old
  putFrames(OTHER, '2026-10-01');
  putFrames(OTHER, '2026-10-16');
  putFrames(GONE, '2026-10-01'); // scratch nobody can assemble any more (the retry needs the child): deleted too
  putFrames(GONE, '2026-10-16');

  assert.equal(discardExpiredFrames(), 4);
  for (const [child, night] of [[U, '2026-10-01'], [U, '2026-10-08'], [OTHER, '2026-10-01'], [GONE, '2026-10-01']]) {
    assert.ok(gone(child, night), `${child} ${night} is more than 32 days old and was kept`);
  }
  for (const [child, night] of [[U, '2026-10-09'], [U, '2026-10-16'], [OTHER, '2026-10-16'], [GONE, '2026-10-16']]) {
    assert.equal(framesOf(child, night), 30, `${child} ${night} is not 32 days old yet and lost its frames`);
  }
  assert.ok(logger.getRecent().some((l) => l.includes(`child ${U} 2026-10-01: discarded 30 frame(s)`)), 'no discard logged');
});

test('b2: the boundary is one UTC instant, whatever the app timezone (UTC, a DST change, UTC+13): kept 1 ms before, deleted at it', () => {
  at(DELETE_FROM - 1);
  for (const tz of ['UTC', 'America/New_York', 'Pacific/Auckland']) {
    setTimezone(tz);
    putFrames(U, NIGHT);
    mock.timers.setTime(DELETE_FROM - 1);
    assert.equal(discardExpiredFrames(), 0, `${tz}: deleted before the boundary`);
    assert.equal(framesOf(U, NIGHT), 30);
    mock.timers.setTime(DELETE_FROM);
    assert.equal(discardExpiredFrames(), 1, `${tz}: kept at the boundary`);
    assert.ok(gone(U, NIGHT));
  }
});

test('b3: every stored status, and no row at all, goes once old (the age rule reads no row)', () => {
  at(Date.UTC(2026, 10, 10, 12));
  const nights = {
    '2026-09-20': 'no_data', '2026-09-21': 'no_sleep', '2026-09-22': 'insufficient', '2026-09-23': 'off',
    '2026-09-24': 'ok', // scored ok, but no video (an assembly the retry gave up on, #846)
    '2026-09-25': null,
  };
  for (const [night, status] of Object.entries(nights)) {
    putFrames(U, night);
    if (status) storeNight(U, night, status);
  }
  assert.equal(discardExpiredFrames(), 6);
  for (const night of Object.keys(nights)) assert.ok(gone(U, night), `${night} (${nights[night]}) kept its frames`);
});

test('m1: the margin outlasts the last moment any night could still be scored, at both ends of the timezone range, with a 24-hour window', () => {
  // A night can be re-scored while at least half its window still has activity samples, and a sample lives at most
  // about 31 days (deleted at 30 days by a prune that runs once a day, activityTracker.js). So the last instant a night
  // can still be scored, and so still be made into a timelapse, is about 31 days after the MIDDLE of its window. The
  // latest middle, relative to the night's own date, is a 24-hour window starting at 23:59 at UTC-12. Its frames must
  // still be there at that instant. A 31-day rule fails this at Etc/GMT+12 (it deletes about 24 hours too early).
  const SAMPLE_LIFE_MS = 31 * DAY;
  const kid = 'child-851-wide';
  makeChild(db, { id: kid, track: 0, start: '23:59', end: '23:59' });
  try {
    at(Date.UTC(2026, 9, 2));
    for (const tz of ['Etc/GMT+12', 'Pacific/Kiritimati']) {
      setTimezone(tz);
      const startMs = zonedToUtc(2026, 9, 1, 23, 59, tz).getTime();
      const middleMs = startMs + 12 * HOUR;
      // The app's own span for this child covers the full 24-hour window (the window helpers agree it wraps to a day).
      const span = reportableSpanMs(kid, NIGHT);
      assert.ok(span.fromMs <= startMs && span.toMs >= startMs + DAY, `${tz}: precondition: a 24-hour window from 23:59`);
      putFrames(kid, NIGHT);
      mock.timers.setTime(middleMs + SAMPLE_LIFE_MS);
      assert.equal(discardExpiredFrames(), 0, `${tz}: frames deleted while the night could still be scored`);
      assert.equal(framesOf(kid, NIGHT), 30);
      mock.timers.setTime(DELETE_FROM);
      assert.equal(discardExpiredFrames(), 1, `${tz}: never deleted`);
    }
  } finally {
    db.prepare('DELETE FROM children WHERE id = ?').run(kid);
  }
});

// --- guards -----------------------------------------------------------------------------------------------------------

test('i1: a night being assembled is not touched; once that assembly has failed, the next pass deletes it', async () => {
  at(DELETE_FROM);
  putFrames(U, NIGHT);
  putFrames(U, '2026-09-30'); // an old neighbour: the pass goes on past the skipped night
  const assembly = assembleTimelapse(U, NIGHT);
  await until(() => assemblyOf(U, NIGHT).length > 0, 'the assembly to start');
  assert.equal(discardExpiredFrames(), 1, 'the in-flight night was deleted, or the pass stopped at it');
  assert.equal(framesOf(U, NIGHT), 30, 'deleted the frames an encoder is reading');
  assert.ok(gone(U, '2026-09-30'));

  assemblyOf(U, NIGHT)[0].finish(1); // fails: the failure path keeps the frames
  assert.equal(await assembly, null);
  assert.equal(discardExpiredFrames(), 1);
  assert.ok(gone(U, NIGHT));
});

test('n1: names that are not a plain child id and a real calendar date are skipped, however old', () => {
  at(DELETE_FROM);
  const kept = [
    putFrames(U, '2026-02-30'), // the shape of a date, not a real one
    putFrames(U, `${NIGHT}.old`),
    putFrames('child 851', NIGHT), // a space: not a segment the app makes
  ];
  putFrames(U, NIGHT); // the one real candidate
  assert.equal(discardExpiredFrames(), 1);
  for (const d of kept) assert.equal(fs.existsSync(d), true, `${d} was deleted`);
  assert.ok(gone(U, NIGHT));
  // Skipped quietly: frameDir would refuse the space anyway, but as an error on every 30-minute tick.
  assert.equal(logger.getRecent().some((l) => l.includes('[ERROR]')), false, 'a skipped name was tried and failed');
});

test('l1: nothing is deleted through a link: a linked child folder, or a linked night folder, leaves its target whole', () => {
  at(DELETE_FROM);
  // A child "folder" that is a link to somewhere holding date-named folders of frames.
  const targetNight = putFrames('elsewhere', NIGHT, 30, OUTSIDE);
  linkDir(path.join(OUTSIDE, 'elsewhere'), path.join(FRAMES_ROOT, 'linked-child'));
  // A real child folder whose night folder is a link.
  const targetFrames = putFrames('night-target', 'x', 30, OUTSIDE);
  linkDir(targetFrames, path.join(FRAMES_ROOT, U, '2026-09-30'));
  putFrames(U, NIGHT); // a real old night beside them still goes

  assert.equal(discardExpiredFrames(), 1, 'a link was counted as an old night');
  assert.equal(fs.readdirSync(targetNight).length, 30, "deleted a linked child folder's target");
  assert.equal(fs.readdirSync(targetFrames).length, 30, "deleted a linked night folder's target");
  assert.ok(fs.lstatSync(path.join(FRAMES_ROOT, U, '2026-09-30')).isSymbolicLink(), 'the night link itself was removed');
  assert.ok(gone(U, NIGHT));
});

test('f1: a folder that cannot be deleted is warned about, not counted or logged as discarded, and the pass goes on', (t) => {
  at(DELETE_FROM);
  const stuck = putFrames(U, '2026-09-30');
  putFrames(U, NIGHT);
  // rmrf swallows every error, so a permissions problem looks exactly like this: rmSync does nothing.
  const realRm = fs.rmSync;
  t.mock.method(fs, 'rmSync', (p, opts) => (p === stuck ? undefined : realRm(p, opts)));
  assert.equal(discardExpiredFrames(), 1);
  assert.equal(framesOf(U, '2026-09-30'), 30);
  assert.ok(gone(U, NIGHT), 'the pass stopped at the folder it could not delete');
  const lines = logger.getRecent();
  assert.ok(lines.some((l) => l.includes('WARN') && l.includes(`could not delete ${stuck}`)), 'no warning');
  assert.equal(lines.some((l) => l.includes(`${U} 2026-09-30: discarded`)), false, 'a failed delete was logged as a success');
});

test('f2: a night that throws does not stop the pass; the error is logged', (t) => {
  at(DELETE_FROM);
  const bad = putFrames(U, '2026-09-30');
  putFrames(U, NIGHT);
  const realExists = fs.existsSync;
  t.mock.method(fs, 'existsSync', (p) => {
    if (p === bad) throw new Error('disk error');
    return realExists(p);
  });
  assert.equal(discardExpiredFrames(), 1);
  assert.ok(gone(U, NIGHT), 'one bad night stopped the rest of the pass');
  assert.ok(logger.getRecent().some((l) => l.includes(`old-frames sweep of ${U} 2026-09-30 failed: disk error`)), 'no error logged');
});

test('c1: oldest first, at most 20 folders a pass; the rest go on the next pass', () => {
  at(DELETE_FROM);
  const nights = Array.from({ length: 25 }, (_, i) => new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10));
  for (const night of nights) putFrames(U, night, 2);
  assert.equal(discardExpiredFrames(), 20);
  for (const night of nights.slice(0, 20)) assert.ok(gone(U, night), `${night} (among the 20 oldest) was kept`);
  for (const night of nights.slice(20)) assert.equal(framesOf(U, night), 2, `${night} went before an older one`);
  assert.equal(discardExpiredFrames(), 5);
  for (const night of nights.slice(20)) assert.ok(gone(U, night));
});

test('c2: a pass stops once about 250 ms have gone by, after the folder it is on (always at least one)', (t) => {
  at(DELETE_FROM);
  for (const night of ['2026-09-28', '2026-09-29', '2026-09-30']) putFrames(U, night, 2);
  // Each discarded folder "takes" 300 ms: the clock is moved on as its log line is written.
  const realInfo = logger.info;
  t.mock.method(logger, 'info', (...args) => {
    mock.timers.setTime(Date.now() + 300);
    return realInfo(...args);
  });
  assert.equal(discardExpiredFrames(), 1);
  assert.ok(gone(U, '2026-09-28'), 'the oldest did not go first');
  assert.equal(framesOf(U, '2026-09-29'), 2);
  assert.equal(discardExpiredFrames(), 1);
  assert.ok(gone(U, '2026-09-29'));
});

test('c3: a listing that alone takes longer than the budget still lets the pass delete one folder', (t) => {
  // On a slow array the folder listing itself can take longer than 250 ms; a pass that then deleted nothing would
  // never make progress at all.
  at(DELETE_FROM);
  for (const night of ['2026-09-29', '2026-09-30']) putFrames(U, night, 2);
  const realReaddir = fs.readdirSync;
  t.mock.method(fs, 'readdirSync', (...args) => {
    mock.timers.setTime(Date.now() + 300);
    return realReaddir(...args);
  });
  assert.equal(discardExpiredFrames(), 1);
  assert.ok(gone(U, '2026-09-29'));
});

// --- with the retry and the nightly job -----------------------------------------------------------------------------

test('r1 (#846): an ok night the retry gave up on keeps its frames until it is 32 days old; after that a restart no longer retries it', async () => {
  storeNight(U, NIGHT, 'ok');
  putFrames(U, NIGHT);
  at(DELETE_FROM - 1); // still young enough: the retry may try, and give up
  for (let i = 0; i < 3; i++) {
    const pass = retryStrandedTimelapses();
    await until(() => assemblyOf(U, NIGHT).length > i, `retry ${i + 1} to start`);
    assemblyOf(U, NIGHT)[i].finish(1);
    assert.equal(await pass, 1);
  }
  assert.ok(logger.getRecent().some((l) => l.includes('giving up on') && l.includes(frameDir(U, NIGHT))), 'no give-up line naming the folder');
  assert.equal(discardExpiredFrames(), 0, 'the frames of a night not yet 32 days old were deleted');
  assert.equal(framesOf(U, NIGHT), 30);

  mock.timers.setTime(DELETE_FROM);
  assert.equal(discardExpiredFrames(), 1);
  resetRetryStateForTest(); // a restart: before #851 this gave the night three more tries, every time, for ever
  const before = spawned.length;
  assert.equal(await retryStrandedTimelapses(), 0);
  assert.equal(spawned.length, before, 'the retry started an assembly of a night whose frames are gone');
});

test('j1: every tick of the nightly job runs the sweep, with or without a night to score', async () => {
  // U is not tracked and the night has no row, so nothing else in the tick touches this folder.
  at(DELETE_FROM);
  putFrames(U, NIGHT);
  putFrames(U, '2026-10-20'); // young: survives the tick
  runNightlySleepJob();
  await until(() => gone(U, NIGHT), 'the tick to delete the old folder');
  assert.equal(framesOf(U, '2026-10-20'), 30);
});
