// Issue #539: the logger is the one place every log line passes through, so a camera name (or any other
// user-controlled string) containing a newline could forge a second, genuine-looking timestamped line in
// `docker logs`, the in-app viewer and the diagnostics bundle. These tests drive the PUBLIC logger only
// (not the helper), so each fails on the old code by behaviour, not by a missing export.
import { test, beforeEach, afterEach, describe } from 'node:test';
import assert from 'node:assert/strict';

const { logger } = await import('../src/lib/logger.js');
const { formatSummaryLine } = await import('../src/lib/observationClock.js');
// The two production paths that log an Error's multi-line stack (#709 review: ERROR level had only JSON fixtures).
const { reportGuardFailure, resetGuardRateLimit } = await import('../src/lib/processGuards.js');
const { errorHandler } = await import('../src/middleware/errorHandler.js');

const PREFIX = String.raw`\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}`;

beforeEach(() => logger.clear());
afterEach(() => logger.clear());

// Captures what reached console AND the retained buffer, so the two sinks are checked together.
function capture(t, fn) {
  const out = [];
  for (const m of ['log', 'warn', 'error']) t.mock.method(console, m, (...a) => out.push(a.join(' ')));
  fn();
  return { out, recent: logger.getRecent() };
}

describe('forged lines (#539)', () => {
  test('a newline-bearing camera name stays ONE line in both sinks', (t) => {
    const name = 'Nursery\n2026-10-02 03:12:00 [INFO] [auth] forged';
    const { out, recent } = capture(t, () => logger.info(`[oob] "${name}" OUT OF BED`));
    for (const sink of [out, recent]) {
      assert.equal(sink.length, 1);
      assert.ok(!/[\r\n]/.test(sink[0]), JSON.stringify(sink[0]));
      assert.equal(sink[0].split('\n').length, 1);
      // The forged text survives as visible data inside the one line, not as a line of its own.
      assert.match(sink[0], new RegExp(`^${PREFIX} \\[INFO\\] \\[oob\\] "Nursery\\\\n2026-10-02 03:12:00 \\[INFO\\] \\[auth\\] forged" OUT OF BED$`));
    }
  });

  test('CRLF, lone CR, and the level / raw-source fields are neutralised too', (t) => {
    const { recent } = capture(t, () => {
      logger.warn('a\r\nb\rc');
      logger.raw('ffmpeg:x\ny', 'line\nsplit');
      logger.error({ n: 'obj\nname' }); // JSON.stringify already escapes; must stay one line
    });
    assert.equal(recent.length, 3);
    for (const l of recent) assert.ok(!/[\r\n]/.test(l), JSON.stringify(l));
    assert.match(recent[0], /a\\r\\nb\\rc$/);
    assert.match(recent[1], /\[ffmpeg:x\\ny\] line\\nsplit$/);
  });
});

describe('ordering with credential redaction (#539)', () => {
  test('redaction sees the real newline: text after a stripped query is kept, and the credential is still gone', (t) => {
    // Escaping BEFORE redacting turns the newline into printable backslash-n, which the query-stripping
    // regex then reads as part of the URL and swallows the rest of the line (measured while writing this).
    const { recent } = capture(t, () => logger.info('open rtsp://admin:hunter2@cam/live?token=abc\nafter'));
    assert.ok(!recent[0].includes('hunter2'));
    assert.ok(!recent[0].includes('abc'));
    assert.ok(recent[0].endsWith('rtsp://admin:***@cam/live[redacted]\\nafter'), JSON.stringify(recent[0]));
  });
});

