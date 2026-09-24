import express from 'express';
import helmet from 'helmet';
import path from 'path';
import { fileURLToPath } from 'url';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { WebSocketServer } from 'ws';
import authRoutes from './routes/auth.js';
import childrenRoutes from './routes/children.js';
import camerasRoutes from './routes/cameras.js';
import settingsRoutes from './routes/settings.js';
import manifestRoutes from './routes/manifest.js';
import logsRoutes from './routes/logs.js';
import diagnosticsRoutes from './routes/diagnostics.js';
import eventsRoutes from './routes/events.js';
import aboutRoutes from './routes/about.js';
import pushRoutes from './routes/push.js';
import pushoverRoutes from './routes/pushover.js';
import ntfyRoutes from './routes/ntfy.js';
import gotifyRoutes from './routes/gotify.js';
import notificationsRoutes from './routes/notifications.js';
import timelapsesRoutes from './routes/timelapses.js';
import recordingsRoutes from './routes/recordings.js';
import { requireAuth, requireAuthQueryOrHeader, verifyToken, SESSION_TOKEN_TTL_DAYS } from './middleware/auth.js';
import { demoGuard, demoRequestLimiter, isDemoModeActive } from './middleware/demoMode.js';
import { whepOnlyGuard } from './middleware/whepOnlyGuard.js';
import {
  recordWebrtcSessionOwner, webrtcSessionOwners, listWebrtcSessions, kickWebrtcSession, sessionsToKick,
} from './lib/webrtcSessions.js';
import { talkConfigured } from './lib/twoWayAudio.js';
import { handleTalkConnection } from './lib/talkSocket.js';
import { subConfigured, isSubRunning, startSubStream } from './lib/subStream.js';
import db from './db.js';
import { upsertPath, isPathConfiguredCorrectly } from './lib/mediamtx.js';
import { startTranscoder, stopAllTranscoders, isRunning } from './lib/transcoder.js';
import { startMotionDetector, stopMotionDetector, isDetecting, stopAllMotionDetectors, motionLegWanted } from './lib/motionDetector.js';
import { startOnvifMotion, stopOnvifMotion, isOnvifMotion, onvifMotionWanted, stopAllOnvifMotion } from './lib/onvifMotion.js';
import { startSoundDetector, isSoundDetecting, stopAllSoundDetectors } from './lib/soundDetector.js';
import { reconcileClipRing, stopAllClipCapture } from './lib/clipCapture.js';
import { stopAllRecordingsForShutdown, reconcileStaleRecordings } from './lib/recordings.js';
import { startClipStorage, stopClipStorage } from './lib/clipStorage.js';
import { initPush } from './lib/push.js';
import { startMediaMTX, stopMediaMTX } from './lib/mediamtxProcess.js';
import { refreshMqttConnection, stopMqtt } from './lib/mqttClient.js';
import { startSensorSampler, stopSensorSampler } from './lib/sensorSampler.js';
import { startActivityTracker, stopActivityTracker } from './lib/activityTracker.js';
import { startSleepJob, stopSleepJob } from './lib/sleepAnalysis.js';
import { startWakeWatcher, stopWakeWatcher } from './lib/wakeWatcher.js';
import { startTimelapseSampler, stopTimelapseSampler } from './lib/timelapse.js';
import { logger } from './lib/logger.js';
import { applyTrustProxy } from './lib/trustProxy.js';
import { safeInterval, installCrashGuards, markBootComplete } from './lib/processGuards.js';
import {
  createCameraWatchdog, createAudioWatchdog, WATCHDOG_INTERVAL_MS, AUDIO_CHECK_INTERVAL_MS,
} from './lib/cameraWatchdogs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || '/app/data';

