import { spawnChild } from './childEnv.js';
import fs from 'fs';
import path from 'path';
import { logger, isNoisyMediaLine } from './logger.js';
import { forwardProcessLines, createLineBuffer } from './processOutput.js';
import { addHold, removeHold, effectiveHold, clearHolds } from './ringHolds.js';
import { killIfSpawned, isKillError, execFailureBackoff, describeExecFailure } from './processGuards.js';
import { CLIPS_DIR, resolveClipsDir } from './clipsDir.js';
import { statMediaFile, unlinkMediaFile, safeSegmentNames } from './mediaFiles.js';
import { ensureClipsFolder, writeInputFile } from './mediaLayout.js';

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

// CLIPS_DIR (and resolveClipsDir, with its #545 note on why it is normalised once) now live in clipsDir.js, so that
// mediaFiles.js and mediaLayout.js can use them without importing this file back. Re-exported: every importer
// (and the tests) still gets them from here.
export { CLIPS_DIR, resolveClipsDir };
// Raw segments are scratch — CLIPS_DIR/.ring/<cameraId>, a hidden sibling so they're obviously not the finished clips.
// The concat lists extractClip hands ffmpeg. NOT in the ring folder: that is one the media user writes into, and a
// list is an INPUT it must read and never change (#553 phase 2b, mediaLayout.js). Per camera, so a clean-up and the
// purge can take a camera's whole folder.
export const CONCAT_SUBDIR = '.concat';

// 2s segments: short enough that pre-roll rounds to a whole-segment boundary the plan calls
// acceptable, long enough to keep the file/keyframe overhead low.
const SEGMENT_SEC = 2;
// A segment whose mtime is within this long of now is still being written. extractClip skips it so it never
// concatenates a partial tail, and ringOldestStartMs (#412) applies the SAME test, from this one constant, so
// the wake watcher's clamp and the cut can never disagree about which segments exist. An open segment's mtime
// moves forward with every write, so one whose mtime is this close to now may still be growing. 700 ms is the
// value extractClip has always used; where it came from is not recorded (not a measurement).
const SEGMENT_OPEN_MS = 700;
const RESTART_DELAY_MS = 5000;

// cameraId -> { proc, stopped, ringDir, ringDepthMs, janitor }. Holds live in ringHolds.js, keyed by
// owner, because THREE features share this ring — see #255 (on-demand Record vs. wake clips) and #446
// (a detection clip mid-extraction gained its own hold too, once a settings save could resize the ring
// out from under one — see clipCapture.js's enqueueClip).
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

// A segment's mtime, or null when it is gone or not a plain one-name file. statMediaFile (lstat), not stat: a
// symbolic link the media user planted under a segment's name must not borrow its target's age (#553 phase 2b).
function statMtime(p) {
  return statMediaFile(p)?.mtimeMs ?? null;
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
  // Only the segmenter's own names (safeSegmentNames), and a flat unlink of each (unlinkMediaFile): the ring folder is
  // one the media user writes into (#553 phase 2b).
  for (const f of safeSegmentNames(safeReaddir(ringDir))) {
    const p = path.join(ringDir, f);
    const m = statMtime(p);
    if (m != null && m < cutoff) {
      try {
        unlinkMediaFile(p);
      } catch {
        /* raced with another prune / still open — ignore */
      }
    }
  }
}

export function isSegmenterRunning(cameraId) {
  return segmenters.has(cameraId);
}

// Protect ring segments back to `fromMs` from pruning (see pruneRing), on behalf of ONE named owner.
// Returns false if no segmenter is running for the camera, so the caller can refuse to start a
// recording that would have nothing to cut.
//
// `owner` is required, and must be a distinct key per holder — RING_OWNER.WAKE for the wake watcher, or
// `ondemandHoldOwner(recordingId)` (ringHolds.js) for on-demand Record, one per capture. Before #255,
// two features (Record and wake clips) shared a single slot, so whichever acted last silently replaced
// the other's protection and whichever finished first destroyed it; #445 found the identical bug ONE
// LEVEL DOWN, between two overlapping on-demand recordings sharing the bare RING_OWNER.ONDEMAND string.
// See ringHolds.js.
export function holdRing(cameraId, owner, fromMs) {
  const entry = segmenters.get(cameraId);
  if (!entry) return false;
  addHold(cameraId, owner, fromMs);
  return true;
}

// Resume normal pruning for ONE owner. Always call this when that owner's work ends (including on
// failure), or its hold keeps the ring growing until the segmenter next restarts. Other owners'
// holds are untouched — that is the whole point of #255.
export function releaseRing(cameraId, owner) {
  removeHold(cameraId, owner);
}

