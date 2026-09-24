// Node's built-in fetch (stable since Node 18) is used here - no import needed, it's
// a global, same as console or setTimeout.
import { reportGuardFailure } from './processGuards.js';

// Host networking means MediaMTX's API is reachable on localhost from the backend container.
// Exported so lib/webrtcSessions.js can talk to the same API without a second, independent
// process.env.MEDIAMTX_API read that could silently drift from this one.
export const MEDIAMTX_API = process.env.MEDIAMTX_API || 'http://127.0.0.1:9997';

// Every call to MediaMTX's API has a deadline (issue #451). Before this the only bound was undici's own
// 300s headersTimeout/bodyTimeout, so a MediaMTX that accepted the connection and never answered held
// GET /api/cameras (which waits on every camera's status at once) and the camera watchdog for five
// minutes per call, while the watchdog stacked a new tick on top of each pending one every 15s.
//
// 5s, matching lib/webrtcSessions.js, which already bounded its calls to this same API (and is left
// untouched: it is security-adjacent, so it stays out of this change's blast radius). The API is on
// loopback in the same container and answers in milliseconds, so 5s without an answer means something
// is wrong, not slow. ⚠️ That is the assumption: an install that points MEDIAMTX_API at a MediaMTX
// across a network would need more headroom. Not configurable on purpose, because nobody has needed to
// tune it and a setting would need its own docs and range; the known limit is in KNOWN-ISSUES.md.
export const MEDIAMTX_API_TIMEOUT_MS = 5000;
let apiTimeoutMs = MEDIAMTX_API_TIMEOUT_MS;

// Test seam ONLY, like processGuards.resetGuardRateLimit: a suite proving the deadline works cannot wait
// 5s per case. Called with no argument it restores the default. Deliberately not an env var: that would
// be a user-facing setting with nothing asking for it.
export function setMediamtxApiTimeoutForTest(ms) {
  apiTimeoutMs = ms ?? MEDIAMTX_API_TIMEOUT_MS;
}

// A call MediaMTX did not answer in time. Its own class because a timeout means something different
// from every other failure here: a refused connection, a 404, a 5xx or bad JSON are all ANSWERS (nothing
// is serving that path), while a timeout is no answer at all. Callers that make decisions on MediaMTX's
// word (the watchdogs, the config check below) must be able to tell the two apart. Owner decision
// 2026-09-24: a timeout is UNKNOWN, never evidence either way.
export class MediamtxTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MediamtxTimeoutError';
  }
}

