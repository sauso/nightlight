import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import { renderAsAdmin } from './helpers/render.jsx';
import CameraDiscovery from '../src/components/CameraDiscovery.jsx';
import { api } from '../src/lib/api.js';

vi.mock('../src/lib/api.js', async (original) => {
  const module = await original();
  return { ...module, api: { ...module.api, get: vi.fn(), post: vi.fn() } };
});
const scanId = '12345678-1234-1234-1234-123456789abc';
const candidate = { id: 'one', ip: '192.168.1.2', name: '<img onerror=alert(1)>',
  rtspPort: 554, sources: ['mdns'], product: 'Thingino' };
beforeEach(() => {
  vi.clearAllMocks();
  api.post.mockResolvedValue({ scanId, endsAt: Date.now() + 30000 });
  api.get.mockResolvedValue({ done: true, candidates: [candidate], sourceErrors: [], endsAt: Date.now() + 30000 });
});
afterEach(() => vi.useRealTimers());

test('poll results appear as text and picking passes the candidate', async () => {
  const onPick = vi.fn();
  const view = renderAsAdmin(<CameraDiscovery onPick={onPick} />);
  await view.user.click(screen.getByRole('button', { name: 'Find cameras on my network' }));
  const row = await screen.findByRole('button', { name: /<img onerror=alert/ });
  expect(row).toHaveTextContent('192.168.1.2');
  expect(row.querySelector('img')).toBeNull();
  await view.user.click(row);
  expect(onPick).toHaveBeenCalledWith(candidate);
});

test('selected row is pressed and an added row stays legible but cannot be picked', async () => {
  const onPick = vi.fn();
  api.get.mockResolvedValue({ done: true, candidates: [candidate, { ...candidate, id: 'two', name: 'Saved camera', alreadyAdded: true }], endsAt: Date.now() });
  const view = renderAsAdmin(<CameraDiscovery onPick={onPick} selectedId="one" />);
  await view.user.click(screen.getByRole('button', { name: 'Find cameras on my network' }));
  const results = await screen.findByRole('list', { name: 'Cameras found' });
  const chosen = within(results).getByRole('button', { name: /<img onerror/ });
  const added = within(results).getByRole('button', { name: /Saved camera/ });
  expect(chosen).toHaveAttribute('aria-pressed', 'true');
  expect(added).toHaveAttribute('aria-disabled', 'true');
  expect(added).toHaveTextContent('Added');
  expect(added).not.toHaveClass('is-added');
  await view.user.click(added);
  expect(onPick).not.toHaveBeenCalled();
});

test('nothing found offers an in-card manual action', async () => {
  api.get.mockResolvedValue({ done: true, candidates: [], endsAt: Date.now() });
  const onAddManually = vi.fn();
  const view = renderAsAdmin(<CameraDiscovery onPick={vi.fn()} onAddManually={onAddManually} />);
  await view.user.click(screen.getByRole('button', { name: 'Find cameras on my network' }));
  const manual = await screen.findByRole('button', { name: 'Add a camera manually' });
  expect(manual.closest('.find-card')).toBeInTheDocument();
  await view.user.click(manual);
  expect(onAddManually).toHaveBeenCalledOnce();
});

test('empty search shows help and can search again; 429 message is shown', async () => {
  api.get.mockResolvedValueOnce({ done: true, candidates: [], sourceErrors: [], endsAt: Date.now() });
  const view = renderAsAdmin(<CameraDiscovery onPick={vi.fn()} />);
  await view.user.click(screen.getByRole('button', { name: 'Find cameras on my network' }));
  expect(await screen.findByText(/No cameras found/)).toHaveTextContent('add a camera manually');
  api.post.mockRejectedValueOnce(new Error('Too many camera searches. Try again in a minute.'));
  await view.user.click(screen.getByRole('button', { name: 'Search again' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Too many camera searches');
});

test('unmount aborts the request and leaves no later poll', async () => {
  let resolve;
  api.post.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  const view = renderAsAdmin(<CameraDiscovery autoStart onPick={vi.fn()} />);
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
  view.unmount();
  await act(async () => { resolve({ scanId, endsAt: Date.now() + 30000 }); });
  expect(api.get).not.toHaveBeenCalled();
});

test('unmount clears a scheduled poll timer', async () => {
  vi.useFakeTimers();
  api.get.mockResolvedValue({ done: false, candidates: [], sourceErrors: [], endsAt: Date.now() + 30000 });
  const view = renderAsAdmin(<CameraDiscovery autoStart onPick={vi.fn()} />);
  await act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
  expect(api.get).toHaveBeenCalledTimes(1);
  view.unmount();
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(api.get).toHaveBeenCalledTimes(1);
});
