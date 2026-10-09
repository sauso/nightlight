// No API response ever carries a stored secret (issue #563, the secret-handling half).
//
// WHY THIS EXISTS. #563's mutation pass found that GET /api/settings/mqtt could return the MQTT password
// in clear, and that lib/secretMask.js could return the whole secret (or stop masking short ones), with
// all 80 backend test files still green: no test mentioned secretMask at all. The existing leak tests
// each guard one route with a field list someone typed (settings-exposure.test.js, the users scan in
// auth-routes.test.js, cameras-assign-exposure.test.js), so a secret column added later, or a secret
// re-exposed by some OTHER route, passes all of them.
//
// HOW THIS FILE IS SHAPED, and why:
//   1. THE SECRET COLUMNS ARE DERIVED FROM THE SCHEMA, not typed. Every column in every table whose NAME
//      says it is a credential (password, secret, token, key, hash, backup code) is a secret, unless it is
//      in NOT_A_SECRET with a reason. A new `foo_api_key` column is covered the day it is added. The typed
//      list below (KNOWN_WHEN_WRITTEN) is only a FLOOR: it fails if the derivation ever stops seeing a
//      credential it used to see.
//   2. THE FIXTURE IS HOSTILE. A recognisable marker is planted in EVERY derived column, in a real row of
//      that table, and read back before anything is asserted. A route that leaks a NULL looks exactly like
//      a route that strips the field; a route that leaks a marker cannot hide. A table that has a secret
//      column but no row this file knows how to create FAILS, rather than being skipped.
//   3. EVERY GET ROUTE IN THE APP IS ASKED, as anonymous, as a caregiver and as an admin. The routes are
//      enumerated from the real routers (helpers/routeTable.js, the same enumeration route-permissions.test.js
//      pins), so a route added later is swept without anyone editing this file. The expectation (no marker,
//      anywhere, ever) does not come from the code under test, so deriving the route list from it is safe.
//   4. THE ROUTES THAT SAVE A SECRET are exercised on purpose: a new secret is stored, a blank one keeps the
//      old (the "leave blank to keep the current one" contract the settings forms rely on), and neither
//      answer echoes it. A masked preview must be EXACTLY maskSecret's shape: four characters, then dots.
//
// ⚠️ THE MARKER SHAPE IS LOAD-BEARING. maskSecret shows the first FOUR characters of a secret longer than
// eight. Every marker starts with four throwaway characters (`qqqq`) and only then the distinctive
// `LEAK-`, so a correct masked preview shows `qqqq••••••` and never the word LEAK. Seeing `LEAK-` in any
// response therefore means more than the permitted prefix escaped.
//
// NOT COVERED HERE (stated, not hidden):
//   - Credentials embedded INSIDE a URL column (cameras.rtsp_url, sub_rtsp_url, snapshot_url) are not found
//     by a column-name rule. cameras-assign-exposure.test.js, camera-report-redaction.test.js and
//     diagnostics-credential-leak-gate.test.js cover them.
//   - Non-GET routes outside the secret-saving ones below are not swept: most of them start transcoders,
//     probe ONVIF devices or send notifications, which a unit test must not do.
//   - The Firebase service-account file lives on disk, not in the database; push.test.js covers it.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';
import bcrypt from 'bcryptjs';
import {
  useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, makeCamera, signToken, call,
} from './helpers/harness.js';
import { scanAppRegistrations, enumerateRouter, instantiate } from './helpers/routeTable.js';

useTempDataDir();

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX = path.resolve(HERE, '..', 'src', 'index.js');

const { default: db } = await import('../src/db.js');
const { maskSecret } = await import('../src/lib/secretMask.js');
const { generateBackupCodes } = await import('../src/lib/mfa.js');
// The app verifies with otplib v13's verifySync; generate with the SAME library (as auth-routes.test.js
// does) so the fixture cannot drift from the implementation.
const { generateSync } = await import('otplib');

// ---- which columns are secrets: derived from the schema ---------------------------------------------------

