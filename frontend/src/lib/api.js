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

// Request timeouts (issue #556). `fetch` has no timeout of its own, so a connection that stalls
// (wifi drop, hung server, a backend route that never replies - #544) used to leave the request
// pending forever: polls stacked up behind it, a per-camera save queue stayed "in flight" for good,
// and every `busy` spinner stayed on until a reload. Every request now carries one.
//
// 30 s: comfortably above any ordinary call here (the slowest routine ones are the notification
// "send a test" calls, which the backend bounds at 10 s) and well above the 15 s status poll, so a
// merely slow network is not mistaken for a dead one. Not measured against real traffic - it is a
// judgement call, which is why a caller can override it (below) rather than it being a constant.
export const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
// For the few calls the backend itself is allowed to run long: the ONVIF/RTSP probes and a camera
// save (which probes each stream in turn, up to ~8-18 s apiece in rtspProbe.js / cameras.js), a
// sleep-night recompute, and photo uploads (a base64 image over a slow link). Cutting these off at
// 30 s would report a failure for work the server is still doing.
export const SLOW_REQUEST_TIMEOUT_MS = 90000;

async function request(method, url, body, { timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  // The timer covers the whole exchange (headers AND body), and it both aborts the fetch (frees the
  // connection for the browser's per-origin pool) and rejects a race - the race is what guarantees
  // the caller is released even if the fetch implementation ignores the signal.
  const controller = new AbortController();
  let timer;
  const timedOut = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      // Deliberately NOT a server-fault message and carries no `status`: nothing was received, so
      // "the server errored" would be a guess. `timedOut` lets a caller tell it apart if it needs to.
      const err = new Error('The server took too long to respond. Check your connection and try again.');
      err.timedOut = true;
      reject(err);
    }, timeoutMs);
  });
  // A request that settles first leaves `timedOut` pending forever; that is harmless, but a timeout
  // that fires AFTER the real error was already thrown must not become an unhandled rejection.
  timedOut.catch(() => {});

  try {
    return await Promise.race([timedOut, exchange(method, url, body, headers, controller.signal)]);
  } finally {
    clearTimeout(timer);
  }
}

async function exchange(method, url, body, headers, signal) {
  const res = await fetch(`/api${url}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
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
    // Demo writes are expected exploration, not a frightening permission failure. Keep the backend's
    // exact marker for policy/audit purposes, but turn it into calm, useful copy everywhere forms
    // already display err.message; unrelated 403s must retain their specific explanation.
    const message = res.status === 403
      && data?.error === 'This is a read-only public demo - that action is disabled here.'
      ? 'This demo is read-only, so changes are disabled. You can still explore the sample data.'
      : data?.error || `Request failed (${res.status})`;
    const err = new Error(message);
    err.status = res.status;
    err.data = data; // lets callers act on structured fields (e.g. needsConfirm)
    throw err;
  }
  return data;
}

export const api = {
  // `opts.timeoutMs` overrides the default for a call known to be slow (see SLOW_REQUEST_TIMEOUT_MS).
  get: (url, opts) => request('GET', url, undefined, opts),
  post: (url, body, opts) => request('POST', url, body, opts),
  put: (url, body, opts) => request('PUT', url, body, opts),
  del: (url, opts) => request('DELETE', url, undefined, opts),
  // Absolute, token-carrying URL for media the browser fetches itself (<img>/<video>,
  // which can't attach an Authorization header). Uses the short-lived MEDIA token (not the session
  // token), so the URL is safe to appear in logs/history. The route must accept it (requireAuthQueryOrHeader).
  url: (path) => {
    const token = getMediaToken();
    if (!token) return `/api${path}`;
    return `/api${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
  },
};
