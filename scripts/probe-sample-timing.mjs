#!/usr/bin/env node
// Issue #373 Stage 1, tool 1: how bursty/jittery/clone-prone is a detector's real sample delivery?
// Standalone Node, no dependencies (so it can be `docker cp`'d anywhere ffmpeg runs). It reproduces
// motionDetector.js's / soundDetector.js's exact ffmpeg args (see motionFfmpegArgs/soundFfmpegArgs
// below for exactly what differs and why) and records everything needed to answer plan questions
// Q1-Q7 (see `C:\Users\nacho\.claude\plans\lexical-hopping-fiddle.md`, "Stage 1: evidence").
//
// Record a run against a real MediaMTX path:
//   docker cp scripts/probe-sample-timing.mjs <container>:/tmp/probe-sample-timing.mjs
//   docker exec <container> node /tmp/probe-sample-timing.mjs \
//     --leg motion --path <mediamtx-path> --minutes 30 --out /tmp/motion-day.jsonl
//   docker cp <container>:/tmp/motion-day.jsonl ./scratchpad/motion-day.jsonl
//
// Then analyse the captured file (works anywhere Node runs, no container needed):
//   node scripts/probe-sample-timing.mjs --analyse ./scratchpad/motion-day.jsonl
//
// Optional flags: --host 127.0.0.1:8554 (default), --block-every S --block-ms MS (busy-wait the
// probe's OWN event loop for MS every S seconds, to manufacture a Node-side backlog on purpose —
// soak box only, see plan "Runs" §2), --relaunch (keep respawning ffmpeg every RESTART_DELAY_MS
// after it exits, like the real detectors do, until --minutes elapses).
//
// ⚠️ Fix round 2026-09-24 (real soak self-test, fakecam + stall-proxy, DROP/HOLD 3s): ffmpeg's
// periodic `-stats` line to stderr ends in `\r`, not `\n` — with only a `\n` splitter it glued onto
// the NEXT showinfo/ashowinfo record and silently ate it (172 holes in one 30-minute ashowinfo run).
// Fixed two ways: `-nostats` on both arg lists (see motionFfmpegArgs/soundFfmpegArgs), and the stderr
// line buffer now treats a bare `\r` as a line end too, as defense in depth. `analyse()`'s `reliable`
// field and q7's `holes` report are what catch it if it ever recurs.
//
// ⚠️ On a periodic test tone (a pure sine, as the fixture captures below use), every output audio
// window hashes identically, so `sameAsPrev` carries NO information for sound — see q3.sound's own
// `sameAsPrevCaveat` in the analysis output. Real camera audio (room noise, speech) won't alias this
// way; this only matters when testing against a synthetic tone.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';

// gray8, one byte per pixel — mirrors motionDetector.js's FW/FH/FRAME_BYTES (320x180 = 57,600).
export const FRAME_BYTES = 320 * 180;
// s16le mono, 1600 samples/window — mirrors soundDetector.js's WIN_SAMPLES/WIN_BYTES (3,200 bytes).
export const WIN_SAMPLES = 1600;
export const WIN_BYTES = WIN_SAMPLES * 2;
// Both real detectors relaunch ffmpeg 5s after it exits (RESTART_DELAY_MS in each file) — --relaunch
// mirrors that cadence so the probe's startup-burst measurements (Q6) reflect the real restart path.
export const RESTART_DELAY_MS = 5000;
const HEARTBEAT_MS = 100;
const HEARTBEAT_FLUSH_MS = 1000;
const RESOURCE_SAMPLE_MS = 60000;

// --- ffmpeg args -------------------------------------------------------------------------------

// Mirrors backend/src/lib/motionDetector.js's launch() ffmpeg args. KEEP IN SYNC: if that file's args
// change, this comment and the array below should change with it, or this probe silently stops
// measuring what actually ships.
//
// ⚠️ #373 Stage 2 (2026-09-26): the DETECTOR now runs its own lean taps — `-loglevel +level+info
// -nostats` and `-vf showinfo@in=checksum=0,fps=5,scale=320:180,format=gray,showinfo@out` (built by
// ffmpegSideChannel.js's buildMotionTaps / SIDE_CHANNEL_LOG_ARGS). This probe deliberately keeps its
// Stage 1 instrumentation, because it measures things the detector does not: a checksum on the input
// tap (Q5, identical real frames) and a tap straight after `fps` (Q3, clones by checksum). Both taps
// only change what ffmpeg PRINTS; stdout was byte-identical with and without them
// (backend/test/fixtures/obs/identity-v4.sh), so the samples it times are the detector's samples.
//
// The differences from the real detector, and why each is safe to add:
//  - `-loglevel level+info` (detector: `+level+info`): the absolute form, which also clears ffmpeg's
//    repeat collapse. Harmless here — the probe records every line and forwards none to a log.
//  - `-stats_period 1` / `-progress pipe:3`: the detector doesn't consume `-progress` at all. Giving
//    it its OWN fd (3), never fd 2, means it can never interleave mid-line with the showinfo records
//    on stderr — mixing the two would mean guessing which partial line belongs to which source.
//  - `showinfo` inserted twice in `-vf`: once BEFORE `fps` (stage 0 — the real, undecimated input
//    frames exactly as they arrive) and once right after `fps`, before `scale` (stage 1 — what `fps`
//    actually emitted, clones included). A frame `fps` clones to fill a gap is a byte-exact repeat of
//    the previous FULL-RESOLUTION output, so its checksum matches the previous stage-1 checksum —
//    that's the clone signal Q3/Q5 use. Putting showinfo AFTER `scale` instead would risk two
//    genuinely different frames aliasing to the same tiny 320x180 checksum and being miscounted.
//  - `-nostats`: `-stats_period` alone still makes ffmpeg print its OWN periodic human-readable
//    "frame=… fps=… size=… time=… speed=…" stats line to stderr, independently of `-progress` (which
//    goes to fd 3) and independently of `-loglevel`. That line ends in `\r`, not `\n` (it's meant to
//    overwrite itself in a terminal) — real soak-box data showed it gluing onto the NEXT showinfo
//    record and eating it (see the file header). `-nostats` suppresses it; `-progress` is unaffected.
export function motionFfmpegArgs(host, path) {
  return [
    '-nostdin',
    '-loglevel', 'level+info',
    '-nostats',
    '-stats_period', '1',
    '-progress', 'pipe:3',
    '-rtsp_transport', 'tcp',
    '-i', `rtsp://${host}/${path}`,
    '-an',
    '-vf', 'showinfo,fps=5,showinfo,scale=320:180,format=gray',
    '-f', 'rawvideo',
    '-',
  ];
}

// Mirrors backend/src/lib/soundDetector.js's launch() ffmpeg args. KEEP IN SYNC. Since #373 Stage 2 the
// detector runs the same `-af ashowinfo` tap as this probe (with `-loglevel +level+info -nostats`), so
// the only differences are the log-level spelling and the progress fd, as in motionFfmpegArgs:
//  - `ashowinfo` sits before the resample so it logs the camera's OWN input PTS/sample-count,
//    not whatever `-ar 8000` produced. soundDetector.js has no `async` on its resample, so an input
//    gap is CONCATENATED rather than silence-filled (see the module header there) — ashowinfo's
//    per-window PTS is what lets Q3 tell a genuinely continuous stream apart from one with a stall
//    stitched invisibly into it.
export function soundFfmpegArgs(host, path) {
  return [
    '-nostdin',
    '-loglevel', 'level+info',
    '-nostats', // see motionFfmpegArgs's comment on -nostats — same fix, same reason
    '-stats_period', '1',
    '-progress', 'pipe:3',
    '-rtsp_transport', 'tcp',
    '-i', `rtsp://${host}/${path}`,
    '-vn',
    '-af', 'ashowinfo',
    '-ac', '1',
    '-ar', '8000',
    '-f', 's16le',
    '-',
  ];
}

