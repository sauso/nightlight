// Every route's permission gate, pinned (issue #563).
//
// WHY THIS EXISTS. A mutation pass deleted `requireAdmin` from routes one at a time, and eleven of those
// deletions left the whole backend suite green: POST and PUT /api/cameras, PUT /api/cameras/:id/enabled,
// DELETE /api/children/:id, PUT /api/push/enable, GET /api/logs (server logs readable by any caregiver),
// DELETE /api/events (a history wipe), GET /api/diagnostics, and the ntfy / Pushover / Gotify config and
// test routes. A twelfth, DELETE /api/cameras/:id, was caught only by accident, by an unrelated timelapse
// test. A caregiver login that can read the server log or wipe the history is exactly the regression
// nobody notices until it is used, and the W5 permission work (#538, #542, #552) is about to change gates
// on purpose. This file has to land first so that every one of those changes is visible.
//
// WHAT IT CHECKS, and why each part is shaped the way it is:
//   1. The route table is ENUMERATED, never typed. index.js cannot be imported (it starts MediaMTX, MQTT
//      and an HTTP listener), so its registrations are read from the source by a tokenizer
//      (helpers/routeTable.js); every router it mounts is then imported and its real `router.stack`
//      walked, comparing the guard FUNCTIONS by identity. A route added anywhere appears here whether or
//      not its author knew this file existed, and anything the enumerator cannot read throws instead of
//      being skipped.
//   2. The enumeration is compared with ROUTE_GATES (helpers/routeGates.js) and APP_REGISTRATIONS below in BOTH directions: a new
//      route, a removed route, and a gate added, removed or reordered all fail until a human edits the pin.
//      That is the point. A permission change should be a line someone wrote on purpose, in a diff a
//      reviewer reads, not a side effect of an unrelated refactor.
//   3. Over real HTTP against the real routers, the pin's claims are enforced: anonymous gets 401 on every
//      gated route; an admin's MEDIA-scoped token gets 401 on every route that wants a session (a leaked
//      <img> URL must never reach the API); a caregiver gets requireAdmin's 403 on every admin route.
//      ⚠️ THE EXPECTATIONS COME FROM THE PIN, NOT FROM THE ENUMERATION. Deriving them from the code under
//      test would let a deleted gate change the expectation along with the behaviour, and nothing would fail.
//   4. The positive direction ("an admin does get through") without running a single real handler: each
//      route's own middleware functions are mounted in front of a sentinel, and the weakest caller the pin
//      says is enough must reach it. Running the real handlers as an admin would restart transcoders,
//      probe ONVIF devices and initialise Firebase from a unit test.
//      Since #1237 this part is also the regression test for ORDINARY sessions against the TV allowlist: the
//      probes sit under `/p<i>`, a path a TV session is always refused, so a guard that ever fired for a
//      session of kind 'user' would fail every probe here. The TV's own walk is tv-session.test.js.
//
// NOT COVERED HERE (stated, not hidden):
//   - App-level routes in index.js (/live, /hls, /api/health, /api/csp-report, the SPA fallback) are pinned
//     only structurally, by APP_REGISTRATIONS: index.js cannot be booted in a unit test. /live's second
//     gate (whepOnlyGuard) has its own tests, as does the /api/talk WebSocket upgrade (talk-socket.test.js),
//     which never passes through Express and so is not in this table at all.
//   - Decisions made INSIDE a handler are not gates and are not pinned: DELETE /api/auth/sessions/:id
//     (your own session, or any if admin), GET /api/children/:id/sleep/:date?store=1 (admin-only store),
//     PUT /api/children/:id (a caregiver may change a child's name, birthday, colour and photo, but not
//     track_sleep, the sleep window, the primary camera or the two sleep report switches sleep_report_enabled and
//     sleep_report_show_name: #542/#655, children-role-fields.test.js; #397/#398, sleep-report-prefs.test.js), PUT /api/cameras/reorder
//     (a non-admin's reorder that would change the camera a tracked child is measured from is refused with a
//     409: #675, reorder-scoring-guard.test.js), and the admin-shaped responses
//     of GET /api/cameras and GET /api/settings. Most have their own tests (auth-routes.test.js,
//     recompute-night.test.js, settings-exposure.test.js); the admin-vs-caregiver shape of the GET
//     /api/cameras LIST has none that was found when this file was written (2026-10-09). PUT
//     /api/cameras/:id/assign used to be listed here for its response shape; it is an admin gate now
//     (#552) and pinned below like any other.
//   - Rate limiters in front of routes are not pinned (login-rate-limit.test.js covers them).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';
import {
  useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, signToken, call,
} from './helpers/harness.js';
import {
  scanAppRegistrations, enumerateRouter, classifyChain, chainNames, instantiate, firstMatchingRoute,
} from './helpers/routeTable.js';
import { PUBLIC, OPTIONAL, MEDIA, SIGNED_IN, ADMIN, ROUTE_GATES } from './helpers/routeGates.js';

