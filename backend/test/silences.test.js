// #552 (PR3): the long-silence notice. When one camera's alerts are kept silenced for longer than the admins
// allow (Settings > Camera controls > Long silence alerts), the admins are told once. lib/silences.js decides;
// lib/cameraStatusAlert.js sends (its fan-out and recipients are pinned in long-silence-notice.test.js and
// push.test.js).
//
// The claims this file holds (the PR body names them):
//   C1  back-to-back silences over the threshold notify exactly ONCE per silence episode (renewals within the
//       30-minute rejoin gap are one episode; a new episode after the gap can notify again);
//   C2  never when the setting is off, never at or below the threshold (strictly more than);
//   C3  the notice cannot fail or undo a silence: a throwing notice, or a settings read that throws, still
//       answers 200 with the camera muted and its history row written; an un-mute never sends one;
//   C5  defaults (on, 60), range (1-719), admin-only exposure and the settings round trip, plus the upgrade;
//   C6  un-mute then re-mute within the gap continues the count, so it cannot be reset that way.
// Also pinned: the episode is written in the SAME transaction as the mute (a failed episode write applies
// nothing; a failed history write leaves the episode as it was), a no-op un-mute touches no episode, and
// deleting a camera deletes its episode.
//
// The timing logic is replayed with EXPLICIT times (noteSilence takes `now`; nothing here reads the clock), so the
// gap and threshold boundaries are exact to the millisecond. The route tests use the real clock, with silences
// long enough that a few milliseconds cannot move a result.
//
// Faked: lib/cameraStatusAlert.js (not in test:core's coverage include list, so mock.module is safe), to see
// exactly what the notice was asked to send, and to make it throw. NOT covered (negative space): delivery through
// any real channel, and the 30-minute gap itself, which no house's data has measured (docs/camera-controls.md).
import { test, describe, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, makeCamera, signToken, mountRouter, call,
} from './helpers/harness.js';

useTempDataDir();

// What the faked notice does, set per test. Default: record the call.
const notices = [];
const fake = { notify: (...args) => { notices.push(args); } };
mock.module('../src/lib/cameraStatusAlert.js', {
  exports: {
    notifyLongSilence: (...args) => fake.notify(...args),
    notifyCameraOffline: () => {},
    notifyCameraRecovered: () => {},
    formatSilenceLength: (m) => `${m} min`,
  },
});

const { default: db } = await import('../src/db.js');
const { noteSilence, claimLongSilenceNotice, sendLongSilenceNotice, REJOIN_GAP_MS } = await import('../src/lib/silences.js');
const { default: camerasRouter } = await import('../src/routes/cameras.js');
const { default: settingsRouter } = await import('../src/routes/settings.js');
const { logger } = await import('../src/lib/logger.js');

const MIN = 60_000;
// A fixed instant, far from now, so nothing here can depend on the real clock.
const T0 = 1_900_000_000_000;
const CAM = 'cam-silence';
const CAM_ROW = { id: CAM, name: 'Silence Cam' };
const ACTOR = { user_id: 'u-carer', username: 'carer-login' };

let cams;
let settings;
let adminToken;
let carerToken;

const episode = (id = CAM) => db.prepare('SELECT started_at, ended_at, notified FROM camera_silences WHERE camera_id = ?').get(id);
const camRow = () => db.prepare('SELECT alerts_snoozed_until, alerts_snoozed_by FROM cameras WHERE id = ?').get(CAM);
const historyRows = () => db.prepare('SELECT * FROM camera_events ORDER BY id').all();
const setAlert = (enabled, minutes) =>
  db.prepare("UPDATE settings SET snooze_alert_enabled = ?, snooze_alert_minutes = ? WHERE id = 'app'").run(enabled, minutes);
const settingsRow = () => db.prepare("SELECT snooze_alert_enabled, snooze_alert_minutes FROM settings WHERE id = 'app'").get();

