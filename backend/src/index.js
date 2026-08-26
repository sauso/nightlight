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
import { requireAuth, requireAuthQueryOrHeader, verifyToken } from './middleware/auth.js';
import { startTalkSession, talkConfigured } from './lib/twoWayAudio.js';
import { subConfigured, isSubRunning, startSubStream } from './lib/subStream.js';
import db from './db.js';
import { upsertPath, isPathConfiguredCorrectly, getPathStatus, subPathName } from './lib/mediamtx.js';
import { startTranscoder, stopAllTranscoders, isRunning } from './lib/transcoder.js';
import { startMotionDetector, stopMotionDetector, isDetecting, stopAllMotionDetectors, motionLegWanted } from './lib/motionDetector.js';
import { startOnvifMotion, stopOnvifMotion, isOnvifMotion, onvifMotionWanted, stopAllOnvifMotion } from './lib/onvifMotion.js';
import { startSoundDetector, isSoundDetecting, stopAllSoundDetectors } from './lib/soundDetector.js';
import { startClipCapture, isClipCapturing, stopAllClipCapture } from './lib/clipCapture.js';
import { stopAllRecordings } from './lib/recordings.js';
import { startClipStorage } from './lib/clipStorage.js';
import { initPush } from './lib/push.js';
import { startMediaMTX, stopMediaMTX } from './lib/mediamtxProcess.js';
import { refreshMqttConnection, stopMqtt } from './lib/mqttClient.js';
import { startSensorSampler } from './lib/sensorSampler.js';
import { startActivityTracker } from './lib/activityTracker.js';
import { startSleepJob } from './lib/sleepAnalysis.js';
import { startWakeWatcher } from './lib/wakeWatcher.js';
import { startTimelapseSampler } from './lib/timelapse.js';
import { logger } from './lib/logger.js';
import { recordCameraEvent, EVENT } from './lib/cameraEvents.js';
import { probeAudioFlowing, tracksHaveAudio } from './lib/audioLiveness.js';
import { notifyCameraOffline, notifyCameraRecovered } from './lib/cameraStatusAlert.js';

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

const app = express();

// The app is reached through a reverse proxy for remote access (see the HLS comment in
// mediamtx.yml), which sets X-Forwarded-For - trusting only loopback (not a blanket
// `true`) means only a proxy running on this same host can supply that header, so it
// can't be spoofed by a client to fake its IP. Without this, Express falls back to the
// proxy's own loopback address for every request, which defeats the login route's
// per-IP rate limiting (see auth.js) for anyone connecting through the proxy.
app.set('trust proxy', 'loopback');

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

// Proxy WHEP (live video signaling) straight through to MediaMTX on the same
// origin/port as everything else. This must be mounted before express.json()
// so the SDP request body is streamed through untouched. requireAuth here means
// only logged-in caregivers can start a stream — MediaMTX itself has no auth of
// its own, so this is the only gate in front of it now that it's not directly
// reachable on the network (see mediamtx.yml).
app.use(
  '/live',
  requireAuth,
  createProxyMiddleware({
    target: process.env.MEDIAMTX_WEBRTC_URL || 'http://127.0.0.1:8889',
    changeOrigin: true,
    pathRewrite: { '^/live': '' },
    on: {
      proxyRes: (proxyRes) => keepUnderPrefix(proxyRes, '/live'),
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
  // Run the clip-storage guard + retention sweeper BEFORE reconcile, so reconcile only starts
  // segmenters once storage is known usable (startClipCapture gates on it).
  startClipStorage();
  startTimelapseSampler(); // sample sleep-window frames for the nightly memories timelapse (gated on clip storage)
  reconcileCameraPaths();
  initPush();
});

// --- Two-way audio (talk-back) over WebSocket ---
// The client opens ws(s)://<origin>/api/talk?camera=<id>&token=<jwt> and streams raw G.711 mu-law
// audio as binary frames; we forward them to the camera's speaker (see lib/twoWayAudio.js). Auth is
// the same JWT+session as the REST API (passed as a query param, since browsers can't set headers on
// a WebSocket handshake), and any signed-in user may talk - it's a caregiving action, like PTZ.
const talkWss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { socket.destroy(); return; }
  if (url.pathname !== '/api/talk') { socket.destroy(); return; }
  // The token rides in the WS URL (browsers can't set headers on the handshake), so it must be a
  // media-scoped token, not the full session token - same reason as the HLS/query-token routes.
  const user = verifyToken(url.searchParams.get('token'), { purpose: 'media' });
  if (!user) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
  const cameraId = url.searchParams.get('camera');
  const camera = cameraId ? db.prepare('SELECT * FROM cameras WHERE id = ?').get(cameraId) : null;
  if (!camera || camera.disabled || !talkConfigured(camera)) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }
  talkWss.handleUpgrade(req, socket, head, (ws) => handleTalkConnection(ws, camera, user));
});

