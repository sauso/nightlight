// The TV's view-only session (#1237, phase 2 of the Android TV app, the restricted session; planning/tv-pairing-design.md
// §6 and §10).
//
// WHAT IS UNDER TEST. A `sessions` row of kind 'tv' is a sign-in for a TV: it is a caregiver whatever role its account
// has (middleware/auth.js, sessionWithUser), it may reach only the allowlist in tvAllowed (everything else answers
// 403 TV_SESSION_RESTRICTED), its media token reaches HLS and nothing else, it can never open the talk-back socket, the
// camera list and /api/about answer it with a small projection, and revoking the session that paired it ends it.
// Most TV sessions here are made by hand, through the real createSession(..., { kind: 'tv' }) the pairing calls; one
// is minted by a real pairing (start, approve, poll) and walked the same way, so the two cannot drift apart. The
// pairing's own cases are in tv-pairing.test.js.
//
// THE CLAIMS, each with the test below that fails without it:
//   - a TV session is refused every pinned route but the allowlist, and reaches the allowlist   "the route walk"
//     (a hand-made one and one minted by a real pairing, the pairing's three signed-in routes included)
//   - its media token reaches no ?token= route (snapshots, clips, timelapses, recordings)        "the route walk"
//   - the allowlist compares the exact method and the path part of originalUrl, refuses any
//     path that is not plain, and a query string does not widen it                             "tvAllowed, table-driven"
//   - the /live and /hls proxies admit only the allowed shapes for a TV                         "the media proxies"
//   - an ADMIN's TV is a caregiver on /me and /settings, and the camera list, /about, /me and
//     /settings carry only the pinned fields, against hostile values in every other column     "the TV projections"
//   - verifyToken refuses a TV for the media purpose (talk-back)                                "verifyToken" (and
//     talk-socket.test.js, "#1237")
//   - revoking a session ends the TV sessions it paired, in one transaction, never another
//     account's; a plain sign-out does not                                                     "the revoke cascade"
//   - the session lists carry kind, label and paired_from                                       "the session lists"
//   - an ordinary session is untouched by the guard                                             "ordinary sessions",
//     and route-permissions.test.js part 4 (its probes sit on paths a TV is always refused)
//   - the four columns arrive on an upgraded database with every old row an ordinary session    alert-hold-migration.test.js
//
// ⚠️ THE EXPECTATIONS ARE TYPED HERE, NOT READ FROM THE CODE. The allowlist and every projection's field list below are
// written out independently of middleware/auth.js and the routes, so a widened allowlist or a leaked field fails here
// instead of moving the expectation with it (the design's §6.4: "admin response minus caregiver response" loses its
// oracle the day an admin-only field leaks into both).
//
// NOT COVERED HERE (stated, not hidden): the pairing's own rules (tv-pairing.test.js); the WebSocket upgrade handler in
// index.js, which no test can import (the rule it relies on is verifyToken's, tested below and in talk-socket.test.js);
// the real http-proxy-middleware behind /live and /hls (a sentinel stands where it sits; route-permissions.test.js pins
// that index.js mounts the guards in front of it); what MediaMTX itself does with a path the guard lets through; and
// any frontend behaviour (the next-but-one change).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';
import { useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, signToken, call } from './helpers/harness.js';
import { scanAppRegistrations, instantiate, firstMatchingRoute } from './helpers/routeTable.js';
import { PUBLIC, MEDIA, ROUTE_GATES } from './helpers/routeGates.js';

useTempDataDir();

// ---- a stand-in for MediaMTX's API ------------------------------------------------------------------------------
// lib/mediamtx.js reads MEDIAMTX_API when it loads, so this is up before anything from src/ is imported. One path is
// live (with readers, tracks and a source the TV must not be handed), one never answers (so its status is "unknown",
// the third state the TV screen shows), everything else is 404.
const hanging = new Set();
const mtx = http.createServer((req, res) => {
  if (req.url === '/v3/paths/get/cam_live') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      name: 'cam_live',
      ready: true,
      readers: [{ type: 'webRTCSession', id: 'LEAK-mtx.reader' }],
      tracks: ['H264', 'LEAK-mtx.track'],
      source: { type: 'rtspSession', id: 'LEAK-mtx.source' },
    }));
    return;
  }
  if (req.url === '/v3/paths/get/cam_stuck') { hanging.add(res); return; } // never answers: a timeout
  res.statusCode = 404;
  res.end('{}');
});
await new Promise((resolve) => mtx.listen(0, '127.0.0.1', resolve));
process.env.MEDIAMTX_API = `http://127.0.0.1:${mtx.address().port}`;
process.env.STUN_SERVERS = 'stun:stun.example.org:3478';
// Hostile values for /api/about's other fields (read when routes/about.js loads), so a TV that got them would show it.
process.env.NIGHTLIGHT_GIT_SHA = 'LEAK-about.gitSha';
process.env.NIGHTLIGHT_GIT_REF = 'LEAK-about.gitRef';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX = path.resolve(HERE, '..', 'src', 'index.js');

const { default: db } = await import('../src/db.js');
const auth = await import('../src/middleware/auth.js');
const { requireAuth, requireAuthQueryOrHeader, verifyToken, tvAllowed, TV_SESSION_RESTRICTED } = auth;
const { whepOnlyGuard } = await import('../src/middleware/whepOnlyGuard.js');
const { createSession } = await import('../src/routes/auth.js');
const { setMediamtxApiTimeoutForTest } = await import('../src/lib/mediamtx.js');
// A status call that never answers gives up after this long instead of the real 5 s.
setMediamtxApiTimeoutForTest(300);

