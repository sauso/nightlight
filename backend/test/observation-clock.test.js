// observationClock.js, the MOTION leg and the clock/registry machinery (issue #373 Stage 2, plan v4 §B-§C,
// §Tests 3, 7). The sound leg is observation-clock-sound.test.js.
//
// ★ INDEPENDENT ORACLES (C7). Two kinds, and every test says which it uses:
//   - CAPTURED: fixtures/obs/fps-slot-*.err are real ffmpeg 8.1.2 runs in which every input frame is unique
//     noise, so an `out` checksum names exactly which input fps emitted into each slot. The R4 tests read
//     that mapping with their own regex and hold the clock to it; the clock never sees those checksums.
//   - PLANTED: every other stream is built by the test (helpers/obsRig.js), so its truth — which frame was
//     real, what was lost, when — is a fact of the fixture, stated next to it.
// Thresholds are tested on BOTH sides with literal values (400 ms, 1000 ms, 50 ms, ...), never with the
// module's exported constants: a fixture derived from a constant moves with it and kills no mutant.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getObservationClock, forgetObservationClocks, sweepIdleClocks, logObservationSummaries, openObservation,
  formatSummaryLine, roundNearInf, startObservationLog, stopObservationLog, ObservationClock, observationHandleFailures,
  _setObservationClockFactoryForTests, _resetObservationClocksForTests,
} from '../src/lib/observationClock.js';
import { motionRig, feedStream, steadyFrames, frameOf, zlibAdler0, makeClock, slotOf90k, WALL0 } from './helpers/obsRig.js';
import { createStderrRouter, buildMotionTaps } from '../src/lib/ffmpegSideChannel.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, 'fixtures', 'obs');
const lines = (name) => fs.readFileSync(path.join(FIX, name), 'utf8').split('\n').filter((l) => l.trim());

beforeEach(() => _resetObservationClocksForTests());

// --- the captured oracle: which input fps put in which output slot -----------------------------------------
function fpsRun(name) {
  const ls = lines(name);
  const tb = /\[showinfo@in @ \S+\] \[info\] config in time_base: (\d+)\/(\d+)/.exec(ls.join('\n'));
  const events = [];
  const inByChecksum = new Map();
  for (const l of ls) {
    const m = /^\[showinfo@(in|out) @ \S+\] \[info\] n: *(\d+) +pts: *(\d+) .*checksum:([0-9A-F]{8}) /.exec(l);
    if (!m) continue;
    const e = { tap: m[1], n: Number(m[2]), pts: Number(m[3]), checksum: m[4] };
    if (e.tap === 'in') inByChecksum.set(e.checksum, e.n);
    events.push(e);
  }
  for (const e of events) if (e.tap === 'out') e.src = inByChecksum.get(e.checksum);
  return { tbNum: Number(tb[1]), tbDen: Number(tb[2]), events, outs: events.filter((e) => e.tap === 'out') };
}

// Replays a captured run into a fresh generation, in ffmpeg's own stderr order, with each output sample
// carrying its (captured) source frame's content and arriving after the next `out` record (CFR hold).
// `dropIn` removes `in` records as a lost record would. Returns observations by output index.
function replayFpsRun(name, { dropIn = [] } = {}) {
  const run = fpsRun(name);
  const rig = motionRig({ tbIn: [run.tbNum, run.tbDen] });
  let at = 100_000;
  const pending = [];
  for (const e of run.events) {
    at += 10;
    if (e.tap === 'in') {
      if (!dropIn.includes(e.n)) rig.inRec(e.n, e.pts, at);
      continue;
    }
    rig.outRec(e.n, e.pts, `S${e.src}`, at);
    if (pending.length) rig.sample(pending.shift(), at + 1);
    pending.push(`S${e.src}`);
  }
  while (pending.length) rig.sample(pending.shift(), at + 2);
  rig.end(at + 3);
  return { run, rig, obs: rig.byIdx() };
}

describe('★ R4: slot-only provenance against real ffmpeg (fixtures/obs/fps-slot-*.err)', () => {
  test('the captures are the runs the plan tabulates (the oracle itself is checked first)', () => {
    const map = (name) => fpsRun(name).outs.map((o) => [o.pts, o.src]);
    assert.deepEqual(map('fps-slot-A.err'), [[0, 1]]);
    assert.deepEqual(map('fps-slot-B.err'), [[0, 0], [1, 2], [2, 4], [3, 6]]);
    assert.deepEqual(map('fps-slot-E.err'), [[0, 0], [1, 2]]);
    assert.deepEqual(map('fps-slot-C.err'), [[0, 0], [1, 0], [2, 2], [3, 2]]);
    assert.deepEqual(map('fps-slot-D.err'), [[0, 0], [1, 1], [2, 1], [3, 1], [4, 1], [5, 1], [6, 1], [7, 1]]);
    // F (added by the v4 build): a final input alone in its slot is NOT emitted at end of stream.
    assert.deepEqual(map('fps-slot-F.err'), [[0, 0], [1, 2], [2, 4]]);
  });

  test('R4-1, run A: two inputs share slot 0 and the LATER one (n1) is the source; n0 is never one', () => {
    const { obs } = replayFpsRun('fps-slot-A.err');
    assert.equal(obs.length, 1);
    assert.equal(obs[0].cls, 'real');
    assert.equal(obs[0].src.n, 1);
  });

  test('R4-1, run E: latest wins, NOT nearest — slot 1 comes from n2 (0.25 s), not n1 (exactly 0.2 s)', () => {
    const { obs } = replayFpsRun('fps-slot-E.err');
    assert.deepEqual(obs.map((o) => [o.cls, o.src && o.src.n]), [['real', 0], ['real', 2]]);
  });

  test('R4-1, run B: half the inputs are never a source; no slot reads REAL from a dropped input', () => {
    const { obs, run } = replayFpsRun('fps-slot-B.err');
    const truth = run.outs.map((o) => o.src);
    for (const [k, o] of obs.entries()) {
      if (o.cls === 'real') assert.equal(o.src.n, truth[k], `slot ${k}`);
      assert.ok(!(o.src && [1, 3, 5].includes(o.src.n)), `slot ${k} names a dropped input`);
    }
    assert.deepEqual(obs.slice(0, 3).map((o) => [o.cls, o.src.n]), [['real', 0], ['real', 2], ['real', 4]]);
  });

  test('R4-3, run B\'s end: the slot fps flushes at end of stream has no later record, so its source is UNKNOWN', () => {
    const { obs } = replayFpsRun('fps-slot-B.err');
    assert.equal(obs[3].cls, 'unknown');
    assert.equal(obs[3].reason, 'source-unproven');
  });

  test('R4-3, run B with its FINAL `in` record lost: that slot is UNKNOWN — not CLONE-FPS, not "REAL from n5"', () => {
    // n5 (0.5 s) and n6 (0.6 s) both round into slot 3 (2.5 rounds away from zero), and fps emitted n6.
    const { obs } = replayFpsRun('fps-slot-B.err', { dropIn: [6] });
    assert.equal(obs[3].cls, 'unknown');
    assert.notEqual(obs[3].src && obs[3].src.n, 5);
  });

  test('R4-3: a generation that ends inside an unbounded clone run leaves those slots UNKNOWN', () => {
    // Planted: `in` records stop at slot 2, but `out` records (and samples) run on to slot 5.
    const rig = motionRig();
    for (let n = 0; n <= 2; n += 1) rig.inRec(n, n * 18000, 100_000 + n * 200);
    for (let k = 0; k <= 5; k += 1) rig.outRec(k, k, `S${Math.min(k, 2)}X${k > 2 ? 'c' : ''}`, 100_700 + k);
    for (let k = 0; k <= 5; k += 1) rig.sample(`S${Math.min(k, 2)}X${k > 2 ? 'c' : ''}`, 100_710 + k);
    rig.end(100_800);
    const o = rig.byIdx();
    assert.deepEqual(o.slice(0, 2).map((x) => x.cls), ['real', 'real']);
    for (const x of o.slice(3)) {
      assert.equal(x.cls, 'unknown');
      assert.equal(x.reason, 'clone-unproven');
    }
  });

  test('R4-2, run C: a backwards input pts makes slots 1..3 UNKNOWN (reordered); slot 1 is not REAL, slot 2 does not name n1', () => {
    const { rig, obs } = replayFpsRun('fps-slot-C.err');
    for (const k of [1, 2, 3]) assert.deepEqual(rig.gen.provenance(k), { cls: 'unknown', reason: 'reordered' });
    assert.equal(rig.gen.provenance(0).cls, 'real');
    for (const o of obs.slice(1)) {
      assert.notEqual(o.cls, 'real');
      assert.ok(!(o.src && o.src.n === 1));
    }
    assert.ok(rig.clock.summary().reordered >= 3, 'counted as reordered=');
  });

  test('R4-2: a forward-only stream shows reordered=0', () => {
    const rig = motionRig();
    const s = feedStream(rig, steadyFrames({ fps: 10, count: 60 }));
    s.flush(130_000);
    rig.end(130_001);
    assert.equal(rig.clock.summary().reordered, 0);
    assert.ok(rig.clock.summary().real > 20);
  });

  test('R4-4, run D: the stall\'s clone run is emitted from the pre-gap frame; with the same-source rule it reads REAL + fps clones', () => {
    const { obs } = replayFpsRun('fps-slot-D.err');
    assert.deepEqual(obs.map((o) => [o.cls, o.src && o.src.n]), [
      ['real', 0], ['real', 1], ['fps-clone', 1], ['fps-clone', 1], ['fps-clone', 1], ['fps-clone', 1], ['fps-clone', 1], ['fps-clone', 1],
    ]);
  });

  test('R4-4: run D stretched past the 10 s ring — every clone slot still names the pre-gap source (never a guess, never a throw)', () => {
    // Planted: n0 at 0, n1 at 0.1 s, then nothing until 12 s. fps emits slots 1..59 from n1 when n2 arrives.
    const rig = motionRig();
    const B = 100_000;
    rig.inRec(0, 0, B);
    rig.inRec(1, 9000, B + 100);
    rig.outRec(0, 0, 'S0', B + 100.1);
    rig.inRec(2, 12 * 90000, B + 12_000);
    for (let k = 1; k <= 59; k += 1) rig.outRec(k, k, 'S1', B + 12_000.1);
    rig.sample('S0', B + 12_000.2);
    for (let k = 1; k <= 58; k += 1) rig.sample('S1', B + 12_000.3);
    rig.inRec(3, 12 * 90000 + 9000, B + 12_100);
    rig.outRec(60, 60, 'S2', B + 12_100.1);
    rig.sample('S1', B + 12_100.2);
    rig.end(B + 20_000);
    const o = rig.byIdx();
    assert.equal(rig.clock.summary().warn, 0, 'nothing threw');
    assert.deepEqual([o[0].cls, o[0].src.n], ['real', 0]);
    assert.deepEqual([o[1].cls, o[1].src.n], ['real', 1]);
    for (const x of o.slice(2, 60)) assert.deepEqual([x.cls, x.src && x.src.n], ['fps-clone', 1]);
  });

  test('R4-4: ...and when the stream carries on while the burst is being finalized, the ring still keeps that source', () => {
    // The shape where pruning actually bites: the burst's samples reach Node over ~1.2 s of reads, and new
    // `in` records keep arriving (and pruning the ring) while those samples finalize one by one. Once the
    // source's own REAL slot is resolved, it is older than the 10 s ring and below every pending slot —
    // exactly what the ring would drop, if it did not keep the current fps source.
    const rig = motionRig();
    const B = 100_000;
    rig.inRec(0, 0, B); // slot 0
    rig.inRec(1, 18000, B + 200); // slot 1: the frame fps will repeat through the stall
    rig.outRec(0, 0, 'S0', B + 200.1);
    // 12 s stall, then 5 fps again from slot 60.
    let n = 2;
    rig.inRec(n, 60 * 18000, B + 12_000); // slot 60: fps emits slots 1..59 (REAL n1, then clones of n1)
    for (let k = 1; k <= 59; k += 1) rig.outRec(k, k, 'S1', B + 12_000.1);
    rig.sample('S0', B + 12_000.2); // released by the CFR hold
    // The burst's 58 remaining frames reach Node 20 ms apart, while the stream carries on.
    let nextIn = B + 12_200;
    let outN = 60;
    for (let k = 1; k <= 58; k += 1) {
      const at = B + 12_000.2 + 20 * k;
      while (nextIn <= at) {
        n += 1;
        rig.inRec(n, (60 + n - 2) * 18000, nextIn);
        rig.outRec(outN, 60 + outN - 60, `N${outN}`, nextIn + 0.1);
        outN += 1;
        nextIn += 200;
      }
      rig.sample('S1', at);
    }
    // ...and on for another 8 s, so records arrive (and prune) while the burst finalizes at +5 s.
    while (nextIn < B + 21_000) {
      n += 1;
      rig.inRec(n, (60 + n - 2) * 18000, nextIn);
      rig.outRec(outN, 60 + outN - 60, `N${outN}`, nextIn + 0.1);
      outN += 1;
      nextIn += 200;
    }
    rig.end(B + 30_000);
    const o = rig.byIdx();
    assert.equal(rig.clock.summary().warn, 0);
    assert.deepEqual([o[1].cls, o[1].src.n], ['real', 1]);
    for (const x of o.slice(2, 59)) assert.deepEqual([x.cls, x.src && x.src.n], ['fps-clone', 1], `burst sample ${x.idx}`);
  });
});

