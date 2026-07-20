import { spawn } from 'child_process';
import { logger } from './logger.js';

let proc = null;
let stopped = false;

const RESTART_DELAY_MS = 3000;

function forwardLines(chunk, onLine) {
  chunk
    .toString()
    .split('\n')
    .filter((line) => line.length > 0)
    .forEach(onLine);
}

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

    // Both streams piped (not 'ignore'/'inherit') so every line can be forwarded
    // through our own logger - this is what makes MediaMTX's output show up in both
    // `docker logs` and the in-app log viewer, rather than being silently discarded.
    proc = spawn('mediamtx', [configPath], { stdio: ['ignore', 'pipe', 'pipe'], env });

    let lastLine = '';
    proc.stdout.on('data', (chunk) => {
      forwardLines(chunk, (line) => {
        lastLine = line;
        logger.raw('mediamtx', line);
      });
    });
    proc.stderr.on('data', (chunk) => {
      forwardLines(chunk, (line) => {
        lastLine = line;
        logger.raw('mediamtx', line);
      });
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
