import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { MEDIAMTX_API, MEDIAMTX_INTERNAL_HOST, mediamtxRtspUrl } from '../src/lib/mediamtx.js';

const config = readFileSync(new URL('../../mediamtx/mediamtx.yml', import.meta.url), 'utf8');
const entries = [...config.matchAll(/^([A-Za-z][A-Za-z0-9]*):[ \t]*([^#\r\n]*?)(?:[ \t]+#.*)?$/gm)]
  .map(([, key, value]) => [key, value.trim()]);
const settings = new Map(entries);

test('internal MediaMTX URL defaults use the same host', () => {
  assert.equal(MEDIAMTX_INTERNAL_HOST, '127.0.0.2');
  assert.equal(mediamtxRtspUrl('cam_test'), 'rtsp://127.0.0.2:8554/cam_test');
  assert.equal(MEDIAMTX_API, 'http://127.0.0.2:9997');
  // index.js starts the application on import, so inspect the two proxy default expressions here.
  const index = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.match(index, /MEDIAMTX_WEBRTC_URL\s*\|\|\s*`http:\/\/\$\{MEDIAMTX_INTERNAL_HOST\}:8889`/);
  assert.match(index, /MEDIAMTX_HLS_URL\s*\|\|\s*`http:\/\/\$\{MEDIAMTX_INTERNAL_HOST\}:8888`/);
});

test('unused MediaMTX listeners stay disabled', () => {
  // #952: MediaMTX 1.21.3 enabled MoQ on all interfaces by default on 2026-11-03.
  for (const key of ['moq', 'metrics', 'pprof', 'playback']) {
    assert.match(settings.get(key) ?? '', /^(?:no|false)$/i, `${key} must be explicitly off`);
  }
});

test('the MediaMTX addresses are all present (a missing key falls back to bind-all)', () => {
  // Review of PR #953: the check below passed when every address line was deleted, which would hand each
  // enabled service MediaMTX's default (all interfaces).
  for (const key of ['rtspAddress', 'apiAddress', 'webrtcAddress', 'hlsAddress', 'webrtcLocalUDPAddress']) {
    assert.ok(settings.has(key), `${key} must be set explicitly`);
  }
});

test('configured MediaMTX addresses bind to the internal host except WebRTC media', () => {
  for (const [key, value] of entries.filter(([key]) => key.endsWith('Address'))) {
    if (key === 'webrtcLocalUDPAddress') continue;
    assert.match(value, /^127\.0\.0\.2:/, `${key} must bind to the internal host`);
  }
});

test('RTSP only uses TCP so MediaMTX does not open its UDP media listeners', () => {
  assert.equal(settings.get('rtspTransports'), '[tcp]');
});