// This lives in the image, not the data volume - MediaMTX doesn't need to persist
// camera paths itself, since the app's own reconciliation (see reconcileCameraPaths
// below) already re-establishes every camera from the database on every startup
// regardless of what state MediaMTX comes up in. Keeping this out of the data volume
// means there's no persisted copy that could ever end up stale or corrupted (this is
// exactly the class of bug that caused MediaMTX to fail to start after the single-image
// migration - an old path baked into a data-volume copy that never got updated).
const mediamtxConfigPath = path.join(__dirname, '..', 'mediamtx.yml');
startMediaMTX(mediamtxConfigPath);
refreshMqttConnection(); // no-ops if no broker is configured
startSensorSampler(); // persist MQTT temp/humidity over time (Stage-2 sleep-tracking groundwork)
startActivityTracker(); // bucket motion/sound activity per minute (Stage-2 sleep-tracking timeline)
startSleepJob(); // compute the nightly per-child sleep summary from that timeline
startWakeWatcher(); // record a short clip when a wake starts — deliberately WITHOUT alerting

// Before anything can fail: a background task that throws must not take the monitor down at 3am.
// The individual call sites are guarded too (see safeInterval, and the per-camera guard the watchdogs in
// lib/cameraWatchdogs.js get from perTargetRunner); this is the backstop for the ones nobody has thought
// of. See lib/processGuards.js for why an unattended monitor deliberately does NOT follow Node's
// exit-on-uncaught guidance.
installCrashGuards();

const app = express();

// The app is reached through a reverse proxy for remote access (see the HLS comment in mediamtx.yml),
// which sets X-Forwarded-For. Trusting only loopback — not a blanket `true` — means only a proxy on
// this same host can supply that header, so a client cannot spoof its own IP.
//
// ⚠️ BUT LOOPBACK IS THE WRONG DEFAULT FOR THE SETUP THIS PROJECT DOCUMENTS (issue #248). The README's
// reverse-proxy section has SWAG reaching Nightlight by its LAN IP — the host's in host mode, or the
// container's own on ipvlan — and the macvlan note even suggests running SWAG on a different host.
// None of those is loopback, so X-Forwarded-For is ignored and `req.ip` is the PROXY for every remote
// user. That collapsed the login limiter into one shared bucket; see auth.js.
//
// Configurable, defaulting to today's behaviour so nothing changes for an existing install. Accepts
// anything Express does: an IP or CIDR (`10.0.0.20`, `172.18.0.0/16`), a comma-separated list, a hop
// count (`1`), or a named range.
//
// ⚠️ ONLY SET THIS WHEN THE PROXY IS TRUSTED. A wrong or over-broad value lets a client forge
// X-Forwarded-For and evade the rate limit entirely — which is worse than the shared bucket it fixes.
// Documented with that warning in the README's reverse-proxy section.
// ⚠️ VALIDATED, NOT PASSED STRAIGHT THROUGH. `app.set('trust proxy', 'true')` THROWS out of proxy-addr
// during startup, and since the bad value lives in the environment every restart dies identically —
// a permanent crash loop on a baby monitor, from one typo. `true` is also the likeliest typo, because
// it is the canonical example in Express's own docs (where the setting takes a real boolean).
// See lib/trustProxy.js; it falls back to 'loopback' with a loud log rather than exiting.
applyTrustProxy(app, process.env.TRUST_PROXY);

// Content-Security-Policy — ENFORCING (validated via a report-only rollout on staging that exercised
// every feature). The report-uri below still logs any future
// violation to /api/csp-report, so a regression (e.g. a new dependency pulling a third-party script)
// shows up in the container log instead of silently. Directives are tuned to this app:
//  - script-src 'self' + static.cloudflareinsights.com: Vite emits one external module script (no
//    inline scripts — don't add unsafe-*); the Cloudflare Web Analytics beacon is allowed by choice.
//  - style-src 'self': theming uses element.style.setProperty (CSSOM), which CSP doesn't police; app
//    CSS is an external <link>. (If real style violations show up, add 'unsafe-inline' — low risk.)
//  - media-src/worker-src blob:: hls.js feeds <video> via MSE blob URLs and runs its demuxer worker
//    from a blob: URL. img-src data:: snapshot posters/icons. font-src data:: any inlined @font-face.
//  - connect-src adds the client-side WebRTC STUN host (WhepPlayer.jsx) + the CF beacon POST target —
//    keep the STUN host in sync if it ever changes.
//  - No upgrade-insecure-requests: the app is also served over plain http on the LAN.
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", 'https://static.cloudflareinsights.com'],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
      mediaSrc: ["'self'", 'blob:'],
      workerSrc: ["'self'", 'blob:'],
      connectSrc: ["'self'", 'stun.l.google.com:19302', 'https://cloudflareinsights.com'],
      fontSrc: ["'self'", 'data:'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      reportUri: ['/api/csp-report'],
    },
  },
}));

