import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import { renderAsAdmin } from './helpers/render.jsx';
import AddCameraFlow from '../src/components/AddCameraFlow.jsx';
import { api, SLOW_REQUEST_TIMEOUT_MS } from '../src/lib/api.js';

vi.mock('../src/lib/api.js', async (original) => {
  const module = await original();
  return { ...module, api: { ...module.api, get: vi.fn(), post: vi.fn() } };
});

const cams = [
  { id: 'one', ip: '192.168.1.2', name: '<img onerror=alert(1)>', rtspPort: 8554,
    sources: ['mdns', 'onvif'], product: 'sonoff_s2_t23n_' + 'x'.repeat(90) },
  { id: 'two', ip: '192.168.1.3', name: 'cam-b', rtspPort: 554, sources: ['onvif'], alreadyAdded: true },
];
const kids = [{ id: 'kid-1', name: 'A child' }, { id: 'kid-2', name: 'Another child' }];
const answer = { rtspHost: '192.168.1.2', rtspPort: 7447, rtspPath: '/main', subRtspPath: '/low',
  onvifDeviceUrl: 'http://192.168.1.2/onvif/device', backchannel: 'yes', motionEvents: 'yes',
  ptz: true, profileToken: 'Profile_1' };
const saved = { id: 'saved-1' };

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  api.post.mockImplementation((path) => {
    if (path === '/cameras/discover') return Promise.resolve({ scanId: 'scan-1', endsAt: Date.now() + 30000 });
    if (path === '/cameras/onvif-probe') return Promise.resolve(answer);
    if (path === '/cameras') return Promise.resolve(saved);
    throw new Error(`Unexpected POST ${path}`);
  });
  api.get.mockResolvedValue({ done: true, candidates: cams, endsAt: Date.now() + 30000 });
});
afterEach(() => vi.restoreAllMocks());

async function found(opts = {}) {
  const onCreated = vi.fn();
  const view = renderAsAdmin(<AddCameraFlow onCreated={onCreated} {...opts} />,
    { kids, route: '/cameras/new' });
  await view.user.click(screen.getByRole('button', { name: 'Find cameras on my network' }));
  const list = await screen.findByRole('list', { name: 'Cameras found' });
  return { ...view, onCreated, list };
}

test('each result is a text card; saved cameras stay visible but cannot be selected', async () => {
  const { user, list } = await found();
  const buttons = within(list).getAllByRole('button');
  expect(buttons).toHaveLength(2);
  expect(buttons[0]).toHaveTextContent(cams[0].name);
  expect(buttons[0].querySelector('img')).toBeNull();
  expect(buttons[0]).toHaveTextContent('192.168.1.2');
  expect(buttons[0]).toHaveTextContent('Thingino');
  expect(buttons[0]).toHaveTextContent('ONVIF');
  expect(within(buttons[0]).getByTitle(cams[0].product)).toHaveClass('camera-card__product');
  expect(buttons[1]).toHaveAttribute('aria-disabled', 'true');
  expect(buttons[1]).toHaveTextContent('Already added');
  await user.click(buttons[1]);
  expect(screen.queryByRole('form', { name: /Connect/ })).toBeNull();
});

test('the picked camera asks for name and login, with child choice only when needed', async () => {
  const { user, list } = await found();
  await user.click(within(list).getAllByRole('button')[0]);
  const form = screen.getByRole('form', { name: `Connect ${cams[0].name}` });
  expect(within(form).getByLabelText('Name')).toHaveValue(cams[0].name);
  expect(within(form).getByLabelText('Username')).toBeInTheDocument();
  expect(within(form).getByLabelText('Password')).toHaveAttribute('type', 'password');
  expect(within(form).getByLabelText('Password')).toHaveAttribute('autocomplete', 'off');
  expect(within(form).getByLabelText('Child')).toBeInTheDocument();
  expect(form).toHaveTextContent('192.168.1.2');
  for (const label of ['Camera IP address', 'RTSP port', 'Stream path', 'MQTT topic']) {
    expect(screen.queryByLabelText(label)).toBeNull();
  }
  expect(screen.getByRole('button', { name: /Add a camera manually/ })).toHaveAttribute('aria-expanded', 'false');
});

