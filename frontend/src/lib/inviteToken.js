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
export function captureInviteTokenFromLocation(win = window) {
  const match = /^#\/invite\/([A-Za-z0-9_-]{1,256})$/.exec(win.location.hash);
  if (!match) return false;
  stashInviteToken(match[1]);
  win.history.replaceState(win.history.state, '', `${win.location.pathname}${win.location.search}#/invite`);
  return true;
}
