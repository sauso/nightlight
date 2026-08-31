import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// jsdom has no layout engine and no media stack, so a few browser APIs the app legitimately uses
// simply do not exist. Stub the ones whose absence would throw during a render — never the ones whose
// BEHAVIOUR is under test.

// ⚠️ THIS ONE MUST BE AT MODULE SCOPE, NOT IN beforeEach.
// `src/lib/theme.js` calls window.matchMedia at IMPORT time (module top level), and a test file's
// imports are resolved before any hook runs — so a stub installed in beforeEach arrives too late and
// the import throws "window.matchMedia is not a function" before a single test starts. Anything the
// app touches while modules are being evaluated has to be stubbed here.
// It is a plain function rather than a vi.fn(), so afterEach's restoreAllMocks leaves it alone and it
// survives for the whole run.
window.matchMedia = window.matchMedia || ((query) => ({
  matches: false, media: query, onchange: null,
  addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  addListener: () => {}, removeListener: () => {},
}));

beforeEach(() => {
  // These are re-applied per test because afterEach's restoreAllMocks strips vi.fn() implementations.
  window.HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
  window.HTMLMediaElement.prototype.pause = vi.fn();
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  if (!window.ResizeObserver) {
    window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  }
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});