// One silence of `mins` minutes set at time `t`, exactly as the route does it: the episode inside the transaction,
// then the notice after the commit. Returns whether a notice was sent.
function mute(t, mins, actor = ACTOR) {
  noteSilence(CAM, t, t + mins * MIN);
  return sendLongSilenceNotice(CAM_ROW, actor);
}
const unmute = (t) => noteSilence(CAM, t, null);
const snooze = (token, minutes) => call(`${cams.url}/api/cameras/${CAM}/snooze`, { method: 'POST', token, body: { minutes } });

before(async () => {
  cams = await mountRouter('/api/cameras', camerasRouter);
  settings = await mountRouter('/api/settings', settingsRouter);
  makeUser(db, { id: 'u-admin', username: 'admin-login', role: 'admin' });
  makeUser(db, { id: 'u-carer', username: 'carer-login', role: 'caregiver' });
  adminToken = signToken({ id: 'u-admin', username: 'admin-login', role: 'admin', sid: makeSession(db, 'u-admin') });
  carerToken = signToken({ id: 'u-carer', username: 'carer-login', role: 'caregiver', sid: makeSession(db, 'u-carer') });
  // A successful PUT /settings refreshes the MQTT connection; off is the state that cannot reach a network.
  db.prepare("UPDATE settings SET mqtt_enabled = 0 WHERE id = 'app'").run();
});

beforeEach(() => {
  notices.length = 0;
  fake.notify = (...args) => { notices.push(args); };
  db.prepare('DROP TRIGGER IF EXISTS refuse_history').run();
  db.prepare('DROP TRIGGER IF EXISTS refuse_episode_insert').run();
  db.prepare('DROP TRIGGER IF EXISTS refuse_episode_update').run();
  db.prepare('DELETE FROM camera_events').run();
  db.prepare('DELETE FROM cameras').run(); // cascades to camera_silences
  db.prepare('DELETE FROM camera_silences').run();
  makeCamera(db, { id: CAM, name: CAM_ROW.name, extra: { disabled: 1 } });
  setAlert(1, 60); // the shipped defaults
});

after(async () => {
  await cams?.close();
  await settings?.close();
  db.close();
  cleanupTempDataDirs();
});

// --- C1: one notice per silence episode ---------------------------------------------------------------------

