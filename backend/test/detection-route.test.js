// PUT /api/cameras/:id/detection — the single endpoint every detection control in the app writes
// through, over real HTTP against the real router.
//
// ★★ WHY THIS MATTERS MORE THAN IT LOOKS. Four different UI surfaces write here, and they do NOT send
// the same thing:
//   * the Motion, Sound and Alert-schedule screens each hold the WHOLE detection state and send all
//     of it, with only their own slice changed;
//   * the quick motion/sound toggles on a camera tile send `detectionPayload(cam, patch)`, which
//     omits `zone` and `record_clips` entirely.
// The tile's toggles are therefore safe ONLY because this route treats an absent field as "keep".
// Nothing tested that. If a refactor ever made a missing field mean "clear", the visible symptom
// would be that **flipping motion off and on from a tile silently erases the painted bed zone** — and
// with it the room-specific setup that sleep tracking depends on. It would not error, it would not
// look wrong on screen, and the next night's sleep data would just be quietly worse.
//
// The other half is the reverse direction: what the route hands BACK has to be re-sendable. It stores
// the zone as a JSON string and returns it PARSED, so the screens can round-trip it without knowing
// that. A change to either side alone breaks the loop.
//
// ⚠️ Every camera here is created `disabled: 1` ON PURPOSE. The handler's tail starts and stops the
// real frame-diff, ONVIF, sound and clip-ring legs for an enabled camera — FFmpeg processes this
// suite has no business spawning — and that whole block sits behind `if (!updated.disabled)`. The
// field handling under test runs before it and is not affected by the flag.
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, makeCamera, signToken, mountRouter, call,
} from './helpers/harness.js';

useTempDataDir();

const { default: db } = await import('../src/db.js');
const { default: camerasRouter } = await import('../src/routes/cameras.js');

let server;
let adminToken;
let caregiverToken;

const CAM = 'cam-det';
const ZONE = [{ x: 0.2, y: 0.3, w: 0.4, h: 0.5 }];

// A camera with every detection field set to something distinctive, so a value that gets reset to a
// default is visible rather than coincidentally equal to one.
const CONFIGURED = {
  disabled: 1,
  detect_motion_enabled: 1,
  detect_zone: JSON.stringify(ZONE),
  detect_sensitivity: 88,
  detect_cooldown_s: 45,
  detect_confirm_s: 7,
  detect_schedule_enabled: 1,
  detect_start: 1140,
  detect_end: 400,
  detect_source: 'framediff',
  motion_mqtt_topic: 'cam/motion',
  motion_mqtt_value: 'ON',
  snapshot_url: 'http://cam/snap.jpg',
  detect_sound_enabled: 1,
  sound_sensitivity: 72,
  sound_confirm_s: 6,
  sound_cooldown_s: 200,
  detect_record_clips: 1,
};

const put = (body, token = adminToken) =>
  call(`${server.url}/api/cameras/${CAM}/detection`, { method: 'PUT', token, body });

// The full body the detection screen sends. A function, not a constant, so a case that mutates it
// cannot leak into the next one.
const CONFIGURED_PAYLOAD = () => ({
  motion_enabled: true, sensitivity: 61, cooldown_s: 45, confirm_s: 7,
  schedule_enabled: true, start: 1140, end: 400, source: 'framediff',
  motion_mqtt_topic: 'cam/motion', motion_mqtt_value: 'ON',
  sound_enabled: true, sound_sensitivity: 72, sound_confirm_s: 6, sound_cooldown_s: 200,
});

const row = () => db.prepare('SELECT * FROM cameras WHERE id = ?').get(CAM);

before(async () => {
  server = await mountRouter('/api/cameras', camerasRouter);
  const admin = makeUser(db, { id: 'u-a', username: 'admin', role: 'admin' });
  const caregiver = makeUser(db, { id: 'u-c', username: 'nanny', role: 'caregiver' });
  adminToken = signToken({ sub: admin.id, role: 'admin', sid: makeSession(db, admin.id) });
  caregiverToken = signToken({ sub: caregiver.id, role: 'caregiver', sid: makeSession(db, caregiver.id) });
});

after(async () => {
  await server.close();
  cleanupTempDataDirs();
});