// ---- the app: every router mounted where index.js mounts it ----------------------------------------------------
// Same discovery as route-permissions.test.js and secrets-never-returned.test.js: index.js cannot be imported (it
// starts MediaMTX and MQTT), so its router mounts are read from the source and each router is imported for real.
const SCAN = scanAppRegistrations(fs.readFileSync(INDEX, 'utf8'));
const MOUNTS = [];
for (const reg of SCAN.registrations) {
  const [where, what] = reg.args;
  const spec = what?.ident && SCAN.imports.get(what.ident);
  if (reg.verb !== 'use' || reg.args.length !== 2 || where.value === undefined || !spec?.startsWith('./routes/')) continue;
  const { default: router } = await import(new URL(spec, pathToFileURL(INDEX)).href);
  MOUNTS.push({ mount: where.value, spec, router });
}
function locate(fullPath) {
  const m = MOUNTS.filter(({ mount }) => fullPath === mount || fullPath.startsWith(`${mount}/`))
    .sort((a, b) => b.mount.length - a.mount.length)[0];
  return m ? { ...m, subPath: fullPath.slice(m.mount.length) || '/' } : null;
}

const servers = [];
async function listen(app) {
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

let base;
before(async () => {
  const app = express();
  app.use(express.json());
  for (const { mount, router } of MOUNTS) app.use(mount, router);
  base = await listen(app);
});
after(async () => {
  await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));
  for (const res of hanging) res.destroy();
  mtx.closeAllConnections();
  await new Promise((resolve) => mtx.close(resolve));
  setMediamtxApiTimeoutForTest(null);
  db.close();
  cleanupTempDataDirs();
});

// ---- fixtures ----------------------------------------------------------------------------------------------------

const TV_UA = 'Mozilla/5.0 (Linux; Android 12; TV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const isTvRefusal = (res) => res.status === 403 && res.body?.code === 'TV_SESSION_RESTRICTED';
const sessionRow = (id) => db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);

const admin = makeUser(db, { id: 'u-admin', username: 'admin', role: 'admin' });
const carer = makeUser(db, { id: 'u-carer', username: 'carer', role: 'caregiver' });

// An ordinary session and its two tokens, as /login and /media-token mint them.
function userSession(user) {
  const sid = makeSession(db, user.id);
  return {
    sid,
    token: signToken({ id: user.id, username: user.username, role: user.role, sid }),
    media: signToken({ id: user.id, username: user.username, role: user.role, sid, purpose: 'media' }),
  };
}
// A TV session made through the real createSession. Its token carries the ACCOUNT's role claim, as a sign-in would
// mint it; the claim is never what decides (sessionWithUser does), and an admin claim makes that visible.
function tvSession(user, { pairedBySession = null, label = 'Living room TV', pairedFrom = 'Chrome on Android' } = {}) {
  const sid = createSession(user.id, TV_UA, { kind: 'tv', label, pairedBySession, pairedFrom });
  return {
    sid,
    token: signToken({ id: user.id, username: user.username, role: user.role, sid }),
    media: signToken({ id: user.id, username: user.username, role: user.role, sid, purpose: 'media' }),
  };
}

// The allowlist, TYPED HERE (see the header), with the status each allowed route answers a live TV session.
const TV_REACHABLE = {
  'GET /api/auth/me': 200,
  'POST /api/auth/media-token': 200,
  'GET /api/about': 200,
  'GET /api/settings': 200,
  'GET /api/cameras': 200,
  'POST /api/auth/logout': 204, // asked LAST: it ends the TV session
};
const LOGOUT = 'POST /api/auth/logout';

// ---- the guard ---------------------------------------------------------------------------------------------------

