import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const config = readFileSync(new URL('../../mediamtx/mediamtx.yml', import.meta.url), 'utf8');
const entries = [...config.matchAll(/^([A-Za-z][A-Za-z0-9]*):[ \t]*([^#\r\n]*?)(?:[ \t]+#.*)?$/gm)]
  .map(([, key, value]) => [key, value.trim()]);
const settings = new Map(entries);

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

test('configured MediaMTX addresses bind to loopback except WebRTC media', () => {
  for (const [key, value] of entries.filter(([key]) => key.endsWith('Address'))) {
    if (key === 'webrtcLocalUDPAddress') continue;
    assert.match(value, /^127\.0\.0\.1:/, `${key} must bind to loopback`);
  }
});