describe('real traces (plan §Tests 4): the oracle is what ffmpeg or the stall proxy recorded, not the clock', () => {
  test('the soak run: the proxy\'s 3 s DROP and 3 s HOLD are exactly the two motion gaps, ~3.05 s each', () => {
    // fixtures/obs/soak-drop-hold.json: the Stage 1 probe's input records (motion before fps) from the soak
    // box, and the stall proxy's OWN log. The proxy log is the oracle for where the faults were and how
    // long; the probe run predates -nostats, so ~1 record in 14 is missing (an n-hole), which the clock
    // must work around rather than read as gaps.
    const fx = JSON.parse(fs.readFileSync(path.join(FIX, 'soak-drop-hold.json'), 'utf8'));
    const r = makeClock('motion', { start: 0, wallOffset: 0 });
    const g = r.clock.beginGeneration({ path: 'soak', fps: 5 });
    g.onConfig({ tap: 'in', dir: 'in', tbNum: fx.motion.tbNum, tbDen: fx.motion.tbDen });
    const found = [];
    let seen = 0;
    for (const [n, pts, mono, wall] of fx.motion.records) {
      r.t.mono = mono;
      r.t.wallOffset = wall - mono;
      g.onRecord({ tap: 'in', n, pts });
      if (r.clock.period.gaps > seen) {
        seen = r.clock.period.gaps;
        found.push({ decidedAtWall: wall, totalMs: r.clock.period.gapMs });
      }
    }
    r.t.mono += 20_000;
    g.end('stop');
    const s = r.clock.summary();
    assert.equal(s.gaps, 2, 'one gap per proxy fault, and no gap from the ~100 lost records');
    // Each gap is decided FINALIZE_MS after the record that ended it, and that record came right after
    // the proxy stopped interfering.
    const { drop, hold } = fx.proxy;
    assert.ok(found[0].decidedAtWall - drop.toWall > 5000 && found[0].decidedAtWall - drop.toWall < 7000, `gap 1 at ${found[0].decidedAtWall - drop.toWall} ms after the DROP ended`);
    assert.ok(found[1].decidedAtWall - hold.toWall > 5000 && found[1].decidedAtWall - hold.toWall < 7000, `gap 2 at ${found[1].decidedAtWall - hold.toWall} ms after the HOLD ended`);
    // Sizes: the proxy's 3 s plus up to one input interval each side (the fakecam runs at 15 fps).
    const g1 = found[0].totalMs;
    const g2 = found[1].totalMs - g1;
    for (const size of [g1, g2]) assert.ok(size > 2900 && size < 3200, `gap ${size} ms vs the proxy's 3 s`);
  });

  test('the same soak run\'s SOUND records (~1 lost in 7): no discontinuity is claimed past the first hole', () => {
    // Regression for a defect this replay found: without the hole guard, every lost ashowinfo record read as a
    // floor rise of one record's worth of samples, and this file produced 22 phantom "gaps".
    const fx = JSON.parse(fs.readFileSync(path.join(FIX, 'soak-drop-hold.json'), 'utf8'));
    const r = makeClock('sound', { start: 0, wallOffset: 0 });
    const g = r.clock.beginGeneration({ path: 'soak' });
    for (const [n, pts, nb, rate, mono] of fx.sound.records) {
      r.t.mono = mono;
      g.onRecord({ tap: 'audio', n, pts, ptsTime: pts / rate, nbSamples: nb, rate });
    }
    r.t.mono += 20_000;
    g.end('stop');
    assert.equal(r.clock.summary().gaps, 0);
  });

  test('the lean capture end to end: real records and real stdout, classes as the v3 capture\'s checksums say', () => {
    // lean-32x18.* is the production tap layout; motion-32x18.err is the SAME input captured with a checksum
    // on every tap, so its `pick` checksums name which input each output slot came from — the oracle.
    const v3 = lines('motion-32x18.err');
    const inSum = new Map();
    const pickSrc = [];
    for (const l of v3) {
      const m = /^\[showinfo@(in|pick) @ \S+\] \[info\] n: *(\d+) .*checksum:([0-9A-F]{8}) /.exec(l);
      if (!m) continue;
      if (m[1] === 'in') inSum.set(m[3], Number(m[2]));
      else pickSrc[Number(m[2])] = inSum.get(m[3]);
    }
    const r = makeClock('motion', { start: 100_000 });
    const g = r.clock.beginGeneration({ path: 'lean', fps: 5 });
    const route = createStderrRouter({ taps: buildMotionTaps({ fps: 5, width: 32, height: 18 }).taps, forward: () => {}, onRecord: (x) => g.onRecord(x), onConfig: (x) => g.onConfig(x) });
    const gray = fs.readFileSync(path.join(FIX, 'lean-32x18.gray'));
    let outSeen = 0;
    for (const l of lines('lean-32x18.err')) {
      r.t.mono += 1;
      route.line(l);
      // A frame reaches stdout once the NEXT `out` record has passed (the CFR hold).
      if (/^\[showinfo@out @ .*\] n: /.test(l)) {
        outSeen += 1;
        const k = outSeen - 2;
        if (k >= 0 && k < 15) g.onSample(gray.subarray(k * 576, (k + 1) * 576), r.t.mono, r.t.mono + WALL0);
      }
    }
    for (let k = outSeen - 1; k < 15; k += 1) g.onSample(gray.subarray(k * 576, (k + 1) * 576), r.t.mono, r.t.mono + WALL0);
    r.t.mono += 10_000;
    g.end('exit');
    const o = [...r.obs].sort((a, b) => a.idx - b.idx);
    assert.equal(o.length, 15);
    for (const x of o) {
      if (x.cls === 'real' || x.cls === 'fps-clone') assert.equal(x.src.n, pickSrc[x.idx], `slot ${x.idx}`);
    }
    // The input skips t=[1.0,1.65]: slots 6-8 repeat input 9 (a clone run). Everything else is real.
    assert.deepEqual(o.slice(5, 9).map((x) => x.cls), ['real', 'fps-clone', 'fps-clone', 'fps-clone']);
    assert.equal(o.filter((x) => x.cls === 'unknown').length, 0, 'the 16th `out` record never got a frame: stream end, not a drop');
    const s = r.clock.summary();
    assert.equal(s.cfrDrop, 0, 'v4 refinement 3: the final unmatched `out` record is not a CFR drop');
    assert.equal(s.cfrDup, 0);
  });
});

describe('integer slots, not pts_time (R2-O10), against real edges one tick either side', () => {
  test('roundNearInf puts every frame of the slot-edge capture where fps put it', () => {
    // fixtures/obs/slot-edges-32x18.err (v3 capture): the `in` and `pick` taps both carry checksums, so the
    // slot fps emitted each input into is read from the capture, then compared with the integer rule.
    const ls = lines('slot-edges-32x18.err');
    const ins = [];
    const picks = [];
    for (const l of ls) {
      const m = /^\[showinfo@(in|pick) @ \S+\] \[info\] n: *(\d+) +pts: *(\d+) .*checksum:([0-9A-F]{8}) /.exec(l);
      if (m) (m[1] === 'in' ? ins : picks).push({ n: Number(m[2]), pts: Number(m[3]), checksum: m[4] });
    }
    let checked = 0;
    for (const p of picks) {
      const src = ins.find((i) => i.checksum === p.checksum);
      // A pick whose source's OWN slot is its slot is where the rule is tested; clones are not.
      if (roundNearInf(src.pts * 5, 90000) === p.pts) checked += 1;
      else assert.ok(roundNearInf(src.pts * 5, 90000) < p.pts, `slot ${p.pts} from n${src.n} must be a clone of an earlier slot`);
    }
    assert.ok(checked >= 8, `only ${checked} real slots checked`);
    // The planted edges (capture.sh): 2.5 -> 3 and 8.5 -> 9 (half AWAY from zero), 1.49994 -> 1, 4.50006 -> 5.
    assert.equal(roundNearInf(45000 * 5, 90000), 3);
    assert.equal(roundNearInf(153000 * 5, 90000), 9);
    assert.equal(roundNearInf(26999 * 5, 90000), 1);
    assert.equal(roundNearInf(81001 * 5, 90000), 5);
    assert.equal(roundNearInf(-45000 * 5, 90000), -3, 'away from zero on the negative side too');
  });

  test('a lost frame one tick inside a slot edge makes that slot UNKNOWN; one tick outside does not', () => {
    // Planted: n0 at slot 0, n1 at pts 26999 (slot 1), n3 at 81001 (slot 5): n2 is lost, so its pts lay in
    // [27000, 81000] -> slots round(1.5)=2 .. round(4.5)=5. Slot 1 is untouched only because 27000 rounds UP.
    const rig = motionRig();
    rig.inRec(0, 0, 100_000);
    rig.inRec(1, 26999, 100_300);
    rig.inRec(3, 81001, 100_900);
    rig.inRec(4, 99000, 101_100);
    for (const t of [2, 3, 4, 5]) assert.equal(rig.gen.provenance(t).reason, 'hole', `slot ${t}`);
    assert.equal(rig.gen.provenance(1).cls, 'real', 'the hole cannot reach slot 1: pts 27000 rounds to 2');
    assert.equal(rig.gen.provenance(1).src.n, 1);
  });

  test('a hole ending EXACTLY on a half-slot edge does not reach that slot: the next record owns it', () => {
    // Planted: n1 lost between n0 (pts 0) and n2 (pts 27000 = slot 1.5, which rounds to 2). The lost frame's
    // pts lay in [1, 26999] -> slots 0..1, never 2: slot 2's input is n2 itself.
    const rig = motionRig();
    rig.inRec(0, 0, 100_000);
    rig.inRec(2, 27000, 100_300);
    rig.inRec(3, 54000, 100_600);
    for (const t of [0, 1]) assert.equal(rig.gen.provenance(t).reason, 'hole', `slot ${t}`);
    assert.equal(rig.gen.provenance(2).cls, 'real');
    assert.equal(rig.gen.provenance(2).src.n, 2);
  });

  test('...and the mirror edge: a hole ending one tick after a half-slot reaches that slot', () => {
    const rig = motionRig();
    rig.inRec(0, 0, 100_000);
    rig.inRec(2, 27001, 100_300); // n1 lost: its pts lay in [1, 27000] -> slots 0 .. round(1.5)=2
    rig.inRec(3, 54000, 100_600);
    rig.inRec(4, 72000, 100_800);
    for (const t of [0, 1, 2]) assert.equal(rig.gen.provenance(t).reason, 'hole', `slot ${t}`);
    assert.equal(rig.gen.provenance(3).cls, 'real');
    assert.equal(rig.gen.provenance(3).src.n, 3);
  });
});

