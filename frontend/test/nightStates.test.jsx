// The "no score yet" states and the review screen's two quieter rows (UI refresh PR H, 2026-11-13).
//
// WHAT IS PINNED, each where two plausible implementations part ways:
//   tonight in progress ... BOTH cards (the child page's and the sleep page's) draw a dashed ring (never a number) and say WHEN the
//                           score and summary arrive, in the app's configured timezone and not the browser's or UTC;
//   no whole-night words .. the child card's headline of a night still going is replaced by that line, not shown beside it;
//   switch off stays quiet  a child whose "Show sleep score" is off has no `score` key; promising a score that will never be
//                           shown would be false, so neither card says it (they behave as before);
//   no data ............... the sleep page's empty night draws the dashed ring and keeps its words;
//   review rows ........... "Change bedtime or fell-asleep time" and "No one was in the bed" are one card of rows, each a button;
//                           the disclosure still opens and closes (aria-expanded).
//
// NOT tested here, and said plainly: the headline WRAPPING at 320px instead of ending in an ellipsis. jsdom does no layout and
// the repo's rule is not to pin CSS text (CLAUDE.md, proportionate testing 7); it was checked in screenshots at 320px
// (before and after, in the PR). Fixture names and ids are made up: the repo is public.
import { describe, test, expect, vi, afterEach, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { Routes, Route } from 'react-router-dom';
import { renderAsAdmin } from './helpers/render.jsx';
import SleepSummaryCard from '../src/components/SleepSummaryCard.jsx';
import SleepScoreCard from '../src/components/SleepScoreCard.jsx';
import SleepDetail from '../src/pages/SleepDetail.jsx';
import NightReview from '../src/pages/NightReview.jsx';
import ChildDetail from '../src/pages/ChildDetail.jsx';
import ChildCameraTile from '../src/components/ChildCameraTile.jsx';
import SensorHistoryCard from '../src/components/SensorHistoryCard.jsx';
import { pendingNightText } from '../src/lib/sleepScoreText.js';
import { api } from '../src/lib/api.js';

afterEach(() => vi.restoreAllMocks());

// Melbourne is UTC+10 on 2 Sept (before daylight saving starts in October): 07:00 UTC is 5:00 PM there, so a card that formatted
// in UTC (7:00 AM) or in the browser's zone (pinned to something else in vite.config.js) fails by name.
const TZ = 'Australia/Melbourne';
const WINDOW_END = '2026-09-02 07:00:00';
const AFTER_5PM = /Score and night summary after 5:00\s*PM/i;
const IN_PROGRESS = { score: null, reason: 'in_progress', version: 2 };
const SO_FAR = {
  headline: { key: 'neutral_so_far' },
  observations: [
    { key: 'total_sleep_so_far', params: { minutes: 275 } },
    { key: 'longest_stretch_so_far', params: { minutes: 275 } },
  ],
  seed: 'child-a|2026-09-01',
};
const TONIGHT = { status: 'ok', night_date: '2026-09-01', in_progress: true, asleep_minutes: 275, window_end: WINDOW_END, score: IN_PROGRESS, summary: SO_FAR };

describe('pendingNightText', () => {
  test('says when the score arrives, in the configured zone', () => {
    expect(pendingNightText(TONIGHT, TZ)).toMatch(AFTER_5PM);
    expect(pendingNightText(TONIGHT, 'UTC')).toMatch(/after 7:00\s*AM/i);
  });

  test.each([
    ['a finished night', { ...TONIGHT, in_progress: false }],
    ['a night with the score switch off (no score key)', { ...TONIGHT, score: undefined }],
    ['a score of null (scoring failed)', { ...TONIGHT, score: null }],
    ['no window end', { ...TONIGHT, window_end: null }],
    ['a window end that is not a date', { ...TONIGHT, window_end: 'soon' }],
    ['no night at all', null],
  ])('says nothing for %s', (_name, night) => {
    expect(pendingNightText(night, TZ)).toBeNull();
  });
});

describe('the child page card, tonight in progress', () => {
  const show = (night) => {
    vi.spyOn(api, 'get').mockResolvedValue({ scope: 'tonight', night });
    return renderAsAdmin(<SleepSummaryCard childId="kid-1" />, { settings: { timezone: TZ } });
  };

  test('★ draws a dashed ring and says when the score arrives, instead of a headline', async () => {
    const { container } = show(TONIGHT);
    expect(await screen.findByText(AFTER_5PM)).toBeInTheDocument();
    expect(container.querySelector('.score-ring--pending')).not.toBeNull();
    // No number in the ring and no whole-night sentence: "Sleep so far tonight, as measured." was the headline before.
    expect(container.querySelector('.score-ring__num')).toBeNull();
    expect(container.querySelector('.night__headline')).toBeNull();
    expect(container.textContent).not.toMatch(/as measured|the night goes on|The night so far/);
    // The ring is decorative, so the button's name has to carry the line for a screen reader.
    expect(screen.getByRole('button').getAttribute('aria-label')).toMatch(AFTER_5PM);
  });

  test('★ a child whose score switch is off (no score key) keeps the headline and gets no promise of a score', async () => {
    const { container } = show({ ...TONIGHT, score: undefined });
    await screen.findByText('Tonight · so far');
    expect(container.querySelector('.score-ring--pending')).toBeNull();
    expect(container.textContent).not.toMatch(/Score and night summary/);
    expect(container.querySelector('.night__headline')).not.toBeNull();
  });

  test('a night with no window end falls back to what the card said before', async () => {
    const { container } = show({ ...TONIGHT, window_end: undefined });
    await screen.findByText('Tonight · so far');
    expect(container.querySelector('.score-ring--pending')).toBeNull();
    expect(container.querySelector('.night__headline')).not.toBeNull();
  });
});

describe('the sleep page night card, tonight in progress', () => {
  const show = (night) => renderAsAdmin(<SleepScoreCard night={night} />, { settings: { timezone: TZ } });

  test('★ draws a dashed ring and says when the score arrives, in place of "No score yet"', () => {
    const { container } = show(TONIGHT);
    expect(screen.getByText(AFTER_5PM)).toBeInTheDocument();
    expect(container.querySelector('.score-ring--pending')).not.toBeNull();
    expect(container.querySelector('.score-ring__num')).toBeNull();
    expect(screen.queryByText(/No score yet/)).not.toBeInTheDocument();
    // The so-far facts the server sends are still shown.
    expect(container.querySelector('.sleep-night-card__blurb:not(.sleep-night-card__pending)').textContent).toMatch(/4h 35m/);
  });

  test('★ a child whose score switch is off gets no promise of a score', () => {
    const { container } = show({ ...TONIGHT, score: undefined });
    expect(container.querySelector('.score-ring--pending')).toBeNull();
    expect(screen.queryByText(/Score and night summary/)).not.toBeInTheDocument();
  });

  test('a night with no window end still says "No score yet" with its reason', () => {
    show({ ...TONIGHT, window_end: undefined });
    expect(screen.getByText('No score yet. The night is still in progress.')).toBeInTheDocument();
  });
});

describe('the sleep page, a night with no data', () => {
  test('draws the dashed ring and keeps its words', async () => {
    vi.spyOn(api, 'get').mockImplementation((p) => {
      if (p.includes('/sleep/live')) return Promise.resolve({ scope: 'last', night: { night_date: '2026-08-30' } });
      if (p.includes('nights=')) return Promise.resolve({ nights: [] });
      if (p.includes('/sleep/insights')) return Promise.resolve(null);
      return Promise.resolve({ status: 'no_data' });
    });
    const ui = <Routes><Route path="/children/:id/sleep" element={<SleepDetail />} /></Routes>;
    const { container } = renderAsAdmin(ui, { route: '/children/kid-1/sleep', kids: [{ id: 'kid-1', name: 'Child A', birthday: null, color: '#f4c56a', photo: null }] });
    expect(await screen.findByText(/No sleep data for this night/)).toBeInTheDocument();
    expect(container.querySelector('.score-ring--pending')).not.toBeNull();
  });
});

describe('the review screen: the two quieter rows', () => {
  const NIGHT = {
    child_id: 'c-1',
    night_date: '2026-08-29',
    settings: { key: '', tz: TZ },
    computed: { status: 'ok', onset_at: '2026-08-29 09:33:00', in_bed_at: '2026-08-29 09:10:00', wake_at: '2026-08-29 19:48:00' },
    review: null,
    transitions: [],
  };
  beforeEach(() => { vi.spyOn(api, 'get').mockResolvedValue(NIGHT); });
  const routed = <Routes><Route path="/children/:id/review/:date" element={<NightReview />} /></Routes>;
  const at = () => renderAsAdmin(routed, { route: '/children/c-1/review/2026-08-29', kids: [{ id: 'c-1', name: 'Child B' }] });

  test('★ both are buttons in one card of their own, apart from the question', async () => {
    at();
    const confirm = await screen.findByRole('button', { name: /That.s right/ });
    const more = screen.getByRole('button', { name: /Change bedtime or fell-asleep time/ });
    const nobody = screen.getByRole('button', { name: /No one was in the bed/ });
    const rows = more.closest('.review-rows');
    expect(rows).not.toBeNull();
    expect(rows.contains(nobody)).toBe(true);
    // The question's own card is a different element, so the rows are not inside the confirm buttons' card.
    expect(rows.contains(confirm)).toBe(false);
  });

  test('the disclosure still opens and closes, and its hint sits above the fields', async () => {
    const { user } = at();
    const more = await screen.findByRole('button', { name: /Change bedtime or fell-asleep time/ });
    expect(more).toHaveAttribute('aria-expanded', 'false');
    await user.click(more);
    expect(more).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByLabelText('Fell asleep')).toBeInTheDocument();
    expect(screen.getByText(/We said .*Only a time you type here is saved/).closest('.review-hint')).not.toBeNull();
    await user.click(more);
    expect(more).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByLabelText('Fell asleep')).not.toBeInTheDocument();
  });

  test('a night already answered "no one was in the bed" shows only the question card', async () => {
    api.get.mockResolvedValue({ ...NIGHT, review: { nobody_in_bed: 1 } });
    at();
    expect(await screen.findByText('You said no one was in the bed.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Change bedtime or fell-asleep time/ })).not.toBeInTheDocument();
    expect(document.querySelector('.review-rows')).toBeNull();
  });
});

// --- the morning question belongs to the night the card shows (owner, staging phone 2026-11-13) -------------------------
// The server answers /review/pending about the LAST COMPLETED night whatever the child's card is showing. While tonight is in
// progress the card says "Tonight · so far", and last night's receipt ("Thanks, that's recorded. You said up at ...") sat under
// it. The question and the receipt are now drawn only for the finished night the card shows.
describe('the child page: the review row follows the night on screen', () => {
  const KIDS = [{ id: 'kid-1', name: 'Child B', birthday: '2023-03-01', color: '#f4c56a', photo: null }];
  const routes = <Routes><Route path="/children/:id" element={<ChildDetail />} /></Routes>;
  const DONE = { state: 'done', night_date: '2026-09-01', true_wake_at: '2026-09-01 19:56:00', true_onset_at: null, true_in_bed_at: null, nobody_in_bed: false };
  const ASK = { state: 'ask', night_date: '2026-09-01', wake_at: '2026-09-01 19:56:00', onset_at: '2026-09-01 09:00:00' };
  const FINISHED = { status: 'ok', night_date: '2026-09-01', in_progress: false, asleep_minutes: 600, wake_at: '2026-09-01 19:56:00' };
  const open = ({ live, pending }) => {
    vi.spyOn(api, 'get').mockImplementation((p) => {
      if (p.includes('/sleep/live')) return Promise.resolve(live);
      if (p.includes('/review/pending')) return Promise.resolve(pending);
      if (p.includes('/cameras/alerts')) return Promise.resolve([]);
      return Promise.resolve(null);
    });
    return renderAsAdmin(routes, { route: '/children/kid-1', kids: KIDS, cameras: [] });
  };

  test('★ tonight in progress: no receipt and no question from the previous night', async () => {
    for (const pending of [DONE, ASK]) {
      const { unmount } = open({ live: { scope: 'tonight', night: { ...TONIGHT, night_date: '2026-09-02' } }, pending });
      await screen.findByText('Tonight · so far');
      // Let the pending request settle: an absent row is only a statement once the answer has been handled.
      await waitFor(() => expect(api.get).toHaveBeenCalledWith(expect.stringContaining('/review/pending')));
      await new Promise((r) => setTimeout(r, 30));
      expect(screen.queryByText(/that.s recorded/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/Is that right\?/)).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Not quite' })).not.toBeInTheDocument();
      unmount();
      vi.restoreAllMocks();
    }
  });

  test('★ a finished night: the receipt shows as before, and so does the question', async () => {
    const done = open({ live: { scope: 'last', night: FINISHED }, pending: DONE });
    expect(await screen.findByText(/that.s recorded/i)).toBeInTheDocument();
    done.unmount();
    vi.restoreAllMocks();
    open({ live: { scope: 'last', night: FINISHED }, pending: ASK });
    expect(await screen.findByText(/Is that right\?/)).toBeInTheDocument();
  });

  test('★ an answer about a different night than the one shown is not drawn', async () => {
    open({ live: { scope: 'last', night: { ...FINISHED, night_date: '2026-08-31' } }, pending: DONE });
    await screen.findByText('Last night');
    await waitFor(() => expect(api.get).toHaveBeenCalledWith(expect.stringContaining('/review/pending')));
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByText(/that.s recorded/i)).not.toBeInTheDocument();
  });
});

