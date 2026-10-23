// #806: two ordering races between PUT /api/cameras/:id/enabled and a camera edit.
//
// RACE 2 (the enable). The enable starts every leg from the row it read BEFORE any await and writes `disabled = 0`
// only at the bottom. An edit saved in between read `disabled = 1`, so it skipped its own start, and the enable finished
// with the OLD address running until the 5-minute reconcile. The fix re-reads the row straight after the flag write (no
// await between) and applies an address that differs from the snapshot the legs started with.
//
// THE DISABLE. The disable route wrote `disabled = 1` only after its stops, so an edit that read the row mid-stop still
// saw 0 and queued a start behind the stop (the sub-stream half is in transcoder-start-chain.test.js, cases r1/r2).
// The flag is now written before the first await.
//
// HOW THIS IS OBSERVED. The route, SQLite schema and MediaMTX client are real; transcoder.js and subStream.js are
// replaced by recorders (neither is in test:core's coverage include list, so mock.module() is safe) whose startTranscoder
// can be HELD by the test, which is how the enable is parked part-way through its starts. The edit that lands meanwhile is
// written to SQLite exactly as the edit route writes it (or sent through the real route for the main address).
//
// Which cases FAIL on the code before #806: e1, e2, e3 (the enable never re-reads), e6 (nothing is re-applied at all)
// and d1 (the flag is written last). Guards that pass there too: e4 (A -> B -> A starts nothing), e5 (nothing changed),
// e7 (a refused enable leaves the camera disabled).
import { test, mock, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, makeCamera, signToken, mountRouter, call } from './helpers/harness.js';

useTempDataDir();
const ops = [];
let db;
// One entry per startTranscoder call to hold, consumed in call order: the test pushes a deferred, the call awaits it.
const gates = [];
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};
// Same shape as the real one, which only checks the string.
const subConfiguredFake = (camera) => !!(camera.sub_rtsp_url && camera.sub_rtsp_url.trim());

mock.module('../src/lib/transcoder.js', {
  exports: {
    startTranscoder: async (id, url) => {
      ops.push({ type: 'start', id, url });
      const gate = gates.shift();
      if (gate) await gate.promise;
    },
    stopTranscoder: async (id) => { ops.push({ type: 'stop', id }); const gate = gates.shift(); if (gate && gate.onStop) await gate.promise; },
    isRunning: () => false,
  },
});
mock.module('../src/lib/subStream.js', {
  exports: {
    subCameraId: (id) => `${id}-sub`,
    subConfigured: subConfiguredFake,
    isSubRunning: () => false,
    startSubStream: async (camera) => { ops.push({ type: 'sub-start', id: camera.id, url: camera.sub_rtsp_url }); },
    stopSubStream: async (camera) => { ops.push({ type: 'sub-stop', id: camera.id }); },
  },
});

let mediaStatus = 200;
const mediamtx = createServer((req, res) => {
  res.writeHead(mediaStatus, { 'content-type': 'application/json' });
  res.end(mediaStatus === 200 ? '{}' : '{"error":"rejected"}');
});
await new Promise((resolve) => mediamtx.listen(0, '127.0.0.1', resolve));
process.env.MEDIAMTX_API = `http://127.0.0.1:${mediamtx.address().port}`;

({ default: db } = await import('../src/db.js'));
const { default: camerasRouter } = await import('../src/routes/cameras.js');
const server = await mountRouter('/api/cameras', camerasRouter);
const admin = makeUser(db, { id: 'u-806', username: 'admin-806', role: 'admin' });
const token = signToken({ sub: admin.id, role: 'admin', sid: makeSession(db, admin.id) });
const CAM = 'cam-806';
const MAIN_A = 'rtsp://user:pass@example/stream';
const SUB_A = 'rtsp://user:pass@example/sub-a';
const SUB_B = 'rtsp://user:pass@example/sub-b';
const url = (suffix = '') => `${server.url}/api/cameras/${CAM}${suffix}`;
const enable = (enabled) => call(url('/enabled'), { method: 'PUT', token, body: { enabled } });
const row = () => db.prepare('SELECT rtsp_url, sub_rtsp_url, disabled FROM cameras WHERE id = ?').get(CAM);
const turn = () => new Promise((r) => setImmediate(r));
async function until(cond, what) {
  for (let i = 0; i < 500; i++) {
    if (cond()) return;
    await turn();
  }
  assert.fail(`timed out waiting for ${what}`);
}

beforeEach(() => {
  ops.length = 0;
  gates.length = 0;
  mediaStatus = 200;
  db.prepare('DELETE FROM cameras WHERE id = ?').run(CAM);
  makeCamera(db, { id: CAM, extra: { disabled: 1, sub_rtsp_url: SUB_A, detect_motion_enabled: 0, detect_sound_enabled: 0 } });
  assert.equal(row().disabled, 1, 'precondition: a disabled camera is being enabled');
  assert.equal(row().rtsp_url, MAIN_A);
});

after(async () => {
  for (const gate of gates.splice(0)) gate.resolve();
  await server.close();
  await new Promise((resolve) => mediamtx.close(resolve));
  db.close();
  cleanupTempDataDirs();
});

