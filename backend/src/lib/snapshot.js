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
// motion notification, and reusable for a future snapshot endpoint / bed-zone picker.
//
// Best-effort: resolves to a JPEG Buffer, or null on any failure/timeout (a missing snapshot must
// never block or break detection). One-shot ffmpeg, killed if it overruns.
//
// The slow part is that decoding the first frame needs a keyframe (IDR): after connecting, ffmpeg
// must wait for the camera's next keyframe, so a long GOP can push a grab past a tight timeout
// (seen intermittently on some cameras). We minimise the OTHER latencies so nearly all of the
// budget goes to that unavoidable wait — trim probe/analyze buffering and don't add jitter buffer —
// and give the wait a more forgiving 8s ceiling. On the rare miss the caller just sends text-only.
//
// `onExit` (optional, #552 review B9) is called exactly once, when no ffmpeg from this call is left
// running: from the child's 'exit', or from a spawn that failed. It is NOT the same moment as the promise
// settling: on a timeout the promise resolves null right after SIGKILL, and the child's 'exit' comes
// later (usually milliseconds; for a process stuck in the kernel, possibly never). grabLiveFrame below
// needs the later moment to cap how many of these run at once. The detection callers (alerts, bed
// transitions, timelapse) do not pass it, and for them nothing changes.
export function captureSnapshot(pathName, { timeoutMs = 8000, onExit } = {}) {
  return new Promise((resolve) => {
    let done = false;
    // Declared before anything can call finish(). It used to be a `const` at the bottom of this
    // executor, so a spawn() that THREW (below) reached clearTimeout(timer) inside the temporal dead
    // zone: a ReferenceError, which made this "never throws" promise reject (#552, found while adding
    // onExit; the snapshot-single-flight test pins it).
    let timer;
    const finish = (val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(val);
    };
    let exited = false;
    const exitOnce = () => {
      if (exited) return;
      exited = true;
      onExit?.();
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
      exitOnce(); // nothing was started, so nothing is left running
      return finish(null);
    }

    const chunks = [];
    proc.stdout.on('data', (c) => chunks.push(c));
    proc.stderr.on('data', () => {}); // swallow; failure surfaces via empty output / non-zero exit
    proc.on('error', () => {
      // An 'error' is not always the end of the process. A spawn that failed (ffmpeg missing: ENOENT)
      // emits 'error' with no pid and then never 'exit' (measured on Node 24: 'error' then 'close'), so
      // that is where it ends. But Node also emits 'error' when kill() fails on a child that is still
      // RUNNING; reporting an exit then would let a second ffmpeg start beside a live one. So: no pid
      // means it never started; otherwise wait for 'exit' (or 'close', below).
      if (proc.pid === undefined) exitOnce();
      finish(null);
    });
    proc.on('exit', (code) => {
      exitOnce();
      const buf = chunks.length ? Buffer.concat(chunks) : null;
      finish(code === 0 && buf && buf.length ? buf : null);
    });
    // Fallback (#552, PR #665 review): Node emits 'close' only once the child has ended and its pipes have
    // closed, after 'exit' when there was one. So 'close' is a safe last word that nothing is left running,
    // and it covers an end we did not hear as 'exit' (an 'error' from a failed kill, then the child ends).
    // Without it such a camera would stay held until restart. exitOnce makes the usual 'exit' then 'close'
    // count once.
    proc.on('close', exitOnce);

    timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* already gone */ }
      finish(null);
    }, timeoutMs);
  });
}