test('wizard assignment hides the child choice; one child is assigned silently', async () => {
  const view = renderAsAdmin(<AddCameraFlow initialChildId="kid-1" />,
    { kids, route: '/setup' });
  await view.user.click(screen.getByRole('button', { name: 'Find cameras on my network' }));
  const list = await screen.findByRole('list', { name: 'Cameras found' });
  await view.user.click(within(list).getAllByRole('button')[0]);
  expect(screen.queryByLabelText('Child')).toBeNull();
  view.unmount();
  const one = renderAsAdmin(<AddCameraFlow />,
    { kids: [kids[0]], route: '/cameras/new' });
  await one.user.click(screen.getByRole('button', { name: 'Find cameras on my network' }));
  await one.user.click(within(await screen.findByRole('list', { name: 'Cameras found' })).getAllByRole('button')[0]);
  expect(screen.queryByLabelText('Child')).toBeNull();
  await one.user.click(screen.getByRole('button', { name: 'Add camera' }));
  await waitFor(() => expect(api.post).toHaveBeenCalledWith('/cameras',
    expect.objectContaining({ child_id: 'kid-1' }), expect.anything()));
});

test('Add camera probes once, saves merged fields, refreshes, and never stores the password', async () => {
  const { user, list, onCreated, camerasValue } = await found();
  await user.click(within(list).getAllByRole('button')[0]);
  const form = screen.getByRole('form', { name: `Connect ${cams[0].name}` });
  await user.clear(within(form).getByLabelText('Name'));
  await user.type(within(form).getByLabelText('Name'), 'cam-a');
  await user.type(within(form).getByLabelText('Username'), 'viewer');
  await user.type(within(form).getByLabelText('Password'), 'only-in-memory-secret');
  await user.selectOptions(within(form).getByLabelText('Child'), 'kid-2');
  await user.click(within(form).getByRole('button', { name: 'Add camera' }));
  await waitFor(() => expect(onCreated).toHaveBeenCalledWith(saved));
  const probe = api.post.mock.calls.find(([path]) => path === '/cameras/onvif-probe');
  expect(probe).toEqual(['/cameras/onvif-probe',
    { host: '192.168.1.2', username: 'viewer', password: 'only-in-memory-secret', id: undefined },
    { timeoutMs: SLOW_REQUEST_TIMEOUT_MS }]);
  const save = api.post.mock.calls.find(([path]) => path === '/cameras');
  expect(save[1]).toMatchObject({ name: 'cam-a', rtsp_host: '192.168.1.2', rtsp_port: '7447',
    rtsp_path: '/main', sub_rtsp_path: '/low', rtsp_username: 'viewer',
    rtsp_password: 'only-in-memory-secret', child_id: 'kid-2', discovery_source: 'onvif' });
  expect(save[2]).toEqual({ timeoutMs: SLOW_REQUEST_TIMEOUT_MS });
  expect(camerasValue.refresh).toHaveBeenCalled();
  for (const storage of [localStorage, sessionStorage]) {
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      expect(key).not.toContain('only-in-memory-secret');
      expect(storage.getItem(key)).not.toContain('only-in-memory-secret');
    }
  }
});

