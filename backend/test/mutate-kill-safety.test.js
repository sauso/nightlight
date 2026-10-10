// A killed or misdirected mutation run must not leave the source mutated, and must not lie about what it ran
// (issues #597, #599, #604).
//
// WHAT HAPPENED. #599: killed runs (timeout, Ctrl-C, CI cancel) left a mutant in clipCapture.js, clipRecorder.js
// and timelapse.js three times in one afternoon; the diffs read like plausible edits, so they are easy to commit.
// #597: 135 catalogue entries carry `\r\n` in a multi-line `find`, which matches nothing in an LF checkout (CI, or
// `core.autocrlf=false`) and aborts the run as "the source has moved". #604: a mutant that ran no test was
// printed as SURVIVED, the most alarming verdict, from a no-op.
//
// ⚠️ NO MOCKS. Every case runs the real harness as a real process against a fixture tree (see
// helpers/mutateFixture.js) and checks real bytes and real pids. A harness that only handled the signal in a
// stub would pass; the bug is what happens to a process that is genuinely killed mid-mutation.
//
// ⚠️ PLATFORMS. The SIGINT/SIGTERM/SIGHUP cases are skipped on Windows, and the reason is the platform, not
// laziness: Node cannot deliver those signals to a handler there (`process.kill(pid, 'SIGTERM')` terminates the
// process outright), so on Windows a killed run is protected ONLY by the journal, and the SIGKILL case below
// (which runs everywhere) is the one that pins it. CI is Linux and runs all of them.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  buildTree, cleanupTrees, startHarness, runHarness, alive, waitDead, waitFor,
} from './helpers/mutateFixture.js';

const pids = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-mutate-kill-pids-'));
after(() => { cleanupTrees(); fs.rmSync(pids, { recursive: true, force: true }); });

const JOURNAL = 'scripts/.mutate-restore.json';

// ---- a test that is "running" while the mutant is on disk -------------------------------------------------
// The test file records its pid (proof the mutant is already written: the harness writes before it spawns) and
// then sleeps, so the case can kill the harness at exactly the moment the bug needs.
const SLOW_SRC = ['export function answer() {', '  return 1;', '}', ''].join('\n');
const SLOW_TEST = [
  "import { test } from 'node:test';",
  "import assert from 'node:assert/strict';",
  "import fs from 'node:fs';",
  "import { answer } from '../src/slow.js';",
  "test('answer is one', async () => {",
  '  fs.writeFileSync(process.env.SLOW_PID_FILE, String(process.pid));',
  '  await new Promise((resolve) => setTimeout(resolve, 60000));',
  '  assert.equal(answer(), 1);',
  '});',
  '',
].join('\n');
const SLOW_MUTANT = {
  label: 'fixture: answer is two',
  file: 'backend/src/slow.js',
  find: '  return 1;',
  replace: '  return 2;',
  expect: 'killed',
  tests: ['slow.test.js'],
};
const slowFiles = { 'backend/src/slow.js': SLOW_SRC, 'backend/test/slow.test.js': SLOW_TEST };

// Start a run, wait until the mutant is certainly on disk, and return what a case needs to hurt it.
async function startMidMutation(label) {
  const dir = buildTree([SLOW_MUTANT], slowFiles);
  const pidFile = path.join(pids, `${label}.pid`);
  const src = path.join(dir, 'backend/src/slow.js');
  const original = fs.readFileSync(src);
  const run = startHarness(dir, [], { SLOW_PID_FILE: pidFile });
  assert.ok(await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').length > 0),
    'the fixture test never started, so no mutant was ever on disk');
  assert.notDeepEqual(fs.readFileSync(src), original, 'precondition: the mutant is on disk while the test runs');
  return { dir, src, original, run, testPid: Number(fs.readFileSync(pidFile, 'utf8')) };
}

const hardKill = async (pid) => {
  try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  await waitDead(pid);
};

