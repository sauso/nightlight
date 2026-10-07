// The mutation harness must not be able to hang, and must be able to say its catalogue has drifted
// (issues #617 and #575).
//
// WHAT HAPPENED (#617, 2026-10-06): a hand-written mutant turned a loop into an infinite one. The harness
// waited on the test child forever, the child kept burning CPU for ~25 minutes after the run was abandoned,
// and the source file stayed mutated, so the NEXT run aborted with a "find matches 0 times" that looked like
// a catalogue problem. #575: four catalogue anchors had drifted, and the only way to find out was to start a
// full run and wait for it to reach them.
//
// ⚠️ NO MOCKS, AND NOT THE REAL SOURCE. Every case copies the real harness into a throwaway tree with a tiny
// fixture module, runs it as a real child process, and checks real processes and real bytes. A fake child
// would pass against a harness that kills only the direct child, which is exactly the bug: `node --test`
// runs each file in a grandchild, and the grandchild is the one that spins. The fixture tree is also why this
// file is safe under a `--full` mutation pass: it never reads the repo's own mutated source.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REAL_HARNESS = path.join(HERE, '..', '..', 'scripts', 'mutate.mjs');

// `count(3)` returns 0. The loop mutant turns `i--` into `i++`, after which `i > 0` is true forever.
const SPIN_SRC = [
  'export function count(n) {',
  '  let i = n;',
  '  while (i > 0) i--;',
  '  // control: editing this comment cannot change behaviour',
  '  return i;',
  '}',
  '',
].join('\n');
// The pid file is written BEFORE the assertion, so even a run that never finishes leaves the pid of the
// grandchild that is spinning, which is the process the test then proves was killed.
const SPIN_TEST = [
  "import { test } from 'node:test';",
  "import assert from 'node:assert/strict';",
  "import fs from 'node:fs';",
  "import { count } from '../src/spin.js';",
  "test('count terminates and reaches zero', () => {",
  "  fs.writeFileSync(process.env.SPIN_PID_FILE, String(process.pid));",
  '  assert.equal(count(3), 0);',
  '});',
  '',
].join('\n');
// A second module with an ordinary assertion failure, so the run has something to do AFTER the hang.
const ADD_SRC = ['export function add(a, b) {', '  return a + b;', '}', ''].join('\n');
const ADD_TEST = [
  "import { test } from 'node:test';",
  "import assert from 'node:assert/strict';",
  "import { add } from '../src/add.js';",
  "test('add adds', () => { assert.equal(add(2, 3), 5); });",
  '',
].join('\n');

let root;

