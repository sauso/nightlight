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
// refused request counts as nothing, so hammering cannot lengthen the delay. The count LEAKS: one wrong guess is
// forgiven for every LEAK_MS without a new one (a leaky bucket), so old typos fade and a guesser can never get more
// than a burst of FREE_FAILURES plus one guess per LEAK_MS, however they pace themselves.
//
// ⚠️ THE TRADE, stated plainly because #248 rejected an account-only key for it and the owner has now accepted it
// (for this one control): anyone who can reach the login form can use up an account's free guesses and so slow
// that person's own sign-in, and can do it again whenever the delay ends, so the slowdown lasts as long as they keep
// doing it. They cannot guess faster. The ways out (docs/mfa.md, "Password guesses"): wait (never more than
// MAX_DELAY_MS), change the password (empties the account at once), or restart the container (the store is in
// memory).
//
// TWO TABLES, because of what a flood of invented usernames can do (Codex, Opus and Astra reviews of #868, each
// verified by running). The caller says whether the name is a real account (`known`):
//   * REAL accounts live in a table with NO cap. Only an admin creates accounts, so it is bounded by the accounts that
//     exist or have existed since the container started (a deleted or renamed account's entry is dropped by the leak
//     when it is next looked at, or on restart). NOTHING an attacker sends can refuse, evict or reset a real
//     account's entry. The first design had one capped table: a flood of invented names pushed real accounts' entries
//     out (a fresh 30 guesses), and then "fail closed" for a full table refused EVERY account without an entry,
//     household-wide, with only a restart as a way out. Real keys are not truncated (two long real names that share a
//     prefix must not share a counter).
//   * INVENTED names (they match no account, so a guess at one is a guess at nothing) live in a table capped at
//     MAX_ENTRIES, with keys cut to MAX_KEY_LENGTH. They are tracked only so that an invented name is throttled like a
//     real one (an unknown name should not be told apart by its answer). When that table is full of protected
//     entries a new invented name is simply NOT tracked: the guess reaches no account, so letting it through costs
//     nothing. ⚠️ KNOWN LIMIT: this cannot be perfectly indistinguishable at bounded memory. An attacker who sends
//     about MAX_ENTRIES requests with fresh invented names can evict an invented candidate's count, whereas a real
//     account keeps its own, and so learn whether a name is real (Astra review of #868, verified by reading).
//     Usernames are not secrets in this app and the probe costs ~10,000 requests per batch; it is documented in
//     docs/mfa.md and not hidden.
//
// NUMBERS. A hypothesis for one household's use, not a measurement:
//   * FREE_FAILURES = 30: the same figure as PER_USER_MFA_LIMIT, and above the per-source 20 in routes/auth.js, so
//     one device mistyping meets its own per-source limit first and this only engages for a guesser spread over many
//     (or forged) addresses, or a long run of wrong passwords over more than one 15-minute window.
//   * BASE_DELAY_MS = 60 s, doubling to MAX_DELAY_MS = 15 min: once past the free guesses an attacker is held to at
//     most one guess a minute, then (from the 5th delayed guess) one every 15 minutes. 15 min is also the window
//     every other limiter here uses.
//   * LEAK_MS = 15 min per forgiven guess. The bound for ANY pacing is FREE_FAILURES + (elapsed / LEAK_MS): 30 plus
//     96 a day, about 126 in the first day and 96 a day after. Two earlier designs got this wrong, each verified by
//     running: forgetting an account after an hour of quiet gave a fresh 30 every hour (~720 a day), and easing only
//     accounts that had reached the limit let a guesser stop at 29 and still refill (~696 a day). A leak has no
//     all-at-once reset to wait out. A person with 30 failures is back to none after 7.5 hours; a correct password
//     resets at once.
//   * MAX_ENTRIES = 10,000 invented names tracked (see above).
//
// CONCURRENCY. Hashing a password yields (a worker thread, see passwordHash), so N parallel requests could all
// pass a check-then-record before any failure is recorded and so get N guesses through one gate. `acquire`
// RESERVES the attempt synchronously, before the caller's first await, and the reservation counts against the
// free guesses; in the delay zone only one attempt may be in flight at a time. The slot is settled exactly once by
// fail / succeed / release (the later calls are no-ops), so a `finally { slot.release() }` is always safe.

