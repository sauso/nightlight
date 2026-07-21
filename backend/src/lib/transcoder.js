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
    // This camera occasionally emits one garbage DTS value right at session start
    // (observed: a single packet jumping to ~4.28 billion, near the 32-bit rollover
    // point - a firmware bug in the camera itself). genpts alone still anchors off
    // that corrupted value, poisoning the entire session's timeline for hours.
    // igndts makes ffmpeg disregard the source's DTS field entirely and synthesize
    // its own clean, monotonic timeline from frame order instead - so one bad
    // timestamp from the camera can't derail everything downstream of it.
    // discardcorrupt drops packets ffmpeg already knows are corrupt outright.
    '-fflags', '+genpts+igndts+discardcorrupt',
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
    proc.stderr.on('data', (chunk) => {
      chunk
        .toString()
        .split('\n')
        .filter((line) => line.length > 0)
        .forEach((line) => {
          lastLine = line;
          logger.raw(`ffmpeg:${mediamtxPath}`, line);
        });
    });

    proc.on('exit', (code) => {
      if (processes.get(cameraId) === entry) processes.delete(cameraId);
      if (!entry.stopped) {
        logger.error(
          `[ffmpeg:${mediamtxPath}] exited (code ${code}), restarting in 5s. Last output: ${lastLine}`
        );
        setTimeout(() => {
          if (!entry.stopped) launch();
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