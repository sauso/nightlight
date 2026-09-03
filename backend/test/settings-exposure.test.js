// What GET /settings is allowed to tell you, and who has to be signed in to hear it.
//
// This route is deliberately reachable with no token — the login screen needs the app name, colours
// and font before anyone can sign in — so it is the one place in the API where a new database column
// becomes world-readable by default. It shipped as a deny-list naming the five mqtt_* columns, and
// when ntfy/Gotify/Pushover later added token columns to the same table those were served to
// unauthenticated callers (GHSA-qffc-965c-x74m).
//
// So these tests are written against the *shape of the mistake*, not against the five fields that
// happened to leak: the first test asserts the response is an allow-list by checking that NOTHING
// outside the known-public set comes back, which fails for any future column too. A test that only
// named the five known tokens would go green again the next time someone adds a sixth.
import { test, before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, signToken, mountRouter, call,
} from './helpers/harness.js';

useTempDataDir();

const { default: db } = await import('../src/db.js');
const { default: settingsRouter } = await import('../src/routes/settings.js');

let server;
// `token: undefined` sends no Authorization header at all — that is the unauthenticated case.
const get = (token) => call(`${server.url}/api/settings`, { token });

before(async () => {
  server = await mountRouter('/api/settings', settingsRouter);
});

// Every field the login screen legitimately needs. Anything else in an unauthenticated response is a
// leak by definition, whether or not it happens to be a credential today.
const PUBLIC = [
  'app_name', 'accent_color', 'live_color', 'offline_color', 'font_choice', 'temp_unit', 'timezone',
];

// Named individually so a failure says which credential escaped, rather than just "extra key".
const SECRETS = [
  'mqtt_host', 'mqtt_port', 'mqtt_username', 'mqtt_password',
  'pushover_app_token', 'pushover_user_key',
  'ntfy_token', 'ntfy_password', 'ntfy_username', 'ntfy_topic', 'ntfy_server_url',
  'gotify_app_token', 'gotify_server_url',
];

let adminToken;
let caregiverToken;

beforeEach(() => {
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM users').run();
  const admin = makeUser(db, { id: 'u-a', username: 'admin', role: 'admin' });
  const care = makeUser(db, { id: 'u-c', username: 'nanny', role: 'caregiver' });
  adminToken = signToken({ id: admin.id, username: admin.username, role: 'admin', sid: makeSession(db, admin.id) });
  caregiverToken = signToken({ id: care.id, username: care.username, role: 'caregiver', sid: makeSession(db, care.id) });

  // Put a recognisable value in every secret column, so a leak is unambiguous rather than a null that
  // happens to look harmless on a fresh database. The original bug was invisible precisely because an
  // unconfigured install leaks empty strings.
  db.prepare(
    `UPDATE settings SET mqtt_host = ?, mqtt_username = ?, mqtt_password = ?,
       pushover_app_token = ?, pushover_user_key = ?,
       ntfy_token = ?, ntfy_password = ?, ntfy_username = ?, ntfy_topic = ?,
       gotify_app_token = ? WHERE id = 'app'`
  ).run(
    'broker.example', 'mqttuser', 'LEAK-mqtt-password',
    'LEAK-pushover-app-token', 'LEAK-pushover-user-key',
    'LEAK-ntfy-token', 'LEAK-ntfy-password', 'ntfyuser', 'LEAK-ntfy-topic',
    'LEAK-gotify-app-token'
  );
});

after(async () => {
  await server?.close();
  db.close();
  cleanupTempDataDirs();
});

describe('GET /settings unauthenticated', () => {
  test('returns nothing beyond the public presentation fields', async () => {
    const r = await get();
    assert.equal(r.status, 200);
    const extra = Object.keys(r.body).filter((k) => !PUBLIC.includes(k));
    assert.deepEqual(
      extra, [],
      `unauthenticated response exposed ${extra.length} field(s) outside the public set: ${extra.join(', ')}`
    );
  });

  test('leaks no provider credential', async () => {
    const r = await get();
    for (const field of SECRETS) {
      assert.equal(r.body[field], undefined, `${field} was exposed to an unauthenticated caller`);
    }
    // Belt and braces: no value anywhere in the payload carries a planted marker, which also catches a
    // secret re-exposed under a renamed key.
    assert.ok(
      !JSON.stringify(r.body).includes('LEAK-'),
      `a planted secret value appeared in the response: ${JSON.stringify(r.body)}`
    );
  });

  test('still serves what the login screen needs', async () => {
    const r = await get();
    for (const field of PUBLIC) {
      assert.ok(field in r.body, `${field} is required by the login screen but was missing`);
    }
  });

  test('an invalid or garbage token is treated as unauthenticated, not as an error', async () => {
    const r = await get('not-a-jwt');
    assert.equal(r.status, 200, 'the login screen must still render for a client holding a stale token');
    assert.equal(r.body.pushover_app_token, undefined);
    assert.equal(r.body.ptz_step, undefined, 'a bad token must not be upgraded to admin');
  });
});

