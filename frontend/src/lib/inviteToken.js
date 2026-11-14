// Where the caregiver invite link's token lives on the CAREGIVER's device (#1094, plan amendment L4).
//
// The link is `<address>#/invite/<token>`. The token sits after the `#` so it is never sent to a server, a reverse proxy's access
// log or (via Referer) another site. What is left is the browser's own history: an entry whose address contains a one-time
// secret would be there for anyone who later opens that device's history. So the token is MOVED out of the address the moment
// the page can, into sessionStorage (this tab only, gone when it closes, never shared with another tab or with localStorage where
// the sign-in lives), and the address becomes `#/invite`.
//
// sessionStorage can throw (private windows, blocked site data), so every access is wrapped and a module variable is the
// fallback: the page then works for this load and loses the token on a reload, which only means asking for a new link.
const KEY = 'nightlight_invite_token';
let memory = null;

export function stashInviteToken(token) {
  memory = null;
  try {
    sessionStorage.setItem(KEY, token);
  } catch {
    memory = token;
  }
}

export function readInviteToken() {
  try {
    const stored = sessionStorage.getItem(KEY);
    if (stored) return stored;
  } catch { /* fall through to the module copy */ }
  return memory;
}

export function clearInviteToken() {
  memory = null;
  try {
    sessionStorage.removeItem(KEY);
  } catch { /* nothing to remove */ }
}

// Called once from main.jsx BEFORE React renders, so the token has left the address bar and history before any screen (or the
// lazily loaded invite page) exists. Why not only in the page: the page is a lazy chunk and sits behind AuthProvider's first
// check, and a device that still holds an old, now-rejected sign-in is sent to #/login by that check, which would overwrite the
// fragment and lose the token. Moving it first keeps it. Returns true when it moved one.
//
// replaceState (not a hash assignment) so no new history entry is made and no hashchange fires; the router has not started yet
// and reads the address when it is created.
//
// The segment is percent-DECODED before it is checked. A messaging app or a QR reader may re-encode a character of a perfectly valid
// token (`%74` for `t`); the router decodes it too (so the page would work), but a check on the raw text would leave the secret in the
// address bar and in history, which is exactly what this function exists to prevent. The decoded text is checked against the SAME
// base64url alphabet, so `%2F` (a slash), `%20` and the like still do not match, and a malformed escape (`%zz`) is left alone rather
// than thrown on, because this runs before React and a throw here would stop the whole app from starting.
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;
const HASH_PREFIX = '#/invite/';
// Longest raw segment worth decoding: a 256-character token with every character escaped (3 characters each). Anything longer cannot
// decode to a valid token.
const MAX_RAW_SEGMENT = 256 * 3;

export function captureInviteTokenFromLocation(win = window) {
  const hash = win.location.hash;
  if (!hash.startsWith(HASH_PREFIX)) return false;
  const raw = hash.slice(HASH_PREFIX.length);
  if (raw.length === 0 || raw.length > MAX_RAW_SEGMENT) return false;
  let token;
  try {
    token = decodeURIComponent(raw);
  } catch {
    return false;
  }
  if (!TOKEN_PATTERN.test(token)) return false;
  stashInviteToken(token);
  win.history.replaceState(win.history.state, '', `${win.location.pathname}${win.location.search}#/invite`);
  return true;
}
