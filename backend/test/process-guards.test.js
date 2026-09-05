// A failing background task must degrade one thing, not kill an unattended baby monitor.
//
// The defect (issue #254): the watchdogs are `setInterval(async () => { ... })`. The promise such a
// callback returns is held by nothing, so a rejection inside it is an UNHANDLED REJECTION, and Node's
// default for that is to terminate the process. Nothing in the backend handled it.
//
// ⚠️ WHAT ACTUALLY THROWS — corrected after adversarial review of PR #275. The PR first claimed the
// crash was reachable from every watchdog through `upsertPath`. That was wrong: `startTranscoder`
// already catches it (transcoder.js:135) and everything else it awaits swallows its own errors, so the
// audio watchdog has no demonstrated rejection path at all. The two real triggers are `subStream.js:38`
// (the one genuinely bare `upsertPath`) and `db.prepare(...)` at the top of EVERY tick, which
// better-sqlite3 throws synchronously on SQLITE_BUSY. See lib/processGuards.js.
//
// ⚠️ These cases assert on Node's REAL rejection/exception machinery rather than on a stub, because the
// bug lives in that machinery: a test against a fake event emitter would pass against the broken code.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { useTempDataDir, cleanupTempDataDirs } from './helpers/harness.js';

const scriptDir = useTempDataDir();

const { logger } = await import('../src/lib/logger.js');
const { safeInterval, reportGuardFailure, resetGuardRateLimit } = await import('../src/lib/processGuards.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ⚠️ WAIT FOR THE CONDITION, NEVER FOR A DURATION. These cases used to start a 20ms interval,
// `await sleep(120)`, then assert at least 2 ticks had happened — an assumption about how fast the
// machine is. `node --test` runs each FILE in its own process, concurrently up to the CPU count, and
// under that contention the 120ms could elapse while the interval had fired only once. Reproduced at
// `--test-concurrency=34` on a 6-core box: 6 runs out of 6 red without this change, 6 of 6 green with
// it.
//
// ⚠️ THIS IS NOT ISSUE #278, though an earlier version of this comment said it was. #278 is CI runs
// reporting `fail 0` with N files `cancelled`, and it was measured to be the GitHub runner receiving
// a shutdown signal mid-job — nothing to do with these assertions. An earlier claim here that "a
// GitHub runner has 2 cores" was never measured and is simply wrong: it is 4 cores and 16GB. The
// flake fixed below is real and reproducible; it is just a different, local one.
//
// ★ Polling is not a weaker assertion, it is a STRONGER one — FOR THE POSITIVE CONDITION. The old
// code merely hoped the ticks had happened; this waits until they demonstrably have. A guard that
// stops its timer after the first failure — the exact defect these cases exist to catch — never
// reaches the count and still fails, just at the deadline rather than immediately. The deadline is
// generous ON PURPOSE: it is a backstop for a broken implementation, not a timing assertion, so
// making it large costs nothing on a passing run and cannot mask a regression.
//
// ⚠️⚠️ BUT THAT IS ONLY TRUE OF POSITIVES, AND ASSUMING IT OF EVERY ASSERTION IN THIS FILE WAS A REAL
// REGRESSION — found by adversarial review of this PR and reproduced. `logged(...) === 1` is NOT a
// positive: it asserts that repeated failures were SUPPRESSED, and suppression is defined by
// RELOG_INTERVAL_MS, an ELAPSED-TIME window. The old `await sleep(120)` incidentally gave that
// negative 120ms of real time to be wrong in. Polling for `ticks >= 3` at a 20ms interval returns
// after ~60-70ms, so it handed the same assertion roughly half the window — and a broken rate limiter
// went undetected. Measured, 5 runs each, mutating RELOG_INTERVAL_MS:
//
//     window   old tests        polling-only
//       30ms   killed 5/5       killed 5/5
//       45ms   killed 5/5       SURVIVED 5/5
//       60ms   killed 5/5       SURVIVED 5/5
//
// ★ THE RULE: a poll may only ever REPLACE a wait, never SHORTEN one that a negative assertion is
// standing on. So the wait below satisfies BOTH conditions — enough ticks (so a slow machine cannot
// fail it early, which is the #278 flake) AND enough elapsed time (so the suppression assertion keeps
// the discrimination the fixed sleep had). Strictly stronger than either version alone.
const WAIT_TIMEOUT_MS = 5000;
async function waitFor(predicate, message, timeoutMs = WAIT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(5);
  }
  // ⚠️ `message` is a THUNK, not a string. Passing a pre-built string captured the counter's value at
  // CALL time, so a real failure reported "(0 tick(s))" when the count was actually 1 by the deadline
  // — a stale diagnostic pointing at the wrong defect. Also caught by the review of this PR.
  assert.fail(`${typeof message === 'function' ? message() : message} (waited ${timeoutMs}ms)`);
}

