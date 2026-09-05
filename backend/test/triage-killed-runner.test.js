// Does the CI triage tell a killed runner apart from a genuinely red suite? Issue #278.
//
// This guards a decision that fails SILENTLY in the worst direction: classify a real failure as a
// killed runner and CI retries away a broken build, twice as red and half as visible. So the cases
// below are weighted toward proving it REFUSES to retry, not toward proving it retries.
//
// ⚠️ IT LIVES HERE BECAUSE THIS IS THE ONLY TEST HARNESS IN THE REPO. The module under test is
// repo-root tooling (`scripts/`), like `check-changelog.mjs` — which has no tests at all, and is
// exactly the precedent not to follow for logic whose failure mode is invisible.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { classify, SHUTDOWN_MARKER } = await import(
  new URL('../../scripts/triage-killed-runner.mjs', import.meta.url).href
);

// ★ A REAL CAPTURED LOG, not a hand-written approximation — from run 33932688168. This is the fixture
// that matters: the first version of the count parser anchored to the start of a line and read `null`
// on this input, because `gh run view --log` prefixes every line with `job<TAB>step<TAB>timestamp`.
// A hand-written fixture would not have had those prefixes and the bug would have shipped.
const REAL_KILLED = readFileSync(path.join(HERE, 'fixtures', 'killed-runner.log'), 'utf8');

describe('a killed runner', () => {
  test('the real captured log is recognised, and asks for a retry', () => {
    const v = classify(REAL_KILLED, 1);
    assert.equal(v.decision, 'killed-runner');
    assert.equal(v.retry, true);
    assert.equal(v.shutdown, true);
    assert.equal(v.failCount, 0, 'the summary said `fail 0` — it must be parsed, not left null');
    assert.equal(v.cancelledCount, 2);
  });

  test('the counts really are parsed from THIS log, not defaulted', () => {
    // Anti-vacuous: if the parser returned null for everything, `failCount !== 0` would send it down
    // the `mixed` path — so the case above would fail. This states the same thing from the other side,
    // and pins the exact numbers so a parser that returns a constant cannot pass.
    const v = classify(REAL_KILLED, 1);
    assert.notEqual(v.failCount, null, 'failCount is null — the parser is not matching this log format');
    assert.notEqual(v.cancelledCount, null);
    assert.equal(`${v.failCount}/${v.cancelledCount}`, '0/2');
  });
});

describe('it refuses to retry anything it cannot prove is safe', () => {
  test('a genuine test failure is left completely alone', () => {
    // Synthetic, and said so plainly: in the last 60 CI runs there has never been a genuine failure to
    // capture — every red run was a killed runner. Built to match node's real reporter output.
    const log = [
      'unit\tRun the test suite\t2026-09-05T00:00:00.0Z ✖ test/sleepAnalysis.test.js (12ms)',
      'unit\tRun the test suite\t2026-09-05T00:00:00.0Z ℹ tests 515',
      'unit\tRun the test suite\t2026-09-05T00:00:00.0Z ℹ pass 512',
      'unit\tRun the test suite\t2026-09-05T00:00:00.0Z ℹ fail 3',
      'unit\tRun the test suite\t2026-09-05T00:00:00.0Z ℹ cancelled 0',
    ].join('\n');
    const v = classify(log, 1);
    assert.equal(v.decision, 'real-failure');
    assert.equal(v.retry, false);
    assert.equal(v.failCount, 3);
  });

  test('the runner died AND tests failed — needs a human, not a retry', () => {
    // The dangerous middle case: the shutdown marker is present, so a check that looked only for it
    // would retry away three real failures.
    const log = [
      `unit\tstep\t2026-09-05T00:00:00.0Z ##[error]${SHUTDOWN_MARKER}. This can happen when ...`,
      'unit\tstep\t2026-09-05T00:00:00.0Z ℹ fail 3',
      'unit\tstep\t2026-09-05T00:00:00.0Z ℹ cancelled 2',
    ].join('\n');
    const v = classify(log, 1);
    assert.equal(v.decision, 'mixed');
    assert.equal(v.retry, false, 'it retried a run in which three tests genuinely failed');
  });

  test('a shutdown with NO summary at all is not retried — absence is not proof', () => {
    const log = `unit\tstep\tZ ##[error]${SHUTDOWN_MARKER}. blah`;
    const v = classify(log, 1);
    assert.equal(v.decision, 'mixed');
    assert.equal(v.retry, false);
    assert.equal(v.failCount, null);
  });

  test('it never retries twice — a dying runner cannot loop forever', () => {
    const v = classify(REAL_KILLED, 2);
    assert.equal(v.decision, 'already-retried');
    assert.equal(v.retry, false, 'a second retry would burn minutes indefinitely on a runner that keeps dying');
  });

  test('an empty or unreadable log is not retried', () => {
    for (const log of ['', '   \n  ', null, undefined]) {
      const v = classify(log, 1);
      assert.equal(v.decision, 'no-log', `classified ${JSON.stringify(log)} as ${v.decision}`);
      assert.equal(v.retry, false);
    }
  });
});

