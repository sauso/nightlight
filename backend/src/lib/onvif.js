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

// Highest-resolution profile is normally the "main" stream.
function pickBestProfile(profiles) {
  return [...profiles].sort((a, b) => {
    const ar = a?.videoEncoderConfiguration?.resolution || {};
    const br = b?.videoEncoderConfiguration?.resolution || {};
    return (br.width || 0) * (br.height || 0) - (ar.width || 0) * (ar.height || 0);
  })[0];
}

// The path from getStreamUri is trustworthy; the host and any embedded credentials are not
// (see header). Substitute the connect host and the user's credentials.
function buildRtspUrl({ streamUri, host, username, password }) {
  let path = '/';
  let rtspPort = DEFAULT_RTSP_PORT;
  const m = /^rtsps?:\/\/([^/]*)(\/.*)?$/i.exec((streamUri || '').trim());
  if (m) {
    if (m[2]) path = m[2];
    // A host-less URI ("rtsp://user:pass@/path") leaves the authority empty or just creds.
    const authority = m[1] || '';
    const hostPart = authority.includes('@') ? authority.split('@').pop() : authority;
    const portMatch = /:(\d+)$/.exec(hostPart);
    if (portMatch) rtspPort = portMatch[1];
  }
  const cred = username ? `${encodeURIComponent(username)}:${encodeURIComponent(password || '')}@` : '';
  return `rtsp://${cred}${host}:${rtspPort}${path}`;
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
  try {
    cam = await connectStandard(opts);
    profiles = await pcall(cam, 'getProfiles').catch(() => []);
  } catch (err) {
    // Minimal servers fault on GetCapabilities/GetServices during connect - fall through
    // to the direct-media-service path below with an unconnected client.
    logger.info(`[onvif] standard connect failed for ${cleanHost} (${err.message}); trying media service directly`);
    cam = new Cam({ ...opts, autoconnect: false });
    cam.media2Support = false;
  }

  if (profiles.length === 0) {
    let lastErr = null;
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

  const rtspUrl = buildRtspUrl({
    streamUri: stream?.uri || '',
    host: cleanHost,
    username,
    password,
  });

  const info = await pcall(cam, 'getDeviceInformation').catch(() => null);
  const vid = best?.videoEncoderConfiguration || {};
  const aud = best?.audioEncoderConfiguration || {};
  return {
    rtspUrl,
    suggestedName: info ? [info.manufacturer, info.model].filter(Boolean).join(' ').trim() || null : null,
    video: {
      codec: vid.encoding || null,
      width: vid.resolution?.width || null,
      height: vid.resolution?.height || null,
    },
    audio: { codec: aud.encoding || null },
    onvifDeviceUrl: `http://${cleanHost}:${onvifPort}${DEVICE_PATH}`,
  };
}