// --- stdout sample framing ----------------------------------------------------------------------

// Turns a raw byte stream into whole samples (motion frames or sound windows), exactly as the real
// detectors' stdout handlers do. `clocks` is injectable so tests can drive it with a controlled
// clock instead of a real delay — the CONTRACT under test (a sample split across two reads carries
// the completing read's time) doesn't care whether the clock is real or fake.
//
// rxMono/rxWall are captured ONCE at the top of each write() call (i.e. once per 'data' event), so a
// sample whose last byte arrives in THIS call carries THIS call's time even if earlier bytes of it
// arrived in a previous call — matching the real detectors' `proc.stdout.on('data', ...)` handlers,
// which timestamp with a single `Date.now()` per event, not per sample.
export function createSampleFramer(sampleBytes, onSample, clocks = {}) {
  const monoNow = clocks.monoNow || (() => performance.now());
  const wallNow = clocks.wallNow || (() => Date.now());
  let buf = Buffer.alloc(0);
  let n = 0;
  let prev = null;
  return function write(chunk) {
    const rxMono = monoNow();
    const rxWall = wallNow();
    buf = buf.length ? Buffer.concat([buf, chunk]) : Buffer.from(chunk);
    const completed = [];
    while (buf.length >= sampleBytes) {
      completed.push(buf.subarray(0, sampleBytes));
      buf = buf.subarray(sampleBytes);
    }
    const samplesInRead = completed.length; // same value on every sample completed by THIS read
    for (const sample of completed) {
      n += 1;
      const hash = createHash('sha1').update(sample).digest('hex').slice(0, 12);
      const sameAsPrev = prev !== null && sample.equals(prev);
      onSample({ n, rxMono, rxWall, samplesInRead, hash, sameAsPrev });
      prev = sample;
    }
    // A leftover partial sample stays in `buf` for the next write() to complete — never emitted here.
  };
}

// --- stderr line parsing -------------------------------------------------------------------------

// A small standalone re-implementation of "buffer partial lines yourself" (see
// backend/src/lib/processOutput.js for the idea) — deliberately NOT imported from backend/src. That
// module's credential-redaction and oversized-line cap are aimed at forwarding an untrusted
// camera-adjacent process's output into the app's own log; this probe only ever reads its own
// locally-spawned ffmpeg for a bounded dev run, so that extra machinery isn't needed here.
// ⚠️ Fix round 2026-09-24: ffmpeg's `-stats` line (see motionFfmpegArgs) ends in a BARE `\r`, not
// `\n` — it's meant to overwrite itself on a terminal. The original version of this buffer only split
// on `\n`, so that line glued onto the FRONT of the next real stderr line (whatever ffmpeg wrote
// right after it) and the combined garbage line failed to parse as anything recognisable — silently
// eating a showinfo/ashowinfo record. `-nostats` (above) now suppresses the line at the source, but
// this splits on `\r` too, as defense in depth against any other `\r`-terminated ffmpeg output.
//
// A `\r` that lands as the very LAST byte currently buffered is held back rather than treated as a
// line end immediately: it might be the first half of a `\r\n` pair split across two chunks, and
// deciding before the next byte arrives would either emit a spurious empty line (if it IS `\r\n`) or
// wrongly wait for a `\n` that will never come (if it's a bare `\r`-terminated stats line that just
// happened to end exactly at a chunk boundary). One more byte (or end()) always resolves it.
export function makeLineBuffer(onLine) {
  let pending = '';
  function flushComplete() {
    for (;;) {
      const idx = pending.search(/[\r\n]/);
      if (idx === -1) return;
      if (pending[idx] === '\r' && idx === pending.length - 1) return; // could be a split \r\n — wait
      const isCrlf = pending[idx] === '\r' && pending[idx + 1] === '\n';
      const line = pending.slice(0, idx);
      pending = pending.slice(idx + (isCrlf ? 2 : 1));
      onLine(line);
    }
  }
  return {
    write(chunk) {
      pending += chunk.toString('utf8');
      flushComplete();
    },
    end() {
      flushComplete(); // a held-back trailing \r is now safely at true end-of-stream
      if (pending) {
        onLine(pending);
        pending = '';
      }
    },
  };
}

// ffmpeg numbers a filter's showinfo instance by its POSITION IN THE WHOLE GRAPH, not by "which
// showinfo is this". With `-vf showinfo,fps=5,showinfo,scale=320:180,format=gray` the real captured
// tags are `Parsed_showinfo_0` (before fps) and `Parsed_showinfo_2` (after fps — `fps` itself
// consumes index 1), NOT 0 and 1. analyse() below discovers the two tags actually present rather
// than assuming which numbers they are — see stageTags there.
const SHOWINFO_TAG = /^\[Parsed_(a?showinfo)_(\d+) @ 0x[0-9a-f]+\]\s*(?:\[info\]\s*)?(.*)$/;

// Parses one stderr line into a typed record. Pure — no clock, no I/O — so tests can feed it real
// captured lines directly. The caller (runGeneration, below) attaches gen/mono/wall.
export function parseStderrLine(line) {
  const m = line.match(SHOWINFO_TAG);
  if (!m) return { type: 'stderr', line };
  const [, kind, stageStr, rest] = m;
  // showinfo/ashowinfo emit a SECOND real log line per frame with no `n:`/`pts:`/`checksum:` at all
  // — a one-time "config in/out time_base" banner, and a per-frame "color_range:… color_space:…
  // color_primaries:… color_trc:…" continuation (both confirmed in the captured fixtures in
  // backend/test/probe-sample-timing.test.js). Neither is a malformed attempt at a data record, so
  // treating "has the Parsed_(a)showinfo tag" as "looks like a record" would flag ONE of these per
  // real frame as a parse-error and make a perfectly healthy 30-minute run look unreliable. A genuine
  // data line always has `n:` followed by a digit and these never do, so that's the signal used here.
  //
  // Classified as its OWN type ('stderr-continuation'), separate from genuinely unexplained stderr
  // ('stderr') — fix round 2026-09-24, Q7: averaging expected per-frame noise together with real
  // unexplained noise would hide a change in the latter behind a constant in the former.
  if (!/\bn:\s*\d+/.test(rest)) return { type: 'stderr-continuation', line };
  const stage = Number(stageStr);
  const n = rest.match(/\bn:\s*(\d+)/);
  const pts = rest.match(/\bpts:\s*(-?\d+)/);
  const ptsTime = rest.match(/\bpts_time:\s*(-?[\d.]+)/);
  const checksum = rest.match(/\bchecksum:\s*([0-9A-Fa-f]+)/);
  if (kind === 'showinfo') {
    if (!n || !pts || !ptsTime || !checksum) return { type: 'parse-error', raw: line };
    return {
      type: 'showinfo', stage,
      n: Number(n[1]), pts: Number(pts[1]), ptsTime: Number(ptsTime[1]), checksum: checksum[1],
    };
  }
  const nbSamples = rest.match(/\bnb_samples:\s*(\d+)/);
  const rate = rest.match(/\brate:\s*(\d+)/);
  if (!n || !pts || !ptsTime || !nbSamples || !rate || !checksum) {
    return { type: 'parse-error', raw: line };
  }
  return {
    type: 'ashowinfo',
    n: Number(n[1]), pts: Number(pts[1]), ptsTime: Number(ptsTime[1]),
    nbSamples: Number(nbSamples[1]), rate: Number(rate[1]), checksum: checksum[1],
  };
}

