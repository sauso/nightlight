// #787: hold the real ONVIF backchannel probe while a competing write or delete completes.
// The camera is enabled and the probe is observed, so a skipped leg cannot make these pass.
import { test, mock, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { readFileSync } from 'node:fs';
import { useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, makeCamera, makeChild, signToken, mountRouter, call } from './helpers/harness.js';

useTempDataDir();
const starts = [];
let db;
let holdStart = null;
let startError = null;
// As in #780, only the transcoder is mocked; the route, database and probe are real.
mock.module('../src/lib/transcoder.js', {
  exports: {
    startTranscoder: async (...args) => {
      starts.push(args);
      if (holdStart) await holdStart();
      if (startError) throw startError;
    },
    stopTranscoder: async () => {},
    isRunning: () => false,
  },
});
const mediamtx = createServer((_req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end('{}');
});
await new Promise((resolve) => mediamtx.listen(0, '127.0.0.1', resolve));
process.env.MEDIAMTX_API = `http://127.0.0.1:${mediamtx.address().port}`;
({ default: db } = await import('../src/db.js'));
const { default: camerasRouter } = await import('../src/routes/cameras.js');
const server = await mountRouter('/api/cameras', camerasRouter);
const admin = makeUser(db, { id: 'u-787', username: 'admin-787', role: 'admin' });
const token = signToken({ sub: admin.id, role: 'admin', sid: makeSession(db, admin.id) });
const CAM = 'cam-787';
const OLD = 'rtsp://user:pass@example/stream';
const NEW = 'rtsp://user:pass@new.example:554/stream';
const row = () => db.prepare('SELECT * FROM cameras WHERE id = ?').get(CAM);
const put = (body) => call(`${server.url}/api/cameras/${CAM}`, { method: 'PUT', token, body });

beforeEach(() => {
  holdStart = null;
  startError = null;
  starts.length = 0;
  db.prepare('DELETE FROM cameras WHERE id = ?').run(CAM);
  makeCamera(db, { id: CAM, name: 'Before', extra: { disabled: 0, detect_motion_enabled: 0, detect_sound_enabled: 0 } });
  assert.equal(row().disabled, 0, 'precondition: camera is enabled');
  assert.equal(row().rtsp_url, OLD);
});
after(async () => {
  await server.close();
  await new Promise((resolve) => mediamtx.close(resolve));
  db.close();
  cleanupTempDataDirs();
});

async function duringProbe(body, competing, { editAddress = false, setup } = {}) {
  let sawProbe;
  const probed = new Promise((resolve) => { sawProbe = resolve; });
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const sockets = new Set();
  const tcp = createTcpServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.once('data', async () => {
      calls += 1;
      sawProbe();
      await released;
      socket.end('RTSP/1.0 404 Not Found\r\nCSeq: 1\r\n\r\n');
    });
  });
  await new Promise((resolve) => tcp.listen(0, '127.0.0.1', resolve));
  try {
    const probeUrl = `rtsp://user:pass@127.0.0.1:${tcp.address().port}/stream`;
    if (!editAddress) db.prepare('UPDATE cameras SET rtsp_url = ? WHERE id = ?').run(probeUrl, CAM);
    setup?.(probeUrl);
    const address = editAddress ? { rtsp_host: '127.0.0.1', rtsp_port: tcp.address().port, force: true } : {};
    const pending = put({ discovery_source: 'onvif', backchannel_supported: 'yes', ...address, ...body });
    await probed;
    assert.ok(calls > 0, 'precondition: ONVIF verification reached the held socket');
    assert.equal(row().rtsp_url, editAddress ? OLD : probeUrl, 'precondition: first PUT is still waiting');
    const middle = await competing();
    release();
    return { middle, finish: await pending, calls, probeUrl };
  } finally {
    release();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => tcp.close(resolve));
  }
}

test('concurrent address survives a no-address ONVIF save', async () => {
  const { finish } = await duringProbe({ name: 'My rename' }, () => {
    db.prepare('UPDATE cameras SET rtsp_url = ? WHERE id = ?').run(NEW, CAM);
    return row().rtsp_url;
  });
  assert.equal(finish.status, 200, JSON.stringify(finish.body));
  assert.equal(row().name, 'My rename');
  assert.equal(row().rtsp_url, NEW);
  assert.equal(starts.length, 0, 'a competing address change alone must not restart this save');
  for (const start of starts) assert.equal(start[1], row().rtsp_url, 'a start must use the saved address');
});

