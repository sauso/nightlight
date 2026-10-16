import db from '../db.js';
import { logger } from './logger.js';
import { postWithTimeout, redactSecrets } from './httpNotify.js';

// Gotify notifications (self-hosted, https://gotify.net). The server POSTs to a Gotify application's
// message endpoint with that application's token; the recipient runs the Gotify server + app. Text
// only — Gotify has no native image attachment — but a tap opens the camera via the click extra.
// See docs/notifications.md.

export function getGotifyConfig() {
  const s = db
    .prepare('SELECT gotify_enabled, gotify_server_url, gotify_app_token, gotify_priority FROM settings WHERE id = ?')
    .get('app') || {};
  return {
    enabled: !!s.gotify_enabled,
    serverUrl: (s.gotify_server_url || '').trim().replace(/\/+$/, ''),
    appToken: (s.gotify_app_token || '').trim(),
    priority: Number.isFinite(s.gotify_priority) ? s.gotify_priority : 5,
  };
}

export function gotifyConfigured() {
  const c = getGotifyConfig();
  return !!c.serverUrl && !!c.appToken;
}

export function gotifyEnabled() {
  const c = getGotifyConfig();
  return c.enabled && !!c.serverUrl && !!c.appToken;
}

// Fire-and-forget. Never throws into the caller. `click` opens a URL when the notification is tapped
// (Gotify's client::notification extra); `priority` is Gotify's 0..10 (defaults to the saved value).
export async function sendGotify({ title, message, click, priority } = {}) {
  const c = getGotifyConfig();
  if (!c.serverUrl || !c.appToken) return;
  try {
    const payload = {
      title: title || 'Nightlight',
      message: message || '',
      priority: priority != null ? priority : c.priority,
    };
    if (click) payload.extras = { 'client::notification': { click: { url: click } } };

    const res = await postWithTimeout(
      // The token goes in the X-Gotify-Key header, not the query string (#555 bullet 4): a URL is what reverse
      // proxies and server access logs record, a header is not. Gotify accepts either (its docs describe both
      // `?token=` and `X-Gotify-Key`). Not verified here against a real Gotify server: see the PR.
      `${c.serverUrl}/message`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Gotify-Key': c.appToken },
        body: JSON.stringify(payload),
      },
      { label: 'gotify' }
    );
    if (!res.ok) {
      // A server (or a proxy in front of it) that echoes the request back must not put the token in the log.
      const text = redactSecrets(res.text, [c.appToken]);
      logger.error(`[gotify] send failed (${res.status}): ${text.slice(0, 200)}`);
      return { ok: false, error: `HTTP ${res.status}${text ? ` — ${text.slice(0, 140)}` : ''}` };
    }
    logger.info(`[gotify] sent "${title || 'notification'}"`);
    return { ok: true };
  } catch (e) {
    // The token is in a HEADER since #555, and a header value fetch refuses is quoted whole in its error (see
    // REQUEST_NOT_BUILT in httpNotify.js, which already replaces that message). redactSecrets is the second
    // line: no message reaches the log or the Test button's 400 with the token in it, whatever produced it.
    // Tokens saved since this change cannot hold such a character (routes/gotify.js); one saved before can.
    const reason = redactSecrets(e.message, [c.appToken]);
    logger.error('[gotify] send failed (network):', reason);
    return { ok: false, error: reason };
  }
}