// -progress emits a flat key=value block per report, ending with `progress=continue|end`. Pure —
// takes an already-split block of lines (the CLI buffers fd 3 into blocks; see runGeneration).
export function parseProgressBlock(lines) {
  const fields = {};
  let state = null;
  for (const raw of lines) {
    const eq = raw.indexOf('=');
    if (eq === -1) continue;
    const key = raw.slice(0, eq).trim();
    const rawVal = raw.slice(eq + 1).trim();
    if (key === 'progress') { state = rawVal; continue; }
    fields[key] = /^-?\d+(\.\d+)?$/.test(rawVal) ? Number(rawVal) : rawVal;
  }
  return { type: 'progress', state, ...fields };
}

// --- analyse() -----------------------------------------------------------------------------------

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function groupBy(arr, keyFn) {
  const m = new Map();
  for (const x of arr) {
    const k = keyFn(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}

function quantile(sortedAsc, p) {
  if (!sortedAsc.length) return null;
  const idx = Math.min(sortedAsc.length - 1, Math.floor(p * (sortedAsc.length - 1)));
  return sortedAsc[idx];
}

// A burst is >=3 samples whose consecutive rxMono gaps are all <=50ms — the shape a Node-side or
// network backlog produces when it releases several buffered samples back to back (plan Q1/Q4).
function detectBursts(sortedByMono) {
  const bursts = [];
  let i = 0;
  while (i < sortedByMono.length) {
    let j = i;
    while (j + 1 < sortedByMono.length && sortedByMono[j + 1].rxMono - sortedByMono[j].rxMono <= 50) j += 1;
    const size = j - i + 1;
    if (size >= 3) bursts.push({ startMono: sortedByMono[i].rxMono, endMono: sortedByMono[j].rxMono, size });
    i = j + 1;
  }
  return bursts;
}

function linearFit(points) {
  const n = points.length;
  if (n < 2) return null;
  const meanX = points.reduce((s, p) => s + p.x, 0) / n;
  const meanY = points.reduce((s, p) => s + p.y, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.x - meanX) * (p.y - meanY);
    den += (p.x - meanX) ** 2;
  }
  const slope = den === 0 ? 0 : num / den;
  const intercept = meanY - slope * meanX;
  return { slope, intercept, residuals: points.map((p) => p.y - (slope * p.x + intercept)) };
}

// A claim between two adjacent-BY-N records is UNTRUSTWORTHY if either (a) ffmpeg's own n sequence
// has a HOLE right here — a record was lost between them (fix round 2026-09-24: this is exactly what
// the `\r`-terminated -stats line was doing before -nostats/the line-buffer fix, above), or (b) a
// parse-error stderr line fell inside the interval — a record that arrived but couldn't be read. Both
// mean "we don't actually know what happened here", so callers skip the pair rather than compute a
// gap/clone/discontinuity claim as if nothing were missing. Shared by q2 (segment boundaries), q3
// (gaps, clones, discontinuities) and q5 (the ordinal clone comparison).
function pairTainted(prev, cur, parseErrorMonos) {
  const hole = cur.n !== prev.n + 1;
  const parseErrorBetween = parseErrorMonos.some((m) => m > prev.mono && m < cur.mono);
  return hole || parseErrorBetween;
}

// Reports n-sequence holes per group (one group per gen:stage for showinfo, per gen for ashowinfo).
// This is the AUTHORITATIVE hole report (q7 and the top-level `reliable` flag read it) — independent
// of pairTainted's per-claim skipping, so a bug in one can't hide a bug in the other.
function findHoles(byGroup) {
  const holes = [];
  for (const [key, list] of byGroup) {
    const sorted = [...list].sort((a, b) => a.n - b.n);
    for (let i = 1; i < sorted.length; i += 1) {
      if (sorted[i].n !== sorted[i - 1].n + 1) {
        holes.push({
          group: String(key), from: sorted[i - 1].n, to: sorted[i].n, missing: sorted[i].n - sorted[i - 1].n - 1,
        });
      }
    }
  }
  return { ok: holes.length === 0, count: holes.length, holes };
}

// A gap/discontinuity whose interval is tainted (see pairTainted) is reported as UNRELIABLE rather
// than computed around — this is what "a parse-error inside an interval marks it unreliable" (and,
// since the fix round, "a hole marks it unreliable") in the test file checks.
function intervalGaps(byGen, parseErrorMonos, thresholdSec) {
  const list = [];
  const unreliableAt = [];
  const gapMonos = [];
  // {gen, ptsTime} pairs, NOT just bare ptsTime — fix round 2026-09-25 (Codex review): ptsTime resets
  // to ~0 on every relaunch, so a bare ptsTime Set used for q2 segmentation would spuriously split
  // generation 2 at the SAME numeric position as a real gap in generation 1, even with no gap there at
  // all. Internal only (not part of the `[at, gapSeconds]` list's contract) — see computeQ2.
  const gapPositions = [];
  for (const [gen, recs] of byGen) {
    const sorted = [...recs].sort((a, b) => a.n - b.n);
    for (let i = 1; i < sorted.length; i += 1) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      if (pairTainted(prev, cur, parseErrorMonos)) { unreliableAt.push(cur.ptsTime); continue; }
      const delta = cur.ptsTime - prev.ptsTime;
      if (delta > thresholdSec) {
        list.push([cur.ptsTime, delta]);
        gapMonos.push(cur.mono);
        gapPositions.push({ gen, ptsTime: cur.ptsTime });
      }
    }
  }
  return { count: list.length, list, unreliableCount: unreliableAt.length, unreliableAt, gapMonos, gapPositions };
}

// Fix round 2026-09-24 (real soak self-test): this camera's audio PTS is wall-clock-stamped PER
// PACKET by the upstream transcoder, not derived from a stable sample clock, so consecutive-frame
// deltas jitter by roughly +/-20ms around the nominal 0.128s window even on a perfectly healthy
// stream. The old 1ms threshold flagged 1143 of 1215 frames in one real run — meaningless noise.
//
// ★ Fix (f), #373 Stage 2 (2026-09-26): a per-packet rule, at ANY threshold, is the wrong rule. The
// Stage 1 day run's only "discontinuity" was one packet +268 ms late followed by 8 compressed ones: the
// cumulative deviation was back to ~0 within ~0.3 s and no audio was lost (the transcoder re-stamped a
// late clump). A per-packet delta calls that a gap. The rule is now the observation clock's FLOOR-RISE
// rule: excess = PTS - (first PTS + the sample clock + gaps already found); a discontinuity is a rise
// of excess over the reference floor (its minimum over the previous SOUND_REF_WINDOW_SEC of media) by
// more than SOUND_GAP_SEC that is STILL there after SOUND_RECOVER_MS of receipt time. A rise over half
// that which recovers is counted `delayed`. Regression test: probe-sample-timing.test.js, built from
// that day clump (backend/test/fixtures/obs/sound-day-clump.json).
// ⚠️ KEEP IN SYNC with backend/src/lib/observationClock.js (SoundGeneration.process): same rule, same
// constants. Duplicated, not imported, because this probe must run standalone (see makeLineBuffer).
const SOUND_GAP_SEC = 0.5;
const SOUND_RECOVER_MS = 1000;
const SOUND_REF_WINDOW_SEC = 60;
const SOUND_DELAY_REPORT_SEC = SOUND_GAP_SEC / 2;

