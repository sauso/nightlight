// Per-ACCOUNT throttle for the places that CHECK A PASSWORD (#553, owner decision 2026-10-25).
//
// THE GAP IT CLOSES. Every limiter on the password routes in routes/auth.js includes the caller's IP in its key
// (`ip|account`, issue #248). That is right for a remote caller, whose address the server reads from the socket,
// but `index.js` trusts `X-Forwarded-For` from loopback by default (TRUST_PROXY=loopback), and a process on
// 127.0.0.1:4000 can put anything it likes in that header. The media programs (ffmpeg, ffprobe, MediaMTX) parse
// bytes a camera sends; once they are a separate Unix user that could still reach the app on loopback, a flaw in
// one of them would hand an attacker an unlimited password guesser: a fresh `ip|account` bucket per request. The
// MFA second step already has an account-only bound (PER_USER_MFA_LIMIT, #550); the password step had none.
//
// WHAT IT IS. A counter of FAILED guesses per account, whatever the source address. Up to FREE_FAILURES wrong
// guesses are free; from then on each further wrong guess is only allowed after a DELAY that doubles, up to
// MAX_DELAY_MS. A correct password resets the account. While a delay runs the answer is 429 + Retry-After, and a
// refused request counts as nothing, so hammering cannot lengthen the delay.
//
// ⚠️ THE TRADE, stated plainly because #248 rejected an account-only key for it and the owner has now accepted it
// (for this one control): anyone who can reach the login form can use up an account's free guesses and so slow
// that person's own sign-in, and can do it again whenever the delay ends, so the slowdown lasts as long as they keep
// doing it. They cannot guess faster. The ways out (docs/mfa.md, "Password guesses"): wait (never more than
// MAX_DELAY_MS), change the password (empties the account at once), or restart the container (the store is in
// memory).
//
// NUMBERS. A hypothesis for one household's use, not a measurement:
//   * FREE_FAILURES = 30: the same figure as PER_USER_MFA_LIMIT, and above the per-source 20 in routes/auth.js, so
//     a single honest device always meets its own per-source limit first and this only ever engages for a guesser
//     spread over many (or forged) addresses. A person mistyping a password does not come near it.
//   * BASE_DELAY_MS = 60 s, doubling to MAX_DELAY_MS = 15 min: once past the free guesses an attacker is held to at
//     most one guess a minute, then (from the 5th delayed guess) one every 15 minutes, 96 a day, which is no use
//     against a password of any real length. 15 min is also the window every other limiter here uses.
//   * DECAY_MS = 1 h without a failure forgets the account, so old typos never accumulate into a delay.
//   * MAX_ENTRIES = 10,000 accounts tracked. Entries exist only for accounts with failures, are dropped when they
//     decay or the person signs in, and a username the attacker invents costs one small entry. Known limits: an
//     attacker who fills the table with invented names can push a not-yet-delayed account out and so give it a
//     fresh set of free guesses (delayed accounts, and accounts with a guess being checked, are never evicted);
//     doing that takes thousands of requests per fresh set of 30, each costing the server a password hash. And if
//     every entry is protected at once (10,000 accounts delayed or being checked), new attempts are refused for a
//     second at a time until room frees: the table fails closed, never open.
//
// CONCURRENCY. Hashing a password yields (a worker thread, see passwordHash), so N parallel requests could all
// pass a check-then-record before any failure is recorded and so get N guesses through one gate. `acquire`
// RESERVES the attempt synchronously, before the caller's first await, and the reservation counts against the
// free guesses; in the delay zone only one attempt may be in flight at a time. The slot is settled exactly once by
// fail / succeed / release (the later calls are no-ops), so a `finally { slot.release() }` is always safe.

export const FREE_FAILURES = 30;
export const BASE_DELAY_MS = 60 * 1000;
export const MAX_DELAY_MS = 15 * 60 * 1000;
export const DECAY_MS = 60 * 60 * 1000;
export const MAX_ENTRIES = 10_000;
// A submitted username can be any length; the key is what is stored, so it is bounded.
const MAX_KEY_LENGTH = 256;

