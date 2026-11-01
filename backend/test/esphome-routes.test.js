import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, signToken, call } from './helpers/harness.js';

useTempDataDir();
const { default: db } = await import('../src/db.js');
const { default: router } = await import('../src/routes/esphome.js');
const { demoGuard } = await import('../src/middleware/demoMode.js');
const { stopEsphome } = await import('../src/lib/esphomeManager.js');
let server;
let base;
let admin;
let caregiver;
// The server side of the latest request: the stalled-download tests watch it to know when the export is waiting.
let lastResponse = null;
// Per response: its listener counts before any route ran, whether the handler called res.end(), and any write after it.
const trace = new WeakMap();
const KEY = Buffer.alloc(32, 3).toString('base64');
const KEY2 = Buffer.alloc(32, 4).toString('base64');

before(async () => {
  makeUser(db, { id: 'admin', username: 'admin', role: 'admin' });
  makeUser(db, { id: 'caregiver', username: 'caregiver', role: 'caregiver' });
  admin = signToken({ id: 'admin', username: 'admin', role: 'admin', sid: makeSession(db, 'admin') });
  caregiver = signToken({ id: 'caregiver', username: 'caregiver', role: 'caregiver', sid: makeSession(db, 'caregiver') });
  db.prepare("INSERT INTO children (id, name) VALUES ('child-a', 'Sample A'), ('child-b', 'Sample B')").run();
  const app = express();
  app.use(express.json(), demoGuard);
  app.use((req, res, next) => {
    lastResponse = res;
    const t = { drain: res.listenerCount('drain'), close: res.listenerCount('close'), ended: false, writesAfterEnd: 0 };
    trace.set(res, t);
    const { write, end } = res;
    res.write = function traceWrite(...args) { if (t.ended) t.writesAfterEnd++; return write.apply(this, args); };
    res.end = function traceEnd(...args) { t.ended = true; return end.apply(this, args); };
    next();
  });
  app.use('/api/esphome', router);
  server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { stopEsphome(); await new Promise((resolve) => server.close(resolve)); db.close(); cleanupTempDataDirs(); });
const api = (path, options = {}) => call(`${base}/api/esphome${path}`, options);

test('#506 key save, blank keep, new key validation, clear and secret-free replies', async () => {
  const created = await api('/devices', { method: 'POST', token: admin,
    body: { name: 'Neutral sensor', host: '127.0.0.1', key: KEY, enabled: false, child_id: 'child-a' } });
  assert.equal(created.status, 201);
  const id = created.body.id;
  assert.equal(created.body.key_set, true);
  assert.ok(!JSON.stringify(created.body).includes(KEY));
  assert.equal(db.prepare('SELECT encryption_key FROM esphome_devices WHERE id = ?').get(id).encryption_key, KEY);
  const list = await api('/devices', { token: admin });
  assert.equal(list.status, 200);
  assert.ok(!JSON.stringify(list.body).includes(KEY));
  assert.ok(!JSON.stringify(list.body).includes(KEY.slice(0, 4)));

  const kept = await api(`/devices/${id}`, { method: 'PUT', token: admin, body: { key: '', name: 'Renamed' } });
  assert.equal(kept.status, 200);
  assert.equal(db.prepare('SELECT encryption_key FROM esphome_devices WHERE id = ?').get(id).encryption_key, KEY);
  const malformed = await api(`/devices/${id}`, { method: 'PUT', token: admin, body: { key: 'bad' } });
  assert.equal(malformed.status, 400);
  assert.ok(!JSON.stringify(malformed.body).includes('bad'));
  assert.equal(db.prepare('SELECT encryption_key FROM esphome_devices WHERE id = ?').get(id).encryption_key, KEY);
  const replaced = await api(`/devices/${id}`, { method: 'PUT', token: admin, body: { key: KEY2 } });
  assert.equal(replaced.status, 200);
  assert.ok(!JSON.stringify(replaced.body).includes(KEY2));
  const cleared = await api(`/devices/${id}`, { method: 'PUT', token: admin, body: { clear_key: true } });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.key_set, false);
  assert.equal(db.prepare('SELECT encryption_key FROM esphome_devices WHERE id = ?').get(id).encryption_key, null);
});

