// #573: a TORN `ashowinfo` record must not blind the sound [obs] measurement.
//
// ★ WHAT HAPPENED. ffmpeg prints one ashowinfo record in several av_log calls; another thread's message (the
// muxer's `Application provided invalid, non monotonically increasing dts`) can land between two of them. The
// first call carries every field the observation clock reads and is intact in every tear seen; only the unused
// tail is glued to foreign text. The strict whole-line grammar threw such a record away, the clock was told one
// was LOST, and one lost record blinds every later window of that ffmpeg run (R1-F11). The fix recovers the
// record from its intact first half (audio only) and leaves a truly lost record exactly as it was, plus one
// warning so a blind measurement is distinguishable from a dead sampler.
//
// ★ ORACLES (C7 of #373, repeated here). Expected values come from the record this file GENERATES, from its own
// small regexes over the 18 real torn lines in fixtures/obs/torn-ashowinfo-real.txt, or from an independent
// copy of the OLD classifier's decision written out below; never from the module under test.
//
// ★ WHAT IS NOT PROVEN HERE (stated, not hidden): that ffmpeg's first av_log call is atomic. That rests on a
// read of the ffmpeg 8.1.2 source and on 18 of 18 real tears; no test runs real ffmpeg. The TAIL lines this
// file feeds after a tear are CONSTRUCTED from the grammar (`HEX ]`, `]`, `plane_checksums: [ HEX ]`): no tail
// line is in any saved log, because tails are dropped as fragments.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLineBuffer } from '../src/lib/processOutput.js';
import { buildMotionTaps, buildSoundTaps, classifyLine, createStderrRouter } from '../src/lib/ffmpegSideChannel.js';
import { ObservationClock } from '../src/lib/observationClock.js';
import { logger } from '../src/lib/logger.js';
import { makeClock, WALL0 } from './helpers/obsRig.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, 'fixtures', 'obs');
const SOUND = buildSoundTaps().taps;
const MOTION = buildMotionTaps({ fps: 5, width: 320, height: 180 }).taps;
const PREFIX = '[Parsed_ashowinfo_0 @ 0x7f0000000001] [info] ';
const FOREIGN_DTS = 'Application provided invalid, non monotonically increasing dts to muxer in stream 0: 5 >= 5';

const REAL = fs.readFileSync(path.join(FIX, 'torn-ashowinfo-real.txt'), 'utf8').split('\n').filter((l) => l.trim());

// --- a generated, coherent 8 kHz stream ------------------------------------------------------------------
const HEX = (v) => v.toString(16).toUpperCase().padStart(8, '0');
function rec(n) {
  const pts = n * 320;
  const sum = HEX(((n + 1) * 2654435761) >>> 0);
  return {
    sum,
    core: `n:${n} pts:${pts} pts_time:${Number((pts / 8000).toPrecision(6))} fmt:s16 channels:1 chlayout:mono rate:8000 nb_samples:320 checksum:${sum} `,
    tails: { 'after-core': `plane_checksums: [ ${sum} ]`, 'after-open': `${sum} ]`, 'after-plane': ']' },
  };
}
const healthyLine = (n) => { const r = rec(n); return `${PREFIX}${r.core}${r.tails['after-core']}`; };

