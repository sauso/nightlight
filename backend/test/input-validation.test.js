// The validation, caps and guards that a mutation pass could delete with every test still green (issue #563,
// the validation half). Each block below names the mutant that survived before it existed.
//
// The expectations here are TYPED, on purpose, and they come from the documentation, not from the code: the
// ranges are the ones docs/recording.md and docs/camera-controls.md promise in their settings tables, the
// photo cap is the one lib/photo.js's header states, the snooze cap is the 12 hours the route's comment and
// route-permissions.test.js both describe. Deriving them from the source would let a loosened bound move the
// expectation along with it, and nothing would fail.
//
// Every refusal is checked TWICE: the status, and that nothing was written. A check that answers 400 after
// the UPDATE has already run would pass a status-only test.
//
// NOT COVERED HERE (stated, not hidden):
//   - lib/photo.js's 700 KB cap cannot be reached over HTTP today: index.js parses JSON with express.json()'s
//     default 100 KB body limit, so a larger photo is refused by the body parser (413) before normalizePhoto
//     sees it. The cap is pinned at the function; the body limit is index.js's and is not tested here.
//   - A one-element ARRAY (`["#123456"]`) passes the colour and timezone checks, which coerce it to its one
//     string, and better-sqlite3 binds it as that string; it is stored correctly. Checked by hand on
//     2026-10-09 and deliberately not pinned: it is an accident of two libraries, not a contract.
//   - GET /api/push/snapshot/:id's id-format check cannot be told apart from its absence: the store is a Map
//     whose keys are always 64 lowercase hex characters, so a malformed id misses it either way. The format
//     check is defence in depth, catalogued as an equivalent mutant in scripts/mutants.json; the tests below
//     pin what a caller sees.
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import {
  useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, makeCamera, signToken, call,
} from './helpers/harness.js';

useTempDataDir();

const { default: db } = await import('../src/db.js');
const { isAdminRequest } = await import('../src/middleware/auth.js');
const { normalizePhoto } = await import('../src/lib/photo.js');
const { storeSnapshot } = await import('../src/lib/pushSnapshots.js');
const { verifyToken, generateSecret } = await import('../src/lib/mfa.js');
const { generateSync } = await import('otplib');
const ROUTERS = {
  '/api/settings': (await import('../src/routes/settings.js')).default,
  '/api/children': (await import('../src/routes/children.js')).default,
  '/api/auth': (await import('../src/routes/auth.js')).default,
  '/api/cameras': (await import('../src/routes/cameras.js')).default,
  '/api/push': (await import('../src/routes/push.js')).default,
};

let server;
let base;
let adminToken;
let caregiverToken;

