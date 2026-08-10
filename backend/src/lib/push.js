import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';
import db from '../db.js';
import { storeSnapshot } from './pushSnapshots.js';

// Push notifications via Firebase Cloud Messaging. The service-account credential is a secret,
// so it is NEVER baked into the (public) image — it's mounted as a file into the data dir. If
// it's absent, push is simply disabled (no error): everything else, including the in-app alerts
// list, works without it.
const DATA_DIR = process.env.DATA_DIR || '/app/data';
const CRED_PATH = process.env.FIREBASE_CREDENTIALS || path.join(DATA_DIR, 'firebase-service-account.json');
// The client-side Firebase config (the admin's google-services.json). Nightlight is self-hosted,
// so each install uses its OWN Firebase project: the generic app fetches these values from its own
// server at runtime and initializes Firebase with them (rather than baking them into the APK).
const CLIENT_CONFIG_PATH = process.env.FIREBASE_CLIENT_CONFIG || path.join(DATA_DIR, 'google-services.json');

// Android notification channel the app must define (see the mobile client). Matched here so the
// notification is delivered to the right channel on Android 8+.
const ANDROID_CHANNEL = 'nightlight_alerts';

let messaging = null;

// Idempotent: initializes firebase-admin from the mounted service-account key the first time it
// finds one. Safe to call again after the admin drops the file in and enables push (no restart
// needed). Returns whether messaging is ready. Absent credential is not an error — push is simply
// unavailable until it's provided.
export async function initPush() {
  if (messaging) return true;
  if (!fs.existsSync(CRED_PATH)) {
    logger.info(`[push] no Firebase credentials at ${CRED_PATH} — push notifications disabled`);
    return false;
  }
  try {
    const cred = JSON.parse(fs.readFileSync(CRED_PATH, 'utf8'));
    const { initializeApp, cert } = await import('firebase-admin/app');
    const { getMessaging } = await import('firebase-admin/messaging');
    initializeApp({ credential: cert(cred) });
    messaging = getMessaging();
    logger.info(`[push] Firebase initialized (project ${cred.project_id})`);
    return true;
  } catch (e) {
    logger.error('[push] failed to initialize Firebase:', e.message);
    return false;
  }
}

// Can this server technically deliver a push right now? Needs both the service-account key (to
// send) and the client config (so the app could register). Independent of the admin on/off switch.
export function pushConfigured() {
  return !!messaging && !!getClientConfig();
}

// The admin's explicit on/off switch (Settings → Notifications). Read live so it takes effect
// without a restart.
function pushSettingOn() {
  try {
    return !!db.prepare('SELECT push_enabled FROM settings WHERE id = ?').get('app')?.push_enabled;
  } catch {
    return false;
  }
}

// The single source of truth for "will a push actually be sent": the admin turned it on AND the
// server is technically able to deliver. Gates sendToAll and is what the app's status reflects.
export function pushEnabled() {
  return pushSettingOn() && pushConfigured();
}

// Validate the Firebase setup for the admin's "enable push" action, with a specific message per
// missing/invalid piece so the Settings page can tell the admin exactly what to fix. Returns
// { ok: true } or { ok: false, error }.
export function validatePushSetup() {
  if (!fs.existsSync(CRED_PATH)) {
    return { ok: false, error: 'The Firebase service-account key (firebase-service-account.json) is missing from the data directory.' };
  }
  try {
    const cred = JSON.parse(fs.readFileSync(CRED_PATH, 'utf8'));
    if (!cred.project_id || !cred.private_key) throw new Error('missing fields');
  } catch {
    return { ok: false, error: 'firebase-service-account.json is present but is not a valid service-account key.' };
  }
  if (!fs.existsSync(CLIENT_CONFIG_PATH)) {
    return { ok: false, error: 'google-services.json is missing from the data directory.' };
  }
  if (!getClientConfig()) {
    return { ok: false, error: 'google-services.json is present but is missing required fields (app id / api key / project id / sender id).' };
  }
  return { ok: true };
}

// The Firebase client config the mobile app needs to initialize FCM at runtime, read from the
// admin's google-services.json. Returns null if it isn't present or is malformed. Re-read each
// call (cheap, tiny file) so dropping the file in doesn't need a restart to take effect.
export function getClientConfig() {
  try {
    if (!fs.existsSync(CLIENT_CONFIG_PATH)) return null;
    const gs = JSON.parse(fs.readFileSync(CLIENT_CONFIG_PATH, 'utf8'));
    const client = gs?.client?.[0];
    const appId = client?.client_info?.mobilesdk_app_id;
    const apiKey = client?.api_key?.[0]?.current_key;
    const projectId = gs?.project_info?.project_id;
    const senderId = gs?.project_info?.project_number;
    if (!appId || !apiKey || !projectId || !senderId) return null;
    // Only the (non-secret) client identifiers — never the service-account private key.
    return { appId, apiKey, projectId, senderId };
  } catch {
    return null;
  }
}

