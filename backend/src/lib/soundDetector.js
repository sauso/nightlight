import { spawn } from 'child_process';
import { logger } from './logger.js';
import { getPathStatus } from './mediamtx.js';
import { inActiveWindow } from './detectSchedule.js';
import { fireDetectionAlert } from './detectionAlert.js';
import { ALERT } from './detectionEvents.js';
import { recordSound } from './activityTracker.js';
import { createSoundAnalyser, marginDb } from './soundBaseline.js';

// Server-side SOUND detection, parallel to motionDetector.js. Per camera with sound detection
// enabled, a cheap audio-only FFmpeg leg reads the already-published MediaMTX stream and reports a
// windowed loudness (RMS dBFS) a few times a second. We track a ROLLING ambient baseline so a
// white-noise machine / fan is learned continuously (not a one-time boot calibration).
// An alert fires when loudness stays a sensitivity-controlled margin ABOVE that ambient for
// sound_confirm_s, rate-limited by sound_cooldown_s and gated by the same quiet-hours schedule as
// motion. Never touches the WebRTC/HLS pipeline — a separate, tiny reader off 127.0.0.1:8554.
//
// This file is now only the PLUMBING — ffmpeg lifecycle, restart/back-off, logging. Everything that
// decides what the ambient floor is and when to alert lives in soundBaseline.js, which is pure and
// tested. ⚠️ The old header claimed the baseline "rises to the new floor within its time constant";
// that was FACTUALLY FALSE for any step landing inside the dead band, and the comment stated it
// confidently for months while the opposite shipped. See soundBaseline.js's DEAD_BAND_MAX_MS.

// camera_id -> { proc, stopped }
const detectors = new Map();

// Cameras with a relaunch SCHEDULED but no process yet — the 5s gap between an ffmpeg exit and the
// restart. The exit handler removes the camera from `detectors` before arming that timer, so during
// the gap the entry is unreachable and `entry.stopped`, the only brake on the relaunch, cannot be set.
// stop() was therefore a no-op inside the window, and a camera deleted or disabled mid-restart kept
// respawning ffmpeg every 5s for the life of the container, invisible to isSoundDetecting(). Keeping
// the timer handle here is what makes the relaunch cancellable. See #253.
const pendingRestarts = new Map(); // cameraId -> timeout handle

// Cancel a scheduled relaunch, if any. Safe to call for a camera that has none.
function cancelPendingRestart(cameraId) {
  const t = pendingRestarts.get(cameraId);
  if (t) {
    clearTimeout(t);
    pendingRestarts.delete(cameraId);
  }
}

const RESTART_DELAY_MS = 5000;
const FORCE_KILL_TIMEOUT_MS = 3000;
const PATH_GRACE_MS = 45000;
const READY_POLL_MS = 2000;

// 200 ms loudness windows at 8 kHz mono — smooth enough to be stable, frequent enough (~5/s) to be
// responsive. We read RAW PCM and compute RMS in JS (like motionDetector reads raw frames) rather
// than parsing ffmpeg's astats text: ffmpeg block-buffers its stdout text output, so the level lines
// don't stream in real time, whereas the raw audio byte stream is delivered promptly.
const WIN_RATE = 8000;
const WIN_SAMPLES = 1600;
const WIN_BYTES = WIN_SAMPLES * 2; // s16le = 2 bytes/sample, mono

// If a launch yields no loudness readings at all and exits quickly this many times in a row, the
// camera almost certainly has no audio track — stop trying (and say so) instead of restart-looping.
const NO_AUDIO_MAX_STRIKES = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForPath(camera, entry) {
  const main = camera.mediamtx_path;
  const deadline = Date.now() + PATH_GRACE_MS;
  for (;;) {
    if (entry.stopped) return null;
    const st = await getPathStatus(main).catch(() => null);
    if (st && st.ready) return main;
    if (Date.now() > deadline) return main; // give up waiting; let ffmpeg try (and restart if it fails)
    await sleep(READY_POLL_MS);
  }
}

export function isSoundDetecting(cameraId) {
  return detectors.has(cameraId);
}

