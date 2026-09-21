import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import db from '../db.js';
import * as sleep from './sleepAnalysis.js';

const CHILDREN = [
  { id: 'demo-child-avery', name: 'Avery', color: '#9ec5e5', cameraId: 'demo-camera-avery', cameraName: 'Avery camera', mediaPath: 'demo-avery' },
  { id: 'demo-child-riley', name: 'Riley', color: '#d8b4d8', cameraId: 'demo-camera-riley', cameraName: 'Riley camera', mediaPath: 'demo-riley' },
];
const WINDOW_START = '19:00';
const WINDOW_END = '07:00';
const HISTORY_NIGHTS = 14;
const MINUTE_MS = 60_000;
// Found by code review 2026-09-21: a real cost-12 bcrypt hash made every public password attempt do
// synchronous work on the shared CPU. This non-bcrypt sentinel is structurally unusable and rejects
// immediately; only POST /api/auth/guest can mint this identity's sessions.
const GUEST_PASSWORD_HASH = '!';

function localDateAt(instant, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant).reduce((all, part) => ({ ...all, [part.type]: part.value }), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function shiftDate(date, days) {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function windowBounds(nightDate, timezone, zonedToUtc) {
  const [year, month, day] = nightDate.split('-').map(Number);
  return {
    start: zonedToUtc(year, month - 1, day, 19, 0, timezone),
    end: zonedToUtc(year, month - 1, day + 1, 7, 0, timezone),
  };
}

function seededRandom(label) {
  let state = 2166136261;
  for (const char of label) {
    state ^= char.charCodeAt(0);
    state = Math.imul(state, 16777619);
  }
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function integerBetween(random, min, max) {
  return min + Math.floor(random() * (max - min + 1));
}

function isMainModule() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

/** Seed a complete public-demo database. The clock seam keeps boot-relative data reproducible in tests. */
export async function seedDemo(clock = () => new Date()) {
  const clockValue = clock();
  const now = clockValue instanceof Date ? new Date(clockValue.getTime()) : new Date(clockValue);
  if (!Number.isFinite(now.getTime())) throw new TypeError('clock must return a valid Date or timestamp');

  const { computeAndStoreNight, computeNight, toSqlUtc, zonedToUtc } = sleep;

  const timezone = process.env.DEMO_TIMEZONE || 'UTC';
  // Ask Intl to reject an invalid configured zone before any rows are written.
  localDateAt(now, timezone);
  const endsAt = new Date(process.env.DEMO_ENDS_AT || now.getTime() + 20 * MINUTE_MS);
  if (!Number.isFinite(endsAt.getTime()) || endsAt < now) {
    throw new Error('DEMO_ENDS_AT must be a valid instant at or after the seed clock');
  }

  const dataDir = path.resolve(process.env.DATA_DIR || '/app/data');
  const clipsDir = path.resolve(process.env.CLIPS_DIR || path.join(dataDir, 'clips'));
  const assetDir = path.resolve(process.env.DEMO_ASSET_DIR || '/app/demo');
  const loopSource = path.join(assetDir, 'loop.mp4');
  const posterSource = path.join(assetDir, 'loop.jpg');
  if (!fs.existsSync(loopSource) || !fs.existsSync(posterSource)) {
    throw new Error(`demo media assets are missing from ${assetDir}`);
  }

  const snapshotsDir = path.join(dataDir, 'detection-snapshots');
  const seededClipsDir = path.join(clipsDir, 'demo-seed');
  fs.rmSync(snapshotsDir, { recursive: true, force: true });
  fs.rmSync(seededClipsDir, { recursive: true, force: true });
  fs.mkdirSync(snapshotsDir, { recursive: true });
  fs.mkdirSync(seededClipsDir, { recursive: true });

  const today = localDateAt(now, timezone);
  const candidateDates = [today, shiftDate(today, -1)];
  const currentNight = candidateDates.find((date) => {
    const { start, end } = windowBounds(date, timezone, zonedToUtc);
    // Found by code review 2026-09-21: a session can begin just before 19:00 and cross into the
    // window while live demo sampling is disabled. Seed any night overlapping the demo session.
    return start < endsAt && now < end;
  }) || null;
  let lastCompleted = today;
  while (windowBounds(lastCompleted, timezone, zonedToUtc).end > now) {
    lastCompleted = shiftDate(lastCompleted, -1);
  }
  const completedNights = Array.from({ length: HISTORY_NIGHTS }, (_, index) => shiftDate(lastCompleted, -index));
  const createdAt = toSqlUtc(now);

  const resetTables = [
    'push_tokens', 'sessions', 'sleep_reviews', 'sleep_nights', 'bed_transitions',
    'activity_samples', 'sensor_readings', 'detection_events', 'camera_events',
    'recordings', 'timelapses', 'cameras', 'children', 'users',
  ];
  const insertSample = db.prepare(
    `INSERT INTO activity_samples
       (camera_id, bucket_start, motion_level, motion_peak, sound_level, sound_peak,
        motion_frames, sound_windows, motion_out_level, motion_out_peak, created_at)
     VALUES (?, ?, ?, ?, NULL, NULL, 5, 0, NULL, NULL, ?)`
  );

  function seedSamples(child, nightDate, seedUntil = null, bedtimeBefore = null) {
    const random = seededRandom(`${child.id}:${nightDate}`);
    const { start, end } = windowBounds(nightDate, timezone, zonedToUtc);
    const generatedBedtimeMinute = integerBetween(random, 10, 50);
    // The 25-minute head start came from the 2026-09-21 demo build review: it leaves enough quiet
    // coverage for an already-open night to stay scored as its analysis window grows after boot.
    const latestBedtimeMinute = bedtimeBefore
      ? Math.floor((bedtimeBefore.getTime() - start.getTime()) / MINUTE_MS) - 25
      : generatedBedtimeMinute;
    const bedtimeMinute = Math.min(generatedBedtimeMinute, latestBedtimeMinute);
    const wakeMinute = 11 * 60 + integerBetween(random, 0, 60);
    const wakeCount = integerBetween(random, 1, 3);
    const wakeRuns = [];
    for (let index = 0; index < wakeCount; index += 1) {
      const centre = 150 + Math.floor(((index + 1) * 420) / (wakeCount + 1)) + integerBetween(random, -20, 20);
      wakeRuns.push([centre, centre + integerBetween(random, 5, 9)]);
    }
    const final = seedUntil && seedUntil > end ? seedUntil : end;
    for (let time = start.getTime() - 70 * MINUTE_MS; time <= final.getTime(); time += MINUTE_MS) {
      const minute = Math.round((time - start.getTime()) / MINUTE_MS);
      const active = minute < bedtimeMinute
        || wakeRuns.some(([from, through]) => minute >= from && minute < through)
        || minute >= wakeMinute;
      const peak = active ? 0.46 + random() * 0.08 : 0.003 + random() * 0.002;
      insertSample.run(child.cameraId, toSqlUtc(new Date(time)), peak, peak, createdAt);
    }
  }

  const seedDatabase = db.transaction(() => {
    for (const table of resetTables) db.prepare(`DELETE FROM ${table}`).run();
    db.prepare(
      `DELETE FROM sqlite_sequence
        WHERE name IN ('activity_samples', 'detection_events', 'recordings', 'timelapses',
                       'sleep_nights', 'bed_transitions', 'sensor_readings', 'camera_events')`
    ).run();

    db.prepare(
      `UPDATE settings SET
         timezone = ?, mqtt_enabled = 0, mqtt_host = NULL, mqtt_port = NULL,
         mqtt_username = NULL, mqtt_password = NULL, push_enabled = 0,
         pushover_enabled = 0, pushover_app_token = NULL, pushover_user_key = NULL,
         pushover_device = NULL, ntfy_enabled = 0, ntfy_topic = NULL, ntfy_token = NULL,
         ntfy_username = NULL, ntfy_password = NULL, gotify_enabled = 0,
         gotify_server_url = NULL, gotify_app_token = NULL, public_base_url = NULL,
         clip_retention_days = 0, clip_retention_max_gb = 0,
         wake_clip_retention_days = 0, wake_clips_enabled = 0,
         camera_offline_alert_enabled = 0, sleep_report_alert_enabled = 0
       WHERE id = 'app'`
    ).run(timezone);

    db.prepare(
      `INSERT INTO users
         (id, username, password_hash, role, first_name, last_name, mfa_enabled,
          mfa_secret, mfa_backup_codes, created_at)
       VALUES ('demo-guest-user', 'demo-guest', ?, 'admin', 'Demo', 'Guest', 0, NULL, NULL, ?)`
    ).run(GUEST_PASSWORD_HASH, createdAt);

    const insertChild = db.prepare(
      `INSERT INTO children
         (id, name, color, track_sleep, sleep_window_start, sleep_window_end, created_at)
       VALUES (?, ?, ?, 1, ?, ?, ?)`
    );
    const insertCamera = db.prepare(
      `INSERT INTO cameras
         (id, name, rtsp_url, child_id, mediamtx_path, sort_order, mqtt_topic, disabled,
          detect_motion_enabled, detect_sound_enabled, detect_record_clips, motion_mqtt_topic,
          motion_mqtt_value, snapshot_url, created_at)
       VALUES (?, ?, 'rtsp://127.0.0.1:8555/demo', ?, ?, 0, NULL, 0, 0, 0, 0,
               NULL, NULL, NULL, ?)`
    );
    for (const child of CHILDREN) {
      insertChild.run(child.id, child.name, child.color, WINDOW_START, WINDOW_END, createdAt);
      insertCamera.run(child.cameraId, child.cameraName, child.id, child.mediaPath, createdAt);
      for (const nightDate of completedNights) seedSamples(child, nightDate);
      if (currentNight) {
        const { start } = windowBounds(currentNight, timezone, zonedToUtc);
        seedSamples(child, currentNight, endsAt, start <= now ? now : null);
      }
    }

    for (const child of CHILDREN) {
      for (const nightDate of completedNights.slice().reverse()) {
        const summary = computeAndStoreNight(child.id, nightDate, { allowDowngrade: false });
        if (summary.status !== 'ok') {
          throw new Error(`completed demo night ${child.id}/${nightDate} computed as ${summary.status}`);
        }
      }
      if (currentNight) computeAndStoreNight(child.id, currentNight, { allowDowngrade: false });
    }

    const insertEvent = db.prepare(
      `INSERT INTO detection_events
         (camera_id, camera_name, type, detail, created_at, snapshot, clip_status)
       VALUES (?, ?, ?, ?, ?, 1, NULL)`
    );
    for (let index = 0; index < 16; index += 1) {
      const child = CHILDREN[index % CHILDREN.length];
      const eventAt = new Date(now.getTime() - (index + 1) * 47 * MINUTE_MS);
      const info = insertEvent.run(
        child.cameraId,
        child.cameraName,
        index % 3 === 0 ? 'sound' : 'motion',
        index % 3 === 0 ? 'Brief sound above the sample baseline' : 'Movement in the sample crib',
        toSqlUtc(eventAt),
      );
      fs.copyFileSync(posterSource, path.join(snapshotsDir, `${info.lastInsertRowid}.jpg`));
    }

    const insertRecording = db.prepare(
      `INSERT INTO recordings
         (camera_id, child_id, status, started_at, ended_at, duration_s, path,
          thumb_path, bytes, triggered_by, kind, created_at)
       VALUES (?, ?, 'ready', ?, ?, 12, ?, ?, ?, 'demo', 'manual', ?)`
    );
    const insertTimelapse = db.prepare(
      `INSERT INTO timelapses
         (child_id, night_date, status, path, thumb_path, frame_count, duration_s, bytes, created_at)
       VALUES (?, ?, 'ready', ?, ?, 180, 12, ?, ?)`
    );
    for (const child of CHILDREN) {
      const recordingPath = path.posix.join('demo-seed', `${child.id}-recording.mp4`);
      const recordingThumb = path.posix.join('demo-seed', `${child.id}-recording.jpg`);
      const timelapsePath = path.posix.join('demo-seed', `${child.id}-timelapse.mp4`);
      const timelapseThumb = path.posix.join('demo-seed', `${child.id}-timelapse.jpg`);
      for (const relative of [recordingPath, timelapsePath]) {
        fs.copyFileSync(loopSource, path.join(clipsDir, ...relative.split('/')));
      }
      for (const relative of [recordingThumb, timelapseThumb]) {
        fs.copyFileSync(posterSource, path.join(clipsDir, ...relative.split('/')));
      }
      const videoBytes = fs.statSync(path.join(clipsDir, ...recordingPath.split('/'))).size;
      const started = new Date(now.getTime() - 90 * MINUTE_MS);
      insertRecording.run(
        child.cameraId,
        child.id,
        toSqlUtc(started),
        toSqlUtc(new Date(started.getTime() + 12_000)),
        recordingPath,
        recordingThumb,
        videoBytes,
        toSqlUtc(started),
      );
      insertTimelapse.run(
        child.id,
        lastCompleted,
        timelapsePath,
        timelapseThumb,
        videoBytes,
        createdAt,
      );

      // The public guest cannot answer the morning-review prompt, so record that this fictional
      // sample night was intentionally reviewed rather than leaving a read-only dead end in the UI.
      const summary = computeNight(child.id, lastCompleted);
      db.prepare(
        `INSERT INTO sleep_reviews
           (child_id, night_date, true_onset_at, true_wake_at, computed_onset_at,
            computed_wake_at, note, dismissed, reviewed_at)
         VALUES (?, ?, ?, ?, ?, ?, 'Fictional demo night; no real child data.', 1, ?)`
      ).run(
        child.id,
        lastCompleted,
        summary.onset_at,
        summary.wake_at,
        summary.onset_at,
        summary.wake_at,
        createdAt,
      );
    }
  });

  seedDatabase();
  return {
    db,
    sleep,
    childIds: CHILDREN.map((child) => child.id),
    currentNight,
    lastCompleted,
    endsAt: endsAt.toISOString(),
  };
}

if (isMainModule()) {
  const result = await seedDemo();
  console.log(
    `seeded ${result.childIds.length} demo children through ${result.endsAt}`
      + (result.currentNight ? ` (active night ${result.currentNight})` : ''),
  );
}