describe('★ #1237 tvAllowed, table-driven', () => {
  const ALLOWED = [
    ['GET', '/api/auth/me'],
    ['POST', '/api/auth/media-token'],
    ['POST', '/api/auth/logout'],
    ['GET', '/api/about'],
    ['GET', '/api/settings'],
    ['GET', '/api/cameras'], // a router-root route: baseUrl + path would rebuild it as /api/cameras/
    ['GET', '/api/cameras?anything=at-all&x=/api/children'], // the query string is cut off, never compared
    ['HEAD', '/api/cameras'], // Express answers HEAD from the GET route
    ['POST', '/live/cam_abc/whep'],
    ['POST', '/live/cam_0f3a2b-sub/whep'],
    ['DELETE', '/live/cam_abc/whep/0b9c1e7a-4d2e-4c1a-9f00-1234567890ab'],
    ['GET', '/hls/cam_abc-hls/index.m3u8?token=x.y.z'],
    ['GET', '/hls/cam_abc-hls/video1_stream.m3u8'],
    ['GET', '/hls/cam_abc-hls/9f3c1d_video1_seg12.mp4'],
    ['HEAD', '/hls/cam_abc-hls/index.m3u8'],
  ];
  const REFUSED = [
    // Wrong methods for an allowed path.
    ['POST', '/api/cameras'], ['PUT', '/api/settings'], ['GET', '/api/auth/logout'], ['DELETE', '/api/auth/me'],
    ['GET', '/api/auth/media-token'], ['HEAD', '/api/auth/media-token'], ['OPTIONS', '/api/cameras'], ['get', '/api/cameras'],
    ['GET', '/live/cam_abc/whep'], ['PATCH', '/live/cam_abc/whep/0b9c'], ['DELETE', '/live/cam_abc/whep'],
    ['POST', '/live/cam_abc/whep/0b9c'], ['POST', '/hls/cam_abc-hls/index.m3u8'], ['DELETE', '/hls/cam_abc-hls/index.m3u8'],
    // A trailing slash or another case reaches the handler in Express; an exact compare refuses it (the safe side).
    ['GET', '/api/cameras/'], ['GET', '/API/cameras'], ['GET', '/api/Cameras'], ['GET', '/api/auth/ME'],
    // Semicolon parameters, an OPTIONS on an allowed HLS file, and HEAD on a path that is not an allowed GET (code review).
    ['GET', '/hls/cam_abc-hls/index.m3u8;foo'], ['GET', '/api/cameras;x=1'], ['OPTIONS', '/hls/cam_abc-hls/index.m3u8'],
    ['HEAD', '/api/children'], ['HEAD', '/api/auth/sessions'],
    ['POST', '/live/CAM_abc/whep'], ['POST', '/live/cam_abc/WHEP'], ['POST', '/live/cam_abc/whep/'],
    ['GET', '/hls/cam_abc-HLS/index.m3u8'], ['GET', '/HLS/cam_abc-hls/index.m3u8'], ['GET', '/hls/cam_abc-hls/index.m3u8/'],
    // Doubled slashes.
    ['GET', '//api/cameras'], ['GET', '/api//cameras'], ['POST', '/live//cam_abc/whep'], ['POST', '/live/cam_abc//whep'],
    ['GET', '/hls/cam_abc-hls//index.m3u8'], ['GET', '/hls//cam_abc-hls/index.m3u8'],
    // Dot segments.
    ['GET', '/api/./cameras'], ['GET', '/api/children/../cameras'], ['GET', '/api/cameras/.'], ['GET', '/api/cameras/..'],
    ['GET', '/hls/cam_abc-hls/..'], ['GET', '/hls/cam_abc-hls/.'], ['DELETE', '/live/cam_abc/whep/..'],
    ['DELETE', '/live/cam_abc/whep/.'],
    // Percent-encoding of any kind: an encoded slash or dot, or an encoded ordinary letter.
    ['GET', '/api%2fcameras'], ['GET', '/api%2Fcameras'], ['GET', '/api/%63ameras'], ['GET', '/hls/cam_abc-hls/%2e%2e'],
    ['GET', '/hls/cam_abc-hls/..%2findex.m3u8'], ['GET', '/hls/cam_abc-hls/%2E%2E%2Fv3'],
    ['DELETE', '/live/cam_abc/whep/..%2F..%2Fv3%2Fconfig'], ['DELETE', '/live/cam_abc/whep/0b9c%2F'],
    // A backslash (some servers read it as a slash).
    ['GET', '/api\\cameras'], ['GET', '/hls/cam_abc-hls/..\\..\\v3'], ['DELETE', '/live/cam_abc/whep/a\\b'],
    // A query string never widens what is compared.
    ['GET', '/api/children?/api/cameras'], ['GET', '/api/children?x=/api/cameras'], ['GET', '/api/auth/sessions?/api/auth/me'],
    ['GET', '/api/cameras/cam-1/snapshot?/api/cameras'],
    // Beyond the media shapes: not the -hls path, a folder, no file, more than one segment, a sub-path of WHEP.
    ['GET', '/hls/cam_abc/index.m3u8'], ['GET', '/hls/cam_abc-hls/sub/index.m3u8'], ['GET', '/hls/cam_abc-hls'],
    ['GET', '/hls/cam_abc-hls/'], ['GET', '/hls/a/b-hls/index.m3u8'], ['POST', '/live/a/b/whep'], ['POST', '/live/whep'],
    ['DELETE', '/live/cam_abc/whep/0b9c/extra'], ['POST', '/live/cam.abc/whep'],
    // The allowed routes' neighbours.
    ['GET', '/api/auth/sessions'], ['GET', '/api/auth/me/mfa'], ['PUT', '/api/auth/me'], ['GET', '/api/cameras/alerts'],
    ['GET', '/api/children'], ['GET', '/api/about/x'], ['GET', '/api/cameras/cam-1/snapshot'], ['GET', '/api/settings/mqtt'],
    ['POST', '/api/cameras/cam-1/snooze'], ['GET', '/api/auth/status'],
    // Not a path at all.
    ['GET', ''], ['GET', '/'], ['GET', 'api/cameras'], ['GET', 'http://example.org/api/cameras'], ['GET', '/api/cameras#x'],
    ['GET', '/api/cameras '], ['GET', '/api/cameras\t'],
  ];
  test('accepts each allowlist entry, the router-root camera list included, and a query string on it', () => {
    const wrong = ALLOWED.filter(([method, url]) => !tvAllowed({ method, originalUrl: url }));
    assert.deepEqual(wrong, [], 'an allowed request was refused');
  });
  test('refuses wrong methods, trailing-slash and case variants, doubled slashes, dot segments, encodings, backslashes and query tricks', () => {
    const wrong = REFUSED.filter(([method, url]) => tvAllowed({ method, originalUrl: url }));
    assert.deepEqual(wrong, [], 'a request that must be refused was allowed');
  });
  test('reads originalUrl, never baseUrl + path, and fails closed without one', () => {
    // Exactly what Express 5.3 hands a router-root route: the pair rebuilds /api/cameras/, which is refused.
    assert.equal(tvAllowed({ method: 'GET', originalUrl: '/api/cameras', baseUrl: '/api/cameras', path: '/' }), true);
    // A refused originalUrl is refused whatever the pair says.
    assert.equal(tvAllowed({ method: 'GET', originalUrl: '/api/children', baseUrl: '/api/cameras', path: '' }), false);
    assert.equal(tvAllowed({ method: 'GET' }), false);
    assert.equal(tvAllowed({ method: 'GET', originalUrl: 42 }), false);
    assert.equal(tvAllowed(undefined), false);
  });
  test('the refusal code is the one the screens key on', () => {
    assert.equal(TV_SESSION_RESTRICTED, 'TV_SESSION_RESTRICTED');
  });
});

