import { beforeEach, describe, expect, test, vi } from 'vitest';
import { screen, waitFor, act } from '@testing-library/react';
import { Routes, Route, useLocation } from 'react-router-dom';
import { renderAsAdmin, renderAsCaregiver } from './helpers/render.jsx';
import { SetupGate } from '../src/App.jsx';
import Setup from '../src/pages/Setup.jsx';
import { setupApi } from '../src/lib/setupApi.js';
import { api } from '../src/lib/api.js';

vi.mock('../src/lib/setupApi.js', () => ({ setupApi: {
  read: vi.fn(), progress: vi.fn(), startTest: vi.fn(), confirm: vi.fn(), complete: vi.fn(),
} }));
vi.mock('../src/lib/api.js', async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, api: { ...original.api, get: vi.fn(), post: vi.fn() } };
});
vi.mock('../src/components/CameraTile.jsx', () => ({ default: ({ frameTestId, onFrames }) =>
  <button onClick={() => onFrames(frameTestId)}>Present video frames</button> }));
vi.mock('../src/components/CameraForm.jsx', () => ({ default: ({ onCreated }) =>
  <button onClick={() => onCreated({ id: 'camera-1' })}>Add camera form</button> }));

const child = { id: 'child-1', name: 'A child' };
const camera = { id: 'camera-1', name: 'Camera', child_id: child.id, disabled: false };
const readiness = { hasChild: true, cameraAssigned: true, playbackAttested: false, ready: false, missing: ['PLAYBACK'] };
let state;

function initial(status = 'not_started', activeStep = 'welcome') {
  return { status, activeStep, flowVersion: 1, rowVersion: 0,
    steps: ['welcome', 'children', 'camera', 'monitor_test', 'caregivers', 'remote', 'review'], readiness };
}

function Path() { return <span data-testid="path">{useLocation().pathname}</span>; }

beforeEach(() => {
  vi.clearAllMocks();
  state = initial();
  setupApi.read.mockImplementation(async () => state);
  setupApi.progress.mockImplementation(async (step, version) => {
    expect(version).toBe(state.rowVersion);
    state = { ...state, status: 'in_progress', activeStep: step, rowVersion: version + 1 };
    return state;
  });
  setupApi.startTest.mockResolvedValue({ testId: 'test-1', expiresAt: 'later' });
  setupApi.confirm.mockResolvedValue({ ok: true });
  setupApi.complete.mockImplementation(async (limited) => ({ status: limited ? 'completed_limited' : 'completed' }));
  api.get.mockResolvedValue({ demo: false });
  api.post.mockResolvedValue({ id: child.id });
});

