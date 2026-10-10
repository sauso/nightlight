// A failing async route handler must END in a response (issue #544).
//
// BEFORE: Express 4 ignores the promise an `async` handler returns, and the app had no error middleware.
// A throw before a handler's own try/catch became an unhandled rejection that processGuards.js logged and
// carried on from, and the request never got ANY answer (the UI spinner spun; behind Cloudflare, a bodiless
// 524). Reproduced with: PUT /api/cameras/:id with a child_id that no longer exists, PUT /api/pushover/config
// with `app_token: 5`, POST /api/cameras with `name: 5`.
//
// WHAT THIS FILE PINS, and which mutation each block kills (all run by hand, see the PR):
//   1. lib/asyncHandler.js: a rejection, and a synchronous throw, reach `next`; success does not.
//        mutant: drop the `.catch(next)`            -> "a rejected handler calls next(err)" fails
//        mutant: drop the try/catch around `fn(...)` -> "a synchronous throw" fails
//   2. middleware/errorHandler.js: the 4xx-vs-5xx rule, and that nothing internal reaches the client.
//        mutant: put err.message in the 500 body    -> "500 body carries NONE of the error" fails
//        mutant: answer 400 for a foreign-key error -> the FK test fails (status)
//   3. The three issue repros against the REAL routers.
//   4. THE CLASS GUARD: every router's registered functions, walked from the real `router.stack`, include no
//      bare `async` function. This is what stops the next route from bringing the hang back.
//        mutant: remove asyncHandler( from any one handler -> the guard names it
//
// NOT COVERED HERE (stated, not hidden):
//   - The class guard recognises a bare `async` function (constructor name AsyncFunction). A NON-async
//     handler that returns a promise (`(req, res) => doThing().then(...)`) cannot be seen from outside and is
//     not caught; routes in src/routes have none today.
//   - index.js cannot be imported (it boots MediaMTX and an HTTP listener), so "errorHandler is mounted last"
//     is pinned only structurally, by APP_REGISTRATIONS in route-permissions.test.js.
//   - app.* handlers defined in index.js itself are not walked; none is async.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';
import rateLimit from 'express-rate-limit';
import {
  useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, makeChild, makeCamera, signToken, call, mountRouter,
} from './helpers/harness.js';

useTempDataDir();

const { default: db } = await import('../src/db.js');
const { asyncHandler, WRAPPED } = await import('../src/lib/asyncHandler.js');
const { errorHandler } = await import('../src/middleware/errorHandler.js');
const { logger } = await import('../src/lib/logger.js');

// A recognisable string planted in every error below. If it shows up in a response body, internals leaked.
const MARKER = 'LEAKMARKER_7f3a_do_not_send';

const listen = (app) => new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const closeServer = (s) => new Promise((resolve) => { s.closeAllConnections?.(); s.close(resolve); });
const logText = () => logger.getRecent().join('\n');

// Top level, so it runs after EVERY suite below: the class guard imports every router, and some of them
// touch the database as they load.
after(() => {
  db.close();
  cleanupTempDataDirs();
});

// ---- 1. the wrapper ---------------------------------------------------------------------------------------

