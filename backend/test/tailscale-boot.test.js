import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { bootTailscale } from '../src/lib/tailscaleBoot.js';
import { useTempDataDir, cleanupTempDataDirs, makeUser } from './helpers/harness.js';

const dataDir = useTempDataDir();
const { default: db } = await import('../src/db.js');
after(() => { db.close(); cleanupTempDataDirs(); });

const safe = { host: false, evidence: [], unknown: null };
test('#967 boot starts once only for persisted intent and logs fixed codes', () => {
  const lines = []; const starts = [];
  const log = { info: (s) => lines.push(s), warn: (s) => lines.push(s) };
  db.prepare("UPDATE settings SET tailscale_enabled = 0 WHERE id = 'app'").run();
  bootTailscale({ db, dataDir, detector: () => safe,
    start: (args) => starts.push(args), log });
  assert.equal(starts.length, 0);
  db.prepare("UPDATE settings SET tailscale_enabled = 1 WHERE id = 'app'").run();
  bootTailscale({ db, dataDir, detector: () => safe,
    start: (args) => starts.push(args), log });
  assert.equal(starts.length, 1);
  assert.deepEqual(starts[0], { db, dataDir });
});

test('#967 boot detector and database throws never escape', () => {
  const db = { prepare: () => { throw Error('private path'); } };
  const log = { info: () => {}, warn: () => {} };
  assert.doesNotThrow(() => bootTailscale({ db, detector: () => safe, log }));
  assert.doesNotThrow(() => bootTailscale({ db, detector: () => { throw Error('interface secret'); }, log }));
});

test('#967 boot with host networking or no admin is unavailable without spawning', async () => {
  const { startTailscale, stopTailscale, getTailscaleStatus } = await import('../src/lib/tailscaleProcess.js');
  db.prepare("UPDATE settings SET tailscale_enabled = 1 WHERE id = 'app'").run();
  makeUser(db, { id: 'boot-admin', username: 'boot-admin' });
  let spawns = 0;
  const startWith = (hostNetwork) => (args) => startTailscale({ ...args, hostNetwork,
    binaryPath: process.execPath, spawnFn: () => { spawns++; throw Error('should not spawn'); } });
  const log = { info: () => {}, warn: () => {} };
  bootTailscale({ db, dataDir, detector: () => ({ host: true, evidence: ['bridge_dir'], unknown: null }),
    start: startWith({ host: true, evidence: ['bridge_dir'], unknown: null }), log });
  assert.equal(getTailscaleStatus().reason, 'host_network');
  await stopTailscale();
  db.prepare("DELETE FROM users WHERE id = 'boot-admin'").run();
  bootTailscale({ db, dataDir, detector: () => safe, start: startWith(safe), log });
  assert.equal(getTailscaleStatus().reason, 'no_admin');
  assert.equal(spawns, 0);
  await stopTailscale();
});

test('#967 index mounts the route first and boots only after markBootComplete in listen callback', () => {
  const src = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  const listen = src.indexOf('app.listen(PORT, () => {');
  const mark = src.indexOf('markBootComplete();', listen);
  const boot = src.indexOf('bootTailscale({ db, dataDir: DATA_DIR });', listen);
  assert.ok(listen >= 0 && mark > listen && boot > mark);
  assert.ok(src.indexOf("app.use('/api/remote-access/tailscale', tailscaleRoutes);") <
    src.indexOf("app.use('/api/remote-access', remoteAccessRoutes);"));
});
