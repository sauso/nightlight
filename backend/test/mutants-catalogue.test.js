// The mutation catalogue (scripts/mutants.json) must still describe the code and the tests it points at
// (issues #575 and #604).
//
// WHY THIS IS A TEST. A catalogue entry that has drifted is only discovered when a full mutation run reaches
// it, which aborts everything after it ("the source has moved"). #575 found five such entries at once, written
// off by routine edits to the source. #604 is the mirror image: a renamed test made the `namePattern` of four
// entries select nothing, and they were reported SURVIVED while all four are killed on the parent commit. A
// pull request that moves a line a mutant anchors on, or renames a test a mutant names, must fail in CI, not in
// the middle of a battery two days later.
//
// The real catalogue is checked with `mutate.mjs --check`, which reads and never writes. The cases around it
// use fixture trees to prove that --check can actually FAIL, because a check that has only ever seen a clean
// catalogue has not been shown to check anything.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REAL_REPO, buildTree, cleanupTrees, runHarness } from './helpers/mutateFixture.js';

after(cleanupTrees);

// While a mutation run is in progress (this very file can be part of a `--full` pass) the real source is
// mutated, so every `find` would legitimately match nothing; the journal is how the harness says "a mutant is
// on disk right now". Checking then would fail this file for a reason that has nothing to do with the code.
const JOURNAL_NOW = path.join(REAL_REPO, 'scripts', '.mutate-restore.json');

describe('the real catalogue', () => {
  test('every `find` occurs exactly once in its file, and every `namePattern` matches a test in the files it names', {
    skip: fs.existsSync(JOURNAL_NOW) && 'a mutation run is in progress (or died): its journal exists, so the source is mutated',
  }, async () => {
    const res = await runHarness(REAL_REPO, ['--check']);
    assert.equal(res.code, 0, `the catalogue has drifted from the code or the tests:\n${res.stderr}${res.stdout}`);
    const size = JSON.parse(fs.readFileSync(path.join(REAL_REPO, 'scripts', 'mutants.json'), 'utf8')).length;
    assert.match(res.stdout, new RegExp(`^${size} catalogue entries, 0 that would not apply`, 'm'));
    assert.ok(size > 1000, 'the catalogue shrank suspiciously; --check cannot vouch for entries that are not there');
  });
});

// ---- --check can fail: fixtures ------------------------------------------------------------------------
const SRC = 'export function one() {\n  return 1;\n}\n';
const SPEC = [
  "import { test, describe } from 'node:test';",
  "describe('the number one', () => {",
  "  test('is exactly one', () => {});",
  '});',
  "test(\"double-quoted names count\", () => {});",
  "test(`template names without interpolation count`, () => {});",
  '',
].join('\n');
const DYNAMIC_SPEC = [
  "import { test } from 'node:test';",
  "for (const n of [1, 2]) test(`case ${n}`, () => {});",
  '',
].join('\n');
const FRONT_SPEC = "import { it, describe } from 'vitest';\ndescribe('Panel', () => { it('Shows The Title', () => {}); });\n";
const entry = (over) => ({
  label: 'fixture entry', file: 'backend/src/one.js', find: '  return 1;', replace: '  return 2;', expect: 'killed', tests: ['one.test.js'], ...over,
});
const files = {
  'backend/src/one.js': SRC,
  'backend/test/one.test.js': SPEC,
  'backend/test/dynamic.test.js': DYNAMIC_SPEC,
  'frontend/src/ui.js': SRC,
  'frontend/test/ui.test.jsx': FRONT_SPEC,
};
const check = (catalogue) => runHarness(buildTree(catalogue, files), ['--check']);

describe('`expect` must be a value the script understands (#642)', () => {
  // M-509-15 said "control", which the run loop did not know: a control that was KILLED did not void the run.
  // Fixtures use values straight from the file, so the case that failed in the real catalogue is reproduced
  // exactly, and `--check` (which the real-catalogue test above runs) is what rejects it.
  test('every value the run knows is accepted', async () => {
    const res = await check(['killed', 'survives', 'equivalent'].map((expect) => entry({ label: expect, expect })));
    assert.equal(res.code, 0, `${res.stdout}\n${res.stderr}`);
  });

  test('"control" (the M-509-15 spelling), any other value and a missing one are each named and fail the check', async () => {
    const noExpect = entry({ label: 'no expect' });
    delete noExpect.expect;
    const res = await check([entry({ label: 'spelled control', expect: 'control' }), entry({ label: 'typo', expect: 'kiled' }), noExpect, entry({ label: 'fine' })]);
    assert.equal(res.code, 3, `${res.stdout}\n${res.stderr}`);
    assert.match(res.stderr, /STALE: "spelled control" — its `expect` is "control"/);
    assert.match(res.stderr, /STALE: "typo" — its `expect` is "kiled"/);
    assert.match(res.stderr, /STALE: "no expect" — its `expect` is missing/);
    assert.doesNotMatch(res.stderr, /"fine"/);
    assert.match(res.stdout, /4 catalogue entries, 3 that would not apply/);
  });

  test('a real run refuses to start on such an entry, before it touches any file or runs any test', async () => {
    const dir = buildTree([entry({ label: 'spelled control', expect: 'control' })], files);
    const res = await runHarness(dir, []);
    assert.equal(res.code, 3, `${res.stdout}\n${res.stderr}`);
    assert.match(res.stderr, /ABORT: "spelled control" — its `expect` is "control"/);
    assert.equal(fs.readFileSync(path.join(dir, 'backend/src/one.js'), 'utf8'), SRC);
    assert.doesNotMatch(res.stdout, /KILLED|SURVIVED/);
  });
});

