import { logger } from './logger.js';

// Keeping the monitor alive when one background task fails.
//
// THE DEFECT THIS EXISTS FOR (issue #254). The 15s camera watchdog and the 30s audio watchdog are
// `setInterval(async () => { ... })`. An async callback handed to setInterval returns a promise that
// NOTHING holds, so a rejection inside it is an unhandled rejection — and Node's default for that is to
// terminate the process. There were no `unhandledRejection`/`uncaughtException` handlers anywhere in the
// backend, so any rejection in a watchdog tick killed a baby monitor, at night, unattended.
//
// It is worse than a random crash, because the fault is CORRELATED WITH ITSELF. `upsertPath` (mediamtx.js)
// is a bare `fetch` that also throws on a non-2xx, and it is reached from `startSubStream` AND from
// `startTranscoder` (which upserts the sibling HLS path). MediaMTX being down or mid-restart is precisely
// what leaves a path unready for 30s — which is the ONLY condition that reaches those calls. So the
// watchdog crashed the app exactly when it was trying to heal the thing it exists to heal, and
// mediamtxProcess.js restarts MediaMTX after 3s, making the window recurring rather than one-off.
//
// ⚠️ The issue described this as "a single missing .catch() at the one call site that isn't guarded".
// That undercounts it: there are THREE unguarded `setInterval(async …)` bodies and two distinct throwing
// calls (`startSubStream` and `startTranscoder`), so the crash is reachable from the main watchdog and
// the audio watchdog too, not just the sub-stream leg.

// One place to report a swallowed failure, so every guard reads the same in the log viewer. Exported
// because the per-camera guard is a plain try/catch at the call site rather than a wrapper: the loop
// bodies use `continue`, which is legal inside a try but cannot cross a function boundary, so wrapping
// them in a callback would mean rewriting control flow that is not what this change is about.
export function reportGuardFailure(label, err) {
  const detail = err instanceof Error ? err.stack || err.message : String(err);
  logger.error(`[guard:${label}] background task failed (continuing): ${detail}`);
}

// setInterval for an async callback. A sync throw or a rejected promise is logged and the timer KEEPS
// RUNNING — a watchdog that stops watching after one bad tick would silently stop healing anything,
// which is the same outage in slow motion.
//
// Returns the timer, so callers can clearInterval/unref it exactly as before.
export function safeInterval(label, ms, fn) {
  return setInterval(() => {
    let result;
    try {
      result = fn();
    } catch (err) {
      // A synchronous throw before the first await — e.g. the `db.prepare(...)` at the top of a tick.
      reportGuardFailure(label, err);
      return;
    }
    // `fn` is normally async; guard the thenable case without assuming it.
    if (result && typeof result.then === 'function') result.then(undefined, (err) => reportGuardFailure(label, err));
  }, ms);
}

// Last-resort process-level backstop, installed once at startup.
//
// ⚠️ DELIBERATE, AND NOT NODE'S DEFAULT ADVICE. The usual guidance is that a process should exit on an
// uncaught exception because its state is unknowable. That trade is different here: this is an
// unattended overnight baby monitor, where a process exit is a real outage that a parent discovers by
// finding a blank screen at 3am, and where EVERY uncaught throw actually seen in this codebase came from
// child-process plumbing (a spawn that failed, kill() on a child that never started — see #257) with the
// rest of the app perfectly healthy. Degraded and running beats correct and gone. The failure is logged
// loudly so it is visible in the log viewer rather than silently absorbed.
//
// This is a BACKSTOP, not a licence to leave call sites unguarded — guard the call site as well, so the
// failure is reported with the context of what was being attempted.
export function installCrashGuards() {
  process.on('unhandledRejection', (reason) => {
    reportGuardFailure('unhandledRejection', reason);
  });
  process.on('uncaughtException', (err) => {
    reportGuardFailure('uncaughtException', err);
  });
}
