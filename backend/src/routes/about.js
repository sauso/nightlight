import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { requireAuth } from '../middleware/auth.js';
import { parseStunServers } from '../lib/stunServers.js';
import { getPublicBaseUrl } from '../lib/push.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Read once at startup - the version can't change without a restart anyway.
let version = 'unknown';
try {
  version = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')).version;
} catch {
  // Leave as 'unknown' rather than fail startup over cosmetic info.
}

// Build provenance baked in by CI (see Dockerfile / docker-publish.yml). Lets the About
// page show exactly which commit/branch this instance is running - so you can verify a
// deploy from the app rather than trusting the release-only version number.
function envOrNull(name) {
  const v = process.env[name];
  return v && v !== 'unknown' ? v : null;
}
const build = {
  gitSha: envOrNull('NIGHTLIGHT_GIT_SHA'),
  gitRef: envOrNull('NIGHTLIGHT_GIT_REF'),
  buildTime: envOrNull('NIGHTLIGHT_BUILD_TIME'),
};

const router = Router();

router.get('/', requireAuth, (req, res) => {
  // stunServers (#558): the ICE servers the live-view player must use, from the STUN_SERVERS setting. Here
  // (signed-in, and already fetched by the app) rather than baked into the frontend build, so the browser
  // follows the operator's setting. Read per request, not at load, so a test can change the environment.
  // publicBaseUrl (#559): the address this server stamps into its own alert links (getPublicBaseUrl), or null.
  // The app compares an alert's address with it, so a household that reaches the server by two addresses is
  // not asked to "switch" to the server it is already on. Read per request: an admin's phone can change it.
  res.json({ version, ...build, stunServers: parseStunServers(process.env.STUN_SERVERS).urls, publicBaseUrl: getPublicBaseUrl() });
});

export default router;