describe('--check and namePattern (#604)', () => {
  test('patterns that select a test pass: a test name, a describe title, quote styles, a /regex/ form', async () => {
    const res = await check([
      entry({ namePattern: 'is exactly one' }),
      entry({ namePattern: 'the number one' }),
      entry({ namePattern: 'double-quoted' }),
      entry({ namePattern: 'template names without' }),
      entry({ namePattern: '/EXACTLY ONE/i' }),
      entry({ namePattern: '^is exactly one$' }),
    ]);
    assert.equal(res.code, 0, `${res.stdout}\n${res.stderr}`);
    assert.match(res.stdout, /6 catalogue entries, 0 that would not apply/);
  });

  test('a pattern that selects NO test is named and fails the check', async () => {
    const res = await check([entry({ label: 'renamed test', namePattern: 'is exactly uno' }), entry({ label: 'fine' })]);
    assert.equal(res.code, 3, `${res.stdout}\n${res.stderr}`);
    assert.match(res.stderr, /STALE: "renamed test" — its namePattern "is exactly uno" matches no test name in one\.test\.js/);
    assert.doesNotMatch(res.stderr, /"fine"/);
    assert.match(res.stdout, /2 catalogue entries, 1 that would not apply/);
  });

  test('an entry with no namePattern is not asked for one, and a pattern is judged against the files the entry names only', async () => {
    const ok = await check([entry({ tests: ['one.test.js'] })]);
    assert.equal(ok.code, 0, `${ok.stdout}\n${ok.stderr}`);
    // dynamic.test.js names its tests with a template (`case ${n}`), so a pattern that matches none of its
    // literal pieces cannot be judged against it.
    const wrongFile = await check([entry({ namePattern: 'is exactly one', tests: ['dynamic.test.js'] })]);
    assert.equal(wrongFile.code, 0, 'a file that builds its names at run time cannot be judged, so it is accepted (the run-time abort still covers it)');
    assert.match(wrongFile.stdout, /1 namePatterns could not be proved statically/, 'an unproved pattern must be admitted, not silently passed');
    // ...but the literal pieces of a template title are still checked: this pattern is provable, so no admission.
    const piece = await check([entry({ namePattern: '^case', tests: ['dynamic.test.js'] })]);
    assert.equal(piece.code, 0, `${piece.stdout}\n${piece.stderr}`);
    assert.doesNotMatch(piece.stdout, /could not be proved/);
    const other = await check([entry({ namePattern: 'double-quoted names count', tests: ['ui.test.jsx'], file: 'frontend/src/ui.js' })]);
    assert.equal(other.code, 3, 'a frontend entry must be judged against frontend/test, not backend/test');
  });

  test('a test file that does not exist, and an invalid regular expression, are both named', async () => {
    const res = await check([
      entry({ label: 'gone file', namePattern: 'x', tests: ['gone.test.js'] }),
      entry({ label: 'bad regex', namePattern: '(' }),
    ]);
    assert.equal(res.code, 3);
    assert.match(res.stderr, /STALE: "gone file" — the test file backend[\\/]test[\\/]gone\.test\.js cannot be read/);
    assert.match(res.stderr, /STALE: "bad regex" — its namePattern is not a valid regular expression/);
  });

  test('a frontend entry is matched case-insensitively (vitest -t does), against frontend/test', async () => {
    const res = await check([entry({
      label: 'frontend', file: 'frontend/src/ui.js', tests: ['ui.test.jsx'], namePattern: 'shows the title',
    }), entry({
      label: 'frontend describe', file: 'frontend/src/ui.js', tests: ['ui.test.jsx'], namePattern: 'Panel Shows The Title',
    })]);
    assert.equal(res.code, 0, `${res.stdout}\n${res.stderr}`);
  });

  test('a stale `find` is still reported alongside a stale pattern in the same entry', async () => {
    const res = await check([entry({ label: 'both', find: '  return 99;', namePattern: 'nothing like it' })]);
    assert.equal(res.code, 3);
    assert.match(res.stderr, /STALE: "both" — its `find` matches 0 times/);
    assert.match(res.stderr, /STALE: "both" — its namePattern/);
    assert.match(res.stdout, /1 catalogue entries, 1 that would not apply/);
  });
});
