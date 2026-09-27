// Does scripts/probe-sample-timing.mjs (issue #373 Stage 1) parse real ffmpeg output correctly, frame
// stdout samples correctly, and answer the plan's Q1-Q7 correctly on inputs with KNOWN answers?
//
// ⚠️ IT LIVES HERE BECAUSE THIS IS THE ONLY TEST HARNESS IN THE REPO, same reason
// triage-killed-runner.test.js does — the module under test is repo-root tooling (`scripts/`), not
// `backend/src`.
//
// The parser fixtures below are REAL lines captured from the soak container (not hand-written), via:
//   docker exec nightlight-soak-nightlight-1 sh -c 'ffmpeg -hide_banner -nostdin -loglevel level+info \
//     -f lavfi -i testsrc2=size=640x360:rate=15 -t 1 -vf showinfo,fps=5,showinfo,scale=320:180,format=gray \
//     -f rawvideo -y /dev/null 2>&1 | head -40'
//   docker exec nightlight-soak-nightlight-1 sh -c 'ffmpeg -hide_banner -nostdin -loglevel level+info \
//     -f lavfi -i sine=frequency=440:sample_rate=8000 -t 1 -af ashowinfo -ac 1 -ar 8000 -f s16le \
//     -y /dev/null 2>&1 | head -20'
//   docker exec nightlight-soak-nightlight-1 sh -c 'ffmpeg -hide_banner -nostdin -loglevel error \
//     -stats_period 1 -progress pipe:1 -f lavfi -i testsrc2=size=320x180:rate=5 -t 2 -f rawvideo \
//     -y /dev/null | head -30'
//   docker exec nightlight-soak-nightlight-1 ffmpeg -version
// ffmpeg version (first line): ffmpeg version 8.1.2 Copyright (c) 2000-2026 the FFmpeg developers
//
// ★ A REAL captured run is what caught the stage-numbering issue this file's first describe() block
// tests directly: with `-vf showinfo,fps=5,showinfo,scale=320:180,format=gray`, ffmpeg numbers a
// filter's showinfo instance by its POSITION IN THE WHOLE GRAPH, not "which showinfo is this" — the
// two tags that actually came back were `Parsed_showinfo_0` (before fps) and `Parsed_showinfo_2`
// (after fps; `fps` itself consumes index 1), never 0 and 1. A hand-written fixture would have had no
// reason to pick anything but 0 and 1 and this bug would have shipped invisibly.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const {
  analyse, parseStderrLine, parseProgressBlock, createSampleFramer, makeLineBuffer,
  motionFfmpegArgs, soundFfmpegArgs, FRAME_BYTES, WIN_BYTES, createLatenessMeter, stallOverlapping,
} = await import(new URL('../../scripts/probe-sample-timing.mjs', import.meta.url).href);

// --- real captured lines -------------------------------------------------------------------------

const REAL_STAGE0_LINE =
  '[Parsed_showinfo_0 @ 0x7b99c84d74c0] [info] n:   0 pts:      0 pts_time:0       duration:      1 '
  + 'duration_time:0.0666667 fmt:yuv420p cl:unspecified sar:1/1 s:640x360 i:P iskey:1 type:I '
  + 'checksum:B70BD5FD plane_checksum:[09F6CE5E 3ACAFD86 1EA10A0A] mean:[125 127 125] stdev:[56.3 79.1 82.9]';

// The SECOND showinfo instance in the graph really is tagged 2, not 1 — see the file header.
const REAL_STAGE1_LINE =
  '[Parsed_showinfo_2 @ 0x7b99c84d7940] [info] n:   1 pts:      1 pts_time:0.2     duration:      1 '
  + 'duration_time:0.2     fmt:yuv420p cl:unspecified sar:1/1 s:640x360 i:P iskey:1 type:I '
  + 'checksum:7522161C plane_checksum:[4AFBAFFD 08521EB9 18544757] mean:[125 128 125] stdev:[56.3 78.9 82.3]';

// showinfo's real SECOND log line per frame — no n:/pts:/checksum at all. Must NOT be a parse-error.
const REAL_COLOR_RANGE_LINE =
  '[Parsed_showinfo_0 @ 0x7b99c84d74c0] [info] color_range:unknown color_space:unknown '
  + 'color_primaries:unknown color_trc:unknown';

const REAL_ASHOWINFO_LINE =
  '[Parsed_ashowinfo_0 @ 0x769e25780900] [info] n:1 pts:1024 pts_time:0.128 fmt:s16 channels:1 '
  + 'chlayout:mono rate:8000 nb_samples:1024 checksum:6B4BE872 plane_checksums: [ 6B4BE872 ]';

const REAL_UNRELATED_LINE = '[info] Stream mapping:';

// The real -progress block (fd 3 in the probe; this capture used pipe:1 to see it directly).
const REAL_PROGRESS_LINES = [
  'frame=10',
  'fps=0.00',
  'stream_0_0_q=-0.0',
  'bitrate=3456.0kbits/s',
  'total_size=864000',
  'out_time_us=2000000',
  'out_time_ms=2000000',
  'out_time=00:00:02.000000',
  'dup_frames=0',
  'drop_frames=0',
  'speed= 237x',
  'progress=end',
];

// A real stage-0 line truncated before its checksum field — n: is present (so it "looks like" a
// record) but the record is incomplete. Must be a parse-error, never silently skipped or guessed at.
const TRUNCATED_LINE =
  '[Parsed_showinfo_0 @ 0x7b99c84d74c0] [info] n:   0 pts:      0 pts_time:0       duration:      1 '
  + 'duration_time:0.0666667 fmt:yuv420p cl:unspecified sar:1/1 s:640x360 i:P iskey:1 type:I';

