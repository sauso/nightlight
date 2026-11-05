import { afterEach, test, expect, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderAsAdmin, renderAsCaregiver } from './helpers/render.jsx';
import About from '../src/pages/About.jsx';
import { api } from '../src/lib/api.js';
import { setupApi } from '../src/lib/setupApi.js';

const LINK = { name: 'Setup status and picture check' };

afterEach(() => { vi.restoreAllMocks(); });

function mockSetup(status) {
  vi.spyOn(api, 'get').mockResolvedValue({ version: 'test' });
  return vi.spyOn(setupApi, 'read').mockResolvedValue({ status });
}

// Owner 2026-11-05: the row is clutter once setup is complete. Only `completed` hides it: a limited setup still needs the
// picture check, and an install upgraded from before the guide uses this link for diagnostics.
test.each(['not_started', 'in_progress', 'completed_limited', 'legacy_completed'])(
  '★ an admin sees the setup status and picture check link while setup is %s', async (status) => {
    mockSetup(status);
    renderAsAdmin(<About />);
    expect(await screen.findByRole('link', LINK)).toHaveAttribute('href', '/setup');
  });

test('★ an admin does not see the link once setup is completed', async () => {
  const read = mockSetup('completed');
  renderAsAdmin(<About />);
  await waitFor(() => expect(read).toHaveBeenCalled());
  await screen.findByText(/Self-hosted baby monitor/);
  expect(screen.queryByRole('link', LINK)).not.toBeInTheDocument();
});

test('the link stays hidden while the status is unknown (no flash on a finished install)', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({ version: 'test' });
  vi.spyOn(setupApi, 'read').mockImplementation(() => new Promise(() => {}));
  renderAsAdmin(<About />);
  await screen.findByText(/Self-hosted baby monitor/);
  expect(screen.queryByRole('link', LINK)).not.toBeInTheDocument();
});

test('a caregiver never sees the link and never asks for the setup status', async () => {
  const read = mockSetup('in_progress');
  renderAsCaregiver(<About />);
  await screen.findByText(/Self-hosted baby monitor/);
  expect(screen.queryByRole('link', LINK)).not.toBeInTheDocument();
  expect(read).not.toHaveBeenCalled();
});
