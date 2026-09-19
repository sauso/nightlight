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

// ROADMAP §1.6: `settings.sleep_report_alert_enabled` defaults ON even when nothing is actually
// configured to deliver it (push needs a mounted FCM credential; Pushover/ntfy/Gotify default off) — a
// caller that only checks the toggle would treat "nothing was sent" the same as "a report went out",
// which matters once a night's notify-history is tracked. Checked here, next to the *Enabled() checks
// it mirrors, rather than reimplemented at each call site.
export function sleepAlertChannelsConfigured() {
  return pushEnabled() || pushoverEnabled() || ntfyEnabled() || gotifyEnabled();
}

// A tag lets a LATER notification (e.g. a §1.6 follow-up) replace an earlier one in the tray instead of
// sitting alongside it as a second, contradictory message — push.js threads this into BOTH Android's
// notification.tag and APNs' apns-collapse-id. Only meaningful for a single child's report — there's no
// coherent way to tag one combined multi-child message — and both childId and nightDate must be
// present: a missing field would otherwise produce a literal `sleep_report_undefined_undefined` tag,
// which is worse than no tag (it would collapse UNRELATED children/nights onto each other). Pushover/
// ntfy/Gotify have no equivalent parameter to receive this.
function reportTag(reports) {
  if (reports.length !== 1) return null;
  const { childId, nightDate } = reports[0];
  return childId != null && nightDate ? `sleep_report_${childId}_${nightDate}` : null;
}

function fanOut(title, body, type, tag) {
  const url = link();
  if (pushEnabled()) {
    sendToAll(title, body, { type }, null, tag ? { tag } : undefined).catch(() => {});
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

// reports: [{ name, summary, childId, nightDate }] — one entry per freshly-computed child this run.
export function notifySleepReports(reports) {
  if (!reports || reports.length === 0) return;
  const tz = appTz();
  const title = reports.length === 1 ? `Sleep report — ${reports[0].name}` : 'Sleep reports ready';
  const body = reports.map((r) => lineFor(r.name, r.summary, tz)).join('\n');
  logger.info(`[sleep-alert] ${title}: ${body.replace(/\n/g, ' | ')}`);
  fanOut(title, body, 'sleep_report', reportTag(reports));
}

// ROADMAP §1.6: a LATER recompute resolved a wake time that was still unknown when the parent was first
// told. Capped by the caller (runNightlySleepJob — notified_wake_at's own nullness is the one-shot cap,
// no separate counter); this function fires unconditionally for whatever it's given, same fire-and-forget
// contract as notifySleepReports. Reuses lineFor() as-is: the null->real transition already changes the
// rendered string shape correctly (the "up HH:MM" clause appears), which is exactly what needs conveying.
export function notifySleepReportUpdates(reports) {
  if (!reports || reports.length === 0) return;
  const tz = appTz();
  const title = reports.length === 1 ? `Sleep report updated — ${reports[0].name}` : 'Sleep reports updated';
  const body = reports.map((r) => lineFor(r.name, r.summary, tz)).join('\n');
  logger.info(`[sleep-alert] ${title}: ${body.replace(/\n/g, ' | ')}`);
  fanOut(title, body, 'sleep_report_update', reportTag(reports));
}
