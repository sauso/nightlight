import { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import { getToken } from '../lib/api.js';
import { isIOS } from '../lib/nativeBridge.js';
import { useNowPlayingSession } from '../lib/useNowPlaying.js';

// The token travels as a query param (not an Authorization header) because Safari's
// native HLS playback fetches segments itself with no way for us to attach headers.
function hlsUrl(mediamtxPath) {
  return `/hls/${mediamtxPath}/index.m3u8?token=${encodeURIComponent(getToken())}`;
}

// Matches .camera-tile__video-wrap's background. A blank <video> with no poster is what
// makes some WebViews draw their own default "start playback" icon over it - supplying
// any poster, even a flat color, is the one fix that's reliably honored everywhere.
const BLANK_POSTER =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1' height='1'%3E%3Crect width='1' height='1' fill='%230a0d1c'/%3E%3C/svg%3E";

export default function HlsPlayer({ mediamtxPath, active, muted = false, isBackgroundAudio = false, cameraName }) {
  const videoRef = useRef(null);
  const audioRef = useRef(null);
  const hlsRef = useRef(null);
  const stateRef = useRef('idle');
  const [state, setStateRaw] = useState('idle'); // idle | connecting | live | error
  const [reconnectKey, setReconnectKey] = useState(0);

  function setState(next) {
    stateRef.current = next;
    setStateRaw(next);
  }

  // iOS background audio for Compatibility mode. iOS suspends the <video> element HLS plays
  // through the moment the app backgrounds, so its audio stops - which is why HLS couldn't do
  // background audio there. Route the sound through a dedicated <audio> element fed the audio-only
  // sidecar stream (see the effect below) while this is the Background-listening camera on iOS:
  // iOS keeps <audio> alive backgrounded (that's how WebRTC/Low latency works too). iOS-only:
  // elsewhere (Android) the <video> element keeps working in the background via the foreground
  // service.
  const useIosBgAudio = isBackgroundAudio && isIOS();

  // Own the Now Playing / lock-screen session while carrying iOS background audio, so
  // Compatibility mode shows the same camera name, artwork, and Pause/Play as Low latency does
  // (Android's own foreground-service notification covers that case there). The <audio> element
  // below is the sound source, so Pause/Play act on it - see the shared hook.
  useNowPlayingSession({
    enabled: active && useIosBgAudio,
    cameraName,
    mediaElRef: audioRef,
  });

  useEffect(() => {
    const video = videoRef.current;
    if (video) {
      // When the dedicated audio element carries the sound (iOS background), keep the video muted
      // so the stream's audio doesn't play twice.
      video.muted = useIosBgAudio ? true : muted;
      if (!video.muted) video.play().catch(() => {});
    }
    const audio = audioRef.current;
    if (audio && useIosBgAudio) {
      audio.muted = muted;
      if (!muted) audio.play().catch(() => {});
    }
  }, [muted, useIosBgAudio]);

  // Feed the dedicated <audio> element the AUDIO-ONLY HLS stream (the `<path>-audio` sidecar the
  // transcoder publishes) while it's carrying background audio; tear it down otherwise so it isn't
  // fetching in the normal foreground case. Audio-only (no video track) is what lets iOS keep it
  // playing in the background, and its regular segments avoid the video-keyframe stutter.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return undefined;
    if (!(active && useIosBgAudio)) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      return undefined;
    }
    audio.src = hlsUrl(`${mediamtxPath}-audio`);
    audio.muted = muted;
    audio.play().catch(() => {});
    return () => {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    };
    // muted is handled by the effect above - excluded here so a mute toggle doesn't reload src.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, useIosBgAudio, mediamtxPath, reconnectKey]);

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
      {/* Carries the sound on iOS while this is the Background-listening camera (see useIosBgAudio) -
          an <audio> element survives iOS backgrounding where the <video> above doesn't. */}
      <audio ref={audioRef} autoPlay />
      {state !== 'live' && (
        <div className={`whep-overlay whep-overlay--${state}`}>
          {state === 'connecting' && <span>Connecting…</span>}
          {state === 'error' && <span>No signal</span>}
        </div>
      )}
    </div>
  );
}
