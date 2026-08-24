import http from 'http';
import net from 'net';
import crypto from 'crypto';
import { logger } from './logger.js';

// Two-way audio ("talk back"): stream audio from the app to a camera's speaker. The app captures
// the mic, downsamples + encodes to G.711 mu-law in the browser (see frontend/lib/twoWayTalk.js),
// and sends raw mu-law bytes over a WebSocket; this module just forwards those bytes to the camera.
// The camera-specific delivery is a "talk sink" - only Hikvision ISAPI is implemented so far.
//
// Hikvision ISAPI flow (all HTTP, no RTSP backchannel):
//   PUT /ISAPI/System/TwoWayAudio/channels/<ch>/open       -> start a talk session
//   PUT /ISAPI/System/TwoWayAudio/channels/<ch>/audioData  -> stream the mu-law bytes (kept open)
//   PUT /ISAPI/System/TwoWayAudio/channels/<ch>/close      -> end it
// ISAPI is HTTP-digest against the camera's WEB user database, which on Hikvision is SEPARATE from
// its ONVIF users - so this uses the camera's talk_username/talk_password, not the ONVIF creds.

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

function parseChallenge(header) {
  const p = {};
  (header || '').replace(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g, (_, k, q, u) => {
    p[k] = q !== undefined ? q : u;
    return '';
  });
  return p;
}