describe('parseStderrLine on real captured lines', () => {
  test('a stage-0 (pre-fps) showinfo record', () => {
    const r = parseStderrLine(REAL_STAGE0_LINE);
    assert.deepEqual(r, { type: 'showinfo', stage: 0, n: 0, pts: 0, ptsTime: 0, checksum: 'B70BD5FD' });
  });

  test('a stage-1 (post-fps) showinfo record — tagged 2, not 1', () => {
    const r = parseStderrLine(REAL_STAGE1_LINE);
    assert.deepEqual(r, { type: 'showinfo', stage: 2, n: 1, pts: 1, ptsTime: 0.2, checksum: '7522161C' });
  });

  test('an ashowinfo record', () => {
    const r = parseStderrLine(REAL_ASHOWINFO_LINE);
    assert.deepEqual(r, {
      type: 'ashowinfo', n: 1, pts: 1024, ptsTime: 0.128, nbSamples: 1024, rate: 8000, checksum: '6B4BE872',
    });
  });

  test('a truncated showinfo line (has n:, missing checksum) is a parse-error, never skipped', () => {
    const r = parseStderrLine(TRUNCATED_LINE);
    assert.equal(r.type, 'parse-error');
    assert.equal(r.raw, TRUNCATED_LINE);
  });

  test('an unrelated stderr line is recorded as noise, not misread as a record', () => {
    const r = parseStderrLine(REAL_UNRELATED_LINE);
    assert.deepEqual(r, { type: 'stderr', line: REAL_UNRELATED_LINE });
  });

  test('the showinfo color_range continuation line is noise, NOT a parse-error', () => {
    // The load-bearing discrimination: this line carries the Parsed_showinfo_N tag (so a naive "has
    // the tag" check would call it a malformed record attempt) but has no n:/pts:/checksum at all,
    // because it's real showinfo output — a second, different log call for the same frame. Getting
    // this wrong would flag ONE parse-error per real frame and make a healthy run look unreliable.
    // Fix round 2026-09-24: classified as its OWN type ('stderr-continuation'), separate from
    // genuinely unexplained stderr, so Q7 can report the two counts separately (see the q7 describe
    // block below).
    const r = parseStderrLine(REAL_COLOR_RANGE_LINE);
    assert.deepEqual(r, { type: 'stderr-continuation', line: REAL_COLOR_RANGE_LINE });
  });
});

describe('fix round 2026-09-24: the \\r-terminated -stats line no longer eats the next record', () => {
  test('motionFfmpegArgs and soundFfmpegArgs both pass -nostats', () => {
    assert.ok(motionFfmpegArgs('h', 'p').includes('-nostats'), 'motion args missing -nostats');
    assert.ok(soundFfmpegArgs('h', 'p').includes('-nostats'), 'sound args missing -nostats');
  });

  test('a \\r-terminated stats line glued to the front of a record still yields the record', () => {
    // Real shape: ffmpeg's `-stats` line ends in `\r` (to overwrite itself on a terminal), with NO
    // `\n` — so before this fix, the stats line and the NEXT real stderr line arrived as one `\n`
    // bounded blob and neither parsed as anything recognisable. -nostats now suppresses the stats
    // line at the source; this is the defense-in-depth check on the line buffer itself.
    const statsLine = 'frame=  123 fps= 25 q=-1.0 size=    2048kB time=00:00:04.92 bitrate=3407.8kbits/s speed=1.23x    \r';
    const chunk = Buffer.from(statsLine + REAL_ASHOWINFO_LINE + '\n', 'utf8');
    const lines = [];
    const buf = makeLineBuffer((line) => lines.push(line));
    buf.write(chunk);
    assert.equal(lines.length, 2, `expected 2 lines, got ${lines.length}: ${JSON.stringify(lines)}`);
    assert.equal(lines[0], statsLine.slice(0, -1));
    const record = parseStderrLine(lines[1]);
    assert.equal(record.type, 'ashowinfo');
    assert.equal(record.n, 1, 'the ashowinfo record must still be recognised, not glued to the stats line');
  });

  test('a \\r\\n pair split exactly across two chunks is still ONE line, not two', () => {
    // The trailing-\r lookahead: a lone \r at the end of the currently buffered text must not be
    // treated as a line end until the next byte (or end()) reveals whether it's really \r\n.
    const lines = [];
    const buf = makeLineBuffer((line) => lines.push(line));
    buf.write(Buffer.from('hello\r', 'utf8'));
    assert.equal(lines.length, 0, 'must not emit yet — the \\r could be the start of \\r\\n');
    buf.write(Buffer.from('\nworld\n', 'utf8'));
    assert.deepEqual(lines, ['hello', 'world'], 'a split \\r\\n must not produce a spurious empty line');
  });
});

describe('parseProgressBlock on a real -progress block', () => {
  test('parses every field and the terminal state', () => {
    const r = parseProgressBlock(REAL_PROGRESS_LINES);
    assert.equal(r.type, 'progress');
    assert.equal(r.state, 'end');
    assert.equal(r.frame, 10);
    assert.equal(r.dup_frames, 0);
    assert.equal(r.drop_frames, 0);
    assert.equal(r.out_time_us, 2000000);
    assert.equal(r.speed, '237x'); // has a unit suffix, so it stays a string, not a Number
    assert.equal(r.bitrate, '3456.0kbits/s');
  });
});

