// #552 (PR2): WHO silenced, un-silenced, restarted or rebooted a camera, through the REAL routes.
//
// The claims this file holds (the PR body names them):
//   C1  each of snooze, un-snooze, restart and reboot, on success AND on failure, writes ONE Camera history
//       row naming the actor by user id and username;
//   C2  a system event (a watchdog's) carries a NULL actor;
//   C3  the tile's name (`alerts_snoozed_by`) is sent only while the camera is actually muted;
//   C4  a snooze whose history row cannot be written is NOT applied (500, the camera as it was, no row), while
//       a restart whose row cannot be written still answers 200 (best-effort, it has already happened);
//   C5  a person deleted while their restart is awaiting is still named, as the database knew them when they
//       acted (actorOf runs before the await);
//   C6  a self-chosen first name cannot impersonate: the row carries the admin-set username;
//   C9  every key an open page already reads is still in each response;
//   C10 the diagnostics bundle carries no username and no user id;
//   C11 an un-mute of a camera that is not muted writes nothing, so un-mutes cannot flood the shared cap and
//       push another camera's silence row out (PR #663 review);
//   C12 a silence prunes Camera history back to its cap after it commits (PR #663 review).
// C5 is checked on /restart AND on /reboot.
//
// Faked: lib/transcoder.js and lib/onvif.js (neither is in test:core's coverage include list, so mock.module is
// safe here; see backend-test-suite notes), so no ffmpeg and no camera is touched. A stand-in MediaMTX answers
// the diagnostics bundle's status calls. NOT covered (negative space): a real camera's reboot, a real ffmpeg
// restart, and the watchdog loop itself (C2 calls the same recordCameraEvent the watchdog calls, with the
// same four arguments).
import { test, mock, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, makeCamera, signToken, mountRouter, call,
} from './helpers/harness.js';

useTempDataDir();

// What the faked transcoder and ONVIF client do, set per test. Default: succeed at once.
const fake = {
  startTranscoder: async () => {},
  rebootCamera: async () => {},
};
mock.module('../src/lib/transcoder.js', {
  exports: {
    isRunning: () => false,
    startTranscoder: (...a) => fake.startTranscoder(...a),
    stopTranscoder: () => {},
    stopAllTranscoders: async () => {},
  },
});
mock.module('../src/lib/onvif.js', {
  exports: {
    probeOnvifCamera: async () => ({}),
    subscribeMotionEvents: () => ({ stop() {} }),
    ptzContinuousMove: async () => {},
    ptzStop: async () => {},
    ptzNudge: async () => {},
    probePtzRelativeSupport: async () => false,
    rebootCamera: (...a) => fake.rebootCamera(...a),
    ptzRelativeStep: async () => {},
  },
});

// A stand-in MediaMTX: the diagnostics bundle asks it for each enabled camera's status. Listening BEFORE the
// dynamic imports, because mediamtx.js reads MEDIAMTX_API at load.
const mediamtx = createServer((req, res) => { res.statusCode = 404; res.end('{}'); });
await new Promise((r) => mediamtx.listen(0, '127.0.0.1', r));
process.env.MEDIAMTX_API = `http://127.0.0.1:${mediamtx.address().port}`;

const { default: db } = await import('../src/db.js');
const { default: camerasRouter } = await import('../src/routes/cameras.js');
const { default: eventsRouter } = await import('../src/routes/events.js');
const { default: diagnosticsRouter } = await import('../src/routes/diagnostics.js');
const { recordCameraEvent, EVENT } = await import('../src/lib/cameraEvents.js');
const { actorOf } = await import('../src/lib/actor.js');

const CAM = 'cam-who';
const REBOOTABLE = 'cam-who-onvif';
let cams;
let events;
let diag;
let adminToken;
let carerToken;

