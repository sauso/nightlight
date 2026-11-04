import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnAsApp } from '../src/lib/childEnv.js';
import { startTailscale, stopTailscale, getTailscaleStatus, EXPOSURE_HOLD_MS, FORCE_KILL_MS, TAILSCALE_STOP_CAP_MS } from '../src/lib/tailscaleProcess.js';
import { isLoopbackExposed } from '../src/lib/loopbackExposure.js';
import { logger } from '../src/lib/logger.js';
import { useTempDataDir, cleanupTempDataDirs, mountRouter, call } from './helpers/harness.js';

useTempDataDir();
const { default: healthDb } = await import('../src/db.js');
const { healthHandler } = await import('../src/lib/serverIdentity.js');
const { default: express } = await import('express');
after(() => { healthDb.close(); cleanupTempDataDirs(); });

const FAKE = fileURLToPath(new URL('./helpers/fakeTailscaled.js', import.meta.url));
const roots = [];
const allChildren = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, ms = 1500) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await sleep(10); }
  assert.fail('timed out waiting for daemon state');
}
function fixture(mode = 'stay', changes = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-ts-proc-'));
  roots.push(dataDir);
  const markerDir = path.join(dataDir, 'markers');
  fs.mkdirSync(markerDir);
  const uid = process.getuid?.() || 1500;
  const fsImpl = { ...fs, lstatSync: (p) => {
    const st = fs.lstatSync(p);
    return Object.assign(st, { uid, mode: process.platform === 'win32'
      ? (st.mode & ~0o777) | (st.isDirectory() ? 0o700 : 0o600) : st.mode });
  } };
  const seen = [];
  const children = [];
  const spawnFn = (binary, argv, options) => {
    const stateFile = argv.find((arg) => arg.startsWith('--state='))?.slice(8);
    seen.push({ binary, argv, options, exposed: isLoopbackExposed(),
      state: getTailscaleStatus().state,
      stateMode: stateFile && fs.existsSync(stateFile) ? fs.statSync(stateFile).mode & 0o777 : null });
    // Preserve the production argv in `seen`, then run the real fake using Node on Windows too.
    const child = spawnAsApp(process.execPath, [FAKE, ...argv], options);
    children.push(child);
    allChildren.push(child);
    return child;
  };
  const opts = {
    db: { prepare: () => ({ get: () => ({ id: 1 }) }) }, dataDir,
    hostNetwork: { host: false, evidence: [], unknown: 'not_linux' }, binaryPath: process.execPath,
    binary: '/usr/local/bin/tailscaled', argvSuffix: [`--marker-dir=${markerDir}`, `--mode=${mode}`],
    stateOptions: { uid, fsImpl }, runtimeOptions: { uid, fsImpl },
    spawnFn, delayMs: () => 30, exposureHoldMs: 20, forceKillMs: 40, stopCapMs: 100,
    ...changes,
  };
  const pids = () => fs.readdirSync(markerDir).filter((n) => /^pid-\d+$/.test(n));
  return { opts, seen, children, pids, markerDir, dataDir };
}
afterEach(async () => {
  // A failed stop seam can leave a SIGTERM-ignoring real child alive. Kill every child before
  // awaiting shutdown, including when the assertion in the test failed early (Opus review of #965).
  for (const child of allChildren.splice(0)) {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      try { process.kill(child.pid, 'SIGKILL'); } catch { /* already exited */ }
    }
  }
  await Promise.race([stopTailscale(), sleep(500)]);
  await sleep(35);
  for (const p of roots.splice(0)) fs.rmSync(p, { recursive: true, force: true });
  logger.clear();
});

test('#965 fixed argv, allowlisted env, and exposure already set at spawn', async () => {
  const f = fixture('dump-env');
  const prior = { ...process.env };
  process.env.MEDIA_ISOLATION = 'off';
  process.env.MTX_SECRET = 'x'; process.env.PORT = '4000'; process.env.JWT_SECRET = 'secret';
  try {
    assert.equal(startTailscale(f.opts), true);
    await until(() => f.pids().length === 1);
    assert.equal(f.seen[0].exposed, true);
    assert.equal(f.seen[0].state, 'starting');
    assert.deepEqual(f.seen[0].argv.slice(0, 2), ['--tun=userspace-networking', '--no-logs-no-support']);
    assert.deepEqual(f.seen[0].argv.slice(2, 6).map((x) => x.split('=')[0]), ['--state', '--statedir', '--socket', '--port']);
    assert.equal(f.seen[0].argv[5], '--port=0');
    assert.equal(f.seen[0].options.cwd.endsWith(path.join('private', 'tailscale')), true);
    const pid = f.pids()[0].slice(4);
    const env = JSON.parse(fs.readFileSync(path.join(f.markerDir, `env-${pid}.json`)));
    for (const name of ['MTX_SECRET', 'PORT', 'JWT_SECRET', 'HOME']) assert.equal(name in env, false, name);
    assert.equal(isLoopbackExposed(), true);
    await stopTailscale();
    assert.equal(isLoopbackExposed(), true, 'the 5s hold is simulated at 20ms');
    await sleep(5);
    assert.equal(isLoopbackExposed(), true, 'the final-exit hold must not clear on the next tick');
    await until(() => !isLoopbackExposed());
  } finally { process.env = prior; }
});

