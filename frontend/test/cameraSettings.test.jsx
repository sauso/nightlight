// Add / edit a camera — the connection and identity screen.
//
// ★ WHY THIS SCREEN. It is the payload-construction class, and this app has already been bitten by
// exactly that: a secret the server never returns, a blank field, and a save that means the wrong
// thing by it. There are TWO such fields here and they resolve it in OPPOSITE ways, which is the
// thing worth pinning:
//
//   * `rtsp_password` is always sent, blank included — the route reads a blank one as "keep the
//     stored password" (`rtsp_password ? rtsp_password : cur.password`).
//   * `talk_username`/`talk_password` are DELETED from the payload for a backchannel camera, because
//     the route reads a blank talk_username as "DISABLE two-way audio". Sending the empty fields
//     would silently switch talk-back off on any unrelated edit — renaming the camera would cost you
//     the intercom.
//
// The second is easy to "tidy up" into the first and be quite sure you have simplified something.
//
// Role gating is not tested here: the route is <AdminProtected> (routeGuards.test.jsx).
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { Routes, Route, useLocation } from 'react-router-dom';
import { renderAsAdmin } from './helpers/render.jsx';
import CameraSettings from '../src/pages/CameraSettings.jsx';
import { api } from '../src/lib/api.js';

// A fully configured camera as the API returns it to an admin: address in parts, no secrets, a flag
// for each one that is stored.
const CAM = {
  id: 'cam-1',
  name: 'Nursery',
  rtsp_host: '192.168.1.50',
  rtsp_port: '554',
  rtsp_path: '/stream1',
  rtsp_username: 'viewer',
  rtsp_has_password: true,
  sub_rtsp_path: '/stream2',
  child_id: 'kid-1',
  mqtt_topic: 'room/temp',
  talk_username: 'admin',
  talk_has_password: true,
  backchannel_supported: 'no',
  talk_backend: 'hikvision-isapi',
  detect_motion_enabled: 1,
  detect_sound_enabled: 0,
  detect_schedule_enabled: 1,
  detect_start: 1200,
  detect_end: 420,
};

const KIDS = [{ id: 'kid-1', name: 'Child B' }, { id: 'kid-2', name: 'Child A' }];

let postSpy;
let putSpy;
let delSpy;

// Renders the screen on its real route. The probe sits OUTSIDE the route table and reports the
// current path on every render — a catch-all route would not work here, because the destinations this
// screen navigates to (`/cameras/<new id>`) are matched by the screen's own route.
const Probe = () => <div>at {useLocation().pathname}</div>;

// `from` is the router state the screen that opened this one passes ({ to, label }); omitted = a direct
// link or a refresh, where the page falls back to its own parent (#383).
function mount({ cam = CAM, isNew = false, from = null } = {}) {
  const pathname = isNew ? '/cameras/new' : `/cameras/${CAM.id}`;
  return renderAsAdmin(
    <>
      <Probe />
      <Routes>
        <Route path="/cameras/new" element={<CameraSettings />} />
        <Route path="/cameras/:id" element={<CameraSettings />} />
        <Route path="*" element={<div>elsewhere</div>} />
      </Routes>
    </>,
    { cameras: cam ? [cam] : [], kids: KIDS, route: from ? { pathname, state: { from } } : pathname }
  );
}

const saved = async (spy) => {
  await waitFor(() => expect(spy).toHaveBeenCalled());
  return spy.mock.calls[0][1];
};

beforeEach(() => {
  postSpy = vi.spyOn(api, 'post').mockResolvedValue({ id: 'cam-new' });
  putSpy = vi.spyOn(api, 'put').mockResolvedValue({});
  delSpy = vi.spyOn(api, 'del').mockResolvedValue({});
});
afterEach(() => vi.restoreAllMocks());