const tokenFor = ({ id, username, role }) => signToken({ id, username, role, sid: makeSession(db, id) });
const rows = () => db.prepare('SELECT * FROM camera_events ORDER BY id').all();
const camRow = (id = CAM) => db.prepare('SELECT alerts_snoozed_until, alerts_snoozed_by FROM cameras WHERE id = ?').get(id);
const post = (path, token, body) => call(`${cams.url}/api/cameras/${path}`, { method: 'POST', token, body });

before(async () => {
  cams = await mountRouter('/api/cameras', camerasRouter);
  events = await mountRouter('/api/events', eventsRouter);
  diag = await mountRouter('/api/diagnostics', diagnosticsRouter);
  makeUser(db, { id: 'u-admin', username: 'admin-login', role: 'admin' });
  makeUser(db, { id: 'u-carer', username: 'carer-login', role: 'caregiver' });
  adminToken = tokenFor({ id: 'u-admin', username: 'admin-login', role: 'admin' });
  carerToken = tokenFor({ id: 'u-carer', username: 'carer-login', role: 'caregiver' });
});

beforeEach(() => {
  fake.startTranscoder = async () => {};
  fake.rebootCamera = async () => {};
  db.prepare('DROP TRIGGER IF EXISTS refuse_history').run();
  db.prepare('DELETE FROM camera_events').run();
  db.prepare('DELETE FROM cameras').run();
  makeCamera(db, { id: CAM, name: 'Who Cam' });
  makeCamera(db, {
    id: REBOOTABLE, name: 'Who Onvif Cam',
    extra: { onvif_capable: 1, onvif_device_url: 'http://192.0.2.10:8000/onvif/device_service' },
  });
});

after(async () => {
  await cams?.close();
  await events?.close();
  await diag?.close();
  await new Promise((r) => mediamtx.close(r));
  db.close();
  cleanupTempDataDirs();
});

// A history write that always fails: what a full disk or a locked/corrupt table looks like to the route.
const refuseHistory = () => db.prepare(
  "CREATE TRIGGER refuse_history BEFORE INSERT ON camera_events BEGIN SELECT RAISE(ABORT, 'history write refused (test)'); END"
).run();

// --- C1: every person-caused event names the person ---------------------------------------------------------

