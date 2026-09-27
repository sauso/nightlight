// observationClock.js, the SOUND leg (issue #373 Stage 2, plan v4 §B Sound, §Tests 5).
//
// ★ ORACLES (C7). Audio has its own sample clock; its PTS is the transcoder's wall-clock stamp of when each
// packet ARRIVED. Every stream here is PLANTED by playAudio() below from an explicit arrival schedule — the
// generator knows which packets it dropped or held and for how long, and that record is the oracle. The one
// real trace is the Stage 1 day run's +268 ms clump (fixtures/obs/sound-day-clump.json), which recovered on
// its own and must NOT read as a discontinuity. The captured AAC runs (sound-aac*.err + .pcm) are real
// ffmpeg records and output.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _resetObservationClocksForTests } from '../src/lib/observationClock.js';
import { makeClock, WALL0 } from './helpers/obsRig.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, 'fixtures', 'obs');

beforeEach(() => _resetObservationClocksForTests());

function soundRig(opts = {}) {
  const r = makeClock('sound', opts);
  const gen = r.clock.beginGeneration({ path: 'cam', windowSeconds: 0.2 });
  return {
    ...r,
    gen,
    rec(n, pts, rate, nb, at, ptsTime = pts / rate) {
      r.t.mono = at;
      gen.onRecord({ tap: 'audio', n, pts, ptsTime, rate, nbSamples: nb });
    },
    win(at, analysed = true) {
      r.t.mono = at;
      gen.onSample(Buffer.alloc(0), at, at + r.t.wallOffset, { analysed });
    },
    end(at) { r.t.mono = at; gen.end('exit', { code: 0 }); },
    byIdx: () => [...r.obs].sort((a, b) => a.idx - b.idx),
  };
}

// Planted audio. Packet i (nb samples at `rate`) is CAPTURED at i*dur ms; arrive(i) is when it reached the
// transcoder (ms), or null if it was lost. Its PTS is that arrival (the wall-clock re-stamp), Node gets the
// record `lat` ms later, and each 1,600-sample output window comes out right after the record that
// completes it. Returns the windows emitted.
function playAudio(rig, { packets, rate = 8000, nb = 320, arrive, lat = 20, base = 100_000, analysed = () => true, n0 = 0 }) {
  const durMs = (nb / rate) * 1000;
  let received = 0;
  let n = n0;
  let windows = 0;
  let lastRx = base;
  for (let i = 0; i < packets; i += 1) {
    const a = arrive(i);
    if (a === null) continue;
    const rx = base + a + lat;
    lastRx = rx;
    rig.rec(n, Math.round((a * rate) / 1000), rate, nb, rx);
    n += 1;
    received += 1;
    while ((windows + 1) * 200 <= received * durMs + 1e-9) {
      rig.win(rx + 0.5, analysed(windows));
      windows += 1;
    }
  }
  return { windows, lastRx, received };
}

// A deterministic small jitter (0..29 ms) so every stream is realistically ragged but reproducible.
const jitter = (i) => (i * 7919) % 30;

describe('a clean stream', () => {
  test('60 s of 8 kHz G711-shaped packets: every window observed, no gaps, windows 200 ms apart', () => {
    const rig = soundRig();
    const { windows, lastRx } = playAudio(rig, { packets: 1500, arrive: (i) => i * 40 + jitter(i) });
    rig.end(lastRx + 10_000);
    const o = rig.byIdx();
    assert.equal(o.length, windows);
    assert.ok(o.every((x) => x.cls === 'observed'), JSON.stringify(o.find((x) => x.cls !== 'observed')));
    for (let i = 1; i < o.length; i += 1) assert.ok(Math.abs(o[i].obsMono - o[i - 1].obsMono - 200) < 1e-6, `window ${i}`);
    const s = rig.clock.summary();
    assert.equal(s.gaps, 0);
    assert.equal(s.delayed, 0);
    assert.ok(o.every((x) => x.obsMono <= x.rxMono));
  });

  test('the real 16 and 48 kHz AAC captures: both whole output windows observed, 200 ms apart', () => {
    for (const f of ['sound-aac16000', 'sound-aac48000']) {
      const recs = fs.readFileSync(path.join(FIX, `${f}.err`), 'utf8').split('\n')
        .map((l) => /\] \[info\] n:(\d+) pts:(\d+) pts_time:(\S+) .* rate:(\d+) nb_samples:(\d+) /.exec(l)).filter(Boolean)
        .map((m) => ({ n: Number(m[1]), pts: Number(m[2]), ptsTime: Number(m[3]), rate: Number(m[4]), nb: Number(m[5]) }));
      const windows = Math.floor(fs.statSync(path.join(FIX, `${f}.pcm`)).size / 3200);
      assert.equal(windows, 2, f);
      const rig = soundRig();
      for (const r of recs) rig.rec(r.n, r.pts, r.rate, r.nb, 100_000 + (r.pts / r.rate) * 1000 + 20, r.ptsTime);
      for (let w = 0; w < windows; w += 1) rig.win(100_600 + w);
      rig.end(110_000);
      const o = rig.byIdx();
      assert.deepEqual(o.map((x) => x.cls), ['observed', 'observed'], f);
      assert.ok(Math.abs(o[1].obsMono - o[0].obsMono - 200) < 1e-6, f);
    }
  });
});

