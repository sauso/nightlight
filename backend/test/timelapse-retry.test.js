// #450: a night that has frames but no video is assembled again, once at a time.
//
// THE DEFECT. The nightly job started one assembly per night, on the night's first scored pass. A failure left the row
// `failed` with its frames kept "so a later retry can still assemble", and no later retry existed. A restart mid-assembly
// left the row `pending` with the same result, and a night whose first attempt ran before clip storage was probed (the job
// runs at boot, before startClipStorage) left no row at all. See lib/timelapse.js retryStrandedTimelapses.
//
// HOW THIS IS OBSERVED. The real assembler, DB and frame folders; child_process is faked (helpers/fakeFfmpeg.js) so each
// ffmpeg pass is a process the test finishes with an exit code. Every assertion is on the processes spawned, the rows and the
// files on disk. Clip storage "not ready" is the real guard fed an empty mounts list.
//
// Which cases FAIL on the code before #450: a1, b1 (no retry exists, so the export is missing), c1, d1 (two passes), d2,
// e1, e2, g1. Guards that pass there too only because the feature is absent are f1-f6: they fail on a retry that ignores
// the condition each names (see the #450 entries in scripts/mutants.json).
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
const { assembleTimelapse, retryStrandedTimelapses, resetRetryStateForTest, frameDir } = await import('../src/lib/timelapse.js');
const { runNightlySleepJob } = await import('../src/lib/sleepAnalysis.js');

// track=0: the nightly job's own loop skips this child, so the hook test (g1) sees only the retry pass.
const CHILD = 'child-450';
const NIGHT = '2026-10-18';
const dir = frameDir(CHILD, NIGHT);
const outFile = path.join(CLIPS_DIR, 'timelapse', CHILD, `${NIGHT}.mp4`);
const thumbFile = path.join(CLIPS_DIR, 'timelapse', CHILD, `${NIGHT}.jpg`);
const flush = () => new Promise((resolve) => setImmediate(resolve));
async function until(pred, what = 'the condition') {
  for (let i = 0; i < 500; i++) {
    if (pred()) return;
    await flush();
  }
  assert.fail(`timed out waiting for ${what}`);
}
function track(p) {
  const state = { value: 'pending' };
  p.then((value) => { state.value = value; }, () => { state.value = 'rejected'; });
  return state;
}
const row = () => db.prepare('SELECT * FROM timelapses WHERE child_id = ? AND night_date = ?').get(CHILD, NIGHT);
const rowCount = () => db.prepare('SELECT COUNT(*) AS n FROM timelapses WHERE child_id = ? AND night_date = ?').get(CHILD, NIGHT).n;
const assembleProcs = () => spawned.filter((p) => p.args.at(-1) === outFile);
const thumbProcs = () => spawned.filter((p) => p.args.at(-1) === thumbFile);
const frameCount = () => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^f-\d+\.jpg$/.test(f)).length : 0);
const putFrames = (n = 30, d = dir) => {
  fs.mkdirSync(d, { recursive: true });
  for (let i = 0; i < n; i++) fs.writeFileSync(path.join(d, `f-${i}.jpg`), 'frame');
};
const scoreNight = (status, child = CHILD, night = NIGHT) =>
  db.prepare(`INSERT OR REPLACE INTO sleep_nights (child_id, night_date, window_start, window_end, status)
              VALUES (?, ?, ?, ?, ?)`).run(child, night, `${night} 19:30:00`, `${night} 07:00:00`, status);
// Finish the Nth assembly pass (0-based) the way a working encoder would: the video, then its thumbnail. Only a pass that
// succeeds reaches the thumbnail step, so the thumbnail process is the next one after those already seen.
async function succeed(n) {
  const thumbsBefore = thumbProcs().length;
  await until(() => assembleProcs().length > n, `assembly pass ${n + 1} to start`);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, 'video');
  assembleProcs()[n].finish(0);
  await until(() => thumbProcs().length > thumbsBefore, 'the thumbnail pass to start');
  fs.writeFileSync(thumbFile, 'thumbnail');
  thumbProcs()[thumbsBefore].finish(0);
}
async function fail(n) {
  await until(() => assembleProcs().length > n, `assembly pass ${n + 1} to start`);
  assembleProcs()[n].finish(1);
}

