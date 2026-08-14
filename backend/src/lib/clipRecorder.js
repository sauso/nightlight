import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';

// Event-recording capture core (Stage 1, "Option A" — see planning/recording-and-sleep-tracking-scope.md).
//
// For every detection-enabled camera we run one continuous, cheap `-c copy` "segmenter" FFmpeg that
// pulls the ALREADY-published local MediaMTX path (never a second RTSP session on the camera) and
// writes short Matroska segments into a rolling ring. Because we're always buffering, a trigger can
// reach BACKWARD in time for pre-roll; the forward post-roll is captured by that same ongoing
// segmenter. On a trigger, extractClip() concatenates the segments spanning [t-pre, t+post] into one
// browser-safe MP4 (+ a thumbnail) with a second short FFmpeg. So: one long-lived copy segmenter per
// recording camera, plus one short concat per event. Video is copied end to end (no video re-encode);
// only the clip's ~20s of audio is re-encoded once, at extract (see the AUDIO note below).
//
// AUDIO — we capture the camera's ORIGINAL audio track (`-map 0:a:0?`) and encode it to AAC ONCE at
// extract time, rather than reusing transcoder.js's own AAC track. transcoder.js publishes two audio
// tracks into MediaMTX: track 0 is the original codec (a clean `-c copy`, often G711) and track 1 is
// an AAC re-encode for HLS. The Phase-1 spike found track 1 is riddled with dropouts (its
// `aresample=async=1` drops/inserts samples on this camera's jittery timestamps — fine as background
// HLS, but "extremely choppy" once isolated in a clip; the app's default WebRTC path uses the clean
// track 0, which is why live sounds fine). Measured on staging: capturing track 1 → ~10 dropouts/12s;
// capturing track 0 and encoding AAC ourselves → 0. So we take the clean original and do our own
// single encode. `?` keeps audio optional so a genuinely silent camera still records a video-only clip.
//
// RING CONTAINER is Matroska (`.mkv`), not MPEG-TS: TS can't carry G711/pcm_alaw at all, and the
// original audio can be any codec. Matroska holds video-copy + any audio-copy and concatenates
// cleanly via the concat demuxer. Video is a pure `-c copy` everywhere; only the ~20s of audio is
// (cheaply) re-encoded, once, over the whole finished clip — so no per-segment AAC priming gaps.
//
// NOTE: this file is the reusable core. The Phase-1 spike (scripts/clip-spike.js) drives it directly;
// Phase 2 wires startSegmenter/stopSegmenter to the per-camera `detect_record_clips` toggle and
// extractClip to fireDetectionAlert, writing clip_* onto the detection_events row.

const DATA_DIR = process.env.DATA_DIR || '/app/data';
// Clips live OUTSIDE the container layer: default under the mapped /app/data, overridable to a
// separate array mount via CLIPS_DIR (see the plan's storage section). Phase 2 adds the startup
// "is this actually a mount?" guard; the spike just needs a writable dir.
export const CLIPS_DIR = process.env.CLIPS_DIR || path.join(DATA_DIR, 'clips');
// Raw segments are scratch — a hidden sibling so they're obviously not the finished clips.
const RING_ROOT = path.join(CLIPS_DIR, '.ring');

// 2s segments: short enough that pre-roll rounds to a whole-segment boundary the plan calls
// acceptable, long enough to keep the file/keyframe overhead low.
const SEGMENT_SEC = 2;
const RESTART_DELAY_MS = 5000;

// cameraId -> { proc, stopped, ringDir, ringDepthMs, janitor }
const segmenters = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function statMtime(p) {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return null;
  }
}

function segmenterArgs(pathName, ringDir) {
  return [
    '-nostdin',
    '-loglevel', 'warning',
    '-rtsp_transport', 'tcp',
    '-i', `rtsp://127.0.0.1:8554/${pathName}`,
    '-map', '0:v:0',
    '-map', '0:a:0?', // the camera's ORIGINAL audio (clean copy); optional so a silent camera records video-only
    '-c', 'copy',
    '-f', 'segment',
    '-segment_time', String(SEGMENT_SEC),
    '-segment_format', 'matroska', // NOT mpegts — TS can't carry G711/pcm_alaw; mkv holds any audio codec
    '-reset_timestamps', '1',
    // Wall-clock-named segments: human-readable + chronological. Selection uses file mtime (below), so
    // this is only for readability/ordering and is immune to the container's timezone.
    '-strftime', '1',
    path.join(ringDir, 'seg-%Y%m%d-%H%M%S.mkv'),
  ];
}

