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
import { test, mock, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { useTempDataDir, cleanupTempDataDirs, makeCamera } from './helpers/harness.js';
import { zlibAdler0 } from './helpers/obsRig.js';
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
const { flushActivity } = await import('../src/lib/activityTracker.js');
const { startMotionDetector, stopMotionDetector } = await import('../src/lib/motionDetector.js');
const { startSoundDetector, stopSoundDetector } = await import('../src/lib/soundDetector.js');
const {
  getObservationClock, sweepIdleClocks, _setObservationClockFactoryForTests, _resetObservationClocksForTests,
} = await import('../src/lib/observationClock.js');

after(async () => {
  await mediamtx.close();
  cleanupTempDataDirs();
});

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
const CLOCK_VARIANTS = {
  working: (captured) => (cameraId, leg) => {
    const c = getObservationClock(cameraId, leg, { clocks: dateClocks, label: 'golden', onObservation: (o) => captured.push(o) });
    return c;
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
  { n: 1, amp: 0 }, //      digital silence: rms 0 -> -Infinity, which handleReading ignores
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
//   - a bucket is labelled with the FLUSH time, not the time its samples were observed (#447);
//   - the first frame of every generation is a baseline with no diff (299 of 300 frames in minute 1,
//     69 of 70 in generation 2), and the frame delivered after 'exit' is still analysed (301);
//   - the alert cooldown resets on a relaunch (generation 2 alerts at 126 s, 53 s after the 73 s alert,
//     inside the 60 s cooldown), while the in/out-of-bed BELIEF survives it (the "flagged impossible"
//     line);
//   - the second loud sound run does not alert (inside the 120 s cooldown) but still moves the level
//     lines and the stored sound_* numbers.
// Log lines that are verbatim forwards of a stderr capture are NOT in these literals: they are checked
// against the capture itself, which is an oracle this code did not produce.
const GOLDEN_MOTION = {
  activity: [
    { camera_id: 'cam-golden-motion', bucket_start: '2026-09-25 12:01:00', motion_level: 0.05667038275733944, motion_peak: 0.3333333333333333, sound_level: null, sound_peak: null, motion_frames: 299, sound_windows: 0, motion_out_level: 0.014864362690449651, motion_out_peak: 0.2222222222222222, sound_p75: null, sound_p90: null, sound_sd: null },
    { camera_id: 'cam-golden-motion', bucket_start: '2026-09-25 12:02:00', motion_level: 0.033776301218161796, motion_peak: 0.3333333333333333, sound_level: null, sound_peak: null, motion_frames: 301, sound_windows: 0, motion_out_level: 0, motion_out_peak: 0, sound_p75: null, sound_p90: null, sound_sd: null },
    { camera_id: 'cam-golden-motion', bucket_start: '2026-09-25 12:03:00', motion_level: 0.09661835748792268, motion_peak: 0.3333333333333333, sound_level: null, sound_peak: null, motion_frames: 69, sound_windows: 0, motion_out_level: 0.02898550724637682, motion_out_peak: 0.2222222222222222, sound_p75: null, sound_p90: null, sound_sd: null },
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
const GOLDEN_SOUND = {
  activity: [
    { camera_id: 'cam-golden-sound', bucket_start: '2026-09-25 12:01:00', motion_level: null, motion_peak: null, sound_level: 1.26657393446471, sound_peak: 24.081866239790152, motion_frames: 0, sound_windows: 274, motion_out_level: null, motion_out_peak: null, sound_p75: 0, sound_p90: 0, sound_sd: 5.263784232701136 },
    { camera_id: 'cam-golden-sound', bucket_start: '2026-09-25 12:02:00', motion_level: null, motion_peak: null, sound_level: 1.1519717499111992, sound_peak: 23.9812664492313, motion_frames: 0, sound_windows: 300, motion_out_level: null, motion_out_peak: null, sound_p75: 0, sound_p90: 0, sound_sd: 5.022056490207111 },
  ],
  events: [
    { camera_id: 'cam-golden-sound', camera_name: 'Golden Sound Cam', type: 'sound', detail: '+12 dB over ambient', snapshot: 0, clip_status: null, clip_path: null, clip_duration_s: null, clip_bytes: null },
  ],
  log: [
    '[INFO] [sound] watching "Golden Sound Cam" — fires at +11 dB over ambient, sustained 4s',
    '[INFO] [sound] "Golden Sound Cam" ambient=-33.3dB peak=-9.2dB maxAvgOver=+0.0 (fires at +11)',
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
    flushActivity();

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
    flushActivity(); // bucket labelled at the flush time: 12:02:00

    // The real 5 s relaunch (RESTART_DELAY_MS), then generation 2.
    await waitFor(() => detectorProcs.length === before + 2, 'the relaunched motion ffmpeg');
    const gen2 = detectorProcs[before + 1];
    gen2.stderr.emit('data', Buffer.from(`${MOTION_CONFIG.join('\n')}\n`));
    deliverObserved(t, gen2, single(MOTION_GEN2, T0 + 121_000), FRAME_BYTES, (k) => motionRecords(k, MOTION_GEN2[k]), { bytes: 0, emitted: 0 });
    t.mock.timers.setTime(T0 + 180_000);
    flushActivity();

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

    assert.deepEqual(withoutCapture(observed, tag, 'loglevel-error.err'), GOLDEN_MOTION);
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
    flushActivity();

    deliverObserved(t, gen1, single(SOUND_MIN2, T0 + 60_000), WIN_BYTES, soundRecords, st);
    t.mock.timers.setTime(T0 + 120_000);
    flushActivity();

    // Real captured stderr with fftools' double-prefixed lines, split mid-line — as the new flag prints it.
    emitSplit(gen1.stderr, levelled('mjpeg-error.err', 'mjpeg-rel.err'), 700);

    await stopSoundDetector(soundCamera.id);
    assert.deepEqual(gen1.signals, ['SIGTERM'], 'the stop must terminate the sound ffmpeg');
    await settle();

    assert.deepEqual(logger.getRecent().filter((l) => /ashowinfo|\bn:\d+ pts:/.test(l)), []);
    if (variant === 'working') {
      // 600 windows, the one digitally silent window among them sampled but not analysed (C5).
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

    assert.deepEqual(withoutCapture(observed, tag, 'mjpeg-error.err'), GOLDEN_SOUND);
  });
  }
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
