import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, signToken, mountRouter, call } from './helpers/harness.js';

const dataDir = useTempDataDir();
const { default: db } = await import('../src/db.js');
const { createTailscaleRouter } = await import('../src/routes/tailscale.js');
const { default: settingsRouter } = await import('../src/routes/settings.js');
const { tailnetEnableBlocker } = await import('../src/lib/tailnetPreconditions.js');
const { startTailscale, stopTailscale, getTailscaleStatus } = await import('../src/lib/tailscaleProcess.js');
const { detectHostNetwork } = await import('../src/lib/hostNetwork.js');
const { onlyListenerPorts } = await import('./helpers/procTcpFilter.js');
const { verifyToken } = await import('../src/middleware/auth.js');
const { isLoopbackExposed } = await import('../src/lib/loopbackExposure.js');
const { spawnAsApp } = await import('../src/lib/childEnv.js');
const { runTailscaleCli, getTailscaleLinks } = await import('../src/lib/tailscaleCli.js');
const { setTailnetAddress, getTailnetAddress } = await import('../src/lib/tailnetAddress.js');
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
  db.prepare("UPDATE settings SET tailscale_hostname = 'nightlight' WHERE id = 'app'").run();
  setTailnetAddress(null);
  await server?.close(); server = null;
  await settings?.close(); settings = null;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
after(() => { db.close(); cleanupTempDataDirs(); });
async function mount(options = {}) {
  server = await mountRouter('/api/remote-access/tailscale', createTailscaleRouter({ database: db, dataDir, detector: () => safe, ...options }));
}

// Linux-only: the default detector reads real /proc socket ownership.
test('#971 default route detector ignores the fake daemon listener',
  { skip: process.platform !== 'linux' && '/proc is Linux-only' }, async () => {
    const f = fixture('listen-wildcard');
    const blocker = (_database, { hostNetwork }) => hostNetwork.evidence.includes('foreign_listener')
      ? { code: 'host_network', message: 'A foreign listener is present.' } : null;
    // Opus review of PR #973 (reproduced): the real /proc table holds the CI runner's own listeners, so show the
    // detector only the fake daemon's (ownership stays real: see helpers/procTcpFilter.js).
    const markers = path.join(f.root, 'markers');
    const readFile = onlyListenerPorts(() => fs.readdirSync(markers).filter((n) => n.startsWith('listener-'))
      .map((n) => JSON.parse(fs.readFileSync(path.join(markers, n), 'utf8')).port));
    await mount({ detector: undefined, start: f.start, blocker,
      detect: ({ ownedPid }) => detectHostNetwork({ ownedPid, port: Number(new URL(server.url).port), readFile }),
      cli: async () => ({ ok: false, code: 'status_unavailable' }) });
    assert.equal((await put(true)).status, 200);
    await until(() => fs.readdirSync(markers).some((n) => n.startsWith('listener-')));
    assert.equal(detectHostNetwork({ port: Number(new URL(server.url).port), readFile }).evidence.includes('foreign_listener'), true);
    const got = await call(route(), { token: adminToken });
    assert.equal(got.status, 200);
    assert.equal(got.body.blocker, null);
    assert.equal(got.body.host_network.unknown, null);
    assert.equal(got.body.host_network.evidence.includes('foreign_listener'), false);
  });

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
  assert.deepEqual(Object.keys(got.body).sort(), ['addresses', 'blocker', 'dns_name', 'enabled', 'host_network',
    'hostname', 'last_error', 'login_url', 'online', 'process', 'serve', 'state', 'video_address_pending']);
  assert.equal(got.body.state, 'off');
  assert.equal(got.body.hostname, 'nightlight');
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
  await mount({ blocker: () => null, start: (args) => {
    assert.deepEqual(args, { db, dataDir });
    atStart = db.prepare("SELECT tailscale_enabled FROM settings WHERE id = 'app'").get().tailscale_enabled;
    state = 'running';
  }, status: () => ({ state, restarts: 0, lastExitCode: null, reason: null }),
  stop: async () => {
    // Opus fix review of #967: disable intent must be durable before stopping.
    assert.equal(db.prepare("SELECT tailscale_enabled FROM settings WHERE id = 'app'").get().tailscale_enabled, 0);
    state = 'off';
  } });
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

