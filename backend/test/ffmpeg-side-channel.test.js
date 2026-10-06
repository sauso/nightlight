// ffmpegSideChannel.js: the stderr router, the record grammar, the tap builders and Adler-32 (issue #373
// Stage 2, plan v4 §A and §Tests 1-2).
//
// ★ THE ORACLES ARE CAPTURED, NOT COMPUTED (C7). Every fixture under fixtures/obs/ is literal ffmpeg 8.1.2
// output (capture.sh, capture-v4.sh). Where a test needs "the right answer" it reads it from the capture
// with its own small regex, or from zlib, never from the module under test:
//   - Adler-32 is checked against showinfo's own `out` checksums over the stdout bytes it wrote, and
//     against zlib's Adler-32 (init 1, converted);
//   - "error text is unchanged" is checked against the SAME run captured under today's `-loglevel error`;
//   - Node's repeat collapse is checked against ffmpeg's own collapse of the same input;
//   - the glued-line cases are real cross-thread glue from interleave-mix-rel.err.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import {
  adler32, ADLER_INIT, buildMotionTaps, buildSoundTaps, classifyLine, createStderrRouter,
  SIDE_CHANNEL_LOG_ARGS, MOTION_TAP_IN, MOTION_TAP_OUT,
} from '../src/lib/ffmpegSideChannel.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, 'fixtures', 'obs');
const read = (name) => fs.readFileSync(path.join(FIX, name));
const lines = (name) => read(name).toString('utf8').split('\n').filter((l) => l.trim());
const norm = (l) => l.replace(/0x[0-9a-f]+/g, '0xADDR'); // ASLR differs per run; nothing else is touched

const LEAN = buildMotionTaps({ fps: 5, width: 320, height: 180 }).taps;
const SOUND = buildSoundTaps().taps;
// The v3 capture set used three named taps; mapping all three lets the real interleaving capture drive
// the classifier (the `pick` tap no longer exists in production).
const THREE = { 'showinfo@in': 'in', 'showinfo@pick': 'pick', 'showinfo@out': 'out' };

// An INDEPENDENT Adler-32: zlib's (init 1), read from the trailer of a zlib stream, converted to init 0.
// With init (a,b) = (1,0), after n bytes a1 = 1 + sum and b1 = n + sum of prefix sums; with (0,0) both lose
// exactly that, so a0 = a1 - 1 and b0 = b1 - n (mod 65521).
function zlibAdler0(buf) {
  const z = zlib.deflateSync(buf);
  const a1b1 = z.readUInt32BE(z.length - 4);
  const a0 = ((a1b1 & 0xffff) - 1 + 65521) % 65521;
  const b0 = (((a1b1 >>> 16) - (buf.length % 65521)) % 65521 + 65521) % 65521;
  return ((b0 << 16) | a0) >>> 0;
}

function route(input, taps, opts = {}) {
  const forwarded = [];
  const records = [];
  const configs = [];
  const parseErrors = [];
  const r = createStderrRouter({
    taps,
    forward: (t) => forwarded.push(t),
    onRecord: (x) => records.push(x),
    onConfig: (x) => configs.push(x),
    onParseError: (tap) => parseErrors.push(tap),
    ...opts,
  });
  for (const l of input) r.line(l);
  if (!opts.noEnd) r.end();
  return { forwarded, records, configs, parseErrors, stats: r.stats(), router: r };
}