describe('planted motion streams (plan §Tests 3)', () => {
  test('a steady 10 fps stream: every sample REAL, stamped at its source\'s PTS, pipeline age constant', () => {
    const rig = motionRig();
    const frames = steadyFrames({ fps: 10, count: 100, lat: 30 });
    const s = feedStream(rig, frames);
    s.flush(111_000);
    rig.end(111_001);
    const o = rig.byIdx();
    const real = o.filter((x) => x.cls === 'real');
    assert.ok(real.length >= 47, `${real.length} real`);
    // Truth planted by feedStream: slot k's source is input 2k (10 fps into 5), except slot 0 (n0).
    for (const x of real) {
      assert.equal(x.src.n, x.idx === 0 ? 0 : 2 * x.idx);
      assert.equal(x.obsMono - x.bounds[0], 0);
    }
    const spacing = real.slice(1).map((x, i) => x.obsMono - real[i].obsMono);
    for (const d of spacing) assert.ok(Math.abs(d - 200) < 1e-6, `spacing ${d}`);
    assert.ok(real.every((x) => x.obsMono <= x.rxMono));
    assert.equal(o[0].baseline, true);
    assert.equal(o[0].analysed, false);
  });

  test('a CFR dup (a later sample proves the next record was written): CLONE-CFR of the same source, counted once', () => {
    const rig = motionRig();
    const B = 100_000;
    for (let n = 0; n <= 4; n += 1) rig.inRec(n, n * 18000, B + n * 200);
    rig.outRec(0, 0, 'A', B + 200.1);
    rig.outRec(1, 1, 'B', B + 400.1);
    rig.sample('A', B + 400.2);
    rig.sample('A', B + 400.3); // the CFR stage wrote A twice
    rig.outRec(2, 2, 'C', B + 600.1);
    rig.sample('B', B + 600.2);
    rig.outRec(3, 3, 'D', B + 800.1);
    rig.sample('C', B + 800.2);
    rig.end(B + 10_000);
    const o = rig.byIdx();
    assert.deepEqual(o.slice(0, 4).map((x) => [x.cls, x.src && x.src.n]), [['real', 0], ['cfr-clone', 0], ['real', 1], ['real', 2]]);
    assert.equal(o[1].obsMono, o[0].obsMono, 'a repeat carries the stamp of what it repeats');
    assert.equal(rig.clock.summary().cfrDup, 1);
  });

  test('a CFR DROP: a record passed over by a later match (no n-hole) is counted once, and nothing is misattributed', () => {
    const rig = motionRig();
    const B = 100_000;
    for (let n = 0; n <= 4; n += 1) rig.inRec(n, n * 18000, B + n * 200);
    rig.outRec(0, 0, 'A', B + 200.1);
    rig.outRec(1, 1, 'B', B + 400.1);
    rig.sample('A', B + 400.2);
    rig.outRec(2, 2, 'C', B + 600.1);
    // B was produced but never written (the CFR stage dropped it).
    rig.outRec(3, 3, 'D', B + 800.1);
    rig.sample('C', B + 800.2);
    rig.end(B + 10_000);
    const o = rig.byIdx();
    assert.deepEqual(o.map((x) => [x.cls, x.src && x.src.n]), [['real', 0], ['real', 2]]);
    assert.equal(rig.clock.summary().cfrDrop, 1);
    assert.equal(rig.clock.summary().cfrDup, 0);
  });

  test('a CFR dup INSIDE an fps clone run is labelled CLONE-CFR, beyond the run\'s record count', () => {
    // Planted: slots 0..3 REAL, then a stall: slots 4..6 are fps repeats of input 3, and the CFR stage writes
    // one of them twice. Five samples of the same picture for four records: one CFR dup.
    const rig = motionRig();
    const B = 100_000;
    for (let n = 0; n <= 3; n += 1) rig.inRec(n, n * 18000, B + n * 200);
    rig.outRec(0, 0, 'S0', B + 200.1);
    rig.outRec(1, 1, 'S1', B + 400.1);
    rig.sample('S0', B + 400.2);
    rig.outRec(2, 2, 'S2', B + 600.1);
    rig.sample('S1', B + 600.2);
    rig.inRec(4, 7 * 18000, B + 1400); // slot 7: fps emits 3 (REAL n3) and 4..6 (repeats of n3)
    for (let k = 3; k <= 6; k += 1) rig.outRec(k, k, 'S3', B + 1400.1);
    rig.sample('S2', B + 1400.2);
    for (let i = 0; i < 5; i += 1) rig.sample('S3', B + 1400.3 + i);
    rig.inRec(5, 8 * 18000, B + 1600);
    rig.outRec(7, 7, 'S4', B + 1600.1);
    rig.sample('S4', B + 1800);
    rig.inRec(6, 9 * 18000, B + 1800.1);
    rig.outRec(8, 8, 'S5', B + 1800.2);
    rig.end(B + 20_000);
    const o = rig.byIdx();
    assert.deepEqual(o.slice(3, 8).map((x) => [x.cls, x.src.n]), [['real', 3], ['fps-clone', 3], ['fps-clone', 3], ['fps-clone', 3], ['cfr-clone', 3]]);
    assert.equal(rig.clock.summary().cfrDup, 1, 'counted once: labelled, not also netted');
    assert.equal(rig.clock.summary().fpsClone, 3);
  });

  test('an observation is final exactly FINALIZE_MS (5000 ms) after receipt: not at 4999 ms', () => {
    const rig = motionRig();
    const B = 100_000;
    for (let n = 0; n <= 2; n += 1) rig.inRec(n, n * 18000, B + n * 200);
    rig.outRec(0, 0, 'A', B + 400.1);
    rig.outRec(1, 1, 'B', B + 400.2);
    rig.sample('A', B + 1000);
    rig.inRec(3, 3 * 18000, B + 5999);
    assert.equal(rig.obs.length, 0, 'at receipt + 4999 ms it is still open');
    rig.inRec(4, 4 * 18000, B + 6000);
    assert.equal(rig.obs.length, 1, 'at receipt + 5000 ms it is final');
    // ...and evidence arriving after that moment can no longer change it: it was final.
    assert.equal(rig.obs[0].cls, 'real');
  });

  test('R3-3: a repeat whose next record never gets its own sample is UNKNOWN, never CLONE-CFR', () => {
    const rig = motionRig();
    const B = 100_000;
    for (let n = 0; n <= 3; n += 1) rig.inRec(n, n * 18000, B + n * 200);
    rig.outRec(0, 0, 'A', B + 200.1);
    rig.outRec(1, 1, 'B', B + 400.1);
    rig.sample('A', B + 400.2);
    rig.sample('A', B + 400.3);
    rig.end(B + 10_000); // B's sample never came: nothing proves the second A was not B's own content
    const o = rig.byIdx();
    assert.equal(o[1].cls, 'unknown');
    assert.equal(o[1].reason, 'cfr-unproven');
    assert.equal(rig.clock.summary().cfrDup, 0);
  });

  test('R3-3: an identical sample whose record is unparseable is UNKNOWN, never CLONE-CFR', () => {
    const rig = motionRig();
    const B = 100_000;
    for (let n = 0; n <= 4; n += 1) rig.inRec(n, n * 18000, B + n * 200);
    rig.outRec(0, 0, 'A', B + 200.1);
    rig.gen.onParseError('out'); // record 1 arrived garbled
    rig.sample('A', B + 400.2);
    rig.sample('A', B + 400.3);
    rig.outRec(2, 2, 'C', B + 600.1);
    rig.sample('C', B + 600.2);
    rig.end(B + 10_000);
    const o = rig.byIdx();
    assert.equal(o[1].cls, 'unknown');
    assert.notEqual(o[1].cls, 'cfr-clone');
  });

  test('an fps clone run (a stall at a steady 5 fps): the first sample REAL, the repeats fps clones of it', () => {
    const rig = motionRig();
    const frames = [...steadyFrames({ fps: 5, count: 10 }), ...steadyFrames({ fps: 5, count: 10, n0: 10, pts0: 15 * 18000, base: 100_000 + 3000 })];
    const s = feedStream(rig, frames);
    s.flush(120_000);
    rig.end(120_001);
    const o = rig.byIdx();
    // Planted truth: inputs 0..9 at slots 0..9, then nothing until slot 15: fps repeats n9 into 10..14.
    assert.deepEqual(o[9].cls, 'real');
    for (const x of o.slice(10, 15)) assert.deepEqual([x.cls, x.src.n], ['fps-clone', 9]);
    assert.deepEqual([o[15].cls, o[15].src.n], ['real', 10]);
    assert.equal(rig.clock.summary().fpsClone, 5);
  });

  test('a static scene: distinct input frames whose scaled output is identical are REAL per slot, but their samples are ambiguous (R3-2)', () => {
    const rig = motionRig();
    const s = feedStream(rig, steadyFrames({ fps: 5, count: 12 }), { content: (src) => (src >= 3 && src <= 6 ? 'STATIC' : `S${src}`) });
    s.flush(110_000);
    rig.end(110_001);
    for (const t of [3, 4, 5, 6]) assert.equal(rig.gen.provenance(t).cls, 'real', `slot ${t} is a real, distinct frame`);
    const o = rig.byIdx();
    for (const x of o.slice(3, 7)) assert.deepEqual([x.cls, x.reason], ['unknown', 'ambiguous']);
    assert.deepEqual(o.slice(0, 3).map((x) => x.cls), ['real', 'real', 'real']);
    assert.equal(o[7].cls, 'real');
  });

  test('F2: identical records O0,O1 (distinct sources) plus a CFR dup of O0 -> all three ambiguous, dup counted exactly', () => {
    const rig = motionRig();
    const B = 100_000;
    for (let n = 0; n <= 4; n += 1) rig.inRec(n, n * 18000, B + n * 200);
    rig.outRec(0, 0, 'X', B + 200.1);
    rig.outRec(1, 1, 'X', B + 400.1);
    rig.sample('X', B + 400.2);
    rig.outRec(2, 2, 'Y', B + 600.1);
    rig.sample('X', B + 600.2);
    rig.sample('X', B + 600.3);
    rig.outRec(3, 3, 'Z', B + 800.1);
    rig.sample('Y', B + 800.2);
    rig.end(B + 10_000);
    const o = rig.byIdx();
    assert.deepEqual(o.slice(0, 3).map((x) => x.reason), ['ambiguous', 'ambiguous', 'ambiguous']);
    assert.equal(o[3].cls, 'real');
    assert.equal(rig.clock.summary().cfrDup, 1, 'three samples for two records: net +1');
    assert.equal(rig.clock.summary().cfrDrop, 0);
  });

  test('R3-2: records A,A,B with stdout A,A,B -> both A samples ambiguous, not REAL, and net dup/drop 0', () => {
    const rig = motionRig();
    const B = 100_000;
    for (let n = 0; n <= 4; n += 1) rig.inRec(n, n * 18000, B + n * 200);
    rig.outRec(0, 0, 'A', B + 200.1);
    rig.outRec(1, 1, 'A', B + 400.1);
    rig.sample('A', B + 400.2);
    rig.outRec(2, 2, 'B', B + 600.1);
    rig.sample('A', B + 600.2);
    rig.outRec(3, 3, 'C', B + 800.1);
    rig.sample('B', B + 800.2);
    rig.end(B + 10_000);
    const o = rig.byIdx();
    assert.deepEqual(o.slice(0, 2).map((x) => [x.cls, x.reason]), [['unknown', 'ambiguous'], ['unknown', 'ambiguous']]);
    // ...and each carries the run's bounds, not a point: [first source's time, last source's time].
    assert.ok(o[0].bounds[1] - o[0].bounds[0] >= 199, `bounds ${o[0].bounds}`);
    assert.equal(rig.clock.summary().cfrDup, 0);
    assert.equal(rig.clock.summary().cfrDrop, 0);
  });

  test('R3-2: a 10 s identical (static) run with a dup at second 6 — nothing finalized at second 5 is revised', () => {
    const rig = motionRig();
    const B = 100_000;
    const seen = new Map();
    rig.clock.onObservation = (x) => {
      assert.ok(!seen.has(x.idx), `sample ${x.idx} observed twice`);
      seen.set(x.idx, { cls: x.cls, reason: x.reason, at: rig.t.mono });
    };
    // 60 inputs at 5 fps; outputs 1..50 are the same static picture; a CFR dup of output 30 (second 6).
    for (let n = 0; n < 60; n += 1) {
      rig.inRec(n, n * 18000, B + n * 200);
      if (n >= 1) rig.outRec(n - 1, n - 1, n - 1 >= 1 && n - 1 <= 50 ? 'STILL' : `S${n - 1}`, B + n * 200 + 0.1);
      if (n >= 2) rig.sample(n - 2 >= 1 && n - 2 <= 50 ? 'STILL' : `S${n - 2}`, B + n * 200 + 0.2);
      if (n === 32) rig.sample('STILL', B + n * 200 + 0.3);
    }
    const beforeDup = [...seen.entries()].filter(([, v]) => v.at < B + 6400 + 5000).map(([k, v]) => [k, v.cls, v.reason]);
    rig.end(B + 30_000);
    for (const [k, cls, reason] of beforeDup) assert.deepEqual([seen.get(k).cls, seen.get(k).reason], [cls, reason]);
    assert.ok(beforeDup.some(([k]) => k >= 1 && k <= 20), 'some of the run WAS finalized before the dup');
    assert.equal(rig.clock.summary().cfrDup, 1, 'the run reports its net dup once it closes');
  });

  test('F3: a repeated frame that arrives BEFORE its record is not called a CFR dup on arrival', () => {
    // Its record (identical content, so the same checksum) arrives 900 ms later, inside PENDING_MS. Plan v2
    // expected REAL here; since R3-2 two identical consecutive records are ambiguous by definition, so the
    // claim that survives is the one F3 was about: NOT CLONE-CFR, and not decided on arrival.
    const rig = motionRig();
    const B = 100_000;
    for (let n = 0; n <= 4; n += 1) rig.inRec(n, n * 18000, B + n * 200);
    rig.outRec(0, 0, 'A', B + 200.1);
    rig.sample('A', B + 400.2);
    rig.sample('A', B + 400.3);
    assert.equal(rig.obs.length, 0, 'nothing is classified on arrival');
    rig.outRec(1, 1, 'A', B + 1300.3);
    rig.outRec(2, 2, 'C', B + 1300.4);
    rig.sample('C', B + 1300.5);
    rig.end(B + 10_000);
    assert.notEqual(rig.byIdx()[1].cls, 'cfr-clone');
  });

  test('a record that follows its sample: matched at PENDING_MS, not at PENDING_MS + 1 ms', () => {
    for (const [lag, expected] of [[1000, 'real'], [1001, 'unknown']]) {
      const rig = motionRig();
      const B = 100_000;
      for (let n = 0; n <= 3; n += 1) rig.inRec(n, n * 18000, B + n * 200);
      rig.sample('A', B + 400);
      rig.outRec(0, 0, 'A', B + 400 + lag);
      rig.outRec(1, 1, 'B', B + 400 + lag + 0.1);
      rig.sample('B', B + 400 + lag + 0.2);
      rig.outRec(2, 2, 'C', B + 400 + lag + 0.3);
      rig.end(B + 20_000);
      assert.equal(rig.byIdx()[0].cls, expected, `record ${lag} ms after its sample`);
    }
  });

  test('F12: static frames at 0, 0.2 and 0.4 with the middle `in` record missing -> slot 0.2 UNKNOWN, not CLONE-FPS', () => {
    const rig = motionRig();
    const B = 100_000;
    rig.inRec(0, 0, B);
    rig.inRec(2, 36000, B + 400); // n1 (0.2 s) lost
    rig.inRec(3, 54000, B + 600);
    rig.outRec(0, 0, 'S', B + 400.1);
    rig.outRec(1, 1, 'S', B + 400.2);
    rig.outRec(2, 2, 'S', B + 600.1);
    for (let i = 0; i < 3; i += 1) rig.sample('S', B + 600.2 + i);
    rig.end(B + 10_000);
    assert.equal(rig.gen.provenance(1).cls, 'unknown');
    assert.notEqual(rig.gen.provenance(1).cls, 'fps-clone');
    for (const x of rig.byIdx()) assert.notEqual(x.cls, 'fps-clone');
  });

  test('an n-hole makes the slots its lost frames could have held UNKNOWN, and only those', () => {
    const rig = motionRig();
    const frames = steadyFrames({ fps: 5, count: 12 }).filter((f) => f.n !== 5);
    const s = feedStream(rig, frames);
    s.flush(110_000);
    rig.end(110_001);
    // Planted: input 5 (pts 90000, slot 5) lost. Its pts lay in [72001, 107999] -> slots 4 (rounds 4.00006
    // down) .. 6: slot 4's REAL frame n4 could have been replaced by a later one in the same slot.
    for (const t of [4, 5, 6]) assert.equal(rig.gen.provenance(t).reason, 'hole', `slot ${t}`);
    for (const t of [3, 7]) assert.equal(rig.gen.provenance(t).cls, 'real', `slot ${t}`);
  });

  test('a startup burst (14 samples within 5 ms, PTS spread 2.8 s) is stamped spread out, not collapsed', () => {
    const rig = motionRig();
    const B = 100_000;
    // Planted: the first 15 inputs reach Node together at B + 3000 (the transcoder's startup burst), then
    // the stream runs normally.
    const burst = steadyFrames({ fps: 5, count: 15 }).map((f, i) => ({ ...f, rx: B + 3000 + i * 0.3 }));
    const rest = steadyFrames({ fps: 5, count: 40, n0: 15, pts0: 15 * 18000, base: B + 3000, lat: 30 });
    const s = feedStream(rig, [...burst, ...rest]);
    s.flush(B + 20_000);
    rig.end(B + 20_001);
    const o = rig.byIdx().slice(0, 14);
    assert.ok(o.every((x) => x.cls === 'real'));
    for (let k = 1; k < o.length; k += 1) assert.ok(Math.abs(o[k].obsMono - o[k - 1].obsMono - 200) < 1e-6, `burst sample ${k}`);
    assert.ok(o.every((x) => x.obsMono <= x.rxMono), 'causality: nothing stamped after it was received');
  });

  test('motion gaps: at 15 fps the 0.4 s floor binds — 400 ms + 1 tick is a gap, exactly 400 ms is not', () => {
    for (const [extraTicks, gaps] of [[1, 1], [0, 0]]) {
      const rig = motionRig();
      const a = steadyFrames({ fps: 15, count: 150 });
      const last = a[a.length - 1];
      const jump = 36000 + extraTicks; // 400 ms at 90 kHz, plus one tick
      const b = steadyFrames({ fps: 15, count: 150, n0: 150, pts0: last.pts + jump, base: last.rx - 30 + jump / 90 });
      feedStream(rig, [...a, ...b]).flush(200_000);
      rig.end(200_001);
      assert.equal(rig.clock.summary().gaps, gaps, `a ${jump}-tick jump`);
    }
  });

  test('motion gaps: at 5 fps GAP_FACTOR binds — 1000 ms + 1 tick is a gap, exactly 1000 ms is not', () => {
    for (const [extraTicks, gaps] of [[1, 1], [0, 0]]) {
      const rig = motionRig();
      const a = steadyFrames({ fps: 5, count: 60 });
      const last = a[a.length - 1];
      const jump = 90000 + extraTicks;
      const b = steadyFrames({ fps: 5, count: 60, n0: 60, pts0: last.pts + jump, base: last.rx - 30 + jump / 90 });
      feedStream(rig, [...a, ...b]).flush(200_000);
      rig.end(200_001);
      assert.equal(rig.clock.summary().gaps, gaps, `a ${jump}-tick jump`);
    }
  });

  test('R3-6: 15 -> 2 fps within one generation is a rate change (0 gaps, full sampler coverage); a 3 s outage at 15 fps is a gap', () => {
    const rig = motionRig();
    const fast = steadyFrames({ fps: 15, count: 150 }); // 10 s
    const last = fast[fast.length - 1];
    const slow = steadyFrames({ fps: 2, count: 20, n0: 150, pts0: last.pts + 45000, base: last.rx - 30 + 500 }); // 10 s
    feedStream(rig, [...fast, ...slow]).flush(last.rx + 11_000);
    rig.t.mono = last.rx + 11_000;
    const sum = rig.clock.summary(last.rx + 11_000 + 5000);
    assert.equal(sum.gaps, 0);
    rig.end(last.rx + 20_000);

    const rig2 = motionRig();
    const a = steadyFrames({ fps: 15, count: 150 });
    const l2 = a[a.length - 1];
    const b = steadyFrames({ fps: 15, count: 150, n0: 150, pts0: l2.pts + 3 * 90000, base: l2.rx - 30 + 3000 });
    feedStream(rig2, [...a, ...b]).flush(200_000);
    rig2.end(200_001);
    assert.equal(rig2.clock.summary().gaps, 1);
    assert.ok(Math.abs(rig2.clock.summary().gapMs - 3000) < 1);
  });

  test('R3-6: sampler coverage follows the same threshold — healthy 2 fps intervals are covered', () => {
    const rig = motionRig({ start: 100_000 });
    const frames = steadyFrames({ fps: 2, count: 60, base: 100_000 }); // 30 s at 2 fps
    feedStream(rig, frames).flush(130_500);
    rig.end(130_501);
    // Covered from the first REAL source to the last: the 29 s the samples span out of 30 s of input.
    const cover = rig.clock.sampler.measure(100_000, 131_000);
    assert.ok(cover > 28_000, `covered ${cover} ms`);
  });
});

describe('the anchor: causality, spacing and the 1 h envelope (C1, R1-F10, R3-1)', () => {
  // A steady 5 fps stream whose DELIVERY to Node falls `backlogMs` behind from input `backlogFrom` on, and
  // catches up at the moment input `clearAt` would normally have arrived: everything still queued then
  // arrives in one burst at that moment, and later inputs arrive on time. (Receipt time never runs back.)
  function backlogRun({ minutes, backlogFrom, backlogMs, clearAt }) {
    const rig = motionRig();
    const B = 100_000;
    const count = Math.round(minutes * 60 * 5);
    const normal = (k) => B + k * 200 + 30;
    const M = normal(clearAt);
    const anchor = [];
    const record = rig.clock.onObservation;
    rig.clock.onObservation = (o) => { record(o); if (o.cls === 'real') anchor.push({ src: o.src.ms, A: rig.gen.A }); };
    let pend = [];
    let outN = 0;
    for (let k = 0; k < count; k += 1) {
      let rx = normal(k);
      if (k >= backlogFrom && normal(k) <= M) rx = Math.min(normal(k) + backlogMs, M);
      rig.inRec(k, k * 18000, rx);
      if (k >= 1) {
        rig.outRec(outN, outN, `S${outN}`, rx + 0.1);
        if (pend.length) rig.sample(pend.shift(), rx + 0.2);
        pend.push(`S${outN}`);
        outN += 1;
      }
    }
    for (const c of pend) rig.sample(c, B + count * 200 + 10_000);
    pend = [];
    rig.end(B + count * 200 + 20_000);
    return Object.assign(rig.byIdx().filter((x) => x.cls === 'real'), { anchor });
  }

  test('an 8 s backlog SHORTER than 1 h: stamps keep their 200 ms spacing through it and through its clearing', () => {
    const real = backlogRun({ minutes: 3, backlogFrom: 300, backlogMs: 8000, clearAt: 600 });
    for (let i = 1; i < real.length; i += 1) {
      assert.ok(real[i].obsMono >= real[i - 1].obsMono, 'ordered');
      assert.ok(Math.abs(real[i].obsMono - real[i - 1].obsMono - 200) < 1e-6, `spacing at ${real[i].idx}`);
      assert.ok(real[i].obsMono <= real[i].rxMono);
    }
    assert.equal(real.filter((x) => x.compressed).length, 0);
  });

  test('the same backlog held PAST the 1 h window: ordered, <= rx, spacing within +-10% while the anchor slews, and the clearing burst flagged compressed', () => {
    // 65.5 minutes: the backlog outlives the 1 h window by ~2 min, then 2.5 min of normal stream to converge.
    const real = backlogRun({ minutes: 65.5, backlogFrom: 300, backlogMs: 8000, clearAt: 300 + 5 * 60 * 62 });
    let maxDev = 0;
    for (let i = 1; i < real.length; i += 1) {
      const d = real[i].obsMono - real[i - 1].obsMono;
      assert.ok(d >= 0, `ordered at ${real[i].idx}`);
      assert.ok(real[i].obsMono <= real[i].rxMono, `causal at ${real[i].idx}`);
      if (!real[i].compressed && !real[i - 1].compressed && real[i].idx === real[i - 1].idx + 1) maxDev = Math.max(maxDev, Math.abs(d - 200));
    }
    assert.ok(maxDev <= 20 + 1e-6, `spacing moved by ${maxDev} ms (ANCHOR_SLEW 0.1 x 200 ms)`);
    assert.ok(real.some((x) => x.compressed), 'the clearing burst could only be stamped at its receipt');
    // ...and the anchor moves at EXACTLY 0.1 x source time while it corrects, both up (as the pre-backlog
    // minimum leaves the 1 h window) and down (after the clear): 20 ms per 200 ms frame, then it settles.
    // That rate is ANCHOR_SLEW's whole meaning (plan: "an 8 s correction converges in 80 s").
    const steps = [];
    for (let i = 1; i < real.anchor.length; i += 1) {
      const d = real.anchor[i].A - real.anchor[i - 1].A;
      if (Math.abs(d) > 1e-6) steps.push({ d, dsrc: real.anchor[i].src - real.anchor[i - 1].src });
    }
    const up = steps.filter((s) => s.d > 0);
    const down = steps.filter((s) => s.d < 0);
    assert.ok(up.length > 300 && down.length > 300, `${up.length} up / ${down.length} down steps`);
    // All but the last step each way (the one that lands on the target) are full-rate.
    for (const s of [...up.slice(0, -1), ...down.slice(0, -1)]) assert.ok(Math.abs(Math.abs(s.d) - 0.1 * s.dsrc) < 1e-6, `step ${s.d} over ${s.dsrc} ms`);
  });
});

