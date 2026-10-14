import { spawn } from 'child_process';

// The ONE way this backend starts ffmpeg, ffprobe and MediaMTX (issue #553, part a).
//
// WHY. Camera streams are untrusted input: IoT cameras get compromised, and ffmpeg/ffprobe parse whatever
// RTSP/RTP a camera sends. These children used to inherit the backend's whole environment, which holds
// JWT_SECRET (when set by env, as the compose file and Unraid template document), FIREBASE_CREDENTIALS and
// anything else an operator put there. A memory-corruption bug in a demuxer would have run with all of it
// readable from /proc/self/environ. No such bug is claimed; this shrinks what one would reach.
//
// WHAT THIS DOES NOT DO. The children still run as the same uid as the backend, so they can still read the
// database and .jwt_secret on disk. Separating the uid was considered and NOT done (owner decision, #553 (b)).
// This is a smaller blast radius, not a sandbox.
//
// THE ALLOWLIST (names, not values; a name that is unset in the parent stays unset in the child):
//   PATH            finds the binary and anything it execs.
//   TZ              the container's zone, so ffmpeg's wall-clock output (segment names) agrees with the app.
//   LANG, LC_ALL    locale; harmless, and some builds print decimal commas without it.
//   MTX_*           MediaMTX ONLY (`mediamtx: true`): its documented way to override mediamtx.yml, e.g. the
//                   MTX_WEBRTCLOCALUDPADDRESS pass-through in docker-compose.yml. ffmpeg gets none of them.
// DELIBERATELY ABSENT, because nothing in this app documents or sets them: HOME (neither tool reads a config
// from it here), LIBVA_*/NVIDIA_* (no hardware decode is configured anywhere; ffmpeg is invoked with
// software decoding only), HTTP(S)_PROXY (cameras are reached by RTSP on the LAN, not through a proxy), and
// LD_LIBRARY_PATH (the Alpine ffmpeg package is dynamically linked against system paths). DNS needs no
// variable: musl's resolver reads /etc/resolv.conf. If a deployment turns out to need one of these, that is a
// feature request: add it to ALLOWED_NAMES with a comment saying which setup needs it, and to the table in
// docs/architecture.md ("Child process environment").
export const ALLOWED_NAMES = Object.freeze(['PATH', 'TZ', 'LANG', 'LC_ALL']);
export const MEDIAMTX_PREFIX = 'MTX_';

// Build the environment for one child. `extra` is explicit, per-call additions (MediaMTX's computed
// MTX_WEBRTCADDITIONALHOSTS); it is applied last, so the caller's own value wins over an inherited one.
export function childEnv({ mediamtx = false, extra = {}, parent = process.env } = {}) {
  const env = {};
  for (const name of ALLOWED_NAMES) {
    if (parent[name] !== undefined) env[name] = parent[name];
  }
  if (mediamtx) {
    for (const name of Object.keys(parent)) {
      if (name.startsWith(MEDIAMTX_PREFIX) && parent[name] !== undefined) env[name] = parent[name];
    }
  }
  return { ...env, ...extra };
}

// spawn() with the allowlisted environment forced on. A caller-supplied `env` in `options` is IGNORED on
// purpose: the only way to add a variable is `extra`, which keeps the allowlist reviewable in one place.
// `source` test (child-env.test.js) fails if any other file calls spawn/execFile directly.
export function spawnChild(command, args, options = {}, { mediamtx = false, extra = {} } = {}) {
  const { env: _ignored, ...rest } = options;
  return spawn(command, args, { ...rest, env: childEnv({ mediamtx, extra }) });
}
