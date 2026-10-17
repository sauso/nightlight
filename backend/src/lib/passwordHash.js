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
import { Worker } from 'node:worker_threads';

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
    hash: (password, cost = 10) => run('hash', [password, cost]),
    compare: (password, hashed) => run('compare', [password, hashed]),
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
