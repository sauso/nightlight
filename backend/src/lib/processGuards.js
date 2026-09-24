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
// it awaits swallows its own errors — `isPathConfiguredCorrectly` returns `false`, or `null` for a call
// MediaMTX never answered (#451), and `getPathStatus` returns a not-ready status, all from a `catch`. So
// `startTranscoder` has no demonstrated rejection path at all, which means the AUDIO watchdog has none
// either. The issue's original framing — one bare call site — was closer to right than the rebuttal to it.
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
// because it is called from other modules too: the watchdogs' sub-leg try/catch (lib/cameraWatchdogs.js)
// and MediaMTX API timeouts (lib/mediamtx.js). The per-camera guard itself now lives in perTargetRunner
// below: #451 moved the watchdog loop bodies into functions, so `continue` became `return` and the
// objection that kept them inline (a `continue` cannot cross a function boundary) no longer applies.
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

// Signal a child process, but ONLY if it is a real OS process. Returns true if a signal was sent.
//
// ★★★ THIS IS NOT DEFENSIVE TIDYING — the unguarded call is a self-inflicted outage on Linux, which is
// the only platform Nightlight actually ships on.
//
// `spawn()` returns synchronously and its 'error' arrives on a later tick, so there is a ~5ms window in
// which a launch that CANNOT WORK (no ffmpeg on PATH, an unrunnable binary) is represented by a
// ChildProcess with `pid === undefined` and a libuv handle whose internal pid is 0. Every stop path
// here can land in that window — `stopSegmenter`, `stopTranscoder`, the detector stops, `stopMediaMTX`
// — because reconcile, a settings save or a shutdown can all fire immediately after a start.
//
// What `kill()` then does depends on the platform, and the difference is the whole point:
//   * win32 — throws `Error: kill EINVAL`. Uncaught, that is the #257 crash class one layer down. Every
//     one of those call sites already wraps the kill in try/catch for exactly this, and their comments
//     say so.
//   * POSIX — does NOT throw. It calls `kill(0, SIGTERM)`, and `kill(0, …)` means **"signal every
//     process in my own process group"**. So the backend SIGTERMs itself, MediaMTX, every FFmpeg and
//     anything else sharing the group. try/catch cannot help: nothing throws, it just dies.
//
// Measured 2026-09-06 in a `node:24` container: the test suite terminated with exit 143 at the first
// `stopAllSegmenters` over two failed spawns, taking `node --test`, its parent and the invoking shell
// with it. That is what had been failing CI as "the runner has received a shutdown signal". Guarding
// the kill on `pid` made the same run exit 0. It is invisible on Windows, where the throw is caught.
//
// `pid` is the right discriminator and the only one available: it is set only once the child really
// exists, and a real child can never have pid 0. The try/catch stays for the win32 throw and for a
// process reaped between the check and the call.
export function killIfSpawned(proc, signal = 'SIGTERM') {
  if (!proc?.pid) return false;
  try {
    return proc.kill(signal);
  } catch {
    return false; // reaped between the check and the call, or the win32 EINVAL above
  }
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

// One pending check per camera, and only a few at once (issue #451).
//
// THE DEFECT. safeInterval above does not wait for the previous tick (a timer cannot), and the camera and
// audio watchdogs had no in-flight guard. Against a MediaMTX that accepted connections and never answered,
// every 15s tick added one more pending loop; when the stall cleared they all resumed together, and each
// restarted the same camera. startTranscoder is not safe under two concurrent calls for one camera (both
// stop, both launch, and the second orphans the first FFmpeg), so that pile-up was real harm, not noise.
//
// THE RULES, each pinned by a P-case in test/process-guards.test.js:
//   * At most ONE pending check per key, ever (AC2). A key still in flight is SKIPPED, never queued a second
//     time. It is marked when QUEUED, not when started, so a target still waiting in one run's queue cannot
//     also be picked up by the next run.
//   * NO escape hatch. The first plan restarted a check pending for 2 minutes; Codex's plan review showed
//     that is still an unbounded backlog if the old check never ends. A long-pending check is only REPORTED
//     (rate-limited) when skipped. That is safe because every await inside a watchdog check is now bounded
//     (#451 gave the MediaMTX calls a deadline, the last unbounded step), and the report makes the
//     should-never-happen case visible instead of silent.
//   * A worker pool of `concurrency`, so one camera's stalled request cannot hold up the others (AC3) and a
//     MediaMTX-wide outage cannot start a restart for every camera at once (Codex P1).
//     ⚠️ KNOWN LIMIT of that pool (Codex code review of #451, SHOULD; P10 pins it): with more targets than
//     workers and the first `concurrency` of them stuck, the later ones WAIT for a free worker. Every real
//     check is bounded, so the wait is bounded too, by one check's worst case per batch of `concurrency`,
//     but it is a limit on AC3 for installs with more than 4 cameras. Not redesigned, deliberately.
//   * A per-target try/catch reporting `${label}:${name}`: the SAME labels the inline loops in index.js
//     used, so `[guard:camera-watchdog:Nursery]` in KNOWN-ISSUES.md stays true. run() never rejects.
//   * A skip is a MISSED OBSERVATION (Codex round 2, P0). `onSkip(target)` tells the caller, and the pending
//     check's `ctx.skipped` flips to true, so a check that resumes after a later tick skipped over it knows
//     its readings no longer form an unbroken run.
//
// ⚠️ Serialisation is per RUNNER. The camera watchdog has two (its main and sub legs) and the audio
// watchdog one, so this does not stop the camera watchdog, the audio watchdog, reconcile and the camera
// routes calling startTranscoder for one camera at the same time; that predates #451 and is a follow-up
// of its own.

// ⚠️ A HYPOTHESIS, NOT A MEASUREMENT. Typical installs have 1-4 cameras, so they are checked fully in
// parallel; bigger ones are bounded. The shape of the load did change: before #451 cameras were checked
// one at a time, now up to 4 at once per runner (the camera watchdog's main and sub legs each have one).
export const WATCHDOG_CONCURRENCY = 4;
// Past this, skipping a still-pending check is reported. 8 camera-watchdog intervals: well past anything
// the bounded awaits in a check can add up to, so a report means something unexpected is holding it.
export const STALE_RUN_MS = 2 * 60 * 1000;

/**
 * @param {string} label  guard label prefix, e.g. 'camera-watchdog'
 * @returns {(targets, keyOf, nameOf, fn, opts?) => Promise<void>} `run`; fn is called as fn(target, ctx)
 *   where `ctx.skipped` reads live. `opts.onSkip(target)` fires for each target skipped as in flight.
 */
export function perTargetRunner(label, { concurrency = WATCHDOG_CONCURRENCY, staleAfterMs = STALE_RUN_MS, now = Date.now } = {}) {
  const inFlight = new Map(); // key -> { since, skipped }

  return async function run(targets, keyOf, nameOf, fn, { onSkip } = {}) {
    const queue = [];
    for (const target of targets) {
      const key = keyOf(target);
      const pending = inFlight.get(key);
      if (pending) {
        pending.skipped = true;
        const pendingMs = now() - pending.since;
        if (pendingMs >= staleAfterMs) {
          reportGuardFailure(
            `${label}:stale:${nameOf(target)}`,
            `previous check still running after ${Math.round(pendingMs / 1000)}s; skipped, not stacked`
          );
        }
        if (onSkip) {
          try {
            onSkip(target);
          } catch (skipErr) {
            reportGuardFailure(`${label}:${nameOf(target)}`, skipErr);
          }
        }
        continue;
      }
      const entry = { since: now(), skipped: false };
      inFlight.set(key, entry);
      queue.push({ target, key, entry });
    }

    let next = 0;
    const worker = async () => {
      while (next < queue.length) {
        const { target, key, entry } = queue[next++];
        const ctx = { get skipped() { return entry.skipped; } };
        try {
          // Inside the try, so a SYNCHRONOUS throw from fn is caught too, not only a rejection.
          await fn(target, ctx);
        } catch (err) {
          reportGuardFailure(`${label}:${nameOf(target)}`, err);
        } finally {
          if (inFlight.get(key) === entry) inFlight.delete(key);
        }
      }
    };
    const workers = [];
    for (let i = 0; i < Math.min(concurrency, queue.length); i++) workers.push(worker());
    await Promise.all(workers);
  };
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
