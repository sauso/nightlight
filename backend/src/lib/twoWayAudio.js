import http from 'http';
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

// Whether a camera is set up for talk-back: a supported backend + credentials stored.
export function talkConfigured(camera) {
  return camera.talk_backend === 'hikvision-isapi' && !!camera.talk_username && !!camera.talk_password;
}

// Create (and start) a talk session for a camera. Resolves an object with write(buf) / close().
export async function startTalkSession(camera) {
  if (!talkConfigured(camera)) throw new Error('Two-way audio is not configured for this camera');
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
