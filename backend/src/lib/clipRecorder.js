import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { logger, isNoisyMediaLine } from './logger.js';

// Event-recording capture core (Stage 1, "Option A"; shipped in 0.17.0).
//
// For every detection-enabled camera we run one continuous, cheap `-c copy` "segmenter" FFmpeg that
// pulls the ALREADY-published local MediaMTX path (never a second RTSP session on the camera) and
// writes short Matroska segments into a rolling ring. Because we're always buffering, a trigger can
// reach BACKWARD in time for pre-roll; the forward post-roll is captured by that same ongoing
// segmenter. On a trigger, extractClip() concatenates the segments spanning [t-pre, t+post] and trims
// them to EXACTLY the pre+post length (a second short FFmpeg). So: one long-lived cheap `-c copy`
// segmenter per recording camera, plus one short re-encode of just the ~20s clip per event — the
// re-encode is what lets the clip be an exact, admin-set length rather than rounding to the camera's
// keyframe spacing (see the trim note in extractClip). Nothing re-encodes the continuous stream.
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

// cameraId -> { proc, stopped, ringDir, ringDepthMs, janitor, holdFromMs }
const segmenters = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// cameraId and outBase become filesystem path SEGMENTS (the per-camera ring/clip dir names and the
// clip/thumb/concat-list basenames), and the concat list is then handed to ffmpeg to read. These are
// always server-generated — a camera UUID and an integer event id (or a timestamp in the spike) — never
// user input, so no traversal is reachable. Validate anyway, fail-closed: a value that isn't a single
// safe segment (letters/digits/dot/dash/underscore, and not "." / "..") can never be coerced into a
// path that escapes the clip tree. Cheap insurance against a future caller passing something unchecked.
function safePathSegment(value, label) {
  const s = String(value);
  if (s === '.' || s === '..' || !/^[A-Za-z0-9._-]+$/.test(s)) {
    throw new Error(`unsafe ${label} for clip path: ${JSON.stringify(s)}`);
  }
  return s;
}

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
// `holdFromMs` protects everything at/after that wall-clock time from pruning, however deep the ring is
// nominally sized. An on-demand recording sets it while running: the ring is sized for a ~20s alert
// clip, so a 2-minute manual recording would otherwise have its own opening pruned out from under it
// before the extraction runs. Holding is bounded by the recording's max-duration cap, so the ring can't
// grow without limit, and normal depth resumes the moment the recording ends.
function pruneRing(ringDir, depthMs, holdFromMs = null) {
  const cutoff = Math.min(Date.now() - depthMs, holdFromMs ?? Infinity);
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

// Protect ring segments back to `fromMs` from pruning, for the duration of an on-demand recording (see
// pruneRing). Returns false if no segmenter is running for the camera, so the caller can refuse to
// start a recording that would have nothing to cut.
export function holdRing(cameraId, fromMs) {
  const entry = segmenters.get(cameraId);
  if (!entry) return false;
  entry.holdFromMs = fromMs;
  return true;
}

// Resume normal depth-based pruning. Always call this when a recording ends (including on failure),
// or the ring for that camera grows until the segmenter next restarts.
export function releaseRing(cameraId) {
  const entry = segmenters.get(cameraId);
  if (entry) entry.holdFromMs = null;
}

// Start (or restart) the continuous segmenter for a camera. `pathName` is the camera's local MediaMTX
// path (camera.mediamtx_path). The ring is sized to always hold the deepest configured pre-roll plus
// the post-roll plus a margin, so a trigger can always reach back far enough.
export function startSegmenter(cameraId, pathName, { preRollSec = 5, postRollSec = 15 } = {}) {
  stopSegmenter(cameraId);

  const ringDir = path.join(RING_ROOT, safePathSegment(cameraId, 'cameraId'));
  fs.mkdirSync(ringDir, { recursive: true });
  // Start clean so stale segments from a previous run can't leak into a fresh clip.
  for (const f of safeReaddir(ringDir)) {
    if (f.endsWith('.mkv') || f.startsWith('concat-')) {
      try { fs.rmSync(path.join(ringDir, f), { force: true }); } catch { /* ignore */ }
    }
  }

  const ringDepthMs = (preRollSec + postRollSec + 4 * SEGMENT_SEC + 10) * 1000;
  // fastFails counts consecutive launches that died almost immediately (the classic case: the
  // upstream MediaMTX path is momentarily gone during a transcoder restart, so ffmpeg gets a 404
  // and exits within a second, every 5s). We used to log an ERROR on every one of those, which
  // spammed ~30 identical lines per camera blip. Now we log the first, then go quiet, and log a
  // recovery when it comes back — see the exit handler.
  const entry = { proc: null, stopped: false, ringDir, ringDepthMs, janitor: null, fastFails: 0, holdFromMs: null };
  segmenters.set(cameraId, entry);

  function launch() {
    const launchedAt = Date.now();
    const proc = spawn('ffmpeg', segmenterArgs(pathName, ringDir), {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    entry.proc = proc;

    proc.on('error', (err) => {
      // A spawn that never started. Node emits 'error' INSTEAD OF 'exit', so the exit handler below
      // never runs — and an EventEmitter 'error' with no listener THROWS, taking the backend down. The
      // sibling extractClip spawn already handles this; the segmenter did not. See issue #257.
      //
      // No relaunch: an unrunnable binary fails identically every time. Instead DELETE the map entry,
      // exactly as the transcoder/detector legs do — because every "is this camera covered?" predicate
      // here is `segmenters.has(cameraId)` (see isSegmenterRunning), which does not look at entry.proc
      // at all. Nulling the field alone left the camera reading as running: startClipCapture's guard
      // (clipCapture.js) would skip it forever, holdRing() would still return true, and an on-demand
      // Record would pass its gate, write a recordings row and only fail ~20s later inside extractClip.
      // That is precisely the "permanently dead and invisible to the healing pass" failure this whole
      // change exists to prevent. Found by adversarial review of PR #274 — the first version of this
      // handler shipped a comment claiming isSegmenterRunning() reported false; it did not.
      //
      // The janitor interval is assigned after launch() returns, but 'error' is emitted asynchronously,
      // so it is always set by the time we get here — clear it or the pruner outlives the segmenter.
      logger.error(`[clipseg:${pathName}] could not start ffmpeg: ${err.code || err.message}`);
      if (segmenters.get(cameraId) === entry) {
        if (entry.janitor) clearInterval(entry.janitor);
        segmenters.delete(cameraId);
      }
    });

    let lastLine = '';
    proc.stderr.on('data', (chunk) => {
      chunk
        .toString()
        .split('\n')
        .filter((line) => line.length > 0)
        .forEach((line) => {
          if (isNoisyMediaLine(line)) return; // same benign per-packet spam as the transcoder
          lastLine = line;
          logger.raw(`clipseg:${pathName}`, line);
        });
    });

    proc.on('exit', (code) => {
      // Only the tracked entry owns this camera; a superseded process must not resurrect itself
      // (same reasoning as transcoder.js).
      if (entry.stopped || segmenters.get(cameraId) !== entry) return;

      // A segmenter that ran a good while and then died is a real event — log it, and reset the
      // fast-fail run so a later blip starts its own fresh (loud-then-quiet) cycle. One that dies
      // almost instantly is the path-not-ready retry loop: log only the first, and periodically
      // (~once/min) after that so a genuinely stuck one still surfaces, but without the flood.
      const ranBriefly = Date.now() - launchedAt < 15000;
      if (!ranBriefly) entry.fastFails = 0;
      entry.fastFails += 1;
      const shouldLog = !ranBriefly || entry.fastFails === 1 || entry.fastFails % 12 === 0;
      if (shouldLog) {
        const note = ranBriefly && entry.fastFails > 1 ? ` (${entry.fastFails}x, upstream path not ready)` : '';
        logger.error(
          `[clipseg:${pathName}] segmenter exited (code ${code})${note}, restarting in 5s. Last output: ${lastLine}`
        );
      }
      setTimeout(() => {
        if (!entry.stopped && segmenters.get(cameraId) === entry) launch();
      }, RESTART_DELAY_MS);
    });
  }

  launch();
  entry.janitor = setInterval(() => pruneRing(ringDir, entry.ringDepthMs, entry.holdFromMs), SEGMENT_SEC * 1000);
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
  { preRollSec = 5, postRollSec = 15, at = Date.now(), outBase = String(Date.now()), settleMs = null } = {}
) {
  const entry = segmenters.get(cameraId);
  if (!entry) throw new Error(`no segmenter running for camera ${cameraId}`);
  const ringDir = entry.ringDir;

  // Wait past the post-roll AND far enough that the segment covering (at+post) has been CLOSED and a
  // fresh one opened — otherwise we'd concat a half-written tail segment and truncate the clip.
  // A detection clip is cut the moment it fires, so we must WAIT OUT its post-roll. An on-demand
  // recording is cut when the user presses Stop — that span is already in the past, so it passes a
  // short settleMs and only waits for the final segment to close.
  await sleep(settleMs ?? postRollSec * 1000 + 2 * SEGMENT_SEC * 1000 + 500);

  // Select GENEROUSLY — every segment that could touch [at-pre, at+post] plus a couple-segment margin
  // each side — so the concatenated source is guaranteed to fully contain the requested window. The
  // exact bounds are then cut by the precise trim below, so this doesn't need to be tight.
  const coverStart = at - (preRollSec + 2 * SEGMENT_SEC) * 1000;
  const coverEnd = at + (postRollSec + 2 * SEGMENT_SEC) * 1000;
  const now = Date.now();

  const segs = safeReaddir(ringDir)
    .filter((f) => f.endsWith('.mkv'))
    .map((f) => {
      const p = path.join(ringDir, f);
      return { f, p, m: statMtime(p) };
    })
    // A segment is finished ~SEGMENT_SEC after it starts; its mtime ≈ close time ≈ segment END. Keep any
    // segment whose [end-SEGMENT, end] overlaps the cover window. Skip the one still being written
    // (mtime within ~700ms of now) so we never concat a partial tail.
    .filter((s) => s.m != null && s.m - SEGMENT_SEC * 1000 <= coverEnd && s.m >= coverStart && now - s.m > 700)
    .sort((a, b) => a.m - b.m);

  if (!segs.length) throw new Error('no ring segments covered the requested window');

  // These two become path segments (the per-camera clip dir + the clip/thumb/list basenames); validate
  // before they touch the filesystem, same guard as the ring dir at start time.
  const safeId = safePathSegment(cameraId, 'cameraId');
  const safeBase = safePathSegment(outBase, 'outBase');

  const outDir = path.join(CLIPS_DIR, safeId);
  fs.mkdirSync(outDir, { recursive: true });

  // concat demuxer list. Absolute paths + `-safe 0`; single-quote-escape for safety.
  const listFile = path.join(ringDir, `concat-${safeBase}.txt`);
  fs.writeFileSync(
    listFile,
    segs.map((s) => `file '${s.p.replace(/'/g, "'\\''")}'`).join('\n') + '\n'
  );

  // Where the requested window starts within the concatenated timeline. The first segment's content
  // began ~SEGMENT_SEC before its close-time (mtime), so that's wall-clock position 0 of the concat;
  // seek forward from there to (at - pre). Clamped to 0 in case the ring didn't reach far enough back.
  const clipStartWallMs = segs[0].m - SEGMENT_SEC * 1000;
  const offsetSec = Math.max(0, (at - preRollSec * 1000 - clipStartWallMs) / 1000);
  const durSec = preRollSec + postRollSec;

  const outFile = path.join(outDir, `${safeBase}.mp4`);
  try {
    // Concatenate the ring segments, then trim to EXACTLY [pre+post] seconds. Because a `-c copy` cut
    // can only land on a keyframe (~2s GOP here), an exact, admin-set duration requires re-encoding
    // this one short clip: the frame-accurate `-ss`/`-t` (output-side) guarantees the clip is exactly
    // as long as the pre-roll + post-roll settings say — otherwise people rightly ask why a "5s + 15s"
    // clip is 27s. Only this ~20s clip is re-encoded (veryfast), once per event; the continuous ring
    // segmenter stays a cheap copy. AUDIO is re-encoded to AAC in the same pass (the ring holds the
    // clean ORIGINAL track — often G711 — which <video> can't play); no aresample=async (it dropped
    // samples and made this camera choppier — see the header note). yuv420p + faststart for browsers.
    await runFfmpeg([
      '-nostdin', '-loglevel', 'error',
      '-f', 'concat', '-safe', '0', '-i', listFile,
      '-ss', offsetSec.toFixed(3),
      '-t', String(durSec),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart',
      '-y', outFile,
    ]);
  } finally {
    try { fs.rmSync(listFile, { force: true }); } catch { /* ignore */ }
  }

  // Thumbnail — one frame from the finished clip. Best-effort (Phase 2 reuses the event snapshot).
  const thumbFile = path.join(outDir, `${safeBase}.jpg`);
  await runFfmpeg([
    '-nostdin', '-loglevel', 'error', '-i', outFile,
    '-frames:v', '1', '-q:v', '4', '-y', thumbFile,
  ]).catch(() => {});

  const probe = await probeClip(outFile);
  return { file: outFile, thumb: fs.existsSync(thumbFile) ? thumbFile : null, segments: segs.length, probe };
}
