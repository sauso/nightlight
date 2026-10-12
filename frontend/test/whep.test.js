// resolveWhepResource: which WHEP `Location` headers the live player may send its token-carrying DELETE to (#562).
//
// WHAT THIS PROVES, rule by rule (src/lib/whep.js says why each rule exists):
//   * the legitimate shapes are kept: an absolute path, a same-origin URL (query kept, fragment and host
//     dropped), and a relative reference resolved against the POST's URL (not the page);
//   * another origin is refused in every spelling the URL parser accepts for one;
//   * a same-origin path that is not this camera's session is refused, including the three forms found in plan
//     review that normalise to the protocol-relative path `//evil.example/x`;
//   * exactly one non-empty segment after the POST path, and no encoded `/` or `\` in it;
//   * garbage in gives null, never an exception.
// Fixtures are hostile on purpose: each refused input would be a token sent somewhere it should not go.
//
// ⚠️ SOME TAILS ARE LONG ON PURPOSE. The prefix check is `startsWith('/live/cam1/whep/')` (16 characters), and the
// one-segment check that follows slices those 16 characters off. If the prefix check were dropped, a path of 16
// characters or fewer (`//evil.example/x` is exactly 16) would slice to '' and be refused by the one-segment rule
// by accident, so the mutant would survive on it. `//evil.example/steal-token` and `/api/auth/users/12345` are
// longer, so they still reach the "one segment" verdict with a non-empty remainder and only the prefix rule can
// refuse them. Keep both kinds when editing these lists.
//
// WHAT IT DOES NOT PROVE: that the player calls this (whepPlayer.test.jsx does), or anything about a real
// browser's fetch. jsdom's URL is a WHATWG implementation, as a browser's is.
import { describe, test, expect } from 'vitest';
import { resolveWhepResource } from '../src/lib/whep.js';

const PAGE = 'https://nightlight.example';
const POST = '/live/cam1/whep';
const resolve = (location, page = PAGE, post = POST) => resolveWhepResource(location, post, page);

function expectRefused(list) {
  for (const location of list) {
    expect(resolve(location), `should refuse ${JSON.stringify(location)}`).toBeNull();
  }
}

describe('resolveWhepResource (#562)', () => {
  test('accepts the session under the POST path: an absolute path, a same-origin URL, and a relative reference', () => {
    expect(resolve('/live/cam1/whep/abc')).toBe('/live/cam1/whep/abc');
    // A UUID-shaped id. The rule does not depend on the id's format: MediaMTX controls it (the WHEP secret).
    expect(resolve('/live/cam1/whep/3c1f9a52-7d1e-4b8e-9a35-0f6c2e8d4b17'))
      .toBe('/live/cam1/whep/3c1f9a52-7d1e-4b8e-9a35-0f6c2e8d4b17');
    // Same origin spelled out: the host is dropped, the query kept, the fragment dropped.
    expect(resolve('https://nightlight.example/live/cam1/whep/abc?x=1')).toBe('/live/cam1/whep/abc?x=1');
    expect(resolve('https://nightlight.example/live/cam1/whep/abc?x=1#frag')).toBe('/live/cam1/whep/abc?x=1');
    // The default port is the same origin.
    expect(resolve('https://nightlight.example:443/live/cam1/whep/abc')).toBe('/live/cam1/whep/abc');
    // Relative to the POST URL `/live/cam1/whep` (RFC 7231 §7.1.2), so `whep/abc` lands under the camera, not
    // at the site root (which is where resolving against the page would put it: `/whep/abc`).
    expect(resolve('whep/abc')).toBe('/live/cam1/whep/abc');
    // A camera path with more than one segment works the same way.
    expect(resolve('whep/abc', PAGE, '/live/room/cam1/whep')).toBe('/live/room/cam1/whep/abc');
  });

  test('refuses an address on another site: other host, scheme, port, userinfo, protocol-relative, backslash, non-http schemes', () => {
    expectRefused([
      'https://evil.example/live/cam1/whep/abc',
      '//evil.example/live/cam1/whep/abc',
      '/\\evil.example/live/cam1/whep/abc',
      'https://user@evil.example/live/cam1/whep/abc',
      // Looks like this site to a person reading it; the host is evil.example.
      'https://nightlight.example@evil.example/live/cam1/whep/abc',
      'https://nightlight.example:8443/live/cam1/whep/abc',
      'http://nightlight.example/live/cam1/whep/abc',
      'javascript:alert(1)',
      'data:text/plain,x',
    ]);
  });

  test("refuses a same-site path outside this camera's WHEP path: /api routes, dot segments, another camera", () => {
    expectRefused([
      '/api/auth/users',
      '/api/auth/users/12345',
      'https://nightlight.example/api/auth/users/12345',
      '/live/../api/x',
      '/live/%2e%2e/api/x',
      '/live/..%2fapi/x',
      '/live/cam2/whep/abc',
      // The POST path without the slash boundary.
      '/live/cam1/whepabc',
      // `..` climbs out of the session path.
      '/live/cam1/whep/..',
    ]);
  });

  test('refuses the forms that normalise to the protocol-relative path //evil.example (plan review)', () => {
    expectRefused([
      // The three forms found in plan review, each producing the path `//evil.example/x`.
      'https://nightlight.example//evil.example/x',
      '/live/..//evil.example/x',
      '/live/%2e%2e//evil.example/x',
      // The same three with a longer tail (see the note at the top of this file).
      'https://nightlight.example//evil.example/steal-token',
      '/live/..//evil.example/steal-token',
      '/live/%2E%2E//evil.example/steal-token',
    ]);
  });

  test('refuses more or less than one segment after the POST path', () => {
    expectRefused([
      '/live/cam1/whep/abc/def',
      '/live/cam1/whep/abc/',
      '/live/cam1/whep/',
      '/live/cam1/whep/.',
      '/live/cam1/whep',
      // A literal backslash is a path separator to the URL parser, so this is two segments too.
      '/live/cam1/whep/a\\b',
    ]);
  });

  test('refuses an encoded slash or backslash in the path, in either case', () => {
    expectRefused([
      '/live/cam1/whep/a%2fb',
      '/live/cam1/whep/a%2Fb',
      '/live/cam1/whep/a%5cb',
      '/live/cam1/whep/a%5Cb',
      // One segment to this parser; `DELETE /api/auth/users/1` to a front proxy that decodes %2F.
      '/live/cam1/whep/..%2f..%2f..%2fapi%2fauth%2fusers%2f1',
    ]);
  });

  test('returns null instead of throwing on a missing, non-string or unparseable input', () => {
    for (const location of ['', null, undefined, 42, {}, ['/live/cam1/whep/abc']]) {
      expect(resolve(location), `should refuse ${String(location)}`).toBeNull();
    }
    // An unparseable header.
    expect(resolve('http://[')).toBeNull();
    // An unusable page origin: a `file:` page reports the origin "null", and nothing parses against it.
    expect(resolve('/live/cam1/whep/abc', 'null')).toBeNull();
    // Called directly: the `resolve` helper above would replace an undefined origin with PAGE.
    expect(resolveWhepResource('/live/cam1/whep/abc', POST, undefined)).toBeNull();
  });
});
