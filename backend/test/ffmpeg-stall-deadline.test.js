// #773: every child runFfmpeg starts (clipRecorder.js: the clip's re-encode, its thumbnail, its ffprobe) now settles
// on a deadline as well as on 'exit' / 'error'. Before, a child that never exited kept its capture pending forever,
// and with it the capture's ring hold, the camera's place in clipCapture's busyCameras, a queue slot, and the Stop
// request. The re-encode gets a STALL deadline (cut only when ffmpeg's progress counters stop moving, with a window
// that grows with what it has written); the probe and the thumbnail a fixed 120 s from spawn.
//
// HOW THIS IS DRIVEN, and why not a stub: clipRecorder.js, clipCapture.js and recordings.js are all in test:core's
// coverage include list, so none of them may be mock.module()d (that corrupts coverage for the whole suite). Only
// `node:child_process` is mocked (helpers/fakeFfmpeg.js): the segmenter is a FakeFfmpeg that stays alive, and each
// extraction child is whatever class the test picks, exiting only when the test says. setTimeout/setInterval are
// node:test mock timers, so a 2-minute window passes in one tick(); Date is real, because the ring's selection and
// janitor compare real file mtimes with it. performance.now() is real too: it only feeds the calibration log line.
//
// The child classes, and why a test picks one: FakeFfmpeg exits on any kill (a normal process); UnkillableFfmpeg
// records the signal and never exits (a process stuck in uninterruptible I/O). Only the second can tell "killed it
// and gave up" from "killed it and waited for an exit", which is the difference between this fix and a new hang.
//
// The window's numbers are written out as literals in the assertions on purpose (120 s, 2 MB per second): asserting
// with the exported formula would test the formula against itself. A deliberate change to them has to edit these.
import { test, mock, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { useTempDataDir, cleanupTempDataDirs, makeCamera } from './helpers/harness.js';
import { FakeFfmpeg, UnkillableFfmpeg } from './helpers/fakeFfmpeg.js';

useTempDataDir();
// Mocked before any import that can spawn, and `node:child_process` only (see fakeFfmpeg.js).
const spawned = [];
let ExtractionKind = FakeFfmpeg; // what every child but the segmenter is built as; set per test
mock.module('node:child_process', {
  exports: {
    spawn(command, args) {
      const Kind = args.includes('segment') ? FakeFfmpeg : ExtractionKind; // the ring segmenter: `-f segment`
      const proc = new Kind(command, args);
      spawned.push(proc);
      return proc;
    },
  },
});

const { default: db } = await import('../src/db.js');
const { logger } = await import('../src/lib/logger.js');
const ev = await import('../src/lib/detectionEvents.js');
const { CLIPS_DIR, startSegmenter, stopAllSegmenters, isSegmenterRunning, extractClip, probeClip, stallWindowMs } =
  await import('../src/lib/clipRecorder.js');
const { holdOwners, clearHolds, clipHoldOwner, ondemandHoldOwner } = await import('../src/lib/ringHolds.js');
const { enqueueClip, reconcileClipRing } = await import('../src/lib/clipCapture.js');
const { startRecording, stopRecording } = await import('../src/lib/recordings.js');

const CAM = 'cam-773';
const RING_DIR = path.join(CLIPS_DIR, '.ring', CAM);
const CLIP_DIR = path.join(CLIPS_DIR, CAM);
const own = (name) => path.join(CLIP_DIR, name);

const flush = () => new Promise((resolve) => setImmediate(resolve));
async function until(pred, what) {
  for (let i = 0; i < 100; i++) {
    if (pred()) return;
    await flush();
  }
  assert.fail(`never happened: ${what}`);
}
// A promise's state, readable synchronously (a pending capture is the bug, so "still pending" must be assertable).
function track(p) {
  const s = { state: 'pending', value: undefined };
  p.then((v) => { s.state = 'resolved'; s.value = v; }, (e) => { s.state = 'rejected'; s.value = e; });
  return s;
}

const cameraRow = () => db.prepare('SELECT * FROM cameras WHERE id = ?').get(CAM);
const clipStatus = (id) => db.prepare('SELECT clip_status FROM detection_events WHERE id = ?').get(id)?.clip_status;
const encodeProc = (base) =>
  spawned.find((p) => p.args.includes('concat') && String(p.args.at(-1)).endsWith(`${base}.mp4`));
const thumbProc = (base) =>
  spawned.find((p) => p.args.includes('-frames:v') && String(p.args.at(-1)).endsWith(`${base}.jpg`));
const probeProc = (base) => spawned.find((p) => p.command === 'ffprobe' && String(p.args.at(-1)).endsWith(`${base}.mp4`));
const cutLines = (base) => logger.getRecent().filter((l) => l.includes('[clip] cut ') && l.includes(`/${base} (`));

function plantSegment(mtimeMs, name = 'seg-20260101-000001.mkv') {
  fs.mkdirSync(RING_DIR, { recursive: true });
  const p = path.join(RING_DIR, name);
  fs.writeFileSync(p, 'footage');
  fs.utimesSync(p, mtimeMs / 1000, mtimeMs / 1000);
  return p;
}

// One `-progress` block as ffmpeg writes it. fps, bitrate and speed are rates over elapsed time, so in a hung
// ffmpeg 7 they keep CHANGING while frame/total_size/out_time_us stay frozen: they vary here on purpose, so a rule
// that resets on "any value changed" is caught as well as one that resets on "any line arrived".
let blockNo = 0;
function blockText({ frame, size, outUs }, progress = 'continue') {
  blockNo++;
  return [
    `frame=${frame}`, `fps=${(blockNo % 7) + 0.5}`, 'stream_0_0_q=28.0', `bitrate=${1000 + blockNo}.0kbits/s`,
    `total_size=${size}`, `out_time_us=${outUs}`, `out_time_ms=${outUs}`, 'out_time=00:00:01.000000',
    'dup_frames=0', 'drop_frames=0', `speed=${(1 / blockNo).toFixed(4)}x`, `progress=${progress}`, '',
  ].join('\n');
}
const block = (proc, counters, progress) => proc.stdout.emit('data', Buffer.from(blockText(counters, progress)));

// Node's documented order lets a child's 'exit' come BEFORE the last of its stdout: 'exit' fires when the process
// ends, 'close' only once its stdio has drained. FakeFfmpeg.finish() emits everything at once, which hides that; this
// is the hostile order (Codex review of #783 found an extraction that resolved on 'exit' parsing half its JSON).
function exitThenDrain(proc, code, ...lateChunks) {
  proc.ended = true; // so a later finish() is a no-op
  proc.emit('exit', code, null);
  for (const c of lateChunks) proc.stdout.emit('data', Buffer.from(c));
  proc.stdout.emit('end');
  proc.stderr.emit('end');
  proc.emit('close', code, null);
}

// Start a real extractClip against a planted segment and return once its encode child exists.
async function startExtraction({ outBase, Kind = FakeFfmpeg }) {
  ExtractionKind = Kind;
  startSegmenter(CAM, cameraRow().mediamtx_path, { preRollSec: 5, postRollSec: 5 });
  const at = Date.now() - 10_000;
  plantSegment(at + 2_000); // closed, and inside [at - pre - 2 segments, at + post + 2 segments]
  const result = track(extractClip(CAM, { preRollSec: 5, postRollSec: 5, at, outBase, settleMs: 0 }));
  mock.timers.tick(1); // the (zero) settle sleep
  await until(() => encodeProc(outBase), 'the encode ffmpeg');
  return { result, proc: encodeProc(outBase) };
}

// After a successful encode: the thumbnail, then ffprobe with a real-looking answer.
async function completeAfterEncode(base) {
  await until(() => thumbProc(base), 'the thumbnail ffmpeg');
  thumbProc(base).finish(0);
  await until(() => probeProc(base), 'the ffprobe of the clip');
  probeProc(base).stdout.emit('data', Buffer.from(JSON.stringify({ format: { duration: '10.0', size: '4096' }, streams: [] })));
  probeProc(base).finish(0);
}

before(() => {
  makeCamera(db, { id: CAM, name: 'Bedroom', extra: { detect_record_clips: 1 } });
  // On-demand recording and wake clips OFF, so a camera with detect_record_clips = 0 does not want a ring at all
  // (clipRingWanted): the reconcile assertions below depend on it. The on-demand case turns its feature on itself.
  db.prepare("UPDATE settings SET ondemand_enabled = 0, wake_clips_enabled = 0, clip_pre_roll_s = 5, clip_post_roll_s = 5 WHERE id = 'app'").run();
});

after(() => {
  stopAllSegmenters();
  db.close();
  cleanupTempDataDirs();
});

beforeEach(() => {
  // BEFORE the segmenter starts, so its janitor interval and every deadline are mocked timers.
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  stopAllSegmenters();
  clearHolds(CAM);
  spawned.length = 0;
  ExtractionKind = FakeFfmpeg;
  logger.clear();
  fs.rmSync(RING_DIR, { recursive: true, force: true });
  fs.rmSync(CLIP_DIR, { recursive: true, force: true });
});

afterEach(() => {
  stopAllSegmenters();
  mock.timers.reset();
});

// A detection clip through the real enqueueClip, whose encode never exits and prints nothing, and is given up on.
// Returns the camera row and the event id once the capture has settled.
async function stallADetectionClip() {
  ExtractionKind = UnkillableFfmpeg; // the hold must not depend on the child ever dying
  const camera = cameraRow();
  startSegmenter(CAM, camera.mediamtx_path, { preRollSec: 5, postRollSec: 5 });
  const at = Date.now() - 20_000;
  plantSegment(at + 2_000);
  const id = ev.recordDetectionEvent(CAM, camera.name, ev.ALERT.MOTION);
  enqueueClip(camera, id, at);
  assert.deepEqual(holdOwners(CAM), [clipHoldOwner(id)], 'precondition: the clip holds the ring');
  await flush(); // the queue starts the job on a later microtask, and only then does extractClip arm its settle timer
  mock.timers.tick(9_500); // extractClip waits out the 5 s post-roll + 2 segments + 0.5 s
  await until(() => encodeProc(String(id)), 'the encode ffmpeg');

  // Control, so the assertions after the window mean something: 1 s short of it, the capture is still pending,
  // still holds the ring, and a ring nobody wants any more is NOT stopped (the deferral the hold exists for).
  mock.timers.tick(119_000);
  await flush();
  assert.equal(clipStatus(id), 'pending', 'given up on before the 120 s stall window ran out');
  const unwanted = { ...camera, detect_record_clips: 0 };
  reconcileClipRing(unwanted);
  assert.equal(isSegmenterRunning(CAM), true, 'precondition: a held ring is not stopped');

  mock.timers.tick(1_000);
  await until(() => clipStatus(id) === 'failed', 'the stalled clip to be given up on (marked failed)');
  assert.deepEqual(encodeProc(String(id)).signals, ['SIGKILL']);
  return { camera, unwanted, id };
}

describe('#773 the extraction children have a deadline', { concurrency: false }, () => {
  test('★ acceptance: a detection clip whose encode never exits is given up on after the stall window; its hold goes and reconcileClipRing then stops the unwanted ring', async () => {
    const { unwanted } = await stallADetectionClip();
    assert.deepEqual(holdOwners(CAM), [], 'the given-up clip still holds the ring (it would grow until a restart)');
    reconcileClipRing(unwanted);
    assert.equal(isSegmenterRunning(CAM), false, 'a ring nobody wants kept running after the stalled clip was given up on');
  });

  test('after a stalled clip is given up on, the camera\'s next detection gets a clip of its own instead of being folded into it', async () => {
    const { camera } = await stallADetectionClip();
    const id2 = ev.recordDetectionEvent(CAM, camera.name, ev.ALERT.MOTION);
    enqueueClip(camera, id2, Date.now() - 5_000);
    assert.equal(clipStatus(id2), 'pending', 'the next event was folded into a clip that was given up on');
    assert.deepEqual(holdOwners(CAM), [clipHoldOwner(id2)]);
    // Let that second job end (its window has no segment, so it fails without spawning) so no job outlives the test.
    await flush();
    mock.timers.tick(9_500);
    await until(() => clipStatus(id2) === 'failed', 'the second clip to settle');
    assert.deepEqual(holdOwners(CAM), []);
  });

  test('★ frozen counters: a child that keeps printing progress blocks whose counters never move is killed after the stall window, and its half-written clip removed', async () => {
    const { result, proc } = await startExtraction({ outBase: 'frozen' });
    fs.writeFileSync(own('frozen.mp4'), 'what the encode had written so far');
    const frozen = { frame: 10, size: 1_000, outUs: 400_000 };
    block(proc, frozen); // the last real progress (from 0): the window now runs from here
    // ...then ffmpeg 7's main thread keeps printing a block every 0.5 s with the counters frozen.
    for (let t = 0; t < 119_000; t += 500) { block(proc, frozen); mock.timers.tick(500); }
    await flush();
    assert.equal(result.state, 'pending', 'killed before the stall window ran out');
    for (let t = 0; t < 2_000; t += 500) { block(proc, frozen); mock.timers.tick(500); }
    await until(() => result.state !== 'pending', 'the frozen encode to be cut (a rule that resets on any output never cuts it)');
    assert.equal(result.state, 'rejected');
    assert.match(result.value.message, /made no progress/);
    assert.deepEqual(proc.signals, ['SIGKILL']);
    assert.equal(fs.existsSync(own('frozen.mp4')), false, 'the half-written clip was left behind');
  });

  test('advancing counters: a slow encode that keeps making progress is never cut, however long it runs (passes on the old code by design: it guards against a wall-clock deadline)', async () => {
    const { result, proc } = await startExtraction({ outBase: 'slow' });
    // 20 minutes at one block a second with the counters creeping up: ten times the window, never a gap near it.
    for (let s = 1; s <= 1200; s++) { block(proc, { frame: s, size: s * 1_000, outUs: s * 40_000 }); mock.timers.tick(1_000); }
    await flush();
    assert.equal(result.state, 'pending');
    assert.deepEqual(proc.signals, [], 'a working encode was killed');
    block(proc, { frame: 1201, size: 1_300_000, outUs: 1201 * 40_000 }, 'end');
    proc.finish(0);
    await completeAfterEncode('slow');
    await until(() => result.state !== 'pending', 'the extraction to finish');
    assert.equal(result.state, 'resolved');
  });

  test('★ an UNKILLABLE child: the extraction settles on the timer without waiting for an exit that never comes, a late \'error\' does not throw, and nothing settles it twice', async () => {
    const { result, proc } = await startExtraction({ outBase: 'unkillable', Kind: UnkillableFfmpeg });
    mock.timers.tick(120_000); // silent from spawn: the base window
    await until(() => result.state !== 'pending', 'the extraction to settle although the child never exits');
    assert.equal(result.state, 'rejected');
    assert.match(result.value.message, /ffmpeg made no progress for 120\.0 s; killed it/);
    assert.deepEqual(proc.signals, ['SIGKILL']);
    assert.equal(proc.ended, false, 'precondition: the child is still there');
    // A late 'error' after the settle: with no listener left, EventEmitter would throw it (the #257 crash class).
    assert.doesNotThrow(() => proc.emit('error', new Error('a late spawn error')));
    // It wakes up and reports progress, then goes quiet past a window: nothing may be re-armed by a child that was
    // already given up on, so it is not signalled a second time...
    for (let s = 1; s <= 10; s++) { block(proc, { frame: s, size: s, outUs: s }); mock.timers.tick(1_000); }
    mock.timers.tick(130_000);
    assert.deepEqual(proc.signals, ['SIGKILL'], 'the child was signalled again after it had been given up on');
    // ...and its eventual exit does not settle the run a second time (one calibration line, not two).
    proc.finish(0);
    await flush();
    await flush();
    assert.equal(cutLines('unkillable').length, 1, `expected one line, got: ${JSON.stringify(cutLines('unkillable'))}`);
    assert.equal(result.state, 'rejected');
  });

  // Since the Codex fix round (settle on 'close') this holds two ways: the timer is cleared on settling, and a timer
  // that fired anyway would find the child `exited` and signal nothing. So deleting the clearTimeout alone is an
  // EQUIVALENT mutant (it survives; it was dropped from the catalogue), and this test pins the outcome, not the line.
  test('a child that exits just before its deadline is never signalled afterwards (passes on the old code by design: it never signalled anything)', async () => {
    const { result, proc } = await startExtraction({ outBase: 'justintime' });
    mock.timers.tick(119_999);
    proc.finish(0);
    await completeAfterEncode('justintime');
    await until(() => result.state !== 'pending', 'the extraction to finish');
    assert.equal(result.state, 'resolved');
    mock.timers.tick(600_000); // far past every deadline that was armed
    assert.deepEqual(proc.signals, [], 'a finished encode was signalled after it had finished');
    assert.deepEqual(thumbProc('justintime').signals, []);
    assert.deepEqual(probeProc('justintime').signals, []);
  });

  test('★ ffprobe has a fixed 120 s deadline from spawn, which output does not extend (not even progress-shaped output)', async () => {
    ExtractionKind = UnkillableFfmpeg;
    const result = track(probeClip(own('probe-me.mp4')));
    const proc = spawned.find((p) => p.command === 'ffprobe');
    // Hostile: lines a stall rule would read as progress, every second. A wall-clock deadline must ignore them.
    for (let s = 1; s < 120; s++) { proc.stdout.emit('data', Buffer.from(`frame=${s}\ntotal_size=${s}\n`)); mock.timers.tick(1_000); }
    await flush();
    assert.equal(result.state, 'pending', 'killed before its 120 s');
    mock.timers.tick(1_000);
    await until(() => result.state !== 'pending', 'the probe to be given up on');
    assert.equal(result.state, 'rejected');
    assert.match(result.value.message, /ffprobe did not finish within 120\.0 s; killed it/);
    assert.deepEqual(proc.signals, ['SIGKILL']);
  });

  test('★ a thumbnail that hangs is given up on after 120 s, its truncated JPG is removed, and the clip is still saved', async () => {
    const { result, proc } = await startExtraction({ outBase: 'thumbhang' });
    fs.writeFileSync(own('thumbhang.mp4'), 'a complete clip');
    ExtractionKind = UnkillableFfmpeg; // the thumbnail and the probe that follow
    proc.finish(0);
    await until(() => thumbProc('thumbhang'), 'the thumbnail ffmpeg');
    fs.writeFileSync(own('thumbhang.jpg'), 'half a jpeg');
    mock.timers.tick(119_999);
    await flush();
    assert.equal(probeProc('thumbhang'), undefined, 'the thumbnail was given up on before its 120 s');
    mock.timers.tick(1);
    await until(() => probeProc('thumbhang'), 'the probe, once the thumbnail was given up on');
    assert.deepEqual(thumbProc('thumbhang').signals, ['SIGKILL']);
    assert.equal(fs.existsSync(own('thumbhang.jpg')), false, 'the truncated thumbnail survived (it would be stored as thumb_path)');
    probeProc('thumbhang').stdout.emit('data', Buffer.from(JSON.stringify({ format: { duration: '10.0' }, streams: [] })));
    probeProc('thumbhang').finish(0);
    await until(() => result.state !== 'pending', 'the extraction to finish');
    assert.equal(result.state, 'resolved');
    assert.equal(result.value.thumb, null);
    assert.equal(fs.existsSync(own('thumbhang.mp4')), true, 'a thumbnail failure deleted the clip');
  });

  test('★ the stall window grows with what the encode has already written (the silent faststart rewrite is proportional to it)', async () => {
    const { result, proc } = await startExtraction({ outBase: 'bigfile' });
    // The last block before the silent tail: 200 MB written, so 120 s + 100 s. Delivered in two chunks split inside
    // the total_size line, as a pipe may: a parser that reads chunk by chunk would see 2000 bytes and cut at ~120 s.
    const text = blockText({ frame: 16_000, size: 200_000_000, outUs: 660_000_000 });
    const cut = text.indexOf('total_size=') + 'total_size=2000'.length;
    proc.stdout.emit('data', Buffer.from(text.slice(0, cut)));
    proc.stdout.emit('data', Buffer.from(text.slice(cut)));
    mock.timers.tick(121_000);
    await flush();
    assert.equal(result.state, 'pending', 'cut at the base window although 200 MB were still to be rewritten');
    mock.timers.tick(98_000); // 219 s
    await flush();
    assert.equal(result.state, 'pending', 'cut before 120 s + 1 s per 2 MB written');
    mock.timers.tick(2_000); // 221 s
    await until(() => result.state !== 'pending', 'the stall to be cut at 220 s');
    assert.equal(result.state, 'rejected');
    assert.deepEqual(proc.signals, ['SIGKILL']);

    // The formula at the sizes the comments quote, and its guard against a counter that never parsed.
    assert.equal(stallWindowMs(0), 120_000);
    assert.equal(stallWindowMs(800_000_000), 520_000, 'a 662 s recording from a 4K camera (~0.8 GB) gets 120 s + 400 s');
    assert.equal(stallWindowMs(-5), 120_000);
    assert.equal(stallWindowMs(Number.NaN), 120_000);
  });

  test('★ a failed encode removes its own partial MP4, and nothing else in the folder', async () => {
    const { result, proc } = await startExtraction({ outBase: 'ev-fail' });
    // Hostile neighbours: another clip's files, and one whose name merely STARTS with this clip's name.
    const others = ['ev-other.mp4', 'ev-other.jpg', 'ev-fail.mp4.keep'].map(own);
    for (const f of [own('ev-fail.mp4'), ...others]) fs.writeFileSync(f, 'x');
    proc.finish(1);
    await until(() => result.state !== 'pending', 'the failed encode to reject');
    assert.equal(result.state, 'rejected');
    assert.equal(fs.existsSync(own('ev-fail.mp4')), false, 'the failed encode\'s partial MP4 was left behind');
    for (const f of others) assert.equal(fs.existsSync(f), true, `cleanup deleted ${path.basename(f)}, which is not this clip's`);
  });

  test('★ a probe that fails after a good encode removes the finished MP4 and its JPG (no row will ever point at them), and nothing else', async () => {
    const { result, proc } = await startExtraction({ outBase: 'ev-probe' });
    const others = ['ev-other.mp4', 'ev-other.jpg'].map(own);
    for (const f of [own('ev-probe.mp4'), ...others]) fs.writeFileSync(f, 'x');
    proc.finish(0);
    await until(() => thumbProc('ev-probe'), 'the thumbnail ffmpeg');
    fs.writeFileSync(own('ev-probe.jpg'), 'a thumbnail');
    thumbProc('ev-probe').finish(0);
    await until(() => probeProc('ev-probe'), 'the ffprobe');
    probeProc('ev-probe').finish(1);
    await until(() => result.state !== 'pending', 'the failed probe to reject');
    assert.equal(result.state, 'rejected');
    assert.equal(fs.existsSync(own('ev-probe.mp4')), false, 'the orphaned clip was left behind');
    assert.equal(fs.existsSync(own('ev-probe.jpg')), false, 'the orphaned thumbnail was left behind');
    for (const f of others) assert.equal(fs.existsSync(f), true, `cleanup deleted ${path.basename(f)}, which is not this clip's`);
    assert.equal(fs.statSync(CLIP_DIR).isDirectory(), true, 'cleanup removed the camera\'s clip folder');
  });

  test('an on-demand recording whose cut never exits: Stop returns after the stall window, the row is failed and its lease released', async () => {
    db.prepare("UPDATE settings SET ondemand_enabled = 1 WHERE id = 'app'").run();
    try {
      const camera = cameraRow();
      startSegmenter(CAM, camera.mediamtx_path, { preRollSec: 5, postRollSec: 5 });
      plantSegment(Date.now() - 3_000);
      const { id } = startRecording(camera);
      assert.deepEqual(holdOwners(CAM), [ondemandHoldOwner(id)], 'precondition: the recording holds the ring');
      ExtractionKind = UnkillableFfmpeg;
      const stop = track(stopRecording(CAM, { settleMs: 0 }));
      mock.timers.tick(1);
      await until(() => encodeProc(`rec-${id}`), 'the recording\'s encode ffmpeg');
      mock.timers.tick(119_000);
      await flush();
      assert.equal(stop.state, 'pending', 'Stop returned before the stall window ran out');
      mock.timers.tick(1_000);
      await until(() => stop.state !== 'pending', 'Stop to return once the cut is given up on');
      assert.equal(stop.state, 'resolved');
      assert.equal(stop.value, id);
      assert.equal(db.prepare('SELECT status FROM recordings WHERE id = ?').get(id).status, 'failed');
      assert.deepEqual(holdOwners(CAM), [], 'the given-up recording still holds the ring');
    } finally {
      db.prepare("UPDATE settings SET ondemand_enabled = 0 WHERE id = 'app'").run();
    }
  });

  test('★ output that arrives after the child\'s \'exit\' is still read: the probe parses all of it and the clip is kept, not deleted', async () => {
    const { result, proc } = await startExtraction({ outBase: 'lateout' });
    fs.writeFileSync(own('lateout.mp4'), 'a complete clip');
    proc.finish(0);
    await until(() => thumbProc('lateout'), 'the thumbnail ffmpeg');
    fs.writeFileSync(own('lateout.jpg'), 'a thumbnail');
    thumbProc('lateout').finish(0);
    await until(() => probeProc('lateout'), 'the ffprobe');
    const json = JSON.stringify({ format: { duration: '10.0', size: '4096' }, streams: [] });
    const half = Math.floor(json.length / 2);
    probeProc('lateout').stdout.emit('data', Buffer.from(json.slice(0, half)));
    exitThenDrain(probeProc('lateout'), 0, json.slice(half)); // exit(0), THEN the rest of the JSON, end, close
    await until(() => result.state !== 'pending', 'the extraction to settle');
    assert.equal(result.state, 'resolved', `rejected: ${result.value?.message}`);
    assert.equal(result.value.probe.durationSec, 10);
    assert.equal(fs.existsSync(own('lateout.mp4')), true, 'a successfully encoded clip was deleted');
    assert.equal(fs.existsSync(own('lateout.jpg')), true, 'its thumbnail was deleted');
  });

  test('a child that exits but whose output never closes is settled at its deadline on its exit code, and not killed', async () => {
    const result = track(probeClip(own('never-closes.mp4')));
    const proc = spawned.find((p) => p.command === 'ffprobe');
    proc.stdout.emit('data', Buffer.from(JSON.stringify({ format: { duration: '4.0' }, streams: [] })));
    proc.ended = true;
    proc.emit('exit', 0, null); // and no 'close': something still holds its stdout open
    mock.timers.tick(119_999);
    await flush();
    assert.equal(result.state, 'pending', 'settled before its output had closed');
    mock.timers.tick(1);
    await until(() => result.state !== 'pending', 'the probe to settle at its deadline');
    assert.equal(result.state, 'resolved', `a child that exited 0 was treated as stuck: ${result.value?.message}`);
    assert.equal(result.value.durationSec, 4);
    assert.deepEqual(proc.signals, [], 'a child that had already exited was signalled');
  });

  test('one calibration line per extraction, naming the clip, the outcome and the longest wait without progress', async () => {
    const { result, proc } = await startExtraction({ outBase: 'calib' });
    block(proc, { frame: 1, size: 100, outUs: 1 });
    proc.finish(0);
    await completeAfterEncode('calib');
    await until(() => result.state !== 'pending', 'the extraction to finish');
    const lines = cutLines('calib');
    assert.equal(lines.length, 1, `expected one line, got: ${JSON.stringify(lines)}`);
    for (const part of [`${CAM}/calib (10 s clip)`, 'finished', 'longest wait for progress', 'after the last progress report', 'stall window']) {
      assert.ok(lines[0].includes(part), `the line lacks "${part}": ${lines[0]}`);
    }
  });
});
