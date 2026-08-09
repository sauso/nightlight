import onvifPkg from 'onvif';
import { logger } from './logger.js';

// ONVIF client used to auto-fill a camera's RTSP URL (and detected codec/resolution) from
// its IP + ONVIF credentials, instead of hand-typing the RTSP path. Deliberately resilient
// to minimal/non-compliant ONVIF servers: the sonoff-hack Sonoff (onvif_simple_server), for
// example, faults on GetCapabilities/GetServices during the library's normal connect, and
// returns host-less stream URIs with bogus embedded credentials. So we:
//   1. try the standard connect, but
//   2. on failure, talk to the media service directly at known paths, and
//   3. rebuild the RTSP URL from the trustworthy part (the path) plus the host we connected
//      to and the credentials the user supplied - never the host/creds the camera returns.
// Discovery-by-multicast is deliberately NOT used: WS-Discovery is L2-multicast and doesn't
// cross VLANs, whereas add-by-IP is unicast and works across a routed network.

const { Cam } = onvifPkg;

const DEFAULT_ONVIF_PORT = 80;
const DEFAULT_RTSP_PORT = 554;
const REQUEST_TIMEOUT_MS = 8000;
// Media-service paths to try when the ONVIF server is too minimal to advertise its own
// endpoints via GetCapabilities. /onvif/media_service covers onvif_simple_server (Sonoff).
const MEDIA_PATH_FALLBACKS = ['/onvif/media_service', '/onvif/media'];
const DEVICE_PATH = '/onvif/device_service';
const PTZ_PATH = '/onvif/ptz_service';
// Camera auto-stops a continuous move after this long even if the Stop command is lost
// (dropped release, network blip) - the runaway-pan failsafe.
const PTZ_MOVE_TIMEOUT_MS = 3000;
// A single "nudge" = a fixed-duration move. Distance is set by this server-side hold time,
// NOT by how long the user held the button or by network timing, so every press travels the
// same amount (see ptzNudge). Tune here if steps feel too big/small.
const PTZ_NUDGE_MS = 200;

function clampVelocity(n) {
  const v = Number(n) || 0;
  return Math.max(-1, Math.min(1, v));
}

// Map an ONVIF SOAP fault to a clear, user-facing reason when it's specifically an auth
// problem - so the add-camera dialog can say "wrong username/password" instead of a vague
// "no profiles found". This matters because repeatedly retrying wrong ONVIF credentials is
// exactly what makes many cameras lock themselves out for ~30 minutes. Returns null for
// anything that isn't recognisably an auth/lockout fault (so those keep their normal message,
// and a minimal server that merely faults on GetCapabilities still falls through to the
// direct-media-service path rather than being mislabelled as an auth failure).
function friendlyAuthError(err) {
  const msg = (err?.message || '').toLowerCase();
  if (!msg) return null;
  // The camera has locked out logins after too many bad attempts (fault wording varies).
  if (msg.includes('locked') || (msg.includes('try') && msg.includes('minute'))) {
    return 'This camera has temporarily locked out logins after too many failed attempts. ' +
      'Wait a few minutes, then try again with the correct ONVIF username and password.';
  }
  // Wrong or missing credentials (explicit auth faults).
  if (
    msg.includes('not authorized') ||
    msg.includes('notauthorized') ||
    msg.includes('unauthorized') ||
    msg.includes('requires authorization') ||
    msg.includes('authentication failed') ||
    msg.includes('auth failed')
  ) {
    return 'The ONVIF username or password appears to be incorrect. Double-check them before ' +
      'retrying — repeated wrong attempts can temporarily lock the camera out.';
  }
  // Some cameras don't return a clean auth fault for bad/blank credentials - instead the
  // library can't parse the (challenge) response and reports a generic "Wrong ONVIF SOAP
  // response". In the add-by-IP flow the overwhelmingly common cause is exactly that, so hint
  // at credentials while hedging (it can also be a wrong ONVIF port or a non-ONVIF device).
  if (msg.includes('wrong onvif soap response') || msg.includes('invalid soap')) {
    return 'The camera rejected the ONVIF request — most often the ONVIF username or password ' +
      'is wrong (repeated wrong attempts can lock the camera out). If they are definitely ' +
      'correct, check the ONVIF port.';
  }
  return null;
}

function connectStandard(opts) {
  return new Promise((resolve, reject) => {
    const cam = new Cam(opts, (err) => (err ? reject(err) : resolve(cam)));
  });
}

