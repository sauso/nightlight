// The diagnostics bundle is intended for public issue attachments. URL query strings are opaque
// camera-controlled data, so they must not survive merely because userinfo redaction succeeded.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, makeCamera, signToken, mountRouter, call,
} from './helpers/harness.js';

useTempDataDir();

const { default: db } = await import('../src/db.js');
const { default: diagnosticsRouter } = await import('../src/routes/diagnostics.js');

const SECRET = 'QUERY_TOKEN_SECRET_7a4d';
let server;
let adminToken;

before(async () => {
  const admin = makeUser(db, { id: 'diag-admin', username: 'admin', role: 'admin' });
  adminToken = signToken({
    id: admin.id,
    username: admin.username,
    role: admin.role,
    sid: makeSession(db, admin.id),
  });
  makeCamera(db, { id: 'query-cam', name: 'Query camera', path: 'query-cam' });
  db.prepare(
    'UPDATE cameras SET disabled = 1, rtsp_url = ?, sub_rtsp_url = ? WHERE id = ?'
  ).run(
    `rtsp://viewer:password@cam.local/live?channel=1&token=${SECRET}#${SECRET}`,
    `rtsp://cam.local/sub?session=${SECRET}`,
    'query-cam'
  );
  server = await mountRouter('/api/diagnostics', diagnosticsRouter);
});

after(async () => {
  await server?.close();
  db.close();
  cleanupTempDataDirs();
});

test('diagnostics publishes URL pathnames but no camera query values or fragments', async () => {
  const res = await call(`${server.url}/api/diagnostics`, { token: adminToken });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const camera = res.body.cameras.find((item) => item.id === 'query-cam');
  assert.equal(camera.rtsp_path, '/live');
  assert.equal(camera.sub_rtsp_path, '/sub');
  assert.equal(camera.rtsp_username, 'viewer');
  assert.equal(camera.rtsp_has_password, true);
  assert.ok(!JSON.stringify(res.body).includes(SECRET), 'query credential reached the exported bundle');
});
