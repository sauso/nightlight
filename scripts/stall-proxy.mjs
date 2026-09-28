#!/usr/bin/env node
// Issue #373 Stage 1, tool 2: an independent ground truth for "was a packet actually held back or
// actually lost", to compare against what probe-sample-timing.mjs infers from ffmpeg's own output.
// A TCP relay for RTSP-over-TCP, meant to sit between the soak box's transcoder and the fakecam (the
// soak camera's RTSP URL points at THIS proxy instead of the fakecam directly). On command it can
// HOLD server->client media frames for N seconds (a real backlog, queued and released in order) or
// DROP them for N seconds (real media loss), while keeping the RTSP control channel alive — see the
// plan's "Tool 2, the stall proxy" section for why suspending the fakecam generator instead can't
// give the same ground truth (Astra F5: `-re` catch-up behaviour is version-dependent, and the
// fakecam's own MediaMTX has its own readTimeout).
//
// Run it on the soak box:
//   docker cp scripts/stall-proxy.mjs nightlight-soak-nightlight-1:/tmp/stall-proxy.mjs
//   docker exec -d nightlight-soak-nightlight-1 node /tmp/stall-proxy.mjs \
//     --listen 0.0.0.0:8555 --target <fakecam-host>:8554 --control 127.0.0.1:8556 --log /tmp/stall.jsonl
//   # then point the soak camera's RTSP URL at 127.0.0.1:8555 instead of the fakecam directly
//
// Drive it while a run is in progress:
//   curl -X POST 'http://127.0.0.1:8556/hold?s=3'    # queue media frames for 3s, then flush in order
//   curl -X POST 'http://127.0.0.1:8556/drop?s=3'    # discard media frames for 3s
//   curl 'http://127.0.0.1:8556/status'              # current mode + counters

import net from 'node:net';
import http from 'node:http';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';

// --- the splitter: byte stream -> whole RTSP-over-TCP units --------------------------------------

// Turns bytes arriving in arbitrary chunks into whole units. Two shapes, distinguished by the first
// byte (RFC 2326 §10.12 interleaved binary data):
//   - an interleaved frame: 0x24 ('$'), a channel byte, a 2-byte big-endian length, then that many
//     payload bytes (RTP on even channels, RTCP on odd — the RTSP session negotiates the pairing,
//     but "even = media" holds for every transport this probe targets);
//   - otherwise an RTSP text message: header bytes up to the first `\r\n\r\n`, plus `Content-Length`
//     bytes of body if that header is present (DESCRIBE responses carry an SDP body this way).
// Exported and pure (an `onUnit` callback, no sockets) so the splitter test can drive it with any
// chunking without a real connection.
export function createUnitSplitter(onUnit) {
  let buf = Buffer.alloc(0);

  function tryParse() {
    for (;;) {
      if (buf.length === 0) return;
      if (buf[0] === 0x24) {
        if (buf.length < 4) return; // header itself not fully arrived yet
        const channel = buf[1];
        const len = buf.readUInt16BE(2);
        const total = 4 + len;
        if (buf.length < total) return; // payload not fully arrived yet
        onUnit({ kind: 'interleaved', channel, payload: buf.subarray(4, total) });
        buf = buf.subarray(total);
        continue;
      }
      const term = buf.indexOf('\r\n\r\n');
      if (term === -1) return; // header not complete yet
      const headerEnd = term + 4;
      const headerText = buf.subarray(0, headerEnd).toString('latin1');
      const m = headerText.match(/^content-length:\s*(\d+)/im);
      const bodyLen = m ? Number(m[1]) : 0;
      const total = headerEnd + bodyLen;
      if (buf.length < total) return; // body not fully arrived yet
      onUnit({ kind: 'text', header: headerText, body: buf.subarray(headerEnd, total) });
      buf = buf.subarray(total);
    }
  }

  return {
    write(chunk) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : Buffer.from(chunk);
      tryParse();
    },
  };
}

// Serialises a unit back to wire bytes (for forwarding/flushing).
export function unitBytes(unit) {
  if (unit.kind === 'interleaved') {
    const header = Buffer.alloc(4);
    header[0] = 0x24;
    header[1] = unit.channel;
    header.writeUInt16BE(unit.payload.length, 2);
    return Buffer.concat([header, unit.payload]);
  }
  return Buffer.concat([Buffer.from(unit.header, 'latin1'), unit.body]);
}