describe('★ delay is not loss: the floor-rise rule (plan §B Sound, R1-F6)', () => {
  test('the day run\'s real +268 ms clump is counted `delayed`, NOT a discontinuity', () => {
    const { records } = JSON.parse(fs.readFileSync(path.join(FIX, 'sound-day-clump.json'), 'utf8'));
    assert.equal(records.length, 150);
    const rig = soundRig();
    let samples = 0;
    records.forEach((r, i) => {
      rig.rec(i, r.pts - records[0].pts, r.rate, r.nbSamples, 100_000 + r.rxMs);
      if (((i + 1) * r.nbSamples) / 1600 >= samples + 1) {
        rig.win(100_000 + r.rxMs + 0.5);
        samples += 1;
      }
    });
    rig.end(100_000 + records.at(-1).rxMs + 10_000);
    const s = rig.clock.summary();
    assert.equal(s.gaps, 0, 'a clump that recovered in ~320 ms is not a gap');
    assert.equal(s.delayed, 1, 'it is reported as delayed');
    assert.ok(rig.byIdx().every((x) => x.cls === 'observed'));
  });

  for (const [kind, sizeMs, planted] of [['DROP', 750, 760], ['DROP', 2000, 2000], ['HOLD', 750, 750], ['HOLD', 2000, 2000]]) {
    test(`${kind} ${sizeMs} ms (planted) -> one UNKNOWN discontinuity at the planted position, ~${planted} ms`, () => {
      // k = 1003: 40.12 s of media, inside output window 200 (40.0-40.2 s), so that window straddles it.
      const k = 1003;
      const arrive = kind === 'DROP'
        ? (i) => (i * 40 >= k * 40 && i * 40 < k * 40 + sizeMs ? null : i * 40 + jitter(i))
        : (i) => i * 40 + (i >= k ? sizeMs : 0) + jitter(i);
      const rig = soundRig();
      const { lastRx } = playAudio(rig, { packets: 2000, arrive });
      rig.end(lastRx + 10_000);
      const s = rig.clock.summary();
      assert.equal(s.gaps, 1, `${kind}: loss and a sustained hold are indistinguishable, so both are one discontinuity`);
      assert.ok(Math.abs(s.gapMs - planted) <= 30, `size ${s.gapMs} vs planted ${planted}`);
      const o = rig.byIdx();
      const straddler = o[200];
      assert.equal(straddler.spans.length, 2, 'the window around the gap carries two spans (C5)');
      assert.ok(Math.abs(straddler.spans[1][0] - straddler.spans[0][1] - planted) <= 30);
      assert.equal(o.filter((x) => x.spans && x.spans.length === 2).length, 1);
      // Nothing about this reads as a "loss": there is no such class.
      assert.ok(o.every((x) => x.cls === 'observed' || x.cls === 'unknown'));
    });
  }

  test('floor rises at SOUND_GAP_S +- 1 ms, held for SOUND_RECOVER_MS +- 1 ms: only 501 ms held 1001 ms is a gap', () => {
    // Anything over half the gap threshold that does not become a gap is one `delayed` episode; at or
    // under half, nothing is counted at all.
    const cases = [
      { rise: 501, hold: 1001, gaps: 1, delayed: 0 },
      { rise: 501, hold: 1000, gaps: 0, delayed: 1 }, // back to normal exactly at the window's end: recovered
      { rise: 501, hold: 999, gaps: 0, delayed: 1 },
      { rise: 500, hold: 1001, gaps: 0, delayed: 1 },
      { rise: 499, hold: 1001, gaps: 0, delayed: 1 },
      { rise: 251, hold: 1001, gaps: 0, delayed: 1 },
      { rise: 250, hold: 1001, gaps: 0, delayed: 0 },
    ];
    for (const c of cases) {
      const rig = soundRig();
      const B = 100_000;
      let n = 0;
      // 20 s of steady packets, received exactly on schedule, so the reference floor is exactly 0.
      for (let i = 0; i < 500; i += 1) rig.rec(n++, i * 320, 8000, 320, B + i * 40);
      // At packet 500 the PTS jumps by `rise` and stays up; the first packet back to normal is RECEIVED
      // exactly `hold` ms after the jump.
      const t0 = B + 500 * 40;
      let i = 500;
      for (; t0 + (i - 500) * 40 < t0 + c.hold - 20; i += 1) rig.rec(n++, i * 320 + c.rise * 8, 8000, 320, t0 + (i - 500) * 40);
      rig.rec(n++, i * 320, 8000, 320, t0 + c.hold);
      for (let j = i + 1; j < i + 100; j += 1) rig.rec(n++, j * 320, 8000, 320, t0 + c.hold + (j - i) * 40);
      rig.end(t0 + c.hold + 10_000);
      const s = rig.clock.summary();
      assert.deepEqual({ gaps: s.gaps, delayed: s.delayed }, { gaps: c.gaps, delayed: c.delayed }, JSON.stringify(c));
    }
  });

  test('a 2 s stall drained at 2x is flagged (the conservative direction) and coverage never exceeds the truth (beyond the 1e-6 ms join epsilon)', () => {
    const k = 1000;
    const arrive = (i) => (i < k ? i * 40 : Math.max(i * 40, k * 40 + 2000 + (i - k) * 20));
    const rig = soundRig();
    const { lastRx, windows } = playAudio(rig, { packets: 2000, arrive, lat: 20 });
    rig.end(lastRx + 10_000);
    const s = rig.clock.summary();
    assert.equal(s.gaps, 1, 'reported as a discontinuity: observed audio called unknown, never the reverse');
    // In RECEIPT time the backlog drains 1 s per second, so after SOUND_RECOVER_MS ~1 s of it remains.
    assert.ok(s.gapMs > 900 && s.gapMs < 1100, `~1 s UNKNOWN (plan §B), got ${s.gapMs}`);
    const covered = rig.clock.sampler.measure(-Infinity, Infinity);
    assert.ok(covered <= windows * 200 + 1e-6, `coverage ${covered} ms exceeds the ${windows * 200} ms of audio delivered`);
  });

  test('+-100 ppm audio-clock drift over 6 h with jitter: 0 discontinuities (the reference floor tracks drift)', () => {
    for (const ppm of [100, -100]) {
      const rig = soundRig();
      // 1 s packets (8,000 samples) keep this at 21,600 records; the rule is per record either way.
      const { lastRx } = playAudio(rig, { packets: 6 * 3600, nb: 8000, arrive: (i) => i * 1000 * (1 + ppm * 1e-6) + (i * 7919) % 60 });
      rig.end(lastRx + 10_000);
      assert.equal(rig.clock.summary().gaps, 0, `${ppm} ppm`);
    }
  });
});

