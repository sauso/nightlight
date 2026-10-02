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
import { screen, waitFor, within } from '@testing-library/react';
import { Routes, Route } from 'react-router-dom';
import { renderAsAdmin, renderAsCaregiver, forEachRole, renderAs } from './helpers/render.jsx';
import MorningReviewCard from '../src/components/MorningReviewCard.jsx';
import NightReview from '../src/pages/NightReview.jsx';
import { api } from '../src/lib/api.js';

// `useNavigate` is a no-op across this whole file. NightReview navigates away on every successful save
// (see saveNobody/save), which — under the real router — unmounts the screen the moment a save
// succeeds. No test here asserts on where navigate actually goes (only on `api.put` calls and on-screen
// text), so this changes nothing any existing test would notice, and it is what makes the mutant-killing
// "touched flag survives a late reseed" test below observable at all: without it, the component would be
// gone before the late reseed it needs to provoke could even run.
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, useNavigate: () => vi.fn() };
});

const PENDING = {
  state: 'ask',
  night_date: '2026-08-29',
  onset_at: '2026-08-29 09:33:00', // 19:33 Melbourne
  wake_at: '2026-08-29 19:48:00', // 05:48 Melbourne, the morning after
  transition_count: 4,
};

const fmtTime = (utc) => (utc ? String(utc).slice(11, 16) : '');

afterEach(() => vi.restoreAllMocks());

