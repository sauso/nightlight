import { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import { getToken } from '../lib/api.js';

// The token travels as a query param (not an Authorization header) because Safari's
// native HLS playback fetches segments itself with no way for us to attach headers.
function hlsUrl(mediamtxPath) {
  return `/hls/${mediamtxPath}/index.m3u8?token=${encodeURIComponent(getToken())}`;
}

export default function HlsPlayer({ mediamtxPath, active, muted = false }) {
  const videoRef = useRef(null);
  const hlsRef = useRef(null);
  const stateRef = useRef('idle');
  const [state, setStateRaw] = useState('idle'); // idle | connecting | live | error
  const [reconnectKey, setReconnectKey] = useState(0);

  function setState(next) {
    stateRef.current = next;
    setStateRaw(next);
  }

  useEffect(() => {
    if (videoRef.current) videoRef.current.muted = muted;
  }, [muted]);

  // Mobile browsers can suspend media/network when backgrounded for a while - but
  // often audio keeps playing fine on its own. Only reconnect if it's actually not
  // live when we come back, rather than unconditionally interrupting a stream that
  // was working (which would also defeat any background audio playback).
  useEffect(() => {
    function handleVisibility() {
      if (document.visibilityState === 'visible' && stateRef.current !== 'live') {
        setReconnectKey((k) => k + 1);
      }
    }
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, []);

  // Automatically retry while sitting in an error state - the visibility-based
  // reconnect above only helps if the tab was backgrounded and came back. If the
  // camera drops and recovers while you're actively watching (tab stays foregrounded
  // the whole time), nothing would otherwise ever retry, leaving it stuck until a
  // manual reload even after the camera is available again.
  useEffect(() => {
    if (state !== 'error') return;
    const timer = setTimeout(() => setReconnectKey((k) => k + 1), 5000);
    return () => clearTimeout(timer);
  }, [state]);

  // hls.js only reports an error (which triggers the retry above) when it classifies
  // something as fatal - a stream that just quietly stalls (segments stop updating,
  // but hls.js doesn't consider that fatal on its own) can leave the video frozen on
  // its last frame indefinitely with no error ever surfacing. This checks actual
  // playback progress directly, independent of hls.js's own classification, and
  // forces a reconnect if the video hasn't actually advanced in a while despite
  // supposedly being "live".
  useEffect(() => {
    if (state !== 'live') return;
    let lastTime = videoRef.current?.currentTime ?? 0;
    const interval = setInterval(() => {
      const video = videoRef.current;
      if (!video) return;
      if (video.currentTime === lastTime) {
        setReconnectKey((k) => k + 1);
      }
      lastTime = video.currentTime;
    }, 8000);
    return () => clearInterval(interval);
  }, [state]);

  useEffect(() => {
    if (!active || !videoRef.current) return;
    const video = videoRef.current;
    setState('connecting');

    const canPlayNatively = video.canPlayType('application/vnd.apple.mpegurl');

    if (canPlayNatively) {
      // Safari: let the browser's own (hardware-accelerated) HLS support handle it,
      // but nudge it to the live edge on load - Safari's own default start position
      // is conservatively further back than necessary.
      video.src = hlsUrl(mediamtxPath);
      video.addEventListener('loadedmetadata', () => {
        if (video.seekable.length > 0) {
          video.currentTime = video.seekable.end(video.seekable.length - 1);
        }
        setState('live');
      });
      video.addEventListener('error', () => setState('error'));
    } else if (Hls.isSupported()) {
      const hls = new Hls({
        backBufferLength: 10,
        // Target staying close to the live edge instead of hls.js's more conservative
        // default (which alone accounted for several extra seconds of the ~15s delay).
        liveSyncDurationCount: 1,
        liveMaxLatencyDurationCount: 3,
        // If playback ever falls behind, speed up slightly (imperceptible) to catch
        // back up to the live edge rather than staying permanently delayed.
        liveDurationInfinity: false,
        maxLiveSyncPlaybackRate: 1.3,
      });
      hlsRef.current = hls;
      hls.loadSource(hlsUrl(mediamtxPath));
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => setState('live'));
      hls.on(Hls.Events.ERROR, (event, data) => {
        if (data.fatal) setState('error');
      });
    } else {
      setState('error');
    }

    return () => {
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
      video.removeAttribute('src');
      video.load();
    };
  }, [mediamtxPath, active, reconnectKey]);

  return (
    <div className="whep-player">
      {/* Hidden until live: Android WebView renders <video> via a hardware overlay that
          draws on top of the DOM regardless of stacking order, so an empty video element
          would otherwise show through the "Connecting…" overlay below as a native
          placeholder icon. */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        className="whep-video"
        style={{ opacity: state === 'live' ? 1 : 0 }}
      />
      {state !== 'live' && (
        <div className={`whep-overlay whep-overlay--${state}`}>
          {state === 'connecting' && <span>Connecting…</span>}
          {state === 'error' && <span>No signal</span>}
        </div>
      )}
    </div>
  );
}
