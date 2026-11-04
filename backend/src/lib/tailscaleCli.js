import { spawnAsApp } from './childEnv.js';
import { getTailscaleSocketPath } from './tailscaleProcess.js';

export const TAILSCALE_BINARY = '/usr/local/bin/tailscale';
// #969: CLI output can contain account and tailnet details. Keep it in memory only and
// cap it before parsing; status is small, while sign-in may print terminal instructions.
const OUTPUT_LIMIT = 16 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
// MEASURED 2026-11-03: containerboot's default up timed out at about 60 seconds.
// Direct up --timeout=0 returns a URL promptly; five minutes bounds a stalled child.
const LOGIN_TIMEOUT_MS = 300_000;
const KILL_RELEASE_MS = 1000;
// child -> release(): cancel must also free the lock if a killed child never reports close.
const children = new Map();
let mutation = false;
let loginUrl = null;
let consentUrl = null;

export function approvedLoginUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'login.tailscale.com' &&
      !url.username && !url.password && !url.port && /^\/a\/[A-Za-z0-9_-]+\/?$/.test(url.pathname) &&
      !url.search && !url.hash ? url.href : null;
  } catch { return null; }
}

function approvedConsentUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'login.tailscale.com' &&
      !url.username && !url.password && !url.port && !url.hash &&
      // Opus review of #970: the link the owner's real run printed (2026-11-03) was
      // /f/serve?node=<id>, not /admin/..., so both shapes are accepted and nothing else.
      ((url.pathname.startsWith('/admin/') && !url.search) ||
        (url.pathname === '/f/serve' && /^\?node=[A-Za-z0-9_-]+$/.test(url.search))) ? url.href : null;
  } catch { return null; }
}

// Codex review of #970 (verified by running): a URL split across two output chunks matched its
// first half and was returned truncated. While the child is still running a candidate counts only
// once whitespace follows it (`terminated`); at exit the end of output also terminates it.
function extractUrl(output, approve, terminated = false) {
  // Opus review of #970 (verified by running): a `(?=\s)` lookahead made this pattern backtrack
  // quadratically (50 ms per call on 16 KB without whitespace, re-run on every chunk). Match
  // greedily and test the character after the match instead.
  for (const match of output.matchAll(/https?:\/\/[^\s<>"']+/g)) {
    if (terminated && match.index + match[0].length >= output.length) continue;
    const candidate = match[0];
    const url = approve(candidate.replace(/[),.;]+$/, ''));
    if (url) return url;
  }
  return null;
}

export function validateHostname(value) {
  // Certificate names enter public CT logs. Only a neutral DNS label supplied by an admin is accepted.
  return typeof value === 'string' && value.length <= 63 &&
    /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value);
}

const argvFor = (verb, hostname) => {
  switch (verb) {
    case 'status': return ['status', '--json'];
    case 'up':
      if (!validateHostname(hostname)) return null;
      return ['up', `--hostname=${hostname}`, '--timeout=0']; // MEASURED 2026-11-03: default up times out after about 60s.
    case 'logout': return ['logout'];
    case 'serve-set': return ['serve', '--bg', '--https=443', 'http://127.0.0.1:4000'];
    case 'serve-status': return ['serve', 'status', '--json'];
    case 'serve-reset': return ['serve', 'reset'];
    case 'set-hostname':
      if (!validateHostname(hostname)) return null;
      return ['set', `--hostname=${hostname}`];
    default: return null;
  }
};

export function getTailscaleLinks() { return { loginUrl, consentUrl }; }
export function clearTailscaleLinks() { loginUrl = null; consentUrl = null; }

export function cancelTailscaleCli() {
  clearTailscaleLinks();
  const stopped = [];
  for (const [child, release] of [...children]) {
    stopped.push(new Promise((resolve) => {
      child.once('close', resolve);
      const cap = setTimeout(() => { release(); resolve(); }, 1000);
      cap.unref?.();
    }));
    try { child.kill('SIGKILL'); } catch { /* close/timeout will settle it */ }
  }
  return Promise.all(stopped);
}

