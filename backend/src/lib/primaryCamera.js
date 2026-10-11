import db from '../db.js';

// THE ONE ANSWER to "which camera is this child's primary camera?" (#655).
//
// Why this file exists: until #655 the answer was "the first enabled camera in `cameras.sort_order`", and
// sort_order is the order of the tiles on the Live page. So dragging a tile, a purely cosmetic action,
// silently changed which camera a child's stored sleep numbers came from. A child can now name a primary
// camera explicitly (`children.primary_camera_id`, admin-only to change, see routes/children.js).
//
// NULL (the default, and every child that existed before #655) keeps the old rule EXACTLY, so an existing
// install and a single-camera child behave byte-for-byte as before. That is a hard requirement, not a
// nicety: the scoring query and the timelapse query never agreed on a tie-break for two cameras with the
// same sort_order (`id` vs `rowid`), and unifying them here would quietly move one of them. So the caller
// says which tie-break it has always used, and this file keeps it (`TIE_BREAKS` below).
//
// Dependency-free on purpose (only db.js): sleepAnalysis.js, timelapse.js and routes/children.js all
// import it, and anything heavier risks an import cycle through sleepAnalysis.js.

// The columns every caller needs: scoring reads id/name, the timelapse sampler reads mediamtx_path and
// snapshot_url (the column list its own query used to select, plus name).
const COLUMNS = 'id, name, mediamtx_path, snapshot_url';

// Each caller's historical tie-break for two enabled cameras with the SAME sort_order. Both put a lower
// sort_order first; they differ only on a tie. Kept apart deliberately, see the header.
//   'id'    — lib/sleepAnalysis.js (scoring, the only path that writes a stored number) and the
//             `primary_camera` shown in the child's settings (which names the camera scoring will use).
//   'rowid' — lib/timelapse.js (the nightly timelapse's frame sampler).
const TIE_BREAKS = {
  id: 'ORDER BY sort_order, id',
  rowid: 'ORDER BY sort_order ASC, rowid ASC',
};

const childPrimaryStmt = db.prepare('SELECT primary_camera_id FROM children WHERE id = ?');
// The named camera counts only while it is STILL this child's AND still enabled. Re-checked on every call
// rather than trusted from the column, because the column is not kept in step with every change:
//   - child_id = ?: a camera reassigned to another child must never score this one (routes/cameras.js
//     clears the pointer on reassignment, but a pointer written any other way, or a restore of an old
//     database, must not be able to read another child's camera);
//   - disabled = 0: a turned-off camera has no stream and no fresh samples (its RTSP source may be gone),
//     the same reason the fallback below has always skipped it. The pointer is deliberately NOT cleared
//     on disable, so turning the camera back on makes it the primary again (pinned by a test).
// A deleted camera simply matches nothing here. In every one of these cases the child falls back to the
// sort_order rule, the same answer a child with no primary gets.
const namedEligibleStmt = db.prepare(
  `SELECT ${COLUMNS} FROM cameras WHERE id = ? AND child_id = ? AND disabled = 0`
);
const fallbackStmts = Object.fromEntries(
  Object.entries(TIE_BREAKS).map(([k, order]) => [
    k,
    db.prepare(`SELECT ${COLUMNS} FROM cameras WHERE child_id = ? AND disabled = 0 ${order} LIMIT 1`),
  ])
);

// The full camera row ({ id, name, mediamtx_path, snapshot_url }) of the camera this child's night is
// measured from, or null when the child has no enabled camera at all.
export function primaryCameraRowFor(childId, { tieBreak = 'id' } = {}) {
  const fallback = fallbackStmts[tieBreak];
  // A typo'd tie-break must fail loudly in a test, not silently pick some third ordering.
  if (!fallback) throw new Error(`primaryCameraRowFor: unknown tieBreak ${JSON.stringify(tieBreak)}`);
  const named = childPrimaryStmt.get(childId)?.primary_camera_id;
  if (named) {
    const row = namedEligibleStmt.get(named, childId);
    if (row) return row;
  }
  return fallback.get(childId) || null;
}