function pcall(cam, method, arg) {
  return new Promise((resolve, reject) => {
    const cb = (err, data) => (err ? reject(err) : resolve(data));
    arg === undefined ? cam[method](cb) : cam[method](arg, cb);
  });
}

function profileToken(p) {
  return p?.token || p?.$?.token || p?.$?.Token || null;
}

// Two-way-audio (ONVIF backchannel) support = does the device expose an audio *output*?
// A populated GetAudioOutputConfigurations list => yes; an empty list, or an explicit
// "AudioOutputNotSupported"/"not supported" fault (what the Sonoff returns) => no; any other
// error/timeout => unknown (don't claim either way). Returns 'yes' | 'no' | 'unknown'.
function classifyBackchannel(err, configs) {
  if (!err) return configs && configs.length > 0 ? 'yes' : 'no';
  const msg = (err.message || '').toLowerCase();
  if (msg.includes('not supported') || msg.includes('audiooutputnotsupported')) return 'no';
  return 'unknown';
}

// Highest-resolution profile is normally the "main" stream.
function pickBestProfile(profiles) {
  return [...profiles].sort((a, b) => {
    const ar = a?.videoEncoderConfiguration?.resolution || {};
    const br = b?.videoEncoderConfiguration?.resolution || {};
    return (br.width || 0) * (br.height || 0) - (ar.width || 0) * (ar.height || 0);
  })[0];
}

// Lowest-resolution profile other than the main - the optional "Low quality" sub-stream. Returns
// null when the camera only exposes one profile.
function pickSubProfile(profiles, best) {
  const bestToken = profileToken(best);
  const others = profiles.filter((p) => profileToken(p) !== bestToken);
  if (others.length === 0) return null;
  return others.sort((a, b) => {
    const ar = a?.videoEncoderConfiguration?.resolution || {};
    const br = b?.videoEncoderConfiguration?.resolution || {};
    return (ar.width || 0) * (ar.height || 0) - (br.width || 0) * (br.height || 0);
  })[0];
}

// The path (and any port) from getStreamUri is trustworthy; the host and embedded
// credentials are not (see header) - so we return the path/port as address components and
// pair them with the host we connected to. The app assembles these with the user's
// credentials into the final rtsp:// URL server-side (see routes/cameras.js), so the
// password never lands in a URL field in the UI.
function rtspPartsFromStreamUri({ streamUri, host }) {
  let path = '/';
  let port = DEFAULT_RTSP_PORT;
  const m = /^rtsps?:\/\/([^/]*)(\/.*)?$/i.exec((streamUri || '').trim());
  if (m) {
    if (m[2]) path = m[2];
    // A host-less URI ("rtsp://user:pass@/path") leaves the authority empty or just creds.
    const authority = m[1] || '';
    const hostPart = authority.includes('@') ? authority.split('@').pop() : authority;
    const portMatch = /:(\d+)$/.exec(hostPart);
    if (portMatch) port = portMatch[1];
  }
  return { host, port: String(port), path };
}

/**
 * Probe a camera over ONVIF and return a ready-to-use RTSP URL plus detected media info.
 * Read-only - does not create or modify anything. Throws with a user-facing message on
 * failure (bad host/creds, not an ONVIF camera, timeout).
 */
