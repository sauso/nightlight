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
//   5. (Opus review of PR #742) a server's error reply is never quoted raw: only whitelisted JSON message fields come
//      back, a kept field that repeats 8 characters of a credential is withheld, and an echo of the credential in
//      every spelling the review found (Go JSON, HTML entities, double percent-encoding, QueryEscape, PHP's \/,
//      base64 without its prefix, half of it) reaches neither the Test reply nor the log. The design does not rely
//      on that list; the list is how the test proves it. Short secrets and the plain ntfy password are not cut out
//      of ordinary words.
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
const { postWithTimeout, redactSecrets, describeErrorReply, REQUEST_NOT_BUILT } = await import('../src/lib/httpNotify.js');
const { sendGotify } = await import('../src/lib/gotify.js');
const { sendNtfy } = await import('../src/lib/ntfy.js');
const { default: gotifyRouter } = await import('../src/routes/gotify.js');
const { default: ntfyRouter } = await import('../src/routes/ntfy.js');

const A = 'LeakMarkerAlpha';
const B = 'LeakMarkerBravo';
const BAD_CHARS = [['CR', '\r'], ['LF', '\n'], ['CR LF', '\r\n'], ['NUL', '\u0000'], ['a non-Latin-1 character', '€']];

let server; // plays Gotify / ntfy; records what reached it
let received;
// When set, (the credential header the request carried) => { status, body, type } is the server's answer; otherwise it
// answers 200 '{}'.
let replyWith;
const echoReply = (cred) => ({ status: 401, body: JSON.stringify({ error: 'Unauthorized', got: cred }) });
let gotifyApi;
let ntfyApi;
let token;

