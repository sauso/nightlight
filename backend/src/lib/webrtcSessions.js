import { MEDIAMTX_API } from './mediamtx.js';

// Who owns each live WHEP viewing session — MediaMTX's own webrtc-session uuid mapped to the
// Nightlight login session (sessions.id) that started it. See routes/auth.js / index.js's own
// comments for why this exists: revoking a login session must also close any camera view it
// already had open, and MediaMTX has no idea any of that happened.
//
// In-memory, not persisted — the SAME convention index.js already uses for its watchdog state
// (notReadySince, audioStallCounts): a MediaMTX restart drops all its own live sessions anyway, so
// there is nothing to remember across one; a BACKEND restart's only real cost is forgetting the
// mapping for sessions MediaMTX (a longer-lived sibling process in the same container) kept open
// through it — those are simply left alone afterward (see sessionsToKick's "no owner recorded"
// case) rather than guessed at or force-closed.
export const webrtcSessionOwners = new Map();

// Reads the id MediaMTX itself assigns a session — NOT the WHEP "secret" our proxy already handles
// via the Location header (backend/src/index.js's keepUnderPrefix), which is a DIFFERENT value. The
// admin API that can actually terminate a session (kickWebrtcSession below) only recognizes this
// one, and MediaMTX conveniently returns it as the `ID` response header on the same WHEP-start POST
// response that carries Location — so this reads it from the exact same place, at zero extra cost.
//
// Only a POST can start a session (a DELETE's response carries no such header, and nothing needs
// recording on cleanup — the mapping is pruned for us, see sessionsToKick's `stale` return). Called
// from a proxyRes hook, so it runs entirely server-side on MediaMTX's own response: a client has no
// way to influence what gets recorded here.
//
// recordedAt exists ONLY so sessionsToKick can tell "genuinely ended" apart from "opened while a
// list fetch was already in flight" — see sessionsToKick's own comment for the race this closes
// (found by adversarial review, reproduced against a real delayed response: a session recorded
// during listWebrtcSessions()'s round trip is absent from that snapshot through no fault of its
// own, and pruning it anyway would strip its owner forever — sessionsToKick's "no owner -> never
// kick" rule above would then make that live session permanently unrevokable).
export function recordWebrtcSessionOwner(proxyRes, req) {
  if (req.method.toUpperCase() !== 'POST') return;
  const id = proxyRes.headers['id'];
  if (!id) return;
  webrtcSessionOwners.set(id, { sid: req.user.sid, recordedAt: Date.now() });
}

const FETCH_TIMEOUT_MS = 5000;

// Every session MediaMTX currently has open, across every camera. Paginated per MediaMTX's own API
// (default 100/page, comfortably above any real household's concurrent viewer count, but looped
// anyway since it costs almost nothing extra).
//
// Deliberately THROWS rather than swallowing a failure to an empty array (contrast
// mediamtx.js's getPathStatus(), which is right to swallow for a watchdog — "unknown" and "not
// ready" call for the same fallback there). Here, "MediaMTX is unreachable" and "there is nothing
// to enforce" must never look identical: the caller (index.js's reconciliation sweep) needs to see
// the failure to report it loudly, not silently do nothing for however long the outage lasts.
export async function listWebrtcSessions() {
  const items = [];
  let page = 0;
  for (;;) {
    const res = await fetch(`${MEDIAMTX_API}/v3/webrtc/sessions/list?page=${page}&itemsPerPage=100`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`MediaMTX webrtc session list failed (${res.status}): ${text}`);
    }
    const data = await res.json();
    items.push(...(data.items || []));
    page += 1;
    if (page >= (data.pageCount || 1)) break;
  }
  return items;
}

// Ends one MediaMTX webrtc session immediately. A 404 (already gone by the time this runs - the
// viewer may have simply closed the tab in the meantime) is fine, matching mediamtx.js's
// removePath() treating the same case as success rather than an error.
export async function kickWebrtcSession(id) {
  const res = await fetch(`${MEDIAMTX_API}/v3/webrtc/sessions/kick/${id}`, {
    method: 'POST',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok && res.status !== 404) {
    const text = await res.text().catch(() => '');
    throw new Error(`MediaMTX failed to kick webrtc session (${res.status}): ${text}`);
  }
}

// Pure and dependency-injected - no fetch, no DB, no Map mutation - so the actual decision (which
// sessions get closed) is testable on its own. `ownerMap` is webrtcSessionOwners (or a fake of the
// same shape in a test); `isLiveSessionId(sid)` answers whether a login session is still valid
// (exists AND within its own absolute token lifetime - see routes/auth.js's SESSION_TOKEN_TTL_DAYS
// and lib/push.js's identical reasoning for the same class of gap). `listStartedAt` is a `Date.now()`
// captured by the CALLER before it asked MediaMTX for `mediamtxSessions` - see below for why.
//
// A MediaMTX session with NO recorded owner is never kicked - it could be one that started before a
// backend restart (see webrtcSessionOwners's own comment), and kicking something we can't positively
// attribute to a revoked session would be closing a legitimate view on a guess.
//
// ⚠️ `stale` must NOT simply be "every owner-map entry absent from mediamtxSessions" - found by
// adversarial review, reproduced against a real delayed response. listWebrtcSessions() is a network
// round trip; a session can open and get recorded WHILE it's in flight, meaning it's absent from a
// snapshot that was already being assembled before it existed - not because it ended. Pruning that
// entry as "stale" would strip its owner forever, and the "no owner -> never kick" rule above would
// then treat that live, revocable session as permanently unattributable - the fix silently defeating
// its own purpose for exactly the newest views, the ones most likely to still be watched. So an
// entry only counts as stale if it was recorded BEFORE the list fetch started: anything newer simply
// isn't old enough for this snapshot to have known about, and is left alone for the NEXT sweep - at
// most one extra tick's delay, not a security gap, since toKick above is unaffected by this race
// (it only ever judges sessions MediaMTX is reporting as open RIGHT NOW).
export function sessionsToKick(mediamtxSessions, ownerMap, isLiveSessionId, listStartedAt) {
  const seenIds = new Set();
  const toKick = [];
  for (const session of mediamtxSessions) {
    seenIds.add(session.id);
    const owner = ownerMap.get(session.id);
    if (!owner) continue;
    if (!isLiveSessionId(owner.sid)) toKick.push({ id: session.id, path: session.path });
  }
  const stale = [...ownerMap.entries()]
    .filter(([id, owner]) => !seenIds.has(id) && owner.recordedAt < listStartedAt)
    .map(([id]) => id);
  return { toKick, stale };
}
