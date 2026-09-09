// The last uncovered handlers: the appearance controls on Settings → General, and the caregiver
// screen's photo + two destructive confirmations.
//
// These are handler-per-control screens, and what makes them worth a test rather than a coverage
// chase is that three of them behave DIFFERENTLY from every other field beside them:
//   * a caregiver's PHOTO saves immediately, with no Save press, while every other field on the same
//     form waits for Save — except on a NEW caregiver, who has no record to save it against yet;
//   * "Reset two-factor" and "Remove caregiver" are the two irreversible actions on the screen and
//     both must be un-dismissable while in flight;
//   * the theme controls write CSS variables live, so a wrong value is visible instantly and a
//     missing one is invisible until someone reloads.
import { describe, test, expect, vi, afterEach } from 'vitest';
import { screen, waitFor, within, fireEvent } from '@testing-library/react';
import { Routes, Route } from 'react-router-dom';
import { renderAsAdmin } from './helpers/render.jsx';
import SettingsGeneral from '../src/pages/SettingsGeneral.jsx';
import UserSettings from '../src/pages/UserSettings.jsx';
import { api } from '../src/lib/api.js';
import * as imageResize from '../src/lib/imageResize.js';

afterEach(() => vi.restoreAllMocks());

// --- Settings → General: appearance -------------------------------------------------------------

describe('Settings → General appearance controls', () => {
  const SETTINGS = {
    app_name: 'Nightlight',
    timezone: 'Australia/Melbourne',
    accent_color: '#f4c56a',
    live_color: '#7FBFA3',
    offline_color: '#E08585',
    font_choice: 'warm-serif',
    temp_unit: 'C',
  };
  const show = () => {
    vi.spyOn(api, 'get').mockResolvedValue(null);
    vi.spyOn(api, 'put').mockResolvedValue({});
    return renderAsAdmin(<SettingsGeneral />, { settings: SETTINGS });
  };

  test('each colour picker shows its current value beside it and saves what you choose', async () => {
    const { user } = show();
    for (const [label, next] of [
      ['Accent (buttons, highlights)', '#112233'],
      ['Live indicator', '#445566'],
      ['Offline / alert', '#778899'],
    ]) {
      const input = screen.getByLabelText(label);
      // The hex is printed next to the swatch — a colour input alone gives no readable value at all.
      // ⚠️ Matched case-insensitively: `<input type="color">` normalises its value to lower case,
      // while the text beside it prints the stored setting verbatim, which is upper case.
      expect(screen.getByText(new RegExp(`^${input.value}$`, 'i'))).toBeInTheDocument();
      fireEvent.change(input, { target: { value: next } });
      expect(screen.getByText(next)).toBeInTheDocument();
    }

    await user.click(screen.getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(api.put).toHaveBeenCalled());
    const body = api.put.mock.calls[0][1];
    expect(body.accent_color).toBe('#112233');
    expect(body.live_color).toBe('#445566');
    expect(body.offline_color).toBe('#778899');
  });

  test('a colour that has never been set falls back to black rather than an invalid value', () => {
    vi.spyOn(api, 'get').mockResolvedValue(null);
    renderAsAdmin(<SettingsGeneral />, { settings: { ...SETTINGS, accent_color: null } });
    // ⚠️ `<input type="color">` silently rejects anything that is not a #rrggbb string, so a null
    // would leave the swatch showing the browser default with no hint that the setting is unset.
    expect(screen.getByLabelText('Accent (buttons, highlights)')).toHaveValue('#000000');
  });

  test('choosing a font marks exactly one option active and saves it', async () => {
    const { user, container } = show();
    const active = () => [...container.querySelectorAll('.font-btn--active')].map((b) => b.textContent);
    expect(active()).toHaveLength(2); // one font + one temperature unit

    // Selected by content, not by position: `.preset-row` is used by more than one group on this
    // page (the colour presets sit in one too), so indexing into it picks a different control
    // depending on what else happens to be on screen.
    const fonts = [...container.querySelectorAll('.font-btn')].filter((b) => !['°C', '°F'].includes(b.textContent));
    expect(fonts.length).toBeGreaterThan(1);
    const other = fonts.find((b) => !b.classList.contains('font-btn--active'));
    await user.click(other);
    expect(other).toHaveClass('font-btn--active');
    // Exactly one, not two — these are a radio group wearing button clothes.
    expect(fonts.filter((b) => b.classList.contains('font-btn--active'))).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(api.put).toHaveBeenCalled());
    expect(api.put.mock.calls[0][1].font_choice).not.toBe('warm-serif');
  });

  test('the temperature unit is a two-way choice and both directions save', async () => {
    const { user } = show();
    const c = screen.getByRole('button', { name: '°C' });
    const f = screen.getByRole('button', { name: '°F' });
    expect(c).toHaveClass('font-btn--active');
    expect(f).not.toHaveClass('font-btn--active');

    await user.click(f);
    expect(f).toHaveClass('font-btn--active');
    expect(c).not.toHaveClass('font-btn--active');
    await user.click(screen.getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(api.put).toHaveBeenCalled());
    // ⚠️ Both directions asserted: this setting decides whether every room-climate reading in the app
    // is Celsius or Fahrenheit, and a one-way test passes against a handler stuck on 'F'.
    expect(api.put.mock.calls[0][1].temp_unit).toBe('F');

    await user.click(c);
    await user.click(screen.getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(2));
    expect(api.put.mock.calls[1][1].temp_unit).toBe('C');
  });
});

