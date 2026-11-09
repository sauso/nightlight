import { beforeEach, describe, expect, test, vi } from 'vitest';
import { screen, waitFor, act, fireEvent } from '@testing-library/react';
import { Routes, Route, useLocation } from 'react-router-dom';
import { renderAsAdmin, renderAsCaregiver } from './helpers/render.jsx';
import { SetupGate } from '../src/App.jsx';
import Setup from '../src/pages/Setup.jsx';
import { setupApi } from '../src/lib/setupApi.js';
import { api } from '../src/lib/api.js';
import * as imageResize from '../src/lib/imageResize.js';

vi.mock('../src/lib/setupApi.js', () => ({ setupApi: {
  read: vi.fn(), progress: vi.fn(), startTest: vi.fn(), confirm: vi.fn(), complete: vi.fn(),
} }));
vi.mock('../src/lib/api.js', async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, api: { ...original.api, get: vi.fn(), post: vi.fn() } };
});
vi.mock('../src/components/CameraTile.jsx', () => ({ default: ({ frameTestId, onFrames }) =>
  <button onClick={() => onFrames(frameTestId)}>Present video frames</button> }));
vi.mock('../src/components/CameraForm.jsx', () => ({ default: ({ onCreated, prefill }) =>
  <button onClick={() => onCreated({ id: 'camera-1' })}>Add camera form {prefill?.host || ''}</button> }));
