// Caregiver management: the list (SettingsUsers) and the add/edit screen (UserSettings).
//
// ★ THREE THINGS MAKE THIS WORTH TESTING BEYOND the e2e happy paths:
//
//  1. **A THIRD blank-password convention.** Editing a caregiver OMITS the password key when the box
//     is blank — where the camera form SENDS a blank one and the push providers send an empty string.
//     All three mean "keep"; all three are written differently. Getting this one wrong would reset a
//     caregiver's password to empty on any unrelated edit.
//  2. **Self-protection.** An admin must not be offered "Remove caregiver" on their own account. The
//     server refuses it, but a button that produces an error is a button that shouldn't be there —
//     and the failure it guards against is locking the last admin out of their own install.
//  3. **`timeAgo` parses a naive timestamp as UTC by appending 'Z'.** That is a real timezone
//     assumption about what the API sends, it is invisible on a machine set to UTC, and this suite
//     runs on Pacific/Auckland specifically so that a local-vs-UTC confusion cannot hide.
//
// Role gating is not tested here: both routes are <AdminProtected> (routeGuards.test.jsx).
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { Routes, Route, useLocation } from 'react-router-dom';
import { renderAsAdmin, ADMIN } from './helpers/render.jsx';
import SettingsUsers from '../src/pages/SettingsUsers.jsx';
import UserSettings from '../src/pages/UserSettings.jsx';
import { api } from '../src/lib/api.js';

const NANNY = { id: 'u-care', username: 'nanny', role: 'caregiver', first_name: 'Nanny', last_name: 'McPhee', photo: null, mfa_enabled: 0 };
const ME = { id: ADMIN.id, username: 'nacho', role: 'admin', first_name: 'Nacho', last_name: 'Leone', photo: null, mfa_enabled: 1 };
const USERS = [ME, NANNY];

const Probe = () => <div>at {useLocation().pathname}</div>;

let postSpy;
let putSpy;
let delSpy;

// Route the two GETs this screen makes by path — they return quite different shapes, and a single
// mockResolvedValue would let a test pass while the component asked for the wrong thing.
function mockApi({ users = USERS, sessions = [], usersFails = null } = {}) {
  vi.spyOn(api, 'get').mockImplementation((path) => {
    if (path === '/auth/users') return usersFails ? Promise.reject(new Error(usersFails)) : Promise.resolve(users);
    if (path === '/auth/sessions/all') return Promise.resolve(sessions);
    return Promise.resolve(null);
  });
  postSpy = vi.spyOn(api, 'post').mockResolvedValue({});
  putSpy = vi.spyOn(api, 'put').mockResolvedValue({});
  delSpy = vi.spyOn(api, 'del').mockResolvedValue({});
}

afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------------------------------------
describe('the caregiver list', () => {
  const mountList = () =>
    renderAsAdmin(
      <>
        <Probe />
        <Routes>
          <Route path="/settings/users" element={<SettingsUsers />} />
          <Route path="*" element={<div>elsewhere</div>} />
        </Routes>
      </>,
      { route: '/settings/users' }
    );

  beforeEach(() => mockApi());

  test('lists everyone by display name, with their username and role', async () => {
    mountList();
    expect(await screen.findByText('Nanny McPhee')).toBeTruthy();
    expect(screen.getByText('nanny · caregiver')).toBeTruthy();
    expect(screen.getByText('Nacho Leone')).toBeTruthy();
  });

  test('someone with no first or last name falls back to their username', async () => {
    // Not cosmetic — a row with a blank title is unclickable in practice, because there is nothing
    // to aim at and nothing to tell one account from another.
    mockApi({ users: [{ id: 'u-x', username: 'temp', role: 'caregiver' }] });
    mountList();
    expect(await screen.findByText('temp')).toBeTruthy();
  });

  test('a row opens that caregiver, by id', async () => {
    const { user } = mountList();
    await user.click(await screen.findByText('Nanny McPhee'));
    expect(await screen.findByText('at /settings/users/u-care')).toBeTruthy();
  });

  test('★ rows are reachable from the keyboard', async () => {
    // <div role="button" tabIndex={0}> — the keyboard handling is hand-written and can be dropped
    // without anything looking wrong on screen.
    //
    // ⚠️ TABBED TO, not `.focus()`ed. `element.focus()` works on a tabIndex={-1} element too, so
    // focusing directly tests the Enter handler while saying nothing about reachability — a mutant
    // that took every row out of the tab order survived that version. Two tabs: the header's back
    // button is first in the order.
    const { user } = mountList();
    const row = (await screen.findByText('Nacho Leone')).closest('.list-row');
    await user.tab();
    await user.tab();
    expect(row, 'the first caregiver row must be tabbable').toBe(document.activeElement);

    await user.keyboard('{Enter}');
    expect(await screen.findByText(`at /settings/users/${ADMIN.id}`)).toBeTruthy();
  });

  test('Add caregiver goes to the new-caregiver screen', async () => {
    const { user } = mountList();
    await user.click(await screen.findByRole('button', { name: /Add caregiver/ }));
    expect(await screen.findByText('at /settings/users/new')).toBeTruthy();
  });

  test('a failed load is reported rather than showing an empty list as if it were true', async () => {
    mockApi({ usersFails: 'Not authorised' });
    mountList();
    expect(await screen.findByText('Not authorised')).toBeTruthy();
  });

  describe('the session list', () => {
    // ⚠️ These timestamps are what the API actually sends: SQLite datetimes with NO timezone marker,
    // which the component reads as UTC by appending 'Z'. Built as offsets from now so they cannot rot.
    const agoIso = (ms) => new Date(Date.now() - ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
    const SESSIONS = [
      { id: 's1', username: 'nacho', device: 'Chrome on Windows', is_current: true, last_seen_at: agoIso(30 * 1000) },
      { id: 's2', username: 'nanny', device: 'Safari on iPhone', is_current: false, last_seen_at: agoIso(3 * 3600 * 1000) },
    ];

    test('shows each session, marking the one you are on', async () => {
      mockApi({ sessions: SESSIONS });
      mountList();
      expect(await screen.findByText(/Chrome on Windows \(this device\)/)).toBeTruthy();
      expect(screen.getByText(/Safari on iPhone$/)).toBeTruthy();
    });

    test('★★ "active 3h ago" is computed in UTC, not in the browser\'s timezone', async () => {
      // The component appends 'Z' because the API sends a naive UTC datetime. If that assumption were
      // dropped — or the API started sending local times — this suite would read the same string as
      // Pacific/Auckland time and report a session from three hours ago as being from fifteen. On a
      // UTC machine the bug is literally invisible, which is exactly why the suite is not pinned to
      // UTC (see vite.config.js).
      mockApi({ sessions: SESSIONS });
      mountList();
      const row = (await screen.findByText(/Safari on iPhone/)).closest('.list-row');
      expect(within(row).getByText('Active 3h ago')).toBeTruthy();
    });

    test('a session seen seconds ago reads "just now"', async () => {
      mockApi({ sessions: SESSIONS });
      mountList();
      const row = (await screen.findByText(/Chrome on Windows/)).closest('.list-row');
      expect(within(row).getByText('Active just now')).toBeTruthy();
    });

    test('no sessions reads as None active, not as a blank card', async () => {
      mockApi({ sessions: [] });
      mountList();
      expect(await screen.findByText('None active')).toBeTruthy();
    });

    test('signing out someone else refreshes the list rather than signing you out', async () => {
      mockApi({ sessions: SESSIONS });
      const { user, auth } = mountList();
      const row = (await screen.findByText(/Safari on iPhone/)).closest('.list-row');
      await user.click(within(row).getByRole('button', { name: 'Sign out' }));

      await waitFor(() => expect(delSpy).toHaveBeenCalledWith('/auth/sessions/s2'));
      expect(auth.logout).not.toHaveBeenCalled();
      await waitFor(() => expect(api.get).toHaveBeenCalledTimes(4)); // the initial pair, then the reload
    });

    test('★ signing out your OWN session logs you out locally instead of reloading', async () => {
      // The session is gone server-side, so every request the reload makes would 401 and the app
      // would sit on a broken screen until something noticed. Logging out is the honest response.
      mockApi({ sessions: SESSIONS });
      const { user, auth } = mountList();
      const row = (await screen.findByText(/Chrome on Windows/)).closest('.list-row');
      await user.click(within(row).getByRole('button', { name: 'Sign out' }));

      await waitFor(() => expect(delSpy).toHaveBeenCalledWith('/auth/sessions/s1'));
      await waitFor(() => expect(auth.logout).toHaveBeenCalled());
    });

    test('a failed sign-out is reported and changes nothing', async () => {
      mockApi({ sessions: SESSIONS });
      delSpy = vi.spyOn(api, 'del').mockRejectedValue(new Error('Session already ended'));
      const { user, auth } = mountList();
      const row = (await screen.findByText(/Safari on iPhone/)).closest('.list-row');
      await user.click(within(row).getByRole('button', { name: 'Sign out' }));

      expect(await screen.findByText('Session already ended')).toBeTruthy();
      expect(auth.logout).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------------------------
describe('adding and editing a caregiver', () => {
  const mountEdit = (id = NANNY.id) =>
    renderAsAdmin(
      <>
        <Probe />
        <Routes>
          <Route path="/settings/users/new" element={<UserSettings />} />
          <Route path="/settings/users/:id" element={<UserSettings />} />
          <Route path="*" element={<div>elsewhere</div>} />
        </Routes>
      </>,
      { route: `/settings/users/${id}` }
    );

  beforeEach(() => mockApi());

  describe('editing', () => {
    test('loads the caregiver into the form, with the password box empty', async () => {
      mountEdit();
      expect((await screen.findByLabelText('First name')).value).toBe('Nanny');
      expect(screen.getByLabelText('Last name').value).toBe('McPhee');
      expect(screen.getByLabelText('Username (login)').value).toBe('nanny');
      expect(screen.getByLabelText(/Role/).value).toBe('caregiver');
      const pw = screen.getByLabelText(/Reset password/);
      expect(pw.value).toBe('');
      expect(pw.placeholder).toBe('Leave blank to keep current password');
      expect(pw.required, 'an edit does not demand a new password').toBe(false);
    });

    test('★★ a blank password is OMITTED from the payload — this screen\'s "keep" convention', async () => {
      // The third of three conventions in this app for the same idea. Sending `password: ''` here
      // would not be read as "keep": it would be a password change to the empty string, and the
      // caregiver would be locked out with nothing to explain it.
      const { user } = mountEdit();
      const first = await screen.findByLabelText('First name');
      await user.clear(first);
      await user.type(first, 'Nan');
      await user.click(screen.getByRole('button', { name: 'Save changes' }));

      await waitFor(() => expect(putSpy).toHaveBeenCalled());
      const [path, body] = putSpy.mock.calls[0];
      expect(path).toBe('/auth/users/u-care');
      expect(body).not.toHaveProperty('password');
      expect(Object.keys(body).sort()).toEqual(['first_name', 'last_name', 'role', 'username']);
      expect(body.first_name).toBe('Nan');
    });

    test('a typed password IS sent', async () => {
      const { user } = mountEdit();
      await user.type(await screen.findByLabelText(/Reset password/), 'newpassword1');
      await user.click(screen.getByRole('button', { name: 'Save changes' }));
      await waitFor(() => expect(putSpy).toHaveBeenCalled());
      expect(putSpy.mock.calls[0][1].password).toBe('newpassword1');
    });

    test('a new password must clear the same length floor as the first one', async () => {
      mountEdit();
      expect((await screen.findByLabelText(/Reset password/)).getAttribute('minlength')).toBe('8');
    });

    test('a successful save returns to the caregiver list', async () => {
      const { user } = mountEdit();
      await user.click(await screen.findByRole('button', { name: 'Save changes' }));
      expect(await screen.findByText('at /settings/users')).toBeTruthy();
    });

    test('★ editing YOURSELF refreshes the signed-in user', async () => {
      // Your own name is on the header, the account row and every avatar in the app; without the
      // refresh they would all keep showing the old one until a reload.
      const { user, auth } = mountEdit(ADMIN.id);
      await screen.findByLabelText('First name');
      await user.click(screen.getByRole('button', { name: 'Save changes' }));
      await waitFor(() => expect(auth.refresh).toHaveBeenCalled());
    });

    test('editing someone else does not', async () => {
      const { user, auth } = mountEdit();
      await screen.findByLabelText('First name');
      await user.click(screen.getByRole('button', { name: 'Save changes' }));
      await waitFor(() => expect(putSpy).toHaveBeenCalled());
      expect(auth.refresh).not.toHaveBeenCalled();
    });

    test('a rejected save says why and stays on the form', async () => {
      putSpy = vi.spyOn(api, 'put').mockRejectedValue(new Error('That username is taken'));
      const { user } = mountEdit();
      await user.click(await screen.findByRole('button', { name: 'Save changes' }));
      expect(await screen.findByText('That username is taken')).toBeTruthy();
      expect(screen.getByText('at /settings/users/u-care')).toBeTruthy();
    });

    test('a failed load still leaves a usable screen, with the reason', async () => {
      mockApi({ usersFails: 'Not authorised' });
      mountEdit();
      expect(await screen.findByText('Not authorised')).toBeTruthy();
      expect(screen.getByLabelText('Username (login)')).toBeTruthy();
    });
  });

  describe('adding', () => {
    test('starts blank, demands a password, and POSTs the whole form', async () => {
      const { user } = mountEdit('new');
      const username = await screen.findByLabelText('Username (login)');
      expect(username.value).toBe('');
      const pw = screen.getByLabelText('Password');
      expect(pw.required, 'a new account cannot be created without one').toBe(true);
      expect(screen.getByLabelText(/Role/).value, 'caregiver is the safe default').toBe('caregiver');

      await user.type(username, 'newnanny');
      await user.type(pw, 'password123');
      await user.click(screen.getByRole('button', { name: 'Add caregiver' }));

      await waitFor(() => expect(postSpy).toHaveBeenCalled());
      const [path, body] = postSpy.mock.calls[0];
      expect(path).toBe('/auth/users');
      expect(body.username).toBe('newnanny');
      expect(body.password).toBe('password123');
      expect(body.role).toBe('caregiver');
    });

    test('an admin can be created deliberately', async () => {
      const { user } = mountEdit('new');
      await user.type(await screen.findByLabelText('Username (login)'), 'admin2');
      await user.type(screen.getByLabelText('Password'), 'password123');
      await user.selectOptions(screen.getByLabelText(/Role/), 'admin');
      await user.click(screen.getByRole('button', { name: 'Add caregiver' }));
      await waitFor(() => expect(postSpy).toHaveBeenCalled());
      expect(postSpy.mock.calls[0][1].role).toBe('admin');
    });

    test('there is nothing to remove or reset yet', async () => {
      mountEdit('new');
      await screen.findByLabelText('Username (login)');
      expect(screen.queryByRole('button', { name: 'Remove caregiver' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Reset two-factor' })).toBeNull();
    });
  });

  describe('★ removing', () => {
    test('is not offered on your OWN account', async () => {
      // The server refuses it anyway, but an admin who deletes themselves is trying to lock
      // themselves out of their own install, and the right place to say no is before the click.
      mountEdit(ADMIN.id);
      await screen.findByLabelText('First name');
      expect(screen.queryByRole('button', { name: 'Remove caregiver' })).toBeNull();
    });

    test('is offered on someone else, behind a confirmation', async () => {
      const { user } = mountEdit();
      await user.click(await screen.findByRole('button', { name: 'Remove caregiver' }));
      expect(await screen.findByText(/signed out everywhere/)).toBeTruthy();
      expect(delSpy, 'opening the dialog is not the deletion').not.toHaveBeenCalled();

      await user.click(screen.getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(screen.queryByText(/signed out everywhere/)).toBeNull());
      expect(delSpy).not.toHaveBeenCalled();
    });

    test('confirming deletes and returns to the list', async () => {
      const { user } = mountEdit();
      await user.click(await screen.findByRole('button', { name: 'Remove caregiver' }));
      await user.click(await screen.findByRole('button', { name: 'Remove' }));
      await waitFor(() => expect(delSpy).toHaveBeenCalledWith('/auth/users/u-care'));
      expect(await screen.findByText('at /settings/users')).toBeTruthy();
    });

    test('a failed delete says why and keeps you on the account', async () => {
      // Navigating away on a failure would look exactly like success, and the caregiver would still
      // be able to sign in.
      delSpy = vi.spyOn(api, 'del').mockRejectedValue(new Error('Cannot remove the last admin'));
      const { user } = mountEdit();
      await user.click(await screen.findByRole('button', { name: 'Remove caregiver' }));
      await user.click(await screen.findByRole('button', { name: 'Remove' }));
      expect(await screen.findByText('Cannot remove the last admin')).toBeTruthy();
      expect(screen.getByText('at /settings/users/u-care')).toBeTruthy();
    });
  });

  describe('★ resetting someone else\'s two-factor', () => {
    test('is offered only for an account that HAS two-factor on', async () => {
      // Offering it otherwise would suggest the account is protected when it is not.
      mountEdit();
      await screen.findByLabelText('First name');
      expect(screen.queryByRole('button', { name: 'Reset two-factor' })).toBeNull();
    });

    test('and is offered when they do', async () => {
      mountEdit(ADMIN.id);
      expect(await screen.findByRole('button', { name: 'Reset two-factor' })).toBeTruthy();
    });

    test('★★ it asks first — this is the account-recovery lever', async () => {
      // It removes a second factor from someone else's account without their password. A misclick
      // that took effect immediately would be a silent, unannounced downgrade of that account's
      // security, so the confirmation is the control that matters.
      const { user } = mountEdit(ADMIN.id);
      await user.click(await screen.findByRole('button', { name: 'Reset two-factor' }));
      // Scoped to the dialog: the card behind it explains the same thing in almost the same words, so
      // a page-wide match would pass whether or not the confirmation ever opened.
      expect(within(await screen.findByRole('dialog')).getByText(/sign in with just their/)).toBeTruthy();
      expect(delSpy).not.toHaveBeenCalled();

      await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Reset two-factor' }));
      await waitFor(() => expect(delSpy).toHaveBeenCalledWith(`/auth/users/${ADMIN.id}/mfa`));
    });

    test('once reset, the button goes away without a reload', async () => {
      // The card is the only indication of the account's two-factor state; leaving it up after a
      // successful reset would invite a second, pointless reset and suggest nothing had happened.
      const { user } = mountEdit(ADMIN.id);
      await user.click(await screen.findByRole('button', { name: 'Reset two-factor' }));
      await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Reset two-factor' }));
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Reset two-factor' })).toBeNull());
    });

    test('a failed reset is reported and leaves the state alone', async () => {
      delSpy = vi.spyOn(api, 'del').mockRejectedValue(new Error('Not permitted'));
      const { user } = mountEdit(ADMIN.id);
      await user.click(await screen.findByRole('button', { name: 'Reset two-factor' }));
      await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Reset two-factor' }));
      expect(await screen.findByText('Not permitted')).toBeTruthy();
    });
  });
});