export function createAccountThrottle({
  // Read at call time, not captured: a caller (or a test) that replaces the clock after this is built is still obeyed.
  now = () => Date.now(),
  freeFailures = FREE_FAILURES,
  baseDelayMs = BASE_DELAY_MS,
  maxDelayMs = MAX_DELAY_MS,
  decayMs = DECAY_MS,
  maxEntries = MAX_ENTRIES,
} = {}) {
  // key -> { fails, lastFailAt, blockedUntil, inflight }
  const entries = new Map();

  // The delay that follows the failure that brought the account to `fails` wrong guesses (fails >= freeFailures).
  // The exponent is clamped so a huge count cannot overflow to Infinity before the cap applies.
  function delayAfter(fails) {
    const exponent = Math.min(fails - freeFailures, 30);
    return Math.min(maxDelayMs, baseDelayMs * 2 ** exponent);
  }

  const decayed = (entry, t) => entry.inflight === 0 && entry.fails > 0 && t - entry.lastFailAt > decayMs;
  const idle = (entry) => entry.inflight === 0 && entry.fails === 0;

  // Make room for one more entry without helping an attacker: forget what is already forgotten, then the oldest
  // account that has NOT yet reached its delay. Never an account in its delay, never one with a request in flight.
  function makeRoom(t) {
    for (const [key, entry] of entries) {
      if (idle(entry) || decayed(entry, t)) entries.delete(key);
    }
    if (entries.size < maxEntries) return true;
    for (const [key, entry] of entries) {
      if (entry.inflight === 0 && entry.fails < freeFailures) {
        entries.delete(key);
        return true;
      }
    }
    return false;
  }

  function denied(retryAfterSec) {
    return { allowed: false, retryAfterSec: Math.max(1, retryAfterSec) };
  }

  function acquire(rawKey) {
    const t = now();
    const key = String(rawKey ?? '').slice(0, MAX_KEY_LENGTH);
    let entry = entries.get(key);
    if (entry && decayed(entry, t)) {
      entries.delete(key);
      entry = undefined;
    }
    if (entry) {
      if (entry.fails >= freeFailures) {
        // In the delay zone: not before the delay is over, and one probe at a time.
        if (t < entry.blockedUntil) return denied(Math.ceil((entry.blockedUntil - t) / 1000));
        if (entry.inflight > 0) return denied(1);
      } else if (entry.fails + entry.inflight >= freeFailures) {
        // Every remaining free guess is already in flight; the next one is only known after they settle.
        return denied(1);
      }
    } else {
      if (entries.size >= maxEntries && !makeRoom(t)) {
        // Every entry is protected (in a delay, or a guess is being checked). FAIL CLOSED: refuse for a second rather
        // than let the guess through untracked, which was the first design and was wrong (Codex review of #868,
        // verified by running): checks queue behind one password-hash worker, so a flood of invented names can hold
        // thousands of entries "in flight" for minutes, and an untracked fallback then gave any account unlimited
        // guesses for as long as the flood lasted. Refusing costs real people a second's wait during such a flood,
        // when sign-in is slow for everyone anyway.
        return denied(1);
      }
      entry = { fails: 0, lastFailAt: 0, blockedUntil: 0, inflight: 0 };
      entries.set(key, entry);
    }
    entry.inflight += 1;

    let settled = false;
    const settle = (apply) => {
      if (settled) return;
      settled = true;
      entry.inflight -= 1;
      apply();
      // An entry nothing is waiting on and with no failures holds no information.
      if (idle(entry) && entries.get(key) === entry) entries.delete(key);
    };
    return {
      allowed: true,
      fail() {
        settle(() => {
          const t2 = now();
          entry.fails += 1;
          entry.lastFailAt = t2;
          if (entry.fails >= freeFailures) entry.blockedUntil = t2 + delayAfter(entry.fails);
        });
      },
      succeed() {
        settle(() => {
          entry.fails = 0;
          entry.blockedUntil = 0;
        });
      },
      // For an attempt that proved nothing about the password (a server error, a row that changed under it).
      release() {
        settle(() => {});
      },
    };
  }

  return {
    acquire,
    // A password change empties the account: the person has a new secret and the old guesses mean nothing.
    reset(rawKey) {
      entries.delete(String(rawKey ?? '').slice(0, MAX_KEY_LENGTH));
    },
    clear() {
      entries.clear();
    },
    size: () => entries.size,
  };
}