beforeEach(() => {
  db.prepare('DELETE FROM cameras WHERE id = ?').run(CAM);
  makeCamera(db, { id: CAM, name: 'Detection Cam', extra: CONFIGURED });
});

// -------------------------------------------------------------------------------------------
test('★★ a payload shaped like the TILE toggle does not erase the bed zone or the clip opt-in', async () => {
  // The exact shape `detectionPayload` in CameraTile.jsx produces: every field except `zone` and
  // `record_clips`. This is the test the whole file exists for — see the header.
  const res = await put({
    motion_enabled: false,
    sensitivity: 88,
    cooldown_s: 45,
    confirm_s: 7,
    schedule_enabled: true,
    start: 1140,
    end: 400,
    source: 'framediff',
    motion_mqtt_topic: 'cam/motion',
    motion_mqtt_value: 'ON',
    snapshot_url: 'http://cam/snap.jpg',
    sound_enabled: true,
    sound_sensitivity: 72,
    sound_confirm_s: 6,
    sound_cooldown_s: 200,
  });

  assert.equal(res.status, 200);
  assert.equal(row().detect_motion_enabled, 0, 'the change it DID ask for still applies');
  assert.deepEqual(JSON.parse(row().detect_zone), ZONE, 'the painted bed zone must survive a tile toggle');
  assert.equal(row().detect_record_clips, 1, 'so must the per-camera clip opt-in');
});

test('★ an omitted field is kept, one field at a time', async () => {
  // Asserted field by field rather than only in a bundle: "keep when absent" is written out once per
  // field in the handler, so a single one losing its guard is the realistic defect, and a bundled
  // assertion would attribute the failure to the wrong field.
  const before = row();
  const res = await put({ sound_sensitivity: 40 });
  assert.equal(res.status, 200);
  const after = row();

  assert.equal(after.sound_sensitivity, 40, 'the field that WAS sent changes');
  for (const col of [
    'detect_zone', 'detect_sensitivity', 'detect_cooldown_s', 'detect_confirm_s',
    'detect_schedule_enabled', 'detect_start', 'detect_end', 'detect_source',
    'motion_mqtt_topic', 'motion_mqtt_value', 'snapshot_url',
    'detect_sound_enabled', 'sound_confirm_s', 'sound_cooldown_s', 'detect_record_clips',
  ]) {
    assert.equal(after[col], before[col], `${col} must be untouched by a write that never mentioned it`);
  }
});

test('⚠️ but motion_enabled is NOT optional — an absent one turns motion OFF', async () => {
  // The one field that does not follow the rule: `motion_enabled ? 1 : 0`, with no undefined check.
  // Pinned because it is a genuine inconsistency and a trap for the next caller that writes a partial
  // payload — every other field can be omitted safely, this one cannot.
  //
  // Deliberately NOT "fixed" here. Making it keep-on-absent is a real behaviour change, not a tidy-up:
  // it would silently redefine what an omitted `motion_enabled` means for every future caller, and
  // that is a decision to take on purpose rather than as a side effect of writing a test. Every
  // caller today sends the field, so nothing is broken; what was missing was anyone knowing.
  await put({ sound_sensitivity: 40 });
  assert.equal(row().detect_motion_enabled, 0, 'motion is switched off by a payload that omits it');
});

test('the zone round-trips: what the route returns can be sent straight back', async () => {
  // Stored as a JSON string, returned parsed. The screens re-send whatever they were given, so if
  // these two ever disagree the zone would be re-serialised as garbage — or dropped — on the next
  // unrelated edit to the same camera.
  const res = await put({ motion_enabled: true, zone: ZONE });
  assert.deepEqual(res.body.detect_zone, ZONE, 'the client is handed an array, not a JSON string');

  const again = await put({ motion_enabled: true, zone: res.body.detect_zone });
  assert.deepEqual(again.body.detect_zone, ZONE, 're-sending what was received changes nothing');
});

test('an explicit null zone clears it back to the whole frame', async () => {
  // Distinct from omitting it: null is how someone erases a painted zone deliberately.
  const res = await put({ motion_enabled: true, zone: null });
  assert.equal(res.status, 200);
  assert.equal(row().detect_zone, null);
  assert.equal(res.body.detect_zone, null);
});

