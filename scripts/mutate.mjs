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
//   node scripts/mutate.mjs --check         # run NO tests: only verify every `find` still matches exactly once and every
//                                           # `namePattern` still matches a test in the files it names (a few seconds; the
//                                           # way to find stale anchors before a full run, #575, #604). CI runs it via
//                                           # backend/test/mutants-catalogue.test.js, so a drifted entry fails at PR time.
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
//   5. **A killed run leaves a mutant in the source** (#599: three times in one afternoon, and the diffs look
//      like plausible edits, so they are easy to commit). Guarded in three layers: (a) SIGINT/SIGTERM/SIGHUP
//      restore the file and the whole test process tree before exiting; (b) BEFORE a mutant is written, the
//      original bytes go to an on-disk journal (`.mutate-restore.json`, gitignored), so even a SIGKILL, a
//      power cut or a Windows hard-kill (Windows cannot deliver SIGTERM to a handler at all) is undone by the
//      NEXT run, which restores from the journal before it does anything else; (c) the normal `finally`.
//
//   6. **The mutant ran no test, or a test the catalogue names no longer exists.** A `namePattern` that
//      matches nothing makes `node --test` skip every test and exit 0, which used to be recorded as SURVIVED
//      (#604: a renamed test made four old mutants "survive" while all four were killed on the parent
//      commit). A run that executed zero tests and did not fail now ABORTS, like a stale `find`.
//
// A mutant is KILLED if the chosen tests fail with it applied. SURVIVED means the suite cannot tell
// the mutated code from the real code — that is the finding, and it needs either a new test or a
// written reason why it does not matter.
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
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

// The restore journal (#599). It exists ONLY while a mutant is on disk, so its presence at startup means a
// previous run died between "write the mutant" and "write the original back". One per checkout, not per run:
// two runs against the same tree would corrupt each other's results anyway, and recoverFromJournal() refuses
// to start while the run that wrote it is still alive.
const JOURNAL = path.join(HERE, '.mutate-restore.json');

// Line endings (#597). The checked-in catalogue was written on Windows, where the working tree is CRLF, so 135
// multi-line `find` strings carry `\r\n`; CI (Linux) and anyone with `core.autocrlf=false` have LF files, where
// those strings match nothing, and a stale-looking entry aborted the whole run. A `find` and its `replace` are
// therefore written in either style and converted to whichever the FILE uses before matching. The file keeps its
// own endings (the replacement is spliced in verbatim), which is what the byte-for-byte restore check relies on.
const adaptEol = (s, eol) => s.replace(/\r\n/g, '\n').replace(/\n/g, eol);
function adaptToFile(text, m) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  return { find: adaptEol(m.find, eol), replace: adaptEol(m.replace, eol) };
}

