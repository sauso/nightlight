// Settings drive the app's identity: accent colour, status colours, font pair, tab title. The theming
// is applied through CSSOM `setProperty` rather than a <style> block ON PURPOSE - that is what lets the
// enforced CSP run without `unsafe-inline`. These tests pin that mechanism, not just the values, so a
// future refactor to inline styles fails here instead of silently breaking the CSP in production.
import { describe, test, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { useContext } from 'react';
import { FONT_PRESETS, DEFAULT_FONT_CHOICE } from '../../src/lib/fonts.js';

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
      <span data-testid="name">{ctx.settings.app_name}</span>
      <span data-testid="unit">{ctx.settings.temp_unit}</span>
      <button onClick={() => ctx.refresh()}>reload</button>
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

describe('theming (CSSOM, never inline styles - the CSP depends on it)', () => {
  test('stamps the accent and status colours onto the document root', async () => {
    stubFetch(() => ({
      body: {
        app_name: 'Casa',
        accent_color: '#123456',
        live_color: '#00ff00',
        offline_color: '#ff0000',
        font_choice: 'modern-sans',
      },
    }));
    renderProvider();
    await waitFor(() => expect(cssVar('--accent')).toBe('#123456'));
    expect(cssVar('--live')).toBe('#00ff00');
    expect(cssVar('--offline')).toBe('#ff0000');
  });

  test('applies the chosen font pair', async () => {
    stubFetch(() => ({ body: { app_name: 'Casa', font_choice: 'classic-serif' } }));
    renderProvider();
    await waitFor(() => expect(cssVar('--font-display')).toBe(FONT_PRESETS['classic-serif'].display));
    expect(cssVar('--font-body')).toBe(FONT_PRESETS['classic-serif'].body);
  });

  test('falls back to the default pair for an unknown font choice rather than clearing the font', async () => {
    stubFetch(() => ({ body: { app_name: 'Casa', font_choice: 'comic-papyrus' } }));
    renderProvider();
    await waitFor(() =>
      expect(cssVar('--font-display')).toBe(FONT_PRESETS[DEFAULT_FONT_CHOICE].display)
    );
  });

  test('sets the browser tab title from app_name', async () => {
    stubFetch(() => ({ body: { app_name: 'Casa Nightlight' } }));
    renderProvider();
    await waitFor(() => expect(document.title).toBe('Casa Nightlight'));
  });
});

describe('when the settings request fails', () => {
  test('still finishes loading and still themes the page with the defaults', async () => {
    stubFetch(() => ({ status: 500, body: '' }));
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));

    // An unthemed app is a broken-looking app, so the fallback must apply the defaults, not nothing.
    expect(screen.getByTestId('name')).toHaveTextContent('Nightlight');
    expect(cssVar('--accent')).toBe('#f4c56a');
    expect(cssVar('--font-display')).toBe(FONT_PRESETS[DEFAULT_FONT_CHOICE].display);
    expect(document.title).toBe('Nightlight');
  });

  test('survives a network-level rejection the same way', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('offline'); });
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    expect(cssVar('--accent')).toBe('#f4c56a');
  });
});
