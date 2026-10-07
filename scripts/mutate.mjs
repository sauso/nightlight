#!/usr/bin/env node
// Mutation testing for the backend and frontend suites.
//
// WHY THIS EXISTS (issue #263, item 5). An adversarial audit found 48 of 54 clip mutants and 8 auth
// mutants surviving a green 389-test suite at ~99% line coverage. None of that was visible from
// coverage, because **coverage measures execution and mutation testing measures discrimination**: a
// line can be executed by twenty tests and still have no test that fails when you change it.
//
// The audit was a one-off, done by hand, and its findings were only as durable as the person who
// remembered them. This makes it repeatable: the mutants live in `mutants.json` next to this file, and
// anyone can re-run them. Item 5 of #263 asked for exactly that — "consider running mutation testing
// periodically rather than once".
//
// USAGE
//   node scripts/mutate.mjs                 # every mutant, each against the tests it names
//   node scripts/mutate.mjs --full          # every mutant against the WHOLE suite (slow, ~50s each)
//   node scripts/mutate.mjs --only=sweeper  # mutants whose label contains "sweeper"
//   node scripts/mutate.mjs --list          # print the catalogue and exit
//   node scripts/mutate.mjs --check         # run NO tests: only verify every `find` still matches exactly once
//                                           # (a few seconds; the way to find stale anchors before a full run, #575)
//   node scripts/mutate.mjs --timeout=<ms>  # wall-clock limit per mutant, overriding the default and every `timeoutMs`
//
// ⚠️ THE THREE WAYS A MUTATION RUN LIES, all of which have happened in this repo and all of which are
// guarded against below. Read these before adding a mutant:
//
//   1. **The mutant never applied.** A `find` string that does not match (a CRLF/LF mismatch, a stale
//      copy of the line, a typo) leaves the source untouched, so the suite passes and the mutant is
//      recorded as SURVIVED — the most alarming possible result, from a no-op. Guarded: `find` must
//      occur EXACTLY ONCE, and the post-write file must differ from the snapshot, or the run aborts.
//   2. **The restore lied.** A previous harness here used `git checkout --` to undo a mutation and
//      reverted an UNCOMMITTED FIX along with it, making five results meaningless. Guarded: the
//      original bytes are held in memory, written back verbatim, and compared byte-for-byte after.
//      Nothing in this file shells out to git.
//   3. **The harness itself is broken.** If the test command is wrong, or the tests never load the
//      mutated module, EVERY mutant survives and it looks like a catastrophic suite failure. Guarded:
//      the catalogue carries `expect: "survives"` control mutants (a comment edit) whose survival
//      proves only that the harness works. A control reported KILLED means the harness is lying and
//      every other result in the run is void — it exits non-zero and says so.
//
//   4. **The mutant never finishes.** A mutation can turn a loop into an infinite one (#509, 2026-10-06: a
//      `continue` guard flipped on a loop that steps `s = e - 1; s++`). The test child then spins forever,
//      the run never produces a verdict, and — measured — the spinning process outlived the run by ~25
//      minutes (~1,750 CPU-seconds) while the scratch tree stayed mutated. Guarded: every mutant's test run
//      has a wall-clock limit (DEFAULT_TIMEOUT_MS, or the entry's own `timeoutMs`); on expiry the WHOLE
//      process tree is killed (`node --test` runs each file in a grandchild, so killing only the direct
//      child leaves the spinner behind), the file is restored as for any other verdict, and the mutant is
//      reported as HANG. A HANG counts as killed — the code did not survive — but it is listed separately
//      at the end, because dying by timeout is a weaker kill than a failing assertion: a mutant that
//      should have tripped a test and only tripped the clock deserves a look.
//
// A mutant is KILLED if the chosen tests fail with it applied. SURVIVED means the suite cannot tell
// the mutated code from the real code — that is the finding, and it needs either a new test or a
// written reason why it does not matter.
import { readFileSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const BACKEND = path.join(REPO, 'backend');
const FRONTEND = path.join(REPO, 'frontend');

const args = process.argv.slice(2);
const flag = (name) => args.some((a) => a === `--${name}`);
const value = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');

const catalogue = JSON.parse(readFileSync(path.join(HERE, 'mutants.json'), 'utf8'));
const only = value('only');
const mutants = only ? catalogue.filter((m) => m.label.includes(only)) : catalogue;

if (flag('list')) {
  for (const m of catalogue) console.log(`${m.expect === 'survives' ? 'CONTROL ' : '        '}${m.label}  [${m.file}]`);
  process.exit(0);
}
// --check applies the same "does this mutant apply at all" rules the run enforces, to the WHOLE catalogue
// and without running a single test. Before this, a stale anchor was only discovered when the full run
// reached it, which aborted everything after it (#575: four entries had drifted unnoticed). Files are read
// as bytes and `find` is matched as text, exactly as below, so the two cannot disagree.
if (flag('check')) {
  let bad = 0;
  for (const m of catalogue) {
    let problem = null;
    try {
      const text = readFileSync(path.join(REPO, m.file)).toString('utf8');
      const hits = text.split(m.find).length - 1;
      if (hits !== 1) problem = `its \`find\` matches ${hits} times in ${m.file}, expected exactly 1`;
      else if (m.find === m.replace) problem = 'find === replace, applying it changes nothing';
    } catch (e) {
      problem = `cannot read ${m.file} (${e.code || e.message})`;
    }
    if (problem) { bad++; console.error(`STALE: "${m.label}" — ${problem}.`); }
  }
  console.log(`${catalogue.length} catalogue entries, ${bad} that would not apply.`);
  process.exit(bad ? 3 : 0);
}
if (!mutants.length) {
  console.error(`no mutants match --only=${only}`);
  process.exit(2);
}

// Wall-clock limit per mutant (issue #617). The longest run in the catalogue is a `--full` pass at about 50 s
// per mutant on the author's Windows machine, so five minutes is six times that: slow enough that a loaded
// CI runner does not trip it, short enough that a looping mutant costs minutes rather than the afternoon it
// cost on 2026-10-06. A catalogue entry that legitimately needs longer sets `timeoutMs`.
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
// How long to wait for the pipes to close after the tree has been killed before giving up on them. A
// grandchild that escaped the kill and still holds stdout open must not turn a timeout into a second hang.
const KILL_GRACE_MS = 10 * 1000;
const cliTimeout = value('timeout');
if (cliTimeout !== undefined && !(Number(cliTimeout) > 0)) {
  console.error(`--timeout must be a positive number of milliseconds, got "${cliTimeout}"`);
  process.exit(2);
}

// The child of the mutant currently under test, and the file that mutant is applied to. Held at module level
// so a SIGINT/SIGTERM can undo both: a `finally` block does not run when the process is signalled.
let currentChild = null;
let applied = null; // { abs, original } while a mutation is on disk

// Kill a child AND everything it started. `node --test` runs each test file in a grandchild, which is the
// process that actually spins; signalling only the direct child (what `spawnSync`'s `timeout` does) leaves
// it running. POSIX: the child is spawned as a process-group leader (`detached`), so one signal to the
// negative pid reaches the group. Windows has no process groups, and `taskkill /T` walks the tree instead.
function killTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
  }
}

