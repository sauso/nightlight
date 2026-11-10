// What the Express 4 -> 5 move (Dependabot #729) changed that the app has to answer for, pinned at the installed
// version. Each block says which Express 4 behaviour it stands for. index.js cannot be imported (it spawns
// MediaMTX and FFmpeg), so the pieces that live in it are tested through the small modules they were moved into
// (lib/listenOrFail.js, middleware/defaultBody.js) or, for the catch-all route, through a copy of its handler.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import express from 'express';
import { listenOrFail } from '../src/lib/listenOrFail.js';
import { defaultBody } from '../src/middleware/defaultBody.js';

const request = (port, { method = 'GET', path = '/', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
    let text = '';
    res.on('data', (c) => { text += c; });
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
  });
  req.on('error', reject);
  if (body !== undefined) req.write(body);
  req.end();
});
const listen = (app) => new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
const close = (s) => new Promise((r) => s.close(r));

describe('listenOrFail: a port that cannot be bound is a failure, not a quiet "listening"', () => {
  // A short timeout on each: if the fix is lost, a promise that waits for one callback would otherwise wait forever
  // and hang CI instead of failing it (found by review: both callbacks resolve it here, and the assertions tell them apart).
  test('★ the port is taken: onListening is NOT called and the error reaches fail (Express 5 hands it to the callback; Express 4 threw)', { timeout: 10000 }, async () => {
    const blocker = net.createServer();
    await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
    const { port } = blocker.address();
    const calls = { listening: 0, errors: [] };
    // Bind the SAME address the blocker holds, so the OS refuses with EADDRINUSE.
    const app = { listen: (p, cb) => express().listen(p, '127.0.0.1', cb) };
    let heard;
    const settled = new Promise((resolve) => { heard = resolve; });
    listenOrFail(app, port, () => { calls.listening += 1; heard(); }, (err) => { calls.errors.push(err); heard(); });
    await settled;
    await close(blocker);
    assert.equal(calls.listening, 0, 'onListening ran although nothing is listening');
    assert.equal(calls.errors.length, 1);
    assert.equal(calls.errors[0].code, 'EADDRINUSE');
  });

  test('the default fail rethrows, which is what the boot guard turns into exit code 1', () => {
    const boom = Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' });
    const fakeApp = { listen: (p, cb) => { cb(boom); return null; } };
    assert.throws(() => listenOrFail(fakeApp, 1, () => assert.fail('must not report listening')), (e) => e === boom);
  });

  test('a free port: onListening runs once, fail never, and the server is returned', { timeout: 10000 }, async () => {
    let listening = 0;
    let failed = 0;
    let server;
    await new Promise((resolve) => {
      server = listenOrFail({ listen: (p, cb) => express().listen(0, '127.0.0.1', cb) }, 0, () => { listening += 1; resolve(); }, () => { failed += 1; resolve(); });
    });
    try {
      assert.equal(listening, 1);
      assert.equal(failed, 0);
      assert.equal(typeof server.address().port, 'number');
    } finally { await close(server); }
  });

  test('after a successful bind Express 5\'s spent once(\'error\') listener is gone, so a later server error is not swallowed', { timeout: 10000 }, async () => {
    // Express 5 leaves app.listen's once('error', callback) on the server after it has bound; the first later error
    // would reach that spent callback and vanish (Express 4: uncaught, which the guard logs).
    let server;
    await new Promise((resolve) => {
      server = listenOrFail({ listen: (p, cb) => express().listen(0, '127.0.0.1', cb) }, 0, resolve, resolve);
    });
    try {
      assert.equal(server.listenerCount('error'), 0);
      // An error event with no listener throws, as on Express 4 (and as processGuards expects to see it).
      assert.throws(() => server.emit('error', new Error('later server error')), /later server error/);
    } finally { await close(server); }
  });
});

