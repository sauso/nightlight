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
  expect(rows[1]).toHaveTextContent('Added');
  expect(rows[1]).toHaveTextContent('Encryption advertised'); // a saved device keeps its chip (#1078 review)
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
  expect(screen.getByText(/You have 8 devices, which is the limit/)).toBeInTheDocument();
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
  expect(rows[0]).toHaveTextContent('Not added');
  await view.user.click(rows[0]);
  expect(onPick).not.toHaveBeenCalled();
  expect(screen.getByText(/You have 8 devices, which is the limit/)).toBeInTheDocument();
});

test('idle and nothing found offer the manual add action inside the card', async () => {
  api.get.mockResolvedValueOnce({ done: true, candidates: [] });
  const onAddManually = vi.fn();
  const view = renderAsAdmin(<EsphomeDiscovery onPick={vi.fn()} onAddManually={onAddManually} />);
  expect(screen.getByText('A search takes up to 30 seconds.')).toBeInTheDocument();
  await view.user.click(screen.getByRole('button', { name: 'Find devices on my network' }));
  await screen.findByText(/No devices found/);
  await view.user.click(screen.getByRole('button', { name: 'Add by IP address' }));
  expect(onAddManually).toHaveBeenCalledOnce();
});

test('the manual action waits for the device count too: the shared card ignores it while loading (#1078 review)', async () => {
  api.get.mockResolvedValueOnce({ done: true, candidates: [] });
  const onAddManually = vi.fn();
  const view = renderAsAdmin(<EsphomeDiscovery onPick={vi.fn()} onAddManually={onAddManually} loading />);
  await view.user.click(screen.getByRole('button', { name: 'Find devices on my network' }));
  await screen.findByText(/No devices found/);
  const manual = screen.getByRole('button', { name: 'Add by IP address' });
  expect(manual).toHaveAttribute('aria-disabled', 'true');
  await view.user.click(manual);
  expect(onAddManually).not.toHaveBeenCalled();
});

test('a loading device list blocks picks without a misleading chip', async () => {
  const onPick = vi.fn();
  const view = renderAsAdmin(<EsphomeDiscovery onPick={onPick} loading />);
  await view.user.click(screen.getByRole('button', { name: 'Find devices on my network' }));
  const row = (await screen.findAllByRole('button', { name: /<img onerror=alert/ }))[0];
  expect(row).toHaveAttribute('aria-disabled', 'true');
  expect(row).not.toHaveTextContent('Not added');
  await view.user.click(row);
  expect(onPick).not.toHaveBeenCalled();
});

test('results arriving during a search remain pickable while the main action is busy', async () => {
  api.get.mockResolvedValueOnce({ done: false, candidates: [candidate], sourceErrors: [] });
  const onPick = vi.fn();
  const view = renderAsAdmin(<EsphomeDiscovery onPick={onPick} />);
  await view.user.click(screen.getByRole('button', { name: 'Find devices on my network' }));
  const row = await screen.findByRole('button', { name: /<img onerror=alert/ });
  expect(screen.getByRole('button', { name: /Looking…/ })).toBeDisabled();
  await view.user.click(row);
  expect(onPick).toHaveBeenCalledWith(candidate);
});