describe('★ #1237 the route walk: every pinned route, the real routers at their real paths, as a TV session', () => {
  // The walk, for a TV session `tv` ({ sid, token, media }) paired by the ordinary session `phone`.
  async function walkAsTv(tv, phone) {
    const plan = [];
    const problems = [];
    for (const [key, gate] of Object.entries(ROUTE_GATES)) {
      // A public route reads no session, so a TV token can change nothing there (the design's §6.2).
      if (gate === PUBLIC) continue;
      const [method, fullPath] = key.split(' ');
      const where = locate(fullPath);
      if (!where) { problems.push(`${key}: no mounted router owns this path`); continue; }
      // The request must land on THIS route, not an earlier one matching the same URL (as in route-permissions).
      const answeredBy = firstMatchingRoute(where.router, method.toLowerCase(), instantiate(where.subPath));
      if (answeredBy !== where.subPath) { problems.push(`${key}: answered by ${answeredBy ?? 'no route'} instead`); continue; }
      plan.push({ key, gate, method, url: `${base}${instantiate(fullPath)}` });
    }
    // The real handlers run for the allowed routes, and /logout deletes the TV session: it goes last.
    plan.sort((a, b) => Number(a.key === LOGOUT) - Number(b.key === LOGOUT));
    for (const { key, gate, method, url } of plan) {
      const res = await call(url, { method, token: tv.token });
      if (Object.hasOwn(TV_REACHABLE, key)) {
        if (res.status !== TV_REACHABLE[key]) problems.push(`${key}: the TV should reach it (got ${res.status} ${JSON.stringify(res.body)})`);
      } else if (!isTvRefusal(res)) {
        problems.push(`${key}: a TV session was not refused (got ${res.status} ${JSON.stringify(res.body)})`);
      }
      // The TV's MEDIA token in ?token=, with no header: how an <img> or <video> sends it. No media route is allowed.
      if (gate === MEDIA) {
        const viaQuery = await call(`${url}?token=${tv.media}`, { method });
        if (!isTvRefusal(viaQuery)) problems.push(`${key}?token=<TV media token>: not refused (got ${viaQuery.status} ${JSON.stringify(viaQuery.body)})`);
      }
    }
    assert.deepEqual(problems, [], `\n${problems.join('\n')}`);
    // Every protected route was asked, and every allowlist entry is a pinned route (none was skipped or mistyped).
    assert.equal(plan.length, Object.values(ROUTE_GATES).filter((g) => g !== PUBLIC).length);
    for (const key of Object.keys(TV_REACHABLE)) assert.ok(plan.some((p) => p.key === key), `${key} was not walked`);
    assert.ok(plan.some((p) => p.gate === MEDIA), 'the walk asked no ?token= route');
    // The sign-out at the end was real, and took only the TV session with it.
    assert.equal(sessionRow(tv.sid), undefined, '/logout did not end the TV session');
    assert.ok(sessionRow(phone.sid), "a TV's sign-out ended the session that paired it");
  }

  test('a TV session is refused 403 TV_SESSION_RESTRICTED everywhere but the allowlist, which it reaches; its media token reaches no ?token= route', async () => {
    const phone = userSession(admin);
    await walkAsTv(tvSession(admin, { pairedBySession: phone.sid }), phone);
  });

  test('a TV minted by a REAL pairing (start, approve, poll) is the same session: the same walk, the same reachable set', async () => {
    // An ADMIN approves, so the forced caregiver role is what the walk meets (#1237 PR 1b; tv-pairing.test.js has the
    // pairing's own cases).
    const phone = userSession(admin);
    const started = await call(`${base}/api/auth/device/start`, { method: 'POST', body: { label: 'Walked TV' }, headers: { 'user-agent': TV_UA } });
    assert.equal(started.status, 200, JSON.stringify(started.body));
    const approved = await call(`${base}/api/auth/device/approve`, { method: 'POST', token: phone.token, body: { user_code: started.body.user_code } });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    const collected = await call(`${base}/api/auth/device/poll`, { method: 'POST', body: { device_code: started.body.device_code }, headers: { 'user-agent': TV_UA } });
    assert.equal(collected.body.status, 'approved', JSON.stringify(collected.body));
    const { sid } = JSON.parse(Buffer.from(collected.body.token.split('.')[1], 'base64url').toString());
    const row = sessionRow(sid);
    assert.equal(row.kind, 'tv');
    assert.equal(row.paired_by_session, phone.sid);
    const media = await call(`${base}/api/auth/media-token`, { method: 'POST', token: collected.body.token });
    assert.equal(media.status, 200);
    await walkAsTv({ sid, token: collected.body.token, media: media.body.token }, phone);
  });

  test('the case and trailing-slash variants REACH the camera list for an ordinary session, so refusing them is the guard', async () => {
    const phone = userSession(carer);
    const tv = tvSession(carer);
    for (const variant of ['/API/CAMERAS', '/api/cameras/', '/api/Cameras']) {
      const asUser = await call(`${base}${variant}`, { token: phone.token });
      assert.equal(asUser.status, 200, `${variant}: precondition, Express routes it to the list`);
      assert.ok(Array.isArray(asUser.body));
      assert.ok(isTvRefusal(await call(`${base}${variant}`, { token: tv.token })), `${variant} was not refused to a TV`);
    }
    // ...and a query string on the real list is still the list.
    assert.equal((await call(`${base}/api/cameras?from=tv`, { token: tv.token })).status, 200);
  });

  test('a dead TV token is the usual 401, never told TV_SESSION_RESTRICTED', async () => {
    const tv = tvSession(carer);
    db.prepare('DELETE FROM sessions WHERE id = ?').run(tv.sid);
    const res = await call(`${base}/api/children`, { token: tv.token });
    assert.equal(res.status, 401);
  });
});