// RTP header (RFC 3550 §5.1): first 12 bytes minimum. Version is the top 2 bits of byte 0 and MUST
// be 2 for real RTP/RTCP — used here only as a validity check before trusting seq/ts for logging, not
// to decide forward/hold/drop (that's channel parity alone, in `decide` below).
export function parseRtpHeader(payload) {
  if (!payload || payload.length < 12) return null;
  const version = (payload[0] >> 6) & 0x3;
  if (version !== 2) return null;
  return { version, seq: payload.readUInt16BE(2), ts: payload.readUInt32BE(4) };
}

// --- the mode decision: pure, no sockets ----------------------------------------------------------

// mode is 'normal' | 'hold' | 'drop'. Pure so the test can drive every (mode, unit-kind) combination
// without a socket.
export function decide(unit, mode) {
  // RTSP text (control + keepalive) ALWAYS passes straight through, in every mode. If a hold queued
  // it too, a keepalive reply would be delayed along with the media, and MediaMTX's own readTimeout
  // (10s) could tear the connection down mid-measurement — turning a planned, observable stall into
  // an unplanned reconnect that the probe would misread as something else entirely.
  if (unit.kind === 'text') return 'forward';
  if (mode === 'normal') return 'forward';
  if (mode === 'hold') return 'queue'; // both RTP and RTCP interleaved frames are held
  if (mode === 'drop') {
    // Only RTP media (even channel) is discarded — RTCP (odd) keeps flowing, matching "real media
    // loss" rather than severing the session's control/reporting entirely.
    return unit.channel % 2 === 0 ? 'discard' : 'forward';
  }
  return 'forward';
}

// --- mode controller: shared, global mode + timed revert -----------------------------------------

// Fix round 2026-09-25 (Codex review): leaving `hold` for ANY mode — not just back to `normal` — must
// flush whatever's queued, in order, before the new mode's own rule applies to anything further. A
// new POST /drop arriving while already in `hold` (hold -> drop) used to leave the already-queued
// frames stuck forever: `onModeChange` only flushed on a transition TO `normal`, so they were neither
// delivered nor counted as dropped. Pure so it's testable without a controller or sockets.
export function shouldFlushOnTransition(fromMode, toMode) {
  return fromMode === 'hold' && toMode !== 'hold';
}

function createModeController(log) {
  const emitter = new EventEmitter();
  let mode = 'normal';
  let revertTimer = null;
  const counters = { held: 0, dropped: 0, forwarded: 0 };

  function setMode(newMode, seconds) {
    if (revertTimer) { clearTimeout(revertTimer); revertTimer = null; }
    const oldMode = mode;
    mode = newMode;
    log({ type: 'mode', mono: performance.now(), wall: Date.now(), mode, seconds, from: oldMode });
    emitter.emit('mode', mode, oldMode);
    revertTimer = setTimeout(() => {
      const before = mode;
      mode = 'normal';
      revertTimer = null;
      log({ type: 'mode', mono: performance.now(), wall: Date.now(), mode: 'normal', seconds: null, from: before });
      emitter.emit('mode', 'normal', before);
    }, seconds * 1000);
    if (revertTimer.unref) revertTimer.unref();
  }

  return {
    getMode: () => mode,
    setMode,
    counters,
    onModeChange: (fn) => emitter.on('mode', fn),
    offModeChange: (fn) => emitter.removeListener('mode', fn),
  };
}

// --- control HTTP server ----------------------------------------------------------------------

function createControlServer({ getStatus, setMode }) {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://control.invalid');
    if (req.method === 'POST' && (url.pathname === '/hold' || url.pathname === '/drop')) {
      const s = Number(url.searchParams.get('s'));
      if (!Number.isFinite(s) || s <= 0) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'missing or invalid ?s=<seconds>' }));
        return;
      }
      const mode = url.pathname === '/hold' ? 'hold' : 'drop';
      setMode(mode, s);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ mode, seconds: s }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/status') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(getStatus()));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
}

// --- per-connection relay ---------------------------------------------------------------------