describe('wall clock (C4): epochs, steps, and UTC that never goes backwards', () => {
  test('a (wall - mono) change of 51 ms opens an epoch; 50 ms does not', () => {
    for (const [step, expected] of [[50, 0], [51, 1]]) {
      const rig = motionRig();
      rig.inRec(0, 0, 100_000);
      rig.t.wallOffset += step;
      rig.inRec(1, 18000, 100_200);
      assert.equal(rig.clock.summary().wallSteps, expected, `${step} ms`);
    }
  });

  function stepRun(stepMs, { lossMs = 0 } = {}) {
    // Planted: 5 fps for 20 s; at input 50 the HOST clock steps by stepMs. The transcoder stamps packets with
    // the wall clock, so from that input on PTS moves by stepMs too — except that after a BACKWARD step it
    // clamps DTS, giving near-equal PTS for |step|. `lossMs` of real media is lost at the same moment.
    const rig = motionRig();
    const B = 100_000;
    let outN = 0;
    const pend = [];
    let lastPts = 0;
    for (let k = 0; k < 100; k += 1) {
      const lost = k >= 50 && lossMs > 0 ? lossMs : 0;
      const rx = B + k * 200 + 30 + lost;
      if (k === 50) rig.t.wallOffset += stepMs;
      let pts = k * 18000 + (k >= 50 ? (stepMs + lost) * 90 : 0);
      if (stepMs < 0 && k >= 50 && pts <= lastPts) pts = lastPts + 1; // the DTS clamp
      lastPts = pts;
      rig.inRec(k, pts, rx);
      if (k >= 1) {
        rig.outRec(outN, outN, `S${outN}`, rx + 0.1);
        if (pend.length) rig.sample(pend.shift(), rx + 0.2);
        pend.push(`S${outN}`);
        outN += 1;
      }
    }
    for (const c of pend) rig.sample(c, B + 30_000);
    rig.end(B + 40_000);
    return rig;
  }

  test('+900 ms: one WALL-STEP, never a gap; UTC jumps with the host clock and never goes back', () => {
    const rig = stepRun(900);
    const s = rig.clock.summary();
    assert.equal(s.wallSteps, 1);
    assert.equal(s.gaps, 0);
    assert.ok(rig.logs.some((l) => /WALL-STEP \+900ms/.test(l)));
    const o = rig.byIdx().filter((x) => x.obsWall !== null);
    for (let i = 1; i < o.length; i += 1) assert.ok(o[i].obsWall >= o[i - 1].obsWall, `UTC went back at ${o[i].idx}`);
  });

  test('-900 ms: UTC never goes backwards within the generation, and the DTS-clamped frames are flagged', () => {
    const rig = stepRun(-900);
    const o = rig.byIdx().filter((x) => x.obsWall !== null);
    for (let i = 1; i < o.length; i += 1) assert.ok(o[i].obsWall >= o[i - 1].obsWall, `UTC went back at ${o[i].idx}`);
    assert.equal(rig.clock.summary().wallSteps, 1);
    assert.equal(rig.clock.summary().gaps, 0, 'the step itself is not a gap');
  });

  test('C4: a DTS-clamped frame (stamped by its receipt) that reached Node 300 ms late cannot make the next stamp earlier', () => {
    // Planted: 5 fps; a -900 ms host step at input 50, after which the transcoder clamps DTS, so inputs 50-53
    // carry PTS one tick apart (all in slot 49; fps keeps the latest, input 53). Their times cannot be
    // trusted, so the slot-49 sample is stamped at input 53's RECEIPT — and input 53 arrived 300 ms late,
    // later than input 54's properly anchored time. The no-reorder clamp is what keeps order here.
    const rig = motionRig();
    const B = 100_000;
    const inRec = rig.inRec;
    rig.inRec = (n, pts, at) => {
      if (n === 50) rig.t.wallOffset -= 900; // the host clock steps back as input 50 arrives
      inRec(n, pts, at);
    };
    let lastPts = 0;
    const frames = [];
    for (let k = 0; k < 100; k += 1) {
      let pts = k * 18000 + (k >= 50 ? -900 * 90 : 0);
      if (k >= 50 && pts <= lastPts) pts = lastPts + 1; // the DTS clamp
      lastPts = pts;
      frames.push({ n: k, pts, rx: B + k * 200 + 30 + (k === 53 ? 300 : 0) });
    }
    // fps emits slot 49 only when input 54 (slot 50) arrives, and the CFR hold releases it a frame later.
    feedStream(rig, frames).flush(B + 30_000);
    rig.end(B + 40_000);
    const o = rig.byIdx();
    assert.deepEqual([o[49].cls, o[49].src.n, o[49].uncertain], ['real', 53, true]);
    assert.equal(o[49].obsMono, B + 53 * 200 + 30 + 300, 'stamped at its (late) receipt');
    assert.equal(o[50].obsMono, o[49].obsMono, 'the next stamp is held, not earlier');
    const stamped = o.filter((x) => x.obsMono !== null);
    for (let i = 1; i < stamped.length; i += 1) assert.ok(stamped[i].obsMono >= stamped[i - 1].obsMono, `reordered at ${stamped[i].idx}`);
    assert.equal(rig.clock.summary().clamps, 1, 'and the clamp is counted');
  });

  test('R3-3\': +900 step with a real 900 ms loss reads as ONE 0.9 s gap, not 1.8 s', () => {
    const rig = stepRun(900, { lossMs: 900 });
    const s = rig.clock.summary();
    assert.equal(s.gaps, 1);
    assert.ok(Math.abs(s.gapMs - 1100) < 1, `gap ${s.gapMs} (900 ms lost + the 200 ms frame interval)`);
  });

  test('R3-3\': -900 step with a real 900 ms loss (their PTS effects cancel) still reads as a 0.9 s gap', () => {
    const rig = stepRun(-900, { lossMs: 900 });
    const s = rig.clock.summary();
    assert.equal(s.gaps, 1);
    assert.ok(Math.abs(s.gapMs - 1100) < 1, `gap ${s.gapMs}`);
  });

  test('R3-7: a frame observed before a +900 ms step but delivered after it keeps the OLD epoch\'s offset', () => {
    const rig = motionRig();
    const B = 100_000;
    for (let k = 0; k < 30; k += 1) rig.inRec(k, k * 18000, B + k * 200 + 30);
    for (let k = 0; k < 28; k += 1) rig.outRec(k, k, `S${k}`, B + (k + 1) * 200 + 30.1);
    for (let k = 0; k < 20; k += 1) rig.sample(`S${k}`, B + (k + 2) * 200 + 30.2);
    // The step lands here: the next sample's SOURCE (input 20, observed at B + 4000) was received before it.
    rig.t.wallOffset += 900;
    rig.sample('S20', B + 6000);
    rig.end(B + 20_000);
    const o = rig.byIdx()[20];
    assert.equal(o.cls, 'real');
    assert.equal(o.obsWall - o.obsMono, WALL0, 'the offset of the epoch that CONTAINS the observation');
  });
});

describe('generations and continuity (C3, R1-F1, R1-F7, R1-F13, R3-4, R3-5)', () => {
  function genWith(clockRig, { base, count }) {
    const g = clockRig.clock.beginGeneration({ path: 'cam-sub', fps: 5 });
    g.onConfig({ tap: 'in', dir: 'in', tbNum: 1, tbDen: 90000 });
    g.onConfig({ tap: 'out', dir: 'in', tbNum: 1, tbDen: 5 });
    const pend = [];
    for (let k = 0; k < count; k += 1) {
      clockRig.t.mono = base + k * 200 + 30;
      g.onRecord({ tap: 'in', n: k, pts: k * 18000 });
      if (k >= 1) {
        clockRig.t.mono += 0.1;
        g.onRecord({ tap: 'out', n: k - 1, pts: k - 1, checksum: zlibAdler0(frameOf(`G${base}-${k - 1}`)) });
        if (pend.length) g.onSample(frameOf(pend.shift()), clockRig.t.mono + 0.1, clockRig.t.mono + WALL0);
        pend.push(`G${base}-${k - 1}`);
      }
    }
    return { g, pend };
  }

  test('F7: samples that drain after "exit" are counted in their own generation; after end() they are late', () => {
    const r = makeClock('motion');
    const { g, pend } = genWith(r, { base: 100_000, count: 20 });
    // 'exit' has fired (no call here: the clock never sees it); stdout keeps draining; then 'close'.
    r.t.mono = 104_500;
    for (const c of pend.splice(0)) g.onSample(frameOf(c), r.t.mono, r.t.mono + WALL0);
    const before = r.obs.length;
    g.end('exit', { code: 0 });
    assert.equal(r.obs.length - before, r.obs.filter((x) => x.gen === g.id).length - before);
    assert.equal(r.obs.filter((x) => x.gen === g.id).length, 19, 'every drained frame counted, in generation 1');
    g.onSample(frameOf('late'), 104_600, 104_600 + WALL0);
    g.end('exit');
    assert.equal(r.clock.summary().late, 2);
  });

  test('F7: a replacement generation that begins before the old one closes is independent', () => {
    const r = makeClock('motion');
    const one = genWith(r, { base: 100_000, count: 30 });
    const two = genWith(r, { base: 200_000, count: 30 });
    assert.notEqual(one.g.id, two.g.id);
    r.t.mono = 206_000;
    for (const c of one.pend.splice(0)) one.g.onSample(frameOf(c), r.t.mono, r.t.mono + WALL0);
    one.g.end('stop');
    two.g.end('exit');
    const byGen = (id) => r.obs.filter((x) => x.gen === id);
    assert.equal(byGen(one.g.id).length, 29);
    assert.equal(byGen(two.g.id).length, 28);
    assert.ok(byGen(two.g.id).every((x) => x.cls !== 'unknown' || x.reason === 'source-unproven'), 'generation 2 unaffected by 1\'s late bytes');
  });

  test('F1: exit, a 64 s outage, a relaunch -> ONE RESTART discontinuity of 64 s (+- one frame)', () => {
    const r = makeClock('motion');
    const one = genWith(r, { base: 100_000, count: 50 });
    r.t.mono = 110_000;
    for (const c of one.pend.splice(0)) one.g.onSample(frameOf(c), r.t.mono, r.t.mono + WALL0);
    one.g.end('exit', { code: 0 });
    // Generation 1's last observation is its last REAL source, input 48 (at 100_000 + 48*200 + 30).
    const two = genWith(r, { base: 100_000 + 49 * 200 + 64_000, count: 50 });
    r.t.mono = 200_000;
    for (const c of two.pend.splice(0)) two.g.onSample(frameOf(c), r.t.mono, r.t.mono + WALL0);
    two.g.end('stop');
    const s = r.clock.summary();
    assert.equal(s.restarts, 1);
    assert.ok(Math.abs(s.restartMs - 64_200) <= 200, `restart ${s.restartMs} ms`);
  });

  test('R3-4: the old generation drains a sample AFTER the new one\'s first finalization -> the interval start moves, nothing is lost', () => {
    const r = makeClock('motion');
    const one = genWith(r, { base: 100_000, count: 30 });
    const two = genWith(r, { base: 110_000, count: 40 }); // its first samples finalize at ~115_000
    r.t.mono = 118_000;
    two.g.onRecord({ tap: 'in', n: 40, pts: 40 * 18000 }); // advances generation 2 past its first finalization
    assert.equal(r.clock.summary().restarts, 0, 'provisional while generation 1 is still open');
    const heldBack = one.pend.splice(0);
    for (const c of heldBack) one.g.onSample(frameOf(c), 118_001, 118_001 + WALL0);
    one.g.end('exit', { code: 0 });
    assert.equal(r.obs.filter((x) => x.gen === one.g.id).length, 29, 'the late samples are generation 1\'s');
    const s = r.clock.summary();
    assert.equal(s.restarts, 1);
    // Generation 1's last source is input 28 (~105_630); generation 2's first REAL source is input 0 (110_030).
    assert.ok(Math.abs(s.restartMs - 4400) < 1, `restart ${s.restartMs}`);
  });

  test('F13: the reconcile race (start -> stop -> start, no settings change) gets the SAME clock back', () => {
    const a = getObservationClock('cam-x', 'sound');
    const b = getObservationClock('cam-x', 'sound');
    assert.equal(a, b);
    assert.notEqual(getObservationClock('cam-x', 'motion'), a);
  });

  test('R3-5: a 70-minute outage past the idle sweep -> one RESTART from the tombstone; generation numbers keep rising', () => {
    const t = { mono: 100_000 };
    const clocks = { monoNow: () => t.mono, wallNow: () => t.mono + WALL0 };
    const clock = getObservationClock('cam-r35', 'motion', { clocks });
    const r = { clock, t, obs: [] };
    const one = genWith(r, { base: 100_000, count: 30 });
    t.mono = 110_000;
    for (const c of one.pend.splice(0)) one.g.onSample(frameOf(c), t.mono, t.mono + WALL0);
    one.g.end('stop');
    t.mono = 110_000 + 3_600_000 - 1;
    sweepIdleClocks();
    assert.equal(getObservationClock('cam-r35', 'motion', { clocks }), clock, 'one ms short of an hour idle: kept');
    t.mono = 110_000 + 3_600_000;
    sweepIdleClocks();
    const again = getObservationClock('cam-r35', 'motion', { clocks });
    assert.notEqual(again, clock, 'swept after an hour');
    t.mono = 100_000 + 70 * 60_000;
    const r2 = { clock: again, t };
    const two = genWith(r2, { base: t.mono, count: 40 });
    assert.ok(two.g.id > one.g.id, 'module-level numbering');
    t.mono += 20_000;
    two.g.end('exit');
    const s = again.summary();
    assert.equal(s.restarts, 1);
    assert.ok(s.restartMs > 69 * 60_000 && s.restartMs < 71 * 60_000, `restart ${s.restartMs}`);
    // The close reason crosses the eviction too: the interval is explained by the swept clock's last stop.
    assert.deepEqual([two.g.restartInfo.reason, two.g.restartInfo.code], ['stop', null]);
  });

  test('camera delete forgets the clocks AND the tombstones', () => {
    const t = { mono: 100_000 };
    const clocks = { monoNow: () => t.mono, wallNow: () => t.mono + WALL0 };
    const clock = getObservationClock('cam-del', 'motion', { clocks });
    const r = { clock, t };
    const one = genWith(r, { base: 100_000, count: 30 });
    t.mono = 110_000;
    one.g.end('stop');
    t.mono += 3_600_000;
    sweepIdleClocks();
    forgetObservationClocks('cam-del');
    const again = getObservationClock('cam-del', 'motion', { clocks });
    const two = genWith({ clock: again, t }, { base: t.mono + 1000, count: 40 });
    t.mono += 20_000;
    two.g.end('exit');
    assert.equal(again.summary().restarts, 0, 'no tombstone, so no continuity to report');
  });
});