test('a rejected login shows the server message and does not save or offer manual details', async () => {
  const message = 'The ONVIF username or password appears to be incorrect. Repeated wrong attempts can lock the camera out.';
  api.post.mockImplementation((path) => path === '/cameras/onvif-probe'
    ? Promise.reject(new Error(message)) : Promise.resolve({ scanId: 'scan-1', endsAt: Date.now() + 30000 }));
  const { user, list } = await found();
  await user.click(within(list).getAllByRole('button')[0]);
  await user.click(screen.getByRole('button', { name: 'Add camera' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(message);
  expect(screen.queryByRole('button', { name: 'Enter the stream details yourself' })).toBeNull();
  expect(api.post.mock.calls.filter(([path]) => path === '/cameras')).toHaveLength(0);
});

test('an unavailable ONVIF probe keeps the login card and offers the manual route', async () => {
  api.post.mockImplementation((path) => path === '/cameras/onvif-probe'
    ? Promise.reject(new Error('No ONVIF service on that address'))
    : Promise.resolve({ scanId: 'scan-1', endsAt: Date.now() + 30000 }));
  const { user, list } = await found();
  await user.click(within(list).getAllByRole('button')[0]);
  await user.click(screen.getByRole('button', { name: 'Add camera' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('No ONVIF service');
  expect(screen.getByRole('form', { name: `Connect ${cams[0].name}` })).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Enter the stream details yourself' }));
  expect(screen.getByLabelText('Camera IP address')).toHaveValue('192.168.1.2');
});

test('a refused stream test can be saved anyway without probing again', async () => {
  let count = 0;
  api.post.mockImplementation((path) => {
    if (path === '/cameras/discover') return Promise.resolve({ scanId: 'scan-1', endsAt: Date.now() + 30000 });
    if (path === '/cameras/onvif-probe') return Promise.resolve(answer);
    if (path === '/cameras' && count++ === 0) {
      const err = new Error('Camera stream refused the connection');
      err.data = { needsConfirm: true };
      return Promise.reject(err);
    }
    return Promise.resolve(saved);
  });
  const { user, list, onCreated } = await found();
  await user.click(within(list).getAllByRole('button')[0]);
  await user.click(screen.getByRole('button', { name: 'Add camera' }));
  expect(await screen.findByRole('button', { name: 'Save anyway' })).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Save anyway' }));
  await waitFor(() => expect(onCreated).toHaveBeenCalledWith(saved));
  expect(api.post.mock.calls.filter(([path]) => path === '/cameras/onvif-probe')).toHaveLength(1);
  const saves = api.post.mock.calls.filter(([path]) => path === '/cameras');
  expect(saves[1][1]).toEqual({ ...saves[0][1], force: true });
});

test('advanced settings carries name, address and username into the manual form, but no password', async () => {
  const { user, list } = await found();
  await user.click(within(list).getAllByRole('button')[0]);
  const form = screen.getByRole('form', { name: `Connect ${cams[0].name}` });
  await user.clear(within(form).getByLabelText('Name'));
  await user.type(within(form).getByLabelText('Name'), 'cam-a');
  await user.type(within(form).getByLabelText('Username'), 'viewer');
  await user.type(within(form).getByLabelText('Password'), 'only-in-memory-secret');
  await user.click(within(form).getByRole('button', { name: 'Advanced settings' }));
  expect(screen.queryByRole('form', { name: `Connect ${cams[0].name}` })).toBeNull();
  expect(screen.getByRole('button', { name: /Add a camera manually/ })).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByLabelText('Camera IP address')).toHaveValue('192.168.1.2');
  expect(screen.getByLabelText('RTSP port')).toHaveValue('8554');
  expect(screen.getByLabelText('Name')).toHaveValue('cam-a');
  expect(screen.getByLabelText('Username')).toHaveValue('viewer');
  expect(screen.getByLabelText('Password')).toHaveValue('');
});

test('the separate manual card starts closed and its full form saves', async () => {
  const onCreated = vi.fn();
  const view = renderAsAdmin(<AddCameraFlow onCreated={onCreated} />,
    { kids: [kids[0]], route: '/cameras/new' });
  expect(screen.queryByLabelText('Camera IP address')).toBeNull();
  await view.user.click(screen.getByRole('button', { name: /Add a camera manually/ }));
  await view.user.type(screen.getByLabelText('Name'), 'cam-a');
  await view.user.type(screen.getByLabelText('Camera IP address'), '192.168.1.2');
  await view.user.click(screen.getByRole('button', { name: 'Add camera' }));
  await waitFor(() => expect(onCreated).toHaveBeenCalledWith(saved));
});

test('leaving during the probe never saves or calls onCreated', async () => {
  let resolveProbe;
  api.post.mockImplementation((path) => path === '/cameras/onvif-probe'
    ? new Promise((resolve) => { resolveProbe = resolve; })
    : Promise.resolve({ scanId: 'scan-1', endsAt: Date.now() + 30000 }));
  const { user, list, onCreated, unmount } = await found();
  await user.click(within(list).getAllByRole('button')[0]);
  await user.click(screen.getByRole('button', { name: 'Add camera' }));
  expect(screen.getByRole('button', { name: 'Adding...' })).toBeDisabled();
  unmount();
  await act(async () => { resolveProbe(answer); });
  expect(api.post.mock.calls.filter(([path]) => path === '/cameras')).toHaveLength(0);
  expect(onCreated).not.toHaveBeenCalled();
});

// ---- #951 review: the cases the first review round found or the mutants showed were unguarded ----

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

test('Advanced settings for a second camera does not inherit the first camera\'s stored draft (#951 review)', async () => {
  const second = { id: 'three', ip: '192.168.1.4', name: 'cam-c', rtspPort: 554, sources: ['onvif'] };
  api.get.mockResolvedValue({ done: true, candidates: [cams[0], second], endsAt: Date.now() + 30000 });
  const { user, list } = await found();
  await user.click(within(list).getAllByRole('button')[0]);
  await user.type(within(screen.getByRole('form', { name: `Connect ${cams[0].name}` })).getByLabelText('Username'), 'alice');
  await user.click(screen.getByRole('button', { name: 'Advanced settings' }));
  expect(screen.getByLabelText('Username')).toHaveValue('alice');
  await user.click(within(list).getAllByRole('button')[1]);
  await user.click(within(screen.getByRole('form', { name: 'Connect cam-c' })).getByRole('button', { name: 'Advanced settings' }));
  expect(screen.getByLabelText('Camera IP address')).toHaveValue('192.168.1.4');
  expect(screen.getByLabelText('Username')).toHaveValue('');
  expect(screen.queryByText(/Unsaved changes restored/)).toBeNull();
});

test('the login fields are locked while the camera is being contacted, so the saved login is the one probed (#951 review)', async () => {
  const probe = deferred();
  api.post.mockImplementation((path) => {
    if (path === '/cameras/discover') return Promise.resolve({ scanId: 'scan-1', endsAt: Date.now() + 30000 });
    if (path === '/cameras/onvif-probe') return probe.promise;
    return Promise.resolve(saved);
  });
  const { user, list, onCreated } = await found();
  await user.click(within(list).getAllByRole('button')[0]);
  const form = screen.getByRole('form', { name: `Connect ${cams[0].name}` });
  await user.type(within(form).getByLabelText('Username'), 'old');
  await user.click(within(form).getByRole('button', { name: 'Add camera' }));
  expect(await screen.findByLabelText('Username')).toBeDisabled();
  expect(screen.getByLabelText('Password')).toBeDisabled();
  expect(screen.getByLabelText('Name')).toBeDisabled();
  await act(async () => { probe.resolve(answer); });
  await waitFor(() => expect(onCreated).toHaveBeenCalled());
  const save = api.post.mock.calls.find(([path]) => path === '/cameras');
  expect(save[1].rtsp_username).toBe('old');
});

test.each([
  ['Connected over ONVIF but could not get the stream URL: NotAuthorized', false],
  ['The ONVIF username or password appears to be incorrect. Double-check them before retrying — repeated wrong attempts can temporarily lock the camera out.', false],
  ['No ONVIF media profiles found at 192.168.1.2:80. Check the IP, port, and ONVIF username/password.', true],
])('the manual route is offered only when the login was not the problem: %s (#951 review)', async (message, offered) => {
  api.post.mockImplementation((path) => path === '/cameras/onvif-probe'
    ? Promise.reject(new Error(message)) : Promise.resolve({ scanId: 'scan-1', endsAt: Date.now() + 30000 }));
  const { user, list } = await found();
  await user.click(within(list).getAllByRole('button')[0]);
  await user.click(screen.getByRole('button', { name: 'Add camera' }));
  await screen.findByRole('alert');
  expect(!!screen.queryByRole('button', { name: 'Enter the stream details yourself' })).toBe(offered);
});

test('changing the login after a refused save probes the camera again with the new login (#951 review)', async () => {
  let saves = 0;
  api.post.mockImplementation((path) => {
    if (path === '/cameras/discover') return Promise.resolve({ scanId: 'scan-1', endsAt: Date.now() + 30000 });
    if (path === '/cameras/onvif-probe') return Promise.resolve(answer);
    if (path === '/cameras' && saves++ === 0) {
      const err = new Error('Camera stream refused the connection');
      err.data = { needsConfirm: true };
      return Promise.reject(err);
    }
    return Promise.resolve(saved);
  });
  const { user, list, onCreated } = await found();
  await user.click(within(list).getAllByRole('button')[0]);
  const form = screen.getByRole('form', { name: `Connect ${cams[0].name}` });
  await user.type(within(form).getByLabelText('Password'), 'wrong');
  await user.click(within(form).getByRole('button', { name: 'Add camera' }));
  await screen.findByRole('button', { name: 'Save anyway' });
  await user.clear(within(form).getByLabelText('Password'));
  await user.type(within(form).getByLabelText('Password'), 'right');
  await user.click(within(form).getByRole('button', { name: 'Add camera' }));
  await waitFor(() => expect(onCreated).toHaveBeenCalled());
  const probes = api.post.mock.calls.filter(([path]) => path === '/cameras/onvif-probe');
  expect(probes).toHaveLength(2);
  expect(probes[1][1].password).toBe('right');
});

test('leaving the page while the camera is being saved does not call onCreated (#951 review)', async () => {
  const save = deferred();
  api.post.mockImplementation((path) => {
    if (path === '/cameras/discover') return Promise.resolve({ scanId: 'scan-1', endsAt: Date.now() + 30000 });
    if (path === '/cameras/onvif-probe') return Promise.resolve(answer);
    return save.promise;
  });
  const { user, list, onCreated, unmount } = await found();
  await user.click(within(list).getAllByRole('button')[0]);
  await user.click(screen.getByRole('button', { name: 'Add camera' }));
  await waitFor(() => expect(api.post.mock.calls.some(([path]) => path === '/cameras')).toBe(true));
  unmount();
  await act(async () => { save.resolve(saved); });
  expect(onCreated).not.toHaveBeenCalled();
});
