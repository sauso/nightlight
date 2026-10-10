// #512: NightReview must never SEND a time that was computed in SettingsContext's placeholder timezone.
//
// The bug was found by capturing the REAL PUT body, so these tests do the same, and they use the REAL
// SettingsProvider with a /settings request that resolves late (or fails) instead of hand-flipping a
// `settingsLoaded` prop the way MorningReview.test.jsx's rerenderWith tests do. That matters: the prop
// is the test's own idea of what the provider does; the provider is what the app ships. What is asserted
// is the body handed to `api.put`, never a label on screen: in the original bug the on-screen hint had
// already moved to the real zone while the input (and so the write) still held the placeholder-zone time.
//
// Fixture: a Melbourne install (AEST, UTC+10 on this date, so no DST ambiguity), browser pinned to a
// different zone by vite.config.js (TZ Pacific/Auckland), so a time converted in the BROWSER zone is
// wrong in a way the assertions see. The convention (owner, 2026-10-10): times are shown and entered in
// HOME time, `settings.timezone`, never the browser's and never the 'UTC' placeholder.

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within, act } from '@testing-library/react';
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

// The two rows of the issue's table, as one night. UTC instants as the server stores them; the local
// wall-clock times in comments are what the person should see and what must be sent.
const NIGHT = {
  child_id: 'c-1',
  night_date: '2026-08-29',
  computed: { status: 'ok', onset_at: '2026-08-29 09:33:00', wake_at: '2026-08-29 19:48:00' }, // 19:33 / 05:48
  review: null,
  transitions: [
    { id: 41, type: 'into_bed', created_at: '2026-08-29 09:20:10', snapshot: 1, verdict: null, camera_name: 'Bedroom' }, // 19:20:10
    { id: 42, type: 'out_of_bed', created_at: '2026-08-29 19:48:30', snapshot: 1, verdict: null, camera_name: 'Bedroom' }, // 05:48:30
  ],
};

// 'HH:MM' on the wall clock of `tz` for a stored UTC instant. Written here, independent of NightReview's
// own helper, so the expected values are not computed by the code under test.
const hhmmIn = (utc, tz) => new Intl.DateTimeFormat('en-GB', {
  timeZone: tz, hourCycle: 'h23', hour: '2-digit', minute: '2-digit',
}).format(new Date(`${utc.replace(' ', 'T')}Z`));

const row = (id) => document.querySelector(`.review-event img[src*="/bed-transitions/${id}/"]`)?.closest('.review-event');

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

const openEvents = async () => user.click(await screen.findByRole('button', { name: /recorded events/ }));
const chip = (id, name) => within(row(id)).getByRole('button', { name });
const lastBody = () => api.put.mock.calls[api.put.mock.calls.length - 1][1];
const saveReview = async () => {
  await user.click(screen.getByRole('button', { name: /Save review/ }));
  await waitFor(() => expect(api.put).toHaveBeenCalled());
  return lastBody();
};

// The full user journey of the issue, parameterised by when /settings resolves, so the happy path and the
// race are compared on the SAME steps. `clickEarly` is the race: tap the chip before the zone is known.
async function journey({ settings, chipRow, chipName, clickEarly }) {
  const m = mount({ settings });
  await openEvents();
  await waitFor(() => expect(row(chipRow)).toBeTruthy());
  if (clickEarly) await user.click(chip(chipRow, chipName)); // disabled: must do nothing
  if (settings === 'late') await m.resolveSettings();
  await waitFor(() => expect(chip(chipRow, chipName)).toBeEnabled());
  await user.click(chip(chipRow, chipName));
  const body = await saveReview();
  m.unmount();
  return body;
}

beforeEach(() => {
  vi.spyOn(api, 'get');
  vi.spyOn(api, 'put').mockResolvedValue({});
  vi.spyOn(api, 'url').mockImplementation((p) => `/api${p}?token=t`);
});
afterEach(() => vi.restoreAllMocks());

describe('#512 — the issue\'s two repro rows, replayed against the real SettingsProvider', () => {
  test('★ row 1: "Put down here" tapped before /settings resolves — every time sent is in HOME time, none in UTC', async () => {
    const body = await journey({ settings: 'late', chipRow: 41, chipName: /Put down here/, clickEarly: true });
    // The tapped moment: the frame wins on the server, the typed value is the frame's local time.
    expect(body.true_in_bed_transition_id).toBe(41);
    expect(body.true_in_bed_local).toBe(hhmmIn('2026-08-29 09:20:10', HOME_TZ)); // 19:20, not the placeholder-zone 09:20
    // The UNCLICKED fields — the issue's actual damage: wake went out as '19:48' (UTC) and was stored as 09:48.
    expect(body.true_onset_local).toBe(hhmmIn(NIGHT.computed.onset_at, HOME_TZ)); // 19:33, not 09:33
    expect(body.true_wake_local).toBe(hhmmIn(NIGHT.computed.wake_at, HOME_TZ)); // 05:48, not 19:48
    expect([body.true_in_bed_local, body.true_onset_local, body.true_wake_local]).toEqual(['19:20', '19:33', '05:48']);
  });

  test('★ row 2: "Up for the day here" tapped before /settings resolves — onset is not left at 09:33', async () => {
    const body = await journey({ settings: 'late', chipRow: 42, chipName: /Up for the day here/, clickEarly: true });
    expect(body.true_wake_transition_id).toBe(42);
    expect(body.true_wake_local).toBe('05:48');
    // The issue: onset 09:33 stored as 23:33, AFTER the wake it was paired with.
    expect(body.true_onset_local).toBe('19:33');
    expect(body.true_in_bed_local).toBeUndefined(); // untouched in-bed is never sent
  });

  test('the late and the immediate /settings produce the SAME PUT body (the happy path is unchanged)', async () => {
    for (const [chipRow, chipName] of [[41, /Put down here/], [41, /Asleep here/], [42, /Up for the day here/]]) {
      api.put.mockClear();
      const late = await journey({ settings: 'late', chipRow, chipName, clickEarly: true });
      api.put.mockClear();
      const now = await journey({ settings: 'now', chipRow, chipName, clickEarly: false });
      expect(late).toEqual(now);
      // And it is not vacuous: the immediate path really does send the home-time values.
      expect(now.true_wake_local).toBe('05:48');
    }
  });

  test('before /settings resolves the chips are disabled and a tap on one sends and changes nothing', async () => {
    mount({ settings: 'late' });
    await openEvents();
    await waitFor(() => expect(row(41)).toBeTruthy());
    for (const [id, name] of [[41, /Put down here/], [41, /Asleep here/], [42, /Up for the day here/]]) {
      expect(chip(id, name)).toBeDisabled();
      await user.click(chip(id, name));
      expect(chip(id, name)).toHaveAttribute('aria-pressed', 'false');
    }
    // A tap on a disabled chip must not even open the edit card (it is what set `touched` in the bug).
    expect(screen.queryByLabelText(/Fell asleep/)).toBeNull();
    expect(screen.getByRole('button', { name: /That.s right/ })).toBeDisabled();
    expect(screen.getByText(/Waiting for the app.s timezone setting/)).toBeInTheDocument();
    expect(screen.queryByText(/could not be loaded/)).toBeNull();
    expect(api.put).not.toHaveBeenCalled();
  });
});

