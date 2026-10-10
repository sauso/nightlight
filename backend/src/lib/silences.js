import db from '../db.js';
import { logger } from './logger.js';
import { notifyLongSilence } from './cameraStatusAlert.js';

// The long-silence notice (#552). Anyone signed in, caregivers included, can silence every alert from a camera
// from its tile (owner decision 2026-10-10: an in-the-moment action, it stays open). One silence is capped (an
// hour on the tile, 12 hours at the server), but nothing stopped a camera being silenced again and again, and a
// silence hides that camera's alerts from everyone. So the admins are told, ONCE, when one camera's alerts are
// kept silenced for longer than Settings > Camera controls > Long silence alerts allows (default 60 minutes,
// range 1-719, on by default). Camera history (lib/cameraEvents.js) is still the full record of who did what;
// this is only the nudge.
//
// WHAT COUNTS AS ONE SILENCE (an "episode", one row per camera in camera_silences, see db.js): consecutive
// silences of one camera, each set no later than REJOIN_GAP_MS after the previous one ended, count as one. Its
// length runs from the first silence's start to the latest one's end, the short breaks between them included.
// The check runs when a silence is SET (there is no timer): a silence that makes the episode long enough notifies
// at once, before it has run, and an un-mute afterwards does not take the notice back.
//
// ⚠️ REJOIN_GAP_MS = 30 minutes is NOT MEASURED. The owner accepted it on 2026-10-10 as a starting point; no
// house's renewal pattern was recorded to set it. Why there has to be a gap at all: the tile HIDES its silence
// buttons while the camera is muted (CameraTile.jsx), so from the tile a renewal can only come after the silence
// has run out or been un-muted, usually when the next alert arrives a few minutes later. "Only a renewal while
// still muted continues the count" would therefore never see a renewal from the tile, every silence would be an
// episode of its own of at most an hour, and at the default threshold the notice would never fire. Why 30: long
// enough to cover "it ran out, the next alert came, I silenced it again", short enough that two silences an
// evening apart are not called one. For everyone else: where renewals come more than 30 minutes after the
// previous silence ended, each starts a new count, so repeated silences each at or under the threshold, with
// longer breaks between them, NEVER notify. A documented known limit (docs/camera-controls.md), not a bug.
export const REJOIN_GAP_MS = 30 * 60_000;

const selectStmt = db.prepare('SELECT started_at, ended_at, notified FROM camera_silences WHERE camera_id = ?');
// A new episode replaces the camera's previous one (one row per camera: only the latest episode matters).
const startStmt = db.prepare(
  `INSERT INTO camera_silences (camera_id, started_at, ended_at, notified) VALUES (?, ?, ?, 0)
   ON CONFLICT(camera_id) DO UPDATE SET started_at = excluded.started_at, ended_at = excluded.ended_at, notified = 0`
);
const continueStmt = db.prepare('UPDATE camera_silences SET ended_at = ? WHERE camera_id = ?');
// MIN(ended_at, now) without a write when it would change nothing: the WHERE skips an episode that already ended.
const endEarlyStmt = db.prepare('UPDATE camera_silences SET ended_at = ? WHERE camera_id = ? AND ended_at > ?');
const settingsStmt = db.prepare("SELECT snooze_alert_enabled, snooze_alert_minutes FROM settings WHERE id = 'app'");
const claimStmt = db.prepare('UPDATE camera_silences SET notified = 1 WHERE camera_id = ? AND notified = 0');

