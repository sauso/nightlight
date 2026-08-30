// The morning review — the card on the child's page and the screen behind it.
//
// Two things here are worth testing and neither is cosmetic:
//   1. THE CARD MUST GO AWAY AND STAY AWAY. Dismissing has to be as final as answering. A prompt that
//      reappears after being dismissed teaches the habit of ignoring it, and then the nights that
//      actually matter get ignored too — which would quietly destroy the feature's whole purpose.
//   2. THE BROWSER MUST NOT CONVERT TIMES. It sends the wall-clock 'HH:MM' that was typed and the
//      server resolves it against the app's configured timezone (the noon rule that decides which side
//      of midnight a bare time falls on is tested in backend/test/morning-review.test.js). Converting
//      here would use the PHONE's zone, so a review typed while travelling would disagree with the very
//      card it was correcting — silently, in the data everything else is scored against.

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { Routes, Route } from 'react-router-dom';
import { renderAsAdmin, renderAsCaregiver, forEachRole, renderAs } from './helpers/render.jsx';
import MorningReviewCard from '../src/components/MorningReviewCard.jsx';
import NightReview from '../src/pages/NightReview.jsx';
import { api } from '../src/lib/api.js';

const PENDING = {
  night_date: '2026-08-29',
  onset_at: '2026-08-29 09:33:00', // 19:33 Melbourne
  wake_at: '2026-08-29 19:48:00', // 05:48 Melbourne, the morning after
  transition_count: 4,
};

const fmtTime = (utc) => (utc ? String(utc).slice(11, 16) : '');

afterEach(() => vi.restoreAllMocks());

describe('the card that asks', () => {
  beforeEach(() => {
    vi.spyOn(api, 'get').mockResolvedValue({ pending: PENDING });
    vi.spyOn(api, 'put').mockResolvedValue({});
  });

  test('it offers the night, for either role', async () => {
    // Deliberately not admin-gated: the person who was in the room at 5am is the one who knows what
    // happened, and that is at least as likely to be a caregiver as the account holder.
    // AWAITED — see forEachRole. Unawaited, this test resolved before its only assertion ran and
    // passed against a card that rendered nothing at all.
    await forEachRole(async (name, who) => {
      const { unmount } = renderAs(who, <MorningReviewCard childId="c-1" fmtTime={fmtTime} />);
      expect(await screen.findByText(/Was last night right\?/)).toBeInTheDocument();
      unmount();
    });
  });

  test('it names the times and how many events there are to check', async () => {
    renderAsAdmin(<MorningReviewCard childId="c-1" fmtTime={fmtTime} />);
    expect(await screen.findByText(/fell asleep at 09:33/)).toBeInTheDocument();
    expect(screen.getByText(/4 recorded events/)).toBeInTheDocument();
  });

  test('one event reads "event", not "1 events"', async () => {
    api.get.mockResolvedValue({ pending: { ...PENDING, transition_count: 1 } });
    renderAsAdmin(<MorningReviewCard childId="c-1" fmtTime={fmtTime} />);
    expect(await screen.findByText(/1 recorded event(?!s)/)).toBeInTheDocument();
  });

  test('dismissing hides it immediately AND records the dismissal', async () => {
    // Both halves matter. Hiding without recording means it returns tomorrow; recording without hiding
    // means it sits there until a reload, which reads as broken.
    const { user } = renderAsAdmin(<MorningReviewCard childId="c-1" fmtTime={fmtTime} />);
    await screen.findByText(/Was last night right\?/);

    await user.click(screen.getByRole('button', { name: /dismiss/i }));

    expect(screen.queryByText(/Was last night right\?/)).not.toBeInTheDocument();
    await waitFor(() => expect(api.put).toHaveBeenCalledWith(
      '/children/c-1/review/2026-08-29',
      { dismissed: true }
    ));
  });

  test('a failed dismissal still hides the card rather than trapping the user', async () => {
    // The write failing means it comes back tomorrow. That is a far better failure than a card which
    // cannot be got rid of.
    api.put.mockRejectedValue(new Error('offline'));
    const { user } = renderAsAdmin(<MorningReviewCard childId="c-1" fmtTime={fmtTime} />);
    await screen.findByText(/Was last night right\?/);
    await user.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(screen.queryByText(/Was last night right\?/)).not.toBeInTheDocument();
  });

  test('nothing renders when there is nothing to review', async () => {
    api.get.mockResolvedValue({ pending: null });
    const { container } = renderAsAdmin(<MorningReviewCard childId="c-1" fmtTime={fmtTime} />);
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(container.querySelector('.review-card')).toBeNull();
  });

  test('a failed load renders nothing rather than an error', async () => {
    // The card is an invitation, not a feature. It must never be the reason a child's page looks broken.
    api.get.mockRejectedValue(new Error('offline'));
    const { container } = renderAsAdmin(<MorningReviewCard childId="c-1" fmtTime={fmtTime} />);
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(container.querySelector('.review-card')).toBeNull();
  });
});

