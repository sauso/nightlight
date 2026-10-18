// The per-child nightly sleep report choices (#397, #398): send it or not, name the child or say "a child".
//
// ★ WHAT THESE TESTS ARE FOR. The thing that matters is what LEAVES THE PROCESS. So a recognisable name is planted
// on a child and every outgoing payload is captured at the boundary of each provider (the Firebase SDK for push,
// and the HTTP request for Pushover, ntfy and Gotify), then searched for it, whole: URL, headers, body, tag, title,
// text. Nothing is mocked inside Nightlight. MQTT is not a provider for this message (nothing in the backend
// publishes to it), so there is no payload there to check.
import { test, describe, before, beforeEach, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, signToken, mountRouter, call } from './helpers/harness.js';

const dataDir = useTempDataDir();

const sendEach = mock.fn(async (messages) => ({
  responses: messages.map(() => ({ success: true })),
  successCount: messages.length,
}));
mock.module('firebase-admin/app', { namedExports: { initializeApp: () => {}, cert: () => ({}) } });
mock.module('firebase-admin/messaging', { namedExports: { getMessaging: () => ({ sendEach }) } });

const { default: db } = await import('../src/db.js');
const { initPush } = await import('../src/lib/push.js');
const { notifySleepReports, notifySleepReportUpdates, sleepReportPrefs } = await import('../src/lib/sleepReportAlert.js');
const { default: childrenRouter } = await import('../src/routes/children.js');

// Unmistakable, two words, and neither is a substring of anything the message says.
const SECRET_FIRST = 'Zephyrine';
const SECRET_LAST = 'Quillfeather';
const SECRET_NAME = `${SECRET_FIRST} ${SECRET_LAST}`;
const OTHER_NAME = 'Marigold Thistlewick';

const OK = { status: 'ok', asleep_minutes: 492, wake_count: 2, wake_at: '2026-07-01 20:47:00' };
const KID = 'kid-a';
const KID2 = 'kid-b';

// Every request the notification providers make, captured instead of sent.
let fetched = [];
const realFetch = globalThis.fetch;
function bodyText(b) {
  if (b == null) return '';
  if (typeof b === 'string') return b;
  if (typeof FormData !== 'undefined' && b instanceof FormData) return JSON.stringify([...b.entries()]);
  return String(b); // URLSearchParams
}

