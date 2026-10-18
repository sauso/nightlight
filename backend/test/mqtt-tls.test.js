// MQTT over TLS (#537): mqtts:// with an optional CA and a verification switch.
//
// ★ NOTHING HERE IS MOCKED. The "broker" is a real socket on 127.0.0.1 that exists for one test, speaking just
// enough MQTT to answer a CONNECT with a CONNACK (the TLS ones are real TLS servers with throwaway certificates from
// fixtures/mqtt-tls.js). So `mqtt.connect` is really called with the options refreshMqttConnection builds, the
// handshake really succeeds or fails, and the verdict is read from the same mqttStatus() the Settings screen shows.
// What this CANNOT show is a real broker (Mosquitto, EMQX, Home Assistant's add-on): their MQTT is not exercised, only
// the TLS layer and a minimal CONNACK. See the PR for what that leaves unverified.
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import { useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, signToken, mountRouter, call } from './helpers/harness.js';
import {
  CA_PEM, OTHER_CA_PEM, SERVER_CERT_PEM, EXPIRED_CERT_PEM, SERVER_KEY_PEM,
} from './fixtures/mqtt-tls.js';

useTempDataDir();

const { default: db } = await import('../src/db.js');
const { default: settingsRouter } = await import('../src/routes/settings.js');
const {
  refreshMqttConnection, mqttStatus, mqttBrokerUrl, describeMqttError, parseMqttCa, MQTT_CA_MAX_CERTS, stopMqtt,
} = await import('../src/lib/mqttClient.js');
const { logger } = await import('../src/lib/logger.js');

const CONNACK = Buffer.from([0x20, 0x02, 0x00, 0x00]);

// A broker that answers MQTT CONNECT. `kind` 'plain' | 'tls'. Records what the first bytes looked like.
function startBroker({ kind = 'plain', cert = SERVER_CERT_PEM, replyGarbage = false } = {}) {
  const seen = { firstByte: null, secure: 0, tlsErrors: 0 };
  const onSocket = (socket) => {
    socket.on('error', () => {});
    socket.once('data', (buf) => {
      seen.firstByte = seen.firstByte ?? buf[0];
      if (replyGarbage) { socket.end('HTTP/1.0 400 Bad Request\r\n\r\n'); return; }
      if (buf[0] === 0x10) socket.write(CONNACK); // MQTT CONNECT
    });
  };
  const server = kind === 'tls'
    ? tls.createServer({ key: SERVER_KEY_PEM, cert }, (s) => { seen.secure++; onSocket(s); })
    : net.createServer(onSocket);
  if (kind === 'tls') server.on('tlsClientError', () => { seen.tlsErrors++; });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      seen,
      close: () => new Promise((r) => { server.close(r); server.closeAllConnections?.(); setTimeout(r, 50); }),
    }));
  });
}

const configure = (cfg) => {
  const c = { mqtt_enabled: 1, mqtt_host: '127.0.0.1', mqtt_username: null, mqtt_password: null, mqtt_tls: 0, mqtt_tls_ca: null, mqtt_tls_verify: 1, ...cfg };
  db.prepare(
    `UPDATE settings SET mqtt_enabled = ?, mqtt_host = ?, mqtt_port = ?, mqtt_username = ?, mqtt_password = ?,
       mqtt_tls = ?, mqtt_tls_ca = ?, mqtt_tls_verify = ? WHERE id = 'app'`
  ).run(c.mqtt_enabled, c.mqtt_host, c.mqtt_port, c.mqtt_username, c.mqtt_password, c.mqtt_tls, c.mqtt_tls_ca, c.mqtt_tls_verify);
  refreshMqttConnection();
};
async function until(fn, ms = 6000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
}
const off = () => { configure({ mqtt_enabled: 0, mqtt_port: 1 }); stopMqtt(); };

let brokers = [];
const broker = async (opts) => { const b = await startBroker(opts); brokers.push(b); return b; };

before(() => db.prepare("UPDATE settings SET mqtt_enabled = 0 WHERE id = 'app'").run());
after(async () => {
  off();
  for (const b of brokers) await b.close();
  db.close();
  cleanupTempDataDirs();
});
async function finish() {
  off();
  for (const b of brokers) await b.close();
  brokers = [];
}

