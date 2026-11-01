// Your own account: display name, password, theme, sessions — and the two-factor section.
//
// ★ WHY UNITS RATHER THAN MORE e2e. The e2e suite already enrols and un-enrols two-factor against a
// real server. What it cannot cheaply reach is the set of states this screen can get into when
// something goes WRONG, and those are where the damage is:
//
//   * the confirm-password check is CLIENT-SIDE ONLY. Nothing on the server compares the two boxes,
//     so if that check were dropped, a typo in "Confirm new password" would silently set the
//     password to whatever was in "New password" — and the person would be locked out at the next
//     login with no idea why.
//   * the backup codes are shown EXACTLY ONCE. Any path that loses them loses the account-recovery
//     mechanism, and nothing later can tell you it happened.
//   * signing out the session you are currently using has to log you out locally too, or the app
//     sits on a dead screen 401-ing every request.
//
// ⚠️ Deliberately NOT covered here: the avatar upload. It goes through `imageResize.js`, which is
// canvas — jsdom's canvas is a stub, so a test of it would be a test of the stub. It is excluded from
// coverage for the same reason and is exercised by the Playwright suite.
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { renderAs, ADMIN, enabledButton } from './helpers/render.jsx';
import Account from '../src/pages/Account.jsx';
import ThemeToggle from '../src/components/ThemeToggle.jsx';
import TwoFactorSection from '../src/components/TwoFactorSection.jsx';
import { api } from '../src/lib/api.js';
import { isReloadHeld } from '../src/lib/reloadGuard.js';
import * as nativeBridge from '../src/lib/nativeBridge.js';
import { setTheme } from '../src/lib/theme.js';

const USER = { ...ADMIN, first_name: 'Nacho', last_name: 'Leone', photo: null };

