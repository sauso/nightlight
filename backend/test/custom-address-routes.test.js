import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, signToken, call } from './helpers/harness.js';

useTempDataDir();
const { default: db } = await import('../src/db.js');
const { createTailscaleRouter } = await import('../src/routes/tailscale.js');
const { createRemoteAccessRouter } = await import('../src/routes/remoteAccess.js');
let server, base, caregiverToken;
const env = { CUSTOM_URL: '' };
before(() => {
  const caregiver = makeUser(db, { id: 'custom-caregiver', username: 'custom-caregiver', role: 'caregiver' });
  caregiverToken = signToken({ id: caregiver.id, sid: makeSession(db, caregiver.id), role: 'caregiver' });
});
afterEach(async () => {
  env.CUSTOM_URL = '';
  db.prepare("UPDATE settings SET tailscale_enabled = 0 WHERE id = 'app'").run();
  if (server) await new Promise((resolve) => server.close(resolve));
  server = null;
});
after(() => { db.close(); cleanupTempDataDirs(); });

async function mount({ state = 'Running', served = true } = {}) {
  const seen = { status: 0, serve: 0 };
  const tailscale = createTailscaleRouter({ database: db, detector: () => ({ host: false, evidence: [], unknown: null }),
    status: () => ({ state: 'running' }), cli: async (verb) => {
      if (verb === 'status-peerless') {
        seen.status++;
        return { ok: true, json: { BackendState: state, Self: { DNSName: 'name.example.ts.net.' } } };
      }
      seen.serve++;
      return { ok: true, json: { Web: served ? { 'name.example.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:4000' } } } } : {} } };
    } });
  const app = express();
  app.use('/api/remote-access/tailscale', tailscale);
  app.use('/api/remote-access', createRemoteAccessRouter({ env, resolveAddress: tailscale.resolveAddress }));
  server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}/api/remote-access`;
  return seen;
}
const ask = (path = '/address', token = caregiverToken) => call(base + path, { token });

test('custom wins while Tailscale is off or uncertain, and old endpoint stays unchanged', async () => {
  await mount({ state: 'NeedsLogin' });
  env.CUSTOM_URL = 'HTTPS://Example.COM:8443/';
  assert.deepEqual((await ask()).body, { url: 'https://example.com:8443', kind: 'custom' });
  assert.deepEqual((await ask('/tailscale/address')).body, { url: null });
  assert.equal((await ask('/address', null)).status, 401);
  db.prepare("UPDATE settings SET tailscale_enabled = 1 WHERE id = 'app'").run();
  assert.deepEqual((await ask()).body, { url: 'https://example.com:8443', kind: 'custom' });
  const old = await ask('/tailscale/address');
  assert.equal(old.status, 409);
  assert.deepEqual(old.body, { error: 'The Tailscale address is not known right now.', code: 'status_unavailable' });
});

test('without custom, both routes share one daemon read and preserve null and 409', async () => {
  db.prepare("UPDATE settings SET tailscale_enabled = 1 WHERE id = 'app'").run();
  let seen = await mount();
  const answers = await Promise.all(Array.from({ length: 30 }, (_, i) => ask(i % 2 ? '/address' : '/tailscale/address')));
  assert.ok(answers.every((answer, i) => answer.status === 200 &&
    (i % 2 ? answer.body.kind === 'tailscale' : Object.keys(answer.body).length === 1)));
  assert.deepEqual(seen, { status: 1, serve: 1 });
  env.CUSTOM_URL = 'https://custom.example';
  assert.deepEqual((await ask()).body, { url: 'https://custom.example', kind: 'custom' });
  assert.deepEqual((await ask('/tailscale/address')).body, { url: 'https://name.example.ts.net' });
  env.CUSTOM_URL = '';
  db.prepare("UPDATE settings SET tailscale_enabled = 0 WHERE id = 'app'").run();
  assert.deepEqual((await ask()).body, { url: null, kind: null });
  await new Promise((resolve) => server.close(resolve)); server = null;
  db.prepare("UPDATE settings SET tailscale_enabled = 1 WHERE id = 'app'").run();
  await mount({ served: false });
  assert.deepEqual((await ask()).body, { url: null, kind: null });
  await new Promise((resolve) => server.close(resolve)); server = null;
  await mount({ state: 'NeedsLogin' });
  assert.equal((await ask()).status, 409);
  env.CUSTOM_URL = 'https://custom.example';
  assert.deepEqual((await ask()).body, { url: 'https://custom.example', kind: 'custom' });
});
