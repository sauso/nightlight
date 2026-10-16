// #536: fetchHttpSnapshot (lib/snapshot.js) reads the admin-set camera snapshot URL on every detection alert.
// It used to follow redirects to any host and buffer the whole body with res.arrayBuffer(), so a misbehaving
// camera could make the backend hold an unbounded body per alert. Now: the body is streamed and abandoned at a
// byte cap, a declared Content-Length over the cap is refused before reading, and a redirect is not followed.
//
// REAL HTTP, no mocks: a local server plays the camera. The cases:
//   - a normal JPEG-sized body comes back byte for byte (the happy path must not regress);
//   - a body over the cap, sent WITHOUT a Content-Length (chunked), is abandoned: null, and the server sees its
//     socket torn down (so the stream is not left running);
//   - a Content-Length over the cap is refused (the server is never asked to send the body);
//   - a body of exactly the cap is accepted, one byte more is not (the boundary);
//   - a redirect is refused, and the redirect TARGET is never requested (the whole point of refusing it);
//   - the default cap is 5 MB (a literal here, not the exported constant: a test that derives its fixture from the
//     constant cannot fail when the constant is changed).
//   - a body that keeps arriving a byte at a time is cut off by the timer, which must outlive the headers (#702
//     review, SN11).
// NOT covered: a real camera.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { useTempDataDir, cleanupTempDataDirs } from './helpers/harness.js';

useTempDataDir();
const { fetchHttpSnapshot } = await import('../src/lib/snapshot.js');

const requested = []; // paths the "camera" was asked for
let aborted; // set when the client drops a streaming response
const closedPaths = new Set(); // request paths whose response the client closed (held-open responses only)
// Poll for the server to notice the client socket close: the close arrives a moment AFTER the function returns.
const closedWithin = async (path, ms) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (closedPaths.has(path)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return closedPaths.has(path);
};
let server;
let base;

