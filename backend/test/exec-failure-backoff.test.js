// #553 phase 1: the two small rules in processGuards.js that media isolation needs from every supervisor.
//
//   execFailureBackoff  a wrapped child that cannot run its program exits 127 at once (setpriv's status, measured in the
//                       #553 spike), which Node reports as an ordinary 'exit'. The supervisors (MediaMTX, the transcoder,
//                       the clip segmenter) relaunched every 3-5 s forever on it; they now back off to a minute and log
//                       the first failure and every 10th. Any other exit keeps the supervisor's own delay exactly.
//   isKillError         Node reports a signal it could not deliver (EPERM) on the child's 'error' event, the same event
//                       a failed spawn uses; this tells them apart by the `syscall` Node sets.
// The wiring into each supervisor is media-supervision.test.js. The clock here is injected, so "at once" and "after a
// real run" are exact.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  execFailureBackoff, describeExecFailure, isKillError,
  EXEC_FAILED_EXIT_CODE, EXEC_FAILED_WITHIN_MS, EXEC_FAILED_MAX_DELAY_MS, EXEC_FAILED_RELOG_EVERY,
} from '../src/lib/processGuards.js';

function clock(start = 1_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

describe('#553 execFailureBackoff', () => {
  test('the documented numbers: 127, "at once" = within 5 s, cap 60 s, a line every 10th', () => {
    // Literals on purpose: a test that derived them from the constants would follow a mutated value.
    assert.equal(EXEC_FAILED_EXIT_CODE, 127);
    assert.equal(EXEC_FAILED_WITHIN_MS, 5_000);
    assert.equal(EXEC_FAILED_MAX_DELAY_MS, 60_000);
    assert.equal(EXEC_FAILED_RELOG_EVERY, 10);
  });

  test('127 at once, again and again: 5, 10, 20, 40 s, then capped at 60 s; logged on the 1st and every 10th', () => {
    const c = clock();
    const b = execFailureBackoff(5_000, { now: c.now });
    const delays = [];
    const logged = [];
    for (let i = 1; i <= 21; i++) {
      b.launched();
      c.advance(30); // setpriv fails in milliseconds
      const r = b.exited(127);
      assert.equal(r.execFailed, true, `launch ${i}`);
      assert.equal(r.streak, i);
      delays.push(r.delayMs);
      if (r.log) logged.push(i);
    }
    assert.deepEqual(delays.slice(0, 6), [5_000, 10_000, 20_000, 40_000, 60_000, 60_000]);
    assert.ok(delays.every((d) => d <= 60_000), 'a delay above the cap');
    assert.deepEqual(logged, [1, 10, 20]);
  });

  test('every other exit is the supervisor\'s own delay, logged as before, and it ends a run of 127s', () => {
    const c = clock();
    const b = execFailureBackoff(3_000, { now: c.now });
    for (const code of [1, 0, null, 126, 128, 255]) {
      b.launched();
      c.advance(10);
      assert.deepEqual(b.exited(code), { execFailed: false, delayMs: 3_000, streak: 0, log: true }, `code ${code}`);
    }
    // A run of 127s, broken by an ordinary exit, starts again from the base delay (and logs again).
    for (let i = 0; i < 3; i++) { b.launched(); c.advance(10); b.exited(127); }
    b.launched(); c.advance(10);
    assert.equal(b.exited(1).delayMs, 3_000);
    b.launched(); c.advance(10);
    assert.deepEqual(b.exited(127), { execFailed: true, delayMs: 3_000, streak: 1, log: true });
  });

  test('a 127 after a real run (5 s or more) is an ordinary exit, and one just inside 5 s is not', () => {
    const c = clock();
    const b = execFailureBackoff(5_000, { now: c.now });
    b.launched();
    c.advance(5_000);
    assert.equal(b.exited(127).execFailed, false, 'exactly 5 s is a real run');
    b.launched();
    c.advance(4_999);
    assert.equal(b.exited(127).execFailed, true, '4.999 s is "at once"');
  });

  test('an exit with no launch recorded is never taken for an exec failure', () => {
    const b = execFailureBackoff(5_000, { now: clock().now });
    assert.equal(b.exited(127).execFailed, false);
  });

  test('the log text names the program, the code, the retry and the cap, and counts a repeat', () => {
    const first = describeExecFailure('MediaMTX', { streak: 1, delayMs: 3_000 });
    assert.match(first, /^MediaMTX could not be run: it exited 127 at once\. /);
    assert.match(first, /Retrying in 3s, backing off to 60s\.$/);
    assert.match(describeExecFailure('ffmpeg', { streak: 10, delayMs: 60_000 }), /at once \(10 times in a row\)\..*Retrying in 60s/);
  });
});

describe('#553 isKillError', () => {
  // The shapes Node itself produces (lib/internal/child_process.js): ErrnoException(err, 'kill') from kill(), and
  // ErrnoException(err, 'spawn ' + file) from a failed spawn.
  test('a kill error is one, a spawn error and anything else are not', () => {
    assert.equal(isKillError(Object.assign(new Error('kill EPERM'), { code: 'EPERM', syscall: 'kill' })), true);
    assert.equal(isKillError(Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT', syscall: 'spawn ffmpeg' })), false);
    assert.equal(isKillError(Object.assign(new Error('spawn /app/media-exec.sh EACCES'), { code: 'EACCES', syscall: 'spawn /app/media-exec.sh' })), false);
    assert.equal(isKillError(new Error('no syscall at all')), false);
    assert.equal(isKillError(undefined), false);
  });
});
