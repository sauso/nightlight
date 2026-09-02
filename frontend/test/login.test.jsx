// The login screen — first-run setup, sign-in, and the second-factor step.
//
// ★ WHY UNITS HERE WHEN e2e ALREADY SIGNS IN. The Playwright suite covers the happy paths against a
// real server, so these deliberately go where it cannot cheaply reach: the states BETWEEN screens.
// This one component is three screens (setup / sign-in / code), switched by two pieces of state, and
// the failure modes are all "the wrong screen, convincingly rendered":
//
//   * `needsSetup === null` renders NOTHING. A first-run install that flashed "Sign in" before
//     switching to "Create admin account" would invite someone to type credentials for an account
//     that does not exist yet.
//   * `await login()` before `navigate('/')` — not awaiting sends you to a guarded route with a user
//     the context has not published, and the guard bounces you straight back to the login screen. It
//     looks exactly like a rejected password.
//   * the code step must not leak the short-lived MFA token, and backing out of it must not leave a
//     half-authenticated state lying around.
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { Routes, Route, useLocation } from 'react-router-dom';
import { renderAs, ADMIN } from './helpers/render.jsx';
import Login from '../src/pages/Login.jsx';
import { api } from '../src/lib/api.js';

const Probe = () => <div>at {useLocation().pathname}</div>;

// Signed OUT: the login screen is the one place the app renders with no user.
function mount() {
  return renderAs(
    null,
    <>
      <Probe />
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="*" element={<div>signed in</div>} />
      </Routes>
    </>,
    { route: '/login' }
  );
}

const SESSION = { token: 'tok-123', user: ADMIN };

let postSpy;

function mockStatus(needsSetup) {
  vi.spyOn(api, 'get').mockResolvedValue({ needsSetup });
}

afterEach(() => vi.restoreAllMocks());

describe('which of the three screens is shown', () => {
  test('★ nothing at all until the server says whether setup is needed', async () => {
    // A flash of the wrong screen is the failure here, so the assertion is that neither appears —
    // not merely that the right one eventually does.
    let resolveStatus;
    vi.spyOn(api, 'get').mockReturnValue(new Promise((r) => { resolveStatus = r; }));
    mount();
    expect(screen.queryByLabelText('Username')).toBeNull();
    expect(screen.queryByRole('button', { name: /Sign in|Create admin/ })).toBeNull();

    resolveStatus({ needsSetup: true });
    expect(await screen.findByRole('button', { name: 'Create admin account' })).toBeTruthy();
  });

  test('an established install gets the sign-in form', async () => {
    mockStatus(false);
    mount();
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeTruthy();
    expect(screen.queryByLabelText('First name'), 'no name fields once an admin exists').toBeNull();
  });

  test('a fresh install gets the setup form, with the names it needs', async () => {
    mockStatus(true);
    mount();
    expect(await screen.findByLabelText('First name')).toBeTruthy();
    expect(screen.getByLabelText('Last name')).toBeTruthy();
    expect(screen.getByText(/Set up the first admin account/)).toBeTruthy();
  });

  test('★ a failed status check falls back to sign-in rather than a blank page', async () => {
    // `needsSetup === null` renders nothing, so an unhandled rejection here is a permanently blank
    // app with no way in. Sign-in is the right guess: a server that cannot answer is far more likely
    // to be an existing install with a hiccup than a brand new one.
    vi.spyOn(api, 'get').mockRejectedValue(new Error('offline'));
    mount();
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeTruthy();
  });
});

