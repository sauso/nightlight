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

  -- Historical temperature/humidity samples, one row per camera per sample tick (see
  -- lib/sensorSampler.js). MQTT temp/humidity is otherwise live-only (getReading in mqttClient);
  -- this persists it over time so the app can chart trends and (Stage 2) correlate overnight
  -- warmth with wake-ups. Same denormalized, FK-free, pruned shape as the event tables above -
  -- camera_id is a loose reference, not a foreign key, so history survives a camera being removed.
  CREATE TABLE IF NOT EXISTS sensor_readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    camera_id TEXT NOT NULL,
    temperature REAL,
    humidity REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_sensor_readings_cam_time ON sensor_readings(camera_id, created_at);

  -- Per-minute activity timeline for sleep tracking (see lib/activityTracker.js). The motion and
  -- sound DETECTORS already compute a continuous signal each ~5/s (motion = fraction of the zone that
  -- changed; sound = dB above a rolling ambient baseline), but detection_events are cooldown-throttled
  -- and far too coarse to infer sleep. This buckets the raw signal into one row per camera per minute -
  -- a real overnight movement/noise timeline the nightly sleep computation (Stage 2 phase 3) reads.
  -- levels are null when that detector wasn't running; the *_frames/_windows counts are the coverage.
  -- Same FK-free, denormalized, pruned shape as the event tables. bucket_start is a UTC minute.
  CREATE TABLE IF NOT EXISTS activity_samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    camera_id TEXT NOT NULL,
    bucket_start TEXT NOT NULL,
    motion_level REAL,
    motion_peak REAL,
    sound_level REAL,
    sound_peak REAL,
    motion_frames INTEGER NOT NULL DEFAULT 0,
    sound_windows INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_activity_samples_cam_time ON activity_samples(camera_id, bucket_start);

  -- One computed sleep summary per child per night (see lib/sleepAnalysis.js). A nightly job reads the
  -- child's cameras' activity_samples over the configured night window, infers asleep/awake per minute,
  -- and stores the derived metrics here so the app shows "last night" without recomputing. night_date is
  -- the LOCAL calendar date the night started (its evening). UNIQUE(child_id, night_date) so a recompute
  -- (after tuning) overwrites rather than duplicates. Times are UTC; status: ok | no_sleep | no_data.
  CREATE TABLE IF NOT EXISTS sleep_nights (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    child_id TEXT NOT NULL,
    night_date TEXT NOT NULL,
    window_start TEXT NOT NULL,
    window_end TEXT NOT NULL,
    status TEXT NOT NULL,
    onset_at TEXT,
    wake_at TEXT,
    asleep_minutes INTEGER,
    awake_minutes INTEGER,
    wake_count INTEGER,
    longest_stretch_minutes INTEGER,
    coverage_minutes INTEGER,
    computed_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (child_id, night_date)
  );

  -- Bed-boundary transition events from the frame-diff detector: a child leaving the bed
  -- ('out_of_bed') or being placed into it ('into_bed'), classified by the SEQUENCE of the in-bed vs
  -- outside-bed motion channels (see lib/motionDetector.js). Low-rate signal, distinct from the
  -- cooldown-throttled detection_events alert feed and NOT surfaced there. sleepAnalysis reads these to
  -- correct onset (gate on the last into_bed before sleep) and wake (the terminal out_of_bed for the
  -- day, even past the window). Denormalized camera_id (no FK), pruned by age. Times are UTC text.
  CREATE TABLE IF NOT EXISTS bed_transitions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    camera_id TEXT NOT NULL,
    type TEXT NOT NULL,
    peak REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_bed_transitions_cam_time ON bed_transitions(camera_id, created_at);

  -- One "memories" timelapse per child per night (spec A3): the sleep window's sampled frames
  -- assembled into a short MP4. Kept in its OWN table (not detection_events) so keepsakes never
  -- leak into the alert feed / clip-management list and aren't swept by clip retention — they get
  -- their own keep-last-N-per-child prune (lib/timelapse.js). path/thumb_path are relative to
  -- CLIPS_DIR. night_date is the child's local window-start date; created_at is UTC text.
  CREATE TABLE IF NOT EXISTS timelapses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    child_id TEXT NOT NULL,
    night_date TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    path TEXT,
    thumb_path TEXT,
    frame_count INTEGER,
    duration_s INTEGER,
    bytes INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_timelapses_child_night ON timelapses(child_id, night_date);

  -- On-demand ("Record" button) recordings. Deliberately their OWN table rather than detection_events,
  -- for the same reason timelapses got one: these are keepsakes a person chose to capture, and mixing
  -- them into the alert feed would both bury them among motion/sound events and expose them to the
  -- clip retention sweeper, which would quietly delete the very moments someone meant to keep.
  -- started_at already includes the pre-roll reach-back, so it is the true first frame of the video.
  CREATE TABLE IF NOT EXISTS recordings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    camera_id TEXT NOT NULL,
    child_id TEXT,
    status TEXT NOT NULL DEFAULT 'recording',
    started_at TEXT NOT NULL,
    ended_at TEXT,
    duration_s INTEGER,
    path TEXT,
    thumb_path TEXT,
    bytes INTEGER,
    triggered_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_recordings_child ON recordings(child_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_recordings_camera ON recordings(camera_id, created_at DESC);

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
// Optional TOTP two-factor auth (added later). mfa_secret is the base32 shared secret (kept while a
// setup is pending AND once enabled); mfa_backup_codes is a JSON array of bcrypt-hashed one-time
// recovery codes. mfa_enabled gates whether login requires the second step.
if (!usersColumns.includes('mfa_enabled')) {
  db.exec('ALTER TABLE users ADD COLUMN mfa_enabled INTEGER NOT NULL DEFAULT 0');
}
if (!usersColumns.includes('mfa_secret')) {
  db.exec('ALTER TABLE users ADD COLUMN mfa_secret TEXT');
}
if (!usersColumns.includes('mfa_backup_codes')) {
  db.exec('ALTER TABLE users ADD COLUMN mfa_backup_codes TEXT');
}
// Optional caregiver/admin avatar photo — same browser-resized base64 data-URL as children.photo.
if (!usersColumns.includes('photo')) {
  db.exec('ALTER TABLE users ADD COLUMN photo TEXT');
}

// Optional child avatar photo — a browser-resized (~256px square) base64 data-URL, stored inline
// (small; the frontend caps the size). Null = fall back to the coloured initials avatar.
const childrenColumns = db.prepare('PRAGMA table_info(children)').all().map((c) => c.name);
if (!childrenColumns.includes('photo')) {
  db.exec('ALTER TABLE children ADD COLUMN photo TEXT');
}

// Per-child sleep tracking (Stage 2). track_sleep gates whether we run the activity leg + compute a
// nightly summary for this child; sleep_window_start/_end are that child's bedtime/wake window (local
// HH:MM, wraps midnight) — replacing the old single global window. Existing children default to ON with
// the previous 19:00-07:00 default so behaviour is unchanged. See lib/sleepAnalysis.js.
if (!childrenColumns.includes('track_sleep')) {
  db.exec('ALTER TABLE children ADD COLUMN track_sleep INTEGER NOT NULL DEFAULT 1');
  db.exec("ALTER TABLE children ADD COLUMN sleep_window_start TEXT NOT NULL DEFAULT '19:00'");
  db.exec("ALTER TABLE children ADD COLUMN sleep_window_end TEXT NOT NULL DEFAULT '07:00'");
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

// Optional Pushover target device(s). Blank/NULL = deliver to all of the user's devices (Pushover's
// default); a device name (or comma-separated list) limits delivery to just those. Not a secret, so
// unlike the tokens it round-trips to the UI in the clear. Separate idempotent migration so existing
// installs pick it up too.
if (!settingsColumns.includes('pushover_device')) {
  db.exec('ALTER TABLE settings ADD COLUMN pushover_device TEXT');
}

// ntfy notifications (https://ntfy.sh, or any self-hosted ntfy server) — the server POSTs the alert
// to a topic; the recipient subscribes in the ntfy app/browser. Optional auth via an access token
// (bearer) or username/password (basic). Off until configured + enabled.
if (!settingsColumns.includes('ntfy_enabled')) {
  db.exec('ALTER TABLE settings ADD COLUMN ntfy_enabled INTEGER NOT NULL DEFAULT 0');
  db.exec("ALTER TABLE settings ADD COLUMN ntfy_server_url TEXT NOT NULL DEFAULT 'https://ntfy.sh'");
  db.exec('ALTER TABLE settings ADD COLUMN ntfy_topic TEXT');
  db.exec('ALTER TABLE settings ADD COLUMN ntfy_token TEXT');
  db.exec('ALTER TABLE settings ADD COLUMN ntfy_username TEXT');
  db.exec('ALTER TABLE settings ADD COLUMN ntfy_password TEXT');
}

// Gotify notifications (self-hosted https://gotify.net) — the server POSTs to a Gotify application's
// message endpoint with its app token; the recipient runs the Gotify server + app. Text only (Gotify
// has no native image attachments). Off until configured + enabled.
if (!settingsColumns.includes('gotify_enabled')) {
  db.exec('ALTER TABLE settings ADD COLUMN gotify_enabled INTEGER NOT NULL DEFAULT 0');
  db.exec('ALTER TABLE settings ADD COLUMN gotify_server_url TEXT');
  db.exec('ALTER TABLE settings ADD COLUMN gotify_app_token TEXT');
  db.exec('ALTER TABLE settings ADD COLUMN gotify_priority INTEGER NOT NULL DEFAULT 5');
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

// Event recording (Stage 1): how much of the stream to keep around each detection. clip_pre_roll_s
// is seconds BEFORE the trigger (drives how deep the segmenter ring must be), clip_post_roll_s is
// seconds after. Global defaults 5s/15s; bounds enforced in routes/settings.js. See lib/clipCapture.js.
if (!settingsColumns.includes('clip_pre_roll_s')) {
  db.exec('ALTER TABLE settings ADD COLUMN clip_pre_roll_s INTEGER NOT NULL DEFAULT 5');
  db.exec('ALTER TABLE settings ADD COLUMN clip_post_roll_s INTEGER NOT NULL DEFAULT 15');
}

// On-demand recording (the tile's Record button). ondemand_enabled gates the whole feature: while it's
// on, every enabled camera keeps a rolling ring so Record can reach BACKWARD by ondemand_pre_roll_s and
// capture the moment before the button was pressed — that buffering is the cost the toggle turns off.
// ondemand_max_duration_s auto-stops a forgotten recording so it can't grow unbounded or fill the disk.
// Defaults on / 30s back / 2 min cap; bounds enforced in routes/settings.js. See lib/recordings.js.
if (!settingsColumns.includes('ondemand_enabled')) {
  db.exec('ALTER TABLE settings ADD COLUMN ondemand_enabled INTEGER NOT NULL DEFAULT 1');
  db.exec('ALTER TABLE settings ADD COLUMN ondemand_pre_roll_s INTEGER NOT NULL DEFAULT 30');
  db.exec('ALTER TABLE settings ADD COLUMN ondemand_max_duration_s INTEGER NOT NULL DEFAULT 120');
}

// Clip retention (Stage 1 phase 3): clips are deleted when EITHER bound is exceeded — older than
// clip_retention_days, OR total clip size over clip_retention_max_gb (oldest deleted first). 0 =
// that bound is off. Defaults 14 days / 5 GB. The cap is what makes sharing the SSD safe by default.
// See lib/clipStorage.js.
if (!settingsColumns.includes('clip_retention_days')) {
  db.exec('ALTER TABLE settings ADD COLUMN clip_retention_days INTEGER NOT NULL DEFAULT 14');
  db.exec('ALTER TABLE settings ADD COLUMN clip_retention_max_gb INTEGER NOT NULL DEFAULT 5');
}

// Offline-camera notification: push an alert when a camera stops delivering frames for longer than
// camera_offline_alert_minutes (one push per outage, plus a "back online" push on recovery). The
// watchdog in index.js already tracks per-camera up/down; this just gates a notification off that.
// Off by default; threshold in whole minutes (bounds enforced in routes/settings.js).
if (!settingsColumns.includes('camera_offline_alert_enabled')) {
  db.exec('ALTER TABLE settings ADD COLUMN camera_offline_alert_enabled INTEGER NOT NULL DEFAULT 0');
  db.exec('ALTER TABLE settings ADD COLUMN camera_offline_alert_minutes INTEGER NOT NULL DEFAULT 5');
}

// Sleep tracking (Stage 2): the nightly "night window" in the app timezone, as 'HH:MM' local times.
// The window bounds where sleep is inferred from the per-minute activity timeline; it wraps midnight
// when end <= start (the default 19:00–07:00). Global for now; a per-child override can come later.
if (!settingsColumns.includes('sleep_window_start')) {
  db.exec("ALTER TABLE settings ADD COLUMN sleep_window_start TEXT NOT NULL DEFAULT '19:00'");
  db.exec("ALTER TABLE settings ADD COLUMN sleep_window_end TEXT NOT NULL DEFAULT '07:00'");
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
// Whether the camera advertises a motion event topic over its ONVIF Event service (captured at
// ONVIF add/re-probe time). Gates the "Camera via ONVIF" motion source — a camera can speak ONVIF
// for streaming/PTZ yet expose no event service, where an ONVIF motion subscription would sit idle.
if (!camerasColumns.includes('onvif_motion_capable')) {
  db.exec('ALTER TABLE cameras ADD COLUMN onvif_motion_capable INTEGER NOT NULL DEFAULT 0');
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
// 0..1 frame fractions to restrict detection to (e.g. just the bed); null = whole frame.
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

// Event-recording opt-in, per camera (separate from alerts — every detection still logs an event +
// snapshot; a video clip is only captured when this is on). Turning it on starts that camera's
// segmenter (lib/clipCapture.js). Off by default so a camera costs no disk unless asked. See
// the CHANGELOG entry for 0.17.0.
if (!camerasColumns.includes('detect_record_clips')) {
  db.exec('ALTER TABLE cameras ADD COLUMN detect_record_clips INTEGER NOT NULL DEFAULT 0');
}

// snapshot: 1 when the alert-time image was captured and saved to disk (DATA_DIR/detection-snapshots/
// <id>.jpg), so the in-app Alerts feed knows to show a thumbnail. See lib/detectionEvents.js.
const detectionEventsColumns = db.prepare('PRAGMA table_info(detection_events)').all().map((c) => c.name);
if (!detectionEventsColumns.includes('snapshot')) {
  db.exec('ALTER TABLE detection_events ADD COLUMN snapshot INTEGER NOT NULL DEFAULT 0');
}

// Clip columns on the same detection_events row (Stage 1 recording). clip_status: NULL = no clip for
// this event (recording was off), 'pending' = capture enqueued/in progress, 'ready' = clip_path is a
// playable MP4, 'failed' = capture errored. clip_path is relative to CLIPS_DIR. The event's existing
// JPEG snapshot doubles as the clip thumbnail. See lib/clipCapture.js + lib/clipRecorder.js.
if (!detectionEventsColumns.includes('clip_status')) {
  db.exec('ALTER TABLE detection_events ADD COLUMN clip_status TEXT');
  db.exec('ALTER TABLE detection_events ADD COLUMN clip_path TEXT');
  db.exec('ALTER TABLE detection_events ADD COLUMN clip_duration_s INTEGER');
  db.exec('ALTER TABLE detection_events ADD COLUMN clip_bytes INTEGER');
}

// Outside-the-bed motion channel on activity_samples (sleep tracking). When a camera has a bed zone,
// the motion detector now also measures movement OUTSIDE that zone — a parent coming in, or the child
// out of bed — kept separate from the in-bed motion so the sleep timeline can distinguish stirring in
// the bed from someone moving around the room. Null when there's no bed zone (whole-frame = no
// "outside") or the detector wasn't running. See lib/activityTracker.js + lib/motionDetector.js.
const activitySamplesColumns = db.prepare('PRAGMA table_info(activity_samples)').all().map((c) => c.name);
if (!activitySamplesColumns.includes('motion_out_peak')) {
  db.exec('ALTER TABLE activity_samples ADD COLUMN motion_out_level REAL');
  db.exec('ALTER TABLE activity_samples ADD COLUMN motion_out_peak REAL');
}

// Sleep Stage 2 phase 5 (temp/humidity correlation): store each computed night's average room
// temperature (Celsius) and humidity (%), derived from the child's cameras' sensor_readings over the
// window. Kept on the night row so the insights correlation reads them without re-scanning sensor
// history. Null when the child's cameras have no MQTT sensor. See lib/sleepAnalysis.js (nightClimate).
const sleepNightsColumns = db.prepare('PRAGMA table_info(sleep_nights)').all().map((c) => c.name);
if (!sleepNightsColumns.includes('avg_temperature')) {
  db.exec('ALTER TABLE sleep_nights ADD COLUMN avg_temperature REAL');
  db.exec('ALTER TABLE sleep_nights ADD COLUMN avg_humidity REAL');
}

// Automatic wake clips (roadmap 2.4). A wake detected by the sleep tracker records a short clip so
// there is something to look at in the morning, WITHOUT firing an alert — measured over 101 prod
// wakes, 53% never alert, because the tracker counts a minute active on a ~200 ms blip while an alert
// needs 2-3 seconds sustained. `kind` keeps those automatic clips out of the manual keepsakes list:
// a manual recording is something a person chose to keep and is never auto-deleted, whereas wake clips
// accumulate nightly and are pruned on a retention window like alert clips.
const recordingsColumns = db.prepare('PRAGMA table_info(recordings)').all().map((c) => c.name);
if (!recordingsColumns.includes('kind')) {
  db.exec("ALTER TABLE recordings ADD COLUMN kind TEXT NOT NULL DEFAULT 'manual'");
  db.exec('CREATE INDEX IF NOT EXISTS idx_recordings_kind ON recordings(kind, created_at DESC)');
}

// Onset/wake derived from the out-of-bed / into-bed transition events (bed_transitions below). These
// were introduced as shadow values for validation; they are now what onset_at/wake_at are set from when
// a transition corroborates them, and are still recorded separately so the promotion stays auditable
// (and revertible). See lib/sleepAnalysis.js.
if (!sleepNightsColumns.includes('onset_at_shadow')) {
  db.exec('ALTER TABLE sleep_nights ADD COLUMN onset_at_shadow TEXT');
  db.exec('ALTER TABLE sleep_nights ADD COLUMN wake_at_shadow TEXT');
}

// The transition-derived times are now the AUTHORITATIVE onset_at/wake_at (sleepAnalysis's
// USE_TRANSITION_TIMES). These keep the movement-only figures the app used before that promotion, so the
// two methods stay comparable night by night and a regression is visible rather than silent. Nullable:
// rows computed before this migration simply have no algo value recorded.
if (!sleepNightsColumns.includes('onset_at_algo')) {
  db.exec('ALTER TABLE sleep_nights ADD COLUMN onset_at_algo TEXT');
  db.exec('ALTER TABLE sleep_nights ADD COLUMN wake_at_algo TEXT');
}

// Quick-silence: a per-camera temporary mute of ALL alerts (motion/sound/ONVIF/MQTT), for when you're
// still up as the alert schedule kicks in. Epoch millis; NULL/past = not muted. inActiveWindow() reads
// it fresh each check so a snooze set from the UI takes effect without restarting the detector leg.
if (!camerasColumns.includes('alerts_snoozed_until')) {
  db.exec('ALTER TABLE cameras ADD COLUMN alerts_snoozed_until INTEGER');
}

// Push a notification when a child's nightly sleep report is computed (window closed + row stored).
// On by default; fires only for a freshly-closed night (a mid-day restart re-computing an old night
// does not re-notify). See lib/sleepReportAlert.js.
if (!settingsColumns.includes('sleep_report_alert_enabled')) {
  db.exec('ALTER TABLE settings ADD COLUMN sleep_report_alert_enabled INTEGER NOT NULL DEFAULT 1');
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