test('#506 moving a child keeps old readings with the old child; export is UTC and neutralises formulas', async () => {
  const id = db.prepare('SELECT id FROM esphome_devices LIMIT 1').get().id;
  db.prepare(`INSERT INTO esphome_entities (device_id, object_id, child_id, kind, name)
    VALUES (?, 'rate', 'child-a', 'sensor', '=formula')`).run(id);
  const entityId = db.prepare('SELECT id FROM esphome_entities WHERE device_id = ?').get(id).id;
  const bucket = Math.floor(Date.parse('2026-10-01T12:34:00Z') / 60000);
  db.prepare('INSERT INTO esphome_readings (entity_id, bucket, last, mean, min, max, n) VALUES (?, ?, 1, 1, 1, 1, 1)')
    .run(entityId, bucket);
  const moved = await api(`/devices/${id}`, { method: 'PUT', token: admin, body: { child_id: 'child-b' } });
  assert.equal(moved.status, 200);
  assert.deepEqual(db.prepare('SELECT child_id, active FROM esphome_entities WHERE device_id = ? ORDER BY id').all(id),
    [{ child_id: 'child-a', active: 0 }, { child_id: 'child-b', active: 1 }]);
  const exported = await api(`/export?device=${id}&from=2026-10-01T00:00:00Z&to=2026-10-02T00:00:00Z`, { token: admin });
  assert.equal(exported.status, 200);
  assert.match(String(exported.body), /2026-10-01T12:34:00\.000Z/);
  assert.match(String(exported.body), /#1/);
  assert.match(String(exported.body), /'=formula/);
  assert.match(String(exported.body), /child-a/);
  // The device is named only as #id: neither the admin's label ("Renamed", set above) nor the stored key may reach the file.
  db.prepare('UPDATE esphome_devices SET encryption_key = ? WHERE id = ?').run(KEY, id);
  const again = await api(`/export?device=${id}&from=2026-10-01T00:00:00Z&to=2026-10-02T00:00:00Z`, { token: admin });
  assert.ok(!String(again.body).includes('Renamed'), 'the admin label reached the CSV');
  assert.ok(!String(again.body).includes(KEY), 'the stored key reached the CSV');
  // The range cap is 31 days: exactly 31 is allowed, one second more is refused.
  assert.equal((await api(`/export?device=${id}&from=2026-10-01T00:00:00Z&to=2026-11-01T00:00:00Z`, { token: admin })).status, 200);
  assert.equal((await api(`/export?device=${id}&from=2026-10-01T00:00:00Z&to=2026-11-01T00:00:01Z`, { token: admin })).status, 400);
  assert.equal((await api(`/export?device=${id}`, { token: admin })).status, 400);
  assert.equal((await api(`/export?device=${id}&from=2026-01-01&to=2026-03-01`, { token: admin })).status, 400);
});

test('#506 settings, host rejection, admin gate and demo block', async () => {
  assert.deepEqual((await api('/settings', { token: admin })).body, { retention_days: 30 });
  assert.equal((await api('/settings', { method: 'PUT', token: admin, body: { retention_days: 0 } })).status, 400);
  assert.equal((await api('/settings', { method: 'PUT', token: admin, body: { retention_days: 365 } })).status, 200);
  assert.equal((await api('/settings', { token: admin })).body.retention_days, 365);
  const host = await api('/devices', { method: 'POST', token: admin, body: { name: 'Other', host: 'sensor.local' } });
  assert.equal(host.status, 400);
  assert.match(host.body.error, /IP address/);
  assert.equal((await api('/devices', { method: 'POST', token: admin,
    body: { name: 'Other', host: 'sensor.local.' } })).status, 400);
  assert.equal((await api('/devices', { token: caregiver })).status, 403);
  process.env.DEMO_MODE = 'true';
  try { assert.equal((await api('/devices', { token: admin })).status, 403); }
  finally { delete process.env.DEMO_MODE; }
});

test('#506 deleting a device removes its entity history', async () => {
  const id = db.prepare('SELECT id FROM esphome_devices LIMIT 1').get().id;
  const entityId = db.prepare('SELECT id FROM esphome_entities WHERE device_id = ? LIMIT 1').get(id).id;
  const add = db.prepare('INSERT OR IGNORE INTO esphome_readings (entity_id, bucket, n) VALUES (?, ?, 0)');
  db.transaction(() => { for (let bucket = 1; bucket <= 1002; bucket++) add.run(entityId, bucket); })();
  assert.ok(db.prepare('SELECT COUNT(*) AS n FROM esphome_readings').get().n > 1000);
  assert.equal((await api(`/devices/${id}`, { method: 'DELETE', token: admin })).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM esphome_readings').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM esphome_entities').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM esphome_devices').get().n, 0);
});

test('#506 device count is capped at eight', async () => {
  for (let i = 0; i < 8; i++) {
    const result = await api('/devices', { method: 'POST', token: admin,
      body: { name: `Unit ${i}`, host: '127.0.0.1', enabled: false } });
    assert.equal(result.status, 201);
  }
  assert.equal((await api('/devices', { method: 'POST', token: admin,
    body: { name: 'Ninth unit', host: '127.0.0.1', enabled: false } })).status, 400);
});

// Devices for the export tests below go straight into the table: the eight-device cap above applies to the route only.
const exportDevice = (objectId, name = objectId) => {
  const deviceId = Number(db.prepare("INSERT INTO esphome_devices (name, host, enabled) VALUES ('Export unit', '127.0.0.1', 0)").run().lastInsertRowid);
  const entityId = Number(db.prepare("INSERT INTO esphome_entities (device_id, object_id, kind, name) VALUES (?, ?, 'sensor', ?)")
    .run(deviceId, objectId, name).lastInsertRowid);
  return { deviceId, entityId };
};

test('#506 export keeps negative numbers as numbers and still neutralises text that could be a formula', async () => {
  const { deviceId, entityId } = exportDevice('signed', '-cmd');
  db.prepare('INSERT INTO esphome_readings (entity_id, bucket, last, mean, min, max, n, nzero, nmiss) VALUES (?, ?, -3.5, -3.5, -4, -3, 2, 5, 1)')
    .run(entityId, Math.floor(Date.parse('2026-10-03T08:00:00Z') / 60000));
  const res = await api(`/export?device=${deviceId}&from=2026-10-03T00:00:00Z&to=2026-10-04T00:00:00Z`, { token: admin });
  assert.equal(res.status, 200);
  // The zero count (#506 review, round 2) sits between n and nmiss, as the header says.
  assert.equal(String(res.body).split('\r\n')[0], 'minute_utc,device,entity,child,last,mean,min,max,n,nzero,nmiss');
  assert.ok(String(res.body).includes(`"'-cmd",,"-3.5","-3.5","-4","-3","2","5","1"`), String(res.body));
});

test('#506 export from/to without a Z or offset are read as UTC, whatever zone the server runs in', async () => {
  const previous = process.env.TZ;
  // UTC+14: a time read in the server's zone would move the window by 14 hours and miss the row.
  process.env.TZ = 'Pacific/Kiritimati';
  try {
    assert.equal(new Date(2026, 9, 5, 12).getTimezoneOffset(), -840,
      'this Node cannot change its zone at runtime, so the test cannot tell UTC from local time');
    const { deviceId, entityId } = exportDevice('zoned');
    db.prepare('INSERT INTO esphome_readings (entity_id, bucket, last, mean, min, max, n) VALUES (?, ?, 1, 1, 1, 1, 1)')
      .run(entityId, Math.floor(Date.parse('2026-10-05T12:34:00Z') / 60000));
    const bare = await api(`/export?device=${deviceId}&from=2026-10-05T12:00:00&to=2026-10-05T13:00`, { token: admin });
    assert.equal(bare.status, 200);
    assert.match(String(bare.body), /2026-10-05T12:34:00\.000Z/, 'a time without a zone was not read as UTC');
    // An explicit offset still counts (+10:00, written %2B10:00 in a URL), and other formats are refused.
    const offset = await api(`/export?device=${deviceId}&from=2026-10-05T22:00:00%2B10:00&to=2026-10-05T23:00:00%2B10:00`, { token: admin });
    assert.match(String(offset.body), /2026-10-05T12:34:00\.000Z/);
    assert.equal((await api(`/export?device=${deviceId}&from=Oct 5 2026&to=2026-10-06`, { token: admin })).status, 400);
  } finally {
    if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous;
  }
});

test('#506 a stalled CSV download leaves the database writable, and the pages return every row once, in order', async () => {
  const { deviceId, entityId } = exportDevice('paged_a');
  const add = db.prepare("INSERT INTO esphome_entities (device_id, object_id, kind, name) VALUES (?, ?, 'sensor', ?)");
  const entities = [entityId, ...['paged_b', 'paged_c'].map((o) => Number(add.run(deviceId, o, o).lastInsertRowid))];
  const names = ['paged_a', 'paged_b', 'paged_c'];
  const first = Math.floor(Date.parse('2026-09-01T00:00:00Z') / 60000);
  // 3 x 20,000 = 60,000 rows, about 4 MB of CSV: far more than the socket buffers hold, so a client that stops reading
  // stalls the server. 2,000-row pages end part-way through a minute, which exercises the (minute, entity) cursor.
  const MINUTES = 20000;
  const reading = db.prepare('INSERT INTO esphome_readings (entity_id, bucket, last, mean, min, max, n) VALUES (?, ?, 1, 1, 1, 1, 1)');
  db.transaction(() => { for (let m = 0; m < MINUTES; m++) for (const e of entities) reading.run(e, first + m); })();
  const req = http.get(`${base}/api/esphome/export?device=${deviceId}&from=2026-09-01T00:00:00Z&to=2026-09-15T00:00:00Z`,
    { headers: { authorization: `Bearer ${admin}` } });
  try {
    const res = await new Promise((resolve, reject) => { req.once('response', resolve); req.once('error', reject); });
    assert.equal(res.statusCode, 200);
    res.pause();
    const deadline = Date.now() + 20000;
    while (!lastResponse?.writableNeedDrain && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(lastResponse?.writableNeedDrain, true, 'the download never stalled, so this test proves nothing about one that does');
    // The writes the app makes all the time (session touch, activity samples, the ESPHome minute flush) must still work.
    const days = db.prepare("SELECT esphome_retention_days AS d FROM settings WHERE id = 'app'").get().d;
    db.prepare("UPDATE settings SET esphome_retention_days = ? WHERE id = 'app'").run(days === 7 ? 8 : 7);
    db.prepare("UPDATE settings SET esphome_retention_days = ? WHERE id = 'app'").run(days);
    const chunks = [];
    res.on('data', (chunk) => chunks.push(chunk));
    await new Promise((resolve, reject) => { res.once('end', resolve); res.once('error', reject); res.resume(); });
    const got = Buffer.concat(chunks).toString('utf8').split('\r\n').filter(Boolean).slice(1)
      .map((line) => line.split(',').slice(0, 3).join(','));
    const want = [];
    for (let m = 0; m < MINUTES; m++) for (const name of names)
      want.push(`"${new Date((first + m) * 60000).toISOString()}","#${deviceId}","${name}"`);
    assert.equal(got.length, want.length, 'the export lost or repeated rows across pages');
    const wrong = got.findIndex((row, i) => row !== want[i]);
    assert.equal(wrong, -1, `row ${wrong} is ${got[wrong]}, expected ${want[wrong]}`);
  } finally {
    req.destroy();
  }
});

// #506 review, round 2: SQLite seeks on the page query's plain `r.bucket >= ?` bound and only FILTERS on the row-value
// cursor, so a page whose bound is the start of the range re-reads every earlier index entry, other devices' rows
// included. That made a 31-day export O(n^2) (52 s and a 3.07 s event-loop stall, measured). Deterministic rather than
// timed: it records the value the route binds to `r.bucket >= ?` on each page and counts, from the database, how many
// index entries lie between that bound and the previous page's last row, which is the work a page does before its
// first row.
test('#506 each export page starts its index walk where the previous page ended, not at the start of the range', async () => {
  const { deviceId, entityId } = exportDevice('walk_a');
  const other = exportDevice('walk_x');
  const add = db.prepare("INSERT INTO esphome_entities (device_id, object_id, kind, name) VALUES (?, ?, 'sensor', ?)");
  const mine = [entityId, Number(add.run(deviceId, 'walk_b', 'walk_b').lastInsertRowid)];
  const theirs = [other.entityId, Number(add.run(other.deviceId, 'walk_y', 'walk_y').lastInsertRowid)];
  const first = Math.floor(Date.parse('2026-08-01T00:00:00Z') / 60000);
  // 2 x 6,000 = 12,000 rows of this device (six full pages), with another device's rows in the same minutes.
  const MINUTES = 6000;
  const PER_MINUTE = mine.length + theirs.length;
  const reading = db.prepare('INSERT INTO esphome_readings (entity_id, bucket, last, mean, min, max, n) VALUES (?, ?, 1, 1, 1, 1, 1)');
  db.transaction(() => { for (let m = 0; m < MINUTES; m++) for (const e of [...mine, ...theirs]) reading.run(e, first + m); })();
  // Record each query the export runs on the readings table: its SQL, the values bound and the rows returned.
  const pages = [];
  const realPrepare = db.prepare;
  db.prepare = function prepareAndRecord(sql) {
    const stmt = realPrepare.call(this, sql);
    if (!/FROM esphome_readings/.test(sql)) return stmt;
    const all = stmt.all;
    stmt.all = (...args) => { const rows = all.apply(stmt, args); pages.push({ sql, args, rows }); return rows; };
    return stmt;
  };
  let res;
  try {
    res = await api(`/export?device=${deviceId}&from=2026-08-01T00:00:00Z&to=2026-08-06T00:00:00Z`, { token: admin });
  } finally {
    delete db.prepare;
  }
  assert.equal(res.status, 200);
  assert.equal(String(res.body).split('\r\n').filter(Boolean).length - 1, MINUTES * mine.length, 'the export lost or repeated rows');
  assert.ok(pages.length >= 6, `the export ran ${pages.length} page queries, so it never paged and this proves nothing`);
  const sql = pages[0].sql;
  assert.ok(pages.every((p) => p.sql === sql), 'the export ran more than one kind of query on the readings table');
  assert.ok(sql.includes('r.bucket >= ?'), 'the page query no longer has an `r.bucket >= ?` bound; update this test');
  // The premise: the walk starts at that bound and the cursor is only a filter. If SQLite ever seeks on the row value,
  // this fails and says so, rather than the count below quietly measuring the wrong thing.
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...pages[1].args).map((step) => step.detail).join(' | ');
  assert.match(plan, /SEARCH r USING (?:COVERING )?INDEX idx_esphome_readings_bucket \(bucket>\? AND bucket<\?\)/, plan);
  const lowerAt = sql.slice(0, sql.indexOf('r.bucket >= ?')).split('?').length - 1;
  const before = db.prepare('SELECT COUNT(*) AS n FROM esphome_readings WHERE bucket >= ? AND (bucket, entity_id) <= (?, ?)');
  for (let k = 1; k < pages.length; k++) {
    const previous = pages[k - 1].rows.at(-1);
    const walked = before.get(pages[k].args[lowerAt], previous.bucket, previous.entity_id).n;
    assert.ok(walked <= PER_MINUTE, `page ${k} reads ${walked} index entries before its first row; at most one minute's ` +
      `${PER_MINUTE} is constant work, more grows with every page (O(n^2) over the export)`);
  }
});

// #506 review, round 2: 'drain' never fires once the client has gone, so the export's wait also ends on 'close'. Without
// that, a download cancelled while the server waited left the handler suspended for good, its 'drain' listener attached.
test('#506 a client that disconnects while the export waits for drain ends the handler, with no listener left behind', async () => {
  const { deviceId, entityId } = exportDevice('gone_a');
  const add = db.prepare("INSERT INTO esphome_entities (device_id, object_id, kind, name) VALUES (?, ?, 'sensor', ?)");
  const entities = [entityId, ...['gone_b', 'gone_c'].map((o) => Number(add.run(deviceId, o, o).lastInsertRowid))];
  const first = Math.floor(Date.parse('2026-07-01T00:00:00Z') / 60000);
  // About 4 MB of CSV, as in the stalled-download test above: more than the socket buffers hold.
  const reading = db.prepare('INSERT INTO esphome_readings (entity_id, bucket, last, mean, min, max, n) VALUES (?, ?, 1, 1, 1, 1, 1)');
  db.transaction(() => { for (let m = 0; m < 20000; m++) for (const e of entities) reading.run(e, first + m); })();
  const req = http.get(`${base}/api/esphome/export?device=${deviceId}&from=2026-07-01T00:00:00Z&to=2026-07-15T00:00:00Z`,
    { headers: { authorization: `Bearer ${admin}` } });
  req.on('error', () => {});
  const res = await new Promise((resolve, reject) => { req.once('response', resolve); req.once('error', reject); });
  assert.equal(res.statusCode, 200);
  res.on('error', () => {});
  res.pause();
  const served = lastResponse;
  const t = trace.get(served);
  const waiting = () => served.writableNeedDrain && served.listenerCount('drain') > t.drain;
  let deadline = Date.now() + 20000;
  while (!waiting() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(waiting(), 'the export never waited for drain, so this test proves nothing about a client leaving then');
  assert.equal(t.ended, false);
  req.destroy();
  deadline = Date.now() + 5000;
  while (!t.ended && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(t.ended, true, 'the handler is still waiting for a drain that cannot come');
  assert.equal(served.listenerCount('drain'), t.drain, "the export's 'drain' listener outlived the request");
  assert.equal(served.listenerCount('close'), t.close, "the export's 'close' listener outlived the request");
  assert.equal(t.writesAfterEnd, 0, 'the export wrote after ending the response');
});