describe('defaultBody: req.body is an object whatever was sent (Express 4 gave {}; Express 5 leaves undefined)', () => {
  const seen = [];
  const mount = (withShim) => {
    const app = express();
    app.use(express.json());
    if (withShim) app.use(defaultBody);
    app.all('/echo', (req, res) => { seen.push(req.body); res.json({ type: typeof req.body, keys: Object.keys(req.body ?? {}) }); });
    return app;
  };

  test('control: without it Express 5 leaves req.body undefined for a request with no body (why the module exists)', async () => {
    const s = await listen(mount(false));
    try {
      const r = await request(s.address().port, { method: 'POST', path: '/echo' }).catch((e) => e);
      assert.ok(r.status === 200, String(r.message || r.status));
      assert.equal(JSON.parse(r.text).type, 'undefined');
    } finally { await close(s); }
  });

  test('with it: no body, a text body and a body of a type nobody parses all read as {}', async () => {
    const s = await listen(mount(true));
    try {
      const port = s.address().port;
      const none = await request(port, { method: 'POST', path: '/echo' });
      const text = await request(port, { method: 'POST', path: '/echo', headers: { 'content-type': 'text/plain', 'content-length': 2 }, body: 'hi' });
      const form = await request(port, { method: 'POST', path: '/echo', headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': 3 }, body: 'a=1' });
      for (const r of [none, text, form]) assert.deepEqual(JSON.parse(r.text), { type: 'object', keys: [] });
    } finally { await close(s); }
  });

  test('a JSON body is left exactly as parsed', async () => {
    const s = await listen(mount(true));
    try {
      const body = JSON.stringify({ enabled: true });
      const r = await request(s.address().port, { method: 'POST', path: '/echo', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }, body });
      assert.deepEqual(JSON.parse(r.text), { type: 'object', keys: ['enabled'] });
    } finally { await close(s); }
  });
});

// A COPY of index.js's catch-all (index.js cannot be imported). Express 5 refuses a bare `*`; the named wildcard
// must still answer `/` and deep paths with the web app and still keep /api/* as a JSON 404. The page is served
// with res.sendFile exactly as index.js does, from a folder under a DOT-FOLDER: send 1.x refuses a file whose
// absolute path has any dot-folder in it unless `root` is given (a deep link was a 404 for a checkout under
// `.claude/worktrees/` or `~/.local/` before index.js passed `root`).
describe('the SPA catch-all pattern /{*splat}', () => {
  test('/ and deep paths reach the page, from under a dot-folder; /api/* is a JSON 404', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-spa-'));
    const publicDir = path.join(base, '.dot', 'public');
    fs.mkdirSync(publicDir, { recursive: true });
    fs.writeFileSync(path.join(publicDir, 'index.html'), '<spa>');
    const app = express();
    app.get('/{*splat}', (req, res) => {
      if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
      res.sendFile('index.html', { root: publicDir });
    });
    const s = await listen(app);
    try {
      const port = s.address().port;
      for (const p of ['/', '/settings/foo', '/a.b', '/children/c-1/sleep/2026-01-01']) {
        const r = await request(port, { path: p });
        assert.equal(r.text, '<spa>', p);
      }
      const head = await request(port, { method: 'HEAD', path: '/settings' });
      assert.equal(head.status, 200);
      const api = await request(port, { path: '/api/nope' });
      assert.equal(api.status, 404);
      assert.deepEqual(JSON.parse(api.text), { error: 'Not found' });
    } finally { await close(s); fs.rmSync(base, { recursive: true, force: true }); }
  });

  test('control: without `root`, the same file under a dot-folder is refused (why index.js passes it)', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-spa-'));
    const publicDir = path.join(base, '.dot', 'public');
    fs.mkdirSync(publicDir, { recursive: true });
    fs.writeFileSync(path.join(publicDir, 'index.html'), '<spa>');
    const app = express();
    app.get('/{*splat}', (req, res) => res.sendFile(path.join(publicDir, 'index.html'), (err) => { if (err) res.status(err.status || 500).end(); }));
    const s = await listen(app);
    try {
      const r = await request(s.address().port, { path: '/settings' });
      assert.equal(r.status, 404);
    } finally { await close(s); fs.rmSync(base, { recursive: true, force: true }); }
  });

  test('the old bare `*` is refused by Express 5 (so it cannot silently come back)', () => {
    assert.throws(() => express().get('*', () => {}), /Missing parameter name|path-to-regexp|Unexpected/i);
  });
});

describe('query strings: Express 5 parses them flat ("simple")', () => {
  test('a bracketed key stays one literal key, so `hours[]=2` is not the number the routes look for', async () => {
    // Express 4 (qs) turned ?hours[]=2 into { hours: ['2'] }; Express 5 gives { 'hours[]': '2' }. Every route reads
    // plain keys (req.query.hours), so a bracketed spelling now falls back to the default instead of being read as an
    // array: nothing the app sends does that.
    const app = express();
    app.get('/q', (req, res) => res.json({ q: Object.fromEntries(Object.entries(req.query)) }));
    const s = await listen(app);
    try {
      const r = await request(s.address().port, { path: '/q?hours[]=2&hours2=5&token=a&token=b' });
      assert.deepEqual(JSON.parse(r.text).q, { 'hours[]': '2', hours2: '5', token: ['a', 'b'] });
    } finally { await close(s); }
  });
});
