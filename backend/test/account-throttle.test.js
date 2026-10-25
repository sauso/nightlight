// The per-account password throttle (#553), tested on its own with a fake clock so nothing sleeps.
// The route-level proof (a forged X-Forwarded-For cannot get past it) is login-account-throttle.test.js; this
// file pins the rules the routes rely on, one observable behaviour each.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createAccountThrottle, FREE_FAILURES, BASE_DELAY_MS, MAX_DELAY_MS, DECAY_MS,
} from '../src/lib/accountThrottle.js';

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

// Fail `n` guesses one after another against `key`.
function failTimes(throttle, key, n) {
  for (let i = 0; i < n; i++) {
    const slot = throttle.acquire(key);
    assert.equal(slot.allowed, true, `guess ${i + 1} should have been allowed`);
    slot.fail();
  }
}

describe('the free guesses', () => {
  test('★ the first FREE_FAILURES wrong guesses are all allowed, the next one is refused', () => {
    const throttle = createAccountThrottle({ now: clock().now });
    failTimes(throttle, 'alice', FREE_FAILURES);
    const refused = throttle.acquire('alice');
    assert.equal(refused.allowed, false, 'a guess past the free ones went through immediately');
    assert.ok(refused.retryAfterSec >= 1);
  });

  test('the defaults are the documented ones', () => {
    // docs/mfa.md states these; a silent change here would make the document wrong.
    assert.equal(FREE_FAILURES, 30);
    assert.equal(BASE_DELAY_MS, 60_000);
    assert.equal(MAX_DELAY_MS, 15 * 60_000);
    assert.equal(DECAY_MS, 60 * 60_000);
  });

  test('one account failing does not slow another', () => {
    const throttle = createAccountThrottle({ now: clock().now });
    failTimes(throttle, 'alice', FREE_FAILURES);
    assert.equal(throttle.acquire('alice').allowed, false);
    assert.equal(throttle.acquire('bob').allowed, true);
  });
});

describe('the delay', () => {
  test('★ it starts at the base delay, doubles per further wrong guess, and stops at the cap', () => {
    const c = clock();
    const throttle = createAccountThrottle({ now: c.now });
    failTimes(throttle, 'alice', FREE_FAILURES);

    // After the FREE_FAILURES-th failure the wait is BASE_DELAY_MS; each later failure doubles it.
    const expected = [60, 120, 240, 480, 900, 900, 900];
    for (const seconds of expected) {
      const refused = throttle.acquire('alice');
      assert.equal(refused.allowed, false);
      assert.equal(refused.retryAfterSec, seconds, `wanted a ${seconds}s wait`);
      c.advance(seconds * 1000);
      const slot = throttle.acquire('alice');
      assert.equal(slot.allowed, true, 'the guess after the delay must be allowed');
      slot.fail();
    }
  });

  test('★ a refused request counts as nothing: hammering cannot lengthen the delay', () => {
    const c = clock();
    const throttle = createAccountThrottle({ now: c.now });
    failTimes(throttle, 'alice', FREE_FAILURES);
    for (let i = 0; i < 200; i++) assert.equal(throttle.acquire('alice').allowed, false);
    c.advance(BASE_DELAY_MS);
    assert.equal(throttle.acquire('alice').allowed, true, 'refused attempts pushed the delay out');
  });

  test('Retry-After counts down as time passes (rounded up to whole seconds)', () => {
    const c = clock();
    const throttle = createAccountThrottle({ now: c.now });
    failTimes(throttle, 'alice', FREE_FAILURES);
    c.advance(10_500);
    assert.equal(throttle.acquire('alice').retryAfterSec, 50); // 49.5 s left, rounded up
  });

  test('★ a huge failure count cannot overflow past the cap', () => {
    const c = clock();
    const throttle = createAccountThrottle({ now: c.now, freeFailures: 1, decayMs: Infinity });
    for (let i = 0; i < 80; i++) {
      c.advance(MAX_DELAY_MS + 1);
      const slot = throttle.acquire('alice');
      assert.equal(slot.allowed, true, `guess ${i + 1}`);
      slot.fail();
    }
    const refused = throttle.acquire('alice');
    assert.equal(refused.allowed, false);
    assert.equal(refused.retryAfterSec, MAX_DELAY_MS / 1000, 'the delay was not capped');
  });
});

