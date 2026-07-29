import { useEffect, useRef, useState } from 'react';
import { getToken } from '../lib/api.js';
import { subscribeBackgroundCameras, backgroundCameraCount } from '../lib/nativeBridge.js';

// The backend proxies WHEP straight through to MediaMTX under /live (see backend/src/index.js),
// so this always uses the same origin/protocol the page was loaded with — no separate port,
// and no mixed-content issues when this is served over HTTPS behind a reverse proxy.
function whepUrl(mediamtxPath) {
  return `/live/${mediamtxPath}/whep`;
}

// Matches .camera-tile__video-wrap's background. A blank <video> with no poster is what
// makes some WebViews draw their own default "start playback" icon over it - supplying
// any poster, even a flat color, is the one fix that's reliably honored everywhere.
const BLANK_POSTER =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1' height='1'%3E%3Crect width='1' height='1' fill='%230a0d1c'/%3E%3C/svg%3E";

// App icon shown as the lock-screen / Now Playing artwork (same-origin URLs the OS fetches).
// Without any artwork, iOS shows a blank tile; without metadata at all it falls back to just
// the app name.
// Dedicated Now Playing tile (icons/now-playing-512.png): the full app icon at its normal size,
// centred on a transparent canvas with a margin around it - so it reads as the app icon rather
// than a zoomed-in crop of the illustration on the lock screen.
export const NOW_PLAYING_ARTWORK = [
  { src: '/icons/now-playing-512.png', sizes: '512x512', type: 'image/png' },
];

