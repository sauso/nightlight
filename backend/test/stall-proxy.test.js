// Does scripts/stall-proxy.mjs (issue #373 Stage 1) correctly split an RTSP-over-TCP byte stream into
// whole units under ANY chunking, decide the right action per mode, parse RTP headers for logging, and
// actually hold/drop/flush over a real socket?
//
// ⚠️ IT LIVES HERE BECAUSE THIS IS THE ONLY TEST HARNESS IN THE REPO — same reason
// triage-killed-runner.test.js does. The module under test is repo-root tooling (`scripts/`), not
// `backend/src`.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';

const {
  createUnitSplitter, unitBytes, parseRtpHeader, decide, startProxy, shouldFlushOnTransition,
} = await import(new URL('../../scripts/stall-proxy.mjs', import.meta.url).href);

function textUnit(header, bodyStr = '') {
  return { kind: 'text', header, body: Buffer.from(bodyStr, 'latin1') };
}
function interleavedUnit(channel, bytes) {
  return { kind: 'interleaved', channel, payload: Buffer.from(bytes) };
}
function rtpPayload(seq, ts) {
  const b = Buffer.alloc(12);
  b[0] = 0x80; // version 2, no padding/extension/CC
  b[1] = 0x00;
  b.writeUInt16BE(seq, 2);
  b.writeUInt32BE(ts, 4);
  return b;
}

// --- the splitter: text, interleaved, text-with-body, interleaved --------------------------------

const UNIT_A = textUnit('RTSP/1.0 200 OK\r\nCSeq: 1\r\n\r\n');
const UNIT_B = interleavedUnit(0, [0x80, 0x60, 0x01, 0x02, 0x03]);
const UNIT_C_BODY = 'v=0\r\n';
const UNIT_C = textUnit(
  `RTSP/1.0 200 OK\r\nCSeq: 2\r\nContent-Length: ${Buffer.byteLength(UNIT_C_BODY, 'latin1')}\r\n\r\n`,
  UNIT_C_BODY,
);
const UNIT_D = interleavedUnit(1, [0xaa, 0xbb, 0xcc]);
const REFERENCE_UNITS = [UNIT_A, UNIT_B, UNIT_C, UNIT_D];
const FULL_BYTES = Buffer.concat(REFERENCE_UNITS.map(unitBytes));

function assertUnitsEqual(actual, expected) {
  assert.equal(actual.length, expected.length, `expected ${expected.length} units, got ${actual.length}`);
  for (let i = 0; i < expected.length; i += 1) {
    assert.equal(actual[i].kind, expected[i].kind, `unit ${i} kind`);
    if (expected[i].kind === 'interleaved') {
      assert.equal(actual[i].channel, expected[i].channel, `unit ${i} channel`);
      assert.ok(actual[i].payload.equals(expected[i].payload), `unit ${i} payload bytes`);
    } else {
      assert.equal(actual[i].header, expected[i].header, `unit ${i} header`);
      assert.ok(actual[i].body.equals(expected[i].body), `unit ${i} body bytes`);
    }
  }
}

describe('createUnitSplitter', () => {
  test('fed one byte at a time, produces the 4 reference units in order', () => {
    const got = [];
    const splitter = createUnitSplitter((u) => got.push(u));
    for (let i = 0; i < FULL_BYTES.length; i += 1) splitter.write(FULL_BYTES.subarray(i, i + 1));
    assertUnitsEqual(got, REFERENCE_UNITS);
  });

  test('every possible 2-chunk split produces the same 4 units', () => {
    for (let cut = 1; cut < FULL_BYTES.length; cut += 1) {
      const got = [];
      const splitter = createUnitSplitter((u) => got.push(u));
      splitter.write(FULL_BYTES.subarray(0, cut));
      splitter.write(FULL_BYTES.subarray(cut));
      assertUnitsEqual(got, REFERENCE_UNITS);
    }
  });

  test('many units arriving in one chunk are all produced', () => {
    const got = [];
    const splitter = createUnitSplitter((u) => got.push(u));
    splitter.write(FULL_BYTES);
    assertUnitsEqual(got, REFERENCE_UNITS);
  });
});

