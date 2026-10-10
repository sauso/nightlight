// An ntfy alert must survive a camera or child name that contains a line break (issue #551).
//
// The defect: `sendNtfy` puts the title (and, with a snapshot, the message) in HTTP headers. `headerSafe` only
// stripped characters above U+00FF, and \r and \n are inside that range, so Node's `fetch` threw
// "invalid header value", the send was logged as "send failed (network)", and ntfy silently stopped for that
// camera while the other channels still worked. The likely cause is a stray newline pasted into a name.
//
// ⚠️ A REAL HTTP SERVER, NOT A STUB. The bug lives in what fetch accepts, so a fake `fetch` would pass against
// the broken code. The server records exactly what arrives; a send that throws never reaches it, which is how
// each case below fails without the fix.
//
// ⚠️ THE BODY IS NOT A HEADER. The nightly sleep report is a multi-line message sent as the request body when
// there is no snapshot. Flattening newlines everywhere would "fix" the crash by wrecking that report, so one
// case pins that the body keeps its line break.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { useTempDataDir, cleanupTempDataDirs } from './helpers/harness.js';

useTempDataDir();

const { default: db } = await import('../src/db.js');
const { sendNtfy } = await import('../src/lib/ntfy.js');

let server;
let received;

before(async () => {
  server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received.push({ headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(200).end('ok');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
});

after(async () => {
  await new Promise((r) => server.close(r));
  cleanupTempDataDirs();
});

beforeEach(() => {
  received = [];
  db.prepare("UPDATE settings SET ntfy_enabled = 1, ntfy_server_url = ?, ntfy_topic = 'nightlight-test' WHERE id = 'app'")
    .run(`http://127.0.0.1:${server.address().port}`);
});

test('a newline in the title is sent as a space, not rejected', async () => {
  const result = await sendNtfy({ title: 'Nursery\nCam - motion', message: 'hello', priority: 3 });
  assert.deepEqual(result, { ok: true }, `the send failed: ${JSON.stringify(result)}`);
  assert.equal(received.length, 1, 'nothing reached the server');
  assert.equal(received[0].headers.title, 'Nursery Cam - motion');
});

test('\\r\\n, a tab, other control characters and DEL in a title are all neutralised', async () => {
  const result = await sendNtfy({ title: 'A\r\nB\tC\u0007D\u007fE', message: 'x' });
  assert.deepEqual(result, { ok: true });
  assert.equal(received[0].headers.title, 'A B C D E');
});

test('a newline in the message header (a snapshot is attached) is neutralised and the image is the body', async () => {
  const image = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x0a, 0x0d, 0x00, 0xff, 0xd9]); // bytes that look like line breaks
  const result = await sendNtfy({ title: 'T', message: 'Child A\nmoved', image });
  assert.deepEqual(result, { ok: true });
  assert.equal(received[0].headers.message, 'Child A moved');
  assert.ok(received[0].body.equals(image), 'the snapshot bytes must be sent untouched');
});

test('★ the BODY keeps its line breaks: the multi-line sleep report must not be flattened', async () => {
  const report = 'Child A: asleep 10h40, 2 wakes, up 06:28\nChild B: asleep 10h39, 3 wakes, up 06:28';
  const result = await sendNtfy({ title: 'Sleep reports ready', message: report });
  assert.deepEqual(result, { ok: true });
  assert.equal(received[0].body.toString('utf8'), report);
});

test('a plain title and the original latin1 stripping still behave as before', async () => {
  const result = await sendNtfy({ title: 'Nursery Cam - motion 😀 café', message: 'm' });
  assert.deepEqual(result, { ok: true });
  // The emoji is above U+00FF and is dropped (as before); the accented letter is latin1 and kept.
  assert.equal(received[0].headers.title, 'Nursery Cam - motion  café');
});

// #643 N7: the nightly sleep report is the ntfy BODY, and #551 made the title/header path stricter without touching
// it. "The body is unchanged" was only pinned for line breaks, so a refactor that sent `String(message || '')` (no
// Latin-1 strip, no trim) would still have passed. These pin what the body has always been, byte for byte, by
// comparing the bytes the server received. They describe the CURRENT behaviour, not an endorsement of it: the strip
// drops an emoji or an em dash from a report body even though a body could carry them (a known limit, left as it
// was because changing what people already receive is a separate decision).
const BODY_EMOJI = String.fromCodePoint(0x1f600);
const BODY_EM_DASH = String.fromCodePoint(0x2014);
const BODY_E_ACUTE = String.fromCodePoint(0xe9);

test('#643 N7: the report body is sent byte for byte: inner line breaks, blank lines, CR LF and tabs untouched', async () => {
  const report = ['Child A: asleep 10h40, 2 wakes', '', 'Child B:\tasleep 10h39, 3 wakes', 'last\r\nline'].join('\n');
  assert.deepEqual(await sendNtfy({ title: 'Sleep reports ready', message: report }), { ok: true });
  assert.ok(received[0].body.equals(Buffer.from(report, 'utf8')), `body was ${JSON.stringify(received[0].body.toString('utf8'))}`);
});

test('#643 N7: characters outside Latin-1 are stripped from the body, Latin-1 letters are kept (sent as UTF-8)', async () => {
  const message = `Caf${BODY_E_ACUTE}: asleep ${BODY_EMOJI} 10h40 ${BODY_EM_DASH} up`;
  assert.deepEqual(await sendNtfy({ title: 'T', message }), { ok: true });
  assert.ok(received[0].body.equals(Buffer.from('Caf' + BODY_E_ACUTE + ': asleep  10h40  up', 'utf8')),
    `body was ${JSON.stringify(received[0].body.toString('utf8'))}`);
});

test('#643 N7: leading and trailing whitespace of the body is trimmed, and only that', async () => {
  assert.deepEqual(await sendNtfy({ title: 'T', message: ' \n\t Child A: up 06:28\nChild B: up 06:28 \r\n ' }), { ok: true });
  assert.ok(received[0].body.equals(Buffer.from('Child A: up 06:28\nChild B: up 06:28', 'utf8')),
    `body was ${JSON.stringify(received[0].body.toString('utf8'))}`);
});

test('#643 N7: a missing message sends an empty body, not the text "undefined"', async () => {
  assert.deepEqual(await sendNtfy({ title: 'T' }), { ok: true });
  assert.equal(received[0].body.length, 0);
});
