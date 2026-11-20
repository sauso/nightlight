// A Nightlight Camera has ONE climate source. While its own climate switch is on, the MQTT sampler must not also write
// for it (two sources for one night would mix and double-weight five-minute slots); switch the group off and MQTT has it back.
//
// mqttClient is replaced by a table of readings (it keeps only live values in memory and has no setter). It is not in
// test:core's include list, so mocking it cannot corrupt the coverage run.
import { test, mock, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupTempDataDirs, makeCamera } from './helpers/harness.js';

useTempDataDir();
const readings = {};
mock.module('../src/lib/mqttClient.js', { exports: { getReading: (topic) => readings[topic] || null } });
const { default: db } = await import('../src/db.js');
const { sampleSensorReadings } = await import('../src/lib/sensorSampler.js');

before(() => { for (const t of ['t-plain', 't-api', 't-api-off']) readings[t] = { temperature: 19.5, humidity: 41, receivedAt: Date.now() }; });
after(() => { cleanupTempDataDirs(); });
beforeEach(() => {
  db.prepare('DELETE FROM cameras').run();
  db.prepare('DELETE FROM sensor_readings').run();
});

const written = () => db.prepare('SELECT camera_id, simulated FROM sensor_readings ORDER BY camera_id').all();

test('MQTT samples a plain camera and a Nightlight Camera whose climate group is off, and skips one whose climate group is on', () => {
  makeCamera(db, { id: 'plain', extra: { mqtt_topic: 't-plain' } });
  makeCamera(db, { id: 'api-on', extra: { mqtt_topic: 't-api', sensor_source: 'nightlight-api' } });
  makeCamera(db, { id: 'api-climate-off', extra: { mqtt_topic: 't-api-off', sensor_source: 'nightlight-api', sensor_groups: JSON.stringify({ climate: false }) } });
  assert.equal(sampleSensorReadings(), 2);
  assert.deepEqual(written(), [{ camera_id: 'api-climate-off', simulated: 0 }, { camera_id: 'plain', simulated: 0 }]);
});

test('switching the climate group off hands the camera back to MQTT, and switching the sensors off does too', () => {
  makeCamera(db, { id: 'api-on', extra: { mqtt_topic: 't-api', sensor_source: 'nightlight-api' } });
  assert.equal(sampleSensorReadings(), 0, 'its API owns the climate');
  db.prepare("UPDATE cameras SET sensor_groups = '{\"climate\":false}' WHERE id = 'api-on'").run();
  assert.equal(sampleSensorReadings(), 1);
  db.prepare("UPDATE cameras SET sensor_groups = NULL, sensor_source = NULL WHERE id = 'api-on'").run();
  assert.equal(sampleSensorReadings(), 1, 'sensors off: MQTT again');
});
