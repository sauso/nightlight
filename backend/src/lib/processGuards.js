import { logger } from './logger.js';

// Keeping the monitor alive when one background task fails.
//
// THE DEFECT THIS EXISTS FOR (issue #254). The 15s camera watchdog and the 30s audio watchdog are
// `setInterval(async () => { ... })`. An async callback handed to setInterval returns a promise that
// NOTHING holds, so a rejection inside it is an unhandled rejection — and Node's default for that is to
// terminate the process. There were no `unhandledRejection`/`uncaughtException` handlers anywhere in the
// backend, so any rejection in a watchdog tick killed a baby monitor, at night, unattended.
//
// WHERE A REJECTION ACTUALLY COMES FROM — corrected after adversarial review of PR #275, because the
// first version of this comment was WRONG and it matters that the next person is not misled.
//
// I originally claimed the crash was reachable from every watchdog via `upsertPath`, which is a bare
// `fetch` that also throws on a non-2xx. That is only half true, and the half asserted loudest was
// false. `startTranscoder` ALREADY catches it (transcoder.js:135, `.catch(...)`), and everything else
// it awaits swallows its own errors — `isPathConfiguredCorrectly` and `getPathStatus` both return a
// falsy default from a `catch`. So `startTranscoder` has no demonstrated rejection path at all, which
// means the AUDIO watchdog has none either. The issue's original framing — one bare call site — was
// closer to right than the rebuttal to it.
//
// What IS demonstrated:
//   1. `subStream.js:38` — the one genuinely bare `await upsertPath(path)`. Reached only from the
//      camera watchdog, and self-correlated: MediaMTX being down is exactly what leaves a sub path
//      unready for 30s, which is the ONLY condition that reaches it.
//   2. `db.prepare('SELECT * FROM cameras').all()` at the top of EVERY tick. better-sqlite3 throws
//      synchronously — SQLITE_BUSY, a locked or corrupted file — and a synchronous throw inside an
//      async callback rejects the same floating promise. This is why all three intervals are guarded
//      and not just the sub-stream one: the shared first line of every tick can throw.
//
// The guard is therefore defence in depth with one proven trigger, not the three first claimed.
// One place to report a swallowed failure, so every guard reads the same in the log viewer. Exported
// because the per-camera guard is a plain try/catch at the call site rather than a wrapper: the loop
// bodies use `continue`, which is legal inside a try but cannot cross a function boundary, so wrapping
// them in a callback would mean rewriting control flow that is not what this change is about.
export function reportGuardFailure(label, err) {
  const detail = err instanceof Error ? err.stack || err.message : String(err);
  // logger.error, deliberately, not info: the log viewer's Errors filter is a substring match on
  // "error" (LogViewer.jsx), so downgrading the level would hide guard reports from the one view an
  // operator opens when something is wrong — while the comment above still claimed "logged loudly".
  const now = Date.now();
  const seen = lastLogged.get(label);
  if (seen && now - seen.at < RELOG_INTERVAL_MS) {
    seen.suppressed += 1;
    return;
  }
  const note = seen?.suppressed ? ` (+${seen.suppressed} more in the last ${Math.round((now - seen.at) / 1000)}s)` : '';
  lastLogged.set(label, { at: now, suppressed: 0 });
  logger.error(`[guard:${label}] background task failed (continuing)${note}: ${detail}`);
}

// Test seam ONLY — the rate limiter is per-label module state, so a suite that reports the same label
// twice would otherwise see the second one suppressed and pass for the wrong reason.
export function resetGuardRateLimit() {
  lastLogged.clear();
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

// Rate limiting, per label. A guard does not fix the fault it catches, so a repeating timer keeps
// hitting it: a throw at startSubStream skips the `subNotReadySince.delete` below it, so the camera
// watchdog retries every 15s FOREVER with no backoff — 2 lines/tick/camera is ~960 lines/hour at two
// cameras, into logger.js's 1000-line ring. It would evict every other line inside the hour, which is
// the precedent already set in mediamtxProcess.js: a log that scrolls away the evidence of the fault
// it is reporting is worse than no log. So: loud the first time, then roughly once a minute per label.
// Found by adversarial review of PR #275, which measured the eviction.
const RELOG_INTERVAL_MS = 60_000;
const lastLogged = new Map(); // label -> { at, suppressed }

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
let installed = false;
let bootComplete = false;

// ⚠️ BOOT AND STEADY STATE NEED DIFFERENT ANSWERS, and the first version of this gave one answer to
// both. Found by adversarial review of PR #275, which demonstrated it: with the guards installed at
// index.js:71 and ~500 lines (including `app.listen`) still to run, a synchronous throw during startup
// was caught and swallowed, so the process either
//   - exited 0 — which LOOKS like a clean shutdown, so Docker's `on-failure` restart policy does not
//     restart it, or
//   - kept running with the watchdog timers registered (they are set up before listen) and NO HTTP
//     SERVER BOUND: a green container, a total outage, and no crash loop to notice.
// Both are worse than crashing. Before the app is serving, a fault is a failed start and the honest
// thing is to exit NON-ZERO so the container restarts. After it is serving, degraded-but-running beats
// gone. `markBootComplete()` is the switch, called once `app.listen` has actually bound.
function onFault(kind, err) {
  reportGuardFailure(kind, err);
  if (!bootComplete) {
    logger.error(`[guard:${kind}] this happened during startup, before the server was listening — exiting non-zero so the container restarts rather than sitting there looking healthy.`);
    process.exit(1);
  }
}

// Call once the HTTP server is actually accepting connections. Until then a fault is a failed start.
export function markBootComplete() {
  bootComplete = true;
}

export function installCrashGuards() {
  // Idempotent. Every other starter in this repo self-guards, and without this each extra call added a
  // duplicate handler: measured at 3 duplicate log lines per fault after 3 calls, and a
  // MaxListenersExceededWarning at 12. Returns false if it was already installed.
  if (installed) return false;
  installed = true;
  process.on('unhandledRejection', (reason) => onFault('unhandledRejection', reason));
  process.on('uncaughtException', (err) => onFault('uncaughtException', err));
  return true;
}