async function queuedRoleChange(how) {
  const id = `queued-${how}`;
  makeUser(db, { id, username: id });
  const sid = makeSession(db, id);
  const token = signToken({ id, sid, role: 'admin' });
  let state = 'running'; let release; let reached = false; let starts = 0;
  const held = new Promise((resolve) => { release = resolve; });
  await mount({ blocker: () => null, onEnqueued: (req) => {
    if (req.headers.authorization === `Bearer ${token}`) reached = true;
  }, start: () => { starts++; state = 'running'; },
  stop: async () => { state = 'stopping'; await held; state = 'off'; },
  status: () => ({ state, restarts: 0, lastExitCode: null, reason: null }) });
  const disabling = put(false);
  await until(() => state === 'stopping');
  const queued = put(true, token);
  // Opus fix review of #967: the seam fires only after requireAuth and
  // requireAdmin, while the prior PUT still holds the route's lock.
  await until(() => reached);
  assert.equal(state, 'stopping');
  if (how === 'revoked') db.prepare('DELETE FROM sessions WHERE id = ?').run(sid);
  else db.prepare("UPDATE users SET role = 'caregiver' WHERE id = ?").run(id);
  release();
  assert.equal((await disabling).status, 200);
  assert.equal((await queued).status, how === 'revoked' ? 401 : 403);
  assert.equal(starts, 0);
  assert.equal(db.prepare("SELECT tailscale_enabled FROM settings WHERE id = 'app'").get().tailscale_enabled, 0);
}

test('#967 queued admin revocation is checked after middleware while lock waits', async () => {
  await queuedRoleChange('revoked');
});

test('#967 queued admin demotion is checked after middleware while lock waits', async () => {
  await queuedRoleChange('demoted');
});

test('#967 schema flag is hidden from settings GET and ignored by settings PUT', async () => {
  settings = await mountRouter('/api/settings', settingsRouter);
  const cols = db.prepare('PRAGMA table_info(settings)').all();
  assert.equal(cols.find((c) => c.name === 'tailscale_enabled')?.dflt_value, '0');
  assert.equal(cols.find((c) => c.name === 'tailscale_enabled')?.notnull, 1);
  assert.equal(cols.find((c) => c.name === 'tailscale_hostname')?.dflt_value, "'nightlight'");
  for (const token of [undefined, adminToken]) {
    const got = await call(`${settings.url}/api/settings`, { token });
    assert.equal(got.status, 200);
    assert.equal(Object.hasOwn(got.body, 'tailscale_enabled'), false);
    assert.equal(Object.hasOwn(got.body, 'tailscale_hostname'), false);
  }
  await call(`${settings.url}/api/settings`, { method: 'PUT', token: adminToken,
    body: { tailscale_enabled: 1, tailscale_hostname: 'injected' } });
  assert.equal(db.prepare("SELECT tailscale_enabled FROM settings WHERE id = 'app'").get().tailscale_enabled, 0);
  assert.equal(db.prepare("SELECT tailscale_hostname FROM settings WHERE id = 'app'").get().tailscale_hostname, 'nightlight');
});