useTempDataDir();

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', 'src');
const INDEX = path.join(SRC, 'index.js');

const { default: db } = await import('../src/db.js');
const auth = await import('../src/middleware/auth.js');
const GUARDS = {
  requireAuth: auth.requireAuth,
  requireAuthQueryOrHeader: auth.requireAuthQueryOrHeader,
  optionalAuth: auth.optionalAuth,
  requireAdmin: auth.requireAdmin,
};

// ---- the pin ----------------------------------------------------------------------------------------------
//
// The table itself (ROUTE_GATES) and its gate names live in helpers/routeGates.js since #1237, so tv-session.test.js
// walks the same routes. HOW TO UPDATE IT is written there.

// index.js's own registrations, in order. Order is part of the contract: express.json() and demoGuard must
// come before the routers, and /live and /hls are mounted before express.json() so a WHEP offer streams
// through untouched. `applyTrustProxy(app)` is the one function `app` itself is handed to (it only calls
// app.set); anything new there could register a route this scan cannot see, so that list is pinned too.
const APP_REGISTRATIONS = [
  'use helmet()',
  'use [/api,/live,/hls] demoRequestLimiter',
  'use /live requireAuth whepOnlyGuard createProxyMiddleware()', //   SIGNED_IN, plus whepOnlyGuard
  'use /hls requireAuthQueryOrHeader createProxyMiddleware()', //      MEDIA: Safari's <video> cannot send a header
  'use express.json()',
  'use defaultBody', //                                               no gate: Express 5 leaves req.body undefined, this restores Express 4's {}
  'use demoGuard',
  'use /api/auth authRoutes',
  'use /api/children childrenRoutes',
  'use /api/cameras camerasRoutes',
  'use /api/setup setupRoutes',
  'use /api/settings settingsRoutes',
  'use /api/logs logsRoutes',
  'use /api/diagnostics diagnosticsRoutes',
  'use /api/remote-access/tailscale tailscaleRoutes',
  'use /api/remote-access remoteAccessRoutes',
  'use /api/esphome esphomeRoutes',
  'use /api/events eventsRoutes',
  'use /api/about aboutRoutes',
  'use /api/push pushRoutes',
  'use /api/pushover pushoverRoutes',
  'use /api/ntfy ntfyRoutes',
  'use /api/gotify gotifyRoutes',
  'use /api/notifications notificationsRoutes',
  'use /api/timelapses timelapsesRoutes',
  'use /api/recordings recordingsRoutes',
  'use /manifest.webmanifest manifestRoutes',
  'get /api/health healthHandler', //                                 PUBLIC: a liveness probe (+ server id and name, #937)
  'post /api/csp-report express.text() <handler>', //                 PUBLIC: browsers send CSP reports without credentials
  'use express.static()',
  'get /{*splat} <handler>', //                                       the SPA shell (Express 5 spelling of the old `*`); /api/* falls through to a 404
  'use errorHandler', //                                              not a gate: turns a thrown/rejected handler into JSON (#544); must stay LAST
];
// listenOrFail(app, PORT, ...) only calls app.listen (lib/listenOrFail.js: Express 5 reports a bind failure through the callback);
// it registers no route, which is what this pin exists to keep true of anything `app` is handed to.
const APP_HANDED_TO = ['applyTrustProxy', 'listenOrFail'];

