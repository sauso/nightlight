// The TV screen (src/pages/TvMonitor.jsx): big live tiles for a remote control. Read-only; OK toggles listening.
//
// WHAT IS REAL HERE AND WHAT IS NOT. Real: the page, its focus and key handling, the camera list as the real context
// publishes it, the localStorage it must not use. STUBBED: the two players (WhepPlayer, HlsPlayer), which render a
// <div> exposing the props the page gives them (muted, active, the path) and a button that calls onFirstConnectFailed,
// because jsdom has no WebRTC and a real player would only prove the stub of the WebRTC. So "listening" is asserted as
// the `muted` prop every player receives, not as sound. And jsdom has no layout, so getBoundingClientRect is faked
// with a fixed grid (installLayout): the arrow-key logic itself is tested exhaustively in tvNav.test.js; here it only
// has to be WIRED to the page.
// NOT TESTED: a real remote, real overscan, audio output, decode on a TV (docs/mobile.md says so).
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, within, fireEvent, act } from '@testing-library/react';
import { forEachRole, renderAsAdmin, renderAsCaregiver } from './helpers/render.jsx';
import TvMonitor, { LONG_PRESS_MS, tvStatus } from '../src/pages/TvMonitor.jsx';
import { offerBackToScreen } from '../src/lib/backInterceptor.js';
import { api } from '../src/lib/api.js';

const h = vi.hoisted(() => ({ whepMounts: [], hlsMounts: [] }));

vi.mock('../src/components/WhepPlayer.jsx', async () => {
  const React = await import('react');
  return {
    default: function WhepStub(props) {
      React.useEffect(() => { h.whepMounts.push(props.mediamtxPath); }, []);
      return React.createElement(
        'div',
        { 'data-testid': `whep-${props.mediamtxPath}`, 'data-muted': String(props.muted), 'data-active': String(props.active) },
        React.createElement('button', { type: 'button', 'data-testid': `fail-${props.mediamtxPath}`, onClick: (e) => { e.stopPropagation(); props.onFirstConnectFailed(); } }),
      );
    },
  };
});
vi.mock('../src/components/HlsPlayer.jsx', async () => {
  const React = await import('react');
  return {
    default: function HlsStub(props) {
      React.useEffect(() => { h.hlsMounts.push(props.mediamtxPath); }, []);
      return React.createElement('div', { 'data-testid': `hls-${props.mediamtxPath}`, 'data-muted': String(props.muted), 'data-active': String(props.active) });
    },
  };
});

const CAMS = [
  { id: 'c1', name: 'Nursery', mediamtx_path: 'p1', statusLevel: 'live' },
  { id: 'c2', name: 'Playroom', mediamtx_path: 'p2', statusLevel: 'offline' }, // an offline tile IN THE MIDDLE
  { id: 'c3', name: 'Garden', mediamtx_path: 'p3', statusLevel: 'connecting' },
  { id: 'c4', name: 'Spare room', mediamtx_path: 'p4', disabled: 1 },
];
const cams = (n) => Array.from({ length: n }, (_, i) => ({ id: `k${i + 1}`, name: `Camera ${i + 1}`, mediamtx_path: `q${i + 1}`, statusLevel: 'live' }));

// A fixed layout for jsdom: tiles in a grid of --tv-cols columns, the Reconnect button top right, the hint bar at the bottom.
function installLayout() {
  const box = (l, t, w, hh) => ({ left: l, top: t, right: l + w, bottom: t + hh, width: w, height: hh, x: l, y: t });
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function rectOf() {
    if (this.classList.contains('tv-btn')) return box(1500, 0, 400, 60);
    if (this.classList.contains('tv-hint')) return box(0, 1000, 1920, 80);
    if (this.classList.contains('tv-tile')) {
      const index = [...document.querySelectorAll('.tv-tile')].indexOf(this);
      const columns = Number(this.parentElement.style.getPropertyValue('--tv-cols')) || 1;
      return box(100 + (index % columns) * 600, 100 + Math.floor(index / columns) * 400, 560, 315);
    }
    return box(0, 0, 0, 0);
  });
}