describe('fail-safe (R2-O5, C6): nothing a clock does can reach a detector', () => {
  test('an internal throw is caught and counted as warn, and the generation keeps working', () => {
    const rig = motionRig();
    rig.inRec(0, 0, 100_000);
    rig.gen.onSample(null, 100_001, 100_001 + WALL0); // adler32(null) throws inside
    rig.gen.onRecord(null); // so does a missing record
    assert.equal(rig.clock.summary().warn, 2);
    rig.inRec(1, 18000, 100_200);
    assert.equal(rig.clock.summary().warn, 2);
  });

  test('openObservation survives a factory that throws, returns null, or hands back a throwing clock', () => {
    const variants = [
      () => { throw new Error('factory down'); },
      () => null,
      () => ({ beginGeneration() { throw new Error('begin down'); } }),
      () => ({
        receipt() { throw new Error('receipt down'); },
        beginGeneration: () => new Proxy({}, { get: () => () => { throw new Error('method down'); } }),
      }),
    ];
    const failuresBefore = observationHandleFailures();
    for (const f of variants) {
      _setObservationClockFactoryForTests(f);
      const h = openObservation('cam', 'motion', { label: 'Cam', path: 'p' });
      const rx = h.receipt();
      assert.equal(typeof rx.mono, 'number');
      assert.equal(typeof rx.wall, 'number');
      h.onRecord({ tap: 'in', n: 0, pts: 0 });
      h.onConfig({ tap: 'in', dir: 'in', tbNum: 1, tbDen: 90000 });
      h.onParseError('in');
      h.onSample(Buffer.alloc(4), rx.mono, rx.wall);
      h.end('exit', { code: 0 });
    }
    // Factory throw, begin throw, and five method throws from the Proxy clock: every one caught AND counted.
    assert.equal(observationHandleFailures() - failuresBefore, 7);
    _setObservationClockFactoryForTests(null);
    assert.equal(openObservation('cam-real', 'motion', { path: 'p' }).active(), true);
  });

  test('F6: records that arrive but cannot be USED (the `config in` line was lost) are not a healthy side channel', () => {
    // Valid `in` and `out` records, every sample matching its record by content, but no time base for
    // `in`: nothing can be placed in a slot, so every sample is UNKNOWN — and the line must say so.
    const r = makeClock('motion');
    const g = r.clock.beginGeneration({ path: 'cam-sub', fps: 5 });
    g.onConfig({ tap: 'out', dir: 'in', tbNum: 1, tbDen: 5 }); // the `in` config line never arrived
    const B = 100_000;
    for (let k = 0; k < 40; k += 1) {
      r.t.mono = B + k * 200;
      g.onRecord({ tap: 'in', n: k, pts: k * 18000 });
      g.onRecord({ tap: 'out', n: k, pts: k, checksum: zlibAdler0(frameOf(`F${k}`)) });
      if (k > 0) g.onSample(frameOf(`F${k - 1}`), r.t.mono + 0.1, r.t.mono + 0.1 + WALL0);
    }
    r.t.mono = B + 20_000;
    g.end('exit');
    assert.ok(r.obs.length >= 10 && r.obs.every((x) => x.cls === 'unknown'));
    assert.notEqual(r.clock.summary().side, 'ok');
    assert.deepEqual(r.logs.filter((l) => l.includes('side-channel unavailable')), [
      `[obs] "Cam" motion gen=${g.id} side-channel unavailable (tap records arrive but cannot be used); samples are reported UNKNOWN, detection is unaffected`,
    ]);
  });

  test('side channel unavailable: samples are UNKNOWN and ONE line says so per generation', () => {
    const r = makeClock('motion');
    const g = r.clock.beginGeneration({ path: 'cam-sub', fps: 5 });
    for (let k = 0; k < 40; k += 1) g.onSample(frameOf(`X${k}`), 100_000 + k * 200, 100_000 + k * 200 + WALL0);
    r.t.mono = 120_000;
    g.end('exit');
    assert.ok(r.obs.every((x) => x.cls === 'unknown'));
    assert.equal(r.logs.filter((l) => l.includes('side-channel unavailable')).length, 1);
    assert.equal(r.clock.summary().side, 'unavailable');
  });
});

// `side` used to be the last generation's cumulative usable(): once one usable record had arrived it read
// `ok` for the rest of the run, however unusable the stream became. The 0.34.0 release review (Codex,
// 2026-09-28) reproduced it — samples=250 unknown=250 side=ok after the tap lines stopped parsing — and a
// live sound leg printed side=ok beside cover=0.0% for over 18 hours. These drive the REAL [obs] timer body
// (logObservationSummaries), period by period, and read the printed line. PLANTED oracle: which frames had
// usable tap lines is a fact of the fixture.
describe('`side` is judged per [obs] period, from what the samples came out as (0.34.0 release review)', () => {
  const field = (line, name) => new RegExp(` ${name}=(\\S+)`).exec(line)?.[1];

  function periodMotion() {
    const t = { mono: 100_000 };
    const clocks = { monoNow: () => t.mono, wallNow: () => t.mono + WALL0 };
    const logs = [];
    const clock = getObservationClock('cam-side', 'motion', { clocks, label: 'Side Cam', log: (l) => logs.push(l) });
    const open = () => {
      const g = clock.beginGeneration({ path: 'cam-sub', fps: 5 });
      g.onConfig({ tap: 'in', dir: 'in', tbNum: 1, tbDen: 90000 });
      g.onConfig({ tap: 'out', dir: 'in', tbNum: 1, tbDen: 5 });
      return {
        g,
        inRec: (n, pts, at) => { t.mono = at; g.onRecord({ tap: 'in', n, pts }); },
        outRec: (n, slot, c, at) => { t.mono = at; g.onRecord({ tap: 'out', n, pts: slot, checksum: zlibAdler0(frameOf(c)) }); },
        sample: (c, at) => { t.mono = at; g.onSample(frameOf(c), at, at + WALL0); },
      };
    };
    // One [obs] tick at `at`: returns this clock's printed period line.
    const tick = (at) => {
      t.mono = at;
      const before = logs.length;
      logObservationSummaries();
      const printed = logs.slice(before).filter((l) => l.includes(' samples='));
      assert.equal(printed.length, 1, 'one [obs] line per tick');
      return printed[0];
    };
    return { t, clock, open, tick, logs };
  }

  test('motion: tap lines that STOP parsing after a healthy start read side=unavailable for the next full period, and ok again after a relaunch', () => {
    const r = periodMotion();
    const gen1 = r.open();
    // Period 1: one healthy minute (every tap line usable).
    feedStream(gen1, steadyFrames({ fps: 5, count: 300, base: 100_000 })).flush(160_000);
    const p1 = r.tick(160_000);
    assert.equal(field(p1, 'side'), 'ok', p1);

    // From here every `in` and `out` tap line fails the grammar (what ffmpegSideChannel's router reports as
    // onParseError, e.g. after an ffmpeg upgrade changes the format). The pictures still reach stdout.
    let k = 0;
    const broken = (until) => {
      for (; 160_200 + k * 200 <= until; k += 1) {
        gen1.g.onParseError('in');
        gen1.g.onParseError('out');
        gen1.sample(`X${k}`, 160_200 + k * 200);
      }
    };
    // Period 2: it breaks inside the period. The healthy samples still finalizing from period 1 were
    // placed, so this period is `ok` — a PARTIAL loss shows in `unknown`, not in `side`.
    broken(220_000);
    const p2 = r.tick(220_000);
    assert.equal(field(p2, 'side'), 'ok', p2);
    assert.ok(Number(field(p2, 'unknown')) > 0 && Number(field(p2, 'real')) > 0, p2);

    // Period 3: a FULL 15 minutes of nothing but unparseable tap lines — the review's reproduction.
    broken(220_000 + 900_000);
    const p3 = r.tick(220_000 + 900_000);
    const samples = Number(field(p3, 'samples'));
    assert.ok(samples > 4000, `a full period of samples: ${p3}`);
    assert.equal(field(p3, 'unknown'), String(samples), 'every one of them UNKNOWN');
    assert.equal(field(p3, 'cover'), '0.0%/0.0%');
    assert.equal(field(p3, 'side'), 'unavailable', `was side=ok here before the fix: ${p3}`);
    // No internal error was involved, so `warn` rightly stays 0: it counts caught exceptions, not health.
    assert.equal(field(p3, 'warn'), '0');

    // Period 4: the detector relaunches and the new run's lines parse. `side` follows the evidence back.
    r.t.mono = 1_120_100;
    gen1.g.end('exit');
    const gen2 = r.open();
    feedStream(gen2, steadyFrames({ fps: 5, count: 300, base: 1_125_000 })).flush(1_185_000);
    const p4 = r.tick(1_190_000);
    assert.equal(field(p4, 'side'), 'ok', p4);
  });

  test('a frozen picture (new frames, every one identical) reads side=unavailable, and `ambiguous` says why', () => {
    // As documented in KNOWN-ISSUES.md: the tap lines arrive and parse, but distinct input frames that scale
    // to the same picture form one identical-content run (R3-2), so nothing can be placed. PLANTED: every
    // frame's content is the same label; the input records are all distinct, real frames.
    const r = periodMotion();
    const g = r.open();
    feedStream(g, steadyFrames({ fps: 5, count: 300, base: 100_000 }), { content: () => 'FROZEN' }).flush(160_000);
    const line = r.tick(166_000);
    const samples = Number(field(line, 'samples'));
    assert.ok(samples > 250, line);
    assert.equal(field(line, 'unknown'), String(samples), line);
    assert.equal(field(line, 'ambiguous'), String(samples), 'the reason is on the line');
    assert.equal(field(line, 'side'), 'unavailable', line);
  });

  test('a period with records flowing but NO sample finalized reads pending, not ok — there is nothing to judge', () => {
    // The detector's stdout stalled while its stderr tap lines kept coming. The old per-generation answer
    // was `ok` because the records were usable; nothing was placed, and nothing was UNKNOWN either.
    const r = periodMotion();
    const g = r.open();
    for (const f of steadyFrames({ fps: 5, count: 300, base: 100_000 })) {
      g.inRec(f.n, f.pts, f.rx);
      g.outRec(f.n, slotOf90k(f.pts), `S${f.n}`, f.rx + 0.1);
    }
    const line = r.tick(160_000);
    assert.equal(field(line, 'samples'), '0', line);
    assert.equal(field(line, 'side'), 'pending', line);
  });

  test('a clock that never began a generation reads side=none', () => {
    const c = new ObservationClock('cam-never', 'motion', { clocks: { monoNow: () => 100_000, wallNow: () => 100_000 + WALL0 } });
    assert.equal(c.summary().side, 'none');
  });
});

describe('the [obs] summary line and its timer (plan §C, §Tests 7)', () => {
  test('the line carries every documented field, in order', () => {
    const line = formatSummaryLine({
      label: 'Nursery Cam', leg: 'motion', gen: 3, path: 'cam-sub', samples: 4500, real: 4497, fpsClone: 1, cfrDup: 0,
      cfrDrop: 0, runsCapped: 0, unknown: 2, ambiguous: 1, reordered: 0, gaps: 0, gapMs: 0, restarts: 1, restartMs: 64_210,
      coverSampler: 0.999, coverAnalysis: 0.998, ageP50: 335.2, ageP99: 378.6, compressed: 0, clamps: 0,
      uncertain: 0, wallSteps: 0, side: 'ok', warn: 0, late: 0,
    });
    assert.equal(line, '[obs] "Nursery Cam" motion gen=3 path=cam-sub samples=4500 real=4497 fpsClone=1 cfrDup=0 cfrDrop=0 runsCapped=0 unknown=2 ambiguous=1 reordered=0 gaps=0/0.0s restarts=1/64.2s cover=99.9%/99.8% age p50/p99=335/379ms compressed=0 clamps=0 uncertain=0 wallSteps=0 side=ok warn=0 late=0');
    const sound = formatSummaryLine({
      label: 'Nursery', leg: 'sound', gen: 2, path: 'cam', samples: 4500, observed: 4490, silent: 3, unknown: 10,
      gaps: 1, gapMs: 3000, delayed: 2, restarts: 0, restartMs: 0, coverSampler: null, coverAnalysis: null,
      ageP50: null, ageP99: null, compressed: 0, clamps: 0, uncertain: 0, wallSteps: 1, side: 'ok', warn: 0, late: 0,
    });
    assert.equal(sound, '[obs] "Nursery" sound gen=2 path=cam samples=4500 observed=4490 silent=3 unknown=10 gaps=1/3.0s delayed=2 restarts=0/0.0s cover=?/? age p50/p99=?/?ms compressed=0 clamps=0 uncertain=0 wallSteps=1 side=ok warn=0 late=0');
  });

  test('logObservationSummaries writes one line per active clock and starts a new period', () => {
    const t = { mono: 100_000 };
    const clocks = { monoNow: () => t.mono, wallNow: () => t.mono + WALL0 };
    const logs = [];
    const clock = getObservationClock('cam-log', 'motion', { clocks, label: 'Log Cam', log: (l) => logs.push(l) });
    const r = { clock, t };
    const g = clock.beginGeneration({ path: 'cam-sub', fps: 5 });
    g.onConfig({ tap: 'in', dir: 'in', tbNum: 1, tbDen: 90000 });
    g.onConfig({ tap: 'out', dir: 'in', tbNum: 1, tbDen: 5 });
    const s = feedStream({ inRec: (n, pts, at) => { t.mono = at; g.onRecord({ tap: 'in', n, pts }); }, outRec: (n, slot, c, at) => { t.mono = at; g.onRecord({ tap: 'out', n, pts: slot, checksum: zlibAdler0(frameOf(c)) }); }, sample: (c, at) => { t.mono = at; g.onSample(frameOf(c), at, at + WALL0); } }, steadyFrames({ fps: 5, count: 100 }));
    s.flush(125_000);
    t.mono = 130_000;
    logObservationSummaries();
    assert.equal(logs.length, 1);
    assert.match(logs[0], /^\[obs\] "Log Cam" motion gen=\d+ path=cam-sub samples=\d+ real=\d+ /);
    assert.ok(r.clock.summary().samples === 0, 'the period was reset');
  });

  test('startObservationLog is idempotent and stopObservationLog nulls its handle (a restart creates a timer)', () => {
    const made = [];
    const real = globalThis.setInterval;
    globalThis.setInterval = (...a) => { const h = real(...a); made.push(h); return h; };
    try {
      startObservationLog();
      startObservationLog();
      assert.equal(made.length, 1);
      stopObservationLog();
      startObservationLog();
      assert.equal(made.length, 2);
    } finally {
      stopObservationLog();
      globalThis.setInterval = real;
    }
  });
});

describe('coverage (C5) is a union of intervals, and the period denominator excludes what cannot be final yet', () => {
  test('a clean steady stream reads ~100% sampler and analysis coverage for its period', () => {
    const rig = motionRig();
    feedStream(rig, steadyFrames({ fps: 5, count: 600 })).flush(221_000); // 2 minutes
    rig.t.mono = 225_000;
    const s = rig.clock.summary(225_000);
    assert.ok(s.coverSampler > 0.95 && s.coverSampler <= 1, `sampler ${s.coverSampler}`);
    assert.ok(s.coverAnalysis > 0.95 && s.coverAnalysis <= 1, `analysis ${s.coverAnalysis}`);
    assert.ok(s.ageP50 > 300 && s.ageP50 < 500, `age ${s.ageP50}`);
  });

  test('ObservationClock is exported for tests only as a class; its default clocks are the process clocks', () => {
    const c = new ObservationClock('cam-default', 'motion');
    assert.ok(Math.abs(c.monoNow() - performance.now()) < 1000);
    assert.ok(Math.abs(c.wallNow() - Date.now()) < 1000);
  });
});