// One run of records with a trustworthy cumulative sample index (no hole, no parse error inside it).
function floorRiseSegment(seg, gen, out) {
  const start = [];
  let cum = 0;
  for (const r of seg) { start.push(cum); cum += r.nbSamples / r.rate; }
  let D = 0;
  const excess = (i) => (seg[i].ptsTime - seg[0].ptsTime) - start[i] - D;
  const accepted = []; // {pos, e} of processed records, for the reference floor
  let quietUntil = -Infinity;
  const refAt = (pos) => {
    let m = null;
    for (let j = accepted.length - 1; j >= 0 && accepted[j].pos >= pos - SOUND_REF_WINDOW_SEC; j -= 1) {
      if (m === null || accepted[j].e < m) m = accepted[j].e;
    }
    return m;
  };
  for (let i = 0; i < seg.length; i += 1) {
    const ref = refAt(start[i]);
    const rise = ref === null ? 0 : excess(i) - ref;
    if (ref !== null && rise > SOUND_DELAY_REPORT_SEC && seg[i].mono > quietUntil) {
      // Judge the rise over the following SOUND_RECOVER_MS of receipt time. A candidate whose window
      // runs past the end of the data cannot be judged and is reported as unreliable, not guessed.
      let floorAfter = Infinity;
      let complete = false;
      for (let j = i; j < seg.length; j += 1) {
        if (seg[j].mono > seg[i].mono + SOUND_RECOVER_MS) { complete = true; break; }
        floorAfter = Math.min(floorAfter, excess(j));
      }
      if (!complete) { out.unreliableAt.push(seg[i].ptsTime); accepted.push({ pos: start[i], e: excess(i) }); continue; }
      if (floorAfter - ref > SOUND_GAP_SEC) {
        const size = floorAfter - ref;
        out.list.push({ at: seg[i].ptsTime, sizeSeconds: size });
        out.gapMonos.push(seg[i].mono);
        out.gapPositions.push({ gen, ptsTime: seg[i].ptsTime });
        D += size;
      } else {
        out.delayed += 1;
        quietUntil = seg[i].mono + SOUND_RECOVER_MS;
      }
    }
    accepted.push({ pos: start[i], e: excess(i) });
    if (i > 0) {
      // The per-packet deviation distribution is kept: it is what makes the jitter band visible.
      out.deviationsMs.push(((seg[i].ptsTime - seg[i - 1].ptsTime) - seg[i - 1].nbSamples / seg[i - 1].rate) * 1000);
    }
  }
}

function soundDiscontinuities(byGen, parseErrorMonos) {
  const out = { list: [], unreliableAt: [], gapMonos: [], gapPositions: [], deviationsMs: [], delayed: 0 };
  for (const [gen, recs] of byGen) {
    const sorted = [...recs].sort((a, b) => a.n - b.n);
    // A hole or a parse error breaks the cumulative sample index (the lost record's sample count is
    // gone), so the stream is judged in segments between them; each break is reported as unreliable.
    let seg = [];
    for (let i = 0; i < sorted.length; i += 1) {
      if (i > 0 && pairTainted(sorted[i - 1], sorted[i], parseErrorMonos)) {
        out.unreliableAt.push(sorted[i].ptsTime);
        floorRiseSegment(seg, gen, out);
        seg = [];
      }
      seg.push(sorted[i]);
    }
    if (seg.length) floorRiseSegment(seg, gen, out);
  }
  const { list, unreliableAt, gapMonos, gapPositions, delayed } = out;
  const deviationsMs = out.deviationsMs.sort((a, b) => a - b);
  return {
    count: list.length,
    list,
    delayed,
    unreliableCount: unreliableAt.length,
    unreliableAt,
    gapMonos,
    gapPositions,
    // The distribution itself (not just a threshold count) — this is what makes the jitter band
    // visible instead of hidden behind a single pass/fail number, and what caught the old 1ms
    // threshold being wrong in the first place (p1/p50/p99 all sat well inside +/-20ms, nowhere near
    // the 1ms cut).
    deltaDeviationMs: {
      p1: quantile(deviationsMs, 0.01), p50: quantile(deviationsMs, 0.5), p99: quantile(deviationsMs, 0.99),
      n: deviationsMs.length,
    },
  };
}

function computeQ1(samples) {
  const byGen = groupBy(samples, (s) => s.gen);
  const deltas = [];
  const hist = {};
  for (const s of samples) hist[s.samplesInRead] = (hist[s.samplesInRead] || 0) + 1;
  for (const [, list] of byGen) {
    const sorted = [...list].sort((a, b) => a.rxMono - b.rxMono);
    for (let i = 1; i < sorted.length; i += 1) deltas.push(sorted[i].rxMono - sorted[i - 1].rxMono);
  }
  deltas.sort((a, b) => a - b);
  return {
    samplesInReadHist: hist,
    interArrivalMs: {
      p50: quantile(deltas, 0.5), p90: quantile(deltas, 0.9), p99: quantile(deltas, 0.99),
      max: deltas.length ? deltas[deltas.length - 1] : null, n: deltas.length,
    },
  };
}

// Fits and measures residuals PER SEGMENT between detected gaps, not across the whole run. Fix round
// 2026-09-24: a single whole-run fit treats a real multi-second stall (already reported in q3) as
// just another outlier to average through, so its entire magnitude leaks into "jitter" — a real 3s
// proxy-induced gap on the soak box showed up as 726ms of reported "jitter", which is nonsense:
// jitter should describe noise around a steady clock, not a stair-step discontinuity. Segments are
// split at the SAME gap positions q3 already reports (so a segment boundary always lines up with a
// claimed gap), grouped by generation first (ptsTime and n both restart at 0 on a relaunch, so a
// segment must never cross a generation boundary). Drift is reported from the single LONGEST segment
// — averaging slopes across segments of very different lengths/noise would itself be a made-up number
// with no clear meaning — and jitter pools the residuals of every segment with 2+ points.
//
// ⚠️ Fix round 2026-09-25 (Codex review): the gap-position match is keyed by `${gen}:${ptsTime}`, NOT
// bare ptsTime. ptsTime restarts near 0 every relaunch, so a bare-ptsTime Set used to spuriously split
// generation 2 at the exact numeric position of a gap that only happened in generation 1 — a run
// where gen 2's clock happens to reach the same ptsTime as gen 1's gap got an extra, fake segment
// boundary with no real gap behind it.
function segmentByGapPositions(sortedRecords, gapKeySet, gen) {
  const segments = [];
  let current = [];
  for (const r of sortedRecords) {
    const key = `${gen}:${r.ptsTime}`;
    if (gapKeySet.has(key) && current.length) { segments.push(current); current = []; }
    current.push(r);
  }
  if (current.length) segments.push(current);
  return segments;
}

