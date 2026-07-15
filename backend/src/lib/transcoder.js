import { spawn } from 'child_process';
import { logger } from './logger.js';

// camera_id -> { proc, stopped }
const processes = new Map();

const RESTART_DELAY_MS = 5000;

function buildArgs(rtspUrl, mediamtxPath) {
  return [
    '-nostdin',
    '-loglevel', 'warning',
    '-rtsp_transport', 'tcp',
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
    '-f', 'rtsp',
    '-rtsp_transport', 'tcp',
    `rtsp://127.0.0.1:8554/${mediamtxPath}`,
  ];
}

export function isRunning(cameraId) {
  return processes.has(cameraId);
}

export function startTranscoder(cameraId, rtspUrl, mediamtxPath) {
  stopTranscoder(cameraId); // clean up any previous process for this camera first

  function launch() {
    const proc = spawn('ffmpeg', buildArgs(rtspUrl, mediamtxPath), { stdio: ['ignore', 'ignore', 'pipe'] });
    const entry = { proc, stopped: false };
    processes.set(cameraId, entry);

    let lastLine = '';
    proc.stderr.on('data', (chunk) => {
      const lines = chunk.toString().trim().split('\n');
      if (lines.length) lastLine = lines[lines.length - 1];
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
  if (entry) {
    entry.stopped = true;
    entry.proc.kill('SIGTERM');
    processes.delete(cameraId);
  }
}

export function stopAllTranscoders() {
  for (const cameraId of [...processes.keys()]) stopTranscoder(cameraId);
}
