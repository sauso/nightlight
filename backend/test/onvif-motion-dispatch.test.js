// #564: drive the callback supplied to ONVIF, with real camera settings and only the device/alert edges replaced.
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupTempDataDirs, makeCamera, makeChild } from './helpers/harness.js';

useTempDataDir();

const subscriptions = [];
const alerts = [];
mock.module('../src/lib/onvif.js', {
  exports: {
    subscribeMotionEvents: (options) => {
      const subscription = { options, stopped: false };
      subscriptions.push(subscription);
      return { stop: () => { subscription.stopped = true; } };
    },
  },
});
mock.module('../src/lib/detectionAlert.js', {
  exports: { fireDetectionAlert: (...args) => { alerts.push(args); return Promise.resolve(); } },
});

const { default: db } = await import('../src/db.js');
const { startOnvifMotion, stopAllOnvifMotion, _setOnvifAlertStampForTests, _onvifAlertStampForTests } =
  await import('../src/lib/onvifMotion.js');
const { shouldHold, HOLD_CAP_MS, _reset } = await import('../src/lib/alertHold.js');
const { _state } = await import('../src/lib/wakeWatcher.js');

after(async () => {
  await stopAllOnvifMotion();
  db.close();
  cleanupTempDataDirs();
});

function camera(id, extra = {}) {
  makeCamera(db, { id, name: `ONVIF ${id}`, extra: {
    detect_motion_enabled: 1, detect_source: 'onvif', detect_cooldown_s: 60,
    onvif_device_url: 'http://camera.example:8080/onvif/device_service',
    onvif_username: 'configured-user', onvif_password: 'configured-password',
    ...extra,
  } });
  return db.prepare('SELECT * FROM cameras WHERE id = ?').get(id);
}

test('#919 ONVIF cooldown cannot start a hold, held motion keeps its stamp, release fires', async () => {
  const id = 'hold-onvif';
  const childId = 'hold-onvif-child';
  const pad = (n) => String(n).padStart(2, '0');
  const hm = (ms) => { const d = new Date(ms); return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };
  const now = Date.now();
  makeChild(db, { id: childId, start: hm(now - 3 * 3600_000), end: hm(now + 3 * 3600_000) });
  db.prepare('UPDATE children SET hold_alerts_until_asleep = 1 WHERE id = ?').run(childId);
  const cam = camera(id);
  db.prepare('UPDATE cameras SET child_id = ? WHERE id = ?').run(childId, id);
  await startOnvifMotion(cam);
  const onMotion = subscriptions.at(-1).options.onMotion;
  _reset();
  const before = alerts.length;
  const minute = new Date().getUTCHours() * 60 + new Date().getUTCMinutes();
  db.prepare('UPDATE cameras SET detect_schedule_enabled = 1, detect_start = ?, detect_end = ? WHERE id = ?')
    .run((minute + 120) % 1440, (minute + 121) % 1440, id);
  onMotion();
  assert.equal(shouldHold({ id }, now + HOLD_CAP_MS), true, 'out-of-schedule motion started the cap');
  _reset();
  db.prepare('UPDATE cameras SET detect_schedule_enabled = 0 WHERE id = ?').run(id);
  _setOnvifAlertStampForTests(id, now);
  onMotion();
  assert.equal(alerts.length, before);
  assert.equal(shouldHold({ id }, now + HOLD_CAP_MS), true, 'cooling edge started the cap');
  _reset();
  _setOnvifAlertStampForTests(id, now - 61_000);
  onMotion();
  assert.equal(alerts.length, before);
  assert.equal(_onvifAlertStampForTests(id), now - 61_000, 'held edge stamped cooldown');
  _state().set(id, { asleep: true });
  onMotion();
  assert.equal(alerts.length, before + 1);
  _state().delete(id);
  alerts.length = 0;
});

test('an ONVIF motion edge dispatches one alert for the current camera row', async () => {
  const cam = camera('onvif-dispatch');
  await startOnvifMotion(cam);
  subscriptions.at(-1).options.onMotion();
  assert.equal(alerts.length, 1);
  assert.deepEqual(alerts[0], [cam, 'motion', 'camera-reported (ONVIF)']);
});

test('motion inside the per-camera cooldown is suppressed, then an aged stamp permits another alert', async () => {
  const cam = camera('onvif-cooldown');
  await startOnvifMotion(cam);
  const onMotion = subscriptions.at(-1).options.onMotion;
  const before = alerts.length;
  onMotion();
  onMotion();
  assert.equal(alerts.length, before + 1, 'a second edge inside cooldown alerted');
  _setOnvifAlertStampForTests(cam.id, Date.now() - 61_000);
  onMotion();
  assert.equal(alerts.length, before + 2, 'an edge after cooldown did not alert');
  assert.equal(alerts.at(-1)[0].id, cam.id);
});