// --- decide(): pure mode logic ---------------------------------------------------------------------

describe('decide()', () => {
  const text = textUnit('X');
  const rtp = interleavedUnit(0, [0, 0]); // even channel = media
  const rtcp = interleavedUnit(1, [0, 0]); // odd channel = control

  test('normal: everything forwards', () => {
    assert.equal(decide(text, 'normal'), 'forward');
    assert.equal(decide(rtp, 'normal'), 'forward');
    assert.equal(decide(rtcp, 'normal'), 'forward');
  });

  test('hold: text forwards straight through; RTP and RTCP both queue', () => {
    assert.equal(decide(text, 'hold'), 'forward');
    assert.equal(decide(rtp, 'hold'), 'queue');
    assert.equal(decide(rtcp, 'hold'), 'queue');
  });

  test('drop: text forwards; RTP (even) discards; RTCP (odd) forwards', () => {
    assert.equal(decide(text, 'drop'), 'forward');
    assert.equal(decide(rtp, 'drop'), 'discard');
    assert.equal(decide(rtcp, 'drop'), 'forward');
  });
});

describe('fix round 2026-09-25 (Codex review): shouldFlushOnTransition', () => {
  // Leaving `hold` for ANY mode — not just back to `normal` — must flush the held queue in order
  // first. A new POST /drop arriving while already holding (hold -> drop) used to leave the
  // already-queued frames stuck forever, neither delivered nor counted as dropped.
  test('hold -> normal flushes', () => { assert.equal(shouldFlushOnTransition('hold', 'normal'), true); });
  test('hold -> drop flushes (the real bug this fix addresses)', () => { assert.equal(shouldFlushOnTransition('hold', 'drop'), true); });
  test('hold -> hold does not flush (still holding, nothing to release)', () => { assert.equal(shouldFlushOnTransition('hold', 'hold'), false); });
  test('normal -> drop does not flush (nothing was queued)', () => { assert.equal(shouldFlushOnTransition('normal', 'drop'), false); });
  test('drop -> normal does not flush (drop never queues anything)', () => { assert.equal(shouldFlushOnTransition('drop', 'normal'), false); });
});

describe('parseRtpHeader', () => {
  test('parses seq and ts from a valid (version 2) RTP header', () => {
    const h = parseRtpHeader(rtpPayload(4242, 123456789));
    assert.deepEqual(h, { version: 2, seq: 4242, ts: 123456789 });
  });

  test('rejects a payload whose version bits are not 2', () => {
    const payload = rtpPayload(1, 1);
    payload[0] = 0x00; // version 0
    assert.equal(parseRtpHeader(payload), null);
  });

  test('rejects a payload shorter than a full RTP header', () => {
    assert.equal(parseRtpHeader(Buffer.alloc(8)), null);
  });
});

// --- one real-socket test ---------------------------------------------------------------------------

function sleep(ms) { return new Promise((r) => { setTimeout(r, ms); }); }

function waitFor(pred, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    (function tick() {
      if (pred()) { resolve(); return; }
      if (Date.now() - start > timeoutMs) { reject(new Error('waitFor timed out')); return; }
      setTimeout(tick, 5);
    }());
  });
}

function httpPost(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST' }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    });
    req.on('error', reject);
    req.end();
  });
}

function httpGet(port, path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve(JSON.parse(body)));
    }).on('error', reject);
  });
}

async function setUpProxy(log) {
  const fakeServer = net.createServer();
  await new Promise((r) => { fakeServer.listen(0, '127.0.0.1', r); });
  const fakePort = fakeServer.address().port;
  let serverSideSocket = null;
  fakeServer.on('connection', (sock) => { serverSideSocket = sock; });

  const proxy = await startProxy({
    listenHost: '127.0.0.1', listenPort: 0,
    targetHost: '127.0.0.1', targetPort: fakePort,
    controlHost: '127.0.0.1', controlPort: 0,
    log,
  });

  const client = net.connect(proxy.address().port, '127.0.0.1');
  await new Promise((r) => { client.once('connect', r); });
  const chunks = [];
  client.on('data', (c) => chunks.push(c));

  await waitFor(() => serverSideSocket !== null);

  return {
    proxy, client, fakeServer,
    chunks: () => Buffer.concat(chunks),
    sendFromServer: (buf) => serverSideSocket.write(buf),
    async teardown() {
      client.destroy();
      await proxy.close();
      await new Promise((r) => { fakeServer.close(r); });
    },
  };
}

