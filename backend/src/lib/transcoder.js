import { spawnChild } from './childEnv.js';
import { logger, isNoisyMediaLine } from './logger.js';
import { recordCameraEvent, EVENT } from './cameraEvents.js';
import { ffprobeAudioCodec } from './rtspProbe.js';
import { hlsPathName, upsertPath, isPathConfiguredCorrectly } from './mediamtx.js';
import { killIfSpawned } from './processGuards.js';
import { forwardProcessLines } from './processOutput.js';

// camera_id -> { proc, stopped }
const processes = new Map();

// Cameras with a relaunch SCHEDULED but no process yet — the 5s gap between an ffmpeg exit and the
// restart. The exit handler removes the camera from `processes` before arming that timer, so during
// the gap the entry is unreachable and `entry.stopped`, the only brake on the relaunch, cannot be set
// by anything. stopTranscoder() was therefore a no-op inside the window: deleting or disabling a
// camera mid-restart left ffmpeg respawning every 5s for the life of the container, invisible to
// isRunning() and so unreachable by the watchdog or reconcile. A flapping camera restarts every 5s,
// so the window is effectively always open for exactly the camera you would want to stop.
// Keeping the timer handle here is what makes the relaunch cancellable. See issue #253.
const pendingRestarts = new Map(); // cameraId -> timeout handle

// Stops whose process has not exited yet (#478 code review): cameraId -> a promise that resolves once it has, or
// once the 3 s fallback has SENT SIGKILL (not once that took effect: see stopProcess for what that leaves
// uncovered). A stop deletes the camera from `processes` before its process is gone, so this
// is the only record that one is still dying; see stopProcess. Deleted as soon as the stop settles.
const stopsInProgress = new Map();

// Cancel a scheduled relaunch, if any. Safe to call for a camera that has none.
function cancelPendingRestart(cameraId) {
  const t = pendingRestarts.get(cameraId);
  if (t) {
    clearTimeout(t);
    pendingRestarts.delete(cameraId);
  }
}

// rtsp_url -> source audio codec (probed once, reused across restarts — the codec doesn't change while
// a camera stays put). Lets buildArgs pick the right WebRTC audio track without an ffprobe per restart.
const audioCodecCache = new Map();
async function sourceIsAac(rtspUrl) {
  if (!audioCodecCache.has(rtspUrl)) {
    const codec = await ffprobeAudioCodec(rtspUrl);
    if (!codec) return false; // couldn't probe (camera momentarily down?) — safe default, retry next start
    audioCodecCache.set(rtspUrl, codec);
  }
  return audioCodecCache.get(rtspUrl) === 'aac';
}

const RESTART_DELAY_MS = 5000;
// If SIGTERM hasn't actually stopped the process within this long, escalate to
// SIGKILL rather than wait indefinitely - a stuck FFmpeg process should never be
// able to block a restart forever.
const FORCE_KILL_TIMEOUT_MS = 3000;

