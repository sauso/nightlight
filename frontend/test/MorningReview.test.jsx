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
import { screen, waitFor, within } from '@testing-library/react';
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

// The app formats a time with its zone suffix ("5:40 am AEST"), so the suggestion buttons are found by pattern.
const SUGGEST_540 = /^5:40 am.* · out of bed$/;

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
      expect(await screen.findByText(/Is that right\?/)).toBeInTheDocument();
      unmount();
    });
  });

  test('it asks the one question the screen asks — when they got up — and no longer quotes bedtime or an event count', async () => {
    renderAsAdmin(<MorningReviewCard childId="c-1" fmtTime={fmtTime} />);
    expect(await screen.findByText('Up at 19:48. Is that right?')).toBeInTheDocument();
    expect(screen.queryByText(/fell asleep/)).not.toBeInTheDocument();
    expect(screen.queryByText(/recorded event/)).not.toBeInTheDocument();
  });

  test('dismissing hides it immediately AND records the dismissal', async () => {
    // Both halves matter. Hiding without recording means it returns tomorrow; recording without hiding
    // means it sits there until a reload, which reads as broken.
    const { user } = renderAsAdmin(<MorningReviewCard childId="c-1" fmtTime={fmtTime} />);
    await screen.findByText(/Is that right\?/);

    await user.click(screen.getByRole('button', { name: /dismiss/i }));

    expect(screen.queryByText(/Is that right\?/)).not.toBeInTheDocument();
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
    await screen.findByText(/Is that right\?/);
    await user.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(screen.queryByText(/Is that right\?/)).not.toBeInTheDocument();
  });

  test('nothing renders when there is nothing to review', async () => {
    api.get.mockResolvedValue({ state: 'none' });
    const { container } = renderAsAdmin(<MorningReviewCard childId="c-1" fmtTime={fmtTime} />);
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(container.querySelector('.night__review')).toBeNull();
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
    expect(container.querySelector('.night__review')).toBeNull();
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
  // The "Edit sleep times" sheet, opened from the "Something else was off" row. Returns the dialog so a test can look
  // INSIDE it (the page behind stays in the DOM, inert, and has a note field of its own with the same label).
  const openSheet = async (user) => {
    await user.click(await screen.findByRole('button', { name: /Something else was off/ }));
    return screen.getByRole('dialog', { name: 'Edit sleep times' });
  };
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
    // The quieter answers are ONE row now; "No one was in the bed" is inside the sheet that row opens (PR I).
    expect(screen.getByRole('button', { name: /Something else was off/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /No one was in the bed/ })).not.toBeInTheDocument();
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
    const sheet = within(await openSheet(user));
    await user.type(sheet.getByLabelText(/Fell asleep/), '19:40');
    expect(sheet.getByRole('button', { name: 'Save' })).toBeEnabled();
    await user.click(sheet.getByRole('button', { name: 'Save' }));
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

  describe('"Something else was off" and the "Edit sleep times" sheet', () => {
    const row = () => screen.getByRole('button', { name: /Something else was off/ });

    test('★ a sheet, not a disclosure: closed until the row is tapped, then a dialog holding both times, the "We had" hints and the note', async () => {
      const { user } = at();
      await thatsRight();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(screen.queryByLabelText(/Fell asleep/)).not.toBeInTheDocument();
      const sheet = within(await openSheet(user));
      expect(sheet.getByLabelText(/In bed/)).toBeInTheDocument();
      expect(sheet.getByLabelText(/Fell asleep/)).toBeInTheDocument();
      // "We had" says what the app had for each, beside the field (19:10 / 19:33 Melbourne).
      expect(sheet.getByText(/^We had 7:10 pm/)).toBeInTheDocument();
      expect(sheet.getByText(/^We had 7:33 pm/)).toBeInTheDocument();
      // The note is behind "Add a note", like on the correcting step.
      expect(sheet.queryByLabelText(/worth noting/)).not.toBeInTheDocument();
      await user.click(sheet.getByRole('button', { name: /Add a note/ }));
      expect(sheet.getByLabelText(/worth noting/)).toBeInTheDocument();
      expect(sheet.getByRole('button', { name: /No one was in the bed/ })).toBeInTheDocument();
    });

    test('★ Escape closes it WITHOUT saving, hands focus back to the row, and what was typed is thrown away', async () => {
      const { user } = at();
      await thatsRight();
      let sheet = within(await openSheet(user));
      // Focus moved INTO the sheet when it opened (the shared Modal does this; this proves the page uses it).
      expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
      await user.type(sheet.getByLabelText(/In bed/), '19:05');
      await user.keyboard('{Escape}');

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(api.put).not.toHaveBeenCalled();
      expect(row()).toHaveFocus();
      // Reopened: the typed time is gone, not remembered (the sheet says closing discards).
      sheet = within(await openSheet(user));
      expect(sheet.getByLabelText(/In bed/)).toHaveValue('');
      expect(sheet.getByRole('button', { name: 'Save' })).toBeDisabled();
    });

    test('a tap on the backdrop and the close button both close it without saving', async () => {
      const { user } = at();
      await thatsRight();
      await openSheet(user);
      await user.click(screen.getByRole('button', { name: 'Close' }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      await openSheet(user);
      await user.click(document.querySelector('.modal-overlay'));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(api.put).not.toHaveBeenCalled();
    });

    test('★ opening it and touching nothing sends nothing, and Save waits for a typed time: the detector\'s guess is never the owner\'s answer', async () => {
      // "Fell asleep" SHOWS the detector's 19:33 so there is something to edit, but it is only sent once typed.
      // In bed shows nothing at all (the detector's put-down is never seeded into it).
      const { user } = at();
      const sheet = within(await thatsRight().then(() => openSheet(user)));
      expect(sheet.getByLabelText(/Fell asleep/)).toHaveValue('19:33');
      expect(sheet.getByLabelText(/In bed/)).toHaveValue('');
      expect(sheet.getByRole('button', { name: 'Save' })).toBeDisabled();
      await user.click(sheet.getByRole('button', { name: 'Save' }));
      expect(api.put).not.toHaveBeenCalled();
    });

    test('★ correcting only the asleep time sends the SAME body the old page sent: that time AND the wake the page shows (no saved-data change)', async () => {
      // The fields used to sit on the page beside "That's right", whose save always sent the shown wake. The sheet's Save sends
      // it too, so this change alters nothing that is stored. (Omitting it would let a note-only save leave a night neither
      // locked nor asked again.) Identical to the pre-sheet test of the same name, key for key.
      const { user } = at();
      await thatsRight();
      const sheet = within(await openSheet(user));
      const asleep = sheet.getByLabelText(/Fell asleep/);
      await user.clear(asleep);
      await user.type(asleep, '19:20');
      await user.click(sheet.getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
      expect(lastBody()).toMatchObject({ true_wake_local: '05:48', true_onset_local: '19:20' });
      expect(keysOf(lastBody())).toEqual([...WAKE_ONLY_KEYS, 'true_onset_local'].sort());
    });

    test('★ a note-only save from the sheet sends the shown wake too, exactly as the old page did', async () => {
      const { user } = at();
      await thatsRight();
      const sheet = within(await openSheet(user));
      await user.click(sheet.getByRole('button', { name: /Add a note/ }));
      await user.type(sheet.getByLabelText(/worth noting/), 'a cold');
      await user.click(sheet.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
      expect(lastBody()).toEqual({
        true_wake_local: '05:48',
        note: 'a cold',
        computed_onset_at: '2026-08-29 09:33:00',
        computed_wake_at: '2026-08-29 19:48:00',
        settings_key: '',
      });
    });

    test('★ an error from the page does not greet the sheet, and one from the sheet does not stay on the page behind it', async () => {
      // One error slot serves both; open and close each clear it.
      api.put.mockRejectedValueOnce(new Error('page boom'));
      const { user } = at();
      await user.click(await thatsRight());
      expect(await screen.findByText('page boom')).toBeInTheDocument();
      const dialog = await openSheet(user);
      expect(within(dialog).queryByText('page boom')).not.toBeInTheDocument();
      expect(screen.queryByText('page boom')).not.toBeInTheDocument();

      api.put.mockRejectedValueOnce(new Error('sheet boom'));
      await user.type(within(dialog).getByLabelText(/In bed/), '19:05');
      await user.click(within(dialog).getByRole('button', { name: 'Save' }));
      expect(await within(dialog).findByText('sheet boom')).toBeInTheDocument();
      await user.keyboard('{Escape}');
      expect(screen.queryByText('sheet boom')).not.toBeInTheDocument();
    });

    test('★ from the correcting step, in bed, asleep and a note typed in the sheet are sent alongside the wake that step shows', async () => {
      const { user } = at();
      await user.click(await screen.findByRole('button', { name: 'Not quite' }));
      const sheet = within(await openSheet(user));
      await user.type(sheet.getByLabelText(/In bed/), '19:05');
      const asleep = sheet.getByLabelText(/Fell asleep/);
      await user.clear(asleep);
      await user.type(asleep, '19:20');
      await user.click(sheet.getByRole('button', { name: /Add a note/ }));
      await user.type(sheet.getByLabelText(/worth noting/), 'a cold');
      await user.click(sheet.getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
      expect(lastBody()).toMatchObject({
        true_wake_local: '05:48', true_in_bed_local: '19:05', true_onset_local: '19:20', note: 'a cold',
      });
    });

    test('a wake typed on the page behind is kept when the sheet is closed, and sent by the sheet\'s Save', async () => {
      const { user } = at();
      await user.click(await screen.findByRole('button', { name: 'Not quite' }));
      const wake = await screen.findByLabelText(/Got up for the day/);
      await user.clear(wake);
      await user.type(wake, '06:10');
      await openSheet(user);
      await user.keyboard('{Escape}');
      expect(screen.getByLabelText(/Got up for the day/)).toHaveValue('06:10');

      const sheet = within(await openSheet(user));
      await user.type(sheet.getByLabelText(/In bed/), '19:05');
      await user.click(sheet.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
      expect(lastBody()).toMatchObject({ true_wake_local: '06:10', true_in_bed_local: '19:05' });
    });

    test('a stored in-bed or asleep answer is read out on the row and seeds the sheet, so an answer is never hidden', async () => {
      api.get.mockResolvedValue({
        ...NIGHT,
        review: { true_in_bed_at: '2026-08-29 08:49:20', true_onset_at: null, true_wake_at: null, note: 'dressed on the bed' },
      });
      const { user } = at();
      expect(await screen.findByText(/You said in bed 6:49 pm.*Tap to change it./)).toBeInTheDocument();
      const sheet = within(await openSheet(user));
      expect(sheet.getByLabelText(/In bed/)).toHaveValue('18:49');
      // A stored note shows its field at once, without a tap on "Add a note".
      expect(sheet.getByLabelText(/worth noting/)).toHaveValue('dressed on the bed');
    });

    test('its fields stay disabled until the real timezone has arrived, but it can be opened', async () => {
      const { user } = at(renderAsAdmin, { settings: { timezone: 'UTC' }, loading: false, settingsLoaded: false });
      await thatsRight();
      const sheet = within(await openSheet(user));
      for (const label of [/In bed/, /Fell asleep/]) expect(sheet.getByLabelText(label)).toBeDisabled();
      expect(sheet.getByRole('button', { name: 'Save' })).toBeDisabled();
    });

    test('★ a failed save keeps the sheet open, shows the reason INSIDE it, and keeps what was typed', async () => {
      // The page's own error banner sits behind the scrim, where nobody would see it (Modal's `error` prop exists for this).
      api.put.mockRejectedValueOnce(new Error('"In bed" can\'t be after "Fell asleep"'));
      const { user } = at();
      await thatsRight();
      const sheet = within(await openSheet(user));
      await user.type(sheet.getByLabelText(/In bed/), '21:00');
      await user.click(sheet.getByRole('button', { name: 'Save' }));
      expect(await sheet.findByText(/can.t be after/)).toBeInTheDocument();
      expect(sheet.getByLabelText(/In bed/)).toHaveValue('21:00');
      expect(sheet.getByRole('button', { name: 'Save' })).toBeEnabled();
      await user.clear(sheet.getByLabelText(/In bed/));
      await user.type(sheet.getByLabelText(/In bed/), '19:00');
      await user.click(sheet.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(api.put).toHaveBeenCalledTimes(2));
      expect(lastBody().true_in_bed_local).toBe('19:00');
    });
  });

  describe('the -5m / +5m stepper on the "Not quite" step (UI refresh PR I)', () => {
    const wakeField = () => screen.getByLabelText(/Got up for the day/);
    const earlier = () => screen.getByRole('button', { name: '−5m, 5 minutes earlier' });
    const later = () => screen.getByRole('button', { name: '+5m, 5 minutes later' });
    // A stored answer opens straight into the step; 14:02Z is 00:02 Melbourne and 13:57Z is 23:57 (UTC+10 in August).
    const answeredAt = (utc, extra = {}) => ({ ...NIGHT, review: { true_wake_at: utc, true_onset_at: null, note: null, ...extra } });

    test('★ "We had" says what the app had, the question names the child, and the time is clear before Save', async () => {
      const { user } = at();
      await user.click(await screen.findByRole('button', { name: 'Not quite' }));
      expect(screen.getByText('When did Child B get up for the day?')).toBeInTheDocument();
      expect(screen.getByText(/We had 5:48 am/)).toBeInTheDocument();
      expect(wakeField()).toHaveValue('05:48');
      // Not a typed answer until touched: Save waits only on a value being there, and a time is.
      expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    });

    test('★ each press moves the time by exactly five minutes, and Save sends the stepped time with the SAME body as a typed one', async () => {
      const { user } = at();
      await user.click(await screen.findByRole('button', { name: 'Not quite' }));
      await user.click(later());
      expect(wakeField()).toHaveValue('05:53');
      await user.click(earlier());
      await user.click(earlier());
      expect(wakeField()).toHaveValue('05:43');
      await user.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
      // Identical to the typed-time test above: the stepper edits the same value and adds no key.
      expect(lastBody()).toEqual({
        true_wake_local: '05:43',
        computed_onset_at: '2026-08-29 09:33:00',
        computed_wake_at: '2026-08-29 19:48:00',
        settings_key: '',
      });
    });

    test('★ it stops at midnight instead of wrapping: a stepped time never silently changes day', async () => {
      // 00:02 - 5 would wrap to 23:57 (the evening BEFORE, a different calendar day to the server's noon rule); 23:57 + 5 would
      // wrap to 00:02. Both stop at the edge of the day instead. Typing across midnight stays possible and is judged by the server.
      api.get.mockResolvedValue(answeredAt('2026-08-28 14:02:00'));
      const { user, unmount } = at();
      await waitFor(() => expect(wakeField()).toHaveValue('00:02'));
      await user.click(earlier());
      expect(wakeField()).toHaveValue('00:00');
      await user.click(earlier());
      expect(wakeField()).toHaveValue('00:00');
      unmount();

      api.get.mockResolvedValue(answeredAt('2026-08-29 13:57:00'));
      const second = at();
      await waitFor(() => expect(wakeField()).toHaveValue('23:57'));
      await second.user.click(later());
      expect(wakeField()).toHaveValue('23:59');
      await second.user.click(later());
      expect(wakeField()).toHaveValue('23:59');
    });

    test('typing still works after stepping, and what is sent is the time as typed', async () => {
      const { user } = at();
      await user.click(await screen.findByRole('button', { name: 'Not quite' }));
      await user.click(later());
      await user.clear(wakeField());
      await user.type(wakeField(), '06:10');
      await user.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
      expect(lastBody().true_wake_local).toBe('06:10');
    });

    test('with no time in the field there is nothing to step from, and the buttons do not invent one', async () => {
      api.get.mockResolvedValue({ ...NIGHT, computed: { status: 'empty', onset_at: null, in_bed_at: null, wake_at: null } });
      const { user } = at();
      await screen.findByLabelText(/Got up for the day/);
      expect(earlier()).toBeDisabled();
      expect(later()).toBeDisabled();
      await user.click(later());
      expect(wakeField()).toHaveValue('');
    });

    test('before the real timezone arrives the stepper is disabled too (it is a control that can send a time)', async () => {
      api.get.mockResolvedValue(answeredAt('2026-08-29 19:40:00'));
      at(renderAsAdmin, { settings: { timezone: 'UTC' }, loading: false, settingsLoaded: false });
      await screen.findByLabelText(/Got up for the day/);
      expect(earlier()).toBeDisabled();
      expect(later()).toBeDisabled();
    });

    test('★ stepping a time that was saved with a frame drops the frame, exactly as typing does', async () => {
      api.get.mockResolvedValue(answeredAt('2026-08-29 19:40:00', { true_wake_transition_id: 11 }));
      const { user } = at();
      await waitFor(() => expect(wakeField()).toHaveValue('05:40'));
      await user.click(later());
      await user.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
      expect(lastBody().true_wake_local).toBe('05:45');
      expect(lastBody().true_wake_transition_id).toBeNull();
    });
  });

  describe('logged out-of-bed times offered under the stepper', () => {
    // 19:40:10Z is 05:40 Melbourne, eight minutes from the app's 05:48. The others are each a reason NOT to offer one.
    const withEvents = (transitions, over = {}) => ({ ...NIGHT, transitions, ...over });
    const OOB = { id: 21, type: 'out_of_bed', created_at: '2026-08-29 19:40:10', verdict: null, quick_reversal_of: null };
    const wakeField = () => screen.getByLabelText(/Got up for the day/);
    const suggestion = (name) => screen.queryByRole('button', { name });

    test('★ a nearby exit is offered, tapping it sets the time and sends its id with the same body keys plus the id', async () => {
      api.get.mockResolvedValue(withEvents([OOB]));
      const { user } = at();
      await user.click(await screen.findByRole('button', { name: 'Not quite' }));
      await user.click(screen.getByRole('button', { name: SUGGEST_540 }));
      expect(wakeField()).toHaveValue('05:40');
      await user.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
      expect(lastBody()).toMatchObject({ true_wake_local: '05:40', true_wake_transition_id: 21 });
      expect(keysOf(lastBody())).toEqual([...WAKE_ONLY_KEYS, 'true_wake_transition_id'].sort());
    });

    test('★ stepping or typing after a tap drops the id: a frame is never sent beside a different time', async () => {
      api.get.mockResolvedValue(withEvents([OOB]));
      const { user } = at();
      await user.click(await screen.findByRole('button', { name: 'Not quite' }));
      await user.click(screen.getByRole('button', { name: SUGGEST_540 }));
      await user.click(screen.getByRole('button', { name: '+5m, 5 minutes later' }));
      expect(wakeField()).toHaveValue('05:45');
      await user.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
      expect(lastBody().true_wake_local).toBe('05:45');
      expect(lastBody()).not.toHaveProperty('true_wake_transition_id');
    });

    test('★ a tap replaces the frame of an answer already on record with the new id (not a clear)', async () => {
      api.get.mockResolvedValue(withEvents([OOB], {
        review: { true_wake_at: '2026-08-29 19:50:00', true_onset_at: null, note: null, true_wake_transition_id: 11 },
      }));
      const { user } = at();
      await user.click(await screen.findByRole('button', { name: SUGGEST_540 }));
      await user.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
      expect(lastBody().true_wake_transition_id).toBe(21);
    });

    test('only an exit that could be the wake is offered: not a far one, a put-down, a "wrong" one or a quick reversal; at most four, in time order', async () => {
      api.get.mockResolvedValue(withEvents([
        { ...OOB, id: 31, created_at: '2026-08-29 17:00:00' }, // 3h48m before the wake: too far
        { ...OOB, id: 32, type: 'into_bed' },
        { ...OOB, id: 33, verdict: 'wrong' },
        { ...OOB, id: 34, quick_reversal_of: 30 },
        { ...OOB, id: 41, created_at: '2026-08-29 19:30:00' }, // 05:30
        { ...OOB, id: 42, created_at: '2026-08-29 19:35:00' }, // 05:35
        { ...OOB, id: 43, created_at: '2026-08-29 19:44:00' }, // 05:44
        { ...OOB, id: 44, created_at: '2026-08-29 19:46:00' }, // 05:46
        { ...OOB, id: 45, created_at: '2026-08-29 20:40:00' }, // 06:40, the farthest of the near ones: dropped by the cap
      ]));
      const { user } = at();
      await user.click(await screen.findByRole('button', { name: 'Not quite' }));
      const offered = within(screen.getByRole('group', { name: /out-of-bed/ })).getAllByRole('button').map((b) => b.textContent);
      expect(offered.map((t) => t.replace(/ [^ ]+ · /, ' · '))).toEqual(['5:30 am · out of bed', '5:35 am · out of bed', '5:44 am · out of bed', '5:46 am · out of bed']);
    });

    test('★ an exit more than an hour from every time on the page is not offered, even when there is room for it', async () => {
      // The cap of four hides a missing window in the test above (the far exit ranks after the near ones), so it is alone here.
      api.get.mockResolvedValue(withEvents([{ ...OOB, id: 31, created_at: '2026-08-29 17:00:00' }])); // 3h48m before 05:48
      const { user } = at();
      await user.click(await screen.findByRole('button', { name: 'Not quite' }));
      expect(screen.queryByRole('group', { name: /out-of-bed/ })).not.toBeInTheDocument();
    });

    test('nothing is offered on a night with no wake and no answer to be near', async () => {
      api.get.mockResolvedValue(withEvents([OOB], { computed: { status: 'empty', onset_at: null, in_bed_at: null, wake_at: null } }));
      at();
      await screen.findByLabelText(/Got up for the day/);
      expect(screen.queryByRole('group', { name: /out-of-bed/ })).not.toBeInTheDocument();
    });

    test('a night whose response carries no events at all behaves as before', async () => {
      const { transitions, ...old } = NIGHT; // eslint-disable-line no-unused-vars
      api.get.mockResolvedValue(old);
      const { user } = at();
      await user.click(await screen.findByRole('button', { name: 'Not quite' }));
      expect(screen.queryByRole('group', { name: /out-of-bed/ })).not.toBeInTheDocument();
      expect(wakeField()).toHaveValue('05:48');
    });

    test('"That\'s right" never sends a frame, even when exits are on offer', async () => {
      api.get.mockResolvedValue(withEvents([OOB]));
      const { user } = at();
      await user.click(await thatsRight());
      await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
      expect(keysOf(lastBody())).toEqual(WAKE_ONLY_KEYS);
    });
  });

  describe('the note on the "Not quite" step', () => {
    test('it is behind "Add a note", and a note typed there is sent', async () => {
      const { user } = at();
      await user.click(await screen.findByRole('button', { name: 'Not quite' }));
      expect(screen.queryByLabelText(/worth noting/)).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: /Add a note/ }));
      await user.type(screen.getByLabelText(/worth noting/), 'woke early');
      await user.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
      expect(lastBody()).toMatchObject({ true_wake_local: '05:48', note: 'woke early' });
    });

    test('a stored note shows its field at once, and an untouched one is not re-sent', async () => {
      api.get.mockResolvedValue({ ...NIGHT, review: { true_wake_at: '2026-08-29 19:40:00', true_onset_at: null, note: 'checked twice' } });
      const { user } = at();
      await waitFor(() => expect(screen.getByLabelText(/worth noting/)).toHaveValue('checked twice'));
      await user.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
      expect(lastBody()).not.toHaveProperty('note');
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

  test('★ a night the app found no wake for opens into the time field, says what the sheet is for, and nothing to say "That\'s right" to', async () => {
    // #355: a detector-empty night becomes a scored night only when a parent gives BOTH times, and the review is
    // the one way in. The sheet cannot open by itself (the old disclosure did), so the step and the row both say where
    // the other times go.
    api.get.mockResolvedValue({ ...NIGHT, computed: { status: 'empty', onset_at: null, in_bed_at: null, wake_at: null } });
    const { user } = at();
    const wake = await screen.findByLabelText(/Got up for the day/);
    expect(screen.queryByRole('button', { name: /That.s right/ })).not.toBeInTheDocument();
    expect(screen.getByText(/didn.t work out when they got up/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Something else was off/ })).toHaveTextContent('Add when they went to bed and fell asleep.');
    // Nothing to save until a time is typed, so an empty field can never be sent as an answer.
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    // ...and the stepper has nothing to step from, so it does not invent a starting time.
    expect(screen.getByRole('button', { name: '+5m, 5 minutes later' })).toBeDisabled();
    await user.type(wake, '06:05');
    // The wake is typed on the page and the asleep time in the sheet, whose Save sends both: the page was already on the
    // wake question, so its value is an answer.
    const sheet = within(await openSheet(user));
    await user.type(sheet.getByLabelText(/Fell asleep/), '19:40');
    await user.click(sheet.getByRole('button', { name: 'Save' }));
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
      // Nothing about "no one was in the bed" carries a time, so it still works: its row opens the sheet before the zone is known.
      expect(screen.getByRole('button', { name: /Something else was off/ })).toBeEnabled();

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
      const sheet = within(await openSheet(user));
      await user.click(sheet.getByRole('button', { name: /No one was in the bed/ }));
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

      const sheet = within(await openSheet(user));
      await user.click(sheet.getByRole('button', { name: /No one was in the bed/ }));
      await waitFor(() => expect(api.put).toHaveBeenCalled());
      expect(api.put.mock.calls[0][1]).toEqual({ nobody_in_bed: true });
    });

    test('★ it stays exclusive with the times typed IN THE SAME SHEET: they are abandoned, never sent beside the flag', async () => {
      // The action now sits under the time fields it must never travel with. Both a time typed in the sheet and the page
      // behind it are dropped; only the flag (and a note, below) is sent, or the server answers "pick one" with a 400.
      const { user } = at();
      const sheet = within(await thatsRight().then(() => openSheet(user)));
      await user.type(sheet.getByLabelText(/In bed/), '19:05');
      const asleep = sheet.getByLabelText(/Fell asleep/);
      await user.clear(asleep);
      await user.type(asleep, '19:20');
      await user.click(sheet.getByRole('button', { name: /No one was in the bed/ }));
      await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
      expect(api.put.mock.calls[0][1]).toEqual({ nobody_in_bed: true });
    });

    // Regression: saveNobody used to send ONLY `{nobody_in_bed: true}`, so a note typed in the form was silently
    // discarded the instant this was tapped instead of saving. The note describes the NIGHT, not a time, and the
    // server's note handling is independent of the flag/time exclusion.
    test('a note typed in the sheet is NOT discarded when the flag is saved', async () => {
      const { user } = at();
      const sheet = within(await thatsRight().then(() => openSheet(user)));
      await user.click(sheet.getByRole('button', { name: /Add a note/ }));
      await user.type(sheet.getByLabelText(/worth noting/), 'he was sick, checked on him twice');

      await user.click(sheet.getByRole('button', { name: /No one was in the bed/ }));
      await waitFor(() => expect(api.put).toHaveBeenCalled());
      expect(api.put.mock.calls[0][1]).toEqual({ nobody_in_bed: true, note: 'he was sick, checked on him twice' });
    });

    // ★ Before the fix the flag was set BEFORE the await, so a failed save left the screen claiming it HAD been
    // set even though the server rejected it, and the only button left was "Someone was in the bed" (the UNDO),
    // which would fire the OPPOSITE of what was asked, against a flag that was never really set.
    test('★ a failed save does NOT claim the flag was set, and a retry sends the ORIGINAL action', async () => {
      api.put.mockRejectedValueOnce(new Error('offline'));
      const { user } = at();
      const sheet = within(await openSheet(user));
      await user.click(sheet.getByRole('button', { name: /No one was in the bed/ }));
      await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));

      expect(screen.queryByText('You said no one was in the bed.')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Someone was in the bed/ })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /That.s right/ })).toBeInTheDocument();
      // The reason shows inside the sheet, which stays open, where it can be seen.
      expect(sheet.getByText(/Could not save|offline/)).toBeInTheDocument();

      await user.click(sheet.getByRole('button', { name: /No one was in the bed/ }));
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
      await user.click(within(await openSheet(user)).getByRole('button', { name: /No one was in the bed/ }));
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

      const sheet = within(await openSheet(user));
      await user.click(sheet.getByRole('button', { name: /No one was in the bed/ }));
      await screen.findByText('You said no one was in the bed.');
      expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); // the sheet is gone with the form
      // ...and not in its busy spelling either: the mocked save succeeds and the real screen would navigate
      // away, so `busy` is still true here and a Save button would read "Saving…". The flag view's own undo
      // button is secondary (and also reads "Saving…"), so the primary button is what must be absent.
      expect(document.querySelector('main .btn-primary')).toBeNull();
      expect(screen.queryByLabelText(/Got up for the day/)).not.toBeInTheDocument();
    });
  });
});
