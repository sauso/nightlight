#!/usr/bin/env node
// Mutation testing for the backend suite.
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
// A mutant is KILLED if the chosen tests fail with it applied. SURVIVED means the suite cannot tell
// the mutated code from the real code — that is the finding, and it needs either a new test or a
// written reason why it does not matter.
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const BACKEND = path.join(REPO, 'backend');

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
if (!mutants.length) {
  console.error(`no mutants match --only=${only}`);
  process.exit(2);
}

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
function runTests(testFiles, namePattern) {
  const target = testFiles?.length ? testFiles.map((f) => path.join('test', f)) : ['test/*.test.js'];
  const nameArgs = namePattern ? ['--test-name-pattern', JSON.stringify(namePattern)] : [];
  const res = spawnSync('node', ['--test', ...nameArgs, ...target], {
    cwd: BACKEND,
    encoding: 'utf8',
    shell: true, // the glob in the full-suite case needs one
    env: { ...process.env, NODE_OPTIONS: '' },
  });
  const out = `${res.stdout || ''}${res.stderr || ''}`;
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
    writeFileSync(abs, mutated);
    // Re-read from disk rather than trusting the write: this is the "the mutant never applied" guard,
    // and the whole point is not to trust that a step did what it said.
    if (!readFileSync(abs).equals(mutated)) throw new Error('the mutated file on disk does not match what was written');
    const { failed, cancelled, ran } = runTests(m.tests && !flag('full') ? m.tests : null, flag('full') ? null : m.namePattern);
    verdict = cancelled > 0 || ran === 0 ? 'ERROR' : failed ? 'KILLED' : 'SURVIVED';
    if (ran === 0) console.error(`        (no tests ran — check \`tests\`/\`namePattern\` for "${m.label}")`);
  } finally {
    writeFileSync(abs, original);
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
  const ok = verdict === expected;
  if (m.expect === 'survives' && verdict === 'KILLED') harnessBroken = true;
  if (m.expect === 'equivalent' && verdict === 'KILLED') {
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
console.log(`${results.length} mutants, ${results.filter((r) => r.verdict === 'KILLED').length} killed, ` +
  `${survivors.length} survived unexpectedly, ${errored.length} errored, ` +
  `${results.filter((r) => r.expect === 'equivalent').length} known-equivalent, ` +
  `${results.filter((r) => r.expect === 'survives').length} control(s) correctly survived.`);
for (const s of survivors) console.log(`  SURVIVED: ${s.label}${s.note ? ` — ${s.note}` : ''}`);
for (const e of errored) console.log(`  ERRORED (cancelled test files, result unusable): ${e.label}`);
process.exit(survivors.length || errored.length ? 1 : 0);
