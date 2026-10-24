import { subPathName, hlsPathName, upsertPath, removePath, isPathConfiguredCorrectly } from './mediamtx.js';
import { startTranscoder, stopTranscoder, isRunning } from './transcoder.js';

// Adaptive stream quality: a camera can have an optional lower-resolution sub-stream (sub_rtsp_url,
// see db.js). When set, we run a SECOND transcoder leg - identical treatment to the main one, just a
// different source URL into a sibling `<path>-sub` MediaMTX path - so clients can pick High or Low.
//
// The sub-stream is modelled as a "virtual camera" keyed `<cameraId>-sub`, which lets it reuse the
// existing transcoder supervisor (its own restart/watchdog lifecycle) unchanged.
//
// NOTE: this runs the sub transcoder continuously alongside the main one whenever a sub_rtsp_url is
// configured, which is a second concurrent RTSP pull from the camera. Starting it on demand (only while
// a client watches Low) was considered and DROPPED after measuring prod — the motion detector prefers
// the sub path and a framediff alerter runs 24/7, so the sub has a permanent consumer regardless of
// viewers; a viewer-only trigger would push the detector onto the full-res main stream and cost more
// than it saves. Decided against 2026-08-25 (planning/ROADMAP.md §4) — 72h of prod logs also showed
// zero camera client-limit errors, so the risk it was meant to avoid isn't real here. If it is ever
// revisited it must be reference-counted with the detector holding a lease, not viewer-triggered:
// getPathStatus() already returns a MediaMTX `readers` count, so the plumbing exists.

export function subCameraId(cameraId) {
  return `${cameraId}-sub`;
}

export function subConfigured(camera) {
  return !!(camera.sub_rtsp_url && camera.sub_rtsp_url.trim());
}

export function isSubRunning(cameraId) {
  return isRunning(subCameraId(cameraId));
}

// Ensure the sub path is registered and its transcoder running (idempotent). No-op if the camera
// has no sub-stream configured.
export async function startSubStream(camera) {
  if (!subConfigured(camera)) return;
  const path = subPathName(camera.mediamtx_path);
  // #806: the path check and re-create run as the start's own `prepare`, INSIDE the stop generation the queued start
  // holds (lib/transcoder.js). Awaited here first, as they used to be, nothing was queued during that MediaMTX round
  // trip, so a disable's stopSubStream (stopTranscoder of `<id>-sub`) bumped nothing and the start queued afterwards
  // launched a sub transcoder for a disabled camera. This function must still reach startTranscoder with no await before
  // it: the enable route queues this and the main start in one synchronous block (routes/cameras.js).
  // Costs, stated: the check now runs after the old sub process has stopped, and a rejected upsertPath leaves the sub
  // down (the sub watchdog restarts it) where it used to leave the old one running.
  const ensureSubPath = async (stopped) => {
    // `=== false`, never `!`: null means MediaMTX did not answer, and a write we give up on can still land
    // and drop a live publisher (#451; see isPathConfiguredCorrectly). Skipped now, retried by reconcile.
    if ((await isPathConfiguredCorrectly(path)) === false) {
      // A stop that landed during the check also removed the sub path: writing it back would re-create what the
      // disable or delete just took down (the same guard doStart has for the `-hls` path).
      if (stopped()) return;
      await upsertPath(path);
    }
  };
  await startTranscoder(subCameraId(camera.id), camera.sub_rtsp_url, path, `${camera.name} (low)`, { prepare: ensureSubPath });
}

// Tear down the sub-stream transcoder + path. Safe to call even if none is running.
export async function stopSubStream(camera) {
  await stopTranscoder(subCameraId(camera.id));
  await removePath(subPathName(camera.mediamtx_path)).catch(() => {});
  // Also drop the sub's sibling AAC/HLS path (the transcoder creates it on start; see transcoder.js).
  await removePath(hlsPathName(subPathName(camera.mediamtx_path))).catch(() => {});
}
