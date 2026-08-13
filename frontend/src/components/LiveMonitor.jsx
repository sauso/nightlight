import { useCallback, useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
} from '@dnd-kit/core';
import { SortableContext, rectSortingStrategy, arrayMove } from '@dnd-kit/sortable';
import { useCameras } from '../lib/CamerasContext.jsx';
import { useSettings } from '../lib/SettingsContext.jsx';
import {
  isNativeApp,
  setAutoPictureInPicture,
  onPipModeChanged,
  onBackgroundPauseChanged,
  setBackgroundPaused,
  didPipAutoEnterFullscreen,
  setPipAutoEnteredFullscreen,
} from '../lib/nativeBridge.js';
import { usePullToRefresh } from '../lib/usePullToRefresh.js';
import { api } from '../lib/api.js';
import AppHeader from './AppHeader.jsx';
import SortableCameraTile from './SortableCameraTile.jsx';

// This component is mounted once for the entire logged-in session (see App.jsx) so that
// switching to Settings/Children/Cameras/Account never tears down the WebRTC connections
// or interrupts audio. When you're not on the Nursery tab it's pushed off-screen with CSS
// (not display:none — that can pause media in some browsers) rather than unmounted.
export default function LiveMonitor() {
  const location = useLocation();
  const isActive = location.pathname === '/';
  const { kids, cameras, error } = useCameras();
  const { settings } = useSettings();

  // Bumping this remounts every camera player (see CameraTile), which rebuilds each
  // stream connection from scratch - the in-app equivalent of restarting the app to
  // clear a wedged WebRTC connection. Driven by pull-to-refresh below.
  const [refreshNonce, setRefreshNonce] = useState(0);
  const handleRefresh = useCallback(() => {
    // Client-only refresh: bump the nonce to remount every camera player, rebuilding each stream
    // connection from scratch. Deliberately does NOT restart the server-side transcoders - doing
    // that (added briefly in 0.6.2) caused more disruption than it fixed, so it was backed out;
    // an upstream wedge is handled by the server's own audio-liveness watchdog instead.
    setRefreshNonce((n) => n + 1);
  }, []);
  const { containerRef, pull, refreshing, dragging, armed } = usePullToRefresh({
    enabled: isActive,
    onRefresh: handleRefresh,
  });

  // A single flat, freely-reorderable list rather than grouped-by-child sections -
  // grouping doesn't mix well with free drag-reordering across children, and each
  // tile already shows its own assigned child underneath its name regardless.
  const [orderedCameras, setOrderedCameras] = useState(cameras);
  useEffect(() => setOrderedCameras(cameras), [cameras]);

  // Cameras an admin has turned off don't belong on the live grid at all - they have no
  // stream. Filter them out for display only; orderedCameras stays the full list so drag
  // reordering keeps their saved position rather than dropping them out of the order.
  const visibleCameras = orderedCameras.filter((cam) => !cam.disabled);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
  );

  function childNameFor(cam) {
    return kids.find((k) => k.id === cam.child_id)?.name;
  }

  function handleDragEnd(event) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setOrderedCameras((current) => {
      const oldIndex = current.findIndex((c) => c.id === active.id);
      const newIndex = current.findIndex((c) => c.id === over.id);
      const next = arrayMove(current, oldIndex, newIndex);
      api.put('/cameras/reorder', { order: next.map((c) => c.id) }).catch(() => {});
      return next;
    });
  }

  // Native Android tells us when it enters/leaves PiP; toggle a body class so the CSS can
  // hide the on-video overlay buttons (mute/settings/fullscreen) that just clutter the
  // tiny floating window. Also relay the notification's Pause/Resume into the app-wide
  // background-pause. Both no-op off-native.
  useEffect(() => {
    if (!isNativeApp()) return undefined;
    const offPip = onPipModeChanged((isInPip) => {
      document.body.classList.toggle('in-pip', isInPip);
      // Leaving PiP: if the PiP button entered fullscreen itself just to get a clean
      // float, drop back out of fullscreen so the user lands where they started (the
      // dashboard). If they were already fullscreen when they hit PiP, the flag is off
      // and we leave them in fullscreen.
      if (!isInPip && didPipAutoEnterFullscreen()) {
        setPipAutoEnteredFullscreen(false);
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      }
    });
    const offPause = onBackgroundPauseChanged((paused) => setBackgroundPaused(paused));
    return () => {
      offPip();
      offPause();
      document.body.classList.remove('in-pip');
    };
  }, []);

  // Auto-enter Picture-in-Picture (native Android) on leaving the app - but only while a
  // camera is *fullscreen*. Activity PiP floats the whole window, so it's only worth doing
  // when the window is showing a single camera (fullscreen); from the grid it would float
  // the whole UI, so pressing Home there just backgrounds normally (audio keeps going via
  // the foreground service). Driven off the actual fullscreen state - a single writer, so
  // no races between tiles. No-op off-native.
  useEffect(() => {
    if (!isNativeApp()) return undefined;
    function syncAutoPip() {
      setAutoPictureInPicture(!!document.fullscreenElement);
    }
    document.addEventListener('fullscreenchange', syncAutoPip);
    syncAutoPip();
    return () => {
      document.removeEventListener('fullscreenchange', syncAutoPip);
      setAutoPictureInPicture(false);
    };
  }, []);

  // Keep the screen awake for as long as the monitor is open. Wake Lock is released
  // automatically whenever the tab is hidden, so it's re-requested on visibility change.
  useEffect(() => {
    let lock = null;
    let cancelled = false;

    async function acquire() {
      if (!('wakeLock' in navigator)) return;
      try {
        const l = await navigator.wakeLock.request('screen');
        if (cancelled) {
          l.release().catch(() => {});
        } else {
          lock = l;
        }
      } catch {
        // Not available/allowed in this context (e.g. battery saver) — non-fatal.
      }
    }

    acquire();
    function handleVisibility() {
      if (document.visibilityState === 'visible') acquire();
    }
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', handleVisibility);
      if (lock) lock.release().catch(() => {});
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className={`live-monitor ${isActive ? 'live-monitor--active' : 'live-monitor--hidden'}`}
      aria-hidden={!isActive}
    >
      <AppHeader title={settings.app_name} />

      {/* Pull-to-refresh indicator. Its own height is what pushes the content down (in
          normal flow), so there's no doubled offset from also translating the grid. The
          icon rotates as you pull and spins while the reconnect runs. aria-hidden - it's
          a transient affordance, not content. */}
      <div
        className={`ptr-indicator${refreshing ? ' ptr-indicator--spinning' : ''}`}
        style={{
          height: pull,
          opacity: pull > 0 || refreshing ? 1 : 0,
          transition: dragging ? 'none' : 'height 0.25s ease, opacity 0.25s ease',
        }}
        aria-hidden="true"
      >
        <RefreshCw
          size={22}
          className="ptr-indicator__icon"
          style={{
            transform: refreshing ? undefined : `rotate(${Math.min(180, pull * 2.2)}deg)`,
          }}
        />
        <span className="ptr-indicator__label">
          {refreshing ? 'Reconnecting…' : armed ? 'Release to reconnect' : 'Pull to reconnect'}
        </span>
      </div>

      <main className="app-main app-main--wide">
        {error && <div className="error-banner">{error}</div>}

        {visibleCameras.length === 0 && (
          <div className="empty-state">
            No cameras yet. Add one from the Cameras tab to start watching.
          </div>
        )}

        {visibleCameras.length > 0 && (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={visibleCameras.map((c) => c.id)} strategy={rectSortingStrategy}>
              <div className="card-grid">
                {visibleCameras.map((cam) => (
                  <SortableCameraTile
                    key={cam.id}
                    camera={cam}
                    childName={childNameFor(cam)}
                    refreshNonce={refreshNonce}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        )}
      </main>
    </div>
  );
}