// The tear SHAPE of a real line, read with this file's own regex: where the foreign text landed, and what it was.
function shapeOf(line) {
  const m = /checksum:[0-9A-F]{8} (plane_checksums: \[ )?(?:([0-9A-F]{8}) )?(.*)$/.exec(line);
  assert.ok(m, line);
  return { kind: m[1] === undefined ? 'after-core' : m[2] === undefined ? 'after-open' : 'after-plane', foreign: m[3] };
}
// Record n torn the way `shape` says: the first line carries the first half and the foreign text, the second
// carries the rest of the record under a fresh prefix (CONSTRUCTED: see the header).
function tornLines(n, shape) {
  const r = rec(n);
  const first = shape.kind === 'after-core' ? '' : shape.kind === 'after-open' ? 'plane_checksums: [ ' : `plane_checksums: [ ${r.sum} `;
  return [`${PREFIX}${r.core}${first}${shape.foreign}`, `${PREFIX}${r.tails[shape.kind]}`];
}
// A record whose CORE is lost: the foreign text lands inside `nb_samples:320`.
function lostCoreLines(n) {
  const r = rec(n);
  const cut = r.core.indexOf('nb_samples:320') + 'nb_samples:3'.length;
  return [`${PREFIX}${r.core.slice(0, cut)}${FOREIGN_DTS}`, `${PREFIX}${r.core.slice(cut)}${r.tails['after-core']}`];
}

// Real router -> real generation, fed through the real line buffer.
function pipeline(rig, { monoNow } = {}) {
  const gen = rig.clock.beginGeneration({ path: 'cam', windowSeconds: 0.2 });
  const delivered = [];
  const forwarded = [];
  const parseErrors = [];
  const router = createStderrRouter({
    taps: SOUND,
    forward: (t) => forwarded.push(t),
    onRecord: (r) => { delivered.push(r); gen.onRecord(r); },
    onParseError: (tap) => { parseErrors.push(tap); gen.onParseError(tap); },
    monoNow: monoNow || (() => rig.t.mono),
  });
  const lb = createLineBuffer((line) => router.line(line));
  return { gen, router, lb, delivered, forwarded, parseErrors };
}
// 40 ms per record (320 samples at 8 kHz), a 200 ms window after every 5th record. `tear[i]` = lines for
// record i instead of its healthy line; `nOf` renumbers; `dup` prints those records twice.
function play(rig, pipe, from, to, { tear = {}, nOf = (i) => i, dup = [], base = 100_000 } = {}) {
  for (let i = from; i < to; i += 1) {
    rig.t.mono = base + i * 40 + 20;
    const lines = tear[i] ? tear[i] : [healthyLine(nOf(i))];
    if (dup.includes(i)) lines.push(...lines);
    pipe.lb.write(`${lines.join('\n')}\n`);
    if ((i + 1) % 5 === 0) {
      rig.t.mono += 0.5;
      pipe.gen.onSample(Buffer.alloc(0), rig.t.mono, rig.t.mono + WALL0, { analysed: true });
    }
  }
}
function finish(rig, pipe, at = 100_000 + 400 * 40 + 10_000) {
  rig.t.mono = at;
  pipe.gen.end('exit', { code: 0 });
  return [...rig.obs].sort((a, b) => a.idx - b.idx);
}

function route(lines, taps = SOUND, opts = {}) {
  const forwarded = [];
  const records = [];
  const parseErrors = [];
  const r = createStderrRouter({
    taps,
    forward: (t) => forwarded.push(t),
    onRecord: (x) => records.push(x),
    onParseError: (tap) => parseErrors.push(tap),
    ...opts,
  });
  for (const l of lines) r.line(l);
  r.end();
  return { forwarded, records, parseErrors, stats: r.stats() };
}

// ===========================================================================================================
describe('#573 a real tear shape does not blind the run', () => {
  test('#573 C1: every one of the 18 real torn lines is a record carrying its OWN values', () => {
    assert.equal(REAL.length, 18);
    const shapes = new Set();
    for (const line of REAL) {
      const m = / n:(\d+) pts:(-?\d+) pts_time:(\S+) fmt:\S+ channels:\d+ chlayout:\S+ rate:(\d+) nb_samples:(\d+) checksum:([0-9A-F]{8}) /.exec(line);
      assert.ok(m, line);
      const d = classifyLine(line, SOUND);
      assert.equal(d.kind, 'record', line);
      assert.equal(d.salvaged, true, line);
      assert.deepEqual(d.rec, {
        n: Number(m[1]), pts: Number(m[2]), ptsTime: Number(m[3]), rate: Number(m[4]), nbSamples: Number(m[5]), checksum: Number.parseInt(m[6], 16),
      }, line);
      shapes.add(shapeOf(line).kind);
    }
    assert.deepEqual([...shapes].sort(), ['after-core', 'after-open', 'after-plane'], 'the real set holds all three shapes');
  });

  test('#573 C1: each real tear, at 5 positions of a coherent 400-record stream: every window observed, side ok', () => {
    let runs = 0;
    for (const real of REAL) {
      const shape = shapeOf(real);
      for (const at of [0, 1, 50, 200, 399]) {
        const rig = makeClock('sound');
        const pipe = pipeline(rig);
        play(rig, pipe, 0, 400, { tear: { [at]: tornLines(at, shape) } });
        const o = finish(rig, pipe);
        const why = `${shape.kind} at ${at}: ${shape.foreign}`;
        assert.equal(o.length, 80, why);
        assert.ok(o.every((x) => x.cls === 'observed'), `${why}: ${JSON.stringify(o.find((x) => x.cls !== 'observed'))}`);
        assert.equal(rig.clock.summary().side, 'ok', why);
        assert.equal(pipe.delivered.length, 400, `${why}: one onRecord per record`);
        assert.deepEqual(pipe.parseErrors, [], why);
        assert.equal(pipe.router.stats().salvaged, 1, why);
        assert.equal(rig.logs.filter((l) => l.includes('timestamp sequence broke')).length, 0, why);
        runs += 1;
      }
    }
    assert.equal(runs, 90);
  });
});

// ===========================================================================================================
// The OLD classifier's decision for a tap-tagged audio `[info]` line that starts `n:`, written out
// independently (a copy of the strict grammar and of the whole-message token rule as they were before #573).
const OLD_TS = String.raw`(?:-?\d+(?:\.\d+)?(?:e[-+]?\d+)?|NOPTS)`;
const OLD_CHLAYOUT = String.raw`(?:[\w.()+@-]+|\d+ channels(?: \([\w.+@-]+\))?)`;
const OLD_STRICT = new RegExp(
  String.raw`^n:(\d+) pts:(-?\d+|NOPTS) pts_time:${OLD_TS} fmt:\S+ channels:\d+ chlayout:${OLD_CHLAYOUT} rate:(\d+) ` +
    String.raw`nb_samples:(\d+) checksum:([0-9A-F]{8}) plane_checksums: \[ (?:[0-9A-F]{8} )+\]\s*$`
);
const OLD_FIELDS = 'n|pts|pts_time|duration|duration_time|fmt|cl|sar|s|i|iskey|type|checksum|plane_checksum|plane_checksums|mean|stdev|channels|chlayout|rate|nb_samples|color_range|color_space|color_primaries|color_trc';
const OLD_TOKEN = new RegExp(String.raw`^(?:(?:${OLD_FIELDS}):\S*|\[?-?[0-9A-Fa-f.]+\]?|[[\]])$`);
function oldDecision(line) {
  const message = /^\[Parsed_ashowinfo_0 @ 0x[0-9a-f]+\] \[info\] (.*)$/.exec(line)[1];
  const r = OLD_STRICT.exec(message);
  if (r && r[2] !== 'NOPTS') return 'record';
  return message.trim().split(/\s+/).every((t) => OLD_TOKEN.test(t)) ? 'dropped' : 'forwarded';
}

// 4 record shapes: 8 kHz mono; 48 kHz planar stereo; a multi-word chlayout; an exponent-form pts_time.
const SHAPES = [
  { name: '8 kHz mono', message: 'n:3 pts:960 pts_time:0.12 fmt:s16 channels:1 chlayout:mono rate:8000 nb_samples:320 checksum:A1B2C3D4 plane_checksums: [ A1B2C3D4 ]', truth: { n: 3, pts: 960, ptsTime: 0.12, rate: 8000, nbSamples: 320, checksum: 0xA1B2C3D4 } },
  { name: '48 kHz planar stereo', message: 'n:7 pts:7168 pts_time:0.149333 fmt:s16p channels:2 chlayout:stereo rate:48000 nb_samples:1024 checksum:0F1E2D3C plane_checksums: [ 0F1E2D3C 4B5A6978 ]', truth: { n: 7, pts: 7168, ptsTime: 0.149333, rate: 48000, nbSamples: 1024, checksum: 0x0F1E2D3C } },
  { name: '3 channels (FL+FR+LFE)', message: 'n:5 pts:5120 pts_time:0.106667 fmt:fltp channels:3 chlayout:3 channels (FL+FR+LFE) rate:48000 nb_samples:1024 checksum:DEADBEEF plane_checksums: [ DEADBEEF 0BADF00D 0000FFFF ]', truth: { n: 5, pts: 5120, ptsTime: 0.106667, rate: 48000, nbSamples: 1024, checksum: 0xDEADBEEF } },
  { name: 'pts_time in exponent form', message: 'n:12 pts:9876543210 pts_time:1.23457e+06 fmt:s16 channels:1 chlayout:mono rate:8000 nb_samples:320 checksum:00C0FFEE plane_checksums: [ 00C0FFEE ]', truth: { n: 12, pts: 9876543210, ptsTime: 1234570, rate: 8000, nbSamples: 320, checksum: 0x00C0FFEE } },
];
// Four foreign texts: letters; digits and brackets that LOOK like the rest of a record; a prefixed one; one that
// begins with a TAB (the lookahead after the checksum digits is a literal space, not any whitespace).
const FOREIGN = ['no frame!', '12 34] [ DEADBEEF ', '[s16le @ 0x1] [error] boom ', '\tboom '];

// Every (shape, offset, foreign text, layout) case. `cut` = where the foreign text lands in the message;
// `lines` = what ffmpeg would print (same layout: the rest of the record on the same line; next: on the next line).
function* tornCases() {
  for (const shape of SHAPES) {
    const m = shape.message;
    const hexStart = m.indexOf('checksum:') + 'checksum:'.length;
    const hexEnd = hexStart + 8;
    for (let cut = 0; cut <= m.length; cut += 1) {
      for (const foreign of FOREIGN) {
        yield { shape, cut, hexStart, hexEnd, foreign, layout: 'same', lines: [`${PREFIX}${m.slice(0, cut)}${foreign}${m.slice(cut)}`] };
        if (cut >= 1) yield { shape, cut, hexStart, hexEnd, foreign, layout: 'next', lines: [`${PREFIX}${m.slice(0, cut)}${foreign}`, ...(m.slice(cut) ? [`${PREFIX}${m.slice(cut)}`] : [])] };
      }
    }
  }
}

describe('#573 the log is byte-identical', () => {
  test('#573 C2: for the 18 real lines and every hostile case, the router forwards exactly what the OLD classifier did', () => {
    let checked = 0;
    const same = (line) => {
      const want = oldDecision(line);
      const { forwarded, records } = route([line]);
      assert.deepEqual(forwarded, want === 'forwarded' ? [line] : [], line);
      // The clock gets the record the old code reported lost whenever the first half is intact; never anything else.
      if (want === 'record') assert.equal(records.length, 1, line);
      checked += 1;
    };
    REAL.forEach(same);
    for (const c of tornCases()) {
      if (c.cut === 0) continue; // foreign text BEFORE `n:` is not a record tear (and `[x @ y] [error]` re-levels the line)
      same(c.lines[0]);
    }
    assert.ok(checked > 3000, `only ${checked} cases`);
  });

  test('#573 C2: a valid multi-word chlayout (`2 channels`, `3 channels (FL+FR+LFE)`) torn after the checksum is forwarded as before', () => {
    // The old rule decided on the WHOLE message: the word `channels` is foreign to isFragment, so the line was
    // forwarded even when nothing else was glued on. A decision on the remainder after the core would drop it.
    for (const layout of ['2 channels', '3 channels (FL+FR+LFE)']) {
      const core = `n:1 pts:1024 pts_time:0.0213333 fmt:s16 channels:${layout.startsWith('2') ? 2 : 3} chlayout:${layout} rate:48000 nb_samples:1024 checksum:AAAAAAAA `;
      for (const rest of ['plane_checksums: [ ', 'plane_checksums: [ AAAAAAAA ', FOREIGN_DTS]) {
        const line = `${PREFIX}${core}${rest}`;
        assert.equal(oldDecision(line), 'forwarded', `the oracle: ${line}`);
        const r = route([line]);
        assert.equal(r.records.length, 1, line);
        assert.deepEqual(r.forwarded, [line], line);
        assert.deepEqual(r.parseErrors, [], line);
      }
    }
  });

  test('#573 C2: a salvaged line with nothing foreign is NOT forwarded, and the untagged line after it is dropped (Rule B), as for the old fragment', () => {
    const line = `${PREFIX}${rec(4).core}plane_checksums: [ `;
    assert.equal(oldDecision(line), 'dropped');
    const r = route([line, '    second line of something']);
    assert.equal(r.records.length, 1);
    assert.deepEqual(r.forwarded, []);
    assert.equal(r.stats.dropped, 1, 'the untagged line followed the fate of the line before it');
  });

  test('#573 C2: the untagged line after a FORWARDED salvaged line is forwarded (Rule B), as after the old unparseable', () => {
    const torn = tornLines(4, { kind: 'after-core', foreign: FOREIGN_DTS })[0];
    const second = '    second line of the foreign message';
    const r = route([torn, second]);
    assert.equal(r.records.length, 1);
    assert.deepEqual(r.forwarded, [torn, second]);
    assert.equal(r.stats.unparseable, 1);
    assert.equal(r.stats.lostRecords, 0);
    assert.equal(r.stats.salvaged, 1);
  });

  test('#573 C2: identical torn lines in a row still collapse into ffmpeg\'s repeat note', () => {
    const torn = tornLines(4, { kind: 'after-core', foreign: FOREIGN_DTS })[0];
    const r = route([torn, torn]);
    assert.equal(r.records.length, 2);
    assert.deepEqual(r.forwarded, [torn, '    Last message repeated 1 times']);
  });

  test('#573 C2: 60 torn foreign lines inside one second take the SMALL bucket: 50 forwarded, then one note', () => {
    const lines = [];
    for (let n = 0; n < 60; n += 1) lines.push(tornLines(n, { kind: 'after-core', foreign: FOREIGN_DTS })[0]);
    const r = route(lines, SOUND, { monoNow: () => 1000 });
    assert.equal(r.records.length, 60, 'every one still reaches the clock');
    assert.equal(r.forwarded.length, 51);
    assert.deepEqual(r.forwarded.slice(0, 50), lines.slice(0, 50));
    assert.equal(r.forwarded[50], `[obs] 10 ffmpeg stderr line(s) not shown (rate limit); last: ${lines[59]}`);
    assert.equal(r.stats.suppressed, 10);
  });
});

// ===========================================================================================================
describe('#573 healthy lines unchanged', () => {
  test('#573 C3: every strictly valid line of the three real sound captures is the same plain record, with no extra key', () => {
    const STRICT = /^\[Parsed_ashowinfo_0 @ 0x[0-9a-f]+\] \[info\] n:(\d+) pts:(-?\d+) pts_time:(\S+) fmt:\S+ channels:\d+ chlayout:\S+ rate:(\d+) nb_samples:(\d+) checksum:([0-9A-F]{8}) plane_checksums: \[ (?:[0-9A-F]{8} )+\]\s*$/;
    let seen = 0;
    for (const f of ['sound-alaw8k.err', 'sound-aac16000.err', 'sound-aac48000.err']) {
      const lines = fs.readFileSync(path.join(FIX, f), 'utf8').split('\n').filter((l) => STRICT.test(l));
      assert.ok(lines.length > 5, f);
      for (const l of lines) {
        const m = STRICT.exec(l);
        const d = classifyLine(l, SOUND);
        assert.deepEqual(d, {
          kind: 'record',
          tap: 'audio',
          rec: { n: Number(m[1]), pts: Number(m[2]), ptsTime: Number(m[3]), rate: Number(m[4]), nbSamples: Number(m[5]), checksum: Number.parseInt(m[6], 16) },
        }, l);
        assert.deepEqual(Object.keys(d), ['kind', 'tap', 'rec'], l);
        assert.deepEqual(Object.keys(d.rec), ['n', 'pts', 'ptsTime', 'rate', 'nbSamples', 'checksum'], l);
        seen += 1;
      }
      const r = route(lines);
      assert.equal(r.stats.salvaged, 0, f);
      assert.equal(r.stats.records, lines.length, f);
      assert.deepEqual(r.forwarded, [], f);
    }
    assert.ok(seen > 30, `only ${seen} healthy lines`);
  });
});

// ===========================================================================================================
describe('#573 foreign text at every offset', () => {
  test('#573 C4: a cut before the checksum is never a record; every record has the TRUE clock fields; a cut after the first call always is one', () => {
    let records = 0;
    let notRecords = 0;
    for (const c of tornCases()) {
      const { shape, cut, hexStart, hexEnd, lines } = c;
      const why = `${shape.name} cut ${cut} ${c.layout} ${JSON.stringify(c.foreign)}`;
      const d = classifyLine(lines[0], SOUND);
      const r = route(lines);
      assert.equal(r.records.length, d.kind === 'record' ? 1 : 0, `${why}: the second line never adds a record`);
      if (cut <= hexStart) {
        assert.notEqual(d.kind, 'record', `${why}: cut before the checksum digits`);
      } else if (cut === hexEnd) {
        // `checksum:HEX` + foreign with no space between: the lookahead after the digits refuses all three texts.
        assert.notEqual(d.kind, 'record', `${why}: foreign text glued onto the digits`);
      }
      if (cut >= hexEnd + 1) {
        assert.equal(d.kind, 'record', why);
        assert.equal(d.salvaged, true, why);
        assert.deepEqual(d.rec, shape.truth, why);
        assert.deepEqual(r.parseErrors, [], why);
      } else if (d.kind === 'record') {
        // Only a cut INSIDE the 8 digits can get here (hex-looking foreign text): the five fields the clock reads
        // are still the true ones; only the checksum, which nothing reads, may differ.
        assert.ok(cut > hexStart && cut < hexEnd, why);
        const { checksum, ...fields } = d.rec;
        const { checksum: trueSum, ...truth } = shape.truth;
        assert.deepEqual(fields, truth, why);
        assert.ok(Number.isInteger(checksum) && trueSum !== undefined, why);
      }
      if (d.kind === 'record') records += 1; else notRecords += 1;
    }
    assert.ok(records > 400 && notRecords > 1500, `${records} records, ${notRecords} not`);
  });

  test('#573 C4: the same torn text on a MOTION tap (showinfo@in / showinfo@out) is never salvaged: still lost, still reported', () => {
    const messages = [...REAL.map((l) => l.replace(/^.*\[info\] /, '')), ...[...tornCases()].filter((c) => c.layout === 'same' && c.cut > c.hexEnd).slice(0, 60).map((c) => c.lines[0].slice(PREFIX.length))];
    for (const [tag, tap] of [['showinfo@in', 'in'], ['showinfo@out', 'out']]) {
      assert.deepEqual(Object.keys(MOTION).sort(), ['showinfo@in', 'showinfo@out']);
      for (const message of messages) {
        const line = `[${tag} @ 0x7f0000000002] [info] ${message}`;
        const d = classifyLine(line, MOTION);
        assert.notEqual(d.kind, 'record', line);
        const r = route([line], MOTION);
        assert.equal(r.records.length, 0, line);
        assert.deepEqual(r.parseErrors, [tap], line);
      }
    }
  });

  test('#573 C4: NOPTS torn after the core is not salvaged (it is still "no record")', () => {
    const core = rec(9).core.replace('pts:2880', 'pts:NOPTS').replace('pts_time:0.36', 'pts_time:NOPTS');
    assert.match(core, /pts:NOPTS pts_time:NOPTS/);
    const line = `${PREFIX}${core}${FOREIGN_DTS}`;
    assert.notEqual(classifyLine(line, SOUND).kind, 'record');
    const r = route([line]);
    assert.equal(r.records.length, 0);
    assert.deepEqual(r.parseErrors, ['audio']);
    assert.deepEqual(r.forwarded, [line]);
  });
});

// ===========================================================================================================
describe('#573 a salvaged record is delivered once, whatever surrounds it', () => {
  const SHAPE_CASES = [
    { kind: 'after-core', foreign: FOREIGN_DTS },
    { kind: 'after-open', foreign: FOREIGN_DTS },
    { kind: 'after-plane', foreign: FOREIGN_DTS },
  ];

  test('#573 C5: the tail line is a fragment (constructed from the grammar): exactly one record per torn record', () => {
    for (const shape of SHAPE_CASES) {
      const [first, tail] = tornLines(7, shape);
      const d = classifyLine(tail, SOUND);
      assert.deepEqual({ kind: d.kind, lost: d.lost }, { kind: 'fragment', lost: false }, tail);
      const r = route([first, tail]);
      assert.deepEqual(r.records.map((x) => x.n), [7], shape.kind);
      assert.equal(r.stats.fragments, 1, shape.kind);
      assert.deepEqual(r.parseErrors, [], shape.kind);
      assert.deepEqual(r.forwarded, [first], `only the torn first line reaches the log: ${shape.kind}`);
    }
  });

  test('#573 C6: split at EVERY byte offset through the line buffer, the result equals the unsplit one', () => {
    const stream = Buffer.from(`${[healthyLine(0), healthyLine(1), ...tornLines(2, SHAPE_CASES[1]), healthyLine(3), healthyLine(4)].join('\n')}\n`);
    const run = (chunks) => {
      const forwarded = [];
      const ns = [];
      const parseErrors = [];
      const router = createStderrRouter({ taps: SOUND, forward: (t) => forwarded.push(t), onRecord: (r) => ns.push(r.n), onParseError: (t) => parseErrors.push(t), monoNow: () => 0 });
      const lb = createLineBuffer((l) => router.line(l));
      for (const c of chunks) lb.write(c);
      lb.end();
      router.end();
      return { ns, forwarded, parseErrors, stats: router.stats() };
    };
    const whole = run([stream]);
    assert.deepEqual(whole.ns, [0, 1, 2, 3, 4]);
    for (let k = 1; k < stream.length; k += 1) {
      assert.deepEqual(run([stream.subarray(0, k), stream.subarray(k)]), whole, `split at byte ${k}`);
    }
  });

  test('#573 C7: a foreign line BETWEEN the two halves: one record, both foreign texts reach the log, the tail does not', () => {
    const [first, tail] = tornLines(7, SHAPE_CASES[0]);
    const error = '[aist#0:0/pcm_alaw @ 0x7f0000000009] [error] a real error in between';
    const r = route([first, error, tail]);
    assert.deepEqual(r.records.map((x) => x.n), [7]);
    assert.deepEqual(r.forwarded, [first, '[aist#0:0/pcm_alaw @ 0x7f0000000009] a real error in between']);
  });

  test('#573 C7: two torn records in a row, and a tear at the first record (n:0): every window observed', () => {
    for (const tears of [{ 100: tornLines(100, SHAPE_CASES[0]), 101: tornLines(101, SHAPE_CASES[1]) }, { 0: tornLines(0, SHAPE_CASES[2]) }, { 0: tornLines(0, SHAPE_CASES[0]), 1: tornLines(1, SHAPE_CASES[0]) }]) {
      const rig = makeClock('sound');
      const pipe = pipeline(rig);
      play(rig, pipe, 0, 400, { tear: tears });
      const o = finish(rig, pipe);
      assert.equal(o.length, 80, JSON.stringify(Object.keys(tears)));
      assert.ok(o.every((x) => x.cls === 'observed'), JSON.stringify(Object.keys(tears)));
      assert.equal(pipe.delivered.length, 400);
    }
  });

  test('#573 C7: PINNED, not changed: a first record with n > 0, and a complete record printed twice, still open the hole', () => {
    const first = makeClock('sound');
    const p1 = pipeline(first);
    play(first, p1, 0, 400, { nOf: (i) => i + 37 });
    const o1 = finish(first, p1);
    assert.ok(o1.every((x) => x.cls === 'unknown' && x.reason === 'hole'), 'first record n=37: holeAt = 0, every window unknown');

    const twice = makeClock('sound');
    const p2 = pipeline(twice);
    play(twice, p2, 0, 400, { dup: [20] });
    const o2 = finish(twice, p2);
    assert.equal(o2[0].cls, 'observed');
    assert.deepEqual([o2.at(-1).cls, o2.at(-1).reason], ['unknown', 'hole'], 'a duplicated complete record (n does not advance) is a hole');
  });
});

// ===========================================================================================================
describe('#573 a lost core still blinds the run, with one warning', () => {
  const broke = (rig) => rig.logs.filter((l) => l.includes('timestamp sequence broke'));
  const WORDING = (id, why) => `[obs] "Cam" sound gen=${id} timestamp sequence broke (${why}): the rest of this ffmpeg run's windows are reported UNKNOWN. This is the timestamp measurement only; whether the sampler is alive is told by the [sound] ambient= lines and the stored sound_windows per minute`;

  test('#573 C8: a glue inside the core: the hole opens exactly as before (R1-F11), and ONE warning names why', () => {
    const rig = makeClock('sound');
    const pipe = pipeline(rig);
    play(rig, pipe, 0, 400, { tear: { 50: lostCoreLines(50) } });
    const o = finish(rig, pipe);
    // The hole sits at record 50's position, 2.0 s of media: windows ending by then are observed, later ones are not.
    assert.ok(o.slice(0, 10).every((x) => x.cls === 'observed'));
    assert.ok(o.slice(10).every((x) => x.cls === 'unknown' && x.reason === 'hole'), JSON.stringify(o[10]));
    assert.deepEqual(pipe.parseErrors, ['audio']);
    assert.deepEqual(broke(rig), [WORDING(pipe.gen.id, 'a record failed to parse')]);
    assert.equal(rig.clock.summary().side, 'ok', 'the first windows were placed: a partial loss reads ok and shows in unknown');
  });

  test('#573 C8: a second hole in the same generation does not warn again', () => {
    const rig = makeClock('sound');
    const pipe = pipeline(rig);
    play(rig, pipe, 0, 400, { tear: { 50: lostCoreLines(50), 200: lostCoreLines(200) } });
    finish(rig, pipe);
    assert.equal(broke(rig).length, 1);
  });

  test('#573 C8: a flapping camera (a new generation each time) warns once per period, and a new period may warn again', () => {
    const rig = makeClock('sound');
    for (let g = 0; g < 4; g += 1) {
      const pipe = pipeline(rig);
      play(rig, pipe, 0, 100, { tear: { 20: lostCoreLines(20) }, base: 100_000 + g * 20_000 });
      rig.t.mono = 100_000 + g * 20_000 + 10_000;
      pipe.gen.end('exit', { code: 0 });
    }
    assert.equal(broke(rig).length, 1, 'four generations, four holes, one warning in this period');
    rig.clock.resetPeriod();
    const pipe = pipeline(rig);
    play(rig, pipe, 0, 100, { tear: { 20: lostCoreLines(20) }, base: 300_000 });
    assert.equal(broke(rig).length, 2, 'the next period may warn again');
    assert.equal(broke(rig)[1], WORDING(pipe.gen.id, 'a record failed to parse'));
  });

  test('#573 C8: the other ways into the same hole are worded as such: an n that restarts at 0, and a first record with n > 0', () => {
    const reset = makeClock('sound');
    const p1 = pipeline(reset);
    play(reset, p1, 0, 200, { nOf: (i) => (i < 100 ? i : i - 100) });
    assert.deepEqual(broke(reset), [WORDING(p1.gen.id, 'n jumped 99 -> 0')]);

    const late = makeClock('sound');
    const p2 = pipeline(late);
    play(late, p2, 0, 50, { nOf: (i) => i + 37 });
    assert.deepEqual(broke(late), [WORDING(p2.gen.id, 'the first record was n=37')]);
  });

  test('#573 C8: a throwing log cannot undo the hole or count as `warn`', () => {
    const t = { mono: 100_000 };
    const obs = [];
    const clock = new ObservationClock('cam', 'sound', {
      clocks: { monoNow: () => t.mono, wallNow: () => t.mono + WALL0 },
      label: 'Cam',
      log: () => { throw new Error('log sink down (planted)'); },
      onObservation: (o) => obs.push(o),
    });
    const rig = { t, clock, obs, logs: [] };
    const pipe = pipeline(rig);
    assert.doesNotThrow(() => play(rig, pipe, 0, 400, { tear: { 50: lostCoreLines(50) } }));
    const o = finish(rig, pipe);
    assert.equal(clock.summary().warn, 0, 'a throw inside the warning is not a caught clock exception');
    assert.notEqual(pipe.gen.holeAt, null, 'the hole state survived');
    assert.ok(o.slice(10).every((x) => x.cls === 'unknown' && x.reason === 'hole'));
    assert.ok(o.slice(0, 10).every((x) => x.cls === 'observed'));
  });
});

// ===========================================================================================================
describe('#573 records that stay unparseable forever', () => {
  test('#573 C9: every core damaged: no record reaches the clock, the one-off unavailable line appears once, nothing grows', () => {
    const rig = makeClock('sound');
    const pipe = pipeline(rig);
    const tear = {};
    for (let i = 0; i < 200; i += 1) tear[i] = lostCoreLines(i);
    assert.doesNotThrow(() => play(rig, pipe, 0, 200, { tear }));
    finish(rig, pipe, 100_000 + 200 * 40 + 10_000);
    assert.equal(pipe.delivered.length, 0);
    assert.equal(pipe.parseErrors.length, 200);
    assert.equal(rig.logs.filter((l) => l.includes('side-channel unavailable (no tap records)')).length, 1);
    assert.equal(rig.logs.filter((l) => l.includes('timestamp sequence broke')).length, 0, 'no record ever arrived to open a hole');
    assert.deepEqual(pipe.gen.sizes().records, 0);
    assert.ok(pipe.gen.sizes().disc <= 1 && pipe.gen.sizes().refFloor <= 1);
  });
});

// ===========================================================================================================
describe('#573 the warning plumbing', () => {
  test('#573 C12: logWarn falls back to the injected `log`, and an injected `warn` takes it instead', () => {
    const rig = makeClock('sound');
    rig.clock.logWarn('a warning line');
    assert.deepEqual(rig.logs, ['a warning line']);

    const logs = [];
    const warns = [];
    const clock = new ObservationClock('cam', 'sound', { log: (l) => logs.push(l), warn: (l) => warns.push(l) });
    clock.logWarn('only to warn');
    assert.deepEqual({ logs, warns }, { logs: [], warns: ['only to warn'] });
  });

  test('#573 C12: with neither injected, the warning goes to logger.warn (and the ordinary line to logger.info)', () => {
    const seen = { warn: [], info: [] };
    const realWarn = logger.warn;
    const realInfo = logger.info;
    logger.warn = (...a) => seen.warn.push(a.join(' '));
    logger.info = (...a) => seen.info.push(a.join(' '));
    try {
      const clock = new ObservationClock('cam', 'sound', {});
      clock.logWarn('production warning');
      clock.log('production info');
    } finally {
      logger.warn = realWarn;
      logger.info = realInfo;
    }
    assert.deepEqual(seen, { warn: ['production warning'], info: ['production info'] });
  });
});
