import { afterEach, describe, expect, test, vi } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import { Routes, Route } from 'react-router-dom';
import { renderAsAdmin } from './helpers/render.jsx';
import Children from '../src/pages/Children.jsx';
import { useLiveSleep } from '../src/lib/useLiveSleep.js';
import { api } from '../src/lib/api.js';

const FIRST = { id: 'first', name: 'First child', birthday: null };
const SECOND = { id: 'second', name: 'Second child', birthday: null };
const cameras = [{ id: 'one', child_id: 'first' }, { id: 'two', child_id: 'first' }];
const scored = { scope: 'last', night: { status: 'ok', asleep_minutes: 432, score: { score: 82, band: 'good', early_estimate: false } } };
const show = (kids = [FIRST], cams = cameras) => renderAsAdmin(
  <Routes><Route path="/" element={<Children />} /><Route path="/children/:id" element={<div>Child detail</div>} /></Routes>,
  { kids, cameras: cams }
);
const card = () => document.querySelector('.child-card');

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('Children list sleep', () => {
  test('finished scored night prints the second row and ring, with a matching ordered button name', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(scored);
    const { user } = show();
    expect(await screen.findByText('7h 12m asleep')).toBeInTheDocument();
    expect(card().querySelector('.child-card__sleep-caption')).toHaveTextContent('Last night');
    expect(card().querySelector('.score-ring__num')).toHaveTextContent('82');
    expect(card().querySelector('.child-card__score-word')).toHaveTextContent('Good');
    expect(card().getAttribute('aria-label')).toBe('First child, 2 cameras, Last night 7h 12m asleep, Sleep score 82, Good');
    await user.click(card());
    expect(screen.getByText('Child detail')).toBeInTheDocument();
  });

  test('night in progress shows Tonight so far and duration without a ring', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({ scope: 'tonight', night: { status: 'ok', asleep_minutes: 267 } });
    show();
    expect(await screen.findByText('4h 27m asleep')).toBeInTheDocument();
    expect(card().querySelector('.child-card__sleep-caption')).toHaveTextContent('Tonight so far');
    expect(card().querySelector('.score-ring')).toBeNull();
  });

  test('score switch off leaves the duration row but no ring', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({ scope: 'last', night: { status: 'ok', asleep_minutes: 432 } });
    show();
    expect(await screen.findByText('7h 12m asleep')).toBeInTheDocument();
    expect(card().querySelector('.score-ring')).toBeNull();
  });

  test.each([
    ['tracking off', { scope: 'off', night: null }],
    ['no data', { scope: 'last', night: { status: 'no_data' } }],
    ['no_sleep', { scope: 'last', night: { status: 'no_sleep' } }],
    ['empty', { scope: 'last', night: { status: 'empty' } }],
    ['missing duration', { scope: 'last', night: { status: 'ok', asleep_minutes: null } }],
    ['request failure', null],
  ])('%s keeps exactly the old card', async (_state, payload) => {
    vi.spyOn(api, 'get').mockImplementation(() => payload == null ? Promise.reject(new Error('failed')) : Promise.resolve(payload));
    show();
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    await act(async () => {});
    expect(card().getAttribute('aria-label')).toBeNull();
    expect(card().querySelector('.child-card__sleep')).toBeNull();
    expect(screen.getByRole('button', { name: 'First child2 cameras' })).toBe(card());
  });

  test('loading keeps exactly the old card', () => {
    vi.spyOn(api, 'get').mockImplementation(() => new Promise(() => {}));
    show();
    expect(card().getAttribute('aria-label')).toBeNull();
    expect(card().querySelector('.child-card__sleep')).toBeNull();
    expect(screen.getByRole('button', { name: 'First child2 cameras' })).toBe(card());
  });

  test('early estimate prints Early and speaks the full qualifier', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({ scope: 'last', night: { ...scored.night, score: { score: 64, band: null, early_estimate: true } } });
    show();
    expect(await screen.findByText('Early')).toBeInTheDocument();
    expect(card().getAttribute('aria-label')).toContain('Sleep score 64, early estimate');
  });

  test('two children request and show their own night', async () => {
    const get = vi.spyOn(api, 'get').mockImplementation((path) => Promise.resolve(path.includes('first') ? scored : { scope: 'tonight', night: { status: 'ok', asleep_minutes: 267 } }));
    show([FIRST, SECOND]);
    expect(await screen.findByText('7h 12m asleep')).toBeInTheDocument();
    expect(await screen.findByText('4h 27m asleep')).toBeInTheDocument();
    expect(get.mock.calls.map(([path]) => path)).toEqual(['/children/first/sleep/live', '/children/second/sleep/live']);
  });

  test('list hook has no interval, while the default hook refreshes after three minutes', async () => {
    vi.useFakeTimers();
    const get = vi.spyOn(api, 'get').mockResolvedValue(scored);
    function Probe({ refreshMs }) { useLiveSleep('probe', { refreshMs }); return null; }
    const list = renderAsAdmin(<Probe refreshMs={null} />);
    await act(async () => {});
    expect(get).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(4 * 60 * 1000); });
    expect(get).toHaveBeenCalledTimes(1);
    list.unmount();
    const detail = renderAsAdmin(<Probe />);
    await act(async () => {});
    expect(get).toHaveBeenCalledTimes(2);
    await act(async () => { vi.advanceTimersByTime(3 * 60 * 1000); });
    expect(get).toHaveBeenCalledTimes(3);
    detail.unmount();
  });
});
