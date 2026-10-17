// webrtcSessions.js is the mechanism behind closing an already-open live camera view when the
// login session that started it is revoked (see this repo's Security Advisories for the full
// writeup) — /live's own gates (requireAuth, whepOnlyGuard) only run at signaling time; once a WHEP
// session starts, audio/video flows directly between the browser and MediaMTX, outside this app
// entirely. This file tests the two halves separately: the pure decision (sessionsToKick,
// recordWebrtcSessionOwner) with no server involved, and the two functions that actually talk to
// MediaMTX's admin API against a REAL local HTTP server standing in for it — matching this repo's
// existing preference (see notify-timeouts.test.js) for a real server over a mocked fetch, so
// pagination and status handling are exercised for real.
import { test, describe, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

let handler = (req, res) => {
  res.statusCode = 500;
  res.end('unconfigured');
};

// MEDIAMTX_API is read once, at module-load time, by lib/mediamtx.js — so the fake server must be
// listening and process.env.MEDIAMTX_API set BEFORE the dynamic import below, the same reason every
// other file in this suite that needs to control a module-load-time env var uses top-level await.
const fakeMediamtx = createServer((req, res) => handler(req, res));
await new Promise((resolve) => fakeMediamtx.listen(0, '127.0.0.1', resolve));
process.env.MEDIAMTX_API = `http://127.0.0.1:${fakeMediamtx.address().port}`;

const { recordWebrtcSessionOwner, webrtcSessionOwners, listWebrtcSessions, kickWebrtcSession, sessionsToKick } =
  await import('../src/lib/webrtcSessions.js');

after(async () => {
  await new Promise((resolve) => fakeMediamtx.close(resolve));
});

beforeEach(() => {
  webrtcSessionOwners.clear();
  handler = (req, res) => {
    res.statusCode = 500;
    res.end('unconfigured');
  };
});

describe('recordWebrtcSessionOwner', () => {
  test('records the mapping from a successful POST response carrying an ID header, with a timestamp', () => {
    const before = Date.now();
    recordWebrtcSessionOwner({ headers: { id: 'mtx-uuid-1' } }, { method: 'POST', user: { sid: 'session-abc' } });
    const owner = webrtcSessionOwners.get('mtx-uuid-1');
    assert.equal(owner.sid, 'session-abc');
    assert.ok(owner.recordedAt >= before && owner.recordedAt <= Date.now(), 'recordedAt was not a real current timestamp');
  });

  test('no-ops when the response has no ID header (e.g. an error response)', () => {
    recordWebrtcSessionOwner({ headers: {} }, { method: 'POST', user: { sid: 'session-abc' } });
    assert.equal(webrtcSessionOwners.size, 0);
  });

  test("no-ops for a DELETE — MediaMTX's session-creation ID is meaningless on cleanup, and nothing needs recording there", () => {
    // Even an ID header present must be ignored on a method that never starts a session.
    recordWebrtcSessionOwner({ headers: { id: 'mtx-uuid-2' } }, { method: 'DELETE', user: { sid: 'session-abc' } });
    assert.equal(webrtcSessionOwners.size, 0);
  });

  test("a lower-case method is still recognized, matching whepOnlyGuard's own normalization", () => {
    recordWebrtcSessionOwner({ headers: { id: 'mtx-uuid-3' } }, { method: 'post', user: { sid: 'session-abc' } });
    assert.equal(webrtcSessionOwners.get('mtx-uuid-3').sid, 'session-abc');
  });
});

describe('sessionsToKick', () => {
  // recordedAt well before any listStartedAt used below — these tests aren't about the race, and
  // shouldn't be affected by it.
  const owner = (sid, recordedAt = 0) => ({ sid, recordedAt });
  const LIST_STARTED_AT = 1_000_000;

  test('a session whose owner is live is kept', () => {
    const owners = new Map([['mtx-1', owner('sess-live')]]);
    const { toKick } = sessionsToKick([{ id: 'mtx-1', path: 'cam_x' }], owners, (sid) => sid === 'sess-live', LIST_STARTED_AT);
    assert.deepEqual(toKick, []);
  });

  test('★ THE FIX: a session whose owner fails the liveness check is kicked', () => {
    const owners = new Map([['mtx-1', owner('sess-revoked')]]);
    const { toKick } = sessionsToKick([{ id: 'mtx-1', path: 'cam_x' }], owners, () => false, LIST_STARTED_AT);
    assert.deepEqual(toKick, [{ id: 'mtx-1', path: 'cam_x' }]);
  });

  test('a session with NO recorded owner at all is never kicked (e.g. opened before a backend restart)', () => {
    const owners = new Map(); // nothing recorded — must never be treated as "revoked" by default
    const { toKick } = sessionsToKick([{ id: 'mtx-1', path: 'cam_x' }], owners, () => false, LIST_STARTED_AT);
    assert.deepEqual(toKick, [], 'a session this process never tagged was kicked on a guess');
  });

  test('a mediamtx-reported id no longer present, recorded well BEFORE the list fetch, is returned as stale — the control', () => {
    const owners = new Map([['mtx-gone', owner('sess-live', 0)]]);
    const { toKick, stale } = sessionsToKick([], owners, () => true, LIST_STARTED_AT);
    assert.deepEqual(toKick, []);
    assert.deepEqual(stale, ['mtx-gone']);
  });

  test('★ THE FIX (found by adversarial review): an owner recorded DURING an in-flight list fetch is NOT pruned as stale, even though it is absent from that snapshot', () => {
    // The real race: listWebrtcSessions() is a network round trip. A session can open and get
    // recorded WHILE it's in flight — absent from a snapshot that was already being assembled
    // before the session existed, not because the session ended. Pruning it anyway would strip its
    // owner forever, and the "no owner -> never kick" rule above would then make this specific,
    // freshly-opened, still-live session permanently unrevokable.
    const owners = new Map([['mtx-new', owner('sess-live', /* recordedAt */ LIST_STARTED_AT + 500)]]);
    const { toKick, stale } = sessionsToKick([], owners, () => true, LIST_STARTED_AT);
    assert.deepEqual(toKick, []);
    assert.deepEqual(stale, [], 'a session opened mid-fetch was pruned before any snapshot could have known about it');
    assert.equal(owners.has('mtx-new'), true, 'the entry must survive for the next sweep to judge correctly');
  });

  test('multiple sessions are judged independently — one revoked entry does not affect the others', () => {
    const owners = new Map([
      ['mtx-1', owner('sess-live')],
      ['mtx-2', owner('sess-revoked')],
    ]);
    const { toKick } = sessionsToKick(
      [
        { id: 'mtx-1', path: 'cam_a' },
        { id: 'mtx-2', path: 'cam_b' },
      ],
      owners,
      (sid) => sid === 'sess-live',
      LIST_STARTED_AT
    );
    assert.deepEqual(toKick, [{ id: 'mtx-2', path: 'cam_b' }]);
  });
});

describe('listWebrtcSessions', () => {
  test('follows pagination and returns every item across every page', async () => {
    const requestedUrls = [];
    handler = (req, res) => {
      requestedUrls.push(req.url);
      const page = Number(new URL(req.url, 'http://x').searchParams.get('page'));
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify(
          page === 0
            ? { itemCount: 2, pageCount: 2, items: [{ id: 'a', path: 'cam_a' }] }
            : { itemCount: 2, pageCount: 2, items: [{ id: 'b', path: 'cam_b' }] }
        )
      );
    };
    const items = await listWebrtcSessions();
    assert.deepEqual(items.map((i) => i.id).sort(), ['a', 'b']);
    assert.equal(requestedUrls.length, 2, 'the pagination loop did not actually request every page');
  });

  test('a single-page response does not loop past it', async () => {
    let calls = 0;
    handler = (req, res) => {
      calls += 1;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ itemCount: 1, pageCount: 1, items: [{ id: 'only', path: 'cam_x' }] }));
    };
    const items = await listWebrtcSessions();
    assert.equal(items.length, 1);
    assert.equal(calls, 1, 'requested a page beyond what pageCount reported');
  });

  test('★ THE FIX: a failure THROWS rather than silently returning an empty list', async () => {
    // Found by adversarial review of the design: silently treating "MediaMTX is unreachable" the
    // same as "nothing to enforce" would let the sweep quietly do nothing for the whole outage.
    handler = (req, res) => {
      res.statusCode = 503;
      res.end('down');
    };
    await assert.rejects(() => listWebrtcSessions(), /503/);
  });
});