describe('#599 a run killed while a mutant is on disk', () => {
  test('the journal exists BEFORE the mutant does, and the next run restores from it (SIGKILL: no handler can run)', async () => {
    const { dir, src, original, run, testPid } = await startMidMutation('sigkill');
    const journalPath = path.join(dir, JOURNAL);
    // The mutant is on disk and so is the journal that can undo it, holding the exact original bytes.
    assert.ok(fs.existsSync(journalPath), 'no journal while a mutant is on disk');
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    assert.equal(journal.file.split(/[\\/]/).join('/'), 'backend/src/slow.js');
    assert.ok(Buffer.from(journal.originalBase64, 'base64').equals(original), 'the journal does not hold the original bytes');
    // #642: and a hash of the MUTATED bytes, which is what lets the next run tell the mutant from a later edit.
    assert.equal(journal.mutatedSha256, createHash('sha256').update(fs.readFileSync(src)).digest('hex'),
      'the journal does not carry the hash of the mutant that is on disk');

    // The harness dies with no chance to clean up (Windows: this is also what any kill of it looks like).
    run.child.kill('SIGKILL');
    await run.done;
    await hardKill(testPid);
    assert.ok(!fs.readFileSync(src).equals(original), 'precondition: the killed run left the source mutated');
    assert.ok(fs.existsSync(journalPath), 'precondition: the journal survived the kill');

    // The next run, even one that has nothing to do with this file's mutant, undoes it before reading anything.
    const next = await runHarness(dir, ['--only=no mutant has this label']);
    assert.ok(fs.readFileSync(src).equals(original), `the source was not restored:\n${next.stdout}\n${next.stderr}`);
    assert.match(next.stderr, /RECOVERED: backend[\\/]src[\\/]slow\.js was left mutated by a run that died/);
    assert.equal(fs.existsSync(journalPath), false, 'the journal was not removed after the restore');
  });

  test('a recovery that finds a LIVE run in the same checkout refuses to touch the file', async () => {
    // The journal names this very test process (certainly alive); a second run restoring now would pull the file
    // out from under the first one and corrupt its verdicts.
    const dir = buildTree([SLOW_MUTANT], slowFiles);
    const src = path.join(dir, 'backend/src/slow.js');
    const mutated = Buffer.from(SLOW_SRC.replace('return 1', 'return 2'));
    fs.writeFileSync(src, mutated);
    fs.writeFileSync(path.join(dir, JOURNAL), JSON.stringify({
      pid: process.pid, file: 'backend/src/slow.js', startedAt: 'now', originalBase64: Buffer.from(SLOW_SRC).toString('base64'),
    }));
    const res = await runHarness(dir);
    assert.equal(res.code, 2, `${res.stdout}\n${res.stderr}`);
    assert.match(res.stderr, new RegExp(`another mutation run \\(pid ${process.pid}\\)`));
    assert.ok(fs.readFileSync(src).equals(mutated), 'the file of a live run was touched');
    assert.ok(fs.existsSync(path.join(dir, JOURNAL)), 'the live run\'s journal was removed');
  });

  test('a journal that names a file outside the checkout, or is unreadable, is refused, not obeyed', async () => {
    const dir = buildTree([SLOW_MUTANT], slowFiles);
    const outside = path.join(pids, 'outside.txt');
    fs.writeFileSync(outside, 'untouched');
    fs.writeFileSync(path.join(dir, JOURNAL), JSON.stringify({
      pid: 0, file: path.relative(dir, outside), startedAt: 'now', originalBase64: Buffer.from('overwritten').toString('base64'),
    }));
    const res = await runHarness(dir);
    assert.equal(res.code, 4, `${res.stdout}\n${res.stderr}`);
    assert.match(res.stderr, /outside this checkout/);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'untouched', 'the journal was allowed to write outside the checkout');

    fs.writeFileSync(path.join(dir, JOURNAL), '{ not json');
    const bad = await runHarness(dir);
    assert.equal(bad.code, 4, `${bad.stdout}\n${bad.stderr}`);
    assert.match(bad.stderr, /cannot be read/);
  });

  test('a normal run leaves no journal behind', async () => {
    const dir = buildTree([{ ...SLOW_MUTANT, tests: ['quick.test.js'] }], {
      'backend/src/slow.js': SLOW_SRC,
      'backend/test/quick.test.js': [
        "import { test } from 'node:test';",
        "import assert from 'node:assert/strict';",
        "import { answer } from '../src/slow.js';",
        "test('answer is one', () => { assert.equal(answer(), 1); });",
        '',
      ].join('\n'),
    });
    const res = await runHarness(dir);
    assert.match(res.stdout, /KILLED\s+fixture: answer is two/);
    assert.equal(res.code, 0, `${res.stdout}\n${res.stderr}`);
    assert.equal(fs.existsSync(path.join(dir, JOURNAL)), false, 'a finished run left its journal');
    assert.equal(fs.readFileSync(path.join(dir, 'backend/src/slow.js'), 'utf8'), SLOW_SRC);
  });

  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
    test(`${signal} restores the file, removes the journal and kills the whole test process tree`, {
      skip: process.platform === 'win32' && 'Windows cannot deliver this signal to a handler (the process is terminated outright); the SIGKILL case above covers the journal there',
    }, async () => {
      const { dir, src, original, run, testPid } = await startMidMutation(signal);
      run.child.kill(signal);
      const res = await run.done;
      try {
        assert.ok(fs.readFileSync(src).equals(original), `${signal} left the source mutated:\n${res.stdout}\n${res.stderr}`);
        assert.equal(fs.existsSync(path.join(dir, JOURNAL)), false, 'the journal was left behind after a clean restore');
        assert.equal(res.code, code, `expected exit ${code}; got ${res.code} / ${res.signal}`);
        assert.match(res.stderr, new RegExp(`${signal}: restored backend[\\\\/]src[\\\\/]slow\\.js`));
        // The sleeping test file is a GRANDCHILD of the harness: it must die with the run, or it keeps its CPU
        // (and, in #617's case, its spin) long after the run is over.
        assert.ok(await waitDead(testPid), `the test process ${testPid} outlived the harness`);
      } finally {
        if (alive(testPid)) await hardKill(testPid);
      }
    });
  }
});

