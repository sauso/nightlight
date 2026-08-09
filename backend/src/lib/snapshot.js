import { spawn } from 'child_process';
import { logger } from './logger.js';

// Fetch a JPEG straight from a camera's own HTTP snapshot endpoint (thingino, sonoff-hack, and most
// IP cameras expose one). Preferred over the ffmpeg stream grab when configured: it returns a full
// frame instantly with no keyframe wait. Best-effort — resolves to a Buffer or null, never throws.
// Supports HTTP Basic auth embedded in the URL (http://user:pass@host/...), which WHATWG fetch
// rejects if left in the URL, so we strip the credentials into an Authorization header. Digest auth
// is not supported (use a snapshot URL that accepts Basic or no auth).
export async function fetchHttpSnapshot(rawUrl, { timeoutMs = 5000 } = {}) {
  let url;
  try {
    url = new URL(String(rawUrl).trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const headers = {};
  if (url.username || url.password) {
    const creds = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
    headers.Authorization = `Basic ${Buffer.from(creds).toString('base64')}`;
    url.username = '';
    url.password = '';
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok) {
      logger.info(`[snapshot] camera URL returned HTTP ${res.status}`);
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length ? buf : null;
  } catch (e) {
    logger.info(`[snapshot] camera URL fetch failed: ${e.name === 'AbortError' ? 'timed out' : e.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Grab a single JPEG frame from an already-published MediaMTX path (the same local stream the
// detector/viewer use, so no extra hit on the camera). Used to attach the triggering frame to a
// motion notification, and reusable for a future snapshot endpoint / crib-zone picker.
//
// Best-effort: resolves to a JPEG Buffer, or null on any failure/timeout (a missing snapshot must
// never block or break detection). One-shot ffmpeg, killed if it overruns.
//
// The slow part is that decoding the first frame needs a keyframe (IDR): after connecting, ffmpeg
// must wait for the camera's next keyframe, so a long GOP can push a grab past a tight timeout
// (seen intermittently on some cameras). We minimise the OTHER latencies so nearly all of the
// budget goes to that unavoidable wait — trim probe/analyze buffering and don't add jitter buffer —
// and give the wait a more forgiving 8s ceiling. On the rare miss the caller just sends text-only.
export function captureSnapshot(pathName, { timeoutMs = 8000 } = {}) {
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
      '-fflags', 'nobuffer', // emit the frame as soon as it decodes, don't sit on a jitter buffer
      '-analyzeduration', '2000000', // 2s: enough to identify H264(+audio); default 5s wastes budget
      '-probesize', '2000000', // 2MB: same trade-off as analyzeduration
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
