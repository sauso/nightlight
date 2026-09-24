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
import { stripCommentsOnly } from './helpers/sourceScan.js';

const scriptDir = useTempDataDir();

const { logger } = await import('../src/lib/logger.js');
const { safeInterval, reportGuardFailure, resetGuardRateLimit, killIfSpawned, perTargetRunner } = await import('../src/lib/processGuards.js');

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

describe('perTargetRunner (#451): at most one pending check per camera, bounded fan-out', () => {
  // The defect: safeInterval starts a new async tick while the previous one is still pending, and the
  // two camera watchdogs had no in-flight guard. Against a MediaMTX that accepted and never answered,
  // ticks stacked up every 15s, and when the stall cleared they all resumed at once and each restarted
  // the same camera (startTranscoder is not safe under two concurrent calls for one camera).
  //
  // ⚠️ Every promise here is CONTROLLED BY THE TEST and the clock is INJECTED. `flush` below drains the
  // microtask queue and a few event-loop turns; it is not a duration, and no assertion depends on how
  // fast this machine is. Every fake either resolves at once or waits on a deferred the test settles.
  const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };
  const flush = async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  };
  const cam = (id) => ({ id, name: `Cam-${id}` });
  const byId = (t) => t.id;
  const byName = (t) => t.name;
  const never = () => new Promise(() => {});

  test('P1 (AC2): a target whose check never settles is checked ONCE across many runs; a healthy one every run', async () => {
    const run = perTargetRunner('p1');
    const stuck = cam('stuck');
    const healthy = cam('healthy');
    const calls = { stuck: 0, healthy: 0 };
    let pendingStuck = 0;
    let peakStuck = 0;
    const fn = (t) => {
      calls[t.id] += 1;
      if (t.id !== 'stuck') return Promise.resolve();
      pendingStuck += 1;
      peakStuck = Math.max(peakStuck, pendingStuck);
      return never();
    };
    for (let i = 0; i < 5; i++) {
      run([stuck, healthy], byId, byName, fn);
      await flush();
    }
    assert.equal(calls.stuck, 1, 'a stuck check was started again: that is the backlog');
    assert.equal(peakStuck, 1, 'more than one check for the same camera was pending at once');
    assert.equal(calls.healthy, 5, 'the healthy camera was not checked every run');
  });

  test('P2 (AC3): once the stuck check settles, the next run checks that target again', async () => {
    const run = perTargetRunner('p2');
    const t = cam('flaky');
    const gate = deferred();
    let calls = 0;
    const fn = () => {
      calls += 1;
      return calls === 1 ? gate.promise : Promise.resolve();
    };
    run([t], byId, byName, fn);
    await flush();
    run([t], byId, byName, fn);
    await flush();
    assert.equal(calls, 1, 'precondition: the second run skipped the pending target');

    gate.resolve();
    await flush();
    await run([t], byId, byName, fn);
    assert.equal(calls, 2, 'a settled check left its in-flight mark behind: that camera is never checked again');
  });

  test('P3: a target whose check REJECTS is reported as label:name, its siblings still run, and run() resolves', async () => {
    const run = perTargetRunner('p3');
    const ran = [];
    const fn = async (t) => {
      ran.push(t.id);
      if (t.id === 'bad') throw new Error('p3-reject-marker');
    };
    await run([cam('a'), cam('bad'), cam('c')], byId, byName, fn);
    assert.deepEqual(ran.sort(), ['a', 'bad', 'c']);
    assert.equal(logged('[guard:p3:Cam-bad]'), 1, 'the failure was not reported under the per-camera label');
    assert.equal(logged('p3-reject-marker'), 1, 'the report does not carry the real reason');
  });

  test('P4: a SYNCHRONOUS throw inside fn is caught the same way', async () => {
    const run = perTargetRunner('p4');
    const ran = [];
    const fn = (t) => {
      ran.push(t.id);
      if (t.id === 'bad') throw new Error('p4-sync-marker');
      return Promise.resolve();
    };
    await run([cam('bad'), cam('b')], byId, byName, fn);
    assert.deepEqual(ran.sort(), ['b', 'bad']);
    assert.equal(logged('[guard:p4:Cam-bad]'), 1);
  });

  test('P5 (AC3): a stuck target listed FIRST does not delay a healthy one listed after it', async () => {
    const run = perTargetRunner('p5');
    const calls = [];
    run([cam('stuck'), cam('healthy')], byId, byName, (t) => {
      calls.push(t.id);
      return t.id === 'stuck' ? never() : Promise.resolve();
    });
    await flush();
    assert.deepEqual(calls, ['stuck', 'healthy'], 'the healthy camera waited behind the stuck one: the loop is sequential');
  });

  test('P6: with 10 targets, at most 4 checks run at once, and all 10 still run', async () => {
    const run = perTargetRunner('p6');
    const gates = new Map();
    let active = 0;
    let peak = 0;
    const started = [];
    const fn = (t) => {
      started.push(t.id);
      active += 1;
      peak = Math.max(peak, active);
      const g = deferred();
      gates.set(t.id, g);
      return g.promise.finally(() => { active -= 1; });
    };
    const targets = Array.from({ length: 10 }, (_, i) => cam(`t${i}`));
    const done = run(targets, byId, byName, fn);
    await flush();
    assert.equal(peak, 4, `expected exactly 4 at once (a MediaMTX-wide outage must not start 10 restarts at once), saw ${peak}`);
    for (let i = 0; i < 10; i++) {
      gates.get(started[i])?.resolve();
      await flush();
    }
    await done;
    assert.equal(started.length, 10, 'not every target was checked');
    assert.equal(peak, 4, 'the cap was exceeded as slots freed up');
  });

  test('P7: a target still WAITING in run 1\'s queue is skipped by run 2: it is marked when queued, not when started', async () => {
    const run = perTargetRunner('p7', { concurrency: 1 });
    const gate = deferred();
    const calls = [];
    const fn = (t) => {
      calls.push(t.id);
      return t.id === 'stuck' ? gate.promise : Promise.resolve();
    };
    run([cam('stuck'), cam('queued')], byId, byName, fn);
    await flush();
    assert.deepEqual(calls, ['stuck'], 'precondition: `queued` is waiting behind the stuck worker');

    await run([cam('queued')], byId, byName, fn);
    assert.deepEqual(calls, ['stuck'], 'run 2 started a target run 1 had already queued: two checks for one camera');

    gate.resolve();
    await flush();
    assert.deepEqual(calls, ['stuck', 'queued'], 'run 1 never got to the queued target, or ran it twice');
  });

  test('P8: a check pending past staleAfterMs is REPORTED on skip, rate-limited, and still never started again', async () => {
    // v1 of the plan restarted a check after 2 minutes. Codex showed that is still an unbounded backlog if
    // the old one never ends, so the runner only reports. Clock injected: no wall-clock wait decides this.
    let clock = 1_000_000;
    const run = perTargetRunner('p8', { staleAfterMs: 120_000, now: () => clock });
    let calls = 0;
    const fn = () => {
      calls += 1;
      return never();
    };
    const t = cam('wedged');
    run([t], byId, byName, fn);
    await flush();

    clock += 119_999;
    await run([t], byId, byName, fn);
    assert.equal(logged('still running'), 0, 'a skip was reported as stale before staleAfterMs');

    clock += 1;
    await run([t], byId, byName, fn);
    assert.equal(logged('[guard:p8:stale:Cam-wedged]'), 1, 'a check pending past staleAfterMs was skipped silently');
    assert.equal(logged('previous check still running after 120s; skipped, not stacked'), 1);

    clock += 60_000;
    await run([t], byId, byName, fn);
    assert.equal(logged('still running'), 1, 'the stale report is not rate-limited');
    assert.equal(calls, 1, 'the stale check was started again: an escape hatch is a backlog');
  });

  test('P9: every skip calls onSkip(target), and the pending check sees ctx.skipped flip to true', async () => {
    // Round 2, P0: a skip is a MISSED OBSERVATION. A check that some later tick skipped over while it was
    // pending holds readings that no longer form an unbroken run, and must be able to tell.
    const run = perTargetRunner('p9');
    const ctxs = {};
    const fn = (t, ctx) => {
      ctxs[t.id] = ctx;
      return never();
    };
    const skipped = [];
    const onSkip = (t) => skipped.push(t.id);
    run([cam('s'), cam('quiet')], byId, byName, fn, { onSkip });
    await flush();
    assert.equal(ctxs.s.skipped, false, 'a check nobody has skipped yet already reads as skipped');

    await run([cam('s')], byId, byName, fn, { onSkip });
    await run([cam('s')], byId, byName, fn, { onSkip });
    assert.deepEqual(skipped, ['s', 's'], 'onSkip must fire once per skipped run');
    assert.equal(ctxs.s.skipped, true, 'the pending check cannot see that it was skipped');
    assert.equal(ctxs.quiet.skipped, false, 'a check nobody skipped reads as skipped');

    // run() never rejects, even if the caller's onSkip throws.
    await run([cam('s')], byId, byName, fn, { onSkip: () => { throw new Error('p9-onskip-marker'); } });
    assert.equal(logged('p9-onskip-marker'), 1, 'a throwing onSkip was swallowed silently');
  });

  test('P10 (the documented AC3 limit): with every worker stuck, a later target waits for the first free worker', async () => {
    // Pins a LIMIT, not a fix (Codex code review of #451, SHOULD): with more cameras than workers and the
    // first `concurrency` of them stuck, the rest wait. Every real check is bounded, so the wait is bounded
    // by one check's worst case per batch. If this ever changes, the comment on perTargetRunner and
    // KNOWN-ISSUES.md must change with it.
    const run = perTargetRunner('p10');
    const gates = new Map();
    const started = [];
    const fn = (t) => {
      started.push(t.id);
      const g = deferred();
      gates.set(t.id, g);
      return g.promise;
    };
    run(['a', 'b', 'c', 'd', 'e'].map(cam), byId, byName, fn);
    await flush();
    assert.deepEqual(started, ['a', 'b', 'c', 'd'], 'expected exactly the first 4 to start, and the 5th to wait');

    gates.get('b').resolve();
    await flush();
    assert.deepEqual(started, ['a', 'b', 'c', 'd', 'e'], 'the 5th target did not start when a worker came free');
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

  // ⚠️ #451 MOVED THE WATCHDOG LOOPS to lib/cameraWatchdogs.js, and their per-camera guard into
  // processGuards.perTargetRunner, so the label and catch-body checks below read those files now. The
  // labels are pinned BEHAVIOURALLY too (camera-watchdogs.test.js W8); these are the cheap, fail-fast half.
  const watchdogsSrc = fs.readFileSync(path.join(backendDir, 'src', 'lib', 'cameraWatchdogs.js'), 'utf8');
  const guardsSrc = fs.readFileSync(path.join(backendDir, 'src', 'lib', 'processGuards.js'), 'utf8');

  test('both watchdog loops isolate a camera, and the sub leg is isolated from the main leg', () => {
    // Per-camera was not enough: the sub leg ran FIRST and holds the only bare upsertPath, so a sub path
    // MediaMTX keeps rejecting stopped the main leg's code from ever running for that camera. Since the
    // #451 fix round the sub leg is a check of its own, with its own runner (and so its own catch).
    // Per camera and per leg: each runner reports as `<label>:<camera name>`.
    for (const label of ['camera-watchdog', 'camera-watchdog:sub', 'audio-watchdog']) {
      assert.match(watchdogsSrc, new RegExp(`perTargetRunner\\('${label}'`), `the ${label} checks no longer run through their own perTargetRunner`);
    }
    assert.match(watchdogsSrc, /const byName = \(cam\) => cam\.name;/, 'the per-camera label is no longer the camera name');
    assert.ok(guardsSrc.includes('reportGuardFailure(`${label}:${nameOf(target)}`, err)'), 'perTargetRunner no longer reports per target');
  });

  test('every guard catch does nothing but report — no break, no rethrow', () => {
    // `break` or `throw err` inside those catch blocks reinstates the defect while still satisfying a
    // naive "does it mention reportGuardFailure" check. Both survived as mutants until this case.
    // Comments stripped: safeInterval's catch EXPLAINS "a synchronous throw" in prose, and a checker that
    // cannot tell code from prose cries wolf.
    const catchesIn = (src) =>
      [...stripCommentsOnly(src).matchAll(/\}\s*catch\s*\(err\)\s*\{([\s\S]*?)\n\s*\}/g)]
        .map((m) => m[1])
        .filter((b) => b.includes('reportGuardFailure'));
    // cameraWatchdogs.js has no guard catch of its own since the fix round (every check goes through a
    // runner), but any that is added later is held to the same rule.
    const watchdogCatches = catchesIn(watchdogsSrc);
    const runnerCatches = catchesIn(guardsSrc);
    // safeInterval's own catch, and perTargetRunner's per-target one.
    assert.ok(runnerCatches.length >= 2, `expected at least 2 guard catch blocks in processGuards.js, found ${runnerCatches.length}`);
    for (const body of [...watchdogCatches, ...runnerCatches, ...catchesIn(indexSrc)]) {
      assert.ok(!/\bbreak\b/.test(body), `a guard catch block breaks out of its loop: ${body.trim()}`);
      assert.ok(!/\bthrow\b/.test(body), `a guard catch block rethrows: ${body.trim()}`);
    }
  });

  test('index.js hands each watchdog\'s TICK to safeInterval, under its own label and interval (#451)', () => {
    // The watchdogs are no longer written out in index.js, so the only thing left to break here is the
    // wiring, and one way to break it is silent: passing the watchdog OBJECT instead of its `.tick` makes
    // safeInterval throw on every call, reported and swallowed, with no watchdog running at all.
    // Comments stripped first (strings kept, the labels are strings), so a line quoted in a comment
    // cannot satisfy this.
    const code = stripCommentsOnly(indexSrc);
    assert.match(
      code,
      /safeInterval\(\s*'camera-watchdog'\s*,\s*WATCHDOG_INTERVAL_MS\s*,\s*createCameraWatchdog\([^)]*\)\.tick\s*\)/,
      'the camera watchdog is not wired: safeInterval(\'camera-watchdog\', WATCHDOG_INTERVAL_MS, createCameraWatchdog().tick)'
    );
    assert.match(
      code,
      /safeInterval\(\s*'audio-watchdog'\s*,\s*AUDIO_CHECK_INTERVAL_MS\s*,\s*createAudioWatchdog\([^)]*\)\.tick\s*\)/,
      'the audio watchdog is not wired: safeInterval(\'audio-watchdog\', AUDIO_CHECK_INTERVAL_MS, createAudioWatchdog().tick)'
    );
    assert.match(
      code,
      /import\s*\{[^}]*\bcreateCameraWatchdog\b[^}]*\bcreateAudioWatchdog\b[^}]*\}\s*from\s*'\.\/lib\/cameraWatchdogs\.js'/,
      'the factories are called in index.js but not imported from lib/cameraWatchdogs.js'
    );
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

