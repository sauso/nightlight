// #512: NightReview must never SEND a time that was computed in SettingsContext's placeholder timezone.
//
// The bug was found by capturing the REAL PUT body, so these tests do the same, and they use the REAL
// SettingsProvider with a /settings request that resolves late (or fails) instead of hand-flipping a
// `settingsLoaded` prop the way MorningReview.test.jsx's rerenderWith tests do. That matters: the prop
// is the test's own idea of what the provider does; the provider is what the app ships. What is asserted
// is the body handed to `api.put`, never a label on screen: in the original bug the on-screen hint had
// already moved to the real zone while the input (and so the write) still held the placeholder-zone time.
//
// Updated 2026-10-27 for the one-question screen: the only time every save carries is the wake (the others
// are sent only when typed, behind the disclosure), so the journeys below are about the wake and the typed
// times. The original repro's chips and event list no longer exist.
//
// Fixture: a Melbourne install (AEST, UTC+10 on this date, so no DST ambiguity), browser pinned to a
// different zone by vite.config.js (TZ Pacific/Auckland), so a time converted in the BROWSER zone is
// wrong in a way the assertions see. The convention (owner, 2026-10-10): times are shown and entered in
// HOME time, `settings.timezone`, never the browser's and never the 'UTC' placeholder.

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { AuthContext } from '../src/lib/AuthContext.jsx';
import { CamerasContext } from '../src/lib/CamerasContext.jsx';
import { SettingsProvider } from '../src/lib/SettingsContext.jsx';
import NightReview from '../src/pages/NightReview.jsx';
import { api } from '../src/lib/api.js';

// Same reason as MorningReview.test.jsx: a successful save navigates away, which would unmount the
// screen under the assertions. Nothing here asserts on where it goes.
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, useNavigate: () => vi.fn() };
});

const HOME_TZ = 'Australia/Melbourne';
const REAL_SETTINGS = {
  app_name: 'Nightlight', accent_color: '#f4c56a', live_color: '#7FBFA3', offline_color: '#E08585',
  timezone: HOME_TZ, font_choice: 'warm-serif', temp_unit: 'C',
};

// UTC instants as the server stores them; the local wall-clock times in comments are what the person should
// see and what must be sent.
const NIGHT = {
  child_id: 'c-1',
  night_date: '2026-08-29',
  computed: { status: 'ok', onset_at: '2026-08-29 09:33:00', in_bed_at: '2026-08-29 09:20:10', wake_at: '2026-08-29 19:48:00' }, // 19:20 / 19:33 / 05:48
  review: null,
  transitions: [],
};

// 'HH:MM' on the wall clock of `tz` for a stored UTC instant. Written here, independent of NightReview's
// own helper, so the expected values are not computed by the code under test.
const hhmmIn = (utc, tz) => new Intl.DateTimeFormat('en-GB', {
  timeZone: tz, hourCycle: 'h23', hour: '2-digit', minute: '2-digit',
}).format(new Date(`${utc.replace(' ', 'T')}Z`));

let user;
// How /settings behaves for the render: 'late' (a promise the test resolves), 'fail', or 'now'.
function mount({ settings = 'late', night = NIGHT, zone = HOME_TZ } = {}) {
  const real = { ...REAL_SETTINGS, timezone: zone };
  let resolveSettings;
  const settingsPromise = new Promise((resolve) => { resolveSettings = resolve; });
  api.get.mockImplementation((path) => {
    if (path === '/settings') {
      if (settings === 'now') return Promise.resolve(real);
      if (settings === 'fail') return Promise.reject(new Error('offline'));
      return settingsPromise;
    }
    return Promise.resolve(night);
  });
  user = userEvent.setup();
  const view = render(
    <MemoryRouter initialEntries={['/children/c-1/review/2026-08-29']}>
      <AuthContext.Provider value={{ user: { id: 'u-1', role: 'admin' }, loading: false, login: vi.fn(), logout: vi.fn(), refresh: vi.fn() }}>
        <SettingsProvider>
          <CamerasContext.Provider value={{ kids: [{ id: 'c-1', name: 'Child A' }], cameras: [], error: '', refresh: vi.fn() }}>
            <Routes><Route path="/children/:id/review/:date" element={<NightReview />} /></Routes>
          </CamerasContext.Provider>
        </SettingsProvider>
      </AuthContext.Provider>
    </MemoryRouter>
  );
  return { ...view, resolveSettings: () => act(async () => { resolveSettings(real); }) };
}

