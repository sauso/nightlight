// Page zoom: relaxed in a browser, untouched in the native app (#562 bullet 3).
//
// The fixture is the REAL viewport string from index.html, read from disk, so a change there is tested as
// shipped. Every case asserts the exact resulting string, not "does not contain": a rewrite that drops
// `viewport-fit=cover` (the safe-area insets depend on it) or reorders tokens must fail too.
//
// Three outcomes (owner decision 2026-10-13): native app = untouched; Android/desktop browser = both locking
// tokens removed; iOS/iPadOS browser = only `user-scalable` removed, `maximum-scale=1` kept (WebKit pinch-zooms
// regardless, and the token stops Safari zooming into a focused 15px field). See src/lib/viewport.js.
//
// ⚠️ NOT COVERED: whether a real browser or Android WebView honours a viewport meta changed after load, and
// whether iOS Safari really stops zooming into a field with `maximum-scale=1`. jsdom only stores the attribute
// and the navigator values are stubbed. Checking either needs a device (stated in the PR as not done).
import { describe, test, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { applyViewportPolicy, relaxedViewportContent, isIosBrowser } from '../../src/lib/viewport.js';
import * as nativeBridge from '../../src/lib/nativeBridge.js';

// `process.cwd()` is the frontend folder (vitest runs from there); under jsdom `import.meta.url` is not a file: URL,
// so a lookup relative to this file throws.
const INDEX_HTML = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
const SHIPPED = /<meta name="viewport" content="([^"]*)"/.exec(INDEX_HTML)?.[1];
const RELAXED = 'width=device-width, initial-scale=1, viewport-fit=cover';
const IOS_RELAXED = 'width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover';

// Real user agents (Safari 17 on iPhone and on iPadOS, Chrome on Android, Windows and macOS), plus the
// platform/maxTouchPoints each device reports.
const UA = {
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  ipadOld: 'Mozilla/5.0 (iPad; CPU OS 12_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1 Mobile/15E148 Safari/604.1',
  ipod: 'Mozilla/5.0 (iPod; CPU OS 9_3 like Mac OS X) AppleWebKit/601.1.46 (KHTML, like Gecko) Version/9.0 Mobile/13E233 Safari/601.1',
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
};
const NAV = {
  // platform is deliberately NOT 'MacIntel' for the UA-named devices, so the UA test alone has to carry them.
  iphone: { userAgent: UA.iphone, platform: 'iPhone', maxTouchPoints: 5 },
  ipadOld: { userAgent: UA.ipadOld, platform: 'iPad', maxTouchPoints: 5 },
  ipod: { userAgent: UA.ipod, platform: 'iPod', maxTouchPoints: 5 },
  // iPadOS 13+ Safari: a Mac user agent, told apart only by the touch screen.
  ipadAsMac: { userAgent: UA.mac, platform: 'MacIntel', maxTouchPoints: 5 },
  mac: { userAgent: UA.mac, platform: 'MacIntel', maxTouchPoints: 0 },
  // The boundary: one touch point is a desktop Mac (some report 1), two is an iPad.
  macOneTouch: { userAgent: UA.mac, platform: 'MacIntel', maxTouchPoints: 1 },
  ipadAsMacTwoTouch: { userAgent: UA.mac, platform: 'MacIntel', maxTouchPoints: 2 },
  macNoTouchField: { userAgent: UA.mac, platform: 'MacIntel' },
  // Touch screens that are not Macs: a rule reading only maxTouchPoints would call these iOS.
  android: { userAgent: UA.android, platform: 'Linux armv81', maxTouchPoints: 5 },
  windows: { userAgent: UA.windows, platform: 'Win32', maxTouchPoints: 10 },
};

// Stub the GLOBAL navigator (what isIosBrowser() reads by default) with own properties, removed again after
// each test so the prototype's values come back.
const stubbed = [];
function stubNavigator(values) {
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(globalThis.navigator, key, { configurable: true, get: () => value });
    stubbed.push(key);
  }
}

function docWith(...metas) {
  const doc = document.implementation.createHTMLDocument('t');
  for (const [name, content] of metas) {
    const m = doc.createElement('meta');
    m.setAttribute('name', name);
    if (content !== undefined) m.setAttribute('content', content);
    doc.head.appendChild(m);
  }
  return doc;
}
const viewportOf = (doc) => [...doc.querySelectorAll('meta[name="viewport"]')].map((m) => m.getAttribute('content'));

afterEach(() => {
  vi.restoreAllMocks();
  for (const key of stubbed.splice(0)) delete globalThis.navigator[key];
  for (const m of document.head.querySelectorAll('meta[name="viewport"]')) m.remove();
});

describe('#562 viewport the fixture is what index.html ships', () => {
  test('#562 viewport fixture: index.html still ships the locked string, with both locking tokens', () => {
    // Guards the tests below: against a meta that never held the tokens, "removed them" would pass vacuously.
    expect(SHIPPED).toBe('width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover');
  });
});