// --- namePattern verification (#604) ---------------------------------------------------------------------
// `node --test --test-name-pattern=X` matches X (a RegExp; `/x/i` is also accepted) against a test's name, and
// a nested test is also matched on its ancestors' names, so a `describe` title can select its children.
// Reading the names out of the source is deliberately approximate: it over-accepts (every describe+test pair
// in a file is a candidate) and it gives up on files that build names at run time, because a false alarm here
// would block CI, while a real stale pattern is still caught at run time by the `ran === 0` abort below.
function patternToRegExp(pattern, frontend) {
  const slashed = /^\/(.*)\/([a-z]*)$/s.exec(pattern);
  const flags = (slashed ? slashed[2] : '') + (frontend && !/i/.test(slashed?.[2] ?? '') ? 'i' : '');
  return new RegExp(slashed ? slashed[1] : pattern, flags);
}
const LITERAL = { "'": /'((?:\\.|[^'\\\n])*)'/y, '"': /"((?:\\.|[^"\\\n])*)"/y, '`': /`((?:\\.|[^`\\])*)`/y };
function testNamesIn(text) {
  const tests = [];
  const suites = [];
  let dynamic = false;
  const call = /\b(test|it|describe|suite)(?:\.\w+)?\(\s*/g;
  let hit;
  while ((hit = call.exec(text))) {
    const quote = text[call.lastIndex];
    const literal = LITERAL[quote];
    if (!literal) { dynamic = true; continue; } // `test(name, ...)`, `test.each(...)(...)`: the name is not in the source
    literal.lastIndex = call.lastIndex;
    const name = literal.exec(text);
    if (!name) { dynamic = true; continue; }
    const into = hit[1] === 'describe' || hit[1] === 'suite' ? suites : tests;
    if (name[1].includes('${')) {
      // A title with holes (`burst boundary: ${n} of 300`) is not a name, but its literal pieces are what a
      // pattern is written against. Offer each piece, and the pieces run together, as candidates.
      dynamic = true;
      const pieces = name[1].split(/\$\{[^}]*\}/).filter((p) => p.trim());
      into.push(pieces.join(''), ...pieces);
      continue;
    }
    into.push(name[1]);
  }
  return { tests, suites, dynamic };
}
// Patterns accepted without proof because a file they name builds some test titles at run time (counted so --check can say so).
let unverifiedPatterns = 0;
function namePatternProblem(m, cache) {
  if (!m.namePattern) return null;
  const frontend = m.file.startsWith('frontend/');
  const dir = path.join(frontend ? FRONTEND : BACKEND, 'test');
  let re;
  try { re = patternToRegExp(m.namePattern, frontend); } catch (e) {
    return `its namePattern is not a valid regular expression (${e.message})`;
  }
  const files = m.tests?.length ? m.tests : readdirSync(dir).filter((f) => /\.test\.jsx?$/.test(f));
  let unverifiable = false;
  for (const f of files) {
    if (!cache.has(f + frontend)) {
      try { cache.set(f + frontend, testNamesIn(readFileSync(path.join(dir, f), 'utf8'))); } catch (e) {
        cache.set(f + frontend, { missing: e.code || e.message });
      }
    }
    const info = cache.get(f + frontend);
    if (info.missing) return `the test file ${path.join(frontend ? 'frontend' : 'backend', 'test', f)} cannot be read (${info.missing})`;
    const candidates = [...info.tests, ...info.suites, ...info.suites.flatMap((s) => info.tests.map((t) => `${s} ${t}`))];
    if (candidates.some((c) => re.test(c))) return null;
    if (info.dynamic) unverifiable = true;
  }
  if (unverifiable) { unverifiedPatterns++; return null; }
  return `its namePattern ${JSON.stringify(m.namePattern)} matches no test name in ${files.join(', ')}`;
}

if (flag('list')) {
  for (const m of catalogue) console.log(`${m.expect === 'survives' ? 'CONTROL ' : '        '}${m.label}  [${m.file}]`);
  process.exit(0);
}
// --check applies the same "does this mutant apply at all" rules the run enforces, to the WHOLE catalogue
// and without running a single test. Before this, a stale anchor was only discovered when the full run
// reached it, which aborted everything after it (#575: four entries had drifted unnoticed). Files are read
// as bytes and `find` is matched as text, exactly as below, so the two cannot disagree.
if (flag('check')) {
  if (existsSync(JOURNAL)) {
    // A mutant may be on disk right now (a run in progress, or one that was killed): every `find` below would
    // then be judged against mutated text. Say so rather than report phantom drift.
    console.error(`WARNING: ${path.relative(REPO, JOURNAL)} exists, so a source file may currently be mutated. ` +
      'A normal run restores it; until then --check can report drift that is not real.');
  }
  let bad = 0;
  const cache = new Map();
  for (const m of catalogue) {
    const problems = [];
    try {
      const text = readFileSync(path.join(REPO, m.file)).toString('utf8');
      const { find, replace } = adaptToFile(text, m);
      const hits = text.split(find).length - 1;
      if (hits !== 1) problems.push(`its \`find\` matches ${hits} times in ${m.file}, expected exactly 1`);
      else if (find === replace) problems.push('find === replace, applying it changes nothing');
    } catch (e) {
      problems.push(`cannot read ${m.file} (${e.code || e.message})`);
    }
    // #604: the mirror image of a stale `find`. A pattern that selects no test makes the run report SURVIVED
    // from a no-op; a pattern that selects only a decoy reports KILLED for the wrong reason (that one needs a
    // human, this only catches the first). Static, so it needs no test run and cannot be fooled by the mutant.
    const patternProblem = namePatternProblem(m, cache);
    if (patternProblem) problems.push(patternProblem);
    for (const problem of problems) console.error(`STALE: "${m.label}" — ${problem}.`);
    if (problems.length) bad++;
  }
  console.log(`${catalogue.length} catalogue entries, ${bad} that would not apply.`);
  if (unverifiedPatterns) {
    console.log(`(${unverifiedPatterns} namePatterns could not be proved statically: their test files build titles at run time. A stale one ` +
      'still aborts the run: it runs no test.)');
  }
  process.exit(bad ? 3 : 0);
}
// Before anything reads a source file: undo what a previous, killed run left behind (#599). Ahead of the
// `--only` check on purpose: a typo in the filter must not leave a mutated file lying around.
recoverFromJournal();
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

