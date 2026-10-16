// The one function that decides whether a fetched list says "loading", "could not load" or "none yet" (#375).
// Every row below is a place a screen used to tell the wrong one.
import { describe, test, expect } from 'vitest';
import { loadState } from '../../src/lib/loadState.js';

describe('#375 loadState', () => {
  test('nothing answered yet, nothing failed: loading - never the empty copy', () => {
    expect(loadState({ loaded: false, error: '', count: 0 })).toBe('loading');
  });

  test('★ a FAILED first request is an error, not "empty" (the Children page bug)', () => {
    expect(loadState({ loaded: false, error: 'Cannot reach Nightlight', count: 0 })).toBe('error');
  });

  test('a request that succeeded with none is empty - the only state that may show setup actions', () => {
    expect(loadState({ loaded: true, error: '', count: 0 })).toBe('empty');
  });

  test('a request that succeeded with some is ready', () => {
    expect(loadState({ loaded: true, error: '', count: 3 })).toBe('ready');
  });

  test('★ a failure after a good load with a list on screen is stale: the list is kept', () => {
    expect(loadState({ loaded: true, error: 'boom', count: 2 })).toBe('stale');
  });

  test('★ a failure after a good load of an EMPTY list is an error: emptiness cannot be confirmed now', () => {
    expect(loadState({ loaded: true, error: 'boom', count: 0 })).toBe('error');
  });

  test('recovery returns to ready/empty by itself', () => {
    expect(loadState({ loaded: true, error: '', count: 0 })).toBe('empty');
    expect(loadState({ loaded: true, error: '', count: 1 })).toBe('ready');
  });

  test('a failed first request that somehow has rows (never happens) still reports the error', () => {
    // Pinned so the error branch is decided by `loaded` AND `count`, not by `count` alone.
    expect(loadState({ loaded: false, error: 'x', count: 5 })).toBe('error');
  });
});
