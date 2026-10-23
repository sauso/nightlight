import { logger } from './logger.js';
import { safeInterval } from './processGuards.js';
import { probeMediamtxApi, mediamtxApiIsLocal } from './mediamtx.js';

// ★ #479: RESTART A MEDIAMTX THAT IS ALIVE BUT NO LONGER ANSWERING ITS API.
//
// mediamtxProcess.js relaunches MediaMTX when its process EXITS. Since #451 every API call has a 5 s deadline and a
// timeout means UNKNOWN, never evidence (owner decision, 2026-09-24): the camera watchdogs do not restart on it, no
// history is written, no path is rewritten, because restarting a camera cannot fix a server that is not answering. The
// consequence was that a deadlocked MediaMTX stayed deadlocked until someone restarted the container, with only a
// `[guard:mediamtx-api]` line a minute and, if enabled, the camera-offline push. This is the missing lever: it acts on
// SUSTAINED silence of the API as a whole, and only on MediaMTX itself.
//
// HOW IT DECIDES. Every CHECK_INTERVAL_MS it asks one cheap question (probeMediamtxApi) on its own timer, so the evidence
// does not depend on camera traffic. A 'timeout' starts a stamp (on the monotonic clock: a wall-clock step must neither
// fire nor delay it); any other outcome clears it. When the stamp is older than the current window, MediaMTX is
// restarted. It deliberately shares no state with the other callers of the API (see probeMediamtxApi): a slow path
// write, or a partial wedge that still answers elsewhere, must not mask or fake the silence it is measuring.
//
// THE WINDOW AND ITS BACKOFF. HUNG_MS is 3 minutes: six probes in a row, each a full 5 s deadline, with no answer in
// between. It is an UNMEASURED GUESS, like the 2-minute and 5 s numbers around it: no wedge has been seen in production,
// so there is no night to calibrate on. A restart drops every camera's streams (they come back through the transcoders'
// own 5 s relaunch and a path reconcile, about a minute), so it must not repeat quickly if the restart did not help:
// each restart that is not followed by sustained health doubles the window (3, 6, 12, 24 minutes, then every 30), and
// only RECOVERED_MS (5 minutes) of continuous HTTP answers sets it back to 3. Not "the first answer": a freshly started
// MediaMTX answers at once, and a server that wedges again a few minutes after every start would otherwise be restarted
// every ~3 minutes for ever (the detector watchdog's ladder, cameraWatchdogs.js, resets on sustained health too).
//
// WHAT IT DOES NOT DO. It does nothing when MEDIAMTX_API is not on this machine (the child it would kill is not the
// server that is silent), and a MediaMTX that is merely SLOW (answers inside the deadline) is never restarted. A
// MediaMTX that closes every connection is an answer ('refused'), not a hang, and is never restarted by this.
export const CHECK_INTERVAL_MS = 30 * 1000;
export const HUNG_MS = 3 * 60 * 1000;
export const MAX_WINDOW_MS = 30 * 60 * 1000;
export const RECOVERED_MS = 5 * 60 * 1000;

let unknownSince = null; // monotonic ms of the first unanswered probe in this streak, or null
let healthySince = null; // monotonic ms of the first HTTP answer in this run of answers, or null
let consecutiveRestarts = 0;
let running = false;
let timer = null;
// Set by stop, cleared by start. A check that was already waiting for its probe when shutdown() stopped the watchdog must
// not go on to SIGTERM MediaMTX in the middle of the awaited stops (code review of #479): clearInterval ends FUTURE ticks only.
let stopRequested = false;

// Test seam ONLY, like resetRetryStateForTest in timelapse.js.
export function resetMediamtxApiWatchdogForTest() {
  unknownSince = null;
  healthySince = null;
  consecutiveRestarts = 0;
  running = false;
  stopRequested = false;
}

export function currentWindowMs() {
  return Math.min(MAX_WINDOW_MS, HUNG_MS * 2 ** consecutiveRestarts);
}

const minutes = (ms) => Math.max(1, Math.round(ms / 60000));

/**
 * One check. Exported with its dependencies injectable so the decision is testable without a timer, a child or
 * index.js. `restart()` returns whether it signalled a process; `onRestart({ silentMs })` is the caller's reaction
 * (Camera history, a path reconcile) and may throw. `now` is a MONOTONIC clock: never pass Date.now.
 * Resolves what happened: 'busy' | 'stopped' | 'unknown' | 'restarted' | 'not-signalled' | 'ok'.
 */
export async function checkMediamtxApi({ probe = probeMediamtxApi, restart, onRestart = () => {}, now = () => performance.now() } = {}) {
  if (running) return 'busy'; // a probe can take its whole 5 s deadline; ticks never overlap
  running = true;
  try {
    const result = await probe();
    if (stopRequested) return 'stopped'; // shutdown began while the probe was waiting: take no action
    const t = now();
    if (result === 'timeout') {
      healthySince = null;
      if (unknownSince == null) {
        unknownSince = t;
        return 'unknown';
      }
      const silentMs = t - unknownSince;
      if (silentMs < currentWindowMs()) return 'unknown';
      // COMMIT FIRST, then act (#369): a restart whose bookkeeping can be skipped by a throw further down would be
      // repeated on the very next tick with no backoff.
      unknownSince = null;
      if (!restart()) return 'not-signalled'; // the child is already gone (relaunch gap), or we are stopping: nothing to claim
      consecutiveRestarts += 1;
      logger.error(
        `[mediamtx] API unanswered for ${minutes(silentMs)} min: restarting the MediaMTX process ` +
          `(restart ${consecutiveRestarts} without sustained recovery; if it stays silent the next one waits ${minutes(currentWindowMs())} min). ` +
          'Cameras reconnect on their own.'
      );
      try {
        onRestart({ silentMs });
      } catch (e) {
        logger.error(`[mediamtx] after the API-hung restart: ${e.message}`);
      }
      return 'restarted';
    }
    // Any other outcome means the process is not wedged: it answered, or nothing is listening (a crash or a restart,
    // which mediamtxProcess.js already handles through the exit).
    unknownSince = null;
    if (result === 'answered') {
      healthySince ??= t;
      if (consecutiveRestarts > 0 && t - healthySince >= RECOVERED_MS) consecutiveRestarts = 0;
    } else {
      healthySince = null; // refused: down or restarting, not healthy yet
    }
    return 'ok';
  } finally {
    running = false;
  }
}

/** Start the periodic check. Idempotent. Returns the timer, or null when MEDIAMTX_API is not on this machine. */
export function startMediamtxApiWatchdog({ restart, onRestart, probe, now, api } = {}) {
  if (timer) return timer;
  if (!mediamtxApiIsLocal(api)) {
    logger.info('[mediamtx] MEDIAMTX_API is not on this machine: not watching it for a hung API (the local MediaMTX is not the server being asked).');
    return null;
  }
  stopRequested = false;
  // `probe` and `now` are passed through only when given, so the defaults of checkMediamtxApi apply in production.
  timer = safeInterval('mediamtx-api-watchdog', CHECK_INTERVAL_MS, () =>
    checkMediamtxApi({ restart, onRestart, ...(probe ? { probe } : {}), ...(now ? { now } : {}) }));
  timer.unref?.();
  return timer;
}

/** Stop the periodic check. Idempotent, and safe when it was never started (shutdown, tests). */
export function stopMediamtxApiWatchdog() {
  stopRequested = true;
  clearInterval(timer);
  // Nulled, not merely cleared: start guards on `if (timer) return`, so a stale handle would make a restart a no-op.
  timer = null;
}