// Delete ring segments older than the ring depth. Runs on a timer while the segmenter lives.
function pruneRing(ringDir, depthMs) {
  const cutoff = Date.now() - depthMs;
  for (const f of safeReaddir(ringDir)) {
    if (!f.endsWith('.mkv')) continue;
    const p = path.join(ringDir, f);
    const m = statMtime(p);
    if (m != null && m < cutoff) {
      try {
        fs.rmSync(p, { force: true });
      } catch {
        /* raced with another prune / still open — ignore */
      }
    }
  }
}

export function isSegmenterRunning(cameraId) {
  return segmenters.has(cameraId);
}

// Start (or restart) the continuous segmenter for a camera. `pathName` is the camera's local MediaMTX
// path (camera.mediamtx_path). The ring is sized to always hold the deepest configured pre-roll plus
// the post-roll plus a margin, so a trigger can always reach back far enough.
export function startSegmenter(cameraId, pathName, { preRollSec = 5, postRollSec = 15 } = {}) {
  stopSegmenter(cameraId);

  const ringDir = path.join(RING_ROOT, String(cameraId));
  fs.mkdirSync(ringDir, { recursive: true });
  // Start clean so stale segments from a previous run can't leak into a fresh clip.
  for (const f of safeReaddir(ringDir)) {
    if (f.endsWith('.mkv') || f.startsWith('concat-')) {
      try { fs.rmSync(path.join(ringDir, f), { force: true }); } catch { /* ignore */ }
    }
  }

  const ringDepthMs = (preRollSec + postRollSec + 4 * SEGMENT_SEC + 10) * 1000;
  const entry = { proc: null, stopped: false, ringDir, ringDepthMs, janitor: null };
  segmenters.set(cameraId, entry);

  function launch() {
    const proc = spawn('ffmpeg', segmenterArgs(pathName, ringDir), {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    entry.proc = proc;

    let lastLine = '';
    proc.stderr.on('data', (chunk) => {
      chunk
        .toString()
        .split('\n')
        .filter((line) => line.length > 0)
        .forEach((line) => {
          lastLine = line;
          logger.raw(`clipseg:${pathName}`, line);
        });
    });

    proc.on('exit', (code) => {
      // Only the tracked entry owns this camera; a superseded process must not resurrect itself
      // (same reasoning as transcoder.js).
      if (entry.stopped || segmenters.get(cameraId) !== entry) return;
      logger.error(
        `[clipseg:${pathName}] segmenter exited (code ${code}), restarting in 5s. Last output: ${lastLine}`
      );
      setTimeout(() => {
        if (!entry.stopped && segmenters.get(cameraId) === entry) launch();
      }, RESTART_DELAY_MS);
    });
  }

  launch();
  entry.janitor = setInterval(() => pruneRing(ringDir, entry.ringDepthMs), SEGMENT_SEC * 1000);
  logger.info(
    `[clipseg:${pathName}] segmenter started (ring ${ringDir}, depth ${Math.round(ringDepthMs / 1000)}s)`
  );
  return entry;
}

export function stopSegmenter(cameraId) {
  const entry = segmenters.get(cameraId);
  if (!entry) return;
  entry.stopped = true;
  if (entry.janitor) clearInterval(entry.janitor);
  segmenters.delete(cameraId);
  try {
    entry.proc?.kill('SIGTERM');
  } catch {
    /* already gone */
  }
}

export function stopAllSegmenters() {
  for (const cameraId of [...segmenters.keys()]) stopSegmenter(cameraId);
}

function runFfmpeg(args, { tool = 'ffmpeg' } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(tool, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    proc.stdout.on('data', (c) => out.push(c));
    proc.stderr.on('data', (c) => err.push(c));
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code === 0) resolve(Buffer.concat(out).toString());
      else reject(new Error(`${tool} exited ${code}: ${Buffer.concat(err).toString().slice(-500)}`));
    });
  });
}

// ffprobe the finished clip so the spike can assert what actually came out: container, video/audio
// codecs (is audio AAC and not G711?), duration, and whether the moov atom is at the front (faststart,
// required for progressive <video> playback). Returns a compact summary object.
export async function probeClip(file) {
  const json = await runFfmpeg(
    ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file],
    { tool: 'ffprobe' }
  );
  const data = JSON.parse(json);
  const v = (data.streams || []).find((s) => s.codec_type === 'video');
  const a = (data.streams || []).find((s) => s.codec_type === 'audio');
  return {
    format: data.format?.format_name,
    durationSec: data.format?.duration ? Number(data.format.duration) : null,
    bytes: data.format?.size ? Number(data.format.size) : null,
    video: v ? `${v.codec_name} ${v.width}x${v.height}` : null,
    audio: a ? `${a.codec_name} ${a.sample_rate || '?'}Hz` : null,
  };
}