const press = (key, init = {}) => fireEvent.keyDown(window, { key, ...init });
const release = (key) => fireEvent.keyUp(window, { key });
const ok = () => { press('Enter'); release('Enter'); };
const tile = (id) => document.querySelector(`[data-camera-id="${id}"]`);
const muted = (path) => screen.getByTestId(`whep-${path}`).dataset.muted;
const reconnectButton = () => screen.getByRole('button', { name: 'Reconnect' });
const mount = (opts = {}, render = renderAsAdmin) => render(<TvMonitor />, { cameras: CAMS, ...opts });
// Without the first-launch hint bar (it is one more arrow-key target below the last row), for tests that walk the grid.
const mountQuiet = (opts, render) => {
  localStorage.setItem('nightlight_tv_hint_dismissed', '1');
  return mount(opts, render);
};

beforeEach(() => {
  h.whepMounts.length = 0;
  h.hlsMounts.length = 0;
  installLayout();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('what the screen shows', () => {
  test('★ renders as an admin AND as a caregiver: one tile per enabled camera, name and status in words', async () => {
    await forEachRole((_name, who) => {
      const render = who.role === 'admin' ? renderAsAdmin : renderAsCaregiver;
      const { unmount } = render(<TvMonitor />, { cameras: CAMS });
      expect(document.querySelectorAll('.tv-tile')).toHaveLength(3);
      expect(screen.queryByText('Spare room')).toBeNull(); // a disabled camera has no stream and no tile
      expect(within(tile('c1')).getByText('Live')).toBeTruthy();
      expect(within(tile('c2')).getByText('Offline')).toBeTruthy();
      expect(within(tile('c3')).getByText('Reconnecting')).toBeTruthy();
      expect(reconnectButton()).toBeTruthy();
      unmount();
    });
  });

  test('★ the status line is words, and "status unknown" is not "offline"', () => {
    expect(tvStatus({ statusLevel: 'live' }).word).toBe('Live');
    expect(tvStatus({ statusLevel: 'offline' }).word).toBe('Offline');
    expect(tvStatus({ statusLevel: 'connecting' }).word).toBe('Reconnecting');
    expect(tvStatus({})).toEqual({ word: 'Reconnecting', tone: 'connecting' });
    // A status check that timed out says nothing about the camera; the same rule the phone's tile follows.
    expect(tvStatus({ statusLevel: 'offline', statusUnknown: true }).word).toBe('Status unknown');
  });

  test('the first tile is focused on load, and exactly one tile is', () => {
    mount();
    expect(document.activeElement).toBe(tile('c1'));
    expect([...document.querySelectorAll('.tv-tile')].filter((el) => el.dataset.focused === 'true')).toEqual([tile('c1')]);
  });

  test('★ the first tile is focused when the cameras ARRIVE: the Reconnect button the loading screen focused does not keep focus', () => {
    const { rerenderWith } = mount({ cameras: [], camerasLoaded: false });
    expect(document.activeElement).toBe(reconnectButton());
    rerenderWith({ cameras: CAMS, camerasLoaded: true });
    expect(document.activeElement).toBe(tile('c1'));
    expect(tile('c1').dataset.focused).toBe('true');
  });

  test('the grid has the columns lib/tvLayout.js gives: 1, 2, 2, 2, 3, 3 for 1, 2, 3, 4, 5, 7 cameras', () => {
    const want = { 1: '1', 2: '2', 3: '2', 4: '2', 5: '3', 7: '3' };
    for (const [count, columns] of Object.entries(want)) {
      const { unmount } = mount({ cameras: cams(Number(count)) });
      expect(document.querySelector('.tv-grid').style.getPropertyValue('--tv-cols'), `${count} cameras`).toBe(columns);
      expect(document.querySelectorAll('.tv-tile')).toHaveLength(Number(count));
      unmount();
    }
  });

  test('a 7-camera layout is two visible rows tall at most (--tv-rows), because a longer list scrolls', () => {
    mount({ cameras: cams(7) });
    expect(document.querySelector('.tv-grid').style.getPropertyValue('--tv-rows')).toBe('2');
  });
});

describe('★ loading, failed and empty are three different screens', () => {
  const messages = {
    loading: /^Loading…$/,
    failed: /Couldn’t load the cameras/,
    empty: /No cameras yet\. Add one in the Nightlight app or website\./,
  };
  const states = {
    loading: { cameras: [], camerasLoaded: false },
    failed: { cameras: [], camerasLoaded: false, error: 'Network down' },
    empty: { cameras: [], camerasLoaded: true },
  };

  test.each(Object.keys(states))('%s says its own thing and none of the others', (state) => {
    mount(states[state]);
    for (const [name, text] of Object.entries(messages)) {
      if (name === state) expect(screen.getByText(text)).toBeTruthy();
      else expect(screen.queryByText(text), `${state} must not show the ${name} text`).toBeNull();
    }
    expect(document.querySelectorAll('.tv-tile')).toHaveLength(0);
    // The failure is announced and carries the cause; loading and empty are not alerts.
    if (state === 'failed') {
      expect(screen.getByRole('alert').textContent).toMatch(/Network down/);
    } else {
      expect(screen.queryByRole('alert')).toBeNull();
    }
  });

  test.each(Object.keys(states))('%s still has a focusable Reconnect button, and it is the focused thing', (state) => {
    mount(states[state]);
    expect(document.activeElement).toBe(reconnectButton());
  });

  test('"every camera is switched off" is the empty screen, not a blank grid', () => {
    mount({ cameras: [CAMS[3]] });
    expect(screen.getByText(messages.empty)).toBeTruthy();
  });

  test('a failed refresh after a good load keeps the tiles and says the list may be out of date', () => {
    mount({ error: 'Network down' });
    expect(document.querySelectorAll('.tv-tile')).toHaveLength(3);
    expect(screen.getByRole('alert').textContent).toMatch(/Showing what we had/);
  });
});

describe('★ OK toggles listening: the listening tile is the ONLY unmuted one', () => {
  test('toggling tile A, then tile B: only B listens; pressing B again mutes everything', async () => {
    mount();
    // Every tile starts muted.
    expect(['p1', 'p2', 'p3'].map(muted)).toEqual(['true', 'true', 'true']);

    ok(); // tile A (c1)
    expect(['p1', 'p2', 'p3'].map(muted)).toEqual(['false', 'true', 'true']);
    expect(within(tile('c1')).getByText('Listening')).toBeTruthy();
    expect(tile('c1').getAttribute('aria-pressed')).toBe('true');

    press('ArrowRight'); // tile B (c2), which is OFFLINE: still focusable
    expect(document.activeElement).toBe(tile('c2'));
    ok();
    expect(['p1', 'p2', 'p3'].map(muted)).toEqual(['true', 'false', 'true']); // A is muted again: only B listens
    expect(within(tile('c1')).getByText('Muted')).toBeTruthy();
    expect(within(tile('c2')).getByText('Listening')).toBeTruthy();
    expect(document.querySelectorAll('.tv-badge--on')).toHaveLength(1);

    ok(); // again on B
    expect(['p1', 'p2', 'p3'].map(muted)).toEqual(['true', 'true', 'true']);
    expect(document.querySelectorAll('.tv-badge--on')).toHaveLength(0);
  });

  test('MediaPlayPause does the same as OK, for the focused tile', () => {
    mount();
    press('ArrowRight');
    press('MediaPlayPause');
    expect(['p1', 'p2', 'p3'].map(muted)).toEqual(['true', 'false', 'true']);
    press('MediaPlayPause');
    expect(muted('p2')).toBe('true');
  });

  test('the badge says Listening or Muted in WORDS, not only by icon or colour', () => {
    mount();
    for (const id of ['c1', 'c2', 'c3']) expect(within(tile(id)).getByText('Muted')).toBeTruthy();
    ok();
    expect(within(tile('c1')).getByText('Listening')).toBeTruthy();
    expect(within(tile('c1')).queryByText('Muted')).toBeNull();
  });

  test('★ the TV ALWAYS starts muted: a persisted "unmuted" from anywhere is ignored', () => {
    // The phone's tile persists its own sound state in localStorage (nightlight_muted_<id>); a stale value, in the
    // formats the phone has used, and a few plausible names a TV version might have used, must not unmute anything.
    for (const store of [localStorage, sessionStorage]) {
      store.setItem('nightlight_muted_c1', 'on');
      store.setItem('nightlight_muted_c2', 'false');
      store.setItem('nightlight_muted_c3', 'bg');
      store.setItem('nightlight_tv_listening', 'c1');
      store.setItem('nightlight_tv_listening_c1', 'true');
      store.setItem('nightlight_listening', 'c2');
    }
    mount();
    expect(['p1', 'p2', 'p3'].map(muted)).toEqual(['true', 'true', 'true']);
    expect(document.querySelectorAll('.tv-badge--on')).toHaveLength(0);
  });

  test('★ listening is held in memory ONLY: nothing is written to storage when it changes', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    mount();
    ok();
    press('ArrowRight');
    ok();
    expect(setItem).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  test('a listening camera that disappears (disabled or removed) leaves nothing listening', () => {
    const { rerenderWith } = mount();
    ok();
    expect(muted('p1')).toBe('false');
    rerenderWith({ cameras: CAMS.slice(1) });
    expect(['p2', 'p3'].map(muted)).toEqual(['true', 'true']);
    expect(document.querySelectorAll('.tv-badge--on')).toHaveLength(0);
  });

  test('clicking a tile (a mouse, in a desktop preview) toggles it the same way', () => {
    mount();
    fireEvent.click(tile('c3'));
    expect(['p1', 'p2', 'p3'].map(muted)).toEqual(['true', 'true', 'false']);
    expect(document.activeElement).toBe(tile('c3'));
  });
});

describe('moving focus with the arrow keys', () => {
  test('an OFFLINE tile in the middle is reachable and does not trap focus, in a row and in a column', () => {
    mount();
    // c1 c2 / c3 in two columns: c2 is the offline one.
    press('ArrowRight');
    expect(document.activeElement).toBe(tile('c2'));
    press('ArrowLeft');
    expect(document.activeElement).toBe(tile('c1'));
    press('ArrowDown');
    expect(document.activeElement).toBe(tile('c3'));
    press('ArrowUp');
    press('ArrowRight');
    press('ArrowDown'); // c2 -> c3 (ragged row: the lone tile is under column one)
    expect(document.activeElement).toBe(tile('c3'));
  });

  test('no wrap-around: the arrows stop at the edges', () => {
    mountQuiet();
    press('ArrowLeft');
    expect(document.activeElement).toBe(tile('c1'));
    press('ArrowDown');
    press('ArrowDown');
    expect(document.activeElement).toBe(tile('c3'));
    press('ArrowRight');
    expect(document.activeElement).toBe(tile('c3'));
  });

  test('arrow keys are consumed (the page never scrolls by itself)', () => {
    mount();
    expect(press('ArrowDown')).toBe(false); // fireEvent returns false when preventDefault was called
  });

  test('Up from the first row reaches Reconnect, Down returns to a tile; OK on it does NOT toggle a tile', () => {
    mount();
    press('ArrowUp');
    expect(document.activeElement).toBe(reconnectButton());
    expect(document.querySelectorAll('.tv-tile[data-focused="true"]')).toHaveLength(0);
    ok(); // a real <button>: the browser's own click does the work; the page must not also toggle a tile
    expect(document.querySelectorAll('.tv-badge--on')).toHaveLength(0);
    press('ArrowDown');
    expect(document.querySelector('.tv-tile[data-focused="true"]')).not.toBeNull();
  });

  test('★ focus follows the CAMERA, not the position: a reorder or a camera appearing does not move it', () => {
    const { rerenderWith } = mount();
    press('ArrowRight');
    expect(document.activeElement).toBe(tile('c2'));
    rerenderWith({ cameras: [CAMS[2], CAMS[1], CAMS[0], CAMS[3]] }); // c2 is now in the middle of a new order
    expect(tile('c2').dataset.focused).toBe('true');
    expect(tile('c1').dataset.focused).toBe('false');
  });

  test('when the focused camera disappears, focus falls to the first tile', () => {
    const { rerenderWith } = mount();
    press('ArrowRight');
    rerenderWith({ cameras: [CAMS[0], CAMS[2]] });
    expect(document.activeElement).toBe(tile('c1'));
  });
});

describe('★ full screen: Menu or a long OK press; Back and Escape leave', () => {
  test('a SHORT press toggles sound and never opens full screen, even long after', () => {
    vi.useFakeTimers();
    mount();
    press('Enter');
    act(() => { vi.advanceTimersByTime(599); });
    release('Enter');
    expect(muted('p1')).toBe('false');
    act(() => { vi.advanceTimersByTime(5000); }); // the pending long-press timer must have been cleared by the release
    expect(tile('c1').className).not.toMatch(/tv-tile--full/);
  });

  test('★ a LONG press opens full screen and does NOT also toggle sound', () => {
    vi.useFakeTimers();
    mount();
    press('Enter');
    act(() => { vi.advanceTimersByTime(599); });
    expect(tile('c1').className).not.toMatch(/tv-tile--full/); // one millisecond short
    press('Enter', { repeat: true }); // a held key repeats; the repeats must not restart the timing
    act(() => { vi.advanceTimersByTime(1); });
    expect(tile('c1').className).toMatch(/tv-tile--full/);
    release('Enter');
    expect(muted('p1')).toBe('true'); // not toggled by the same press
    expect(document.querySelectorAll('.tv-badge--on')).toHaveLength(0);
  });

  test('LONG_PRESS_MS is the 600 ms the brief fixed', () => {
    expect(LONG_PRESS_MS).toBe(600);
  });

  test('the Menu key opens the focused tile full screen; the other tiles are put out of reach', () => {
    mount();
    press('ArrowRight');
    expect(press('ContextMenu')).toBe(false); // the WebView's own context menu must not open
    expect(tile('c2').className).toMatch(/tv-tile--full/);
    expect(tile('c1').hasAttribute('inert')).toBe(true);
    expect(tile('c2').hasAttribute('inert')).toBe(false);
    press('ContextMenu'); // Menu again leaves
    expect(tile('c2').className).not.toMatch(/tv-tile--full/);
    expect(tile('c1').hasAttribute('inert')).toBe(false);
  });

  test('★ Escape leaves full screen (and is not swallowed when there is no full screen)', () => {
    mount();
    press('ContextMenu');
    expect(tile('c1').className).toMatch(/tv-tile--full/);
    expect(press('Escape')).toBe(false);
    expect(tile('c1').className).not.toMatch(/tv-tile--full/);
    expect(press('Escape')).toBe(true); // top level: the page does not consume it
  });

  test('★ the shell\'s Back event (offerBackToScreen) leaves full screen; at the top level it is NOT taken', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    mount();
    expect(offerBackToScreen()).toBe(false); // top level: useHardwareBack goes on to exit the app
    act(() => { press('ContextMenu'); });
    expect(tile('c1').className).toMatch(/tv-tile--full/);
    let handled;
    act(() => { handled = offerBackToScreen(); });
    expect(handled).toBe(true);
    expect(tile('c1').className).not.toMatch(/tv-tile--full/);
    // The same press reported twice (a key AND the shell's event) must not exit the app on the second report...
    expect(offerBackToScreen()).toBe(true);
    // ...but a genuine Back a moment later is the app's again.
    act(() => { vi.advanceTimersByTime(500); });
    expect(offerBackToScreen()).toBe(false);
  });

  test('inside full screen OK still toggles sound for that tile, and the arrows move nothing', () => {
    mount();
    press('ContextMenu');
    ok();
    expect(muted('p1')).toBe('false');
    press('ArrowRight');
    expect(document.activeElement).toBe(tile('c1'));
    expect(tile('c1').className).toMatch(/tv-tile--full/);
  });

  test('a long press inside full screen leaves it', () => {
    vi.useFakeTimers();
    mount();
    press('ContextMenu');
    press('Enter');
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS); });
    release('Enter');
    expect(tile('c1').className).not.toMatch(/tv-tile--full/);
  });
});