describe('signing in', () => {
  beforeEach(() => {
    mockStatus(false);
    postSpy = vi.spyOn(api, 'post').mockResolvedValue(SESSION);
  });

  const fillAndSubmit = async (user, { name = 'nacho', pw = 'hunter22' } = {}) => {
    await user.type(await screen.findByLabelText('Username'), name);
    await user.type(screen.getByLabelText('Password'), pw);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
  };

  test('posts the credentials and lands inside the app', async () => {
    const { user } = mount();
    await fillAndSubmit(user);
    await waitFor(() => expect(postSpy).toHaveBeenCalledWith('/auth/login', { username: 'nacho', password: 'hunter22' }));
    expect(await screen.findByText('at /')).toBeTruthy();
  });

  test('★★ it waits for the session to be established BEFORE navigating', async () => {
    // `login()` fetches the media token and only then publishes the user. Navigating first would put
    // a guarded route in front of a context that still says "signed out", and the guard would bounce
    // straight back here — indistinguishable, to the person, from a wrong password.
    const { user, auth } = mount();
    let finishLogin;
    auth.login.mockImplementation(() => new Promise((r) => { finishLogin = r; }));

    await fillAndSubmit(user);
    await waitFor(() => expect(auth.login).toHaveBeenCalledWith('tok-123', ADMIN));
    expect(screen.getByText('at /login'), 'still here while the session is being set up').toBeTruthy();

    finishLogin();
    expect(await screen.findByText('at /')).toBeTruthy();
  });

  test('a rejected sign-in shows the reason and stays put', async () => {
    postSpy = vi.spyOn(api, 'post').mockRejectedValue(new Error('Invalid username or password'));
    const { user, auth } = mount();
    await fillAndSubmit(user);

    expect(await screen.findByText('Invalid username or password')).toBeTruthy();
    expect(screen.getByText('at /login')).toBeTruthy();
    expect(auth.login).not.toHaveBeenCalled();
  });

  test('the form is usable again after a failure', async () => {
    // `finally { setBusy(false) }` — without it a single typo would leave the button disabled forever
    // and the only way back would be a page reload.
    postSpy = vi.spyOn(api, 'post').mockRejectedValue(new Error('nope'));
    const { user } = mount();
    await fillAndSubmit(user);
    await screen.findByText('nope');
    expect(screen.getByRole('button', { name: 'Sign in' }).disabled).toBe(false);
  });

  test('★ the sign-in password has NO minimum length', async () => {
    // The other half of the setup-screen assertion, and the half that carries the consequence: a
    // floor here would lock out anyone whose existing password predates the rule, which is not a
    // security improvement. Asserting only the setup side left `minLength={needsSetup ? 8 : undefined}`
    // free to become an unconditional `minLength={8}` with the whole suite green.
    mount();
    expect((await screen.findByLabelText('Password')).getAttribute('minlength')).toBe(null);
  });

  test('password managers are given the right hints', async () => {
    // Wrong autocomplete tokens are why a manager offers to save a "new password" on every sign-in,
    // or silently fills the wrong field on the setup screen.
    mount();
    expect((await screen.findByLabelText('Username')).getAttribute('autocomplete')).toBe('username');
    expect(screen.getByLabelText('Password').getAttribute('autocomplete')).toBe('current-password');
  });
});

describe('first-run setup', () => {
  beforeEach(() => {
    mockStatus(true);
    postSpy = vi.spyOn(api, 'post').mockResolvedValue(SESSION);
  });

  test('posts the names alongside the credentials, to /auth/setup', async () => {
    const { user } = mount();
    await user.type(await screen.findByLabelText('First name'), 'Nacho');
    await user.type(screen.getByLabelText('Last name'), 'Leone');
    await user.type(screen.getByLabelText('Username'), 'nacho');
    await user.type(screen.getByLabelText('Password'), 'longenough1');
    await user.click(screen.getByRole('button', { name: 'Create admin account' }));

    await waitFor(() => expect(postSpy).toHaveBeenCalledWith('/auth/setup', {
      username: 'nacho', password: 'longenough1', first_name: 'Nacho', last_name: 'Leone',
    }));
  });

  test('★ the first password has a minimum length; signing in does not', async () => {
    // The floor belongs on the screen that CREATES a password. Putting it on the sign-in form would
    // lock out anyone whose existing password predates the rule, which is not a security improvement.
    mount();
    expect((await screen.findByLabelText('Password')).getAttribute('minlength')).toBe('8');
    expect(screen.getByLabelText('Password').getAttribute('autocomplete')).toBe('new-password');
  });
});