describe('what ends or forgives a run of failures', () => {
  test('★ a correct password resets the account', () => {
    const throttle = createAccountThrottle({ now: clock().now });
    failTimes(throttle, 'alice', FREE_FAILURES - 1);
    throttle.acquire('alice').succeed();
    // A full set of free guesses is available again.
    failTimes(throttle, 'alice', FREE_FAILURES);
    assert.equal(throttle.acquire('alice').allowed, false);
  });

  test('a correct password also lifts a running delay (reachable only after it has ended)', () => {
    const c = clock();
    const throttle = createAccountThrottle({ now: c.now });
    failTimes(throttle, 'alice', FREE_FAILURES);
    c.advance(BASE_DELAY_MS);
    throttle.acquire('alice').succeed();
    assert.equal(throttle.acquire('alice').allowed, true);
    assert.equal(throttle.size(), 1, 'the account should be tracked only while a guess is in flight');
  });

  test('★ an hour without a failure forgets the account, so old typos never add up', () => {
    const c = clock();
    const throttle = createAccountThrottle({ now: c.now });
    failTimes(throttle, 'alice', FREE_FAILURES - 1);
    c.advance(DECAY_MS + 1);
    failTimes(throttle, 'alice', FREE_FAILURES - 1);
    assert.equal(throttle.acquire('alice').allowed, true, 'failures older than the decay still counted');
  });

  test('just inside the decay window the failures still count', () => {
    const c = clock();
    const throttle = createAccountThrottle({ now: c.now });
    failTimes(throttle, 'alice', FREE_FAILURES - 1);
    c.advance(DECAY_MS - 1000);
    failTimes(throttle, 'alice', 1);
    assert.equal(throttle.acquire('alice').allowed, false);
  });

  test('reset() empties one account and leaves the others', () => {
    const throttle = createAccountThrottle({ now: clock().now });
    failTimes(throttle, 'alice', FREE_FAILURES);
    failTimes(throttle, 'bob', FREE_FAILURES);
    throttle.reset('alice');
    assert.equal(throttle.acquire('alice').allowed, true);
    assert.equal(throttle.acquire('bob').allowed, false);
  });

  test('clear() empties everything', () => {
    const throttle = createAccountThrottle({ now: clock().now });
    failTimes(throttle, 'alice', FREE_FAILURES);
    throttle.clear();
    assert.equal(throttle.size(), 0);
    assert.equal(throttle.acquire('alice').allowed, true);
  });
});

describe('reservations (the concurrency rule)', () => {
  test('★ parallel guesses cannot exceed the free ones: they are reserved before any outcome is known', () => {
    const throttle = createAccountThrottle({ now: clock().now });
    // 50 requests arrive before any compare has finished. Only FREE_FAILURES may be let through.
    const slots = Array.from({ length: 50 }, () => throttle.acquire('alice'));
    assert.equal(slots.filter((s) => s.allowed).length, FREE_FAILURES);
    const refused = slots.find((s) => !s.allowed);
    assert.equal(refused.retryAfterSec, 1, 'a refusal caused only by guesses still in flight should say "try again in a second"');
  });

  test('a reservation given back (release) frees the place and counts as no failure', () => {
    const throttle = createAccountThrottle({ now: clock().now });
    const slots = Array.from({ length: FREE_FAILURES }, () => throttle.acquire('alice'));
    assert.equal(throttle.acquire('alice').allowed, false);
    slots[0].release();
    const again = throttle.acquire('alice');
    assert.equal(again.allowed, true, 'a released reservation was not freed');
    again.release();
    slots.slice(1).forEach((s) => s.release());
    assert.equal(throttle.size(), 0, 'released slots left an entry behind');
    failTimes(throttle, 'alice', FREE_FAILURES); // would be refused earlier if release had counted as a failure
  });

  test('★ in the delay zone only ONE guess may be in flight at a time', () => {
    const c = clock();
    const throttle = createAccountThrottle({ now: c.now });
    failTimes(throttle, 'alice', FREE_FAILURES);
    c.advance(BASE_DELAY_MS);
    const first = throttle.acquire('alice');
    assert.equal(first.allowed, true);
    const second = throttle.acquire('alice');
    assert.equal(second.allowed, false, 'two guesses were let through one expired delay');
    first.fail();
    c.advance(2 * BASE_DELAY_MS);
    assert.equal(throttle.acquire('alice').allowed, true);
  });

  test('a slot settles exactly once: later calls are no-ops', () => {
    const throttle = createAccountThrottle({ now: clock().now });
    const slot = throttle.acquire('alice');
    slot.fail();
    slot.fail();
    slot.succeed();
    slot.release();
    // Only one failure was recorded, so FREE_FAILURES - 1 more are still free and one more is refused.
    failTimes(throttle, 'alice', FREE_FAILURES - 1);
    assert.equal(throttle.acquire('alice').allowed, false);
  });

  test('an in-flight failure that lands after a successful sign-in counts from zero', () => {
    const throttle = createAccountThrottle({ now: clock().now });
    const slow = throttle.acquire('alice');
    throttle.acquire('alice').succeed();
    slow.fail();
    failTimes(throttle, 'alice', FREE_FAILURES - 1);
    assert.equal(throttle.acquire('alice').allowed, false, 'the late failure was lost');
  });
});