function buildArgs(rtspUrl, mediamtxPath, aacSource) {
  // ONE FFmpeg, TWO published outputs — because WebRTC and MPEG-TS HLS share no common audio codec, and
  // MediaMTX's MPEG-TS HLS won't tolerate a non-AAC audio track (notably Opus) on the same path as AAC.
  // So we split them onto sibling paths:
  //   • main path  = video + the camera's OWN audio (Opus/G711), for WebRTC / Low latency.
  //   • <path>-hls = video + AAC, for HLS / Compatibility.
  // A native-Opus camera thus keeps crisp Opus on Low latency AND still works in Compatibility. See
  // lib/mediamtx.js hlsPathName. (Video is a cheap copy on both; audio is decoded once for the AAC.)
  const hlsPath = hlsPathName(mediamtxPath);
  // The main (WebRTC) audio: pass the camera's own codec through (Opus stays Opus, G711 stays G711) so
  // Low latency gets the best the camera offers. Exception: an AAC source — WebRTC can't carry AAC — is
  // down-converted to G711 (µ-law, 8 kHz mono), which WebRTC does carry.
  const webrtcAudio = aacSource ? ['-ac', '1', '-ar', '8000', '-c:a', 'pcm_mulaw'] : ['-c:a', 'copy'];
  return [
    '-nostdin',
    '-loglevel', 'warning',
    '-rtsp_transport', 'tcp',
    // Every RTSP reconnect legitimately starts a fresh, near-zero timestamp epoch;
    // genpts smooths that transition. This camera also occasionally sends one
    // corrupted RTP timestamp (jumping to billions) that no amount of PTS/DTS
    // reinterpretation can clean up after the fact - see the discontinuity
    // detector below, which is the real defense against that.
    '-fflags', '+genpts',
    // Discard the camera's own (buggy) RTP timestamps entirely and stamp each packet
    // with the server's arrival time instead. Some cameras - notably the Sonoff
    // GK-200MP2-B - send jittery/backward audio timestamps and occasional corrupt video
    // timestamps; replacing them at the input with a monotonic wall-clock fixes both at
    // the source, for every downstream track at once. Trade-off: timing is arrival-based, so
    // A/V lip-sync can drift slightly - acceptable for a monitor, and the alternative was
    // stalled audio / stream restarts. Applied to the input, so it must precede -i.
    '-use_wallclock_as_timestamps', '1',
    '-i', rtspUrl,

    // --- OUTPUT 1: main path (WebRTC / Low latency) — video copied, the camera's own audio ---
    '-map', '0:v:0',
    '-map', '0:a:0?', // "?" = optional, in case a camera has no audio track at all
    '-c:v', 'copy',
    ...webrtcAudio,
    '-avoid_negative_ts', 'make_zero',
    '-f', 'rtsp',
    '-rtsp_transport', 'tcp',
    `rtsp://127.0.0.1:8554/${mediamtxPath}`,

    // --- OUTPUT 2: <path>-hls (HLS / Compatibility) — video copied, audio always AAC ---
    // Some cameras send audio with jittery, occasionally-backward RTP timestamps (logged as "Queue input
    // is backward in time"); fed straight to the AAC encoder those poison the HLS muxer's timeline and
    // show up as "No signal" in Compatibility. We used to fix this with aresample=async=1, but that
    // DROPS/inserts samples on every jitter event and made Compatibility audio audibly choppy (~15
    // dropouts in 15s on the Sonoff cam). Instead we resample to 48k and REBUILD the audio PTS purely
    // from the sample count (asetpts=N/SR/TB): the output clock is perfectly monotonic, so the HLS muxer
    // never sees a backward jump, and no samples are dropped (0 dropouts). Trade-off: a genuine audio gap
    // collapses rather than silence-padding, so lip-sync can drift slightly on a bad camera — an accepted
    // trade, far better than choppy. See KNOWN-ISSUES.md.
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-c:v', 'copy',
    '-filter:a', 'aresample=48000,asetpts=N/SR/TB',
    '-c:a', 'aac', '-b:a', '64k',
    '-avoid_negative_ts', 'make_zero',
    '-f', 'rtsp',
    '-rtsp_transport', 'tcp',
    `rtsp://127.0.0.1:8554/${hlsPath}`,
  ];
}