describe('★ the second-factor step', () => {
  const MFA_CHALLENGE = { mfaRequired: true, mfaToken: 'short-lived-abc123' };

  async function reachCodeStep(user) {
    await user.type(await screen.findByLabelText('Username'), 'nacho');
    await user.type(screen.getByLabelText('Password'), 'hunter22');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    return screen.findByLabelText('Verification code');
  }

  beforeEach(() => {
    mockStatus(false);
    postSpy = vi.spyOn(api, 'post').mockResolvedValue(MFA_CHALLENGE);
  });

  test('a challenge swaps the password form for the code form, and signs nobody in yet', async () => {
    const { user, auth } = mount();
    expect(await reachCodeStep(user)).toBeTruthy();
    expect(screen.queryByLabelText('Password'), 'the password form is gone, not merely hidden').toBeNull();
    expect(auth.login, 'a challenge is not a session').not.toHaveBeenCalled();
  });

  test('★★ the short-lived token is never put on the page', async () => {
    // It is a credential — a bearer for the second half of a login. It belongs in state and in the
    // request body, and nowhere a screenshot, a screen recording or a shoulder can reach.
    const { user } = mount();
    await reachCodeStep(user);
    expect(document.body.textContent).not.toContain('short-lived-abc123');
    expect(document.body.innerHTML).not.toContain('short-lived-abc123');
  });

  test('the code is sent with its token, trimmed', async () => {
    // Trimming matters more than it looks: a code pasted from an authenticator app very often arrives
    // with a trailing space, and an untrimmed one fails as "invalid code" — sending the person back
    // to re-read a code that was right.
    const { user } = mount();
    await reachCodeStep(user);
    postSpy.mockResolvedValue(SESSION);
    await user.type(screen.getByLabelText('Verification code'), ' 123456 ');
    await user.click(screen.getByRole('button', { name: 'Verify' }));

    await waitFor(() => expect(postSpy).toHaveBeenCalledWith('/auth/login/mfa', {
      mfaToken: 'short-lived-abc123', code: '123456',
    }));
  });

  test('it also waits for the session before navigating', async () => {
    const { user, auth } = mount();
    await reachCodeStep(user);
    postSpy.mockResolvedValue(SESSION);
    let finishLogin;
    auth.login.mockImplementation(() => new Promise((r) => { finishLogin = r; }));

    await user.type(screen.getByLabelText('Verification code'), '123456');
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    await waitFor(() => expect(auth.login).toHaveBeenCalled());
    expect(screen.getByText('at /login')).toBeTruthy();

    finishLogin();
    expect(await screen.findByText('at /')).toBeTruthy();
  });

  test('a wrong code is reported without losing the challenge', async () => {
    // Staying on the code step is the point: a wrong digit must not send you back to re-enter your
    // password, which would mean a fresh challenge and a fresh 30-second code.
    const { user } = mount();
    await reachCodeStep(user);
    postSpy.mockRejectedValue(new Error('Invalid code'));
    await user.type(screen.getByLabelText('Verification code'), '000000');
    await user.click(screen.getByRole('button', { name: 'Verify' }));

    expect(await screen.findByText('Invalid code')).toBeTruthy();
    expect(screen.getByLabelText('Verification code')).toBeTruthy();
  });

  test('it says backup codes work here too', async () => {
    // The only place this is said. Someone whose phone is lost is looking at this screen, and if it
    // only asks for "the code from your authenticator app" they have no reason to think the backup
    // codes they saved are accepted in the same box.
    const { user } = mount();
    await reachCodeStep(user);
    expect(screen.getByText(/backup codes instead/i)).toBeTruthy();
  });

  test('★ Back returns to the form and clears the typed password', async () => {
    // Not tidiness: backing out means starting the login over, and leaving the password populated
    // would leave a live credential sitting in a form on an unattended screen.
    const { user } = mount();
    await reachCodeStep(user);
    await user.click(screen.getByRole('button', { name: 'Back' }));

    const pw = await screen.findByLabelText('Password');
    expect(pw.value).toBe('');
    expect(screen.getByLabelText('Username').value, 'the username is kept — it is not a secret').toBe('nacho');
    expect(screen.queryByLabelText('Verification code')).toBeNull();
  });
});
