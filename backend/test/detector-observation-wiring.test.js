// Golden characterization of the motion and sound detectors, pinned on UNMODIFIED dev code
// (issue #373 Stage 2, Step 0; plan R2-O6, §Tests 6).
//
// ★ WHY THIS EXISTS. Stage 2 adds an observation clock to both detectors: new ffmpeg args (showinfo /
// ashowinfo taps, `+level+info`), a stderr classifier, and one `observe` call per sample. The promise
// is that none of it changes a detection DECISION (plan §D, constraint C6). A promise is not a test.
// This file records what the detectors decide TODAY from a fixed byte stream delivered at fixed times,
// through their REAL side effects, so the Stage 2 change has to reproduce them exactly:
//   - activity_samples rows (after flushActivity), bed_transitions rows, detection_events rows;
//   - the decision log lines ([oob], [intobed], [detect], [sound]) and the forwarded ffmpeg stderr.
// It was written and made green BEFORE any detector change, which is the whole point: a golden
// recorded after the change would agree with whatever the new code does.
//
// HOW:
//   - ffmpeg is faked by mocking `node:child_process` ONLY. It is not in `test:core`'s coverage
//     include list, so mocking it is safe. ⚠️ mock.module() of an INCLUDED module corrupts coverage
//     for the WHOLE suite, so nothing else is mocked: the DB, activityTracker, bedTransitionTracker,
//     soundBaseline, detectionAlert and the logger are all real. (The mock also intercepts the bare
//     `'child_process'` specifier the detectors import; checked with a throwaway module first.)
//   - MediaMTX readiness is a real local HTTP server (the restart-cancellation.test.js pattern),
//     because both detectors refuse to spawn until their path reports ready.
//   - TIME: `Date` is mocked (mock.timers, apis ['Date']) and set before every stdout delivery, so
//     every `Date.now()` a detector reads is a value planted here. setTimeout stays REAL, so the 5 s
//     relaunch after an ffmpeg exit runs for real (that case costs ~5 s of wall time).
//   - stdout is synthesized deterministically here (frames and PCM with planted content); stderr is
//     REAL ffmpeg output captured by fixtures/obs/capture.sh under today's `-loglevel error`.
//
// ⚠️ The GOLDEN_* literals were recorded by running this file against dev db46da1, whose detectors
// were untouched. Re-recording them after changing a detector turns this into a test that agrees
// with whatever the code does. If a Stage 2 change breaks it, the change is wrong, or the plan's
// "no decision change" claim is — either way that is a finding, not a golden to refresh.
//
// ★ STAGE 2 (the build): the SAME scenario now runs three times, with a WORKING observation clock, a
// THROWING one and NO clock (plan §Tests 6), and every GOLDEN_* literal and capture check must hold in
// all three, unchanged. What changed is only what the fake ffmpeg PRINTS, because the detectors now run
// ffmpeg with `+level+info` and the taps:
//   - the error captures are fed WITH their level tokens. Each line's level is read from the same run
//     captured under the new flag (`*-rel.err`), so the input is exactly what the new ffmpeg prints for
//     those errors, and the forwarded text must still equal the `-loglevel error` capture byte for byte;
//   - tap records are printed before each stdout read, as the real taps would, so the working clock has
//     something to work with (and must never leak a record into the log).
// The level-less captures are no longer what ffmpeg prints; fed raw they are a drifted format, and the
// router rate-limits them by design (ffmpeg-side-channel.test.js, "drifted-format flood").
//
// ★ #493: the working clock now also feeds the motion leg's clone ledger, which takes PROVEN clones back out
// of activity_samples' motion_frames / motion_level / motion_out_level. The golden stream has no camera stall,
// so there is nothing to take out: every GOLDEN_* literal still holds, unchanged, in all three variants (and
// its many `unknown` quiet frames are exactly what the ledger must never touch). Where a stall DOES make
// clones, the variants must differ in those three columns and nowhere else: the #493 describe below.
//
// ★ #447: activity_samples rows are now labelled with the minute their samples were RECEIVED, and written a
// grace (7 s) after that minute ends, instead of being labelled with the flush time. That moves the golden's
// activity rows, and ONLY those: they were re-derived BY HAND from the pre-#447 recording and the planted
// frames (see GOLDEN_MOTION below), never re-recorded from the new code. Every other literal is untouched.
// The flushes became ticks of the tracker at each minute's end + PAST_GRACE_MS, the time a real tick would
// write it. The golden's three variants all read ONE mocked clock, so they cannot tell a receipt time from a
// per-call Date.now(); the #447 describe at the end plants a receipt on the other side of a minute boundary.
import { test, mock, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { useTempDataDir, cleanupTempDataDirs, makeCamera } from './helpers/harness.js';
import { zlibAdler0, feedStream } from './helpers/obsRig.js';
// #369 moved the fake ffmpeg and the fake MediaMTX server into this shared helper, unchanged in behaviour, so
// the detector-watchdog tests drive the very same fake. The goldens, the scenarios and every assertion in this
// file are untouched.
import { FakeFfmpeg, startFakeMediamtx } from './helpers/fakeFfmpeg.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures', 'obs');

useTempDataDir();

// ⚠️ ORDER MATTERS: mediamtx.js reads MEDIAMTX_API at module load, so the fake has to be listening and
// the env var set BEFORE the dynamic imports below (see restart-cancellation.test.js for the vacuous
// pass this once caused).
const mediamtx = await startFakeMediamtx();

// --- the fake ffmpeg --------------------------------------------------------------------------------
// Detector processes are driven by the test. Anything else (the alert and bed-transition snapshot
// grabs, `-f image2`) fails at once with exit 1, so each snapshot resolves null without a network.
const detectorProcs = [];

mock.module('node:child_process', {
  exports: {
    spawn(command, args) {
      const proc = new FakeFfmpeg(command, args);
      if (args.includes('rawvideo') || args.includes('s16le')) {
        detectorProcs.push(proc);
      } else {
        proc.finish(1);
      }
      return proc;
    },
  },
});

const { default: db } = await import('../src/db.js');
const { logger } = await import('../src/lib/logger.js');
const { flushActivity, _resetActivityTrackerForTests } = await import('../src/lib/activityTracker.js');
const { startMotionDetector, stopMotionDetector } = await import('../src/lib/motionDetector.js');
const { startSoundDetector, stopSoundDetector } = await import('../src/lib/soundDetector.js');
const {
  getObservationClock, sweepIdleClocks, _setObservationClockFactoryForTests, _resetObservationClocksForTests,
} = await import('../src/lib/observationClock.js');

after(async () => {
  await mediamtx.close();
  cleanupTempDataDirs();
});
// #447: the tracker remembers, per camera, the last minute it closed, and the golden runs the SAME camera at the
// SAME planted times three times over: without this, the second variant's 12:00 samples would be filed in the
// minute after the first variant's last one.
beforeEach(() => _resetActivityTrackerForTests());

// #447: a tick this long after a minute's end writes it: past activityTracker's 7 s GRACE_MS, which its own
// tests pin with literal times either side. The flushes below pass it explicitly and never move the mocked clock.
const PAST_GRACE_MS = 8_000;

// --- helpers ------------------------------------------------------------------------------------------

// A fixed instant, so every stored bucket_start is reproducible. Local timezone never matters: the
// only formatted times kept below are activity_samples' UTC bucket labels.
const T0 = Date.UTC(2026, 8, 25, 12, 0, 0);
const STEP_MS = 200; // both detectors' nominal sample period (5 fps frames, 1600-sample windows at 8 kHz)

// Poll on performance.now(), NOT Date: Date is frozen by the mock, so a Date deadline never expires.
async function waitFor(pred, what, capMs = 15_000) {
  const deadline = performance.now() + capMs;
  while (!pred()) {
    if (performance.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

// Let queued microtasks and immediates run: the alert path awaits a snapshot grab before its last log.
async function settle() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

// Every column except the two a test cannot control: `id` (depends on what ran before) and
// `created_at` (SQLite's own real clock). Derived from the schema so a column added later is pinned
// too, instead of silently escaping a hand-typed list.
const UNCONTROLLED = new Set(['id', 'created_at']);
function rowsFor(table, cameraId) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name).filter((c) => !UNCONTROLLED.has(c));
  return db.prepare(`SELECT ${cols.join(', ')} FROM ${table} WHERE camera_id = ? ORDER BY id`).all(cameraId);
}

// Logger lines mentioning this camera, with the timestamp removed (it is local-time formatted).
function logFor(...needles) {
  return logger.getRecent()
    .map((l) => l.replace(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} /, ''))
    .filter((l) => needles.some((n) => l.includes(n)));
}

// Delivery plans. `units` are equal-sized sample buffers (frames or PCM windows); unit i is "produced"
// at base + i*STEP_MS. Each plan returns [atMs, chunk] pairs; the mocked clock is set to atMs before
// that chunk is emitted, so it is the receipt time every decision in that chunk reads.
const single = (units, base) => units.map((u, i) => [base + i * STEP_MS, u]);
function burst(units, base, n) { // n units per read, delivered when the last of them is produced
  const out = [];
  for (let i = 0; i < units.length; i += n) {
    const group = units.slice(i, i + n);
    out.push([base + (i + group.length - 1) * STEP_MS, Buffer.concat(group)]);
  }
  return out;
}
function split(units, base, size) { // the byte stream re-cut at `size`, so samples straddle reads
  const all = Buffer.concat(units);
  const unit = units[0].length;
  const out = [];
  for (let off = 0; off < all.length; off += size) {
    const end = Math.min(all.length, off + size);
    out.push([base + Math.floor((end - 1) / unit) * STEP_MS, all.subarray(off, end)]);
  }
  return out;
}
function deliver(t, stream, plan) {
  for (const [at, chunk] of plan) {
    t.mock.timers.setTime(at);
    stream.emit('data', chunk);
  }
}

// Real `-loglevel error` stderr captured from ffmpeg 8.1.2 (see fixtures/obs/capture.sh), emitted in
// two reads split mid-line, because stderr arrives in arbitrary chunks, not lines.
function stderrFixture(name) {
  return fs.readFileSync(path.join(FIXTURES, name));
}
function emitSplit(stream, bytes, at) {
  stream.emit('data', bytes.subarray(0, at));
  stream.emit('data', bytes.subarray(at));
}
// A capture's own non-blank lines: what today's forwarder publishes for it, verbatim (none of these
// captures contains a URL, so credential redaction has nothing to rewrite).
function captureLines(name) {
  return stderrFixture(name).toString('utf8').split('\n').filter((l) => l.trim());
}

// The `-loglevel error` capture as the NEW flag prints it: each line gets the level token ffmpeg gave the
// same message in the `+level+info` capture of the same input (matched with addresses normalised; ASLR).
// ffmpeg's own "    Last message repeated" note never carries a level, under either flag.
const normAddr = (l) => l.replace(/0x[0-9a-f]+/g, '0xADDR');
function levelled(errorCapture, relCapture) {
  const levelOf = new Map();
  for (const l of captureLines(relCapture)) {
    const m = /^((?:\[[^\]]+ @ 0x[0-9a-f]+\] )*)\[(error|fatal|panic)\] (.*)$/.exec(l);
    if (m) levelOf.set(normAddr(m[1] + m[3]), m[2]);
  }
  const out = captureLines(errorCapture).map((l) => {
    if (/^\s/.test(l)) return l;
    const m = /^((?:\[[^\]]+ @ 0x[0-9a-f]+\] )*)(.*)$/.exec(l);
    const level = levelOf.get(normAddr(l));
    assert.ok(level, `no level for "${l}" in ${relCapture}`);
    return `${m[1]}[${level}] ${m[2]}`;
  });
  return Buffer.from(`${out.join('\n')}\n`);
}

