// The admin "Recompute this night" control.
//
// Four things are worth testing here and none is cosmetic:
//   1. THE BASELINE IS THE STORED ROW. The first cut of this component compared the page's `night` —
//      which is already a fresh recompute — against another fresh recompute. The two sides were the
//      same computation, so the dialog always said "exactly the same numbers" while the child's card
//      stayed wrong. The feature shipped doing nothing. That is what the first block below guards.
//   2. ROLE GATING — a caregiver must not be able to rewrite stored sleep history. The failure mode is
//      silent, which is the shape of bug this project has shipped before.
//   3. It PREVIEWS before it writes, because the write is irreversible.
//   4. THE "AFTER" PICTURE IS THE OVERLAID NIGHT, NOT THE RAW STORE RESPONSE (plan review R3). `?store=1`
//      answers "what did the detector just save", not "what should the parent see" — a corrected or
//      flagged night's normal read differs from that raw row. Trusting the store response directly
//      would repaint the page with the detector's raw answer the instant you recompute, silently
//      undoing whatever correction was showing. The fix re-fetches the normal route after storing.

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, act } from '@testing-library/react';
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
// `overlaid` defaults to FRESH so tests that don't care about R3 keep working unchanged; the R3-specific
// tests below override it to something DIFFERENT from `onStore`, which is what makes the assertion
// discriminating rather than vacuous (see the ⚠️ on the regression test itself).
// `locked` is what `?stored=1` says since 2026-09-30 (a parent corrected the night, so the server will not
// re-store it). `undefined` by default: the shape a server from before the field answers with.
function mockApi({ stored = STORED, onStore = FRESH, overlaid = FRESH, locked } = {}) {
  vi.spyOn(api, 'get').mockImplementation((url) => {
    if (url.includes('stored=1')) return Promise.resolve(locked === undefined ? { night: stored } : { night: stored, locked });
    // Checked before the plain `detail=1` branch: `?store=1&detail=1` contains both substrings.
    if (url.includes('store=1')) return Promise.resolve(onStore);
    if (url.includes('detail=1')) return Promise.resolve(overlaid);
    return Promise.reject(new Error(`unexpected call: ${url}`));
  });
}

const setup = (renderer, props = {}) =>
  renderer(
    <RecomputeNight childId="c-1" date="2026-08-28" night={props.night || FRESH} fmtTime={fmtTime}
      onRecomputed={props.onRecomputed || vi.fn()} onCorrectionRemoved={props.onCorrectionRemoved}
      settingsView={props.settingsView} onSettingsViewChange={props.onSettingsViewChange} />
  );

beforeEach(() => mockApi());
afterEach(() => vi.restoreAllMocks());

describe('a night the person has corrected', () => {
  // Rewritten 2026-09-30. The note used to say recomputing "will not change what is shown", which read as
  // "harmless, go ahead". Since the lock a corrected night is usually not recomputed at all, so the note
  // now only says what is true of EVERY corrected night, and the dialog says when it is locked.
  test('says the times are theirs and where to change them, without calling a recompute harmless', async () => {
    // The owner pressed the button on a corrected night expecting a wrong time to be replaced, and
    // nothing visible happened. The note is what explains that.
    setup(renderAsAdmin, { night: { ...FRESH, corrected: true } });
    expect(await screen.findByText(/These times are the ones you told us, and recomputing never replaces them/)).toBeInTheDocument();
    expect(screen.queryByText(/not change what is shown/)).not.toBeInTheDocument();
  });

  test('and says nothing of the sort on an ordinary night', () => {
    setup(renderAsAdmin);
    expect(screen.queryByText(/ones you told us/)).not.toBeInTheDocument();
  });
});

describe('a LOCKED night (the server says so in ?stored=1)', () => {
  test('★ opens on "locked because you corrected it", offers no save, and never stores', async () => {
    // The saved row differs from the fresh one, so without the lock this dialog WOULD offer "Save the new
    // numbers" (the tests below prove it does). Locked, it must not: the server would refuse the write.
    mockApi({ locked: true });
    const { user } = setup(renderAsAdmin, { night: { ...FRESH, corrected: true } });
    await user.click(screen.getByRole('button', { name: /recompute this night/i }));

    expect(await screen.findByText(/This night is locked because you corrected it/)).toBeInTheDocument();
    // Said as an instruction now that there is a control for it (see "Remove my correction" below).
    expect(screen.getByText(/remove your correction here to unlock it/)).toBeInTheDocument();
    expect(screen.queryByText(/Removing your correction unlocks it/)).not.toBeInTheDocument();
    expect(screen.queryByText(/no longer matches/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^cancel$/i })).not.toBeInTheDocument(); // nothing to cancel
    expect(screen.getAllByRole('button', { name: /^close$/i }).length).toBeGreaterThan(0);
    expect(api.get.mock.calls.filter(([u]) => /[?&]store=1/.test(u))).toHaveLength(0);
  });

  test('★ keys on the SERVER\'s `locked`, not on `night.corrected`: a corrected night the server calls unlocked can still be fixed', async () => {
    // A corrected night whose saved row is missing (or unscored) is NOT locked, and Recompute is the only
    // way to get it saved (plan review R8). Keying on `corrected` would hide that fix.
    mockApi({ stored: null, locked: false });
    const { user } = setup(renderAsAdmin, { night: { ...FRESH, corrected: true } });
    await user.click(screen.getByRole('button', { name: /recompute this night/i }));
    await waitFor(() => expect(screen.getByText(/nothing is saved for this night yet/i)).toBeInTheDocument());
    expect(screen.queryByText(/locked/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save this night/i })).toBeInTheDocument();
  });

  test('a server that does not send `locked` at all reads as unlocked (an older backend)', async () => {
    mockApi(); // `{ night }` only
    const { user } = setup(renderAsAdmin);
    await user.click(screen.getByRole('button', { name: /recompute this night/i }));
    await waitFor(() => expect(screen.getByText(/no longer matches/i)).toBeInTheDocument());
    expect(screen.queryByText(/locked/)).not.toBeInTheDocument();
  });
});