describe('C1: each action writes one row naming who did it', () => {
  test('a silence: muted, the tile name set, one row with the actor', async () => {
    const res = await post(`${CAM}/snooze`, carerToken, { minutes: 30 });
    assert.equal(res.status, 200);
    assert.equal(res.body.alerts_snoozed_by, 'carer-login');
    assert.equal(camRow().alerts_snoozed_by, 'carer-login');
    assert.ok(camRow().alerts_snoozed_until > Date.now(), 'and it really is muted');
    const r = rows();
    assert.equal(r.length, 1, 'exactly one row');
    assert.equal(r[0].type, EVENT.SNOOZE);
    assert.equal(r[0].detail, 'muted for 30 min');
    assert.equal(r[0].actor_user_id, 'u-carer');
    assert.equal(r[0].actor_username, 'carer-login');
  });

  test('an un-mute: the name cleared WITH the time, one row with the actor', async () => {
    await post(`${CAM}/snooze`, carerToken, { minutes: 30 });
    const res = await post(`${CAM}/snooze`, adminToken, { minutes: 0 });
    assert.equal(res.status, 200);
    assert.equal(res.body.alerts_snoozed_until, null);
    assert.equal(res.body.alerts_snoozed_by, null);
    assert.deepEqual(camRow(), { alerts_snoozed_until: null, alerts_snoozed_by: null },
      'an un-mute leaves no name behind a silence that has ended');
    const last = rows().at(-1);
    assert.equal(rows().length, 2);
    assert.deepEqual([last.type, last.detail, last.actor_user_id, last.actor_username],
      [EVENT.SNOOZE, 'un-muted', 'u-admin', 'admin-login']);
  });

  test('a restart that worked', async () => {
    const res = await post(`${CAM}/restart`, carerToken);
    assert.equal(res.status, 200);
    const r = rows();
    assert.equal(r.length, 1);
    assert.deepEqual([r[0].type, r[0].detail, r[0].actor_user_id, r[0].actor_username],
      [EVENT.RESTART, 'stream restarted manually', 'u-carer', 'carer-login']);
  });

  test('a restart that failed is recorded too, with fixed text, never the error (which can carry an address)', async () => {
    fake.startTranscoder = async () => { throw new Error('rtsp://cam:PLANTED-SECRET@192.0.2.7/live refused'); };
    const res = await post(`${CAM}/restart`, carerToken);
    assert.equal(res.status, 502, 'the failure itself is still reported as before');
    const r = rows();
    assert.equal(r.length, 1, 'one row for the failed attempt');
    assert.deepEqual([r[0].type, r[0].detail, r[0].actor_user_id, r[0].actor_username],
      [EVENT.RESTART, 'stream restart failed', 'u-carer', 'carer-login']);
    assert.ok(!JSON.stringify(r[0]).includes('PLANTED-SECRET'), 'the error text did not reach the history');
  });

  test('a reboot that the camera confirmed', async () => {
    const res = await post(`${REBOOTABLE}/reboot`, carerToken);
    assert.equal(res.status, 200);
    const r = rows();
    assert.equal(r.length, 1);
    assert.deepEqual([r[0].type, r[0].detail, r[0].actor_user_id, r[0].actor_username],
      [EVENT.RESTART, 'camera reboot requested (ONVIF)', 'u-carer', 'carer-login']);
  });

  test('a reboot the camera did not confirm is recorded as requested-but-unconfirmed', async () => {
    fake.rebootCamera = async () => { throw new Error('socket hang up from 192.0.2.10'); };
    const res = await post(`${REBOOTABLE}/reboot`, adminToken);
    assert.equal(res.status, 502);
    const r = rows();
    assert.equal(r.length, 1);
    assert.deepEqual([r[0].type, r[0].detail, r[0].actor_user_id, r[0].actor_username],
      [EVENT.RESTART, 'camera reboot requested (ONVIF); the camera did not confirm', 'u-admin', 'admin-login']);
    assert.ok(!r[0].detail.includes('192.0.2.10'), 'fixed text, not the error');
  });

  test('a refused request (unknown camera, disabled camera, not rebootable) writes nothing: nothing was attempted', async () => {
    db.prepare('UPDATE cameras SET disabled = 1 WHERE id = ?').run(CAM);
    assert.equal((await post('no-such-cam/restart', carerToken)).status, 404);
    assert.equal((await post(`${CAM}/restart`, carerToken)).status, 400);
    assert.equal((await post(`${CAM}/reboot`, carerToken)).status, 400);
    assert.equal((await post('no-such-cam/snooze', carerToken, { minutes: 15 })).status, 404);
    assert.equal(rows().length, 0);
  });
});

// --- C2 ---------------------------------------------------------------------------------------------------------

test('C2: an event the system writes (the watchdog calls it with four arguments) has a NULL actor', () => {
  recordCameraEvent(CAM, 'Who Cam', EVENT.OFFLINE, 'stream stopped delivering frames');
  const [r] = rows();
  assert.equal(r.actor_user_id, null);
  assert.equal(r.actor_username, null);
});

// --- C3 ---------------------------------------------------------------------------------------------------------

test('C3: the tile gets the name only while the camera is muted, for a caregiver and an admin alike', async () => {
  // Every camera disabled so the list never asks MediaMTX (and its status is irrelevant here).
  db.prepare('UPDATE cameras SET disabled = 1').run();
  makeCamera(db, { id: 'cam-expired', name: 'Expired', extra: { disabled: 1 } });
  makeCamera(db, { id: 'cam-never', name: 'Never', extra: { disabled: 1 } });
  db.prepare('UPDATE cameras SET alerts_snoozed_until = ?, alerts_snoozed_by = ? WHERE id = ?')
    .run(Date.now() + 3_600_000, 'muter-login', CAM);
  // Expired, with the name the route leaves behind when a silence simply runs out (only an un-mute clears it).
  db.prepare('UPDATE cameras SET alerts_snoozed_until = ?, alerts_snoozed_by = ? WHERE id = ?')
    .run(Date.now() - 60_000, 'stale-login', 'cam-expired');
  for (const token of [carerToken, adminToken]) {
    const res = await call(`${cams.url}/api/cameras`, { token });
    assert.equal(res.status, 200);
    const by = Object.fromEntries(res.body.map((c) => [c.id, c.alerts_snoozed_by]));
    assert.equal(by[CAM], 'muter-login', 'muted now: named');
    assert.equal(by['cam-expired'], null, 'a silence that ran out names nobody');
    assert.equal(by['cam-never'], null);
    assert.ok(!JSON.stringify(res.body).includes('stale-login'), 'the stale name is not sent anywhere in the list');
  }
});