describe('loading an existing camera into the form', () => {
  test('every stored field is shown', async () => {
    mount();
    expect((await screen.findByLabelText('Name')).value).toBe('Nursery');
    expect(screen.getByLabelText('Camera IP address').value).toBe('192.168.1.50');
    expect(screen.getByLabelText('RTSP port').value).toBe('554');
    expect(screen.getByLabelText('Stream path').value).toBe('/stream1');
    expect(screen.getByLabelText('Username').value).toBe('viewer');
    expect(screen.getByLabelText('Low-quality stream path (optional)').value).toBe('/stream2');
    expect(screen.getByLabelText(/MQTT topic/).value).toBe('room/temp');
    expect(screen.getByLabelText(/Assign to child/).value).toBe('kid-1');
  });

  test('★ the password box is EMPTY, and says the stored one is unchanged', async () => {
    // Both halves matter. Empty is what makes "blank means keep" possible at all; the placeholder is
    // the only thing that stops an empty box reading as "no password set", which would invite someone
    // to type one in and thereby replace a working credential.
    mount();
    const pw = await screen.findByLabelText('Password');
    expect(pw.value, 'the stored password is never sent to the browser').toBe('');
    expect(pw.type).toBe('password');
    expect(pw.placeholder).toBe('•••••• (unchanged)');
  });

  test('a camera with no stored password gets no "unchanged" hint', async () => {
    mount({ cam: { ...CAM, rtsp_has_password: false } });
    expect((await screen.findByLabelText('Password')).placeholder).toBe('');
  });

  test('a camera still loading shows Loading…, not a blank form', async () => {
    // The form would otherwise initialise from nothing and be one Save away from writing those blanks
    // over a configured camera.
    mount({ cam: null });
    expect(screen.getByText('Loading…')).toBeTruthy();
    expect(screen.queryByLabelText('Name')).toBeNull();
  });
});