// "Remove my correction" (the missing control behind "Removing your correction unlocks it").
//
// The PUT body is the claim worth testing, so every assertion on it is EXACT (`toEqual` on the whole body)
// and the keys that must be absent are named: the route reads an omitted key as "keep what is stored", so a
// body that also carried `verdicts`, `note` or `computed_*` would silently re-save them as this person's
// answer. `calls` records the ORDER the requests happened in: the review is read before the write (to know
// about the flag) and the saved row is read again after it (so the dialog can leave "locked").
describe('"Remove my correction" on a LOCKED night', () => {
  const OVERLAID_UNCORRECTED = { ...FRESH, night__marker: 'after-removal' };
  const TIMES_ONLY = {
    true_onset_local: null,
    true_wake_local: null,
    true_in_bed_local: null,
    true_onset_transition_id: null,
    true_wake_transition_id: null,
    true_in_bed_transition_id: null,
  };

  function mockLockedApi({ review = { review: { nobody_in_bed: 0, true_onset_at: '2026-08-28 10:30:00' } },
    lockedAfter = false, putError = null, overlaidError = null } = {}) {
    const state = { locked: true, calls: [] };
    vi.spyOn(api, 'get').mockImplementation((url) => {
      state.calls.push(`GET ${url}`);
      if (url.includes('stored=1')) return Promise.resolve({ night: STORED, locked: state.locked });
      // A function is read at REQUEST time, so a test can change what is stored between two reads (#679).
      if (url.includes('/review/')) return Promise.resolve(typeof review === 'function' ? review() : review);
      if (url.includes('detail=1')) {
        return overlaidError ? Promise.reject(overlaidError) : Promise.resolve(OVERLAID_UNCORRECTED);
      }
      return Promise.reject(new Error(`unexpected call: ${url}`));
    });
    vi.spyOn(api, 'put').mockImplementation((url, body) => {
      state.calls.push(`PUT ${url}`);
      if (putError) return Promise.reject(putError);
      state.locked = lockedAfter;
      return Promise.resolve({ review: body });
    });
    return state;
  }

  async function openLocked(props = {}) {
    const rendered = setup(renderAsAdmin, { night: { ...FRESH, corrected: true }, ...props });
    await rendered.user.click(screen.getByRole('button', { name: /recompute this night/i }));
    await screen.findByText(/This night is locked because you corrected it/);
    return rendered;
  }

  test('★ the locked dialog offers it', async () => {
    mockLockedApi();
    await openLocked();
    expect(screen.getByRole('button', { name: /^remove my correction$/i })).toBeInTheDocument();
  });

  test('an UNLOCKED dialog has nothing to remove, so it does not offer it', async () => {
    // Not locked (a corrected night whose saved row is stale): the ordinary preview, no removal.
    mockApi({ locked: false });
    const { user } = setup(renderAsAdmin, { night: { ...FRESH, corrected: true } });
    await user.click(screen.getByRole('button', { name: /recompute this night/i }));
    await waitFor(() => expect(screen.getByText(/no longer matches/i)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /remove my correction/i })).not.toBeInTheDocument();
  });

  test('★ it asks first, in the modal, says what it does, and sends nothing until confirmed', async () => {
    const state = mockLockedApi();
    const confirm = vi.spyOn(window, 'confirm');
    const { user } = await openLocked();

    await user.click(screen.getByRole('button', { name: /^remove my correction$/i }));
    // The wording the owner required: REMOVED not hidden; the estimate may be wrong; enter them again.
    expect(screen.getByText(/They are removed, not hidden/)).toBeInTheDocument();
    expect(screen.getByText(/your answers to the events and your note are kept/i)).toBeInTheDocument();
    expect(screen.getByText(/the app’s own estimate, which may be wrong/)).toBeInTheDocument();
    expect(screen.getByText(/you will need to enter them again/)).toBeInTheDocument();
    expect(screen.getByText(/a corrected night locks again when you save it/)).toBeInTheDocument();
    expect(confirm).not.toHaveBeenCalled(); // an in-app step, never window.confirm
    expect(api.put).not.toHaveBeenCalled();

    // The unlocking button is the one in the confirm step now (there is exactly one of that name).
    expect(screen.getAllByRole('button', { name: /^remove my correction$/i })).toHaveLength(1);
    expect(state.calls.some((c) => c.startsWith('PUT'))).toBe(false);
  });

  test('★ "Keep my correction" goes back to the locked view and sends nothing', async () => {
    mockLockedApi();
    const { user } = await openLocked();
    await user.click(screen.getByRole('button', { name: /^remove my correction$/i }));
    await user.click(screen.getByRole('button', { name: /^keep my correction$/i }));

    expect(screen.getByText(/This night is locked because you corrected it/)).toBeInTheDocument();
    expect(screen.queryByText(/They are removed, not hidden/)).not.toBeInTheDocument();
    expect(api.put).not.toHaveBeenCalled();
  });

  test('★ confirming sends ONLY the six time fields, as nulls: no verdicts, reasons, note, computed_* or flag', async () => {
    const state = mockLockedApi();
    const { user } = await openLocked();
    await user.click(screen.getByRole('button', { name: /^remove my correction$/i }));
    await user.click(screen.getByRole('button', { name: /^remove my correction$/i }));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));

    const [url, body] = api.put.mock.calls[0];
    expect(url).toBe('/children/c-1/review/2026-08-28');
    expect(body).toEqual(TIMES_ONLY);
    // Named, because `toEqual` alone would not say WHICH omission matters: each of these, sent, would be
    // re-saved as this person's answer, and `null` would not mean "keep" for them.
    for (const key of ['verdicts', 'reasons', 'note', 'computed_onset_at', 'computed_wake_at', 'dismissed', 'nobody_in_bed']) {
      expect(Object.hasOwn(body, key)).toBe(false);
    }
    // Order: the stored review is read, then written, then the saved row is read again.
    const order = state.calls.map((c) => (c.startsWith('PUT') ? 'put' : /\/review\//.test(c) ? 'review' : /stored=1/.test(c) ? 'stored' : 'night'));
    expect(order).toEqual(['stored', 'review', 'put', 'stored', 'night']);
  });

  test('★ a night corrected by "no one was in the bed" also sends nobody_in_bed false, and still no times', async () => {
    mockLockedApi({ review: { review: { nobody_in_bed: 1, true_onset_at: null, true_wake_at: null, true_in_bed_at: null } } });
    const { user } = await openLocked();
    await user.click(screen.getByRole('button', { name: /^remove my correction$/i }));
    await user.click(screen.getByRole('button', { name: /^remove my correction$/i }));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));

    expect(api.put.mock.calls[0][1]).toEqual({ ...TIMES_ONLY, nobody_in_bed: false });
  });

  // ★ THE FLAG IS READ AT CONFIRMATION, NOT WHEN THE DIALOG OPENED (#679, from the #678 review). A second phone
  // can set or clear "no one was in the bed" while this dialog sits on its confirm step. A body built from a
  // review read at dialog-open would then send the wrong thing: omit the flag the night still has (so it
  // stays locked after a "successful" removal) or send `false` for one that is gone (resetting a dismissal
  // and naming the sender for nothing). The earlier order test supplied ONE unchanging review and asserted
  // only the sequence of requests, so a body built from an earlier read passed it.
  for (const [label, atOpen, atConfirm, sendsFlag] of [
    ['set by a second phone after the dialog opened', 0, 1, true],
    ['cleared by a second phone after the dialog opened', 1, 0, false],
  ]) {
    test(`★ the flag is read when the removal is confirmed: ${label}`, async () => {
      let nobody = atOpen;
      const state = mockLockedApi({ review: () => ({ review: { nobody_in_bed: nobody, true_onset_at: null } }) });
      const { user } = await openLocked();
      await user.click(screen.getByRole('button', { name: /^remove my correction$/i }));
      // On the confirm step now; the stored review changes under the open dialog.
      nobody = atConfirm;
      await user.click(screen.getByRole('button', { name: /^remove my correction$/i }));
      await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));

      const body = api.put.mock.calls[0][1];
      expect(Object.hasOwn(body, 'nobody_in_bed')).toBe(sendsFlag);
      if (sendsFlag) expect(body.nobody_in_bed).toBe(false);
      // And the review was read AFTER the confirm step was reached: the read nearest the write is the one
      // that counts, so it is the last review read before the PUT.
      const putAt = state.calls.findIndex((c) => c.startsWith('PUT'));
      expect(/\/review\//.test(state.calls[putAt - 1])).toBe(true);
    });
  }

  // The confirm button is disabled while the removal runs. Without it a double tap reads the review twice and
  // writes twice, and the second write can carry a flag the first already cleared. The review read is held
  // open by hand so the second tap lands while the first removal is genuinely in flight.
  test('★ a double tap on the confirm button sends one removal', async () => {
    let release;
    const state = mockLockedApi({
      review: () => new Promise((resolve) => { release = () => resolve({ review: { nobody_in_bed: 0 } }); }),
    });
    const { user } = await openLocked();
    await user.click(screen.getByRole('button', { name: /^remove my correction$/i }));
    await user.dblClick(screen.getByRole('button', { name: /^remove my correction$/i }));

    expect(state.calls.filter((c) => /\/review\//.test(c))).toHaveLength(1);
    // The affordance too, not only the count: the button says it is working and cannot be pressed again.
    // (Codex review on #687: a handler-side guard alone passed the count assertion with the button live.)
    expect(screen.getByRole('button', { name: /^removing…$/i })).toBeDisabled();
    release();
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText(/no longer matches/i)).toBeInTheDocument());
    expect(api.put).toHaveBeenCalledTimes(1);
  });

  // `0` is the stored column's own "no"; `-1` is a value the server's saidNobody (exactly 1) does not read
  // as the flag either, so the button must not send an answer for it; null is a review row with no flag.
  for (const [label, review] of [
    ['an absent review', { review: null }],
    ['nobody_in_bed 0', { review: { nobody_in_bed: 0 } }],
    ['nobody_in_bed -1 (not the flag, as the server reads it)', { review: { nobody_in_bed: -1 } }],
  ]) {
    test(`★ a flag that is not set is NOT sent as false: ${label} (sending it would also reset a dismissal and name the sender)`, async () => {
      mockLockedApi({ review });
      const { user } = await openLocked();
      await user.click(screen.getByRole('button', { name: /^remove my correction$/i }));
      await user.click(screen.getByRole('button', { name: /^remove my correction$/i }));
      await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
      expect(Object.hasOwn(api.put.mock.calls[0][1], 'nobody_in_bed')).toBe(false);
    });
  }

  test('★ after success the dialog is UNLOCKED (the ordinary preview) and the page is refreshed with the overlaid night', async () => {
    const state = mockLockedApi();
    const onRecomputed = vi.fn();
    const onCorrectionRemoved = vi.fn();
    const { user } = await openLocked({ onRecomputed, onCorrectionRemoved });
    await user.click(screen.getByRole('button', { name: /^remove my correction$/i }));
    await user.click(screen.getByRole('button', { name: /^remove my correction$/i }));

    await waitFor(() => expect(screen.getByText(/no longer matches/i)).toBeInTheDocument());
    // So the page can drop anything that quotes the removed correction (the "that's recorded" receipt).
    expect(onCorrectionRemoved).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/This night is locked/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /remove my correction/i })).not.toBeInTheDocument();
    // The ordinary recompute is on offer now, and nothing has been recomputed or stored yet.
    expect(screen.getByRole('button', { name: /save the new numbers/i })).toBeInTheDocument();
    expect(state.calls.some((c) => /[?&]store=1/.test(c))).toBe(false);
    // The page is told, with the NORMAL (overlaid) read, not a store response.
    expect(onRecomputed).toHaveBeenCalledWith(OVERLAID_UNCORRECTED);
  });

  test('★ the dialog trusts the server\'s `locked`, not the PUT: still locked after it stays locked', async () => {
    // A second phone corrected the night in between, or the save did not clear everything.
    mockLockedApi({ lockedAfter: true });
    const { user } = await openLocked();
    await user.click(screen.getByRole('button', { name: /^remove my correction$/i }));
    await user.click(screen.getByRole('button', { name: /^remove my correction$/i }));

    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText(/This night is locked because you corrected it/)).toBeInTheDocument());
    expect(screen.queryByText(/no longer matches/i)).not.toBeInTheDocument();
  });

  test('★ a failed removal shows the error, stays locked, and does not touch the page', async () => {
    mockLockedApi({ putError: new Error('Could not save that review') });
    const onRecomputed = vi.fn();
    const onCorrectionRemoved = vi.fn();
    const { user } = await openLocked({ onRecomputed, onCorrectionRemoved });
    await user.click(screen.getByRole('button', { name: /^remove my correction$/i }));
    await user.click(screen.getByRole('button', { name: /^remove my correction$/i }));

    expect(await screen.findByText(/Could not save that review/)).toBeInTheDocument();
    expect(onRecomputed).not.toHaveBeenCalled();
    expect(onCorrectionRemoved).not.toHaveBeenCalled(); // nothing was removed, so the receipt stays true
    // Back where it was: asking again is possible, and it is still the confirm step (nothing was removed).
    expect(screen.getByRole('button', { name: /^remove my correction$/i })).not.toBeDisabled();
    expect(screen.queryByText(/no longer matches/i)).not.toBeInTheDocument();
    expect(api.get.mock.calls.filter(([u]) => /stored=1/.test(u))).toHaveLength(1); // only the opening read
  });

  test('a refresh that fails AFTER the removal says the correction was removed, not that the removal failed', async () => {
    mockLockedApi({ overlaidError: new Error('network down') });
    const { user } = await openLocked();
    await user.click(screen.getByRole('button', { name: /^remove my correction$/i }));
    await user.click(screen.getByRole('button', { name: /^remove my correction$/i }));

    expect(await screen.findByText(/Your correction was removed, but this page could not refresh/)).toBeInTheDocument();
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
    // Both the write AND the re-fetch happened, in that order — storing alone is not enough (R3).
    const urls = api.get.mock.calls.map(([u]) => u);
    expect(urls.some((u) => /[?&]store=1/.test(u))).toBe(true);
    expect(urls.at(-1)).toMatch(/detail=1/);
    expect(urls.at(-1)).not.toMatch(/store=1/);
  });

  // ★ THE REGRESSION TEST FOR R3. `onStore` (what `?store=1` answers) and `overlaid` (what the NORMAL
  // route answers right after) are deliberately DIFFERENT values here — `night__marker` only exists on
  // the overlaid one. Passing the raw store response straight to `onRecomputed`, the pre-fix shape,
  // would report `onStore` and this fails; only re-fetching the normal route reports `overlaid`. A
  // fixture where the two happened to be equal (as in the test above, and in the rest of this file)
  // could not tell the two code paths apart — this is the one test in the file that can.
  test('★ the "after" picture is the OVERLAID night (a fresh normal read), not the raw store response', async () => {
    const onRecomputed = vi.fn();
    const overlaid = { ...FRESH, corrected: true, night__marker: 'overlay' };
    mockApi({ overlaid });
    const { user } = setup(renderAsAdmin, { onRecomputed });
    await user.click(screen.getByRole('button', { name: /recompute this night/i }));
    await waitFor(() => expect(screen.getByText(/no longer matches/i)).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /save the new numbers/i }));
    await waitFor(() => expect(onRecomputed).toHaveBeenCalled());
    expect(onRecomputed).toHaveBeenCalledWith(overlaid);
    expect(onRecomputed).not.toHaveBeenCalledWith(FRESH);
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