before(() => {
  makeChild(db, { id: CHILD, track: 0 });
  checkClipStorage({ mounts: null });
});
after(() => {
  db.close();
  cleanupTempDataDirs();
});
beforeEach(() => {
  mock.timers.enable({ apis: ['setTimeout'] });
  spawned.length = 0;
  logger.clear();
  resetRetryStateForTest();
  checkClipStorage({ mounts: null });
  db.prepare('DELETE FROM timelapses').run();
  db.prepare('DELETE FROM sleep_nights').run();
  fs.rmSync(path.join(CLIPS_DIR, '.timelapse-frames'), { recursive: true, force: true });
  fs.rmSync(path.dirname(outFile), { recursive: true, force: true });
  putFrames();
  scoreNight('ok');
});
afterEach(async () => {
  for (const proc of spawned) proc.finish(1);
  await flush();
  mock.timers.reset();
});

test('a1: the first assembly fails and keeps its frames; once the encoder works, the retry makes ONE ready video', async () => {
  const first = track(assembleTimelapse(CHILD, NIGHT));
  await fail(0);
  await until(() => first.value !== 'pending', 'the first attempt to settle');
  assert.equal(first.value, null);
  assert.equal(row().status, 'failed');
  assert.equal(frameCount(), 30, 'precondition: the failed attempt kept its frames');

  const retry = track(retryStrandedTimelapses());
  await succeed(1);
  await until(() => retry.value !== 'pending', 'the retry to finish');
  assert.equal(retry.value, 1, 'one assembly started');
  assert.equal(rowCount(), 1, 'the retry duplicated the night');
  assert.equal(row().status, 'ready');
  assert.equal(frameCount(), 0, 'the frames outlived a successful assembly');
  assert.equal(fs.existsSync(outFile), true);
});

test('b1: a night with NO row (the first attempt ran before storage was probed) is assembled by the retry; not-ready passes spend no attempt', async () => {
  checkClipStorage({ mounts: '' }); // "not a mapped volume": clipStorageReady() is false, as at boot
  assert.equal(await assembleTimelapse(CHILD, NIGHT), null);
  assert.equal(row(), undefined, 'precondition: the first attempt left no row');
  assert.equal(frameCount(), 30);
  // More not-ready passes than there are retries: each must be free, or the night would be given up on before it ever ran.
  for (let i = 0; i < 5; i++) assert.equal(await retryStrandedTimelapses(), 0);
  assert.equal(spawned.length, 0);

  checkClipStorage({ mounts: null });
  const retry = track(retryStrandedTimelapses());
  await succeed(0);
  await until(() => retry.value !== 'pending', 'the retry to finish');
  assert.equal(retry.value, 1);
  assert.equal(row().status, 'ready');
});

test('c1: a pending row left by an interrupted assembly (nothing in flight) is assembled by the retry', async () => {
  db.prepare("INSERT INTO timelapses (child_id, night_date, status) VALUES (?, ?, 'pending')").run(CHILD, NIGHT);
  const retry = track(retryStrandedTimelapses());
  await succeed(0);
  await until(() => retry.value !== 'pending', 'the retry to finish');
  assert.equal(rowCount(), 1);
  assert.equal(row().status, 'ready');
});

test('d1: two overlapping assemblies of one night run ONE ffmpeg pass; the second returns null at once', async () => {
  const a = track(assembleTimelapse(CHILD, NIGHT));
  const b = track(assembleTimelapse(CHILD, NIGHT));
  await until(() => assembleProcs().length > 0, 'the assembly to start');
  await flush();
  assert.equal(b.value, null, 'the second call waited for, or duplicated, the first');
  assert.equal(assembleProcs().length, 1, 'two ffmpeg passes for one night');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, 'video');
  assembleProcs()[0].finish(0);
  await until(() => thumbProcs().length > 0, 'the thumbnail pass to start');
  thumbProcs()[0].finish(0);
  await until(() => a.value !== 'pending', 'the first assembly to finish');
  assert.equal(row().status, 'ready');
});

test('d2: a retry pass leaves a night alone while its first attempt is still in flight', async () => {
  const first = track(assembleTimelapse(CHILD, NIGHT));
  await until(() => assembleProcs().length > 0, 'the assembly to start');
  assert.equal(await retryStrandedTimelapses(), 0, 'the retry started a second pass beside the first');
  assert.equal(assembleProcs().length, 1);
  assembleProcs()[0].finish(1);
  await until(() => first.value !== 'pending', 'the first attempt to settle');
  // Released in a finally: the night can be attempted again (kills a guard key that is never removed).
  const retry = track(retryStrandedTimelapses());
  await succeed(1);
  await until(() => retry.value !== 'pending', 'the retry to finish');
  assert.equal(row().status, 'ready');
});