export async function startSoundDetector(camera) {
  await stopSoundDetector(camera.id);
  if (!camera.detect_sound_enabled || camera.disabled) return;

  const margin = marginDb(camera.sound_sensitivity);
  const confirmMs = Math.max(0, (camera.sound_confirm_s ?? 4) * 1000);
  const cooldownMs = Math.max(1, camera.sound_cooldown_s ?? 120) * 1000;
  // Number of ~200 ms readings to average over = the confirm window (min ~0.6 s of context).
  const READING_MS = (WIN_SAMPLES / WIN_RATE) * 1000;
  const trailN = Math.max(3, Math.round(confirmMs / READING_MS));
  let noAudioStrikes = 0;

  // ⚠️ DELIBERATELY OUTSIDE `launch()`: the analyser (and with it the learned ambient floor) must
  // OUTLIVE an ffmpeg relaunch. It used to be re-created per launch, so every restart — and the
  // detector restarts 5 s after any exit — threw away hours of learning and re-seeded the floor from
  // a single 200 ms window. A relaunch during a cry therefore seeded ambient AT CRY LEVEL. It is also
  // why two containers could never be assumed comparable for a sound A/B: they had independent,
  // arbitrarily-seeded floors.
  //
  // ⚠️ RESIDUAL, not fixed here: the floor is still lost if `startSoundDetector` itself is called
  // again, which the 5-minute reconcile tick does when `isSoundDetecting` is false. `detectors` is
  // cleared on ffmpeg's exit and repopulated 5 s later, so a tick landing in that gap (~1.7% of
  // exits) re-creates the analyser. Left alone deliberately: closing it means moving the detector
  // registry's lifetime out of this function, and the 5 s seed window now costs 5 s of readings
  // rather than an arbitrary single sample.
  // `readingMs` is how the analyser recognises a hole in the stream: because it now survives an
  // ffmpeg restart, it has to be able to tell "45 s of sustained noise" from "45 s of outage".
  const analyser = createSoundAnalyser({ margin, trailN, cooldownMs, readingMs: READING_MS });

  async function launch() {
    const entry = { proc: null, stopped: false };
    detectors.set(camera.id, entry);
    const path = await waitForPath(camera, entry);
    if (!path || entry.stopped) {
      if (detectors.get(camera.id) === entry) detectors.delete(camera.id);
      return;
    }
    const args = [
      '-nostdin',
      '-loglevel', 'error',
      '-rtsp_transport', 'tcp',
      '-i', `rtsp://127.0.0.1:8554/${path}`,
      '-vn',
      '-ac', '1', // mono
      '-ar', String(WIN_RATE),
      '-f', 's16le', '-', // raw 16-bit PCM to stdout — streamed promptly, RMS computed below
    ];
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    entry.proc = proc;
    const startedAt = Date.now();
    logger.info(`[sound] watching "${camera.name}" — fires at +${Math.round(margin)} dB over ambient, sustained ${Math.round(confirmMs / 1000)}s`);

    let sawReading = false;
    let pcm = Buffer.alloc(0);
    // Periodic level line (throttled) so the ambient baseline + recent peak are visible for tuning
    // without needing an actual alert — e.g. "ambient=-32.1 peak=-18.3 (fires at +15)".
    let windowPeak = -Infinity;
    let windowMaxOver = -Infinity; // max trailing-avg-over-ambient in the window (what actually triggers)
    let lastLevelLog = Date.now();
    const LEVEL_LOG_MS = 15000;

    function handleReading(rms) {
      if (!Number.isFinite(rms)) return; // -inf / nan (true digital silence) — ignore
      sawReading = true;
      const now = Date.now();
      if (rms > windowPeak) windowPeak = rms;
      if (now - lastLevelLog >= LEVEL_LOG_MS) {
        const b = analyser.baseline;
        logger.info(
          `[sound] "${camera.name}" ambient=${b === null ? '?' : b.toFixed(1)}dB ` +
            `peak=${windowPeak === -Infinity ? '?' : windowPeak.toFixed(1)}dB ` +
            `maxAvgOver=${windowMaxOver === -Infinity ? '?' : `+${windowMaxOver.toFixed(1)}`} (fires at +${Math.round(margin)})`
        );
        windowPeak = -Infinity;
        windowMaxOver = -Infinity;
        lastLevelLog = now;
      }

      const r = analyser.push(rms, now);
      if (r.recordDb !== null) recordSound(camera.id, r.recordDb);
      if (r.confirmed && r.over > windowMaxOver) windowMaxOver = r.over;
      // The analyser reports that the ALERT RULES are satisfied; the quiet-hours schedule is this
      // layer's business. `markAlerted` only runs when a notification actually went out, so the
      // cooldown is never consumed by an alert that was suppressed by the schedule.
      if (r.wouldAlert && inActiveWindow(camera)) {
        analyser.markAlerted(now);
        fireDetectionAlert(camera, ALERT.SOUND, `+${Math.round(r.over)} dB over ambient`, { snapshotPath: path }).catch(() => {});
      }
    }

    proc.stdout.on('data', (chunk) => {
      pcm = pcm.length ? Buffer.concat([pcm, chunk]) : chunk;
      while (pcm.length >= WIN_BYTES) {
        const win = pcm.subarray(0, WIN_BYTES);
        pcm = pcm.subarray(WIN_BYTES);
        let sumSq = 0;
        for (let i = 0; i < WIN_BYTES; i += 2) {
          const s = win.readInt16LE(i);
          sumSq += s * s;
        }
        const rms = Math.sqrt(sumSq / WIN_SAMPLES);
        // dBFS: 0 dB = full scale (32768). True silence (rms 0) -> -Infinity, ignored upstream.
        handleReading(rms > 0 ? 20 * Math.log10(rms / 32768) : -Infinity);
      }
    });

    proc.stderr.on('data', (chunk) => {
      chunk.toString().split('\n').filter((l) => l.trim()).forEach((l) => logger.raw(`sound:${path}`, l));
    });

    proc.on('exit', (code) => {
      const wasTracked = detectors.get(camera.id) === entry;
      if (wasTracked) detectors.delete(camera.id);
      if (entry.stopped || !wasTracked) return;
      // A quick exit with no readings ever = almost certainly no audio track on this camera.
      if (!sawReading && Date.now() - startedAt < 10000) {
        noAudioStrikes += 1;
        if (noAudioStrikes >= NO_AUDIO_MAX_STRIKES) {
          logger.error(`[sound:${path}] no audio readings after ${noAudioStrikes} tries — does this camera have a microphone? Sound detection stopped.`);
          return;
        }
      } else {
        noAudioStrikes = 0;
      }
      if (code === 0) logger.raw(`sound:${path}`, 'stream ended, reconnecting');
      else logger.error(`[sound:${path}] exited (code ${code}), restarting in 5s`);
      pendingRestarts.set(camera.id, setTimeout(() => {
        pendingRestarts.delete(camera.id);
        if (!entry.stopped && !detectors.has(camera.id)) launch().catch(() => {});
      }, RESTART_DELAY_MS));
    });
  }

  launch().catch(() => {});
}

export function stopSoundDetector(cameraId) {
  // FIRST, before the early return: a camera in the 5s restart gap has no entry but does have a
  // relaunch armed, and stop() used to return without cancelling it (#253).
  cancelPendingRestart(cameraId);

  const entry = detectors.get(cameraId);
  if (!entry) return Promise.resolve();
  entry.stopped = true;
  detectors.delete(cameraId);
  if (!entry.proc) return Promise.resolve();
  return new Promise((resolve) => {
    let resolved = false;
    const done = () => {
      if (!resolved) {
        resolved = true;
        resolve();
      }
    };
    entry.proc.once('exit', done);
    entry.proc.kill('SIGTERM');
    setTimeout(() => {
      if (!resolved) {
        entry.proc.kill('SIGKILL');
        done();
      }
    }, FORCE_KILL_TIMEOUT_MS);
  });
}

export async function stopAllSoundDetectors() {
  // Union of both maps: a camera in its restart gap is in pendingRestarts only, and iterating
  // detectors alone would leave its relaunch armed through shutdown.
  const ids = new Set([...detectors.keys(), ...pendingRestarts.keys()]);
  await Promise.all([...ids].map(stopSoundDetector));
}