// #361 PR 3: "Use the settings this night was saved with".
//
// The claims worth testing, each one a way the feature could quietly do the wrong thing:
//   1. THE DEFAULT IS TODAY'S SETTINGS, unchanged: unticked, the save URL is EXACTLY the one this dialog always
//      sent (no `context` at all), and the box starts unticked every time the dialog opens (owner, #361 Q4).
//   2. TICKED, THE "AFTER" COLUMN IS THE STORED-SETTINGS PREVIEW (`?context=stored&raw=1`), not the page's night:
//      previewing one thing and saving another is the #222 class of bug again. REPLAY differs from FRESH on every
//      row, so a table built from the wrong side is visible.
//   3. The save is bound to the record the dialog was shown (`expect_context`, plan R2), and the page is re-read
//      afterwards in its default view (since #361 PR 4a; PR 3 re-read it with today's settings and showed a line).
//   4. The option is shown only where there is something to choose, disabled WITH A REASON where the night
//      cannot offer it, and never on a locked night.
//   5. On a night today's settings cannot score, the control appears only for that choice (plan R1).
describe('#361 PR 3: "Use the settings this night was saved with"', () => {
  const CTX_SAVED = { v: 1, camera_id: 'cam-a', tz: 'Australia/Melbourne', window: { start: '19:30', end: '07:00' }, algo: '1' };
  const CTX_NOW = { ...CTX_SAVED, camera_id: 'cam-b', window: { start: '20:00', end: '07:00' } };
  const DIFFERS = {
    stored_state: 'ok', stored: CTX_SAVED, current: CTX_NOW, differs: true,
    camera_names: { stored: 'Bed cam', current: 'Door cam' },
  };
  const SAVED_ROW = { ...STORED, status: 'ok', scoring_context: JSON.stringify(CTX_SAVED) };
  // What the stored settings give: different from FRESH (the page's night) AND from the saved row on every row.
  const REPLAY = {
    night_date: '2026-08-28', status: 'ok', onset_at: '2026-08-28 09:40:00', wake_at: '2026-08-28 20:00:00',
    asleep_minutes: 620, awake_minutes: 5, wake_count: 1,
    scoring: { source: 'stored', algo: '1', current_algo: '1', algo_differs: false, problem: null },
  };
  const OVERLAID = { ...FRESH, night__marker: 'normal-read' };
  const BASE = '/children/c-1/sleep/2026-08-28';

  // Routes by query, in an order where no URL can match an earlier branch by accident: `?stored=1` (the dialog's
  // opening read), the preview (`context=stored&raw=1`), a store, then the normal read. `contexts: null` answers
  // with no `contexts` key at all, the shape a server from before #361 PR 3 sends.
  function mockChoiceApi({ contexts = DIFFERS, stored = SAVED_ROW, locked = false, preview = REPLAY, previewError = null, storeError = null } = {}) {
    const calls = [];
    vi.spyOn(api, 'get').mockImplementation((url) => {
      calls.push(url);
      if (url.includes('?stored=1')) return Promise.resolve(contexts === null ? { night: stored, locked } : { night: stored, locked, contexts });
      if (url.includes('context=stored&raw=1')) return previewError ? Promise.reject(previewError) : Promise.resolve(preview);
      if (url.includes('store=1')) return storeError ? Promise.reject(storeError) : Promise.resolve({ ...preview, stored: true });
      if (url.includes('detail=1')) return Promise.resolve(OVERLAID);
      return Promise.reject(new Error(`unexpected call: ${url}`));
    });
    return calls;
  }
  const httpError = (status, data) => Object.assign(new Error(data.error), { status, data });
  const box = () => screen.getByRole('checkbox', { name: /use the settings this night was saved with/i });
  async function openDialog(props = {}) {
    const rendered = setup(renderAsAdmin, props);
    await rendered.user.click(screen.getByRole('button', { name: /recompute this night/i }));
    await screen.findByRole('dialog');
    return rendered;
  }

  test('★ the box starts unticked, names both settings, says today\'s rules are used, and the table is the page\'s night', async () => {
    mockChoiceApi();
    await openDialog();
    expect(box()).not.toBeChecked();
    expect(box()).toBeEnabled();
    const line = screen.getByText(/^Saved with:/);
    expect(line.textContent).toBe('Saved with: Bed cam, 19:30–07:00, Australia/Melbourne. Now: Door cam, 20:00–07:00, Australia/Melbourne.');
    // Only what changed is emphasised: the camera and the window, not the unchanged timezone.
    expect([...line.querySelectorAll('strong')].map((n) => n.textContent)).toEqual(['Bed cam', '19:30–07:00', 'Door cam', '20:00–07:00']);
    expect(screen.getByText('Uses today’s detection rules either way.')).toBeInTheDocument();
    // Unticked: today's comparison, exactly as before (FRESH's 10:15 on the right, nothing from REPLAY).
    expect(screen.getByText('10:15')).toBeInTheDocument();
    expect(screen.queryByText('09:40')).not.toBeInTheDocument();
  });

  test('★ ticking fetches the RAW stored-settings preview and the table compares the saved row with IT', async () => {
    const calls = mockChoiceApi();
    const { user } = await openDialog();
    await user.click(box());
    await waitFor(() => expect(screen.getByText('09:40')).toBeInTheDocument());
    expect(calls).toContain(`${BASE}?context=stored&raw=1`);
    // The saved row on the left, the replay on the right; the page's night (10:15) is gone from the table.
    expect(screen.getByText('06:56')).toBeInTheDocument();
    expect(screen.getByText('10h 20m')).toBeInTheDocument();
    expect(screen.queryByText('10:15')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save the new numbers/i })).toBeInTheDocument();
    // Unticking goes back to today's comparison.
    await user.click(box());
    expect(box()).not.toBeChecked();
    expect(screen.getByText('10:15')).toBeInTheDocument();
    expect(screen.queryByText('09:40')).not.toBeInTheDocument();
  });

  test('★ unticked, Save sends EXACTLY today\'s URL: no context, no expect_context', async () => {
    const calls = mockChoiceApi();
    const onRecomputed = vi.fn();
    const { user } = await openDialog({ onRecomputed });
    await user.click(screen.getByRole('button', { name: /save the new numbers/i }));
    await waitFor(() => expect(onRecomputed).toHaveBeenCalledWith(OVERLAID));
    expect(calls.filter((u) => /[?&]store=1/.test(u))).toEqual([`${BASE}?store=1&detail=1`]);
    // The only `context` anywhere is the page's re-read in its default view (#361 PR 4a), never on the store.
    expect(calls.filter((u) => u.includes('context='))).toEqual([`${BASE}?detail=1&context=auto`]);
  });

  // #361 PR 4a (plan R4) replaced PR 3's ending here. PR 3 re-read the page with TODAY's settings and showed a line
  // saying the page "still works the night out with today's settings"; the page now shows a finished night with the
  // settings it was saved with by default, so the re-read is the page's DEFAULT view and the page is told to go back
  // to it, and the line is gone (it would now be false).
  test('★ ticked, Save sends context=stored with the record it was shown, then re-reads the page in its DEFAULT view and resets it', async () => {
    const calls = mockChoiceApi();
    const onRecomputed = vi.fn();
    const onSettingsViewChange = vi.fn();
    const { user } = setup(renderAsAdmin, { onRecomputed, onSettingsViewChange, settingsView: 'current' });
    await user.click(screen.getByRole('button', { name: /recompute this night/i }));
    await screen.findByRole('dialog');
    await user.click(box());
    await screen.findByText('09:40');
    await user.click(screen.getByRole('button', { name: /save the new numbers/i }));
    await waitFor(() => expect(onRecomputed).toHaveBeenCalledTimes(1));

    expect(calls.filter((u) => /[?&]store=1/.test(u))).toEqual([
      `${BASE}?store=1&detail=1&context=stored&expect_context=${encodeURIComponent(SAVED_ROW.scoring_context)}`,
    ]);
    // Re-read in the DEFAULT view even though the page was showing today's settings, and the page is told so.
    expect(calls.at(-1)).toBe(`${BASE}?detail=1&context=auto`);
    expect(onSettingsViewChange).toHaveBeenCalledWith('auto');
    expect(onRecomputed).toHaveBeenCalledWith(OVERLAID);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByText(/Saved using the settings this night was recorded with/)).not.toBeInTheDocument();
    expect(screen.queryByText(/this page still works the night out with today’s settings/)).not.toBeInTheDocument();
  });

  test('★ the dialog opens unticked every time, even after it was ticked', async () => {
    mockChoiceApi();
    const { user } = await openDialog();
    await user.click(box());
    await screen.findByText('09:40');
    await user.click(screen.getByRole('button', { name: /^cancel$/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /recompute this night/i }));
    await screen.findByRole('dialog');
    expect(box()).not.toBeChecked();
    expect(screen.getByText('10:15')).toBeInTheDocument();
  });

  test('identical settings: no option at all (nothing to choose)', async () => {
    mockChoiceApi({ contexts: { ...DIFFERS, current: CTX_SAVED, differs: false, camera_names: { stored: 'Bed cam', current: 'Bed cam' } } });
    await openDialog();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByText(/^Saved with:/)).not.toBeInTheDocument();
  });

  for (const [state, reason] of [
    ['none', 'This night was saved before the app recorded its settings.'],
    ['unreadable', 'The settings saved with this night can’t be read.'],
  ]) {
    test(`a ${state === 'none' ? 'legacy (no record)' : 'unreadable'} night shows the option DISABLED with the reason`, async () => {
      mockChoiceApi({ contexts: { stored_state: state, stored: null, current: CTX_NOW, differs: false, camera_names: { stored: null, current: 'Door cam' } } });
      await openDialog();
      expect(box()).toBeDisabled();
      expect(screen.getByText(reason)).toBeInTheDocument();
      // The ordinary comparison is still offered beside it.
      expect(screen.getByRole('button', { name: /save the new numbers/i })).toBeInTheDocument();
    });
  }

  test('no option when nothing is saved, or the night is locked, or the server sends no `contexts` (an older backend)', async () => {
    mockChoiceApi({ stored: null, contexts: { ...DIFFERS, stored_state: 'none', stored: null, differs: false } });
    let rendered = await openDialog();
    expect(screen.getByText(/nothing is saved for this night yet/i)).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    rendered.unmount();
    vi.restoreAllMocks();

    mockChoiceApi({ locked: true });
    rendered = await openDialog({ night: { ...FRESH, corrected: true } });
    expect(screen.getByText(/This night is locked because you corrected it/)).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    rendered.unmount();
    vi.restoreAllMocks();

    mockChoiceApi({ contexts: null });
    await openDialog();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save the new numbers/i })).toBeInTheDocument();
  });

  test('★ a preview whose camera no longer exists says so and offers no table and no Save', async () => {
    mockChoiceApi({ preview: { ...REPLAY, status: 'no_data', onset_at: null, wake_at: null, scoring: { ...REPLAY.scoring, problem: 'camera_deleted' } } });
    const { user } = await openDialog();
    await user.click(box());
    expect(await screen.findByText(/The camera this night was saved from no longer exists/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument();
    expect(document.querySelector('.recompute-diff')).toBeNull();
    expect(screen.queryByRole('button', { name: /^cancel$/i })).not.toBeInTheDocument(); // nothing to cancel
    expect(screen.getAllByRole('button', { name: /^close$/i }).length).toBeGreaterThan(0);
  });

  test('a 400 no_stored_context on the preview shows the server\'s message and goes back to today\'s settings', async () => {
    const message = "This night has no saved settings that can be used (it was saved before the app recorded them, or what was saved can't be read). Recompute it with the current settings instead.";
    mockChoiceApi({ previewError: httpError(400, { error: message, reason: 'no_stored_context' }) });
    const { user } = await openDialog();
    await user.click(box());
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(box()).not.toBeChecked();
    expect(screen.getByText('10:15')).toBeInTheDocument();
  });

  test('a 409 context_changed on Save shows the server\'s message and saves nothing else', async () => {
    const message = 'This night was saved again while you were looking at it. Close this and open Recompute again.';
    const calls = mockChoiceApi({ storeError: httpError(409, { error: message, reason: 'context_changed' }) });
    const onRecomputed = vi.fn();
    const { user } = await openDialog({ onRecomputed });
    await user.click(box());
    await screen.findByText('09:40');
    await user.click(screen.getByRole('button', { name: /save the new numbers/i }));
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(onRecomputed).not.toHaveBeenCalled();
    expect(calls.filter((u) => /[?&]store=1/.test(u))).toHaveLength(1);
    expect(screen.queryByText(/Saved using the settings/)).not.toBeInTheDocument();
  });

  // Plan R1: a night today's settings cannot score.
  describe('on a no_data / no_sleep night', () => {
    const NO_DATA = { night_date: '2026-08-28', status: 'no_data', in_progress: false, onset_at: null, wake_at: null, coverage_minutes: 0 };

    test('★ the control appears only after its own read finds usable, DIFFERING saved settings; the dialog offers only that path', async () => {
      const calls = mockChoiceApi();
      const { user } = setup(renderAsAdmin, { night: NO_DATA });
      await user.click(await screen.findByRole('button', { name: /recompute this night/i }));
      await screen.findByRole('dialog');
      expect(calls[0]).toBe(`${BASE}?stored=1`); // the mount-time read
      expect(screen.getByText(/Today’s settings find no data for this night\. The settings it was saved with may still work\./)).toBeInTheDocument();
      expect(box()).not.toBeChecked();
      // Unticked: no comparison with "no data" and nothing to save with today's settings.
      expect(document.querySelector('.recompute-diff')).toBeNull();
      expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument();
      // Ticked: the stored-settings preview and its save.
      await user.click(box());
      expect(await screen.findByText('09:40')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: /save the new numbers/i }));
      await waitFor(() => expect(calls.some((u) => u.startsWith(`${BASE}?store=1&detail=1&context=stored&expect_context=`))).toBe(true));
      expect(calls.filter((u) => /[?&]store=1/.test(u)).every((u) => u.includes('context=stored'))).toBe(true);
    });

    test('a saved row that vanished after the offer: no Save with today\'s settings (it would store "no data")', async () => {
      // The control was offered from one read, then the dialog's own read finds nothing saved (another phone).
      let reads = 0;
      vi.spyOn(api, 'get').mockImplementation((url) => {
        if (url.includes('?stored=1')) {
          reads += 1;
          return Promise.resolve(reads === 1 ? { night: SAVED_ROW, locked: false, contexts: DIFFERS } : { night: null, locked: false, contexts: { ...DIFFERS, stored_state: 'none', stored: null, differs: false } });
        }
        return Promise.reject(new Error(`unexpected call: ${url}`));
      });
      const { user } = setup(renderAsAdmin, { night: NO_DATA });
      await user.click(await screen.findByRole('button', { name: /recompute this night/i }));
      expect(await screen.findByText(/Nothing is saved for this night any more/)).toBeInTheDocument();
      expect(screen.queryByText(/Saving now records the night/)).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument();
    });

    test('a no_sleep night says "no clear sleep", not "no data"', async () => {
      mockChoiceApi();
      const { user } = setup(renderAsAdmin, { night: { ...NO_DATA, status: 'no_sleep', coverage_minutes: 700 } });
      await user.click(await screen.findByRole('button', { name: /recompute this night/i }));
      expect(await screen.findByText(/Today’s settings find no clear sleep in this night\./)).toBeInTheDocument();
    });

    for (const [label, opts] of [
      ['identical saved settings', { contexts: { ...DIFFERS, current: CTX_SAVED, differs: false } }],
      ['a legacy night (no record)', { contexts: { ...DIFFERS, stored_state: 'none', stored: null, differs: false } }],
      ['an unreadable record', { contexts: { ...DIFFERS, stored_state: 'unreadable', stored: null, differs: false } }],
      ['a locked night', { locked: true }],
      ['an older server (no contexts)', { contexts: null }],
    ]) {
      test(`nothing is shown for ${label}`, async () => {
        const calls = mockChoiceApi(opts);
        setup(renderAsAdmin, { night: NO_DATA });
        await waitFor(() => expect(calls).toEqual([`${BASE}?stored=1`]));
        // Let the answer land; the control must still not appear.
        await act(async () => {});
        expect(screen.queryByRole('button', { name: /recompute this night/i })).not.toBeInTheDocument();
      });
    }

    test('a caregiver gets nothing, and no request is made for them', async () => {
      const calls = mockChoiceApi();
      setup(renderAsCaregiver, { night: NO_DATA });
      await act(async () => {});
      expect(screen.queryByRole('button', { name: /recompute this night/i })).not.toBeInTheDocument();
      expect(calls).toEqual([]);
    });
  });
});

