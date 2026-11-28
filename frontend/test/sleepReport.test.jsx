// The weekly and monthly sleep report page (pages/SleepReport.jsx, issue #1236): what it asks for, the screens it can be in, how
// it words a change, how it draws a night that did not count, and the links that lead to it. The words and chart models behind
// it are in reportFormat.test.js; the server's own answer is tested in backend/test/sleep-report.test.js.
//
// WHAT THIS PROTECTS, in order of how silently it would break:
//   1. A STALE ANSWER OVERWRITING A NEWER ONE (week, then month, the week coming back second: a Month button over a week's figures);
//   2. A GAP DRAWN AS A ZERO, or a figure the server calls not ready drawn as 0 or NaN;
//   3. THE REQUEST: period, date and the viewer's own locale's week start, and only ever a GET;
//   4. THE CHILD WHOSE SCORE SWITCH IS OFF seeing the word "score" anywhere, or a band colour;
//   5. LOADING, FAILED AND EMPTY being three different screens.
// Each test below that backs a claim names it.
import { describe, test, expect, vi, afterEach } from 'vitest';
import { screen, waitFor, within, act } from '@testing-library/react';
import { Routes, Route, useLocation, useNavigate } from 'react-router-dom';
import { renderAs, renderAsAdmin, forEachRole, ADMIN } from './helpers/render.jsx';
import SleepReport from '../src/pages/SleepReport.jsx';
import ChildDetail from '../src/pages/ChildDetail.jsx';
import SleepDetail from '../src/pages/SleepDetail.jsx';
import { api } from '../src/lib/api.js';

const KID = { id: 'kid-1', name: 'Child B' };

afterEach(() => vi.restoreAllMocks());

// ---- fixtures -------------------------------------------------------------------------------------------------------

const figure = (value, extra = {}) => ({ value, n: 6, ready: true, ...extra });
const notReady = (n = 1) => ({ value: null, n, ready: false });
const night = (date, over = {}) => ({
  date, status_class: 'counted', score: 80, asleep_minutes: 600, wake_count: 2, longest_stretch_minutes: 300, onset_clock: 450, wake_clock: 1110, ...over,
});

// A finished Monday-to-Sunday week, 2026-11-02 to 2026-11-08: five counted nights, one not watched enough, one empty bed.
const WEEK_NIGHTS = [
  night('2026-11-02', { score: 82, asleep_minutes: 605, wake_count: 1 }),
  night('2026-11-03', { score: 88, onset_clock: 440 }),
  { date: '2026-11-04', status_class: 'low_coverage' },
  night('2026-11-05', { score: 71 }),
  { date: '2026-11-06', status_class: 'empty_bed' },
  night('2026-11-07', { score: 90 }),
  night('2026-11-08', { score: 76, onset_clock: 460 }),
];
const SUMMARY = {
  nights_counted: 5, nights_in_period: 7,
  score: figure(81),
  asleep_minutes: figure(605),
  wake_count: figure(2),
  longest_stretch_minutes: figure(300),
  settle_minutes: notReady(2),
  onset_clock: figure(450, { spread: 20 }),
  wake_clock: figure(1110, { spread: 10 }),
  best_night: { date: '2026-11-07', score: 90 },
  worst_night: { date: '2026-11-05', score: 71 },
};
const COMPARISON = {
  score: { direction: 'up', delta: 8.2 },
  asleep_minutes: { direction: 'steady', delta: -5 },
  wake_count: { direction: 'down', delta: -0.5 },
  longest_stretch_minutes: { direction: 'up', delta: 20.4 },
  settle_minutes: { direction: 'not_enough', delta: null },
  onset_clock: { direction: 'up', delta: 15 },
  wake_clock: { direction: 'down', delta: -20 },
};
const report = (over = {}) => ({
  period: { kind: 'week', from: '2026-11-02', to: '2026-11-08', complete: true },
  earliest_night_date: '2026-09-01',
  nights: WEEK_NIGHTS,
  summary: SUMMARY,
  previous: { from: '2026-10-26', to: '2026-11-01', summary: SUMMARY },
  comparison: COMPARISON,
  notes: [],
  ...over,
});
// The same report as the server sends it for a child whose Show sleep score switch is off: no `score` key ANYWHERE, and the
// extremes judged by time asleep.
const withoutScore = () => {
  const { score: _s, ...summary } = SUMMARY;
  const { score: _c, ...comparison } = COMPARISON;
  return report({
    nights: WEEK_NIGHTS.map(({ score: _n, ...rest }) => rest),
    summary: { ...summary, best_night: { date: '2026-11-02', asleep_minutes: 605 }, worst_night: { date: '2026-11-08', asleep_minutes: 540 } },
    comparison,
    previous: { from: '2026-10-26', to: '2026-11-01', summary },
  });
};