test('#967 unavailable route branch has no unreachable second stop', () => {
  const source = fs.readFileSync(new URL('../src/routes/tailscale.js', import.meta.url), 'utf8');
  const branch = source.match(/if \(now\.state === 'unavailable'\) \{([\s\S]*?)\n          \}/)?.[1];
  assert.ok(branch);
  // Opus fix review of #967: the busy branch handles a live process first;
  // launch() handles a spawned child if its later setup throws.
  assert.doesNotMatch(branch, /hasLiveProcess\(|await stop\(/);
});

test('#969 status vets addresses and DNS while retaining the old fields', async () => {
  db.prepare("UPDATE settings SET tailscale_enabled = 1 WHERE id = 'app'").run();
  await mount({ blocker: () => null, status: () => ({ state: 'running', restarts: 0, reason: null }),
    cli: async (verb) => verb === 'status-peerless' ? { ok: true, json: { BackendState: 'Running', AuthURL: 'https://login.tailscale.com.evil/a/steal', Self: {
      TailscaleIPs: ['100.64.0.1', '100.127.255.255', '100.128.0.1', '192.168.0.1', '100.64.1.999'],
      DNSName: 'neutral.example.ts.net.',
    } } } : { ok: true, json: { Web: {} } } });
  const got = await call(route(), { token: adminToken });
  assert.equal(got.status, 200);
  assert.equal(got.body.state, 'connected');
  assert.deepEqual(got.body.addresses, ['100.64.0.1', '100.127.255.255']);
  assert.equal(got.body.dns_name, 'neutral.example.ts.net');
  assert.equal(got.body.login_url, null);
  assert.doesNotMatch(JSON.stringify(got.body), /steal/);
  for (const field of ['enabled', 'process', 'blocker', 'host_network']) assert.ok(Object.hasOwn(got.body, field));
});

// Owner's staging node, 2026-11-05: deleting the device from the tailnet flipped Self.Online true -> false in about two seconds while
// BackendState stayed "Running" and Health stayed []. The route reports it as `online`: a boolean, or null when it cannot tell.
test('the status reports Self.Online as a boolean, and null whenever it cannot tell', async () => {
  db.prepare("UPDATE settings SET tailscale_enabled = 1 WHERE id = 'app'").run();
  // `mount` replaces the shared `server`, and afterEach closes only the LAST one: this test mounts several routers, so each
  // earlier one is closed first or its listening socket keeps the whole test process from ever exiting.
  const remount = async (options) => { await server?.close(); server = null; await mount(options); };
  const view = async (json) => {
    await remount({ blocker: () => null, status: () => ({ state: 'running', restarts: 0, reason: null }),
      cli: async (verb) => verb === 'status-peerless' ? { ok: true, json } : { ok: true, json: { Web: {} } } });
    return (await call(route(), { token: adminToken })).body;
  };
  const connected = { BackendState: 'Running', Health: [], Self: { TailscaleIPs: ['100.64.0.1'], DNSName: 'n.example.ts.net.' } };
  assert.equal((await view({ ...connected, Self: { ...connected.Self, Online: true } })).online, true);
  const lost = await view({ ...connected, Self: { ...connected.Self, Online: false } });
  assert.equal(lost.online, false);
  assert.equal(lost.state, 'connected', 'a lost connection is still BackendState Running: the new field is the only signal');
  for (const odd of [undefined, null, 'false', 0, 1, {}]) {
    assert.equal((await view({ ...connected, Self: { ...connected.Self, Online: odd } })).online, null, `Online ${JSON.stringify(odd)} is not a boolean`);
  }
  assert.equal((await view({ BackendState: 'Running' })).online, null, 'no Self at all');
  // An unreadable status and a daemon that is off both say null, never false: nothing was measured.
  await remount({ blocker: () => null, status: () => ({ state: 'running', restarts: 0, reason: null }), cli: async () => ({ ok: false, code: 'timeout' }) });
  assert.equal((await call(route(), { token: adminToken })).body.online, null);
  db.prepare("UPDATE settings SET tailscale_enabled = 0 WHERE id = 'app'").run();
  await remount({ blocker: () => null, status: () => ({ state: 'stopped', restarts: 0, reason: null }), cli: async () => assert.fail('no CLI call when off') });
  assert.equal((await call(route(), { token: adminToken })).body.online, null);
});

// Found in the review of #978 and MEASURED on the real CLI (2026-11-04): a rename leaves the Serve entry under the OLD name.
// 'Any :443 entry' called the secure address on while the node's new name served nothing.
test('#978 the secure address counts as on only when Serve is set up for the CURRENT name', async () => {
  db.prepare("UPDATE settings SET tailscale_enabled = 1 WHERE id = 'app'").run();
  const proxy = 'http://127.0.0.1:4000';
  let web;
  await mount({ blocker: () => null, status: () => ({ state: 'running', restarts: 0, reason: null }),
    cli: async (verb) => verb === 'status-peerless'
      ? { ok: true, json: { BackendState: 'Running', Self: { TailscaleIPs: ['100.64.0.1'], DNSName: 'new-name.example.ts.net.' } } }
      : { ok: true, json: { Web: web } } });
  const enabled = async () => (await call(route(), { token: adminToken })).body.serve.enabled;
  web = { 'old-name.example.ts.net:443': { Handlers: { '/': { Proxy: proxy } } } };
  assert.equal(await enabled(), false);
  web = { 'new-name.example.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:9999' } } } };
  assert.equal(await enabled(), false);
  web = { 'new-name.example.ts.net:443': { Handlers: { '/': { Proxy: proxy } } } };
  assert.equal(await enabled(), true);
});

