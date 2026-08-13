import db from '../db.js';
import { logger } from './logger.js';

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

    const res = await fetch(`${c.serverUrl}/message?token=${encodeURIComponent(c.appToken)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logger.error(`[gotify] send failed (${res.status}): ${text.slice(0, 200)}`);
      return { ok: false, error: `HTTP ${res.status}${text ? ` — ${text.slice(0, 140)}` : ''}` };
    }
    logger.info(`[gotify] sent "${title || 'notification'}"`);
    return { ok: true };
  } catch (e) {
    logger.error('[gotify] send failed (network):', e.message);
    return { ok: false, error: e.message };
  }
}
