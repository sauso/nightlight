// What Gotify and Pushover are actually SENT (issue #564, "pure logic first": message construction asserted on the
// request that left, not on a return value).
//
// Both providers were at roughly half line coverage with no test file of their own, so nothing pinned the
// request shape the receiving service parses: a Gotify token that stopped being URL-encoded, a Pushover `device`
// that was sent blank (which Pushover rejects), or a priority of 0 that was dropped by a truthiness check would
// each have shipped silently. ntfy's equivalent is pinned in ntfy-header-safety.test.js.
//
// ⚠️ HOW EACH IS OBSERVED, AND WHY THEY DIFFER.
//   - Gotify's server URL is a setting, so it talks to a REAL local HTTP server, the same technique as
//     ntfy-header-safety.test.js and notify-timeouts.test.js.
//   - Pushover's endpoint is a constant (https://api.pushover.net/1), so there is nothing to point at a local
//     server. `globalThis.fetch` is therefore wrapped for that one host and every other URL falls through to the
//     real fetch. This is an injected network edge, not a mock of the code under test: the module under test
//     (pushover.js, httpNotify.js) runs unmodified, and what is asserted is the FormData it built. A device-bound
//     or real-service path is not needed to check message construction, and the real Pushover is never contacted.
//
// Known limit, documented: nothing here proves Pushover ACCEPTS the request, only that it is the request the
// documented API describes. That is the e2e/manual layer.
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { useTempDataDir, cleanupTempDataDirs } from './helpers/harness.js';

useTempDataDir();

const { default: db } = await import('../src/db.js');
const { sendGotify, gotifyEnabled, gotifyConfigured } = await import('../src/lib/gotify.js');
const { sendPushover, validatePushover, pushoverEnabled, pushoverConfigured } = await import('../src/lib/pushover.js');

const setting = (cols) => {
  for (const [k, v] of Object.entries(cols)) db.prepare(`UPDATE settings SET ${k} = ? WHERE id = 'app'`).run(v);
};

// --- Gotify: a real local server -------------------------------------------------------------------------

let gotify;
let received;
let reply;

