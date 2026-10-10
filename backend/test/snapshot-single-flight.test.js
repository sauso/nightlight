// #552: the live still frame (GET /api/cameras/:id/snapshot, the picture behind the bed-zone picker) runs ONE
// grab per camera at a time.
//
// That route is open to every signed-in viewer (it takes a media token), and it used to start a grab per request:
// an HTTP fetch from the camera and, failing that, a one-shot ffmpeg of up to 8 s. grabLiveFrame (lib/snapshot.js)
// now shares one grab between every request for the same camera. The claims, each with the tests that fail
// without it:
//
//   C1  One grab per camera at a time, INCLUDING while a killed grab is still exiting (#552 review B9: on a
//       timeout captureSnapshot resolves null right after SIGKILL, before the child's 'exit'). Tests: "five
//       requests at once share one capture", "the HTTP address is fetched once for everyone", "a timed-out grab
//       holds the camera until its process exits", "end to end: a killed ffmpeg that has not exited yet",
//       "end to end: after a failed kill the camera is held until the child closes", and the route tests "five
//       concurrent GETs for one camera make ONE request to the camera" and "with no HTTP address, five concurrent
//       GETs start ONE ffmpeg".
//   C2  A failed grab does not wedge the camera. Tests: "a new request after the process exited starts a new
//       grab", "a null result", "a rejected capture", "a late or repeated onExit", captureSnapshot's onExit
//       tests (a normal exit, exit then close, a spawn that throws, a spawn that fails later, a failed kill then
//       close with no exit), and the route test "when the HTTP address and the ffmpeg both fail".
//   C3  Cameras never share a frame. Test: "two cameras get two grabs and their own frames".
//   Also pinned (PR #665 review): an ordinary join of a running grab logs nothing (KNOWN-ISSUES tells an admin to
//   restart on the "[snapshot] still frame" line), the route's 503 body, and `Cache-Control: no-store` on a frame.
//
// HOW. grabLiveFrame takes injectable `fetchHttp`/`capture` (real injection; snapshot.js is NOT mocked).
// captureSnapshot's own onExit wiring runs against a fake child process: `node:child_process` is mocked, which is
// not in test:core's include list (see helpers/fakeFfmpeg.js). The route tests mount the REAL cameras router with
// nothing injected: the camera's snapshot_url points at a local HTTP server that holds its answer, and where there
// is none (or it fails) the real captureSnapshot runs against the mocked spawn. snapshot.js is imported as a
// namespace and grabLiveFrame reached through grab(), so that against code without #552 the grabLiveFrame tests fail
// one by one and the route tests still run (and fail on their counts). Every suite has a deadline (SUITE below).
//
// NOT COVERED (negative space): a real ffmpeg, MediaMTX or camera. A process that never exits after SIGKILL is
// only modelled here (the fake simply never emits 'exit'); what it leads to (that camera's still frame answers
// 503 until restart) is a documented known limit, not something this file proves harmless.
import { test, describe, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, makeCamera, signToken, mountRouter,
} from './helpers/harness.js';
import { FakeFfmpeg } from './helpers/fakeFfmpeg.js';

useTempDataDir();

// Every process captureSnapshot starts comes from `spawnImpl`; each test sets the one it needs. The default never
// exits on its own, so a test that forgets to set one waits on its own grab rather than passing by accident.
const spawned = [];
let spawnImpl = (command, args) => new FakeFfmpeg(command, args);
mock.module('node:child_process', {
  exports: {
    spawn(command, args, opts) {
      const proc = spawnImpl(command, args, opts);
      spawned.push(proc);
      return proc;
    },
  },
});

// An ffmpeg that has been SIGKILLed but has not exited yet: kill() is recorded, and 'exit' comes only when the
// test calls finish(). This is the window review B9 is about.
class DyingFfmpeg extends FakeFfmpeg {
  kill(signal) {
    this.signals.push(signal);
    return true;
  }
}

const { default: db } = await import('../src/db.js');
const { default: camerasRouter } = await import('../src/routes/cameras.js');
const { logger } = await import('../src/lib/logger.js');
const snapshot = await import('../src/lib/snapshot.js');
const { captureSnapshot } = snapshot;

