import db from '../db.js';

// WHO is making this request, as it should be written into a history row (#552): the camera history's
// silence / restart / reboot rows and the morning review's "Answered by".
//
// ⚠️ THE USERNAME, NEVER first_name (review finding A6). Anyone can set their own first name to anything
// (PUT /api/auth/me), so a caregiver whose first name is "Admin" could put an admin's name on what they
// did. A username is set only by an admin (PUT /api/auth/users/:id is admin-only) and is UNIQUE (db.js,
// the users table), so it names one account and the person cannot choose it.
//
// ⚠️ THE DATABASE DECIDES, NOT THE TOKEN, the same rule middleware/auth.js applies to the role (issue
// #261): the session token carries the username it was minted with, and an admin can rename the account
// afterwards, so the claim can be up to 30 days stale. The row is read through the session id, joined to
// the user's CURRENT row.
//
// ⚠️ CALL IT BEFORE ANY `await`. requireAuth has just proved the session and user rows exist, and nothing
// can delete them while the handler runs synchronously; after an await they can be gone (an admin deleting
// the account mid-restart). Read first, the row names the person as they were when they acted.
//
// If the row IS gone (a caller that read it late), it falls back to the verified token's own id and
// username rather than returning null, so a person is never recorded as the system. Returns null only
// for a request with no signed-in user at all.
//
// Returned as a plain `{ user_id, username }`, copied into the history row (like camera_name), so a later
// rename or a deleted account cannot rewrite what happened.
const sessionUserStmt = db.prepare(
  'SELECT u.id AS user_id, u.username AS username FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?'
);

export function actorOf(req) {
  const user = req?.user;
  if (!user) return null;
  const row = user.sid ? sessionUserStmt.get(user.sid) : null;
  if (row) return { user_id: row.user_id, username: row.username };
  return { user_id: user.id ?? null, username: user.username ?? null };
}