const HOW_TO_UPDATE = 'If you changed a route or a gate ON PURPOSE, update ROUTE_GATES in backend/test/helpers/routeGates.js ' +
  '(or APP_REGISTRATIONS in backend/test/route-permissions.test.js) and say in the PR who gains or loses access. Do not ' +
  'regenerate the pin from the code.';

// ---- the enumeration --------------------------------------------------------------------------------------

const SCAN = scanAppRegistrations(fs.readFileSync(INDEX, 'utf8'));
// A router mount is `app.use('<path>', <name>)` where <name> was imported from ./routes/. Anything else
// registered on `app` is pinned as an opaque registration by APP_REGISTRATIONS.
const MOUNTS = [];
for (const reg of SCAN.registrations) {
  const [where, what] = reg.args;
  const spec = what?.ident && SCAN.imports.get(what.ident);
  if (reg.verb !== 'use' || reg.args.length !== 2 || where.value === undefined || !spec?.startsWith('./routes/')) continue;
  const { default: router } = await import(new URL(spec, pathToFileURL(INDEX)).href);
  MOUNTS.push({ mount: where.value, spec, router });
}
const ROUTES = MOUNTS.flatMap(({ mount, spec, router }) => enumerateRouter(router, mount, spec));
const byKey = new Map(ROUTES.map((r) => [r.key, r]));

// The mount a full path belongs to (longest prefix wins), and the path inside that router.
function locate(fullPath) {
  const m = MOUNTS.filter(({ mount }) => fullPath === mount || fullPath.startsWith(`${mount}/`))
    .sort((a, b) => b.mount.length - a.mount.length)[0];
  if (!m) return null;
  return { ...m, subPath: fullPath.slice(m.mount.length) || '/' };
}
const splitKey = (key) => {
  const [method, fullPath] = key.split(' ');
  return { method: method.toLowerCase(), fullPath };
};

// ---- credentials ------------------------------------------------------------------------------------------

let adminToken;
let caregiverToken;
let adminMediaToken;
let caregiverMediaToken;
before(() => {
  const admin = makeUser(db, { id: 'u-admin', username: 'admin', role: 'admin' });
  const carer = makeUser(db, { id: 'u-carer', username: 'carer', role: 'caregiver' });
  const adminSid = makeSession(db, admin.id);
  const carerSid = makeSession(db, carer.id);
  adminToken = signToken({ id: admin.id, username: admin.username, role: 'admin', sid: adminSid });
  caregiverToken = signToken({ id: carer.id, username: carer.username, role: 'caregiver', sid: carerSid });
  // Media tokens name the same live sessions, exactly as routes/auth.js /media-token mints them.
  adminMediaToken = signToken({ id: admin.id, username: admin.username, role: 'admin', sid: adminSid, purpose: 'media' });
  caregiverMediaToken = signToken({ id: carer.id, username: carer.username, role: 'caregiver', sid: carerSid, purpose: 'media' });
});

const servers = [];
async function listen(app) {
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}
after(async () => {
  await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));
  db.close();
  cleanupTempDataDirs();
});

// ---- 1. the enumerator itself can fail ---------------------------------------------------------------------
// A guard that has only ever seen the real index.js has not been shown to see anything. These fixtures are
// written to defeat the obvious cheap implementations (a regex over the text, a name comparison).