test('a callback uses the stored cooldown and enforces its one-second minimum', async () => {
  for (const [id, cooldown, ageMs, expected] of [
    ['onvif-short-cooldown', 5, 6_000, true],
    ['onvif-long-cooldown', 300, 61_000, false],
    ['onvif-minimum-cooldown', 0, 0, false],
  ]) {
    const cam = camera(id, { detect_cooldown_s: cooldown });
    await startOnvifMotion(cam);
    _setOnvifAlertStampForTests(id, Date.now() - ageMs);
    const before = alerts.length;
    subscriptions.at(-1).options.onMotion();
    assert.equal(alerts.length, before + Number(expected), `${id} ignored its cooldown`);
  }
});

test('a missing cooldown falls back to 60 seconds', async () => {
  const cam = camera('onvif-missing-cooldown');
  await startOnvifMotion(cam);
  const onMotion = subscriptions.at(-1).options.onMotion;
  const prepare = db.prepare;
  // A migrated database always supplies this column; omit it from the fetched row to exercise the legacy fallback.
  db.prepare = function (sql) {
    if (sql === 'SELECT * FROM cameras WHERE id = ?') {
      const statement = prepare.call(this, sql);
      return { get(id) {
        const { detect_cooldown_s, ...row } = statement.get(id);
        return row;
      } };
    }
    return prepare.call(this, sql);
  };
  try {
    const before = alerts.length;
    _setOnvifAlertStampForTests(cam.id, Date.now() - 30_000);
    onMotion();
    assert.equal(alerts.length, before, 'missing cooldown allowed an edge at 30 seconds');
    _setOnvifAlertStampForTests(cam.id, Date.now() - 61_000);
    onMotion();
    assert.equal(alerts.length, before + 1, 'missing cooldown suppressed an edge at 61 seconds');
  } finally {
    db.prepare = prepare;
  }
});

test('a subscribed callback honors settings changed in the DB without stamping rejected edges', async () => {
  for (const [id, column, rejected, eligible] of [
    ['onvif-disabled', 'disabled', 1, 0],
    ['onvif-changed-source', 'detect_source', 'mqtt', 'onvif'],
    ['onvif-detection-off', 'detect_motion_enabled', 0, 1],
  ]) {
    const cam = camera(id);
    await startOnvifMotion(cam);
    const onMotion = subscriptions.at(-1).options.onMotion;
    db.prepare(`UPDATE cameras SET ${column} = ? WHERE id = ?`).run(rejected, id);
    const before = alerts.length;
    onMotion();
    assert.equal(alerts.length, before, `${column} changed after subscribing but still alerted`);
    db.prepare(`UPDATE cameras SET ${column} = ? WHERE id = ?`).run(eligible, id);
    onMotion();
    assert.equal(alerts.length, before + 1, `${column} rejection stamped a cooldown`);
  }
});

test('a motion edge outside the camera active window does not alert', async () => {
  db.prepare("UPDATE settings SET timezone = 'UTC' WHERE id = 'app'").run();
  const now = new Date();
  const minute = now.getUTCHours() * 60 + now.getUTCMinutes();
  // Keep the window two hours away even when the current minute is near midnight.
  const cam = camera('onvif-schedule', {
    detect_schedule_enabled: 1, detect_start: (minute + 120) % 1440, detect_end: (minute + 121) % 1440,
  });
  await startOnvifMotion(cam);
  const before = alerts.length;
  subscriptions.at(-1).options.onMotion();
  assert.equal(alerts.length, before, 'motion outside the active window alerted');
  db.prepare('UPDATE cameras SET detect_schedule_enabled = 0 WHERE id = ?').run(cam.id);
  subscriptions.at(-1).options.onMotion();
  assert.equal(alerts.length, before + 1, 'quiet-hours rejection stamped a cooldown');
});

test('an unwanted camera does not subscribe', async () => {
  const before = subscriptions.length;
  await startOnvifMotion(camera('onvif-unwanted', { detect_motion_enabled: 0 }));
  assert.equal(subscriptions.length, before);
});

test('subscription uses URL host and port and stored ONVIF credentials; an invalid URL cannot subscribe', async () => {
  const initialCount = subscriptions.length;
  const withPort = camera('onvif-endpoint-port', {
    onvif_device_url: 'http://camera.example:8899/onvif/device_service',
  });
  await startOnvifMotion(withPort);
  assert.equal(subscriptions.length, initialCount + 1);
  assert.deepEqual(
    (({ host, port, username, password }) => ({ host, port, username, password }))(subscriptions.at(-1).options),
    { host: 'camera.example', port: '8899', username: 'configured-user', password: 'configured-password' },
  );

  const withUserinfo = camera('onvif-endpoint-userinfo', {
    onvif_device_url: 'http://url-user:url-pass@second.example/onvif/device_service',
  });
  await startOnvifMotion(withUserinfo);
  assert.deepEqual(
    (({ host, port, username, password }) => ({ host, port, username, password }))(subscriptions.at(-1).options),
    { host: 'second.example', port: '80', username: 'configured-user', password: 'configured-password' },
  );

  const count = subscriptions.length;
  await startOnvifMotion(camera('onvif-endpoint-invalid', { onvif_device_url: 'not a URL' }));
  assert.equal(subscriptions.length, count, 'an unparseable endpoint subscribed');
});