function segmentedDriftAndJitter(records, gapPositions) {
  const gapKeySet = new Set(gapPositions.map((g) => `${g.gen}:${g.ptsTime}`));
  const byGen = groupBy(records, (r) => r.gen);
  const allResiduals = [];
  let longest = null;
  let totalN = 0;
  let segmentCount = 0;
  for (const [gen, list] of byGen) {
    const sorted = [...list].sort((a, b) => a.n - b.n);
    totalN += sorted.length;
    const segments = segmentByGapPositions(sorted, gapKeySet, gen).filter((s) => s.length >= 2);
    segmentCount += segments.length;
    for (const seg of segments) {
      const fit = linearFit(seg.map((r) => ({ x: r.ptsTime, y: r.mono })));
      // A loop, not push(...spread): a 6-hour run gives one segment of ~100k residuals, and spreading that
      // many arguments throws RangeError (it crashed the 2026-09-25 overnight analysis).
      if (fit) for (const r of fit.residuals) allResiduals.push(Math.abs(r));
      if (!longest || seg.length > longest.length) longest = seg;
    }
  }
  if (!longest) return { driftPpm: null, jitterP99Ms: null, n: totalN, segmentCount, note: 'no segment had 2+ points to fit' };
  // x = input-clock seconds (pts_time), y = receipt mono ms. A perfectly synced clock has
  // slope = 1000 ms of receipt time per second of input time; the excess over that, in ppm, is drift.
  const longestFit = linearFit(longest.map((r) => ({ x: r.ptsTime, y: r.mono })));
  allResiduals.sort((a, b) => a - b);
  return {
    driftPpm: longestFit ? ((longestFit.slope - 1000) / 1000) * 1e6 : null,
    driftFromSegmentPoints: longest.length,
    jitterP99Ms: quantile(allResiduals, 0.99),
    n: totalN,
    segmentCount,
  };
}

function computeQ2(leg, stage0, ashowinfoEvents, motionGapInfo, soundGapInfo) {
  const note = 'RELATIVE ONLY: receipt (mono) time vs THIS connection\'s own input clock (PTS). '
    + 'Absolute camera-capture-to-receipt lag is unmeasurable from inside the server (plan negative space). '
    + 'Fit and residuals are PER SEGMENT between detected gaps — see segmentCount.';
  if (leg === 'motion') {
    const gapPositions = motionGapInfo ? motionGapInfo.gapPositions : [];
    return { note, motion: segmentedDriftAndJitter(stage0, gapPositions), sound: null };
  }
  if (leg === 'sound') {
    const gapPositions = soundGapInfo ? soundGapInfo.gapPositions : [];
    return { note, motion: null, sound: segmentedDriftAndJitter(ashowinfoEvents, gapPositions) };
  }
  return { note, motion: null, sound: null };
}

// Half a 5fps output interval either side of the output slot's own pts_time — see the WHY comment in
// computeQ3's motion branch for the full reasoning.
const PROVENANCE_WINDOW_SEC = 0.1;

function computeQ3(leg, stage0, stage1, ashowinfoEvents, samples, parseErrorMonos, cfrDupsTotal, motionGapInfo, soundGapInfo) {
  const out = {};
  if (leg === 'motion') {
    const stage0ByGen = groupBy(stage0, (e) => e.gen);
    const stage1ByGen = groupBy(stage1, (e) => e.gen);
    // Clone attribution by PROVENANCE, not checksum equality (fix round 2026-09-25, Codex review): a
    // static/daylit scene can produce byte-identical scaled output from DISTINCT real input frames —
    // checksum equality alone then miscounts real frames as clones, likelier exactly on a quiet,
    // well-lit room, which is the case this tool most needs to get right. The headline rule mirrors
    // `fps`'s own behaviour: it assigns each output slot a REGULAR pts_time grid (5fps -> 0, 0.2,
    // 0.4, ...) and fills it with the nearest real input frame seen so far — a slot is REAL iff some
    // stage-0 (pre-fps) frame of the SAME GENERATION has pts_time within PROVENANCE_WINDOW_SEC of the
    // output pts_time, otherwise `fps` had nothing new to offer and repeated the held frame (a clone).
    // Checksum equality is kept as a SECONDARY signal (`byChecksum`), and the two are compared:
    // `disagreements` is exactly the static-scene case above (provenance says real, checksum says
    // clone) surfacing for the first time.
    //
    // stage-0 and stage-2 share ONE time origin within a generation — verified against the real
    // captured fixture (backend/test/probe-sample-timing.test.js): both stage-0's n=0 and stage-2's
    // n=0 records report pts_time:0 at generation start. Their raw `pts` integers are NOT comparable
    // (different timebases — real capture: stage-0's config is time_base 1/15, stage-2's is 1/5),
    // which is exactly why this compares `ptsTime` (already timebase-normalised to seconds), never
    // raw `pts`.
    //
    // A checksum PAIR separated by a HOLE (or a parse-error) is skipped, not compared — see
    // pairTainted; provenance classification needs no such pairing (it's an existence check per
    // record, not a comparison between two), so it isn't affected by a stage-1 hole the way the
    // checksum signal is.
    let stage1Total = 0;
    let cloneByProvenanceTotal = 0;
    let provenanceLongestRun = 0;
    let cloneByChecksumTotal = 0;
    let checksumLongestRun = 0;
    let cloneUnreliableCount = 0;
    const disagreements = [];
    for (const [gen, list] of stage1ByGen) {
      const sorted = [...list].sort((a, b) => a.n - b.n);
      stage1Total += sorted.length;
      const stage0ForGen = stage0ByGen.get(gen) || [];
      let provenanceRun = 0;
      let checksumRun = 0;
      for (let i = 0; i < sorted.length; i += 1) {
        const rec = sorted[i];
        const lo = rec.ptsTime - PROVENANCE_WINDOW_SEC;
        const hi = rec.ptsTime + PROVENANCE_WINDOW_SEC;
        const provenanceClone = !stage0ForGen.some((r) => r.ptsTime >= lo && r.ptsTime < hi);
        if (provenanceClone) {
          cloneByProvenanceTotal += 1;
          provenanceRun += 1;
          if (provenanceRun > provenanceLongestRun) provenanceLongestRun = provenanceRun;
        } else provenanceRun = 0;

        const tainted = i > 0 && pairTainted(sorted[i - 1], sorted[i], parseErrorMonos);
        let checksumClone = false;
        if (i > 0 && tainted) {
          cloneUnreliableCount += 1;
          checksumRun = 0;
        } else if (i > 0) {
          checksumClone = sorted[i].checksum === sorted[i - 1].checksum;
          if (checksumClone) {
            cloneByChecksumTotal += 1;
            checksumRun += 1;
            if (checksumRun > checksumLongestRun) checksumLongestRun = checksumRun;
          } else checksumRun = 0;
        }

        if (i > 0 && !tainted && provenanceClone !== checksumClone) {
          disagreements.push({ gen, n: rec.n, ptsTime: rec.ptsTime, provenanceClone, checksumClone });
        }
      }
    }
    let stage0Total = 0;
    let fpsSum = 0;
    let fpsN = 0;
    for (const [, list] of stage0ByGen) {
      const sorted = [...list].sort((a, b) => a.n - b.n);
      stage0Total += sorted.length;
      if (sorted.length >= 2) {
        const span = sorted[sorted.length - 1].ptsTime - sorted[0].ptsTime;
        if (span > 0) { fpsSum += (sorted.length - 1) / span; fpsN += 1; }
      }
    }
    out.motion = {
      fpsInternalClones: {
        // HEADLINE — provenance (see the comment above this block for why it, not checksum, is
        // authoritative).
        total: cloneByProvenanceTotal,
        per1000Stage1Frames: stage1Total ? (cloneByProvenanceTotal / stage1Total) * 1000 : null,
        longestRun: provenanceLongestRun,
        stage1FrameCount: stage1Total,
        byChecksum: {
          total: cloneByChecksumTotal,
          per1000Stage1Frames: stage1Total ? (cloneByChecksumTotal / stage1Total) * 1000 : null,
          longestRun: checksumLongestRun,
        },
        disagreements: { count: disagreements.length, examples: disagreements.slice(0, 5) },
        unreliablePairs: cloneUnreliableCount,
      },
      // -progress's dup_frames/drop_frames are CUMULATIVE PER GENERATION, resetting on relaunch, so
      // the run total is the SUM of each generation's own last value, not just the final generation's
      // (fix round 2026-09-25, Codex review — a relaunch mid-run used to silently drop every earlier
      // generation's dup/drop count).
      cfrDups: cfrDupsTotal,
      realInputFps: fpsN ? fpsSum / fpsN : null,
      stage0FrameCount: stage0Total,
      inputPtsGaps: motionGapInfo,
    };
  }
  if (leg === 'sound') {
    const inputSampleTotal = ashowinfoEvents.reduce((s, e) => s + e.nbSamples, 0);
    // outputSampleTotal counts only COMPLETED WIN_BYTES windows; any partial window still sitting in
    // the probe's own read buffer at run-end (< WIN_BYTES = 0.2s of audio) is not counted — a small,
    // stated gap rather than an estimate, per the brief's "reported as unreliable, not estimated
    // around" rule for anything this tool can't actually see.
    const outputSampleTotal = samples.length * WIN_SAMPLES;
    out.sound = {
      inputSampleTotal,
      outputSampleTotal,
      sampleTotalDelta: inputSampleTotal - outputSampleTotal,
      outputTotalNote: 'excludes any partial window (<0.2s) still buffered when the run ended',
      inputPtsDiscontinuities: soundGapInfo,
      // Fix round 2026-09-24: a periodic test tone (e.g. a pure sine, as the fixture captures below
      // use) repeats EXACTLY every WIN_SAMPLES window, so sameAsPrev is 1 for nearly every window on
      // such a signal and says nothing about real silence or repetition — real camera audio (room
      // noise, speech) won't alias this way, but a synthetic-tone run must not be read as "constant".
      sameAsPrevCaveat: 'on a periodic test tone, sameAsPrev carries no information for audio',
    };
  }
  return out;
}