describe('the route table is enumerated from the source, and the enumerator cannot be fooled cheaply', () => {
  test('the index.js scanner ignores registrations inside comments, strings and templates, and sees one after a regex holding `//`', () => {
    const src = [
      "import fooRoutes from './routes/foo.js';",
      'const app = express();',
      "// app.get('/commented-out', (req, res) => res.end());",
      "/* app.use('/also-commented', fooRoutes); */",
      'const s = "app.get(\'/in-a-string\', h)";',
      "const t = `${ { a: 1 }.a } app.post('/in-a-template', h) ${`nested ${'}'}`}`;",
      // A naive comment stripper reads `//i.test(x)) app.get(...)` as a comment and loses the registration.
      "if (/^https?:\\/\\//i.test(x)) app.get('/after-a-regex', h);",
      "app.use('/api/foo', fooRoutes);",
      "app.delete('/api/x', requireAuth, requireAdmin, async (req, res) => { res.end(); });",
      'configure(app, 1);',
      'app.listen(4000);',
    ].join('\n');
    const { registrations, imports, handedTo } = scanAppRegistrations(src);
    assert.deepEqual(registrations.map((r) => r.text), [
      'get /after-a-regex h',
      'use /api/foo fooRoutes',
      'delete /api/x requireAuth requireAdmin <handler>',
    ]);
    assert.equal(imports.get('fooRoutes'), './routes/foo.js');
    assert.deepEqual(handedTo, ['configure'], '`app` handed to another function must be reported, not ignored');
  });

  test('the scanner refuses what it cannot read instead of skipping it', () => {
    for (const src of ["app['get']('/x', h);", "app.frobnicate('/x', h);", 'app?.use(h);']) {
      assert.throws(() => scanAppRegistrations(src), /unrecognised/, src);
    }
  });

  test('a chain is classified by the guard FUNCTIONS it holds and their order, not by names or position in the file', () => {
    const G = GUARDS;
    const router = express.Router();
    router.get('/before-the-use', (req, res) => res.end());
    router.use(G.requireAuth);
    router.get('/after-the-use', (req, res) => res.end());
    router.post('/admin', G.requireAdmin, (req, res) => res.end());
    // A look-alike: same name, not the real guard. Comparing by name would call this admin-only.
    const lookAlike = { requireAdmin(req, res, next) { next(); } }.requireAdmin;
    router.put('/look-alike', lookAlike, (req, res) => res.end());
    const gates = Object.fromEntries(enumerateRouter(router, '/m', 'fixture').map((r) => [r.key, classifyChain(r.chain, G)]));
    assert.deepEqual(gates, {
      'GET /m/before-the-use': PUBLIC,
      'GET /m/after-the-use': SIGNED_IN,
      'POST /m/admin': ADMIN,
      'PUT /m/look-alike': SIGNED_IN,
    });
    // requireAdmin in front of authentication refuses everyone, admins included; it must never match a pin.
    assert.equal(classifyChain([G.requireAdmin, G.requireAuth], G), 'signed-in+admin-before-auth');
    assert.equal(classifyChain([G.requireAuthQueryOrHeader, G.requireAdmin], G), 'media+admin');
  });

  test('a router shape the enumerator does not understand throws instead of being skipped', () => {
    const nested = express.Router();
    nested.use('/sub', express.Router());
    assert.throws(() => enumerateRouter(nested, '/m', 'nested'), /nested router/);
    const scoped = express.Router();
    scoped.use('/only-here', GUARDS.requireAuth);
    assert.throws(() => enumerateRouter(scoped, '/m', 'scoped'), /router\.use\(\) with a path/);
    assert.throws(() => enumerateRouter({}, '/m', 'not-a-router'), /no router\.stack/);
  });
});

// ---- 2. the pin --------------------------------------------------------------------------------------------

