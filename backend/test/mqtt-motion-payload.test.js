// #564: pin camera-native MQTT motion payloads and the broker-message path that gates alerts.
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { useTempDataDir, cleanupTempDataDirs, makeCamera } from './helpers/harness.js';

useTempDataDir();

const broker = new EventEmitter();
broker.subscribe = (_topics, done) => done?.(null);
broker.end = () => {};
const alerts = [];
// Keep the real DB and dispatch logic; replace only the broker socket and the alert side effect.
mock.module('mqtt', { exports: { default: { connect: () => broker } } });
mock.module('../src/lib/detectionAlert.js', {
  exports: { fireDetectionAlert: (...args) => { alerts.push(args); return Promise.resolve(); } },
});

const { default: db } = await import('../src/db.js');
const { isMotionPayload, refreshMqttConnection, stopMqtt, forgetMqttMotionAlert } = await import('../src/lib/mqttClient.js');

after(() => {
  stopMqtt();
  db.close();
  cleanupTempDataDirs();
});

test('payload interpretation covers plain tokens, JSON fields, overrides and rejects', () => {
  const cases = [
    // Bare values and words: OFF takes priority even when motion appears in the same payload.
    ...['ON', '1', 'true', 'yes', 'motion', 'active', 'detected', 'start', 'started', 'open', 'alarm', 'detect',
      'motion_start', 'motionDetected', 'alarm-trigger'].map((payload) => [payload, undefined, true]),
    ...['OFF', '0', 'false', 'no', 'clear', 'cleared', 'inactive', 'idle', 'stop', 'stopped', 'end',
      'ended', 'closed', 'none', 'normal', 'motion_stop'].map((payload) => [payload, undefined, false]),
    [' true ', undefined, true], ['   ', undefined, false], ['', 'ON', false],
    ['garbage', undefined, false], ['{}', undefined, false], ['{"other":"garbage"}', undefined, false],
    ['["motion"]', undefined, true],
    ...['motion', 'motion_detected', 'motionDetected', 'event', 'state', 'alarm', 'occupancy',
      'value', 'status', 'detected'].map((field) => [JSON.stringify({ [field]: 'ON' }), undefined, true]),
    ['{"motion":true}', undefined, true], ['{"motion":1}', undefined, true],
    ['{"motion":0}', undefined, false], ['{"motion":-1}', undefined, false],
    ['{"motion":null}', undefined, false], ['{"motion":[]}', undefined, false],
    ['{"motion":"motion_stop"}', undefined, false],
    ['{"motion":"OFF","event":"ON"}', undefined, true],
    ['{"motion":"garbage","other":"ON"}', undefined, false], ['{"other":"ON"}', undefined, true], // unknown shape: whole-payload check, deliberate (isMotionPayload comment)
    ['alarm-trigger', 'alarm-trigger', true], ['prefix ALARM-TRIGGER suffix', 'alarm-trigger', true],
    ['{"custom":"ALARM-TRIGGER"}', 'alarm-trigger', true],
    ['{"custom":1}', '1', true], ['{"custom":"OFF"}', 'alarm-trigger', false],
    ['ON', 'alarm-trigger', false], ['garbage', 'alarm-trigger', false],
    ['{"other":"garbage"}', '  ', false],
    // Review of #564: a blank known field is not motion; an override can match a JSON value that the raw text does not contain.
    ['{"motion":"   "}', undefined, false], ['{"custom":["ON","OFF"]}', 'on,off', true],
  ];
  for (const [payload, override, expected] of cases) {
    assert.equal(isMotionPayload(payload, override), expected, `${JSON.stringify(payload)} / ${JSON.stringify(override)}`);
  }
});

test('broker messages select the topic camera and gate OFF, schedule and cooldown before alerting', () => {
  const first = 'mqtt-motion-a';
  const second = 'mqtt-motion-b';
  const topic = 'test/motion/a';
  const otherTopic = 'test/motion/b';
  for (const [id, motionTopic] of [[first, topic], [second, otherTopic]]) {
    makeCamera(db, { id, name: `MQTT ${id}`, extra: {
      detect_motion_enabled: 1, detect_source: 'mqtt', motion_mqtt_topic: motionTopic,
      detect_cooldown_s: 60,
    } });
    forgetMqttMotionAlert(id);
  }
  db.prepare("UPDATE settings SET mqtt_enabled = 1, mqtt_host = 'broker.example', mqtt_port = 1883, timezone = 'UTC' WHERE id = 'app'").run();
  refreshMqttConnection();
  const publish = (t, value) => broker.emit('message', t, Buffer.from(value));

  publish('test/motion/unmatched', 'ON');
  publish(topic, 'OFF');
  publish(topic, 'garbage');
  assert.equal(alerts.length, 0);

  // Make a one-minute window two minutes from now in the configured timezone, including at midnight.
  const now = new Date();
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  db.prepare('UPDATE cameras SET detect_schedule_enabled = 1, detect_start = ?, detect_end = ? WHERE id = ?')
    .run((minutes + 2) % 1440, (minutes + 3) % 1440, first);
  publish(topic, 'ON');
  assert.equal(alerts.length, 0, 'motion outside the active window must be ignored');

  db.prepare('UPDATE cameras SET detect_schedule_enabled = 0 WHERE id = ?').run(first);
  publish(topic, 'ON');
  publish(topic, 'ON');
  assert.equal(alerts.length, 1, 'the second motion within cooldown must not alert');
  assert.equal(alerts[0][0].id, first, 'the topic must select its camera');
  assert.equal(alerts[0][1], 'motion');
  assert.equal(alerts[0][2], 'camera-reported (MQTT)');
  publish(otherTopic, 'ON');
  assert.equal(alerts.length, 2, 'a different topic must produce one alert for its own camera');
  assert.equal(alerts[1][0].id, second);
});
