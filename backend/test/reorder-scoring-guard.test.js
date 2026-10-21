// PUT /api/cameras/reorder for a caregiver (#675, owner 2026-10-20, "option A"): any signed-in user may
// rearrange the live grid again, and a NON-admin's reorder is refused (409, nothing written) only when it would
// change which camera a TRACKED child is measured from.
//
// WHY THIS IS A RISK AT ALL. `sort_order` is not only layout: for a child with no main camera chosen (the
// default, and every child set up before #655), or whose chosen one is turned off, the first ENABLED camera in
// it is the one the child's sleep is scored from (tie-break 'id') and the nightly timelapse is built from
// (tie-break 'rowid'), both through lib/primaryCamera.js. #552 closed the route to caregivers for that reason;
// #675 reopens it with a guard that asks the REAL resolver, before and after the writes, inside one transaction.
//
// How each test is shaped against a plausible wrong implementation:
//   - Every refusal asserts EVERY sort_order unchanged, and the refused orders move a harmless camera FIRST, so a
//     guard that refused after writing part of the list (or outside the transaction) fails.
//   - The tie tests come as a PAIR (only the 'rowid' pick moves; only the 'id' pick moves), so a guard comparing
//     only one tie-break fails one of them. Each states its premise with the resolver itself.
//   - The main-camera test uses a reorder that WOULD be refused without the main camera, and shows that it is
//     once the choice is cleared, so its 200 cannot pass trivially.
//   - The two-children test puts the affected child SECOND (by id and by insertion), so a guard that looked
//     only at the first child, or stopped at the first match, fails.
//   - The admin test repeats the exact refused reorder: an admin is not checked.
//
// Every camera here is a plain row: the reorder route touches no stream, so enabled cameras spawn nothing.
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, makeChild, makeCamera, signToken, mountRouter, call,
} from './helpers/harness.js';

useTempDataDir();

const { default: db } = await import('../src/db.js');
const { default: camerasRouter } = await import('../src/routes/cameras.js');
const { primaryCameraRowFor } = await import('../src/lib/primaryCamera.js');
const { logger } = await import('../src/lib/logger.js');

const REASON = 'would_change_sleep_camera';

let server;
let adminToken;
let caregiverToken;

before(async () => {
  server = await mountRouter('/api/cameras', camerasRouter);
  const admin = makeUser(db, { id: 'u-a', username: 'admin', role: 'admin' });
  const carer = makeUser(db, { id: 'u-c', username: 'carer', role: 'caregiver' });
  adminToken = signToken({ id: admin.id, username: admin.username, role: 'admin', sid: makeSession(db, admin.id) });
  caregiverToken = signToken({ id: carer.id, username: carer.username, role: 'caregiver', sid: makeSession(db, carer.id) });
});

after(async () => {
  await server.close();
  db.close();
  cleanupTempDataDirs();
});

beforeEach(() => {
  db.prepare('DROP TRIGGER IF EXISTS reorder_test_boom').run();
  db.prepare('DELETE FROM cameras').run();
  db.prepare('DELETE FROM children').run();
});

// A camera row: `child` its owner (null = unassigned), `sort` its sort_order, `off` = turned off.
const cam = (id, { child = null, sort, off = false } = {}) =>
  makeCamera(db, { id, childId: child, extra: { sort_order: sort, disabled: off ? 1 : 0 } });
const child = (id, name, { track = 1 } = {}) => makeChild(db, { id, name, track });
const choosePrimary = (childId, camId) =>
  db.prepare('UPDATE children SET primary_camera_id = ? WHERE id = ?').run(camId, childId);
const sortOrders = () =>
  Object.fromEntries(db.prepare('SELECT id, sort_order FROM cameras ORDER BY id').all().map((r) => [r.id, r.sort_order]));
const reorder = (ids, token = caregiverToken) =>
  call(`${server.url}/api/cameras/reorder`, { method: 'PUT', token, body: { order: ids } });
const picks = (childId) => ({
  byId: primaryCameraRowFor(childId, { tieBreak: 'id' })?.id ?? null,
  byRowid: primaryCameraRowFor(childId, { tieBreak: 'rowid' })?.id ?? null,
});

// The refusal, asserted whole: the status, the additive JSON, and that nothing at all was written.
function assertRefused(res, beforeOrders, children) {
  assert.equal(res.status, 409, `expected a refusal, got ${res.status} ${JSON.stringify(res.body)}`);
  assert.equal(res.body.reason, REASON);
  assert.deepEqual(res.body.children, children);
  assert.deepEqual(sortOrders(), beforeOrders, 'a refused reorder wrote some of its order');
}

