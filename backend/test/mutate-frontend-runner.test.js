// The mutation harness must read the FRONTEND suite's verdict from where vitest 5 actually puts it (issue #520).
//
// WHAT HAPPENED (#520, found by three people independently while building #519): scripts/mutate.mjs ran
// `vitest run --reporter=json` and parsed stdout. vitest 5.0.1 does not print that report any more: with no
// output target the JSON reporter writes `frontend/.vitest/json/output.json` and prints one line,
// "JSON report written to ...". `JSON.parse(stdout)` therefore threw for every run, and all 103 frontend
// mutants in the catalogue ended ERROR whatever the mutation did, while the 1262 backend mutants in the same
// invocation scored normally. Mutation testing is what shows a test discriminates; for the whole frontend suite
// that guarantee had silently gone, and the only sign was reading each per-mutant line.
//
// ⚠️ A FAKE vitest, and why that is right HERE (the backend harness tests use no mocks, see
// mutate-harness.test.js). What these cases pin is the harness's contract with vitest's reporter: which flag it
// passes, where it reads the report back from, and what it does when the report is absent or wrong. The fake
// reproduces the one measured behaviour that broke us (report to a FILE, a status line on stdout, nothing
// else), and it is hostile in the ways a real run can be: it writes NOTHING when asked to, writes a report of
// the wrong shape, and writes a stale-looking default file. The real vitest is exercised by running the
// frontend slice of the catalogue (the PR body gives the numbers); a unit suite that needed the frontend's
// node_modules installed would not run in the backend-only CI job.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildTree, cleanupTrees, runHarness } from './helpers/mutateFixture.js';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-mutate-fe-'));
after(() => { cleanupTrees(); fs.rmSync(scratch, { recursive: true, force: true }); });

const UI_SRC = ['export function answer() {', '  return 1;', '}', '// control: editing this comment changes nothing', ''].join('\n');

// What `vitest run --reporter=json [--outputFile=X] [files]` does on 5.0.1, as far as the harness can see it:
//   - the report is NOT on stdout; stdout gets "JSON report written to <path>";
//   - with `--outputFile=X` the report goes to X, without it to `.vitest/json/output.json` under the cwd;
//   - exit status 1 when a test failed.
// The "test" is `answer() === 1`, so the catalogue's mutant (`return 2`) fails it and a comment edit does not.
// FAKE_VITEST_MODE picks the hostile variant; FAKE_VITEST_LOG records every --outputFile it was given.
const FAKE_VITEST = [
  "import fs from 'node:fs';",
  "import path from 'node:path';",
  "import { answer } from '../../src/ui.js';",
  "const mode = process.env.FAKE_VITEST_MODE || 'normal';",
  "const arg = process.argv.find((a) => a.startsWith('--outputFile='));",
  "const outputFile = arg ? arg.slice('--outputFile='.length) : null;",
  'if (outputFile && process.env.FAKE_VITEST_LOG) fs.appendFileSync(process.env.FAKE_VITEST_LOG, outputFile + "\\n");',
  'const failed = answer() !== 1 ? 1 : 0;',
  'const report = { success: !failed, numPassedTests: failed ? 0 : 1, numFailedTests: failed };',
  "let target = outputFile ?? path.join('.vitest', 'json', 'output.json');",
  "let body = JSON.stringify(report);",
  // 'silent': the run produced no report at all (a crash before the reporter, a config the mutant broke).
  "if (mode === 'silent') target = null;",
  // 'first-only': only the FIRST invocation of the run writes a report, so a harness that reads a fixed path
  // would read invocation 1's report as invocation 2's verdict.
  "if (mode === 'first-only') {",
  "  const marker = process.env.FAKE_VITEST_LOG + '.seen';",
  '  if (fs.existsSync(marker)) target = null; else fs.writeFileSync(marker, "1");',
  '}',
  // 'shape': a report whose counts are not where the harness looks (a vitest that renamed its fields).
  "if (mode === 'shape') body = JSON.stringify({ success: !failed, tests: { passed: 1 } });",
  'if (target) {',
  '  fs.mkdirSync(path.dirname(target), { recursive: true });',
  '  fs.writeFileSync(target, body);',
  '  console.log(`JSON report written to ${target.replace(/\\\\/g, "/")}`);',
  '}',
  'process.exit(failed ? 1 : 0);',
  '',
].join('\n');