// Unlike the read-only guard below, this must also cover the media proxies: the guest-session cap
// bounds concurrent sign-ins, but one admitted token can otherwise open many WHEP sessions or make
// repeated HLS/API requests. Its own DEMO_MODE skip makes this a no-op for normal installations.
app.use(['/api', '/live', '/hls'], demoRequestLimiter);

// MediaMTX doesn't know it's being reverse-proxied under a prefix (e.g. /live or /hls),
// so any redirect or resource-location it issues (WHEP's session Location header, HLS's
// own internal redirects like its cookie check) omits that prefix. Left alone, the
// browser follows those straight to the wrong URL, which falls through to the app's own
// catch-all route instead of back through the proxy. This re-adds the prefix so every
// follow-up request keeps coming back through the same proxy.
function keepUnderPrefix(proxyRes, prefix) {
  const loc = proxyRes.headers['location'];
  if (!loc) return;
  try {
    let pathPart = loc;
    if (/^https?:\/\//i.test(loc)) {
      const u = new URL(loc);
      pathPart = u.pathname + u.search;
    }
    if (!pathPart.startsWith(prefix)) {
      pathPart = prefix + (pathPart.startsWith('/') ? pathPart : `/${pathPart}`);
    }
    proxyRes.headers['location'] = pathPart;
  } catch {
    // Leave the header as-is if it couldn't be parsed.
  }
}

// Proxy WHEP (live video signaling) straight through to MediaMTX on the same origin/port as
// everything else. Two gates, not one. requireAuth confirms the caller is a signed-in
// caregiver — but MediaMTX itself has no authorization model of its own, so whepOnlyGuard is a
// second, necessary gate (see its own comment, and this repo's Security Advisories, for why):
// it rejects anything that isn't one of the two exact WHEP-viewing request shapes the frontend
// ever sends (see WhepPlayer.jsx), before the request ever reaches MediaMTX. This must still be
// mounted before express.json() so the SDP offer body streams through untouched.
//
// Those two gates only run at signaling time, though — once a session starts, audio/video flows
// directly between the browser and MediaMTX over UDP, outside this proxy entirely. recordWebrtc
// SessionOwner (in the same proxyRes hook as keepUnderPrefix) remembers which login session opened
// each view; the periodic sweep below closes it again if that session is revoked while the view is
// still open (see this repo's Security Advisories for the full writeup).
app.use(
  '/live',
  requireAuth,
  whepOnlyGuard,
  createProxyMiddleware({
    target: process.env.MEDIAMTX_WEBRTC_URL || 'http://127.0.0.1:8889',
    changeOrigin: true,
    pathRewrite: { '^/live': '' },
    on: {
      proxyRes: (proxyRes, req) => {
        keepUnderPrefix(proxyRes, '/live');
        recordWebrtcSessionOwner(proxyRes, req);
      },
    },
  })
);

app.use(
  '/hls',
  requireAuthQueryOrHeader,
  createProxyMiddleware({
    target: process.env.MEDIAMTX_HLS_URL || 'http://127.0.0.1:8888',
    changeOrigin: true,
    pathRewrite: { '^/hls': '' },
    on: {
      proxyRes(proxyRes) {
        keepUnderPrefix(proxyRes, '/hls');
        // This is live, constantly-changing content — explicitly forbid caching so
        // any CDN/proxy in front of this (e.g. Cloudflare) never serves a stale
        // playlist or segment, and never mangles it via range/cache heuristics.
        proxyRes.headers['cache-control'] = 'no-store, no-cache, must-revalidate';
        delete proxyRes.headers['etag'];
      },
    },
  })
);

app.use(express.json());

