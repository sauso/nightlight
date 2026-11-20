// A Nightlight Camera in the screens: the offer when it is added, the Sensors screen, the tile chips and the history badge.
// The server half (detection, polling, what is stored) is tested in backend/test/cameraSensors.test.js and
// cameras-nightlight-routes.test.js; here the camera answers are fixtures.
import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import { screen, waitFor, within, render } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { renderAsAdmin } from './helpers/render.jsx';
import AddCameraFlow from '../src/components/AddCameraFlow.jsx';
import NightlightCameraSettings from '../src/pages/NightlightCameraSettings.jsx';
import SensorHistoryCard from '../src/components/SensorHistoryCard.jsx';
import SimulatedBadge from '../src/components/SimulatedBadge.jsx';
import { cameraReadingParts } from '../src/components/CameraTile.jsx';
import { api } from '../src/lib/api.js';
import { parseSensorGroups, usesCameraClimate } from '../src/lib/nightlightSensors.js';

vi.mock('../src/lib/api.js', async (original) => {
  const module = await original();
  return { ...module, api: { ...module.api, get: vi.fn(), post: vi.fn(), put: vi.fn() } };
});

const found = [{ id: 'nl', ip: '192.168.3.142', name: 'Nightlight Camera', rtspPort: 554, sources: ['nightlight', 'onvif'], product: 'Nightlight Camera' }];
const kids = [{ id: 'kid-1', name: 'A child' }];
const baseAnswer = { rtspHost: '192.168.3.142', rtspPort: 554, rtspPath: '/main', subRtspPath: '/sub',
  onvifDeviceUrl: 'http://192.168.3.142/onvif/device', backchannel: 'yes', motionEvents: 'no', ptz: false, profileToken: 'p1' };
let probeAnswer;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  probeAnswer = { ...baseAnswer, nightlight_camera: { device_id: 'nlcam-abc', firmware: '0.1.0', simulated: true, api_port: 8080 } };
  api.post.mockImplementation((path) => {
    if (path === '/cameras/discover') return Promise.resolve({ scanId: 's', endsAt: Date.now() + 30000 });
    if (path === '/cameras/onvif-probe') return Promise.resolve(probeAnswer);
    if (path === '/cameras') return Promise.resolve({ id: 'saved-nl' });
    throw new Error(`Unexpected POST ${path}`);
  });
  api.put.mockResolvedValue({ enabled: true, groups: {}, status: 'connecting' });
  api.get.mockResolvedValue({ done: true, candidates: found, endsAt: Date.now() + 30000 });
});
afterEach(() => vi.restoreAllMocks());

async function pickAndLogin() {
  const onCreated = vi.fn();
  const view = renderAsAdmin(<AddCameraFlow onCreated={onCreated} />, { kids, route: '/cameras/new' });
  await view.user.click(screen.getByRole('button', { name: 'Find cameras on my network' }));
  await view.user.click(within(await screen.findByRole('list', { name: 'Cameras found' })).getAllByRole('button')[0]);
  const form = screen.getByRole('form', { name: 'Connect Nightlight Camera' });
  await view.user.type(within(form).getByLabelText('Username'), 'nightlight');
  await view.user.type(within(form).getByLabelText('Password'), 'pw');
  return { ...view, form, onCreated };
}
const postsTo = (path) => api.post.mock.calls.filter(([p]) => p === path);

test('a Nightlight Camera is offered its sensors between the probe and the save, on by default, with the Simulated badge', async () => {
  const { user, form, onCreated } = await pickAndLogin();
  await user.click(within(form).getByRole('button', { name: 'Add camera' }));
  const offer = await screen.findByRole('group', { name: 'Nightlight Camera detected' });
  expect(within(offer).getByText('Simulated sensors')).toBeInTheDocument();
  expect(within(offer).getByRole('switch', { name: 'Use its room sensors' })).toBeChecked();
  expect(postsTo('/cameras')).toHaveLength(0); // not saved yet: the person has not seen the offer
  await user.click(within(form).getByRole('button', { name: 'Add camera' }));
  await waitFor(() => expect(onCreated).toHaveBeenCalledWith({ id: 'saved-nl' }));
  expect(postsTo('/cameras/onvif-probe')).toHaveLength(1); // the second press does not log in to the camera again
  expect(api.put).toHaveBeenCalledWith('/cameras/saved-nl/nightlight', { enabled: true }, expect.anything());
});

