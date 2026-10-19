// #743: a malformed percent escape in a saved RTSP login must still reach the talk backchannel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { startTalkSession } from '../src/lib/twoWayAudio.js';

test('talk backchannel uses a malformed escape as typed in Basic authentication', async () => {
  const requests = [];
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('data', (chunk) => {
      requests.push(chunk.toString('latin1'));
      if (requests.length === 1) {
        socket.write('RTSP/1.0 401 Unauthorized\r\nCSeq: 1\r\nWWW-Authenticate: Basic realm="camera"\r\n\r\n');
      } else {
        socket.write('RTSP/1.0 403 Forbidden\r\nCSeq: 2\r\n\r\n');
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    await assert.rejects(startTalkSession({ talk_backend: 'onvif-backchannel', rtsp_url: `rtsp://us%zz:pa%zz@127.0.0.1:${port}/stream` }), /DESCRIBE failed/);
    assert.equal(requests.length, 2, 'the malformed login prevented a camera request');
    assert.match(requests[1], new RegExp(`Authorization: Basic ${Buffer.from('us%zz:pa%zz').toString('base64')}`));
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});