describe('★★ saving an edit', () => {
  test('sends the blank password, which the route reads as "keep the stored one"', async () => {
    const { user } = mount();
    const name = await screen.findByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Nursery cam');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    const body = await saved(putSpy);
    expect(putSpy.mock.calls[0][0]).toBe('/cameras/cam-1');
    expect(body.name).toBe('Nursery cam');
    expect(body.rtsp_password, 'blank is sent, and means keep — see routes/cameras.js').toBe('');
  });

  test('a typed password IS sent', async () => {
    const { user } = mount();
    await user.type(await screen.findByLabelText('Password'), 'newsecret');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect((await saved(putSpy)).rtsp_password).toBe('newsecret');
  });

  test('★★ a backchannel camera never sends its talk fields — a blank one DISABLES talk-back', async () => {
    // THE test for this screen. A camera that carries talk-back over its stream audio has no separate
    // talk login, so those inputs are not even rendered and `form.talk_username` stays ''. The route
    // reads a sent-but-empty talk_username as "turn two-way audio off". If these were left in the
    // payload, renaming the camera would silently kill the intercom, and nothing would say so.
    const { user } = mount({ cam: { ...CAM, backchannel_supported: 'yes', talk_backend: null } });
    await screen.findByLabelText('Name');
    expect(screen.queryByLabelText('Talk username'), 'no separate login to ask for').toBeNull();

    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    const body = await saved(putSpy);
    expect(body).not.toHaveProperty('talk_username');
    expect(body).not.toHaveProperty('talk_password');
  });

  test('…but an ISAPI camera DOES send them, because that is where they are set', async () => {
    // The mirror image, and the reason the deletion has to be conditional rather than unconditional:
    // for a Hikvision-style camera these fields are the only way to configure talk-back at all, and
    // clearing the username is the documented way to switch it off.
    const { user } = mount();
    expect(await screen.findByLabelText('Talk username')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    const body = await saved(putSpy);
    expect(body.talk_username).toBe('admin');
    expect(body.talk_password, 'blank talk password = keep, same as the stream one').toBe('');
  });

  test('unassigning a child sends null, not an empty string', async () => {
    // The route attaches on a truthy child_id and detaches on null. '' is neither, and would leave the
    // camera attached to a child the form is showing as Unassigned.
    const { user } = mount();
    await user.selectOptions(await screen.findByLabelText(/Assign to child/), '');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect((await saved(putSpy)).child_id).toBe(null);
  });

  test('a successful edit refreshes the camera list and returns to the Cameras tab', async () => {
    // The refresh is not cosmetic — every other screen reads cameras from that context, so skipping it
    // would leave the rest of the app showing the old address until a reload.
    // CHANGED ON PURPOSE (#383): this asserted `/family`, a retired route that redirects to Children, so a
    // camera opened from the Cameras tab was saved and then dropped on the Children tab. With no router
    // state the page's own parent is the Cameras tab.
    const { user, camerasValue } = mount();
    await user.click(await screen.findByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(camerasValue.refresh).toHaveBeenCalled());
    expect(await screen.findByText('at /cameras')).toBeTruthy();
  });
});

// ★ #383. Where "Back" points, and where a finished save or remove lands, must be the same place.
// The header link already honoured `location.state.from`; the navigate after a save/remove did not, and
// ignored it for a hard-coded '/family'. Both halves are asserted, with an origin that is NOT the default
// (a child page) so a fallback cannot satisfy it by coincidence.
describe('★ Back and the landing after save/remove agree (#383)', () => {
  const FROM_CHILD = { to: '/children/kid-1', label: 'Child B' };

  test('no router state: the link says Cameras, and a save lands on /cameras', async () => {
    const { user } = mount();
    expect(await screen.findByRole('button', { name: 'Back to Cameras' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('at /cameras')).toBeTruthy();
  });

  test('opened from a child: the link names that child and a SAVE returns there', async () => {
    const { user } = mount({ from: FROM_CHILD });
    expect(await screen.findByRole('button', { name: 'Back to Child B' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('at /children/kid-1')).toBeTruthy();
  });

  test('opened from a child: a REMOVE returns there too', async () => {
    const { user } = mount({ from: FROM_CHILD });
    await user.click(await screen.findByRole('button', { name: 'Remove camera' }));
    await user.click(await screen.findByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(delSpy).toHaveBeenCalledWith('/cameras/cam-1'));
    expect(await screen.findByText('at /children/kid-1')).toBeTruthy();
  });
});

describe('adding a camera', () => {
  test('starts empty and POSTs to /cameras', async () => {
    const { user } = mount({ isNew: true });
    const name = await screen.findByLabelText('Name');
    expect(name.value).toBe('');
    expect(screen.getByLabelText('RTSP port').value, 'the usual RTSP port is offered').toBe('554');

    await user.type(name, 'Playroom');
    await user.type(screen.getByLabelText('Camera IP address'), '10.0.0.9');
    await user.click(screen.getByRole('button', { name: 'Add camera' }));

    const body = await saved(postSpy);
    expect(postSpy.mock.calls[0][0]).toBe('/cameras');
    expect(body.name).toBe('Playroom');
    expect(body.rtsp_host).toBe('10.0.0.9');
  });

  test('★ a new camera lands on its OWN page, not back at the list', async () => {
    // Deliberate: motion, sound and the bed zone are configured from the camera's own screen, and they
    // are the entire point of adding it. Dropping the user back at Family would leave a camera that
    // streams and detects nothing, which looks like the feature not working.
    const { user } = mount({ isNew: true });
    await user.type(await screen.findByLabelText('Name'), 'Playroom');
    await user.type(screen.getByLabelText('Camera IP address'), '10.0.0.9');
    await user.click(screen.getByRole('button', { name: 'Add camera' }));
    expect(await screen.findByText('at /cameras/cam-new')).toBeTruthy();
  });

  test('detection rows are hidden until the camera exists', async () => {
    // There is nothing to configure detection against yet — the routes behind those rows take a
    // camera id.
    mount({ isNew: true });
    await screen.findByLabelText('Name');
    expect(screen.queryByText('Motion detection')).toBeNull();
    expect(screen.queryByText('Alert schedule')).toBeNull();
  });

  test('and there is nothing to remove yet', async () => {
    mount({ isNew: true });
    await screen.findByLabelText('Name');
    expect(screen.queryByRole('button', { name: 'Remove camera' })).toBeNull();
  });
});

describe('★ an unreachable camera can still be saved', () => {
  // The server probes the stream on save and returns 422 + needsConfirm rather than refusing outright,
  // because a camera that is merely switched off right now is a normal thing to be adding.
  const unreachable = () => {
    const err = new Error('connection refused');
    err.status = 422;
    err.data = { needsConfirm: true, error: 'connection refused' };
    return err;
  };

  test('the warning explains it and offers Save anyway', async () => {
    putSpy = vi.spyOn(api, 'put').mockRejectedValue(unreachable());
    const { user } = mount();
    await user.click(await screen.findByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText(/Couldn't reach the camera stream: connection refused/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save anyway' })).toBeTruthy();
    // ⚠️ Not an error banner: this is a question, and treating it as a failure would tell someone
    // their settings were wrong when they may be perfectly right.
    expect(document.querySelector('.error-banner')).toBeNull();
  });

  test('★★ Save anyway re-sends the SAME payload with force, not a fresh one', async () => {
    // The retry has to carry everything the first attempt did. A force-retry that rebuilt a thinner
    // payload would be a save that quietly did less than the one the user was told had failed.
    putSpy = vi.spyOn(api, 'put').mockRejectedValue(unreachable());
    const { user } = mount();
    await user.click(await screen.findByRole('button', { name: 'Save changes' }));
    await screen.findByRole('button', { name: 'Save anyway' });

    await user.click(screen.getByRole('button', { name: 'Save anyway' }));
    await waitFor(() => expect(putSpy).toHaveBeenCalledTimes(2));
    const [first, second] = putSpy.mock.calls.map((c) => c[1]);
    expect(second).toEqual({ ...first, force: true });
  });

  test('★★ after Save anyway ADDS a camera, its page shows Save changes and no stale warning (#496)', async () => {
    // The page stays mounted from /cameras/new to /cameras/<new id> (same component, same position in the route
    // table), so the state set by the failed first attempt used to survive onto the new camera's page.
    const created = { ...CAM, id: 'cam-new', name: 'Playroom' };
    postSpy = vi.spyOn(api, 'post')
      .mockRejectedValueOnce(unreachable())
      .mockResolvedValue({ id: 'cam-new' });
    const { user } = renderAsAdmin(
      <>
        <Probe />
        <Routes>
          <Route path="/cameras/new" element={<CameraSettings />} />
          <Route path="/cameras/:id" element={<CameraSettings />} />
        </Routes>
      </>,
      { cameras: [CAM, created], kids: KIDS, route: '/cameras/new' }
    );
    await user.type(await screen.findByLabelText('Name'), 'Playroom');
    await user.type(screen.getByLabelText('Camera IP address'), '10.0.0.9');
    await user.click(screen.getByRole('button', { name: 'Add camera' }));
    await user.click(await screen.findByRole('button', { name: 'Save anyway' }));

    expect(await screen.findByText('at /cameras/cam-new')).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Save changes' })).toBeTruthy();
    expect(screen.queryByText(/Couldn't reach the camera stream/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save anyway' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry save' })).toBeNull();
  });

  test('an ordinary failure is shown as an error, with no override offered', async () => {
    // Only `needsConfirm` earns the override. Offering "Save anyway" for, say, a duplicate name would
    // invite someone to force a save that cannot succeed.
    putSpy = vi.spyOn(api, 'put').mockRejectedValue(new Error('A camera with that name already exists'));
    const { user } = mount();
    await user.click(await screen.findByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText('A camera with that name already exists')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save anyway' })).toBeNull();
  });
});

describe('the ONVIF fetch', () => {
  const PROBE = {
    rtspHost: '192.168.1.50', rtspPort: '554', rtspPath: '/onvif/main', subRtspPath: '/onvif/sub',
    backchannel: 'yes', backchannelVerified: true, ptz: true, motionEvents: 'yes',
    onvifDeviceUrl: 'http://192.168.1.50/onvif/device', profileToken: 'Profile_1',
    video: { codec: 'H264', width: 1920, height: 1080 },
  };

  test('fills in the paths it discovered and says what it found', async () => {
    postSpy = vi.spyOn(api, 'post').mockResolvedValue(PROBE);
    const { user } = mount();
    await user.click(await screen.findByRole('button', { name: /Fetch port, path/ }));

    await waitFor(() => expect(screen.getByLabelText('Stream path').value).toBe('/onvif/main'));
    expect(screen.getByLabelText('Low-quality stream path (optional)').value).toBe('/onvif/sub');
    // Asserted against the one message element rather than the page: a regex matcher tests the whole
    // textContent, so a page-wide query also matches every ancestor and cannot tell you the
    // capabilities were reported TOGETHER, in the summary the person actually reads.
    const summary = screen.getByText(/^Found stream/).textContent;
    expect(summary).toContain('H264 1920×1080');
    expect(summary).toContain('two-way audio');
    expect(summary).toContain('PTZ');
    expect(summary).toContain('ONVIF motion');
    expect(summary).toContain('low-quality stream');
  });

  test('★ a probe that finds nothing does not wipe what is already there', async () => {
    // Every assignment is `discovered || existing`. A camera configured by hand, re-probed by someone
    // curious, must not come back blank — that would turn an idle click into a broken camera.
    //
    // ⚠️ ASSERTED ON THE SAVED PAYLOAD, not only on the boxes. Dropping the `|| existing` fallback
    // sets the field to `undefined`, which makes React treat the input as UNCONTROLLED — so the old
    // text stays on screen while the state behind it is empty, and the screen looks perfectly fine
    // right up until you press Save. Checking the inputs alone passed against that mutation; the
    // payload is where the damage would actually be.
    postSpy = vi.spyOn(api, 'post').mockResolvedValue({ backchannel: 'no' });
    const { user } = mount();
    await user.click(await screen.findByRole('button', { name: /Fetch port, path/ }));
    await waitFor(() => expect(screen.getByText(/Found stream/)).toBeTruthy());

    expect(screen.getByLabelText('Stream path').value).toBe('/stream1');
    expect(screen.getByLabelText('Low-quality stream path (optional)').value).toBe('/stream2');
    expect(screen.getByLabelText('RTSP port').value).toBe('554');

    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    const body = await saved(putSpy);
    expect(body.rtsp_path).toBe('/stream1');
    expect(body.sub_rtsp_path).toBe('/stream2');
    expect(body.rtsp_port).toBe('554');
  });

  test('★★ the capabilities it discovered are carried into the next save', async () => {
    // The probe result is not just filling in text boxes: PTZ support, the ONVIF device URL and the
    // profile token are stored on the camera and are what make the PTZ controls and ONVIF motion work
    // later. They ride along on the next save and there is no other way for them to be persisted, so
    // losing them here would leave a perfectly capable camera with its features switched off.
    postSpy = vi.spyOn(api, 'post').mockResolvedValue(PROBE);
    const { user } = mount();
    await user.click(await screen.findByRole('button', { name: /Fetch port, path/ }));
    await waitFor(() => expect(screen.getByLabelText('Stream path').value).toBe('/onvif/main'));

    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    const body = await saved(putSpy);
    expect(body.discovery_source).toBe('onvif');
    expect(body.ptz_supported).toBe(1);
    expect(body.onvif_device_url).toBe('http://192.168.1.50/onvif/device');
    expect(body.onvif_profile_token).toBe('Profile_1');
    expect(body.motion_events_supported).toBe('yes');
  });

  test('it refuses to probe without an address, rather than asking the server about nothing', async () => {
    const { user } = mount({ isNew: true });
    await user.click(await screen.findByRole('button', { name: /Fetch port, path/ }));
    expect(await screen.findByText('Enter the camera IP first')).toBeTruthy();
    expect(postSpy).not.toHaveBeenCalled();
  });

  test('a failed probe is reported and leaves the form alone', async () => {
    postSpy = vi.spyOn(api, 'post').mockRejectedValue(new Error('No ONVIF service on that address'));
    const { user } = mount();
    await user.click(await screen.findByRole('button', { name: /Fetch port, path/ }));
    expect(await screen.findByText('No ONVIF service on that address')).toBeTruthy();
    expect(screen.getByLabelText('Stream path').value).toBe('/stream1');
  });
});

describe('the two-way audio panel', () => {
  test('★ a backchannel camera is told it needs no login', async () => {
    // Prompting for a talk login on a camera that rides the stream audio is worse than unhelpful: the
    // save path discards whatever is typed, so the field would look like a setting and be a no-op.
    mount({ cam: { ...CAM, backchannel_supported: 'yes', talk_backend: null } });
    expect(await screen.findByText(/no separate login/)).toBeTruthy();
    expect(screen.queryByLabelText('Talk username')).toBeNull();
  });

  test('an ISAPI camera gets the credential form and a verify button', async () => {
    mount();
    expect(await screen.findByLabelText('Talk username')).toBeTruthy();
    expect(screen.getByLabelText('Talk password').placeholder).toBe('•••••• (unchanged)');
    expect(screen.getByRole('button', { name: 'Verify login' })).toBeTruthy();
  });

  test('★ a camera with no backchannel and no known backend shows no talk panel at all', async () => {
    // The stated reason in the source: a legacy camera whose backend was never resolved must not be
    // shown the credential form, because leaving its username blank there would read as "disable
    // talk-back" on the next save. Silence is the safe default.
    mount({ cam: { ...CAM, backchannel_supported: undefined, talk_backend: null } });
    await screen.findByLabelText('Name');
    expect(screen.queryByText(/Two-way audio/)).toBeNull();
  });

  test('a fresh probe overrules the stored backend', async () => {
    // `backchannelVerified` comes from a live check, so it beats whatever was recorded when the camera
    // was added — that is how a camera fixed by a firmware update stops asking for a login it no
    // longer needs.
    postSpy = vi.spyOn(api, 'post').mockResolvedValue({ backchannel: 'yes', backchannelVerified: true });
    const { user } = mount();
    expect(await screen.findByLabelText('Talk username')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /Fetch port, path/ }));
    await waitFor(() => expect(screen.queryByLabelText('Talk username')).toBeNull());
    expect(screen.getByText(/no separate login/)).toBeTruthy();
  });

  test('verify reports success and failure distinctly', async () => {
    postSpy = vi.spyOn(api, 'post').mockResolvedValue({ codec: 'PCMU' });
    const { user } = mount();
    await user.click(await screen.findByRole('button', { name: 'Verify login' }));
    expect(await screen.findByText(/Talk login works — PCMU/)).toBeTruthy();

    vi.restoreAllMocks();
    vi.spyOn(api, 'post').mockRejectedValue(new Error('401 from the camera'));
    await user.click(screen.getByRole('button', { name: 'Verify login' }));
    expect(await screen.findByText('401 from the camera')).toBeTruthy();
  });

  test('verify refuses before there is a username to verify', async () => {
    const { user } = mount({ cam: { ...CAM, talk_username: '' } });
    await user.click(await screen.findByRole('button', { name: 'Verify login' }));
    expect(await screen.findByText('Enter the talk username first')).toBeTruthy();
    expect(postSpy).not.toHaveBeenCalled();
  });
});

describe('the detection rows', () => {
  test('show each detector\'s current state and the schedule window', async () => {
    // These rows are the only place the three detection settings are visible together, so they are
    // how someone checks at a glance that a camera is actually armed.
    mount();
    await screen.findByText('Motion detection');
    const row = (label) => screen.getByText(label).closest('.det-row');
    expect(row('Motion detection').textContent).toContain('On');
    expect(row('Sound detection').textContent).toContain('Off');
    expect(row('Alert schedule').textContent, '1200 and 420 minutes past midnight').toContain('20:00–07:00');
  });

  test('a camera with no schedule reads Always, not a zero-length window', async () => {
    mount({ cam: { ...CAM, detect_schedule_enabled: 0 } });
    await screen.findByText('Alert schedule');
    expect(screen.getByText('Alert schedule').closest('.det-row').textContent).toContain('Always');
  });

  test('midnight formats as 00:00 rather than being treated as missing', async () => {
    // `minToHHMM` writes `m || 0`, so a genuine 0 and a missing value look the same going in — which
    // is fine only because they produce the same output. Pinned so a "tidier" `m ?? 0` refactor, or a
    // switch to a formatter that treats 0 as absent, does not put a blank where midnight should be.
    mount({ cam: { ...CAM, detect_start: 0, detect_end: 90 } });
    await screen.findByText('Alert schedule');
    expect(screen.getByText('Alert schedule').closest('.det-row').textContent).toContain('00:00–01:30');
  });

  test('each row opens its own screen', async () => {
    const { user } = mount();
    await user.click(await screen.findByText('Sound detection'));
    expect(await screen.findByText('at /cameras/cam-1/sound')).toBeTruthy();
  });
});

describe('removing a camera', () => {
  test('★ asks in an in-app modal, and does nothing until it is confirmed', async () => {
    // An in-app Modal rather than window.confirm — the house rule, and the reason a caregiver-facing
    // destructive action stays testable at all. The important half is that opening the dialog is not
    // itself the deletion.
    const { user } = mount();
    await user.click(await screen.findByRole('button', { name: 'Remove camera' }));
    expect(await screen.findByText(/This stops its stream and permanently deletes everything/)).toBeTruthy();
    expect(delSpy).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByText(/This stops its stream/)).toBeNull());
    expect(delSpy).not.toHaveBeenCalled();
  });

  // ★ #554. The server now deletes everything recorded by the camera, files included, so the dialog has
  // to say so: the old copy ("deletes it from Nightlight ... you can always add it again") promised that
  // adding it back was a full undo, which is no longer true. Each category is asserted on its own, because
  // a single regex over the paragraph would stay green if one line of the list were dropped.
  test('★ #554 the dialog says plainly that everything for the camera is deleted, lists what, and asks', async () => {
    const { user } = mount();
    await user.click(await screen.findByRole('button', { name: 'Remove camera' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/permanently deletes everything for this camera/)).toBeTruthy();
    const items = within(dialog).getAllByRole('listitem').map((li) => li.textContent);
    expect(items).toHaveLength(5);
    expect(items.join('|')).toMatch(/bed transitions and their snapshot photos/);
    expect(items.join('|')).toMatch(/activity history/);
    expect(items.join('|')).toMatch(/alerts, with their clips and snapshots/);
    expect(items.join('|')).toMatch(/recordings and wake clips, including the video files/);
    expect(items.join('|')).toMatch(/event log and temperature and humidity history/);
    expect(within(dialog).getByText('Are you sure?')).toBeTruthy();
    expect(within(dialog).getByText(/none of this comes back/)).toBeTruthy();
    // #719 review: the nights it recorded are the child's and keep their summary and timelapse, but not their
    // detail or photos.
    expect(within(dialog).getByText(/Nights it recorded keep their saved summary and their timelapse but lose their detail and their morning-review photos/)).toBeTruthy();
    expect(delSpy).not.toHaveBeenCalled();
  });

  // ★ #719 review. The server refuses with a 409 and a reason (a 5xx body is stripped by Cloudflare). Through the
  // REAL api.js (only fetch is stubbed), so the seam is tested: the dialog must show the server's own words, never
  // "Request failed (409)".
  test('★ #719 a refused delete (409) shows the server\'s reason inside the dialog', async () => {
    const reason = 'This camera is recording. Stop the recording first, then remove the camera.';
    delSpy.mockRestore();
    const fetchSpy = vi.fn(async () => ({ ok: false, status: 409, text: async () => JSON.stringify({ error: reason }) }));
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const { user, camerasValue } = mount();
      await user.click(await screen.findByRole('button', { name: 'Remove camera' }));
      await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove' }));
      const dialog = screen.getByRole('dialog');
      expect(await within(dialog).findByRole('alert')).toHaveTextContent(reason);
      expect(within(dialog).queryByText(/Request failed/)).toBeNull();
      expect(fetchSpy).toHaveBeenCalledWith('/api/cameras/cam-1', expect.objectContaining({ method: 'DELETE' }));
      expect(camerasValue.refresh).not.toHaveBeenCalled();
      expect(screen.getByText('at /cameras/cam-1')).toBeTruthy();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('confirming deletes it, refreshes the list and returns to the Cameras tab', async () => {
    // CHANGED ON PURPOSE (#383): was `/family`, see the save test above.
    const { user, camerasValue } = mount();
    await user.click(await screen.findByRole('button', { name: 'Remove camera' }));
    await user.click(await screen.findByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(delSpy).toHaveBeenCalledWith('/cameras/cam-1'));
    await waitFor(() => expect(camerasValue.refresh).toHaveBeenCalled());
    expect(await screen.findByText('at /cameras')).toBeTruthy();
  });

  test('★ a failed delete says why and leaves the camera alone', async () => {
    // The camera is still there, so the screen has to stay on it. Navigating away on a failed delete
    // would look exactly like a successful one.
    delSpy = vi.spyOn(api, 'del').mockRejectedValue(new Error('Camera is in use by a recording'));
    const { user } = mount();
    await user.click(await screen.findByRole('button', { name: 'Remove camera' }));
    await user.click(await screen.findByRole('button', { name: 'Remove' }));

    expect(await screen.findByText('Camera is in use by a recording')).toBeTruthy();
    // Positive form: still ON the camera. (It used to assert only that '/family' was absent, which is true
    // of any page at all, so it could not have caught a navigation to somewhere else.)
    expect(screen.getByText('at /cameras/cam-1')).toBeTruthy();
  });

  // ★ #378. See cameras.test.jsx for why "the text is in the document" proves nothing here: the page-level
  // banner is in <main>, under the modal overlay. jsdom cannot see the overlay; it can see which element
  // the message is a descendant of.
  test('★ #378 the failure is shown INSIDE the dialog, once, with the dialog still open and retryable', async () => {
    delSpy = vi.spyOn(api, 'del').mockRejectedValue(new Error('Refused: recording in progress #378'));
    const { user, camerasValue } = mount();
    await user.click(await screen.findByRole('button', { name: 'Remove camera' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove' }));

    const dialog = screen.getByRole('dialog');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Refused: recording in progress #378');
    expect(screen.getAllByText('Refused: recording in progress #378')).toHaveLength(1);
    expect(within(dialog).getByRole('button', { name: 'Remove' })).toBeEnabled();
    expect(camerasValue.refresh).not.toHaveBeenCalled();
    expect(screen.getByText('at /cameras/cam-1')).toBeTruthy();

    // A retry that works leaves, and a reopened dialog starts clean.
    delSpy.mockResolvedValue({});
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));
    expect(await screen.findByText('at /cameras')).toBeTruthy();
  });

  test('★ #378 pressing Remove again clears the old failure WHILE the retry is in flight', async () => {
    // The message from the failed attempt must not sit there, contradicting "Removing…", until the retry
    // settles: it would read as the retry having already failed. Held pending so the in-flight moment is
    // observable; then rejected with a DIFFERENT message to show the new failure replaces it.
    delSpy = vi.spyOn(api, 'del').mockRejectedValueOnce(new Error('First refusal #378'));
    const { user } = mount();
    await user.click(await screen.findByRole('button', { name: 'Remove camera' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove' }));
    expect(await within(screen.getByRole('dialog')).findByRole('alert')).toHaveTextContent('First refusal #378');

    let rejectRetry;
    delSpy.mockImplementationOnce(() => new Promise((_, reject) => { rejectRetry = reject; }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Removing…' })).toBeDisabled();
    expect(within(dialog).queryByRole('alert'), 'the first failure is gone while the retry runs').toBeNull();
    expect(within(dialog).queryByText('First refusal #378')).toBeNull();

    rejectRetry(new Error('Second refusal #378'));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Second refusal #378');
    expect(within(dialog).getByRole('button', { name: 'Remove' })).toBeEnabled();
  });

  test('★ #378 a stale message is gone when the dialog is cancelled and reopened', async () => {
    delSpy = vi.spyOn(api, 'del').mockRejectedValue(new Error('Refused once #378'));
    const { user } = mount();
    await user.click(await screen.findByRole('button', { name: 'Remove camera' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove' }));
    await within(screen.getByRole('dialog')).findByText('Refused once #378');
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await user.click(screen.getByRole('button', { name: 'Remove camera' }));
    expect(within(screen.getByRole('dialog')).queryByRole('alert')).toBeNull();
  });
});