describe('★★ a caregiver may not move the camera a tracked child is measured from (#675)', () => {
  test('★★ making the second camera of an Automatic child first: 409, the child named, and NOTHING written', async () => {
    child('c-a', 'Child A');
    cam('cam-1', { child: 'c-a', sort: 0 });
    cam('cam-2', { child: 'c-a', sort: 1 });
    cam('cam-u', { sort: 2 }); // unassigned; listed FIRST below, so its write happens before the one that moves
    const beforeOrders = sortOrders();
    const res = await reorder(['cam-u', 'cam-2', 'cam-1']);
    assertRefused(res, beforeOrders, [{ id: 'c-a', name: 'Child A' }]);
    // The words a person reads: who is affected, what it would change, and the way out (an admin choosing a main
    // camera, revision 3). Tokens, not the exact sentence.
    assert.match(res.body.error, /Child A/);
    assert.match(res.body.error, /sleep tracking and the nightly timelapse/);
    assert.match(res.body.error, /An admin can choose a main camera that is turned on for Child A in their settings, after which tiles can be rearranged freely\.$/);
    assert.deepEqual(picks('c-a'), { byId: 'cam-1', byRowid: 'cam-1' }, 'the sleep camera moved anyway');
  });

  test('moving a camera that is NOT first, for a three-camera Automatic child: 200 and stored', async () => {
    child('c-a', 'Child A');
    cam('cam-1', { child: 'c-a', sort: 0 });
    cam('cam-2', { child: 'c-a', sort: 1 });
    cam('cam-3', { child: 'c-a', sort: 2 });
    const res = await reorder(['cam-1', 'cam-3', 'cam-2']);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body, { ok: true });
    assert.deepEqual(sortOrders(), { 'cam-1': 0, 'cam-2': 2, 'cam-3': 1 });
  });

  test('★ a child with a main camera chosen: a reorder that WOULD move the Automatic pick is accepted, and refused once the choice is cleared', async () => {
    child('c-a', 'Child A');
    cam('cam-1', { child: 'c-a', sort: 0 });
    cam('cam-2', { child: 'c-a', sort: 1 });
    cam('cam-3', { child: 'c-a', sort: 2 });
    choosePrimary('c-a', 'cam-2');
    // cam-3 first: under Automatic that moves the pick from cam-1 to cam-3. With cam-2 chosen nothing moves.
    const res = await reorder(['cam-3', 'cam-1', 'cam-2']);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(sortOrders(), { 'cam-1': 1, 'cam-2': 2, 'cam-3': 0 });
    // The same kind of move with the choice cleared (back to Automatic) is refused: the 200 above was the main
    // camera's doing, not a guard that never fires.
    choosePrimary('c-a', null);
    const beforeOrders = sortOrders();
    assertRefused(await reorder(['cam-1', 'cam-3', 'cam-2']), beforeOrders, [{ id: 'c-a', name: 'Child A' }]);
  });

  test('a child whose chosen main camera is turned off falls back to Automatic, so swapping its first camera is refused', async () => {
    child('c-a', 'Child A');
    cam('cam-1', { child: 'c-a', sort: 0 });
    cam('cam-2', { child: 'c-a', sort: 1 });
    cam('cam-3', { child: 'c-a', sort: 2, off: true });
    choosePrimary('c-a', 'cam-3');
    const beforeOrders = sortOrders();
    assertRefused(await reorder(['cam-2', 'cam-1', 'cam-3']), beforeOrders, [{ id: 'c-a', name: 'Child A' }]);
  });

  test('a partial order that moves the first camera is refused; one that does not is stored', async () => {
    // Cameras left out of `order` keep their sort_order (unchanged since #552). cam-2 alone at index 0 jumps
    // ahead of cam-1 (3); cam-u and cam-1 at 0 and 1 leave cam-1 ahead of cam-2 (4).
    child('c-a', 'Child A');
    cam('cam-1', { child: 'c-a', sort: 3 });
    cam('cam-2', { child: 'c-a', sort: 4 });
    cam('cam-u', { sort: 5 });
    const beforeOrders = sortOrders();
    assertRefused(await reorder(['cam-2']), beforeOrders, [{ id: 'c-a', name: 'Child A' }]);
    const res = await reorder(['cam-u', 'cam-1']);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(sortOrders(), { 'cam-1': 1, 'cam-2': 4, 'cam-u': 0 });
  });
});

