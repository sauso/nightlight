import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';
import db from '../db.js';

// Push notifications via Firebase Cloud Messaging. The service-account credential is a secret,
// so it is NEVER baked into the (public) image — it's mounted as a file into the data dir. If
// it's absent, push is simply disabled (no error): everything else, including the in-app alerts
// list, works without it.
const CRED_PATH =
  process.env.FIREBASE_CREDENTIALS ||
  path.join(process.env.DATA_DIR || '/app/data', 'firebase-service-account.json');

// Android notification channel the app must define (see the mobile client). Matched here so the
// notification is delivered to the right channel on Android 8+.
const ANDROID_CHANNEL = 'nightlight_alerts';

let messaging = null;

export async function initPush() {
  if (!fs.existsSync(CRED_PATH)) {
    logger.info(`[push] no Firebase credentials at ${CRED_PATH} — push notifications disabled`);
    return;
  }
  try {
    const cred = JSON.parse(fs.readFileSync(CRED_PATH, 'utf8'));
    const { initializeApp, cert } = await import('firebase-admin/app');
    const { getMessaging } = await import('firebase-admin/messaging');
    initializeApp({ credential: cert(cred) });
    messaging = getMessaging();
    logger.info(`[push] Firebase initialized (project ${cred.project_id})`);
  } catch (e) {
    logger.error('[push] failed to initialize Firebase:', e.message);
  }
}

export function pushEnabled() {
  return !!messaging;
}

export function registerToken(token, platform, userId) {
  if (!token) return;
  db.prepare(
    `INSERT INTO push_tokens (token, user_id, platform, updated_at)
       VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(token) DO UPDATE SET
       user_id = excluded.user_id, platform = excluded.platform, updated_at = datetime('now')`
  ).run(token, userId || null, platform || null);
}

export function removeToken(token) {
  if (token) db.prepare('DELETE FROM push_tokens WHERE token = ?').run(token);
}

// Fire-and-forget push to every registered device. Never throws into the caller (a push failure
// must not disrupt detection). Prunes tokens FCM reports as permanently dead.
export async function sendToAll(title, body, data = {}) {
  if (!messaging) return;
  const tokens = db.prepare('SELECT token FROM push_tokens').all().map((r) => r.token);
  if (tokens.length === 0) return;
  // FCM data payload values must all be strings.
  const stringData = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)]));
  try {
    const res = await messaging.sendEachForMulticast({
      tokens,
      notification: { title, body },
      data: stringData,
      android: { priority: 'high', notification: { channelId: ANDROID_CHANNEL } },
    });
    res.responses.forEach((r, i) => {
      if (r.success) return;
      const code = r.error?.code || '';
      if (
        code.includes('registration-token-not-registered') ||
        code.includes('invalid-registration-token') ||
        code.includes('invalid-argument')
      ) {
        removeToken(tokens[i]);
      }
    });
    logger.info(`[push] alert sent to ${res.successCount}/${tokens.length} device(s)`);
  } catch (e) {
    logger.error('[push] send failed:', e.message);
  }
}
