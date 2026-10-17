// #555 bullet 4: the Gotify application token travels in the X-Gotify-Key header, not in the URL's query string.
// A URL is what reverse proxies and access logs record. REAL HTTP: a local server plays the Gotify server and
// records exactly what it was sent. Pinned: the header carries the token; the request URL carries no token at all
// (neither `token=` nor the value); the path is still /message and the JSON body is unchanged; a trailing slash on
// the saved server URL still works.
// NOT covered: a real Gotify server. Gotify documents both forms; that the header form works against the Gotify
// versions people run is from its documentation, not from a run.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { useTempDataDir, cleanupTempDataDirs } from './helpers/harness.js';

useTempDataDir();
const { default: db } = await import('../src/db.js');
const { sendGotify } = await import('../src/lib/gotify.js');

const TOKEN = 'Aq1-secret.token';
let seen;
let server;

before(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      seen = { url: req.url, method: req.method, key: req.headers['x-gotify-key'], body };
      res.end('{}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  db.prepare('UPDATE settings SET gotify_enabled = 1, gotify_server_url = ?, gotify_app_token = ?, gotify_priority = 7 WHERE id = ?')
    .run(`http://127.0.0.1:${server.address().port}/`, TOKEN, 'app');
});
after(async () => {
  await new Promise((r) => server.close(r));
  cleanupTempDataDirs();
});

test('the token is sent as X-Gotify-Key and never in the URL', async () => {
  const r = await sendGotify({ title: 'T', message: 'M' });
  assert.deepEqual(r, { ok: true });
  assert.equal(seen.method, 'POST');
  assert.equal(seen.key, TOKEN);
  assert.equal(seen.url, '/message', 'the request URL must carry nothing but the path');
  assert.ok(!seen.url.includes('token') && !seen.url.includes(TOKEN));
  assert.deepEqual(JSON.parse(seen.body), { title: 'T', message: 'M', priority: 7 });
});