describe('#512 — the gate is on "settings arrived", not on "the zone is not UTC"', () => {
  test('a UTC install is a real configured zone: once its settings arrive the controls work and send UTC times', async () => {
    // 'UTC' is both the placeholder and a legitimate setting, so the VALUE cannot tell them apart (see
    // SettingsContext's `loaded`). A gate written as `timezone !== 'UTC'` would leave this install greyed out.
    // The same evening as NIGHT but as UTC wall-clock times (19:20 put-down), so nothing lands in the
    // 'Before bedtime' group that a 09:20 UTC put-down would, correctly, fall into.
    const night = {
      ...NIGHT,
      computed: { status: 'ok', onset_at: '2026-08-29 19:33:00', wake_at: '2026-08-30 05:48:00' },
      transitions: [
        { ...NIGHT.transitions[0], created_at: '2026-08-29 19:20:10' },
        { ...NIGHT.transitions[1], created_at: '2026-08-30 05:48:30' },
      ],
    };
    const m = mount({ settings: 'late', zone: 'UTC', night });
    await openEvents();
    await waitFor(() => expect(row(41)).toBeTruthy());
    expect(chip(41, /Put down here/)).toBeDisabled();
    await m.resolveSettings();
    await waitFor(() => expect(chip(41, /Put down here/)).toBeEnabled());
    await user.click(chip(41, /Put down here/));
    const body = await saveReview();
    expect([body.true_in_bed_local, body.true_onset_local, body.true_wake_local]).toEqual(['19:20', '19:33', '05:48']);
  });
});

describe('#512 — /settings FAILS for the whole visit', () => {
  test('★ "That\'s right" cannot send the placeholder-UTC times; the page says what happened and how to recover', async () => {
    mount({ settings: 'fail' });
    const thatsRight = await screen.findByRole('button', { name: /That.s right/ });
    await screen.findByText(/timezone setting could not be loaded/);
    expect(screen.getByText(/Reload the page to try again/)).toBeInTheDocument();
    expect(screen.queryByText(/Waiting for the app.s timezone setting/)).toBeNull();
    expect(thatsRight).toBeDisabled();
    await user.click(thatsRight);
    expect(screen.getByRole('button', { name: /Not quite/ })).toBeDisabled();
    expect(api.put).not.toHaveBeenCalled();
  });

  test('Save stays disabled on a night reopened into its times, and its fields cannot be edited', async () => {
    mount({
      settings: 'fail',
      night: { ...NIGHT, review: { true_onset_at: '2026-08-29 09:15:00', true_wake_at: null, true_in_bed_at: null, note: null } },
    });
    const save = await screen.findByRole('button', { name: /Save review/ });
    await screen.findByText(/timezone setting could not be loaded/);
    expect(save).toBeDisabled();
    for (const label of [/In bed/, /Fell asleep/, /Got up for the day/]) expect(screen.getByLabelText(label)).toBeDisabled();
    await user.click(save);
    expect(api.put).not.toHaveBeenCalled();
  });

  test('what carries no time still works: an event answer saves, with no time in the body', async () => {
    mount({ settings: 'fail' });
    await openEvents();
    await waitFor(() => expect(row(41)).toBeTruthy());
    await user.click(within(row(41)).getByRole('button', { name: 'Yes', exact: true }));
    await user.click(screen.getByRole('button', { name: /Save just the event answers/ }));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    const body = lastBody();
    expect(body.verdicts).toMatchObject({ 41: 'correct' });
    for (const key of ['true_onset_local', 'true_wake_local', 'true_in_bed_local', 'true_onset_transition_id', 'true_wake_transition_id']) {
      expect(body[key], key).toBeUndefined();
    }
  });

  test('the error appears only once the request has settled; while it is in flight the page just waits', async () => {
    mount({ settings: 'late' });
    await screen.findByText(/Waiting for the app.s timezone setting/);
    expect(screen.queryByText(/could not be loaded/)).toBeNull();
  });
});
