// Unsaved edits survive the background reload and a trip to another screen (#377).
//
// The shell reloads the page after 15 s in the background (App.jsx), which empties React state. A reload
// cannot be performed in jsdom, so "reload" here is what it amounts to for a form: UNMOUNT the screen and
// mount it again, with the real sessionStorage in between. Nothing in the storage path is mocked.
//
// ★ THE RULE THIS FILE EXISTS FOR: no secret ever reaches browser storage. The camera test plants a marker in
// both password boxes and then scans EVERY value in sessionStorage and localStorage for it.
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { Routes, Route } from 'react-router-dom';
import { renderAsAdmin } from './helpers/render.jsx';
import ChildSettings from '../src/pages/ChildSettings.jsx';
import CameraSettings from '../src/pages/CameraSettings.jsx';
import SettingsRecording from '../src/pages/SettingsRecording.jsx';
import { api } from '../src/lib/api.js';

const KID = { id: 'kid-1', name: 'Child B', birthday: '2023-04-01', color: '#7FBFA3', track_sleep: 1, sleep_window_start: '19:30', sleep_window_end: '06:45' };
const CAM = {
  id: 'cam-1', name: 'Nursery', rtsp_host: '192.168.1.50', rtsp_port: '554', rtsp_path: '/stream1', rtsp_username: 'viewer',
  rtsp_has_password: true, sub_rtsp_path: '', child_id: 'kid-1', mqtt_topic: '', talk_username: 'admin', talk_has_password: true,
  backchannel_supported: 'no', talk_backend: 'hikvision-isapi',
};

const everythingStored = () => [localStorage, sessionStorage]
  .flatMap((s) => Object.keys(s).map((k) => `${k}=${s.getItem(k)}`)).join('\n');

const mountChild = (id = KID.id) => renderAsAdmin(
  <Routes>
    <Route path="/children/new" element={<ChildSettings />} />
    <Route path="/children/:id" element={<ChildSettings />} />
    <Route path="*" element={<div>elsewhere</div>} />
  </Routes>,
  { kids: [KID], route: `/children/${id}` },
);
const mountCamera = () => renderAsAdmin(
  <Routes>
    <Route path="/cameras/:id" element={<CameraSettings />} />
    <Route path="*" element={<div>elsewhere</div>} />
  </Routes>,
  { cameras: [CAM], kids: [KID], route: `/cameras/${CAM.id}` },
);

beforeEach(() => {
  vi.spyOn(api, 'post').mockResolvedValue({ id: 'new' });
  vi.spyOn(api, 'put').mockResolvedValue({});
  vi.spyOn(api, 'del').mockResolvedValue({});
  vi.spyOn(api, 'get').mockResolvedValue({});
});
afterEach(() => vi.restoreAllMocks());

