// What PUT /cameras/:id/assign is allowed to tell a caregiver.
//
// Assignment is deliberately open to caregivers — attaching a camera to a child is day-to-day
// caregiving, not administration — so this is one of the few camera routes a non-admin can reach. It
// was also the only site in routes/cameras.js that returned the raw database row instead of going
// through publicCamera(), which handed out rtsp_url with the stream password embedded in it, plus the
// ONVIF and talk credentials (GHSA-43c3-wrx8-fq39).
//
// The ONVIF account on typical consumer cameras is the camera's own administrator account, so this
// crossed out of the app entirely: the credentials reach the camera's web UI and firmware.
//
// These tests assert the SHAPE of the mistake — that no response carries a credential-bearing field —
// rather than naming the fields that leaked, so a column added to `cameras` later fails them too.
import { test, before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, makeChild, makeCamera, signToken,
  mountRouter, call,
} from './helpers/harness.js';

useTempDataDir();

const { default: db } = await import('../src/db.js');
const { default: camerasRouter } = await import('../src/routes/cameras.js');

let server;
let adminToken;
let caregiverToken;

// Every column on `cameras` that carries, or can carry, a credential. rtsp_url and sub_rtsp_url are
// the dangerous ones: the password is embedded IN the URL, so masking the *_password columns alone
// would still leak it. snapshot_url can carry HTTP Basic credentials.
const CREDENTIAL_FIELDS = [
  'rtsp_url', 'sub_rtsp_url', 'onvif_username', 'onvif_password',
  'talk_username', 'talk_password', 'snapshot_url',
];

const PLANTED = 'LEAK-camera-secret';

before(async () => {
  server = await mountRouter('/api/cameras', camerasRouter);
});

beforeEach(() => {
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM users').run();
  db.prepare('DELETE FROM cameras').run();
  db.prepare('DELETE FROM children').run();

  const admin = makeUser(db, { id: 'u-a', username: 'admin', role: 'admin' });
  const care = makeUser(db, { id: 'u-c', username: 'nanny', role: 'caregiver' });
  adminToken = signToken({ id: admin.id, username: admin.username, role: 'admin', sid: makeSession(db, admin.id) });
  caregiverToken = signToken({ id: care.id, username: care.username, role: 'caregiver', sid: makeSession(db, care.id) });

  makeChild(db, { id: 'kid-1' });
  makeCamera(db, { id: 'cam-1', childId: 'kid-1' });
  // Plant a recognisable value in every credential column. On a fresh row most are NULL, and a NULL
  // that leaks looks identical to a field that was correctly stripped — which is how this kind of bug
  // survives review.
  db.prepare(
    `UPDATE cameras SET rtsp_url = ?, sub_rtsp_url = ?, onvif_username = ?, onvif_password = ?,
       talk_username = ?, talk_password = ?, snapshot_url = ? WHERE id = 'cam-1'`
  ).run(
    `rtsp://admin:${PLANTED}@192.0.2.10:554/ch0`,
    `rtsp://admin:${PLANTED}@192.0.2.10:554/ch1`,
    'onvifuser', PLANTED,
    'talkuser', PLANTED,
    `http://admin:${PLANTED}@192.0.2.10/snap.jpg`
  );
});

after(async () => {
  await server?.close();
  db.close();
  cleanupTempDataDirs();
});

// Unassign rather than assign: clearing child_id makes motionLegWanted() false, so the route takes the
// stopMotionDetector branch and never tries to spawn ffmpeg. The response shape is identical either
// way, and this keeps the test from depending on a media stack that isn't running.
const unassign = (token) =>
  call(`${server.url}/api/cameras/cam-1/assign`, { method: 'PUT', token, body: { child_id: null } });

