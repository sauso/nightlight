// The morning review — the card on the child's page and the one-question screen behind it.
//
// Rewritten 2026-10-27 with the screen: it used to ask for three times and a verdict on every recorded event
// (about 190 controls on a real night), and was skipped most mornings. It now asks only when the child got
// up. What is worth testing here is not the layout:
//   1. THE CARD MUST GO AWAY AND STAY AWAY. Dismissing has to be as final as answering. A prompt that
//      reappears after being dismissed teaches the habit of ignoring it, and then the nights that
//      actually matter get ignored too — which would quietly destroy the feature's whole purpose.
//   2. THE BROWSER MUST NOT CONVERT TIMES. It sends the wall-clock 'HH:MM' that was typed and the
//      server resolves it against the app's configured timezone (the noon rule that decides which side
//      of midnight a bare time falls on is tested in backend/test/morning-review.test.js). Converting
//      here would use the PHONE's zone, so a review typed while travelling would disagree with the very
//      card it was correcting — silently, in the data everything else is scored against.
//   3. THE PAYLOAD IS THE WAKE ANSWER AND WHAT WAS ON SCREEN, AND NOTHING ELSE. Keys the person did not
//      touch are OMITTED (the server reads that as "keep what is stored"), never sent as null or as the
//      detector's guess. The tests below compare the key SET, so a stray key fails them by name.
//   4. NOTHING THAT SENDS A TIME WORKS BEFORE THE REAL TIMEZONE HAS ARRIVED (#512). The real-provider
//      version of that is in nightReviewTimezoneGate.test.jsx; the cases here use the injected flag.

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { Routes, Route } from 'react-router-dom';
import { renderAsAdmin, renderAsCaregiver, forEachRole, renderAs } from './helpers/render.jsx';
import MorningReviewCard from '../src/components/MorningReviewCard.jsx';
import NightReview from '../src/pages/NightReview.jsx';
import { api } from '../src/lib/api.js';

