import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nightlight-demo-seed-'));
const dataDir = path.join(tempRoot, 'data');
const clipsDir = path.join(tempRoot, 'clips');
const assetDir = path.join(tempRoot, 'assets');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(clipsDir, { recursive: true });
fs.mkdirSync(assetDir, { recursive: true });
fs.writeFileSync(path.join(assetDir, 'loop.mp4'), Buffer.from('test-video'));
fs.writeFileSync(path.join(assetDir, 'loop.jpg'), Buffer.from('test-jpeg'));

process.env.DATA_DIR = dataDir;
process.env.CLIPS_DIR = clipsDir;
process.env.DEMO_ASSET_DIR = assetDir;
process.env.DEMO_TIMEZONE = 'America/New_York';

let seededDb;
after(() => {
  seededDb?.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
  for (const key of ['DATA_DIR', 'CLIPS_DIR', 'DEMO_ASSET_DIR', 'DEMO_TIMEZONE', 'DEMO_ENDS_AT']) {
    delete process.env[key];
  }
});

const tablesForHash = [
  'users', 'children', 'cameras', 'settings', 'activity_samples', 'sleep_nights',
  'sleep_reviews', 'detection_events', 'recordings', 'timelapses', 'push_tokens',
];

function databaseHash(db) {
  const hash = createHash('sha256');
  for (const table of tablesForHash) {
    hash.update(table);
    for (const row of db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).iterate()) {
      hash.update(JSON.stringify(row));
    }
  }
  return hash.digest('hex');
}

function assertCompletedNightsAreOk(result) {
  for (const childId of result.childIds) {
    const appDate = result.sleep.lastCompletedNightDate(childId);
    assert.equal(appDate, result.lastCompleted, 'seed and app disagree on the last completed local night');
    assert.equal(result.sleep.computeNight(childId, appDate).status, 'ok');
    assert.equal(
      result.db.prepare('SELECT status FROM sleep_nights WHERE child_id = ? AND night_date = ?')
        .get(childId, appDate).status,
      'ok',
    );
  }
}

function assertSeededThroughDeadline(result) {
  assert.ok(result.currentNight, 'the test clock must be inside the configured sleep window');
  const deadlineSql = result.sleep.toSqlUtc(new Date(result.endsAt));
  for (const childId of result.childIds) {
    const cameraId = result.db.prepare('SELECT id FROM cameras WHERE child_id = ?').get(childId).id;
    const last = result.db.prepare('SELECT MAX(bucket_start) AS value FROM activity_samples WHERE camera_id = ?')
      .get(cameraId).value;
    assert.ok(last >= deadlineSql, `${cameraId} stops at ${last}, before ${deadlineSql}`);
  }
}