describe('Gotify', () => {
  before(async () => {
    gotify = createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        received.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
        res.writeHead(reply.status).end(reply.body);
      });
    });
    await new Promise((r) => gotify.listen(0, '127.0.0.1', r));
  });
  after(async () => {
    await new Promise((r) => gotify.close(r));
  });
  beforeEach(() => {
    received = [];
    reply = { status: 200, body: '{}' };
    setting({
      gotify_enabled: 1,
      gotify_server_url: `http://127.0.0.1:${gotify.address().port}`,
      gotify_app_token: 'tok-abc',
      gotify_priority: 5,
    });
  });

  test('the request is a JSON POST to /message with the token in the X-Gotify-Key header, and the payload carries the title and message', async () => {
    const r = await sendGotify({ title: 'Nursery — motion', message: 'Motion detected' });
    assert.deepEqual(r, { ok: true });
    assert.equal(received.length, 1);
    assert.equal(received[0].method, 'POST');
    assert.equal(received[0].url, '/message'); // no token in the URL (#555 bullet 4; gotify-token-header.test.js)
    assert.equal(received[0].headers['x-gotify-key'], 'tok-abc');
    assert.match(received[0].headers['content-type'], /^application\/json/);
    assert.deepEqual(JSON.parse(received[0].body), { title: 'Nursery — motion', message: 'Motion detected', priority: 5 });
  });

  test('the token is sent as-is in the header and a trailing slash on the server URL does not double up', async () => {
    // The token used to be URL-encoded into the query (a & or # would end the query early); since #555 bullet 4 it
    // travels in a header, where it must arrive byte for byte, unencoded. A stored "http://host:port/" would
    // otherwise request "//message".
    setting({ gotify_app_token: 'a&b#c', gotify_server_url: `http://127.0.0.1:${gotify.address().port}///` });
    await sendGotify({ title: 't', message: 'm' });
    assert.equal(received[0].url, '/message');
    assert.equal(received[0].headers['x-gotify-key'], 'a&b#c');
  });

  test('★ a priority of 0 is sent as 0, not replaced by the saved default (0 is "no priority", a real choice)', async () => {
    await sendGotify({ title: 't', message: 'm', priority: 0 });
    assert.equal(JSON.parse(received[0].body).priority, 0, 'a falsy priority was treated as "not given"');
    received.length = 0;
    await sendGotify({ title: 't', message: 'm' });
    assert.equal(JSON.parse(received[0].body).priority, 5, 'with none given, the saved default applies');
  });

  test('a tap target is carried as Gotify\'s click extra, and omitted entirely when there is none', async () => {
    await sendGotify({ title: 't', message: 'm', click: 'nightlight://camera/c1' });
    assert.deepEqual(JSON.parse(received[0].body).extras, { 'client::notification': { click: { url: 'nightlight://camera/c1' } } });
    received.length = 0;
    await sendGotify({ title: 't', message: 'm' });
    assert.equal('extras' in JSON.parse(received[0].body), false, 'an empty click extra was sent');
  });

  test('an untitled message is titled "Nightlight" rather than sent blank', async () => {
    await sendGotify({ message: 'm' });
    assert.equal(JSON.parse(received[0].body).title, 'Nightlight');
  });

  test('a refusal comes back as { ok:false } naming the status and the server\'s words, and does not throw', async () => {
    // Gotify's own 401 body. Only its JSON message fields come back since the Opus review of PR #742: a reply is never
    // quoted raw (describeErrorReply in httpNotify.js), so a plain-text one is reported as its status alone.
    reply = { status: 401, body: JSON.stringify({ error: 'Unauthorized', errorCode: 401, errorDescription: 'you need to provide a valid access token or user credentials to access this api' }) };
    const r = await sendGotify({ title: 't', message: 'm' });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'HTTP 401 Unauthorized — error: Unauthorized; errorDescription: you need to provide a valid access token or user credentials to access this api');
    reply = { status: 401, body: 'invalid token' };
    assert.deepEqual(await sendGotify({ title: 't', message: 'm' }), { ok: false, error: 'HTTP 401 Unauthorized' });
  });

  test('without a server URL or a token nothing is sent at all', async () => {
    setting({ gotify_app_token: '' });
    assert.equal(await sendGotify({ title: 't', message: 'm' }), undefined);
    assert.equal(received.length, 0);
    assert.equal(gotifyConfigured(), false);
    assert.equal(gotifyEnabled(), false, 'enabled needs the token as well as the switch');
  });
});

// --- Pushover: the one host is intercepted at the network edge -------------------------------------------

