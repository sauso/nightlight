// The admin "Recompute this night" control.
//
// Two things are worth testing here and neither is cosmetic:
//   1. ROLE GATING — a caregiver must not be able to rewrite stored sleep history. The failure mode is
//      silent (the write just happens), which is exactly the shape of bug this project has shipped
//      before: an admin-only route that 403'd everyone, invisible until someone clicked it.
//   2. The dialog PREVIEWS before it writes. That is the whole point of the feature — it turns an
//      irreversible overwrite into something a person can read first — so "does it store without
//      asking" is a real regression to guard against.

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderAsAdmin, renderAsCaregiver } from './helpers/render.jsx';
import RecomputeNight from '../src/components/RecomputeNight.jsx';
import { api } from '../src/lib/api.js';

const NIGHT = {
  night_date: '2026-08-28',
  onset_at: '2026-08-28 06:56:00',
  wake_at: '2026-08-28 19:20:00',
  asleep_minutes: 598,
  awake_minutes: 146,
  wake_count: 3,
  in_progress: false,
};
// What the recompute returns: the corrected night, as it actually came out on prod.
const FIXED = { ...NIGHT, onset_at: '2026-08-28 10:15:00', asleep_minutes: 545, awake_minutes: 0, wake_count: 0 };

const fmtTime = (utc) => (utc ? String(utc).slice(11, 16) : '');

const setup = (renderer, props = {}) =>
  renderer(
    <RecomputeNight childId="c-1" date="2026-08-28" night={NIGHT} fmtTime={fmtTime} onRecomputed={props.onRecomputed || vi.fn()} />
  );

beforeEach(() => {
  vi.spyOn(api, 'get').mockResolvedValue(FIXED);
});
afterEach(() => {
  vi.restoreAllMocks();
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

describe('preview before writing', () => {
  test('pressing it previews without storing anything', async () => {
    const { user } = setup(renderAsAdmin);
    await user.click(screen.getByRole('button', { name: /recompute this night/i }));

    await waitFor(() => expect(screen.getByText(/different numbers/i)).toBeInTheDocument());
    // The preview must NOT carry store=1 — looking at a night can never overwrite it.
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.get.mock.calls[0][0]).not.toMatch(/store=1/);
  });

  test('the dialog shows before and after for every figure that moved', async () => {
    const { user } = setup(renderAsAdmin);
    await user.click(screen.getByRole('button', { name: /recompute this night/i }));

    await waitFor(() => expect(screen.getByText(/different numbers/i)).toBeInTheDocument());
    expect(screen.getByText('06:56')).toBeInTheDocument(); // the wrong stored bedtime
    expect(screen.getByText('10:15')).toBeInTheDocument(); // the corrected one
    expect(screen.getByText('9h 58m')).toBeInTheDocument();
    expect(screen.getByText('9h 5m')).toBeInTheDocument();
  });

  test('saving is what stores, and it reports the result upwards', async () => {
    const onRecomputed = vi.fn();
    const { user } = setup(renderAsAdmin, { onRecomputed });
    await user.click(screen.getByRole('button', { name: /recompute this night/i }));
    await waitFor(() => expect(screen.getByText(/different numbers/i)).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /save the new numbers/i }));
    await waitFor(() => expect(onRecomputed).toHaveBeenCalledWith(FIXED));
    expect(api.get.mock.calls.at(-1)[0]).toMatch(/store=1/);
  });

  test('cancelling closes the dialog and stores nothing', async () => {
    const { user } = setup(renderAsAdmin);
    await user.click(screen.getByRole('button', { name: /recompute this night/i }));
    await waitFor(() => expect(screen.getByText(/different numbers/i)).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /^cancel$/i }));
    await waitFor(() => expect(screen.queryByText(/different numbers/i)).not.toBeInTheDocument());
    expect(api.get.mock.calls.filter(([u]) => /store=1/.test(u))).toHaveLength(0);
  });
});

describe('the cases where there is nothing to do', () => {
  test('an unchanged night offers no save button', async () => {
    api.get.mockResolvedValue(NIGHT); // recompute agrees with what is stored
    const { user } = setup(renderAsAdmin);
    await user.click(screen.getByRole('button', { name: /recompute this night/i }));

    await waitFor(() => expect(screen.getByText(/exactly the same numbers/i)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /save the new numbers/i })).not.toBeInTheDocument();
  });

  test('a night still in progress has no control — there is nothing settled to store', () => {
    renderAsAdmin(
      <RecomputeNight childId="c-1" date="2026-08-28" night={{ ...NIGHT, in_progress: true }}
        fmtTime={fmtTime} onRecomputed={vi.fn()} />
    );
    expect(screen.queryByRole('button', { name: /recompute this night/i })).not.toBeInTheDocument();
  });

  test('a refused save surfaces the reason instead of failing silently', async () => {
    // The backend answers 409 when a night's samples have aged out. The user has to be told why, or
    // the button looks broken.
    const { user } = setup(renderAsAdmin);
    await user.click(screen.getByRole('button', { name: /recompute this night/i }));
    await waitFor(() => expect(screen.getByText(/different numbers/i)).toBeInTheDocument());

    api.get.mockRejectedValueOnce(new Error("This night can't be re-scored: its minute-by-minute data has aged out"));
    await user.click(screen.getByRole('button', { name: /save the new numbers/i }));
    await waitFor(() => expect(screen.getByText(/aged out/i)).toBeInTheDocument());
  });
});