describe('PUT /cameras/:id/assign as a caregiver', () => {
  test('succeeds — assignment is intentionally open to caregivers', async () => {
    const r = await unassign(caregiverToken);
    assert.equal(r.status, 200, `expected 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(db.prepare('SELECT child_id FROM cameras WHERE id = ?').get('cam-1').child_id, null);
  });

  test('returns no credential-bearing field', async () => {
    const r = await unassign(caregiverToken);
    for (const field of CREDENTIAL_FIELDS) {
      assert.equal(r.body[field], undefined, `${field} was returned to a caregiver`);
    }
  });

  test('no planted secret appears anywhere in the payload', async () => {
    const r = await unassign(caregiverToken);
    assert.ok(
      !JSON.stringify(r.body).includes(PLANTED),
      `a camera credential reached a caregiver: ${JSON.stringify(r.body)}`
    );
  });

  test('does not get the admin edit-form view', async () => {
    // Hard-coding publicCamera(updated, true) leaks no planted marker to a caregiver — it hands them
    // the admin SHAPE. The marker sweep cannot see that, so assert on the admin-only keys directly, or
    // that mutant survives.
    const r = await unassign(caregiverToken);
    for (const field of ['rtsp_host', 'rtsp_port', 'rtsp_path', 'rtsp_username', 'rtsp_display',
                         'rtsp_has_password', 'talk_has_password', 'sub_rtsp_path']) {
      assert.equal(r.body[field], undefined, `${field} is admin-only but reached a caregiver`);
    }
  });

  test('still returns the fields the tile needs', async () => {
    const r = await unassign(caregiverToken);
    for (const field of ['id', 'name', 'child_id']) {
      assert.ok(field in r.body, `${field} missing — the camera tile needs it`);
    }
  });
});

describe('the credential list itself stays honest', () => {
  // The header above claims these tests catch a credential column added to `cameras` later. That was
  // not true as written: the fixture is a hand-written UPDATE naming seven columns and
  // CREDENTIAL_FIELDS is a seven-element literal, so a new column would simply be invisible to both.
  //
  // This is the tripwire that makes the claim real. It reads the live schema and fails when a column
  // appears whose NAME suggests it carries a credential and which nobody has classified yet. The fix
  // when it fires is to decide: strip it in publicCamera and add it to CREDENTIAL_FIELDS, or add it to
  // REVIEWED_SAFE with a reason.
  const REVIEWED_SAFE = new Set([
    'mediamtx_path',      // server-generated local path, no credential
    'onvif_device_url',   // bare service endpoint; ONVIF creds live in their own columns
    'motion_mqtt_topic',  // topic name; broker credentials are in `settings`, not here
    'motion_mqtt_value',  // the payload value that means "motion"
    'talk_backend',       // which backchannel implementation, e.g. 'onvif'
    'discovery_source',   // 'manual' | 'onvif'
    // Named "token" but it is not authentication material: an ONVIF MEDIA PROFILE identifier
    // (e.g. 'Profile_1'), stored so PTZ commands don't have to re-probe. It selects which profile
    // to act on; the credentials that authorise the call are onvif_username/onvif_password.
    // Caught by this tripwire on its first run, which is the point of it.
    'onvif_profile_token',
  ]);

  test('no unclassified column on `cameras` looks like a credential', () => {
    const cols = db.prepare('PRAGMA table_info(cameras)').all().map((c) => c.name);
    const suspicious = cols.filter((c) => /pass|secret|token|cred|auth|url|user/i.test(c));
    const unclassified = suspicious.filter(
      (c) => !CREDENTIAL_FIELDS.includes(c) && !REVIEWED_SAFE.has(c)
    );
    assert.deepEqual(
      unclassified, [],
      `new column(s) on \`cameras\` that may carry a credential and are classified nowhere: ` +
      `${unclassified.join(', ')}. Either strip them in publicCamera() and add them to ` +
      `CREDENTIAL_FIELDS, or add them to REVIEWED_SAFE with a reason.`
    );
  });

  test('every field CREDENTIAL_FIELDS names is really a column', () => {
    // Guards the other direction: a renamed column would silently make an assertion vacuous, because
    // `undefined === undefined` passes for a field that no longer exists.
    const cols = new Set(db.prepare('PRAGMA table_info(cameras)').all().map((c) => c.name));
    const missing = CREDENTIAL_FIELDS.filter((f) => !cols.has(f));
    assert.deepEqual(missing, [], `CREDENTIAL_FIELDS names column(s) that no longer exist: ${missing.join(', ')}`);
  });
});

describe('PUT /cameras/:id/assign as an admin', () => {
  test('gets the edit-form fields, but never a raw credential', async () => {
    const r = await unassign(adminToken);
    assert.equal(r.status, 200);
    // publicCamera gives an admin the address broken into fields plus has_password flags — never the
    // password itself, and never the credentialed URL.
    assert.ok('rtsp_host' in r.body, 'admin should get the address components for the edit form');
    assert.equal(r.body.rtsp_has_password, true);
    // An admin DOES get talk_username and snapshot_url — both are edit-form fields, and publicCamera
    // returns the talk password only as a has_password flag. What an admin must never get is a raw
    // secret or a credentialed URL.
    for (const field of ['rtsp_url', 'sub_rtsp_url', 'onvif_username', 'onvif_password', 'talk_password']) {
      assert.equal(r.body[field], undefined, `${field} was returned to an admin as a raw value`);
    }
    // ★ FIXED in issue #271. This assertion used to pin the OPPOSITE: snapshot_url came back to an
    // admin verbatim, embedded Basic-auth credentials included, marked "known and deliberate" because
    // the edit box had to show what the operator typed. It was the one credential-bearing column
    // publicCamera returned raw, three lines from two that were handled correctly. It now gets the
    // same treatment as the RTSP password — the URL without the password, plus a has_password flag.
    assert.equal(r.body.snapshot_url, 'http://admin@192.0.2.10/snap.jpg', 'the password is still in the URL');
    assert.equal(r.body.snapshot_has_password, true, 'the admin cannot tell a password is set');
    // ★★ NO CARVE-OUT ANY MORE. This used to destructure snapshot_url out before scanning, which is
    // precisely how the leak stayed invisible: the one field that leaked was the one excluded from the
    // check. The planted marker must now appear NOWHERE in the whole response.
    assert.ok(
      !JSON.stringify(r.body).includes(PLANTED),
      `a raw credential reached the admin response: ${JSON.stringify(r.body)}`
    );
  });
});
