// Smoke test for the REAL `ws` library. It exists because nothing else in this suite loads it:
// talk-socket.test.js drives handleTalkConnection with a hand-rolled EventEmitter, and src/index.js
// (the only importer of `ws`) is not imported by any test. So a `ws` bump (Dependabot) could change
// the handshake, framing, close-code or ping/pong behaviour that the two-way-talk upgrade path in
// index.js relies on and every test would stay green.
//
// It mirrors how index.js uses ws: `new WebSocketServer({ noServer: true })` fed by an http server's
// 'upgrade' event, binary frames (talk-back audio) and text frames (JSON control messages).
//
// Robustness rules: port 0 (never a fixed port), everything is closed in `after`, and each wait is
// bounded so a regression fails in a couple of seconds instead of hanging the suite.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';

const within = (promise, ms, what) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms).unref()),
]);
const once = (emitter, event) => new Promise((resolve) => emitter.once(event, (...args) => resolve(args)));

describe('real ws library (noServer upgrade, as src/index.js uses it)', () => {
  let server;
  let wss;
  let url;
  const serverSockets = [];

  before(async () => {
    wss = new WebSocketServer({ noServer: true });
    server = http.createServer();
    server.on('upgrade', (req, socket, head) => {
      wss.handleUpgrade(req, socket, head, (ws) => {
        serverSockets.push(ws);
        // Echo: preserve the binary/text distinction, because the talk path sends both.
        ws.on('message', (data, isBinary) => ws.send(data, { binary: isBinary }));
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `ws://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    await new Promise((resolve) => server.close(resolve));
  });

  test('echoes a binary frame byte for byte and a text frame as text', async () => {
    const client = new WebSocket(url);
    await within(once(client, 'open'), 3000, 'open');

    const audio = Buffer.from([0, 1, 2, 3, 250, 251, 252, 253]);
    const gotBinary = once(client, 'message');
    client.send(audio);
    const [bin, binIsBinary] = await within(gotBinary, 3000, 'binary echo');
    assert.equal(binIsBinary, true);
    assert.deepEqual(Buffer.from(bin), audio);

    const gotText = once(client, 'message');
    client.send(JSON.stringify({ type: 'ready' }));
    const [txt, txtIsBinary] = await within(gotText, 3000, 'text echo');
    assert.equal(txtIsBinary, false);
    assert.equal(txt.toString(), '{"type":"ready"}');

    client.close();
    await within(once(client, 'close'), 3000, 'client close');
  });

  test('a client close reaches the server side with its code and reason', async () => {
    const client = new WebSocket(url);
    await within(once(client, 'open'), 3000, 'open');
    const serverSide = serverSockets[serverSockets.length - 1];
    const closed = once(serverSide, 'close');
    client.close(4001, 'bye');
    const [code, reason] = await within(closed, 3000, 'server-side close');
    assert.equal(code, 4001);
    assert.equal(reason.toString(), 'bye');
  });

  test('ping from the server is answered by the client with a pong (automatic)', async () => {
    const client = new WebSocket(url);
    await within(once(client, 'open'), 3000, 'open');
    const serverSide = serverSockets[serverSockets.length - 1];
    const ponged = once(serverSide, 'pong');
    serverSide.ping(Buffer.from('hb'));
    const [payload] = await within(ponged, 3000, 'pong');
    assert.equal(Buffer.from(payload).toString(), 'hb');
    client.close();
    await within(once(client, 'close'), 3000, 'client close');
  });

  test('invalid close() arguments throw and leave the socket OPEN (8.22.0 changed the state transition)', async () => {
    // ws 8.22.0: "Calling websocket.close() with invalid arguments no longer transitions the state to
    // WebSocket.CLOSING". Pin the new behaviour: a bad call must not half-close a live talk socket.
    const client = new WebSocket(url);
    await within(once(client, 'open'), 3000, 'open');
    // 1005 is reserved ("no status") and must not be sent in a close frame, so ws rejects it.
    assert.throws(() => client.close(1005));
    assert.equal(client.readyState, WebSocket.OPEN);
    client.close();
    await within(once(client, 'close'), 3000, 'client close');
  });
});