describe('setup handoff', () => {
  function gate(route = '/', role = 'admin') {
    const ui = <SetupGate user={{ id: 'user-1', role }}><Path /><Routes>
      <Route path="/" element={<span>Live view</span>} />
      <Route path="/setup" element={<span>Setup route</span>} />
    </Routes></SetupGate>;
    return role === 'admin' ? renderAsAdmin(ui, { route }) : renderAsCaregiver(ui, { route });
  }

  test('a fresh admin is redirected once', async () => {
    gate();
    await waitFor(() => expect(screen.getByTestId('path')).toHaveTextContent('/setup'));
    expect(screen.queryByRole('button', { name: 'Finish setting up' })).not.toBeInTheDocument();
  });

  test('a late older setup read cannot replace a published progress state', async () => {
    let resolveRead;
    setupApi.read.mockImplementationOnce(() => new Promise((resolve) => { resolveRead = resolve; }));
    gate();
    await act(async () => {
      window.dispatchEvent(new CustomEvent('setup-state-changed', { detail: { ...initial('in_progress', 'camera'), rowVersion: 2 } }));
    });
    await act(async () => { resolveRead(initial()); });
    expect(screen.getByTestId('path')).toHaveTextContent('/');
    expect(screen.getByRole('button', { name: 'Finish setting up' })).toBeInTheDocument();
  });

  test('fresh handoff, Save and exit, then refresh stays on Live with the banner', async () => {
    const ui = <SetupGate user={{ id: 'user-1', role: 'admin' }}><Path /><Routes>
      <Route path="/" element={<span>Live view</span>} />
      <Route path="/setup" element={<Setup />} />
    </Routes></SetupGate>;
    const first = renderAsAdmin(ui);
    await first.user.click(await screen.findByRole('button', { name: 'Save and exit' }));
    await waitFor(() => expect(screen.getByTestId('path')).toHaveTextContent('/'));
    expect(await screen.findByRole('button', { name: 'Finish setting up' })).toBeInTheDocument();
    first.unmount();
    renderAsAdmin(ui);
    await waitFor(() => expect(screen.getByTestId('path')).toHaveTextContent('/'));
    expect(screen.getByRole('button', { name: 'Finish setting up' })).toBeInTheDocument();
  });

  test('Save and exit state persists across a refresh and shows the banner', async () => {
    state = initial('in_progress', 'camera');
    const first = gate();
    expect(await screen.findByRole('button', { name: 'Finish setting up' })).toBeInTheDocument();
    first.unmount();
    gate();
    expect(await screen.findByRole('button', { name: 'Finish setting up' })).toBeInTheDocument();
    expect(screen.getByTestId('path')).toHaveTextContent('/');
  });

  test('limited completion keeps the banner without redirecting', async () => {
    state = initial('completed_limited', 'review');
    gate();
    expect(await screen.findByRole('button', { name: 'Finish setting up' })).toBeInTheDocument();
    expect(screen.getByTestId('path')).toHaveTextContent('/');
  });

  test('caregiver, demo and legacy installs are never redirected or shown the banner', async () => {
    const caregiver = gate('/', 'caregiver');
    expect(screen.getByTestId('path')).toHaveTextContent('/');
    caregiver.unmount();
    api.get.mockResolvedValueOnce({ demo: true });
    const demo = gate();
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/auth/status'));
    expect(screen.getByTestId('path')).toHaveTextContent('/');
    demo.unmount();
    state = initial('legacy_completed', 'review');
    gate();
    await waitFor(() => expect(setupApi.read).toHaveBeenCalled());
    expect(screen.getByTestId('path')).toHaveTextContent('/');
    expect(screen.queryByRole('button', { name: 'Finish setting up' })).not.toBeInTheDocument();
  });
});

