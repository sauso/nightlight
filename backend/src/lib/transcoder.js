import { spawn } from 'child_process';
import { logger } from './logger.js';
import { recordCameraEvent, EVENT } from './cameraEvents.js';
import { ffprobeAudioCodec } from './rtspProbe.js';
import { hlsPathName, upsertPath, isPathConfiguredCorrectly } from './mediamtx.js';

// camera_id -> { proc, stopped }
const processes = new Map();

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

export function isRunning(cameraId) {
  return processes.has(cameraId);
}

export async function startTranscoder(cameraId, rtspUrl, mediamtxPath, cameraName = mediamtxPath) {
  // Wait for any previous process for this camera to actually be gone before
  // starting a new one - previously this fired stop and start back-to-back, which
  // left a real window where the old FFmpeg process was still holding the MediaMTX
  // publish connection when the new one tried to claim the same path. That collision
  // could leave MediaMTX's own state for the path confused well beyond just this one
  // restart, causing repeated "broken pipe" failures rather than a single clean blip.
  await stopTranscoder(cameraId);

  // Probe the source audio codec once (cached) so we can build the right WebRTC audio track. A probe
  // failure/timeout returns false → the current passthrough-copy behaviour, so nothing regresses.
  const aacSource = await sourceIsAac(rtspUrl);
  if (aacSource) logger.info(`[ffmpeg:${mediamtxPath}] AAC-audio source — using G711 for the WebRTC track so HLS stays valid`);

  // Ensure the sibling AAC/HLS path exists before we publish to it (see buildArgs — the second output).
  // Same publisher-only config as the main path; created once and left in place across restarts (the
  // isConfigured check avoids a needless reload). The main path itself is created by reconcile/routes.
  const hlsPath = hlsPathName(mediamtxPath);
  if (!(await isPathConfiguredCorrectly(hlsPath))) {
    await upsertPath(hlsPath).catch((e) => logger.error(`[hls-path:${hlsPath}] ${e.message}`));
  }

  function launch() {
    const proc = spawn('ffmpeg', buildArgs(rtspUrl, mediamtxPath, aacSource), { stdio: ['ignore', 'ignore', 'pipe'] });
    const entry = { proc, stopped: false };
    processes.set(cameraId, entry);

    let lastLine = '';
    // This camera occasionally sends one corrupted RTP timestamp (jumping to
    // billions, near the 32-bit rollover point) which poisons every downstream
    // PTS/DTS calculation for the rest of the session - no ffmpeg flag can clean
    // that up after the fact once it's happened. Catching the discontinuity as
    // soon as ffmpeg reports it and restarting immediately limits the damage to
    // a ~5s reconnect blip instead of hours of garbled output.
    let restarting = false;
    proc.stderr.on('data', (chunk) => {
      chunk
        .toString()
        .split('\n')
        .filter((line) => line.length > 0)
        .forEach((line) => {
          lastLine = line;
          logger.raw(`ffmpeg:${mediamtxPath}`, line);
          if (!restarting && line.includes('DTS discontinuity in stream')) {
            restarting = true;
            logger.error(
              `[ffmpeg:${mediamtxPath}] camera sent a corrupt timestamp - restarting now rather than let the session run poisoned`
            );
            recordCameraEvent(cameraId, cameraName, EVENT.RESTART, 'camera sent a corrupt timestamp');
            proc.kill('SIGTERM');
          }
        });
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
        setTimeout(() => {
          // Re-checked at fire time too: startTranscoder (watchdog, camera edit)
          // may have started a new owner during the 5s delay - launching anyway
          // would create exactly the two-lineage fight described above.
          if (!entry.stopped && !processes.has(cameraId)) launch();
        }, RESTART_DELAY_MS);
      }
    });
  }

  launch();
}

export function stopTranscoder(cameraId) {
  const entry = processes.get(cameraId);
  if (!entry) return Promise.resolve();

  entry.stopped = true;
  processes.delete(cameraId);

  return new Promise((resolve) => {
    let resolved = false;
    function done() {
      if (resolved) return;
      resolved = true;
      resolve();
    }
    entry.proc.once('exit', done);
    entry.proc.kill('SIGTERM');
    // Belt-and-suspenders: don't let a stuck process block a restart indefinitely.
    setTimeout(() => {
      if (resolved) return;
      entry.proc.kill('SIGKILL');
      done();
    }, FORCE_KILL_TIMEOUT_MS);
  });
}

export async function stopAllTranscoders() {
  await Promise.all([...processes.keys()].map(stopTranscoder));
}