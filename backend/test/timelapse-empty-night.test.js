// #419: an `empty` night's timelapse frames are discarded only once that verdict is final.
//
// THE DEFECT. The nightly job re-scores a night every 30 minutes for ~3 hours after its window closes (#351). It deleted
// the night's raw frames on the FIRST pass that scored it `empty`, so a later pass that found the child after all
// (`empty` -> `ok`: some of the window's activity rows had not been read yet) had nothing left to make a timelapse from.
// The frames now stay until the stored verdict is final; lib/timelapse.js discardFinalEmptyNightFrames has the rule.
//
// HOW THIS IS OBSERVED. The real DB, the real frame folders, the real job and the real assembler; child_process is faked
// (helpers/fakeFfmpeg.js) so each ffmpeg pass is a process the test finishes. The clock is mocked and every stored
// `computed_at` is set explicitly: SQLite's datetime('now') default would read the real clock, not the mocked one.
// The timezone is not UTC on purpose, so a night date taken from the UTC calendar instead of the child's own would show.
//
// Which cases FAIL on the code before #419: every s* case (the sweep did not exist), j1-j3 (the first `empty` pass
// deleted the frames) and j4 (no tick discarded anything it had not just scored). The guards each s* case names are
// also covered by the #419 entries in scripts/mutants.json.
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
  assembleTimelapse, discardFinalEmptyNightFrames, retryStrandedTimelapses, resetRetryStateForTest, frameDir,
} = await import('../src/lib/timelapse.js');
const { runNightlySleepJob, currentNightDate } = await import('../src/lib/sleepAnalysis.js');
const { saveNightReview } = await import('../src/lib/sleepReviews.js');

// America/Los_Angeles in July is UTC-7 (no DST change near these dates). Every child's window is 19:00-07:00 local, so
// night N's window closes at 07:00 on N+1 and its evidence is final at 10:00 on N+1 (WAKE_LOOKAHEAD_MS, 3 h).
const TZ = 'America/Los_Angeles';
const OFFSET_MS = 7 * 3_600_000;
const local = (h, m, dayShift = 0) => new Date(Date.UTC(2026, 6, 1 + dayShift, h, m) + OFFSET_MS);
const sql = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
const NIGHT = '2026-07-01';
const WINDOW_END = local(7, 0, 1);
const HORIZON = local(10, 0, 1);

const KID = 'kid-419'; // tracked, with a camera: the job scores this child's nights (j* cases)
const CAM = 'cam-419';
const U = 'child-419'; // not tracked: the sweep's own cases (s*) use it, and the job never scores it
const OTHER = 'child-419-b'; // not tracked: a neighbour whose frames must survive

const framesOf = (child, night) => {
  const d = frameDir(child, night);
  return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => /^f-\d+\.jpg$/.test(f)).length : 0;
};
const putFrames = (child, night, n = 30) => {
  const d = frameDir(child, night);
  fs.mkdirSync(d, { recursive: true });
  for (let i = 0; i < n; i++) fs.writeFileSync(path.join(d, `f-${1000 + i}.jpg`), 'frame');
};
// A stored night, every time field explicit. Night D's window is D 19:00 -> D+1 07:00 local unless `windowEnd` says
// otherwise (s6 stores a window from an earlier configuration).
function storeNight(child, night, status, { computedAt, windowEnd } = {}) {
  const [y, mo, d] = night.split('-').map(Number);
  const start = new Date(Date.UTC(y, mo - 1, d, 19, 0) + OFFSET_MS);
  const end = windowEnd ?? new Date(Date.UTC(y, mo - 1, d + 1, 7, 0) + OFFSET_MS);
  db.prepare(`INSERT OR REPLACE INTO sleep_nights (child_id, night_date, window_start, window_end, status, computed_at)
              VALUES (?, ?, ?, ?, ?, ?)`).run(child, night, sql(start), end instanceof Date ? sql(end) : end, status,
    sql(computedAt));
}
const statusOf = (child, night) =>
  db.prepare('SELECT status FROM sleep_nights WHERE child_id = ? AND night_date = ?').get(child, night)?.status;

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
const timelapseRow = (child, night) =>
  db.prepare('SELECT status FROM timelapses WHERE child_id = ? AND night_date = ?').get(child, night);
