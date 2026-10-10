// Which parts of a child a caregiver may change (#542; owner decision 2026-10-10: a caregiver can watch
// and act in the moment, but cannot destroy or reconfigure).
//
// ★ WHY THIS FILE EXISTS. PUT /api/children/:id serves both roles from ONE request: name, birthday,
// colour and photo stay open to a caregiver, while `track_sleep` and the bedtime window are admin-only.
// So the gate cannot be a requireAdmin in front of the route (route-permissions.test.js pins the route as
// SIGNED_IN and lists this file in its header); it is a comparison inside the handler, and only these
// tests see it.
//
// What each part pins, and the mistake it is shaped against:
//   - EVERY refused request also carries a changed name, and the name is asserted unchanged. A gate placed
//     after the UPDATE (or one that drops the refused fields and saves the rest) still answers 403, so a
//     test that only read the status would pass against it.
//   - The SPA's edit form re-sends the WHOLE form (`track_sleep: true` against a stored 1). A gate that
//     tests for PRESENCE, or compares the raw input, refuses every rename from an open caregiver page.
//   - Truthy junk. `"0"`, `[]` and `" "` are written as 1 (`track_sleep ? 1 : 0`), so a gate that compares
//     with `!=` or `Number()` reads them as 0 and lets a caregiver turn tracking ON for a child that has it
//     off. Hence the stored-0 AND stored-1 fixtures: each direction has its own way to slip past.
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, makeChild, signToken, mountRouter, call,
} from './helpers/harness.js';

useTempDataDir();

const { default: db } = await import('../src/db.js');
const { default: childrenRouter } = await import('../src/routes/children.js');

const KID = 'kid-role';
const STORED = { name: 'Original Name', start: '19:30', end: '06:45' };
const REFUSED = 'Only an admin can turn sleep tracking on or off or change the sleep window. Your other changes were not saved.';

let server;
let adminToken;
let caregiverToken;

