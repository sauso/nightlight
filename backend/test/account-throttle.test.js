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
// `opts` is acquire's second argument: { known: false } is an invented name (the capped table).
function failTimes(throttle, key, n, opts) {
  for (let i = 0; i < n; i++) {
    const slot = throttle.acquire(key, opts);
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

  test('★ an account that reached its delay is eased by an hour of quiet to ONE guess short of the limit, not to zero', () => {
    const c = clock();
    const throttle = createAccountThrottle({ now: c.now });
    failTimes(throttle, 'alice', FREE_FAILURES);
    c.advance(DECAY_MS + 1);
    const guess = throttle.acquire('alice');
    assert.equal(guess.allowed, true, 'an hour of quiet should allow a guess');
    guess.fail();
    const next = throttle.acquire('alice');
    assert.equal(next.allowed, false, 'the whole free allowance came back after an hour');
    assert.equal(next.retryAfterSec, BASE_DELAY_MS / 1000, 'the account should be straight back at the base delay');
  });

  test('★ waiting out the decay again and again does NOT give 30 fresh guesses an hour (Opus review: 720 a day)', () => {
    // 30 quickly, then repeat "wait just over an hour, guess until refused". With a full reset that is 30 a cycle.
    const c = clock();
    const throttle = createAccountThrottle({ now: c.now });
    let guesses = 0;
    for (let cycle = 0; cycle < 24; cycle++) {
      c.advance(DECAY_MS + 1000);
      for (;;) {
        const slot = throttle.acquire('alice');
        if (!slot.allowed) break;
        guesses += 1;
        slot.fail();
      }
    }
    assert.ok(guesses <= 30 + 24 * 2, `${guesses} guesses in about a day; the documented bound is about 100`);
  });

  test('★ the best a guesser can do in a day is about 100 guesses (waiting out each delay exactly)', () => {
    const c = clock();
    const throttle = createAccountThrottle({ now: c.now });
    let guesses = 0;
    let elapsed = 0;
    const DAY = 24 * 60 * 60 * 1000;
    while (elapsed < DAY) {
      const slot = throttle.acquire('alice');
      if (slot.allowed) {
        guesses += 1;
        slot.fail();
        continue;
      }
      const wait = slot.retryAfterSec * 1000;
      c.advance(wait);
      elapsed += wait;
    }
    assert.ok(guesses >= 30 + 90 && guesses <= 30 + 110, `${guesses} guesses in a day (30 free, then one per 15 minutes)`);
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

  const INVENTED = { known: false };

  test('★ the invented-names table never grows past its cap, and room is made from the least valuable entries', () => {
    const throttle = createAccountThrottle({ now: clock().now, maxEntries: 3 });
    failTimes(throttle, 'delayed', FREE_FAILURES, INVENTED); // in its delay: must survive
    failTimes(throttle, 'one-typo', 1, INVENTED);
    failTimes(throttle, 'two-typos', 2, INVENTED);
    assert.equal(throttle.size(), 3);

    // A fourth name: the oldest entry that is NOT delayed is forgotten, never the delayed one.
    failTimes(throttle, 'newcomer', 1, INVENTED);
    assert.equal(throttle.size(), 3);
    assert.equal(throttle.acquire('delayed', INVENTED).allowed, false, 'the delayed entry was evicted to make room');
  });

  test('entries that decayed are dropped before anything live is', () => {
    const c = clock();
    const throttle = createAccountThrottle({ now: c.now, maxEntries: 2 });
    failTimes(throttle, 'old-typo', 1, INVENTED);
    c.advance(DECAY_MS + 1);
    failTimes(throttle, 'recent-typo', 1, INVENTED);
    failTimes(throttle, 'newcomer', 1, INVENTED); // table full: the decayed one goes, the recent one stays
    assert.equal(throttle.size(), 2);
    // It already has one failure; FREE_FAILURES - 1 more bring it to the free limit, so it is refused only if it kept it.
    failTimes(throttle, 'recent-typo', FREE_FAILURES - 1, INVENTED);
    assert.equal(throttle.acquire('recent-typo', INVENTED).allowed, false, 'the recent entry lost its failures');
  });

  test('★ a delayed entry that has aged out is eased and then evictable, so the table cannot stay full of them', () => {
    // Opus review of #868: with delayed entries protected for good, a full table never freed. Aged-out delayed entries
    // are eased to one short of the limit, which is evictable, so room comes back an hour after the fill stops.
    const c = clock();
    const throttle = createAccountThrottle({ now: c.now, maxEntries: 2 });
    failTimes(throttle, 'a', FREE_FAILURES, INVENTED);
    failTimes(throttle, 'b', FREE_FAILURES, INVENTED);
    assert.equal(throttle.size(), 2);
    c.advance(DECAY_MS + 1);
    const slot = throttle.acquire('c', INVENTED);
    assert.equal(slot.allowed, true);
    slot.fail();
    // 'c' is TRACKED (it took a place), not waved through: it has one failure on record.
    failTimes(throttle, 'c', FREE_FAILURES - 1, INVENTED);
    assert.equal(throttle.acquire('c', INVENTED).allowed, false, 'the newcomer was not tracked once room had freed');
    assert.equal(throttle.size(), 2);
  });

  test('★ when the invented-names table is full of protected entries a newcomer is NOT tracked (it reaches no account)', () => {
    const throttle = createAccountThrottle({ now: clock().now, maxEntries: 2 });
    failTimes(throttle, 'a', FREE_FAILURES, INVENTED);
    failTimes(throttle, 'b', FREE_FAILURES, INVENTED);
    const slot = throttle.acquire('c', INVENTED);
    assert.equal(slot.allowed, true, 'a guess at an invented name was refused');
    slot.fail();
    assert.equal(throttle.size(), 2, 'the table grew past its cap');
    assert.equal(throttle.acquire('a', INVENTED).allowed, false);
    assert.equal(throttle.acquire('b', INVENTED).allowed, false);
  });

  test('★ REAL accounts are never refused, evicted or reset by a flood of invented names', () => {
    // The shape of the Opus finding: 10,000 invented names (here 3) held "in flight" or delayed must not touch a real
    // account in either direction. The target keeps its own 30 guesses; it is not refused (no household-wide lock-out)
    // and not given more (no eviction), and the flood does not clear what it already has.
    const throttle = createAccountThrottle({ now: clock().now, maxEntries: 3 });
    failTimes(throttle, 'target', 5); // a real account with 5 failures on record
    const flood = ['x1', 'x2', 'x3'].map((name) => throttle.acquire(name, INVENTED)); // table full, all in flight
    for (let i = 0; i < 50; i++) throttle.acquire(`more-${i}`, INVENTED).fail(); // untracked, allowed
    let through = 0;
    for (let i = 0; i < 100; i++) {
      const slot = throttle.acquire('target');
      if (slot.allowed) { through += 1; slot.fail(); }
    }
    assert.equal(through, FREE_FAILURES - 5, 'the real account did not keep exactly its remaining free guesses');
    flood.forEach((slot) => slot.release());
  });

  test('★ a real account that nobody has mistyped is NOT refused while the invented table is full', () => {
    const throttle = createAccountThrottle({ now: clock().now, maxEntries: 2 });
    failTimes(throttle, 'a', FREE_FAILURES, INVENTED);
    failTimes(throttle, 'b', FREE_FAILURES, INVENTED);
    const slot = throttle.acquire('someone-real');
    assert.equal(slot.allowed, true, 'a real account with a clean record was refused during the flood');
    slot.succeed();
  });

  test('★ an entry with a guess in flight is never evicted, and its outcome still counts', () => {
    const throttle = createAccountThrottle({ now: clock().now, maxEntries: 1 });
    const inFlight = throttle.acquire('a', INVENTED);
    throttle.acquire('b', INVENTED).fail(); // table full and its only entry is in flight: 'b' is untracked
    assert.equal(throttle.size(), 1, 'the in-flight entry was evicted to make room');
    inFlight.fail();
    // 'a' kept its entry, so its failure is on record: FREE_FAILURES - 1 more bring it to the limit.
    failTimes(throttle, 'a', FREE_FAILURES - 1, INVENTED);
    assert.equal(throttle.acquire('a', INVENTED).allowed, false, 'the failure of an in-flight guess was lost');
  });

  test('a name is tracked in one table: reset() clears it whichever table it was in', () => {
    const throttle = createAccountThrottle({ now: clock().now });
    failTimes(throttle, 'real', FREE_FAILURES);
    failTimes(throttle, 'ghost', FREE_FAILURES, INVENTED);
    throttle.reset('real');
    throttle.reset('ghost');
    assert.equal(throttle.size(), 0);
  });

  test('a missing key is the empty string, not a crash', () => {
    const throttle = createAccountThrottle({ now: clock().now });
    failTimes(throttle, undefined, FREE_FAILURES);
    assert.equal(throttle.acquire('').allowed, false);
    throttle.reset(null);
    assert.equal(throttle.acquire(undefined).allowed, true);
  });
});
