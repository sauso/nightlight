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

// ⚠️⚠️ PIN THE LOCALE, for the same reason vite.config.js pins the timezone: otherwise the suite
// gives a different verdict on a different machine. The app formats dates and times with an EMPTY
// locale list (`toLocaleDateString([], …)`, `new Intl.DateTimeFormat([], …)`), which means "whatever
// the runtime default is" — and that comes from the OS through ICU. vitest's `env` cannot set it:
// Node reads LANG/LC_ALL for ICU on Linux but not on Windows, so there is no environment variable
// that works in both places. Patching the two entry points is the only thing that does.
//
// ★ THIS WAS NOT THEORETICAL. Ten tests passed locally and failed in CI on exactly this: a fixture
// asserted "Play Tue, 1 Sept timelapse" (en-AU), CI renders "Tue, Sep 1" (en-US), and even the
// "locale-tolerant" regex written to survive it — `/Play .*1.*Sep.*/` — still assumed day-BEFORE-month
// and failed too. Tolerant matchers are a losing game; determinism is the fix.
//
// en-AU is chosen because it is what the deployed install uses, so pinning changes nothing about what
// the existing suite was written against. ⚠️ It does mean the suite can no longer NOTICE a hardcoded
// locale — so prefer asserting values over formatted strings where a test has the choice.
const PINNED_LOCALE = 'en-AU';
const noLocale = (l) => l === undefined || (Array.isArray(l) && l.length === 0);

// `Date.prototype.toLocale*String` does NOT route through Intl.DateTimeFormat in V8 — it has its own
// path — so both have to be patched or half the app keeps using the OS locale.
for (const method of ['toLocaleDateString', 'toLocaleTimeString', 'toLocaleString']) {
  const real = Date.prototype[method];
  Date.prototype[method] = function pinned(locales, options) {
    return real.call(this, noLocale(locales) ? PINNED_LOCALE : locales, options);
  };
}

const RealDateTimeFormat = Intl.DateTimeFormat;
function PinnedDateTimeFormat(locales, options) {
  // Callable with or without `new` — the spec allows both, and the app uses `new`.
  return new RealDateTimeFormat(noLocale(locales) ? PINNED_LOCALE : locales, options);
}
PinnedDateTimeFormat.prototype = RealDateTimeFormat.prototype;
PinnedDateTimeFormat.supportedLocalesOf = RealDateTimeFormat.supportedLocalesOf.bind(RealDateTimeFormat);
Intl.DateTimeFormat = PinnedDateTimeFormat;

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
