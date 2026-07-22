import { useEffect, useRef, useState } from 'react';
import { Maximize2, Minimize2, Settings, PictureInPicture2, Volume2, VolumeX, Radio, GripVertical } from 'lucide-react';
import { useSettings } from '../lib/SettingsContext.jsx';
import { isNativeApp, isSoftReload, setBackgroundListening, onBackgroundStopped } from '../lib/nativeBridge.js';
import WhepPlayer from './WhepPlayer.jsx';
import HlsPlayer from './HlsPlayer.jsx';
import BreathingDot from './BreathingDot.jsx';

function formatReading(mqtt, tempUnit) {
  if (!mqtt) return null;
  const parts = [];
  if (typeof mqtt.temperature === 'number') {
    const value = tempUnit === 'F' ? (mqtt.temperature * 9) / 5 + 32 : mqtt.temperature;
    parts.push(`${value.toFixed(1)}°${tempUnit}`);
  }
  if (typeof mqtt.humidity === 'number') {
    parts.push(`${Math.round(mqtt.humidity)}%`);
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

export default function CameraTile({ camera, childName, dragHandleProps }) {
  const { settings } = useSettings();
  // Per-device, not synced through the backend - deliberately so a phone sitting next
  // to you can stay muted while a tablet mounted in the nursery stays unmuted, rather
  // than muting on one device silently muting it everywhere.
  const muteKey = `nightlight_muted_${camera.id}`;

  // Audio is a three-way state in the native Android app, two-way on the web:
  //   'on'  - audio plays while the app is open (the old unmuted state)
  //   'off' - muted (the old muted state)
  //   'bg'  - audio plays AND a native foreground service keeps it alive with the
  //           screen off / app minimised (native app only)
  // Tapping the speaker cycles Off -> On -> Background -> Off in the app, and just
  // On <-> Off in a browser where background mode doesn't exist.
  const [audioState, setAudioState] = useState(() => {
    try {
      const stored = localStorage.getItem(muteKey);
      if (stored === 'true') return 'off'; // legacy boolean values from the old
      if (stored === 'false') return 'on'; // two-state mute
      if (stored === 'on' || stored === 'off') return stored;
      // A stored 'bg' restores as 'bg' across our own background-triggered
      // reload (isSoftReload) - the foreground service kept running the whole
      // time, so JS state should catch back up to match it. Only on a genuine
      // fresh app launch does it collapse to 'on': starting a foreground
      // service silently on launch would be surprising - background mode is
      // something you switch on for tonight, not a persistent default.
      if (stored === 'bg') return isSoftReload ? 'bg' : 'on';
      return 'on';
    } catch {
      return 'on';
    }
  });
  const muted = audioState === 'off';

  // 'on' mode should only actually produce audio while the app is genuinely
  // open and in front - not when it's minimized or the screen is off. Without
  // this, closing the app while in plain 'on' mode would leave audio playing
  // for however long Android takes to suspend a backgrounded WebView, which is
  // both surprising and wasteful. 'bg' mode is deliberately exempt: staying
  // alive while backgrounded is the entire point of it, backed by the native
  // foreground service. The Page Visibility API works here without any native
  // code - Capacitor's WebView fires it correctly when the app is minimized.
  const [pageVisible, setPageVisible] = useState(() => !document.hidden);
  useEffect(() => {
    function handleVisibilityChange() {
      setPageVisible(!document.hidden);
    }
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, []);
  const effectiveMuted = muted || (audioState === 'on' && !pageVisible);

  const [mode, setMode] = useState('live'); // 'live' (WebRTC) | 'compat' (HLS)
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const manualModeRef = useRef(false);
  const videoWrapRef = useRef(null);

  // Double-tap to zoom in centered on the tap point; while zoomed, a single tap
  // re-centers the view on the new point (a way to "walk" the zoom around the frame
  // without zooming out first), and a double-tap resets back to normal size. Refs
  // (not just state) track the current values so the tap-timing logic always reads
  // what's actually true right now, not a stale value captured when the timer/handler
  // was first created.
  const [zoomed, setZoomedState] = useState(false);
  const [zoomOrigin, setZoomOrigin] = useState({ x: 50, y: 50 });
  const zoomedRef = useRef(false);
  const lastTapRef = useRef(0);
  const singleTapTimeoutRef = useRef(null);
  const DOUBLE_TAP_WINDOW_MS = 300;

  function setZoomed(value) {
    zoomedRef.current = value;
    setZoomedState(value);
  }

  // Track fullscreen state for this specific tile, and release the landscape lock on
  // exit so the rest of the app goes back to normal portrait behavior rather than
  // staying stuck sideways.
  useEffect(() => {
    function handleFullscreenChange() {
      setIsFullscreen(document.fullscreenElement === videoWrapRef.current);
      if (!document.fullscreenElement) {
        screen.orientation?.unlock?.();
      }
    }
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  // Keep the native foreground service in sync with this tile's state. The bridge
  // reference-counts across tiles, so several cameras can share one service and the
  // notification retitles itself as cameras join and leave.
  useEffect(() => {
    if (!isNativeApp()) return undefined;
    setBackgroundListening(camera.id, camera.name, audioState === 'bg');
    return undefined;
  }, [audioState, camera.id, camera.name]);

  // If the person taps "Stop" on the Android notification, every tile in background
  // mode drops back to plain On. Also make sure an unmounting tile releases its
  // claim on the service rather than leaving it running forever.
  useEffect(() => {
    if (!isNativeApp()) return undefined;
    const unsubscribe = onBackgroundStopped(() => {
      setAudioState((s) => (s === 'bg' ? 'on' : s));
    });
    return () => {
      unsubscribe();
      setBackgroundListening(camera.id, camera.name, false);
    };
  }, [camera.id, camera.name]);

  function handleFirstConnectFailed() {
    // Only auto-switch if the person hasn't already made their own choice - e.g. if
    // they deliberately picked Low Latency mode again after an earlier auto-switch,
    // don't immediately override that choice too.
    if (!manualModeRef.current) setMode('compat');
  }

  function selectMode(newMode) {
    manualModeRef.current = true;
    setMode(newMode);
    setModeMenuOpen(false);
  }

  async function toggleFullscreen() {
    const wrap = videoWrapRef.current;
    if (!wrap) return;

    // Already fullscreen - this tap means "shrink back down."
    if (document.fullscreenElement) {
      document.exitFullscreen?.().catch(() => {});
      return;
    }

    // Can't be in PiP and fullscreen at once - cleanly exit PiP first rather than
    // letting the browser handle both transitions at the same time, which is what
    // was causing a blank/white result.
    if (document.pictureInPictureElement) {
      await document.exitPictureInPicture().catch(() => {});
    }

    // iOS Safari: no standard Fullscreen API for arbitrary elements, but video
    // elements have their own native fullscreen mode which rotates to landscape
    // automatically for video content - no separate orientation lock needed or possible.
    const videoEl = wrap.querySelector('video');
    if (videoEl?.webkitEnterFullscreen) {
      videoEl.webkitEnterFullscreen();
      return;
    }

    if (wrap.requestFullscreen) {
      wrap.requestFullscreen()
        .then(() => screen.orientation?.lock?.('landscape').catch(() => {}))
        .catch(() => {});
    }
  }

  async function enterPip() {
    const wrap = videoWrapRef.current;
    const videoEl = wrap?.querySelector('video');
    if (!videoEl || !document.pictureInPictureEnabled || videoEl.disablePictureInPicture) return;

    // Can't be fullscreen and in PiP at once - cleanly exit fullscreen first and give
    // the browser a brief moment to settle before requesting PiP. Requesting both at
    // once left the page on a blank/white screen instead of a clean transition.
    if (document.fullscreenElement) {
      await document.exitFullscreen().catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 150));
    }

    videoEl.requestPictureInPicture().catch(() => {});
  }

  function cycleAudio() {
    setAudioState((current) => {
      let next;
      if (isNativeApp()) {
        next = current === 'off' ? 'on' : current === 'on' ? 'bg' : 'off';
      } else {
        next = current === 'off' ? 'on' : 'off';
      }
      try {
        localStorage.setItem(muteKey, next);
      } catch {
        // Private browsing / storage disabled - the state still works for this
        // session, it just won't be remembered next time.
      }
      return next;
    });
  }

  const audioLabel =
    audioState === 'off'
      ? `${camera.name} muted - tap to unmute`
      : audioState === 'bg'
        ? `${camera.name} listening in background - tap to return to normal audio`
        : isNativeApp()
          ? `${camera.name} audio on - tap to mute, tap twice for background listening`
          : `Mute ${camera.name}`;

  // Clean up any pending single-tap timer if the tile unmounts mid-wait.
  useEffect(() => () => clearTimeout(singleTapTimeoutRef.current), []);

  function handleVideoTap(e) {
    // Only the video area itself should trigger zoom gestures - taps on the overlay
    // buttons (mute, fullscreen, PiP, settings) shouldn't also register as a tap here.
    if (e.target.closest('button')) return;

    const rect = videoWrapRef.current.getBoundingClientRect();
    const point = {
      x: ((e.clientX - rect.left) / rect.width) * 100,
      y: ((e.clientY - rect.top) / rect.height) * 100,
    };

    const now = Date.now();
    const isDoubleTap = now - lastTapRef.current < DOUBLE_TAP_WINDOW_MS;
    lastTapRef.current = now;

    if (isDoubleTap) {
      clearTimeout(singleTapTimeoutRef.current);
      if (zoomedRef.current) {
        setZoomed(false); // double-tap while zoomed -> reset to normal size
      } else {
        setZoomOrigin(point);
        setZoomed(true); // double-tap at normal size -> zoom in centered here
      }
      return;
    }

    // Wait briefly to see if a second tap follows before treating this as a
    // deliberate single tap (which only does something while already zoomed).
    singleTapTimeoutRef.current = setTimeout(() => {
      if (zoomedRef.current) {
        setZoomOrigin(point); // single tap while zoomed -> re-center the view here
      }
    }, DOUBLE_TAP_WINDOW_MS);
  }

  return (
    <div className="camera-tile">
      <div className="camera-tile__video-wrap" ref={videoWrapRef} onClick={handleVideoTap}>
        <div
          className="camera-tile__zoom-layer"
          style={
            zoomed
              ? { transform: 'scale(2.5)', transformOrigin: `${zoomOrigin.x}% ${zoomOrigin.y}%` }
              : undefined
          }
        >
          {mode === 'live' ? (
            <WhepPlayer
              mediamtxPath={camera.mediamtx_path}
              active
              muted={effectiveMuted}
              onFirstConnectFailed={handleFirstConnectFailed}
              cameraName={camera.name}
            />
          ) : (
            <HlsPlayer mediamtxPath={camera.mediamtx_path} active muted={effectiveMuted} />
          )}
        </div>

        <button
          className="pip-btn"
          onClick={enterPip}
          aria-label={`Pop out ${camera.name} as a floating window`}
        >
          <PictureInPicture2 size={16} />
        </button>

        <button
          className="settings-btn"
          onClick={() => setModeMenuOpen((o) => !o)}
          aria-label="Stream quality settings"
          aria-expanded={modeMenuOpen}
        >
          <Settings size={16} />
        </button>

        {modeMenuOpen && (
          <>
            <div className="tile-menu-backdrop" onClick={() => setModeMenuOpen(false)} />
            <div className="tile-menu">
              <button
                className={`tile-menu__item${mode === 'live' ? ' tile-menu__item--active' : ''}`}
                onClick={() => selectMode('live')}
              >
                Low latency
              </button>
              <button
                className={`tile-menu__item${mode === 'compat' ? ' tile-menu__item--active' : ''}`}
                onClick={() => selectMode('compat')}
              >
                Compatibility
              </button>
            </div>
          </>
        )}

        <button
          className={`mute-btn${audioState === 'bg' ? ' mute-btn--bg' : ''}`}
          onClick={cycleAudio}
          aria-label={audioLabel}
        >
          {audioState === 'off' ? (
            <VolumeX size={16} />
          ) : audioState === 'bg' ? (
            <Radio size={16} />
          ) : (
            <Volume2 size={16} />
          )}
        </button>
        <button
          className="fullscreen-btn"
          onClick={toggleFullscreen}
          aria-label={isFullscreen ? `Exit fullscreen` : `View ${camera.name} fullscreen`}
        >
          {isFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </button>
      </div>
      <div className="camera-tile__meta">
        <div className="camera-tile__meta-left">
          {dragHandleProps && (
            <button className="drag-handle" {...dragHandleProps} aria-label={`Reorder ${camera.name}`}>
              <GripVertical size={16} />
            </button>
          )}
          <div>
            <div className="camera-tile__name">{camera.name}</div>
            <div className="camera-tile__sub">{childName || 'Unassigned'}</div>
          </div>
        </div>
        <div className="status-row">
          {formatReading(camera.mqtt, settings.temp_unit) && (
            <span className="camera-tile__reading">{formatReading(camera.mqtt, settings.temp_unit)}</span>
          )}
          <BreathingDot status={camera.statusLevel || 'connecting'} />
        </div>
      </div>
    </div>
  );
}
