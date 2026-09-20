// Pins normalizeRequestPath's own contract directly. It's imported by two different security
// guards (demoMode.js's blocklist, whepOnlyGuard.js's allowlist) — this file exists so its
// behavior is verified once, in one place, rather than only observed indirectly through each
// caller's own HTTP-level tests.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRequestPath } from '../src/lib/httpPath.js';

describe('normalizeRequestPath', () => {
  test('lower-cases', () => {
    assert.equal(normalizeRequestPath('/API/Diagnostics'), '/api/diagnostics');
  });

  test('collapses an internal double slash', () => {
    assert.equal(normalizeRequestPath('/api/children//c1'), '/api/children/c1');
  });

  test('collapses a triple slash the same way', () => {
    assert.equal(normalizeRequestPath('/live///cam_x'), '/live/cam_x');
  });

  test('strips exactly one trailing slash', () => {
    assert.equal(normalizeRequestPath('/api/diagnostics/'), '/api/diagnostics');
  });

  test('strips a trailing slash left behind after collapsing a double one', () => {
    assert.equal(normalizeRequestPath('/api/diagnostics//'), '/api/diagnostics');
  });

  test('leaves a bare root alone (does not collapse it to empty string)', () => {
    assert.equal(normalizeRequestPath('/'), '/');
  });

  test('a leading double slash is also collapsed', () => {
    assert.equal(normalizeRequestPath('//api/logs'), '/api/logs');
  });

  test('is a no-op on an already-normal path', () => {
    assert.equal(normalizeRequestPath('/live/cam_x/whep'), '/live/cam_x/whep');
  });
});
