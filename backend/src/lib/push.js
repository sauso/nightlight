import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';
import db from '../db.js';
import { storeSnapshot } from './pushSnapshots.js';
import { SESSION_TOKEN_TTL_DAYS } from '../middleware/auth.js';

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

// The only shape of address the app ever legitimately reports is `window.location.origin` — scheme,
// host and optional port, nothing else — so that is the only shape accepted: http(s)://host[:port],
// optionally with ONE trailing slash. The host is limited to the characters a hostname or an IPv4/IPv6
// literal can contain (underscore is allowed because a LAN machine name may have one).
//
// ⚠️ This checks the RAW STRING, on purpose, BEFORE handing it to `new URL()`. The WHATWG parser is
// deliberately forgiving — it turns `http:host`, `https:\\host`, `https://host?`, `https://host/a/..`
// and a tab in the middle of the host into a perfectly good origin — so validating only what it
// returns would quietly accept all of those. An adversarial review demonstrated exactly that against
// an earlier version that checked `pathname`/`search`/`hash` on the parsed result. `new URL()` is kept
// only to reject what the pattern cannot (a port above 65535, an impossible IPv6 literal) and to
// canonicalise. The pattern has no `@`, `/`, `?`, `#`, `\` or whitespace in the host, which is what
// rules out credentials, paths, queries, fragments and smuggled control characters in one place.
//
// It is a CHARACTER filter, not a hostname validator: `http://a..b`, `http://.` and legacy numeric
// IPv4 forms such as `http://0x7f.1` still pass (the parser canonicalises the last to 127.0.0.1, which is
// also what a browser reports). That is accepted on purpose — only an admin's device can set the shared
// address and an app reports exactly what a browser reports, so a stricter grammar would add regex
// complexity to guard a value nothing untrusted can reach.
const ORIGIN_SHAPE = /^https?:\/\/(?:[a-z0-9._-]+|\[[0-9a-f:.]+\])(?::\d{1,5})?\/?$/i;

// Returns the canonical origin (lower-cased host, default port dropped, no trailing slash) or null.
//
// ⚠️ This proves the value is a well-formed http(s) origin, NOT that it reaches this server: nothing
// here can know that. Who is allowed to *teach* the server an address is the job of registerToken's
// admin check; this only stops a malformed or non-web value from being stored at all.
export function normalizeBaseUrl(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  // 255 is well past any real origin (a max-length DNS name is 253); it only bounds hostile input.
  if (!s || s.length > 255) return null;
  if (!ORIGIN_SHAPE.test(s)) return null;
  try {
    return new URL(s).origin;
  } catch {
    return null;
  }
}

function isAdminUser(userId) {
  if (!userId) return false;
  return !!db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'admin'").get(userId);
}

// sessionId: the login session that made this registration call (req.user.sid — always a live
// session, requireAuth guarantees it). NOT coalesced like base_url — unlike a missing base_url
// (which just means an older app didn't send one), a re-register always carries a real, current
// session, and the whole point is to always rebind to whichever session registered most recently
// (e.g. a fresh sign-in after logging out), never to keep pointing at a now-stale one.
export function registerToken(token, platform, userId, baseUrl, sessionId) {
  if (!token) return;
  // A value that isn't a well-formed origin is dropped, not an error: the device still registers (an
  // unrecognised hint must never cost someone their alerts) and just gets no snapshot/deep-link base.
  const origin = normalizeBaseUrl(baseUrl);
  // COALESCE on base_url so a re-register from an older app that doesn't send it keeps the last
  // known good value rather than nulling out the device's snapshot-fetch base.
  db.prepare(
    `INSERT INTO push_tokens (token, user_id, platform, base_url, session_id, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(token) DO UPDATE SET
       user_id = excluded.user_id, platform = excluded.platform,
       base_url = COALESCE(excluded.base_url, push_tokens.base_url),
       session_id = excluded.session_id, updated_at = datetime('now')`
  ).run(token, userId || null, platform || null, origin, sessionId || null);
  // Zero-config learning of THIS server's own public URL: the origin an app reaches us through is an
  // address that opens us in that app. Stash it so deep links can carry it and a tap always lands on
  // the sending server (see getPublicBaseUrl / detectionAlert.js).
  //
  // Only an ADMIN's device may teach it. This one value is global — every household member's alert
  // links follow it — so it is server configuration, like everything else only an admin can change,
  // not a per-device hint. A caregiver's own address is still stored on their own token above (it is
  // only ever used to build links delivered to that same device). Decided from the database here,
  // not passed in by the caller, so no future caller can forget the check.
  if (origin && isAdminUser(userId)) {
    try {
      db.prepare('UPDATE settings SET public_base_url = ? WHERE id = ?').run(origin, 'app');
    } catch {
      // Non-fatal — deep links just fall back to the server-less scheme.
    }
  }
}