describe('the Reconnect button', () => {
  test('★ reconnects EVERY tile (each player is mounted afresh), re-reads the list, and keeps what is listening', async () => {
    const { user, camerasValue } = mount();
    expect(h.whepMounts).toEqual(['p1', 'p2', 'p3']);
    ok(); // c1 listening
    press('ArrowUp');
    expect(document.activeElement).toBe(reconnectButton());
    await user.keyboard('{Enter}');
    expect([...h.whepMounts].sort()).toEqual(['p1', 'p1', 'p2', 'p2', 'p3', 'p3']);
    expect(camerasValue.refresh).toHaveBeenCalledTimes(1);
    expect(muted('p1')).toBe('false');
    expect(muted('p2')).toBe('true');
  });

  test('on the failed screen it is the retry: it asks for the list again', async () => {
    const { user, camerasValue } = mount({ cameras: [], camerasLoaded: false, error: 'Network down' });
    await user.keyboard('{Enter}');
    expect(camerasValue.refresh).toHaveBeenCalledTimes(1);
  });
});

describe('keeping the TV awake', () => {
  test('★ asks for a screen wake lock while the screen is open and releases it when it is left', async () => {
    const release = vi.fn().mockResolvedValue(undefined);
    const request = vi.fn().mockResolvedValue({ release });
    Object.defineProperty(navigator, 'wakeLock', { value: { request }, configurable: true });
    try {
      const view = mount();
      await act(async () => {});
      expect(request).toHaveBeenCalledWith('screen');
      expect(release).not.toHaveBeenCalled();
      view.unmount();
      expect(release).toHaveBeenCalledTimes(1);
    } finally {
      delete navigator.wakeLock;
    }
  });

  test('a WebView without the Wake Lock API, or one that refuses it, still shows the tiles', async () => {
    mount(); // jsdom has no navigator.wakeLock
    expect(tile('c1')).not.toBeNull();
    Object.defineProperty(navigator, 'wakeLock', { value: { request: vi.fn().mockRejectedValue(new Error('refused')) }, configurable: true });
    try {
      document.body.innerHTML = '';
      mount();
      await act(async () => {});
      expect(tile('c1')).not.toBeNull();
    } finally {
      delete navigator.wakeLock;
    }
  });
});

