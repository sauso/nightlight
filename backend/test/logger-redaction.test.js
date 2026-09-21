// The logger is the last boundary before output reaches `docker logs`, the in-app log API, and the
// diagnostics bundle. A producer missing its own scrub must still be safe here.
import { test, beforeEach, afterEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

const { logger } = await import('../src/lib/logger.js');
const { createLineBuffer, forwardProcessLines, MAX_LINE_CHARS } = await import('../src/lib/processOutput.js');

const SECRET = 'RAW_LOG_SECRET_9f3a2c';

beforeEach(() => logger.clear());
afterEach(() => logger.clear());

describe('raw child-process log redaction', () => {
  test('scrubs RTSP and HTTP credentials from both console output and retained history', (t) => {
    const consoleLines = [];
    t.mock.method(console, 'log', (...args) => consoleLines.push(args.join(' ')));

    logger.raw('ffmpeg:test', `rtsp://admin:${encodeURIComponent(SECRET)}@cam/live: 401`);
    logger.raw('snapshot:test', `GET http://viewer:${SECRET}@cam/snapshot.jpg failed`);

    const published = [...consoleLines, ...logger.getRecent()].join('\n');
    assert.ok(!published.includes(SECRET), `raw credential reached a log sink: ${published}`);
    assert.ok(!published.includes(encodeURIComponent(SECRET)), `encoded credential reached a log sink: ${published}`);
    assert.match(published, /rtsp:\/\/admin:\*\*\*@cam\/live/);
    assert.match(published, /http:\/\/viewer:\*\*\*@cam\/snapshot\.jpg/);
  });

  test('drops a camera query string entirely, not just the value that looks like a credential', (t) => {
    // A query can be one opaque token with no key=value structure at all (an unencoded stand-in for
    // a base64 auth token) — nothing here looks like "a value to redact" under a key/value split, so
    // the whole query is dropped rather than partially preserved. See urlCredentials.js's own comment.
    const consoleLines = [];
    t.mock.method(console, 'log', (...args) => consoleLines.push(args.join(' ')));

    logger.raw('ffmpeg:test', `rtsp://cam/live?channel=1&token=${SECRET}`);

    const published = [...consoleLines, ...logger.getRecent()].join('\n');
    assert.ok(!published.includes(SECRET), `query credential reached a log sink: ${published}`);
    assert.match(published, /rtsp:\/\/cam\/live\[redacted\]/, 'the query string was not marked as redacted');
  });

  test('waits for a complete stderr line when credentials span arbitrary chunks', (t) => {
    const consoleLines = [];
    t.mock.method(console, 'log', (...args) => consoleLines.push(args.join(' ')));
    const stderr = createLineBuffer((line) => logger.raw('ffmpeg:test', line));

    stderr.write(Buffer.from('rtsp://admin:RAW_LOG_'));
    assert.deepEqual(logger.getRecent(), [], 'a partial credential was published before the line completed');
    stderr.write(Buffer.from('SECRET_9f3a2c@cam/live: 401\nnext'));
    stderr.end();

    const published = [...consoleLines, ...logger.getRecent()].join('\n');
    assert.ok(!published.includes(SECRET), `split credential reached a log sink: ${published}`);
    assert.match(published, /rtsp:\/\/admin:\*\*\*@cam\/live: 401/);
    assert.match(published, /next/, 'the final non-newline-terminated line was dropped');
  });

  test('bounds a child process line that never terminates, then resumes at the next line', () => {
    const lines = [];
    const stderr = createLineBuffer((line) => lines.push(line));
    stderr.write(Buffer.from('x'.repeat(64 * 1024 + 1)));
    stderr.write(Buffer.from('\nhealthy again\n'));
    stderr.end();
    assert.deepEqual(lines, ['[output line omitted: exceeded 64 KiB]', 'healthy again']);
  });

  test('★ THE FIX: a line that never terminates does not grow pending unboundedly across MANY writes', () => {
    // Found by adversarial review: the original cap only cleared `pending` on the transition INTO
    // discarding, not on every write while already discarding. The bug was invisible to a final-
    // output-shape assertion (the `discarding` flag alone still suppresses the eventual oversized
    // content once a newline finally arrives), which is why this checks pendingLength() directly,
    // DURING the accumulation, rather than only the end result — a buggy version passes the "final
    // lines" shape check below just as cleanly as a correct one, and only differs in how large
    // `pending` was allowed to grow in between.
    const lines = [];
    const stderr = createLineBuffer((line) => lines.push(line));
    stderr.write(Buffer.from('x'.repeat(MAX_LINE_CHARS + 1))); // crosses the cap, enters discarding
    for (let i = 0; i < 200; i++) {
      stderr.write(Buffer.from('y'.repeat(1024))); // ~200KB more, still no \n
      assert.ok(
        stderr.pendingLength() <= MAX_LINE_CHARS,
        `pending grew to ${stderr.pendingLength()} bytes while discarding — the cap is not being re-applied`
      );
    }
    stderr.write(Buffer.from('\nhealthy again\n'));
    stderr.end();
    // Exactly one omitted-line marker for the whole oversized run, then the next real line — never a
    // second marker, and never any of the raw 'x'/'y' content.
    assert.deepEqual(lines, ['[output line omitted: exceeded 64 KiB]', 'healthy again']);
  });

  test('does not flush on process exit before stderr has drained', () => {
    const proc = new EventEmitter();
    const stderr = new EventEmitter();
    const lines = [];
    forwardProcessLines(proc, stderr, (line) => lines.push(line));

    stderr.emit('data', Buffer.from('rtsp://admin:EXIT_RACE_'));
    proc.emit('exit', 1);
    assert.deepEqual(lines, [], 'process exit flushed a credential-bearing prefix');
    stderr.emit('data', Buffer.from('SECRET@camera/live\n'));
    stderr.emit('end');
    proc.emit('close', 1);

    assert.deepEqual(lines, ['rtsp://admin:EXIT_RACE_SECRET@camera/live']);
  });

  test('★ THE FIX: a genuinely incomplete trailing credential (no closing @) is reduced, not echoed raw', () => {
    // Found by adversarial review: at real end-of-stream (the process died mid-write, or simply never
    // emits a final newline), redactCredentials cannot redact a `//user:pass` that never reached its
    // closing '@' — it needs the whole shape in one string. The final emit() must not echo it as-is.
    const lines = [];
    const stderr = createLineBuffer((line) => lines.push(line));
    stderr.write(Buffer.from(`rtsp://admin:${SECRET}`)); // no trailing newline, no '@' — ever
    stderr.end();
    assert.equal(lines.length, 1);
    assert.ok(!lines[0].includes(SECRET), `an incomplete trailing credential survived: ${lines[0]}`);
  });

  test('a genuinely incomplete but credential-FREE trailing line still survives — the control', () => {
    const lines = [];
    const stderr = createLineBuffer((line) => lines.push(line));
    stderr.write(Buffer.from('camera reconnecting, attempt 3 of 5'));
    stderr.end();
    assert.deepEqual(lines, ['camera reconnecting, attempt 3 of 5']);
  });

  test('end is idempotent and ignores impossible late writes', () => {
    const lines = [];
    const stderr = createLineBuffer((line) => lines.push(line));
    stderr.write('last line');
    stderr.end();
    stderr.end();
    stderr.write('must not be published');
    assert.deepEqual(lines, ['last line']);
  });
});