// `detached` takes the children out of this terminal's foreground process group, so Ctrl-C no longer reaches
// them by itself; this is what stops a Ctrl-C leaving both a running test and a mutated source file behind.
// (The wider "killed run leaves a mutant in the source" problem, journal and all, is #599.)
function bail(signal) {
  killTree(currentChild);
  if (applied) {
    try { writeFileSync(applied.abs, applied.original); } catch { /* reported below if it matters */ }
    console.error(`\n${signal}: restored ${path.relative(REPO, applied.abs)} and stopped the test run.`);
  }
  process.exit(130);
}
process.on('SIGINT', () => bail('SIGINT'));
process.on('SIGTERM', () => bail('SIGTERM'));

// Run the suite (or a subset of it) and report only whether it failed. stdio is swallowed: a mutated
// suite produces pages of expected noise, and the one bit that matters is the exit status.
//
// ⚠️ `node --test` exits 0 on a run whose files were CANCELLED rather than failed (issue #278 — a
// killed runner reports `fail 0, cancelled N`). Exit status alone would read that as "the mutant
// survived". So the output is also scanned for a non-zero `cancelled` count, which is neither a kill
// nor a survival — it is an unusable result, and it is reported as ERROR.
// `namePattern` narrows the run further, to the tests whose name matches. It exists for a specific
// honesty problem: a test that pins a constant against its literal value kills EVERY mutation of that
// constant on its own, which hides whether the behavioural tests around it discriminate at all. Naming
// the pattern lets a mutant be scored against the behaviour alone.
//
// Async (spawn, not spawnSync) so a wall-clock limit can fire while the child is still running: spawnSync
// blocks this process, and its own `timeout` kills only the direct child (see killTree).
function runCommand(command, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const env = { ...process.env, NODE_OPTIONS: '' };
    // When this script is itself run from inside a `node --test` file (the harness's own test does that), the
    // inherited NODE_TEST_CONTEXT makes the nested runner behave as a reporter child and print nothing
    // parseable. The mutant's suite is a fresh, top-level run.
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, command, {
      cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
    });
    currentChild = child;
    let stdout = '';
    let stderr = '';
    let hung = false;
    let settled = false;
    const finish = (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(limit);
      clearTimeout(grace);
      currentChild = null;
      resolve({ status, stdout, stderr, hung });
    };
    let grace;
    const limit = setTimeout(() => {
      hung = true;
      killTree(child);
      grace = setTimeout(() => finish(null), KILL_GRACE_MS);
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', () => finish(null)); // the interpreter itself could not start: an unusable run, ERROR upstream
    child.on('close', (status) => finish(status));
  });
}

