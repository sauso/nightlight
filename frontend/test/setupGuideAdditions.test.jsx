// Two additions to the setup guide (owner, 2026-11-05): add caregivers inside the guide instead of jumping to Settings, and the
// admin's own photo on the Welcome step. Both go through requests that already existed (POST /auth/users and PUT /auth/me), so
// these tests are about what the guide SENDS and what it does with the answer, including the failure paths.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { renderAs, ADMIN } from './helpers/render.jsx';
import SetupCaregivers from '../src/components/SetupCaregivers.jsx';
import SetupOwnPhoto from '../src/components/SetupOwnPhoto.jsx';
import { api } from '../src/lib/api.js';
import * as imageResize from '../src/lib/imageResize.js';
import { resetDemoStatusForTests } from '../src/lib/demoStatus.js';

let postSpy;
let putSpy;

beforeEach(() => {
  resetDemoStatusForTests();
  vi.spyOn(api, 'get').mockResolvedValue({ demo: false });
  postSpy = vi.spyOn(api, 'post').mockResolvedValue({ id: 'u-new' });
  putSpy = vi.spyOn(api, 'put').mockResolvedValue({});
});
afterEach(() => vi.restoreAllMocks());

async function fill(user, { first = '', last = '', username = 'nanny', password = 'correct horse' } = {}) {
  if (first) await user.type(await screen.findByLabelText('First name'), first);
  if (last) await user.type(screen.getByLabelText('Last name'), last);
  await user.type(await screen.findByLabelText('Username'), username);
  await user.type(screen.getByLabelText('Password'), password);
}