// Finish an assembly the way a working encoder would: the video, then its thumbnail.
async function succeed(child, night) {
  await until(() => assemblyOf(child, night).length > 0, `the assembly of ${child} ${night} to start`);
  const video = outFile(child, night);
  const thumb = video.replace(/\.mp4$/, '.jpg');
  fs.mkdirSync(path.dirname(video), { recursive: true });
  fs.writeFileSync(video, 'video');
  assemblyOf(child, night).at(-1).finish(0);
  await until(() => spawned.some((p) => p.args.at(-1) === thumb && !p.ended), 'the thumbnail pass to start');
  fs.writeFileSync(thumb, 'thumbnail');
  spawned.find((p) => p.args.at(-1) === thumb && !p.ended).finish(0);
  await until(() => timelapseRow(child, night)?.status === 'ready', `the timelapse of ${child} ${night} to be ready`);
}

// KID's samples: the occupied night the sleepInsights #351 tests use, three stretches of movement in an otherwise
// still window. Written in two halves, as the issue describes: the still minutes first (enough of the window watched,
// and nothing moving, so the night reads `empty`), the moving minutes later (now it reads `ok`).
const insertSample = db.prepare(
  `INSERT INTO activity_samples (camera_id, bucket_start, motion_level, motion_peak, sound_level, sound_peak,
     motion_frames, sound_windows) VALUES (?, ?, ?, ?, 0, 0, 1, 0)`
);
const MOVING = [[local(19, 0), local(19, 10)], [local(23, 0), local(23, 6)], [local(1, 0, 1), local(1, 9, 1)]];
function laySamples({ moving }) {
  for (let t = local(19, 0); t < WINDOW_END; t = new Date(t.getTime() + 60_000)) {
    const isMoving = MOVING.some(([a, b]) => t >= a && t < b);
    if (isMoving === moving) insertSample.run(CAM, sql(t), isMoving ? 0.4 : 0.0002, isMoving ? 0.6 : 0.0002);
  }
}

before(() => {
  db.prepare(`INSERT INTO settings (id, timezone) VALUES ('app', ?)
              ON CONFLICT(id) DO UPDATE SET timezone = excluded.timezone`).run(TZ);
  makeChild(db, { id: KID, track: 1, start: '19:00', end: '07:00' });
  makeChild(db, { id: U, track: 0, start: '19:00', end: '07:00' });
  makeChild(db, { id: OTHER, track: 0, start: '19:00', end: '07:00' });
  db.prepare(`INSERT INTO cameras (id, name, rtsp_url, child_id, mediamtx_path)
              VALUES (?, 'Bed cam', 'rtsp://example/stream', ?, 'cam419')`).run(CAM, KID);
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
  for (const table of ['sleep_nights', 'sleep_reviews', 'timelapses']) db.prepare(`DELETE FROM ${table}`).run();
  db.prepare('DELETE FROM activity_samples').run();
  fs.rmSync(path.join(CLIPS_DIR, '.timelapse-frames'), { recursive: true, force: true });
  fs.rmSync(path.join(CLIPS_DIR, 'timelapse'), { recursive: true, force: true });
});
afterEach(async () => {
  for (const proc of spawned) proc.finish(1);
  await settle();
  mock.timers.reset();
});
const at = (when) => mock.timers.enable({ apis: ['Date', 'setTimeout'], now: when.getTime() });

// --- the sweep on its own -------------------------------------------------------------------------------------------

