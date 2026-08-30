import db from '../db.js';
import { computeNight, lastCompletedNightDate, childTracksSleep, zonedToUtc, toSqlUtc } from './sleepAnalysis.js';
import { getBedTransitions } from './bedTransitions.js';

// What actually happened last night, as told by the person who was there.
//
// Why this exists: every sleep change so far has been judged against the owner's recollection the next
// morning — "around 6am". That was fine while the errors were hours; it stopped being fine when they
// reached ~10 minutes, because the error became smaller than the measurement. Worse, the same handful
// of nights was used to design a change AND to validate it, so nothing was ever held out. This turns a
// morning's recollection into dated, precise, replayable data, captured while it is still fresh.
//
// It is not analysis and it is not a setting: nothing here feeds back into computeNight. It records
// what was true, so a future change can be scored rather than argued about.

const REVIEW_WINDOW_HOURS = 20; // wide enough for any bedtime and any lie-in, on either side of midnight

export const VERDICTS = Object.freeze(['correct', 'wrong', 'unclear']);

// A wall-clock 'HH:MM' the person read off their own clock -> the UTC timestamp everything else in
// this database is stored as.
//
// Done HERE and not in the browser, deliberately. The rest of the app renders times in the app's
// CONFIGURED timezone (settings.timezone), so converting with the browser's zone instead would make a
// review typed on a travelling phone disagree with the card it was correcting — and it would duplicate
// timezone maths that already exists, tested, in sleepAnalysis. `zonedToUtc` carries the DST refinement
// pass; hand-rolling this is how the daylight-saving bug in `localDateStr` got there in the first place.
//
// The night spans midnight, so a bare time is ambiguous: an hour at or after noon belongs to the
// night's own date, an hour before noon to the morning after. That resolves 19:33 to the night's date,
// 05:48 to the next morning, and a child put down at 00:30 to the next morning too.
//
// Returns null for empty (nothing recorded), or undefined for malformed — the caller must tell those
// apart, because storing a garbled time as "nothing" would silently lose ground truth.
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const appTz = () => db.prepare("SELECT timezone FROM settings WHERE id = 'app'").get()?.timezone || 'UTC';

export function localHmToUtcSql(nightDate, hhmm) {
  if (hhmm == null || hhmm === '') return null;
  const m = HHMM.exec(String(hhmm));
  if (!m) return undefined;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  const [y, mo, d] = nightDate.split('-').map(Number);
  return toSqlUtc(zonedToUtc(y, mo - 1, d + (h < 12 ? 1 : 0), h, mi, appTz()));
}

const getReviewStmt = db.prepare('SELECT * FROM sleep_reviews WHERE child_id = ? AND night_date = ?');

const upsertReviewStmt = db.prepare(
  `INSERT INTO sleep_reviews
     (child_id, night_date, true_onset_at, true_wake_at, computed_onset_at, computed_wake_at, note,
      dismissed, reviewed_at)
   VALUES (@child_id, @night_date, @true_onset_at, @true_wake_at, @computed_onset_at, @computed_wake_at,
           @note, @dismissed, datetime('now'))
   ON CONFLICT(child_id, night_date) DO UPDATE SET
     true_onset_at     = excluded.true_onset_at,
     true_wake_at      = excluded.true_wake_at,
     computed_onset_at = excluded.computed_onset_at,
     computed_wake_at  = excluded.computed_wake_at,
     note              = excluded.note,
     dismissed         = excluded.dismissed,
     reviewed_at       = datetime('now')`
);

// The child's cameras in the same order the analysis picks its scoring camera, so the frames shown are
// the ones the decisions were actually made from.
const camsForChild = db.prepare(
  'SELECT id, name FROM cameras WHERE child_id = ? AND disabled = 0 ORDER BY sort_order, id'
);

// A generous fixed span rather than the child's configured sleep window: the review shows what
// HAPPENED, and an event landing outside the window is exactly the sort of thing worth being able to
// see. Anchored at 04:00 UTC on the night's date — early afternoon in Melbourne, before any plausible
// bedtime — and running 20 hours from there.
function nightBounds(nightDate) {
  const start = new Date(`${nightDate}T04:00:00Z`);
  const end = new Date(start.getTime() + REVIEW_WINDOW_HOURS * 3600 * 1000);
  const sql = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
  return { startSql: sql(start), endSql: sql(end) };
}