describe('Adler-32 with an initial value of 0 (plan §B step 4)', () => {
  // The capture's own `out` records, read with a regex that knows nothing about the module's grammar.
  const outChecksums = (name) => lines(name)
    .filter((l) => /^\[showinfo@out @ /.test(l) && / n: *\d+ /.test(l))
    .map((l) => Number.parseInt(/checksum:([0-9A-F]{8})/.exec(l)[1], 16));

  test('equals showinfo\'s `out` checksum for every stdout frame of the lean 32x18 capture, and init 1 matches none', () => {
    const sums = outChecksums('lean-32x18.err');
    const gray = read('lean-32x18.gray');
    const size = 32 * 18;
    const frames = gray.length / size;
    assert.equal(frames, 15, 'the capture must be the 15-frame run (-t 3 at 5 fps)');
    // One more `out` record than stdout frames: the record fps emitted after muxing stopped (see
    // capture-v4.sh). That is the end-of-generation case, not an error in the capture.
    assert.equal(sums.length, 16);
    let init1Matches = 0;
    for (let k = 0; k < frames; k += 1) {
      const frame = gray.subarray(k * size, (k + 1) * size);
      assert.equal(adler32(frame), sums[k], `frame ${k}`);
      if (adler32(frame, 1) === sums[k]) init1Matches += 1;
    }
    assert.equal(init1Matches, 0, 'init 1 (zlib\'s) must not align any frame');
    assert.equal(ADLER_INIT, 0);
  });

  test('...and at the production geometry, 320x180', () => {
    const sums = outChecksums('lean-320x180.err');
    const gray = read('lean-320x180.gray');
    const size = 320 * 180;
    assert.equal(gray.length, 2 * size);
    for (let k = 0; k < 2; k += 1) assert.equal(adler32(gray.subarray(k * size, (k + 1) * size)), sums[k]);
  });

  test('agrees with zlib\'s own Adler-32 across its 5552-byte chunk boundary and at frame size', () => {
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed >>> 24; };
    for (const n of [0, 1, 2, 5551, 5552, 5553, 11104, 57600, 200000]) {
      const buf = Buffer.alloc(n);
      for (let i = 0; i < n; i += 1) buf[i] = rnd();
      assert.equal(adler32(buf), zlibAdler0(buf), `length ${n}`);
    }
    // All-0xFF is the worst case for the running sums.
    const max = Buffer.alloc(57600, 0xff);
    assert.equal(adler32(max), zlibAdler0(max));
  });
});

