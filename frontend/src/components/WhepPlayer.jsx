import { useEffect, useRef, useState } from 'react';
import { getToken } from '../lib/api.js';

// The backend proxies WHEP straight through to MediaMTX under /live (see backend/src/index.js),
// so this always uses the same origin/protocol the page was loaded with — no separate port,
// and no mixed-content issues when this is served over HTTPS behind a reverse proxy.
function whepUrl(mediamtxPath) {
  return `/live/${mediamtxPath}/whep`;
}

export default function WhepPlayer({
  mediamtxPath,
  active,
  muted = false,
  onFirstConnectFailed,
  cameraName,
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

  function handleEnableSound() {
    if (!audioRef.current) return;
    audioRef.current
      .play()
      .then(() => setNeedsGesture(false))
      .catch(() => {});
  }

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
        pc.onconnectionstatechange = () => {
          if (cancelled) return;
          if (pc.connectionState === 'connected') {
            setState('live');
            everConnectedRef.current = true;
            clearTimeout(firstConnectTimeoutId);
            if ('mediaSession' in navigator) {
              navigator.mediaSession.metadata = new MediaMetadata({
                title: cameraName || 'Camera',
                artist: 'Nightlight',
              });
              navigator.mediaSession.playbackState = 'playing';
              // Registering real action handlers (even simple ones) is what actually
              // signals to Chrome that this is deliberate, controllable background
              // media - metadata alone is informational and isn't enough on its own
              // to reliably keep audio playing once the tab is backgrounded.
              navigator.mediaSession.setActionHandler('play', () => {
                audioRef.current?.play().catch(() => {});
                navigator.mediaSession.playbackState = 'playing';
              });
              navigator.mediaSession.setActionHandler('pause', () => {
                // This is a live monitor feed, not a track - there's nothing meaningful
                // to pause to, so just acknowledge the control rather than leave it
                // unhandled.
                navigator.mediaSession.playbackState = 'playing';
              });
            }
          }
          if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
            setState('error');
            setErrorMsg('Connection lost');
            // Only treat this as "WebRTC doesn't work here" (triggering an automatic
            // mode switch upstream) the first time - a later disconnect on a
            // previously-working stream is more likely a transient blip, and will
            // simply retry as WebRTC rather than abandoning it.
            if (!everConnectedRef.current) onFirstConnectFailed?.();
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
      if ('mediaSession' in navigator) {
        navigator.mediaSession.setActionHandler('play', null);
        navigator.mediaSession.setActionHandler('pause', null);
      }
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
      <video ref={videoRef} autoPlay playsInline muted className="whep-video" />
      <audio ref={audioRef} autoPlay />
      {state !== 'live' && (
        <div className={`whep-overlay whep-overlay--${state}`}>
          {state === 'connecting' && <span>Connecting…</span>}
          {state === 'error' && <span>{errorMsg || 'No signal'}</span>}
          {state === 'idle' && <span>Tap to view</span>}
        </div>
      )}
      {state === 'live' && !muted && needsGesture && (
        <button className="whep-gesture-btn" onClick={handleEnableSound}>
          🔈 Tap for sound
        </button>
      )}
    </div>
  );
}