describe('Pushover', () => {
  const realFetch = globalThis.fetch;
  let calls;
  let answer;

  const edge = async (url, init) => {
    if (!String(url).startsWith('https://api.pushover.net/')) return realFetch(url, init);
    calls.push({ url: String(url), method: init.method, body: init.body });
    return new Response(answer.body, { status: answer.status });
  };

  before(() => {
    globalThis.fetch = edge;
  });
  after(() => {
    globalThis.fetch = realFetch;
  });
  beforeEach(() => {
    calls = [];
    answer = { status: 200, body: '{"status":1}' };
    setting({ pushover_enabled: 1, pushover_app_token: 'app-tok', pushover_user_key: 'user-key', pushover_device: '' });
  });

  test('a send POSTs a form to messages.json carrying the token, user and message', async () => {
    const r = await sendPushover({ title: 'Nursery — sound', message: 'Sound detected' });
    assert.deepEqual(r, { ok: true });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.pushover.net/1/messages.json');
    assert.equal(calls[0].method, 'POST');
    const f = calls[0].body;
    assert.equal(f.get('token'), 'app-tok');
    assert.equal(f.get('user'), 'user-key');
    assert.equal(f.get('title'), 'Nursery — sound');
    assert.equal(f.get('message'), 'Sound detected');
  });

  test('★ a blank device is OMITTED (all devices), a chosen one is sent, and the optional fields only appear when given', async () => {
    await sendPushover({ title: 't', message: 'm' });
    const bare = calls[0].body;
    for (const k of ['device', 'url', 'url_title', 'priority', 'attachment']) {
      assert.equal(bare.has(k), false, `${k} was sent although nothing asked for it (a blank device makes Pushover refuse the message)`);
    }
    setting({ pushover_device: 'nursery-phone' });
    await sendPushover({ title: 't', message: 'm', url: 'nightlight://camera/c1', urlTitle: 'Open in Nightlight', priority: 0 });
    const full = calls[1].body;
    assert.equal(full.get('device'), 'nursery-phone');
    assert.equal(full.get('url'), 'nightlight://camera/c1');
    assert.equal(full.get('url_title'), 'Open in Nightlight');
    assert.equal(full.get('priority'), '0', 'a priority of 0 (normal) was dropped as if it were absent');
  });

  test('the message is cut to 1024 characters and the title to 250, Pushover\'s own limits', async () => {
    await sendPushover({ title: 'T'.repeat(400), message: 'M'.repeat(3000) });
    assert.equal(calls[0].body.get('message').length, 1024);
    assert.equal(calls[0].body.get('title').length, 250);
  });

  test('a snapshot is attached as snapshot.jpg (image/jpeg) and an empty buffer is not', async () => {
    await sendPushover({ title: 't', message: 'm', image: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) });
    const file = calls[0].body.get('attachment');
    assert.equal(file.name, 'snapshot.jpg');
    assert.equal(file.type, 'image/jpeg');
    // The BYTES, not only the length: a four-byte fixture let `new Blob([Buffer.alloc(image.length)])` pass (#714 review).
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    await sendPushover({ title: 't', message: 'm', image: Buffer.alloc(0) });
    assert.equal(calls[1].body.has('attachment'), false, 'a zero-byte attachment was sent');
  });

  test('a refusal returns { ok:false } with Pushover\'s own errors joined, or the status when it gave none', async () => {
    answer = { status: 400, body: '{"status":0,"errors":["user identifier is invalid","token is invalid"]}' };
    assert.deepEqual(await sendPushover({ title: 't', message: 'm' }), { ok: false, error: 'user identifier is invalid; token is invalid' });
    answer = { status: 503, body: 'upstream down' };
    assert.deepEqual(await sendPushover({ title: 't', message: 'm' }), { ok: false, error: 'HTTP 503' });
  });

  test('with either credential missing nothing is sent, and enabled needs both', async () => {
    setting({ pushover_user_key: '' });
    assert.equal(await sendPushover({ title: 't', message: 'm' }), undefined);
    assert.equal(calls.length, 0);
    assert.equal(pushoverConfigured(), false);
    assert.equal(pushoverEnabled(), false);
  });

  test('validate: both fields are required before anything is sent; a single device is checked, a list is not', async () => {
    assert.equal((await validatePushover('', 'u')).ok, false);
    assert.equal((await validatePushover('t', '')).ok, false);
    assert.equal(calls.length, 0, 'validation went to the network without both credentials');

    assert.deepEqual(await validatePushover('t', 'u', 'phone'), { ok: true });
    assert.equal(calls[0].url, 'https://api.pushover.net/1/users/validate.json');
    // POST with the token and the user in their own fields: the fake edge answers ok whatever it is sent, so without
    // these a swapped token/user or a GET would still pass (#714 review).
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].body.get('token'), 't');
    assert.equal(calls[0].body.get('user'), 'u');
    assert.equal(calls[0].body.get('device'), 'phone', 'a single typo-able device name must be validated');

    await validatePushover('t', 'u', 'phone,tablet');
    assert.equal(calls[1].body.has('device'), false, 'users/validate checks one device at a time, so a list is left out');
  });

  test('validate: a rejection reports Pushover\'s reason, and an unreachable service reports that', async () => {
    answer = { status: 400, body: '{"status":0,"errors":["application token is invalid"]}' };
    assert.deepEqual(await validatePushover('t', 'u'), { ok: false, error: 'application token is invalid' });
    answer = { status: 400, body: '{"status":0}' };
    assert.match((await validatePushover('t', 'u')).error, /rejected the token or user\/group key/);
    globalThis.fetch = async () => { throw new Error('getaddrinfo ENOTFOUND'); };
    try {
      assert.match((await validatePushover('t', 'u')).error, /^Couldn't reach Pushover to validate: .*ENOTFOUND/);
    } finally {
      globalThis.fetch = edge;
    }
  });
});

after(() => {
  cleanupTempDataDirs();
});