describe('the tap builders: one function owns the filter AND the tag map', () => {
  test('motion: two named lean taps around the detector\'s own chain', () => {
    const t = buildMotionTaps({ fps: 5, width: 320, height: 180 });
    assert.equal(t.filter, 'showinfo@in=checksum=0,fps=5,scale=320:180,format=gray,showinfo@out');
    assert.deepEqual(t.taps, { 'showinfo@in': 'in', 'showinfo@out': 'out' });
    assert.equal(MOTION_TAP_IN, 'showinfo@in');
    assert.equal(MOTION_TAP_OUT, 'showinfo@out');
  });

  test('ffmpeg 8.1.2 logs exactly those two tags for the lean chain (the capture settles the naming)', () => {
    const tags = new Set();
    for (const l of lines('lean-32x18.err')) {
      const m = /^\[(showinfo[^ \]]*) @ /.exec(l);
      if (m) tags.add(m[1]);
    }
    assert.deepEqual([...tags].sort(), Object.keys(LEAN).sort());
  });

  test('sound: one ashowinfo, whose instance is Parsed_ashowinfo_0 in every captured sound run', () => {
    assert.deepEqual(buildSoundTaps(), { filter: 'ashowinfo', taps: { Parsed_ashowinfo_0: 'audio' } });
    for (const f of ['sound-alaw8k.err', 'sound-aac16000.err', 'sound-aac48000.err']) {
      const tags = new Set(lines(f).map((l) => /^\[(\w*ashowinfo\w*) @ /.exec(l)?.[1]).filter(Boolean));
      assert.deepEqual([...tags], ['Parsed_ashowinfo_0'], f);
    }
  });

  test('the log args are the RELATIVE spelling: ffmpeg\'s own repeat collapse survives it and not the absolute one', () => {
    assert.deepEqual([...SIDE_CHANNEL_LOG_ARGS], ['-loglevel', '+level+info', '-nostats']);
    const repeats = (f) => lines(f).filter((l) => /^ {4}Last message repeated \d+ times$/.test(l)).length;
    assert.ok(repeats('loglevel-rel.err') > 10, 'the relative spelling keeps AV_LOG_SKIP_REPEATED');
    assert.equal(repeats('loglevel-abs.err'), 0, 'the absolute spelling clears it');
  });
});

describe('the record grammar, on real captured lines', () => {
  const tapLines = (name, tag) => lines(name).filter((l) => l.startsWith(`[${tag} @ `) && / n: *\d+ /.test(l));

  test('every lean `in` and `out` record parses, with the n and pts the line shows; `in` has no checksum', () => {
    for (const tag of ['showinfo@in', 'showinfo@out']) {
      const ls = tapLines('lean-32x18.err', tag);
      assert.ok(ls.length >= 15, tag);
      for (const l of ls) {
        const d = classifyLine(l, LEAN);
        assert.equal(d.kind, 'record', l);
        assert.equal(d.rec.n, Number(/ n: *(\d+)/.exec(l)[1]));
        assert.equal(d.rec.pts, Number(/ pts: *(-?\d+)/.exec(l)[1]));
        if (tag === 'showinfo@in') assert.equal(d.rec.checksum, null);
        else assert.equal(d.rec.checksum, Number.parseInt(/checksum:([0-9A-F]{8})/.exec(l)[1], 16));
      }
    }
  });

  test('every ashowinfo record at 8, 16 and 48 kHz parses with its rate and sample count', () => {
    for (const f of ['sound-alaw8k.err', 'sound-aac16000.err', 'sound-aac48000.err']) {
      const ls = tapLines(f, 'Parsed_ashowinfo_0');
      assert.ok(ls.length > 5, f);
      for (const l of ls) {
        const d = classifyLine(l, SOUND);
        assert.equal(d.kind, 'record', l);
        assert.equal(d.rec.rate, Number(/rate:(\d+)/.exec(l)[1]));
        assert.equal(d.rec.nbSamples, Number(/nb_samples:(\d+)/.exec(l)[1]));
        assert.equal(d.rec.pts, Number(/ pts:(-?\d+)/.exec(l)[1]));
      }
    }
  });

  test('an `out` record without its checksum is not a usable record', () => {
    const inLine = tapLines('lean-32x18.err', 'showinfo@in')[0];
    const asOut = inLine.replace('[showinfo@in @', '[showinfo@out @');
    assert.equal(classifyLine(asOut, LEAN).kind, 'fragment', 'nothing but record fields: dropped, and lost');
  });

  test('config lines carry the tap\'s time base', () => {
    const { configs } = route(lines('lean-32x18.err'), LEAN);
    assert.deepEqual(configs.filter((c) => c.dir === 'in').map((c) => [c.tap, c.tbNum, c.tbDen]), [['in', 1, 10], ['out', 1, 5]]);
  });
});

describe('★ the WHOLE grammar, anchored (plan v4 refinement 2): glued lines are never records', () => {
  test('a real glued record from ffmpeg 8.1.2 (another thread\'s error inside it) is forwarded, not parsed', () => {
    const glued = lines('interleave-mix-rel.err').find((l) => l.includes('mean:[Could not open encoder'));
    assert.ok(glued, 'the capture\'s glued record');
    const d = classifyLine(glued, THREE);
    assert.equal(d.kind, 'unparseable');
    assert.equal(d.lost, true);
    const { forwarded, records, parseErrors } = route([glued], THREE);
    assert.deepEqual(records, []);
    assert.deepEqual(forwarded, [glued], 'the glued error text reaches the log');
    assert.deepEqual(parseErrors, ['in'], 'and the clock is told a record was lost');
  });

  // #573 moved this test's expectation ON PURPOSE (the intent, "a glued error is never lost silently", is
  // kept). It used to say "never accepted as a record" for the audio line too, which pinned the very
  // behaviour that blinded the sound [obs] measurement: an audio line torn AFTER its first av_log call (the
  // part the clock reads) is a complete record, and throwing it away opened a permanent hole. Now, for the
  // audio line: the glued line ALWAYS reaches the log; a cut after the core (the `checksum:HEX ` token and
  // its space) gives exactly ONE record and no parse error; any earlier cut gives no record and exactly one
  // parse error. The motion lines are unchanged: never a record. The forwarding assertion is what keeps the
  // whole-grammar rule honest (it kills M-SC09/M-SC10, which a "record iff after the core" check alone lets
  // survive).
  test('an error glued in at ANY token boundary of a real record is never LOST silently: audio recovers after its core, motion never a record', () => {
    const recs = [
      { tag: 'in', line: lines('lean-32x18.err').find((l) => /^\[showinfo@in @ .* n: +3 /.test(l)) },
      { tag: 'out', line: lines('lean-32x18.err').find((l) => /^\[showinfo@out @ .* n: +3 /.test(l)) },
      { tag: 'audio', line: lines('sound-alaw8k.err').find((l) => / n:3 /.test(l)) },
    ];
    const taps = { ...LEAN, ...SOUND };
    const err = 'no frame!';
    let tried = 0;
    let audioRecovered = 0;
    let audioLost = 0;
    for (const { tag, line: rec } of recs) {
      assert.equal(classifyLine(rec, taps).kind, 'record', rec);
      const prefixEnd = rec.indexOf('] n:') + 2;
      // The end of the first av_log call, found with this test's own regex: `checksum:HEX ` is 9 + 8 + 1
      // characters; a cut at or after coreEnd + 1 leaves the whole first call intact.
      const ck = /checksum:[0-9A-F]{8}/.exec(rec);
      const coreEnd = ck ? ck.index + ck[0].length : Infinity;
      for (let i = prefixEnd + 1; i <= rec.length; i += 1) {
        if (i < rec.length && rec[i] !== ' ' && rec[i - 1] !== ' ' && rec[i] !== ']') continue;
        const glued = rec.slice(0, i) + err + rec.slice(i);
        const d = classifyLine(glued, taps);
        if (tag !== 'audio') {
          assert.notEqual(d.kind, 'record', glued);
        } else {
          const r = route([glued], taps);
          assert.ok(r.forwarded.includes(glued), `the glued line must reach the log: ${glued}`);
          if (i > coreEnd) {
            assert.equal(d.kind, 'record', glued);
            assert.equal(r.records.length, 1, glued);
            assert.equal(r.records[0].n, 3, glued);
            assert.deepEqual(r.parseErrors, [], glued);
            audioRecovered += 1;
          } else {
            assert.notEqual(d.kind, 'record', glued);
            assert.equal(r.records.length, 0, glued);
            assert.deepEqual(r.parseErrors, ['audio'], glued);
            audioLost += 1;
          }
        }
        tried += 1;
      }
    }
    assert.ok(tried > 40, `only ${tried} glue points tried`);
    assert.ok(audioRecovered >= 4 && audioLost >= 4, `audio cases: ${audioRecovered} recovered, ${audioLost} lost`);
  });

  test('the real glued COLOUR lines keep their error text; the leftover field fragments are dropped', () => {
    const cap = lines('interleave-mix-rel.err');
    const { forwarded } = route(cap, THREE);
    const gluedColour = cap.filter((l) => /\] \[info\] color_range:\S+(?: color_space:\S+)?[A-Z][a-z]/.test(l) || l.includes('color_range:unknownnon-existing'));
    assert.equal(gluedColour.length, 2, 'the two real glued colour lines');
    for (const l of gluedColour) assert.ok(forwarded.includes(l), l);
    const fragments = cap.filter((l) => /\] \[info\] (?: color_space| color_primaries|\d+ \d+ \d+\] stdev)/.test(l));
    assert.equal(fragments.length, 3, 'the three real leftover fragments');
    for (const l of fragments) assert.ok(!forwarded.includes(l), `a fragment reached the log: ${l}`);
    // And no complete record or colour line ever does.
    for (const l of forwarded) assert.doesNotMatch(l, /\] \[info\] (n: +\d+ pts: .*stdev:\[[\d. ]+\]|color_range:\S+ color_space:\S+ color_primaries:\S+ color_trc:\S+)$/);
  });
});