function digestHeader(challenge, method, uri, username, password, nc) {
  let qop = challenge.qop;
  if (qop && qop.includes(',')) qop = 'auth';
  const ncHex = String(nc).padStart(8, '0');
  const cnonce = crypto.randomBytes(8).toString('hex');
  const ha1 = md5(`${username}:${challenge.realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);
  const response = qop
    ? md5(`${ha1}:${challenge.nonce}:${ncHex}:${cnonce}:${qop}:${ha2}`)
    : md5(`${ha1}:${challenge.nonce}:${ha2}`);
  let a = `Digest username="${username}", realm="${challenge.realm}", nonce="${challenge.nonce}", uri="${uri}", response="${response}"`;
  if (qop) a += `, qop=${qop}, nc=${ncHex}, cnonce="${cnonce}"`;
  if (challenge.opaque) a += `, opaque="${challenge.opaque}"`;
  return a;
}

function hostFromCamera(camera) {
  for (const url of [camera.onvif_device_url, camera.rtsp_url]) {
    try {
      if (url) return new URL(url).hostname;
    } catch {
      // try the next
    }
  }
  return null;
}

class HikvisionTalk {
  constructor({ host, port = 80, username, password, channel = 1 }) {
    this.host = host;
    this.port = port;
    this.username = username;
    this.password = password;
    this.base = `/ISAPI/System/TwoWayAudio/channels/${channel}`;
    this.challenge = null; // reused for the streaming audioData request
    this.audioReq = null;
    this.closed = false;
  }

  // A plain (non-streaming) request that performs the 401 -> digest-retry handshake itself and
  // resolves { status, body, challenge } (challenge = what the 401 offered, so a later streaming
  // request can reuse the same nonce).
  _request(method, path) {
    return new Promise((resolve, reject) => {
      const attempt = (authHeader, isRetry, challenge) => {
        const headers = authHeader ? { Authorization: authHeader } : {};
        const req = http.request({ host: this.host, port: this.port, path, method, timeout: 8000, headers }, (res) => {
          let b = '';
          res.on('data', (d) => (b += d));
          res.on('end', () => {
            if (res.statusCode === 401 && !isRetry && res.headers['www-authenticate']) {
              const ch = parseChallenge(res.headers['www-authenticate']);
              return attempt(digestHeader(ch, method, path, this.username, this.password, 1), true, ch);
            }
            resolve({ status: res.statusCode, body: b, challenge });
          });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        req.end();
      };
      attempt(null, false, null);
    });
  }

  async start() {
    // Hikvision allows only ONE two-way-audio session at a time and returns 403 on open while one
    // is held. A talk that didn't close cleanly (crash, dropped socket) can leave one stuck, so
    // always release any existing session first - best-effort, ignore the result.
    await this._request('PUT', `${this.base}/close`).catch(() => {});
    const open = await this._request('PUT', `${this.base}/open`);
    if (open.status !== 200) {
      const err = new Error(`Hikvision talk open failed (HTTP ${open.status})`);
      err.status = open.status;
      throw err;
    }
    this.challenge = open.challenge;
    this._startAudioStream();
  }

  _startAudioStream() {
    // Reuse the open challenge with nc=2 so we can send auth up front (a streaming body can't be
    // replayed after a 401). Then keep this request open and write mu-law bytes to it as they come.
    const path = `${this.base}/audioData`;
    const headers = {
      'Content-Type': 'application/octet-stream',
      // Stream with a fixed (huge) Content-Length rather than chunked transfer-encoding. This camera
      // does NOT de-chunk the audioData body, so a chunked stream plays as silence; a plain-bodied
      // stream plays correctly. We send audio until the talk ends, then close the connection well
      // short of this length - node emits a benign content-length-mismatch that the error handler
      // below swallows, and the camera has already played everything we sent.
      'Content-Length': '2147483647',
    };
    if (this.challenge) {
      headers.Authorization = digestHeader(this.challenge, 'PUT', path, this.username, this.password, 2);
    }
    const req = http.request({ host: this.host, port: this.port, path, method: 'PUT', headers }, (res) => {
      res.on('data', () => {});
      res.on('end', () => {
        if (!this.closed && res.statusCode >= 400) {
          logger.error(`[talk] audioData rejected (HTTP ${res.statusCode})`);
        }
      });
    });
    req.on('error', (e) => { if (!this.closed) logger.error(`[talk] audioData stream error: ${e.message}`); });
    this.audioReq = req;
  }

  write(buf) {
    if (this.audioReq && !this.closed) {
      try { this.audioReq.write(buf); } catch { /* connection went away; close() handles cleanup */ }
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    try { this.audioReq?.end(); } catch { /* ignore */ }
    try { await this._request('PUT', `${this.base}/close`); } catch { /* best-effort */ }
  }
}

// ONVIF/RTSP audio backchannel talk sink — for cameras (Thingino/Sonoff and most ONVIF cams) that
// receive audio over RTSP instead of Hikvision's HTTP ISAPI. Flow (validated against a Thingino cam):
//   DESCRIBE <url> with `Require: www.onvif.org/ver20/backchannel`  -> SDP gains a `a=sendonly` audio
//     media section (the direction we send) offering PCMU (G711 µ-law, payload 0), among others.
//   SETUP <track> Transport: RTP/AVP/TCP;interleaved=0-1  ->  PLAY  ->  stream RTP (PT 0) over the
//   interleaved TCP channel. The browser already produces µ-law, so we packetise it straight through.
// Uses the camera's STREAM credentials (embedded in rtsp_url), same as ONVIF/RTSP — no separate login.
function parseRtspUrl(rtspUrl) {
  try {
    const u = new URL(rtspUrl);
    return {
      host: u.hostname,
      port: u.port ? Number(u.port) : 554,
      path: (u.pathname || '/') + (u.search || ''),
      username: decodeURIComponent(u.username || ''),
      password: decodeURIComponent(u.password || ''),
    };
  } catch {
    return null;
  }
}

const BACKCHANNEL_REQUIRE = 'Require: www.onvif.org/ver20/backchannel';
// Per-request RTSP timeout. The socket's own timeout is cleared after connect (setTimeout(0)) so a
// long talk isn't torn down, which means an individual RTSP request has no backstop of its own: a
// camera that accepts the TCP connection but never answers a request (some Hikvisions do exactly
// this to an ONVIF-backchannel DESCRIBE/SETUP/TEARDOWN they don't really support) would otherwise
// leave the awaiting caller hung forever — including the TEARDOWN inside close(), which is awaited
// by verifyBackchannel and, through it, by the /onvif-probe HTTP handler.
const RTSP_REQUEST_TIMEOUT_MS = 5000;

class OnvifBackchannelTalk {
  constructor({ host, port = 554, path = '/', username, password }) {
    this.host = host;
    this.port = port;
    this.url = `rtsp://${host}:${port}${path}`;
    this.username = username;
    this.password = password;
    this.sock = null;
    this.cseq = 1;
    this.session = null;
    this.rtpCh = 0;
    this.auth = null; // { scheme:'basic' } | { scheme:'digest', challenge }
    this.seq = crypto.randomBytes(2).readUInt16BE(0);
    this.ts = 0;
    this.ssrc = crypto.randomBytes(4).readUInt32BE(0);
    this.pending = Buffer.alloc(0);
    this.closed = false;
    this.keepalive = null;
  }

  _authHeader(method, uri) {
    if (!this.auth) return null;
    if (this.auth.scheme === 'basic') return 'Basic ' + Buffer.from(`${this.username}:${this.password}`).toString('base64');
    return digestHeader(this.auth.challenge, method, uri, this.username, this.password, this.cseq);
  }

  // Send one RTSP request and resolve its parsed response (head + body). Only used during the
  // handshake, before any interleaved RTP flows, so simple \r\n\r\n + Content-Length parsing is safe.
  _send(method, uri, extra = []) {
    return new Promise((resolve, reject) => {
      const headers = [`${method} ${uri} RTSP/1.0`, `CSeq: ${this.cseq++}`];
      const a = this._authHeader(method, uri);
      if (a) headers.push(`Authorization: ${a}`);
      headers.push(...extra);
      let buf = '';
      let timer = null;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        this.sock.removeListener('data', onData);
      };
      const onData = (d) => {
        buf += d.toString('latin1');
        const idx = buf.indexOf('\r\n\r\n');
        if (idx < 0) return;
        const head = buf.slice(0, idx);
        const m = /Content-Length:\s*(\d+)/i.exec(head);
        if (buf.length - (idx + 4) >= (m ? Number(m[1]) : 0)) {
          cleanup();
          resolve({ head, body: buf.slice(idx + 4), status: Number((/^\S+\s+(\d+)/.exec(head) || [])[1]) });
        }
      };
      // No per-request timeout otherwise (the socket's own timeout is disabled after connect), so an
      // unanswered request would hang forever — reject instead so start()/close() can't wedge.
      timer = setTimeout(() => { cleanup(); reject(new Error(`RTSP ${method} timed out`)); }, RTSP_REQUEST_TIMEOUT_MS);
      this.sock.on('data', onData);
      this.sock.write(headers.join('\r\n') + '\r\n\r\n');
    });
  }

  async start() {
    await new Promise((resolve, reject) => {
      this.sock = net.connect(this.port, this.host, resolve);
      this.sock.setTimeout(8000, () => this.sock.destroy(new Error('RTSP connect timeout')));
      this.sock.once('error', reject);
    });
    this.sock.setTimeout(0);
    this.sock.on('error', () => {});

    let d = await this._send('DESCRIBE', this.url, [BACKCHANNEL_REQUIRE, 'Accept: application/sdp']);
    if (d.status === 401) {
      const wa = /WWW-Authenticate:\s*(.+)/i.exec(d.head);
      this.auth = wa && /^\s*Digest/i.test(wa[1]) ? { scheme: 'digest', challenge: parseChallenge(wa[1]) } : { scheme: 'basic' };
      d = await this._send('DESCRIBE', this.url, [BACKCHANNEL_REQUIRE, 'Accept: application/sdp']);
    }
    if (d.status !== 200) throw new Error(`backchannel DESCRIBE failed (${d.status || d.head.split('\r\n')[0]})`);

    // The send-only audio media section is the backchannel. Grab its control URL; confirm it offers
    // PCMU (payload 0 = G711 µ-law), which is what the browser sends.
    const block = d.body.split(/^m=/m).find((b) => /^audio/.test(b) && /a=sendonly/.test(b));
    if (!block) throw new Error('camera did not offer an audio backchannel');
    if (!/a=rtpmap:0\s+PCMU/i.test(block) && !/\bRTP\/AVP[^\r\n]*\b0\b/.test('m=' + block)) {
      logger.info('[talk] backchannel does not advertise PCMU explicitly — sending µ-law as payload 0 anyway');
    }
    const ctl = (/a=control:(\S+)/.exec(block) || [])[1] || 'track0';
    const setupUrl = /^rtsps?:\/\//i.test(ctl) ? ctl : `${this.url}/${ctl}`;

    const s = await this._send('SETUP', setupUrl, [BACKCHANNEL_REQUIRE, 'Transport: RTP/AVP/TCP;unicast;interleaved=0-1']);
    if (s.status !== 200) throw new Error(`backchannel SETUP failed (${s.status})`);
    this.session = (/Session:\s*([^;\r\n]+)/i.exec(s.head) || [])[1]?.trim() || null;
    const il = /interleaved=(\d+)/i.exec(s.head);
    if (il) this.rtpCh = Number(il[1]);

    const p = await this._send('PLAY', this.url, [BACKCHANNEL_REQUIRE, ...(this.session ? [`Session: ${this.session}`] : [])]);
    if (p.status !== 200) throw new Error(`backchannel PLAY failed (${p.status})`);

    // From here the socket may carry interleaved RTCP from the camera — discard it (we only send).
    this.sock.on('data', () => {});
    // RTSP session keepalive: a fire-and-forget OPTIONS well within the SETUP timeout so a longer talk
    // isn't torn down mid-sentence. We don't parse the reply (it'd race the interleaved data).
    this.keepalive = setInterval(() => {
      if (this.closed) return;
      const req = [`OPTIONS ${this.url} RTSP/1.0`, `CSeq: ${this.cseq++}`];
      const a = this._authHeader('OPTIONS', this.url);
      if (a) req.push(`Authorization: ${a}`);
      if (this.session) req.push(`Session: ${this.session}`);
      try { this.sock.write(req.join('\r\n') + '\r\n\r\n'); } catch { /* closing */ }
    }, 20000);
  }

  // Packetise incoming µ-law bytes into 20 ms (160-byte) RTP packets (PT 0) framed over the RTSP TCP
  // interleaved channel. The mic delivers ~8000 bytes/s in real time, so this paces itself.
  write(buf) {
    if (this.closed || !this.sock) return;
    this.pending = this.pending.length ? Buffer.concat([this.pending, buf]) : Buffer.from(buf);
    while (this.pending.length >= 160) {
      const payload = this.pending.subarray(0, 160);
      this.pending = this.pending.subarray(160);
      const rtp = Buffer.allocUnsafe(172);
      rtp[0] = 0x80;
      rtp[1] = 0x00; // marker 0, payload type 0 (PCMU)
      rtp.writeUInt16BE(this.seq & 0xffff, 2);
      rtp.writeUInt32BE(this.ts >>> 0, 4);
      rtp.writeUInt32BE(this.ssrc, 8);
      payload.copy(rtp, 12);
      const frame = Buffer.allocUnsafe(176);
      frame[0] = 0x24; // '$' interleaved marker
      frame[1] = this.rtpCh;
      frame.writeUInt16BE(172, 2);
      rtp.copy(frame, 4);
      try { this.sock.write(frame); } catch { /* closing */ }
      this.seq = (this.seq + 1) & 0xffff;
      this.ts = (this.ts + 160) >>> 0;
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    if (this.keepalive) clearInterval(this.keepalive);
    try { if (this.session) await this._send('TEARDOWN', this.url, [`Session: ${this.session}`]); } catch { /* best-effort */ }
    try { this.sock?.end(); } catch { /* ignore */ }
    try { this.sock?.destroy(); } catch { /* ignore */ }
  }
}

