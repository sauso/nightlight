// Writing and reading a child's primary camera through the API (#655): PUT/POST /api/children, the
// `primary_camera` the child responses carry, and the camera routes that clear a stale pointer.
// The role gate (a caregiver may not change it) is in children-role-fields.test.js with the rest of #542's
// gate; the resolver and the scoring it feeds are in primary-camera.test.js.
//
// What each part is shaped against:
//   - Validation runs only when the written value DIFFERS from the stored one. The edit form re-sends the
//     whole record, so validating an echoed value would block every later save of a child whose chosen
//     camera has since been deleted or moved, a plain rename included. Hence the "re-save" tests, each
//     with a stored pointer that would FAIL validation if it were checked.
//   - Every refused request carries a changed name, asserted unchanged: a 400 that wrote the rest first
//     would still answer 400.
//   - `primary_camera` is the RESOLVED camera, not an echo of the column: the tests set the column to a
//     camera that is turned off and expect the fallback back.
//
// Every camera here is DISABLED unless a test needs one enabled for the resolver: a disabled camera skips
// the detector/clip-ring reconcile in the camera routes, so no ffmpeg is spawned from a unit test.
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, makeChild, makeCamera, signToken, mountRouter, call,
} from './helpers/harness.js';

useTempDataDir();

const { default: db } = await import('../src/db.js');
const { default: childrenRouter } = await import('../src/routes/children.js');
const { default: camerasRouter } = await import('../src/routes/cameras.js');
const { default: diagnosticsRouter } = await import('../src/routes/diagnostics.js');
const { computeNight } = await import('../src/lib/sleepAnalysis.js');

const KID = 'kid-pc';
const OTHER = 'kid-other';

let kids;
let cams;
let diag;
let adminToken;

before(async () => {
  kids = await mountRouter('/api/children', childrenRouter);
  cams = await mountRouter('/api/cameras', camerasRouter);
  diag = await mountRouter('/api/diagnostics', diagnosticsRouter);
  const admin = makeUser(db, { id: 'u-a', username: 'admin', role: 'admin' });
  adminToken = signToken({ id: admin.id, username: admin.username, role: 'admin', sid: makeSession(db, admin.id) });
});

after(async () => {
  await kids.close();
  await cams.close();
  await diag.close();
  db.close();
  cleanupTempDataDirs();
});

beforeEach(() => {
  db.prepare('DELETE FROM cameras').run();
  db.prepare('DELETE FROM children').run();
  makeChild(db, { id: KID, name: 'Original' });
  makeChild(db, { id: OTHER, name: 'Sibling' });
  makeCamera(db, { id: 'cam-1', name: 'Cam one', childId: KID, extra: { disabled: 1, sort_order: 0 } });
  makeCamera(db, { id: 'cam-2', name: 'Cam two', childId: KID, extra: { disabled: 1, sort_order: 1 } });
  makeCamera(db, { id: 'cam-theirs', name: 'Their cam', childId: OTHER, extra: { disabled: 1, sort_order: 2 } });
});

const row = (id = KID) => db.prepare('SELECT * FROM children WHERE id = ?').get(id);
const setStored = (camId, id = KID) => db.prepare('UPDATE children SET primary_camera_id = ? WHERE id = ?').run(camId, id);
const enable = (...ids) => ids.forEach((id) => db.prepare('UPDATE cameras SET disabled = 0 WHERE id = ?').run(id));
const put = (body) => call(`${kids.url}/api/children/${KID}`, { method: 'PUT', token: adminToken, body });

