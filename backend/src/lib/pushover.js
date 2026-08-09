import db from '../db.js';
import { logger } from './logger.js';

// Pushover notifications (https://pushover.net) — a self-hosted-friendly alternative to Firebase/FCM.
// The recipient installs the Pushover app (iOS/Android/desktop, one-time ~$5/platform) and the server
// just POSTs to Pushover's API with an application token (this install's Pushover "app") + a user or
// group key (the recipient, or a delivery group for multiple caregivers). No Firebase project, no
// APNs cert — and it works on iOS, which the FCM path can't do yet. See docs/notifications.md.

const API = 'https://api.pushover.net/1';
// Pushover caps messages at 1024 chars / titles at 250 — keep well under.
const MAX_MESSAGE = 1024;

export function getPushoverConfig() {
  const s = db
    .prepare('SELECT pushover_enabled, pushover_app_token, pushover_user_key FROM settings WHERE id = ?')
    .get('app') || {};
  return {
    enabled: !!s.pushover_enabled,
    appToken: (s.pushover_app_token || '').trim(),
    userKey: (s.pushover_user_key || '').trim(),
  };
}

// Both tokens present — the server could send if it wanted to (independent of the on/off switch).
export function pushoverConfigured() {
  const c = getPushoverConfig();
  return !!c.appToken && !!c.userKey;
}

// The single source of truth for "will a Pushover message actually be sent": admin turned it on AND
// both tokens are present. Gates the detector's send.
export function pushoverEnabled() {
  const c = getPushoverConfig();
  return c.enabled && !!c.appToken && !!c.userKey;
}

// Confirm the app token + user/group key are real before saving an "enabled" state, so we never
// accept a config that can't deliver. Uses Pushover's users/validate endpoint. Returns
// { ok: true } or { ok: false, error }.
export async function validatePushover(appToken, userKey) {
  if (!appToken || !userKey) return { ok: false, error: 'Both an application token and a user/group key are required.' };
  try {
    const body = new URLSearchParams({ token: appToken, user: userKey });
    const res = await fetch(`${API}/users/validate.json`, { method: 'POST', body });
    const data = await res.json().catch(() => ({}));
    if (data.status === 1) return { ok: true };
    const msg = Array.isArray(data.errors) && data.errors.length ? data.errors.join('; ') : 'Pushover rejected the token or user/group key.';
    return { ok: false, error: msg };
  } catch (e) {
    return { ok: false, error: `Couldn't reach Pushover to validate: ${e.message}` };
  }
}

// Fire-and-forget send. Never throws into the caller (a notification failure must not disrupt
// detection). `image` is an optional JPEG Buffer attached to the message (Pushover renders it inline).
// `url`/`urlTitle` add a supplementary link (we use a nightlight:// deep link to open the app).
export async function sendPushover({ title, message, url, urlTitle, priority, image } = {}) {
  const c = getPushoverConfig();
  if (!c.appToken || !c.userKey) return;
  try {
    const form = new FormData();
    form.set('token', c.appToken);
    form.set('user', c.userKey);
    form.set('message', String(message || '').slice(0, MAX_MESSAGE));
    if (title) form.set('title', String(title).slice(0, 250));
    if (url) form.set('url', url);
    if (urlTitle) form.set('url_title', urlTitle);
    if (priority != null) form.set('priority', String(priority));
    if (image && image.length) {
      form.set('attachment', new Blob([image], { type: 'image/jpeg' }), 'snapshot.jpg');
    }
    const res = await fetch(`${API}/messages.json`, { method: 'POST', body: form });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      const msg = Array.isArray(data.errors) && data.errors.length ? data.errors.join('; ') : `HTTP ${res.status}`;
      logger.error('[pushover] send failed:', msg);
      return { ok: false, error: msg };
    }
    return { ok: true };
  } catch (e) {
    logger.error('[pushover] send failed:', e.message);
    return { ok: false, error: e.message };
  }
}