export async function probeOnvifCamera({ host, port, username, password }) {
  if (!host || !host.trim()) throw new Error('Camera IP address is required');
  const cleanHost = host.trim();
  const onvifPort = Number(port) || DEFAULT_ONVIF_PORT;
  const opts = {
    hostname: cleanHost,
    port: onvifPort,
    username: username || undefined,
    password: password || undefined,
    timeout: REQUEST_TIMEOUT_MS,
  };

  let cam;
  let profiles = [];
  let connectErr = null;
  try {
    cam = await connectStandard(opts);
    profiles = await pcall(cam, 'getProfiles').catch(() => []);
  } catch (err) {
    // Minimal servers fault on GetCapabilities/GetServices during connect - fall through
    // to the direct-media-service path below with an unconnected client. Keep the error
    // though: if it was actually an auth/lockout fault, that's the real reason and we want
    // to report it clearly rather than the generic "no profiles" message.
    connectErr = err;
    logger.info(`[onvif] standard connect failed for ${cleanHost} (${err.message}); trying media service directly`);
    cam = new Cam({ ...opts, autoconnect: false });
    cam.media2Support = false;
  }

  if (profiles.length === 0) {
    let lastErr = connectErr;
    for (const mpath of MEDIA_PATH_FALLBACKS) {
      cam.uri = { ...(cam.uri || {}), media: { path: mpath }, device: { path: DEVICE_PATH } };
      try {
        profiles = await pcall(cam, 'getProfiles');
        if (profiles.length > 0) break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (profiles.length === 0) {
      // Prefer a specific "bad credentials"/"locked out" message when the fault says so -
      // that's what stops the user retrying blindly and re-locking the camera.
      const authMsg = friendlyAuthError(connectErr) || friendlyAuthError(lastErr);
      if (authMsg) throw new Error(authMsg);
      throw new Error(
        `No ONVIF media profiles found at ${cleanHost}:${onvifPort}` +
          (lastErr ? ` (${lastErr.message})` : '') +
          '. Check the IP, port, and ONVIF username/password.'
      );
    }
  }

  const best = pickBestProfile(profiles);
  const stream = await pcall(cam, 'getStreamUri', {
    protocol: 'RTSP',
    profileToken: profileToken(best),
  }).catch((e) => {
    throw new Error(`Connected over ONVIF but could not get the stream URL: ${e.message}`);
  });

  const rtspParts = rtspPartsFromStreamUri({ streamUri: stream?.uri || '', host: cleanHost });

  // Also grab the lowest-res sub-stream's path (if the camera has one), to pre-fill the "Low
  // quality" option in the add/edit form. Best-effort - never fails the probe.
  let subRtspPath = null;
  const sub = pickSubProfile(profiles, best);
  if (sub) {
    const subStream = await pcall(cam, 'getStreamUri', { protocol: 'RTSP', profileToken: profileToken(sub) }).catch(() => null);
    if (subStream?.uri) {
      const subParts = rtspPartsFromStreamUri({ streamUri: subStream.uri, host: cleanHost });
      // Only useful if it's actually a different path from the main stream.
      if (subParts.path && subParts.path !== rtspParts.path) subRtspPath = subParts.path;
    }
  }

  // Phase 2: record whether the camera exposes an audio output (two-way-audio backchannel),
  // while we're already connected. Read-only, best-effort - never fails the probe.
  const backchannel = await new Promise((resolve) => {
    try {
      cam.getAudioOutputConfigurations((e, configs) => resolve(classifyBackchannel(e, configs)));
    } catch {
      resolve('unknown');
    }
  });

  const info = await pcall(cam, 'getDeviceInformation').catch(() => null);
  const vid = best?.videoEncoderConfiguration || {};
  // Hikvision's ONVIF stream URIs carry a `?transportmode=…&profile=Profile_N` query that its own
  // web/RTSP account rejects (401) - the clean /Streaming/Channels/NNN path is what works. Strip it
  // for Hikvision so the pre-filled paths just work. Left intact for other brands (e.g. Dahua needs
  // its ?channel=…&subtype=… query).
  const isHik = /hikvision/i.test(info?.manufacturer || '');
  const cleanPath = (p) => (isHik && p ? p.split('?')[0] : p);
  return {
    // Address components for the add-camera form; the app pairs these with the entered
    // credentials to build the RTSP URL server-side.
    rtspHost: rtspParts.host,
    rtspPort: rtspParts.port,
    rtspPath: cleanPath(rtspParts.path),
    subRtspPath: cleanPath(subRtspPath), // lowest-res sub-stream path for "Low quality", or null

    suggestedName: info ? [info.manufacturer, info.model].filter(Boolean).join(' ').trim() || null : null,
    video: {
      codec: vid.encoding || null,
      width: vid.resolution?.width || null,
      height: vid.resolution?.height || null,
    },
    backchannel, // 'yes' | 'no' | 'unknown' — two-way-audio capability
    // PTZ support: the media profile carries a PTZConfiguration when the camera is
    // pan/tilt/zoom-capable. profileToken is stored so later PTZ commands don't have to
    // re-fetch profiles on every move.
    ptz: !!best?.PTZConfiguration,
    profileToken: profileToken(best),
    onvifDeviceUrl: `http://${cleanHost}:${onvifPort}${DEVICE_PATH}`,
  };
}

// Unconnected Cam with service paths pre-injected, for control ops (PTZ) against minimal
// ONVIF servers - skips the capability discovery those servers fault on. No network here;
// the actual SOAP call happens in the command below. Auth uses local time (no getSystem-
// DateAndTime sync needed) - proven to work against the Sonoff, whose clock tracks NTP.
function makeControlCam({ host, port, username, password }) {
  const cam = new Cam({
    hostname: host,
    port: Number(port) || DEFAULT_ONVIF_PORT,
    username: username || undefined,
    password: password || undefined,
    timeout: REQUEST_TIMEOUT_MS,
    autoconnect: false,
  });
  cam.media2Support = false;
  cam.uri = { media: { path: MEDIA_PATH_FALLBACKS[0] }, ptz: { path: PTZ_PATH }, device: { path: DEVICE_PATH } };
  return cam;
}

// Seed the WS-Security clock before an AUTHENTICATED PTZ command. We deliberately skip the ONVIF
// connect() handshake (the Sonoff faults on GetCapabilities), but that also skips the lib's clock
// sync — leaving `timeShift` unset, so _passwordDigest emits a ~1970 "Created" timestamp (epoch +
// process uptime). A camera that enforces auth rejects that stale timestamp, so PTZ fails whenever
// the ONVIF user has a password (an unauthenticated camera never sees a digest, so it's unaffected).
// Fix: ask the camera its own time via the unauthenticated GetSystemDateAndTime (also corrects a
// camera whose clock is skewed from ours); if it doesn't answer (minimal servers), fall back to our
// wall clock so the timestamp is at least "now". Best-effort and never throws.
function ensureAuthClock(cam) {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      // The lib only sets timeShift if unset; seed from our wall clock when the camera didn't answer.
      if (!cam.timeShift) cam.timeShift = Date.now() - process.uptime() * 1000;
      resolve();
    };
    try {
      cam.getSystemDateAndTime(() => done());
    } catch {
      done();
    }
    setTimeout(done, REQUEST_TIMEOUT_MS); // guard against a hung callback
  });
}