describe('createSampleFramer', () => {
  test('a sample split across two reads carries the SECOND read\'s rxMono/rxWall', () => {
    const monoValues = [111, 222]; // first write's clock, second write's clock
    const wallValues = [1000, 2000];
    let monoCall = 0;
    let wallCall = 0;
    const clocks = {
      monoNow: () => monoValues[monoCall++],
      wallNow: () => wallValues[wallCall++],
    };
    const samples = [];
    const write = createSampleFramer(10, (s) => samples.push(s), clocks);
    write(Buffer.alloc(6, 1)); // partial — 6 of 10 bytes, nothing completed yet
    assert.equal(samples.length, 0, 'a partial sample must not be emitted');
    write(Buffer.alloc(4, 1)); // completes the sample on THIS (second) read
    assert.equal(samples.length, 1);
    assert.equal(samples[0].rxMono, 222, 'the completing read\'s mono time, not the first read\'s');
    assert.equal(samples[0].rxWall, 2000);
  });

  test('many samples completed by one read all get the same samplesInRead', () => {
    const samples = [];
    const write = createSampleFramer(10, (s) => samples.push(s));
    write(Buffer.alloc(35, 2)); // 3 whole samples + 5 leftover bytes, in ONE read
    assert.equal(samples.length, 3);
    for (const s of samples) assert.equal(s.samplesInRead, 3);
  });

  test('a leftover partial sample is not emitted, and completes on the next read', () => {
    const samples = [];
    const write = createSampleFramer(10, (s) => samples.push(s));
    write(Buffer.alloc(15, 3)); // 1 whole + 5 leftover
    assert.equal(samples.length, 1);
    write(Buffer.alloc(5, 3)); // completes the leftover
    assert.equal(samples.length, 2);
  });

  test('identical consecutive sample bytes are flagged sameAsPrev; the hash is stable', () => {
    const samples = [];
    const write = createSampleFramer(4, (s) => samples.push(s));
    write(Buffer.from([1, 2, 3, 4]));
    write(Buffer.from([1, 2, 3, 4])); // byte-identical to the previous sample
    write(Buffer.from([9, 9, 9, 9]));
    assert.equal(samples[0].sameAsPrev, false);
    assert.equal(samples[1].sameAsPrev, true);
    assert.equal(samples[1].hash, samples[0].hash);
    assert.equal(samples[2].sameAsPrev, false);
  });

  test('sample byte sizes match the real detectors (320x180 gray8, 1600-sample s16le windows)', () => {
    assert.equal(FRAME_BYTES, 57600);
    assert.equal(WIN_BYTES, 3200);
  });
});