describe('PUT /api/children/:id — an admin chooses the primary camera', () => {
  test('★ an admin sets it: stored, and the response names the camera now used', async () => {
    enable('cam-1', 'cam-2');
    const res = await put({ name: 'Renamed', primary_camera_id: 'cam-2' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(row().primary_camera_id, 'cam-2');
    assert.equal(row().name, 'Renamed');
    assert.equal(res.body.primary_camera_id, 'cam-2');
    assert.deepEqual(res.body.primary_camera, { id: 'cam-2', name: 'Cam two' });
  });

  test('a turned-off camera of this child is accepted (the picker lists it); the response shows the fallback', async () => {
    enable('cam-1');
    const res = await put({ primary_camera_id: 'cam-2' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(row().primary_camera_id, 'cam-2');
    assert.deepEqual(res.body.primary_camera, { id: 'cam-1', name: 'Cam one' }, 'resolved, not echoed');
  });

  test('★★ hostile: another child\'s camera is a 400, and nothing in the request is saved', async () => {
    const res = await put({ name: 'Renamed', primary_camera_id: 'cam-theirs' });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.match(res.body.error, /isn't assigned to this child/);
    assert.equal(row().primary_camera_id, null);
    assert.equal(row().name, 'Original');
  });

  test('a camera id that does not exist is a 400', async () => {
    const res = await put({ name: 'Renamed', primary_camera_id: 'cam-ghost' });
    assert.equal(res.status, 400);
    assert.equal(row().name, 'Original');
  });

  for (const value of [42, true, { id: 'cam-1' }, ['cam-1']]) {
    test(`a non-string (${JSON.stringify(value)}) is a 400, not a 500`, async () => {
      const res = await put({ name: 'Renamed', primary_camera_id: value });
      assert.equal(res.status, 400, JSON.stringify(res.body));
      assert.deepEqual(res.body, { error: 'The sleep camera must be a camera id, or empty for automatic' });
      assert.equal(row().name, 'Original');
    });
  }

  for (const value of ['', null]) {
    test(`${JSON.stringify(value)} clears it back to automatic (stored NULL)`, async () => {
      setStored('cam-2');
      const res = await put({ primary_camera_id: value });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(row().primary_camera_id, null);
    });
  }

  test('not sent keeps the stored value (a partial PUT, like the photo write)', async () => {
    setStored('cam-2');
    const res = await put({ name: 'Renamed' });
    assert.equal(res.status, 200);
    assert.equal(row().primary_camera_id, 'cam-2');
  });
});

describe('★★ re-saving a child whose stored primary went stale is never blocked', () => {
  // The edit form re-sends the stored id. Each stored pointer below would FAIL the "assigned to this
  // child" check if the route validated an unchanged value.
  test('the stored primary was deleted', async () => {
    setStored('cam-2');
    db.prepare("DELETE FROM cameras WHERE id = 'cam-2'").run();
    const res = await put({ name: 'Renamed', primary_camera_id: 'cam-2' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(row().name, 'Renamed');
    assert.equal(row().primary_camera_id, 'cam-2', 'kept as stored: the resolver falls back on its own');
  });

  test('the stored primary was moved to another child behind the routes\' back', async () => {
    setStored('cam-2');
    db.prepare("UPDATE cameras SET child_id = ? WHERE id = 'cam-2'").run(OTHER);
    const res = await put({ name: 'Renamed', primary_camera_id: 'cam-2' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(row().name, 'Renamed');
  });

  test('but CHANGING to a stale camera is still refused', async () => {
    // The control: without it, "never validate" would pass the two tests above.
    setStored('cam-1');
    db.prepare("DELETE FROM cameras WHERE id = 'cam-2'").run();
    const res = await put({ name: 'Renamed', primary_camera_id: 'cam-2' });
    assert.equal(res.status, 400);
    assert.equal(row().primary_camera_id, 'cam-1');
  });
});

describe('POST /api/children — a new child has no cameras, so only automatic', () => {
  const post = (body) => call(`${kids.url}/api/children`, { method: 'POST', token: adminToken, body });

  test('a camera id is a 400 and no child is created', async () => {
    const count = () => db.prepare('SELECT COUNT(*) AS c FROM children').get().c;
    const before = count();
    const res = await post({ name: 'New child', primary_camera_id: 'cam-1' });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.match(res.body.error, /no cameras yet/);
    assert.equal(count(), before);
  });

  // `false` and `0` matter most: they are falsy, so only the type check stands between them and a 201
  // that reads them as "automatic". A truthy non-string (7) is also caught by the camera-id refusal,
  // which is why the message is asserted, not only the status.
  for (const value of [7, false, 0]) {
    test(`a non-string (${JSON.stringify(value)}) is a 400 saying so, and no child is created`, async () => {
      const count = () => db.prepare('SELECT COUNT(*) AS c FROM children').get().c;
      const before = count();
      const res = await post({ name: 'New child', primary_camera_id: value });
      assert.equal(res.status, 400, JSON.stringify(res.body));
      assert.deepEqual(res.body, { error: 'The sleep camera must be a camera id, or empty for automatic' });
      assert.equal(count(), before);
    });
  }

  for (const value of ['', null, undefined]) {
    test(`${JSON.stringify(value)} creates the child with no primary`, async () => {
      const res = await post({ name: 'New child', primary_camera_id: value });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(row(res.body.id).primary_camera_id, null);
      assert.equal(res.body.primary_camera, null, 'no camera yet, so nothing is measured');
    });
  }
});

describe('GET /api/children — `primary_camera` is the camera the night is measured from now', () => {
  const get = async () => (await call(`${kids.url}/api/children`, { token: adminToken })).body.find((k) => k.id === KID);

  test('NULL primary: the first enabled camera in sort_order', async () => {
    enable('cam-1', 'cam-2');
    const kid = await get();
    assert.equal(kid.primary_camera_id, null);
    assert.deepEqual(kid.primary_camera, { id: 'cam-1', name: 'Cam one' });
  });

  test('a chosen camera', async () => {
    enable('cam-1', 'cam-2');
    setStored('cam-2');
    assert.deepEqual((await get()).primary_camera, { id: 'cam-2', name: 'Cam two' });
  });

  test('no enabled camera: null', async () => {
    assert.equal((await get()).primary_camera, null);
  });

  test('★ a sort_order tie: names the camera SCORING would use (tie broken by id, not insert order)', async () => {
    // Inserted z first, so rowid order (z, a) disagrees with id order (a, z). Both sort ahead of the
    // fixture's cameras. The answer is checked against computeNight itself, not against a constant, so
    // the response and the score cannot drift apart.
    makeCamera(db, { id: 'cam-z', name: 'Zed', childId: KID, extra: { sort_order: -1 } });
    makeCamera(db, { id: 'cam-a', name: 'Ay', childId: KID, extra: { sort_order: -1 } });
    const scoredFrom = computeNight(KID, '2026-07-01').analysis_camera_id;
    assert.equal(scoredFrom, 'cam-a');
    assert.deepEqual((await get()).primary_camera, { id: 'cam-a', name: 'Ay' });
  });

  test('every key a client already reads is still there (the shape is only ADDED to)', async () => {
    const kid = await get();
    for (const k of ['id', 'name', 'birthday', 'color', 'photo', 'track_sleep', 'sleep_window_start',
      'sleep_window_end', 'created_at', 'cameras']) {
      assert.ok(k in kid, `${k} missing from GET /api/children`);
    }
    assert.deepEqual(Object.keys(kid.cameras[0]).sort(), ['id', 'mediamtx_path', 'name']);
  });
});

describe('a camera that leaves the child stops being its primary (camera routes)', () => {
  const assign = (camId, child_id) => call(`${cams.url}/api/cameras/${camId}/assign`, { method: 'PUT', token: adminToken, body: { child_id } });
  const editCam = (camId, body) => call(`${cams.url}/api/cameras/${camId}`, { method: 'PUT', token: adminToken, body });

  test('★ /assign to another child clears the old child\'s pointer', async () => {
    setStored('cam-2');
    const res = await assign('cam-2', OTHER);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(row().primary_camera_id, null);
  });

  test('/assign to nobody (unassign) clears it', async () => {
    setStored('cam-2');
    assert.equal((await assign('cam-2', null)).status, 200);
    assert.equal(row().primary_camera_id, null);
  });

  test('★ /assign to the SAME child keeps it (only a camera that leaves clears it)', async () => {
    setStored('cam-2');
    assert.equal((await assign('cam-2', KID)).status, 200);
    assert.equal(row().primary_camera_id, 'cam-2');
  });

  test('★ PUT /cameras/:id moving it to another child clears the pointer', async () => {
    setStored('cam-2');
    const res = await editCam('cam-2', { child_id: OTHER });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(row().primary_camera_id, null);
  });

  test('★ PUT /cameras/:id renaming it keeps the owner\'s pointer', async () => {
    setStored('cam-2');
    assert.equal((await editCam('cam-2', { name: 'Renamed cam' })).status, 200);
    assert.equal(row().primary_camera_id, 'cam-2');
  });

  test('a camera move never touches a pointer to a DIFFERENT camera', async () => {
    setStored('cam-1');
    assert.equal((await assign('cam-2', OTHER)).status, 200);
    assert.equal(row().primary_camera_id, 'cam-1');
  });
});

describe('deleting a child: its cameras are unassigned, and no other child keeps naming one', () => {
  const del = () => call(`${kids.url}/api/children/${KID}`, { method: 'DELETE', token: adminToken });
  const assign = (camId, child_id) => call(`${cams.url}/api/cameras/${camId}/assign`, { method: 'PUT', token: adminToken, body: { child_id } });

  test('★★ hostile: another child\'s stale pointer to a deleted child\'s camera does not revive on reassignment', async () => {
    // Written straight to the DB: OTHER names KID's camera, which no route would allow. Without the cleanup
    // in DELETE, the camera is unassigned with the pointer left in place, and assigning it to OTHER later
    // keeps the pointer (the camera routes keep the OWNER's choice), silently making it OTHER's primary.
    setStored('cam-1', OTHER);
    assert.equal((await del()).status, 204);
    assert.equal(row(OTHER).primary_camera_id, null, 'the stale pointer survived the delete');
    assert.equal((await assign('cam-1', OTHER)).status, 200);
    assert.equal(row(OTHER).primary_camera_id, null, 'the stale choice revived');
  });

  test('the control: another child\'s choice of its OWN camera is untouched', async () => {
    setStored('cam-theirs', OTHER);
    assert.equal((await del()).status, 204);
    assert.equal(row(OTHER).primary_camera_id, 'cam-theirs');
  });
});

test('the support bundle carries each child\'s primary_camera_id (NULL = automatic is an answer too)', async () => {
  setStored('cam-2');
  const res = await call(`${diag.url}/api/diagnostics`, { token: adminToken });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const byId = Object.fromEntries(res.body.children.map((c) => [c.id, c]));
  assert.equal(byId[KID].primary_camera_id, 'cam-2');
  assert.ok('primary_camera_id' in byId[OTHER], 'a NULL must be present as null, not missing');
  assert.equal(byId[OTHER].primary_camera_id, null);
});
