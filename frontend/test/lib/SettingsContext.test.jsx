// Settings publish server values and the app name. Legacy appearance fields never override CSS (#943).
import { describe, test, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { useContext } from 'react';

let SettingsProvider, SettingsContext;

function stubFetch(handler) {
  globalThis.fetch = vi.fn(async (url, init) => {
    const { status = 200, body = {} } = handler(url, init) || {};
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    };
  });
  return globalThis.fetch;
}

function Probe() {
  const ctx = useContext(SettingsContext);
  return (
    <div>
      <span data-testid="loading">{String(ctx.loading)}</span>
      <span data-testid="loaded">{String(ctx.loaded)}</span>
      <span data-testid="name">{ctx.settings.app_name}</span>
      <span data-testid="unit">{ctx.settings.temp_unit}</span>
      <button onClick={() => ctx.refresh()}>reload</button>
      <button onClick={() => ctx.commit({ app_name: 'Committed', accent_color: '#f4c56a' })}>
        commit
      </button>
    </div>
  );
}

const renderProvider = () =>
  render(
    <SettingsProvider>
      <Probe />
    </SettingsProvider>
  );

const cssVar = (name) => document.documentElement.style.getPropertyValue(name);

beforeEach(async () => {
  vi.resetModules();
  document.documentElement.removeAttribute('style');
  document.title = '';
  ({ SettingsProvider, SettingsContext } = await import('../../src/lib/SettingsContext.jsx'));
});

describe('loading settings', () => {
  test('publishes what the server returned', async () => {
    stubFetch(() => ({ body: { app_name: 'Casa', accent_color: '#123456', temp_unit: 'F' } }));
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('name')).toHaveTextContent('Casa'));
    expect(screen.getByTestId('unit')).toHaveTextContent('F');
    expect(screen.getByTestId('loading')).toHaveTextContent('false');
  });

  test('starts from defaults before the fetch resolves, so nothing renders undefined', async () => {
    let release;
    globalThis.fetch = vi.fn(() => new Promise((resolve) => { release = resolve; }));
    renderProvider();
    expect(screen.getByTestId('name')).toHaveTextContent('Nightlight');
    expect(screen.getByTestId('loading')).toHaveTextContent('true');
    // Let the in-flight request settle inside act(), or React logs an update-outside-act warning
    // once this test has already finished.
    await act(async () => { release({ ok: true, status: 200, text: async () => '{}' }); });
  });

  test('refresh() re-reads from the server', async () => {
    let name = 'First';
    const fetchMock = stubFetch(() => ({ body: { app_name: name, accent_color: '#f4c56a' } }));
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('name')).toHaveTextContent('First'));

    name = 'Second';
    await act(async () => { screen.getByText('reload').click(); });
    await waitFor(() => expect(screen.getByTestId('name')).toHaveTextContent('Second'));
    expect(fetchMock.mock.calls.length).toBe(2);
  });
});

describe('fixed branding (#943)', () => {
  test('ignores saved colours and fonts while keeping the app name', async () => {
    stubFetch(() => ({ body: {
      app_name: 'Casa Nightlight', accent_color: '#123456',
      live_color: '#00ff00', offline_color: '#ff0000', font_choice: 'classic-serif',
    } }));
    renderProvider();
    await waitFor(() => expect(document.title).toBe('Casa Nightlight'));
    for (const token of ['--accent', '--live', '--offline', '--font-display', '--font-body']) {
      expect(cssVar(token), token).toBe('');
    }
  });
});

