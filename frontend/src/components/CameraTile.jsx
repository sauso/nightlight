import { useEffect, useRef, useState } from 'react';
import { Maximize2, Minimize2, Settings, PictureInPicture2, Volume2, VolumeX, Radio, GripVertical, Move, ChevronUp, ChevronDown, ChevronLeft, ChevronRight, Mic, Thermometer, Droplet } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { startTalk } from '../lib/twoWayTalk.js';
import { useSettings } from '../lib/SettingsContext.jsx';
import { useAuth } from '../lib/AuthContext.jsx';
import { isNativeApp, isIOS, isSoftReload, setBackgroundListening, onBackgroundStopped, enterNativePip, hasNativePip, subscribeBackgroundPaused, isBackgroundPaused, setBackgroundPaused, setPipAutoEnteredFullscreen } from '../lib/nativeBridge.js';
import WhepPlayer from './WhepPlayer.jsx';
import HlsPlayer from './HlsPlayer.jsx';
import BreathingDot from './BreathingDot.jsx';

// Room temperature / humidity from MQTT, one entry per available reading, each with its own
// icon (thermometer / droplet) so the two values read at a glance instead of running together
// as a "22.5°C · 45%" string.
function readingParts(mqtt, tempUnit) {
  if (!mqtt) return [];
  const parts = [];
  if (typeof mqtt.temperature === 'number') {
    const value = tempUnit === 'F' ? (mqtt.temperature * 9) / 5 + 32 : mqtt.temperature;
    parts.push({ key: 'temp', Icon: Thermometer, text: `${value.toFixed(1)}°${tempUnit}` });
  }
  if (typeof mqtt.humidity === 'number') {
    parts.push({ key: 'humidity', Icon: Droplet, text: `${Math.round(mqtt.humidity)}%` });
  }
  return parts;
}