function grab(cam, opts) {
  if (typeof snapshot.grabLiveFrame !== 'function') {
    assert.fail('lib/snapshot.js does not export grabLiveFrame: the #552 single-flight is missing');
  }
  return snapshot.grabLiveFrame(cam, opts);
}

const JPEG_A = Buffer.from([0xff, 0xd8, 0x0a, 0xff, 0xd9]);
const JPEG_B = Buffer.from([0xff, 0xd8, 0x0b, 0xff, 0xd9]);
const flush = () => new Promise((r) => setImmediate(r));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// A stand-in for captureSnapshot that records each call and lets the test decide, separately, when the answer
// arrives (resolve/reject) and when the process is gone (the onExit the caller passed in).
function fakeCapture() {
  const calls = [];
  const capture = (pathName, opts = {}) => {
    const d = deferred();
    calls.push({ pathName, onExit: opts.onExit, resolve: d.resolve, reject: d.reject });
    return d.promise;
  };
  return { capture, calls };
}

// The same for fetchHttpSnapshot.
function fakeFetch() {
  const calls = [];
  const fetchHttp = (url) => {
    const d = deferred();
    calls.push({ url, resolve: d.resolve, reject: d.reject });
    return d.promise;
  };
  return { fetchHttp, calls };
}

// The flight store is per process and keyed by camera id, so every test uses a camera id of its own: a test can
// never inherit another test's flight.
let camSeq = 0;
function cam(extra = {}) {
  camSeq += 1;
  return { id: `cam-sf-${camSeq}`, name: `Single-flight cam ${camSeq}`, mediamtx_path: `path_sf_${camSeq}`, snapshot_url: null, ...extra };
}

after(() => cleanupTempDataDirs());

// Every suite has a deadline (PR #665 review). These tests wait on promises the test itself resolves, so a
// regression that breaks the sharing (a constant key, say) can leave a flight that never settles under a key a
// later test reuses, and every later grab would then wait on it forever. CI's test job has no time limit of its
// own, so without this the file would hang for hours instead of failing. Each test here takes milliseconds;
// 5 s is generous on a loaded runner. Subtests inherit it from their describe.
const SUITE = { timeout: 5000 };

// The "stays unavailable until the app restarts" line (KNOWN-ISSUES tells an admin to restart on it), counted.
const stillFrameWarnings = (lines) => lines.filter((w) => w.includes('[snapshot] still frame')).length;

