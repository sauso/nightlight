// A bad MQTT port or host must be refused when saved, and must never be able to take the process down at boot
// (issue #543).
//
// The defect: `PUT /api/settings` stored `mqtt_port` with only `parseInt`. A value like 188333 (one digit too
// many) was written to the database; `refreshMqttConnection()` then threw a RangeError from `mqtt.connect`, so
// the request answered 500 with the value ALREADY SAVED. On every later boot the same call ran at the top level of
// index.js, before the crash guards were installed, and exited the process: a restart loop whose cure (the
// Settings screen) was unreachable, fixable only by editing the SQLite file by hand. An unbalanced `[` in the host
// threw the same way ("Invalid URL").
//
// ⚠️ TWO SEPARATE DEFENCES, TWO SEPARATE GROUPS OF TESTS, because either one can regress alone:
//   1. the SAVE refuses a bad value and writes nothing;
//   2. `refreshMqttConnection()` survives a bad value that is ALREADY stored (an older version saved it, or
//      someone edited the database), which is the boot case. The stored value is written straight to the
//      database here, deliberately bypassing the route, because that is how it got there for a real install.
//
// ⚠️ NOTHING HERE MAY DIAL A BROKER. `mqtt_enabled` is forced off for every route test (a successful PUT calls
// refreshMqttConnection, and an enabled config would dial for real and hang the suite on DNS: see
// settings-exposure.test.js). The boot tests only use values that are rejected BEFORE any connection is made.
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, signToken, mountRouter, call,
} from './helpers/harness.js';

useTempDataDir();

const { default: db } = await import('../src/db.js');
const { default: settingsRouter } = await import('../src/routes/settings.js');
const { refreshMqttConnection, mqttStatus, mqttBrokerUrl, stopMqtt } = await import('../src/lib/mqttClient.js');
const { logger } = await import('../src/lib/logger.js');

let server;
let token;
const put = (body) => call(`${server.url}/api/settings`, { method: 'PUT', token, body });
const stored = () => db.prepare('SELECT mqtt_enabled, mqtt_host, mqtt_port FROM settings WHERE id = ?').get('app');
const notConnecting = () => logger.getRecent().filter((l) => l.includes('[mqtt] Not connecting')).length;

before(async () => {
  server = await mountRouter('/api/settings', settingsRouter);
  const admin = makeUser(db, { id: 'u-a', username: 'admin', role: 'admin' });
  token = signToken({ id: admin.id, username: admin.username, role: 'admin', sid: makeSession(db, admin.id) });
});

after(async () => {
  stopMqtt();
  await server.close();
  cleanupTempDataDirs();
});

beforeEach(() => {
  db.prepare("UPDATE settings SET mqtt_enabled = 0, mqtt_host = 'broker.example', mqtt_port = 1883 WHERE id = 'app'").run();
});

describe('#543 the save refuses a bad port and writes nothing', () => {
  // A string and a number of each kind, because the settings screen sends a string and an API client may not.
  const BAD_PORTS = [
    [188333, 'one digit too many (188333)'], ['188333', 'the same as a string'], [65536, 'just over the top (65536)'],
    ['65536', '65536 as a string'], ['0', 'the string "0" (0 is not a port)'], [-1, 'negative'], ['-1', 'negative as a string'],
    ['1883abc', 'a number with trailing text (parseInt would have read 1883)'], ['abc', 'text'], [1883.5, 'a fraction'],
    ['18.5', 'a fraction as a string'], [true, 'a boolean'], [{}, 'an object'], [['1883'], 'an array'],
  ];
  for (const [value, label] of BAD_PORTS) {
    test(`port ${label} is a 400 with a readable message and nothing is saved`, async () => {
      const before = stored();
      const res = await put({ mqtt_port: value, app_name: 'Changed' });
      assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
      assert.match(res.body.error, /MQTT port must be a whole number between 1 and 65535/);
      assert.deepEqual(stored(), before, 'a rejected save must not write the broker settings');
      assert.notEqual(db.prepare("SELECT app_name FROM settings WHERE id = 'app'").get().app_name, 'Changed',
        'a rejected save must not apply the other fields in the same request either');
    });
  }

  test('the edges 1 and 65535 are accepted, as a number or a string', async () => {
    for (const [value, expected] of [[1, 1], ['65535', 65535], [65535, 65535], ['1', 1], [' 8883 ', 8883]]) {
      const res = await put({ mqtt_port: value });
      assert.equal(res.status, 200, `${JSON.stringify(value)}: ${JSON.stringify(res.body)}`);
      assert.equal(stored().mqtt_port, expected);
    }
  });

  test('a blank port still means "the default" and is stored as NULL, as before', async () => {
    for (const blank of ['', '   ', null, 0]) {
      db.prepare("UPDATE settings SET mqtt_port = 8883 WHERE id = 'app'").run();
      const res = await put({ mqtt_port: blank });
      assert.equal(res.status, 200, JSON.stringify(blank));
      assert.equal(stored().mqtt_port, null, `${JSON.stringify(blank)} should clear the port`);
    }
  });

  test('a save that does not mention the port leaves it alone', async () => {
    db.prepare("UPDATE settings SET mqtt_port = 8883 WHERE id = 'app'").run();
    const res = await put({ app_name: 'Still Fine' });
    assert.equal(res.status, 200);
    assert.equal(stored().mqtt_port, 8883);
  });
});

