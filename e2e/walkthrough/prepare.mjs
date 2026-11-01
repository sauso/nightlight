// Run once after demoSeed.js, inside the throwaway walkthrough container (start.sh).
// Turns the seeded demo household into an ordinary install the captures can sign in to and write to:
//   - the read-only guest is replaced by a real admin and a caregiver (fictional names, throwaway passwords);
//   - the first child's seeded "reviewed" last night is un-reviewed, so the morning-review prompt shows.
// Never point this at a real database: it deletes users.
import db from '/app/src/db.js';
import { hash } from '/app/src/lib/passwordHash.js';

export const ADMIN = { id: 'walk-admin', username: 'sam', password: 'walkthrough-admin-1', first: 'Sam', last: 'Rivera', role: 'admin' };
export const CAREGIVER = { id: 'walk-caregiver', username: 'jordan', password: 'walkthrough-care-1', first: 'Jordan', last: 'Lee', role: 'caregiver' };

db.prepare("DELETE FROM users WHERE username = 'demo-guest'").run();
const insert = db.prepare(
  'INSERT INTO users (id, username, password_hash, role, first_name, last_name) VALUES (?, ?, ?, ?, ?, ?)'
);
for (const u of [ADMIN, CAREGIVER]) {
  insert.run(u.id, u.username, await hash(u.password), u.role, u.first, u.last);
}

const night = db.prepare("SELECT MAX(night_date) AS d FROM sleep_reviews WHERE child_id = 'demo-child-avery'").get().d;
db.prepare("DELETE FROM sleep_reviews WHERE child_id = 'demo-child-avery' AND night_date = ?").run(night);
console.log(`walkthrough: admin ${ADMIN.username}, caregiver ${CAREGIVER.username}, review pending for ${night}`);
process.exit(0);