describe('grabLiveFrame: one grab per camera at a time (#552)', SUITE, () => {
  test('five requests at once share one capture and all get the same buffer', async (t) => {
    const warns = [];
    t.mock.method(logger, 'warn', (...a) => warns.push(a.join(' ')));
    const { capture, calls } = fakeCapture();
    const c = cam();
    const pending = Array.from({ length: 5 }, () => grab(c, { capture }));
    assert.equal(calls.length, 1, 'each request started its own capture');
    assert.equal(calls[0].pathName, c.mediamtx_path);
    calls[0].resolve(JPEG_A);
    calls[0].onExit();
    const got = await Promise.all(pending);
    for (const img of got) assert.equal(img, JPEG_A, 'a request got something other than the one grab\'s buffer');
    // Joining a grab that is still RUNNING is the ordinary case and must not log the restart line.
    assert.equal(stillFrameWarnings(warns), 0, 'an ordinary join of a running grab logged the "until the app restarts" line');
  });

  test('a new request after the process exited starts a new grab', async () => {
    const { capture, calls } = fakeCapture();
    const c = cam();
    const first = grab(c, { capture });
    calls[0].onExit(); // the process is gone before the answer is read: the real 'exit' order
    calls[0].resolve(JPEG_A);
    assert.equal(await first, JPEG_A);

    const second = grab(c, { capture });
    assert.equal(calls.length, 2, 'a finished grab was handed out again instead of starting a new one');
    calls[1].resolve(JPEG_B);
    calls[1].onExit();
    assert.equal(await second, JPEG_B);
  });

  test('a null result (the grab failed) does not wedge the camera', async () => {
    const { capture, calls } = fakeCapture();
    const c = cam();
    const first = grab(c, { capture });
    calls[0].resolve(null);
    calls[0].onExit();
    assert.equal(await first, null);
    const second = grab(c, { capture });
    assert.equal(calls.length, 2, 'a failed grab kept the camera from trying again');
    calls[1].resolve(JPEG_B);
    calls[1].onExit();
    assert.equal(await second, JPEG_B);
  });

  test('a rejected capture answers null, never rejects, and does not wedge the camera', async () => {
    const { capture, calls } = fakeCapture();
    const c = cam();
    const first = grab(c, { capture });
    calls[0].reject(new Error('capture broke its contract')); // and never calls onExit
    assert.equal(await first, null);
    const second = grab(c, { capture });
    assert.equal(calls.length, 2, 'a rejected capture kept the camera from trying again');
    calls[1].resolve(JPEG_B);
    calls[1].onExit();
    assert.equal(await second, JPEG_B);
  });

  test('two cameras get two grabs and their own frames', async () => {
    const { capture, calls } = fakeCapture();
    const a = cam();
    const b = cam();
    const pa = grab(a, { capture });
    const pb = grab(b, { capture });
    assert.equal(calls.length, 2, 'two cameras shared one grab');
    assert.deepEqual(calls.map((x) => x.pathName), [a.mediamtx_path, b.mediamtx_path]);
    calls[0].resolve(JPEG_A);
    calls[0].onExit();
    calls[1].resolve(JPEG_B);
    calls[1].onExit();
    assert.equal(await pa, JPEG_A);
    assert.equal(await pb, JPEG_B, 'one camera was given another camera\'s frame');
  });

  test('the HTTP address is fetched once for everyone, and an HTTP-only grab ends when it answers', async () => {
    const http = fakeFetch();
    const { capture, calls } = fakeCapture();
    const c = cam({ snapshot_url: 'http://192.0.2.10/snap.jpg' });
    const pending = Array.from({ length: 5 }, () => grab(c, { fetchHttp: http.fetchHttp, capture }));
    assert.equal(http.calls.length, 1, 'each request fetched the camera\'s HTTP address itself');
    assert.equal(http.calls[0].url, c.snapshot_url);
    http.calls[0].resolve(JPEG_A);
    for (const img of await Promise.all(pending)) assert.equal(img, JPEG_A);
    assert.equal(calls.length, 0, 'the stream grab ran although the HTTP address answered');

    // No process ran, so nothing has to exit: the next request fetches again.
    const again = grab(c, { fetchHttp: http.fetchHttp, capture });
    assert.equal(http.calls.length, 2, 'an HTTP-only grab held the camera after it had answered');
    http.calls[1].resolve(JPEG_B);
    assert.equal(await again, JPEG_B);
  });

  test('when the HTTP address fails, ONE stream grab serves everyone waiting', async () => {
    const http = fakeFetch();
    const { capture, calls } = fakeCapture();
    const c = cam({ snapshot_url: 'http://192.0.2.10/snap.jpg' });
    const pending = Array.from({ length: 5 }, () => grab(c, { fetchHttp: http.fetchHttp, capture }));
    http.calls[0].resolve(null);
    await flush();
    assert.equal(http.calls.length, 1);
    assert.equal(calls.length, 1, 'the fallback stream grab ran once per request');
    calls[0].resolve(JPEG_B);
    calls[0].onExit();
    for (const img of await Promise.all(pending)) assert.equal(img, JPEG_B);
  });

  test('an HTTP fetch that throws falls back to the stream grab', async () => {
    const { capture, calls } = fakeCapture();
    const c = cam({ snapshot_url: 'http://192.0.2.10/snap.jpg' });
    const p = grab(c, { fetchHttp: () => { throw new Error('fetch blew up'); }, capture });
    await flush();
    assert.equal(calls.length, 1);
    calls[0].resolve(JPEG_A);
    calls[0].onExit();
    assert.equal(await p, JPEG_A);
  });

  test('a timed-out grab holds the camera until its process exits (review B9), and says so once', async (t) => {
    const warns = [];
    t.mock.method(logger, 'warn', (...a) => warns.push(a.join(' ')));
    const { capture, calls } = fakeCapture();
    const c = cam();
    const first = grab(c, { capture });
    calls[0].resolve(null); // the timeout: the answer is known, the SIGKILLed process has not exited
    assert.equal(await first, null);

    const during = grab(c, { capture });
    const duringAgain = grab(c, { capture });
    assert.equal(calls.length, 1, 'a second grab started while the killed one was still exiting');
    assert.equal(await during, null);
    assert.equal(await duringAgain, null);
    assert.equal(warns.filter((w) => w.includes('[snapshot] still frame')).length, 1, `logged ${warns.length} times, expected once`);

    calls[0].onExit();
    const later = grab(c, { capture });
    assert.equal(calls.length, 2, 'the camera stayed blocked after the process exited');
    calls[1].resolve(JPEG_A);
    calls[1].onExit();
    assert.equal(await later, JPEG_A);
  });

  test('a late or repeated onExit from a finished grab does not end the newer one', async () => {
    const { capture, calls } = fakeCapture();
    const c = cam();
    const first = grab(c, { capture });
    calls[0].resolve(null);
    calls[0].onExit();
    assert.equal(await first, null);

    const second = grab(c, { capture });
    assert.equal(calls.length, 2);
    calls[0].onExit(); // the OLD grab's onExit, again
    const third = grab(c, { capture });
    assert.equal(calls.length, 2, 'a stale onExit ended the running grab, so a second one started beside it');
    assert.equal(third, second, 'the request did not join the running grab');
    calls[1].resolve(JPEG_A);
    calls[1].onExit();
    assert.equal(await third, JPEG_A);
  });
});