test('demo seed is deterministic, timezone-native, safe and stable throughout a session', async (t) => {
  const midWindowBoot = Date.parse('2026-01-16T03:00:00.000Z'); // 22:00 in the configured test zone
  t.mock.timers.enable({ apis: ['Date'], now: midWindowBoot });
  const { seedDemo } = await import('../src/lib/demoSeed.js');

  process.env.DEMO_ENDS_AT = new Date(midWindowBoot + 20 * 60_000).toISOString();
  const midWindow = await seedDemo(() => new Date(midWindowBoot));
  seededDb = midWindow.db;
  assertCompletedNightsAreOk(midWindow);
  assertSeededThroughDeadline(midWindow);

  const justAfterMidnight = Date.parse('2026-01-16T05:05:00.000Z'); // 00:05 in the configured test zone
  t.mock.timers.setTime(justAfterMidnight);
  process.env.DEMO_ENDS_AT = new Date(justAfterMidnight + 20 * 60_000).toISOString();
  const midnight = await seedDemo(() => new Date(justAfterMidnight));
  assertCompletedNightsAreOk(midnight);
  assertSeededThroughDeadline(midnight);

  const firstHash = databaseHash(midnight.db);
  const repeated = await seedDemo(() => new Date(justAfterMidnight));
  assert.equal(databaseHash(repeated.db), firstHash, 'a fixed clock did not reproduce the same database');

  t.mock.timers.tick(30 * 60_000);
  assertCompletedNightsAreOk(repeated);
  for (const childId of repeated.childIds) {
    assert.equal(
      repeated.sleep.computeNight(childId, repeated.currentNight).status,
      'ok',
      'the in-progress night degraded after the 30-minute recompute interval',
    );
  }

  const settings = repeated.db.prepare('SELECT * FROM settings WHERE id = ?').get('app');
  assert.equal(settings.timezone, process.env.DEMO_TIMEZONE);
  assert.deepEqual(
    [settings.clip_retention_days, settings.clip_retention_max_gb, settings.wake_clip_retention_days],
    [0, 0, 0],
  );
  for (const flag of ['mqtt_enabled', 'push_enabled', 'pushover_enabled', 'ntfy_enabled', 'gotify_enabled']) {
    assert.equal(settings[flag], 0, `${flag} is enabled`);
  }
  for (const field of [
    'mqtt_host', 'mqtt_username', 'mqtt_password', 'pushover_app_token', 'pushover_user_key',
    'ntfy_topic', 'ntfy_token', 'ntfy_username', 'ntfy_password', 'gotify_server_url',
    'gotify_app_token', 'public_base_url',
  ]) {
    assert.equal(settings[field], null, `${field} configures an outbound destination`);
  }
  assert.equal(repeated.db.prepare('SELECT COUNT(*) AS count FROM push_tokens').get().count, 0);

  const cameras = repeated.db.prepare(
    `SELECT snapshot_url, mqtt_topic, motion_mqtt_topic, detect_motion_enabled,
            detect_sound_enabled, disabled
       FROM cameras ORDER BY id`,
  ).all();
  assert.equal(cameras.length, 2);
  for (const camera of cameras) {
    assert.equal(camera.snapshot_url, null);
    assert.equal(camera.mqtt_topic, null);
    assert.equal(camera.motion_mqtt_topic, null);
    assert.equal(camera.detect_motion_enabled, 0);
    assert.equal(camera.detect_sound_enabled, 0);
    assert.equal(camera.disabled, 0);
  }

  for (const table of ['recordings', 'timelapses']) {
    const rows = repeated.db.prepare(`SELECT status, path, thumb_path FROM ${table} ORDER BY id`).all();
    assert.equal(rows.length, 2, `${table} must contain one row per child`);
    for (const row of rows) {
      assert.equal(row.status, 'ready');
      for (const relative of [row.path, row.thumb_path]) {
        assert.ok(relative && !path.isAbsolute(relative) && !relative.split('/').includes('..'));
        assert.ok(fs.existsSync(path.join(clipsDir, ...relative.split('/'))), `${relative} was not copied`);
      }
    }
  }
  assert.equal(repeated.db.prepare('SELECT COUNT(*) AS count FROM detection_events WHERE snapshot = 1').get().count, 16);
  assert.equal(repeated.db.prepare('SELECT COUNT(*) AS count FROM sleep_reviews').get().count, 2);

  const guest = repeated.db.prepare(
    'SELECT username, password_hash, role, mfa_enabled, mfa_secret, mfa_backup_codes FROM users',
  ).get();
  assert.equal(guest.username, 'demo-guest');
  assert.equal(guest.role, 'admin');
  assert.equal(guest.mfa_enabled, 0);
  assert.equal(guest.mfa_secret, null);
  assert.equal(guest.mfa_backup_codes, null);
  assert.doesNotMatch(
    guest.password_hash,
    /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/,
    'the public guest retained a usable bcrypt password hash',
  );

  const source = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'src', 'lib', 'demoSeed.js'), 'utf8');
  assert.match(source, /\bzonedToUtc\(/, 'seed does not call the app timezone conversion helper');
  assert.match(source, /\btoSqlUtc\(/, 'seed does not call the app UTC storage helper');
  assert.doesNotMatch(source, /(?:Australia|America|Europe|Pacific)\//, 'seed contains a house-specific timezone');
  const publicIps = source.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g) || [];
  assert.deepEqual([...new Set(publicIps)], ['127.0.0.1'], 'seed contains an IP other than its required loopback source');

  const [year, month, day] = repeated.lastCompleted.split('-').map(Number);
  const expectedWindowStart = repeated.sleep.toSqlUtc(
    repeated.sleep.zonedToUtc(year, month - 1, day, 19, 0, process.env.DEMO_TIMEZONE),
  );
  assert.equal(
    repeated.db.prepare('SELECT window_start FROM sleep_nights WHERE night_date = ? LIMIT 1')
      .get(repeated.lastCompleted).window_start,
    expectedWindowStart,
  );
});

test('demo seed covers a sleep window that opens or closes during the session', async (t) => {
  const { seedDemo } = await import('../src/lib/demoSeed.js');
  const scenarios = [
    ['closes during the session', '2026-09-21T06:50:00.000Z', '2026-09-21T06:55:00.000Z'],
    ['opens during the session', '2026-09-21T18:50:00.000Z', '2026-09-21T19:05:00.000Z'],
    ['is already open', '2026-09-21T22:00:00.000Z', '2026-09-21T22:05:00.000Z'],
  ];
  process.env.DEMO_TIMEZONE = 'UTC';
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(scenarios[0][1]) });

  for (const [label, bootIso, observationIso] of scenarios) {
    const boot = Date.parse(bootIso);
    t.mock.timers.setTime(boot);
    process.env.DEMO_ENDS_AT = new Date(boot + 20 * 60_000).toISOString();
    const result = await seedDemo(() => new Date(boot));
    seededDb = result.db;
    assert.ok(result.currentNight, `${label}: no session night was selected`);

    t.mock.timers.setTime(Date.parse(observationIso));
    for (const childId of result.childIds) {
      assert.notEqual(
        result.sleep.computeNight(childId, result.currentNight).status,
        'no_data',
        `${label}: ${childId} had no in-progress sleep data`,
      );
    }
  }
});