describe('asyncHandler', () => {
  test('a rejected handler calls next(err) with that error', async () => {
    const boom = new Error(MARKER);
    const calls = [];
    const h = asyncHandler(async () => { throw boom; });
    h({}, {}, (e) => calls.push(e));
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(calls, [boom]);
  });

  test('a synchronous throw from the handler calls next(err) too', () => {
    const boom = new Error(MARKER);
    const calls = [];
    // Not async: the throw happens before any promise exists, so only a try/catch can see it.
    asyncHandler(() => { throw boom; })({}, {}, (e) => calls.push(e));
    assert.deepEqual(calls, [boom]);
  });

  test('a throw before the first await inside an async function is a rejection, and is caught', async () => {
    const calls = [];
    asyncHandler(async () => { null.x; })({}, {}, (e) => calls.push(e)); // eslint-disable-line no-unused-expressions
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.length, 1);
    assert.ok(calls[0] instanceof TypeError);
  });

  test('success never calls next, and the handler gets req, res and next unchanged and is called synchronously', async () => {
    const seen = [];
    const next = () => seen.push('next called');
    const req = {}; const res = {};
    asyncHandler(async (a, b, c) => { seen.push(a === req, b === res, c === next); })(req, res, next);
    // Synchronous: the handler's first line has already run before any microtask.
    assert.deepEqual(seen, [true, true, true]);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(seen, [true, true, true]);
  });

  test('the wrapper is marked, has exactly three parameters (Express would treat four as an error handler), and refuses a non-function', () => {
    const w = asyncHandler(async () => {});
    assert.equal(w[WRAPPED], true);
    assert.equal(w.length, 3);
    assert.throws(() => asyncHandler('nope'), TypeError);
  });
});

// ---- 2. the error middleware ------------------------------------------------------------------------------

