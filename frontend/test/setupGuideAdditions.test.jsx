// Adding caregivers inside the setup guide instead of jumping to Settings (owner, 2026-11-05). It goes through a request that
// already existed (POST /auth/users), so these tests are about what the guide SENDS and what it does with the answer, including
// the failure paths. (The admin's own photo moved to the first-run account form: see firstRun.test.jsx.)
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { renderAs, ADMIN } from './helpers/render.jsx';
import SetupCaregivers from '../src/components/SetupCaregivers.jsx';
import { api } from '../src/lib/api.js';
import * as imageResize from '../src/lib/imageResize.js';
import { resetDemoStatusForTests } from '../src/lib/demoStatus.js';

let postSpy;

beforeEach(() => {
  resetDemoStatusForTests();
  vi.spyOn(api, 'get').mockResolvedValue({ demo: false });
  postSpy = vi.spyOn(api, 'post').mockResolvedValue({ id: 'u-new' });
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