const describeMs = (ms) => (ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`);

// The one place a request to MediaMTX's API is made. Resolves `{ ok, status, text }`, never a live
// Response: the BODY is read here, inside the same abort window, because `fetch` resolves as soon as
// the headers arrive and a server can then hold the body open forever. Bounding only the headers would
// leave that read unbounded (the lesson of #262, see httpNotify.js's postWithTimeout).
async function mtxRequest(method, apiPath, body) {
  const deadline = AbortSignal.timeout(apiTimeoutMs);
  try {
    const res = await fetch(`${MEDIAMTX_API}${apiPath}`, {
      method,
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      signal: deadline,
    });
    let text = '';
    try {
      text = await res.text();
    } catch (e) {
      // ⚠️ A blanket `.catch(() => '')` here would swallow the ABORT too, turning a body that never
      // arrived into `{ ok: true, text: '' }`: bounded, but reported as an answer. (Caught in #262 for
      // the same shape.) A body lost for any other reason is still not fatal, as before #451: callers only
      // parse it, and an empty string fails that parse the way a bad body always did.
      if (deadline.aborted) throw e;
    }
    return { ok: res.ok, status: res.status, text };
  } catch (e) {
    // Keyed on the signal rather than e.name: whatever the runtime throws out of an aborted body read,
    // the reason we stopped is the same one.
    if (deadline.aborted) {
      // Not the raw "The operation was aborted due to timeout": routes surface e.message to a person
      // (camera add/edit), and that sentence tells them nothing about what did not answer.
      const err = new MediamtxTimeoutError(`MediaMTX API did not answer ${method} ${apiPath} within ${describeMs(apiTimeoutMs)}`);
      // Reported here, once, rather than by every caller: the per-label rate limit then gives one ERROR
      // line a minute however many cameras and watchdogs are waiting, instead of flooding the 1000-line
      // log ring. A refusal is NOT reported: it fails fast, and mediamtxProcess.js already logs
      // MediaMTX's exit, which is what a refusal almost always means.
      reportGuardFailure('mediamtx-api', err);
      throw err;
    }
    throw e;
  }
}

// Turn a camera ID into a safe MediaMTX path name (alphanumeric, dashes, underscores).
//
// The id, deliberately — NOT the camera's name, which this comment used to claim (issue #315).
// The path must survive a rename: it is baked into MediaMTX's config, the transcoder's publish
// target and every client's stream URL, so deriving it from an editable field would break or
// migrate a live stream every time someone corrected a typo.
//
// The sanitising replace is therefore a no-op on the only input this ever gets — its one caller
// passes a freshly generated UUID (routes/cameras.js). Keep it anyway: this value reaches a
// MediaMTX path, and the guard costs nothing.
export function toPathName(id) {
  return `cam_${id.replace(/[^a-zA-Z0-9_-]/g, '')}`;
}

// The low-quality sub-stream lives at a sibling MediaMTX path (see db.js sub_rtsp_url). A second
// transcoder leg publishes the camera's sub-stream here, so clients can pick High (the main path)
// or Low (this one) - see the "quality" selector in the frontend.
export function subPathName(pathName) {
  return `${pathName}-sub`;
}

// The Compatibility (HLS) audio lives at its OWN sibling path. MediaMTX's MPEG-TS HLS can only carry
// AAC and won't tolerate a non-AAC audio track (notably Opus) sitting alongside it on the same path —
// so instead of publishing two audio tracks to one path, the transcoder publishes the camera's own
// audio (Opus/G711, for WebRTC) to the main path and a separate AAC copy to `<path>-hls`, which the
// HLS player reads. A native-Opus camera thus keeps crisp Opus on Low latency AND works in Compatibility.
export function hlsPathName(pathName) {
  return `${pathName}-hls`;
}

// The path has no pull source — it's publisher-only. Our FFmpeg transcoder (see
// transcoder.js) pulls the camera's RTSP feed itself and publishes the (audio
// re-encoded) result straight into this path, rather than MediaMTX pulling the
// camera directly. This is what lets HLS carry audio even from cameras using G711,
// a codec HLS can't transport at all.
// Throws on any failure, a timeout included (MediamtxTimeoutError); every caller already catches.
export async function upsertPath(pathName) {
  const body = { source: 'publisher' };
  // MediaMTX: try PATCH (path exists) first, fall back to POST (create new).
  let res = await mtxRequest('PATCH', `/v3/config/paths/patch/${pathName}`, body);
  if (res.status === 404) {
    res = await mtxRequest('POST', `/v3/config/paths/add/${pathName}`, body);
  }
  if (!res.ok) {
    throw new Error(`MediaMTX rejected path config (${res.status}): ${res.text}`);
  }
}

// Checks whether a path is already correctly configured, WITHOUT changing anything.
// Important: any actual config write (upsertPath above) forces MediaMTX to reload the
// path, disconnecting whatever is currently publishing to it. This lets periodic
// reconciliation skip that disruption entirely for paths that are already fine.
//
// ⚠️ THREE-VALUED since #451, and callers must write ONLY on `=== false`:
//   true  - MediaMTX answered: configured correctly.
//   false - MediaMTX answered, and the path is missing or wrong (404, another source, an HTTP error,
//           bad JSON), or refused the connection outright. That is evidence; writing is right.
//   null  - MediaMTX did not answer in time: UNKNOWN.
// Why null is not false (Codex plan review of #451, round 2, P0): every caller used to read "not true" as
// permission to write, and a write we gave up waiting on can still be applied by MediaMTX afterwards,
// reloading the path and disconnecting a publisher that may have been working all along. That is the
// owner's "a timeout is not evidence" rule. On null the caller skips the write; the 5-minute reconcile
// asks again. test/mediamtx-api-deadline.test.js T3c holds every caller in src/ to `=== false`.
export async function isPathConfiguredCorrectly(pathName) {
  try {
    const res = await mtxRequest('GET', `/v3/config/paths/get/${pathName}`);
    if (!res.ok) return false;
    return JSON.parse(res.text).source === 'publisher';
  } catch (e) {
    if (e instanceof MediamtxTimeoutError) return null;
    return false;
  }
}

// Throws on any failure, a timeout included; every caller already catches.
export async function removePath(pathName) {
  const res = await mtxRequest('DELETE', `/v3/config/paths/delete/${pathName}`);
  // 404 just means it was already gone — fine.
  if (!res.ok && res.status !== 404) {
    throw new Error(`MediaMTX failed to remove path (${res.status}): ${res.text}`);
  }
}

// `unknown: true` is set ONLY for a timeout (#451). It is an ADDED field, so a client that reads only
// `ready` (CamerasContext.jsx) keeps working unchanged, and a refusal, a 404 or a 5xx still come back
// exactly as before: those are answers, and the watchdog must keep acting on them.
export async function getPathStatus(pathName) {
  try {
    const res = await mtxRequest('GET', `/v3/paths/get/${pathName}`);
    if (!res.ok) return { ready: false, tracks: [] };
    const data = JSON.parse(res.text);
    return { ready: !!data.ready, readers: data.readers?.length || 0, tracks: data.tracks || [] };
  } catch (e) {
    return e instanceof MediamtxTimeoutError ? { ready: false, tracks: [], unknown: true } : { ready: false, tracks: [] };
  }
}