describe('setup steps', () => {
  function wizard({ kids = [child], cameras = [camera], camerasLoaded = true } = {}) {
    return renderAsAdmin(<><Path /><Routes><Route path="/setup" element={<Setup />} /><Route path="/" element={<span>Live view</span>} /><Route path="/settings/users/new" element={<span>New caregiver</span>} /><Route path="/settings/remote-access" element={<span>Remote access</span>} /></Routes></>,
      { route: '/setup', kids, cameras, camerasLoaded });
  }

  test('waits for the child and camera lists before offering to add one', async () => {
    const view = wizard({ kids: [], cameras: [], camerasLoaded: false });
    expect(await screen.findByText('Loading children and cameras…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Continue' })).not.toBeInTheDocument();
    view.rerenderWith({ camerasLoaded: true });
    await view.user.click(await screen.findByRole('button', { name: 'Get started' }));
    expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument();
  });

  test('refresh resume selects an assigned camera after its list arrives', async () => {
    state = initial('in_progress', 'monitor_test');
    const view = wizard({ kids: [], cameras: [], camerasLoaded: false });
    expect(await screen.findByText('Loading children and cameras…')).toBeInTheDocument();
    view.rerenderWith({ kids: [child], cameras: [camera], camerasLoaded: true });
    expect(await screen.findByRole('button', { name: 'Run picture check' })).toBeEnabled();
  });

  test('admin completes the steps only after this browser reports frames', async () => {
    const view = wizard();
    await view.user.click(await screen.findByRole('button', { name: 'Get started' }));
    expect(screen.getByRole('heading', { name: 'Add your child' })).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Step 1 of 6' })).toBeInTheDocument();
    await view.user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByRole('heading', { name: 'Connect your camera' })).toBeInTheDocument();
    await view.user.click(screen.getByRole('button', { name: 'Check picture' }));
    expect(screen.getByRole('heading', { name: 'Test your monitor' })).toBeInTheDocument();
    await view.user.click(screen.getByRole('button', { name: 'Run picture check' }));
    expect(setupApi.confirm).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Open my monitor' })).not.toBeInTheDocument();
    expect(setupApi.complete).not.toHaveBeenCalled();
    await view.user.click(screen.getByRole('button', { name: 'Present video frames' }));
    await waitFor(() => expect(setupApi.confirm).toHaveBeenCalledWith('test-1', camera.id));
    await view.user.click(await screen.findByRole('button', { name: 'Continue' }));
    expect(screen.getByRole('heading', { name: 'Invite caregivers' })).toBeInTheDocument();
    await view.user.click(screen.getByRole('button', { name: 'Skip for now' }));
    expect(screen.getByRole('heading', { name: 'Watch from anywhere' })).toBeInTheDocument();
    await view.user.click(screen.getByRole('button', { name: 'Maybe later' }));
    await view.user.click(screen.getByRole('button', { name: 'Open my monitor' }));
    expect(setupApi.complete).toHaveBeenCalledWith(false);
    await waitFor(() => expect(screen.getByTestId('path')).toHaveTextContent('/'));
  });

  test('adding the first child leads to the shared camera form', async () => {
    const view = wizard({ kids: [], cameras: [] });
    await view.user.click(await screen.findByRole('button', { name: 'Get started' }));
    await view.user.type(screen.getByRole('textbox', { name: "Child's name" }), 'A child');
    await view.user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(api.post).toHaveBeenCalledWith('/children', { name: 'A child' });
    await view.user.click(screen.getByRole('button', { name: /Add a camera manually/ }));
    expect(await screen.findByRole('button', { name: 'Add camera form' })).toBeInTheDocument();
  });

  test.each([['2024-02-29', { name: 'A child', birthday: '2024-02-29' }], ['', { name: 'A child' }]])('child birthday %s is sent only when entered', async (date, expected) => {
    const view = wizard({ kids: [], cameras: [] });
    await view.user.click(await screen.findByRole('button', { name: 'Get started' }));
    await view.user.type(screen.getByRole('textbox', { name: "Child's name" }), 'A child');
    if (date) await view.user.type(screen.getByLabelText('Date of birth (optional)'), date);
    await view.user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(api.post).toHaveBeenCalledWith('/children', expected);
  });

  test('the optional steps save progress before leaving for settings', async () => {
    state = initial('in_progress', 'caregivers');
    const view = wizard();
    await view.user.click(await screen.findByRole('button', { name: 'Add a caregiver account' }));
    expect(setupApi.progress).toHaveBeenCalledWith('remote', 0);
    expect(screen.getByTestId('path')).toHaveTextContent('/settings/users/new');
  });

  test.each([['caregivers', 'Add a caregiver account'], ['remote', 'Set up remote access']])('a refused progress save on the %s step keeps the admin on the wizard', async (step, label) => {
    // Save-before-navigate must be enforced, not just ordered by luck: a failed save may not leave the page (#947 review).
    state = initial('in_progress', step);
    setupApi.progress.mockRejectedValueOnce(new Error('Could not save'));
    const view = wizard();
    await view.user.click(await screen.findByRole('button', { name: label }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save');
    expect(screen.getByTestId('path')).not.toHaveTextContent('/settings');
  });

  test('the app header (with a way back to Settings) shows while the setup status loads and when the read fails', async () => {
    setupApi.read.mockImplementation(() => new Promise(() => {}));
    const first = wizard();
    expect(await screen.findByRole('button', { name: 'Back to Settings' })).toBeInTheDocument();
    first.unmount();
    setupApi.read.mockRejectedValue(new Error('offline'));
    wizard();
    expect(await screen.findByRole('alert')).toHaveTextContent('offline');
    expect(screen.getByRole('button', { name: 'Back to Settings' })).toBeInTheDocument();
  });

  test('remote access saves review before leaving for settings', async () => {
    state = initial('in_progress', 'remote');
    const view = wizard();
    await view.user.click(await screen.findByRole('button', { name: 'Set up remote access' }));
    expect(setupApi.progress).toHaveBeenCalledWith('review', 0);
    expect(screen.getByTestId('path')).toHaveTextContent('/settings/remote-access');
  });

  test.each(['completed', 'legacy_completed'])('%s setup uses the app header and Settings back button', async (status) => {
    state = initial(status, 'review');
    wizard();
    expect(await screen.findByRole('heading', { name: 'Setup' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back to Settings' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save and exit' })).not.toBeInTheDocument();
  });

  test('limited setup is explicit and can resume at the saved step', async () => {
    state = initial('in_progress', 'monitor_test');
    const view = wizard();
    await view.user.click(await screen.findByRole('button', { name: 'Continue with limited setup' }));
    await view.user.click(screen.getByRole('button', { name: 'Skip for now' }));
    await view.user.click(screen.getByRole('button', { name: 'Maybe later' }));
    await view.user.click(await screen.findByRole('button', { name: 'Finish with limited setup' }));
    expect(setupApi.complete).toHaveBeenCalledWith(true);
  });

  test('an expired proof offers both a fresh picture check and limited completion', async () => {
    state = { ...initial('in_progress', 'review'), readiness: { ...readiness, playbackAttested: true, ready: true, missing: [] } };
    setupApi.complete.mockRejectedValueOnce(Object.assign(new Error('Not ready'), {
      status: 409, data: { code: 'NOT_READY', missing: ['PLAYBACK'] },
    }));
    setupApi.read.mockImplementationOnce(async () => state).mockImplementation(async () => ({ ...state, readiness }));
    const view = wizard();
    await view.user.click(await screen.findByRole('button', { name: 'Open my monitor' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The picture check has expired');
    expect(screen.getByRole('button', { name: 'Run picture check' })).toBeInTheDocument();
    await view.user.click(screen.getByRole('button', { name: 'Continue with limited setup' }));
    expect(screen.getByRole('button', { name: 'Finish with limited setup' })).toBeInTheDocument();
  });

  test.each(['completed', 'completed_limited', 'legacy_completed'])('%s diagnostics offers a picture check', async (status) => {
    state = initial(status, 'review');
    wizard();
    expect(await screen.findByRole('button', { name: 'Run picture check' })).toBeInTheDocument();
    if (status === 'completed_limited') expect(screen.queryByRole('heading', { name: 'Setup' })).not.toBeInTheDocument();
    expect(setupApi.progress).not.toHaveBeenCalled();
  });

  test('a 409 reloads the server step and does not overwrite it', async () => {
    setupApi.progress.mockRejectedValueOnce(Object.assign(new Error('Stale'), { status: 409 }));
    state = initial('in_progress', 'welcome');
    const view = wizard();
    await view.user.click(await screen.findByRole('button', { name: 'Get started' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Setup changed in another tab');
    expect(screen.getByRole('button', { name: 'Get started' })).toBeInTheDocument();
  });

  test('Save and exit writes the current step before returning to Live', async () => {
    state = initial('in_progress', 'camera');
    const view = wizard();
    await view.user.click(await screen.findByRole('button', { name: 'Save and exit' }));
    expect(setupApi.progress).toHaveBeenCalledWith('camera', 0);
    expect(screen.getByTestId('path')).toHaveTextContent('/');
  });

  test('a legacy install stays read-only until the picture check passes', async () => {
    state = initial('legacy_completed', 'review');
    const view = wizard();
    await view.user.click(await screen.findByRole('button', { name: 'Run picture check' }));
    expect(setupApi.progress).not.toHaveBeenCalled();
    await view.user.click(screen.getByRole('button', { name: 'Run picture check' }));
    expect(setupApi.complete).not.toHaveBeenCalled();
    await view.user.click(screen.getByRole('button', { name: 'Present video frames' }));
    await view.user.click(await screen.findByRole('button', { name: 'Continue' }));
    await view.user.click(screen.getByRole('button', { name: 'Open my monitor' }));
    expect(setupApi.complete).toHaveBeenCalledWith(false);
  });
});