test('a real (not simulated) Nightlight Camera shows no Simulated badge, and switching the offer off adds the camera without sensors', async () => {
  probeAnswer.nightlight_camera.simulated = false;
  const { user, form, onCreated } = await pickAndLogin();
  await user.click(within(form).getByRole('button', { name: 'Add camera' }));
  const offer = await screen.findByRole('group', { name: 'Nightlight Camera detected' });
  expect(within(offer).queryByText('Simulated sensors')).toBeNull();
  await user.click(within(offer).getByRole('switch', { name: 'Use its room sensors' }));
  await user.click(within(form).getByRole('button', { name: 'Add camera' }));
  await waitFor(() => expect(onCreated).toHaveBeenCalled());
  expect(api.put).not.toHaveBeenCalled();
});

test('a camera that is not a Nightlight Camera is saved on the first press, with no offer and no sensors request', async () => {
  delete probeAnswer.nightlight_camera;
  const { user, form, onCreated } = await pickAndLogin();
  await user.click(within(form).getByRole('button', { name: 'Add camera' }));
  await waitFor(() => expect(onCreated).toHaveBeenCalled());
  expect(screen.queryByRole('group', { name: 'Nightlight Camera detected' })).toBeNull();
  expect(api.put).not.toHaveBeenCalled();
});

test('changing the login after the offer asks the camera again instead of saving with the old answer', async () => {
  const { user, form } = await pickAndLogin();
  await user.click(within(form).getByRole('button', { name: 'Add camera' }));
  await screen.findByRole('group', { name: 'Nightlight Camera detected' });
  await user.type(within(form).getByLabelText('Password'), 'x');
  expect(screen.queryByRole('group', { name: 'Nightlight Camera detected' })).toBeNull();
  await user.click(within(form).getByRole('button', { name: 'Add camera' }));
  await screen.findByRole('group', { name: 'Nightlight Camera detected' });
  expect(postsTo('/cameras/onvif-probe')).toHaveLength(2);
  expect(postsTo('/cameras')).toHaveLength(0);
});

test('a failed sensors request does not undo the add', async () => {
  api.put.mockRejectedValue(new Error('This camera did not answer as a Nightlight Camera.'));
  const { user, form, onCreated } = await pickAndLogin();
  await user.click(within(form).getByRole('button', { name: 'Add camera' }));
  await screen.findByRole('group', { name: 'Nightlight Camera detected' });
  await user.click(within(form).getByRole('button', { name: 'Add camera' }));
  await waitFor(() => expect(onCreated).toHaveBeenCalledWith({ id: 'saved-nl' }));
});

// --- the Sensors screen ---------------------------------------------------------------------------------------------

const CAMERA = { id: 'cam-nl', name: 'Bedroom', sensor_source: 'nightlight-api', nlcam_device_id: 'nlcam-abc', sensor_groups: null };
const info = (over = {}) => ({ enabled: true, groups: { climate: true, radar: true, light: true, pad: true }, device_id: 'nlcam-abc',
  detected: true, firmware: '0.1.0', simulated: true, capabilities: { radar: true, environment: true, pressure: true },
  status: 'ok', readings: { temperature: 21.4, humidity: 45, presence: 1, heart_rate: 92, breathing_rate: 22 }, ...over });

function renderScreen(state, cameras = [CAMERA]) {
  api.get.mockImplementation((path) => (path === '/cameras/cam-nl/nightlight' ? Promise.resolve(state) : Promise.reject(new Error(`GET ${path}`))));
  return renderAsAdmin(
    <Routes><Route path="/cameras/:id/nightlight" element={<NightlightCameraSettings />} /></Routes>,
    { cameras, route: '/cameras/cam-nl/nightlight', settings: { temp_unit: 'C' } },
  );
}

test('the Sensors screen shows status, the Simulated badge, the switches and the live readings with the estimate wording', async () => {
  renderScreen(info());
  expect(await screen.findByText('Connected')).toBeInTheDocument();
  expect(screen.getByText('Simulated sensors')).toBeInTheDocument();
  expect(screen.getByRole('switch', { name: "Use this camera's sensors" })).toBeChecked();
  for (const label of ['Room temperature and humidity', 'Radar', 'Ambient light', 'Bed pad']) expect(screen.getByRole('switch', { name: label })).toBeChecked();
  const now = screen.getByRole('region', { name: 'Right now' });
  expect(within(now).getByText('21.4°C')).toBeInTheDocument();
  expect(within(now).getByText('92 bpm')).toBeInTheDocument();
  expect(within(now).getByText('22 per minute')).toBeInTheDocument();
  expect(within(now).getByText(/not for medical use/)).toBeInTheDocument();
});