// ---- the media proxies ---------------------------------------------------------------------------------------------

// A request with its path sent EXACTLY as written: fetch() resolves dot segments and re-encodes before sending.
function raw(baseUrl, method, rawPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl);
    const req = http.request({ host: u.hostname, port: u.port, method, path: rawPath, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let body = text;
        try { body = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
        resolve({ status: res.statusCode, body });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('★ #1237 the media proxies: /live and /hls, guarded as index.js guards them', () => {
  let proxyBase;
  before(async () => {
    // index.js's two mounts with the real guards in their real order (route-permissions.test.js pins that order in
    // APP_REGISTRATIONS); a sentinel stands where the proxy to MediaMTX would be, so "reached" means "would be proxied".
    const app = express();
    app.use('/live', requireAuth, whepOnlyGuard, (req, res) => res.json({ reached: 'live', url: req.originalUrl }));
    app.use('/hls', requireAuthQueryOrHeader, (req, res) => res.json({ reached: 'hls', url: req.originalUrl }));
    proxyBase = await listen(app);
  });

  test('a TV reaches WebRTC viewing (start and end) and the HLS files, by header or by its media token, HEAD included', async () => {
    const tv = tvSession(carer);
    const bearer = { authorization: `Bearer ${tv.token}` };
    const reached = [
      ['POST', '/live/cam_abc/whep', bearer],
      ['POST', '/live/cam_abc/whep?ignored=1', bearer],
      ['DELETE', '/live/cam_abc/whep/0b9c1e7a-4d2e-4c1a-9f00-1234567890ab', bearer],
      ['GET', `/hls/cam_abc-hls/index.m3u8?token=${tv.media}`, {}],
      ['GET', `/hls/cam_abc-hls/9f3c1d_video1_seg12.mp4?token=${tv.media}`, {}],
      ['GET', '/hls/cam_abc-hls/index.m3u8', bearer],
    ];
    for (const [method, p, headers] of reached) {
      const res = await raw(proxyBase, method, p, headers);
      assert.equal(res.status, 200, `${method} ${p}: ${JSON.stringify(res.body)}`);
      assert.ok(res.body.reached, `${method} ${p} did not reach the proxy`);
    }
    assert.equal((await raw(proxyBase, 'HEAD', `/hls/cam_abc-hls/index.m3u8?token=${tv.media}`)).status, 200);
  });

  test('every other shape is refused to a TV, including the ones an ordinary session reaches through the same mounts', async () => {
    const tv = tvSession(carer);
    const phone = userSession(carer);
    const refusedToBoth = [
      ['GET', '/live/cam_abc/whep', 'session'],
      ['PATCH', '/live/cam_abc/whep/0b9c', 'session'],
      ['POST', '/hls/cam_abc-hls/index.m3u8', 'media'],
    ];
    // Shapes the ORDINARY session reaches (whepOnlyGuard lower-cases and collapses slashes; HLS has no shape check of
    // its own), so the TV's refusal is tvAllowed's and nothing else's.
    const refusedToTvOnly = [
      ['POST', '/live/CAM_ABC/whep', 'session'],
      ['POST', '/live/cam_abc//whep', 'session'],
      ['DELETE', '/live/cam_abc/whep/..%2F..%2Fv3%2Fconfig%2Fglobal%2Fpatch', 'session'],
      ['DELETE', '/live/cam_abc/whep/..', 'session'],
      ['GET', '/hls/cam_abc/index.m3u8', 'media'],
      ['GET', '/hls/cam_abc-hls/../../v3/paths/list', 'media'],
      ['GET', '/hls/cam_abc-hls/%2e%2e/%2e%2e/v3/paths/list', 'media'],
      ['GET', '/hls/cam_abc-hls/..\\..\\v3', 'media'],
      ['GET', '/hls/cam_abc-hls/sub/index.m3u8', 'media'],
      ['GET', '/hls//cam_abc-hls/index.m3u8', 'media'],
    ];
    const ask = (who, method, p, how) => (how === 'media'
      ? raw(proxyBase, method, `${p}${p.includes('?') ? '&' : '?'}token=${who.media}`)
      : raw(proxyBase, method, p, { authorization: `Bearer ${who.token}` }));
    for (const [method, p, how] of [...refusedToBoth, ...refusedToTvOnly]) {
      const res = await ask(tv, method, p, how);
      assert.ok(isTvRefusal(res), `${method} ${p} (TV ${how} token) was not refused: ${res.status} ${JSON.stringify(res.body)}`);
    }
    for (const [method, p, how] of refusedToTvOnly) {
      const res = await ask(phone, method, p, how);
      assert.equal(res.status, 200, `${method} ${p}: precondition, an ordinary ${how} token reaches it (${res.status})`);
    }
  });

  test('a TV media token is never a session token: requireAuth refuses it on /live with the usual 401', async () => {
    const tv = tvSession(carer);
    const res = await raw(proxyBase, 'POST', `/live/cam_abc/whep?token=${tv.media}`, { authorization: `Bearer ${tv.media}` });
    assert.equal(res.status, 401);
  });
});

// ---- verifyToken -----------------------------------------------------------------------------------------------

describe('★ #1237 verifyToken', () => {
  test('refuses a TV session for the media purpose (the talk-back handshake and its re-check); the same account\'s ordinary media token passes', () => {
    const tv = tvSession(admin);
    const phone = userSession(admin);
    assert.equal(verifyToken(tv.media, { purpose: 'media' }), null, 'a TV media token opened the talk-back socket');
    assert.equal(verifyToken(phone.media, { purpose: 'media' })?.sid, phone.sid, 'control: an ordinary media token must still pass');
  });
  test('accepts a TV session token for the normal purpose, as a caregiver of kind tv (what optionalAuth and the Tailscale re-check read)', () => {
    const tv = tvSession(admin);
    const v = verifyToken(tv.token);
    assert.equal(v?.sid, tv.sid);
    assert.equal(v.role, 'caregiver', 'an admin account\'s TV kept the admin role');
    assert.equal(v.kind, 'tv');
    assert.equal(verifyToken(userSession(admin).token).kind, 'user');
    // A media token is never a session, as before.
    assert.equal(verifyToken(tv.media), null);
  });
});

// ---- the projections -------------------------------------------------------------------------------------------

describe('★ #1237 the TV projections: an ADMIN\'s TV, hostile values in every other column', () => {
  // The fields each route may answer a TV with, typed here.
  const TV_CAMERA_KEYS = ['disabled', 'id', 'mediamtx_path', 'name', 'status'];
  const TV_STATUS_KEYS = ['ready', 'unknown'];
  const PUBLIC_SETTINGS_KEYS = ['accent_color', 'app_name', 'font_choice', 'live_color', 'offline_color', 'temp_unit', 'timezone'];
  const PUBLIC_USER_KEYS = ['created_at', 'first_name', 'id', 'last_name', 'mfa_enabled', 'photo', 'role', 'username'];
  const marker = (label) => `qqqqLEAK-${label}`;
  const leak = (body) => {
    const text = JSON.stringify(body);
    const at = text.indexOf('LEAK-');
    return at === -1 ? null : text.slice(Math.max(0, at - 30), at + 50);
  };
  let tv;
  let phone;

  before(() => {
    // Cameras: every column the TV is not given holds a marker, derived from the schema so a column added later is
    // planted too. child_id has a foreign key, so it names a real child whose id is the marker.
    const cameraCols = db.prepare('PRAGMA table_info(cameras)').all().map((c) => c.name);
    const keep = new Set(['id', 'name', 'mediamtx_path', 'disabled']);
    assert.ok(cameraCols.includes('onvif_device_url') && cameraCols.includes('detect_zone'), `schema read found too little: ${cameraCols}`);
    db.prepare("INSERT INTO children (id, name) VALUES (?, 'A child')").run(marker('cameras.child_id'));
    const cams = [['cam-live', 'Camera one', 'cam_live', 0], ['cam-stuck', 'Camera two', 'cam_stuck', 0], ['cam-off', 'Camera three', 'cam_off', 1]];
    cams.forEach(([id, name, mp, disabled], i) => {
      db.prepare('INSERT INTO cameras (id, name, rtsp_url, mediamtx_path, sort_order, disabled) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, name, 'rtsp://u:p@192.0.2.1/stream', mp, i, disabled);
      for (const col of cameraCols) {
        if (keep.has(col) || col === 'sort_order') continue; // the order is the TV's order too, so it stays a number
        db.prepare(`UPDATE cameras SET ${col} = ? WHERE id = ?`).run(marker(`cameras.${col}`), id);
      }
    });
    // Settings: every column outside the public seven (and the row id).
    for (const { name: col } of db.prepare('PRAGMA table_info(settings)').all()) {
      if (col === 'id' || PUBLIC_SETTINGS_KEYS.includes(col)) continue;
      db.prepare(`UPDATE settings SET ${col} = ? WHERE id = 'app'`).run(marker(`settings.${col}`));
    }
    // The admin's own row: every column outside the public user shape, except the two that let it sign in at all.
    for (const { name: col } of db.prepare('PRAGMA table_info(users)').all()) {
      if (PUBLIC_USER_KEYS.includes(col) || col === 'password_set' || col === 'disabled') continue;
      db.prepare(`UPDATE users SET ${col} = ? WHERE id = 'u-admin'`).run(marker(`users.${col}`));
    }
    db.prepare("UPDATE users SET first_name = 'Pat', photo = 'data:image/png;base64,AAAA' WHERE id = 'u-admin'").run();
    phone = userSession(admin);
    tv = tvSession(admin, { pairedBySession: phone.sid });
  });

  test('GET /api/cameras: only id, name, mediamtx_path, disabled and status { ready, unknown }, in the server\'s order', async () => {
    const res = await call(`${base}/api/cameras`, { token: tv.token });
    assert.equal(res.status, 200);
    assert.equal(leak(res.body), null, `the TV camera list leaked: ${leak(res.body)}`);
    for (const cam of res.body) {
      assert.deepEqual(Object.keys(cam).sort(), TV_CAMERA_KEYS, `${cam.id} carries other fields`);
      assert.ok(Object.keys(cam.status).every((k) => TV_STATUS_KEYS.includes(k)), `${cam.id} status: ${JSON.stringify(cam.status)}`);
    }
    assert.deepEqual(res.body, [
      { id: 'cam-live', name: 'Camera one', mediamtx_path: 'cam_live', disabled: 0, status: { ready: true } },
      { id: 'cam-stuck', name: 'Camera two', mediamtx_path: 'cam_stuck', disabled: 0, status: { ready: false, unknown: true } },
      { id: 'cam-off', name: 'Camera three', mediamtx_path: 'cam_off', disabled: 1, status: { ready: false } },
    ]);
    // Control: the plant and the stand-in reach the ordinary answer (its status carries MediaMTX's track list and a
    // reader count), so the TV's clean one is the projection, not an empty fixture.
    const asAdmin = await call(`${base}/api/cameras`, { token: phone.token });
    assert.equal(asAdmin.status, 200);
    const adminText = JSON.stringify(asAdmin.body);
    assert.ok(adminText.includes('LEAK-cameras.onvif_device_url'), 'control: the planted columns did not reach the admin answer');
    assert.ok(adminText.includes('LEAK-mtx.track'), "control: the stand-in MediaMTX's status did not reach the admin answer");
    assert.equal(asAdmin.body.find((c) => c.id === 'cam-live').status.readers, 1);
  });

  test('GET /api/about: stunServers and nothing else', async () => {
    const res = await call(`${base}/api/about`, { token: tv.token });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { stunServers: ['stun:stun.example.org:3478'] });
    const asAdmin = await call(`${base}/api/about`, { token: phone.token });
    assert.equal(asAdmin.body.gitSha, 'LEAK-about.gitSha', 'control: the ordinary answer carries the build fields');
  });

  test('GET /api/settings: the caregiver\'s public seven, because the TV is a caregiver whatever the account is', async () => {
    const res = await call(`${base}/api/settings`, { token: tv.token });
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.body).sort(), PUBLIC_SETTINGS_KEYS);
    assert.equal(leak(res.body), null);
    const asAdmin = await call(`${base}/api/settings`, { token: phone.token });
    assert.ok(leak(asAdmin.body), 'control: the admin answer carries the planted admin fields');
  });

  test('GET /api/auth/me: the public user shape plus kind tv, with the EFFECTIVE role caregiver', async () => {
    const res = await call(`${base}/api/auth/me`, { token: tv.token });
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.body).sort(), [...PUBLIC_USER_KEYS, 'kind'].sort());
    assert.equal(res.body.id, 'u-admin');
    assert.equal(res.body.role, 'caregiver', "an admin account's TV is told it is an admin");
    assert.equal(res.body.kind, 'tv');
    assert.equal(leak(res.body), null);
    // Control: the same account's ordinary session is the admin it is, with the shape it always had.
    const asAdmin = await call(`${base}/api/auth/me`, { token: phone.token });
    assert.equal(asAdmin.body.role, 'admin');
    assert.deepEqual(Object.keys(asAdmin.body).sort(), PUBLIC_USER_KEYS);
  });
});

