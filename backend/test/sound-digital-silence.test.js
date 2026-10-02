// Issue #453, the DETECTOR side: an all-zero audio window (digital silence) is an observed, quiet window,
// not a missing one. The analyser half (what a silent window does to the ambient, the trailing window and the
// alert rules) is soundBaseline.test.js's "#453" block; this file proves the REAL sound detector delivers it:
//   C2   a stream of nothing but zero PCM stores a quiet per-minute row (sound_windows > 0, sound_peak 0),
//        logs its level line, and never alerts; a stream of NO bytes stores nothing, so a missing stream is
//        still told apart from a silent one; silent windows count in the minute's mean (interleaved with an
//        audible one); and a silent window is filed under its stdout event's RECEIPT minute (#447), not the
//        detector's own clock;
//   C2b  a leg that received only zero PCM and exited within 10 s is not a "does this camera have a
//        microphone?" strike, while one that received no bytes at all still is (the control);
//   C3b  a minute of nothing but silence reaches the live wake watcher exactly as a quiet audible minute with
//        no motion already did before #453: the same call, the same watcher state;
//   D2   (fix round 1) the 15-second level line's `maxAvgOver` counts silent windows too.
// The other half of C2c (a watchdog kill is never a strike) is #369's C14a, in detector-watchdog-levers.test.js,
// and is not duplicated here.
//
// Before #453 every one of these failed (shown on dev e9e5d83 in the PR): the detector returned on a non-finite
// level before it set `sawReading`, before the analyser and before recordSound, so a muted or gated microphone
// produced no sound row at all and looked, to the strike rule, like no microphone.
//
// HOW (the detector-observation-wiring.test.js pattern, sharing helpers/fakeFfmpeg.js):
//   * ffmpeg is faked by mocking `node:child_process` ONLY. ⚠️ It is not in test:core's include list; mocking an
//     included module corrupts coverage for the whole suite, so the DB, the activity tracker, the analyser, the
//     wake watcher and the logger are all real.
//   * MediaMTX is a real local HTTP server reporting every path ready (the detectors wait for that).
//   * `Date` is mocked (mock.timers, apis ['Date']) and set before each delivery; setTimeout stays REAL, so
//     C2b's 5 s relaunches run for real (~15 s of wall time).
//   * The observation clock is a stub whose receipt time is the mocked Date unless a test plants another.
import { test, mock, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupTempDataDirs, makeCamera, makeChild } from './helpers/harness.js';
import { FakeFfmpeg, startFakeMediamtx } from './helpers/fakeFfmpeg.js';

useTempDataDir();

// ⚠️ ORDER MATTERS: mediamtx.js reads MEDIAMTX_API at module load (see helpers/fakeFfmpeg.js).
const mediamtx = await startFakeMediamtx();

const procs = [];
mock.module('node:child_process', {
  exports: {
    spawn(command, args) {
      const proc = new FakeFfmpeg(command, args);
      if (args.includes('s16le')) procs.push(proc);
      else proc.finish(1); // snapshot grabs and the like: fail at once, no network
      return proc;
    },
  },
});

const { default: db } = await import('../src/db.js');
const { logger } = await import('../src/lib/logger.js');
const { flushActivity, onMinuteFlushed, _resetActivityTrackerForTests } = await import('../src/lib/activityTracker.js');
const { startSoundDetector, stopSoundDetector } = await import('../src/lib/soundDetector.js');
const { _setObservationClockFactoryForTests } = await import('../src/lib/observationClock.js');
const { handleMinute, _state } = await import('../src/lib/wakeWatcher.js');
const { createSoundAnalyser, marginDb } = await import('../src/lib/soundBaseline.js');

// The receipt time the stub clock hands out: the mocked Date, unless a test plants another (C2's minute boundary).
let plantedWall = null;
_setObservationClockFactoryForTests(() => ({
  receipt: () => ({ mono: Date.now(), wall: plantedWall ?? Date.now() }),
  beginGeneration: () => ({ onRecord() {}, onConfig() {}, onParseError() {}, onSample() {}, end() {} }),
}));