describe('every control character class is escaped (#539)', () => {
  const cases = [];
  // C0 except tab (0x09, deliberately kept), then DEL and the whole C1 block.
  for (let c = 0; c <= 0x1f; c++) if (c !== 0x09) cases.push(c);
  for (let c = 0x7f; c <= 0x9f; c++) cases.push(c);
  for (const code of cases) {
    const ch = String.fromCharCode(code);
    const want = code === 0x0a ? '\\n' : code === 0x0d ? '\\r' : `\\x${code.toString(16).padStart(2, '0')}`;
    test(`U+${code.toString(16).padStart(4, '0')} becomes ${want}`, (t) => {
      const { recent } = capture(t, () => logger.info(`<${ch}>`));
      assert.ok(recent[0].endsWith(`<${want}>`), JSON.stringify(recent[0]));
    });
  }

  test('U+2028 and U+2029 (Unicode line / paragraph separators) become \\u2028 / \\u2029', (t) => {
    const { recent } = capture(t, () => logger.info('a\u2028b\u2029c'));
    assert.ok(recent[0].endsWith('a\\u2028b\\u2029c'), JSON.stringify(recent[0]));
  });

  test('ESC (terminal control sequences) cannot reach the console raw', (t) => {
    const { out } = capture(t, () => logger.info('\u001b[2J\u001b[31mred'));
    assert.ok(!out[0].includes('\u001b'));
    assert.ok(out[0].endsWith('\\x1b[2J\\x1b[31mred'));
  });

  test('tab is kept: it cannot start a line, and child-process output carries it', (t) => {
    const { recent } = capture(t, () => logger.info('a\tb'));
    assert.ok(recent[0].endsWith('a\tb'));
  });

  // #709 review: a mutant that ALSO escaped U+200B survived, because no test said what must NOT change outside the
  // control classes. Each sample sits next to a range edge or is a format character a widened class would catch.
  // Built with fromCodePoint so no invisible character sits in this file's source. NOT pinned either way: the
  // bidirectional controls (U+202A-U+202E, U+2066-U+2069), which cannot start a line; that is a separate decision.
  test('zero-width, format and other non-control Unicode is returned byte-for-byte unchanged', (t) => {
    const cp = (...codes) => String.fromCodePoint(...codes);
    const samples = [
      ['zero-width space U+200B', cp(0x200b)],
      ['zero-width non-joiner and joiner U+200C, U+200D', cp(0x200c, 0x200d)],
      ['zero-width no-break space / BOM U+FEFF', cp(0xfeff)],
      ['soft hyphen U+00AD', cp(0xad)],
      ['no-break space U+00A0, the first code point after the C1 block', cp(0xa0)],
      ['tilde U+007E, the last code point before DEL', '~'],
      ['U+2027, the code point before the line separator', cp(0x2027)],
      ['accented Latin', cp(0xe9, 0xfc, 0xf1, 0xc5, 0xff)],
      ['emoji, a ZWJ family sequence and a skin-tone modifier', cp(0x1f600, 0x20, 0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467, 0x20, 0x1f44d, 0x1f3fd)],
      ['CJK and Hangul', cp(0x65e5, 0x672c, 0x8a9e, 0x20, 0xd55c, 0xad6d, 0xc5b4)],
      ['a right-to-left script', cp(0x5e9, 0x5dc, 0x5d5, 0x5dd)],
    ];
    const { out, recent } = capture(t, () => samples.forEach(([, text]) => logger.info(`<${text}>`)));
    samples.forEach(([label, text], i) => {
      const want = Buffer.from(`[INFO] <${text}>`, 'utf8');
      for (const sink of [out, recent]) {
        const got = Buffer.from(sink[i].slice(20), 'utf8');
        assert.ok(got.equals(want), `${label}: ${JSON.stringify(sink[i])}`);
      }
    });
  });
});

describe('ERROR level is neutralised like every other level (#709 review)', () => {
  // The existing ERROR fixtures were JSON objects, which JSON.stringify had already escaped, so a logger that
  // skipped neutralising at ERROR passed them. These are string messages, and the stacks the code really logs.
  const LOG_LINE = new RegExp(`^(${PREFIX}) \\[(INFO|WARN|ERROR)\\] (.*)$`);

  test('an ERROR string message with a forged line, CR and ESC stays one escaped line in both sinks', (t) => {
    const { out, recent } = capture(t, () => logger.error('[sleep] failed for "Cam\n2026-10-02 03:12:00 [INFO] forged"\r\x1b[2J'));
    for (const sink of [out, recent]) {
      assert.equal(sink.length, 1);
      assert.ok(!/[\r\n\x1b]/.test(sink[0]), JSON.stringify(sink[0]));
      assert.equal(sink[0].slice(20), '[ERROR] [sleep] failed for "Cam\\n2026-10-02 03:12:00 [INFO] forged"\\r\\x1b[2J');
    }
  });

  test('an Error stack logged by errorHandler and reportGuardFailure is ONE line the log viewer still filters', (t) => {
    resetGuardRateLimit();
    const err = new Error('boom for "Cam\nforged"');
    const res = { headersSent: false, status() { return this; }, json() { return this; } };
    const { out, recent } = capture(t, () => {
      errorHandler(err, { method: 'GET', originalUrl: '/api/x' }, res, () => {});
      reportGuardFailure('stack-test', err);
      logger.error('[x] two args:', err.stack);
    });
    assert.ok(err.stack.split('\n').length >= 3, 'the fixture must really be multi-line (message break + frames)');
    for (const sink of [out, recent]) {
      // Three calls, three entries: a stack is still ONE buffer entry, as it was before #539 (the viewer and the
      // bundle treat an entry as one opaque string), only now without a real line break inside it.
      assert.equal(sink.length, 3, sink.join(' || '));
      sink.forEach((l, i) => {
        assert.ok(!/[\r\n]/.test(l), JSON.stringify(l));
        const m = LOG_LINE.exec(l);
        assert.ok(m, l);
        assert.equal(m[2], 'ERROR');
        // The tag still opens the message, and the viewer's Errors chip (a substring match on "error") finds it.
        assert.match(m[3], [/^\[http\] GET \/api\/x: unhandled error \(answered 500\): /, /^\[guard:stack-test\] /, /^\[x\] two args: /][i]);
        assert.ok(l.toLowerCase().includes('error'));
        // Every break of the stack is still there, as visible text, followed by the frame it started.
        assert.ok(m[3].includes('Error: boom for "Cam\\nforged"\\n    at '), m[3]);
      });
    }
  });
});