// #478: ONE START AT A TIME PER CAMERA.
//
// THE DEFECT. Many callers start a transcoder: the camera watchdog's main leg and the audio watchdog
// (cameraWatchdogs.js), reconcileCameraPaths (index.js, at boot and every 5 minutes), the camera routes (add,
// an edit with a new address, enable, restart, a failed delete putting a camera back) and subStream.js (under
// its own key, `<id>-sub`). #451 serialised the checks of ONE watchdog runner only, so nothing stopped two of
// these overlapping for one camera. Both then stopped the old process, both awaited the probe and the MediaMTX
// checks below, and both launched: the second `processes.set` overwrote the first, whose ffmpeg kept running
// and publishing, invisible to isRunning() and out of stopTranscoder()'s reach. Two lineages on one path kick
// each other off it forever (the 901-restart incident described in launch()'s exit handler). Found by reading
// the source while planning #451; never reproduced in production.
//
// THE FIX. Each camera has a promise chain. A start waits until the previous start of the SAME camera has
// finished, resolved or rejected, and then runs with ITS OWN arguments. Different cameras never wait for each
// other. Requests with different arguments are never merged: an edit with a new RTSP address must end with
// that address running, not with whichever start happened to be in flight. #780 saves the new address
// before queuing its start. #787 also preserves camera columns changed by another save while the edit
// waits for an ONVIF probe; a column this edit changed wins its own write. A reader that fetched the
// old row before that write can still queue its stale-address start after the edit's start; this queue
// then runs it last. Closing that narrow window requires re-reading the address when a queued start
// runs, outside this module's current contract.
//
// One record per camera, deleted when its chain drains, so nothing is left behind for a deleted camera:
//   tail     what the next start waits on. Always `run.then(noop, noop)`, so a start that rejects rejects for
//            its own caller only and never poisons the starts queued behind it.
//   epoch    the stop generation, bumped by the exported stopTranscoder(). A start whose generation has moved
//            since it was QUEUED was stopped meanwhile (camera disabled, deleted, shutting down) and launches
//            nothing.
//   pending  starts queued or in flight. While it is above 0, isRunning() reports true.
//   last     the start queued most recently, kept for the same-arguments dedupe in startTranscoder().
const startChains = new Map(); // cameraId -> { tail, epoch, pending, last }
const noop = () => {};

// True while ffmpeg is tracked for this camera, OR a start for it is queued or in flight (#478). The second
// half matters: between a start's own stop and its launch nothing is in `processes`, so reconcile (index.js)
// read that as "not running" and queued a second start, whose own stop then killed the first one's fresh
// ffmpeg. A start that ends without launching leaves `pending` before its caller resumes, so right after
// `await startTranscoder(...)` this reports only the process.
export function isRunning(cameraId) {
  return processes.has(cameraId) || (startChains.get(cameraId)?.pending ?? 0) > 0;
}

// Test seam ONLY (transcoder-start-chain.test.js), like mediamtx.js's setMediamtxApiTimeoutForTest: how many
// per-camera chain records exist, so a test can prove they are deleted once their starts have settled.
// Nothing in src/ uses it, which is why the four-export mock of this module in who-did-it.test.js still loads.
export function startChainCountForTest() {
  return startChains.size;
}

// Test seam ONLY, the same kind: how many stop records are kept, so a test can prove a settled stop's is deleted.
export function stopsInProgressCountForTest() {
  return stopsInProgress.size;
}