// 2026-11-06: the phone apps fall back to this address when the local one does not answer, and DROP a saved address on `url: null`.
// So the endpoint must tell "definitely not available" (null) from "not known right now" (409), or a daemon restart would erase it.
test('GET /address: any signed-in user gets the https address only when connected AND Serve is on for the current name', async () => {
  db.prepare("UPDATE settings SET tailscale_enabled = 1 WHERE id = 'app'").run();
  const proxy = 'http://127.0.0.1:4000';
  let web = {};
  await mount({ blocker: () => null, status: () => ({ state: 'running', restarts: 0, reason: null }),
    cli: async (verb) => verb === 'status-peerless'
      ? { ok: true, json: { BackendState: 'Running', Self: { TailscaleIPs: ['100.64.0.1'], DNSName: 'new-name.example.ts.net.' } } }
      : { ok: true, json: { Web: web } } });
  const address = (token = caregiverToken) => call(`${route()}/address`, { token });
  web = { 'new-name.example.ts.net:443': { Handlers: { '/': { Proxy: proxy } } } };
  for (const token of [adminToken, caregiverToken]) {
    const got = await address(token);
    assert.equal(got.status, 200);
    assert.deepEqual(got.body, { url: 'https://new-name.example.ts.net' }, 'exactly the one field: no addresses, hostname or state leak to a caregiver');
  }
  assert.equal((await call(`${route()}/address`)).status, 401, 'not signed in');
  web = {};
  assert.deepEqual((await address()).body, { url: null }, 'connected, Serve off: definitely not available');
  web = { 'old-name.example.ts.net:443': { Handlers: { '/': { Proxy: proxy } } } };
  assert.deepEqual((await address()).body, { url: null }, 'Serve is set up for the OLD name only (#978)');
});

test('GET /address: Tailscale turned off is a definite null with no CLI call; an unsettled daemon is a 409, never a null', async () => {
  const remount = async (options) => { await server?.close(); server = null; await mount(options); };
  const address = () => call(`${route()}/address`, { token: caregiverToken });
  db.prepare("UPDATE settings SET tailscale_enabled = 0 WHERE id = 'app'").run();
  await remount({ blocker: () => null, status: () => ({ state: 'stopped', restarts: 0, reason: null }), cli: async () => assert.fail('no CLI call when off') });
  const off = await address();
  assert.equal(off.status, 200);
  assert.deepEqual(off.body, { url: null });

  db.prepare("UPDATE settings SET tailscale_enabled = 1 WHERE id = 'app'").run();
  const running = { state: 'running', restarts: 0, reason: null };
  const web = { Web: { 'n.example.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:4000' } } } } };
  const cases = [
    ['the daemon is still starting', { status: () => ({ state: 'starting', restarts: 0, reason: null }), cli: async () => assert.fail('not asked') }],
    ['it needs sign-in', { status: () => running, cli: async (verb) => verb === 'status-peerless' ? { ok: true, json: { BackendState: 'NeedsLogin' } } : { ok: true, json: web } }],
    ['its status cannot be read', { status: () => running, cli: async () => ({ ok: false, code: 'timeout' }) }],
    ['the CLI throws', { status: () => running, cli: async () => { throw new Error('boom'); } }],
  ];
  for (const [label, options] of cases) {
    await remount({ blocker: () => null, ...options });
    const got = await address();
    assert.equal(got.status, 409, label);
    assert.equal(got.body.code, 'status_unavailable', label);
    assert.equal(Object.hasOwn(got.body, 'url'), false, `${label}: no url field, so the phone keeps what it has`);
  }
});

