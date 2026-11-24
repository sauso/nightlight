import { describe, test, expect, vi, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderAsAdmin, renderAsCaregiver } from './helpers/render.jsx';
import UpdatePastNights from '../src/components/UpdatePastNights.jsx';
import { api } from '../src/lib/api.js';

const preview = {
  preview: 'a'.repeat(64), changed: 1, figures_changed: 1, facts_only: 0,
  children: [{ child_id: 'child-1', name: 'A child', unchanged: 2,
    changed: [{ night_date: '2026-07-01', figures_changed: true,
      before: { onset_at: '2026-07-01 09:00:00', wake_at: '2026-07-01 20:00:00', asleep_minutes: 400, wake_count: 2 },
      after: { onset_at: '2026-07-01 09:20:00', wake_at: '2026-07-01 20:10:00', asleep_minutes: 420, wake_count: 1 } }],
    skipped: { has_review: 1, partial_data: 2 } }],
};
const latest = { batch_id: 'batch-1', undoable: true, changed: 1 };

afterEach(() => vi.restoreAllMocks());

describe('Update past nights', () => {
  test('requires the check and a second explicit click, explains skips, then offers undo', async () => {
    vi.spyOn(api, 'get').mockResolvedValueOnce(null).mockResolvedValueOnce(latest).mockResolvedValueOnce({ ...latest, undoable: false });
    const post = vi.spyOn(api, 'post').mockResolvedValueOnce(preview).mockResolvedValueOnce(preview)
      .mockResolvedValueOnce({ restored: 1, skipped: {} });
    const { user } = renderAsAdmin(<UpdatePastNights />);
    expect(screen.queryByRole('button', { name: /update 1 night/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /check what would change/i }));
    expect(await screen.findByText(/1 night would change/)).toBeInTheDocument();
    expect(screen.getByText(/Someone reviewed this night: 1/)).toBeInTheDocument();
    expect(screen.getByText(/Some minute data is missing: 2/)).toBeInTheDocument();
    expect(screen.getByText(/onset 7:00 pm/i)).toBeInTheDocument();
    expect(screen.queryByText(/onset 2026-07-01 09:00:00/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Figures changed/).closest('p')).toHaveTextContent(/01\/07\/2026/);
    expect(screen.getByRole('button', { name: /update 1 night/i }).closest('.modal-actions')).toBeInTheDocument();
    expect(post).toHaveBeenCalledExactlyOnceWith('/settings/sleep-rewrite', { apply: false }, expect.any(Object));
    await user.click(screen.getByRole('button', { name: /update 1 night/i }));
    expect(await screen.findByText(/Updated 1 night/)).toBeInTheDocument();
    expect(post).toHaveBeenNthCalledWith(2, '/settings/sleep-rewrite', { apply: true, expect: preview.preview }, expect.any(Object));
    await user.click(screen.getByRole('button', { name: /undo these changes/i }));
    expect(screen.getByRole('dialog', { name: /undo the last update/i })).toBeInTheDocument();
    expect(post).toHaveBeenCalledTimes(2);
    await user.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(screen.queryByRole('dialog', { name: /undo the last update/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /undo these changes/i }));
    await user.click(screen.getByRole('button', { name: /^undo$/i }));
    await waitFor(() => expect(post).toHaveBeenNthCalledWith(3, '/settings/sleep-rewrite/undo', { batch_id: 'batch-1' }, expect.any(Object)));
    expect(await screen.findByText(/last update can no longer be undone/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /undo these changes/i })).not.toBeInTheDocument();
  });

  test('a changed preview asks for another check and cannot apply the stale one', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(null);
    const post = vi.spyOn(api, 'post').mockResolvedValueOnce(preview)
      .mockRejectedValueOnce(new Error('Past nights changed since the check'));
    const { user } = renderAsAdmin(<UpdatePastNights />);
    await user.click(screen.getByRole('button', { name: /check what would change/i }));
    await user.click(await screen.findByRole('button', { name: /update 1 night/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/check what would change again/i);
    expect(screen.queryByRole('button', { name: /update 1 night/i })).not.toBeInTheDocument();
    expect(post).toHaveBeenCalledTimes(2);
  });

  test('a closed undo batch shows how many nights were left and no Undo button', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({ ...latest, undoable: false, restored: 1, left: 2 });
    renderAsAdmin(<UpdatePastNights />);
    expect(await screen.findByText(/2 nights were left as they are/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /undo these changes/i })).not.toBeInTheDocument();
  });

  test('only admins see the card', () => {
    vi.spyOn(api, 'get').mockResolvedValue(null);
    renderAsCaregiver(<UpdatePastNights />);
    expect(screen.queryByText('Update past nights')).not.toBeInTheDocument();
    renderAsAdmin(<UpdatePastNights />);
    expect(screen.getByText('Update past nights')).toBeInTheDocument();
  });
});
