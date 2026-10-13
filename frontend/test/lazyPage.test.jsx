// #386: route-level code splitting (lib/lazyPage.jsx) and the on-demand hls.js load in HlsPlayer.
//
// WHAT THIS PROVES: a lazy screen shows its loading slot, then renders; a failed chunk fetch shows an inline
// message with a Retry that fetches again and recovers (React.lazy alone caches the rejection, so the retry
// test fails if lazyPage reused the first lazy component); an ordinary render error is NOT swallowed by the
// chunk boundary and still reaches the app-level ErrorBoundary.
// (That the real App serves lazy routes is covered by appShell.test.jsx, whose route table now goes through lazyPage.)
// WHAT IT DOES NOT PROVE: a real network failure (the factory is made to reject), real bundle sizes (see the
// PR body for the build numbers), or load time on a device.
import { describe, test, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
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

  test('a failed chunk load shows an inline message, and Retry loads it again', async () => {
    const factory = vi.fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch dynamically imported module'))
      .mockResolvedValue({ default: () => <p>second attempt worked</p> });
    const Page = lazyPage(factory);
    render(<Page />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/couldn.t load this screen/i);
    expect(factory).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('second attempt worked')).toBeInTheDocument();
    expect(factory).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('Retry that fails again keeps the message up rather than going blank', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const factory = vi.fn().mockRejectedValue(new TypeError('offline'));
    const Page = lazyPage(factory);
    render(<Page />);
    await screen.findByRole('alert');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(factory).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument();
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