test('#969 hostname is saved only after CLI success and sign-in uses that name', async () => {
  const calls = [];
  await mount({ blocker: () => null, status: () => ({ state: 'running' }),
    cli: async (verb, options) => {
      calls.push([verb, options]);
      if (verb === 'set-hostname' && options.hostname === 'failed-name') return { ok: false, code: 'cli_failed' };
      return { ok: true, json: {} };
    } });
  db.prepare("UPDATE settings SET tailscale_enabled = 1 WHERE id = 'app'").run();
  const action = (body) => call(`${route()}/actions`, { method: 'POST', token: adminToken, body });
  assert.equal((await action({ action: 'hostname', hostname: 'failed-name' })).status, 409);
  assert.equal(db.prepare("SELECT tailscale_hostname FROM settings WHERE id = 'app'").get().tailscale_hostname, 'nightlight');
  assert.equal((await action({ action: 'hostname', hostname: 'neutral-name' })).status, 200);
  assert.equal(db.prepare("SELECT tailscale_hostname FROM settings WHERE id = 'app'").get().tailscale_hostname, 'neutral-name');
  assert.equal((await action({ action: 'sign-in' })).status, 200);
  assert.deepEqual(calls.findLast(([verb]) => verb === 'up'), ['up', { hostname: 'neutral-name' }]);
});

test('#969 malformed CLI status reports a safe error', async () => {
  db.prepare("UPDATE settings SET tailscale_enabled = 1 WHERE id = 'app'").run();
  await mount({ blocker: () => null, status: () => ({ state: 'running' }),
    cli: async () => ({ ok: false, code: 'invalid_status' }) });
  const got = await call(route(), { token: adminToken });
  assert.equal(got.status, 200);
  assert.equal(got.body.state, 'error');
  assert.equal(got.body.last_error, 'invalid_status');
});

test('#969 actions reject caregiver, revoked admin, demo and hostile hostname', async () => {
  let calls = 0;
  await mount({ blocker: () => null, status: () => ({ state: 'running' }),
    cli: async () => { calls++; return { ok: true, json: {} }; } });
  db.prepare("UPDATE settings SET tailscale_enabled = 1 WHERE id = 'app'").run();
  const action = (body, token = adminToken) => call(`${route()}/actions`, { method: 'POST', token, body });
  assert.equal((await action({ action: 'serve-enable' }, caregiverToken)).status, 403);
  assert.equal((await action({ action: 'hostname', hostname: 'private.name' })).status, 400);
  assert.equal((await action({ action: 'serve-enable', target: 'http://evil' })).status, 400);
  const user = makeUser(db, { id: 'revoked-969', username: 'revoked-969' });
  const sid = makeSession(db, user.id);
  const revoked = signToken({ id: user.id, sid, role: 'admin' });
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sid);
  assert.equal((await action({ action: 'serve-enable' }, revoked)).status, 401);
  process.env.DEMO_MODE = 'true';
  try { assert.equal((await action({ action: 'serve-enable' })).status, 403); }
  finally { delete process.env.DEMO_MODE; }
  assert.equal(calls, 0);
});

test('#969 every action refuses host networking before CLI or reset', async () => {
  let calls = 0; let stops = 0;
  await mount({ blocker: () => ({ code: 'host_network', message: 'Use a separate network.' }),
    status: () => ({ state: 'running' }), stop: async () => { stops++; },
    cli: async () => { calls++; return { ok: true, json: {} }; } });
  db.prepare("UPDATE settings SET tailscale_enabled = 1 WHERE id = 'app'").run();
  for (const action of ['sign-in', 'hostname', 'serve-enable', 'serve-disable', 'logout', 'reset']) {
    const body = action === 'hostname' ? { action, hostname: 'neutral' } : { action };
    const got = await call(`${route()}/actions`, { method: 'POST', token: adminToken, body });
    assert.equal(got.status, 409, action);
    assert.equal(got.body.code, 'host_network', action);
  }
  assert.equal(calls, 0);
  assert.equal(stops, 0);
});