after(async () => {
  _setObservationClockFactoryForTests(null);
  await mediamtx.close();
  cleanupTempDataDirs();
});
beforeEach(() => {
  _resetActivityTrackerForTests();
  plantedWall = null;
});

const T0 = Date.UTC(2026, 8, 25, 12, 0, 0);
const STEP_MS = 200; // one 1600-sample window at 8 kHz
const PAST_GRACE_MS = 8_000; // past activityTracker's 7 s GRACE_MS (pinned with literal times in its own tests)

// --- PCM ----------------------------------------------------------------------------------------------------
// A 440 Hz tone is exactly 88 cycles in a 1600-sample window, so every window of one amplitude is byte-identical
// whatever its position in the stream: an ambient run is the SAME level every window, and the analyser's floor,
// once seeded on it, sits exactly on it (each EMA step is 0). That is what lets the expected rows below be
// worked out from the planted bytes alone.
const WIN_SAMPLES = 1600;
function tone(amp) {
  const w = Buffer.alloc(WIN_SAMPLES * 2);
  for (let i = 0; i < WIN_SAMPLES; i++) w.writeInt16LE(Math.round(amp * Math.sin((2 * Math.PI * 440 * i) / 8000)), i * 2);
  return w;
}
const SILENT = Buffer.alloc(WIN_SAMPLES * 2); // all zeros: rms 0, level -Infinity
const AMBIENT = tone(1000); // about -33 dBFS
const LOUD = tone(4000); // +12.04 dB over AMBIENT: one window of it never fills the 4 s confirm window
// A window's level exactly as soundDetector.js computes it (same expression, same summation order).
function levelOf(win) {
  let sumSq = 0;
  for (let i = 0; i < win.length; i += 2) {
    const s = win.readInt16LE(i);
    sumSq += s * s;
  }
  return 20 * Math.log10(Math.sqrt(sumSq / WIN_SAMPLES) / 32768);
}
const rep = (n, v) => Array.from({ length: n }, () => v);

// --- harness ------------------------------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Poll on performance.now(), NOT Date: Date is frozen by the mock.
async function waitFor(pred, what, capMs = 25_000) {
  const deadline = performance.now() + capMs;
  while (!pred()) {
    if (performance.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await sleep(10);
  }
}
async function settle() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}
const procsFor = (cam) => procs.filter((p) => p.args.includes(`rtsp://127.0.0.1:8554/${cam.mediamtx_path}`));
const linesFor = (needle) => logger.getRecent().filter((l) => l.includes(needle));
const stripTime = (l) => l.replace(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} /, '');

function soundCam(id, { childId = null } = {}) {
  const cam = {
    id,
    name: `Silence ${id}`,
    mediamtx_path: `path_${id}`,
    disabled: 0,
    child_id: childId,
    detect_sound_enabled: 1,
    sound_sensitivity: 50,
    sound_confirm_s: 4,
    sound_cooldown_s: 120,
    detect_schedule_enabled: 0,
    detect_record_clips: 0,
    snapshot_url: null,
  };
  makeCamera(db, { id, name: cam.name, path: cam.mediamtx_path, childId });
  return cam;
}
async function start(cam) {
  await startSoundDetector(cam);
  await waitFor(() => procsFor(cam).length === 1, `the ${cam.id} sound ffmpeg`);
  return procsFor(cam)[0];
}
// One window per stdout read, window k produced (and received) at startMs + k * STEP_MS.
function deliver(t, proc, windows, startMs) {
  windows.forEach((w, k) => {
    t.mock.timers.setTime(startMs + k * STEP_MS);
    proc.stdout.emit('data', w);
  });
}
// Every column except `id` and `created_at`, derived from the schema so a later column is pinned too.
const UNCONTROLLED = new Set(['id', 'created_at']);
function rowsFor(table, cameraId) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name).filter((c) => !UNCONTROLLED.has(c));
  return db.prepare(`SELECT ${cols.join(', ')} FROM ${table} WHERE camera_id = ? ORDER BY id`).all(cameraId);
}
// What an activity row with no video looks like: every motion column empty.
const NO_VIDEO = { motion_level: null, motion_peak: null, motion_frames: 0, motion_out_level: null, motion_out_peak: null };