describe('adding caregivers inside the guide', () => {
  test('★ one caregiver: the request carries a fixed caregiver role and nothing else, and the form is cleared (password too)', async () => {
    const onAdded = vi.fn();
    const { user } = renderAs(ADMIN, <SetupCaregivers onAdded={onAdded} />);
    await fill(user, { first: 'Nanny', last: 'McPhee' });
    await user.click(screen.getByRole('button', { name: 'Add caregiver' }));
    await waitFor(() => expect(postSpy).toHaveBeenCalledTimes(1));
    expect(postSpy.mock.calls[0][0]).toBe('/auth/users');
    expect(postSpy.mock.calls[0][1], 'exactly these fields: no photo when none was picked').toEqual({
      username: 'nanny', password: 'correct horse', role: 'caregiver', first_name: 'Nanny', last_name: 'McPhee',
    });
    expect(await screen.findByText(/Nanny McPhee/)).toBeTruthy();
    expect(onAdded).toHaveBeenCalledWith(1);
    expect(screen.getByLabelText('Username').value).toBe('');
    expect(screen.getByLabelText('Password').value, 'the password does not outlive the request').toBe('');
    expect(screen.getByRole('button', { name: 'Add another caregiver' })).toBeTruthy();
  });

  test('a second caregiver is added the same way and the count goes up', async () => {
    const onAdded = vi.fn();
    const { user } = renderAs(ADMIN, <SetupCaregivers onAdded={onAdded} />);
    await fill(user, { username: 'one' });
    await user.click(screen.getByRole('button', { name: 'Add caregiver' }));
    await screen.findByText(/one/);
    await fill(user, { username: 'two' });
    await user.click(screen.getByRole('button', { name: 'Add another caregiver' }));
    await waitFor(() => expect(onAdded).toHaveBeenLastCalledWith(2));
    expect(postSpy).toHaveBeenCalledTimes(2);
  });

  test('★ the server refusing (a taken username) shows its message, adds nothing, and keeps what was typed except the password stays out of the message', async () => {
    postSpy.mockRejectedValue(new Error('That username is already taken'));
    const onAdded = vi.fn();
    const { user } = renderAs(ADMIN, <SetupCaregivers onAdded={onAdded} />);
    await fill(user, { first: 'Nanny', username: 'nanny', password: 'hunter2hunter2' });
    await user.click(screen.getByRole('button', { name: 'Add caregiver' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('That username is already taken');
    expect(alert.textContent).not.toContain('hunter2hunter2');
    expect(onAdded).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Caregivers you added')).toBeNull();
    expect(screen.getByLabelText('Username').value, 'what was typed is kept so it can be fixed').toBe('nanny');
  });

  test('★ a short password is stopped by the form before any request, and says why', async () => {
    const onAdded = vi.fn();
    const { user } = renderAs(ADMIN, <SetupCaregivers onAdded={onAdded} />);
    await fill(user, { password: 'short' });
    await user.click(screen.getByRole('button', { name: 'Add caregiver' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Password must be at least 8 characters');
    expect(postSpy).not.toHaveBeenCalled();
    expect(onAdded).not.toHaveBeenCalled();
  });

  test('a picked photo rides along in the request; an unreadable one says why and sends nothing', async () => {
    const readPhoto = vi.spyOn(imageResize, 'fileToAvatarDataUrl').mockResolvedValue('data:image/png;base64,PICKED');
    const { user } = renderAs(ADMIN, <SetupCaregivers />);
    fireEvent.change(await screen.findByLabelText('Add photo'), { target: { files: [new File(['x'], 'p.png', { type: 'image/png' })] } });
    await waitFor(() => expect(readPhoto).toHaveBeenCalled());
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Add caregiver' }));
    await waitFor(() => expect(postSpy).toHaveBeenCalled());
    expect(postSpy.mock.calls[0][1].photo).toBe('data:image/png;base64,PICKED');
  });

  test('an unreadable photo shows its reason and nothing is sent', async () => {
    vi.spyOn(imageResize, 'fileToAvatarDataUrl').mockRejectedValue(new Error('That image is too large'));
    renderAs(ADMIN, <SetupCaregivers />);
    fireEvent.change(await screen.findByLabelText('Add photo'), { target: { files: [new File(['x'], 'p.png', { type: 'image/png' })] } });
    expect(await screen.findByText('That image is too large')).toBeTruthy();
    expect(postSpy).not.toHaveBeenCalled();
  });

  test('a read-only demo cannot add anyone', async () => {
    resetDemoStatusForTests();
    api.get.mockResolvedValue({ demo: { label: 'demo' } });
    renderAs(ADMIN, <SetupCaregivers />);
    await screen.findByText(/read-only/);
    expect(screen.getByLabelText('Username').disabled).toBe(true);
    expect(postSpy).not.toHaveBeenCalled();
  });
});

describe('the admin photo on the Welcome step', () => {
  beforeEach(() => vi.spyOn(imageResize, 'fileToAvatarDataUrl').mockResolvedValue('data:image/png;base64,PICKED'));

  test('★ picking a photo saves it to your own account (only the photo) and refreshes the signed-in user', async () => {
    const view = renderAs({ ...ADMIN, photo: null }, <SetupOwnPhoto />);
    fireEvent.change(await screen.findByLabelText('Add photo'), { target: { files: [new File(['x'], 'p.png', { type: 'image/png' })] } });
    await waitFor(() => expect(putSpy).toHaveBeenCalledWith('/auth/me', { photo: 'data:image/png;base64,PICKED' }, expect.anything()));
    await waitFor(() => expect(view.auth.refresh).toHaveBeenCalled());
    expect(await screen.findByText('Saved ✓')).toBeTruthy();
  });

  test('a failed save says why and does not claim success', async () => {
    putSpy.mockRejectedValue(new Error('Photo too big'));
    renderAs({ ...ADMIN, photo: null }, <SetupOwnPhoto />);
    fireEvent.change(await screen.findByLabelText('Add photo'), { target: { files: [new File(['x'], 'p.png', { type: 'image/png' })] } });
    expect(await screen.findByRole('alert')).toHaveTextContent('Photo too big');
    expect(screen.queryByText('Saved ✓')).toBeNull();
  });

  test('with a photo there is Remove, which clears it; with none there is not', async () => {
    const { user, unmount } = renderAs({ ...ADMIN, photo: 'data:image/png;base64,AAA' }, <SetupOwnPhoto />);
    await user.click(await screen.findByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(putSpy).toHaveBeenCalledWith('/auth/me', { photo: null }, expect.anything()));
    unmount();
    renderAs({ ...ADMIN, photo: null }, <SetupOwnPhoto />);
    await screen.findByLabelText('Add photo');
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
  });

  test('a read-only demo offers no photo control at all', async () => {
    resetDemoStatusForTests();
    api.get.mockResolvedValue({ demo: { label: 'demo' } });
    const { container } = renderAs({ ...ADMIN, photo: null }, <SetupOwnPhoto />);
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(container.querySelector('.setup-ownphoto')).toBeNull();
  });
});
