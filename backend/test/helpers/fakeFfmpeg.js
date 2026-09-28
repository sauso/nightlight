// A fake ffmpeg/ffprobe child process and a fake MediaMTX API, shared by the suites that drive the REAL
// detector and liveness code without spawning anything.
//
// Extracted from detector-observation-wiring.test.js for #369 (the plan asked for extraction, not a copy):
// the detector-watchdog tests need the same fake, plus a WEDGED variant, and two copies of a process fake
// drift, and the one that drifts is the one nobody re-reads.
//
// HOW A SUITE USES IT: `mock.module('node:child_process', { exports: { spawn } })` with a spawn of its own that
// builds one of these. ⚠️ Mock `node:child_process` ONLY: it is not in test:core's coverage include list.
// mock.module() of an INCLUDED module corrupts coverage for the WHOLE suite (backend-test-suite memory note).
// The mock also intercepts the bare `'child_process'` specifier the modules under test import.
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';

let nextPid = 41000;

export class FakeFfmpeg extends EventEmitter {
  constructor(command, args) {
    super();
    this.command = command;
    this.args = args;
    this.pid = nextPid++; // killIfSpawned refuses a pid-less process
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.signals = [];
    this.ended = false;
  }

  // Node's order for a real child: 'exit', then the stdio streams end, then 'close'.
  finish(code, signal = null) {
    if (this.ended) return;
    this.ended = true;
    queueMicrotask(() => {
      this.emit('exit', code, signal);
      this.stdout.emit('end');
      this.stderr.emit('end');
      this.emit('close', code, signal);
    });
  }

  kill(signal) {
    this.signals.push(signal);
    this.finish(null, signal);
    return true;
  }
}

// #369: an ffmpeg that IGNORES SIGTERM (a real wedged process can: stuck in a syscall, or its signal handling
// blocked), so only the SIGKILL fallback ends it. It still records every signal it was sent.
export class WedgedFfmpeg extends FakeFfmpeg {
  kill(signal) {
    this.signals.push(signal);
    if (signal === 'SIGKILL') this.finish(null, signal);
    return true;
  }
}

// A fake MediaMTX API on a random local port. ⚠️ ORDER MATTERS: lib/mediamtx.js reads MEDIAMTX_API at MODULE
// LOAD, so a suite must `await startFakeMediamtx()` BEFORE its dynamic imports of anything that loads it. Doing
// it later left the detectors polling the default port forever: they never spawned, and their cases passed
// while testing nothing (restart-cancellation.test.js).
// `isReady(pathName)` decides each path's readiness per request (default: every path is ready).
export async function startFakeMediamtx({ isReady = () => true } = {}) {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    const m = /\/v3\/paths\/get\/([^?]+)/.exec(req.url);
    if (m) return res.end(JSON.stringify({ ready: !!isReady(decodeURIComponent(m[1])), name: 'x' }));
    res.end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.MEDIAMTX_API = `http://127.0.0.1:${server.address().port}`;
  return { server, close: () => new Promise((r) => server.close(r)) };
}
