import fs from 'fs';
import path from 'path';
import db from '../db.js';
import { logger } from './logger.js';
import { safeInterval } from './processGuards.js';
import { CLIPS_DIR, PROBE_DEADLINE_MS, runFfmpeg } from './clipRecorder.js';
import { clipStorageReady, hasMinFreeSpace } from './clipStorage.js';
import { captureSnapshot, fetchHttpSnapshot } from './snapshot.js';
import {
  childTracksSleep, childWindowActiveNow, currentNightDate, isEvidenceFinal, lastCompletedNightDate,
} from './sleepAnalysis.js';
import { primaryCameraRowFor } from './primaryCamera.js';

// Nightly "memories" timelapse (shipped in 0.24.0). While a child's sleep
// window is open we sample one still every SAMPLE_INTERVAL from their primary camera (lib/primaryCamera.js:
// the one named in the child's settings, else the first enabled one in tile order) into a per-night
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
// Exported so a test can locate a child-night's scratch frame dir without reimplementing/hardcoding
// FRAMES_ROOT's layout.
export function frameDir(childId, nightDate) {
  return path.join(FRAMES_ROOT, safeSeg(childId), safeSeg(nightDate));
}
function safeReaddir(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}
function rmrf(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
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

// ★ #850: A NIGHT THE DETECTOR NOW STORES AS `empty` IS NOT LISTED, but its video is NOT deleted. A night first stored
// `ok` has its video made and its frames thrown away; a later pass (#351) can store it `empty`, and the page would
// keep showing a "memory" of a night recorded as "no one was in the bed". Deleting that MP4 was the first plan and
// the plan review (Opus, 2026-10-24) found it unsafe: an admin's Recompute (?store=1) can re-store ANY night of the
// last 30 days at any time, with no finality check, and `empty -> ok` is not a downgrade, so a night whose zone was
// fixed after the delete would be `ok` again with its only video and its frames gone for good. Hiding reads the
// stored row at list time instead, so that Recompute simply brings the video back. Cost: the file stays on disk
// until the child's 30 newest ready videos (KEEP_PER_CHILD) age it out (the page's Delete button works from this
// list, so a hidden video has none; the DELETE route by id still works). Only the DETECTOR's
// verdict (sleep_nights.status) counts: a night a parent marked "No one was in the bed" lives in sleep_reviews and
// keeps its listed video (docs/recording.md). The video is still served by id; only the listing leaves it out.
// The anti-join sits inside the LIMIT, so hidden nights never use up the caller's page.
export function listChildTimelapses(childId, limit = 30) {
  return db
    .prepare(
      `SELECT t.id, t.child_id, t.night_date, t.status, t.frame_count, t.duration_s, t.bytes, t.created_at
         FROM timelapses t
        WHERE t.child_id = ? AND t.status = 'ready'
          AND NOT EXISTS (SELECT 1 FROM sleep_nights s
                           WHERE s.child_id = t.child_id AND s.night_date = t.night_date AND s.status = 'empty')
        ORDER BY t.night_date DESC LIMIT ?`
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

// The camera is the child's primary camera, from the same resolver sleep scoring uses
// (lib/primaryCamera.js, #655), so the timelapse shows the room the night was measured from: the camera an
// admin named in the child's settings while it is still theirs and enabled, else the first enabled one in
// sort_order. disabled = 0 either way: a disabled camera's streaming/detection legs are off, and its RTSP
// source may be stale or gone entirely, so it must never be sampled, not even when it is the named one.
// tieBreak 'rowid': this sampler's own tie-break for two cameras with the same sort_order before #655
// (`ORDER BY sort_order ASC, rowid ASC`), kept so a child with no primary samples exactly the camera it
// did. Scoring breaks the same tie by id; see primaryCamera.js for why the two are not unified.
// Re-checked right before a frame is written (see captureChildFrame) — a camera can be disabled,
// reassigned to a different child, or deleted entirely while its snapshot fetch was in flight.
const isStillEligibleStmt = db.prepare('SELECT 1 FROM cameras WHERE id = ? AND child_id = ? AND disabled = 0');

export async function captureChildFrame(childId, nightDate) {
  const cam = primaryCameraRowFor(childId, { tieBreak: 'rowid' });
  if (!cam) return;
  let buf = null;
  if (cam.snapshot_url) buf = await fetchHttpSnapshot(cam.snapshot_url).catch(() => null);
  if (!buf) buf = await captureSnapshot(cam.mediamtx_path).catch(() => null);
  if (!buf || !buf.length) return;
  // The fetch above is async and can take real time (an HTTP request, or an ffmpeg grab up to its
  // own 8s timeout) — re-validate eligibility now rather than trusting the read from before it
  // started, so disabling/reassigning/deleting the camera mid-capture can't produce a late frame
  // from a camera the timelapse is no longer supposed to include.
  if (!isStillEligibleStmt.get(cam.id, childId)) return;
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

// Stop the frame sampler. Idempotent, and safe when it was never started.
//
// ⚠️ MISSED BY THE #286 SWEEP, and worth recording why rather than just adding it: that sweep found
// every periodic job by scanning for the literal `setInterval`, and this one goes through
// `safeInterval`, so the module was skipped before the pairing rule ever ran. The guard now also looks
// for the wrapper (see test/helpers/sourceScan.js). Same class of miss as the #278 root cause — the
// check was real, it just could not see this shape.
//
// Like the other unref'd jobs, this one cannot cause the #278 hang; it gets a stop so the rule stays
// uniform and so shutdown is explicit rather than relying on process.exit to take the timer down.
export function stopTimelapseSampler() {
  clearInterval(sampleTimer);
  // Nulled, not merely cleared: `startTimelapseSampler` guards on `if (sampleTimer) return`, so a
  // stale handle here would make every later restart a silent no-op.
  sampleTimer = null;
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

// Throw away a night's collected frames without building anything. Used when the night turns out to
// have had nobody in the bed: the frames are of an empty room, so a "memory" of it is just wasted disk
// and a pointless card on the child's page. Sampling can't know this in advance — occupancy is only
// decided once the night is scored — so the frames are collected and then discarded here, by the sweep
// at the end of this file once that verdict is final (#419), never on the first pass that says `empty`.
//
// #851 reuses it for frames that have simply grown too old (discardExpiredFrames, below): `reason` ends the log line,
// and its default is the original wording, so the empty-night sweep's success line is byte-for-byte what it was.
// Returns how many frames it discarded, or -1 when the folder is STILL THERE afterwards (#851 plan review): rmrf
// swallows every error, so a folder that cannot be removed (a permissions problem) used to be reported as discarded,
// and a sweep that runs every 30 minutes would log that false success on every tick. It says so as a warning instead,
// for both callers (the empty-night sweep ignores the return value, as before; the old-frames sweep counts on it).
export function discardTimelapseFrames(childId, nightDate, reason = 'no one in the bed') {
  const dir = frameDir(childId, nightDate);
  const frames = safeReaddir(dir).filter((f) => /^f-\d+\.jpg$/.test(f));
  rmrf(dir);
  if (fs.existsSync(dir)) {
    logger.warn(`[timelapse] child ${childId} ${nightDate}: could not delete ${dir} (${reason}); tried again on the next pass`);
    return -1;
  }
  if (frames.length) logger.info(`[timelapse] child ${childId} ${nightDate}: discarded ${frames.length} frame(s) — ${reason}`);
  return frames.length;
}

// Deleting a child's frames (all nights, assembled or not: issue #259, PR #284) is NOT done here any more: it
// moved to lib/entityPurge.js (#719 review), because rmrf above swallows every error, so an unremovable frames
// folder let the child be deleted while a photo of the bed every 2 minutes stayed on disk. The purge's sweep
// throws instead, and stops before the child's row goes.

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

// Assemble the sampled frames for one child-night into an MP4. Best-effort and idempotent: safe to
// re-run (upserts the row, overwrites the file); cleans up the frame dir on success or a hard skip.
//
// ★ #450: ONE ASSEMBLY PER CHILD-NIGHT AT A TIME. The first attempt (the nightly job, on the night's first scored
// pass) and the retry below can otherwise both reach this function for one night: two ffmpeg passes writing the same
// .mp4 and the second one's rmrf of the `.seq` dir under the first. A call that finds its night already in flight
// returns null at once (no caller uses the value: the job ignores it, the retry only reads success as "an id").
// Registered SYNCHRONOUSLY, before the first await, so a retry started in the same tick sees it; released in a
// `finally` around the WHOLE body, because assembleOnce can return or throw before its own try (storage not ready,
// too few frames, an unsafe path segment, the upsert): a key left behind would make this night return null until the
// process restarts.
const inFlight = new Set();
const nightKey = (childId, nightDate) => `${childId}|${nightDate}`; // safeSeg allows no `|`, so keys cannot collide
export async function assembleTimelapse(childId, nightDate) {
  const key = nightKey(childId, nightDate);
  if (inFlight.has(key)) return null;
  inFlight.add(key);
  try {
    return await assembleOnce(childId, nightDate);
  } finally {
    inFlight.delete(key);
  }
}

async function assembleOnce(childId, nightDate) {
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

    // #781 reuses #773's unmeasured 120 s plus 1 s per 2 MB stall hypothesis. The
    // [timelapse] assemble line records waits for calibration. A slower machine keeps
    // encoding while its counters increase; only a stretch without progress is cut.
    await runFfmpeg([
      '-nostdin', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1',
      '-framerate', String(fps),
      '-i', path.join(seqDir, '%06d.jpg'),
      // Downscale only if wider than MAX_WIDTH; -2 keeps aspect with an even height (yuv420p needs even).
      '-vf', `scale=min(${MAX_WIDTH}\\,iw):-2`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '25', '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      '-y', outFile,
    ], { stallLabel: `${childId} ${nightDate}`, progressKind: 'timelapse' });

    // Thumbnail: a frame from ~1/3 in (past the lights-on settling, still recognisably the room).
    await runFfmpeg([
      '-nostdin', '-loglevel', 'error',
      '-ss', String((frames.length / fps) / 3),
      '-i', outFile, '-frames:v', '1', '-q:v', '4', '-y', thumbFile,
    ], { deadlineMs: PROBE_DEADLINE_MS }).catch(() => {
      // #781: a timed-out thumbnail can leave a partial JPG; a ready row must not point at it.
      try { fs.rmSync(thumbFile, { force: true }); } catch { /* already gone */ }
    });

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

// ★ #450: RETRY A NIGHT THAT HAS FRAMES BUT NO VIDEO. The nightly job starts an assembly once, on a night's first
// scored pass, and nothing started another: a failed assembly kept its frames "so a later retry can still assemble",
// and no later retry existed (the sleep row is scored by then, so the job never put the night in its list again).
// The same dead end held for a night whose assembly was interrupted by a restart (row left `pending`) and, found by the
// plan review, for a night with NO row at all: a boot-time first pass runs before clip storage is probed (index.js
// starts the sleep job before startClipStorage), so assembleOnce returns at its storage check before it writes a row,
// and an admin Recompute can score a night outside the job. So candidates come from the FRAME FOLDERS, not from rows.
//
// A frame folder is retried only when all of these hold (re-read right before each attempt, since an earlier one in
// the same pass can take minutes): the child exists; the night is scored 'ok' (an 'empty' or unscored night must not
// get a video of an empty room, and a deleted child's sleep rows are gone); no ready timelapse exists; it is not the
// child's open night (the sampler is still writing there); nothing is assembling it; it has at least MIN_FRAMES
// frames; and it would not be pruned the moment it is ready (a child already holding KEEP_PER_CHILD newer ready ones:
// the encode would be wasted, and deleting a night's frames that way is not what a retry is for).
// Newest nights first, one at a time (each can run to its stall deadline, so a pass is not bounded by the job's
// 30-minute cadence: the `retrying` flag stops a second pass starting beside it, the way `sampling` does for the sampler).
// Not run while clip storage is not ready or the disk is nearly full (hasMinFreeSpace, as the sampler): neither
// spends an attempt.
//
// LIMITS, deliberately: at most MAX_RETRIES attempts per night per PROCESS, spaced by the job's own 30-minute tick
// (about 1.5 hours for a transient encoder or storage failure). The count is in memory, not stored (a stored count
// would be a schema change), so a restart or deploy gives a night that was given up on three more tries. The numbers are
// unmeasured guesses, not calibrated on any failure we have seen. A night that exhausts them keeps its frames and logs
// where they are, until it is FRAME_EXPIRE_DAYS (32) days old: then discardExpiredFrames (#851, the frames half of
// #846) deletes them, so restarts can no longer keep a night's frames, or its retries, going for ever. The in-memory
// count itself still resets on a restart (#846 stays open for that half).
const MAX_RETRIES = 3;
const retryAttempts = new Map(); // nightKey -> attempts made by this process
let retrying = false;
// Test seam ONLY (timelapse-retry.test.js), like startChainCountForTest in transcoder.js: the attempt counts live as
// long as the process, so one test giving a night up would otherwise leave every later test with a night already
// "given up on". Nothing in src/ uses it.
export function resetRetryStateForTest() {
  retryAttempts.clear();
}
const childExistsStmt = db.prepare('SELECT 1 FROM children WHERE id = ?');
const scoredOkStmt = db.prepare("SELECT 1 FROM sleep_nights WHERE child_id = ? AND night_date = ? AND status = 'ok'");
const readyRowStmt = db.prepare("SELECT 1 FROM timelapses WHERE child_id = ? AND night_date = ? AND status = 'ready'");
const newerReadyStmt = db.prepare("SELECT COUNT(*) AS n FROM timelapses WHERE child_id = ? AND status = 'ready' AND night_date > ?");

function frameNights() {
  const out = [];
  for (const childId of safeReaddir(FRAMES_ROOT)) {
    for (const nightDate of safeReaddir(path.join(FRAMES_ROOT, childId))) out.push({ childId, nightDate });
  }
  // Newest night first ACROSS children (code review, Codex: sorting only within a child started an older night of one
  // child before a newer night of another), ties by child id so the order is the same on every run.
  return out.sort((a, b) => b.nightDate.localeCompare(a.nightDate) || a.childId.localeCompare(b.childId));
}

function retryable(childId, nightDate) {
  if (inFlight.has(nightKey(childId, nightDate))) return false;
  if (!childExistsStmt.get(childId)) return false;
  if (!scoredOkStmt.get(childId, nightDate)) return false;
  if (readyRowStmt.get(childId, nightDate)) return false;
  if (currentNightDate(childId) === nightDate) return false;
  if (newerReadyStmt.get(childId, nightDate).n >= KEEP_PER_CHILD) return false;
  const frames = safeReaddir(path.join(FRAMES_ROOT, childId, nightDate)).filter((f) => /^f-\d+\.jpg$/.test(f));
  return frames.length >= MIN_FRAMES;
}

// Returns how many assemblies it started. Never throws.
export async function retryStrandedTimelapses() {
  if (retrying) return 0;
  if (!clipStorageReady() || !hasMinFreeSpace()) return 0;
  retrying = true;
  let attempted = 0;
  try {
    for (const { childId, nightDate } of frameNights()) {
      try {
        const key = nightKey(childId, nightDate);
        const tried = retryAttempts.get(key) || 0;
        // The folder names come off the disk: anything that is not a plain segment is skipped, not trusted.
        if (tried >= MAX_RETRIES || !/^[A-Za-z0-9._-]+$/.test(childId) || !/^\d{4}-\d{2}-\d{2}$/.test(nightDate)) continue;
        if (!retryable(childId, nightDate)) continue;
        retryAttempts.set(key, tried + 1);
        attempted += 1;
        logger.info(`[timelapse] retrying ${childId} ${nightDate}: no video yet, frames kept (attempt ${tried + 1} of ${MAX_RETRIES})`);
        const id = await assembleTimelapse(childId, nightDate);
        if (id) retryAttempts.delete(key);
        else if (tried + 1 >= MAX_RETRIES) {
          logger.warn(`[timelapse] giving up on ${childId} ${nightDate} after ${MAX_RETRIES} tries; its frames stay in ${frameDir(childId, nightDate)} until the night is ${FRAME_EXPIRE_DAYS} days old (a restart tries again)`);
        }
      } catch (e) {
        logger.error(`[timelapse] retry of ${childId} ${nightDate} failed: ${e.message}`);
      }
    }
  } finally {
    retrying = false;
  }
  return attempted;
}

// ★ #419: AN EMPTY NIGHT'S FRAMES ARE DISCARDED ONLY ONCE THE VERDICT IS FINAL, by this sweep, never on the first
// pass that says `empty`. The nightly job re-scores a night every 30 minutes for ~3 hours after its window closes
// (#351), and a later pass can find the child after all (`empty` -> `ok`: some of the window's activity rows had not
// been read yet). The job used to delete the frames on the FIRST pass that scored `empty`, so a night that then turned
// `ok` had nothing left to make its timelapse from. Deleting frames cannot be undone, so it now waits for the
// classification to stop changing; an `empty` that turns `ok` in the meantime is assembled by the job like any first
// `ok` (runNightlySleepJob). Found by adversarial review of PR #418; no real night is known to have flipped.
//
// A frame folder is discarded only when ALL of these hold (each re-read here, from the stored row and the clock, so a
// night the job no longer recomputes is still cleaned up):
//   - the child exists (a deleted child's frames are lib/entityPurge.js's to delete, with the child);
//   - the STORED row says `empty`: the detector's own verdict. A parent's "no one was in the bed" mark lives in
//     sleep_reviews, not here, so a flagged night that the detector scored `ok` keeps its frames and its timelapse
//     (docs/recording.md: the mark is reversible and must never destroy what taking it back could not restore);
//   - its evidence is final NOW (isEvidenceFinal: WAKE_LOOKAHEAD_MS, 3 h, past window_end);
//   - AND no recompute is still owed: the row was itself computed at or after that horizon (judged on its OWN
//     computed_at, as the job's #351 gate is), OR it is no longer the child's last completed night (the job never
//     visits any other). `now` alone is not enough (plan review, Opus): a night a parent corrected is locked and skipped
//     with an early computed_at, and taking the correction back makes the job owe it one more pass, hours after the
//     horizon; a pass refused as `would_downgrade`, or one that threw, leaves it owed the same way. Any of those can
//     still turn `ok`;
//   - it is not the child's open night (the sampler may be writing there, after a sleep-window edit reopened it);
//   - nothing is assembling it (an admin Recompute can re-score a night `empty` while the retry is encoding it).
//
// ⚠️ THE COST, stated: an empty night's frames (one every 2 minutes, a JPEG each) now stay on disk for about 3 hours
// after the window closes instead of being deleted at the first pass, and up to about a day (until the next night's
// window closes) for a night that is locked, refused or threw. Bounded: one night per child at a time. Candidates come
// from the FRAME FOLDERS, not from rows (the #450 lesson), so a folder left by a restart between the row write and the
// old fire-and-forget delete is found too, and the first start after this change deletes every such leftover at once.
//
// Deliberately NOT inside retryStrandedTimelapses: that pass is skipped while the disk is nearly full
// (hasMinFreeSpace) or another pass is still encoding (`retrying`), and neither may stop a delete, which frees space.
// No clip-storage check either, as the old delete had none: removing an empty room's frames needs nothing written.
// Synchronous (no await), so a pass cannot overlap itself. Returns how many nights it discarded; never throws.
const storedEmptyStmt = db.prepare(
  "SELECT window_end, computed_at FROM sleep_nights WHERE child_id = ? AND night_date = ? AND status = 'empty'"
);
const sqlUtcMs = (s) => new Date(`${s.replace(' ', 'T')}Z`).getTime();

function discardable(childId, nightDate, nowMs) {
  if (inFlight.has(nightKey(childId, nightDate))) return false;
  if (!childExistsStmt.get(childId)) return false;
  const row = storedEmptyStmt.get(childId, nightDate);
  if (!row) return false;
  if (!isEvidenceFinal(row.window_end, nowMs)) return false;
  if (nightDate === currentNightDate(childId)) return false; // (operands this way round: #450 M8 anchors on the retry's line)
  return isEvidenceFinal(row.window_end, sqlUtcMs(row.computed_at)) || nightDate !== lastCompletedNightDate(childId);
}

export function discardFinalEmptyNightFrames() {
  const nowMs = Date.now();
  let discarded = 0;
  // frameNights() cannot throw (safeReaddir swallows a missing or unreadable folder), so the per-night catch below is
  // the only one needed for "never throws".
  for (const { childId, nightDate } of frameNights()) {
    try {
      // The folder names come off the disk: anything that is not a plain segment is skipped, not trusted (as the retry).
      if (!/^[A-Za-z0-9._-]+$/.test(childId) || !/^\d{4}-\d{2}-\d{2}$/.test(nightDate)) continue;
      if (!discardable(childId, nightDate, nowMs)) continue;
      discardTimelapseFrames(childId, nightDate);
      discarded += 1;
    } catch (e) {
      // One bad row (a malformed stored time, say) must not keep every other night's frames on disk.
      logger.error(`[timelapse] empty-night sweep of ${childId} ${nightDate} failed: ${e.message}`);
    }
  }
  return discarded;
}

// ★ #851 (and the frames half of #846): NO FRAME FOLDER OUTLIVES ITS NIGHT BY MORE THAN ABOUT A MONTH. Frames (about
// 30 MB a night) were deleted only when the night was assembled, or (#419, above) once its stored verdict was a final
// `empty`. Everything else kept them until the child was removed: nights stored `no_data`, `no_sleep`, `insufficient`
// or `off`, nights with no row at all, and an `ok` night whose assembly the retry gave up on (3 tries per process,
// reset by every restart, #846). Owner decision (2026-10-24): delete them after 30 days.
//
// ONE AGE RULE, keyed on the folder's NIGHT DATE only, not on the stored row. A rule per status needs a case for each
// status and still misses "no row" and "ok but given up"; the age rule covers all of them, and is the one sentence the
// docs can say: no frame folder stays longer than that.
//
// WHY 30 DAYS IS SAFE, and why the comparison is 32 (plan review of #851, Opus, verified by reading): past a certain
// age nothing can turn a frame folder into a timelapse any more, because no later score can make the night `ok`.
//   - activity_samples are deleted at created_at < now - 30 days (activityTracker.js RETENTION_DAYS, not configurable)
//     by a prune that runs once a day, so a minute's sample lives at most about 31 days;
//   - a night scores only while at least half its window (MIN_COVERAGE_FRAC) has samples, so it can be re-scored until
//     about 31 days after the MIDDLE of its window (Recompute's `aged_out` is not a date limit: it only refuses a
//     scored -> unscored downgrade);
//   - night dates are LOCAL calendar dates (the date the window starts on, in the app timezone) but this rule reads no
//     timezone: it compares against the UTC calendar. The latest a window's middle can fall, relative to its own date,
//     is a 24-hour window starting at 23:59 in UTC-12: night D starts at D+1 11:59 UTC, so its middle is D+1 23:59 UTC
//     and it can be re-scored until about D+32 23:59 UTC;
//   - this rule deletes night D from D+33 00:00 UTC (`nightDate < UTC date of (now - 32 days)`), after that worst case
//     (by about a minute in the very worst case: a full-length window, at UTC-12, with a prune that only just missed);
//     every real setup has more margin. At 31 days even a 19:00-07:00 night in UTC (middle D+1 01:00, re-scorable until
//     about D+32 01:00) could still be re-scored after its frames had gone, and a US-West or Hawaii night by hours.
//     Pinned by timelapse-expire-frames.test.js m1 (Etc/GMT+12 and Pacific/Kiritimati, 24-hour window).
// Before that age nothing is deleted by this rule, so a Recompute inside the window still finds its frames. Users are
// told "about 32 days" (docs/recording.md), which is what they see.
//
// What this leaves, stated (docs/recording.md and the CHANGELOG say the same):
//   - a night first scored MORE than 32 days after it ended (a server that was off for a month) cannot get a timelapse
//     any more: its frames are gone first. The first start after updating deletes every such old folder (capped per
//     pass, below), as #419's first start did for empty nights;
//   - a forward clock jump (a wrong RTC at boot) makes every folder look old and deletes it, the same exposure as the
//     activity prune, which would delete the samples too;
//   - the partial MP4 a failed assembly can leave under timelapse/<child>/ is not touched (out of scope, #850 review D7);
//   - a child that no longer exists still has its old folders deleted: they are scratch nobody can assemble (the retry
//     needs the child) or see, and lib/entityPurge.js leaves the folders of a non-UUID id behind on purpose.
//
// HOW, and why each guard:
//   - candidates come from the FRAME FOLDERS (frameNights, the #450 lesson), and a name that is not a plain child-id
//     segment and a real calendar date is skipped, not trusted (the names come off the disk);
//   - never through a link (lstat, not stat), at the child folder AND the night folder: rmSync on
//     `.timelapse-frames/<link>/<night>` would delete whatever the link points at (lib/entityPurge.js refuses links
//     for the same reason). `.timelapse-frames` itself is used as every other frame path here uses it;
//   - a night that is being assembled is skipped (in flight: an encoder is reading its frames); the job registers this
//     pass AFTER the retry, so a night the retry has just started is already marked;
//   - no clip-storage or free-space gate, and not inside the retry: both would let a full disk stop a delete, which is
//     what frees space (the #419 reasoning);
//   - OLDEST FIRST, at most EXPIRE_MAX_PER_PASS folders and about EXPIRE_BUDGET_MS per pass (plan review): rmSync is
//     synchronous and blocks the server while it runs, and the first start after this change can face months of
//     folders at a few hundred frames each on a slow array. The rest go on the next 30-minute tick. Both numbers are
//     unmeasured guesses; the budget is checked between folders, so one folder always goes whole;
//   - each delete is checked (discardTimelapseFrames returns -1 when the folder is still there), so a folder that
//     cannot be removed is logged as a warning, never counted or logged as discarded;
//   - synchronous (no await), so a pass cannot overlap itself; per-night try/catch; never throws; returns the count.
const FRAME_EXPIRE_DAYS = 32;
const EXPIRE_MAX_PER_PASS = 20;
const EXPIRE_BUDGET_MS = 250;
const DAY_MS = 24 * 60 * 60 * 1000;

// A real date, not just the shape of one: `2026-02-30` would compare as a date but is no night the sampler named.
function isCalendarDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
}
// lstat describes a link itself, so a link (or a stray file) is never a directory here and is left alone.
function isRealDir(p) {
  try { return fs.lstatSync(p).isDirectory(); } catch { return false; }
}

export function discardExpiredFrames() {
  const nowMs = Date.now();
  // Strictly-before this UTC date = expired. YYYY-MM-DD strings compare as dates once both are real dates.
  const cutoff = new Date(nowMs - FRAME_EXPIRE_DAYS * DAY_MS).toISOString().slice(0, 10);
  const expired = frameNights()
    .filter(({ childId, nightDate }) => /^[A-Za-z0-9._-]+$/.test(childId) && isCalendarDate(nightDate) && nightDate < cutoff)
    .sort((a, b) => a.nightDate.localeCompare(b.nightDate) || a.childId.localeCompare(b.childId));
  let discarded = 0;
  let attempted = 0;
  for (const { childId, nightDate } of expired) {
    // Counted per ATTEMPT, so a folder that keeps failing cannot make one pass try (and warn about) every old folder.
    // The budget only applies after the first attempt: a slow listing alone must never leave a pass deleting nothing.
    if (attempted >= EXPIRE_MAX_PER_PASS || (attempted > 0 && Date.now() - nowMs >= EXPIRE_BUDGET_MS)) break;
    try {
      if (inFlight.has(nightKey(childId, nightDate))) continue; // an encoder is reading these frames
      if (!isRealDir(path.join(FRAMES_ROOT, childId)) || !isRealDir(path.join(FRAMES_ROOT, childId, nightDate))) continue;
      attempted += 1;
      if (discardTimelapseFrames(childId, nightDate, `the night is more than ${FRAME_EXPIRE_DAYS} days old`) >= 0) discarded += 1;
    } catch (e) {
      logger.error(`[timelapse] old-frames sweep of ${childId} ${nightDate} failed: ${e.message}`);
    }
  }
  return discarded;
}
