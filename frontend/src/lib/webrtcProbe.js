import { getToken } from './api.js';
import { getIceServersWithin } from './iceServers.js';
import { resolveWhepResource } from './whep.js';

const DEADLINE_MS = 10000;

export function selectedRemoteCandidate(stats) {
  const values = [...stats.values()];
  const transport = values.find((entry) => entry.type === 'transport' && entry.selectedCandidatePairId);
  const pair = (transport && stats.get(transport.selectedCandidatePairId))
    || values.find((entry) => entry.type === 'candidate-pair' && entry.nominated && entry.state === 'succeeded');
  const remote = pair && stats.get(pair.remoteCandidateId);
  return { protocol: remote?.protocol ?? null, candidateType: remote?.candidateType ?? null };
}

// WHY this runs on the viewer's device: only that route can say whether this viewer can receive
// live video. An external probe would contact a third party, breaking Nightlight's privacy promise (#558).
export async function probeLowLatency({ mediamtxPath, signal } = {}) {
  if (typeof RTCPeerConnection === 'undefined') return { outcome: 'unsupported' };
  // Camera paths are server-generated single segments. Keep this test on the same WHEP endpoint as live view.
  if (typeof mediamtxPath !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(mediamtxPath)) return { outcome: 'failed' };

  const requestUrl = `/live/${mediamtxPath}/whep`;
  let pc;
  let resourceUrl;
  let finished = false;
  let timer;
  const postController = new AbortController();
  let resolveResult;
  const result = new Promise((resolve) => { resolveResult = resolve; });

  function deleteSession(url) {
    if (!url) return;
    fetch(url, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${getToken()}` },
      // A redirect could replay this authenticated DELETE at an address we did not check (#562).
      redirect: 'error',
    }).catch(() => {});
  }

  function finish(value) {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    // Stop an in-flight POST on timeout or navigation; a response that wins this race is handled below.
    postController.abort();
    // Close the viewer and ask MediaMTX to end any session whose address we received.
    pc?.close();
    deleteSession(resourceUrl);
    resourceUrl = null;
    resolveResult(value);
  }
  function onAbort() { finish({ outcome: 'failed' }); }
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  else timer = setTimeout(() => finish({ outcome: 'timeout' }), DEADLINE_MS);

  async function negotiate() {
    try {
      const iceServers = await getIceServersWithin(1000);
      if (finished) return;
      pc = new RTCPeerConnection({ iceServers });
      pc.addTransceiver('video', { direction: 'recvonly' });
      pc.onconnectionstatechange = async () => {
        if (finished) return;
        if (pc.connectionState === 'connected') {
          try {
            const stats = await pc.getStats();
            if (!finished) finish({ outcome: 'connected', ...selectedRemoteCandidate(stats) });
          } catch { finish({ outcome: 'failed' }); }
        } else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
          finish({ outcome: 'failed' });
        }
      };
      const offer = await pc.createOffer();
      if (finished) return;
      await pc.setLocalDescription(offer);
      if (finished) return;
      const response = await fetch(requestUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/sdp', Authorization: `Bearer ${getToken()}` },
        body: offer.sdp,
        signal: postController.signal,
      });
      if (!response.ok) throw new Error('WHEP refused');
      const url = resolveWhepResource(response.headers.get('Location'), requestUrl, window.location.origin);
      if (finished) { deleteSession(url); return; }
      resourceUrl = url;
      const sdp = await response.text();
      if (finished) return;
      await pc.setRemoteDescription({ type: 'answer', sdp });
    } catch { finish({ outcome: 'failed' }); }
  }
  if (!finished) void negotiate();
  return result;
}
