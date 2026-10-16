// #555 bullets 1 and 2: a child's colour and birthday, and the type of an avatar photo, are validated.
//
// Before: `POST /api/children` with `color: 'red;background:url(//evil/x)'` returned 201 and stored it, as did any
// string for birthday; a photo only had to start with `data:image/`, which includes image/svg+xml.
// The router and database are real. Each refusal also asserts NOTHING was written, because a 400 that still
// stored the row would look right from the response alone.
//
// What is pinned as UNCHANGED: blank/omitted colour and birthday still mean default / keep / clear, a value equal to
// the stored one is accepted (the edit form re-sends the whole record), and the colours the app's own palette
// sends and the date <input type="date"> sends pass.
import { test, before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, makeChild, signToken, mountRouter, call,
} from './helpers/harness.js';

useTempDataDir();
const { default: db } = await import('../src/db.js');
const { default: childrenRouter } = await import('../src/routes/children.js');

let server;
let token;
const KID = 'kid-validate';
const post = (body) => call(`${server.url}/api/children`, { method: 'POST', token, body });
const put = (body) => call(`${server.url}/api/children/${KID}`, { method: 'PUT', token, body });
const row = () => db.prepare('SELECT * FROM children WHERE id = ?').get(KID);
const count = () => db.prepare('SELECT COUNT(*) AS c FROM children').get().c;

before(async () => {
  server = await mountRouter('/api/children', childrenRouter);
  const admin = makeUser(db, { id: 'u-v', username: 'admin', role: 'admin' });
  token = signToken({ sub: admin.id, role: 'admin', sid: makeSession(db, admin.id) });
});
after(async () => {
  await server.close();
  cleanupTempDataDirs();
});
beforeEach(() => {
  db.prepare('DELETE FROM children').run();
  makeChild(db, { id: KID, name: 'Original' });
  db.prepare('UPDATE children SET color = ?, birthday = ? WHERE id = ?').run('#7FBFA3', '2023-04-01', KID);
});

const BAD_COLORS = ['red;background:url(//evil/x)', 'red', '#fff', '#12345', '#1234567', '#GGGGGG', ' #112233', '#112233 ', 12, {}, ['#112233'], true];
const BAD_BIRTHDAYS = ['yesterday', '2023-4-1', '2023-02-31', '2023-13-01', '2023-00-10', '20230401', '2023-04-01T00:00:00Z', 5, {}, ['2023-04-01'], true];

describe('colour', () => {
  for (const bad of BAD_COLORS) {
    test(`POST with colour ${JSON.stringify(bad)} is a 400 and nothing is created`, async () => {
      const res = await post({ name: 'New', color: bad });
      assert.equal(res.status, 400);
      assert.match(res.body.error, /Colour must be a hex colour/);
      assert.equal(count(), 1);
    });
    test(`PUT with colour ${JSON.stringify(bad)} is a 400 and the stored colour stays`, async () => {
      const res = await put({ name: 'Renamed', color: bad });
      assert.equal(res.status, 400);
      assert.equal(row().color, '#7FBFA3');
      assert.equal(row().name, 'Original', 'a refused request must write nothing, the name included');
    });
  }

  test('the palette colours and the default are accepted, upper or lower case', async () => {
    for (const c of ['#f4c56a', '#7FBFA3', '#8A9FE0', '#E0A5C9', '#E0B27F', '#7c83db']) {
      assert.equal((await put({ color: c })).status, 200, c);
      assert.equal(row().color, c);
    }
    const created = await post({ name: 'New', color: '#ABCDEF' });
    assert.equal(created.status, 201);
    assert.equal(created.body.color, '#ABCDEF');
  });

  test('blank or omitted colour keeps the default on POST and the stored value on PUT, as before', async () => {
    const created = await post({ name: 'New' });
    assert.equal(created.status, 201);
    assert.equal(created.body.color, '#F5D9A8');
    for (const blank of [null, '']) {
      assert.equal((await put({ name: 'Original', color: blank })).status, 200);
      assert.equal(row().color, '#7FBFA3');
    }
  });

  test('a colour stored before this check is accepted when re-sent unchanged, refused when changed to another bad one', async () => {
    db.prepare('UPDATE children SET color = ? WHERE id = ?').run('legacy-not-hex', KID);
    assert.equal((await put({ name: 'Renamed', color: 'legacy-not-hex' })).status, 200);
    assert.equal(row().name, 'Renamed');
    assert.equal((await put({ color: 'another-bad' })).status, 400);
  });
});

