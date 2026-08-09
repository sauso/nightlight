import db from '../db.js';

// Shared "is this camera inside its motion-alert window right now?" logic, used by BOTH detection
// sources (frame-diff in motionDetector.js and camera-native over MQTT in mqttClient.js) so the
// quiet-hours schedule behaves identically no matter how motion was detected.

// Current minutes-since-midnight (0..1439) in the app's configured timezone. Falls back to UTC if
// the timezone lookup/format ever fails.
export function nowMinutesInAppTz() {
  let tz = 'UTC';
  try {
    tz = db.prepare('SELECT timezone FROM settings WHERE id = ?').get('app')?.timezone || 'UTC';
  } catch { /* keep UTC */ }
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date());
    const h = Number(parts.find((p) => p.type === 'hour').value);
    const m = Number(parts.find((p) => p.type === 'minute').value);
    return (h % 24) * 60 + m;
  } catch {
    const d = new Date();
    return d.getUTCHours() * 60 + d.getUTCMinutes();
  }
}

// Is this camera inside its motion-alert window right now? True when no schedule is set. Handles
// windows that wrap midnight (start > end, e.g. 20:00–07:00). A zero-length window (start == end) is
// treated as "always on" rather than "never".
export function inActiveWindow(camera) {
  if (!camera.detect_schedule_enabled) return true;
  const start = camera.detect_start | 0;
  const end = camera.detect_end | 0;
  if (start === end) return true;
  const now = nowMinutesInAppTz();
  return start < end ? now >= start && now < end : now >= start || now < end;
}