test('#969 action queue rechecks a revoked session at mutation time', async () => {
  const user = makeUser(db, { id: 'queued-969', username: 'queued-969' });
  const sid = makeSession(db, user.id);
  const token = signToken({ id: user.id, sid, role: 'admin' });
  let release; let entered = false; let calls = 0;
  const held = new Promise((resolve) => { release = resolve; });
  await mount({ blocker: () => null, status: () => ({ state: 'running' }),
    onEnqueued: (req) => { if (req.headers.authorization === `Bearer ${token}`) entered = true; },
    cli: async () => { calls++; if (calls === 1) await held; return { ok: true, json: {} }; } });
  db.prepare("UPDATE settings SET tailscale_enabled = 1 WHERE id = 'app'").run();
  const first = call(`${route()}/actions`, { method: 'POST', token: adminToken, body: { action: 'serve-enable' } });
  await until(() => calls === 1);
  const second = call(`${route()}/actions`, { method: 'POST', token, body: { action: 'serve-enable' } });
  await until(() => entered);
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sid);
  release();
  assert.equal((await first).status, 200);
  assert.equal((await second).status, 401);
  assert.equal(calls, 3); // first mutation plus two read-only status checks from its response
});

test('#969 action queue rechecks a demoted admin at mutation time', async () => {
  const user = makeUser(db, { id: 'demoted-969', username: 'demoted-969' });
  const token = signToken({ id: user.id, sid: makeSession(db, user.id), role: 'admin' });
  let release; let entered = false; let calls = 0;
  const held = new Promise((resolve) => { release = resolve; });
  await mount({ blocker: () => null, status: () => ({ state: 'running' }),
    onEnqueued: (req) => { if (req.headers.authorization === `Bearer ${token}`) entered = true; },
    cli: async () => { calls++; if (calls === 1) await held; return { ok: true, json: {} }; } });
  db.prepare("UPDATE settings SET tailscale_enabled = 1 WHERE id = 'app'").run();
  const first = call(`${route()}/actions`, { method: 'POST', token: adminToken, body: { action: 'serve-enable' } });
  await until(() => calls === 1);
  const second = call(`${route()}/actions`, { method: 'POST', token, body: { action: 'serve-enable' } });
  await until(() => entered);
  db.prepare("UPDATE users SET role = 'caregiver' WHERE id = ?").run(user.id); // session stays valid: role is the only change
  release();
  assert.equal((await first).status, 200);
  assert.equal((await second).status, 403);
  assert.equal(calls, 3); // the demoted request never reached the CLI
});

test('#969 reset refuses a linked state directory and deletes nothing through it', async () => {
  const privateDir = path.join(dataDir, 'private');
  const stateDir = path.join(privateDir, 'tailscale');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-969-outside-'));
  roots.push(outside);
  fs.writeFileSync(path.join(outside, 'precious'), 'must survive');
  fs.mkdirSync(privateDir, { recursive: true });
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.symlinkSync(outside, stateDir, 'junction'); // a junction is the unprivileged link on win32
  let state = 'running';
  await mount({ blocker: () => null, status: () => ({ state }), stop: async () => { state = 'off'; },
    start: () => { state = 'running'; }, cli: async () => ({ ok: true, json: {} }) });
  db.prepare("UPDATE settings SET tailscale_enabled = 1 WHERE id = 'app'").run();
  const result = await call(`${route()}/actions`, { method: 'POST', token: adminToken, body: { action: 'reset' } });
  fs.unlinkSync(stateDir); // remove the link itself, never its target
  assert.equal(result.status, 409);
  assert.equal(fs.readFileSync(path.join(outside, 'precious'), 'utf8'), 'must survive');
});

test('#969 disable and logout do not wait behind a sign-in that never prints a link', async () => {
  for (const [name, send] of [['disable', () => put(false)],
    ['logout', () => call(`${route()}/actions`, { method: 'POST', token: adminToken, body: { action: 'logout' } })]]) {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    let spawned = false;
    child.kill = () => { queueMicrotask(() => child.emit('close', null)); return true; };
    let state = 'running';
    await mount({ blocker: () => null, status: () => ({ state }), stop: async () => { state = 'off'; },
      // #971: these tests fake the CLI child, not the daemon, so the socket the new wait looks for is "ready".
      cli: (verb, o) => runTailscaleCli(verb, { ...o, socketPath: '/tmp/owned.sock', socketExists: () => true,
        timeoutMs: 20_000, spawnFn: () => {
          // First spawn = the stalled sign-in. Any later CLI call (the logout itself) gets a fresh
          // child that succeeds at once; handing it the killed child would hang until the timeout.
          if (spawned) {
            const next = new EventEmitter();
            next.stdout = new PassThrough(); next.stderr = new PassThrough();
            next.kill = () => true;
            queueMicrotask(() => next.emit('close', 0));
            return next;
          }
          spawned = true; return child;
        } }) });
    db.prepare("UPDATE settings SET tailscale_enabled = 1 WHERE id = 'app'").run();
    const signIn = call(`${route()}/actions`, { method: 'POST', token: adminToken, body: { action: 'sign-in' } });
    await until(() => spawned);
    const started = Date.now();
    const result = await send();
    assert.equal(result.status === 200 || result.status === 409, true, name);
    assert.ok(Date.now() - started < 5000, `${name} waited behind the stalled sign-in`);
    await signIn;
    await server.close(); server = null;
    spawned = false;
  }
});

