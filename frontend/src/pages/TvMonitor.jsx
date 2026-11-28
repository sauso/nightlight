import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw, Volume2, VolumeX, X } from 'lucide-react';
import { useCameras } from '../lib/CamerasContext.jsx';
import { useSettings } from '../lib/SettingsContext.jsx';
import { loadState } from '../lib/loadState.js';
import { nextFocus } from '../lib/tvNav.js';
import { tvColumns, tvRows } from '../lib/tvLayout.js';
import { setBackHandler } from '../lib/backInterceptor.js';
import WhepPlayer from '../components/WhepPlayer.jsx';
import HlsPlayer from '../components/HlsPlayer.jsx';

// The TV screen (route /tv): big live tiles for a remote control. READ-ONLY and live cameras only. Design and
// key map: docs/mobile.md "Android TV" and docs/design-language.md "TV screen".
//
// This page is NOT CameraTile. CameraTile is built for a finger (double-tap zoom, drag to reorder, pull to
// refresh, 30px overlay icons, hold-to-talk); none of it works with four arrow keys. What is shared is what is
// worth sharing: the camera list (useCameras, the same context LiveMonitor reads, so there is ONE poller and the
// order is the server's) and the two players (WhepPlayer, HlsPlayer), chosen the way CameraTile chooses.
//
// WHAT THIS PAGE NEVER DOES, on purpose: write anything to the server (it only reads the camera list), keep
// the listening state anywhere but in memory, or use the phone layout's controls. A baby monitor that starts
// playing sound at launch is worse than a muted one, so the TV ALWAYS starts muted; nothing is saved or sent
// (tests: tvMonitor.test.jsx "starts muted", "no write request").

// Held at least this long, OK opens the tile full screen instead of toggling sound. Chosen by judgement, not
// measured: long enough that an ordinary press (well under half a second on a remote) never reaches it, short
// enough not to feel like waiting. A press shorter than this must toggle the sound and do nothing else.
export const LONG_PRESS_MS = 600;

// Back arriving this soon after this page already closed full screen is that same press reported twice
// (a keydown AND the shell's Back event), not a second one: without this the second one would exit the app.
// The window is a guess at "the same press"; no real remote has been tried (docs/mobile.md says so).
const BACK_ECHO_MS = 400;

const HINT_STORAGE_KEY = 'nightlight_tv_hint_dismissed';

// Focus target keys that are not cameras. Camera ids are used as their own keys.
const RECONNECT = 'tv:reconnect';
const HINT = 'tv:hint';

function readHintDismissed() {
  try {
    return localStorage.getItem(HINT_STORAGE_KEY) === '1';
  } catch {
    return false; // no storage: show the hint every launch rather than failing
  }
}

// Status line wording. `statusLevel` comes from CamerasContext ('live' | 'connecting' | 'offline'), the same
// word the phone's tile dot is built from; a status check that timed out is "unknown" there, never "offline".
export function tvStatus(cam) {
  if (cam.statusUnknown) return { word: 'Status unknown', tone: 'unknown' };
  if (cam.statusLevel === 'live') return { word: 'Live', tone: 'live' };
  if (cam.statusLevel === 'offline') return { word: 'Offline', tone: 'offline' };
  return { word: 'Reconnecting', tone: 'connecting' };
}

