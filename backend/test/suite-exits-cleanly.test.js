// The suite must be able to EXIT ON ITS OWN. Issue #278.
//
// The defect, and why it looked like something else entirely: `startActivityTracker()` created two
// `setInterval`s and there was no `stopActivityTracker()` to clear them. One test starts the tracker
// for real, so `node --test` could never exit — and instead of fixing the lifecycle, all three npm
// scripts were given `--test-force-exit`.
//
// That flag was the actual bug. `node --test` runs each FILE in its own child process, concurrently
// up to the CPU count. On a 2-core GitHub runner the parent's own event loop drained while children
// were still being spawned, force-exit fired, and 14 of 34 files were cancelled mid-flight. The run
// reported:
//
//     tests 312   pass 298   fail 0   cancelled 14   duration_ms 5957
//
// ★ `fail 0`. Not one assertion failed — a third of the suite simply never ran, each cancelled file
// carrying Node's `'Promise resolution is still pending but the event loop has already resolved'`.
// The coverage gate then read the modules that never ran as a coverage REGRESSION (87.50% against a
// 95% threshold) and went red too, which is what made this look like a code defect rather than a
// harness one. Green-vs-red is not the signal here; `cancelled` is.
//
// ⚠️ THIS IS NOT THE SAME FAULT AS PR #281, and conflating them is how this stayed open. That PR
// fixes real timing flakes in process-guards.test.js (`await sleep(120)` then asserting a tick count)
// which reproduce locally at `--test-concurrency=34`, 5 runs in 6. Those are genuine FAILURES in one
// file. This is CANCELLATION of many files with nothing failing. Both are real; only this one makes
// the suite lie about what it ran.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, readdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  walkSources, scanPeriodic, unstoppableTimerOffences,
} from './helpers/sourceScan.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.resolve(HERE, '..');

// ⚠️ THREE DIFFERENT CLOCKS, and mixing them was the flake in issue #666. Every probe child has to boot
// node, open the database and import a module BEFORE it can say anything about timers. That startup
// cost is a property of the machine's load; the exit (or the hang) that follows the body is a property
// of the code under test. The first version gave both one wall-clock deadline measured from spawn, so a
// loaded runner failed a probe for being slow to START — "the probe never reached the end" on a case
// whose only real assertion is "this timer pins the process". Measured: 32 copies of this file pinned
// to one core failed 30 of 32 runs that way; four copies at once (the load the issue describes) did not
// reproduce it in 40 runs, so the exact failure seen on 2026-10-11 is inferred, not observed.
//
//   STARTUP_BUDGET_MS  how long a child may take to reach the end of its body. Pure load tolerance; it
//                      costs nothing on a green run, because the clock stops the moment BODY-DONE is
//                      printed. Generous on purpose: a child that never gets there is a crash or a
//                      wedged import, and that is reported as such, not as a timing verdict.
//   EXIT_DEADLINE_MS   after BODY-DONE, how long a child that SHOULD exit has to do it. A clean
//                      start+stop returns in ~270ms; 20s is the old, proven-generous number.
//   HANG_GRACE_MS      after BODY-DONE, how long a child that SHOULD be pinned is watched before it is
//                      declared hung and killed. This one is paid in full on every green build (four
//                      controls), so it is short: a leaked timer holds the process for the 60s flush
//                      interval, a clean one is gone in tens of ms. Load can only make a pinned child
//                      look MORE pinned, never less, so a short grace here cannot produce a false
//                      failure — which is why it is the only deadline that may be tight.
const STARTUP_BUDGET_MS = 120_000;
const EXIT_DEADLINE_MS = 20_000;
const HANG_GRACE_MS = 3_000;

// The nested `node --test` run below boots a whole test runner plus a test file, so it gets a much
// longer ceiling than a probe. It is only ever reached by a real hang (a clean run returns in ~1.5s),
// so the ceiling costs nothing on a green build (and a leak planted on purpose is reported after
// this long, not 5 minutes). It was EXIT_DEADLINE_MS * 3 = 60s measured from spawn
// and timed out (ETIMEDOUT) on 23 of 32 heavily loaded runs (#666).
const NESTED_RUN_CEILING_MS = 150_000;

// ⚠️ `node --test` sets NODE_TEST_CONTEXT on every child it spawns, and a child that sees it switches
// from the human reporter to TAP — so `ℹ pass 18` arrives as `# pass 18` instead. Inherited blindly,
// that made the whole-suite case below match nothing and pass vacuously in 110ms; its anti-vacuous
// assertion is what caught it. Strip the variable so a nested run behaves like a run from a shell.
function cleanEnv() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

