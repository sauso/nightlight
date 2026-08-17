import { spawn } from 'child_process';
import { logger } from './logger.js';
import { getPathStatus } from './mediamtx.js';
import { inActiveWindow } from './detectSchedule.js';
import { fireDetectionAlert } from './detectionAlert.js';
import { ALERT } from './detectionEvents.js';
import { recordSound } from './activityTracker.js';

// Server-side SOUND detection, parallel to motionDetector.js. Per camera with sound detection
// enabled, a cheap audio-only FFmpeg leg reads the already-published MediaMTX stream and reports a
// windowed loudness (RMS dBFS) a few times a second. We track a ROLLING ambient baseline so a
// white-noise machine / fan is learned continuously (not a one-time boot calibration): turn the
// machine on an hour after boot and the baseline rises to the new floor within its time constant.
// An alert fires when loudness stays a sensitivity-controlled margin ABOVE that ambient for
// sound_confirm_s, rate-limited by sound_cooldown_s and gated by the same quiet-hours schedule as
// motion. Never touches the WebRTC/HLS pipeline — a separate, tiny reader off 127.0.0.1:8554.

// camera_id -> { proc, stopped }
const detectors = new Map();

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

// Ambient baseline EMA. At ~5 readings/s, alpha 0.01 gives a ~20 s time constant — slow enough that
// a cry doesn't get absorbed before it alerts, fast enough to track a fan/AC/white-noise change.
const BASELINE_ALPHA = 0.01;
// A level that stays elevated far longer than any cry burst is treated as a NEW ambient floor (the
// white-noise machine was switched on, a fan, a running tap, the TV) and folded into the baseline so
// it stops alerting. A cry alerts well before this.
const REBASELINE_MS = 45000;

// If a launch yields no loudness readings at all and exits quickly this many times in a row, the
// camera almost certainly has no audio track — stop trying (and say so) instead of restart-looping.
const NO_AUDIO_MAX_STRIKES = 3;

// Map 1..100 sensitivity to how many dB the trailing-average loudness must exceed the ambient
// baseline by. Higher sensitivity => smaller margin => easier to trigger. ~18 dB (needs a clearly
// loud sound) at 1, ~4 dB (quite sensitive) at 100, ~11 dB at the 50 default. This is compared
// against the AVERAGE over the confirm window, so a pulsing cry (loud on average) clears it even
// though its quiet moments dip below.
function marginDb(sensitivity) {
  const s = Math.min(100, Math.max(1, sensitivity || 50));
  return 4 + (18 - 4) * ((100 - s) / 99);
}

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

    let baseline = null; // rolling ambient level (dBFS)
    let loudSince = 0; // start of the current elevated run (0 = not currently elevated)
    let lastAlert = 0;
    const recent = []; // last trailN readings, for the trailing average
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
        logger.info(
          `[sound] "${camera.name}" ambient=${baseline === null ? '?' : baseline.toFixed(1)}dB ` +
            `peak=${windowPeak === -Infinity ? '?' : windowPeak.toFixed(1)}dB ` +
            `maxAvgOver=${windowMaxOver === -Infinity ? '?' : `+${windowMaxOver.toFixed(1)}`} (fires at +${Math.round(margin)})`
        );
        windowPeak = -Infinity;
        windowMaxOver = -Infinity;
        lastLevelLog = now;
      }
      if (baseline === null) {
        baseline = rms;
        return;
      }

      // Feed loudness-above-ambient into the per-minute activity timeline (independent of the alert
      // margin/cooldown), so sleep tracking sees continuous noise level, not just cry alerts.
      recordSound(camera.id, Math.max(0, rms - baseline));

      // Trailing average over the confirm window. A cry is loud ON AVERAGE across those seconds even
      // as it pulses, so averaging is far more robust than requiring every instant to clear the bar.
      recent.push(rms);
      if (recent.length > trailN) recent.shift();
      const over = recent.reduce((a, b) => a + b, 0) / recent.length - baseline;
      if (recent.length >= trailN && over > windowMaxOver) windowMaxOver = over;

      if (recent.length >= trailN && over >= margin) {
        if (!loudSince) loudSince = now;
        // A steady elevated source held far longer than a cry burst becomes the new ambient (the
        // white-noise machine was switched on, a fan, the TV) so it stops alerting.
        if (now - loudSince >= REBASELINE_MS) {
          baseline += over; // absorb the elevation into the ambient
          loudSince = 0;
          recent.length = 0;
          return;
        }
        if (now - lastAlert >= cooldownMs && inActiveWindow(camera)) {
          lastAlert = now;
          fireDetectionAlert(camera, ALERT.SOUND, `+${Math.round(over)} dB over ambient`, { snapshotPath: path }).catch(() => {});
        }
      } else {
        loudSince = 0;
        // Track the ambient floor, but freeze while the average is already creeping up toward a
        // trigger, so a cry's ramp-up can't quietly raise its own baseline and desensitise itself.
        if (over < margin * 0.5) baseline += BASELINE_ALPHA * (rms - baseline);
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
      setTimeout(() => {
        if (!entry.stopped && !detectors.has(camera.id)) launch().catch(() => {});
      }, RESTART_DELAY_MS);
    });
  }

  launch().catch(() => {});
}

export function stopSoundDetector(cameraId) {
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
  await Promise.all([...detectors.keys()].map(stopSoundDetector));
}