describe('analyse() on synthetic event lists with known answers', () => {
  test('a repeated stage-1 checksum counts as an fps-internal clone', () => {
    const events = [
      { type: 'showinfo', gen: 1, stage: 0, n: 0, pts: 0, ptsTime: 0, checksum: 'S0A', mono: 1000, wall: 0 },
      { type: 'showinfo', gen: 1, stage: 0, n: 1, pts: 1, ptsTime: 0.2, checksum: 'S0B', mono: 1200, wall: 0 },
      { type: 'showinfo', gen: 1, stage: 1, n: 0, pts: 0, ptsTime: 0, checksum: 'X', mono: 1050, wall: 0 },
      { type: 'showinfo', gen: 1, stage: 1, n: 1, pts: 1, ptsTime: 0.2, checksum: 'X', mono: 1250, wall: 0 },
      { type: 'showinfo', gen: 1, stage: 1, n: 2, pts: 2, ptsTime: 0.4, checksum: 'Y', mono: 1450, wall: 0 },
    ];
    const s = analyse(events);
    assert.equal(s.q3.motion.fpsInternalClones.total, 1);
    assert.equal(s.q3.motion.fpsInternalClones.longestRun, 1);
    assert.equal(s.q3.motion.fpsInternalClones.stage1FrameCount, 3);
  });

  test('a stage-0 PTS gap of 3s is reported as [at, gapSeconds]', () => {
    const events = [
      { type: 'showinfo', gen: 1, stage: 0, n: 0, pts: 0, ptsTime: 0, checksum: 'A', mono: 1000, wall: 0 },
      { type: 'showinfo', gen: 1, stage: 0, n: 1, pts: 1, ptsTime: 3, checksum: 'B', mono: 4000, wall: 0 },
    ];
    const s = analyse(events);
    assert.equal(s.q3.motion.inputPtsGaps.count, 1);
    assert.deepEqual(s.q3.motion.inputPtsGaps.list, [[3, 3]]);
  });

  test('a sound input PTS discontinuity (a SUSTAINED floor rise over 0.5 s) is found, with its size', () => {
    // Planted: 1024-sample packets at 8 kHz (0.128 s), received on schedule; before packet 10 the stream
    // loses 0.6 s, and every later packet is 0.6 s later than the sample clock says, for well over the
    // 1 s recover window. Changed by #373 fix (f): the old per-packet rule is gone (see the next block).
    const events = [];
    for (let n = 0; n < 30; n += 1) {
      const t = n * 0.128 + (n >= 10 ? 0.6 : 0);
      events.push({ type: 'ashowinfo', gen: 1, n, pts: Math.round(t * 8000), ptsTime: t, nbSamples: 1024, rate: 8000, checksum: `C${n}`, mono: 1000 + t * 1000, wall: 0 });
    }
    const s = analyse(events);
    assert.equal(s.q3.sound.inputPtsDiscontinuities.count, 1);
    const d = s.q3.sound.inputPtsDiscontinuities.list[0];
    assert.ok(Math.abs(d.at - (10 * 0.128 + 0.6)) < 1e-9);
    assert.ok(Math.abs(d.sizeSeconds - 0.6) < 1e-6);
  });

  test('fix (f): a lone late packet that the stream makes up for is NOT a discontinuity (the old rule said it was)', () => {
    // Planted: the old test's shape — one packet 0.372 s late — but the stream then carries on at its own
    // clock, so the "gap" is gone two packets later. A per-packet rule reported this as a 0.5 s gap.
    const events = [];
    for (let n = 0; n < 30; n += 1) {
      const t = n * 0.128 + (n === 1 ? 0.372 : 0);
      events.push({ type: 'ashowinfo', gen: 1, n, pts: Math.round(t * 8000), ptsTime: t, nbSamples: 1024, rate: 8000, checksum: `C${n}`, mono: 1000 + t * 1000, wall: 0 });
    }
    const disc = analyse(events).q3.sound.inputPtsDiscontinuities;
    assert.equal(disc.count, 0);
    assert.equal(disc.delayed, 1);
  });

  test('a burst of 5 samples within 50ms is reported with the heartbeat lateness around it', () => {
    const events = [
      { type: 'sample', gen: 1, mono: 2000, wall: 0, n: 0, rxMono: 2000, rxWall: 0, samplesInRead: 5, hash: 'h0', sameAsPrev: false },
      { type: 'sample', gen: 1, mono: 2010, wall: 0, n: 1, rxMono: 2010, rxWall: 0, samplesInRead: 5, hash: 'h1', sameAsPrev: false },
      { type: 'sample', gen: 1, mono: 2020, wall: 0, n: 2, rxMono: 2020, rxWall: 0, samplesInRead: 5, hash: 'h2', sameAsPrev: false },
      { type: 'sample', gen: 1, mono: 2030, wall: 0, n: 3, rxMono: 2030, rxWall: 0, samplesInRead: 5, hash: 'h3', sameAsPrev: false },
      { type: 'sample', gen: 1, mono: 2040, wall: 0, n: 4, rxMono: 2040, rxWall: 0, samplesInRead: 5, hash: 'h4', sameAsPrev: false },
      { type: 'heartbeat', gen: 1, mono: 2500, wall: 0, maxLateness: 1000, count: 10 },
    ];
    const s = analyse(events);
    assert.equal(s.q4.length, 1);
    assert.equal(s.q4[0].size, 5);
    assert.equal(s.q4[0].heartbeatMaxLatenessMs, 1000);
  });

  test('drift is recovered from a sequence with a known slope (100ppm chosen)', () => {
    // mono = 500 + 1000 * ptsTime * 1.0001 -> an EXACT line, slope 1000.1 ms/s -> 100ppm drift, ~0
    // jitter. Spacing is 0.2s (< the 0.4s gap threshold) so q2's per-segment split (fix round
    // 2026-09-24) doesn't treat every point as its own gap-bounded segment of length 1.
    const events = [0, 0.2, 0.4, 0.6, 0.8].map((t, i) => ({
      type: 'showinfo', gen: 1, stage: 0, n: i, pts: i, ptsTime: t,
      checksum: `C${i}`, mono: 500 + 1000 * t * 1.0001, wall: 0,
    }));
    const s = analyse(events);
    assert.match(s.q2.note, /RELATIVE ONLY/);
    assert.equal(s.q2.motion.segmentCount, 1, 'no gap in this fixture, so it must be ONE segment');
    assert.ok(Math.abs(s.q2.motion.driftPpm - 100) < 0.5, `expected ~100ppm, got ${s.q2.motion.driftPpm}`);
    assert.ok(s.q2.motion.jitterP99Ms < 0.01, `expected ~0 jitter on an exact line, got ${s.q2.motion.jitterP99Ms}`);
  });

  test('fix round 2026-09-24: a real gap no longer inflates jitter (per-segment fit)', () => {
    // Two clean segments (tiny, real +/-0.05ms noise within each) joined by a genuine 3s gap. Under
    // the OLD whole-run fit, the gap's huge step was averaged into the residuals as "jitter"
    // (measured on the soak box: a 3s gap read as 726ms of jitter). The fix must keep jitter down at
    // the true in-segment noise level and report the gap as its own segment boundary.
    const seg1 = [0, 0.2, 0.4, 0.6].map((t, i) => ({
      type: 'showinfo', gen: 1, stage: 0, n: i, pts: i, ptsTime: t,
      checksum: `A${i}`, mono: 1000 + t * 1000 + (i % 2 === 0 ? 0.05 : -0.05), wall: 0,
    }));
    const gapStartN = seg1.length;
    const seg2 = [3.6, 3.8, 4.0, 4.2].map((t, i) => ({
      type: 'showinfo', gen: 1, stage: 0, n: gapStartN + i, pts: gapStartN + i, ptsTime: t,
      checksum: `B${i}`, mono: 1000 + t * 1000 + (i % 2 === 0 ? 0.05 : -0.05), wall: 0,
    }));
    const events = [...seg1, ...seg2];
    const s = analyse(events);
    assert.equal(s.q3.motion.inputPtsGaps.count, 1, 'the 3s jump must be reported as a q3 gap');
    assert.equal(s.q2.motion.segmentCount, 2, 'the run must be split into 2 segments at that gap');
    assert.ok(s.q2.motion.jitterP99Ms < 1, `jitter must stay near the true in-segment noise, got ${s.q2.motion.jitterP99Ms}ms`);
  });

  test('a parse-error inside an interval marks that gap unreliable, not estimated around', () => {
    const events = [
      { type: 'showinfo', gen: 1, stage: 0, n: 0, pts: 0, ptsTime: 0, checksum: 'A', mono: 1000, wall: 0 },
      { type: 'showinfo', gen: 1, stage: 0, n: 1, pts: 1, ptsTime: 0.5, checksum: 'B', mono: 1500, wall: 0 },
      { type: 'parse-error', gen: 1, mono: 1200, wall: 0, raw: 'garbled line' },
    ];
    const s = analyse(events);
    assert.equal(s.q3.motion.inputPtsGaps.count, 0, 'a tainted interval must not be reported as a normal gap');
    assert.equal(s.q3.motion.inputPtsGaps.unreliableCount, 1);
    assert.deepEqual(s.q3.motion.inputPtsGaps.unreliableAt, [0.5]);
    assert.equal(s.q7.parseErrorCount, 1);
  });
});

