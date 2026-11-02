import { Bonjour } from 'bonjour-service';
import { logger } from './logger.js';
import { getServerIdentity } from './serverIdentity.js';

// #937: ANNOUNCE THIS SERVER ON THE LOCAL NETWORK (mDNS / DNS-SD, `_nightlight._tcp`), so a phone can find it
// without anyone typing an address.
//
// WHERE IT WORKS, MEASURED (Connect & Discovery spike, 2026-11-02, this library in a container on an Unraid host,
// browsed from a wired PC with the same library and from a phone's service-browser app on two Wi-Fi networks):
//   * host networking (the shipped default): seen, and the health id matched; no port 5353 clash with the host's
//     own avahi;
//   * an own-address network (ipvlan): seen;
//   * the default Docker bridge: NOT seen (multicast stays inside the bridge). Nothing here can detect that, so the
//     docs say it, and the server logs that it is announcing even when nobody can hear it;
//   * another VLAN: only through a router that reflects mDNS, which most homes do not have.
// Time to appear on the PC varied from 5 to 67 s, and services we do not control were as slow on that PC, so the
// slowness is the test client's. Not measured: iOS, a Raspberry Pi, any real phone app (the phone side is later).
// THIS MODULE, with the real library (#937 smoke test, announcer and the spike's browser on one Windows PC): seen
// after 0.8 s with exactly the records below, /api/health verified on each announced address, gone from the browser
// as soon as it was stopped, the stop resolving in 7 ms, and the process then exiting on its own.
//
// WHAT GOES ON THE WIRE, all of it: the TXT `v=1` and `id=<server id>`; the instance name `Nightlight-<first 8 of the
// id>`; the host name `nightlight-<first 8 of the id>.local`; the port; and the IPv4 address of every non-internal
// network interface the process can see (on a host-network install that includes Docker's bridge addresses; the
// phone is expected to try each and keep the one that answers /api/health with the same id). NOT the display name
// (the phone reads it from /api/health, which is always current, so a rename needs no re-announcement), NOT the
// machine's own host name (the library's default is os.hostname(), which would broadcast e.g. a NAS's name or a
// container id), NOT a version, and no IPv6 for now (the phone side accepts IPv4 private addresses only in v1).
//
// WHAT IT MUST NEVER DO: block or crash the server. Discovery is a convenience; the server works fully without it.
// So every call into the library is inside try/catch, AND the asynchronous failure paths are handled, which a
// try/catch cannot see (plan review of #937, checked in the library source):
//   * multicast-dns reports a failed bind (EACCES, EADDRINUSE or any other code) as an 'error' event on ITS OWN
//     emitter, which bonjour-service exposes as `bonjour.server.mdns`. An 'error' event nobody listens for is thrown
//     by Node as an uncaught exception, so the listener is attached right after construction, before anything is
//     published (the bind completes asynchronously, so this is in time).
//   * bonjour-service's own error callback (answering a query failed) defaults to `throw err`, inside a socket
//     callback: also an uncaught exception. One is always passed.
// There is no retry loop: a server whose announcement failed logs one WARN and carries on.
//
// WHAT THE LIBRARY ALREADY DOES, so this file does not (plan decision 5 of #937): it answers queries, re-announces on
// its own (3 s after the first announcement, then 9 s, 27 s and so on, tripling until the gap would pass an hour, on
// unref'd timers), and sends goodbye packets on unpublishAll. The spike found that enough on the networks measured.
// It reads the interface addresses once, when it first announces: a server whose network interfaces change after
// start announces the old addresses until it is restarted (docs/networking.md says so).

/** How long `up` may take before one WARN says the announcement did not happen. See armWatchdog. */
export const UP_WATCHDOG_MS = 10_000;

/** The longest stopMdnsAnnounce waits for the goodbye packets and the socket close. See stopMdnsAnnounce. */
export const STOP_CAP_MS = 1_500;

// MDNS_ANNOUNCE: on unless it says off. Default ON because the point of the feature is that it works with no setup.
const OFF_VALUES = new Set(['0', 'false', 'no', 'off']);
const ON_VALUES = new Set(['1', 'true', 'yes', 'on']);

/**
 * Read MDNS_ANNOUNCE. Trimmed, any case. `false`, `0`, `no`, `off` turn it off; unset, blank and `true`, `1`,
 * `yes`, `on` leave it on. Anything else also leaves it on (the default), with a warning naming the value, so a
 * typo in an attempt to turn it OFF is not silently ignored.
 * @returns {{ enabled: boolean, warning: string|null }}
 */
