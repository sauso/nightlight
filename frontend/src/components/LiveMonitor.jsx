import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
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
      className={`live-monitor ${isActive ? 'live-monitor--active' : 'live-monitor--hidden'}`}
      aria-hidden={!isActive}
    >
      <AppHeader title={settings.app_name} />
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
                  <SortableCameraTile key={cam.id} camera={cam} childName={childNameFor(cam)} />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        )}
      </main>
    </div>
  );
}