// The journal is written BEFORE the mutant, never after: a process killed between the two steps would
// otherwise leave a mutated file with nothing recording the original. Temp file + rename, so a kill during the
// write cannot leave a half-written journal that the next run then refuses to read.
function writeJournal(abs, original) {
  const tmp = `${JOURNAL}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({
    pid: process.pid,
    file: path.relative(REPO, abs),
    startedAt: new Date().toISOString(),
    originalBase64: original.toString('base64'),
  }));
  renameSync(tmp, JOURNAL);
}
function dropJournal() {
  try { unlinkSync(JOURNAL); } catch { /* nothing to drop */ }
}

// Startup recovery (#599): a run that was SIGKILLed, hard-killed on Windows, or lost to a power cut cannot run
// any handler, so the journal is the only thing that knows a mutant is still on disk.
function recoverFromJournal() {
  if (!existsSync(JOURNAL)) return;
  let entry;
  try {
    entry = JSON.parse(readFileSync(JOURNAL, 'utf8'));
    if (typeof entry.file !== 'string' || typeof entry.originalBase64 !== 'string') throw new Error('unexpected shape');
  } catch (e) {
    console.error(`ABORT: ${path.relative(REPO, JOURNAL)} exists but cannot be read (${e.message}).`);
    console.error('        A source file may be mutated. Check `git diff`, restore by hand, then delete the journal.');
    process.exit(4);
  }
  if (Number.isInteger(entry.pid) && entry.pid > 0 && entry.pid !== process.pid) { // pid 0 or negative would signal a whole process group, so it is never "a live run"
    let alive = true;
    try { process.kill(entry.pid, 0); } catch (e) { alive = e.code === 'EPERM'; }
    if (alive) {
      // Restoring now would pull the file out from under a live run. (A reused pid looks the same; the message
      // says how to proceed.)
      console.error(`ABORT: another mutation run (pid ${entry.pid}) is writing mutants into this checkout.`);
      console.error(`        If that process is not a mutate.mjs run, delete ${path.relative(REPO, JOURNAL)} after checking \`git diff\`.`);
      process.exit(2);
    }
  }
  const abs = path.resolve(REPO, entry.file);
  // The journal is data on disk: never let it name a file outside this checkout.
  if (!abs.startsWith(REPO + path.sep)) {
    console.error(`ABORT: the restore journal names ${entry.file}, which is outside this checkout. Not touching it.`);
    process.exit(4);
  }
  const original = Buffer.from(entry.originalBase64, 'base64');
  const was = existsSync(abs) ? readFileSync(abs) : null;
  writeFileSync(abs, original);
  if (!readFileSync(abs).equals(original)) {
    console.error(`\n★★★ RESTORE FAILED for ${entry.file} from the journal — restore it by hand.`);
    process.exit(4);
  }
  dropJournal();
  console.error(`RECOVERED: ${entry.file} was left mutated by a run that died (pid ${entry.pid}, ${entry.startedAt}); ` +
    `${was && was.equals(original) ? 'it was already intact' : 'restored it from the journal'}.`);
}

// One place that undoes whatever is on disk, used by every way out that is not the normal `finally`.
function restoreApplied() {
  if (!applied) return null;
  const { abs, original } = applied;
  try { writeFileSync(abs, original); } catch { /* the journal is still there for the next run */ }
  let ok = false;
  try { ok = readFileSync(abs).equals(original); } catch { /* ditto */ }
  applied = null;
  if (ok) dropJournal();
  return { abs, ok };
}

