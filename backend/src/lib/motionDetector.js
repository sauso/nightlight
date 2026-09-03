import { spawn } from 'child_process';
import db from '../db.js';
import { logger } from './logger.js';
import { subPathName, getPathStatus } from './mediamtx.js';
import { inActiveWindow } from './detectSchedule.js';
import { fireDetectionAlert } from './detectionAlert.js';
import { ALERT } from './detectionEvents.js';
import { recordMotion, recordMotionOut } from './activityTracker.js';
import { recordBedTransition, TRANSITION } from './bedTransitions.js';
import { oobLinkKind, OOB_LINK_MS, OOB_LINK_SLOW_MS, OOB_SLOW_OUT_MIN } from './bedTransitionRules.js';
import { childSamplingActiveNow } from './sleepAnalysis.js';

// Server-side motion detection. Per camera with detection enabled, a cheap FFmpeg leg reads
// the already-published MediaMTX stream (the sub-stream when there is one — far cheaper to
// decode), scaled tiny and grayscale at a low frame rate, and we frame-diff consecutive
// NAMING: user-facing wording is "bed" throughout (see the 0.26.0 changelog). A few identifiers here
// still read `crib*` (cribActive, cribLastActive) and the DB column is still `detect_zone` — those are
// deliberately untouched to keep the rename free of schema and API churn. They mean the same thing.
// frames inside an optional bed zone. Sustained movement past the confirmation delay logs a
// detection_event, at most once per cooldown. This never touches the WebRTC/HLS pipeline —
// it's a separate, low-cost sampler, mirroring transcoder.js's process supervision.

// camera_id -> { proc, stopped }
const detectors = new Map();

// Cameras with a relaunch SCHEDULED but no process yet — the 5s gap between an ffmpeg exit and the
// restart. The exit handler removes the camera from `detectors` before arming that timer, so during
// the gap the entry is unreachable and `entry.stopped`, the only brake on the relaunch, cannot be set.
// stop() was therefore a no-op inside the window, and a camera deleted or disabled mid-restart kept
// respawning ffmpeg every 5s for the life of the container — invisible to isDetecting(), so no
// watchdog or reconcile pass could see or heal it, while it went on writing activity_samples outside
// the sleep window. Keeping the timer handle here is what makes the relaunch cancellable. See #253.
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

// --- "Out of bed" (bed -> outside transition) ---
// A child climbing out reads as motion in the bed FIRST, then motion OUTSIDE the bed while the bed
// goes and STAYS quiet (the child has left it). A parent entering is the reverse (outside first) or
// leaves the child still stirring in the bed. Confirmed transitions are persisted to `bed_transitions`
// and are AUTHORITATIVE for the reported wake time (see USE_TRANSITION_TIMES in sleepAnalysis.js), so a
// missed exit here is a wrong wake time on the child's night, not just a missing marker.
//
// The link windows themselves live in `bedTransitionRules.js` — pure, importable, and therefore
// testable without ffmpeg or a stream. See there for why there are two of them.
//
// A rejected link is logged (rate-limited) up to this far back, so the real gap distribution stays
// measurable from the logs rather than being invisible the way the 05:52 miss was.
const OOB_NEARMISS_MS = 180000;
const OOB_NEARMISS_LOG_MS = 30000;
const OOB_CONFIRM_QUIET_MS = 6000; // ...and the bed must stay quiet this long after, to count as "left"
const OOB_COOLDOWN_MS = 120000; // don't re-log an exit more than once per this