// --- C4 ---------------------------------------------------------------------------------------------------------

describe('C4: a silence is applied only together with its history row', () => {
  test('★ the row cannot be written: 500, the camera exactly as it was, and no row', async () => {
    // A camera ALREADY muted by someone else, so a half-applied write would show (a fresh camera could hide a
    // write that set the same NULLs it started with).
    const earlier = Date.now() + 10 * 60_000;
    db.prepare('UPDATE cameras SET alerts_snoozed_until = ?, alerts_snoozed_by = ? WHERE id = ?').run(earlier, 'earlier-login', CAM);
    refuseHistory();
    for (const minutes of [60, 0]) {
      const res = await post(`${CAM}/snooze`, carerToken, { minutes });
      assert.equal(res.status, 500, `minutes=${minutes}: refused`);
      assert.deepEqual(camRow(), { alerts_snoozed_until: earlier, alerts_snoozed_by: 'earlier-login' },
        `minutes=${minutes}: neither the time nor the name moved`);
    }
    db.prepare('DROP TRIGGER refuse_history').run();
    assert.equal(rows().length, 0, 'and no row');
  });

  test('a fresh camera stays unmuted when the row cannot be written', async () => {
    refuseHistory();
    assert.equal((await post(`${CAM}/snooze`, carerToken, { minutes: 15 })).status, 500);
    assert.deepEqual(camRow(), { alerts_snoozed_until: null, alerts_snoozed_by: null });
  });

  test('the contrast: a restart whose row cannot be written still answers 200, because it has already happened', async () => {
    refuseHistory();
    let restarted = 0;
    fake.startTranscoder = async () => { restarted++; };
    const res = await post(`${CAM}/restart`, carerToken);
    assert.equal(res.status, 200);
    assert.equal(restarted, 1);
    db.prepare('DROP TRIGGER refuse_history').run();
    assert.equal(rows().length, 0);
  });
});

// --- C5 ---------------------------------------------------------------------------------------------------------

test('★ C5: an account deleted while its restart is awaiting is still named, as it was when it acted', async () => {
  // The account was RENAMED by an admin after this token was minted, so the token's own claim
  // ('renamed-before-login') is stale. Read before the await, the row names the account as the database knew
  // it ('renamed-now'). Read after it (when the account is gone), only the stale claim is left: so the two
  // orders give different rows, which is what makes this test able to tell them apart.
  makeUser(db, { id: 'u-leaving', username: 'renamed-before-login', role: 'caregiver' });
  const token = tokenFor({ id: 'u-leaving', username: 'renamed-before-login', role: 'caregiver' });
  db.prepare("UPDATE users SET username = 'renamed-now' WHERE id = 'u-leaving'").run();
  let release;
  let started;
  const startedP = new Promise((r) => { started = r; });
  fake.startTranscoder = () => { started(); return new Promise((r) => { release = r; }); };
  const pending = post(`${CAM}/restart`, token);
  await startedP;
  db.prepare("DELETE FROM users WHERE id = 'u-leaving'").run(); // sessions go with it (ON DELETE CASCADE)
  assert.equal(db.prepare("SELECT COUNT(*) c FROM sessions WHERE user_id = 'u-leaving'").get().c, 0, 'setup: gone');
  release();
  const res = await pending;
  assert.equal(res.status, 200);
  const [r] = rows();
  assert.equal(r.actor_user_id, 'u-leaving');
  assert.equal(r.actor_username, 'renamed-now');
});

