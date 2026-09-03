// A failing background task must degrade one thing, not kill an unattended baby monitor.
//
// The defect (issue #254): the watchdogs are `setInterval(async () => { ... })`. The promise such a
// callback returns is held by nothing, so a rejection inside it is an UNHANDLED REJECTION, and Node's
// default for that is to terminate the process. Nothing in the backend handled it. Worse, the fault is
// correlated with itself: `upsertPath` is a bare fetch that also throws on a non-2xx, reached from both
// `startSubStream` and `startTranscoder`, and MediaMTX being down is exactly what makes a path unready
// for 30s — the only condition that reaches those calls. So the watchdog killed the app precisely when
// it was trying to heal the thing it exists to heal.
//
// ⚠️ These cases assert on Node's REAL rejection/exception machinery rather than on a stub, because the
// bug lives in that machinery: a test against a fake event emitter would pass against the broken code.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { useTempDataDir, cleanupTempDataDirs } from './helpers/harness.js';

const scriptDir = useTempDataDir();

const { logger } = await import('../src/lib/logger.js');
const { safeInterval, reportGuardFailure, installCrashGuards } = await import('../src/lib/processGuards.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const logged = (needle) => logger.getRecent().filter((l) => l.includes(needle)).length;

const timers = [];
afterEach(() => {
  while (timers.length) clearInterval(timers.pop());
  logger.clear();
});

describe('safeInterval', () => {
  test('an async tick that REJECTS is reported, and never reaches Node as an unhandled rejection', async () => {
    // The precise shape of the #254 crash. Without safeInterval this rejection is unhandled, and an
    // unhandled rejection in a node:test file fails the run — which is what makes this discriminating.
    const seen = [];
    const onUnhandled = (reason) => seen.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      let ticks = 0;
      timers.push(
        safeInterval('probe', 20, async () => {
          ticks += 1;
          throw new Error('ECONNREFUSED to mediamtx');
        })
      );
      await sleep(120);

      assert.deepEqual(seen, [], 'the rejection escaped to Node — the process would have exited here');
      assert.ok(ticks >= 2, `the timer stopped after the first failure (${ticks} tick(s))`);
      assert.ok(logged('[guard:probe]') >= 2, 'the failure was swallowed silently instead of being logged');
      assert.ok(logged('ECONNREFUSED to mediamtx') >= 1, 'the log line does not carry the real reason');
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  test('a SYNCHRONOUS throw before the first await is caught too', async () => {
    // Not the same path: this one never produces a promise at all, so the `.then` guard cannot see it.
    // A real example is the `db.prepare(...)` at the top of a watchdog tick.
    let ticks = 0;
    timers.push(
      safeInterval('sync-probe', 20, () => {
        ticks += 1;
        throw new Error('db is locked');
      })
    );
    await sleep(120);

    assert.ok(ticks >= 2, 'the timer stopped after a synchronous throw');
    assert.ok(logged('[guard:sync-probe]') >= 2);
    assert.ok(logged('db is locked') >= 1);
  });

  test('a healthy tick is left completely alone', async () => {
    // The guard must not change behaviour when nothing is wrong: same cadence, nothing logged.
    let ticks = 0;
    timers.push(safeInterval('quiet', 20, async () => { ticks += 1; }));
    await sleep(120);

    assert.ok(ticks >= 2, 'the guarded timer did not run');
    assert.equal(logged('[guard:quiet]'), 0, 'a successful tick logged a failure');
  });

  test('it returns the real timer, so callers can still clear and unref it', async () => {
    // index.js and timelapse.js both rely on this: the sampler calls `.unref?.()` on the result.
    let ticks = 0;
    const t = safeInterval('clearable', 20, async () => { ticks += 1; });
    assert.equal(typeof t.unref, 'function', 'not a Timeout — unref?.() would silently no-op');
    clearInterval(t);
    const after = ticks;
    await sleep(80);
    assert.equal(ticks, after, 'clearInterval did not stop the guarded timer');
  });
});

describe('reportGuardFailure', () => {
  test('it carries the stack for an Error, and still says something useful for a non-Error', () => {
    // Rejections are not always Errors — `Promise.reject('nope')` is legal and has no stack. A guard
    // that assumed Error would log "undefined" for exactly the cases that are hardest to diagnose.
    reportGuardFailure('with-error', new Error('boom-marker'));
    assert.ok(logged('boom-marker') >= 1);
    assert.ok(logged('at ') >= 1, 'no stack frames were logged for an Error');

    reportGuardFailure('with-string', 'plain-string-marker');
    assert.ok(logged('plain-string-marker') >= 1, 'a non-Error rejection reason was lost');
  });
});

describe('installCrashGuards', () => {
  // ⚠️ THESE RUN IN A CHILD PROCESS, and that is not incidental. node:test installs its OWN
  // unhandledRejection/uncaughtException handling and attributes anything it catches to the running
  // test, failing it — so in-process these cases fail even though the guard demonstrably works (its log
  // line is right there in the output). The only way to observe what Node actually does to an
  // UNGUARDED process is to be a separate process. Each case therefore runs the same script twice, once
  // with the guards installed and once without, and asserts the difference: that is the whole claim,
  // and it needs no mutation to prove.
  const guardsUrl = pathToFileURL(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'lib', 'processGuards.js')
  ).href;

  // Written with fs, never handed to a shell (the workspace rule) — this text is full of backticks and
  // $ and would be mangled by any shell that touched it.
  function runScript(body, { withGuards }) {
    const file = path.join(scriptDir, `guard-probe-${Math.random().toString(36).slice(2)}.mjs`);
    fs.writeFileSync(
      file,
      [
        `import { installCrashGuards } from ${JSON.stringify(guardsUrl)};`,
        withGuards ? 'installCrashGuards();' : '// guards deliberately NOT installed',
        body,
        // Printed last: if the process died first, the marker is absent AND the exit code is non-zero.
        'setTimeout(() => { console.log("SURVIVED"); process.exit(0); }, 120);',
      ].join('\n')
    );
    return new Promise((resolve) => {
      const proc = spawn(process.execPath, [file], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      proc.stdout.on('data', (c) => (out += c));
      proc.stderr.on('data', (c) => (out += c));
      proc.on('close', (code) => resolve({ code, out }));
    });
  }

  test('a floating rejection kills an unguarded process, and is survived + logged by a guarded one', async () => {
    // The case no call-site guard can cover: a promise attached to nothing at all.
    const body = 'Promise.reject(new Error("floating-rejection-marker"));';

    const unguarded = await runScript(body, { withGuards: false });
    assert.notEqual(unguarded.code, 0, 'an unguarded floating rejection did NOT kill the process — the premise of #254 is wrong');
    assert.ok(!unguarded.out.includes('SURVIVED'), 'the unguarded process kept running');

    const guarded = await runScript(body, { withGuards: true });
    assert.equal(guarded.code, 0, `the guarded process still died: ${guarded.out}`);
    assert.ok(guarded.out.includes('SURVIVED'), 'the guarded process did not reach the end');
    assert.ok(guarded.out.includes('[guard:unhandledRejection]'), 'the failure was swallowed silently');
    assert.ok(guarded.out.includes('floating-rejection-marker'), 'the log line does not carry the reason');
  });

  test('an uncaught synchronous throw likewise', async () => {
    // Deliberately not Node's default advice — see the comment in processGuards.js. An overnight
    // monitor that keeps running degraded beats one that is gone.
    const body = 'setTimeout(() => { throw new Error("uncaught-marker"); }, 0);';

    const unguarded = await runScript(body, { withGuards: false });
    assert.notEqual(unguarded.code, 0, 'an unguarded uncaught throw did NOT kill the process');

    const guarded = await runScript(body, { withGuards: true });
    assert.equal(guarded.code, 0, `the guarded process still died: ${guarded.out}`);
    assert.ok(guarded.out.includes('[guard:uncaughtException]'));
    assert.ok(guarded.out.includes('uncaught-marker'));
  });
});

describe('index.js wiring', () => {
  // ⚠️ WHAT THIS IS AND IS NOT. index.js boots the whole app — it spawns child processes and binds a
  // port — so no unit test can execute its watchdogs, and the guards there would otherwise ship with no
  // test at all. This reads the source TEXT instead. It proves the dangerous construct is absent and
  // the backstop is installed; it does NOT prove the watchdogs behave correctly. It is a tripwire for
  // the next person (the same reason the PRAGMA check exists in cameras-assign-exposure.test.js): a new
  // `setInterval(async …)` added in a year's time fails this immediately, instead of crashing a
  // stranger's monitor at 3am.
  const indexSrc = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js'),
    'utf8'
  );

  test('no bare setInterval takes an async callback', () => {
    const offenders = [...indexSrc.matchAll(/setInterval\(\s*async/g)];
    assert.equal(
      offenders.length,
      0,
      'a setInterval with an async callback floats its promise: a rejection there exits the process. Use safeInterval.'
    );
  });

  test('the crash backstop is installed at startup', () => {
    assert.match(indexSrc, /^installCrashGuards\(\);$/m, 'installCrashGuards() is not called at top level');
  });

  test('both watchdog loops isolate one camera from the next', () => {
    // Without this, the first camera to throw skips every camera after it for that tick — and the fault
    // repeats every tick, so one bad camera permanently blocks its siblings.
    assert.ok(
      indexSrc.includes('reportGuardFailure(`camera-watchdog:${cam.name}`, err)'),
      'the frame watchdog has no per-camera guard'
    );
    assert.ok(
      indexSrc.includes('reportGuardFailure(`audio-watchdog:${cam.name}`, err)'),
      'the audio watchdog has no per-camera guard'
    );
  });
});

process.on('exit', cleanupTempDataDirs);