describe('child form', () => {
  test('★ a name typed and not saved comes back after a reload, with a notice', async () => {
    const first = mountChild();
    const name = await screen.findByLabelText('Name');
    await first.user.clear(name);
    await first.user.type(name, 'Unsaved name');
    first.unmount();

    mountChild();
    expect((await screen.findByLabelText('Name')).value).toBe('Unsaved name');
    expect(screen.getByText('Unsaved changes restored.')).toBeInTheDocument();
    // Only what was edited is restored; the rest still comes from the stored child.
    expect(screen.getByLabelText(/Birthday/).value).toBe('2023-04-01');
  });

  test('an untouched form stores nothing and shows no notice', async () => {
    const first = mountChild();
    await screen.findByLabelText('Name');
    expect(screen.queryByText(/Unsaved changes/)).toBeNull();
    expect(Object.keys(sessionStorage)).toEqual([]);
    first.unmount();
  });

  test('typing the original value back leaves no draft: unsaved is derived', async () => {
    const { user } = mountChild();
    const name = await screen.findByLabelText('Name');
    await user.type(name, 'x');
    expect(Object.keys(sessionStorage)).toHaveLength(1);
    await user.type(name, '{backspace}');
    await waitFor(() => expect(Object.keys(sessionStorage)).toEqual([]));
    expect(screen.queryByText(/Unsaved changes/)).toBeNull();
  });

  test('★ "Discard changes" restores the stored value and clears the draft', async () => {
    const first = mountChild();
    await first.user.type(await screen.findByLabelText('Name'), ' edited');
    first.unmount();

    const { user } = mountChild();
    expect((await screen.findByLabelText('Name')).value).toBe('Child B edited');
    await user.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(screen.getByLabelText('Name').value).toBe('Child B');
    expect(screen.queryByText(/Unsaved changes/)).toBeNull();
    expect(Object.keys(sessionStorage)).toEqual([]);
  });

  test('★ a successful save clears the draft', async () => {
    const { user } = mountChild();
    await user.type(await screen.findByLabelText('Name'), ' edited');
    expect(Object.keys(sessionStorage)).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByText('elsewhere');
    expect(Object.keys(sessionStorage)).toEqual([]);
  });

  test('★ removing the child clears its draft', async () => {
    const { user } = mountChild();
    await user.type(await screen.findByLabelText('Name'), ' edited');
    expect(Object.keys(sessionStorage)).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Remove child' }));
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    await screen.findByText('elsewhere');
    expect(Object.keys(sessionStorage)).toEqual([]);
  });

  test('a FAILED save keeps the draft', async () => {
    api.put.mockRejectedValue(new Error('Nope'));
    const { user } = mountChild();
    await user.type(await screen.findByLabelText('Name'), ' edited');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Nope')).toBeInTheDocument();
    expect(Object.keys(sessionStorage)).toHaveLength(1);
  });

  test('a new child is resumable too', async () => {
    const first = mountChild('new');
    await first.user.type(await screen.findByLabelText('Name'), 'Half typed');
    first.unmount();
    mountChild('new');
    expect((await screen.findByLabelText('Name')).value).toBe('Half typed');
  });

  test('a draft belongs to one child: another child\'s form is not affected', async () => {
    const first = mountChild();
    await first.user.type(await screen.findByLabelText('Name'), ' edited');
    first.unmount();
    mountChild('new');
    expect((await screen.findByLabelText('Name')).value).toBe('');
  });
});

describe('camera form', () => {
  const PASSWORD = 'planted-camera-password-7c1';
  const TALK_PASSWORD = 'planted-talk-password-4d8';

  test('★★ NO SECRET reaches storage, and the rest of the form is restored', async () => {
    const first = mountCamera();
    const name = await screen.findByLabelText('Name');
    await first.user.clear(name);
    await first.user.type(name, 'Renamed');
    await first.user.type(screen.getByLabelText('Password'), PASSWORD);
    await first.user.type(screen.getByLabelText('Talk password'), TALK_PASSWORD);

    // The marker is on screen (so the test is not vacuous), and absent from every storage value.
    expect(screen.getByLabelText('Password').value).toBe(PASSWORD);
    expect(everythingStored()).toContain('Renamed');
    expect(everythingStored()).not.toContain(PASSWORD);
    expect(everythingStored()).not.toContain(TALK_PASSWORD);
    first.unmount();

    mountCamera();
    expect((await screen.findByLabelText('Name')).value).toBe('Renamed');
    expect(screen.getByLabelText('Password').value).toBe('');
    expect(screen.getByLabelText('Talk password').value).toBe('');
    expect(screen.getByText(/Passwords are never kept on the device/)).toBeInTheDocument();
    expect(everythingStored()).not.toContain(PASSWORD);
  });

  test('a typed password alone counts as unsaved (the person would lose it) but stores nothing', async () => {
    const { user } = mountCamera();
    await user.type(await screen.findByLabelText('Password'), PASSWORD);
    expect(screen.getByText('Unsaved changes.')).toBeInTheDocument();
    expect(Object.keys(sessionStorage)).toEqual([]);
  });

  test('a successful save clears the draft', async () => {
    const { user } = mountCamera();
    await user.type(await screen.findByLabelText('Name'), ' 2');
    expect(Object.keys(sessionStorage)).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: /^Save/ }));
    await screen.findByText('elsewhere');
    expect(Object.keys(sessionStorage)).toEqual([]);
  });

  test('★ removing the camera clears its draft', async () => {
    const { user } = mountCamera();
    await user.type(await screen.findByLabelText('Name'), ' 2');
    expect(Object.keys(sessionStorage)).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: /Remove camera/ }));
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    await screen.findByText('elsewhere');
    expect(Object.keys(sessionStorage)).toEqual([]);
  });

  test('Discard changes puts the stored values back', async () => {
    const { user } = mountCamera();
    await user.type(await screen.findByLabelText('Name'), ' 2');
    await user.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(screen.getByLabelText('Name').value).toBe('Nursery');
    expect(Object.keys(sessionStorage)).toEqual([]);
  });
});