// Naive UTC datetimes, exactly as the API sends them (no timezone marker — the screen appends 'Z').
const agoIso = (ms) => new Date(Date.now() - ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
// ⚠️ THE SECOND ONE IS 3 HOURS OLD, NOT 2 DAYS, AND THAT IS THE WHOLE POINT. This suite runs on
// Pacific/Auckland, so misparsing a naive UTC timestamp as local shifts it by 12–13 hours — and at
// DAY granularity a 12-hour error is invisible: 2 days and 2 days 12 hours both floor to "2d ago".
// A mutant that dropped the 'Z' survived the whole suite against a 2-day fixture. At hour
// granularity the same mutant turns "3h ago" into "15h ago" and dies. Pick fixtures by working out
// what the failure would look like, not by picking a value that feels representative.
const SESSIONS = [
  { id: 's1', device: 'Chrome on Windows', is_current: true, last_seen_at: agoIso(20 * 1000) },
  { id: 's2', device: 'Safari on iPhone', is_current: false, last_seen_at: agoIso(3 * 3600 * 1000) },
];

let putSpy;
let delSpy;
let postSpy;

function mockAccount({ sessions = SESSIONS, mfa = { enabled: false, backup_codes_remaining: 0 } } = {}) {
  vi.spyOn(api, 'get').mockImplementation((path) => {
    if (path === '/auth/sessions') return Promise.resolve(sessions);
    if (path === '/auth/me/mfa') return Promise.resolve(mfa);
    return Promise.resolve(null);
  });
  putSpy = vi.spyOn(api, 'put').mockResolvedValue({});
  postSpy = vi.spyOn(api, 'post').mockResolvedValue({});
  delSpy = vi.spyOn(api, 'del').mockResolvedValue({});
}

const mountAccount = (user = USER) => renderAs(user, <Account />, { route: '/account' });

afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------------------------------------
describe('your photo', () => {
  // #855: the 2 s timer that blanks "Saved ✓" used to run on after the page had gone (see childSettings.test.jsx).
  test('★ #855: leaving the page cancels the "Saved" timer', async () => {
    mockAccount();
    const setSpy = vi.spyOn(globalThis, 'setTimeout');
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    const { user, unmount } = mountAccount({ ...USER, photo: 'data:image/png;base64,AAA' });
    await user.click(await screen.findByRole('button', { name: 'Remove' }));
    await screen.findByText('Saved ✓');
    const ids = setSpy.mock.calls.flatMap((c, i) => (c[1] === 2000 ? [setSpy.mock.results[i].value] : []));
    expect(ids).toHaveLength(1);
    expect(clearSpy).not.toHaveBeenCalledWith(ids[0]);
    unmount();
    expect(clearSpy).toHaveBeenCalledWith(ids[0]);
  });

  // The other way in (Codex review of #858): the page closes while the save is still in flight.
  test('★ #855: a save that finishes after the page is gone starts no "Saved" timer', async () => {
    mockAccount();
    const setSpy = vi.spyOn(globalThis, 'setTimeout');
    let finish;
    putSpy.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const { user, unmount } = mountAccount({ ...USER, photo: 'data:image/png;base64,AAA' });
    await user.click(await screen.findByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(putSpy).toHaveBeenCalled());
    unmount();
    finish({});
    await new Promise((resolve) => setTimeout(resolve, 20)); // let the save's continuation run
    expect(setSpy.mock.calls.filter((c) => c[1] === 2000)).toHaveLength(0);
  });
});

describe('your display name', () => {
  beforeEach(() => mockAccount());

  test('is loaded from the signed-in user', async () => {
    mountAccount();
    expect((await screen.findByLabelText('First name')).value).toBe('Nacho');
    expect(screen.getByLabelText('Last name').value).toBe('Leone');
  });

  test('★★ arrives even when the user does, a moment AFTER first paint', async () => {
    // AuthContext resolves asynchronously, so this screen genuinely renders once with no user at all.
    // Without the effect that syncs the form when `user` lands, the boxes stay empty — and then the
    // very next Save writes those blanks over the real name. Same shape as the context value that
    // destroyed a user's typing once before, which is why the render helper can reproduce it.
    const { rerenderWith } = renderAs(null, <Account />, { route: '/account' });
    expect(screen.getByLabelText('First name').value, 'nothing to show yet').toBe('');

    rerenderWith({ user: USER });
    await waitFor(() => expect(screen.getByLabelText('First name').value).toBe('Nacho'));
    expect(screen.getByLabelText('Last name').value).toBe('Leone');
  });

  test('saves both names and refreshes the signed-in user', async () => {
    // The refresh is what updates the header, the account row and every avatar; without it the app
    // keeps showing the old name until a reload.
    const { user, auth } = mountAccount();
    const first = await screen.findByLabelText('First name');
    await user.clear(first);
    await user.type(first, 'Ignacio');
    await user.click(screen.getByRole('button', { name: /Save/ }));

    await waitFor(() => expect(putSpy).toHaveBeenCalledWith('/auth/me', { first_name: 'Ignacio', last_name: 'Leone' }));
    await waitFor(() => expect(auth.refresh).toHaveBeenCalled());
  });

  // #855: the name's "Saved ✓" blanked itself with a bare setTimeout that nothing cancelled (now useLater).
  test('★ #855: leaving the page cancels the name "Saved" timer', async () => {
    const setSpy = vi.spyOn(globalThis, 'setTimeout');
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    const { user, unmount } = mountAccount();
    await user.click(await screen.findByRole('button', { name: /Save/ }));
    await screen.findByText('Saved ✓');
    // The 2 s timers this screen started (no photo is saved here, so the name's is the only one).
    const ids = setSpy.mock.calls.flatMap((c, i) => (c[1] === 2000 ? [setSpy.mock.results[i].value] : []));
    expect(ids).toHaveLength(1);
    expect(clearSpy).not.toHaveBeenCalledWith(ids[0]);
    unmount();
    expect(clearSpy).toHaveBeenCalledWith(ids[0]);
  });

  test('a failed save says why', async () => {
    putSpy = vi.spyOn(api, 'put').mockRejectedValue(new Error('Name is too long'));
    const { user } = mountAccount();
    await user.click(await screen.findByRole('button', { name: /Save/ }));
    expect(await screen.findByText('Name is too long')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------------------------
describe('★★ changing your own password', () => {
  beforeEach(() => mockAccount());

  async function openForm(user) {
    await user.click(await screen.findByRole('button', { name: 'Change my password' }));
    return screen.findByLabelText('Current password');
  }

  const fill = async (user, { current = 'oldpassword', next = 'newpassword1', confirm = 'newpassword1' }) => {
    await user.type(screen.getByLabelText('Current password'), current);
    await user.type(screen.getByLabelText('New password'), next);
    await user.type(screen.getByLabelText('Confirm new password'), confirm);
    await user.click(screen.getByRole('button', { name: 'Update password' }));
  };

  test('sends the current and new password, and nothing else', async () => {
    const { user } = mountAccount();
    await openForm(user);
    await fill(user, {});

    await waitFor(() => expect(putSpy).toHaveBeenCalledWith('/auth/me/password', {
      current_password: 'oldpassword', new_password: 'newpassword1',
    }));
  });

  test('★★ a mismatched confirmation is caught HERE, before anything is sent', async () => {
    // THE test in this file. The server never sees the confirmation box, so this check is the only
    // thing standing between a typo and a password nobody knows. If it were removed, the request
    // would succeed, the screen would say it worked, and the account would be locked at next login.
    const { user } = mountAccount();
    await openForm(user);
    await fill(user, { next: 'newpassword1', confirm: 'newpassword2' });

    expect(await screen.findByText("New passwords don't match")).toBeTruthy();
    expect(putSpy, 'nothing may reach the server on a mismatch').not.toHaveBeenCalled();
  });

  test('a mismatch leaves the form filled in so it can be corrected', async () => {
    // Clearing the boxes on a typo would mean retyping all three, which is how people end up
    // choosing a weaker password.
    const { user } = mountAccount();
    await openForm(user);
    await fill(user, { next: 'newpassword1', confirm: 'newpassword2' });
    await screen.findByText("New passwords don't match");
    expect(screen.getByLabelText('Current password').value).toBe('oldpassword');
  });

  test('★ a successful change closes the form and confirms it', async () => {
    // Closing is what takes the live credential off the screen, and the banner is the only feedback
    // that the change actually took — the form simply vanishing would read as a dismissal.
    // (The boxes are blanked on OPEN as well, so asserting they are empty after reopening would pass
    // whether or not the successful save cleared anything. Closing is the observable part.)
    const { user } = mountAccount();
    await openForm(user);
    await fill(user, {});

    expect(await screen.findByText('Password updated ✓')).toBeTruthy();
    await waitFor(() => expect(screen.queryByLabelText('Current password')).toBeNull());
  });

  test('a wrong current password is reported without claiming success', async () => {
    putSpy = vi.spyOn(api, 'put').mockRejectedValue(new Error('Current password is incorrect'));
    const { user } = mountAccount();
    await openForm(user);
    await fill(user, {});

    expect(await screen.findByText('Current password is incorrect')).toBeTruthy();
    expect(screen.queryByText('Password updated ✓')).toBeNull();
  });

  test('all three boxes are real password fields', async () => {
    const { user } = mountAccount();
    await openForm(user);
    for (const label of ['Current password', 'New password', 'Confirm new password']) {
      expect(screen.getByLabelText(label).type, `${label} must not be readable on screen`).toBe('password');
    }
  });
});

// ---------------------------------------------------------------------------------------------
describe('your sessions', () => {
  beforeEach(() => mockAccount());

  test('★ are listed with when they were last seen, read as UTC', async () => {
    // Same naive-timestamp assumption as the user-management screen: the API sends a SQLite datetime
    // with no timezone marker and the screen appends 'Z'. Under this suite's Pacific/Auckland clock,
    // dropping that 'Z' turns "3h ago" into "15h ago" — see the fixture note above for why the age
    // had to be measured in hours for this assertion to be able to fail at all.
    mountAccount();
    const row = (await screen.findByText(/Safari on iPhone/)).closest('.list-row');
    expect(within(row).getByText('Active 3h ago')).toBeTruthy();
  });

  test('the one you are using is marked', async () => {
    mountAccount();
    expect(await screen.findByText(/Chrome on Windows.*this device/)).toBeTruthy();
  });

  test('signing out another device just refreshes the list', async () => {
    const { user, auth } = mountAccount();
    const row = (await screen.findByText(/Safari on iPhone/)).closest('.list-row');
    await user.click(within(row).getByRole('button', { name: 'Sign out' }));

    await waitFor(() => expect(delSpy).toHaveBeenCalledWith('/auth/sessions/s2'));
    expect(auth.logout).not.toHaveBeenCalled();
  });

  test('★ signing out THIS device asks first, and does nothing if you decline', async () => {
    // ⚠️ This is the app's one remaining browser confirm(), against the house rule that says use the
    // in-app Modal. It is pinned here rather than left untested — but the behaviour worth protecting
    // is that declining is honoured, whatever the dialog is made of.
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { user, auth } = mountAccount();
    const row = (await screen.findByText(/Chrome on Windows/)).closest('.list-row');
    await user.click(within(row).getByRole('button', { name: 'Sign out' }));

    expect(confirmSpy).toHaveBeenCalled();
    expect(delSpy).not.toHaveBeenCalled();
    expect(auth.logout).not.toHaveBeenCalled();
  });

  test('★ accepting ends the session AND logs you out locally', async () => {
    // The session is gone server-side, so staying signed in locally would leave every request
    // 401-ing on a screen that still looks logged in.
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { user, auth } = mountAccount();
    const row = (await screen.findByText(/Chrome on Windows/)).closest('.list-row');
    await user.click(within(row).getByRole('button', { name: 'Sign out' }));

    await waitFor(() => expect(delSpy).toHaveBeenCalledWith('/auth/sessions/s1'));
    await waitFor(() => expect(auth.logout).toHaveBeenCalled());
  });
});

// ---------------------------------------------------------------------------------------------
describe('the theme picker', () => {
  beforeEach(() => mockAccount());

  test('offers all three choices and marks the active one', async () => {
    // "System" is the third state and the default; without it there is no way back to following the
    // device once a choice has been made.
    mountAccount();
    const group = await screen.findByRole('group', { name: 'Theme' });
    for (const label of ['Light', 'Dark', 'System']) {
      expect(within(group).getByRole('button', { name: label })).toBeTruthy();
    }
  });

  test('★ choosing one applies immediately and is remembered per device', async () => {
    // Per device, not per account: it is a display preference, and it is written to localStorage
    // rather than sent to the server. A save button here would be wrong, and so would a round trip.
    const { user } = mountAccount();
    const group = await screen.findByRole('group', { name: 'Theme' });
    await user.click(within(group).getByRole('button', { name: 'Dark' }));

    await waitFor(() => expect(document.documentElement.getAttribute('data-theme')).toBe('dark'));
    expect(localStorage.getItem('nightlight_theme')).toBe('dark');
    expect(putSpy, 'a per-device preference is not account state').not.toHaveBeenCalled();
  });

  test('Appearance follows a change from the Live toggle', async () => {
    setTheme('light');
    // Mount the publisher explicitly to check Account's subscription in the same tree.
    const { user } = renderAs(USER, <><Account /><ThemeToggle /></>, { route: '/account' });
    const group = await screen.findByRole('group', { name: 'Theme' });
    expect(within(group).getByRole('button', { name: 'Light' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: 'Switch to dark mode' }));
    expect(within(group).getByRole('button', { name: 'Dark' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(group).getByRole('button', { name: 'Light' })).toHaveAttribute('aria-pressed', 'false');
  });
});

// ---------------------------------------------------------------------------------------------
describe('two-factor authentication', () => {
  const mountMfa = (mfa) => {
    vi.spyOn(api, 'get').mockResolvedValue(mfa);
    postSpy = vi.spyOn(api, 'post').mockResolvedValue({});
    return renderAs(USER, <TwoFactorSection />, { route: '/account' });
  };

  const SETUP = { secret: 'JBSWY3DPEHPK3PXP', otpauth_uri: 'otpauth://totp/x', qr: 'data:image/png;base64,iVBOR' };
  const CODES = ['1111-1111', '2222-2222', '3333-3333', '4444-4444'];

  // Every set-up entry point asks for the account password first (review of #765). Opens the step from the
  // card button, types the password and continues; the set-up panel is the result (wait for it, not for "a
  // dialog": the password step is a dialog too).
  const startThroughPassword = async (user, button = 'Set up two-factor', password = 'hunter22') => {
    await user.click(await enabledButton(button));
    const step = await screen.findByRole('dialog');
    await user.type(within(step).getByLabelText('Password'), password);
    await user.click(within(step).getByRole('button', { name: 'Continue' }));
  };

  test('off, it offers to set two-factor up', async () => {
    mountMfa({ enabled: false, backup_codes_remaining: 0 });
    expect(await screen.findByRole('button', { name: 'Set up two-factor' })).toBeTruthy();
    expect(screen.getByText('Off')).toBeTruthy();
  });

  test('on, it says how many backup codes are left', async () => {
    // The count is the whole point of showing anything here: backup codes are single-use, and
    // running out without noticing means the next lost phone is a locked account.
    mountMfa({ enabled: true, backup_codes_remaining: 3 });
    expect(await screen.findByText('3 backup codes left')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Turn off two-factor' })).toBeTruthy();
  });

  test('one code left is not pluralised', async () => {
    mountMfa({ enabled: true, backup_codes_remaining: 1 });
    expect(await screen.findByText('1 backup code left')).toBeTruthy();
  });

  test('★ the set-up button waits until the status is known', async () => {
    // `disabled={busy || !status}`: starting an enrolment before the current state is known could
    // offer to set up two-factor on an account that already has it.
    let resolveStatus;
    vi.spyOn(api, 'get').mockReturnValue(new Promise((r) => { resolveStatus = r; }));
    renderAs(USER, <TwoFactorSection />, { route: '/account' });
    expect(screen.getByRole('button', { name: 'Set up two-factor' }).disabled).toBe(true);
    resolveStatus({ enabled: false, backup_codes_remaining: 0 });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Set up two-factor' }).disabled).toBe(false));
  });

  test('★ enrolling shows the QR AND the manual key', async () => {
    // Both, not either: the QR is unusable when the authenticator app is on the same device as the
    // browser, which is exactly the case on a phone.
    const { user } = mountMfa({ enabled: false, backup_codes_remaining: 0 });
    postSpy.mockResolvedValue(SETUP);
    await startThroughPassword(user);

    await screen.findByAltText('Two-factor setup QR code');
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByAltText('Two-factor setup QR code').src).toBe(SETUP.qr);
    expect(within(dialog).getByText('JBSWY3DPEHPK3PXP')).toBeTruthy();
  });

  test('the confirmation code is trimmed before it is sent', async () => {
    // A code copied out of an authenticator app very often carries a trailing space; sending it
    // unmodified fails as "invalid", which reads as the app being wrong rather than the paste.
    const { user } = mountMfa({ enabled: false, backup_codes_remaining: 0 });
    postSpy.mockResolvedValue(SETUP);
    await startThroughPassword(user);
    // Let the set-up request settle (the dialog is its result) BEFORE swapping the mock for the next step;
    // re-mocking while it is in flight hands the NEXT step's answer to the first call on a slow run (#570).
    await screen.findByLabelText(/Enter the 6-digit code/);
    postSpy.mockResolvedValue({ backup_codes: CODES });

    await user.type(await screen.findByLabelText(/Enter the 6-digit code/), ' 123456 ');
    await user.click(screen.getByRole('button', { name: 'Turn on' }));
    await waitFor(() => expect(postSpy).toHaveBeenCalledWith('/auth/me/mfa/enable', { code: '123456' }));
  });

  test('★★ the backup codes are shown once, with a warning that says so', async () => {
    // They are the account-recovery mechanism and the server will not show them again. A dialog that
    // dismissed itself, or a warning that did not make the "once" explicit, would leave people with
    // no way back into their own account after a lost phone.
    const { user } = mountMfa({ enabled: false, backup_codes_remaining: 0 });
    postSpy.mockResolvedValue(SETUP);
    await startThroughPassword(user);
    // Let the set-up request settle (the dialog is its result) BEFORE swapping the mock for the next step;
    // re-mocking while it is in flight hands the NEXT step's answer to the first call on a slow run (#570).
    await screen.findByLabelText(/Enter the 6-digit code/);
    postSpy.mockResolvedValue({ backup_codes: CODES });
    await user.type(await screen.findByLabelText(/Enter the 6-digit code/), '123456');
    await user.click(screen.getByRole('button', { name: 'Turn on' }));

    // Wait for a CODE, not for "a dialog": the set-up dialog is still on screen when "Turn on" is clicked,
    // so `findByRole('dialog')` returns it at once and the codes are read before the response lands (#570).
    await screen.findByText(CODES[0]);
    const dialog = screen.getByRole('dialog');
    for (const code of CODES) expect(within(dialog).getByText(code)).toBeTruthy();
    expect(within(dialog).getByText(/won.{0,3}t be shown again/i)).toBeTruthy();
    expect(within(dialog).getByText(/once/i)).toBeTruthy();
  });

  test('a rejected code keeps the enrolment open rather than starting over', async () => {
    // Losing the dialog would mean a fresh secret, re-scanning the QR, and re-adding the entry in
    // the authenticator app — all because of one mistyped digit.
    const { user } = mountMfa({ enabled: false, backup_codes_remaining: 0 });
    postSpy.mockResolvedValue(SETUP);
    await startThroughPassword(user);
    // Let the set-up request settle (the dialog is its result) BEFORE swapping the mock for the next step;
    // re-mocking while it is in flight hands the NEXT step's answer to the first call on a slow run (#570).
    await screen.findByLabelText(/Enter the 6-digit code/);
    postSpy.mockRejectedValue(new Error('That code is not valid'));

    await user.type(await screen.findByLabelText(/Enter the 6-digit code/), '000000');
    await user.click(screen.getByRole('button', { name: 'Turn on' }));

    expect(await screen.findByText('That code is not valid')).toBeTruthy();
    expect(screen.getByLabelText(/Enter the 6-digit code/), 'still enrolling').toBeTruthy();
  });

  test('★ the page may not reload itself while the set-up panel is open, and may again once it is closed (#765)', async () => {
    const { user } = mountMfa({ enabled: false, backup_codes_remaining: 0 });
    postSpy.mockResolvedValue(SETUP);
    expect(isReloadHeld()).toBe(false);
    await startThroughPassword(user);
    await screen.findByLabelText(/Enter the 6-digit code/);
    expect(isReloadHeld()).toBe(true);

    await user.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByLabelText(/Enter the 6-digit code/)).toBeNull());
    expect(isReloadHeld()).toBe(false);
  });

  test('a pending set-up offers Continue set-up and Start over instead of Set up two-factor (#765)', async () => {
    mountMfa({ enabled: false, backup_codes_remaining: 0, setup_pending: true });
    expect(await enabledButton('Continue set-up')).toBeTruthy();
    expect(await enabledButton('Start over')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Set up two-factor' })).toBeNull();
  });

  // Review of #765 (owner's decision): the server answers every set-up call only with the account password, so
  // each entry point asks for it BEFORE calling set-up, and sends it. FAILS on a passwordless entry point: it
  // posted on the first tap, without the password.
  test.each([
    ['Set up two-factor', false, { password: 'hunter22' }],
    ['Continue set-up', true, { password: 'hunter22' }],
    ['Start over', true, { restart: true, password: 'hunter22' }],
  ])('★ %s asks for the password first, then sends it', async (button, pending, body) => {
    const { user } = mountMfa({ enabled: false, backup_codes_remaining: 0, setup_pending: pending });
    postSpy.mockResolvedValue(pending && button === 'Continue set-up' ? { ...SETUP, resumed: true } : SETUP);
    await user.click(await enabledButton(button));
    const step = await screen.findByRole('dialog');
    const pw = within(step).getByLabelText('Password');
    expect(pw.type).toBe('password');
    expect(pw.required).toBe(true);
    expect(postSpy, 'set-up was called before the password was asked for').not.toHaveBeenCalled();
    await user.type(pw, 'hunter22');
    await user.click(within(step).getByRole('button', { name: 'Continue' }));
    await screen.findByLabelText(/Enter the 6-digit code/);
    expect(postSpy).toHaveBeenCalledTimes(1);
    expect(postSpy).toHaveBeenCalledWith('/auth/me/mfa/setup', body);
    expect(screen.getByText(SETUP.secret)).toBeTruthy();
    expect(screen.queryByLabelText('Password'), 'the password step stayed open over the set-up').toBeNull();
  });

  test.each([['Set up two-factor', false], ['Continue set-up', true], ['Start over', true]])(
    'a wrong password on %s shows the message beside the field and keeps the step open (#765)',
    async (button, pending) => {
      const { user } = mountMfa({ enabled: false, backup_codes_remaining: 0, setup_pending: pending });
      postSpy.mockRejectedValue(new Error('Password is incorrect'));
      await user.click(await enabledButton(button));
      const step = await screen.findByRole('dialog');
      await user.type(within(step).getByLabelText('Password'), 'wrong');
      await user.click(within(step).getByRole('button', { name: 'Continue' }));

      expect(await within(step).findByText('Password is incorrect')).toBeTruthy();
      expect(within(step).getByLabelText('Password'), 'the step closed on a wrong password').toBeTruthy();
      expect(screen.queryByLabelText(/Enter the 6-digit code/), 'the set-up opened without a key').toBeNull();
    },
  );

  // Review of #765: the pending set-up was discarded elsewhere (an admin reset, a password change on another
  // device), so "Continue set-up" got a NEW key, without `resumed`. FAILS without the notice: the panel looked
  // exactly like a continued set-up, and the code from the old entry could never match.
  test('Continue set-up that gets a new key (no `resumed`) says so in the panel; a real continue and a first start do not', async () => {
    const NOTICE = /There was no set-up to continue, so this is a new key/;
    const cases = [
      ['Continue set-up', true, SETUP, true],
      ['Continue set-up', true, { ...SETUP, resumed: true }, false],
      ['Set up two-factor', false, SETUP, false],
    ];
    for (const [button, pending, answer, shown] of cases) {
      const { user, unmount } = mountMfa({ enabled: false, backup_codes_remaining: 0, setup_pending: pending });
      postSpy.mockResolvedValue(answer);
      await startThroughPassword(user, button);
      await screen.findByLabelText(/Enter the 6-digit code/);
      expect(!!screen.queryByText(NOTICE), `${button} with ${JSON.stringify(answer.resumed)}`).toBe(shown);
      unmount();
    }
  });

  // FAILS if opening the step does not clear the field: a password typed and abandoned would wait, filled in,
  // for whoever opens the step next on a shared device.
  test('a password typed into the step and abandoned is gone when the step is opened again', async () => {
    const { user } = mountMfa({ enabled: false, backup_codes_remaining: 0, setup_pending: true });
    await user.click(await enabledButton('Continue set-up'));
    const first = await screen.findByRole('dialog');
    await user.type(within(first).getByLabelText('Password'), 'typed-then-abandoned');
    await user.click(within(first).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await user.click(await enabledButton('Start over'));
    const again = await screen.findByRole('dialog');
    expect(within(again).getByLabelText('Password').value).toBe('');
    expect(postSpy).not.toHaveBeenCalled();
  });

  describe('opening the key in an authenticator app (#765)', () => {
    const coarse = (matches) => { window.matchMedia = vi.fn().mockReturnValue({ matches }); };
    const open = async () => {
      const { user } = mountMfa({ enabled: false, backup_codes_remaining: 0 });
      postSpy.mockResolvedValue(SETUP);
      await startThroughPassword(user);
      await screen.findByLabelText(/Enter the 6-digit code/);
    };
    afterEach(() => { delete window.matchMedia; });

    test('shown on a touch device in the browser, linking to the otpauth uri', async () => {
      coarse(true);
      vi.spyOn(nativeBridge, 'isNativeApp').mockReturnValue(false);
      await open();
      expect(screen.getByRole('link', { name: /authenticator app/i }).getAttribute('href')).toBe(SETUP.otpauth_uri);
    });

    test('not shown inside the native app, nor on a mouse device', async () => {
      coarse(true);
      vi.spyOn(nativeBridge, 'isNativeApp').mockReturnValue(true);
      await open();
      expect(screen.queryByRole('link', { name: /authenticator app/i })).toBeNull();
    });

    test('not shown without a coarse pointer', async () => {
      coarse(false);
      vi.spyOn(nativeBridge, 'isNativeApp').mockReturnValue(false);
      await open();
      expect(screen.queryByRole('link', { name: /authenticator app/i })).toBeNull();
    });
  });

  test('★ turning it off requires the password, and sends it', async () => {
    // Without this, anyone who found an unlocked, signed-in device could strip the second factor off
    // the account in two clicks — which is precisely what the second factor exists to prevent.
    const { user } = mountMfa({ enabled: true, backup_codes_remaining: 5 });
    await user.click(await enabledButton('Turn off two-factor'));

    const dialog = await screen.findByRole('dialog');
    const pw = within(dialog).getByLabelText('Password');
    expect(pw.type).toBe('password');
    expect(pw.required).toBe(true);
    await user.type(pw, 'hunter22');
    await user.click(within(dialog).getByRole('button', { name: 'Turn off two-factor' }));

    await waitFor(() => expect(postSpy).toHaveBeenCalledWith('/auth/me/mfa/disable', { password: 'hunter22' }));
  });

  test('a wrong password leaves two-factor ON and says why', async () => {
    const { user } = mountMfa({ enabled: true, backup_codes_remaining: 5 });
    postSpy.mockRejectedValue(new Error('Password is incorrect'));
    await user.click(await enabledButton('Turn off two-factor'));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Password'), 'wrong');
    await user.click(within(dialog).getByRole('button', { name: 'Turn off two-factor' }));

    expect(await screen.findByText('Password is incorrect')).toBeTruthy();
    expect(screen.getByText('On'), 'still enabled').toBeTruthy();
  });

  test('★★ a failed status lookup reads as UNKNOWN, never as "Off"', async () => {
    // The dangerous default, and one this test used to NAME without asserting: `enabled` is
    // `!!status?.enabled`, so a failed lookup is false — and the card said a confident "Off", with
    // "Require a 6-digit code…" under it, to someone whose account may well have two-factor ON.
    // Telling a protected account it is unprotected is the one wrong answer this card can give.
    //
    // Asserting the error appears is NOT enough — it appeared alongside the false "Off" all along.
    // The claim that discriminates is the ABSENCE of the wrong status.
    vi.spyOn(api, 'get').mockRejectedValue(new Error('Could not load two-factor status'));
    renderAs(USER, <TwoFactorSection />, { route: '/account' });

    expect(await screen.findByText('Could not load two-factor status')).toBeTruthy();
    expect(screen.getByText('Unknown')).toBeTruthy();
    expect(screen.queryByText('Off'), 'never claim an account is unprotected on no evidence').toBeNull();
    expect(screen.queryByText(/Require a 6-digit code/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Set up two-factor' }).disabled).toBe(true);
  });
});
