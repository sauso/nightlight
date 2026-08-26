// The camera-status poller. Two pieces of deliberate hysteresis live here and neither is obvious from
// reading a screen:
//   * a camera that isn't ready shows YELLOW ("connecting") for the first couple of polls and only
//     then RED ("offline"), so a normal quick reconnect doesn't flash alarm colours at a parent;
//   * after a sustained backend outage the whole page reloads on recovery, because this thing runs
//     unattended overnight and stale WebRTC sessions do not heal themselves.
// Both are exactly the kind of timing behaviour nobody re-verifies by hand.
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import { useContext } from 'react';

let CamerasProvider, CamerasContext;

// Serves /children and /cameras from mutable fixtures so a test can change what the next poll sees.
function stubApi({ kids = [], cams = [], fail = false } = {}) {
  const state = { kids, cams, fail };
  globalThis.fetch = vi.fn(async (url) => {
    if (state.fail) throw new Error('backend unreachable');
    const body = url.endsWith('/children') ? state.kids : state.cams;
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  });
  return state;
}

const cam = (id, ready) => ({ id, name: id, status: { ready } });

function Probe() {
  const ctx = useContext(CamerasContext);
  return (
    <div>
      <span data-testid="error">{ctx.error}</span>
      <span data-testid="kids">{ctx.kids.map((k) => k.name).join(',')}</span>
      <span data-testid="levels">{ctx.cameras.map((c) => `${c.id}:${c.statusLevel}`).join(' ')}</span>
    </div>
  );
}

const renderProvider = () =>
  render(
    <CamerasProvider>
      <Probe />
    </CamerasProvider>
  );

const levels = () => screen.getByTestId('levels').textContent;
const tick = async (ms = 15000) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

// jsdom's location.reload is non-configurable, so it can't be spied on directly - swap the whole
// location object for the duration of a test and put it back afterwards.
let realLocation = null;
function stubReload() {
  realLocation = window.location;
  const reload = vi.fn();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { href: realLocation.href, hash: realLocation.hash, reload },
  });
  return reload;
}

beforeEach(async () => {
  vi.resetModules();
  // Installed before mount: the 15s poll is scheduled at mount, and an interval created under real
  // timers is not controlled by fake ones afterwards.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  ({ CamerasProvider, CamerasContext } = await import('../../src/lib/CamerasContext.jsx'));
});

afterEach(() => {
  vi.useRealTimers();
  if (realLocation) {
    Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
    realLocation = null;
  }
});

describe('loading', () => {
  test('publishes children and cameras from the first poll', async () => {
    stubApi({ kids: [{ id: 'k1', name: 'Renz' }], cams: [cam('c1', true)] });
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('kids')).toHaveTextContent('Renz'));
    expect(levels()).toBe('c1:live');
  });

  test('re-polls every 15 seconds', async () => {
    const state = stubApi({ cams: [cam('c1', true)] });
    renderProvider();
    await waitFor(() => expect(levels()).toBe('c1:live'));

    state.cams = [cam('c1', true), cam('c2', true)];
    await tick();
    await waitFor(() => expect(levels()).toBe('c1:live c2:live'));
  });

  test('stops polling once unmounted', async () => {
    stubApi({ cams: [cam('c1', true)] });
    const { unmount } = renderProvider();
    await waitFor(() => expect(levels()).toBe('c1:live'));

    unmount();
    const after = globalThis.fetch.mock.calls.length;
    await tick(60000);
    expect(globalThis.fetch.mock.calls.length).toBe(after);
  });
});

describe('status hysteresis', () => {
  test('a not-ready camera shows "connecting" for the first two polls, then "offline"', async () => {
    stubApi({ cams: [cam('c1', false)] });
    renderProvider();

    // Poll 1 and 2: still yellow - a quick reconnect gets the benefit of the doubt.
    await waitFor(() => expect(levels()).toBe('c1:connecting'));
    await tick();
    await waitFor(() => expect(levels()).toBe('c1:connecting'));

    // Poll 3 (~30s down): now red.
    await tick();
    await waitFor(() => expect(levels()).toBe('c1:offline'));
  });

  test('stays offline while it stays down', async () => {
    stubApi({ cams: [cam('c1', false)] });
    renderProvider();
    await waitFor(() => expect(levels()).toBe('c1:connecting'));
    await tick();
    await tick();
    await tick();
    await waitFor(() => expect(levels()).toBe('c1:offline'));
  });

  test('recovering resets the count, so the next blip starts yellow again rather than red', async () => {
    const state = stubApi({ cams: [cam('c1', false)] });
    renderProvider();
    await waitFor(() => expect(levels()).toBe('c1:connecting'));
    await tick();
    await tick();
    await waitFor(() => expect(levels()).toBe('c1:offline'));

    state.cams = [cam('c1', true)];
    await tick();
    await waitFor(() => expect(levels()).toBe('c1:live'));

    // The reset is the point: without clearing the counter, one poll of downtime would jump
    // straight back to red.
    state.cams = [cam('c1', false)];
    await tick();
    await waitFor(() => expect(levels()).toBe('c1:connecting'));
  });

  test('tracks each camera independently', async () => {
    stubApi({ cams: [cam('c1', true), cam('c2', false)] });
    renderProvider();
    await waitFor(() => expect(levels()).toBe('c1:live c2:connecting'));
    await tick();
    await tick();
    await waitFor(() => expect(levels()).toBe('c1:live c2:offline'));
  });

  test('treats a camera with no status object at all as not ready', async () => {
    stubApi({ cams: [{ id: 'c1', name: 'c1' }] });
    renderProvider();
    await waitFor(() => expect(levels()).toBe('c1:connecting'));
  });
});

describe('backend outage', () => {
  test('surfaces the error message and keeps the last known cameras on screen', async () => {
    const state = stubApi({ cams: [cam('c1', true)] });
    renderProvider();
    await waitFor(() => expect(levels()).toBe('c1:live'));

    state.fail = true;
    await tick();
    await waitFor(() => expect(screen.getByTestId('error')).toHaveTextContent('backend unreachable'));
    // Blanking the tiles on one failed poll would be worse than showing stale ones.
    expect(levels()).toBe('c1:live');
  });

  test('clears the error once a poll succeeds again', async () => {
    const state = stubApi({ cams: [cam('c1', true)], fail: true });
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('error')).toHaveTextContent('backend unreachable'));

    state.fail = false;
    await tick();
    await waitFor(() => expect(screen.getByTestId('error')).toHaveTextContent(''));
  });

  test('does NOT reload the page after a short blip', async () => {
    const reload = stubReload();
    const state = stubApi({ cams: [cam('c1', true)] });
    renderProvider();
    await waitFor(() => expect(levels()).toBe('c1:live'));

    // Two consecutive failures is under the threshold: recovery must be silent.
    state.fail = true;
    await tick();
    await tick();
    state.fail = false;
    await tick();
    await waitFor(() => expect(screen.getByTestId('error')).toHaveTextContent(''));
    expect(reload).not.toHaveBeenCalled();
  });

  test('reloads the page when the backend returns after a sustained outage', async () => {
    const reload = stubReload();
    const state = stubApi({ cams: [cam('c1', true)] });
    renderProvider();
    await waitFor(() => expect(levels()).toBe('c1:live'));

    // Three consecutive failures (~45s) is a real outage, not a blip.
    state.fail = true;
    await tick();
    await tick();
    await tick();
    expect(reload).not.toHaveBeenCalled(); // still down - nothing to reload into yet

    state.fail = false;
    await tick();
    await waitFor(() => expect(reload).toHaveBeenCalled());
  });
});