describe('the key hint', () => {
  test('shows the three keys on a first launch, below the tiles', () => {
    mount();
    const hint = screen.getByRole('button', { name: /OK: listen/ });
    expect(hint.textContent).toContain('OK: listen');
    expect(hint.textContent).toContain('Hold OK: full screen');
    expect(hint.textContent).toContain('Back: exit');
  });

  test('★ it is in the arrow-key grid: Down from the last row reaches it, OK dismisses it, focus returns to the tile', async () => {
    const { user, unmount } = mount();
    press('ArrowDown'); // c3, the last row
    press('ArrowDown'); // the hint bar
    const hint = screen.getByRole('button', { name: /OK: listen/ });
    expect(document.activeElement).toBe(hint);
    await user.keyboard('{Enter}');
    expect(screen.queryByRole('button', { name: /OK: listen/ })).toBeNull();
    expect(localStorage.getItem('nightlight_tv_hint_dismissed')).toBe('1');
    expect(document.activeElement).toBe(tile('c3'));
    // ...and a later launch does not show it again.
    unmount();
    mount();
    expect(screen.queryByRole('button', { name: /OK: listen/ })).toBeNull();
  });

  test('★ it works without storage (private mode): shown, and it still dismisses for this launch', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    const { user } = mount();
    press('ArrowDown');
    press('ArrowDown');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /OK: listen/ }));
    await user.keyboard('{Enter}');
    expect(screen.queryByRole('button', { name: /OK: listen/ })).toBeNull();
  });

  test('it is not shown on the loading, failed or empty screens (no tiles to hint about)', () => {
    mount({ cameras: [], camerasLoaded: true });
    expect(screen.queryByRole('button', { name: /OK: listen/ })).toBeNull();
  });
});