describe('the broker URL', () => {
  test('★ the default is plain mqtt:// on 1883, exactly as before', () => {
    assert.equal(mqttBrokerUrl('broker.local', null), 'mqtt://broker.local:1883');
    assert.equal(mqttBrokerUrl('broker.local', 1884), 'mqtt://broker.local:1884');
    assert.equal(mqttBrokerUrl('broker.local', null, { tls: false }), 'mqtt://broker.local:1883');
  });

  test('TLS makes it mqtts://, on 8883 when the port is blank and on the given port otherwise', () => {
    assert.equal(mqttBrokerUrl('broker.local', null, { tls: true }), 'mqtts://broker.local:8883');
    assert.equal(mqttBrokerUrl('broker.local', 8884, { tls: true }), 'mqtts://broker.local:8884');
    assert.equal(mqttBrokerUrl('[fe80::1]', null, { tls: true }), 'mqtts://[fe80::1]:8883');
  });

  test('a bad host or port is refused with TLS exactly as without it', () => {
    for (const tlsOn of [false, true]) {
      assert.throws(() => mqttBrokerUrl('bad host', 1883, { tls: tlsOn }), /not a valid hostname/);
      assert.throws(() => mqttBrokerUrl('broker', 70000, { tls: tlsOn }), /between 1 and 65535/);
      assert.throws(() => mqttBrokerUrl('user@broker', 1883, { tls: tlsOn }), /not a valid hostname/);
    }
  });
});

describe('the CA text', () => {
  const MARK = 'ZZ-MARKER-9f3a-DO-NOT-ECHO';

  test('blank means "use the system authorities" (null), a real certificate is kept', () => {
    assert.equal(parseMqttCa(''), null);
    assert.equal(parseMqttCa('   \n '), null);
    assert.equal(parseMqttCa(undefined), null);
    assert.equal(parseMqttCa(null), null);
    assert.equal(parseMqttCa(CA_PEM), CA_PEM.trim() + '\n');
  });

  test('Windows line endings and surrounding blank space are normalised, not refused', () => {
    assert.equal(parseMqttCa(`\r\n  ${CA_PEM.replace(/\n/g, '\r\n')}  \r\n`), CA_PEM.trim() + '\n');
  });

  test('a chain of several certificates is accepted, in order', () => {
    const out = parseMqttCa(`${CA_PEM}\n${OTHER_CA_PEM}`);
    assert.equal(out, `${CA_PEM.trim()}\n${OTHER_CA_PEM.trim()}\n`);
  });

  test('★ a private key is refused by name, and the key text is not echoed', () => {
    const key = SERVER_KEY_PEM;
    assert.throws(() => parseMqttCa(key), (e) => /private key/i.test(e.message) && !e.message.includes(key.split('\n')[1]));
    // Also when it rides along with a good certificate: the whole thing is refused, nothing is half-kept.
    assert.throws(() => parseMqttCa(`${CA_PEM}\n${key}`), /private key/i);
  });

  test('junk is refused: no certificate at all, text around a certificate, a block that only looks like one', () => {
    assert.throws(() => parseMqttCa(MARK), /No certificate found/);
    assert.throws(() => parseMqttCa(`${MARK}\n${CA_PEM}`), /not a certificate/);
    assert.throws(() => parseMqttCa(`${CA_PEM}\n${MARK}`), /not a certificate/);
    assert.throws(() => parseMqttCa(`-----BEGIN CERTIFICATE-----\n${MARK}\n-----END CERTIFICATE-----`), /Certificate 1 of 1 is not a valid certificate/);
    assert.throws(() => parseMqttCa(CA_PEM.replace(/-----END CERTIFICATE-----/, '')), /No certificate found/);
  });

  test('no refusal ever repeats what was pasted', () => {
    for (const input of [MARK, `${MARK}\n${CA_PEM}`, `-----BEGIN CERTIFICATE-----\n${MARK}\n-----END CERTIFICATE-----`, `${MARK} PRIVATE KEY ${MARK}`]) {
      assert.throws(() => parseMqttCa(input), (e) => !e.message.includes(MARK));
    }
  });

  test('a non-string, and a flood, are refused', () => {
    for (const bad of [123, true, [], {}]) assert.throws(() => parseMqttCa(bad), /must be text/);
    assert.throws(() => parseMqttCa('a'.repeat(100_001)), /too long/);
    assert.throws(() => parseMqttCa(Array(MQTT_CA_MAX_CERTS + 1).fill(CA_PEM).join('\n')), /Too many certificates/);
    assert.doesNotThrow(() => parseMqttCa(Array(MQTT_CA_MAX_CERTS).fill(CA_PEM).join('\n')));
  });
});

