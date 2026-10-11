// Express 4 does not look at the promise an `async` route handler returns. If one rejects (or throws
// before its own try/catch), nothing is listening: the request is left with NO response, the client's
// spinner never resolves, and behind Cloudflare the user eventually sees a bodiless 524. The process
// guard (lib/processGuards.js) only logs the unhandled rejection and carries on, which is why it went
// unnoticed (issue #544: PUT /api/cameras/:id with a deleted child_id, PUT /api/pushover/config with a
// non-string token, POST /api/cameras with a non-string name all hung).
//
// `asyncHandler(fn)` hands a rejection to `next(err)`, which reaches the error middleware mounted last in
// index.js (middleware/errorHandler.js) and so ends in a JSON response. EVERY `async` route handler in
// src/routes must be wrapped; the class guard at the bottom of backend/test/async-errors.test.js walks the
// real router stacks and fails for an `async` function registered directly, so a new route cannot quietly
// bring the hang back.
//
// Calls `fn` SYNCHRONOUSLY (not inside `Promise.resolve().then(...)`) so a handler's timing is exactly what
// it was before it was wrapped: nothing that answered in the same tick now answers a microtask later.
// A plain (non-async) handler that throws synchronously is caught too; Express already does that for it,
// so this only matters if someone wraps one by habit.

// Marks the function this returns so a test can tell "wrapped" from "an async function that happens to be
// registered", without relying on the function's name.
export const WRAPPED = Symbol.for('nightlight.asyncHandler');

// Express treats `next(<falsy>)` as "no error, carry on to the next route", so a handler that rejects with
// undefined / null / 0 / '' (`Promise.reject()`, `throw undefined`) would fall through to the 404 page with
// nothing logged: the same silent failure this file exists to remove. Give it a real Error instead.
const asError = (e) => e || new Error('Handler rejected without a value');

export function asyncHandler(fn) {
  if (typeof fn !== 'function') throw new TypeError('asyncHandler needs a function');
  // Three declared parameters on purpose: Express tells an error handler from a normal one by
  // `fn.length === 4`, and this must never be mistaken for one.
  const wrapped = function asyncHandlerWrapper(req, res, next) {
    try {
      Promise.resolve(fn(req, res, next)).catch((e) => next(asError(e)));
    } catch (err) {
      next(asError(err));
    }
  };
  wrapped[WRAPPED] = true;
  return wrapped;
}