// --- what the taps print --------------------------------------------------------------------------------
// Laid out exactly as ffmpeg 8.1.2's showinfo/ashowinfo lines (fixtures/obs/lean-*.err, sound-*.err):
// the `in` tap without a checksum, the `out` tap with the Adler-32 of the frame's bytes, and the colour
// line each prints after a record. 5 fps input on a 90 kHz clock, one input per output slot.
const hex8 = (v) => v.toString(16).toUpperCase().padStart(8, '0');
const ts = (s) => String(Number(s.toPrecision(6))).padEnd(7);
const MOTION_CONFIG = [
  '[showinfo@in @ 0x7f00000a0000] [info] config in time_base: 1/90000, frame_rate: 5/1',
  '[showinfo@in @ 0x7f00000a0000] [info] config out time_base: 0/0, frame_rate: 0/0',
  '[showinfo@out @ 0x7f00000b0000] [info] config in time_base: 1/5, frame_rate: 5/1',
  '[showinfo@out @ 0x7f00000b0000] [info] config out time_base: 0/0, frame_rate: 0/0',
];
function motionRecords(k, frame) {
  const sum = hex8(zlibAdler0(frame));
  return [
    `[showinfo@in @ 0x7f00000a0000] [info] n:${String(k).padStart(4)} pts:${String(k * 18000).padStart(7)} pts_time:${ts(k * 0.2)} duration:  18000 duration_time:0.2     fmt:yuv420p cl:left sar:1/1 s:640x360 i:P iskey:0 type:P `,
    '[showinfo@in @ 0x7f00000a0000] [info] color_range:tv color_space:bt709 color_primaries:bt709 color_trc:bt709',
    `[showinfo@out @ 0x7f00000b0000] [info] n:${String(k).padStart(4)} pts:${String(k).padStart(7)} pts_time:${ts(k * 0.2)} duration:      1 duration_time:0.2     fmt:gray cl:unspecified sar:1/1 s:320x180 i:P iskey:0 type:P checksum:${sum} plane_checksum:[${sum}] mean:[60] stdev:[40.0]`,
    '[showinfo@out @ 0x7f00000b0000] [info] color_range:pc color_space:unknown color_primaries:unknown color_trc:unknown',
  ];
}
function soundRecords(w) {
  return [`[Parsed_ashowinfo_0 @ 0x7f00000c0000] [info] n:${w} pts:${w * 1600} pts_time:${Number((w * 0.2).toPrecision(6))} fmt:s16 channels:1 chlayout:mono rate:8000 nb_samples:1600 checksum:0000ABCD plane_checksums: [ 0000ABCD ]`];
}

// deliver(), plus the tap records for every sample a read completes, printed on stderr just before it
// (records reach Node ahead of their samples: measured, plan "What Stage 1 settled").
function deliverObserved(t, proc, plan, unitBytes, recordsFor, state) {
  for (const [at, chunk] of plan) {
    t.mock.timers.setTime(at);
    state.bytes += chunk.length;
    const lines = [];
    while (state.emitted < Math.floor(state.bytes / unitBytes)) {
      lines.push(...recordsFor(state.emitted));
      state.emitted += 1;
    }
    if (lines.length) proc.stderr.emit('data', Buffer.from(`${lines.join('\n')}\n`));
    proc.stdout.emit('data', chunk);
  }
}

// The three clocks the same golden must hold under. `dateClocks` keeps the clock's monotonic and wall
// time on the test's mocked Date, so a planted receipt time is what the clock sees too (without it, the
// frozen Date against a running performance.now() would read as a host clock stepping every read).
const dateClocks = { monoNow: () => Date.now(), wallNow: () => Date.now() };
const throwing = () => { throw new Error('clock failure (planted)'); };
// #493: the working clock is built the way production builds it, WITH the detector's own listener (the motion
// leg's clone ledger), which the factory is now handed as its third argument; before #493 the factory
// dropped it, so this variant would have exercised no correction at all. The test's own capture is a SECOND
// listener beside it: the one function per variant, so the factory running again for the relaunch still
// captures each observation once.
const CLOCK_VARIANTS = {
  working: (captured) => {
    const capture = (o) => captured.push(o);
    return (cameraId, leg, { onObservation } = {}) => {
      const c = getObservationClock(cameraId, leg, { clocks: dateClocks, label: 'golden', onObservation });
      c.addObservationListener(capture);
      return c;
    };
  },
  throwing: () => () => ({
    receipt: throwing,
    beginGeneration: () => ({ onRecord: throwing, onConfig: throwing, onParseError: throwing, onSample: throwing, end: throwing }),
  }),
  none: () => () => null,
};

function resetCamera(cameraId) {
  for (const table of ['activity_samples', 'bed_transitions', 'detection_events']) {
    db.prepare(`DELETE FROM ${table} WHERE camera_id = ?`).run(cameraId);
  }
}

// --- motion ---------------------------------------------------------------------------------------------
// Geometry is the detector's own: 320x180 gray, one byte per pixel. The bed zone is the LEFT half.
const FW = 320;
const FH = 180;
const FRAME_BYTES = FW * FH;
const BASE = 60;
const LIT = 200; // |LIT - BASE| = 140, far over the detector's PIXEL_DELTA of 24
// Painted regions, and what each one does to the detector's two channels (sensitivity 50 -> an
// active threshold of 5.15% of the zone):
//   bed:     rows 0-59 of the left half   = 9,600 px = 33.3% of the 28,800 px zone   -> active
//   out:     rows 0-39 of the right half  = 6,400 px = 22.2% of the 28,800 px outside -> active
//   flicker: rows 170-174 of the left half =  800 px =  2.8% of the zone            -> NOT active
// An active region is lit on alternate frames, so every frame of a run differs from the one before.
function paint({ bed = false, out = false, flicker = false }) {
  const f = Buffer.alloc(FRAME_BYTES, BASE);
  const fill = (x0, x1, y0, y1, v) => { for (let y = y0; y < y1; y++) f.fill(v, y * FW + x0, y * FW + x1); };
  if (bed) fill(0, 160, 0, 60, LIT);
  if (out) fill(160, 320, 0, 40, LIT);
  if (flicker) fill(0, 160, 170, 175, BASE + 30);
  return f;
}
// A segment list -> frames. Active segments are even-length and end on an unlit frame, so the next
// segment starts from a clean BASE picture.
function frames(script) {
  const out = [];
  for (const s of script) {
    for (let k = 0; k < s.n; k++) {
      const lit = k % 2 === 0;
      out.push(paint({
        bed: !!s.bed && lit,
        out: !!s.out && lit,
        flicker: !!s.flickerEvery && k % s.flickerEvery === 0,
      }));
    }
  }
  return out;
}

// Generation 1, minute 1 (0-60 s), one frame per read. Approximate times at 5 fps in the comments.
const MOTION_MIN1 = frames([
  { n: 25, flickerEvery: 5 }, //   0-5 s   quiet, sub-threshold flicker
  { n: 26, bed: true }, //         5-10 s  bed moving: the motion alert confirms 3 s in
  { n: 10, out: true }, //        10-12 s  outside only: an exit candidate (bed active <8 s ago)
  { n: 40 }, //                   12-20 s  quiet bed for >6 s: the exit is confirmed (out_of_bed)
  { n: 10, out: true }, //        20-22 s  outside again
  { n: 20, bed: true }, //        22-26 s  bed only, outside quiet: entry candidate -> into_bed 6 s on
  { n: 169, flickerEvery: 7 }, // 26-60 s  quiet (the alert cooldown, 60 s, keeps this run silent)
]);
// Generation 1, minute 2 (60-120 s): a second bed run at 70 s, 65 s after the first alert, so it
// alerts again. Delivered in 3-frame bursts (a clump) and then re-cut into 40,000-byte reads.
const MOTION_MIN2 = frames([
  { n: 50, flickerEvery: 9 },
  { n: 26, bed: true },
  { n: 224, flickerEvery: 11 },
]);
// Generation 2, after the relaunch: outside, then bed. An into_bed while the belief (which survives a
// relaunch) is already "in bed" is logged as impossible; the alert state does NOT survive, so this run
// alerts even though the last alert was well inside the cooldown.
const MOTION_GEN2 = frames([
  { n: 10, out: true },
  { n: 20, bed: true },
  { n: 40 },
]);

const motionCamera = {
  id: 'cam-golden-motion',
  name: 'Golden Motion Cam',
  mediamtx_path: 'path_golden_motion',
  sub_rtsp_url: null,
  disabled: 0,
  child_id: null,
  detect_motion_enabled: 1,
  detect_source: 'framediff',
  detect_sensitivity: 50,
  detect_confirm_s: 3,
  detect_cooldown_s: 60,
  detect_zone: JSON.stringify([{ x: 0, y: 0, w: 0.5, h: 1 }]),
  detect_schedule_enabled: 0,
  detect_record_clips: 0,
  snapshot_url: null,
};

// --- sound ----------------------------------------------------------------------------------------------
const WIN_SAMPLES = 1600; // the detector's 200 ms window at 8 kHz
let sampleClock = 0; // continuous phase across windows, so a window boundary is not a click
function pcm(script) {
  const out = [];
  for (const s of script) {
    for (let k = 0; k < s.n; k++) {
      const w = Buffer.alloc(WIN_SAMPLES * 2);
      for (let i = 0; i < WIN_SAMPLES; i++, sampleClock++) {
        w.writeInt16LE(Math.round(s.amp * Math.sin((2 * Math.PI * 440 * sampleClock) / 8000)), i * 2);
      }
      out.push(w);
    }
  }
  return out;
}
// Amplitude 1,000 is about -33 dBFS RMS, 16,000 about -9 dBFS: +24 dB, over the +11 dB margin that
// sensitivity 50 gives. The trailing average (20 windows = sound_confirm_s 4) crosses it ~2 s into a
// loud run.
const SOUND_MIN1 = pcm([
  { n: 25, amp: 1000 }, //  0-5 s   the 25 seed windows: the ambient baseline is their median
  { n: 50, amp: 1000 }, //  5-15 s  ambient
  { n: 1, amp: 0 }, //      digital silence: rms 0 -> -Infinity, recorded as a quiet reading at the ambient since #453
  { n: 15, amp: 16000 }, // 15-18 s  loud: alerts
  { n: 209, amp: 1000 }, // to 60 s
]);
// Minute 2: another loud run at ~70 s, inside the 120 s cooldown, so it must NOT alert.
const SOUND_MIN2 = pcm([
  { n: 50, amp: 1000 },
  { n: 15, amp: 16000 },
  { n: 235, amp: 1000 },
]);

const soundCamera = {
  id: 'cam-golden-sound',
  name: 'Golden Sound Cam',
  mediamtx_path: 'path_golden_sound',
  disabled: 0,
  detect_sound_enabled: 1,
  sound_sensitivity: 50,
  sound_confirm_s: 4,
  sound_cooldown_s: 120,
  detect_schedule_enabled: 0,
  detect_record_clips: 0,
  snapshot_url: null,
};

makeCamera(db, { id: motionCamera.id, name: motionCamera.name, path: motionCamera.mediamtx_path });
makeCamera(db, { id: soundCamera.id, name: soundCamera.name, path: soundCamera.mediamtx_path });

