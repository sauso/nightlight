// A brand-new installation (owner, 2026-11-06): the welcome screen with the steps comes FIRST, then the form that creates the first
// admin, in the same card and look as the setup guide's caregiver form. The server step is unchanged (POST /auth/setup, which takes
// no photo), so these tests are about the order of the screens, what is sent, and what happens when something fails, including the
// optional photo that is saved with PUT /auth/me once the new admin is signed in.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { Routes, Route, useLocation } from 'react-router-dom';
import { renderAs, ADMIN } from './helpers/render.jsx';
import Login from '../src/pages/Login.jsx';
import { api } from '../src/lib/api.js';
import * as imageResize from '../src/lib/imageResize.js';

const Probe = () => <div>at {useLocation().pathname}</div>;
const SESSION = { token: 'tok-123', user: ADMIN };

let postSpy;
let putSpy;

function mount() {
  return renderAs(null, <><Probe /><Routes>
    <Route path="/login" element={<Login />} />
    <Route path="*" element={<div>signed in</div>} />
  </Routes></>, { route: '/login' });
}

beforeEach(() => {
  vi.spyOn(api, 'get').mockResolvedValue({ needsSetup: true });
  postSpy = vi.spyOn(api, 'post').mockResolvedValue(SESSION);
  putSpy = vi.spyOn(api, 'put').mockResolvedValue({});
});
afterEach(() => vi.restoreAllMocks());

async function toAccount(user) {
  await user.click(await screen.findByRole('button', { name: 'Get started' }));
  await screen.findByLabelText('First name');
}
async function fillAccount(user, { first = 'Nacho', last = 'Leone', username = 'nacho', password = 'longenough1' } = {}) {
  await user.type(screen.getByLabelText('First name'), first);
  await user.type(screen.getByLabelText('Last name'), last);
  await user.type(screen.getByLabelText('Username'), username);
  await user.type(screen.getByLabelText('Password'), password);
}
const pickFile = (input) => fireEvent.change(input, { target: { files: [new File(['x'], 'p.png', { type: 'image/png' })] } });

