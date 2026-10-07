// A child's name that is not text must be a 400, not a 500 (issue #541).
//
// The defect: `POST /api/children` and `PUT /api/children/:id` called `name.trim()` on whatever the JSON body
// carried. A number, an object or an array threw a TypeError and Express answered 500. Cloudflare strips 5xx
// bodies (see the route comment), so a client saw an empty failure instead of a readable message.
//
// ⚠️ THE ROUTER IS REAL AND SO IS THE DATABASE. The assertions that matter are two: the status is 400 with a
// readable `error`, AND nothing was written. A 400 that still inserted the row would look right from the
// response alone.
//
// ⚠️ THE OLD BEHAVIOURS ARE PINNED TOO. A partial PUT that omits `name` keeps the stored one (the child
// screen relies on it, see children-route.test.js), and `null`/blank have always meant "keep" on PUT and
// "required" on POST. A validation that rejected those would break the photo-only write from the child screen.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, makeChild, signToken, mountRouter, call,
} from './helpers/harness.js';

useTempDataDir();

const { default: db } = await import('../src/db.js');
const { default: childrenRouter } = await import('../src/routes/children.js');

let server;
let token;
const KID = 'kid-name';

const post = (body) => call(`${server.url}/api/children`, { method: 'POST', token, body });
const put = (body) => call(`${server.url}/api/children/${KID}`, { method: 'PUT', token, body });
const names = () => db.prepare('SELECT name FROM children ORDER BY name').all().map((r) => r.name);

before(async () => {
  server = await mountRouter('/api/children', childrenRouter);
  const admin = makeUser(db, { id: 'u-a', username: 'admin', role: 'admin' });
  token = signToken({ sub: admin.id, role: 'admin', sid: makeSession(db, admin.id) });
});

after(async () => {
  await server.close();
  cleanupTempDataDirs();
});

beforeEach(() => {
  db.prepare('DELETE FROM children').run();
  makeChild(db, { id: KID, name: 'Original' });
});

// Truthy non-strings are what used to crash. `0` and `false` were already a 400 ("required").
const NOT_TEXT = [[123, '123'], [{ a: 1 }, 'an object'], [['x'], 'an array'], [true, 'true'], [[], 'an empty array']];

for (const [value, label] of NOT_TEXT) {
  test(`POST with name ${label} is a 400 and nothing is created`, async () => {
    const res = await post({ name: value });
    assert.equal(res.status, 400, `expected 400, got ${res.status}`);
    assert.equal(res.body.error, 'Name must be text');
    assert.deepEqual(names(), ['Original'], 'a rejected create must not insert a row');
  });

  test(`PUT with name ${label} is a 400 and the child is untouched`, async () => {
    const res = await put({ name: value, color: '#112233' });
    assert.equal(res.status, 400, `expected 400, got ${res.status}`);
    assert.equal(res.body.error, 'Name must be text');
    const r = db.prepare('SELECT name, color FROM children WHERE id = ?').get(KID);
    assert.equal(r.name, 'Original');
    assert.notEqual(r.color, '#112233', 'a rejected edit must not apply the other fields either');
  });
}

test('POST with a missing, null, empty or blank name is still "Name is required"', async () => {
  for (const body of [{}, { name: null }, { name: '' }, { name: '   ' }]) {
    const res = await post(body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(res.body.error, 'Name is required', JSON.stringify(body));
  }
  assert.deepEqual(names(), ['Original']);
});

test('PUT that omits the name, or sends null, empty or blank, keeps the stored name', async () => {
  for (const body of [{ color: '#111111' }, { name: null }, { name: '' }, { name: '   ' }]) {
    const res = await put(body);
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(db.prepare('SELECT name FROM children WHERE id = ?').get(KID).name, 'Original', JSON.stringify(body));
  }
});

test('a valid name is still trimmed and saved on both routes', async () => {
  const created = await post({ name: '  Child C  ' });
  assert.equal(created.status, 201);
  assert.equal(created.body.name, 'Child C');
  const edited = await put({ name: '  Child D ' });
  assert.equal(edited.status, 200);
  assert.equal(db.prepare('SELECT name FROM children WHERE id = ?').get(KID).name, 'Child D');
});