// ---- #642 recovery must not overwrite a later edit ------------------------------------------------------
// Windows cannot deliver SIGTERM to a handler, so these cases do not kill anything: they write the journal a
// killed run would have left (a pid that is certainly dead, the saved original, the mutant's hash) next to a
// file in the state under test, then start the next run. The files are fixture copies in a scratch tree, never
// the repo's own source.
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const DEAD_PID = spawnSync(process.execPath, ['-e', '']).pid; // exited by the time spawnSync returns
const ORIGINAL = Buffer.from(SLOW_SRC);
const MUTANT = Buffer.from(SLOW_SRC.replace('return 1', 'return 2'));
const EDIT = Buffer.from(`${MUTANT.toString()}// a developer edit made after the kill\n`);
function leftBehind({ onDisk, journal = {} }) {
  const dir = buildTree([SLOW_MUTANT], slowFiles);
  const src = path.join(dir, 'backend/src/slow.js');
  if (onDisk === null) fs.rmSync(src); else fs.writeFileSync(src, onDisk);
  fs.writeFileSync(path.join(dir, JOURNAL), JSON.stringify({
    pid: DEAD_PID, file: 'backend/src/slow.js', startedAt: '2026-10-10T00:00:00.000Z',
    originalBase64: ORIGINAL.toString('base64'), mutatedSha256: sha(MUTANT), ...journal,
  }));
  return { dir, src, journalPath: path.join(dir, JOURNAL) };
}
const nextRun = (dir) => runHarness(dir, ['--only=no mutant has this label']);