// Concatenate the ring segments covering [at-pre, at+post] into one faststart MP4 (+ JPEG thumbnail).
// Waits out the post-roll first so the forward segments actually exist. `outBase` names the files
// (Phase 2 passes the eventId; the spike passes a timestamp). Returns { file, thumb, segments, probe }.
export async function extractClip(
  cameraId,
  { preRollSec = 5, postRollSec = 15, at = Date.now(), outBase = String(Date.now()) } = {}
) {
  const entry = segmenters.get(cameraId);
  if (!entry) throw new Error(`no segmenter running for camera ${cameraId}`);
  const ringDir = entry.ringDir;

  // Wait past the post-roll AND far enough that the segment covering (at+post) has been CLOSED and a
  // fresh one opened — otherwise we'd concat a half-written tail segment and truncate the clip.
  await sleep(postRollSec * 1000 + 2 * SEGMENT_SEC * 1000 + 500);

  // Exact requested bounds; whole-segment overlap (below) still keeps the segments straddling each
  // edge, so pre/post-roll is never cut short — we just don't over-capture an extra segment each side.
  const windowStart = at - preRollSec * 1000;
  const windowEnd = at + postRollSec * 1000;
  const now = Date.now();

  const segs = safeReaddir(ringDir)
    .filter((f) => f.endsWith('.mkv'))
    .map((f) => {
      const p = path.join(ringDir, f);
      return { f, p, m: statMtime(p) };
    })
    // A segment is finished ~SEGMENT_SEC after it starts; its mtime ≈ close time ≈ segment END. Keep any
    // segment whose [end-SEGMENT, end] overlaps the window. Skip the one still being written (mtime
    // within ~700ms of now) so we never concat a partial tail.
    .filter((s) => s.m != null && s.m - SEGMENT_SEC * 1000 <= windowEnd && s.m >= windowStart && now - s.m > 700)
    .sort((a, b) => a.m - b.m);

  if (!segs.length) throw new Error('no ring segments covered the requested window');

  const outDir = path.join(CLIPS_DIR, String(cameraId));
  fs.mkdirSync(outDir, { recursive: true });

  // concat demuxer list. Absolute paths + `-safe 0`; single-quote-escape for safety.
  const listFile = path.join(ringDir, `concat-${outBase}.txt`);
  fs.writeFileSync(
    listFile,
    segs.map((s) => `file '${s.p.replace(/'/g, "'\\''")}'`).join('\n') + '\n'
  );

  const outFile = path.join(outDir, `${outBase}.mp4`);
  try {
    // mkv ring -> mp4. VIDEO is a pure copy (cheap, no re-encode; ffmpeg auto-applies h264_mp4toannexb).
    // AUDIO is encoded to AAC ONCE over the whole concatenated clip — the ring holds the clean ORIGINAL
    // audio (a `-c copy`, e.g. G711) so this single encode produces continuous, dropout-free AAC with
    // no per-segment priming gaps. Deliberately NO aresample=async here: on this camera's already-clean
    // original track it only dropped/inserted samples and made things choppier (measured — see the
    // header note). +faststart puts moov up front for progressive <video> playback.
    await runFfmpeg([
      '-nostdin', '-loglevel', 'error',
      '-f', 'concat', '-safe', '0', '-i', listFile,
      '-c:v', 'copy',
      '-c:a', 'aac', '-b:a', '128k',
      '-avoid_negative_ts', 'make_zero',
      '-movflags', '+faststart',
      '-y', outFile,
    ]);
  } finally {
    try { fs.rmSync(listFile, { force: true }); } catch { /* ignore */ }
  }

  // Thumbnail — one frame from the finished clip. Best-effort (Phase 2 reuses the event snapshot).
  const thumbFile = path.join(outDir, `${outBase}.jpg`);
  await runFfmpeg([
    '-nostdin', '-loglevel', 'error', '-i', outFile,
    '-frames:v', '1', '-q:v', '4', '-y', thumbFile,
  ]).catch(() => {});

  const probe = await probeClip(outFile);
  return { file: outFile, thumb: fs.existsSync(thumbFile) ? thumbFile : null, segments: segs.length, probe };
}