// Runs `body` in a FRESH node process and reports whether that process exited by itself.
// A child is the only honest way to ask this question: a leaked handle is a property of a whole
// process, and the process running these assertions is the same one the leak would be in.
//
// Async, with the deadline anchored on the BODY-DONE marker rather than on spawn (#666, see the
// constants above). `graceMs` is how long after the marker the child may keep running before it is
// killed and reported as not having exited on its own.
//
// ⚠️ The result's `exited` is "we never had to kill it", not "status === 0": a child that crashes
// before the marker has exited (ranBody false, status non-zero) and the callers' `ranBody`/`status`
// assertions are what turn that into a failure with a reason attached.
function childExitsOnItsOwn(body, graceMs = EXIT_DEADLINE_MS, modulePath = 'src/lib/activityTracker.js') {
  const dir = mkdtempSync(path.join(tmpdir(), 'nightlight-exit-'));
  const script = path.join(dir, 'probe.mjs');
  writeFileSync(
    script,
    `process.env.DATA_DIR = ${JSON.stringify(dir)};\n` +
      `process.env.JWT_SECRET = 'test-secret-not-used-anywhere-real';\n` +
      // pathToFileURL, not a raw path: on Windows `C:/x/y.js` is not a valid ESM specifier, and the
      // resulting ERR_INVALID_FILE_URL_PATH makes the child exit ~1 instantly — which reads as "it
      // exited on its own" and would have made the leak test pass for entirely the wrong reason.
      // The `status === 0` assertion below is what caught that.
      `const at = await import(${JSON.stringify(pathToFileURL(path.join(BACKEND, modulePath)).href)});\n` +
      body +
      // Printed AFTER the body, and flushed before any hang. It is what separates "the child hung
      // holding a leaked timer" from "the child hung, or crashed, somewhere earlier for an unrelated
      // reason" — without it the control case below passes for any failure that happens to stall.
      // It is also the moment the parent starts timing the child (see the constants above).
      `\nconsole.log('BODY-DONE');\n`,
    'utf8'
  );
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], { env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let killedByUs = false;
    let graceTimer = null;
    const kill = () => { killedByUs = true; child.kill('SIGKILL'); };
    const startupTimer = setTimeout(kill, STARTUP_BUDGET_MS);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { stderr += d; });
    child.stdout.on('data', (d) => {
      stdout += d;
      if (graceTimer === null && stdout.includes('BODY-DONE')) {
        clearTimeout(startupTimer);
        graceTimer = setTimeout(kill, graceMs);
      }
    });
    const finish = (status, signal) => {
      clearTimeout(startupTimer);
      clearTimeout(graceTimer);
      rmSync(dir, { recursive: true, force: true });
      resolve({
        exited: !killedByUs && signal === null && status !== null,
        ranBody: stdout.includes('BODY-DONE'),
        status,
        signal,
        stderr,
      });
    };
    // 'close', not 'exit': stdout must be fully drained before BODY-DONE is judged absent.
    child.on('close', finish);
    child.on('error', (e) => { stderr += String(e); finish(null, 'spawn-error'); });
  });
}

describe('starting the activity tracker does not pin the process open', () => {
  test('a process that starts and then STOPS the tracker exits on its own', async () => {
    const r = await childExitsOnItsOwn('at.startActivityTracker();\nat.stopActivityTracker();\n');
    assert.ok(
      r.exited,
      `the child had to be killed ${EXIT_DEADLINE_MS}ms after finishing its body (signal=${r.signal}) — stopActivityTracker ` +
        `left a timer behind, which is what forced --test-force-exit on the whole suite. stderr: ${r.stderr}`
    );
    assert.equal(r.status, 0, `the child exited ${r.status} rather than cleanly: ${r.stderr}`);
  });

  // ★ THE CONTROL, and the reason the case above proves anything. Without it, a `stopActivityTracker`
  // that did nothing at all would still pass if some unrelated change let the process exit anyway.
  // This asserts the leak is REAL and that the test can see it: start without stopping, and the child
  // must have to be killed.
  test('a process that starts and does NOT stop it has to be killed — the leak is real', async () => {
    const r = await childExitsOnItsOwn('at.startActivityTracker();\n', HANG_GRACE_MS);
    assert.ok(
      r.ranBody,
      `the child never reached the end of the probe, so it proves nothing about timers: ${r.stderr}`
    );
    assert.equal(
      r.exited,
      false,
      'a tracker that was started and never stopped let the process exit anyway — this test can no ' +
        'longer tell a cleared timer from an uncleared one, so the case above proves nothing'
    );
  });

  test('stop is idempotent and a restart still works', async () => {
    // Kills the "cleared but not nulled" mutant: `startActivityTracker` guards on `if (flushTimer)
    // return`, so a stop that clears the handles without nulling them makes every later start a
    // silent no-op — and nothing else in the suite would notice.
    const r = await childExitsOnItsOwn(
      'at.stopActivityTracker();\n' + // never started
        'at.startActivityTracker();\n' +
        'at.stopActivityTracker();\n' +
        'at.stopActivityTracker();\n' + // twice
        'let started = 0;\n' +
        'const realSetInterval = globalThis.setInterval;\n' +
        'globalThis.setInterval = (...a) => { started += 1; return realSetInterval(...a); };\n' +
        'at.startActivityTracker();\n' +
        'globalThis.setInterval = realSetInterval;\n' +
        'at.stopActivityTracker();\n' +
        'if (started !== 2) { console.error(`restart created ${started} timer(s), expected 2`); process.exit(3); }\n'
    );
    assert.ok(r.exited, `the child had to be killed: ${r.stderr}`);
    assert.equal(r.status, 0, `restart after stop is broken: ${r.stderr}`);
  });
});