// The gap's recorded mono is the receipt of the FRAME AFTER the gap — the moment the stall ended —
// which can itself be the very first sample of the burst it causes (a backlog draining out all at
// once), so the window has to extend from slightly BEFORE burst start (the two streams' timing isn't
// perfectly aligned even though causally related) through to the burst's own end, not stop at burst
// start. Fix round 2026-09-24: the old code paired a burst with ANY earlier gap with no limit at all
// (real measurement: one burst reported a gap 49.8s earlier, another 86.9s — neither had anything to
// do with the burst), and would have MISSED a gap whose mono fell inside the burst entirely (real
// measurement: gap mono 94505 vs burst start 94494).
const GAP_ATTRIBUTION_LOOKBACK_MS = 1000;

// A heartbeat tick counts as a Node-side stall only when it is at least this late, since normal timer
// jitter is a few ms. 50 ms is a quarter of one 200 ms sample, so anything smaller can't have queued
// even one sample behind the event loop.
const STALL_LOG_MS = 50;

// Lateness measured TICK TO TICK: how much longer than one interval passed since the previous tick.
// ⚠️ The first version measured against a schedule (`expected += interval`) that never resynced after
// a stall, so one 3 s block made every later tick read ~3 s late, and the next block stacked on top.
// Real soak run 2026-09-24: blocks of 3 s read as 3,481 ms and then 6,602 ms, and a run with NO block
// crept from 281 to 1,106 ms. Measured tick to tick, a stall is counted once, on the tick that ends it.
export function createLatenessMeter(intervalMs, startMono) {
  let prev = startMono;
  return {
    tick(now) {
      const late = Math.max(0, now - prev - intervalMs);
      prev = now;
      return late;
    },
  };
}

// The largest Node-side stall whose span [mono - lateMs, mono] overlaps [from, to], or 0 if none.
export function stallOverlapping(stalls, from, to) {
  let max = 0;
  for (const s of stalls) {
    if (s.mono - s.lateMs <= to && s.mono >= from && s.lateMs > max) max = s.lateMs;
  }
  return max;
}

function computeQ4(samples, heartbeats, motionGapInfo, soundGapInfo, leg, stalls = []) {
  let gapMonos = [];
  if (leg === 'motion' && motionGapInfo) gapMonos = motionGapInfo.gapMonos;
  else if (leg === 'sound' && soundGapInfo) gapMonos = soundGapInfo.gapMonos;

  const byGen = groupBy(samples, (s) => s.gen);
  const bursts = [];
  for (const [, list] of byGen) {
    const sorted = [...list].sort((a, b) => a.rxMono - b.rxMono);
    for (const b of detectBursts(sorted)) bursts.push(b); // no spread: the burst count grows with run length
  }
  return bursts.map((b) => {
    let nearestHb = null;
    let nearestHbDist = Infinity;
    for (const hb of heartbeats) {
      const d = Math.abs(hb.mono - b.startMono);
      if (d < nearestHbDist) { nearestHbDist = d; nearestHb = hb; }
    }
    const windowStart = b.startMono - GAP_ATTRIBUTION_LOOKBACK_MS;
    const windowEnd = b.endMono;
    const matching = gapMonos.filter((g) => g >= windowStart && g <= windowEnd);
    let gapDistanceMs = null;
    if (matching.length) {
      let closest = matching[0];
      for (const g of matching) if (Math.abs(b.startMono - g) < Math.abs(b.startMono - closest)) closest = g;
      gapDistanceMs = b.startMono - closest;
    }
    return {
      size: b.size,
      startMono: b.startMono,
      heartbeatMaxLatenessMs: nearestHb ? nearestHb.maxLateness : null,
      heartbeatCount: nearestHb ? nearestHb.count : null,
      // The Node-side stall that could explain this burst: a backlog queued behind a blocked event loop.
      // This is the plan's discriminator candidate (i). It uses the same window as the gap attribution
      // below, so the two can be compared burst by burst.
      nodeStallMs: stallOverlapping(stalls, windowStart, windowEnd),
      precededByGap: matching.length > 0,
      gapDistanceMs,
    };
  });
}

function computeQ5(samples, stage1, cfrDupsTotal, parseErrorMonos) {
  if (!stage1.length) return { note: 'no stage-1 (post-fps) showinfo records in this file', realIdenticalCount: null };
  const byGenSamples = groupBy(samples, (s) => s.gen);
  const byGenStage1 = groupBy(stage1, (s) => s.gen);
  let realIdenticalCount = 0;
  let comparedCount = 0;
  let unreliableCount = 0;
  for (const [gen, sList] of byGenSamples) {
    const sSorted = [...sList].sort((a, b) => a.n - b.n);
    const st1 = (byGenStage1.get(gen) || []).slice().sort((a, b) => a.n - b.n);
    // Mapping stdout sample k <-> stage-1 record k is ORDINAL (index-based), never PTS-based —
    // there's no per-frame PTS on the stdout side to match against. min(count) bounds it to where
    // both series actually have data.
    const count = Math.min(sSorted.length, st1.length);
    for (let k = 0; k < count; k += 1) {
      // A hole/parse-error means st1[k] isn't actually known to be adjacent to st1[k-1] in ffmpeg's
      // real output, so a clone/non-clone comparison across the pair can't be trusted — skip it.
      if (k > 0 && pairTainted(st1[k - 1], st1[k], parseErrorMonos)) { unreliableCount += 1; continue; }
      comparedCount += 1;
      const isClone = k > 0 && st1[k].checksum === st1[k - 1].checksum;
      if (sSorted[k].sameAsPrev && !isClone) realIdenticalCount += 1;
    }
  }
  // Fix round 2026-09-25 (Codex review): summed across EVERY generation's own last progress record,
  // not just the final generation's — see the WHY comment on cfrDups in computeQ3.
  const dup = cfrDupsTotal ? cfrDupsTotal.dup_frames : 0;
  const drop = cfrDupsTotal ? cfrDupsTotal.drop_frames : 0;
  const mappingApproximate = dup > 0 || drop > 0;
  return {
    realIdenticalCount,
    comparedCount,
    unreliableCount,
    mappingApproximate,
    // WHY approximate: -progress only gives CUMULATIVE dup_frames/drop_frames, never which index
    // they landed on, so once either is non-zero the ordinal k<->k correspondence used above can have
    // silently drifted somewhere in the run and there's no way to say exactly where from this data.
    note: mappingApproximate
      ? `dup_frames=${dup} drop_frames=${drop} at the CFR (rawvideo) stage — the ordinal mapping can drift once either is non-zero; see the comment above this field`
      : 'dup_frames and drop_frames were both 0 for this run — the ordinal mapping is exact',
  };
}

