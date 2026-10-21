import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
} from '@dnd-kit/core';
import { SortableContext, rectSortingStrategy, arrayMove, sortableKeyboardCoordinates } from '@dnd-kit/sortable';

// Move `activeId` to where `overId` sits, in the FULL camera list.
//
// ⚠️ Exported and pure on purpose. The grid only renders ENABLED cameras, but the order that gets
// saved covers every camera including the disabled ones — so a disabled camera keeps its saved
// position and reappears where it was when it is switched back on, rather than being shunted to the
// end by the first drag anyone does. That means the indices must be looked up in `full`, never in the
// list on screen; computing them from the visible subset would write an order missing every disabled
// camera. It lives out here because it is pure logic worth testing directly — same arrangement as
// CameraTile's `togglePatch`.
//
// ⚠️ NOT because the component is untestable. This used to say the surrounding component "cannot run
// under jsdom" and cited a coverage exclusion in vite.config.js as evidence; that exclusion has since
// been removed precisely because the claim was false, and liveMonitor.test.jsx / appShell.test.jsx
// render this component under jsdom today (issue #322). If you are deciding whether to write a test
// for something in here: you can.
export function reorderCameras(full, activeId, overId) {
  const oldIndex = full.findIndex((c) => c.id === activeId);
  const newIndex = full.findIndex((c) => c.id === overId);
  // A drag onto something not in the list would make arrayMove(-1) silently move the LAST camera.
  if (oldIndex === -1 || newIndex === -1) return full;
  return arrayMove(full, oldIndex, newIndex);
}
import { useCameras } from '../lib/CamerasContext.jsx';
import { useSettings } from '../lib/SettingsContext.jsx';
import { useAuth } from '../lib/AuthContext.jsx';
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
import LoadFailed from './LoadFailed.jsx';
import { loadState } from '../lib/loadState.js';

