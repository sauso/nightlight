import { Router } from 'express';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import db from '../db.js';
import { logger } from '../lib/logger.js';
import { getPathStatus } from '../lib/mediamtx.js';
import { mqttStatus, getReading } from '../lib/mqttClient.js';
import { getRecentEvents } from '../lib/cameraEvents.js';
import { getRecentDetectionEvents } from '../lib/detectionEvents.js';
import { pushConfigured, pushEnabled } from '../lib/push.js';
import { pushoverConfigured, pushoverEnabled } from '../lib/pushover.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// A one-click "support bundle" a self-hoster can attach to a GitHub issue. It's deliberately a
// REDACTED snapshot of everything useful for diagnosing a problem — build/version, host + runtime
// info, the (secret-free) app + camera + detection config, live stream/MQTT/push status, recent
// detection + camera-history events, and the in-memory server log buffer.
//
// SECURITY: this must never leak credentials. Every field below is an explicit allow-list, and
// anything sensitive (RTSP/ONVIF/talk/MQTT/Pushover/Firebase passwords + tokens, snapshot URLs
// that can embed Basic-auth) is reduced to a boolean "is it set?" rather than its value. Admin-only.

let appVersion = 'unknown';
try {
  appVersion = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')).version;
} catch { /* leave as unknown */ }

function envOrNull(name) {
  const v = process.env[name];
  return v && v !== 'unknown' ? v : null;
}

// Split an RTSP URL into non-secret address parts. Node's URL parses arbitrary schemes, so
// rtsp://user:pass@host:554/path yields hostname/port/pathname with the password left behind.
function rtspAddress(url) {
  try {
    const u = new URL(url);
    return {
      host: u.hostname,
      port: u.port,
      path: (u.pathname || '') + (u.search || ''),
      username: u.username || '',
      hasPassword: !!u.password,
    };
  } catch {
    return { host: '', port: '', path: '', username: '', hasPassword: false };
  }
}

const mb = (n) => Math.round((n / 1024 / 1024) * 10) / 10;

// Allow-listed, secret-free view of one camera row.
function safeCamera(cam) {
  const addr = rtspAddress(cam.rtsp_url || '');
  const subAddr = rtspAddress(cam.sub_rtsp_url || '');
  return {
    id: cam.id,
    name: cam.name,
    child_id: cam.child_id || null,
    mediamtx_path: cam.mediamtx_path,
    sort_order: cam.sort_order,
    created_at: cam.created_at,
    // Address (no credentials)
    rtsp_host: addr.host,
    rtsp_port: addr.port,
    rtsp_path: addr.path,
    rtsp_username: addr.username,
    rtsp_has_password: addr.hasPassword,
    has_sub_stream: !!(cam.sub_rtsp_url && cam.sub_rtsp_url.trim()),
    sub_rtsp_path: subAddr.path,
    has_snapshot_url: !!(cam.snapshot_url && cam.snapshot_url.trim()),
    // Capabilities
    ptz_supported: cam.ptz_supported,
    ptz_relative: cam.ptz_relative,
    backchannel_supported: cam.backchannel_supported,
    talk_backend: cam.talk_backend || null,
    talk_configured: !!(cam.talk_backend && cam.talk_username && cam.talk_password),
    onvif_has_credentials: !!(cam.onvif_username || cam.onvif_password),
    onvif_profile_token_set: !!cam.onvif_profile_token,
    discovery_source: cam.discovery_source || null,
    // Detection config (non-secret)
    detect_motion_enabled: cam.detect_motion_enabled,
    detect_sound_enabled: cam.detect_sound_enabled,
    detect_schedule_enabled: cam.detect_schedule_enabled,
    detect_source: cam.detect_source,
    detect_sensitivity: cam.detect_sensitivity,
    detect_cooldown_s: cam.detect_cooldown_s,
    detect_confirm_s: cam.detect_confirm_s,
    detect_start: cam.detect_start,
    detect_end: cam.detect_end,
    sound_sensitivity: cam.sound_sensitivity,
    sound_confirm_s: cam.sound_confirm_s,
    sound_cooldown_s: cam.sound_cooldown_s,
    motion_mqtt_topic: cam.motion_mqtt_topic || null,
    has_motion_mqtt_value: !!cam.motion_mqtt_value,
    mqtt_topic: cam.mqtt_topic || null,
  };
}

