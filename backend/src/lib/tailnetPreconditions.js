import fs from 'node:fs';
import { detectHostNetwork } from './hostNetwork.js';

export const TAILSCALED_BINARY = '/usr/local/bin/tailscaled';

// Supervisor contract: check this before starting the tunnel daemon on every start AND restart,
// not only when someone clicks enable. A restored database can have no admin even if it once did.
export function firstAdminExists(db) {
  return Boolean(db.prepare("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1").get());
}

export function tailnetEnableBlocker(db, { hostNetwork = detectHostNetwork(), binaryPath = TAILSCALED_BINARY } = {}) {
  if (!firstAdminExists(db)) return {
    code: 'no_admin', message: 'Create the first admin account on your home network before turning on Tailscale.',
  };
  // Opus plan review of #967: unknown namespace evidence must refuse as well as a
  // positively detected shared namespace; a missing binary must never be an allow default.
  if (hostNetwork.host || (hostNetwork.unknown && hostNetwork.unknown !== 'not_linux')) return {
    code: 'host_network', message: 'Tailscale cannot be used with host networking or an unverified network. Give Nightlight its own address first.',
  };
  try {
    if (!fs.statSync(binaryPath).isFile()) throw Error('not a file');
    fs.accessSync(binaryPath, fs.constants.X_OK);
  }
  catch { return { code: 'not_installed', message: 'The Tailscale tunnel daemon is not installed.' }; }
  return null;
}