// ★ `options.prepare` (#806): an optional async step run INSIDE the start, after the old process has stopped and
// before the probe, handed `stopped()` (see doStart). It exists for work that must happen before the launch but that
// the caller used to await BEFORE calling this function: startSubStream checked and re-created the sub path first, and
// during that MediaMTX round trip nothing was queued, so a disable's stopTranscoder found no chain record to bump and the
// start, queued afterwards with a fresh generation, launched a disabled camera. Done inside, the stop generation
// (captured below, when the request is QUEUED) already covers it.
// Rules for a `prepare`: it must be BOUNDED (it holds this camera's chain; MediaMTX calls are capped by their own API
// deadline), it must not start a transcoder of the same camera (the deadlock doStart warns about), and it must check
// `stopped()` before any write that a stop would have undone. Requests are deduped on the four arguments only, so every
// caller of one leg must pass an equivalent `prepare`.
export function startTranscoder(cameraId, rtspUrl, mediamtxPath, cameraName = mediamtxPath, { prepare } = {}) {
  let chain = startChains.get(cameraId);
  if (!chain) {
    chain = { tail: Promise.resolve(), epoch: 0, pending: 0, last: null };
    startChains.set(cameraId, chain);
  }
  // ⚠️ CAPTURED HERE, WHEN THE REQUEST IS QUEUED, synchronously. Never when the start begins, and never after
  // doStart's own stop (Opus plan review of #478, HIGH): a start queued behind another would then read the
  // generation AFTER a disable that landed while it waited, and launch a disabled camera. Neither reconcile nor
  // any watchdog stops a disabled camera, so that ffmpeg would relaunch every 5 s for the life of the
  // container, the #253 failure mode.
  const epoch = chain.epoch;
  // Dedupe: a request with the same four arguments, in the same stop generation, as the start queued LAST
  // shares that start's promise instead of queueing another. It bounds `POST /:id/restart` spam
  // (routes/cameras.js) to one queued restart. It never joins:
  //   * the start in flight: a request made while a start is part-way through may be reacting to what that
  //     start has already done (stopped the stream, probed a camera that was down), so it gets its own start;
  //   * an earlier queued start that is no longer the last: joining it would run this request BEFORE a later
  //     one with different arguments, and the camera would end on those;
  //   * across a stop: disable then enable would otherwise join a start the disable aborted, and the camera
  //     would come back enabled with no transcoder at all.
  const last = chain.last;
  if (last && !last.started && last.epoch === epoch && last.rtspUrl === rtspUrl
    && last.mediamtxPath === mediamtxPath && last.cameraName === cameraName) {
    return last.run;
  }
  const request = { epoch, rtspUrl, mediamtxPath, cameraName, started: false, run: null };
  const previous = chain.tail;
  chain.pending += 1;
  chain.last = request;
  const stopped = () => chain.epoch !== epoch;
  request.run = (async () => {
    try {
      await previous; // never rejects: see `tail` above
      request.started = true;
      await doStart(cameraId, rtspUrl, mediamtxPath, cameraName, stopped, prepare);
    } finally {
      // In the run's OWN finally, so it is done before the caller's `await` resumes: isRunning() must not still
      // say true straight after a start that launched nothing. Never `run.finally(cleanup)` instead: that is a
      // second promise, and when the start rejects nothing would catch it, an unhandledRejection that
      // processGuards.js's backstop logs as a fault on every failed start.
      chain.pending -= 1;
      if (chain.last === request) chain.last = null;
      if (chain.pending === 0 && startChains.get(cameraId) === chain) startChains.delete(cameraId);
    }
  })();
  // The caller gets `run` itself, so a rejection reaches that caller (and anyone deduped onto it) and no one
  // else; the chain keeps only the settled-either-way copy.
  chain.tail = request.run.then(noop, noop);
  return request.run;
}

// A start that was stopped part-way. It RESOLVES, deliberately, and is not an error: the restart route would
// answer 502 for a camera that was simply switched off meanwhile, and reconcile's catch (index.js) would
// re-run its whole pass 3 s later. `when` says how far the start got, for the log.
function abandon(mediamtxPath, when) {
  logger.info(`[ffmpeg:${mediamtxPath}] start abandoned ${when}: the camera was stopped while it was starting`);
}