test('a degenerate rectangle is dropped rather than stored', async () => {
  // A stray tap on the zone picker can produce a sliver. Storing one would mean a detector watching
  // an area too small to contain a child, which reads as "detection stopped working".
  const res = await put({ motion_enabled: true, zone: [{ x: 0.1, y: 0.1, w: 0.001, h: 0.5 }] });
  assert.equal(res.status, 200);
  assert.equal(row().detect_zone, null, 'nothing storable left, so it means the whole frame');
});

test('out-of-range zone coordinates are clamped into the frame', async () => {
  const res = await put({ motion_enabled: true, zone: [{ x: -0.5, y: 0.5, w: 2, h: 0.4 }] });
  assert.deepEqual(res.body.detect_zone, [{ x: 0, y: 0.5, w: 1, h: 0.4 }]);
});

test('★ ONVIF as a source is refused unless the camera advertised it', async () => {
  // Not a UI concern — the button is hidden for an incapable camera — but the route cannot rely on
  // that. A stale tab, or a request made by hand, would otherwise park the camera on a source that
  // can never fire, and motion detection would be silently dead with the screen showing it as on.
  const res = await put({ motion_enabled: true, source: 'onvif' });
  assert.equal(res.body.detect_source, 'framediff', 'degrades rather than accepting a dead source');

  db.prepare('UPDATE cameras SET onvif_motion_capable = 1 WHERE id = ?').run(CAM);
  const ok = await put({ motion_enabled: true, source: 'onvif' });
  assert.equal(ok.body.detect_source, 'onvif', 'and is honoured once the camera advertises it');
});

test('an unrecognised source falls back to frame-diff', async () => {
  const res = await put({ motion_enabled: true, source: 'telepathy' });
  assert.equal(res.body.detect_source, 'framediff');
});

test('★ numbers are clamped to their documented ranges', async () => {
  const res = await put({
    motion_enabled: true,
    sensitivity: 500,
    cooldown_s: 0,
    confirm_s: -5,
    start: 5000,
    end: -20,
    sound_sensitivity: 0,
    sound_confirm_s: 999,
    sound_cooldown_s: 99999,
  });
  const r = row();
  assert.equal(r.detect_sensitivity, 100, 'sensitivity tops out at 100');
  assert.equal(r.detect_cooldown_s, 60, 'a cooldown of 0 is meaningless, so the default applies');
  assert.equal(r.detect_confirm_s, 0, 'confirm has a real floor of 0 — no delay is a valid choice');
  assert.equal(r.detect_start, 1439, 'minutes-since-midnight cannot leave the day');
  assert.equal(r.detect_end, 0);
  assert.equal(r.sound_sensitivity, 50, 'sound sensitivity is 1..100, so 0 falls back to the default');
  assert.equal(r.sound_confirm_s, 999, 'confirm has no upper clamp — the form is what bounds it');
  assert.equal(r.sound_cooldown_s, 99999);
});

test('★ …and at the BOTTOM of the range too, not just the top', async () => {
  // ⚠️ The clamp test above sends 500 (upper) and a sound sensitivity of 0 — but 0 never reaches the
  // clamp, `|| 50` absorbs it first. So the LOWER bound of both sensitivities was untested, and
  // widening `Math.max(1, …)` to `Math.max(-999, …)` survived the whole suite. A negative sensitivity
  // is not academic: it would store a threshold no frame can ever meet, and motion detection would be
  // silently dead with the screen showing it as on.
  const res = await put({ motion_enabled: true, sensitivity: -5, sound_sensitivity: -20 });
  assert.equal(res.status, 200);
  assert.equal(row().detect_sensitivity, 1, 'sensitivity has a floor of 1');
  assert.equal(row().sound_sensitivity, 1);
});

test('garbage in a numeric field falls back to the default instead of writing NaN', async () => {
  // `Number('soon')` is NaN, and a NaN reaching SQLite would make the detector unarmable in a way
  // nothing on screen would explain.
  const res = await put({ motion_enabled: true, sensitivity: 'very', cooldown_s: 'soon', confirm_s: 'later' });
  assert.equal(res.status, 200);
  assert.equal(row().detect_sensitivity, 50);
  assert.equal(row().detect_cooldown_s, 60);
  assert.equal(row().detect_confirm_s, 0);
});