test('s1: a final empty night loses its frames; its neighbours (another child, another night, no row, a deleted child) keep theirs', () => {
  at(local(10, 30, 1));
  storeNight(U, NIGHT, 'empty', { computedAt: HORIZON });
  putFrames(U, NIGHT);
  // Hostile neighbours, each one condition away from the target.
  storeNight(OTHER, NIGHT, 'ok', { computedAt: HORIZON });
  putFrames(OTHER, NIGHT);
  storeNight(U, '2026-06-30', 'ok', { computedAt: local(10, 0) });
  putFrames(U, '2026-06-30');
  putFrames(U, '2026-06-29'); // frames with no stored night at all
  storeNight('child-gone-419', NIGHT, 'empty', { computedAt: HORIZON }); // a row whose child no longer exists
  putFrames('child-gone-419', NIGHT);

  assert.equal(discardFinalEmptyNightFrames(), 1);
  assert.equal(fs.existsSync(frameDir(U, NIGHT)), false, 'the final empty night kept its frames');
  assert.equal(framesOf(OTHER, NIGHT), 30, "another child's ok night lost its frames");
  assert.equal(framesOf(U, '2026-06-30'), 30, "the same child's ok night lost its frames");
  assert.equal(framesOf(U, '2026-06-29'), 30, 'a night with no stored verdict lost its frames');
  assert.equal(framesOf('child-gone-419', NIGHT), 30, "a deleted child's frames were taken by the sweep, not the purge");
});

test('s2: an empty night inside its 3-hour window keeps its frames (the moment the old code deleted them)', () => {
  at(local(7, 5, 1)); // the job's first pass after the window closed, as it would have stored the night
  storeNight(U, NIGHT, 'empty', { computedAt: local(7, 5, 1) });
  putFrames(U, NIGHT);
  assert.equal(discardFinalEmptyNightFrames(), 0);
  assert.equal(framesOf(U, NIGHT), 30);
});

test('s3: past the horizon, an empty night still owed a pass (computed before the horizon) keeps its frames while it is the last completed night, and loses them once the next night closes', () => {
  // A row last written before the horizon is one the job still owes a pass: a night locked by a correction (which can
  // be taken back), or one whose last pass was refused or threw. That pass can still turn it `ok`.
  storeNight(U, NIGHT, 'empty', { computedAt: local(7, 5, 1) });
  putFrames(U, NIGHT);
  at(local(10, 30, 1));
  assert.equal(discardFinalEmptyNightFrames(), 0, 'discarded while a recompute is still owed');
  assert.equal(framesOf(U, NIGHT), 30);

  mock.timers.setTime(local(7, 5, 2).getTime()); // the next night's window has closed: the job never visits this one again
  assert.equal(discardFinalEmptyNightFrames(), 1, 'kept forever once nothing could change the verdict');
  assert.equal(fs.existsSync(frameDir(U, NIGHT)), false);
});

test('s4: the clock is checked as well as the row: a row computed at the horizon is not discarded while the clock reads earlier', () => {
  // A clock set back (a server that booted before its time sync, a restored database). Every other condition holds,
  // so this is the only case where `now` alone decides.
  at(local(9, 0, 1));
  storeNight(U, NIGHT, 'empty', { computedAt: HORIZON });
  putFrames(U, NIGHT);
  assert.equal(discardFinalEmptyNightFrames(), 0);
  assert.equal(framesOf(U, NIGHT), 30);
});

test('s5: a night a parent marked "no one was in the bed", which the detector scored ok, keeps its frames (the mark deletes nothing)', () => {
  // docs/recording.md: the mark is reversible, and a tap must never destroy what taking it back could not restore.
  // The sweep reads the stored detector verdict only.
  at(local(10, 30, 1));
  storeNight(U, NIGHT, 'ok', { computedAt: HORIZON });
  db.prepare('INSERT INTO sleep_reviews (child_id, night_date, nobody_in_bed) VALUES (?, ?, 1)').run(U, NIGHT);
  putFrames(U, NIGHT);
  assert.equal(discardFinalEmptyNightFrames(), 0);
  assert.equal(framesOf(U, NIGHT), 30);
});