describe('the child page camera: a slim row, not a picture area', () => {
  test('★ no placeholder picture; the name, detection line, Watch live and the gear are all there for an admin', () => {
    const cam = { id: 'c1', name: 'Child B Room', statusLevel: 'live', detect_motion_enabled: 1, detect_sound_enabled: 0 };
    const { container } = renderAsAdmin(<ChildCameraTile cam={cam} onWatch={() => {}} onSettings={() => {}} />);
    expect(container.querySelector('.child-cam__bed')).toBeNull();
    expect(container.querySelector('svg.lucide-bed-single')).toBeNull();
    expect(container.querySelector('.child-cam__detect').textContent).toBe('Motion on · Sound off');
    expect(screen.getByRole('button', { name: /Watch live/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Camera settings for Child B Room' })).toBeInTheDocument();
  });
});

describe('Room climate heading', () => {
  test('★ has the icon heading the Timelapse and Recent alerts cards have', async () => {
    vi.spyOn(api, 'get').mockResolvedValue([{ temperature: 21, humidity: 40, recorded_at: '2026-09-01 10:00:00' }]);
    const { container } = renderAsAdmin(<SensorHistoryCard camera={{ id: 'c1', name: 'Child B Room', mqtt_topic: 'x' }} />);
    await screen.findByText(/Room climate/);
    expect(container.querySelector('.sensor-card__title svg')).not.toBeNull();
  });
});
