// The admin "Recompute this night" control.
//
// Three things are worth testing here and none is cosmetic:
//   1. THE BASELINE IS THE STORED ROW. The first cut of this component compared the page's `night` —
//      which is already a fresh recompute — against another fresh recompute. The two sides were the
//      same computation, so the dialog always said "exactly the same numbers" while the child's card
//      stayed wrong. The feature shipped doing nothing. That is what the first block below guards.
//   2. ROLE GATING — a caregiver must not be able to rewrite stored sleep history. The failure mode is
//      silent, which is the shape of bug this project has shipped before.
//   3. It PREVIEWS before it writes, because the write is irreversible.

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderAsAdmin, renderAsCaregiver } from './helpers/render.jsx';
import RecomputeNight from '../src/components/RecomputeNight.jsx';
import { api } from '../src/lib/api.js';

// What the sleep detail page shows: freshly recomputed, and correct.
const FRESH = {
  night_date: '2026-08-28',
  onset_at: '2026-08-28 10:15:00',
  wake_at: '2026-08-28 19:20:00',
  asleep_minutes: 545,
  awake_minutes: 0,
  wake_count: 0,
  in_progress: false,
};
// What is actually SAVED — written before the algorithm was fixed. This is the real prod row.
const STORED = {
  night_date: '2026-08-28',
  onset_at: '2026-08-28 06:56:00',
  wake_at: '2026-08-28 19:20:00',
  asleep_minutes: 568,
  awake_minutes: 176,
  wake_count: 3,
};

const fmtTime = (utc) => (utc ? String(utc).slice(11, 16) : '');

// api.get is called with different URLs for different things; route by query string.
function mockApi({ stored = STORED, onStore = FRESH } = {}) {
  vi.spyOn(api, 'get').mockImplementation((url) => {
    if (url.includes('stored=1')) return Promise.resolve({ night: stored });
    if (url.includes('store=1')) return Promise.resolve(onStore);
    return Promise.reject(new Error(`unexpected call: ${url}`));
  });
}

const setup = (renderer, props = {}) =>
  renderer(
    <RecomputeNight childId="c-1" date="2026-08-28" night={props.night || FRESH} fmtTime={fmtTime}
      onRecomputed={props.onRecomputed || vi.fn()} />
  );

beforeEach(() => mockApi());
afterEach(() => vi.restoreAllMocks());

describe('a night the person has corrected', () => {
  test('says why recomputing will not change what is shown', async () => {
    // A corrected night displays the person's times, so recompute changes the detector's answer
    // underneath while the display keeps the correction — the button looks broken otherwise. The owner
    // pressed it expecting a wrong time to be replaced and nothing visible happened.
    setup(renderAsAdmin, { night: { ...FRESH, corrected: true } });
    expect(await screen.findByText(/will\s+not change what is shown/)).toBeInTheDocument();
  });

  test('and says nothing of the sort on an ordinary night', () => {
    setup(renderAsAdmin);
    expect(screen.queryByText(/not change what is shown/)).not.toBeInTheDocument();
  });
});