// Demo-mode guard: when DEMO_MODE=true, blocks every write except log in/out (see
// middleware/demoMode.js for the full policy and why it's positioned here — after
// express.json(), before every API router, and deliberately not in front of /live or /hls,
// which are mounted above and never reach this line). A complete no-op for every real
// install, where DEMO_MODE is unset.
app.use(demoGuard);

app.use('/api/auth', authRoutes);
app.use('/api/children', childrenRoutes);
app.use('/api/cameras', camerasRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/logs', logsRoutes);
app.use('/api/diagnostics', diagnosticsRoutes);
app.use('/api/events', eventsRoutes);
app.use('/api/about', aboutRoutes);
app.use('/api/push', pushRoutes);
app.use('/api/pushover', pushoverRoutes);
app.use('/api/ntfy', ntfyRoutes);
app.use('/api/gotify', gotifyRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/timelapses', timelapsesRoutes);
app.use('/api/recordings', recordingsRoutes);
app.use('/manifest.webmanifest', manifestRoutes);

app.get('/api/health', (req, res) => res.json({ ok: true }));

// CSP violation sink (see the helmet block above). The browser POSTs a report here whenever the policy
// blocks something; we log it so a regression — e.g. a new dependency pulling in a third-party script —
// shows up in the container log instead of silently breaking a feature. Unauthenticated by necessity
// (browsers send these with no credentials), so it is deliberately hardened against abuse: anyone who
// can reach the app can post here, and the log is a 1000-line ring buffer that also backs the in-app log
// viewer. Without limits, a flood would evict every real log line, and newlines in the body would forge
// convincing-looking log entries. Hence: a per-minute cap, one line, and length-clamped.
// express.text with a wildcard type captures the body regardless of the report's content-type
// (application/csp-report vs application/reports+json).
const CSP_REPORTS_PER_MIN = 10;
const CSP_REPORT_MAX_CHARS = 500;
let cspReportWindowStart = 0;
let cspReportCount = 0;
app.post('/api/csp-report', express.text({ type: '*/*', limit: '64kb' }), (req, res) => {
  res.status(204).end(); // always accept; the browser has nothing useful to do with an error
  if (!req.body) return;
  const now = Date.now();
  if (now - cspReportWindowStart > 60_000) {
    // Note when a burst was actually dropped, so silence isn't mistaken for "no violations".
    if (cspReportCount > CSP_REPORTS_PER_MIN) {
      logger.warn(`[csp-report] suppressed ${cspReportCount - CSP_REPORTS_PER_MIN} further report(s) in the last minute`);
    }
    cspReportWindowStart = now;
    cspReportCount = 0;
  }
  if (++cspReportCount > CSP_REPORTS_PER_MIN) return;
  const raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
  // Collapse all whitespace so a body can't inject extra log lines, then clamp the length.
  const oneLine = raw.replace(/\s+/g, ' ').trim().slice(0, CSP_REPORT_MAX_CHARS);
  logger.warn(`[csp-report] ${oneLine}${raw.length > CSP_REPORT_MAX_CHARS ? '…' : ''}`);
});

// Serve the built React frontend (see Dockerfile — built at image-build time into ./public).
const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(publicDir, 'index.html'));
});

const PORT = process.env.PORT || 4000;
const server = app.listen(PORT, () => {
  logger.info(`Baby monitor backend listening on port ${PORT}`);
  // From here on a background fault should be survived, not fatal. BEFORE this point it is a failed
  // start, and the guards exit non-zero instead of leaving a healthy-looking container with no server
  // bound — see the boot/steady-state note in lib/processGuards.js.
  markBootComplete();
  // Run the clip-storage guard + retention sweeper BEFORE reconcile, so reconcile only starts
  // segmenters once storage is known usable (startClipCapture gates on it).
  startClipStorage();
  // Any recording still marked 'recording' or 'pending' is debris from a restart that interrupted it —
  // there is no in-process state left for either. Sweeping it to 'failed' is what makes it VISIBLE:
  // since #276 the child's page lists 'ready' and 'failed', and excludes the two live statuses, so a
  // row left 'pending' is the one that stays hidden forever. See #256 and #276.
  // (This comment previously said listChildRecordings "filters on 'ready'" — true before #276, and a
  // false reason attached to a still-true conclusion, which is the hardest kind to notice.)
  reconcileStaleRecordings();
  startTimelapseSampler(); // sample sleep-window frames for the nightly memories timelapse (gated on clip storage)
  reconcileCameraPaths();
  initPush();
});