// Actively confirm a camera really answers the ONVIF/RTSP audio backchannel, using the stream URL's
// own credentials — a full DESCRIBE+SETUP+PLAY handshake, then teardown. Returns true/false (never
// throws). Called at ONVIF probe/edit time to PICK and CORRECT the talk backend: a Thingino/Sonoff (or
// any ONVIF cam that does the backchannel) verifies true and gets 'onvif-backchannel'; a real Hikvision
// won't answer it and falls back to the ISAPI sink. This is what lets the backend self-heal when a
// camera is re-pointed at a different device or was added before this protocol existed, instead of
// latching onto whatever was stored first. `backchannel_supported` (from the ONVIF probe) only says the
// device advertises an audio output — this proves the send path actually works.
export async function verifyBackchannel(rtspUrl, { timeoutMs = 6000 } = {}) {
  const parts = parseRtspUrl(rtspUrl);
  if (!parts || !parts.host) return false;
  const session = new OnvifBackchannelTalk(parts);
  let timer;
  const timeout = new Promise((res) => { timer = setTimeout(() => res('timeout'), timeoutMs); });
  try {
    const outcome = await Promise.race([session.start().then(() => 'ok', () => 'fail'), timeout]);
    return outcome === 'ok';
  } finally {
    clearTimeout(timer);
    try { await session.close(); } catch { /* ignore */ }
  }
}

