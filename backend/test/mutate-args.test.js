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

// ---- --shard=i/n (the CI matrix, .github/workflows/mutation.yml) ------------------------------------------
// The workflow's last job is only as good as one property: the shards TOGETHER are the whole catalogue, each
// mutant exactly once. A shard rule that dropped or doubled an entry would make the weekly run green while
// part of the catalogue never ran. These cases pin that on a catalogue whose size is not a multiple of n, so
// an off-by-one at the boundary shows up. `--list` runs nothing and prints exactly what a shard would run.
describe('--shard=<i>/<n> (the CI matrix)', () => {
  const labels = ['a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6'].map((l) => `shard-fixture ${l}`);
  const catalogue = labels.map((label) => ({ ...MUTANT, label }));
  const shardTree = () => buildTree(catalogue, { 'backend/src/add.js': ADD_SRC, 'backend/test/add.test.js': ADD_TEST });
  const listed = async (dir, argv) => {
    const res = await runHarness(dir, ['--list', ...argv]);
    assert.equal(res.code, 0, `${argv.join(' ')}:\n${res.stdout}\n${res.stderr}`);
    return res.stdout.split('\n').filter(Boolean).map((l) => /shard-fixture (a\d)/.exec(l)[1]);
  };

  test('round-robin by position: shard i of 3 holds entries i-1, i+2, i+5 ...', async () => {
    const dir = shardTree();
    assert.deepEqual(await listed(dir, ['--shard=1/3']), ['a0', 'a3', 'a6']);
    assert.deepEqual(await listed(dir, ['--shard=2/3']), ['a1', 'a4']);
    assert.deepEqual(await listed(dir, ['--shard=3/3']), ['a2', 'a5']);
  });

  test('the shards of 1..n are a partition: every mutant exactly once, whatever n is (including n > size)', async () => {
    const dir = shardTree();
    for (const n of [1, 2, 3, 7, 9]) {
      const all = [];
      for (let i = 1; i <= n; i++) all.push(...(await listed(dir, [`--shard=${i}/${n}`])));
      assert.deepEqual([...all].sort(), ['a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6'], `n=${n}`);
    }
  });

  test('--shard applies after --only', async () => {
    const dir = shardTree();
    // --only narrows to the single entry a4 FIRST; sharding that one-entry list gives it to shard 1 and leaves 2 empty.
    // (Sharding before --only would index into the full catalogue and could drop a4 from both.)
    assert.deepEqual(await listed(dir, ['--only=shard-fixture a4', '--shard=1/2']), ['a4']);
    assert.deepEqual(await listed(dir, ['--only=shard-fixture a4', '--shard=2/2']), []);
  });

  test('a malformed shard is refused with the usage before anything is read', async () => {
    const dir = shardTree();
    for (const bad of ['0/4', '5/4', '1/0', '2', '1/2/3', 'a/b', '-1/4', '1.5/4', '01/4', '1e0/2', ' 1/2', '/2', '1/', '9007199254740993/9007199254740992', '1/9007199254740993']) {
      const res = await runHarness(dir, [`--shard=${bad}`]);
      assert.equal(res.code, 2, `--shard=${bad} was accepted:\n${res.stdout}\n${res.stderr}`);
      assert.match(res.stderr, /--shard must be <i>\/<n>/);
      assert.match(res.stderr, /usage:/);
    }
    const empty = await runHarness(dir, ['--shard=']);
    assert.equal(empty.code, 2);
  });

  test('a real run of a shard runs only that shard, and an empty shard is refused loudly', async () => {
    const dir = shardTree();
    const run = await runHarness(dir, ['--shard=3/3']);
    assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, /shard-fixture a2/);
    assert.match(run.stdout, /shard-fixture a5/);
    assert.doesNotMatch(run.stdout, /shard-fixture a(0|1|3|4|6)/);
    assert.match(run.stdout, /^2 mutants, 2 killed/m);
    const none = await runHarness(dir, ['--shard=9/9']);
    assert.equal(none.code, 2);
    assert.match(none.stderr, /no mutants match in shard 9\/9/);
  });

  // The harness check is a control mutant that must SURVIVE; a filtered run that selects no control cannot tell a
  // working suite from a broken one (every test failing reports every mutant KILLED). Found by the #722 review.
  test('--only that matches no control still carries one; a filter matching nothing stays refused', async () => {
    const control = { ...MUTANT, label: 'shard-fixture control', replace: '  return a + b; // comment only', expect: 'survives' };
    const dir = buildTree([...catalogue, control], { 'backend/src/add.js': ADD_SRC, 'backend/test/add.test.js': ADD_TEST });
    const res = await runHarness(dir, ['--list', '--only=shard-fixture a4']);
    assert.equal(res.code, 0, `${res.stdout}\n${res.stderr}`);
    const lines = res.stdout.split('\n').filter(Boolean);
    assert.equal(lines.length, 2, res.stdout);
    assert.match(lines[0], /shard-fixture a4/);
    assert.match(lines[1], /^CONTROL .*shard-fixture control/);
    // A filter that already selects the control does not add a second copy.
    const own = await runHarness(dir, ['--list', '--only=shard-fixture control']);
    assert.equal(own.stdout.split('\n').filter(Boolean).length, 1, own.stdout);
    // A typo in the filter still matches nothing, rather than running just the control.
    const typo = await runHarness(dir, ['--only=no-such-label']);
    assert.equal(typo.code, 2);
    assert.match(typo.stderr, /no mutants match/);
  });

  test('a filtered run against a broken suite is voided by the carried control', async () => {
    const control = { ...MUTANT, label: 'shard-fixture control', replace: '  return a + b; // comment only', expect: 'survives' };
    const dir = buildTree([...catalogue, control], { 'backend/src/add.js': ADD_SRC, 'backend/test/add.test.js': ADD_TEST.replace('5)', '6)') });
    const run = await runHarness(dir, ['--only=shard-fixture a4']);
    assert.notEqual(run.code, 0, `a failing suite went green:\n${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout + run.stderr, /CONTROL MUTANT WAS KILLED/);
  });
});