// A column whose NAME says credential. Deliberately broad: a false positive costs one NOT_A_SECRET line
// with a reason; a false negative is a leak nobody is told about.
const SECRET_NAME = /password|passwd|secret|token|key|hash|backup_code/i;

// Columns the rule matches that are NOT credentials, each with the reason. A stale entry fails (below).
const NOT_A_SECRET = {
  'cameras.onvif_profile_token':
    "an ONVIF media-profile NAME (e.g. 'Profile_1') picked from the camera's own GetProfiles answer; it " +
    'authorises nothing, and GET /api/cameras returns it to every role by design',
};

// A floor, not the list: the credentials that existed when this file was written (2026-10-09). If the
// derivation stops finding one of these, SECRET_NAME was narrowed or a column was renamed past it.
const KNOWN_WHEN_WRITTEN = [
  'cameras.onvif_password', 'cameras.talk_password',
  'push_tokens.token',
  'settings.gotify_app_token', 'settings.mqtt_password', 'settings.ntfy_password', 'settings.ntfy_token',
  'settings.pushover_app_token', 'settings.pushover_user_key',
  'users.mfa_backup_codes', 'users.mfa_secret', 'users.password_hash',
];

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()
  .map((r) => r.name);
function deriveSecretColumns() {
  const out = [];
  for (const table of tables) {
    for (const { name: column } of db.prepare(`PRAGMA table_info(${table})`).all()) {
      if (SECRET_NAME.test(column) && !Object.hasOwn(NOT_A_SECRET, `${table}.${column}`)) out.push({ table, column });
    }
  }
  return out;
}
const SECRET_COLUMNS = deriveSecretColumns();
const SECRET_TABLES = [...new Set(SECRET_COLUMNS.map((c) => c.table))];

// ---- markers ----------------------------------------------------------------------------------------------

// Four throwaway characters first (see the header): maskSecret may legitimately show them, and nothing else.
const SHOWN = 'qqqq';
const marker = (label) => `${SHOWN}LEAK-${label}`;
// REAL credentials (bcrypt hashes, TOTP secrets, backup-code hashes) of the accounts that have to log in for
// real, where a marker cannot stand in. Each is long and random, so its tail is as recognisable as a marker.
const REAL_SECRETS = [];
// A body "leaks" if any part of a marker past its permitted 4-character prefix appears in it, or the tail
// of a real credential does.
const leakIn = (body) => {
  const text = (typeof body === 'string' ? body : JSON.stringify(body)) ?? '';
  const at = text.indexOf('LEAK-');
  if (at !== -1) return text.slice(Math.max(0, at - 30), at + 60);
  const real = REAL_SECRETS.find((s) => text.includes(s.slice(4)));
  return real ? `the tail of a real stored credential (${real.slice(0, 12)}...)` : null;
};
const DOTS6 = '•'.repeat(6);

// ---- the app: every router, mounted as index.js mounts it ------------------------------------------------

// Same discovery as route-permissions.test.js: index.js cannot be imported (it starts MediaMTX and MQTT),
// so its router mounts are read from the source and each router is imported for real.
const SCAN = scanAppRegistrations(fs.readFileSync(INDEX, 'utf8'));
const MOUNTS = [];
for (const reg of SCAN.registrations) {
  const [where, what] = reg.args;
  const spec = what?.ident && SCAN.imports.get(what.ident);
  if (reg.verb !== 'use' || reg.args.length !== 2 || where.value === undefined || !spec?.startsWith('./routes/')) continue;
  const { default: router } = await import(new URL(spec, pathToFileURL(INDEX)).href);
  MOUNTS.push({ mount: where.value, spec, router });
}
const GET_ROUTES = MOUNTS.flatMap(({ mount, spec, router }) => enumerateRouter(router, mount, spec))
  .filter((r) => r.method === 'get');

let base;
let server;
let adminToken;
let caregiverToken;