// The start itself. It runs only through startTranscoder()'s chain, so at most one runs per camera.
// `stopped()` reports whether the exported stopTranscoder() ran since this request was queued. It is checked
// after every await below and once more right before launch(), with no await between that check and the
// launch, the last moment a stop can still be honoured.
//
// ⚠️ NOTHING IN HERE MAY START, OR AWAIT A START OF, THE SAME CAMERA (startTranscoder, or anything that calls
// it). That start would queue behind this one, which would be waiting for it: a deadlock that holds the
// camera's chain, and every later start of that camera, forever. The 5 s relaunch timer inside launch() calls
// launch() directly, never startTranscoder, for the same reason, and because a relaunch is not a new start: it
// is this lineage replacing its own exited process.
async function doStart(cameraId, rtspUrl, mediamtxPath, cameraName, stopped, prepare) {
  if (stopped()) return abandon(mediamtxPath, 'while it waited its turn');
  // Wait for any previous process for this camera to actually be gone before
  // starting a new one - previously this fired stop and start back-to-back, which
  // left a real window where the old FFmpeg process was still holding the MediaMTX
  // publish connection when the new one tried to claim the same path. That collision
  // could leave MediaMTX's own state for the path confused well beyond just this one
  // restart, causing repeated "broken pipe" failures rather than a single clean blip.
  // The INTERNAL stop (#478): the exported stopTranscoder() bumps the stop generation, which would abort this
  // very start. It also waits for a stop of this camera that is still in progress (a disable, a delete or
  // stopSubStream whose process has not exited yet), for at most that stop's 3 s fallback: until the old process
  // exits or SIGKILL is sent. After a SIGKILL the old process is gone a moment later, not at once, and one that
  // survives SIGKILL is not waited for (see stopProcess).
  await stopProcess(cameraId);
  if (stopped()) return abandon(mediamtxPath, 'while the old ffmpeg stopped');

  // #806: the caller's own pre-launch step (the sub path check and re-create), inside the stop cover. After it, like
  // after every await here, a stop that landed meanwhile abandons the start.
  if (prepare) {
    await prepare(stopped);
    if (stopped()) return abandon(mediamtxPath, 'while its MediaMTX path was prepared');
  }

  // Probe the source audio codec once (cached) so we can build the right WebRTC audio track. A probe
  // failure/timeout returns false → the current passthrough-copy behaviour, so nothing regresses.
  const aacSource = await sourceIsAac(rtspUrl);
  if (stopped()) return abandon(mediamtxPath, 'while the camera was probed');
  if (aacSource) logger.info(`[ffmpeg:${mediamtxPath}] AAC-audio source — using G711 for the WebRTC track so HLS stays valid`);

  // Ensure the sibling AAC/HLS path exists before we publish to it (see buildArgs — the second output).
  // Same publisher-only config as the main path; created once and left in place across restarts (the
  // isConfigured check avoids a needless reload). The main path itself is created by reconcile/routes.
  // `=== false`, never `!`: null means MediaMTX did not answer, and writing then could reload a path
  // that was fine (#451; see isPathConfiguredCorrectly). If the path really was missing, ffmpeg cannot
  // publish to it, the stream goes unready, and the watchdog's restart comes back through here to ask
  // again once MediaMTX answers.
  const hlsPath = hlsPathName(mediamtxPath);
  if ((await isPathConfiguredCorrectly(hlsPath)) === false) {
    // Checked before the write as well (#478): a DELETE that stopped this start also removes `-hls`, and the
    // write would re-create a MediaMTX path for a camera that no longer exists.
    if (stopped()) return abandon(mediamtxPath, 'before the -hls path was written');
    await upsertPath(hlsPath).catch((e) => logger.error(`[hls-path:${hlsPath}] ${e.message}`));
  }

  function launch() {
    const proc = spawnChild('ffmpeg', buildArgs(rtspUrl, mediamtxPath, aacSource), { stdio: ['ignore', 'ignore', 'pipe'] });
    const entry = { proc, stopped: false };
    processes.set(cameraId, entry);

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
      // sane cadence, and isRunning() reports the truth in the meantime — without this the leg would be
      // left claimed by a process that never existed, and reconcile would skip it as healthy.
      logger.error(`[ffmpeg:${mediamtxPath}] could not start ffmpeg: ${err.code || err.message}`);
      if (processes.get(cameraId) === entry) processes.delete(cameraId);
    });

    let lastLine = '';
    // This camera occasionally sends one corrupted RTP timestamp (jumping to
    // billions, near the 32-bit rollover point) which poisons every downstream
    // PTS/DTS calculation for the rest of the session - no ffmpeg flag can clean
    // that up after the fact once it's happened. Catching the discontinuity as
    // soon as ffmpeg reports it and restarting immediately limits the damage to
    // a ~5s reconnect blip instead of hours of garbled output.
    let restarting = false;
    forwardProcessLines(proc, proc.stderr, (line) => {
      // Drop the benign per-packet timestamp spam from the logs (and from lastLine, so the exit
      // message reports the real last error, not a cosmetic warning). The discontinuity check
      // below still runs on every line — a real "DTS discontinuity" never matches the noise filter.
      if (isNoisyMediaLine(line)) return;
      lastLine = line;
      logger.raw(`ffmpeg:${mediamtxPath}`, line);
      if (!restarting && line.includes('DTS discontinuity in stream')) {
        restarting = true;
        logger.error(
          `[ffmpeg:${mediamtxPath}] camera sent a corrupt timestamp - restarting now rather than let the session run poisoned`
        );
        recordCameraEvent(cameraId, cameraName, EVENT.RESTART, 'camera sent a corrupt timestamp');
        killIfSpawned(proc, 'SIGTERM');
      }
    });

    proc.on('exit', (code) => {
      // Only the entry currently tracked in the map "owns" this camera. A stale
      // process (superseded while it was still running) must NOT schedule its own
      // resurrection: MediaMTX lets a new publisher override the current one, so a
      // second lineage doesn't fail fast - it kicks the legitimate one off the
      // path, which then restarts and kicks it back, indefinitely. That exact
      // ping-pong once flapped a camera every ~10 seconds for 2.5 hours (901
      // restarts) after a camera glitch got two lineages running at once.
      const wasTracked = processes.get(cameraId) === entry;
      if (wasTracked) processes.delete(cameraId);
      if (!entry.stopped && wasTracked) {
        logger.error(
          `[ffmpeg:${mediamtxPath}] exited (code ${code}), restarting in 5s. Last output: ${lastLine}`
        );
        // The DTS-discontinuity path already recorded its own, more specific event just
        // before killing the process - don't double-log that same restart here.
        if (!restarting) {
          recordCameraEvent(cameraId, cameraName, EVENT.RESTART, `stream ended (exit code ${code})`);
        }
        pendingRestarts.set(cameraId, setTimeout(() => {
          pendingRestarts.delete(cameraId);
          // Re-checked at fire time too: startTranscoder (watchdog, camera edit)
          // may have started a new owner during the 5s delay - launching anyway
          // would create exactly the two-lineage fight described above.
          // ⚠️ launch(), never startTranscoder() (#478): this closure runs outside the per-camera chain, and a
          // start queued from here would wait behind whatever start is in flight (see doStart's header). Any
          // start that does run cancels this timer first, through its own stop.
          if (!entry.stopped && !processes.has(cameraId)) launch();
        }, RESTART_DELAY_MS));
      }
    });
  }

  // Synchronously before launch(), with no await in between (#478).
  if (stopped()) return abandon(mediamtxPath, 'before ffmpeg was launched');
  launch();
}