describe('the card that asks', () => {
  beforeEach(() => {
    vi.spyOn(api, 'get').mockResolvedValue(PENDING);
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
    api.get.mockResolvedValue({ ...PENDING, transition_count: 1 });
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
    api.get.mockResolvedValue({ state: 'none' });
    const { container } = renderAsAdmin(<MorningReviewCard childId="c-1" fmtTime={fmtTime} />);
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(container.querySelector('.review-card')).toBeNull();
  });

  test('an answered night shows a receipt with a way back in, not nothing', async () => {
    // Vanishing on save is indistinguishable from failing, which is how this first landed.
    api.get.mockResolvedValue({
      state: 'done',
      night_date: '2026-08-29',
      true_onset_at: '2026-08-29 09:33:00',
      true_wake_at: '2026-08-29 19:29:00',
    });
    renderAsAdmin(<MorningReviewCard childId="c-1" fmtTime={fmtTime} />);
    expect(await screen.findByText(/that.s recorded/i)).toBeInTheDocument();
    expect(screen.getByText(/Tap to change it/)).toBeInTheDocument();
  });

  test('"no one was in the bed" gets its own receipt line, not "You said — to —"', async () => {
    // reviewCardState returns `nobody_in_bed` as a REAL boolean (unlike GET /review's raw 0/1 column),
    // so `true` here is the actual server shape, not a stand-in. Without ReviewReceipt's own branch for
    // it, a flag-only night falls into the `fmtTime(undefined) || '—'` path and reads as "You said — to
    // —" — a blank-looking receipt for what was a complete, deliberate answer.
    api.get.mockResolvedValue({
      state: 'done',
      night_date: '2026-08-29',
      true_onset_at: null,
      true_wake_at: null,
      nobody_in_bed: true,
    });
    renderAsAdmin(<MorningReviewCard childId="c-1" fmtTime={fmtTime} />);
    expect(await screen.findByText(/that.s recorded/i)).toBeInTheDocument();
    expect(screen.getByText('You said no one was in the bed. Tap to change it.')).toBeInTheDocument();
    expect(screen.queryByText(/— to —/)).not.toBeInTheDocument();
  });

  test('★ an in-bed answer reads back as "in bed, asleep … to …", with the resolved times', async () => {
    // reviewCardState's done state since 2026-09-30: `onset_at`/`wake_at` are RESOLVED (the parent's where
    // they gave one, otherwise the stored detector time), `true_in_bed_at` is the put-down they gave. An
    // in-bed-only answer has no true_onset_at or true_wake_at at all, so reading those would say "— to —".
    api.get.mockResolvedValue({
      state: 'done',
      night_date: '2026-08-29',
      true_onset_at: null,
      true_wake_at: null,
      nobody_in_bed: false,
      true_in_bed_at: '2026-08-29 08:49:00',
      onset_at: '2026-08-29 09:13:00',
      wake_at: '2026-08-29 20:37:00',
    });
    renderAsAdmin(<MorningReviewCard childId="c-1" fmtTime={fmtTime} />);
    expect(await screen.findByText('You said in bed 08:49, asleep 09:13 to 20:37. Tap to change it.')).toBeInTheDocument();
    expect(screen.queryByText(/— to —/)).not.toBeInTheDocument();
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
      { id: 11, type: 'out_of_bed', created_at: '2026-08-29 19:45:22', snapshot: 1, verdict: null, camera_name: 'Child B Room' },
      { id: 12, type: 'into_bed', created_at: '2026-08-29 19:47:30', snapshot: 0, verdict: null, camera_name: 'Child B Room' },
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
    renderer(routed, { route: '/children/c-1/review/2026-08-29', kids: [{ id: 'c-1', name: 'Child B' }] });

  // The event list is collapsed by default — a night carries 20-35 transitions and opening straight
  // into a wall of frames buries the two times that matter. Tests that care about events open it.
  const openEvents = async (user) =>
    user.click(await screen.findByRole('button', { name: /recorded events/ }));

  test("it shows the app's own answer, and confirming it is one tap", async () => {
    // "We were right" is the most valuable record and the one nobody writes down unaided — so it has
    // to be a single deliberate button, not a form you scroll past.
    at();
    expect(await screen.findByRole('button', { name: /That.s right/ })).toBeInTheDocument();
    expect(screen.getByText('19:33')).toBeInTheDocument();
    expect(screen.getByText('05:48')).toBeInTheDocument();
  });

  test('an event with a frame shows it; one without says so', async () => {
    const { user } = at();
    await openEvents(user);
    await screen.findByText(/got out of bed/);
    const img = document.querySelector('.review-event__frame:not(.review-event__frame--none)');
    expect(img).toHaveAttribute('src', '/api/cameras/bed-transitions/11/snapshot?token=t');
    expect(screen.getByText('No frame')).toBeInTheDocument();
  });

  describe('enlarging a snapshot', () => {
    // Clicking a thumbnail opens the same photo full-size in a modal, for frames that are too small
    // or too dim to judge at 160x120 — the owner's own words: some are "hard to confirm".
    test('clicking a thumbnail in the event list opens it enlarged, and it can be closed', async () => {
      const { user } = at();
      await openEvents(user);
      await screen.findByText(/got out of bed/);

      await user.click(screen.getByRole('button', { name: /Enlarge photo/ }));

      const big = await screen.findByRole('dialog');
      const bigImg = big.querySelector('.image-preview');
      expect(bigImg).toHaveAttribute('src', '/api/cameras/bed-transitions/11/snapshot?token=t');
      expect(within(big).getByText('Child B Room')).toBeInTheDocument();

      await user.click(within(big).getByRole('button', { name: /close/i }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    // A transition with no snapshot renders the "No frame" placeholder, not an image — there is
    // nothing to enlarge, so it must not be wrapped in a button either.
    test('a transition with no frame is not clickable', async () => {
      const { user } = at();
      await openEvents(user);
      await screen.findByText('No frame');
      expect(screen.queryAllByRole('button', { name: /Enlarge photo/ })).toHaveLength(1);
    });

    test('the quick check-in thumbnail enlarges too', async () => {
      api.get.mockResolvedValue({
        ...NIGHT,
        transitions: [
          { id: 21, type: 'into_bed', created_at: '2026-08-29 09:51:00', snapshot: 1, verdict: null, camera_name: 'Child B Room', quick_reversal_of: null, quick_reversal_gap_s: null },
          { id: 22, type: 'out_of_bed', created_at: '2026-08-29 09:51:14', snapshot: 1, verdict: null, camera_name: 'Child B Room', quick_reversal_of: 21, quick_reversal_gap_s: 14 },
        ],
      });
      const { user } = at();
      await screen.findByText('Quick check-in?');

      await user.click(screen.getByRole('button', { name: /Enlarge photo/ }));

      const big = await screen.findByRole('dialog');
      expect(big.querySelector('.image-preview')).toHaveAttribute('src', '/api/cameras/bed-transitions/22/snapshot?token=t');
    });
  });

  test('saving sends what was typed, as wall-clock, for the server to resolve', async () => {
    // The browser deliberately does NOT convert. The night spans midnight and the app has its own
    // configured timezone, so resolving 19:33 and 05:48 to instants is the server's job — doing it
    // here would use the phone's zone and disagree with the card being corrected.
    const { user } = at();
    await user.click(await screen.findByRole('button', { name: /Not quite/ }));
    await waitFor(() => expect(screen.getByLabelText(/Fell asleep/)).toHaveValue('19:33'));

    await user.click(screen.getByRole('button', { name: /Save review/ }));

    await waitFor(() => expect(api.put).toHaveBeenCalled());
    const [url, body] = api.put.mock.calls[0];
    expect(url).toBe('/children/c-1/review/2026-08-29');
    expect(body).toMatchObject({ true_onset_local: '19:33', true_wake_local: '05:48' });
  });

  test('it sends back WHAT IT SHOWED, so the server can record it beside the answer', async () => {
    // This is the assertion whose absence let a broken feature ship. The server was changed to store
    // the client's echo instead of recomputing — and the client was never changed to send it, so every
    // review recorded "the app had no opinion", which was false for every single one of them. The
    // backend tests passed because they send the fields explicitly.
    const { user } = at();
    await screen.findByRole('button', { name: /That.s right/ });
    await user.click(screen.getByRole('button', { name: /That.s right/ }));

    await waitFor(() => expect(api.put).toHaveBeenCalled());
    expect(api.put.mock.calls[0][1]).toMatchObject({
      computed_onset_at: '2026-08-29 09:33:00',
      computed_wake_at: '2026-08-29 19:48:00',
    });
  });

  test('the app\'s answer is NOT one reflex tap from becoming ground truth', async () => {
    // A pre-filled form saves by reflex, and the app's answer is sometimes badly wrong — a drifted
    // wake of 08:29 against a real 06:00. On first real use exactly that got blessed as "truth".
    // Confirming and correcting are now separate, deliberate acts.
    at();
    await screen.findByRole('button', { name: /That.s right/ });
    expect(screen.queryByLabelText(/Fell asleep/)).not.toBeInTheDocument();

    const { user } = { user: (await import('@testing-library/user-event')).default.setup() };
    await user.click(screen.getByRole('button', { name: /Not quite/ }));
    expect(await screen.findByLabelText(/Fell asleep/)).toHaveValue('19:33');
  });

  test('a verdict can be set and un-set by tapping it again', async () => {
    // A mis-tap has to be undoable: a wrong label is worse than a missing one, because everything else
    // gets scored against it.
    const { user } = at();
    await openEvents(user);
    await screen.findByText(/got out of bed/);
    const yes = screen.getAllByRole('button', { name: /Yes/ })[0];

    await user.click(yes);
    expect(yes).toHaveAttribute('aria-pressed', 'true');
    await user.click(yes);
    expect(yes).toHaveAttribute('aria-pressed', 'false');

    await user.click(screen.getByRole('button', { name: /Save just the event answers/ }));
    await waitFor(() => expect(api.put).toHaveBeenCalled());
    expect(api.put.mock.calls[0][1].verdicts[11]).toBeNull();
  });

  test('verdicts are sent keyed by transition id', async () => {
    const { user } = at();
    await openEvents(user);
    await screen.findByText(/got out of bed/);
    await user.click(screen.getAllByRole('button', { name: /^No$/ })[0]);
    await user.click(screen.getByRole('button', { name: /Save just the event answers/ }));
    await waitFor(() => expect(api.put).toHaveBeenCalled());
    expect(api.put.mock.calls[0][1].verdicts).toMatchObject({ 11: 'wrong' });
  });

  test('an already-reviewed night comes back with what was said before', async () => {
    api.get.mockResolvedValue({
      ...NIGHT,
      review: { true_onset_at: '2026-08-29 09:30:00', true_wake_at: '2026-08-29 19:45:00', note: 'dressed on the bed' },
      transitions: [{ ...NIGHT.transitions[0], verdict: 'wrong' }],
    });
    const { user } = at();
    // Already answered, so it opens straight into the values it recorded — coming back to change one
    // thing must not make you confirm from scratch.
    await waitFor(() => expect(screen.getByLabelText(/Fell asleep/)).toHaveValue('19:30'));
    expect(screen.getByLabelText(/worth noting/)).toHaveValue('dressed on the bed');
    await openEvents(user);
    expect(screen.getAllByRole('button', { name: /^No$/ })[0]).toHaveAttribute('aria-pressed', 'true');
  });

  test('the event list is collapsed until asked for, so the times are not buried', async () => {
    // 31 events on a real night. Opening into that wall is what the owner called "flooded with in and
    // out of bed" — and it hid the two times the screen exists to confirm.
    const { user } = at();
    expect(await screen.findByRole('button', { name: /Check the 2 recorded events/ })).toBeInTheDocument();
    expect(screen.queryByText(/got out of bed/)).not.toBeInTheDocument();

    await openEvents(user);
    expect(await screen.findByText(/got out of bed/)).toBeInTheDocument();
  });

  describe('lingering motion prompts', () => {
    // Same shape as the backend evidence-precedes-display regression: oldest exit at
    // 20:00:30 local, motion at 20:01-20:04, newest exit at 20:06 with no later movement.
    const LINGERING_NIGHT = {
      ...NIGHT,
      transitions: [
        { id: 41, type: 'out_of_bed', created_at: '2026-08-29 10:00:30', snapshot: 0, verdict: null, camera_name: 'Child B Room', quick_reversal_of: null, lingering_motion_minutes: null, lingering_motion_gap_s: null },
        { id: 42, type: 'out_of_bed', created_at: '2026-08-29 10:06:00', snapshot: 1, verdict: null, camera_name: 'Child B Room', quick_reversal_of: null, lingering_motion_minutes: 4, lingering_motion_gap_s: 30 },
      ],
    };

    test('shows separate-minute evidence without claiming it followed the displayed exit or was continuous', async () => {
      api.get.mockResolvedValue(LINGERING_NIGHT);
      at();
      const card = (await screen.findByText('Still moving?')).closest('.card');
      expect(within(card).getByText(/Recorded as out of bed at 20:06/)).toHaveTextContent(
        'Recorded as out of bed at 20:06 — the bed also showed movement in 4 separate minutes with no return logged in between. What actually happened?'
      );
      // "then"/"since"/"later" all imply the movement followed the displayed exit chronologically —
      // which is exactly the claim that can be false for a same-direction run's reported (newest)
      // member, whose evidence is anchored at the run's OLDEST member instead. Found by an adversarial
      // pre-merge review (Codex, gpt-6-astra), 2026-09-14: the first fix removed "after"/"kept moving"
      // but left "then" carrying the identical implication, and this forbidden-word list didn't catch
      // it either.
      expect(card.textContent).not.toMatch(/\bafter\b|\bthen\b|\bsince\b|\blater\b|kept moving|more minutes|continuously|ongoing/i);
      expect(screen.getByRole('button', { name: /Check the 2 recorded events/ })).toBeInTheDocument();
    });

    test('an ordinary night has no lingering prompt', async () => {
      at();
      await screen.findByRole('button', { name: /That.s right/ });
      expect(screen.queryByText('Still moving?')).not.toBeInTheDocument();
    });

    test.each([
      ['No, still in bed', 'wrong'],
      ['Yes, they got up', 'correct'],
      ['Not sure', 'unclear'],
    ])('answering "%s" saves %s on the displayed exit', async (label, verdict) => {
      api.get.mockResolvedValue(LINGERING_NIGHT);
      const { user } = at();
      await user.click(await screen.findByRole('button', { name: label, exact: true }));
      await user.click(screen.getByRole('button', { name: /Save just the event answers/ }));
      await waitFor(() => expect(api.put).toHaveBeenCalled());
      expect(api.put.mock.calls[0][1].verdicts).toMatchObject({ 42: verdict });
      expect(api.put.mock.calls[0][1].verdicts[41]).toBeUndefined();
    });

    test('save is available while the full event list stays collapsed', async () => {
      api.get.mockResolvedValue(LINGERING_NIGHT);
      at();
      expect(await screen.findByRole('button', { name: /Save just the event answers/ })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Check the 2 recorded events/ })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Up for the day here/ })).not.toBeInTheDocument();
    });

    test('a double-flagged exit renders exactly one quick check-in card and one verdict set', async () => {
      api.get.mockResolvedValue({
        ...NIGHT,
        transitions: [
          { id: 21, type: 'into_bed', created_at: '2026-08-29 09:51:00', snapshot: 0, verdict: null },
          { id: 22, type: 'out_of_bed', created_at: '2026-08-29 09:51:14', snapshot: 0, verdict: null, quick_reversal_of: 21, quick_reversal_gap_s: 14, lingering_motion_minutes: 4, lingering_motion_gap_s: 46 },
        ],
      });
      at();
      expect(await screen.findAllByText('Quick check-in?')).toHaveLength(1);
      expect(screen.queryByText('Still moving?')).not.toBeInTheDocument();
      expect(document.querySelectorAll('.review-event__verdicts')).toHaveLength(1);
      expect(screen.getAllByRole('button', { name: 'Not sure', exact: true })).toHaveLength(1);
    });

    test('different quick and lingering exits each get an independently answerable card', async () => {
      api.get.mockResolvedValue({
        ...LINGERING_NIGHT,
        transitions: [
          { id: 21, type: 'into_bed', created_at: '2026-08-29 09:51:00', snapshot: 0, verdict: null },
          { id: 22, type: 'out_of_bed', created_at: '2026-08-29 09:51:14', snapshot: 0, verdict: null, quick_reversal_of: 21, quick_reversal_gap_s: 14 },
          ...LINGERING_NIGHT.transitions,
        ],
      });
      const { user } = at();
      const quick = (await screen.findByText('Quick check-in?')).closest('.card');
      const lingering = screen.getByText('Still moving?').closest('.card');
      await user.click(within(quick).getByRole('button', { name: 'They got up', exact: true }));
      expect(within(lingering).getByRole('button', { name: 'No, still in bed' })).toHaveAttribute('aria-pressed', 'false');
      await user.click(within(lingering).getByRole('button', { name: 'No, still in bed' }));
      expect(within(quick).getByRole('button', { name: 'They got up', exact: true })).toHaveAttribute('aria-pressed', 'true');
      await user.click(screen.getByRole('button', { name: /Save just the event answers/ }));
      await waitFor(() => expect(api.put).toHaveBeenCalled());
      expect(api.put.mock.calls[0][1].verdicts).toMatchObject({ 22: 'correct', 42: 'wrong' });
    });

    test('answering before the timezone arrives preserves the verdict while reseeding onset and wake', async () => {
      api.get.mockResolvedValue(LINGERING_NIGHT);
      const { user, rerenderWith } = renderAsAdmin(routed, {
        route: '/children/c-1/review/2026-08-29',
        kids: [{ id: 'c-1', name: 'Child B' }],
        settings: { timezone: 'UTC' },
      });
      await user.click(await screen.findByRole('button', { name: 'No, still in bed' }));
      rerenderWith({ settings: { timezone: 'Australia/Melbourne' } });
      await waitFor(() => expect(screen.getByText('19:33')).toBeInTheDocument());
      expect(screen.getByText('05:48')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: /That.s right/ }));
      await waitFor(() => expect(api.put).toHaveBeenCalled());
      expect(api.put.mock.calls[0][1].verdicts).toMatchObject({ 42: 'wrong' });
    });

    test('the lingering snapshot opens the existing full-size preview', async () => {
      api.get.mockResolvedValue(LINGERING_NIGHT);
      const { user } = at();
      await user.click(await screen.findByRole('button', { name: 'Enlarge photo' }));
      const dialog = await screen.findByRole('dialog');
      expect(dialog.querySelector('.image-preview')).toHaveAttribute('src', '/api/cameras/bed-transitions/42/snapshot?token=t');
    });
  });

  describe('quick check-in (an entry immediately undone by an exit)', () => {
    const QUICK_NIGHT = {
      ...NIGHT,
      // created_at is UTC; the app's timezone in these tests is Melbourne (+10, see NIGHT's own
      // 09:33 UTC -> 19:33 local assertion above) — 09:51 UTC is 19:51 local, not 19:51 UTC itself.
      transitions: [
        { id: 21, type: 'into_bed', created_at: '2026-08-29 09:51:00', snapshot: 1, verdict: null, camera_name: 'Child B Room', quick_reversal_of: null, quick_reversal_gap_s: null },
        { id: 22, type: 'out_of_bed', created_at: '2026-08-29 09:51:14', snapshot: 1, verdict: null, camera_name: 'Child B Room', quick_reversal_of: 21, quick_reversal_gap_s: 14 },
      ],
    };

    test('an ordinary night with no quick reversal shows no prompt, and no save-just-answers button', async () => {
      // NIGHT's fixture has no quick_reversal_of on either transition — the prompt must not appear
      // just because SOME transitions exist, and the save button gained a second way to appear
      // (quickReversals.length > 0) that must not fire when there's nothing to answer.
      at();
      await screen.findByRole('button', { name: /That.s right/ });
      expect(screen.queryByText(/Quick check-in/)).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Save just the event answers/ })).not.toBeInTheDocument();
    });

    test('a quick reversal shows the check-in prompt WITHOUT opening the collapsed event list', async () => {
      api.get.mockResolvedValue(QUICK_NIGHT);
      at();
      expect(await screen.findByText('Quick check-in?')).toBeInTheDocument();
      expect(screen.getByText(/Got into bed at 19:51, then got out of bed again 14s later/)).toBeInTheDocument();
      // The full list stays collapsed — this is a SEPARATE, always-visible prompt, not a reason to
      // flood the screen the way the owner already complained about once.
      expect(screen.getByRole('button', { name: /Check the 2 recorded events/ })).toBeInTheDocument();
    });

    test('answering "That was me" saves it as the out_of_bed being wrong, not the into_bed', async () => {
      api.get.mockResolvedValue(QUICK_NIGHT);
      const { user } = at();
      await user.click(await screen.findByRole('button', { name: /That was me/ }));
      await user.click(screen.getByRole('button', { name: /Save just the event answers/ }));

      await waitFor(() => expect(api.put).toHaveBeenCalled());
      expect(api.put.mock.calls[0][1].verdicts).toMatchObject({ 22: 'wrong' });
      expect(api.put.mock.calls[0][1].verdicts[21]).toBeUndefined();
    });

    test('answering "They got up" saves it as correct', async () => {
      api.get.mockResolvedValue(QUICK_NIGHT);
      const { user } = at();
      await user.click(await screen.findByRole('button', { name: /They got up/ }));
      await user.click(screen.getByRole('button', { name: /Save just the event answers/ }));

      await waitFor(() => expect(api.put).toHaveBeenCalled());
      expect(api.put.mock.calls[0][1].verdicts).toMatchObject({ 22: 'correct' });
    });

    test('the save button for it appears even with the full event list still collapsed', async () => {
      // Before this, "Save just the event answers" only appeared once showEvents was toggled — which
      // this prompt deliberately never does. Without this fix, an answer here would have no save path.
      api.get.mockResolvedValue(QUICK_NIGHT);
      at();
      expect(await screen.findByRole('button', { name: /Save just the event answers/ })).toBeInTheDocument();
    });

    test('two reversals in one night each get their own prompt, answered independently', async () => {
      api.get.mockResolvedValue({
        ...NIGHT,
        transitions: [
          ...QUICK_NIGHT.transitions,
          { id: 31, type: 'into_bed', created_at: '2026-08-29 19:00:00', snapshot: 0, verdict: null, camera_name: 'Child B Room', quick_reversal_of: null, quick_reversal_gap_s: null },
          { id: 32, type: 'out_of_bed', created_at: '2026-08-29 19:00:20', snapshot: 0, verdict: null, camera_name: 'Child B Room', quick_reversal_of: 31, quick_reversal_gap_s: 20 },
        ],
      });
      const { user } = at();
      expect(await screen.findAllByText('Quick check-in?')).toHaveLength(2);

      // Answer only the second one — the first must stay untouched.
      await user.click(screen.getAllByRole('button', { name: /They got up/ })[1]);
      await user.click(screen.getByRole('button', { name: /Save just the event answers/ }));

      await waitFor(() => expect(api.put).toHaveBeenCalled());
      expect(api.put.mock.calls[0][1].verdicts).toMatchObject({ 32: 'correct' });
      expect(api.put.mock.calls[0][1].verdicts[22]).toBeUndefined();
    });

    test('answering it first does not freeze onset/wake at the wrong timezone', async () => {
      // Found in adversarial review, 2026-09-13: the verdict buttons set the SAME `touched` flag a
      // time edit does, and unlike the old opt-in collapsed list, this prompt is often the very FIRST
      // tap on the page — so answering it before /settings resolves (it starts at UTC, see the fetch
      // effect's own comment) would have permanently frozen onset/wake in the wrong zone. Mirrors the
      // existing "typing survives the timezone arriving" test, substituting a verdict tap for typing.
      api.get.mockResolvedValue(QUICK_NIGHT);
      const { user, rerenderWith } = renderAsAdmin(routed, {
        route: '/children/c-1/review/2026-08-29',
        kids: [{ id: 'c-1', name: 'Child B' }],
        settings: { timezone: 'UTC' }, // as it is for the first moments after a reload
      });

      await user.click(await screen.findByRole('button', { name: /They got up/ }));

      // /settings resolves and the real zone replaces the placeholder, AFTER the verdict tap.
      rerenderWith({ settings: { timezone: 'Australia/Melbourne' } });
      await waitFor(() => expect(screen.getByText('19:33')).toBeInTheDocument());
      expect(screen.getByText('05:48')).toBeInTheDocument();

      // And the verdict answered before the zone resolved must have survived the reseed too.
      await user.click(screen.getByRole('button', { name: /That.s right/ }));
      await waitFor(() => expect(api.put).toHaveBeenCalled());
      expect(api.put.mock.calls[0][1].verdicts).toMatchObject({ 22: 'correct' });
    });
  });

  test('typing survives the timezone arriving — the form must not reset under you', async () => {
    // THE regression test for a real data loss. SettingsContext starts at its defaults (timezone
    // 'UTC') and replaces them when /settings resolves, so `tz` changes a moment after boot. With `tz`
    // in the fetch effect's dependencies, that re-ran, re-fetched and re-seeded the inputs — silently
    // discarding whatever had been typed in between. The owner corrected a wake to 05:52, watched it
    // save as 08:29, and had no way of knowing why.
    const { user, rerenderWith } = renderAsAdmin(routed, {
      route: '/children/c-1/review/2026-08-29',
      kids: [{ id: 'c-1', name: 'Child B' }],
      settings: { timezone: 'UTC' }, // as it is for the first moments after a reload
    });

    await user.click(await screen.findByRole('button', { name: /Not quite/ }));
    const wake = screen.getByLabelText(/Got up for the day/);
    await user.clear(wake);
    await user.type(wake, '05:52');
    expect(wake).toHaveValue('05:52');

    // /settings resolves and the real zone replaces the placeholder.
    rerenderWith({ settings: { timezone: 'Australia/Melbourne' } });

    await waitFor(() => expect(screen.getByLabelText(/Got up for the day/)).toHaveValue('05:52'));
  });

  test('naming a frame fills the time and sends WHICH frame it was', async () => {
    const { user } = at();
    await openEvents(user);
    await user.click(await screen.findByRole('button', { name: /Up for the day here/ }));

    // The filled time has to be VISIBLE — otherwise there is no way to tell which frame you picked, or
    // that picking one did anything at all. The event is 19:45:22 UTC, which is 05:45 in Melbourne.
    expect(screen.getByLabelText(/Got up for the day/)).toHaveValue('05:45');

    await user.click(screen.getByRole('button', { name: /Save review/ }));
    await waitFor(() => expect(api.put).toHaveBeenCalled());
    expect(api.put.mock.calls[0][1]).toMatchObject({ true_wake_transition_id: 11 });
  });

  test('naming a frame is a DIFFERENT act from saying the event is correct', async () => {
    // An exit can be perfectly real and still not be the end of the night: 05:45 was a genuine
    // got-out-of-bed on a morning the child went back and got up again at 06:00. Tying the wake to the
    // "correct" verdict would have ended that night at the wrong one.
    const { user } = at();
    await openEvents(user);
    await user.click(screen.getAllByRole('button', { name: /Yes/ })[0]);

    await user.click(screen.getByRole('button', { name: /Save just the event answers/ }));
    await waitFor(() => expect(api.put).toHaveBeenCalled());
    const body = api.put.mock.calls[0][1];
    expect(body.verdicts).toMatchObject({ 11: 'correct' });
    expect(body.true_wake_transition_id).toBeUndefined();
  });

  // --- "in bed" is not "asleep" (2026-09-30) -----------------------------------------------------------
  //
  // Rewritten from "a put-down frame fills the bedtime", which pinned the bug itself: on the night of
  // 2026-09-29 the detector had a child asleep at 19:13 (right), they had been put down at 18:49 for a bedtime
  // story, and "Put down here" wrote 18:49 into "Fell asleep". Night of 2026-08-29, Melbourne (+10).
  const STORY_NIGHT = {
    ...NIGHT,
    computed: { status: 'ok', in_bed_at: '2026-08-29 09:10:00', onset_at: '2026-08-29 09:13:00', wake_at: '2026-08-29 20:37:00' },
    transitions: [
      { id: 31, type: 'into_bed', created_at: '2026-08-29 08:49:20', snapshot: 1, verdict: null, camera_name: 'Bedroom A' }, // 18:49:20
      { id: 32, type: 'into_bed', created_at: '2026-08-29 09:13:05', snapshot: 1, verdict: null, camera_name: 'Bedroom A' }, // 19:13:05
      { id: 33, type: 'out_of_bed', created_at: '2026-08-29 20:37:40', snapshot: 1, verdict: null, camera_name: 'Bedroom A' }, // 06:37:40
    ],
  };
  const storyRow = (id) => document.querySelector(`.review-event img[src*="/bed-transitions/${id}/"]`)?.closest('.review-event');
  const saveReview = async (user) => {
    await user.click(screen.getByRole('button', { name: /Save review/ }));
    await waitFor(() => expect(api.put).toHaveBeenCalled());
    return api.put.mock.calls[0][1];
  };

  test('a got-into-bed row offers TWO moments, "Put down here" and "Asleep here"; a got-out-of-bed row one', async () => {
    api.get.mockResolvedValue(STORY_NIGHT);
    const { user } = at();
    await openEvents(user);
    await waitFor(() => expect(storyRow(31)).toBeTruthy());
    for (const id of [31, 32]) {
      expect(within(storyRow(id)).getByRole('button', { name: /Put down here/ })).toBeInTheDocument();
      expect(within(storyRow(id)).getByRole('button', { name: /Asleep here/ })).toBeInTheDocument();
      expect(within(storyRow(id)).queryByRole('button', { name: /Up for the day here/ })).toBeNull();
    }
    const exit = storyRow(33);
    expect(within(exit).getByRole('button', { name: /Up for the day here/ })).toBeInTheDocument();
    expect(within(exit).queryByRole('button', { name: /Put down here|Asleep here/ })).toBeNull();
  });

  test('★ "Put down here" fills IN BED and leaves "Fell asleep" alone — the put-down night', async () => {
    api.get.mockResolvedValue(STORY_NIGHT);
    const { user } = at();
    await openEvents(user);
    await waitFor(() => expect(storyRow(31)).toBeTruthy());
    await user.click(within(storyRow(31)).getByRole('button', { name: /Put down here/ }));

    expect(screen.getByLabelText(/In bed/)).toHaveValue('18:49');
    expect(screen.getByLabelText(/Fell asleep/)).toHaveValue('19:13'); // the detector's, which was right
    expect(within(storyRow(31)).getByRole('button', { name: /Put down here/ })).toHaveAttribute('aria-pressed', 'true');
    expect(within(storyRow(31)).getByRole('button', { name: /Asleep here/ })).toHaveAttribute('aria-pressed', 'false');

    const body = await saveReview(user);
    expect(body.true_in_bed_transition_id).toBe(31);
    expect(body.true_in_bed_local).toBe('18:49');
    expect(body.true_onset_transition_id).toBeNull(); // no asleep FRAME was named
    expect(body.true_onset_local).toBe('19:13');
  });

  test('"Asleep here" fills "Fell asleep" and sends nothing about in bed', async () => {
    api.get.mockResolvedValue(STORY_NIGHT);
    const { user } = at();
    await openEvents(user);
    await waitFor(() => expect(storyRow(32)).toBeTruthy());
    await user.click(within(storyRow(31)).getByRole('button', { name: /Asleep here/ }));
    expect(screen.getByLabelText(/Fell asleep/)).toHaveValue('18:49');
    expect(screen.getByLabelText(/In bed/)).toHaveValue('');

    const body = await saveReview(user);
    expect(body.true_onset_transition_id).toBe(31);
    expect(body.true_in_bed_local).toBeUndefined();
    expect(body.true_in_bed_transition_id).toBeUndefined();
  });

  test('marking both on a story night sends both, each from its own frame', async () => {
    api.get.mockResolvedValue(STORY_NIGHT);
    const { user } = at();
    await openEvents(user);
    await waitFor(() => expect(storyRow(31)).toBeTruthy());
    await user.click(within(storyRow(31)).getByRole('button', { name: /Put down here/ }));
    await user.click(within(storyRow(32)).getByRole('button', { name: /Asleep here/ }));
    const body = await saveReview(user);
    expect(body).toMatchObject({ true_in_bed_transition_id: 31, true_onset_transition_id: 32 });
  });

  test('typing "In bed" by hand clears the picked put-down frame; tapping the frame again un-picks it', async () => {
    api.get.mockResolvedValue(STORY_NIGHT);
    const { user } = at();
    await openEvents(user);
    await waitFor(() => expect(storyRow(31)).toBeTruthy());
    const putDown = within(storyRow(31)).getByRole('button', { name: /Put down here/ });
    await user.click(putDown);
    await user.click(putDown);
    expect(putDown).toHaveAttribute('aria-pressed', 'false');
    await user.click(putDown);

    const inBed = screen.getByLabelText(/In bed/);
    await user.clear(inBed);
    await user.type(inBed, '18:50');
    expect(putDown).toHaveAttribute('aria-pressed', 'false');
    const body = await saveReview(user);
    expect(body.true_in_bed_transition_id).toBeNull();
    expect(body.true_in_bed_local).toBe('18:50');
  });

  // --- un-picking a frame undoes the pick (fix round, item 4) -------------------------------------------
  // A second tap on a pressed moment chip used to drop only the frame id: the frame's time stayed in the
  // field and was saved as if typed. For "In bed" that recorded a put-down the parent had just taken back.
  test('★ picking then un-picking "Put down here" sends NOTHING about in bed', async () => {
    api.get.mockResolvedValue(STORY_NIGHT);
    const { user } = at();
    await openEvents(user);
    await waitFor(() => expect(storyRow(31)).toBeTruthy());
    const putDown = within(storyRow(31)).getByRole('button', { name: /Put down here/ });
    await user.click(putDown);
    expect(screen.getByLabelText(/In bed/)).toHaveValue('18:49');
    await user.click(putDown);
    expect(putDown).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByLabelText(/In bed/)).toHaveValue('');
    const body = await saveReview(user);
    expect(body.true_in_bed_local).toBeUndefined();
    expect(body.true_in_bed_transition_id).toBeUndefined();
    expect(body.true_onset_local).toBe('19:13');
  });

  test('un-picking puts back what was TYPED before the pick, and sends that', async () => {
    api.get.mockResolvedValue(STORY_NIGHT);
    const { user } = at();
    await user.click(await screen.findByRole('button', { name: /Not quite/ }));
    await user.type(screen.getByLabelText(/In bed/), '18:45');
    await openEvents(user);
    await waitFor(() => expect(storyRow(31)).toBeTruthy());
    const putDown = within(storyRow(31)).getByRole('button', { name: /Put down here/ });
    await user.click(putDown);
    await user.click(putDown);
    expect(screen.getByLabelText(/In bed/)).toHaveValue('18:45');
    const body = await saveReview(user);
    expect(body.true_in_bed_local).toBe('18:45');
    expect(body.true_in_bed_transition_id).toBeNull();
  });

  test('un-pressing a put-down already ON RECORD removes it (and says so to the server)', async () => {
    api.get.mockResolvedValue({
      ...STORY_NIGHT,
      review: { true_in_bed_at: '2026-08-29 08:49:20', true_in_bed_transition_id: 31, true_onset_at: null, true_wake_at: null },
    });
    const { user } = at();
    await openEvents(user);
    await waitFor(() => expect(storyRow(31)).toBeTruthy());
    const putDown = within(storyRow(31)).getByRole('button', { name: /Put down here/ });
    expect(putDown).toHaveAttribute('aria-pressed', 'true');
    await user.click(putDown);
    expect(screen.getByLabelText(/In bed/)).toHaveValue('');
    const body = await saveReview(user);
    expect(body.true_in_bed_local).toBeNull();
    expect(body.true_in_bed_transition_id).toBeNull();
  });

  test('"Asleep here" and "Up for the day here" un-picked put their fields back too', async () => {
    // The same bug, found checking the other two moments: an un-picked frame's time stayed as the answer.
    // Frame 34 (06:50) is an exit AFTER the detector's 06:37 wake, so a leftover would be visible.
    api.get.mockResolvedValue({
      ...STORY_NIGHT,
      transitions: [...STORY_NIGHT.transitions,
        { id: 34, type: 'out_of_bed', created_at: '2026-08-29 20:50:10', snapshot: 1, verdict: null, camera_name: 'Bedroom A' }],
    });
    const { user } = at();
    await openEvents(user);
    await waitFor(() => expect(storyRow(34)).toBeTruthy());
    const asleep = within(storyRow(31)).getByRole('button', { name: /Asleep here/ });
    const up = within(storyRow(34)).getByRole('button', { name: /Up for the day here/ });
    await user.click(asleep);
    await user.click(up);
    expect(screen.getByLabelText(/Fell asleep/)).toHaveValue('18:49');
    expect(screen.getByLabelText(/Got up for the day/)).toHaveValue('06:50');
    await user.click(asleep);
    await user.click(up);
    expect(screen.getByLabelText(/Fell asleep/)).toHaveValue('19:13');
    expect(screen.getByLabelText(/Got up for the day/)).toHaveValue('06:37');
    const body = await saveReview(user);
    expect(body).toMatchObject({ true_onset_local: '19:13', true_onset_transition_id: null, true_wake_transition_id: null });
  });

  test('★ In bed keeps re-seeding into the real timezone until IT is touched, even after another time was (Fc)', async () => {
    // Its own touched flag, not the shared one: correcting the asleep time before /settings resolves must
    // not freeze a stored put-down in the placeholder zone (18:49 Melbourne shown as 08:49).
    api.get.mockResolvedValue({
      ...STORY_NIGHT,
      review: { true_in_bed_at: '2026-08-29 08:49:20', true_in_bed_transition_id: 31, true_onset_at: null, true_wake_at: null },
    });
    const { user, rerenderWith } = renderAsAdmin(routed, {
      route: '/children/c-1/review/2026-08-29', kids: [{ id: 'c-1', name: 'Child A' }], settings: { timezone: 'UTC' },
    });
    await waitFor(() => expect(screen.getByLabelText(/In bed/)).toHaveValue('08:49'));
    const asleep = screen.getByLabelText(/Fell asleep/);
    await user.clear(asleep);
    await user.type(asleep, '09:20');
    rerenderWith({ settings: { timezone: 'Australia/Melbourne' } });
    await waitFor(() => expect(screen.getByLabelText(/In bed/)).toHaveValue('18:49'));
    expect(screen.getByLabelText(/Fell asleep/)).toHaveValue('09:20');
  });

  // --- no time is ever sent in the placeholder timezone (fix round 2, 2026-09-30, Codex P1) --------------
  //
  // SettingsContext starts at the placeholder 'UTC' and replaces it when /settings resolves (or never, if
  // that request fails). "Fell asleep" and "Got up for the day" are seeded from UTC instants shown in the
  // zone, so until then the story night's 19:13 / 06:37 read 09:13 / 20:37. A chip tap set `touched`, which
  // stopped the seed re-running when the real zone arrived, and Save then sent 09:13 / 20:37: a wake before
  // the asleep time, asleep 0. `settingsLoaded: false` with `loading: false` is also what a FAILED first
  // /settings request leaves, so a gate on `loading` fails these too.
  const beforeZone = (night = STORY_NIGHT) => {
    api.get.mockResolvedValue(night);
    return renderAsAdmin(routed, {
      route: '/children/c-1/review/2026-08-29',
      kids: [{ id: 'c-1', name: 'Child A' }],
      settings: { timezone: 'UTC' }, // SettingsContext's placeholder, not a configured zone
      loading: false,
      settingsLoaded: false,
    });
  };
  const zoneArrives = (rerenderWith) =>
    rerenderWith({ settings: { timezone: 'Australia/Melbourne' }, settingsLoaded: true });

  test('★ a chip tapped before the real timezone arrives cannot freeze asleep/wake in the placeholder zone (Codex P1)', async () => {
    const { user, rerenderWith } = beforeZone();
    await openEvents(user);
    await waitFor(() => expect(storyRow(31)).toBeTruthy());
    // The reviewer's repro, step for step, with whatever the screen offers at each moment (the next test
    // pins that it offers no chip yet): "Put down here" while the zone is still the placeholder...
    await user.click(within(storyRow(31)).getByRole('button', { name: /Put down here/ }));
    // ...then /settings resolves...
    zoneArrives(rerenderWith);
    await waitFor(() => expect(storyRow(31).querySelector('.review-event__when').textContent).toMatch(/^18:49/));
    // ...then the put-down is marked (again, if the first tap could not be) and the review saved.
    if (!screen.queryByRole('button', { name: /Save review/ })) {
      await user.click(screen.getByRole('button', { name: /Not quite/ }));
    }
    const putDown = within(storyRow(31)).getByRole('button', { name: /Put down here/ });
    if (putDown.getAttribute('aria-pressed') !== 'true') await user.click(putDown);
    const body = await saveReview(user);
    expect(body.true_in_bed_transition_id).toBe(31);
    expect(body.true_onset_local, 'asleep in the REAL zone, not the placeholder 09:13').toBe('19:13');
    expect(body.true_wake_local, 'wake in the REAL zone, not the placeholder 20:37').toBe('06:37');
  });

  test('until the real timezone arrives nothing that sends a time can be used; verdicts and the flag still can', async () => {
    const { user, rerenderWith } = beforeZone();
    const thatsRight = await screen.findByRole('button', { name: /That.s right/ });
    expect(thatsRight).toBeDisabled();
    // Tapped anyway: nothing is sent. Before the fix it sent the placeholder 09:13 / 20:37 at once.
    await user.click(thatsRight);
    expect(api.put).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Not quite/ })).toBeDisabled();
    expect(screen.getByText(/Waiting for the app.s timezone setting/)).toBeInTheDocument();
    // Nothing here carries a time, so none of it waits (and it is all that works if /settings failed).
    expect(screen.getByRole('button', { name: /No one was in the bed/ })).toBeEnabled();
    await openEvents(user);
    await waitFor(() => expect(storyRow(31)).toBeTruthy());
    expect(within(storyRow(31)).getByRole('button', { name: /Put down here/ })).toBeDisabled();
    expect(within(storyRow(31)).getByRole('button', { name: /Asleep here/ })).toBeDisabled();
    expect(within(storyRow(33)).getByRole('button', { name: /Up for the day here/ })).toBeDisabled();
    await user.click(within(storyRow(31)).getByRole('button', { name: 'Yes', exact: true }));
    expect(within(storyRow(31)).getByRole('button', { name: 'Yes', exact: true })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /Save just the event answers/ })).toBeEnabled();

    zoneArrives(rerenderWith);
    await waitFor(() => expect(screen.getByRole('button', { name: /That.s right/ })).toBeEnabled());
    expect(screen.queryByText(/Waiting for the app.s timezone setting/)).toBeNull();
    expect(within(storyRow(31)).getByRole('button', { name: /Put down here/ })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: /That.s right/ }));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    expect(api.put.mock.calls[0][1]).toMatchObject({ true_onset_local: '19:13', true_wake_local: '06:37' });
  });

  test('a night reopened into its times waits too: its fields and Save review stay disabled until the zone is known', async () => {
    // The edit card is open from the first paint on a night already answered, so its fields are there to
    // type into before /settings resolves. A keystroke there (the note included) set `touched` too.
    const { user, rerenderWith } = beforeZone({
      ...STORY_NIGHT,
      review: { true_onset_at: '2026-08-29 09:15:00', true_wake_at: null, true_in_bed_at: null, note: 'a cold' },
    });
    await waitFor(() => expect(screen.getByLabelText(/Fell asleep/)).toBeInTheDocument());
    for (const label of [/In bed/, /Fell asleep/, /Got up for the day/, /Anything else worth noting/]) {
      expect(screen.getByLabelText(label)).toBeDisabled();
    }
    expect(screen.getByRole('button', { name: /Save review/ })).toBeDisabled();

    zoneArrives(rerenderWith);
    await waitFor(() => expect(screen.getByLabelText(/Fell asleep/)).toHaveValue('19:15'));
    await user.type(screen.getByLabelText(/Anything else worth noting/), ', slept badly');
    const body = await saveReview(user);
    expect(body).toMatchObject({ true_onset_local: '19:15', true_wake_local: '06:37', note: 'a cold, slept badly' });
  });

  test('★ correcting only the asleep time sends NOTHING about in bed — the field is never seeded from the detector', async () => {
    // Plan review R3. `computed.in_bed_at` is 19:10 here. Seeded from it, every save would store the
    // detector's put-down as the parent's own answer.
    api.get.mockResolvedValue(STORY_NIGHT);
    const { user } = at();
    await user.click(await screen.findByRole('button', { name: /Not quite/ }));
    expect(screen.getByLabelText(/In bed/)).toHaveValue('');
    const asleep = screen.getByLabelText(/Fell asleep/);
    await user.clear(asleep);
    await user.type(asleep, '19:20');
    const body = await saveReview(user);
    expect(body.true_onset_local).toBe('19:20');
    expect(body).not.toHaveProperty('true_in_bed_local', expect.anything());
    expect(body.true_in_bed_local).toBeUndefined();
    expect(body.true_in_bed_transition_id).toBeUndefined();
  });

  test('a stored in-bed answer seeds the field and its frame, and reopens straight into the times', async () => {
    api.get.mockResolvedValue({
      ...STORY_NIGHT,
      review: { true_in_bed_at: '2026-08-29 08:49:20', true_in_bed_transition_id: 31, true_onset_at: null, true_wake_at: null },
    });
    const { user } = at();
    await waitFor(() => expect(screen.getByLabelText(/In bed/)).toHaveValue('18:49'));
    await openEvents(user);
    await waitFor(() => expect(storyRow(31)).toBeTruthy());
    expect(within(storyRow(31)).getByRole('button', { name: /Put down here/ })).toHaveAttribute('aria-pressed', 'true');
  });

  test('"What we recorded" shows the detector\'s In bed beside its asleep and wake times', async () => {
    api.get.mockResolvedValue(STORY_NIGHT);
    at();
    await screen.findByRole('button', { name: /That.s right/ });
    const shown = document.querySelector('.review-shown');
    expect(within(shown).getByText('In bed')).toBeInTheDocument();
    expect(within(shown).getByText('19:10')).toBeInTheDocument();
    expect(within(shown).getByText('19:13')).toBeInTheDocument();
  });

  test('"That\'s right" confirms asleep and wake only — never the detector\'s put-down', async () => {
    api.get.mockResolvedValue(STORY_NIGHT);
    const { user } = at();
    await user.click(await screen.findByRole('button', { name: /That.s right/ }));
    await waitFor(() => expect(api.put).toHaveBeenCalled());
    const body = api.put.mock.calls[0][1];
    expect(body).toMatchObject({ true_onset_local: '19:13', true_wake_local: '06:37' });
    expect(body.true_in_bed_local).toBeUndefined();
  });

  test('the help line says what each button records, once, above the list', async () => {
    api.get.mockResolvedValue(STORY_NIGHT);
    const { user } = at();
    await openEvents(user);
    const help = await screen.findAllByText(/they went into bed/);
    expect(help).toHaveLength(1);
    expect(help[0].closest('.review-events__help')).toHaveTextContent(
      'Put down here = they went into bed. Asleep here = they fell asleep. Reading a story first? Mark both.'
    );
  });

  test('typing a time by hand clears the named frame, so only one of them is the answer', async () => {
    const { user } = at();
    await openEvents(user);
    await user.click(await screen.findByRole('button', { name: /Up for the day here/ }));

    const wake = screen.getByLabelText(/Got up for the day/);
    await user.clear(wake);
    await user.type(wake, '06:10');

    await user.click(screen.getByRole('button', { name: /Save review/ }));
    await waitFor(() => expect(api.put).toHaveBeenCalled());
    const body = api.put.mock.calls[0][1];
    expect(body.true_wake_transition_id).toBeNull();
    expect(body.true_wake_local).toBe('06:10');
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
    expect(await screen.findByRole('button', { name: /That.s right/ })).toBeInTheDocument();
  });

  test('a failed save surfaces the reason and leaves the form usable', async () => {
    api.put.mockRejectedValue(new Error('Not a valid verdict for transition 11'));
    const { user } = at();
    await openEvents(user);
    await screen.findByText(/got out of bed/);
    await user.click(screen.getByRole('button', { name: /Save just the event answers/ }));
    expect(await screen.findByText(/Not a valid verdict/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Save just the event answers/ })).toBeEnabled();
  });

  // --- WHO it was, after a "No" (issue #501, B1) -------------------------------------------------

  describe('who it was, after a "No"', () => {
    const reasonGroups = () => document.querySelectorAll('.review-event__reasons');
    const rowOf = (id) => document.querySelector(`.review-event img[src*="/bed-transitions/${id}/"]`)?.closest('.review-event');
    const saveAnswers = async (user) => {
      await user.click(screen.getByRole('button', { name: /Save just the event answers/ }));
      await waitFor(() => expect(api.put).toHaveBeenCalled());
      return api.put.mock.calls[0][1];
    };

    test('the follow-up appears only after "No", and the answer is saved beside the verdict', async () => {
      const { user } = at();
      await openEvents(user);
      await screen.findAllByRole('button', { name: /^No$/ });
      expect(reasonGroups()).toHaveLength(0);
      expect(screen.queryByRole('button', { name: 'Me or another adult' })).toBeNull();

      await user.click(screen.getAllByRole('button', { name: /^No$/ })[0]);
      const row = rowOf(11);
      expect(within(row).getByRole('group', { name: 'What was it?' })).toBeInTheDocument();
      expect(reasonGroups()).toHaveLength(1);
      // Its own wrapper: the row still has exactly its two .review-event__verdicts containers, so the
      // count the double-flagged-exit test relies on is not inflated by the follow-up.
      expect(row.querySelectorAll('.review-event__verdicts')).toHaveLength(2);

      await user.click(within(row).getByRole('button', { name: 'Me or another adult' }));
      expect(within(row).getByRole('button', { name: 'Me or another adult' })).toHaveAttribute('aria-pressed', 'true');
      const body = await saveAnswers(user);
      expect(body.verdicts).toMatchObject({ 11: 'wrong' });
      expect(body.reasons).toEqual({ 11: 'adult' });
    });

    test.each([
      ['switching to "Yes"', 'Yes'],
      ['switching to "Can\'t tell"', "Can't tell"],
      ['tapping "No" again to clear it', 'No'],
    ])('%s hides the follow-up AND clears the reason before save', async (_how, next) => {
      const { user } = at();
      await openEvents(user);
      await user.click((await screen.findAllByRole('button', { name: /^No$/ }))[0]);
      const row = rowOf(11);
      await user.click(within(row).getByRole('button', { name: 'They moved in bed' }));
      await user.click(within(row).getByRole('button', { name: next, exact: true }));
      expect(reasonGroups()).toHaveLength(0);
      const body = await saveAnswers(user);
      expect(body.reasons[11]).toBeNull();
    });

    test('No -> Yes -> No shows no stale pick, and SENDS null so a stored reason is cleared too', async () => {
      // A reason already on record ('adult') would otherwise survive a round trip the person made
      // on screen without re-picking one: the final verdict 'wrong' keeps the stored reason server-side.
      api.get.mockResolvedValue({ ...NIGHT, transitions: [{ ...NIGHT.transitions[0], verdict: 'wrong', wrong_reason: 'adult' }] });
      const { user } = at();
      await openEvents(user);
      const row = await waitFor(() => { const r = rowOf(11); expect(r).toBeTruthy(); return r; });
      expect(within(row).getByRole('button', { name: 'Me or another adult' })).toHaveAttribute('aria-pressed', 'true');

      await user.click(within(row).getByRole('button', { name: 'Yes', exact: true }));
      await user.click(within(row).getByRole('button', { name: 'No', exact: true }));
      for (const label of ['Me or another adult', 'They moved in bed', 'Someone walking by / nothing']) {
        expect(within(row).getByRole('button', { name: label })).toHaveAttribute('aria-pressed', 'false');
      }
      const body = await saveAnswers(user);
      expect(body.verdicts[11]).toBe('wrong');
      expect(body.reasons).toHaveProperty('11', null);
    });

    test('an already-answered reason comes back pressed and is resent unchanged', async () => {
      api.get.mockResolvedValue({ ...NIGHT, transitions: [{ ...NIGHT.transitions[0], verdict: 'wrong', wrong_reason: 'other' }] });
      const { user } = at();
      await openEvents(user);
      await waitFor(() => expect(screen.getByRole('button', { name: 'Someone walking by / nothing' })).toHaveAttribute('aria-pressed', 'true'));
      const body = await saveAnswers(user);
      expect(body.reasons).toEqual({ 11: 'other' });
    });

    test('never under the quick check-in or "Still moving?" cards — their buttons already say more', async () => {
      api.get.mockResolvedValue({
        ...NIGHT,
        transitions: [
          { id: 21, type: 'into_bed', created_at: '2026-08-29 09:51:00', snapshot: 0, verdict: null, quick_reversal_of: null },
          { id: 22, type: 'out_of_bed', created_at: '2026-08-29 09:51:14', snapshot: 0, verdict: null, quick_reversal_of: 21, quick_reversal_gap_s: 14 },
          { id: 42, type: 'out_of_bed', created_at: '2026-08-29 10:06:00', snapshot: 0, verdict: null, quick_reversal_of: null, lingering_motion_minutes: 4, lingering_motion_gap_s: 30 },
        ],
      });
      const { user } = at();
      const quick = (await screen.findByText('Quick check-in?')).closest('.card');
      const lingering = screen.getByText('Still moving?').closest('.card');
      await user.click(within(quick).getByRole('button', { name: 'That was me' }));
      await user.click(within(lingering).getByRole('button', { name: 'No, still in bed' }));
      // Both are now 'wrong' in the shared map, and neither card grew a follow-up.
      expect(reasonGroups()).toHaveLength(0);

      // Nor does the full list, where both events ALSO appear with their 'wrong' chip lit: their own
      // card already said what it was, and a second "What was it?" under "That was me" could answer
      // "They moved in bed" against it (adversarial code review, 2026-09-25).
      await openEvents(user);
      // The full list's rows, in the fixture's order (21, 22, 42). Scoped to the list's own card: the
      // quick check-in and "Still moving?" cards above render .review-event rows of their own.
      const listRows = () => [...document.querySelectorAll('.card.tight .review-event')];
      await waitFor(() => expect(listRows()).toHaveLength(3));
      const [plain, quickRow, lingeringRow] = listRows();
      for (const row of [quickRow, lingeringRow]) {
        expect(within(row).getByRole('button', { name: 'No', exact: true }), 'shows its answer')
          .toHaveAttribute('aria-pressed', 'true');
      }
      expect(reasonGroups()).toHaveLength(0);

      // A plain, unflagged event in the same list still gets the follow-up.
      await user.click(within(plain).getByRole('button', { name: 'No', exact: true }));
      expect(reasonGroups()).toHaveLength(1);
      expect(plain.querySelector('.review-event__reasons')).not.toBeNull();
    });

    test('"That was me" records WHO without asking: reason \'adult\' goes in the same save', async () => {
      api.get.mockResolvedValue({
        ...NIGHT,
        transitions: [
          { id: 21, type: 'into_bed', created_at: '2026-08-29 09:51:00', snapshot: 0, verdict: null, quick_reversal_of: null },
          { id: 22, type: 'out_of_bed', created_at: '2026-08-29 09:51:14', snapshot: 0, verdict: null, quick_reversal_of: 21, quick_reversal_gap_s: 14 },
        ],
      });
      const { user } = at();
      const quick = (await screen.findByText('Quick check-in?')).closest('.card');
      await user.click(within(quick).getByRole('button', { name: 'That was me' }));
      const body = await saveAnswers(user);
      expect(body.verdicts).toEqual({ 22: 'wrong' });
      expect(body.reasons).toEqual({ 22: 'adult' });
    });

    test.each([
      ['switching to "They got up"', 'They got up', 'correct'],
      ['tapping "That was me" again to clear it', 'That was me', null],
    ])('%s drops the automatic reason', async (_how, next, verdict) => {
      api.get.mockResolvedValue({
        ...NIGHT,
        transitions: [
          { id: 21, type: 'into_bed', created_at: '2026-08-29 09:51:00', snapshot: 0, verdict: null, quick_reversal_of: null },
          { id: 22, type: 'out_of_bed', created_at: '2026-08-29 09:51:14', snapshot: 0, verdict: null, quick_reversal_of: 21, quick_reversal_gap_s: 14 },
        ],
      });
      const { user } = at();
      const quick = (await screen.findByText('Quick check-in?')).closest('.card');
      await user.click(within(quick).getByRole('button', { name: 'That was me' }));
      await user.click(within(quick).getByRole('button', { name: next }));
      const body = await saveAnswers(user);
      expect(body.verdicts[22]).toBe(verdict);
      expect(body.reasons).toHaveProperty('22', null);
    });

    test('a reason picked before the timezone arrives survives the reseed', async () => {
      // The third time this file's seed effect could eat an answer — copied from the verdict version
      // above, for a reason tap specifically. Reasons ride on `verdictsTouched`.
      const { user, rerenderWith } = renderAsAdmin(routed, {
        route: '/children/c-1/review/2026-08-29',
        kids: [{ id: 'c-1', name: 'Child B' }],
        settings: { timezone: 'UTC' },
      });
      await openEvents(user);
      await user.click((await screen.findAllByRole('button', { name: /^No$/ }))[0]);
      await user.click(screen.getByRole('button', { name: 'They moved in bed' }));

      rerenderWith({ settings: { timezone: 'Australia/Melbourne' } });
      await waitFor(() => expect(screen.getByText('19:33')).toBeInTheDocument());
      expect(screen.getByRole('button', { name: 'They moved in bed' })).toHaveAttribute('aria-pressed', 'true');

      const body = await saveAnswers(user);
      expect(body.reasons).toEqual({ 11: 'child_moved' });
      expect(body.verdicts).toMatchObject({ 11: 'wrong' });
    });
  });

  // --- events well before bedtime, grouped (issue #501, B2) --------------------------------------

  describe('"Before bedtime" grouping', () => {
    // Night of 2026-08-29, Melbourne (+10). The cutoff is 16:00 LOCAL on the night's own date.
    const tx = (id, created_at, extra = {}) => ({ id, type: 'out_of_bed', created_at, snapshot: 1, verdict: null, camera_name: 'Child B Room', quick_reversal_of: null, lingering_motion_minutes: null, ...extra });
    const EARLY_NIGHT = {
      ...NIGHT,
      transitions: [
        tx(53, '2026-08-29 04:00:00', { type: 'into_bed', verdict: 'correct' }), // 14:00 — a nap, already "Yes"
        tx(55, '2026-08-29 04:30:00', { type: 'into_bed' }), // 14:30
        tx(56, '2026-08-29 04:30:12', { quick_reversal_of: 55, quick_reversal_gap_s: 12 }), // flagged: own card
        tx(54, '2026-08-29 05:10:00', { lingering_motion_minutes: 4, lingering_motion_gap_s: 60 }), // flagged: own card
        tx(51, '2026-08-29 05:59:59'), // 15:59:59 — the last second inside the group
        tx(52, '2026-08-29 06:00:00'), // 16:00:00 — the first second outside it
        tx(57, '2026-08-29 19:45:22'), // 05:45 next morning
      ],
    };
    const earlyBox = () => document.querySelector('.review-early');
    const rowOf = (id) => document.querySelector(`.review-event img[src*="/bed-transitions/${id}/"]`)?.closest('.review-event');
    const openGroup = async (user) => user.click(await screen.findByRole('button', { name: /Before bedtime/ }));

    test('an event one second before 16:00 local is grouped; one AT 16:00 is not — both sides pinned', async () => {
      api.get.mockResolvedValue(EARLY_NIGHT);
      const { user } = at();
      await openEvents(user);
      expect(await screen.findByRole('button', { name: /Before bedtime \(5\)/ })).toBeInTheDocument();
      expect(rowOf(51), 'collapsed: grouped rows are not drawn yet').toBeUndefined();
      expect(rowOf(52), 'but the rest of the list is').toBeTruthy();

      await openGroup(user);
      expect(earlyBox().contains(rowOf(51))).toBe(true);
      expect(earlyBox().contains(rowOf(52))).toBe(false);
      expect(earlyBox().contains(rowOf(57))).toBe(false);
      expect(screen.getByRole('button', { name: /Check the 7 recorded events|Hide the recorded events/ })).toBeInTheDocument();
    });

    test('the cutoff follows the APP timezone, not a fixed UTC hour', async () => {
      // The same two instants in UTC: 05:59:59 and 06:00:00 are both morning, both before 16:00 on the
      // 29th, so BOTH group — the opposite of Melbourne for 52. A cutoff hard-wired to one zone
      // cannot pass both this and the test above.
      api.get.mockResolvedValue({ ...NIGHT, transitions: [tx(51, '2026-08-29 05:59:59'), tx(52, '2026-08-29 06:00:00'), tx(58, '2026-08-29 16:00:00')] });
      const { user } = renderAsAdmin(routed, {
        route: '/children/c-1/review/2026-08-29', kids: [{ id: 'c-1', name: 'Child B' }], settings: { timezone: 'UTC' },
      });
      await openEvents(user);
      await openGroup(user);
      expect(earlyBox().contains(rowOf(51))).toBe(true);
      expect(earlyBox().contains(rowOf(52))).toBe(true);
      expect(earlyBox().contains(rowOf(58))).toBe(false);
    });

    test('the one-tap answer skips anything already answered or flagged, and lands in the SAME save as a manual tap', async () => {
      api.get.mockResolvedValue(EARLY_NIGHT);
      const { user } = at();
      await openEvents(user);
      await openGroup(user);
      // Answered earlier in this sitting, before the bulk tap: must survive it.
      await user.click(within(rowOf(51)).getByRole('button', { name: "Can't tell" }));
      // A manual answer outside the group, in the same save.
      await user.click(within(rowOf(52)).getByRole('button', { name: 'No', exact: true }));
      await user.click(within(rowOf(52)).getByRole('button', { name: 'Me or another adult' }));

      await user.click(screen.getByRole('button', { name: /None of these were a bedtime event/ }));

      await user.click(screen.getByRole('button', { name: /Save just the event answers/ }));
      await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
      const { verdicts, reasons } = api.put.mock.calls[0][1];
      expect(verdicts[55], 'unanswered and unflagged: pre-filled').toBe('wrong');
      expect(verdicts[53], 'the nap already said "Yes" — never overwritten').toBe('correct');
      expect(verdicts[51], 'answered this sitting — never overwritten').toBe('unclear');
      expect(verdicts[56], 'quick check-in has its own card').toBeUndefined();
      expect(verdicts[54], '"Still moving?" has its own card').toBeUndefined();
      expect(verdicts[52], 'the manual tap outside the group').toBe('wrong');
      expect(verdicts[57]).toBeUndefined();
      expect(reasons).toEqual({ 52: 'adult' });
    });

    test('a pre-filled answer is a starting point: each grouped event can still be changed', async () => {
      api.get.mockResolvedValue(EARLY_NIGHT);
      const { user } = at();
      await openEvents(user);
      await openGroup(user);
      await user.click(screen.getByRole('button', { name: /None of these were a bedtime event/ }));
      const nap = rowOf(55);
      expect(within(nap).getByRole('button', { name: 'No', exact: true })).toHaveAttribute('aria-pressed', 'true');
      await user.click(within(nap).getByRole('button', { name: 'Yes', exact: true }));
      expect(screen.getByRole('button', { name: /None of these were a bedtime event/ })).toBeDisabled();

      await user.click(screen.getByRole('button', { name: /Save just the event answers/ }));
      await waitFor(() => expect(api.put).toHaveBeenCalled());
      expect(api.put.mock.calls[0][1].verdicts[55]).toBe('correct');
    });

    test('the one-tap answer is unusable until the group has been opened at least once', async () => {
      // Otherwise a genuine, unanswered nap in the group could be marked "No" by someone who never saw
      // it — a false label written into the ground truth this screen exists to collect (adversarial
      // code review, 2026-09-25). Opening it once is enough; closing it again does not re-lock it.
      api.get.mockResolvedValue(EARLY_NIGHT);
      const { user } = at();
      await openEvents(user);
      const bulk = await screen.findByRole('button', { name: /None of these were a bedtime event/ });
      expect(bulk).toBeDisabled();
      expect(earlyBox()).toHaveTextContent(/Open this to check first/);
      await user.click(bulk); // inert: nothing may be pre-filled by a tap on the locked button
      await user.click(screen.getByRole('button', { name: /Before bedtime/ })); // open
      expect(within(rowOf(55)).getByRole('button', { name: 'No', exact: true })).toHaveAttribute('aria-pressed', 'false');

      await user.click(screen.getByRole('button', { name: /Before bedtime/ })); // and close again
      expect(rowOf(55), 'closed').toBeUndefined();
      const unlocked = screen.getByRole('button', { name: /None of these were a bedtime event/ });
      expect(unlocked).toBeEnabled();
      expect(earlyBox()).not.toHaveTextContent(/Open this to check first/);
      await user.click(unlocked);

      await user.click(screen.getByRole('button', { name: /Save just the event answers/ }));
      await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
      expect(api.put.mock.calls[0][1].verdicts[55]).toBe('wrong');
    });

    test.each([
      ['a computed put-down', { status: 'ok', onset_at: null, in_bed_at: '2026-08-29 09:20:00', wake_at: null }, null],
      ['a computed onset', { status: 'ok', onset_at: '2026-08-29 09:33:00', in_bed_at: null, wake_at: null }, null],
      ['a put-down frame the person named', { status: 'no_data', onset_at: null, in_bed_at: null, wake_at: null },
        { true_onset_at: '2026-08-29 09:20:00', true_onset_transition_id: 57 }],
      // Typed, no frame named: nothing else here is a bedtime — no computed times, no onsetFrame.
      ['a correction the person typed, with no frame named', { status: 'no_data', onset_at: null, in_bed_at: null, wake_at: null },
        { true_onset_at: '2026-08-29 09:20:00', true_onset_transition_id: null, true_wake_at: null }],
      // The parent's own put-down ("In bed", 2026-09-30) is a bedtime too, with no asleep time at all (Fe).
      ['an in-bed time the person gave, and nothing else', { status: 'no_data', onset_at: null, in_bed_at: null, wake_at: null },
        { true_in_bed_at: '2026-08-29 09:20:00', true_in_bed_transition_id: null, true_onset_at: null, true_wake_at: null }],
    ])('groups once the night has a bedtime — from %s alone', async (_what, computed, review) => {
      api.get.mockResolvedValue({ ...EARLY_NIGHT, computed, review });
      const { user } = at();
      await openEvents(user);
      expect(await screen.findByRole('button', { name: /Before bedtime/ })).toBeInTheDocument();
    });

    test('...and from a put-down FRAME picked on this screen (Fe)', async () => {
      // "Put down here" used to set the onset frame, which was an anchor. It now sets the in-bed frame, and
      // that must anchor the grouping just the same, or picking the put-down stops the list grouping.
      api.get.mockResolvedValue({
        ...EARLY_NIGHT, computed: { status: 'no_data', onset_at: null, in_bed_at: null, wake_at: null }, review: null,
      });
      const { user } = at();
      await openEvents(user);
      await waitFor(() => expect(rowOf(55)).toBeTruthy());
      expect(screen.queryByRole('button', { name: /Before bedtime/ }), 'no anchor yet').toBeNull();
      await user.click(within(rowOf(55)).getByRole('button', { name: /Put down here/ }));
      expect(await screen.findByRole('button', { name: /Before bedtime/ })).toBeInTheDocument();
    });

    test('with no bedtime anchor at all, the list stays flat exactly as before — no group, nothing hidden', async () => {
      api.get.mockResolvedValue({
        ...EARLY_NIGHT, computed: { status: 'no_data', onset_at: null, in_bed_at: null, wake_at: null }, review: null,
      });
      const { user } = at();
      await openEvents(user);
      await waitFor(() => expect(rowOf(51)).toBeTruthy());
      expect(screen.queryByRole('button', { name: /Before bedtime/ })).toBeNull();
      expect(earlyBox()).toBeNull();
      for (const id of [53, 55, 56, 54, 51, 52, 57]) expect(rowOf(id), `row ${id} is drawn`).toBeTruthy();
    });

    test('a night with nothing before 16:00 shows no group at all', async () => {
      const { user } = at(); // NIGHT: both events are 05:45 / 05:47 the next morning
      await openEvents(user);
      await screen.findAllByRole('button', { name: /^No$/ });
      expect(screen.queryByRole('button', { name: /Before bedtime/ })).toBeNull();
    });

    // --- the timezone the 16:00 cutoff is judged in has to be the REAL one (0.34.0 release review) -------
    //
    // SettingsContext starts at timezone 'UTC' and replaces it when /settings resolves (or never, if that
    // request fails). Planted night of 2026-08-29, Melbourne (+10):
    //   61  into_bed  09:20 UTC = 19:20 Melbourne — the REAL put-down. Before 16:00 in UTC, NOT in Melbourne:
    //       the one event whose bucket depends on which zone is used.
    //   62  out_of_bed 04:00 UTC = 14:00 Melbourne — genuinely before bedtime in either zone.
    //   63  out_of_bed 19:45 UTC = 05:45 the next morning — after 16:00 in either zone.
    // `loading: false, settingsLoaded: false` is exactly what a FAILED first /settings request leaves, so
    // an implementation gated on `loading` instead of `loaded` fails these too.
    const TZ_NIGHT = {
      ...NIGHT,
      computed: { status: 'ok', onset_at: '2026-08-29 09:33:00', in_bed_at: '2026-08-29 09:20:00', wake_at: '2026-08-29 19:48:00' },
      transitions: [
        tx(62, '2026-08-29 04:00:00'),
        tx(61, '2026-08-29 09:20:00', { type: 'into_bed' }),
        tx(63, '2026-08-29 19:45:22'),
      ],
    };
    const beforeSettings = () => renderAsAdmin(routed, {
      route: '/children/c-1/review/2026-08-29',
      kids: [{ id: 'c-1', name: 'Child B' }],
      settings: { timezone: 'UTC' }, // SettingsContext's placeholder, not a configured zone
      loading: false,
      settingsLoaded: false,
    });
    const realZoneArrives = (rerenderWith) =>
      rerenderWith({ settings: { timezone: 'Australia/Melbourne' }, settingsLoaded: true });

    test('the review\'s reproduction: a real 19:20 put-down is never saved "No" by a one-tap made before the zone arrived', async () => {
      // Codex's execution-verified repro, step for step: the timezone still the UTC placeholder, open
      // "Before bedtime", tap "None of these were a bedtime event", THEN the real zone (Melbourne) arrives,
      // and save. Before the fix 61 — 09:20 UTC, i.e. "before 16:00" in the placeholder zone — was in the
      // group, and was saved as 'wrong' for a real put-down. The steps are taken with whatever the screen
      // offers at that moment; the next test pins that it offers neither control until the zone is known.
      api.get.mockResolvedValue(TZ_NIGHT);
      const { user, rerenderWith } = beforeSettings();
      await openEvents(user);
      await screen.findAllByRole('button', { name: /^No$/ });
      const group = screen.queryByRole('button', { name: /Before bedtime/ });
      if (group) {
        await user.click(group);
        await user.click(screen.getByRole('button', { name: /None of these were a bedtime event/ }));
      }

      realZoneArrives(rerenderWith);
      await waitFor(() => expect(screen.getByText('19:33')).toBeInTheDocument());

      await user.click(screen.getByRole('button', { name: /Save just the event answers/ }));
      await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
      expect(api.put.mock.calls[0][1].verdicts[61], 'the real 19:20 put-down').toBeUndefined();
    });

    test('before the zone is known the list is flat — nothing grouped, no one-tap — and it groups by the REAL zone once it is', async () => {
      api.get.mockResolvedValue(TZ_NIGHT);
      const { user, rerenderWith } = beforeSettings();
      await openEvents(user);
      await waitFor(() => expect(rowOf(61)).toBeTruthy());
      expect(screen.queryByRole('button', { name: /Before bedtime/ }), 'no group on a guessed zone').toBeNull();
      expect(screen.queryByRole('button', { name: /None of these were a bedtime event/ })).toBeNull();
      expect(earlyBox()).toBeNull();
      // Nothing is hidden meanwhile: every event is drawn with its own chips, as on a night with no bedtime.
      for (const id of [61, 62, 63]) {
        expect(within(rowOf(id)).getByRole('button', { name: 'No', exact: true }), `row ${id}`).toBeInTheDocument();
      }

      realZoneArrives(rerenderWith);
      // Melbourne: only 62 (14:00) is before 16:00 on the 29th. 61 (19:20) is NOT, whatever UTC said.
      expect(await screen.findByRole('button', { name: /Before bedtime \(1\)/ })).toBeInTheDocument();
      expect(rowOf(61), 'the put-down is outside the collapsed group, still drawn').toBeTruthy();
      await openGroup(user);
      expect(earlyBox().contains(rowOf(62))).toBe(true);
      expect(earlyBox().contains(rowOf(61))).toBe(false);
      await user.click(screen.getByRole('button', { name: /None of these were a bedtime event/ }));

      await user.click(screen.getByRole('button', { name: /Save just the event answers/ }));
      await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
      const { verdicts } = api.put.mock.calls[0][1];
      expect(verdicts[62], 'the genuinely early event').toBe('wrong');
      expect(verdicts[61], 'the real put-down').toBeUndefined();
      expect(verdicts[63]).toBeUndefined();
    });
  });

  // --- "no one was in the bed" (the nobody-in-bed plan, R5) ---------------------------------------

  describe('"no one was in the bed"', () => {
    test('a fresh, unflagged night never shows the flag view', async () => {
      at();
      await screen.findByRole('button', { name: /That.s right/ });
      expect(screen.queryByText('You said no one was in the bed.')).not.toBeInTheDocument();
    });

    test('tapping the button from confirm mode saves the flag alone — no times, nothing else', async () => {
      const { user } = at();
      await user.click(await screen.findByRole('button', { name: /No one was in the bed/ }));
      await waitFor(() => expect(api.put).toHaveBeenCalled());
      expect(api.put.mock.calls[0][0]).toBe('/children/c-1/review/2026-08-29');
      // Exactly this body — not merely "contains" it — because sending the (unrelated) `onset`/`wake`
      // state alongside the flag is precisely what would trip the server's "pick one" 400. `note: null`
      // because nothing was typed here — see the dedicated note test below for the non-empty case.
      expect(api.put.mock.calls[0][1]).toEqual({ nobody_in_bed: true, note: null });
    });

    test('tapping it from edit mode abandons whatever was typed IN THE TIME FIELDS rather than sending it alongside the flag', async () => {
      const { user } = at();
      await user.click(await screen.findByRole('button', { name: /Not quite/ }));
      const wake = await screen.findByLabelText(/Got up for the day/);
      await user.clear(wake);
      await user.type(wake, '06:10');

      await user.click(screen.getByRole('button', { name: /No one was in the bed/ }));
      await waitFor(() => expect(api.put).toHaveBeenCalled());
      expect(api.put.mock.calls[0][1]).toEqual({ nobody_in_bed: true, note: null });
    });

    // Regression (finding #4): saveNobody used to send ONLY `{nobody_in_bed: true}`, so a note typed
    // in edit mode — directly above this same button, and unrelated to the flag/time exclusion rule
    // enforced server-side (sleepReviews.js's `pick('note', ...)` is independent of it) — was silently
    // discarded the instant this button was tapped instead of "Save review". There is no server-side
    // reason for that: the note describes the NIGHT, not a specific time or event.
    test('a note typed in edit mode is NOT discarded when the flag is saved instead of "Save review"', async () => {
      const { user } = at();
      await user.click(await screen.findByRole('button', { name: /Not quite/ }));
      const noteField = await screen.findByLabelText(/worth noting/);
      await user.type(noteField, 'he was sick, checked on him twice');

      await user.click(screen.getByRole('button', { name: /No one was in the bed/ }));
      await waitFor(() => expect(api.put).toHaveBeenCalled());
      expect(api.put.mock.calls[0][1]).toEqual({
        nobody_in_bed: true,
        note: 'he was sick, checked on him twice',
      });
    });

    // ★ THE FIX #1 REGRESSION TEST. Before the fix, `nobody`/`nobodyTouched` were set BEFORE the await,
    // so a failed save left the screen claiming the flag HAD been set even though the server rejected
    // it — and the only button left was "Someone was in the bed" (the UNDO), which would then fire the
    // OPPOSITE of what was actually asked for, against a flag that was never really set. Compare `save()`
    // above (line ~233), which never mutates an answer before its own await for the same reason.
    test('★ a failed save does NOT claim the flag was set, and a retry sends the ORIGINAL action', async () => {
      api.put.mockRejectedValueOnce(new Error('offline'));
      const { user } = at();
      await user.click(await screen.findByRole('button', { name: /No one was in the bed/ }));
      await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));

      // The screen must still show the ORIGINAL confirm view — not "You said no one was in the bed.",
      // which would be a claim about server state that never actually happened.
      expect(screen.queryByText('You said no one was in the bed.')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Someone was in the bed/ })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /That.s right/ })).toBeInTheDocument();
      expect(screen.getByText(/Could not save|offline/)).toBeInTheDocument();

      // The retry is the SAME button, sending the SAME (true) intent — not an undo of a flag that was
      // never actually stored.
      await user.click(screen.getByRole('button', { name: /No one was in the bed/ }));
      await waitFor(() => expect(api.put).toHaveBeenCalledTimes(2));
      expect(api.put.mock.calls[1][1]).toEqual({ nobody_in_bed: true, note: null });
    });

    // ★ THE R5 REGRESSION TEST. Without seeding `nobody` from the flag, `editing` is seeded from
    // `review.true_onset_at`/`true_wake_at` — which the flag always clears server-side — so the screen
    // falls through to the confirm block offering "That's right" for the DETECTOR's own 19:33/05:48,
    // silently misrepresenting what the parent actually said. GET /review returns the flag as the raw
    // stored column (0/1, same shape as `dismissed`), so this also pins truthiness over `=== true`.
    test('★ reopening a flagged night seeds the flag view, never "confirm the detector\'s times"', async () => {
      api.get.mockResolvedValue({ ...NIGHT, review: { nobody_in_bed: 1 } });
      at();
      expect(await screen.findByText('You said no one was in the bed.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Someone was in the bed/ })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /That.s right/ })).not.toBeInTheDocument();
      expect(screen.queryByText('19:33')).not.toBeInTheDocument();
      expect(screen.queryByLabelText(/Fell asleep/)).not.toBeInTheDocument();
    });

    test('undo ("Someone was in the bed") sends the flag alone — no times attached (README\'s stated limit)', async () => {
      // Backend behaviour (pinned in backend/test/nobody-in-bed.test.js): un-flagging with nothing else
      // sent restores the detector's night but does NOT restore whatever was typed before the flag was
      // set — the times are gone for good, and the morning card then shows neither "ask" nor "done".
      // That is only true if THIS call sends nothing but the flag; attaching the (stale, hidden)
      // onset/wake state here would silently confirm the detector's guess instead of leaving it quiet.
      api.get.mockResolvedValue({ ...NIGHT, review: { nobody_in_bed: 1 } });
      const { user } = at();
      await user.click(await screen.findByRole('button', { name: /Someone was in the bed/ }));
      await waitFor(() => expect(api.put).toHaveBeenCalled());
      expect(api.put.mock.calls[0][1]).toEqual({ nobody_in_bed: false, note: null });
    });

    test('★ a late-arriving timezone does not clear the seeded flag, nor flash the detector\'s confirm prompt', async () => {
      api.get.mockResolvedValue({ ...NIGHT, review: { nobody_in_bed: 1 } });
      const { rerenderWith } = renderAsAdmin(routed, {
        route: '/children/c-1/review/2026-08-29',
        kids: [{ id: 'c-1', name: 'Child B' }],
        settings: { timezone: 'UTC' }, // as it is for the first moments after a reload
      });
      await screen.findByText('You said no one was in the bed.');

      rerenderWith({ settings: { timezone: 'Australia/Melbourne' } });
      // The seeding effect re-runs (it depends on `tz`) but must reseed the SAME flagged view, not fall
      // back through to a detector confirm prompt it never showed in the first place.
      await waitFor(() => expect(screen.getByText('You said no one was in the bed.')).toBeInTheDocument());
      expect(screen.queryByRole('button', { name: /That.s right/ })).not.toBeInTheDocument();
    });

    // ★ STRENGTHENS THE ABOVE TEST (review finding, 2026-09-29). The test above seeds the SAME stored
    // value (`nobody_in_bed: 1`) before AND after the timezone arrives, so removing the `!nobodyTouched`
    // guard entirely (`if (!nobodyTouched) setNobody(...)` -> unconditional) would not change its
    // outcome — a mutant that survives. This test starts the flag OFF (a value the reseed WOULD apply if
    // the guard were gone), has the user turn it ON — a genuine local divergence from the fetched
    // `data.review.nobody_in_bed`, which never changes after the initial fetch — and only THEN triggers
    // the tz-driven reseed, so a dropped guard is directly observable: it would flip the screen straight
    // back to the confirm view. `useNavigate` is mocked to a no-op at the top of this file for exactly
    // this: a successful save navigates away in the real app (see saveNobody), which would unmount this
    // screen before the late reseed could even run — the guard is what's under test, not that timing.
    test('★★ the touched flag survives a late reseed carrying the OLD stored value (kills the dropped-guard mutant)', async () => {
      api.get.mockResolvedValue({ ...NIGHT, review: { nobody_in_bed: 0 } });
      const { user, rerenderWith } = renderAsAdmin(routed, {
        route: '/children/c-1/review/2026-08-29',
        kids: [{ id: 'c-1', name: 'Child B' }],
        settings: { timezone: 'UTC' }, // a genuine value change below, same as the test above
      });
      await user.click(await screen.findByRole('button', { name: /No one was in the bed/ }));
      await waitFor(() => expect(screen.getByText('You said no one was in the bed.')).toBeInTheDocument());

      rerenderWith({ settings: { timezone: 'Australia/Melbourne' } });
      // Without the guard, this reseed would read `data.review.nobody_in_bed` (still 0 — `data` was
      // fetched once and never changes) and flip straight back to the confirm view.
      expect(screen.getByText('You said no one was in the bed.')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /That.s right/ })).not.toBeInTheDocument();
    });
  });
});