describe('fix round 1 (Codex review): generations and wall steps stay bounded, with the same answers', () => {
  // A generation that observes: planted 5 fps frames through feedStream, then closed.
  function observingGen(r, base, count, reason = 'exit', code = 0) {
    const g = r.clock.beginGeneration({ path: 'p', fps: 5 });
    g.onConfig({ tap: 'in', dir: 'in', tbNum: 1, tbDen: 90000 });
    g.onConfig({ tap: 'out', dir: 'in', tbNum: 1, tbDen: 5 });
    const rig = {
      inRec: (n, pts, at) => { r.t.mono = at; g.onRecord({ tap: 'in', n, pts }); },
      outRec: (n, slot, c, at) => { r.t.mono = at; g.onRecord({ tap: 'out', n, pts: slot, checksum: zlibAdler0(frameOf(c)) }); },
      sample: (c, at) => { r.t.mono = at; g.onSample(frameOf(c), at, at + WALL0); },
    };
    feedStream(rig, steadyFrames({ fps: 5, count, base })).flush(base + count * 200 + 100);
    r.t.mono = base + count * 200 + 10_000;
    g.end(reason, { code });
    return g;
  }

  test('F2: 20,000 launches that never observe keep `gens` small, and the RESTART after them is still exact', () => {
    const r = makeClock('motion', { start: 100_000 });
    const first = observingGen(r, 100_000, 50);
    const lastObs = first.lastObsMono;
    let peak = 0;
    const started = performance.now();
    for (let i = 0; i < 20_000; i += 1) {
      r.t.mono += 5000; // an offline camera: launch, fail, relaunch 5 s later
      const g = r.clock.beginGeneration({ path: 'p', fps: 5 });
      g.end('exit', { code: 1 });
      peak = Math.max(peak, r.clock.gens.length);
    }
    const tookMs = performance.now() - started;
    assert.ok(peak <= 3, `gens peaked at ${peak}`);
    assert.ok(tookMs < 5000, `20,000 cycles took ${tookMs} ms (loose: a regression here is quadratic, minutes)`);
    // The camera comes back: one RESTART from the first generation's last observation, with the reason and
    // code of the LAST failed launch.
    const back = r.t.mono + 5000;
    const again = observingGen(r, back, 50);
    const s = r.clock.summary(back + 20_000);
    assert.equal(s.restarts, 1);
    assert.ok(Math.abs(again.restartInfo.lo - lastObs) < 1e-6, 'the interval starts at the first generation\'s last observation');
    assert.equal(again.restartInfo.hi, again.firstObsMono);
    assert.deepEqual([again.restartInfo.reason, again.restartInfo.code], ['exit', 1]);
  });

  test('F2: failed launches right after a tombstone fold their close reason into continuity (never lost)', () => {
    const r = makeClock('motion', { start: 100_000, tombstone: { lastObsMono: 90_000, lastReason: 'stop', lastCode: null } });
    for (let i = 0; i < 1000; i += 1) {
      r.t.mono += 5000;
      r.clock.beginGeneration({ path: 'p', fps: 5 }).end('exit', { code: 1 });
    }
    assert.ok(r.clock.gens.length <= 1);
    const g = observingGen(r, r.t.mono + 5000, 50);
    assert.deepEqual([g.restartInfo.lo, g.restartInfo.reason, g.restartInfo.code], [90_000, 'exit', 1]);
  });

  test('F2: ONE failed launch between two good ones does not stop folding, and every RESTART after it is exact', () => {
    // The case the first F2 fix missed (surviving mutant M-R1-18): a generation that never observes never
    // commits, and Phase A folded the front only once gens[1] had committed — so from here on NOTHING folded
    // and the list climbed to the 16 cap. Closed generations at the front now fold unconditionally.
    const r = makeClock('motion', { start: 100_000 });
    let prev = observingGen(r, 100_000, 20);
    r.t.mono += 5000;
    r.clock.beginGeneration({ path: 'p', fps: 5 }).end('exit', { code: 1 });
    let peak = 0;
    for (let i = 0; i < 20; i += 1) {
      const g = observingGen(r, r.t.mono + 5000, 20);
      peak = Math.max(peak, r.clock.gens.length);
      // Each interval runs from the previous generation's last observation; the first one after the failed
      // launch carries ITS reason and code, the rest the clean exits'.
      assert.ok(Math.abs(g.restartInfo.lo - prev.lastObsMono) < 1e-6, `restart ${i} starts at the previous last observation`);
      assert.deepEqual([g.restartInfo.reason, g.restartInfo.code], i === 0 ? ['exit', 1] : ['exit', 0], `restart ${i}`);
      prev = g;
    }
    assert.ok(peak <= 2, `gens peaked at ${peak}`);
    assert.equal(r.clock.summary().restarts, 20);
  });

  test('F2: launches failing BEHIND a hung generation that never exits stay bounded, and the RESTART keeps the last reason', () => {
    // A closed generation cannot fold past an open one (the reason passed on is the last in launch order), so
    // here only the empty-pair rule and the cap can bound the list.
    const r = makeClock('motion', { start: 100_000 });
    const first = observingGen(r, 100_000, 20);
    r.t.mono += 1000;
    const hung = r.clock.beginGeneration({ path: 'p', fps: 5 }); // never observes, never exits (yet)
    let peak = 0;
    for (let i = 0; i < 20_000; i += 1) {
      r.t.mono += 5000;
      r.clock.beginGeneration({ path: 'p', fps: 5 }).end('exit', { code: i === 19_999 ? 7 : 1 });
      peak = Math.max(peak, r.clock.gens.length);
    }
    assert.ok(peak <= 3, `gens peaked at ${peak}`);
    // The camera comes back while the hung process is still "open": its commit waits for the hung one.
    const back = observingGen(r, r.t.mono + 5000, 20);
    assert.equal(back.restartCommitted, false, 'an earlier generation is still open: the interval is provisional (R3-4)');
    r.t.mono += 1000;
    hung.end('exit', { code: 0 });
    assert.equal(back.restartCommitted, true);
    assert.ok(Math.abs(back.restartInfo.lo - first.lastObsMono) < 1e-6);
    // The LAST launch before the good one, in launch order — the failed one with code 7, not the hung one
    // that happened to close later.
    assert.deepEqual([back.restartInfo.reason, back.restartInfo.code], ['exit', 7]);
    assert.equal(r.clock.gens.length, 0, 'everything closed: everything folded');
  });

  test('F3: identical-content runs while alignment fails (A,A,B,B,... and samples that never match): capped, each counted once', () => {
    const rig = motionRig();
    const B = 100_000;
    let peak = 0;
    for (let k = 0; k < 2000; k += 1) {
      rig.inRec(k, k * 18000, B + k * 200);
      rig.outRec(k, k, `P${k >> 1}`, B + k * 200 + 0.1); // pairs of identical records: 1,000 runs of two
      rig.sample(`never-${k}`, B + k * 200 + 0.2); // content that matches no record
      peak = Math.max(peak, rig.gen.openRuns.size);
    }
    assert.ok(peak <= 64, `open runs peaked at ${peak}`);
    rig.end(B + 2000 * 200 + 10_000);
    assert.equal(rig.gen.openRuns.size, 0);
    // Every run closed exactly once. The 936 closed early by the cap report NO net (fix round 2, G2: this
    // test used to assert 1,999 "drops" — every capped run's records counted as drops before any sample
    // could arrive, which is exactly the fabrication G2 removed); they are counted in runsCapped. The 64
    // still open at the end close normally, each netting -2 (two records, no sample attributed), less one:
    // the generation's FINAL record, unmatched at the end, is the stream ending before its frame was written
    // (plan v4 refinement 3). Every sample here is unmatched, which the [obs] line shows as `unknown`.
    const s = rig.clock.summary();
    assert.deepEqual([s.runsCapped, s.cfrDrop, s.cfrDup], [936, 127, 0]);
  });

  test('F1: a window minimum over a strictly rising series, coarsened past its cap, is never ABOVE the true minimum', () => {
    // 16,384 rising values, all inside the 1 h window: the monotonic deque would keep every one; past 8,192
    // (the cap since fix round 2, H2) it merges pairs. The reported minimum must still be the true one (value
    // 0 at key 0) — and once the oldest key expires, too low by at most the series' rise across one merged
    // entry's key span (the bound the H2 comment states), never too high. Here it coarsens twice (at 8,193
    // entries, and again 4,096 pushes later), so the oldest entries span 4 keys of a series rising 1 per key:
    // key 11 holds the value of key 8.
    const g = motionRig().gen;
    for (let i = 0; i < 16_384; i += 1) g.envelope.push(i, i);
    assert.ok(g.envelope.size() <= 8193, `size ${g.envelope.size()}`);
    assert.equal(g.envelope.min(16_383), 0);
    const trueMin = 11; // the window [now - 1 h, now] with now = 1 h + 11 starts at key 11
    const reported = g.envelope.min(3_600_000 + 11);
    assert.ok(reported <= trueMin && reported >= trueMin - 3, `reported ${reported} vs true ${trueMin}`);
  });

  test('F7: 10,000 alternating +-900 ms host steps in one generation: the step list stays tiny and no gap is invented', () => {
    // Planted: 5 fps for ~8.3 simulated hours, a +-900 ms step every 3 s. The transcoder stamps PTS with the
    // wall clock, so each step moves PTS too; after a backward one it clamps DTS (PTS one tick apart).
    const r = makeClock('motion', { start: 100_000 });
    const g = r.clock.beginGeneration({ path: 'p', fps: 5 });
    g.onConfig({ tap: 'in', dir: 'in', tbNum: 1, tbDen: 90000 });
    let offset = 0;
    let sign = 1;
    let lastPts = -1;
    let peak = 0;
    let steps = 0;
    for (let k = 0; steps < 10_000; k += 1) {
      if (k > 0 && k % 15 === 0) {
        offset += 900 * sign;
        r.t.wallOffset += 900 * sign;
        sign = -sign;
        steps += 1;
      }
      let pts = Math.round((k * 200 + offset) * 90);
      if (pts <= lastPts) pts = lastPts + 1;
      lastPts = pts;
      r.t.mono = 100_000 + k * 200 + 30;
      g.onRecord({ tap: 'in', n: k, pts });
      peak = Math.max(peak, g.steps.length);
    }
    assert.equal(r.clock.period.wallSteps, 10_000);
    assert.ok(peak <= 2, `the step list peaked at ${peak}`);
    r.t.mono += 10_000;
    g.end('stop');
    assert.equal(r.clock.period.gaps, 0, 'every step was normalised away: no phantom gap');
  });

  test('G4: 65 +900 ms host steps inside one lag zone, then a record from BEFORE them — no step is folded early, so it is not stamped 900 ms early', () => {
    // The Codex review's input (fix round 2, G4), which replaced fix round 1's "at the cap, the oldest step is
    // folded" test: that count backstop was the defect. A receipt floor of zero — every earlier record's raw
    // PTS equals its receipt time (a 1 kHz input clock, so pts is ms) — then 65 steps noticed within 65 ms,
    // then a record whose raw PTS still equals its receipt time: it was stamped before any step took effect.
    const r = makeClock('motion', { start: 99_000 });
    const g = r.clock.beginGeneration({ path: 'p', fps: 5 });
    g.onConfig({ tap: 'in', dir: 'in', tbNum: 1, tbDen: 1000 });
    for (let k = 0; k < 5; k += 1) {
      r.t.mono = 99_000 + k * 200;
      g.onRecord({ tap: 'in', n: k, pts: 99_000 + k * 200 });
    }
    for (let i = 0; i < 65; i += 1) g.addWallStep(100_000 + i, 900);
    const before = g.normalise(100_100, 100_100, 99_800);
    assert.equal(before.ms, 100_100, 'on the before-side of every step (fix round 1 gave 99,200)');
    assert.equal(g.steps.length, 65, 'nothing folded while still inside its lag zone');
    // Well after every zone: all 65 folded, the whole +58,500 ms kept exactly once.
    const after = g.normalise(110_000 + 65 * 900, 110_000, null);
    assert.equal(g.steps.length, 0);
    assert.equal(after.ms, 110_000);
  });

  test('F7: a BACKWARD step longer than the lag zone keeps flagging DTS-clamped frames until its clamp span ends', () => {
    // Planted: 5 fps, a -5000 ms host step at input 50. For 5 s the transcoder clamps DTS (PTS one tick
    // apart); frames received 2-5 s after the step are past the lag zone but still clamped, and must still
    // be flagged timing-uncertain — which needs the step to stay in the list for its whole clamp span.
    const r = makeClock('motion', { start: 100_000 });
    const g = r.clock.beginGeneration({ path: 'p', fps: 5 });
    g.onConfig({ tap: 'in', dir: 'in', tbNum: 1, tbDen: 90000 });
    let lastPts = -1;
    for (let k = 0; k < 100; k += 1) {
      if (k === 50) r.t.wallOffset -= 5000;
      let pts = Math.round((k * 200 - (k >= 50 ? 5000 : 0)) * 90);
      if (pts <= lastPts) pts = lastPts + 1;
      lastPts = pts;
      r.t.mono = 100_000 + k * 200 + 30;
      g.onRecord({ tap: 'in', n: k, pts });
    }
    // Inputs 50..74 were clamped (25 frames, 5 s). The ones received inside the 2 s lag zone are judged by
    // the zone rule (input 50, 200 ms "late", is within WALL_MATCH_TOL_MS of the floor and reads as a
    // pre-step frame); the ones received AFTER the zone — inputs 60..74 — are the case this pins.
    const pastZone = g.ring.filter((x) => x.n >= 60 && x.n <= 74);
    assert.equal(pastZone.length, 15);
    assert.ok(pastZone.every((x) => x.uncertain), `unflagged: ${pastZone.filter((x) => !x.uncertain).map((x) => x.n)}`);
    assert.ok(g.ring.filter((x) => x.n >= 75).every((x) => !x.uncertain), 'and nothing after the clamp span');
  });
});