describe('stamps after a discontinuity (R1-F4, R2-O1)', () => {
  test('a 3 s discontinuity then 90 s of normal audio: stamps never exceed receipt, are never offset twice, no clamps', () => {
    const k = 1500; // 60 s in
    const rig = soundRig();
    const { lastRx } = playAudio(rig, { packets: 1500 + 2250 + 75, arrive: (i) => (i >= k && i < k + 75 ? null : i * 40 + jitter(i)) });
    rig.end(lastRx + 10_000);
    const o = rig.byIdx().filter((x) => x.cls === 'observed');
    assert.equal(rig.clock.summary().gaps, 1);
    assert.equal(rig.clock.summary().clamps, 0);
    assert.equal(rig.clock.summary().compressed, 0);
    for (const x of o) assert.ok(x.obsMono <= x.rxMono, `window ${x.idx} stamped after its receipt`);
    // Age = receipt - stamp. Before and after the gap it is the same pipeline latency; a gap counted twice
    // would put every later window 3 s in the future (clamped) or 3 s older.
    const age = (x) => x.rxMono - x.obsMono;
    const before = o.filter((x) => x.idx < 290).map(age);
    const after = o.filter((x) => x.idx > 320).map(age);
    const avg = (a) => a.reduce((p, c) => p + c, 0) / a.length;
    assert.ok(Math.abs(avg(before) - avg(after)) < 40, `age ${avg(before)} vs ${avg(after)}`);
    // Windows positioned BEFORE the gap, finalized after it was found, carry no share of it (R2-O1).
    const w299 = o.find((x) => x.idx === 299);
    const w300 = o.find((x) => x.idx === 300);
    assert.ok(w300.obsMono - w299.obsMono > 3000, 'the jump sits between the windows either side of the gap');
    for (let i = 1; i < 299; i += 1) assert.ok(Math.abs(o[i].obsMono - o[i - 1].obsMono - 200) < 1e-6);
  });
});