// Enough ticks to prove the timer KEPT going, and — for the rate-limited cases — that repeated
// failures really were suppressed rather than never having occurred.
const TICKS_PROVING_REPEAT = 3;

// The floor the suppression assertions stand on. Matches the 120ms the pre-#278 fixed sleep happened
// to provide, so this restores exactly the discrimination that was lost rather than guessing a new
// number: a rate-limit window anywhere below this is now caught, as the table above shows it was.
// Costs 120ms on a passing run, which is the price of the negative being real.
const RATE_LIMIT_WINDOW_PROBE_MS = 120;

// Waits for the tick count AND for enough wall-clock that a too-small RELOG_INTERVAL_MS would have
// re-logged. Use this — not the bare tick wait — before any `logged(...) === 1` assertion.
function provedSuppression(startedAt, ticksSoFar) {
  return () => ticksSoFar() >= TICKS_PROVING_REPEAT && Date.now() - startedAt >= RATE_LIMIT_WINDOW_PROBE_MS;
}
const recent = () => logger.getRecent();
const logged = (needle) => recent().filter((l) => l.includes(needle)).length;

const timers = [];
beforeEach(() => {
  // The rate limiter is per-label module state. Without this reset a later case reporting the same
  // label would be SUPPRESSED and pass for the wrong reason.
  resetGuardRateLimit();
});
afterEach(() => {
  while (timers.length) clearInterval(timers.pop());
  logger.clear();
});