describe('the review screen', () => {
  const NIGHT = {
    child_id: 'c-1',
    night_date: '2026-08-29',
    computed: { status: 'ok', onset_at: '2026-08-29 09:33:00', wake_at: '2026-08-29 19:48:00' },
    review: null,
    transitions: [
      { id: 11, type: 'out_of_bed', created_at: '2026-08-29 19:45:22', snapshot: 1, verdict: null, camera_name: 'Raffa Room' },
      { id: 12, type: 'into_bed', created_at: '2026-08-29 19:47:30', snapshot: 0, verdict: null, camera_name: 'Raffa Room' },
    ],
  };

  beforeEach(() => {
    vi.spyOn(api, 'get').mockResolvedValue(NIGHT);
    vi.spyOn(api, 'put').mockResolvedValue({});
    vi.spyOn(api, 'url').mockImplementation((p) => `/api${p}?token=t`);
  });

  // Mounted on a real Route: NightReview takes :id and :date from useParams, and rendered bare those
  // are undefined — which is a different screen from the one the app actually shows.
  const routed = <Routes><Route path="/children/:id/review/:date" element={<NightReview />} /></Routes>;
  const at = (renderer = renderAsAdmin) =>
    renderer(routed, { route: '/children/c-1/review/2026-08-29', kids: [{ id: 'c-1', name: 'Raffa' }] });

  test("it pre-fills with the app's own answer so confirming it is one tap", async () => {
    // "We were right" is the most valuable record and the one nobody writes down unaided.
    at();
    await waitFor(() => expect(screen.getByLabelText(/Fell asleep/)).toHaveValue('19:33'));
    expect(screen.getByLabelText(/Got up for the day/)).toHaveValue('05:48');
  });

  test('an event with a frame shows it; one without says so', async () => {
    at();
    await screen.findByText(/got out of bed/);
    const img = document.querySelector('.review-event__frame:not(.review-event__frame--none)');
    expect(img).toHaveAttribute('src', '/api/cameras/bed-transitions/11/snapshot?token=t');
    expect(screen.getByText('No frame')).toBeInTheDocument();
  });

  test('saving sends what was typed, as wall-clock, for the server to resolve', async () => {
    // The browser deliberately does NOT convert. The night spans midnight and the app has its own
    // configured timezone, so resolving 19:33 and 05:48 to instants is the server's job — doing it
    // here would use the phone's zone and disagree with the card being corrected.
    const { user } = at();
    await waitFor(() => expect(screen.getByLabelText(/Fell asleep/)).toHaveValue('19:33'));

    await user.click(screen.getByRole('button', { name: /Save review/ }));

    await waitFor(() => expect(api.put).toHaveBeenCalled());
    const [url, body] = api.put.mock.calls[0];
    expect(url).toBe('/children/c-1/review/2026-08-29');
    expect(body).toMatchObject({ true_onset_local: '19:33', true_wake_local: '05:48' });
  });

  test('a verdict can be set and un-set by tapping it again', async () => {
    // A mis-tap has to be undoable: a wrong label is worse than a missing one, because everything else
    // gets scored against it.
    const { user } = at();
    await screen.findByText(/got out of bed/);
    const yes = screen.getAllByRole('button', { name: /Yes/ })[0];

    await user.click(yes);
    expect(yes).toHaveAttribute('aria-pressed', 'true');
    await user.click(yes);
    expect(yes).toHaveAttribute('aria-pressed', 'false');

    await user.click(screen.getByRole('button', { name: /Save review/ }));
    await waitFor(() => expect(api.put).toHaveBeenCalled());
    expect(api.put.mock.calls[0][1].verdicts[11]).toBeNull();
  });

  test('verdicts are sent keyed by transition id', async () => {
    const { user } = at();
    await screen.findByText(/got out of bed/);
    await user.click(screen.getAllByRole('button', { name: /No/ })[0]);
    await user.click(screen.getByRole('button', { name: /Save review/ }));
    await waitFor(() => expect(api.put).toHaveBeenCalled());
    expect(api.put.mock.calls[0][1].verdicts).toMatchObject({ 11: 'wrong' });
  });

  test('an already-reviewed night comes back with what was said before', async () => {
    api.get.mockResolvedValue({
      ...NIGHT,
      review: { true_onset_at: '2026-08-29 09:30:00', true_wake_at: '2026-08-29 19:45:00', note: 'dressed on the bed' },
      transitions: [{ ...NIGHT.transitions[0], verdict: 'wrong' }],
    });
    at();
    await waitFor(() => expect(screen.getByLabelText(/Fell asleep/)).toHaveValue('19:30'));
    expect(screen.getByLabelText(/worth noting/)).toHaveValue('dressed on the bed');
    expect(screen.getAllByRole('button', { name: /No/ })[0]).toHaveAttribute('aria-pressed', 'true');
  });

  test('a night with no recorded events says so instead of showing an empty list', async () => {
    api.get.mockResolvedValue({ ...NIGHT, transitions: [] });
    at();
    expect(await screen.findByText(/nothing here to check/)).toBeInTheDocument();
  });

  test('a caregiver can review too', async () => {
    // The person who was in the room at 5am knows what happened; gating this to admins would lose
    // exactly the nights worth recording.
    at(renderAsCaregiver);
    expect(await screen.findByRole('button', { name: /Save review/ })).toBeInTheDocument();
  });

  test('a failed save surfaces the reason and leaves the form usable', async () => {
    api.put.mockRejectedValue(new Error('Not a valid verdict for transition 11'));
    const { user } = at();
    await screen.findByText(/got out of bed/);
    await user.click(screen.getByRole('button', { name: /Save review/ }));
    expect(await screen.findByText(/Not a valid verdict/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Save review/ })).toBeEnabled();
  });
});