before(async () => {
  globalThis.fetch = async (url, options = {}) => {
    // Only the providers are captured; this file's own requests to the router under test go through.
    if (String(url).startsWith('http://127.0.0.1')) return realFetch(url, options);
    fetched.push({ url: String(url), headers: JSON.stringify(options.headers || {}), body: bodyText(options.body) });
    return new Response(JSON.stringify({ status: 1 }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  fs.writeFileSync(path.join(dataDir, 'firebase-service-account.json'), JSON.stringify({ project_id: 'test-project', private_key: 'x' }));
  fs.writeFileSync(
    path.join(dataDir, 'google-services.json'),
    JSON.stringify({ client: [{ client_info: { mobilesdk_app_id: 'app-1' }, api_key: [{ current_key: 'key-1' }] }], project_info: { project_id: 'test-project', project_number: '123' } })
  );
  assert.equal(await initPush(), true, 'precondition: fake Firebase setup must initialise');
  makeUser(db, { id: 'u-1', username: 'alice' });
  const sid = makeSession(db, 'u-1');
  db.prepare('INSERT INTO push_tokens (token, user_id, session_id, platform) VALUES (?, ?, ?, ?)').run('tok-1', 'u-1', sid, 'android');
  // All four providers on.
  db.prepare(
    `UPDATE settings SET push_enabled = 1,
       pushover_enabled = 1, pushover_app_token = 'app-token-1234567890', pushover_user_key = 'user-key-1234567890',
       ntfy_enabled = 1, ntfy_topic = 'a-topic', ntfy_server_url = 'https://ntfy.example',
       gotify_enabled = 1, gotify_server_url = 'https://gotify.example', gotify_app_token = 'gotify-token-12345'
     WHERE id = 'app'`
  ).run();
});
after(() => {
  globalThis.fetch = realFetch;
  cleanupTempDataDirs();
});
beforeEach(() => {
  db.prepare('DELETE FROM children').run();
  db.prepare("INSERT INTO children (id, name) VALUES (?, ?), (?, ?)").run(KID, SECRET_NAME, KID2, OTHER_NAME);
  fetched = [];
  sendEach.mock.resetCalls();
});

const report = (childId = KID, name = SECRET_NAME) => ({ name, summary: OK, childId, nightDate: '2026-07-01' });
const setPrefs = (id, enabled, showName) =>
  db.prepare('UPDATE children SET sleep_report_enabled = ?, sleep_report_show_name = ? WHERE id = ?').run(enabled, showName, id);

// Everything that left the process, as one string per provider, so a test can search each separately.
function outgoing() {
  const push = sendEach.mock.calls.map((c) => JSON.stringify(c.arguments[0])).join('\n');
  const by = (host) => fetched.filter((f) => f.url.includes(host)).map((f) => `${f.url}\n${f.headers}\n${f.body}`).join('\n');
  return { push, pushover: by('pushover.net'), ntfy: by('ntfy.example'), gotify: by('gotify.example') };
}
// fan-out is fire-and-forget; give the un-awaited sends a tick to reach the capture.
const settle = () => new Promise((r) => setTimeout(r, 30));

describe('★ defaults are what every install has always had', () => {
  test('a child created without saying anything: report ON, name SHOWN, on every provider', async () => {
    assert.deepEqual(sleepReportPrefs(KID), { enabled: true, showName: true });
    notifySleepReports([report()]);
    await settle();
    const o = outgoing();
    for (const [provider, text] of Object.entries(o)) {
      assert.ok(text.includes(SECRET_NAME), `${provider} did not get the report with the name`);
    }
    assert.ok(o.push.includes(`Sleep report — ${SECRET_NAME}`));
  });

  test('the column defaults really are ON (read from the schema, not from the fixture above)', () => {
    const cols = db.prepare('PRAGMA table_info(children)').all();
    for (const name of ['sleep_report_enabled', 'sleep_report_show_name']) {
      const c = cols.find((x) => x.name === name);
      assert.equal(c.dflt_value, '1', name);
      assert.equal(c.notnull, 1, name);
    }
  });
});

describe('★ "Send this child\'s sleep report" off', () => {
  test('nothing at all reaches any provider, for the first report or the update', async () => {
    setPrefs(KID, 0, 1);
    notifySleepReports([report()]);
    notifySleepReportUpdates([report()]);
    await settle();
    assert.equal(sendEach.mock.callCount(), 0, 'push was sent');
    assert.deepEqual(fetched, [], 'a provider request was made');
  });

  test('one child off, another on, in the same combined message: only the other is in it', async () => {
    setPrefs(KID, 0, 1);
    notifySleepReports([report(KID, SECRET_NAME), report(KID2, OTHER_NAME)]);
    await settle();
    const o = outgoing();
    for (const [provider, text] of Object.entries(o)) {
      assert.ok(text.includes(OTHER_NAME), `${provider}: the child whose report is on is missing`);
      assert.ok(!text.includes(SECRET_FIRST) && !text.includes(SECRET_LAST), `${provider}: the child whose report is off appears`);
    }
  });

  test('one child off, another on: what is left is a ONE-child message, titled and tagged for that child', async () => {
    // Review S7. The tray-collapse tag and the one-child title are worked out from the children actually IN the
    // message, after the filter. Worked out from the list the job handed over, two entries would read as a combined
    // message: no tag, so the remaining child's "Sleep report updated" could not replace its first report.
    setPrefs(KID, 0, 1);
    for (const [send, title] of [
      [notifySleepReports, `Sleep report — ${OTHER_NAME}`],
      [notifySleepReportUpdates, `Sleep report updated — ${OTHER_NAME}`],
    ]) {
      sendEach.mock.resetCalls();
      send([report(KID, SECRET_NAME), report(KID2, OTHER_NAME)]);
      await settle();
      assert.equal(sendEach.mock.callCount(), 1, title);
      const msg = sendEach.mock.calls[0].arguments[0][0];
      assert.equal(msg.notification.title, title);
      assert.equal(msg.android.notification.tag, `sleep_report_${KID2}_2026-07-01`, `${title}: the remaining child's message lost its tag`);
    }
  });

  test('a child that no longer exists is not reported on', async () => {
    notifySleepReports([report('gone-kid', SECRET_NAME)]);
    await settle();
    assert.equal(sendEach.mock.callCount(), 0);
    assert.deepEqual(fetched, []);
  });
});

describe('★ "Show this child\'s name" off: the name is in NO outgoing payload, anywhere, on any provider', () => {
  for (const [label, send] of [['first report', notifySleepReports], ['update', notifySleepReportUpdates]]) {
    test(`${label}: the planted name is absent from push, Pushover, ntfy and Gotify, and "a child" takes its place`, async () => {
      setPrefs(KID, 1, 0);
      send([report()]);
      await settle();
      const o = outgoing();
      assert.ok(o.push && o.pushover && o.ntfy && o.gotify, 'every provider must have been sent something: ' + JSON.stringify(Object.keys(o).filter((k) => !o[k])));
      for (const [provider, text] of Object.entries(o)) {
        assert.ok(!text.includes(SECRET_FIRST), `${provider} carries the first name`);
        assert.ok(!text.includes(SECRET_LAST), `${provider} carries the last name`);
        assert.ok(!text.toLowerCase().includes(SECRET_FIRST.toLowerCase()), `${provider} carries the name in another case`);
        assert.match(text, /a child/i, `${provider} does not say "a child"`);
      }
      // The numbers are still there: hiding the name must not blank the report.
      assert.ok(outgoing().ntfy.includes('asleep 8h12'));
    });
  }

  test('the TITLE and the TEXT are both clean (push is the one provider with them in separate fields)', async () => {
    setPrefs(KID, 1, 0);
    notifySleepReports([report()]);
    await settle();
    const msg = sendEach.mock.calls[0].arguments[0][0];
    assert.equal(msg.notification.title, 'Sleep report — a child');
    assert.ok(msg.notification.body.startsWith('A child: asleep 8h12'));
    assert.ok(!JSON.stringify(msg).includes(SECRET_FIRST), 'the push message as a whole');
  });

  test('in a combined message each line follows its own child\'s choice', async () => {
    setPrefs(KID, 1, 0);
    notifySleepReports([report(KID, SECRET_NAME), report(KID2, OTHER_NAME)]);
    await settle();
    const text = outgoing().gotify;
    assert.ok(text.includes(OTHER_NAME), 'the child who shows their name is named');
    assert.ok(!text.includes(SECRET_FIRST) && !text.includes(SECRET_LAST));
    assert.match(text, /A child: asleep/);
  });

  test('the name choice is independent: with the name shown the planted name IS sent', async () => {
    setPrefs(KID, 1, 1);
    notifySleepReports([report()]);
    await settle();
    assert.ok(outgoing().gotify.includes(SECRET_NAME));
  });
});

describe('the children API: additive, and an admin\'s decision', () => {
  let server;
  let admin;
  let caregiver;
  before(async () => {
    server = await mountRouter('/api/children', childrenRouter);
  });
  after(async () => { await server?.close(); });
  beforeEach(() => {
    db.prepare('DELETE FROM sessions').run();
    db.prepare('DELETE FROM users WHERE id != ?').run('u-1');
    const a = makeUser(db, { id: 'u-admin', username: 'boss', role: 'admin' });
    const c = makeUser(db, { id: 'u-care', username: 'nanny', role: 'caregiver' });
    admin = signToken({ id: a.id, username: a.username, role: 'admin', sid: makeSession(db, a.id) });
    caregiver = signToken({ id: c.id, username: c.username, role: 'caregiver', sid: makeSession(db, c.id) });
  });
  const put = (id, body, token) => call(`${server.url}/api/children/${id}`, { method: 'PUT', token, body });

  test('every child already carries both fields (new keys only; none renamed or removed)', async () => {
    const r = await call(`${server.url}/api/children`, { token: caregiver });
    assert.equal(r.status, 200);
    for (const kid of r.body) {
      assert.equal(kid.sleep_report_enabled, 1);
      assert.equal(kid.sleep_report_show_name, 1);
      for (const k of ['id', 'name', 'birthday', 'color', 'track_sleep', 'sleep_window_start', 'cameras', 'primary_camera']) {
        assert.ok(k in kid, `${k} is gone from the child`);
      }
    }
  });

  test('★ an admin can turn each off and back on, and the stored value and the response agree', async () => {
    let r = await put(KID, { sleep_report_enabled: false, sleep_report_show_name: false }, admin);
    assert.equal(r.status, 200);
    assert.equal(r.body.sleep_report_enabled, 0);
    assert.equal(r.body.sleep_report_show_name, 0);
    assert.deepEqual(sleepReportPrefs(KID), { enabled: false, showName: false });
    r = await put(KID, { sleep_report_enabled: true, sleep_report_show_name: true }, admin);
    assert.deepEqual(sleepReportPrefs(KID), { enabled: true, showName: true });
  });

  test('★ a caregiver CANNOT change either, nothing is saved, and the refusal names the field', async () => {
    for (const body of [{ sleep_report_enabled: false }, { sleep_report_show_name: false }]) {
      const r = await put(KID, { name: 'Renamed', ...body }, caregiver);
      assert.equal(r.status, 403);
      assert.equal(r.body.reason, 'admin_only_fields');
      assert.deepEqual(r.body.fields, Object.keys(body));
    }
    assert.deepEqual(sleepReportPrefs(KID), { enabled: true, showName: true });
    assert.equal(db.prepare('SELECT name FROM children WHERE id = ?').get(KID).name, SECRET_NAME, 'the rename was saved despite the refusal');
  });

  test('a caregiver re-sending the stored values (an old open page) is NOT refused, and a rename works', async () => {
    setPrefs(KID, 0, 0);
    const r = await put(KID, { name: 'Renamed', sleep_report_enabled: false, sleep_report_show_name: false }, caregiver);
    assert.equal(r.status, 200);
    assert.equal(r.body.name, 'Renamed');
    assert.deepEqual(sleepReportPrefs(KID), { enabled: false, showName: false });
  });

  test('a save that does not mention them leaves them as they were', async () => {
    setPrefs(KID, 0, 0);
    const r = await put(KID, { name: 'Renamed' }, admin);
    assert.equal(r.status, 200);
    assert.deepEqual(sleepReportPrefs(KID), { enabled: false, showName: false });
  });

  // Strict parsing (review R6d/R10/R11), for both fields and both routes. Only true/false/1/0 are on/off. Each refused
  // value is tried against BOTH stored states, so a handler that read it by truthiness (the string '0' is truthy, null
  // is falsy) changes the stored value in one of the two and is caught; a rename rides along so a partial write shows.
  // Each accepted value starts from the OPPOSITE stored value, so a value that is ignored fails too.
  const ACCEPTED = [[true, 1], [1, 1], [false, 0], [0, 0]];
  const REFUSED = ['0', '1', 'false', 'true', 'no', '', null, [], {}, 2, -1];
  const stored = (id) => db.prepare('SELECT name, sleep_report_enabled, sleep_report_show_name FROM children WHERE id = ?').get(id);
  const REPORT_FIELDS = ['sleep_report_enabled', 'sleep_report_show_name'];
  const otherOf = (field) => REPORT_FIELDS.find((k) => k !== field);
  const post = (body, token = admin) => call(`${server.url}/api/children`, { method: 'POST', token, body });

  for (const field of REPORT_FIELDS) {
    test(`PUT ${field}: true and 1 store 1, false and 0 store 0, and the response says the same`, async () => {
      for (const [v, want] of ACCEPTED) {
        const start = want ? 0 : 1;
        setPrefs(KID, start, start);
        const r = await put(KID, { [field]: v }, admin);
        assert.equal(r.status, 200, `${JSON.stringify(v)}: ${JSON.stringify(r.body)}`);
        assert.equal(r.body[field], want, `${JSON.stringify(v)} in the response`);
        assert.equal(stored(KID)[field], want, `${JSON.stringify(v)} as stored`);
        assert.equal(stored(KID)[otherOf(field)], start, `${JSON.stringify(v)} changed the OTHER switch`);
      }
    });

    test(`PUT ${field}: anything but true/false/1/0 is a 400 and writes nothing, whatever was stored`, async () => {
      for (const v of REFUSED) {
        for (const start of [0, 1]) {
          setPrefs(KID, start, start);
          const r = await put(KID, { name: 'Renamed', [field]: v }, admin);
          assert.equal(r.status, 400, `${JSON.stringify(v)} over a stored ${start}`);
          assert.match(r.body.error, /Sleep report settings must be on or off/, JSON.stringify(v));
          assert.deepEqual(stored(KID), { name: SECRET_NAME, sleep_report_enabled: start, sleep_report_show_name: start },
            `${JSON.stringify(v)} over a stored ${start} wrote something`);
        }
      }
    });

    test(`POST ${field}: true and 1 store 1, false and 0 store 0; the other switch keeps its default (on)`, async () => {
      for (const [v, want] of ACCEPTED) {
        const r = await post({ name: `New ${field} ${JSON.stringify(v)}`, [field]: v });
        assert.equal(r.status, 201, `${JSON.stringify(v)}: ${JSON.stringify(r.body)}`);
        assert.equal(r.body[field], want, `${JSON.stringify(v)} in the response`);
        assert.equal(stored(r.body.id)[field], want, `${JSON.stringify(v)} as stored`);
        assert.equal(stored(r.body.id)[otherOf(field)], 1, `${JSON.stringify(v)} changed the OTHER switch`);
      }
    });

    test(`POST ${field}: anything but true/false/1/0 is a 400 and no child is created`, async () => {
      const count = () => db.prepare('SELECT COUNT(*) n FROM children').get().n;
      const before = count();
      for (const v of REFUSED) {
        const r = await post({ name: 'Refused', [field]: v });
        assert.equal(r.status, 400, JSON.stringify(v));
        assert.match(r.body.error, /Sleep report settings must be on or off/, JSON.stringify(v));
      }
      assert.equal(count(), before, 'a refused add created a child');
    });
  }

  test('★ adding a child with the report OFF: stored off, and nothing is sent for that child (review R7)', async () => {
    const off = await post({ name: 'Quiet Newcomer', sleep_report_enabled: false });
    assert.equal(off.status, 201);
    assert.equal(off.body.sleep_report_enabled, 0);
    assert.deepEqual(sleepReportPrefs(off.body.id), { enabled: false, showName: true });
    notifySleepReports([report(off.body.id, 'Quiet Newcomer')]);
    await settle();
    assert.equal(sendEach.mock.callCount(), 0, 'push was sent for a child added with the report off');
    assert.deepEqual(fetched, [], 'a provider was sent a report for a child added with the report off');
    // The control: a child added the same way but with the report left on IS sent, so the silence above is the switch.
    const on = await post({ name: 'Loud Newcomer' });
    notifySleepReports([report(on.body.id, 'Loud Newcomer')]);
    await settle();
    assert.ok(fetched.some((f) => f.body.includes('Loud Newcomer')), 'control: the report of a child added with it on did not go out');
  });

  test('adding a child: both ON unless the admin says otherwise, and a caregiver cannot add one', async () => {
    let r = await call(`${server.url}/api/children`, { method: 'POST', token: admin, body: { name: 'Newcomer' } });
    assert.equal(r.status, 201);
    assert.deepEqual([r.body.sleep_report_enabled, r.body.sleep_report_show_name], [1, 1]);
    r = await call(`${server.url}/api/children`, { method: 'POST', token: admin, body: { name: 'Other', sleep_report_show_name: false } });
    assert.deepEqual([r.body.sleep_report_enabled, r.body.sleep_report_show_name], [1, 0]);
    r = await call(`${server.url}/api/children`, { method: 'POST', token: admin, body: { name: 'Bad', sleep_report_enabled: 'false' } });
    assert.equal(r.status, 400);
    r = await call(`${server.url}/api/children`, { method: 'POST', token: caregiver, body: { name: 'Nope' } });
    assert.equal(r.status, 403);
  });
});