function handleConnection(clientSocket, { targetHost, targetPort, modeCtl, log }) {
  const serverSocket = net.connect(targetPort, targetHost);
  const queue = [];

  log({ type: 'connect', mono: performance.now(), wall: Date.now() });

  // client -> server: relayed verbatim, never inspected or held. Only the server->client direction
  // carries media, and only that direction is what hold/drop model.
  clientSocket.on('data', (chunk) => {
    if (serverSocket.writable) serverSocket.write(chunk);
  });

  function forwardUnit(unit) {
    if (clientSocket.writable) clientSocket.write(unitBytes(unit));
    modeCtl.counters.forwarded += 1;
  }

  function flushQueue() {
    // On return to normal, the queue drains IN ORDER, then resumes — triggered directly off the mode
    // controller's 'mode' event (see onModeChange below), not off the next incoming unit, so the
    // flush happens exactly when the hold ends rather than whenever the server next happens to send
    // something.
    for (const q of queue.splice(0)) forwardUnit(q);
  }

  function logHeldOrDropped(kind, unit) {
    const rtp = unit.kind === 'interleaved' && unit.channel % 2 === 0 ? parseRtpHeader(unit.payload) : null;
    log({
      type: kind, mono: performance.now(), wall: Date.now(),
      channel: unit.kind === 'interleaved' ? unit.channel : null,
      len: unit.kind === 'interleaved' ? unit.payload.length : unit.header.length + unit.body.length,
      seq: rtp ? rtp.seq : null,
      ts: rtp ? rtp.ts : null,
    });
  }

  const splitter = createUnitSplitter((unit) => {
    const action = decide(unit, modeCtl.getMode());
    if (action === 'forward') {
      forwardUnit(unit);
    } else if (action === 'queue') {
      queue.push(unit);
      modeCtl.counters.held += 1;
      logHeldOrDropped('held', unit);
    } else {
      modeCtl.counters.dropped += 1;
      logHeldOrDropped('dropped', unit);
    }
  });
  serverSocket.on('data', (chunk) => splitter.write(chunk));

  function onModeChange(newMode, oldMode) {
    if (shouldFlushOnTransition(oldMode, newMode)) flushQueue();
  }
  modeCtl.onModeChange(onModeChange);

  let closed = false;
  function closeBoth() {
    if (closed) return;
    closed = true;
    modeCtl.offModeChange(onModeChange);
    log({ type: 'close', mono: performance.now(), wall: Date.now() });
    clientSocket.destroy();
    serverSocket.destroy();
  }
  clientSocket.on('close', closeBoth);
  clientSocket.on('error', closeBoth);
  serverSocket.on('close', closeBoth);
  serverSocket.on('error', closeBoth);
}

// --- wiring: listener + control server ----------------------------------------------------------

function listenAsync(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.removeListener('error', reject); resolve(); });
  });
}

// Starts both servers and returns a handle. Exported so the real-socket test can drive a proxy
// in-process (ephemeral ports) without spawning the CLI as a subprocess.
export async function startProxy({ listenHost, listenPort, targetHost, targetPort, controlHost, controlPort, log }) {
  const modeCtl = createModeController(log);
  let connCount = 0;

  const server = net.createServer((clientSocket) => {
    connCount += 1;
    handleConnection(clientSocket, { targetHost, targetPort, modeCtl, log });
    clientSocket.once('close', () => { connCount -= 1; });
  });

  const control = createControlServer({
    getStatus: () => ({ mode: modeCtl.getMode(), counters: { ...modeCtl.counters }, connections: connCount }),
    setMode: modeCtl.setMode,
  });

  await listenAsync(server, listenPort, listenHost);
  await listenAsync(control, controlPort, controlHost);

  return {
    address: () => server.address(),
    controlAddress: () => control.address(),
    modeCtl,
    close: async () => {
      await Promise.all([
        new Promise((r) => server.close(r)),
        new Promise((r) => control.close(r)),
      ]);
    },
  };
}

// --- CLI -----------------------------------------------------------------------------------------

function splitHostPort(s) {
  const idx = s.lastIndexOf(':');
  if (idx === -1) throw new Error(`stall-proxy: expected HOST:PORT, got "${s}"`);
  return { host: s.slice(0, idx), port: Number(s.slice(idx + 1)) };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    switch (a) {
      case '--listen': out.listen = argv[i += 1]; break;
      case '--target': out.target = argv[i += 1]; break;
      case '--control': out.control = argv[i += 1]; break;
      case '--log': out.log = argv[i += 1]; break;
      default: throw new Error(`stall-proxy: unknown argument ${a}`);
    }
  }
  for (const k of ['listen', 'target', 'control', 'log']) {
    if (!out[k]) throw new Error(`stall-proxy: --${k} is required`);
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('stall-proxy.mjs')) {
  const cliArgs = parseArgs(process.argv.slice(2));
  const { host: listenHost, port: listenPort } = splitHostPort(cliArgs.listen);
  const { host: targetHost, port: targetPort } = splitHostPort(cliArgs.target);
  const { host: controlHost, port: controlPort } = splitHostPort(cliArgs.control);
  const fd = fs.openSync(cliArgs.log, 'w');
  const log = (event) => { fs.writeSync(fd, `${JSON.stringify(event)}\n`); };
  await startProxy({ listenHost, listenPort, targetHost, targetPort, controlHost, controlPort, log });
  process.stdout.write(`stall-proxy listening on ${cliArgs.listen}, control on ${cliArgs.control}, relaying to ${cliArgs.target}\n`);
}