// The exported stop: every caller outside this file (the routes' disable and delete, stopSubStream, shutdown).
// It also bumps the camera's stop generation, so a start that is queued or in flight launches nothing (#478).
// Without that, a disable landing while a start awaited its probe stopped nothing (no process existed yet), and
// the start then launched the disabled camera. A camera with no start pending has no record, so nothing is
// bumped and nothing is kept.
// ⚠️ It does NOT go through the chain: it must never wait behind a queued start (shutdown's 9 s bound, index.js,
// pinned by recordings-shutdown.test.js), and it needs no turn, because the generation alone stops what is queued.
export function stopTranscoder(cameraId) {
  const chain = startChains.get(cameraId);
  if (chain) chain.epoch += 1;
  return stopProcess(cameraId);
}

// Stop and forget the tracked process (and any relaunch armed for it), WITHOUT touching the stop generation.
// doStart() uses it for its own stop; everything else goes through stopTranscoder() above.
function stopProcess(cameraId) {
  // FIRST, and before the early return below: a camera in the 5s restart gap has no entry in
  // `processes` but does have a relaunch armed. Without this, stop() returned Promise.resolve() and
  // the relaunch fired anyway (#253).
  cancelPendingRestart(cameraId);

  const entry = processes.get(cameraId);
  // #478 code review (Codex, reproduced with a fake ffmpeg that ignores SIGTERM): "nothing tracked" does not mean
  // "nothing running". A stop deletes the entry at once, then waits up to FORCE_KILL_TIMEOUT_MS for the process
  // to exit. A start arriving in that window found no entry, its own stop returned at once, and it launched next
  // to the old process, still alive until the SIGKILL: two publishers on one path. So a stop with nothing tracked
  // waits for the stop still in progress, and for no longer than that stop does.
  // ⚠️ WHAT THIS DOES NOT COVER (round 2, accepted as a limit): the wait ends at the old process's 'exit', OR when
  // the fallback SENDS SIGKILL, not when the process has died from it. A process killed that way is gone a moment
  // later, not at once, so a queued start can spawn while it is still exiting (Codex showed it with a fake that
  // exits one event-loop turn after SIGKILL); one that survives SIGKILL (stuck in the kernel) is not waited for at
  // all. Deliberate: waiting on, or abandoning the start for, a child that cannot be killed would leave the camera
  // down for good, and resolving at the SIGKILL is what this stop always did.
  // Still outside the start chain, so shutdown's bound is unchanged (stopAllTranscoders runs these in parallel).
  if (!entry) return stopsInProgress.get(cameraId) ?? Promise.resolve();

  entry.stopped = true;
  processes.delete(cameraId);

  const stopping = killAndWait(entry);
  // Joined with a stop already in progress, if any, so a later wait covers every process still dying. Defensive:
  // now that a start waits here, a second process should not exist while one is still stopping.
  const prior = stopsInProgress.get(cameraId);
  const inProgress = prior ? Promise.all([prior, stopping]).then(noop) : stopping;
  stopsInProgress.set(cameraId, inProgress);
  inProgress.then(() => {
    if (stopsInProgress.get(cameraId) === inProgress) stopsInProgress.delete(cameraId);
  });
  return inProgress;
}