// The ring depth: always the deepest configured pre-roll plus the post-roll plus a margin, so a
// trigger can always reach back far enough. Factored out of startSegmenter (#446) so setRingDepth can
// recompute it for a RUNNING ring, when settings change, without restarting the segmenter — see its
// comment for why a restart is no longer needed just to change this number.
export function ringDepthMsFor(preRollSec, postRollSec) {
  return (preRollSec + postRollSec + 4 * SEGMENT_SEC + 10) * 1000;
}

// Start (or restart) the continuous segmenter for a camera. `pathName` is the camera's local MediaMTX
// path (camera.mediamtx_path). The ring is sized to always hold the deepest configured pre-roll plus
// the post-roll plus a margin, so a trigger can always reach back far enough.
export function startSegmenter(cameraId, pathName, { preRollSec = 5, postRollSec = 15 } = {}) {
  stopSegmenter(cameraId);

  const safeId = safePathSegment(cameraId, 'cameraId');
  // The ring folder is a media-writable LEAF (mediaLayout.js): made, or repaired if it is an older app-only one.
  const ringDir = ensureClipsFolder(['.ring', safeId], { leaf: true });
  // Start clean so stale segments from a previous run can't leak into a fresh clip. EVERYTHING in the folder goes
  // (a flat unlink of each name): since #553 phase 2b the app's concat lists live elsewhere, so what is here was
  // written by the media user, and a stray file of any name is junk, not footage. A stray folder cannot be unlinked and
  // stays (the error is swallowed); nothing recurses into a folder the media user can write.
  for (const f of safeReaddir(ringDir)) {
    try { unlinkMediaFile(path.join(ringDir, f)); } catch { /* ignore */ }
  }
  // Concat lists left by a run that was killed mid-cut (the finally in extractClip removes them otherwise).
  const listDir = path.join(CLIPS_DIR, CONCAT_SUBDIR, safeId);
  for (const f of safeReaddir(listDir)) {
    try { unlinkMediaFile(path.join(listDir, f)); } catch { /* ignore */ }
  }

  const ringDepthMs = ringDepthMsFor(preRollSec, postRollSec);
  // fastFails counts consecutive launches that died almost immediately (the classic case: the
  // upstream MediaMTX path is momentarily gone during a transcoder restart, so ffmpeg gets a 404
  // and exits within a second, every 5s). We used to log an ERROR on every one of those, which
  // spammed ~30 identical lines per camera blip. Now we log the first, then go quiet, and log a
  // recovery when it comes back — see the exit handler.
  const entry = { proc: null, stopped: false, ringDir, ringDepthMs, janitor: null, fastFails: 0 };
  segmenters.set(cameraId, entry);
  // #553: a 126/127 at once (the program, or the switch to the media user, could not run) backs off from RESTART_DELAY_MS
  // to a minute with its own line (processGuards.js, execFailureBackoff). Every other exit keeps the fast-fail logging
  // below and the 5 s relaunch. Per segmenter entry, like fastFails.
  const execBackoff = execFailureBackoff(RESTART_DELAY_MS);

  function launch() {
    const launchedAt = Date.now();
    const proc = spawnChild('ffmpeg', segmenterArgs(pathName, ringDir), {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    execBackoff.launched();
    entry.proc = proc;

    proc.on('error', (err) => {
      // #553: a SIGNAL that could not be delivered (EPERM), not a failed spawn (isKillError): the segmenter is still
      // running and writing the ring. Deregistering it here would let startClipCapture start a second one into the same
      // folder. Keep the entry; its 'exit' still does the rest.
      if (isKillError(err)) {
        logger.error(`[clipseg:${pathName}] could not signal the segmenter (pid ${proc.pid}): ${err.code || err.message}. It is still running.`);
        return;
      }
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
    forwardProcessLines(proc, proc.stderr, (line) => {
      if (isNoisyMediaLine(line)) return; // same benign per-packet spam as the transcoder
      lastLine = line;
      logger.raw(`clipseg:${pathName}`, line);
    });

    proc.on('exit', (code) => {
      // Only the tracked entry owns this camera; a superseded process must not resurrect itself
      // (same reasoning as transcoder.js).
      if (entry.stopped || segmenters.get(cameraId) !== entry) return;

      const next = execBackoff.exited(code);
      if (next.execFailed) {
        if (next.log) logger.error(`[clipseg:${pathName}] ${describeExecFailure('the segmenter (ffmpeg)', next)} Last output: ${lastLine}`);
        setTimeout(() => {
          if (!entry.stopped && segmenters.get(cameraId) === entry) launch();
        }, next.delayMs);
        return;
      }

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
  entry.janitor = setInterval(() => pruneRing(ringDir, entry.ringDepthMs, effectiveHold(cameraId)), SEGMENT_SEC * 1000);
  logger.info(
    `[clipseg:${pathName}] segmenter started (ring ${ringDir}, depth ${Math.round(ringDepthMs / 1000)}s)`
  );
  return entry;
}

export function stopSegmenter(cameraId) {
  clearHolds(cameraId); // the ring is about to go; a surviving hold would apply to the next one
  const entry = segmenters.get(cameraId);
  if (!entry) return;
  entry.stopped = true;
  if (entry.janitor) clearInterval(entry.janitor);
  segmenters.delete(cameraId);
  // ⚠️ killIfSpawned, NOT proc.kill — see processGuards.js. A launch whose spawn has failed but whose
  // 'error' has not arrived yet has `pid === undefined`, and killing THAT on Linux signals the whole
  // process group: the backend SIGTERMs itself. This exact call is the one that was measured doing it.
  killIfSpawned(entry.proc, 'SIGTERM');
}

export function stopAllSegmenters() {
  for (const cameraId of [...segmenters.keys()]) stopSegmenter(cameraId);
}

// Resize a RUNNING ring's depth in place: no ffmpeg restart, no ring-dir deletion, no clearHolds (#446).
// Before this existed, the only way to change depth was startSegmenter (via restartClipCapture), which
// stops the segmenter first — and stopSegmenter unconditionally clears every hold and deletes every
// segment on (re)start. That destroyed an active recording, a wake-clip hold, or a detection clip
// mid-extraction on ANY pre/post-roll edit, even though depth is just a plain field the janitor already
// re-reads every tick (see the `setInterval` in startSegmenter) — a shrink takes effect on the very next
// tick, and pruneRing never prunes past `effectiveHold`, so every active consumer keeps exactly what it
// holds while the nominal depth changes around it. Returns false if nothing is running for this camera.
export function setRingDepth(cameraId, { preRollSec, postRollSec }) {
  const entry = segmenters.get(cameraId);
  if (!entry) return false;
  entry.ringDepthMs = ringDepthMsFor(preRollSec, postRollSec);
  return true;
}

// Diagnostic only: the ring depth currently in effect, or null if nothing is running for this camera.
// Exported so a test can assert a resize actually happened WITHOUT re-deriving ringDepthMsFor itself —
// re-implementing the formula in an assertion would test the assertion against itself, not the code
// (see clip-capture.test.js's file header on exactly this trap).
export function ringDepthMs(cameraId) {
  return segmenters.get(cameraId)?.ringDepthMs ?? null;
}

// The wall-clock point a hold or an extraction must reach back to for a clip centred at `at` with this
// pre-roll — mirrors extractClip's own generous selection margin (2 extra segments either side) exactly,
// so a caller that takes a hold from this formula can never be shallower than what extractClip will
// actually read back (#446, Codex F2: a lease that exists but is too shallow must still fail the case it
// exists for). The hold and the extraction share this ONE formula and cannot drift apart.
export function clipCoverStartMs(at, preRollSec) {
  return at - (preRollSec + 2 * SEGMENT_SEC) * 1000;
}

// The wall-clock time the OLDEST footage in this camera's ring starts at (the content start of its oldest
// CLOSED segment: close time minus SEGMENT_SEC, the same convention extractClip uses for its offset), or
// null when there is no segmenter or no closed segment yet. #412: the wake watcher clamps a clip's anchor
// to this, because a clip that opens before the ring's oldest footage has an EMPTY selection in extractClip
// ("no ring segments covered the requested window") and the row goes `failed`; extractClip's own
// `Math.max(0, ...)` offset clamp only runs after a non-empty selection, so it does not protect that case.
// WHY it reads the files and not the nominal depth: a ring that was wiped (a settings save restarts it), is
// still filling after a start, or was just grown by setRingDepth is YOUNGER than its depth, and a clamp on
// the nominal depth would anchor before its first segment and fail a clip the unclamped code cuts. This reads
// the same directory, the same mtimes and the same closed-segment test (SEGMENT_OPEN_MS) as extractClip's
// selection, so the clamp and the cut cannot disagree. Approximate to the janitor's tick (a segment can
// outlive its depth by up to SEGMENT_SEC): the caller's docs say +-4 s (2 s segment + 2 s janitor tick,
// reasoned, not measured).
export function ringOldestStartMs(cameraId) {
  const entry = segmenters.get(cameraId);
  if (!entry) return null;
  const now = Date.now();
  let oldest = null;
  for (const f of safeSegmentNames(safeReaddir(entry.ringDir))) { // only the segmenter's own names are footage
    const m = statMtime(path.join(entry.ringDir, f));
    if (m == null || now - m <= SEGMENT_OPEN_MS) continue; // gone, or still being written
    if (oldest === null || m < oldest) oldest = m;
  }
  return oldest === null ? null : oldest - SEGMENT_SEC * 1000;
}

// The ring segments extractClip would concatenate for a clip at `at` (oldest first): every CLOSED segment whose
// [mtime - SEGMENT_SEC, mtime] overlaps [clipCoverStartMs(at, pre), at + post + 2 segments]. A segment is finished
// ~SEGMENT_SEC after it starts; its mtime ≈ close time ≈ segment END. The one still being written (mtime within
// SEGMENT_OPEN_MS of `now`) is skipped so a partial tail is never concatenated. Select GENEROUSLY (a couple of
// segments of margin each side): the exact bounds are cut by the precise trim afterwards.
// #412: extracted so extractClip and ringHasFootageFor below use ONE selection and cannot disagree.
function selectRingSegments(ringDir, at, preRollSec, postRollSec, now) {
  const coverStart = clipCoverStartMs(at, preRollSec);
  const coverEnd = at + (postRollSec + 2 * SEGMENT_SEC) * 1000;
  // safeSegmentNames: this list becomes a concat list read with `-safe 0`, so a name the media user chose (a newline
  // or a quote in it) must never reach it (#553 phase 2b).
  return safeSegmentNames(safeReaddir(ringDir))
    .map((f) => {
      const p = path.join(ringDir, f);
      return { f, p, m: statMtime(p) };
    })
    .filter((s) => s.m != null && s.m - SEGMENT_SEC * 1000 <= coverEnd && s.m >= coverStart && now - s.m > SEGMENT_OPEN_MS)
    .sort((a, b) => a.m - b.m);
}

// Would extractClip find ANY footage for a clip at `at` right now? false when there is no segmenter. #412: the wake
// watcher asks this before anchoring a clip EARLIER than today's anchor, because ringOldestStartMs only reads the
// OLDEST segment and a ring can have a hole after it (the motion detector may read the camera's sub stream while
// the ring records the main one, and a relaunch keeps the old segments): the oldest segment then reaches back past
// the first frame but nothing covers the clip's window, extractClip's selection is empty and the row fails, where
// the old anchor would have been cut. Same selection function as extractClip, so the answer cannot drift from the cut.
export function ringHasFootageFor(cameraId, { at, preRollSec, postRollSec }) {
  const entry = segmenters.get(cameraId);
  if (!entry) return false; // a camera with no segmenter has no footage
  return selectRingSegments(entry.ringDir, at, preRollSec, postRollSec, Date.now()).length > 0;
}

// --- Deadlines for the extraction children (#773) ---------------------------------------------------
// WHY THERE IS ONE. runFfmpeg used to settle only on the child's 'exit' or 'error'. A child that never exits
// (a stuck read, a wedged encoder) kept its capture's promise pending forever, and every capture holds the ring
// for as long as it runs (a detection clip's clipHoldOwner, an on-demand recording's ondemandHoldOwner, a wake
// clip's wakeCaptureHoldOwner). So one hung child kept the janitor from pruning past that clip's start (the ring
// grows by the camera's bitrate, ~172 KiB/s, about 10 MB a minute, at the rate recordings.js quotes), kept a ring
// nobody wants running (reconcileClipRing defers its stop while any hold exists), left the camera in clipCapture's
// busyCameras (so every later detection on it was folded into a clip that never came), held one of the queue's two
// slots, and left the Stop request (routes/cameras.js) waiting. Not reproduced: found by the plan review of #471/#490.
//
// The costs are LOPSIDED, and every number below leans the same way because of it: a deadline that fires late
// costs a few more MB of ring for a few more minutes; a deadline that fires early DESTROYS a recording someone
// pressed Record for. So the windows are minutes, not seconds.
//
// The clips these cover (the bounds are routes/settings.js's): a detection clip is at most 30 + 120 = 150 s, a
// wake clip at most 3 + 120 = 123 s (WAKE_CLIP_LEAD_SEC + wake_clip_seconds), an on-demand recording at most
// 60 + 600 + 2 = 662 s (pre-roll + the max-duration cap + recordings.js's TAIL_SEC; its MAX_ACTIVE_MS backstop is
// longer, but the cap of 600 s always fires first, so it is unreachable from the UI).

// THE RE-ENCODE (extractClip's libx264 pass) gets a STALL deadline, not a wall-clock one: it is cut only when
// ffmpeg's own progress counters stop moving, never for being slow. A clip's encode time depends on its length,
// the camera's resolution and the server's CPU, none of which this code knows, so any wall-clock number would be
// a guess about someone else's machine; "nothing has moved for N minutes" is not.
//
// The window has two parts, and a reason for each:
//   * STALL_WINDOW_BASE_MS covers the stretches where nothing moves although nothing is wrong: opening the inputs
//     and starting the encoders (before the first progress block), the output-side `-ss` decode-and-discard at
//     the start (a few seconds of footage: the selection margin is two segments), and the encoder flush at the end.
//   * One second per STALL_ASSUMED_BYTES_PER_SEC already written covers the END of the encode, which reports no
//     progress at all and grows with the file: `-movflags +faststart` rewrites the whole MP4 to move its index to
//     the front, a read and a write of every byte, after the last progress block. A 662 s recording from a 4K camera
//     is ~0.8 GB; on a parity-protected array at 30-40 MB/s that pass alone can pass 60 s. 2 MB/s is deliberately
//     pessimistic (roughly ten times slower than that), so the window at that size is 120 + 400 = 520 s.
// ⚠️ A HYPOTHESIS, NOT A MEASUREMENT. Neither number was timed on the owner's server or any other machine (no
// ffmpeg was available where this was written). Someone on a slower disk or a higher-bitrate camera gets a larger
// file and so a larger window, still generous: the allowance scales with exactly the thing that makes the tail
// slow. The `[clip] cut ...` line runFfmpeg logs for every extraction (see logProgressRun below) records the
// longest stretch without progress and the length of the silent tail, which is what to calibrate both from.
// ⚠️ NO WALL-CLOCK BACKSTOP ON TOP, deliberately: the input is a finite list of local files and the output is
// limited by `-t`, so a child whose counters keep advancing is getting closer to the end and must finish; cutting
// it would only ever destroy a slow-but-working recording. Known limit, stated: a child that keeps advancing its
// counters and never finishes is never cut. The calibration line is how a backstop could later be sized from data.
export const STALL_WINDOW_BASE_MS = 120_000;
export const STALL_ASSUMED_BYTES_PER_SEC = 2_000_000;

// The stall window after a child has reported `totalSizeBytes` written (0 before it has reported anything).
export function stallWindowMs(totalSizeBytes) {
  const bytes = Number.isFinite(totalSizeBytes) && totalSizeBytes > 0 ? totalSizeBytes : 0;
  return STALL_WINDOW_BASE_MS + Math.ceil((bytes / STALL_ASSUMED_BYTES_PER_SEC) * 1000);
}

// ffprobe and the one-frame thumbnail read a FINISHED local file: the headers, or a single frame. That takes
// milliseconds, so they get a plain wall-clock deadline, and a generous one: 120 s is a judgement, not a
// measurement (unmeasured, like the stall window above), chosen so that only a child that is really stuck reaches it.
export const PROBE_DEADLINE_MS = 120_000;

// Remove one file this extraction itself named (the clip or its thumbnail, from safePathSegment). Never anything
// else, and never a directory: a flat unlink (unlinkMediaFile) throws on a directory, and the catch swallows that.
// The folder is one the media user writes into, hence the helper and not a plain rm (#553 phase 2b).
function removeOwnFile(file) {
  try { unlinkMediaFile(file); } catch { /* not a plain file: leave it */ }
}

const secs = (ms) => (ms == null ? '?' : (ms / 1000).toFixed(1));
const stalledFor = (ms) => `made no progress for ${secs(ms)} s`;

// One child of extractClip/probeClip, settled exactly once: on 'close', on 'error', or when its deadline fires.
// ⚠️ 'close', NOT 'exit' (Codex review of #783, P1, verified by running extractClip with a fake child): Node emits
// 'exit' when the process ends, which can be BEFORE the last of its stdout has been read; 'close' comes only once its
// stdio has drained. Resolving on 'exit' handed probeClip half its JSON ("Unexpected end of JSON input"), and the
// failure cleanup in extractClip then deleted a clip that had been encoded perfectly well. The 'exit' code is still
// recorded: if 'close' never comes (something else holding the pipe open), the deadline settles on that code instead
// of treating a child that has already exited as stuck.
//   deadlineMs      a wall-clock deadline from spawn (probe, thumbnail).
//   stallLabel      instead: read ffmpeg's `-progress pipe:1` output and apply the stall window above. The label
//                   names the clip in the one log line per run. Progress output is NOT kept (it would be most of
//                   the process's output and nothing reads it); the resolved value is then ''.
//   progressKind    #781 lets timelapse use the same helper and identify its calibration line; the default
//                   preserves every byte of the existing [clip] cut line for clipRecorder callers.
// On a deadline the child is SIGKILLed and the promise REJECTS AT ONCE, without waiting for its 'exit': a process
// stuck in the kernel (uninterruptible I/O) may not exit even on SIGKILL, and waiting for it would rebuild the very
// hang this exists to end. `settled` makes a later 'close' or 'error' a no-op.
export function runFfmpeg(args, { tool = 'ffmpeg', deadlineMs = null, stallLabel = null, progressKind = 'clip' } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawnChild(tool, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    let settled = false;
    let timer = null;
    let exited = false; // the process has ended ('exit'), its stdio may not have drained yet
    let exitCode = null;
    // Monotonic, for the calibration line only: a wall-clock step must not read as a 10-minute gap. Nothing
    // DECIDES on it (the deadline is a timer), so it plays no part in when a child is cut.
    const t0 = performance.now();
    const run = stallLabel == null ? null : {
      // The largest value seen so far for each counter, from 0: only a value ABOVE it is progress.
      seen: { frame: 0, total_size: 0, out_time_us: 0 },
      lastAdvanceAt: t0,
      maxGapMs: 0,
      lastContinueAt: null,
      windowMs: stallWindowMs(0),
    };

    const settle = (ok, value, outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (run) logProgressRun(stallLabel, run, t0, outcome, progressKind);
      if (ok) resolve(value);
      else reject(value);
    };
    const settleOnCode = (code) => {
      if (code === 0) settle(true, Buffer.concat(out).toString(), 'finished');
      else settle(false, new Error(`${tool} exited ${code}: ${Buffer.concat(err).toString().slice(-500)}`), `failed (exit ${code})`);
    };

    // clearTimeout + a NEW setTimeout, never `timer.refresh()` and never setInterval: under node:test's mock timers
    // refresh() does not move the deadline (verified on Node 24.18 while writing #773: a 1 s timer refreshed at
    // 0.8 s still fired at 1.1 s), so the tests could not see the reset at all; and test/helpers/sourceScan.js
    // sweeps src/ for intervals. unref'd: four suites spawn with an empty PATH (clip-recorder, clip-capture,
    // recordings-lifecycle, wake-watcher), and a pending timer that is not unref'd would hold a test process open,
    // the #278 failure.
    const arm = (ms, why) => {
      if (settled) return; // a child that keeps talking after it was given up on must not re-arm anything
      clearTimeout(timer);
      timer = setTimeout(() => {
        // Already exited, and only its stdio never closed: it is not stuck, so judge it by its exit code on what
        // arrived, and signal nothing (there is no process left to kill).
        if (exited) return settleOnCode(exitCode);
        // killIfSpawned, never proc.kill: on Linux, killing a child whose spawn failed signals our whole process
        // group (processGuards.js, #263/#297).
        killIfSpawned(proc, 'SIGKILL');
        settle(false, new Error(`${tool} ${why(ms)}; killed it`), 'given up on (killed)');
      }, ms);
      timer.unref?.();
    };

    if (run) {
      // A reader for the WHOLE run, not only while we care: unread progress output fills the 64 KiB pipe, the
      // child then blocks on its next write, and that blocked child would look exactly like a stall.
      const lines = createLineBuffer((line) => {
        const m = /^(frame|total_size|out_time_us)=(\d+)\s*$/.exec(line);
        if (m) {
          const v = Number(m[2]);
          // ONLY an increase is progress. ffmpeg 7+ prints a `progress=continue` block every 0.5 s from its main
          // thread even while a worker thread is hung, with the counters frozen (read in ffmpeg 7.x's source by the
          // plan review, not run here), so "any output resets the timer" would never cut a hung encode. The
          // Dockerfile installs whatever ffmpeg node:24-alpine's `apk add ffmpeg` resolves to, so the major version
          // can change with no diff here: this rule has to hold for either behaviour, and "a counter went up" does.
          if (v > run.seen[m[1]]) {
            run.seen[m[1]] = v;
            const now = performance.now();
            run.maxGapMs = Math.max(run.maxGapMs, now - run.lastAdvanceAt);
            run.lastAdvanceAt = now;
            run.windowMs = stallWindowMs(run.seen.total_size);
            arm(run.windowMs, stalledFor);
          }
        } else if (line === 'progress=continue') {
          run.lastContinueAt = performance.now();
        }
      });
      proc.stdout.on('data', (c) => lines.write(c));
      arm(run.windowMs, stalledFor);
    } else {
      proc.stdout.on('data', (c) => out.push(c));
      if (deadlineMs != null) arm(deadlineMs, (ms) => `did not finish within ${secs(ms)} s`);
    }
    proc.stderr.on('data', (c) => err.push(c));
    // Stays attached for the child's whole life, settled or not: an 'error' emitted with no listener THROWS and
    // takes the backend down (the #257 class). So nothing here ever removes a listener.
    // A spawn that fails emits 'error' and may never emit 'close'; this settles it either way.
    // #553: but a SIGNAL that could not be delivered (EPERM, isKillError) is not "could not run": it is reported on this
    // same event, synchronously inside the deadline's kill, and used to settle first with that wrong outcome. The
    // deadline settles it with its own reason right after; only say that the kill failed.
    proc.on('error', (e) => {
      if (isKillError(e)) {
        logger.error(`[${tool}] could not signal ${tool} (pid ${proc.pid}): ${e.code || e.message}. It may still be running.`);
        return;
      }
      settle(false, e, `could not run (${e.code || e.message})`);
    });
    proc.on('exit', (code) => {
      exited = true;
      exitCode = code;
    });
    proc.on('close', (code) => settleOnCode(exited ? exitCode : code));
  });
}

// The calibration line (#773): one per extraction, whatever the outcome, so the stall window (and any future
// wall-clock backstop) can be sized from real runs instead of from the guesses above.
//   longest wait   the longest the stall timer ran without being reset (between two counter increases, or from
//                  the last one to the end): how close this run came to being cut.
//   tail           from the last `progress=continue` block to the end: the encoder flush plus the faststart rewrite.
//                  Measured to the last CONTINUE block, not the last block, because ffmpeg prints its final
//                  `progress=end` block only after writing the trailer (our reading of fftools/ffmpeg.c, not
//                  verified by running ffmpeg), so counting that block would hide the very tail this is for.
function logProgressRun(label, run, t0, outcome, progressKind) {
  const now = performance.now();
  const maxGapMs = Math.max(run.maxGapMs, now - run.lastAdvanceAt);
  const tailMs = run.lastContinueAt == null ? null : now - run.lastContinueAt;
  logger.info(
    `[${progressKind}] ${progressKind === 'clip' ? 'cut' : 'assemble'} ${label}: ${outcome} after ${secs(now - t0)} s; longest wait for progress ${secs(maxGapMs)} s, ` +
      `${secs(tailMs)} s after the last progress report; stall window at the end ${secs(run.windowMs)} s`
  );
}

// ffprobe the finished clip so the spike can assert what actually came out: container, video/audio
// codecs (is audio AAC and not G711?), duration, and whether the moov atom is at the front (faststart,
// required for progressive <video> playback). Returns a compact summary object.
export async function probeClip(file) {
  const json = await runFfmpeg(
    ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file],
    { tool: 'ffprobe', deadlineMs: PROBE_DEADLINE_MS }
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
  // coverStart shares its formula with clipCoverStartMs (#446) — a hold taken from that function is
  // guaranteed to reach at least as far back as this selection actually reads.
  const coverStart = clipCoverStartMs(at, preRollSec);
  const segs = selectRingSegments(ringDir, at, preRollSec, postRollSec, Date.now());

  if (!segs.length) throw new Error('no ring segments covered the requested window');

  // These two become path segments (the per-camera clip dir + the clip/thumb/list basenames); validate
  // before they touch the filesystem, same guard as the ring dir at start time.
  const safeId = safePathSegment(cameraId, 'cameraId');
  const safeBase = safePathSegment(outBase, 'outBase');

  // The clip folder is a media-writable LEAF (ffmpeg writes the clip and thumbnail into it); the concat list goes in an
  // app-only folder beside it, read-only to the media user (mediaLayout.js).
  const outDir = ensureClipsFolder([safeId], { leaf: true });
  const listDir = ensureClipsFolder([CONCAT_SUBDIR, safeId]);

  // concat demuxer list. Absolute paths + `-safe 0`; single-quote-escape for safety. The names come from
  // selectRingSegments, i.e. only ever `seg-YYYYMMDD-HHMMSS.mkv`, so none can carry a newline or a quote.
  const listFile = path.join(listDir, `concat-${safeBase}.txt`);
  writeInputFile(
    listFile,
    segs.map((s) => `file '${s.p.replace(/'/g, "'\\''")}'`).join('\n') + '\n'
  );

  // A clip or thumbnail of this name left by an earlier run (a restored database reuses event ids) belongs to the app,
  // and the media user, which writes the new one, could not overwrite it. Flat unlink, as ffmpeg's -y would have replaced it.
  const outFile = path.join(outDir, `${safeBase}.mp4`);
  const thumbFile = path.join(outDir, `${safeBase}.jpg`);
  removeOwnFile(outFile);
  removeOwnFile(thumbFile);

  // Where the requested window starts within the concatenated timeline. The first segment's content
  // began ~SEGMENT_SEC before its close-time (mtime), so that's wall-clock position 0 of the concat;
  // seek forward from there to (at - pre). Clamped to 0 in case the ring didn't reach far enough back.
  const clipStartWallMs = segs[0].m - SEGMENT_SEC * 1000;
  const offsetSec = Math.max(0, (at - preRollSec * 1000 - clipStartWallMs) / 1000);
  const durSec = preRollSec + postRollSec;

  try {
    try {
      // Concatenate the ring segments, then trim to EXACTLY [pre+post] seconds. Because a `-c copy` cut
      // can only land on a keyframe (~2s GOP here), an exact, admin-set duration requires re-encoding
      // this one short clip: the frame-accurate `-ss`/`-t` (output-side) guarantees the clip is exactly
      // as long as the pre-roll + post-roll settings say — otherwise people rightly ask why a "5s + 15s"
      // clip is 27s. Only this ~20s clip is re-encoded (veryfast), once per event; the continuous ring
      // segmenter stays a cheap copy. AUDIO is re-encoded to AAC in the same pass (the ring holds the
      // clean ORIGINAL track — often G711 — which <video> can't play); no aresample=async (it dropped
      // samples and made this camera choppier — see the header note). yuv420p + faststart for browsers.
      // `-progress pipe:1 -nostats` (#773): machine-readable progress on stdout for the stall deadline (see
      // runFfmpeg), and no human-readable stats line on stderr, whose tail is what a failure reports.
      await runFfmpeg([
        '-nostdin', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1',
        '-f', 'concat', '-safe', '0', '-i', listFile,
        '-ss', offsetSec.toFixed(3),
        '-t', String(durSec),
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '128k',
        '-movflags', '+faststart',
        '-y', outFile,
      ], { stallLabel: `${safeId}/${safeBase} (${durSec} s clip)` });
    } finally {
      removeOwnFile(listFile);
    }

    // Thumbnail — one frame from the finished clip. Best-effort (Phase 2 reuses the event snapshot). A failure is
    // swallowed, so it must not leave a half-written JPG behind for the caller to store as thumb_path (#773).
    await runFfmpeg([
      '-nostdin', '-loglevel', 'error', '-i', outFile,
      '-frames:v', '1', '-q:v', '4', '-y', thumbFile,
    ], { deadlineMs: PROBE_DEADLINE_MS }).catch(() => removeOwnFile(thumbFile));

    const probe = await probeClip(outFile);
    return { file: outFile, thumb: statMediaFile(thumbFile) ? thumbFile : null, segments: segs.length, probe };
  } catch (err) {
    // #773: a failed extraction leaves nothing of its own behind. Before this only the concat list was removed, so a
    // failed or killed encode orphaned its partial MP4, and a probe failing after a good encode orphaned a complete
    // MP4 + JPG: no row points at either (the caller marks it failed), and on-demand recordings have no retention
    // sweep, so they stayed on disk for good. ONLY this call's two files, by the names built above from
    // safePathSegment: never the directory, never a sibling (another clip may be being written beside them).
    // ⚠️ A PROBE failure after a good encode deletes the clip too, deliberately, and this includes an ffprobe that
    // exits 0 with output that does not parse. Since runFfmpeg settles on 'close' its output is complete, so such a
    // failure means ffprobe could not describe the file, not that we read it half-way (the P1 the Codex review of
    // #783 found, when it settled on 'exit'). The alternatives are worse: resolving without the probe would store a
    // ready row with no duration or size (the UI then shows a zero-second video, see clip-recorder.test.js's probeClip
    // case, and the clip storage cap cannot count it), and rejecting WITHOUT deleting leaves files no row points at,
    // which for an on-demand recording nothing ever removes.
    removeOwnFile(outFile);
    removeOwnFile(thumbFile);
    throw err;
  }
}
