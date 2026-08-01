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
        // `out` is one codec_type per line (e.g. "video\naudio"). Report whether an audio track
        // is present so the caller can record has_audio and gate the audio-only sidecar output.
        resolve({ ok: true, hasAudio: /audio/i.test(out) });
        return;
      }
      // Surface the most useful line of ffprobe's error output (e.g. "401 Unauthorized",
      // "Connection refused", "Connection timed out"), trimmed of the noisy URL prefix.
      const lines = err.split('\n').map((l) => l.trim()).filter(Boolean);
      const reason =
        lines.find((l) => /unauthor|401|refused|timed out|not found|404|no route|host/i.test(l)) ||
        lines[lines.length - 1] ||
        'Could not connect to the stream';
      // Strip ffmpeg's noise: a leading "[rtsp @ 0x...] " tag and any URL prefix, so the
      // message reads like "method DESCRIBE failed: 401 (Unauthorized)".
      const clean = reason
        .replace(/^\[[^\]]*\]\s*/, '')
        .replace(/^rtsps?:\/\/\S+:\s*/i, '')
        .trim();
      resolve({ ok: false, error: clean || 'Could not connect to the stream' });
    });
  });
}