before(async () => {
  const app = express();
  app.use(express.json()); // index.js's own body parser, default limit
  for (const { mount, router } of MOUNTS) app.use(mount, router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
  cleanupTempDataDirs();
});

const api = (p, opts) => call(`${base}${p}`, opts);

// ---- planting: one real row per table that holds a secret ------------------------------------------------

// How to put a REAL row in each table that has a secret column. The marker is then written into every
// derived secret column of that row by one generic UPDATE, so this map says only how to create a row,
// never which columns are secret.
const ROW_MAKERS = {
  settings: () => {
    // mqtt_enabled defaults to 1 (see settings-exposure.test.js): with it on, a successful PUT /settings
    // dials the broker for real. Off, and nothing here leaves the process.
    db.prepare("UPDATE settings SET mqtt_enabled = 0 WHERE id = 'app'").run();
    return [{ where: "id = 'app'", params: [], label: 'settings' }];
  },
  users: () => {
    makeUser(db, { id: 'u-admin', username: 'admin', role: 'admin' });
    makeUser(db, { id: 'u-carer', username: 'carer', role: 'caregiver' });
    // MFA on for the caregiver so GET /me/mfa runs its enabled branch (needs_reenrolment reads the secret).
    db.prepare("UPDATE users SET mfa_enabled = 1 WHERE id = 'u-carer'").run();
    return [
      { where: 'id = ?', params: ['u-admin'], label: 'users[admin]' },
      { where: 'id = ?', params: ['u-carer'], label: 'users[carer]' },
    ];
  },
  cameras: () => {
    // Disabled, so GET /api/cameras and the diagnostics bundle do not ask MediaMTX for its status.
    makeCamera(db, { id: 'cam-1', name: 'Planted Cam', extra: { disabled: 1 } });
    return [{ where: 'id = ?', params: ['cam-1'], label: 'cameras' }];
  },
  push_tokens: () => {
    db.prepare("INSERT INTO push_tokens (token, user_id, platform, session_id) VALUES ('placeholder', 'u-admin', 'android', NULL)").run();
    return [{ where: "token = 'placeholder'", params: [], label: 'push_tokens' }];
  },
};
// Order matters only for push_tokens' user_id; derived tables are planted in this order when present.
const PLANT_ORDER = ['settings', 'users', 'cameras', 'push_tokens'];

describe('the secret columns are derived from the schema', () => {
  test('the derivation still finds every credential that existed when this was written', () => {
    const found = SECRET_COLUMNS.map((c) => `${c.table}.${c.column}`);
    const lost = KNOWN_WHEN_WRITTEN.filter((k) => !found.includes(k));
    assert.deepEqual(lost, [], `SECRET_NAME no longer matches ${lost.join(', ')}: narrowed, or a column was renamed past it`);
  });

  test('every NOT_A_SECRET exception still names a real column the rule matches', () => {
    for (const key of Object.keys(NOT_A_SECRET)) {
      const [table, column] = key.split('.');
      const cols = tables.includes(table) ? db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name) : [];
      assert.ok(cols.includes(column), `${key} is excused but no longer exists; delete the exception`);
      assert.match(column, SECRET_NAME, `${key} is excused but the rule no longer matches it; delete the exception`);
    }
  });

  test('a credential column added later is found without anyone editing this file', () => {
    // The forward-compatibility claim, tested rather than asserted: add a column the way a migration in
    // db.js would, and the derivation must pick it up. (The plant and the sweeps below are generic over
    // whatever this returns.) Dropped again so nothing after this test sees it.
    db.exec('ALTER TABLE settings ADD COLUMN zz563_webhook_api_key TEXT');
    try {
      assert.ok(deriveSecretColumns().some((c) => c.table === 'settings' && c.column === 'zz563_webhook_api_key'));
    } finally {
      db.exec('ALTER TABLE settings DROP COLUMN zz563_webhook_api_key');
    }
  });

  test('every table holding a secret has a row maker here, so none can go unplanted', () => {
    const missing = SECRET_TABLES.filter((t) => !Object.hasOwn(ROW_MAKERS, t));
    assert.deepEqual(missing, [], `teach ROW_MAKERS to create a real row in: ${missing.join(', ')}`);
  });
});

