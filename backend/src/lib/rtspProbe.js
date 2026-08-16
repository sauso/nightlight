import { spawn } from 'child_process';

// Quick "does this RTSP URL actually work?" check, used to validate a camera before saving
// it (catches wrong credentials, wrong path, unreachable IP up front instead of silently
// storing a dead camera). Runs ffprobe over TCP with a short timeout and reports whether it
// saw any media, plus a concise reason on failure.

const OVERALL_TIMEOUT_MS = 8000;
const DETAILED_TIMEOUT_MS = 12000;

// The single ffprobe version line, e.g. "ffprobe version 6.1 ...", for the camera report. Best-effort.
export function ffprobeVersion() {
  return new Promise((resolve) => {
    try {
      const proc = spawn('ffprobe', ['-hide_banner', '-version'], { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      proc.stdout.on('data', (d) => (out += d.toString()));
      const killer = setTimeout(() => proc.kill('SIGKILL'), 3000);
      proc.on('error', () => { clearTimeout(killer); resolve(null); });
      proc.on('exit', () => { clearTimeout(killer); resolve((out.split('\n')[0] || '').trim() || null); });
    } catch {
      resolve(null);
    }
  });
}

// Full stream/codec dump of an RTSP URL for the "unsupported camera" report — the details needed to
// add support (video codec/profile/resolution/pixel format, audio codec/sample-rate/channels). Never
// throws; on failure returns { ok:false, error, stderr } with the last ffprobe error lines.
export function probeRtspDetailed(rtspUrl) {
  return new Promise((resolve) => {
    const args = [
      '-v', 'error',
      '-rtsp_transport', 'tcp',
      '-rw_timeout', '8000000',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      '-i', rtspUrl,
    ];
    let proc;
    try {
      proc = spawn('ffprobe', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolve({ ok: false, error: 'Could not run ffprobe' });
      return;
    }
    let out = '';
    let err = '';
    let timedOut = false;
    proc.stdout.on('data', (d) => (out += d.toString()));
    proc.stderr.on('data', (d) => (err += d.toString()));
    const killer = setTimeout(() => { timedOut = true; proc.kill('SIGKILL'); }, DETAILED_TIMEOUT_MS);
    proc.on('error', () => { clearTimeout(killer); resolve({ ok: false, error: 'Could not run ffprobe' }); });
    proc.on('exit', (code) => {
      clearTimeout(killer);
      let parsed = null;
      try { parsed = JSON.parse(out); } catch { /* not JSON */ }
      if (code === 0 && parsed && Array.isArray(parsed.streams)) {
        resolve({
          ok: true,
          format: parsed.format
            ? { format_name: parsed.format.format_name, nb_streams: parsed.format.nb_streams, probe_score: parsed.format.probe_score }
            : null,
          streams: parsed.streams.map((s) => ({
            index: s.index,
            codec_type: s.codec_type,
            codec_name: s.codec_name,
            codec_long_name: s.codec_long_name,
            profile: s.profile,
            width: s.width,
            height: s.height,
            pix_fmt: s.pix_fmt,
            avg_frame_rate: s.avg_frame_rate,
            sample_rate: s.sample_rate,
            channels: s.channels,
            channel_layout: s.channel_layout,
            bit_rate: s.bit_rate,
          })),
        });
      } else {
        const lines = err.split('\n').map((l) => l.trim()).filter(Boolean);
        // A timeout kills ffprobe with SIGKILL, so `code` is null — report that as a reachability
        // problem rather than the meaningless "ffprobe exited null".
        const error = timedOut
          ? `Timed out after ${DETAILED_TIMEOUT_MS / 1000}s — no response from the camera (wrong IP/port, offline, or blocked by a firewall)`
          : (lines[lines.length - 1] || `ffprobe exited ${code}`);
        resolve({ ok: false, error, stderr: lines.slice(-8) });
      }
    });
  });
}

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
