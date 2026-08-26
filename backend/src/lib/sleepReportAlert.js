import db from '../db.js';
import { logger } from './logger.js';
import { sendToAll, pushEnabled, getPublicBaseUrl } from './push.js';
import { pushoverEnabled, sendPushover } from './pushover.js';
import { ntfyEnabled, sendNtfy } from './ntfy.js';
import { gotifyEnabled, sendGotify } from './gotify.js';

// Push notification fired once when a child's nightly sleep report is computed (the sleep window has
// closed and runNightlySleepJob has stored the row). Same multi-provider fan-out as cameraStatusAlert.js.
// Freshness is gated by the caller (only fires for a night whose window just closed, so a mid-day
// container restart re-computing an old night does NOT re-notify).

function appTz() {
  try {
    return db.prepare('SELECT timezone FROM settings WHERE id = ?').get('app')?.timezone || 'UTC';
  } catch {
    return 'UTC';
  }
}

// UTC 'YYYY-MM-DD HH:MM:SS' -> local 'HH:MM' in the app timezone.
function localHm(sqlUtc, tz) {
  if (!sqlUtc) return null;
  try {
    return new Date(sqlUtc.replace(' ', 'T') + 'Z').toLocaleTimeString('en-GB', {
      timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
  } catch {
    return null;
  }
}

function fmtDur(min) {
  if (min == null) return '?';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h}h${String(m).padStart(2, '0')}`;
}

// Build the one-line summary for a single child's night.
function lineFor(name, summary, tz) {
  // An empty bed is a real observation, not missing data — say so, rather than lumping it in with
  // "no sleep data" (which reads as a broken camera) or inventing a night's sleep for it.
  if (summary?.status === 'empty') return `${name}: no one in the bed`;
  if (!summary || summary.status !== 'ok') return `${name}: no sleep data`;
  const wake = localHm(summary.wake_at, tz);
  const parts = [`asleep ${fmtDur(summary.asleep_minutes)}`, `${summary.wake_count} wake${summary.wake_count === 1 ? '' : 's'}`];
  if (wake) parts.push(`up ${wake}`);
  return `${name}: ${parts.join(', ')}`;
}

function link() {
  const server = getPublicBaseUrl();
  return server ? `nightlight://sleep?server=${encodeURIComponent(server)}` : 'nightlight://sleep';
}

// reports: [{ name, summary }] — one entry per freshly-computed child this run.
export function notifySleepReports(reports) {
  if (!reports || reports.length === 0) return;
  const tz = appTz();
  const title = reports.length === 1 ? `Sleep report — ${reports[0].name}` : 'Sleep reports ready';
  const body = reports.map((r) => lineFor(r.name, r.summary, tz)).join('\n');
  logger.info(`[sleep-alert] ${title}: ${body.replace(/\n/g, ' | ')}`);
  const url = link();
  if (pushEnabled()) {
    sendToAll(title, body, { type: 'sleep_report' }).catch(() => {});
  }
  if (pushoverEnabled()) {
    sendPushover({ title, message: body, url, urlTitle: 'Open in Nightlight' })
      .catch((e) => logger.error(`[pushover] sleep report alert failed: ${e.message}`));
  }
  if (ntfyEnabled()) {
    sendNtfy({ title, message: body, click: url, priority: 3 })
      .catch((e) => logger.error(`[ntfy] sleep report alert failed: ${e.message}`));
  }
  if (gotifyEnabled()) {
    sendGotify({ title, message: body, click: url })
      .catch((e) => logger.error(`[gotify] sleep report alert failed: ${e.message}`));
  }
}