export function parseMdnsAnnounce(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  const v = s.toLowerCase();
  if (OFF_VALUES.has(v)) return { enabled: false, warning: null };
  if (v === '' || ON_VALUES.has(v)) return { enabled: true, warning: null };
  return {
    enabled: true,
    warning: `MDNS_ANNOUNCE=${JSON.stringify(s)} is not a recognised value, so this server is announced on the local ` +
      'network (the default). Set it to false, 0, no or off to turn the announcement off.',
  };
}

/**
 * Exactly what is handed to bonjour-service's publish(). Exported for the test that pins it.
 * The instance name is unique per id, not plain "Nightlight": the library PROBES the name first and, if another
 * responder already holds it, stops the service silently (it only console.logs; there is no event). Two
 * Nightlights on one network (staging beside production is a shipped configuration) would otherwise leave one
 * never announced. A copied database still collides (same id): that is the documented known limit, and the
 * watchdog makes it visible.
 * The host name ends in `.local` because that is the mDNS domain (RFC 6762) the SRV target is looked up in, and it
 * is set at all so the machine's own host name is not broadcast (see the header).
 */
export function publishOptions({ id, port }) {
  const short = String(id).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
  return {
    name: `Nightlight-${short}`,
    host: `nightlight-${short}.local`,
    type: 'nightlight',
    protocol: 'tcp',
    port,
    disableIPv6: true,
    txt: { v: '1', id },
  };
}

const defaultCreateBonjour = (opts, errorCallback) => new Bonjour(opts, errorCallback);

// One announcer per process. null = not started (or stopped); otherwise
// { bonjour, service, name, watchdog, up, failed, destroyed, warned, stopping }.
let current = null;

const describeError = (err) => (err?.code ? `${err.code}: ${err.message}` : err?.message || String(err));

// Release the library's socket (and multicast-dns's 5 s interface timer, which is NOT unref'd and would otherwise
// hold the process open) exactly once, whichever path gets here first.
function destroyOnce(s, cb) {
  if (s.destroyed) { if (cb) cb(); return; }
  s.destroyed = true;
  try {
    s.bonjour.destroy(cb ? () => cb() : undefined);
  } catch (err) {
    logger.warn(`[mdns] closing the announcer failed: ${describeError(err)}`);
    if (cb) cb();
  }
}

// A failed bind (or any 'error' event): nothing can be on the wire, so say so once and release the socket.
// `log: false` when the caller has already logged the cause (startMdnsAnnounce's catch), so one fault is one line.
function onFatal(s, err, { log = true } = {}) {
  if (s.failed || s.stopping) return; // multicast-dns emits a bind failure twice (socket 'error', then the bind callback)
  s.failed = true;
  clearTimeout(s.watchdog);
  if (log) {
    logger.warn(
      `[mdns] could not announce this server on the local network (${describeError(err)}). ` +
        'Everything else works; phones can still connect by its address.'
    );
  }
  destroyOnce(s);
}

// Problems the library survives (a malformed packet from another device, one interface refusing the multicast
// group, an answer that failed to send): log the FIRST, at WARN, and carry on. Not fatal, because multicast-dns
// keeps working after them, and a malformed packet from any device on the network must not switch discovery off.
// Only the first, because some repeat: a refused interface is retried, and warns, every 5 s.
function onNonFatal(s, err) {
  // A failed bind with any code but EACCES/EADDRINUSE arrives here first, as a 'warning', and then again as an
  // 'error' from multicast-dns's bind callback, which onFatal reports. Skipped here so one fault is one line (seen
  // in the #937 smoke test: EADDRNOTAVAIL gave two WARNs).
  if (err?.syscall === 'bind') return;
  if (s.warned || s.failed || s.stopping) return;
  s.warned = true;
  logger.warn(`[mdns] network warning (further mDNS warnings are not logged): ${describeError(err)}`);
}

// The library emits `up` once its first announcement has been sent (a probe of about a second first: up to 250 ms
// of jitter, then three queries 250 ms apart). It does NOT emit anything when the probe finds the name taken, so
// silence is the only signal. 10 s is several times the normal second, and short enough that the WARN sits next to
// the start-up lines. It catches the name collision; a multicast send that fails is NOT caught by it (the library
// ignores send errors and still emits `up`), which is why the text says "may".
function armWatchdog(s) {
  s.watchdog = setTimeout(() => {
    if (s.up || s.failed || s.stopping || current !== s) return;
    logger.warn(
      `[mdns] this server has not been announced on the local network after ${UP_WATCHDOG_MS / 1000} s. The name ` +
        `${s.name} may be in use by another server (for example one started from a copy of this database), or ` +
        'multicast may be unavailable. Everything else works; phones can still connect by its address.'
    );
  }, UP_WATCHDOG_MS);
  // A start-up diagnostic must never be what keeps a process alive.
  s.watchdog.unref?.();
}

