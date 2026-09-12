import { logger } from './logger.js';
import { verifyToken } from '../middleware/auth.js';
import { startTalkSession } from './twoWayAudio.js';

// The client-facing half of two-way audio: owns one open talk WebSocket's lifecycle (audio
// forwarding, camera-session start/stop, and — see below — staying authorized for as long as the
// socket stays open). Split out of index.js (which wires the actual `server.on('upgrade', ...)`
// handshake, since that needs the real HTTP server/WebSocketServer instances) so this can be
// imported and tested directly — index.js has import-time side effects every test avoids
// triggering, same reason clipCapture.js's reconcileClipRing was pulled out (see its own comment).

// How often an open connection re-checks that its token/session is still valid. Only the upgrade
// handshake was ever checked before this existed — an open WebSocket forwarded audio forever
// regardless of what happened to the session or account behind it. Short enough that revoking a
// caregiver (logout, account deletion, or the media token's own natural expiry) takes effect on an
// ALREADY-OPEN talk connection within a bounded, human-noticeable window rather than "whenever the
// socket happens to close on its own" — which for a live audio channel into a child's room could be
// indefinitely. Exported so a test can advance a mocked clock by exactly this much rather than an
// arbitrary "long enough" guess.
export const TALK_REVALIDATE_MS = 15_000;

export async function handleTalkConnection(ws, camera, user, token) {
  let session = null;
  let closed = false;
  let bytes = 0;
  let revalidateTimer = null;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (revalidateTimer) clearInterval(revalidateTimer);
    logger.info(`[talk] session ended for "${camera.name}" (${bytes} audio bytes forwarded)`);
    try { session?.close(); } catch { /* ignore */ }
    try { ws.close(); } catch { /* ignore */ }
  };

  // The one fix this module exists for: re-run the SAME check the handshake used, against the SAME
  // token, on a timer. Covers all three ways access can stop being valid mid-call — the session row
  // being deleted (logout, an admin revoking that device), the user row being deleted (liveSession's
  // join fails the same way), and the media token's own JWT expiry — via the one function that
  // already knows how to check all three, rather than reimplementing any of it here.
  revalidateTimer = setInterval(() => {
    if (!verifyToken(token, { purpose: 'media' })) {
      logger.info(`[talk] access for "${camera.name}" was revoked mid-call — closing`);
      cleanup();
    }
  }, TALK_REVALIDATE_MS);
  revalidateTimer.unref?.();

  // Register the audio handler before the (async) session start so nothing races; audio arriving
  // before the session is up is simply dropped (the client waits for our 'ready' before sending).
  let sampled = false;
  ws.on('message', (data, isBinary) => {
    // Once cleanup has run (revoked mid-call, or any other teardown), never forward another frame —
    // don't rely on the underlying WebSocket library's own close semantics to stop 'message' events
    // promptly. This is the actual enforcement point for the revalidation timer above: without it, a
    // frame already in flight (or queued) at the moment cleanup fires would still reach the camera.
    if (closed) return;
    if (!isBinary) return;
    if (!sampled) {
      sampled = true;
      const b = Buffer.from(data);
      // mu-law silence is ~0xff/0x7f; varied bytes here mean real captured audio.
      logger.info(`[talk] first audio bytes for "${camera.name}": ${b.slice(0, 12).toString('hex')}`);
    }
    bytes += data.length;
    session?.write(data);
  });
  ws.on('close', cleanup);
  ws.on('error', cleanup);
  try {
    session = await startTalkSession(camera);
    if (closed) { session.close(); return; } // client hung up during startup
    logger.info(`[talk] session started for "${camera.name}" by ${user.username || 'user'}`);
    ws.send(JSON.stringify({ type: 'ready' }));
  } catch (e) {
    logger.error(`[talk] failed to start for "${camera.name}": ${e.message}`);
    try { ws.send(JSON.stringify({ type: 'error', error: e.message })); } catch { /* ignore */ }
    cleanup();
  }
}
