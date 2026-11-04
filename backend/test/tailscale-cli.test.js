import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnAsApp } from '../src/lib/childEnv.js';
import { runTailscaleCli, cancelTailscaleCli, getTailscaleLinks, approvedLoginUrl, validateHostname } from '../src/lib/tailscaleCli.js';

const script = fileURLToPath(new URL('./helpers/fakeTailscaleCli.js', import.meta.url));
const files = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function fixture(mode) {
  const record = path.join(os.tmpdir(), `nl-969-cli-${process.pid}-${Math.random()}.txt`);
  files.push(record);
  return { record, spawnFn: (_binary, argv, options) => spawnAsApp(process.execPath,
    [script, mode, record, ...argv], options) };
}
afterEach(async () => {
  await cancelTailscaleCli();
  for (const file of files.splice(0)) fs.rmSync(file, { force: true });
});

test('#969 login URL is approved, returned early, and a pending child is cancelled', {
  skip: process.platform === 'win32' && 'The sandbox refuses nested process spawn on win32; Linux CI runs the real CLI child',
}, async () => {
  const f = fixture('login');
  const result = await runTailscaleCli('up', { ...f, socketPath: '/tmp/private.sock', hostname: 'nightlight' });
  assert.equal(result.loginUrl, 'https://login.tailscale.com/a/approved_123');
  assert.equal(getTailscaleLinks().loginUrl, result.loginUrl);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.record, 'utf8').trim()),
    ['--socket=/tmp/private.sock', 'up', '--hostname=nightlight', '--timeout=0']);
  assert.equal((await runTailscaleCli('logout', { ...f, socketPath: '/tmp/private.sock' })).code, 'busy');
  await cancelTailscaleCli();
  assert.equal(getTailscaleLinks().loginUrl, null);
});

test('#969 hostile URLs and hostnames are rejected', () => {
  assert.equal(approvedLoginUrl('javascript:alert(1)'), null);
  for (const value of ['https://login.tailscale.com.evil/a/x', 'https://login.tailscale.com/b/x',
    'https://login.tailscale.com/a/x?next=evil', 'https://login.tailscale.com@evil.com/a/x'])
    assert.equal(approvedLoginUrl(value), null);
  for (const value of ['Private', 'two.words', '-start', 'end-', 'night_light', 'a'.repeat(64), 'x\n--advertise-routes=0'])
    assert.equal(validateHostname(value), false);
  assert.equal(validateHostname('nightlight'), true);
});

test('#969 fake CLI cannot return hostile URLs', {
  skip: process.platform === 'win32' && 'The sandbox refuses nested process spawn on win32; Linux CI runs the real CLI child',
}, async () => {
  const f = fixture('hostile');
  assert.equal((await runTailscaleCli('up', { ...f, socketPath: '/tmp/private.sock', hostname: 'nightlight' })).code, 'cli_failed');
});

test('#969 output and runtime are bounded; garbage status is harmless', {
  skip: process.platform === 'win32' && 'The sandbox refuses nested process spawn on win32; Linux CI runs the real CLI child',
}, async () => {
  for (const [mode, code, timeoutMs] of [['huge', 'output_limit', 1000], ['hang', 'timeout', 30], ['garbage', 'invalid_status', 1000]]) {
    const f = fixture(mode);
    const result = await runTailscaleCli('status', { ...f, socketPath: '/tmp/private.sock', timeoutMs });
    assert.equal(result.code, code, mode);
  }
});

test('#969 mutations serialise and Serve uses the exact private argv', {
  skip: process.platform === 'win32' && 'The sandbox refuses nested process spawn on win32; Linux CI runs the real CLI child',
}, async () => {
  const pending = fixture('login');
  await runTailscaleCli('up', { ...pending, socketPath: '/tmp/private.sock', hostname: 'nightlight' });
  const f = fixture('status');
  assert.equal((await runTailscaleCli('serve-set', { ...f, socketPath: '/tmp/private.sock' })).code, 'busy');
  await cancelTailscaleCli();
  assert.equal((await runTailscaleCli('serve-set', { ...f, socketPath: '/tmp/private.sock' })).ok, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.record, 'utf8').trim()),
    ['--socket=/tmp/private.sock', 'serve', '--bg', '--https=443', 'http://127.0.0.1:4000']);
  assert.equal((await runTailscaleCli('set-hostname', { ...f, socketPath: '/tmp/private.sock', hostname: 'bad.name' })).code, 'invalid_command');
  await sleep(1);
});

test('#969 Serve consent link is vetted for admin retry', {
  skip: process.platform === 'win32' && 'The sandbox refuses nested process spawn on win32; Linux CI runs the real CLI child',
}, async () => {
  const f = fixture('consent');
  const result = await runTailscaleCli('serve-set', { ...f, socketPath: '/tmp/private.sock' });
  assert.equal(result.code, 'consent_required');
  assert.equal(result.consentUrl, 'https://login.tailscale.com/admin/feature/serve');
});