describe('every API response, for every role', () => {
  let carerSid;
  before(() => {
    for (const table of PLANT_ORDER.filter((t) => SECRET_TABLES.includes(t))) {
      const cols = SECRET_COLUMNS.filter((c) => c.table === table).map((c) => c.column);
      for (const row of ROW_MAKERS[table]()) {
        const sets = cols.map((c) => `${c} = ?`).join(', ');
        db.prepare(`UPDATE ${table} SET ${sets} WHERE ${row.where}`)
          .run(...cols.map((c) => marker(`${row.label}.${c}`)), ...row.params);
      }
    }
    const adminSid = makeSession(db, 'u-admin');
    carerSid = makeSession(db, 'u-carer');
    adminToken = signToken({ id: 'u-admin', username: 'admin', role: 'admin', sid: adminSid });
    caregiverToken = signToken({ id: 'u-carer', username: 'carer', role: 'caregiver', sid: carerSid });
  });

  test('the plant took: every derived secret column holds a marker, not a NULL', () => {
    const empty = [];
    for (const { table, column } of SECRET_COLUMNS) {
      const vals = db.prepare(`SELECT ${column} AS v FROM ${table}`).all().map((r) => r.v);
      if (!vals.length || vals.some((v) => typeof v !== 'string' || !v.includes('LEAK-'))) empty.push(`${table}.${column}: ${JSON.stringify(vals)}`);
    }
    assert.deepEqual(empty, [], 'a secret column was not planted, so a leak of it would be invisible');
  });

  // ---- the routes that save a secret ----------------------------------------------------------------------

  describe('PUT /api/settings and GET /api/settings/mqtt: the MQTT password', () => {
    const stored = () => db.prepare("SELECT mqtt_password FROM settings WHERE id = 'app'").get().mqtt_password;
    const NEW = marker('new-mqtt-password');

    test('a new password is stored and is not in the answer', async () => {
      const res = await api('/api/settings', { method: 'PUT', token: adminToken, body: { mqtt_password: NEW } });
      assert.equal(res.status, 200);
      assert.equal(stored(), NEW, 'the save did not happen, so its absence from the answer proves nothing');
      assert.equal(leakIn(res.body), null, `PUT /api/settings echoed a secret: ${leakIn(res.body)}`);
    });

    test('a blank password keeps the stored one (the settings form sends blank to mean "unchanged")', async () => {
      for (const body of [{ mqtt_password: '' }, { mqtt_password: null }, { app_name: 'Nightlight' }]) {
        const res = await api('/api/settings', { method: 'PUT', token: adminToken, body });
        assert.equal(res.status, 200);
        assert.equal(stored(), NEW, `${JSON.stringify(body)} replaced the stored MQTT password`);
      }
    });

    test('GET /mqtt says a password is set, and never what it is', async () => {
      const res = await api('/api/settings/mqtt', { token: adminToken });
      assert.equal(res.status, 200);
      assert.equal(leakIn(res.body), null, `GET /api/settings/mqtt returned the password: ${leakIn(res.body)}`);
      assert.equal(res.body.mqtt_password_set, true);
      // The exact shape: a field added to this answer must be a decision, because the route it sits on
      // exists to serve a credential's neighbours.
      assert.deepEqual(Object.keys(res.body).sort(), ['mqtt_enabled', 'mqtt_host', 'mqtt_password_set', 'mqtt_port', 'mqtt_username']);
    });

    test('GET /mqtt says no password is set when none is (the flag is not a constant)', async () => {
      const keep = stored();
      db.prepare("UPDATE settings SET mqtt_password = NULL WHERE id = 'app'").run();
      try {
        const res = await api('/api/settings/mqtt', { token: adminToken });
        assert.equal(res.status, 200);
        assert.equal(res.body.mqtt_password_set, false);
      } finally {
        db.prepare("UPDATE settings SET mqtt_password = ? WHERE id = 'app'").run(keep);
      }
    });
  });

  // ntfy / Pushover / Gotify: the same contract, three routes. The secrets come back as a masked preview
  // (`*_masked`, exactly maskSecret's shape) or a bare "is it set" flag, never the value.
  const PROVIDERS = [
    {
      name: 'ntfy',
      body: (s) => ({ enabled: false, server_url: 'https://ntfy.example', topic: 'a-topic', username: 'a-user', token: s.token, password: s.password }),
      secrets: { token: 'ntfy_token', password: 'ntfy_password' },
      masked: { token: 'token_masked' },
      flags: { token: 'token_set', password: 'password_set' },
      keys: ['configured', 'enabled', 'password_set', 'server_url', 'token_masked', 'token_set', 'topic', 'username'],
    },
    {
      name: 'pushover',
      // enabled: false, so the route does not ask Pushover's API to validate the keys.
      body: (s) => ({ enabled: false, app_token: s.app_token, user_key: s.user_key, device: 'a-phone' }),
      secrets: { app_token: 'pushover_app_token', user_key: 'pushover_user_key' },
      masked: { app_token: 'app_token_masked', user_key: 'user_key_masked' },
      flags: { app_token: 'app_token_set', user_key: 'user_key_set' },
      keys: ['app_token_masked', 'app_token_set', 'configured', 'device', 'enabled', 'user_key_masked', 'user_key_set'],
    },
    {
      name: 'gotify',
      body: (s) => ({ enabled: false, server_url: 'https://gotify.example', app_token: s.app_token, priority: 5 }),
      secrets: { app_token: 'gotify_app_token' },
      masked: { app_token: 'app_token_masked' },
      flags: { app_token: 'app_token_set' },
      keys: ['app_token_masked', 'app_token_set', 'configured', 'enabled', 'priority', 'server_url'],
    },
  ];

  for (const p of PROVIDERS) {
    describe(`PUT and GET /api/${p.name}/config`, () => {
      const column = (field) => db.prepare(`SELECT ${p.secrets[field]} AS v FROM settings WHERE id = 'app'`).get().v;
      const fresh = Object.fromEntries(Object.keys(p.secrets).map((f) => [f, marker(`new-${p.name}-${f}`)]));

      const checkAnswer = (res, values, how) => {
        assert.equal(res.status, 200, `${how}: ${JSON.stringify(res.body)}`);
        assert.equal(leakIn(res.body), null, `${how} returned a secret: ${leakIn(res.body)}`);
        assert.deepEqual(Object.keys(res.body).sort(), p.keys, `${how}: the answer's shape changed`);
        for (const [field, value] of Object.entries(values)) {
          assert.equal(res.body[p.flags[field]], true, `${how}: ${p.flags[field]} should say the ${field} is set`);
          if (p.masked[field]) {
            assert.equal(res.body[p.masked[field]], `${SHOWN}${DOTS6}`, `${how}: ${p.masked[field]} is not maskSecret's 4 characters + 6 dots`);
            assert.equal(res.body[p.masked[field]], maskSecret(value));
          }
        }
      };

      test('a new secret is stored, and the answer shows only the masked preview', async () => {
        const res = await api(`/api/${p.name}/config`, { method: 'PUT', token: adminToken, body: p.body(fresh) });
        for (const field of Object.keys(p.secrets)) assert.equal(column(field), fresh[field], `${field} was not saved`);
        checkAnswer(res, fresh, `PUT /api/${p.name}/config`);
      });

      test('a blank secret keeps the stored one', async () => {
        const blanks = Object.fromEntries(Object.keys(p.secrets).map((f) => [f, '']));
        const res = await api(`/api/${p.name}/config`, { method: 'PUT', token: adminToken, body: p.body(blanks) });
        for (const field of Object.keys(p.secrets)) assert.equal(column(field), fresh[field], `a blank ${field} replaced the stored one`);
        checkAnswer(res, fresh, `PUT /api/${p.name}/config with blanks`);
      });

      test('GET shows the same masked preview', async () => {
        checkAnswer(await api(`/api/${p.name}/config`, { token: adminToken }), fresh, `GET /api/${p.name}/config`);
      });

      if (p.masked && Object.keys(p.masked).length) {
        test('a secret of eight characters or fewer is masked completely, through the route', async () => {
          // maskSecret shows four characters only when there are more than eight; four of eight would be half.
          const field = Object.keys(p.masked)[0];
          const short = { ...fresh, [field]: 'Ab3$Ab3$' };
          await api(`/api/${p.name}/config`, { method: 'PUT', token: adminToken, body: p.body(short) });
          try {
            const res = await api(`/api/${p.name}/config`, { token: adminToken });
            assert.equal(res.status, 200);
            assert.equal(res.body[p.masked[field]], '•'.repeat(8), `an 8-character ${field} was not fully masked`);
            assert.ok(!JSON.stringify(res.body).includes('Ab3$'), 'part of a short secret escaped');
          } finally {
            db.prepare(`UPDATE settings SET ${p.secrets[field]} = ? WHERE id = 'app'`).run(fresh[field]);
          }
        });
      }
    });
  }

  // ---- users: login, MFA, account management --------------------------------------------------------------

  describe('the user routes: no password hash, TOTP secret or backup-code hash, and an honest MFA flag', () => {
    const PASSWORD = 'correct-horse-battery';
    // What toPublicUser answers with. A field added to a user object must be a decision: this is the
    // object that sits next to the password hash and the TOTP secret in the row it is built from.
    const PUBLIC_USER_KEYS = ['created_at', 'first_name', 'id', 'last_name', 'mfa_enabled', 'photo', 'role', 'username'];
    let mfaSecret;
    let backupCodes;
    const userRow = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    const tokenFor = (id, username, role) => signToken({ id, username, role, sid: makeSession(db, id) });
    const realCredentials = (id) => {
      const u = userRow(id);
      return [u.password_hash, u.mfa_secret, ...JSON.parse(u.mfa_backup_codes || '[]')].filter(Boolean);
    };

    before(async () => {
      // A REAL account (real bcrypt hash, real TOTP secret, real backup-code hashes) for the routes that
      // verify them: a marker cannot be logged in with. Its real values join REAL_SECRETS, so every later
      // check, the GET sweep included, looks for their tails too.
      const mfa = await import('../src/lib/mfa.js');
      mfaSecret = mfa.generateSecret();
      const generated = generateBackupCodes();
      backupCodes = generated.codes;
      db.prepare(
        `INSERT INTO users (id, username, password_hash, role, mfa_enabled, mfa_secret, mfa_backup_codes)
         VALUES ('u-real', 'real', ?, 'caregiver', 1, ?, ?)`
      ).run(bcrypt.hashSync(PASSWORD, 4), mfaSecret, generated.hashesJson);
      REAL_SECRETS.push(...realCredentials('u-real'));
      assert.equal(REAL_SECRETS.length, 12, 'the real account should carry a hash, a secret and ten backup-code hashes');
    });

    test('login, then the second factor: neither answer carries a credential, and the user is MFA-enabled', async () => {
      const first = await api('/api/auth/login', { method: 'POST', body: { username: 'real', password: PASSWORD } });
      assert.equal(first.status, 200);
      assert.equal(first.body.mfaRequired, true);
      assert.equal(leakIn(first.body), null, `POST /login: ${leakIn(first.body)}`);
      const second = await api('/api/auth/login/mfa', { method: 'POST', body: { mfaToken: first.body.mfaToken, code: generateSync({ secret: mfaSecret }) } });
      assert.equal(second.status, 200, JSON.stringify(second.body));
      assert.equal(leakIn(second.body), null, `POST /login/mfa: ${leakIn(second.body)}`);
      assert.deepEqual(Object.keys(second.body.user).sort(), PUBLIC_USER_KEYS);
      assert.equal(second.body.user.mfa_enabled, true);
    });

    test('a backup code signs in once, and GET /me/mfa then reports MFA on with one code fewer', async () => {
      const first = await api('/api/auth/login', { method: 'POST', body: { username: 'real', password: PASSWORD } });
      const second = await api('/api/auth/login/mfa', { method: 'POST', body: { mfaToken: first.body.mfaToken, code: backupCodes[0] } });
      assert.equal(second.status, 200, JSON.stringify(second.body));
      assert.equal(leakIn(second.body), null, `POST /login/mfa (backup code): ${leakIn(second.body)}`);
      const state = await api('/api/auth/me/mfa', { token: second.body.token });
      assert.equal(state.status, 200);
      assert.equal(leakIn(state.body), null, `GET /me/mfa: ${leakIn(state.body)}`);
      assert.deepEqual(state.body, { enabled: true, backup_codes_remaining: 9, needs_reenrolment: false });
    });

    test('GET /me/mfa says OFF for an account without MFA (the flag is read, not assumed)', async () => {
      const res = await api('/api/auth/me/mfa', { token: adminToken });
      assert.equal(res.status, 200);
      assert.equal(leakIn(res.body), null, `GET /me/mfa: ${leakIn(res.body)}`);
      assert.equal(res.body.enabled, false);
      assert.equal(res.body.needs_reenrolment, false);
    });

    test('enrolment: turning MFA on answers with the one-time codes, never their stored hashes or the secret', async () => {
      makeUser(db, { id: 'u-enrol', username: 'enrol', role: 'caregiver' });
      const token = tokenFor('u-enrol', 'enrol', 'caregiver');
      // /setup returns the new secret ON PURPOSE (it is what the authenticator app scans), so its answer is
      // not checked here; what must never come back is the secret once it is ACTIVE, or any stored hash.
      const setup = await api('/api/auth/me/mfa/setup', { method: 'POST', token });
      assert.equal(setup.status, 200);
      const enable = await api('/api/auth/me/mfa/enable', { method: 'POST', token, body: { code: generateSync({ secret: setup.body.secret }) } });
      assert.equal(enable.status, 200, JSON.stringify(enable.body));
      REAL_SECRETS.push(...realCredentials('u-enrol'));
      assert.equal(leakIn(enable.body), null, `POST /me/mfa/enable: ${leakIn(enable.body)}`);
      assert.deepEqual(Object.keys(enable.body), ['backup_codes']);
      assert.equal(enable.body.backup_codes.length, 10);
      const state = await api('/api/auth/me/mfa', { token });
      assert.deepEqual(state.body, { enabled: true, backup_codes_remaining: 10, needs_reenrolment: false });
    });

    test('GET /users: every account in the public shape, with mfa_enabled matching the database', async () => {
      const res = await api('/api/auth/users', { token: adminToken });
      assert.equal(res.status, 200);
      assert.equal(leakIn(res.body), null, `GET /users: ${leakIn(res.body)}`);
      assert.ok(res.body.length >= 4);
      for (const u of res.body) {
        assert.deepEqual(Object.keys(u).sort(), PUBLIC_USER_KEYS, `${u.username}: the user shape changed`);
        assert.equal(u.mfa_enabled, userRow(u.id).mfa_enabled === 1, `${u.username}: mfa_enabled does not match the database`);
      }
      // Both values of the flag are present, so a constant cannot pass.
      assert.deepEqual([...new Set(res.body.map((u) => u.mfa_enabled))].sort(), [false, true]);
    });

    test('creating and editing accounts never answers with a hash', async () => {
      const created = await api('/api/auth/users', { method: 'POST', token: adminToken, body: { username: 'newbie', password: 'another-long-one' } });
      assert.equal(created.status, 201);
      REAL_SECRETS.push(userRow(created.body.id).password_hash);
      // The new account, not u-carer: a password reset signs that user's other sessions out, and the
      // caregiver sweep below needs u-carer's session alive.
      const edited = await api(`/api/auth/users/${created.body.id}`, { method: 'PUT', token: adminToken, body: { first_name: 'Edited', password: 'a-new-long-password' } });
      assert.equal(edited.status, 200);
      REAL_SECRETS.push(userRow(created.body.id).password_hash);
      const self = await api('/api/auth/me', { method: 'PUT', token: adminToken, body: { first_name: 'Self' } });
      assert.equal(self.status, 200);
      for (const [name, res] of [['POST /users', created], ['PUT /users/:id', edited], ['PUT /me', self]]) {
        assert.equal(leakIn(res.body), null, `${name}: ${leakIn(res.body)}`);
        assert.doesNotMatch(JSON.stringify(res.body), /\$2[aby]\$/, `${name} returned something shaped like a bcrypt hash`);
        assert.deepEqual(Object.keys(res.body).sort(), PUBLIC_USER_KEYS, `${name}: the user shape changed`);
      }
    });
  });

  // ---- every GET route --------------------------------------------------------------------------------------

  describe('every GET route in the app, as each role', () => {
    const CALLERS = { anonymous: () => undefined, caregiver: () => caregiverToken, admin: () => adminToken };
    // Positive controls: routes that DO read the planted rows and must answer this caller with 200. If one
    // stopped answering (a dead token, a broken mount), the sweep could pass because nothing was read.
    const MUST_ANSWER = {
      anonymous: ['GET /api/settings', 'GET /api/auth/status'],
      caregiver: ['GET /api/settings', 'GET /api/auth/me', 'GET /api/auth/me/mfa', 'GET /api/cameras', 'GET /api/auth/sessions'],
      admin: [
        'GET /api/settings', 'GET /api/settings/mqtt', 'GET /api/ntfy/config', 'GET /api/pushover/config',
        'GET /api/gotify/config', 'GET /api/auth/users', 'GET /api/auth/me', 'GET /api/auth/me/mfa',
        'GET /api/cameras', 'GET /api/diagnostics', 'GET /api/logs', 'GET /api/auth/sessions/all',
      ],
    };

    for (const [who, token] of Object.entries(CALLERS)) {
      test(`${who}: no GET route returns any part of a planted secret`, async (t) => {
        const leaks = [];
        const statuses = {};
        for (const r of GET_ROUTES) {
          const res = await api(instantiate(r.key.split(' ')[1]), { token: token() });
          statuses[r.key] = res.status;
          const leak = leakIn(res.body);
          if (leak) leaks.push(`${r.key} (${res.status}): ...${leak}...`);
        }
        assert.deepEqual(leaks, [], `\n${leaks.join('\n')}`);
        const silent = MUST_ANSWER[who].filter((k) => statuses[k] !== 200);
        assert.deepEqual(silent, [], `these routes did not answer ${who} with 200, so the sweep proved nothing about them: ${silent.map((k) => `${k}=${statuses[k]}`).join(', ')}`);
        t.diagnostic(`${GET_ROUTES.length} GET routes asked as ${who}; ${Object.values(statuses).filter((s) => s === 200).length} answered 200`);
      });
    }
  });
});

describe('maskSecret: enough to recognise a saved secret, never enough to use it', () => {
  test('nothing saved is an empty string, not a row of dots', () => {
    for (const v of ['', null, undefined, '   ']) assert.equal(maskSecret(v), '', JSON.stringify(v));
  });

  test('eight characters or fewer are masked completely, length kept as the only hint', () => {
    // Four characters of an eight-character token would be half of it.
    assert.equal(maskSecret('a'), '•');
    assert.equal(maskSecret('abcdefgh'), '•'.repeat(8));
  });

  test('longer secrets show their first four characters and a FIXED six dots', () => {
    assert.equal(maskSecret('abcdefghi'), `abcd${DOTS6}`);
    // Six dots whatever the length: the preview must not tell an observer how long the secret is.
    assert.equal(maskSecret('x'.repeat(64)), `xxxx${DOTS6}`);
    assert.equal(maskSecret(`abcd${'z'.repeat(40)}`).length, 10);
  });

  test('surrounding whitespace is not part of the secret (a pasted token often carries a newline)', () => {
    assert.equal(maskSecret('  abcdefghi\n'), `abcd${DOTS6}`);
    assert.equal(maskSecret(' abcdefgh '), '•'.repeat(8));
  });
});
