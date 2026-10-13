// #697: a mistyped CURRENT password (Account) or confirmation password (turn off two-factor) must show its
// message inline and leave the person signed in.
//
// These run the REAL api client over a faked fetch, not a spy on api.put/api.post: the bug was in how
// api.js reacts to the status (any 401 clears the token and sends the person to #/login), so a test that
// rejects with a ready-made Error never reaches the code that signed people out.
import { describe, test, expect, vi, afterEach, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { renderAsAdmin, enabledButton } from './helpers/render.jsx';
import Account from '../src/pages/Account.jsx';
import TwoFactorSection from '../src/components/TwoFactorSection.jsx';
import { getToken, setToken } from '../src/lib/api.js';

const realFetch = globalThis.fetch;
const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });

// What the server answers, per route. 400 is what the fixed backend sends; the 401 variant is the old
// behaviour, kept so the test can be shown to fail against it.
function serve(wrongStatus, wrongRoute) {
  globalThis.fetch = vi.fn(async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith('/auth/sessions')) return reply(200, []);
    if (u.endsWith('/auth/me/mfa')) return reply(200, { enabled: true, backup_codes_remaining: 4 });
    if (u.endsWith(wrongRoute) && init.method !== 'GET') {
      return reply(wrongStatus, { error: wrongRoute.endsWith('password') ? 'Current password is incorrect' : 'Password is incorrect' });
    }
    return reply(200, null);
  });
}

beforeEach(() => { setToken('a-live-token'); window.location.hash = '#/account'; });
afterEach(() => { globalThis.fetch = realFetch; setToken(null); vi.restoreAllMocks(); });

describe('#697 a wrong password is an inline message, not a sign-out', () => {
  test('★ Account: wrong current password shows the message and keeps the token', async () => {
    serve(400, '/auth/me/password');
    const { user } = renderAsAdmin(<Account />, { route: '/account' });
    await user.click(await screen.findByRole('button', { name: 'Change my password' }));
    await user.type(await screen.findByLabelText('Current password'), 'wrong');
    await user.type(screen.getByLabelText('New password'), 'newpassword1');
    await user.type(screen.getByLabelText('Confirm new password'), 'newpassword1');
    await user.click(screen.getByRole('button', { name: 'Update password' }));

    expect(await screen.findByText('Current password is incorrect')).toBeInTheDocument();
    expect(getToken()).toBe('a-live-token');
    expect(window.location.hash).not.toBe('#/login');
    // The form is still open for another try.
    expect(screen.getByLabelText('Current password')).toBeInTheDocument();
  });

  test('★ turning two-factor off: wrong password shows the message in the dialog and keeps the token', async () => {
    serve(400, '/auth/me/mfa/disable');
    const { user } = renderAsAdmin(<TwoFactorSection />);
    await user.click(await enabledButton('Turn off two-factor'));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/password/i), 'wrong');
    await user.click(within(dialog).getByRole('button', { name: /Turn off/ }));

    expect(await screen.findByText('Password is incorrect')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(getToken()).toBe('a-live-token');
    expect(window.location.hash).not.toBe('#/login');
  });

  test('control: a real 401 (dead session) still clears the token — only the wrong-password status changed', async () => {
    serve(401, '/auth/me/password');
    const { user } = renderAsAdmin(<Account />, { route: '/account' });
    await user.click(await screen.findByRole('button', { name: 'Change my password' }));
    await user.type(await screen.findByLabelText('Current password'), 'x');
    await user.type(screen.getByLabelText('New password'), 'newpassword1');
    await user.type(screen.getByLabelText('Confirm new password'), 'newpassword1');
    await user.click(screen.getByRole('button', { name: 'Update password' }));
    await waitFor(() => expect(getToken()).toBeNull());
  });
});