describe('the pin', () => {
  test('every file in src/routes is mounted by index.js exactly once', () => {
    const files = fs.readdirSync(path.join(SRC, 'routes')).filter((f) => f.endsWith('.js')).map((f) => `./routes/${f}`).sort();
    const mounted = MOUNTS.map((m) => m.spec).sort();
    // A router mounted some way the scanner does not read (a loop over a table, a helper that takes `app`)
    // shows up here as "not mounted", so its routes cannot silently go unenumerated.
    assert.deepEqual(mounted, files);
  });

  test('index.js registers exactly the pinned middleware and routes, in the pinned order', () => {
    assert.deepEqual(SCAN.registrations.map((r) => r.text), APP_REGISTRATIONS, HOW_TO_UPDATE);
    assert.deepEqual(SCAN.handedTo, APP_HANDED_TO, `\`app\` is handed to a function that could register routes. ${HOW_TO_UPDATE}`);
  });

  test('every route has exactly the gate the pin says, no route is unpinned, and no pinned route has gone', (t) => {
    const problems = [];
    const seen = new Set();
    for (const r of ROUTES) {
      const actual = classifyChain(r.chain, GUARDS);
      const detail = `[chain: ${chainNames(r.chain, GUARDS).join(' > ') || 'nothing'}]`;
      if (seen.has(r.key)) problems.push(`REGISTERED TWICE: ${r.key}; the pin cannot say which gate answers it ${detail}`);
      seen.add(r.key);
      if (!Object.hasOwn(ROUTE_GATES, r.key)) problems.push(`NEW ROUTE, not pinned: '${r.key}': '${actual}' ${detail}`);
      else if (ROUTE_GATES[r.key] !== actual) {
        problems.push(`GATE CHANGED: ${r.key} is pinned '${ROUTE_GATES[r.key]}' but is now '${actual}' ${detail}`);
      }
    }
    for (const key of Object.keys(ROUTE_GATES)) if (!seen.has(key)) problems.push(`GONE: ${key} is pinned but no router answers it`);
    assert.deepEqual(problems, [], `\n${problems.join('\n')}\n\n${HOW_TO_UPDATE}`);
    t.diagnostic(`${ROUTES.length} routes pinned; ${Object.values(ROUTE_GATES).filter((e) => e === ADMIN).length} admin-only`);
  });
});

// ---- 3. the gates refuse who the pin says, over real HTTP ---------------------------------------------------

describe('the real routers refuse who the pin says', () => {
  let base;
  before(async () => {
    // The routers exactly as index.js mounts them, in its order, behind the same body parser. Not
    // demoGuard or the demo limiter: both are no-ops outside DEMO_MODE (demoMode.test.js).
    const app = express();
    app.use(express.json());
    for (const { mount, router } of MOUNTS) app.use(mount, router);
    base = await listen(app);
  });

  // Every pinned route the expectation applies to, with the request that tests it. Built from the PIN.
  function targets(wanted) {
    const out = [];
    const problems = [];
    for (const [key, gate] of Object.entries(ROUTE_GATES)) {
      if (!wanted(gate)) continue;
      const { method, fullPath } = splitKey(key);
      const where = locate(fullPath);
      if (!where) { problems.push(`${key}: no mounted router owns this path`); continue; }
      // The request must land on THIS route, not an earlier one that also matches the URL; otherwise the
      // status below would belong to some other route's gate.
      const answeredBy = firstMatchingRoute(where.router, method, instantiate(where.subPath));
      if (answeredBy !== where.subPath) {
        problems.push(`${key}: a request for it is answered by ${answeredBy ? `the earlier route ${where.mount}${answeredBy}` : 'no route'}`);
        continue;
      }
      out.push({ key, method, url: `${base}${instantiate(fullPath)}` });
    }
    return { out, problems };
  }

  async function expectAll(list, problems, { token, headers }, check) {
    for (const { key, method, url } of list) {
      const res = await call(url, { method: method.toUpperCase(), token, headers });
      const wrong = check(res);
      if (wrong) problems.push(`${key}: ${wrong} (got ${res.status} ${JSON.stringify(res.body)})`);
    }
    return problems;
  }

  test('the credentials are live, so every refusal below is the gate and not a dead token', async () => {
    const asAdmin = await call(`${base}/api/auth/me`, { token: adminToken });
    assert.equal(asAdmin.status, 200);
    assert.equal(asAdmin.body.role, 'admin');
    const asCarer = await call(`${base}/api/auth/me`, { token: caregiverToken });
    assert.equal(asCarer.status, 200);
    assert.equal(asCarer.body.role, 'caregiver');
    // The admin media token gets PAST a media route's gate (404: no such recording), so its 401s on the
    // session routes below are about its purpose, not its validity.
    const media = await call(`${base}/api/recordings/${instantiate(':id')}/video?token=${adminMediaToken}`);
    assert.equal(media.status, 404);
    assert.deepEqual(media.body, { error: 'No recording for this id' });
  });

  test('anonymous: 401 on every route the pin says needs a session or a media token', async () => {
    const { out, problems } = targets((g) => g !== PUBLIC && g !== OPTIONAL);
    assert.ok(out.length > 0);
    await expectAll(out, problems, {}, (res) => (res.status === 401 ? null : 'expected 401 for an anonymous caller'));
    assert.deepEqual(problems, [], `\n${problems.join('\n')}`);
  });

  test("an admin's MEDIA token: 401 on every route the pin says needs a session (a leaked <img> URL never reaches the API)", async () => {
    const { out, problems } = targets((g) => g.startsWith(SIGNED_IN));
    assert.ok(out.length > 0);
    await expectAll(out, problems, { token: adminMediaToken }, (res) => (res.status === 401 ? null : 'expected 401 for a media-scoped token'));
    assert.deepEqual(problems, [], `\n${problems.join('\n')}`);
  });

  test("a caregiver: requireAdmin's 403 on every route the pin says is admin-only", async () => {
    const { out, problems } = targets((g) => g === ADMIN);
    assert.equal(out.length + problems.length, Object.values(ROUTE_GATES).filter((e) => e === ADMIN).length);
    await expectAll(out, problems, { token: caregiverToken }, (res) => (
      res.status === 403 && res.body?.error === 'Admin access required' ? null : "expected requireAdmin's 403 for a caregiver"
    ));
    assert.deepEqual(problems, [], `\n${problems.join('\n')}`);
  });
});