// The live still frame (GET /api/cameras/:id/snapshot, the picture behind the bed-zone picker): ONE grab
// per camera at a time (#552).
//
// WHY. That route is open to every signed-in viewer (it takes a media token), and each request used to
// start its own grab: an HTTP fetch from the camera, then, if that failed or none is set, a one-shot
// ffmpeg of up to 8 s. A page reloaded in a loop, or a few people opening the zone editor at once, stacked
// one ffmpeg per request on the server and one more RTSP reader per request on MediaMTX. Now a request
// that arrives while a grab for the SAME camera is under way waits for that grab and gets its result: the
// same picture, or null, which each caller turns into its own 503. On a slow camera that means the second
// person waits for the first person's grab instead of starting a second one.
//
// WHY NO GLOBAL CEILING. With one grab per camera, the number running at once is at most the number of
// cameras, and only an admin can add a camera. A fixed cap across cameras would be a number nobody has
// measured, so there is none.
//
// HOW LONG A FLIGHT LASTS: until no ffmpeg from it is left running, not merely until its answer is known
// (#552 review B9). On a timeout captureSnapshot resolves null right after SIGKILL, before the child's
// 'exit'; releasing the camera then would let the next request start a second ffmpeg beside one that is
// still dying. So a flight ends when BOTH have happened: its result has settled and, if an ffmpeg ran,
// that ffmpeg has exited (captureSnapshot's onExit). In between, a request gets the settled result and
// starts nothing.
//
// KNOWN LIMIT (documented in KNOWN-ISSUES.md). An ffmpeg that never exits after SIGKILL (stuck in the
// kernel; not seen here) keeps its camera's flight open for good, so that camera's still frame answers
// 503 until the app restarts. It is logged once per flight, the first time a request is turned away by
// it. Alerts, bed-transition frames and timelapse frames do not come through here (they call the
// grabbers directly), so they are unaffected.
//
// Keyed by camera id, so two cameras never share a frame. A flight uses the camera row of the request
// that started it: a request arriving mid-flight gets that grab's frame even if an admin has just changed
// the camera's snapshot address (a flight lasts at most about 13 s: 5 s HTTP plus 8 s ffmpeg).
//
// `fetchHttp` and `capture` are injectable for tests only; the route passes neither.
const liveFrameFlights = new Map();

export function grabLiveFrame(cam, { fetchHttp = fetchHttpSnapshot, capture = captureSnapshot } = {}) {
  const key = cam.id;
  const current = liveFrameFlights.get(key);
  if (current) {
    if (current.settled && !current.exited && !current.warned) {
      current.warned = true;
      logger.warn(
        `[snapshot] still frame for "${cam.name}": the last ffmpeg grab was stopped but has not exited yet, ` +
          'so requests get its result (no frame) instead of starting another grab. If it never exits, ' +
          "this camera's still frame stays unavailable until the app restarts."
      );
    }
    return current.promise;
  }

  // `exited` starts true because nothing is running until a capture starts; an HTTP-only flight
  // therefore ends as soon as its result settles.
  const flight = { promise: null, settled: false, exited: true, warned: false };
  liveFrameFlights.set(key, flight);
  // The identity check matters: a late onExit (or a second one, from an injected capture) of a flight
  // that has already ended must not end the NEWER flight now registered under the same camera.
  const release = () => {
    if (flight.settled && flight.exited && liveFrameFlights.get(key) === flight) liveFrameFlights.delete(key);
  };
  const onExit = () => {
    flight.exited = true;
    release();
  };
  flight.promise = (async () => {
    let img = null;
    if (cam.snapshot_url && String(cam.snapshot_url).trim()) {
      try {
        img = await fetchHttp(cam.snapshot_url);
      } catch {
        img = null;
      }
    }
    if (!img) {
      flight.exited = false;
      try {
        img = await capture(cam.mediamtx_path, { onExit });
      } catch {
        // captureSnapshot never rejects, so this is an injected capture breaking its contract. Treat it
        // as "nothing left running": the other choice, waiting for an onExit that may never come, would
        // turn one bad grab into a camera whose still frame is 503 until restart.
        img = null;
        onExit();
      }
    }
    return img || null;
  })().then((img) => {
    flight.settled = true;
    release();
    return img;
  });
  return flight.promise;
}
