// #386: route-level code splitting (lib/lazyPage.jsx) and the on-demand hls.js load in HlsPlayer.
//
// WHAT THIS PROVES: a lazy screen shows its loading slot, then renders; a failed chunk FETCH (recognised by
// the browsers' messages, or by name ChunkLoadError) shows an inline message whose button RELOADS THE
// DOCUMENT (a second import() of a URL that failed once replays the cached failure, so importing again
// cannot recover: only a new document does); a module that loads but THROWS when evaluated, an ordinary
// render error, and an unrecognised factory rejection are NOT shown as a connection problem and still
// reach the app-level ErrorBoundary.
// (That the real App serves lazy routes is covered by appShell.test.jsx, whose route table now goes through lazyPage.)
// WHAT IT DOES NOT PROVE: a real network failure (the factory is made to reject), real bundle sizes (see the
// PR body for the build numbers), or load time on a device.
import { describe, test, expect, vi, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ErrorBoundary from '../src/components/ErrorBoundary.jsx';
import Hls from 'hls.js';
import HlsPlayer from '../src/components/HlsPlayer.jsx';
import { lazyPage } from '../src/lib/lazyPage.jsx';

afterEach(() => vi.restoreAllMocks());

describe('lazyPage', () => {
  test('shows the loading slot, then the screen, passing props through', async () => {
    let resolve;
    const Page = lazyPage(() => new Promise((r) => { resolve = r; }));
    render(<Page greeting="hello" />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading…');
    await act(async () => { resolve({ default: ({ greeting }) => <p>{greeting} from the lazy screen</p> }); });
    expect(await screen.findByText('hello from the lazy screen')).toBeInTheDocument();
    expect(screen.queryByRole('status')).toBeNull();
  });

  // jsdom cannot spy on location.reload, so the whole location is swapped for a stub (same as chrome.test.jsx).
  async function withReloadStub(run) {
    const reload = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', { configurable: true, value: { ...original, reload } });
    try {
      await run(reload);
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: original });
    }
  }

  // Every wording a browser (or Vite's preload helper) uses for "the module could not be fetched".
  test.each([
    ['Chrome', new TypeError('Failed to fetch dynamically imported module: https://x/assets/Page-abc.js')],
    ['Firefox', new TypeError('error loading dynamically imported module: https://x/assets/Page-abc.js')],
    ['Safari', new TypeError('Importing a module script failed.')],
    ['Vite CSS preload', new Error('Unable to preload CSS for /assets/Page-abc.css')],
    ['a webpack-style ChunkLoadError', Object.assign(new Error('Loading chunk 7 failed.'), { name: 'ChunkLoadError' })],
  ])('a failed chunk fetch (%s) shows an inline message whose button reloads the document', async (_browser, failure) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const factory = vi.fn().mockRejectedValue(failure);
    const Page = lazyPage(factory);
    await withReloadStub(async (reload) => {
      render(<Page />);
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(/couldn.t load this screen/i);
      expect(factory).toHaveBeenCalledTimes(1);
      expect(reload).not.toHaveBeenCalled();

      // The button must NOT import again: that replays the browser's cached failure (the server sees one
      // request for two imports), so a "Retry" that re-imports can never recover. It reloads instead.
      await userEvent.click(screen.getByRole('button', { name: 'Reload' }));
      expect(reload).toHaveBeenCalledTimes(1);
      expect(factory).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    });
  });

  // A module that is fetched fine but throws at its top level rejects the same import() promise. It is a
  // bug, not a connection problem: telling the viewer to check their connection would be a lie.
  test.each([
    ['an evaluation error (module top level throws)', new Error('boom while evaluating the module')],
    ['a TypeError that is not a fetch failure', new TypeError("Cannot read properties of undefined (reading 'x')")],
    ['an error whose message only mentions a fetch', new Error('Failed to fetch dynamically imported module')],
  ])('%s reaches the app ErrorBoundary and is not shown as a connection problem', async (_what, failure) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const Page = lazyPage(() => Promise.reject(failure));
    render(<ErrorBoundary><Page /></ErrorBoundary>);
    expect(await screen.findByText('Something went wrong')).toBeInTheDocument();
    expect(screen.queryByText(/couldn.t load this screen/i)).toBeNull();
    expect(screen.queryByText(/check your connection/i)).toBeNull();
  });

  test('an ordinary render error is not caught here — it reaches the app ErrorBoundary', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const Page = lazyPage(() => Promise.resolve({ default: () => { throw new Error('boom in the screen'); } }));
    render(<ErrorBoundary><Page /></ErrorBoundary>);
    expect(await screen.findByText('Something went wrong')).toBeInTheDocument();
    expect(screen.queryByText(/couldn.t load this screen/i)).toBeNull();
  });
});

describe('HlsPlayer loads hls.js on demand', () => {
  test('without MediaSource support (jsdom) the lazy import resolves and the player reports No signal', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('');
    render(<HlsPlayer mediamtxPath="cam1-hls" active />);
    expect(screen.getByText('Connecting…')).toBeInTheDocument();
    expect(await screen.findByText('No signal')).toBeInTheDocument();
  });

  test('unmounting before the import resolves never reaches hls.js (no player is built for a dead effect)', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('');
    const isSupported = vi.spyOn(Hls, 'isSupported').mockReturnValue(true);
    const { unmount } = render(<HlsPlayer mediamtxPath="cam1-hls" active />);
    unmount();
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    // Without the `cancelled` guard the resolved import goes on to ask isSupported() and build a player
    // attached to a video that has already been torn down.
    expect(isSupported).not.toHaveBeenCalled();
  });
});
