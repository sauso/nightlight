import fs from 'fs';
import path from 'path';
import db from '../db.js';
import { logger } from './logger.js';
import { CLIPS_DIR } from './clipRecorder.js';
import {
  getExpiredClips,
  getReadyClipsOldestFirst,
  getClipStorageTotals,
  deleteClip,
} from './detectionEvents.js';

// Storage safety + retention for Stage 1 recording:
//   * a startup guard that CLIPS_DIR is writable AND on a real mount — never the container's
//     ephemeral overlay layer (where clips would vanish on recreate and bloat the image);
//   * a minimum-free-space check callers make before writing a clip, so a full disk can't wedge things;
//   * a periodic sweeper that enforces the admin's day + size-cap retention (oldest deleted first).
// Shipped in 0.17.0.

const GB = 1024 * 1024 * 1024;
// Refuse to start a new clip if the volume has less than this free. A clip is a few MB, but this is a
// hard floor so recording can never be the thing that fills a disk out from under the DB.
const MIN_FREE_BYTES = 500 * 1024 * 1024; // 500 MB
const SWEEP_INTERVAL_MS = 15 * 60 * 1000;

let status = { ok: false, path: CLIPS_DIR, writable: false, onMount: false, reason: 'not checked' };
let sweepTimer = null;

// Is CLIPS_DIR backed by a real mount (bind/volume) rather than the container overlay? A mapped
// volume shows up in /proc/mounts as its own mountpoint; an unmapped path falls under "/" (the
// overlay root), which means it lives on the ephemeral layer. We find the DEEPEST mountpoint that
// contains CLIPS_DIR: if that's "/", it's unmapped. Off Linux (dev machine, no /proc/mounts) we skip
// the check and assume fine.
function isOnRealMount(absDir) {
  let mounts;
  try {
    mounts = fs.readFileSync('/proc/mounts', 'utf8');
  } catch {
    return true; // not a Linux container — can't check, don't block
  }
  let deepest = '';
  for (const line of mounts.split('\n')) {
    const mnt = line.split(' ')[1];
    if (!mnt) continue;
    const m = mnt.replace(/\\040/g, ' '); // /proc/mounts escapes spaces
    const withSep = m === '/' ? '/' : m + '/';
    if (absDir === m || absDir.startsWith(withSep)) {
      if (m.length > deepest.length) deepest = m;
    }
  }
  return deepest !== '' && deepest !== '/';
}

// Run the startup guard. Creates CLIPS_DIR, checks it's writable, and warns/blocks if it's on the
// ephemeral layer. Sets the module status used to gate capture.
export function checkClipStorage() {
  const abs = path.resolve(CLIPS_DIR);
  let writable = false;
  try {
    fs.mkdirSync(abs, { recursive: true });
    const probe = path.join(abs, '.write-test');
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe, { force: true });
    writable = true;
  } catch (e) {
    logger.error(`[clips] CLIPS_DIR "${abs}" is not writable (${e.message}). Clip recording disabled.`);
    status = { ok: false, path: abs, writable: false, onMount: false, reason: 'not writable' };
    return status;
  }
  const onMount = isOnRealMount(abs);
  if (!onMount) {
    // Unmapped container path — clips would land on the overlay layer (lost on recreate, image bloat).
    logger.error(
      `[clips] CLIPS_DIR "${abs}" is NOT a mapped volume — it's on the container's ephemeral layer. ` +
        `Map it to a host path (default is under DATA_DIR, or set CLIPS_DIR to a /recordings mount). ` +
        `Clip recording disabled until this is fixed.`
    );
    status = { ok: false, path: abs, writable: true, onMount: false, reason: 'unmapped container path' };
    return status;
  }
  status = { ok: true, path: abs, writable: true, onMount: true, reason: 'ok' };
  logger.info(`[clips] storage OK at ${abs}`);
  return status;
}

export function clipStorageReady() {
  return status.ok;
}

// Bytes free on the CLIPS_DIR volume. Best-effort — returns Infinity if it can't be measured so a
// probe failure never silently blocks recording.
export function freeBytes() {
  try {
    const st = fs.statfsSync(path.resolve(CLIPS_DIR));
    return st.bavail * st.bsize;
  } catch {
    return Infinity;
  }
}

export function hasMinFreeSpace() {
  return freeBytes() >= MIN_FREE_BYTES;
}

function getRetention() {
  const s = db.prepare('SELECT clip_retention_days, clip_retention_max_gb FROM settings WHERE id = ?').get('app') || {};
  const days = Number(s.clip_retention_days);
  const maxGb = Number(s.clip_retention_max_gb);
  return {
    days: Number.isFinite(days) ? days : 14,
    maxGb: Number.isFinite(maxGb) ? maxGb : 5,
  };
}

// Used storage + where it lives, for the Settings display.
export function clipStorageStats() {
  const totals = getClipStorageTotals();
  // On-demand recordings live in their own table and are NEVER swept by the retention above, so they
  // don't appear in getClipStorageTotals() — report them separately rather than under-stating what
  // recording is actually using on disk. Queried directly rather than imported from lib/recordings.js,
  // which imports hasMinFreeSpace() from here: the cycle happens to resolve via hoisting, but there's
  // no reason to introduce one for a single COUNT/SUM.
  const rec = db
    .prepare("SELECT COUNT(*) n, COALESCE(SUM(bytes),0) b FROM recordings WHERE status='ready'")
    .get() || { n: 0, b: 0 };
  return {
    recordingCount: rec.n,
    recordingBytes: rec.b,
    path: status.path,
    onMount: status.onMount,
    writable: status.writable,
    ok: status.ok,
    clipCount: totals.count,
    usedBytes: totals.bytes,
    freeBytes: freeBytes(),
    ...getRetention(),
  };
}

// Enforce retention: delete clips older than the day bound, then (if still over) the oldest clips
// until under the size cap. Each delete removes the file(s) and clears the row's clip_* columns,
// leaving the alert + snapshot intact. Best-effort and self-contained.
export function sweepClips() {
  if (!status.ok) return;
  const { days, maxGb } = getRetention();
  let removed = 0;

  if (days > 0) {
    for (const { id, clip_path } of getExpiredClips(days)) {
      deleteClip(id, clip_path);
      removed++;
    }
  }

  if (maxGb > 0) {
    const cap = maxGb * GB;
    let { bytes } = getClipStorageTotals();
    if (bytes > cap) {
      for (const c of getReadyClipsOldestFirst()) {
        if (bytes <= cap) break;
        deleteClip(c.id, c.clip_path);
        bytes -= c.clip_bytes || 0;
        removed++;
      }
    }
  }

  if (removed > 0) logger.info(`[clips] retention swept ${removed} clip(s) (>${days}d or >${maxGb}GB)`);
}

// Called once at boot: run the guard, sweep immediately, then on an interval.
export function startClipStorage() {
  checkClipStorage();
  try {
    sweepClips();
  } catch (e) {
    logger.error('[clips] initial sweep failed:', e.message);
  }
  if (!sweepTimer) {
    sweepTimer = setInterval(() => {
      try { sweepClips(); } catch (e) { logger.error('[clips] sweep failed:', e.message); }
    }, SWEEP_INTERVAL_MS);
    sweepTimer.unref?.();
  }
}