test('#965 a daemon-created 0644 state file is tightened before relaunch', {
  skip: process.platform === 'win32' && 'POSIX modes are required; Linux CI runs this',
}, async () => {
  const f = fixture('write-state=0644');
  startTailscale(f.opts);
  await until(() => f.pids().length === 1);
  await stopTailscale();
  startTailscale(f.opts);
  await until(() => f.pids().length === 2);
  assert.equal(f.seen[1].stateMode, 0o600);
});

test('#965 two starts in one tick spawn once and start while stopping refuses', async () => {
  const f = fixture('ignore-sigterm');
  assert.equal(startTailscale(f.opts), true);
  assert.equal(startTailscale(f.opts), false);
  await until(() => f.pids().length === 1);
  const stopped = stopTailscale();
  assert.equal(stopTailscale(), stopped, 'repeated stops share the in-flight stop');
  assert.equal(startTailscale(f.opts), false);
  await stopped;
  assert.equal(f.pids().length, 1);
  await until(() => getTailscaleStatus().state === 'off');
});

test('#965 missing interpreter enters quiet backoff without throwing (#257)', async () => {
  const f = fixture('stay', { spawnFn: (binary, argv, options) => spawnAsApp(binary, argv, options) });
  f.opts.binary = path.join(f.dataDir, 'bad-interpreter');
  fs.writeFileSync(f.opts.binary, '#!/missing-interpreter-for-967\n', { mode: 0o700 });
  f.opts.binaryPath = f.opts.binary;
  assert.equal(startTailscale(f.opts), true);
  await until(() => getTailscaleStatus().state === 'backoff');
  assert.equal(getTailscaleStatus().reason, 'spawn_failed');
});

test('#965 non-executable binary EACCES enters backoff without throwing (#257)', {
  skip: process.platform === 'win32' && 'POSIX execute bits are required; Linux CI runs this',
}, async () => {
  const f = fixture('stay');
  const binary = path.join(f.dataDir, 'not-executable');
  fs.writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o600 });
  f.opts.binary = binary;
  f.opts.binaryPath = process.execPath;
  f.opts.spawnFn = (cmd, argv, options) => spawnAsApp(cmd, argv, options);
  startTailscale(f.opts);
  await until(() => getTailscaleStatus().state === 'backoff');
  assert.equal(getTailscaleStatus().reason, 'spawn_failed');
});

test('#965 wrapper-style 127 and crash retain exposure during relaunch', async () => {
  const delays = [];
  const f = fixture('exit=127', { delayMs: (n) => { delays.push(n); return 30; } });
  startTailscale(f.opts);
  await until(() => f.pids().length >= 3);
  assert.deepEqual(delays.slice(0, 2), [3000, 6000], '126/127 use execFailureBackoff');
  assert.equal(isLoopbackExposed(), true);
  assert.equal(getTailscaleStatus().restarts >= 1, true);
  await stopTailscale();
});

test('#965 exposure stays set through a crash and pending relaunch gap', async () => {
  const f = fixture('exit=1', { delayMs: () => 150 });
  startTailscale(f.opts);
  await until(() => getTailscaleStatus().state === 'backoff');
  assert.equal(f.pids().length, 1);
  assert.equal(isLoopbackExposed(), true);
  await until(() => f.pids().length >= 2);
  assert.equal(isLoopbackExposed(), true);
});

test('#965 stop cancels a pending crash relaunch', async () => {
  const f = fixture('exit=1', { delayMs: () => 150 });
  startTailscale(f.opts);
  await until(() => getTailscaleStatus().state === 'backoff');
  await stopTailscale();
  await sleep(190);
  assert.equal(f.pids().length, 1);
  assert.equal(getTailscaleStatus().state, 'off');
});