export default function WhepPlayer({
  mediamtxPath,
  active,
  muted = false,
  onFirstConnectFailed,
  cameraName,
  isBackgroundAudio = false,
}) {
  const videoRef = useRef(null);
  // Audio lives on its own <audio> element, separate from <video> - Chrome treats
  // background video very restrictively (it can throttle/pause it freely), but treats
  // background audio much more like a music player: given real leeway to keep playing
  // regardless of screen state. Splitting them means losing the video in the
  // background costs nothing (we don't need to see it) while sound keeps flowing
  // independently, the same way Spotify's web player does.
  const audioRef = useRef(null);
  const pcRef = useRef(null);
  const resourceUrlRef = useRef(null);
  const everConnectedRef = useRef(false);
  const [state, setState] = useState('idle'); // idle | connecting | live | error
  const [errorMsg, setErrorMsg] = useState('');
  const [needsGesture, setNeedsGesture] = useState(false);
  const [reconnectKey, setReconnectKey] = useState(0);

  // Keep the <audio> element's muted flag in sync with the mute toggle, and retry
  // playback (e.g. after the user unmutes) since some browsers pause on unmute otherwise.
  useEffect(() => {
    if (!audioRef.current) return;
    audioRef.current.muted = muted;
    audioRef.current
      .play()
      .then(() => setNeedsGesture(false))
      .catch(() => setNeedsGesture(true));
  }, [muted]);

  // When the browser blocks unmuted autoplay (no user gesture yet on this page load),
  // don't show a "Tap for sound" prompt - just silently retry playback on the first
  // interaction anywhere on the page. So an unmuted stream starts the moment the person
  // clicks/taps anything, with no extra affordance to dismiss. (A brand-new visitor
  // defaults to muted - see CameraTile - so they never hit this; it only matters for a
  // returning visitor whose saved state was unmuted.)
  useEffect(() => {
    if (!needsGesture || muted) return undefined;
    const resume = () => {
      audioRef.current
        ?.play()
        .then(() => setNeedsGesture(false))
        .catch(() => {});
    };
    document.addEventListener('pointerdown', resume);
    return () => document.removeEventListener('pointerdown', resume);
  }, [needsGesture, muted]);

  // Mobile browsers can drop WebRTC connections when backgrounded for a while - but
  // often they don't, especially for audio, which is why Android shows a media
  // notification and keeps playing sound while backgrounded. Only reconnect if the
  // connection is actually dead when we come back; forcing a reconnect unconditionally
  // would interrupt a stream that was working fine and defeat that background audio.
  useEffect(() => {
    function handleVisibility() {
      if (document.visibilityState !== 'visible') return;
      const cs = pcRef.current?.connectionState;
      if (cs && cs !== 'connected' && cs !== 'connecting' && cs !== 'new') {
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

  // Own the system media session (Now Playing / lock screen) ONLY while this camera is the
  // active Background-audio one and actually streaming - so the lock-screen controls show the
  // correct camera (previously every camera set the single global session on connect, so the
  // last one to connect/reconnect won, showing the wrong camera). Registering real action
  // handlers is also what signals the OS this is deliberate, controllable background media.
  // Play/pause route through the app-wide background pause (mute/unmute), matching the
  // Android notification's Pause button. Cleaned up when this camera stops being the bg one.
  useEffect(() => {
    if (!('mediaSession' in navigator) || !isBackgroundAudio || state !== 'live') return undefined;
    // Title shows this camera's name when it's the only one being listened to, or "Multiple
    // Cameras" when several are. Re-applied whenever the background-camera set changes, since a
    // second camera joining (or leaving) should flip the title live.
    function applyMetadata() {
      try {
        const title = backgroundCameraCount() >= 2 ? 'Multiple Cameras' : cameraName || 'Camera';
        navigator.mediaSession.metadata = new MediaMetadata({ title, artist: 'Nightlight', artwork: NOW_PLAYING_ARTWORK });
      } catch {
        // ignore
      }
    }
    try {
      applyMetadata();
      navigator.mediaSession.playbackState = 'playing';
      // Real pause/play of the <audio> element (not a mute): iOS tracks the element's actual
      // playback state for Now Playing, so a mute-with-playbackState='paused' mismatch made it
      // drop our session (→ "My music") and refuse to resume. Pausing the element for real keeps
      // our session shown as paused and lets Play resume it. The audio is on its own element, so
      // there's no video to blank. The WebRTC stream keeps flowing, so play() resumes at the live
      // edge. (In-app, the speaker button still recovers via cycleAudio's background-pause clear.)
      navigator.mediaSession.setActionHandler('pause', () => {
        audioRef.current?.pause();
        try { navigator.mediaSession.playbackState = 'paused'; } catch { /* ignore */ }
      });
      navigator.mediaSession.setActionHandler('play', () => {
        audioRef.current?.play().catch(() => {});
        try { navigator.mediaSession.playbackState = 'playing'; } catch { /* ignore */ }
      });
    } catch {
      // Not every engine supports the full Media Session API - non-fatal.
    }
    const unsubscribe = subscribeBackgroundCameras(applyMetadata);
    return () => {
      unsubscribe();
      try {
        navigator.mediaSession.setActionHandler('play', null);
        navigator.mediaSession.setActionHandler('pause', null);
      } catch {
        // ignore
      }
    };
  }, [isBackgroundAudio, state, cameraName]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let firstConnectTimeoutId = null;

    async function connect() {
      setState('connecting');
      setErrorMsg('');
      try {
        const pc = new RTCPeerConnection({
          // STUN helps both sides discover a reachable address when connecting over the
          // internet. Harmless and effectively unused for same-LAN viewing.
          iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
        });
        pcRef.current = pc;
        pc.addTransceiver('video', { direction: 'recvonly' });
        pc.addTransceiver('audio', { direction: 'recvonly' });

        // Browsers' own native ICE-failure detection is very conservative (often 15s+)
        // before declaring a connection failed. Rather than wait on that, treat a first
        // connection attempt that hasn't succeeded within 2s as failed ourselves - real
        // same-LAN connections settle in well under a second, so this is still generous.
        if (!everConnectedRef.current) {
          firstConnectTimeoutId = setTimeout(() => {
            if (!cancelled && pc.connectionState !== 'connected') {
              setState('error');
              setErrorMsg('Connection timed out');
              onFirstConnectFailed?.();
            }
          }, 2000);
        }

        // Each track arrives as its own ontrack event (one for video, one for audio),
        // since they were requested as separate transceivers above - route each to its
        // own dedicated element rather than one combined stream on a single <video>.
        pc.ontrack = (event) => {
          if (event.track.kind === 'video' && videoRef.current) {
            videoRef.current.srcObject = new MediaStream([event.track]);
            videoRef.current.muted = true; // video element never carries sound now
            videoRef.current.play().catch(() => {});
          }
          if (event.track.kind === 'audio' && audioRef.current) {
            audioRef.current.srcObject = new MediaStream([event.track]);
            audioRef.current.muted = muted;
            // Browsers may block unmuted autoplay until the user has interacted with
            // the page — if so, fall back to a "tap for sound" prompt rather than
            // failing silently.
            audioRef.current
              .play()
              .then(() => setNeedsGesture(false))
              .catch(() => setNeedsGesture(true));
          }
        };
        // 'disconnected' is a deliberately transient WebRTC state (brief ICE
        // connectivity check failures - a WiFi hiccup, a NAT rebind, etc.) that often
        // self-recovers within a second or two on its own; it's distinct from 'failed',
        // which means ICE has actually given up. Treating them the same (tearing down
        // and rebuilding the whole connection immediately) was very likely the cause of
        // frequent drop-and-reconnect cycling - give 'disconnected' a grace period to
        // recover on its own before treating it as a real failure.
        let disconnectedGraceTimeoutId = null;
        pc.onconnectionstatechange = () => {
          if (cancelled) return;
          if (pc.connectionState === 'connected') {
            clearTimeout(disconnectedGraceTimeoutId);
            disconnectedGraceTimeoutId = null;
            setState('live');
            everConnectedRef.current = true;
            clearTimeout(firstConnectTimeoutId);
            // The system media session (Now Playing / lock screen) is owned only by the
            // Background-mode camera - see the dedicated effect below. Setting it here, for
            // every camera on connect, is what made Now Playing show the wrong camera.
          }
          if (['failed', 'closed'].includes(pc.connectionState)) {
            clearTimeout(disconnectedGraceTimeoutId);
            disconnectedGraceTimeoutId = null;
            setState('error');
            setErrorMsg('Connection lost');
            if (!everConnectedRef.current) onFirstConnectFailed?.();
          }
          if (pc.connectionState === 'disconnected' && !disconnectedGraceTimeoutId) {
            disconnectedGraceTimeoutId = setTimeout(() => {
              if (cancelled) return;
              disconnectedGraceTimeoutId = null;
              // Still disconnected 4s later - this one isn't self-recovering, treat it
              // as a real failure now. Only treat this as "WebRTC doesn't work here"
              // (triggering an automatic mode switch upstream) the first time - a later
              // disconnect on a previously-working stream is more likely a transient
              // blip, and will simply retry as WebRTC rather than abandoning it.
              if (pc.connectionState === 'disconnected') {
                setState('error');
                setErrorMsg('Connection lost');
                if (!everConnectedRef.current) onFirstConnectFailed?.();
              }
            }, 4000);
          }
        };

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        const res = await fetch(whepUrl(mediamtxPath), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/sdp',
            Authorization: `Bearer ${getToken()}`,
          },
          body: offer.sdp,
        });
        if (!res.ok) throw new Error(`Camera stream unavailable (${res.status})`);
        resourceUrlRef.current = res.headers.get('Location');
        const answerSdp = await res.text();
        if (cancelled) return;
        await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
      } catch (err) {
        if (!cancelled) {
          setState('error');
          setErrorMsg(err.message || 'Could not connect to camera');
          if (!everConnectedRef.current) onFirstConnectFailed?.();
        }
      }
    }

    connect();

    return () => {
      cancelled = true;
      clearTimeout(firstConnectTimeoutId);
      if (pcRef.current) {
        pcRef.current.close();
        pcRef.current = null;
      }
      if (resourceUrlRef.current) {
        fetch(resourceUrlRef.current, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${getToken()}` },
        }).catch(() => {});
        resourceUrlRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        muted
        poster={BLANK_POSTER}
        className="whep-video"
        style={{ opacity: state === 'live' ? 1 : 0 }}
      />
      <audio ref={audioRef} autoPlay />
      {state !== 'live' && (
        <div className={`whep-overlay whep-overlay--${state}`}>
          {state === 'connecting' && <span>Connecting…</span>}
          {state === 'error' && <span>{errorMsg || 'No signal'}</span>}
          {state === 'idle' && <span>Tap to view</span>}
        </div>
      )}
    </div>
  );
}