vi.mock('../src/components/CameraDiscovery.jsx', () => ({ default: ({ onPick, children }) => <>
  <button onClick={() => onPick({ id: 'cam-a', ip: '192.168.1.2', name: 'cam-a', rtspPort: 8554 })}>Pick cam-a</button>
  {children}
</> }));

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
  api.get.mockImplementation(async (path) => path === '/remote-access/tailscale'
    ? { enabled: false, state: 'off', blocker: null, hostname: 'nightlight', serve: { enabled: false }, video_address_pending: false }
    : { demo: false });
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
    expect(await screen.findByRole('button', { name: 'Continue' })).toBeInTheDocument();
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
    // The guide opens on "Add your child": the welcome screen now comes before the admin account (FirstRun.jsx).
    expect(await screen.findByRole('heading', { name: 'Add your child' })).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Step 2 of 7' })).toBeInTheDocument();
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
    await view.user.type(await screen.findByRole('textbox', { name: "Child's name" }), 'A child');
    await view.user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(api.post).toHaveBeenCalledWith('/children', { name: 'A child' });
    await view.user.click(screen.getByRole('button', { name: /Add a camera manually/ }));
    expect(await screen.findByRole('button', { name: 'Add camera form' })).toBeInTheDocument();
  });

  test('picking a suggestion opens the login card, with advanced settings in the manual card', async () => {
    state = initial('in_progress', 'camera');
    const view = wizard();
    await view.user.click(await screen.findByRole('button', { name: 'Pick cam-a' }));
    expect(screen.getByRole('form', { name: 'Connect cam-a' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Camera IP address')).toBeNull();
    await view.user.click(screen.getByRole('button', { name: 'Advanced settings' }));
    expect(screen.getByRole('button', { name: 'Add camera form 192.168.1.2' })).toBeInTheDocument();
  });

  test.each([['2024-02-29', { name: 'A child', birthday: '2024-02-29' }], ['', { name: 'A child' }]])('child birthday %s is sent only when entered', async (date, expected) => {
    const view = wizard({ kids: [], cameras: [] });
    await view.user.type(await screen.findByRole('textbox', { name: "Child's name" }), 'A child');
    if (date) await view.user.type(screen.getByLabelText('Date of birth (optional)'), date);
    await view.user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(api.post).toHaveBeenCalledWith('/children', expected);
  });

  describe('the first child\'s photo (owner, 2026-11-06)', () => {
    const pick = () => fireEvent.change(screen.getByLabelText('Add photo'), { target: { files: [new File(['x'], 'p.png', { type: 'image/png' })] } });

    test('★ a picked photo is held, then sent in the same POST /children that creates the child; no photo means no photo field', async () => {
      const spy = vi.spyOn(imageResize, 'fileToAvatarDataUrl').mockResolvedValue('data:image/png;base64,KID');
      try {
        const view = wizard({ kids: [], cameras: [] });
        await view.user.type(await screen.findByRole('textbox', { name: "Child's name" }), 'A child');
        pick();
        await screen.findByLabelText('Change photo');
        expect(api.post, 'nothing is sent until Continue').not.toHaveBeenCalled();
        await view.user.click(screen.getByRole('button', { name: 'Continue' }));
        expect(api.post).toHaveBeenCalledWith('/children', { name: 'A child', photo: 'data:image/png;base64,KID' });
      } finally { spy.mockRestore(); }
    });

    test('Remove drops the picked photo, so it is not sent', async () => {
      const spy = vi.spyOn(imageResize, 'fileToAvatarDataUrl').mockResolvedValue('data:image/png;base64,KID');
      try {
        const view = wizard({ kids: [], cameras: [] });
        await view.user.type(await screen.findByRole('textbox', { name: "Child's name" }), 'A child');
        pick();
        await view.user.click(await screen.findByRole('button', { name: 'Remove' }));
        await view.user.click(screen.getByRole('button', { name: 'Continue' }));
        expect(api.post).toHaveBeenCalledWith('/children', { name: 'A child' });
      } finally { spy.mockRestore(); }
    });

    test('an unreadable photo says why and adds no photo to the child', async () => {
      const spy = vi.spyOn(imageResize, 'fileToAvatarDataUrl').mockRejectedValue(new Error('That image is too large'));
      try {
        const view = wizard({ kids: [], cameras: [] });
        await view.user.type(await screen.findByRole('textbox', { name: "Child's name" }), 'A child');
        pick();
        expect(await screen.findByRole('alert')).toHaveTextContent('That image is too large');
        await view.user.click(screen.getByRole('button', { name: 'Continue' }));
        expect(api.post).toHaveBeenCalledWith('/children', { name: 'A child' });
      } finally { spy.mockRestore(); }
    });
  });

  test('★ the caregivers step is part of the guide: no jump to Settings, and Skip saves progress and moves on', async () => {
    // Owner, 2026-11-05: "Add a caregiver account" used to leave for Settings, which broke the guide's feel.
    state = initial('in_progress', 'caregivers');
    const view = wizard();
    expect(await screen.findByLabelText('Username'), 'the form is on the step itself').toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add a caregiver account' })).toBeNull();
    await view.user.click(screen.getByRole('button', { name: 'Skip for now' }));
    expect(setupApi.progress).toHaveBeenCalledWith('remote', 0);
    expect(screen.getByTestId('path')).not.toHaveTextContent('/settings');
  });

  test('★ adding a caregiver in the guide turns the footer into Continue, and Continue still saves progress', async () => {
    state = initial('in_progress', 'caregivers');
    api.post.mockResolvedValue({ id: 'u-new' });
    const view = wizard();
    await view.user.type(await screen.findByLabelText('Username'), 'nanny');
    await view.user.type(screen.getByLabelText('Password'), 'correct horse');
    await view.user.click(screen.getByRole('button', { name: 'Add caregiver' }));
    expect(await screen.findByRole('button', { name: 'Continue' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Skip for now' })).toBeNull();
    await view.user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(setupApi.progress).toHaveBeenCalledWith('remote', 0);
  });

  test.each([['caregivers', 'Skip for now'], ['remote', 'Maybe later']])('a refused progress save on the %s step keeps the admin on the wizard', async (step, label) => {
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

  test('remote step shows the Tailscale card and Maybe later saves review', async () => {
    state = initial('in_progress', 'remote');
    const view = wizard();
    expect(await screen.findByRole('button', { name: 'Turn on Tailscale' })).toBeInTheDocument();
    await view.user.click(await screen.findByRole('button', { name: 'Maybe later' }));
    expect(setupApi.progress).toHaveBeenCalledWith('review', 0);
    expect(screen.getByRole('heading', { name: "You're all set!" })).toBeInTheDocument();
  });

  test('★ remote step: a connected card with its secure address turns "Maybe later" into "Continue"', async () => {
    api.get.mockImplementation(async (path) => path === '/remote-access/tailscale'
      ? { enabled: true, state: 'connected', blocker: null, hostname: 'nightlight', dns_name: 'nightlight.example.ts.net',
        addresses: ['100.101.102.103'], serve: { enabled: true }, video_address_pending: false }
      : { demo: false });
    state = initial('in_progress', 'remote');
    const view = wizard();
    expect(await screen.findByText('https://nightlight.example.ts.net/')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Maybe later' })).toBeNull();
    await view.user.click(await screen.findByRole('button', { name: 'Continue' }));
    expect(setupApi.progress).toHaveBeenCalledWith('review', 0);
  });

  test('remote step: connected but without the secure address yet is still "Maybe later"', async () => {
    api.get.mockImplementation(async (path) => path === '/remote-access/tailscale'
      ? { enabled: true, state: 'connected', blocker: null, hostname: 'nightlight', dns_name: 'nightlight.example.ts.net',
        addresses: ['100.101.102.103'], serve: { enabled: false }, video_address_pending: false }
      : { demo: false });
    state = initial('in_progress', 'remote');
    wizard();
    expect(await screen.findByRole('button', { name: 'Turn on the secure address' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Maybe later' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
  });

  // The navigation (bottom bar / sidebar) is hidden by CSS while this class is on <html>: the page is what decides when.
  const navHidden = () => document.documentElement.classList.contains('setup-wizard');

  test.each(['not_started', 'in_progress', 'completed_limited'])('★ the navigation is hidden while the guide is running (%s)', async (status) => {
    state = initial(status, 'review');
    const view = wizard();
    await screen.findByRole('heading', { name: "You're all set!" });
    expect(navHidden()).toBe(true);
    view.unmount();
    expect(navHidden(), 'leaving the page gives the navigation back').toBe(false);
  });

  test.each(['completed', 'legacy_completed'])('★ the finished guide (%s) keeps the navigation', async (status) => {
    state = initial(status, 'review');
    wizard();
    await screen.findByRole('heading', { name: 'Setup' });
    expect(navHidden()).toBe(false);
  });

  test('★ Save and exit gives the navigation back', async () => {
    state = initial('in_progress', 'remote');
    const view = wizard();
    await view.user.click(await screen.findByRole('button', { name: 'Save and exit' }));
    await waitFor(() => expect(navHidden()).toBe(false));
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
    state = initial('in_progress', 'caregivers');
    const view = wizard();
    await view.user.click(await screen.findByRole('button', { name: 'Skip for now' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Setup changed in another tab');
    expect(screen.getByRole('button', { name: 'Skip for now' }), 'still on the step the server holds').toBeInTheDocument();
  });

  test('★ a new installation opens the guide on "Add your child": no Welcome step, no Back, no photo control', async () => {
    // The Welcome screen moved BEFORE the admin account (FirstRun.jsx, owner 2026-11-06), and the server still stores `welcome` as a
    // new installation's first step, which is shown as the first real step.
    state = initial('not_started', 'welcome');
    wizard();
    expect(await screen.findByRole('heading', { name: 'Add your child' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Welcome to Nightlight' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Back' }), 'nothing before the first step').toBeNull();
    expect(screen.queryByRole('button', { name: 'Get started' })).toBeNull();
    expect(screen.queryByLabelText('Add photo')).toBeNull();
    // Creating the account was Step 1 (FirstRun.jsx, owner 2026-11-06), so the guide opens on Step 2 of 7 with the first segment done.
    const bar = screen.getByRole('progressbar', { name: 'Step 2 of 7' });
    expect([...bar.children].map((segment) => segment.className).slice(0, 3)).toEqual(['is-complete', 'is-current', '']);
    expect(bar.children).toHaveLength(7);
  });

  test('the second step still has a Back that returns to the first', async () => {
    state = initial('in_progress', 'camera');
    const view = wizard();
    await view.user.click(await screen.findByRole('button', { name: 'Back' }));
    expect(setupApi.progress).toHaveBeenCalledWith('children', 0);
    expect(await screen.findByRole('heading', { name: 'Add your child' })).toBeInTheDocument();
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