// ---------------------------------------------------------------------------------------------------------------
test('#453 C2: a stream of nothing but digital silence is a quiet room from its first window: stored, logged, never alerted', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: T0 });
  logger.clear();
  const cam = soundCam('c2-silent');
  const proc = await start(cam);
  deliver(t, proc, rep(350, SILENT), T0); // 70 s: all of 12:00 and the first 10 s of 12:01
  await stopSoundDetector(cam.id);
  await settle();
  flushActivity(T0 + 120_000 + PAST_GRACE_MS);

  // No ambient is ever learned (silence is not evidence of one), and still every window is a quiet
  // observation: "heard, nothing above ambient", stored as 0 with its windows counted. Before #453: no row.
  const quiet = { ...NO_VIDEO, sound_level: 0, sound_peak: 0, sound_p75: 0, sound_p90: 0, sound_sd: 0 };
  assert.deepEqual(rowsFor('activity_samples', cam.id), [
    { camera_id: cam.id, bucket_start: '2026-09-25 12:00:00', ...quiet, sound_windows: 300 },
    { camera_id: cam.id, bucket_start: '2026-09-25 12:01:00', ...quiet, sound_windows: 50 },
  ]);
  assert.deepEqual(rowsFor('detection_events', cam.id), [], 'silence never alerts');
  // A muted microphone still prints its 15-second level line (at 15, 30, 45 and 60 s): nothing learned yet
  // (`ambient=?`), no audible peak (`peak=?`), no confirmed trailing window (`maxAvgOver=?`).
  assert.deepEqual(
    linesFor(`[sound] "${cam.name}" ambient=`).map(stripTime),
    rep(4, `[INFO] [sound] "${cam.name}" ambient=?dB peak=?dB maxAvgOver=? (fires at +11)`)
  );
});

test('#453 D2: a level line whose 15 s were all silent still reports the trailing average its silent windows saw', async (t) => {
  // Found by the code review (2026-10-02) as a surviving mutant: leaving silent windows out of the level
  // line's `maxAvgOver` changed nothing any test looked at. It matters right after a sound: the confirm
  // window still holds it while the room has gone silent, and that average is what the line is for.
  t.mock.timers.enable({ apis: ['Date'], now: T0 });
  logger.clear();
  const cam = soundCam('d2-level');
  const proc = await start(cam);
  // 0-12.8 s ambient (the first 25 windows seed the floor), 13.0-14.8 s a burst, then silence from 15.0 s
  // (k = 75) to 30.0 s (k = 150). Line 1 is written at k = 75, BEFORE that window is pushed; line 2 at
  // k = 150, so it covers exactly the 75 silent pushes 75-149 and no audible one.
  const windows = [...rep(65, AMBIENT), ...rep(10, LOUD), ...rep(76, SILENT)];
  deliver(t, proc, windows, T0);
  await stopSoundDetector(cam.id);
  await settle();
  // What line 2 must say, from the analyser fed the same windows at the same times: the largest confirmed
  // trailing average among pushes 75-149, and the floor as it stood before push 150.
  const a = createSoundAnalyser({ margin: marginDb(50), trailN: 20, cooldownMs: 120_000, readingMs: STEP_MS });
  let max = -Infinity;
  windows.slice(0, 150).forEach((w, k) => {
    const r = a.push(levelOf(w), T0 + k * STEP_MS);
    if (k >= 75 && r.confirmed && r.over > max) max = r.over;
  });
  assert.ok(max > 1, `the silent windows' trailing average still held the burst: ${max}`);
  const lines = linesFor(`[sound] "${cam.name}" ambient=`).map(stripTime);
  assert.equal(lines.length, 2);
  assert.equal(lines[1], `[INFO] [sound] "${cam.name}" ambient=${a.baseline.toFixed(1)}dB peak=?dB maxAvgOver=+${max.toFixed(1)} (fires at +11)`);
  assert.deepEqual(rowsFor('detection_events', cam.id), [], 'a burst that never fills the confirm window is not an alert');
});