describe('players', () => {
  test('★ each camera starts on WebRTC and falls back to HLS (its "-hls" path) after a first failed connection, as CameraTile does', () => {
    mount();
    expect(screen.getByTestId('whep-p1')).toBeTruthy();
    fireEvent.click(screen.getByTestId('fail-p1'));
    expect(screen.queryByTestId('whep-p1')).toBeNull();
    expect(screen.getByTestId('hls-p1-hls').dataset.muted).toBe('true');
    expect(screen.getByTestId('whep-p2')).toBeTruthy(); // only that tile switched
    // Listening still reaches the HLS player.
    ok();
    expect(screen.getByTestId('hls-p1-hls').dataset.muted).toBe('false');
  });

  test('streams run only while the page is visible: a hidden page (Home pressed) tears them down', () => {
    mount();
    expect(screen.getByTestId('whep-p1').dataset.active).toBe('true');
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    try {
      act(() => { document.dispatchEvent(new Event('visibilitychange')); });
      expect(['p1', 'p2', 'p3'].map((p) => screen.getByTestId(`whep-${p}`).dataset.active)).toEqual(['false', 'false', 'false']);
    } finally {
      delete document.hidden;
    }
  });
});

describe('★ read-only: no write request is ever issued', () => {
  test('a fake api and fetch that fail the test on any write, through every interaction the screen has', async () => {
    const writes = [];
    for (const method of ['post', 'put', 'patch', 'del']) {
      vi.spyOn(api, method).mockImplementation(() => { writes.push(method); throw new Error(`write: api.${method}`); });
    }
    const fetchSpy = vi.fn(() => { writes.push('fetch'); throw new Error('fetch'); });
    vi.stubGlobal('fetch', fetchSpy);

    const { user } = mount();
    ok(); // listen
    press('ArrowRight');
    ok();
    press('ContextMenu'); // full screen
    press('Escape');
    press('ArrowUp');
    await user.keyboard('{Enter}'); // Reconnect
    press('ArrowDown');
    press('ArrowDown');
    press('ArrowDown');
    await user.keyboard('{Enter}'); // dismiss the hint
    fireEvent.click(tile('c3'));
    expect(writes).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('the page offers no settings, history, sleep, alert, talk, picture-in-picture or reorder controls', () => {
    mount();
    const names = screen.getAllByRole('button').map((b) => b.textContent + ' ' + (b.getAttribute('aria-label') || ''));
    expect(names.join('|')).not.toMatch(/settings|sleep|history|alert|talk|picture|reorder|drag/i);
    expect(document.querySelector('a')).toBeNull(); // nothing to navigate to
  });
});