// SIGTERM the entry's process and resolve once it is gone, or after FORCE_KILL_TIMEOUT_MS and a SIGKILL. Never
// rejects.
function killAndWait(entry) {
  return new Promise((resolve) => {
    let resolved = false;
    function done() {
      if (resolved) return;
      resolved = true;
      resolve();
    }
    // A process that never spawned has no OS process behind it, and stop() can land in that window
    // (it is ~5ms wide: spawn() returns synchronously, 'error' arrives on a later tick). Two
    // consequences, both found by adversarial review of PR #274:
    //   1. Killing it is unsafe, and `killIfSpawned` is what makes it safe — see processGuards.js.
    //      ⚠️ THIS USED TO SAY "kill() THROWS on it — EINVAL, verified on win32", wrapped in a
    //      try/catch, and that was only the Windows half of the truth. On Linux it does NOT throw: it
    //      resolves to `kill(0, SIGTERM)`, which signals the WHOLE PROCESS GROUP — the backend kills
    //      itself, MediaMTX and every FFmpeg. A try/catch cannot help with that, and the comment
    //      claiming it did is why nobody looked again. Measured 2026-09-06, in #263.
    //   2. It emits 'error' then 'close' but NEVER 'exit', so waiting on 'exit' alone would stall
    //      every such stop for the full force-kill timeout before resolving.
    const kill = (sig) => killIfSpawned(entry.proc, sig);
    entry.proc.once('exit', done);
    entry.proc.once('error', done);
    kill('SIGTERM');
    // Belt-and-suspenders: don't let a stuck process block a restart indefinitely.
    setTimeout(() => {
      if (resolved) return;
      kill('SIGKILL');
      done();
    }, FORCE_KILL_TIMEOUT_MS);
  });
}

export async function stopAllTranscoders() {
  // The union of all four: a camera sitting in its restart gap is in `pendingRestarts` only, and
  // iterating `processes` alone would leave its relaunch armed through shutdown. A camera whose start is
  // queued or in flight is in `startChains` only (#478): stopping it bumps its stop generation, so that start
  // launches nothing after shutdown has begun. A camera whose ffmpeg an earlier stop (a disable, a delete) is
  // still waiting on is in `stopsInProgress` only (#478 code review, round 2): without it, shutdown settled while
  // that process was still alive. Its stop is awaited like the rest, in parallel, each bounded by the 3 s
  // fallback, so the shutdown bound is unchanged. The stops themselves stay outside the chain (see stopTranscoder).
  const ids = new Set([...processes.keys(), ...pendingRestarts.keys(), ...startChains.keys(), ...stopsInProgress.keys()]);
  await Promise.all([...ids].map(stopTranscoder));
}
