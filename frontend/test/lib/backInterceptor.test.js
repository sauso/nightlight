// lib/backInterceptor.js: one screen at a time may take the Android Back button for itself (the TV screen's full-screen tile).
import { afterEach, expect, test } from 'vitest';
import { offerBackToScreen, setBackHandler } from '../../src/lib/backInterceptor.js';

let off = () => {};
afterEach(() => off());

test('with no handler registered Back is not taken', () => {
  expect(offerBackToScreen()).toBe(false);
});

test('a handler that returns true takes Back; one that returns anything else does not', () => {
  off = setBackHandler(() => true);
  expect(offerBackToScreen()).toBe(true);
  off();
  for (const answer of [false, undefined, null, 1, 'yes']) {
    off = setBackHandler(() => answer);
    expect(offerBackToScreen(), String(answer)).toBe(false);
    off();
  }
});

test('a handler that throws does not take Back (a broken screen must not trap the app)', () => {
  off = setBackHandler(() => { throw new Error('boom'); });
  expect(offerBackToScreen()).toBe(false);
});

test('unregistering removes the handler, and only if it is still the registered one', () => {
  const first = () => true;
  const second = () => true;
  const offFirst = setBackHandler(first);
  const offSecond = setBackHandler(second); // replaces the first
  offFirst(); // a stale unregister must not remove the newer registration
  expect(offerBackToScreen()).toBe(true);
  offSecond();
  expect(offerBackToScreen()).toBe(false);
});
