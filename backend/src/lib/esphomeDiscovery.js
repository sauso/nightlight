import { createHash } from 'node:crypto';
import { Bonjour } from 'bonjour-service';
import { isPrivateLanIPv4 } from './privateAddress.js';

const defaultCreateBonjour = (onError) => new Bonjour({}, onError);
const validPort = (port) => Number.isInteger(port) && port >= 1 && port <= 65535;
const cleanTxt = (value) => typeof value === 'string' && /^[A-Za-z0-9 ._+-]{1,40}$/.test(value) ? value : undefined;
const cleanPart = (value) => typeof value === 'string' ? Array.from(value.replace(/[\x00-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
    .replace(/\s+/g, ' ').trim()).slice(0, 60).join('') : '';
const cleanName = (friendly, host, ip) => cleanPart(friendly) || cleanPart(host) || `ESPHome device at ${ip}`;

// #1071: browse only ESPHome's service; a response is a suggestion, never a connection or a verified encryption state.
export async function discoverEsphomeDevices({ createBonjour = defaultCreateBonjour, reuseBonjour = null,
  onCandidate = () => {}, signal, timeoutMs = 30000, now = Date.now, existingHosts = new Set(),
} = {}) {
  const candidates = new Map();
  const sourceErrors = [];
  let dropped = 0;
  const begun = now();
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(abort, timeoutMs);
  let bonjour, owned = false, mdnsEmitter, browser;
  let rejectMdns;
  const failure = new Promise((_, reject) => { rejectMdns = reject; });
  const onFatal = (error) => rejectMdns(error);
  try {
    try {
      // #945/#1071: the announcer import has server state, so defer it until a real scan.
      const shared = createBonjour === defaultCreateBonjour
        ? (await import('./mdnsAnnounce.js')).getMdnsBonjour() : reuseBonjour;
      bonjour = shared || createBonjour(onFatal);
      owned = bonjour !== shared;
      // #945: an unhandled UDP error can terminate Node. An owned default socket needs a listener.
      if (owned && createBonjour === defaultCreateBonjour) {
        mdnsEmitter = bonjour?.server?.mdns;
        if (typeof mdnsEmitter?.on !== 'function') throw new Error('mDNS socket errors cannot be watched');
        mdnsEmitter.on('error', onFatal);
      }
      browser = bonjour.find({ type: 'esphomelib', protocol: 'tcp' }, (record) => {
        if (controller.signal.aborted) return;
        const port = validPort(record?.port) ? record.port : 6053;
        const txt = record?.txt && typeof record.txt === 'object' ? record.txt : {};
        for (const ip of Array.isArray(record?.addresses) ? record.addresses : []) {
          if (!isPrivateLanIPv4(ip)) { dropped++; continue; }
          // Keyed by address AND port: one host advertising two ESPHome services (a saved :6053 and a new :6054) must
          // stay two cards, or the later announcement would silently replace the saved one and hide it (#1072 review).
          const key = `${ip}:${port}`;
          let candidate = candidates.get(key);
          if (!candidate && candidates.size >= 20) continue;
          candidate = { id: createHash('sha256').update(key).digest('hex').slice(0, 12), ip,
            name: cleanName(txt.friendly_name, record?.host || record?.name, ip), port };
          const board = cleanTxt(txt.board);
          const version = cleanTxt(txt.version);
          if (board) candidate.board = board;
          if (version) candidate.version = version;
          // #1071: supported encryption alone is not a configured PSK. TXT remains unverified.
          if (typeof txt.api_encryption === 'string' && txt.api_encryption.length > 0) candidate.encrypted = true;
          if (existingHosts.has(`${ip}:${port}`)) candidate.alreadyAdded = true;
          candidates.set(key, candidate);
          onCandidate({ ...candidate });
        }
      });
      await Promise.race([new Promise((resolve) => {
        if (controller.signal.aborted) resolve();
        else controller.signal.addEventListener('abort', resolve, { once: true });
      }), failure]);
    } catch { sourceErrors.push({ source: 'mdns', code: 'DISCOVERY_FAILED' }); }
    finally {
      mdnsEmitter?.off('error', onFatal);
      try { browser?.stop(); } catch { /* the socket still needs closing (#945) */ }
      if (owned) { try { bonjour?.destroy(); } catch { /* scan already ended */ } }
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    controller.abort();
  }
  return { candidates: [...candidates.values()], sourceErrors, dropped, elapsedMs: now() - begun };
}
