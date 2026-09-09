// Splitting Basic-auth credentials out of a URL, and putting them back on save.
//
// THE DEFECT THIS EXISTS FOR (issue #271). `publicCamera()` returned `snapshot_url` to admins
// VERBATIM, credentials and all, while every other secret in the same function was reduced before it
// left the server — `rtsp_url` became host/port/path/username + a `rtsp_has_password` flag, and
// `talk_password` became `talk_has_password`. `routes/diagnostics.js` already reduced this very column
// to `has_snapshot_url`. So the masked treatment existed three lines away, for the same field, and the
// odd one out was invisible in review.
//
// "Admin-only" was the mitigation applied. The RTSP and talk passwords are also admin-only and are
// still not returned, because admin-only is a weaker guarantee than not-sent: a value that reaches the
// browser is in the DOM, in memory, in any error report or session replay, and in anything that
// scrapes the page.
//
// ⚠️ The snapshot field is free text an operator pastes, so nothing here may throw on a malformed
// URL — a camera whose endpoint is half-typed must still load its settings page.

/** Parse leniently. Returns null for anything that is not a URL with a host. */
function parse(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.host ? u : null;
  } catch {
    return null;
  }
}

/** True if the URL carries a Basic-auth password. */
export function urlHasPassword(raw) {
  const u = parse(raw);
  return !!(u && u.password);
}

/** The username in the URL, or '' — safe to show, like `rtsp_username`. */
export function urlUsername(raw) {
  const u = parse(raw);
  return u ? decodeURIComponent(u.username || '') : '';
}

/**
 * The URL with the password removed and the username kept — what an admin may see.
 *
 * Three cases, and it always returns a string (issue #320 — this used to document a `null` return
 * that no branch produces, so a caller's `=== null` is a check that never fires):
 *   - parseable      → the password-stripped URL
 *   - unparseable, but demonstrably credential-free (no `@`) → the trimmed original
 *   - anything else  → `''`
 *
 * The last case is the point: input that cannot be shown to be safe is reduced rather than echoed,
 * so a caller cannot accidentally display something uninspected.
 *
 * @returns {string}
 */
export function stripUrlPassword(raw) {
  const u = parse(raw);
  if (!u) return typeof raw === 'string' && raw.trim() && !raw.includes('@') ? raw.trim() : '';
  u.password = '';
  // href re-encodes; drop the trailing '@' the URL API leaves when only a username remains removed.
  return u.toString().replace('//@', '//');
}

/**
 * Replace the password in every `//user:pass@host` occurrence in a block of free text.
 *
 * THE DEFECT THIS EXISTS FOR (GHSA-wcgj-6p3c-vr9h). The "unsupported camera" report embeds
 * ffprobe's stderr, and ffprobe prefixes its failure line with the input URL — credentials and
 * all. That report is built specifically to be attached to a PUBLIC GitHub issue, and the UI told
 * the user it contained no password. `validateRtspStream()` already stripped the URL prefix, but
 * only because it wanted a tidy message; the function whose output was meant to be published did
 * not.
 *
 * ⚠️ This scrubs the pattern ANYWHERE in the line, not just as a prefix, deliberately. Stripping a
 * leading URL (what `validateRtspStream` does) is a formatting choice that happens to redact; it
 * breaks the moment ffmpeg words a message differently, and we do not control ffmpeg's wording.
 * The username is kept — it is already returned in the report as `rtsp_username`, and knowing the
 * probe authenticated as the right user is part of what the report is for.
 *
 * @param {string} text
 * @returns {string} the text with every embedded password replaced by `***`
 */
export function redactCredentials(text) {
  if (typeof text !== 'string' || !text) return text;
  // The user may be empty (`//:pass@`). The password is everything up to the '@' that is not a '/'
  // or whitespace, so a percent-encoded password matches — `encodeURIComponent`'s entire output
  // alphabet (`!%'()*-.0-9A-Z_a-z~`) contains nothing that breaks `[^/\s@]`, and every RTSP URL on
  // this path is built by `assembleRtspUrl`, which encodes. A RAW '/' or space in the password
  // segment does defeat this — unreachable here for that reason, and `findCredentialLeak` is the
  // backstop if it ever becomes reachable.
  // ⚠️ Do NOT restate this as "an encoded password containing ':' still matches": encodeURIComponent
  // emits '%3A', never a literal colon, so that phrasing described a case that cannot occur — and a
  // test named after it sat clear of the boundary it claimed to pin.
  return text.replace(/(\/\/)([^/\s:@]*):([^/\s@]+)@/g, '$1$2:***@');
}

/**
 * Deep-scrub an object about to leave the server: every string is `redactCredentials`'d, and any
 * literal occurrence of `secret` is replaced.
 *
 * ⚠️ THIS IS A BACKSTOP, NOT THE FIX. The fix is that each producer redacts its own output. This
 * exists because the report is assembled from several sources — ffprobe stderr, ONVIF fault
 * strings, error messages from libraries we do not control — and the advisory's lesson was that
 * one unredacted producer is enough. `secret` catches a password that appears on its own, outside
 * URL form, which no pattern can recognise.
 *
 * @param {*} value  any JSON-shaped value
 * @param {string} [secret]  a literal to replace wherever it appears
 */
