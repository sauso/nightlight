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
//       and the route test "five concurrent GETs for one camera make ONE request to the camera".
//   C2  A failed grab does not wedge the camera. Tests: "a new request after the process exited starts a new
//       grab", "a null result", "a rejected capture", "a late or repeated onExit", and captureSnapshot's onExit
//       tests (a normal exit, a spawn that throws, a spawn that fails later).
//   C3  Cameras never share a frame. Test: "two cameras get two grabs and their own frames".
//
// HOW. grabLiveFrame takes injectable `fetchHttp`/`capture` (real injection; snapshot.js is NOT mocked).
// captureSnapshot's own onExit wiring runs against a fake child process: `node:child_process` is mocked, which is
// not in test:core's include list (see helpers/fakeFfmpeg.js). The route test mounts the REAL cameras router with
// the camera's snapshot_url pointing at a local HTTP server that holds its answer, so no ffmpeg is involved.
// snapshot.js is imported as a namespace and grabLiveFrame reached through grab(), so that against code without
// #552 the grabLiveFrame tests fail one by one and the route test still runs (and fails on its hit count).
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

describe('grabLiveFrame: one grab per camera at a time (#552)', () => {
  test('five requests at once share one capture and all get the same buffer', async () => {
    const { capture, calls } = fakeCapture();
    const c = cam();
    const pending = Array.from({ length: 5 }, () => grab(c, { capture }));
    assert.equal(calls.length, 1, 'each request started its own capture');
    assert.equal(calls[0].pathName, c.mediamtx_path);
    calls[0].resolve(JPEG_A);
    calls[0].onExit();
    const got = await Promise.all(pending);
    for (const img of got) assert.equal(img, JPEG_A, 'a request got something other than the one grab\'s buffer');
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

describe('captureSnapshot: onExit fires once, when no ffmpeg is left running', () => {
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

  test('a spawn that fails later (ffmpeg missing: an error with no pid) calls onExit', async () => {
    let proc;
    spawnImpl = (command, args) => {
      proc = new FakeFfmpeg(command, args);
      proc.pid = undefined; // a process that never started has no pid
      // Node 24's order for ENOENT, measured: 'error', then 'close', and no 'exit'.
      queueMicrotask(() => {
        proc.emit('error', Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' }));
        proc.emit('close', -4058, null);
      });
      return proc;
    };
    let exits = 0;
    assert.equal(await captureSnapshot('path_enoent', { onExit: () => { exits += 1; } }), null);
    assert.equal(exits, 1, 'a spawn that never started left its camera waiting for an exit that never comes');
    proc.emit('exit', -4058, null); // Node's docs allow an 'exit' after an 'error': still once
    assert.equal(exits, 1, 'onExit fired twice');
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

  test('without onExit (the detection callers) a grab behaves as before', async () => {
    spawnImpl = (command, args) => new FakeFfmpeg(command, args);
    const ok = captureSnapshot('path_plain');
    spawned.at(-1).stdout.emit('data', JPEG_B);
    spawned.at(-1).finish(0);
    assert.deepEqual(await ok, JPEG_B);

    spawnImpl = (command, args) => new DyingFfmpeg(command, args);
    assert.equal(await captureSnapshot('path_plain_timeout', { timeoutMs: 10 }), null);
    spawned.at(-1).finish(null, 'SIGKILL'); // a late exit with no onExit must not throw
    await flush();
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

describe('GET /api/cameras/:id/snapshot through the real router', () => {
  let app;
  let cameraHttp;
  let token;
  let hits = 0;
  const gate = deferred();
  // Resolved once five snapshot requests have run the SYNCHRONOUS part of the route, which includes the
  // grabLiveFrame call that joins or starts a flight (auth and the camera lookup are synchronous). Releasing the
  // camera's answer only then means no request can arrive after the flight ended: the count below cannot be
  // lowered or raised by timing.
  let entered = 0;
  const allEntered = deferred();
  const countEntered = (req, _res, next) => {
    const isSnapshot = req.path.endsWith('/snapshot');
    next();
    if (isSnapshot && ++entered === 5) allEntered.resolve();
  };

  before(async () => {
    // The camera's own HTTP snapshot endpoint: counts every request and holds every answer until the test lets go.
    cameraHttp = createServer(async (_req, res) => {
      hits += 1;
      await gate.promise;
      res.setHeader('content-type', 'image/jpeg');
      res.end(JPEG_A);
    });
    await new Promise((r) => cameraHttp.listen(0, '127.0.0.1', r));
    const care = makeUser(db, { id: 'u-sf-care', username: 'carer', role: 'caregiver' });
    token = signToken({ id: care.id, username: care.username, role: 'caregiver', sid: makeSession(db, care.id) });
    makeCamera(db, {
      id: 'cam-sf-route',
      extra: { snapshot_url: `http://127.0.0.1:${cameraHttp.address().port}/snap.jpg`, disabled: 1 },
    });
    app = await mountRouter('/api/cameras', camerasRouter, { middleware: [countEntered] });
  });

  after(async () => {
    gate.resolve();
    await app?.close();
    await new Promise((r) => {
      cameraHttp.close(r);
      cameraHttp.closeAllConnections?.();
    });
  });

  test('five concurrent GETs for one camera make ONE request to the camera, and all five get the frame', async () => {
    const responses = Array.from({ length: 5 }, () =>
      fetch(`${app.url}/api/cameras/cam-sf-route/snapshot`, { headers: { authorization: `Bearer ${token}` } })
    );
    await allEntered.promise;
    gate.resolve();
    const got = await Promise.all(
      responses.map(async (r) => {
        const res = await r;
        return { status: res.status, type: res.headers.get('content-type'), body: Buffer.from(await res.arrayBuffer()) };
      })
    );
    assert.equal(hits, 1, `the camera was asked ${hits} times for one still frame`);
    for (const g of got) {
      assert.equal(g.status, 200);
      assert.equal(g.type, 'image/jpeg');
      assert.deepEqual(g.body, JPEG_A);
    }
  });
});
