import { spawnAsApp } from './childEnv.js';
import { tailnetEnableBlocker } from './tailnetPreconditions.js';
import { setLoopbackExposed } from './loopbackExposure.js';
import { prepareStateDir, makeRuntimeDir, removeRuntimeDir } from './tailscaleState.js';
import { killIfSpawned, isKillError, execFailureBackoff } from './processGuards.js';
import { forwardProcessLines } from './processOutput.js';
import { logger } from './logger.js';

const TAILSCALED_BINARY = '/usr/local/bin/tailscaled';
const RESTART_DELAY_MS = 3000;
const MAX_RESTART_DELAY_MS = 60000;
const FORCE_KILL_MS = 3000;
const EXPOSURE_HOLD_MS = 5000;
export const TAILSCALE_STOP_CAP_MS = 4000;

let state = 'off';
let generation = 0;
let session = null;
let proc = null;
let restartTimer = null;
let clearTimer = null;
let stopPromise = null;
let stopResolve = null;
let forceTimer = null;
let capTimer = null;
let restarts = 0;
let lastExitCode = null;
let reason = null;
let shortDelay = RESTART_DELAY_MS;
let lastNoticeAt = -Infinity;
let outputWindowAt = 0;
let outputLines = 0;

const timer = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; };
const current = (g) => generation === g;

function notice(message) {
  // Opus plan review of #965: a broken binary retries indefinitely; one ring line per retry
  // would evict unrelated diagnostics. The first failure and about one per minute are enough.
  const now = Date.now();
  if (lastNoticeAt === -Infinity || now - lastNoticeAt >= 60000) {
    lastNoticeAt = now;
    logger.warn(`[tailscale] ${message}`);
  }
}