describe('safeInterval', () => {
  test('an async tick that REJECTS is reported, and never reaches Node as an unhandled rejection', async () => {
    const seen = [];
    const onUnhandled = (reason) => seen.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      let ticks = 0;
      const startedAt = Date.now();
      timers.push(
        safeInterval('probe', 20, async () => {
          ticks += 1;
          throw new Error('ECONNREFUSED to mediamtx');
        })
      );
      // provedSuppression, not a bare tick wait: the `logged(...) === 1` below is a NEGATIVE standing
      // on elapsed time. See the rule at the top of this file.
      await waitFor(
        provedSuppression(startedAt, () => ticks),
        () => `the timer stopped after the first failure (${ticks} tick(s))`
      );

      assert.deepEqual(seen, [], 'the rejection escaped to Node — the process would have exited here');
      assert.equal(logged('[guard:probe]'), 1, 'expected exactly one line — the rest are rate-limited');
      assert.ok(logged('ECONNREFUSED to mediamtx') >= 1, 'the log line does not carry the real reason');
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  test('a SYNCHRONOUS throw before the first await is caught too', async () => {
    // Not the same path: this never produces a promise, so the `.then` guard cannot see it. This is the
    // REAL trigger in production — `db.prepare('SELECT * FROM cameras').all()` at the top of each tick,
    // which better-sqlite3 throws synchronously on SQLITE_BUSY or a locked file.
    let ticks = 0;
    const startedAt = Date.now();
    timers.push(
      safeInterval('sync-probe', 20, () => {
        ticks += 1;
        throw new Error('SQLITE_BUSY: database is locked');
      })
    );
    await waitFor(provedSuppression(startedAt, () => ticks), () => `the timer stopped after a synchronous throw (${ticks} tick(s))`);

    assert.equal(logged('[guard:sync-probe]'), 1);
    assert.ok(logged('SQLITE_BUSY') >= 1);
  });

  test('a healthy tick is left completely alone', async () => {
    let ticks = 0;
    timers.push(safeInterval('quiet', 20, async () => { ticks += 1; }));
    await waitFor(() => ticks >= TICKS_PROVING_REPEAT, 'the guarded timer did not run');

    assert.equal(logged('[guard:quiet]'), 0, 'a successful tick logged a failure');
  });

  test('it returns the real timer, so callers can still clear and unref it', async () => {
    let ticks = 0;
    const t = safeInterval('clearable', 20, async () => { ticks += 1; });
    assert.equal(typeof t.unref, 'function', 'not a Timeout — unref?.() would silently no-op');
    clearInterval(t);
    const after = ticks;

    // ⚠️ A NEGATIVE assertion cannot poll for its condition, so it needs a CONTROL instead of a sleep.
    // `await sleep(80)` here was not a flake risk — a starved machine ticks less, so it passed more
    // easily — it was a DISCRIMINATION risk: if clearInterval silently did nothing, a loaded machine
    // might still not have ticked within 80ms, and the mutant would survive. Waiting until an
    // uncleared control timer has ticked several times proves the event loop really ran that many
    // intervals' worth, whatever the machine was doing, before asserting the cleared one stood still.
    let control = 0;
    timers.push(safeInterval('control', 20, async () => { control += 1; }));
    await waitFor(() => control >= TICKS_PROVING_REPEAT, 'the control timer never ran — the wait proves nothing');

    assert.equal(ticks, after, 'clearInterval did not stop the guarded timer');
  });
});

describe('reportGuardFailure', () => {
  test('it carries the stack for an Error, and still says something useful for a non-Error', () => {
    // Rejections are not always Errors — `Promise.reject('nope')` is legal and has no stack.
    reportGuardFailure('with-error', new Error('boom-marker'));
    assert.ok(logged('boom-marker') >= 1);
    assert.ok(logged('at ') >= 1, 'no stack frames were logged for an Error');

    reportGuardFailure('with-string', 'plain-string-marker');
    assert.ok(logged('plain-string-marker') >= 1, 'a non-Error rejection reason was lost');
  });

  test('it logs at ERROR level, because the log viewer filters on that word', () => {
    // Not cosmetic: LogViewer.jsx's Errors chip is a substring match on "error", so downgrading the
    // level would hide every guard report from the one view an operator opens when something is wrong.
    // Mutation found this — the old assertions grepped for the label and never the level.
    reportGuardFailure('level-check', new Error('level-marker'));
    const line = recent().find((l) => l.includes('level-marker'));
    assert.ok(line, 'nothing was logged at all');
    assert.match(line, /\[ERROR\]/, `guard reports must be ERROR level, got: ${line}`);
  });

  test('a repeating fault is logged once a minute, not every tick, and says how many it swallowed', () => {
    // A guard does not fix the fault it catches, so a 15s watchdog hitting a permanent error writes
    // ~960 lines/hour at two cameras into logger.js's 1000-line ring — evicting the very evidence
    // needed to diagnose it. Same precedent as mediamtxProcess.js. Measured by review of PR #275.
    for (let i = 0; i < 50; i++) reportGuardFailure('flood', new Error(`burst-${i}`));
    assert.equal(logged('[guard:flood]'), 1, 'the guard flooded the log ring');

    // The suppressed ones are not silently dropped — the next line that IS emitted says how many.
    resetGuardRateLimit();
    reportGuardFailure('flood', new Error('after-window'));
    assert.equal(logged('[guard:flood]'), 2);
  });

  test('rate limiting is per label, so one noisy camera cannot mask another fault', () => {
    reportGuardFailure('camera-a', new Error('a-marker'));
    reportGuardFailure('camera-a', new Error('a-again'));
    reportGuardFailure('camera-b', new Error('b-marker'));

    assert.equal(logged('[guard:camera-a]'), 1);
    assert.equal(logged('[guard:camera-b]'), 1, 'a different label was suppressed by an unrelated one');
  });
});

describe('installCrashGuards', () => {
  // ⚠️ THESE RUN IN A CHILD PROCESS, and that is not incidental. node:test installs its OWN
  // unhandledRejection/uncaughtException handling and attributes anything it catches to the running
  // test, failing it — so in-process these cases fail even when the guard demonstrably works. The only
  // way to observe what Node does to an UNGUARDED process is to be a separate process. Each case runs
  // the same script with and without the guard and asserts the DIFFERENCE.
  const guardsUrl = pathToFileURL(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'lib', 'processGuards.js')
  ).href;

  // Written with fs, never handed to a shell (the workspace rule) — this text is full of backticks and
  // $ and would be mangled by any shell that touched it.
  function runScript(body, { withGuards, booted = true }) {
    const file = path.join(scriptDir, `guard-probe-${Math.random().toString(36).slice(2)}.mjs`);
    fs.writeFileSync(
      file,
      [
        `import { installCrashGuards, markBootComplete } from ${JSON.stringify(guardsUrl)};`,
        withGuards ? 'installCrashGuards();' : '// guards deliberately NOT installed',
        // Steady state vs startup are deliberately different: see the boot note in processGuards.js.
        booted ? 'markBootComplete();' : '// still booting — a fault here is a FAILED START',
        body,
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

  const FLOATING_REJECTION = 'Promise.reject(new Error("floating-rejection-marker"));';
  const UNCAUGHT_THROW = 'setTimeout(() => { throw new Error("uncaught-marker"); }, 0);';

  test('a floating rejection kills an unguarded process, and is survived + logged by a guarded one', async () => {
    const unguarded = await runScript(FLOATING_REJECTION, { withGuards: false });
    assert.notEqual(unguarded.code, 0, 'an unguarded floating rejection did NOT kill the process — the premise of #254 is wrong');
    assert.ok(!unguarded.out.includes('SURVIVED'), 'the unguarded process kept running');

    const guarded = await runScript(FLOATING_REJECTION, { withGuards: true });
    assert.equal(guarded.code, 0, `the guarded process still died: ${guarded.out}`);
    assert.ok(guarded.out.includes('SURVIVED'), 'the guarded process did not reach the end');
    assert.ok(guarded.out.includes('[guard:unhandledRejection]'), 'the failure was swallowed silently');
    assert.ok(guarded.out.includes('floating-rejection-marker'), 'the log line does not carry the reason');
  });

  test('an uncaught synchronous throw likewise — and the process KEEPS RUNNING, not just exits 0', async () => {
    // ⚠️ The SURVIVED assertion is the point. Without it, a guard that logs and then calls
    // process.exit(0) passes — exit code 0 and both log lines are still there. That mutant survived the
    // first version of this file, and it is precisely the 3am outage this whole PR argues against.
    const unguarded = await runScript(UNCAUGHT_THROW, { withGuards: false });
    assert.notEqual(unguarded.code, 0, 'an unguarded uncaught throw did NOT kill the process');
    assert.ok(!unguarded.out.includes('SURVIVED'));

    const guarded = await runScript(UNCAUGHT_THROW, { withGuards: true });
    assert.equal(guarded.code, 0, `the guarded process still died: ${guarded.out}`);
    assert.ok(guarded.out.includes('SURVIVED'), 'the guard logged and then killed the process anyway');
    assert.ok(guarded.out.includes('[guard:uncaughtException]'));
    assert.ok(guarded.out.includes('uncaught-marker'));
  });

  test('BEFORE boot completes, the same fault exits NON-ZERO instead of being survived', async () => {
    // Boot and steady state need different answers. Swallowing during startup left the process either
    // exiting 0 — which looks like a clean shutdown, so an `on-failure` restart policy does NOT restart
    // it — or alive with the watchdog timers registered and no HTTP server bound: a green container
    // with a total outage. Found by adversarial review of PR #275.
    const booting = await runScript(UNCAUGHT_THROW, { withGuards: true, booted: false });
    assert.equal(booting.code, 1, `a startup fault must exit 1 so the container restarts, got ${booting.code}: ${booting.out}`);
    assert.ok(!booting.out.includes('SURVIVED'), 'it carried on with a half-built app');
    assert.ok(booting.out.includes('before the server was listening'), 'it exited without explaining why');

    const rejecting = await runScript(FLOATING_REJECTION, { withGuards: true, booted: false });
    assert.equal(rejecting.code, 1, 'a startup rejection must also exit 1');
  });

  test('installing twice does not double up the handlers', async () => {
    // Every sibling starter in this repo self-guards. Without it, 3 calls meant 3 duplicate log lines
    // per fault and 12 produced a MaxListenersExceededWarning.
    const body = [
      'const again = installCrashGuards();',
      'if (again !== false) { console.log("NOT-IDEMPOTENT"); }',
      'for (let i = 0; i < 12; i++) installCrashGuards();',
      FLOATING_REJECTION,
    ].join('\n');
    const res = await runScript(body, { withGuards: true });

    assert.equal(res.code, 0, res.out);
    assert.ok(!res.out.includes('NOT-IDEMPOTENT'), 'a second installCrashGuards() did not report as already installed');
    assert.ok(!res.out.includes('MaxListenersExceededWarning'), 'repeated installs leaked listeners');
    const hits = res.out.split('[guard:unhandledRejection]').length - 1;
    assert.equal(hits, 1, `one fault produced ${hits} log lines — duplicate handlers`);
  });
});

describe('index.js wiring', () => {
  // ⚠️ WHAT THIS IS AND IS NOT. index.js boots the whole app — it spawns child processes and binds a
  // port — so no unit test can execute its watchdogs, and the guards there would otherwise ship with no
  // test at all. This reads the source TEXT. It proves the dangerous constructs are absent and the
  // wiring is present; it does NOT prove the watchdogs behave.
  //
  // ⚠️ The first version of this was WEAKER THAN IT LOOKED. It only matched `setInterval(async`, so
  // review defeated it in one line: hoist the callback to `const tick = async () => {...}` and pass it
  // by reference. That floats the promise identically and restores the entire defect with every
  // tripwire green — and it is this file's own house idiom. The rule is therefore absolute now:
  // index.js does not call setInterval AT ALL.
  const backendDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const indexPath = path.join(backendDir, 'src', 'index.js');
  const indexSrc = fs.readFileSync(indexPath, 'utf8');

  test('index.js never calls setInterval directly — every timer goes through safeInterval', () => {
    const offenders = [...indexSrc.matchAll(/\bsetInterval\s*\(/g)];
    assert.equal(
      offenders.length,
      0,
      `${offenders.length} direct setInterval call(s). An async callback — including a named one passed by reference — floats its promise, and a rejection there exits the process. Use safeInterval.`
    );
  });

  test('no module in src/ hands an inline async callback to a timer', () => {
    // Broader than index.js, because reverting timelapse.js alone went unnoticed: the old tripwire read
    // one file. This cannot catch every by-reference case across the codebase (see the note above), so
    // it is a floor, not a ceiling.
    const offenders = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith('.js')) {
          // Comments are stripped first: processGuards.js's own header QUOTES the dangerous construct
          // while explaining it, and a checker that cannot tell code from prose cries wolf.
          const src = fs
            .readFileSync(full, 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .split('\n')
            // No `$` anchor: these files are CRLF, `.` stops before the \r, and `$` without /m wants
            // end-of-input — so the anchored version silently stripped nothing.
            .map((l) => l.replace(/\/\/.*/, ''))
            .join('\n');
          if (/\b(setInterval|setTimeout)\s*\(\s*async\b/.test(src)) offenders.push(path.relative(backendDir, full));
        }
      }
    };
    walk(path.join(backendDir, 'src'));
    assert.deepEqual(offenders, [], `inline async timer callback(s) in: ${offenders.join(', ')}`);
  });

  test('the timelapse sampler is guarded too', () => {
    // Its own case, because reverting it was invisible to every other assertion here.
    const src = fs.readFileSync(path.join(backendDir, 'src', 'lib', 'timelapse.js'), 'utf8');
    assert.match(src, /safeInterval\(\s*'timelapse-sampler'/, 'timelapse.js no longer routes its sampler through safeInterval');
  });

  test('the crash backstop is installed at startup and released once listening', () => {
    assert.match(indexSrc, /^installCrashGuards\(\);$/m, 'installCrashGuards() is not called at top level');
    assert.match(indexSrc, /markBootComplete\(\);/, 'markBootComplete() is never called — every startup fault stays fatal');
    // Order matters: releasing the boot gate before the server binds would reinstate the exact hole.
    assert.ok(
      indexSrc.indexOf('app.listen') < indexSrc.indexOf('markBootComplete();'),
      'markBootComplete() must come after app.listen, or a failed start looks healthy'
    );
  });

  test('both watchdog loops isolate a camera, and the sub leg is isolated from the main leg', () => {
    // Per-camera was not enough: the sub leg runs FIRST and holds the only bare upsertPath, so a sub
    // path MediaMTX keeps rejecting stopped the main leg's code from ever running for that camera.
    for (const label of ['camera-watchdog:${cam.name}', 'audio-watchdog:${cam.name}', 'camera-watchdog:sub:${cam.name}']) {
      assert.ok(indexSrc.includes(`reportGuardFailure(\`${label}\`, err)`), `missing guard: ${label}`);
    }
  });

  test('every guard catch does nothing but report — no break, no rethrow', () => {
    // `break` or `throw err` inside those catch blocks reinstates the defect while still satisfying a
    // naive "does it mention reportGuardFailure" check. Both survived as mutants until this case.
    const catches = [...indexSrc.matchAll(/\}\s*catch\s*\(err\)\s*\{([\s\S]*?)\n\s*\}/g)].map((m) => m[1]);
    assert.ok(catches.length >= 3, `expected at least 3 guard catch blocks, found ${catches.length}`);
    for (const body of catches) {
      if (!body.includes('reportGuardFailure')) continue; // not one of ours
      assert.ok(!/\bbreak\b/.test(body), `a guard catch block breaks out of its loop: ${body.trim()}`);
      assert.ok(!/\bthrow\b/.test(body), `a guard catch block rethrows: ${body.trim()}`);
    }
  });

  test('index.js actually parses', async () => {
    // Nothing else in the suite ever loads index.js, so a syntax error in it was invisible — a mutant
    // that broke the file outright still produced a green run. `node --check` is the cheapest honest
    // answer; importing it would boot the app.
    const res = await new Promise((resolve) => {
      const proc = spawn(process.execPath, ['--check', indexPath], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      proc.stdout.on('data', (c) => (out += c));
      proc.stderr.on('data', (c) => (out += c));
      proc.on('close', (code) => resolve({ code, out }));
    });
    assert.equal(res.code, 0, `src/index.js does not parse:\n${res.out}`);
  });
});

process.on('exit', cleanupTempDataDirs);