const MUTANT = {
  label: 'fixture: answer is two', file: 'frontend/src/ui.js', find: '  return 1;', replace: '  return 2;',
  expect: 'killed', tests: ['ui.test.jsx'],
};
const CONTROL = {
  label: 'fixture: comment edit', file: 'frontend/src/ui.js',
  find: '// control: editing this comment changes nothing', replace: '// control: edited', expect: 'survives', tests: ['ui.test.jsx'],
};
const files = {
  'frontend/package.json': '{"type":"module"}',
  'frontend/src/ui.js': UI_SRC,
  'frontend/test/ui.test.jsx': "// the fake vitest does not read this\n",
  'frontend/node_modules/vitest/vitest.mjs': FAKE_VITEST,
};

describe('#520 the frontend verdict comes from vitest 5\'s report file', () => {
  test('a mutant the test catches is KILLED and a comment edit SURVIVES (both were ERROR before the fix)', async () => {
    const dir = buildTree([MUTANT, CONTROL], files);
    const r = await runHarness(dir, [], { FAKE_VITEST_LOG: path.join(scratch, 'normal.log') });
    assert.match(r.stdout, /KILLED\s+fixture: answer is two/, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
    assert.match(r.stdout, /SURVIVED\s+fixture: comment edit/, r.stdout);
    assert.doesNotMatch(r.stdout, /ERROR/, 'no frontend mutant may end ERROR on a working vitest');
    assert.equal(r.code, 0, `the run must be clean: ${r.stderr}`);
  });

  test('the report is written under the OS temp dir, a new one per run, and removed afterwards', async () => {
    const dir = buildTree([MUTANT, CONTROL], files);
    const log = path.join(scratch, 'paths.log');
    await runHarness(dir, [], { FAKE_VITEST_LOG: log });
    const paths = fs.readFileSync(log, 'utf8').trim().split('\n');
    assert.equal(paths.length, 2, 'one vitest run per mutant, each given an --outputFile');
    assert.notEqual(paths[0], paths[1], 'a fixed path would let one mutant be judged on the previous mutant\'s report');
    for (const p of paths) {
      assert.ok(path.resolve(p).startsWith(path.resolve(os.tmpdir())), `${p} is not under the OS temp dir`);
      assert.equal(fs.existsSync(path.dirname(p)), false, `${path.dirname(p)} was left behind`);
    }
    assert.equal(fs.existsSync(path.join(dir, 'frontend', '.vitest')), false,
      'nothing may be written into the checkout (vitest\'s default target is frontend/.vitest/json/output.json)');
  });

  test('a run that wrote no report is ERROR, never SURVIVED', async () => {
    const dir = buildTree([CONTROL], files);
    const r = await runHarness(dir, [], { FAKE_VITEST_MODE: 'silent', FAKE_VITEST_LOG: path.join(scratch, 'silent.log') });
    assert.match(r.stdout, /ERROR\s+fixture: comment edit/, r.stdout);
    assert.doesNotMatch(r.stdout, /SURVIVED\s+fixture/, 'a missing report is not a surviving mutant');
    assert.equal(r.code, 1);
  });

  test('a report is never carried over from the previous mutant', async () => {
    // Invocation 1 (the mutant) writes a report; invocation 2 (the control) writes none. A harness that read a
    // fixed location would take invocation 1's report (failed) as 2's, and the control would read KILLED, which
    // the harness treats as "every result is void". The right reading is ERROR.
    const dir = buildTree([MUTANT, CONTROL], files);
    const r = await runHarness(dir, [], { FAKE_VITEST_MODE: 'first-only', FAKE_VITEST_LOG: path.join(scratch, 'first.log') });
    assert.match(r.stdout, /KILLED\s+fixture: answer is two/, r.stdout);
    assert.match(r.stdout, /ERROR\s+fixture: comment edit/, r.stdout);
    assert.doesNotMatch(r.stdout + r.stderr, /CONTROL MUTANT WAS KILLED/);
  });

  test('a report without numeric counts is ERROR (NaN === 0 is false, so it would otherwise slip through)', async () => {
    const dir = buildTree([CONTROL], files);
    const r = await runHarness(dir, [], { FAKE_VITEST_MODE: 'shape', FAKE_VITEST_LOG: path.join(scratch, 'shape.log') });
    assert.match(r.stdout, /ERROR\s+fixture: comment edit/, r.stdout);
    assert.doesNotMatch(r.stdout, /SURVIVED\s+fixture/, 'an unreadable report must not be scored as a survivor');
  });
});