describe('what the sound model cannot know, it says (R1-F11, C5)', () => {
  test('an ashowinfo n-hole at 48 kHz: every later window in the generation is UNKNOWN, earlier ones are not', () => {
    const rig = soundRig();
    const B = 100_000;
    let windows = 0;
    let media = 0;
    for (let i = 0; i < 600; i += 1) {
      if (i === 300) continue; // record 300 lost: its 1,024 samples can no longer be placed
      rig.rec(i, i * 1024, 48000, 1024, B + (i * 1024) / 48 + 20);
      media += 1024 / 48;
      while ((windows + 1) * 200 <= media) { rig.win(B + (i * 1024) / 48 + 20.5); windows += 1; }
    }
    rig.end(B + 30_000);
    const o = rig.byIdx();
    const holeMs = (300 * 1024) / 48; // media position of the hole
    for (const x of o) {
      if ((x.idx + 1) * 200 <= holeMs) assert.equal(x.cls, 'observed', `window ${x.idx}`);
      else assert.deepEqual([x.cls, x.reason], ['unknown', 'hole'], `window ${x.idx}`);
    }
  });

  test('a candidate whose recover window reaches a hole stays undecided: never judged on partial evidence', () => {
    // Planted: 20 s steady, then a +600 ms floor rise at packet 500, then record 503 LOST (a hole) 120 ms
    // later — inside the 1 s recover window. Records past a hole are not kept, so the window cannot be
    // completed: no gap and no `delayed` may be claimed from the three records before it.
    const rig = soundRig();
    const B = 100_000;
    for (let i = 0; i < 500; i += 1) rig.rec(i, i * 320, 8000, 320, B + i * 40);
    for (let i = 500; i < 540; i += 1) {
      if (i === 503) continue;
      rig.rec(i, i * 320 + 600 * 8, 8000, 320, B + i * 40);
    }
    rig.end(B + 30_000);
    const s = rig.clock.summary();
    assert.deepEqual({ gaps: s.gaps, delayed: s.delayed }, { gaps: 0, delayed: 0 });
    assert.ok(rig.gen.candidate, 'the candidate is left open (its windows read UNKNOWN)');
  });

  test('an 8 kHz record that failed to parse is treated exactly like a hole', () => {
    const rig = soundRig();
    const { lastRx } = playAudio(rig, { packets: 100, arrive: (i) => i * 40 });
    rig.gen.onParseError('audio');
    playAudio(rig, { packets: 100, arrive: (i) => 4000 + i * 40, n0: 100 });
    rig.end(lastRx + 20_000);
    const o = rig.byIdx();
    assert.ok(o.slice(0, 20).every((x) => x.cls === 'observed'));
    assert.ok(o.slice(20).every((x) => x.reason === 'hole'));
  });

  test('silence: a digitally silent window counts as SAMPLED coverage but not ANALYSED coverage', () => {
    const rig = soundRig();
    const { lastRx } = playAudio(rig, { packets: 500, arrive: (i) => i * 40, analysed: (w) => !(w >= 40 && w < 60) });
    rig.end(lastRx + 10_000);
    const sampled = rig.clock.sampler.measure(-Infinity, Infinity);
    const analysed = rig.clock.analysis.measure(-Infinity, Infinity);
    assert.ok(Math.abs(sampled - analysed - 20 * 200) < 1e-6, `sampled ${sampled} analysed ${analysed}`);
    const s = rig.clock.summary();
    assert.equal(s.silent, 20);
    assert.equal(s.observed, 100);
  });

  test('no records at all: windows are UNKNOWN and one line says the side channel is unavailable', () => {
    const rig = soundRig();
    for (let w = 0; w < 30; w += 1) rig.win(100_000 + w * 200);
    rig.end(120_000);
    assert.ok(rig.obs.every((x) => x.cls === 'unknown'));
    assert.equal(rig.logs.filter((l) => l.includes('side-channel unavailable')).length, 1);
  });
});