// `detached` takes the children out of this terminal's foreground process group, so Ctrl-C no longer reaches
// them by itself; this is what stops a Ctrl-C leaving both a running test and a mutated source file behind.
// Windows delivers only SIGINT (Ctrl-C) and SIGHUP (console closed) to a handler; SIGTERM and a task-manager
// kill terminate the process outright, so there the journal is the only protection and the next run's
// recoverFromJournal() does the restore.
const SIGNALS = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };
function bail(signal) {
  killTree(currentChild);
  const restored = restoreApplied();
  if (restored) {
    console.error(`\n${signal}: ${restored.ok ? 'restored' : '★★★ COULD NOT RESTORE (the journal will, on the next run):'} ` +
      `${path.relative(REPO, restored.abs)} and stopped the test run.`);
  }
  process.exit(SIGNALS[signal]);
}
for (const signal of Object.keys(SIGNALS)) process.on(signal, () => bail(signal));

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
  // #520: vitest 5's `--reporter=json` no longer prints the report to stdout; with no target it writes
  // `frontend/.vitest/json/output.json` and prints only "JSON report written to ..." (measured on 5.0.1, which
  // made all 103 frontend mutants ERROR). So the report goes to a file we name: `--outputFile=<path>`, in a
  // directory made fresh for THIS run. Fresh matters: a fixed path would let a run that wrote nothing (a crash
  // before the reporter ran, a mutant that breaks the config) be read as the PREVIOUS mutant's report, which is
  // a stale verdict, the worst kind. The OS temp dir, not the checkout, so no stray directory is left behind
  // and a hard kill leaves nothing in the working tree to mistake for source (the journal covers that).
  const reportDir = frontend ? mkdtempSync(path.join(os.tmpdir(), 'nl-mutate-vitest-')) : null;
  const reportFile = frontend ? path.join(reportDir, 'report.json') : null;
  const command = frontend
    ? [path.join(FRONTEND, 'node_modules/vitest/vitest.mjs'), 'run', '--reporter=json', `--outputFile=${reportFile}`, ...nameArgs, ...(testFiles?.length ? target : [])]
    : ['--experimental-test-module-mocks', '--test', '--test-reporter=spec', ...nameArgs, ...target];
  try {
    const res = await runCommand(command, frontend ? FRONTEND : BACKEND, timeoutMs);
    const out = `${res.stdout || ''}${res.stderr || ''}`;
    // A run the clock ended says nothing about the tests (the JSON/spec output is cut off mid-way), so it is
    // reported as its own thing and never parsed as a pass or a fail.
    if (res.hung) return { failed: true, cancelled: 0, ran: 0, out, hung: true };
    if (frontend) {
      // Vitest's JSON counts completed assertions. Startup failures or a missing/garbled report must be
      // ERROR, not a spurious kill; use the same no-tests-ran guard as the backend runner. The counts are
      // checked to be numbers because `undefined + undefined` is NaN, and NaN === 0 is false: a report of the
      // wrong shape (a vitest that renamed its fields) would otherwise slip past the guard as SURVIVED or KILLED.
      let report;
      try { report = JSON.parse(readFileSync(reportFile, 'utf8')); } catch { return { failed: true, cancelled: 0, ran: 0, out }; }
      if (!Number.isFinite(report?.numPassedTests) || !Number.isFinite(report?.numFailedTests)) {
        return { failed: true, cancelled: 0, ran: 0, out };
      }
      return {
        failed: res.status !== 0 || !report.success,
        cancelled: 0,
        ran: report.numPassedTests + report.numFailedTests,
        out,
      };
    }
    return parseBackendRun(res, out);
  } finally {
    if (reportDir) rmSync(reportDir, { recursive: true, force: true });
  }
}

