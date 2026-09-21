// The diagnostics route's fail-closed backstop (remediation step 2 of GHSA-wcgj-6p3c-vr9h, the same
// pattern already proven on the camera-report route in routes/cameras.js): even though every field in
// the bundle is meant to be secret-free by construction, findCredentialLeak() checks the SERIALISED
// output before it's sent, and refuses to send anything that still looks like it contains a
// credential.
//
// ⚠️ Deliberately does NOT mock urlCredentials.js to force this — that file is in test:core's
// --test-coverage-include list, and node:test's mock.module() on a coverage-included file corrupts
// --experimental-test-coverage attribution for the WHOLE SUITE, even after an immediate restore (hit
// this for real while writing this file: the very first draft did exactly that and urlCredentials.js's
// reported coverage collapsed to ~10% for the whole `npm run test:core` run). Real findCredentialLeak,
// real redaction — only the DATA is rigged: a raw camera_events row (an existing, legitimate history
// table) planted directly with an unredacted `//user:pass@`-shaped detail string, simulating a future
// producer that writes into a bundle field without going through this app's own redaction. That's
// exactly the scenario this backstop exists for — a field this route doesn't yet control.
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, signToken, mountRouter, call } from './helpers/harness.js';

useTempDataDir();

const { default: db } = await import('../src/db.js');
const { default: diagnosticsRouter } = await import('../src/routes/diagnostics.js');

let server;
let adminToken;

before(async () => {
  const admin = makeUser(db, { id: 'diag-gate-admin', username: 'admin', role: 'admin' });
  adminToken = signToken({
    id: admin.id,
    username: admin.username,
    role: admin.role,
    sid: makeSession(db, admin.id),
  });
  server = await mountRouter('/api/diagnostics', diagnosticsRouter);
});

beforeEach(() => {
  db.prepare('DELETE FROM camera_events').run();
});

after(async () => {
  await server?.close();
  db.close();
  cleanupTempDataDirs();
});

test('★ THE FIX: a bundle findCredentialLeak flags is refused, not sent', async () => {
  db.prepare('INSERT INTO camera_events (camera_id, camera_name, type, detail) VALUES (?, ?, ?, ?)').run(
    'gate-cam', 'Gate Camera', 'restart',
    'reconnected to rtsp://admin:LEAK_GATE_SECRET@camera.local/live after a stall'
  );
  const res = await call(`${server.url}/api/diagnostics`, { token: adminToken });
  assert.equal(res.status, 500, JSON.stringify(res.body));
  assert.ok(!('cameras' in res.body), 'the flagged bundle body was sent anyway');
  assert.ok(!('server_logs' in res.body), 'the flagged bundle body was sent anyway');
});

test('a clean bundle (no camera_events row leaks anything) is sent normally — the control', async () => {
  db.prepare('INSERT INTO camera_events (camera_id, camera_name, type, detail) VALUES (?, ?, ?, ?)').run(
    'gate-cam', 'Gate Camera', 'restart', 'force-restarted by watchdog (unready 30s+)'
  );
  const res = await call(`${server.url}/api/diagnostics`, { token: adminToken });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok('cameras' in res.body);
});