// `useNavigate` is a no-op across this whole file. NightReview navigates away on every successful save
// (see save/saveNobody), which — under the real router — unmounts the screen the moment a save
// succeeds. No test here asserts on where navigate actually goes (only on `api.put` calls and on-screen
// text), and it is what makes the "touched flag survives a late reseed" test below observable at all:
// without it, the component would be gone before the late reseed it needs to provoke could even run.
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

  test('it asks the one question the screen asks — when they got up — and no longer quotes bedtime or an event count', async () => {
    renderAsAdmin(<MorningReviewCard childId="c-1" fmtTime={fmtTime} />);
    expect(await screen.findByText(/We think they got up at 19:48/)).toBeInTheDocument();
    expect(screen.queryByText(/fell asleep/)).not.toBeInTheDocument();
    expect(screen.queryByText(/recorded event/)).not.toBeInTheDocument();
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

  test('a wake-only answer shows a receipt that says only "up at …", with a way back in, not nothing', async () => {
    // Vanishing on save is indistinguishable from failing, which is how this first landed. And the receipt
    // must not quote an asleep time the person never gave: `onset_at` is in the response (the stored
    // detector time, resolved) and is planted here as the marker that would leak if the receipt read it.
    api.get.mockResolvedValue({
      state: 'done',
      night_date: '2026-08-29',
      true_onset_at: null,
      true_wake_at: '2026-08-29 19:29:00',
      true_in_bed_at: null,
      onset_at: '2026-08-29 09:33:00',
      wake_at: '2026-08-29 19:29:00',
    });
    renderAsAdmin(<MorningReviewCard childId="c-1" fmtTime={fmtTime} />);
    expect(await screen.findByText(/that.s recorded/i)).toBeInTheDocument();
    expect(screen.getByText('You said up at 19:29. Tap to change it.')).toBeInTheDocument();
    expect(screen.queryByText(/09:33|asleep|— to —/)).not.toBeInTheDocument();
  });

  test('"no one was in the bed" gets its own receipt line', async () => {
    // reviewCardState returns `nobody_in_bed` as a REAL boolean (unlike GET /review's raw 0/1 column), so
    // `true` here is the actual server shape, not a stand-in.
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
  });

  test('★ an older review that holds all three times still reads all three, in the order they happen', async () => {
    // Reviews saved before the one-question screen carry an in-bed, an asleep and a wake time the person gave.
    // The receipt says what they said, so all three come back; none is the detector's.
    api.get.mockResolvedValue({
      state: 'done',
      night_date: '2026-08-29',
      true_in_bed_at: '2026-08-29 08:49:00',
      true_onset_at: '2026-08-29 09:13:00',
      true_wake_at: '2026-08-29 20:37:00',
      nobody_in_bed: false,
    });
    renderAsAdmin(<MorningReviewCard childId="c-1" fmtTime={fmtTime} />);
    expect(await screen.findByText('You said in bed 08:49, asleep 09:13, up at 20:37. Tap to change it.')).toBeInTheDocument();
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
  // 09:33Z / 19:48Z are 19:33 and 05:48 Melbourne. `transitions` is what the server still sends: the screen
  // no longer shows them, and one test below proves none of it reaches the page.
  const NIGHT = {
    child_id: 'c-1',
    night_date: '2026-08-29',
    settings: { key: '', tz: 'Australia/Melbourne' },
    computed: { status: 'ok', onset_at: '2026-08-29 09:33:00', in_bed_at: '2026-08-29 09:10:00', wake_at: '2026-08-29 19:48:00' },
    review: null,
    transitions: [
      { id: 11, type: 'out_of_bed', created_at: '2026-08-29 19:45:22', snapshot: 1, verdict: 'wrong', camera_name: 'Child B Room' },
      { id: 12, type: 'into_bed', created_at: '2026-08-29 19:47:30', snapshot: 0, verdict: null, camera_name: 'Child B Room' },
    ],
  };

  beforeEach(() => {
    vi.spyOn(api, 'get').mockResolvedValue(NIGHT);
    vi.spyOn(api, 'put').mockResolvedValue({});
  });

  // Mounted on a real Route: NightReview takes :id and :date from useParams, and rendered bare those
  // are undefined — which is a different screen from the one the app actually shows.
  const routed = <Routes><Route path="/children/:id/review/:date" element={<NightReview />} /></Routes>;
  const ROUTE = '/children/c-1/review/2026-08-29';
  const KIDS = [{ id: 'c-1', name: 'Child B' }];
  const at = (renderer = renderAsAdmin, extra = {}) => renderer(routed, { route: ROUTE, kids: KIDS, ...extra });

  const thatsRight = () => screen.findByRole('button', { name: /That.s right/ });
  const lastBody = () => api.put.mock.calls[api.put.mock.calls.length - 1][1];
  // The key SET of a body, sorted: a stray key (onset, note, verdicts, a null) fails by name.
  const keysOf = (body) => Object.keys(body).sort();
  const WAKE_ONLY_KEYS = ['computed_onset_at', 'computed_wake_at', 'settings_key', 'true_wake_local'];

  test("it asks one question, and confirming the app's answer is one tap", async () => {
    // "We were right" is the most valuable record and the one nobody writes down unaided — so it has to be a
    // single deliberate button, not a form you scroll past. Melbourne 05:48 in the viewer's locale.
    at();
    expect(await screen.findByText(/^Up at 5:48 am.*Is that right\?/)).toBeInTheDocument();
    expect(await thatsRight()).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Not quite' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /No one was in the bed/ })).toBeInTheDocument();
  });

  test('★ none of the old per-event UI is on the page, although the server still sends the events', async () => {
    // The fixture carries two recorded events (one with a stored "No" verdict and a camera name). The page
    // ignores them: no list, no photos, no Yes/No/Can't tell, no "What was it?", no quick check-in, no
    // "Before bedtime", no "Answered by" line.
    api.get.mockResolvedValue({ ...NIGHT, review: { true_wake_at: null, answered_by_username: 'carer1' } });
    at();
    await thatsRight();
    for (const gone of [/recorded events/, /Enlarge photo/, /Child B Room/, /Answered by/, /Quick check-in/, /Still moving/,
      /Before bedtime/, /What was it\?/, /event answers/, /Put down here/, /Up for the day here/]) {
      expect(screen.queryByText(gone), String(gone)).not.toBeInTheDocument();
    }
    expect(screen.queryByRole('button', { name: /^(Yes|No|Can.t tell)$/ })).not.toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
  });

  test('★ "That\'s right" sends the wake answer, what was on screen, and the settings key — and NOTHING else', async () => {
    // Plan amendment 3. Keys left out are "keep what is stored" to the server; sent as null they would clear,
    // and the old "That's right" sent the detector's fell-asleep time as the owner's own answer.
    const { user } = at();
    await user.click(await thatsRight());
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    const [url, body] = api.put.mock.calls[0];
    expect(url).toBe('/children/c-1/review/2026-08-29');
    // The browser does not convert: the wall clock as shown in the app's zone, for the server to resolve.
    expect(body).toEqual({
      true_wake_local: '05:48',
      computed_onset_at: '2026-08-29 09:33:00',
      computed_wake_at: '2026-08-29 19:48:00',
      settings_key: '',
    });
    expect(keysOf(body)).toEqual(WAKE_ONLY_KEYS);
  });

  test('★ it sends back WHAT IT SHOWED, so the server can record it beside the answer', async () => {
    // This is the assertion whose absence let a broken feature ship. The server was changed to store the
    // client's echo instead of recomputing — and the client was never changed to send it, so every review
    // recorded "the app had no opinion", which was false for every single one of them. The backend tests
    // passed because they send the fields explicitly. The ONSET echo is sent although the screen no longer
    // asks about it: it records what the detector said, beside the answer.
    const { user } = at();
    await user.click(await thatsRight());
    await waitFor(() => expect(api.put).toHaveBeenCalled());
    expect(lastBody()).toMatchObject({
      computed_onset_at: '2026-08-29 09:33:00',
      computed_wake_at: '2026-08-29 19:48:00',
    });
  });

  test('#361 PR 4b: "That\'s right" sends back the settings key it was given, and nothing when there was none', async () => {
    api.get.mockResolvedValue({ ...NIGHT, settings: { key: 'ctx-abc', tz: 'Australia/Melbourne' } });
    const { user, unmount } = at();
    await user.click(await thatsRight());
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    expect(api.put.mock.calls[0][1]).toHaveProperty('settings_key', 'ctx-abc');
    unmount();

    api.get.mockResolvedValue({ ...NIGHT, settings: undefined });
    const second = at();
    await second.user.click(await thatsRight());
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(2));
    expect(api.put.mock.calls[1][1].settings_key).toBeUndefined();
  });

  test('the app\'s answer is NOT one reflex tap from becoming ground truth: "Not quite" is a separate act that reveals ONE time field', async () => {
    // A pre-filled form saves by reflex, and the app's answer is sometimes badly wrong — a drifted wake of
    // 08:29 against a real 06:00. Confirming and correcting are separate, deliberate acts, and the screen
    // shows no time field until correcting is chosen.
    const { user } = at();
    await thatsRight();
    expect(screen.queryByLabelText(/Got up for the day/)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Not quite' }));
    expect(await screen.findByLabelText(/Got up for the day/)).toHaveValue('05:48');
    // Only the wake is asked: the other two times stay behind the disclosure.
    expect(screen.queryByLabelText(/Fell asleep/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/In bed/)).not.toBeInTheDocument();
    // And "That's right" is replaced by Save: one primary action at a time.
    expect(screen.queryByRole('button', { name: /That.s right/ })).not.toBeInTheDocument();
  });

  test('★ "Not quite" then a typed wake sends that wake as wall-clock text, and the same minimal key set', async () => {
    const { user } = at();
    await user.click(await screen.findByRole('button', { name: 'Not quite' }));
    const wake = await screen.findByLabelText(/Got up for the day/);
    await user.clear(wake);
    await user.type(wake, '06:10');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    expect(lastBody()).toMatchObject({ true_wake_local: '06:10' });
    expect(keysOf(lastBody())).toEqual(WAKE_ONLY_KEYS);
  });

  test('Save is disabled while there is nothing to save: no wake on the night and nothing typed (a)', async () => {
    api.get.mockResolvedValue({ ...NIGHT, computed: { status: 'empty', onset_at: null, in_bed_at: null, wake_at: null } });
    const { user } = at();
    await screen.findByLabelText(/Got up for the day/);
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    await user.type(screen.getByLabelText(/Got up for the day/), '06:10');
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  test('★ (b) only "Fell asleep" typed on a night with no wake enables Save and sends NO wake key', async () => {
    // The old screen could save an asleep time on its own; the wake key is omitted (not null) because the person
    // never touched that field, so a stored wake elsewhere is not cleared.
    api.get.mockResolvedValue({ ...NIGHT, computed: { status: 'empty', onset_at: null, in_bed_at: null, wake_at: null } });
    const { user } = at();
    await screen.findByLabelText(/Got up for the day/);
    await user.type(screen.getByLabelText(/Fell asleep/), '19:40');
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    expect(lastBody()).toMatchObject({ true_onset_local: '19:40' });
    expect(lastBody()).not.toHaveProperty('true_wake_local');
  });

  test('★ (c) clearing an answered wake enables Save and sends true_wake_local: null (a caregiver can remove a time)', async () => {
    api.get.mockResolvedValue({
      ...NIGHT, review: { true_wake_at: '2026-08-29 19:40:00', true_onset_at: null, note: null },
    });
    const { user } = at();
    const wake = await screen.findByLabelText(/Got up for the day/);
    await waitFor(() => expect(wake).toHaveValue('05:40'));
    await user.clear(wake);
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    expect(lastBody().true_wake_local).toBeNull();
  });

  test('typing survives the timezone arriving — the form must not reset under you', async () => {
    // THE regression test for a real data loss. SettingsContext starts at its defaults (timezone 'UTC') and
    // replaces them when /settings resolves, so `tz` changes a moment after boot. With `tz` in the fetch
    // effect's dependencies, that re-ran, re-fetched and re-seeded the inputs — silently discarding whatever
    // had been typed in between. The owner corrected a wake to 05:52, watched it save as 08:29, and had no
    // way of knowing why. (The field shows what was typed if anything was; the zone only moves the STORED
    // value it falls back to.)
    const { user, rerenderWith } = at(renderAsAdmin, { settings: { timezone: 'UTC' } });
    await user.click(await screen.findByRole('button', { name: 'Not quite' }));
    const wake = screen.getByLabelText(/Got up for the day/);
    await user.clear(wake);
    await user.type(wake, '05:52');
    expect(wake).toHaveValue('05:52');

    // /settings resolves and the real zone replaces the placeholder.
    rerenderWith({ settings: { timezone: 'Australia/Melbourne' } });

    await waitFor(() => expect(screen.getByLabelText(/Got up for the day/)).toHaveValue('05:52'));
  });

  describe('"Change bedtime or fell-asleep time" (the disclosure)', () => {
    const toggle = () => screen.getByRole('button', { name: /Change bedtime or fell-asleep time/ });

    test('collapsed by default, with its state on the button', async () => {
      const { user } = at();
      await thatsRight();
      expect(toggle()).toHaveAttribute('aria-expanded', 'false');
      expect(screen.queryByLabelText(/Fell asleep/)).not.toBeInTheDocument();
      await user.click(toggle());
      expect(toggle()).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByLabelText(/In bed/)).toBeInTheDocument();
      expect(screen.getByLabelText(/Fell asleep/)).toBeInTheDocument();
      expect(screen.getByLabelText(/worth noting/)).toBeInTheDocument();
      await user.click(toggle());
      expect(toggle()).toHaveAttribute('aria-expanded', 'false');
      expect(screen.queryByLabelText(/Fell asleep/)).not.toBeInTheDocument();
    });

    test('★ opening it and touching nothing sends nothing extra: the detector\'s guess is never the owner\'s answer', async () => {
      // "Fell asleep" SHOWS the detector's 19:33 so there is something to edit, but it is only sent once typed.
      // In bed shows nothing at all (the detector's put-down is never seeded into it).
      const { user } = at();
      await user.click(await thatsRight().then(() => toggle()));
      expect(screen.getByLabelText(/Fell asleep/)).toHaveValue('19:33');
      expect(screen.getByLabelText(/In bed/)).toHaveValue('');
      await user.click(screen.getByRole('button', { name: /That.s right/ }));
      await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
      expect(keysOf(lastBody())).toEqual(WAKE_ONLY_KEYS);
    });

    test('★ correcting only the asleep time sends that time, and NOTHING about in bed', async () => {
      const { user } = at();
      await thatsRight();
      await user.click(toggle());
      const asleep = screen.getByLabelText(/Fell asleep/);
      await user.clear(asleep);
      await user.type(asleep, '19:20');
      await user.click(screen.getByRole('button', { name: /That.s right/ }));

      await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
      expect(lastBody()).toMatchObject({ true_wake_local: '05:48', true_onset_local: '19:20' });
      expect(keysOf(lastBody())).toEqual([...WAKE_ONLY_KEYS, 'true_onset_local'].sort());
    });

    test('★ in bed, asleep and a note typed here are all sent, alongside the wake', async () => {
      const { user } = at();
      await user.click(await screen.findByRole('button', { name: 'Not quite' }));
      await user.click(toggle());
      await user.type(screen.getByLabelText(/In bed/), '19:05');
      const asleep = screen.getByLabelText(/Fell asleep/);
      await user.clear(asleep);
      await user.type(asleep, '19:20');
      await user.type(screen.getByLabelText(/worth noting/), 'a cold');
      await user.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
      expect(lastBody()).toMatchObject({
        true_wake_local: '05:48', true_in_bed_local: '19:05', true_onset_local: '19:20', note: 'a cold',
      });
    });

    test('a stored in-bed or asleep answer opens it by itself and seeds the fields, so an answer is never hidden', async () => {
      api.get.mockResolvedValue({
        ...NIGHT,
        review: { true_in_bed_at: '2026-08-29 08:49:20', true_onset_at: null, true_wake_at: null, note: 'dressed on the bed' },
      });
      at();
      await waitFor(() => expect(screen.getByLabelText(/In bed/)).toHaveValue('18:49'));
      expect(toggle()).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByLabelText(/worth noting/)).toHaveValue('dressed on the bed');
    });

    test('its fields stay disabled until the real timezone has arrived', async () => {
      const { user } = at(renderAsAdmin, { settings: { timezone: 'UTC' }, loading: false, settingsLoaded: false });
      await thatsRight();
      await user.click(toggle());
      for (const label of [/In bed/, /Fell asleep/, /worth noting/]) expect(screen.getByLabelText(label)).toBeDisabled();
    });
  });

  describe('a night that already has an answer', () => {
    const ANSWERED = {
      ...NIGHT,
      review: { true_onset_at: null, true_wake_at: '2026-08-29 19:40:00', note: null, answered_by_username: 'carer1' },
    };

    test('it opens straight into the time field with what was said, not back to "That\'s right"', async () => {
      // Coming back to change one answer must not make you confirm from scratch.
      api.get.mockResolvedValue(ANSWERED);
      at();
      await waitFor(() => expect(screen.getByLabelText(/Got up for the day/)).toHaveValue('05:40'));
      expect(screen.getByText(/You said up at 5:40 am/)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /That.s right/ })).not.toBeInTheDocument();
    });

    test('re-saving it sends the wake only: stored bedtime, note and event answers are not re-sent', async () => {
      api.get.mockResolvedValue({ ...ANSWERED, review: { ...ANSWERED.review, note: 'checked twice' } });
      const { user } = at();
      await user.click(await screen.findByRole('button', { name: 'Save' }));
      await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
      expect(keysOf(lastBody())).toEqual(WAKE_ONLY_KEYS);
      expect(lastBody().true_wake_local).toBe('05:40');
    });

    test('★ a time typed by hand over one taken from a frame drops that frame; an untouched time keeps it', async () => {
      // A review saved by the old screen can hold a frame beside its time. The server keeps a stored frame id
      // when none is sent, so a retyped time would sit beside a frame of a different moment, labelling the
      // wrong picture "they got up". The old screen cleared the id when a time was edited; so does this.
      api.get.mockResolvedValue({ ...ANSWERED, review: { ...ANSWERED.review, true_wake_transition_id: 11 } });
      const { user, unmount } = at();
      await user.click(await screen.findByRole('button', { name: 'Save' }));
      await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
      expect(lastBody()).not.toHaveProperty('true_wake_transition_id');
      unmount();

      const second = at();
      const wake = await screen.findByLabelText(/Got up for the day/);
      await second.user.clear(wake);
      await second.user.type(wake, '05:45');
      await second.user.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(api.put).toHaveBeenCalledTimes(2));
      expect(lastBody().true_wake_transition_id).toBeNull();
      expect(lastBody().true_wake_local).toBe('05:45');
    });

    test('a first-time answer carries no frame key at all', async () => {
      const { user } = at();
      await user.click(await screen.findByRole('button', { name: 'Not quite' }));
      const wake = await screen.findByLabelText(/Got up for the day/);
      await user.clear(wake);
      await user.type(wake, '05:45');
      await user.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(api.put).toHaveBeenCalled());
      expect(lastBody()).not.toHaveProperty('true_wake_transition_id');
    });
  });

  test('★ a night the app found no wake for opens into the time field WITH the asleep field, and nothing to say "That\'s right" to', async () => {
    // #355: a detector-empty night becomes a scored night only when a parent gives BOTH times, and the review is
    // the one way in, so the disclosure is open by itself here (a night with a wake keeps it shut).
    api.get.mockResolvedValue({ ...NIGHT, computed: { status: 'empty', onset_at: null, in_bed_at: null, wake_at: null } });
    const { user } = at();
    const wake = await screen.findByLabelText(/Got up for the day/);
    expect(screen.queryByRole('button', { name: /That.s right/ })).not.toBeInTheDocument();
    expect(screen.getByText(/didn.t work out when they got up/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Change bedtime or fell-asleep time/ })).toHaveAttribute('aria-expanded', 'true');
    // Nothing to save until a time is typed, so an empty field can never be sent as an answer.
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    await user.type(wake, '06:05');
    await user.type(screen.getByLabelText(/Fell asleep/), '19:40');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    expect(lastBody()).toMatchObject({ true_wake_local: '06:05', true_onset_local: '19:40', computed_wake_at: null });
  });

  test('a failed save surfaces the reason and leaves the screen usable', async () => {
    api.put.mockRejectedValueOnce(new Error('offline'));
    const { user } = at();
    await user.click(await thatsRight());
    expect(await screen.findByText('offline')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /That.s right/ })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: /That.s right/ }));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(2));
  });

  test('★ the server\'s ordering refusal is shown in the error slot, and the answer can be corrected and sent again', async () => {
    // The wake-before-stored-asleep 400 (routes/children.js; backend/test/review-wake-only.test.js). The page
    // now sends no asleep time, so this message is the only way the person learns the time is impossible.
    const message = '"Got up for the day" can\'t be before the time they fell asleep, which this night already has.';
    api.put.mockRejectedValueOnce(new Error(message));
    const { user } = at();
    await user.click(await screen.findByRole('button', { name: 'Not quite' }));
    const wake = await screen.findByLabelText(/Got up for the day/);
    await user.clear(wake);
    await user.type(wake, '18:00');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(message)).toBeInTheDocument();
    // Still on the form, enabled, with what was typed kept.
    expect(screen.getByLabelText(/Got up for the day/)).toHaveValue('18:00');
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    await user.clear(screen.getByLabelText(/Got up for the day/));
    await user.type(screen.getByLabelText(/Got up for the day/), '06:00');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(2));
    expect(lastBody().true_wake_local).toBe('06:00');
    expect(screen.queryByText(message)).not.toBeInTheDocument();
  });

  test('a caregiver can review too', async () => {
    // The person who was in the room at 5am knows what happened; gating this to admins would lose
    // exactly the nights worth recording.
    at(renderAsCaregiver);
    expect(await thatsRight()).toBeInTheDocument();
  });

  describe('until the real timezone has arrived (#512)', () => {
    // `settingsLoaded: false` with `loading: false` is what a FAILED first /settings request leaves, so a gate
    // on `loading` fails these too. The real-provider version is nightReviewTimezoneGate.test.jsx.
    const beforeZone = (night = NIGHT) => {
      api.get.mockResolvedValue(night);
      return at(renderAsAdmin, { settings: { timezone: 'UTC' }, loading: false, settingsLoaded: false });
    };
    const zoneArrives = (rerenderWith) => rerenderWith({ settings: { timezone: 'Australia/Melbourne' }, settingsLoaded: true });

    test('nothing that sends a time can be used, and the placeholder zone\'s time is never shown to be confirmed', async () => {
      const { user, rerenderWith } = beforeZone();
      const confirm = await thatsRight();
      expect(confirm).toBeDisabled();
      // Tapped anyway: nothing is sent. Before the gate it sent the placeholder zone's time at once.
      await user.click(confirm);
      expect(api.put).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Not quite' })).toBeDisabled();
      // The question (and so the time in the wrong zone) is not on screen; the page says why instead.
      expect(screen.queryByText(/Is that right\?/)).not.toBeInTheDocument();
      expect(screen.getByText(/timezone setting could not be loaded/)).toBeInTheDocument();
      expect(screen.queryByText(/Waiting for the app.s timezone setting/)).toBeNull();
      // Nothing about "no one was in the bed" carries a time, so it still works.
      expect(screen.getByRole('button', { name: /No one was in the bed/ })).toBeEnabled();

      zoneArrives(rerenderWith);
      await waitFor(() => expect(screen.getByRole('button', { name: /That.s right/ })).toBeEnabled());
      expect(screen.getByText(/^Up at 5:48 am/)).toBeInTheDocument();
      expect(screen.queryByText(/timezone setting could not be loaded/)).toBeNull();
      await user.click(screen.getByRole('button', { name: /That.s right/ }));
      await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
      expect(lastBody().true_wake_local).toBe('05:48');
    });

    test('a night reopened into its time field waits too: the field and Save stay disabled until the zone is known', async () => {
      // The time field is on screen from the first paint on a night already answered, so there is something to
      // type into before /settings resolves.
      beforeZone({ ...NIGHT, review: { true_wake_at: '2026-08-29 19:40:00', true_onset_at: null } });
      await waitFor(() => expect(screen.getByLabelText(/Got up for the day/)).toBeInTheDocument());
      expect(screen.getByLabelText(/Got up for the day/)).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    });
  });

  describe('"no one was in the bed"', () => {
    test('a fresh, unflagged night never shows the flag view', async () => {
      at();
      await thatsRight();
      expect(screen.queryByText('You said no one was in the bed.')).not.toBeInTheDocument();
    });

    test('tapping the link saves the flag alone — no times, nothing else', async () => {
      const { user } = at();
      await user.click(await screen.findByRole('button', { name: /No one was in the bed/ }));
      await waitFor(() => expect(api.put).toHaveBeenCalled());
      expect(api.put.mock.calls[0][0]).toBe('/children/c-1/review/2026-08-29');
      // Exactly this body — not merely "contains" it — because sending a time alongside the flag is
      // precisely what would trip the server's "pick one" 400.
      expect(api.put.mock.calls[0][1]).toEqual({ nobody_in_bed: true });
    });

    test('tapping it after typing a wake abandons that wake rather than sending it alongside the flag', async () => {
      const { user } = at();
      await user.click(await screen.findByRole('button', { name: 'Not quite' }));
      const wake = await screen.findByLabelText(/Got up for the day/);
      await user.clear(wake);
      await user.type(wake, '06:10');

      await user.click(screen.getByRole('button', { name: /No one was in the bed/ }));
      await waitFor(() => expect(api.put).toHaveBeenCalled());
      expect(api.put.mock.calls[0][1]).toEqual({ nobody_in_bed: true });
    });

    // Regression: saveNobody used to send ONLY `{nobody_in_bed: true}`, so a note typed in the form was silently
    // discarded the instant this was tapped instead of saving. The note describes the NIGHT, not a time, and the
    // server's note handling is independent of the flag/time exclusion.
    test('a note typed in the disclosure is NOT discarded when the flag is saved', async () => {
      const { user } = at();
      await thatsRight();
      await user.click(screen.getByRole('button', { name: /Change bedtime or fell-asleep time/ }));
      await user.type(screen.getByLabelText(/worth noting/), 'he was sick, checked on him twice');

      await user.click(screen.getByRole('button', { name: /No one was in the bed/ }));
      await waitFor(() => expect(api.put).toHaveBeenCalled());
      expect(api.put.mock.calls[0][1]).toEqual({ nobody_in_bed: true, note: 'he was sick, checked on him twice' });
    });

    // ★ Before the fix the flag was set BEFORE the await, so a failed save left the screen claiming it HAD been
    // set even though the server rejected it, and the only button left was "Someone was in the bed" (the UNDO),
    // which would fire the OPPOSITE of what was asked, against a flag that was never really set.
    test('★ a failed save does NOT claim the flag was set, and a retry sends the ORIGINAL action', async () => {
      api.put.mockRejectedValueOnce(new Error('offline'));
      const { user } = at();
      await user.click(await screen.findByRole('button', { name: /No one was in the bed/ }));
      await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));

      expect(screen.queryByText('You said no one was in the bed.')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Someone was in the bed/ })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /That.s right/ })).toBeInTheDocument();
      expect(screen.getByText(/Could not save|offline/)).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /No one was in the bed/ }));
      await waitFor(() => expect(api.put).toHaveBeenCalledTimes(2));
      expect(api.put.mock.calls[1][1]).toEqual({ nobody_in_bed: true });
    });

    // ★ Reopening a flagged night must show the flag view, never "That's right" for the detector's own wake: a
    // flag always clears the review's stored times server-side, so without seeding it the screen would
    // misrepresent what the parent actually said. GET /review returns the flag as the raw stored column (0/1),
    // so this also pins truthiness over `=== true`.
    test('★ reopening a flagged night shows the flag view, never "confirm the detector\'s time"', async () => {
      api.get.mockResolvedValue({ ...NIGHT, review: { nobody_in_bed: 1 } });
      at();
      expect(await screen.findByText('You said no one was in the bed.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Someone was in the bed/ })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /That.s right/ })).not.toBeInTheDocument();
      expect(screen.queryByText(/Is that right\?/)).not.toBeInTheDocument();
      expect(screen.queryByLabelText(/Got up for the day/)).not.toBeInTheDocument();
    });

    test('undo ("Someone was in the bed") sends the flag alone — no times attached', async () => {
      // Backend behaviour (pinned in backend/test/nobody-in-bed.test.js): un-flagging with nothing else sent
      // restores the detector's night but does NOT restore whatever was typed before the flag was set. That is
      // only true if THIS call sends nothing but the flag.
      api.get.mockResolvedValue({ ...NIGHT, review: { nobody_in_bed: 1 } });
      const { user } = at();
      await user.click(await screen.findByRole('button', { name: /Someone was in the bed/ }));
      await waitFor(() => expect(api.put).toHaveBeenCalled());
      expect(api.put.mock.calls[0][1]).toEqual({ nobody_in_bed: false });
    });

    test('★ a late-arriving timezone does not clear the seeded flag, nor flash the detector\'s question', async () => {
      api.get.mockResolvedValue({ ...NIGHT, review: { nobody_in_bed: 1 } });
      const { rerenderWith } = at(renderAsAdmin, { settings: { timezone: 'UTC' } });
      await screen.findByText('You said no one was in the bed.');

      rerenderWith({ settings: { timezone: 'Australia/Melbourne' } });
      await waitFor(() => expect(screen.getByText('You said no one was in the bed.')).toBeInTheDocument());
      expect(screen.queryByRole('button', { name: /That.s right/ })).not.toBeInTheDocument();
    });

    // ★ Starts the flag OFF, has the user turn it ON (a genuine local divergence from the fetched
    // `review.nobody_in_bed`, which never changes after the fetch) and only THEN triggers the tz-driven
    // rerender. A screen that fell back to the fetched value on every render would flip straight back to the
    // question. `useNavigate` is mocked to a no-op at the top of this file for exactly this: a successful save
    // navigates away in the real app, which would unmount the screen before the rerender could run.
    test('★★ the confirmed flag survives a later rerender that still carries the OLD stored value', async () => {
      api.get.mockResolvedValue({ ...NIGHT, review: { nobody_in_bed: 0 } });
      const { user, rerenderWith } = at(renderAsAdmin, { settings: { timezone: 'UTC' } });
      await user.click(await screen.findByRole('button', { name: /No one was in the bed/ }));
      await waitFor(() => expect(screen.getByText('You said no one was in the bed.')).toBeInTheDocument());

      rerenderWith({ settings: { timezone: 'Australia/Melbourne' } });
      expect(screen.getByText('You said no one was in the bed.')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /That.s right/ })).not.toBeInTheDocument();
    });

    test('★ the flag view offers no time controls and no Save, even after a wake was being typed (#631)', async () => {
      // Typed a wake, then tapped the link. The mocked save succeeds and the flag view shows; nothing in it may
      // offer to save the wake the flag just abandoned. The positive half (Save exists on the form) comes first
      // in the SAME test, so a button that never renders cannot satisfy the absence check.
      const { user } = at();
      await user.click(await screen.findByRole('button', { name: 'Not quite' }));
      const wake = await screen.findByLabelText(/Got up for the day/);
      await user.clear(wake);
      await user.type(wake, '06:10');
      expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
      expect(document.querySelector('main .btn-primary')).not.toBeNull(); // the selector below really finds it

      await user.click(screen.getByRole('button', { name: /No one was in the bed/ }));
      await screen.findByText('You said no one was in the bed.');
      expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
      // ...and not in its busy spelling either: the mocked save succeeds and the real screen would navigate
      // away, so `busy` is still true here and a Save button would read "Saving…". The flag view's own undo
      // button is secondary (and also reads "Saving…"), so the primary button is what must be absent.
      expect(document.querySelector('main .btn-primary')).toBeNull();
      expect(screen.queryByLabelText(/Got up for the day/)).not.toBeInTheDocument();
    });
  });
});