describe('a real socket', () => {
  test('hold: nothing arrives until the hold ends, then both frames arrive in order', async () => {
    const logEvents = [];
    const rig = await setUpProxy((e) => logEvents.push(e));
    try {
      await httpPost(rig.proxy.controlAddress().port, '/hold?s=0.3');

      const text = Buffer.from('RTSP/1.0 200 OK\r\nCSeq: 1\r\n\r\n', 'latin1');
      const frame1 = unitBytes(interleavedUnit(0, rtpPayload(100, 1000)));
      const frame2 = unitBytes(interleavedUnit(0, rtpPayload(101, 1040)));
      rig.sendFromServer(text);
      rig.sendFromServer(frame1);
      rig.sendFromServer(frame2);

      await sleep(100); // well inside the 0.3s hold window
      const midway = rig.chunks();
      assert.ok(midway.toString('latin1').includes('CSeq: 1'), 'RTSP text must pass straight through during hold');
      assert.equal(midway.indexOf(frame1), -1, 'held RTP must not have arrived yet');
      assert.equal(midway.indexOf(frame2), -1, 'held RTP must not have arrived yet');

      await sleep(450); // past the hold window (300ms) with margin
      const all = rig.chunks();
      const i1 = all.indexOf(frame1);
      const i2 = all.indexOf(frame2);
      assert.ok(i1 !== -1, 'frame1 must eventually arrive');
      assert.ok(i2 !== -1, 'frame2 must eventually arrive');
      assert.ok(i1 < i2, 'frames must arrive in the order they were held');

      assert.ok(logEvents.some((e) => e.type === 'connect'));
      assert.ok(logEvents.some((e) => e.type === 'mode' && e.mode === 'hold'));
      const held = logEvents.filter((e) => e.type === 'held');
      assert.equal(held.length, 2);
      assert.equal(held[0].seq, 100);
      assert.equal(held[1].seq, 101);
    } finally {
      await rig.teardown();
    }
  });

  test('drop: RTP frames never arrive; a text message does; /status counts the drops', async () => {
    const logEvents = [];
    const rig = await setUpProxy((e) => logEvents.push(e));
    try {
      await httpPost(rig.proxy.controlAddress().port, '/drop?s=0.3');

      const text = Buffer.from('RTSP/1.0 200 OK\r\nCSeq: 9\r\n\r\n', 'latin1');
      const frame1 = unitBytes(interleavedUnit(0, rtpPayload(200, 5000)));
      const frame2 = unitBytes(interleavedUnit(0, rtpPayload(201, 5040)));
      rig.sendFromServer(text);
      rig.sendFromServer(frame1);
      rig.sendFromServer(frame2);

      await sleep(500); // past the 0.3s drop window, so a wrongly-queued frame would have flushed by now
      const all = rig.chunks();
      assert.ok(all.toString('latin1').includes('CSeq: 9'), 'RTSP text must pass through during drop');
      assert.equal(all.indexOf(frame1), -1, 'dropped RTP must never arrive');
      assert.equal(all.indexOf(frame2), -1, 'dropped RTP must never arrive');

      const status = await httpGet(rig.proxy.controlAddress().port, '/status');
      assert.ok(status.counters.dropped >= 2, `expected >=2 dropped, got ${status.counters.dropped}`);

      const dropped = logEvents.filter((e) => e.type === 'dropped');
      assert.equal(dropped.length, 2);
      assert.equal(dropped[0].seq, 200);
      assert.equal(dropped[1].seq, 201);
    } finally {
      await rig.teardown();
    }
  });
});
