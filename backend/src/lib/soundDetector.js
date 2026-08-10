import { spawn } from 'child_process';
import { logger } from './logger.js';
import { getPathStatus } from './mediamtx.js';
import { inActiveWindow } from './detectSchedule.js';
import { fireDetectionAlert } from './detectionAlert.js';
import { ALERT } from './detectionEvents.js';

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
// responsive. Audio is downsampled first so the window size is rate-independent.
const WIN_SAMPLES = 1600;
const WIN_RATE = 8000;

// Ambient baseline EMA. At ~5 readings/s, alpha 0.01 gives a ~20 s time constant — slow enough that
// a cry doesn't get absorbed before it alerts, fast enough to track a fan/AC/white-noise change.
const BASELINE_ALPHA = 0.01;
// A brief dip below the loud threshold shouldn't end a sustained run — real crying pulses.
const SOUND_GRACE_MS = 2500;
// A level that stays elevated far longer than any cry burst is treated as a NEW ambient floor (the
// white-noise machine was switched on, a fan, a running tap, the TV) and folded into the baseline so
// it stops alerting. A cry alerts well before this.
const REBASELINE_MS = 45000;

// If a launch yields no loudness readings at all and exits quickly this many times in a row, the
// camera almost certainly has no audio track — stop trying (and say so) instead of restart-looping.
const NO_AUDIO_MAX_STRIKES = 3;

// Map 1..100 sensitivity to the dB margin a sound must exceed the ambient baseline by. Higher
// sensitivity => smaller margin => easier to trigger. ~24 dB (needs a loud, clear sound) at 1,
// ~6 dB (quite sensitive) at 100; ~15 dB at the 50 default (a cry is typically well above that).
function marginDb(sensitivity) {
  const s = Math.min(100, Math.max(1, sensitivity || 50));
  return 6 + (24 - 6) * ((100 - s) / 99);
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
      // downsample -> fixed-size windows -> per-window RMS -> print just the RMS_level metadata.
      '-af', `aresample=${WIN_RATE},asetnsamples=${WIN_SAMPLES}:p=0,astats=metadata=1:reset=1,ametadata=mode=print:key=lavfi.astats.Overall.RMS_level:file=-`,
      '-f', 'null', '-',
    ];
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    entry.proc = proc;
    const startedAt = Date.now();

    let baseline = null; // rolling ambient level (dBFS)
    let loudSince = 0; // start of the current sustained-loud run (0 = not currently loud)
    let lastLoud = 0;
    let lastAlert = 0;
    let sawReading = false;
    let stdoutBuf = '';

    function handleReading(rms) {
      if (!Number.isFinite(rms)) return; // -inf / nan (true digital silence) — ignore
      sawReading = true;
      const now = Date.now();
      if (baseline === null) {
        baseline = rms;
        return;
      }
      const delta = rms - baseline;
      if (delta >= margin) {
        if (!loudSince) loudSince = now;
        lastLoud = now;
        // Steady elevated source: adopt it as the new ambient so it doesn't alert forever.
        if (now - loudSince >= REBASELINE_MS) {
          baseline = rms;
          loudSince = 0;
          return;
        }
        if (now - loudSince >= confirmMs && now - lastAlert >= cooldownMs && inActiveWindow(camera)) {
          lastAlert = now;
          fireDetectionAlert(camera, ALERT.SOUND, `+${Math.round(delta)} dB over ambient`, { snapshotPath: path }).catch(() => {});
        }
      } else {
        // Quiet: track the ambient floor. (We deliberately DON'T adapt while loud, so a cry can't
        // raise its own baseline before the confirm delay — the re-baseline valve handles the
        // legitimately-steady case above.)
        baseline += BASELINE_ALPHA * (rms - baseline);
        if (loudSince && now - lastLoud > SOUND_GRACE_MS) loudSince = 0;
      }
    }

    proc.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString();
      let nl;
      while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
        const line = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        const m = /RMS_level=(-?\d+(?:\.\d+)?|-?inf|nan)/i.exec(line);
        if (m) handleReading(m[1].toLowerCase() === '-inf' || m[1].toLowerCase() === 'nan' ? -Infinity : parseFloat(m[1]));
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
