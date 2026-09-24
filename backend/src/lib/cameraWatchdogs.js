// The camera watchdog (15s) and the audio watchdog (30s): the ONLY things that recover a wedged stream.
//
// These loops lived inline in index.js until #451, where nothing could test them: index.js spawns
// MediaMTX and a transcoder per camera at import, so their only coverage was a source-text tripwire.
// Codex's plan review of #451 (round 1, P1) asked for AC3 to be tested through the real logic, so they
// moved here as factories whose collaborators are injected. index.js builds each one and hands its
// `tick` to safeInterval. The bodies were moved verbatim first (`continue` became `return`), and the
// #451 behaviour was applied on top as a separate step.
//
// WHAT #451 CHANGED, and the owner decision behind it (2026-09-24). A MediaMTX API call that times out
// is UNKNOWN (`status.unknown`, see lib/mediamtx.js): not evidence the stream is down, and not evidence
// it is up. So, deliberately asymmetric:
//   * RESTART decisions (main path 30s, sub path 30s, audio 2 consecutive stalls) need an UNBROKEN run of
//     CONFIRMED observations. An unknown BREAKS the run: its timer or count is cleared, and nothing is
//     restarted and no OFFLINE/ONLINE history event is recorded on it. A working stream must not be
//     restarted because the API in front of it stopped answering.
//   * The OFFLINE PUSH clock starts at the first check that could not CONFIRM the camera was up, and only
//     a confirmed ready stops it. An unknown is such a check, exactly like a confirmed not-ready, so a
//     wedged MediaMTX still reaches the parent if they turned the alert on. docs/camera-controls.md and
//     KNOWN-ISSUES.md state the difference.
// A refused connection, a 404, a 5xx or bad JSON are ANSWERS (nothing is serving the path) and still
// count as not ready exactly as before.
//
// And each check goes through lib/processGuards.js's perTargetRunner: at most one pending check per
// camera (a camera still being checked is skipped, never stacked), a few cameras at once. A skip is a
// missed observation, so it breaks the same runs an unknown does (Codex round 2, P0): see the onSkip
// handlers and `ctx.skipped` below.
import db from '../db.js';
import { getPathStatus, subPathName } from './mediamtx.js';
import { startTranscoder } from './transcoder.js';
import { startSubStream, subConfigured } from './subStream.js';
import { recordCameraEvent, EVENT } from './cameraEvents.js';
import { notifyCameraOffline, notifyCameraRecovered } from './cameraStatusAlert.js';
import { probeAudioFlowing, tracksHaveAudio } from './audioLiveness.js';
import { logger } from './logger.js';
import { perTargetRunner } from './processGuards.js';

export const WATCHDOG_INTERVAL_MS = 15 * 1000;
const STUCK_THRESHOLD_MS = 30 * 1000;
// 30s interval + 2 consecutive stalls => a stall is caught and healed in ~30-60s. That
// matters for a monitor - minutes of dead audio is too long. The probe is cheap on a
// healthy camera (audio delivers dozens of packets/sec, so it hits MIN_AUDIO_PACKETS and
// returns in well under a second); only a genuinely stalled one waits the full 6s timeout.
// Requiring two consecutive stalls still filters blips and probes that land during a normal
// restart (a not-ready path is skipped, and an inconclusive probe resets the counter).
export const AUDIO_CHECK_INTERVAL_MS = 30 * 1000;
const AUDIO_STALL_RESTART_THRESHOLD = 2;

// The two DB reads, as named functions so the bindings test (camera-watchdogs.test.js W12) can check what
// they read. Called at the top of every tick; better-sqlite3 throws SYNCHRONOUSLY on SQLITE_BUSY, which
// makes the tick reject and is reported under the watchdog's own label by safeInterval.
export function listCameras() {
  return db.prepare('SELECT * FROM cameras').all();
}

export function readOfflineAlertConfig() {
  return db.prepare(
    "SELECT camera_offline_alert_enabled AS enabled, camera_offline_alert_minutes AS minutes FROM settings WHERE id = 'app'"
  ).get();
}