describe('kickWebrtcSession', () => {
  // ⚠️ #564: both cases below used to be `assert.doesNotReject(() => kickWebrtcSession('mtx-1'))` and nothing
  // else. A kick that never sent a request resolves too, so making the function a no-op left them green
  // (proved by mutation, see the PR): and a no-op here means a revoked login's live camera view keeps
  // streaming, which is the whole reason this module exists. They now assert WHAT WAS SENT.
  const record = (status) => {
    const seen = [];
    handler = (req, res) => {
      seen.push({ method: req.method, url: req.url });
      res.statusCode = status;
      res.end();
    };
    return seen;
  };

  test('a successful kick POSTs to MediaMTX\'s kick endpoint for exactly that session id, once', async () => {
    const seen = record(200);
    await kickWebrtcSession('mtx-1');
    assert.deepEqual(seen, [{ method: 'POST', url: '/v3/webrtc/sessions/kick/mtx-1' }]);
  });

  test('a 404 (already gone by the time this runs) is treated as success, not an error, and the kick was still attempted', async () => {
    const seen = record(404);
    await kickWebrtcSession('mtx-1'); // rejecting here fails the test, which is the "not an error" half
    assert.equal(seen.length, 1, 'a 404 is only meaningful if the request was actually sent');
    assert.equal(seen[0].url, '/v3/webrtc/sessions/kick/mtx-1');
  });

  test('any other failure status throws', async () => {
    handler = (req, res) => {
      res.statusCode = 500;
      res.end('boom');
    };
    await assert.rejects(() => kickWebrtcSession('mtx-1'), /500/);
  });
});