describe('errorHandler over real HTTP', () => {
  let server;
  let base;

  before(async () => {
    const app = express();
    app.use(express.json());
    app.get('/reject', asyncHandler(async () => { throw new Error(`${MARKER} detail`); }));
    app.get('/sync-throw-in-async', asyncHandler(async () => { JSON.parse(`{${MARKER}`); }));
    // REAL SqliteErrors from the real schema (a foreign-key failure and a not-null failure), neither
    // hand-built, so the test cannot drift from what better-sqlite3 really throws.
    app.get('/fk', asyncHandler(async () => {
      db.prepare('INSERT INTO cameras (id, name, rtsp_url, child_id, mediamtx_path) VALUES (?, ?, ?, ?, ?)')
        .run('fk-cam', `${MARKER}-name`, 'rtsp://x/y', 'no-such-child', 'p_fk');
    }));
    app.get('/not-null', asyncHandler(async () => {
      db.prepare('INSERT INTO cameras (id, name) VALUES (?, ?)').run(`${MARKER}-id`, null);
    }));
    app.get('/status-418', asyncHandler(async () => { throw Object.assign(new Error(`${MARKER} teapot`), { status: 418 }); }));
    app.get('/statusCode-422', asyncHandler(async () => { throw Object.assign(new Error(`${MARKER} nope`), { statusCode: 422 }); }));
    app.get('/exposed-400', asyncHandler(async () => {
      throw Object.assign(new Error('Pick a smaller photo.'), { status: 400, expose: true });
    }));
    app.get('/status-401', asyncHandler(async () => { throw Object.assign(new Error(`${MARKER} upstream says 401`), { status: 401 }); }));
    app.get('/status-403', asyncHandler(async () => { throw Object.assign(new Error(`${MARKER} upstream says 403`), { statusCode: 403 }); }));
    app.get('/status-503', asyncHandler(async () => { throw Object.assign(new Error(`${MARKER} unavailable`), { status: 503 }); }));
    app.get('/non-error', asyncHandler(async () => { throw `${MARKER} a thrown string`; })); // eslint-disable-line no-throw-literal
    app.get('/query-secret', asyncHandler(async () => { throw new Error('boom for the query-secret route'); }));
    app.get('/after-reply', asyncHandler(async (req, res) => {
      res.json({ ok: true });
      throw new Error(`${MARKER} after the reply`);
    }));
    app.get('/mid-stream', asyncHandler(async (req, res) => {
      res.write('partial-'); // headers go out now; the body is not finished
      await new Promise((r) => setTimeout(r, 20));
      throw new Error(`${MARKER} mid stream`);
    }));
    app.post('/echo', (req, res) => res.json({ got: req.body }));
    app.use(errorHandler);
    server = await listen(app);
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => closeServer(server));

  const get = (p) => call(`${base}${p}`);
  const noLeak = (res) => {
    const text = JSON.stringify(res.body);
    for (const needle of [MARKER, 'SqliteError', 'SQLITE', 'cameras', 'FOREIGN KEY', 'NOT NULL', '\n', '.js', 'node_modules', 'TypeError', 'SyntaxError']) {
      assert.ok(!text.includes(needle), `response body must not contain ${JSON.stringify(needle)}: ${text}`);
    }
  };

  test('a rejected handler is a 500 with the generic JSON message, and the 500 body carries NONE of the error', async () => {
    const res = await get('/reject');
    assert.equal(res.status, 500);
    assert.deepEqual(Object.keys(res.body), ['error']);
    assert.equal(typeof res.body.error, 'string');
    noLeak(res);
  });

  test('the real error (marker and stack) is logged server-side instead', async () => {
    await get('/reject');
    const text = logText();
    assert.ok(text.includes(`${MARKER} detail`), 'the message must be in the log');
    assert.ok(text.includes('GET /reject'), 'the log names the request');
    assert.ok(/at .*async-errors\.test\.js/.test(text), 'the stack must be in the log');
  });

  test('an exception thrown inside an async handler (not a thrown Error object we built) is a clean 500', async () => {
    const res = await get('/sync-throw-in-async');
    assert.equal(res.status, 500);
    noLeak(res);
  });

  test('a thrown non-Error (a string) is a clean 500 and is logged', async () => {
    const res = await get('/non-error');
    assert.equal(res.status, 500);
    noLeak(res);
    assert.ok(logText().includes(`${MARKER} a thrown string`));
  });

  test('a SQLite foreign-key failure is a readable 409 (a 4xx survives Cloudflare), with no table or column name', async () => {
    const res = await get('/fk');
    assert.equal(res.status, 409);
    assert.match(res.body.error, /no longer exists/);
    noLeak(res);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM cameras WHERE id = 'fk-cam'").get().n, 0, 'nothing was written');
  });

  test('any OTHER SQLite constraint failure is a 500, not a 4xx: only the foreign key is known to be the caller\'s doing', async () => {
    const res = await get('/not-null');
    assert.equal(res.status, 500);
    noLeak(res);
  });

  test('an error carrying a 4xx status/statusCode keeps that status; the message stays generic unless the error is marked expose', async () => {
    const a = await get('/status-418');
    assert.equal(a.status, 418);
    noLeak(a);
    const b = await get('/statusCode-422');
    assert.equal(b.status, 422);
    noLeak(b);
    const c = await get('/exposed-400');
    assert.equal(c.status, 400);
    assert.deepEqual(c.body, { error: 'Pick a smaller photo.' });
    assert.ok(logText().includes(`${MARKER} teapot`), 'a 4xx that was not client-safe is still logged');
  });

  test('a library error carrying 401 or 403 must NOT become a 401/403 (the UI would sign the user out); it is a 500', async () => {
    for (const p of ['/status-401', '/status-403']) {
      const res = await get(p);
      assert.equal(res.status, 500, p);
      noLeak(res);
    }
  });

  test('a 5xx status on the error is still a generic 500', async () => {
    const res = await get('/status-503');
    assert.equal(res.status, 500);
    noLeak(res);
  });

  test('body-parser errors keep their own status: malformed JSON is 400, an oversized body is 413, both JSON', async () => {
    const bad = await fetch(`${base}/echo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":' });
    assert.equal(bad.status, 400);
    assert.match(bad.headers.get('content-type'), /json/);
    assert.equal(typeof (await bad.json()).error, 'string');
    const big = await fetch(`${base}/echo`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ x: 'a'.repeat(200 * 1024) }),
    });
    assert.equal(big.status, 413);
    assert.equal(typeof (await big.json()).error, 'string');
  });

  test('the query string (it can carry a media token) never reaches the log', async () => {
    await get('/query-secret?token=SECRETTOKEN123');
    const line = logger.getRecent().filter((l) => l.includes('query-secret')).join('\n');
    assert.ok(line.includes('GET /query-secret'));
    assert.ok(!line.includes('SECRETTOKEN123'));
  });

  test('an error AFTER the reply was sent leaves the client\'s answer intact and is logged', async () => {
    const res = await get('/after-reply');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true });
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(logText().includes(`${MARKER} after the reply`));
  });

  test('an error mid-stream (headers sent, body unfinished) is delegated so the client sees a FAILED response, not a truncated "complete" one', async () => {
    const outcome = await new Promise((resolve) => {
      const req = http.get(`${base}/mid-stream`, (res) => {
        res.on('data', () => {});
        res.on('end', () => resolve(res.complete ? 'complete' : 'incomplete'));
        res.on('error', () => resolve('errored'));
        res.on('aborted', () => resolve('aborted'));
        res.on('close', () => resolve(res.complete ? 'complete' : 'incomplete'));
      });
      req.on('error', () => resolve('errored'));
      // Bounded: a handler that neither finishes nor closes the response would otherwise hang the whole file.
      setTimeout(() => { resolve('hung'); req.destroy(); }, 3000).unref();
    });
    assert.ok(['aborted', 'errored', 'incomplete'].includes(outcome), `the client must see a failure, got: ${outcome}`);
  });

  test('delegation, unit level: headers sent + still open -> next(err); headers sent + ended -> not delegated; nothing sent -> answered', () => {
    const err = new Error(MARKER);
    const req = { method: 'GET', originalUrl: '/x' };
    let delegated = null;
    errorHandler(err, req, { headersSent: true, writableEnded: false }, (e) => { delegated = e; });
    assert.equal(delegated, err);
    delegated = null;
    errorHandler(err, req, { headersSent: true, writableEnded: true }, (e) => { delegated = e; });
    assert.equal(delegated, null);
    let sent;
    const res = { headersSent: false, status(c) { sent = { c }; return this; }, json(b) { sent.b = b; return this; } };
    errorHandler(err, req, res, () => assert.fail('must not delegate'));
    assert.equal(sent.c, 500);
  });
});

// ---- 3. the three repros from the issue, against the REAL routers -----------------------------------------

describe('issue #544 repros against the real routers', () => {
  let cams; let pov;
  let adminToken;

  before(async () => {
    makeUser(db, { id: 'u-admin', username: 'admin', role: 'admin' });
    adminToken = signToken({ id: 'u-admin', username: 'admin', role: 'admin', sid: makeSession(db, 'u-admin') });
    cams = await mountRouter('/api/cameras', (await import('../src/routes/cameras.js')).default);
    pov = await mountRouter('/api/pushover', (await import('../src/routes/pushover.js')).default);
    makeChild(db, { id: 'kid-1' });
    makeCamera(db, { id: 'cam-1', name: 'Original', childId: 'kid-1' });
  });

  after(async () => {
    await cams.close();
    await pov.close();
  });

  const row = () => db.prepare("SELECT name, child_id FROM cameras WHERE id = 'cam-1'").get();

  // Each request is bounded: before the fix these never answered, and a test that waits forever would
  // time the whole file out instead of failing with a message.
  const callWithin = (url, opts) => Promise.race([
    call(url, opts),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`no response from ${opts.method} ${url} (the #544 hang)`)), 4000)),
  ]);

  test('PUT /api/cameras/:id with a child_id that no longer exists is a 400 (like /assign), and nothing is written', async () => {
    const res = await callWithin(`${cams.url}/api/cameras/cam-1`, { method: 'PUT', token: adminToken, body: { name: 'Renamed', child_id: 'deleted-in-another-tab' } });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: 'Child not found' });
    assert.deepEqual(row(), { name: 'Original', child_id: 'kid-1' });
  });

  test('PUT /:id with a non-string child_id is the same 400, not an exception', async () => {
    const res = await callWithin(`${cams.url}/api/cameras/cam-1`, { method: 'PUT', token: adminToken, body: { child_id: { id: 'kid-1' } } });
    assert.equal(res.status, 400);
    assert.deepEqual(row(), { name: 'Original', child_id: 'kid-1' });
  });

  test('what PUT /:id accepted before still works: an existing child, a rename, and null to unassign', async () => {
    let res = await callWithin(`${cams.url}/api/cameras/cam-1`, { method: 'PUT', token: adminToken, body: { name: 'Renamed' } });
    assert.equal(res.status, 200);
    assert.deepEqual(row(), { name: 'Renamed', child_id: 'kid-1' });
    res = await callWithin(`${cams.url}/api/cameras/cam-1`, { method: 'PUT', token: adminToken, body: { child_id: 'kid-1' } });
    assert.equal(res.status, 200);
    res = await callWithin(`${cams.url}/api/cameras/cam-1`, { method: 'PUT', token: adminToken, body: { child_id: null } });
    assert.equal(res.status, 200);
    assert.equal(row().child_id, null);
    db.prepare("UPDATE cameras SET name = 'Original', child_id = 'kid-1' WHERE id = 'cam-1'").run();
  });

  test('PUT /:id /assign still answers its own 400 for a missing child (unchanged by the shared helper)', async () => {
    const res = await callWithin(`${cams.url}/api/cameras/cam-1/assign`, { method: 'PUT', token: adminToken, body: { child_id: 'ghost' } });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: 'Child not found' });
  });

  test('POST /api/cameras with name: 5 is a 400, not a hang', async () => {
    const res = await callWithin(`${cams.url}/api/cameras`, { method: 'POST', token: adminToken, body: { name: 5, rtsp_host: '192.0.2.1', force: true } });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: 'Name is required' });
  });

  test('POST /api/cameras with a child that does not exist is a 400 and registers nothing', async () => {
    const before = db.prepare('SELECT COUNT(*) AS n FROM cameras').get().n;
    const res = await callWithin(`${cams.url}/api/cameras`, { method: 'POST', token: adminToken, body: { name: 'New', rtsp_host: '192.0.2.1', force: true, child_id: 'ghost' } });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: 'Child not found' });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cameras').get().n, before);
  });

  test('PUT /api/pushover/config with app_token: 5 is a 400, not a hang, and the saved config is untouched', async () => {
    db.prepare("UPDATE settings SET pushover_app_token = 'saved-token' WHERE id = 'app'").run();
    for (const body of [{ app_token: 5 }, { user_key: { a: 1 } }, { device: 7 }, { app_token: ['x'] }]) {
      const res = await callWithin(`${pov.url}/api/pushover/config`, { method: 'PUT', token: adminToken, body });
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.match(res.body.error, /must be text/);
    }
    assert.equal(db.prepare("SELECT pushover_app_token AS t FROM settings WHERE id = 'app'").get().t, 'saved-token');
  });

  test('pushover config values that WERE accepted still are: absent, null, false, 0 and blank all mean "keep the saved one"', async () => {
    for (const body of [{}, { app_token: null }, { app_token: false, user_key: 0 }, { app_token: '', user_key: '  ', device: '' }, { device: null }]) {
      const res = await callWithin(`${pov.url}/api/pushover/config`, { method: 'PUT', token: adminToken, body });
      assert.equal(res.status, 200, JSON.stringify(body));
    }
    assert.equal(db.prepare("SELECT pushover_app_token AS t FROM settings WHERE id = 'app'").get().t, 'saved-token');
  });

  test('a failure no validation anticipates (PUT /:id with talk_username: 5) is a generic 500 JSON, no internals, and the request is answered', async () => {
    const res = await callWithin(`${cams.url}/api/cameras/cam-1`, { method: 'PUT', token: adminToken, body: { talk_username: 5 } });
    assert.equal(res.status, 500);
    assert.deepEqual(Object.keys(res.body), ['error']);
    for (const needle of ['trim', 'TypeError', 'cameras.js', 'is not a function']) {
      assert.ok(!res.body.error.includes(needle), needle);
    }
    assert.ok(logText().includes('talk_username') || logText().includes('trim'), 'the real cause is in the log');
  });
});