function parseBackendRun(res, out) {
  const num = (label) => Number(new RegExp(`^ℹ ${label} (\\d+)$`, 'm').exec(out)?.[1] ?? 0);
  // ⚠️ A `--test-name-pattern` that matches nothing SKIPS every test and exits 0, which would be
  // recorded as "the mutant survived" — the same lie as a mutant that never applied, arriving from the
  // other end. `ran` is what makes that detectable.
  // ⚠️ MEASURED on Node 24.18 (2026-10-09, while building #604): when the pattern selects nothing in a file,
  // node reports the FILE itself as one passing test ("✔ test/x.test.js (4ms)", `ℹ tests 1`, `ℹ pass 1`), so
  // `pass + fail` is never 0 and the check above would never fire. A file that DID run tests prints no such
  // line (only its suites and tests), and a file that failed to load prints "✖", which is a real failure and
  // stays counted. So each passing file-level line is an empty file, and is subtracted.
  const emptyFiles = (out.match(/^✔ \S+\.test\.[cm]?js \(\d/gm) || []).length;
  return { failed: res.status !== 0, cancelled: num('cancelled'), ran: Math.max(0, num('pass') + num('fail') - emptyFiles), out };
}

const results = [];
let harnessBroken = false;

for (const m of mutants) {
  const abs = path.join(REPO, m.file);
  // Bytes, not text: these files are CRLF and a text round-trip through anything that normalises
  // newlines would rewrite the whole file and make the restore check meaningless.
  const original = readFileSync(abs);
  const text = original.toString('utf8');

  const { find, replace } = adaptToFile(text, m);
  const hits = text.split(find).length - 1;
  if (hits !== 1) {
    console.error(`ABORT: "${m.label}" — its \`find\` matches ${hits} times in ${m.file}, expected exactly 1.`);
    console.error('        The source has moved. Fix the catalogue entry; do NOT interpret this run.');
    process.exit(3);
  }

  // A replacer FUNCTION, not the string: `String.replace` reads `$&`, `$1`, `$$` in a replacement string, and a
  // mutant such as `` `${x}` `` -> `` `$${x}` `` would be silently rewritten into something else.
  const mutated = Buffer.from(text.replace(find, () => replace), 'utf8');
  if (mutated.equals(original)) {
    console.error(`ABORT: "${m.label}" — applying it changed nothing (find === replace?).`);
    process.exit(3);
  }

  let verdict;
  let noTestsRan = false;
  try {
    writeJournal(abs, original);
    applied = { abs, original }; // before the write, so a signal at any point after it can undo it
    writeFileSync(abs, mutated);
    // Re-read from disk rather than trusting the write: this is the "the mutant never applied" guard,
    // and the whole point is not to trust that a step did what it said.
    if (!readFileSync(abs).equals(mutated)) throw new Error('the mutated file on disk does not match what was written');
    const timeoutMs = Number(cliTimeout) || m.timeoutMs || DEFAULT_TIMEOUT_MS;
    const { failed, cancelled, ran, hung } = await runTests(m.tests && !flag('full') ? m.tests : null, flag('full') ? null : m.namePattern, m.file.startsWith('frontend/'), timeoutMs);
    // #604: a run that executed ZERO tests and did not fail is not a result. Before this it was printed as
    // SURVIVED (the alarming verdict, from a no-op) next to a one-line stderr hint that a captured stdout never
    // shows. It means the catalogue has drifted from the tests (a renamed test, a `namePattern` that matches
    // nothing), exactly like a stale `find`, so it stops the run the same way. A run that FAILED with zero
    // tests (a test file that did not load, a missing file) stays ERROR: that is the mutant or the command
    // being broken, and the run can go on.
    noTestsRan = ran === 0 && !failed && !hung;
    verdict = hung ? 'HANG' : cancelled > 0 || ran === 0 ? 'ERROR' : failed ? 'KILLED' : 'SURVIVED';
    if (ran === 0 && !hung && !noTestsRan) console.error(`        (no tests ran — check \`tests\`/\`namePattern\` for "${m.label}")`);
  } finally {
    writeFileSync(abs, original);
    applied = null;
    if (!readFileSync(abs).equals(original)) {
      console.error(`\n★★★ RESTORE FAILED for ${m.file} — the working tree is NOT clean. Restore it by hand.`);
      process.exit(4); // the journal is deliberately left in place: the next run retries the restore
    }
    dropJournal();
  }
  if (noTestsRan) {
    console.error(`ABORT: "${m.label}" — it ran NO test (\`tests\`: ${JSON.stringify(m.tests ?? 'all')}, \`namePattern\`: ${JSON.stringify(m.namePattern ?? null)}).`);
    console.error('        The catalogue has moved from the tests. Fix the entry; do NOT interpret this run.');
    process.exit(3);
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