describe('#562 viewport browser: the two locking tokens go, nothing else changes', () => {
  test('#562 viewport browser: the shipped string becomes exactly the relaxed one', () => {
    const doc = docWith(['viewport', SHIPPED]);
    expect(applyViewportPolicy(doc, false, false)).toBe(true);
    expect(viewportOf(doc)).toEqual([RELAXED]);
  });

  test('#562 viewport browser: every other token is kept verbatim and in order, including ones that also end in -scale', () => {
    const doc = docWith(['viewport',
      'height=device-height, minimum-scale=0.5, maximum-scale=1, initial-scale=2, user-scalable=0, interactive-widget=resizes-content, viewport-fit=cover']);
    applyViewportPolicy(doc, false, false);
    expect(viewportOf(doc)).toEqual([
      'height=device-height, minimum-scale=0.5, initial-scale=2, interactive-widget=resizes-content, viewport-fit=cover',
    ]);
  });

  test('#562 viewport browser: spacing, case, ; separators and empty tokens do not hide a locking token', () => {
    const doc = docWith(['viewport', ' width=device-width ,  Maximum-Scale = 1 ;USER-SCALABLE=no;;viewport-fit=cover, ']);
    applyViewportPolicy(doc, false, false);
    expect(viewportOf(doc)).toEqual(['width=device-width, viewport-fit=cover']);
  });

  test('#562 viewport browser: whitespace separates settings as in Blink, alone or mixed with , and ; (fix round 1)', () => {
    // A browser reads `width=device-width maximum-scale=1 user-scalable=no` as three settings. A comma-only split
    // saw one, matched no locking name, and left the page locked.
    const cases = [
      // [content, Android/desktop result, iOS result]
      ['width=device-width maximum-scale=1 user-scalable=no', 'width=device-width', 'width=device-width, maximum-scale=1'],
      ['width=device-width\tinitial-scale=1\nmaximum-scale=1  user-scalable=no viewport-fit=cover',
        'width=device-width, initial-scale=1, viewport-fit=cover', 'width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover'],
      ['width=device-width,initial-scale=1 maximum-scale=1;user-scalable=no\tviewport-fit=cover',
        'width=device-width, initial-scale=1, viewport-fit=cover', 'width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover'],
      // Spaces around `=` with whitespace separators: each setting is kept as written.
      ['width = device-width user-scalable = no initial-scale = 1', 'width = device-width, initial-scale = 1', 'width = device-width, initial-scale = 1'],
      // A stray `=` where a name should start is a separator to Blink, so this IS a lock and must go.
      ['width=device-width, =user-scalable=no, =maximum-scale=1', 'width=device-width', 'width=device-width, maximum-scale=1'],
    ];
    for (const [content, browser, ios] of cases) {
      expect(relaxedViewportContent(content, false), content).toBe(browser);
      expect(relaxedViewportContent(content, true), `${content} (iOS)`).toBe(ios);
    }
  });

  test('#562 viewport browser: a name with `=` but no value is kept as written, without the spaces after it', () => {
    expect(relaxedViewportContent('width=device-width, foo = , user-scalable=no, viewport-fit=cover'))
      .toBe('width=device-width, foo =, viewport-fit=cover');
  });

  test('#562 viewport browser: the shipped comma-separated string gives exactly the same result as before fix round 1', () => {
    expect(relaxedViewportContent(SHIPPED)).toBe(RELAXED);
    expect(relaxedViewportContent(SHIPPED, true)).toBe(IOS_RELAXED);
  });

  test('#562 viewport browser: idempotent, a second run changes nothing and says so', () => {
    const doc = docWith(['viewport', SHIPPED]);
    applyViewportPolicy(doc, false, false);
    expect(applyViewportPolicy(doc, false, false)).toBe(false);
    expect(viewportOf(doc)).toEqual([RELAXED]);
    expect(relaxedViewportContent(relaxedViewportContent(SHIPPED))).toBe(RELAXED);
  });

  test('#562 viewport browser: no viewport meta is a no-op, and a meta that is not the viewport is never touched', () => {
    const none = docWith();
    expect(applyViewportPolicy(none, false, false)).toBe(false);
    expect(none.head.querySelectorAll('meta')).toHaveLength(0);
    // Hostile: another meta whose content LOOKS like a locked viewport.
    const doc = docWith(['description', SHIPPED], ['viewport', SHIPPED], ['theme-color', '#12172B']);
    applyViewportPolicy(doc, false, false);
    expect(doc.querySelector('meta[name="description"]').getAttribute('content')).toBe(SHIPPED);
    expect(doc.querySelector('meta[name="theme-color"]').getAttribute('content')).toBe('#12172B');
    expect(viewportOf(doc)).toEqual([RELAXED]);
    // A viewport meta with no content attribute gains none.
    const bare = docWith(['viewport']);
    expect(applyViewportPolicy(bare, false, false)).toBe(false);
    expect(bare.querySelector('meta[name="viewport"]').hasAttribute('content')).toBe(false);
  });

  test('#562 viewport browser: every viewport meta is relaxed, not only the first', () => {
    const doc = docWith(['viewport', SHIPPED], ['viewport', 'width=device-width, user-scalable=no']);
    applyViewportPolicy(doc, false, false);
    expect(viewportOf(doc)).toEqual([RELAXED, 'width=device-width']);
  });
});