// --- the goldens (recorded on dev db46da1, unmodified detectors) --------------------------------------
// Read these as today's behaviour, including the parts that look odd, because pinning them is the job:
//   - #447: a bucket is labelled with the minute its samples were RECEIVED (the activity rows below were
//     re-derived by hand when that changed; the pre-#447 recording, labelled with the FLUSH time, is kept);
//   - the first frame of every generation is a baseline with no diff (299 of 300 frames in minute 1,
//     69 of 70 in generation 2), and the frame delivered after 'exit' is still analysed (it now sits with
//     generation 2's frames in 12:02, the minute it arrived in);
//   - the alert cooldown resets on a relaunch (generation 2 alerts at 126 s, 53 s after the 73 s alert,
//     inside the 60 s cooldown), while the in/out-of-bed BELIEF survives it (the "flagged impossible"
//     line);
//   - the second loud sound run does not alert (inside the 120 s cooldown) but still moves the level
//     lines and the stored sound_* numbers.
// Log lines that are verbatim forwards of a stderr capture are NOT in these literals: they are checked
// against the capture itself, which is an oracle this code did not produce.
// The pre-#447 activity rows, AS RECORDED on db46da1 (flush-time labels, flushes at 60 s, 120 s, 180 s). Kept
// verbatim: they are the oracle the #447 rows below are derived from, and not produced by the #447 code.
const PRE447_MOTION_ROWS = [
  { camera_id: 'cam-golden-motion', bucket_start: '2026-09-25 12:01:00', motion_level: 0.05667038275733944, motion_peak: 0.3333333333333333, sound_level: null, sound_peak: null, motion_frames: 299, sound_windows: 0, motion_out_level: 0.014864362690449651, motion_out_peak: 0.2222222222222222, sound_p75: null, sound_p90: null, sound_sd: null },
  { camera_id: 'cam-golden-motion', bucket_start: '2026-09-25 12:02:00', motion_level: 0.033776301218161796, motion_peak: 0.3333333333333333, sound_level: null, sound_peak: null, motion_frames: 301, sound_windows: 0, motion_out_level: 0, motion_out_peak: 0, sound_p75: null, sound_p90: null, sound_sd: null },
  { camera_id: 'cam-golden-motion', bucket_start: '2026-09-25 12:03:00', motion_level: 0.09661835748792268, motion_peak: 0.3333333333333333, sound_level: null, sound_peak: null, motion_frames: 69, sound_windows: 0, motion_out_level: 0.02898550724637682, motion_out_peak: 0.2222222222222222, sound_p75: null, sound_p90: null, sound_sd: null },
];
// ★ #447: THE ACTIVITY ROWS, RE-DERIVED BY HAND — NOT RE-RECORDED (plan round 2, B). A golden recorded from the
// new code agrees with whatever it does; this one is worked out from where each planted frame ARRIVED:
//   - minute 1's 300 frames arrive at 0-59.8 s: 12:00 holds exactly what the old 12:01 row held (299 diffs),
//     summed in the same order, so it is that row, relabelled, to the last bit;
//   - minute 2's 300 frames arrive at 60-119.8 s: 12:01. The old 12:02 row ALSO held the frame drained after
//     'exit' (delivered at 120 s), which now belongs to 12:02, with generation 2's 69 diffs (121-134.8 s);
//   - the per-frame fractions come from the painted regions (`paint` above; zone = the left 28,800 px): the
//     flicker band 800 px in the zone = 1/36, the lit bed 9,600 px = 1/3, the lit outside 6,400 of the 28,800 px
//     outside it = 2/9. MOTION_MIN2, after MIN1's last frame (k = 168 of `flickerEvery: 7`, a flicker frame):
//     segment A {50, flickerEvery 9} changes on k = 1, 9-10, 18-19, 27-28, 36-37, 45-46 = 11 flicker diffs;
//     segment B {26, bed} changes on all 26 frames (each lit/unlit vs the one before) = 26 x 1/3; segment C
//     {224, flickerEvery 11} has flicker frames at k = 0, 11, ..., 220 (21), each changing twice = 42 diffs.
//     No outside movement. The drained frame (a flicker) after C's last frame (k = 223, unlit, no flicker) =
//     1/36 in the zone, 0 outside. Generation 2: MOTION_GEN2's first frame is its baseline; the out run's
//     9 diffs = 9 x 2/9 outside, the bed run's 20 (including the first lit frame after the unlit out frame)
//     = 20 x 1/3 in the zone, and its quiet tail changes nothing.
// The derivation is CHECKED against the pre-#447 recording before it is used (the motion test below asserts
// that 301 frames of MIN2 + the drained one, and 69 of generation 2, reproduce the recorded levels), so a
// slip in it fails loudly instead of quietly redefining the golden. Levels are compared within 1e-12: the
// detector sums frame by frame, and a hand total re-associates the same additions.
const FLICKER = 1 / 36;
const LIT_BED = 1 / 3;
const LIT_OUT = 2 / 9;
const MIN2_SUM = (11 + 42) * FLICKER + 26 * LIT_BED; // 365/36
const GEN2_SUM = 20 * LIT_BED;
const GEN2_OUT_SUM = 9 * LIT_OUT;
const GOLDEN_MOTION = {
  activity: [
    { ...PRE447_MOTION_ROWS[0], bucket_start: '2026-09-25 12:00:00' },
    { ...PRE447_MOTION_ROWS[1], bucket_start: '2026-09-25 12:01:00', motion_frames: 300, motion_level: MIN2_SUM / 300 },
    { ...PRE447_MOTION_ROWS[2], bucket_start: '2026-09-25 12:02:00', motion_frames: 70, motion_level: (FLICKER + GEN2_SUM) / 70, motion_out_level: GEN2_OUT_SUM / 70 },
  ],
  // ⚠️ `wrong_reason: null` was added by the #373 build, and it is NOT a re-recording: dev b379737 (#504,
  // this branch's base) added the `bed_transitions.wrong_reason` column AFTER this golden was recorded on
  // db46da1. rowsFor() pins every column from PRAGMA table_info on purpose, so the golden went red on the
  // unmodified base the moment that column existed. The detectors never write it (a user's review sets
  // it), so NULL is what every unmodified detector inserts. No other value here was touched.
  transitions: [
    { camera_id: 'cam-golden-motion', type: 'out_of_bed', peak: 0.222, snapshot: 0, verdict: null, out_peak: 0.222, out_frames: 10, wrong_reason: null },
    { camera_id: 'cam-golden-motion', type: 'into_bed', peak: 0.333, snapshot: 0, verdict: null, out_peak: 0.222, out_frames: 10, wrong_reason: null },
    { camera_id: 'cam-golden-motion', type: 'into_bed', peak: 0.333, snapshot: 0, verdict: null, out_peak: 0.222, out_frames: 9, wrong_reason: null },
  ],
  events: [
    { camera_id: 'cam-golden-motion', camera_name: 'Golden Motion Cam', type: 'motion', detail: '33.3% of zone', snapshot: 0, clip_status: null, clip_path: null, clip_duration_s: null, clip_bytes: null },
    { camera_id: 'cam-golden-motion', camera_name: 'Golden Motion Cam', type: 'motion', detail: '33.3% of zone', snapshot: 0, clip_status: null, clip_path: null, clip_duration_s: null, clip_bytes: null },
    { camera_id: 'cam-golden-motion', camera_name: 'Golden Motion Cam', type: 'motion', detail: '33.3% of zone', snapshot: 0, clip_status: null, clip_path: null, clip_duration_s: null, clip_bytes: null },
  ],
  log: [
    '[INFO] [intobed] "Golden Motion Cam" bed active with no entry link — outside last active never (this run) (need <=8000ms), believed unknown',
    '[INFO] [detect] motion on "Golden Motion Cam" (33.3% of zone)',
    '[INFO] [oob] "Golden Motion Cam" exit candidate (fast) — bed active 200ms ago, outside now 22.2%',
    '[INFO] [oob] "Golden Motion Cam" OUT OF BED — motion left the bed, quiet 6000ms since, outside peak 22.2%',
    '[INFO] [oob] "Golden Motion Cam" exit candidate (slow) — bed active 10200ms ago, outside now 22.2%',
    '[INFO] [oob] "Golden Motion Cam" candidate cancelled — bed re-active after 2000ms',
    '[INFO] [intobed] "Golden Motion Cam" entry candidate — outside active 200ms ago, bed now 33.3%',
    '[INFO] [intobed] "Golden Motion Cam" INTO BED — motion entered the bed, outside quiet 6000ms since, bed peak 33.3%',
    '[INFO] [detect] motion on "Golden Motion Cam" (33.3% of zone)',
    // rtsp-refused-error.err, forwarded: the logger's credential redaction drops the URL query string.
    '[detect:path_golden_motion] [tcp @ 0x78fde35b0e40] Connection to tcp://127.0.0.1:1[redacted] failed: Connection refused',
    '[detect:path_golden_motion] [in#0 @ 0x78fddd6e2b00] Error opening input: Connection refused',
    '[detect:path_golden_motion] Error opening input file rtsp://127.0.0.1:1/nope.',
    '[detect:path_golden_motion] Error opening input files: Connection refused',
    '[detect:path_golden_motion] stream ended, reconnecting',
    '[INFO] [detect] no snapshot for "Golden Motion Cam" (grab failed/timed out) — feed/alert without image',
    '[INFO] [detect] no snapshot for "Golden Motion Cam" (grab failed/timed out) — feed/alert without image',
    '[INFO] [intobed] "Golden Motion Cam" entry candidate — outside active 200ms ago, bed now 33.3%',
    '[INFO] [detect] motion on "Golden Motion Cam" (33.3% of zone)',
    '[INFO] [intobed] "Golden Motion Cam" INTO BED would be flagged impossible — already believed in bed (§1.2 item 1, log-only)',
    '[INFO] [intobed] "Golden Motion Cam" INTO BED — motion entered the bed, outside quiet 6000ms since, bed peak 33.3%',
    '[INFO] [detect] no snapshot for "Golden Motion Cam" (grab failed/timed out) — feed/alert without image',
  ],
};
// ★ #447, derived by hand as for motion: SOUND_MIN1's windows all arrive at 0-59.8 s and SOUND_MIN2's at
// 60-119.8 s, exactly the two pre-#447 flush intervals, so each recorded row (labelled 12:01 and 12:02, the
// flush times) is the same row, to the last bit, under the minute its windows arrived in: 12:00 and 12:01.
// ★ #453: THE 12:00 ROW, RE-DERIVED BY HAND FROM THE db46da1 RECORDING — NOT RE-RECORDED. SOUND_MIN1's one
// digitally silent window (k = 75) used to be dropped before the analyser; it is now a reading AT the ambient,
// so it records an excursion of exactly 0 and is counted. Nothing else about the run moves: just before it the
// trailing window held 20 ambient readings and the floor sat exactly on them (identical windows, so every EMA
// step was 0), so pushing one more ambient-valued reading leaves the window, the floor, `loudSince` and
// `frozenSince` exactly as they were, and the loud run that follows meets the same state as before (same alert,
// same excursions). So 12:00 gains one window of 0: the SUM and the SUM OF SQUARES of its excursions are
// unchanged and only the count goes 274 -> 275. The mean and the population sd are recomputed from those two
// sums (sd = sqrt(sumSq / n - mean^2), activityTracker.js), so the mean shrinks by 274/275 and so does the sd.
// ⚠️ The two sums are recovered from the recorded mean and sd, which carry the last-bit rounding of the
// detector's own summation order, so these two values hold to ~1e-15, not bit for bit: they join the MEANS
// tolerance set below for exactly that reason. p75/p90 stay 0 (one more 0 in a minute that was already mostly
// 0) and the peak is untouched. The 12:01 row has no silent window and is unchanged.
const PRE453_SOUND_1200 = { sound_level: 1.26657393446471, sound_windows: 274, sound_sd: 5.263784232701136 };
const SUM_1200 = PRE453_SOUND_1200.sound_level * PRE453_SOUND_1200.sound_windows;
const SUMSQ_1200 = PRE453_SOUND_1200.sound_windows * (PRE453_SOUND_1200.sound_sd ** 2 + PRE453_SOUND_1200.sound_level ** 2);
const MEAN_1200 = SUM_1200 / 275;
const GOLDEN_SOUND = {
  activity: [
    { camera_id: 'cam-golden-sound', bucket_start: '2026-09-25 12:00:00', motion_level: null, motion_peak: null, sound_level: MEAN_1200, sound_peak: 24.081866239790152, motion_frames: 0, sound_windows: 275, motion_out_level: null, motion_out_peak: null, sound_p75: 0, sound_p90: 0, sound_sd: Math.sqrt(SUMSQ_1200 / 275 - MEAN_1200 ** 2) },
    { camera_id: 'cam-golden-sound', bucket_start: '2026-09-25 12:01:00', motion_level: null, motion_peak: null, sound_level: 1.1519717499111992, sound_peak: 23.9812664492313, motion_frames: 0, sound_windows: 300, motion_out_level: null, motion_out_peak: null, sound_p75: 0, sound_p90: 0, sound_sd: 5.022056490207111 },
  ],
  events: [
    { camera_id: 'cam-golden-sound', camera_name: 'Golden Sound Cam', type: 'sound', detail: '+12 dB over ambient', snapshot: 0, clip_status: null, clip_path: null, clip_duration_s: null, clip_bytes: null },
  ],
  log: [
    '[INFO] [sound] watching "Golden Sound Cam" — fires at +11 dB over ambient, sustained 4s',
    // ★ #453, hand-derived: the silent window k = 75 arrives at exactly 15 s, the first level-log boundary, and
    // now reaches the level check, so line 1 is written AT it (it used to be written one window later, by the
    // first loud window, whose -9.2 dB it printed). Its peak is therefore the ambient windows' -33.3 dB (a silent
    // window never sets the peak). Every later level line is unchanged: line 2's boundary moves 200 ms earlier,
    // to 30.0 s, but windows 100-199 are re-cut into 5,000-byte reads and the first window handled at or after
    // 30.0 s is window 150 at 30.2 s, the one that wrote it before; from there on the times are identical.
    '[INFO] [sound] "Golden Sound Cam" ambient=-33.3dB peak=-33.3dB maxAvgOver=+0.0 (fires at +11)',
    '[INFO] [detect] sound on "Golden Sound Cam" (+12 dB over ambient)',
    '[INFO] [sound] "Golden Sound Cam" ambient=-32.6dB peak=-9.2dB maxAvgOver=+16.9 (fires at +11)',
    '[INFO] [sound] "Golden Sound Cam" ambient=-33.0dB peak=-33.3dB maxAvgOver=+-0.4 (fires at +11)',
    '[INFO] [sound] "Golden Sound Cam" ambient=-33.2dB peak=-33.3dB maxAvgOver=+-0.2 (fires at +11)',
    '[INFO] [sound] "Golden Sound Cam" ambient=-32.0dB peak=-9.2dB maxAvgOver=+16.8 (fires at +11)',
    '[INFO] [sound] "Golden Sound Cam" ambient=-32.7dB peak=-33.3dB maxAvgOver=+7.2 (fires at +11)',
    '[INFO] [sound] "Golden Sound Cam" ambient=-33.0dB peak=-33.3dB maxAvgOver=+-0.3 (fires at +11)',
    '[INFO] [detect] no snapshot for "Golden Sound Cam" (grab failed/timed out) — feed/alert without image',
  ],
};