// -------------------------------------------------------------------------------------------
describe('★★★ killIfSpawned — killing a child that never spawned', () => {
  // THE DEFECT. `spawn()` returns synchronously and its 'error' arrives on a later tick, so for ~5ms a
  // launch that cannot work is a ChildProcess with `pid === undefined` over a libuv handle whose
  // internal pid is 0. Every stop path in this codebase can land there. Killing it:
  //   * win32 — throws `kill EINVAL`. Uncaught, that is #257's crash class one layer down.
  //   * POSIX — does NOT throw. It becomes `kill(0, SIGTERM)`: **signal my entire process group.**
  //     The backend SIGTERMs itself, MediaMTX and every FFmpeg.
  // Five call sites had the try/catch that handles the first and cannot touch the second, with comments
  // asserting the throw was the whole hazard. Found on 2026-09-06 when the CI runner kept dying with
  // "the runner has received a shutdown signal" on a branch that was green on Windows.
  const guardsHref = pathToFileURL(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'lib', 'processGuards.js')
  ).href;

  // A child that spawns an unresolvable binary and then kills it the way `killLine` says. Prints
  // SURVIVED and exits 0 only if it is still alive afterwards. Written with fs, never through a shell.
  function killProbe(killLine) {
    const file = path.join(scriptDir, `killprobe-${Math.random().toString(36).slice(2)}.mjs`);
    fs.writeFileSync(
      file,
      [
        `import { killIfSpawned } from ${JSON.stringify(guardsHref)};`,
        "import { spawn } from 'node:child_process';",
        // A name that cannot resolve on any platform, so the failure needs no PATH manipulation.
        "const p = spawn('nightlight-no-such-binary-9f3a', []);",
        "p.on('error', () => {}); // swallowed, exactly as the app's spawn handlers do",
        killLine,
        'setTimeout(() => { console.log("SURVIVED"); process.exit(0); }, 200);',
      ].join('\n')
    );
    return new Promise((resolve) => {
      const proc = spawn(process.execPath, [file], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      proc.stdout.on('data', (c) => (out += c));
      proc.stderr.on('data', (c) => (out += c));
      proc.on('close', (code, signal) => resolve({ code, signal, out }));
    });
  }

  test('★ a stop that lands in the pre-error window leaves the process alive', async () => {
    // ⚠️ RUN IN A CHILD, because the failure mode is "this process is gone" — there is no other way to
    // observe it, and observing it in-process would take the test runner down with it, which is
    // precisely what it did in CI.
    const guarded = await killProbe("killIfSpawned(p, 'SIGTERM');");
    assert.match(guarded.out, /SURVIVED/, `the guarded child did not survive: ${guarded.out}`);
    assert.equal(guarded.code, 0);
  });

  test('★★ kill() is NEVER CALLED on a child that has no pid — the assertion the guard rests on', () => {
    // ⚠️ THIS, NOT THE CHILD-PROCESS CASE ABOVE, IS WHAT KILLS THE MUTANT. The obvious control —
    // "and the UNGUARDED version dies" — was written first and is WRONG, because it is racy: libuv
    // forks before it resolves the binary, so the handle holds a real pid until that doomed child is
    // reaped, and only after that does the kill degrade to `kill(0, …)`. Under `node --test` on a
    // loaded machine the reaping wins and the process group dies; in a quiet standalone probe it does
    // not, and the "control" passes. Measured both ways on Linux before this was rewritten.
    // A spy has no race: it asserts the guard's actual contract, on every platform, every run.
    const calls = [];
    const spy = (pid) => ({ pid, kill: (sig) => { calls.push([pid, sig]); return true; } });

    assert.equal(killIfSpawned(spy(undefined)), false);
    assert.equal(killIfSpawned(spy(0)), false, 'pid 0 is the process GROUP, never a child');
    assert.equal(killIfSpawned(spy(null)), false);
    assert.deepEqual(calls, [], 'kill() was called on a child that never spawned — that is the defect');

    // ...and the same guard must not swallow a real one.
    assert.equal(killIfSpawned(spy(4242), 'SIGTERM'), true);
    assert.deepEqual(calls, [[4242, 'SIGTERM']]);
  });

  test('it reports false, and does not throw, for a missing process object', () => {
    assert.equal(killIfSpawned(null), false);
    assert.equal(killIfSpawned(undefined), false);
    assert.equal(killIfSpawned({}), false, 'an object with no pid was treated as a process');
  });

  test('★ it really does signal a live child — the control for the guard itself', async () => {
    // Without this, a `killIfSpawned` that always returned false would pass every assertion above, and
    // shutdown would silently stop killing anything.
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    await new Promise((r) => child.once('spawn', r));
    assert.ok(child.pid, 'precondition: the child really started');
    const ended = new Promise((r) => child.once('exit', (code, signal) => r({ code, signal })));
    assert.equal(killIfSpawned(child, 'SIGTERM'), true, 'a live child was not signalled');
    const res = await ended;
    assert.ok(res.signal === 'SIGTERM' || res.code !== 0, `the child was not actually terminated: ${JSON.stringify(res)}`);
  });

  test('a signal argument other than the default is passed through', () => {
    let got = null;
    assert.equal(killIfSpawned({ pid: 1234, kill: (s) => { got = s; return true; } }, 'SIGKILL'), true);
    assert.equal(got, 'SIGKILL', 'the caller-chosen signal was replaced');
  });

  test('a throw from kill() is swallowed rather than escaping into a stop path', () => {
    // The win32 EINVAL, and the race where a child is reaped between the pid check and the call. Every
    // caller is a shutdown or a restart; a throw there is the outage this whole file exists to prevent.
    assert.equal(killIfSpawned({ pid: 999999, kill: () => { throw new Error('ESRCH'); } }), false);
  });
});

process.on('exit', cleanupTempDataDirs);