// ---- 4. the gates admit who the pin says, without running a handler -----------------------------------------

describe('the gates admit who the pin says', () => {
  test('each route\'s own middleware, in front of a sentinel, lets through the weakest caller the pin says is enough', async () => {
    // One probe app; each route under its own prefix so no probe can shadow another. The middleware are the
    // route's real function objects (router-level use() first, as Express runs them); only the final
    // handler is replaced, so no camera is restarted and no device is probed.
    const app = express();
    app.use(express.json());
    const probes = [];
    const problems = [];
    Object.keys(ROUTE_GATES).forEach((key, i) => {
      const route = byKey.get(key);
      if (!route) { problems.push(`${key}: pinned but not enumerated (see the pin test)`); return; }
      const prefix = `/p${i}`;
      app[route.method](`${prefix}${route.mount}${route.path === '/' ? '' : route.path}`, ...route.chain, (req, res) => res.json({ reached: key }));
      probes.push({ key, method: route.method, path: `${prefix}${instantiate(key.split(' ')[1])}` });
    });
    const probeBase = await listen(app);
    // The weakest credential each gate is supposed to accept.
    const CALLER = {
      [PUBLIC]: {},
      [OPTIONAL]: {},
      [MEDIA]: { query: caregiverMediaToken },
      [SIGNED_IN]: { token: caregiverToken },
      [ADMIN]: { token: adminToken },
    };
    for (const { key, method, path: p } of probes) {
      const who = CALLER[ROUTE_GATES[key]];
      if (!who) { problems.push(`${key}: pinned gate '${ROUTE_GATES[key]}' has no caller defined here`); continue; }
      const url = `${probeBase}${p}${who.query ? `?token=${who.query}` : ''}`;
      const res = await call(url, { method: method.toUpperCase(), token: who.token });
      if (res.status !== 200 || res.body?.reached !== key) problems.push(`${key}: the gate did not admit ${JSON.stringify(Object.keys(who))} (got ${res.status} ${JSON.stringify(res.body)})`);
    }
    assert.equal(probes.length, Object.keys(ROUTE_GATES).length);
    assert.deepEqual(problems, [], `\n${problems.join('\n')}`);
  });
});
