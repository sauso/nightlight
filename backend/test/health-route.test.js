// #937: GET /api/health over real HTTP, through the REAL handler index.js mounts (lib/serverIdentity.js exports it
// for this). index.js cannot be imported by a test (it starts MediaMTX and the rest), so this mounts the exported
// function on a bare app, and route-permissions.test.js pins that index.js registers exactly that function, with no
// gate in front of it. Together they fail if the route goes back to `{ ok: true }`; a test of healthBody() alone
// would not.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupTempDataDirs, mountRouter, call } from './helpers/harness.js';

useTempDataDir();

const { default: db } = await import('../src/db.js');
const { healthHandler } = await import('../src/lib/serverIdentity.js');
const { default: express } = await import('express');

let server;
before(async () => {
  const router = express.Router();
  router.get('/', healthHandler);
  server = await mountRouter('/api/health', router);
});
after(async () => {
  await server?.close();
  db.close();
  cleanupTempDataDirs();
});

test('★ unauthenticated 200 with ok, app, this server\'s id and its name', async () => {
  const { server_id: id, app_name: name } = db.prepare("SELECT server_id, app_name FROM settings WHERE id = 'app'").get();
  assert.ok(id, 'precondition: db.js made an id');
  const r = await call(`${server.url}/api/health`); // no token
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, app: 'nightlight', id, name });
});

test('an old client that only looks for "ok" still passes (the phone apps check the body contains "ok")', async () => {
  const res = await fetch(`${server.url}/api/health`);
  assert.equal(res.status, 200);
  assert.ok((await res.text()).includes('"ok"'));
});

test('★ a settings table the handler cannot read still answers 200 { ok: true }', async () => {
  // A real failure of the real read, not an injected one: the column the handler selects is renamed away.
  db.exec('ALTER TABLE settings RENAME COLUMN server_id TO server_id_moved');
  try {
    const r = await call(`${server.url}/api/health`);
    assert.equal(r.status, 200, 'a broken identity read turned the liveness probe into a failure');
    assert.deepEqual(r.body, { ok: true });
  } finally {
    db.exec('ALTER TABLE settings RENAME COLUMN server_id_moved TO server_id');
  }
});
