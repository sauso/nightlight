// PUT /api/children/:id — over real HTTP against the real router.
//
// ★ WHY. Same seam as the detection route, and the same reason: a caller sends a PARTIAL payload and
// relies on the route to keep the rest. On the child screen, changing the avatar writes immediately
// with only `{ name, birthday, color, photo }` — no `track_sleep`, no sleep window. If a missing
// field ever meant "clear" rather than "keep", **setting a child's photo would silently switch their
// sleep tracking off**, or reset the overnight window that every night's analysis is scoped to. The
// screen would look right, the photo would appear, and the damage would only show up as sleep data
// quietly going missing.
//
// ⚠️ WHAT THIS FILE DOES **NOT** COVER, stated plainly because an earlier version of this very header
// claimed otherwise: `reconcileChildLegs`. Turning tracking on, or moving the window, changes whether
// the activity leg should be running right now, so the route re-evaluates immediately rather than
// waiting up to five minutes for the periodic reconcile — and "nothing happened until I restarted the
// container" is the symptom of getting that wrong. **No test here pins it.** Its only observable
// effect is a call to `startMotionDetector`, which spawns an FFmpeg leg; this harness exists precisely
// to keep the process tree out, and node:test cannot intercept the import without an experimental
// flag. So a mutation deleting the reconcile call survives this suite. Verified, not assumed —
// removing line 94 of children.js leaves all of these green.
// ★ The header said "the tests below pin when that is triggered" and nothing did. That is the same
// shape as PR #229's test whose NAME carried the invariant its body never asserted, and it is worth
// leaving the correction visible: a file header is an assertion too, and nothing checks it.
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
const KID = 'kid-1';

const CONFIGURED = {
  name: 'Raffa',
  birthday: '2023-04-01',
  color: '#7FBFA3',
  track_sleep: 1,
  sleep_window_start: '19:30',
  sleep_window_end: '06:45',
};

const put = (body) => call(`${server.url}/api/children/${KID}`, { method: 'PUT', token, body });
const row = () => db.prepare('SELECT * FROM children WHERE id = ?').get(KID);

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
  db.prepare('DELETE FROM children WHERE id = ?').run(KID);
  makeChild(db, { id: KID, name: CONFIGURED.name, track: 1, start: CONFIGURED.sleep_window_start, end: CONFIGURED.sleep_window_end });
  db.prepare('UPDATE children SET birthday = ?, color = ? WHERE id = ?').run(CONFIGURED.birthday, CONFIGURED.color, KID);
});

test('★★ the photo-only write from the child screen keeps the sleep settings', async () => {
  // The exact payload `persistPhoto` sends. This is the test the file exists for.
  const res = await put({ name: 'Raffa', birthday: '2023-04-01', color: '#7FBFA3', photo: null });
  assert.equal(res.status, 200);
  const r = row();
  assert.equal(r.track_sleep, 1, 'changing a photo must not switch sleep tracking off');
  assert.equal(r.sleep_window_start, '19:30', 'nor move the window every night is scoped to');
  assert.equal(r.sleep_window_end, '06:45');
});

test('★ each omitted field is kept, one at a time', async () => {
  const before = row();
  const res = await put({ color: '#8A9FE0' });
  assert.equal(res.status, 200);
  const after = row();

  assert.equal(after.color, '#8A9FE0', 'the field that WAS sent changes');
  for (const col of ['name', 'birthday', 'track_sleep', 'sleep_window_start', 'sleep_window_end']) {
    assert.equal(after[col], before[col], `${col} must be untouched by a write that never mentioned it`);
  }
});

test('an empty name is ignored rather than blanking the child', async () => {
  // A child with no name is unidentifiable everywhere it appears — the tile, the sleep history, the
  // camera assignment list. Falling back to the existing name is the safe reading of a blank.
  const res = await put({ name: '   ' });
  assert.equal(res.status, 200);
  assert.equal(row().name, 'Raffa');
});

test('★ a birthday can be CLEARED, which is different from omitting it', async () => {
  // `birthday !== undefined ? birthday : existing.birthday` — the `!== undefined` is what makes an
  // explicit empty string mean "remove it" while an absent key means "keep it". Written as
  // `birthday || existing.birthday` the two collapse, and a birthday entered by mistake could never
  // be taken off again. Both directions asserted, because only the pair distinguishes them.
  const cleared = await put({ birthday: '' });
  assert.equal(cleared.status, 200);
  assert.equal(row().birthday, '', 'an explicit blank clears it');

  db.prepare('UPDATE children SET birthday = ? WHERE id = ?').run('2023-04-01', KID);
  await put({ name: 'Raffa' });
  assert.equal(row().birthday, '2023-04-01', 'while omitting the key keeps it');
});

test('sleep tracking can be turned off, and back on', async () => {
  await put({ track_sleep: false });
  assert.equal(row().track_sleep, 0);
  await put({ track_sleep: true });
  assert.equal(row().track_sleep, 1);
});

test('★ a malformed time is refused with a message, not stored', async () => {
  // The window is parsed on every night's analysis. A junk value here would not fail loudly; it would
  // make the night window unresolvable and the child's sleep quietly stop being computed.
  for (const bad of ['7pm', '25:00', '19:5', '']) {
    const res = await put({ sleep_window_start: bad });
    assert.equal(res.status, 400, `${JSON.stringify(bad)} must be refused`);
    assert.match(res.body.error, /Bedtime must be a time/);
  }
  assert.equal(row().sleep_window_start, '19:30', 'and nothing was written on the way to being refused');
});

test('the wake time is validated the same way, with its own message', async () => {
  // Its own wording, so the message names the field the person actually got wrong.
  const res = await put({ sleep_window_end: 'morning' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Wake time must be a time/);
});

test('a window that runs past midnight is accepted', async () => {
  // The normal case for a child, and the one a naive start < end validation would reject.
  const res = await put({ sleep_window_start: '20:00', sleep_window_end: '07:00' });
  assert.equal(res.status, 200);
  assert.equal(row().sleep_window_start, '20:00');
  assert.equal(row().sleep_window_end, '07:00');
});

test('an unknown child is a 404, not a silent success', async () => {
  const res = await call(`${server.url}/api/children/nope`, { method: 'PUT', token, body: { name: 'X' } });
  assert.equal(res.status, 404);
});

test('the response carries the saved child back, with its cameras', async () => {
  // The screen refreshes its context from this, so a response missing the camera list would make
  // every camera look unassigned until a reload.
  const res = await put({ name: 'Raffaella' });
  assert.equal(res.body.name, 'Raffaella');
  assert.ok(Array.isArray(res.body.cameras), 'withCameras() shape');
});
