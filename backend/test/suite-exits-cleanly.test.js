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
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  walkSources, stripCommentsAndStrings, periodicEvidence, unstoppableTimerOffences,
} from './helpers/sourceScan.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.resolve(HERE, '..');

// Comfortably longer than a clean start+stop takes, and far shorter than the 60s flush interval that
// a leaked timer would hold the process open for — so the two outcomes cannot be confused for one
// another on a slow runner.
const EXIT_DEADLINE_MS = 20_000;

// The control case below has to WAIT OUT its deadline every single run, so that number is paid in
// wall-clock on every green build — it is deliberately not the same one. A clean start+stop child
// returns in ~270ms, so 5s is ~18x the honest time (no flake risk from a slow runner) while still
// being a twelfth of the 60s flush interval a leaked timer would hold the process open for. The
// generous 20s stays where it costs nothing: on the cases that PASS by exiting promptly.
const HANG_DEADLINE_MS = 5_000;

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
function childExitsOnItsOwn(body, timeoutMs = EXIT_DEADLINE_MS, modulePath = 'src/lib/activityTracker.js') {
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
      `\nconsole.log('BODY-DONE');\n`,
    'utf8'
  );
  try {
    const r = spawnSync(process.execPath, [script], { timeout: timeoutMs, encoding: 'utf8', env: cleanEnv() });
    // spawnSync sets `signal` when it kills a child on timeout; a child that returned on its own has
    // a numeric status and no signal.
    return {
      exited: r.signal === null && r.status !== null,
      ranBody: (r.stdout || '').includes('BODY-DONE'),
      status: r.status,
      signal: r.signal,
      stderr: r.stderr,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('starting the activity tracker does not pin the process open', () => {
  test('a process that starts and then STOPS the tracker exits on its own', () => {
    const r = childExitsOnItsOwn('at.startActivityTracker();\nat.stopActivityTracker();\n');
    assert.ok(
      r.exited,
      `the child had to be killed after ${EXIT_DEADLINE_MS}ms (signal=${r.signal}) — stopActivityTracker ` +
        `left a timer behind, which is what forced --test-force-exit on the whole suite. stderr: ${r.stderr}`
    );
    assert.equal(r.status, 0, `the child exited ${r.status} rather than cleanly: ${r.stderr}`);
  });

  // ★ THE CONTROL, and the reason the case above proves anything. Without it, a `stopActivityTracker`
  // that did nothing at all would still pass if some unrelated change let the process exit anyway.
  // This asserts the leak is REAL and that the test can see it: start without stopping, and the child
  // must have to be killed.
  test('a process that starts and does NOT stop it has to be killed — the leak is real', () => {
    const r = childExitsOnItsOwn('at.startActivityTracker();\n', HANG_DEADLINE_MS);
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

  test('stop is idempotent and a restart still works', () => {
    // Kills the "cleared but not nulled" mutant: `startActivityTracker` guards on `if (flushTimer)
    // return`, so a stop that clears the handles without nulling them makes every later start a
    // silent no-op — and nothing else in the suite would notice.
    const r = childExitsOnItsOwn(
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

  // ⚠️ EVERY stop, not just the first one. This started as a single assertion for
  // stopActivityTracker, added because adversarial review of #290 found that deleting a call left the
  // whole suite green. #286 then added three more calls and did NOT extend the assertion — so
  // removing `stopSensorSampler();` or `stopClipStorage();` from shutdown() passed all 620 tests.
  // The lesson was cited in the same PR that repeated it, which is why this is now derived from the
  // list rather than written out once per name.
  for (const stop of ['stopActivityTracker', 'stopSensorSampler', 'stopClipStorage', 'stopSleepJob']) {
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
    assert.ok(scripts?.test?.includes('node --test'), `package.json scripts.test is not a node --test run: ${scripts?.test}`);
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
  test('node --test with no force-exit returns for a file that uses the tracker', () => {
    const started = Date.now();
    const stdout = execFileSync(process.execPath, ['--test', 'test/activityTracker.test.js'], {
      cwd: BACKEND,
      timeout: EXIT_DEADLINE_MS * 3,
      encoding: 'utf8',
      stdio: 'pipe',
      env: cleanEnv(),
    });
    const elapsed = Date.now() - started;
    assert.ok(elapsed < EXIT_DEADLINE_MS * 3, `it took ${elapsed}ms to come back`);
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
  // ⚠️ `pinsLoop` is NOT decoration. A timer that is `unref()`d does not hold the event loop open, so
  // it can never cause the #278 failure — and for those modules the "start pins the process" control
  // below is simply false. Asserting it anyway would be asserting something untrue about correct code.
  // wakeWatcher and clipStorage both unref; the other three do not, which is why they were the risk.
  const PERIODIC = [
    { module: 'src/lib/activityTracker.js', start: 'startActivityTracker', stop: 'stopActivityTracker', pinsLoop: true },
    { module: 'src/lib/sensorSampler.js', start: 'startSensorSampler', stop: 'stopSensorSampler', pinsLoop: true },
    { module: 'src/lib/sleepAnalysis.js', start: 'startSleepJob', stop: 'stopSleepJob', pinsLoop: true },
    { module: 'src/lib/wakeWatcher.js', start: 'startWakeWatcher', stop: 'stopWakeWatcher', pinsLoop: false },
    { module: 'src/lib/clipStorage.js', start: 'startClipStorage', stop: 'stopClipStorage', pinsLoop: false },
  ];

  for (const { module, start, stop, pinsLoop } of PERIODIC) {
    test(`${start} can be undone, and the process then exits`, () => {
      const r = childExitsOnItsOwn(`at.${start}();\nat.${stop}();\n`, EXIT_DEADLINE_MS, module);
      assert.ok(r.exited, `${module} had to be killed after ${start}/${stop} — a timer survived. stderr: ${r.stderr}`);
      assert.equal(r.status, 0, `${module} exited ${r.status}: ${r.stderr}`);
    });

    test(`...and ${start} ${pinsLoop ? 'really does pin the process without it' : 'unrefs its timers, so it cannot pin the process'}`, () => {
      const r = childExitsOnItsOwn(`at.${start}();
`, HANG_DEADLINE_MS, module);
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
    };

    const examined = [];
    const offenders = [];
    for (const { rel, src } of walkSources()) {
      if (ALLOWED[rel]) continue;
      const code = stripCommentsAndStrings(src);
      const evidence = periodicEvidence(code);
      if (!evidence.length) continue;
      examined.push(rel);

      offenders.push(...unstoppableTimerOffences(rel, code));
    }

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

  test('★ a stop must NULL its handle, or the next start is a silent no-op', () => {
    // Every one of these guards on `if (timer) return` (or `if (!timer)`), so a stop that clears the
    // handle without nulling it leaves the module permanently stopped: the restart looks like it
    // worked and nothing runs again. Mutation testing found this uncovered for the new stops — the
    // clear-but-do-not-null mutant survived, because every other case here stops and never restarts.
    //
    // Counts real setInterval calls in a child, which is the only observable difference: a restart
    // that silently did nothing registers no new timers.
    for (const { module, start, stop } of PERIODIC) {
      const r = childExitsOnItsOwn(
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
