// A notification provider that stops answering must not hold the request open for five minutes.
//
// The defect (issue #262): ntfy, Gotify and both Pushover calls were a bare `fetch` with no
// AbortController, so the only bound was undici's default `headersTimeout` — 300 SECONDS. Two real
// symptoms: the admin Test button hangs with no feedback for five minutes (self-hosted ntfy/Gotify are
// the common case, and a half-up server that accepts TCP then goes quiet is exactly how they fail), and
// each hung Pushover send pins its JPEG snapshot buffer for the whole 300s.
//
// ⚠️ THE SERVER HERE ACCEPTS THE CONNECTION AND THEN NEVER REPLIES, which is the specific failure mode.
// A closed port or a refused connection is NOT this bug — those fail fast on their own and would make
// every case below pass with the fix removed. The socket is held open and deliberately never written
// to, so the only thing that can end the request is our own timeout.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { useTempDataDir, cleanupTempDataDirs } from './helpers/harness.js';

useTempDataDir();

const { NOTIFY_TIMEOUT_MS, postWithTimeout } = await import('../src/lib/httpNotify.js');

// A raw TCP server, not an http one: node's http server would answer a malformed request or time the
// socket out itself, and either would end the request for reasons that have nothing to do with the fix.
const sockets = [];
let blackHole;
let baseUrl;