/**
 * Start announcing. Call once the HTTP server is accepting connections (index.js: in the listen callback, after
 * markBootComplete). Never throws. A second call while one is running is a no-op.
 * @param {object} o
 * @param {number|string} o.port  the port the server listens on (PORT, default 4000)
 * @param {Function} [o.createBonjour]  test seam: (opts, errorCallback) => a bonjour-service instance
 * @param {object} [o.env]  test seam, defaults to process.env
 * @param {Function} [o.getIdentity]  test seam, defaults to the settings row
 */
export function startMdnsAnnounce({
  port,
  createBonjour = defaultCreateBonjour,
  env = process.env,
  getIdentity = getServerIdentity,
} = {}) {
  if (current) return;
  try {
    const { enabled, warning } = parseMdnsAnnounce(env.MDNS_ANNOUNCE);
    if (warning) logger.warn(`[mdns] ${warning}`);
    if (!enabled) {
      // Before the library is constructed: off means no socket is bound at all.
      logger.info('[mdns] not announcing this server on the local network (MDNS_ANNOUNCE is off).');
      return;
    }
    // PORT reaches here as a string from the environment. A value the library would announce wrongly is refused.
    const p = Number(port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      logger.warn(`[mdns] not announcing this server: ${JSON.stringify(String(port))} is not a port number.`);
      return;
    }
    const { id } = getIdentity();
    if (!id) {
      logger.warn('[mdns] not announcing this server: it has no server id (settings.server_id is empty).');
      return;
    }

    const opts = publishOptions({ id, port: p });
    const s = {
      bonjour: null, service: null, name: opts.name, watchdog: null,
      up: false, failed: false, destroyed: false, warned: false, stopping: null,
    };
    s.bonjour = createBonjour({}, (err) => onNonFatal(s, err));
    // Set before anything else can fail, so a throw below still leaves stopMdnsAnnounce able to close the socket.
    current = s;

    const mdns = s.bonjour?.server?.mdns;
    if (typeof mdns?.on !== 'function') {
      // The 'error' listener is what stops a failed bind becoming an uncaught exception. A library version that
      // moved the emitter must not be allowed to publish without it.
      onFatal(s, new Error('the mDNS socket could not be watched for errors (bonjour-service changed?)'));
      return;
    }
    mdns.on('error', (err) => onFatal(s, err));
    mdns.on('warning', (err) => onNonFatal(s, err));

    s.service = s.bonjour.publish(opts);
    s.service.on('up', () => {
      if (s.up || s.failed || s.stopping) return;
      s.up = true;
      clearTimeout(s.watchdog);
      logger.info(`[mdns] announcing this server on the local network as ${opts.name} (_nightlight._tcp, port ${p}).`);
    });
    armWatchdog(s);
  } catch (err) {
    logger.warn(
      `[mdns] could not announce this server on the local network (${describeError(err)}). ` +
        'Everything else works; phones can still connect by its address.'
    );
    if (current) onFatal(current, err, { log: false });
  }
}

/**
 * Stop announcing: send the goodbye packets (so phones drop the entry at once instead of when it expires), then
 * close the socket. Returns a promise that resolves when both are done, or after STOP_CAP_MS, whichever is first;
 * it never rejects. Safe before start, and twice (the second call gets the same promise).
 * WHY A PROMISE, and why shutdown() starts it early and awaits it at the very end (index.js): the goodbye is sent
 * in an asynchronous callback, so a `process.exit(0)` straight after the call can cut it off. Started early, it runs
 * alongside the seconds of awaited stops in shutdown and normally costs nothing; the cap bounds it when the callback
 * never comes (a wedged socket), so it can never push shutdown past the declared stop grace
 * (recordings-shutdown.test.js holds the 23 s bound inside the 30 s grace).
 */
export function stopMdnsAnnounce() {
  const s = current;
  if (!s) return Promise.resolve();
  if (s.stopping) return s.stopping;
  clearTimeout(s.watchdog);
  s.stopping = new Promise((resolve) => {
    let settled = false;
    let cap = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(cap);
      destroyOnce(s); // the cap path: the goodbye never completed, so close the socket without waiting for it
      if (current === s) current = null;
      resolve();
    };
    cap = setTimeout(finish, STOP_CAP_MS);
    if (s.failed || s.destroyed) { finish(); return; }
    try {
      s.bonjour.unpublishAll(() => destroyOnce(s, finish));
    } catch (err) {
      logger.warn(`[mdns] sending the goodbye failed: ${describeError(err)}`);
      finish();
    }
  });
  return s.stopping;
}
