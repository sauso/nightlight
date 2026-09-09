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
 * Unparseable input is returned unchanged EXCEPT that it is not trusted to be password-free:
 * callers get `null` so they cannot accidentally display something they have not inspected.
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
  // user may be empty (`//:pass@`); password is everything up to the '@' that isn't a '/' or space,
  // so an encoded password containing ':' or '%' still matches.
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
  // over the report ("554", "h264") and mangle the diagnostic without adding protection the URL
  // pattern above doesn't already give.
  const lit = typeof secret === 'string' && secret.length >= 4 ? secret : null;
  const walk = (v) => {
    if (typeof v === 'string') {
      let s = redactCredentials(v);
      if (lit) s = s.split(lit).join('***');
      // The URL-encoded form is what ends up inside an assembled RTSP URL.
      if (lit) {
        const enc = encodeURIComponent(lit);
        if (enc !== lit) s = s.split(enc).join('***');
      }
      return s;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
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
