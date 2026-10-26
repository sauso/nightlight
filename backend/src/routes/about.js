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

// WHY isolation is off (#553), as backend/entrypoint.sh exported it. The About page warns admins for `fallback` (asked
// for, the host could not give it) and `id-clash` (PUID or PGID is the media user's id; the operator can fix it);
// `disabled` is the operator's switch and `root` is a setup where off is the rule, so those stay quiet.
//
// NO FREE TEXT CROSSES THIS BOUNDARY. This route is readable by every signed-in user, a caregiver included, and the
// entrypoint's warning line can name a file or folder of the host (a leftover backup's name, a path with a person's name
// in it). So the environment supplies only CODES, each checked against a fixed set here (anything else is null, or
// `other` for a cause), and the sentence a person reads comes from the tables below. No value from the environment is
// ever echoed. The log keeps the full free-text warning.
const ISOLATION_REASONS = new Set(['disabled', 'root', 'id-clash', 'fallback']);
// Causes of a fallback, as the entrypoint's MEDIA_CAUSE names them. A Map, so a cause such as "constructor" is not found
// on a prototype. Keep this list and the entrypoint's in step (the tests pin both ends).
const FALLBACK_DETAILS = new Map([
  ['probe-failed', 'The start-up trial run found that a media program could reach files only the app may read, or could not run as the media user.'],
  ['probe-timeout', 'The start-up trial run did not finish in time (a stalled network share, for example) and was abandoned.'],
  ['missing-capability', 'The container lacks a capability the app needs to start the camera programs as a separate user (SETUID, SETGID or KILL), or the trial run could not start.'],
  ['layout-failed', 'The data or clips folders could not be set up for the media user (an owner or permission the host does not allow).'],
  ['top-level-leftover', 'A database, backup or secret is still at the top of the data directory instead of in private/, so the move into private/ has not finished.'],
  ['bad-ids', 'PUID or PGID is not a number.'],
  ['other', 'The host could not support it. The container log has the reason.'],
]);
const ID_CLASH_DETAIL = 'PUID or PGID is 1700, the media user\'s own id. Change it to another number and re-create the container.';
function isolationReason() {
  if (mediaIsolationOn()) return null;
  const v = process.env.MEDIA_ISOLATION_REASON;
  return ISOLATION_REASONS.has(v) ? v : null;
}
function isolationDetail() {
  const reason = isolationReason();
  if (reason === 'id-clash') return ID_CLASH_DETAIL;
  if (reason !== 'fallback') return null;
  const cause = process.env.MEDIA_ISOLATION_CAUSE;
  return FALLBACK_DETAILS.get(cause) ?? FALLBACK_DETAILS.get('other');
}

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
    mediaIsolationReason: isolationReason(),
    mediaIsolationDetail: isolationDetail(),
    dataLayout: DB_LAYOUT,
    layoutConflict: layoutConflict(dataDirFrom()),
  });
});

export default router;
