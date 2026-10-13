// `hasUnsavedEdits` (src/lib/unsavedEdits.js): the comparison behind "Send test is held back while the form
// has unsaved edits" on the push provider pages (#396).
//
// Kept apart from pushSendTestUnsaved.test.jsx on purpose: that file proves the PAGES' behaviour and must not
// import this helper, or against the old source (where the helper does not exist) the whole file would die at
// import and never exercise the old button, which is the one thing a red-on-old run is for.
import { describe, test, expect } from 'vitest';
import { hasUnsavedEdits, UNSAVED_TEST_HINT } from '../src/lib/unsavedEdits.js';

describe('hasUnsavedEdits', () => {
  const saved = { a: 'x', n: 5, flag: false, nothing: null, enabled: true };

  test('identical objects are clean, and so is a fresh copy', () => {
    expect(hasUnsavedEdits(saved, saved)).toBe(false);
    expect(hasUnsavedEdits({ ...saved }, saved)).toBe(false);
  });

  test('any changed key is an edit', () => {
    expect(hasUnsavedEdits({ ...saved, a: 'y' }, saved)).toBe(true);
    expect(hasUnsavedEdits({ ...saved, flag: true }, saved)).toBe(true);
  });

  test('a toggled boolean (the Enable switch) is an edit, and toggling it back is not', () => {
    expect(hasUnsavedEdits({ ...saved, enabled: false }, saved)).toBe(true);
    expect(hasUnsavedEdits({ ...saved, enabled: true }, saved)).toBe(false);
  });

  test('a number and the same number as a string are the same value', () => {
    expect(hasUnsavedEdits({ ...saved, n: '5' }, saved)).toBe(false);
    expect(hasUnsavedEdits({ ...saved, n: '6' }, saved)).toBe(true);
  });

  test('null, undefined and empty string are the same "nothing", but 0 is not nothing', () => {
    expect(hasUnsavedEdits({ ...saved, nothing: '' }, saved)).toBe(false);
    expect(hasUnsavedEdits({ ...saved, nothing: undefined }, saved)).toBe(false);
    expect(hasUnsavedEdits({ ...saved, nothing: 0 }, saved)).toBe(true);
    expect(hasUnsavedEdits({ k: 0 }, { k: null })).toBe(true);
    expect(hasUnsavedEdits({ k: 0 }, { k: 0 })).toBe(false);
  });

  test('any non-empty secret is an edit; empty, null and undefined are not', () => {
    expect(hasUnsavedEdits(saved, saved, ['', null, undefined])).toBe(false);
    expect(hasUnsavedEdits(saved, saved, ['', 'tok'])).toBe(true);
    expect(hasUnsavedEdits(saved, saved, [' '])).toBe(true);
  });

  test('nothing to compare against is clean, not an error', () => {
    expect(hasUnsavedEdits(null, saved)).toBe(false);
    expect(hasUnsavedEdits(saved, null)).toBe(false);
  });

  test('the hint tells the person to save first and names what Send test uses', () => {
    expect(UNSAVED_TEST_HINT).toMatch(/Save your changes first/);
    expect(UNSAVED_TEST_HINT).toMatch(/last saved/);
  });
});
