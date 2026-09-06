// The wake-clip settings: round-trip, bounds, and admin-only.
//
// The round-trip test earns its place beyond the obvious: settings are saved by one long hand-written
// UPDATE with positional placeholders, so adding a column means adding a `= ?` AND a bind argument in
// the matching position. Get that wrong and better-sqlite3 throws at runtime, on the save path, for
// every setting — not just the new ones. A regex can't check that; a real PUT can.
import { test, before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, signToken, mountRouter, call,
} from './helpers/harness.js';

useTempDataDir();

const { default: db } = await import('../src/db.js');
const { default: settingsRouter } = await import('../src/routes/settings.js');

let server;
let adminToken;
let caregiverToken;

const get = () => db.prepare('SELECT * FROM settings WHERE id = ?').get('app');
const put = (body, token = adminToken) =>
  call(`${server.url}/api/settings`, { method: 'PUT', token, body });

before(async () => {
  server = await mountRouter('/api/settings', settingsRouter);
});

after(async () => {
  await server?.close();
  db.close();
  cleanupTempDataDirs();
});

beforeEach(() => {
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM users').run();
  const admin = makeUser(db, { id: 'u-a', username: 'admin', role: 'admin' });
  const care = makeUser(db, { id: 'u-c', username: 'nanny', role: 'caregiver' });
  adminToken = signToken({ id: admin.id, username: admin.username, role: 'admin', sid: makeSession(db, admin.id) });
  caregiverToken = signToken({ id: care.id, username: care.username, role: 'caregiver', sid: makeSession(db, care.id) });
  db.prepare(
    'UPDATE settings SET wake_clips_enabled = 1, wake_clip_seconds = 30, wake_clip_retention_days = 14 WHERE id = ?'
  ).run('app');
});

describe('defaults', () => {
  // ⚠️ THESE ARE THE SCHEMA'S DEFAULTS, READ FROM THE SCHEMA — not from the row the `beforeEach` above
  // writes. That distinction is the whole point of this block, and getting it wrong is one of the four
  // trap tests named in issue #263: this used to assert `1 / 30 / 14` against the settings row, one
  // line after its own fixture had written exactly `1 / 30 / 14` with an explicit UPDATE. It tested
  // the fixture. Confirmed at the time by changing the db.js defaults to `0 / 7 / 3` with the suite
  // still green — a fresh install would have shipped with three-day retention and nothing would have
  // noticed.
  //
  // Two independent readings, because each catches something the other cannot:
  //   * PRAGMA table_info reports the DEFAULT clause as written, which is what a column added by a
  //     later ALTER TABLE actually carries.
  //   * inserting a bare row proves the default is what a real install RECEIVES — it would catch a
  //     migration that re-created the table, or a trigger, or an INSERT elsewhere that supplies its
  //     own values.
  const DEFAULTS = { wake_clips_enabled: 1, wake_clip_seconds: 30, wake_clip_retention_days: 14 };

  test('the schema declares them: on, 30s, kept 14 days', () => {
    const cols = Object.fromEntries(
      db.prepare('PRAGMA table_info(settings)').all().map((c) => [c.name, c.dflt_value])
    );
    for (const [name, expected] of Object.entries(DEFAULTS)) {
      assert.equal(Number(cols[name]), expected, `settings.${name} declares DEFAULT ${cols[name]}, expected ${expected}`);
    }
  });

  test('and a brand-new settings row receives them', () => {
    // `id TEXT PRIMARY KEY DEFAULT 'app'` — so a second row with a different id is legal and gives a
    // clean read of what every column defaults to, without touching the 'app' row the rest of the
    // file depends on.
    db.prepare("INSERT INTO settings (id) VALUES ('fresh-install-probe')").run();
    try {
      const fresh = db.prepare('SELECT * FROM settings WHERE id = ?').get('fresh-install-probe');
      for (const [name, expected] of Object.entries(DEFAULTS)) {
        assert.equal(fresh[name], expected, `a fresh install gets ${name} = ${fresh[name]}, expected ${expected}`);
      }
    } finally {
      db.prepare("DELETE FROM settings WHERE id = 'fresh-install-probe'").run();
    }
  });

  test('the fixture does not decide the answer — it writes something else first', () => {
    // A tripwire on the two tests above. If someone later moves the `beforeEach` UPDATE to also touch
    // a fresh row, or replaces PRAGMA with a row read, this fails: the values below are deliberately
    // NOT the defaults, so any reading that comes from the fixture rather than the schema is wrong.
    db.prepare(
      'UPDATE settings SET wake_clips_enabled = 0, wake_clip_seconds = 99, wake_clip_retention_days = 111 WHERE id = ?'
    ).run('app');
    db.prepare("INSERT INTO settings (id) VALUES ('fresh-install-probe-2')").run();
    try {
      const fresh = db.prepare('SELECT * FROM settings WHERE id = ?').get('fresh-install-probe-2');
      assert.equal(fresh.wake_clip_seconds, 30, 'the new row inherited the app row, so these tests read the fixture');
      assert.equal(fresh.wake_clips_enabled, 1);
      assert.equal(fresh.wake_clip_retention_days, 14);
    } finally {
      db.prepare("DELETE FROM settings WHERE id = 'fresh-install-probe-2'").run();
    }
  });
});