export const FREE_FAILURES = 30;
export const BASE_DELAY_MS = 60 * 1000;
export const MAX_DELAY_MS = 15 * 60 * 1000;
export const LEAK_MS = 15 * 60 * 1000;
export const MAX_ENTRIES = 10_000;
// A made-up username can be any length; its key is what is stored, so it is bounded. (Real names are not cut.)
const MAX_KEY_LENGTH = 256;

const UNTRACKED = Object.freeze({
  allowed: true,
  fail() {},
  succeed() {},
  release() {},
});

export function createAccountThrottle({
  // Read at call time, not captured: a caller (or a test) that replaces the clock after this is built is still obeyed.
  now = () => Date.now(),
  freeFailures = FREE_FAILURES,
  baseDelayMs = BASE_DELAY_MS,
  maxDelayMs = MAX_DELAY_MS,
  leakMs = LEAK_MS,
  maxEntries = MAX_ENTRIES,
} = {}) {
  // key -> { fails, lastFailAt, blockedUntil, inflight }
  const knownEntries = new Map(); // real accounts: no cap
  const unknownEntries = new Map(); // invented names: capped at maxEntries

  // The delay that follows the failure that brought the account to `fails` wrong guesses (fails >= freeFailures).
  // The exponent is clamped so a huge count cannot overflow to Infinity before the cap applies.
  function delayAfter(fails) {
    const exponent = Math.min(fails - freeFailures, 30);
    return Math.min(maxDelayMs, baseDelayMs * 2 ** exponent);
  }

  const idle = (entry) => entry.inflight === 0 && entry.fails === 0;

  // Forgive one wrong guess per leakMs since the last one, keeping the remainder of the time (so forgiving never
  // gives back more than the time that passed). An entry with a request in flight is left alone: that request will
  // settle against the count it was admitted under.
  function leak(entry, t) {
    if (entry.inflight > 0 || entry.fails === 0) return;
    const steps = Math.floor((t - entry.lastFailAt) / leakMs);
    if (steps <= 0) return;
    entry.fails = Math.max(0, entry.fails - steps);
    entry.lastFailAt += steps * leakMs;
    // The delay is never longer than one leak step, so once a step has passed the delay has too.
    if (entry.fails < freeFailures) entry.blockedUntil = 0;
  }

  // Make room in the invented-names table without helping an attacker: leak what has gone quiet, then evict the
  // oldest entry that has NOT reached its delay. Never one in its delay, never one with a request in flight.
  function makeRoom(map, t) {
    for (const [key, entry] of map) {
      leak(entry, t);
      if (idle(entry)) map.delete(key);
    }
    if (map.size < maxEntries) return true;
    for (const [key, entry] of map) {
      if (entry.inflight === 0 && entry.fails < freeFailures) {
        map.delete(key);
        return true;
      }
    }
    return false;
  }

  function denied(retryAfterSec) {
    return { allowed: false, retryAfterSec: Math.max(1, retryAfterSec) };
  }

  function acquire(rawKey, { known = true } = {}) {
    const t = now();
    const full = String(rawKey ?? '');
    const key = known ? full : full.slice(0, MAX_KEY_LENGTH);
    const map = known ? knownEntries : unknownEntries;
    let entry = map.get(key);
    if (entry) {
      leak(entry, t);
      if (idle(entry)) {
        map.delete(key);
        entry = undefined;
      }
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
      // Only the invented-names table has a cap. When it is full of protected entries the guess is not tracked: it
      // reaches no account (see the header), so nothing is gained by it.
      if (!known && map.size >= maxEntries && !makeRoom(map, t)) return UNTRACKED;
      entry = { fails: 0, lastFailAt: 0, blockedUntil: 0, inflight: 0 };
      map.set(key, entry);
    }
    entry.inflight += 1;

    let settled = false;
    const settle = (apply) => {
      if (settled) return;
      settled = true;
      entry.inflight -= 1;
      apply();
      // An entry nothing is waiting on and with no failures holds no information.
      if (idle(entry) && map.get(key) === entry) map.delete(key);
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
      const full = String(rawKey ?? '');
      knownEntries.delete(full);
      unknownEntries.delete(full.slice(0, MAX_KEY_LENGTH));
    },
    clear() {
      knownEntries.clear();
      unknownEntries.clear();
    },
    size: () => knownEntries.size + unknownEntries.size,
  };
}
