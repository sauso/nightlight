// "Up between X and Y" on the morning review screen (server field `wake_range`, set by
// backend/src/lib/wakeRange.js; its rules and routes are tested in backend/test/wake-range*.test.js).
//
// What matters here is what the PERSON is asked and what is SENT:
//   1. In range mode the review screen asks "Up between A and B. When did they get up?" and offers each end
//      and "Another time". A range can never be confirmed (the review stores ONE true wake), so there is no
//      "That's right" and no "Not quite".
//   2. Each "Around ..." button sends the SAME wake-only payload as "That's right" does (the wake in 'HH:MM',
//      the two echoes of what was on screen, the settings key, and nothing else), with that end's time.
//   3. Without a range nothing changes: the single-time question and its buttons are exactly as before.
//   4. The timezone gate applies to the new buttons: nothing that sends a time works before /settings arrives.
// The range is deliberately NOT on the child card or the sleep page (the hold-out put it on 33% of right nights);
// backend/test/wake-range-routes.test.js pins that those responses carry no such field.
//
// Melbourne is the fixture zone (UTC+10 in August; the browser is pinned to Pacific/Auckland by vite.config.js,
// so a time converted in the wrong zone is wrong in a way the assertions see).

import { describe, test, expect, vi, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Routes, Route } from 'react-router-dom';
import { renderAsAdmin } from './helpers/render.jsx';
import NightReview from '../src/pages/NightReview.jsx';
import { api } from '../src/lib/api.js';

// A successful save navigates away; as in MorningReview.test.jsx, keep the screen mounted for the assertions.
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, useNavigate: () => vi.fn() };
});

afterEach(() => vi.restoreAllMocks());

// 5:31 and 6:25 in Melbourne on the morning of 2026-08-29 (UTC+10): the exit-earlier-than-movement shape.
const EARLY = '2026-08-28 19:31:00';
const LATE = '2026-08-28 20:25:00';
// `\b` keeps "5:31" from matching inside "15:31" (the two zones' readings of one instant differ by ten hours).
const at = (h12, mm) => new RegExp(`\\b${h12}:${mm}\\b`);

// --- the review screen ---------------------------------------------------------------------------

const RANGE_NIGHT = {
  child_id: 'c-1',
  night_date: '2026-08-28',
  settings: { key: 'settings-key', tz: 'Australia/Melbourne' },
  computed: { status: 'ok', onset_at: '2026-08-28 09:33:00', in_bed_at: '2026-08-28 09:20:00', wake_at: EARLY },
  wake_range: { from: EARLY, to: LATE },
  review: null,
  transitions: [],
};
const SINGLE_NIGHT = { ...RANGE_NIGHT, wake_range: null };

const routed = <Routes><Route path="/children/:id/review/:date" element={<NightReview />} /></Routes>;
const mountReview = (night, opts = {}) => {
  vi.spyOn(api, 'get').mockResolvedValue(night);
  const put = vi.spyOn(api, 'put').mockResolvedValue({});
  const view = renderAsAdmin(routed, { kids: [{ id: 'c-1', name: 'Child A' }], route: '/children/c-1/review/2026-08-28', ...opts });
  return { put, ...view };
};
const buttons = () => screen.getAllByRole('button').map((b) => b.textContent);

describe('the review screen in range mode', () => {
  test('★ asks "Up between A and B. When did they get up?" with both ends and "Another time", and no confirm', async () => {
    mountReview(RANGE_NIGHT);
    const q = await screen.findByText(/Up between/);
    expect(q.textContent).toMatch(at(5, '31'));
    expect(q.textContent).toMatch(at(6, '25'));
    expect(q.textContent).toMatch(/When did they get up\?/);
    expect(screen.getByRole('button', { name: /^Around .*5:31/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Around .*6:25/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Another time' })).toBeInTheDocument();
    // A range cannot be confirmed: neither the confirm button nor its "Not quite" twin is offered.
    expect(buttons().join('|')).not.toMatch(/That.s right|Not quite/);
  });

  test('★ the two ends are equal choices: none of the three buttons is the accent-coloured primary', async () => {
    mountReview(RANGE_NIGHT);
    await screen.findByText(/Up between/);
    for (const name of [/^Around .*5:31/, /^Around .*6:25/, 'Another time']) {
      expect(screen.getByRole('button', { name })).not.toHaveClass('btn-primary');
    }
  });

  test('★ "Around" the earlier end sends exactly the wake-only payload with that time', async () => {
    const { put } = mountReview(RANGE_NIGHT);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /^Around .*5:31/ }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    const [path, body] = put.mock.calls[0];
    expect(path).toBe('/children/c-1/review/2026-08-28');
    // The key SET is compared, so a stray key (an onset, an in-bed time, a note, a verdict) fails by name.
    expect(body).toEqual({
      true_wake_local: '05:31',
      computed_onset_at: RANGE_NIGHT.computed.onset_at,
      computed_wake_at: RANGE_NIGHT.computed.wake_at,
      settings_key: 'settings-key',
    });
  });

  test('★ "Around" the later end sends that end, in home time (not the browser zone)', async () => {
    const { put } = mountReview(RANGE_NIGHT);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /^Around .*6:25/ }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put.mock.calls[0][1].true_wake_local).toBe('06:25');
    // The echo still names what was on screen as the detector's reported wake (the earlier end), not the choice.
    expect(put.mock.calls[0][1].computed_wake_at).toBe(EARLY);
  });

  test('★ "Another time" opens one EMPTY time input; Save waits for a typed time and sends it', async () => {
    const { put } = mountReview(RANGE_NIGHT);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Another time' }));
    expect(put).not.toHaveBeenCalled();
    const input = screen.getByLabelText('Got up for the day');
    // Neither estimate is pre-filled: the person just said neither was right.
    expect(input).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.getByText(/We said up between/)).toBeInTheDocument();
    // The range buttons are gone, and still no confirm.
    expect(buttons().join('|')).not.toMatch(/Around|That.s right|Not quite/);
    await user.type(input, '0610');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put.mock.calls[0][1]).toEqual({
      true_wake_local: '06:10',
      computed_onset_at: RANGE_NIGHT.computed.onset_at,
      computed_wake_at: RANGE_NIGHT.computed.wake_at,
      settings_key: 'settings-key',
    });
  });

  test('★ the timezone gate holds the new buttons: before /settings arrives they are disabled and send nothing', async () => {
    const { put } = mountReview(RANGE_NIGHT, { settingsLoaded: false, loading: true });
    const user = userEvent.setup();
    const another = await screen.findByRole('button', { name: 'Another time' });
    // The question (the only place the placeholder zone's times would show) is not drawn either.
    expect(screen.queryByText(/Up between/)).not.toBeInTheDocument();
    for (const b of screen.getAllByRole('button', { name: /^Around|^Another time/ })) expect(b).toBeDisabled();
    await user.click(another);
    expect(put).not.toHaveBeenCalled();
  });

  test('a night already answered shows the owner\'s single time even if a stale range arrives', async () => {
    mountReview({ ...RANGE_NIGHT, review: { true_wake_at: LATE } });
    await screen.findByLabelText('Got up for the day');
    expect(screen.queryByText(/Up between/)).not.toBeInTheDocument();
    expect(buttons().join('|')).not.toMatch(/Around/);
    expect(screen.getByLabelText('Got up for the day')).toHaveValue('06:25');
  });
});