function usePageVisible() {
  const [visible, setVisible] = useState(() => !document.hidden);
  useEffect(() => {
    const onChange = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);
  return visible;
}

// Keep the TV awake while the monitor is open: a TV's screensaver or sleep timer would otherwise blank the cameras a
// parent is watching. The same Screen Wake Lock approach as LiveMonitor.jsx (which keeps its own inline copy; not
// refactored here to leave the phone screen untouched). The lock is released by the browser whenever the page is
// hidden, so it is asked for again when the page becomes visible. Not available or refused (a WebView without the
// API, a power-saver mode): silently nothing, the TV then follows its own timeout. NOT verified on a real TV: if a TV's
// WebView lacks the API the shell would need a native keep-screen-on flag (a follow-up, noted in docs/mobile.md).
function useScreenWakeLock() {
  useEffect(() => {
    let lock = null;
    let cancelled = false;
    async function acquire() {
      if (!('wakeLock' in navigator)) return;
      try {
        const l = await navigator.wakeLock.request('screen');
        if (cancelled) l.release().catch(() => {});
        else lock = l;
      } catch {
        // refused: non-fatal
      }
    }
    acquire();
    const onVisible = () => { if (document.visibilityState === 'visible') acquire(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      if (lock) lock.release().catch(() => {});
    };
  }, []);
}

function TvTile({ camera, listening, focused, full, hidden, active, refreshNonce, register, onFocus, onClick }) {
  // 'live' (WebRTC) until the first connection attempt fails, then 'compat' (HLS): the same rule as CameraTile,
  // minus its manual override, which a TV has no way to offer.
  const [mode, setMode] = useState('live');
  const status = tvStatus(camera);
  const muted = !listening;
  return (
    <div
      ref={register}
      role="button"
      // Only the focused tile is in the Tab order: a keyboard Tab (desktop preview) lands on the same tile the
      // arrows would, never on a tile the page does not consider focused.
      tabIndex={focused ? 0 : -1}
      aria-pressed={listening}
      aria-label={`${camera.name}, ${status.word}`}
      // Not display:none or unmounted when another tile is full screen: the streams keep running behind it, so
      // leaving full screen is instant. `inert` keeps them out of reach meanwhile.
      inert={hidden || undefined}
      data-camera-id={camera.id}
      data-focused={focused ? 'true' : 'false'}
      data-listening={listening ? 'true' : 'false'}
      className={`tv-tile${focused ? ' tv-tile--focused' : ''}${full ? ' tv-tile--full' : ''}`}
      onFocus={onFocus}
      onClick={onClick}
    >
      <div className="tv-tile__video">
        {mode === 'live' ? (
          <WhepPlayer
            key={`live-${refreshNonce}`}
            mediamtxPath={camera.mediamtx_path}
            active={active}
            muted={muted}
            onFirstConnectFailed={() => setMode('compat')}
            cameraName={camera.name}
            statusUnknown={!!camera.statusUnknown}
          />
        ) : (
          <HlsPlayer
            key={`compat-${refreshNonce}`}
            // The sibling AAC path, as in CameraTile: MediaMTX's HLS cannot carry the camera's own audio codec.
            mediamtxPath={`${camera.mediamtx_path}-hls`}
            active={active}
            muted={muted}
            statusUnknown={!!camera.statusUnknown}
          />
        )}
        {/* Text AND icon: the state must not rest on a colour or a glyph a person across the room cannot make out. */}
        <div className={`tv-badge ${listening ? 'tv-badge--on' : 'tv-badge--off'}`} data-testid={`tv-badge-${camera.id}`}>
          {listening ? <Volume2 aria-hidden="true" /> : <VolumeX aria-hidden="true" />}
          <span>{listening ? 'Listening' : 'Muted'}</span>
        </div>
      </div>
      <div className="tv-tile__info">
        <span className="tv-tile__name">{camera.name}</span>
        <span className={`tv-tile__status tv-tile__status--${status.tone}`}>
          <span className="tv-tile__dot" aria-hidden="true" />
          {status.word}
        </span>
      </div>
    </div>
  );
}

export default function TvMonitor() {
  const { cameras = [], error, loaded, refresh } = useCameras() || {};
  const { settings } = useSettings() || {};
  const pageVisible = usePageVisible();
  useScreenWakeLock();

  // Disabled cameras have no stream and are not shown, as on the phone's live grid. The order is the server's.
  const visible = useMemo(() => cameras.filter((cam) => !cam.disabled), [cameras]);
  const listState = loadState({ loaded, error, count: visible.length });
  const showTiles = listState === 'ready' || listState === 'stale';

  // Which camera is listening: ONE id or none, in memory only (see the header comment).
  const [listeningId, setListeningId] = useState(null);
  const [fullId, setFullId] = useState(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [hintDismissed, setHintDismissed] = useState(readHintDismissed);
  const showHint = showTiles && !hintDismissed;

  // Focus is kept as a KEY (a camera id, or one of the two fixed targets), not an index, so a camera appearing,
  // disappearing or being disabled in the poll cannot silently move focus to a different camera.
  const [focusKey, setFocusKey] = useState(null);
  const targets = useMemo(
    () => [RECONNECT, ...(showTiles ? visible.map((cam) => cam.id) : []), ...(showHint ? [HINT] : [])],
    [visible, showTiles, showHint],
  );
  // Exactly one tile is focused at all times: the first camera until a key moves it; the Reconnect button when
  // there is no tile (empty, loading and failed screens) so it is always the thing OK acts on.
  const effectiveFocus = targets.includes(focusKey) ? focusKey : (showTiles ? visible[0].id : RECONNECT);

  const elements = useRef(new Map());
  const focusFromPage = useRef(false);
  // DOM focus that did not come from this page (a mouse click, a desktop Tab) becomes the page's focus; the page's own is already.
  const noteFocus = (key) => () => { if (!focusFromPage.current) setFocusKey(key); };
  const registerFor = (key) => (el) => {
    if (el) elements.current.set(key, el);
    else elements.current.delete(key);
  };

  // The last tile that had focus, so closing the hint bar (a target below the tiles) returns to it.
  const lastTileRef = useRef(null);
  if (effectiveFocus !== RECONNECT && effectiveFocus !== HINT) lastTileRef.current = effectiveFocus;

  useEffect(() => {
    const el = elements.current.get(effectiveFocus);
    if (!el) return;
    // The focus EVENT this raises must not be taken for the person moving focus (onFocus below): on the loading screen
    // the page focuses Reconnect, and recording that as a choice kept focus there after the tiles arrived.
    focusFromPage.current = true;
    try { el.focus({ preventScroll: true }); } finally { focusFromPage.current = false; }
    // The page scrolls by row (5+ cameras): keep the focused tile on screen.
    el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [effectiveFocus]);

  const reconnectAll = useCallback(() => {
    // Remounting every player rebuilds each stream from scratch (the same trick as the phone's pull-to-refresh);
    // the list is re-read too, a plain GET, so a failed or empty screen can recover from the same button.
    setRefreshNonce((n) => n + 1);
    refresh?.();
  }, [refresh]);

  const dismissHint = useCallback(() => {
    setHintDismissed(true);
    try { localStorage.setItem(HINT_STORAGE_KEY, '1'); } catch { /* render and behave the same without storage */ }
    setFocusKey(lastTileRef.current);
  }, []);

  // ---- Keys -----------------------------------------------------------------------------------------------
  // One window listener reading the latest state through a ref: it never has to be re-subscribed, and it sees
  // the key whichever element happens to hold DOM focus.
  const live = useRef({});
  live.current = { targets, effectiveFocus, fullId };
  const leftFullAt = useRef(0);
  const press = useRef(null); // { key, fired, timer }: an OK press in progress

  const leaveFull = useCallback(() => {
    leftFullAt.current = Date.now();
    setFullId(null);
  }, []);

  useEffect(() => {
    const isTile = (key) => key !== RECONNECT && key !== HINT;
    const toggleListening = (key) => setListeningId((id) => (id === key ? null : key));
    const toggleFull = (key) => setFullId((id) => {
      if (id === key) { leftFullAt.current = Date.now(); return null; }
      return key;
    });

    function onKeyDown(e) {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const { targets: list, effectiveFocus: at, fullId: full } = live.current;
      switch (e.key) {
        case 'ArrowUp': case 'ArrowDown': case 'ArrowLeft': case 'ArrowRight': {
          e.preventDefault(); // never scroll the page ourselves: scrolling follows focus
          if (full) return; // a full-screen tile has nowhere to move to
          const rects = list.map((key) => elements.current.get(key)?.getBoundingClientRect() ?? null);
          const from = list.indexOf(at);
          const to = nextFocus(rects, from, e.key.slice(5).toLowerCase());
          if (to !== from && list[to]) setFocusKey(list[to]);
          return;
        }
        case 'Enter': {
          // The Reconnect button and the hint bar are real buttons: Enter on them is the browser's own click.
          if (!isTile(at)) return;
          e.preventDefault();
          if (e.repeat) return; // a held key repeats; only the first keydown starts the timing
          clearTimeout(press.current?.timer);
          const entry = { key: at, fired: false, timer: null };
          entry.timer = setTimeout(() => {
            entry.fired = true;
            toggleFull(entry.key);
          }, LONG_PRESS_MS);
          press.current = entry;
          return;
        }
        case 'MediaPlayPause':
          if (isTile(at) && !e.repeat) { e.preventDefault(); toggleListening(at); }
          return;
        case 'ContextMenu': case 'Menu':
          e.preventDefault(); // the Menu key must not open the WebView's own context menu
          if (e.repeat) return;
          if (full) leaveFull();
          else if (isTile(at)) toggleFull(at);
          return;
        case 'Escape': case 'GoBack': case 'BrowserBack':
          // Only leaves full screen. At the top level Back is the app's (useHardwareBack exits); this page
          // must not swallow it.
          if (full) { e.preventDefault(); leaveFull(); }
          return;
        default:
      }
    }

    function onKeyUp(e) {
      if (e.key !== 'Enter' || !press.current) return;
      e.preventDefault();
      const entry = press.current;
      press.current = null;
      clearTimeout(entry.timer);
      // A press that reached the long-press time already opened full screen: it must not ALSO toggle sound.
      if (!entry.fired) toggleListening(entry.key);
    }

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      clearTimeout(press.current?.timer);
      press.current = null;
    };
  }, [leaveFull]);

  // The native Back button reaches the app as an event, not a key (lib/backInterceptor.js): offer it to this page
  // first, so Back in full screen closes full screen and only Back from the grid leaves the app.
  useEffect(() => setBackHandler(() => {
    if (live.current.fullId) { leaveFull(); return true; }
    return Date.now() - leftFullAt.current < BACK_ECHO_MS;
  }), [leaveFull]);

  // A camera that vanished (disabled, removed) cannot stay the one that is listening or full screen.
  const ids = useMemo(() => new Set(visible.map((cam) => cam.id)), [visible]);
  const listening = listeningId && ids.has(listeningId) ? listeningId : null;
  const full = fullId && ids.has(fullId) ? fullId : null;

  const cols = tvColumns(visible.length);
  const rows = tvRows(visible.length);

  return (
    <main className="tv-screen" aria-label="Live cameras">
      <header className="tv-bar">
        <h1 className="tv-bar__title">{settings?.app_name || 'Nightlight'}</h1>
        <button
          type="button"
          ref={registerFor(RECONNECT)}
          className="tv-btn"
          tabIndex={effectiveFocus === RECONNECT ? 0 : -1}
          data-focused={effectiveFocus === RECONNECT ? 'true' : 'false'}
          onFocus={noteFocus(RECONNECT)}
          onClick={reconnectAll}
        >
          <RefreshCw aria-hidden="true" /> Reconnect
        </button>
      </header>

      {listState === 'loading' && <p className="tv-message">Loading…</p>}

      {listState === 'error' && (
        <p className="tv-message tv-message--error" role="alert">
          <strong>Couldn’t load the cameras.</strong> {error} Check the connection, then choose Reconnect.
        </p>
      )}

      {listState === 'stale' && (
        <p className="tv-message tv-message--stale" role="alert">
          Couldn’t refresh the camera list. Showing what we had.
        </p>
      )}

      {listState === 'empty' && (
        <p className="tv-message">No cameras yet. Add one in the Nightlight app or website.</p>
      )}

      {showTiles && (
        <div className={`tv-grid${showHint ? ' tv-grid--hint' : ''}`} style={{ '--tv-cols': cols, '--tv-rows': Math.min(rows, 2) }}>
          {visible.map((cam) => (
            <TvTile
              key={cam.id}
              camera={cam}
              listening={listening === cam.id}
              focused={effectiveFocus === cam.id}
              full={full === cam.id}
              hidden={!!full && full !== cam.id}
              active={pageVisible}
              refreshNonce={refreshNonce}
              register={registerFor(cam.id)}
              onFocus={noteFocus(cam.id)}
              onClick={() => { setFocusKey(cam.id); setListeningId((id) => (id === cam.id ? null : cam.id)); }}
            />
          ))}
        </div>
      )}

      {showHint && (
        <button
          type="button"
          ref={registerFor(HINT)}
          className="tv-hint"
          tabIndex={effectiveFocus === HINT ? 0 : -1}
          data-focused={effectiveFocus === HINT ? 'true' : 'false'}
          onFocus={noteFocus(HINT)}
          onClick={dismissHint}
        >
          <span>OK: listen</span>
          <span>Hold OK: full screen</span>
          <span>Back: exit</span>
          <span className="tv-hint__hide"><X aria-hidden="true" /> Hide</span>
        </button>
      )}
    </main>
  );
}