describe('saving', () => {
  test('the three values round-trip', async () => {
    const r = await put({ wake_clips_enabled: false, wake_clip_seconds: 45, wake_clip_retention_days: 7 });
    assert.equal(r.status, 200, `expected 200, got ${r.status} ${JSON.stringify(r.body)}`);
    const s = get();
    assert.equal(s.wake_clips_enabled, 0);
    assert.equal(s.wake_clip_seconds, 45);
    assert.equal(s.wake_clip_retention_days, 7);
  });

  test('saving unrelated settings leaves the wake-clip ones alone', async () => {
    // The positional-UPDATE hazard in reverse: a mis-ordered bind would quietly overwrite these with
    // some other field's value.
    await put({ wake_clip_seconds: 45 });
    const r = await put({ app_name: 'Casa' });
    assert.equal(r.status, 200);
    const s = get();
    assert.equal(s.app_name, 'Casa');
    assert.equal(s.wake_clip_seconds, 45, 'an unrelated save must not disturb wake-clip settings');
    assert.equal(s.wake_clips_enabled, 1);
  });

  test('★ a General-page save leaves the ON-DEMAND settings alone', async () => {
    // The front end relies on this, so it is worth its own test rather than being assumed from the
    // wake-clip case above. The General settings screen used to post ondemand_enabled,
    // ondemand_pre_roll_s and ondemand_max_duration_s — left behind when on-demand recording moved to
    // its own page — which meant a stale General form could silently revert a Record-button toggle
    // somebody had just made elsewhere. Those keys were removed from its payload, and that removal is
    // only safe because this route falls back to each field's STORED value when a key is absent.
    // Take that fallback away and the fix turns into the bug it replaced, with the setting reset on
    // every visit to General.
    await put({ ondemand_enabled: false, ondemand_pre_roll_s: 12, ondemand_max_duration_s: 90 });

    // Exactly what the General screen sends now: its own seven fields, none of them on-demand.
    const r = await put({ app_name: 'Casa', timezone: 'Australia/Melbourne', temp_unit: 'F' });
    assert.equal(r.status, 200);

    const s = get();
    assert.equal(s.app_name, 'Casa');
    assert.equal(s.ondemand_enabled, 0, 'a save that omits the Record-button switch must not turn it back on');
    assert.equal(s.ondemand_pre_roll_s, 12, 'nor reset the pre-roll');
    assert.equal(s.ondemand_max_duration_s, 90, 'nor the auto-stop');
  });

  test('0 days is accepted and means keep forever', async () => {
    const r = await put({ wake_clip_retention_days: 0 });
    assert.equal(r.status, 200);
    assert.equal(get().wake_clip_retention_days, 0);
  });
});

describe('bounds', () => {
  test('a clip shorter than 5s is refused', async () => {
    const r = await put({ wake_clip_seconds: 2 });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /between 5 and 120 seconds/);
    assert.equal(get().wake_clip_seconds, 30, 'nothing is saved when validation fails');
  });

  test('a clip longer than 120s is refused — the point is a BOUNDED clip', async () => {
    // Wakes average ~19 minutes; capturing them end to end would be ~1.1 GiB/night.
    const r = await put({ wake_clip_seconds: 1200 });
    assert.equal(r.status, 400);
    assert.equal(get().wake_clip_seconds, 30);
  });

  test('a non-numeric length is refused rather than stored as NaN', async () => {
    const r = await put({ wake_clip_seconds: 'thirty' });
    assert.equal(r.status, 400);
    assert.equal(get().wake_clip_seconds, 30);
  });

  test('retention over a year is refused', async () => {
    const r = await put({ wake_clip_retention_days: 400 });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /0 and 365 days/);
  });

  test('negative retention is refused', async () => {
    assert.equal((await put({ wake_clip_retention_days: -1 })).status, 400);
  });

  test('the bounds are inclusive at both ends', async () => {
    assert.equal((await put({ wake_clip_seconds: 5 })).status, 200);
    assert.equal(get().wake_clip_seconds, 5);
    assert.equal((await put({ wake_clip_seconds: 120 })).status, 200);
    assert.equal(get().wake_clip_seconds, 120);
    assert.equal((await put({ wake_clip_retention_days: 365 })).status, 200);
  });
});

describe('permissions', () => {
  test('a caregiver cannot change recording settings', async () => {
    const r = await put({ wake_clips_enabled: false }, caregiverToken);
    assert.equal(r.status, 403);
    assert.equal(get().wake_clips_enabled, 1, 'unchanged');
  });

  test('an unauthenticated request cannot either', async () => {
    const r = await call(`${server.url}/api/settings`, { method: 'PUT', body: { wake_clips_enabled: false } });
    assert.equal(r.status, 401);
    assert.equal(get().wake_clips_enabled, 1);
  });
});
