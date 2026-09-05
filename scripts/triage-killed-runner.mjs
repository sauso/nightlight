#!/usr/bin/env node
// Tell "the GitHub runner was killed" apart from "a test actually failed".
//
// THE PROBLEM (issue #278). Between 7% and 42% of `Tests and checks` runs, depending on the day, end
// with the hosted runner being killed mid-job:
//
//     ##[error]The runner has received a shutdown signal. ...
//     ##[error]The operation was canceled.
//
// Node is terminated with test files still in flight, so it reports them `cancelled` and the run goes
// red — while the summary says `fail 0`, because nothing actually failed. Measured over the last 60
// runs: EVERY red run was this, six for six. Every failure notification so far has been a false alarm.
//
// Ruled out by measurement before writing this: memory (16GB, 14.4GB free at the worst sample), CPU
// (4 cores; capping --test-concurrency changes nothing), resource leaks (process/fd/zombie counts flat
// across repeated runs), our own code signalling stray PIDs (no raw process.kill anywhere), workflow
// concurrency, and quota. It is infrastructure, so this mitigates rather than fixes.
//
// ⚠️ This is deliberately a MODULE with a pure `classify`, not inline shell in the workflow. A
// misclassification here fails silently in the worst direction — retrying away a genuine red suite —
// and inline `run:` shell cannot be tested. See backend/test/triage-killed-runner.test.js.

// The runner's own message when its VM is reclaimed. Matched as a fixed substring, never a regex:
// the phrase is GitHub's, not ours, and a loose pattern is how a guard starts matching the wrong thing.
export const SHUTDOWN_MARKER = 'The runner has received a shutdown signal';

/**
 * Decide what a red run actually was.
 *
 * @param {string} log      the failed jobs' log text
 * @param {number} attempt  run_attempt (1 for the first try)
 * @returns {{decision: string, retry: boolean, shutdown: boolean, failCount: number|null,
 *            cancelledCount: number|null, reason: string}}
 *
 * decision is one of:
 *   killed-runner        the runner died and nothing failed  -> retry
 *   real-failure         no shutdown marker                  -> leave alone
 *   mixed                runner died AND tests failed         -> leave alone, needs a human
 *   already-retried      attempt > 1                          -> leave alone, never loop
 *   no-log               nothing to judge on                  -> leave alone
 */
export function classify(log, attempt = 1) {
  // ⚠️ RETRY ONCE, NEVER IN A LOOP. A rerun emits another workflow_run event, so without this a
  // runner that keeps dying would retry forever and burn minutes indefinitely.
  if (attempt > 1) {
    return verdict('already-retried', false, false, null, null,
      `this is attempt ${attempt}; one automatic retry is the limit`);
  }
  if (!log || !log.trim()) {
    return verdict('no-log', false, false, null, null,
      'no log to judge on — retrying blind could hide a genuine failure');
  }

  const shutdown = log.includes(SHUTDOWN_MARKER);
  const failCount = lastCount(log, 'fail');
  const cancelledCount = lastCount(log, 'cancelled');

  if (!shutdown) {
    return verdict('real-failure', false, false, failCount, cancelledCount,
      'no runner-shutdown marker, so this red run means what it says');
  }
  // ★ THE LOAD-BEARING HALF. Requiring `fail 0` is what stops a genuinely red suite being retried
  // away just because it happened to be running when the runner died. A missing count is treated as
  // "not proven zero" and is NOT retried — the safe direction is always to leave red runs alone.
  if (failCount !== 0) {
    return verdict('mixed', false, true, failCount, cancelledCount,
      failCount === null
        ? 'the runner died, but no test summary was found — cannot prove nothing failed'
        : `the runner died, but ${failCount} test(s) genuinely failed first`);
  }
  return verdict('killed-runner', true, true, failCount, cancelledCount,
    `the runner was killed with ${cancelledCount ?? 0} test file(s) still in flight; nothing failed`);
}

function verdict(decision, retry, shutdown, failCount, cancelledCount, reason) {
  return { decision, retry, shutdown, failCount, cancelledCount, reason };
}

// Reads the LAST `<word> <n>` in the log — node's run summary, rather than an earlier per-file line.
//
// ⚠️ KEYED ON NODE'S SUMMARY MARKER (`ℹ` for the human reporter, `#` for TAP), NOT ON LINE POSITION.
// The first version anchored to the start of a line, which is wrong for the input this actually gets:
// `gh run view --log` prefixes EVERY line with `jobname<TAB>stepname<TAB>timestamp`, so nothing was
// ever at a line start and the count silently read `null` — which the caller treats as "cannot prove
// nothing failed", i.e. it would have refused to retry, always. Caught only by testing against a real
// captured log rather than a hand-written one.
//
// The marker is also what keeps a test NAME from being read as a count: an unanchored /fail (\d+)/
// would happily match a case titled "...fail 3 times...", but `ℹ fail 3` is the reporter's own line.
function lastCount(log, word) {
  const re = new RegExp(String.raw`[ℹ#]\s*${word}\s+(\d+)\b`, 'g');
  let last = null;
  for (const m of log.matchAll(re)) last = Number(m[1]);
  return last;
}

/** One-line summary for the workflow's step summary. */
export function summarise(v, runUrl) {
  const rows = [
    '| signal | value |',
    '|---|---|',
    `| runner shutdown marker | \`${v.shutdown ? 'present' : 'absent'}\` |`,
    `| tests that actually failed | \`${v.failCount ?? 'unknown'}\` |`,
    `| test files cancelled | \`${v.cancelledCount ?? 0}\` |`,
    `| decision | \`${v.decision}\` |`,
  ];
  const head = v.retry
    ? `### Not a test failure — retrying\n\nThe hosted runner was killed mid-job (issue #278). ${v.reason}.`
    : `### Not retried\n\n${v.reason}.`;
  return `${head}\n\n${rows.join('\n')}\n\n[run](${runUrl})\n`;
}

// CLI: log on stdin, verdict as JSON on stdout, and exit 10 when the caller should retry.
// Exit codes rather than stdout parsing, so the workflow cannot misread a decision.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('triage-killed-runner.mjs')) {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const v = classify(Buffer.concat(chunks).toString('utf8'), Number(process.env.RUN_ATTEMPT || 1));
  process.stdout.write(JSON.stringify(v) + '\n');
  process.exit(v.retry ? 10 : 0);
}
