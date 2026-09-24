// Who is protecting a camera's ring segments from pruning, and back to when.
//
// THE DEFECT THIS EXISTS FOR (issue #255). The hold used to be a single field on the segmenter entry,
// `entry.holdFromMs`, written unconditionally by holdRing and cleared unconditionally by releaseRing.
// THREE independent features share it:
//   - on-demand Record (recordings.js) — holds on start, releases when the clip is cut
//   - automatic wake clips (wakeWatcher.js) — holds when a run begins, releases on a stir or after cut
//   - a detection clip mid-extraction (clipCapture.js's enqueueClip) — holds from just before it's
//     queued, releases in the job's `finally` (#446: added once a settings save could resize the ring
//     out from under a clip that was still relying on depth-based pruning alone to protect it)
//
// The realistic sequence is not exotic. A child wakes; the wake watcher takes a hold so the opening of
// the wake survives the ~63s ring; a parent watching that same event on their phone presses Record.
// The Record hold OVERWRITES the wake watcher's, and when the manual recording finishes, its release
// clears protection the wake watcher still needed — so the janitor prunes the wake clip's pre-roll on
// its next 2s tick. Both features are correct as written. The bug is that one slot cannot represent
// two holders. Measured in the issue: a single unrelated release deletes an over-depth segment, and a
// later shallower hold silently shortens an earlier deeper one.
//
// ⚠️ WHY THIS IS ITS OWN MODULE rather than a Map on the segmenter entry: it has to be testable. Since
// PR #274 a startSegmenter with no ffmpeg on PATH correctly DELETES its own map entry, and a test
// environment deliberately has no ffmpeg — so there is never a live entry to hang a hold off, and a
// test would have to race a ~5ms window. A pure registry is directly testable, and is honestly the
// better shape anyway.

// cameraId -> Map(owner -> fromMs)
const holds = new Map();

// WAKE is a single owner: one wake watcher run per camera holds it directly. ONDEMAND is no longer an
// owner on its own (#445) — it is the shared PREFIX for `ondemandHoldOwner(recordingId)` below, since
// one camera can have more than one on-demand capture in flight. Constants rather than bare strings
// because a typo in a RELEASE would silently leak a hold — the ring would then grow until the segmenter
// next restarts, with nothing logged and nothing failing.
export const RING_OWNER = {
  ONDEMAND: 'ondemand',
  WAKE: 'wake',
};

// #445: ONDEMAND is a NAMESPACE, not a single owner. Two on-demand recordings on the same camera can
// overlap (another device, or pressing Record again right after Stop) while the first is still being
// cut, and giving them the bare RING_OWNER.ONDEMAND key repeats the pre-#255 single-slot bug ONE LEVEL
// DOWN: the second Start's addHold overwrites the first's fromMs (shortening or losing its protection),
// and the first's release then deletes the second's hold entirely. A recording id is unique and never
// reused (SQLite AUTOINCREMENT), so keying the lease per-recording gives each capture its own slot and
// the existing min-of-owners logic in effectiveHold does the rest — no change needed there.
export function ondemandHoldOwner(recordingId) {
  return `${RING_OWNER.ONDEMAND}:${recordingId}`;
}

// #446: a detection clip's own namespace, same reasoning as ondemandHoldOwner — an event id is unique
// (SQLite AUTOINCREMENT) and multiple clips can be in flight at once (the concurrency-2 queue), so each
// gets its own slot rather than sharing one. Before this existed, a detection clip relied ONLY on ring
// depth to keep its segments; a settings save that shrank the depth mid-capture had nothing else
// protecting them (the old restart-based settings.js wiped the ring outright — this is what replaces
// that wipe with an actual guarantee for the in-flight clip).
export function clipHoldOwner(eventId) {
  return `clip:${eventId}`;
}

export function addHold(cameraId, owner, fromMs) {
  let forCamera = holds.get(cameraId);
  if (!forCamera) {
    forCamera = new Map();
    holds.set(cameraId, forCamera);
  }
  forCamera.set(owner, fromMs);
}

/** Remove only this owner's hold. Unknown owner (or camera) is a no-op, never a clear-all. */
export function removeHold(cameraId, owner) {
  const forCamera = holds.get(cameraId);
  if (!forCamera) return;
  forCamera.delete(owner);
  if (forCamera.size === 0) holds.delete(cameraId);
}

/**
 * The effective protection point: the EARLIEST (deepest) hold any owner is asking for, or null when
 * nobody holds. Minimum, not last-writer — a shallower second hold must never shorten a deeper first
 * one, which is the specific way the single-slot version lost wake-clip pre-roll.
 */
export function effectiveHold(cameraId) {
  const forCamera = holds.get(cameraId);
  if (!forCamera || forCamera.size === 0) return null;
  let earliest = null;
  for (const fromMs of forCamera.values()) {
    if (earliest === null || fromMs < earliest) earliest = fromMs;
  }
  return earliest;
}

/** Drop every hold for a camera. Called when its segmenter is torn down — the ring goes with it. */
export function clearHolds(cameraId) {
  holds.delete(cameraId);
}

/** Diagnostics, and it lets a test assert WHO holds rather than only the resulting depth. */
export function holdOwners(cameraId) {
  return [...(holds.get(cameraId)?.keys() ?? [])];
}
