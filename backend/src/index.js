import express from 'express';
import helmet from 'helmet';
import path from 'path';
import { fileURLToPath } from 'url';
import { createProxyMiddleware } from 'http-proxy-middleware';
import authRoutes from './routes/auth.js';
import childrenRoutes from './routes/children.js';
import camerasRoutes from './routes/cameras.js';
import settingsRoutes from './routes/settings.js';
import manifestRoutes from './routes/manifest.js';
import logsRoutes from './routes/logs.js';
import eventsRoutes from './routes/events.js';
import aboutRoutes from './routes/about.js';
import { requireAuth, requireAuthQueryOrHeader } from './middleware/auth.js';
import db from './db.js';
import { upsertPath, isPathConfiguredCorrectly, getPathStatus } from './lib/mediamtx.js';
import { startTranscoder, stopAllTranscoders, isRunning } from './lib/transcoder.js';
import { startMediaMTX, stopMediaMTX } from './lib/mediamtxProcess.js';
import { refreshMqttConnection, stopMqtt } from './lib/mqttClient.js';
import { logger } from './lib/logger.js';
import { recordCameraEvent, EVENT } from './lib/cameraEvents.js';

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

const app = express();

// The app is reached through a reverse proxy for remote access (see the HLS comment in
// mediamtx.yml), which sets X-Forwarded-For - trusting only loopback (not a blanket
// `true`) means only a proxy running on this same host can supply that header, so it
// can't be spoofed by a client to fake its IP. Without this, Express falls back to the
// proxy's own loopback address for every request, which defeats the login route's
// per-IP rate limiting (see auth.js) for anyone connecting through the proxy.
app.set('trust proxy', 'loopback');

// CSP is deliberately disabled here rather than misconfigured: the custom theming
// feature applies colors via inline styles (document.documentElement.style...), and
// WebRTC connects out to a STUN server - both need careful, tested CSP directives to
// allow without weakening the policy generally, and that's not something to get right
// blind. Every other protection helmet provides (clickjacking, MIME-sniffing, etc.)
// stays on.
app.use(helmet({ contentSecurityPolicy: false }));

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
app.use('/api/events', eventsRoutes);
app.use('/api/about', aboutRoutes);
app.use('/manifest.webmanifest', manifestRoutes);

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Serve the built React frontend (see Dockerfile — built at image-build time into ./public).
const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(publicDir, 'index.html'));
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  logger.info(`Baby monitor backend listening on port ${PORT}`);
  reconcileCameraPaths();
});

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
// Stable online/offline status per camera, so the Camera history panel gets one clean
// "offline" event when a camera actually stops and one "online" event when it comes
// back - not a new event every 15s poll while it stays down. Seeded lazily: the first
// time we see a camera we adopt its current state silently (no event), so a restart of
// the app doesn't log a phantom "came online" for every already-healthy camera.
const onlineState = new Map(); // camera_id -> boolean
const WATCHDOG_INTERVAL_MS = 15 * 1000;
const STUCK_THRESHOLD_MS = 30 * 1000;

setInterval(async () => {
  const cameras = db.prepare('SELECT * FROM cameras').all();
  for (const cam of cameras) {
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
      if (!(await isPathConfiguredCorrectly(cam.mediamtx_path))) {
        await upsertPath(cam.mediamtx_path);
        fixedCount++;
      }
      if (!isRunning(cam.id)) {
        await startTranscoder(cam.id, cam.rtsp_url, cam.mediamtx_path, cam.name);
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
  await stopAllTranscoders();
  stopMediaMTX();
  stopMqtt();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
