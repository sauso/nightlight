// Wiring test for the original disclosure path: FFmpeg stderr -> transcoder -> raw logger. The line
// buffer itself has fast unit coverage in logger-redaction.test.js; this proves the transcoder uses it
// instead of splitting arbitrary `data` chunks as if they were complete lines.
import { test, mock, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

const spawned = [];

class FakeProcess extends EventEmitter {
  constructor() {
    super();
    this.pid = 4242;
    this.stderr = new EventEmitter();
    this.stdout = new EventEmitter();
    this.exited = false;
  }

  kill() {
    if (!this.exited) {
      this.exited = true;
      queueMicrotask(() => this.emit('exit', 0));
    }
    return true;
  }
}

mock.module('child_process', {
  exports: {
    spawn: () => {
      const proc = new FakeProcess();
      spawned.push(proc);
      return proc;
    },
  },
});
mock.module('../src/lib/rtspProbe.js', {
  exports: { ffprobeAudioCodec: async () => null },
});
mock.module('../src/lib/mediamtx.js', {
  exports: {
    hlsPathName: (path) => `${path}-hls`,
    upsertPath: async () => {},
    isPathConfiguredCorrectly: async () => true,
  },
});
mock.module('../src/lib/cameraEvents.js', {
  exports: { recordCameraEvent: () => {}, EVENT: { RESTART: 'restart' } },
});

const { logger } = await import('../src/lib/logger.js');
const { startTranscoder, stopTranscoder } = await import('../src/lib/transcoder.js');

const SECRET = 'TRANSCODER_SPLIT_SECRET_3bd1';

beforeEach(() => {
  spawned.length = 0;
  logger.clear();
});

after(async () => {
  await stopTranscoder('log-redaction-camera');
  logger.clear();
});

test('transcoder buffers split stderr before sending it through the redacting raw logger', async () => {
  await startTranscoder('log-redaction-camera', 'rtsp://source/live', 'log-redaction-path');
  assert.equal(spawned.length, 1, 'the fake FFmpeg process was not launched');

  const proc = spawned[0];
  proc.stderr.emit('data', Buffer.from('rtsp://admin:TRANSCODER_SPLIT_'));
  assert.deepEqual(logger.getRecent(), [], 'a partial stderr chunk was published as a line');
  // Node documents that process `exit` may precede stdio drain. The old fix flushed here and leaked
  // the prefix above before the `@host` half arrived.
  proc.emit('exit', 1);
  assert.ok(!logger.getRecent().join('\n').includes('TRANSCODER_SPLIT_'), 'exit flushed partial stderr');
  proc.stderr.emit('data', Buffer.from('SECRET_3bd1@camera/live: 401\n'));
  proc.stderr.emit('end');
  proc.emit('close', 1);

  const published = logger.getRecent().join('\n');
  assert.ok(!published.includes(SECRET), `transcoder log leaked the credential: ${published}`);
  assert.match(published, /rtsp:\/\/admin:\*\*\*@camera\/live: 401/);

  await stopTranscoder('log-redaction-camera'); // cancels the restart armed by the synthetic exit
});