// --- "Into bed" twin (outside -> bed transition) ---
// The mirror of out-of-bed: a child being placed INTO the bed reads as motion OUTSIDE first (parent
// carrying/leaning in), then motion in the BED while the outside goes and STAYS quiet (the parent stepped
// back, leaving the child settling in the bed alone). Same state machine as OOB with the two channels
// swapped. Confirmed transitions are persisted to `bed_transitions` (see lib/bedTransitions.js).
//
// NOT given the slow window its twin has. The asymmetry is the point: the slow link exists for a child
// climbing out unaided, and there is no matching event on the way in — a child cannot put himself to
// bed, so an entry is always someone carrying him, which is continuous motion. Widening this side would
// only admit more of the false arrivals this detector is already prone to (see ROADMAP §1.2).
const IB_LINK_MS = 8000; // outside must have been active within this long before the bed burst
const IB_CONFIRM_QUIET_MS = 6000; // ...and the outside must stay quiet this long after, to count as "placed in"
const IB_COOLDOWN_MS = 120000; // don't re-log an entry more than once per this

// When (re)starting a detector, wait up to this long for the preferred sub-stream to start
// publishing before settling for the heavier main stream, polling readiness this often. We
// never spawn ffmpeg against a not-yet-ready path, so there's no 404 churn at startup/after a blip.
const SUB_GRACE_MS = 45000;
const READY_POLL_MS = 2000;

// Map 1..100 sensitivity to the fraction of zone pixels that must change for a frame to count
// as "active". Higher sensitivity => smaller fraction => easier to trigger.
// Exported for tests only — it and buildZoneMask below are the two pure functions on this path, and
// everything else here is welded to a spawned ffmpeg process.
export function activeFractionThreshold(sensitivity) {
  const s = Math.min(100, Math.max(1, sensitivity || 50));
  // Linear in sensitivity: 10% of the zone at 1, ~5.2% at 50, ~1.2% at 90, 0.2% at 100.
  // (This line previously said "~2.5% at 50", which the formula has never produced.)
  return 0.002 + (0.1 - 0.002) * ((100 - s) / 99);
}