test('a switch saves once, as one request, and the group switches are disabled while the sensors are off', async () => {
  const { user } = renderScreen(info());
  await screen.findByText('Connected');
  api.put.mockResolvedValue({ enabled: true, groups: { climate: true, radar: false, light: true, pad: true }, status: 'ok' });
  await user.click(screen.getByRole('switch', { name: 'Radar' }));
  await waitFor(() => expect(screen.getByText('Saved ✓')).toBeInTheDocument());
  expect(api.put).toHaveBeenCalledTimes(1);
  expect(api.put).toHaveBeenCalledWith('/cameras/cam-nl/nightlight', { groups: { radar: false } });
});

test('with the sensors off the group switches are disabled and the readings card is gone', async () => {
  renderScreen(info({ enabled: false, status: 'off', readings: {} }));
  await screen.findByRole('switch', { name: "Use this camera's sensors" });
  expect(screen.getByRole('switch', { name: 'Radar' })).toBeDisabled();
  expect(screen.queryByRole('region', { name: 'Right now' })).toBeNull();
});

test('a sensor that the camera says it does not have is not offered', async () => {
  renderScreen(info({ capabilities: { radar: false, environment: true, pressure: false } }));
  await screen.findByText('Connected');
  expect(screen.queryByRole('switch', { name: 'Radar' })).toBeNull();
  expect(screen.queryByRole('switch', { name: 'Bed pad' })).toBeNull();
  expect(screen.getByRole('switch', { name: 'Ambient light' })).toBeInTheDocument();
});

test('a failed login says so and offers Retry, which asks the server to resume', async () => {
  const { user } = renderScreen(info({ status: 'login_failed', readings: {} }));
  expect(await screen.findByText(/Sensor login failed/)).toBeInTheDocument();
  api.put.mockResolvedValue({ enabled: true, groups: {}, status: 'connecting' });
  await user.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(api.put).toHaveBeenCalledWith('/cameras/cam-nl/nightlight', { retry: true }));
});

test('a camera that does not answer as a Nightlight Camera says so, and a name-added camera explains the limit', async () => {
  renderScreen(info({ detected: false, reason: 'address', enabled: false, status: 'off', readings: {} }));
  expect(await screen.findByText('Not answering as a Nightlight Camera')).toBeInTheDocument();
  expect(screen.getByText(/added by a name/)).toBeInTheDocument();
  expect(screen.queryByRole('switch', { name: "Use this camera's sensors" })).toBeNull();
});

test('an unknown camera is a not-found screen', async () => {
  renderScreen(info(), []);
  await waitFor(() => expect(screen.queryByText('Loading…')).toBeNull());
  expect(screen.queryByRole('switch', { name: "Use this camera's sensors" })).toBeNull();
});

// --- chips, history ---------------------------------------------------------------------------------------------------

const live = (metrics, simulated = false) => ({ status: 'ok', simulated, metrics });
const texts = (parts) => parts.map((p) => p.text);

test('tile chips: an ordinary camera shows its MQTT readings exactly as before', () => {
  expect(texts(cameraReadingParts({ mqtt: { temperature: 20, humidity: 50 } }, 'C'))).toEqual(['20.0°C', '50%']);
  expect(cameraReadingParts({ mqtt: null }, 'C')).toEqual([]);
});

test('tile chips: a Nightlight Camera with its climate switch on shows the camera’s readings, not MQTT’s, plus ok radar readings only', () => {
  const camera = { sensor_source: 'nightlight-api', sensor_groups: null, mqtt: { temperature: 99, humidity: 99 },
    nightlight_sensors: live({ temperature: 21.4, humidity: 45, presence: 1, heart_rate: 92.4, breathing_rate: 22 }) };
  expect(texts(cameraReadingParts(camera, 'C'))).toEqual(['21.4°C', '45%', 'Present', '92 bpm', '22/min']);
  expect(cameraReadingParts(camera, 'C').find((p) => p.key === 'hr').title).toMatch(/not for medical use/);
  expect(texts(cameraReadingParts(camera, 'F'))[0]).toBe('70.5°F');
  // Nothing the server did not mark ok and fresh: missing keys draw nothing (never 0, never NaN).
  expect(texts(cameraReadingParts({ ...camera, nightlight_sensors: live({}) }, 'C'))).toEqual([]);
  expect(texts(cameraReadingParts({ ...camera, nightlight_sensors: live({ heart_rate: Number.NaN, presence: 0 }) }, 'C'))).toEqual(['Nobody there']);
});

test('tile chips: with the climate switch off the camera’s MQTT readings are used again, and a radar switch off hides the radar chips', () => {
  const camera = { sensor_source: 'nightlight-api', sensor_groups: JSON.stringify({ climate: false, radar: false }), mqtt: { temperature: 19, humidity: 40 },
    nightlight_sensors: live({ temperature: 21.4, humidity: 45, presence: 1, heart_rate: 92 }) };
  expect(texts(cameraReadingParts(camera, 'C'))).toEqual(['19.0°C', '40%']);
});

