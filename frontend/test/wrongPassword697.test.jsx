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
import { getToken, setToken, onUnauthorized } from '../src/lib/api.js';

const realFetch = globalThis.fetch;
const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });

// The two confirmation routes, by exact method AND path: what the backend serves (routes/auth.js).
const CHANGE_PASSWORD = { method: 'PUT', path: '/api/auth/me/password', error: 'Current password is incorrect' };
const MFA_DISABLE = { method: 'POST', path: '/api/auth/me/mfa/disable', error: 'Password is incorrect' };

// What the server answers. 400 is what the fixed backend sends; the 401 variant is the old behaviour, kept
// so the test can be shown to fail against it.
//
// STRICT on method and path (review of #706): an earlier fake answered the route on ANY non-GET method,
// so swapping the verbs in api.js's `post`/`put` wrappers still passed. Anything this fake does not know
// is recorded in `unexpected` and answered 404, and every test asserts that list is empty.
let unexpected;
function serve(wrongStatus, route) {
  unexpected = [];
  globalThis.fetch = vi.fn(async (url, init = {}) => {
    const request = `${init.method || 'GET'} ${String(url)}`;
    // demoStatus.js caches this at module scope, so only the first page rendered in the file asks for it.
    if (request === 'GET /api/auth/status') return reply(200, { needsSetup: false, demo: false });
    if (request === 'GET /api/auth/sessions') return reply(200, []);
    if (request === 'GET /api/auth/me/mfa') return reply(200, { enabled: true, backup_codes_remaining: 4 });
    if (request === `${route.method} ${route.path}`) return reply(wrongStatus, { error: route.error });
    unexpected.push(request);
    return reply(404, { error: `unexpected request: ${request}` });
  });
}

let signedOut; let unsub;
beforeEach(() => { setToken('a-live-token'); window.location.hash = '#/account'; signedOut = vi.fn(); unsub = onUnauthorized(signedOut); });
afterEach(() => { unsub(); globalThis.fetch = realFetch; setToken(null); vi.restoreAllMocks(); });

describe('#697 a wrong password is an inline message, not a sign-out', () => {
  test('★ Account: wrong current password shows the message and keeps the token', async () => {
    serve(400, CHANGE_PASSWORD);
    const { user } = renderAsAdmin(<Account />, { route: '/account' });
    await user.click(await screen.findByRole('button', { name: 'Change my password' }));
    await user.type(await screen.findByLabelText('Current password'), 'wrong');
    await user.type(screen.getByLabelText('New password'), 'newpassword1');
    await user.type(screen.getByLabelText('Confirm new password'), 'newpassword1');
    await user.click(screen.getByRole('button', { name: 'Update password' }));

    expect(await screen.findByText('Current password is incorrect')).toBeInTheDocument();
    expect(signedOut).not.toHaveBeenCalled();
    expect(getToken()).toBe('a-live-token');
    expect(window.location.hash).not.toBe('#/login');
    // The form is still open for another try.
    expect(screen.getByLabelText('Current password')).toBeInTheDocument();
    expect(unexpected).toEqual([]);
  });

  test('★ turning two-factor off: wrong password shows the message in the dialog and keeps the token', async () => {
    serve(400, MFA_DISABLE);
    const { user } = renderAsAdmin(<TwoFactorSection />);
    await user.click(await enabledButton('Turn off two-factor'));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/password/i), 'wrong');
    await user.click(within(dialog).getByRole('button', { name: /Turn off/ }));

    expect(await screen.findByText('Password is incorrect')).toBeInTheDocument();
    expect(signedOut).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(getToken()).toBe('a-live-token');
    expect(window.location.hash).not.toBe('#/login');
    expect(unexpected).toEqual([]);
  });

  // The control must prove ALL THREE things a dead sign-in does, not only the token (review of #706: with
  // just the token asserted, deleting api.js's `#/login` redirect passed). Without the redirect and the
  // listener call, the "not signed out" checks above would pass for a client that never signs anyone out.
  test('control: a real 401 (dead session) still clears the token — only the wrong-password status changed', async () => {
    serve(401, CHANGE_PASSWORD);
    const { user } = renderAsAdmin(<Account />, { route: '/account' });
    await user.click(await screen.findByRole('button', { name: 'Change my password' }));
    await user.type(await screen.findByLabelText('Current password'), 'x');
    await user.type(screen.getByLabelText('New password'), 'newpassword1');
    await user.type(screen.getByLabelText('Confirm new password'), 'newpassword1');
    await user.click(screen.getByRole('button', { name: 'Update password' }));
    await waitFor(() => expect(getToken()).toBeNull());
    expect(window.location.hash).toBe('#/login');
    expect(signedOut).toHaveBeenCalledTimes(1);
    expect(unexpected).toEqual([]);
  });
});