describe('★★ a sort_order tie: BOTH tie-breaks are protected (#675)', () => {
  // cam-z is inserted FIRST, so rowid order is (z, a) while id order is (a, z): scoring ('id') picks cam-a and
  // the timelapse ('rowid') picks cam-z. A reorder that settles the tie can move one pick and not the other.
  function tie() {
    child('c-a', 'Child A');
    cam('cam-z', { child: 'c-a', sort: 0 });
    cam('cam-a', { child: 'c-a', sort: 0 });
    assert.deepEqual(picks('c-a'), { byId: 'cam-a', byRowid: 'cam-z' }, 'fixture premise: the two picks differ');
  }

  test('★★ a reorder that moves ONLY the timelapse pick (rowid) is refused', async () => {
    tie();
    const beforeOrders = sortOrders();
    assertRefused(await reorder(['cam-a', 'cam-z']), beforeOrders, [{ id: 'c-a', name: 'Child A' }]);
    // Premise of the refusal, shown by doing the same move as an admin (who is not checked): only rowid moved.
    assert.equal((await reorder(['cam-a', 'cam-z'], adminToken)).status, 200);
    assert.deepEqual(picks('c-a'), { byId: 'cam-a', byRowid: 'cam-a' });
  });

  test('★★ a reorder that moves ONLY the scoring pick (id) is refused', async () => {
    tie();
    const beforeOrders = sortOrders();
    assertRefused(await reorder(['cam-z', 'cam-a']), beforeOrders, [{ id: 'c-a', name: 'Child A' }]);
    assert.equal((await reorder(['cam-z', 'cam-a'], adminToken)).status, 200);
    assert.deepEqual(picks('c-a'), { byId: 'cam-z', byRowid: 'cam-z' });
  });
});

describe('★ what a caregiver may move freely (#675)', () => {
  test('a single-camera child, unassigned cameras and a child with only turned-off cameras: 200 and stored', async () => {
    child('c-a', 'Child A');
    child('c-b', 'Child B');
    cam('cam-1', { child: 'c-a', sort: 0 }); // c-a's only camera: wherever it goes, it is still the one
    cam('cam-u1', { sort: 1 });
    cam('cam-u2', { sort: 2 });
    cam('cam-d1', { child: 'c-b', sort: 3, off: true }); // c-b has no enabled camera before or after
    cam('cam-d2', { child: 'c-b', sort: 4, off: true });
    const res = await reorder(['cam-u2', 'cam-d2', 'cam-u1', 'cam-d1', 'cam-1']);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(sortOrders(), { 'cam-1': 4, 'cam-d1': 3, 'cam-d2': 1, 'cam-u1': 2, 'cam-u2': 0 });
  });

  test('a turned-off camera of an Automatic child moved in front of its first enabled one: 200 (the resolver skips it)', async () => {
    child('c-a', 'Child A');
    cam('cam-1', { child: 'c-a', sort: 0 });
    cam('cam-2', { child: 'c-a', sort: 1 });
    cam('cam-x', { child: 'c-a', sort: 2, off: true });
    const res = await reorder(['cam-x', 'cam-1', 'cam-2']);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(sortOrders(), { 'cam-1': 1, 'cam-2': 2, 'cam-x': 0 });
  });

  test('★ a child with sleep tracking OFF is not guarded: swapping its first camera is stored', async () => {
    // Scoring answers `off` for it and the timelapse skips it, so the swap changes nothing anyone sees.
    child('c-a', 'Child A', { track: 0 });
    cam('cam-1', { child: 'c-a', sort: 0 });
    cam('cam-2', { child: 'c-a', sort: 1 });
    const res = await reorder(['cam-2', 'cam-1']);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(sortOrders(), { 'cam-1': 1, 'cam-2': 0 });
  });
});

describe('★ two children: one refusal for the whole order (#675)', () => {
  // c-a is inserted first and sorts first by id; c-b is SECOND both ways.
  function twoChildren() {
    child('c-a', 'Child A');
    child('c-b', 'Child B');
    cam('cam-a1', { child: 'c-a', sort: 0 });
    cam('cam-a2', { child: 'c-a', sort: 1 });
    cam('cam-b1', { child: 'c-b', sort: 2 });
    cam('cam-b2', { child: 'c-b', sort: 3 });
  }

  test('★ safe for the first child, unsafe for the second: refused whole, naming only the second', async () => {
    twoChildren();
    const beforeOrders = sortOrders();
    const res = await reorder(['cam-a1', 'cam-a2', 'cam-b2', 'cam-b1']);
    assertRefused(res, beforeOrders, [{ id: 'c-b', name: 'Child B' }]);
    assert.match(res.body.error, /Child B/);
    assert.doesNotMatch(res.body.error, /Child A/);
  });

  test('both children moved: both are named', async () => {
    twoChildren();
    const beforeOrders = sortOrders();
    const res = await reorder(['cam-a2', 'cam-a1', 'cam-b2', 'cam-b1']);
    assertRefused(res, beforeOrders, [{ id: 'c-a', name: 'Child A' }, { id: 'c-b', name: 'Child B' }]);
    assert.match(res.body.error, /Child A and Child B/);
  });
});