describe('C1: back-to-back silences over the threshold notify once per silence', () => {
  test('★ 60 + 60, the second set 5 minutes after the first ran out: one 125-minute silence, one notice', () => {
    assert.equal(mute(T0, 60), false, 'one silence of exactly the threshold does not notify');
    assert.deepEqual(episode(), { started_at: T0, ended_at: T0 + 60 * MIN, notified: 0 });
    assert.equal(notices.length, 0);
    // The tile hides its buttons while muted, so this is how a renewal from the tile arrives: after it ran out.
    assert.equal(mute(T0 + 65 * MIN, 60), true);
    assert.deepEqual(episode(), { started_at: T0, ended_at: T0 + 125 * MIN, notified: 1 }, 'one episode, from the first start');
    assert.deepEqual(notices, [[CAM_ROW, 125, 'u-carer']],
      'one notice: the camera, its length in minutes, and whose devices to leave out (no username: PR #664 review)');
  });

  test('★ a third renewal in the same silence sends no second notice', () => {
    mute(T0, 60);
    mute(T0 + 65 * MIN, 60);
    assert.equal(mute(T0 + 130 * MIN, 60), false);
    assert.equal(mute(T0 + 195 * MIN, 720), false, 'not even a 12-hour one');
    assert.equal(notices.length, 1);
    assert.deepEqual(episode(), { started_at: T0, ended_at: T0 + 915 * MIN, notified: 1 });
  });

  test('a renewal WHILE still muted continues the silence too (another device, the API)', () => {
    mute(T0, 60);
    assert.equal(mute(T0 + 30 * MIN, 60), true);
    assert.deepEqual(episode(), { started_at: T0, ended_at: T0 + 90 * MIN, notified: 1 });
  });

  test('★ a renewal at EXACTLY the gap after the end continues; one millisecond later starts a new silence', () => {
    assert.equal(REJOIN_GAP_MS, 30 * MIN, 'the documented gap (docs/camera-controls.md)');
    mute(T0, 30);
    mute(T0 + 30 * MIN + REJOIN_GAP_MS, 30);
    assert.deepEqual(episode(), { started_at: T0, ended_at: T0 + 90 * MIN, notified: 1 }, 'inclusive: exactly the gap is the same silence');
    assert.equal(notices.length, 1);

    db.prepare('DELETE FROM camera_silences').run();
    notices.length = 0;
    mute(T0, 30);
    const late = T0 + 30 * MIN + REJOIN_GAP_MS + 1;
    assert.equal(mute(late, 30), false);
    assert.deepEqual(episode(), { started_at: late, ended_at: late + 30 * MIN, notified: 0 }, 'a new silence, counted from its own start');
  });

  test('★ a new silence after the gap can notify again: once per silence, not once ever', () => {
    mute(T0, 60);
    mute(T0 + 61 * MIN, 60); // notified
    const later = T0 + 121 * MIN + REJOIN_GAP_MS + 1;
    assert.equal(mute(later, 60), false, 'a fresh silence starts un-notified, and 60 is not over 60');
    assert.equal(episode().notified, 0);
    assert.equal(mute(later + 61 * MIN, 60), true);
    assert.equal(notices.length, 2);
  });

  test('two claims of the same long silence: only the first sends (the conditional UPDATE)', () => {
    noteSilence(CAM, T0, T0 + 120 * MIN);
    assert.equal(claimLongSilenceNotice(CAM), 120 * MIN);
    assert.equal(claimLongSilenceNotice(CAM), null, 'already claimed');
    assert.equal(claimLongSilenceNotice('cam-with-no-silence'), null, 'a camera with no silence has nothing to claim');
  });

  test('a shorter silence set over a longer one replaces it, as the mute does', () => {
    mute(T0, 60);
    mute(T0 + 10 * MIN, 15);
    assert.deepEqual(episode(), { started_at: T0, ended_at: T0 + 25 * MIN, notified: 0 });
  });

  test('the length is rounded UP to whole minutes, so it never reads as at or below the threshold', () => {
    noteSilence(CAM, T0, T0 + 60 * MIN + 1);
    assert.equal(sendLongSilenceNotice(CAM_ROW, ACTOR), true);
    assert.equal(notices[0][1], 61);
  });

  test('an actor with no id is passed on as null, not invented', () => {
    noteSilence(CAM, T0, T0 + 120 * MIN);
    sendLongSilenceNotice(CAM_ROW, { user_id: null, username: null });
    assert.deepEqual(notices[0].slice(2), [null]);
  });

  test('★ the clock set BACK before the silence began: the next mute starts a new silence, never a negative one', () => {
    // PR #664 review, the exact timeline it reproduced: a 60-minute silence set at T0, then (the server clock having
    // been set back by just over an hour) a mute at T0 - 61 min. Continuing would store an end BEFORE the start, a
    // negative length that never notifies however long the renewals go on.
    assert.equal(T0, 1_900_000_000_000);
    mute(T0, 60);
    const back = 1_899_996_340_000; // T0 - 61 minutes
    assert.equal(mute(back, 60), false);
    assert.deepEqual(episode(), { started_at: back, ended_at: back + 60 * MIN, notified: 0 }, 'a new silence from the earlier time');
    assert.ok(episode().ended_at > episode().started_at, 'never a negative length');
    assert.equal(mute(back + 65 * MIN, 60), true, 'and it adds up and notifies as usual from there');
    assert.deepEqual(notices.map((n) => n[1]), [125]);
  });
});

// --- C2: off means never, and the threshold is strict --------------------------------------------------------

