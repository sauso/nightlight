// bcrypt on a request path, OFF the main event loop (#548).
//
// WHY A WORKER AND NOT bcrypt.hash()/compare(). The obvious fix, bcryptjs's async API, does not work, and
// the issue assumed it would ("bcryptjs yields between rounds"). Measured on bcryptjs 2.4.3: it yields
// only after `MAX_EXECUTION_TIME = 100` ms of work, and a cost-10 compare takes ~82 ms, so it never
// yields at all: compare() and compareSync() both left a gap of ~82 ms with no timer firing. The async
// call is only a promise wrapped around the same blocked loop. (Cost 12 would yield once per 100 ms,
// which is still a 100 ms stall.) A native bcrypt would work but is a new binary dependency in a public
// image built for amd64 and arm64; a worker thread running the SAME bcryptjs needs nothing new, produces
// the same hashes, and keeps the cost factor at 10.
//
// ONE persistent worker, deliberately: it serialises hashing, so a flood of login attempts queues behind
// one thread instead of fanning out across every core the camera pipeline is also using. The attempt
// limiters in routes/auth.js bound how many requests get here at all.
//
// The worker is unref()'d so it never keeps the process (or a test run) alive, started on first use, and
// replaced if it dies. A request in flight when it dies is rejected, which the route turns into a 500
// through asyncHandler, the same as any other unexpected failure; the next request gets a fresh worker.
//
// ⚠️ EACH WORKER OWNS ITS OWN PENDING JOBS (review of #720, verified by running). A crashing worker emits
// 'error' and then, later, 'exit'. A call made between the two already starts the NEXT worker. With one
// map shared by every worker, the old worker's 'exit' rejected that new call ("worker stopped") although
// it had never touched the old worker, and the new worker was never unref'd again (its answer found no
// pending entry), so the process could not exit. So the map is created per worker, and a dying worker
// fails only the jobs it was given.
//
// createPasswordHasher() exists so a test can run this exact logic against a worker that crashes on
// demand; the app only uses the default hasher below (hash, compare, stopPasswordWorker).
//
// ⚠️ A PASSWORD THAT IS NOT VALID TEXT NEVER REACHES bcrypt (found in the review of #1094, verified by running).
// A JSON body can carry an unpaired UTF-16 surrogate ("\ud800": half of a pair, alone), and bcryptjs 2.4.3's own
// UTF-8 conversion does not handle one: instead of failing at once it fails slowly, holding the ONE worker that every
// sign-in queues on, and then throws (a 500). No real password contains one (a keyboard, a password manager and a
// paste all produce whole characters; an emoji is a well-formed PAIR and is fine), so it is refused here, centrally,
// before a job is queued:
//   * compare() answers false at once: a sign-in or a confirmation answers exactly as for a wrong password, and is
//     counted like one. Nothing stored can match it anyway: bcryptjs has always failed on one, so no stored hash
//     was ever made from one.
//   * hash() rejects with UnusablePasswordError, a 400 the error handler shows as is (middleware/errorHandler.js
//     honours its `status` and `expose`), so a route that forgets its own early check still answers the caller's
//     400, unlogged, instead of a 500. The routes that set a password check first (routes/auth.js,
//     refusedUnusablePassword), so the refusal comes before their other work.
// Non-strings are left alone: bcrypt rejects them itself, at once, as it always has.
import { Worker } from 'node:worker_threads';

export const UNUSABLE_PASSWORD_MESSAGE = 'That password contains characters that cannot be used';

export class UnusablePasswordError extends Error {
  constructor() {
    super(UNUSABLE_PASSWORD_MESSAGE);
    this.name = 'UnusablePasswordError';
    this.status = 400;
    this.expose = true;
  }
}

// True for a string that is not well-formed UTF-16 (an unpaired surrogate anywhere in it). Node 24 (the only
// supported version, package.json `engines`) has String.prototype.isWellFormed.
export function isUnusablePassword(password) {
  return typeof password === 'string' && !password.isWellFormed();
}

export function createPasswordHasher(workerUrl) {
  let current = null; // { worker, pending } for the live worker, or null before first use / after it died
  let nextId = 1;
  let submitted = 0;

  function start() {
    const w = new Worker(workerUrl);
    const pending = new Map(); // THIS worker's jobs only: see the warning above
    const entry = { worker: w, pending };
    const failAll = (err) => {
      for (const { reject } of pending.values()) reject(err);
      pending.clear();
    };
    w.on('message', ({ id, result, error }) => {
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      if (pending.size === 0) w.unref();
      if (error !== undefined) p.reject(new Error(error));
      else p.resolve(result);
    });
    // 'error' fires for an uncaught exception in the worker, 'exit' for every end. Either way the worker is
    // gone: forget it so the next call starts a new one, and don't leave its callers waiting forever.
    w.on('error', (err) => {
      if (current === entry) current = null;
      failAll(err);
    });
    w.on('exit', () => {
      if (current === entry) current = null;
      failAll(new Error('Password hashing worker stopped'));
    });
    // Idle workers must not keep the process alive (seen: a script that hashed once never exited), but one
    // with a call in flight must, or a script awaiting a hash would exit under it. So: unref now, and
    // run() refs it only while something is pending. Done AFTER the listeners: attaching a 'message'
    // listener re-refs the worker.
    w.unref();
    return entry;
  }

  function run(op, args) {
    current ??= start();
    const { worker, pending } = current;
    const id = nextId++;
    submitted += 1;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.ref();
      worker.postMessage({ id, op, args });
    });
  }

  return {
    // The guard is here, before run(), so a refused password queues no job and is not counted in `submitted`.
    hash: (password, cost = 10) =>
      (isUnusablePassword(password) ? Promise.reject(new UnusablePasswordError()) : run('hash', [password, cost])),
    compare: (password, hashed) => (isUnusablePassword(password) ? Promise.resolve(false) : run('compare', [password, hashed])),
    // Stops the live worker; the next call starts a new one.
    stop: () => (current ? current.worker.terminate() : Promise.resolve()),
    // Read-only counters for tests: jobs ever submitted, and jobs the live worker has not answered yet.
    // A test uses `pending` to know a request has reached its bcrypt await (and cannot resume before that
    // job is answered), and `submitted` to count how much hashing a burst of requests caused.
    stats: () => ({ submitted, pending: current ? current.pending.size : 0 }),
  };
}

const passwordHasher = createPasswordHasher(new URL('./passwordHashWorker.js', import.meta.url));

// Same arguments and results as bcryptjs's hashSync / compareSync.
export const hash = (password, cost = 10) => passwordHasher.hash(password, cost);
export const compare = (password, hashed) => passwordHasher.compare(password, hashed);

// Stops the worker. Tests use it to prove recovery; the next call starts a new one.
export function stopPasswordWorker() {
  return passwordHasher.stop();
}

// Test-only counters for the app's hasher; see stats() above. Nothing in the app reads them.
export function passwordWorkerStats() {
  return passwordHasher.stats();
}
