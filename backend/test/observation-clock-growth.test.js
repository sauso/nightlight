// Bounded growth: every memory-bearing structure in observationClock.js stays small over a simulated DAY
// (issue #373 Stage 2, fix round 1, F1). The class of bug no other test here can see: the Codex review found
// SoundGeneration.records keeping every ashowinfo record of a generation (~2.2 million objects a day at
// 25 records/s), and a camera that never restarts never ends its generation.
//
// HOW: pure and simulated — the clock gets injected monotonic/wall clocks and is fed the records and samples
// a detector would hand it, at a planted rate, for 24 simulated hours per scenario. Every simulated hour the
// size of every structure is sampled (clock.sizes()); the test asserts the MAXIMUM over the day stays under
// a small constant. The `[obs]` timer is emulated (resetPeriod every 15 minutes), as it runs in production.
//
// RATES: to run in seconds, the 24 h runs use 1 output sample per second (motion fps=1 with 2 inputs per
// output; sound 1 s packets and 1 s windows). The structures are bounded by TIME windows (10 s ring, 30 s
// out retention once a record is released, 5 s finalize, 1 h envelope), so their size scales with the rate —
// except in the one regime only COUNT caps bound (a frozen picture with no samples; see FROZEN_2H) — and a
// 2-hour run at the real
// rates (motion 10 fps in / 5 fps out; sound 25 packets/s, 0.2 s windows) pins the constants there.
//
// The bounds below are literal numbers, derived here from the planted rates, not read from the module.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ObservationClock } from '../src/lib/observationClock.js';

const H = 3_600_000;
const WALL0 = 1_790_000_000_000;