export function scrubSecrets(value, secret) {
  // Only literals long enough to be distinctive. A 1-3 char password would match substrings all
  // over the report ("554", "h264") and mangle the diagnostic beyond use.
  //
  // ⚠️ THIS IS A REAL, ACCEPTED TRADE-OFF, NOT A FREE ONE — an earlier version of this comment
  // claimed a short password was still covered by the URL pattern, which is FALSE for the bare
  // (non-URL) form that is the whole reason the literal pass exists. A 3-character password
  // appearing outside URL form is NOT scrubbed. That is judged acceptable: sub-4-char credentials
  // are vanishingly rare, and the alternative mangles every report. `findCredentialLeak` at the
  // route is the backstop that stops such a report being published anyway.
  const lit = typeof secret === 'string' && secret.length >= 4 ? secret : null;
  // encodeURIComponent throws URIError on a lone surrogate, and a password is arbitrary user input.
  // A scrubber must never be the thing that fails.
  let encLit = null;
  if (lit) {
    try {
      const e = encodeURIComponent(lit);
      if (e !== lit) encLit = e;
    } catch { /* unpaired surrogate — the literal form below still applies */ }
  }
  const walk = (v) => {
    if (typeof v === 'string') {
      let s = redactCredentials(v);
      if (lit) s = s.split(lit).join('***');
      // The URL-encoded form is what ends up inside an assembled RTSP URL.
      if (encLit) s = s.split(encLit).join('***');
      return s;
    }
    if (Array.isArray(v)) return v.map(walk);
    // ⚠️ PLAIN OBJECTS ONLY. Rebuilding from Object.entries turns a Date into `{}` and a Buffer into
    // a map of numeric keys — it would silently DESTROY the field rather than scrub it. Nothing in
    // the report is a class instance today (checked: probeOnvifCamera returns flat primitives, and
    // `generated_at` is already an ISO string), so this guard is for the field somebody adds later.
    // Such a value is passed through untouched: a scrubber that corrupts the diagnostic it is
    // protecting gets switched off, and silent corruption is worse than an unscrubbed non-string.
    if (v && typeof v === 'object') {
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) return v;
      const out = {};
      for (const [k, x] of Object.entries(v)) out[k] = walk(x);
      return out;
    }
    return v;
  };
  return walk(value);
}

/**
 * Work out the password a save should end up with, then rebuild the URL.
 *
 * Order of precedence:
 *   1. a password embedded in what the operator submitted — that is how one gets set in the first place
 *   2. an explicit `password` field — the "type a new one" path
 *   3. the stored password, but ONLY if the submitted URL points at the same place
 *
 * ⚠️ RULE 3'S CONDITION IS THE SECURITY-RELEVANT PART, not a convenience. "Blank keeps the existing
 * password" is the pattern used for the RTSP and talk passwords, but those are separate fields from
 * the host. Here the host sits in the same box the operator is editing, so carrying the old password
 * forward unconditionally would silently send the credential for camera A to whatever host they
 * retyped — including a host they do not control. Same origin, same username, same path, or the
 * password is dropped and they retype it.
 *
 * @returns {string|null} the URL to store, or null for "no snapshot endpoint"
 */
export function resolveUrlPassword({ submitted, stored, password }) {
  const sub = parse(submitted);
  if (!sub) {
    // Not a parseable URL: store the trimmed text as-is (or null). Nothing to merge into.
    const s = typeof submitted === 'string' ? submitted.trim() : '';
    return s || null;
  }
  if (sub.password) return sub.toString();

  if (typeof password === 'string' && password !== '') {
    sub.password = encodeURIComponent(password);
    return sub.toString();
  }

  const old = parse(stored);
  if (old && old.password && sameTarget(old, sub)) {
    sub.password = old.password;
    return sub.toString();
  }
  return sub.toString().replace('//@', '//');
}

// Same place, for the purpose of carrying a credential forward. Protocol, host (incl. port), username
// and path must all match; a query-string change is not enough to warrant dropping the password.
function sameTarget(a, b) {
  return a.protocol === b.protocol && a.host === b.host && a.username === b.username && a.pathname === b.pathname;
}

/**
 * Does this about-to-be-published value still contain a credential? Returns the reason, or null.
 *
 * ⚠️ FAIL CLOSED. `scrubSecrets` walks what it recognises and passes anything else through
 * UNTOUCHED — deliberately, because a scrubber that corrupts the diagnostic it protects gets
 * switched off. The cost of that choice is that an unrecognised container (a class instance, a
 * cross-realm object) would be published unscrubbed, which trades a loud failure for a silent one
 * in a security control. This is the loud failure: the caller checks the SERIALISED output, which
 * is what actually gets written to the file, and refuses to send it if a credential survived.
 *
 * This is remediation step 2 of GHSA-wcgj-6p3c-vr9h — "assert the invariant rather than describing
 * it". The advisory exists because four separate places DESCRIBED this guarantee and none checked.
 *
 * @param {*} payload  the value about to be serialised and sent
 * @param {string} [secret]  a literal that must not appear
 * @returns {string|null} a short reason if a credential is present, else null
 */
export function findCredentialLeak(payload, secret) {
  let json;
  try {
    json = JSON.stringify(payload);
  } catch {
    // Circular or unserialisable: it cannot be published either, so treat it as unsafe.
    return 'payload could not be serialised for inspection';
  }
  if (typeof json !== 'string') return 'payload serialised to nothing';
  // The same pattern redactCredentials replaces — but NOT matching its own `***` marker, or the gate
  // rejects every correctly-redacted report. (It did exactly that on first run: `rtsp://u:***@h`
  // still matches `[^/\s@]+`. Caught because the route test asserted 200, not merely "no sentinel" —
  // a test that only checked for the password would have called this a pass.)
  if (/(\/\/)([^/\s:@]*):(?!\*\*\*@)([^/\s@]+)@/.test(json)) return 'an embedded URL credential survived redaction';
  if (typeof secret === 'string' && secret.length >= 4 && json.includes(secret)) {
    return 'the camera password appears verbatim';
  }
  return null;
}