describe('GET /settings role check reads own properties only', () => {
  // jwt.verify hands back a JSON.parse'd object, so `req.user.role` would otherwise resolve through
  // the prototype chain. No way to set Object.prototype.role from a request was found (six query-string
  // shapes, four header shapes, and a JWT with a literal "__proto__" key all failed), so this is
  // defence in depth rather than a demonstrated exploit — but the failure direction is widening the
  // response, which is the one that must not happen. Media tokens are rejected before this point;
  // a *session* token simply minted without a role claim is the shape that reaches it.
  test('a token with no role claim is not admin, even if Object.prototype.role says otherwise', async () => {
    const sid = makeSession(db, 'u-c');
    const noRoleToken = signToken({ id: 'u-c', username: 'nanny', sid });
    Object.prototype.role = 'admin'; // eslint-disable-line no-extend-native
    try {
      const r = await get(noRoleToken);
      assert.equal(r.status, 200);
      assert.equal(
        r.body.ptz_step, undefined,
        'a token carrying no role claim was treated as admin via the prototype chain'
      );
      const extra = Object.keys(r.body).filter((k) => !PUBLIC.includes(k));
      assert.deepEqual(extra, [], `prototype-chain read widened the response: ${extra.join(', ')}`);
    } finally {
      delete Object.prototype.role;
    }
  });
});

describe('GET /settings only widens for the admin role specifically', () => {
  // Mutation testing found that `role === 'admin'` could be rewritten as `role !== 'caregiver'` and
  // every one of the other tests still passed, because the fixtures only ever use 'admin', 'caregiver'
  // or no role claim at all. Nothing pinned the case in between. A role this build does not recognise
  // — an older or newer token, a value someone adds later — must fail CLOSED.
  test('an unrecognised role is not treated as admin', async () => {
    const viewer = makeUser(db, { id: 'u-v', username: 'viewer', role: 'caregiver' });
    const token = signToken({ id: viewer.id, username: viewer.username, role: 'viewer', sid: makeSession(db, viewer.id) });
    const r = await get(token);
    assert.equal(r.status, 200);
    assert.equal(r.body.ptz_step, undefined, "role 'viewer' was treated as admin");
    const extra = Object.keys(r.body).filter((k) => !PUBLIC.includes(k));
    assert.deepEqual(extra, [], `an unrecognised role widened the response: ${extra.join(', ')}`);
  });
});

describe('GET /settings ignores a token in the query string', () => {
  // A full session token must never be accepted from a query string — query strings reach reverse-proxy
  // access logs, browser history and Referer headers, which is why requireAuthQueryOrHeader accepts
  // only media-scoped tokens there. verifyToken pins the media half (mutating optionalAuth to demand
  // purpose:'media' is killed), but nothing pinned this: teaching optionalAuth to read req.query.token
  // survived all 398 tests while returning the full admin set for a token sitting in a URL.
  test('an admin session token in ?token= does not widen the response', async () => {
    const r = await call(`${server.url}/api/settings?token=${encodeURIComponent(adminToken)}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.ptz_step, undefined, 'a session token in the query string was honoured');
    const extra = Object.keys(r.body).filter((k) => !PUBLIC.includes(k));
    assert.deepEqual(extra, [], `a query-string token widened the response: ${extra.join(', ')}`);
  });
});

describe('GET /settings as a caregiver', () => {
  test('gets the public fields and no admin config', async () => {
    const r = await get(caregiverToken);
    assert.equal(r.status, 200);
    const extra = Object.keys(r.body).filter((k) => !PUBLIC.includes(k));
    assert.deepEqual(extra, [], `caregiver saw admin-only field(s): ${extra.join(', ')}`);
  });

  test('leaks no provider credential', async () => {
    const r = await get(caregiverToken);
    assert.ok(!JSON.stringify(r.body).includes('LEAK-'), 'a planted secret reached a caregiver');
  });
});

describe('GET /settings as an admin', () => {
  // The admin settings forms seed their state directly from this response, so a field dropped here is
  // a blank input on a settings page. These are the fields SettingsGeneral / SettingsCamera /
  // SettingsRecording actually bind — keep this list in step with them.
  const FORM_FIELDS = [
    'camera_offline_alert_enabled', 'camera_offline_alert_minutes',
    'clip_pre_roll_s', 'clip_post_roll_s', 'clip_retention_days', 'clip_retention_max_gb',
    'ondemand_enabled', 'ondemand_pre_roll_s', 'ondemand_max_duration_s',
    'ptz_step',
    'wake_clips_enabled', 'wake_clip_seconds', 'wake_clip_retention_days',
  ];

  test('gets every field the settings forms bind', async () => {
    const r = await get(adminToken);
    assert.equal(r.status, 200);
    for (const field of [...PUBLIC, ...FORM_FIELDS]) {
      assert.ok(field in r.body, `${field} is bound by an admin settings form but was missing`);
    }
  });

  test('still gets no provider credential — those have their own masked routes', async () => {
    const r = await get(adminToken);
    for (const field of SECRETS) {
      assert.equal(r.body[field], undefined, `${field} was exposed on the general settings route`);
    }
    assert.ok(!JSON.stringify(r.body).includes('LEAK-'), 'a planted secret reached the admin settings route');
  });
});
