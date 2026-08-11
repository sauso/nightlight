import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DATA_DIR = process.env.DATA_DIR || '/app/data';
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'babymonitor.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'caregiver',
    first_name TEXT,
    last_name TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS children (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    birthday TEXT,
    color TEXT NOT NULL DEFAULT '#F5D9A8',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS cameras (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    rtsp_url TEXT NOT NULL,
    child_id TEXT,
    mediamtx_path TEXT UNIQUE NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    mqtt_topic TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (child_id) REFERENCES children(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    id TEXT PRIMARY KEY DEFAULT 'app',
    app_name TEXT NOT NULL DEFAULT 'Nightlight',
    accent_color TEXT NOT NULL DEFAULT '#F5D9A8',
    live_color TEXT NOT NULL DEFAULT '#7FBFA3',
    offline_color TEXT NOT NULL DEFAULT '#E08585',
    timezone TEXT NOT NULL DEFAULT 'UTC',
    font_choice TEXT NOT NULL DEFAULT 'warm-serif',
    temp_unit TEXT NOT NULL DEFAULT 'C',
    mqtt_host TEXT,
    mqtt_port INTEGER,
    mqtt_username TEXT,
    mqtt_password TEXT
  );

  -- One row per login. The JWT carries this row's id (see routes/auth.js) - a request
  -- is only valid if this row still exists, which is what makes both "sign out this
  -- device" and "delete this caregiver" take effect immediately rather than waiting
  -- for the token to naturally expire.
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    user_agent TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  -- A persistent history of camera up/down/restart events, so "was that the camera or
  -- my phone?" can be answered after the fact from the app itself, not just by SSHing in
  -- to read docker logs. camera_name is denormalized (copied in at insert time) rather
  -- than joined, so the history survives the camera being deleted or renamed - it's a
  -- record of what happened, not a live foreign-key relationship. No FK to cameras for
  -- the same reason. Pruned by lib/cameraEvents.js so it can't grow unbounded.
  CREATE TABLE IF NOT EXISTS camera_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    camera_id TEXT NOT NULL,
    camera_name TEXT NOT NULL,
    type TEXT NOT NULL,
    detail TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_camera_events_created_at ON camera_events(created_at);

  -- Detection alerts (motion now, sound later): a separate history from camera_events
  -- above, because "the baby stirred / there's crying" is a different question from "was
  -- the camera up?" and is surfaced as its own "Recent alerts" view. Same denormalized,
  -- pruned, FK-free shape as camera_events (see lib/detectionEvents.js).
  CREATE TABLE IF NOT EXISTS detection_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    camera_id TEXT NOT NULL,
    camera_name TEXT NOT NULL,
    type TEXT NOT NULL,
    detail TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_detection_events_created_at ON detection_events(created_at);

  -- FCM device tokens for push notifications (one row per app install that registered). The
  -- token is the primary key so re-registering the same device is idempotent; user_id is who
  -- was logged in when it registered (informational). Tokens FCM reports as dead are pruned by
  -- lib/push.js when a send fails against them.
  CREATE TABLE IF NOT EXISTS push_tokens (
    token TEXT PRIMARY KEY,
    user_id TEXT,
    platform TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Migrations: columns added after the initial release, for databases created before them.
const usersColumns = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
if (!usersColumns.includes('first_name')) {
  db.exec('ALTER TABLE users ADD COLUMN first_name TEXT');
}
if (!usersColumns.includes('last_name')) {
  db.exec('ALTER TABLE users ADD COLUMN last_name TEXT');
}

const camerasColumns = db.prepare('PRAGMA table_info(cameras)').all().map((c) => c.name);
if (!camerasColumns.includes('sort_order')) {
  db.exec('ALTER TABLE cameras ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0');
  const existing = db.prepare('SELECT id FROM cameras ORDER BY created_at').all();
  const setOrder = db.prepare('UPDATE cameras SET sort_order = ? WHERE id = ?');
  existing.forEach((cam, index) => setOrder.run(index, cam.id));
}

const settingsColumns = db.prepare('PRAGMA table_info(settings)').all().map((c) => c.name);
if (!settingsColumns.includes('timezone')) {
  db.exec("ALTER TABLE settings ADD COLUMN timezone TEXT NOT NULL DEFAULT 'UTC'");
}
if (!settingsColumns.includes('font_choice')) {
  db.exec("ALTER TABLE settings ADD COLUMN font_choice TEXT NOT NULL DEFAULT 'warm-serif'");
}
if (!settingsColumns.includes('temp_unit')) {
  db.exec("ALTER TABLE settings ADD COLUMN temp_unit TEXT NOT NULL DEFAULT 'C'");
}
if (!settingsColumns.includes('mqtt_host')) {
  db.exec('ALTER TABLE settings ADD COLUMN mqtt_host TEXT');
  db.exec('ALTER TABLE settings ADD COLUMN mqtt_port INTEGER');
  db.exec('ALTER TABLE settings ADD COLUMN mqtt_username TEXT');
  db.exec('ALTER TABLE settings ADD COLUMN mqtt_password TEXT');
}
// Separate on/off switch rather than "blank host means off" - lets the broker
// config stay saved while MQTT is temporarily disabled (e.g. broker down for
// maintenance) instead of the client endlessly retrying a dead broker.
if (!settingsColumns.includes('mqtt_enabled')) {
  db.exec('ALTER TABLE settings ADD COLUMN mqtt_enabled INTEGER NOT NULL DEFAULT 1');
}

// Admin-level switch for push notifications, separate from motion detection: motion
// detection still records in-app alerts on its own, but no push is sent unless an admin
// has explicitly enabled it here (which also validates the Firebase files are present).
// Defaults off so an existing install never starts pushing until it's deliberately turned on.
if (!settingsColumns.includes('push_enabled')) {
  db.exec('ALTER TABLE settings ADD COLUMN push_enabled INTEGER NOT NULL DEFAULT 0');
}

// Pushover notifications — an alternative to the Firebase/FCM path that needs no Firebase project
// and works on iOS (the recipient installs the Pushover app). The server just POSTs to Pushover's
// API with an application token + a user/group key. Off until configured + enabled.
if (!settingsColumns.includes('pushover_enabled')) {
  db.exec('ALTER TABLE settings ADD COLUMN pushover_enabled INTEGER NOT NULL DEFAULT 0');
  db.exec('ALTER TABLE settings ADD COLUMN pushover_app_token TEXT');
  db.exec('ALTER TABLE settings ADD COLUMN pushover_user_key TEXT');
}

// The server's own public URL, learned zero-config from the origin the mobile app reports on
// push-register (last writer wins — each server only ever hears its own address from its own app).
// Embedded in deep links so tapping an alert from THIS server opens THIS server in the app, even if
// the app was last pointed at a different one (e.g. a prod alert while the app is showing dev).
if (!settingsColumns.includes('public_base_url')) {
  db.exec('ALTER TABLE settings ADD COLUMN public_base_url TEXT');
}

// Global PTZ step size for cameras driven by ONVIF RelativeMove (see lib/onvif.js ptzRelativeStep):
// how far one D-pad tap moves, in the camera's own relative-translation units. Adjustable because
// the right value depends on the camera's ONVIF space (12 suits the Sonoff pan/tilt cams). Cameras
// that fall back to continuous-move nudges ignore this.
if (!settingsColumns.includes('ptz_step')) {
  db.exec('ALTER TABLE settings ADD COLUMN ptz_step INTEGER NOT NULL DEFAULT 12');
}

if (!camerasColumns.includes('mqtt_topic')) {
  db.exec('ALTER TABLE cameras ADD COLUMN mqtt_topic TEXT');
}

// ONVIF: how a camera was added and (for cameras added via ONVIF) where its ONVIF device
// service lives, so later ONVIF operations (two-way-audio capability check, PTZ) can
// reconnect without re-discovering. discovery_source is 'manual' | 'onvif'.
if (!camerasColumns.includes('discovery_source')) {
  db.exec("ALTER TABLE cameras ADD COLUMN discovery_source TEXT NOT NULL DEFAULT 'manual'");
}
if (!camerasColumns.includes('onvif_capable')) {
  db.exec('ALTER TABLE cameras ADD COLUMN onvif_capable INTEGER NOT NULL DEFAULT 0');
}
if (!camerasColumns.includes('onvif_device_url')) {
  db.exec('ALTER TABLE cameras ADD COLUMN onvif_device_url TEXT');
}
// Two-way-audio (ONVIF backchannel) capability, captured at ONVIF add time:
// 'yes' | 'no' | 'unknown' (unknown = manually added, or ONVIF didn't say). Informational
// for now; Phase 3 (two-way audio) would only ever be offered on 'yes'.
if (!camerasColumns.includes('backchannel_supported')) {
  db.exec("ALTER TABLE cameras ADD COLUMN backchannel_supported TEXT NOT NULL DEFAULT 'unknown'");
}
// PTZ: whether the camera supports pan/tilt/zoom, plus the ONVIF credentials and media
// profile token needed to issue control commands later (stored at ONVIF add time so PTZ
// moves don't need to re-authenticate/re-query profiles each time). Credentials are as
// sensitive as the ones already embedded in rtsp_url, and are redacted from non-admin API
// responses the same way.
if (!camerasColumns.includes('ptz_supported')) {
  db.exec('ALTER TABLE cameras ADD COLUMN ptz_supported INTEGER NOT NULL DEFAULT 0');
}
if (!camerasColumns.includes('onvif_username')) {
  db.exec('ALTER TABLE cameras ADD COLUMN onvif_username TEXT');
}
if (!camerasColumns.includes('onvif_password')) {
  db.exec('ALTER TABLE cameras ADD COLUMN onvif_password TEXT');
}
if (!camerasColumns.includes('onvif_profile_token')) {
  db.exec('ALTER TABLE cameras ADD COLUMN onvif_profile_token TEXT');
}
// Whether this camera supports ONVIF RelativeMove — a single fixed-distance PTZ command the camera
// stops itself, which is far more predictable than start→hold→stop continuous moves on cameras whose
// ContinuousMove latency swings wildly (cheap Sonoff/thingino cams). null = not yet probed, 1 = yes
// (use RelativeMove), 0 = no (fall back to continuous+stop nudge). Probed lazily on first PTZ.
if (!camerasColumns.includes('ptz_relative')) {
  db.exec('ALTER TABLE cameras ADD COLUMN ptz_relative INTEGER');
}

// Admin can turn a camera off entirely (server-side): its transcoder is stopped and its
// MediaMTX path dropped, so it consumes no camera/server/network resources and disappears
// from the live grid, without deleting it. Distinct from the per-device "stop playback"
// toggle on a tile, which only tears down that one viewer's stream.
if (!camerasColumns.includes('disabled')) {
  db.exec('ALTER TABLE cameras ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0');
}

// Two-way audio (talk-back). The camera's speaker is reached by a "talk sink" whose type is
// talk_backend ('hikvision-isapi' | 'onvif-backchannel' | null=off). It needs its own credentials:
// on Hikvision the speaker is driven via ISAPI, which authenticates against the camera's regular
// web/ISAPI user database - SEPARATE from the ONVIF users we store in onvif_username/password (an
// ONVIF-only account gets 401 on ISAPI). Stored as sensitively as the ONVIF creds and redacted from
// non-admin API responses the same way.
if (!camerasColumns.includes('talk_backend')) {
  db.exec('ALTER TABLE cameras ADD COLUMN talk_backend TEXT');
}
if (!camerasColumns.includes('talk_username')) {
  db.exec('ALTER TABLE cameras ADD COLUMN talk_username TEXT');
}
if (!camerasColumns.includes('talk_password')) {
  db.exec('ALTER TABLE cameras ADD COLUMN talk_password TEXT');
}

// Adaptive stream quality: an optional lower-resolution sub-stream URL. Nearly every IP camera
// exposes a second, lower-bitrate RTSP endpoint in hardware (for Hikvision, .../Streaming/Channels/
// 102), giving a "Low" quality tier at zero server-side transcoding cost - a fallback for congested
// connections (WebRTC can then drop to it instead of just stuttering). When set, the transcoder runs
// a second leg publishing this into a `<path>-sub` MediaMTX path. Full URL (with creds) like
// rtsp_url, so a camera whose sub-stream uses a different path/host still works; redacted from
// non-admin API responses.
if (!camerasColumns.includes('sub_rtsp_url')) {
  db.exec('ALTER TABLE cameras ADD COLUMN sub_rtsp_url TEXT');
}

// Motion detection (server-side, per camera). Off by default. When enabled, a cheap
// low-res/low-fps FFmpeg leg (off the sub-stream when there is one) frame-diffs the video
// and logs a detection_event when movement is sustained past the confirmation delay, no
// more than once per cooldown. detect_zone is an optional JSON {x,y,w,h} rectangle in
// 0..1 frame fractions to restrict detection to (e.g. just the crib); null = whole frame.
// See lib/motionDetector.js.
if (!camerasColumns.includes('detect_motion_enabled')) {
  db.exec('ALTER TABLE cameras ADD COLUMN detect_motion_enabled INTEGER NOT NULL DEFAULT 0');
}
if (!camerasColumns.includes('detect_zone')) {
  db.exec('ALTER TABLE cameras ADD COLUMN detect_zone TEXT');
}
if (!camerasColumns.includes('detect_sensitivity')) {
  db.exec('ALTER TABLE cameras ADD COLUMN detect_sensitivity INTEGER NOT NULL DEFAULT 50');
}
if (!camerasColumns.includes('detect_cooldown_s')) {
  db.exec('ALTER TABLE cameras ADD COLUMN detect_cooldown_s INTEGER NOT NULL DEFAULT 60');
}
if (!camerasColumns.includes('detect_confirm_s')) {
  db.exec('ALTER TABLE cameras ADD COLUMN detect_confirm_s INTEGER NOT NULL DEFAULT 3');
}

// Optional per-camera active window for motion alerts ("quiet hours"): when enabled, motion outside
// the window is fully ignored (no push, no in-app alert). detect_start/detect_end are minutes since
// midnight (0..1439) in the app's configured timezone; start > end means the window wraps midnight
// (e.g. 20:00–07:00). Off by default = alert 24/7.
if (!camerasColumns.includes('detect_schedule_enabled')) {
  db.exec('ALTER TABLE cameras ADD COLUMN detect_schedule_enabled INTEGER NOT NULL DEFAULT 0');
  db.exec('ALTER TABLE cameras ADD COLUMN detect_start INTEGER NOT NULL DEFAULT 0');
  db.exec('ALTER TABLE cameras ADD COLUMN detect_end INTEGER NOT NULL DEFAULT 0');
}

// Sound detection: a separate audio-loudness detector (lib/soundDetector.js), parallel to motion.
// It tracks each camera's rolling ambient level (so a white-noise machine/fan is learned, not a
// one-time boot calibration) and fires when the level stays a sensitivity-controlled margin above
// that ambient for sound_confirm_s, rate-limited by sound_cooldown_s. Shares the per-camera
// quiet-hours schedule with motion. Off by default.
if (!camerasColumns.includes('detect_sound_enabled')) {
  db.exec('ALTER TABLE cameras ADD COLUMN detect_sound_enabled INTEGER NOT NULL DEFAULT 0');
  db.exec('ALTER TABLE cameras ADD COLUMN sound_sensitivity INTEGER NOT NULL DEFAULT 50');
  db.exec('ALTER TABLE cameras ADD COLUMN sound_confirm_s INTEGER NOT NULL DEFAULT 4');
  db.exec('ALTER TABLE cameras ADD COLUMN sound_cooldown_s INTEGER NOT NULL DEFAULT 120');
}

// Detection source: 'framediff' (the server-side frame-diff detector, the universal default) or
// 'mqtt' (the camera detects motion itself and publishes it — thingino/sonoff-hack etc. — which
// costs the server ~nothing). For 'mqtt', motion_mqtt_topic is the topic the camera publishes to,
// and motion_mqtt_value is an optional payload matcher override (blank = the built-in smart matcher).
// snapshot_url is an optional camera HTTP snapshot endpoint used for the alert image (avoids the
// stream keyframe-wait); it benefits BOTH sources. See lib/mqttClient.js + lib/detectionAlert.js.
if (!camerasColumns.includes('detect_source')) {
  db.exec("ALTER TABLE cameras ADD COLUMN detect_source TEXT NOT NULL DEFAULT 'framediff'");
  db.exec('ALTER TABLE cameras ADD COLUMN motion_mqtt_topic TEXT');
  db.exec('ALTER TABLE cameras ADD COLUMN motion_mqtt_value TEXT');
  db.exec('ALTER TABLE cameras ADD COLUMN snapshot_url TEXT');
}

// base_url: the origin the app reaches this server through (window.location.origin), reported on
// push registration. Used to build a device-fetchable snapshot URL for FCM image alerts — FCM
// downloads the picture by URL (unlike Pushover, which takes the bytes), so it must be a base the
// phone can actually reach (LAN IP or public domain, whichever that device used).
const pushTokenColumns = db.prepare('PRAGMA table_info(push_tokens)').all().map((c) => c.name);
if (!pushTokenColumns.includes('base_url')) {
  db.exec('ALTER TABLE push_tokens ADD COLUMN base_url TEXT');
}

// snapshot: 1 when the alert-time image was captured and saved to disk (DATA_DIR/detection-snapshots/
// <id>.jpg), so the in-app Alerts feed knows to show a thumbnail. See lib/detectionEvents.js.
const detectionEventsColumns = db.prepare('PRAGMA table_info(detection_events)').all().map((c) => c.name);
if (!detectionEventsColumns.includes('snapshot')) {
  db.exec('ALTER TABLE detection_events ADD COLUMN snapshot INTEGER NOT NULL DEFAULT 0');
}

// Ensure the single settings row always exists.
db.prepare(
  `INSERT OR IGNORE INTO settings (id, app_name, accent_color, live_color, offline_color, timezone, font_choice, temp_unit)
   VALUES ('app', 'Nightlight', '#f4c56a', '#7FBFA3', '#E08585', 'UTC', 'warm-serif', 'C')`
).run();

// The default accent moved from the old pale gold (#F5D9A8) to the deeper gold (#f4c56a) that
// the refreshed UI uses. Migrate installs still on the exact old default to the new one; a value
// that isn't the old default means the user picked their own colour, so leave it untouched.
db.prepare("UPDATE settings SET accent_color = '#f4c56a' WHERE accent_color = '#F5D9A8'").run();

export default db;