test('#965 Gate B blocks initial launch and rechecks after a crash', async () => {
  const f = fixture('crash-after=20');
  f.opts.db = { prepare: () => ({ get: () => null }) };
  startTailscale(f.opts);
  assert.equal(getTailscaleStatus().state, 'unavailable');
  assert.equal(f.pids().length, 0);
  assert.equal(isLoopbackExposed(), false);
  await stopTailscale();
  let admin = true;
  f.opts.db = { prepare: () => ({ get: () => admin ? { id: 1 } : null }) };
  startTailscale(f.opts);
  await until(() => f.pids().length === 1);
  admin = false;
  await until(() => getTailscaleStatus().state === 'unavailable');
  assert.equal(f.pids().length, 1);
  await until(() => !isLoopbackExposed());
});

test('#965 daemon output is console-only, redacted, capped, and rate-limited', async () => {
  const secret = ['active login: someone@example.com', 'device.tail.ts.net', '203.0.113.7:1234', 'https://login.tailscale.com/a', 'tskey-secret', 'authkey=secret',
    'person@\u0000example.com someone\u001b@example.com someone@github someone@passkey',
    '[fe80::1%eth0]:41641 [::ffff:203.0.113.7]:41641'];
  const sink = [];
  const f = fixture(`print-lines=${JSON.stringify([...secret, 'ordinary line', ...Array(30).fill('more output')])}`, { consoleSink: (x) => sink.push(x) });
  startTailscale(f.opts);
  await until(() => sink.some((line) => line.includes('ordinary line')));
  assert.ok(sink.length <= 10);
  const all = sink.join('\n');
  for (const raw of ['someone@example.com', 'person@example.com', 'person@\u0000example.com', 'someone\u001b@example.com', 'someone@github', 'someone@passkey',
    'device.tail.ts.net', '203.0.113.7:1234', '[fe80::1%eth0]:41641', '[::ffff:203.0.113.7]:41641',
    'login.tailscale.com/a', 'tskey-secret', 'authkey=secret']) {
    assert.equal(all.includes(raw), false, raw);
    assert.equal(logger.getRecent().join('\n').includes(raw), false, raw);
  }
  assert.equal(all.includes('ordinary line'), true);
  assert.equal(logger.getRecent().some((x) => x.includes('ordinary line')), false);
});

test('#965 a new start resets the daemon output budget', async () => {
  const sink = [];
  const f = fixture(`print-lines=${JSON.stringify([...Array(10).fill('first run'), 'overflow'])}`,
    { consoleSink: (line) => sink.push(line) });
  startTailscale(f.opts);
  await until(() => sink.length === 10);
  await stopTailscale();
  f.opts.argvSuffix = [`--marker-dir=${f.markerDir}`, `--mode=print-lines=${JSON.stringify(['second run'])}`];
  startTailscale(f.opts);
  await until(() => sink.some((line) => line.includes('second run')));
});

test('#965 a 64 KiB hostile daemon line is redacted promptly', async () => {
  const sink = [];
  const f = fixture('print-hostile', { consoleSink: (line) => sink.push(line) });
  const start = performance.now();
  startTailscale(f.opts);
  await until(() => sink.length === 1);
  assert.ok(performance.now() - start < 900, 'regex work on a hostile line blocked the event loop');
  assert.ok(sink[0].length <= 512);
});

test('#965 one daemon line is length-capped before the console sink', async () => {
  const lines = [];
  const f = fixture(`print-lines=${JSON.stringify(['x'.repeat(2000)])}`, { consoleSink: (line) => lines.push(line) });
  startTailscale(f.opts);
  await until(() => lines.length === 1);
  assert.ok(lines[0].length <= 512);
});

test('#965 ordinary crash delay doubles and a stable run resets it', async () => {
  // Each launch and exit reads the injected monotonic clock twice. The second run lasts 60s
  // on that clock; the fake still exits quickly so the test does not spend a minute waiting.
  const ticks = [0, 0, 100, 100, 100, 100, 200, 200, 200, 200, 60200, 60200];
  let last = 60200;
  const delays = [];
  const f = fixture('exit=1', {
    now: () => ticks.shift() ?? ++last,
    delayMs: (n) => { delays.push(n); return 30; },
  });
  startTailscale(f.opts);
  await until(() => delays.length >= 3);
  assert.deepEqual(delays.slice(0, 3), [3000, 6000, 3000]);
});

test('#965 a kill error leaves the real child as the only instance (#553)', async () => {
  const f = fixture('stay');
  startTailscale(f.opts);
  await until(() => f.pids().length === 1);
  f.children[0].emit('error', Object.assign(new Error('denied'), { syscall: 'kill', code: 'EPERM' }));
  assert.equal(getTailscaleStatus().state, 'unavailable');
  await sleep(100);
  assert.equal(f.pids().length, 1);
  assert.equal(isLoopbackExposed(), true);
});