// This is the only CLI execution path. No request can supply an argv token, socket or target.
export function runTailscaleCli(verb, { hostname, socketPath = getTailscaleSocketPath(),
  binary = TAILSCALE_BINARY, spawnFn, timeoutMs,
} = {}) {
  const fixed = argvFor(verb, hostname);
  if (!fixed) return Promise.resolve({ ok: false, code: 'invalid_command' });
  if (!socketPath || typeof socketPath !== 'string') return Promise.resolve({ ok: false, code: 'daemon_not_ready' });
  const mutates = !['status', 'serve-status'].includes(verb);
  if (mutates && mutation) return Promise.resolve({ ok: false, code: 'busy' });
  if (mutates) mutation = true;
  return new Promise((resolve) => {
    let child;
    let output = '';
    let settled = false;
    let closed = false;
    let failure = null;
    const finish = (result) => { if (!settled) { settled = true; resolve(result); } };
    const done = (code) => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      children.delete(child);
      if (mutates) mutation = false;
      // Opus review of #970: a finished or timed-out sign-in leaves a dead link; do not show it again.
      if (verb === 'up' && (failure || code === 0)) loginUrl = null;
      if (settled) return;
      if (failure) return finish({ ok: false, code: failure });
      if (verb === 'up') {
        const url = extractUrl(output, approvedLoginUrl);
        if (url) { loginUrl = url; return finish({ ok: true, loginUrl: url }); }
      }
      if (verb === 'serve-set') {
        const url = extractUrl(output, approvedConsentUrl);
        if (url) { consentUrl = url; return finish({ ok: false, code: 'consent_required', consentUrl: url }); }
      }
      if (code !== 0) return finish({ ok: false, code: 'cli_failed' });
      if (verb === 'status' || verb === 'serve-status') {
        try {
          const json = JSON.parse(output);
          if (!json || typeof json !== 'object' || Array.isArray(json)) throw Error('invalid JSON');
          return finish({ ok: true, json });
        } catch { return finish({ ok: false, code: 'invalid_status' }); }
      }
      if (verb === 'up') return finish({ ok: true });
      if (verb === 'serve-set') consentUrl = null;
      if (verb === 'serve-reset') consentUrl = null;
      if (verb === 'logout') clearTailscaleLinks();
      finish({ ok: true });
    };
    const onData = (chunk) => {
      if (failure) return;
      output += chunk.toString('utf8');
      if (Buffer.byteLength(output) > OUTPUT_LIMIT) {
        failure = 'output_limit';
        finish({ ok: false, code: failure });
        try { child.kill('SIGKILL'); } catch { /* the release cap below still frees the lock */ }
        forceRelease();
        return;
      }
      if (verb === 'up') {
        const url = extractUrl(output, approvedLoginUrl, true);
        if (url) { loginUrl = url; finish({ ok: true, loginUrl: url }); }
      }
      if (verb === 'serve-set') {
        // Opus review of #970: the real CLI prints the approval link and then WAITS, so reading it
        // only at exit meant a 10 s timeout and no link. Settle as soon as it appears; the child is
        // then cancelled, because it would otherwise hold the mutation lock until its timeout.
        const url = extractUrl(output, approvedConsentUrl, true);
        if (url) {
          consentUrl = url;
          finish({ ok: false, code: 'consent_required', consentUrl: url });
          try { child.kill('SIGKILL'); } catch { /* the release cap below still frees the lock */ }
          forceRelease();
        }
      }
    };
    // Codex review of #970 (verified by running): a child that ignores SIGKILL never emits close, so
    // `done` never released the mutation lock and every later action answered `busy` forever. After a
    // forced kill, release the lock on a short cap even without a close event.
    const forceRelease = () => {
      const cap = setTimeout(() => done(null), KILL_RELEASE_MS);
      cap.unref?.();
    };
    let timer;
    try {
      child = (spawnFn ?? spawnAsApp)(binary, [`--socket=${socketPath}`, ...fixed], { stdio: ['ignore', 'pipe', 'pipe'] });
      children.set(child, () => done(null));
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      child.on('error', () => { failure = 'cli_failed'; done(null); });
      child.on('close', done);
      timer = setTimeout(() => {
        failure = 'timeout';
        finish({ ok: false, code: failure });
        try { child.kill('SIGKILL'); } catch { done(null); return; }
        forceRelease();
      }, timeoutMs ?? (verb === 'up' ? LOGIN_TIMEOUT_MS : DEFAULT_TIMEOUT_MS));
    } catch {
      if (mutates) mutation = false;
      finish({ ok: false, code: 'cli_failed' });
    }
  });
}