// ---- harness --------------------------------------------------------------------------------------------------------

function Where() {
  const l = useLocation();
  return <output data-testid="where">{l.pathname}{l.search}</output>;
}
// The browser's Back button, as the router's own history step (MemoryRouter has no window history to press).
function HistoryBack() {
  const navigate = useNavigate();
  return <button type="button" onClick={() => navigate(-1)}>history back</button>;
}
const page = <Routes><Route path="/children/:id/reports" element={<><SleepReport /><Where /><HistoryBack /></>} /></Routes>;
const at = (query = '') => ({ kids: [KID], route: `/children/kid-1/reports${query}` });

// Answers each report GET by the request path (so a test sees WHAT was asked); everything else is null. Returns the spy.
function serve(answer = () => report()) {
  return vi.spyOn(api, 'get').mockImplementation((path) => Promise.resolve(answer(String(path))));
}
const asked = (spy) => spy.mock.calls.map((c) => String(c[0]));
const lastAsked = (spy) => asked(spy).at(-1);
const params = (path) => new URLSearchParams(path.split('?')[1]);
const mount = (query = '', who = ADMIN, ui = page) => renderAs(who, ui, at(query));
const where = () => screen.getByTestId('where').textContent;
const deferred = () => {
  let resolve; let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const tile = (label) => screen.getByText(label, { selector: 'dt' }).closest('.report-tile');

// ---- the three screens ----------------------------------------------------------------------------------------------

describe('loading, failed and empty are three different screens', () => {
  test('★ loading: calm text, no error, no empty copy, the arrows wait', () => {
    vi.spyOn(api, 'get').mockImplementation(() => new Promise(() => {}));
    mount();
    expect(screen.getByText('Loading report…')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('No nights yet')).toBeNull();
    expect(screen.getByRole('button', { name: 'Previous week' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next week' })).toBeDisabled();
    // The Week | Month switch is still usable while the first request is out.
    expect(screen.getByRole('button', { name: 'Month' })).toBeEnabled();
  });

  test('★ failed: a plain message and a Retry button, never the report or the empty copy; Retry asks again', async () => {
    const get = vi.spyOn(api, 'get').mockRejectedValueOnce(new Error('The server took too long to respond.'));
    get.mockResolvedValue(report());
    const { user } = mount();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Couldn’t load this report.');
    expect(alert).toHaveTextContent('Check your connection, then try again.');
    expect(screen.queryByText('Loading report…')).toBeNull();
    expect(screen.queryByText('No nights yet')).toBeNull();
    expect(screen.queryByText('A typical night')).toBeNull();
    await user.click(screen.getByRole('button', { name: /retry/i }));
    expect(await screen.findByText('A typical night')).toBeInTheDocument();
    expect(get).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('a null or unreadable answer (a proxy page that came back 200) is a failure, not a half-empty page', async () => {
    serve(() => null);
    mount();
    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t load this report.');
    expect(screen.queryByText('No nights yet')).toBeNull();
  });

  test('★ a 200 whose `nights` holds a null (valid-looking period and summary) is the failed screen, not a crash', async () => {
    // The exact shape Codex found: string bounds, an object summary, nights [null]. chartModel used to throw reading n.date.
    serve(() => ({ period: { kind: 'week', from: '2026-11-02', to: '2026-11-08', complete: true }, summary: {}, comparison: {}, nights: [null] }));
    const { user } = mount();
    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t load this report.');
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
    expect(screen.queryByText('A typical night')).toBeNull();
    expect(screen.queryByText('No nights yet')).toBeNull();
    await user.click(screen.getByRole('button', { name: /retry/i }));
  });

  test('★ forward compatible: an extra key on the report and on a night, and an unknown note, still draw', async () => {
    serve(() => ({ ...report({ notes: ['a_new_code'] }), brand_new_key: { x: 1 }, nights: WEEK_NIGHTS.map((n) => ({ ...n, extra_field: 'x' })) }));
    mount();
    expect(await screen.findByText('A typical night')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('★ empty: a child with no saved night says reports appear after the first night, with no controls and no error', async () => {
    serve(() => report({ earliest_night_date: null, nights: [], previous: null, summary: { nights_counted: 0, nights_in_period: 0 }, comparison: {} }));
    mount();
    expect(await screen.findByText('No nights yet')).toBeInTheDocument();
    expect(screen.getByText(/Reports appear after the first night is recorded/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('Loading report…')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Week' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Previous week' })).toBeNull();
  });

  test('★ insufficient: fewer nights than a typical night needs still shows the chart and the gaps, and says plainly why the figures are missing', async () => {
    const thin = {
      nights_counted: 2, nights_in_period: 7, score: notReady(2), asleep_minutes: notReady(2), wake_count: notReady(2),
      longest_stretch_minutes: notReady(2), settle_minutes: notReady(1), onset_clock: { ...notReady(2), spread: null },
      wake_clock: { ...notReady(2), spread: null }, best_night: null, worst_night: null,
    };
    serve(() => report({
      nights: [night('2026-11-02'), { date: '2026-11-03', status_class: 'no_data' }, { date: '2026-11-04', status_class: 'low_coverage' }, night('2026-11-05'),
        { date: '2026-11-06', status_class: 'no_data' }, { date: '2026-11-07', status_class: 'no_data' }, { date: '2026-11-08', status_class: 'no_data' }],
      summary: thin, previous: null, comparison: {},
    }));
    mount();
    expect(await screen.findByRole('heading', { name: 'Not enough nights yet' })).toBeInTheDocument();
    expect(screen.getByText(/Only 2 nights counted of 7 this week/)).toBeInTheDocument();
    // No tile grid of seven "not enough" boxes, but the chart and its gaps are all there.
    expect(screen.queryByText('A typical night')).toBeNull();
    expect(screen.getByRole('list', { name: 'Each night this week' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /Wed 4, 4 Nov, Not enough of this night was watched/ })).toBeInTheDocument();
    expect(screen.getByText(/Not counted: 4 nights with no data, 1 night not watched enough/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

// ---- the request ----------------------------------------------------------------------------------------------------

describe('the request', () => {
  test('★ it is a GET of the report with period, week_start from the viewer\'s locale, and the date in the address', async () => {
    const get = serve();
    mount('?period=week&date=2026-11-05');
    await screen.findByText('A typical night');
    const p = params(lastAsked(get));
    expect(lastAsked(get)).toMatch(/^\/children\/kid-1\/sleep\/report\?/);
    expect(p.get('period')).toBe('week');
    expect(p.get('date')).toBe('2026-11-05');
    expect(p.get('week_start')).toMatch(/^[1-7]$/);
  });

  test('with no date in the address none is sent: today is the server\'s to work out in the app timezone', async () => {
    const get = serve();
    mount();
    await screen.findByText('A typical night');
    expect(params(lastAsked(get)).has('date')).toBe(false);
    expect(params(lastAsked(get)).get('period')).toBe('week');
  });

  test('a hand-edited bad date or period is ignored, never sent (the server would answer 400)', async () => {
    const get = serve();
    mount('?period=year&date=2026-02-31');
    await screen.findByText('A typical night');
    const p = params(lastAsked(get));
    expect(p.get('period')).toBe('week');
    expect(p.has('date')).toBe(false);
  });

  // ★ The locale's own week start, three ways. The stand-in answers BY LANGUAGE, so a hard-coded 1 (or 7) fails one of them.
  describe.each([
    ['a Sunday-first locale', 'en-US', { getWeekInfo: () => ({ firstDay: 7 }) }, '7'],
    ['a Monday-first locale', 'en-GB', { getWeekInfo: () => ({ firstDay: 1 }) }, '1'],
    ['a Saturday-first locale (the older weekInfo spelling)', 'ar-EG', { weekInfo: { firstDay: 6 } }, '6'],
    ['a locale the runtime knows no week for', 'xx', {}, '1'],
  ])('%s', (_name, language, info, expected) => {
    test(`week_start is ${expected}`, async () => {
      const realLocale = Intl.Locale;
      vi.spyOn(navigator, 'language', 'get').mockReturnValue(language);
      Intl.Locale = class { constructor(l) { this.language = l; Object.assign(this, info); } };
      try {
        const get = serve();
        mount('?period=week');
        await screen.findByText('A typical night');
        expect(params(lastAsked(get)).get('week_start')).toBe(expected);
      } finally {
        Intl.Locale = realLocale;
      }
    });
  });

  test('★ read-only: only GET is ever called, whatever is pressed', async () => {
    const get = serve();
    const writes = ['post', 'put', 'patch', 'del'].map((m) => vi.spyOn(api, m).mockResolvedValue({}));
    const { user } = mount('?period=week&date=2026-11-05');
    await screen.findByText('A typical night');
    await user.click(screen.getByRole('button', { name: 'Month' }));
    await waitFor(() => expect(asked(get).length).toBe(2));
    await user.click(screen.getByRole('button', { name: 'Previous month' }));
    for (const w of writes) expect(w).not.toHaveBeenCalled();
  });
});

// ---- the controls ---------------------------------------------------------------------------------------------------

describe('Week | Month and the arrows', () => {
  test('★ Week and Month switch refetch with the other period, keep the date, and put the choice in the address', async () => {
    const get = serve((path) => (params(path).get('period') === 'month'
      ? report({ period: { kind: 'month', from: '2026-11-01', to: '2026-11-30', complete: true }, nights: [night('2026-11-01')] })
      : report()));
    const { user } = mount('?period=week&date=2026-11-05');
    await screen.findByText('A typical night');
    expect(screen.getByRole('button', { name: 'Week' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Month' })).toHaveAttribute('aria-pressed', 'false');

    await user.click(screen.getByRole('button', { name: 'Month' }));
    expect(await screen.findByRole('heading', { name: 'November 2026' })).toBeInTheDocument();
    expect(asked(get)).toHaveLength(2);
    expect(params(lastAsked(get)).get('period')).toBe('month');
    expect(params(lastAsked(get)).get('date')).toBe('2026-11-05');
    expect(where()).toBe('/children/kid-1/reports?period=month&date=2026-11-05');
    expect(screen.getByRole('button', { name: 'Month' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Previous month' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Week' }));
    await waitFor(() => expect(asked(get)).toHaveLength(3));
    expect(params(lastAsked(get)).get('period')).toBe('week');
  });

  test('pressing the period that is already shown asks for nothing', async () => {
    const get = serve();
    const { user } = mount('?period=week');
    await screen.findByText('A typical night');
    await user.click(screen.getByRole('button', { name: 'Week' }));
    expect(asked(get)).toHaveLength(1);
  });

  test('★ the arrows step by the answer\'s own bounds, over a month end and a year end', async () => {
    // A week over the year end: the next one starts the day after its `to`, in the new year.
    const get = serve(() => report({ period: { kind: 'week', from: '2026-12-28', to: '2027-01-03', complete: true } }));
    const { user } = mount('?period=week&date=2026-12-30');
    expect(await screen.findByRole('heading', { name: /28 Dec 2026.*3 Jan 2027/ })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Next week' }));
    await waitFor(() => expect(asked(get)).toHaveLength(2));
    expect(params(lastAsked(get)).get('date')).toBe('2027-01-04');
    expect(where()).toBe('/children/kid-1/reports?period=week&date=2027-01-04');
  });

  test('★ Dec -> Jan and Jan -> Dec for a month', async () => {
    const monthOf = (date) => {
      const [y, m] = date.split('-').map(Number);
      const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
      const mm = String(m).padStart(2, '0');
      return report({ period: { kind: 'month', from: `${y}-${mm}-01`, to: `${y}-${mm}-${last}`, complete: true } });
    };
    const get = serve((path) => monthOf(params(path).get('date')));
    const { user } = mount('?period=month&date=2026-12-15');
    expect(await screen.findByRole('heading', { name: 'December 2026' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Next month' }));
    expect(await screen.findByRole('heading', { name: 'January 2027' })).toBeInTheDocument();
    expect(params(lastAsked(get)).get('date')).toBe('2027-01-01');
    await user.click(screen.getByRole('button', { name: 'Previous month' }));
    expect(await screen.findByRole('heading', { name: 'December 2026' })).toBeInTheDocument();
    expect(params(lastAsked(get)).get('date')).toBe('2026-12-31');
  });

  test('★ next is disabled for the period that is still running, previous for a period back to the first night', async () => {
    serve(() => report({ period: { kind: 'week', from: '2026-11-02', to: '2026-11-08', complete: false }, earliest_night_date: '2026-11-02' }));
    mount();
    await screen.findByText('A typical night');
    expect(screen.getByRole('button', { name: 'Next week' })).toBeDisabled();
    // The previous week ends 2026-11-01, before the first saved night (2026-11-02): nothing to go back to.
    expect(screen.getByRole('button', { name: 'Previous week' })).toBeDisabled();
  });

  test('one day later the previous week is reachable, and a finished period can go forward', async () => {
    serve(() => report({ earliest_night_date: '2026-11-01' }));
    mount();
    await screen.findByText('A typical night');
    expect(screen.getByRole('button', { name: 'Previous week' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Next week' })).toBeEnabled();
  });

  test('★ the browser Back button steps back through the periods (the address is the state)', async () => {
    const get = serve((path) => (params(path).get('period') === 'month'
      ? report({ period: { kind: 'month', from: '2026-11-01', to: '2026-11-30', complete: true } })
      : report()));
    const { user } = mount('?period=week');
    await screen.findByText('A typical night');
    await user.click(screen.getByRole('button', { name: 'Month' }));
    expect(await screen.findByRole('heading', { name: 'November 2026' })).toBeInTheDocument();
    expect(where()).toBe('/children/kid-1/reports?period=month');
    await user.click(screen.getByRole('button', { name: 'history back' }));
    // Back is one step to the week that was open, read again from the address: the page follows the address.
    expect(await screen.findByRole('heading', { name: /2.8 Nov 2026/ })).toBeInTheDocument();
    expect(where()).toBe('/children/kid-1/reports?period=week');
    expect(screen.getByRole('button', { name: 'Week' })).toHaveAttribute('aria-pressed', 'true');
    expect(params(lastAsked(get)).get('period')).toBe('week');
  });

  test('the room for a later Download button exists and renders nothing', async () => {
    serve();
    mount();
    await screen.findByText('A typical night');
    const room = document.querySelector('.report-controls__actions');
    expect(room).not.toBeNull();
    expect(room).toBeEmptyDOMElement();
  });
});

// ---- stale answers --------------------------------------------------------------------------------------------------

describe('a superseded request', () => {
  test('★ a week that answers AFTER the month does not overwrite it', async () => {
    const weekAnswer = deferred();
    const monthAnswer = deferred();
    const get = vi.spyOn(api, 'get').mockImplementation((path) => (params(String(path)).get('period') === 'month' ? monthAnswer.promise : weekAnswer.promise));
    const { user } = mount('?period=week&date=2026-11-05');
    expect(await screen.findByText('Loading report…')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Month' }));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));

    await act(async () => { monthAnswer.resolve(report({ period: { kind: 'month', from: '2026-11-01', to: '2026-11-30', complete: true } })); });
    expect(await screen.findByRole('heading', { name: 'November 2026' })).toBeInTheDocument();

    // The OLD request answers last, with a week. It must be dropped.
    await act(async () => { weekAnswer.resolve(report()); });
    expect(screen.getByRole('heading', { name: 'November 2026' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /2.8 Nov 2026/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Month' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('list', { name: 'Each night this month' })).toBeInTheDocument();
  });

  test('a superseded request that FAILS late does not show an error over the newer answer', async () => {
    const weekAnswer = deferred();
    vi.spyOn(api, 'get').mockImplementation((path) => (params(String(path)).get('period') === 'month'
      ? Promise.resolve(report({ period: { kind: 'month', from: '2026-11-01', to: '2026-11-30', complete: true } }))
      : weekAnswer.promise));
    const { user } = mount('?period=week');
    await screen.findByText('Loading report…');
    await user.click(screen.getByRole('button', { name: 'Month' }));
    expect(await screen.findByRole('heading', { name: 'November 2026' })).toBeInTheDocument();
    await act(async () => { weekAnswer.reject(new Error('boom')); });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('heading', { name: 'November 2026' })).toBeInTheDocument();
  });

  test('the request carries an abort signal, and it is aborted when superseded', async () => {
    const signals = [];
    vi.spyOn(api, 'get').mockImplementation((path, opts) => { signals.push(opts?.signal); return new Promise(() => {}); });
    const { user } = mount('?period=week');
    await screen.findByText('Loading report…');
    await user.click(screen.getByRole('button', { name: 'Month' }));
    await waitFor(() => expect(signals).toHaveLength(2));
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
  });
});

// ---- the figures ----------------------------------------------------------------------------------------------------

describe('the typical night', () => {
  test('★ each tile shows the typical value and the change as an arrow AND words, for both roles', async () => {
    serve();
    await forEachRole(async (_name, who) => {
      const { unmount } = mount('', who);
      await screen.findByText('A typical night');
      expect(within(tile('Sleep score')).getByText('81')).toBeInTheDocument();
      expect(within(tile('Sleep score')).getByText('up 8 points')).toBeInTheDocument();
      expect(within(tile('Time asleep')).getByText('10h 5m')).toBeInTheDocument();
      expect(within(tile('Time asleep')).getByText('steady')).toBeInTheDocument();
      expect(within(tile('Wake-ups')).getByText('2')).toBeInTheDocument();
      expect(within(tile('Wake-ups')).getByText('down 0.5 wake-ups')).toBeInTheDocument();
      expect(within(tile('Longest stretch')).getByText('5h 0m')).toBeInTheDocument();
      expect(within(tile('Longest stretch')).getByText('up 20 minutes')).toBeInTheDocument();
      expect(within(tile('Fell asleep')).getByText('15 minutes later')).toBeInTheDocument();
      expect(within(tile('Got up')).getByText('20 minutes earlier')).toBeInTheDocument();
      // The arrow is a drawn icon beside the words, never the only signal.
      for (const label of ['Sleep score', 'Time asleep', 'Fell asleep']) {
        expect(tile(label).querySelector('.report-tile__change svg')).not.toBeNull();
        expect(tile(label).querySelector('.report-tile__change svg')).toHaveAttribute('aria-hidden', 'true');
      }
      unmount();
    });
  });

  test('★ a figure that is not ready says "Not enough nights yet": no dash, no zero, no NaN', async () => {
    serve();
    mount();
    await screen.findByText('A typical night');
    const settle = tile('Settling time');
    expect(within(settle).getByText('Not enough nights yet')).toBeInTheDocument();
    expect(settle.textContent).not.toMatch(/NaN|null|undefined/);
    expect(settle.textContent).not.toMatch(/\b0m\b|^Settling time0/);
    expect(document.body.textContent).not.toMatch(/NaN|undefined/);
  });

  test('★ a ready figure whose value came back null still reads "Not enough nights yet", never 0', async () => {
    serve(() => report({ summary: { ...SUMMARY, asleep_minutes: { value: null, n: 5, ready: true } } }));
    mount();
    await screen.findByText('A typical night');
    expect(within(tile('Time asleep')).getByText('Not enough nights yet')).toBeInTheDocument();
    expect(tile('Time asleep').textContent).not.toMatch(/0m/);
  });

  test('a comparison of "not enough" reads "not enough nights to compare", and the previous period is named', async () => {
    serve(() => report({ comparison: { ...COMPARISON, asleep_minutes: { direction: 'not_enough', delta: null } } }));
    mount();
    await screen.findByText('A typical night');
    expect(within(tile('Time asleep')).getByText('not enough nights to compare')).toBeInTheDocument();
    expect(screen.getByText(/Changes are against .*26 Oct.*1 Nov 2026\./)).toBeInTheDocument();
  });

  test('with no previous period it says there is nothing to compare with, and every change reads "not enough nights to compare"', async () => {
    serve(() => report({ previous: null, comparison: Object.fromEntries(Object.keys(COMPARISON).map((k) => [k, { direction: 'not_enough', delta: null }])) }));
    mount();
    await screen.findByText('A typical night');
    expect(screen.getByText(/There is no earlier week with saved nights to compare with\./)).toBeInTheDocument();
    expect(within(tile('Sleep score')).getByText('not enough nights to compare')).toBeInTheDocument();
  });

  test('the clock tiles show how much the times varied, rounded', async () => {
    serve();
    mount();
    await screen.findByText('A typical night');
    expect(within(tile('Fell asleep')).getByText('half of nights within about 20 minutes')).toBeInTheDocument();
    expect(within(tile('Got up')).getByText('half of nights within about 10 minutes')).toBeInTheDocument();
  });

  test('the best and the lowest night link to those nights, and are hidden when the server sends none', async () => {
    serve();
    const first = mount();
    await screen.findByText('A typical night');
    const best = screen.getByRole('link', { name: /Highest score/ });
    expect(best).toHaveAttribute('href', '/children/kid-1/sleep?date=2026-11-07');
    expect(best).toHaveTextContent('90');
    expect(screen.getByRole('link', { name: /Lowest score/ })).toHaveAttribute('href', '/children/kid-1/sleep?date=2026-11-05');
    first.unmount();

    serve(() => report({ summary: { ...SUMMARY, best_night: null, worst_night: null } }));
    mount();
    await screen.findByText('A typical night');
    expect(screen.queryByRole('link', { name: /Highest score/ })).toBeNull();
    expect(screen.queryByRole('link', { name: /Lowest score/ })).toBeNull();
  });
});

// ---- the chart ------------------------------------------------------------------------------------------------------

describe('night by night', () => {
  const slotFor = (date) => {
    const el = [...document.querySelectorAll('.report-slot')].find((s) => (s.querySelector('[aria-label]')?.getAttribute('aria-label') || '').includes(`, ${Number(date.slice(8))} Nov`));
    return el;
  };

  test('★ a night that did not count is an empty slot with its reason, never a bar of any height, for every reason', async () => {
    serve(() => report({
      nights: [
        night('2026-11-02'),
        { date: '2026-11-03', status_class: 'no_data' },
        { date: '2026-11-04', status_class: 'low_coverage' },
        { date: '2026-11-05', status_class: 'empty_bed' },
        { date: '2026-11-06', status_class: 'in_progress' },
        night('2026-11-07'),
        night('2026-11-08'),
      ],
    }));
    mount();
    await screen.findByText('A typical night');
    const reasons = {
      '2026-11-03': 'No data',
      '2026-11-04': 'Not enough of this night was watched',
      '2026-11-05': 'No one was in the bed',
      '2026-11-06': 'Tonight, still in progress',
    };
    for (const [date, words] of Object.entries(reasons)) {
      const slot = slotFor(date);
      expect(slot, date).toBeTruthy();
      expect(slot.querySelector('.report-bar'), `${date} has no bar`).toBeNull();
      expect(slot.querySelector('[style]'), `${date} has no height`).toBeNull();
      expect(slot.querySelector('.report-gap'), `${date} has the gap mark`).not.toBeNull();
      expect(within(slot).getByRole('img', { name: new RegExp(words) })).toBeInTheDocument();
      expect(slot.querySelector('a'), `${date} is not a link`).toBeNull();
    }
  });

  test('★ a counted night is a bar as tall as its score, coloured by the score band, and a link to that night', async () => {
    serve();
    mount();
    await screen.findByText('A typical night');
    const link = screen.getByRole('link', { name: /^Mon 2, 2 Nov, score 82, Good, asleep 10h 5m, 1 wake-up$/ });
    expect(link).toHaveAttribute('href', '/children/kid-1/sleep?date=2026-11-02');
    const bar = link.querySelector('.report-bar');
    expect(bar).toHaveClass('report-bar--good');
    expect(bar.style.height).toBe('82%');
    // 88 and 90 are the Great band; 71 is Good.
    expect(screen.getByRole('link', { name: /^Tue 3,.*score 88, Great/ }).querySelector('.report-bar')).toHaveClass('report-bar--great');
    expect(screen.getByRole('link', { name: /^Thu 5,.*score 71, Good/ }).querySelector('.report-bar')).toHaveClass('report-bar--good');
  });

  test('every night of the period has a slot, in order, and the chart explains itself in words and in print', async () => {
    serve();
    mount();
    await screen.findByText('A typical night');
    expect(screen.getByRole('list', { name: 'Each night this week' }).querySelectorAll('.report-slot')).toHaveLength(7);
    expect(screen.getByText(/Bar height is the sleep score, and its colour is the score band\./)).toBeInTheDocument();
    expect(screen.getByText('Not counted: 1 night not watched enough, 1 night with no one in the bed.')).toBeInTheDocument();
  });

  test('a month draws one slot per date, and prints a number on the 1st and every fifth day only', async () => {
    const dates = Array.from({ length: 30 }, (_, i) => `2026-11-${String(i + 1).padStart(2, '0')}`);
    serve(() => report({ period: { kind: 'month', from: '2026-11-01', to: '2026-11-30', complete: true }, nights: dates.map((d) => night(d)) }));
    mount('?period=month');
    await screen.findByText('A typical night');
    const slots = screen.getByRole('list', { name: 'Each night this month' }).querySelectorAll('.report-slot');
    expect(slots).toHaveLength(30);
    const printed = [...slots].map((s) => s.querySelector('.report-slot__label').textContent).filter(Boolean);
    expect(printed).toEqual(['1', '6', '11', '16', '21', '26']);
  });

  test('★ a counted night with no score, among nights with scores, is a hollow stub that still links, not a zero', async () => {
    serve(() => report({ nights: [night('2026-11-02'), night('2026-11-03', { score: undefined }), night('2026-11-04')] }));
    mount();
    await screen.findByText('A typical night');
    const link = screen.getByRole('link', { name: /^Tue 3,.*No score for this night/ });
    expect(link.querySelector('.report-bar--stub')).not.toBeNull();
    expect(link.querySelector('[style]')).toBeNull();
  });

  test('without scores the bars are time asleep, in the timeline colour, and say so', async () => {
    serve(() => withoutScore());
    mount();
    await screen.findByText('A typical night');
    expect(screen.getByText(/Bar height is the time asleep\./)).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /^Mon 2,/ });
    expect(link.querySelector('.report-bar')).toHaveClass('report-bar--time');
    // 605 minutes of a 12 hour axis.
    expect(parseFloat(link.querySelector('.report-bar').style.height)).toBeCloseTo((605 / 720) * 100, 1);
  });
});

describe('fell asleep and got up', () => {
  test('★ a chart for each, with the typical time in words, and the same numbers as a table for a screen reader', async () => {
    serve();
    mount();
    await screen.findByText('A typical night');
    const fell = screen.getByRole('img', { name: /Fell asleep/ });
    expect(fell.querySelector('desc').textContent).toMatch(/Typical time (7:30|19:30).*half of nights within about 20 minutes.*5 nights shown/);
    expect(fell.querySelectorAll('.report-drift__dot')).toHaveLength(5);
    expect(fell.querySelector('.report-drift__typical')).not.toBeNull();
    expect(fell.querySelector('.report-drift__band')).not.toBeNull();
    expect(screen.getByRole('img', { name: /Got up/ }).querySelectorAll('.report-drift__dot')).toHaveLength(5);
    const table = screen.getByRole('table', { name: /Fell asleep and got up, night by night/ });
    expect(within(table).getAllByRole('row')).toHaveLength(6); // the head and five counted nights
    expect(within(table).getAllByRole('cell')[0].textContent).toMatch(/7:30|19:30/);
  });

  test('a gap has no dot, and a period with no clock time at all draws neither chart', async () => {
    serve(() => report({ nights: WEEK_NIGHTS.map((n) => ({ date: n.date, status_class: n.status_class === 'counted' ? 'counted' : n.status_class, score: n.score })) }));
    mount();
    await screen.findByText('A typical night');
    expect(screen.queryByRole('img', { name: /Fell asleep/ })).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
  });
});

// ---- notes ----------------------------------------------------------------------------------------------------------

describe('the notes', () => {
  test('★ a period still running says "So far: N of M nights"; a finished one does not', async () => {
    serve(() => report({ period: { kind: 'week', from: '2026-11-02', to: '2026-11-08', complete: false }, summary: { ...SUMMARY, nights_counted: 4, nights_in_period: 5 } }));
    const first = mount();
    expect(await screen.findByText(/So far: 4 of 5 nights\./)).toBeInTheDocument();
    first.unmount();

    serve();
    mount();
    await screen.findByText('A typical night');
    expect(screen.queryByText(/So far/)).toBeNull();
  });

  test('before any night of the period has finished it says so, not "0 of 0"', async () => {
    serve(() => report({ period: { kind: 'week', from: '2026-11-02', to: '2026-11-08', complete: false }, summary: { ...SUMMARY, nights_counted: 0, nights_in_period: 0 } }));
    mount();
    expect(await screen.findByText(/So far: no nights have finished yet this week\./)).toBeInTheDocument();
    expect(screen.queryByText(/0 of 0/)).toBeNull();
  });

  test('★ context_changed shows one line about the camera or sleep window', async () => {
    serve(() => report({ notes: ['context_changed'] }));
    mount();
    const note = await screen.findByText(/The camera or sleep window changed within this and the previous week, so some comparisons may not be like for like\./);
    expect(note).toBeInTheDocument();
  });

  test('★ a note code this build does not know is ignored, and the page still draws', async () => {
    serve(() => report({ notes: ['something_new', 7, null] }));
    mount();
    await screen.findByText('A typical night');
    expect(screen.queryByText(/camera or sleep window changed/)).toBeNull();
    expect(screen.queryByText(/something_new/)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('a report without `notes` at all still draws', async () => {
    const { notes: _n, ...rest } = report();
    serve(() => rest);
    mount();
    expect(await screen.findByText('A typical night')).toBeInTheDocument();
  });
});

// ---- the score switch -----------------------------------------------------------------------------------------------

describe('a child whose Show sleep score switch is off', () => {
  test('★ there is no score tile, no band colour, and the word "score" is nowhere on the page', async () => {
    serve(() => withoutScore());
    await forEachRole(async (_name, who) => {
      const { unmount, container } = mount('', who);
      await screen.findByText('A typical night');
      expect(screen.queryByText('Sleep score', { selector: 'dt' })).toBeNull();
      expect(container.querySelector('[class*="--great"], [class*="--good"], [class*="--fair"], [class*="--low"], [class*="--early"]')).toBeNull();
      expect(container.querySelector('.report-tile__mark')).toBeNull();
      // Every accessible name too, not only the printed words.
      const names = [...container.querySelectorAll('[aria-label]')].map((e) => e.getAttribute('aria-label')).join(' ');
      expect(`${container.textContent} ${names}`).not.toMatch(/score/i);
      // The extremes are about sleep, not a score.
      expect(screen.getByRole('link', { name: /Most sleep/ })).toHaveAttribute('href', '/children/kid-1/sleep?date=2026-11-02');
      expect(screen.getByRole('link', { name: /Least sleep/ })).toBeInTheDocument();
      unmount();
    });
  });
});

// ---- the way in -----------------------------------------------------------------------------------------------------

describe('the links to the report', () => {
  test('★ the child\'s page links to it, for an admin and a caregiver', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(null);
    await forEachRole(async (_name, who) => {
      const { unmount } = renderAs(who, <Routes><Route path="/children/:id" element={<ChildDetail />} /></Routes>, { kids: [{ ...KID, birthday: null }], cameras: [], route: '/children/kid-1' });
      const link = await screen.findByRole('link', { name: 'Weekly and monthly reports' });
      expect(link).toHaveAttribute('href', '/children/kid-1/reports');
      unmount();
    });
  });

  test('★ the sleep page links to it, even while the night is still loading', async () => {
    vi.spyOn(api, 'get').mockImplementation(() => new Promise(() => {}));
    renderAsAdmin(<Routes><Route path="/children/:id/sleep" element={<SleepDetail />} /></Routes>, { kids: [KID], route: '/children/kid-1/sleep' });
    expect(await screen.findByRole('link', { name: 'Weekly and monthly reports' })).toHaveAttribute('href', '/children/kid-1/reports');
  });

  test('the report\'s back link names the child', async () => {
    serve();
    mount();
    await screen.findByText('A typical night');
    expect(document.querySelector('.app-header').textContent).toContain('Child B');
    expect(screen.getByRole('heading', { name: 'Reports', level: 1 })).toBeInTheDocument();
  });
});
