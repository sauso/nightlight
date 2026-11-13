// "That's right" on the child page's night card (components/MorningReviewCard.jsx): a ONE-TAP save of the app's wake time,
// made from the card instead of from the review screen.
//
// Why this needs its own tests: it writes a parent's answer (the ground truth every later sleep change is scored against) from a
// place that has not shown them the screen's own safeguards. The review screen refuses to offer "That's right" on a night with
// an "Up between A and B" range, on a night already answered, and on a night with no wake; the card must hand those to the
// screen instead of saving, and when it does save it must send EXACTLY what the screen sends (lib/reviewConfirm.js). Each claim
// below names what fails without it.
import { describe, test, expect, vi, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { Routes, Route, useParams } from 'react-router-dom';
import { renderAsAdmin } from './helpers/render.jsx';
import MorningReviewCard from '../src/components/MorningReviewCard.jsx';
import { api } from '../src/lib/api.js';
import { confirmWakeBody } from '../src/lib/reviewConfirm.js';

afterEach(() => vi.restoreAllMocks());

const TZ = 'Australia/Melbourne';
// 20:47Z is 06:47 the next morning in Melbourne (UTC+10 on 1 September); 09:10Z is 19:10.
const WAKE = '2026-09-01 20:47:00';
const ONSET = '2026-09-01 09:10:00';
const PENDING = { state: 'ask', night_date: '2026-09-01', onset_at: ONSET, wake_at: WAKE, transition_count: 3 };
const DONE = { state: 'done', night_date: '2026-09-01', true_onset_at: null, true_wake_at: WAKE, true_in_bed_at: null, nobody_in_bed: false };
const REVIEW = {
  child_id: 'c-1',
  night_date: '2026-09-01',
  settings: { key: 'ctx-1', tz: TZ },
  computed: { status: 'ok', onset_at: ONSET, wake_at: WAKE },
  review: null,
  wake_range: null,
};

// 'HH:MM' in the app's zone, the way the card words it.
const fmtTime = (utc) => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  .format(new Date(`${utc.replace(' ', 'T')}Z`));

function ReviewScreenProbe() { const { id, date } = useParams(); return <div>review screen for {id} on {date}</div>; }
const routes = (
  <Routes>
    <Route path="/" element={<MorningReviewCard childId="c-1" fmtTime={fmtTime} />} />
    <Route path="/children/:id/review/:date" element={<ReviewScreenProbe />} />
  </Routes>
);

// Path-aware api: `pending` answers /review/pending (a function is called per request, so the second read can differ), `review`
// answers GET /review/:date.
function mockApi({ pending = [PENDING], review = REVIEW, put = () => Promise.resolve({}) } = {}) {
  const queue = [...pending];
  vi.spyOn(api, 'get').mockImplementation((path) => {
    if (String(path).endsWith('/review/pending')) {
      const next = queue.length > 1 ? queue.shift() : queue[0];
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    }
    return Promise.resolve(review);
  });
  vi.spyOn(api, 'put').mockImplementation(put);
}
const thatsRight = () => screen.findByRole('button', { name: 'That’s right' });
const putCalls = () => api.put.mock.calls;

describe('"That\'s right" on the night card', () => {
  test('★ one tap saves the screen\'s own confirm body, and the card becomes the receipt', async () => {
    mockApi({ pending: [PENDING, DONE] });
    const { user } = renderAsAdmin(routes, { settings: { timezone: TZ } });
    expect(await screen.findByText('Up at 06:47. Is that right?')).toBeInTheDocument();
    await user.click(await thatsRight());

    await waitFor(() => expect(putCalls()).toHaveLength(1));
    const [url, body] = putCalls()[0];
    expect(url).toBe('/children/c-1/review/2026-09-01');
    // The wall clock in the app's zone (the browser does not convert), what was shown, and the settings key: nothing else.
    expect(body).toEqual({ true_wake_local: '06:47', computed_onset_at: ONSET, computed_wake_at: WAKE, settings_key: 'ctx-1' });
    expect(Object.keys(body).sort()).toEqual(['computed_onset_at', 'computed_wake_at', 'settings_key', 'true_wake_local']);
    // The question is replaced by the receipt (not by nothing), read back from the server's own view of the answer.
    expect(await screen.findByText('Thanks — that’s recorded')).toBeInTheDocument();
    expect(screen.getByText('You said up at 06:47. Tap to change it.')).toBeInTheDocument();
    expect(screen.queryByText(/Is that right\?/)).not.toBeInTheDocument();
  });

  test('a save where only the second read of the pending state fails still ends in a receipt, never in nothing', async () => {
    // A prompt that vanishes looks exactly like a failed save, which is what the owner reported when this first shipped.
    mockApi({ pending: [PENDING, new Error('offline')] });
    const { user } = renderAsAdmin(routes, { settings: { timezone: TZ } });
    await user.click(await thatsRight());
    expect(await screen.findByText('You said up at 06:47. Tap to change it.')).toBeInTheDocument();
    expect(putCalls()).toHaveLength(1);
  });

  test('the same tap twice is one save (the button is disabled while it runs)', async () => {
    let release;
    mockApi({ put: () => new Promise((resolve) => { release = resolve; }) });
    const { user } = renderAsAdmin(routes, { settings: { timezone: TZ } });
    const button = await thatsRight();
    await user.click(button);
    await waitFor(() => expect(putCalls()).toHaveLength(1));
    expect(button).toBeDisabled();
    await user.click(button);
    release({});
    await waitFor(() => expect(button).not.toBeDisabled());
    expect(putCalls()).toHaveLength(1);
  });

  test('a refused save says why, stays a question, and can be tried again', async () => {
    mockApi({ put: () => Promise.reject(new Error('The settings for this night changed while you were reviewing.')) });
    const { user } = renderAsAdmin(routes, { settings: { timezone: TZ } });
    await user.click(await thatsRight());
    expect(await screen.findByRole('alert')).toHaveTextContent('The settings for this night changed while you were reviewing.');
    expect(screen.getByText('Up at 06:47. Is that right?')).toBeInTheDocument();
    expect(screen.queryByText(/that’s recorded/)).not.toBeInTheDocument();
    expect(await thatsRight()).not.toBeDisabled();
  });

  // The nights the review screen would NOT confirm from. Each one must reach the screen and must not write anything. A mutation
  // that drops the corresponding guard in confirmWakeBody saves a time nobody checked, and fails its row here.
  test.each([
    ['two wake estimates 10+ minutes apart (the screen asks "Up between A and B")', { wake_range: { from: '2026-09-01 20:30:00', to: '2026-09-01 20:47:00' } }],
    ['the night already carries an answer (another phone got there first)', { review: { true_wake_at: '2026-09-01 20:30:00' } }],
    ['the screen has no wake to confirm', { computed: { status: 'no_data', onset_at: null, wake_at: null } }],
    ['the screen\'s wake is not the one the card showed (the card reads the stored night, the screen recomputes)', { computed: { status: 'ok', onset_at: ONSET, wake_at: '2026-09-01 20:52:00' } }],
  ])('★ %s: opens the review screen and writes nothing', async (_why, over) => {
    mockApi({ review: { ...REVIEW, ...over } });
    const { user } = renderAsAdmin(routes, { settings: { timezone: TZ } });
    await user.click(await thatsRight());
    expect(await screen.findByText('review screen for c-1 on 2026-09-01')).toBeInTheDocument();
    expect(putCalls()).toHaveLength(0);
  });

  test('"Not quite" opens the review screen without reading or writing anything', async () => {
    mockApi();
    const { user } = renderAsAdmin(routes, { settings: { timezone: TZ } });
    await user.click(await screen.findByRole('button', { name: 'Not quite' }));
    expect(await screen.findByText('review screen for c-1 on 2026-09-01')).toBeInTheDocument();
    expect(putCalls()).toHaveLength(0);
    expect(api.get.mock.calls.map(([p]) => p)).toEqual(['/children/c-1/review/pending']);
  });

  test('a night the app found no wake for offers one button into the screen, not a time to confirm', async () => {
    mockApi({ pending: [{ ...PENDING, wake_at: null }] });
    const { user } = renderAsAdmin(routes, { settings: { timezone: TZ } });
    expect(await screen.findByText(/Tap to check the times/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'That’s right' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Check the times' }));
    expect(await screen.findByText('review screen for c-1 on 2026-09-01')).toBeInTheDocument();
  });

  // ⚠️ #512: until /settings has arrived the zone is the placeholder 'UTC', and a time read in it and saved is a wrong time stored
  // as the parent's own answer. Neither the question nor a button that sends a time may be there yet.
  test('★ nothing that sends a time works before the real timezone has arrived', async () => {
    mockApi();
    const { rerenderWith } = renderAsAdmin(routes, { settings: { timezone: 'UTC' }, settingsLoaded: false });
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    const yes = await thatsRight();
    expect(yes).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Not quite' })).toBeDisabled();
    expect(screen.queryByText(/Is that right\?/)).not.toBeInTheDocument();
    expect(putCalls()).toHaveLength(0);
    rerenderWith({ settings: { timezone: TZ }, settingsLoaded: true });
    expect(await screen.findByText('Up at 06:47. Is that right?')).toBeInTheDocument();
    expect(await thatsRight()).not.toBeDisabled();
  });
});

// The body builder on its own: the cases above go through the card; these pin the helper's contract so a second caller cannot drift.
describe('confirmWakeBody', () => {
  test('returns the screen\'s body for a plain night, and omits the settings key when the server sent none', () => {
    expect(confirmWakeBody(REVIEW, TZ, WAKE)).toEqual({ true_wake_local: '06:47', computed_onset_at: ONSET, computed_wake_at: WAKE, settings_key: 'ctx-1' });
    expect(confirmWakeBody({ ...REVIEW, settings: undefined }, TZ, WAKE).settings_key).toBeUndefined();
  });

  test('the wake is the wall clock in the GIVEN zone, so the same night reads differently under another one', () => {
    expect(confirmWakeBody(REVIEW, 'UTC', WAKE).true_wake_local).toBe('20:47');
    expect(confirmWakeBody(REVIEW, TZ, WAKE).true_wake_local).toBe('06:47');
  });

  test('a missing onset is sent as null (recorded as "no opinion"), never left out', () => {
    expect(confirmWakeBody({ ...REVIEW, computed: { status: 'ok', wake_at: WAKE } }, TZ, WAKE).computed_onset_at).toBeNull();
  });

  test('returns null for nothing at all, a whole range, or no shown wake, without throwing; one end alone is not a range', () => {
    expect(confirmWakeBody(null, TZ, WAKE)).toBeNull();
    expect(confirmWakeBody({}, TZ, WAKE)).toBeNull();
    expect(confirmWakeBody({ ...REVIEW, wake_range: { from: WAKE, to: WAKE } }, TZ, WAKE)).toBeNull();
    expect(confirmWakeBody(REVIEW, TZ, null)).toBeNull();
    // The screen asks the range question only with BOTH ends, so one end alone is still a plain confirm.
    expect(confirmWakeBody({ ...REVIEW, wake_range: { from: WAKE } }, TZ, WAKE)).not.toBeNull();
  });
});