describe('captureSnapshot: onExit fires once, when no ffmpeg is left running', SUITE, () => {
  test('a grab that exits normally resolves its frame and calls onExit once', async () => {
    spawnImpl = (command, args) => new FakeFfmpeg(command, args);
    let exits = 0;
    const p = captureSnapshot('path_normal', { onExit: () => { exits += 1; } });
    const proc = spawned.at(-1);
    assert.ok(proc.args.includes('rtsp://127.0.0.1:8554/path_normal'));
    proc.stdout.emit('data', JPEG_A);
    proc.finish(0);
    assert.deepEqual(await p, JPEG_A);
    assert.equal(exits, 1);
  });

  test('a timeout resolves null at once, and onExit waits for the killed process to exit', async () => {
    spawnImpl = (command, args) => new DyingFfmpeg(command, args);
    let exits = 0;
    const p = captureSnapshot('path_timeout', { timeoutMs: 10, onExit: () => { exits += 1; } });
    const proc = spawned.at(-1);
    assert.equal(await p, null);
    assert.deepEqual(proc.signals, ['SIGKILL']);
    assert.equal(exits, 0, 'onExit fired before the killed process had exited');
    proc.finish(null, 'SIGKILL');
    await flush();
    assert.equal(exits, 1);
  });

  test('a spawn that throws resolves null (it used to reject) and calls onExit', async (t) => {
    t.mock.method(logger, 'error', () => {});
    spawnImpl = () => { throw new Error('spawn EPERM'); };
    let exits = 0;
    const got = await captureSnapshot('path_throw', { onExit: () => { exits += 1; } });
    assert.equal(got, null);
    assert.equal(exits, 1);
  });

  test('a spawn that fails later (ffmpeg missing: an error with no pid) calls onExit at the error', async () => {
    let proc;
    spawnImpl = (command, args) => {
      proc = new FakeFfmpeg(command, args);
      proc.pid = undefined; // a process that never started has no pid
      // Node 24's order for ENOENT, measured: 'error', then 'close', and no 'exit'. The 'close' is emitted by
      // the test below, AFTER checking that the release already happened at the 'error'.
      queueMicrotask(() => proc.emit('error', Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' })));
      return proc;
    };
    let exits = 0;
    assert.equal(await captureSnapshot('path_enoent', { onExit: () => { exits += 1; } }), null);
    assert.equal(exits, 1, 'a spawn that never started was not released at its error');
    proc.emit('close', -4058, null);
    proc.emit('exit', -4058, null); // Node's docs allow an 'exit' after an 'error': still once
    assert.equal(exits, 1, 'onExit fired more than once');
  });

  test('an error on a process that is still running (a failed kill) waits for its exit', async () => {
    spawnImpl = (command, args) => new FakeFfmpeg(command, args); // has a pid: it started
    let exits = 0;
    const p = captureSnapshot('path_killfail', { onExit: () => { exits += 1; } });
    const proc = spawned.at(-1);
    proc.emit('error', Object.assign(new Error('kill EPERM'), { code: 'EPERM' }));
    assert.equal(await p, null);
    assert.equal(exits, 0, 'onExit fired while the process was still running');
    proc.finish(null, 'SIGKILL');
    await flush();
    assert.equal(exits, 1);
  });

  test('a failed kill, then the child ends with close and no exit: onExit still fires, once', async () => {
    spawnImpl = (command, args) => new FakeFfmpeg(command, args); // has a pid: it started
    let exits = 0;
    const p = captureSnapshot('path_killfail_close', { onExit: () => { exits += 1; } });
    const proc = spawned.at(-1);
    proc.emit('error', Object.assign(new Error('kill EPERM'), { code: 'EPERM' }));
    assert.equal(await p, null);
    assert.equal(exits, 0);
    proc.emit('close', null, 'SIGKILL'); // the end arrives only as 'close'
    assert.equal(exits, 1, "a child that ended with 'close' and no 'exit' was never reported as gone");
    proc.emit('close', null, 'SIGKILL');
    assert.equal(exits, 1, 'onExit fired more than once');
  });

  test("exit then close (Node's normal order) fires onExit exactly once", async () => {
    spawnImpl = (command, args) => new FakeFfmpeg(command, args);
    let exits = 0;
    const p = captureSnapshot('path_exit_close', { onExit: () => { exits += 1; } });
    const proc = spawned.at(-1);
    proc.stdout.emit('data', JPEG_A);
    proc.emit('exit', 0, null);
    // Released at 'exit' already: 'close' also waits for the pipes, which a process holding them open delays.
    assert.equal(exits, 1, "onExit did not fire at 'exit'");
    proc.emit('close', 0, null);
    assert.deepEqual(await p, JPEG_A);
    assert.equal(exits, 1, `onExit fired ${exits} times for one process`);
  });

  test('end to end: after a failed kill the camera is held until the child closes, then a new grab starts', async (t) => {
    t.mock.method(logger, 'warn', () => {}); // the turned-away request logs the still-exiting line, by design
    spawnImpl = (command, args) => new FakeFfmpeg(command, args);
    const c = cam();
    const before = spawned.length;
    const first = grab(c);
    const proc = spawned.at(-1);
    assert.equal(spawned.length - before, 1);
    proc.emit('error', Object.assign(new Error('kill EPERM'), { code: 'EPERM' }));
    assert.equal(await first, null);
    assert.equal(await grab(c), null, 'a request while the child was still running did not get the settled result');
    assert.equal(spawned.length - before, 1, 'a second ffmpeg started beside one that was still running');

    proc.emit('close', null, 'SIGKILL'); // no 'exit' was ever heard
    const next = grab(c);
    assert.equal(spawned.length - before, 2, "the camera stayed held after its child closed without an 'exit'");
    spawned.at(-1).stdout.emit('data', JPEG_B);
    spawned.at(-1).finish(0);
    assert.deepEqual(await next, JPEG_B);
  });

  test('without onExit (the detection callers) a grab behaves as before', async () => {
    // The child's events are emitted SYNCHRONOUSLY here (not through FakeFfmpeg.finish's microtask), so a handler
    // that throws without an onExit fails this test with its own error instead of crashing the file as an
    // uncaught exception, which the mutation harness can only count as "errored".
    spawnImpl = (command, args) => new FakeFfmpeg(command, args);
    const ok = captureSnapshot('path_plain');
    const proc = spawned.at(-1);
    proc.stdout.emit('data', JPEG_B);
    proc.emit('exit', 0, null);
    proc.emit('close', 0, null);
    assert.deepEqual(await ok, JPEG_B);

    spawnImpl = (command, args) => new DyingFfmpeg(command, args);
    assert.equal(await captureSnapshot('path_plain_timeout', { timeoutMs: 10 }), null);
    const dying = spawned.at(-1);
    dying.emit('exit', null, 'SIGKILL'); // a late exit with no onExit must not throw
    dying.emit('close', null, 'SIGKILL');
  });

  test('end to end: a killed ffmpeg that has not exited yet blocks a second ffmpeg for that camera', async (t) => {
    t.mock.method(logger, 'warn', () => {});
    spawnImpl = (command, args) => new DyingFfmpeg(command, args);
    const capture = (pathName, opts) => captureSnapshot(pathName, { ...opts, timeoutMs: 10 });
    const c = cam();
    const before = spawned.length;
    assert.equal(await grab(c, { capture }), null); // timed out and SIGKILLed; still exiting
    assert.equal(await grab(c, { capture }), null);
    assert.equal(spawned.length - before, 1, 'a second ffmpeg started beside one that was still exiting');
    assert.ok(spawned.at(-1).args.includes(`rtsp://127.0.0.1:8554/${c.mediamtx_path}`));

    spawned.at(-1).finish(null, 'SIGKILL');
    await flush();
    const next = grab(c, { capture });
    assert.equal(spawned.length - before, 2, 'the camera stayed blocked after its ffmpeg exited');
    assert.equal(await next, null);
    spawned.at(-1).finish(null, 'SIGKILL');
    await flush();
  });
});

describe('GET /api/cameras/:id/snapshot through the real router', SUITE, () => {
  let app;
  let cameraHttp;
  let token;
  // The camera's own HTTP snapshot endpoints, by path. Each counts its requests and holds every answer until
  // its test lets go.
  const endpoints = new Map();
  function endpoint(path, status, body) {
    const ep = { hits: 0, gate: deferred(), status, body };
    endpoints.set(path, ep);
    return ep;
  }
  const cameraUrl = (path) => `http://127.0.0.1:${cameraHttp.address().port}${path}`;

  // Snapshot requests that have run the SYNCHRONOUS part of the route, which includes the grabLiveFrame call that
  // joins or starts a flight (auth and the camera lookup are synchronous, and so is the spawn of a stream grab).
  // A test releases the camera's answer only once all five of its requests are in, so none can arrive after the
  // flight ended: the counts asserted below cannot be lowered or raised by timing.
  let entered = 0;
  let waiter = null;
  const countEntered = (req, _res, next) => {
    const isSnapshot = req.path.endsWith('/snapshot');
    next();
    if (!isSnapshot) return;
    entered += 1;
    if (waiter && entered >= waiter.n) waiter.d.resolve();
  };
  function enteredAtLeast(n) {
    const d = deferred();
    waiter = { n, d };
    if (entered >= n) d.resolve();
    return d.promise;
  }

  // Five GETs at once for one camera; `release` lets the camera answer once all five are in. Each fetch has its
  // own deadline, so a regression that leaves a request hanging fails the test and the server can still close.
  async function fiveAtOnce(cameraId, release) {
    const base = entered;
    const responses = Array.from({ length: 5 }, () =>
      fetch(`${app.url}/api/cameras/${cameraId}/snapshot`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(3000),
      })
    );
    await enteredAtLeast(base + 5);
    release();
    return Promise.all(
      responses.map(async (r) => {
        const res = await r;
        return {
          status: res.status,
          type: res.headers.get('content-type'),
          cache: res.headers.get('cache-control'),
          body: Buffer.from(await res.arrayBuffer()),
        };
      })
    );
  }

  before(async () => {
    cameraHttp = createServer(async (req, res) => {
      const ep = endpoints.get(req.url);
      if (!ep) {
        res.statusCode = 404;
        res.end();
        return;
      }
      ep.hits += 1;
      await ep.gate.promise;
      res.statusCode = ep.status;
      if (ep.status === 200) res.setHeader('content-type', 'image/jpeg');
      res.end(ep.body);
    });
    await new Promise((r) => cameraHttp.listen(0, '127.0.0.1', r));
    const care = makeUser(db, { id: 'u-sf-care', username: 'carer', role: 'caregiver' });
    token = signToken({ id: care.id, username: care.username, role: 'caregiver', sid: makeSession(db, care.id) });
    app = await mountRouter('/api/cameras', camerasRouter, { middleware: [countEntered] });
  });

  after(async () => {
    for (const ep of endpoints.values()) ep.gate.resolve();
    await app?.close();
    await new Promise((r) => {
      cameraHttp.close(r);
      cameraHttp.closeAllConnections?.();
    });
  });

  test('five concurrent GETs for one camera make ONE request to the camera, and all five get the frame', async (t) => {
    const warns = [];
    t.mock.method(logger, 'warn', (...a) => warns.push(a.join(' ')));
    const ep = endpoint('/snap.jpg', 200, JPEG_A);
    makeCamera(db, { id: 'cam-sf-route', extra: { snapshot_url: cameraUrl('/snap.jpg'), disabled: 1 } });
    const got = await fiveAtOnce('cam-sf-route', () => ep.gate.resolve());
    assert.equal(ep.hits, 1, `the camera was asked ${ep.hits} times for one still frame`);
    for (const g of got) {
      assert.equal(g.status, 200);
      assert.equal(g.type, 'image/jpeg');
      assert.equal(g.cache, 'no-store', 'a live frame was served cacheable');
      assert.deepEqual(g.body, JPEG_A);
    }
    assert.equal(stillFrameWarnings(warns), 0, 'an ordinary join of a running grab logged the "until the app restarts" line');
  });

  // The default capture (the real captureSnapshot), with nothing injected: the route's ffmpeg path end to end, with
  // the mocked spawn standing in for ffmpeg.
  test('with no HTTP address, five concurrent GETs start ONE ffmpeg and all five get its frame', async (t) => {
    const warns = [];
    t.mock.method(logger, 'warn', (...a) => warns.push(a.join(' ')));
    const procs = [];
    spawnImpl = (command, args) => {
      const proc = new FakeFfmpeg(command, args);
      procs.push(proc);
      return proc;
    };
    makeCamera(db, { id: 'cam-sf-route-ffmpeg', extra: { disabled: 1 } });
    const got = await fiveAtOnce('cam-sf-route-ffmpeg', () => {
      // Answer EVERY process that was started, so a regression that starts five fails on the count, not on a hang.
      for (const proc of procs) {
        proc.stdout.emit('data', JPEG_B);
        proc.finish(0);
      }
    });
    assert.equal(procs.length, 1, `${procs.length} ffmpeg processes for one still frame`);
    assert.ok(procs[0].args.includes('rtsp://127.0.0.1:8554/path_cam-sf-route-ffmpeg'));
    for (const g of got) {
      assert.equal(g.status, 200);
      assert.equal(g.type, 'image/jpeg');
      assert.equal(g.cache, 'no-store', 'a live frame was served cacheable');
      assert.deepEqual(g.body, JPEG_B);
    }
    assert.equal(stillFrameWarnings(warns), 0, 'an ordinary join of a running grab logged the "until the app restarts" line');
  });

  test('when the HTTP address and the ffmpeg both fail, all five get the same 503 and its JSON body', async (t) => {
    t.mock.method(logger, 'info', () => {}); // fetchHttpSnapshot logs the camera's HTTP 500
    const ep = endpoint('/broken.jpg', 500, 'the camera says no');
    const procs = [];
    spawnImpl = (command, args) => {
      const proc = new FakeFfmpeg(command, args);
      procs.push(proc);
      proc.finish(1); // ffmpeg fails with no frame
      return proc;
    };
    makeCamera(db, { id: 'cam-sf-route-fail', extra: { snapshot_url: cameraUrl('/broken.jpg'), disabled: 1 } });
    const got = await fiveAtOnce('cam-sf-route-fail', () => ep.gate.resolve());
    assert.equal(ep.hits, 1, `the camera was asked ${ep.hits} times`);
    assert.equal(procs.length, 1, `the fallback ffmpeg ran ${procs.length} times`);
    for (const g of got) {
      assert.equal(g.status, 503);
      assert.match(g.type, /^application\/json/);
      assert.equal(g.body.toString('utf8'), JSON.stringify({ error: 'Could not grab a frame right now' }));
    }
  });
});