before(async () => {
  server = createServer((req, res) => {
    received.push({ url: req.url, headers: req.headers });
    req.resume();
    req.on('end', () => {
      if (replyWith) {
        const r = replyWith(req.headers['x-gotify-key'] || req.headers.authorization || '');
        res.writeHead(r.status, { 'content-type': r.type || 'application/json' });
        return res.end(r.body);
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
  replyWith = null;
  logger.clear();
});

const serverUrl = () => `http://127.0.0.1:${server.address().port}`;
const storeGotify = (appToken) => db
  .prepare('UPDATE settings SET gotify_enabled = 1, gotify_server_url = ?, gotify_app_token = ?, gotify_priority = 5 WHERE id = ?')
  .run(serverUrl(), appToken, 'app');
const storedGotifyToken = () => db.prepare("SELECT gotify_app_token AS t FROM settings WHERE id = 'app'").get().t;
const storeNtfy = (ntfyToken, { username = null, password = null } = {}) => db
  .prepare("UPDATE settings SET ntfy_enabled = 1, ntfy_server_url = ?, ntfy_topic = 'leak-test', ntfy_token = ?, ntfy_username = ?, ntfy_password = ? WHERE id = 'app'")
  .run(serverUrl(), ntfyToken, username, password);
const logText = () => logger.getRecent().join('\n');

function assertNoMarker(where, text) {
  for (const m of [A, B]) assert.ok(!String(text).includes(m), `${where} contains the token (${m}):\n${text}`);
}

// Every way the Opus review of PR #742 showed a server or proxy can write a credential back. The DESIGN does not
// depend on this list (only whitelisted reply fields come back); the list is how the tests prove that.
function echoSpellings(value) {
  const jsonInner = JSON.stringify(value).slice(1, -1);
  return {
    raw: value,
    goJson: jsonInner.replace(/&/g, '\\u0026').replace(/</g, '\\u003c').replace(/>/g, '\\u003e'),
    html: value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    doubleEncoded: encodeURIComponent(encodeURIComponent(value)),
    queryEscape: encodeURIComponent(value).replace(/[!'()~]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`).replace(/%20/g, '+'),
    php: jsonInner.replace(/\//g, '\\/'),
    base64: Buffer.from(value).toString('base64'),
    half: value.slice(0, Math.ceil(value.length / 2)),
  };
}
// The spellings of the credential header AND of its bare value (after `Bearer ` / `Basic `).
function hostileSpellings(cred) {
  const bare = cred.replace(/^(Bearer|Basic) /, '');
  return [...new Set([...Object.values(echoSpellings(cred)), ...Object.values(echoSpellings(bare))])].filter((v) => v.length >= 8);
}
// Three bodies: JSON with one whitelisted field and every spelling in fields that are not, the same as plain text, and
// as an HTML error page. Each must come back as `expectedJson` / the status alone.
const hostileBodies = (cred) => {
  const spellings = hostileSpellings(cred);
  return [
    { kind: 'JSON', type: 'application/json', body: JSON.stringify({ error: 'Unauthorized', ...Object.fromEntries(spellings.map((v, i) => [`got${i}`, v])) }) },
    { kind: 'text', type: 'text/plain', body: `rejected: ${spellings.join(' | ')}` },
    { kind: 'HTML', type: 'text/html', body: `<html><body><pre>${spellings.join('\n')}</pre></body></html>` },
  ];
};
function assertNoSpelling(where, text, cred) {
  for (const v of hostileSpellings(cred)) assert.ok(!String(text).includes(v), `${where} contains an echo of the credential (${JSON.stringify(v)}):\n${text}`);
  assertNoMarker(where, text);
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

  test('#742 review redactSecrets: a secret echoed JSON-escaped or percent-encoded is cut out too', () => {
    // ntfy accepts a token holding a quote, a backslash or a space; a server that echoes the Authorization header
    // in a JSON error writes `\"` and `\\`, a form or URL echo writes %22 and + (Codex review of PR #742).
    const tok = `tk"${A}\\${B} x`;
    const json = JSON.stringify({ error: `bad header Bearer ${tok}` });
    const form = `Authorization=${encodeURIComponent(`Bearer ${tok}`)}&b=${encodeURIComponent(tok).replace(/%20/g, '+')}`;
    for (const echoed of [`bad header Bearer ${tok}`, json, form]) {
      const out = redactSecrets(echoed, [tok]);
      assert.ok(!out.includes(A) && !out.includes(B), `a fragment of the token survived: ${out}`);
      assert.ok(out.includes('[redacted]'), out);
    }
  });

  // Opus review of PR #742, R1: the JSON spelling is the escaped token WITHOUT its quotes. A spelling that kept the
  // closing quote only matched where a quote happened to follow, and ate that quote when it did.
  test('#742 review redactSecrets: the JSON-escaped spelling is cut exactly, followed by a quote or not', () => {
    const tok = 'ab"cdefghij';
    const esc = JSON.stringify(tok).slice(1, -1); // ab\"cdefghij
    assert.equal(redactSecrets(`x ${esc} y`, [tok]), 'x [redacted] y');
    assert.equal(redactSecrets(`{"got":"${esc}"}`, [tok]), '{"got":"[redacted]"}');
  });

  // R2: a form encoding writes EVERY space as +, so a token with two spaces must have both replaced.
  test('#742 review redactSecrets: a token with two spaces echoed form-encoded is cut out', () => {
    const tok = 'ab cd efghij';
    assert.equal(redactSecrets('q=ab+cd+efghij&z=1', [tok]), 'q=[redacted]&z=1');
  });

  // D4: encodeURIComponent throws on a lone surrogate, and redactSecrets runs inside catch blocks that must not throw.
  test('#742 review redactSecrets: a secret holding a lone surrogate does not throw, and is still cut out as written', () => {
    const tok = `${A}\uD800${B}`;
    assert.equal(redactSecrets(`key ${tok} refused`, [tok]), 'key [redacted] refused');
    assert.equal(redactSecrets('nothing to cut', [tok]), 'nothing to cut');
  });

  // D2: a secret under 8 characters is not cut out of free text (it shredded words and hinted at the secret).
  test('#742 review redactSecrets: a secret shorter than 8 characters is left in free text; 8 or more is cut', () => {
    assert.equal(redactSecrets('HTTP 500 internal error, see https://ntfy.sh/docs', ['e', 'ntfy', '1234567']), 'HTTP 500 internal error, see https://ntfy.sh/docs');
    assert.equal(redactSecrets('the key 12345678 was refused', ['12345678']), 'the key [redacted] was refused');
  });
});

describe('#742 review: a server\'s error reply is never quoted raw', () => {
  test('#742 review describeErrorReply: only the whitelisted JSON fields are kept, with the standard status phrase', () => {
    assert.equal(describeErrorReply(401, JSON.stringify({ error: 'Unauthorized', errorCode: 401, errorDescription: 'bad key', got: 'x', link: 'y' })),
      'HTTP 401 Unauthorized — error: Unauthorized; errorDescription: bad key');
    assert.equal(describeErrorReply(500, JSON.stringify({ message: 'boom', detail: 'disk', title: 'Oops', other: 'z' })),
      'HTTP 500 Internal Server Error — message: boom; detail: disk; title: Oops');
    for (const notAnObject of ['plain words', '<html>err</html>', '["error"]', 'null', '"error"', '42', '']) {
      assert.equal(describeErrorReply(502, notAnObject), 'HTTP 502 Bad Gateway', JSON.stringify(notAnObject));
    }
    assert.equal(describeErrorReply(599, '{}'), 'HTTP 599', 'a status Node has no phrase for');
  });

  test('#742 review describeErrorReply: each kept field is cut to 200 characters', () => {
    const out = describeErrorReply(500, JSON.stringify({ error: 'x'.repeat(1000) }));
    assert.equal(out, `HTTP 500 Internal Server Error — error: ${'x'.repeat(200)}`);
  });

  test('#742 review describeErrorReply: a kept field that repeats 8 characters of a credential is withheld whole', () => {
    const tok = `${A}-${B}`;
    const withheld = 'HTTP 401 Unauthorized — error: [withheld: it repeats part of a saved credential]';
    assert.equal(describeErrorReply(401, JSON.stringify({ error: `unknown key ${tok.slice(0, 8)}...` }), [tok]), withheld);
    assert.equal(describeErrorReply(401, JSON.stringify({ error: `unknown key ...${tok.slice(-8)}` }), [tok]), withheld);
    // Seven characters is not a run: an ordinary word that happens to share a few letters stays.
    assert.equal(describeErrorReply(401, JSON.stringify({ error: `unknown key ${tok.slice(0, 7)}` }), [tok]), `HTTP 401 Unauthorized — error: unknown key ${tok.slice(0, 7)}`);
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
    replyWith = echoReply;
    const r = await sendGotify({ title: 'T', message: 'M' });
    assert.equal(received.length, 1, 'the request was sent');
    assert.equal(received[0].headers['x-gotify-key'], `${A}-${B}`, 'and it carried the token (so the echo below has it)');
    assert.deepEqual(r, { ok: false, error: 'HTTP 401 Unauthorized — error: Unauthorized' });
    assert.match(logText(), /\[gotify\] send failed \(401\): HTTP 401 Unauthorized — error: Unauthorized/);
    assertNoMarker('the log', logText());
  });

  // Opus review of PR #742: the reply is filtered by a whitelist, not by recognising the token, so an echo in ANY
  // spelling (or half of it, or in an HTML page) stays out. The token has every character those encodings change.
  test('#742 review gotify: an echo of the token in any spelling reaches neither the Test reply nor the log', async () => {
    const tok = `${A}&<>"'/!()~ ${B}`;
    storeGotify(tok);
    for (const { kind, type, body } of hostileBodies(tok)) {
      logger.clear();
      replyWith = () => ({ status: 401, type, body });
      const res = await call(`${gotifyApi.url}/api/gotify/test`, { method: 'POST', token, body: {} });
      assert.equal(res.status, 400, `${kind}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.error, kind === 'JSON' ? 'HTTP 401 Unauthorized — error: Unauthorized' : 'HTTP 401 Unauthorized', kind);
      assertNoSpelling(`${kind}: the Test reply`, JSON.stringify(res.body), tok);
      assert.match(logText(), /\[gotify\] send failed \(401\)/, `${kind}: the failure was logged`);
      assertNoSpelling(`${kind}: the log`, logText(), tok);
    }
  });

  test('#742 review gotify: a kept field that repeats part of the token is withheld', async () => {
    storeGotify(`${A}-${B}`);
    replyWith = (cred) => ({ status: 401, body: JSON.stringify({ error: `unknown key ${cred.slice(0, 8)}` }) });
    const r = await sendGotify({ title: 'T', message: 'M' });
    assert.deepEqual(r, { ok: false, error: 'HTTP 401 Unauthorized — error: [withheld: it repeats part of a saved credential]' });
    assert.ok(!logText().includes(A.slice(0, 8)), logText());
  });
});

describe('#702 review: the Gotify token is checked when it is saved', () => {
  const save = (body) => call(`${gotifyApi.url}/api/gotify/config`, { method: 'PUT', token, body });

  test('#702 review gotify save: a token with a line break, NUL, space or other character is refused, not repeated, not stored', async () => {
    storeGotify('AKeep.me-1');
    // `"`, `&`, `<` and `>` (Opus review of PR #742, G4): an allow-list widened to the characters an echo escapes
    // differently survived every other entry here.
    for (const bad of [`${A}\n${B}`, `${A}\r${B}`, `${A}\u0000${B}`, `${A} ${B}`, `${A}€${B}`, `${A}:${B}`, `${A}%0a${B}`, `${A}\t${B}`,
      `${A}"${B}`, `${A}&${B}`, `${A}<${B}`, `${A}>${B}`]) {
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
    replyWith = echoReply;
    const r = await sendNtfy({ title: 'T', message: 'M' });
    assert.equal(received[0].headers.authorization, `Bearer tk_${A}${B}`);
    assert.deepEqual(r, { ok: false, error: 'HTTP 401 Unauthorized — error: Unauthorized' });
    assert.match(logText(), /\[ntfy\] send failed \(401\)/);
    assertNoMarker('the log', logText());
  });

  for (const [label, store] of [
    ['an access token', () => storeNtfy(`tk_${A}&<>"'/!()~ ${B}`)],
    ['a user name and password (Basic)', () => storeNtfy(null, { username: 'nightlight', password: `${A}&<>"'/!()~ ${B}` })],
  ]) {
    test(`#742 review ntfy: with ${label}, an echo of the credential in any spelling reaches neither the Test reply nor the log`, async () => {
      store();
      for (const kind of ['JSON', 'text', 'HTML']) {
        logger.clear();
        let cred = '';
        // The echo is built from the header that ARRIVED, so a Basic credential is echoed as its base64.
        replyWith = (c) => {
          cred = c;
          const { type, body } = hostileBodies(c).find((b) => b.kind === kind);
          return { status: 401, type, body };
        };
        const res = await call(`${ntfyApi.url}/api/ntfy/test`, { method: 'POST', token, body: {} });
        assert.ok(cred.length > 8, 'the request carried the credential (so the echo has it)');
        assert.equal(res.status, 400, `${kind}: ${JSON.stringify(res.body)}`);
        assert.equal(res.body.error, kind === 'JSON' ? 'HTTP 401 Unauthorized — error: Unauthorized' : 'HTTP 401 Unauthorized', kind);
        assertNoSpelling(`${kind}: the Test reply`, JSON.stringify(res.body), cred);
        assert.match(logText(), /\[ntfy\] send failed \(401\)/, `${kind}: the failure was logged`);
        assertNoSpelling(`${kind}: the log`, logText(), cred);
      }
    });
  }

  // Opus review of PR #742, N4: with a user name and password what travels is base64(user:password). It must be
  // withheld from a kept field and cut out of an error, with or without its `Basic ` prefix.
  test('#742 review ntfy: Basic credentials (base64 of user:password) never reach the reply or the log', async (t) => {
    storeNtfy(null, { username: 'nightlight', password: `${A}-${B}` });
    const b64 = Buffer.from(`nightlight:${A}-${B}`).toString('base64');
    replyWith = (cred) => ({ status: 401, body: JSON.stringify({ error: `bad credentials ${cred.replace(/^Basic /, '')}` }) });
    const r = await sendNtfy({ title: 'T', message: 'M' });
    assert.equal(received[0].headers.authorization, `Basic ${b64}`);
    assert.deepEqual(r, { ok: false, error: 'HTTP 401 Unauthorized — error: [withheld: it repeats part of a saved credential]' });
    t.after(() => mock.restoreAll());
    mock.method(globalThis, 'fetch', async () => { throw new Error(`proxy rejected Basic ${b64}; raw ${b64}`); });
    const r2 = await sendNtfy({ title: 'T', message: 'M' });
    assert.equal(r2.error, 'proxy rejected Basic [redacted]; raw [redacted]');
    assert.ok(!logText().includes(b64), logText());
  });

  test('#742 review ntfy: ntfy\'s own error reply keeps its words and numbers, not its link', async () => {
    storeNtfy(`tk_${A}${B}`);
    replyWith = () => ({ status: 401, body: JSON.stringify({ code: 40101, http: 401, error: 'unauthorized', link: 'https://ntfy.sh/docs/publish/#authentication' }) });
    assert.deepEqual(await sendNtfy({ title: 'T', message: 'M' }), { ok: false, error: 'HTTP 401 Unauthorized — error: unauthorized; code: 40101; http: 401' });
  });

  // D2: a short token, or the plain password (which never travels), must not shred ordinary words in what remains.
  test('#742 review ntfy: a short token or the plain password is never cut out of ordinary words', async (t) => {
    storeNtfy('e');
    replyWith = () => ({ status: 500, body: JSON.stringify({ error: 'internal error' }) });
    assert.deepEqual(await sendNtfy({ title: 'T', message: 'M' }), { ok: false, error: 'HTTP 500 Internal Server Error — error: internal error' });
    for (const password of ['ntfy', 'network error']) {
      storeNtfy(null, { username: 'u', password });
      replyWith = () => ({ status: 503, body: JSON.stringify({ error: 'network error, ntfy rejected it, see https://ntfy.sh/docs' }) });
      assert.deepEqual(await sendNtfy({ title: 'T', message: 'M' }),
        { ok: false, error: 'HTTP 503 Service Unavailable — error: network error, ntfy rejected it, see https://ntfy.sh/docs' }, password);
    }
    storeNtfy('e');
    t.after(() => mock.restoreAll());
    mock.method(globalThis, 'fetch', async () => { throw new Error('HTTP 500 internal error'); });
    assert.deepEqual(await sendNtfy({ title: 'T', message: 'M' }), { ok: false, error: 'HTTP 500 internal error' });
  });
});
