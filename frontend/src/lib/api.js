const TOKEN_KEY = 'nightlight_token';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
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
  // which can't attach an Authorization header) — same ?token= approach HLS uses. The
  // matching route must accept the query token (requireAuthQueryOrHeader).
  url: (path) => {
    const token = getToken();
    if (!token) return `/api${path}`;
    return `/api${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
  },
};