// ---- the revoke cascade ----------------------------------------------------------------------------------------

describe('★ #1237 the revoke cascade', () => {
  const pushToken = (token, userId, sessionId) =>
    db.prepare('INSERT INTO push_tokens (token, user_id, session_id, platform) VALUES (?, ?, ?, ?)').run(token, userId, sessionId, 'android');
  const pushTokenExists = (token) => !!db.prepare('SELECT 1 FROM push_tokens WHERE token = ?').get(token);
  const revoke = (sid, token) => call(`${base}/api/auth/sessions/${sid}`, { method: 'DELETE', token });

  test('revoking a session ends the TV sessions it paired (and their push registrations); nothing else', async () => {
    const phone = userSession(carer); // the session that paired the TV
    const other = userSession(carer); // another phone of the same account, with a TV of its own
    const unrelated = userSession(carer); // a session that paired nothing
    const tv = tvSession(carer, { pairedBySession: phone.sid });
    const otherTv = tvSession(carer, { pairedBySession: other.sid });
    pushToken('tok-tv', carer.id, tv.sid);
    assert.equal((await revoke(unrelated.sid, phone.token)).status, 204, 'revoking a session that paired nothing');
    assert.ok(sessionRow(tv.sid) && sessionRow(otherTv.sid), 'revoking an unrelated session ended a TV');
    assert.equal((await revoke(phone.sid, other.token)).status, 204);
    assert.equal(sessionRow(phone.sid), undefined);
    assert.equal(sessionRow(tv.sid), undefined, 'the TV the revoked session paired is still signed in');
    assert.equal(pushTokenExists('tok-tv'), false, "the TV's push registration outlived it");
    assert.equal((await call(`${base}/api/auth/me`, { token: tv.token })).status, 401, 'the TV token still works');
    assert.ok(sessionRow(otherTv.sid), 'a TV paired by ANOTHER session was ended');
    assert.ok(sessionRow(other.sid));
  });

  test('every TV the revoked session paired is ended, and only TVs (an ordinary session that names it is not)', async () => {
    const phone = userSession(carer);
    const tvA = tvSession(carer, { pairedBySession: phone.sid });
    const tvB = tvSession(carer, { pairedBySession: phone.sid });
    // Hand-made: no shipped route makes an ordinary session with a paired_by_session. The cascade must still not take it.
    const ordinary = createSession(carer.id, TV_UA, { kind: 'user', pairedBySession: phone.sid });
    assert.equal((await revoke(phone.sid, phone.token)).status, 204);
    assert.equal(sessionRow(tvA.sid), undefined, 'the first TV outlived the revoke');
    assert.equal(sessionRow(tvB.sid), undefined, 'the second TV outlived the revoke');
    assert.ok(sessionRow(ordinary), 'the cascade deleted an ordinary session that merely named the revoked one');
  });

  test('a plain sign-out of the pairing session does not end the TV', async () => {
    const phone = userSession(carer);
    const tv = tvSession(carer, { pairedBySession: phone.sid });
    assert.equal((await call(`${base}/api/auth/logout`, { method: 'POST', token: phone.token })).status, 204);
    assert.equal(sessionRow(phone.sid), undefined);
    assert.ok(sessionRow(tv.sid), 'signing a phone out switched the TV off');
    assert.equal((await call(`${base}/api/auth/me`, { token: tv.token })).status, 200);
  });

  test('an admin revoking another account\'s session ends THAT account\'s TVs (the revoked session\'s account decides)', async () => {
    const carerPhone = userSession(carer);
    const tv = tvSession(carer, { pairedBySession: carerPhone.sid });
    const adminPhone = userSession(admin);
    assert.equal((await revoke(carerPhone.sid, adminPhone.token)).status, 204);
    assert.equal(sessionRow(tv.sid), undefined);
  });

  test('the cascade never reaches another account\'s session, whatever its paired_by_session says', async () => {
    const phone = userSession(carer);
    // Hand-made and impossible through the pairing (a TV signs in as its approver): another account's TV row naming
    // this account's session.
    const stranger = tvSession(admin, { pairedBySession: phone.sid });
    assert.equal((await revoke(phone.sid, phone.token)).status, 204);
    assert.ok(sessionRow(stranger.sid), "revoking one account's session ended another account's TV");
  });

  test('one transaction: a revoke that fails part-way leaves the TV signed in', async () => {
    const phone = userSession(carer);
    const tv = tvSession(carer, { pairedBySession: phone.sid });
    // The pairing session's own delete fails AFTER the TV's has run (TV first, then the session): without the
    // transaction the TV would stay deleted while the request failed.
    db.exec(`CREATE TEMP TRIGGER fail_revoke BEFORE DELETE ON sessions WHEN OLD.id = '${phone.sid}' BEGIN SELECT RAISE(ABORT, 'refused by the test'); END`);
    try {
      const res = await revoke(phone.sid, phone.token);
      assert.equal(res.status, 500);
    } finally {
      db.exec('DROP TRIGGER fail_revoke');
    }
    assert.ok(sessionRow(phone.sid));
    assert.ok(sessionRow(tv.sid), 'a failed revoke still ended the TV');
  });
});

