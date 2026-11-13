import { beforeEach, expect, test, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderAsAdmin } from './helpers/render.jsx';
import EsphomeDiscovery from '../src/components/EsphomeDiscovery.jsx';
import { api } from '../src/lib/api.js';

vi.mock('../src/lib/api.js', async (original) => {
  const module = await original();
  return { ...module, api: { ...module.api, get: vi.fn(), post: vi.fn() } };
});
const candidate = { id: 'one', ip: '10.0.0.5', name: '<img onerror=alert(1)>', port: 6053,
  board: 'esp32', encrypted: true };
beforeEach(() => {
  vi.clearAllMocks();
  api.post.mockResolvedValue({ scanId: 'one', endsAt: Date.now() + 30000 });
  api.get.mockResolvedValue({ done: true, candidates: [candidate, { ...candidate, id: 'two', ip: '10.0.0.6', alreadyAdded: true }], sourceErrors: [] });
});

test('results render as text; encrypted and added states are visible and pickable only when available (#1071)', async () => {
  const onPick = vi.fn();
  const view = renderAsAdmin(<EsphomeDiscovery onPick={onPick} />);
  await view.user.click(screen.getByRole('button', { name: 'Find devices on my network' }));
  const rows = await screen.findAllByRole('button', { name: /<img onerror=alert/ });
  expect(rows[0].querySelector('img')).toBeNull();
  expect(rows[0]).toHaveTextContent('10.0.0.5:6053');
  expect(rows[0]).toHaveTextContent('Encryption advertised');
  expect(rows[1]).toHaveAttribute('aria-disabled', 'true');
  await view.user.click(rows[1]);
  expect(onPick).not.toHaveBeenCalled();
  await view.user.click(rows[0]);
  expect(onPick).toHaveBeenCalledWith(candidate);
});

test('empty help, error and device limit (#1071)', async () => {
  api.get.mockResolvedValueOnce({ done: true, candidates: [] });
  const view = renderAsAdmin(<EsphomeDiscovery onPick={vi.fn()} full />);
  await view.user.click(screen.getByRole('button', { name: 'Find devices on my network' }));
  expect(await screen.findByText(/No devices found/)).toHaveTextContent('mDNS relay');
  expect(screen.getByText(/Results cannot be picked while you have 8 devices/)).toBeInTheDocument();
  api.post.mockRejectedValueOnce(new Error('Too many device searches. Try again in a minute.'));
  await view.user.click(screen.getByRole('button', { name: 'Search again' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Too many device searches');
});

test('device limit leaves discovered cards visible but unpickable (#1071)', async () => {
  const onPick = vi.fn();
  const view = renderAsAdmin(<EsphomeDiscovery onPick={onPick} full />);
  await view.user.click(screen.getByRole('button', { name: 'Find devices on my network' }));
  const rows = await screen.findAllByRole('button', { name: /<img onerror=alert/ });
  expect(rows[0]).toHaveAttribute('aria-disabled', 'true');
  await view.user.click(rows[0]);
  expect(onPick).not.toHaveBeenCalled();
  expect(screen.getByText(/Results cannot be picked while you have 8 devices/)).toBeInTheDocument();
});