describe('fix round 2026-09-24: holes must be loud', () => {
  test('a hole in the stage-0 n sequence is reported by q7 and flips reliable to false', () => {
    // n jumps 0 -> 2: record n=1 was lost entirely (never arrived), distinct from a parse-error
    // (which DID arrive but failed to parse).
    const events = [
      { type: 'showinfo', gen: 1, stage: 0, n: 0, pts: 0, ptsTime: 0, checksum: 'A', mono: 1000, wall: 0 },
      { type: 'showinfo', gen: 1, stage: 0, n: 2, pts: 2, ptsTime: 0.4, checksum: 'C', mono: 1400, wall: 0 },
    ];
    const s = analyse(events);
    assert.equal(s.reliable, false, 'a run with any hole must show reliable: false');
    assert.equal(s.q7.holes.video.count, 1);
    assert.deepEqual(s.q7.holes.video.holes[0], { group: '1:0', from: 0, to: 2, missing: 1 });
    assert.equal(s.q7.holes.audio.count, 0);
  });

  test('a run with no holes and no parse-errors is reliable: true', () => {
    const events = [
      { type: 'showinfo', gen: 1, stage: 0, n: 0, pts: 0, ptsTime: 0, checksum: 'A', mono: 1000, wall: 0 },
      { type: 'showinfo', gen: 1, stage: 0, n: 1, pts: 1, ptsTime: 0.2, checksum: 'B', mono: 1200, wall: 0 },
    ];
    assert.equal(analyse(events).reliable, true);
  });

  test('a gap claim adjacent to a hole is marked unreliable, not computed as a (wrong) gap', () => {
    // n jumps 0 -> 2 AND the ptsTime delta between them (1.0s) is > the 0.4s gap threshold — without
    // hole-awareness this would be reported as a normal 1.0s gap, when the true gap (if any) between
    // the REAL n=1 record and its neighbours is unknown, because n=1 never arrived.
    const events = [
      { type: 'showinfo', gen: 1, stage: 0, n: 0, pts: 0, ptsTime: 0, checksum: 'A', mono: 1000, wall: 0 },
      { type: 'showinfo', gen: 1, stage: 0, n: 2, pts: 2, ptsTime: 1.0, checksum: 'C', mono: 2000, wall: 0 },
    ];
    const s = analyse(events);
    assert.equal(s.q3.motion.inputPtsGaps.count, 0, 'must not report a gap across a hole');
    assert.equal(s.q3.motion.inputPtsGaps.unreliableCount, 1);
  });

  test('a CHECKSUM clone claim adjacent to a stage-1 hole is marked unreliable, not counted either way', () => {
    // Fix round 2026-09-25: `.total` is now the PROVENANCE headline (see the describe block below),
    // which correctly flags n=2 as a clone on its own terms (no stage-0 record near t=0.4 in this
    // fixture) — that's not what this test is about. This test is about the SECONDARY (checksum)
    // signal specifically: n=1 was lost (a hole), so the checksum comparison between st1[0] and
    // st1[2] can't be trusted (they aren't known to be adjacent in the real output) and must be
    // skipped, not counted as a checksum clone even though the checksums happen to match.
    const events = [
      { type: 'showinfo', gen: 1, stage: 0, n: 0, pts: 0, ptsTime: 0, checksum: 'S0', mono: 1000, wall: 0 },
      { type: 'showinfo', gen: 1, stage: 1, n: 0, pts: 0, ptsTime: 0, checksum: 'X', mono: 1050, wall: 0 },
      // stage-1 n jumps 0 -> 2: n=1 was lost. checksum happens to match — must NOT be counted as a
      // checksum clone, because we don't actually know st1[2] is adjacent to st1[0] in the real output.
      { type: 'showinfo', gen: 1, stage: 1, n: 2, pts: 2, ptsTime: 0.4, checksum: 'X', mono: 1450, wall: 0 },
    ];
    const s = analyse(events);
    assert.equal(s.q3.motion.fpsInternalClones.byChecksum.total, 0, 'a pair spanning a hole must not be counted as a checksum clone');
    assert.equal(s.q3.motion.fpsInternalClones.unreliablePairs, 1);
  });
});

describe('fix round 2026-09-25 (Codex review): clone attribution by PROVENANCE, not checksum', () => {
  // fps at 5fps assigns output slots at t=0, 0.2, 0.4, ... A slot is REAL iff some stage-0 (pre-fps)
  // input frame of the SAME generation has pts_time within +/-0.1s of that output time; otherwise fps
  // repeated the held frame (a clone). This is INDEPENDENT of whatever the stage-1 checksum says.

  test('a static scene: distinct stage-0 inputs every 0.2s, but IDENTICAL stage-2 checksums -> 0 provenance clones, N checksum "clones", all reported as disagreements', () => {
    // Every output slot has a real, distinct stage-0 frame nearby (0, 0.2, 0.4, 0.6, 0.8), so
    // provenance says every stage-1 record is real. But the scene is static, so every stage-1 record
    // happens to hash identically — checksum equality alone would call all but the first a clone.
    const stage0 = [0, 0.2, 0.4, 0.6, 0.8].map((t, i) => ({
      type: 'showinfo', gen: 1, stage: 0, n: i, pts: i, ptsTime: t, checksum: `S${i}`, mono: 1000 + t * 1000, wall: 0,
    }));
    const stage1 = [0, 0.2, 0.4, 0.6, 0.8].map((t, i) => ({
      type: 'showinfo', gen: 1, stage: 1, n: i, pts: i, ptsTime: t, checksum: 'SAME', mono: 1000 + t * 1000, wall: 0,
    }));
    const s = analyse([...stage0, ...stage1]);
    const clones = s.q3.motion.fpsInternalClones;
    assert.equal(clones.total, 0, 'provenance: every slot has a real nearby stage-0 frame, so 0 clones');
    assert.equal(clones.byChecksum.total, 4, 'checksum: 4 of the 5 records repeat the previous checksum');
    assert.equal(clones.disagreements.count, 4, 'all 4 checksum "clones" disagree with provenance');
    assert.ok(clones.disagreements.examples.length > 0 && clones.disagreements.examples.length <= 5);
    for (const ex of clones.disagreements.examples) {
      assert.equal(ex.provenanceClone, false);
      assert.equal(ex.checksumClone, true);
    }
  });

  test('a 3s stage-0 gap -> 15 provenance clones (3s / 0.2s output interval)', () => {
    // stage-0 frames only at t=0 and t=3.2 (a 3.2s real gap). Output slots land every 0.2s. Slots
    // strictly between the two real frames' +/-0.1s windows have NO stage-0 support -> clones.
    // Supported slots: t=0 (window [-0.1,0.1) contains stage-0 t=0) and t=3.2's window [3.1,3.3)
    // contains stage-0 t=3.2. Slots t=0.2 .. t=3.0 (15 of them: 0.2,0.4,...,3.0) are unsupported.
    const stage0 = [
      { type: 'showinfo', gen: 1, stage: 0, n: 0, pts: 0, ptsTime: 0, checksum: 'A', mono: 1000, wall: 0 },
      { type: 'showinfo', gen: 1, stage: 0, n: 1, pts: 1, ptsTime: 3.2, checksum: 'B', mono: 4200, wall: 0 },
    ];
    const slots = [];
    for (let t = 0; t <= 3.2 + 1e-9; t = Math.round((t + 0.2) * 10) / 10) slots.push(t);
    // slots holds 0, 0.2, 0.4, ..., 3.2 -> 17 output frames (5fps over a 3.2s span).
    const stage1 = slots.map((t, i) => ({
      type: 'showinfo', gen: 1, stage: 1, n: i, pts: i, ptsTime: t, checksum: `C${i}`, mono: 1000 + t * 1000, wall: 0,
    }));
    const s = analyse([...stage0, ...stage1]);
    assert.equal(s.q3.motion.fpsInternalClones.total, 15, `expected 15 provenance clones, got ${s.q3.motion.fpsInternalClones.total}`);
  });

  test('a normal 10fps input (every 0.1s) -> 0 provenance clones at 5fps output', () => {
    const stage0 = [];
    for (let i = 0; i <= 20; i += 1) {
      stage0.push({ type: 'showinfo', gen: 1, stage: 0, n: i, pts: i, ptsTime: Math.round(i * 0.1 * 10) / 10, checksum: `S${i}`, mono: 1000 + i * 100, wall: 0 });
    }
    const stage1 = [];
    for (let i = 0; i <= 10; i += 1) {
      const t = Math.round(i * 0.2 * 10) / 10;
      stage1.push({ type: 'showinfo', gen: 1, stage: 1, n: i, pts: i, ptsTime: t, checksum: `C${i}`, mono: 1000 + t * 1000, wall: 0 });
    }
    const s = analyse([...stage0, ...stage1]);
    assert.equal(s.q3.motion.fpsInternalClones.total, 0, 'every 5fps output slot has a 10fps input within +/-0.1s');
  });
});