describe('birthday', () => {
  for (const bad of BAD_BIRTHDAYS) {
    test(`POST with birthday ${JSON.stringify(bad)} is a 400 and nothing is created`, async () => {
      const res = await post({ name: 'New', birthday: bad });
      assert.equal(res.status, 400);
      assert.match(res.body.error, /Birthday must be a date/);
      assert.equal(count(), 1);
    });
    test(`PUT with birthday ${JSON.stringify(bad)} is a 400 and the stored birthday stays`, async () => {
      const res = await put({ name: 'Renamed', birthday: bad });
      assert.equal(res.status, 400);
      assert.equal(row().birthday, '2023-04-01');
      assert.equal(row().name, 'Original');
    });
  }

  test('real dates are accepted, including a leap day and a future date; blank clears, omitted keeps', async () => {
    for (const d of ['2024-02-29', '2023-04-01', '2999-12-31']) {
      assert.equal((await put({ birthday: d })).status, 200, d);
      assert.equal(row().birthday, d);
    }
    assert.equal((await put({ birthday: '' })).status, 200);
    assert.equal(row().birthday, '', 'an explicit blank still clears (children-route.test.js)');
    assert.equal((await post({ name: 'New', birthday: '2024-02-29' })).status, 201);
    // 2023-02-29 does not exist (2023 is not a leap year); 2024-02-29 does.
    assert.equal((await put({ birthday: '2023-02-29' })).status, 400);
  });

  // The birthday twin of the colour test above (PR #702 review: dropping `|| birthday === existing` from
  // badBirthday survived, because only the colour had a "stored before this check" case).
  test('a birthday stored before this check is accepted when re-sent unchanged, refused when changed to another bad one', async () => {
    db.prepare('UPDATE children SET birthday = ? WHERE id = ?').run('legacy-not-a-date', KID);
    assert.equal((await put({ name: 'Renamed', birthday: 'legacy-not-a-date' })).status, 200);
    assert.equal(row().name, 'Renamed');
    assert.equal(row().birthday, 'legacy-not-a-date');
    assert.equal((await put({ name: 'Again', birthday: 'another-bad' })).status, 400);
    assert.equal(row().name, 'Renamed', 'a refused request must write nothing');
  });
});

describe('photo type', () => {
  const JPEG = 'data:image/jpeg;base64,/9j/4AAQ';
  test('jpeg, png and webp are accepted on POST and PUT', async () => {
    for (const p of [JPEG, 'data:image/png;base64,iVBORw0K', 'data:image/webp;base64,UklGRg==']) {
      assert.equal((await put({ photo: p })).status, 200, p);
      assert.equal(row().photo, p);
    }
    assert.equal((await post({ name: 'New', photo: JPEG })).status, 201);
  });

  test('svg, gif, a non-base64 image URL and an upper-case MIME type are refused and nothing is stored', async () => {
    for (const p of [
      'data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+', 'data:image/gif;base64,R0lGODlh',
      'data:image/png,rawbytes', 'data:IMAGE/PNG;base64,AAAA', 'data:image/jpeg;charset=utf-8;base64,AAAA',
    ]) {
      const res = await put({ photo: p });
      assert.equal(res.status, 400, p);
      assert.match(res.body.error, /Photo must be/);
      assert.equal(row().photo, null);
      assert.equal((await post({ name: 'New', photo: p })).status, 400, p);
    }
    assert.equal(count(), 1);
  });

  test('a photo stored before the allowlist (a gif) does not block saving the child, when re-sent unchanged', async () => {
    const gif = 'data:image/gif;base64,R0lGODlh';
    db.prepare('UPDATE children SET photo = ? WHERE id = ?').run(gif, KID);
    assert.equal((await put({ name: 'Renamed', photo: gif })).status, 200);
    assert.equal(row().name, 'Renamed');
    assert.equal(row().photo, gif);
    assert.equal((await put({ photo: 'data:image/svg+xml;base64,AA==' })).status, 400);
  });

  // INTENDED (see the comment on normalizePhoto in lib/photo.js): a value equal to the stored one is accepted
  // UNCHECKED, size included. The cap used to be 700 KB, and a photo stored under it (up to the ~99 KB the
  // 100 KB body limit let through) can sit above today's 90 KB cap; refusing it on a re-send would block every
  // later save of that child, a rename included. Only a CHANGED photo is held to the cap. 95 KB keeps the whole
  // PUT body under the 100 KB express.json limit, so this is a request the real app can make.
  test('a photo above the cap that was stored earlier is accepted when re-sent unchanged; a new one above the cap is refused', async () => {
    const big = `data:image/jpeg;base64,${'A'.repeat(95 * 1024)}`;
    db.prepare('UPDATE children SET photo = ? WHERE id = ?').run(big, KID);
    assert.equal((await put({ name: 'Renamed', photo: big })).status, 200);
    assert.equal(row().name, 'Renamed');
    assert.equal(row().photo, big);
    const other = `data:image/jpeg;base64,${'B'.repeat(95 * 1024)}`;
    const res = await put({ name: 'Again', photo: other });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /too large/);
    assert.equal(row().photo, big, 'a refused photo must not replace the stored one');
    assert.equal(row().name, 'Renamed');
  });
});