// --- Two-way audio (talk-back) over WebSocket ---
// The client opens ws(s)://<origin>/api/talk?camera=<id>&token=<jwt> and streams raw G.711 mu-law
// audio as binary frames; we forward them to the camera's speaker (see lib/twoWayAudio.js). Auth is a
// MEDIA-scoped token, NOT the session token the REST API takes: this handler REJECTS a session token,
// and the ordinary `requireAuth` routes reject a media one. (The exception, so nobody is surprised by
// it: the handful of routes behind `requireAuthQueryOrHeader` — HLS segments, snapshots, clips —
// deliberately accept a media token in `?token=`, because an <img>/<video> cannot set a header.)
// Any signed-in user may talk; it's a caregiving action, like PTZ.
//
// ⚠️ This used to say "the same JWT+session as the REST API", which described the world before the
// JWT-in-URLs hardening in 0.25.0 and would lead someone "simplifying" this handler to put FULL
// SESSION TOKENS IN WEBSOCKET URLS. The narrowing is the point - see the note on verifyToken below.
const talkWss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { socket.destroy(); return; }
  if (url.pathname !== '/api/talk') { socket.destroy(); return; }
  // WebSocket upgrades never pass through Express's middleware chain, so demoGuard (mounted as
  // app.use() above) structurally cannot see this request no matter where it's positioned — this
  // check is the only enforcement point for the demo on this path. Placed before the token/camera
  // lookups so no unnecessary DB read happens first.
  if (isDemoModeActive()) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
  // The token rides in the WS URL (browsers can't set headers on the handshake), so it must be a
  // media-scoped token, not the full session token - same reason as the HLS/query-token routes.
  // Kept (not just the verified payload) so handleTalkConnection can re-check it for as long as the
  // socket stays open — see talkSocket.js for why the handshake alone isn't enough.
  const token = url.searchParams.get('token');
  const user = verifyToken(token, { purpose: 'media' });
  if (!user) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
  const cameraId = url.searchParams.get('camera');
  const camera = cameraId ? db.prepare('SELECT * FROM cameras WHERE id = ?').get(cameraId) : null;
  if (!camera || camera.disabled || !talkConfigured(camera)) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }
  talkWss.handleUpgrade(req, socket, head, (ws) => handleTalkConnection(ws, camera, user, token));
});

// Also re-check periodically (not just at startup) — if MediaMTX is ever restarted
// on its own (e.g. after a config change, or a crash) without the app restarting too,
// this makes it self-heal within a few minutes instead of needing a manual restart.
safeInterval('reconcile', 5 * 60 * 1000, reconcileCameraPaths);

// Housekeeping: every login inserts a sessions row, and only an explicit logout
// deletes it, so abandoned rows accumulate forever. Anything idle past the JWT's own
// 30-day lifetime (see routes/auth.js) can never authenticate again regardless, so
// deleting it changes nothing except table size.
function purgeExpiredSessions() {
  // push_tokens has no FK to sessions (deliberate — same reasoning as its user_id column, see
  // lib/push.js), so a row bound to one of these about to go stale first, matching every other
  // session-revocation path in routes/auth.js — not strictly required (activePushTokens() already
  // excludes it either way) but keeps push_tokens from accumulating rows nothing will ever clean up.
  db.prepare(
    `DELETE FROM push_tokens WHERE session_id IN (
       SELECT id FROM sessions WHERE last_seen_at < datetime('now', '-31 days')
     )`
  ).run();
  const { changes } = db.prepare("DELETE FROM sessions WHERE last_seen_at < datetime('now', '-31 days')").run();
  if (changes > 0) logger.info(`Purged ${changes} expired session(s).`);
}
purgeExpiredSessions();
safeInterval('purge-sessions', 24 * 60 * 60 * 1000, purgeExpiredSessions);

