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

        {orderedCameras.length === 0 && (
          <div className="empty-state">
            No cameras yet. Add one from the Cameras tab to start watching.
          </div>
        )}

        {orderedCameras.length > 0 && (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={orderedCameras.map((c) => c.id)} strategy={rectSortingStrategy}>
              <div className="card-grid">
                {orderedCameras.map((cam) => (
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
