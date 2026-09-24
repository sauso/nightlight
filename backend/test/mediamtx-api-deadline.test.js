// A MediaMTX that accepts the connection and never answers must not hold the app open (issue #451).
//
// The defect: lib/mediamtx.js made five `fetch` calls to MediaMTX's HTTP API with no `signal`, so the
// only bound was undici's 300s `headersTimeout`/`bodyTimeout`. GET /api/cameras and /api/diagnostics
// `Promise.all` one status call per camera, so a single stuck call held the whole camera list for five
// minutes, and the 15s camera watchdog stacked a new tick on top of every pending one.
//
// ⚠️ THE STUB ACCEPTS AND THEN SAYS NOTHING, which is the specific failure mode (the same technique as
// notify-timeouts.test.js for #262). A refused connection or a closed port is NOT this bug: those fail in
// milliseconds on their own and would make every case below pass with the fix removed. T1 therefore also
// asserts the call took at least the deadline, so it cannot pass because of a fast refusal.
//
// ⚠️ ONE SERVER, ONE HANDLER SWAPPED PER CASE (Codex plan review of #451, round 2, P1). MEDIAMTX_API is
// read once at module load, so a second server cannot be pointed at later; this is the
// webrtcSessions.test.js pattern. There is deliberately NO production seam for the API base, only the
// timeout seam, so nothing here can quietly test a different URL from the one the app uses.
import { test, describe, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import {
  useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, makeCamera, signToken, mountRouter,
} from './helpers/harness.js';
import { walkSources, stripCommentsAndStrings } from './helpers/sourceScan.js';

useTempDataDir();

// An empty directory as the whole PATH, so T3b's real startTranscoder cannot spawn ffmpeg or ffprobe
// whatever this machine has installed (the spawn-failure.test.js technique). Node reads PATH at spawn
// time and `node --test` runs each file in its own process, so this cannot leak into another suite.
const emptyBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightlight-nobin-'));
process.env.PATH = emptyBinDir;

// Responses held open by the black-hole handlers, destroyed after every case so nothing outlives it.
const held = [];
const unconfigured = (req, res) => {
  res.statusCode = 500;
  res.end('unconfigured');
};
let handler = unconfigured;
const fakeMediamtx = createServer((req, res) => handler(req, res));
await new Promise((resolve) => fakeMediamtx.listen(0, '127.0.0.1', resolve));
process.env.MEDIAMTX_API = `http://127.0.0.1:${fakeMediamtx.address().port}`;

// Accepts, reads the request, and never answers. Node's http server does not time a request out on
// its own anywhere near the deadline used here (its requestTimeout is 300s), so only OUR deadline can
// end the call.
const blackHole = (req, res) => {
  req.resume();
  held.push(res);
};
// The subtle half (#262's lesson): `fetch` resolves on HEADERS, so a server can answer them and then
// hold the body forever. A fix that bounded only the headers would leave this unbounded.
const hungBody = (req, res) => {
  req.resume();
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': '100' });
  res.write('{"ready":');
  held.push(res);
};
// A fast failure: the connection dies immediately, which is an ANSWER (nothing is serving), not a
// timeout.
const destroySocket = (req) => req.socket.destroy();
const json = (status, body) => (req, res) => {
  req.resume();
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
};

const mediamtx = await import('../src/lib/mediamtx.js');
const { getPathStatus, isPathConfiguredCorrectly, upsertPath, removePath } = mediamtx;
const { logger } = await import('../src/lib/logger.js');
const { resetGuardRateLimit } = await import('../src/lib/processGuards.js');
const { startSubStream, subCameraId } = await import('../src/lib/subStream.js');
const { stopTranscoder } = await import('../src/lib/transcoder.js');
const { default: db } = await import('../src/db.js');
const { default: camerasRouter } = await import('../src/routes/cameras.js');

// Nothing in this file may reach a real MediaMTX: every URL the module builds must be the stub's.
assert.equal(mediamtx.MEDIAMTX_API, process.env.MEDIAMTX_API, 'mediamtx.js was loaded before the stub existed');

// Shorter than the real 5s so the file runs in seconds, but NOT tiny: the cases that expect an ANSWER
// (T3's 404/true, T5, T8's healthy camera, T9) would read a slow-but-healthy loopback reply as a timeout
// if the event loop stalls past the deadline, and `node --test` runs files concurrently. 1s leaves that
// margin. Optional-chained on purpose: on the unfixed source the seam does not exist, and calling it
// would fail every case with a TypeError instead of with the thing this file is about, the call hanging
// past its budget. T7 asserts the seam exists, so the optional chain cannot hide a removed one.
const DEADLINE_MS = 1000;
mediamtx.setMediamtxApiTimeoutForTest?.(DEADLINE_MS);

// Room for two deadlines in a row (T3b's two config reads) plus slack for a loaded runner, and still
// sixty times inside undici's 300s, which is the only thing this needs to discriminate. Every case RACES
// this budget, so the unfixed code fails at the budget rather than hanging the suite for five minutes.
const SETTLE_BUDGET_MS = 5000;
async function settles(label, fn) {
  const startedAt = Date.now();
  let timer;
  const budget = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} did not settle within ${SETTLE_BUDGET_MS}ms: the call is unbounded (undici's own limit is 300000ms)`)),
      SETTLE_BUDGET_MS
    );
  });
  try {
    const result = await Promise.race([fn(), budget]);
    return { result, elapsed: Date.now() - startedAt };
  } finally {
    clearTimeout(timer);
  }
}

