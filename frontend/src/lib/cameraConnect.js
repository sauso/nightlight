import { api, SLOW_REQUEST_TIMEOUT_MS } from './api.js';

// The two API conversations behind adding a camera, shared by the full camera form (CameraForm) and the
// login-only card on the Add camera screens (AddCameraFlow, #950). They live here so both build the SAME
// request: the ONVIF probe and the save payload must not drift apart between the two forms.

// Ask the camera over ONVIF for its stream port, paths and capabilities. Throws the server's own message
// (a wrong login, a lock-out warning, a timeout): callers show it verbatim and never retry on their own,
// because repeated wrong logins are what makes many cameras lock themselves out.
//
// `fields` holds only what the camera answered with ('' when it said nothing), so a caller can keep what a
// person already typed for anything the camera left blank. `extra` is what a saved camera must remember
// about how it was found; `caps` is what the form shows about two-way audio.
export async function probeCamera({ host, username, password, id }) {
  const r = await api.post('/cameras/onvif-probe', {
    host, username: username || undefined, password: password || undefined, id,
  }, { timeoutMs: SLOW_REQUEST_TIMEOUT_MS }); // the server allows the probe up to 18 s itself
  const res = r.video?.width ? `${r.video.codec || ''} ${r.video.width}×${r.video.height}`.trim() : r.video?.codec || '';
  const talk = r.backchannel === 'yes' ? ' · two-way audio' : r.backchannel === 'no' ? ' · no two-way audio' : '';
  const ptz = r.ptz ? ' · PTZ' : '';
  const motion = r.motionEvents === 'yes' ? ' · ONVIF motion' : '';
  const low = r.subRtspPath ? ' · low-quality stream' : '';
  return {
    fields: {
      rtsp_host: r.rtspHost || host,
      rtsp_port: r.rtspPort || '',
      rtsp_path: r.rtspPath || '',
      sub_rtsp_path: r.subRtspPath || '',
    },
    extra: {
      discovery_source: 'onvif',
      onvif_device_url: r.onvifDeviceUrl,
      backchannel_supported: r.backchannel,
      motion_events_supported: r.motionEvents,
      ptz_supported: r.ptz ? 1 : 0,
      onvif_profile_token: r.profileToken || null,
    },
    caps: { backchannel_supported: r.backchannel, backchannel_verified: r.backchannelVerified },
    summary: `Found stream${res ? ` — ${res}` : ''}${talk}${ptz}${motion}${low}. Port & path filled in.`,
  };
}

// The body of POST /cameras. A blank child is sent as null (unassigned); `force` is the "Save anyway" answer
// to a stream test the server refused.
export function buildCameraPayload(form, extra, { force = false } = {}) {
  return { ...form, child_id: form.child_id || null, ...extra, ...(force ? { force: true } : {}) };
}
