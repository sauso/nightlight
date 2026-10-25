import fs from 'fs';
import os from 'os';
import path from 'path';
import { mediaIsolationOn, MEDIA_GID } from './childEnv.js';

// The ONE place the STUN_SERVERS setting is read (#558).
//
// WHY THIS EXISTS. Until #558 Google's public STUN server was written into three places that had to agree
// by hand: the browser's RTCPeerConnection (WhepPlayer.jsx), MediaMTX's own ICE list (mediamtx.yml) and the
// Content-Security-Policy's connect-src (cspDirectives.js). Each STUN request tells the server operator the
// viewer's public IP and when each live view connected, and README.md promised "no cloud". Now all three are
// derived from the value parsed here, so turning STUN off cannot leave one of them still reaching Google:
//   - browser:   GET /api/about returns `stunServers`; the player builds iceServers from exactly that list;
//   - MediaMTX:  renderMediamtxConfig() writes the list into the config MediaMTX is started with;
//   - CSP:       cspDirectives.js adds a connect-src entry for each URL in the list and for no other.
//
// SETTING. STUN_SERVERS, a comma-separated list of `stun:host[:port]` URLs.
//   unset                      -> DEFAULT_STUN_SERVERS (Google's, exactly as before #558)
//   set but blank/whitespace   -> NO STUN. Deliberate: it is how you switch it off. (Unraid and compose pass a
//                                 cleared field as an empty string, so "blank" must mean "off", not "default";
//                                 their templates therefore ship the Google URL as the visible default.)
//   otherwise                  -> the valid entries, in order. Anything that is not a `stun:` URL is dropped,
//                                 with ONE warning for the whole value (same rule as TRUST_PROXY and UMASK:
//                                 a typo must never stop a baby monitor starting).
// ⚠️ If EVERY entry is invalid the result is the empty list, not the default: someone who typed a value
// wanted to move away from Google, and falling back to it would contact the very server they were avoiding.
// Cost of failing "off": remote viewers behind some NATs may not connect until the typo is fixed; LAN
// viewing never needs STUN. The warning says so.
//
// Only `stun:` is accepted, not `turn:`/`stuns:`: TURN needs credentials and a relay, which this setting has
// nowhere to carry, and a TURN URL here would silently do nothing useful.

export const DEFAULT_STUN_SERVERS = ['stun:stun.l.google.com:19302'];
// RFC 5389's port for a `stun:` URL without one. The CSP entry has to name it: a host-source with no port
// only matches the scheme's default port, which is not 3478.
const DEFAULT_STUN_PORT = 3478;