before(async () => {
  const app = express();
  app.use(express.json()); // index.js's own body parser, default limit
  for (const [mount, router] of Object.entries(ROUTERS)) app.use(mount, router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
  makeUser(db, { id: 'u-admin', username: 'admin', role: 'admin' });
  makeUser(db, { id: 'u-carer', username: 'carer', role: 'caregiver' });
  adminToken = signToken({ id: 'u-admin', username: 'admin', role: 'admin', sid: makeSession(db, 'u-admin') });
  caregiverToken = signToken({ id: 'u-carer', username: 'carer', role: 'caregiver', sid: makeSession(db, 'u-carer') });
  // mqtt_enabled defaults to 1, and a successful PUT /settings then refreshes the MQTT connection. No broker
  // is configured here, but off is the state that cannot reach the network whatever a test writes.
  db.prepare("UPDATE settings SET mqtt_enabled = 0 WHERE id = 'app'").run();
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
  cleanupTempDataDirs();
});

const api = (p, opts) => call(`${base}${p}`, opts);
const settingsRow = () => db.prepare("SELECT * FROM settings WHERE id = 'app'").get();
const putSettings = (body) => api('/api/settings', { method: 'PUT', token: adminToken, body });

// ---- PUT /api/settings ------------------------------------------------------------------------------------

describe('PUT /api/settings: every numeric setting keeps to its documented range', () => {
  // [column, lowest allowed, highest allowed, where the range is promised]. MUTANT THIS KILLS (#563): the
  // post-roll ceiling raised from 120 to 12000 survived the whole suite; so would any other bound here.
  const BOUNDS = [
    ['ptz_step', 1, 100, 'docs/camera-controls.md'],
    ['camera_offline_alert_minutes', 1, 1440, 'docs/camera-controls.md'],
    ['snooze_alert_minutes', 1, 719, 'docs/camera-controls.md'], // #552: the long-silence notice
    ['clip_pre_roll_s', 0, 30, 'docs/recording.md'],
    ['clip_post_roll_s', 5, 120, 'docs/recording.md'],
    ['clip_retention_days', 0, 365, 'docs/recording.md'],
    ['clip_retention_max_gb', 0, 2000, 'docs/recording.md'],
    ['wake_clip_seconds', 5, 120, 'docs/recording.md'],
    ['wake_clip_retention_days', 0, 365, 'docs/recording.md'],
    ['ondemand_pre_roll_s', 0, 60, 'docs/recording.md'],
    ['ondemand_max_duration_s', 5, 600, 'docs/recording.md'],
  ];

  for (const [field, lo, hi, doc] of BOUNDS) {
    test(`${field}: ${lo} to ${hi} (${doc}); one either side, or not a number, is refused and nothing is written`, async () => {
      // A sentinel strictly inside the range and equal to neither bound, so "unchanged" and "set to a bound"
      // can never look alike.
      const sentinel = lo + 1;
      db.prepare(`UPDATE settings SET ${field} = ? WHERE id = 'app'`).run(sentinel);
      for (const bad of [lo - 1, hi + 1, 'not a number']) {
        const res = await putSettings({ [field]: bad });
        assert.equal(res.status, 400, `${field} = ${JSON.stringify(bad)} was accepted (${JSON.stringify(res.body)})`);
        assert.equal(settingsRow()[field], sentinel, `${field} = ${JSON.stringify(bad)} was refused but still written`);
      }
      for (const good of [lo, hi]) {
        const res = await putSettings({ [field]: good });
        assert.equal(res.status, 200, `${field} = ${good} is inside the documented range but was refused: ${JSON.stringify(res.body)}`);
        assert.equal(settingsRow()[field], good);
      }
    });
  }

  test('a request with one bad field writes none of its good ones', async () => {
    const before = settingsRow();
    const res = await putSettings({ app_name: 'Renamed', accent_color: '#123456', clip_post_roll_s: 121 });
    assert.equal(res.status, 400);
    const now = settingsRow();
    assert.equal(now.app_name, before.app_name);
    assert.equal(now.accent_color, before.accent_color);
  });
});

describe('PUT /api/settings: the three colours must be #RRGGBB', () => {
  // MUTANT THIS KILLS (#563): the hex check disabled survived the whole suite. It matters beyond tidiness:
  // the colours reach EVERY visitor's page as CSS custom properties (frontend SettingsContext.jsx), the
  // unauthenticated login screen included, so the pattern is what keeps the value a colour rather than
  // arbitrary CSS. (The enforcing CSP's img-src is a second layer: it would still block a url() pointing at
  // another origin.)
  const BAD = [
    '#FFF', 'F5D9A8', '#F5D9A', '#F5D9A8A', '#GGGGGG', 'red', '', ' #F5D9A8', '#F5D9A8 ', '#F5D9A8\n',
    '#F5D9A8;background:url(https://example.invalid/x)', 'url(https://example.invalid/x)', 123456,
  ];
  for (const field of ['accent_color', 'live_color', 'offline_color']) {
    test(`${field}: anything but # and six hex digits is refused and nothing is written`, async () => {
      db.prepare(`UPDATE settings SET ${field} = '#0A0B0C' WHERE id = 'app'`).run();
      for (const bad of BAD) {
        const res = await putSettings({ [field]: bad });
        assert.equal(res.status, 400, `${field} = ${JSON.stringify(bad)} was accepted`);
        assert.equal(settingsRow()[field], '#0A0B0C', `${field} = ${JSON.stringify(bad)} was refused but still written`);
      }
      const ok = await putSettings({ [field]: '#a1B2c3' });
      assert.equal(ok.status, 200, 'mixed-case hex is a valid colour');
      assert.equal(settingsRow()[field], '#a1B2c3');
    });
  }
});

describe('PUT /api/settings: the timezone must be one the runtime knows', () => {
  // MUTANT THIS KILLS (#563): the timezone check disabled survived the whole suite. A timezone Intl does
  // not know would be stored, and every later Intl call that reads it (the sleep analysis's DST-safe
  // conversions among them) would throw, for every child, every night.
  test('an unknown zone is refused and nothing is written; real ones are stored as given', async () => {
    db.prepare("UPDATE settings SET timezone = 'UTC' WHERE id = 'app'").run();
    for (const bad of ['Not/AZone', 'Mars/Olympus_Mons', 'UTC+25', '', '../../etc/passwd']) {
      const res = await putSettings({ timezone: bad });
      assert.equal(res.status, 400, `timezone ${JSON.stringify(bad)} was accepted`);
      assert.equal(settingsRow().timezone, 'UTC', `timezone ${JSON.stringify(bad)} was refused but still written`);
    }
    for (const good of ['America/New_York', 'Europe/Berlin', 'UTC']) {
      const res = await putSettings({ timezone: good });
      assert.equal(res.status, 200, `${good} is a real zone but was refused`);
      assert.equal(settingsRow().timezone, good);
    }
  });
});

// ---- photos -----------------------------------------------------------------------------------------------

describe('photos: an image data URL, within the cap', () => {
  // The cap lib/photo.js's header states: ~700 KB of base64, a 512 px JPEG with headroom.
  const MAX = 700 * 1024;
  const PREFIX = 'data:image/jpeg;base64,';
  const ofLength = (n) => PREFIX + 'A'.repeat(n - PREFIX.length);

  test('omitted keeps what is stored; null or empty clears it', () => {
    assert.equal(normalizePhoto(undefined, 'data:image/png;base64,KEEP'), 'data:image/png;base64,KEEP');
    assert.equal(normalizePhoto(null, 'data:image/png;base64,KEEP'), null);
    assert.equal(normalizePhoto('', 'data:image/png;base64,KEEP'), null);
  });

  test('only an image data URL is accepted', () => {
    // MUTANT THIS KILLS (#563): loosening the prefix check was caught only by accident, by an unrelated
    // timelapse test. A photo is stored as given and served back to every signed-in user.
    assert.equal(normalizePhoto('data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA');
    for (const bad of [
      'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==', 'data:application/octet-stream;base64,AA',
      'data:,image/png', 'https://example.invalid/a.png', 'javascript:alert(1)', 123, {}, ['data:image/png;base64,AA'],
    ]) {
      assert.throws(() => normalizePhoto(bad), /Photo must be an image data URL/, JSON.stringify(bad));
    }
  });

  test(`exactly ${MAX} characters is accepted; one more is refused`, () => {
    // MUTANT THIS KILLS (#563): the size cap removed survived the whole suite.
    assert.equal(normalizePhoto(ofLength(MAX)).length, MAX);
    assert.throws(() => normalizePhoto(ofLength(MAX + 1)), /too large/);
  });

  test('the routes that take a photo refuse a non-image and store nothing', async () => {
    const html = 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==';
    const childCount = () => db.prepare('SELECT COUNT(*) AS c FROM children').get().c;
    const before = childCount();
    // An ADMIN token: adding a child is admin-only since #542, and a caregiver's 403 would pass this
    // assertion without the photo check ever running.
    const child = await api('/api/children', { method: 'POST', token: adminToken, body: { name: 'A child', photo: html } });
    assert.equal(child.status, 400);
    assert.equal(childCount(), before, 'the child was created anyway');

    const me = await api('/api/auth/me', { method: 'PUT', token: caregiverToken, body: { first_name: 'Changed', photo: html } });
    assert.equal(me.status, 400);
    const row = db.prepare("SELECT first_name, photo FROM users WHERE id = 'u-carer'").get();
    assert.equal(row.photo, null);
    assert.equal(row.first_name, null, 'PUT /me wrote the name of a request it refused');

    const user = await api('/api/auth/users', { method: 'POST', token: adminToken, body: { username: 'pic', password: 'long-enough-1', photo: html } });
    assert.equal(user.status, 400);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM users WHERE username = 'pic'").get().c, 0);
  });
});

// ---- snooze ----------------------------------------------------------------------------------------------

describe('POST /api/cameras/:id/snooze: at most 12 hours, whole minutes, zero or less un-mutes', () => {
  // MUTANT THIS KILLS (#563): removing the 720-minute cap survived the whole suite. Any signed-in caregiver
  // can mute ALL of a camera's alerts with this route (route-permissions.test.js; owner decision 2026-10-10), so the cap
  // is what bounds a forgotten or mistaken mute to one night instead of forever.
  before(() => { makeCamera(db, { id: 'cam-1', name: 'Snooze Cam' }); });
  const stored = () => db.prepare("SELECT alerts_snoozed_until AS v FROM cameras WHERE id = 'cam-1'").get().v;

  const CASES = [
    // [what was sent, minutes it must mean (null = not muted)]
    [721, 720], [100000, 720], [720, 720], [1, 1], [2.6, 3], [0, null], [-5, null], ['abc', null], [undefined, null],
  ];
  for (const [sent, minutes] of CASES) {
    test(`minutes = ${JSON.stringify(sent)} mutes for ${minutes === null ? 'nothing' : `${minutes} min`}`, async () => {
      // A camera that IS muted (an hour left), so every "nothing" case is a real un-mute. Since #552 an un-mute
      // of a camera that is not muted writes nothing at all (who-did-it.test.js), so an expired value planted
      // here, as this used to, would stay in the database while the answer says null (not muted).
      db.prepare("UPDATE cameras SET alerts_snoozed_until = ? WHERE id = 'cam-1'").run(Date.now() + 3_600_000);
      const t0 = Date.now();
      const res = await api('/api/cameras/cam-1/snooze', { method: 'POST', token: caregiverToken, body: sent === undefined ? {} : { minutes: sent } });
      const t1 = Date.now();
      assert.equal(res.status, 200);
      assert.equal(res.body.alerts_snoozed_until, stored(), 'the answer and the database disagree');
      if (minutes === null) {
        assert.equal(res.body.alerts_snoozed_until, null);
      } else {
        const until = res.body.alerts_snoozed_until;
        assert.ok(until >= t0 + minutes * 60_000 && until <= t1 + minutes * 60_000,
          `expected ${minutes} min from now, got ${((until - t0) / 60_000).toFixed(2)} min`);
      }
    });
  }

  test('an unknown camera is a 404, not a silent no-op', async () => {
    const res = await api('/api/cameras/no-such-cam/snooze', { method: 'POST', token: caregiverToken, body: { minutes: 10 } });
    assert.equal(res.status, 404);
  });
});

// ---- push snapshot ---------------------------------------------------------------------------------------

describe('GET /api/push/snapshot/:id: only the exact id it was stored under', () => {
  // This route is PUBLIC (a phone's system layer fetches the picture without the app's token), so what it
  // serves is decided by the id alone.
  test('the stored id serves the image; anything near it is a 404', async () => {
    const id = storeSnapshot(Buffer.from('fake-jpeg-bytes'));
    assert.match(id, /^[a-f0-9]{64}$/);
    const res = await fetch(`${base}/api/push/snapshot/${id}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/jpeg');
    assert.match(res.headers.get('cache-control') || '', /private/);
    assert.equal(await res.text(), 'fake-jpeg-bytes');
    for (const near of [id.toUpperCase(), id.slice(1), `${id}0`, `${id.slice(0, 63)}g`, 'zz', '%00']) {
      const r = await fetch(`${base}/api/push/snapshot/${near}`);
      assert.equal(r.status, 404, `${near} served something`);
    }
  });
});

// ---- isAdminRequest ----------------------------------------------------------------------------------------

describe('isAdminRequest reads the role as an own property only', () => {
  // MUTANT THIS KILLS (#563): dropping the Object.hasOwn check survived the whole suite, because every real
  // req.user is built with an own `role` from the database (middleware/auth.js), so no request can reach the
  // branch. It is defence in depth against a polluted Object.prototype, whose failure direction is WIDENING
  // a response; the function is the one place that decision is made, so it is pinned here directly.
  test('an inherited role is not an admin role', () => {
    assert.equal(isAdminRequest({ user: Object.create({ role: 'admin' }) }), false);
  });

  test('only exactly "admin" is admin', () => {
    assert.equal(isAdminRequest({ user: { role: 'admin' } }), true);
    for (const req of [{ user: { role: 'caregiver' } }, { user: { role: 'Admin' } }, { user: { role: 'viewer' } },
      { user: {} }, { user: null }, {}, null, undefined]) {
      assert.equal(isAdminRequest(req), false, JSON.stringify(req));
    }
  });
});

// ---- MFA ---------------------------------------------------------------------------------------------------

describe('MFA: no code verifies against a missing secret', () => {
  // A TOTP code for an arbitrary raw key, computed from RFC 6238 directly rather than with otplib, so it can
  // be computed for the EMPTY key, which otplib itself refuses to do.
  const totpForKey = (key, now = Date.now()) => {
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(Math.floor(now / 1000 / 30)));
    const h = crypto.createHmac('sha1', key).update(counter).digest();
    const off = h[h.length - 1] & 0xf;
    return String((h.readUInt32BE(off) & 0x7fffffff) % 1_000_000).padStart(6, '0');
  };
  const base32Decode = (s) => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = '';
    for (const ch of s.replace(/=+$/, '').toUpperCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
    return Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  };

  test('the RFC 6238 helper is right: its code for a real secret verifies', () => {
    // Without this, the next test could pass because the helper computes garbage.
    const secret = generateSecret();
    assert.equal(verifyToken(secret, totpForKey(base32Decode(secret))), true);
  });

  test('a code computed for the empty key does not verify against an empty or missing secret', () => {
    // An account row with MFA on but no secret (a half-finished enrolment, a hand-edited database) must
    // refuse every code. HMAC with an empty key is perfectly well defined, so "it cannot compute" is not
    // what protects this; verifyToken's up-front refusal (and otplib's minimum secret size behind it) is.
    const code = totpForKey(Buffer.alloc(0));
    for (const secret of ['', null, undefined]) assert.equal(verifyToken(secret, code), false, JSON.stringify(secret));
  });
});

describe('MFA enrolment cannot replace a second factor that is already on', () => {
  // POST /me/mfa/setup needs only a live session, not the password (turning MFA OFF needs the password).
  // If setup worked on an account that already has MFA on, whoever holds an unlocked, signed-in device
  // could swap in a secret of their own: the owner's authenticator would stop working and theirs would be
  // the live second factor. These guards had no test.
  let token;
  const row = () => db.prepare("SELECT mfa_enabled, mfa_secret, mfa_backup_codes FROM users WHERE id = 'u-mfa'").get();
  beforeEach(() => {
    db.prepare("DELETE FROM users WHERE id = 'u-mfa'").run();
    makeUser(db, { id: 'u-mfa', username: 'mfa-user', role: 'caregiver' });
    token = signToken({ id: 'u-mfa', username: 'mfa-user', role: 'caregiver', sid: makeSession(db, 'u-mfa') });
  });

  test('setup on an MFA-enabled account is refused and the active secret is untouched', async () => {
    const secret = generateSecret();
    db.prepare("UPDATE users SET mfa_enabled = 1, mfa_secret = ?, mfa_backup_codes = '[]' WHERE id = 'u-mfa'").run(secret);
    const res = await api('/api/auth/me/mfa/setup', { method: 'POST', token });
    assert.equal(res.status, 400);
    assert.equal(res.body.secret, undefined, 'a new secret was handed out');
    assert.equal(row().mfa_secret, secret, 'the active secret was replaced');
  });

  test('enable on an MFA-enabled account is refused and its backup codes are untouched', async () => {
    const secret = generateSecret();
    db.prepare("UPDATE users SET mfa_enabled = 1, mfa_secret = ?, mfa_backup_codes = '[\"kept\"]' WHERE id = 'u-mfa'").run(secret);
    const res = await api('/api/auth/me/mfa/enable', { method: 'POST', token, body: { code: generateSync({ secret }) } });
    assert.equal(res.status, 400);
    assert.equal(res.body.backup_codes, undefined);
    assert.equal(row().mfa_backup_codes, '["kept"]', 'the backup codes were regenerated');
  });

  test('enable before setup says to start setup, and turns nothing on', async () => {
    const res = await api('/api/auth/me/mfa/enable', { method: 'POST', token, body: { code: '123456' } });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'Start setup first.');
    assert.equal(row().mfa_enabled, 0);
  });
});
