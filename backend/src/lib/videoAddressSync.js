import { logger } from './logger.js';
import { safeInterval } from './processGuards.js';
import { getTailscaleStatus } from './tailscaleProcess.js';
import { runTailscaleCli } from './tailscaleCli.js';
import { getTailnetAddress, setTailnetAddress, vettedTailnetIPv4 } from './tailnetAddress.js';
import { applyWebrtcHostsLive, getLastAdvertisedHosts } from './mediamtxProcess.js';
import { listWebrtcSessions } from './webrtcSessions.js';

const CHECK_INTERVAL_MS = 15_000;
const FIRST_RETRY_MS = 30_000;
const MAX_RETRY_MS = 10 * 60_000;

// #974: Starting and CLI errors do not erase a known address. Only an explicit off/unavailable
// daemon or NeedsLogin proves that the current address must no longer be advertised.
export async function refreshTailnetAddress({ status = getTailscaleStatus, cli = runTailscaleCli } = {}) {
  const state = status().state;
  if (state === 'off' || state === 'unavailable') { setTailnetAddress(null); return null; }
  if (state !== 'running') return getTailnetAddress();
  const result = await cli('status-peerless');
  if (!result.ok) return getTailnetAddress();
  if (result.json?.BackendState === 'NeedsLogin') setTailnetAddress(null);
  else if (result.json?.BackendState === 'Running') {
    const address = vettedTailnetIPv4(result.json?.Self?.TailscaleIPs);
    if (address) setTailnetAddress(address);
  }
  return getTailnetAddress();
}

export function videoAddressPending(address = getTailnetAddress(), hosts = getLastAdvertisedHosts()) {
  return Boolean(address && !hosts.includes(address));
}

export function createVideoAddressSync({ refresh = refreshTailnetAddress, apply = applyWebrtcHostsLive,
  countViewers = async () => (await listWebrtcSessions()).length, now = () => performance.now(),
  getAddress = getTailnetAddress, getHosts = getLastAdvertisedHosts } = {}) {
  let timer = null;
  let stopRequested = false;
  let running = false;
  let seenAnyAddress = false;
  let firstAddressValue = null;
  let lastAddress = null;
  let nextAttempt = 0;
  let retryMs = FIRST_RETRY_MS;

  const pending = () => videoAddressPending(getAddress(), getHosts());
  const tick = async () => {
    if (running || stopRequested) return false;
    running = true;
    try {
      try { await refresh(); } catch { return false; }
      if (stopRequested) return false;
      const address = getAddress();
      if (!address) {
        // Lead review of #974 (found by reading): after a success `nextAttempt` is Infinity. If the address goes away
        // (logout) and the SAME one returns after a MediaMTX relaunch dropped it, nothing would ever re-apply it, because
        // the address string never changed. Forget the attempt state when the address is gone.
        lastAddress = null; nextAttempt = 0; retryMs = FIRST_RETRY_MS;
        return false;
      }
      if (!seenAnyAddress) { seenAnyAddress = true; firstAddressValue = address; }
      else if (address !== firstAddressValue) firstAddressValue = null;
      const firstAddress = address === firstAddressValue;
      if (!pending()) return false;
      if (address !== lastAddress) { lastAddress = address; nextAttempt = 0; retryMs = FIRST_RETRY_MS; }
      if (now() < nextAttempt) return false;
      if (!firstAddress) {
        let viewers;
        try { viewers = await countViewers(); } catch { return false; } // Unknown is busy.
        if (stopRequested || viewers !== 0) return false;
      }
      if (stopRequested) return false;
      let applied = false;
      try { applied = await apply(); } catch { /* retry on the next backoff rung */ }
      if (stopRequested) return false;
      if (applied) {
        nextAttempt = Infinity;
        logger.info(`[video] tailnet address ${address} added to the WebRTC hosts`);
      } else {
        nextAttempt = now() + retryMs;
        retryMs = Math.min(MAX_RETRY_MS, retryMs * 2);
      }
      return applied;
    } finally { running = false; }
  };

  const applyNow = async () => {
    if (running || stopRequested) return false;
    running = true;
    try {
      let applied = false;
      try { applied = await apply(); } catch { return false; }
      if (stopRequested) return false;
      if (applied) {
        const address = getAddress();
        if (address) {
          seenAnyAddress = true;
          lastAddress = address;
          logger.info(`[video] tailnet address ${address} added to the WebRTC hosts`);
        }
        nextAttempt = Infinity;
        retryMs = FIRST_RETRY_MS;
      }
      return applied;
    } finally { running = false; }
  };

  return {
    tick, pending, applyNow,
    start() {
      if (timer) return timer;
      stopRequested = false;
      timer = safeInterval('video-address-sync', CHECK_INTERVAL_MS, tick);
      timer.unref?.();
      return timer;
    },
    stop() { stopRequested = true; clearInterval(timer); timer = null; },
  };
}

const sync = createVideoAddressSync();
export const startVideoAddressSync = () => sync.start();
export const stopVideoAddressSync = () => sync.stop();
export const applyVideoAddressNow = () => sync.applyNow();