describe('an admin, and the input rules (#675)', () => {
  test('★★ an admin doing the SAME reorder a caregiver is refused: 200 and stored (admins are not checked)', async () => {
    child('c-a', 'Child A');
    cam('cam-1', { child: 'c-a', sort: 0 });
    cam('cam-2', { child: 'c-a', sort: 1 });
    cam('cam-u', { sort: 2 });
    const res = await reorder(['cam-u', 'cam-2', 'cam-1'], adminToken);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(sortOrders(), { 'cam-1': 2, 'cam-2': 1, 'cam-u': 0 });
  });

  test('a malformed body is still 400 for everyone, and no session is still 401', async () => {
    cam('cam-1', { sort: 0 });
    for (const token of [caregiverToken, adminToken]) {
      for (const body of [{ order: 'cam-1' }, { order: [1] }, {}]) {
        const res = await call(`${server.url}/api/cameras/reorder`, { method: 'PUT', token, body });
        assert.equal(res.status, 400, JSON.stringify(body));
        assert.deepEqual(res.body, { error: 'order must be an array of camera ids' });
      }
    }
    assert.equal((await reorder(['cam-1'], null)).status, 401);
  });

  test('an order longer than the number of cameras is 400 for everyone, and nothing is written', async () => {
    // Abuse-only input (the UI sends each camera once): bounded so one request cannot run unbounded UPDATEs.
    cam('cam-1', { sort: 0 });
    cam('cam-2', { sort: 1 });
    const beforeOrders = sortOrders();
    for (const token of [caregiverToken, adminToken]) {
      const res = await reorder(['cam-2', 'cam-1', 'cam-2'], token);
      assert.equal(res.status, 400);
      assert.match(res.body.error, /more cameras than there are/);
      assert.deepEqual(sortOrders(), beforeOrders);
    }
  });

  test('★ only the refusal is a 409: any other error inside the transaction stays a 500 and writes nothing', async () => {
    // A trigger that aborts the first sort_order write: a SqliteError, not the refusal, so a catch that turned
    // every error into the friendly 409 would answer 409 here and tell a person to fix a server fault.
    child('c-a', 'Child A');
    cam('cam-1', { child: 'c-a', sort: 0 });
    cam('cam-2', { child: 'c-a', sort: 1 });
    const beforeOrders = sortOrders();
    db.prepare(`CREATE TRIGGER reorder_test_boom BEFORE UPDATE OF sort_order ON cameras
                BEGIN SELECT RAISE(ABORT, 'boom'); END`).run();
    const res = await reorder(['cam-1', 'cam-2']);
    assert.equal(res.status, 500);
    assert.equal(res.body.reason, undefined);
    assert.deepEqual(sortOrders(), beforeOrders);
  });

  test('one log line per caregiver reorder (user id and outcome, never a child\'s name); none for an admin', async (t) => {
    // A snooze records who did it; a reorder recorded nothing (revision 5). Server logs go into the support
    // bundle, so the line carries ids, not the child's name.
    const lines = [];
    t.mock.method(logger, 'info', (...a) => { const l = a.join(' '); if (l.includes('[reorder]')) lines.push(l); });
    child('c-a', 'Child A');
    cam('cam-1', { child: 'c-a', sort: 0 });
    cam('cam-2', { child: 'c-a', sort: 1 });
    cam('cam-3', { child: 'c-a', sort: 2 });

    assert.equal((await reorder(['cam-2', 'cam-1', 'cam-3'])).status, 409);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /u-c/);
    assert.match(lines[0], /refused/);
    assert.match(lines[0], /c-a/);
    assert.doesNotMatch(lines[0], /Child A/);

    assert.equal((await reorder(['cam-1', 'cam-3', 'cam-2'])).status, 200);
    assert.equal(lines.length, 2);
    assert.match(lines[1], /u-c/);
    assert.match(lines[1], /accepted/);

    assert.equal((await reorder(['cam-2', 'cam-1', 'cam-3'], adminToken)).status, 200);
    assert.equal(lines.length, 2, 'an admin reorder was logged');
  });
});