describe('#642 the journal restores only a file that still holds the mutant', () => {
  test('a developer edit made after the kill is NOT overwritten: the run stops, names the file and leaves it (and the journal) alone', async () => {
    const { dir, src, journalPath } = leftBehind({ onDisk: EDIT });
    const res = await nextRun(dir);
    assert.equal(res.code, 4, `${res.stdout}\n${res.stderr}`);
    assert.ok(fs.readFileSync(src).equals(EDIT), 'the developer\'s edit was overwritten by the journal\'s original');
    assert.match(res.stderr, /ABORT: backend[\\/]src[\\/]slow\.js was left mutated by a run that died/);
    assert.match(res.stderr, /no longer matches the mutant the journal recorded/);
    assert.match(res.stderr, /NOT overwriting/);
    assert.doesNotMatch(res.stderr, /RECOVERED/);
    assert.ok(fs.existsSync(journalPath), 'the journal (the only copy of the original bytes) was deleted');
  });

  test('another version of the file entirely (a different branch) is likewise left alone', async () => {
    const other = Buffer.from('export function answer() {\n  return 3;\n}\n');
    const { dir, src } = leftBehind({ onDisk: other });
    const res = await nextRun(dir);
    assert.equal(res.code, 4, `${res.stdout}\n${res.stderr}`);
    assert.ok(fs.readFileSync(src).equals(other));
  });

  test('a file that is exactly the recorded mutant IS restored (the guard must not disable the recovery)', async () => {
    const { dir, src, journalPath } = leftBehind({ onDisk: MUTANT });
    const res = await nextRun(dir);
    assert.ok(fs.readFileSync(src).equals(ORIGINAL), `${res.stdout}\n${res.stderr}`);
    assert.match(res.stderr, /RECOVERED: backend[\\/]src[\\/]slow\.js .*restored it from the journal/);
    assert.equal(fs.existsSync(journalPath), false);
  });

  test('a file already back to the original just drops the journal, whatever the hash says', async () => {
    const { dir, src, journalPath } = leftBehind({ onDisk: ORIGINAL });
    const res = await nextRun(dir);
    assert.ok(fs.readFileSync(src).equals(ORIGINAL));
    assert.match(res.stderr, /it was already intact/);
    assert.equal(fs.existsSync(journalPath), false);
  });

  test('a file that has been deleted is not recreated from the journal', async () => {
    const { dir, src, journalPath } = leftBehind({ onDisk: null });
    const res = await nextRun(dir);
    assert.equal(res.code, 4, `${res.stdout}\n${res.stderr}`);
    assert.match(res.stderr, /the file no longer exists/);
    assert.equal(fs.existsSync(src), false);
    assert.ok(fs.existsSync(journalPath));
  });

  // A journal from before the hash existed. The conservative reading: act only when the file is exactly what a
  // CURRENT catalogue entry makes of the saved original, and say that this is what was checked.
  const legacy = { mutatedSha256: undefined };
  test('a journal WITHOUT a hash still restores a file that is exactly a catalogue mutant of the original, and says how it knew', async () => {
    const { dir, src } = leftBehind({ onDisk: MUTANT, journal: legacy });
    const res = await nextRun(dir);
    assert.ok(fs.readFileSync(src).equals(ORIGINAL), `${res.stdout}\n${res.stderr}`);
    assert.match(res.stderr, /predates the mutant hash/);
    assert.match(res.stderr, /RECOVERED/);
  });

  test('a journal WITHOUT a hash does not restore over a developer edit: it stops and says why', async () => {
    const { dir, src, journalPath } = leftBehind({ onDisk: EDIT, journal: legacy });
    const res = await nextRun(dir);
    assert.equal(res.code, 4, `${res.stdout}\n${res.stderr}`);
    assert.ok(fs.readFileSync(src).equals(EDIT), 'a hash-less journal overwrote the developer\'s edit');
    assert.match(res.stderr, /predates the mutant hash/);
    assert.ok(fs.existsSync(journalPath));
  });
});

// ---- #597 line endings ---------------------------------------------------------------------------------
const TWO_LINES = ['export function add(a, b) {', '  const sum = a + b;', '  return sum;', '}', ''];
const ADD_TEST = [
  "import { test } from 'node:test';",
  "import assert from 'node:assert/strict';",
  "import { add } from '../src/add.js';",
  "test('add adds', () => { assert.equal(add(2, 3), 5); });",
  '',
].join('\n');
const addMutant = (find, replace) => ({
  label: 'fixture: add subtracts', file: 'backend/src/add.js', find, replace, expect: 'killed', tests: ['add.test.js'],
});