test('#965 failed SIGKILL keeps exposure until the child truly exits', {
  skip: process.platform === 'win32' && 'POSIX SIGKILL semantics are required; Linux CI runs this',
}, async () => {
  const f = fixture('ignore-sigterm', { killFn: () => false });
  startTailscale(f.opts);
  await until(() => f.pids().length === 1);
  const at = Date.now();
  await Promise.race([stopTailscale(), sleep(500).then(() => assert.fail('stop exceeded its cap'))]);
  assert.ok(Date.now() - at < 500, 'the injected 100ms stop cap did not bound the wait');
  assert.equal(getTailscaleStatus().state, 'unavailable');
  assert.equal(isLoopbackExposed(), true);
  process.kill(f.children[0].pid, 'SIGKILL');
  await until(() => getTailscaleStatus().state === 'off');
  await until(() => !isLoopbackExposed());
});

test('#965 status reasons are fixed codes without paths', async () => {
  const f = fixture('stay');
  f.opts.dataDir = path.join(f.dataDir, 'missing');
  startTailscale(f.opts);
  const reason = getTailscaleStatus().reason;
  assert.match(reason, /^[a-z][a-z0-9_]*$/);
  assert.equal(reason.includes('/'), false);
  assert.equal(logger.getRecent().some((line) => line.includes(f.dataDir)), false);
});

test('#965 production timing bounds', () => {
  assert.ok(EXPOSURE_HOLD_MS >= 5000);
  assert.ok(FORCE_KILL_MS < TAILSCALE_STOP_CAP_MS);
});

test('#965 runtime directory is removed after the child exits', async () => {
  const f = fixture('exit=1', { delayMs: () => 1000 });
  startTailscale(f.opts);
  await until(() => getTailscaleStatus().state === 'backoff');
  assert.equal(f.pids().length, 1, 'the real child must have exited before checking cleanup');
  const socket = f.seen[0].argv.find((arg) => arg.startsWith('--socket=')).slice(9);
  assert.equal(fs.existsSync(path.dirname(socket)), false);
});

test('#965 a late old-generation exit cannot clear or relaunch over a new child', async () => {
  const f = fixture('stay');
  startTailscale(f.opts);
  await until(() => f.pids().length === 1);
  const old = f.children[0];
  await stopTailscale();
  startTailscale(f.opts);
  await until(() => f.pids().length === 2);
  old.emit('exit', 1);
  old.emit('error', Object.assign(new Error('late kill'), { syscall: 'kill', code: 'EPERM' }));
  await sleep(50);
  assert.equal(f.pids().length, 2);
  assert.equal(getTailscaleStatus().state, 'running');
  assert.equal(isLoopbackExposed(), true);
});

test('#965 production callers supply no test-only argv suffix', () => {
  for (const file of ['../src/routes/tailscale.js', '../src/lib/tailscaleBoot.js']) {
    const src = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /argvSuffix|--marker-dir|--mode=/);
  }
  const supervisor = fs.readFileSync(new URL('../src/lib/tailscaleProcess.js', import.meta.url), 'utf8');
  assert.doesNotMatch(supervisor, /from\s+['"][^'"]*mediamtx/i);
  assert.deepEqual(Object.keys(getTailscaleStatus()), ['state', 'restarts', 'lastExitCode', 'reason']);
});

test('#967 omitted network and binary injections end unavailable', async () => {
  const f = fixture();
  startTailscale({ db: f.opts.db, dataDir: f.dataDir });
  assert.equal(getTailscaleStatus().state, 'unavailable');
  assert.ok(['host_network', 'not_installed'].includes(getTailscaleStatus().reason));
  assert.equal(f.seen.length, 0);
});

test('#967 post-spawn exception sends stop to the live child', async () => {
  let kills = 0;
  const handlers = {};
  const f = fixture('stay', {
    spawnFn: () => ({ pid: 12345, on: (event, fn) => {
      if (event === 'close') throw Error('handler setup failed');
      handlers[event] = fn;
    } }),
    killFn: () => { kills++; queueMicrotask(() => handlers.exit?.(0)); return true; },
  });
  startTailscale(f.opts);
  assert.ok(kills > 0, 'catch left a spawned child without a stop signal');
  await until(() => getTailscaleStatus().state === 'off');
});

test('#965 repeated crashes keep ring output bounded and /api/health answering', async () => {
  const f = fixture('exit=1');
  const router = express.Router();
  router.get('/', healthHandler);
  const server = await mountRouter('/api/health', router);
  try {
    logger.clear();
    startTailscale(f.opts);
    await until(() => f.pids().length >= 4);
    const response = await call(`${server.url}/api/health`);
    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.ok(logger.getRecent().filter((line) => line.includes('[tailscale]')).length <= 1);
    assert.equal(isLoopbackExposed(), true);
  } finally { await server.close(); }
});