// ---- the session lists, createSession, ordinary sessions -----------------------------------------------------------

describe('★ #1237 the session lists and createSession', () => {
  test('both lists say kind, label and paired_from on every row: null for an ordinary session', async () => {
    const phone = userSession(admin);
    const tv = tvSession(admin, { pairedBySession: phone.sid, label: 'Bedroom TV', pairedFrom: 'Safari on iPhone' });
    for (const p of ['/api/auth/sessions', '/api/auth/sessions/all']) {
      const res = await call(`${base}${p}`, { token: phone.token });
      assert.equal(res.status, 200);
      const by = new Map(res.body.map((s) => [s.id, s]));
      const tvRow = by.get(tv.sid);
      assert.equal(tvRow.kind, 'tv', p);
      assert.equal(tvRow.label, 'Bedroom TV');
      assert.equal(tvRow.paired_from, 'Safari on iPhone');
      assert.equal(tvRow.device, 'Chrome on Android');
      assert.equal('paired_by_session' in tvRow, false, `${p} hands out another session's id`);
      const own = by.get(phone.sid);
      assert.deepEqual([own.kind, own.label, own.paired_from], ['user', null, null], p);
    }
  });

  test('createSession: two arguments give an ordinary session; an unknown kind is refused and stores nothing', () => {
    const sid = createSession(carer.id, 'Mozilla/5.0 (Windows NT 10.0) Firefox/120.0');
    const row = sessionRow(sid);
    assert.deepEqual([row.kind, row.label, row.paired_by_session, row.paired_from], ['user', null, null, null]);
    const before = db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n;
    for (const kind of ['TV', 'admin', '', 'tv ']) {
      assert.throws(() => createSession(carer.id, 'x', { kind }), /unknown session kind/, JSON.stringify(kind));
    }
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, before);
  });

  test('a sign-in through /login makes an ordinary session, as before', async () => {
    makeUser(db, { id: 'u-login', username: 'login-check', role: 'admin', password: 'a-long-password' });
    const res = await call(`${base}/api/auth/login`, { method: 'POST', body: { username: 'login-check', password: 'a-long-password' } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const rows = db.prepare("SELECT kind FROM sessions WHERE user_id = 'u-login'").all();
    assert.deepEqual(rows.map((r) => r.kind), ['user']);
    assert.equal(res.body.user.role, 'admin');
    assert.equal('kind' in res.body.user, false, 'the sign-in answer changed shape');
  });
});

describe('★ #1237 ordinary sessions are untouched by the guard', () => {
  test('an ordinary session reaches a route a TV is refused, with the same answer as before', async () => {
    const phone = userSession(carer);
    const res = await call(`${base}/api/children`, { token: phone.token });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body));
    // And a session whose kind is set to 'user' explicitly is the same thing as one made before the column existed.
    assert.equal(sessionRow(phone.sid).kind, 'user');
  });
});