describe('memory is bounded', () => {
  test('★ keys are cut to a fixed length, so a huge username cannot make a huge entry', () => {
    const throttle = createAccountThrottle({ now: clock().now });
    failTimes(throttle, 'x'.repeat(5000), FREE_FAILURES);
    // The same first 256 characters share an entry; a different tail past that is the same account to the throttle.
    assert.equal(throttle.acquire('x'.repeat(5000) + 'different tail').allowed, false);
  });

  test('★ the table never grows past its cap, and room is made from the least valuable entries', () => {
    const throttle = createAccountThrottle({ now: clock().now, maxEntries: 3 });
    failTimes(throttle, 'delayed', FREE_FAILURES); // in its delay: must survive
    failTimes(throttle, 'one-typo', 1);
    failTimes(throttle, 'two-typos', 2);
    assert.equal(throttle.size(), 3);

    // A fourth name: the oldest account that is NOT delayed is forgotten, never the delayed one.
    failTimes(throttle, 'newcomer', 1);
    assert.equal(throttle.size(), 3);
    assert.equal(throttle.acquire('delayed').allowed, false, 'the delayed account was evicted to make room');
  });

  test('entries that decayed are dropped before anything live is', () => {
    const c = clock();
    const throttle = createAccountThrottle({ now: c.now, maxEntries: 2 });
    failTimes(throttle, 'old-typo', 1);
    c.advance(DECAY_MS + 1);
    failTimes(throttle, 'recent-typo', 1);
    failTimes(throttle, 'newcomer', 1); // table full: the decayed one goes, the recent one stays
    assert.equal(throttle.size(), 2);
    // It already has one failure; FREE_FAILURES - 1 more bring it to the free limit, so it is refused only if it kept it.
    failTimes(throttle, 'recent-typo', FREE_FAILURES - 1);
    assert.equal(throttle.acquire('recent-typo').allowed, false, 'the recent account lost its failures');
  });

  test('★ when every entry is protected a newcomer is simply not tracked (never an unbounded table)', () => {
    const throttle = createAccountThrottle({ now: clock().now, maxEntries: 2 });
    failTimes(throttle, 'a', FREE_FAILURES);
    failTimes(throttle, 'b', FREE_FAILURES);
    const slot = throttle.acquire('c');
    assert.equal(slot.allowed, true);
    slot.fail();
    assert.equal(throttle.size(), 2, 'the table grew past its cap');
    assert.equal(throttle.acquire('a').allowed, false);
    assert.equal(throttle.acquire('b').allowed, false);
  });

  test('an entry with a guess in flight is never evicted', () => {
    const throttle = createAccountThrottle({ now: clock().now, maxEntries: 1 });
    const inFlight = throttle.acquire('a');
    const other = throttle.acquire('b'); // table full and its only entry is in flight: untracked
    assert.equal(other.allowed, true);
    assert.equal(throttle.size(), 1);
    inFlight.release();
  });

  test('a missing key is the empty string, not a crash', () => {
    const throttle = createAccountThrottle({ now: clock().now });
    failTimes(throttle, undefined, FREE_FAILURES);
    assert.equal(throttle.acquire('').allowed, false);
    throttle.reset(null);
    assert.equal(throttle.acquire(undefined).allowed, true);
  });
});
