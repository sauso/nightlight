// Seed one reviewable night, so the morning-review e2e has something to review.
//
// Runs INSIDE the app container (it imports the app's own modules), driven by test.sh:
//   docker compose cp seed-review-night.mjs nightlight:/tmp/
//   docker compose exec -T nightlight node /tmp/seed-review-night.mjs
//
// ⚠️ WHAT THIS DOES AND DOES NOT PROVE. It writes a `sleep_nights` row directly rather than producing
// one from camera activity, so the spec that follows does NOT test sleep detection. It tests the
// REVIEW round trip — the card reading server state, a correction being written, and the result coming
// back — which is precisely the seam that produced three defects the owner found by hand on first use,
// and precisely the seam a frontend unit test cannot span (it has no server) nor a backend unit test
// (it has no browser).
//
// The night date is not hard-coded: it is whatever the app itself considers the last completed night
// for this child, computed by the same function the feature uses. Hard-coding a date would make the
// spec pass or fail depending on the hour it ran.
import db from '/app/src/db.js';
import { lastCompletedNightDate } from '/app/src/lib/sleepAnalysis.js';

const CHILD_ID = 'e2e-review-kid';
const CHILD_NAME = 'Review Kid';

// A child who tracks sleep, with a wide window so the night has certainly ended whenever this runs.
db.prepare(
  `INSERT INTO children (id, name, track_sleep, sleep_window_start, sleep_window_end)
   VALUES (@id, @name, 1, '19:00', '07:00')
   ON CONFLICT(id) DO UPDATE SET track_sleep = 1, sleep_window_start = '19:00', sleep_window_end = '07:00'`
).run({ id: CHILD_ID, name: CHILD_NAME });

const nightDate = lastCompletedNightDate(CHILD_ID);
if (!nightDate) {
  console.error('no completed night available to seed');
  process.exit(1);
}

// Times are stored UTC. 09:33Z / 19:48Z are 19:33 and 05:48 in Melbourne, which is what the card
// should render for the default e2e timezone — chosen so a naive "just slice the string" bug in the
// client would show 09:33 and be obvious.
const onset = `${nightDate} 09:33:00`;
const [y, m, d] = nightDate.split('-').map(Number);
const next = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
const wake = `${next} 19:48:00`;

db.prepare('DELETE FROM sleep_reviews WHERE child_id = ?').run(CHILD_ID);
db.prepare('DELETE FROM sleep_nights WHERE child_id = ?').run(CHILD_ID);
db.prepare(
  `INSERT INTO sleep_nights
     (child_id, night_date, window_start, window_end, status, onset_at, wake_at,
      asleep_minutes, awake_minutes, wake_count, longest_stretch_minutes, coverage_minutes)
   VALUES (@child, @night, @onset, @wake, 'ok', @onset, @wake, 555, 60, 2, 300, 720)`
).run({ child: CHILD_ID, night: nightDate, onset, wake });

console.log(`seeded ${CHILD_NAME} (${CHILD_ID}) night ${nightDate}: onset ${onset}, wake ${wake}`);
