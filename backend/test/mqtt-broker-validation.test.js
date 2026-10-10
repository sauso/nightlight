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
import { createServer } from 'node:net';
import { domainToASCII } from 'node:url';
import mqtt from 'mqtt';
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
    // #641 must not narrow what worked: underscore, dash, bracketed IPv6 (also with an embedded IPv4), mixed case,
    // internationalised and punycode names, a trailing dot and a bare label are all hosts people really type.
    for (const host of ['broker.local', '192.168.1.5', '[::1]', 'MQTT.Example.COM', 'x_y.local', 'my-broker', 'mosquitto',
      '[fe80::1]', '[2001:DB8::1]', '[::ffff:1.2.3.4]', 'bücher.example', 'xn--bcher-kva.example', 'broker.local.']) {
      const res = await put({ mqtt_host: host });
      assert.equal(res.status, 200, `${host}: ${JSON.stringify(res.body)}`);
      assert.equal(stored().mqtt_host, host);
    }
  });

  // #641: hosts the WHATWG URL parser (the only check before #641) accepts but mqtt.js's legacy url.parse reads as a DIFFERENT
  // host. Each was verified against the real mqtt.js parse (see the "same host" group below for the proof) before it
  // was listed. The first group is the report's own examples; the rest is one per character class.
  const MISREAD_HOSTS = [
    ['local\nbroker', 'an embedded line break (the URL parser deletes it: reads "localbroker")'],
    ['local\r\nbroker', 'an embedded CR LF'], ['local\tbroker', 'an embedded tab'], ['broker\u0000x', 'a NUL'],
    ['broker\u001bx', 'another control character (ESC)'], ['broker\u007fx', 'DEL'],
    ['broker;x', 'a semicolon (mqtt.js ends the host there)'], ["broker'x", 'an apostrophe'], ['broker%20x', 'a percent escape'],
    ['broker\u00a0x', 'a no-break space'], ['broker\u200bx', 'a zero-width space'], ['broker\u2028x', 'a line separator'],
    ['broker\\x', 'a backslash'], ['broker,x', 'a comma'], ['broker*x', 'an asterisk'], ['broker"x', 'a double quote'],
    ['broker:x', 'a colon in a name'], ['[::1]x', 'text after an IPv6 literal'], ['x[::1]', 'text before an IPv6 literal'],
    ['[::g]', 'a non-hex character in an IPv6 literal'], ['[]', 'an empty IPv6 literal'], ['[::1%25eth0]', 'an IPv6 zone id'],
    ['[1:2]', 'an IPv6 literal that is not an address'],
  ];
  for (const [host, label] of MISREAD_HOSTS) {
    test(`#641 host ${label} is refused with a message naming the host, and nothing is saved`, async () => {
      const before = stored();
      const res = await put({ mqtt_host: host, mqtt_port: 8883 });
      assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
      assert.match(res.body.error, /MQTT broker is not usable: the host .* is not a valid hostname or address/);
      assert.deepEqual(stored(), before);
    });
  }

  test('#641 the unusable host is shown in the message as typed, escaped, so an invisible character can be seen', async () => {
    const res = await put({ mqtt_host: 'local\nbroker' });
    assert.equal(res.status, 400);
    assert.ok(res.body.error.includes('"local\\nbroker"'), res.body.error);
  });

  test('#641 an invisible character in the host is spelled out in the message, a plain space is left alone', async () => {
    const nbsp = String.fromCodePoint(0xa0);
    const res = await put({ mqtt_host: `broker${nbsp}x` });
    assert.equal(res.status, 400);
    assert.ok(res.body.error.includes('"broker\\u00a0x"'), res.body.error);
    assert.ok(!res.body.error.includes(nbsp), 'the raw invisible character must not appear in the message');
    assert.ok((await put({ mqtt_host: 'bro ker' })).body.error.includes('"bro ker"'));
  });

  test('#641 a letter the legacy parser cannot convert is refused rather than left to fail inside mqtt.js', async () => {
    // U+037A (Greek ypogegrammeni) is a letter, passes the character class, and has no valid punycode form:
    // mqtt.js threw "Invalid URL" for it in the sweep below, so the SAVE must refuse it.
    const res = await put({ mqtt_host: `a${String.fromCodePoint(0x37a)}b` });
    assert.equal(res.status, 400, JSON.stringify(res.body));
  });

  test('#641 surrounding spaces and line breaks are trimmed, inner ones are not', async () => {
    const res = await put({ mqtt_host: '  broker.local \n' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(stored().mqtt_host, 'broker.local');
    assert.equal((await put({ mqtt_host: ' broker. local ' })).status, 400);
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

  test('#643 S5: a save that changes ONLY the port is refused while the STORED host is bad, with the host named', async () => {
    // The mirror of the test above. The host is checked when the host OR the port is sent; a route that only checked
    // it when the host field was present would let a port-only save pass over a host that can never connect, and the
    // admin would think the broker was fixed. The bad host is written straight to the database (as an older version
    // could have stored it).
    db.prepare("UPDATE settings SET mqtt_host = 'bro ker', mqtt_port = 1883 WHERE id = 'app'").run();
    const res = await put({ mqtt_port: 8883 });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.match(res.body.error, /the host "bro ker"/);
    assert.equal(stored().mqtt_port, 1883, 'the refused port must not be written');
    // And it is not the port that was refused: the same port over a good host is accepted.
    db.prepare("UPDATE settings SET mqtt_host = 'broker.local' WHERE id = 'app'").run();
    assert.equal((await put({ mqtt_port: 8883 })).status, 200);
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
    for (const host of ['[', 'a b', 'a/b', 'u@h', 'h?q', 'h#f', '', '   ', 'a\nb', null, undefined, 42, {}]) assert.throws(() => mqttBrokerUrl(host, 1883), /host/);
  });

  test('#643 Q9: a stored port of 0 means the default 1883, like a blank one (`||`, not `??`)', () => {
    // Older versions stored the port with parseInt, so a "0" typed or sent by a client became the number 0 and the
    // broker was dialled on 1883. A port of 0 is therefore "no port", not "port 0". With `port ?? 1883` the 0 is
    // kept, fails the 1-65535 check and MQTT stays off at boot for an install that worked.
    for (const blank of [0, null, undefined, '']) {
      assert.equal(mqttBrokerUrl('broker.local', blank), 'mqtt://broker.local:1883', JSON.stringify(blank));
    }
    // The route still refuses a typed "0" (see BAD_PORTS above): only the already-stored 0 keeps working.
    assert.throws(() => mqttBrokerUrl('broker.local', '0'), /port/);
  });

  test('#643 Q9: the string "0" in the database really is read back as the number 0 (column affinity), so the case above is the boot case', () => {
    db.prepare("UPDATE settings SET mqtt_port = '0' WHERE id = 'app'").run();
    const { mqtt_port: port, t } = db.prepare("SELECT mqtt_port, typeof(mqtt_port) AS t FROM settings WHERE id = 'app'").get();
    assert.equal(t, 'integer');
    assert.equal(mqttBrokerUrl('broker.local', port), 'mqtt://broker.local:1883');
  });

  test('the host is trimmed in the URL, so a stored value with stray spaces connects where it was meant to', () => {
    assert.equal(mqttBrokerUrl('  broker.local\n', 8883), 'mqtt://broker.local:8883');
  });
});

// #641: "the check passes" must mean "mqtt.js connects to this host", not just "the WHATWG URL parser likes it". These
// feed the SAME string to the real mqtt.js and compare. `manualConnect` makes mqtt.connect parse its arguments (with
// the legacy `url.parse`) and build the client WITHOUT opening a socket, so nothing is dialled and nothing needs
// closing.
describe('#641 mqttBrokerUrl and mqtt.js read the same host', () => {
  const mqttjsReads = (brokerUrl) => {
    const o = mqtt.connect(brokerUrl, { manualConnect: true }).options;
    return { host: o.host, port: o.port, auth: o.auth, username: o.username, path: o.path };
  };
  // What mqtt.js ought to dial for a host we accepted: the typed name (surrounding spaces trimmed, as the app does)
  // lowercased, or its punycode form if it has non-ASCII letters; an IPv6 literal without its brackets.
  const expectedHost = (typed) => {
    const host = typed.trim();
    if (host.startsWith('[')) return host.slice(1, -1).toLowerCase();
    return [...host].every((ch) => ch.charCodeAt(0) < 128) ? host.toLowerCase() : domainToASCII(host);
  };

  test('every accepted host is dialled by mqtt.js on that host and that port, with no user name and no path', () => {
    const hosts = ['broker.local', 'MQTT.Example.COM', 'x_y.local', 'my-broker', '192.168.1.5', 'broker.local.', 'bücher.example',
      'xn--bcher-kva.example', '[::1]', '[fe80::1]', '[2001:DB8::1]', '[::ffff:1.2.3.4]', 'a'.repeat(64) + '.example',
      // All-ASCII names go through exactly as typed: no IPv4 rewriting (domainToASCII turns 1.2.3 into 1.2.0.3) and no
      // refusal of a name that ends in a number (domainToASCII returns '' for it).
      '1.2.3', 'broker.1'];
    for (const host of hosts) {
      for (const port of [null, 1883, 8883, 65535]) {
        const url = mqttBrokerUrl(host, port);
        const read = mqttjsReads(url);
        assert.equal(read.host, expectedHost(host), `${host}: mqtt.js dials ${read.host} (from ${url})`);
        assert.equal(read.port, port || 1883, `${host}: mqtt.js dials port ${read.port} (from ${url})`);
        assert.equal(read.auth ?? read.username, undefined, `${host}: mqtt.js read a user name from ${url}`);
      }
    }
  });

  test('★ the reported hosts: before the fix the URL check passed them and mqtt.js dialled a different host', () => {
    // This is the demonstration of the defect itself: build the URL the OLD check would have built (the host
    // unchanged after the WHATWG parse) and show mqtt.js reads another host. If mqtt.js ever fixes this, these stop
    // differing and the guard is merely redundant, which is fine; the next test is what must always hold.
    for (const host of ['broker;x', "broker'x", 'broker%20x']) {
      const u = new URL(`mqtt://${host}:8883`);
      assert.equal(u.port, '8883', `${host}: the WHATWG parser accepted it with the right port`);
      assert.notEqual(mqttjsReads(`mqtt://${host}:8883`).host, host, `${host}: mqtt.js dials a different host`);
      assert.throws(() => mqttBrokerUrl(host, 8883), /valid hostname/);
    }
    assert.equal(new URL('mqtt://local\nbroker:1883').hostname, 'localbroker', 'the URL parser deletes a line break');
    assert.throws(() => mqttBrokerUrl('local\nbroker', 1883), /valid hostname/);
  });

  test('★ every single character: if mqttBrokerUrl accepts a host with it, mqtt.js dials exactly that host', () => {
    // Exhaustive over the Basic Multilingual Plane (surrogates are not characters), in the middle of a name, at its
    // start and at its end. A character that either parser treats specially (ends the host, is deleted, becomes a
    // path) and that the alphabet lets through shows up here as a host mismatch. This is the test that makes
    // "the two cannot disagree" a checked claim rather than a comment.
    const mismatches = [];
    let accepted = 0;
    for (let cp = 0; cp <= 0xffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const c = String.fromCodePoint(cp);
      for (const host of [`a${c}b`, `${c}ab`, `ab${c}`]) {
        let url;
        try { url = mqttBrokerUrl(host, 8883); } catch { continue; }
        accepted++;
        let read;
        try { read = mqttjsReads(url); } catch (e) { mismatches.push(`U+${cp.toString(16)} in ${JSON.stringify(host)}: mqtt.js threw ${e.message}`); continue; }
        if (read.host !== expectedHost(host) || read.port !== 8883 || read.path !== undefined || (read.auth ?? read.username) !== undefined) {
          mismatches.push(`U+${cp.toString(16)} in ${JSON.stringify(host)}: mqtt.js reads ${JSON.stringify(read)}`);
        }
      }
    }
    assert.ok(accepted > 1000, `the sweep accepted only ${accepted} hosts: the alphabet is far narrower than intended`);
    assert.deepEqual(mismatches.slice(0, 10), [], `${mismatches.length} characters are read differently by mqtt.js`);
  });
});

describe('#643 Q11: after a failed connect the client is gone', () => {
  // A previous, live client then a stored value that cannot connect: refreshMqttConnection ends the old client and
  // the new connect throws. `client` must be NULL afterwards. Left pointing at the ended client, a later
  // "disabled" refresh would tear it down AGAIN and log "Disconnected" for a connection that no longer exists,
  // and subscribeAllCameraTopics would call subscribe on a dead client.
  //
  // The first connection goes to a local listener that accepts the TCP connection and says nothing: no broker is
  // dialled, mqtt.js just sits in "connecting".
  const sockets = new Set();
  let listener;
  before(async () => {
    listener = createServer((s) => { sockets.add(s); s.on('error', () => {}); });
    await new Promise((r) => listener.listen(0, '127.0.0.1', r));
  });
  after(async () => {
    stopMqtt();
    for (const s of sockets) s.destroy();
    await new Promise((r) => listener.close(r));
  });

  const disconnectedLogs = () => logger.getRecent().filter((l) => l.includes('[mqtt] Disconnected (disabled or unconfigured)')).length;

  test('a disabled refresh right after a failed connect does not report a disconnect', () => {
    db.prepare("UPDATE settings SET mqtt_enabled = 0 WHERE id = 'app'").run();
    refreshMqttConnection(); // make sure no client is left over from an earlier test

    db.prepare("UPDATE settings SET mqtt_enabled = 1, mqtt_host = '127.0.0.1', mqtt_port = ? WHERE id = 'app'").run(listener.address().port);
    refreshMqttConnection(); // a live (connecting) client now exists
    let before = disconnectedLogs();
    // Control: with a client, the same disabled refresh DOES report it, so the assertion below is not vacuous.
    db.prepare("UPDATE settings SET mqtt_enabled = 0 WHERE id = 'app'").run();
    refreshMqttConnection();
    assert.equal(disconnectedLogs(), before + 1, 'control: tearing down a live client should log once');

    db.prepare("UPDATE settings SET mqtt_enabled = 1, mqtt_host = '127.0.0.1', mqtt_port = ? WHERE id = 'app'").run(listener.address().port);
    refreshMqttConnection(); // live again
    db.prepare("UPDATE settings SET mqtt_port = 199997 WHERE id = 'app'").run();
    assert.doesNotThrow(() => refreshMqttConnection()); // ends the live client, the new connect throws
    assert.equal(mqttStatus().connected, false);

    before = disconnectedLogs();
    db.prepare("UPDATE settings SET mqtt_enabled = 0 WHERE id = 'app'").run();
    refreshMqttConnection();
    assert.equal(disconnectedLogs(), before, 'the failed connect left a stale client behind');
  });
});
