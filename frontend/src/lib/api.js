const TOKEN_KEY = 'nightlight_token';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

// --- Media token: a short-lived, video-only capability for URLs the browser fetches itself
// (<img>/<video>, HLS, the talk WebSocket), where an Authorization header can't be attached. Kept in
// memory ONLY (never localStorage), and refreshed proactively, so a URL that leaks into a proxy log,
// browser history or Referer header carries at most a time-boxed, media-only token — not the full
// session token. Backed by POST /auth/media-token; enforced by the server's requireAuthQueryOrHeader.
let mediaToken = null;
let mediaTokenExpMs = 0;
let mediaTokenInflight = null;

export async function refreshMediaToken() {
  if (!getToken()) { mediaToken = null; mediaTokenExpMs = 0; return null; }
  if (mediaTokenInflight) return mediaTokenInflight;
  mediaTokenInflight = (async () => {
    try {
      const data = await request('POST', '/auth/media-token');
      mediaToken = data.token;
      mediaTokenExpMs = Date.now() + data.expires_in * 1000;
      return mediaToken;
    } catch {
      return mediaToken; // keep any still-valid token on a transient failure
    } finally {
      mediaTokenInflight = null;
    }
  })();
  return mediaTokenInflight;
}

export function getMediaToken() {
  // Kick off a background refresh when missing or within 5 min of expiry; return whatever we hold now
  // (a still-valid token, or null on the very first call before the bootstrap fetch lands).
  if (getToken() && (!mediaToken || Date.now() > mediaTokenExpMs - 5 * 60 * 1000)) {
    refreshMediaToken();
  }
  return mediaToken;
}

export function clearMediaToken() {
  mediaToken = null;
  mediaTokenExpMs = 0;
}

async function request(method, url, body) {
  const headers = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`/api${url}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401) {
    setToken(null);
    window.location.hash = '#/login';
  }

  let data = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!res.ok) {
    const err = new Error(data?.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.data = data; // lets callers act on structured fields (e.g. needsConfirm)
    throw err;
  }
  return data;
}

export const api = {
  get: (url) => request('GET', url),
  post: (url, body) => request('POST', url, body),
  put: (url, body) => request('PUT', url, body),
  del: (url) => request('DELETE', url),
  // Absolute, token-carrying URL for media the browser fetches itself (<img>/<video>,
  // which can't attach an Authorization header). Uses the short-lived MEDIA token (not the session
  // token), so the URL is safe to appear in logs/history. The route must accept it (requireAuthQueryOrHeader).
  url: (path) => {
    const token = getMediaToken();
    if (!token) return `/api${path}`;
    return `/api${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
  },
};
