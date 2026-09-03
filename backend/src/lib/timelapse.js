import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import db from '../db.js';
import { logger } from './logger.js';
import { safeInterval } from './processGuards.js';
import { CLIPS_DIR } from './clipRecorder.js';
import { clipStorageReady, hasMinFreeSpace } from './clipStorage.js';
import { captureSnapshot, fetchHttpSnapshot } from './snapshot.js';
import { childTracksSleep, childWindowActiveNow, currentNightDate } from './sleepAnalysis.js';

// Nightly "memories" timelapse (shipped in 0.24.0). While a child's sleep
// window is open we sample one still every SAMPLE_INTERVAL from their primary camera into a per-night
// frame dir; when the window closes the nightly sleep job assembles those frames into a short MP4 that
// condenses the whole night into ~TARGET_DURATION_SEC. Cheap and self-contained: frames come from the
// same local snapshot path the alert image uses (no extra camera session), one FFmpeg pass assembles
// them, and the result lives under CLIPS_DIR like a clip — but tracked in its OWN `timelapses` table so
// it never shows up as an alert / recorded clip and isn't swept by clip retention.

const SAMPLE_INTERVAL_MS = 2 * 60 * 1000; // one frame every 2 min while the window is open
const TARGET_DURATION_SEC = 30; // aim the finished timelapse at ~30s; fps is derived from the frame count
const MIN_FPS = 8;
const MAX_FPS = 30;
const MIN_FRAMES = 30; // fewer than this isn't a night worth assembling (a late-configured child, an outage)
const KEEP_PER_CHILD = 30; // retention: keep this many of a child's most recent timelapses, prune older
const MAX_WIDTH = 1280; // downscale wider sources so a night of frames stays a small MP4 (never upscale)

// Frames are scratch: a hidden subtree of CLIPS_DIR (same volume, so the finished MP4 is a rename away
// and hardlinks work). Finished timelapses live under CLIPS_DIR/timelapse/<childId>/<night>.mp4.
const FRAMES_ROOT = path.join(CLIPS_DIR, '.timelapse-frames');
const OUT_SUBDIR = 'timelapse';

