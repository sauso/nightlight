// GET /api/cameras/:id/recording-readiness and lib/recordingReadiness.js (#394): what a camera is READY to
// save right now, for the "Recording and alerts" panel on its settings page.
//
// ★ WHAT IS UNDER TEST, in the order a reader should trust it:
//   1. The three pure deciders (bufferState, motionState, soundState): every branch, by name.
//   2. The route against a REAL database and the real router: who may call it, what it returns, that it
//      returns nothing but booleans and enums, and that a planted secret in every credential column of
//      the camera and the settings row never appears. No mocks anywhere.
//   3. The states the panel reads: each answer is produced by changing the REAL input it depends on
//      (a setting, the schedule, a silence, a running ring) and reading it back.
//
// ⚠️ THE PATH IS EMPTIED BEFORE ANYTHING LOADS, for the reason spelled out in clip-capture.test.js: a
// ring that starts must not spawn a real ffmpeg. The consequence this file leans on: a started ring's
// map entry exists until spawn's ENOENT arrives on a later tick, so the "ring is up" states are read
// SYNCHRONOUSLY right after startClipCapture (no await in between), exactly as clip-capture.test.js does.
// Over HTTP (which is async) the ring is therefore always down, and that is what the route tests assert.
//
// NOT COVERED HERE (stated, not hidden): a ring that stays up across a real HTTP round trip, and a
// detector process that is genuinely running. Both need a real ffmpeg; the e2e stack has one.
import { test, before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const emptyBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightlight-nobin-'));
process.env.PATH = emptyBinDir;

import {
  useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, makeChild, makeCamera, signToken, mountRouter, call,
} from './helpers/harness.js';

useTempDataDir();

const { default: db } = await import('../src/db.js');
const { default: camerasRouter } = await import('../src/routes/cameras.js');
const { bufferState, motionState, soundState, recordingReadiness } = await import('../src/lib/recordingReadiness.js');
const { CLIPS_DIR } = await import('../src/lib/clipRecorder.js');
const { checkClipStorage } = await import('../src/lib/clipStorage.js');
const { startClipCapture, stopAllClipCapture } = await import('../src/lib/clipCapture.js');
const { nowMinutesInAppTz } = await import('../src/lib/detectSchedule.js');

const MOUNTED = `/dev/sda1 / ext4 rw 0 0\n/dev/sdb1 ${path.resolve(CLIPS_DIR)} xfs rw 0 0\n`;
const UNMAPPED = '/dev/sda1 / ext4 rw 0 0\n';

const BUFFER = ['ready', 'not_running', 'not_needed', 'storage_unavailable', 'camera_disabled'];
const DETECTOR = ['off', 'running', 'not_running', 'camera_side'];
const KEYS = ['alerting_now', 'buffer', 'manual_recording_available', 'motion', 'sound', 'storage_ready', 'wake_clip_ready'];

let server;
let adminToken;
let caregiverToken;

const setSettings = (cols) => {
  for (const [k, v] of Object.entries(cols)) db.prepare(`UPDATE settings SET ${k} = ? WHERE id = 'app'`).run(v);
};
const row = (id = 'cam-1') => db.prepare('SELECT * FROM cameras WHERE id = ?').get(id);
const get = (token, id = 'cam-1') => call(`${server.url}/api/cameras/${id}/recording-readiness`, { token });

before(async () => {
  fs.mkdirSync(CLIPS_DIR, { recursive: true });
  server = await mountRouter('/api/cameras', camerasRouter);
});

after(async () => {
  stopAllClipCapture();
  await server.close();
  db.close();
  cleanupTempDataDirs();
  try { fs.rmSync(emptyBinDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

beforeEach(() => {
  stopAllClipCapture();
  checkClipStorage({ mounts: MOUNTED });
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM users').run();
  db.prepare('DELETE FROM cameras').run();
  db.prepare('DELETE FROM children').run();
  const admin = makeUser(db, { id: 'u-a', username: 'admin', role: 'admin' });
  const care = makeUser(db, { id: 'u-c', username: 'nanny', role: 'caregiver' });
  adminToken = signToken({ id: admin.id, username: admin.username, role: 'admin', sid: makeSession(db, admin.id) });
  caregiverToken = signToken({ id: care.id, username: care.username, role: 'caregiver', sid: makeSession(db, care.id) });
  // The defaults a fresh install has, so no test inherits another's switches.
  setSettings({ ondemand_enabled: 1, wake_clips_enabled: 1, timezone: 'UTC' });
  makeCamera(db, { id: 'cam-1' });
});

describe('the three deciders, branch by branch', () => {
  const base = { disabled: false, running: false, wanted: true, storageReady: true };

  test('bufferState: each answer, and the order the causes are checked in', () => {
    assert.equal(bufferState({ ...base, disabled: true }), 'camera_disabled');
    assert.equal(bufferState({ ...base, running: true }), 'ready');
    assert.equal(bufferState({ ...base, wanted: false }), 'not_needed');
    assert.equal(bufferState({ ...base, storageReady: false }), 'storage_unavailable');
    assert.equal(bufferState(base), 'not_running');
    // Order: a disabled camera is never "ready" even with a stale ring; a RUNNING ring is ready even when
    // nothing wants it any more (a deferred stop) or storage has since gone bad; with no ring, "nothing
    // wants one" outranks "storage is bad" (there is nothing to be sorry about), which outranks the residual.
    assert.equal(bufferState({ ...base, disabled: true, running: true }), 'camera_disabled');
    assert.equal(bufferState({ ...base, running: true, wanted: false }), 'ready');
    assert.equal(bufferState({ ...base, running: true, storageReady: false }), 'ready');
    assert.equal(bufferState({ ...base, wanted: false, storageReady: false }), 'not_needed');
  });

  test('motionState: off, camera-side (MQTT), and running vs not for the two sources Nightlight runs itself', () => {
    const both = (cam, o = {}) => ({
      idle: motionState(cam, { framediffRunning: false, onvifRunning: false, ...o }),
      up: motionState(cam, { framediffRunning: true, onvifRunning: true, ...o }),
    });
    const on = { detect_motion_enabled: 1, disabled: 0 };
    assert.deepEqual(both({ ...on, detect_motion_enabled: 0, detect_source: 'framediff' }), { idle: 'off', up: 'off' });
    assert.deepEqual(both({ ...on, disabled: 1, detect_source: 'framediff' }), { idle: 'off', up: 'off' });
    assert.deepEqual(both({ ...on, detect_source: 'mqtt' }), { idle: 'camera_side', up: 'camera_side' });
    assert.deepEqual(both({ ...on, detect_source: 'framediff' }), { idle: 'not_running', up: 'running' });
    assert.deepEqual(both({ ...on, detect_source: 'onvif' }), { idle: 'not_running', up: 'running' });
    // Each source reads ITS OWN process, not the other's.
    assert.equal(motionState({ ...on, detect_source: 'onvif' }, { framediffRunning: true, onvifRunning: false }), 'not_running');
    assert.equal(motionState({ ...on, detect_source: 'framediff' }, { framediffRunning: false, onvifRunning: true }), 'not_running');
  });

  test('soundState: off, running, not running', () => {
    assert.equal(soundState({ detect_sound_enabled: 0, disabled: 0 }, { running: true }), 'off');
    assert.equal(soundState({ detect_sound_enabled: 1, disabled: 1 }, { running: true }), 'off');
    assert.equal(soundState({ detect_sound_enabled: 1, disabled: 0 }, { running: true }), 'running');
    assert.equal(soundState({ detect_sound_enabled: 1, disabled: 0 }, { running: false }), 'not_running');
  });
});

describe('who may ask', () => {
  test('an anonymous caller gets 401, a caregiver 403, an admin 200', async () => {
    assert.equal((await get(undefined)).status, 401);
    assert.equal((await get(caregiverToken)).status, 403);
    assert.equal((await get(adminToken)).status, 200);
  });

  test('a caregiver gets the same 403 for a camera that does not exist (the gate answers before any lookup)', async () => {
    const real = await get(caregiverToken, 'cam-1');
    const absent = await get(caregiverToken, 'no-such-camera');
    assert.equal(absent.status, 403);
    assert.deepEqual(absent.body, real.body);
  });

  test('an unknown camera is a 404 with a readable message, for an admin', async () => {
    const res = await get(adminToken, 'no-such-camera');
    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'Camera not found');
  });
});

describe('what comes back: booleans and enums, nothing else', () => {
  test('exactly the documented keys; every value is a boolean or a member of its enum', async () => {
    const { status, body } = await get(adminToken);
    assert.equal(status, 200);
    assert.deepEqual(Object.keys(body).sort(), KEYS);
    assert.ok(BUFFER.includes(body.buffer), body.buffer);
    assert.ok(DETECTOR.includes(body.motion), body.motion);
    assert.ok(['off', 'running', 'not_running'].includes(body.sound), body.sound);
    for (const k of ['storage_ready', 'wake_clip_ready', 'manual_recording_available', 'alerting_now']) {
      assert.equal(typeof body[k], 'boolean', k);
    }
  });

  test('a secret planted in every credential column of the camera and the settings row is never returned', async () => {
    // Derived from the schema like secrets-never-returned.test.js, not typed, so a credential column added
    // later is planted too. The marker shape (four throwaway characters, then LEAK-) is that file's.
    const SECRET_NAME = /password|passwd|secret|token|key|hash|backup_code/i;
    const marker = (what) => `qqqqLEAK-${what}`;
    const planted = [];
    for (const table of ['cameras', 'settings']) {
      const where = table === 'cameras' ? "id = 'cam-1'" : "id = 'app'";
      for (const col of db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name).filter((n) => SECRET_NAME.test(n))) {
        db.prepare(`UPDATE ${table} SET ${col} = ? WHERE ${where}`).run(marker(`${table}.${col}`));
        planted.push(`${table}.${col}`);
      }
    }
    // Credentials that live INSIDE a URL column are not found by a column-name rule.
    db.prepare(`UPDATE cameras SET rtsp_url = ?, sub_rtsp_url = ?, snapshot_url = ?, name = ?, mqtt_topic = ? WHERE id = 'cam-1'`).run(
      'rtsp://user:qqqqLEAK-url@192.0.2.10:554/ch0', 'rtsp://user:qqqqLEAK-sub@192.0.2.10:554/ch1',
      'http://user:qqqqLEAK-snap@192.0.2.10/snap.jpg', 'qqqqLEAK-camera-name', 'qqqqLEAK-topic'
    );
    makeChild(db, { id: 'kid-1', name: 'qqqqLEAK-child-name' });
    db.prepare("UPDATE cameras SET child_id = 'kid-1' WHERE id = 'cam-1'").run();
    // The fixture must really be hostile: the planted values are in the rows, and there are several.
    assert.ok(planted.length >= 6, `the derivation found only ${planted.join(', ')}`);
    assert.match(row().onvif_password, /LEAK-cameras\.onvif_password/);

    for (const [who, token] of [['admin', adminToken], ['caregiver', caregiverToken]]) {
      const res = await get(token);
      assert.doesNotMatch(JSON.stringify(res.body), /LEAK|qqqq|192\.0\.2|nanny|admin@|rtsp:/i, `${who}: ${JSON.stringify(res.body)}`);
    }
    assert.equal((await get(adminToken)).status, 200);
  });

  test('it never writes: the camera row and the settings row are byte-identical after a call', async () => {
    const before = JSON.stringify([row(), db.prepare("SELECT * FROM settings WHERE id = 'app'").get()]);
    await get(adminToken);
    await get(adminToken);
    assert.equal(JSON.stringify([row(), db.prepare("SELECT * FROM settings WHERE id = 'app'").get()]), before);
  });
});

describe('the buffer, as the panel reads it', () => {
  test('a disabled camera is camera_disabled, whatever else is on', async () => {
    db.prepare("UPDATE cameras SET disabled = 1, detect_record_clips = 1 WHERE id = 'cam-1'").run();
    assert.equal((await get(adminToken)).body.buffer, 'camera_disabled');
  });

  test('nothing wants a ring: not_needed (detection clips off, manual recording off, no wake clip possible)', async () => {
    setSettings({ ondemand_enabled: 0 });
    const body = (await get(adminToken)).body;
    assert.equal(body.buffer, 'not_needed');
    assert.equal(body.manual_recording_available, false);
    assert.equal(body.wake_clip_ready, false);
  });

  test('a ring is wanted but the clips folder is not usable: storage_unavailable, and storage_ready says why', async () => {
    checkClipStorage({ mounts: UNMAPPED });
    const body = (await get(adminToken)).body;
    assert.equal(body.buffer, 'storage_unavailable');
    assert.equal(body.storage_ready, false);
  });

  test('a ring is wanted, storage is fine, and none is running: not_running (the residual)', async () => {
    const body = (await get(adminToken)).body;
    assert.equal(body.buffer, 'not_running');
    assert.equal(body.storage_ready, true);
    assert.equal(body.manual_recording_available, false);
  });

  test('a ring that is up makes the buffer ready, and manual recording available', () => {
    // Synchronous after the start: see the file header.
    startClipCapture(row());
    const r = recordingReadiness(row());
    assert.equal(r.buffer, 'ready');
    assert.equal(r.manual_recording_available, true);
    // Switching the manual-recording option off removes the answer without touching the ring.
    setSettings({ ondemand_enabled: 0 });
    startClipCapture(row()); // already running; a no-op that does not stop it
    assert.equal(recordingReadiness(row()).manual_recording_available, false);
  });
});

describe('wake clips: eligible is not ready', () => {
  const assign = (track = 1) => {
    makeChild(db, { id: 'kid-1', track });
    db.prepare("UPDATE cameras SET child_id = 'kid-1' WHERE id = 'cam-1'").run();
  };
  // Only the wake dependency keeps the ring wanted, so a wake clip is isolated from the other two users.
  const wakeOnly = () => setSettings({ ondemand_enabled: 0, wake_clips_enabled: 1 });

  test('all four inputs present and a ring up: ready', () => {
    wakeOnly();
    assign();
    startClipCapture(row());
    assert.equal(recordingReadiness(row()).wake_clip_ready, true);
  });

  test('all inputs present but NO ring: not ready (this is the #387 shape)', async () => {
    wakeOnly();
    assign();
    const body = (await get(adminToken)).body;
    assert.equal(body.wake_clip_ready, false);
    assert.equal(body.buffer, 'not_running');
  });

  for (const [what, arrange] of [
    ['the global option is off', () => { setSettings({ ondemand_enabled: 1, wake_clips_enabled: 0 }); assign(); }],
    ['no child is assigned', () => { wakeOnly(); }],
    ['the child does not track sleep', () => { wakeOnly(); assign(0); }],
  ]) {
    test(`not ready when ${what}, even with a ring up`, () => {
      arrange();
      // Detection clips keep the ring wanted for a reason that is NOT the wake clip. Without this the ring is
      // down in the last two cases and "not ready" is true for the wrong reason: a mutant that ignores the
      // child or the tracking flag survived exactly that (caught by the #394 mutants, 2026-10-14).
      db.prepare("UPDATE cameras SET detect_record_clips = 1 WHERE id = 'cam-1'").run();
      startClipCapture(row());
      const r = recordingReadiness(row());
      assert.equal(r.buffer, 'ready', 'the ring must be up, or this case proves nothing about the wake inputs');
      assert.equal(r.wake_clip_ready, false);
    });
  }

  test('a disabled camera is never wake-ready', () => {
    wakeOnly();
    assign();
    startClipCapture(row());
    db.prepare("UPDATE cameras SET disabled = 1 WHERE id = 'cam-1'").run();
    assert.equal(recordingReadiness(row()).wake_clip_ready, false);
  });
});

describe('manual recording agrees with the tile’s own can_record', () => {
  test('the same answer as GET /api/cameras for the settings that matter, ring down', async () => {
    for (const [ondemand, disabled] of [[1, 0], [0, 0], [1, 1], [0, 1]]) {
      setSettings({ ondemand_enabled: ondemand });
      db.prepare('UPDATE cameras SET disabled = ? WHERE id = ?').run(disabled, 'cam-1');
      const list = await call(`${server.url}/api/cameras`, { token: adminToken });
      const tile = list.body.find((c) => c.id === 'cam-1').can_record;
      assert.equal((await get(adminToken)).body.manual_recording_available, tile, `ondemand=${ondemand} disabled=${disabled}`);
    }
  });
});

describe('detectors and alerting_now', () => {
  test('motion and sound read the camera’s own switches; no detector process exists in a unit test, so "on" means not_running', async () => {
    db.prepare("UPDATE cameras SET detect_motion_enabled = 1, detect_source = 'framediff', detect_sound_enabled = 1 WHERE id = 'cam-1'").run();
    let body = (await get(adminToken)).body;
    assert.equal(body.motion, 'not_running');
    assert.equal(body.sound, 'not_running');
    db.prepare("UPDATE cameras SET detect_source = 'mqtt' WHERE id = 'cam-1'").run();
    assert.equal((await get(adminToken)).body.motion, 'camera_side');
    db.prepare("UPDATE cameras SET detect_motion_enabled = 0, detect_sound_enabled = 0 WHERE id = 'cam-1'").run();
    body = (await get(adminToken)).body;
    assert.equal(body.motion, 'off');
    assert.equal(body.sound, 'off');
  });

  test('no schedule and no silence: alerting now', async () => {
    assert.equal((await get(adminToken)).body.alerting_now, true);
  });

  test('a silence in the future stops alerting; one that has run out does not', async () => {
    db.prepare('UPDATE cameras SET alerts_snoozed_until = ? WHERE id = ?').run(Date.now() + 600000, 'cam-1');
    assert.equal((await get(adminToken)).body.alerting_now, false);
    db.prepare('UPDATE cameras SET alerts_snoozed_until = ? WHERE id = ?').run(Date.now() - 1000, 'cam-1');
    assert.equal((await get(adminToken)).body.alerting_now, true);
  });

  test('a schedule is judged in the APP’S timezone, not UTC', async () => {
    // A zone far from UTC, so a UTC reading of "now" lands outside a window the app's zone is inside.
    setSettings({ timezone: 'Pacific/Auckland' });
    const now = nowMinutesInAppTz();
    const at = (m) => ((m % 1440) + 1440) % 1440;
    // Window around the app-zone "now" (±60 min, so a minute rolling over mid-test cannot flip it).
    db.prepare('UPDATE cameras SET detect_schedule_enabled = 1, detect_start = ?, detect_end = ? WHERE id = ?').run(at(now - 60), at(now + 60), 'cam-1');
    assert.equal((await get(adminToken)).body.alerting_now, true);
    // A window that opened and closed hours ago, in the same zone.
    db.prepare('UPDATE cameras SET detect_start = ?, detect_end = ? WHERE id = ?').run(at(now + 120), at(now + 240), 'cam-1');
    assert.equal((await get(adminToken)).body.alerting_now, false);
  });
});