/**
 * Continuous PTZ move at the given velocities (each -1..1). The camera auto-stops after
 * PTZ_MOVE_TIMEOUT_MS as a failsafe; the client should still send ptzStop on release.
 */
export async function ptzContinuousMove({ host, port, username, password, profileToken, pan = 0, tilt = 0, zoom = 0 }) {
  const cam = makeControlCam({ host, port, username, password });
  await ensureAuthClock(cam);
  return new Promise((resolve, reject) => {
    cam.continuousMove(
      {
        x: clampVelocity(pan),
        y: clampVelocity(tilt),
        zoom: clampVelocity(zoom),
        profileToken,
        timeout: PTZ_MOVE_TIMEOUT_MS,
      },
      (err) => (err ? reject(err) : resolve())
    );
  });
}

/** Stop any ongoing PTZ movement. */
export async function ptzStop({ host, port, username, password, profileToken }) {
  const cam = makeControlCam({ host, port, username, password });
  await ensureAuthClock(cam);
  return new Promise((resolve, reject) => {
    cam.stop({ profileToken, panTilt: true, zoom: true }, (err) => (err ? reject(err) : resolve()));
  });
}

/**
 * A single fixed-distance nudge: start moving, hold for a set time, then stop. Because the
 * duration is a server-side constant, every press travels the same amount regardless of how
 * briefly the button was tapped or of network latency - which is what makes the D-pad feel
 * consistent. The continuousMove still carries its own auto-stop timeout, so even if the
 * stop below is lost the camera won't run away. Uses ONE control cam (clock synced once) for
 * both the move and the stop.
 */
export async function ptzNudge({ host, port, username, password, profileToken, pan = 0, tilt = 0, zoom = 0 }) {
  const cam = makeControlCam({ host, port, username, password });
  await ensureAuthClock(cam);
  await new Promise((resolve, reject) => {
    cam.continuousMove(
      { x: clampVelocity(pan), y: clampVelocity(tilt), zoom: clampVelocity(zoom), profileToken, timeout: PTZ_MOVE_TIMEOUT_MS },
      (err) => (err ? reject(err) : resolve())
    );
  });
  await new Promise((r) => setTimeout(r, PTZ_NUDGE_MS));
  // best-effort; the continuousMove auto-stop timeout is the backstop
  await new Promise((resolve) => cam.stop({ profileToken, panTilt: true, zoom: true }, () => resolve()));
}