// #361 PR 4a (plan R4): the page can now show a finished night WITH the settings it was saved with (the server says
// so in `night.scoring_view`). The unticked "after" column must still be TODAY's settings, so on such a page the
// dialog reads its own today's preview (`?context=current&raw=1`) and judges everything about "today's settings" on
// it: the comparison, and whether today's settings can score the night at all. Each fixture makes the page's night
// and today's preview DIFFERENT in the way that matters, so a dialog that used the page's night shows something else.
describe('#361 PR 4a: on a page showing the saved settings, the dialog compares against TODAY\'s', () => {
  const CTX_SAVED = { v: 1, camera_id: 'cam-a', tz: 'Australia/Melbourne', window: { start: '19:30', end: '07:00' }, algo: '1' };
  const CTX_NOW = { ...CTX_SAVED, camera_id: 'cam-b' };
  const NAMES = { stored: 'Bed cam', current: 'Door cam' };
  const VIEW = { applied: 'stored', stored: CTX_SAVED, current: CTX_NOW, camera_names: NAMES, algo_differs: false };
  const DIFFERS = { stored_state: 'ok', stored: CTX_SAVED, current: CTX_NOW, differs: true, camera_names: NAMES };
  const SAVED_ROW = { ...STORED, status: 'ok', scoring_context: JSON.stringify(CTX_SAVED) };
  // The page: the saved settings worked out again, so the same numbers as the saved row (what the card shows).
  const PAGE = { ...STORED, status: 'ok', in_progress: false, scoring_view: VIEW };
  // Today's settings: other numbers on every row.
  const TODAY = { night_date: '2026-08-28', status: 'ok', onset_at: '2026-08-28 11:05:00', wake_at: '2026-08-28 19:00:00',
    asleep_minutes: 480, awake_minutes: 10, wake_count: 2 };
  const TODAY_NO_DATA = { night_date: '2026-08-28', status: 'no_data', onset_at: null, wake_at: null, coverage_minutes: 0 };
  const BASE = '/children/c-1/sleep/2026-08-28';
  const TODAY_URL = `${BASE}?context=current&raw=1`;

  function mockToday({ today = TODAY, locked = false } = {}) {
    const calls = [];
    vi.spyOn(api, 'get').mockImplementation((url) => {
      calls.push(url);
      if (url.includes('?stored=1')) return Promise.resolve({ night: SAVED_ROW, locked, contexts: DIFFERS });
      if (url === TODAY_URL) return Promise.resolve(today);
      if (url.includes('context=stored&raw=1')) return Promise.resolve({ ...SAVED_ROW, scoring: { source: 'stored', problem: null } });
      if (url.includes('store=1')) return Promise.resolve({ ...today, stored: true });
      if (url.includes('detail=1')) return Promise.resolve({ ...PAGE, night__marker: 're-read' });
      return Promise.reject(new Error(`unexpected call: ${url}`));
    });
    return calls;
  }
  async function open(props) {
    const rendered = setup(renderAsAdmin, props);
    await rendered.user.click(await screen.findByRole('button', { name: /recompute this night/i }));
    await screen.findByRole('dialog');
    return rendered;
  }

  test('★ opening reads today\'s preview, and the unticked table is the saved row against IT, not against the page', async () => {
    const calls = mockToday();
    await open({ night: PAGE });
    expect(calls).toEqual([`${BASE}?stored=1`, TODAY_URL]);
    // The page's night IS the saved row's numbers, so a dialog comparing against it would say "already matches".
    expect(await screen.findByText(/no longer matches/i)).toBeInTheDocument();
    expect(screen.getByText('06:56')).toBeInTheDocument(); // saved
    expect(screen.getByText('11:05')).toBeInTheDocument(); // today's settings
    expect(screen.getByRole('button', { name: /save the new numbers/i })).toBeInTheDocument();
  });

  test('a page showing today\'s settings (no scoring_view) makes no extra read: its own night is today\'s', async () => {
    const calls = mockToday();
    await open({ night: FRESH });
    expect(calls).toEqual([`${BASE}?stored=1`]);
  });

  test('a locked night reads no today\'s preview (there is nothing to compare)', async () => {
    const calls = mockToday({ locked: true });
    await open({ night: { ...PAGE, corrected: true } });
    expect(await screen.findByText(/This night is locked because you corrected it/)).toBeInTheDocument();
    expect(calls).toEqual([`${BASE}?stored=1`]);
  });

  test('★ the saved settings score the night but today\'s do not: the dialog says so and offers no today\'s-settings Save', async () => {
    // The page shows `ok` (the saved settings). Judged on the page, the dialog would offer a Save with today's settings
    // that the server is certain to refuse, with the false "aged out" wording.
    mockToday({ today: TODAY_NO_DATA });
    const { user } = await open({ night: PAGE });
    expect(await screen.findByText(/Today’s settings find no data for this night\. The settings it was saved with may still work\./)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument();
    expect(document.querySelector('.recompute-diff')).toBeNull();
    // The stored-settings path is still there.
    await user.click(screen.getByRole('checkbox', { name: /use the settings this night was saved with/i }));
    expect(await screen.findByText(/already matches/i)).toBeInTheDocument();
  });

  test('today’s no_sleep preview chooses the no-clear-sleep wording even when the page night scores', async () => {
    mockToday({ today: { ...TODAY_NO_DATA, status: 'no_sleep' } });
    await open({ night: PAGE });
    expect(await screen.findByText(/Today’s settings find no clear sleep in this night\./)).toBeInTheDocument();
    expect(screen.queryByText(/Today’s settings find no data for this night\./)).not.toBeInTheDocument();
  });

  test('★ the saved settings find no data but today\'s do: the dialog compares today\'s, and never says they find no data', async () => {
    // The page shows `no_data` (a saved camera since deleted, or one with nothing recorded). The control appears from
    // its own `?stored=1` (PR 3, plan R1); once open, today's settings are the ones that score.
    const calls = mockToday();
    const { user } = setup(renderAsAdmin, { night: { ...PAGE, status: 'no_data', onset_at: null, wake_at: null } });
    await user.click(await screen.findByRole('button', { name: /recompute this night/i }));
    expect(await screen.findByText(/no longer matches/i)).toBeInTheDocument();
    expect(calls).toContain(TODAY_URL);
    expect(screen.queryByText(/Today’s settings find no/)).not.toBeInTheDocument();
    expect(screen.getByText('11:05')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save the new numbers/i })).toBeInTheDocument();
  });

  test('★ "Remove my correction" reads today\'s preview once unlocked, and re-reads the page in the view it is IN', async () => {
    const state = { locked: true };
    const calls = [];
    vi.spyOn(api, 'get').mockImplementation((url) => {
      calls.push(url);
      if (url.includes('?stored=1')) return Promise.resolve({ night: SAVED_ROW, locked: state.locked, contexts: DIFFERS });
      if (url.includes('/review/')) return Promise.resolve({ review: { nobody_in_bed: 0, true_onset_at: '2026-08-28 10:30:00' } });
      if (url === TODAY_URL) return Promise.resolve(TODAY);
      if (url.includes('detail=1')) return Promise.resolve({ ...PAGE, night__marker: 're-read' });
      return Promise.reject(new Error(`unexpected call: ${url}`));
    });
    vi.spyOn(api, 'put').mockImplementation(() => { state.locked = false; return Promise.resolve({ review: {} }); });
    const onRecomputed = vi.fn();
    const onSettingsViewChange = vi.fn();
    const { user } = setup(renderAsAdmin, {
      night: { ...PAGE, corrected: true, scoring_view: { ...VIEW, applied: 'current' } },
      settingsView: 'current', onRecomputed, onSettingsViewChange,
    });
    await user.click(screen.getByRole('button', { name: /recompute this night/i }));
    await user.click(await screen.findByRole('button', { name: /^remove my correction$/i }));
    await user.click(screen.getByRole('button', { name: /^remove my correction$/i }));
    await waitFor(() => expect(onRecomputed).toHaveBeenCalledTimes(1));
    // Unlocked: today's preview is read for the comparison, and the page is re-read in ITS view, not reset.
    expect(calls.slice(-3)).toEqual([`${BASE}?stored=1`, TODAY_URL, `${BASE}?detail=1&context=current`]);
    expect(onSettingsViewChange).not.toHaveBeenCalled();
    expect(await screen.findByText('11:05')).toBeInTheDocument();
  });
});