// Closes the gap recordWebrtcSessionOwner exists for (see the /live mount's own comment): a login
// session revoked while its owner is already watching a camera doesn't tear down that view on its
// own — MediaMTX has no idea the revocation happened. This is the enforcement side: every tick, ask
// MediaMTX what's actually still open, and end anything whose recorded owner is no longer a live
// session — checked the SAME way every other revocation path in this repo checks it (exists, AND
// within its own absolute token lifetime — see SESSION_TOKEN_TTL_DAYS and lib/push.js's identical
// reasoning for the same class of gap).
//
// 15s, matching camera-watchdog's cadence below — the documented bound on how long a revoked
// session's view can keep playing. `sweeping` skips a tick already in flight: safeInterval does not
// await the previous call, and listWebrtcSessions/kickWebrtcSession hitting a genuinely stalled
// MediaMTX (the exact case their own timeout is bounded against, but worth guarding regardless)
// must not stack up concurrent sweeps.
const WEBRTC_KICK_INTERVAL_MS = 15 * 1000;
let sweeping = false;
safeInterval('webrtc-session-reconcile', WEBRTC_KICK_INTERVAL_MS, async () => {
  if (sweeping) return;
  sweeping = true;
  try {
    // Captured BEFORE the request, not after — see sessionsToKick's own comment for the race this
    // guards against (a session recorded while this fetch is in flight must never be pruned just
    // because it's missing from a snapshot older than it is).
    const listStartedAt = Date.now();
    const sessions = await listWebrtcSessions();
    const isLive = (sid) =>
      !!db.prepare(`SELECT 1 FROM sessions WHERE id = ? AND created_at > datetime('now', ?)`)
        .get(sid, `-${SESSION_TOKEN_TTL_DAYS} days`);
    const { toKick, stale } = sessionsToKick(sessions, webrtcSessionOwners, isLive, listStartedAt);
    for (const { id, path } of toKick) {
      await kickWebrtcSession(id);
      webrtcSessionOwners.delete(id);
      logger.info(`[webrtc] closed a live view whose session was revoked (path ${path})`);
    }
    for (const id of stale) webrtcSessionOwners.delete(id);
  } finally {
    sweeping = false;
  }
});

// The camera watchdog (15s) and the audio watchdog (30s) — the ONLY things that recover a wedged camera
// stream. Their loop bodies live in lib/cameraWatchdogs.js since #451, so they can be tested through their
// real logic (this file cannot be imported: it boots the app). Each factory's deps default to the real
// functions, so nothing is overridden here. The per-camera guard and the "one pending check per camera"
// rule live in lib/processGuards.js's perTargetRunner; the `[guard:camera-watchdog:<name>]`,
// `[guard:camera-watchdog:sub:<name>]` and `[guard:audio-watchdog:<name>]` labels are unchanged.
//
// ⚠️ `.tick` must be what is handed over, not the watchdog object: safeInterval calls its argument, and an
// object would throw every tick, reported and swallowed, with no watchdog running at all. The wiring
// tripwire in process-guards.test.js pins this line.
safeInterval('camera-watchdog', WATCHDOG_INTERVAL_MS, createCameraWatchdog().tick);
safeInterval('audio-watchdog', AUDIO_CHECK_INTERVAL_MS, createAudioWatchdog().tick);

