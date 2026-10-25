import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

// The ONE way this backend starts ffmpeg, ffprobe and MediaMTX (issue #553, part a).
//
// WHY. Camera streams are untrusted input: IoT cameras get compromised, and ffmpeg/ffprobe parse whatever
// RTSP/RTP a camera sends. These children used to inherit the backend's whole environment, which holds
// JWT_SECRET (when set by env, as the compose file and Unraid template document), FIREBASE_CREDENTIALS and
// anything else an operator put there. Whatever a child INHERITS is what leaks through a bug that discloses
// the child's own memory or environment (a demuxer over-read, a crash report, a log line), and what every
// command a MediaMTX hook runs inherits in turn. No such bug is claimed; this narrows what one would expose.
//
// WHAT THIS DOES NOT DO (yet). By default the children still run as the same operating-system user as the backend.
// A child that a camera managed to take over could therefore still read the backend's own environment through the
// process table (/proc on Linux), JWT_SECRET included, and the database and .jwt_secret on disk. This narrows what a
// child inherits; it is not a sandbox. The earlier decision not to separate the user (#553 (b)) was reversed by the
// owner on 2026-10-25: MEDIA ISOLATION below runs every child as a second user. It is behind an internal switch,
// off by default, until the shared-folder layout and the secrets move (later phases of #553) let ffmpeg write
// recordings as that user; until then only streaming works with it on.
//
// THE ALLOWLIST (names, not values; a name that is unset in the parent stays unset in the child):
//   PATH            finds the binary and anything it execs.
//   TZ              the container's zone, so ffmpeg's wall-clock output (segment names) agrees with the app.
//   LANG, LC_ALL    locale, forwarded so a child formats times the way the server's locale does; harmless
//                   either way (the Dockerfile, compose file and Unraid template set neither).
//   MTX_*           MediaMTX ONLY (`mediamtx: true`): its documented way to override mediamtx.yml, e.g. the
//                   MTX_WEBRTCLOCALUDPADDRESS pass-through in docker-compose.yml. ffmpeg gets none of them.
// DELIBERATELY ABSENT, because nothing in this app documents or sets them: HOME (neither tool reads a config
// from it here), LIBVA_*/NVIDIA_* (no hardware decode is configured anywhere; ffmpeg is invoked with
// software decoding only), HTTP(S)_PROXY (cameras are reached by RTSP on the LAN, not through a proxy),
// LD_LIBRARY_PATH (the Alpine ffmpeg package is dynamically linked against system paths), and RTSP_*
// (MediaMTX's legacy override prefix, which upstream still reads; MTX_* is the spelling we pass). DNS needs no
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

// MEDIA ISOLATION (#553). When it is on, every child runs as the media user (uid:gid 1700:1700, no capabilities,
// no-new-privs) through media-exec.sh, which is exactly one `umask 007; exec setpriv ... -- "$@"` (see its header).
//
// WHO DECIDES. backend/entrypoint.sh, as root, before the app exists: it dry-runs the whole chain (the app's own drop
// to PUID with CAP_SETUID/SETGID/KILL as ambient capabilities, then this wrapper) and exports MEDIA_ISOLATION=on only
// if all of it worked, otherwise MEDIA_ISOLATION=off and the usual su-exec start. It always exports one of the two,
// so a value an operator put in the environment never reaches here. The app only reports what it was given: Node
// cannot drop capabilities, so a fallback decided HERE ("run unwrapped") would hand SETUID/SETGID/KILL to every child.
// That is why, when it is on, EVERY call below is wrapped and there is no unwrapped path at all.
// NIGHTLIGHT_MEDIA_ISOLATION (the switch, read only by the entrypoint) and MEDIA_ISOLATION are not in ALLOWED_NAMES,
// so no child sees either.
//
// WHERE THE WRAPPER IS. Next to the backend's root, found from this file's own location: /app/media-exec.sh in the
// image (this file is /app/src/lib/childEnv.js), backend/media-exec.sh in a checkout. The entrypoint finds it the same
// way, next to itself, so the dry run tests the very file this spawns.
export const MEDIA_EXEC_PATH = fileURLToPath(new URL('../../media-exec.sh', import.meta.url));
// The media user and group. Must equal the ids in media-exec.sh, the Dockerfile (nlmedia) and entrypoint.sh (MEDIA_ID).
export const MEDIA_UID = 1700;
export const MEDIA_GID = 1700;

// Read at CALL time, not at load, so a test can switch it per case.
export function mediaIsolationOn(env = process.env) {
  return env.MEDIA_ISOLATION === 'on';
}

// spawn() with the allowlisted environment forced on. A caller-supplied `env` in `options` is IGNORED on
// purpose: the only way to add a variable is `extra`, which keeps the allowlist reviewable in one place.
// `source` test (child-env.test.js) fails if any other file calls spawn/execFile directly.
// With media isolation on, the same command and arguments go to the wrapper, with the same options and environment:
// the program is the wrapper's first argument. The returned ChildProcess is the wrapper's, and because the wrapper
// execs (twice: sh into setpriv, setpriv into the program) its pid IS the program's, which is what every kill uses.
export function spawnChild(command, args, options = {}, { mediamtx = false, extra = {} } = {}) {
  const { env: _ignored, ...rest } = options;
  if (mediaIsolationOn()) {
    return spawn(MEDIA_EXEC_PATH, [command, ...(args ?? [])], { ...rest, env: childEnv({ mediamtx, extra }) });
  }
  return spawn(command, args, { ...rest, env: childEnv({ mediamtx, extra }) });
}