function computeQ6(spawns, samples) {
  const byGen = groupBy(samples, (s) => s.gen);
  const out = {};
  for (const sp of spawns) {
    const list = (byGen.get(sp.gen) || []).slice().sort((a, b) => a.rxMono - b.rxMono);
    const first = list[0];
    const bursts = detectBursts(list);
    // A "startup burst" must begin AT the generation's very first sample — fix round 2026-09-25
    // (Codex review): `detectBursts(list)[0]` is the first burst ANYWHERE in the run, which could
    // start 5s in with perfectly normal spacing before it; that's an ordinary mid-run burst, not
    // evidence about startup delivery, and reporting it as `firstBurstSize` conflated the two.
    const startupBurst = bursts.length > 0 && !!first && bursts[0].startMono === first.rxMono;
    out[sp.gen] = {
      spawnToFirstSampleMs: first ? first.rxMono - sp.mono : null,
      firstBurstSize: startupBurst ? bursts[0].size : null,
      startupBurst,
    };
  }
  return out;
}

function computeQ7(events, showinfoEvents, ashowinfoEvents, parseErrors, stderrOther, stderrContinuation, holes) {
  // One pass, not Math.max(...monos): spreading hundreds of thousands of arguments throws RangeError
  // (found by the Codex review 2026-09-25 with a 150,000-event fixture; a 6-hour run has several times that).
  let lo = Infinity;
  let hi = -Infinity;
  let n = 0;
  for (const e of events) {
    if (!Number.isFinite(e.mono)) continue;
    if (e.mono < lo) lo = e.mono;
    if (e.mono > hi) hi = e.mono;
    n += 1;
  }
  const spanSec = n >= 2 ? (hi - lo) / 1000 : null;
  const recordCount = showinfoEvents.length + ashowinfoEvents.length;
  return {
    parseErrorCount: parseErrors.length,
    otherStderrCount: stderrOther.length,
    otherStderrSample: stderrOther.slice(0, 5).map((e) => e.line),
    // showinfo/ashowinfo's own "second log line per frame" (color_range…, config banners) is real,
    // EXPECTED noise at this log level — kept separate from genuinely unexplained stderr (fix round
    // 2026-09-24) so averaging the two together can't hide a change in the latter behind a constant
    // in the former.
    continuationLineCount: stderrContinuation.length,
    recordsPerSecond: spanSec ? recordCount / spanSec : null,
    holes,
  };
}

// The single entry point the CLI's --analyse calls. Pure: takes the parsed JSONL events, returns one
// summary object with one key per plan question (q1-q7). See the plan's "Questions" section for what
// each answers.
export function analyse(events) {
  const samples = events.filter((e) => e.type === 'sample');
  const showinfoEvents = events.filter((e) => e.type === 'showinfo');
  const ashowinfoEvents = events.filter((e) => e.type === 'ashowinfo');
  const progressEvents = events.filter((e) => e.type === 'progress');
  const heartbeats = events.filter((e) => e.type === 'heartbeat');
  const parseErrors = events.filter((e) => e.type === 'parse-error');
  const stderrOther = events.filter((e) => e.type === 'stderr');
  const stderrContinuation = events.filter((e) => e.type === 'stderr-continuation');
  const spawns = events.filter((e) => e.type === 'spawn');

  const leg = showinfoEvents.length ? 'motion' : (ashowinfoEvents.length ? 'sound' : null);

  const stageTags = [...new Set(showinfoEvents.map((e) => e.stage))].sort((a, b) => a - b);
  const stage0Tag = stageTags[0];
  const stage1Tag = stageTags.length > 1 ? stageTags[1] : null;
  const stage0 = stageTags.length ? showinfoEvents.filter((e) => e.stage === stage0Tag) : [];
  const stage1 = stage1Tag === null ? [] : showinfoEvents.filter((e) => e.stage === stage1Tag);

  const parseErrorMonos = parseErrors.map((e) => e.mono);
  // Fix round 2026-09-25 (Codex review): dup_frames/drop_frames are cumulative PER GENERATION — they
  // reset to 0 when ffmpeg relaunches — so the run's true total is the SUM of each generation's own
  // last progress record, not just the final generation's (a relaunch mid-run used to silently drop
  // every earlier generation's count). null (not {dup_frames:0,...}) when there was no progress data
  // at all, to keep "measured zero" distinguishable from "never measured".
  const progressByGen = groupBy(progressEvents, (e) => e.gen);
  const cfrDupsTotal = progressEvents.length
    ? [...progressByGen.values()].reduce((acc, list) => {
      const last = [...list].sort((a, b) => a.mono - b.mono).at(-1);
      acc.dup_frames += numOrNull(last.dup_frames) ?? 0;
      acc.drop_frames += numOrNull(last.drop_frames) ?? 0;
      return acc;
    }, { dup_frames: 0, drop_frames: 0 })
    : null;

  const motionGapInfo = leg === 'motion' ? intervalGaps(groupBy(stage0, (e) => e.gen), parseErrorMonos, 0.4) : null;
  const soundGapInfo = leg === 'sound' ? soundDiscontinuities(groupBy(ashowinfoEvents, (e) => e.gen), parseErrorMonos) : null;

  const holes = {
    video: findHoles(groupBy(showinfoEvents, (e) => `${e.gen}:${e.stage}`)),
    audio: findHoles(groupBy(ashowinfoEvents, (e) => e.gen)),
  };
  // A run is only as trustworthy as its worst gap: any lost record (a hole) OR any line this probe
  // couldn't parse at all means SOME interval's numbers were computed with missing information — even
  // though the affected interval itself is separately marked unreliable rather than silently wrong.
  // `reliable` is the one field meant to be checked FIRST, before trusting anything else here.
  const reliable = holes.video.count === 0 && holes.audio.count === 0 && parseErrors.length === 0;

  return {
    reliable,
    leg,
    counts: {
      samples: samples.length, showinfo: showinfoEvents.length, ashowinfo: ashowinfoEvents.length,
      progress: progressEvents.length, heartbeats: heartbeats.length, parseErrors: parseErrors.length,
      stderrOther: stderrOther.length, stderrContinuation: stderrContinuation.length, spawns: spawns.length,
    },
    q1: computeQ1(samples),
    q2: computeQ2(leg, stage0, ashowinfoEvents, motionGapInfo, soundGapInfo),
    q3: computeQ3(leg, stage0, stage1, ashowinfoEvents, samples, parseErrorMonos, cfrDupsTotal, motionGapInfo, soundGapInfo),
    q4: computeQ4(samples, heartbeats, motionGapInfo, soundGapInfo, leg, events.filter((e) => e.type === 'stall')),
    q5: leg === 'motion' ? computeQ5(samples, stage1, cfrDupsTotal, parseErrorMonos) : null,
    q6: computeQ6(spawns, samples),
    q7: computeQ7(events, showinfoEvents, ashowinfoEvents, parseErrors, stderrOther, stderrContinuation, holes),
  };
}

