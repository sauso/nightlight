// #479: restart a MediaMTX that is alive but no longer answers its API.
//
// THE GAP. mediamtxProcess.js relaunches MediaMTX when its process EXITS. Since #451 an API call that gets no answer
// within 5 s is UNKNOWN (never evidence), so nothing acted on a MediaMTX that stayed alive and silent: it stayed wedged until
// someone restarted the container. lib/mediamtxApiWatchdog.js restarts it after SUSTAINED silence, with a backoff.
//
// HOW THIS IS OBSERVED. The probe's classification is driven against a REAL local HTTP stub (accepts and never answers,
// answers 200/500, kills the socket) through the real fetch and the real deadline. The decision logic is driven with an
// injected probe, an injected restart and a fake MONOTONIC clock, so a three-minute window costs no time and no timer.
// Which cases FAIL on the code before #479: all of them (the module does not exist). They fail on a watchdog that
// ignores the thing each names: see the #479 entries in scripts/mutants.json.
import { test, describe, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { useTempDataDir, cleanupTempDataDirs } from './helpers/harness.js';

useTempDataDir();

const held = [];
let handler = (req, res) => { res.statusCode = 500; res.end('unconfigured'); };
const fakeMediamtx = createServer((req, res) => handler(req, res));
await new Promise((resolve) => fakeMediamtx.listen(0, '127.0.0.1', resolve));
process.env.MEDIAMTX_API = `http://127.0.0.1:${fakeMediamtx.address().port}`;

const mediamtx = await import('../src/lib/mediamtx.js');
const watchdog = await import('../src/lib/mediamtxApiWatchdog.js');
const { logger } = await import('../src/lib/logger.js');
const { resetGuardRateLimit } = await import('../src/lib/processGuards.js');
const { HUNG_MS, RECOVERED_MS, MAX_WINDOW_MS, checkMediamtxApi, currentWindowMs, resetMediamtxApiWatchdogForTest } = watchdog;

// 1 s like mediamtx-api-deadline.test.js: a loaded runner turns a slow loopback answer into a timeout at anything shorter.
const DEADLINE_MS = 1000;
mediamtx.setMediamtxApiTimeoutForTest(DEADLINE_MS);

const blackHole = (req, res) => { req.resume(); held.push(res); };
const hungBody = (req, res) => {
  req.resume();
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': '100' });
  res.write('{"paths":');
  held.push(res);
};
const status = (code) => (req, res) => { req.resume(); res.statusCode = code; res.end('{}'); };
const destroySocket = (req) => req.socket.destroy();

beforeEach(() => {
  resetMediamtxApiWatchdogForTest();
  resetGuardRateLimit();
  logger.clear();
});
afterEach(() => {
  for (const res of held.splice(0)) res.destroy();
  watchdog.stopMediamtxApiWatchdog();
});
after(async () => {
  mediamtx.setMediamtxApiTimeoutForTest();
  for (const res of held.splice(0)) res.destroy();
  await new Promise((resolve) => { fakeMediamtx.close(resolve); fakeMediamtx.closeAllConnections?.(); });
  cleanupTempDataDirs();
});

describe('probeMediamtxApi: what counts as silence', () => {
  test('w1: a server that accepts and never answers, or answers the headers and never the body, is a TIMEOUT after the deadline', async () => {
    for (const h of [blackHole, hungBody]) {
      handler = h;
      const startedAt = Date.now();
      assert.equal(await mediamtx.probeMediamtxApi(), 'timeout');
      assert.ok(Date.now() - startedAt >= DEADLINE_MS - 100, 'resolved before the deadline: a fast failure, not silence');
    }
  });

  test('w1b: any HTTP answer is "answered" (a 500 included), a dead socket is "refused", and neither is a hang', async () => {
    handler = status(200);
    assert.equal(await mediamtx.probeMediamtxApi(), 'answered');
    handler = status(500);
    assert.equal(await mediamtx.probeMediamtxApi(), 'answered');
    handler = destroySocket;
    assert.equal(await mediamtx.probeMediamtxApi(), 'refused');
  });

  test('w1c: only an API on this machine is supervised (the child killed must be the server that is silent)', () => {
    assert.equal(mediamtx.mediamtxApiIsLocal('http://127.0.0.1:9997'), true);
    assert.equal(mediamtx.mediamtxApiIsLocal('http://localhost:9997'), true);
    assert.equal(mediamtx.mediamtxApiIsLocal('http://[::1]:9997'), true);
    assert.equal(mediamtx.mediamtxApiIsLocal('http://10.0.0.5:9997'), false);
    assert.equal(mediamtx.mediamtxApiIsLocal('http://mediamtx.example:9997'), false);
    assert.equal(mediamtx.mediamtxApiIsLocal('not a url'), false);
  });
});

// Drives checkMediamtxApi with a scripted probe and a clock the test sets.
function rig() {
  const r = { clock: 0, results: [], restarts: 0, restartResult: true, onRestarts: [], onRestartThrows: false };
  r.tick = (at, result) => {
    r.clock = at;
    r.results.push(result);
    return checkMediamtxApi({
      probe: async () => result,
      now: () => r.clock,
      restart: () => { r.restarts += 1; return r.restartResult; },
      onRestart: (info) => { r.onRestarts.push(info); if (r.onRestartThrows) throw new Error('onRestart failed'); },
    });
  };
  return r;
}

describe('checkMediamtxApi: when silence becomes a restart', () => {
  test('w2: restarts exactly ONCE after HUNG_MS of unbroken silence, then waits twice as long for the next', async () => {
    const r = rig();
    assert.equal(await r.tick(0, 'timeout'), 'unknown');
    assert.equal(await r.tick(HUNG_MS - 1, 'timeout'), 'unknown');
    assert.equal(r.restarts, 0, 'restarted before the window');
    assert.equal(await r.tick(HUNG_MS, 'timeout'), 'restarted');
    assert.equal(r.restarts, 1);
    assert.equal(r.onRestarts.length, 1);
    assert.equal(r.onRestarts[0].silentMs, HUNG_MS);
    assert.ok(logger.getRecent().some((l) => l.includes('restarting the MediaMTX process')), 'the restart was not logged loudly');
    // Still silent: the stamp starts again, and the window is now doubled.
    const t0 = HUNG_MS + 30_000;
    assert.equal(await r.tick(t0, 'timeout'), 'unknown');
    assert.equal(await r.tick(t0 + 2 * HUNG_MS - 1, 'timeout'), 'unknown');
    assert.equal(r.restarts, 1, 'a second restart inside the doubled window');
    assert.equal(await r.tick(t0 + 2 * HUNG_MS, 'timeout'), 'restarted');
    assert.equal(r.restarts, 2);
  });

  test('w2b: the window doubles to a ceiling of MAX_WINDOW_MS', async () => {
    const r = rig();
    let t = 0;
    const seen = [];
    for (let i = 0; i < 7; i++) {
      await r.tick(t, 'timeout');
      t += currentWindowMs();
      assert.equal(await r.tick(t, 'timeout'), 'restarted');
      seen.push(currentWindowMs());
      t += 30_000;
    }
    assert.deepEqual(seen.slice(0, 4), [2 * HUNG_MS, 4 * HUNG_MS, 8 * HUNG_MS, 16 * HUNG_MS].map((w) => Math.min(w, MAX_WINDOW_MS)));
    assert.equal(seen.at(-1), MAX_WINDOW_MS);
  });

  test('w3: any answer breaks the streak: a server that answers now and then is never restarted', async () => {
    const r = rig();
    await r.tick(0, 'timeout');
    assert.equal(await r.tick(100_000, 'answered'), 'ok');
    await r.tick(200_000, 'timeout'); // a NEW stamp
    assert.equal(await r.tick(200_000 + HUNG_MS - 1, 'timeout'), 'unknown');
    assert.equal(r.restarts, 0, 'the stamp survived an answer');
  });

  test('w4: a refused connection is not a hang: it clears the stamp and never restarts', async () => {
    const r = rig();
    await r.tick(0, 'timeout');
    assert.equal(await r.tick(HUNG_MS - 30_000, 'refused'), 'ok');
    await r.tick(HUNG_MS, 'timeout');
    assert.equal(await r.tick(HUNG_MS + 60_000, 'timeout'), 'unknown');
    assert.equal(r.restarts, 0);
  });

  test('w5: the backoff is cleared by SUSTAINED answers (RECOVERED_MS), not by the first one', async () => {
    const r = rig();
    await r.tick(0, 'timeout');
    await r.tick(HUNG_MS, 'timeout'); // restart 1
    assert.equal(currentWindowMs(), 2 * HUNG_MS);
    // The restarted server answers at once and keeps answering, but not for long enough yet.
    const base = HUNG_MS + 30_000;
    await r.tick(base, 'answered');
    await r.tick(base + RECOVERED_MS - 1, 'answered');
    assert.equal(currentWindowMs(), 2 * HUNG_MS, 'one early answer reset the backoff');
    await r.tick(base + RECOVERED_MS, 'answered');
    assert.equal(currentWindowMs(), HUNG_MS, 'sustained answers did not reset the backoff');
  });

  test('w5b: answers that are interrupted by a refusal or a timeout restart the recovery count', async () => {
    const r = rig();
    await r.tick(0, 'timeout');
    await r.tick(HUNG_MS, 'timeout'); // restart 1
    const base = HUNG_MS + 30_000;
    await r.tick(base, 'answered');
    await r.tick(base + 60_000, 'refused'); // breaks the run
    await r.tick(base + 90_000, 'answered');
    await r.tick(base + 90_000 + RECOVERED_MS - 1, 'answered');
    assert.equal(currentWindowMs(), 2 * HUNG_MS, 'a broken run of answers still counted');
    // The same for a TIMEOUT in the middle of the run: a flapping server must not get its backoff reset 5 minutes after its first answer.
    const r2 = rig();
    resetMediamtxApiWatchdogForTest();
    await r2.tick(0, 'timeout');
    await r2.tick(HUNG_MS, 'timeout'); // restart 1
    const b2 = HUNG_MS + 30_000;
    await r2.tick(b2, 'answered');
    await r2.tick(b2 + 60_000, 'timeout'); // breaks the run
    await r2.tick(b2 + 90_000, 'answered');
    await r2.tick(b2 + RECOVERED_MS, 'answered'); // 5 min after the FIRST answer, but only 3.5 min into the unbroken run
    assert.equal(currentWindowMs(), 2 * HUNG_MS, 'a timeout did not break the run of healthy answers');
  });

  test('w6b: the state is committed BEFORE the restart is attempted (a restart that throws is not repeated on the next tick)', async () => {
    let calls = 0;
    const tick = (at, result, restart) => checkMediamtxApi({ probe: async () => result, now: () => at, restart });
    await tick(0, 'timeout', () => true);
    await assert.rejects(() => tick(HUNG_MS, 'timeout', () => { calls += 1; throw new Error('kill failed'); }), /kill failed/);
    assert.equal(calls, 1);
    // Committed: the stamp was cleared before the throw, so the next tick starts a fresh window instead of restarting again.
    assert.equal(await tick(HUNG_MS + 30_000, 'timeout', () => { calls += 1; return true; }), 'unknown');
    assert.equal(calls, 1, 'the throwing restart was repeated on the very next tick');
  });

  test('w6: a restart that signalled nothing (the child is already gone) claims nothing and does not back off', async () => {
    const r = rig();
    r.restartResult = false;
    await r.tick(0, 'timeout');
    assert.equal(await r.tick(HUNG_MS, 'timeout'), 'not-signalled');
    assert.equal(r.onRestarts.length, 0, 'Camera history would claim a restart that did not happen');
    assert.equal(currentWindowMs(), HUNG_MS);
    assert.equal(logger.getRecent().filter((l) => l.includes('restarting the MediaMTX process')).length, 0);
  });

  test('w7: a throwing onRestart is logged, and the restart is still counted (it is not repeated on the next tick)', async () => {
    const r = rig();
    r.onRestartThrows = true;
    await r.tick(0, 'timeout');
    assert.equal(await r.tick(HUNG_MS, 'timeout'), 'restarted');
    assert.equal(currentWindowMs(), 2 * HUNG_MS);
    assert.ok(logger.getRecent().some((l) => l.includes('after the API-hung restart')));
    await r.tick(HUNG_MS + 30_000, 'timeout');
    assert.equal(await r.tick(HUNG_MS + 60_000, 'timeout'), 'unknown');
    assert.equal(r.restarts, 1);
  });

  test('w8: ticks never overlap: a probe still waiting makes the next tick a no-op', async () => {
    let release;
    const slow = checkMediamtxApi({ probe: () => new Promise((resolve) => { release = () => resolve('answered'); }), now: () => 0, restart: () => true });
    assert.equal(await checkMediamtxApi({ probe: async () => 'timeout', now: () => 0, restart: () => true }), 'busy');
    release();
    assert.equal(await slow, 'ok');
    assert.equal(await checkMediamtxApi({ probe: async () => 'answered', now: () => 0, restart: () => true }), 'ok');
  });
});

describe('the whole chain', () => {
  test('w9: a real probe against a server that never answers, over two ticks on a fake clock, restarts once', async () => {
    handler = blackHole;
    let clock = 0;
    let restarts = 0;
    const tick = () => checkMediamtxApi({ now: () => clock, restart: () => { restarts += 1; return true; } });
    assert.equal(await tick(), 'unknown');
    clock = HUNG_MS;
    assert.equal(await tick(), 'restarted');
    assert.equal(restarts, 1);
  });

  test('w9b: a server that is merely SLOW (answers inside the deadline) is never restarted, however long it stays slow', async () => {
    handler = (req, res) => { req.resume(); setTimeout(() => { res.statusCode = 200; res.end('{}'); }, DEADLINE_MS / 4); };
    let clock = 0;
    let restarts = 0;
    for (let i = 0; i < 4; i++) {
      assert.equal(await checkMediamtxApi({ now: () => clock, restart: () => { restarts += 1; return true; } }), 'ok');
      clock += HUNG_MS;
    }
    assert.equal(restarts, 0);
  });

  test('w10: start is idempotent, stop nulls the handle (a restart of the module is not a silent no-op), and a remote API is not supervised', () => {
    assert.equal(watchdog.startMediamtxApiWatchdog({ restart: () => true, api: 'http://10.0.0.5:9997' }), null, 'a remote API was supervised');
    const a = watchdog.startMediamtxApiWatchdog({ restart: () => true });
    const b = watchdog.startMediamtxApiWatchdog({ restart: () => true });
    assert.ok(a);
    assert.equal(a, b, 'a second start made a second timer');
    watchdog.stopMediamtxApiWatchdog();
    watchdog.stopMediamtxApiWatchdog(); // safe twice
    const c = watchdog.startMediamtxApiWatchdog({ restart: () => true });
    assert.ok(c && c !== a, 'start after stop did not create a timer');
  });

  test('w12: a check already waiting for its probe when the watchdog is stopped takes no action (shutdown must not SIGTERM MediaMTX mid-stop)', async () => {
    let release;
    let restarts = 0;
    let t = 0;
    // First tick stamps the streak; the second waits on a probe that will say "timeout" past the window.
    await checkMediamtxApi({ probe: async () => 'timeout', now: () => t, restart: () => { restarts += 1; return true; } });
    t = HUNG_MS;
    const waiting = checkMediamtxApi({
      probe: () => new Promise((resolve) => { release = () => resolve('timeout'); }),
      now: () => t,
      restart: () => { restarts += 1; return true; },
    });
    watchdog.stopMediamtxApiWatchdog();
    release();
    assert.equal(await waiting, 'stopped');
    assert.equal(restarts, 0, 'a stopped watchdog restarted MediaMTX');
  });

  test('w13: the STARTED watchdog runs a check every 30 s and reaches onRestart (Camera history) when it restarts', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    let clock = 0;
    const events = [];
    let restarts = 0;
    watchdog.startMediamtxApiWatchdog({
      probe: async () => 'timeout',
      now: () => clock,
      restart: () => { restarts += 1; return true; },
      onRestart: (info) => events.push(info),
    });
    // Six 30 s ticks: the streak is stamped at tick 1 and is 150 s old at tick 6.
    for (let i = 1; i <= 6; i++) {
      clock = (i - 1) * watchdog.CHECK_INTERVAL_MS;
      t.mock.timers.tick(watchdog.CHECK_INTERVAL_MS);
      for (let k = 0; k < 5; k++) await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(restarts, 0, 'restarted inside the window');
    clock = HUNG_MS;
    t.mock.timers.tick(watchdog.CHECK_INTERVAL_MS);
    for (let k = 0; k < 5; k++) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(restarts, 1, 'the started watchdog never restarted (is the interval 30 s? does it run the check?)');
    assert.equal(events.length, 1, 'onRestart never ran: Camera history would not be written');
    assert.equal(events[0].silentMs, HUNG_MS);
  });

  test('w11: shutdown() stops the watchdog FIRST, before its first await (a tick during the awaited stops could SIGTERM MediaMTX)', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const body = src.slice(src.indexOf('async function shutdown()'));
    const stop = body.indexOf('stopMediamtxApiWatchdog()');
    assert.ok(stop > 0, 'shutdown() does not stop the watchdog');
    assert.ok(stop < body.indexOf('await '), 'shutdown() awaits something before it stops the watchdog');
    assert.ok(stop < body.indexOf('stopMediaMTX()'), 'the watchdog is stopped after MediaMTX');
  });
});