test('re-sent old sub path keeps a concurrent sub-path change', async () => {
  const { finish } = await duringProbe({ sub_rtsp_path: '/low' }, () => {
    db.prepare('UPDATE cameras SET rtsp_url = ?, sub_rtsp_url = ? WHERE id = ?')
      .run(NEW, 'rtsp://user:pass@new.example:554/other', CAM);
  }, { setup: (probeUrl) => db.prepare('UPDATE cameras SET sub_rtsp_url = ? WHERE id = ?')
    .run(probeUrl.replace('/stream', '/low'), CAM) });
  assert.equal(finish.status, 200, JSON.stringify(finish.body));
  assert.equal(row().sub_rtsp_url, 'rtsp://user:pass@new.example:554/other');
});

test('re-sent old sub path keeps a concurrent sub-stream removal', async () => {
  const { finish } = await duringProbe({ sub_rtsp_path: '/low' }, () => {
    db.prepare('UPDATE cameras SET rtsp_url = ?, sub_rtsp_url = NULL WHERE id = ?').run(NEW, CAM);
  }, { setup: (probeUrl) => db.prepare('UPDATE cameras SET sub_rtsp_url = ? WHERE id = ?')
    .run(probeUrl.replace('/stream', '/low'), CAM) });
  assert.equal(finish.status, 200, JSON.stringify(finish.body));
  assert.equal(row().sub_rtsp_url, null);
});

test('every camera edit column keeps its concurrent value when this save leaves it unchanged', async () => {
  // #787: read the UPDATE's actual SET list so a newly wired column cannot silently escape this test.
  const source = readFileSync(new URL('../src/routes/cameras.js', import.meta.url), 'utf8');
  const sql = source.match(/const updatedRows = db\.prepare\(`UPDATE cameras SET ([\s\S]*?)WHERE id = \?`\)/)?.[1];
  assert.ok(sql, 'camera edit UPDATE SQL must be found');
  const columns = [...sql.matchAll(/([a-z_]+)\s*=\s*\?/g)].map((match) => match[1]);
  assert.equal(columns.length, 17, 'all 17 camera edit columns must be exercised');
  const schema = new Map(db.prepare('PRAGMA table_info(cameras)').all().map((column) => [column.name, column]));
  const secondChild = makeChild(db, { id: 'child-787-other', name: 'Another child' });
  const markers = Object.fromEntries(columns.map((column, index) => {
    assert.ok(schema.has(column), `unknown camera edit column ${column}`);
    if (column === 'child_id') return [column, secondChild.id];
    if (column === 'rtsp_url') return [column, NEW];
    if (column === 'sub_rtsp_url') return [column, 'rtsp://user:pass@new.example:554/low'];
    if (schema.get(column).type === 'INTEGER') return [column, 100 + index];
    return [column, `${column}-marker-787`];
  }));
  const { finish } = await duringProbe({}, () => {
    const assignments = columns.map((column) => `${column} = ?`).join(', ');
    db.prepare(`UPDATE cameras SET ${assignments} WHERE id = ?`)
      .run(...columns.map((column) => markers[column]), CAM);
  }, { setup: () => db.prepare("UPDATE cameras SET discovery_source = 'onvif', onvif_capable = 1, backchannel_supported = 'yes', talk_backend = 'onvif-backchannel' WHERE id = ?").run(CAM) });
  assert.equal(finish.status, 200, JSON.stringify(finish.body));
  for (const column of columns) assert.equal(row()[column], markers[column], `concurrent ${column} was lost`);
  assert.equal(starts.filter((start) => start[0] === CAM).length, 0);
});

test('concurrent MQTT topic survives an ONVIF rename', async () => {
  const { finish } = await duringProbe({ name: 'My rename' }, () => {
    db.prepare('UPDATE cameras SET mqtt_topic = ? WHERE id = ?').run('other/topic', CAM);
  });
  assert.equal(finish.status, 200, JSON.stringify(finish.body));
  assert.equal(row().mqtt_topic, 'other/topic');
  assert.equal(row().name, 'My rename');
});

