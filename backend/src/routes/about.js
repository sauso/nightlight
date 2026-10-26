import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { requireAuth } from '../middleware/auth.js';
import { parseStunServers } from '../lib/stunServers.js';
import { getPublicBaseUrl } from '../lib/push.js';
import { mediaIsolationOn } from '../lib/childEnv.js';
import { DB_LAYOUT } from '../db.js';
import { dataDirFrom, layoutConflict } from '../lib/dataPaths.js';

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
  // mediaIsolation (#553): 'on' when ffmpeg, ffprobe and MediaMTX run as the separate media user, 'off' otherwise. It
  // is what backend/entrypoint.sh decided and exported at start (lib/childEnv.js, mediaIsolationOn), never guessed
  // here. Added to the response, nothing else changed (an older app reading it ignores the field). The About page
  // shows it as one line (frontend/src/pages/About.jsx) since isolation became the default (#553 phase 4).
  // dataLayout and layoutConflict (#553 phase 2a, both added, nothing else changed): where the database this server
  // OPENED is ('private' = DATA_DIR/private/, 'legacy' = the top level, an install the start-up move has not reached),
  // and whether a copy waits for the owner's decision (a private/legacy-* folder the move set aside, or a second
  // database at the top level). The conflict is read per request, so deleting the set-aside folder clears it at once.
  res.json({
    version,
    ...build,
    stunServers: parseStunServers(process.env.STUN_SERVERS).urls,
    publicBaseUrl: getPublicBaseUrl(),
    mediaIsolation: mediaIsolationOn() ? 'on' : 'off',
    dataLayout: DB_LAYOUT,
    layoutConflict: layoutConflict(dataDirFrom()),
  });
});

export default router;
