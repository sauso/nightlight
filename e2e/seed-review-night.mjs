// Seed reviewable nights, so the sleep specs have something to work on.
//
// Runs INSIDE the app container (it imports the app's own modules), driven by test.sh:
//   docker compose cp seed-review-night.mjs nightlight:/tmp/
//   docker compose exec -T nightlight node /tmp/seed-review-night.mjs
//
// ⚠️ WHAT THIS DOES AND DOES NOT PROVE. It writes `sleep_nights` rows directly rather than producing
// them from camera activity, so the specs that follow do NOT test sleep detection. They test the
// REVIEW and RECOMPUTE round trips — precisely the seams that produced defects the owner found by hand
// on first use, and precisely the seams a frontend unit test cannot span (it has no server) nor a
// backend unit test (it has no browser).
//
// ★ ONE CHILD PER SPEC, deliberately. The review spec CORRECTS its night, which changes what the sleep
// detail page displays and sets `corrected` on it. Sharing a child would make the recompute spec's
// result depend on whether the review spec had run first — the kind of order-coupling that turns a
// suite into a coin toss.
//
// The night date is not hard-coded: it is whatever the app itself considers the last completed night,
// computed by the same function the feature uses. Hard-coding a date would make the specs pass or fail
// depending on the hour they ran.
import db from '/app/src/db.js';
import { lastCompletedNightDate } from '/app/src/lib/sleepAnalysis.js';

// The third child exists for the one-question review's WAKE-ONLY answer (07-morning-review.spec.js): that spec
// answers a night with a wake alone and reads back that nothing else was stored, which would collide with the
// review kid's own story if they shared a night.
//
// ⚠️ WHAT THIS CANNOT SEED (2026-10-27). The review screen's "That's right" needs the live recompute to find a
// wake, and that needs an enabled camera with activity samples for the child. This fixture seeds
// nights without camera activity, so the screen opens on its time field. The "That's right" button is covered by the unit tests
// (frontend/test/MorningReview.test.jsx) while the e2e proves the same request body over the real wire.
const CHILDREN = [
  { id: 'e2e-review-kid', name: 'Review Kid' },
  { id: 'e2e-recompute-kid', name: 'Recompute Kid' },
  { id: 'e2e-wakeonly-kid', name: 'Wake Only Kid' },
];

// ★ THE SLEEP WINDOW NEVER CONTAINS "NOW" (UI refresh PR H). It used to be the fixed 19:00-07:00, and the child page's night card
// (and the morning question under it) follow /sleep/live, which reports tonight IN PROGRESS whenever a window is open: a run
// that started at 21:00 got "Tonight · so far" and no question, so 07-morning-review failed by time of day. The window is now a
// single hour that starts two hours from now, in the app's own timezone (the zone the window is read in), so no window is open
// for the rest of the run and /sleep/live answers with the last completed night at any hour. The seeded night's own times are
// unchanged and independent of the window.
const tz = db.prepare('SELECT timezone FROM settings WHERE id = ?').get('app')?.timezone || 'UTC';
const hhmmAt = (ms) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).format(new Date(ms));
const WINDOW_START = hhmmAt(Date.now() + 2 * 3600 * 1000);
const WINDOW_END = hhmmAt(Date.now() + 3 * 3600 * 1000);

for (const { id, name } of CHILDREN) {
  // A child who tracks sleep, with a window that is not open now (see above).
  db.prepare(
    `INSERT INTO children (id, name, track_sleep, sleep_window_start, sleep_window_end)
     VALUES (@id, @name, 1, @ws, @we)
     ON CONFLICT(id) DO UPDATE SET track_sleep = 1, sleep_window_start = @ws, sleep_window_end = @we`
  ).run({ id, name, ws: WINDOW_START, we: WINDOW_END });

  const nightDate = lastCompletedNightDate(id);
  if (!nightDate) {
    console.error(`no completed night available to seed for ${id}`);
    process.exit(1);
  }

  // Times are stored UTC. 09:33Z / 19:48Z are 19:33 and 05:48 in Melbourne — chosen so that a naive
  // "just slice the string" bug in the client would render 09:33 and be obvious.
  const onset = `${nightDate} 09:33:00`;
  const [y, m, d] = nightDate.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  const wake = `${next} 19:48:00`;

  db.prepare('DELETE FROM sleep_reviews WHERE child_id = ?').run(id);
  db.prepare('DELETE FROM sleep_nights WHERE child_id = ?').run(id);
  db.prepare(
    `INSERT INTO sleep_nights
       (child_id, night_date, window_start, window_end, status, onset_at, wake_at,
        asleep_minutes, awake_minutes, wake_count, longest_stretch_minutes, coverage_minutes)
     VALUES (@child, @night, @onset, @wake, 'ok', @onset, @wake, 555, 60, 2, 300, 720)`
  ).run({ child: id, night: nightDate, onset, wake });

  console.log(`seeded ${name} (${id}) night ${nightDate}: onset ${onset}, wake ${wake}`);
}