test("s6: the child's open night keeps its frames, even with a final empty row from an earlier sleep window", () => {
  // The night was stored `empty` under a daytime window (01:00-13:00), then the window was edited to 19:00-07:00,
  // which reopened that date: the sampler is writing to its folder again. Everything else says "discard".
  makeChild(db, { id: 'open-419', track: 0, start: '19:00', end: '07:00' });
  try {
    at(local(23, 0));
    assert.equal(currentNightDate('open-419'), NIGHT, 'precondition: the night is open');
    storeNight('open-419', NIGHT, 'empty', { computedAt: local(16, 0), windowEnd: local(13, 0) });
    putFrames('open-419', NIGHT);
    assert.equal(discardFinalEmptyNightFrames(), 0);
    assert.equal(framesOf('open-419', NIGHT), 30);
  } finally {
    db.prepare('DELETE FROM children WHERE id = ?').run('open-419');
  }
});

test('s7: a night being assembled is not touched; once that assembly has failed, the next sweep discards it', async () => {
  // How it happens: the retry starts encoding an ok night and an admin Recompute re-scores it empty meanwhile.
  at(local(10, 30, 1));
  putFrames(U, NIGHT);
  const assembly = assembleTimelapse(U, NIGHT);
  await until(() => assemblyOf(U, NIGHT).length > 0, 'the assembly to start');
  storeNight(U, NIGHT, 'empty', { computedAt: HORIZON });
  assert.equal(discardFinalEmptyNightFrames(), 0, 'deleted the frames an encoder is reading');
  assert.equal(framesOf(U, NIGHT), 30);

  assemblyOf(U, NIGHT)[0].finish(1); // fails: the failure path keeps the frames
  assert.equal(await assembly, null);
  assert.equal(framesOf(U, NIGHT), 30);
  assert.equal(discardFinalEmptyNightFrames(), 1);
  assert.equal(fs.existsSync(frameDir(U, NIGHT)), false);
});

test('s8: a folder whose night name is not a date is skipped, even with a matching final empty row', () => {
  // The names come off the disk. frameDir would accept this one (it is a plain segment), so only the date check stops it.
  at(local(10, 30, 1));
  const odd = `${NIGHT}.old`;
  storeNight(U, NIGHT, 'empty', { computedAt: HORIZON });
  db.prepare('UPDATE sleep_nights SET night_date = ? WHERE child_id = ? AND night_date = ?').run(odd, U, NIGHT);
  putFrames(U, odd);
  assert.equal(discardFinalEmptyNightFrames(), 0);
  assert.equal(framesOf(U, odd), 30);
});

test('s9: a night whose stored row cannot be read does not stop the pass; the error is logged', () => {
  at(local(10, 30, 1));
  // The newest night first (the sweep goes newest first), with a window_end stored as a blob: reading it as a time
  // throws. (A number would not do: the column's TEXT affinity turns it into text, which merely fails to parse.)
  storeNight(U, '2026-07-01', 'empty', { computedAt: HORIZON, windowEnd: Buffer.from('not a time') });
  putFrames(U, '2026-07-01');
  storeNight(U, '2026-06-30', 'empty', { computedAt: local(10, 0) });
  putFrames(U, '2026-06-30');
  assert.equal(discardFinalEmptyNightFrames(), 1);
  assert.equal(fs.existsSync(frameDir(U, '2026-06-30')), false, 'one bad night stopped the rest of the pass');
  assert.equal(framesOf(U, '2026-07-01'), 30);
  assert.ok(logger.getRecent().some((l) => l.includes('empty-night sweep of child-419 2026-07-01 failed')), 'no error logged');
});

// --- through the nightly job ----------------------------------------------------------------------------------------