describe('the two screens, in order', () => {
  test('★ the welcome screen with the steps comes first and has no form, no counter and no progress bar', async () => {
    mount();
    expect(await screen.findByRole('heading', { name: 'Welcome to Nightlight' })).toBeTruthy();
    for (const step of ['Add your child', 'Connect your camera', 'Test your monitor', 'Invite caregivers (optional)', 'Watch from anywhere (optional)']) {
      expect(screen.getByText(step), step).toBeTruthy();
    }
    expect(screen.queryByLabelText('Username')).toBeNull();
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.queryByText(/Step \d of \d/)).toBeNull();
    expect(postSpy).not.toHaveBeenCalled();
  });

  test('★ Get started shows the account form in the guide\'s card as Step 1 of 7 (first segment current), and Back returns to the welcome screen', async () => {
    const { user } = mount();
    await toAccount(user);
    expect(screen.getByRole('heading', { name: 'Create your account' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create admin account' })).toBeTruthy();
    // Owner 2026-11-06: creating the account is Step 1, not a detour before "step 1". The guide that follows is Steps 2-7.
    expect(screen.getByText('Step 1 of 7')).toBeTruthy();
    const bar = screen.getByRole('progressbar', { name: 'Step 1 of 7' });
    expect(bar.getAttribute('aria-valuemax')).toBe('7');
    const segments = [...bar.children];
    expect(segments).toHaveLength(7);
    expect(segments[0].className).toBe('is-current');
    expect(segments.slice(1).every((segment) => segment.className === '')).toBe(true);
    expect(screen.getByText('At least 8 characters.')).toBeTruthy();
    await user.type(screen.getByLabelText('Username'), 'nacho');
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByRole('heading', { name: 'Welcome to Nightlight' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Get started' }));
    expect(screen.getByLabelText('Username').value, 'what was typed survives going back').toBe('nacho');
  });
});

describe('the status-bar strip', () => {
  // index.css draws the navy strip under a phone's status bar when <html> carries `setup-wizard`. These screens have no header,
  // so without the class the page showed under the light status-bar icons (owner, 2026-11-06).
  const on = () => document.documentElement.classList.contains('setup-wizard');

  test('★ <html> carries setup-wizard on the welcome screen AND the account screen, and not after the screens are gone', async () => {
    const { user, unmount } = mount();
    await screen.findByRole('heading', { name: 'Welcome to Nightlight' });
    expect(on(), 'welcome').toBe(true);
    await toAccount(user);
    expect(on(), 'account').toBe(true);
    unmount();
    expect(on(), 'removed on unmount, so a signed-in page has its bottom bar').toBe(false);
  });
});

describe('creating the first admin', () => {
  test('★ sends exactly the names and credentials to /auth/setup (username trimmed), signs in, and lands at /setup', async () => {
    const { user, auth } = mount();
    await toAccount(user);
    await fillAccount(user, { username: '  nacho  ' });
    await user.click(screen.getByRole('button', { name: 'Create admin account' }));
    await waitFor(() => expect(postSpy).toHaveBeenCalledTimes(1));
    expect(postSpy.mock.calls[0][0]).toBe('/auth/setup');
    expect(postSpy.mock.calls[0][1]).toEqual({ username: 'nacho', password: 'longenough1', first_name: 'Nacho', last_name: 'Leone' });
    await waitFor(() => expect(auth.login).toHaveBeenCalledWith('tok-123', ADMIN));
    expect(await screen.findByText('at /setup')).toBeTruthy();
    expect(putSpy, 'no photo picked: nothing else is sent').not.toHaveBeenCalled();
  });

  test('★ a short password is stopped before any request, and says why', async () => {
    const { user } = mount();
    await toAccount(user);
    await fillAccount(user, { password: 'short' });
    await user.click(screen.getByRole('button', { name: 'Create admin account' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Password must be at least 8 characters');
    expect(postSpy).not.toHaveBeenCalled();
  });

  test('★ a refusal (a taken username) shows the server\'s message, keeps what was typed, signs nobody in and goes nowhere', async () => {
    postSpy.mockRejectedValue(new Error('That username is already taken'));
    const { user, auth } = mount();
    await toAccount(user);
    await fillAccount(user);
    await user.click(screen.getByRole('button', { name: 'Create admin account' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That username is already taken');
    expect(screen.getByLabelText('Username').value).toBe('nacho');
    expect(auth.login).not.toHaveBeenCalled();
    expect(screen.queryByText('at /setup')).toBeNull();
    expect(screen.getByRole('button', { name: 'Create admin account' }).disabled, 'the button is usable again').toBe(false);
  });
});

describe('the optional photo', () => {
  beforeEach(() => vi.spyOn(imageResize, 'fileToAvatarDataUrl').mockResolvedValue('data:image/png;base64,PICKED'));

  test('★ a picked photo is saved with PUT /auth/me AFTER the new admin is signed in, then the signed-in user is refreshed', async () => {
    const { user, auth } = mount();
    await toAccount(user);
    pickFile(await screen.findByLabelText('Add photo'));
    await screen.findByLabelText('Change photo');
    await fillAccount(user);
    await user.click(screen.getByRole('button', { name: 'Create admin account' }));
    await waitFor(() => expect(putSpy).toHaveBeenCalledWith('/auth/me', { photo: 'data:image/png;base64,PICKED' }, expect.anything()));
    expect(postSpy.mock.calls[0][1], 'the setup request itself never carries the photo').not.toHaveProperty('photo');
    expect(auth.login.mock.invocationCallOrder[0], 'sign in first').toBeLessThan(putSpy.mock.invocationCallOrder[0]);
    await waitFor(() => expect(auth.refresh).toHaveBeenCalled());
    expect(await screen.findByText('at /setup')).toBeTruthy();
  });

  test('★ a photo that cannot be saved does not stop the new admin: they are still signed in and taken on', async () => {
    putSpy.mockRejectedValue(new Error('Photo too big'));
    const { user, auth } = mount();
    await toAccount(user);
    pickFile(await screen.findByLabelText('Add photo'));
    await screen.findByLabelText('Change photo');
    await fillAccount(user);
    await user.click(screen.getByRole('button', { name: 'Create admin account' }));
    expect(await screen.findByText('at /setup')).toBeTruthy();
    expect(auth.login).toHaveBeenCalled();
    expect(screen.queryByText('Photo too big'), 'nothing to show: they have left the form').toBeNull();
  });

  test('an unreadable photo says why and sends nothing; Remove clears a picked one', async () => {
    imageResize.fileToAvatarDataUrl.mockRejectedValueOnce(new Error('That image is too large'));
    const { user } = mount();
    await toAccount(user);
    pickFile(await screen.findByLabelText('Add photo'));
    expect(await screen.findByText('That image is too large')).toBeTruthy();
    expect(postSpy).not.toHaveBeenCalled();
    pickFile(screen.getByLabelText('Add photo'));
    await user.click(await screen.findByRole('button', { name: 'Remove' }));
    expect(screen.getByLabelText('Add photo')).toBeTruthy();
  });
});