describe('host wall-clock steps on the sound leg (R2-O3, R3-3\')', () => {
  function stepAudio(stepMs, lossMs) {
    // 60 s of packets; at packet 1000 the host clock steps (wall AND the transcoder's PTS move by stepMs)
    // and, optionally, lossMs of real audio is lost at the same instant. After a BACKWARD step the
    // transcoder clamps DTS for |step|, so PTS creeps by one tick per packet until wall time catches up.
    const rig = soundRig();
    const B = 100_000;
    let n = 0;
    let lastPts = -1;
    let windows = 0;
    let received = 0;
    for (let i = 0; i < 1500; i += 1) {
      const lost = i >= 1000 && lossMs > 0 && i * 40 < 1000 * 40 + lossMs;
      if (lost) continue;
      const arrivalMs = i * 40;
      const rx = B + arrivalMs + 20;
      if (i === 1000 || (lossMs > 0 && lastPts >= 0 && i === Math.ceil((1000 * 40 + lossMs) / 40) && i > 1000 && rig.t.wallOffset === WALL0)) rig.t.wallOffset = WALL0 + stepMs;
      let pts = Math.round(((arrivalMs + (i >= 1000 ? stepMs : 0)) * 8000) / 1000);
      if (pts <= lastPts) pts = lastPts + 1; // the DTS clamp after a backward step
      lastPts = pts;
      rig.rec(n++, pts, 8000, 320, rx);
      received += 1;
      while ((windows + 1) * 200 <= received * 40) { rig.win(rx + 0.5); windows += 1; }
    }
    rig.end(B + 80_000);
    return rig;
  }

  test('+900 and -900 ms steps: one WALL-STEP each, never a discontinuity, UTC never goes back', () => {
    for (const step of [900, -900]) {
      const rig = stepAudio(step, 0);
      const s = rig.clock.summary();
      assert.equal(s.wallSteps, 1, `${step}`);
      assert.equal(s.gaps, 0, `${step}: a host clock step is not a gap`);
      const o = rig.byIdx().filter((x) => x.obsWall !== null);
      for (let i = 1; i < o.length; i += 1) assert.ok(o[i].obsWall >= o[i - 1].obsWall, `${step}: UTC went back at ${o[i].idx}`);
    }
  });

  test('a step coinciding with a real 900 ms loss: the loss still reads as ~0.9 s, in both directions', () => {
    for (const step of [900, -900]) {
      const rig = stepAudio(step, 900);
      const s = rig.clock.summary();
      assert.equal(s.gaps, 1, `${step} + loss`);
      assert.ok(Math.abs(s.gapMs - 920) <= 60, `${step} + loss: ${s.gapMs} ms (planted: 23 packets = 920 ms)`);
    }
  });
});