test('sub-stream path follows a concurrent main-address edit', async () => {
  const { finish } = await duringProbe({ sub_rtsp_path: '/low' }, () => {
    db.prepare('UPDATE cameras SET rtsp_url = ? WHERE id = ?').run(NEW, CAM);
  });
  assert.equal(finish.status, 200, JSON.stringify(finish.body));
  assert.equal(row().rtsp_url, NEW);
  assert.equal(row().sub_rtsp_url, 'rtsp://user:pass@new.example:554/low');
});

test('request-edited address also owns its sub-stream path over a concurrent address', async () => {
  const { finish, probeUrl } = await duringProbe({ sub_rtsp_path: '/low' }, () => {
    db.prepare('UPDATE cameras SET rtsp_url = ? WHERE id = ?').run(NEW, CAM);
  }, { editAddress: true });
  assert.equal(finish.status, 200, JSON.stringify(finish.body));
  assert.equal(row().rtsp_url, probeUrl);
  assert.equal(row().sub_rtsp_url, probeUrl.replace('/stream', '/low'));
  assert.equal(starts.find((start) => start[0] === CAM)?.[1], row().rtsp_url);
});

test('request-edited address wins over a competing address', async () => {
  const { finish, probeUrl } = await duringProbe({ name: 'My rename' }, () => {
    db.prepare('UPDATE cameras SET rtsp_url = ? WHERE id = ?').run(NEW, CAM);
  }, { editAddress: true });
  assert.equal(finish.status, 200, JSON.stringify(finish.body));
  assert.equal(row().rtsp_url, probeUrl);
  assert.equal(row().rtsp_url, starts.at(-1)[1]);
});

test('delete during an address-edit ONVIF probe returns 404 without starting a leg', async () => {
  const { finish } = await duringProbe({}, () => db.prepare('DELETE FROM cameras WHERE id = ?').run(CAM), { editAddress: true });
  assert.equal(finish.status, 404, JSON.stringify(finish.body));
  assert.deepEqual(finish.body, { error: 'Camera not found' });
  assert.equal(row(), undefined);
  assert.equal(starts.length, 0);
});

test('delete of a disabled camera during ONVIF probe returns the early 404', async () => {
  const { finish } = await duringProbe({}, () => db.prepare('DELETE FROM cameras WHERE id = ?').run(CAM), {
    setup: () => db.prepare('UPDATE cameras SET disabled = 1 WHERE id = ?').run(CAM),
  });
  assert.equal(finish.status, 404, JSON.stringify(finish.body));
  assert.deepEqual(finish.body, { error: 'Camera not found' });
  assert.equal(row(), undefined);
});

test('delete while transcoder start is awaited returns 404', async () => {
  let sawStart;
  const starting = new Promise((resolve) => { sawStart = resolve; });
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  holdStart = async () => { sawStart(); await released; };
  try {
    const pending = put({ rtsp_host: 'new.example', force: true });
    await starting;
    assert.equal(row().rtsp_url, NEW, 'precondition: save preceded awaited start');
    db.prepare('DELETE FROM cameras WHERE id = ?').run(CAM);
    release();
    const finish = await pending;
    assert.equal(finish.status, 404, JSON.stringify(finish.body));
    assert.deepEqual(finish.body, { error: 'Camera not found' });
    assert.equal(row(), undefined);
    assert.equal(starts.length, 1);
  } finally { release(); }
});

test('delete while a rejecting transcoder start is awaited returns 404', async () => {
  let sawStart;
  const starting = new Promise((resolve) => { sawStart = resolve; });
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  holdStart = async () => { sawStart(); await released; };
  startError = new Error('cancelled by delete');
  try {
    const pending = put({ rtsp_host: 'new.example', force: true });
    await starting;
    db.prepare('DELETE FROM cameras WHERE id = ?').run(CAM);
    release();
    const finish = await pending;
    assert.equal(finish.status, 404, JSON.stringify(finish.body));
    assert.deepEqual(finish.body, { error: 'Camera not found' });
  } finally { release(); }
});

test('unknown camera is 404 and a plain rename saves', async () => {
  const missing = await call(`${server.url}/api/cameras/missing-787`, { method: 'PUT', token, body: { name: 'No' } });
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.body, { error: 'Camera not found' });
  const renamed = await put({ name: 'After' });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
  assert.equal(row().name, 'After');
  assert.equal(starts.length, 0);
});