test('#453 C2 (guard): a stream that delivers NO bytes stores no sound row at all, so a missing stream is still told apart', async (t) => {
  // The other half of the distinction: no bytes -> handleReading never runs -> no recordSound, sound_peak stays
  // NULL (here: no row at all). Passes before #453 too; it pins that the fix did not invent observations.
  t.mock.timers.enable({ apis: ['Date'], now: T0 });
  const cam = soundCam('c2-nobytes');
  await start(cam);
  t.mock.timers.setTime(T0 + 70_000);
  await stopSoundDetector(cam.id);
  await settle();
  flushActivity(T0 + 120_000 + PAST_GRACE_MS);
  assert.deepEqual(rowsFor('activity_samples', cam.id), []);
});

test('#453 C2: silent windows count in the minute (before the ambient is learned, and between audible ones), filed under their RECEIPT minute', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: T0 });
  const cam = soundCam('c2-mixed');
  const proc = await start(cam);
  // 12:00: 10 silent windows BEFORE any ambient exists (each recorded as 0), then 30 ambient windows: the first
  // 25 seed the floor (recording nothing, the documented asymmetry) and the last 5 record exactly 0.
  deliver(t, proc, [...rep(10, SILENT), ...rep(30, AMBIENT)], T0);
  // 12:01: one LOUD window, then 9 silent ones.
  deliver(t, proc, [LOUD, ...rep(9, SILENT)], T0 + 60_000);
  // ...and one read carrying 5 more silent windows, RECEIVED at 12:01:59.9 while the detector's clock already
  // reads 12:02:00.1 (the #447 receipt test's shape): they belong to 12:01.
  plantedWall = T0 + 119_900;
  t.mock.timers.setTime(T0 + 120_100);
  proc.stdout.emit('data', Buffer.concat(rep(5, SILENT)));
  plantedWall = null;
  await stopSoundDetector(cam.id);
  await settle();
  flushActivity(T0 + 180_000 + PAST_GRACE_MS);

  // Worked out from the planted bytes, not from the detector: the floor is exactly AMBIENT's level, the loud
  // window scores LOUD's level minus it, and every silent window scores 0. 12:01 holds 1 + 9 + 5 = 15 windows.
  const peak = levelOf(LOUD) - levelOf(AMBIENT);
  assert.ok(peak > 12 && peak < 12.1, `the planted excursion is ~12.04 dB, got ${peak}`);
  const rows = rowsFor('activity_samples', cam.id);
  assert.deepEqual(rows.map((r) => r.bucket_start), ['2026-09-25 12:00:00', '2026-09-25 12:01:00'], 'nothing filed under 12:02');
  assert.deepEqual(rows[0], {
    camera_id: cam.id, bucket_start: '2026-09-25 12:00:00', ...NO_VIDEO,
    sound_level: 0, sound_peak: 0, sound_windows: 15, sound_p75: 0, sound_p90: 0, sound_sd: 0,
  });
  const { sound_level: level, sound_sd: sd, ...rest } = rows[1];
  assert.deepEqual(rest, {
    camera_id: cam.id, bucket_start: '2026-09-25 12:01:00', ...NO_VIDEO,
    sound_peak: peak, sound_windows: 15, sound_p75: 0, sound_p90: 0,
  });
  // The mean and the population sd of one `peak` and fourteen zeros: the silent windows really are in the mean.
  assert.ok(Math.abs(level - peak / 15) < 1e-12, `sound_level ${level}, want ${peak / 15}`);
  assert.ok(Math.abs(sd - peak * Math.sqrt(1 / 15 - 1 / 225)) < 1e-12, `sound_sd ${sd}`);
  assert.deepEqual(rowsFor('detection_events', cam.id), [], 'one loud window is not a sustained sound');
});

