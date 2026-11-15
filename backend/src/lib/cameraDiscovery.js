import { createHash, randomUUID } from 'node:crypto';
import { Bonjour } from 'bonjour-service';
import onvifPkg from 'onvif';
import { isPrivateLanIPv4 } from './privateAddress.js';

const defaultCreateBonjour = (onError) => new Bonjour({}, onError);

const cleanName = (value, ip) => {
  const name = typeof value === 'string' ? Array.from(value.replace(/[\x00-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
    .replace(/\s+/g, ' ').trim()).slice(0, 60).join('') : '';
  return name || `Camera at ${ip}`;
};
const cleanTxt = (value) => typeof value === 'string' && /^[A-Za-z0-9 ._+-]{1,40}$/.test(value) ? value : undefined;
const validPort = (port) => Number.isInteger(port) && port >= 1 && port <= 65535;
const idFor = (ip) => createHash('sha256').update(ip).digest('hex').slice(0, 12);

// The package closes its own UDP socket when its callback timer fires. Its resolve:false mode
// avoids Cam construction and any credentialed connection. Keep this timeout under the 30 s
// manager hard stop so there is no socket left after an aborted scan (#945).
export function probeOnvifDiscovery({ timeoutMs, onDevice }) {
  return new Promise((resolve, reject) => {
    const discovery = onvifPkg.Discovery;
    // This library emits 'error' on a singleton before invoking the callback. Without a
    // listener, one malformed LAN response can terminate Node (#945).
    const onError = () => {};
    discovery.on('error', onError);
    let settled = false;
    const duration = Math.min(timeoutMs, 29000);
    const removeListener = () => discovery.off('error', onError);
    const cleanupTimer = setTimeout(removeListener, duration + 100);
    cleanupTimer.unref();
    try {
      discovery.probe({ resolve: false, timeout: duration }, (error, devices) => {
        if (settled) return;
        settled = true;
        if (!error) { clearTimeout(cleanupTimer); removeListener(); }
        try { for (const device of devices || []) onDevice(device); }
        catch (cause) { reject(cause); return; }
        if (error) reject(new Error('ONVIF discovery failed'));
        else resolve();
      });
    } catch (error) { clearTimeout(cleanupTimer); removeListener(); reject(error); }
  });
}

// existingHosts: the IPs of cameras already saved. A discovered camera at one of those IPs is NOT dropped; it is
// returned with `alreadyAdded: true` so the screen can show it greyed out (#950). It still counts toward the
// 20-candidate cap and still passes the private-address filter and the name sanitising like any other.
export async function discoverCameras({
  createBonjour = defaultCreateBonjour, reuseBonjour = null,
  wsProbe = probeOnvifDiscovery, onCandidate = () => {}, signal,
  timeoutMs = 30000, now = Date.now, existingHosts = new Set(),
} = {}) {
  const candidates = new Map();
  const sourceErrors = [];
  let dropped = 0;
  const ports = new Map();
  const begun = now();
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(abort, timeoutMs);
  const alive = () => !controller.signal.aborted;
  const add = (ip, source, name, txt = {}) => {
    if (!alive()) return;
    if (!isPrivateLanIPv4(ip)) { dropped++; return; }
    let candidate = candidates.get(ip);
    if (!candidate) {
      if (candidates.size >= 20) return;
      candidate = { id: idFor(ip), ip, name: cleanName(name, ip), rtspPort: ports.get(ip) || 554, sources: [] };
      // A saved camera is kept and marked, not dropped (#950): leaving it out looked like a missed camera.
      // The flag is present only when true, so a camera that is not saved carries no extra field.
      if (existingHosts.has(ip)) candidate.alreadyAdded = true;
      candidates.set(ip, candidate);
    }
    if (!candidate.sources.includes(source)) candidate.sources.push(source);
    if (source === 'mdns') {
      candidate.name = cleanName(name, ip);
      const product = cleanTxt(txt?.product);
      const streamer = cleanTxt(txt?.streamer);
      if (product) candidate.product = product;
      if (streamer) candidate.streamer = streamer;
    }
    onCandidate({ ...candidate, sources: [...candidate.sources] });
  };
  const mdns = async () => {
    let bonjour, owned = false;
    let mdnsEmitter;
    const browsers = [];
    let rejectMdns;
    const failure = new Promise((_, reject) => { rejectMdns = reject; });
    const onFatal = (error) => rejectMdns(error);
    try {
      // Delay the announcer import until a real scan. It pulls in server state, while
      // importing this discovery module must have no database or network side effects.
      const shared = createBonjour === defaultCreateBonjour
        ? (await import('./mdnsAnnounce.js')).getMdnsBonjour() : reuseBonjour;
      bonjour = shared || createBonjour(onFatal);
      owned = bonjour !== shared;
      if (owned && createBonjour === defaultCreateBonjour) {
        mdnsEmitter = bonjour?.server?.mdns;
        if (typeof mdnsEmitter?.on !== 'function') throw new Error('mDNS socket errors cannot be watched');
        mdnsEmitter.on('error', onFatal);
      }
      const main = bonjour.find({ type: 'thingino', protocol: 'tcp' }, (record) => {
        for (const ip of record?.addresses || []) add(ip, 'mdns', record.name, record.txt);
      });
      browsers.push(main);
      const rtsp = bonjour.find({ type: 'rtsp', protocol: 'tcp' }, (record) => {
        if (!validPort(record?.port)) return;
        for (const ip of record?.addresses || []) {
          if (!isPrivateLanIPv4(ip)) { dropped++; continue; }
          ports.set(ip, record.port);
          const candidate = candidates.get(ip);
          if (candidate) { candidate.rtspPort = record.port; onCandidate({ ...candidate, sources: [...candidate.sources] }); }
        }
      });
      browsers.push(rtsp);
      const untilAbort = new Promise((resolve) => {
        if (!alive()) return resolve();
        controller.signal.addEventListener('abort', resolve, { once: true });
      });
      await Promise.race([untilAbort, failure]);
    } finally {
      mdnsEmitter?.off('error', onFatal);
      for (const browser of browsers) {
        try { browser?.stop(); } catch { /* the other browser and socket still need closing */ }
      }
      if (owned) {
        try { bonjour?.destroy(); } catch { /* the scan has already ended */ }
      }
    }
  };
  const ws = async () => Promise.race([wsProbe({ timeoutMs: Math.min(timeoutMs, 29000), signal: controller.signal, onDevice: (device) => {
    const raw = device?.probeMatches?.probeMatch?.XAddrs;
    for (const address of typeof raw === 'string' ? raw.split(/\s+/) : []) {
      try {
        const url = new URL(address);
        // WHATWG URL normalises octal/hex IPv4 spelling. Require the wire hostname
        // to be the same literal dotted quad before accepting it (#945).
        const wireHost = /^https?:\/\/([^/?#:]+)(?::\d+)?(?:[/?#]|$)/i.exec(address)?.[1];
        if (wireHost !== url.hostname) { dropped++; continue; }
        add(url.hostname, 'onvif', device?.name);
      } catch { dropped++; }
    }
  } }), new Promise((resolve) => {
    if (!alive()) resolve();
    else controller.signal.addEventListener('abort', resolve, { once: true });
  })]);
  try {
    await Promise.all([['mdns', mdns], ['onvif', ws]].map(async ([source, run]) => {
      try { await run(); } catch { sourceErrors.push({ source, code: 'DISCOVERY_FAILED' }); }
    }));
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    controller.abort();
  }
  return { candidates: [...candidates.values()], sourceErrors, dropped, elapsedMs: now() - begun };
}

export function createScanManager({ discover = discoverCameras, existingHosts = () => new Set(),
  now = Date.now, setTimer = (fn, ms) => { const timer = setTimeout(fn, ms); return () => clearTimeout(timer); },
} = {}) {
  const scans = new Map();
  let active = null;
  const prune = () => {
    for (const [id, scan] of scans) if (scan.done && now() - scan.finishedAt >= 300000) scans.delete(id);
    while (scans.size > 8) scans.delete(scans.keys().next().value);
  };
  return {
    start() {
      prune();
      if (active) return { scanId: active.scanId, reused: true, endsAt: active.endsAt };
      const scanId = randomUUID();
      const startedAt = now();
      const scan = { scanId, startedAt, endsAt: startedAt + 30000, done: false,
        candidates: [], sourceErrors: [], controller: new AbortController() };
      scans.set(scanId, scan);
      active = scan;
      const finish = () => {
        if (scan.done) return;
        scan.done = true;
        scan.finishedAt = now();
        scan.cancelTimer();
        scan.controller.abort();
        if (active === scan) active = null;
        prune();
      };
      scan.cancelTimer = setTimer(finish, 30000);
      Promise.resolve().then(() => discover({ signal: scan.controller.signal, existingHosts: existingHosts(),
        onCandidate: (candidate) => {
          if (scan.done) return;
          // Merge by id when there is one: a camera's id is a hash of its IP, so cameras behave exactly as before,
          // while the ESPHome search (same manager) has one host with two services as two entries (#1072 review).
          const index = scan.candidates.findIndex((item) => (item.id ?? item.ip) === (candidate.id ?? candidate.ip));
          if (index < 0) scan.candidates.push(candidate);
          else scan.candidates[index] = candidate;
        } })).then((result) => {
        if (!scan.done) {
          scan.candidates = result.candidates;
          scan.sourceErrors = result.sourceErrors;
        }
      }, () => { if (!scan.done) scan.sourceErrors.push({ source: 'scan', code: 'DISCOVERY_FAILED' }); }).finally(finish);
      return { scanId, reused: false, endsAt: scan.endsAt };
    },
    get(id) {
      prune();
      const scan = scans.get(id);
      return scan ? { done: scan.done, candidates: scan.candidates, sourceErrors: scan.sourceErrors,
        startedAt: scan.startedAt, endsAt: scan.endsAt } : null;
    },
  };
}