/**
 * Record a silence, or an un-mute, in the camera's episode. Called ONLY inside the snooze route's transaction
 * (routes/cameras.js), after its "un-mute of a camera that is not muted" guard, so the episode moves exactly when
 * the mute does and rolls back with it. A failed write throws, and the route then applies nothing, as it does
 * when the Camera history row cannot be written: a silence the notice cannot count is not applied.
 *
 *   mute (`until` set): if the camera's episode ended no more than REJOIN_GAP_MS before `now` (inclusive), this
 *     silence continues it, keeping its start and whether it was already notified; otherwise a new episode starts
 *     at `now`, not yet notified. Either way the episode now ends at `until`, which can be EARLIER than before (a
 *     15-minute silence set over a 60-minute one replaces it, exactly as the mute itself does).
 *     A mute whose `now` is EARLIER than the episode's start (the server clock was set back: NTP, a host whose
 *     clock was wrong at boot) also starts a new episode (PR #664 review, reproduced): continuing would store an
 *     end before the start, a negative length that can never notify, for as long as the renewals keep coming.
 *   un-mute (`until` null): bring the end forward to `now`, never later. The episode is NOT closed, so a re-mute
 *     within the gap continues it: un-mute then re-mute cannot reset the count. An un-mute of an episode that has
 *     already ended, or of a camera with none, writes nothing (the route does not even call this then: since
 *     PR #663 a no-op un-mute writes nothing at all, and this keeps to that if it ever is called).
 *
 * `now` and `until` are epoch millis passed in by the caller, never read here, so the route's one clock reading
 * is used throughout and tests can replay any timing exactly.
 */
export function noteSilence(cameraId, now, until) {
  if (until) {
    const row = selectStmt.get(cameraId);
    if (row && now >= row.started_at && now <= row.ended_at + REJOIN_GAP_MS) continueStmt.run(until, cameraId);
    else startStmt.run(cameraId, now, until);
    return;
  }
  endEarlyStmt.run(now, cameraId, now);
}

/**
 * Whether the camera's episode is now long enough to tell the admins, decided ONCE per episode. Returns the
 * episode's length in ms when this call has claimed the notice, or null (off, short enough, or already told).
 * Reads the settings every time, so turning the setting on or off or changing the threshold applies to the next
 * silence without a restart (a silence already notified stays notified).
 */
export function claimLongSilenceNotice(cameraId) {
  const s = settingsStmt.get();
  if (!s?.snooze_alert_enabled) return null;
  const row = selectStmt.get(cameraId);
  if (!row) return null;
  const length = row.ended_at - row.started_at;
  // Strictly MORE than the threshold, so at the default 60 one press of the tile's longest button (exactly 60
  // minutes) never notifies and its first renewal does. This is also why the setting's ceiling is 719, not 720
  // (routes/settings.js): the longest single silence the server accepts is 720 minutes.
  if (!(length > s.snooze_alert_minutes * 60_000)) return null;
  // The claim is a conditional UPDATE, not a read of `notified`: only the call that flips 0 to 1 sends, so two
  // silences of the same episode can never both notify. (better-sqlite3 is synchronous and the snooze route has no
  // await, so two requests cannot interleave in one process today; the UPDATE keeps that true if either changes.)
  return claimStmt.run(cameraId).changes === 1 ? length : null;
}

/**
 * After a silence has COMMITTED: claim the notice and send it. NEVER throws: everything here, including the
 * settings read, is inside the try, so the notice can neither fail the silence nor roll it back (the silence is
 * already applied and recorded by the time this runs; answering 500 now would tell the person it was not). A
 * failure is logged and the notice is lost for this episode if it had already been claimed; Camera history still
 * has every silence. Only a mute calls this: an un-mute can only shorten an episode, never make it long enough.
 * Returns whether a notice was sent (for tests and the log).
 */
export function sendLongSilenceNotice(cam, actor) {
  try {
    const length = claimLongSilenceNotice(cam.id);
    if (length === null) return false;
    // Rounded UP, so the minutes shown are never at or below a threshold the episode was strictly above. Only the
    // account id goes on (to leave that person's own devices out); no username, see notifyLongSilence.
    notifyLongSilence(cam, Math.ceil(length / 60_000), actor?.user_id ?? null);
    return true;
  } catch (err) {
    logger.error(`[silence-alert] "${cam.name}": the long-silence notice was not sent (${err.message})`);
    return false;
  }
}
