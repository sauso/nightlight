// WEBRTC_UDP_PORT: a bare port number the app turns into MediaMTX's MTX_WEBRTCLOCALUDPADDRESS (":<port>").
//
// Why it exists (2026-10-05): the raw override needed a hand-typed leading colon and, in Unraid's
// "Add Variable" dialog, the name went into the wrong box, so staging silently stayed on :8189 and
// remote WebRTC never worked. The setting takes only the number and adds the colon itself.
//
// The ⚠️ that shapes these tests: an INVALID MTX_ value makes MediaMTX exit at startup and launch()
// retries every 3s forever, so the validator is the whole safety of the feature. Every rejected input
// below is one that MediaMTX would choke on (or that would silently bind somewhere unintended), and
// each boundary is pinned from both sides.
//
// Fixtures are written out literally on purpose: deriving the expected value from the same rule the
// code uses (e.g. `:${port}`) would make the table agree with any mutation of that rule.
import { test, describe, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { useTempDataDir, cleanupTempDataDirs } from './helpers/harness.js';

useTempDataDir();

// Same trigger as spawn-failure.test.js: an empty PATH makes `mediamtx` fail with ENOENT whatever the
// host has installed, so the launch() path under test runs without a real MediaMTX. Node reads PATH at
// spawn time and `node --test` gives each file its own process, so this cannot leak.
const emptyBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightlight-nobin-'));
process.env.PATH = emptyBinDir;

const { logger } = await import('../src/lib/logger.js');
const { resolveWebrtcUdpAddress, startMediaMTX, stopMediaMTX } = await import('../src/lib/mediamtxProcess.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const logged = (needle) => logger.getRecent().filter((l) => l.includes(needle)).length;

describe('resolveWebrtcUdpAddress: what reaches MediaMTX', () => {
  test('blank, unset or whitespace keeps the default (nothing is passed)', () => {
    for (const v of [undefined, '', '   ', '\t']) {
      const r = resolveWebrtcUdpAddress({ WEBRTC_UDP_PORT: v });
      assert.deepEqual(r, { value: null, warning: null }, `input ${JSON.stringify(v)}`);
    }
    assert.deepEqual(resolveWebrtcUdpAddress({}), { value: null, warning: null });
  });

  test('a bare number gets exactly one colon added; a pasted ":8190" and stray spaces are accepted', () => {
    assert.equal(resolveWebrtcUdpAddress({ WEBRTC_UDP_PORT: '8190' }).value, ':8190');
    assert.equal(resolveWebrtcUdpAddress({ WEBRTC_UDP_PORT: ' 8190 ' }).value, ':8190');
    assert.equal(resolveWebrtcUdpAddress({ WEBRTC_UDP_PORT: ':8190' }).value, ':8190');
    assert.equal(resolveWebrtcUdpAddress({ WEBRTC_UDP_PORT: '8190' }).warning, null);
  });

  test('both ends of the range are accepted', () => {
    assert.equal(resolveWebrtcUdpAddress({ WEBRTC_UDP_PORT: '1' }).value, ':1');
    assert.equal(resolveWebrtcUdpAddress({ WEBRTC_UDP_PORT: '65535' }).value, ':65535');
  });

  test('a leading zero is normalised, not passed through', () => {
    assert.equal(resolveWebrtcUdpAddress({ WEBRTC_UDP_PORT: '08190' }).value, ':8190');
  });

  test('anything that is not a whole port number is refused with a warning and falls back to the default', () => {
    const bad = ['0', '65536', '99999', '-1', '81.5', 'abc', '8190/udp', '0x1F', '8190:8190', '::8190', '1e3', ':', '8 190', '+8190'];
    for (const v of bad) {
      const r = resolveWebrtcUdpAddress({ WEBRTC_UDP_PORT: v });
      assert.equal(r.value, null, `${JSON.stringify(v)} must not reach MediaMTX`);
      assert.match(r.warning ?? '', /WEBRTC_UDP_PORT=.* is not a port number between 1 and 65535/, `${JSON.stringify(v)} must warn`);
    }
  });

  test('an explicit MTX_WEBRTCLOCALUDPADDRESS wins, and the ignored port is reported', () => {
    const r = resolveWebrtcUdpAddress({ WEBRTC_UDP_PORT: '8190', MTX_WEBRTCLOCALUDPADDRESS: 'fly-global-services:8189' });
    assert.equal(r.value, null, 'the raw override must be left to MediaMTX untouched');
    assert.match(r.warning, /WEBRTC_UDP_PORT=8190 ignored: MTX_WEBRTCLOCALUDPADDRESS is set/);
  });

  test('a blank MTX_WEBRTCLOCALUDPADDRESS (compose can forward an empty one) does not suppress the port', () => {
    assert.equal(resolveWebrtcUdpAddress({ WEBRTC_UDP_PORT: '8190', MTX_WEBRTCLOCALUDPADDRESS: '' }).value, ':8190');
    assert.equal(resolveWebrtcUdpAddress({ WEBRTC_UDP_PORT: '8190', MTX_WEBRTCLOCALUDPADDRESS: '  ' }).value, ':8190');
  });

  test('the raw override alone is not this function\'s business: no value, no warning', () => {
    assert.deepEqual(resolveWebrtcUdpAddress({ MTX_WEBRTCLOCALUDPADDRESS: ':9000' }), { value: null, warning: null });
  });
});

describe('launch() reports a bad port once, not on every 3s relaunch', () => {
  beforeEach(() => logger.clear());
  after(async () => {
    stopMediaMTX();
    delete process.env.WEBRTC_UDP_PORT;
    cleanupTempDataDirs();
    try { fs.rmSync(emptyBinDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  test('one warning across more than two retry intervals', async () => {
    process.env.WEBRTC_UDP_PORT = 'abc';
    await startMediaMTX(path.join(emptyBinDir, 'mediamtx.yml'));
    // Precondition (a vacuous pass is the failure mode this file's sibling documents): the warning
    // must have been logged at least once, so the case cannot pass because launch() never ran.
    const deadline = Date.now() + 15_000;
    while (logged('WEBRTC_UDP_PORT=abc is not a port number') < 1 && Date.now() < deadline) await sleep(10);
    assert.equal(logged('WEBRTC_UDP_PORT=abc is not a port number'), 1, 'launch() never reported the bad port');

    // Spans two 3s relaunches. A negative, so it has to be a real elapsed wait.
    await sleep(7000);
    assert.equal(logged('WEBRTC_UDP_PORT=abc is not a port number'), 1, 'the warning repeats on every relaunch');
  });
});