describe('describing a connection error', () => {
  test('every TLS verification failure is a sentence that says what to do', () => {
    for (const code of ['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY']) {
      const d = describeMqttError(Object.assign(new Error('raw'), { code }));
      assert.equal(d.code, code);
      assert.match(d.message, /CA certificate/);
      assert.match(d.message, /Verify the broker's certificate/);
    }
    assert.match(describeMqttError({ code: 'CERT_HAS_EXPIRED' }).message, /expired/);
    assert.match(describeMqttError({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' }).message, /not valid for the host/);
    assert.match(describeMqttError({ code: 'ERR_SSL_WRONG_VERSION_NUMBER' }).message, /did not answer with TLS/);
    // What Node really reports for TLS spoken to a plain server (code EPROTO, reason only in the message).
    const eproto = describeMqttError(Object.assign(new Error('error:0A00010B:SSL routines:ssl3_get_record:wrong version number'), { code: 'EPROTO' }));
    assert.equal(eproto.code, 'ERR_SSL_WRONG_VERSION_NUMBER');
    assert.match(eproto.message, /did not answer with TLS/);
    // An EPROTO for any other reason keeps its own words.
    assert.match(describeMqttError(Object.assign(new Error('some other protocol problem'), { code: 'EPROTO' })).message, /some other protocol problem/);
    assert.match(describeMqttError({ code: 'ECONNREFUSED' }).message, /refused/);
  });

  test('an unknown error keeps its own words, cut short, with any certificate text removed', () => {
    const long = `boom ${'x'.repeat(500)}`;
    assert.ok(describeMqttError(new Error(long)).message.length <= 201);
    const withPem = describeMqttError(new Error(`bad ${CA_PEM} tail`));
    assert.ok(!withPem.message.includes('BEGIN CERTIFICATE'));
    assert.ok(!withPem.detail.includes(CA_PEM.split('\n')[1]));
    assert.equal(describeMqttError(null).message, 'Connection error');
  });
});

describe('★ the real connection', () => {
  test('★ default: plain mqtt:// - the broker is sent MQTT, not a TLS handshake, and status says no TLS', async () => {
    const b = await broker();
    configure({ mqtt_port: b.port });
    assert.ok(await until(() => mqttStatus().connected), 'did not connect');
    assert.equal(b.seen.firstByte, 0x10, 'the first byte on the wire was not an MQTT CONNECT');
    assert.deepEqual(mqttStatus(), { enabled: true, connected: true, tls: false, error: null, error_code: null });
    await finish();
  });

  test('★ TLS on with the broker\'s CA: connects over TLS, with no error', async () => {
    const b = await broker({ kind: 'tls' });
    configure({ mqtt_port: b.port, mqtt_tls: 1, mqtt_tls_ca: CA_PEM });
    assert.ok(await until(() => mqttStatus().connected), JSON.stringify(mqttStatus()));
    assert.equal(b.seen.secure, 1, 'the broker saw no TLS handshake');
    assert.equal(b.seen.firstByte, 0x10, 'MQTT should run inside the TLS tunnel');
    assert.deepEqual(mqttStatus(), { enabled: true, connected: true, tls: true, error: null, error_code: null });
    await finish();
  });

  test('★ TLS on, verification ON, no CA: a broker the system does not trust is REFUSED and the reason is reported', async () => {
    const b = await broker({ kind: 'tls' });
    configure({ mqtt_port: b.port, mqtt_tls: 1 });
    const st = await until(() => mqttStatus().error && mqttStatus());
    assert.ok(st, 'no error was reported');
    assert.equal(st.connected, false);
    assert.equal(st.tls, true);
    assert.ok(['UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN'].includes(st.error_code), st.error_code);
    assert.match(st.error, /Add the CA certificate/);
    assert.equal(b.seen.firstByte, null, 'MQTT bytes were sent to a broker that failed verification');
    await finish();
  });

  test('★ the WRONG CA is refused too (a CA that is configured but did not sign the broker)', async () => {
    const b = await broker({ kind: 'tls' });
    configure({ mqtt_port: b.port, mqtt_tls: 1, mqtt_tls_ca: OTHER_CA_PEM });
    const st = await until(() => mqttStatus().error && mqttStatus());
    assert.ok(st && !st.connected, JSON.stringify(st));
    assert.match(st.error_code, /UNABLE_TO|SELF_SIGNED/);
    await finish();
  });

  test('an expired broker certificate is refused, and says so', async () => {
    const b = await broker({ kind: 'tls', cert: EXPIRED_CERT_PEM });
    configure({ mqtt_port: b.port, mqtt_tls: 1, mqtt_tls_ca: CA_PEM });
    const st = await until(() => mqttStatus().error && mqttStatus());
    assert.equal(st?.error_code, 'CERT_HAS_EXPIRED', JSON.stringify(st));
    assert.match(st.error, /expired/);
    await finish();
  });

  test('verification switched OFF accepts the same untrusted broker (and logs a warning)', async () => {
    const b = await broker({ kind: 'tls' });
    configure({ mqtt_port: b.port, mqtt_tls: 1, mqtt_tls_verify: 0 });
    assert.ok(await until(() => mqttStatus().connected), JSON.stringify(mqttStatus()));
    assert.ok(logger.getRecent().some((l) => /verification is OFF/.test(l)));
    await finish();
  });

  test('★ TLS on against a broker that only speaks plain MQTT says so, instead of failing silently', async () => {
    const b = await broker({ replyGarbage: true });
    configure({ mqtt_port: b.port, mqtt_tls: 1 });
    const st = await until(() => mqttStatus().error && mqttStatus());
    assert.ok(st && !st.connected, JSON.stringify(st));
    assert.equal(st.error_code, 'ERR_SSL_WRONG_VERSION_NUMBER');
    assert.match(st.error, /did not answer with TLS/);
    await finish();
  });

  test('the error clears once the connection works, and is not reported while MQTT is off', async () => {
    const bad = await broker({ kind: 'tls' });
    configure({ mqtt_port: bad.port, mqtt_tls: 1 });
    assert.ok(await until(() => mqttStatus().error));
    configure({ mqtt_port: bad.port, mqtt_tls: 1, mqtt_tls_ca: CA_PEM }); // same broker, now trusted
    assert.ok(await until(() => mqttStatus().connected), JSON.stringify(mqttStatus()));
    assert.equal(mqttStatus().error, null);
    configure({ mqtt_enabled: 0, mqtt_port: bad.port, mqtt_tls: 1 });
    assert.deepEqual(mqttStatus(), { enabled: false, connected: false, tls: false, error: null, error_code: null });
    await finish();
  });

  test('★ turning TLS on or off reconnects (the configuration key covers it)', async () => {
    const plain = await broker();
    const secure = await broker({ kind: 'tls' });
    configure({ mqtt_port: plain.port });
    assert.ok(await until(() => mqttStatus().connected));
    assert.equal(mqttStatus().tls, false);
    configure({ mqtt_port: secure.port, mqtt_tls: 1, mqtt_tls_ca: CA_PEM });
    assert.ok(await until(() => mqttStatus().connected && mqttStatus().tls), JSON.stringify(mqttStatus()));
    await finish();
  });

  test('★ the certificate text is never written to the log, whether the connection works or not', async () => {
    const ok = await broker({ kind: 'tls' });
    configure({ mqtt_port: ok.port, mqtt_tls: 1, mqtt_tls_ca: CA_PEM });
    await until(() => mqttStatus().connected);
    configure({ mqtt_port: ok.port, mqtt_tls: 1, mqtt_tls_ca: OTHER_CA_PEM });
    await until(() => mqttStatus().error);
    const log = logger.getRecent().join('\n');
    assert.ok(!log.includes('BEGIN CERTIFICATE'), 'a certificate block reached the log');
    for (const pem of [CA_PEM, OTHER_CA_PEM]) assert.ok(!log.includes(pem.split('\n')[2]), 'part of a certificate reached the log');
    await finish();
  });

  test('★ a CA already stored that is not usable (hand-edited) leaves MQTT off and the app up, without logging it', async () => {
    const junk = 'ZZ-STORED-JUNK-77';
    assert.doesNotThrow(() => configure({ mqtt_port: 8883, mqtt_tls: 1, mqtt_tls_ca: junk }));
    assert.equal(mqttStatus().connected, false);
    const log = logger.getRecent().join('\n');
    assert.match(log, /Not connecting: the stored CA certificate is not usable/);
    assert.match(log, /MQTT stays off until the CA certificate is fixed/);
    assert.ok(!log.includes(junk), 'the stored CA text was logged');
    await finish();
  });
});

describe('the settings route', () => {
  let server;
  let admin;
  let caregiver;
  before(async () => {
    server = await mountRouter('/api/settings', settingsRouter);
    const a = makeUser(db, { id: 'u-a', username: 'boss', role: 'admin' });
    const c = makeUser(db, { id: 'u-c', username: 'nanny', role: 'caregiver' });
    admin = signToken({ id: a.id, username: a.username, role: 'admin', sid: makeSession(db, a.id) });
    caregiver = signToken({ id: c.id, username: c.username, role: 'caregiver', sid: makeSession(db, c.id) });
  });
  after(async () => { await server?.close(); });
  beforeEach(() => {
    db.prepare("UPDATE settings SET mqtt_enabled = 0, mqtt_host = NULL, mqtt_port = NULL, mqtt_password = 'LEAKPW-secret-pass', mqtt_tls = 0, mqtt_tls_ca = NULL, mqtt_tls_verify = 1 WHERE id = 'app'").run();
  });
  // mqtt_enabled stays off in every body: a successful PUT calls refreshMqttConnection, and nothing here may dial.
  const put = (body, token = admin) => call(`${server.url}/api/settings`, { method: 'PUT', token, body: { mqtt_enabled: false, ...body } });
  const stored = () => db.prepare('SELECT mqtt_tls, mqtt_tls_ca, mqtt_tls_verify, mqtt_port FROM settings WHERE id = ?').get('app');

  test('★ defaults: a fresh settings row is plain, verified, with no CA (read from the schema)', () => {
    const cols = db.prepare('PRAGMA table_info(settings)').all();
    const dflt = (n) => cols.find((c) => c.name === n)?.dflt_value;
    assert.equal(dflt('mqtt_tls'), '0');
    assert.equal(dflt('mqtt_tls_verify'), '1');
    assert.equal(dflt('mqtt_tls_ca'), null);
  });

  test('GET returns the TLS settings for an admin, the CA included, and never the password', async () => {
    db.prepare('UPDATE settings SET mqtt_tls = 1, mqtt_tls_ca = ?, mqtt_tls_verify = 0 WHERE id = ?').run(CA_PEM, 'app');
    const r = await call(`${server.url}/api/settings/mqtt`, { token: admin });
    assert.equal(r.status, 200);
    assert.equal(r.body.mqtt_tls, true);
    assert.equal(r.body.mqtt_tls_verify, false);
    assert.equal(r.body.mqtt_tls_ca, CA_PEM);
    assert.equal(r.body.mqtt_password_set, true);
    assert.ok(!JSON.stringify(r.body).includes('LEAKPW'), 'the password came back');
    assert.ok(!('mqtt_password' in r.body));
  });

  test('★ an untouched row reads back as off / on / blank', async () => {
    const r = await call(`${server.url}/api/settings/mqtt`, { token: admin });
    assert.equal(r.body.mqtt_tls, false);
    assert.equal(r.body.mqtt_tls_verify, true);
    assert.equal(r.body.mqtt_tls_ca, '');
  });

  test('★ admin-only: a caregiver can read none of it and change none of it; anonymous neither', async () => {
    assert.equal((await call(`${server.url}/api/settings/mqtt`, { token: caregiver })).status, 403);
    assert.equal((await call(`${server.url}/api/settings/mqtt`)).status, 401);
    assert.equal((await put({ mqtt_tls: true }, caregiver)).status, 403);
    assert.equal((await call(`${server.url}/api/settings`, { method: 'PUT', body: { mqtt_tls: true } })).status, 401);
    assert.equal(stored().mqtt_tls, 0);
  });

  test('the public and caregiver views of GET /settings carry none of the TLS fields', async () => {
    db.prepare('UPDATE settings SET mqtt_tls = 1, mqtt_tls_ca = ? WHERE id = ?').run(CA_PEM, 'app');
    for (const token of [undefined, caregiver, admin]) {
      const r = await call(`${server.url}/api/settings`, { token });
      assert.ok(!JSON.stringify(r.body).includes('BEGIN CERTIFICATE'), 'the CA is in /settings');
      assert.ok(!('mqtt_tls' in r.body));
    }
  });

  test('an admin saves TLS on with a CA, and the CA is stored canonically', async () => {
    const r = await put({ mqtt_host: 'broker.local', mqtt_tls: true, mqtt_tls_ca: `\r\n${CA_PEM.replace(/\n/g, '\r\n')}\r\n`, mqtt_tls_verify: true });
    assert.equal(r.status, 200);
    assert.deepEqual(stored(), { mqtt_tls: 1, mqtt_tls_ca: CA_PEM.trim() + '\n', mqtt_tls_verify: 1, mqtt_port: null });
  });

  test('★ junk is refused with 400, names the field, echoes nothing, and writes NOTHING (the rest of the body too)', async () => {
    const MARK = 'ZZ-ROUTE-MARKER-31';
    for (const ca of [MARK, `${MARK}\n${CA_PEM}`, SERVER_KEY_PEM, 12345]) {
      const r = await put({ mqtt_host: 'changed.local', mqtt_tls: true, mqtt_tls_ca: ca });
      assert.equal(r.status, 400, String(ca).slice(0, 20));
      assert.equal(r.body.field, 'mqtt_tls_ca');
      assert.ok(!JSON.stringify(r.body).includes(MARK));
    }
    assert.deepEqual(stored(), { mqtt_tls: 0, mqtt_tls_ca: null, mqtt_tls_verify: 1, mqtt_port: null });
    assert.equal(db.prepare('SELECT mqtt_host FROM settings WHERE id = ?').get('app').mqtt_host, null, 'the host was saved from a refused request');
  });

  test('a blank CA clears it; leaving the field out keeps it', async () => {
    await put({ mqtt_tls: true, mqtt_tls_ca: CA_PEM });
    assert.ok(stored().mqtt_tls_ca);
    await put({ mqtt_username: 'someone' }); // does not mention TLS at all
    assert.deepEqual([stored().mqtt_tls, !!stored().mqtt_tls_ca], [1, true]);
    await put({ mqtt_tls_ca: '' });
    assert.equal(stored().mqtt_tls_ca, null);
  });

  test('★ the switches take only on/off: "false" must not turn verification OFF by being truthy', async () => {
    for (const bad of ['false', 'no', 2, null, [], {}]) {
      for (const name of ['mqtt_tls', 'mqtt_tls_verify']) {
        const r = await put({ [name]: bad });
        assert.equal(r.status, 400, `${name}=${JSON.stringify(bad)}`);
        assert.equal(r.body.field, name);
      }
    }
    assert.deepEqual(stored(), { mqtt_tls: 0, mqtt_tls_ca: null, mqtt_tls_verify: 1, mqtt_port: null });
    assert.equal((await put({ mqtt_tls_verify: 0 })).status, 200);
    assert.equal(stored().mqtt_tls_verify, 0);
  });

  test('the host is still checked, with TLS in the URL', async () => {
    assert.equal((await put({ mqtt_host: 'bad host', mqtt_tls: true })).status, 400);
    assert.equal((await put({ mqtt_host: 'broker.local', mqtt_port: '', mqtt_tls: true })).status, 200);
  });
});
