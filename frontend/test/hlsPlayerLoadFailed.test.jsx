// #386: HlsPlayer fetches hls.js on demand. When that fetch FAILS the player must not sit in the 5 s auto-retry
// loop: a dynamic import of a URL that failed once is remembered by the browser's module map for the life of
// the document, so each retry would replay the first failure forever (verified in headless Chrome). It has to
// offer a reload, the only thing that clears the module map.
//
// WHAT THIS PROVES: with the import rejecting, the player shows a "Couldn't load the video player" alert with a
// Reload button that reloads the document, and it does not call import() again on its own (the mock factory
// runs once however long we wait, past the 5 s retry timer and a visibility change back to the tab).
// WHAT IT DOES NOT PROVE: a real network failure or the browser's module-map caching itself (the factory is
// made to throw; the caching was observed by hand in Chrome, not asserted here).
import { describe, test, expect, vi, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// vi.hoisted so the counter exists when the (hoisted) mock factory runs. A factory that throws makes the
// component's `import('hls.js')` reject, which is what a failed chunk fetch looks like to it.
const factoryCalls = vi.hoisted(() => ({ n: 0 }));
vi.mock('hls.js', () => {
  factoryCalls.n += 1;
  throw new TypeError('Failed to fetch dynamically imported module: /assets/hls-abc.js');
});

import HlsPlayer from '../src/components/HlsPlayer.jsx';

afterEach(() => vi.restoreAllMocks());

describe('HlsPlayer when the hls.js chunk cannot be fetched', () => {
  test('stops retrying and offers a reload that reloads the document', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('');
    const reload = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', { configurable: true, value: { ...original, reload } });
    try {
      render(<HlsPlayer mediamtxPath="cam1-hls" active />);
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(/couldn.t load the video player/i);
      expect(screen.queryByText('No signal')).toBeNull();
      expect(factoryCalls.n).toBe(1);

      // Past the 5 s error auto-retry, and a tab coming back to the foreground (the other reconnect path):
      // neither may import again, since both would only replay the cached failure.
      vi.useFakeTimers();
      try {
        await act(async () => { await vi.advanceTimersByTimeAsync(12000); });
        await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
        await act(async () => { await vi.advanceTimersByTimeAsync(12000); });
      } finally {
        vi.useRealTimers();
      }
      expect(factoryCalls.n).toBe(1);
      expect(screen.getByRole('alert')).toBeInTheDocument();

      expect(reload).not.toHaveBeenCalled();
      await userEvent.click(screen.getByRole('button', { name: 'Reload' }));
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: original });
    }
  });
});
