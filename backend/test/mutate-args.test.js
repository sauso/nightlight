// The mutation script must refuse a command line it does not understand BEFORE it does anything (issue #654).
//
// WHAT HAPPENED (2026-10-10): `node scripts/mutate.mjs --help` was read as "no recognised flag, so run
// everything" and started the full battery, which writes mutants into real source files. When the pipe it was
// being read through closed, the run died mid-mutation and left backend/src/lib/clipStorage.js mutated on disk.
// A typo such as `--ful` or `--only` (no value) did the same.
//
// ⚠️ SAFE BY CONSTRUCTION. A regression here means "the script starts a battery", which is the very thing being
// tested for, so every case runs the REAL script copied into a throwaway fixture tree (helpers/mutateFixture.js)
// with a one-mutant catalogue over a tiny fixture module. If the guard disappears, the "battery" that starts
// mutates that fixture file for a second or two and the assertions below fail; the repo's own source is never
// reachable, and the run cannot take longer than the fixture's one test.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildTree, cleanupTrees, runHarness } from './helpers/mutateFixture.js';

after(() => cleanupTrees());

const ADD_SRC = ['export function add(a, b) {', '  return a + b;', '}', ''].join('\n');
const ADD_TEST = [
  "import { test } from 'node:test';",
  "import assert from 'node:assert/strict';",
  "import { add } from '../src/add.js';",
  "test('add adds', () => { assert.equal(add(2, 3), 5); });",
  '',
].join('\n');
const MUTANT = {
  label: 'fixture: add subtracts',
  file: 'backend/src/add.js',
  find: '  return a + b;',
  replace: '  return a - b;',
  expect: 'killed',
  tests: ['add.test.js'],
};
const JOURNAL = 'scripts/.mutate-restore.json';

function fixture() {
  const dir = buildTree([MUTANT], { 'backend/src/add.js': ADD_SRC, 'backend/test/add.test.js': ADD_TEST });
  return { dir, src: path.join(dir, 'backend/src/add.js') };
}

// What "did not start a battery" means, checked from the outside: the source file still has its original bytes,
// no restore journal was ever left behind, and nothing was printed that only a run prints.
function assertNothingRan(dir, src, res) {
  assert.equal(fs.readFileSync(src, 'utf8'), ADD_SRC, 'the source file was touched');
  assert.equal(fs.existsSync(path.join(dir, JOURNAL)), false, 'a restore journal exists, so a mutant was written');
  assert.doesNotMatch(res.stdout + res.stderr, /KILLED|SURVIVED|HANG|mutants? (run|tested)/i, `output looks like a battery ran:\n${res.stdout}\n${res.stderr}`);
}

describe('mutate.mjs command line (#654)', () => {
  for (const arg of ['--help', '-h']) {
    test(`${arg} prints the usage and exits 0 without touching anything`, async () => {
      const { dir, src } = fixture();
      const res = await runHarness(dir, [arg]);
      assert.equal(res.code, 0, `${res.stdout}\n${res.stderr}`);
      assert.match(res.stdout, /usage: node scripts\/mutate\.mjs/);
      // Every documented flag is in the usage, so it cannot drift from the parser without this noticing.
      for (const f of ['--full', '--only=', '--timeout=', '--list', '--check', '--help']) assert.ok(res.stdout.includes(f), `usage does not mention ${f}`);
      assertNothingRan(dir, src, res);
    });
  }

  for (const arg of ['--bogus', '--ful', '--only', '--timeout', '--only=', '--timeout=', '--full=1', '--help=1', 'full', '-x']) {
    test(`${JSON.stringify(arg)} exits 2 naming the argument, with the usage, before touching anything`, async () => {
      const { dir, src } = fixture();
      const res = await runHarness(dir, [arg]);
      assert.equal(res.code, 2, `${res.stdout}\n${res.stderr}`);
      assert.ok(res.stderr.includes(arg), `the message does not name ${arg}:\n${res.stderr}`);
      assert.match(res.stderr, /usage: node scripts\/mutate\.mjs/);
      assertNothingRan(dir, src, res);
    });
  }

  for (const argv of [['--help', '--bogus'], ['--bogus', '--help'], ['-h', '--only=']]) {
    test(`${argv.join(' ')}: a bad argument beside --help still exits 2 and is named (help does not hide it)`, async () => {
      // Deliberate (see the comment in mutate.mjs): exit 0 means the whole command line was understood.
      const { dir, src } = fixture();
      const res = await runHarness(dir, argv);
      assert.equal(res.code, 2, `${res.stdout}\n${res.stderr}`);
      assert.ok(res.stderr.includes(argv.find((a) => a !== '--help' && a !== '-h')), `the bad argument is not named:\n${res.stderr}`);
      assertNothingRan(dir, src, res);
    });
  }

  test('one bad flag among good ones still stops the run', async () => {
    // The order must not matter: a valid `--only=` in front must not let the run reach the filter and start.
    const { dir, src } = fixture();
    const res = await runHarness(dir, ['--only=add subtracts', '--bogus']);
    assert.equal(res.code, 2, `${res.stdout}\n${res.stderr}`);
    assert.ok(res.stderr.includes('--bogus'));
    assertNothingRan(dir, src, res);
  });

  test('a leftover journal is not recovered by a rejected command line either', async () => {
    // "Before any file is read": the recovery that normally runs first writes to source files, so a command
    // line that is going to be refused must not trigger it. The journal here names the fixture file with
    // stale content; if recovery ran, the source would be rewritten and the journal deleted.
    const { dir, src } = fixture();
    const journal = path.join(dir, JOURNAL);
    fs.writeFileSync(journal, JSON.stringify({ file: 'backend/src/add.js', originalBase64: Buffer.from('ORIGINAL').toString('base64'), pid: 0 }));
    const res = await runHarness(dir, ['--bogus']);
    assert.equal(res.code, 2);
    assert.equal(fs.readFileSync(src, 'utf8'), ADD_SRC, 'recovery rewrote the source');
    assert.ok(fs.existsSync(journal), 'recovery consumed the journal');
  });

  test('every documented flag is still accepted, alone and together', async () => {
    const { dir, src } = fixture();
    // --check and --list stop after reading the catalogue, so these run no tests and write nothing.
    for (const argv of [['--list'], ['--check'], ['--check', '--full'], ['--list', '--only=add', '--timeout=1000', '--full'], ['--check', '--only=add subtracts', '--timeout=5000']]) {
      const res = await runHarness(dir, argv);
      assert.equal(res.code, 0, `${argv.join(' ')} was refused:\n${res.stdout}\n${res.stderr}`);
      assert.doesNotMatch(res.stderr, /usage:/, `${argv.join(' ')} printed the usage`);
    }
    assert.equal(fs.readFileSync(src, 'utf8'), ADD_SRC);
  });

  test('a valid run is unchanged: --only runs the matching mutant and --timeout is still validated', async () => {
    const { dir, src } = fixture();
    const run = await runHarness(dir, ['--only=add subtracts']);
    assert.match(run.stdout + run.stderr, /add subtracts/, 'the matching mutant did not run');
    assert.equal(fs.readFileSync(src, 'utf8'), ADD_SRC, 'the source was not restored');
    // The pre-existing value check still answers (exit 2), now with the usage-free message it always had.
    const bad = await runHarness(dir, ['--timeout=abc']);
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /--timeout must be a positive number/);
  });
});