export default function CameraTile({ camera, childName, dragHandleProps, refreshNonce = 0 }) {
  const { settings } = useSettings();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const navigate = useNavigate();
  // Per-device, not synced through the backend - deliberately so a phone sitting next
  // to you can stay muted while a tablet mounted in the nursery stays unmuted, rather
  // than muting on one device silently muting it everywhere.
  const muteKey = `nightlight_muted_${camera.id}`;
  // Per-device "stop playback" for this tile - tears the stream down entirely on this device
  // to save bandwidth/data when you only care about some cameras, without affecting the
  // server-side stream or any other viewer. Persisted per-camera like mute, so a stopped
  // camera stays stopped across reloads until you start it again here.
  const stopKey = `nightlight_stopped_${camera.id}`;
  const [stopped, setStoppedState] = useState(() => {
    try {
      return localStorage.getItem(stopKey) === 'true';
    } catch {
      return false;
    }
  });
  function setStopped(value) {
    setStoppedState(value);
    try {
      localStorage.setItem(stopKey, value ? 'true' : 'false');
    } catch {
      // Private browsing / storage disabled - still works for this session.
    }
  }

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
      // Nothing saved = a brand-new visitor on this device. Default to muted: it means
      // audio autoplays cleanly with no browser "tap for sound" gesture prompt, and it's
      // the polite default (no unexpected sound on first open). Returning visitors keep
      // whatever they last chose, via the branches above.
      return 'off';
    } catch {
      return 'off';
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
  // Background-audio pause (from the Android notification's Pause button or iOS's Now
  // Playing controls) mutes every Background-mode tile app-wide. Kept separate from the
  // per-tile mute so resuming restores exactly the previous state.
  const [bgPaused, setBgPaused] = useState(isBackgroundPaused);
  useEffect(() => subscribeBackgroundPaused(setBgPaused), []);

  // Two-way audio (push-to-talk). While talking we duck THIS camera's incoming audio - the camera
  // is half-duplex (walkie-talkie), and leaving its mic live would feed its own speaker back as echo.
  const [talking, setTalking] = useState(false);
  const talkStopRef = useRef(null);
  const talkTimeoutRef = useRef(null);
  const [talkError, setTalkError] = useState('');
  // Tap-to-talk (toggle), not hold: tap once to go live, tap again to stop. A safety cap auto-stops
  // it so a forgotten "on" can't leave the mic live indefinitely (the reason the old design held).
  const TALK_MAX_MS = 2 * 60 * 1000;
  function startTalking() {
    if (talkStopRef.current) return;
    setTalkError('');
    setTalking(true);
    talkStopRef.current = startTalk(camera.id, {
      onError: (msg) => { setTalkError(msg || 'Talk failed'); stopTalking(); },
    });
    clearTimeout(talkTimeoutRef.current);
    talkTimeoutRef.current = setTimeout(stopTalking, TALK_MAX_MS);
  }
  function stopTalking() {
    clearTimeout(talkTimeoutRef.current);
    setTalking(false);
    try { talkStopRef.current?.(); } catch { /* ignore */ }
    talkStopRef.current = null;
  }
  function toggleTalk(e) {
    e.preventDefault();
    e.stopPropagation();
    if (talkStopRef.current) stopTalking();
    else startTalking();
  }
  // Tear down talk if the tile unmounts, and stop the live mic if the app is backgrounded.
  useEffect(() => () => { clearTimeout(talkTimeoutRef.current); try { talkStopRef.current?.(); } catch { /* ignore */ } }, []);
  useEffect(() => {
    if (talking && !pageVisible) stopTalking();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [talking, pageVisible]);

  const effectiveMuted =
    talking || muted || (audioState === 'on' && !pageVisible) || (audioState === 'bg' && bgPaused);

  // When the app is minimized and this camera isn't in Background mode, tear the stream
  // connection down entirely (WhepPlayer/HlsPlayer both fully disconnect when active is
  // false) rather than merely muting it - otherwise it keeps pulling video/audio over the
  // network in the background, the real battery and data drain. It reconnects on return.
  // Background mode is deliberately exempt: keeping the connection alive with the screen
  // off is its entire purpose (backed by the native foreground service). A tile the user has
  // explicitly stopped stays torn down no matter what - that's the whole point of stopping it.
  const streamActive = !stopped && (pageVisible || audioState === 'bg');

  const [mode, setMode] = useState('live'); // 'live' (WebRTC) | 'compat' (HLS)

  // Stream quality: 'high' (the main stream) | 'low' (the camera's lower-res sub-stream, if it has
  // one - camera.has_sub). Per-device, like mute: a phone on mobile data and a wall tablet on wifi
  // want different answers. Selecting Low points the player at the `<path>-sub` MediaMTX path.
  const qualityKey = `nightlight_quality_${camera.id}`;
  const [quality, setQualityState] = useState(() => {
    try {
      return localStorage.getItem(qualityKey) === 'low' ? 'low' : 'high';
    } catch {
      return 'high';
    }
  });
  function setQuality(q) {
    setQualityState(q);
    try { localStorage.setItem(qualityKey, q); } catch { /* ignore */ }
  }
  const effectivePath =
    quality === 'low' && camera.has_sub ? `${camera.mediamtx_path}-sub` : camera.mediamtx_path;
  // Background audio needs the native app, and on iOS it's Low-latency-only. Compatibility (HLS)
  // background audio on iOS was tried and dropped: iOS runs the native HLS stream's own lock-screen
  // session and won't reliably let us show the camera name/artwork, catch the lock-screen pause, or
  // control several cameras together - it was inconsistent and caused more problems than it solved
  // (see KNOWN-ISSUES.md). Android is unaffected (its foreground service keeps the <video> alive),
  // so only iOS + Compatibility is excluded.
  const canBackgroundAudio = isNativeApp() && !(isIOS() && mode === 'compat');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const [qualityMenuOpen, setQualityMenuOpen] = useState(false); // drill-in submenu for High/Low
  function closeMenu() {
    setModeMenuOpen(false);
    setQualityMenuOpen(false);
  }
  // "Camera settings" from the gear sheet (admin only) → that camera's routed settings screen.
  // `from` makes its back button return to Live, where the gear sheet was opened.
  function openCameraSettings() {
    closeMenu();
    navigate(`/cameras/${camera.id}`, { state: { from: { to: '/', label: 'Live' } } });
  }
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
    // A stopped tile releases its claim on the background service too - no point keeping a
    // foreground-audio notification alive for a camera whose stream we've torn down.
    setBackgroundListening(camera.id, camera.name, audioState === 'bg' && !stopped);
    return undefined;
  }, [audioState, camera.id, camera.name, stopped]);

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

    // Native Android: Activity PiP floats the whole app *window*, so PiP-ing from the grid
    // floats the entire UI and you can barely see the video. To float just the video, we
    // first fullscreen this tile - the video then fills the window - and only then enter
    // PiP, so the floating window shows the video alone. hasNativePip() is Android-only
    // (the Pip plugin isn't registered in the iOS shell), so iOS falls through to the web
    // path below. No native change needed: the native side floats whatever's on screen.
    if (isNativeApp() && hasNativePip()) {
      const alreadyFullscreen = document.fullscreenElement === wrap;
      let enteredFullscreenForPip = false;
      if (wrap && !alreadyFullscreen && wrap.requestFullscreen) {
        try {
          await wrap.requestFullscreen();
          enteredFullscreenForPip = true;
          screen.orientation?.lock?.('landscape').catch(() => {});
          // Let the WebView actually paint the fullscreen view before the PiP snapshot,
          // otherwise the float can capture the pre-fullscreen (whole-app) frame.
          await new Promise((resolve) => setTimeout(resolve, 250));
        } catch {
          // Fullscreen refused - fall through to a plain whole-window PiP rather than fail.
        }
      }
      // Record whether *we* entered fullscreen just for PiP, so leaving PiP can put the
      // user back where they were (dashboard) rather than stranding them in fullscreen.
      // If they were already fullscreen, leave that flag off so they stay there on return.
      setPipAutoEnteredFullscreen(enteredFullscreenForPip);
      if (await enterNativePip()) return;
      // Native PiP unexpectedly didn't start - undo any fullscreen we entered and clear.
      setPipAutoEnteredFullscreen(false);
      if (enteredFullscreenForPip && document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
      return;
    }

    // Web / iOS path: element-level PiP on the <video> itself.
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
    // Tapping the speaker is an explicit "I want to control audio now", so clear any lingering
    // background-pause (from the lock-screen / notification Pause). Otherwise a stale pause
    // would keep Background mode silent even after toggling to it, until an app restart.
    setBackgroundPaused(false);
    setAudioState((current) => {
      let next;
      if (canBackgroundAudio) {
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

  // If Background audio isn't available for this camera's current mode (iOS + Compatibility) but
  // the tile is somehow in it - e.g. it was listening in Background on Low latency and the user
  // switched it to Compatibility - drop back to plain On, so we don't claim a background session
  // iOS will just suspend.
  useEffect(() => {
    if (audioState === 'bg' && !canBackgroundAudio) {
      setAudioState('on');
      try {
        localStorage.setItem(muteKey, 'on');
      } catch {
        // ignore
      }
    }
  }, [canBackgroundAudio, audioState, muteKey]);

  const audioLabel =
    audioState === 'off'
      ? `${camera.name} muted - tap to unmute`
      : audioState === 'bg'
        ? `${camera.name} listening in background - tap to return to normal audio`
        : canBackgroundAudio
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

  // --- PTZ (pan/tilt) control, for ONVIF cameras that report support ---
  const [ptzOpen, setPtzOpen] = useState(false);
  const ptzHoldingRef = useRef(false);
  // Move velocity per nudge (ONVIF x/y are -1..1). Kept modest because some cameras
  // (notably Sonoff-hack / onvif_simple_server) answer ContinuousMove slowly and moving for a
  // variable 0.4-2.3s regardless of our hold time — a lower speed keeps that variable-length
  // move to a smaller, less jarring angle (distance = speed x time). A "real" ONVIF PTZ camera
  // responds in tens of ms and is unaffected either way.
  const PTZ_SPEED = 0.25;

  // Each press sends fixed-duration "nudges" (the server starts, holds, and stops the move),
  // so a tap always travels a consistent amount regardless of how briefly it was pressed or
  // of network timing. A quick tap completes exactly one nudge (the loop only re-checks the
  // hold flag after the in-flight nudge resolves); holding repeats nudges for continued
  // movement. No stranded moves - each nudge self-stops.
  async function ptzHoldLoop(pan, tilt) {
    if (ptzHoldingRef.current) return; // already running for this press
    ptzHoldingRef.current = true;
    while (ptzHoldingRef.current) {
      try {
        await api.post(`/cameras/${camera.id}/ptz/nudge`, { pan, tilt });
      } catch {
        break; // stop repeating if a nudge fails
      }
    }
  }
  function ptzEndHold() {
    ptzHoldingRef.current = false;
  }
  function ptzHold(pan, tilt) {
    return {
      onPointerDown: (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        ptzHoldLoop(pan, tilt);
      },
      onPointerUp: ptzEndHold,
      onPointerCancel: ptzEndHold,
      onPointerLeave: ptzEndHold,
    };
  }
  // Stop any active hold-loop if the tile unmounts mid-press.
  useEffect(() => () => { ptzHoldingRef.current = false; }, []);

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
          {/* refreshNonce is part of the key: a pull-to-refresh bumps it, which remounts
              the player, tearing down and rebuilding the stream connection from scratch.
              This is the in-app equivalent of restarting the app to clear a WebRTC
              connection that's wedged "connected" but no longer delivering frames - and
              it works inside the native WebView, where a browser refresh gesture doesn't
              exist. Keyed here rather than on the tile so mute/zoom/mode state survives. */}
          {mode === 'live' ? (
            <WhepPlayer
              key={`live-${refreshNonce}`}
              mediamtxPath={effectivePath}
              active={streamActive}
              muted={effectiveMuted}
              onFirstConnectFailed={handleFirstConnectFailed}
              cameraName={camera.name}
              isBackgroundAudio={audioState === 'bg'}
            />
          ) : (
            <HlsPlayer
              key={`compat-${refreshNonce}`}
              mediamtxPath={effectivePath}
              active={streamActive}
              muted={effectiveMuted}
            />
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
          onClick={() => { setModeMenuOpen((o) => !o); setQualityMenuOpen(false); }}
          aria-label="Stream quality settings"
          aria-expanded={modeMenuOpen}
        >
          <Settings size={16} />
        </button>

        {modeMenuOpen && (
          <>
            <div className="tile-menu-backdrop" onClick={closeMenu} />
            <div className="tile-menu" role="dialog" aria-label={`${camera.name} settings`}>
              <div className="tile-menu__grabber" aria-hidden="true" />
              <div className="tile-menu__title">{camera.name}</div>
              {qualityMenuOpen ? (
                // Quality submenu (drill-in) - keeps the main sheet short.
                <div className="tile-menu__section">
                  <button
                    className="tile-menu__item tile-menu__item--back"
                    onClick={() => setQualityMenuOpen(false)}
                  >
                    ‹ Quality
                  </button>
                  <button
                    className={`tile-menu__item${quality === 'high' ? ' tile-menu__item--active' : ''}`}
                    onClick={() => { setQuality('high'); closeMenu(); }}
                  >
                    High
                  </button>
                  <button
                    className={`tile-menu__item${quality === 'low' ? ' tile-menu__item--active' : ''}`}
                    onClick={() => { setQuality('low'); closeMenu(); }}
                  >
                    Low
                  </button>
                </div>
              ) : (
                <>
                  <div className="tile-menu__label">Stream</div>
                  <div className="tile-menu__section">
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
                    {camera.has_sub && (
                      <button
                        className="tile-menu__item tile-menu__item--submenu"
                        onClick={() => setQualityMenuOpen(true)}
                      >
                        <span>Quality</span>
                        <span className="tile-menu__value">{quality === 'low' ? 'Low ›' : 'High ›'}</span>
                      </button>
                    )}
                  </div>
                  <div className="tile-menu__section">
                    <button
                      className="tile-menu__item"
                      onClick={() => { setStopped(!stopped); closeMenu(); }}
                    >
                      {stopped ? 'Start camera' : 'Stop camera'}
                    </button>
                    {isAdmin && (
                      <button className="tile-menu__item tile-menu__item--submenu" onClick={openCameraSettings}>
                        <span>Camera settings</span>
                        <span className="tile-menu__value">›</span>
                      </button>
                    )}
                  </div>
                </>
              )}
              <button className="tile-menu__done" onClick={closeMenu}>Done</button>
            </div>
          </>
        )}

        {/* PTZ control - only for cameras that reported pan/tilt support over ONVIF. */}
        {camera.ptz_supported ? (
          <button
            className="ptz-btn"
            onClick={() => setPtzOpen((o) => !o)}
            aria-label={`Move ${camera.name}`}
            aria-expanded={ptzOpen}
          >
            <Move size={16} />
          </button>
        ) : null}

        {ptzOpen && (
          <>
            <div
              className="ptz-backdrop"
              onClick={() => {
                ptzEndHold();
                setPtzOpen(false);
              }}
            />
            <div className="ptz-pad" role="group" aria-label="Pan and tilt controls">
              <button className="ptz-arrow" aria-label="Tilt up" {...ptzHold(0, PTZ_SPEED)}>
                <ChevronUp size={24} />
              </button>
              <div className="ptz-pad__mid">
                <button className="ptz-arrow" aria-label="Pan left" {...ptzHold(-PTZ_SPEED, 0)}>
                  <ChevronLeft size={24} />
                </button>
                <button className="ptz-arrow" aria-label="Pan right" {...ptzHold(PTZ_SPEED, 0)}>
                  <ChevronRight size={24} />
                </button>
              </div>
              <button className="ptz-arrow" aria-label="Tilt down" {...ptzHold(0, -PTZ_SPEED)}>
                <ChevronDown size={24} />
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
        {/* Tap-to-talk (toggle): only for cameras an admin has set up two-way audio on. Tap to go
            live (button turns red + pulses), tap again to stop; auto-stops after a couple of minutes. */}
        {camera.talk_configured && (
          <button
            className={`talk-btn${talking ? ' talk-btn--active' : ''}`}
            onClick={toggleTalk}
            aria-label={talking ? `Stop talking to ${camera.name}` : `Talk to ${camera.name}`}
            aria-pressed={talking}
            title={talkError || (talking ? 'Tap to stop' : 'Tap to talk')}
          >
            <Mic size={16} />
          </button>
        )}
        <button
          className="fullscreen-btn"
          onClick={toggleFullscreen}
          aria-label={isFullscreen ? `Exit fullscreen` : `View ${camera.name} fullscreen`}
        >
          {isFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </button>

        {/* Covers the whole tile when stopped - the stream is torn down (see streamActive),
            so this replaces the players' own idle overlay with a clear "you stopped this"
            message and a one-tap way to bring it back. */}
        {stopped && (
          <div className="camera-tile__stopped">
            <span>Camera stopped</span>
            <button className="btn btn-sm" onClick={() => setStopped(false)}>
              Start camera
            </button>
          </div>
        )}
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
          {readingParts(camera.mqtt, settings.temp_unit).map(({ key, Icon, text }) => (
            <span key={key} className="camera-tile__reading">
              <Icon size={13} className="camera-tile__reading-icon" aria-hidden="true" />
              {text}
            </span>
          ))}
          <BreathingDot status={camera.statusLevel || 'connecting'} />
        </div>
      </div>
    </div>
  );
}