test('★ C5, the reboot: an account renamed, then deleted while its reboot is awaiting, is named as it was when it acted', async () => {
  // The same shape as the restart case above, on /reboot (PR #663 review: the reboot's own "actorOf after the
  // await" mutant survived without this). Rename after the token was minted, delete mid-await: read first,
  // the row says 'reboot-renamed-now'; read late, only the token's stale claim is left.
  makeUser(db, { id: 'u-reboot-leaving', username: 'reboot-claim-at-login', role: 'caregiver' });
  const token = tokenFor({ id: 'u-reboot-leaving', username: 'reboot-claim-at-login', role: 'caregiver' });
  db.prepare("UPDATE users SET username = 'reboot-renamed-now' WHERE id = 'u-reboot-leaving'").run();
  let release;
  let started;
  const startedP = new Promise((r) => { started = r; });
  fake.rebootCamera = () => { started(); return new Promise((r) => { release = r; }); };
  const pending = post(`${REBOOTABLE}/reboot`, token);
  await startedP;
  db.prepare("DELETE FROM users WHERE id = 'u-reboot-leaving'").run();
  assert.equal(db.prepare("SELECT COUNT(*) c FROM sessions WHERE user_id = 'u-reboot-leaving'").get().c, 0, 'setup: gone');
  release();
  const res = await pending;
  assert.equal(res.status, 200);
  const [r] = rows();
  assert.equal(r.detail, 'camera reboot requested (ONVIF)');
  assert.equal(r.actor_user_id, 'u-reboot-leaving');
  assert.equal(r.actor_username, 'reboot-renamed-now');
});

// --- an un-mute that changes nothing writes nothing (PR #663 review) -----------------------------------------

describe('an un-mute of a camera that is not muted writes nothing', () => {
  test('★ never muted, or muted and run out: 200, "not muted", no row, the camera row untouched', async () => {
    const ranOut = Date.now() - 60_000;
    db.prepare('UPDATE cameras SET alerts_snoozed_until = ?, alerts_snoozed_by = ? WHERE id = ?').run(ranOut, 'stale-login', REBOOTABLE);
    for (const id of [CAM, REBOOTABLE]) {
      const before_ = camRow(id);
      const res = await post(`${id}/snooze`, carerToken, { minutes: 0 });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { ok: true, alerts_snoozed_until: null, alerts_snoozed_by: null });
      assert.deepEqual(camRow(id), before_, `${id}: the stored state did not change`);
    }
    assert.equal(rows().length, 0, 'no history row for an un-mute that changed nothing');
  });

  test('★ the flood: un-mutes of an un-muted camera cannot push another camera\'s silence out of the shared cap', async () => {
    // Camera history keeps the newest 2,000 rows across EVERY camera (lib/cameraEvents.js, docs). Smaller form of
    // the reviewer's reproduction (2,000 un-mutes): the silence row first, 1,990 other rows after it, then 15
    // un-mutes of a camera that was never muted. Writing a row each would make 2,006 and prune the silence row.
    assert.equal((await post(`${CAM}/snooze`, carerToken, { minutes: 720 })).status, 200);
    const plant = db.prepare("INSERT INTO camera_events (camera_id, camera_name, type, detail) VALUES ('cam-elsewhere', 'Elsewhere', 'offline', 'filler')");
    db.transaction(() => { for (let i = 0; i < 1990; i++) plant.run(); })();
    for (let i = 0; i < 15; i++) {
      assert.equal((await post(`${REBOOTABLE}/snooze`, carerToken, { minutes: 0 })).status, 200);
    }
    const r = rows();
    assert.equal(r.length, 1991, 'nothing was added');
    const mute = r.find((x) => x.camera_id === CAM);
    assert.ok(mute, 'the silence row survived');
    assert.deepEqual([mute.detail, mute.actor_username], ['muted for 720 min', 'carer-login']);
    assert.ok(camRow(CAM).alerts_snoozed_until > Date.now(), 'and the camera is still muted');
  });

  test('the contrast: un-muting a camera that IS muted still records who did it', async () => {
    db.prepare('UPDATE cameras SET alerts_snoozed_until = ?, alerts_snoozed_by = ? WHERE id = ?').run(Date.now() + 600_000, 'admin-login', CAM);
    const res = await post(`${CAM}/snooze`, carerToken, { minutes: 0 });
    assert.equal(res.status, 200);
    assert.deepEqual(camRow(), { alerts_snoozed_until: null, alerts_snoozed_by: null });
    const r = rows();
    assert.equal(r.length, 1);
    assert.deepEqual([r[0].detail, r[0].actor_username], ['un-muted', 'carer-login']);
  });
});

