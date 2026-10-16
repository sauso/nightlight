// A provider token that fetch cannot send must never be quoted into the log or a response (post-merge review of
// PR #702).
//
// THE DEFECT. #555 moved the Gotify application token from the URL into the X-Gotify-Key header. Node's fetch
// refuses a header value holding CR, LF or NUL with `Headers.append: "<the whole value>" is an invalid header
// value.`, and sendGotify logged that e.message (`[gotify] send failed (network): ...`) AND returned it, so
// POST /api/gotify/test answered 400 with the WHOLE token in its body, and the log (which the support bundle
// carries) had it too. GET /config masks the token, so this was the one place it came back out. ntfy's access token
// rides in `Authorization: Bearer` and had the same exposure. The reviewer's repro: a stored token
// 'AsecretPART1\nsecretPART2', then the Test button.
//
// WHAT IS PINNED, each with its own test so each defence fails on its own when removed:
//   1. the shared POST (lib/httpNotify.js) reports a request it cannot BUILD with a fixed sentence that quotes
//      nothing (bad header value, credentials in the URL), and leaves a real network failure's message alone;
//   2. Gotify and ntfy: a stored hostile token reaches neither the Test reply nor logger.getRecent() (the buffer
//      the in-app log and the support bundle read), over real HTTP through the real routes;
//   3. Gotify and ntfy redact their own credentials from ANY message (an error that quotes it for another reason,
//      a server reply that echoes it), so the fixed sentence is not the only thing standing between the token and
//      the log;
//   4. Gotify's save refuses a token outside Gotify's own character set, without repeating it, and still accepts
//      the tokens Gotify generates, a blank (keep the saved one) and surrounding whitespace.
// Every hostile token carries two markers, one each side of the bad character, and each check asserts that the
// log line it looks in was actually written: an absent marker in an empty log would prove nothing.
// NOT covered: a real Gotify or ntfy server; Pushover (its tokens travel in the form BODY to a fixed URL, so fetch
// has no header or URL of theirs to quote) and Firebase (firebase-admin builds its own requests) are unchanged.
import { test, describe, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, signToken, mountRouter, call } from './helpers/harness.js';

useTempDataDir();
const { default: db } = await import('../src/db.js');
const { logger } = await import('../src/lib/logger.js');
const { postWithTimeout, redactSecrets, REQUEST_NOT_BUILT } = await import('../src/lib/httpNotify.js');
const { sendGotify } = await import('../src/lib/gotify.js');
const { sendNtfy } = await import('../src/lib/ntfy.js');
const { default: gotifyRouter } = await import('../src/routes/gotify.js');
const { default: ntfyRouter } = await import('../src/routes/ntfy.js');

const A = 'LeakMarkerAlpha';
const B = 'LeakMarkerBravo';
const BAD_CHARS = [['CR', '\r'], ['LF', '\n'], ['CR LF', '\r\n'], ['NUL', '\u0000'], ['a non-Latin-1 character', '€']];

let server; // plays Gotify / ntfy; records what reached it
let received;
let echo; // when set, the server answers 401 with the request's credential headers in the body
let gotifyApi;
let ntfyApi;
let token;