// detect_zone JSON -> a per-pixel mask over the analysis frame. The zone is a LIST of rectangles
// ({x,y,w,h} in 0..1 frame fractions); a pixel counts if it falls in ANY of them (so overlapping or
// diagonal boxes are handled correctly, each pixel counted once). Returns { mask, zonePixels }: mask
// is a Uint8Array(FW*FH) of 0/1, or null when the whole frame is used (no/degenerate zone), in which
// case zonePixels is the full frame. A legacy single-object zone still works (treated as one rect).
export function buildZoneMask(camera) {
  let rects = null;
  if (camera.detect_zone) {
    try {
      const z = JSON.parse(camera.detect_zone);
      rects = Array.isArray(z) ? z : [z];
    } catch {
      rects = null;
    }
  }
  rects = (rects || []).filter((r) => r && [r.x, r.y, r.w, r.h].every((v) => typeof v === 'number'));
  if (rects.length === 0) return { mask: null, zonePixels: FW * FH };

  const clamp = (v) => Math.min(1, Math.max(0, v));
  const mask = new Uint8Array(FW * FH);
  let count = 0;
  for (const z of rects) {
    // Round to the NEAREST pixel edge, not outward (floor/ceil). The zone picker paints on a 32x18
    // grid whose cells are exactly 10x10 pixels here, but its fractions are stored rounded, so an
    // edge arrives as 10.0008 rather than 10 — rounding outward turned that into a whole extra row
    // of pixels per rect. Nearest-edge absorbs the rounding and makes a painted zone pixel-exact.
    // For an older hand-drawn box this shifts an edge by at most half a pixel.
    const x0 = Math.round(clamp(z.x) * FW);
    const y0 = Math.round(clamp(z.y) * FH);
    const x1 = Math.min(FW, Math.round(clamp(z.x + z.w) * FW));
    const y1 = Math.min(FH, Math.round(clamp(z.y + z.h) * FH));
    for (let y = y0; y < y1; y++) {
      let idx = y * FW + x0;
      for (let x = x0; x < x1; x++, idx++) {
        if (!mask[idx]) { mask[idx] = 1; count++; }
      }
    }
  }
  if (count < 4) return { mask: null, zonePixels: FW * FH };
  return { mask, zonePixels: count };
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

// Does this camera run the frame-diff leg to ALERT? Only a 'framediff'-source camera with motion
// detection on. A camera on the 'mqtt' source detects motion itself (mqttClient.js) and one on the
// 'onvif' source subscribes to camera events (onvifMotion.js) — both alert elsewhere, so this leg
// must be explicit ('=== framediff'), not "anything but mqtt", or an ONVIF camera would double-alert.
export function motionAlerting(camera) {
  return !!camera?.detect_motion_enabled && camera.detect_source === 'framediff' && !camera.disabled;
}

// Should the pixel-diff leg run RIGHT NOW? Either to alert (above) OR "activity-only" for sleep tracking:
// a child-assigned camera whose motion alerts come from MQTT (or has motion alerting off) still runs
// the cheap leg to feed a continuous motion timeline (activityTracker) — but fires NO alerts, so it
// doesn't reintroduce the false positives the MQTT source avoids. The activity-only leg runs only when
// the child has sleep tracking ON *and* their sleep window is currently open (childSamplingActiveNow), so
// it samples overnight instead of burning CPU all day; the 5-min reconcile starts it at bedtime and
// stops it after wake. A camera with no child (or one outside its window) that isn't a framediff alerter
// runs no leg. Frame-diff ALERT legs above are NOT window-gated — alerts run 24/7.
export function motionLegWanted(camera) {
  if (!camera || camera.disabled) return false;
  if (motionAlerting(camera)) return true;
  // childSamplingActiveNow, not childWindowActiveNow: sampling opens a few hours BEFORE the configured
  // bedtime so an early night is captured (bedtime is never a rigid time). See its comment.
  return !!camera.child_id && childSamplingActiveNow(camera.child_id);
}

export async function startMotionDetector(camera) {
  await stopMotionDetector(camera.id);
  if (!motionLegWanted(camera)) return;
  // Activity-only when we want the leg but it isn't the alerting one (MQTT-source or motion-off, but
  // child-assigned). In that mode we record the movement signal and skip all alert bookkeeping.
  const activityOnly = !motionAlerting(camera);
  if (activityOnly) {
    logger.info(`[detect] activity-only motion leg for "${camera.name}" (sleep tracking; no alerts)`);
  }

  const { mask, zonePixels } = buildZoneMask(camera);
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

    proc.on('error', (err) => {
      // A spawn that never started. Node emits 'error' INSTEAD OF 'exit' here, so nothing downstream
      // runs — and with no listener on it an EventEmitter 'error' THROWS, taking the whole backend down.
      // On a baby monitor that is an outage. ENOENT (no ffmpeg on PATH — a broken image layer, a bad
      // volume mount) is the obvious trigger; EACCES, and EMFILE/EAGAIN under file-descriptor or fork
      // pressure, arrive the same way. See issue #257.
      //
      // Deliberately NOT scheduling the 5s relaunch the exit path uses: a binary that cannot be executed
      // fails identically every time, so that would be a hot loop writing a log line every five seconds
      // forever. Clearing the map entry instead lets the reconcile pass (every 5 minutes) retry at a
      // sane cadence, and isDetecting() reports the truth in the meantime — without this the leg would be
      // left claimed by a process that never existed, and reconcile would skip it as healthy.
      logger.error(`[detect:${path}] could not start ffmpeg: ${err.code || err.message}`);
      if (detectors.get(camera.id) === entry) detectors.delete(camera.id);
    });

    let prev = null;
    let buf = Buffer.alloc(0);
    let activeSince = 0; // start of the current sustained-motion run (0 = not currently active)
    let lastActive = 0; // last frame that was above the active threshold
    let lastAlert = 0;
    // Out-of-bed prototype state (see OOB_* constants above).
    let cribLastActive = 0; // last frame the bed zone itself moved
    let oobPendingAt = 0; // when a bed->outside exit candidate opened (0 = none pending)
    let oobPeakOut = 0; // peak outside-fraction seen during the pending candidate
    let oobLastLog = 0;
    let oobLastNearMiss = 0; // rate-limit for the rejected-link diagnostic
    // Into-bed twin state (see IB_* constants above) — mirror of OOB with the channels swapped.
    let outLastActive = 0; // last frame the outside-bed area moved
    let ibPendingAt = 0; // when an outside->bed entry candidate opened (0 = none pending)
    let ibPeakCrib = 0; // peak bed-fraction seen during the pending candidate
    let ibLastLog = 0;

    const outPixels = mask ? FRAME_BYTES - zonePixels : 0; // area outside the bed zone (0 = whole frame)

    function handleFrame(frame) {
      if (prev) {
        let changed = 0;
        let changedOut = 0;
        // Count changed pixels inside the bed mask (any of its rectangles), or the whole frame when
        // there's no zone. The mask counts each pixel once, so overlapping/diagonal boxes are fine.
        // With a bed zone, also count changes OUTSIDE it (parent/child-out-of-bed) as a separate channel.
        if (mask) {
          for (let i = 0; i < FRAME_BYTES; i++) {
            const d = frame[i] - prev[i];
            if (d > PIXEL_DELTA || d < -PIXEL_DELTA) { if (mask[i]) changed++; else changedOut++; }
          }
        } else {
          for (let i = 0; i < FRAME_BYTES; i++) {
            const d = frame[i] - prev[i];
            if (d > PIXEL_DELTA || d < -PIXEL_DELTA) changed++;
          }
        }
        const fraction = changed / zonePixels;
        const now = Date.now();
        // Feed the raw per-frame movement into the per-minute activity timeline (independent of the
        // alert threshold/cooldown below), so sleep tracking sees continuous motion, not just alerts.
        recordMotion(camera.id, fraction);
        // Outside-bed movement (only meaningful when a bed zone carves out an "outside") — a separate
        // channel so sleep tracking can flag someone in the room vs stirring in the bed.
        if (outPixels > 0) {
          const outFraction = changedOut / outPixels;
          recordMotionOut(camera.id, outFraction);
          // --- "Out of bed" / "into bed" prototypes: classify motion by the SEQUENCE of the two channels. ---
          // Runs whether the leg is alerting or activity-only (a distinct, low-rate signal, not raw motion)
          // and is currently LOG-ONLY — no events, no push, no clips.
          const cribActive = fraction >= threshold;
          const outActive = outFraction >= threshold;
          if (cribActive) cribLastActive = now;
          if (outActive) outLastActive = now;
          if (!oobPendingAt) {
            // Candidate: outside just moved, the bed moved recently but is quiet NOW → motion left the bed.
            if (outActive && !cribActive && cribLastActive > 0) {
              const since = now - cribLastActive;
              const link = oobLinkKind(since, outFraction);
              if (link) {
                oobPendingAt = now;
                oobPeakOut = outFraction;
                logger.info(
                  `[oob] "${camera.name}" exit candidate (${link}) — bed active ${since}ms ago, outside now ${(outFraction * 100).toFixed(1)}%`
                );
              } else if (since <= OOB_NEARMISS_MS && now - oobLastNearMiss >= OOB_NEARMISS_LOG_MS) {
                oobLastNearMiss = now;
                logger.info(
                  `[oob] "${camera.name}" link rejected — bed active ${since}ms ago, outside ${(outFraction * 100).toFixed(1)}% (need <=${OOB_LINK_MS}ms, or <=${OOB_LINK_SLOW_MS}ms at >=${(OOB_SLOW_OUT_MIN * 100).toFixed(0)}%)`
                );
              }
            }
          } else {
            if (outFraction > oobPeakOut) oobPeakOut = outFraction;
            if (cribActive) {
              // Bed moved again inside the confirm window — child's still in it (or a parent reached in).
              logger.info(`[oob] "${camera.name}" candidate cancelled — bed re-active after ${now - oobPendingAt}ms`);
              oobPendingAt = 0;
              oobPeakOut = 0;
            } else if (now - oobPendingAt >= OOB_CONFIRM_QUIET_MS) {
              // Bed stayed quiet after the motion left it → treat as the child having climbed out.
              if (now - oobLastLog >= OOB_COOLDOWN_MS) {
                oobLastLog = now;
                logger.info(
                  `[oob] "${camera.name}" OUT OF BED — motion left the bed, quiet ${OOB_CONFIRM_QUIET_MS}ms since, outside peak ${(oobPeakOut * 100).toFixed(1)}%`
                );
                recordBedTransition(camera.id, TRANSITION.OUT_OF_BED, oobPeakOut);
              }
              oobPendingAt = 0;
              oobPeakOut = 0;
            }
          }
          // --- "Into bed" twin: outside->bed entry (child placed into the bed). Mirror of OOB. ---
          if (!ibPendingAt) {
            // Candidate: bed just moved, the outside moved recently but is quiet NOW → motion entered the bed.
            if (cribActive && !outActive && outLastActive > 0 && now - outLastActive <= IB_LINK_MS) {
              ibPendingAt = now;
              ibPeakCrib = fraction;
              logger.info(
                `[intobed] "${camera.name}" entry candidate — outside active ${now - outLastActive}ms ago, bed now ${(fraction * 100).toFixed(1)}%`
              );
            }
          } else {
            if (fraction > ibPeakCrib) ibPeakCrib = fraction;
            if (outActive) {
              // Outside moved again inside the confirm window — parent still at the bed / child not settled alone.
              logger.info(`[intobed] "${camera.name}" candidate cancelled — outside re-active after ${now - ibPendingAt}ms`);
              ibPendingAt = 0;
              ibPeakCrib = 0;
            } else if (now - ibPendingAt >= IB_CONFIRM_QUIET_MS) {
              // Outside stayed quiet after motion entered the bed → child placed in and the parent stepped back.
              if (now - ibLastLog >= IB_COOLDOWN_MS) {
                ibLastLog = now;
                logger.info(
                  `[intobed] "${camera.name}" INTO BED — motion entered the bed, outside quiet ${IB_CONFIRM_QUIET_MS}ms since, bed peak ${(ibPeakCrib * 100).toFixed(1)}%`
                );
                recordBedTransition(camera.id, TRANSITION.INTO_BED, ibPeakCrib);
              }
              ibPendingAt = 0;
              ibPeakCrib = 0;
            }
          }
        }
        // Activity-only legs (MQTT-source / motion-off child cameras) stop here — no alert bookkeeping.
        if (!activityOnly) {
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
        pendingRestarts.set(camera.id, setTimeout(() => {
          pendingRestarts.delete(camera.id);
          if (!entry.stopped && !detectors.has(camera.id)) launch().catch(() => {});
        }, RESTART_DELAY_MS));
      }
    });
  }

  launch().catch(() => {});
}

export function stopMotionDetector(cameraId) {
  // FIRST, before the early return: a camera in the 5s restart gap has no entry but does have a
  // relaunch armed, and stop() used to return without cancelling it (#253).
  cancelPendingRestart(cameraId);

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
    // See stopTranscoder for the full reasoning: a process that never spawned throws on kill()
    // (EINVAL, verified on win32 — an uncaught throw, the same crash class as #257) and emits
    // 'error'/'close' but never 'exit', so waiting on 'exit' alone stalls for the whole timeout.
    const kill = (sig) => {
      try {
        entry.proc.kill(sig);
      } catch {
        /* never spawned, or already reaped */
      }
    };
    entry.proc.once('exit', done);
    entry.proc.once('error', done);
    kill('SIGTERM');
    setTimeout(() => {
      if (!resolved) {
        kill('SIGKILL');
        done();
      }
    }, FORCE_KILL_TIMEOUT_MS);
  });
}

export async function stopAllMotionDetectors() {
  // Union of both maps: a camera in its restart gap is in pendingRestarts only, and iterating
  // detectors alone would leave its relaunch armed through shutdown.
  const ids = new Set([...detectors.keys(), ...pendingRestarts.keys()]);
  await Promise.all([...ids].map(stopMotionDetector));
}
