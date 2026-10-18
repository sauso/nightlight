// lib/reloadGuard.js (#765): a COUNT of holds, each with its own release, so two screens holding the page
// against the reload-after-background rule cannot release each other's hold. The two-factor set-up panel is
// the one holder today; these pin the two properties a second holder would rely on. Each FAILS on a single
// boolean flag (the first release drops both holds) and on a release that is not idempotent (a double call
// decrements twice and drops the other holder's hold).
import { describe, test, expect, afterEach } from 'vitest';
import { holdReload, isReloadHeld } from '../src/lib/reloadGuard.js';

// The count is module state: every case releases what it took, and this checks nothing leaked between cases.
afterEach(() => { expect(isReloadHeld()).toBe(false); });

describe('reloadGuard', () => {
  test('nothing held by default; a hold holds, and its release lets go', () => {
    expect(isReloadHeld()).toBe(false);
    const release = holdReload();
    expect(isReloadHeld()).toBe(true);
    release();
    expect(isReloadHeld()).toBe(false);
  });

  test('★ two holders: releasing one keeps the other\'s hold', () => {
    const releaseA = holdReload();
    const releaseB = holdReload();
    releaseA();
    expect(isReloadHeld(), 'releasing A dropped B\'s hold').toBe(true);
    releaseB();
    expect(isReloadHeld()).toBe(false);
  });

  test('★ a release called twice does not drop another holder\'s hold', () => {
    const releaseA = holdReload();
    const releaseB = holdReload();
    releaseA();
    releaseA();
    expect(isReloadHeld(), 'the second call to A\'s release dropped B\'s hold').toBe(true);
    releaseB();
    expect(isReloadHeld()).toBe(false);
  });
});