describe('#543 the save refuses a host that is not just a hostname or address', () => {
  const BAD_HOSTS = [
    ['[', 'an unbalanced bracket (the one that threw "Invalid URL")'], ['bro ker', 'a space'], ['a/b', 'a path'],
    ['user@host', 'a user name'], ['host?x', 'a query'], ['host#x', 'a fragment'], ['a:b', 'a colon and text'],
  ];
  for (const [host, label] of BAD_HOSTS) {
    test(`host ${label} is a 400 and nothing is saved`, async () => {
      const before = stored();
      const res = await put({ mqtt_host: host });
      assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
      assert.match(res.body.error, /MQTT broker is not usable/);
      assert.deepEqual(stored(), before);
    });
  }

  test('ordinary hosts are accepted: a name, an IPv4 address, a bracketed IPv6 address, mixed case', async () => {
    for (const host of ['broker.local', '192.168.1.5', '[::1]', 'MQTT.Example.COM', 'x_y.local']) {
      const res = await put({ mqtt_host: host });
      assert.equal(res.status, 200, `${host}: ${JSON.stringify(res.body)}`);
      assert.equal(stored().mqtt_host, host);
    }
  });

  test('a blank host means "not configured" and is stored as NULL', async () => {
    const res = await put({ mqtt_host: '   ' });
    assert.equal(res.status, 200);
    assert.equal(stored().mqtt_host, null);
  });

  test('a good host with a bad stored port is refused with the PORT named, so the admin knows what to fix', async () => {
    db.prepare("UPDATE settings SET mqtt_port = 188333 WHERE id = 'app'").run();
    const res = await put({ mqtt_host: 'broker.local' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /port 188333/);
  });
});

describe('#543 a bad value that is ALREADY stored must not take the process down', () => {
  // `mqtt_enabled = 1` with a host is what makes refreshMqttConnection try to connect; the values below are all
  // rejected before any socket is opened.
  const storeBad = (host, port) =>
    db.prepare("UPDATE settings SET mqtt_enabled = 1, mqtt_host = ?, mqtt_port = ? WHERE id = 'app'").run(host, port);

  test('a stored out-of-range port: refreshMqttConnection does not throw, MQTT stays off, and it says why', () => {
    storeBad('broker.local', 188333);
    const before = notConnecting();
    assert.doesNotThrow(() => refreshMqttConnection());
    assert.equal(mqttStatus().connected, false);
    assert.equal(notConnecting(), before + 1, 'no log line explained why MQTT is off');
    assert.match(logger.getRecent().filter((l) => l.includes('[mqtt] Not connecting')).at(-1), /188333/);
  });

  test('a stored malformed host does not throw either', () => {
    storeBad('[', 1883);
    assert.doesNotThrow(() => refreshMqttConnection());
    assert.equal(mqttStatus().connected, false);
  });

  test('★ a failed attempt is NOT remembered as "already configured": the next call tries (and says why) again', () => {
    // Otherwise the cache key set before the attempt would make every later refresh a silent no-op, and an admin who
    // fixed the value would find MQTT still dead until a restart.
    storeBad('broker.local', 188333);
    const before = notConnecting();
    refreshMqttConnection();
    refreshMqttConnection();
    assert.equal(notConnecting(), before + 2, 'the second call did not retry');
  });

  test('a save that does not touch the broker, with a bad value already stored and MQTT enabled, succeeds instead of answering 500', async () => {
    // refreshMqttConnection is what every settings save and camera edit calls. It used to throw out of the handler
    // AFTER the write, so the client saw a 500 for a save that had in fact been applied.
    //
    // ⚠️ A port NO EARLIER TEST USES, on purpose. The old code set its "already configured" cache key BEFORE the
    // connect that threw, so a second refresh with the identical bad config returned early and did not throw. Reusing
    // 188333 here made this test pass against the old source (found when it was run there): it only discriminates
    // when this is the first attempt at this configuration.
    storeBad('broker.local', 199999);
    const res = await put({ app_name: 'Saved Anyway' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(db.prepare("SELECT app_name FROM settings WHERE id = 'app'").get().app_name, 'Saved Anyway');
    assert.equal(mqttStatus().connected, false);
    // And the admin can repair the broker settings from the screen: fixing the port (and switching MQTT off so the
    // test dials nothing) is accepted.
    const fixed = await put({ mqtt_port: 8883, mqtt_enabled: false });
    assert.equal(fixed.status, 200, JSON.stringify(fixed.body));
    assert.equal(stored().mqtt_port, 8883);
  });
});

describe('#543 mqttBrokerUrl, the one definition of a usable broker', () => {
  test('builds the URL, defaulting a blank port to 1883', () => {
    assert.equal(mqttBrokerUrl('broker.local', 8883), 'mqtt://broker.local:8883');
    assert.equal(mqttBrokerUrl('broker.local', null), 'mqtt://broker.local:1883');
    assert.equal(mqttBrokerUrl('broker.local', '1883'), 'mqtt://broker.local:1883');
  });

  test('rejects a port outside 1-65535 and a host that is not a plain authority', () => {
    for (const port of [0.5, -1, 65536, 188333, 'x']) assert.throws(() => mqttBrokerUrl('h', port), /port/);
    for (const host of ['[', 'a b', 'a/b', 'u@h', 'h?q', 'h#f', '']) assert.throws(() => mqttBrokerUrl(host, 1883), /host/);
  });
});
