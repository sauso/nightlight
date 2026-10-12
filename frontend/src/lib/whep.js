// Where the live player may send its "end this viewing session" DELETE (#562).
//
// WHY THIS EXISTS. WhepPlayer starts a WebRTC session with a POST to `/live/<camera path>/whep`; the answer's
// `Location` header names the session, and on teardown the player sends `DELETE <that address>` carrying the
// person's full session token (`Authorization: Bearer`, the long-lived login token, not the short media token).
// Before #562 the header was used as it came. It comes back through everything between the browser and
// MediaMTX (the backend's `keepUnderPrefix` hook in backend/src/index.js, the http-proxy-middleware library it
// sits in, any reverse proxy in front of the server), so one bug or one rewrite there would have sent the
// token, with a DELETE, to wherever the header pointed. This decides whether the header is trustworthy, and
// gives the caller only a path, never a host.
//
// THE RULES, each for a reason (all found or confirmed in plan review by running `new URL` on hostile input):
//   1. Same origin as the page. Refuses another host, port or scheme, `//host`, `/\host`, `user@host`, and
//      `javascript:` / `data:` (whose origin is the string "null").
//   2. The path is EXACTLY `<the POST's path>/<one non-empty segment>`. THIS is the rule that keeps the token on
//      the site, not rule 1: `https://<this site>//evil.example/x`, `/live/..//evil.example/x` and
//      `/live/%2e%2e//evil.example/x` all pass rule 1 and normalise to the path `//evil.example/x`, which a later
//      `fetch()` would read as a protocol-relative address on another host. Requiring the POST's own path as
//      the prefix also rules out a same-site path elsewhere (a DELETE to an `/api/...` route with an admin's
//      token) and another camera's session.
//   3. No `%2f` / `%5c` (an encoded slash or backslash), in either case, anywhere in the path. URL parsing
//      leaves them encoded, so `/live/cam/whep/..%2f..%2f..%2fapi%2fusers%2f1` is "one segment" here; this server
//      never decodes it, but a front proxy that decodes `%2F` would turn it into `DELETE /api/users/1`.
// Rule 2 mirrors the server's own allowlist (backend/src/middleware/whepOnlyGuard.js: DELETE only
// `/<camera>/whep/<one segment>`, `[^/]+`), so it does not constrain the session id's FORMAT, which MediaMTX
// controls and which that guard deliberately leaves open too. Rule 3 is STRICTER than that guard's session
// segment (`[^/]+` accepts `%2F`), for the decode-boundary reason the guard itself gives for its camera segment;
// it can only cost a DELETE if MediaMTX ever put an encoded slash in a session id.
//
// A relative Location is resolved against the POST's URL, not the page (RFC 7231 §7.1.2: a relative reference
// in Location is relative to the effective request URI). `whep/abc` therefore means `/live/<camera>/whep/abc`.
//
// Returns `pathname + search` (no host, no fragment), so whatever the caller fetches can only ever go to the
// page's own origin; or null when the header is missing or fails a rule. Never throws: the caller is a cleanup
// path, and a refusal only costs the courtesy DELETE (see the comment at the call site in WhepPlayer.jsx).
const ENCODED_SEPARATOR = /%2f|%5c/i;

export function resolveWhepResource(locationHeader, requestUrl, pageOrigin) {
  if (typeof locationHeader !== 'string' || locationHeader === '') return null;
  try {
    const base = new URL(requestUrl, pageOrigin);
    const u = new URL(locationHeader, base);
    if (u.origin !== pageOrigin) return null;
    const prefix = `${base.pathname}/`;
    if (!u.pathname.startsWith(prefix)) return null;
    const session = u.pathname.slice(prefix.length);
    if (session === '' || session.includes('/')) return null;
    if (ENCODED_SEPARATOR.test(u.pathname)) return null;
    return u.pathname + u.search;
  } catch {
    // `new URL` throws on an unparseable header or an unusable origin (a `file:` page's origin is "null").
    return null;
  }
}
