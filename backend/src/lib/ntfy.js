import db from '../db.js';
import { logger } from './logger.js';
import { postWithTimeout, redactSecrets, describeErrorReply, REPLY_FIELDS } from './httpNotify.js';
import { stripTrailingSlashes } from './stripTrailingSlashes.js';

const NTFY_REPLY_FIELDS = [...REPLY_FIELDS, 'code', 'http'];

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
    serverUrl: stripTrailingSlashes((s.ntfy_server_url || 'https://ntfy.sh').trim()),
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
const latin1 = (s) => String(s || '').replace(/[^\x00-\xFF]/g, '').trim();

// ⚠️ A HEADER value must also be a single line, and \r and \n are inside latin1: fetch throws on them, so one
// stray newline pasted into a camera or child name (the title is "<name> - motion") made every ntfy alert for it
// fail as "send failed (network)" while the other channels carried on (#551). Control characters become a
// space, not nothing, so "Nursery\nCam" stays two words. NOT applied to the BODY below: the sleep report is a
// multi-line message ("<child>: asleep ...\n<child>: ...") and a body may legitimately contain newlines.
const headerSafe = (s) => latin1(s).replace(/[\x00-\x1F\x7F]+/g, ' ').trim();

// Fire-and-forget. Never throws into the caller. `image` (JPEG Buffer) is attached inline; `click`
// is a URL opened when the notification is tapped; `priority` is ntfy's 1..5.
export async function sendNtfy({ title, message, click, image, priority } = {}) {
  const c = getNtfyConfig();
  if (!c.serverUrl || !c.topic) return;
  // The access token rides in the Authorization header, so it has the same exposure the Gotify token had (post-merge
  // review of PR #702): a token with a line break made fetch quote the whole header into its error. httpNotify.js
  // replaces that error; redactSecrets below keeps the credentials out of every other message too.
  // WHAT is a secret here is what actually travels (Opus review of PR #742, D2): the token, or base64(user:password)
  // without its `Basic ` prefix (a server can echo the bare value, and the prefixed one contains it). NOT the plain
  // password: it is never on the wire, so it cannot be echoed, and cutting it out of text only shredded unrelated
  // words and hinted at it (a password `ntfy` turned the docs URL in ntfy's own reply into `[redacted].sh`).
  const auth = authHeader(c);
  const secrets = [c.token, auth?.startsWith('Basic ') ? auth.slice('Basic '.length) : ''];
  try {
    const headers = {};
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
      body = latin1(message);
    }

    const res = await postWithTimeout(
      `${c.serverUrl}/${encodeURIComponent(c.topic)}`,
      { method: 'POST', headers, body },
      { label: 'ntfy' }
    );
    if (!res.ok) {
      // Never the raw reply (describeErrorReply in httpNotify.js). ntfy's own error JSON is
      // {"code":40101,"http":401,"error":"unauthorized","link":...}: its numbers are kept too, its link is not.
      const reply = describeErrorReply(res.status, res.text, secrets, NTFY_REPLY_FIELDS);
      logger.error(`[ntfy] send failed (${res.status}): ${reply}`);
      return { ok: false, error: reply };
    }
    logger.info(`[ntfy] sent "${title || 'notification'}"${image && image.length ? ` with snapshot (${image.length} bytes)` : ''}`);
    return { ok: true };
  } catch (e) {
    const reason = redactSecrets(e.message, secrets);
    logger.error('[ntfy] send failed (network):', reason);
    return { ok: false, error: reason };
  }
}
