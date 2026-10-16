// #547: the diagnostics bundle is attached to PUBLIC GitHub issues and must not carry a child's name or
// birthday, nor the camera names people choose after their children, nor an account's login or real name.
//
// The fixture is HOSTILE on purpose. Each identity-bearing column gets a recognisable marker, and the list of
// columns is DERIVED from `PRAGMA table_info` (every TEXT column minus a named SAFE list), never typed: a
// column someone adds next year is planted automatically and fails this test until it is either kept out of
// the bundle or classified SAFE here. "Forward-compatible" is a claim; this is the test that makes it one.
//
// Names also reach the bundle the way they really do: interpolated into log lines and event details by call
// sites in other files. So the markers are logged, not only stored.
//
// NOT covered (negative space): a real log buffer from a live detector or a real ffprobe line; a name that
// exists only as OLD log text after a rename (unknowable to the redactor, documented in SECURITY.md);
// Unicode normalisation forms (NFC vs NFD); the camera addresses, MQTT topics, timezone and event times that
// stay in the bundle BY DECISION (and are documented as staying).
import { test, mock, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, signToken, mountRouter, call } from './helpers/harness.js';

useTempDataDir();

const { default: db } = await import('../src/db.js');
const { logger, neutraliseControlChars } = await import('../src/lib/logger.js');
const { reportGuardFailure, resetGuardRateLimit } = await import('../src/lib/processGuards.js');
const { default: diagnosticsRouter } = await import('../src/routes/diagnostics.js');

const MARK = 'ZZ-IDENT-MARKER';

let server;
let adminToken;

before(async () => {
  const admin = makeUser(db, { id: 'ident-admin', username: 'admin', role: 'admin' });
  db.prepare('UPDATE users SET created_at = ? WHERE id = ?').run('2020-01-01 00:00:00', admin.id);
  adminToken = signToken({ id: admin.id, username: admin.username, role: admin.role, sid: makeSession(db, admin.id) });
  server = await mountRouter('/api/diagnostics', diagnosticsRouter);
});

function resetState() {
  db.prepare('DELETE FROM camera_events').run();
  db.prepare('DELETE FROM detection_events').run();
  db.prepare('DELETE FROM cameras').run();
  db.prepare('DELETE FROM children').run();
  db.prepare("DELETE FROM users WHERE id != 'ident-admin'").run();
  db.prepare("UPDATE settings SET app_name = 'Nightlight' WHERE id = 'app'").run();
  logger.clear();
}
beforeEach(resetState);

after(async () => {
  mock.restoreAll();
  await server?.close();
  db.close();
  cleanupTempDataDirs();
});

// TEXT columns of `table` that are NOT on the safe list: every one of them gets a marker.
function identityColumns(table, safe) {
  const info = db.prepare(`PRAGMA table_info(${table})`).all();
  const names = info.map((c) => c.name);
  for (const s of safe) assert.ok(names.includes(s), `${table}.${s} is on the SAFE list but no longer exists: reclassify`);
  return info.filter((c) => c.type === 'TEXT' && !safe.includes(c.name)).map((c) => c.name);
}

function insertPlanted(table, base, planted) {
  const cols = [...Object.keys(base), ...planted];
  const vals = [...Object.values(base), ...planted.map((c) => `${MARK}-${table}-${c}`)];
  db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...vals);
}