test('groups parse like the server: all on by default, only booleans count', () => {
  expect(parseSensorGroups(null)).toEqual({ climate: true, radar: true, light: true, pad: true });
  expect(parseSensorGroups('{"radar":false,"light":"no"}')).toEqual({ climate: true, radar: false, light: true, pad: true });
  expect(parseSensorGroups('nope')).toEqual({ climate: true, radar: true, light: true, pad: true });
  expect(usesCameraClimate({ sensor_source: 'nightlight-api', sensor_groups: null })).toBe(true);
  expect(usesCameraClimate({ sensor_source: 'nightlight-api', sensor_groups: '{"climate":false}' })).toBe(false);
  expect(usesCameraClimate({ sensor_source: null })).toBe(false);
});

test('the badge says Simulated sensors', () => {
  render(<SimulatedBadge />);
  expect(screen.getByText('Simulated sensors')).toBeInTheDocument();
});

test('the chart card labels itself when any point is simulated, and not otherwise', async () => {
  const card = (readings) => {
    api.get.mockResolvedValue({ hours: 24, readings });
    return renderAsAdmin(<SensorHistoryCard camera={{ id: 'c', name: 'Bedroom' }} />, { settings: { temp_unit: 'C' } });
  };
  const real = card([{ t: '2026-11-20 01:00:00', temperature: 20, humidity: 50, simulated: false }, { t: '2026-11-20 02:00:00', temperature: 21, humidity: 51, simulated: false }]);
  await screen.findByText(/Room climate/);
  expect(screen.queryByText('Simulated sensors')).toBeNull();
  real.unmount();
  card([{ t: '2026-11-20 01:00:00', temperature: 20, humidity: 50, simulated: false }, { t: '2026-11-20 02:00:00', temperature: 99, humidity: 99, simulated: true }]);
  expect(await screen.findByText('Simulated sensors')).toBeInTheDocument();
});

// Code review (Codex, 2026-11-20).
test('stored sensors can still be switched off while the camera does not answer', async () => {
  const { user } = renderScreen(info({ detected: false, reason: 'no_answer', enabled: true, status: 'offline', readings: {} }));
  expect(await screen.findByText('Not answering as a Nightlight Camera')).toBeInTheDocument();
  const master = screen.getByRole('switch', { name: "Use this camera's sensors" });
  expect(master).toBeChecked();
  api.put.mockResolvedValue({ enabled: false, groups: {}, status: 'off' });
  await user.click(master);
  await waitFor(() => expect(api.put).toHaveBeenCalledWith('/cameras/cam-nl/nightlight', { enabled: false }));
});

test('a refresh that fails after a good load says the numbers may be out of date', async () => {
  let calls = 0;
  api.get.mockImplementation(() => (++calls === 1 ? Promise.resolve(info()) : Promise.reject(new Error('server down'))));
  renderAsAdmin(<Routes><Route path="/cameras/:id/nightlight" element={<NightlightCameraSettings />} /></Routes>,
    { cameras: [CAMERA], route: '/cameras/cam-nl/nightlight', settings: { temp_unit: 'C' } });
  expect(await screen.findByText('Connected')).toBeInTheDocument();
  expect(screen.queryByText(/Couldn.t refresh/)).toBeNull();
  // The screen polls every 5 s; wait for the second request (a real timer: the screen owns its interval).
  expect(await screen.findByText(/Couldn.t refresh/, {}, { timeout: 8000 })).toBeInTheDocument();
  expect(screen.getByText('Connected')).toBeInTheDocument(); // the last good values stay on screen
}, 12000);

test('a new login after the offer starts the offer on again, even if it was switched off before', async () => {
  const { user, form } = await pickAndLogin();
  await user.click(within(form).getByRole('button', { name: 'Add camera' }));
  const first = await screen.findByRole('group', { name: 'Nightlight Camera detected' });
  await user.click(within(first).getByRole('switch', { name: 'Use its room sensors' }));
  expect(within(first).getByRole('switch', { name: 'Use its room sensors' })).not.toBeChecked();
  await user.type(within(form).getByLabelText('Password'), 'x');
  await user.click(within(form).getByRole('button', { name: 'Add camera' }));
  const second = await screen.findByRole('group', { name: 'Nightlight Camera detected' });
  expect(within(second).getByRole('switch', { name: 'Use its room sensors' })).toBeChecked();
});