// The production bindings. Exported so a test can assert each one IS the real function it names (Codex
// round 2, P1): a missing or swapped binding then fails the suite instead of staging.
export const DEFAULT_CAMERA_WATCHDOG_DEPS = Object.freeze({
  listCameras,
  offlineAlertConfig: readOfflineAlertConfig,
  getPathStatus,
  startTranscoder,
  startSubStream,
  subConfigured,
  subPathName,
  recordCameraEvent,
  notifyCameraOffline,
  notifyCameraRecovered,
  now: Date.now,
});

export const DEFAULT_AUDIO_WATCHDOG_DEPS = Object.freeze({
  listCameras,
  getPathStatus,
  tracksHaveAudio,
  probeAudioFlowing,
  startTranscoder,
  recordCameraEvent,
  now: Date.now,
});

const byId = (cam) => cam.id;
const byName = (cam) => cam.name;

// The frame watchdog. It watches MediaMTX's own "is this path actually receiving frames" status
// directly, and force-restarts a camera's transcoder if it's been stuck not-ready for too long -
// regardless of what the FFmpeg process itself is doing. That independence is what makes it work: a
// stalled FFmpeg is alive, so nothing about the process itself says anything is wrong.
//
// ⚠️ This used to call itself a "second layer of defense" behind "FFmpeg's own read timeout (see
// transcoder.js)". THERE IS NO SUCH TIMEOUT ON THE STREAMING PATH - transcoder.js sets no
// `-rw_timeout`. The `-rw_timeout` flags in the codebase are all in lib/rtspProbe.js, which is the
// add/edit validation path, so grepping for the flag finds hits and confirms the wrong thing. Do not
// treat this watchdog as redundant: on a baby monitor it is the whole recovery mechanism.
//
// ★ TWO LEGS, TWO RUNNERS (#451 fix round, Codex code review BLOCKER, verified by trace). The main path
// and the optional sub path are checked by SEPARATE runners, and each leg decides straight after its own
// reading. They used to share one run per camera, sub leg first, so a slow `startSubStream` (16s is
// enough) held the run past the next tick; that tick skipped the camera and cleared BOTH timers, and the
// main restart that was already due got discarded as stale. It repeated every cycle, so the main
// transcoder, the monitor's only recovery path, was never restarted (camera-watchdogs.test.js W16). Just
// putting the main leg first only moves the starvation onto the sub leg (W17), so they are split.
// A main and a sub restart for one camera can now run at the same time. That is safe: they use different
// transcoder keys (the sub runs as `subCameraId(id)`, see subStream.js) and different MediaMTX paths, so
// neither can orphan the other's FFmpeg the way two restarts of the SAME key can.
export function createCameraWatchdog(overrides = {}) {
  const deps = { ...DEFAULT_CAMERA_WATCHDOG_DEPS, ...overrides };
  // One pending check per camera PER LEG. The clock is the injected one, so a test's fake clock also
  // drives the stale-check report. Each runner checks up to 4 cameras at once, so a MediaMTX-wide outage
  // can start at most 4 main and 4 sub restarts at a time.
  const runMain = perTargetRunner('camera-watchdog', { now: deps.now });
  // Labelled so a sub-leg failure reports as `[guard:camera-watchdog:sub:<name>]`: the same label the
  // sub leg's own try/catch used before, so KNOWN-ISSUES.md and anyone grepping old logs stay right.
  const runSub = perTargetRunner('camera-watchdog:sub', { now: deps.now });

  const notReadySince = new Map(); // camera_id -> timestamp
  // Same idea for the optional low-res SUB stream. Its transcoder can wedge (FFmpeg alive but no longer
  // publishing — seen after a camera drops/reconnects or a codec change), which the reconcile can't catch
  // because the process IS running (isSubRunning stays true), and the main-path check above never looks at
  // the sub path. So a wedged sub-stream ("Low" quality shows no video) would otherwise stay dead until the
  // whole app restarts. This tracks sub-path readiness and force-restarts just the sub leg when it's stuck.
  const subNotReadySince = new Map(); // camera_id -> timestamp
  // Stable online/offline status per camera, so the Camera history panel gets one clean
  // "offline" event when a camera actually stops and one "online" event when it comes
  // back - not a new event every 15s poll while it stays down. Seeded lazily: the first
  // time we see a camera we adopt its current state silently (no event), so a restart of
  // the app doesn't log a phantom "came online" for every already-healthy camera.
  const onlineState = new Map(); // camera_id -> boolean
  // Offline-duration notification (separate from the 30s restart timer below, which resets on every
  // force-restart). offlineSince marks when a camera actually went down; offlineAlerted remembers we've
  // already pushed for the current outage so it's one alert per outage, not one every 15s.
  const offlineSince = new Map(); // camera_id -> timestamp it went offline
  const offlineAlerted = new Set(); // camera_ids already notified for the current outage

  // A leg whose previous check is still pending when a tick comes round has MISSED an observation, so the
  // restart run it was building no longer describes an unbroken 30s: clear it. Each leg clears ONLY its
  // own, so a slow leg cannot cost the other one its run. offlineSince is deliberately KEPT: the push
  // clock stops only on a confirmed ready, and a skip is not one.
  function onMainSkip(cam) {
    notReadySince.delete(cam.id);
  }
  function onSubSkip(cam) {
    subNotReadySince.delete(cam.id);
  }

  async function checkMain(cam, offlineCfg, ctx) {
    // A disabled camera intentionally has no path/transcoder - skip it entirely so the
    // watchdog doesn't read it as "unready", log phantom offline events, or try to restart
    // it. Clear any tracked state so re-enabling starts clean (seeds silently, no event).
    // (The sub leg clears its own timer in checkSub.)
    if (cam.disabled) {
      notReadySince.delete(cam.id);
      onlineState.delete(cam.id);
      offlineSince.delete(cam.id);
      offlineAlerted.delete(cam.id);
      return;
    }
    const status = await deps.getPathStatus(cam.mediamtx_path);
    // Timestamped WHEN READ (#451). The restart comparison used to take the clock after the sub leg, which
    // can be slow (a sub restart stops and relaunches ffmpeg), so 15s of readings could pass as 35s. Since
    // the legs were split nothing is awaited between this reading and the decision below, so this equals
    // the clock at decision time; it is kept so an await added in between later cannot bring that back.
    const observedAt = deps.now();
    const unknown = status.unknown === true;

    // Record sustained up/down transitions (see onlineState above). A brief blip that
    // self-heals between two polls never flips this and so never logs an event here -
    // those fine-grained restarts are recorded by the transcoder itself instead.
    // An UNKNOWN reading neither seeds nor flips it: an API that did not answer is not the camera going
    // offline, and recording it as one would put a phantom outage in Camera history (#451).
    if (!unknown) {
      const wasOnline = onlineState.get(cam.id);
      if (wasOnline === undefined) {
        onlineState.set(cam.id, status.ready); // seed silently, no event
      } else if (status.ready && !wasOnline) {
        onlineState.set(cam.id, true);
        deps.recordCameraEvent(cam.id, cam.name, EVENT.ONLINE, 'stream recovered');
      } else if (!status.ready && wasOnline) {
        onlineState.set(cam.id, false);
        deps.recordCameraEvent(cam.id, cam.name, EVENT.OFFLINE, 'stream stopped delivering frames');
      }
    }

    // Offline-duration notification (see offlineSince/offlineAlerted above). Independent of the 30s
    // restart timer below. Fires one push once the outage passes the admin's threshold, and a "back
    // online" push on recovery. Only notifies when enabled; recovery only fires if we actually alerted.
    // ⚠️ An UNKNOWN reading lands in the not-ready branch ON PURPOSE (owner decision 2026-09-24): the push
    // clock starts at the first check that could not confirm the camera was up, and only a confirmed ready
    // stops it, so a MediaMTX that stops answering still reaches the parent.
    if (status.ready) {
      if (offlineAlerted.has(cam.id)) deps.notifyCameraRecovered(cam, offlineSince.get(cam.id));
      offlineSince.delete(cam.id);
      offlineAlerted.delete(cam.id);
    } else {
      if (!offlineSince.has(cam.id)) offlineSince.set(cam.id, observedAt);
      if (
        offlineCfg?.enabled &&
        !offlineAlerted.has(cam.id) &&
        observedAt - offlineSince.get(cam.id) >= offlineCfg.minutes * 60 * 1000
      ) {
        offlineAlerted.add(cam.id);
        deps.notifyCameraOffline(cam, offlineCfg.minutes);
      }
    }

    // Stale, if a later tick skipped this leg while its reading was pending (onMainSkip already cleared
    // the timer): no decision, and no seed either, or the next check would inherit a run that the missed
    // observation broke (Codex round 2, P0).
    if (ctx.skipped) return;
    if (unknown) {
      // No answer is not evidence (#451): break the run, so a restart needs 30s of CONFIRMED not-ready.
      notReadySince.delete(cam.id);
      return;
    }
    if (status.ready) {
      notReadySince.delete(cam.id);
      return;
    }
    const since = notReadySince.get(cam.id);
    if (!since) {
      notReadySince.set(cam.id, observedAt);
    } else if (observedAt - since > STUCK_THRESHOLD_MS) {
      logger.error(
        `Camera "${cam.name}" has been unready for over ${STUCK_THRESHOLD_MS / 1000}s - force-restarting its transcoder.`
      );
      deps.recordCameraEvent(cam.id, cam.name, EVENT.RESTART, 'force-restarted by watchdog (unready 30s+)');
      await deps.startTranscoder(cam.id, cam.rtsp_url, cam.mediamtx_path, cam.name);
      notReadySince.delete(cam.id);
    }
  }

  // Sub-stream (Low quality) wedge check — independent of the main path, so it runs even when the main
  // stream is healthy. Mirrors the main logic: if the sub path stays not-ready past the threshold,
  // force-restart just the sub leg (startSubStream → stopTranscoder SIGTERM→SIGKILL → relaunch), which
  // clears a wedged FFmpeg that the reconcile can't (it's still alive).
  //
  // Its failures are caught by its own runner, never the main leg's. That isolation predates #451:
  // adversarial review of PR #275 found that a sub path MediaMTX kept rejecting (startSubStream holds the
  // one genuinely bare `upsertPath`) threw every tick before the main-leg code could run, so the MAIN
  // transcoder could never be force-restarted, with MediaMTX itself perfectly up. It was an inner try/catch
  // until the fix round made the sub leg a check of its own.
  async function checkSub(cam, ctx) {
    if (cam.disabled || !deps.subConfigured(cam)) {
      subNotReadySince.delete(cam.id);
      return;
    }
    const sub = await deps.getPathStatus(deps.subPathName(cam.mediamtx_path));
    // Taken right after the read, like observedAt, and nothing is awaited before the decision.
    const observedAt = deps.now();
    // Stale, if a later tick skipped this leg while its reading was pending (onSubSkip already cleared
    // the timer): it may neither restart the sub leg nor re-seed its timer.
    if (ctx.skipped) return;
    if (sub.unknown) {
      // No answer is not evidence (#451): break the run, never restart on it.
      subNotReadySince.delete(cam.id);
      return;
    }
    if (sub.ready) {
      subNotReadySince.delete(cam.id);
      return;
    }
    const subSince = subNotReadySince.get(cam.id);
    if (!subSince) {
      subNotReadySince.set(cam.id, observedAt);
    } else if (observedAt - subSince > STUCK_THRESHOLD_MS) {
      logger.error(`Sub-stream (Low) for "${cam.name}" unready over ${STUCK_THRESHOLD_MS / 1000}s - force-restarting it.`);
      deps.recordCameraEvent(cam.id, cam.name, EVENT.RESTART, 'sub-stream force-restarted by watchdog (unready 30s+)');
      await deps.startSubStream(cam);
      subNotReadySince.delete(cam.id);
    }
  }

  async function tick() {
    const cameras = deps.listCameras();
    // Read the offline-alert config once per tick (not per camera).
    const offlineCfg = deps.offlineAlertConfig();
    // One camera must not take the others down with it, nor hold them up: each runner catches and reports
    // per camera (`camera-watchdog:<name>`, `camera-watchdog:sub:<name>`) and checks up to 4 at once.
    // Both legs start together, so neither waits on the other (see TWO LEGS, TWO RUNNERS above).
    await Promise.all([
      runMain(cameras, byId, byName, (cam, ctx) => checkMain(cam, offlineCfg, ctx), { onSkip: onMainSkip }),
      runSub(cameras, byId, byName, checkSub, { onSkip: onSubSkip }),
    ]);
  }

  return { tick };
}

