import { api } from './api.js';

// The ICE (STUN) servers the live-view player hands to RTCPeerConnection (#558).
//
// They come from the server's STUN_SERVERS setting, via GET /api/about, and not from a constant in this file:
// the browser used to be hard-wired to Google's public STUN server, which told Google the viewer's public IP
// and the time of every live view, with no way to turn it off. The same setting also drives MediaMTX and the
// Content-Security-Policy, so the three cannot disagree.
//
// ⚠️ FAILS TO NO STUN, NEVER TO GOOGLE. If the request fails (offline, signed out, an older server that does
// not send the field) the answer is an empty list for that connection attempt. Same-network viewing does not
// need STUN, and the player retries every few seconds, so the next attempt asks again. Only a SUCCESSFUL answer
// is remembered for the life of the page: caching a failure would switch STUN off for a remote viewer until
// they reloaded.
let cached = null;

export function getIceServers() {
  if (cached) return cached;
  const attempt = api
    .get('/about')
    .then((about) => {
      const urls = Array.isArray(about?.stunServers) ? about.stunServers.filter((u) => typeof u === 'string') : null;
      if (!urls) throw new Error('no stunServers in /about');
      return urls.length ? [{ urls }] : [];
    })
    .catch(() => {
      if (cached === attempt) cached = null;
      return [];
    });
  cached = attempt;
  return attempt;
}

// Test seam: the cache outlives a test, and the setting is per test.
export function resetIceServersCache() {
  cached = null;
}
