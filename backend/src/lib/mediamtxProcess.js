import { spawn } from 'child_process';
import { logger } from './logger.js';

let proc = null;
let stopped = false;

const RESTART_DELAY_MS = 3000;

// Manages the MediaMTX binary as a child process of this app - same restart-on-exit
// pattern as transcoder.js uses for FFmpeg. Combining the two into one image means
// this app is now responsible for both, rather than Docker/compose supervising two
// separate containers.
export function startMediaMTX(configPath) {
  function launch() {
    // MediaMTX reads its own env-var overrides (like MTX_WEBRTCADDITIONALHOSTS) from
    // whatever process spawns it. Translate our friendlier PUBLIC_HOST name into
    // MediaMTX's own expected variable here, since it's a child process now rather
    // than a separate container Compose could inject that into directly.
    const env = { ...process.env };
    if (process.env.PUBLIC_HOST) {
      env.MTX_WEBRTCADDITIONALHOSTS = process.env.PUBLIC_HOST;
    }

    proc = spawn('mediamtx', [configPath], { stdio: ['ignore', 'ignore', 'pipe'], env });

    let lastLine = '';
    proc.stderr.on('data', (chunk) => {
      const lines = chunk.toString().trim().split('\n');
      if (lines.length) lastLine = lines[lines.length - 1];
    });

    proc.on('exit', (code) => {
      if (!stopped) {
        logger.error(
          `[mediamtx] exited (code ${code}), restarting in ${RESTART_DELAY_MS / 1000}s. Last output: ${lastLine}`
        );
        setTimeout(() => {
          if (!stopped) launch();
        }, RESTART_DELAY_MS);
      }
    });
  }

  launch();
}

export function stopMediaMTX() {
  stopped = true;
  if (proc) proc.kill('SIGTERM');
}