before(async () => {
  blackHole = createServer((socket) => {
    // Hold it. Read the request so the client's write completes, then answer nothing, ever.
    sockets.push(socket);
    socket.on('data', () => {});
    socket.on('error', () => {});
  });
  await new Promise((r) => blackHole.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${blackHole.address().port}`;
});

after(async () => {
  for (const s of sockets) s.destroy();
  if (blackHole) await new Promise((r) => blackHole.close(r));
  cleanupTempDataDirs();
});

// Generous enough not to be flaky on a loaded CI runner, tight enough that it could not pass against
// undici's 300s default — which is the only thing this needs to discriminate.
const SETTLE_BUDGET_MS = 30_000;

async function settlesWithin(label, fn) {
  const startedAt = Date.now();
  const result = await fn();
  const elapsed = Date.now() - startedAt;
  assert.ok(
    elapsed < SETTLE_BUDGET_MS,
    `${label} took ${elapsed}ms — it is not bounded (undici's default would be 300000ms)`
  );
  return { result, elapsed };
}

describe('the shared bounded POST', () => {
  test('it gives up on a server that never replies, instead of waiting five minutes', async () => {
    const { elapsed } = await settlesWithin('postWithTimeout', async () => {
      await assert.rejects(
        () => postWithTimeout(baseUrl, { method: 'POST', body: 'x' }, { timeoutMs: 1200, label: 'probe' }),
        /timed out after/
      );
    });
    // It waited for its timeout rather than failing instantly — otherwise this would pass against a
    // refused connection and prove nothing about the abort.
    assert.ok(elapsed >= 1000, `gave up after only ${elapsed}ms — it is not the timeout doing the work`);
  });

  test('the error names the real problem, because a user reads it verbatim', () => {
    // AbortError's own message is "This operation was aborted", which tells someone testing a
    // self-hosted server nothing about what to change. These strings surface in the Test buttons.
    return assert.rejects(
      () => postWithTimeout(baseUrl, { method: 'POST' }, { timeoutMs: 300, label: 'probe' }),
      (e) => {
        assert.match(e.message, /timed out/, `unhelpful error surfaced to the user: ${e.message}`);
        // "stopped responding" rather than "never replied": review of #262 pointed out that the
        // second case this covers is a server which DID reply with headers and then went quiet
        // mid-body, so "never" was imprecise for half the failures it describes.
        assert.match(e.message, /stopped responding/);
        assert.ok(!/aborted/i.test(e.message), 'the raw AbortError message is leaking to the user');
        return true;
      }
    );
  });

  test('a healthy server is not broken by the timeout — the control', async () => {
    // Without this, every case above would still pass if postWithTimeout simply always threw.
    const ok = createServer();
    const http = await import('node:http');
    const srv = http.createServer((req, res) => res.end('fine'));
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    try {
      const res = await postWithTimeout(`http://127.0.0.1:${srv.address().port}`, { method: 'POST' }, { label: 'probe' });
      assert.equal(res.ok, true);
      assert.equal(res.text, 'fine', 'the body is not being read inside the abort window');
    } finally {
      await new Promise((r) => srv.close(r));
      ok.close();
    }
  });

  test('the body read is INSIDE the abort window, not after it', async () => {
    // ⚠️ The subtle half of #262, and the one a naive fix misses. `fetch` resolves as soon as the
    // response HEADERS arrive — a server can send them and then hold the body open forever. Clearing
    // the timeout when fetch resolves would leave that read unbounded and reintroduce the bug behind a
    // green test. Here the headers arrive immediately and the body never does.
    const http = await import('node:http');
    const held = [];
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': '100' });
      res.write('partial');
      held.push(res); // never end()
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    try {
      await settlesWithin('a hung BODY read', async () => {
        await assert.rejects(
          () => postWithTimeout(`http://127.0.0.1:${srv.address().port}`, { method: 'POST' }, { timeoutMs: 1200, label: 'probe' }),
          /timed out/
        );
      });
    } finally {
      for (const r of held) r.destroy();
      await new Promise((r) => srv.close(r));
    }
  });

  test('the default is short enough to be useful and long enough to deliver', () => {
    // A doorbell, not a durable queue. Asserted as a range rather than an equality so it can be tuned
    // without a test edit, but not silently raised back toward undici's 300s.
    assert.ok(NOTIFY_TIMEOUT_MS >= 3_000, `${NOTIFY_TIMEOUT_MS}ms is too tight for a slow uplink with a snapshot attached`);
    assert.ok(NOTIFY_TIMEOUT_MS <= 30_000, `${NOTIFY_TIMEOUT_MS}ms leaves the Test button hanging past anyone's patience`);
  });
});

describe('nothing in the backend performs an UNBOUNDED fetch', () => {
  // ★ FAIL CLOSED. The first version of this did the opposite: it scanned a hard-coded filename
  // whitelist, /^(ntfy|gotify|pushover|push)\.js$/, while its own comment claimed "a fifth provider
  // added later cannot quietly reintroduce this". Adversarial review of #262 falsified that in the
  // most direct way available — it dropped a `discord.js` into src/lib with a genuinely unbounded
  // fetch and the suite stayed green, because the file was never looked at. A whitelist fails OPEN,
  // which is the one shape a regression guard must never have.
  //
  // Now every .js under src is scanned and each fetch() must pass a `signal:`. A new provider added
  // anywhere fails by default; the only ways to pass are to bound the call or to add the file to
  // ALLOWED, which is a visible decision carrying a reason rather than a silence.
  const readAllSources = async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const root = path.join(process.cwd(), 'src');
    const out = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith('.js')) {
          out.push({
            rel: path.relative(root, full).split(path.sep).join('/'),
            src: fs.readFileSync(full, 'utf8'),
          });
        }
      }
    };
    walk(root);
    return out;
  };

  // Every entry needs a reason. These are the only unbounded fetches left in the backend.
  const ALLOWED = {
    // The bounded helper itself — its fetch is the one carrying the signal.
    'lib/httpNotify.js': 'defines postWithTimeout',
    // ⚠️ KNOWN LIMIT, DOCUMENTED RATHER THAN HIDDEN. mediamtx.js talks to MediaMTX's HTTP API on
    // 127.0.0.1 inside the same container, so it cannot hang on a network partition the way a remote
    // provider can, and its callers now run under safeInterval's crash guard. Still technically
    // unbounded, and out of scope for #262, which is about notification providers.
    'lib/mediamtx.js': 'loopback API in the same container; out of scope for #262',
  };

  // A text scan is fooled by comments and string literals in BOTH directions — review of #262 hid a
  // real unbounded call from the old scan, and separately made it fail on the literal "await fetch("
  // sitting inside an explanatory comment. Strip both before matching.
  const stripCommentsAndStrings = (src) =>
    src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*/g, '$1')
      .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
      .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
      .replace(/`(?:[^`\\]|\\.)*`/g, '``');

  test('every fetch() passes a signal, or is an allowed exception with a stated reason', async () => {
    const files = await readAllSources();
    assert.ok(files.length > 20, `the source walk found only ${files.length} files — it has stopped working`);
    // Anti-vacuous: the scan must actually be finding fetch calls, or it proves nothing at all.
    const withFetch = files.filter((f) => /\bfetch\s*\(/.test(f.src));
    assert.ok(withFetch.length >= 2, `found fetch() in only ${withFetch.length} file(s) — the scan stopped matching`);

    for (const f of files) {
      if (ALLOWED[f.rel]) continue;
      const code = stripCommentsAndStrings(f.src);

      for (const m of code.matchAll(/\bfetch\s*\(/g)) {
        const tail = code.slice(m.index, m.index + 400);
        assert.match(
          tail,
          /signal\s*:/,
          `${f.rel} calls fetch() with no signal — undici's default bound is 300s (issue #262). ` +
            'Route it through postWithTimeout, or add it to ALLOWED with a reason.'
        );
      }

      // ⚠️ AND THE ALIAS FORM, which a plain `fetch(` scan cannot see. Review of #262 slipped an
      // unbounded call past the old scan as `const rawFetch = fetch; await rawFetch(url, ...)`.
      // A regex cannot catch every indirection — that needs an AST — but it catches the shapes people
      // actually write, and aliasing fetch is not something anyone does by accident.
      assert.doesNotMatch(
        code,
        /=\s*(globalThis\.)?fetch\s*[;,\r\n]/,
        `${f.rel} aliases fetch to another name, which would slip past the check above`
      );
    }
  });

  test('the notification providers in particular go through the bounded helper', async () => {
    // The positive half. The scan above proves nothing unbounded EXISTS; this proves the call sites
    // #262 was filed about are actually wired to the helper, rather than deleted or routed elsewhere.
    const files = await readAllSources();
    for (const rel of ['lib/ntfy.js', 'lib/gotify.js', 'lib/pushover.js']) {
      const f = files.find((x) => x.rel === rel);
      assert.ok(f, `${rel} has gone missing`);
      assert.match(f.src, /postWithTimeout\(/, `${rel} no longer sends through the bounded helper`);
    }
  });
});
