import { spawn } from 'child_process';
import db from '../db.js';
import { logger } from './logger.js';
import { subPathName, getPathStatus } from './mediamtx.js';
import { inActiveWindow } from './detectSchedule.js';
import { fireDetectionAlert } from './detectionAlert.js';
import { ALERT } from './detectionEvents.js';
import { recordMotion } from './activityTracker.js';

// Server-side motion detection. Per camera with detection enabled, a cheap FFmpeg leg reads
// the already-published MediaMTX stream (the sub-stream when there is one — far cheaper to
// decode), scaled tiny and grayscale at a low frame rate, and we frame-diff consecutive
// frames inside an optional crib zone. Sustained movement past the confirmation delay logs a
// detection_event, at most once per cooldown. This never touches the WebRTC/HLS pipeline —
// it's a separate, low-cost sampler, mirroring transcoder.js's process supervision.

// camera_id -> { proc, stopped }
const detectors = new Map();

const RESTART_DELAY_MS = 5000;
const FORCE_KILL_TIMEOUT_MS = 3000;

// Analysis frame geometry: tiny + grayscale. Aspect is deliberately squashed to a fixed size
// (irrelevant for frame-diff, and fixed dimensions let us slice exact frame-sized chunks off
// ffmpeg's stdout). 320x180 gray8 @ 5fps is a trivial amount of data to diff in JS.
const FW = 320;
const FH = 180;
const FPS = 5;
const FRAME_BYTES = FW * FH; // gray8: 1 byte/pixel

// A pixel counts as "changed" only if its brightness moved more than this (0..255) — filters
// sensor noise and compression shimmer.
const PIXEL_DELTA = 24;

// A brief dip below the active threshold shouldn't reset a sustained motion run (real motion
// flickers frame to frame); only a gap longer than this ends the run.
const ACTIVE_GRACE_MS = 1500;

// When (re)starting a detector, wait up to this long for the preferred sub-stream to start
// publishing before settling for the heavier main stream, polling readiness this often. We
// never spawn ffmpeg against a not-yet-ready path, so there's no 404 churn at startup/after a blip.
const SUB_GRACE_MS = 45000;
const READY_POLL_MS = 2000;

// Map 1..100 sensitivity to the fraction of zone pixels that must change for a frame to count
// as "active". Higher sensitivity => smaller fraction => easier to trigger.
function activeFractionThreshold(sensitivity) {
  const s = Math.min(100, Math.max(1, sensitivity || 50));
  // ~10% of the zone at sensitivity 1, ~2.5% at 50, ~0.2% at 100.
  return 0.002 + (0.1 - 0.002) * ((100 - s) / 99);
}