// Whether a camera is set up for talk-back: a supported backend + whatever creds that backend needs.
export function talkConfigured(camera) {
  if (camera.talk_backend === 'hikvision-isapi') return !!camera.talk_username && !!camera.talk_password;
  if (camera.talk_backend === 'onvif-backchannel') return !!camera.rtsp_url; // creds come from the stream URL
  return false;
}

// Verify talk credentials without opening a session: an authenticated ISAPI read of the TwoWayAudio
// channel. Resolves { ok: true, codec } or { ok: false, error }. Used by the "Verify login" button
// so a wrong account (the ONVIF-user-vs-web-user trap) is caught before saving, rather than showing
// up later as silent no-audio.
export function verifyTalkCreds({ host, port = 80, username, password, channel = 1 }) {
  return new Promise((resolve) => {
    if (!host || !username || !password) return resolve({ ok: false, error: 'Missing camera address or talk credentials' });
    const path = `/ISAPI/System/TwoWayAudio/channels/${channel}`;
    const attempt = (authHeader, isRetry) => {
      const headers = authHeader ? { Authorization: authHeader } : {};
      const req = http.request({ host, port, path, method: 'GET', timeout: 8000, headers }, (res) => {
        let b = '';
        res.on('data', (d) => (b += d));
        res.on('end', () => {
          if (res.statusCode === 401 && !isRetry && res.headers['www-authenticate']) {
            const ch = parseChallenge(res.headers['www-authenticate']);
            return attempt(digestHeader(ch, 'GET', path, username, password, 1), true);
          }
          if (res.statusCode === 401) {
            return resolve({ ok: false, error: 'Login failed (401) - check the username/password. On Hikvision this must be the camera\'s web (User Management) account, not the ONVIF user.' });
          }
          if (res.statusCode === 200) {
            const codec = /<audioCompressionType>([^<]+)</.exec(b)?.[1] || null;
            return resolve({ ok: true, codec });
          }
          resolve({ ok: false, error: `Camera returned HTTP ${res.statusCode}` });
        });
      });
      req.on('error', (e) => resolve({ ok: false, error: e.message || 'Could not reach the camera' }));
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'Timed out reaching the camera' }); });
      req.end();
    };
    attempt(null, false);
  });
}

// Create (and start) a talk session for a camera. Resolves an object with write(buf) / close().
export async function startTalkSession(camera) {
  if (!talkConfigured(camera)) throw new Error('Two-way audio is not configured for this camera');

  if (camera.talk_backend === 'onvif-backchannel') {
    const parts = parseRtspUrl(camera.rtsp_url);
    if (!parts || !parts.host) throw new Error('Could not parse the camera stream URL for talk-back');
    const session = new OnvifBackchannelTalk(parts);
    await session.start();
    return session;
  }

  const host = hostFromCamera(camera);
  if (!host) throw new Error('Could not determine camera host for talk-back');
  const session = new HikvisionTalk({
    host,
    username: camera.talk_username,
    password: camera.talk_password,
  });
  await session.start();
  return session;
}