// --- fix round 2 ---------------------------------------------------------------------------------------------
// Findings from the second review round (an Opus reviewer with a ground-truth fuzzer, Codex `gpt-6-sol`, and
// Astra). Every test here fails on the fix-round-1 code; each says which finding it pins. Truth is PLANTED
// (the stream is built here) and every expected value is written out.
describe('fix round 2: evidence kept across long stalls, holes beside runs, bounded work', () => {
  // A 10 fps stream (pts n x 9000 ticks of 90 kHz), 200 frames, then the camera STALLS with its RTSP session
  // still up for `stallMs` — nothing arrives at all: no `in`, no `out`, no stdout — then 200 more frames whose
  // pts carry on from real time. fps=5 puts inputs 2k-1 and 2k in slot k and emits the LATER one (R4-1), so
  // slot k's source is input 2k, slot 0's is input 0, and input 199 sits alone in slot 100 until the stall
  // ends. Output record k is slot k. The frame the CFR stage holds across the stall is slot 99 (source 198):
  // its record arrives before the stall, its SAMPLE only once the next record exists, a whole stall later.
  function connectedStall(stallMs) {
    const rig = motionRig();
    const B = 100_000;
    const pre = steadyFrames({ fps: 10, count: 200, base: B });
    const post = steadyFrames({ fps: 10, count: 200, n0: 200, pts0: (20_000 + stallMs) * 90, base: B + 20_000 + stallMs });
    const s = feedStream(rig, [...pre, ...post]);
    s.flush(B + 20_000 + stallMs + 20_100);
    rig.end(B + 20_000 + stallMs + 30_000);
    return { rig, o: rig.byIdx(), B };
  }

  test('H1: a connected camera stall of 31 s, 64 s and 120 s — the REAL frame held across it stays REAL, and the burst stays CLONE-FPS', () => {
    // Fix round 1 timed an `out` record's 30 s retention from its OWN arrival, so a sample the CFR stage held
    // longer than that found its record gone and the REAL frame read UNKNOWN('unmatched') (Opus review,
    // craft-stall.mjs: 25 s and 29 s fine, 31 s and 64 s not). Post-stall input 200 lands in slot
    // (20 s + stall) / 0.2 s, so fps repeats input 199 into every slot from 101 up to that one, exclusive.
    for (const [stallMs, clones] of [[31_000, 154], [64_000, 319], [120_000, 599]]) {
      const { rig, o, B } = connectedStall(stallMs);
      const lastClone = 100 + clones;
      assert.deepEqual([o[99].cls, o[99].src && o[99].src.n], ['real', 198], `${stallMs} ms: the frame held across the stall`);
      // Stamped at its source's time (anchor B + 30 ms latency, source 19.8 s), not at its release a stall later.
      assert.ok(Math.abs(o[99].obsMono - (B + 30 + 19_800)) < 1e-6, `${stallMs} ms: stamp ${o[99].obsMono}`);
      assert.deepEqual([o[100].cls, o[100].src.n], ['real', 199]);
      for (const x of o.slice(101, lastClone + 1)) assert.deepEqual([x.cls, x.src && x.src.n], ['fps-clone', 199], `${stallMs} ms: burst sample ${x.idx}`);
      assert.deepEqual([o[lastClone + 1].cls, o[lastClone + 1].src.n], ['real', 200]);
      const s = rig.clock.summary();
      // 101 before the stall (slots 0..100), input 200's slot, and the 99 slots after it (sources 202..398).
      assert.deepEqual([s.real, s.fpsClone, s.unknown], [201, clones, 0], `${stallMs} ms`);
    }
  });

  test('H1: a same-source clone run held across a 34.5 s stall keeps every record its classification needs', () => {
    // Opus fuzz seed 8's shape. 2 fps into fps=5: input n lands in slot round(2.5 n) — 0, 3, 5, 8 — and fps
    // repeats it until the next one, so records 5..7 are input 2 (REAL) and two repeats of it: ONE
    // identical-content run. Record 7's sample is held across the stall and is a byte repeat of sample 6, so
    // it is classified FROM THE RUN, which needs records 5..7 all present. Fix round 1 had already expired
    // them by their own age, and the repeat read UNKNOWN('ambiguous').
    const rig = motionRig();
    const B = 100_000;
    const pre = [0, 1, 2, 3].map((n) => ({ n, pts: n * 45_000, rx: B + n * 500 + 30 }));
    const post = [4, 5, 6, 7, 8].map((n) => ({ n, pts: (n * 500 + 34_500) * 90, rx: B + n * 500 + 34_500 + 30 }));
    const s = feedStream(rig, [...pre, ...post]);
    s.flush(B + 45_000);
    rig.end(B + 50_000);
    const o = rig.byIdx();
    assert.deepEqual(o.slice(0, 9).map((x) => [x.cls, x.src && x.src.n]), [
      ['real', 0], ['fps-clone', 0], ['fps-clone', 0], ['real', 1], ['fps-clone', 1], ['real', 2], ['fps-clone', 2], ['fps-clone', 2], ['real', 3],
    ]);
    assert.equal(rig.clock.summary().unknown, 0);
  });

  test('H1: ...and when the generation ENDS 10 ms after the burst, the whole burst keeps its clone evidence', () => {
    // Opus fuzz seed 9's shape: 5 fps, a 44 s stall, and the stream ends right after the burst. With the held
    // frame's record expired, its sample waited PENDING_MS for a record that was gone, every later sample
    // queued behind it (content alignment is first-in first-out), and at the end all 221 read
    // UNKNOWN('unmatched'). As in that seed, sources 47 and 48 scale to the same bytes just before the held
    // frame: a static pair, ambiguous by R3-2, which must not disturb what follows.
    const rig = motionRig();
    const B = 100_000;
    const pre = steadyFrames({ fps: 5, count: 51, base: B }); // inputs 0..50 in slots 0..50
    const post = [{ n: 51, pts: (10_200 + 44_000) * 90, rx: B + 10_200 + 44_000 + 30 }]; // slot 271
    feedStream(rig, [...pre, ...post], { content: (src) => (src === 47 || src === 48 ? 'STATIC' : `S${src}`), holdLast: true });
    rig.end(B + 10_200 + 44_000 + 40);
    const o = rig.byIdx();
    assert.deepEqual(o.slice(46, 51).map((x) => [x.cls, x.reason, x.src && x.src.n]), [
      ['real', null, 46], ['unknown', 'ambiguous', null], ['unknown', 'ambiguous', null], ['real', null, 49], ['real', null, 50],
    ]);
    assert.equal(o.length, 270);
    for (const x of o.slice(51)) assert.deepEqual([x.cls, x.src && x.src.n], ['fps-clone', 50], `burst sample ${x.idx}`);
    const s = rig.clock.summary();
    assert.deepEqual([s.fpsClone, s.unknown, s.ambiguous], [219, 2, 2]);
  });

  // The caps below bind only in the regime the release rule cannot age out: something pins the oldest slot
  // still to classify (observation-clock-growth.test.js, FROZEN_3H). Here ONE `out` record (slot 0) that
  // nothing ever releases or resolves does it, so every hole and span stays "needed" until the cap drops it.
  test('H1: holes dropped by their count cap leave a floor — a lost frame\'s slot stays UNKNOWN, never a clone guess, and the floor does not over-reach', () => {
    const rig = motionRig();
    const B = 100_000;
    rig.inRec(0, 0, B);
    rig.outRec(0, 0, 'S0', B + 0.1);
    // 5 fps (input n in slot n); every input n = 4j+1 is lost: 300 holes, hole j covering slots 4j..4j+2 (the
    // lost frame's pts lies strictly between its neighbours'), so slots 4j+3 are in no hole at all.
    for (let n = 2; n < 1200; n += 1) if (n % 4 !== 1) rig.inRec(n, n * 18000, B + n * 200);
    assert.equal(rig.gen.holes.length, 256, '44 of 300 dropped');
    // Slot 1 was lost input 1's: dropped with hole 0. Without the floor, input 0 plus the later input 2 read as
    // positive evidence of an fps repeat of input 0 — a clone claim for a frame that was real and lost.
    assert.deepEqual(rig.gen.provenance(1), { cls: 'unknown', reason: 'hole' });
    assert.deepEqual(rig.gen.provenance(173), { cls: 'unknown', reason: 'hole' }, 'the last dropped hole (j = 43)');
    // The floor is the highest slot a DROPPED hole covered (174): slot 175 is in no hole and stays answerable.
    assert.deepEqual([rig.gen.provenance(175).cls, rig.gen.provenance(175).src.n], ['real', 175]);
    assert.deepEqual(rig.gen.provenance(177), { cls: 'unknown', reason: 'hole' }, 'a hole still in the list (j = 44)');
  });

  test('H1: reordered spans dropped by their count cap leave a floor — no REAL claim survives inside one (R4-2)', () => {
    const rig = motionRig();
    const B = 100_000;
    rig.inRec(0, 0, B);
    rig.outRec(0, 0, 'S0', B + 0.1);
    // 5 fps; every input n = 10j+9 arrives with its pts two slots BACK: span j is slots 10j+7 .. 10j+9 (its own
    // slot up to the highest slot seen before it, plus one). 300 spans, disjoint, 44 over the cap.
    for (let n = 1; n < 3000; n += 1) rig.inRec(n, (n % 10 === 9 ? n - 2 : n) * 18000, B + n * 200);
    assert.equal(rig.gen.reorderedSpans.length, 256, '44 of 300 dropped');
    // Slot 8 is inside span 0 (dropped). Without the floor, input 8 alone in slot 8 reads REAL — the claim R4-2
    // forbids after a backwards input.
    assert.deepEqual(rig.gen.provenance(8), { cls: 'unknown', reason: 'reordered' });
    // The floor is span 43's top (439); slot 441 is in no span and stays answerable.
    assert.deepEqual([rig.gen.provenance(441).cls, rig.gen.provenance(441).src.n], ['real', 441]);
    assert.deepEqual(rig.gen.provenance(448), { cls: 'unknown', reason: 'reordered' }, 'a span still in the list (j = 44)');
  });

  // H5 (Opus review, verified with a ground-truth fuzzer): a lost `out` record BESIDE an identical-content run.
  // 2 fps into fps=5: input n lands in slot round(2.5 n) — 0, 3, 5, 8, 10, 13, 15, 18, 20 — and fps repeats it
  // until the next one, so output records come in same-source runs of two or three (record k = slot k).
  const twoFps = (count) => steadyFrames({ fps: 2, count });

  test('H5: a record lost right AFTER a same-source run, in a static scene — no later sample is called a CFR repeat of it, and none is stamped early', () => {
    // Fuzz seed 39's shape. Sources 2, 3 and 4 scale to the same bytes (a static scene). Record 7 (a repeat of
    // source 2) is lost, so the run of source 2 looks like records 5..6 and the next record (8, REAL source 3)
    // follows a hole. Every later identical sample chained onto the source-2 run, and the Phase A rule
    // labelled everything past its two records a CFR repeat of source 2: samples 8 and 10 are REAL frames of
    // sources 3 and 4 (pts 1.5 s and 2.0 s), and they got source 2's stamp (1.0 s) — 0.5 s and 1.0 s before
    // those frames even existed.
    const rig = motionRig();
    const s = feedStream(rig, twoFps(9), { content: (src) => ([2, 3, 4].includes(src) ? 'STILL' : `S${src}`), dropOut: [7], holdLast: true });
    rig.end(110_000);
    const o = rig.byIdx();
    assert.deepEqual(s.truth.slice(5, 13).map((x) => x.src), [2, 2, 2, 3, 3, 4, 4, 4], 'the planted sources');
    assert.deepEqual(o.slice(0, 5).map((x) => [x.cls, x.src && x.src.n]), [['real', 0], ['fps-clone', 0], ['fps-clone', 0], ['real', 1], ['fps-clone', 1]]);
    for (const x of o.slice(5, 13)) assert.deepEqual([x.cls, x.reason, x.obsMono], ['unknown', 'out-hole', null], `sample ${x.idx}`);
    assert.deepEqual([o[13].cls, o[13].src.n], ['real', 5], 'the first record after the static stretch is classified again');
    // ...and the runs beside the hole report no net dup or drop: which sample is which record is unknowable.
    const sum = rig.clock.summary();
    assert.deepEqual([sum.cfrDup, sum.cfrDrop], [0, 0]);
  });

  test('H5: a REAL frame whose own record is lost, followed by a clone run of it — its sample is not called an fps clone', () => {
    // Fuzz seed 135's shape (no static scene, no dup or drop). Record 5 (REAL source 2) is lost; records 6..7
    // are fps repeats of source 2 with a hole before them. Sample 5 carries the same bytes, so content
    // alignment matched it to record 6, and the Phase A rule called a REAL frame a clone. The run BEFORE the
    // lost record (3..4, source 1) is beside it too — nothing says the lost record was not identical to it —
    // so its samples go UNKNOWN as well; only the run with clean records on both sides keeps its labels.
    const rig = motionRig();
    feedStream(rig, twoFps(9), { dropOut: [5], holdLast: true });
    rig.end(110_000);
    const o = rig.byIdx();
    assert.notEqual(o[5].cls, 'fps-clone', 'the REAL frame is not called a clone');
    for (const x of o.slice(3, 8)) assert.deepEqual([x.cls, x.reason], ['unknown', 'out-hole'], `sample ${x.idx}`);
    assert.deepEqual([o[8].cls, o[8].src.n], ['real', 3]);
    assert.deepEqual(o.slice(0, 3).map((x) => [x.cls, x.src.n]), [['real', 0], ['fps-clone', 0], ['fps-clone', 0]], 'a clean run is unchanged');
  });

  test('H5: the generation\'s FIRST record lost, in a static pair — neither sample is claimed (not REAL of the wrong frame, not a CFR repeat)', () => {
    // Fuzz seed 526's shape: 5 fps (input n in slot n), sources 0 and 1 scale to the same bytes, and out record
    // 0 is lost. The first record received (1) had no record before it, so nothing marked the loss: sample 0
    // matched it and read REAL of source 1 (truly source 0), and sample 1 a CFR repeat (truly REAL).
    const rig = motionRig();
    feedStream(rig, steadyFrames({ fps: 5, count: 6 }), { content: (src) => (src <= 1 ? 'STILL' : `S${src}`), dropOut: [0], holdLast: true });
    rig.end(110_000);
    const o = rig.byIdx();
    assert.deepEqual(o.slice(0, 2).map((x) => [x.cls, x.reason]), [['unknown', 'out-hole'], ['unknown', 'out-hole']]);
    assert.deepEqual([o[2].cls, o[2].src.n], ['real', 2]);
  });

  test('H5: a sample BEYOND a run\'s record count while the record after the run is not known yet reads UNKNOWN(\'pending\'); once the stream has ended it is a CFR repeat', () => {
    // Planted: 2 fps, fps emits slots 0..2 from input 0 (one same-source run), and FOUR identical samples
    // arrive. The fourth is a CFR repeat — or, if record 3's line was lost and its frame scaled to the same
    // bytes, record 3's own frame. Only the record after the run can tell, and here the side channel goes
    // quiet for 6 s (stdout does not), so the samples finalize before it arrives.
    for (const ending of [false, true]) {
      const rig = motionRig();
      const B = 100_000;
      rig.inRec(0, 0, B + 30);
      rig.inRec(1, 45_000, B + 530); // slot 3: fps emits slots 0..2 from input 0
      for (let k = 0; k <= 2; k += 1) rig.outRec(k, k, 'S0', B + 530.1);
      for (let i = 0; i < 4; i += 1) rig.sample('S0', B + 530.2 + i);
      if (ending) rig.end(B + 600); // "no later record will come" is now a fact (as neighbourState treats it)
      else rig.inRec(2, 90_000, B + 6_600); // an `in` record 6 s later: the four samples finalize now
      const o = rig.byIdx();
      assert.deepEqual(o.slice(0, 3).map((x) => [x.cls, x.src.n]), [['real', 0], ['fps-clone', 0], ['fps-clone', 0]]);
      assert.deepEqual([o[3].cls, o[3].reason], ending ? ['cfr-clone', null] : ['unknown', 'pending'], ending ? 'at the end' : 'while the record after the run is unknown');
    }
  });

  // G1 (Codex review, confirmed by Opus's craft-gens-cap.mjs): the GENS_MAX backstop folded the front
  // generation even when it was OPEN. A clean 8 kHz sound stream (320-sample packets, 25/s; a 0.2 s window
  // every 5 packets) whose PTS follow real time from the generation's own connection start, as the transcoder
  // stamps them; `st.step` is a host wall step already inside them.
  function soundFeed(r) {
    return (gen, start, secs, st) => {
      if (st.c0 === undefined) st.c0 = start;
      const p0 = start - st.c0;
      for (let i = 0; i < secs * 25; i += 1) {
        r.t.mono = start + i * 40 + 20;
        const pts = Math.round((p0 + i * 40 + (st.step || 0)) * 8);
        gen.onRecord({ tap: 'audio', n: st.n, pts, ptsTime: pts / 8000, rate: 8000, nbSamples: 320 });
        st.n += 1;
        if (st.n % 5 === 0) gen.onSample(Buffer.alloc(0), r.t.mono + 1, r.t.mono + 1 + r.t.wallOffset, { analysed: true });
      }
      return start + secs * 1000;
    };
  }

  test('G1: 17 launches that observe and exit behind an OPEN generation — the open one is never folded: it keeps its wall steps, its later observations, and the clock is not idle', () => {
    const r = makeClock('sound', { start: 100_000 });
    const { t, clock } = r;
    const feed = soundFeed(r);
    const A = clock.beginGeneration({ path: 'p', windowSeconds: 0.2 });
    const stA = { n: 0 };
    let now = feed(A, 100_000, 10, stA);
    for (let i = 1; i <= 17; i += 1) {
      now += 5000;
      t.mono = now;
      const B = clock.beginGeneration({ path: 'p', windowSeconds: 0.2 });
      now = feed(B, now, 10, { n: 0 });
      t.mono = now + 6000;
      B.end('exit', { code: i });
      now = t.mono;
    }
    // 18 generations held, past GENS_MAX (16): the open one and the 17 that observed behind it.
    assert.ok(clock.gens.includes(A), 'the open generation is still in the list');
    assert.equal(clock.sizes().gens, 18);
    assert.equal(clock.isIdle(now + 3_600_001), false, 'a generation is open: never idle, however long it is quiet');
    assert.equal(clock.hasSomethingToReport(), true);
    assert.equal(clock.summary().restarts, 0, 'every interval behind the open generation is still provisional (R3-4)');
    // The host clock steps +900 ms, then A delivers 10 s more (its PTS carry the step) and closes.
    t.wallOffset += 900;
    now += 5000;
    stA.step = 900;
    const resumed = now;
    now = feed(A, now, 10, stA);
    t.mono = now + 6000;
    A.end('exit', { code: 0 });
    const s = clock.summary();
    assert.equal(s.restarts, 0, 'A observed after every launch behind it began, so no interval survives (R3-4)');
    // A's own pause is ONE discontinuity of exactly its real length: its media stopped at 10 s, and its PTS
    // resumed at (resumed - 100 s); the +900 ms step is the host clock, removed because A still gets steps.
    assert.equal(s.gaps, 1);
    assert.ok(Math.abs(s.gapMs - (resumed - 110_000)) < 1e-6, `gap ${s.gapMs} ms vs ${resumed - 110_000}`);
    // A new launch: ONE restart, from A's LATEST observation, with the reason and code of the LAST launch
    // before it in launch order (the 17th).
    const C = clock.beginGeneration({ path: 'p', windowSeconds: 0.2 });
    feed(C, t.mono + 5000, 10, { n: 0 }); // its first window finalizes 5 s after receipt
    assert.ok(Math.abs(C.restartInfo.lo - A.lastObsMono) < 1e-6, `lo ${C.restartInfo.lo} vs A's last observation ${A.lastObsMono}`);
    assert.ok(A.lastObsMono > resumed, 'A\'s last observation is from its second delivery');
    assert.deepEqual([C.restartInfo.reason, C.restartInfo.code], ['exit', 17]);
  });

  test('G1: past GENS_MAX the backstop drops the oldest CLOSED generation that never observed — never the open one — and the RESTART after them all is exact', () => {
    // Planted: A opens and observes; then 20 x (a launch that fails at once, a launch that observes 2 s and
    // exits). A failed launch followed by an observing one is not an empty PAIR, so only the backstop can drop it.
    const r = makeClock('sound', { start: 100_000 });
    const { t, clock } = r;
    const feed = soundFeed(r);
    const A = clock.beginGeneration({ path: 'p', windowSeconds: 0.2 });
    const stA = { n: 0 };
    let now = feed(A, 100_000, 2, stA);
    let peak = 0;
    for (let i = 0; i < 20; i += 1) {
      t.mono = now + 1000;
      clock.beginGeneration({ path: 'p', windowSeconds: 0.2 }).end('exit', { code: 1 });
      now = t.mono + 1000;
      t.mono = now;
      const O = clock.beginGeneration({ path: 'p', windowSeconds: 0.2 });
      now = feed(O, now, 2, { n: 0 });
      t.mono = now + 6000;
      O.end('exit', { code: 0 });
      now = t.mono;
      peak = Math.max(peak, clock.gens.length);
    }
    assert.equal(peak, 21, 'A and the 20 launches that observed; every failed launch dropped');
    assert.ok(clock.gens.includes(A));
    assert.ok(clock.gens.every((g) => g === A || g.firstObsMono !== null), 'only launches that never observed were dropped');
    now += 5000;
    now = feed(A, now, 2, stA);
    t.mono = now + 6000;
    A.end('exit', { code: 0 });
    assert.equal(clock.gens.length, 0, 'everything closed: everything folded');
    const C = clock.beginGeneration({ path: 'p', windowSeconds: 0.2 });
    feed(C, t.mono + 5000, 10, { n: 0 }); // its first window finalizes 5 s after receipt
    assert.ok(Math.abs(C.restartInfo.lo - A.lastObsMono) < 1e-6);
    assert.deepEqual([C.restartInfo.reason, C.restartInfo.code], ['exit', 0]);
    assert.equal(clock.summary().restarts, 1);
  });

  test('G1: sizes() counts every generation the clock still holds — totals, and the last one begun even after it folds', () => {
    const r = makeClock('motion', { start: 100_000 });
    const g1 = r.clock.beginGeneration({ path: 'p', fps: 5 });
    const g2 = r.clock.beginGeneration({ path: 'p', fps: 5 });
    for (const [g, k] of [[g1, 3], [g2, 5]]) {
      g.onConfig({ tap: 'in', dir: 'in', tbNum: 1, tbDen: 90000 });
      for (let n = 0; n < k; n += 1) g.onRecord({ tap: 'in', n, pts: n * 18000 });
    }
    assert.deepEqual([r.clock.sizes().gens, r.clock.sizes().ring], [2, 8], 'two open generations: 3 + 5 `in` records');
    g1.end('exit');
    g2.end('exit');
    assert.equal(r.clock.gens.length, 0, 'both closed and folded out of the list');
    assert.deepEqual([r.clock.sizes().gens, r.clock.sizes().ring], [1, 5], 'the last one begun is still held (lastGen)');
  });

  test('H3: provenanceMany answers exactly as provenance, slot for slot — through holes, backwards pts, stalls, pruning, and the count caps and their floors', () => {
    // An internal equivalence: the one-pass path runClass now uses, against the per-slot path that the R4
    // capture tests pin to real ffmpeg. Two regimes, each checked after every 25th `in` record over the lowest
    // and highest slots held and a spread between: (a) no `out` records, so the ring and the holes age out;
    // (b) one `out` record nothing releases or resolves, which pins the oldest slot, so the 4,000-record ring
    // cap and the 256 hole/span caps and their floors all bind.
    for (const pinned of [false, true]) {
      const rig = motionRig();
      let seed = pinned ? 7 : 3;
      const rnd = () => {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return seed / 2147483648;
      };
      if (pinned) rig.outRec(0, 0, 'PIN', 100_000);
      let ms = 0;
      let checked = 0;
      for (let n = 0; n < 6000; n += 1) {
        ms += rnd() < 0.005 ? 2000 + rnd() * 15_000 : rnd() < 0.5 ? 100 : 200; // 10 or 5 fps, and stalls
        if (rnd() < 0.08) continue; // a lost `in` record: a hole
        let pts = Math.round(ms * 90);
        if (rnd() < 0.1) pts = Math.max(0, pts - Math.round(rnd() * 90 * 1500)); // backwards: a reordered span
        rig.inRec(n, pts, 100_000 + ms + 30);
        if (n % 25 !== 0 || !rig.gen.ring.length) continue;
        const held = rig.gen.ring.map((r) => r.slot);
        const lo = Math.min(...held);
        const hi = Math.max(...held);
        const slots = [];
        for (let t = lo - 3; t <= lo + 20; t += 1) slots.push(t);
        for (let t = hi - 20; t <= hi + 3; t += 1) slots.push(t);
        for (let k = 0; k < 30; k += 1) slots.push(lo + Math.floor(rnd() * (hi - lo + 1)));
        assert.deepEqual(rig.gen.provenanceMany(slots), slots.map((t) => rig.gen.provenance(t)), `${pinned ? 'pinned' : 'ageing'}, after input ${n}`);
        checked += slots.length;
      }
      assert.ok(checked > 10_000, `${checked} slots compared`);
      if (pinned) {
        // The regime really did reach the caps (so the floors and the pruned-record marks were exercised).
        assert.equal(rig.gen.ring.length, 4000);
        assert.ok(rig.gen.holesFloor > -Infinity && rig.gen.spansFloor > -Infinity, `floors ${rig.gen.holesFloor} / ${rig.gen.spansFloor}`);
      }
    }
  });

  test('H3: a stall\'s clone burst computes its run\'s verdict ONCE for the whole batch, not once per sample', () => {
    // The 120 s connected stall above: a 600-record same-source run whose 599 samples arrive together and
    // finalize in one batch. Phase A asked provenance() about every member for every sample: 599 x 600.
    let evals = 0;
    const rig = motionRig();
    const many = rig.gen.provenanceMany.bind(rig.gen);
    rig.gen.provenanceMany = (slots) => {
      evals += slots.length;
      return many(slots);
    };
    const B = 100_000;
    const pre = steadyFrames({ fps: 10, count: 200, base: B });
    const post = steadyFrames({ fps: 10, count: 200, n0: 200, pts0: (20_000 + 120_000) * 90, base: B + 140_000 });
    feedStream(rig, [...pre, ...post]).flush(B + 160_100);
    rig.end(B + 170_000);
    assert.equal(rig.clock.summary().fpsClone, 599);
    assert.ok(evals <= 1200, `${evals} provenance evaluations (one pass over the 600 members is 600)`);
  });

  test('H3: a run\'s cached verdict is dropped when an `in` record arrives — the answer is the one recomputing would give', () => {
    // Planted out of order (the `out` records before the input that makes fps emit them) so that one provenance
    // input changes between two batches of the same run's samples: records 1..5 are input 1 and four fps
    // repeats of it, and the input that PROVES them (a later slot, R4-3) arrives only after the first batch.
    const rig = motionRig();
    const B = 100_000;
    rig.inRec(0, 0, B);
    rig.inRec(1, 18_000, B + 200); // slot 1
    rig.outRec(0, 0, 'S0', B + 200.1);
    for (let k = 1; k <= 5; k += 1) rig.outRec(k, k, 'S1', B + 200.2);
    rig.sample('S0', B + 300);
    for (let i = 0; i < 3; i += 1) rig.sample('S1', B + 300.1 + i);
    rig.sample('S1', B + 5_400); // an event past the first four samples' deadline: they finalize now
    assert.deepEqual(rig.byIdx().slice(1, 4).map((x) => [x.cls, x.reason]), Array(3).fill(['unknown', 'source-unproven']));
    rig.inRec(2, 6 * 18_000, B + 5_500); // slot 6: every slot 1..5 now has a later record
    rig.sample('S1', B + 5_600);
    rig.end(B + 20_000);
    const o = rig.byIdx();
    assert.deepEqual(o.slice(4, 6).map((x) => [x.cls, x.src && x.src.n]), [['fps-clone', 1], ['fps-clone', 1]]);
  });

  test('H3: ...and when the run GROWS between two batches, with no `in` record in between', () => {
    // Records 1..3 are input 1 and two fps repeats of it (one same-source run). After the first batch, record 4
    // extends the run — identical bytes, but a DIFFERENT real frame (input 2, a static scene), so the run is no
    // longer same-source and its later samples are ambiguous (R3-2). Every `in` record arrives first (planted:
    // record 4 is late) so that nothing but the run's growth separates the two batches.
    const rig = motionRig();
    const B = 100_000;
    rig.inRec(0, 0, B); // slot 0
    rig.inRec(1, 18_000, B + 200); // slot 1
    rig.inRec(2, 4 * 18_000, B + 800); // slot 4: proves slots 1..3
    rig.inRec(3, 5 * 18_000, B + 1_000); // slot 5: proves slot 4 is input 2's
    rig.outRec(0, 0, 'S0', B + 1_000.1);
    for (let k = 1; k <= 3; k += 1) rig.outRec(k, k, 'S1', B + 1_000.2);
    rig.sample('S0', B + 1_100);
    rig.sample('S1', B + 1_100.1);
    rig.sample('S1', B + 1_100.2);
    rig.outRec(4, 4, 'S1', B + 6_150); // an event past their deadline (they finalize), then it joins the run
    assert.deepEqual(rig.byIdx().slice(1, 3).map((x) => [x.cls, x.src.n]), [['real', 1], ['fps-clone', 1]]);
    rig.sample('S1', B + 6_200);
    rig.sample('S1', B + 6_200.1);
    rig.end(B + 20_000);
    const o = rig.byIdx();
    assert.deepEqual(o.slice(3, 5).map((x) => [x.cls, x.reason]), [['unknown', 'ambiguous'], ['unknown', 'ambiguous']]);
  });

  test('G2: runs closed early by the open-run cap report no dup or drop — they count in runsCapped — even when their samples arrive after the cap closed them', () => {
    // Planted: stderr runs ahead of stdout. 66 identical-content PAIRS of records (P0,P0,P1,P1,...) reach the
    // clock before any sample, so 66 runs are open at once and the cap (64) closes the two oldest while their
    // samples are still on the way. Then every sample arrives, and a final distinct frame closes the last run.
    // Each record got exactly one sample: the truth is 0 dups and 0 drops. Fix round 1 counted each capped
    // run's two records as drops the moment it closed it, and nothing revised them (Codex review).
    const rig = motionRig();
    const B = 100_000;
    for (let k = 0; k < 132; k += 1) rig.outRec(k, k, `P${k >> 1}`, B + k);
    rig.outRec(132, 132, 'END', B + 132);
    rig.outRec(133, 133, 'NEXT', B + 133);
    assert.equal(rig.gen.openRuns.size, 64);
    for (let k = 0; k < 132; k += 1) rig.sample(`P${k >> 1}`, B + 500 + k);
    rig.sample('END', B + 700);
    rig.end(B + 20_000);
    const s = rig.clock.summary();
    assert.deepEqual([s.cfrDup, s.cfrDrop, s.runsCapped], [0, 0, 2]);
    assert.equal(s.samples, 133, 'every sample was still classified');
  });

  test('G3: at the 10,000-interval coverage cap, an interval inside the newest one merges and evicts nothing; a new disjoint one evicts the earliest', () => {
    // Codex review: fix round 1 evicted the earliest interval BEFORE merging, so coverage the union already
    // held still cost the oldest interval. Planted: 10,000 disjoint 5 ms intervals, 10 ms apart.
    const { clock } = makeClock('motion');
    for (let k = 0; k < 10_000; k += 1) clock.addCoverage('sampler', k * 10, k * 10 + 5);
    assert.equal(clock.sampler.iv.length, 10_000);
    clock.addCoverage('sampler', 99_991, 99_993); // wholly inside the newest, [99,990, 99,995)
    assert.equal(clock.sampler.iv.length, 10_000);
    assert.deepEqual(clock.sampler.iv[0], [0, 5], 'the earliest interval is still there');
    assert.equal(clock.sampler.measure(0, 100_000), 50_000, 'nothing lost, nothing added');
    clock.addCoverage('sampler', 100_000, 100_005); // disjoint and new: the union needs one more slot
    assert.equal(clock.sampler.iv.length, 10_000);
    assert.deepEqual(clock.sampler.iv[0], [10, 15], 'now the earliest goes');
  });
});