// MediaMTX only learns about a camera when it's added/edited through our API, or from
// this reconciliation. Important: every actual config write to MediaMTX forces it to
// reload that path, which disconnects whatever is currently publishing to it - so this
// only writes when a path is actually missing or misconfigured, never unconditionally.
// This also makes sure each camera's audio transcoder (see transcoder.js) is running -
// that part is always safe to check, since it only starts one if none is running.
async function reconcileCameraPaths(attempt = 1) {
  const cameras = db.prepare('SELECT * FROM cameras').all();
  if (cameras.length === 0) return;
  try {
    let fixedCount = 0;
    for (const cam of cameras) {
      // Disabled cameras are deliberately off - don't recreate their path or start their
      // transcoder (that's what keeps them off across an app restart, since this runs on boot).
      if (cam.disabled) continue;
      // `=== false`, never `!`: null means MediaMTX did not answer in time, and a write we give up on
      // can still land and drop a publisher that was working (#451; see isPathConfiguredCorrectly). An
      // unknown path is left alone and asked about again on the next pass, 5 minutes later.
      if ((await isPathConfiguredCorrectly(cam.mediamtx_path)) === false) {
        await upsertPath(cam.mediamtx_path);
        fixedCount++;
      }
      if (!isRunning(cam.id)) {
        await startTranscoder(cam.id, cam.rtsp_url, cam.mediamtx_path, cam.name);
      }
      // Keep the optional low-quality sub-stream (adaptive quality) alive the same way.
      if (subConfigured(cam) && !isSubRunning(cam.id)) {
        await startSubStream(cam);
      }
      // Keep the pixel-diff leg alive (reads the stream above). It runs to ALERT for frame-diff
      // cameras, or ACTIVITY-ONLY for child-assigned cameras whose alerts come from MQTT (sleep
      // tracking's motion signal) — motionLegWanted() decides; startMotionDetector picks the mode.
      // motionLegWanted() also window-gates the activity-only leg, so start it at bedtime and tear it
      // down after wake (the alert leg is 24/7 and never hits the stop branch).
      if (motionLegWanted(cam) && !isDetecting(cam.id)) {
        await startMotionDetector(cam).catch((e) => logger.error(`[detect] start failed: ${e.message}`));
      } else if (!motionLegWanted(cam) && isDetecting(cam.id)) {
        await stopMotionDetector(cam.id).catch(() => {});
      }
      // Keep the ONVIF motion subscription alive for cameras on the 'onvif' source (peer to the
      // pixel-diff leg; the camera reports motion over its Event service). Tear one down if the
      // camera has since switched away from ONVIF.
      if (onvifMotionWanted(cam) && !isOnvifMotion(cam.id)) {
        await startOnvifMotion(cam).catch((e) => logger.error(`[onvif-motion] start failed: ${e.message}`));
      } else if (!onvifMotionWanted(cam) && isOnvifMotion(cam.id)) {
        await stopOnvifMotion(cam.id).catch(() => {});
      }
      // Keep the optional sound detector alive the same way (audio-only leg off the same stream).
      if (cam.detect_sound_enabled && !isSoundDetecting(cam.id)) {
        await startSoundDetector(cam).catch((e) => logger.error(`[sound] start failed: ${e.message}`));
      }
      // Keep the clip/recording ring alive the same way (its own leg off the same path). The condition
      // lives in clipRingWanted — this used to test `detect_record_clips` alone, which left on-demand
      // recording unarmed on every restart for anyone who hadn't also turned on detection clips.
      //
      // reconcileClipRing has BOTH directions (see clipCapture.js) — until issue #387's adversarial
      // review, this only had the start half, so a camera that stopped wanting the ring for any reason
      // nothing else happened to catch (assign to no child, a child deleted, any future caller that
      // forgets clipRingWanted) kept its segmenter, and so its ffmpeg process, running indefinitely.
      // Confirmed live: PUT /api/cameras/:id/assign (unassign) and DELETE /api/children/:id both left a
      // wake-only ring running with no path back before this fix.
      //
      // ⚠️ THIS CALL SITE IS UNTESTED, honestly: index.js spawns MediaMTX/transcoders at import time,
      // which every existing test deliberately avoids triggering (see clip-capture.test.js's own
      // header), so nothing here can import this file to prove the line still calls reconcileClipRing.
      // reconcileClipRing itself IS thoroughly tested (clip-capture.test.js), so a bug in the DECISION
      // would be caught — a future edit silently deleting or bypassing this call would not be. Confirmed
      // by a second adversarial review pass (issue #387 follow-up) as a genuine structural limit, not
      // one given up on early — closing it for real needs either an e2e test with a real ffmpeg
      // (clipRing.test.js's own header defers the analogous on-demand-recording case there) or
      // extracting reconcileCameraPaths's loop body into something importable, which wasn't judged
      // worth the risk of touching for this fix alone.
      reconcileClipRing(cam);
    }
    if (fixedCount > 0) {
      logger.info(`Reconciled ${fixedCount} of ${cameras.length} camera path(s) with MediaMTX.`);
    }
  } catch (err) {
    if (attempt >= 10) {
      logger.error('Giving up reconciling camera paths with MediaMTX:', err.message);
      return;
    }
    // MediaMTX may not have finished starting up yet — retry for a while.
    setTimeout(() => reconcileCameraPaths(attempt + 1), 3000);
  }
}

