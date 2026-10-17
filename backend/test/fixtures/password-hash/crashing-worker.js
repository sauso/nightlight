// A stand-in for src/lib/passwordHashWorker.js that can be made to CRASH (an uncaught exception, so the
// parent sees 'error' and then 'exit', exactly as a real crash would). Used by crash-then-call.mjs.
//   compare('crash', ...)  -> throws outside any try/catch: the worker dies
//   anything else          -> answers with the password string after 200 ms, so the job is still pending
//                             for a while after it is submitted
import { parentPort } from 'node:worker_threads';

parentPort.on('message', ({ id, args }) => {
  if (args[0] === 'crash') {
    setTimeout(() => {
      throw new Error('fixture worker crashed');
    }, 0);
    return;
  }
  setTimeout(() => parentPort.postMessage({ id, result: args[0] }), 200);
});
