import { useEffect, useRef, useState } from 'react';
import StreamUnavailableNotice from './StreamUnavailableNotice.jsx';
import { getMediaToken } from '../lib/api.js';

// The token travels as a query param (not an Authorization header) because Safari's
// native HLS playback fetches segments itself with no way for us to attach headers. It's the
// short-lived MEDIA token, not the session token (MediaMTX copies this query onto every segment URL
// it emits, so the token is embedded in each segment request too).
function hlsUrl(mediamtxPath) {
  return `/hls/${mediamtxPath}/index.m3u8?token=${encodeURIComponent(getMediaToken() || '')}`;
}

// Matches .camera-tile__video-wrap's background. A blank <video> with no poster is what
// makes some WebViews draw their own default "start playback" icon over it - supplying
// any poster, even a flat color, is the one fix that's reliably honored everywhere.
const BLANK_POSTER =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1' height='1'%3E%3Crect width='1' height='1' fill='%230a0d1c'/%3E%3C/svg%3E";

export default function HlsPlayer({ mediamtxPath, active, muted = false, statusUnknown = false }) {
  const videoRef = useRef(null);
  const hlsRef = useRef(null);
  const stateRef = useRef('idle');
  const [state, setStateRaw] = useState('idle'); // idle | connecting | live | error | load-failed
  const [reconnectKey, setReconnectKey] = useState(0);

  function setState(next) {
    stateRef.current = next;
    setStateRaw(next);
  }

  // Keep the <video> element's muted flag in sync with the mute toggle, and retry playback (e.g.
  // after the user unmutes) since some browsers pause on unmute otherwise.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = muted;
    if (!muted) video.play().catch(() => {});
  }, [muted]);

  // Mobile browsers can suspend media/network when backgrounded for a while - but
  // often audio keeps playing fine on its own. Only reconnect if it's actually not
  // live when we come back, rather than unconditionally interrupting a stream that
  // was working (which would also defeat any background audio playback).
  useEffect(() => {
    function handleVisibility() {
      // 'load-failed' is excluded: re-importing the same failed module URL replays the cached failure (see the
      // import below), so a reconnect would only flicker "Connecting…" before failing again.
      if (document.visibilityState === 'visible' && stateRef.current !== 'live' && stateRef.current !== 'load-failed') {
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

    // The native path's two listeners, kept by name so the cleanup below can take them off (#560). The
    // <video> element is the SAME node across every run of this effect (it is only the effect that re-runs:
    // each 5 s retry while in error, each stall reconnect), so anonymous listeners piled up one more pair
    // per reconnect, and every one of them re-ran its seek/setState on each later event. null on the
    // hls.js path, which has no DOM listeners of its own to remove (hls.destroy() detaches its own).
    let onLoadedMetadata = null;
    let onVideoError = null;
    let cancelled = false;

    if (canPlayNatively) {
      // Safari: let the browser's own (hardware-accelerated) HLS support handle it,
      // but nudge it to the live edge on load - Safari's own default start position
      // is conservatively further back than necessary.
      video.src = hlsUrl(mediamtxPath);
      onLoadedMetadata = () => {
        if (video.seekable.length > 0) {
          video.currentTime = video.seekable.end(video.seekable.length - 1);
        }
        setState('live');
      };
      onVideoError = () => setState('error');
      video.addEventListener('loadedmetadata', onLoadedMetadata);
      video.addEventListener('error', onVideoError);
    } else {
      // #386: hls.js is ~560 kB of the ~1.1 MB entry chunk and this branch is the only code that needs
      // it, so it is fetched on demand. It is NOT needed by the WebRTC path (the default) or by the
      // native-HLS branch above (Safari/iOS), so most sessions never download it.
      // `cancelled` covers the window between asking for the module and getting it: the effect re-runs
      // (a mode switch, a retry) or unmounts in that gap, and a player created after teardown would
      // attach to a video that is being replaced and never be destroyed.
      import('hls.js').then(({ default: Hls }) => {
        if (cancelled) return;
        if (!Hls.isSupported()) {
          setState('error');
          return;
        }
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
      }, () => {
        // The chunk could not be fetched (offline). NOT the 'error' state: that one auto-retries every 5 s by
        // importing the same URL again, and a dynamic import of a URL that failed once is remembered by the
        // browser's module map for the life of the document, so every retry would replay the first failure
        // forever (verified in headless Chrome for the route chunks, #386). Only a new document clears it,
        // so this state stops the retry loop and offers a reload instead.
        if (!cancelled) setState('load-failed');
      }).catch(() => {
        // The module loaded but building the player threw: an ordinary failure to connect, retried as before.
        if (!cancelled) setState('error');
      });
    }

    return () => {
      cancelled = true;
      // Listeners off BEFORE the src is removed and load() called: tearing the source down is itself
      // something browsers may answer with an `error` event, and it must not reach this run's handler
      // and flip a player that is being replaced into the error state.
      if (onLoadedMetadata) video.removeEventListener('loadedmetadata', onLoadedMetadata);
      if (onVideoError) video.removeEventListener('error', onVideoError);
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
      {/* poster + opacity:0 until live - the Android app's WebView draws its own default
          "start playback" icon over a blank/sourceless <video>, showing through the
          "Connecting…" overlay below. Belt-and-suspenders against whichever mechanism
          is actually responsible on that WebView. */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        poster={BLANK_POSTER}
        className="whep-video"
        style={{ opacity: state === 'live' ? 1 : 0 }}
      />
      {state !== 'live' && (
        <div className={`whep-overlay whep-overlay--${state}${statusUnknown ? ' whep-overlay--unknown' : ''}`}>
          {/* Same rule as WhepPlayer (#505): unknown status is not "No signal". */}
          {state === 'load-failed' ? (
            // Takes priority over the unknown-status notice: this one has a fix the viewer can act on.
            <div className="stream-unavailable" role="alert">
              <span>Couldn’t load the video player. Check your connection, then reload the page.</span>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => window.location.reload()}>
                Reload
              </button>
            </div>
          ) : statusUnknown ? (
            <StreamUnavailableNotice onRetry={() => setReconnectKey((k) => k + 1)} />
          ) : (
            <>
              {state === 'connecting' && <span>Connecting…</span>}
              {state === 'error' && <span>No signal</span>}
            </>
          )}
        </div>
      )}
    </div>
  );
}
