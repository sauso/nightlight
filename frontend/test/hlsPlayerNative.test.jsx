// HlsPlayer's NATIVE-HLS branch (Safari, and iOS WebKit generally): the <video> plays the playlist itself and
// the component only listens for `loadedmetadata` (seek to the live edge) and `error` (retry) (#560).
//
// ★ THE DEFECT. The effect that wires this up re-runs on every reconnect (each 5 s retry while in the error
// state, each stall reconnect, a path change) but the <video> element is the SAME node each time, and the
// listeners were anonymous arrow functions the cleanup could not remove. Every reconnect added another pair,
// so after N reconnects one `loadedmetadata` ran the seek-and-setState N+1 times, and a long overnight
// session on a flaky camera accumulated them without bound.
//
// WHAT THIS PROVES (against a stubbed `canPlayType`, which is the only way jsdom reaches this branch):
//   * the number of live `loadedmetadata`/`error` listeners on the element does not grow across five
//     error -> 5 s -> reconnect cycles;
//   * a single `loadedmetadata` runs the seek handler once, not once per past reconnect (counted by reads of
//     `video.seekable`, which the handler does exactly once per call);
//   * the listeners are already gone when the teardown calls `video.load()` (which browsers may answer with an
//     `error` event that must not reach a stale handler).
// WHAT IT DOES NOT PROVE: real Safari playback, or the hls.js/MediaSource branch (not reachable in jsdom; it
// stays on the coverage exclude list in vite.config.js for that reason). Not run on a phone.
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, waitFor } from '@testing-library/react';
import HlsPlayer from '../src/components/HlsPlayer.jsx';

vi.mock('hls.js', () => {
  class FakeHls {
    static instances = [];
    static Events = { MANIFEST_PARSED: 'manifest', ERROR: 'error' };
    static isSupported() { return true; }
    constructor() { this.handlers = {}; FakeHls.instances.push(this); }
    loadSource() {}
    attachMedia() {}
    on(event, callback) { this.handlers[event] = callback; }
    destroy() {}
  }
  return { default: FakeHls };
});

const WATCHED = ['loadedmetadata', 'error'];

// Every listener currently attached to a <video>, by type. Tracks add/remove on EventTarget itself because
// that is where the component's calls land; same-function re-adds are deduplicated the way the DOM does.
let live;
let loadSnapshots;

function installTracker() {
  live = [];
  loadSnapshots = [];
  const realAdd = EventTarget.prototype.addEventListener;
  const realRemove = EventTarget.prototype.removeEventListener;
  vi.spyOn(EventTarget.prototype, 'addEventListener').mockImplementation(function add(type, fn, opts) {
    if (this instanceof HTMLVideoElement && WATCHED.includes(type)
        && !live.some((l) => l.target === this && l.type === type && l.fn === fn)) {
      live.push({ target: this, type, fn });
    }
    return realAdd.call(this, type, fn, opts);
  });
  vi.spyOn(EventTarget.prototype, 'removeEventListener').mockImplementation(function remove(type, fn, opts) {
    live = live.filter((l) => !(l.target === this && l.type === type && l.fn === fn));
    return realRemove.call(this, type, fn, opts);
  });
}
const net = (type) => live.filter((l) => l.type === type).length;

beforeEach(() => {
  vi.useFakeTimers();
  // 'maybe' is what Safari answers for application/vnd.apple.mpegurl; jsdom answers '' for everything.
  vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('maybe');
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  // Record how many of the component's listeners are still attached at the instant load() is called.
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {
    loadSnapshots.push({ error: net('error'), loadedmetadata: net('loadedmetadata') });
  });
  installTracker();
});