describe('#562 viewport ios: an iOS browser keeps maximum-scale and loses only user-scalable', () => {
  test('#562 viewport ios: the shipped string keeps maximum-scale=1 and loses user-scalable=no', () => {
    const doc = docWith(['viewport', SHIPPED]);
    expect(applyViewportPolicy(doc, false, true)).toBe(true);
    expect(viewportOf(doc)).toEqual([IOS_RELAXED]);
    // Idempotent on iOS too.
    expect(applyViewportPolicy(doc, false, true)).toBe(false);
    expect(relaxedViewportContent(IOS_RELAXED, true)).toBe(IOS_RELAXED);
  });

  test('#562 viewport ios: spacing and case do not hide user-scalable, and maximum-scale is kept as written', () => {
    const doc = docWith(['viewport', ' width=device-width ,  Maximum-Scale = 1 ;USER-SCALABLE=no;;viewport-fit=cover, ']);
    applyViewportPolicy(doc, false, true);
    expect(viewportOf(doc)).toEqual(['width=device-width, Maximum-Scale = 1, viewport-fit=cover']);
  });

  test('#562 viewport ios: the native x iOS table', () => {
    const cases = [
      // [native, ios, expected]
      [true, true, SHIPPED],
      [true, false, SHIPPED],
      [false, true, IOS_RELAXED],
      [false, false, RELAXED],
    ];
    for (const [native, ios, expected] of cases) {
      const doc = docWith(['viewport', SHIPPED]);
      applyViewportPolicy(doc, native, ios);
      expect(viewportOf(doc), `native=${native} ios=${ios}`).toEqual([expected]);
    }
  });
});

describe('#562 viewport native: the app keeps the lock', () => {
  test('#562 viewport native: the shipped string is left exactly as it is, separators included', () => {
    const doc = docWith(['viewport', SHIPPED]);
    expect(applyViewportPolicy(doc, true, false)).toBe(false);
    expect(viewportOf(doc)).toEqual([SHIPPED]);
    const odd = docWith(['viewport', 'width=device-width,maximum-scale=1;user-scalable=no']);
    applyViewportPolicy(odd, true, false);
    expect(viewportOf(odd)).toEqual(['width=device-width,maximum-scale=1;user-scalable=no']);
  });
});

describe('#562 viewport isIosBrowser: which devices count as iOS', () => {
  test('#562 viewport isIosBrowser: iPhone, iPad, iPod and iPadOS-reporting-a-Mac (2 or more touch points) are iOS', () => {
    for (const k of ['iphone', 'ipadOld', 'ipod', 'ipadAsMac', 'ipadAsMacTwoTouch']) expect(isIosBrowser(NAV[k]), k).toBe(true);
  });

  test('#562 viewport isIosBrowser: a real Mac (0 or 1 touch points), Android, Windows and touch screens that are not Macs are not', () => {
    for (const k of ['mac', 'macOneTouch', 'macNoTouchField', 'android', 'windows']) expect(isIosBrowser(NAV[k]), k).toBe(false);
  });

  test('#562 viewport isIosBrowser: no navigator at all, or one with nothing in it, is not iOS', () => {
    expect(isIosBrowser(null)).toBe(false);
    expect(isIosBrowser({})).toBe(false);
  });

  test('#562 viewport isIosBrowser: with no argument it reads the global navigator', () => {
    stubNavigator(NAV.ipadAsMac);
    expect(isIosBrowser()).toBe(true);
    stubNavigator(NAV.windows);
    expect(isIosBrowser()).toBe(false);
  });
});

describe('#562 viewport defaults: the global document, the real native check and the real iOS check', () => {
  const addShipped = () => {
    const m = document.createElement('meta');
    m.setAttribute('name', 'viewport');
    m.setAttribute('content', SHIPPED);
    document.head.appendChild(m);
  };

  test('#562 viewport defaults: with no arguments, an Android browser relaxes the page\'s own meta fully', () => {
    vi.spyOn(nativeBridge, 'isNativeApp').mockReturnValue(false);
    stubNavigator(NAV.android);
    addShipped();
    expect(applyViewportPolicy()).toBe(true);
    expect(viewportOf(document)).toEqual([RELAXED]);
  });

  test('#562 viewport defaults: with no arguments, an iOS browser keeps maximum-scale', () => {
    vi.spyOn(nativeBridge, 'isNativeApp').mockReturnValue(false);
    stubNavigator(NAV.iphone);
    addShipped();
    expect(applyViewportPolicy()).toBe(true);
    expect(viewportOf(document)).toEqual([IOS_RELAXED]);
  });

  test('#562 viewport defaults: with no arguments, the native app leaves it locked', () => {
    vi.spyOn(nativeBridge, 'isNativeApp').mockReturnValue(true);
    stubNavigator(NAV.android);
    addShipped();
    expect(applyViewportPolicy()).toBe(false);
    expect(viewportOf(document)).toEqual([SHIPPED]);
  });
});