const logged = (needle) => logger.getRecent().filter((l) => l.includes(needle)).length;

beforeEach(() => {
  // Round 2, P2: the guard rate limiter is per-label module state, and the log ring is process-wide. A
  // case counting `[guard:mediamtx-api]` lines would otherwise see an earlier case's line, or have its
  // own suppressed, and pass for the wrong reason.
  resetGuardRateLimit();
  handler = unconfigured;
});

afterEach(() => {
  while (held.length) held.pop().destroy();
  logger.clear();
});

after(async () => {
  while (held.length) held.pop().destroy();
  fakeMediamtx.closeAllConnections?.();
  await new Promise((resolve) => fakeMediamtx.close(resolve));
  db.close();
  cleanupTempDataDirs();
  try { fs.rmSync(emptyBinDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('every MediaMTX API call has a deadline (#451)', () => {
  test('T1 (AC1): a status call against a server that never answers resolves UNKNOWN, and it was the deadline that ended it', async () => {
    handler = blackHole;
    const { result, elapsed } = await settles('getPathStatus', () => getPathStatus('cam_t1'));
    assert.deepEqual(result, { ready: false, tracks: [], unknown: true });
    // A refusal would come back in a few ms and prove nothing about the abort.
    assert.ok(elapsed >= DEADLINE_MS - 50, `gave up after only ${elapsed}ms: it was not the deadline doing the work`);
  });

  test('T2: headers arrive and then the body hangs: still bounded, still UNKNOWN', async () => {
    handler = hungBody;
    const { result } = await settles('getPathStatus (hung body)', () => getPathStatus('cam_t2'));
    assert.deepEqual(result, { ready: false, tracks: [], unknown: true }, 'the body read is not inside the abort window');
  });

  test('T3: isPathConfiguredCorrectly is three-valued: null for no answer, false for a real "no", true for "yes"', async () => {
    handler = blackHole;
    const hung = await settles('isPathConfiguredCorrectly (black hole)', () => isPathConfiguredCorrectly('cam_t3'));
    assert.equal(hung.result, null, 'a timeout must be UNKNOWN (null), never false: every caller treats false as permission to write');

    handler = json(404, { error: 'path not found' });
    assert.equal((await settles('404', () => isPathConfiguredCorrectly('cam_t3'))).result, false);

    handler = json(200, { source: 'rtsp://somewhere-else' });
    assert.equal((await settles('wrong source', () => isPathConfiguredCorrectly('cam_t3'))).result, false);

    handler = json(200, { source: 'publisher' });
    assert.equal((await settles('correct', () => isPathConfiguredCorrectly('cam_t3'))).result, true);
  });

  test('T3b: through a REAL caller, a config read that times out writes NOTHING; once MediaMTX answers "missing", it writes', async () => {
    // Round 2, P0. A PATCH that we gave up on can still be applied by MediaMTX after we stopped waiting,
    // and any write reloads the path, disconnecting a publisher that may have been working. So an
    // unanswered config read must not be read as "misconfigured". Driven through startSubStream because
    // it reaches TWO of the three call sites in one go: subStream.js's own check, then startTranscoder's
    // HLS-path check. The third, index.js's reconcile, cannot be imported and is covered by T3c.
    const cam = {
      id: 'cam-t3b', name: 'T3b', mediamtx_path: 'cam_t3b', rtsp_url: 'rtsp://192.0.2.10:554/main',
      sub_rtsp_url: 'rtsp://192.0.2.10:554/sub',
    };
    const writes = [];
    const configReads = [];
    const recordWrites = (req, res) => {
      writes.push(`${req.method} ${req.url}`);
      json(200, {})(req, res);
    };

    handler = (req, res) => {
      if (req.method === 'GET' && req.url.startsWith('/v3/config/paths/get/')) {
        configReads.push(req.url);
        return blackHole(req, res);
      }
      if (req.method === 'PATCH' || req.method === 'POST') return recordWrites(req, res);
      return json(404, {})(req, res);
    };
    try {
      await settles('startSubStream (config read hangs)', () => startSubStream(cam));
      // Anti-vacuous: zero writes means nothing unless the checks really ran and really went unanswered.
      assert.deepEqual(
        configReads.sort(),
        ['/v3/config/paths/get/cam_t3b-sub', '/v3/config/paths/get/cam_t3b-sub-hls'],
        'precondition: both call sites should have asked MediaMTX for their path config'
      );
      assert.deepEqual(writes, [], 'a timed-out config read was taken as permission to write: that write reloads the path and drops a live publisher');

      // Recovery: MediaMTX now answers, and says the paths are missing. That IS evidence, so both write.
      handler = (req, res) => {
        if (req.method === 'GET' && req.url.startsWith('/v3/config/paths/get/')) return json(404, { error: 'not found' })(req, res);
        if (req.method === 'PATCH' || req.method === 'POST') return recordWrites(req, res);
        return json(404, {})(req, res);
      };
      await settles('startSubStream (MediaMTX answers)', () => startSubStream(cam));
      assert.deepEqual(
        writes.sort(),
        ['PATCH /v3/config/paths/patch/cam_t3b-sub', 'PATCH /v3/config/paths/patch/cam_t3b-sub-hls'],
        'once MediaMTX answered "missing", both paths should have been written'
      );
    } finally {
      await stopTranscoder(subCameraId(cam.id));
    }
  });

  test('T3c (tripwire, fail closed): no caller in src/ reads isPathConfiguredCorrectly except as `=== false`', () => {
    // Covers index.js's reconcileCameraPaths, which T3b cannot reach because importing index.js boots the
    // app. `!(await isPathConfiguredCorrectly(...))` is exactly the pre-#451 shape: it treats null
    // (unknown) as "misconfigured" and writes. Scans every file rather than a list, so a new caller added
    // anywhere is held to the same rule on the day it lands.
    const sites = [];
    for (const f of walkSources()) {
      const code = stripCommentsAndStrings(f.src);
      for (const m of code.matchAll(/\bisPathConfiguredCorrectly\s*\(/g)) {
        const before = code.slice(Math.max(0, m.index - 40), m.index);
        if (/function\s+$/.test(before)) continue; // the definition itself
        let depth = 0;
        let end = m.index + m[0].length - 1;
        for (; end < code.length; end++) {
          if (code[end] === '(') depth++;
          else if (code[end] === ')' && --depth === 0) break;
        }
        const after = code.slice(end + 1, end + 40);
        const ok = /\(\s*await\s+$/.test(before) && /^\s*\)\s*===\s*false\b/.test(after);
        sites.push({ rel: f.rel, ok, text: code.slice(Math.max(0, m.index - 20), end + 20).replace(/\s+/g, ' ') });
      }
    }
    const callers = [...new Set(sites.map((s) => s.rel))].sort();
    for (const rel of ['index.js', 'lib/subStream.js', 'lib/transcoder.js']) {
      assert.ok(callers.includes(rel), `the scan no longer finds the call in ${rel}: it has stopped matching, or the caller moved`);
    }
    const bad = sites.filter((s) => !s.ok);
    assert.deepEqual(bad, [], 'a caller treats an UNKNOWN config read as "misconfigured" and would write');
  });

  test('T4: a write that is never answered rejects with a readable message, not "This operation was aborted"', async () => {
    // Routes surface e.message (camera add/edit), so the raw AbortError text would reach a person.
    handler = blackHole;
    for (const [label, call] of [
      ['upsertPath', () => upsertPath('cam_t4')],
      ['removePath', () => removePath('cam_t4')],
    ]) {
      const { result: err } = await settles(label, () => call().then(() => null, (e) => e));
      assert.ok(err instanceof Error, `${label} resolved against a server that never answered`);
      assert.match(err.message, /did not answer .* within/, `${label}: unhelpful message: ${err.message}`);
      assert.ok(!/aborted/i.test(err.message), `${label}: the raw abort message leaked: ${err.message}`);
    }
  });

  test('T5 (AC3): nothing latches: once MediaMTX answers again, the next call is READY and not unknown', async () => {
    handler = blackHole;
    assert.equal((await settles('stuck', () => getPathStatus('cam_t5'))).result.unknown, true, 'precondition: the first call timed out');

    handler = json(200, { ready: true, tracks: ['H264'], readers: [{}] });
    const { result } = await settles('recovered', () => getPathStatus('cam_t5'));
    assert.deepEqual(result, { ready: true, readers: 1, tracks: ['H264'] });
    assert.ok(!('unknown' in result), 'a recovered answer still carries `unknown`');
  });

  test('T6: timeouts are logged once a minute under [guard:mediamtx-api]; an ordinary error answer is not logged', async () => {
    handler = json(500, { error: 'boom' });
    await settles('500', () => getPathStatus('cam_t6'));
    assert.equal(logged('[guard:mediamtx-api]'), 0, 'a 500 is an answer, not a timeout, and was logged as one');

    handler = blackHole;
    await settles('first timeout', () => getPathStatus('cam_t6'));
    await settles('second timeout', () => getPathStatus('cam_t6'));
    assert.equal(logged('[guard:mediamtx-api]'), 1, 'expected exactly one line for two timeouts: one, or it floods the 1000-line ring');
    assert.equal(logged('did not answer GET /v3/paths/get/cam_t6'), 1, 'the line does not say which call went unanswered');
  });

  test('T7: the deadline is short enough to be useful and long enough for a loaded box, and the test seam exists', () => {
    assert.equal(typeof mediamtx.setMediamtxApiTimeoutForTest, 'function', 'the timeout seam is gone, so every case above ran at the 5s default');
    const ms = mediamtx.MEDIAMTX_API_TIMEOUT_MS;
    assert.ok(ms >= 3000, `${ms}ms: a loopback API on a busy NAS can take a second or two`);
    assert.ok(ms <= 15000, `${ms}ms: long enough that the camera list and the watchdog stall again`);
  });

  test('T8 (AC1 through the route): GET /api/cameras answers within the budget while one camera\'s status never comes', async () => {
    const admin = makeUser(db, { id: 'u-t8', username: 't8admin', role: 'admin' });
    const token = signToken({ id: admin.id, username: admin.username, role: 'admin', sid: makeSession(db, admin.id) });
    makeCamera(db, { id: 'cam-a', name: 'A', path: 'cam_a' });
    makeCamera(db, { id: 'cam-b', name: 'B', path: 'cam_b' });
    handler = (req, res) => {
      if (req.url === '/v3/paths/get/cam_a') return blackHole(req, res);
      if (req.url === '/v3/paths/get/cam_b') return json(200, { ready: true, tracks: ['H264'], readers: [] })(req, res);
      return json(404, {})(req, res);
    };
    const server = await mountRouter('/api/cameras', camerasRouter);
    try {
      const { result: res } = await settles('GET /api/cameras', () =>
        fetch(`${server.url}/api/cameras`, {
          headers: { authorization: `Bearer ${token}` },
          // The client's own bound, so the unfixed route fails here instead of hanging for 300s.
          signal: AbortSignal.timeout(SETTLE_BUDGET_MS),
        })
      );
      assert.equal(res.status, 200);
      const body = await res.json();
      const a = body.find((c) => c.id === 'cam-a');
      const b = body.find((c) => c.id === 'cam-b');
      assert.deepEqual(a.status, { ready: false, tracks: [], unknown: true }, 'the unanswered camera is not reported as unknown');
      assert.equal(b.status.ready, true, 'the healthy camera was not reported ready: one stuck camera took the other with it');
    } finally {
      await server.close();
      db.prepare("DELETE FROM cameras WHERE id IN ('cam-a', 'cam-b')").run();
    }
  });

  test('T9: a fast failure and an error answer are "not ready", NOT unknown: only a timeout is unknown', async () => {
    // The control for the whole owner decision. A refusal or a 5xx means nothing is serving that path,
    // which is evidence; marking it unknown would switch the watchdog off for a MediaMTX that is down.
    handler = destroySocket;
    const refused = await settles('socket destroyed', () => getPathStatus('cam_t9'));
    assert.deepEqual(refused.result, { ready: false, tracks: [] });

    handler = json(500, { error: 'boom' });
    const failed = await settles('500', () => getPathStatus('cam_t9'));
    assert.deepEqual(failed.result, { ready: false, tracks: [] });
  });
});