// This server's own public URL, used to stamp deep links so a tapped alert opens the server that
// sent it, not whichever server the app last had open. Prefer the value learned on push-register
// (settings.public_base_url), but fall back to the most recently registered ADMIN device's base_url —
// that too is an address a real app used to reach us, so it's a valid "open this server" URL. The
// fallback matters right after upgrading to this version: a server registered by an older app has a
// token base_url but no settings value yet, and would otherwise emit server-less links until the
// next fresh registration. Null when nothing usable exists — including a household whose only app
// users are caregivers, which degrades to the plain nightlight://camera/:id link (opens in place).
//
// Both the stored value and every fallback candidate are re-validated on READ, and the fallback is
// admin-only for the same reason registerToken's write is: rows written before that check existed
// (or by any other route to the table) must not be able to change where the household's links point.
export function getPublicBaseUrl() {
  try {
    const stored = normalizeBaseUrl(
      db.prepare('SELECT public_base_url FROM settings WHERE id = ?').get('app')?.public_base_url
    );
    return stored || newestAdminDeviceBaseUrl();
  } catch {
    return null;
  }
}

// The fallback half of getPublicBaseUrl. `IN (admins)` rather than `NOT IN (caregivers)` on purpose:
// push_tokens.user_id has no foreign key, so a row can name a user that no longer exists, and only
// the positive form excludes it. Walks newest-first and takes the first VALID value, so one malformed
// legacy row can't hide an older good one behind it.
function newestAdminDeviceBaseUrl() {
  const rows = db
    .prepare(
      `SELECT pt.base_url FROM push_tokens pt
        WHERE pt.base_url IS NOT NULL AND pt.base_url != ''
          AND pt.user_id IN (SELECT id FROM users WHERE role = 'admin')
        ORDER BY pt.updated_at DESC`
    )
    .all();
  for (const { base_url } of rows) {
    const origin = normalizeBaseUrl(base_url);
    if (origin) return origin;
  }
  return null;
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
// Every push_tokens row still worth delivering to. Defense in depth against GHSA-q98f:
// push_tokens.user_id has no FK/cascade, so a caller of DELETE /users/:id that ever misses the
// explicit cleanup there (routes/auth.js) — now, or in a future edit — must not be able to deliver
// to that device anyway. A NULL user_id also can't match this, which is correct: the only real
// caller of registerToken (routes/push.js) always supplies req.user.id, so a NULL row is either
// stale data or something that was never tied to a live, deletable account. Exported (rather than
// left inline in sendToAll) so the filter itself is directly testable without needing a real
// Firebase Admin SDK setup — `messaging` is module-level, non-exported state only initPush() can
// set, which real credentials are needed for.
// Same defense-in-depth reasoning as the user_id filter above, now for the session that registered
// each device: a row whose session has been revoked (signed out, an admin ending a device, a
// password reset) must not be delivered to even if some caller never explicitly cleaned it up. A
// row from before this filter existed (session_id NULL) is excluded too — NULL never satisfies IN
// (...) — until that device re-registers under a live session (see this repo's Security Advisories
// for the full writeup).
//
// The session subquery ALSO checks absolute age, not just row existence: `sessions` rows are only
// ever pruned by 31 days of INACTIVITY (db's purgeExpiredSessions, keyed on last_seen_at), so a
// session that's genuinely outlived its own JWT's SESSION_TOKEN_TTL_DAYS lifetime can still sit in
// the table — kept "alive" by unrelated activity from the same device — well past when its holder's
// API access has already, correctly, stopped working. Checking created_at here closes that gap
// directly rather than silently trusting row presence alone.
export function activePushTokens() {
  return db
    .prepare(
      `SELECT pt.token, pt.base_url FROM push_tokens pt
        WHERE pt.user_id IN (SELECT id FROM users)
          AND pt.session_id IN (
            SELECT id FROM sessions WHERE created_at > datetime('now', ?)
          )`
    )
    .all(`-${SESSION_TOKEN_TTL_DAYS} days`);
}

// `tag` (ROADMAP §1.6) is a notification-tray dedup key: posting a later message with the SAME tag
// replaces the earlier one instead of sitting alongside it. Set on BOTH platforms' own mechanism —
// Android's `notification.tag` and APNs' `apns-collapse-id` header (64-byte limit; the caller's tag
// format, `sleep_report_<childId>_<nightDate>`, comfortably fits a UUID childId). Optional and backward
// compatible — every existing caller omits it and gets today's exact behavior (no `tag`/`apns` key at
// all).
export async function sendToAll(title, body, data = {}, imageBuffer = null, { tag } = {}) {
  if (!pushEnabled()) return;
  const rows = activePushTokens();
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
      android: { priority: 'high', notification: { channelId: ANDROID_CHANNEL, ...(tag ? { tag } : {}) } },
      ...(tag ? { apns: { headers: { 'apns-collapse-id': tag } } } : {}),
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