describe('recording settings', () => {
  const SETTINGS = {
    clip_pre_roll_s: 5, clip_post_roll_s: 15, clip_retention_days: 14, clip_retention_max_gb: 5,
    wake_clips_enabled: 1, wake_clip_seconds: 30, wake_clip_retention_days: 14,
    ondemand_enabled: 1, ondemand_pre_roll_s: 30, ondemand_max_duration_s: 120,
  };
  const mount = () => renderAsAdmin(<SettingsRecording />, { settings: SETTINGS });

  test('★ an unsaved switch and number come back after a reload', async () => {
    const first = mount();
    await first.user.click(await screen.findByLabelText('Show a Record button on each camera'));
    const days = screen.getByLabelText('Keep clips for (days)');
    await first.user.clear(days);
    await first.user.type(days, '3');
    first.unmount();

    mount();
    expect((await screen.findByLabelText('Keep clips for (days)')).value).toBe('3');
    expect(screen.getByLabelText('Show a Record button on each camera').checked).toBe(false);
    expect(screen.getByText('Unsaved changes restored.')).toBeInTheDocument();
    expect(api.put).not.toHaveBeenCalled(); // restoring is not saving
  });

  test('Discard changes returns to what is stored', async () => {
    const first = mount();
    await first.user.click(await screen.findByLabelText('Show a Record button on each camera'));
    first.unmount();
    const { user } = mount();
    await user.click(await screen.findByRole('button', { name: 'Discard changes' }));
    expect(screen.getByLabelText('Show a Record button on each camera').checked).toBe(true);
    expect(Object.keys(sessionStorage)).toEqual([]);
  });
});

// ★ After a REAL reload the data arrives AFTER the first render: the children, cameras and settings are
// fetched again. A draft must not be wiped by the empty or placeholder state of that first render.
describe('★ the data arriving after the screen has rendered', () => {
  test('child: the draft survives the render before the child has loaded, and is applied once it has', async () => {
    const first = mountChild();
    await first.user.type(await screen.findByLabelText('Name'), ' edited');
    first.unmount();

    const { rerenderWith } = renderAsAdmin(
      <Routes><Route path="/children/:id" element={<ChildSettings />} /></Routes>,
      { kids: [], route: `/children/${KID.id}` },
    );
    expect(await screen.findByText('Loading…')).toBeInTheDocument();
    expect(Object.keys(sessionStorage)).toHaveLength(1); // not wiped by the empty first render
    rerenderWith({ kids: [KID] });
    expect((await screen.findByLabelText('Name')).value).toBe('Child B edited');
  });

  test('camera: the same', async () => {
    const first = mountCamera();
    await first.user.type(await screen.findByLabelText('Name'), ' 2');
    first.unmount();

    const { rerenderWith } = renderAsAdmin(
      <Routes><Route path="/cameras/:id" element={<CameraSettings />} /></Routes>,
      { cameras: [], camerasLoaded: false, kids: [KID], route: `/cameras/${CAM.id}` },
    );
    expect(await screen.findByText('Loading…')).toBeInTheDocument();
    expect(Object.keys(sessionStorage)).toHaveLength(1);
    rerenderWith({ cameras: [CAM], camerasLoaded: true });
    expect((await screen.findByLabelText('Name')).value).toBe('Nursery 2');
  });

  test('recording: a draft equal to a placeholder default is not cleared while the settings load', async () => {
    // The server stores 30 days; the person typed 14 — which is also the placeholder default. Judged against
    // the placeholder it would look like "no change" and be dropped from storage before the real 30 arrives.
    const stored = { ...{ clip_retention_days: 30, wake_clips_enabled: 1, ondemand_enabled: 1 } };
    const first = renderAsAdmin(<SettingsRecording />, { settings: stored });
    const days = await screen.findByLabelText('Keep clips for (days)');
    await first.user.clear(days);
    await first.user.type(days, '14');
    first.unmount();
    expect(Object.keys(sessionStorage)).toHaveLength(1);

    const { rerenderWith } = renderAsAdmin(<SettingsRecording />, { settings: {}, settingsLoaded: false });
    expect(Object.keys(sessionStorage)).toHaveLength(1);
    rerenderWith({ settings: stored, settingsLoaded: true });
    expect((await screen.findByLabelText('Keep clips for (days)')).value).toBe('14');
    expect(screen.getByText('Unsaved changes restored.')).toBeInTheDocument();
  });
});
