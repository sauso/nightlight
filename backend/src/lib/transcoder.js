import { spawn } from 'child_process';
import { logger } from './logger.js';
import { recordCameraEvent, EVENT } from './cameraEvents.js';
import { audioPathName } from './mediamtx.js';

// camera_id -> { proc, stopped }
const processes = new Map();

const RESTART_DELAY_MS = 5000;
// If SIGTERM hasn't actually stopped the process within this long, escalate to
// SIGKILL rather than wait indefinitely - a stuck FFmpeg process should never be
// able to block a restart forever.
const FORCE_KILL_TIMEOUT_MS = 3000;

function buildArgs(rtspUrl, mediamtxPath, hasAudio) {
  const args = [
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
    // the source, for every downstream track at once (the WebRTC copy tracks too, which
    // the per-output aresample below can't reach). Trade-off: timing is arrival-based, so
    // A/V lip-sync can drift slightly - acceptable for a monitor, and the alternative was
    // stalled audio / stream restarts. Applied to the input, so it must precede -i.
    '-use_wallclock_as_timestamps', '1',
    '-i', rtspUrl,
    '-map', '0:v:0',
    '-map', '0:a:0?', // "?" makes these optional, in case a camera has no audio track at all
    '-map', '0:a:0?',
    '-c:v', 'copy',
    // Two audio tracks, not one: WebRTC (Low Latency mode) can't decode AAC at all, and
    // HLS (Compatibility mode) can't carry the original codec (often G711) at all. Each
    // protocol picks whichever of these two tracks it actually supports and ignores the
    // other - the same way MediaMTX already silently skips incompatible tracks per protocol.
    '-c:a:0', 'copy',
    // Track 1 (AAC, for HLS/Compatibility mode) gets an async resampler. Some cameras
    // send audio with jittery, occasionally-backward RTP timestamps (logged as "Queue
    // input is backward in time"); fed straight to the AAC encoder that poisons the HLS
    // muxer's timeline and shows up as "No signal" in Compatibility mode. aresample with
    // async=1 rebuilds a continuous, monotonic output clock - padding gaps with silence
    // and absorbing backward jumps - so HLS stays playable through the camera's audio
    // glitches. This is a camera-side fault (see KNOWN-ISSUES.md); this just stops it
    // taking Compatibility mode down with it. Only track 1 - the WebRTC copy track (a:0)
    // can't be filtered and tolerates the jitter anyway.
    '-filter:a:1', 'aresample=async=1:first_pts=0',
    '-c:a:1', 'aac', '-b:a:1', '64k', '-ar:1', '48000',
    '-avoid_negative_ts', 'make_zero',
    '-f', 'rtsp',
    '-rtsp_transport', 'tcp',
    `rtsp://127.0.0.1:8554/${mediamtxPath}`,
  ];

  // Second output: an AUDIO-ONLY AAC stream to the sidecar path (see mediamtx.js). This is what
  // iOS Compatibility-mode background audio plays. Two reasons it's a separate stream, not the
  // main one: (1) iOS suspends any media element carrying a video track in the background, so
  // the audio has to come from a video-less stream to keep playing; (2) HLS segments the main
  // stream on the camera's (often irregular) video keyframes, which makes iOS stutter - an
  // audio-only stream segments on a regular cadence instead, so it's smooth. Same aresample as
  // track 1 to absorb the camera's audio-clock jitter.
  //
  // Only added when the camera actually has an audio track (has_audio, from the RTSP probe -
  // see rtspProbe.js / db.js). An audio-only output for a camera with no audio would contain no
  // streams, which fails the entire FFmpeg command and would take the video output down with it.
  if (hasAudio) {
    args.push(
      '-map', '0:a:0?',
      '-filter:a', 'aresample=async=1:first_pts=0',
      '-c:a', 'aac', '-b:a', '64k', '-ar', '48000',
      '-avoid_negative_ts', 'make_zero',
      '-f', 'rtsp',
      '-rtsp_transport', 'tcp',
      `rtsp://127.0.0.1:8554/${audioPathName(mediamtxPath)}`,
    );
  }

  return args;
}

export function isRunning(cameraId) {
  return processes.has(cameraId);
}

export async function startTranscoder(cameraId, rtspUrl, mediamtxPath, cameraName = mediamtxPath, hasAudio = true) {
  // Wait for any previous process for this camera to actually be gone before
  // starting a new one - previously this fired stop and start back-to-back, which
  // left a real window where the old FFmpeg process was still holding the MediaMTX
  // publish connection when the new one tried to claim the same path. That collision
  // could leave MediaMTX's own state for the path confused well beyond just this one
  // restart, causing repeated "broken pipe" failures rather than a single clean blip.
  await stopTranscoder(cameraId);

  function launch() {
    const proc = spawn('ffmpeg', buildArgs(rtspUrl, mediamtxPath, hasAudio), { stdio: ['ignore', 'ignore', 'pipe'] });
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