before(async () => {
  server = createServer((req, res) => {
    requested.push(req.url);
    if (req.url === '/ok') {
      res.writeHead(200, { 'content-type': 'image/jpeg' });
      return res.end(Buffer.alloc(300_000, 7));
    }
    if (req.url === '/redirect') {
      res.writeHead(302, { location: `${base}/target` });
      return res.end();
    }
    if (req.url === '/target') {
      res.writeHead(200, { 'content-type': 'image/jpeg' });
      return res.end(Buffer.alloc(10, 1));
    }
    if (req.url === '/declared-big') {
      // Headers go out, the body never does and the response is never ended: only the declared-length guard can
      // return quickly. (It used to send 10 bytes and end, which made a client that skipped the guard fail on
      // a length mismatch instead of waiting, so deleting the guard went unnoticed: PR #702 review.)
      res.writeHead(200, { 'content-length': String(50 * 1024 * 1024), 'content-type': 'image/jpeg' });
      res.flushHeaders();
      res.on('close', () => closedPaths.add(req.url));
      return undefined;
    }
    if (req.url === '/redirect-open') {
      // A redirect whose body then stays open. Chunked, so the response is still "in progress" on the wire.
      res.writeHead(302, { location: `${base}/target`, 'content-type': 'text/plain' });
      res.write('moved');
      res.on('close', () => closedPaths.add(req.url));
      return undefined;
    }
    if (req.url.startsWith('/exact/')) {
      return res.end(Buffer.alloc(Number(req.url.split('/')[2]), 3));
    }
    if (req.url.startsWith('/chunked/')) {
      // Two writes and no Content-Length: the streaming count is the only guard that sees this body's size.
      const n = Number(req.url.split('/')[2]);
      res.writeHead(200, { 'content-type': 'image/jpeg' });
      res.write(Buffer.alloc(n - 1, 5));
      return res.end(Buffer.alloc(1, 5));
    }
    if (req.url === '/drip') {
      // Headers at once, then ONE byte every 50 ms for ever: always under the size cap, so only the timer can end it.
      res.writeHead(200, { 'content-type': 'image/jpeg' });
      res.flushHeaders();
      const timer = setInterval(() => res.write(Buffer.from([1])), 50);
      res.on('close', () => { clearInterval(timer); closedPaths.add(req.url); });
      return undefined;
    }
    if (req.url === '/endless') {
      // No Content-Length (chunked), and it never ends: only the cap can stop it.
      res.writeHead(200, { 'content-type': 'image/jpeg' });
      const timer = setInterval(() => res.write(Buffer.alloc(64 * 1024, 9)), 1);
      res.on('close', () => { clearInterval(timer); aborted = true; });
      return undefined;
    }
    res.statusCode = 404;
    return res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  cleanupTempDataDirs();
});

test('a normal image is returned byte for byte', async () => {
  const buf = await fetchHttpSnapshot(`${base}/ok`);
  assert.equal(buf.length, 300_000);
  assert.ok(buf.every((b) => b === 7));
});

test('a body that never ends is abandoned at the cap, and the connection is dropped', async () => {
  aborted = false;
  const t0 = Date.now();
  const buf = await fetchHttpSnapshot(`${base}/endless`, { maxBytes: 1024 * 1024 });
  assert.equal(buf, null);
  assert.ok(Date.now() - t0 < 4000, 'it waited for the timeout instead of stopping at the cap');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(aborted, true, 'the server was left streaming: the client did not tear the connection down');
});

test('a Content-Length over the cap is refused without waiting for the body', async () => {
  // Default 5 s stream timeout: returning in well under 1 s can only be the declared-length guard, since the
  // server never sends a byte of body.
  const t0 = Date.now();
  assert.equal(await fetchHttpSnapshot(`${base}/declared-big`, { maxBytes: 1024 }), null);
  assert.ok(Date.now() - t0 < 1000, 'it waited for the stream instead of refusing on the declared length');
});

// PR #702 review (P2, verified with a real HTTP probe): the early returns (a redirect, a declared length over
// the cap) left the response body unread and the timer cleared, so a camera that kept its body open kept the
// connection live and streaming after the function had returned. The base code at least closed it by timeout.
test('a Content-Length over the cap is refused and the connection is closed', async () => {
  closedPaths.delete('/declared-big');
  assert.equal(await fetchHttpSnapshot(`${base}/declared-big`, { maxBytes: 1024 }), null);
  assert.equal(await closedWithin('/declared-big', 2000), true, 'the server still sees the connection open');
});

test('a redirect whose body stays open is refused and the connection is closed', async () => {
  closedPaths.delete('/redirect-open');
  requested.length = 0;
  assert.equal(await fetchHttpSnapshot(`${base}/redirect-open`), null);
  assert.equal(await closedWithin('/redirect-open', 2000), true, 'the server still sees the connection open');
  assert.deepEqual(requested, ['/redirect-open'], 'the redirect target must not be requested');
});

// Post-merge review of PR #702 (mutant SN11): the timer must cover the BODY read, not only the wait for the headers.
// With `clearTimeout(timer)` moved to straight after `await fetch(...)` every other test here still passed, and a
// camera that answers at once and then drips its body (under the cap) held the alert, and the socket, for as long
// as it kept dripping. The race turns that hang into a failure instead of a stuck suite.
test('#702 review snapshot: a body that arrives one byte at a time is cut off at the timeout, and the connection is closed', async () => {
  closedPaths.delete('/drip');
  const HUNG = Symbol('hung');
  let deadline;
  const t0 = Date.now();
  const out = await Promise.race([
    fetchHttpSnapshot(`${base}/drip`, { timeoutMs: 600 }),
    new Promise((r) => { deadline = setTimeout(() => r(HUNG), 4000); }),
  ]);
  clearTimeout(deadline);
  assert.notEqual(out, HUNG, 'still reading the body after 4 s: the timeout does not cover the body read');
  assert.equal(out, null);
  assert.ok(Date.now() - t0 >= 500, 'it returned before the timeout, so something other than the timer ended it');
  assert.equal(await closedWithin('/drip', 2000), true, 'the server still sees the connection open');
});

test('exactly the cap is accepted; one byte more is not', async () => {
  assert.equal((await fetchHttpSnapshot(`${base}/exact/2048`, { maxBytes: 2048 })).length, 2048);
  assert.equal(await fetchHttpSnapshot(`${base}/exact/2049`, { maxBytes: 2048 }), null);
});

test('streaming boundary, with no Content-Length: exactly the cap is accepted; one byte more is not', async () => {
  assert.equal((await fetchHttpSnapshot(`${base}/chunked/2048`, { maxBytes: 2048 })).length, 2048);
  assert.equal(await fetchHttpSnapshot(`${base}/chunked/2049`, { maxBytes: 2048 }), null);
});

test('a redirect is not followed, and its target is never requested', async () => {
  requested.length = 0;
  assert.equal(await fetchHttpSnapshot(`${base}/redirect`), null);
  assert.deepEqual(requested, ['/redirect']);
});

test('the default cap is 5 MB', async () => {
  const five = 5 * 1024 * 1024;
  assert.equal((await fetchHttpSnapshot(`${base}/exact/${five}`)).length, five);
  assert.equal(await fetchHttpSnapshot(`${base}/exact/${five + 1}`), null);
});
