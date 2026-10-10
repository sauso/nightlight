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
//   2. The enumeration is compared with ROUTE_GATES and APP_REGISTRATIONS below in BOTH directions: a new
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
//
// NOT COVERED HERE (stated, not hidden):
//   - App-level routes in index.js (/live, /hls, /api/health, /api/csp-report, the SPA fallback) are pinned
//     only structurally, by APP_REGISTRATIONS: index.js cannot be booted in a unit test. /live's second
//     gate (whepOnlyGuard) has its own tests, as does the /api/talk WebSocket upgrade (talk-socket.test.js),
//     which never passes through Express and so is not in this table at all.
//   - Decisions made INSIDE a handler are not gates and are not pinned: DELETE /api/auth/sessions/:id
//     (your own session, or any if admin), GET /api/children/:id/sleep/:date?store=1 (admin-only store),
//     PUT /api/children/:id (a caregiver may change a child's name, birthday, colour and photo, but not
//     track_sleep or the sleep window: #542, children-role-fields.test.js), and the admin-shaped responses
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
// HOW TO UPDATE IT, when this file fails because you changed something on purpose:
//   - NEW ROUTE: add it with the gate you intend. If it is PUBLIC or SIGNED_IN, write one line on why a
//     caregiver (or nobody at all) should reach it, and give the route its own behaviour tests.
//   - GATE CHANGED: change the entry, and say in the PR who gains or loses access. Loosening a gate is a
//     security-relevant change and is reviewed as one.
//   - GONE: delete the entry.
// Do not regenerate the pin from the code to make it green: that turns it back into the thing it replaced.
const PUBLIC = 'public'; //            no authentication at all
const OPTIONAL = 'optional'; //        optionalAuth: answers everyone, says more to a signed-in caller
const MEDIA = 'media'; //              requireAuthQueryOrHeader: a session header, OR a media token in ?token=
const SIGNED_IN = 'signed-in'; //      requireAuth: a session token in the header, ANY role (caregiver included)
const ADMIN = 'signed-in+admin'; //    requireAuth, then requireAdmin

// HISTORY. When this file landed (#563), sixteen routes were pinned at their behaviour of the day and marked
// "pending owner decision" (#538, #542, #552). The owner decided on 2026-10-10: a caregiver can watch and act
// in the moment, but cannot destroy or reconfigure. The entries below are that decision; each one that a
// caregiver can still reach says why on its own line.