test("j1: the issue's case: the first pass says empty and keeps the frames; the pass that finds the child starts the timelapse itself, even while the retry is busy", async () => {
  putFrames(KID, NIGHT);
  laySamples({ moving: false });
  at(local(7, 5, 1));
  runNightlySleepJob();
  await settle();
  assert.equal(statusOf(KID, NIGHT), 'empty', 'precondition: the still minutes alone read as an empty bed');
  assert.equal(framesOf(KID, NIGHT), 30, 'the first empty pass deleted the frames');
  assert.equal(assemblyOf(KID, NIGHT).length, 0);

  // The retry is busy encoding another night, so only the job's own start can make this night's video on this tick.
  storeNight(OTHER, '2026-06-20', 'ok', { computedAt: local(10, 0, -11) });
  putFrames(OTHER, '2026-06-20');
  const busy = retryStrandedTimelapses();
  await until(() => assemblyOf(OTHER, '2026-06-20').length > 0, 'the retry to start encoding the other night');

  laySamples({ moving: true }); // the rest of the window's rows arrive
  mock.timers.setTime(local(7, 35, 1).getTime());
  runNightlySleepJob();
  await settle();
  assert.equal(statusOf(KID, NIGHT), 'ok', 'precondition: the later pass found the child');
  assert.equal(assemblyOf(KID, NIGHT).length, 1, 'the empty -> ok pass did not start the timelapse');
  await succeed(KID, NIGHT);
  assert.equal(framesOf(KID, NIGHT), 0, 'the assembled frames were kept');

  assemblyOf(OTHER, '2026-06-20')[0].finish(1);
  await busy;
});

test('j2: an owed pass exactly at the horizon that turns the night ok keeps the frames and makes the timelapse', async () => {
  putFrames(KID, NIGHT);
  laySamples({ moving: false });
  at(local(7, 5, 1));
  runNightlySleepJob();
  await settle();
  assert.equal(statusOf(KID, NIGHT), 'empty');

  laySamples({ moving: true });
  mock.timers.setTime(HORIZON.getTime()); // no tick in between (the server was down): this pass is owed and final at once
  runNightlySleepJob();
  await settle();
  assert.equal(statusOf(KID, NIGHT), 'ok');
  await succeed(KID, NIGHT);
  assert.equal(assemblyOf(KID, NIGHT).length, 1, 'the job and the retry both encoded the night');
});

test('j3: a night locked empty by a correction keeps its frames past the horizon; taking the correction back lets the owed pass make its timelapse', async () => {
  putFrames(KID, NIGHT);
  laySamples({ moving: false });
  at(local(7, 5, 1));
  runNightlySleepJob();
  await settle();
  saveNightReview(KID, NIGHT, { trueWakeAt: sql(local(6, 10, 1)) }); // locks the stored `empty` row
  laySamples({ moving: true });

  mock.timers.setTime(local(10, 30, 1).getTime());
  runNightlySleepJob();
  await settle();
  assert.equal(statusOf(KID, NIGHT), 'empty', 'precondition: the lock kept the job away');
  assert.equal(framesOf(KID, NIGHT), 30, 'the frames of a night the parent can still unlock were deleted');

  db.prepare('DELETE FROM sleep_reviews WHERE child_id = ? AND night_date = ?').run(KID, NIGHT);
  mock.timers.setTime(local(11, 0, 1).getTime());
  runNightlySleepJob();
  await settle();
  assert.equal(statusOf(KID, NIGHT), 'ok', 'precondition: the owed pass ran once the correction was gone');
  await succeed(KID, NIGHT);
});

test('j4: every tick of the nightly job runs the sweep, with or without a night to score', async () => {
  // U is not tracked, so nothing in the job's own loop touches this night: only the sweep can.
  at(local(12, 0, 1));
  storeNight(U, NIGHT, 'empty', { computedAt: HORIZON });
  putFrames(U, NIGHT);
  runNightlySleepJob();
  await until(() => !fs.existsSync(frameDir(U, NIGHT)), "the tick to discard the final empty night's frames");
});
