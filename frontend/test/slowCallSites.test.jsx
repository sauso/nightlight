// Call sites that must pass the SLOW (90 s) request timeout (issue #556). The default 30 s timeout in
// api.js would cut these off while the server is still working, and the user would see a "took too
// long" error for a job that then finishes. Each test fails if the override is dropped from its call.
import { describe, test, expect, vi, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { renderAsAdmin } from './helpers/render.jsx';
import DiagnosticsCard from '../src/components/DiagnosticsCard.jsx';
import ClipManagement from '../src/pages/ClipManagement.jsx';
import * as nativeBridge from '../src/lib/nativeBridge.js';
import { api, SLOW_REQUEST_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS } from '../src/lib/api.js';

const SLOW = { timeoutMs: SLOW_REQUEST_TIMEOUT_MS };

afterEach(() => vi.restoreAllMocks());

test('the slow timeout really is longer than the default', () => {
  expect(SLOW_REQUEST_TIMEOUT_MS).toBeGreaterThan(DEFAULT_REQUEST_TIMEOUT_MS);
});

describe('diagnostics bundle', () => {
  test('GET /diagnostics is given the slow timeout', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:nightlight/1');
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(nativeBridge, 'isNativeApp').mockReturnValue(false);
    const get = vi.spyOn(api, 'get').mockResolvedValue({ version: 'x' });
    const { user } = renderAsAdmin(<DiagnosticsCard title="Report a problem" />);
    await user.click(screen.getByRole('button', { name: /Download diagnostics/ }));
    await waitFor(() => expect(get).toHaveBeenCalledWith('/diagnostics', SLOW));
  });
});

describe('clip management', () => {
  const CLIPS = [
    { id: 'c1', type: 'motion', camera_name: 'A', created_at: '2026-01-02 03:04:05', clip_bytes: 1024 },
    { id: 'c2', type: 'sound', camera_name: 'A', created_at: '2026-01-02 04:04:05', clip_bytes: 2048 },
  ];

  test('GET /cameras/clips (the list) is given the slow timeout', async () => {
    const get = vi.spyOn(api, 'get').mockResolvedValue(CLIPS);
    renderAsAdmin(<ClipManagement />, { route: '/settings/clips' });
    await waitFor(() => expect(get).toHaveBeenCalledWith('/cameras/clips', SLOW));
  });

  test('POST /cameras/clips/delete (bulk) is given the slow timeout', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(CLIPS);
    const post = vi.spyOn(api, 'post').mockResolvedValue({});
    const { user } = renderAsAdmin(<ClipManagement />, { route: '/settings/clips' });
    await user.click(await screen.findByRole('button', { name: 'Select all' }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Delete 2' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith(
      '/cameras/clips/delete', { ids: expect.arrayContaining(['c1', 'c2']) }, SLOW,
    ));
  });
});