// --- fix round 3 ---------------------------------------------------------------------------------------------
describe('fix round 3: the net count of a run the stream ends inside (finding (a) of fix round 2)', () => {
  // Planted (the fix-round-2 builder's reproducer, scratch quirk-end.mjs): 2 fps into fps=5, so fps emits
  // slots 0..2 from input 0 — ONE same-source run of three identical records, the generation's last — then
  // `samples` identical frames reach stdout (the first matched by content, the rest byte repeats of it) and
  // the generation ends.
  function endInsideRun(samples) {
    const rig = motionRig();
    const B = 100_000;
    rig.inRec(0, 0, B + 30);
    rig.inRec(1, 45_000, B + 530); // slot 3: fps emits slots 0..2, all from input 0
    for (let k = 0; k <= 2; k += 1) rig.outRec(k, k, 'S0', B + 530.1);
    for (let i = 0; i < samples; i += 1) rig.sample('S0', B + 530.2 + i);
    rig.end(B + 600);
    return rig.clock.summary();
  }

  test('(a) phantom dup: 3 samples for 3 records is no dup, 4 is exactly one; 2 is the unwritten final frame (no drop), 1 is one real drop', () => {
    // Before the fix the final record always looked unwritten (a byte repeat never marks its record
    // matched), so a fully delivered run was docked one record: [3 -> dup 1] and [4 -> dup 2]. The 2- and
    // 1-sample rows are the ones the fix must NOT change: there the run really is short, and refinement 3
    // (the final frame is the stream ending, not a drop) still applies — 2 samples read 0 drops, not 1.
    const rows = [[3, 0, 0], [4, 1, 0], [2, 0, 0], [1, 0, 1]];
    for (const [samples, dup, drop] of rows) {
      const s = endInsideRun(samples);
      assert.deepEqual([s.cfrDup, s.cfrDrop], [dup, drop], `${samples} samples for 3 records`);
    }
  });
});