// --- the caregiver screen -----------------------------------------------------------------------

describe('UserSettings', () => {
  const CAREGIVER = {
    id: 'u-care',
    username: 'nanny',
    first_name: 'Nanny',
    last_name: 'McPhee',
    role: 'caregiver',
    photo: null,
    mfa_enabled: 0,
  };

  const mount = (id = 'u-care', user = CAREGIVER) => {
    // ⚠️ The page fetches the LIST and finds its user in it — there is no per-user GET. A fixture
    // returning the bare object resolves to a page that never finds anyone and renders a blank form.
    vi.spyOn(api, 'get').mockImplementation((p) =>
      String(p).includes('/auth/users') ? Promise.resolve([user]) : Promise.resolve([])
    );
    vi.spyOn(api, 'put').mockResolvedValue({});
    vi.spyOn(api, 'post').mockResolvedValue({});
    vi.spyOn(api, 'del').mockResolvedValue({});
    return renderAsAdmin(
      <Routes>
        <Route path="/settings/users/:id" element={<UserSettings />} />
        <Route path="/settings/users/new" element={<UserSettings />} />
        <Route path="/settings/users" element={<div>caregivers list</div>} />
      </Routes>,
      { route: `/settings/users/${id}` }
    );
  };

  const pickPhoto = async (container) => {
    const input = container.querySelector('input[type="file"]');
    const file = new File(['x'], 'face.png', { type: 'image/png' });
    await waitFor(() => expect(input).not.toBeNull());
    fireEvent.change(input, { target: { files: [file] } });
  };

  test('a photo on an EXISTING caregiver saves immediately, with no Save press', async () => {
    vi.spyOn(imageResize, 'fileToAvatarDataUrl').mockResolvedValue('data:image/png;base64,AAA');
    const { container } = mount();
    await screen.findByDisplayValue('nanny');
    await pickPhoto(container);

    // ⚠️ Deliberately unlike every other field on this form. A photo is picked from a system dialog
    // that has already felt like a commit, so leaving it pending behind a Save button is where people
    // lose it.
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/auth/users/u-care', { photo: 'data:image/png;base64,AAA' }));
    expect(await screen.findByText('Photo saved ✓')).toBeInTheDocument();
  });

  test('a photo on a NEW caregiver is held until the form is first saved', async () => {
    vi.spyOn(imageResize, 'fileToAvatarDataUrl').mockResolvedValue('data:image/png;base64,BBB');
    const { container } = mount('new');
    await pickPhoto(container);
    // There is no record to attach it to yet, so an immediate PUT would 404.
    await waitFor(() => expect(imageResize.fileToAvatarDataUrl).toHaveBeenCalled());
    expect(api.put).not.toHaveBeenCalled();
  });

  test('a photo that cannot be read surfaces the reason instead of failing silently', async () => {
    vi.spyOn(imageResize, 'fileToAvatarDataUrl').mockRejectedValue(new Error('That image is too large'));
    const { container } = mount();
    await screen.findByDisplayValue('nanny');
    await pickPhoto(container);
    expect(await screen.findByText('That image is too large')).toBeInTheDocument();
  });

  test('a failed photo save says so, and stops claiming to be saving', async () => {
    vi.spyOn(imageResize, 'fileToAvatarDataUrl').mockResolvedValue('data:image/png;base64,AAA');
    const { container } = mount();
    await screen.findByDisplayValue('nanny');
    api.put.mockRejectedValue(new Error('Photo too big for the database'));
    await pickPhoto(container);
    expect(await screen.findByText('Photo too big for the database')).toBeInTheDocument();
    expect(screen.queryByText('Saving photo…')).not.toBeInTheDocument();
  });

  test('choosing no file at all is a no-op', async () => {
    const resize = vi.spyOn(imageResize, 'fileToAvatarDataUrl');
    const { container } = mount();
    await screen.findByDisplayValue('nanny');
    const input = container.querySelector('input[type="file"]');
    // Cancelling the system picker fires change with an empty list; without the guard this throws.
    fireEvent.change(input, { target: { files: [] } });
    expect(resize).not.toHaveBeenCalled();
    expect(api.put).not.toHaveBeenCalled();
  });

  test('removing a caregiver asks first, names them, and returns to the list', async () => {
    const { user } = mount();
    await screen.findByDisplayValue('nanny');
    await user.click(screen.getByRole('button', { name: /Remove caregiver/ }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Nanny McPhee')).toBeInTheDocument();
    expect(api.del).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(api.del).toHaveBeenCalledWith('/auth/users/u-care'));
    expect(await screen.findByText('caregivers list')).toBeInTheDocument();
  });

  test('the remove dialog cannot be dismissed mid-delete', async () => {
    const { user } = mount();
    await screen.findByDisplayValue('nanny');
    let release;
    api.del.mockImplementation(() => new Promise((r) => { release = r; }));
    await user.click(screen.getByRole('button', { name: /Remove caregiver/ }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    release({});
  });

  test('a failed remove keeps the dialog open with the reason', async () => {
    const { user } = mount();
    await screen.findByDisplayValue('nanny');
    api.del.mockRejectedValue(new Error('You cannot remove yourself'));
    await user.click(screen.getByRole('button', { name: /Remove caregiver/ }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove' }));
    expect(await screen.findByText('You cannot remove yourself')).toBeInTheDocument();
  });

  test('resetting two-factor is offered only when they HAVE it, and confirms first', async () => {
    const withoutMfa = mount('u-care', { ...CAREGIVER, mfa_enabled: 0 });
    await screen.findByDisplayValue('nanny');
    expect(screen.queryByRole('button', { name: /Reset two-factor/ })).not.toBeInTheDocument();
    withoutMfa.unmount();

    const { user } = mount('u-care', { ...CAREGIVER, mfa_enabled: 1 });
    await screen.findByDisplayValue('nanny');
    await user.click(screen.getByRole('button', { name: /Reset two-factor/ }));
    const dialog = await screen.findByRole('dialog');
    // ⚠️ This turns OFF someone else's second factor. The confirmation says what it costs them —
    // they will have to set it up again — rather than just asking "are you sure?".
    expect(within(dialog).getByText(/set two-factor up again/)).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });
});