describe('the level filter, against a hostile matrix (plan §Tests 2)', () => {
  const inRec = lines('lean-32x18.err').find((l) => /^\[showinfo@in @ .* n: +2 /.test(l));
  const recMsg = inRec.slice(inRec.indexOf('] n:') + 2);
  const colour = 'color_range:unknown color_space:unknown color_primaries:unknown color_trc:unknown';
  const LEVELS = ['quiet', 'panic', 'fatal', 'error', 'warning', 'info', 'verbose', 'debug', 'trace'];
  const CONTEXTS = { none: '', one: '[h264 @ 0x7f0000001000] ', two: '[vist#0:0/h264 @ 0x7f0000002000] [dec:h264 @ 0x7f0000003000] ', tap: '[showinfo@in @ 0x7f0000004000] ' };

  test('records never reach the log; errors keep their text; everything under ERROR is dropped', () => {
    for (const level of LEVELS) {
      for (const [ctxName, ctx] of Object.entries(CONTEXTS)) {
        for (const [msgName, msg] of Object.entries({ record: recMsg, colour, text: 'something happened' })) {
          const line = `${ctx}[${level}] ${msg}`;
          const { forwarded, records } = route([line], LEAN);
          const isTapRecord = ctxName === 'tap' && level === 'info' && msgName === 'record';
          if (isTapRecord) {
            assert.equal(records.length, 1, line);
            assert.deepEqual(forwarded, [], line);
          } else if (['panic', 'fatal', 'error'].includes(level)) {
            assert.deepEqual(forwarded, [`${ctx}${msg}`], `stripped exactly the level token: ${line}`);
            assert.equal(records.length, 0);
          } else if (ctxName === 'tap' && level === 'info' && msgName === 'text') {
            assert.deepEqual(forwarded, [line], 'foreign text on a tap line is forwarded whole');
          } else {
            assert.deepEqual(forwarded, [], `dropped: ${line}`);
            assert.equal(records.length, 0);
          }
        }
      }
    }
  });
});

describe('forwarded text is byte-for-byte what `-loglevel error` printed (same run, both flags)', () => {
  test('the repeated-decoder-error run: same lines (addresses aside), the native repeat notes included', () => {
    const { forwarded, records } = route(lines('loglevel-rel.err'), LEAN);
    assert.deepEqual(records, []);
    const today = lines('loglevel-error.err').map(norm);
    assert.equal(today.length, 80);
    // The tail of both captures is thread-scheduled, so compare as a multiset...
    assert.deepEqual(forwarded.map(norm).sort(), [...today].sort());
    // ...and the deterministic head in order.
    assert.deepEqual(forwarded.map(norm).slice(0, 60), today.slice(0, 60));
  });

  test('a connection failure and fftools\' double-prefixed errors: identical, in order', () => {
    for (const [rel, err] of [['rtsp-refused-rel.err', 'rtsp-refused-error.err'], ['mjpeg-rel.err', 'mjpeg-error.err']]) {
      const { forwarded } = route(lines(rel), LEAN);
      assert.deepEqual(forwarded.map(norm), lines(err).map(norm), rel);
    }
  });
});

describe('★ Rule B: an untagged line takes the fate of the line before it (plan v4 refinement 1)', () => {
  test('a multi-line WARNING\'s second line is dropped with it (the real mjpeg capture)', () => {
    const cap = lines('mjpeg-rel.err');
    const continuation = cap.find((l) => l.startsWith('Consider increasing'));
    assert.ok(continuation);
    const { forwarded } = route(cap, LEAN);
    assert.ok(!forwarded.includes(continuation));
  });

  test('ffmpeg\'s own repeat note after an ERROR is forwarded; after a dropped line it is dropped', () => {
    const afterError = route(['[h264 @ 0x1] [error] bad', '    Last message repeated 3 times'], LEAN).forwarded;
    assert.deepEqual(afterError, ['[h264 @ 0x1] bad', '    Last message repeated 3 times']);
    const afterWarning = route(['[h264 @ 0x1] [warning] meh', '    Last message repeated 3 times'], LEAN).forwarded;
    assert.deepEqual(afterWarning, []);
    // The real case: interleave-rel.err is a per-frame WARNING with one orphaned repeat note.
    const real = route(lines('interleave-rel.err'), SOUND);
    assert.deepEqual(real.forwarded, []);
    assert.equal(real.stats.untagged, 1);
  });

  test('an untagged FIRST line of a stream is forwarded (nothing to inherit from: conservative)', () => {
    assert.deepEqual(route(['plain text, no level'], LEAN).forwarded, ['plain text, no level']);
  });

  test('an untagged line after a tap record or a continuation is dropped', () => {
    const inRec = lines('lean-32x18.err').find((l) => /^\[showinfo@in @ .* n: +2 /.test(l));
    assert.deepEqual(route([inRec, 'leftover'], LEAN).forwarded, []);
    assert.deepEqual(route(['[showinfo@in @ 0x1] [info] color_range:pc color_space:bt709 color_primaries:bt709 color_trc:bt709', 'leftover'], LEAN).forwarded, []);
  });
});

describe('★ decision B: identical forwarded lines are re-collapsed in Node', () => {
  test('the ABSOLUTE-level capture (no native collapse) comes out exactly as ffmpeg collapses it itself', () => {
    const abs = route(lines('loglevel-abs.err'), LEAN);
    assert.ok(abs.stats.collapsed > 50, 'there were repeats to collapse');
    const today = lines('loglevel-error.err').map(norm);
    assert.deepEqual(abs.forwarded.map(norm).sort(), [...today].sort());
    assert.deepEqual(abs.forwarded.map(norm).slice(0, 60), today.slice(0, 60));
  });

  test('N identical errors with tap records between them -> one line, then the repeat note; the next error in full', () => {
    const inRec = lines('lean-32x18.err').find((l) => /^\[showinfo@in @ .* n: +2 /.test(l));
    const input = [];
    for (let i = 0; i < 6; i += 1) input.push('[h264 @ 0x1] [error] no frame!', inRec);
    input.push('[h264 @ 0x1] [error] something else');
    const { forwarded } = route(input, LEAN);
    assert.deepEqual(forwarded, ['[h264 @ 0x1] no frame!', '    Last message repeated 5 times', '[h264 @ 0x1] something else']);
  });

  test('a repeat count still held when the generation ends is flushed, not lost', () => {
    const { forwarded } = route(['[x @ 0x1] [error] a', '[x @ 0x1] [error] a', '[x @ 0x1] [error] a'], LEAN);
    assert.deepEqual(forwarded, ['[x @ 0x1] a', '    Last message repeated 2 times']);
  });

  test('F4: an [error] then a [fatal] with the SAME words both reach the log (the fatal is not a "repeat")', () => {
    const { forwarded } = route(['[dec @ 0x1] [error] Decoding failed', '[dec @ 0x1] [fatal] Decoding failed', '[dec @ 0x1] [fatal] Decoding failed'], LEAN);
    assert.deepEqual(forwarded, ['[dec @ 0x1] Decoding failed', '[dec @ 0x1] Decoding failed', '    Last message repeated 1 times']);
  });

  test('a repeat of a SUPPRESSED line is never summarised under a line the log did not get', () => {
    const t = { now: 0 };
    const input = [];
    for (let i = 0; i < 50; i += 1) input.push(`junk ${i}`);
    input.push('junk X', 'junk X', 'junk X', '[e @ 0x1] [error] real');
    const { forwarded } = route(input, LEAN, { monoNow: () => t.now });
    assert.equal(forwarded.filter((l) => l.startsWith('    Last message repeated')).length, 0);
    assert.ok(forwarded.includes('[e @ 0x1] real'));
  });
});

describe('forwarding limits: two buckets, fatal exempt (R2-O5, R3-8)', () => {
  const frozen = () => { const t = { now: 1000 }; return { t, monoNow: () => t.now }; };

  test('50 distinct errors and a fatal in one delivery: every one forwarded', () => {
    const { monoNow } = frozen();
    const input = [];
    for (let i = 0; i < 50; i += 1) input.push(`[h264 @ 0x1] [error] error ${i}`);
    input.push('[fatal] the end');
    const { forwarded, stats } = route(input, LEAN, { monoNow });
    assert.equal(forwarded.length, 51);
    assert.equal(stats.suppressed, 0);
  });

  test('60 malformed tap lines then a real error: the error is forwarded (junk cannot starve it)', () => {
    const { monoNow } = frozen();
    const input = [];
    for (let i = 0; i < 60; i += 1) input.push(`[showinfo@in @ 0x1] [info] n: ${i} garbled`);
    input.push('[h264 @ 0x1] [error] the real one');
    const { forwarded, parseErrors } = route(input, LEAN, { monoNow });
    assert.equal(parseErrors.length, 60);
    assert.ok(forwarded.includes('[h264 @ 0x1] the real one'));
    assert.equal(forwarded.filter((l) => l.startsWith('[showinfo@in')).length, 50, 'the small bucket capped the junk at its burst');
    assert.match(forwarded.find((l) => l.startsWith('[obs]')), /^\[obs\] 10 ffmpeg stderr line\(s\) not shown \(rate limit\); last: \[showinfo@in @ 0x1\] \[info\] n: 59 garbled$/);
  });

  test('a drifted-format flood is capped at the burst, then at 10 lines/s, with a note carrying count and last text', () => {
    const { t, monoNow } = frozen();
    const lines500 = Array.from({ length: 500 }, (_, i) => `drifted line ${i}`);
    const r = route([], LEAN, { monoNow, noEnd: true });
    const router = createStderrRouter({ taps: LEAN, forward: (x) => r.forwarded.push(x), monoNow });
    for (const l of lines500) router.line(l);
    assert.equal(r.forwarded.length, 50);
    t.now += 1000;
    router.line('drifted line after one second');
    router.end();
    assert.equal(r.forwarded[50], '[obs] 450 ffmpeg stderr line(s) not shown (rate limit); last: drifted line 499');
    assert.equal(r.forwarded[51], 'drifted line after one second');
  });

  test('threshold sides: the small bucket\'s 50th line passes and its 51st does not; 10/s refills one line per 100 ms', () => {
    const { t, monoNow } = frozen();
    const out = [];
    const router = createStderrRouter({ taps: LEAN, forward: (x) => out.push(x), monoNow });
    for (let i = 0; i < 51; i += 1) router.line(`u${i}`);
    assert.equal(out.length, 50);
    t.now += 99;
    router.line('at 99 ms');
    assert.equal(out.length, 50, '0.99 of a token is not a token');
    t.now += 1;
    router.line('at 100 ms');
    assert.deepEqual(out.slice(50), ['[obs] 2 ffmpeg stderr line(s) not shown (rate limit); last: at 99 ms', 'at 100 ms']);
  });

  test('threshold sides: the error bucket passes 500 then stops; 50/s refills one per 20 ms; fatal is never suppressed', () => {
    const { t, monoNow } = frozen();
    const out = [];
    const router = createStderrRouter({ taps: LEAN, forward: (x) => out.push(x), monoNow });
    for (let i = 0; i < 501; i += 1) router.line(`[x @ 0x1] [error] e${i}`);
    assert.equal(out.length, 500);
    router.line('[x @ 0x1] [fatal] still here');
    router.line('[panic] and this');
    assert.deepEqual(out.slice(500), ['[obs] 1 ffmpeg stderr line(s) not shown (rate limit); last: [x @ 0x1] e500', '[x @ 0x1] still here', 'and this']);
    t.now += 19;
    router.line('[x @ 0x1] [error] at 19 ms');
    assert.equal(out.at(-1), 'and this');
    t.now += 1;
    router.line('[x @ 0x1] [error] at 20 ms');
    assert.equal(out.at(-1), '[x @ 0x1] at 20 ms');

    // A second, fresh bucket for the other side: 19.7 ms after draining is 0.985 of a token at 50/s — but a
    // whole one at 51/s. (One accrual step only: several partial steps add up in floating point.)
    const t2 = { now: 5000 };
    const out2 = [];
    const r2 = createStderrRouter({ taps: LEAN, forward: (x) => out2.push(x), monoNow: () => t2.now });
    for (let i = 0; i < 500; i += 1) r2.line(`[x @ 0x1] [error] e${i}`);
    t2.now += 19.7;
    r2.line('[x @ 0x1] [error] at 19.7 ms');
    assert.equal(out2.length, 500, 'still no token at 19.7 ms');
  });
});

describe('the router is guarded: a throw can never escape into the stderr listener', () => {
  test('a throwing classifier forwards the RAW line and counts it', () => {
    const { forwarded, stats } = route(['[x @ 0x1] [info] anything', 'second'], LEAN, { classify: () => { throw new Error('boom'); } });
    assert.deepEqual(forwarded, ['[x @ 0x1] [info] anything', 'second']);
    assert.equal(stats.classifierErrors, 2);
  });

  test('F5: with a throwing classifier, 51 distinct [fatal] lines at one instant are ALL forwarded; ordinary lines are capped', () => {
    const boom = () => { throw new Error('boom'); };
    const fatals = Array.from({ length: 51 }, (_, i) => `[vist#0:0 @ 0x1] [fatal] fatal ${i}`);
    const f = route(fatals, LEAN, { classify: boom, monoNow: () => 1000 });
    assert.equal(f.forwarded.length, 51);
    assert.deepEqual(f.forwarded, fatals, 'raw, as the failure path forwards them');
    const panics = Array.from({ length: 51 }, (_, i) => `[panic] panic ${i}`);
    assert.equal(route(panics, LEAN, { classify: boom, monoNow: () => 1000 }).forwarded.length, 51);
    // The control: the same count of ordinary lines on that path is rate-limited (50 + one summary note).
    const plain = Array.from({ length: 51 }, (_, i) => `[x @ 0x1] [error] e ${i}`);
    const p = route(plain, LEAN, { classify: boom, monoNow: () => 1000 });
    assert.equal(p.forwarded.length, 51);
    assert.equal(p.forwarded.filter((l) => l.startsWith('[x @')).length, 50);
  });

  test('a throwing clock callback is counted; the record still never reaches the log', () => {
    const rec = lines('lean-32x18.err').find((l) => /^\[showinfo@in @ .* n: +2 /.test(l));
    const cfg = lines('lean-32x18.err').find((l) => l.includes('config in time_base'));
    const boom = () => { throw new Error('clock down'); };
    const { forwarded, stats } = route([cfg, rec, '[showinfo@in @ 0x1] [info] n: 9 garbled'], LEAN, { onRecord: boom, onConfig: boom, onParseError: boom });
    assert.deepEqual(forwarded, ['[showinfo@in @ 0x1] [info] n: 9 garbled']);
    assert.equal(stats.callbackErrors, 3);
  });

  test('a throwing log sink is counted, not propagated', () => {
    const r = createStderrRouter({ taps: LEAN, forward: () => { throw new Error('log down'); } });
    r.line('[x @ 0x1] [error] e');
    r.end();
    assert.equal(r.stats().callbackErrors, 1);
  });

  test('lines after end() are ignored, and end() is idempotent', () => {
    const out = [];
    const r = createStderrRouter({ taps: LEAN, forward: (x) => out.push(x) });
    r.line('[x @ 0x1] [error] a');
    r.line('[x @ 0x1] [error] a');
    r.end();
    r.end();
    r.line('[x @ 0x1] [error] late');
    assert.deepEqual(out, ['[x @ 0x1] a', '    Last message repeated 1 times']);
  });
});