test('★ a silence prunes Camera history back to its cap, after the commit, keeping its own row', async () => {
  // PR #663 review: deleting the route's pruneCameraEvents() call survived. 2,005 rows already there (more than
  // the documented 2,000), then one silence: the table is back at 2,000 and the newest row is the silence's.
  const plant = db.prepare("INSERT INTO camera_events (camera_id, camera_name, type, detail) VALUES ('cam-elsewhere', 'Elsewhere', 'offline', 'filler')");
  db.transaction(() => { for (let i = 0; i < 2005; i++) plant.run(); })();
  assert.equal((await post(`${CAM}/snooze`, carerToken, { minutes: 30 })).status, 200);
  const r = rows();
  assert.equal(r.length, 2000);
  assert.deepEqual([r.at(-1).camera_id, r.at(-1).detail, r.at(-1).actor_username], [CAM, 'muted for 30 min', 'carer-login']);
});

// --- C6 ---------------------------------------------------------------------------------------------------------

test('★ C6: a caregiver whose first name is "Admin" is recorded by their username, everywhere', async () => {
  makeUser(db, { id: 'u-spoof', username: 'spoof-login', role: 'caregiver' });
  db.prepare("UPDATE users SET first_name = 'Admin', last_name = 'Account' WHERE id = 'u-spoof'").run();
  const token = tokenFor({ id: 'u-spoof', username: 'spoof-login', role: 'caregiver' });
  const res = await post(`${CAM}/snooze`, token, { minutes: 15 });
  assert.equal(res.body.alerts_snoozed_by, 'spoof-login');
  assert.equal(camRow().alerts_snoozed_by, 'spoof-login');
  const [r] = rows();
  assert.equal(r.actor_username, 'spoof-login');
  assert.ok(!JSON.stringify(rows()).includes('Admin'), 'the first name appears nowhere in the history');
});

// --- actorOf directly: the branches the routes cannot reach --------------------------------------------------

describe('actorOf', () => {
  test('a live session: the database row, not the token claim', () => {
    const sid = makeSession(db, 'u-carer');
    assert.deepEqual(actorOf({ user: { id: 'u-carer', username: 'stale-claim', sid } }), { user_id: 'u-carer', username: 'carer-login' });
  });
  test('the session is gone: the verified token\'s own id and username, never null (a person is not the system)', () => {
    assert.deepEqual(actorOf({ user: { id: 'u-x', username: 'x-login', sid: 'no-such-session' } }), { user_id: 'u-x', username: 'x-login' });
    assert.deepEqual(actorOf({ user: { id: 'u-x', username: 'x-login' } }), { user_id: 'u-x', username: 'x-login' }, 'no sid at all');
    assert.deepEqual(actorOf({ user: { sid: 'no-such-session' } }), { user_id: null, username: null }, 'a claim-less token');
  });
  test('no signed-in user: null', () => {
    assert.equal(actorOf({}), null);
    assert.equal(actorOf(undefined), null);
  });
});

// --- C9 ---------------------------------------------------------------------------------------------------------