// Third watchdog: audio liveness. The frame watchdog above can't see a camera whose AUDIO track
// stalls while video keeps flowing - the path still reads "ready" and frames keep arriving, so it
// never trips (the tell is sound working in VLC/a fresh connection but not in the app). This
// periodically probes that audio is actually flowing (see audioLiveness.js) and force-restarts a
// camera whose audio has stalled. Confirmed over two consecutive checks so a momentary blip - or a
// one-off probe failure - never triggers a needless restart (see the interval constant above).
export function createAudioWatchdog(overrides = {}) {
  const deps = { ...DEFAULT_AUDIO_WATCHDOG_DEPS, ...overrides };
  const run = perTargetRunner('audio-watchdog', { now: deps.now });
  const audioStallCounts = new Map(); // camera_id -> consecutive stalled checks

  // A skipped check is a missed observation, so the stalls counted so far are no longer consecutive.
  function onSkip(cam) {
    audioStallCounts.delete(cam.id);
  }

  async function checkAudio(cam, ctx) {
    if (cam.disabled) {
      audioStallCounts.delete(cam.id);
      return;
    }
    const status = await deps.getPathStatus(cam.mediamtx_path);
    // Only meaningful once the stream is up AND actually carries audio - never restart a camera
    // that legitimately has no audio track (its "no audio flowing" is correct, not a stall).
    // An UNKNOWN status (#451) has `ready: false`, so it lands here and resets the count: already the
    // owner's rule that no answer breaks a run, with no change needed. camera-watchdogs.test.js W7.
    if (!status.ready || !deps.tracksHaveAudio(status.tracks)) {
      audioStallCounts.delete(cam.id);
      return;
    }
    const flowing = await deps.probeAudioFlowing(cam.mediamtx_path);
    // Stale, if a later tick skipped this camera while the probe ran (up to 6s): its stall must not
    // count toward "2 consecutive", or a resumed check could restart on a broken run (Codex round 2, P0).
    if (ctx.skipped) return;
    if (flowing !== false) {
      // true (flowing) or null (couldn't tell) - clear the counter, don't act on an unknown.
      audioStallCounts.delete(cam.id);
      return;
    }
    const stalls = (audioStallCounts.get(cam.id) || 0) + 1;
    audioStallCounts.set(cam.id, stalls);
    if (stalls >= AUDIO_STALL_RESTART_THRESHOLD) {
      logger.error(`Camera "${cam.name}" audio has stalled (declared but not flowing) - restarting its transcoder.`);
      deps.recordCameraEvent(cam.id, cam.name, EVENT.RESTART, 'audio stalled - restarted by watchdog');
      await deps.startTranscoder(cam.id, cam.rtsp_url, cam.mediamtx_path, cam.name);
      audioStallCounts.delete(cam.id);
    }
  }

  async function tick() {
    // Same per-camera isolation as the frame watchdog above, labelled `audio-watchdog:<name>`.
    await run(deps.listCameras(), byId, byName, checkAudio, { onSkip });
  }

  return { tick };
}
