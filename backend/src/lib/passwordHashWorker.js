// Runs INSIDE the worker thread started by passwordHash.js. Plain bcryptjs, synchronous API: blocking is
// exactly what we want here, because this thread has nothing else to do and the main thread is free.
import { parentPort } from 'node:worker_threads';
import bcrypt from 'bcryptjs';

parentPort.on('message', ({ id, op, args }) => {
  try {
    const result = op === 'hash' ? bcrypt.hashSync(...args) : bcrypt.compareSync(...args);
    parentPort.postMessage({ id, result });
  } catch (e) {
    parentPort.postMessage({ id, error: e?.message || String(e) });
  }
});