// The golden log minus the lines that are verbatim forwards of `capture` (checked against it instead).
function withoutCapture(observed, tag, capture) {
  const forwarded = new Set(captureLines(capture).map((l) => `${tag} ${l}`));
  return { ...observed, log: observed.log.filter((l) => !forwarded.has(l)) };
}

// #447: the golden, with the two MEANS of the hand-derived rows compared within 1e-12 (see GOLDEN_MOTION on
// why) and every other column, and everything else in `observed`, compared exactly.
// #453: sound_level and sound_sd join them, for the hand-derived 12:00 sound row (see GOLDEN_SOUND on why).
const MEANS = new Set(['motion_level', 'motion_out_level', 'sound_level', 'sound_sd']);
function assertGolden(observed, golden) {
  const { activity, ...rest } = observed;
  const { activity: want, ...wantRest } = golden;
  assert.equal(activity.length, want.length, `${activity.length} activity rows`);
  activity.forEach((row, i) => {
    assert.deepEqual(Object.keys(row), Object.keys(want[i]), `row ${i}: the same columns`);
    for (const [col, v] of Object.entries(want[i])) {
      if (MEANS.has(col) && typeof v === 'number') assert.ok(Math.abs(row[col] - v) < 1e-12, `row ${i} ${col}: ${row[col]}, want ${v}`);
      else assert.deepEqual(row[col], v, `row ${i} ${col}`);
    }
  });
  assert.deepEqual(rest, wantRest);
}

describe('detector decisions: the #373 golden, with a working, a throwing and no observation clock', { concurrency: false }, () => {
  for (const variant of Object.keys(CLOCK_VARIANTS)) {
  test(`motion (${variant} clock): activity, transitions, alerts and forwarded stderr across two generations`, async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: T0 });
    logger.clear();
    resetCamera(motionCamera.id);
    _resetObservationClocksForTests();
    const observations = [];
    _setObservationClockFactoryForTests(CLOCK_VARIANTS[variant](observations));
    t.after(() => _setObservationClockFactoryForTests(null));
    const before = detectorProcs.length;

    await startMotionDetector(motionCamera);
    await waitFor(() => detectorProcs.length === before + 1, 'the motion ffmpeg spawn');
    const gen1 = detectorProcs[before];
    assert.equal(gen1.command, 'ffmpeg');
    // The args the build ships (the stdout byte identity of exactly these was checked by
    // fixtures/obs/identity-v4.sh).
    assert.deepEqual(gen1.args.slice(0, 4), ['-nostdin', '-loglevel', '+level+info', '-nostats']);
    assert.equal(gen1.args[gen1.args.indexOf('-vf') + 1], 'showinfo@in=checksum=0,fps=5,scale=320:180,format=gray,showinfo@out');

    gen1.stderr.emit('data', Buffer.from(`${MOTION_CONFIG.join('\n')}\n`));
    const frames1 = [...MOTION_MIN1, ...MOTION_MIN2, paint({ flicker: true })];
    const rec1 = (k) => motionRecords(k, frames1[k]);
    const st1 = { bytes: 0, emitted: 0 };
    deliverObserved(t, gen1, single(MOTION_MIN1, T0), FRAME_BYTES, rec1, st1);
    t.mock.timers.setTime(T0 + 60_000);
    flushActivity(T0 + 60_000 + PAST_GRACE_MS); // #447: 12:00's row, as the tick after its grace writes it

    const min2 = T0 + 60_000;
    deliverObserved(t, gen1, burst(MOTION_MIN2.slice(0, 150), min2, 3), FRAME_BYTES, rec1, st1);
    deliverObserved(t, gen1, split(MOTION_MIN2.slice(150), min2 + 150 * STEP_MS, 40_000), FRAME_BYTES, rec1, st1);

    // Real captured stderr: a repeated decoder error ("Last message repeated" collapse) and a
    // connection failure, each split mid-line across two reads — as the new flag prints them.
    t.mock.timers.setTime(T0 + 119_900);
    emitSplit(gen1.stderr, levelled('loglevel-error.err', 'loglevel-rel.err'), 1000);
    emitSplit(gen1.stderr, levelled('rtsp-refused-error.err', 'rtsp-refused-rel.err'), 100);

    // The generation ends the way Node really orders it: 'exit' can come BEFORE stdout drains. One
    // whole frame arrives after 'exit' (still analysed by generation 1), then half a frame that never
    // completes (dropped: generation 2 starts with an empty buffer).
    t.mock.timers.setTime(T0 + 120_000);
    gen1.ended = true;
    gen1.emit('exit', 0, null);
    deliverObserved(t, gen1, [[T0 + 120_000, paint({ flicker: true })]], FRAME_BYTES, rec1, st1);
    gen1.stdout.emit('data', paint({ bed: true }).subarray(0, FRAME_BYTES / 2));
    gen1.stdout.emit('end');
    gen1.stderr.emit('end');
    gen1.emit('close', 0, null);
    await settle();
    // #447: 12:01's row. The frame drained after 'exit' arrived at 12:02:00, so it waits in 12:02 (it was in
    // the pre-#447 12:02 row, labelled with this flush's time).
    flushActivity(T0 + 120_000 + PAST_GRACE_MS);

    // The real 5 s relaunch (RESTART_DELAY_MS), then generation 2.
    await waitFor(() => detectorProcs.length === before + 2, 'the relaunched motion ffmpeg');
    const gen2 = detectorProcs[before + 1];
    gen2.stderr.emit('data', Buffer.from(`${MOTION_CONFIG.join('\n')}\n`));
    deliverObserved(t, gen2, single(MOTION_GEN2, T0 + 121_000), FRAME_BYTES, (k) => motionRecords(k, MOTION_GEN2[k]), { bytes: 0, emitted: 0 });
    t.mock.timers.setTime(T0 + 180_000);
    flushActivity(T0 + 180_000 + PAST_GRACE_MS);

    await stopMotionDetector(motionCamera.id);
    assert.deepEqual(gen2.signals, ['SIGTERM'], 'the stop must terminate generation 2');
    await settle();

    // No tap record may ever reach the log, whatever the clock did with it.
    assert.deepEqual(logger.getRecent().filter((l) => /showinfo|\bn: +\d+ pts:/.test(l)), []);
    if (variant === 'working') {
      // The clock really ran: every frame observed, in the generation that delivered it (C3) — the one
      // frame drained after 'exit' included.
      const gens = [...new Set(observations.map((o) => o.gen))];
      assert.equal(gens.length, 2);
      const inGen = (i) => observations.filter((o) => o.gen === gens[i]).sort((a, b) => a.idx - b.idx);
      assert.deepEqual([inGen(0).length, inGen(1).length], [601, 70]);
      // Planted truth, from the frames themselves: a frame byte-identical to its neighbour is part of a
      // static stretch (distinct inputs, same picture), which R3-2 makes ambiguous; a generation's last
      // frame has no later record to prove its source (R4-3); every other frame is REAL.
      for (const [i, frames] of [[0, frames1], [1, MOTION_GEN2]]) {
        const expectReal = frames.map((f, k) => !(k > 0 && f.equals(frames[k - 1])) && !(k < frames.length - 1 && f.equals(frames[k + 1])) && k !== frames.length - 1);
        assert.deepEqual(inGen(i).map((o) => o.cls === 'real'), expectReal, `generation ${i + 1}`);
      }
      assert.ok(observations.every((o) => o.cls === 'real' || o.cls === 'unknown'), 'no clone in a stream with no stall');
      // #493: not vacuous — the detector's clone ledger WAS listening on this clock the whole time.
      assert.equal(typeof getObservationClock(motionCamera.id, 'motion').onObservation, 'function');
      assert.ok(observations.some((o) => o.cls === 'unknown' && o.idx > 0), 'unknown frames were there to (wrongly) correct');
      const summary = getObservationClock(motionCamera.id, 'motion').summary();
      assert.equal(summary.warn, 0);
      assert.equal(summary.side, 'ok');
    } else {
      assert.equal(observations.length, 0);
    }

    const observed = {
      activity: rowsFor('activity_samples', motionCamera.id),
      transitions: rowsFor('bed_transitions', motionCamera.id),
      events: rowsFor('detection_events', motionCamera.id),
      log: logFor(motionCamera.name, motionCamera.mediamtx_path),
    };

    // The forwarded stderr is checked against the CAPTURE (an oracle independent of this module):
    // every non-blank captured line, verbatim, in order, tagged with the detector's path, and nothing
    // forwarded ahead of it.
    const tag = `[detect:${motionCamera.mediamtx_path}]`;
    const forwarded = observed.log.filter((l) => l.startsWith(`${tag} `)).map((l) => l.slice(tag.length + 1));
    const captured = captureLines('loglevel-error.err');
    assert.ok(captured.length > 50, 'the capture must be the real repeated-error run, not an empty file');
    assert.deepEqual(forwarded.slice(0, captured.length), captured);

    // #447: the hand derivation, checked against the pre-#447 RECORDING before it is trusted (GOLDEN_MOTION's
    // comment): MIN2's 300 frames plus the drained one made the old 12:02 row, generation 2's 69 the old 12:03.
    assert.ok(Math.abs((MIN2_SUM + FLICKER) / 301 - PRE447_MOTION_ROWS[1].motion_level) < 1e-12, 'the MIN2 + drained-frame derivation');
    assert.ok(Math.abs(GEN2_SUM / 69 - PRE447_MOTION_ROWS[2].motion_level) < 1e-12, 'the generation 2 derivation');
    assert.ok(Math.abs(GEN2_OUT_SUM / 69 - PRE447_MOTION_ROWS[2].motion_out_level) < 1e-12, 'the generation 2 outside derivation');
    assertGolden(withoutCapture(observed, tag, 'loglevel-error.err'), GOLDEN_MOTION);
  });

  test(`sound (${variant} clock): activity, alerts, level lines and forwarded stderr`, async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: T0 });
    logger.clear();
    resetCamera(soundCamera.id);
    _resetObservationClocksForTests();
    const observations = [];
    _setObservationClockFactoryForTests(CLOCK_VARIANTS[variant](observations));
    t.after(() => _setObservationClockFactoryForTests(null));
    const before = detectorProcs.length;

    await startSoundDetector(soundCamera);
    await waitFor(() => detectorProcs.length === before + 1, 'the sound ffmpeg spawn');
    const gen1 = detectorProcs[before];
    assert.ok(gen1.args.includes('s16le'));
    assert.deepEqual(gen1.args.slice(0, 4), ['-nostdin', '-loglevel', '+level+info', '-nostats']);
    assert.equal(gen1.args[gen1.args.indexOf('-af') + 1], 'ashowinfo');

    // Minute 1: single windows, then windows re-cut into 5,000-byte reads, then 4-window bursts.
    const WIN_BYTES = WIN_SAMPLES * 2;
    const st = { bytes: 0, emitted: 0 };
    deliverObserved(t, gen1, single(SOUND_MIN1.slice(0, 100), T0), WIN_BYTES, soundRecords, st);
    deliverObserved(t, gen1, split(SOUND_MIN1.slice(100, 200), T0 + 100 * STEP_MS, 5_000), WIN_BYTES, soundRecords, st);
    deliverObserved(t, gen1, burst(SOUND_MIN1.slice(200), T0 + 200 * STEP_MS, 4), WIN_BYTES, soundRecords, st);
    t.mock.timers.setTime(T0 + 60_000);
    flushActivity(T0 + 60_000 + PAST_GRACE_MS); // #447: 12:00's row

    deliverObserved(t, gen1, single(SOUND_MIN2, T0 + 60_000), WIN_BYTES, soundRecords, st);
    t.mock.timers.setTime(T0 + 120_000);
    flushActivity(T0 + 120_000 + PAST_GRACE_MS); // #447: 12:01's row

    // Real captured stderr with fftools' double-prefixed lines, split mid-line — as the new flag prints it.
    emitSplit(gen1.stderr, levelled('mjpeg-error.err', 'mjpeg-rel.err'), 700);

    await stopSoundDetector(soundCamera.id);
    assert.deepEqual(gen1.signals, ['SIGTERM'], 'the stop must terminate the sound ffmpeg');
    await settle();

    assert.deepEqual(logger.getRecent().filter((l) => /ashowinfo|\bn:\d+ pts:/.test(l)), []);
    if (variant === 'working') {
      // 600 windows, the one digitally silent window among them sampled but not analysed (C5): the clock's own
      // sense, "had a measurable loudness". The detector records it as a quiet reading since #453 (GOLDEN_SOUND).
      assert.equal(observations.length, 600);
      assert.equal(observations.filter((o) => o.cls === 'observed').length, 600);
      assert.equal(observations.filter((o) => !o.analysed).length, 1);
      assert.equal(getObservationClock(soundCamera.id, 'sound').summary().warn, 0);
    } else {
      assert.equal(observations.length, 0);
    }

    const observed = {
      activity: rowsFor('activity_samples', soundCamera.id),
      events: rowsFor('detection_events', soundCamera.id),
      log: logFor(soundCamera.name, soundCamera.mediamtx_path),
    };

    const tag = `[sound:${soundCamera.mediamtx_path}]`;
    const forwarded = observed.log.filter((l) => l.startsWith(`${tag} `)).map((l) => l.slice(tag.length + 1));
    const captured = captureLines('mjpeg-error.err');
    assert.ok(captured.length > 10, 'the capture must be the real fftools error run, not an empty file');
    assert.deepEqual(forwarded, captured);

    assertGolden(withoutCapture(observed, tag, 'mjpeg-error.err'), GOLDEN_SOUND);
  });
  }
});