test('#969 disable clears an old action error', async () => {
  let state = 'running';
  await mount({ blocker: () => null, status: () => ({ state }), stop: async () => { state = 'off'; },
    cli: async () => ({ ok: false, code: 'consent_required' }) });
  db.prepare("UPDATE settings SET tailscale_enabled = 1 WHERE id = 'app'").run();
  await call(`${route()}/actions`, { method: 'POST', token: adminToken, body: { action: 'serve-enable' } });
  const off = await put(false);
  assert.equal(off.status, 200);
  assert.equal(off.body.last_error, null);
});

test('#969 reset removes only Tailscale state and restarts a new node', async () => {
  const privateDir = path.join(dataDir, 'private');
  const stateDir = path.join(privateDir, 'tailscale');
  fs.mkdirSync(stateDir, { recursive: true });
  const sentinel = path.join(privateDir, 'keep-969');
  fs.writeFileSync(sentinel, 'secret sibling');
  fs.writeFileSync(path.join(stateDir, 'tailscaled.state'), 'old identity');
  let state = 'running'; let starts = 0;
  await mount({ blocker: () => null,
    status: () => ({ state }), stop: async () => { state = 'off'; },
    start: () => { starts++; state = 'running'; }, cli: async () => ({ ok: false, code: 'invalid_status' }) });
  db.prepare("UPDATE settings SET tailscale_enabled = 1 WHERE id = 'app'").run();
  const result = await call(`${route()}/actions`, { method: 'POST', token: adminToken, body: { action: 'reset' } });
  assert.equal(result.status, 200);
  assert.equal(starts, 1);
  assert.equal(fs.existsSync(stateDir), false);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'secret sibling');
  fs.rmSync(sentinel);
});

test('#969 disable cancels a login child whose URL was already returned', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  let killed = false;
  child.kill = () => { killed = true; queueMicrotask(() => child.emit('close', null)); return true; };
  const pending = runTailscaleCli('up', { hostname: 'nightlight', socketPath: '/tmp/owned.sock', socketExists: () => true,
    spawnFn: () => {
      queueMicrotask(() => child.stdout.write('https://login.tailscale.com/a/waiting\n'));
      return child;
    } });
  assert.equal((await pending).ok, true);
  assert.equal(getTailscaleLinks().loginUrl, 'https://login.tailscale.com/a/waiting');
  let state = 'running';
  await mount({ blocker: () => null, status: () => ({ state }),
    stop: async () => { state = 'off'; } });
  db.prepare("UPDATE settings SET tailscale_enabled = 1 WHERE id = 'app'").run();
  assert.equal((await put(false)).status, 200);
  assert.equal(killed, true);
  assert.equal(getTailscaleLinks().loginUrl, null);
});

test('#969 logout cancels pending sign-in before running its CLI mutation', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  let killed = false; const verbs = [];
  child.kill = () => { killed = true; queueMicrotask(() => child.emit('close', null)); return true; };
  const pending = runTailscaleCli('up', { hostname: 'nightlight', socketPath: '/tmp/owned.sock', socketExists: () => true,
    spawnFn: () => { queueMicrotask(() => child.stdout.write('https://login.tailscale.com/a/waiting\n')); return child; } });
  await pending;
  await mount({ blocker: () => null, status: () => ({ state: 'running' }),
    cli: async (verb) => { verbs.push(verb); return { ok: true, json: {} }; } });
  db.prepare("UPDATE settings SET tailscale_enabled = 1 WHERE id = 'app'").run();
  const got = await call(`${route()}/actions`, { method: 'POST', token: adminToken, body: { action: 'logout' } });
  assert.equal(got.status, 200);
  assert.equal(killed, true);
  assert.equal(verbs[0], 'logout');
  assert.equal(getTailscaleLinks().loginUrl, null);
});

