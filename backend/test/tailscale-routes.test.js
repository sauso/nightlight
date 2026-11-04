import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, signToken, mountRouter, call } from './helpers/harness.js';

const dataDir = useTempDataDir();
const { default: db } = await import('../src/db.js');
const { createTailscaleRouter } = await import('../src/routes/tailscale.js');
const { default: settingsRouter } = await import('../src/routes/settings.js');
const { tailnetEnableBlocker } = await import('../src/lib/tailnetPreconditions.js');
const { startTailscale, stopTailscale, getTailscaleStatus } = await import('../src/lib/tailscaleProcess.js');
const { verifyToken } = await import('../src/middleware/auth.js');
const { isLoopbackExposed } = await import('../src/lib/loopbackExposure.js');
const { spawnAsApp } = await import('../src/lib/childEnv.js');
const FAKE = fileURLToPath(new URL('./helpers/fakeTailscaled.js', import.meta.url));
const safe = { host: false, evidence: [], unknown: null };
const roots = [];
const children = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn) {
  for (let i = 0; i < 200; i++) { if (fn()) return; await sleep(10); }
  assert.fail('timed out waiting for daemon');
}
function fixture(mode = 'stay', extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-967-route-'));
  roots.push(root);
  const markerDir = path.join(root, 'markers');
  fs.mkdirSync(markerDir);
  const uid = process.getuid?.() || 1500;
  const fsImpl = { ...fs, lstatSync: (p) => {
    const st = fs.lstatSync(p);
    return Object.assign(st, { uid, mode: process.platform === 'win32'
      ? (st.mode & ~0o777) | (st.isDirectory() ? 0o700 : 0o600) : st.mode });
  } };
  let spawns = 0;
  const start = ({ db: database, dataDir: dir }) => startTailscale({ db: database, dataDir: dir,
    hostNetwork: safe, binaryPath: process.execPath, binary: process.execPath,
    stateOptions: { uid, fsImpl }, runtimeOptions: { uid, fsImpl },
    argvSuffix: [`--marker-dir=${markerDir}`, `--mode=${mode}`],
    spawnFn: (_binary, argv, options) => {
      spawns++;
      const child = spawnAsApp(process.execPath, [FAKE, ...argv], options);
      children.push(child);
      return child;
    }, forceKillMs: 40, stopCapMs: 150, exposureHoldMs: 20, ...extra });
  const blocker = (database, { hostNetwork }) => tailnetEnableBlocker(database, { hostNetwork, binaryPath: process.execPath });
  return { root, start, blocker, get spawns() { return spawns; } };
}
let server, settings, adminToken, caregiverToken;
const route = () => `${server.url}/api/remote-access/tailscale`;
const put = (enabled, token = adminToken) => call(route(), { method: 'PUT', token, body: { enabled } });
before(async () => {
  const admin = makeUser(db);
  const caregiver = makeUser(db, { id: 'caregiver', username: 'caregiver', role: 'caregiver' });
  adminToken = signToken({ id: admin.id, sid: makeSession(db, admin.id), role: 'admin' });
  caregiverToken = signToken({ id: caregiver.id, sid: makeSession(db, caregiver.id), role: 'caregiver' });
});
afterEach(async () => {
  for (const child of children.splice(0)) {
    try { if (child.pid && child.exitCode === null) process.kill(child.pid, 'SIGKILL'); } catch { /* exited */ }
  }
  await Promise.race([stopTailscale(), sleep(500)]);
  db.prepare("UPDATE settings SET tailscale_enabled = 0 WHERE id = 'app'").run();
  await server?.close(); server = null;
  await settings?.close(); settings = null;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
after(() => { db.close(); cleanupTempDataDirs(); });
async function mount(options = {}) {
  server = await mountRouter('/api/remote-access/tailscale', createTailscaleRouter({ database: db, dataDir, detector: () => safe, ...options }));
}

test('#967 admin routes, strict body and fixed response shape', async () => {
  const f = fixture(); await mount({ start: f.start, blocker: f.blocker });
  for (const method of ['GET', 'PUT']) {
    assert.equal((await call(route(), { method, body: method === 'PUT' ? { enabled: true } : undefined })).status, 401);
    assert.equal((await call(route(), { method, token: caregiverToken, body: method === 'PUT' ? { enabled: true } : undefined })).status, 403);
  }
  for (const body of [{}, { enabled: 'true' }, { enabled: true, extra: 1 }, []]) {
    assert.equal((await call(route(), { method: 'PUT', token: adminToken, body })).status, 400);
  }
  assert.equal(f.spawns, 0);
  const got = await call(route(), { token: adminToken });
  assert.equal(got.status, 200);
  assert.deepEqual(Object.keys(got.body).sort(), ['blocker', 'enabled', 'host_network', 'process']);
  assert.doesNotMatch(JSON.stringify(got.body), /private\/|pid-|tskey-|@example/);
});

test('#967 blockers refuse without spawn or persistence', async () => {
  const f = fixture();
  for (const code of ['no_admin', 'host_network', 'not_installed']) {
    await mount({ start: f.start, blocker: () => ({ code, message: 'The tunnel daemon cannot start.' }) });
    const got = await put(true);
    assert.equal(got.status, 409); assert.equal(got.body.code, code);
    assert.equal(f.spawns, 0);
    assert.equal(db.prepare("SELECT tailscale_enabled FROM settings WHERE id = 'app'").get().tailscale_enabled, 0);
    await server.close(); server = null;
  }
});

test('#967 enable is idempotent and disable clears intent before stopping', async () => {
  const f = fixture(); await mount({ start: f.start, blocker: f.blocker });
  const [a, b] = await Promise.all([put(true), put(true)]);
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  assert.equal(f.spawns, 1);
  assert.equal((await call(route(), { token: adminToken })).body.enabled, true);
  assert.equal((await put(false)).status, 200);
  assert.equal(getTailscaleStatus().state, 'off');
  await sleep(35);
  assert.equal(isLoopbackExposed(), false);
  assert.equal((await put(false)).status, 200);
  assert.equal(db.prepare("SELECT tailscale_enabled FROM settings WHERE id = 'app'").get().tailscale_enabled, 0);
});

test('#967 failed save compensates by stopping; a later job still works', async () => {
  const f = fixture(); let fail = true;
  await mount({ start: f.start, blocker: f.blocker, write: (v) => {
    if (fail) { fail = false; throw Error('private path and secret'); }
    db.prepare("UPDATE settings SET tailscale_enabled = ? WHERE id = 'app'").run(v);
  } });
  const first = await put(true);
  assert.equal(first.status, 409); assert.equal(first.body.code, 'could_not_save');
  assert.doesNotMatch(JSON.stringify(first.body), /private path|secret/);
  assert.equal(getTailscaleStatus().state, 'off');
  assert.equal((await put(true)).status, 200);
});

test('#967 unavailable start does not persist intent', async () => {
  await mount({ blocker: () => null, start: ({ db: database, dataDir: dir }) => startTailscale({ db: database, dataDir: dir,
    hostNetwork: safe, binaryPath: process.execPath, stateOptions: { uid: 0 } }) });
  const got = await put(true);
  assert.equal(got.status, 409);
  assert.equal(db.prepare("SELECT tailscale_enabled FROM settings WHERE id = 'app'").get().tailscale_enabled, 0);
});

test('#967 intent is saved after a started state, and enable while running is idempotent', async () => {
  let state = 'off'; let atStart;
  await mount({ blocker: () => null, start: () => {
    atStart = db.prepare("SELECT tailscale_enabled FROM settings WHERE id = 'app'").get().tailscale_enabled;
    state = 'running';
  }, status: () => ({ state, restarts: 0, lastExitCode: null, reason: null }),
  stop: async () => { state = 'off'; } });
  assert.equal((await put(true)).status, 200);
  assert.equal(atStart, 0);
  assert.equal((await put(true)).status, 200);
  assert.equal((await put(false)).status, 200);
});

test('#967 wedged stop reports busy and uncertain disable reports 409', async () => {
  let state = 'stopping';
  await mount({ blocker: () => null, start: () => false, stop: async () => {},
    status: () => ({ state, restarts: 0, lastExitCode: null, reason: null }) });
  assert.equal((await put(true)).body.code, 'busy');
  const disabled = await put(false);
  assert.equal(disabled.status, 409);
  assert.equal(disabled.body.code, 'stop_uncertain');
  assert.equal(disabled.body.enabled, false);
});

test('#967 lock serialises disable then enable without awaiting between requests', async () => {
  let state = 'running'; let release;
  let stopping = new Promise((resolve) => { release = resolve; });
  await mount({ blocker: () => null,
    start: () => { if (state === 'stopping') return false; state = 'running'; return true; },
    stop: async () => { state = 'stopping'; await stopping; state = 'off'; },
    status: () => ({ state, restarts: 0, lastExitCode: null, reason: null }) });
  const disabling = put(false);
  await until(() => state === 'stopping');
  const enabling = put(true);
  release();
  assert.equal((await disabling).status, 200);
  assert.equal((await enabling).status, 200);
  assert.equal(db.prepare("SELECT tailscale_enabled FROM settings WHERE id = 'app'").get().tailscale_enabled, 1);
});

test('#967 SIGTERM-ignoring fake serialises disable then enable', {
  skip: process.platform === 'win32' && 'POSIX SIGTERM and SIGKILL are required; Linux CI runs this',
}, async () => {
  const f = fixture('ignore-sigterm', { stopCapMs: 500 });
  await mount({ start: f.start, blocker: f.blocker });
  assert.equal((await put(true)).status, 200);
  await until(() => fs.readdirSync(path.join(f.root, 'markers')).some((n) => n.startsWith('ready-')));
  const disabling = put(false);
  await until(() => getTailscaleStatus().state === 'stopping');
  const enabling = put(true);
  assert.equal((await disabling).status, 200);
  assert.equal((await enabling).status, 200);
  assert.equal(f.spawns, 2);
  assert.equal(db.prepare("SELECT tailscale_enabled FROM settings WHERE id = 'app'").get().tailscale_enabled, 1);
});

test('#967 SIGTERM-ignoring fake with failed SIGKILL reports stop_uncertain', {
  skip: process.platform === 'win32' && 'POSIX SIGTERM and SIGKILL are required; Linux CI runs this',
}, async () => {
  const f = fixture('ignore-sigterm', { stopCapMs: 100, killFn: (child, signal) =>
    signal === 'SIGKILL' ? false : child.kill(signal) });
  await mount({ start: f.start, blocker: f.blocker });
  assert.equal((await put(true)).status, 200);
  await until(() => fs.readdirSync(path.join(f.root, 'markers')).some((n) => n.startsWith('ready-')));
  const got = await put(false);
  assert.equal(got.status, 409);
  assert.equal(got.body.code, 'stop_uncertain');
  assert.equal(got.body.enabled, false);
  assert.equal(isLoopbackExposed(), true);
});

test('#967 rejected job is followed by a valid PUT', async () => {
  let fail = true; let state = 'off';
  await mount({ blocker: () => null, start: () => { state = 'running'; },
    verify: (token) => { if (fail) { fail = false; throw Error('private details'); }
      return verifyToken(token); },
    status: () => ({ state, restarts: 0, lastExitCode: null, reason: null }) });
  const first = await put(true);
  assert.equal(first.status, 409);
  assert.doesNotMatch(JSON.stringify(first.body), /private details/);
  assert.equal((await put(true)).status, 200);
});

test('#967 queued admin revocation is checked when the job begins', {
  skip: process.platform === 'win32' && 'POSIX signal handling is required; Linux CI runs this',
}, async () => {
  const f = fixture('ignore-sigterm', { stopCapMs: 500 });
  await mount({ start: f.start, blocker: f.blocker });
  assert.equal((await put(true)).status, 200);
  await until(() => fs.readdirSync(path.join(f.root, 'markers')).some((n) => n.startsWith('ready-')));
  const sid = makeSession(db, 'u-admin');
  const token = signToken({ id: 'u-admin', sid, role: 'admin' });
  const disabling = put(false);
  await until(() => getTailscaleStatus().state === 'stopping');
  const queued = put(true, token);
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sid);
  await disabling;
  assert.equal((await queued).status, 401);
});

test('#967 schema flag is hidden from settings GET and ignored by settings PUT', async () => {
  settings = await mountRouter('/api/settings', settingsRouter);
  const cols = db.prepare('PRAGMA table_info(settings)').all();
  assert.equal(cols.find((c) => c.name === 'tailscale_enabled')?.dflt_value, '0');
  for (const token of [undefined, adminToken]) {
    const got = await call(`${settings.url}/api/settings`, { token });
    assert.equal(got.status, 200);
    assert.equal(Object.hasOwn(got.body, 'tailscale_enabled'), false);
  }
  await call(`${settings.url}/api/settings`, { method: 'PUT', token: adminToken, body: { tailscale_enabled: 1 } });
  assert.equal(db.prepare("SELECT tailscale_enabled FROM settings WHERE id = 'app'").get().tailscale_enabled, 0);
});