// Clean shutdown: stop every FFmpeg transcoder, MediaMTX, and the MQTT connection,
// rather than letting `docker stop` just kill the whole process tree indiscriminately.
async function shutdown() {
  logger.info('Shutting down - stopping transcoders and MediaMTX.');
  // Started HERE, awaited below. The only ordering that actually matters is that an in-flight
  // recording finishes cutting BEFORE stopAllClipCapture takes the ring away; the detector stops are
  // unrelated to it and can overlap.
  //
  // ⚠️ THE REASON IT IS NOT SIMPLY AWAITED IN PLACE IS ARITHMETIC, and awaiting in place was a real
  // regression caught by adversarial review of PR #277. Each detector stop is bounded by its own 3s
  // force-kill, and so is the transcoder stop: awaiting in sequence gave 3 + 3 + 6 + 3 = 15s worst
  // case, where before that PR it was 3 + 3 + 3 = 9s. Overlapping the recording wait with the
  // detector stops restores that: max(6, 3+3) + 3 = 9s. Asserted in recordings-shutdown.test.js,
  // because it is not observable any other way.
  //
  // ⚠️ 9s is the number the DEPLOYMENT grace is sized from — see issue #279 and the
  // `stop_grace_period` / `--stop-timeout 30` declarations in docker-compose.yml, unraid-template.xml
  // and the README. An earlier version of this comment said 15s exceeded "Docker's DEFAULT 10s stop
  // grace"; soak-testing this on Docker Engine 29.7.2 showed there is no such guarantee — `docker
  // stop` with no `-t` SIGKILLed the container after ~4s, losing exactly the recording this code
  // exists to save. Keep the bound under 9s AND keep the grace declared; neither alone is enough.
  const recordingsFinished = stopAllRecordingsForShutdown();
  await stopAllMotionDetectors();
  await stopAllOnvifMotion();
  await stopAllSoundDetectors();
  // Finish any in-flight recording before the ring goes — it cuts from the segments the ring owns.
  await recordingsFinished;
  stopAllClipCapture();
  await stopAllTranscoders();
  stopMediaMTX();
  stopMqtt();
  // Grouped with the other background stops, and placed AFTER the detector stops on purpose: the
  // detectors feed recordMotion/recordSound, so clearing the flusher earlier would only widen the
  // window in which activity is accumulated and never written. Placing it here preserves exactly the
  // previous behaviour while giving the process a way to exit that is not `process.exit`.
  //
  // ⚠️ It does NOT flush the partial minute still sitting in the in-memory buckets. That row was
  // already lost to `process.exit(0)` before this line existed, so writing one here would be a new
  // behaviour smuggled in under a bug fix — see issue #278. If that minute turns out to matter,
  // it is its own change with its own test.
  stopActivityTracker();
  // The other periodic jobs, stopped for the same reason and grouped with it (issue #286). All are
  // cheap synchronous clearInterval calls; none writes anything on the way out, so their order
  // relative to each other does not matter.
  //
  // ⚠️ TWO of these joined the list in #263, not #286, and for two different reasons.
  //   * The timelapse sampler was invisible to that sweep: it looked for the literal `setInterval` and
  //     this job is created through `safeInterval`. The guard now knows about the wrapper.
  //   * The wake watcher was NOT invisible — it has had a `stopWakeWatcher` since #286 and was in the
  //     test's own list of periodic jobs. Shutdown simply never called it, and the assertion that
  //     would have said so was a hand-typed array that nobody extended. It is derived now
  //     (suite-exits-cleanly.test.js), which is what surfaced this.
  stopSensorSampler();
  stopClipStorage();
  stopSleepJob();
  stopTimelapseSampler();
  stopWakeWatcher();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