before(async () => {
  server = await mountRouter('/api/children', childrenRouter);
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

// A child with NO camera, so a write that does reach reconcileChildLegs has nothing to start or stop (no
// ffmpeg is spawned from a unit test).
function seed(track) {
  db.prepare('DELETE FROM cameras').run();
  db.prepare('DELETE FROM children').run();
  makeChild(db, { id: KID, name: STORED.name, track, start: STORED.start, end: STORED.end });
}
const row = () => db.prepare('SELECT * FROM children WHERE id = ?').get(KID);
const put = (body, token = caregiverToken) => call(`${server.url}/api/children/${KID}`, { method: 'PUT', token, body });

function assertRefused(res, fields, label) {
  assert.equal(res.status, 403, `${label}: expected 403, got ${res.status} ${JSON.stringify(res.body)}`);
  assert.deepEqual(res.body, { error: REFUSED, reason: 'admin_only_fields', fields }, label);
}
// Nothing in a refused request is written, the sleep settings included.
function assertUntouched(track, label) {
  const r = row();
  assert.equal(r.name, STORED.name, `${label}: the name in a refused request was saved`);
  assert.equal(r.track_sleep, track, `${label}: track_sleep changed`);
  assert.equal(r.sleep_window_start, STORED.start, `${label}: bedtime changed`);
  assert.equal(r.sleep_window_end, STORED.end, `${label}: wake time changed`);
}

describe('a caregiver cannot change sleep tracking or the window, and nothing else in that request is saved', () => {
  beforeEach(() => seed(1));

  test('turning tracking off (1 -> 0)', async () => {
    const res = await put({ name: 'Renamed', track_sleep: false });
    assertRefused(res, ['track_sleep'], 'tracking off');
    assertUntouched(1, 'tracking off');
  });

  test('only the bedtime', async () => {
    const res = await put({ name: 'Renamed', sleep_window_start: '20:00' });
    assertRefused(res, ['sleep_window_start'], 'bedtime');
    assertUntouched(1, 'bedtime');
  });

  test('only the wake time', async () => {
    const res = await put({ name: 'Renamed', sleep_window_end: '07:15' });
    assertRefused(res, ['sleep_window_end'], 'wake time');
    assertUntouched(1, 'wake time');
  });

  test('all three at once names all three, in a fixed order', async () => {
    const res = await put({ name: 'Renamed', track_sleep: 0, sleep_window_start: '20:00', sleep_window_end: '07:15' });
    assertRefused(res, ['track_sleep', 'sleep_window_start', 'sleep_window_end'], 'all three');
    assertUntouched(1, 'all three');
  });
});

describe('what a caregiver can still change', () => {
  beforeEach(() => seed(1));

  test('★ re-sending the stored sleep values, as an open edit form does, saves the rest', async () => {
    // The exact shape pages/ChildSettings.jsx has always sent: the whole form, booleans and all.
    const photo = 'data:image/png;base64,AAAA';
    const res = await put({
      name: 'Renamed', birthday: '2024-01-02', color: '#8A9FE0', photo,
      track_sleep: true, sleep_window_start: STORED.start, sleep_window_end: STORED.end,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const r = row();
    assert.equal(r.name, 'Renamed');
    assert.equal(r.birthday, '2024-01-02');
    assert.equal(r.color, '#8A9FE0');
    assert.equal(r.photo, photo);
    assert.equal(r.track_sleep, 1);
    assert.equal(r.sleep_window_start, STORED.start);
    assert.equal(r.sleep_window_end, STORED.end);
  });

  test('a request that omits the sleep fields saves', async () => {
    const res = await put({ name: 'Renamed', color: '#7c83db' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(row().name, 'Renamed');
    assert.equal(row().color, '#7c83db');
  });
});

describe('★ no type coercion turns tracking on or off for a caregiver', () => {
  // Each value is sent with a changed name. The UPDATE writes `track_sleep ? 1 : 0`, so the question for
  // every value is "would this have been written as the OTHER state?", and every one of these would.
  describe('stored 0 (tracking off): values that are written as 1', () => {
    beforeEach(() => seed(0));
    for (const value of [true, '0', [], ' ']) {
      test(`${JSON.stringify(value)} is refused and the child stays untracked`, async () => {
        const res = await put({ name: 'Renamed', track_sleep: value });
        assertRefused(res, ['track_sleep'], JSON.stringify(value));
        assertUntouched(0, JSON.stringify(value));
      });
    }
  });

  describe('stored 1 (tracking on): values that are written as 0', () => {
    beforeEach(() => seed(1));
    for (const value of [false, 0, '', null]) {
      test(`${JSON.stringify(value)} is refused and the child stays tracked`, async () => {
        const res = await put({ name: 'Renamed', track_sleep: value });
        assertRefused(res, ['track_sleep'], JSON.stringify(value));
        assertUntouched(1, JSON.stringify(value));
      });
    }
  });

  test('the control: a value that is written as the stored state passes (stored 0, sent false)', async () => {
    // Without this, "refuse every track_sleep a caregiver sends" would pass the two blocks above.
    seed(0);
    const res = await put({ name: 'Renamed', track_sleep: false });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(row().name, 'Renamed');
    assert.equal(row().track_sleep, 0);
  });
});

describe('an admin and the other roles', () => {
  beforeEach(() => seed(1));

  test('an admin changes all three, and the name with them', async () => {
    const res = await put({ name: 'Renamed', track_sleep: false, sleep_window_start: '20:00', sleep_window_end: '07:15' }, adminToken);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const r = row();
    assert.equal(r.name, 'Renamed');
    assert.equal(r.track_sleep, 0);
    assert.equal(r.sleep_window_start, '20:00');
    assert.equal(r.sleep_window_end, '07:15');
  });

  test('anonymous gets 401 and nothing is written', async () => {
    const res = await put({ name: 'Renamed', track_sleep: false }, null); // null, not undefined: undefined takes the default token
    assert.equal(res.status, 401);
    assertUntouched(1, 'anonymous');
  });
});

describe('POST /api/children is admin-only (#542)', () => {
  beforeEach(() => seed(1));
  const count = () => db.prepare('SELECT COUNT(*) AS c FROM children').get().c;

  test('a caregiver gets 403 and no child is created', async () => {
    const before = count();
    const res = await call(`${server.url}/api/children`, { method: 'POST', token: caregiverToken, body: { name: 'New child' } });
    assert.equal(res.status, 403);
    assert.deepEqual(res.body, { error: 'Admin access required' });
    assert.equal(count(), before, 'the child was created anyway');
  });

  test('an admin creates one', async () => {
    const before = count();
    const res = await call(`${server.url}/api/children`, { method: 'POST', token: adminToken, body: { name: 'New child' } });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(count(), before + 1);
    assert.equal(res.body.name, 'New child');
  });
});