function transitionsFor(childId, nightDate) {
  const cams = camsForChild.all(childId);
  const byId = new Map(cams.map((c) => [c.id, c.name]));
  const { startSql, endSql } = nightBounds(nightDate);
  return getBedTransitions(cams.map((c) => c.id), startSql, endSql).map((t) => ({
    ...t,
    camera_name: byId.get(t.camera_id) || null,
  }));
}

// Everything the review screen needs for one night: what the app currently says, what a person has
// already said, and every recorded transition with whether it has a frame and a verdict.
export function getNightReview(childId, nightDate) {
  const computed = computeNight(childId, nightDate);
  return {
    child_id: childId,
    night_date: nightDate,
    computed: {
      status: computed.status,
      onset_at: computed.onset_at ?? null,
      wake_at: computed.wake_at ?? null,
      asleep_minutes: computed.asleep_minutes ?? null,
      wake_count: computed.wake_count ?? null,
    },
    review: getReviewStmt.get(childId, nightDate) || null,
    transitions: transitionsFor(childId, nightDate),
  };
}

// Save a review. `computed_*` is captured HERE, from what the app says at this moment, rather than
// trusted from the client — a completed night's computed wake genuinely moves through the morning
// (measured 2026-08-29: 05:51 at 08:16 and 08:31 at 09:50, same night, same data, as ordinary daytime
// activity accumulates inside the analysis lookahead). Storing the judged pair together is what makes
// "were we right about this night" a fixed fact rather than one that quietly re-decides itself later.
export function saveNightReview(childId, nightDate, { trueOnsetAt, trueWakeAt, note, dismissed } = {}) {
  const computed = computeNight(childId, nightDate);
  upsertReviewStmt.run({
    child_id: childId,
    night_date: nightDate,
    true_onset_at: trueOnsetAt ?? null,
    true_wake_at: trueWakeAt ?? null,
    computed_onset_at: computed.onset_at ?? null,
    computed_wake_at: computed.wake_at ?? null,
    note: note ?? null,
    dismissed: dismissed ? 1 : 0,
  });
  return getReviewStmt.get(childId, nightDate);
}

// Is there a night waiting to be reviewed? Drives the card on the child's page.
//
// The most recent scored, unreviewed night within the last week — NOT simply "yesterday". Anchoring on
// yesterday alone means a morning you don't open the app loses that night permanently, and the nights
// most worth asking about are exactly the ones on the days you were too busy to look. A week's backlog
// is the compromise: recent enough that you still remember it, forgiving enough to survive a weekend
// away. Older than that and recollection is no better than the detector's guess, which would poison
// the ground truth this whole table exists to hold.
const REVIEW_BACKLOG_NIGHTS = 7;

const pendingStmt = db.prepare(
  `SELECT n.night_date, n.onset_at, n.wake_at
     FROM sleep_nights n
     LEFT JOIN sleep_reviews r ON r.child_id = n.child_id AND r.night_date = n.night_date
    WHERE n.child_id = ? AND n.status = 'ok' AND n.night_date >= ? AND r.child_id IS NULL
    ORDER BY n.night_date DESC
    LIMIT 1`
);

export function pendingReview(childId) {
  if (!childTracksSleep(childId)) return null;
  // Anchored on the last completed night rather than on `new Date()` so the cutoff uses the app's
  // configured timezone — the same calendar the nights themselves are dated in. Shifting the DATE on
  // the calendar, never the instant: subtracting milliseconds crosses a daylight-saving boundary twice
  // a year and silently drops or repeats a night.
  const anchor = lastCompletedNightDate(childId);
  if (!anchor) return null;
  const [y, m, d] = anchor.split('-').map(Number);
  const cutoff = new Date(Date.UTC(y, m - 1, d - (REVIEW_BACKLOG_NIGHTS - 1))).toISOString().slice(0, 10);

  // Only nights there is something to be right or wrong about: 'no_data' and 'empty' carry no times to
  // confirm, and asking anyway would teach the habit of dismissing the card unread — which would cost
  // exactly the nights that matter. The LEFT JOIN excludes anything already answered OR dismissed.
  const stored = pendingStmt.get(childId, cutoff);
  if (!stored) return null;
  return {
    night_date: stored.night_date,
    onset_at: stored.onset_at,
    wake_at: stored.wake_at,
    transition_count: transitionsFor(childId, stored.night_date).length,
  };
}