describe('fix round 2026-09-24: q4 gap attribution window is [burstStart-1000ms, burstEnd]', () => {
  // A shared 5-sample burst (size 5, startMono 10000, endMono 10040) reused by every case below, so
  // only the gap's mono position varies between them.
  function burstEvents(gapMono) {
    const samples = [10000, 10010, 10020, 10030, 10040].map((mono, i) => ({
      type: 'sample', gen: 1, mono, wall: 0, n: i, rxMono: mono, rxWall: 0, samplesInRead: 5, hash: `h${i}`, sameAsPrev: false,
    }));
    // A minimal motion gap fixture whose SECOND record's mono is the gap's recorded receipt time.
    const showinfo = [
      { type: 'showinfo', gen: 1, stage: 0, n: 0, pts: 0, ptsTime: 0, checksum: 'A', mono: gapMono - 3500, wall: 0 },
      { type: 'showinfo', gen: 1, stage: 0, n: 1, pts: 1, ptsTime: 3.5, checksum: 'B', mono: gapMono, wall: 0 },
    ];
    return [...samples, ...showinfo];
  }

  test('a gap exactly at burstStart - 1000ms counts (inclusive edge)', () => {
    const s = analyse(burstEvents(10000 - 1000));
    assert.equal(s.q4[0].precededByGap, true);
  });

  test('a gap at burstStart - 1001ms does NOT count (just outside the window)', () => {
    const s = analyse(burstEvents(10000 - 1001));
    assert.equal(s.q4[0].precededByGap, false);
  });

  test('a gap exactly at burstEnd counts (the gap-ending record can land INSIDE the burst)', () => {
    const s = analyse(burstEvents(10040));
    assert.equal(s.q4[0].precededByGap, true);
  });

  test('a gap at burstEnd + 1ms does NOT count (just outside the window)', () => {
    const s = analyse(burstEvents(10041));
    assert.equal(s.q4[0].precededByGap, false);
  });

  test('a gap 49.8s earlier does NOT count — the real bug this fix addresses', () => {
    const s = analyse(burstEvents(10000 - 49800));
    assert.equal(s.q4[0].precededByGap, false, 'a stale, unrelated gap 49.8s earlier must not be attributed to this burst');
  });
});

describe('fix 2026-09-25: a multi-hour capture analyses without blowing the call stack', () => {
  test('200,000 events analyse cleanly (Math.max(...spread) threw RangeError here)', () => {
    // An overnight run holds several hundred thousand events. Spreading them all into Math.max/min
    // throws RangeError: Maximum call stack size exceeded, which the Codex review reproduced at 150,000.
    const events = [];
    for (let i = 0; i < 200000; i++) events.push({ type: 'heartbeat', gen: 1, mono: i, wall: 0, maxLateness: 0, count: 1 });
    let s;
    assert.doesNotThrow(() => { s = analyse(events); });
    assert.equal(s.counts.heartbeats, 200000);
  });

  test('a 150,000-frame motion segment gets through the drift/jitter fit (push(...spread) threw here)', () => {
    // The first fix above missed this one: q2 spread every residual of a segment into push(), and a real
    // 6-hour overnight capture crashed there. The fixture is one gap-free stage-0 run of 150k frames.
    const events = [];
    for (let n = 0; n < 150000; n++) {
      events.push({ type: 'showinfo', gen: 1, stage: 0, n, pts: n, ptsTime: n / 10, checksum: `c${n}`, mono: n * 100, wall: 0 });
    }
    let s;
    assert.doesNotThrow(() => { s = analyse(events); });
    assert.equal(s.q2.motion.segmentCount, 1);
  });
});