// Park the enable inside its first startTranscoder (the legs started from the OLD row), run `during`, then let it finish.
async function enableWith(during) {
  const gate = deferred();
  gates.push(gate);
  const pending = enable(true);
  await until(() => ops.some((o) => o.type === 'start'), 'the enable to reach its transcoder start');
  assert.equal(row().disabled, 1, 'precondition: the enable has not written its flag yet');
  await during();
  gate.resolve();
  return pending;
}

test('e1: a main address saved while the enable is starting is started afterwards, last', async () => {
  const res = await enableWith(async () => {
    const edit = await call(url(), { method: 'PUT', token, body: { rtsp_host: 'new.example', force: true } });
    assert.equal(edit.status, 200, JSON.stringify(edit.body));
    assert.notEqual(row().rtsp_url, MAIN_A, 'precondition: the edit saved a new address');
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const starts = ops.filter((o) => o.type === 'start');
  assert.equal(starts[0].url, MAIN_A, 'precondition: the enable started from the old row');
  assert.equal(starts.at(-1).url, row().rtsp_url, 'the camera ended on the OLD address');
  assert.equal(starts.length, 2);
  assert.equal(row().disabled, 0);
});

test('e2: a sub address saved while the enable is starting is started afterwards', async () => {
  const res = await enableWith(async () => {
    db.prepare('UPDATE cameras SET sub_rtsp_url = ? WHERE id = ?').run(SUB_B, CAM);
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const subs = ops.filter((o) => o.type === 'sub-start');
  assert.equal(subs[0].url, SUB_A, 'precondition: the enable started the sub leg from the old row');
  assert.equal(subs.at(-1).url, SUB_B, 'the sub leg ended on the OLD address');
});

test('e3: a sub address cleared while the enable is starting stops the sub leg', async () => {
  const res = await enableWith(async () => {
    db.prepare("UPDATE cameras SET sub_rtsp_url = NULL WHERE id = ?").run(CAM);
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(ops.filter((o) => o.type === 'sub-start').length, 1, 'precondition: the enable started the old sub leg');
  assert.equal(ops.filter((o) => o.type === 'sub-stop').length, 1, 'the cleared sub address left its old leg running');
});

test('e4: A -> B -> A during the enable starts nothing extra', async () => {
  const res = await enableWith(async () => {
    db.prepare('UPDATE cameras SET sub_rtsp_url = ? WHERE id = ?').run(SUB_B, CAM);
    db.prepare('UPDATE cameras SET sub_rtsp_url = ? WHERE id = ?').run(SUB_A, CAM);
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(ops.filter((o) => o.type === 'start').length, 1);
  assert.equal(ops.filter((o) => o.type === 'sub-start').length, 1);
  assert.equal(ops.filter((o) => o.type === 'sub-stop').length, 0);
});

test('e5: nothing saved during the enable starts nothing extra', async () => {
  const res = await enableWith(async () => {});
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(ops.map((o) => o.type), ['start', 'sub-start']);
});

test('e6: both re-applied starts are queued in one synchronous block (the sub does not wait for the main start to finish)', async () => {
  // Hold the enable's own start AND the re-applied main start. If the sub were applied only after the main start
  // finished, a later edit or a disable could land in between and the stale sub address would be queued last.
  const first = deferred();
  const reapply = deferred();
  gates.push(first, reapply);
  const pending = enable(true);
  await until(() => ops.some((o) => o.type === 'start'), 'the enable to reach its transcoder start');
  db.prepare('UPDATE cameras SET rtsp_url = ?, sub_rtsp_url = ? WHERE id = ?').run('rtsp://user:pass@new.example/stream', SUB_B, CAM);
  first.resolve();
  await until(() => ops.filter((o) => o.type === 'start').length === 2, 'the re-applied main start');
  // The main re-apply is still held. The sub re-apply must already have been issued.
  assert.equal(ops.filter((o) => o.type === 'sub-start').at(-1)?.url, SUB_B,
    'the sub start waited for the main start instead of being queued with it');
  reapply.resolve();
  const res = await pending;
  assert.equal(res.status, 200, JSON.stringify(res.body));
});

test('e7: an enable MediaMTX refuses answers 502, starts nothing and leaves the camera disabled', async () => {
  mediaStatus = 500;
  const res = await enable(true);
  assert.equal(res.status, 502, JSON.stringify(res.body));
  assert.equal(row().disabled, 1);
  assert.deepEqual(ops, []);
});

test('d1: a disable records disabled = 1 before its first stop, so an edit reading the row mid-stop sees it', async () => {
  // The camera being disabled is an enabled one (beforeEach leaves it disabled, which would make the check below vacuous).
  db.prepare('UPDATE cameras SET disabled = 0 WHERE id = ?').run(CAM);
  const gate = deferred();
  gate.onStop = true;
  gates.push(gate);
  const pending = call(url('/enabled'), { method: 'PUT', token, body: { enabled: false } });
  await until(() => ops.some((o) => o.type === 'stop'), 'the disable to reach its first stop');
  assert.equal(row().disabled, 1, 'the flag was still 0 while the stops were running');
  gate.resolve();
  const res = await pending;
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(row().disabled, 1);
});
