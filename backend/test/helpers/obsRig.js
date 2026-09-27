// Test rig for observationClock.js (issue #373). Builds a clock with INJECTED monotonic and wall clocks and
// feeds it the events ffmpeg and the detector would, in the order they really arrive.
//
// ★ C7: nothing here asks the module what the answer is. Checksums come from zlib (zlibAdler0), and the
// fps emulation below only CONSTRUCTS inputs (which frame fps would put in which slot, from vf_fps's
// documented rule); every test states its truth as a planted fact, or reads it from a real capture.
import zlib from 'node:zlib';
import { ObservationClock } from '../../src/lib/observationClock.js';

export const WALL0 = 1_790_000_000_000; // wall - mono at the start of every rig

// zlib's Adler-32 (init 1, from the zlib trailer) converted to showinfo's init 0. See
// ffmpeg-side-channel.test.js for the derivation.
export function zlibAdler0(buf) {
  const z = zlib.deflateSync(buf);
  const a1b1 = z.readUInt32BE(z.length - 4);
  const a0 = ((a1b1 & 0xffff) - 1 + 65521) % 65521;
  const b0 = (((a1b1 >>> 16) - (buf.length % 65521)) % 65521 + 65521) % 65521;
  return ((b0 << 16) | a0) >>> 0;
}

// A small, distinct frame per content label. The clock never looks at pixels, only bytes and checksums.
export function frameOf(content) {
  const b = Buffer.alloc(64);
  b.write(String(content));
  return b;
}

export function makeClock(leg, { start = 100_000, tombstone, cameraId = 'cam', wallOffset = WALL0 } = {}) {
  const t = { mono: start, wallOffset };
  const clocks = { monoNow: () => t.mono, wallNow: () => t.mono + t.wallOffset };
  const obs = [];
  const logs = [];
  const clock = new ObservationClock(cameraId, leg, {
    clocks, label: 'Cam', log: (l) => logs.push(l), onObservation: (o) => obs.push(o), tombstone,
  });
  return { t, clocks, clock, obs, logs };
}

// A motion generation with its config lines already delivered (90 kHz input clock, fps=5 output).
export function motionRig(opts = {}) {
  const r = makeClock('motion', opts);
  const gen = r.clock.beginGeneration({ path: 'cam-sub', fps: 5 });
  const tb = opts.tbIn || [1, 90000];
  gen.onConfig({ tap: 'in', dir: 'in', tbNum: tb[0], tbDen: tb[1] });
  gen.onConfig({ tap: 'out', dir: 'in', tbNum: 1, tbDen: 5 });
  const rig = {
    ...r,
    gen,
    at(ms) { r.t.mono = ms; },
    inRec(n, pts, at) { if (at !== undefined) r.t.mono = at; gen.onRecord({ tap: 'in', n, pts }); },
    outRec(n, slot, content, at) {
      if (at !== undefined) r.t.mono = at;
      gen.onRecord({ tap: 'out', n, pts: slot, checksum: zlibAdler0(frameOf(content)) });
    },
    sample(content, at) {
      if (at !== undefined) r.t.mono = at;
      gen.onSample(frameOf(content), r.t.mono, r.t.mono + r.t.wallOffset);
    },
    end(at, reason = 'exit') { if (at !== undefined) r.t.mono = at; gen.end(reason, { code: 0 }); },
    byIdx: () => [...r.obs].sort((a, b) => a.idx - b.idx),
  };
  return rig;
}

// vf_fps's rule, to CONSTRUCT a realistic stream: output slot t is emitted when an input with slot > t
// arrives, carrying the latest input with slot <= t (fixtures/obs/fps-slot-*.err show it). Round half
// away from zero on the 90 kHz clock. Returns the planted truth: [{outN, slot, src}].
export function slotOf90k(pts) {
  const num = pts * 5;
  return Math.floor((2 * num + 90000) / (2 * 90000));
}

// Feeds a whole stream: `frames` = [{ n, pts (90 kHz ticks), rx }]. Each out record is logged right after
// the input that triggered it; each stdout sample arrives right after the NEXT out record (the rawvideo
// CFR stage holds a frame until the next one arrives — measured, plan "What Stage 1 settled"). `content`
// maps a source input n to its frame content (identical content = identical bytes). `dropOut` lists output
// record numbers whose stderr LINE is lost (glued or garbled): the frame is still written to stdout.
export function feedStream(rig, frames, { content = (src) => `S${src}`, outN0 = 0, holdLast = false, dropOut = [] } = {}) {
  const truth = [];
  let next = null;
  let outN = outN0;
  const seen = [];
  const pendingSamples = [];
  for (const f of frames) {
    rig.inRec(f.n, f.pts, f.rx);
    const slot = slotOf90k(f.pts);
    if (next === null) next = slot;
    while (seen.length && slot > next) {
      let src = null;
      for (const s of seen) if (s.slot <= next) src = s.n;
      truth.push({ outN, slot: next, src });
      if (!dropOut.includes(outN)) rig.outRec(outN, next, content(src), f.rx + 0.1);
      // The frame held by the CFR stage is released now that a newer one exists.
      if (pendingSamples.length) rig.sample(pendingSamples.shift(), f.rx + 0.2);
      pendingSamples.push(content(src));
      outN += 1;
      next += 1;
    }
    seen.push({ n: f.n, slot });
  }
  return { truth, pendingSamples, nextOutN: outN, nextSlot: next, flush(at) { if (!holdLast) while (pendingSamples.length) rig.sample(pendingSamples.shift(), at); } };
}

// Frames at a steady input rate on the 90 kHz clock, received `lat` ms after their PTS.
export function steadyFrames({ fps, count, base = 100_000, lat = 30, n0 = 0, pts0 = 0 }) {
  const step = 90000 / fps;
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const pts = pts0 + Math.round(i * step);
    out.push({ n: n0 + i, pts, rx: base + (pts - pts0) / 90 + lat });
  }
  return out;
}