const ROUTE_GATES = {
  // /api/auth — the login screen has to work before anyone can sign in, so its first five are public. Each
  // carries its own rate limiter (not pinned here; login-rate-limit.test.js).
  'GET /api/auth/status': PUBLIC, //            needsSetup + demo flags, read by the login screen
  'POST /api/auth/guest': PUBLIC, //            demo mode only; a plain 404 otherwise (demo-guest.test.js)
  'POST /api/auth/setup': PUBLIC, //            first-run admin creation; refuses once any user exists
  'POST /api/auth/login': PUBLIC,
  'POST /api/auth/login/mfa': PUBLIC,
  'POST /api/auth/logout': SIGNED_IN,
  'GET /api/auth/me': SIGNED_IN,
  'POST /api/auth/media-token': SIGNED_IN,
  'GET /api/auth/sessions': SIGNED_IN, //       your own sessions
  'GET /api/auth/sessions/all': ADMIN,
  'DELETE /api/auth/sessions/:id': SIGNED_IN, // own-or-admin is decided in the handler (see header)
  'GET /api/auth/users': ADMIN,
  'POST /api/auth/users': ADMIN,
  'PUT /api/auth/users/:id': ADMIN,
  'PUT /api/auth/me': SIGNED_IN,
  'PUT /api/auth/me/password': SIGNED_IN,
  'GET /api/auth/me/mfa': SIGNED_IN,
  'POST /api/auth/me/mfa/setup': SIGNED_IN,
  'POST /api/auth/me/mfa/enable': SIGNED_IN,
  'POST /api/auth/me/mfa/disable': SIGNED_IN,
  'DELETE /api/auth/users/:id/mfa': ADMIN,
  'DELETE /api/auth/users/:id': ADMIN,

  // /api/children — `router.use(requireAuth)` gates the whole router; add and delete add requireAdmin.
  'GET /api/children': SIGNED_IN,
  'POST /api/children': ADMIN, //                        #542: a new child starts with sleep tracking on
  'PUT /api/children/:id': SIGNED_IN, //                 name/colour/photo; tracking + window refused in the handler (#542)
  'GET /api/children/:id/sleep/live': SIGNED_IN,
  'GET /api/children/:id/sleep/insights': SIGNED_IN,
  'GET /api/children/:id/sleep': SIGNED_IN,
  'GET /api/children/:id/sleep/:date': SIGNED_IN,
  'GET /api/children/:id/review/pending': SIGNED_IN,
  'GET /api/children/:id/review/:date': SIGNED_IN,
  'PUT /api/children/:id/review/:date': SIGNED_IN, //    saving the morning review is acting in the moment (owner)
  'DELETE /api/children/:id': ADMIN, //                  deletes the child's media too

  // /api/cameras — four media routes come BEFORE `router.use(requireAuth)` so an <img>/<video> can load
  // them with ?token=; everything after that line needs a session.
  'GET /api/cameras/alerts/:id/snapshot': MEDIA,
  'GET /api/cameras/bed-transitions/:id/snapshot': MEDIA,
  'GET /api/cameras/alerts/:id/clip': MEDIA,
  'GET /api/cameras/:id/snapshot': MEDIA, //                   the bed-zone picker's still; watching (owner). Spawn cap: #552
  'POST /api/cameras/onvif-probe': ADMIN,
  'POST /api/cameras/probe-report': ADMIN,
  'POST /api/cameras/:id/record/start': SIGNED_IN, //           capturing a moment is acting in it (owner)
  'POST /api/cameras/:id/record/stop': SIGNED_IN,
  'POST /api/cameras/:id/ptz/nudge': SIGNED_IN, //              moving the camera to see the child (owner)
  'POST /api/cameras/:id/restart': SIGNED_IN, //                a recovery action for every viewer (owner)
  'POST /api/cameras/:id/reboot': SIGNED_IN, //                 ditto, heavier; ONVIF cameras only (owner)
  'POST /api/cameras/:id/snooze': SIGNED_IN, //                 mutes a camera's alerts, capped at 12 h (owner)
  'GET /api/cameras': SIGNED_IN, //                             admin sees more fields (see header)
  'GET /api/cameras/alerts': SIGNED_IN,
  'DELETE /api/cameras/alerts': ADMIN, //                       the whole alert history
  'DELETE /api/cameras/alerts/:id/clip': ADMIN, //              #538: one alert's clip, irreversibly
  'GET /api/cameras/clips': SIGNED_IN,
  'GET /api/cameras/:id/sensor-history': SIGNED_IN,
  'GET /api/cameras/:id/activity-history': SIGNED_IN,
  'POST /api/cameras/clips/delete': ADMIN,
  'PUT /api/cameras/reorder': ADMIN, //                         #552: sort_order picks the scoring, timelapse and review camera
  'POST /api/cameras/verify-talk': ADMIN,
  'POST /api/cameras': ADMIN,
  'PUT /api/cameras/:id': ADMIN,
  'PUT /api/cameras/:id/enabled': ADMIN,
  'PUT /api/cameras/:id/detection': ADMIN,
  'PUT /api/cameras/:id/assign': ADMIN, //                      #552: unassigning stops tracking, like track_sleep off
  'DELETE /api/cameras/:id': ADMIN,

  'GET /api/settings': OPTIONAL, //          the public half feeds the login screen; admins get the rest
  'GET /api/settings/mqtt': ADMIN,
  'GET /api/settings/mqtt/status': ADMIN,
  'GET /api/settings/clip-storage': ADMIN,
  'PUT /api/settings': ADMIN,

  'GET /api/logs': ADMIN,
  'DELETE /api/logs': ADMIN,
  'GET /api/diagnostics': ADMIN,
  'GET /api/events': ADMIN,
  'DELETE /api/events': ADMIN,
  'GET /api/about': SIGNED_IN,

  // The FCM image alert is fetched by Android's system layer, which cannot send the app's token. Safe
  // because the id is 256 random bits and the frame expires in minutes (see routes/push.js).
  'GET /api/push/snapshot/:id': PUBLIC,
  'POST /api/push/register': SIGNED_IN,
  'POST /api/push/unregister': SIGNED_IN,
  'GET /api/push/config': SIGNED_IN, //      the Firebase CLIENT config, which a client needs by design
  'GET /api/push/status': SIGNED_IN,
  'PUT /api/push/enable': ADMIN,
  'GET /api/pushover/config': ADMIN,
  'PUT /api/pushover/config': ADMIN,
  'POST /api/pushover/test': ADMIN,
  'GET /api/ntfy/config': ADMIN,
  'PUT /api/ntfy/config': ADMIN,
  'POST /api/ntfy/test': ADMIN,
  'GET /api/gotify/config': ADMIN,
  'PUT /api/gotify/config': ADMIN,
  'POST /api/gotify/test': ADMIN,
  'GET /api/notifications/status': ADMIN,

  'GET /api/timelapses/child/:childId': SIGNED_IN,
  'GET /api/timelapses/:id/video': MEDIA,
  'GET /api/timelapses/:id/thumb': MEDIA,
  'DELETE /api/timelapses/:id': ADMIN, //               a keepsake that cannot be rebuilt
  'GET /api/recordings/child/:childId': SIGNED_IN,
  'GET /api/recordings/:id/video': MEDIA,
  'GET /api/recordings/:id/thumb': MEDIA,
  'DELETE /api/recordings/:id': ADMIN, //               #552: a manual recording or a wake clip; no retention for the former

  'GET /manifest.webmanifest': PUBLIC, //    the PWA manifest; a browser fetches it without credentials
};

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
  'use demoGuard',
  'use /api/auth authRoutes',
  'use /api/children childrenRoutes',
  'use /api/cameras camerasRoutes',
  'use /api/settings settingsRoutes',
  'use /api/logs logsRoutes',
  'use /api/diagnostics diagnosticsRoutes',
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
  'get /api/health <handler>', //                                     PUBLIC: a liveness probe
  'post /api/csp-report express.text() <handler>', //                 PUBLIC: browsers send CSP reports without credentials
  'use express.static()',
  'get * <handler>', //                                               the SPA shell; /api/* falls through to a 404
  'use errorHandler', //                                              not a gate: turns a thrown/rejected handler into JSON (#544); must stay LAST
];
const APP_HANDED_TO = ['applyTrustProxy'];

const HOW_TO_UPDATE = 'If you changed a route or a gate ON PURPOSE, update ROUTE_GATES / APP_REGISTRATIONS in ' +
  'backend/test/route-permissions.test.js and say in the PR who gains or loses access. Do not regenerate the pin from the code.';

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
