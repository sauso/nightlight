import { spawn } from 'child_process';
import { logger } from './logger.js';

// Grab a single JPEG frame from an already-published MediaMTX path (the same local stream the
// detector/viewer use, so no extra hit on the camera). Used to attach the triggering frame to a
// motion notification, and reusable for a future snapshot endpoint / crib-zone picker.
//
// Best-effort: resolves to a JPEG Buffer, or null on any failure/timeout (a missing snapshot must
// never block or break detection). One-shot ffmpeg, killed if it overruns.
export function captureSnapshot(pathName, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(val);
    };

    const args = [
      '-nostdin',
      '-loglevel', 'error',
      '-rtsp_transport', 'tcp',
      '-i', `rtsp://127.0.0.1:8554/${pathName}`,
      '-frames:v', '1',
      '-q:v', '4', // JPEG quality (2=best..31=worst); 4 is a good small-but-clear thumbnail
      '-f', 'image2',
      '-',
    ];
    let proc;
    try {
      proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      logger.error('[snapshot] spawn failed:', e.message);
      return finish(null);
    }

    const chunks = [];
    proc.stdout.on('data', (c) => chunks.push(c));
    proc.stderr.on('data', () => {}); // swallow; failure surfaces via empty output / non-zero exit
    proc.on('error', () => finish(null));
    proc.on('exit', (code) => {
      const buf = chunks.length ? Buffer.concat(chunks) : null;
      finish(code === 0 && buf && buf.length ? buf : null);
    });

    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* already gone */ }
      finish(null);
    }, timeoutMs);
  });
}