describe('fix 2026-09-24: heartbeat lateness is tick to tick, and a stall is attributed only by overlap', () => {
  test('one 3 s stall is counted ONCE, on the tick that ends it, and not on every tick after', () => {
    // Ticks every 100 ms, then one 3,000 ms stall, then normal again. The old schedule-based meter read
    // [0, 0, 3000, 3000, 3000]: a real soak run showed 3,481 then 6,602 ms as two blocks stacked.
    const meter = createLatenessMeter(100, 0);
    const late = [100, 200, 3300, 3400, 3500].map((t) => meter.tick(t));
    assert.deepEqual(late, [0, 0, 3000, 0, 0]);
  });

  test('a stall overlapping the burst window is reported; one ending before the window is not', () => {
    // Window [9000, 10040]: a stall spanning [8000, 9500] overlaps, one spanning [5000, 8999] doesn't.
    assert.equal(stallOverlapping([{ mono: 9500, lateMs: 1500 }], 9000, 10040), 1500);
    assert.equal(stallOverlapping([{ mono: 8999, lateMs: 3999 }], 9000, 10040), 0);
    assert.equal(stallOverlapping([{ mono: 10041 + 3000, lateMs: 2000 }], 9000, 10040), 0);
  });

  test('q4 carries nodeStallMs from the stall events in the file', () => {
    const samples = [10000, 10010, 10020].map((mono, i) => ({
      type: 'sample', gen: 1, mono, wall: 0, n: i, rxMono: mono, rxWall: 0, samplesInRead: 3, hash: `h${i}`, sameAsPrev: false,
    }));
    const showinfo = [0, 1].map((n) => ({ type: 'showinfo', gen: 1, stage: 0, n, pts: n, ptsTime: n * 0.2, checksum: `c${n}`, mono: 9000 + n, wall: 0 }));
    const s = analyse([...samples, ...showinfo, { type: 'stall', gen: 1, mono: 9990, wall: 0, lateMs: 3000 }]);
    assert.equal(s.q4[0].nodeStallMs, 3000);
  });
});

describe('fix round 2026-09-24: sound gap redefinition on a jittered real-shaped sequence', () => {
  test('only the two real gaps (3.33s and 3.25s) are reported; jitter noise is not', () => {
    // Audio PTS here is wall-clock-stamped per packet upstream, so deltas jitter by roughly +/-20ms
    // around the nominal 0.128s window even on a healthy stream (real measurement). Built with a
    // small deterministic jitter pattern plus two real stall-shaped gaps.
    const jitterPattern = [0, 0.018, -0.02, 0.01, -0.015, 0.02, -0.018, 0.012]; // seconds, all < 0.25s
    const events = [];
    let n = 0;
    let ptsTime = 0;
    let mono = 1000;
    const pushFrame = () => {
      events.push({
        type: 'ashowinfo', gen: 1, n, pts: Math.round(ptsTime * 8000), ptsTime,
        nbSamples: 1024, rate: 8000, checksum: `C${n}`, mono,
      });
      n += 1;
    };
    pushFrame();
    for (let i = 0; i < jitterPattern.length; i += 1) {
      const delta = 0.128 + jitterPattern[i];
      ptsTime += delta;
      mono += delta * 1000;
      pushFrame();
    }
    // Real gap 1: 3.33s
    ptsTime += 3.33;
    mono += 3.33 * 1000;
    pushFrame();
    for (let i = 0; i < 3; i += 1) {
      ptsTime += 0.128;
      mono += 128;
      pushFrame();
    }
    // Real gap 2: 3.25s
    ptsTime += 3.25;
    mono += 3.25 * 1000;
    pushFrame();

    // Four more on-schedule packets, so the second gap's recover window can be judged (fix (f): a
    // candidate whose window runs off the end of the data is reported unreliable, not guessed).
    for (let i = 0; i < 12; i += 1) {
      ptsTime += 0.128;
      mono += 128;
      pushFrame();
    }

    const s = analyse(events);
    const disc = s.q3.sound.inputPtsDiscontinuities;
    assert.equal(disc.count, 2, `expected exactly 2 real gaps, got ${disc.count}: ${JSON.stringify(disc.list)}`);
    // Fix (f): the size is now the sustained floor rise — the jump minus the one packet (0.128 s) the
    // sample clock expected, measured from the lowest point of the jitter before it. Planted: gap 1 =
    // 3.33 - 0.128 + (0.007 cumulative jitter at the jump - (-0.007) the floor) = 3.216; gap 2 = 3.25 - 0.128
    // (its floor is now gap 1's level, the jitter no longer moves) = 3.122.
    const sizes = disc.list.map((g) => Math.round(g.sizeSeconds * 1000) / 1000).sort((a, b) => a - b);
    assert.deepEqual(sizes, [3.122, 3.216]);
    assert.ok(disc.deltaDeviationMs.p1 !== null && disc.deltaDeviationMs.p99 !== null);
  });
});

describe('#373 fix (f): the probe\'s sound gaps use the observation clock\'s floor-rise rule', () => {
  test('★ regression: the Stage 1 day run\'s real +268 ms clump is `delayed`, NOT a discontinuity', async () => {
    // backend/test/fixtures/obs/sound-day-clump.json: the real ashowinfo records around the day run's only
    // per-packet deviation over 0.25 s, timing fields only. The old per-packet rule reported it as a gap;
    // the cumulative deviation was back to ~0 within ~0.3 s and no audio was lost.
    const { readFileSync } = await import('node:fs');
    const { records } = JSON.parse(readFileSync(new URL('./fixtures/obs/sound-day-clump.json', import.meta.url), 'utf8'));
    const events = records.map((r) => ({ type: 'ashowinfo', gen: 1, ...r, checksum: 'x', mono: 1000 + r.rxMs, wall: 0 }));
    const disc = analyse(events).q3.sound.inputPtsDiscontinuities;
    assert.equal(disc.count, 0, JSON.stringify(disc.list));
    assert.equal(disc.delayed, 1);
  });

  test('the shared constants: a 501 ms sustained rise is a gap, 499 ms is not (both sides of SOUND_GAP_SEC)', () => {
    for (const [rise, gaps] of [[0.501, 1], [0.499, 0]]) {
      const events = [];
      for (let n = 0; n < 60; n += 1) {
        const t = n * 0.04 + (n >= 30 ? rise : 0);
        events.push({ type: 'ashowinfo', gen: 1, n, pts: Math.round(t * 8000), ptsTime: t, nbSamples: 320, rate: 8000, checksum: 'x', mono: 1000 + n * 40 + (n >= 30 ? rise * 1000 : 0), wall: 0 });
      }
      assert.equal(analyse(events).q3.sound.inputPtsDiscontinuities.count, gaps, `rise ${rise}`);
    }
  });
});

