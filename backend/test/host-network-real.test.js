import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { detectHostNetwork } from '../src/lib/hostNetwork.js';

const FAKE = fileURLToPath(new URL('./helpers/fakeTailscaled.js', import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Linux-only: this checks real /proc socket inodes, which Windows does not expose.
test('#971 real child socket is exempt, but a test-process listener is foreign',
  { skip: process.platform !== 'linux' && '/proc is Linux-only' }, async () => {
    const markerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-971-net-'));
    const child = spawn(process.execPath, [FAKE, `--marker-dir=${markerDir}`, '--mode=listen-wildcard'],
      { stdio: 'ignore' });
    let server;
    try {
      const marker = path.join(markerDir, `listener-${child.pid}.json`);
      for (let i = 0; i < 200 && !fs.existsSync(marker); i++) await sleep(10);
      assert.ok(fs.existsSync(marker), 'child wildcard listener did not become ready');
      const owned = () => detectHostNetwork({ ownedPid: child.pid });
      assert.equal(owned().unknown, null);
      assert.equal(owned().evidence.includes('foreign_listener'), false);
      const unowned = detectHostNetwork();
      assert.equal(unowned.unknown, null);
      assert.equal(unowned.evidence.includes('foreign_listener'), true);
      server = net.createServer((socket) => socket.destroy());
      await new Promise((resolve, reject) => server.once('error', reject).listen(0, '0.0.0.0', resolve));
      assert.equal(owned().evidence.includes('foreign_listener'), true);
    } finally {
      await new Promise((resolve) => server?.close(resolve) ?? resolve());
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await new Promise((resolve) => child.once('close', resolve));
      }
      fs.rmSync(markerDir, { recursive: true, force: true });
    }
  });
