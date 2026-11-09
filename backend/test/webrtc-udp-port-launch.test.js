// What the MediaMTX CHILD actually receives for WEBRTC_UDP_PORT.
//
// webrtc-udp-port.test.js pins the conversion (resolveWebrtcUdpAddress) but, as the adversarial review of
// this change demonstrated, not the hand-off: deleting the line in launch() that copies the validated value
// into the child's environment left every one of those tests green, while the setting silently did nothing
// (exactly the symptom that started this: MediaMTX stayed on :8189). So this file drives launch() with a
// fake spawn and reads the env the child was given.
//
// mock.module('node:child_process') is safe here: mediamtxProcess.js is not in test:core's include list, and
// it reaches child_process only through lib/childEnv.js (#553), which is not in that list either. So the fake
// sees the env childEnv() really built, and `env` below is what the child would get. Same pattern as
// detector-observation-wiring.test.js, and the same FakeFfmpeg stand-in (it has the pid killIfSpawned needs).
import { test, describe, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { networkInterfaces } from 'node:os';
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

const { startMediaMTX, stopMediaMTX, getLastAdvertisedHosts } = await import('../src/lib/mediamtxProcess.js');

// PUBLIC_HOST and MTX_WEBRTCADDITIONALHOSTS are cleared too, so the host-list cases below see only what they set.
const KEYS = ['WEBRTC_UDP_PORT', 'MTX_WEBRTCLOCALUDPADDRESS', 'PUBLIC_HOST', 'MTX_WEBRTCADDITIONALHOSTS'];
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

// #553: since the child no longer inherits everything, the advertised host list reaches MediaMTX only because
// launch() puts it in `extra`, and an operator's (or a stale) MTX_WEBRTCADDITIONALHOSTS is inherited by
// childEnv({ mediamtx: true }) underneath it. child-env.test.js pins the merge order with a literal `extra`;
// only driving launch() shows the computed value is put there at all. A review found two mutants of that one
// line surviving: the assignment made conditional on no inherited value, and the assignment removed.
describe('#553 the MediaMTX child gets the host list computed at launch', () => {
  // The same filter detectHostIPv4s() applies, so the expectation holds on any machine (CI runner or laptop).
  const detected = () => Object.values(networkInterfaces()).flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal).map((a) => a.address);
  const computed = (publicHost) => [...new Set([publicHost, ...detected()])].join(',');

  test('PUBLIC_HOST and the detected IPs reach the child as MTX_WEBRTCADDITIONALHOSTS', async () => {
    const env = await childEnvFor({ PUBLIC_HOST: 'nightlight.example' });
    assert.equal(env.MTX_WEBRTCADDITIONALHOSTS, computed('nightlight.example'));
    assert.deepEqual(getLastAdvertisedHosts({ PUBLIC_HOST: 'changed.example' }), env.MTX_WEBRTCADDITIONALHOSTS.split(','));
  });

  test('a stale inherited MTX_WEBRTCADDITIONALHOSTS is replaced by the computed value, not passed through', async () => {
    const env = await childEnvFor({ PUBLIC_HOST: 'nightlight.example', MTX_WEBRTCADDITIONALHOSTS: 'stale.example' });
    assert.equal(env.MTX_WEBRTCADDITIONALHOSTS, computed('nightlight.example'));
    assert.doesNotMatch(env.MTX_WEBRTCADDITIONALHOSTS, /stale/);
  });
});