// ★ ONE LIST, USED TWICE. Below, it drives the assertion that shutdown() calls each stop; further
// down, it drives the child-process probes that each stop actually works. Two lists is what let
// `stopSensorSampler`, `stopClipStorage`, `stopTimelapseSampler` and `stopWakeWatcher` all go
// unasserted — the last two found only when this was finally derived rather than hand-typed.
//
// ⚠️ Declared at module scope, ABOVE both consumers: `describe` callbacks run synchronously as the
// file loads, so a `const` further down is in the temporal dead zone when the first one reads it.
//
// ⚠️ `pinsLoop` is NOT decoration. A timer that is `unref()`d does not hold the event loop open, so it
// can never cause the #278 failure — and for those modules the "start pins the process" control is
// simply false. Asserting it anyway would be asserting something untrue about correct code.
// wakeWatcher, clipStorage and timelapse all unref; the other three do not, which is why they were the risk.
const PERIODIC = [
  { module: 'src/lib/activityTracker.js', start: 'startActivityTracker', stop: 'stopActivityTracker', pinsLoop: true },
  { module: 'src/lib/sensorSampler.js', start: 'startSensorSampler', stop: 'stopSensorSampler', pinsLoop: true },
  { module: 'src/lib/sleepAnalysis.js', start: 'startSleepJob', stop: 'stopSleepJob', pinsLoop: true },
  { module: 'src/lib/wakeWatcher.js', start: 'startWakeWatcher', stop: 'stopWakeWatcher', pinsLoop: false },
  { module: 'src/lib/clipStorage.js', start: 'startClipStorage', stop: 'stopClipStorage', pinsLoop: false },
  // Added in #263, not #286: created through `safeInterval`, so the literal-`setInterval` scan that
  // built this list could not see it. Unref'd like the two above, so it never pinned the loop.
  { module: 'src/lib/timelapse.js', start: 'startTimelapseSampler', stop: 'stopTimelapseSampler', pinsLoop: false },
  // #373: the 15-minute `[obs]` line. Unref'd from the start, so like the three above it never pinned the loop.
  { module: 'src/lib/observationClock.js', start: 'startObservationLog', stop: 'stopObservationLog', pinsLoop: false },
  // #479: the 30 s check that restarts a MediaMTX whose API stopped answering. Created through `safeInterval` and unref'd,
  // so it never pinned the loop; listed so that shutdown() is asserted to stop it (the first call in shutdown()).
  { module: 'src/lib/mediamtxApiWatchdog.js', start: 'startMediamtxApiWatchdog', stop: 'stopMediamtxApiWatchdog', pinsLoop: false },
];

describe('shutdown() actually stops the tracker', () => {
  // ★ ADDED AFTER ADVERSARIAL REVIEW OF THIS PR. Deleting the `stopActivityTracker()` call from
  // shutdown() left the entire 513-test suite green — the production wiring was untested, and both
  // reviewers found it independently. It is invisible to a behavioural test because the `process.exit(0)`
  // on the very next line tears the timers down anyway, so nothing observable changes today. That is
  // exactly why it needs a source-level assertion: the moment shutdown stops hard-exiting, this call is
  // the only thing standing between a SIGTERM and a process that never dies.
  //
  // Matched as a trimmed WHOLE LINE, never with `indexOf` on a fragment: a substring search is
  // satisfied by the call appearing inside a comment, which is how a source assertion quietly stops
  // discriminating. Same technique as recordings-shutdown.test.js.
  const indexLines = readFileSync(path.join(BACKEND, 'src/index.js'), 'utf8')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.trim());

  // ⚠️ EVERY stop, and DERIVED — this list is `PERIODIC`, the same one the guard further down uses.
  //
  // ★ THIS HAS NOW BEEN GOT WRONG THREE TIMES, each time in the PR that cited the previous one.
  // It started as a single assertion for `stopActivityTracker`, because review of #290 found that
  // deleting the call left the whole suite green. #286 added three more calls and did not extend the
  // assertion, so removing `stopSensorSampler();` passed all 620 tests. #263 then added
  // `stopTimelapseSampler` and did not extend it either — while the comment sitting here CLAIMED to be
  // "derived from the list rather than written out once per name". It was a hand-typed literal array.
  // Found by adversarial review, which removed the call and watched 859 tests pass.
  //
  // So it is derived now, for real. A module added to PERIODIC is asserted here by construction, and
  // deriving it immediately exposed a FOURTH instance: `stopWakeWatcher` had existed since #286 and
  // shutdown never called it.
  for (const stop of PERIODIC.map((p) => p.stop)) {
    test(`shutdown() calls ${stop}()`, () => {
      assert.ok(
        indexLines.includes(`${stop}();`),
        `src/index.js no longer calls ${stop}() — a SIGTERM would leave its timer running, and only the ` +
          'hard process.exit(0) would still be ending the process (issues #278, #286)'
      );
    });

    test(`...and imports ${stop}, so the call is not dead text`, () => {
      // A call to a name that was never imported throws at shutdown, which is strictly worse than not
      // calling it — and the line-presence check above cannot tell the difference.
      const src = readFileSync(path.join(BACKEND, 'src/index.js'), 'utf8');
      assert.match(
        src,
        new RegExp(String.raw`import\s*\{[^}]*\b${stop}\b[^}]*\}\s*from`),
        `${stop} is called in index.js but never imported`
      );
    });
  }

  test('and imports it, rather than the call being dead text', () => {
    // Anti-vacuous companion: a call to a name that was never imported would throw at shutdown, which
    // is strictly worse than not calling it. The line above cannot tell the difference.
    const src = readFileSync(path.join(BACKEND, 'src/index.js'), 'utf8');
    assert.match(
      src,
      /import\s*\{[^}]*\bstopActivityTracker\b[^}]*\}\s*from\s*'\.\/lib\/activityTracker\.js'/,
      'stopActivityTracker is called in index.js but not imported from lib/activityTracker.js'
    );
  });
});

