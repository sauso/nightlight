// The per-account password throttle (#553), tested on its own with a fake clock so nothing sleeps.
// The route-level proof (a forged X-Forwarded-For cannot get past it) is login-account-throttle.test.js; this
// file pins the rules the routes rely on, one observable behaviour each.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createAccountThrottle, FREE_FAILURES, BASE_DELAY_MS, MAX_DELAY_MS, LEAK_MS,
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
    assert.equal(LEAK_MS, 15 * 60_000);
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
    const throttle = createAccountThrottle({ now: c.now, freeFailures: 1, leakMs: Infinity });
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

  test('★ one wrong guess is forgiven for every LEAK_MS of quiet (a leaky bucket)', () => {
    const c = clock();
    const throttle = createAccountThrottle({ now: c.now });
    failTimes(throttle, 'alice', FREE_FAILURES - 1); // 29 on record
    c.advance(3 * LEAK_MS + 1000); // three steps pass, with a remainder that must be kept
    // 29 - 3 = 26 on record, so four more guesses are free and the fifth is refused.
    failTimes(throttle, 'alice', 4);
    assert.equal(throttle.acquire('alice').allowed, false, 'more than three guesses were forgiven');
  });

  test('just inside one step nothing is forgiven', () => {
    const c = clock();
    const throttle = createAccountThrottle({ now: c.now });
    failTimes(throttle, 'alice', FREE_FAILURES - 1);
    c.advance(LEAK_MS - 1000);
    failTimes(throttle, 'alice', 1);
    assert.equal(throttle.acquire('alice').allowed, false);
  });

  test('★ enough quiet forgets the account completely, and an idle account leaves no entry', () => {
    const c = clock();
    const throttle = createAccountThrottle({ now: c.now });
    failTimes(throttle, 'alice', FREE_FAILURES - 1);
    c.advance((FREE_FAILURES - 1) * LEAK_MS + 1);
    const slot = throttle.acquire('alice');
    assert.equal(slot.allowed, true);
    slot.release();
    assert.equal(throttle.size(), 0, 'a fully forgiven account kept an entry');
    failTimes(throttle, 'alice', FREE_FAILURES); // a whole fresh allowance
    assert.equal(throttle.acquire('alice').allowed, false);
  });

  test('★ the remainder of a step is kept, so forgiving never gives back more time than passed', () => {
    const c = clock();
    const throttle = createAccountThrottle({ now: c.now });
    failTimes(throttle, 'alice', FREE_FAILURES - 1); // 29
    c.advance(LEAK_MS + LEAK_MS / 2); // 1.5 steps: one forgiven now
    throttle.acquire('alice').release(); // looks at the account: 28 left, half a step banked
    c.advance(LEAK_MS / 2); // the banked half plus this half is a second step
    failTimes(throttle, 'alice', 3); // 27 + 3 = 30 reached only if exactly two were forgiven
    assert.equal(throttle.acquire('alice').allowed, false, 'the half step was lost or counted twice');
  });

  test('★ stopping short of the limit and waiting does NOT refill the allowance (Astra review: ~696 a day)', () => {
    // The pattern that beat "forget after an hour": 29 wrong guesses, wait just over an hour, repeat. With a leak an
    // hour forgives four, however close to the limit the guesser stops. Greedy guesser: guess whenever allowed.
    const c = clock();
    const throttle = createAccountThrottle({ now: c.now });
    let guesses = 0;
    for (let cycle = 0; cycle < 24; cycle++) {
      for (;;) {
        const slot = throttle.acquire('alice');
        if (!slot.allowed) break;
        guesses += 1;
        slot.fail();
      }
      c.advance(60 * 60 * 1000 + 1000);
    }
    assert.ok(guesses <= 30 + 24 * 4 + 4, `${guesses} guesses in about a day; the bound is 30 plus 4 an hour`);
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
  test('★ keys of INVENTED names are cut to a fixed length, so a huge made-up username cannot make a huge entry', () => {
    const throttle = createAccountThrottle({ now: clock().now });
    failTimes(throttle, 'x'.repeat(5000), FREE_FAILURES, { known: false });
    // The same first 256 characters share an entry; a different tail past that is the same name to the throttle.
    assert.equal(throttle.acquire('x'.repeat(5000) + 'different tail', { known: false }).allowed, false);
  });

  test('★ keys of REAL accounts are NOT cut: two long names that share a 256-character prefix are two accounts', () => {
    // Astra review of #868: POST /users has no length limit, so cutting a real key let one account's good sign-in
    // reset another's count.
    const throttle = createAccountThrottle({ now: clock().now });
    const prefix = 'x'.repeat(300);
    failTimes(throttle, `${prefix}a`, FREE_FAILURES);
    assert.equal(throttle.acquire(`${prefix}a`).allowed, false);
    const other = throttle.acquire(`${prefix}b`);
    assert.equal(other.allowed, true, 'a different long name shared the first account\'s count');
    other.succeed();
    assert.equal(throttle.acquire(`${prefix}a`).allowed, false, 'a good sign-in on one name reset the other');
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

  test('entries that have leaked away are dropped before anything live is', () => {
    const c = clock();
    const throttle = createAccountThrottle({ now: c.now, maxEntries: 2 });
    failTimes(throttle, 'old-typo', 1, INVENTED);
    c.advance(LEAK_MS + 1); // one forgiven guess: the single typo is gone
    failTimes(throttle, 'recent-typo', 1, INVENTED);
    failTimes(throttle, 'newcomer', 1, INVENTED); // table full: the decayed one goes, the recent one stays
    assert.equal(throttle.size(), 2);
    // It already has one failure; FREE_FAILURES - 1 more bring it to the free limit, so it is refused only if it kept it.
    failTimes(throttle, 'recent-typo', FREE_FAILURES - 1, INVENTED);
    assert.equal(throttle.acquire('recent-typo', INVENTED).allowed, false, 'the recent entry lost its failures');
  });

  test('★ a delayed entry that has leaked below the limit is evictable, so the table cannot stay full of them', () => {
    // Opus review of #868: with delayed entries protected for good, a full table never freed. An entry that has
    // leaked one step is below the limit, which is evictable, so room comes back once the fill has stopped.
    const c = clock();
    const throttle = createAccountThrottle({ now: c.now, maxEntries: 2 });
    failTimes(throttle, 'a', FREE_FAILURES, INVENTED);
    failTimes(throttle, 'b', FREE_FAILURES, INVENTED);
    assert.equal(throttle.size(), 2);
    c.advance(LEAK_MS + 1);
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

  test('KNOWN LIMIT (pinned so it is never silently worse): a flood of fresh invented names can tell a real name from an invented one', () => {
    // Astra review of #868, verified by reading. Bounded memory cannot make the two perfectly alike: filling the invented
    // table evicts an invented candidate's count but never a real account's. Documented in docs/mfa.md with its cost
    // (about MAX_ENTRIES requests per probe). If this ever stops being true, update the docs; if it gets WORSE (fewer
    // requests, or a real count lost), this fails.
    const cap = 5;
    const probe = (known) => {
      const throttle = createAccountThrottle({ now: clock().now, maxEntries: cap });
      failTimes(throttle, 'candidate', FREE_FAILURES - 1, { known }); // 29 on record
      for (let i = 0; i < cap; i++) failTimes(throttle, `fresh-${i}`, 1, INVENTED); // the flood: `cap` fresh names
      let allowed = 0;
      for (let i = 0; i < 3; i++) {
        const slot = throttle.acquire('candidate', { known });
        if (slot.allowed) { allowed += 1; slot.fail(); }
      }
      return allowed;
    };
    assert.equal(probe(true), 1, 'a real account lost or gained guesses because of the flood');
    assert.equal(probe(false), 3, 'the invented candidate was expected to be evicted by a flood of `cap` fresh names');
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