test('C9: every key an open page already reads is still in each response (keys are only ADDED)', async () => {
  const snooze = await post(`${CAM}/snooze`, carerToken, { minutes: 15 });
  for (const k of ['ok', 'alerts_snoozed_until']) assert.ok(Object.hasOwn(snooze.body, k), `snooze response lost ${k}`);
  assert.equal(snooze.body.ok, true);
  assert.equal(typeof snooze.body.alerts_snoozed_until, 'number');
  assert.deepEqual((await post(`${CAM}/restart`, carerToken)).body, { ok: true });
  assert.deepEqual((await post(`${REBOOTABLE}/reboot`, carerToken)).body, { ok: true });
  const OLD_ROW_KEYS = ['id', 'camera_id', 'camera_name', 'type', 'detail', 'created_at'];
  const history = (await call(`${events.url}/api/events`, { token: adminToken })).body.events;
  assert.equal(history.length, 3);
  for (const row of history) for (const k of OLD_ROW_KEYS) assert.ok(Object.hasOwn(row, k), `history row lost ${k}`);
  const bundle = (await call(`${diag.url}/api/diagnostics`, { token: adminToken })).body;
  for (const row of bundle.camera_history) for (const k of OLD_ROW_KEYS) assert.ok(Object.hasOwn(row, k), `bundle row lost ${k}`);
});

// --- C10 --------------------------------------------------------------------------------------------------------

test('★ C10: the diagnostics bundle carries no username and no user id, only "person" or "system"', async () => {
  // HOSTILE FIXTURE, derived from the schema: every camera_events column that is not one of the six the
  // history had before #552 gets a recognisable marker, so a future column carrying identity is planted too
  // and fails this until someone decides it is safe for a public issue. Plus the camera's own tile name.
  const BEFORE_552 = ['id', 'camera_id', 'camera_name', 'type', 'detail', 'created_at'];
  const added = db.prepare('PRAGMA table_info(camera_events)').all().map((c) => c.name).filter((n) => !BEFORE_552.includes(n));
  assert.deepEqual([...added].sort(), ['actor_user_id', 'actor_username'], 'the columns this PR added (a new one must be classified here)');
  const MARK = 'ZZ-IDENTITY-MARKER';
  const values = Object.fromEntries(added.map((c) => [c, `${MARK}-${c}`]));
  db.prepare(`INSERT INTO camera_events (camera_id, camera_name, type, detail, ${added.join(', ')})
              VALUES ('${CAM}', 'Who Cam', 'snooze', 'muted for 15 min', ${added.map((c) => `@${c}`).join(', ')})`).run(values);
  recordCameraEvent(CAM, 'Who Cam', EVENT.OFFLINE, 'stream stopped delivering frames'); // a system row beside it
  db.prepare('UPDATE cameras SET alerts_snoozed_until = ?, alerts_snoozed_by = ? WHERE id = ?')
    .run(Date.now() + 3_600_000, `${MARK}-tile`, CAM);
  // And a real snooze through the route, by a user whose username is itself a marker.
  makeUser(db, { id: `${MARK}-uid`, username: `${MARK}-login`, role: 'caregiver' });
  const token = tokenFor({ id: `${MARK}-uid`, username: `${MARK}-login`, role: 'caregiver' });
  assert.equal((await post(`${REBOOTABLE}/snooze`, token, { minutes: 15 })).status, 200);

  const res = await call(`${diag.url}/api/diagnostics`, { token: adminToken });
  assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 300));
  assert.ok(!JSON.stringify(res.body).includes(MARK), 'a username or user id reached the bundle');
  const actors = res.body.camera_history.map((r) => r.actor).sort();
  assert.deepEqual(actors, ['person', 'person', 'system']);
  for (const row of res.body.camera_history) {
    for (const c of added) assert.ok(!Object.hasOwn(row, c), `bundle row still has ${c}`);
  }
  // The admin's own Camera history DOES name them: the bundle strips, the history does not.
  const history = (await call(`${events.url}/api/events`, { token: adminToken })).body.events;
  assert.ok(history.some((r) => r.actor_username === `${MARK}-login`));
});
