// resolveWhepResource: which WHEP `Location` headers the live player may send its token-carrying DELETE to (#562).
//
// WHAT THIS PROVES, rule by rule (src/lib/whep.js says why each rule exists):
//   * the legitimate shapes are kept: an absolute path, a same-origin URL (query kept, fragment and host
//     dropped), and a relative reference resolved against the POST's URL (not the page);
//   * another origin is refused in every spelling the URL parser accepts for one;
//   * a same-origin path that is not this camera's session is refused, including the three forms found in plan
//     review that normalise to the protocol-relative path `//evil.example/x`;
//   * exactly one non-empty segment after the POST path, with no `%` in it, and no encoded `/` or `\` anywhere in
//     the path (the camera part included), while an escape the camera part legitimately needs is kept;
//   * userinfo in front of THIS host is accepted and dropped (only a path is returned);
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
    // An escape in the CAMERA part is this app's own (it must equal the POST's path), so the session rule's
    // "no `%`" does not reach it: a camera path that needs one keeps its DELETE.
    expect(resolve('/live/cam%20one/whep/abc', PAGE, '/live/cam%20one/whep')).toBe('/live/cam%20one/whep/abc');
  });

  test('accepts userinfo in front of THIS host and drops it with the host: only the path is returned', () => {
    // Same origin (an origin has no userinfo), so rule 1 lets it through; the credentials cannot reach the wire
    // because the caller is handed a path.
    expect(resolve('https://user:pw@nightlight.example/live/cam1/whep/abc')).toBe('/live/cam1/whep/abc');
  });

  test('refuses an address on another site: other host, scheme, port, userinfo with another host, protocol-relative, backslash, non-http schemes', () => {
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
      // In the session segment (the "no %" rule refuses these too).
      '/live/cam1/whep/a%2fb',
      '/live/cam1/whep/a%2Fb',
      '/live/cam1/whep/a%5cb',
      '/live/cam1/whep/a%5Cb',
      // One segment to this parser; `DELETE /api/auth/users/1` to a front proxy that decodes %2F.
      '/live/cam1/whep/..%2f..%2f..%2fapi%2fauth%2fusers%2f1',
    ]);
    // In the CAMERA part, where only this rule applies (the "no %" rule is for the session segment alone). The
    // Location matches the POST path exactly, so nothing else refuses these; both cases of each escape are here
    // so the rule's case-insensitivity is pinned too.
    for (const camera of ['a%2fb', 'a%2Fb', 'a%5cb', 'a%5Cb']) {
      const post = `/live/${camera}/whep`;
      expect(resolve(`${post}/abc`, PAGE, post), `should refuse a camera path ${camera}`).toBeNull();
    }
  });

  test('refuses any percent sign in the session segment: double-encoded, harmless-looking and malformed escapes', () => {
    expectRefused([
      // `%25` is `%`: a layer that decodes twice turns this into `/` (found in code review: it passed the
      // `%2f|%5c` rule).
      '/live/cam1/whep/a%252fb',
      '/live/cam1/whep/..%252f..%252f..%252fapi',
      // Harmless-looking escapes: refused all the same, since no session id needs one.
      '/live/cam1/whep/%41',
      '/live/cam1/whep/a%2eb',
      // A lone or malformed escape: the URL parser leaves it as it is.
      '/live/cam1/whep/%',
      '/live/cam1/whep/abc%',
      '/live/cam1/whep/%zz',
    ]);
    // A whole-segment `%2e` is `.` to the URL parser and normalises away (refused as an empty segment).
    expect(resolve('/live/cam1/whep/%2e')).toBeNull();
  });

  test('returns null instead of throwing on a missing, non-string or unparseable input', () => {
    // The array is the hostile one: its string form is a valid session address, so only the `typeof` check
    // refuses it (`new URL` would happily stringify it).
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