function redactLine(line) {
  // Opus plan review of #965: diagnostics are shareable, and daemon output can contain login
  // identity, tailnet names, endpoint addresses, and auth material. Console is still scrubbed.
  return String(line)
    .replace(/https:\/\/login\.tailscale\.com\/[^\s"']+/gi, '[login URL]')
    .replace(/\btskey-[^\s"']+/gi, '[key]')
    .replace(/\bauthkey\b[^\r\n]*/gi, 'authkey [redacted]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]')
    .replace(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.ts\.net\b/gi, '[tailnet name]')
    .replace(/(?:\b\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:]+\]):\d{1,5}\b/gi, '[endpoint]')
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .slice(0, 500);
}

function output(line, s) {
  const now = Date.now();
  if (now - outputWindowAt >= 60000) { outputWindowAt = now; outputLines = 0; }
  if (++outputLines > 10) return;
  try { (s.consoleSink ?? console.log)(`[tailscale] ${redactLine(line)}`); }
  catch { /* logging must not crash the HTTP server */ }
}

function scheduleClear(g) {
  clearTimeout(clearTimer);
  // MEASURED 2026-11-03: Express computes req.ip on each read. Keep the flag through an
  // in-flight request for five seconds after the final confirmed exit (Opus review of #965).
  clearTimer = timer(() => {
    if (current(g) && !proc && (state === 'off' || state === 'unavailable')) setLoopbackExposed(false);
    clearTimer = null;
  }, session?.exposureHoldMs ?? EXPOSURE_HOLD_MS);
}

function finishStop() {
  clearTimeout(forceTimer); forceTimer = null;
  clearTimeout(capTimer); capTimer = null;
  if (stopResolve) { stopResolve(); stopResolve = null; }
  stopPromise = null;
}

function unavailable(g, why) {
  if (!current(g)) return;
  state = 'unavailable';
  reason = why;
  notice(why);
  if (!proc) scheduleClear(g);
}

function launch(g) {
  if (!current(g) || state === 'stopping' || state === 'unavailable' || proc) return;
  const s = session;
  try {
    // The order is intentional on EVERY launch. A restored database can lose its admin, and
    // a share can change permissions after the previous run (Opus plan review of #965).
    const blocker = tailnetEnableBlocker(s.db);
    if (blocker) return unavailable(g, blocker.code);
    const prepared = prepareStateDir({ dataDir: s.dataDir, ...(s.stateOptions ?? {}) });
    if (!prepared.ok) return unavailable(g, prepared.reason);
    const runtime = makeRuntimeDir(s.runtimeOptions);
    if (!runtime.ok) return unavailable(g, runtime.reason);
    const argv = [
      '--tun=userspace-networking', '--no-logs-no-support',
      `--state=${prepared.stateDir}/tailscaled.state`, `--statedir=${prepared.stateDir}`,
      `--socket=${runtime.socketPath}`, '--port=0',
      ...(s.argvSuffix ?? []), // Test-only seam: production callers pass no suffix.
    ];
    s.runtimeDir = runtime.runtimeDir;
    state = 'starting';
    reason = null;
    // Opus plan review of #965: no await may separate this flag from the spawn boundary.
    setLoopbackExposed(true);
    s.atSpawn = true;
    const child = s.spawnFn
      ? s.spawnFn(s.binary ?? TAILSCALED_BINARY, argv, { cwd: prepared.stateDir, stdio: ['ignore', 'pipe', 'pipe'] })
      : spawnAsApp(s.binary ?? TAILSCALED_BINARY, argv, { cwd: prepared.stateDir, stdio: ['ignore', 'pipe', 'pipe'] });
    s.atSpawn = false;
    proc = child;
    s.launchedAt = s.now();
    s.execBackoff.launched();
    state = 'running';
    let settled = false;
    const ended = (code, err) => {
      if (settled || !current(g) || proc !== child) return;
      settled = true;
      proc = null;
      lastExitCode = code;
      removeRuntimeDir(s.runtimeDir);
      s.runtimeDir = null;
      if (state === 'stopping' || state === 'unavailable') {
        state = 'off'; reason = null;
        scheduleClear(g);
        finishStop();
        return;
      }
      const duration = s.now() - s.launchedAt;
      // Wrapper 126/127 takes precedence over ordinary crash-loop timing. A >=60s run
      // resets the ordinary delay; 30-60s keeps it (Opus plan review of #965).
      const exec = s.execBackoff.exited(code);
      if (duration >= 60000) shortDelay = RESTART_DELAY_MS;
      const delay = exec.execFailed ? exec.delayMs : shortDelay;
      if (!exec.execFailed && duration < 30000) shortDelay = Math.min(MAX_RESTART_DELAY_MS, shortDelay * 2);
      restarts += 1;
      state = 'backoff';
      reason = err?.code ?? (exec.execFailed ? 'exec_failure' : 'daemon_exited');
      notice(`${reason}; retry in ${delay}ms (exit ${code ?? 'unknown'})`);
      restartTimer = timer(() => { restartTimer = null; if (current(g) && state === 'backoff') launch(g); }, s.delayMs?.(delay) ?? delay);
    };
    child.on('error', (err) => {
      try {
        if (!current(g)) return;
        // #553: a failed kill emits 'error' on a still-live child. It cannot authorize a relaunch.
        if (isKillError(err)) { unavailable(g, 'signal_failed'); return; }
        ended(null, err);
      } catch { unavailable(g, 'child_error_handler_failed'); }
    });
    child.on('exit', (code) => { try { ended(code); } catch { unavailable(g, 'exit_handler_failed'); } });
    // #257: a spawn failure emits error then close, but never exit. One settled guard handles both.
    child.on('close', (code) => { try { ended(code); } catch { unavailable(g, 'close_handler_failed'); } });
    if (child.stdout) forwardProcessLines(child, child.stdout, (line) => output(line, s));
    if (child.stderr) forwardProcessLines(child, child.stderr, (line) => output(line, s));
  } catch (err) {
    if (s.runtimeDir && !proc) { removeRuntimeDir(s.runtimeDir); s.runtimeDir = null; }
    if (s.atSpawn) {
      s.atSpawn = false;
      state = 'backoff';
      reason = err?.code ?? 'spawn_failed';
      restarts += 1;
      const delay = shortDelay;
      shortDelay = Math.min(MAX_RESTART_DELAY_MS, shortDelay * 2);
      notice(`${reason}; retry in ${delay}ms`);
      restartTimer = timer(() => { restartTimer = null; if (current(g) && state === 'backoff') launch(g); }, s.delayMs?.(delay) ?? delay);
    } else unavailable(g, err?.code ?? 'start_failed');
  }
}

export function startTailscale({ db, dataDir, binary, argvSuffix, spawnFn, killFn,
  stateOptions, runtimeOptions, now = () => performance.now(), delayMs, exposureHoldMs,
  forceKillMs, stopCapMs, consoleSink } = {}) {
  if (state === 'starting' || state === 'running' || state === 'backoff' || state === 'stopping' || (state === 'unavailable' && proc)) return false;
  // Start while stopping is deliberately refused: an uncertain old child must never overlap a new one.
  clearTimeout(clearTimer); clearTimer = null;
  clearTimeout(restartTimer); restartTimer = null;
  const g = ++generation;
  state = 'starting';
  restarts = 0; lastExitCode = null; reason = null; shortDelay = RESTART_DELAY_MS; lastNoticeAt = -Infinity;
  session = { db, dataDir, binary, argvSuffix, spawnFn, killFn, stateOptions, runtimeOptions,
    now, delayMs, exposureHoldMs, forceKillMs, stopCapMs, consoleSink,
    execBackoff: execFailureBackoff(RESTART_DELAY_MS, { now }) };
  launch(g);
  return true;
}

export function stopTailscale() {
  try {
    if (stopPromise) return stopPromise;
    if (state === 'off') return Promise.resolve();
    state = 'stopping';
    clearTimeout(restartTimer); restartTimer = null;
    const g = generation;
    const child = proc;
    stopPromise = new Promise((resolve) => { stopResolve = resolve; });
    if (!child) {
      state = 'off'; reason = null;
      scheduleClear(g);
      finishStop();
      return Promise.resolve();
    }
    const kill = session?.killFn ?? killIfSpawned;
    try { kill(child, 'SIGTERM'); } catch { /* cap and fallback still apply */ }
    forceTimer = timer(() => {
      if (!current(g) || proc !== child) return;
      let sent = false;
      try { sent = kill(child, 'SIGKILL'); } catch { /* leave exposure set */ }
      if (!sent && proc === child) unavailable(g, 'sigkill_failed');
    }, session?.forceKillMs ?? FORCE_KILL_MS);
    capTimer = timer(() => {
      if (!current(g) || proc !== child) return;
      if (state !== 'unavailable') unavailable(g, 'stop_timeout');
      finishStop();
    }, session?.stopCapMs ?? TAILSCALE_STOP_CAP_MS);
    return stopPromise;
  } catch {
    // Shutdown must never throw synchronously, including on a broken test seam.
    return Promise.resolve();
  }
}

export function getTailscaleStatus() { return { state, restarts, lastExitCode, reason }; }