// host: a DNS name (labels of letters, digits and hyphens), an IPv4 address (the same shape) or a bracketed
// IPv6 literal. Deliberately strict: the value is pasted into a YAML file and a CSP header, so nothing that
// could carry a space, quote, semicolon or comma may get through.
const STUN_URL = /^stun:((?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*|\[[0-9A-Fa-f:.]+\])(?::(\d{1,5}))?$/;

/** @returns {{ host: string, port: number }|null} null = not a valid stun: URL */
export function parseStunUrl(url) {
  const m = STUN_URL.exec(url);
  if (!m) return null;
  const port = m[2] === undefined ? DEFAULT_STUN_PORT : Number(m[2]);
  if (!(port >= 1 && port <= 65535)) return null;
  return { host: m[1], port };
}

/**
 * @param {string|undefined} raw  the STUN_SERVERS value as read from the environment
 * @returns {{ urls: string[], warning: string|null }}
 */
export function parseStunServers(raw) {
  if (raw === undefined) return { urls: [...DEFAULT_STUN_SERVERS], warning: null };
  const parts = String(raw).split(',').map((p) => p.trim()).filter(Boolean);
  const urls = [];
  const bad = [];
  for (const p of parts) {
    if (parseStunUrl(p)) {
      if (!urls.includes(p)) urls.push(p);
    } else {
      bad.push(p);
    }
  }
  if (bad.length === 0) return { urls, warning: null };
  return {
    urls,
    warning:
      `STUN_SERVERS: ignored ${bad.map((b) => JSON.stringify(b)).join(', ')} (each entry must look like ` +
      `stun:host or stun:host:port). ${urls.length ? `Using ${urls.join(', ')}.` : 'No valid entry is left, so STUN is OFF: ' +
      'viewing on your home network is unaffected, but a viewer behind some NATs may not connect until this is fixed.'}`,
  };
}

/** The CSP connect-src source for one STUN URL, e.g. `stun.l.google.com:19302`. */
export function stunCspSource(url) {
  const p = parseStunUrl(url);
  return p ? `${p.host}:${p.port}` : null;
}

// The line in mediamtx.yml that this module replaces. It is an empty list in the file on purpose (not Google's
// default): the file then cannot contradict the setting, and a MediaMTX started from the raw file contacts
// nobody. stunServers.test.js fails if the file stops containing exactly this line.
export const MEDIAMTX_ICE_LINE = 'webrtcICEServers2: []';

/**
 * mediamtx.yml's text with the ICE list filled in from `urls`.
 * Throws if the template no longer has MEDIAMTX_ICE_LINE: a silent no-op here would start MediaMTX with the
 * wrong list, which is exactly what this module exists to prevent.
 */
export function renderMediamtxConfig(baseText, urls) {
  const re = new RegExp(`^${MEDIAMTX_ICE_LINE.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}[ \\t]*$`, 'm');
  if (!re.test(baseText)) throw new Error(`mediamtx.yml has no "${MEDIAMTX_ICE_LINE}" line to fill in`);
  // #740: a Windows checkout gives us CRLF; joining with LF made a mixed-ending MediaMTX copy.
  const newline = baseText.includes('\r\n') ? '\r\n' : '\n';
  const block = urls.length
    ? `webrtcICEServers2:${newline}${urls.map((u) => `  - url: ${u}`).join(newline)}`
    : MEDIAMTX_ICE_LINE;
  // A replacer function, not a string: `$` in a replacement string is special and a URL is not trusted text.
  return baseText.replace(re, () => block);
}

/**
 * Writes the config MediaMTX is started with and returns its path. MediaMTX has no documented way to take a
 * list of objects from the environment, and the image's /app is not writable by the app user, so the filled-in
 * copy goes to the temp directory on every start (never persisted, so it can never go stale: the same reason
 * the base file lives in the image and not the data volume).
 *
 * If it cannot be written the BASE file is returned: its list is empty, so the failure mode is "no STUN",
 * never "Google when you asked for none".
 *
 * #553, with media isolation on (`mediaGid` set), MediaMTX runs as the media user, another uid, and could not read
 * the copy above: the app writes it under its own UMASK (default 077, so 0600). So the copy then goes into a FRESH
 * folder made for this start (mkdtemp: a new random name, created atomically, so nothing can be planted in it
 * beforehand) with the media group and modes 0750 / 0640: the media user may read it and nothing else. Not the fixed
 * /tmp/nightlight-mediamtx.yml: /tmp is shared with the media user, who could leave a symlink at that name for the
 * next start to write THROUGH (fs.protected_symlinks is 0 on some hosts, Unraid among them). The file holds no secret
 * (mediamtx.yml has none; camera paths are added later through the API). One small folder per container start is left
 * in the temp directory; it is never reused. If any step fails, the base file is used, as above. The general rule for
 * app-written files the media user reads comes with the later phases of #553; this is the one MediaMTX needs to start.
 */
export function writeMediamtxConfig(basePath, urls, { tmpDir = os.tmpdir(), log = null, mediaGid = mediaIsolationOn() ? MEDIA_GID : null } = {}) {
  try {
    const text = renderMediamtxConfig(fs.readFileSync(basePath, 'utf8'), urls);
    if (mediaGid == null) {
      const out = path.join(tmpDir, 'nightlight-mediamtx.yml');
      fs.writeFileSync(out, text);
      return out;
    }
    const dir = fs.mkdtempSync(path.join(tmpDir, 'nightlight-mediamtx-'));
    // The group first, then the mode (chmod sets exactly these bits whatever the umask made). The app may give its
    // own folder and file to the media group because the PROCESS has that group: the entrypoint's isolated start
    // passes --groups=PGID,1700 (the kernel checks the process's groups, not /etc/group, and the image does not make
    // the app a member). No capability is involved.
    fs.chownSync(dir, -1, mediaGid);
    fs.chmodSync(dir, 0o750);
    const out = path.join(dir, 'mediamtx.yml');
    fs.writeFileSync(out, text, { flag: 'wx', mode: 0o640 });
    fs.chownSync(out, -1, mediaGid);
    fs.chmodSync(out, 0o640);
    return out;
  } catch (err) {
    if (log) log.error(`[mediamtx] could not write the STUN-aware config (${err.message}); starting with no STUN servers`);
    return basePath;
  }
}