// A cached tailnet address must not outlive the node that owned it: while it is cached, the next MediaMTX launch
// would advertise a dead address ("never advertise a disconnected IP", design section 4).
test('#974 disable, logout and reset each forget the cached tailnet address', async () => {
  db.prepare("UPDATE settings SET tailscale_enabled = 1 WHERE id = 'app'").run();
  let state = 'running';
  await mount({ blocker: () => null, status: () => ({ state }), stop: async () => { state = 'off'; },
    start: () => true, cli: async () => ({ ok: true, json: {} }) });
  setTailnetAddress('100.64.1.1');
  assert.equal((await call(`${route()}/actions`, { method: 'POST', token: adminToken, body: { action: 'logout' } })).status, 200);
  assert.equal(getTailnetAddress(), null);
  setTailnetAddress('100.64.1.1');
  assert.equal((await put(false)).status, 200);
  assert.equal(getTailnetAddress(), null);
  state = 'running'; setTailnetAddress('100.64.1.1');
  await call(`${route()}/actions`, { method: 'POST', token: adminToken, body: { action: 'reset' } });
  assert.equal(getTailnetAddress(), null);
});

test('#974 Apply now is admin-only, works with the daemon off, and reports failures', async () => {
  let applied = true; let calls = 0;
  await mount({ blocker: () => ({ code: 'host_network', message: 'Unavailable.' }),
    pendingVideoAddress: () => true, applyVideoAddress: async () => { calls++; return applied; } });
  const action = (token = adminToken) => call(`${route()}/actions`, { method: 'POST', token,
    body: { action: 'apply-video-address' } });
  assert.equal((await action(caregiverToken)).status, 403);
  const view = await call(route(), { token: adminToken });
  assert.equal(view.body.video_address_pending, true);
  const good = await action();
  assert.equal(good.status, 200); assert.equal(good.body.applied, true);
  assert.equal(good.body.video_address_pending, true);
  applied = false;
  const bad = await action();
  assert.equal(bad.status, 409); assert.equal(bad.body.code, 'video_address_not_applied');
  assert.equal(bad.body.applied, false); assert.equal(bad.body.video_address_pending, true);
  applied = null;
  const busy = await action();
  assert.equal(busy.status, 409); assert.equal(busy.body.code, 'busy');
  assert.equal(busy.body.error, 'A video address check is in progress. Try again in a moment.');
  assert.equal(busy.body.applied, false); assert.equal(busy.body.video_address_pending, true);
  process.env.DEMO_MODE = 'true';
  try { assert.equal((await action()).status, 403); }
  finally { delete process.env.DEMO_MODE; }
  assert.equal(calls, 3);
});

test('#974 queued Apply now rechecks revoked and demoted admin sessions', async () => {
  let calls = 0;
  const user = makeUser(db, { id: 'queued-974', username: 'queued-974' });
  const sid = makeSession(db, user.id);
  const token = signToken({ id: user.id, sid, role: 'admin' });
  await mount({ onEnqueued: (req) => {
    if (req.headers.authorization === `Bearer ${token}`) db.prepare('DELETE FROM sessions WHERE id = ?').run(sid);
  }, applyVideoAddress: async () => { calls++; return true; } });
  const action = () => call(`${route()}/actions`, { method: 'POST', token,
    body: { action: 'apply-video-address' } });
  assert.equal((await action()).status, 401);
  await server.close(); server = null;
  const sid2 = makeSession(db, user.id);
  const token2 = signToken({ id: user.id, sid: sid2, role: 'admin' });
  await mount({ onEnqueued: (req) => {
    if (req.headers.authorization === `Bearer ${token2}`)
      db.prepare("UPDATE users SET role = 'caregiver' WHERE id = ?").run(user.id);
  }, applyVideoAddress: async () => { calls++; return true; } });
  const demoted = await call(`${route()}/actions`, { method: 'POST', token: token2,
    body: { action: 'apply-video-address' } });
  assert.equal(demoted.status, 403); assert.equal(calls, 0);
});