async function runTests(testFiles, namePattern, frontend = false, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const target = testFiles?.length ? testFiles.map((f) => path.join('test', f)) : ['test/*.test.js'];
  const nameArgs = namePattern ? [frontend ? '--testNamePattern' : '--test-name-pattern', namePattern] : [];
  const command = frontend
    ? [path.join(FRONTEND, 'node_modules/vitest/vitest.mjs'), 'run', '--reporter=json', ...nameArgs, ...(testFiles?.length ? target : [])]
    : ['--experimental-test-module-mocks', '--test', '--test-reporter=spec', ...nameArgs, ...target];
  const res = await runCommand(command, frontend ? FRONTEND : BACKEND, timeoutMs);
  const out = `${res.stdout || ''}${res.stderr || ''}`;
  // A run the clock ended says nothing about the tests (the JSON/spec output is cut off mid-way), so it is
  // reported as its own thing and never parsed as a pass or a fail.
  if (res.hung) return { failed: true, cancelled: 0, ran: 0, out, hung: true };
  if (frontend) {
    // Vitest's JSON counts completed assertions. Startup failures or missing reports must be
    // ERROR, not a spurious kill; use the same no-tests-ran guard as the backend runner.
    let report;
    try { report = JSON.parse(res.stdout); } catch { return { failed: true, cancelled: 0, ran: 0, out }; }
    return {
      failed: res.status !== 0 || !report.success,
      cancelled: 0,
      ran: report.numPassedTests + report.numFailedTests,
      out,
    };
  }
  const num = (label) => Number(new RegExp(`^ℹ ${label} (\\d+)$`, 'm').exec(out)?.[1] ?? 0);
  // ⚠️ A `--test-name-pattern` that matches nothing SKIPS every test and exits 0, which would be
  // recorded as "the mutant survived" — the same lie as a mutant that never applied, arriving from the
  // other end. `ran` is what makes that detectable.
  return { failed: res.status !== 0, cancelled: num('cancelled'), ran: num('pass') + num('fail'), out };
}

const results = [];
let harnessBroken = false;