describe('commit() (#449)', () => {
  // A PUT's response is the server's own word on what it just wrote, and a page (e.g.
  // SettingsRecording.jsx) uses commit() to publish it directly instead of a second refresh() that
  // could fail on its own (see commit()'s comment in SettingsContext.jsx). But commit() bumps reqSeq
  // so a stale, already-in-flight refresh can't land on top of it — and until this fix, that bump was
  // the ONLY thing commit() did to reqSeq/loading: refresh()'s `finally` only calls setLoading(false)
  // for the request whose own `seq` still matches `reqSeq.current`, so bumping reqSeq without also
  // clearing `loading` left it stuck at `true` forever whenever a commit landed while the initial (or
  // post-login) fetch was still in flight — even though real, authoritative settings were already on
  // screen.
  test('a commit landing during an in-flight initial fetch clears loading and is not overwritten by that fetch resolving later', async () => {
    let releaseInitialFetch;
    globalThis.fetch = vi.fn(() => new Promise((resolve) => { releaseInitialFetch = resolve; }));
    renderProvider();

    // The initial GET /settings never resolved yet - this is the failing case before the fix:
    // loading stays true and would stay true even after commit() below without it.
    expect(screen.getByTestId('loading')).toHaveTextContent('true');

    await act(async () => { screen.getByText('commit').click(); });

    expect(screen.getByTestId('loading')).toHaveTextContent('false');
    expect(screen.getByTestId('name')).toHaveTextContent('Committed');

    // Now let the stale initial GET resolve, with DIFFERENT values. Its `seq` no longer matches
    // reqSeq.current (commit() bumped it), so it must not overwrite the committed settings.
    await act(async () => {
      releaseInitialFetch({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ app_name: 'StaleGET' }),
      });
    });

    expect(screen.getByTestId('name')).toHaveTextContent('Committed');
  });
});

describe('when the settings request fails', () => {
  test('still finishes loading and sets the default tab title', async () => {
    stubFetch(() => ({ status: 500, body: '' }));
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));

    expect(screen.getByTestId('name')).toHaveTextContent('Nightlight');
    expect(cssVar('--accent')).toBe('');
    expect(document.title).toBe('Nightlight');
  });

  test('survives a network-level rejection the same way', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('offline'); });
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    expect(cssVar('--accent')).toBe('');
  });
});

// `loaded` — have the SERVER's settings ever arrived? Added after the 0.34.0 release review: NightReview's
// "Before bedtime" group judged 16:00 in the placeholder 'UTC' and saved a real put-down as "No". The
// placeholder and a configured UTC are the same value, so only this flag tells them apart — and it must
// NOT be `!loading`, which also turns true when the first request FAILS and the placeholder stays.
describe('loaded: whether the settings are the server\'s own, not the placeholder defaults', () => {
  test('false while the first request is in flight, true once it succeeds', async () => {
    let release;
    globalThis.fetch = vi.fn(() => new Promise((resolve) => { release = resolve; }));
    renderProvider();
    expect(screen.getByTestId('loaded')).toHaveTextContent('false');
    await act(async () => {
      release({ ok: true, status: 200, text: async () => JSON.stringify({ app_name: 'Casa', timezone: 'Australia/Melbourne' }) });
    });
    expect(screen.getByTestId('loaded')).toHaveTextContent('true');
  });

  test('a FAILED first request finishes loading but is NOT loaded — the defaults are still a guess', async () => {
    // The distinction the flag exists for: `loading` false here, `loaded` false with it.
    stubFetch(() => ({ status: 500, body: '' }));
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    expect(screen.getByTestId('loaded')).toHaveTextContent('false');
  });

  test('a commit is the server\'s own word, so it counts as loaded even with the first GET still in flight', async () => {
    globalThis.fetch = vi.fn(() => new Promise(() => {}));
    renderProvider();
    expect(screen.getByTestId('loaded')).toHaveTextContent('false');
    await act(async () => { screen.getByText('commit').click(); });
    expect(screen.getByTestId('loaded')).toHaveTextContent('true');
  });

  test('once loaded, a later failed refresh does not un-load it (the good settings are kept)', async () => {
    let fail = false;
    stubFetch(() => (fail ? { status: 500, body: '' } : { body: { app_name: 'Casa' } }));
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('loaded')).toHaveTextContent('true'));
    fail = true;
    await act(async () => { screen.getByText('reload').click(); });
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId('loaded')).toHaveTextContent('true');
    expect(screen.getByTestId('name')).toHaveTextContent('Casa');
  });
});