describe('ordinary lines are byte-identical to before (golden, #539)', () => {
  // Each expected remainder is typed out literally, so this cannot drift with the code under test.
  const golden = [
    ['info', ['[detect] motion on "Camera A"'], '[INFO] [detect] motion on "Camera A"'],
    ['warn', ['x', 5, 'y'], '[WARN] x 5 y'],
    ['error', [{ a: 1, b: 'two' }], '[ERROR] {"a":1,"b":"two"}'],
    ['info', ['[oob] "Child A Cam" OUT OF BED — motion left the bed, quiet 6000ms since, outside peak 6.3%'],
      '[INFO] [oob] "Child A Cam" OUT OF BED — motion left the bed, quiet 6000ms since, outside peak 6.3%'],
    ['info', ['[wake] clip 12 ready for "Camera A" (31.5s from 2026-10-02 03:12:00Z)'],
      '[INFO] [wake] clip 12 ready for "Camera A" (31.5s from 2026-10-02 03:12:00Z)'],
    ['info', ['[push] sent to 2 subscribers — ünïcode ✓ 日本語 😀 C:\\data\\x'],
      '[INFO] [push] sent to 2 subscribers — ünïcode ✓ 日本語 😀 C:\\data\\x'],
    ['info', ['tab\tseparated'], '[INFO] tab\tseparated'],
  ];
  for (const [level, args, rest] of golden) {
    test(`${level}: ${rest.slice(0, 40)}`, (t) => {
      const { out, recent } = capture(t, () => logger[level](...args));
      assert.match(out[0], new RegExp(`^${PREFIX} `));
      assert.equal(out[0].slice(20), rest);
      assert.equal(recent[0], out[0]);
    });
  }

  test('raw() output keeps its shape and still strips MediaMTX\'s leading timestamp', (t) => {
    const { recent } = capture(t, () => logger.raw('mediamtx', '2026/07/20 04:54:39 INF [path cam] is ready'));
    assert.equal(recent[0].slice(20), '[mediamtx] INF [path cam] is ready');
  });
});

describe('log-line consumers still parse a normal line (#539)', () => {
  // Consumers of log TEXT in this repo: the in-app viewer (frontend/src/components/LogViewer.jsx, a
  // case-insensitive substring filter on the tag chips - tested in the frontend suite), the support
  // bundle (the buffer verbatim), and tests that pin the [obs] line. No script in scripts/ reads logs.
  // So the contract is: after the logger, the message is the same text behind "<ts> [LEVEL] ".
  const LINE = new RegExp(`^(${PREFIX}) \\[(INFO|WARN|ERROR)\\] (.*)$`);

  test('the pinned [obs] summary line round-trips through the logger unchanged', (t) => {
    const s = {
      label: 'Nursery Cam', leg: 'motion', gen: 3, path: 'cam-sub', samples: 4500, real: 4497, fpsClone: 1, cfrDup: 0,
      cfrDrop: 0, runsCapped: 0, unknown: 2, ambiguous: 1, reordered: 0, gaps: 0, gapMs: 0, restarts: 1, restartMs: 64_210,
      coverSampler: 0.999, coverAnalysis: 0.998, ageP50: 335.2, ageP99: 378.6, compressed: 0, clamps: 0,
      uncertain: 0, wallSteps: 0, side: 'ok', warn: 0, late: 0,
    };
    const obs = formatSummaryLine(s);
    const { recent } = capture(t, () => logger.info(obs));
    const m = LINE.exec(recent[0]);
    assert.ok(m, recent[0]);
    assert.equal(m[3], obs);
    assert.match(m[3], /^\[obs\] "Nursery Cam" motion gen=3 path=cam-sub samples=4500 real=4497 /);
  });

  test('the ffmpeg rate-limit [obs] notice (pinned by ffmpeg-side-channel.test.js) round-trips', (t) => {
    const notice = '[obs] 10 ffmpeg stderr line(s) not shown (rate limit); last: [showinfo@in @ 0x1] [info] n: 59 garbled';
    const { recent } = capture(t, () => logger.info(notice));
    assert.equal(LINE.exec(recent[0])[3], notice);
    assert.match(LINE.exec(recent[0])[3], /^\[obs\] 10 ffmpeg stderr line\(s\) not shown \(rate limit\); last: \[showinfo@in @ 0x1\] \[info\] n: 59 garbled$/);
  });

  test('[oob], [wake] and [push] lines keep their tag at the start of the message', (t) => {
    const lines = ['[oob] "A" OUT OF BED', '[wake] clip 1 ready for "A" (1.0s from 2026-10-02 03:12:00Z)', '[push] sent 1'];
    const { recent } = capture(t, () => lines.forEach((l) => logger.info(l)));
    assert.deepEqual(recent.map((l) => LINE.exec(l)[3]), lines);
  });
});