for (const m of mutants) {
  const abs = path.join(REPO, m.file);
  // Bytes, not text: these files are CRLF and a text round-trip through anything that normalises
  // newlines would rewrite the whole file and make the restore check meaningless.
  const original = readFileSync(abs);
  const text = original.toString('utf8');

  const hits = text.split(m.find).length - 1;
  if (hits !== 1) {
    console.error(`ABORT: "${m.label}" — its \`find\` matches ${hits} times in ${m.file}, expected exactly 1.`);
    console.error('        The source has moved. Fix the catalogue entry; do NOT interpret this run.');
    process.exit(3);
  }

  const mutated = Buffer.from(text.replace(m.find, m.replace), 'utf8');
  if (mutated.equals(original)) {
    console.error(`ABORT: "${m.label}" — applying it changed nothing (find === replace?).`);
    process.exit(3);
  }

  let verdict;
  try {
    applied = { abs, original }; // before the write, so a signal at any point after it can undo it
    writeFileSync(abs, mutated);
    // Re-read from disk rather than trusting the write: this is the "the mutant never applied" guard,
    // and the whole point is not to trust that a step did what it said.
    if (!readFileSync(abs).equals(mutated)) throw new Error('the mutated file on disk does not match what was written');
    const timeoutMs = Number(cliTimeout) || m.timeoutMs || DEFAULT_TIMEOUT_MS;
    const { failed, cancelled, ran, hung } = await runTests(m.tests && !flag('full') ? m.tests : null, flag('full') ? null : m.namePattern, m.file.startsWith('frontend/'), timeoutMs);
    verdict = hung ? 'HANG' : cancelled > 0 || ran === 0 ? 'ERROR' : failed ? 'KILLED' : 'SURVIVED';
    if (ran === 0 && !hung) console.error(`        (no tests ran — check \`tests\`/\`namePattern\` for "${m.label}")`);
  } finally {
    writeFileSync(abs, original);
    applied = null;
    if (!readFileSync(abs).equals(original)) {
      console.error(`\n★★★ RESTORE FAILED for ${m.file} — the working tree is NOT clean. Restore it by hand.`);
      process.exit(4);
    }
  }

  // `expect` has three values, and the third one earns its place. "equivalent" marks a mutant that
  // changes the source but provably cannot change behaviour — a redundant fast-path guard, a bound
  // already enforced by the line under it. Mutation literature calls these equivalent mutants and they
  // are the standard false positive of the technique: no test can kill one, so recording it as an
  // unexplained survivor is worse than useless — it is the noise that makes people stop reading the
  // report. Each one carries a `note` saying WHY it cannot matter, which is a claim the next person
  // can check.
  const expected = m.expect === 'killed' ? 'KILLED' : 'SURVIVED';
  // A HANG is a kill (the mutant did not survive) but a weaker one, so it satisfies `expect: "killed"` and
  // is called out in the summary. For a control or an equivalent mutant it is just as damning as a KILLED:
  // a comment edit cannot hang the suite, and an equivalent mutant cannot change behaviour.
  const dead = verdict === 'KILLED' || verdict === 'HANG';
  const ok = verdict === expected || (expected === 'KILLED' && dead);
  if (m.expect === 'survives' && dead) harnessBroken = true;
  if (m.expect === 'equivalent' && dead) {
    console.error(`        NOTE: "${m.label}" was declared equivalent but a test KILLED it — the note is wrong.`);
  }
  results.push({ ...m, verdict, ok });
  console.log(`${ok ? ' ok ' : '★★★ '}${verdict.padEnd(8)} ${m.label}`);
}

console.log('');
if (harnessBroken) {
  console.error('★★★ A CONTROL MUTANT WAS KILLED. The harness is not measuring what it claims —');
  console.error('    a comment edit cannot break the suite. EVERY result above is void.');
  process.exit(5);
}
const survivors = results.filter((r) => r.expect === 'killed' && r.verdict === 'SURVIVED');
const errored = results.filter((r) => r.verdict === 'ERROR');
const hangs = results.filter((r) => r.verdict === 'HANG');
console.log(`${results.length} mutants, ${results.filter((r) => r.verdict === 'KILLED').length + hangs.length} killed ` +
  `(${hangs.length} of them by timeout), ` +
  `${survivors.length} survived unexpectedly, ${errored.length} errored, ` +
  `${results.filter((r) => r.expect === 'equivalent').length} known-equivalent, ` +
  `${results.filter((r) => r.expect === 'survives' && r.verdict === 'SURVIVED').length} control(s) correctly survived.`);
for (const s of survivors) console.log(`  SURVIVED: ${s.label}${s.note ? ` — ${s.note}` : ''}`);
for (const h of hangs) console.log(`  HANG (killed by the clock, not by an assertion — a weaker kill, look at it): ${h.label}`);
for (const e of errored) console.log(`  ERRORED (cancelled test files, result unusable): ${e.label}`);
process.exit(survivors.length || errored.length ? 1 : 0);
