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
    'http://192.0.2.10/snap.jpg'
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

  test('still returns the fields the tile needs', async () => {
    const r = await unassign(caregiverToken);
    for (const field of ['id', 'name', 'child_id']) {
      assert.ok(field in r.body, `${field} missing — the camera tile needs it`);
    }
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
    assert.ok(
      !JSON.stringify(r.body).includes(PLANTED),
      `a raw credential reached the admin response: ${JSON.stringify(r.body)}`
    );
  });
});