describe('fix round 2: discontinuities while stdout is stalled (H4)', () => {
  test('H4: 299 discontinuities before any window arrives — the list stays capped, and a window before a discontinuity folded early reads UNKNOWN, never a wrong time', () => {
    // Planted: 8 kHz, 320-sample packets (40 ms). 300 cycles of 30 packets received then 20 lost (a real 800 ms
    // loss each), all records first — stdout stalled — then every window. Every loss but the last is followed
    // by a record, so there are 299 discontinuities; discontinuity c sits at received media (c + 1) x 1.2 s.
    // The list holds 256; the 43 oldest fold early, the last of them at 43 x 1.2 = 51.6 s, so windows 0..257
    // (they start before it) are UNKNOWN('disc-capped'), and from window 258 on every one is stamped at its
    // true capture time.
    const rig = soundRig();
    const B = 100_000;
    const lat = 20;
    let n = 0;
    let lastRx = B;
    for (let c = 0; c < 300; c += 1) {
      for (let p = 0; p < 30; p += 1) {
        const capture = c * 2000 + p * 40; // ms: each cycle is 2 s of camera time, the last 0.8 s lost
        lastRx = B + capture + lat;
        rig.rec(n, Math.round(capture * 8), 8000, 320, lastRx);
        n += 1;
      }
    }
    assert.equal(rig.gen.disc.length, 256, 'capped');
    const windows = (300 * 30 * 320) / 1600; // 1,800
    for (let w = 0; w < windows; w += 1) rig.win(lastRx + 100 + w * 0.01);
    rig.end(lastRx + 20_000);
    const o = rig.byIdx();
    assert.equal(o.length, windows);
    assert.equal(rig.clock.summary().gaps, 299);
    for (const x of o.slice(0, 258)) assert.deepEqual([x.cls, x.reason], ['unknown', 'disc-capped'], `window ${x.idx}`);
    // Independent of the module: window w ends at received media r = 200 (w + 1) ms, i.e. capture time
    // 2000 floor(r / 1200) + (r mod 1200) — except exactly at a cycle boundary, which is the END of the
    // packet before the loss (800 ms earlier). The anchor is the lowest (receipt - media END of the record):
    // each packet is received 20 ms after its capture START and ends 40 ms after it, so B - 20 ms.
    for (const x of o.slice(258)) {
      const r = 200 * (x.idx + 1);
      const c = Math.floor(r / 1200);
      const capture = r % 1200 === 0 ? c * 2000 - 800 : c * 2000 + (r % 1200);
      assert.equal(x.cls, 'observed', `window ${x.idx}: ${x.reason}`);
      assert.ok(Math.abs(x.obsMono - (B + lat - 40 + capture)) < 1e-6, `window ${x.idx} stamped ${x.obsMono} vs ${B + lat - 40 + capture}`);
    }
  });
});

describe('fix round 2: the reference floor over a smoothly rising excess (H2)', () => {
  test('H2: > 1,024 strictly rising records inside one 60 s window — no phantom discontinuity, every window stamped at its own media time', () => {
    // The Opus review's craft-deque-phantom.mjs, as a planted stream: 8 kHz, 320-sample packets (25/s), 96 s.
    // Transport latency 20 ms for media 0-2 s, then 420 ms (a 400 ms held floor rise: `delayed`, not a gap),
    // then 320 ms rising by exactly 0.145 ms a packet with no jitter (a ~0.36 % clock-rate error). The
    // excess never rises SOUND_GAP_S above the true 60 s minimum, so the truth is: no discontinuity.
    // At the old 1,024-entry cap the reference deque coarsened, kept the 0 ms excess of media ~2 s under the
    // key of media 10 s, read 300 ms too low for 8 s of media, and at ~62 s called a 500.9 ms discontinuity
    // that moved every later window 500 ms later.
    const rig = soundRig();
    const B = 100_000;
    const latency = (i) => (i < 50 ? 20 : i < 250 ? 420 : 320 + 0.145 * (i - 250));
    const { windows, lastRx } = playAudio(rig, { packets: 2400, arrive: (i) => i * 40 + latency(i), lat: 2, base: B });
    rig.end(lastRx + 10_000);
    const s = rig.clock.summary();
    assert.deepEqual([s.gaps, s.gapMs], [0, 0]);
    // Independent of the module: the anchor is the lowest (receipt - media end) — the 20 ms stretch: packet i
    // is received at B + 40 i + 20 + 2 and ends at media 40 (i + 1), with the first PTS at 20 ms, so the anchor
    // is B - 38 and window w (media ending at 0.2 (w + 1) s) is stamped at B - 18 + 200 (w + 1).
    const o = rig.byIdx();
    assert.equal(o.length, windows);
    for (const x of o) {
      assert.equal(x.cls, 'observed', `window ${x.idx}: ${x.reason}`);
      assert.ok(Math.abs(x.obsMono - (B - 18 + 200 * (x.idx + 1))) < 1e-6, `window ${x.idx} stamped ${x.obsMono}`);
    }
  });
});