const lastBody = () => api.put.mock.calls[api.put.mock.calls.length - 1][1];
const thatsRight = () => screen.findByRole('button', { name: /That.s right/ });
const bedtimeToggle = () => screen.getByRole('button', { name: /Change bedtime or fell-asleep time/ });

// The full journey, parameterised by when /settings resolves, so the happy path and the race are compared on
// the SAME steps. `clickEarly` is the race: tap before the zone is known.
async function journey({ settings, clickEarly }) {
  const m = mount({ settings });
  const confirm = await thatsRight();
  if (clickEarly) await user.click(confirm); // disabled: must do nothing
  if (settings === 'late') await m.resolveSettings();
  await waitFor(() => expect(screen.getByRole('button', { name: /That.s right/ })).toBeEnabled());
  await user.click(screen.getByRole('button', { name: /That.s right/ }));
  await waitFor(() => expect(api.put).toHaveBeenCalled());
  const body = lastBody();
  m.unmount();
  return body;
}

beforeEach(() => {
  vi.spyOn(api, 'get');
  vi.spyOn(api, 'put').mockResolvedValue({});
});
afterEach(() => vi.restoreAllMocks());

describe('#512 — the repro, replayed against the real SettingsProvider', () => {
  test('★ "That\'s right" tapped before /settings resolves sends the wake in HOME time, never the placeholder zone\'s', async () => {
    const body = await journey({ settings: 'late', clickEarly: true });
    // The issue's actual damage: a time read in the 'UTC' placeholder went out as 19:48 and was stored as 09:48.
    expect(body.true_wake_local).toBe(hhmmIn(NIGHT.computed.wake_at, HOME_TZ)); // 05:48, not 19:48
    expect(body.true_wake_local).toBe('05:48');
    // And nothing else carries a time: the asleep and in-bed times are not sent unless typed.
    expect(body.true_onset_local).toBeUndefined();
    expect(body.true_in_bed_local).toBeUndefined();
  });

  test('the late and the immediate /settings produce the SAME PUT body (the happy path is unchanged)', async () => {
    api.put.mockClear();
    const late = await journey({ settings: 'late', clickEarly: true });
    api.put.mockClear();
    const now = await journey({ settings: 'now', clickEarly: false });
    expect(late).toEqual(now);
    // And it is not vacuous: the immediate path really does send the home-time value.
    expect(now.true_wake_local).toBe('05:48');
  });

  test('★ a time typed in the disclosure after /settings resolves is sent as typed, and the untouched ones are not sent at all', async () => {
    // The disclosure's fields show the stored times read in the zone that is current when they are drawn, so
    // after the real zone arrives they hold HOME time (19:33, not the placeholder zone's 09:33). Only the one
    // typed is sent.
    const m = mount({ settings: 'late' });
    await thatsRight();
    await user.click(bedtimeToggle());
    expect(screen.getByLabelText(/Fell asleep/)).toBeDisabled(); // before the zone is known
    await m.resolveSettings();
    await waitFor(() => expect(screen.getByLabelText(/Fell asleep/)).toBeEnabled());
    expect(screen.getByLabelText(/Fell asleep/)).toHaveValue(hhmmIn(NIGHT.computed.onset_at, HOME_TZ)); // 19:33, not 09:33
    await user.type(screen.getByLabelText(/In bed/), '19:05');
    await user.click(screen.getByRole('button', { name: /That.s right/ }));
    await waitFor(() => expect(api.put).toHaveBeenCalled());
    expect(lastBody()).toMatchObject({ true_wake_local: '05:48', true_in_bed_local: '19:05' });
    expect(lastBody().true_onset_local).toBeUndefined();
  });

  test('before /settings resolves every control that sends a time is disabled, and a tap sends and changes nothing', async () => {
    mount({ settings: 'late' });
    const confirm = await thatsRight();
    expect(confirm).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Not quite' })).toBeDisabled();
    await user.click(confirm);
    await user.click(screen.getByRole('button', { name: 'Not quite' }));
    // A tap on a disabled button must not even open the time field.
    expect(screen.queryByLabelText(/Got up for the day/)).toBeNull();
    // The question, and so the placeholder zone's time, is not on screen yet; the page says what it waits for.
    expect(screen.queryByText(/Is that right\?/)).toBeNull();
    expect(screen.getByText(/Waiting for the app.s timezone setting/)).toBeInTheDocument();
    expect(screen.queryByText(/could not be loaded/)).toBeNull();
    expect(api.put).not.toHaveBeenCalled();
  });

  test('★ "Not quite" after the zone arrives seeds the field in HOME time, not the placeholder zone\'s', async () => {
    const m = mount({ settings: 'late' });
    await thatsRight();
    await m.resolveSettings();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Not quite' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Not quite' }));
    expect(await screen.findByLabelText(/Got up for the day/)).toHaveValue('05:48');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.put).toHaveBeenCalled());
    expect(lastBody().true_wake_local).toBe('05:48');
  });
});

