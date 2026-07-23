import { spawn } from 'child_process';
import { logger } from './logger.js';

// camera_id -> { proc, stopped }
const processes = new Map();

const RESTART_DELAY_MS = 5000;
// If SIGTERM hasn't actually stopped the process within this long, escalate to
// SIGKILL rather than wait indefinitely - a stuck FFmpeg process should never be
// able to block a restart forever.
const FORCE_KILL_TIMEOUT_MS = 3000;

function buildArgs(rtspUrl, mediamtxPath) {
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
    '-c:a:1', 'aac', '-b:a:1', '64k', '-ar:1', '48000',
    '-avoid_negative_ts', 'make_zero',
    '-f', 'rtsp',
    '-rtsp_transport', 'tcp',
    `rtsp://127.0.0.1:8554/${mediamtxPath}`,
  ];
}

export function isRunning(cameraId) {
  return processes.has(cameraId);
}

export async function startTranscoder(cameraId, rtspUrl, mediamtxPath) {
  // Wait for any previous process for this camera to actually be gone before
  // starting a new one - previously this fired stop and start back-to-back, which
  // left a real window where the old FFmpeg process was still holding the MediaMTX
  // publish connection when the new one tried to claim the same path. That collision
  // could leave MediaMTX's own state for the path confused well beyond just this one
  // restart, causing repeated "broken pipe" failures rather than a single clean blip.
  await stopTranscoder(cameraId);

  function launch() {
    const proc = spawn('ffmpeg', buildArgs(rtspUrl, mediamtxPath), { stdio: ['ignore', 'ignore', 'pipe'] });
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