// ---- 4. the class guard -----------------------------------------------------------------------------------

describe('class guard: no async route handler is registered unwrapped', () => {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const ROUTES_DIR = path.resolve(HERE, '..', 'src', 'routes');
  // express-rate-limit's middleware is itself an `async` function (the auth routes put limiters in front of
  // their handlers), but it wraps its own body in try/catch and calls next(error) (handleAsyncErrors in its
  // source, checked against the installed 8.x), so a rejection inside it is already answered. It is
  // recognised by the two methods the library attaches to every limiter it returns; both must be present.
  const answersItsOwnErrors = (fn) => typeof fn.resetKey === 'function' && typeof fn.getKey === 'function';
  const isAsync = (fn) => typeof fn === 'function' && fn.constructor?.name === 'AsyncFunction' && !answersItsOwnErrors(fn);

  // Every function Express has registered on a router, with a name for the failure message. Nested routers
  // are walked too (route-permissions.test.js refuses them, but this guard should not go quiet if one appears).
  function* functionsOf(router, label) {
    for (const layer of router.stack) {
      if (layer.route) {
        const where = `${Object.keys(layer.route.methods).join('/').toUpperCase()} ${layer.route.path}`;
        for (const l of layer.route.stack) yield { where: `${label} ${where}`, fn: l.handle };
      } else if (layer.handle?.stack) {
        yield* functionsOf(layer.handle, `${label} (nested)`);
      } else {
        yield { where: `${label} router.use`, fn: layer.handle };
      }
    }
  }

  async function allRouters() {
    const files = fs.readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.js')).sort();
    const out = [];
    for (const f of files) {
      const mod = await import(pathToFileURL(path.join(ROUTES_DIR, f)).href);
      assert.ok(Array.isArray(mod.default?.stack), `${f}: default export is not an Express router; teach this guard before skipping it`);
      out.push([f, mod.default]);
    }
    return out;
  }

  test('every async function Express would run is wrapped by asyncHandler', async () => {
    const bare = [];
    let wrapped = 0;
    for (const [file, router] of await allRouters()) {
      for (const { where, fn } of functionsOf(router, file)) {
        if (fn[WRAPPED]) wrapped++;
        else if (isAsync(fn)) bare.push(where);
      }
    }
    assert.deepEqual(bare, [], 'wrap these in asyncHandler(...) (lib/asyncHandler.js), or a rejection leaves the request without a response');
    // Not "exactly N": a new wrapped route must not need this file edited. But the guard must have SEEN
    // routes, or a change to how routers are enumerated could make it pass over nothing.
    assert.ok(wrapped >= 22, `expected to find at least the 22 wrapped handlers of #544, found ${wrapped}`);
  });

  test('the guard recognises a bare async handler (so a clean result above means something)', () => {
    const router = express.Router();
    router.get('/oops', async () => {});
    router.get('/fine', asyncHandler(async () => {}));
    router.use(async () => {});
    router.get('/limited', rateLimit({ limit: 5, validate: false }), asyncHandler(async () => {}));
    const found = [...functionsOf(router, 'fixture')].filter(({ fn }) => !fn[WRAPPED] && isAsync(fn)).map((x) => x.where);
    // The real limiter is async and is correctly NOT reported; a look-alike with only one of its two methods is.
    assert.deepEqual(found, ['fixture GET /oops', 'fixture router.use']);
    const impostor = Object.assign(async () => {}, { resetKey() {} });
    assert.equal(isAsync(impostor), true);
  });
});
