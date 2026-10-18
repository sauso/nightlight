import db from '../db.js';
import { getExpiredClips, getReadyClipsOldestFirst, getClipStorageTotals } from './detectionEvents.js';
import { clipStorageReady } from './clipStorage.js';

// A DRY RUN of lib/clipStorage.js's sweepClips() (#395): what would the retention sweep delete if these two
// limits were saved, without deleting anything. Lowering "Keep clips for" or "Storage cap" deletes video the
// moment Save is pressed (routes/settings.js calls sweepClips()), and the form used to say nothing about it.
//
// ⚠️ WHAT IS SHARED WITH THE REAL SWEEP, AND WHAT IS NOT. The three queries that decide WHICH clips go are the
// real ones, imported from detectionEvents.js and called with the same arguments: getExpiredClips(days),
// getReadyClipsOldestFirst() and getClipStorageTotals(). The preview cannot select a different set of clips than
// the sweep would. What is NOT shared is the ~10-line decision loop around them (the day pass, then the size
// pass walking oldest-first until under the cap), because lifting it out of sweepClips would mean editing
// clipStorage.js, which sits on the test:core list and is out of scope for a read-only preview. That loop is
// copied here instead, and test/clip-retention-preview.test.js is the guard against drift: it runs this, then
// the REAL sweepClips on the same rows, and requires the two to name exactly the same clips.
//
// Not a promise: new alerts and clips arrive between the preview and the Save, and a clip's size is the size
// recorded when it was cut, so the screen shows the amount as "about" and the clip count as of now.
//
// Nothing here returns a path or a name: counts, bytes and one timestamp only.
export function previewClipRetention({ days, maxGb }) {
  const out = {
    storageReady: clipStorageReady(),
    count: 0,
    bytes: 0,
    oldestAt: null,
    byAge: { count: 0, bytes: 0 },
    bySize: { count: 0, bytes: 0 },
  };
  const ready = getReadyClipsOldestFirst();
  const bytesOf = new Map(ready.map((c) => [c.id, c.clip_bytes || 0]));
  const doomed = new Set();

  if (days > 0) {
    for (const { id } of getExpiredClips(days)) {
      doomed.add(id);
      // An expired clip that is not 'ready' (still being cut, or failed) has no bytes in the totals either.
      out.byAge.count++;
      out.byAge.bytes += bytesOf.get(id) || 0;
    }
  }

  if (maxGb > 0) {
    const cap = maxGb * 1024 * 1024 * 1024;
    // sweepClips re-reads the total AFTER the day pass has deleted; subtracting the same clips is the same number.
    let bytes = getClipStorageTotals().bytes - out.byAge.bytes;
    if (bytes > cap) {
      for (const c of ready) {
        if (bytes <= cap) break;
        if (doomed.has(c.id)) continue; // already gone after the day pass
        doomed.add(c.id);
        bytes -= c.clip_bytes || 0;
        out.bySize.count++;
        out.bySize.bytes += c.clip_bytes || 0;
      }
    }
  }

  out.count = doomed.size;
  out.bytes = out.byAge.bytes + out.bySize.bytes;
  if (doomed.size > 0) {
    out.oldestAt = db
      .prepare('SELECT MIN(created_at) AS t FROM detection_events WHERE id IN (SELECT value FROM json_each(?))')
      .get(JSON.stringify([...doomed]))?.t ?? null;
  }
  return out;
}
