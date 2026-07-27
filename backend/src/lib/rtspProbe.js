import { spawn } from 'child_process';

// Quick "does this RTSP URL actually work?" check, used to validate a camera before saving
// it (catches wrong credentials, wrong path, unreachable IP up front instead of silently
// storing a dead camera). Runs ffprobe over TCP with a short timeout and reports whether it
// saw any media, plus a concise reason on failure.

const OVERALL_TIMEOUT_MS = 8000;

export function validateRtspStream(rtspUrl) {
  return new Promise((resolve) => {
    const args = [
      '-v', 'error',
      '-rtsp_transport', 'tcp',
      '-rw_timeout', '6000000', // 6s socket I/O timeout (microseconds)
      '-i', rtspUrl,
      '-show_entries', 'stream=codec_type',
      '-of', 'csv=p=0',
    ];
    let proc;
    try {
      proc = spawn('ffprobe', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolve({ ok: false, error: 'Could not run stream validation' });
      return;
    }
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => (out += d.toString()));
    proc.stderr.on('data', (d) => (err += d.toString()));
    const killer = setTimeout(() => proc.kill('SIGKILL'), OVERALL_TIMEOUT_MS);

    proc.on('error', () => {
      clearTimeout(killer);
      resolve({ ok: false, error: 'Could not run stream validation' });
    });
    proc.on('exit', (code) => {
      clearTimeout(killer);
      if (code === 0 && /(video|audio)/i.test(out)) {
        resolve({ ok: true });
        return;
      }
      // Surface the most useful line of ffprobe's error output (e.g. "401 Unauthorized",
      // "Connection refused", "Connection timed out"), trimmed of the noisy URL prefix.
      const lines = err.split('\n').map((l) => l.trim()).filter(Boolean);
      const reason =
        lines.find((l) => /unauthor|401|refused|timed out|not found|404|no route|host/i.test(l)) ||
        lines[lines.length - 1] ||
        'Could not connect to the stream';
      resolve({ ok: false, error: reason.replace(/^rtsps?:\/\/\S+:\s*/i, '') });
    });
  });
}
