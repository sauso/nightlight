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
        assert.match(e.message, /never replied/);
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

describe('every provider is bounded, not just the one that was fixed first', () => {
  // ★ DERIVED FROM THE SOURCE, not a list typed here: the point of #262 is that FOUR call sites shared
  // one defect, and a fix applied to three of them looks identical to a fix applied to all four. If a
  // fifth provider is added next year with a bare fetch, this fails.
  test('no provider module still calls fetch() directly', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const libDir = path.join(process.cwd(), 'src', 'lib');
    const providers = fs
      .readdirSync(libDir)
      .filter((f) => /^(ntfy|gotify|pushover|push)\.js$/.test(f));
    assert.ok(providers.length >= 3, `only found ${providers.length} provider modules — the scan has stopped working`);

    for (const f of providers) {
      const src = fs.readFileSync(path.join(libDir, f), 'utf8');
      const bare = src.match(/await fetch\(/g) || [];
      assert.equal(
        bare.length,
        0,
        `${f} still has ${bare.length} unbounded fetch call(s) — undici's default is 300s (issue #262)`
      );
    }
  });
});