describe('C2: never when off, never at or below the threshold', () => {
  test('★ exactly the threshold sends nothing; one millisecond more sends one notice', () => {
    noteSilence(CAM, T0, T0 + 60 * MIN);
    assert.equal(sendLongSilenceNotice(CAM_ROW, ACTOR), false);
    assert.equal(episode().notified, 0, 'and nothing was claimed');
    noteSilence(CAM, T0 + 60 * MIN, T0 + 60 * MIN + 1); // a renewal at the end: 60 min + 1 ms
    assert.equal(sendLongSilenceNotice(CAM_ROW, ACTOR), true);
    assert.equal(notices.length, 1);
  });

  test('★ the threshold is the SETTING, read at each silence', () => {
    setAlert(1, 30);
    assert.equal(mute(T0, 30), false);
    db.prepare('DELETE FROM camera_silences').run();
    assert.equal(mute(T0, 31), true, '31 minutes is over a 30-minute threshold');
    db.prepare('DELETE FROM camera_silences').run();
    setAlert(1, 719);
    assert.equal(mute(T0, 719), false);
    assert.equal(mute(T0 + 719 * MIN, 1), true, 'the top of the range: 720 minutes in a row notifies');
  });

  test('★ off: no notice, however long, and nothing is claimed; turned on, the next renewal notifies', () => {
    setAlert(0, 60);
    assert.equal(mute(T0, 720), false);
    assert.equal(mute(T0 + 720 * MIN, 720), false);
    assert.equal(notices.length, 0);
    assert.equal(episode().notified, 0, 'still un-notified, so turning it on can still tell the admins');
    setAlert(1, 60);
    assert.equal(mute(T0 + 1440 * MIN, 60), true, 'read live: no restart needed');
  });

  test('no settings row at all: no notice, no error', () => {
    const saved = db.prepare("SELECT * FROM settings WHERE id = 'app'").get();
    db.prepare("DELETE FROM settings WHERE id = 'app'").run();
    try {
      assert.equal(mute(T0, 720), false);
    } finally {
      const cols = Object.keys(saved);
      db.prepare(`INSERT INTO settings (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})`).run(saved);
    }
  });
});

// --- C6: un-mute + re-mute cannot reset the count --------------------------------------------------------------

describe('C6: un-muting does not reset the count', () => {
  test('★ un-mute, then re-mute a minute later: the same silence, counted from its first start', () => {
    mute(T0, 60);
    unmute(T0 + 10 * MIN);
    assert.deepEqual(episode(), { started_at: T0, ended_at: T0 + 10 * MIN, notified: 0 }, 'the un-mute brought the end forward');
    assert.equal(mute(T0 + 11 * MIN, 60), true, '71 minutes, on and off (the one-minute gap counts)');
    assert.deepEqual(notices.map((n) => n[1]), [71]);
  });

  test('★ un-mute, then re-mute after the gap: a new silence (the un-mute really ended it early)', () => {
    mute(T0, 60);
    unmute(T0 + 10 * MIN);
    const late = T0 + 10 * MIN + REJOIN_GAP_MS + 1;
    assert.equal(mute(late, 60), false);
    assert.deepEqual(episode(), { started_at: late, ended_at: late + 60 * MIN, notified: 0 });
  });

  test('★ an un-mute never moves the end LATER, and writes nothing for a silence that already ended', () => {
    mute(T0, 15);
    unmute(T0 + 20 * MIN); // the silence ran out 5 minutes ago
    assert.deepEqual(episode(), { started_at: T0, ended_at: T0 + 15 * MIN, notified: 0 });
    unmute(T0 + 15 * MIN); // exactly at its end
    assert.deepEqual(episode(), { started_at: T0, ended_at: T0 + 15 * MIN, notified: 0 });
  });

  test('an un-mute of a camera with no silence creates nothing', () => {
    unmute(T0);
    assert.equal(episode(), undefined);
  });
});

// --- through the real route -------------------------------------------------------------------------------------

