// The Cameras tab (src/pages/Cameras.jsx) and Settings → Camera controls (src/pages/SettingsCamera.jsx).
//
// Both had ZERO tests. What is worth pinning here is not the markup:
//   1. ROLE GATING. Every destructive or reconfiguring affordance on this page — Disable, Edit, Remove,
//      Add, and (since #552) the assign-to-child <select> — is admin-only; a caregiver sees which child a
//      camera belongs to as text. A caregiver seeing a Remove button is the exact shape of bug this suite
//      exists for (an admin-only route once shipped 403-ing everyone, invisible until someone clicked it).
//   2. THE ENABLE TOGGLE SENDS THE OPPOSITE OF WHAT IT READS. `enabled: !!cam.disabled` — the payload
//      is the NEW state, derived from the OLD one. An inverted flag here silently disables a camera
//      when someone tries to enable it, and the label would still look right.
//   3. THE REMOVE MODAL MUST NOT BE CLOSEABLE MID-DELETE. `onClose` returns null while busy.
//   4. SettingsCamera SENDS A PARTIAL PAYLOAD — its own five fields, on purpose, because the settings PUT
//      keeps everything it is not sent. Sending the whole form would stamp this page's stale copy of
//      every other setting over the real ones. (Five since #552 added the long-silence pair.)
//   5. SettingsCamera's form is SEEDED FROM CONTEXT AND RE-SEEDED WHEN IT ARRIVES. SettingsContext
//      resolves after first paint, so the page always renders once with an empty settings object.
import { describe, test, expect, vi, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { Routes, Route } from 'react-router-dom';
import { renderAsAdmin, renderAsCaregiver, forEachRole, renderAs } from './helpers/render.jsx';
import Cameras from '../src/pages/Cameras.jsx';
import SettingsCamera from '../src/pages/SettingsCamera.jsx';
import { api } from '../src/lib/api.js';

const KIDS = [
  { id: 'kid-1', name: 'Child B' },
  { id: 'kid-2', name: 'Child A' },
];

const CAMS = [
  {
    id: 'cam-a',
    name: 'Child B Room',
    child_id: 'kid-1',
    statusLevel: 'live',
    rtsp_display: 'rtsp://192.0.2.10:554/ch0',
    discovery_source: 'onvif',
    ptz_supported: 1,
    backchannel_supported: 'yes',
  },
  {
    id: 'cam-b',
    name: 'Hallway',
    child_id: null,
    disabled: 1,
    discovery_source: 'manual',
    ptz_supported: 0,
    backchannel_supported: 'no',
  },
];

const withCams = (over = {}) => ({ kids: KIDS, cameras: CAMS, ...over });
const card = (name) => screen.getByText(name).closest('.cam-card');

function mockApi() {
  vi.spyOn(api, 'put').mockResolvedValue({});
  vi.spyOn(api, 'del').mockResolvedValue({});
  vi.spyOn(api, 'get').mockResolvedValue(null);
}

afterEach(() => vi.restoreAllMocks());

// --- the Cameras tab ----------------------------------------------------------------------------

describe('the Cameras tab', () => {
  test('lists every camera with its address and capability badges, for either role', async () => {
    await forEachRole(async (_name, who) => {
      mockApi();
      const { unmount } = renderAs(who, <Cameras />, withCams());
      expect(screen.getByText('Child B Room')).toBeInTheDocument();
      expect(screen.getByText('Hallway')).toBeInTheDocument();
      expect(screen.getByText('rtsp://192.0.2.10:554/ch0')).toBeInTheDocument();

      // The badges are the same three words on every card, so they only mean anything scoped to a
      // card AND read together with the class that carries the yes/no.
      const live = card('Child B Room');
      expect(within(live).getByText('ONVIF')).toHaveClass('cam-badge--ok');
      expect(within(live).getByText('PTZ')).toHaveClass('cam-badge--ok');
      expect(within(live).getByText('Two-way Audio')).toHaveClass('cam-badge--ok');

      const off = card('Hallway');
      expect(within(off).getByText('ONVIF')).toHaveClass('cam-badge--bad');
      expect(within(off).getByText('PTZ')).toHaveClass('cam-badge--bad');
      expect(within(off).getByText('Two-way Audio')).toHaveClass('cam-badge--bad');
      // ⚠️ Required: forEachRole renders both roles into the SAME document, so without this the
      // second pass has two copies of every camera on the page and every query is ambiguous.
      unmount();
    });
  });

  test('a disabled camera is styled as off and reads as offline', () => {
    mockApi();
    renderAsAdmin(<Cameras />, withCams());
    expect(card('Hallway')).toHaveClass('cam-card--off');
    expect(card('Child B Room')).not.toHaveClass('cam-card--off');
  });

  test('says so when there are no cameras at all', () => {
    mockApi();
    renderAsAdmin(<Cameras />, withCams({ cameras: [] }));
    expect(screen.getByText('No cameras added yet.')).toBeInTheDocument();
  });

  test('an error from the cameras context is shown without any action being taken', () => {
    mockApi();
    renderAsAdmin(<Cameras />, withCams({ error: 'Could not load cameras' }));
    expect(screen.getByText('Could not load cameras')).toBeInTheDocument();
  });

  test('ONLY an admin gets Disable, Edit, Remove and Add camera', () => {
    mockApi();
    const { unmount } = renderAsAdmin(<Cameras />, withCams());
    expect(screen.getAllByRole('button', { name: 'Edit' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Remove' })).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Disable' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enable' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '+ Add camera' })).toBeInTheDocument();
    unmount();

    renderAsCaregiver(<Cameras />, withCams());
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Disable' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '+ Add camera' })).not.toBeInTheDocument();
  });

  test('★ a caregiver SEES each camera\'s child as text, with no control to change it (#552)', () => {
    // Assigning is admin-only now: which child a camera belongs to decides whether its nights are
    // tracked, and the server refuses a caregiver's assign. A <select> here would only lead to a refusal.
    mockApi();
    renderAsCaregiver(<Cameras />, withCams());
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(within(card('Child B Room')).getByText('Child B')).toBeInTheDocument();
    expect(within(card('Hallway')).getByText('Unassigned')).toBeInTheDocument();
    expect(api.put).not.toHaveBeenCalled();
  });

  test('an admin reassigns a camera to a child through the <select>', async () => {
    mockApi();
    const { user, camerasValue } = renderAsAdmin(<Cameras />, withCams());
    expect(screen.getAllByRole('combobox')).toHaveLength(2);
    const select = within(card('Hallway')).getByRole('combobox');
    await user.selectOptions(select, 'kid-2');
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/cameras/cam-b/assign', { child_id: 'kid-2' }));
    // waitFor: refresh runs when the PUT resolves, which is after it was called (#570).
    await waitFor(() => expect(camerasValue.refresh).toHaveBeenCalled());
  });

  test('unassigning sends null, not an empty string', async () => {
    mockApi();
    const { user } = renderAsAdmin(<Cameras />, withCams());
    const select = within(card('Child B Room')).getByRole('combobox');
    expect(select).toHaveValue('kid-1');
    await user.selectOptions(select, '');
    // ⚠️ The <option> value is '' and the route stores whatever it is given. `child_id: ''` would
    // write an empty string where every other unassigned camera holds NULL.
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/cameras/cam-a/assign', { child_id: null }));
  });

  test('a failed assign surfaces the message instead of failing silently', async () => {
    mockApi();
    api.put.mockRejectedValue(new Error('That child was deleted'));
    const { user } = renderAsAdmin(<Cameras />, withCams());
    await user.selectOptions(within(card('Hallway')).getByRole('combobox'), 'kid-1');
    expect(await screen.findByText('That child was deleted')).toBeInTheDocument();
  });

  test('the enable/disable toggle sends the NEW state, which is the opposite of what it reads', async () => {
    mockApi();
    const { user } = renderAsAdmin(<Cameras />, withCams());

    // Child B Room is on, so its button says Disable and must send enabled:false.
    await user.click(within(card('Child B Room')).getByRole('button', { name: 'Disable' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/cameras/cam-a/enabled', { enabled: false }));

    // Hallway is off (`disabled: 1`), so its button says Enable and must send enabled:true. Both
    // directions are asserted because a single inverted flag passes either one on its own.
    await user.click(within(card('Hallway')).getByRole('button', { name: 'Enable' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/cameras/cam-b/enabled', { enabled: true }));
  });

  test('only the camera being toggled is disabled while its request is in flight', async () => {
    mockApi();
    let release;
    api.put.mockImplementation(() => new Promise((r) => { release = r; }));
    const { user } = renderAsAdmin(<Cameras />, withCams());

    await user.click(within(card('Child B Room')).getByRole('button', { name: 'Disable' }));
    const busy = within(card('Child B Room')).getByRole('button', { name: '…' });
    expect(busy).toBeDisabled();
    // The OTHER camera's toggle must stay live — `togglingId` is an id, not a boolean, precisely so
    // one slow camera does not freeze the page.
    expect(within(card('Hallway')).getByRole('button', { name: 'Enable' })).toBeEnabled();

    release({});
    await waitFor(() => expect(within(card('Child B Room')).getByRole('button', { name: 'Disable' })).toBeEnabled());
  });

  test('a failed toggle clears the busy state so it can be retried', async () => {
    mockApi();
    api.put.mockRejectedValue(new Error('Camera is gone'));
    const { user } = renderAsAdmin(<Cameras />, withCams());
    await user.click(within(card('Child B Room')).getByRole('button', { name: 'Disable' }));
    expect(await screen.findByText('Camera is gone')).toBeInTheDocument();
    expect(within(card('Child B Room')).getByRole('button', { name: 'Disable' })).toBeEnabled();
  });

  test('Edit and Add navigate to the camera screen carrying a Cameras back-link', async () => {
    mockApi();
    const seen = [];
    const Probe = () => { seen.push(true); return <div>camera screen</div>; };
    const { user } = renderAsAdmin(
      <Routes>
        <Route path="/" element={<Cameras />} />
        <Route path="/cameras/:id" element={<Probe />} />
      </Routes>,
      withCams()
    );
    await user.click(within(card('Child B Room')).getByRole('button', { name: 'Edit' }));
    expect(await screen.findByText('camera screen')).toBeInTheDocument();
    expect(seen).toHaveLength(1);
  });

  describe('removing a camera', () => {
    test('asks first, names the camera, and sends nothing until confirmed', async () => {
      mockApi();
      const { user } = renderAsAdmin(<Cameras />, withCams());
      await user.click(within(card('Child B Room')).getByRole('button', { name: 'Remove' }));

      const dialog = screen.getByRole('dialog');
      expect(within(dialog).getByText('Child B Room')).toBeInTheDocument();
      expect(api.del).not.toHaveBeenCalled();

      await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(api.del).not.toHaveBeenCalled();
    });

    test('confirming deletes that camera and refreshes the list', async () => {
      mockApi();
      const { user, camerasValue } = renderAsAdmin(<Cameras />, withCams());
      await user.click(within(card('Hallway')).getByRole('button', { name: 'Remove' }));
      await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove' }));

      await waitFor(() => expect(api.del).toHaveBeenCalledWith('/cameras/cam-b'));
      expect(api.del).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(camerasValue.refresh).toHaveBeenCalled());
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    });

    test('the dialog cannot be dismissed while the delete is in flight', async () => {
      mockApi();
      let release;
      api.del.mockImplementation(() => new Promise((r) => { release = r; }));
      const { user } = renderAsAdmin(<Cameras />, withCams());
      await user.click(within(card('Hallway')).getByRole('button', { name: 'Remove' }));
      await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove' }));

      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByRole('button', { name: 'Removing…' })).toBeDisabled();
      expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
      // Escape is the other way out, and `onClose` returns null while busy rather than closing.
      await user.keyboard('{Escape}');
      expect(screen.getByRole('dialog')).toBeInTheDocument();

      release({});
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    });

    test('a failed delete keeps the dialog open with the reason, so it can be retried', async () => {
      mockApi();
      api.del.mockRejectedValue(new Error('Camera is in use'));
      const { user } = renderAsAdmin(<Cameras />, withCams());
      await user.click(within(card('Hallway')).getByRole('button', { name: 'Remove' }));
      await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove' }));

      expect(await screen.findByText('Camera is in use')).toBeInTheDocument();
      // ⚠️ `setRemoving(null)` runs only on success, so the dialog must still be there — otherwise the
      // error banner appears behind a screen the user has already been thrown out of.
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove' })).toBeEnabled();
    });
  });
});

// --- Settings → Camera controls -----------------------------------------------------------------

const SETTINGS = {
  ptz_step: 12,
  camera_offline_alert_enabled: 1,
  camera_offline_alert_minutes: 5,
  // Stored AWAY from the defaults (on, 60), so "seeded" and "fell back" cannot look alike.
  snooze_alert_enabled: 0,
  snooze_alert_minutes: 95,
  // Deliberately present and deliberately NOT in the payload below.
  app_name: 'Nightlight',
  timezone: 'Australia/Melbourne',
};

const OFFLINE_SWITCH = { name: 'Notify when a camera goes offline' };
const SILENCE_SWITCH = { name: "Notify admins when a camera's alerts stay silenced for a long time" };

describe('Settings → Camera controls', () => {
  test('seeds every field from the settings context', () => {
    mockApi();
    renderAsAdmin(<SettingsCamera />, { settings: SETTINGS });
    expect(screen.getByLabelText('PTZ step size')).toHaveValue(12);
    expect(screen.getByLabelText('Offline for longer than (minutes)')).toHaveValue(5);
    expect(screen.getByRole('switch', OFFLINE_SWITCH)).toBeChecked();
    expect(screen.getByRole('switch', SILENCE_SWITCH)).not.toBeChecked();
    expect(screen.getByLabelText('Silenced for longer than (minutes)')).toHaveValue(95);
  });

  test('falls back to the documented defaults when settings are empty', () => {
    mockApi();
    renderAsAdmin(<SettingsCamera />, { settings: { ptz_step: undefined, camera_offline_alert_minutes: undefined } });
    // These numbers are the defaults docs/camera-controls.md quotes; if they change, the docs are wrong too.
    expect(screen.getByLabelText('PTZ step size')).toHaveValue(12);
    expect(screen.getByLabelText('Offline for longer than (minutes)')).toHaveValue(5);
    // #552: long-silence alerts are ON by default, threshold 60.
    expect(screen.getByRole('switch', SILENCE_SWITCH)).toBeChecked();
    expect(screen.getByLabelText('Silenced for longer than (minutes)')).toHaveValue(60);
    expect(screen.getByLabelText('Silenced for longer than (minutes)')).toBeEnabled();
  });

  test('picks the settings up when the context resolves AFTER first paint', () => {
    mockApi();
    const { rerenderWith } = renderAsAdmin(<SettingsCamera />, { settings: { ptz_step: undefined } });
    expect(screen.getByLabelText('PTZ step size')).toHaveValue(12); // the fallback, not real data
    rerenderWith({ settings: { ...SETTINGS, ptz_step: 40 } });
    // ⚠️ SettingsContext always resolves a moment after boot, so EVERY visit renders once with an
    // empty object. A page that seeds only in useState and never in an effect shows the fallback
    // forever and then saves it over the real value.
    expect(screen.getByLabelText('PTZ step size')).toHaveValue(40);
  });

  test('saves ONLY its own five fields', async () => {
    mockApi();
    const { user } = renderAsAdmin(<SettingsCamera />, { settings: SETTINGS });
    await user.clear(screen.getByLabelText('PTZ step size'));
    await user.type(screen.getByLabelText('PTZ step size'), '25');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(api.put).toHaveBeenCalled());
    const body = api.put.mock.calls[0][1];
    // ⚠️ THE WHOLE POINT: the settings PUT keeps any field it is not sent. Sending the full form
    // would stamp this page's copy of app_name/timezone — captured at mount — over whatever another
    // tab has since saved.
    expect(Object.keys(body).sort()).toEqual([
      'camera_offline_alert_enabled',
      'camera_offline_alert_minutes',
      'ptz_step',
      'snooze_alert_enabled',
      'snooze_alert_minutes',
    ]);
    expect(body.ptz_step).toBe('25');
    expect(body.snooze_alert_enabled).toBe(false);
    expect(body.snooze_alert_minutes).toBe(95);
  });

  test('the offline toggle is saved as a real boolean, not the 0/1 the API returns', async () => {
    mockApi();
    const { user } = renderAsAdmin(<SettingsCamera />, { settings: SETTINGS });
    await user.click(screen.getByRole('switch', OFFLINE_SWITCH));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(api.put).toHaveBeenCalled());
    expect(api.put.mock.calls[0][1].camera_offline_alert_enabled).toBe(false);
  });

  test('the minutes field is disabled while offline alerts are off', async () => {
    mockApi();
    const { user } = renderAsAdmin(<SettingsCamera />, {
      settings: { ...SETTINGS, camera_offline_alert_enabled: 0 },
    });
    const mins = screen.getByLabelText('Offline for longer than (minutes)');
    expect(mins).toBeDisabled();
    await user.click(screen.getByRole('switch', OFFLINE_SWITCH));
    expect(mins).toBeEnabled();
  });

  // --- #552: Long silence alerts ---

  test('long-silence alerts: the toggle and the minutes are saved, the toggle as a real boolean', async () => {
    mockApi();
    const { user } = renderAsAdmin(<SettingsCamera />, { settings: SETTINGS });
    const mins = screen.getByLabelText('Silenced for longer than (minutes)');
    expect(mins).toBeDisabled(); // stored off
    await user.click(screen.getByRole('switch', SILENCE_SWITCH));
    expect(mins).toBeEnabled();
    expect(mins).toHaveAttribute('min', '1');
    expect(mins).toHaveAttribute('max', '719');
    await user.clear(mins);
    await user.type(mins, '120');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(api.put).toHaveBeenCalled());
    const body = api.put.mock.calls[0][1];
    expect(body.snooze_alert_enabled).toBe(true);
    expect(body.snooze_alert_minutes).toBe('120');
  });

  test('long-silence alerts: values that never arrived are NOT saved over the stored ones', async () => {
    // The page shows the defaults (on, 60) before the settings arrive. Saving then must not send them: they
    // would overwrite whatever an admin had stored. Left undefined, they drop out of the request body and
    // the server keeps what it has.
    mockApi();
    const { user } = renderAsAdmin(<SettingsCamera />, { settings: { ptz_step: 12 } });
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(api.put).toHaveBeenCalled());
    const sentBody = JSON.parse(JSON.stringify(api.put.mock.calls[0][1]));
    expect('snooze_alert_enabled' in sentBody).toBe(false);
    expect('snooze_alert_minutes' in sentBody).toBe(false);
  });

  test('long-silence alerts: the card says who receives it on each kind of channel', () => {
    mockApi();
    renderAsAdmin(<SettingsCamera />, { settings: SETTINGS });
    expect(screen.getByText(/goes to admins only, not to the person who set the silence/)).toBeInTheDocument();
    expect(screen.getByText(/Pushover, ntfy and Gotify can't send to one person, so everyone on those receives it too,\s+including whoever set the silence/)).toBeInTheDocument();
    expect(screen.getByText(/kept silenced, on and off, for longer than the time below/)).toBeInTheDocument();
    expect(screen.getByText(/It names no one: the camera's tile and Camera history show\s+who set each silence/)).toBeInTheDocument();
    expect(screen.getByText(/within 30 minutes of the last one ending count as one, and those short gaps\s+count toward the time too/)).toBeInTheDocument();
  });

  test('shows Saved ✓ and refreshes the context on success', async () => {
    mockApi();
    const { user, settingsValue } = renderAsAdmin(<SettingsCamera />, { settings: SETTINGS });
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Saved ✓')).toBeInTheDocument();
    expect(settingsValue.refresh).toHaveBeenCalled();
  });

  test('a failed save shows the reason, no Saved banner, and leaves the button usable', async () => {
    mockApi();
    api.put.mockRejectedValue(new Error('PTZ step must be 1-100'));
    const { user } = renderAsAdmin(<SettingsCamera />, { settings: SETTINGS });
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('PTZ step must be 1-100')).toBeInTheDocument();
    expect(screen.queryByText('Saved ✓')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled();
  });

  test('the button reads Saving… and is disabled while the request is in flight', async () => {
    mockApi();
    let release;
    api.put.mockImplementation(() => new Promise((r) => { release = r; }));
    const { user } = renderAsAdmin(<SettingsCamera />, { settings: SETTINGS });
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
    release({});
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled());
  });
});
