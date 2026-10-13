// #555 bullet 10: the ONVIF-motion and MQTT-motion per-camera cooldown maps (lib/onvifMotion.js `lastAlert`,
// lib/mqttClient.js `motionLastAlert`) were never pruned, so a deleted camera left a number behind for the life of
// the process. `DELETE /api/cameras/:id` now clears THIS camera's entry in each, through the REAL router.
// Same shape as motion-alert-cooldown-routes.test.js (#454) and the same two claims:
//   - DELETE clears this camera's stamp and no other camera's;
//   - an edit (a rename, a detection save) does NOT clear it: the cooldown has to survive the stop/start those
//     routes do, or an unrelated edit would re-arm alerts.
// NOT covered: the cooldown BEHAVIOUR itself (handleMotion is not exported; it is the unchanged code on the
// other side of this map), and a deleted camera re-stamped by an in-flight message after the delete.
import { test, mock, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, makeCamera, signToken, mountRouter, call,
} from './helpers/harness.js';
import { FakeFfmpeg } from './helpers/fakeFfmpeg.js';

useTempDataDir();
mock.module('node:child_process', {
  exports: {
    spawn(command, args) {
      const proc = new FakeFfmpeg(command, args);
      if (command === 'ffprobe') proc.finish(1);
      return proc;
    },
  },
});
const mediamtx = createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end('{}'); });
await new Promise((r) => mediamtx.listen(0, '127.0.0.1', r));
process.env.MEDIAMTX_API = `http://127.0.0.1:${mediamtx.address().port}`;

const { default: db } = await import('../src/db.js');
const { default: camerasRouter } = await import('../src/routes/cameras.js');
const onvif = await import('../src/lib/onvifMotion.js');
const mqttc = await import('../src/lib/mqttClient.js');

let server;
let token;
const CAM = 'cam-555';
const OTHER = 'cam-555-other';
const PLANTED = 1_700_000_000_000;

before(async () => {
  server = await mountRouter('/api/cameras', camerasRouter);
  const admin = makeUser(db, { id: 'u-admin', username: 'admin', role: 'admin' });
  token = signToken({ sub: admin.id, role: 'admin', sid: makeSession(db, admin.id) });
});
after(async () => {
  await server?.close();
  await new Promise((r) => mediamtx.close(r));
  cleanupTempDataDirs();
});
beforeEach(() => {
  for (const id of [CAM, OTHER]) {
    db.prepare('DELETE FROM cameras WHERE id = ?').run(id);
    makeCamera(db, { id, name: `Route ${id}`, extra: { disabled: 1, detect_motion_enabled: 0, detect_sound_enabled: 0, detect_record_clips: 0 } });
    onvif._setOnvifAlertStampForTests(id, PLANTED);
    mqttc._setMqttMotionStampForTests(id, PLANTED);
  }
});

const stamps = (id) => [onvif._onvifAlertStampForTests(id), mqttc._mqttMotionStampForTests(id)];

describe('#555 bullet 10: per-camera cooldown maps', { concurrency: false }, () => {
  test('DELETE clears this camera in both maps and leaves another camera alone', async () => {
    const res = await call(`${server.url}/api/cameras/${CAM}`, { method: 'DELETE', token });
    assert.equal(res.status, 204);
    assert.deepEqual(stamps(CAM), [undefined, undefined], 'a deleted camera left a cooldown stamp behind');
    assert.deepEqual(stamps(OTHER), [PLANTED, PLANTED], 'DELETE cleared another camera\'s stamp');
  });

  for (const [label, doCall] of [
    ['a rename', () => call(`${server.url}/api/cameras/${CAM}`, { method: 'PUT', token, body: { name: 'Renamed' } })],
    ['a detection save', () => call(`${server.url}/api/cameras/${CAM}/detection`, { method: 'PUT', token, body: { motion_enabled: false, sensitivity: 61, cooldown_s: 45, confirm_s: 7 } })],
  ]) {
    test(`${label} keeps the stamps`, async () => {
      const res = await doCall();
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(stamps(CAM), [PLANTED, PLANTED]);
    });
  }
});