// Adler-32 with showinfo's initial value 0, textbook form (NOT the module's): the out records need the
// checksum of the sample bytes they stand for. zlib's (helpers/obsRig.js) is exact too but, at hundreds of
// thousands of records, costs more than the clock under test.
function adler0(buf) {
  let a = 0;
  let b = 0;
  for (const byte of buf) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function makeClock(leg) {
  const t = { mono: 1_000, wallStep: 0 };
  const clocks = { monoNow: () => t.mono, wallNow: () => t.mono + WALL0 + t.wallStep };
  const clock = new ObservationClock('growth', leg, { clocks, log: () => {} });
  return { t, clock };
}

// Tracks the maximum of every size, and emulates the 15-minute `[obs]` timer (keeping the day's totals of
// the counters it resets).
const TOTALS = ['samples', 'observed', 'real', 'unknown', 'gaps', 'wallSteps', 'delayed', 'warn'];
function watcher(clock, t, { noTimer = false } = {}) {
  const max = {};
  const totals = Object.fromEntries(TOTALS.map((k) => [k, 0]));
  const addTotals = () => {
    const s = clock.summary(t.mono);
    for (const k of TOTALS) totals[k] += s[k];
  };
  let nextSample = t.mono + H;
  let nextReset = t.mono + 900_000;
  return {
    tick() {
      if (!noTimer && t.mono >= nextReset) {
        addTotals();
        clock.resetPeriod(t.mono);
        nextReset += 900_000;
      }
      if (t.mono >= nextSample) {
        for (const [k, v] of Object.entries(clock.sizes())) max[k] = Math.max(max[k] ?? 0, v);
        nextSample += H;
      }
    },
    final() {
      for (const [k, v] of Object.entries(clock.sizes())) max[k] = Math.max(max[k] ?? 0, v);
      addTotals();
      return { max, totals };
    },
  };
}

// --- motion ---------------------------------------------------------------------------------------------
// `inFps` inputs per second into fps=`fps`; the out records follow vf_fps (slot t is emitted when an input
// with a later slot arrives, from the latest input at or before it), and each stdout sample arrives one out
// record later (the CFR hold). Options plant the awkward cases.
// Fix round 2 (H1) added three hostile shapes: `pairs` (output records identical in pairs: a run of two, then
// a new one), `staticScene` (every output frame identical: ONE identical-content run that never ends, a frozen
// picture) and `backEvery` (every Nth input's pts two output slots backwards: a reordered span each time).
function runMotion({ hours, fps = 1, inFps = 2, holeEvery = 0, outHoleEvery = 0, stallEvery = 0, stallMs = 0, stepEvery = 0, noSamples = false, driftPerRecordMs = 0, spikeAt = -1, noTimer = false, noOuts = false, pairs = false, staticScene = false, backEvery = 0, onGen = null, onSample = null }) {
  const { t, clock } = makeClock('motion');
  const gen = clock.beginGeneration({ path: 'growth', fps });
  if (onGen) onGen(gen, t); // lets a test attach work counters (H3)
  gen.onConfig({ tap: 'in', dir: 'in', tbNum: 1, tbDen: 90000 });
  gen.onConfig({ tap: 'out', dir: 'in', tbNum: 1, tbDen: fps });
  const w = watcher(clock, t, { noTimer });
  const inMs = 1000 / inFps;
  const total = Math.round((hours * H) / inMs);
  const slotOf = (ptsMs) => Math.floor((2 * ptsMs * fps + 1000) / 2000);
  let next = null;
  let latest = null;
  let outN = 0;
  let held = null;
  let stepSign = 1;
  let stepOffset = 0;
  let lastPts = -1;
  const t0 = t.mono;
  for (let k = 0; k < total; k += 1) {
    const trueMs = k * inMs;
    // A camera stall: nothing arrives for stallMs, then the stream carries on (pts continue from real time).
    if (stallEvery && k > 0 && k % stallEvery === 0) t.mono += stallMs;
    if (stepEvery && k > 0 && k % stepEvery === 0) {
      t.wallStep += 900 * stepSign;
      stepOffset += 900 * stepSign;
      stepSign = -stepSign;
    }
    const stall = stallEvery ? Math.floor(k / stallEvery) * stallMs : 0;
    // driftPerRecordMs: receipt falls further behind with every record and never catches up, with no jitter
    // to break the rise (a slowly growing backlog, or a camera clock running slow): the worst case for
    // the monotonic deques.
    const rx = t0 + trueMs + stall + 30 + (driftPerRecordMs ? k * driftPerRecordMs : (k * 7919) % 40);
    let pts = Math.round((trueMs + stall + stepOffset) * 90);
    if (pts <= lastPts) pts = lastPts + 1; // the transcoder's DTS clamp after a backward step
    lastPts = pts;
    t.mono = rx;
    // One corrupt record an hour ahead: every later record then reads as BACKWARDS against it (R4-2). Only
    // the clock sees it; the fps emulation carries on as if it never happened (it is a hostile input for
    // the structure bounds, not a model of what fps would do with it).
    let sent = k === spikeAt ? pts + 3600 * 90000 : pts;
    if (backEvery && k % backEvery === backEvery - 1) sent = pts - Math.round((2 * 90000) / fps);
    if (!(holeEvery && k % holeEvery === holeEvery - 1)) gen.onRecord({ tap: 'in', n: k, pts: sent });
    const slot = slotOf(pts / 90);
    if (next === null) next = slot;
    while (latest !== null && slot > next) {
      const content = Buffer.alloc(16);
      if (!staticScene) {
        content.writeUInt32LE(pairs ? outN >> 1 : latest.k, 0);
        content.writeUInt32LE(pairs ? 0 : next, 4);
      }
      if (!noOuts && !(outHoleEvery && outN % outHoleEvery === outHoleEvery - 1)) {
        gen.onRecord({ tap: 'out', n: outN, pts: next, checksum: adler0(content) });
      }
      outN += 1;
      if (held && !noSamples) {
        gen.onSample(held, t.mono, t.mono + WALL0 + t.wallStep);
        if (onSample) onSample(t.mono);
      }
      held = content;
      next += 1;
    }
    latest = { k, slot };
    w.tick();
  }
  t.mono += 10_000;
  gen.end('stop');
  return { ...w.final(), outs: outN };
}

// --- sound ----------------------------------------------------------------------------------------------
function runSound({ hours, packetSamples = 8000, windowSeconds = 1, rate = 8000, holeEvery = 0, stallEvery = 0, stallMs = 0, stepEvery = 0, noSamples = false, driftPerRecordMs = 0, silentEvery = 0, noTimer = false }) {
  const { t, clock } = makeClock('sound');
  const gen = clock.beginGeneration({ path: 'growth', windowSeconds });
  const w = watcher(clock, t, { noTimer });
  const pktMs = (packetSamples / rate) * 1000;
  const total = Math.round((hours * H) / pktMs);
  let media = 0;
  let windows = 0;
  let stepSign = 1;
  let stepOffset = 0;
  let lastPts = -1;
  let backlog = 0;
  const t0 = t.mono;
  for (let i = 0; i < total; i += 1) {
    if (stallEvery && i > 0 && i % stallEvery === 0) backlog = stallMs; // a lossless hold: everything late
    if (stepEvery && i > 0 && i % stepEvery === 0) {
      t.wallStep += 900 * stepSign;
      stepOffset += 900 * stepSign;
      stepSign = -stepSign;
    }
    const arrival = i * pktMs + backlog;
    // The held packets drain at 2x until the backlog is gone.
    if (backlog > 0) backlog = Math.max(0, backlog - pktMs / 2);
    let pts = Math.round(((arrival + stepOffset) * rate) / 1000);
    if (pts <= lastPts) pts = lastPts + 1;
    lastPts = pts;
    t.mono = t0 + arrival + 20 + (driftPerRecordMs ? i * driftPerRecordMs : (i * 7919) % 30);
    if (!(holeEvery && i % holeEvery === holeEvery - 1)) {
      gen.onRecord({ tap: 'audio', n: i, pts, ptsTime: pts / rate, rate, nbSamples: packetSamples });
    }
    media += packetSamples / rate;
    while (!noSamples && (windows + 1) * windowSeconds <= media + 1e-9) {
      gen.onSample(Buffer.alloc(0), t.mono, t.mono + WALL0 + t.wallStep, { analysed: !(silentEvery && windows % silentEvery === 0) });
      windows += 1;
    }
    w.tick();
  }
  t.mono += 10_000;
  gen.end('stop');
  return w.final();
}

function assertBounded(max, bounds, label) {
  if (process.env.GROWTH_PRINT) console.log(label, JSON.stringify(max));
  for (const [k, bound] of Object.entries(bounds)) {
    assert.ok((max[k] ?? 0) <= bound, `${label}: ${k} reached ${max[k]} (bound ${bound})`);
  }
}

// The bounds, derived from the planted rates (NOT from the module's constants). At 2 inputs/s and 1 output/s:
//   ring      10 s of inputs (20), or 30 s when out records go unmatched and hold the oldest slot (60)  -> 80
//   outs      30 s of unmatched out records (30), or a 9 s stall's clone burst                          -> 40
//   pending   5 s of samples before they finalize (5), plus a burst                                    -> 20
//   intervals 2 x 5 s + 10 s of input pairs (40)                                                        -> 50
//   rxFloor   60 s of records (120) at most; envelope, 1 h of records at most (7,200 at 2/s; the deques'
//             cap, 8,192 since fix round 2 H2, only binds at the real rate — see the real-rate drift test)
//   sampler / analysis: one entry per real gap in a 15-minute period (the holes stream makes ~48)
const MOTION_24H = {
  ring: 80, outs: 40, pending: 20, intervals: 50, holes: 5, reorderedSpans: 2, openRuns: 64, stampBySrc: 64,
  envelope: 10, rxFloor: 130, sampler: 60, analysis: 60, gens: 2, epochs: 64, steps: 64,
};
// Sound at 1 packet/s and 1 s windows: records only from the next one to judge (a 256-record trim batch plus
// a 1 s recover window); discontinuities folded once every window before them is final.
const SOUND_24H = {
  records: 300, disc: 2, pending: 12, refFloor: 70, envelope: 10, rxFloor: 70, sampler: 5, analysis: 5, steps: 64,
};

describe('★ bounded growth over 24 simulated hours (F1)', () => {
  test('motion, a healthy stream', () => {
    const r = runMotion({ hours: 24 });
    assert.ok(r.totals.real > 80_000);
    assertBounded(r.max, MOTION_24H, 'healthy');
  });

  test('motion, input and output record holes', () => {
    const r = runMotion({ hours: 24, holeEvery: 50, outHoleEvery: 70 });
    assertBounded(r.max, MOTION_24H, 'holes');
  });

  test('motion, 9 s stalls every 2 minutes and the clone bursts after them', () => {
    const r = runMotion({ hours: 24, stallEvery: 240, stallMs: 9_000 });
    assertBounded(r.max, MOTION_24H, 'stalls');
  });

  test('motion, a wall-step storm (+-900 ms every 10 s, all day)', () => {
    const r = runMotion({ hours: 24, stepEvery: 20 });
    assert.ok(r.totals.wallSteps > 8000, `${r.totals.wallSteps} steps`);
    assertBounded(r.max, MOTION_24H, 'wall-step storm');
  });

  test('motion, records but NO samples (stdout never delivers)', () => {
    const r = runMotion({ hours: 24, noSamples: true });
    assertBounded(r.max, MOTION_24H, 'no samples');
  });

  test('motion, `in` records but NO `out` records (the out tap never parses)', () => {
    const r = runMotion({ hours: 24, noOuts: true });
    assertBounded(r.max, MOTION_24H, 'no out records');
  });

  // The anchor envelope keeps 1 h of a strictly rising series: 2 inputs/s is 7,200 entries, under the deques'
  // 8,192-entry cap (fix round 2, H2), which binds only in the real-rate drift test below.
  test('motion, receipt drifting later all day with no jitter (the monotonic deques\' worst case)', () => {
    const r = runMotion({ hours: 24, driftPerRecordMs: 0.05 });
    assertBounded(r.max, { ...MOTION_24H, envelope: 7201 }, 'drift');
  });

  test('motion, one corrupt pts an hour ahead (every later record reads as backwards)', () => {
    const r = runMotion({ hours: 24, spikeAt: 1000 });
    assertBounded(r.max, MOTION_24H, 'pts spike');
  });

  test('motion, identical-content PAIRS of records and NO samples: each run ages out like a single record (H1)', () => {
    // Fix round 2, H1: an `out` record now ages from its RELEASE (the record after it arrived), and a run's
    // records from the record after the whole run. Runs of two keep ending here, so their records must keep
    // going 30 s later, as single records do; a run that is never released would pin them to the hard cap.
    const r = runMotion({ hours: 24, pairs: true, noSamples: true });
    assertBounded(r.max, MOTION_24H, 'pairs, no samples');
  });

  // The one regime the release rule cannot age out: an identical-content run that never ends (a frozen
  // picture) while no sample resolves anything pins the oldest slot still to classify, so only the hard caps
  // bound it: 4,000 `in` records, 4,000 `out` records, 256 holes, 256 reordered spans. 3 h at 1 output/s
  // (10,800 records; sizes are sampled hourly) is well past the 4,000 cap.
  const FROZEN_3H = { ring: 4000, outs: 4000, holes: 256, reorderedSpans: 256, openRuns: 1, pending: 0 };

  test('motion, a FROZEN picture with NO samples and every other `in` record lost: holes capped (H1)', () => {
    const r = runMotion({ hours: 3, staticScene: true, noSamples: true, holeEvery: 2 });
    assertBounded(r.max, FROZEN_3H, 'frozen, holes');
    assert.equal(r.max.outs, 4000, 'the regime really is pinned: only the count cap holds the out records');
    assert.ok(r.max.holes > 200, `the scenario really does pile up holes (${r.max.holes})`);
  });

  test('motion, a FROZEN picture for 3 h WITH samples (an encoder wedged on one frame): the work per sample stays bounded (H3)', () => {
    // Every output frame identical while real frames keep arriving: ONE identical-content run with distinct
    // sources, so every sample is UNKNOWN. Phase A rebuilt an array over the whole run for every sample (~432,000
    // entries after a day at 5 fps: quadratic overall, in the detector's callback — Astra review). Counted
    // here, per sample: `out`-record lookups and provenance evaluations. The run's first record leaves the
    // 4,000-record cap after ~67 min at 1 output/s; from then on the run's answer is O(1), so the last hour
    // must cost a few lookups per sample and no provenance at all.
    const w = { gets: 0, evals: 0, maxCall: 0, lastGets: 0, lastEvals: 0, fed: 0, lastFed: 0 };
    let clockT = null;
    const lastHour = () => clockT.mono >= 1_000 + 2 * H; // makeClock starts the clock at 1,000
    const r = runMotion({
      hours: 3,
      staticScene: true,
      onGen: (gen, t) => {
        clockT = t;
        const get = gen.outs.get.bind(gen.outs);
        gen.outs.get = (k) => {
          w.gets += 1;
          if (lastHour()) w.lastGets += 1;
          return get(k);
        };
        const many = gen.provenanceMany.bind(gen);
        gen.provenanceMany = (slots) => {
          w.evals += slots.length;
          if (lastHour()) w.lastEvals += slots.length;
          w.maxCall = Math.max(w.maxCall, slots.length);
          return many(slots);
        };
      },
      onSample: () => {
        w.fed += 1;
        if (lastHour()) w.lastFed += 1;
      },
    });
    assert.equal(r.totals.warn, 0, 'nothing threw');
    assert.equal(r.totals.samples, w.fed, 'every sample was classified');
    assert.equal(r.totals.real, 0, 'a frozen picture of distinct frames: nothing is claimed');
    assert.ok(w.maxCall <= 4000, `one classification asked about ${w.maxCall} records (the out-record cap is 4,000)`);
    assert.equal(w.lastEvals, 0, 'once the run\'s first record is gone, no provenance is computed for it');
    assert.ok(w.lastFed > 3000 && w.lastGets <= 10 * w.lastFed, `${w.lastGets} lookups for ${w.lastFed} samples in the last hour`);
  });

  test('motion, a FROZEN picture with NO samples and a backwards pts every 10 records: reordered spans capped (H1)', () => {
    const r = runMotion({ hours: 3, staticScene: true, noSamples: true, backEvery: 10 });
    assertBounded(r.max, FROZEN_3H, 'frozen, backwards');
    assert.ok(r.max.reorderedSpans > 200, `the scenario really does pile up spans (${r.max.reorderedSpans})`);
  });

  test('sound, a healthy stream', () => {
    const r = runSound({ hours: 24 });
    assert.ok(r.totals.observed > 80_000);
    assertBounded(r.max, SOUND_24H, 'healthy');
  });

  test('sound, record holes (everything after the first is UNKNOWN, and nothing piles up)', () => {
    const r = runSound({ hours: 24, holeEvery: 97 });
    assertBounded(r.max, SOUND_24H, 'holes');
  });

  test('sound, a 9 s lossless hold every 10 minutes (a discontinuity each time)', () => {
    const r = runSound({ hours: 24, stallEvery: 600, stallMs: 9_000 });
    assert.ok(r.totals.gaps > 100, `${r.totals.gaps} discontinuities`);
    assertBounded(r.max, SOUND_24H, 'holds');
  });

  test('sound, a wall-step storm', () => {
    const r = runSound({ hours: 24, stepEvery: 10 });
    assertBounded(r.max, SOUND_24H, 'wall-step storm');
  });

  test('sound, records but NO samples', () => {
    const r = runSound({ hours: 24, noSamples: true });
    assertBounded(r.max, SOUND_24H, 'no samples');
  });

  test('sound, records with a discontinuity every 250 records and NO samples: the discontinuity list is capped (H4)', () => {
    // Astra review (fix round 2, H4): discontinuities fold only once the windows before them are final, so
    // with stdout stalled and stderr flowing every one was kept for the generation's life (~8,600 a day at the
    // real 25 records/s). A 9 s hold every 250 one-second records is 345 discontinuities in a day here.
    const r = runSound({ hours: 24, stallEvery: 250, stallMs: 9_000, noSamples: true });
    assert.ok(r.totals.gaps > 300, `${r.totals.gaps} discontinuities`);
    assertBounded(r.max, { ...SOUND_24H, disc: 256 }, 'discontinuities, no samples');
  });

  test('sound, receipt drifting later all day with no jitter', () => {
    // 1 record/s: 1 h of a rising series is 3,600 envelope entries, under the 8,192 cap.
    const r = runSound({ hours: 24, driftPerRecordMs: 0.05 });
    assertBounded(r.max, { ...SOUND_24H, envelope: 3601 }, 'drift');
  });

  test('sound, alternate windows silent and NO [obs] timer: analysis coverage still capped', () => {
    // Every silent window splits analysis coverage, and without the timer nothing is ever pruned: 43,200
    // disjoint intervals in a day. The cap keeps the newest 10,000.
    const r = runSound({ hours: 24, silentEvery: 2, noTimer: true });
    assertBounded(r.max, { ...SOUND_24H, analysis: 10_000 }, 'silent, no timer');
    assert.ok(r.max.analysis > 9_000, 'the scenario really does split coverage');
  });
});

describe('...and at the REAL rates for 2 simulated hours', () => {
  test('motion at 10 fps in / 5 fps out: ring ~100, out records and pending a few seconds\' worth', () => {
    const r = runMotion({ hours: 2, fps: 5, inFps: 10 });
    assertBounded(r.max, { ring: 110, outs: 40, pending: 30, intervals: 210, envelope: 10, rxFloor: 610, sampler: 5 }, 'real-rate motion');
  });

  test('motion at 10 fps with receipt drifting later all the way: the anchor envelope\'s 8,192-entry cap holds', () => {
    // 36,000 strictly rising envelope entries an hour: the one place the deques' cap binds at a real rate
    // (fix round 2, H2). The 60 s rxFloor holds 600 and never reaches it.
    const r = runMotion({ hours: 2, fps: 5, inFps: 10, driftPerRecordMs: 0.005 });
    assertBounded(r.max, { ring: 110, outs: 40, pending: 30, envelope: 8193, rxFloor: 610 }, 'real-rate drift');
    assert.ok(r.max.envelope > 4000, `the scenario really does fill the envelope (${r.max.envelope})`);
  });

  test('sound at 25 packets/s and 0.2 s windows: a few hundred records at most', () => {
    const r = runSound({ hours: 2, packetSamples: 320, windowSeconds: 0.2 });
    assertBounded(r.max, { records: 300, disc: 2, pending: 30, refFloor: 1510, envelope: 10, rxFloor: 1510, sampler: 5 }, 'real-rate sound');
  });
});