// --- #493: a camera stall's clones, through the REAL motion detector -----------------------------------------
// The #373 soak box's stall, played through the real detector and the real stderr router: 5 fps input, then
// nothing for 3.06 s after frame 150, then 5 fps again. Each input sits 8,000 ticks (89 ms) into its output
// slot, so the gap spans 15.3 slots and fps fills slots 151-165 with repeats of frame 150 — the 15-frame burst
// the soak run showed — delivered to stdout in one clump when frame 151 arrives. The stream is emulated by
// obsRig's feedStream (vf_fps's documented rule; it only CONSTRUCTS inputs), whose `truth` is the planted
// oracle for which outputs are repeats. The run is repeated with a WORKING clock, a THROWING one, NO clock,
// and a working clock whose tap lines stop before the stall (the "side channel lost" case, observation-
// clock.test.js's F6 family), on a camera WITH a bed zone and one WITHOUT. What must hold:
//   - bed transitions, alerts and every log line are identical in all four (nothing here feeds a decision);
//   - no clock, a throwing one and a lost side channel store exactly the same rows: with no proof, nothing is
//     corrected (a lost side channel makes every later frame `unknown`, which is never corrected);
//   - the working clock's stall minute stores 16 fewer motion_frames (the 15 fps repeats, and one planted CFR
//     duplicate, below), and motion_level / motion_out_level are the same sums over 16 fewer frames; its
//     peaks, and the whole of the next minute, are identical;
//   - without a bed zone, motion_out_* stay NULL whatever was corrected.
const STALL_INPUTS = 575; // ~119 s of stream: two stored minutes, with the stall in the first
// #452: the planted stall's own length (stallInputs: 275,400 ticks at 90 kHz before input 151), not a recording of the
// code's output: the frame the hold releases is stamped with the receipt time of input 151, 3,060 ms after input 150's.
const STALL_RESTART_GAP_MS = 3060;
// `base` = the receipt time of stream time 0 (#447's relaunch test shifts it so the collision sits in one minute).
function stallInputs(base = T0) {
  const out = [];
  let pts = 8000;
  for (let n = 0; n < STALL_INPUTS; n += 1) {
    if (n > 0) pts += n === 151 ? 275_400 : 18000; // 3.06 s at 90 kHz before frame 151, else 0.2 s
    out.push({ n, pts, rx: base + Math.ceil(pts / 90) + 10 }); // integer ms: the mocked Date is set to it
  }
  return out;
}
// Every input is a distinct picture: a marker of at most 16 grey levels (under the detector's PIXEL_DELTA
// of 24, so it never counts as movement) encodes its number in three corner pixels. Without it, the quiet
// stretches would be identical frames, which the clock rightly calls ambiguous. Movement is planted: the bed
// lit on alternate frames in three runs (the last one ENDS on frame 150, so the repeated frame is a lit
// one), the outside in one, both in the second minute.
function stallPicture(n) {
  const lit = n % 2 === 0;
  const bed = lit && ((n >= 40 && n < 60) || (n >= 140 && n <= 150) || (n >= 200 && n < 220) || (n >= 400 && n < 420));
  const out = lit && ((n >= 70 && n < 80) || (n >= 400 && n < 420));
  const f = paint({ bed, out });
  f[FRAME_BYTES - 1] = BASE + (n % 17);
  f[FRAME_BYTES - 2] = BASE + (Math.floor(n / 17) % 17);
  f[FRAME_BYTES - 3] = BASE + (Math.floor(n / 289) % 17);
  return f;
}
// Tap lines for any input pts / output slot, laid out exactly as motionRecords() above (which prints only
// the 1:1 case).
function inRecordLines(n, pts) {
  return [
    `[showinfo@in @ 0x7f00000a0000] [info] n:${String(n).padStart(4)} pts:${String(pts).padStart(7)} pts_time:${ts(pts / 90000)} duration:  18000 duration_time:0.2     fmt:yuv420p cl:left sar:1/1 s:640x360 i:P iskey:0 type:P `,
    '[showinfo@in @ 0x7f00000a0000] [info] color_range:tv color_space:bt709 color_primaries:bt709 color_trc:bt709',
  ];
}
function outRecordLines(n, slot, frame) {
  const sum = hex8(zlibAdler0(frame));
  return [
    `[showinfo@out @ 0x7f00000b0000] [info] n:${String(n).padStart(4)} pts:${String(slot).padStart(7)} pts_time:${ts(slot * 0.2)} duration:      1 duration_time:0.2     fmt:gray cl:unspecified sar:1/1 s:320x180 i:P iskey:0 type:P checksum:${sum} plane_checksum:[${sum}] mean:[60] stdev:[40.0]`,
    '[showinfo@out @ 0x7f00000b0000] [info] color_range:pc color_space:unknown color_primaries:unknown color_trc:unknown',
  ];
}
// feedStream, recording what ffmpeg would print and write instead of feeding a clock: per receipt time, the
// tap lines (the `in` record, then each `out` record fps emits) and the stdout frames the CFR hold releases.
// PLANTED on top: output 250 (~50 s, well clear of the stall) is written to stdout TWICE, the rawvideo CFR
// stage's own kind of repeat. The clock proves that one `cfr-clone`, which the detector corrects as well.
const CFR_DUP_OUTPUT = 250;
// `dropOut`: output numbers whose `out` tap line is lost (glued or garbled); the frame is still written.
function stallSchedule({ dropOut = [], base = T0 } = {}) {
  const pictures = new Map();
  const picture = (src) => {
    if (!pictures.has(src)) pictures.set(src, stallPicture(src));
    return pictures.get(src);
  };
  const groups = new Map();
  const group = (at) => {
    const k = Math.floor(at);
    if (!groups.has(k)) groups.set(k, { lines: [], frames: [] });
    return groups.get(k);
  };
  let written = 0;
  const recorder = {
    inRec: (n, pts, at) => group(at).lines.push(...inRecordLines(n, pts)),
    outRec: (n, slot, src, at) => group(at).lines.push(...outRecordLines(n, slot, picture(src))),
    sample: (src, at) => {
      group(at).frames.push(picture(src));
      if (written === CFR_DUP_OUTPUT) group(at).frames.push(picture(src));
      written += 1;
    },
  };
  const inputs = stallInputs(base);
  const s = feedStream(recorder, inputs, { content: (src) => src, dropOut });
  s.flush(inputs[inputs.length - 1].rx + 50);
  return { groups: [...groups.entries()], truth: s.truth };
}

