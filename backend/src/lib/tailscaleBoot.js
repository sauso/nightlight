import { detectHostNetwork } from './hostNetwork.js';
import { startTailscale } from './tailscaleProcess.js';
import { logger } from './logger.js';

export function bootTailscale({ db, dataDir, detector = detectHostNetwork,
  start = startTailscale, log = logger } = {}) {
  try {
    const hostNetwork = detector();
    // Opus plan review of #967: the one boot line contains fixed codes only, so a
    // user can check the network decision without disclosing interface names.
    log.info(`[tailscale] network check: ${JSON.stringify(hostNetwork)}`);
    if (db.prepare("SELECT tailscale_enabled FROM settings WHERE id = 'app'").get()?.tailscale_enabled === 1) {
      start({ db, dataDir });
    }
  } catch {
    // Opus plan review of #967: a detector or DB fault after listen must not turn
    // persisted intent into a permanent startup crash loop.
    try { log.warn('[tailscale] boot check failed'); } catch { /* logging is best effort */ }
  }
}