function insertCamera(id, name, extra = {}) {
  const row = { id, name, rtsp_url: 'rtsp://viewer:pw@cam.local/live', mediamtx_path: `path_${id}`, sort_order: 1, ...extra };
  const cols = Object.keys(row);
  db.prepare(`INSERT INTO cameras (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...Object.values(row));
}

const bundle = async () => {
  const res = await call(`${server.url}/api/diagnostics`, { token: adminToken });
  return res;
};
const text = (res) => JSON.stringify(res.body);

test('★ #547: no marker planted in a children, users or camera column reaches the bundle', async () => {
  // Derived from the schema. id/color/created_at/primary_camera_id are published as-is by design (a uuid, a
  // hex colour, a timestamp); the sleep window and track flag are settings, not identity.
  const childCols = identityColumns('children', [
    'id', 'color', 'created_at', 'primary_camera_id', 'track_sleep', 'sleep_window_start', 'sleep_window_end',
  ]);
  const userCols = identityColumns('users', ['id', 'role', 'created_at', 'mfa_enabled']);
  // The ones this test exists for must be among what was derived, or the derivation silently matched nothing.
  for (const c of ['name', 'birthday']) assert.ok(childCols.includes(c), `children.${c} not planted`);
  for (const c of ['username', 'first_name', 'last_name']) assert.ok(userCols.includes(c), `users.${c} not planted`);

  insertPlanted('children', { id: 'kid-1', created_at: '2021-01-01 00:00:00' }, childCols);
  insertPlanted('users', { id: 'person-1', role: 'caregiver', created_at: '2021-02-01 00:00:00' }, userCols);
  const childName = `${MARK}-children-name`;
  const cameraName = `${MARK}-camera-name`;
  const username = `${MARK}-users-username`;
  const firstName = `${MARK}-users-first_name`;
  insertCamera('cam-1', cameraName, { child_id: 'kid-1' });
  db.prepare("UPDATE settings SET app_name = ? WHERE id = 'app'").run(`${MARK}-app-name`);

  // Names reach the bundle through free text: log lines, event details, history rows.
  logger.info(`[detect] motion on "${cameraName}" (score 12)`);
  logger.error(`[sleep] failed to process ${childName}: boom`);
  logger.info(`[talk] session started for "${cameraName}" by ${username}`);
  logger.info(`[x] hello ${firstName}`);
  db.prepare('INSERT INTO camera_events (camera_id, camera_name, type, detail, actor_user_id, actor_username) VALUES (?, ?, ?, ?, ?, ?)')
    .run('cam-1', cameraName, 'restart', `restarted ${cameraName} for ${childName}`, 'person-1', username);
  db.prepare('INSERT INTO detection_events (camera_id, camera_name, type, detail) VALUES (?, ?, ?, ?)')
    .run('cam-1', cameraName, 'motion', `${childName} moved`);

  const res = await bundle();
  assert.equal(res.status, 200, text(res).slice(0, 400));
  assert.ok(!text(res).includes(MARK), `a marker reached the bundle: ${text(res).match(new RegExp(`${MARK}[\\w-]*`))?.[0]}`);

  // Controls: the bundle was not simply blanked, and the aliases correlate.
  const [child] = res.body.children;
  assert.deepEqual(Object.keys(child), ['id', 'name', 'birthday', 'color', 'created_at', 'primary_camera_id'], 'an open client reads these keys');
  assert.equal(child.name, 'Child 1');
  assert.equal(child.birthday, null);
  const [cam] = res.body.cameras;
  assert.equal(cam.name, 'Camera 1');
  assert.equal(cam.child_id, 'kid-1', 'the camera is still tied to its child');
  assert.equal(cam.rtsp_host, 'cam.local', 'connectivity facts stay: support needs them');
  assert.equal(cam.rtsp_username, 'viewer');
  const logs = res.body.server_logs.join('\n');
  assert.match(logs, /motion on "Camera 1" \(score 12\)/);
  assert.match(logs, /failed to process Child 1: boom/);
  assert.match(logs, /for "Camera 1" by User 2/);
  assert.equal(res.body.camera_history[0].camera_name, 'Camera 1');
  assert.equal(res.body.camera_history[0].detail, 'restarted Camera 1 for Child 1');
  assert.equal(res.body.camera_history[0].actor, 'person');
  assert.equal(res.body.recent_detection_events[0].camera_name, 'Camera 1');
  assert.equal(res.body.recent_detection_events[0].detail, 'Child 1 moved');
  assert.equal(res.body.settings.app_name, '(customised)');
  assert.deepEqual(res.body.redaction, { identity: 'aliased', birthday: 'omitted' });
  assert.match(res.body.note, /Child 1/);
  assert.match(res.body.note, /timezone/);
});

test('★ #709: names containing control characters reach no bundle, neither as typed nor as the logger escapes them', async () => {
  // Since #539 the log buffer holds a control character as visible text (`\n`, `\x01`, ...), so a name has a
  // spelling in `server_logs` that the redactor did not know: it survived, and the gate (same matcher) passed it.
  // Every identity source the route hands the redactor gets its own name with a marker on BOTH sides of the
  // character (so neither half can leak unnoticed), in the middle, leading or trailing (a leading line break is
  // trimmed off the name, which leaves the escape right before it in the log). The names reach the log through
  // every level, raw(), and a real Error stack, the way they really do. One class of each the logger escapes
  // differently, plus tab, which it leaves raw.
  const controls = [0x0a, 0x0d, 0x09, 0x01, 0x1b, 0x7f, 0x85, 0x2028, 0x2029];
  for (const code of controls) {
    resetState();
    resetGuardRateLimit();
    const c = String.fromCharCode(code);
    const at = `U+${code.toString(16).padStart(4, '0')}`;
    const names = {
      child: `Qzx-child-a${c}Qzx-child-b`,
      camera: `${c}Qzx-camera`,
      login: `Qzx-login${c}`,
      first: `Qzx-first-a${c}Qzx-first-b`,
      last: `${c}Qzx-last`,
      oldcam: `Qzx-oldcam-a${c}Qzx-oldcam-b`,
      detcam: `Qzx-detcam${c}`,
      former: `${c}Qzx-former-a${c}Qzx-former-b`,
    };
    db.prepare("INSERT INTO children (id, name, created_at) VALUES ('kid-c', ?, '2021-01-01 00:00:00')").run(names.child);
    insertCamera('cam-c', names.camera, { child_id: 'kid-c' });
    db.prepare("INSERT INTO users (id, username, password_hash, first_name, last_name, created_at) VALUES ('u-c', ?, 'x', ?, ?, '2021-02-01 00:00:00')")
      .run(names.login, names.first, names.last);
    db.prepare('INSERT INTO camera_events (camera_id, camera_name, type, detail, actor_user_id, actor_username) VALUES (?, ?, ?, ?, ?, ?)')
      .run('cam-gone-1', names.oldcam, 'restart', `restarted ${names.oldcam} for ${names.child}`, 'old-id', names.former);
    db.prepare('INSERT INTO detection_events (camera_id, camera_name, type, detail) VALUES (?, ?, ?, ?)')
      .run('cam-gone-2', names.detcam, 'motion', `${names.child} moved`);

    logger.info(`[detect] motion on "${names.camera}" for ${names.child}`);
    logger.warn(`[talk] session by ${names.login} (${names.first} ${names.last})`);
    logger.error(`[sleep] failed for ${names.child}:\n${names.camera} stopped\n${names.oldcam}`);
    logger.raw(`ffmpeg:${names.camera}`, `${names.detcam} frame error\n${names.former}`);
    reportGuardFailure('ident-stack', new Error(`lost ${names.former}\n${names.first}\n${names.last}`));

    const res = await bundle();
    assert.equal(res.status, 200, `${at}: ${text(res).slice(0, 300)}`);
    assert.ok(!text(res).includes('Qzx'), `${at}: a marker reached the bundle: ${text(res).match(/.{0,40}Qzx.{0,40}/)?.[0]}`);
    const logs = res.body.server_logs;
    assert.equal(logs.length, 5, `${at}: every logged line is in the bundle (the check is not passing an empty log)`);
    for (const [field, name] of Object.entries(names)) {
      for (const l of logs) {
        assert.ok(!l.includes(name) && !l.includes(neutraliseControlChars(name)), `${at} ${field}: ${l}`);
      }
    }
    // Controls: the lines were rewritten, not blanked, and the aliases still correlate. (A leading or trailing
    // character is not part of the trimmed name, so its escape stays beside the alias: `"\nCamera 1"`.)
    const want = [['Camera 1', 'Child 1'], ['User 2'], ['Child 1', 'Camera 1', 'Camera (removed) 1'],
      ['Camera 1', 'Camera (removed) 2', 'User (former) 1'], ['User (former) 1', 'User 2', '    at ']];
    want.forEach((aliases, i) => aliases.forEach((a) => assert.ok(logs[i].includes(a), `${at}: "${a}" missing from ${logs[i]}`)));
    assert.equal(res.body.camera_history[0].detail, 'restarted Camera (removed) 1 for Child 1', at);
    assert.equal(res.body.recent_detection_events[0].detail, 'Child 1 moved', at);
  }
});

test('★ #709 exhaustive: for EVERY code unit the logger escapes, no camera name reaches the bundle', async () => {
  // Round-2 review of PR #709: the nine sampled characters above let NUL through two mutants (a probe from U+0001,
  // and a logged spelling that kept NUL raw). Every unit the logger changes (derived from its own function; its
  // exact set is pinned in logger-control-chars.test.js), in a name at the start, middle and end, and a name that
  // sits right after the escaped unit in a log line, through the real route: its scrub AND its privacy gate.
  const units = [];
  for (let u = 0; u <= 0xffff; u++) {
    const ch = String.fromCharCode(u);
    if (neutraliseControlChars(ch) !== ch) units.push(u);
  }
  for (const must of [0x00, 0x0a, 0x7f, 0x2029]) assert.ok(units.includes(must), `U+${must.toString(16)} not derived`);
  for (const u of units) {
    resetState();
    const c = String.fromCharCode(u);
    const at = `U+${u.toString(16).padStart(4, '0')}`;
    const names = { lead: `${c}Qzx-lead`, mid: `Qzx-mid-a${c}Qzx-mid-b`, end: `Qzx-end${c}`, after: 'Qzx After Room' };
    Object.values(names).forEach((name, i) => insertCamera(`cam-${i + 1}`, name, { sort_order: i + 1 }));
    logger.info(`[detect] motion on "${names.lead}" "${names.mid}" "${names.end}"`);
    logger.error(`[x] failed:${c}${names.after} down${c}${names.mid}${c}${names.lead}${c}${names.end}${c}end`);
    const res = await bundle();
    assert.equal(res.status, 200, `${at}: ${text(res).slice(0, 200)}`);
    assert.ok(!text(res).includes('Qzx'), `${at}: ${text(res).match(/.{0,40}Qzx.{0,40}/)?.[0]}`);
    assert.equal(res.body.server_logs.length, 2, at);
    for (const alias of ['Camera 1', 'Camera 2', 'Camera 3']) assert.ok(res.body.server_logs[0].includes(alias), `${at}: ${alias}`);
    assert.ok(res.body.server_logs[1].includes('failed:') && res.body.server_logs[1].includes('Camera 4 down'), `${at}: ${res.body.server_logs[1]}`);
  }
});

test('a renamed or removed camera: its history rows carry the OLD name, which is still replaced', async () => {
  insertCamera('cam-live', 'Today Name');
  const old = 'ZZ Yesterday Name';
  const gone = 'ZZ Removed Cam';
  db.prepare('INSERT INTO camera_events (camera_id, camera_name, type, detail) VALUES (?, ?, ?, ?)').run('cam-live', old, 'offline', `${old} stopped`);
  db.prepare('INSERT INTO detection_events (camera_id, camera_name, type, detail) VALUES (?, ?, ?, ?)').run('cam-gone', gone, 'motion', null);
  logger.info(`[detect] motion on "${gone}"`);
  logger.info(`[detect] motion on "${old}"`);

  const res = await bundle();
  assert.equal(res.status, 200, text(res).slice(0, 300));
  assert.ok(!text(res).includes('Yesterday Name') && !text(res).includes('Removed Cam') && !text(res).includes('Today Name'));
  assert.equal(res.body.camera_history[0].camera_name, 'Camera 1', 'the renamed camera keeps ITS alias');
  assert.equal(res.body.camera_history[0].detail, 'Camera 1 stopped');
  assert.equal(res.body.recent_detection_events[0].camera_name, 'Camera (removed) 1');
  const logs = res.body.server_logs.join('\n');
  assert.match(logs, /motion on "Camera \(removed\) 1"/);
  assert.match(logs, /motion on "Camera 1"/);
});

test('an account that is no longer in the users table is still replaced (renamed or deleted)', async () => {
  const former = 'zz-former-login';
  db.prepare('INSERT INTO camera_events (camera_id, camera_name, type, detail, actor_user_id, actor_username) VALUES (?, ?, ?, ?, ?, ?)')
    .run('cam-x', 'Some Cam', 'snooze', 'muted for 15 min', 'old-id', former);
  logger.info(`[talk] session started for "Some Cam" by ${former}`);
  const res = await bundle();
  assert.equal(res.status, 200, text(res).slice(0, 300));
  assert.ok(!text(res).includes(former));
  assert.match(res.body.server_logs.join('\n'), /by User \(former\) 1/);
});

test('a name inside a percent-encoded RTSP path is replaced (rtsp_path keeps the encoded pathname)', async () => {
  insertCamera('cam-enc', 'ZZ Nursery Room', { rtsp_url: 'rtsp://viewer:pw@cam.local/ZZ%20Nursery%20Room/stream' });
  const res = await bundle();
  assert.equal(res.status, 200, text(res).slice(0, 300));
  assert.ok(!/Nursery/i.test(text(res)), text(res).match(/.{0,30}Nursery.{0,30}/i)?.[0]);
  assert.equal(res.body.cameras[0].rtsp_path, '/Camera 1/stream');
});

test('a child and a camera with the same name: structured fields keep their own alias, free text says both', async () => {
  const shared = 'ZZ Shared Name';
  db.prepare("INSERT INTO children (id, name, created_at) VALUES ('kid-s', ?, '2021-01-01 00:00:00')").run(shared);
  insertCamera('cam-s', shared, { child_id: 'kid-s' });
  logger.info(`[detect] motion on "${shared}"`);
  const res = await bundle();
  assert.equal(res.status, 200, text(res).slice(0, 300));
  assert.equal(res.body.children[0].name, 'Child 1');
  assert.equal(res.body.cameras[0].name, 'Camera 1');
  assert.match(res.body.server_logs.join('\n'), /motion on "Child 1 \/ Camera 1"/);
  assert.ok(!text(res).includes('Shared Name'));
});

test('names that look like the bundle\'s own aliases do not make the bundle unsendable', async () => {
  // A camera called "Camera" is found inside its own alias "Camera 1" unless the gate masks aliases first;
  // a child really named "Child 1" must not be treated as identity (it publishes nothing).
  db.prepare("INSERT INTO children (id, name, created_at) VALUES ('kid-a', 'Child 1', '2021-01-01 00:00:00')").run();
  insertCamera('cam-a', 'Camera');
  logger.info('[detect] motion on "Camera" ok');
  const res = await bundle();
  assert.equal(res.status, 200, text(res).slice(0, 300));
  assert.equal(res.body.cameras[0].name, 'Camera 1');
  assert.equal(res.body.children[0].name, 'Child 1');
  assert.match(res.body.server_logs.join('\n'), /motion on "Camera 1" ok/);
  // Two more places the word shows up that are not data: the bundle's own note, and its fixed keys
  // ("camera_history", "camera_id"). Neither may be rewritten or make the check fail.
  assert.match(res.body.note, /camera and MQTT addresses/);
  assert.ok('camera_history' in res.body);
});

test('the birthday is not a search term: a timestamp on the day of birth is left alone', async () => {
  db.prepare("INSERT INTO children (id, name, birthday, created_at) VALUES ('kid-b', 'Zed Zephyr', '2026-10-12', '2026-10-12 08:00:00')").run();
  db.prepare('INSERT INTO camera_events (camera_id, camera_name, type, detail, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('cam-b', 'Cam B', 'offline', 'down since 2026-10-12 07:59', '2026-10-12 08:01:00');
  const res = await bundle();
  assert.equal(res.status, 200, text(res).slice(0, 300));
  assert.equal(res.body.children[0].birthday, null);
  assert.equal(res.body.children[0].created_at, '2026-10-12 08:00:00');
  assert.equal(res.body.camera_history[0].created_at, '2026-10-12 08:01:00');
  assert.equal(res.body.camera_history[0].detail, 'down since 2026-10-12 07:59');
});

test('the timezone, version and runtime fields are not rewritten when a name is also a place (code review)', async () => {
  // A child called Phoenix (or Sydney) must not turn "America/Phoenix" into "America/Child 1": the timezone
  // is the one fact a bedtime-off-by-an-hour bug is diagnosed from.
  db.prepare("INSERT INTO children (id, name, created_at) VALUES ('kid-p', 'Phoenix', '2021-01-01 00:00:00')").run();
  db.prepare("UPDATE settings SET timezone = 'America/Phoenix' WHERE id = 'app'").run();
  logger.info('[sleep] Phoenix slept');
  const res = await bundle();
  assert.equal(res.status, 200, text(res).slice(0, 300));
  assert.equal(res.body.settings.timezone, 'America/Phoenix');
  assert.equal(res.body.children[0].name, 'Child 1');
  assert.match(res.body.server_logs.join('\n'), /Child 1 slept/);
});

test('a camera whose name begins with another alias is replaced whole, not "Camera 1" plus the rest', async () => {
  insertCamera('cam-1', 'ZZ Hall');
  insertCamera('cam-2', 'Camera 1 ZZ Nursery', { sort_order: 2 });
  logger.info('[detect] motion on "Camera 1 ZZ Nursery"');
  const res = await bundle();
  assert.equal(res.status, 200, text(res).slice(0, 300));
  assert.ok(!/Nursery/.test(text(res)), text(res).match(/.{0,20}Nursery.{0,20}/)?.[0]);
  assert.match(res.body.server_logs.join('\n'), /motion on "Camera 2"/);
});

test('a name under 3 characters is still aliased in every list, though it is not searched for in log text', async () => {
  // The free-text scrub skips "Jo" (it would rewrite ordinary words), so the lists must not depend on it:
  // the route aliases by id. This is the test that fails if a list is left to the text scrub.
  db.prepare("INSERT INTO children (id, name, created_at) VALUES ('kid-j', 'Jo', '2021-01-01 00:00:00')").run();
  insertCamera('cam-j', 'Bo', { child_id: 'kid-j' });
  db.prepare('INSERT INTO camera_events (camera_id, camera_name, type) VALUES (?, ?, ?)').run('cam-j', 'Bo', 'offline');
  db.prepare('INSERT INTO detection_events (camera_id, camera_name, type) VALUES (?, ?, ?)').run('cam-j', 'Bo', 'motion');
  const res = await bundle();
  assert.equal(res.status, 200, text(res).slice(0, 300));
  assert.equal(res.body.children[0].name, 'Child 1');
  assert.equal(res.body.cameras[0].name, 'Camera 1');
  assert.equal(res.body.camera_history[0].camera_name, 'Camera 1');
  assert.equal(res.body.recent_detection_events[0].camera_name, 'Camera 1');
});

test('numbering follows created_at (children, accounts) and the grid order (cameras), not insertion order', async () => {
  db.prepare("INSERT INTO children (id, name, created_at) VALUES ('kid-late', 'Zed Late', '2023-01-01 00:00:00')").run();
  db.prepare("INSERT INTO children (id, name, created_at) VALUES ('kid-early', 'Zed Early', '2022-01-01 00:00:00')").run();
  insertCamera('cam-b', 'Zed Back', { sort_order: 2 });
  insertCamera('cam-a', 'Zed Front', { sort_order: 1 });
  db.prepare("INSERT INTO users (id, username, password_hash, created_at) VALUES ('u-late', 'zlate-login', 'x', '2023-01-01 00:00:00')").run();
  db.prepare("INSERT INTO users (id, username, password_hash, created_at) VALUES ('u-early', 'zearly-login', 'x', '2022-01-01 00:00:00')").run();
  logger.info('[talk] by zearly-login then zlate-login');
  logger.info('[sleep] Zed Early / Zed Late');
  logger.info('[detect] Zed Front / Zed Back');
  const res = await bundle();
  assert.equal(res.status, 200, text(res).slice(0, 300));
  const logs = res.body.server_logs.join('\n');
  // the admin (2020) is User 1
  assert.match(logs, /by User 2 then User 3/);
  assert.match(logs, /Child 1 \/ Child 2/);
  assert.match(logs, /Camera 1 \/ Camera 2/);
});

test('a generic account name is not identity: the camera\'s own login "admin" is left readable', async () => {
  insertCamera('cam-g', 'Hall', { rtsp_url: 'rtsp://admin:pw@cam.local/live' });
  const res = await bundle();
  assert.equal(res.status, 200, text(res).slice(0, 300));
  assert.equal(res.body.cameras[0].rtsp_username, 'admin');
});

test('an install with no children, cameras or history is sent (the redactor has nothing to search for)', async () => {
  const res = await bundle();
  assert.equal(res.status, 200, text(res).slice(0, 300));
  assert.deepEqual(res.body.children, []);
  assert.deepEqual(res.body.cameras, []);
  assert.equal(res.body.settings.app_name, 'Nightlight');
});

test('★ the gate: a name the scrub cannot reach is refused, not sent', async () => {
  // A class instance is passed through by the scrub on purpose (rebuilding a Date or a Buffer from its
  // entries would destroy it), so this is the branch real log lines never reach: the check on the
  // serialised bundle is the only thing between this value and a public issue. A method mock, NOT
  // mock.module: logger.js is in test:core's coverage include list.
  const name = 'ZZ Gate Camera';
  insertCamera('cam-gate', name);
  class Holder { constructor(t) { this.text = t; } }
  const m = mock.method(logger, 'getRecent', () => [new Holder(`motion on ${name}`)]);
  try {
    const res = await bundle();
    assert.equal(res.status, 500, text(res).slice(0, 300));
    assert.ok(!('cameras' in res.body) && !('server_logs' in res.body), 'the flagged bundle was sent anyway');
    assert.ok(!text(res).includes('Gate Camera'), 'the refusal itself echoed the name');
  } finally {
    m.mock.restore();
  }
});