// This component is mounted once for the entire logged-in session (see App.jsx) so that
// switching to Settings/Children/Cameras/Account never tears down the WebRTC connections
// or interrupts audio. When you're not on the Nursery tab it's pushed off-screen with CSS
// (not display:none — that can pause media in some browsers) rather than unmounted.
export default function LiveMonitor() {
  const location = useLocation();
  const isActive = location.pathname === '/';
  const { kids, cameras, error, loaded, refresh } = useCameras();
  const { settings } = useSettings();
  // Every signed-in user can reorder (#675; admin-only from #552 until then). The camera order can still pick the
  // camera a child's sleep is measured from, so the SERVER refuses a non-admin's reorder that would change it
  // (routes/cameras.js, PUT /reorder), and handleDragEnd puts the tiles back and shows why. `!!user`, not
  // `true`: no drag handle on a page with nobody signed in (the server would answer it 401 anyway).
  const { user } = useAuth() || {};
  const isAdmin = user?.role === 'admin';
  const canReorder = !!user;

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
  // "No cameras yet" only after a request SUCCEEDED with none (#375); an outage keeps the last grid (stale) or
  // says it could not load, and a cold start says it is loading.
  const listState = loadState({ loaded, error, count: visibleCameras.length });

  // The newest order, readable from an event handler between renders (#562). handleDragEnd closes over
  // `orderedCameras` from the render it was created in, so two drops reported inside ONE React batch (before
  // any render) would both build from the same old order and the second would silently undo the first. The
  // old updater form (`setOrderedCameras((current) => ...)`) did not have that problem; moving the PUT out of
  // the updater must not lose it, so the handler reads and advances this ref, which every render re-syncs
  // from state (so a cameras refresh from the context still wins).
  const orderRef = useRef(orderedCameras);
  orderRef.current = orderedCameras;

  // The reorder saves, sent one at a time (#675; why, in handleDragEnd). `saveChainRef` is the tail of the chain;
  // `pendingSavesRef` counts drops whose save has not settled; `refusalsRef` counts refusals, so a drop queued
  // before one can tell it was built on a refused order; `refreshWhenIdleRef` asks for one refresh() once the
  // chain is idle. `reorderRefusal` is the server's message for the banner above the grid.
  const saveChainRef = useRef(Promise.resolve());
  const pendingSavesRef = useRef(0);
  const refusalsRef = useRef(0);
  const refreshWhenIdleRef = useRef(false);
  const [reorderRefusal, setReorderRefusal] = useState('');

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  // The grid hides disabled cameras, while the saved order includes them. Speak positions in the
  // visible grid (#381), so a camera beside the second tile is called second even if hidden cameras
  // sit before it in the full order sent by handleDragEnd.
  const cameraName = (id) => visibleCameras.find((cam) => cam.id === id)?.name;
  const visiblePosition = (id) => visibleCameras.findIndex((cam) => cam.id === id) + 1;
  const announcements = {
    onDragStart: ({ active }) => `Picked up ${cameraName(active.id)}. Position ${visiblePosition(active.id)} of ${visibleCameras.length}.`,
    onDragOver: ({ active, over }) => over
      ? `Moved ${cameraName(active.id)} to position ${visiblePosition(over.id)} of ${visibleCameras.length}`
      : undefined,
    onDragEnd: ({ active, over }) => over
      ? `Moved ${cameraName(active.id)} to position ${visiblePosition(over.id)} of ${visibleCameras.length}`
      : `Stopped moving ${cameraName(active.id)}.`,
    onDragCancel: ({ active }) => `Cancelled moving ${cameraName(active.id)}.`,
  };
  const screenReaderInstructions = {
    draggable: 'To reorder a camera, press Space or Enter to pick it up. Use the arrow keys to move it, then press Space or Enter to place it. Press Escape to cancel.',
  };

  function childNameFor(cam) {
    return kids.find((k) => k.id === cam.child_id)?.name;
  }

  function handleDragEnd(event) {
    const { active, over } = event;
    if (!canReorder || !over || active.id === over.id) return;
    // The new order is computed HERE and the PUT is sent from the handler, not from inside the
    // setOrderedCameras updater (#562). React may call an updater more than once (StrictMode does it on
    // purpose in development, to flush out exactly this), and a side effect inside it sent the same
    // reorder twice. An updater must be pure.
    // Built from the ref, not the closure, and the ref is advanced at once: see orderRef above.
    const before = orderRef.current;
    const next = reorderCameras(orderRef.current, active.id, over.id);
    orderRef.current = next;
    setOrderedCameras(next);
    // THE SAVE (#675). The grid moved optimistically above, and the server may now refuse the move: 409 with
    // reason `would_change_sleep_camera` when a non-admin moved the camera a tracked child is measured from.
    //   - SERIALISED (one promise chain): a drop is sent only after the previous drop's save has settled, so a
    //     later drop is never judged by the server before an earlier one.
    //   - On THAT refusal the tiles go back AT ONCE to the order from before this drop (the state AND the ref),
    //     and the server's message is shown. Not left to refresh(): it can fail (and is an inert spy in the
    //     tests), and then the refused order would stay on screen with the ref still holding it.
    //   - A drop queued behind a refused one is NOT sent: it was built on the refused order, and judged alone it
    //     would be refused too and "put back" the refused order. The tiles stay where the refusal put them.
    //   - Once the chain is idle after a refusal, refresh() loads the server's order, which is the truth (the
    //     order is shared, and another viewer may have moved tiles meanwhile).
    //   - Every OTHER failure stays silent, exactly as before #675 (the grid keeps the new order): the public
    //     demo's read-only 403 (a banner on every drag there otherwise), a 401 (api.js already sends the person
    //     to sign in), another 4xx, a 5xx, a network failure. KNOWN LIMIT: such a drop did not save and nothing
    //     says so; the next cameras poll (15 s, lib/CamerasContext.jsx) puts the grid back to the server's order.
    const generation = refusalsRef.current;
    pendingSavesRef.current += 1;
    saveChainRef.current = saveChainRef.current
      .then(() => {
        if (refusalsRef.current !== generation) return undefined;
        return api.put('/cameras/reorder', { order: next.map((c) => c.id) }).catch((err) => {
          if (err?.data?.reason !== 'would_change_sleep_camera') return;
          refusalsRef.current += 1;
          orderRef.current = before;
          setOrderedCameras(before);
          setReorderRefusal(err.message);
          refreshWhenIdleRef.current = true;
        });
      })
      .finally(() => {
        pendingSavesRef.current -= 1;
        if (pendingSavesRef.current === 0 && refreshWhenIdleRef.current) {
          refreshWhenIdleRef.current = false;
          refresh?.();
        }
      })
      // The tail must never stay rejected: every later `.then` would be skipped and no drop would save again.
      .catch(() => {});
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

  // The monitor stays mounted on every route so the streams keep running, which means its buttons stay in the DOM
  // while another screen is showing. aria-hidden hides them from a screen reader but leaves them in the Tab order, so
  // a keyboard user tabbed into controls they could not see (#376). `inert` takes them out of both, and of the
  // accessibility tree, without unmounting anything, so playback and background audio carry on.
  //
  // Set through the DOM, not as a JSX prop, on purpose: React 18 does not know `inert` (it drops `inert={true}` and
  // needs the string form), and React 19 treats the string form "" as false. A ref write is correct on both, so the
  // React 19 migration (#634) cannot silently turn this off.
  useEffect(() => {
    containerRef.current?.toggleAttribute('inert', !isActive);
  }, [isActive]);

  return (
    <div
      ref={containerRef}
      className={`live-monitor ${isActive ? 'live-monitor--active' : 'live-monitor--hidden'}`}
      aria-hidden={!isActive}
    >
      <AppHeader title={settings.app_name} showDemoBanner={isActive} />

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
        {(listState === 'error' || listState === 'stale') && (
          <LoadFailed what="cameras" error={error} onRetry={refresh} stale={listState === 'stale'} />
        )}

        {/* A drop the server refused (#675): only the sleep-camera refusal reaches here (see handleDragEnd), and
            the tiles are already back where they were. Beside the grid, never a browser popup
            (docs/design-language.md); role="alert" so it is spoken when it appears; it stays until dismissed,
            because it is about one drop and the person may look up only after letting go. */}
        {reorderRefusal && (
          <div className="error-banner" role="alert" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
            <span>{reorderRefusal}</span>
            <button type="button" className="btn btn-sm btn-secondary" onClick={() => setReorderRefusal('')}>Dismiss</button>
          </div>
        )}

        {listState === 'loading' && <div className="empty-state">Loading…</div>}

        {listState === 'empty' && (
          <div className="empty-state">
            {/* Adding a camera is admin-only (the server refuses a caregiver's POST /cameras, and the
                Cameras tab shows them no Add button), so telling a caregiver to "add one" sends them to
                a screen that cannot do it (#380). They are told who can. The admin's copy is unchanged. */}
            {isAdmin
              ? 'No cameras yet. Add one from the Cameras tab to start watching.'
              : 'No cameras yet. Ask an administrator to add or enable a camera.'}
          </div>
        )}

        {visibleCameras.length > 0 && (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            accessibility={{ announcements, screenReaderInstructions }}
            onDragEnd={handleDragEnd}
          >
            <SortableContext items={visibleCameras.map((c) => c.id)} strategy={rectSortingStrategy}>
              <div className="card-grid">
                {visibleCameras.map((cam) => (
                  <SortableCameraTile
                    key={cam.id}
                    camera={cam}
                    childName={childNameFor(cam)}
                    refreshNonce={refreshNonce}
                    sortable={canReorder}
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