describe('#493: a stall\'s clones leave motion_frames/motion_level/motion_out_level, and nothing else moves', { concurrency: false }, () => {
  const STALL_VARIANTS = ['working', 'throwing', 'none', 'side-channel-lost', 'swallows-one-sample'];
  // #447: when the tracker writes each minute's row — its end plus a tick past the grace — and not, as before,
  // a flush AT each minute boundary. Frames are counted per minute of RECEIPT (perMinute below). The stall's
  // clones are proven at ~38 s and the CFR duplicate at ~55 s, so the grace changes nothing in this stream.
  const WRITES = [T0 + 60_000 + PAST_GRACE_MS, T0 + 120_000 + PAST_GRACE_MS];
  const LOSE_AT = T0 + 24_000; // tap lines stop ~6 s before the stall (frame 150 arrives at ~30.1 s)
  const proven = (o) => o.cls === 'fps-clone' || o.cls === 'cfr-clone';

  // Review round 1 (gap 4): a WORKING clock that throws on one sample, as a clock bug would. The handle
  // catches it and detection carries on, but the clock never counts that sample, so from there on its own
  // sample number (`idx`) runs one behind the detector's frame number (`token`). In every other fixture the
  // two are equal, which is why a listener correcting by `idx` survived. The ledger must still correct exactly
  // what the working clock corrects. (No real clock is known to throw here; the fail-safe exists because a
  // clock bug must never misdirect anything, and this is what such a bug looks like.)
  const SWALLOWED_TOKEN = 101; // a quiet frame, 50 frames before the stall
  function swallowingClock(captured) {
    const working = CLOCK_VARIANTS.working(captured);
    return (cameraId, leg, opts) => {
      const clock = working(cameraId, leg, opts);
      return {
        receipt: () => clock.receipt(),
        beginGeneration: (o) => {
          const gen = clock.beginGeneration(o);
          const real = gen.onSample.bind(gen);
          let calls = 0;
          gen.onSample = (...args) => {
            calls += 1;
            if (calls === SWALLOWED_TOKEN + 1) throw new Error('clock failure on one sample (planted)');
            return real(...args);
          };
          return gen;
        },
      };
    };
  }
  const factoryFor = (variant, observations) => {
    if (variant === 'swallows-one-sample') return swallowingClock(observations);
    return CLOCK_VARIANTS[variant === 'side-channel-lost' ? 'working' : variant](observations);
  };

  // `tag` keeps each run's camera (and so its rows) apart; `dropOut` loses those outputs' `out` tap lines;
  // `inLostFrom` loses every `in` tap line from that time on (the `out` lines keep coming).
  async function runStall(t, variant, zone, { tag = '', dropOut = [], inLostFrom = Infinity } = {}) {
    const cam = {
      ...motionCamera,
      id: `cam-493-${zone ? 'zone' : 'nozone'}-${variant}${tag}`,
      name: '493 Stall Cam', // the SAME name in every run, so the log lines can be compared verbatim
      mediamtx_path: `path_493_${zone ? 'zone' : 'nozone'}_${variant.replace(/-/g, '_')}${tag}`,
      detect_zone: zone ? motionCamera.detect_zone : null,
    };
    makeCamera(db, { id: cam.id, name: cam.name, path: cam.mediamtx_path });
    logger.clear();
    _resetObservationClocksForTests();
    const observations = [];
    _setObservationClockFactoryForTests(factoryFor(variant, observations));
    const before = detectorProcs.length;
    t.mock.timers.setTime(T0 - 1000);
    await startMotionDetector(cam);
    await waitFor(() => detectorProcs.length === before + 1, `${cam.id} spawn`);
    const proc = detectorProcs[before];
    proc.stderr.emit('data', Buffer.from(`${MOTION_CONFIG.join('\n')}\n`));

    const { groups, truth } = stallSchedule({ dropOut });
    let fi = 0;
    const perMinute = [0, 0];
    for (const [at, g] of groups) {
      while (fi < WRITES.length && at >= WRITES[fi]) {
        flushActivity(WRITES[fi]);
        fi += 1;
      }
      t.mock.timers.setTime(at);
      const lost = variant === 'side-channel-lost' && at >= LOSE_AT;
      const lines = at >= inLostFrom ? g.lines.filter((l) => !l.startsWith('[showinfo@in ')) : g.lines;
      if (lines.length && !lost) proc.stderr.emit('data', Buffer.from(`${lines.join('\n')}\n`));
      if (g.frames.length) proc.stdout.emit('data', Buffer.concat(g.frames));
      perMinute[Math.floor((at - T0) / 60_000)] += g.frames.length;
    }
    for (; fi < WRITES.length; fi += 1) flushActivity(WRITES[fi]);
    await stopMotionDetector(cam.id);
    await settle();
    _setObservationClockFactoryForTests(null);
    const strip = (rs) => rs.map(({ camera_id: _c, ...r }) => r);
    return {
      truth,
      perMinute,
      observations,
      activity: strip(rowsFor('activity_samples', cam.id)),
      transitions: strip(rowsFor('bed_transitions', cam.id)),
      events: strip(rowsFor('detection_events', cam.id)),
      log: logFor(cam.name),
    };
  }

  for (const zone of [true, false]) {
    test(`${zone ? 'with' : 'WITHOUT'} a bed zone: the working clock takes exactly the 15 fps repeats and the CFR duplicate out of the stall minute, and every other variant stores what the code before #493 stored`, async (t) => {
      t.mock.timers.enable({ apis: ['Date'], now: T0 - 1000 });
      const run = {};
      for (const variant of STALL_VARIANTS) run[variant] = await runStall(t, variant, zone);
      const { truth, perMinute } = run.none;

      // The planted oracle, checked first: the repeats are outputs 151-165, all in the first minute.
      const clones = truth.filter((x, i) => i > 0 && x.src === truth[i - 1].src).map((x) => x.outN);
      assert.deepEqual(clones, Array.from({ length: 15 }, (_, i) => 151 + i));
      assert.ok(perMinute[0] > 200 && perMinute[1] > 200, `two full minutes: ${perMinute}`);

      // Decisions: identical everywhere. The runs really made some (not an empty comparison).
      assert.ok(run.none.events.length > 0 && run.none.log.length > 0, 'the scene alerted and logged');
      for (const v of STALL_VARIANTS) {
        assert.deepEqual(run[v].transitions, run.none.transitions, `${v}: bed transitions`);
        assert.deepEqual(run[v].events, run.none.events, `${v}: alerts`);
        assert.deepEqual(run[v].log, run.none.log, `${v}: log lines`);
      }
      // ★ #452: the one line the stall adds. The 3,060 ms hole falls in the middle of a bed-active run (frames
      // 140-150), so the motion run restarts ONCE, on the first frame of the clump that follows it; nothing is
      // pending on the bed-transition side, so no `confirmation restarted` line. Identical in every clock variant
      // (asserted above on the whole log), and the line carries no camera path, which differs per variant. The
      // rest of the log is what it was before #452. The gap is the planted 3,060 ms (STALL_RESTART_GAP_MS).
      const restartLines = run.none.log.filter((l) => l.includes('motion run restarted'));
      assert.deepEqual(restartLines, [`[INFO] [detect] "493 Stall Cam" motion run restarted — no frames for ${STALL_RESTART_GAP_MS}ms`]);
      assert.deepEqual(run.none.log.filter((l) => l.includes('confirmation restarted')), [], 'no bed-transition candidate was pending across the stall');

      // No proof, no correction: the raw counts, byte for byte. Minute 1's raw count is every frame written
      // before its flush, less the generation's first (the detector's baseline, never counted).
      const [raw1, raw2] = run.none.activity;
      assert.equal(raw1.motion_frames, perMinute[0] - 1);
      assert.equal(raw2.motion_frames, perMinute[1]);
      assert.deepEqual(run.throwing.activity, run.none.activity, 'a throwing clock');
      assert.deepEqual(run['side-channel-lost'].activity, run.none.activity, 'a clock whose tap lines stopped');
      assert.ok(!run['side-channel-lost'].observations.some((o) => o.cls === 'fps-clone' || o.cls === 'cfr-clone'), 'nothing proven after the loss');
      assert.ok(run['side-channel-lost'].observations.some((o) => o.cls === 'unknown' && o.idx > 160), 'the burst was there, and came out unknown');

      // The working clock: it proved exactly the planted repeats, by the detector's own frame numbers — a
      // token is the stdout frame's index, so outputs 151-165 are frames 151-165, and output 250's duplicate
      // is frame 251.
      const verdicts = run.working.observations.filter(proven);
      assert.deepEqual(verdicts.map((o) => [o.token, o.cls]), [...clones.map((k) => [k, 'fps-clone']), [CFR_DUP_OUTPUT + 1, 'cfr-clone']]);
      // A clock that swallowed one sample proves the same frames, under the same tokens, while its own
      // sample numbers run one behind (the premise, checked, not assumed) — and stores exactly what the
      // working clock stores. By `idx`, it would have corrected frame 150 (which moved, so it is not staged)
      // instead of 151, and frame 250 instead of 251: one correction short.
      const swallowed = run['swallows-one-sample'].observations.filter(proven);
      assert.deepEqual(swallowed.map((o) => o.token), verdicts.map((o) => o.token));
      assert.ok(swallowed.every((o) => o.idx === o.token - 1), 'idx and token really differ here');
      assert.deepEqual(run['swallows-one-sample'].activity, run.working.activity);
      const [w1, w2] = run.working.activity;
      assert.deepEqual(w2, raw2, 'the next minute: untouched');
      assert.equal(w1.motion_frames, raw1.motion_frames - 16);
      const rescale = (level) => (level * raw1.motion_frames) / (raw1.motion_frames - 16);
      assert.ok(raw1.motion_level > 0 && Math.abs(w1.motion_level - rescale(raw1.motion_level)) < 1e-12, `motion_level ${w1.motion_level}`);
      if (zone) {
        assert.ok(raw1.motion_out_level > 0 && Math.abs(w1.motion_out_level - rescale(raw1.motion_out_level)) < 1e-12, `motion_out_level ${w1.motion_out_level}`);
      } else {
        assert.equal(raw1.motion_out_level, null);
        assert.equal(w1.motion_out_level, null, 'no bed zone: no out-of-bed channel to correct, and none conjured');
        assert.equal(w1.motion_out_peak, null);
      }
      const { motion_frames: _f, motion_level: _l, motion_out_level: _o, ...rest1 } = w1;
      const { motion_frames: _rf, motion_level: _rl, motion_out_level: _ro, ...rawRest1 } = raw1;
      assert.deepEqual(rest1, rawRest1, 'every other column of the stall minute, peaks included');
      // The lit bed is 1/3 of the zone, or 1/6 of the whole frame without one.
      assert.ok(raw1.motion_peak > 0.15, `a real peak was measured in the stall minute: ${raw1.motion_peak}`);
    });
  }

  // The reconnect race the plan's first review found. A settings change restarts the detector: the old
  // ffmpeg's 'exit' lets the new launch start while its pipes are still open, and its 'close' — which ends
  // its generation and delivers its last ~5 s of verdicts, the stall burst's among them — comes only after
  // the new launch has counted frames of its own, numbered from 0 again. By then the clock's one listener
  // is the NEW launch's.
  // ★ The collision has to be REAL for this to test anything (review round 1, gap 5: the first version's new
  // launch counted frames 0-9 only, so the late verdicts for 151-165 could not meet them, and a ledger key
  // WITHOUT the generation passed). Here the new launch counts 200 frames, so its own frames 151-165 are in
  // the ledger when the old launch's verdicts for 151-165 arrive. And the restart ADDS a bed zone: the old
  // frames were counted in bed only, the new ones in bed AND outside, so a verdict that landed on the wrong
  // launch's frame shows up as an out-of-bed correction that must not happen.
  // ★ #447 REWROTE THE TIMELINE, NOT THE CLAIM (plan round 2, E). The old launch's burst (~33 s into its stream)
  // is proven only when its pipes close, after the new launch's 200 frames: ~45 s later. The #493 version ran
  // the whole thing from 12:00:00, so the burst's minute had ENDED 18 s before its verdicts came; it passed only
  // because nothing wrote that minute until one flush at the very end, which the 1 s tick now does at 12:01:07.
  // Here the old stream starts 30 s before a minute boundary, so the burst, the new launch's colliding frames
  // 151-165 and the late verdicts all fall inside the ONE minute 12:00, still open, while the tracker ticks every
  // second as it really does. Two rows: 11:59 (the old launch's first 30 s) and 12:00.
  const RELAUNCH_BASE = T0 - 30_000; // stream time 0 of the old launch
  const RELAUNCH_CLOSE_AT = RELAUNCH_BASE + 78_000; // 12:00:48, after the new launch's 200 frames (37 s + 40 s)
  async function runRelaunch(t, variant) {
    const withZone = { ...motionCamera, id: `cam-493-relaunch-${variant}`, name: '493 Relaunch Cam', mediamtx_path: `path_493_relaunch_${variant}` };
    const noZone = { ...withZone, detect_zone: null };
    makeCamera(db, { id: withZone.id, name: withZone.name, path: withZone.mediamtx_path });
    logger.clear();
    _resetObservationClocksForTests();
    const observations = [];
    _setObservationClockFactoryForTests(factoryFor(variant, observations));
    // The tracker's 1 s timer, emulated on the planted clock: every tick up to `ms`, before the event at `ms`.
    let nextTick = RELAUNCH_BASE;
    const tickTo = (ms) => { for (; nextTick <= ms; nextTick += 1000) flushActivity(nextTick); };
    const before = detectorProcs.length;
    t.mock.timers.setTime(RELAUNCH_BASE - 1000);
    await startMotionDetector(noZone);
    await waitFor(() => detectorProcs.length === before + 1, 'the first launch');
    const old = detectorProcs[before];
    old.stderr.emit('data', Buffer.from(`${MOTION_CONFIG.join('\n')}\n`));
    let oldFrames = 0;
    for (const [at, g] of stallSchedule({ base: RELAUNCH_BASE }).groups) {
      if (at >= RELAUNCH_BASE + 36_000) break; // the burst (~33.2 s) is in; its verdicts (~38.2 s) are not yet
      tickTo(at);
      t.mock.timers.setTime(at);
      if (g.lines.length) old.stderr.emit('data', Buffer.from(`${g.lines.join('\n')}\n`));
      if (g.frames.length) old.stdout.emit('data', Buffer.concat(g.frames));
      oldFrames += g.frames.length;
    }
    const earlyVerdicts = observations.filter(proven).length;

    // This ffmpeg exits at once, but its pipes close later: 'close' is emitted by hand, below.
    old.kill = (signal) => {
      old.signals.push(signal);
      old.ended = true;
      queueMicrotask(() => old.emit('exit', null, signal));
      return true;
    };
    tickTo(RELAUNCH_BASE + 36_000);
    t.mock.timers.setTime(RELAUNCH_BASE + 36_000);
    await startMotionDetector(withZone);
    await waitFor(() => detectorProcs.length === before + 2, 'the relaunch');
    const next = detectorProcs[before + 1];
    next.stderr.emit('data', Buffer.from(`${MOTION_CONFIG.join('\n')}\n`));
    // The new launch's own 200 frames, numbered 0-199: the stall scene's pictures, so frames 152-165 are
    // still in bed AND outside (staged in both channels) and 151 is still outside only.
    const fresh = Array.from({ length: 200 }, (_, k) => stallPicture(k));
    const st = { bytes: 0, emitted: 0 };
    for (const step of single(fresh, RELAUNCH_BASE + 37_000)) {
      tickTo(step[0]);
      deliverObserved(t, next, [step], FRAME_BYTES, (k) => motionRecords(k, fresh[k]), st);
    }

    // Now the old pipes close: the old generation ends and its burst's verdicts arrive, 12:00 still open.
    tickTo(RELAUNCH_CLOSE_AT);
    t.mock.timers.setTime(RELAUNCH_CLOSE_AT);
    old.stdout.emit('end');
    old.stderr.emit('end');
    old.emit('close', null, 'SIGTERM');
    await settle();
    tickTo(T0 + 60_000 + PAST_GRACE_MS); // 12:00 is written at 12:01:07
    const closedAt = nextTick - 1000;
    await stopMotionDetector(withZone.id);
    await settle();
    _setObservationClockFactoryForTests(null);
    return { observations, oldFrames, freshFrames: fresh.length, earlyVerdicts, closedAt, rows: rowsFor('activity_samples', withZone.id) };
  }

  test('a verdict that lands AFTER a relaunch still corrects its own launch\'s frame — keyed by the verdict\'s generation, not the listener\'s', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: RELAUNCH_BASE - 1000 });
    const w = await runRelaunch(t, 'working');
    const n = await runRelaunch(t, 'none');
    assert.equal(w.earlyVerdicts, 0, 'no burst verdict arrived before the relaunch');
    const oldGen = w.observations[0].gen;
    assert.deepEqual(w.observations.filter(proven).map((o) => [o.gen, o.token]), Array.from({ length: 15 }, (_, i) => [oldGen, 151 + i]), 'the OLD launch\'s burst, proven after the relaunch');
    // The premise, checked: the NEW launch had already counted its own frames 151-165 when those verdicts came,
    // and all of it (the burst, the collision, the verdicts) happened inside the still-open minute 12:00.
    const newOwn = w.observations.filter((o) => o.gen !== oldGen && o.token >= 151 && o.token <= 165);
    assert.equal(newOwn.length, 15);
    assert.ok(newOwn.every((o) => o.gen > oldGen && o.rxMono < RELAUNCH_CLOSE_AT), 'the collision is real');
    const burst = w.observations.filter((o) => o.gen === oldGen && o.token >= 151 && o.token <= 165);
    assert.ok(burst.every((o) => o.rxMono >= T0 && o.rxMono < T0 + 60_000), 'the burst was received in 12:00');
    assert.ok(RELAUNCH_CLOSE_AT < T0 + 60_000, 'its verdicts came while 12:00 was still receiving');
    assert.ok(w.closedAt >= T0 + 67_000, 'and the tracker really ticked every second up to 12:00\'s write');

    assert.deepEqual(w.rows.map((r) => r.bucket_start), ['2026-09-25 11:59:00', '2026-09-25 12:00:00']);
    assert.deepEqual(n.rows.map((r) => r.bucket_start), ['2026-09-25 11:59:00', '2026-09-25 12:00:00']);
    const [w1159, wr] = w.rows;
    const [n1159, nr] = n.rows;
    // Each launch's first frame is its baseline, never counted.
    assert.equal(n1159.motion_frames + nr.motion_frames, (w.oldFrames - 1) + (w.freshFrames - 1), 'no clock: every frame of both launches');
    assert.deepEqual({ ...w1159, camera_id: null }, { ...n1159, camera_id: null }, '11:59, before the burst: nothing to correct');
    assert.equal(wr.motion_frames, nr.motion_frames - 15, 'the old launch\'s 15 repeats out');
    assert.ok(Math.abs(wr.motion_level - (nr.motion_level * nr.motion_frames) / (nr.motion_frames - 15)) < 1e-12);
    assert.ok(nr.motion_out_level > 0);
    assert.equal(wr.motion_out_level, nr.motion_out_level, 'the old frames had no out-of-bed reading to undo, and the new launch\'s frames 151-165 keep theirs');
    assert.deepEqual([wr.motion_peak, wr.motion_out_peak], [nr.motion_peak, nr.motion_out_peak]);
  });

  test('an `unknown` verdict is never corrected, whatever its reason: out-hole, cfr-unproven, clone-unproven', async (t) => {
    // Review round 1 (gap 3): the fixtures above produce proven clones plus `unknown` for the ordinary reasons
    // only (ambiguous, unmatched, source-unproven), so a listener widened to ALSO correct any one of these
    // reasons survived them. Each is planted here on frames the ledger HAS staged (fraction 0), with its
    // verdict arriving while the minute is still open, so a widened listener would take them out:
    //   - out-hole: output 166's `out` line is lost, right after the stall burst. The burst is still repeats
    //     of frame 150, but beside a lost line its samples could be the lost record's own, so all of them
    //     are `unknown (out-hole)` and stay counted — uncorrected by design, because unproven;
    //   - cfr-unproven: output 251's `out` line is lost, right after the planted CFR duplicate of output 250,
    //     so nothing proves the duplicate is not output 251's own identical picture;
    //   - clone-unproven: from 110 s every `in` line is lost while the `out` lines keep coming (a tap that
    //     stopped parsing). Those frames are REAL, but with no later `in` record the clock cannot prove even
    //     that; correcting them would throw away real observation.
    t.mock.timers.enable({ apis: ['Date'], now: T0 - 1000 });
    const opts = { tag: '-reasons', dropOut: [166, CFR_DUP_OUTPUT + 1], inLostFrom: T0 + 110_000 };
    const w = await runStall(t, 'working', true, opts);
    const n = await runStall(t, 'none', true, opts);
    const tokensOf = (reason) => w.observations.filter((o) => o.reason === reason).map((o) => o.token);
    for (let k = 151; k <= 165; k += 1) assert.ok(tokensOf('out-hole').includes(k), `repeat ${k}: out-hole`);
    assert.deepEqual(tokensOf('cfr-unproven'), [CFR_DUP_OUTPUT + 1], 'the duplicate: cfr-unproven');
    // In time to be corrected: received more than FINALIZE_MS (plus one frame) before the stream ends at ~120 s,
    // so judged while frames were still arriving, well before the 12:01 row is written.
    const lateTail = w.observations.filter((o) => o.reason === 'clone-unproven' && o.rxMono + 5_200 < T0 + 120_000);
    assert.ok(lateTail.length >= 10, `real frames after the in-tap loss, judged in time: ${lateTail.length}`);
    assert.ok(!w.observations.some(proven), 'nothing is proven anywhere in this stream');
    assert.deepEqual(w.activity, n.activity, 'and so nothing is corrected');
    for (const k of ['transitions', 'events', 'log']) assert.deepEqual(w[k], n[k], k);
  });

  test('...nor `unknown (no-anchor)`: frames first judged after more than an hour of silence', async (t) => {
    // A generation's observation times are anchored at its first judgement, on the `in` records of the last
    // hour. A launch that delivers a second of frames and then nothing, its session still up, for over an
    // hour, has none left when it finally ends, so every frame it delivered is `unknown (no-anchor)`. Since
    // #369 the detector watchdog restarts a detector whose output stops for ~75 s, so this is effectively
    // unreachable in production; it is pinned so a listener widened to this reason is still caught.
    t.mock.timers.enable({ apis: ['Date'], now: T0 - 1000 });
    const runSilent = async (variant) => {
      const cam = { ...motionCamera, id: `cam-493-noanchor-${variant}`, name: '493 Silent Cam', mediamtx_path: `path_493_noanchor_${variant}` };
      makeCamera(db, { id: cam.id, name: cam.name, path: cam.mediamtx_path });
      _resetObservationClocksForTests();
      const observations = [];
      _setObservationClockFactoryForTests(factoryFor(variant, observations));
      const before = detectorProcs.length;
      t.mock.timers.setTime(T0 - 1000);
      await startMotionDetector(cam);
      await waitFor(() => detectorProcs.length === before + 1, `${cam.id} spawn`);
      const proc = detectorProcs[before];
      proc.stderr.emit('data', Buffer.from(`${MOTION_CONFIG.join('\n')}\n`));
      for (const [at, g] of stallSchedule().groups) {
        if (at >= T0 + 1_300) break; // inputs 0-6: stdout frames 0-4, all still pictures
        t.mock.timers.setTime(at);
        if (g.lines.length) proc.stderr.emit('data', Buffer.from(`${g.lines.join('\n')}\n`));
        if (g.frames.length) proc.stdout.emit('data', Buffer.concat(g.frames));
      }
      t.mock.timers.setTime(T0 + 3_700_000); // an hour and a bit of silence, then the stop
      await stopMotionDetector(cam.id);
      await settle();
      flushActivity();
      _setObservationClockFactoryForTests(null);
      return { observations, rows: rowsFor('activity_samples', cam.id) };
    };
    const w = await runSilent('working');
    const n = await runSilent('none');
    assert.deepEqual(w.observations.filter((o) => o.reason === 'no-anchor').map((o) => o.token), [0, 1, 2, 3, 4], 'every frame: no-anchor');
    assert.equal(n.rows[0].motion_frames, 4, 'frames 1-4 counted (0 is the baseline)');
    assert.deepEqual(w.rows, n.rows.map((r) => ({ ...r, camera_id: w.rows[0].camera_id })), 'nothing corrected');
  });
});