// --- CLI -------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { host: '127.0.0.1:8554' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    switch (a) {
      case '--leg': out.leg = argv[i += 1]; break;
      case '--path': out.path = argv[i += 1]; break;
      case '--minutes': out.minutes = Number(argv[i += 1]); break;
      case '--out': out.out = argv[i += 1]; break;
      case '--host': out.host = argv[i += 1]; break;
      case '--block-every': out.blockEvery = Number(argv[i += 1]); break;
      case '--block-ms': out.blockMs = Number(argv[i += 1]); break;
      case '--relaunch': out.relaunch = true; break;
      case '--analyse': out.analyse = argv[i += 1]; break;
      default: throw new Error(`probe-sample-timing: unknown argument ${a}`);
    }
  }
  return out;
}

function firstLine(cmd, cmdArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, cmdArgs, { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (c) => { out += c.toString('utf8'); });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0 && !out) { reject(new Error(`${cmd} exited ${code}`)); return; }
      resolve(out.split('\n')[0] || null);
    });
  });
}

async function captureVersions() {
  const ffmpeg = await firstLine('ffmpeg', ['-version']);
  const mediamtx = await firstLine('mediamtx', ['--version']).catch(() => null); // optional; ignore failure
  return { ffmpeg, mediamtx };
}

async function runProbe(args) {
  if (args.leg !== 'motion' && args.leg !== 'sound') throw new Error('probe-sample-timing: --leg must be "motion" or "sound"');
  if (!args.path) throw new Error('probe-sample-timing: --path is required');
  if (!args.minutes || args.minutes <= 0) throw new Error('probe-sample-timing: --minutes must be > 0');
  if (!args.out) throw new Error('probe-sample-timing: --out is required');

  const fd = fs.openSync(args.out, 'w');
  const emit = (event) => { fs.writeSync(fd, `${JSON.stringify(event)}\n`); };

  const versions = await captureVersions();
  emit({ type: 'versions', gen: 0, mono: performance.now(), wall: Date.now(), ...versions });

  let gen = 0;
  let currentChild = null;
  const sampleBytes = args.leg === 'motion' ? FRAME_BYTES : WIN_BYTES;

  const heartbeatState = { max: 0, count: 0 };
  const meter = createLatenessMeter(HEARTBEAT_MS, performance.now());
  const hbTick = setInterval(() => {
    const now = performance.now();
    const late = meter.tick(now);
    if (late > heartbeatState.max) heartbeatState.max = late;
    heartbeatState.count += 1;
    // Each real stall is logged on its own with its exact span, [mono - lateMs, mono], so q4 can line a
    // burst up with the stall that caused it. The per-second aggregate below can't do that: it's
    // emitted up to a second after the stall.
    if (late >= STALL_LOG_MS) emit({ type: 'stall', gen, mono: now, wall: Date.now(), lateMs: late });
  }, HEARTBEAT_MS);
  const hbFlush = setInterval(() => {
    emit({
      type: 'heartbeat', gen, mono: performance.now(), wall: Date.now(),
      maxLateness: heartbeatState.max, count: heartbeatState.count,
    });
    heartbeatState.max = 0;
    heartbeatState.count = 0;
  }, HEARTBEAT_FLUSH_MS);
  const resourceTick = setInterval(() => {
    const cpu = process.cpuUsage();
    emit({
      type: 'resource', gen, mono: performance.now(), wall: Date.now(),
      loadavg: os.loadavg(), cpuUserUs: cpu.user, cpuSystemUs: cpu.system,
    });
  }, RESOURCE_SAMPLE_MS);

  let blockTick = null;
  if (args.blockEvery && args.blockMs) {
    blockTick = setInterval(() => {
      const until = performance.now() + args.blockMs;
      while (performance.now() < until) { /* deliberately busy-wait: manufactures a Node-side backlog, plan Q4 */ }
      emit({ type: 'block', gen, mono: performance.now(), wall: Date.now(), ms: args.blockMs });
    }, args.blockEvery * 1000);
  }

  const deadline = Date.now() + args.minutes * 60000;
  const stopTimer = setTimeout(() => {
    if (currentChild && !currentChild.killed) currentChild.kill('SIGTERM');
  }, Math.max(0, deadline - Date.now()));

  async function runGeneration() {
    gen += 1;
    const thisGen = gen;
    const ffArgs = args.leg === 'motion' ? motionFfmpegArgs(args.host, args.path) : soundFfmpegArgs(args.host, args.path);
    const child = spawn('ffmpeg', ffArgs, { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
    currentChild = child;
    emit({ type: 'spawn', gen: thisGen, mono: performance.now(), wall: Date.now() });

    const framer = createSampleFramer(sampleBytes, (sample) => {
      emit({ type: 'sample', gen: thisGen, mono: sample.rxMono, wall: sample.rxWall, ...sample });
    });
    child.stdout.on('data', framer);

    const stderrLines = makeLineBuffer((line) => {
      const parsed = parseStderrLine(line);
      emit({ ...parsed, gen: thisGen, mono: performance.now(), wall: Date.now() });
    });
    child.stderr.on('data', (chunk) => stderrLines.write(chunk));
    child.stderr.once('end', () => stderrLines.end());

    let progressLines = [];
    const fd3Lines = makeLineBuffer((line) => {
      if (!line.trim()) return;
      progressLines.push(line);
      if (line.startsWith('progress=')) {
        const block = parseProgressBlock(progressLines);
        progressLines = [];
        emit({ ...block, gen: thisGen, mono: performance.now(), wall: Date.now() });
      }
    });
    if (child.stdio[3]) {
      child.stdio[3].on('data', (chunk) => fd3Lines.write(chunk));
      child.stdio[3].once('end', () => fd3Lines.end());
    }

    await new Promise((resolve) => {
      child.once('exit', (code, signal) => {
        emit({ type: 'exit', gen: thisGen, code, signal, mono: performance.now(), wall: Date.now() });
      });
      child.once('close', () => {
        emit({ type: 'close', gen: thisGen, mono: performance.now(), wall: Date.now() });
        if (currentChild === child) currentChild = null;
        resolve();
      });
      child.once('error', (err) => {
        emit({
          type: 'stderr', gen: thisGen, mono: performance.now(), wall: Date.now(),
          line: `spawn error: ${err.code || err.message}`,
        });
        resolve();
      });
    });
  }

  const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
  do {
    await runGeneration();
    if (!args.relaunch) break;
    if (Date.now() >= deadline) break;
    await sleep(RESTART_DELAY_MS); // mirrors RESTART_DELAY_MS in both real detectors
  } while (Date.now() < deadline);

  clearTimeout(stopTimer);
  clearInterval(hbTick);
  clearInterval(hbFlush);
  clearInterval(resourceTick);
  if (blockTick) clearInterval(blockTick);
  fs.closeSync(fd);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('probe-sample-timing.mjs')) {
  const cliArgs = parseArgs(process.argv.slice(2));
  if (cliArgs.analyse) {
    const events = fs.readFileSync(cliArgs.analyse, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    process.stdout.write(`${JSON.stringify(analyse(events), null, 2)}\n`);
  } else {
    await runProbe(cliArgs);
  }
}
