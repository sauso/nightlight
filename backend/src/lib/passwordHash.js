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
import { Worker } from 'node:worker_threads';

let worker = null;
let nextId = 1;
const pending = new Map();

function failAll(err) {
  for (const { reject } of pending.values()) reject(err);
  pending.clear();
}

function start() {
  const w = new Worker(new URL('./passwordHashWorker.js', import.meta.url));
  w.on('message', ({ id, result, error }) => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (pending.size === 0) w.unref();
    if (error !== undefined) p.reject(new Error(error));
    else p.resolve(result);
  });
  // 'error' fires for an uncaught exception in the worker, 'exit' for every end. Either way the worker is
  // gone: forget it so the next call starts a new one, and don't leave callers waiting forever.
  w.on('error', (err) => {
    if (worker === w) worker = null;
    failAll(err);
  });
  w.on('exit', () => {
    if (worker === w) worker = null;
    failAll(new Error('Password hashing worker stopped'));
  });
  // Idle workers must not keep the process alive (seen: a script that hashed once never exited), but one
  // with a call in flight must, or a script awaiting a hash would exit under it. So: unref now, and
  // settle()/run() ref it only while something is pending. Done AFTER the listeners: attaching a
  // 'message' listener re-refs the worker.
  w.unref();
  return w;
}

function run(op, args) {
  worker ??= start();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.ref();
    worker.postMessage({ id, op, args });
  });
}

// Same arguments and results as bcryptjs's hashSync / compareSync.
export const hash = (password, cost = 10) => run('hash', [password, cost]);
export const compare = (password, hashed) => run('compare', [password, hashed]);

// Stops the worker. Tests use it to prove recovery; the next call starts a new one.
export function stopPasswordWorker() {
  return worker ? worker.terminate() : Promise.resolve();
}