// --- #373 wiring beyond the golden ------------------------------------------------------------------------
describe('#373 wiring on a live detector', { concurrency: false }, () => {
  async function started(t, camera, start) {
    t.mock.timers.enable({ apis: ['Date'], now: T0 });
    logger.clear();
    _resetObservationClocksForTests();
    _setObservationClockFactoryForTests(CLOCK_VARIANTS.working([]));
    t.after(() => _setObservationClockFactoryForTests(null));
    makeCamera(db, { id: camera.id, name: camera.name, path: camera.mediamtx_path });
    const before = detectorProcs.length;
    await start(camera);
    await waitFor(() => detectorProcs.length === before + 1, `${camera.id} spawn`);
    return { proc: detectorProcs[before], before };
  }

  test('the rate limit binds on a flood only: 300 drifted lines are capped at 50 plus one note, and a real error still gets through', async (t) => {
    const cam = { ...soundCamera, id: 'cam-flood', name: 'Flood Cam', mediamtx_path: 'path_flood' };
    const { proc } = await started(t, cam, startSoundDetector);
    const junk = `${Array.from({ length: 300 }, (_, i) => `drifted ffmpeg output ${i}`).join('\n')}\n`;
    proc.stderr.emit('data', Buffer.from(junk));
    proc.stderr.emit('data', Buffer.from('[aist#0:0/pcm_alaw @ 0x7f0000000001] [error] a real error after the flood\n'));
    await stopSoundDetector(cam.id);
    await settle();
    const fwd = logger.getRecent().filter((l) => l.includes('[sound:path_flood]'));
    assert.equal(fwd.filter((l) => /\] drifted ffmpeg output \d+$/.test(l)).length, 50);
    assert.ok(fwd.some((l) => l.endsWith('[obs] 250 ffmpeg stderr line(s) not shown (rate limit); last: drifted ffmpeg output 299')));
    assert.ok(fwd.some((l) => l.endsWith('[aist#0:0/pcm_alaw @ 0x7f0000000001] a real error after the flood')));
  });

  test('generations stay isolated: bytes from an old process after its close are counted late and never reach the new generation', async (t) => {
    const cam = { ...motionCamera, id: 'cam-late', name: 'Late Cam', mediamtx_path: 'path_late' };
    const { proc: gen1, before } = await started(t, cam, startMotionDetector);
    gen1.stderr.emit('data', Buffer.from(`${MOTION_CONFIG.join('\n')}\n`));
    const st = { bytes: 0, emitted: 0 };
    deliverObserved(t, gen1, single(MOTION_GEN2, T0), FRAME_BYTES, (k) => motionRecords(k, MOTION_GEN2[k]), st);
    gen1.finish(1); // a real failure: logged, relaunched after the real 5 s
    await waitFor(() => detectorProcs.length === before + 2, 'the relaunch');
    const gen2 = detectorProcs[before + 1];
    gen2.stderr.emit('data', Buffer.from(`${MOTION_CONFIG.join('\n')}\n`));
    deliverObserved(t, gen2, single(MOTION_GEN2.slice(0, 20), T0 + 30_000), FRAME_BYTES, (k) => motionRecords(k, MOTION_GEN2[k]), { bytes: 0, emitted: 0 });
    const clock = getObservationClock(cam.id, 'motion');
    const lateBefore = clock.summary().late;
    // Hostile: generation 1's pipes deliver AFTER its close. The late frame reaches generation 1's handle,
    // which counts and drops it; late stderr never even reaches the router, because processOutput.js's
    // line buffer ignores writes after its end (pre-existing behaviour).
    const gen2Before = clock.summary().samples;
    gen1.stdout.emit('data', paint({ bed: true }));
    gen1.stderr.emit('data', Buffer.from(`${motionRecords(99, paint({ bed: true })).join('\n')}\n`));
    assert.equal(clock.summary().late, lateBefore + 1, 'the late frame: dropped and counted');
    assert.equal(clock.summary().samples, gen2Before, 'nothing entered generation 2');
    await stopMotionDetector(cam.id);
    await settle();
    assert.equal(clock.summary().warn, 0);
  });

  test('a stop inside the #253 restart window leaves no open generation, so the idle sweep can evict the clock (R2-O9)', async (t) => {
    const cam = { ...motionCamera, id: 'cam-window', name: 'Window Cam', mediamtx_path: 'path_window' };
    const { proc } = await started(t, cam, startMotionDetector);
    proc.finish(1); // 'exit' then 'close': the generation ends; a relaunch is armed for 5 s from now
    await settle();
    await stopMotionDetector(cam.id); // returns early (no entry), after cancelling the relaunch
    const clock = getObservationClock(cam.id, 'motion');
    assert.equal(clock.gens.some((g) => g.open), false);
    t.mock.timers.setTime(Date.now() + 3_600_000);
    sweepIdleClocks();
    assert.notEqual(getObservationClock(cam.id, 'motion'), clock, 'evicted after an hour idle');
  });

  // ★ F8 (fix round 1): R1-F8 and "rx once per 'data' event" were reported as untestable. They are not: a
  // stub observer can look, at the moment it is called, for the decision handler's own side effect, and
  // count receipt() calls. Recorded, not asserted inside the stub: the detectors' handle swallows throws.
  function stubObserver(check) {
    const seen = { receipts: 0, samples: [] };
    _setObservationClockFactoryForTests(() => ({
      receipt: () => {
        seen.receipts += 1;
        return { mono: Date.now(), wall: Date.now() };
      },
      beginGeneration: () => ({
        onRecord() {}, onConfig() {}, onParseError() {}, end() {},
        onSample: () => seen.samples.push(check()),
      }),
    }));
    return seen;
  }

  test('F8 motion: one receipt() per data event, and each frame is observed only AFTER its decision handler ran', async (t) => {
    const cam = { ...motionCamera, id: 'cam-order', name: 'Order Cam', mediamtx_path: 'path_order' };
    t.mock.timers.enable({ apis: ['Date'], now: T0 });
    logger.clear();
    const seen = stubObserver(() => logger.getRecent().some((l) => l.includes('[intobed]') && l.includes(cam.name)));
    t.after(() => _setObservationClockFactoryForTests(null));
    makeCamera(db, { id: cam.id, name: cam.name, path: cam.mediamtx_path });
    const before = detectorProcs.length;
    await startMotionDetector(cam);
    await waitFor(() => detectorProcs.length === before + 1, 'spawn');
    // TWO frames in ONE read: a quiet one (the baseline), then the bed lit. The second frame's handler logs
    // "[intobed] … bed active with no entry link" (the golden's first line), so that line exists when, and
    // only when, the handler has already run for it.
    detectorProcs[before].stdout.emit('data', Buffer.concat([paint({}), paint({ bed: true })]));
    await stopMotionDetector(cam.id);
    await settle();
    assert.equal(seen.receipts, 1, 'the receipt clock is read ONCE for the data event');
    assert.deepEqual(seen.samples, [false, true], 'frame 2 was observed after its handler logged');
  });

  test('F8 sound: one receipt() per data event, and each window is observed only AFTER its decision handler ran', async (t) => {
    const cam = { ...soundCamera, id: 'cam-order-s', name: 'Order Sound', mediamtx_path: 'path_order_s' };
    t.mock.timers.enable({ apis: ['Date'], now: T0 });
    logger.clear();
    const seen = stubObserver(() => logger.getRecent().some((l) => l.includes(`[sound] "${cam.name}" ambient=`)));
    t.after(() => _setObservationClockFactoryForTests(null));
    makeCamera(db, { id: cam.id, name: cam.name, path: cam.mediamtx_path });
    const before = detectorProcs.length;
    await startSoundDetector(cam);
    await waitFor(() => detectorProcs.length === before + 1, 'spawn');
    // 20 s after launch, two windows in ONE read: the first window's handler writes the 15-second level line.
    t.mock.timers.setTime(T0 + 20_000);
    detectorProcs[before].stdout.emit('data', Buffer.concat(pcm([{ n: 2, amp: 1000 }])));
    await stopSoundDetector(cam.id);
    await settle();
    assert.equal(seen.receipts, 1);
    assert.deepEqual(seen.samples, [true, true], 'window 1 was observed after its handler wrote the level line');
  });
});

