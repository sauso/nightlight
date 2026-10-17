// Run in its OWN process by mfa-replay-and-async-bcrypt.test.js (review of #720, defect H), because one
// of the two things it checks is that the process can exit at all.
//
// 1. A job is given to a worker that crashes. Its rejection is delivered by the worker's 'error' handler.
// 2. The next call is made straight from that rejection, which runs BEFORE the dead worker's 'exit' event
//    (a promise continuation queued in 'error' runs first; measured on Node 24), so it starts a NEW worker
//    while the old one has not finished dying. Its answer takes 200 ms, so it is still pending when the
//    old worker's 'exit' fires.
// With one pending map shared by all workers, that 'exit' rejected the new job ("worker stopped") and the
// new worker stayed ref'd forever, so this process never exited. stop() is NOT called on purpose.
import { createPasswordHasher } from '../../../src/lib/passwordHash.js';

const hasher = createPasswordHasher(new URL('./crashing-worker.js', import.meta.url));
const crashed = await hasher.compare('crash', 'x').then(() => 'resolved', (e) => e.message);
const next = await hasher.compare('answer', 'x').then((r) => `resolved:${r}`, (e) => `rejected:${e.message}`);
process.stdout.write(JSON.stringify({ crashed, next }));