afterEach(() => {
  delete HTMLVideoElement.prototype.requestVideoFrameCallback;
  delete HTMLVideoElement.prototype.cancelVideoFrameCallback;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test('picture check waits for successive presented frames and ignores an old test id', () => {
  const callbacks = [];
  HTMLVideoElement.prototype.requestVideoFrameCallback = vi.fn((callback) => { callbacks.push(callback); return callbacks.length; });
  HTMLVideoElement.prototype.cancelVideoFrameCallback = vi.fn();
  const onFrames = vi.fn();
  const view = render(<HlsPlayer mediamtxPath="camera" active muted frameTestId="first" onFrames={onFrames} />);
  const video = view.container.querySelector('video');
  act(() => { video.dispatchEvent(new Event('loadedmetadata')); });
  expect(onFrames).not.toHaveBeenCalled();
  const stale = callbacks.shift();
  view.rerender(<HlsPlayer mediamtxPath="camera" active muted frameTestId="second" onFrames={onFrames} />);
  act(() => { stale(0, { presentedFrames: 1 }); stale(1, { presentedFrames: 2 }); });
  expect(onFrames).not.toHaveBeenCalled();
  act(() => { callbacks.shift()(2, { presentedFrames: 3 }); });
  expect(onFrames).not.toHaveBeenCalled();
  act(() => { callbacks.shift()(3, { presentedFrames: 4 }); });
  expect(onFrames).toHaveBeenCalledExactlyOnceWith('second');
});

test('fallback ignores the native HLS metadata seek and needs later time progress', () => {
  const onFrames = vi.fn();
  const view = render(<HlsPlayer mediamtxPath="camera" active muted frameTestId="test" onFrames={onFrames} />);
  const video = view.container.querySelector('video');
  act(() => { video.dispatchEvent(new Event('loadedmetadata')); });
  act(() => {
    video.dispatchEvent(new Event('loadedmetadata'));
    video.currentTime = 40;
    video.dispatchEvent(new Event('seeking'));
    video.dispatchEvent(new Event('seeked'));
    vi.advanceTimersByTime(1500);
  });
  expect(onFrames).not.toHaveBeenCalled();
  act(() => { video.currentTime = 41; vi.advanceTimersByTime(500); });
  expect(onFrames).not.toHaveBeenCalled();
  act(() => { video.currentTime = 42; vi.advanceTimersByTime(500); });
  expect(onFrames).toHaveBeenCalledExactlyOnceWith('test');
});

test('an HLS playlist alone does not pass the picture check', async () => {
  vi.useRealTimers();
  HTMLMediaElement.prototype.canPlayType.mockReturnValue('');
  const { default: FakeHls } = await import('hls.js');
  FakeHls.instances.length = 0;
  const callbacks = [];
  HTMLVideoElement.prototype.requestVideoFrameCallback = vi.fn((callback) => { callbacks.push(callback); return callbacks.length; });
  const onFrames = vi.fn();
  render(<HlsPlayer mediamtxPath="camera" active muted frameTestId="test" onFrames={onFrames} />);
  await waitFor(() => expect(FakeHls.instances).toHaveLength(1));
  act(() => { FakeHls.instances[0].handlers.manifest(); });
  expect(onFrames).not.toHaveBeenCalled();
  act(() => { callbacks.shift()(0, { presentedFrames: 1 }); });
  expect(onFrames).not.toHaveBeenCalled();
  act(() => { callbacks.shift()(1, { presentedFrames: 2 }); });
  expect(onFrames).toHaveBeenCalledExactlyOnceWith('test');
});

// React itself attaches its own listeners to a <video> for the media events; they are the same on every
// <video> and never removed. Measure them on a bare element so the component's own pair can be isolated.
function reactOwnBaseline() {
  const probe = render(<video />);
  const base = { error: net('error'), loadedmetadata: net('loadedmetadata') };
  probe.unmount();
  live = [];
  return base;
}

describe('★★ HlsPlayer native path does not leak listeners across reconnects (#560)', () => {
  test('★ listener count is flat across five error -> retry -> reconnect cycles, and one loadedmetadata seeks once', () => {
    const base = reactOwnBaseline();
    const { container } = render(<HlsPlayer mediamtxPath="cam-1" active muted />);
    const video = container.querySelector('video');

    // The component's own pair, once. (If canPlayType were not honoured this would be the hls.js branch.)
    expect(video.getAttribute('src')).toContain('/hls/cam-1/index.m3u8');
    const afterMount = { error: net('error'), loadedmetadata: net('loadedmetadata') };
    expect(afterMount.error).toBe(base.error + 1);
    expect(afterMount.loadedmetadata).toBe(base.loadedmetadata + 1);

    for (let i = 0; i < 5; i += 1) {
      act(() => { video.dispatchEvent(new Event('error')); });
      expect(container.textContent).toContain('No signal');
      // 5 s in the error state is the component's own retry timer.
      act(() => { vi.advanceTimersByTime(5000); });
      expect(container.textContent).toContain('Connecting');
    }

    // Without the fix: base + 6 each (one pair per run). With it: still exactly one pair.
    expect(net('error')).toBe(afterMount.error);
    expect(net('loadedmetadata')).toBe(afterMount.loadedmetadata);

    // One loadedmetadata must run the handler ONCE. The handler reads `video.seekable` once per call, so
    // the reads count the handlers that ran (6 without the fix: the live one plus five stale ones).
    let seekableReads = 0;
    Object.defineProperty(video, 'seekable', {
      configurable: true,
      get() { seekableReads += 1; return { length: 0, end: () => 0 }; },
    });
    act(() => { video.dispatchEvent(new Event('loadedmetadata')); });
    expect(seekableReads).toBe(1);
    // ...and it did its job: the overlay is gone (state 'live').
    expect(container.textContent).not.toContain('Connecting');
    expect(container.textContent).not.toContain('No signal');
  });

  test('★ the listeners are already off when the teardown calls load(), on a reconnect and on unmount', () => {
    const base = reactOwnBaseline();
    const { container, unmount } = render(<HlsPlayer mediamtxPath="cam-1" active muted />);
    const video = container.querySelector('video');

    act(() => { video.dispatchEvent(new Event('error')); });
    act(() => { vi.advanceTimersByTime(5000); }); // reconnect: cleanup (load) then a new run
    expect(loadSnapshots.length).toBeGreaterThanOrEqual(1);
    for (const s of loadSnapshots) {
      // At the instant of load() only React's own listeners may be left, not the component's pair: a
      // teardown `error` must not be able to reach a stale handler and flip the state.
      expect(s).toEqual({ error: base.error, loadedmetadata: base.loadedmetadata });
    }

    loadSnapshots.length = 0;
    unmount();
    expect(loadSnapshots.length).toBeGreaterThanOrEqual(1);
    expect(loadSnapshots[0]).toEqual({ error: base.error, loadedmetadata: base.loadedmetadata });
  });

  test('an inactive player attaches nothing', () => {
    const base = reactOwnBaseline();
    render(<HlsPlayer mediamtxPath="cam-1" active={false} muted />);
    expect(net('error')).toBe(base.error);
    expect(net('loadedmetadata')).toBe(base.loadedmetadata);
  });
});