// --- #447: every sample is filed under its stdout event's RECEIPT minute ----------------------------------
// The golden's variants all read one mocked clock, so a detector that ignored `rx.wall` and read Date.now() per
// call would still pass them (plan round 2, E). Here a stub clock's receipt says 11:59:59.900 while the mocked
// Date says 12:00:00.100, the two sides of a minute boundary: every sample of the event must be filed under
// 11:59 — both channels of a frame (or the out-of-bed one would be dropped with no in-bed partner, the KNOWN GAP
// in activityTracker.test.js), and every window of a chunk.
describe('#447: activity is filed under the receipt minute of the stdout event that delivered it', { concurrency: false }, () => {
  const RECEIVED = T0 - 100; // 11:59:59.900
  const NOW = T0 + 100; // 12:00:00.100, what every Date.now() in the detector reads
  function plantedReceipt(t) {
    t.mock.timers.enable({ apis: ['Date'], now: NOW });
    logger.clear();
    // No numeric generation id: nothing is staged, so this is purely about WHEN, not about clones.
    _setObservationClockFactoryForTests(() => ({
      receipt: () => ({ mono: Date.now(), wall: RECEIVED }),
      beginGeneration: () => ({ onRecord() {}, onConfig() {}, onParseError() {}, onSample() {}, end() {} }),
    }));
    t.after(() => _setObservationClockFactoryForTests(null));
  }

  test('motion: a frame\'s in-bed and out-of-bed readings both land in the receipt minute, not the clock\'s', async (t) => {
    plantedReceipt(t);
    const cam = { ...motionCamera, id: 'cam-447-rx', name: '447 Receipt Cam', mediamtx_path: 'path_447_rx' };
    makeCamera(db, { id: cam.id, name: cam.name, path: cam.mediamtx_path });
    const before = detectorProcs.length;
    await startMotionDetector(cam);
    await waitFor(() => detectorProcs.length === before + 1, 'spawn');
    // The baseline, then a frame with the bed AND the outside lit, both in ONE read.
    detectorProcs[before].stdout.emit('data', Buffer.concat([paint({}), paint({ bed: true, out: true })]));
    await stopMotionDetector(cam.id);
    await settle();
    flushActivity(NOW + 3 * 60_000);
    assert.deepEqual(rowsFor('activity_samples', cam.id).map((r) => [r.bucket_start, r.motion_frames, r.motion_peak, r.motion_out_peak]),
      [['2026-09-25 11:59:00', 1, 1 / 3, 2 / 9]]);
  });

  test('sound: every window of one read lands in the receipt minute, not the clock\'s', async (t) => {
    plantedReceipt(t);
    const cam = { ...soundCamera, id: 'cam-447-rx-s', name: '447 Receipt Sound', mediamtx_path: 'path_447_rx_s' };
    makeCamera(db, { id: cam.id, name: cam.name, path: cam.mediamtx_path });
    const before = detectorProcs.length;
    await startSoundDetector(cam);
    await waitFor(() => detectorProcs.length === before + 1, 'spawn');
    // 30 windows in ONE read: the analyser seeds its ambient floor on the first 25 (soundBaseline.js SEED_WINDOWS)
    // and records the other 5.
    detectorProcs[before].stdout.emit('data', Buffer.concat(pcm([{ n: 30, amp: 1000 }])));
    await stopSoundDetector(cam.id);
    await settle();
    flushActivity(NOW + 3 * 60_000);
    assert.deepEqual(rowsFor('activity_samples', cam.id).map((r) => [r.bucket_start, r.sound_windows]),
      [['2026-09-25 11:59:00', 5]]);
  });
});