test('#453 C2b: a leg that received only digital silence and exited within 10 s is NOT a "no microphone" strike; one that received no bytes still is', async (t) => {
  // The strike rule (soundDetector.js, "does this camera have a microphone?") counts a quick exit that produced
  // no reading. A silent window IS a reading (the stream is delivering real zero bytes: a muted or gated mic),
  // so three such exits must not stop sound detection. The control, in the same harness and at the same moments,
  // is a leg that delivered nothing: it must still be stopped on its third quick exit, or this test could pass
  // on a fixture where no exit ever strikes. Date is frozen, so every exit is 0 ms after its spawn: "quick".
  t.mock.timers.enable({ apis: ['Date'], now: T0 });
  logger.clear();
  const silent = soundCam('c2b-silent');
  const dead = soundCam('c2b-dead');
  await startSoundDetector(silent);
  await startSoundDetector(dead);
  for (let k = 1; k <= 3; k++) {
    await waitFor(() => procsFor(silent).length === k && procsFor(dead).length === k, `spawn ${k} of both legs`);
    procsFor(silent)[k - 1].stdout.emit('data', SILENT);
    procsFor(silent)[k - 1].finish(1);
    procsFor(dead)[k - 1].finish(1);
  }
  await waitFor(() => linesFor(`[sound:${dead.mediamtx_path}] no audio readings after 3 tries`).length === 1,
    'the control: three quick exits with no bytes stop the leg');
  await waitFor(() => procsFor(silent).length === 4, 'the silent leg relaunched after its third quick exit');
  assert.equal(linesFor(`[sound:${silent.mediamtx_path}] no audio readings`).length, 0, 'a silent leg was struck');
  await stopSoundDetector(silent.id);
  await stopSoundDetector(dead.id);
});

test('#453 C3b: a minute of nothing but silence reaches the wake watcher exactly as a quiet audible minute with no motion does', async (t) => {
  // A digitally silent mic now produces, per minute, the listener call a quiet room with no motion has always
  // produced: { motionPeak: null, soundPeak: 0 }, i.e. a QUIET minute. That is the intent (plan v2, step 3), not a
  // regression, and it is pinned here as an equivalence through the real detector, the real tracker and the real
  // watcher: two cameras, one hearing a steady ambient tone (every window exactly at its floor, so 0), the other
  // hearing silence. Before #453 the silent camera's minutes never reached the watcher at all.
  t.mock.timers.enable({ apis: ['Date'], now: T0 });
  // A tracked child whose window covers the planted clock (the app's timezone is the default UTC).
  makeChild(db, { id: 'c3b-child', name: 'A child', start: '00:00', end: '23:59' });
  const silentCam = soundCam('c3b-silent', { childId: 'c3b-child' });
  const quietCam = soundCam('c3b-quiet', { childId: 'c3b-child' });
  const payloads = [];
  const ids = new Set([silentCam.id, quietCam.id]);
  const off = onMinuteFlushed((m) => {
    if (!ids.has(m.cameraId)) return;
    payloads.push(m);
    handleMinute(m);
  });
  t.after(off);
  const sp = await start(silentCam);
  const qp = await start(quietCam);
  // Both learn the same ambient in 12:00, then hear three minutes of the room: silence for one, the ambient
  // tone for the other. Same receipt times, window by window.
  for (let k = 0; k < 4 * 300; k++) {
    t.mock.timers.setTime(T0 + k * STEP_MS);
    sp.stdout.emit('data', k < 30 ? AMBIENT : SILENT);
    qp.stdout.emit('data', AMBIENT);
  }
  await stopSoundDetector(silentCam.id);
  await stopSoundDetector(quietCam.id);
  await settle();
  t.mock.timers.setTime(T0 + 4 * 60_000 + PAST_GRACE_MS);
  flushActivity(T0 + 4 * 60_000 + PAST_GRACE_MS);

  const of = (id) => payloads.filter((p) => p.cameraId === id).map(({ cameraId: _c, ...p }) => p);
  assert.deepEqual(of(silentCam.id), of(quietCam.id), 'the same calls, minute for minute');
  assert.deepEqual(of(silentCam.id).map((p) => [p.motionPeak, p.soundPeak]), rep(4, [null, 0]), 'four quiet, motionless minutes');
  assert.deepEqual(_state().get(silentCam.id), _state().get(quietCam.id), 'and the same watcher state');
  assert.equal(_state().get(silentCam.id).quietRun, 4, 'counted as quiet toward the onset gate');
});
