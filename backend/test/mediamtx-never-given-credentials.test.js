// MediaMTX is never given a camera's address or password (GHSA-2wvp-f9vx-7fmf).
//
// WHY THIS TEST EXISTS. docs/architecture.md and docs/operations.md used to say "MediaMTX's control API on
// 127.0.0.1:9997 has no password, so a taken-over media process can read the cameras' passwords from it". That was
// false, and the advisory built on it was withdrawn: the app registers every path as `{ source: 'publisher' }`
// (lib/mediamtx.js upsertPath, unchanged since the first commit) and FFmpeg, not MediaMTX, pulls the camera's RTSP
// URL. Read back from a real MediaMTX (the image's own binary) the path config holds `source: publisher` and nothing
// else that is a credential. The docs now rest on that fact, so it is pinned here: a later change that hands
// MediaMTX a camera URL (a pull `source`, a `runOnDemand` command with the address in it, a `forward` target) would
// make the API a credential store and must fail this test, not wait for a review to notice.
//
// ⚠️ THE FIXTURE IS HOSTILE (CLAUDE.md, "A claim is a hypothesis until a test fails without it"). A marker goes in
// EVERY text column of the cameras table, and the list of columns comes from PRAGMA table_info, not from a list
// typed here: a column added later is planted automatically, so a future credential field cannot slip past. The
// only columns left unplanted are named in EXEMPT with the reason each one cannot carry a credential or cannot hold
// a marker without changing behaviour; a stale exemption (a column that no longer exists) fails the test too.
//
// WHAT IS DRIVEN: the routes that talk to MediaMTX, against a fake that records every request in full (method,
// URL, headers, body): add, edit the address, disable, enable, delete. The sub-stream path is registered too, since
// the seeded camera has a sub-stream address. Not covered, stated: the watchdog and reconcile paths take the same
// `upsertPath(pathName)` / `isPathConfiguredCorrectly(pathName)` helpers, which receive only a path name and so
// cannot be handed an address by their signature; a caller that changed that signature is what the routes here
// would catch.
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, makeCamera, signToken, mountRouter, call } from './helpers/harness.js';

useTempDataDir();

mock.module('../src/lib/rtspProbe.js', {
  exports: {
    validateRtspStream: async () => ({ ok: true }),
    probeRtspDetailed: async () => ({ ok: false }),
    ffprobeVersion: async () => null,
  },
});
mock.module('../src/lib/transcoder.js', {
  exports: {
    startTranscoder: async () => {},
    stopTranscoder: async () => {},
    isRunning: () => false,
  },
});

// A fake MediaMTX that keeps EVERYTHING it is sent. The body is read to the end; headers are kept whole.
const requests = [];
const mediamtx = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    requests.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
    res.setHeader('content-type', 'application/json');
    res.end('{}');
  });
});
await new Promise((resolve) => mediamtx.listen(0, '127.0.0.1', resolve));
process.env.MEDIAMTX_API = `http://127.0.0.1:${mediamtx.address().port}`;

const { default: db } = await import('../src/db.js');
const { default: camerasRouter } = await import('../src/routes/cameras.js');
const server = await mountRouter('/api/cameras', camerasRouter);
const admin = makeUser(db, { id: 'u-mtx-creds', username: 'admin-mtx-creds', role: 'admin' });
const token = signToken({ sub: admin.id, role: 'admin', sid: makeSession(db, admin.id) });

after(async () => {
  await server.close();
  await new Promise((resolve) => mediamtx.close(resolve));
  db.close();
  cleanupTempDataDirs();
});

const MARK = 'HOSTILE-7c1e';
// Text columns that cannot carry a credential, or cannot hold a marker without changing what the routes do.
const EXEMPT = {
  id: 'identity, a UUID the path name is built from',
  child_id: 'a foreign key: a marker would be rejected, and it holds an id',
  mediamtx_path: 'the path name legitimately appears in every MediaMTX URL',
  created_at: 'a timestamp the database writes',
  discovery_source: 'an enum the routes branch on',
  backchannel_supported: 'an enum the routes branch on',
  talk_backend: 'an enum the routes branch on',
  detect_source: 'an enum the detector wiring branches on',
  detect_zone: 'JSON the detector parses',
  motion_mqtt_value: 'a compared value, not an address',
};

