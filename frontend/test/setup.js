import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// Opt-in "as if it were later" run (issue #570): `NIGHTLIGHT_CLOCK_SHIFT_DAYS=365 npm test` moves
// `new Date()` / `Date.now()` a year ahead (or to an ISO instant), and NIGHTLIGHT_CLOCK_TZ changes the
// zone, to find fixtures with a shelf life BEFORE the calendar does. Dynamic and conditional on purpose:
// the ordinary run, and the coverage gate, must not load it. Everything about what moves and what does
// not is in scripts/clock-shift.mjs.
if (process.env.NIGHTLIGHT_CLOCK_SHIFT_DAYS) await import('../../scripts/clock-shift.mjs');

// Opt-in "slow server" run (issue #570): `NIGHTLIGHT_TEST_LATENCY_MS=10 npm test` makes every
// `vi.spyOn(api, 'get').mockResolvedValue(x)` settle after a real 10 ms instead of in a microtask.
//
// WHY. A mocked request that settles instantly hides a whole family of tests that are RACES: they find a
// control, then read it or click it before the data it depends on has arrived. A form renders empty and
// disabled, `findByLabelText` resolves at once, `.value` is read straight away — and it passes only
// because the mock beat the assertion. On a loaded CI runner it does not always (settingsSecrets "loads
// the stored broker details" went red that way). Measured 2026-10-09: with 10 ms, eleven tests failed;
// they are fixed (the wait is now for the VALUE, or for the button to ENABLE — see `enabledButton` in
// helpers/render.jsx) and this keeps the next one from growing back unnoticed.
// Only `mockResolvedValue` on a spy is delayed: promises made some other way, fake-timer tests and
// rejections are untouched, so a failure here is a test that depends on timing it did not state.
// ⚠️ KNOWN LIMIT: the suite holds at 10 ms (CI went red at 10 ms on four more tests that local runs missed after the first dozen were
// fixed: a test that ends before its PUT resolves leaks into the next one). At 25 ms "mediaCards reloads on the nonce" fails, at 40 ms ten (cameras reassign,
// settingsPush x7, mediaCards refresh nonce): not a claim about every latency.
const LATENCY_MS = Number(process.env.NIGHTLIGHT_TEST_LATENCY_MS) || 0;
if (LATENCY_MS > 0) {
  const realSpyOn = vi.spyOn.bind(vi);
  vi.spyOn = (obj, method, ...rest) => {
    const spy = realSpyOn(obj, method, ...rest);
    if (spy && typeof spy.mockResolvedValue === 'function') {
      spy.mockResolvedValue = (value) =>
        spy.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(value), LATENCY_MS)));
    }
    return spy;
  };
}

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