describe('the review screen without a range is unchanged', () => {
  test('★ the single-time question, "That\'s right" and "Not quite" are all still there', async () => {
    mountReview(SINGLE_NIGHT);
    const q = await screen.findByText(/Is that right\?/);
    expect(q.textContent).toMatch(/Up at .*5:31/);
    expect(screen.getByRole('button', { name: /That.s right/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Not quite' })).toBeInTheDocument();
    expect(buttons().join('|')).not.toMatch(/Around|Another time/);
    expect(screen.queryByText(/Up between/)).not.toBeInTheDocument();
  });

  test('a page whose server predates the field (no wake_range key at all) behaves the same', async () => {
    const { wake_range, ...old } = RANGE_NIGHT; // eslint-disable-line no-unused-vars
    mountReview(old);
    expect(await screen.findByText(/Is that right\?/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /That.s right/ })).toBeInTheDocument();
  });

  test('"That\'s right" still sends the shown wake as before', async () => {
    const { put } = mountReview(SINGLE_NIGHT);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /That.s right/ }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put.mock.calls[0][1]).toEqual({
      true_wake_local: '05:31',
      computed_onset_at: SINGLE_NIGHT.computed.onset_at,
      computed_wake_at: SINGLE_NIGHT.computed.wake_at,
      settings_key: 'settings-key',
    });
  });
});


// Codex gpt-6-sol review of this change: the server resolves a typed 'HH:MM' to a day by the noon rule (before
// 12:00 = the morning after, otherwise the night's start date) and only the echoed `computed_wake_at` is exempt.
// An "Around" button sends just 'HH:MM', so with the two ends on opposite sides of noon the end that is not the
// echoed wake would land on the wrong day. The screen then asks the ordinary question instead.
describe('the review screen when the two ends straddle noon (home time)', () => {
  // Melbourne is UTC+10 in August: 01:00Z is 11:00 and 03:00Z is 13:00.
  const NOON_BEFORE = '2026-08-28 01:00:00';
  const NOON_AFTER = '2026-08-28 03:00:00';
  const night = (from, to) => ({
    ...RANGE_NIGHT,
    computed: { ...RANGE_NIGHT.computed, wake_at: from },
    wake_range: { from, to },
  });

  test('★ ends either side of noon: the ordinary "Up at ... Is that right?" question, no "Around" buttons', async () => {
    mountReview(night(NOON_BEFORE, NOON_AFTER));
    const q = await screen.findByText(/Is that right\?/);
    expect(q.textContent).toMatch(/Up at .*11:00/);
    expect(screen.getByRole('button', { name: /That.s right/ })).toBeInTheDocument();
    expect(buttons().join('|')).not.toMatch(/Around|Another time/);
    expect(screen.queryByText(/Up between/)).not.toBeInTheDocument();
  });

  test('★ the same straddle with the echoed wake on the later end behaves the same', async () => {
    const n = night(NOON_BEFORE, NOON_AFTER);
    n.computed.wake_at = NOON_AFTER;
    mountReview(n);
    expect(await screen.findByText(/Is that right\?/)).toBeInTheDocument();
    expect(buttons().join('|')).not.toMatch(/Around/);
  });

  test('both ends after noon is still range mode (only a straddle is excluded)', async () => {
    mountReview(night('2026-08-28 03:00:00', '2026-08-28 04:30:00')); // 13:00 and 14:30
    expect(await screen.findByText(/Up between/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Around .*1:00/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Around .*2:30/ })).toBeInTheDocument();
  });

  test('both ends before noon is range mode (the normal morning)', async () => {
    mountReview(RANGE_NIGHT);
    expect(await screen.findByText(/Up between/)).toBeInTheDocument();
  });
});
