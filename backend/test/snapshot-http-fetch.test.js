// fetchHttpSnapshot, the camera's own HTTP snapshot endpoint (issue #564, "a local fake server is enough").
//
// The module sat at 85% lines but 42% branches: every test that touched snapshots injected a fake `fetchHttp`
// (snapshot-single-flight, timelapse-capture), so the function that really talks to a camera ran in none of
// them. This drives it against a REAL http server on 127.0.0.1, which records what arrived, including the cases
// a camera really produces: auth embedded in the URL, a non-2xx, an empty body, a redirect, and one that never
// answers.
//
// Known limit, documented: digest auth is not supported (see the function's own comment) and a real camera's
// JPEG is not needed to check any of this, so the body here is a few marker bytes.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { useTempDataDir, cleanupTempDataDirs } from './helpers/harness.js';

useTempDataDir();

const { fetchHttpSnapshot } = await import('../src/lib/snapshot.js');

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02, 0xff, 0xd9]);
let server;
let base;
let seen;
let route; // (req, res) => void, set per test

before(async () => {
  server = createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization });
    route(req, res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  cleanupTempDataDirs();
});
beforeEach(() => {
  seen = [];
  route = (req, res) => res.writeHead(200, { 'content-type': 'image/jpeg' }).end(JPEG);
});

test('a 200 returns the exact bytes, and a plain URL sends no Authorization header', async () => {
  const img = await fetchHttpSnapshot(`http://${base}/snap.jpg`);
  assert.ok(Buffer.isBuffer(img));
  assert.ok(img.equals(JPEG), 'the bytes returned are not the bytes served');
  assert.equal(seen[0].auth, undefined);
});

test('★ credentials in the URL become a Basic header (decoded first) and never travel in the request line', async () => {
  // WHATWG fetch refuses a URL with userinfo, so without this move every camera that wants a login yields no
  // snapshot at all. The password has characters that only survive if percent-decoding happens before encoding.
  const img = await fetchHttpSnapshot(`http://admin:p%40ss%3Aword@${base}/snap.jpg?channel=1`);
  assert.ok(img?.equals(JPEG), 'a camera that needs a login returned no image');
  assert.equal(seen[0].auth, `Basic ${Buffer.from('admin:p@ss:word').toString('base64')}`);
  assert.equal(seen[0].url, '/snap.jpg?channel=1', 'the path and query must survive the credential move');
});

test('a non-2xx answer is null, not an error page treated as a picture', async () => {
  route = (req, res) => res.writeHead(401).end('<html>login</html>');
  assert.equal(await fetchHttpSnapshot(`http://${base}/snap.jpg`), null);
  route = (req, res) => res.writeHead(500).end('boom');
  assert.equal(await fetchHttpSnapshot(`http://${base}/snap.jpg`), null);
  assert.equal(seen.length, 2, 'the camera was asked both times; null is the answer, not a skipped request');
});

test('an empty 200 is null: a zero-byte "image" would be saved and pushed as a broken thumbnail', async () => {
  route = (req, res) => res.writeHead(200).end();
  assert.equal(await fetchHttpSnapshot(`http://${base}/snap.jpg`), null);
});

// #536 reversed this: redirects used to be followed (some cameras bounce /snap to a token URL), but a followed
// redirect sends the Authorization header to whatever host the camera names, so it is now refused and the admin
// enters the final address. snapshot-http-limits.test.js pins the same rule from the size-cap side.
test('a redirect is not followed: null, and the redirect target is never requested', async () => {
  route = (req, res) => {
    if (req.url === '/snap') return res.writeHead(302, { location: '/token/abc.jpg' }).end();
    res.writeHead(200).end(JPEG);
  };
  const img = await fetchHttpSnapshot(`http://${base}/snap`);
  assert.equal(img, null);
  assert.deepEqual(seen.map((s) => s.url), ['/snap']);
});

test('a malformed address and a non-http scheme are null without a request being made', async () => {
  // Pins the OUTCOME. The scheme guard in fetchHttpSnapshot is defence in depth: fetch() itself refuses ftp: and
  // file: ("fetch failed"), which the catch turns into the same null, so deleting the guard is an EQUIVALENT
  // mutant here and no test can tell. Surrounding whitespace is the same story (WHATWG URL strips it), which is
  // why there is no test for the .trim().
  assert.equal(await fetchHttpSnapshot('not a url'), null);
  assert.equal(await fetchHttpSnapshot(''), null);
  assert.equal(await fetchHttpSnapshot(undefined), null);
  assert.equal(await fetchHttpSnapshot(`ftp://${base}/snap.jpg`), null);
  assert.equal(await fetchHttpSnapshot(`file:///etc/hostname`), null);
  assert.equal(seen.length, 0);
});

test('★ a camera that accepts the request and never answers gives up at the timeout, with null', async () => {
  // Same shape as notify-timeouts.test.js: a refused port fails fast on its own and would pass without the
  // timer. Here the connection is held open and never written to, so only the abort can end the call.
  route = () => {};
  const t0 = Date.now();
  assert.equal(await fetchHttpSnapshot(`http://${base}/snap.jpg`, { timeoutMs: 150 }), null);
  const took = Date.now() - t0;
  assert.ok(took >= 100 && took < 5000, `gave up after ${took}ms, expected about 150ms`);
});
