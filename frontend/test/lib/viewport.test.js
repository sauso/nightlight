// Page zoom: relaxed in a browser, untouched in the native app (#562 bullet 3).
//
// The fixture is the REAL viewport string from index.html, read from disk, so a change there is tested as
// shipped. Every case asserts the exact resulting string, not "does not contain": a rewrite that drops
// `viewport-fit=cover` (the safe-area insets depend on it) or reorders tokens must fail too.
//
// ⚠️ NOT COVERED: whether a real browser or Android WebView honours a viewport meta changed after load. jsdom
// only stores the attribute. Checking that needs a phone (stated in the PR as not done).
import { describe, test, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { applyViewportPolicy, relaxedViewportContent } from '../../src/lib/viewport.js';
import * as nativeBridge from '../../src/lib/nativeBridge.js';

// `process.cwd()` is the frontend folder (vitest runs from there); see touchTargets.test.js for why not
// import.meta.url under jsdom.
const INDEX_HTML = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
const SHIPPED = /<meta name="viewport" content="([^"]*)"/.exec(INDEX_HTML)?.[1];
const RELAXED = 'width=device-width, initial-scale=1, viewport-fit=cover';

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
    expect(applyViewportPolicy(doc, false)).toBe(true);
    expect(viewportOf(doc)).toEqual([RELAXED]);
  });

  test('#562 viewport browser: every other token is kept verbatim and in order, including ones that also end in -scale', () => {
    const doc = docWith(['viewport',
      'height=device-height, minimum-scale=0.5, maximum-scale=1, initial-scale=2, user-scalable=0, interactive-widget=resizes-content, viewport-fit=cover']);
    applyViewportPolicy(doc, false);
    expect(viewportOf(doc)).toEqual([
      'height=device-height, minimum-scale=0.5, initial-scale=2, interactive-widget=resizes-content, viewport-fit=cover',
    ]);
  });

  test('#562 viewport browser: spacing, case, ; separators and empty tokens do not hide a locking token', () => {
    const doc = docWith(['viewport', ' width=device-width ,  Maximum-Scale = 1 ;USER-SCALABLE=no;;viewport-fit=cover, ']);
    applyViewportPolicy(doc, false);
    expect(viewportOf(doc)).toEqual(['width=device-width, viewport-fit=cover']);
  });

  test('#562 viewport browser: idempotent, a second run changes nothing and says so', () => {
    const doc = docWith(['viewport', SHIPPED]);
    applyViewportPolicy(doc, false);
    expect(applyViewportPolicy(doc, false)).toBe(false);
    expect(viewportOf(doc)).toEqual([RELAXED]);
    expect(relaxedViewportContent(relaxedViewportContent(SHIPPED))).toBe(RELAXED);
  });

  test('#562 viewport browser: no viewport meta is a no-op, and a meta that is not the viewport is never touched', () => {
    const none = docWith();
    expect(applyViewportPolicy(none, false)).toBe(false);
    expect(none.head.querySelectorAll('meta')).toHaveLength(0);
    // Hostile: another meta whose content LOOKS like a locked viewport.
    const doc = docWith(['description', SHIPPED], ['viewport', SHIPPED], ['theme-color', '#12172B']);
    applyViewportPolicy(doc, false);
    expect(doc.querySelector('meta[name="description"]').getAttribute('content')).toBe(SHIPPED);
    expect(doc.querySelector('meta[name="theme-color"]').getAttribute('content')).toBe('#12172B');
    expect(viewportOf(doc)).toEqual([RELAXED]);
    // A viewport meta with no content attribute gains none.
    const bare = docWith(['viewport']);
    expect(applyViewportPolicy(bare, false)).toBe(false);
    expect(bare.querySelector('meta[name="viewport"]').hasAttribute('content')).toBe(false);
  });

  test('#562 viewport browser: every viewport meta is relaxed, not only the first', () => {
    const doc = docWith(['viewport', SHIPPED], ['viewport', 'width=device-width, user-scalable=no']);
    applyViewportPolicy(doc, false);
    expect(viewportOf(doc)).toEqual([RELAXED, 'width=device-width']);
  });
});

describe('#562 viewport native: the app keeps the lock', () => {
  test('#562 viewport native: the shipped string is left exactly as it is, separators included', () => {
    const doc = docWith(['viewport', SHIPPED]);
    expect(applyViewportPolicy(doc, true)).toBe(false);
    expect(viewportOf(doc)).toEqual([SHIPPED]);
    const odd = docWith(['viewport', 'width=device-width,maximum-scale=1;user-scalable=no']);
    applyViewportPolicy(odd, true);
    expect(viewportOf(odd)).toEqual(['width=device-width,maximum-scale=1;user-scalable=no']);
  });
});

describe('#562 viewport defaults: the global document and the real native check', () => {
  const addShipped = () => {
    const m = document.createElement('meta');
    m.setAttribute('name', 'viewport');
    m.setAttribute('content', SHIPPED);
    document.head.appendChild(m);
  };

  test('#562 viewport defaults: with no arguments, a browser relaxes the page\'s own meta', () => {
    vi.spyOn(nativeBridge, 'isNativeApp').mockReturnValue(false);
    addShipped();
    expect(applyViewportPolicy()).toBe(true);
    expect(viewportOf(document)).toEqual([RELAXED]);
  });

  test('#562 viewport defaults: with no arguments, the native app leaves it locked', () => {
    vi.spyOn(nativeBridge, 'isNativeApp').mockReturnValue(true);
    addShipped();
    expect(applyViewportPolicy()).toBe(false);
    expect(viewportOf(document)).toEqual([SHIPPED]);
  });
});