// detect_zone JSON ({x,y,w,h} in 0..1 frame fractions) -> pixel bounds in the analysis frame.
// Anything missing/degenerate falls back to the whole frame.
function zoneBounds(camera) {
  let z = null;
  if (camera.detect_zone) {
    try {
      z = JSON.parse(camera.detect_zone);
    } catch {
      z = null;
    }
  }
  if (!z || [z.x, z.y, z.w, z.h].some((v) => typeof v !== 'number')) {
    return { x0: 0, y0: 0, x1: FW, y1: FH };
  }
  const clamp = (v) => Math.min(1, Math.max(0, v));
  const x0 = Math.floor(clamp(z.x) * FW);
  const y0 = Math.floor(clamp(z.y) * FH);
  const x1 = Math.min(FW, Math.ceil(clamp(z.x + z.w) * FW));
  const y1 = Math.min(FH, Math.ceil(clamp(z.y + z.h) * FH));
  if (x1 - x0 < 2 || y1 - y0 < 2) return { x0: 0, y0: 0, x1: FW, y1: FH };
  return { x0, y0, x1, y1 };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Resolve to the path to analyse once one is actually publishing, preferring the sub-stream
// (cheap to decode). Polls MediaMTX readiness rather than spawning ffmpeg speculatively, so we
// never hit a 404 (at startup, or after a blip took both streams down): it waits up to
// SUB_GRACE_MS for the sub, then settles for the main path if the sub still isn't up. Because
// this runs on every (re)launch, the detector also returns to the sub after a blip instead of
// staying stuck on the heavier main stream. Resolves null if the detector was stopped meanwhile.
async function pickReadyPath(camera, entry) {
  const sub = camera.sub_rtsp_url && String(camera.sub_rtsp_url).trim() ? subPathName(camera.mediamtx_path) : null;
  const main = camera.mediamtx_path;
  const deadline = Date.now() + SUB_GRACE_MS;
  for (;;) {
    if (entry.stopped) return null;
    if (sub) {
      const st = await getPathStatus(sub).catch(() => null);
      if (st && st.ready) return sub;
    }
    // No sub, or the sub grace has elapsed: take the main path as soon as it's ready.
    if (!sub || Date.now() > deadline) {
      const st = await getPathStatus(main).catch(() => null);
      if (st && st.ready) return main;
    }
    await sleep(READY_POLL_MS);
  }
}

export function isDetecting(cameraId) {
  return detectors.has(cameraId);
}

export async function startMotionDetector(camera) {
  await stopMotionDetector(camera.id);
  // The frame-diff detector only runs when this camera is set to the frame-diff source. A camera on
  // the 'mqtt' source detects motion itself and is handled in mqttClient.js — running the frame-diff
  // leg for it would just waste CPU (the whole point of the MQTT source).
  if (!camera.detect_motion_enabled || camera.disabled || camera.detect_source === 'mqtt') return;

  const { x0, y0, x1, y1 } = zoneBounds(camera);
  const zonePixels = (x1 - x0) * (y1 - y0);
  const threshold = activeFractionThreshold(camera.detect_sensitivity);
  const confirmMs = Math.max(0, (camera.detect_confirm_s ?? 3) * 1000);
  const cooldownMs = Math.max(1, camera.detect_cooldown_s ?? 60) * 1000;

  async function launch() {
    // Claim the slot before the async gap below, so a concurrent start/reconcile can't
    // double-run this camera's detector.
    const entry = { proc: null, stopped: false };
    detectors.set(camera.id, entry);
    const path = await pickReadyPath(camera, entry);
    if (!path || entry.stopped) {
      if (detectors.get(camera.id) === entry) detectors.delete(camera.id);
      return;
    }
    const args = [
      '-nostdin',
      '-loglevel', 'error',
      '-rtsp_transport', 'tcp',
      '-i', `rtsp://127.0.0.1:8554/${path}`,
      '-an',
      '-vf', `fps=${FPS},scale=${FW}:${FH},format=gray`,
      '-f', 'rawvideo',
      '-',
    ];
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    entry.proc = proc;

    let prev = null;
    let buf = Buffer.alloc(0);
    let activeSince = 0; // start of the current sustained-motion run (0 = not currently active)
    let lastActive = 0; // last frame that was above the active threshold
    let lastAlert = 0;

    function handleFrame(frame) {
      if (prev) {
        let changed = 0;
        for (let y = y0; y < y1; y++) {
          let idx = y * FW + x0;
          for (let x = x0; x < x1; x++, idx++) {
            const d = frame[idx] - prev[idx];
            if (d > PIXEL_DELTA || d < -PIXEL_DELTA) changed++;
          }
        }
        const fraction = changed / zonePixels;
        const now = Date.now();
        // Feed the raw per-frame movement into the per-minute activity timeline (independent of the
        // alert threshold/cooldown below), so sleep tracking sees continuous motion, not just alerts.
        recordMotion(camera.id, fraction);
        if (fraction >= threshold) {
          if (!activeSince) activeSince = now;
          lastActive = now;
          if (now - activeSince >= confirmMs && now - lastAlert >= cooldownMs && inActiveWindow(camera)) {
            // inActiveWindow gates the WHOLE alert: outside a camera's schedule, motion produces no
            // in-app event and no push, and lastAlert is left untouched so an alert can fire promptly
            // the moment the window opens.
            lastAlert = now; // cooldown gates re-fire; a continuing run alerts once per cooldown
            const pct = (fraction * 100).toFixed(1);
            // Shared downstream (record event + push both channels); pass the exact path we're
            // analysing so a stream-grab snapshot uses the same (cheap) sub-stream. Fire-and-forget.
            fireDetectionAlert(camera, ALERT.MOTION, `${pct}% of zone`, { snapshotPath: path }).catch(() => {});
          }
        } else if (activeSince && now - lastActive > ACTIVE_GRACE_MS) {
          activeSince = 0; // the run ended (gap exceeded the grace window)
        }
      }
      prev = frame;
    }

    proc.stdout.on('data', (chunk) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      while (buf.length >= FRAME_BYTES) {
        handleFrame(Buffer.from(buf.subarray(0, FRAME_BYTES)));
        buf = buf.subarray(FRAME_BYTES);
      }
    });

    proc.stderr.on('data', (chunk) => {
      chunk
        .toString()
        .split('\n')
        .filter((l) => l.trim())
        .forEach((l) => logger.raw(`detect:${path}`, l));
    });

    proc.on('exit', (code) => {
      const wasTracked = detectors.get(camera.id) === entry;
      if (wasTracked) detectors.delete(camera.id);
      if (!entry.stopped && wasTracked) {
        // code 0 = the upstream stream ended (a camera/transcoder blip), not an error — just
        // reconnect quietly, re-picking sub vs main. Only a real failure is logged loudly.
        if (code === 0) logger.raw(`detect:${path}`, 'stream ended, reconnecting');
        else logger.error(`[detect:${path}] exited (code ${code}), restarting in 5s`);
        setTimeout(() => {
          if (!entry.stopped && !detectors.has(camera.id)) launch().catch(() => {});
        }, RESTART_DELAY_MS);
      }
    });
  }

  launch().catch(() => {});
}

export function stopMotionDetector(cameraId) {
  const entry = detectors.get(cameraId);
  if (!entry) return Promise.resolve();
  entry.stopped = true;
  detectors.delete(cameraId);
  // Caught during launch()'s async path-selection gap (no process spawned yet) — the launch
  // will see `stopped` and abort itself, so there's nothing to kill.
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

export async function stopAllMotionDetectors() {
  await Promise.all([...detectors.keys()].map(stopMotionDetector));
}