const router = Router();

router.get('/', requireAuth, requireAdmin, async (req, res) => {
  try {
    const settings = db.prepare('SELECT * FROM settings WHERE id = ?').get('app') || {};
    const cameras = db.prepare('SELECT * FROM cameras ORDER BY sort_order, created_at').all();
    const children = db.prepare('SELECT id, name, birthday, color, created_at FROM children').all();
    const userRows = db.prepare('SELECT role FROM users').all();

    const camerasWithStatus = await Promise.all(
      cameras.map(async (cam) => {
        const safe = safeCamera(cam);
        return {
          ...safe,
          // Skip the MediaMTX query for a disabled camera — its path is removed, so it would 404 and log
          // "path not found". It's intentionally off; report not-ready without asking.
          stream_status: cam.disabled ? { ready: false, tracks: [] } : await getPathStatus(cam.mediamtx_path),
          mqtt_reading: cam.mqtt_topic ? getReading(cam.mqtt_topic) : null,
        };
      })
    );

    const bundle = {
      report: 'nightlight-diagnostics',
      note: 'Redacted support bundle — contains configuration and recent logs, but no passwords or tokens. Review before sharing.',
      generated_at: new Date().toISOString(),

      app: {
        version: appVersion,
        git_sha: envOrNull('NIGHTLIGHT_GIT_SHA'),
        git_ref: envOrNull('NIGHTLIGHT_GIT_REF'),
        build_time: envOrNull('NIGHTLIGHT_BUILD_TIME'),
      },

      system: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        uptime_seconds: Math.round(process.uptime()),
        timezone: process.env.TZ || (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return null; } })(),
        memory_mb: (() => { const m = process.memoryUsage(); return { rss: mb(m.rss), heap_used: mb(m.heapUsed), heap_total: mb(m.heapTotal), external: mb(m.external) }; })(),
        host: { total_mem_mb: mb(os.totalmem()), free_mem_mb: mb(os.freemem()), loadavg: os.loadavg().map((n) => Math.round(n * 100) / 100), os_release: os.release() },
        env: {
          data_dir_set: !!process.env.DATA_DIR,
          public_host_set: !!process.env.PUBLIC_HOST,
          jwt_secret_set: !!process.env.JWT_SECRET,
          puid: process.env.PUID || null,
          pgid: process.env.PGID || null,
        },
      },

      settings: {
        app_name: settings.app_name,
        timezone: settings.timezone,
        font_choice: settings.font_choice,
        temp_unit: settings.temp_unit,
        ptz_step: settings.ptz_step,
        accent_color: settings.accent_color,
        live_color: settings.live_color,
        offline_color: settings.offline_color,
        mqtt_enabled: settings.mqtt_enabled,
        mqtt_host: settings.mqtt_host || null,
        mqtt_port: settings.mqtt_port || null,
        mqtt_username: settings.mqtt_username || null,
        mqtt_password_set: !!settings.mqtt_password,
      },

      integrations: {
        mqtt: mqttStatus(),
        firebase_push: { enabled: pushEnabled(), configured: pushConfigured() },
        pushover: { enabled: pushoverEnabled(), configured: pushoverConfigured() },
      },

      counts: {
        cameras: cameras.length,
        children: children.length,
        users: userRows.length,
        admins: userRows.filter((u) => u.role === 'admin').length,
      },

      cameras: camerasWithStatus,
      children,

      recent_detection_events: getRecentDetectionEvents(100),
      camera_history: getRecentEvents(200),
      server_logs: logger.getRecent(),
    };

    res.json(bundle);
  } catch (err) {
    logger.error(`[diagnostics] failed to build bundle: ${err.message}`);
    // 4xx (not 5xx): a reverse proxy replaces origin 5xx bodies, hiding the message.
    res.status(400).json({ error: `Failed to build diagnostics: ${err.message}` });
  }
});

export default router;