async function handleTalkConnection(ws, camera, user) {
  let session = null;
  let closed = false;
  let bytes = 0;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    logger.info(`[talk] session ended for "${camera.name}" (${bytes} audio bytes forwarded)`);
    try { session?.close(); } catch { /* ignore */ }
    try { ws.close(); } catch { /* ignore */ }
  };
  // Register the audio handler before the (async) session start so nothing races; audio arriving
  // before the session is up is simply dropped (the client waits for our 'ready' before sending).
  let sampled = false;
  ws.on('message', (data, isBinary) => {
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

// Also re-check periodically (not just at startup) — if MediaMTX is ever restarted
// on its own (e.g. after a config change, or a crash) without the app restarting too,
// this makes it self-heal within a few minutes instead of needing a manual restart.
setInterval(reconcileCameraPaths, 5 * 60 * 1000);

// Housekeeping: every login inserts a sessions row, and only an explicit logout
// deletes it, so abandoned rows accumulate forever. Anything idle past the JWT's own
// 30-day lifetime (see routes/auth.js) can never authenticate again regardless, so
// deleting it changes nothing except table size.
function purgeExpiredSessions() {
  const { changes } = db.prepare("DELETE FROM sessions WHERE last_seen_at < datetime('now', '-31 days')").run();
  if (changes > 0) logger.info(`Purged ${changes} expired session(s).`);
}
purgeExpiredSessions();
setInterval(purgeExpiredSessions, 24 * 60 * 60 * 1000);

// Second, independent layer of defense: even with FFmpeg's own read timeout (see
// transcoder.js), a stalled connection could conceivably hang in a way that never
// triggers it. This watches MediaMTX's own "is this path actually receiving frames"
// status directly, and force-restarts a camera's transcoder if it's been stuck
// not-ready for too long - regardless of what the FFmpeg process itself is doing.
const notReadySince = new Map(); // camera_id -> timestamp
// Same idea for the optional low-res SUB stream. Its transcoder can wedge (FFmpeg alive but no longer
// publishing — seen after a camera drops/reconnects or a codec change), which the reconcile can't catch
// because the process IS running (isSubRunning stays true), and the main-path check above never looks at
// the sub path. So a wedged sub-stream ("Low" quality shows no video) would otherwise stay dead until the
// whole app restarts. This tracks sub-path readiness and force-restarts just the sub leg when it's stuck.
const subNotReadySince = new Map(); // camera_id -> timestamp
// Stable online/offline status per camera, so the Camera history panel gets one clean
// "offline" event when a camera actually stops and one "online" event when it comes
// back - not a new event every 15s poll while it stays down. Seeded lazily: the first
// time we see a camera we adopt its current state silently (no event), so a restart of
// the app doesn't log a phantom "came online" for every already-healthy camera.
const onlineState = new Map(); // camera_id -> boolean
// Offline-duration notification (separate from the 30s restart timer below, which resets on every
// force-restart). offlineSince marks when a camera actually went down; offlineAlerted remembers we've
// already pushed for the current outage so it's one alert per outage, not one every 15s.
const offlineSince = new Map(); // camera_id -> timestamp it went offline
const offlineAlerted = new Set(); // camera_ids already notified for the current outage
const WATCHDOG_INTERVAL_MS = 15 * 1000;
const STUCK_THRESHOLD_MS = 30 * 1000;

setInterval(async () => {
  const cameras = db.prepare('SELECT * FROM cameras').all();
  // Read the offline-alert config once per tick (not per camera).
  const offlineCfg = db.prepare(
    "SELECT camera_offline_alert_enabled AS enabled, camera_offline_alert_minutes AS minutes FROM settings WHERE id = 'app'"
  ).get();
  for (const cam of cameras) {
    // A disabled camera intentionally has no path/transcoder - skip it entirely so the
    // watchdog doesn't read it as "unready", log phantom offline events, or try to restart
    // it. Clear any tracked state so re-enabling starts clean (seeds silently, no event).
    if (cam.disabled) {
      notReadySince.delete(cam.id);
      subNotReadySince.delete(cam.id);
      onlineState.delete(cam.id);
      offlineSince.delete(cam.id);
      offlineAlerted.delete(cam.id);
      continue;
    }
    const status = await getPathStatus(cam.mediamtx_path);

    // Record sustained up/down transitions (see onlineState above). A brief blip that
    // self-heals between two polls never flips this and so never logs an event here -
    // those fine-grained restarts are recorded by the transcoder itself instead.
    const wasOnline = onlineState.get(cam.id);
    if (wasOnline === undefined) {
      onlineState.set(cam.id, status.ready); // seed silently, no event
    } else if (status.ready && !wasOnline) {
      onlineState.set(cam.id, true);
      recordCameraEvent(cam.id, cam.name, EVENT.ONLINE, 'stream recovered');
    } else if (!status.ready && wasOnline) {
      onlineState.set(cam.id, false);
      recordCameraEvent(cam.id, cam.name, EVENT.OFFLINE, 'stream stopped delivering frames');
    }

    // Offline-duration notification (see offlineSince/offlineAlerted above). Independent of the 30s
    // restart timer below. Fires one push once the outage passes the admin's threshold, and a "back
    // online" push on recovery. Only notifies when enabled; recovery only fires if we actually alerted.
    if (status.ready) {
      if (offlineAlerted.has(cam.id)) notifyCameraRecovered(cam, offlineSince.get(cam.id));
      offlineSince.delete(cam.id);
      offlineAlerted.delete(cam.id);
    } else {
      if (!offlineSince.has(cam.id)) offlineSince.set(cam.id, Date.now());
      if (
        offlineCfg?.enabled &&
        !offlineAlerted.has(cam.id) &&
        Date.now() - offlineSince.get(cam.id) >= offlineCfg.minutes * 60 * 1000
      ) {
        offlineAlerted.add(cam.id);
        notifyCameraOffline(cam, offlineCfg.minutes);
      }
    }

    // Sub-stream (Low quality) wedge check — independent of the main path above, and BEFORE its early
    // `continue`, so it runs even when the main stream is healthy. Mirrors the main logic: if the sub path
    // stays not-ready past the threshold, force-restart just the sub leg (startSubStream → stopTranscoder
    // SIGTERM→SIGKILL → relaunch), which clears a wedged FFmpeg that the reconcile can't (it's still alive).
    if (subConfigured(cam)) {
      const subReady = (await getPathStatus(subPathName(cam.mediamtx_path))).ready;
      if (subReady) {
        subNotReadySince.delete(cam.id);
      } else {
        const subSince = subNotReadySince.get(cam.id);
        if (!subSince) {
          subNotReadySince.set(cam.id, Date.now());
        } else if (Date.now() - subSince > STUCK_THRESHOLD_MS) {
          logger.error(`Sub-stream (Low) for "${cam.name}" unready over ${STUCK_THRESHOLD_MS / 1000}s - force-restarting it.`);
          recordCameraEvent(cam.id, cam.name, EVENT.RESTART, 'sub-stream force-restarted by watchdog (unready 30s+)');
          await startSubStream(cam);
          subNotReadySince.delete(cam.id);
        }
      }
    } else {
      subNotReadySince.delete(cam.id);
    }

    if (status.ready) {
      notReadySince.delete(cam.id);
      continue;
    }
    const since = notReadySince.get(cam.id);
    if (!since) {
      notReadySince.set(cam.id, Date.now());
    } else if (Date.now() - since > STUCK_THRESHOLD_MS) {
      logger.error(
        `Camera "${cam.name}" has been unready for over ${STUCK_THRESHOLD_MS / 1000}s - force-restarting its transcoder.`
      );
      recordCameraEvent(cam.id, cam.name, EVENT.RESTART, 'force-restarted by watchdog (unready 30s+)');
      await startTranscoder(cam.id, cam.rtsp_url, cam.mediamtx_path, cam.name);
      notReadySince.delete(cam.id);
    }
  }
}, WATCHDOG_INTERVAL_MS);

// Third watchdog: audio liveness. The frame watchdog above can't see a camera whose AUDIO track
// stalls while video keeps flowing - the path still reads "ready" and frames keep arriving, so it
// never trips (the tell is sound working in VLC/a fresh connection but not in the app). This
// periodically probes that audio is actually flowing (see audioLiveness.js) and force-restarts a
// camera whose audio has stalled. Confirmed over two consecutive checks so a momentary blip - or a
// one-off probe failure - never triggers a needless restart (see the interval constant below).
const audioStallCounts = new Map(); // camera_id -> consecutive stalled checks
// 30s interval + 2 consecutive stalls => a stall is caught and healed in ~30-60s. That
// matters for a monitor - minutes of dead audio is too long. The probe is cheap on a
// healthy camera (audio delivers dozens of packets/sec, so it hits MIN_AUDIO_PACKETS and
// returns in well under a second); only a genuinely stalled one waits the full 6s timeout.
// Requiring two consecutive stalls still filters blips and probes that land during a normal
// restart (a not-ready path is skipped, and an inconclusive probe resets the counter).
const AUDIO_CHECK_INTERVAL_MS = 30 * 1000;
const AUDIO_STALL_RESTART_THRESHOLD = 2;

setInterval(async () => {
  const cameras = db.prepare('SELECT * FROM cameras').all();
  for (const cam of cameras) {
    if (cam.disabled) {
      audioStallCounts.delete(cam.id);
      continue;
    }
    const status = await getPathStatus(cam.mediamtx_path);
    // Only meaningful once the stream is up AND actually carries audio - never restart a camera
    // that legitimately has no audio track (its "no audio flowing" is correct, not a stall).
    if (!status.ready || !tracksHaveAudio(status.tracks)) {
      audioStallCounts.delete(cam.id);
      continue;
    }
    const flowing = await probeAudioFlowing(cam.mediamtx_path);
    if (flowing !== false) {
      // true (flowing) or null (couldn't tell) - clear the counter, don't act on an unknown.
      audioStallCounts.delete(cam.id);
      continue;
    }
    const stalls = (audioStallCounts.get(cam.id) || 0) + 1;
    audioStallCounts.set(cam.id, stalls);
    if (stalls >= AUDIO_STALL_RESTART_THRESHOLD) {
      logger.error(`Camera "${cam.name}" audio has stalled (declared but not flowing) - restarting its transcoder.`);
      recordCameraEvent(cam.id, cam.name, EVENT.RESTART, 'audio stalled - restarted by watchdog');
      await startTranscoder(cam.id, cam.rtsp_url, cam.mediamtx_path, cam.name);
      audioStallCounts.delete(cam.id);
    }
  }
}, AUDIO_CHECK_INTERVAL_MS);

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
      if (!(await isPathConfiguredCorrectly(cam.mediamtx_path))) {
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
      // Keep the optional clip-recording segmenter alive the same way (its own ring off the same path).
      if (cam.detect_record_clips && !isClipCapturing(cam.id)) {
        startClipCapture(cam);
      }
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
  await stopAllMotionDetectors();
  await stopAllOnvifMotion();
  await stopAllSoundDetectors();
  // Finish any in-flight recording first — it cuts from the ring the segmenters own.
  stopAllRecordings().catch(() => {});
  stopAllClipCapture();
  await stopAllTranscoders();
  stopMediaMTX();
  stopMqtt();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