describe('the npm scripts do not paper over a leaked handle', () => {
  // The guard that keeps this fixed. `--test-force-exit` is an easy thing to re-add the next time one
  // test leaks a handle, and it fails in the least visible way available: files vanish from the run
  // and the summary still says `fail 0`.
  //
  // ⚠️ Read from package.json rather than asserted about the CI workflow: the workflow just calls
  // `npm test`, so package.json is where the flag would actually come back.
  const scripts = JSON.parse(readFileSync(path.join(BACKEND, 'package.json'), 'utf8')).scripts;

  test('no test script uses --test-force-exit', () => {
    // Every script, not a hand-written list of three — a `test:whatever` added later is covered by
    // default. Enumerating what is ALLOWED rather than what to CHECK is the shape that fails closed.
    const offenders = Object.entries(scripts)
      .filter(([, cmd]) => cmd.includes('--test-force-exit'))
      .map(([name]) => name);
    assert.deepEqual(
      offenders,
      [],
      `${offenders.join(', ')} re-introduced --test-force-exit (issue #278). It hides a leaked handle ` +
        'and cancels test files under CI load without failing anything. Find the handle and clear it.'
    );
  });

  // Anti-vacuous: if the scripts were renamed or the file moved, the check above would pass by
  // reading nothing at all.
  test('the scripts really were read', () => {
    // Flags between `node` and `--test` (e.g. --experimental-test-module-mocks) are legitimate — this
    // only needs to confirm we're looking at a real `node ... --test ...` invocation, not the exact
    // adjacency of those two words, or a new flag added for an unrelated reason breaks this vacuously.
    assert.ok(/\bnode\b.*--test\b/.test(scripts?.test ?? ''), `package.json scripts.test is not a node --test run: ${scripts?.test}`);
    assert.ok(Object.keys(scripts).length >= 3, 'the scripts block looks empty — this file is reading the wrong package.json');
  });
});

