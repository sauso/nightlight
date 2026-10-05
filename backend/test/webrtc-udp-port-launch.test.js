// What the MediaMTX CHILD actually receives for WEBRTC_UDP_PORT.
//
// webrtc-udp-port.test.js pins the conversion (resolveWebrtcUdpAddress) but, as the adversarial review of
// this change demonstrated, not the hand-off: deleting the line in launch() that copies the validated value
// into the child's environment left every one of those tests green, while the setting silently did nothing
// (exactly the symptom that started this: MediaMTX stayed on :8189). So this file drives launch() with a
// fake spawn and reads the env the child was given.
//
// mock.module('node:child_process') is safe here: mediamtxProcess.js is not in test:core's include list, and
// this is the only file in its import graph that touches child_process. Same pattern as
// detector-observation-wiring.test.js, and the same FakeFfmpeg stand-in (it has the pid killIfSpawned needs).
import { test, describe, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupTempDataDirs } from './helpers/harness.js';
import { FakeFfmpeg } from './helpers/fakeFfmpeg.js';

useTempDataDir();

const spawned = [];
mock.module('node:child_process', {
  exports: {
    spawn(command, args, options) {
      const proc = new FakeFfmpeg(command, args);
      spawned.push({ command, args, env: options?.env });
      return proc;
    },
  },
});

const { startMediaMTX, stopMediaMTX } = await import('../src/lib/mediamtxProcess.js');

const KEYS = ['WEBRTC_UDP_PORT', 'MTX_WEBRTCLOCALUDPADDRESS'];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

// Launch once with the given environment and return the env the MediaMTX child was handed.
async function childEnvFor(vars) {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, vars);
  spawned.length = 0;
  await startMediaMTX('mediamtx.yml');
  assert.equal(spawned.length, 1, 'launch() never reached spawn — this case would pass vacuously');
  assert.equal(spawned[0].command, 'mediamtx');
  stopMediaMTX();
  return spawned[0].env;
}

beforeEach(() => {
  for (const k of KEYS) delete process.env[k];
});

after(() => {
  stopMediaMTX();
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  cleanupTempDataDirs();
});

describe('the MediaMTX child gets the WebRTC UDP port', () => {
  test('a valid WEBRTC_UDP_PORT reaches the child as MTX_WEBRTCLOCALUDPADDRESS=":<port>"', async () => {
    const env = await childEnvFor({ WEBRTC_UDP_PORT: '8190' });
    assert.equal(env.MTX_WEBRTCLOCALUDPADDRESS, ':8190');
  });

  test('a pasted ":8190" reaches the child with exactly one colon', async () => {
    const env = await childEnvFor({ WEBRTC_UDP_PORT: ':8190' });
    assert.equal(env.MTX_WEBRTCLOCALUDPADDRESS, ':8190');
  });

  test('blank leaves the child alone, so MediaMTX keeps the mediamtx.yml default', async () => {
    const env = await childEnvFor({ WEBRTC_UDP_PORT: '' });
    assert.equal(env.MTX_WEBRTCLOCALUDPADDRESS, undefined);
  });

  test('an invalid value is NOT handed to MediaMTX (it would exit and restart every 3s)', async () => {
    const env = await childEnvFor({ WEBRTC_UDP_PORT: '99999' });
    assert.equal(env.MTX_WEBRTCLOCALUDPADDRESS, undefined);
  });

  test('an explicit MTX_WEBRTCLOCALUDPADDRESS reaches the child untouched and wins over the port', async () => {
    const env = await childEnvFor({ WEBRTC_UDP_PORT: '8190', MTX_WEBRTCLOCALUDPADDRESS: 'fly-global-services:8189' });
    assert.equal(env.MTX_WEBRTCLOCALUDPADDRESS, 'fly-global-services:8189');
  });

  test('an existing install that only sets the raw override is unchanged', async () => {
    const env = await childEnvFor({ MTX_WEBRTCLOCALUDPADDRESS: ':9000' });
    assert.equal(env.MTX_WEBRTCLOCALUDPADDRESS, ':9000');
  });
});