test('e1: a night that keeps failing is attempted MAX_RETRIES (3) times in this process, then left alone, with one give-up line', async () => {
  for (let i = 0; i < 3; i++) {
    const pass = track(retryStrandedTimelapses());
    await fail(i);
    await until(() => pass.value !== 'pending', `retry pass ${i + 1} to finish`);
    assert.equal(pass.value, 1);
  }
  assert.equal(await retryStrandedTimelapses(), 0, 'a fourth attempt was made');
  assert.equal(assembleProcs().length, 3);
  assert.equal(frameCount(), 30, 'the frames of a night we gave up on were deleted');
  const lines = logger.getRecent().filter((l) => l.includes('giving up on'));
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.ok(lines[0].includes(dir), 'the line does not say where the frames are');
});

test('e2: a success clears the count, so the night is not "given up on" by earlier failures', async () => {
  for (let i = 0; i < 2; i++) {
    const pass = track(retryStrandedTimelapses());
    await fail(i);
    await until(() => pass.value !== 'pending', `retry pass ${i + 1} to finish`);
  }
  const pass = track(retryStrandedTimelapses());
  await succeed(2);
  await until(() => pass.value !== 'pending', 'the third pass to finish');
  assert.equal(row().status, 'ready');
});

test('f1: fewer than 30 frames are not retried and are left on disk', async () => {
  fs.rmSync(dir, { recursive: true, force: true });
  putFrames(29);
  assert.equal(await retryStrandedTimelapses(), 0);
  assert.equal(spawned.length, 0);
  assert.equal(frameCount(), 29);
});

test('f2: a night that is not scored "ok" (empty, or not scored at all) is not retried', async () => {
  scoreNight('empty');
  assert.equal(await retryStrandedTimelapses(), 0);
  db.prepare('DELETE FROM sleep_nights').run();
  assert.equal(await retryStrandedTimelapses(), 0);
  assert.equal(spawned.length, 0);
  assert.equal(frameCount(), 30);
});

test('f3: a night that already has a ready video is not assembled again', async () => {
  db.prepare("INSERT INTO timelapses (child_id, night_date, status, path) VALUES (?, ?, 'ready', 'x.mp4')").run(CHILD, NIGHT);
  assert.equal(await retryStrandedTimelapses(), 0);
  assert.equal(spawned.length, 0);
});

test('f4: frames of a child that no longer exists are not assembled', async () => {
  const ghost = frameDir('child-gone-450', NIGHT);
  putFrames(30, ghost);
  scoreNight('ok', 'child-gone-450');
  fs.rmSync(dir, { recursive: true, force: true }); // only the ghost's frames are candidates
  assert.equal(await retryStrandedTimelapses(), 0);
  assert.equal(spawned.length, 0);
  assert.equal(fs.existsSync(ghost), true, 'a retry deleted frames it did not assemble');
});

test('f5: a night the child\'s 30 newest ready videos already outrank is not encoded just to be pruned at once', async () => {
  const insert = db.prepare("INSERT INTO timelapses (child_id, night_date, status, path) VALUES (?, ?, 'ready', ?)");
  for (let i = 0; i < 30; i++) insert.run(CHILD, `2026-11-${String(i + 1).padStart(2, '0')}`, `n${i}.mp4`);
  assert.equal(await retryStrandedTimelapses(), 0);
  assert.equal(spawned.length, 0);
  assert.equal(frameCount(), 30);
});

test('f6: a pass is not re-entered: a second call while one is running starts nothing', async () => {
  const frames2 = frameDir(CHILD, '2026-10-17');
  putFrames(30, frames2);
  scoreNight('ok', CHILD, '2026-10-17');
  const first = track(retryStrandedTimelapses());
  await until(() => assembleProcs().length > 0, 'the first pass to start encoding');
  assert.equal(await retryStrandedTimelapses(), 0, 'a second pass started beside the first');
  assembleProcs()[0].finish(1);
  // The older night's output file has its own name, so it is found by that, not by assembleProcs().
  const olderProcs = () => spawned.filter((p) => String(p.args.at(-1)).endsWith('2026-10-17.mp4'));
  await until(() => olderProcs().length > 0, 'the first pass to move on to the older night');
  olderProcs()[0].finish(1);
  await until(() => first.value !== 'pending', 'the first pass to finish');
  assert.equal(first.value, 2);
});

test('g1: the nightly job\'s tick starts the retry, with or without a night to score', async () => {
  runNightlySleepJob();
  await succeed(0);
  await until(() => row()?.status === 'ready', 'the night to become ready');
  assert.equal(rowCount(), 1);
});