export function registerToken(token, platform, userId, baseUrl) {
  if (!token) return;
  // COALESCE on base_url so a re-register from an older app that doesn't send it keeps the last
  // known good value rather than nulling out the device's snapshot-fetch base.
  db.prepare(
    `INSERT INTO push_tokens (token, user_id, platform, base_url, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(token) DO UPDATE SET
       user_id = excluded.user_id, platform = excluded.platform,
       base_url = COALESCE(excluded.base_url, push_tokens.base_url), updated_at = datetime('now')`
  ).run(token, userId || null, platform || null, baseUrl || null);
  // Zero-config learning of THIS server's own public URL: the origin the app reaches us through is,
  // by definition, an address that opens us in that app. Stash it so deep links can carry it and a
  // tap always lands on the sending server (see getPublicBaseUrl / detectionAlert.js).
  if (baseUrl) {
    try {
      db.prepare('UPDATE settings SET public_base_url = ? WHERE id = ?').run(baseUrl.replace(/\/+$/, ''), 'app');
    } catch {
      // Non-fatal — deep links just fall back to the server-less scheme.
    }
  }
}

// This server's own public URL, used to stamp deep links so a tapped alert opens the server that
// sent it, not whichever server the app last had open. Prefer the value learned on push-register
// (settings.public_base_url), but fall back to the most recently registered device's base_url — that
// too is an address a real app used to reach us, so it's a valid "open this server" URL. The
// fallback matters right after upgrading to this version: a server registered by an older app has a
// token base_url but no settings value yet, and would otherwise emit server-less links until the
// next fresh registration. Null only if nothing has ever registered.
export function getPublicBaseUrl() {
  try {
    const explicit = db.prepare('SELECT public_base_url FROM settings WHERE id = ?').get('app')?.public_base_url;
    if (explicit) return explicit.replace(/\/+$/, '');
    const row = db
      .prepare("SELECT base_url FROM push_tokens WHERE base_url IS NOT NULL AND base_url != '' ORDER BY updated_at DESC LIMIT 1")
      .get();
    return row?.base_url ? row.base_url.replace(/\/+$/, '') : null;
  } catch {
    return null;
  }
}

export function removeToken(token) {
  if (token) db.prepare('DELETE FROM push_tokens WHERE token = ?').run(token);
}

// Fire-and-forget push to every registered device. Never throws into the caller (a push failure
// must not disrupt detection). Prunes tokens FCM reports as permanently dead. An optional JPEG
// buffer is attached as a picture: FCM downloads it by URL (it can't carry the bytes like Pushover),
// so we stash the frame behind a short-lived unguessable URL built on each device's own reported
// base (see pushSnapshots.js). A device that never reported a base, or the whole thing when no image
// is given, simply gets the text-only alert.
export async function sendToAll(title, body, data = {}, imageBuffer = null) {
  if (!pushEnabled()) return;
  const rows = db.prepare('SELECT token, base_url FROM push_tokens').all();
  if (rows.length === 0) return;
  // FCM data payload values must all be strings.
  const stringData = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)]));
  const snapshotId = imageBuffer ? storeSnapshot(imageBuffer) : null;
  const messages = rows.map(({ token, base_url }) => {
    // Carry the server this alert came from so a tap can switch the app to it if it's showing a
    // different one. Per-device base_url is exactly the address THIS device uses to reach us, so
    // it's the right thing for this device to point at.
    const data = base_url ? { ...stringData, server: base_url.replace(/\/+$/, '') } : stringData;
    const msg = {
      token,
      notification: { title, body },
      data,
      android: { priority: 'high', notification: { channelId: ANDROID_CHANNEL } },
    };
    if (snapshotId && base_url) {
      const url = `${base_url.replace(/\/+$/, '')}/api/push/snapshot/${snapshotId}`;
      msg.notification.image = url;
      msg.android.notification.imageUrl = url;
    }
    return msg;
  });
  try {
    const res = await messaging.sendEach(messages);
    res.responses.forEach((r, i) => {
      if (r.success) return;
      const code = r.error?.code || '';
      if (
        code.includes('registration-token-not-registered') ||
        code.includes('invalid-registration-token') ||
        code.includes('invalid-argument')
      ) {
        removeToken(rows[i].token);
      }
    });
    const withImg = snapshotId ? (rows.some((r) => r.base_url) ? ' with image' : ' (image skipped — no device base URL)') : '';
    logger.info(`[push] alert sent to ${res.successCount}/${rows.length} device(s)${withImg}`);
  } catch (e) {
    logger.error('[push] send failed:', e.message);
  }
}