function safeSeg(value) {
  const s = String(value);
  if (s === '.' || s === '..' || !/^[A-Za-z0-9._-]+$/.test(s)) throw new Error(`unsafe path segment: ${JSON.stringify(s)}`);
  return s;
}
function frameDir(childId, nightDate) {
  return path.join(FRAMES_ROOT, safeSeg(childId), safeSeg(nightDate));
}
function safeReaddir(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}
function rmrf(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const err = [];
    proc.stderr.on('data', (c) => err.push(c));
    proc.on('error', reject);
    proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${Buffer.concat(err).toString().slice(-400)}`))));
  });
}

// --- DB helpers (own table; see db.js) ---
const selIdStmt = db.prepare('SELECT id FROM timelapses WHERE child_id = ? AND night_date = ?');
const upsertPendingStmt = db.prepare(
  `INSERT INTO timelapses (child_id, night_date, status) VALUES (@child_id, @night_date, 'pending')
   ON CONFLICT(child_id, night_date) DO UPDATE SET
     status='pending', path=NULL, thumb_path=NULL, frame_count=NULL, duration_s=NULL, bytes=NULL,
     created_at=datetime('now')`
);
const setReadyStmt = db.prepare(
  `UPDATE timelapses SET status='ready', path=@path, thumb_path=@thumb_path,
     frame_count=@frame_count, duration_s=@duration_s, bytes=@bytes WHERE id=@id`
);
const setFailedStmt = db.prepare("UPDATE timelapses SET status='failed' WHERE id=?");

export function listChildTimelapses(childId, limit = 30) {
  return db
    .prepare(
      `SELECT id, child_id, night_date, status, frame_count, duration_s, bytes, created_at
         FROM timelapses WHERE child_id = ? AND status = 'ready'
         ORDER BY night_date DESC LIMIT ?`
    )
    .all(childId, Math.min(90, Math.max(1, limit)));
}

// A jailed { root, path } for a ready timelapse's MP4 (or thumbnail), or null — used by the serving
// route, same containment guard as clips (resolve under CLIPS_DIR, reject any escape).
function jailedFile(relPath) {
  if (!relPath) return null;
  const abs = path.resolve(CLIPS_DIR, relPath);
  if (abs !== CLIPS_DIR && !abs.startsWith(CLIPS_DIR + path.sep)) return null;
  return fs.existsSync(abs) ? { root: CLIPS_DIR, path: path.relative(CLIPS_DIR, abs) } : null;
}
export function getTimelapseVideoFile(id) {
  const row = db.prepare("SELECT path, status FROM timelapses WHERE id = ?").get(id);
  if (!row || row.status !== 'ready') return null;
  return jailedFile(row.path);
}
export function getTimelapseThumbFile(id) {
  const row = db.prepare("SELECT thumb_path, status FROM timelapses WHERE id = ?").get(id);
  if (!row || row.status !== 'ready') return null;
  return jailedFile(row.thumb_path);
}

// --- frame sampling ---

async function captureChildFrame(childId, nightDate) {
  const cam = db
    .prepare('SELECT id, mediamtx_path, snapshot_url FROM cameras WHERE child_id = ? ORDER BY sort_order ASC, rowid ASC LIMIT 1')
    .get(childId);
  if (!cam) return;
  let buf = null;
  if (cam.snapshot_url) buf = await fetchHttpSnapshot(cam.snapshot_url).catch(() => null);
  if (!buf) buf = await captureSnapshot(cam.mediamtx_path).catch(() => null);
  if (!buf || !buf.length) return;
  const dir = frameDir(childId, nightDate);
  fs.mkdirSync(dir, { recursive: true });
  // Fixed-width epoch names sort lexically = chronologically, so assembly just sorts the dir.
  fs.writeFileSync(path.join(dir, `f-${Date.now()}.jpg`), buf);
}

let sampleTimer = null;
let sampling = false;
async function sampleTick() {
  if (sampling) return; // never overlap (a slow snapshot mustn't stack up ticks)
  if (!clipStorageReady() || !hasMinFreeSpace()) return; // nowhere safe to store frames — skip this tick
  sampling = true;
  try {
    const kids = db.prepare('SELECT id FROM children').all();
    for (const kid of kids) {
      try {
        if (!childTracksSleep(kid.id) || !childWindowActiveNow(kid.id)) continue;
        const nightDate = currentNightDate(kid.id);
        if (nightDate) await captureChildFrame(kid.id, nightDate);
      } catch (e) {
        logger.error(`[timelapse] sample failed for child ${kid.id}: ${e.message}`);
      }
    }
  } catch (e) {
    logger.error(`[timelapse] sample tick failed: ${e.message}`);
  } finally {
    sampling = false;
  }
}

export function startTimelapseSampler() {
  if (sampleTimer) return;
  // sampleTick guards its own body, but its first two checks (clipStorageReady/hasMinFreeSpace) sit
  // OUTSIDE that try — a throw there rejects the floating promise, which used to mean an unhandled
  // rejection and a dead process. safeInterval catches it and keeps the timer alive. See #254.
  sampleTimer = safeInterval('timelapse-sampler', SAMPLE_INTERVAL_MS, sampleTick);
  sampleTimer.unref?.();
  logger.info(`[timelapse] frame sampler started (every ${SAMPLE_INTERVAL_MS / 1000}s during open sleep windows)`);
}

// --- assembly (called by the nightly sleep job once a night's window has closed) ---

// Build a temp dir of sequentially-named hardlinks (000001.jpg…) so ffmpeg's image2 demuxer can read
// the night as a numbered sequence — robust across ffmpeg builds (no glob dependency), and hardlinks
// cost no extra bytes on the same volume. Falls back to copy if a link can't be made.
function buildSeqDir(dir, frames) {
  const seqDir = path.join(dir, '.seq');
  rmrf(seqDir);
  fs.mkdirSync(seqDir, { recursive: true });
  frames.forEach((f, i) => {
    const src = path.join(dir, f);
    const dst = path.join(seqDir, `${String(i + 1).padStart(6, '0')}.jpg`);
    try { fs.linkSync(src, dst); } catch { fs.copyFileSync(src, dst); }
  });
  return seqDir;
}

// Keep only a child's KEEP_PER_CHILD most recent ready timelapses; delete older files + rows.
function pruneChild(childId) {
  const rows = db
    .prepare("SELECT id, path, thumb_path FROM timelapses WHERE child_id = ? AND status = 'ready' ORDER BY night_date DESC")
    .all(childId);
  for (const row of rows.slice(KEEP_PER_CHILD)) {
    for (const rel of [row.path, row.thumb_path]) {
      const f = jailedFile(rel);
      if (f) { try { fs.rmSync(path.resolve(f.root, f.path), { force: true }); } catch { /* ignore */ } }
    }
    try { db.prepare('DELETE FROM timelapses WHERE id = ?').run(row.id); } catch { /* ignore */ }
  }
}

// Assemble the sampled frames for one child-night into an MP4. Best-effort and idempotent: safe to
// re-run (upserts the row, overwrites the file); cleans up the frame dir on success or a hard skip.
// Throw away a night's collected frames without building anything. Used when the night turns out to
// have had nobody in the bed: the frames are of an empty room, so a "memory" of it is just wasted disk
// and a pointless card on the child's page. Sampling can't know this in advance — occupancy is only
// decided once the night is scored — so the frames are collected and then discarded here.
export function discardTimelapseFrames(childId, nightDate) {
  const dir = frameDir(childId, nightDate);
  const frames = safeReaddir(dir).filter((f) => /^f-\d+\.jpg$/.test(f));
  rmrf(dir);
  if (frames.length) logger.info(`[timelapse] child ${childId} ${nightDate}: discarded ${frames.length} frame(s) — no one in the bed`);
  return frames.length;
}

// Delete one timelapse: the row, the MP4 and its thumbnail. Admin-only at the route. The files are
// resolved through the same CLIPS_DIR jail as playback, so a tampered stored path can't escape it.
export function deleteTimelapse(id) {
  const row = db.prepare('SELECT id, path, thumb_path FROM timelapses WHERE id = ?').get(id);
  if (!row) return false;
  for (const rel of [row.path, row.thumb_path]) {
    if (!rel) continue;
    const f = jailedFile(rel);
    if (f) { try { fs.unlinkSync(path.join(f.root, f.path)); } catch { /* already gone */ } }
  }
  db.prepare('DELETE FROM timelapses WHERE id = ?').run(id);
  logger.info(`[timelapse] deleted timelapse ${id}`);
  return true;
}

export async function assembleTimelapse(childId, nightDate) {
  if (!clipStorageReady()) return null;
  const dir = frameDir(childId, nightDate);
  const frames = safeReaddir(dir).filter((f) => /^f-\d+\.jpg$/.test(f)).sort();
  if (frames.length < MIN_FRAMES) {
    if (frames.length > 0) logger.info(`[timelapse] child ${childId} ${nightDate}: ${frames.length} frame(s) (<${MIN_FRAMES}) — skipping`);
    rmrf(dir);
    return null;
  }

  upsertPendingStmt.run({ child_id: childId, night_date: nightDate });
  const id = selIdStmt.get(childId, nightDate).id;

  let seqDir;
  try {
    seqDir = buildSeqDir(dir, frames);
    const fps = Math.min(MAX_FPS, Math.max(MIN_FPS, Math.round(frames.length / TARGET_DURATION_SEC)));

    const outDir = path.join(CLIPS_DIR, OUT_SUBDIR, safeSeg(childId));
    fs.mkdirSync(outDir, { recursive: true });
    const base = safeSeg(nightDate);
    const outFile = path.join(outDir, `${base}.mp4`);
    const thumbFile = path.join(outDir, `${base}.jpg`);

    await runFfmpeg([
      '-nostdin', '-loglevel', 'error',
      '-framerate', String(fps),
      '-i', path.join(seqDir, '%06d.jpg'),
      // Downscale only if wider than MAX_WIDTH; -2 keeps aspect with an even height (yuv420p needs even).
      '-vf', `scale=min(${MAX_WIDTH}\\,iw):-2`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '25', '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      '-y', outFile,
    ]);

    // Thumbnail: a frame from ~1/3 in (past the lights-on settling, still recognisably the room).
    await runFfmpeg([
      '-nostdin', '-loglevel', 'error',
      '-ss', String((frames.length / fps) / 3),
      '-i', outFile, '-frames:v', '1', '-q:v', '4', '-y', thumbFile,
    ]).catch(() => {});

    const bytes = (() => { try { return fs.statSync(outFile).size; } catch { return null; } })();
    const durationS = Math.round(frames.length / fps);
    setReadyStmt.run({
      id,
      path: path.relative(CLIPS_DIR, outFile),
      thumb_path: fs.existsSync(thumbFile) ? path.relative(CLIPS_DIR, thumbFile) : null,
      frame_count: frames.length,
      duration_s: durationS,
      bytes,
    });
    logger.info(`[timelapse] child ${childId} ${nightDate}: assembled ${frames.length} frames → ${durationS}s @ ${fps}fps (${bytes ? Math.round(bytes / 1024) : '?'} KB)`);
    rmrf(dir); // frames + seq dir gone; the MP4 is the keepsake
    pruneChild(childId);
    return id;
  } catch (e) {
    logger.error(`[timelapse] assembly failed for child ${childId} ${nightDate}: ${e.message}`);
    try { setFailedStmt.run(id); } catch { /* ignore */ }
    if (seqDir) rmrf(seqDir); // leave the frames on a failure so a later retry can still assemble
    return null;
  }
}