describe('through POST /api/cameras/:id/snooze', () => {
  test('★ C1: a 12-hour silence notifies once, with the camera, its length and who set it; a renewal does not', async () => {
    const res = await snooze(carerToken, 720);
    assert.equal(res.status, 200);
    assert.equal(notices.length, 1);
    const [cam, minutes, userId] = notices[0];
    assert.deepEqual([cam.id, cam.name, minutes, userId], [CAM, CAM_ROW.name, 720, 'u-carer']);
    assert.equal((await snooze(adminToken, 720)).status, 200);
    assert.equal(notices.length, 1, 'the same silence, already notified');
    assert.equal(episode().notified, 1);
  });

  test('★ an admin\'s silence passes the admin\'s id, so the admin\'s own devices are the ones left out', async () => {
    await snooze(adminToken, 120);
    assert.deepEqual(notices[0].slice(2), ['u-admin']);
  });

  test('★ C3, "after the commit": a silence whose COMMIT fails sends no notice (and is not applied)', async () => {
    // The one failure that tells "notice after the commit" from "notice inside the transaction, after its writes"
    // (PR #664 review, mutant R05): every write succeeds and only COMMIT fails. A deferred foreign key does exactly
    // that: a row naming a camera that does not exist is allowed until COMMIT, which then refuses the transaction.
    // A test-only table and trigger plant one inside the snooze's own transaction.
    db.exec(`CREATE TABLE IF NOT EXISTS commit_tripwire (
               cam TEXT REFERENCES cameras(id) DEFERRABLE INITIALLY DEFERRED)`);
    db.exec(`CREATE TRIGGER trip_commit AFTER INSERT ON camera_silences
             BEGIN INSERT INTO commit_tripwire (cam) VALUES ('no-such-camera'); END`);
    try {
      const res = await snooze(carerToken, 720);
      assert.equal(res.status, 500, JSON.stringify(res.body));
      assert.deepEqual(camRow(), { alerts_snoozed_until: null, alerts_snoozed_by: null }, 'the silence rolled back');
      assert.equal(episode(), undefined);
      assert.equal(notices.length, 0, 'no notice about a silence that never happened');
    } finally {
      db.exec('DROP TRIGGER IF EXISTS trip_commit');
      db.exec('DROP TABLE IF EXISTS commit_tripwire');
    }
    // Control: without the tripwire the same silence notifies, so the 0 above is the commit, not something else.
    assert.equal((await snooze(carerToken, 720)).status, 200);
    assert.equal(notices.length, 1);
  });

  test('one press of the tile\'s longest button (60 minutes) does not notify at the default threshold', async () => {
    assert.equal((await snooze(carerToken, 60)).status, 200);
    assert.equal(notices.length, 0);
    const e = episode();
    assert.ok(e && e.ended_at - e.started_at === 60 * MIN && e.notified === 0, JSON.stringify(e));
  });

  test('★ C3: the notice throws: still 200, still muted, the history row written', async () => {
    fake.notify = () => { throw new Error('every channel is down (test)'); };
    const res = await snooze(carerToken, 120);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.alerts_snoozed_by, 'carer-login');
    assert.ok(camRow().alerts_snoozed_until > Date.now(), 'the silence stands');
    assert.equal(historyRows().length, 1);
    assert.ok(logger.getRecent().some((l) => l.includes('the long-silence notice was not sent')), 'and the failure is logged');
  });

  test('★ C3: even the settings read failing cannot fail the silence (it is inside the same try)', async () => {
    db.exec('ALTER TABLE settings RENAME COLUMN snooze_alert_minutes TO snooze_alert_minutes_gone');
    try {
      const res = await snooze(carerToken, 120);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.ok(camRow().alerts_snoozed_until > Date.now());
      assert.equal(notices.length, 0);
    } finally {
      db.exec('ALTER TABLE settings RENAME COLUMN snooze_alert_minutes_gone TO snooze_alert_minutes');
    }
  });

  test('★ C3: an un-mute never sends a notice, even of a long silence nobody was told about', async () => {
    // A silence that has ALREADY run for two hours, set while the setting was off (so nobody was told), still
    // muted for ten more. Un-muting it now leaves an episode of two hours, well over the threshold: only the
    // rule "an un-mute never sends" stops a notice here (a fresh silence un-muted at once would be too short
    // to notify anyway, and could not tell the two apart).
    const now = Date.now();
    db.prepare('UPDATE cameras SET alerts_snoozed_until = ?, alerts_snoozed_by = ? WHERE id = ?').run(now + 600 * MIN, 'carer-login', CAM);
    db.prepare('INSERT INTO camera_silences (camera_id, started_at, ended_at, notified) VALUES (?, ?, ?, 0)')
      .run(CAM, now - 120 * MIN, now + 600 * MIN);
    const res = await snooze(carerToken, 0);
    assert.equal(res.status, 200);
    const e = episode();
    assert.ok(e.ended_at - e.started_at > 60 * MIN, `setup: the episode is still over the threshold (${JSON.stringify(e)})`);
    assert.equal(notices.length, 0, 'an un-mute only ever shortens a silence; it is not one being set');
    assert.equal(e.notified, 0);
  });

  test('★ the silence record is written with the mute: if it cannot be, nothing is applied (500, no row, no notice)', async () => {
    db.prepare("CREATE TRIGGER refuse_episode_insert BEFORE INSERT ON camera_silences BEGIN SELECT RAISE(ABORT, 'episode write refused (test)'); END").run();
    const res = await snooze(carerToken, 120);
    assert.equal(res.status, 500);
    assert.deepEqual(camRow(), { alerts_snoozed_until: null, alerts_snoozed_by: null }, 'not muted');
    assert.equal(historyRows().length, 0, 'and the history row rolled back with it');
    assert.equal(notices.length, 0);
  });

  test('a renewal whose record cannot be updated is not applied either: the earlier silence stands as it was', async () => {
    await snooze(carerToken, 30);
    const before_ = { cam: camRow(), episode: episode(), rows: historyRows().length };
    db.prepare("CREATE TRIGGER refuse_episode_update BEFORE UPDATE ON camera_silences BEGIN SELECT RAISE(ABORT, 'episode write refused (test)'); END").run();
    assert.equal((await snooze(carerToken, 60)).status, 500);
    assert.deepEqual({ cam: camRow(), episode: episode(), rows: historyRows().length }, before_);
  });

  test('★ the history row cannot be written: the silence record is untouched too (one transaction)', async () => {
    await snooze(carerToken, 30);
    const before_ = episode();
    db.prepare("CREATE TRIGGER refuse_history BEFORE INSERT ON camera_events BEGIN SELECT RAISE(ABORT, 'history write refused (test)'); END").run();
    for (const minutes of [60, 0]) {
      assert.equal((await snooze(carerToken, minutes)).status, 500, `minutes=${minutes}`);
      assert.deepEqual(episode(), before_, `minutes=${minutes}: the episode did not move`);
    }
  });

  test('an un-mute of a camera that is not muted touches no silence record (PR #663: it writes nothing)', async () => {
    db.prepare('INSERT INTO camera_silences (camera_id, started_at, ended_at, notified) VALUES (?, ?, ?, 0)')
      .run(CAM, Date.now() - 50 * MIN, Date.now() - 20 * MIN);
    const before_ = episode();
    assert.equal((await snooze(carerToken, 0)).status, 200);
    assert.deepEqual(episode(), before_);
    db.prepare('DELETE FROM camera_silences').run();
    assert.equal((await snooze(carerToken, 0)).status, 200);
    assert.equal(episode(), undefined, 'and creates none');
  });

  test('a real un-mute brings the record\'s end forward to the un-mute', async () => {
    await snooze(carerToken, 60);
    const t = Date.now();
    await snooze(carerToken, 0);
    const e = episode();
    assert.ok(e.ended_at >= t && e.ended_at <= Date.now(), JSON.stringify(e));
  });

  test('deleting a camera deletes its silence record', async () => {
    await snooze(carerToken, 30);
    assert.ok(episode());
    db.prepare('DELETE FROM cameras WHERE id = ?').run(CAM);
    assert.equal(episode(), undefined);
  });
});

