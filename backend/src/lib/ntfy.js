import db from '../db.js';
import { logger } from './logger.js';
import { postWithTimeout } from './httpNotify.js';

// ntfy notifications (https://ntfy.sh, or any self-hosted ntfy server). The server POSTs the alert
// straight to a topic; the recipient subscribes in the ntfy app or a browser. The snapshot is sent
// as the request body (inline attachment) so it works even on a LAN ntfy with no public URL — no
// device-fetchable link needed. Optional auth: an access token (bearer) or username/password (basic).
// See docs/notifications.md.

export function getNtfyConfig() {
  const s = db
    .prepare('SELECT ntfy_enabled, ntfy_server_url, ntfy_topic, ntfy_token, ntfy_username, ntfy_password FROM settings WHERE id = ?')
    .get('app') || {};
  return {
    enabled: !!s.ntfy_enabled,
    serverUrl: (s.ntfy_server_url || 'https://ntfy.sh').trim().replace(/\/+$/, ''),
    topic: (s.ntfy_topic || '').trim(),
    token: (s.ntfy_token || '').trim(),
    username: (s.ntfy_username || '').trim(),
    password: (s.ntfy_password || '').trim(),
  };
}

export function ntfyConfigured() {
  const c = getNtfyConfig();
  return !!c.serverUrl && !!c.topic;
}

export function ntfyEnabled() {
  const c = getNtfyConfig();
  return c.enabled && !!c.serverUrl && !!c.topic;
}

function authHeader(c) {
  if (c.token) return `Bearer ${c.token}`;
  if (c.username || c.password) return `Basic ${Buffer.from(`${c.username}:${c.password}`).toString('base64')}`;
  return null;
}

// ntfy carries title/message in HTTP headers, which are effectively latin1 — Node's fetch throws on
// a non-latin1 header value. Strip anything outside that range so an emoji or CJK camera name can't
// make the whole request fail (the ASCII/Western text still goes through).
const headerSafe = (s) => String(s || '').replace(/[^\x00-\xFF]/g, '').trim();

// Fire-and-forget. Never throws into the caller. `image` (JPEG Buffer) is attached inline; `click`
// is a URL opened when the notification is tapped; `priority` is ntfy's 1..5.
export async function sendNtfy({ title, message, click, image, priority } = {}) {
  const c = getNtfyConfig();
  if (!c.serverUrl || !c.topic) return;
  try {
    const headers = {};
    const auth = authHeader(c);
    if (auth) headers.Authorization = auth;
    if (title) headers.Title = headerSafe(title);
    if (click) headers.Click = click;
    if (priority != null) headers.Priority = String(priority);

    let body;
    if (image && image.length) {
      headers.Filename = 'snapshot.jpg';
      headers.Message = headerSafe(message);
      body = image;
    } else {
      body = headerSafe(message);
    }

    const res = await postWithTimeout(
      `${c.serverUrl}/${encodeURIComponent(c.topic)}`,
      { method: 'POST', headers, body },
      { label: 'ntfy' }
    );
    if (!res.ok) {
      const text = res.text;
      logger.error(`[ntfy] send failed (${res.status}): ${text.slice(0, 200)}`);
      return { ok: false, error: `HTTP ${res.status}${text ? ` — ${text.slice(0, 140)}` : ''}` };
    }
    logger.info(`[ntfy] sent "${title || 'notification'}"${image && image.length ? ` with snapshot (${image.length} bytes)` : ''}`);
    return { ok: true };
  } catch (e) {
    logger.error('[ntfy] send failed (network):', e.message);
    return { ok: false, error: e.message };
  }
}