// Build a tree shaped like the repo (scripts/, backend/src, backend/test) around a copy of the real harness.
// The catalogue is a parameter so each case states exactly what it feeds the harness.
function buildTree(catalogue) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-mutate-'));
  for (const sub of ['scripts', 'backend/src', 'backend/test']) fs.mkdirSync(path.join(dir, sub), { recursive: true });
  fs.copyFileSync(REAL_HARNESS, path.join(dir, 'scripts', 'mutate.mjs'));
  fs.writeFileSync(path.join(dir, 'scripts', 'mutants.json'), JSON.stringify(catalogue, null, 2));
  // ESM `.js` files: without "type": "module" an older Node reads the fixture as CommonJS and every test file
  // fails to load, which would read as a KILLED mutant and make the HANG case pass or fail for the wrong reason.
  fs.writeFileSync(path.join(dir, 'backend/package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(dir, 'backend/src/spin.js'), SPIN_SRC);
  fs.writeFileSync(path.join(dir, 'backend/test/spin.test.js'), SPIN_TEST);
  fs.writeFileSync(path.join(dir, 'backend/src/add.js'), ADD_SRC);
  fs.writeFileSync(path.join(dir, 'backend/test/add.test.js'), ADD_TEST);
  return dir;
}

function runHarness(dir, extraArgs = [], env = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [path.join(dir, 'scripts', 'mutate.mjs'), ...extraArgs], {
      cwd: dir, env: { ...process.env, ...env }, windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    // A harness that has regressed to waiting forever must fail THIS test, not hang the whole suite.
    const bail = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 90 * 1000);
    child.on('close', (code) => { clearTimeout(bail); resolve({ code, stdout, stderr, ms: Date.now() - started }); });
  });
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
async function waitDead(pid, ms = 5000) {
  const end = Date.now() + ms;
  while (alive(pid) && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
  return !alive(pid);
}

const LOOP_MUTANT = {
  label: 'fixture: the loop never ends',
  file: 'backend/src/spin.js',
  find: '  while (i > 0) i--;',
  replace: '  while (i > 0) i++;',
  expect: 'killed',
  tests: ['spin.test.js'],
  // Short on purpose: the test must observe the limit firing, not wait out the 5-minute default.
  timeoutMs: 2000,
};
const ADD_MUTANT = {
  label: 'fixture: add subtracts',
  file: 'backend/src/add.js',
  find: '  return a + b;',
  replace: '  return a - b;',
  expect: 'killed',
  tests: ['add.test.js'],
};
const CONTROL = {
  label: 'fixture: control (comment edit)',
  file: 'backend/src/spin.js',
  find: '  // control: editing this comment cannot change behaviour',
  replace: '  // control: edited',
  expect: 'survives',
  tests: ['spin.test.js'],
};

const trees = [];
const mk = (catalogue) => { const d = buildTree(catalogue); trees.push(d); return d; };
before(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-mutate-pids-')); });
after(() => {
  for (const d of [...trees, root]) fs.rmSync(d, { recursive: true, force: true });
});

describe('#617 a mutant that loops forever', () => {
  test('is reported HANG within its limit, its whole process tree is killed, and the source is restored', async () => {
    const dir = mk([LOOP_MUTANT, ADD_MUTANT, CONTROL]);
    const pidFile = path.join(root, 'spin.pid');
    const spinBefore = fs.readFileSync(path.join(dir, 'backend/src/spin.js'));
    const beforeAdd = fs.readFileSync(path.join(dir, 'backend/src/add.js'));

    const res = await runHarness(dir, [], { SPIN_PID_FILE: pidFile });

    // " ok " at the start of the line, not the "★★★" a surprise gets: for an `expect: killed` mutant a HANG
    // is an accepted kill. The exit code does not depend on this marker, so only the line itself can pin it.
    assert.match(res.stdout, /^ ok HANG\s+fixture: the loop never ends/m, `no accepted HANG verdict in:\n${res.stdout}\n${res.stderr}`);
    // The run went ON after the hang: the next mutant was scored, and the control survived as it must.
    assert.match(res.stdout, /KILLED\s+fixture: add subtracts/);
    assert.match(res.stdout, /SURVIVED\s+fixture: control/);
    // Counted as killed, but never silently: it is in the summary AND listed by name.
    assert.match(res.stdout, /3 mutants, 2 killed \(1 of them by timeout\)/);
    assert.match(res.stdout, /HANG \(killed by the clock[^)]*\): fixture: the loop never ends/);
    assert.equal(res.code, 0, `a HANG on an expect:killed mutant is a kill, so the run is clean; got ${res.code}:\n${res.stdout}\n${res.stderr}`);
    // The limit was 2 s: the whole run (three mutants, each spawning node) is nowhere near the 5 min default.
    assert.ok(res.ms < 60 * 1000, `took ${res.ms} ms`);

    assert.ok(fs.readFileSync(path.join(dir, 'backend/src/spin.js')).equals(spinBefore), 'spin.js was not restored byte-for-byte');
    assert.ok(fs.readFileSync(path.join(dir, 'backend/src/add.js')).equals(beforeAdd), 'add.js was not restored byte-for-byte');

    // The process that was actually spinning is the test file's own node, a GRANDCHILD of the harness. Killing
    // only the direct child leaves it running at 100% CPU, which is what happened on 2026-10-06.
    const spinPid = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.ok(Number.isInteger(spinPid) && spinPid > 0, `bad pid file: ${spinPid}`);
    assert.ok(await waitDead(spinPid), `the spinning test process ${spinPid} is still running after the harness exited`);
  });

  test('a HANG does not satisfy a control: a comment edit cannot hang a suite, so the harness is void', async () => {
    // The control's test file is spin.test.js, so a control that hangs means the harness itself is hanging
    // rather than measuring anything; it must exit 5 like a KILLED control, never report a clean run.
    const hungControl = { ...CONTROL, label: 'fixture: control that hangs', find: '  while (i > 0) i--;', replace: '  while (i > 0) i++;', timeoutMs: 2000 };
    const dir = mk([hungControl]);
    const res = await runHarness(dir, [], { SPIN_PID_FILE: path.join(root, 'ctl.pid') });
    assert.equal(res.code, 5, `expected the harness-broken exit; got ${res.code}:\n${res.stdout}\n${res.stderr}`);
    assert.match(res.stdout + res.stderr, /A CONTROL MUTANT WAS KILLED/);
  });

  test('--timeout overrides the entry limit (a slow machine can raise it without editing the catalogue)', async () => {
    // Entry says 2 s; the flag says 1 ms. A 1 ms limit cannot be met by a node child that must start up,
    // so even the well-behaved mutant hangs. Without the override it would be KILLED.
    const dir = mk([{ ...ADD_MUTANT, timeoutMs: 60000 }]);
    const res = await runHarness(dir, ['--timeout=1']);
    assert.match(res.stdout, /HANG\s+fixture: add subtracts/);
    const ok = await runHarness(dir);
    assert.match(ok.stdout, /KILLED\s+fixture: add subtracts/);
  });

  test('a bad --timeout is refused rather than read as "no limit"', async () => {
    const dir = mk([ADD_MUTANT]);
    for (const bad of ['--timeout=0', '--timeout=abc', '--timeout=-5']) {
      const res = await runHarness(dir, [bad]);
      assert.equal(res.code, 2, `${bad} should be refused`);
      assert.match(res.stderr, /--timeout must be a positive number/);
    }
  });
});

describe('#575 --check finds drifted anchors without running a test', () => {
  test('a clean catalogue passes and touches nothing', async () => {
    const dir = mk([ADD_MUTANT, CONTROL]);
    const pidFile = path.join(root, 'check-clean.pid');
    const res = await runHarness(dir, ['--check'], { SPIN_PID_FILE: pidFile });
    assert.equal(res.code, 0, `${res.stdout}\n${res.stderr}`);
    assert.match(res.stdout, /2 catalogue entries, 0 that would not apply/);
    assert.equal(fs.existsSync(pidFile), false, '--check ran a test');
  });

  test('names every entry that matches zero times, twice, or changes nothing, then exits non-zero', async () => {
    const stale = { ...ADD_MUTANT, label: 'fixture: stale anchor', find: '  return a + b + 0;' };
    const twice = { ...ADD_MUTANT, label: 'fixture: ambiguous anchor', find: 'a' };
    const noop = { ...ADD_MUTANT, label: 'fixture: no-op', replace: ADD_MUTANT.find };
    const gone = { ...ADD_MUTANT, label: 'fixture: deleted file', file: 'backend/src/deleted.js' };
    const dir = mk([ADD_MUTANT, stale, twice, noop, gone]);
    const res = await runHarness(dir, ['--check']);
    assert.equal(res.code, 3, `${res.stdout}\n${res.stderr}`);
    assert.match(res.stderr, /STALE: "fixture: stale anchor" — its `find` matches 0 times/);
    assert.match(res.stderr, /STALE: "fixture: ambiguous anchor" — its `find` matches 3 times/);
    assert.match(res.stderr, /STALE: "fixture: no-op" — find === replace/);
    assert.match(res.stderr, /STALE: "fixture: deleted file" — cannot read backend\/src\/deleted\.js/);
    // The one good entry is not named, and the count says 4 of 5 are bad.
    assert.doesNotMatch(res.stderr, /add subtracts/);
    assert.match(res.stdout, /5 catalogue entries, 4 that would not apply/);
  });

  test('checks the WHOLE catalogue even when --only narrows a run', async () => {
    const stale = { ...ADD_MUTANT, label: 'fixture: stale anchor', find: 'no such text' };
    const dir = mk([ADD_MUTANT, stale]);
    const res = await runHarness(dir, ['--check', '--only=add subtracts']);
    assert.equal(res.code, 3, 'a stale entry outside the --only filter must still fail --check');
  });
});