const textColumns = db.prepare('PRAGMA table_info(cameras)').all().filter((c) => /TEXT/i.test(c.type)).map((c) => c.name);
for (const name of Object.keys(EXEMPT)) {
  test(`exemption "${name}" still names a real text column`, () => {
    assert.ok(textColumns.includes(name), `${name} is no longer a text column of cameras: drop it from EXEMPT`);
  });
}
const planted = textColumns.filter((c) => !(c in EXEMPT));

test('the hostile fixture covers every credential-bearing text column the schema has', () => {
  // The columns that, today, hold an address, a login or a token. If one of these stops being planted the
  // fixture has lost its teeth; a NEW column is planted automatically and needs no edit here.
  for (const col of ['rtsp_url', 'sub_rtsp_url', 'onvif_username', 'onvif_password', 'talk_username', 'talk_password', 'snapshot_url']) {
    assert.ok(planted.includes(col), `${col} is not in the planted set: ${planted.join(', ')}`);
  }
});

test('adding, editing, disabling, enabling and deleting a camera never sends MediaMTX an address or a password', async () => {
  const CAM = '84600000-0000-4000-8000-0000000000aa';
  makeCamera(db, { id: CAM });
  for (const col of planted) {
    // A URL-shaped marker where the column is parsed as a URL, a plain marker elsewhere; both contain MARK.
    const value = /rtsp_url$/.test(col) ? `rtsp://user:${MARK}-${col}@cam.example/stream` : `${MARK}-${col}`;
    db.prepare(`UPDATE cameras SET ${col} = ? WHERE id = ?`).run(value, CAM);
  }
  const row = db.prepare('SELECT * FROM cameras WHERE id = ?').get(CAM);
  for (const col of planted) assert.ok(String(row[col]).includes(MARK), `precondition: ${col} carries the marker`);
  requests.length = 0;

  // add (marker in every field the form posts)
  const added = await call(`${server.url}/api/cameras`, {
    method: 'POST', token,
    body: {
      name: 'Marker add', rtsp_host: 'added.example', rtsp_username: `${MARK}-user`, rtsp_password: `${MARK}-pass`,
      rtsp_path: `${MARK}-path`, sub_rtsp_path: `${MARK}-subpath`, talk_username: `${MARK}-talkuser`, talk_password: `${MARK}-talkpass`,
      mqtt_topic: `${MARK}-topic`, force: true,
    },
  });
  assert.equal(added.status, 201, JSON.stringify(added.body));

  // edit the address and the login of the seeded camera, then disable and re-enable it
  const edited = await call(`${server.url}/api/cameras/${CAM}`, {
    method: 'PUT', token,
    body: { rtsp_host: 'edited.example', rtsp_username: `${MARK}-newuser`, rtsp_password: `${MARK}-newpass`, force: true },
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  const off = await call(`${server.url}/api/cameras/${CAM}/enabled`, { method: 'PUT', token, body: { enabled: false } });
  assert.equal(off.status, 200, JSON.stringify(off.body));
  const on = await call(`${server.url}/api/cameras/${CAM}/enabled`, { method: 'PUT', token, body: { enabled: true } });
  assert.equal(on.status, 200, JSON.stringify(on.body));
  const gone = await call(`${server.url}/api/cameras/${CAM}`, { method: 'DELETE', token });
  assert.equal(gone.status, 204, JSON.stringify(gone.body));

  // The interface was really exercised: path registrations (with the publisher-only body) and a removal.
  const writes = requests.filter((r) => r.method === 'PATCH' || r.method === 'POST');
  assert.ok(writes.length >= 3, `expected path registrations, saw ${JSON.stringify(requests.map((r) => `${r.method} ${r.url}`))}`);
  for (const w of writes) assert.deepEqual(JSON.parse(w.body), { source: 'publisher' }, `${w.method} ${w.url} sent more than the publisher-only config`);
  assert.ok(requests.some((r) => r.method === 'DELETE'), 'expected a path removal');

  // THE CLAIM: nothing MediaMTX was sent, in URL, headers or body, carries any marker or a camera address.
  for (const r of requests) {
    const wire = JSON.stringify(r);
    assert.ok(!wire.includes(MARK), `${r.method} ${r.url} carried a marker: ${wire}`);
    assert.ok(!/rtsp:\/\/|cam\.example|added\.example|edited\.example/i.test(wire), `${r.method} ${r.url} carried a camera address: ${wire}`);
  }
});