describe('#512 — the gate is on "settings arrived", not on "the zone is not UTC"', () => {
  test('a UTC install is a real configured zone: once its settings arrive the controls work and send UTC times', async () => {
    // 'UTC' is both the placeholder and a legitimate setting, so the VALUE cannot tell them apart (see
    // SettingsContext's `loaded`). A gate written as `timezone !== 'UTC'` would leave this install greyed out.
    // The same evening as NIGHT but as UTC wall-clock times.
    const night = {
      ...NIGHT,
      computed: { status: 'ok', onset_at: '2026-08-29 19:33:00', in_bed_at: null, wake_at: '2026-08-30 05:48:00' },
    };
    const m = mount({ settings: 'late', zone: 'UTC', night });
    const confirm = await thatsRight();
    expect(confirm).toBeDisabled();
    await m.resolveSettings();
    await waitFor(() => expect(screen.getByRole('button', { name: /That.s right/ })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: /That.s right/ }));
    await waitFor(() => expect(api.put).toHaveBeenCalled());
    expect(lastBody().true_wake_local).toBe('05:48');
  });
});

describe('#512 — /settings FAILS for the whole visit', () => {
  test('★ "That\'s right" cannot send the placeholder-UTC time; the page says what happened and how to recover', async () => {
    mount({ settings: 'fail' });
    const confirm = await thatsRight();
    await screen.findByText(/timezone setting could not be loaded/);
    expect(screen.getByText(/Reload the page to try again/)).toBeInTheDocument();
    expect(screen.queryByText(/Waiting for the app.s timezone setting/)).toBeNull();
    expect(confirm).toBeDisabled();
    await user.click(confirm);
    expect(screen.getByRole('button', { name: 'Not quite' })).toBeDisabled();
    expect(api.put).not.toHaveBeenCalled();
  });

  test('Save stays disabled on a night reopened into its time field, and its fields cannot be edited', async () => {
    mount({
      settings: 'fail',
      night: { ...NIGHT, review: { true_onset_at: '2026-08-29 09:15:00', true_wake_at: '2026-08-29 19:40:00', true_in_bed_at: null, note: null } },
    });
    const save = await screen.findByRole('button', { name: 'Save' });
    await screen.findByText(/timezone setting could not be loaded/);
    expect(save).toBeDisabled();
    expect(screen.getByLabelText(/Got up for the day/)).toBeDisabled();
    // This review holds an asleep time, so the disclosure opened by itself: its fields are shut too.
    for (const label of [/In bed/, /Fell asleep/]) expect(screen.getByLabelText(label)).toBeDisabled();
    await user.click(save);
    expect(api.put).not.toHaveBeenCalled();
  });

  test('what carries no time still works: "No one was in the bed" saves, with no time in the body', async () => {
    mount({ settings: 'fail' });
    await user.click(await screen.findByRole('button', { name: /No one was in the bed/ }));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    expect(lastBody()).toEqual({ nobody_in_bed: true });
  });

  test('the error appears only once the request has settled; while it is in flight the page just waits', async () => {
    mount({ settings: 'late' });
    await screen.findByText(/Waiting for the app.s timezone setting/);
    expect(screen.queryByText(/could not be loaded/)).toBeNull();
  });
});