test('blank text fields are stored as null, not as empty strings', async () => {
  // The detector checks these for presence. An empty string is truthy in SQL comparisons often enough
  // to matter, and "" as an MQTT topic would subscribe to nothing while looking configured.
  const res = await put({ motion_enabled: true, motion_mqtt_topic: '   ', motion_mqtt_value: '', snapshot_url: '  ' });
  assert.equal(res.status, 200);
  const r = row();
  assert.equal(r.motion_mqtt_topic, null);
  assert.equal(r.motion_mqtt_value, null);
  assert.equal(r.snapshot_url, null);
});

test('an unknown camera is a 404, not a silent success', async () => {
  const res = await call(`${server.url}/api/cameras/nope/detection`, {
    method: 'PUT', token: adminToken, body: { motion_enabled: true },
  });
  assert.equal(res.status, 404);
});

test('★ a caregiver cannot change detection settings', async () => {
  // Role gating is checked here rather than assumed: this repo has already shipped an admin-only
  // route that 403'd everyone, invisible in review. The mirror of that — a caregiver-writable
  // admin route — is the one worth catching.
  const before = row().detect_sensitivity;
  const res = await put({ motion_enabled: true, sensitivity: 5 }, caregiverToken);
  assert.equal(res.status, 403);
  assert.equal(row().detect_sensitivity, before, 'and nothing was written on the way to being refused');
});

// -------------------------------------------------------------------------------------------
// Snapshot credentials survive a round trip through the form — issue #271.
//
// ⚠️ THIS IS THE CLIENT/SERVER SEAM, and a unit test on urlCredentials.js cannot reach it. The server
// now strips the password before sending, so the form CANNOT send it back; if the PUT handler did not
// carry the stored one forward, every ordinary save of the detection screen would silently wipe the
// snapshot credential and alert images would start failing with no visible cause.
describe('snapshot_url credentials (#271)', () => {
  const SECRET = 'snap-secret-7c1';
  const WITH_PW = `http://admin:${SECRET}@cam.local/snap.jpg`;
  const setStored = (v) => db.prepare('UPDATE cameras SET snapshot_url = ? WHERE id = ?').run(v, CAM);

  test('a save that does not mention the password keeps it', async () => {
    setStored(WITH_PW);
    // Exactly what the form now sends: the stripped URL it was given, and no password field at all.
    const res = await put({ ...CONFIGURED_PAYLOAD(), snapshot_url: 'http://admin@cam.local/snap.jpg' });
    assert.equal(res.status, 200);
    assert.equal(row().snapshot_url, WITH_PW, 'an ordinary save wiped the stored snapshot password');
  });

  test('and the response still never contains it', async () => {
    setStored(WITH_PW);
    const res = await put({ ...CONFIGURED_PAYLOAD(), snapshot_url: 'http://admin@cam.local/snap.jpg' });
    assert.ok(!JSON.stringify(res.body).includes(SECRET), `the password came back in the PUT response: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.snapshot_has_password, true, 'the form cannot tell a password is set');
  });

  test('typing a new password replaces it', async () => {
    setStored(WITH_PW);
    const res = await put({ ...CONFIGURED_PAYLOAD(), snapshot_url: 'http://admin@cam.local/snap.jpg', snapshot_password: 'replaced' });
    assert.equal(res.status, 200);
    assert.equal(row().snapshot_url, 'http://admin:replaced@cam.local/snap.jpg');
  });

  test('★ pointing the URL at a different host does NOT forward the password', async () => {
    setStored(WITH_PW);
    await put({ ...CONFIGURED_PAYLOAD(), snapshot_url: 'http://somewhere-else.example/snap.jpg' });
    assert.ok(!row().snapshot_url.includes(SECRET), `the stored credential was sent to a new host: ${row().snapshot_url}`);
  });

  test('clearing the field clears the endpoint', async () => {
    setStored(WITH_PW);
    await put({ ...CONFIGURED_PAYLOAD(), snapshot_url: '' });
    assert.equal(row().snapshot_url, null);
  });
});