// --- C5: the settings -------------------------------------------------------------------------------------------

describe('C5: Long silence alerts settings', () => {
  const get = (token) => call(`${settings.url}/api/settings`, { token });
  const put = (token, body) => call(`${settings.url}/api/settings`, { method: 'PUT', token, body });

  test('★ a fresh install defaults to on, 60 minutes (the documented defaults)', () => {
    const fresh = db.prepare("SELECT dflt_value, name FROM pragma_table_info('settings') WHERE name LIKE 'snooze_alert_%' ORDER BY name").all();
    assert.deepEqual(fresh, [{ dflt_value: '1', name: 'snooze_alert_enabled' }, { dflt_value: '60', name: 'snooze_alert_minutes' }]);
  });

  test('★ round trip: PUT both, GET returns both; a PUT without them keeps them', async () => {
    let r = await put(adminToken, { snooze_alert_enabled: false, snooze_alert_minutes: 95 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    r = await get(adminToken);
    assert.equal(r.body.snooze_alert_enabled, 0);
    assert.equal(r.body.snooze_alert_minutes, 95);
    assert.equal((await put(adminToken, { app_name: 'Nightlight' })).status, 200);
    assert.deepEqual(settingsRow(), { snooze_alert_enabled: 0, snooze_alert_minutes: 95 }, 'a save from another page leaves them alone');
    assert.equal((await put(adminToken, { snooze_alert_enabled: true })).status, 200);
    assert.deepEqual(settingsRow(), { snooze_alert_enabled: 1, snooze_alert_minutes: 95 });
  });

  test('★ the range is 1-719, whole numbers only: anything else is refused and nothing is written', async () => {
    // PR #664 review, reproduced: parseInt stored 59.5 as 59 and 1e100 as 1 (a huge value silently became a
    // one-minute threshold). Every one of these must be a 400 with the readable message, and change nothing.
    setAlert(1, 42);
    const BAD = [0, 720, -5, 'abc', '', 59.5, '59.5', 1e100, '1e3', '60abc', [60], null, true, '0x10', ' 60', {}];
    for (const bad of BAD) {
      const r = await put(adminToken, { snooze_alert_minutes: bad, snooze_alert_enabled: false });
      assert.equal(r.status, 400, `${JSON.stringify(bad)} was accepted`);
      assert.equal(r.body.error, 'Long-silence alert threshold must be between 1 and 719 minutes');
      assert.deepEqual(settingsRow(), { snooze_alert_enabled: 1, snooze_alert_minutes: 42 }, `${JSON.stringify(bad)}: nothing written`);
    }
    for (const good of [1, 719, '60', '30']) {
      assert.equal((await put(adminToken, { snooze_alert_minutes: good })).status, 200, `${good} refused`);
      assert.equal(settingsRow().snooze_alert_minutes, Number(good));
    }
  });

  test('★ the switch takes only true/false/1/0: the string "false" is refused, never stored as on', async () => {
    // Truthiness (what the older switches on this route use) would store "false", "0" and "no" as ON.
    setAlert(0, 42);
    for (const bad of ['false', '0', 'no', 'true', '1', 2, null, [], {}]) {
      const r = await put(adminToken, { snooze_alert_enabled: bad });
      assert.equal(r.status, 400, `${JSON.stringify(bad)} was accepted`);
      assert.equal(r.body.error, 'Long-silence alerts must be switched on or off (true or false)');
      assert.equal(settingsRow().snooze_alert_enabled, 0, `${JSON.stringify(bad)}: nothing written`);
    }
    for (const [good, stored] of [[true, 1], [false, 0], [1, 1], [0, 0]]) {
      assert.equal((await put(adminToken, { snooze_alert_enabled: good })).status, 200, `${good} refused`);
      assert.equal(settingsRow().snooze_alert_enabled, stored);
    }
  });

  test('★ admin only: a caregiver cannot change them, and neither a caregiver nor a visitor is sent them', async () => {
    setAlert(1, 42);
    const r = await put(carerToken, { snooze_alert_enabled: false, snooze_alert_minutes: 5 });
    assert.equal(r.status, 403);
    assert.deepEqual(settingsRow(), { snooze_alert_enabled: 1, snooze_alert_minutes: 42 });
    for (const token of [carerToken, undefined]) {
      const body = (await get(token)).body;
      assert.ok(!('snooze_alert_enabled' in body) && !('snooze_alert_minutes' in body), JSON.stringify(body));
    }
    const admin = (await get(adminToken)).body;
    assert.deepEqual([admin.snooze_alert_enabled, admin.snooze_alert_minutes], [1, 42]);
  });
});

// --- C5: the upgrade ---------------------------------------------------------------------------------------------

test('★ C5: an install from before this change gains the two settings (on, 60) and the silence table on boot', () => {
  // Same shape as who-did-it-migration.test.js: separate processes on ONE database file, because db.js migrates
  // once at module load. Boot 1 builds today's schema and rewinds it (drops what this change added); boot 2 is
  // the upgrade; boot 3 proves it is a no-op the second time. Compared with the FRESH schema, not a typed list,
  // so a guard that tests the wrong column (the column is then never added) fails here.
  const DB_JS_URL = pathToFileURL(path.join(import.meta.dirname, '..', 'src', 'db.js')).href;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightlight-test-silencemig-'));
  const run = (script) => execFileSync(
    process.execPath,
    ['--input-type=module', '-e', `process.env.DATA_DIR = ${JSON.stringify(dir)};\n${script}`],
    { encoding: 'utf8' }
  ).trim();
  const readSchema = `const { default: db } = await import(${JSON.stringify(DB_JS_URL)});
    const cols = (t) => db.prepare('PRAGMA table_info(' + t + ')').all();
    const fks = db.prepare('PRAGMA foreign_key_list(camera_silences)').all();
    const row = db.prepare("SELECT app_name, snooze_alert_enabled, snooze_alert_minutes FROM settings WHERE id = 'app'").get();`;
  try {
    const fresh = JSON.parse(run(`${readSchema}
      const out = { settings: cols('settings'), silences: cols('camera_silences'), fks };
      db.exec('ALTER TABLE settings DROP COLUMN snooze_alert_enabled');
      db.exec('ALTER TABLE settings DROP COLUMN snooze_alert_minutes');
      db.exec('DROP TABLE camera_silences');
      db.prepare("UPDATE settings SET app_name = 'Kept Name' WHERE id = 'app'").run();
      console.log(JSON.stringify(out));`));
    assert.ok(fresh.settings.some((c) => c.name === 'snooze_alert_minutes'), 'setup: a fresh install has the column');
    assert.equal(fresh.silences.length, 4, 'setup: a fresh install has the table');
    for (const boot of [2, 3]) {
      const got = JSON.parse(run(`${readSchema}
        console.log(JSON.stringify({ settings: cols('settings'), silences: cols('camera_silences'), fks, row }));`));
      const byName = (list) => [...list].sort((a, b) => a.name.localeCompare(b.name)).map(({ cid, ...c }) => c);
      assert.deepEqual(byName(got.settings), byName(fresh.settings), `boot ${boot}: settings is back to the fresh schema`);
      assert.deepEqual(got.silences, fresh.silences, `boot ${boot}: camera_silences matches a fresh install`);
      assert.deepEqual(got.fks, fresh.fks, `boot ${boot}: with its cascade to cameras`);
      assert.deepEqual(got.row, { app_name: 'Kept Name', snooze_alert_enabled: 1, snooze_alert_minutes: 60 },
        `boot ${boot}: the existing settings row keeps its values and gains the defaults`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