describe('the baseline is what is SAVED, not what the page is showing', () => {
  test('it reads the stored row rather than recomputing a second time', async () => {
    const { user } = setup(renderAsAdmin);
    await user.click(screen.getByRole('button', { name: /recompute this night/i }));

    await waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(api.get.mock.calls[0][0]).toMatch(/stored=1/);
    // And it must NOT store on merely opening the dialog.
    expect(api.get.mock.calls.filter(([u]) => /[?&]store=1/.test(u))).toHaveLength(0);
  });

  test('a stale saved summary is reported as a difference, not as "nothing to do"', async () => {
    // THE regression test for the shipped bug. The page shows 10:15 and the saved row says 06:56, so
    // there is plainly something to fix — comparing the page against itself said otherwise.
    const { user } = setup(renderAsAdmin);
    await user.click(screen.getByRole('button', { name: /recompute this night/i }));

    await waitFor(() => expect(screen.getByText(/no longer matches/i)).toBeInTheDocument());
    expect(screen.queryByText(/already matches/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save the new numbers/i })).toBeInTheDocument();
  });

  test('the dialog shows the saved figures on the left and the new ones on the right', async () => {
    const { user } = setup(renderAsAdmin);
    await user.click(screen.getByRole('button', { name: /recompute this night/i }));

    await waitFor(() => expect(screen.getByText(/no longer matches/i)).toBeInTheDocument());
    expect(screen.getByText('06:56')).toBeInTheDocument(); // saved, wrong
    expect(screen.getByText('10:15')).toBeInTheDocument(); // recomputed, right
    expect(screen.getByText('2h 56m')).toBeInTheDocument(); // saved awake time
    expect(screen.getByText('0m')).toBeInTheDocument(); // recomputed awake time
  });

  test('a saved summary that already agrees offers nothing to save', async () => {
    mockApi({ stored: { ...FRESH } });
    const { user } = setup(renderAsAdmin);
    await user.click(screen.getByRole('button', { name: /recompute this night/i }));

    await waitFor(() => expect(screen.getByText(/already matches/i)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument();
  });

  test('a night with nothing saved yet offers to record it', async () => {
    mockApi({ stored: null });
    const { user } = setup(renderAsAdmin);
    await user.click(screen.getByRole('button', { name: /recompute this night/i }));

    await waitFor(() => expect(screen.getByText(/nothing is saved for this night yet/i)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /save this night/i })).toBeInTheDocument();
  });
});

describe('role gating', () => {
  test('an admin sees the control', () => {
    setup(renderAsAdmin);
    expect(screen.getByRole('button', { name: /recompute this night/i })).toBeInTheDocument();
  });

  test('a caregiver does not see it at all', () => {
    setup(renderAsCaregiver);
    expect(screen.queryByRole('button', { name: /recompute this night/i })).not.toBeInTheDocument();
  });

  test('a caregiver cannot reach the endpoint through this component', () => {
    setup(renderAsCaregiver);
    expect(api.get).not.toHaveBeenCalled();
  });
});

describe('writing', () => {
  test('saving is what stores, and it reports the result upwards', async () => {
    const onRecomputed = vi.fn();
    const { user } = setup(renderAsAdmin, { onRecomputed });
    await user.click(screen.getByRole('button', { name: /recompute this night/i }));
    await waitFor(() => expect(screen.getByText(/no longer matches/i)).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /save the new numbers/i }));
    await waitFor(() => expect(onRecomputed).toHaveBeenCalledWith(FRESH));
    expect(api.get.mock.calls.at(-1)[0]).toMatch(/store=1/);
  });

  test('cancelling closes the dialog and stores nothing', async () => {
    const { user } = setup(renderAsAdmin);
    await user.click(screen.getByRole('button', { name: /recompute this night/i }));
    await waitFor(() => expect(screen.getByText(/no longer matches/i)).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /^cancel$/i }));
    await waitFor(() => expect(screen.queryByText(/no longer matches/i)).not.toBeInTheDocument());
    expect(api.get.mock.calls.filter(([u]) => /[?&]store=1/.test(u))).toHaveLength(0);
  });

  test('a refused save surfaces the reason instead of failing silently', async () => {
    // The backend answers 409 when a night's samples have aged out. The user has to be told why, or the
    // button just looks broken.
    const { user } = setup(renderAsAdmin);
    await user.click(screen.getByRole('button', { name: /recompute this night/i }));
    await waitFor(() => expect(screen.getByText(/no longer matches/i)).toBeInTheDocument());

    api.get.mockRejectedValueOnce(new Error("This night can't be re-scored: its minute-by-minute data has aged out"));
    await user.click(screen.getByRole('button', { name: /save the new numbers/i }));
    await waitFor(() => expect(screen.getByText(/aged out/i)).toBeInTheDocument());
  });
});

describe('when there is nothing to act on', () => {
  test('a night still in progress has no control — there is nothing settled to store', () => {
    setup(renderAsAdmin, { night: { ...FRESH, in_progress: true } });
    expect(screen.queryByRole('button', { name: /recompute this night/i })).not.toBeInTheDocument();
  });
});
