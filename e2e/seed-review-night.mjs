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

const CHILDREN = [
  { id: 'e2e-review-kid', name: 'Review Kid' },
  { id: 'e2e-recompute-kid', name: 'Recompute Kid' },
];

for (const { id, name } of CHILDREN) {
  // A child who tracks sleep, with a wide window so the night has certainly ended whenever this runs.
  db.prepare(
    `INSERT INTO children (id, name, track_sleep, sleep_window_start, sleep_window_end)
     VALUES (@id, @name, 1, '19:00', '07:00')
     ON CONFLICT(id) DO UPDATE SET track_sleep = 1, sleep_window_start = '19:00', sleep_window_end = '07:00'`
  ).run({ id, name });

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
