// The camera watchdog (15s) and the audio watchdog (30s): the ONLY things that recover a wedged stream.
// And since #369 a third, the DETECTOR watchdog (15s, at the bottom of this file): the only thing that
// recovers a motion or sound DETECTOR that is alive and connected but has stopped receiving anything.
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
import { probeAudioFlowing, probeVideoFlowing, tracksHaveAudio } from './audioLiveness.js';
import { logger } from './logger.js';
import { perTargetRunner, MIN_KILL_AGE_MS } from './processGuards.js';
import { getMotionDetectorHealth, restartMotionDetector, motionLegWanted } from './motionDetector.js';
import { getSoundDetectorHealth, restartSoundDetector } from './soundDetector.js';

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

// #369: what the camera watchdog needs to judge a restart REQUEST from the detector watchdog (see
// createRestartRequests below). A separate object, not two more keys in DEFAULT_CAMERA_WATCHDOG_DEPS: the
// bindings test W12 pins that object's keys exactly, and it stays untouched. The mailbox itself has no
// default here: index.js builds ONE and hands it to both watchdogs, and a camera watchdog built without one
// (every #451 test) simply has no requests to consume.
export const DEFAULT_RESTART_REQUEST_CONSUMER_DEPS = Object.freeze({
  getMotionDetectorHealth,
  motionLegWanted,
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
  const deps = { ...DEFAULT_CAMERA_WATCHDOG_DEPS, ...DEFAULT_RESTART_REQUEST_CONSUMER_DEPS, restartRequests: null, ...overrides };
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

  // #369: a restart REQUEST from the detector watchdog (plan v5 §D). That watchdog never starts a publisher
  // itself: startTranscoder is not safe under two concurrent calls for one camera, and this watchdog's
  // per-leg runner is what already serialises this leg's restarts. So it posts a request, and the check of
  // the leg that owns the publisher consumes it. Each check TAKES its request at its very start, which
  // deletes it from the mailbox whatever happens next: a request is acted on at most once, and never after
  // an awaited restart, however slow or throwing (a startSubStream can take 16s).
  const takeRequest = (cam, kind) => (deps.restartRequests ? deps.restartRequests.take(cam.id, kind) : null);

  // A taken request runs only if EVERY condition below still holds; otherwise it is DROPPED without acting.
  // The caller has already established the rest: the camera is not disabled in THIS tick's fresh
  // listCameras() snapshot, this check was not skipped, and its path status is a confirmed READY (not
  // unknown, #451). A request on a path that is not ready is dropped too: this leg's own 30s rule already
  // owns that case. The TTL was applied by the mailbox, on its own clock. Returns why it is dropped, or null.
  function requestDropReason(cam, path) {
    // Detection switched off, or an activity-only leg's sampling window closed, since the request was posted.
    if (!deps.motionLegWanted(cam)) return 'the motion leg is no longer wanted';
    const health = deps.getMotionDetectorHealth(cam.id);
    // Still DARK = not healthy by the detector watchdog's own definition. This deliberately INCLUDES a young
    // replacement that has not produced its first frame yet (Astra R2: dropping that case dropped every
    // escalation, because the request always arrives just after a relaunch).
    if (detectorLegHealthy(health)) return 'the motion detector is receiving frames again';
    // (Builder's refinement, see the #369 build notes.) A replacement now reading the OTHER path does not
    // need THIS publisher restarted: a detector that relaunched onto the sub path after a main-path stall
    // would otherwise cost the live view a pointless main restart. If the new path stalls too, the detector
    // watchdog asks for that path's publisher on its own.
    if (health?.path != null && health.path !== path) return `the motion detector now reads ${health.path}`;
    return null;
  }

  async function honourRestartRequest(cam, kind, request, path, restart) {
    const what = kind === 'sub' ? 'sub-stream (Low)' : 'transcoder';
    const drop = requestDropReason(cam, path);
    if (drop) {
      logger.info(`[detector-watchdog] "${cam.name}": dropped its request to restart the ${what}: ${drop}`);
      return;
    }
    logger.warn(`Camera "${cam.name}": restarting its ${what} at the detector watchdog's request (${request.reason}).`);
    // Names the DETECTOR as the trigger: EVENT.RESTART alone reads as "the transcoder crashed or wedged".
    deps.recordCameraEvent(cam.id, cam.name, EVENT.RESTART, `${what} restarted at the detector watchdog's request (motion detector getting no frames)`);
    await restart();
  }

  async function checkMain(cam, offlineCfg, ctx) {
    // #369: FIRST, before any early return, so a request never outlives the check that saw it.
    const request = takeRequest(cam, 'main');
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
      // #369: the ONLY place a detector-watchdog request for the main publisher can run: a fresh, confirmed,
      // unskipped READY. Every earlier return above has already dropped it.
      if (request) {
        await honourRestartRequest(cam, 'main', request, cam.mediamtx_path,
          () => deps.startTranscoder(cam.id, cam.rtsp_url, cam.mediamtx_path, cam.name));
      }
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
    // #369: FIRST, before any early return (see checkMain).
    const request = takeRequest(cam, 'sub');
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
      // #369: only on a fresh, confirmed, unskipped READY (see checkMain).
      if (request) await honourRestartRequest(cam, 'sub', request, deps.subPathName(cam.mediamtx_path), () => deps.startSubStream(cam));
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

// =============================================================================================================
// #369: THE DETECTOR WATCHDOG
//
// WHY IT EXISTS. On STAGING one camera's MOTION detector received ZERO frames for 285 minutes (2026-09-27
// 05:16 -> 10:00) and 523 minutes (2026-09-17 01:18 -> 10:00). Both runs were ended by the daily 10:00
// camera reboot, not by anything here. The same camera's SOUND detector kept working, camera_events recorded
// nothing, and PROD's instance reading the same physical camera had no such run in 30 days, so the fault is
// inside our pipeline, not the camera. Which layer (restream or detector) and which path (sub, or main
// after the fallback that #500 has since made temporary) is UNKNOWN: the container logs of that night were destroyed by a redeploy.
// Nothing above could see it. The camera watchdog reads the PATH (ready, and it was), the audio watchdog
// reads AUDIO on the main path (flowing, and it was), and reconcile skips any detector that has an entry
// (an alive ffmpeg keeps its entry). A night with no motion data cost a real wake.
//
// WHAT IT READS: whether a stdout byte arrived, per detector process (getMotionDetectorHealth /
// getSoundDetectorHealth, as AGES computed in the detector module, so this file needs no clock of its own to
// judge a leg). Bytes, not activity: a still room still delivers frames and a silent room still delivers PCM,
// so a quiet night never looks stale.
//
// WHAT IT DOES, by attempt (plan v5, E6), each gated by a backoff that doubles from 1 to 30 minutes:
//   attempt 1   L1: restart the DETECTOR (its own exit handler relaunches it after 5s: one lineage).
//   attempt 2+  L2 (motion only): also ask for the PUBLISHER of the path it reads to be restarted, through a
//               request the camera watchdog consumes. THIS WATCHDOG NEVER STARTS OR STOPS A PUBLISHER
//               ITSELF: startTranscoder is not safe under two concurrent calls for one camera (processGuards.js),
//               and the camera watchdog's per-leg runner is what already serialises that leg's restarts.
// Every action records one camera_events RESTART naming the detector, and ONE diagnosis line (path status,
// a video/audio probe, the ffmpeg input tap's age) - that line is how the unknown root cause gets learned.
//
// ⚠️ NO PROBE RESULT EVER VETOES AN ACTION (Astra R1/R2, Sol R2). A probe cannot prove a negative (live RTSP
// never ends, a stalled setup looks like silence), and a video PACKET is not a decodable FRAME (the publisher
// copies H.264 packets, so a path can carry them while the detector decodes nothing). The ladder is by
// attempt count; the probe is written into the diagnosis line and nowhere else. The ONE exception is the sound
// leg (below), and even there a broken probe cannot block it for more than two ticks.
//
// ⚠️ CLOCKS. Everything here is on performance.now() (monotonic). The camera watchdog above stays on
// Date.now: it stores `offlineSince` and hands it to notifyCameraRecovered, which subtracts it from
// Date.now(), and a monotonic stamp there produced "29,841,119 minutes offline" during planning.
// ⚠️ `() => performance.now()`, never bare `performance.now`: perTargetRunner calls `now()` unbound, before its
// try, and an unbound performance.now THROWS in Node 24, so every tick would reject.
// =============================================================================================================

// How often each detector leg is judged. Reading a leg's health is an in-memory lookup, so a tick costs nothing
// unless a leg is stale. It adds up to one interval to the detection latency (STALE + up to one tick); the same
// cadence as the camera watchdog, whose request consumption it pairs with.
export const DETECTOR_CHECK_INTERVAL_MS = 15 * 1000;
// A leg with no stdout byte for longer than this is stale. A healthy leg of either kind produces ~5 stdout events
// a second (5 fps frames; 1600-sample windows at 8 kHz), so 60s of nothing is hundreds of missed events, never
// jitter. CHOSEN, NOT MEASURED against anything but those two rates: the staging runs it exists for lasted hours,
// so it only has to be long enough to never trip on a working leg. A camera delivering fewer than ~1 frame a
// minute (nothing supported does) would be restarted at the backoff cadence: a documented limit.
export const DETECTOR_STALE_MS = 60 * 1000;
// A fresh process gets this long to deliver its FIRST byte: RTSP setup, ffmpeg's stream probe, and the first
// decodable keyframe (a long-GOP camera can take many seconds). Longer than STALE so a new process is never
// judged faster than a running one, and pinned longer than MIN_KILL_AGE_MS (detector-watchdog.test.js).
export const DETECTOR_STARTUP_GRACE_MS = 90 * 1000;
// A crash loop no single process shows: each replacement dies (or is stuck) inside its own grace, so none is
// ever entry-stalled. After this long with NO healthy tick since the last action AND at least two replacement
// generations without data, the episode escalates to a publisher request on its own (never to a kill).
export const DETECTOR_EPISODE_STALL_MS = 3 * 60 * 1000;
// The backoff between actions on one leg: 1, 2, 4, 8, 16, 30, 30... minutes. The first retry waits one STALE
// window after the action, time for the relaunch to prove itself; the cap bounds a leg that never recovers to
// 48 restarts and 48 camera_events rows a day (that table is capped at 2000 rows SHARED by every camera).
export const DETECTOR_RESTART_FLOOR_MS = 60 * 1000;
export const DETECTOR_RESTART_CAP_MS = 30 * 60 * 1000;
// Continuous health for this long ends the episode (its attempts and backoff are forgotten). A leg that delivers
// a byte inside each STALE window but never holds 5 minutes of health keeps its attempt count, so it backs off to
// the 30-minute cap instead of restarting every minute: a documented churn bound.
export const DETECTOR_RECOVERED_MS = 5 * 60 * 1000;
// How long a posted publisher request stays valid: four camera-watchdog ticks. One not consumed by then
// describes a situation that has moved on, and the detector watchdog will post again if it has not.
export const RESTART_REQUEST_TTL_MS = 60 * 1000;
export { MIN_KILL_AGE_MS };

// A leg is HEALTHY when its current process delivered a stdout byte within STALE. `health` is a detector's
// getXDetectorHealth() result: null (the 5s relaunch gap, or not running) and { waiting } (no process yet)
// are NOT healthy. Shared by both watchdogs so "dark" means exactly one thing.
export function detectorLegHealthy(health) {
  return health != null && health.dataAgeMs != null && health.dataAgeMs <= DETECTOR_STALE_MS;
}

// The backoff after `attempts` actions: 0 before the first, then FLOOR doubling, capped.
export function detectorRestartFloorMs(attempts) {
  if (attempts <= 0) return 0;
  return Math.min(DETECTOR_RESTART_FLOOR_MS * 2 ** (attempts - 1), DETECTOR_RESTART_CAP_MS);
}

// The mailbox between the detector watchdog (posts) and the camera watchdog (takes). ONE instance, built in
// index.js and handed to both. It OWNS ITS CLOCK (monotonic, Sol R2): the TTL is judged on the stamp it took
// itself, so the camera watchdog's Date.now never meets a performance.now stamp. `now` is injectable for tests
// only. `kind` is 'main' or 'sub': whose publisher to restart.
//   post(camId, kind, reason)  replaces any pending request of that kind for that camera
//   take(camId, kind)          removes it, and returns it only if it is still younger than the TTL, else null
//   cancel(camId)              removes both kinds (detection switched off, camera disabled or deleted)
export function createRestartRequests({ now = () => performance.now() } = {}) {
  const requests = new Map(); // `${camId}:${kind}` -> { reason, postedMono }
  const keyOf = (camId, kind) => `${camId}:${kind}`;
  const expired = (request, at) => at - request.postedMono >= RESTART_REQUEST_TTL_MS;
  return {
    post(camId, kind, reason) {
      const at = now();
      // Sweep what nobody took, so a deleted camera's request cannot sit here for the life of the process.
      for (const [key, request] of requests) if (expired(request, at)) requests.delete(key);
      requests.set(keyOf(camId, kind), { reason, postedMono: at });
    },
    take(camId, kind) {
      const key = keyOf(camId, kind);
      const request = requests.get(key);
      if (!request) return null;
      requests.delete(key);
      return expired(request, now()) ? null : request;
    },
    cancel(camId) {
      requests.delete(keyOf(camId, 'main'));
      requests.delete(keyOf(camId, 'sub'));
    },
    get size() {
      return requests.size;
    },
  };
}

// The production bindings (the bindings test checks each one IS the real function, except `now`, which is a
// wrapper by necessity: see CLOCKS above). ⚠️ startTranscoder and startSubStream are deliberately ABSENT, and a
// source tripwire in detector-watchdog.test.js keeps them out of this watchdog's code (plan v5 §D).
export const DEFAULT_DETECTOR_WATCHDOG_DEPS = Object.freeze({
  listCameras,
  getPathStatus,
  subPathName,
  motionLegWanted,
  getMotionDetectorHealth,
  getSoundDetectorHealth,
  restartMotionDetector,
  restartSoundDetector,
  probeVideoFlowing,
  probeAudioFlowing,
  recordCameraEvent,
  now: () => performance.now(),
});

const seconds = (ms) => Math.round(ms / 1000);

// How long an ENTRY-STALLED process has been dark, in words, for the event detail and the diagnosis line. Only
// ever called for one (a spawned process), so it has an age of one kind or the other.
function darkFor(health) {
  return health.dataAgeMs != null
    ? `no data for ${seconds(health.dataAgeMs)}s`
    : `no data in the ${seconds(health.spawnAgeMs)}s since it started`;
}

const VIDEO_PROBE_WORDS = { true: 'video packets arriving (packets, not frames)', 'video-missing': 'audio but NO video packets' };
const AUDIO_PROBE_WORDS = { true: 'audio flowing', false: 'no audio flowing' };

export function createDetectorWatchdog(overrides = {}) {
  const deps = { ...DEFAULT_DETECTOR_WATCHDOG_DEPS, restartRequests: null, ...overrides };
  // One pending check per camera LEG: a slow motion probe (up to 8s) never delays the sound leg.
  const run = perTargetRunner('detector-watchdog', { now: deps.now });

  const LEGS = {
    motion: {
      wanted: (cam) => deps.motionLegWanted(cam),
      health: (id) => deps.getMotionDetectorHealth(id),
      restart: (id, expect) => deps.restartMotionDetector(id, expect),
      noun: 'frames',
    },
    sound: {
      // What reconcile and the camera routes use to decide whether to run it.
      wanted: (cam) => !!cam.detect_sound_enabled,
      health: (id) => deps.getSoundDetectorHealth(id),
      restart: (id, expect) => deps.restartSoundDetector(id, expect),
      noun: 'audio data',
    },
  };
  const keyOf = ({ cam, leg }) => `${cam.id}:${leg}`;
  const nameOf = ({ cam, leg }) => `${cam.name}:${leg}`;

  // Per leg, created by the FIRST action and kept through the relaunch gap, `waiting` and a young replacement,
  // so the backoff and the escalation survive them (Opus R1). Deleted only by sustained recovery, the leg
  // becoming unwanted or disabled, or the camera leaving listCameras() - each restarts at attempts = 0.
  //   { camId, attempts, lastActionMono, lastHealthyMono, flowingSinceMono, lastSeenSpawnMono, gensWithoutData, path }
  const episodes = new Map();
  // Sound legs whose PREVIOUS eligible probe answered neither true nor false (key -> camId). See the sound gate.
  const inconclusiveProbe = new Map();

  function forget(key) {
    episodes.delete(key);
    inconclusiveProbe.delete(key);
  }

  // The stall verdict for a leg already known NOT healthy (E2), or null when there is nothing to act on.
  function stallOf(leg, st, health, now) {
    // (a) it had data and it is not healthy, so that data is older than STALE; (b) it never had any and it is
    // past its startup grace. A young replacement inside its own grace is neither, WHATEVER its episode. A
    // null health (the relaunch gap) and a `waiting` one carry neither age, so neither is ever entry-stalled.
    const entryStalled = health?.dataAgeMs != null || health?.spawnAgeMs > DETECTOR_STARTUP_GRACE_MS;
    // (c) motion only: a crash loop. NO healthy tick since the last action, EPISODE_STALL since it, and at least
    // two replacement generations seen without data. Two, not one: a single slow-starting replacement after
    // hours offline must not qualify (Astra R2 / Sol R2). It authorises a publisher request, never a kill.
    const episodeStalled = leg === 'motion' && st != null
      && (st.lastHealthyMono == null || st.lastHealthyMono <= st.lastActionMono)
      && now - st.lastActionMono > DETECTOR_EPISODE_STALL_MS
      && st.gensWithoutData >= 2;
    return entryStalled || episodeStalled ? { entryStalled, episodeStalled } : null;
  }

  // A confirmed READY. An unknown (#451: the API timed out) is not one, and needs no term of its own: getPathStatus
  // always returns it with `ready: false` (mediamtx.js). The 10:00 camera reboot lands here too.
  const confirmedReady = (status) => status?.ready === true;

  const publisherOf = (cam, path) =>
    (path === deps.subPathName(cam.mediamtx_path) ? 'sub' : path === cam.mediamtx_path ? 'main' : null);

  // DIAGNOSIS ONLY. A throwing probe is an inconclusive one: it must not stop the action it was only describing.
  async function diagnose(leg, cam, path) {
    try {
      return leg === 'motion' ? await deps.probeVideoFlowing(path) : await deps.probeAudioFlowing(cam.mediamtx_path);
    } catch {
      return null;
    }
  }

  async function checkLeg(target) {
    const { cam, leg } = target;
    const L = LEGS[leg];
    const key = keyOf(target);

    // E0. BEFORE any health early-return, or a leg switched off while dark would keep its request queued and
    // its episode alive (Astra R1/R2). Only the MOTION leg owns requests, so only it cancels them.
    if (cam.disabled || !L.wanted(cam)) {
      forget(key);
      if (leg === 'motion') deps.restartRequests?.cancel(cam.id);
      return;
    }

    const health = L.health(cam.id);
    const now = deps.now();
    const st = episodes.get(key);

    // E1. Healthy: nothing to do, except to count sustained recovery on its OWN clock (Astra R1).
    if (detectorLegHealthy(health)) {
      inconclusiveProbe.delete(key);
      if (!st) return;
      // (A generation that delivers here may still be counted in gensWithoutData if it stalls later. That count
      // matters only while NO healthy tick has happened since the last action, and this tick is one.)
      st.lastHealthyMono = now;
      st.flowingSinceMono ??= now;
      if (now - st.flowingSinceMono >= DETECTOR_RECOVERED_MS) episodes.delete(key);
      return;
    }

    // E2. Not healthy: any such tick breaks a sustained recovery, and a new process seen dark is one more
    // replacement generation that has not (yet) delivered.
    if (st) {
      st.flowingSinceMono = null;
      if (health?.spawnedMono != null && health.spawnedMono !== st.lastSeenSpawnMono) {
        st.gensWithoutData += 1;
        st.lastSeenSpawnMono = health.spawnedMono;
      }
    }
    // null / waiting / inside its grace, and no crash loop: skip WITHOUT touching the episode (the relaunch gap
    // must not cost the leg its attempt count).
    if (!stallOf(leg, st, health, now)) return;
    // E4 before E3 (no await for a leg inside its backoff; same outcome either way).
    if (st && now - st.lastActionMono < detectorRestartFloorMs(st.attempts)) return;
    // Always defined here: an entry-stall means a spawned process (which has its path), and an episode-stall
    // means an episode (which remembers the path of its last action).
    const path = health?.path ?? st?.path;
    // E3. #451: act only on a confirmed ready path.
    if (!confirmedReady(await deps.getPathStatus(path))) return;

    // E5. Diagnose (best effort), then RE-READ everything: the probe takes up to 8s, and a leg that recovered,
    // moved, or whose path dropped meanwhile must not be acted on. That abort changes NOTHING: no action, no
    // event, no episode update (Astra R1).
    const probe = await diagnose(leg, cam, path);
    const status = await deps.getPathStatus(path);
    if (!confirmedReady(status)) return;
    const fresh = L.health(cam.id);
    const at = deps.now();
    if (detectorLegHealthy(fresh)) return;
    if ((fresh?.path ?? st?.path) !== path) return;
    const verdict = stallOf(leg, episodes.get(key), fresh, at);
    if (!verdict) return;

    // E6. The ladder, by attempt count. The probe never vetoes it: repeated detector restarts escalate even when
    // every probe says video packets are arriving (a packet is not a frame).
    const attempts = episodes.get(key)?.attempts ?? 0;
    const kill = verdict.entryStalled; // (c) alone never kills: never a young replacement inside its grace
    let requestKind = null;
    if (leg === 'sound') {
      // SOUND: L1 only, never a request. `false` covers BOTH a path that really carries no audio (G.711 VAD,
      // Opus DTX) AND a probe that had to be killed after its 6 s window with zero packets - a live RTSP audio
      // stream never reaches EOF on its own, so a genuinely stalled one can *only* ever be observed via that
      // timeout, never a clean exit (audioLiveness.js). Either way it is the pre-existing audio watchdog's job,
      // not this leg's: restarting the SOUND DETECTOR would not fix a path-level audio problem, and that
      // watchdog independently restarts the transcoder on its own ~60-120s cadence (createAudioWatchdog above).
      // Corrected 2026-09-28 (#369 review fix round): this used to say a timeout-hang was INCONCLUSIVE and
      // "cost at most one extra tick" - traced and found wrong (a test proved changing probeAudioFlowing to
      // resolve `null` on that path breaks createAudioWatchdog's only real detection signal). Only a probe that
      // could not give a reading is inconclusive here: ffprobe missing / a spawn error, and (#515) a run that
      // exited non-zero or was killed from outside, all resolved `null`.
      if (probe === false) {
        inconclusiveProbe.delete(key);
        return;
      }
      if (probe !== true && !inconclusiveProbe.has(key)) {
        inconclusiveProbe.set(key, cam.id);
        return;
      }
    } else if (attempts >= 1 && deps.restartRequests) {
      // L2: this leg has already been restarted and is dark again. `main` when the detector reads the main path
      // (a camera with no sub, or a fallback while the sub is down, which #500 now ends by itself once the sub is
      // up and the room quiet): that costs the live view a brief interruption.
      requestKind = publisherOf(cam, path);
    }
    if (!kill && !requestKind) return;

    // E7. COMMIT BEFORE MUTATING (Opus R1): a lever that throws, hangs or empties the entry can never cause a
    // retry without backoff, because the attempt is already counted.
    const ep = episodes.get(key) ?? {
      camId: cam.id, attempts: 0, lastActionMono: null, lastHealthyMono: null, flowingSinceMono: null,
      lastSeenSpawnMono: null, gensWithoutData: 0, path: null,
    };
    ep.attempts += 1;
    ep.lastActionMono = at;
    // The process judged here is not a REPLACEMENT generation: remember it, so that if it outlives the action
    // (a kill refused, or a wedged process not yet reaped) the next tick does not count it towards the crash loop.
    if (fresh?.spawnedMono != null) ep.lastSeenSpawnMono = fresh.spawnedMono;
    ep.gensWithoutData = 0;
    ep.path = path;
    episodes.set(key, ep);
    inconclusiveProbe.delete(key);

    const publisher = requestKind === 'sub' ? 'sub-stream (Low)' : 'transcoder';
    const dark = verdict.entryStalled ? darkFor(fresh) : `no data through ${attempts} restart(s) and the relaunches since`;
    const lever = kill && requestKind ? `detector + ${requestKind} publisher` : kill ? 'detector' : `${requestKind} publisher`;
    const levers = [kill && `${leg} detector restarted`, requestKind && `${publisher} restart requested`].filter(Boolean).join(', ');
    deps.recordCameraEvent(cam.id, cam.name, EVENT.RESTART, `${leg} detector getting no ${L.noun} (${dark}) - ${levers} by the detector watchdog`);
    const words = leg === 'motion' ? VIDEO_PROBE_WORDS : AUDIO_PROBE_WORDS;
    logger.warn(
      `[detector-watchdog] "${cam.name}" ${leg} on ${path}: ${dark}; ` +
      `path ready, ${status.readers ?? '?'} reader(s), tracks ${(status.tracks || []).join('+') || 'none'}; ` +
      `probe: ${words[String(probe)] ?? 'inconclusive'}; ` +
      `input tap: ${fresh?.inputRecordAgeMs != null ? `last record ${seconds(fresh.inputRecordAgeMs)}s ago` : 'no record (inconclusive)'}; ` +
      `attempt ${ep.attempts}; lever: ${lever}`
    );
    if (requestKind) deps.restartRequests.post(cam.id, requestKind, `${leg} detector on ${path}: ${dark}`);
    if (kill) L.restart(cam.id, { expectSpawn: fresh.spawnedMono, expectLastData: fresh.lastDataMono });
  }

  async function tick() {
    const cameras = deps.listCameras();
    // A camera that left the list (deleted) takes its episodes and requests with it: re-added, it starts clean.
    const ids = new Set(cameras.map(byId));
    for (const [key, ep] of episodes) {
      if (!ids.has(ep.camId)) {
        episodes.delete(key);
        deps.restartRequests?.cancel(ep.camId);
      }
    }
    for (const [key, camId] of inconclusiveProbe) if (!ids.has(camId)) inconclusiveProbe.delete(key);
    const targets = cameras.flatMap((cam) => [{ cam, leg: 'motion' }, { cam, leg: 'sound' }]);
    await run(targets, keyOf, nameOf, checkLeg);
  }

  // A read-only copy of one leg's episode, or null: for tests and for a later per-detector status view.
  function episodeOf(camId, leg) {
    const ep = episodes.get(`${camId}:${leg}`);
    return ep ? { ...ep } : null;
  }

  return { tick, episodeOf };
}