describe('the whole suite terminates without being forced', () => {
  // The end-to-end statement of the property, and the only one that covers a handle leaked by some
  // OTHER file later. Runs the real command on a single fast file rather than all 34: this test is
  // itself inside the suite, so running the suite from here would recurse.
  //
  // ⚠️ WHAT THIS DOES AND DOES NOT PROVE, stated plainly because it is easy to over-read: it proves
  // `node --test` with no force-exit terminates for the file it is given. It does NOT prove every
  // file in the suite is leak-free — that is proved by the suite itself passing without the flag,
  // which is now what CI does on every push. There is no way to assert that from within.
  test('node --test with no force-exit returns for a file that uses the tracker', async () => {
    const started = Date.now();
    // Async, with a ceiling that only a real hang reaches (see NESTED_RUN_CEILING_MS). A rejection here
    // carries the child's stdout/stderr, which is what the file-level failure of #666 never showed.
    const { stdout } = await promisify(execFile)(process.execPath, ['--test', 'test/activityTracker.test.js'], {
      cwd: BACKEND,
      timeout: NESTED_RUN_CEILING_MS,
      encoding: 'utf8',
      env: cleanEnv(),
    });
    const elapsed = Date.now() - started;
    assert.ok(elapsed < NESTED_RUN_CEILING_MS, `it took ${elapsed}ms to come back`);
    // Anti-vacuous: returning promptly means nothing if it returned without running anything. A
    // renamed or deleted target file would otherwise leave this green forever.
    // Accepts the human reporter (`ℹ pass 18`) or TAP (`# pass 18`), so this does not silently go
    // vacuous again if the reporter changes under it.
    const passed = Number(/(?:^|\n)[ℹ#]\s*pass (\d+)/.exec(stdout)?.[1] ?? 0);
    assert.ok(passed > 0, `the run came back without passing any tests — did the target file move?\n${stdout.slice(-400)}`);
  });
});

// -------------------------------------------------------------------------------------------
// The CLASS, not just the instance — issue #286.
//
// #278 was one module (activityTracker) with a start and no stop. Fixing that module did not stop the
// same shape existing elsewhere: `startSleepJob()` and `startSensorSampler()` had it too, and the only
// reason they never cost us the suite is that the one test calling startSleepJob for real wraps it in
// `mock.timers.enable`, so no real interval is ever created — a coincidence of how a test is written,
// not a property of the code. Nothing called startSensorSampler in a test at all.
//
// ★ The guard below is the durable half: it fails closed for modules that DO NOT EXIST YET, which is
// the property the npm-script check lacks. That check stops the symptom (`--test-force-exit`) coming
// back; this stops the cause.
describe('every periodic job can be stopped (#286)', () => {
  for (const { module, start, stop, pinsLoop } of PERIODIC) {
    test(`${start} can be undone, and the process then exits`, async () => {
      const r = await childExitsOnItsOwn(`at.${start}();\nat.${stop}();\n`, EXIT_DEADLINE_MS, module);
      assert.ok(r.exited, `${module} had to be killed after ${start}/${stop} — a timer survived. stderr: ${r.stderr}`);
      assert.equal(r.status, 0, `${module} exited ${r.status}: ${r.stderr}`);
    });

    test(`...and ${start} ${pinsLoop ? 'really does pin the process without it' : 'unrefs its timers, so it cannot pin the process'}`, async () => {
      // A module that pins is watched briefly (load cannot fake a hang); one that must NOT pin gets the
      // generous exit deadline, because there load CAN fake one (#666).
      const r = await childExitsOnItsOwn(`at.${start}();
`, pinsLoop ? HANG_GRACE_MS : EXIT_DEADLINE_MS, module);
      assert.ok(r.ranBody, `the probe never reached the end for ${module}: ${r.stderr}`);
      // For a module that pins the loop this is the control that makes the pair above meaningful.
      // For one that unrefs, the honest assertion is the opposite: it must NOT pin, because that is
      // the property keeping it clear of #278 in the first place.
      assert.equal(
        r.exited,
        !pinsLoop,
        pinsLoop
          ? `${start} does not hold the event loop open — the start/stop pair above proves nothing`
          : `${start} pinned the process despite unref() — it is now exposed to the #278 failure mode`
      );
    });
  }

  test('★ no module exports a startX that creates an interval without a matching stopX', () => {
    // ⚠️ THE FAIL-CLOSED GUARD. Discovered by walking src/, not by a list someone maintains — a new
    // periodic job added next year is covered on the day it lands, which is exactly what the list
    // above cannot do for code that does not exist yet. It has already earned that: it found
    // clipStorage, which issue #286 did not name.
    //
    // ⚠️ THE ANTI-VACUOUS HALF IS INSIDE THIS TEST ON PURPOSE. It used to be a separate case that
    // re-derived the sweep for itself, so narrowing THIS loop — or dropping the setInterval filter —
    // left both cases green while the guard examined nothing at all. Mutation testing showed exactly
    // that: two mutants that neutered the guard survived. Asserting on what this loop actually
    // examined is the only version that cannot be quietly switched off.
    // ⚠️ EXEMPTIONS CARRY A REASON, and there is exactly one. An ALLOWED map is still a skip-list, so
    // it is the shape that can fail open — which is why each entry has to justify itself in writing
    // and why the list is this short. Same pattern as the unbounded-fetch guard in notify-timeouts.
    const ALLOWED = {
      // safeInterval is a FACTORY: it returns the timer to its caller, who owns and clears it. The
      // module never holds a handle, so it has nothing to stop. index.js calls it fire-and-forget for
      // watchdogs that are meant to run for the process lifetime; process-guards.test.js collects and
      // clears the ones it creates.
      'lib/processGuards.js': 'safeInterval returns the timer; the caller owns it',
      // index.js is the PROCESS, not a module. Its four watchdogs are meant to run for the lifetime of
      // the container and end when it does; there is no importer to leak into and no lifecycle to
      // export. It only appears here at all because the guard learned about `safeInterval` (#263) —
      // rule B then reads "a repeating timer with no stop export", which is true and not a defect.
      //
      // ⚠️ The claim "no importer to leak into" is asserted, not assumed — see the test below. An
      // exemption whose justification nothing checks is how a skip-list quietly becomes wrong.
      'index.js': 'the process entry point: never imported, its timers end with the process',
      // handleTalkConnection's setInterval is PER-CONNECTION, not module-level state: it lives in that
      // one call's closure, is cleared by that SAME closure's own cleanup() (called from ws 'close',
      // ws 'error', a failed session start, AND the interval's own revocation check — every path out),
      // and nothing outside the closure ever holds a reference to it. There is no separate "stop the
      // interval" step for a caller to forget, because there is no caller-visible lifecycle at all —
      // the one caller (index.js's upgrade handler) calls this once per connection and never calls
      // anything else. Structurally this is the processGuards.js case (a factory whose timer belongs
      // entirely to its own scope), not the #286 shape (a module-level job an importer must remember
      // to stop) — it just doesn't return the timer to an external owner because there isn't one.
      //
      // ⚠️ "Self-clearing" is ASSERTED here, not just assumed — same standard as the index.js exemption
      // above. Proof lives in talk-socket.test.js's "★ the revalidation timer is actually cleared on
      // revocation, not just harmlessly idempotent" test, which spies on clearInterval directly. It
      // exists BECAUSE an earlier adversarial review found this exemption's own first draft had no such
      // test: deleting the clearInterval call left every other test in that file passing, since
      // cleanup()'s `closed` guard makes a leaked-but-never-firing-again-observably interval invisible
      // to assertions that only check state once. An exemption whose justification nothing checks is
      // exactly how a skip-list quietly becomes wrong — this one no longer is.
      'lib/talkSocket.js': 'setInterval is per-connection and self-clearing, not module-level state',
    };

    // ⚠️ THE SWEEP ITSELF IS A TESTED FUNCTION NOW, not a loop written here. Written here, it passed
    // pre-stripped source into both helpers and silently disabled the guard's computed-access
    // detection — the helper was right and the wiring was wrong, so no mutation of the helper could
    // have found it. See scanPeriodic's own fixtures below.
    const { examined, offenders } = scanPeriodic(walkSources(), ALLOWED);

    // Anti-vacuous FIRST: if the loop examined nothing, an empty `offenders` means nothing.
    for (const { module } of PERIODIC) {
      const rel = module.replace(/^src\//, '');
      assert.ok(examined.includes(rel), `the guard did not examine ${rel} — it has stopped covering it`);
    }
    assert.ok(
      examined.length >= PERIODIC.length,
      `the guard examined only ${examined.length} module(s) — the walk or the setInterval filter has stopped matching`
    );

    assert.deepEqual(
      offenders,
      [],
      'a periodic job cannot be stopped (issue #286). A setInterval nothing can clear keeps `node --test` ' +
        'alive forever, which is what forced --test-force-exit and cost a third of the suite in #278:\n  ' +
        offenders.join('\n  ')
    );
  });

  test('★ a stop must NULL its handle, or the next start is a silent no-op', async () => {
    // Every one of these guards on `if (timer) return` (or `if (!timer)`), so a stop that clears the
    // handle without nulling it leaves the module permanently stopped: the restart looks like it
    // worked and nothing runs again. Mutation testing found this uncovered for the new stops — the
    // clear-but-do-not-null mutant survived, because every other case here stops and never restarts.
    //
    // Counts real setInterval calls in a child, which is the only observable difference: a restart
    // that silently did nothing registers no new timers.
    for (const { module, start, stop } of PERIODIC) {
      const r = await childExitsOnItsOwn(
        `at.${start}();\n` +
          `at.${stop}();\n` +
          'let created = 0;\n' +
          'const realSetInterval = globalThis.setInterval;\n' +
          'globalThis.setInterval = (...a) => { created += 1; return realSetInterval(...a); };\n' +
          `at.${start}();\n` +
          'globalThis.setInterval = realSetInterval;\n' +
          `at.${stop}();\n` +
          `if (created === 0) { console.error('restart after stop created no timers'); process.exit(3); }\n`,
        EXIT_DEADLINE_MS,
        module
      );
      assert.ok(r.exited, `${module}: the child had to be killed — ${r.stderr}`);
      assert.equal(r.status, 0, `${module}: ${stop}() did not null its handle, so ${start}() is now inert — ${r.stderr}`);
    }
  });
});

// -------------------------------------------------------------------------------------------
// What the guard can and cannot see — issue #286.
//
// ⚠️ THE FIRST VERSION OF THE GUARD CAUGHT ONE OF EIGHT LEAK SHAPES. I only found that out by writing
// files into src/ by hand and watching the suite stay green; six walked straight past it, including
// the two indirections that beat the unbounded-fetch scan in #262 (an alias, and a renamed export).
// A guard that only catches the shape its author happened to write is not a guard.
//
// These are those probes, as fixtures. The rule is a pure function precisely so they can live here
// instead of depending on someone remembering to re-attack it.
describe('the guard catches the shapes people actually write (#286)', () => {
  const LEAKS = {
    'export function + setInterval': 'let t=null;\nexport function startZz(){ t=setInterval(()=>{},1000); }',
    'arrow-function export': 'let t=null;\nexport const startZz = () => { t=setInterval(()=>{},1000); };',
    'renamed export': 'let t=null;\nfunction foo(){ t=setInterval(()=>{},1000); }\nexport { foo as startZz };',
    'aliased setInterval': 'let t=null;\nconst si = setInterval;\nexport function startZz(){ t=si(()=>{},1000); }',
    'globalThis.setInterval': 'let t=null;\nexport function startZz(){ t=globalThis.setInterval(()=>{},1000); }',
    'module-level timer, no start at all': 'const t = setInterval(()=>{},1000);\nexport const noop = () => t;',
    'class method': 'export class Zz { startZz(){ this.t=setInterval(()=>{},1000); } }',
  };

  for (const [name, code] of Object.entries(LEAKS)) {
    test(`catches: ${name}`, () => {
      const offences = unstoppableTimerOffences('lib/zz-probe.js', code);
      assert.ok(offences.length > 0, `this leak shape is invisible to the guard:\n${code}`);
    });
  }

  const FINE = {
    'a proper start/stop pair':
      'let t=null;\nexport function startZz(){ t=setInterval(()=>{},1000); }\nexport function stopZz(){ clearInterval(t); t=null; }',
    'teardown named close(), as twoWayAudio does':
      'let t=null;\nexport function startZz(){ t=setInterval(()=>{},1000); }\nexport function closeZz(){ clearInterval(t); t=null; }',
    'no timer at all': 'export function startZz(){ /* nothing periodic */ }',
    'a one-shot setTimeout with a named callback, as onvif does':
      'const done = () => {};\nexport function probeZz(){ setTimeout(done, 5000); }',
  };

  for (const [name, code] of Object.entries(FINE)) {
    test(`does NOT flag: ${name}`, () => {
      // ⚠️ The false-positive half, and it is not decoration. An earlier draft flagged onvif.js for a
      // one-shot `setTimeout(done, …)` it mistook for a self-rescheduling timer, and twoWayAudio for
      // naming its teardown `close()`. A guard that flags correct code is one people learn to click
      // past — this repo's own reason for keeping the definition-of-done job a warning.
      const offences = unstoppableTimerOffences('lib/zz-probe.js', code);
      assert.deepEqual(offences, [], `correct code was flagged:\n${code}`);
    });
  }

  test('⚠️ the known limit is real and stated: a self-rescheduling setTimeout is NOT caught', () => {
    // Asserted rather than left implicit, so nobody reads the guard as airtight. Detecting this needs
    // to know whether the call sits inside the body of the function it names — a parser's job. An
    // approximation was tried and false-positived on the first real file it met.
    const code = 'let t=null;\nfunction tick(){ t=setTimeout(tick,1000); }\nexport function startZz(){ tick(); }';
    const offences = unstoppableTimerOffences('lib/zz-probe.js', code);
    assert.deepEqual(
      offences,
      [],
      'the guard now catches self-rescheduling setTimeout — good, but update this test and the comment ' +
        'in sourceScan.js, which both say it does not'
    );
  });
});

// -------------------------------------------------------------------------------------------
// Shapes adversarial review of #286 got past the guard, as fixtures. Each was a REAL hang: a probe
// importing the planted module and calling its start had to be killed on the timeout.
describe('bypasses found by review, now closed (#286)', () => {
  test('computed access: globalThis[\'setInterval\'](…)', () => {
    // ⚠️ THE STRIPPER CAUSED THIS ONE. Blanking string literals — which exists to stop a comment
    // mentioning setInterval from being read as a timer — turned `globalThis['setInterval']` into
    // `globalThis['']`, so the identifier vanished before any scan saw it. The thing preventing false
    // positives was creating a false NEGATIVE. Timer detection now runs on source with comments
    // removed but strings intact; export detection still runs on the fully stripped copy.
    const code = "export function startZz(){ globalThis['setInterval'](()=>{},1000); }";
    assert.ok(unstoppableTimerOffences('lib/zz.js', code).length > 0, 'computed access is still invisible');
  });

  test('destructured access: const { setInterval: si } = globalThis', () => {
    const code = 'const { setInterval: si } = globalThis;\nexport function startZz(){ si(()=>{},1000); }';
    assert.ok(unstoppableTimerOffences('lib/zz.js', code).length > 0);
  });

  test('a module-level timer beside DECOY unref() calls', () => {
    // ⚠️ `unrefsEverything` counted `.unref(` against `setInterval(` and could not tell WHICH object
    // was unref'd. Two decoys on unrelated objects satisfied the count while a real interval leaked —
    // demonstrated as an actual hang. The unref exemption is gone from rule B entirely.
    const code = [
      'const a = {}; const b = {};',
      'a.unref?.(); b.unref?.();',
      'const t = setInterval(()=>{},1000);',
      'export const noop = () => t;',
    ].join('\n');
    assert.ok(unstoppableTimerOffences('lib/zz.js', code).length > 0, 'decoy unref() calls still buy a pass');
  });

  test('a comment mentioning setInterval is still NOT a timer', () => {
    // The false-positive half of the same change: strings are now visible to the timer scan, so the
    // comment path is the one still doing the work of not flagging prose.
    const code = '// this module deliberately avoids setInterval\nexport function startZz(){ /* nothing */ }';
    assert.deepEqual(unstoppableTimerOffences('lib/zz.js', code), []);
  });

  test('★ the repo\'s OWN wrapper: safeInterval (#263)', () => {
    // The one that got through in real life. `processGuards.safeInterval` returns a genuine interval
    // timer, but the word `setInterval` never appears at the call site, so the module was skipped
    // before either rule ran. `lib/timelapse.js` had a start and no stop for exactly as long as the
    // guard could not see it — a guard that only knows the platform primitive is blind to every
    // wrapper written over it, and this codebase has one, used in five places.
    const code = "import { safeInterval } from './processGuards.js';\n" +
      'let t = null;\nexport function startZz(){ t = safeInterval("zz", 1000, () => {}); }';
    assert.ok(
      unstoppableTimerOffences('lib/zz.js', code).length > 0,
      'a start built on safeInterval, with no stop, is still invisible to the guard'
    );
  });

  test('...and safeInterval WITH a stop is fine — the control', () => {
    // Without this, a rule that flagged every module mentioning safeInterval would pass the test above
    // and fail the whole codebase; the assertion has to discriminate, not just fire.
    const code = "import { safeInterval } from './processGuards.js';\n" +
      'let t = null;\nexport function startZz(){ t = safeInterval("zz", 1000, () => {}); }\n' +
      'export function stopZz(){ clearInterval(t); t = null; }';
    assert.deepEqual(unstoppableTimerOffences('lib/zz.js', code), []);
  });
});

describe('the SWEEP, not just the rule — testing the wiring (#263)', () => {
  // ★ Every fixture in the block above hands source straight to `unstoppableTimerOffences`. That
  // proves the RULE and says nothing about how the real tree reaches it, and the real tree reached it
  // through a loop that pre-stripped the source and undid half of it. These go through `scanPeriodic`,
  // which is what the guard above actually calls.
  const src = (rel, code) => [{ rel, src: code }];

  test('★ computed access survives the trip through the sweep', () => {
    // The mutant this exists for: `scanPeriodic` passing `stripCommentsAndStrings(src)` instead of
    // `stripCommentsOnly(src)`. Nothing in src/ is written this way, so the real-tree assertion cannot
    // notice — only a synthetic source can.
    const { examined, offenders } = scanPeriodic(
      src('lib/zz.js', "export function startZz(){ globalThis['setInterval'](()=>{},1000); }")
    );
    assert.deepEqual(examined, ['lib/zz.js'], 'the sweep skipped a module that does create a timer');
    assert.ok(offenders.length > 0, 'the sweep blanked the string before looking for the timer');
  });

  test('a name that only appears inside a STRING is not treated as an export', () => {
    // The other half of the two-views rule, and the reason the sweep must not pre-blank OR pre-keep
    // for both questions. Here `stopZz` exists only as text inside a log line — it is not a teardown,
    // and a scan that read exports from strings-intact source would think it was.
    const { offenders } = scanPeriodic(
      src('lib/zz.js', 'let t=null;\nexport function startZz(){ t = setInterval(()=>{},1000); console.log("stopZz"); }')
    );
    assert.ok(offenders.length > 0, 'a stop mentioned only in a string counted as a real teardown');
  });

  test('the exemption map is honoured, and only for the exact path', () => {
    const code = 'export function startZz(){ setInterval(()=>{},1000); }';
    assert.deepEqual(scanPeriodic(src('lib/zz.js', code), { 'lib/zz.js': 'reason' }).examined, []);
    assert.deepEqual(scanPeriodic(src('lib/zz.js', code), { 'lib/other.js': 'reason' }).examined, ['lib/zz.js']);
  });

  test('a module with no timer is not even examined', () => {
    assert.deepEqual(scanPeriodic(src('lib/zz.js', 'export const x = 1;')), { examined: [], offenders: [] });
  });
});

describe('the ALLOWED exemptions justify themselves (#263)', () => {
  test('★ index.js really is imported by no test — which is what its exemption rests on', () => {
    // The exemption's stated reason is "never imported, so it cannot leak into a test process". That
    // is a CLAIM, and a claim nothing checks is how a skip-list rots: the day someone imports index.js
    // from a suite, its four unstoppable watchdogs come with it and the guard is looking the other way.
    // Derived from the test directory rather than a list typed here, so a new file is covered by
    // default.
    //
    // ⚠️ IMPORTING is the question, not mentioning. Four suites already READ src/index.js as text
    // (asserting that shutdown calls each stop, that it parses) and that is fine — reading a file does
    // not run it. The first version of this matched any string containing the path and flagged all
    // four. Known limit: a computed specifier would slip past; nothing in this suite uses one, and an
    // AST for this would cost more than it is worth.
    const IMPORTS_INDEX = /(?:\bfrom|\bimport\s*\()\s*['"`][^'"`]*src\/index\.js['"`]/;
    const SELF = path.basename(fileURLToPath(import.meta.url));
    const testDir = path.dirname(fileURLToPath(import.meta.url));
    // This file is excluded because the three probe assertions below contain literal import
    // statements as DATA — a scanner that reads itself matches its own pattern, which it did on the
    // first run. Safe here specifically because this suite never imports application code: everything
    // it exercises runs in a spawned child (see childExitsOnItsOwn).
    const files = readdirSync(testDir).filter((f) => f.endsWith('.test.js') && f !== SELF);
    // Anti-vacuous, and not theoretical: if the directory ever moves, `offenders` is empty because
    // nothing was read, and an empty list is exactly what "all clear" looks like.
    assert.ok(files.length > 20, `only ${files.length} test files found — the scan is looking in the wrong place`);
    // ...and the pattern itself must still match the thing it is looking for.
    assert.ok(IMPORTS_INDEX.test("import x from '../src/index.js';"), 'the import pattern no longer matches an import');
    assert.ok(IMPORTS_INDEX.test("await import('../src/index.js')"), 'the import pattern no longer matches a dynamic import');
    assert.ok(!IMPORTS_INDEX.test("readFileSync(new URL('../src/index.js', import.meta.url))"), 'reading the file is not importing it');

    const offenders = files.filter((f) => IMPORTS_INDEX.test(readFileSync(path.join(testDir, f), 'utf8')));
    assert.deepEqual(
      offenders,
      [],
      `${offenders.join(', ')} imports src/index.js, so its exemption in the periodic-job guard no ` +
        'longer holds. Either drop the import or drop the exemption and give index.js a teardown.'
    );
  });
});

describe('what the guard still cannot see — stated, not hidden (#286)', () => {
  // ⚠️ These are REAL gaps, asserted so nobody reads the guard as airtight and so closing one forces
  // an update here. Adversarial review found all of them; each is a genuine hang.
  const KNOWN_GAPS = {
    'self-rescheduling setTimeout':
      'let t=null;\nfunction tick(){ t=setTimeout(tick,1000); }\nexport function startZz(){ tick(); }',
    'self-rescheduling setImmediate':
      'function loop(){ setImmediate(loop); }\nexport function startZzImmediate(){ loop(); }',
    'a stop that exists but clears nothing':
      'let t=null;\nexport function startZz(){ t=setInterval(()=>{},1000); }\nexport function stopZz(){ /* forgot clearInterval */ }',
  };
  for (const [name, code] of Object.entries(KNOWN_GAPS)) {
    test(`still not caught: ${name}`, () => {
      assert.deepEqual(
        unstoppableTimerOffences('lib/zz.js', code),
        [],
        `the guard now catches "${name}" — good. Update this test AND the limits documented in ` +
          'sourceScan.js, which both still say it does not.'
      );
    });
  }

  test('the ALLOWED exemption is by FILENAME, so a new job in that file is invisible', () => {
    // Stated because it is a genuine hole: the reason given ("safeInterval returns the timer to its
    // caller") justifies ONE function, not the whole file forever. Narrowing it needs per-function
    // analysis, which is a parser's job. Recorded so the next person does not assume otherwise.
    const code = 'export function safeInterval(l,ms,fn){ return setInterval(fn,ms); }\n' +
      'let t=null;\nexport function startLeak(){ t=setInterval(()=>{},1000); }';
    assert.ok(
      unstoppableTimerOffences('lib/processGuards.js', code).length > 0,
      'the pure rule does flag it — the exemption is applied by the caller, which is where the hole is'
    );
  });
});