before(async () => {
  server = createServer((req, res) => {
    received.push({ url: req.url, headers: req.headers });
    req.resume();
    req.on('end', () => {
      if (echo) {
        res.writeHead(401, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Unauthorized', got: req.headers['x-gotify-key'] || req.headers.authorization }));
      }
      return res.end('{}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  gotifyApi = await mountRouter('/api/gotify', gotifyRouter);
  ntfyApi = await mountRouter('/api/ntfy', ntfyRouter);
  const admin = makeUser(db, { id: 'u-admin', username: 'admin', role: 'admin' });
  token = signToken({ sub: admin.id, role: 'admin', sid: makeSession(db, admin.id) });
});
after(async () => {
  await gotifyApi.close();
  await ntfyApi.close();
  await new Promise((r) => server.close(r));
  cleanupTempDataDirs();
});
beforeEach(() => {
  received = [];
  echo = false;
  logger.clear();
});

const serverUrl = () => `http://127.0.0.1:${server.address().port}`;
const storeGotify = (appToken) => db
  .prepare('UPDATE settings SET gotify_enabled = 1, gotify_server_url = ?, gotify_app_token = ?, gotify_priority = 5 WHERE id = ?')
  .run(serverUrl(), appToken, 'app');
const storedGotifyToken = () => db.prepare("SELECT gotify_app_token AS t FROM settings WHERE id = 'app'").get().t;
const storeNtfy = (ntfyToken) => db
  .prepare("UPDATE settings SET ntfy_enabled = 1, ntfy_server_url = ?, ntfy_topic = 'leak-test', ntfy_token = ?, ntfy_username = NULL, ntfy_password = NULL WHERE id = 'app'")
  .run(serverUrl(), ntfyToken);
const logText = () => logger.getRecent().join('\n');

function assertNoMarker(where, text) {
  for (const m of [A, B]) assert.ok(!String(text).includes(m), `${where} contains the token (${m}):\n${text}`);
}

describe('#702 review: the shared bounded POST never quotes a request it cannot build', () => {
  test('#702 review postWithTimeout: a request fetch cannot build is reported without quoting the header or the URL', async () => {
    for (const [name, c] of BAD_CHARS) {
      await assert.rejects(
        () => postWithTimeout(`${serverUrl()}/x`, { method: 'POST', headers: { 'X-Secret': `${A}${c}${B}` } }, { label: 'probe' }),
        (e) => {
          assert.equal(e.message, REQUEST_NOT_BUILT, `${name}: ${e.message}`);
          assertNoMarker(name, e.message);
          return true;
        }
      );
    }
    // A URL with credentials in it: fetch's own message repeats the URL, password included.
    await assert.rejects(
      () => postWithTimeout(`http://user:${A}@127.0.0.1:${server.address().port}/x`, { method: 'POST' }, { label: 'probe' }),
      (e) => { assert.equal(e.message, REQUEST_NOT_BUILT); return true; }
    );
    assert.deepEqual(received, [], 'nothing was sent');
  });

  test('#702 review postWithTimeout: a network failure keeps its own message (only a request that cannot be built is replaced)', async () => {
    const closed = createServer();
    await new Promise((r) => closed.listen(0, '127.0.0.1', r));
    const { port } = closed.address();
    await new Promise((r) => closed.close(r));
    await assert.rejects(() => postWithTimeout(`http://127.0.0.1:${port}/x`, { method: 'POST' }, { label: 'probe' }), /^TypeError: fetch failed$/);
  });

  test('#702 review redactSecrets: every non-empty secret is cut out, and an empty one cuts nothing', () => {
    assert.equal(redactSecrets(`a ${A} b ${A} c ${B}`, [A, B]), 'a [redacted] b [redacted] c [redacted]');
    assert.equal(redactSecrets('fetch failed', ['', null, undefined, 42]), 'fetch failed');
    assert.equal(redactSecrets(undefined, [A]), '');
  });
});

describe('#702 review: a stored Gotify token that fetch cannot send', () => {
  for (const [name, c] of BAD_CHARS) {
    test(`#702 review gotify: a stored token holding ${name} is quoted in neither the Test reply nor the log`, async () => {
      // Written straight to the database: the shape of a token saved before the save-time check existed.
      storeGotify(`${A}${c}${B}`);
      const res = await call(`${gotifyApi.url}/api/gotify/test`, { method: 'POST', token, body: {} });
      assert.equal(res.status, 400, JSON.stringify(res.body));
      assert.match(res.body.error, /could not be built/);
      assertNoMarker('the Test reply', JSON.stringify(res.body));
      assert.match(logText(), /\[gotify\] send failed \(network\)/, 'the failure was logged (so the absence below means something)');
      assertNoMarker('the log', logText());
      assert.deepEqual(received, [], 'and nothing reached the server');
    });
  }

  test('#702 review gotify: an error that quotes the token for any other reason is redacted too', async (t) => {
    const tok = `${A}-${B}`;
    storeGotify(tok);
    t.after(() => mock.restoreAll());
    mock.method(globalThis, 'fetch', async () => { throw new Error(`upstream refused key ${tok} for this app`); });
    const r = await sendGotify({ title: 'T', message: 'M' });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'upstream refused key [redacted] for this app');
    assert.match(logText(), /\[gotify\] send failed \(network\): upstream refused key \[redacted\]/);
    assertNoMarker('the log', logText());
  });

  test('#702 review gotify: a server that echoes the token in its error reply does not put it in the log or the reply', async () => {
    storeGotify(`${A}-${B}`);
    echo = true;
    const r = await sendGotify({ title: 'T', message: 'M' });
    assert.equal(received.length, 1, 'the request was sent');
    assert.equal(received[0].headers['x-gotify-key'], `${A}-${B}`, 'and it carried the token (so the echo below has it)');
    assert.equal(r.ok, false);
    assert.match(r.error, /^HTTP 401 — .*\[redacted\]/);
    assertNoMarker('the reply', r.error);
    assert.match(logText(), /\[gotify\] send failed \(401\)/);
    assertNoMarker('the log', logText());
  });
});

describe('#702 review: the Gotify token is checked when it is saved', () => {
  const save = (body) => call(`${gotifyApi.url}/api/gotify/config`, { method: 'PUT', token, body });

  test('#702 review gotify save: a token with a line break, NUL, space or other character is refused, not repeated, not stored', async () => {
    storeGotify('AKeep.me-1');
    for (const bad of [`${A}\n${B}`, `${A}\r${B}`, `${A}\u0000${B}`, `${A} ${B}`, `${A}€${B}`, `${A}:${B}`, `${A}%0a${B}`, `${A}\t${B}`]) {
      const res = await save({ enabled: true, server_url: serverUrl(), app_token: bad });
      assert.equal(res.status, 400, `${JSON.stringify(bad)} was accepted`);
      assert.match(res.body.error, /only contain letters, digits, dots, hyphens and underscores/);
      assertNoMarker('the refusal', JSON.stringify(res.body));
      assert.equal(storedGotifyToken(), 'AKeep.me-1', 'a refused token must not be stored');
    }
    assertNoMarker('the log', logText());
  });

  test('#702 review gotify save: the tokens Gotify generates are accepted (the older A + 14 with dots, the newer gtfya + 22)', async () => {
    for (const good of ['AbC.d-e_F9.xY_z', 'gtfyaAbCdEfGhIj-_0123456789K']) {
      const res = await save({ enabled: true, server_url: serverUrl(), app_token: good });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(storedGotifyToken(), good);
    }
  });

  test('#702 review gotify save: surrounding whitespace (a pasted line end) is trimmed, not refused', async () => {
    const res = await save({ enabled: true, server_url: serverUrl(), app_token: '  gtfyaPasted_1\r\n' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(storedGotifyToken(), 'gtfyaPasted_1');
  });

  test('#702 review gotify save: blank keeps the saved token, even one saved before this check', async () => {
    storeGotify(`${A}\n${B}`);
    const res = await save({ enabled: true, server_url: serverUrl(), app_token: '' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(storedGotifyToken(), `${A}\n${B}`);
    assertNoMarker('the saved-config reply', JSON.stringify(res.body));
  });

  test('#702 review gotify save: a token that is not text is a 400, not a 500', async () => {
    for (const bad of [12345, { a: 1 }, ['x'], true]) {
      const res = await save({ enabled: true, server_url: serverUrl(), app_token: bad });
      assert.equal(res.status, 400, `${JSON.stringify(bad)}: ${res.status}`);
      assert.equal(res.body.error, 'app_token must be text.');
    }
  });
});

describe('#702 review: ntfy\'s access token has the same exposure', () => {
  for (const [name, c] of BAD_CHARS) {
    test(`#702 review ntfy: a stored access token holding ${name} is quoted in neither the Test reply nor the log`, async () => {
      storeNtfy(`${A}${c}${B}`);
      const res = await call(`${ntfyApi.url}/api/ntfy/test`, { method: 'POST', token, body: {} });
      assert.equal(res.status, 400, JSON.stringify(res.body));
      assertNoMarker('the Test reply', JSON.stringify(res.body));
      assert.match(logText(), /\[ntfy\] send failed \(network\)/);
      assertNoMarker('the log', logText());
    });
  }

  test('#702 review ntfy: an error that quotes the token for any other reason is redacted too', async (t) => {
    const tok = `tk_${A}${B}`;
    storeNtfy(tok);
    t.after(() => mock.restoreAll());
    mock.method(globalThis, 'fetch', async () => { throw new Error(`proxy rejected Bearer ${tok}`); });
    const r = await sendNtfy({ title: 'T', message: 'M' });
    assert.equal(r.ok, false);
    assertNoMarker('the reply', r.error);
    assert.match(logText(), /\[ntfy\] send failed \(network\): proxy rejected/);
    assertNoMarker('the log', logText());
  });

  test('#702 review ntfy: a server that echoes the Authorization header in its error reply does not put the token in the log', async () => {
    storeNtfy(`tk_${A}${B}`);
    echo = true;
    const r = await sendNtfy({ title: 'T', message: 'M' });
    assert.equal(received[0].headers.authorization, `Bearer tk_${A}${B}`);
    assert.equal(r.ok, false);
    assertNoMarker('the reply', r.error);
    assert.match(logText(), /\[ntfy\] send failed \(401\)/);
    assertNoMarker('the log', logText());
  });
});