describe('the parser is not fooled by text that merely looks like a summary', () => {
  test('a test NAME containing the words is not read as a count', () => {
    // The suite really does have cases with words like "fail" in the title. Without the `ℹ`/`#`
    // marker requirement, an unanchored /fail (\d+)/ reads one of these and the verdict flips.
    // ⚠️ THE DECOYS SIT AFTER THE SUMMARY ON PURPOSE. An earlier version of this case put them
    // before it, so "the last match wins" rescued a parser that had lost its marker requirement
    // entirely — the mutant survived and this test still passed. Real `--log-failed` output does
    // repeat a "failing tests:" section after the summary block, so this is also the realistic order.
    const log = [
      `unit\tstep\tZ ##[error]${SHUTDOWN_MARKER}.`,
      'unit\tstep\tZ ℹ fail 0',
      'unit\tstep\tZ ℹ cancelled 2',
      'unit\tstep\tZ ✖ failing tests:',
      'unit\tstep\tZ ✔ retries after fail 3 times before giving up (4ms)',
      'unit\tstep\tZ ✔ reports cancelled 9 uploads (2ms)',
    ].join('\n');
    const v = classify(log, 1);
    assert.equal(v.failCount, 0, 'it read the test name "fail 3" instead of the summary line');
    assert.equal(v.cancelledCount, 2, 'it read the test name "cancelled 9" instead of the summary line');
    assert.equal(v.decision, 'killed-runner');
  });

  test('TAP output is understood as well as the human reporter', () => {
    // node switches children to TAP when NODE_TEST_CONTEXT is set, so `ℹ pass 18` arrives as
    // `# pass 18`. A parser that only knew `ℹ` would read null and refuse every retry.
    const log = [
      `unit\tstep\tZ ##[error]${SHUTDOWN_MARKER}.`,
      'unit\tstep\tZ # fail 0',
      'unit\tstep\tZ # cancelled 4',
    ].join('\n');
    const v = classify(log, 1);
    assert.equal(v.decision, 'killed-runner');
    assert.equal(v.cancelledCount, 4);
  });

  test('the LAST summary wins when a log carries more than one job', () => {
    // --log-failed can return several jobs concatenated. The final summary is the run's.
    const log = [
      `unit\tstep\tZ ##[error]${SHUTDOWN_MARKER}.`,
      'coverage\tstep\tZ ℹ fail 0',
      'coverage\tstep\tZ ℹ cancelled 15',
      'unit\tstep\tZ ℹ fail 0',
      'unit\tstep\tZ ℹ cancelled 2',
    ].join('\n');
    const v = classify(log, 1);
    assert.equal(v.cancelledCount, 2);
  });

  test('the shutdown marker is matched literally, not loosely', () => {
    // A log merely discussing the phenomenon must not trip it. The marker is GitHub's exact wording.
    const log = [
      'unit\tstep\tZ ✔ explains what a runner shutdown looks like (1ms)',
      'unit\tstep\tZ ℹ fail 0',
      'unit\tstep\tZ ℹ cancelled 0',
    ].join('\n');
    const v = classify(log, 1);
    assert.equal(v.shutdown, false);
    assert.equal(v.decision, 'real-failure', 'a run with no shutdown marker must be left alone');
  });
});