describe('fix round 2026-09-24: Q7 separates showinfo/ashowinfo continuation noise from real noise', () => {
  test('continuationLineCount and otherStderrCount are reported separately', () => {
    const events = [
      { type: 'showinfo', gen: 1, stage: 0, n: 0, pts: 0, ptsTime: 0, checksum: 'A', mono: 1000, wall: 0 },
      { type: 'stderr-continuation', gen: 1, mono: 1010, wall: 0, line: 'color_range:unknown' },
      { type: 'stderr-continuation', gen: 1, mono: 1020, wall: 0, line: 'color_range:unknown' },
      { type: 'stderr', gen: 1, mono: 1030, wall: 0, line: 'Stream mapping:' },
    ];
    const s = analyse(events);
    assert.equal(s.q7.continuationLineCount, 2);
    assert.equal(s.q7.otherStderrCount, 1);
    assert.equal(s.counts.stderrContinuation, 2);
  });
});

describe('fix round 2026-09-25 (Codex review): dup_frames/drop_frames summed across generations', () => {
  test('two generations: cfrDups sums each generation\'s own last progress record, not just the final one', () => {
    const events = [
      { type: 'progress', gen: 1, mono: 1000, wall: 0, state: 'continue', dup_frames: 3, drop_frames: 1 },
      { type: 'progress', gen: 1, mono: 2000, wall: 0, state: 'end', dup_frames: 5, drop_frames: 2 }, // gen 1's LAST
      { type: 'progress', gen: 2, mono: 3000, wall: 0, state: 'continue', dup_frames: 1, drop_frames: 0 },
      { type: 'progress', gen: 2, mono: 4000, wall: 0, state: 'end', dup_frames: 4, drop_frames: 3 }, // gen 2's LAST
      { type: 'showinfo', gen: 1, stage: 0, n: 0, pts: 0, ptsTime: 0, checksum: 'A', mono: 500, wall: 0 },
    ];
    const s = analyse(events);
    assert.deepEqual(s.q3.motion.cfrDups, { dup_frames: 9, drop_frames: 5 }, 'must sum gen1 (5,2) + gen2 (4,3), not just the last progress event overall');
  });
});

describe('fix round 2026-09-25 (Codex review): gap/segment boundaries are keyed by generation', () => {
  test('gen 2 reaching the same pts_time as gen 1\'s gap causes NO extra segment split', () => {
    // Gen 1: a real 3.5s gap (0 -> 3.5), each side with only 1 point so it can't itself form a
    // 2+-point segment. Gen 2: NORMAL, evenly spaced (0.25s steps, all < the 0.4s gap threshold, so
    // NO gap of its own) frames that simply happen to pass through ptsTime=3.5 too — ptsTime restarts
    // near 0 every generation, so this coincidence is realistic, not contrived.
    const gen1 = [
      { type: 'showinfo', gen: 1, stage: 0, n: 0, pts: 0, ptsTime: 0, checksum: 'A', mono: 1000, wall: 0 },
      { type: 'showinfo', gen: 1, stage: 0, n: 1, pts: 1, ptsTime: 3.5, checksum: 'B', mono: 4500, wall: 0 },
    ];
    const gen2 = [3.0, 3.25, 3.5, 3.75, 4.0].map((t, i) => ({
      type: 'showinfo', gen: 2, stage: 0, n: i, pts: i, ptsTime: t, checksum: `G${i}`, mono: 10000 + t * 1000, wall: 0,
    }));
    const s = analyse([...gen1, ...gen2]);
    assert.equal(s.q3.motion.inputPtsGaps.count, 1, 'only gen 1\'s real gap should be reported');
    assert.equal(s.q2.motion.segmentCount, 1, 'gen 2 (5 points, no gap of its own) must be ONE segment, not split at ptsTime=3.5 just because gen 1 had a gap there');
  });
});

describe('fix round 2026-09-25 (Codex review): Q6 startup burst must begin at the FIRST sample', () => {
  test('normal spacing at the start, then a burst 5s later -> no startup burst reported', () => {
    const normalStart = [0, 200, 400].map((mono, i) => ({
      type: 'sample', gen: 1, mono, wall: 0, n: i, rxMono: mono, rxWall: 0, samplesInRead: 1, hash: `h${i}`, sameAsPrev: false,
    }));
    // A real burst (>=3 samples within 50ms) starting 5s in — NOT at the first sample.
    const lateBurst = [5000, 5010, 5020, 5030].map((mono, i) => ({
      type: 'sample', gen: 1, mono, wall: 0, n: 3 + i, rxMono: mono, rxWall: 0, samplesInRead: 1, hash: `b${i}`, sameAsPrev: false,
    }));
    const events = [{ type: 'spawn', gen: 1, mono: -100, wall: 0 }, ...normalStart, ...lateBurst];
    const s = analyse(events);
    assert.equal(s.q6[1].startupBurst, false, 'the burst starts 5s in, not at the first sample');
    assert.equal(s.q6[1].firstBurstSize, null);
  });
});

describe('fix round 2026-09-24: sameAsPrev caveat for sound', () => {
  test('q3.sound documents that sameAsPrev is meaningless on a periodic test tone', () => {
    const events = [
      { type: 'ashowinfo', gen: 1, n: 0, pts: 0, ptsTime: 0, nbSamples: 1024, rate: 8000, checksum: 'A', mono: 1000, wall: 0 },
    ];
    const s = analyse(events);
    assert.match(s.q3.sound.sameAsPrevCaveat, /periodic test tone/);
    assert.match(s.q3.sound.sameAsPrevCaveat, /no information/);
  });
});