describe('#597 a catalogue entry applies whichever line endings the file has', () => {
  for (const [name, fileEol, findEol] of [
    ['an LF file with a `find` written with CRLF (the checked-in catalogue on Linux CI)', '\n', '\r\n'],
    ['a CRLF file with a `find` written with LF', '\r\n', '\n'],
    ['a CRLF file with a `find` written with CRLF (the case that always worked)', '\r\n', '\r\n'],
    ['an LF file with a `find` written with LF (the case that always worked)', '\n', '\n'],
  ]) {
    test(`${name}: KILLED, and the file comes back byte-for-byte`, async () => {
      const file = TWO_LINES.join(fileEol);
      const find = ['  const sum = a + b;', '  return sum;'].join(findEol);
      const replace = ['  const sum = a - b;', '  return sum;'].join(findEol);
      const dir = buildTree([addMutant(find, replace)], { 'backend/src/add.js': file, 'backend/test/add.test.js': ADD_TEST });
      const check = await runHarness(dir, ['--check']);
      assert.equal(check.code, 0, `--check disagrees:\n${check.stdout}\n${check.stderr}`);
      const res = await runHarness(dir);
      assert.match(res.stdout, /^ ok KILLED\s+fixture: add subtracts/m, `${res.stdout}\n${res.stderr}`);
      assert.equal(res.code, 0);
      assert.equal(fs.readFileSync(path.join(dir, 'backend/src/add.js'), 'utf8'), file, 'the file was not restored exactly');
    });
  }

  test('the replacement is spliced in literally: `$&` and `$$` in it are not String.replace patterns', async () => {
    // With `text.replace(find, replace)`, `'$$'` becomes `'$'`, the mutant is not the one the catalogue says,
    // and this test (which fails only for the literal two-dollar value) would see a SURVIVOR.
    const dir = buildTree([{
      label: 'fixture: two dollars', file: 'backend/src/tag.js', find: "'x'", replace: "'$$'", expect: 'killed', tests: ['tag.test.js'],
    }], {
      'backend/src/tag.js': "export const tag = 'x';\n",
      'backend/test/tag.test.js': [
        "import { test } from 'node:test';",
        "import assert from 'node:assert/strict';",
        "import { tag } from '../src/tag.js';",
        "test('the tag is not the two-dollar string', () => { assert.notEqual(tag, '$' + '$'); });",
        '',
      ].join('\n'),
    });
    const res = await runHarness(dir);
    assert.match(res.stdout, /^ ok KILLED\s+fixture: two dollars/m, `${res.stdout}\n${res.stderr}`);
  });
});

// ---- #604 a mutant that runs no test -------------------------------------------------------------------
describe('#604 a mutant that ran no test aborts the run', () => {
  const quickFiles = {
    'backend/src/add.js': TWO_LINES.join('\n'),
    'backend/test/add.test.js': ADD_TEST,
  };
  const good = addMutant('  const sum = a + b;', '  const sum = a - b;');

  for (const expect of ['killed', 'survives', 'equivalent']) {
    test(`a namePattern that selects no test aborts (exit 3) for an \`expect: ${expect}\` entry, instead of printing SURVIVED`, async () => {
      const dir = buildTree([{ ...good, label: 'fixture: pattern selects nothing', expect, namePattern: 'this name matches no test' }, good], quickFiles);
      const before = fs.readFileSync(path.join(dir, 'backend/src/add.js'));
      const res = await runHarness(dir);
      assert.equal(res.code, 3, `${res.stdout}\n${res.stderr}`);
      assert.match(res.stderr, /ABORT: "fixture: pattern selects nothing" — it ran NO test/);
      assert.match(res.stderr, /do NOT interpret this run/);
      // No verdict line for it and no summary: stdout must not read as a result.
      assert.doesNotMatch(res.stdout, /SURVIVED|mutants,/);
      assert.ok(fs.readFileSync(path.join(dir, 'backend/src/add.js')).equals(before), 'the source was left mutated');
      assert.equal(fs.existsSync(path.join(dir, JOURNAL)), false);
    });
  }

  test('a run that FAILED with zero tests (a test file that does not exist) is still an ERROR, not an abort', async () => {
    // Only "ran nothing AND passed" is the silent lie; a command that could not run is already loud.
    const dir = buildTree([{ ...good, label: 'fixture: no such test file', tests: ['missing.test.js'] }], quickFiles);
    const res = await runHarness(dir);
    assert.equal(res.code, 1, `${res.stdout}\n${res.stderr}`);
    assert.match(res.stdout, /ERROR\s+fixture: no such test file/);
  });

  test('a pattern that does select a test is unaffected', async () => {
    const dir = buildTree([{ ...good, namePattern: 'add adds' }], quickFiles);
    const res = await runHarness(dir);
    assert.match(res.stdout, /^ ok KILLED\s+fixture: add subtracts/m, `${res.stdout}\n${res.stderr}`);
    assert.equal(res.code, 0);
  });
});
