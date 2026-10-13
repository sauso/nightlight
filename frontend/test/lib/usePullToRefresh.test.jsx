// Pull-to-refresh and browser pinch-zoom (#562 bullet 3, fix round 1).
//
// WHY THIS FILE EXISTS. #562 gave browsers their pinch-zoom back. Zoomed in, a one-finger drag pans the
// VISUAL viewport and window.scrollY stays 0, so the hook's only "not at the top" check could not see it: a
// drag down while zoomed in was taken for a pull (its default prevented, which blocked the pan) and a long one
// refreshed the dashboard, remounting every player. The hook now ignores a gesture while
// window.visualViewport.scale > 1. These tests drive the hook's real listeners with synthetic touch events.
//
// ⚠️ NOT COVERED: a real browser's visualViewport and touch handling. jsdom has neither a visualViewport
// (stubbed here) nor Touch objects (a plain Event carries a `touches` list). The rest of pull-to-refresh is
// e2e's job, as liveMonitor.test.jsx says.
import { describe, test, expect, vi, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { usePullToRefresh } from '../../src/lib/usePullToRefresh.js';

function Harness({ onRefresh }) {
  const { containerRef, pull } = usePullToRefresh({ enabled: true, onRefresh });
  return <div ref={containerRef} data-testid="ptr" data-pull={pull} />;
}

const ORIGINAL_VV = Object.getOwnPropertyDescriptor(window, 'visualViewport');
function setVisualViewport(value) {
  Object.defineProperty(window, 'visualViewport', { configurable: true, writable: true, value });
}
afterEach(() => {
  if (ORIGINAL_VV) Object.defineProperty(window, 'visualViewport', ORIGINAL_VV);
  else delete window.visualViewport;
  vi.restoreAllMocks();
});

function touch(el, type, clientY) {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'touches', { value: clientY === undefined ? [] : [{ clientY }] });
  act(() => { el.dispatchEvent(ev); });
  return ev;
}
async function release(el) {
  const ev = new Event('touchend', { bubbles: true });
  Object.defineProperty(ev, 'touches', { value: [] });
  await act(async () => { el.dispatchEvent(ev); });
}
const pullOf = (el) => Number(el.getAttribute('data-pull'));

function mount() {
  const onRefresh = vi.fn().mockResolvedValue(undefined);
  render(<Harness onRefresh={onRefresh} />);
  return { el: screen.getByTestId('ptr'), onRefresh };
}

describe('#562 viewport pull-to-refresh: not zoomed in, unchanged', () => {
  for (const [label, vv] of [['scale 1', { scale: 1 }], ['no visualViewport (jsdom, old browsers)', undefined]]) {
    test(`#562 viewport pull-to-refresh: ${label}, a long drag down at the top is a pull and refreshes once`, async () => {
      setVisualViewport(vv);
      const { el, onRefresh } = mount();
      touch(el, 'touchstart', 100);
      const move = touch(el, 'touchmove', 300); // dy 200, halved by the resistance: 100 px, past the 70 px threshold
      expect(move.defaultPrevented).toBe(true);
      expect(pullOf(el)).toBe(100);
      await release(el);
      expect(onRefresh).toHaveBeenCalledTimes(1);
    });
  }
});

describe('#562 viewport pull-to-refresh: pinch-zoomed in, a drag is a pan', () => {
  test('#562 viewport pull-to-refresh: zoomed in (scale 1.5), no pull, no preventDefault, no refresh', async () => {
    setVisualViewport({ scale: 1.5 });
    const { el, onRefresh } = mount();
    touch(el, 'touchstart', 100);
    const move = touch(el, 'touchmove', 300);
    expect(move.defaultPrevented).toBe(false);
    expect(pullOf(el)).toBe(0);
    await release(el);
    expect(onRefresh).not.toHaveBeenCalled();
  });

  test('#562 viewport pull-to-refresh: zoomed in mid-gesture, the move check lets go and nothing refreshes', async () => {
    const vv = { scale: 1 };
    setVisualViewport(vv);
    const { el, onRefresh } = mount();
    touch(el, 'touchstart', 100);
    expect(touch(el, 'touchmove', 300).defaultPrevented).toBe(true);
    expect(pullOf(el)).toBe(100); // armed past the threshold...
    vv.scale = 2;
    const move = touch(el, 'touchmove', 310);
    expect(move.defaultPrevented).toBe(false);
    expect(pullOf(el)).toBe(0); // ...and disarmed by the zoom
    await release(el);
    expect(onRefresh).not.toHaveBeenCalled();
  });

  test('#562 viewport pull-to-refresh: a gesture that STARTS zoomed in stays ignored even if the zoom is back to 1 when the finger moves', async () => {
    // The start check owns the whole gesture: a pan that began zoomed in is never re-read as a pull.
    const vv = { scale: 1.5 };
    setVisualViewport(vv);
    const { el, onRefresh } = mount();
    touch(el, 'touchstart', 100);
    vv.scale = 1;
    const move = touch(el, 'touchmove', 300);
    expect(move.defaultPrevented).toBe(false);
    expect(pullOf(el)).toBe(0);
    await release(el);
    expect(onRefresh).not.toHaveBeenCalled();
  });
});
