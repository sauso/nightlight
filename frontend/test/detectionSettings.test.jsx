// The Motion / Sound / Alert-schedule screens — one component serving three routes.
//
// ★ WHY THIS SCREEN IS WORTH REAL TESTS. It has no Save button. Every control applies itself, and
// each write restarts the camera's detector, so the two things that can go wrong are both invisible:
//
//  1. **It writes the WHOLE detection state on every change, not a patch.** The screen holds all
//     three slices (motion, sound, schedule) and re-sends all of them whenever any one is touched.
//     So a field `fromCam` fails to read, or `toPayload` fails to carry, does not go missing — it goes
//     out WRONG, and adjusting the sound sensitivity silently rewrites the motion zone or the alert
//     window. Nothing on screen would show it; the next night's data would just be worse.
//     (The server-side half of this contract — that an omitted field is kept — is pinned in
//     backend/test/detection-route.test.js. Only the two together cover the seam.)
//  2. **Writes are debounced at 700 ms and coalesced.** Dragging a slider must produce ONE restart,
//     not forty. A lost debounce would not fail anything; it would just thrash the detector.
//
// Role gating is not tested here: the route is <AdminProtected> (routeGuards.test.jsx).
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import { Routes, Route } from 'react-router-dom';
import { renderAsAdmin } from './helpers/render.jsx';
import DetectionSettings from '../src/pages/DetectionSettings.jsx';
import { api } from '../src/lib/api.js';

// The debounce is 700 ms of real time. Every assertion about a write therefore needs a window wider
// than that — fake timers were avoided deliberately, because userEvent drives its own clock and the
// two interacting is a well-known source of tests that pass for the wrong reason.
const SETTLE = { timeout: 3000 };

// A camera with every detection field set to something distinctive, so a value that gets reset to a
// default on the way through is visible rather than coincidentally equal to one.
const CAM = {
  id: 'cam-1',
  name: 'Nursery',
  detect_motion_enabled: 1,
  detect_sensitivity: 88,
  detect_cooldown_s: 45,
  detect_confirm_s: 7,
  detect_schedule_enabled: 1,
  detect_start: 1140, // 19:00
  detect_end: 400, // 06:40
  detect_source: 'framediff',
  detect_zone: [{ x: 0.2, y: 0.3, w: 0.4, h: 0.5 }],
  motion_mqtt_topic: 'cam/motion',
  motion_mqtt_value: 'ON',
  snapshot_url: 'http://cam/snap.jpg',
  detect_sound_enabled: 1,
  sound_sensitivity: 72,
  sound_confirm_s: 6,
  sound_cooldown_s: 200,
  detect_record_clips: 1,
  onvif_motion_capable: 0,
};

let putSpy;

function mount(kind, cam = CAM) {
  return renderAsAdmin(
    <Routes>
      <Route path="/cameras/:id/:kind" element={<DetectionSettings />} />
    </Routes>,
    { cameras: [cam], route: `/cameras/${cam.id}/${kind}` }
  );
}

// The single write the screen produced, once the debounce has fired.
async function sentBody() {
  await waitFor(() => expect(putSpy).toHaveBeenCalled(), SETTLE);
  return putSpy.mock.calls[putSpy.mock.calls.length - 1][1];
}

beforeEach(() => {
  putSpy = vi.spyOn(api, 'put').mockResolvedValue({});
});
afterEach(() => vi.restoreAllMocks());

describe('★★ every write carries the whole detection state', () => {
  test('changing the SOUND sensitivity re-sends the motion slice untouched', async () => {
    // THE test this file exists for. The sound screen cannot see the motion settings, but it sends
    // them — so it has to send back exactly what it was given. The bed zone is the one that would
    // hurt most: it is painted per installation, nothing validates it, and sleep tracking depends on
    // it entirely.
    const { user } = mount('sound');
    const slider = await screen.findByLabelText(/Sensitivity/);
    fireEvent.change(slider, { target: { value: '30' } });

    const body = await sentBody();
    expect(body.sound_sensitivity).toBe(30);
    expect(body.zone, 'the painted bed zone must survive an unrelated edit').toEqual(CAM.detect_zone);
    expect(body.sensitivity).toBe(88);
    expect(body.source).toBe('framediff');
    expect(body.motion_enabled).toBe(true);
    expect(body.start).toBe(1140);
    expect(body.end).toBe(400);
    expect(body.motion_mqtt_topic).toBe('cam/motion');
    expect(body.snapshot_url).toBe('http://cam/snap.jpg');
    expect(body.record_clips).toBe(true);
    void user;
  });

  test('changing the SCHEDULE re-sends both detectors untouched', async () => {
    const { user } = mount('schedule');
    const from = await screen.findByLabelText('From');
    fireEvent.change(from, { target: { value: '21:30' } });

    const body = await sentBody();
    expect(body.start, '21:30 in minutes since midnight').toBe(1290);
    expect(body.sound_sensitivity).toBe(72);
    expect(body.sensitivity).toBe(88);
    expect(body.zone).toEqual(CAM.detect_zone);
    void user;
  });

  test('the payload carries every field the route understands', async () => {
    // An exact key set. A field dropped here would be preserved by the route rather than cleared, so
    // the symptom would not be data loss — it would be a control on this screen that silently stops
    // having any effect, which is harder to notice and harder to diagnose.
    mount('sound');
    fireEvent.change(await screen.findByLabelText(/Sensitivity/), { target: { value: '30' } });
    const body = await sentBody();
    expect(Object.keys(body).sort()).toEqual([
      'confirm_s', 'cooldown_s', 'end', 'motion_enabled', 'motion_mqtt_topic', 'motion_mqtt_value',
      'record_clips', 'schedule_enabled', 'sensitivity', 'snapshot_url', 'sound_confirm_s',
      'sound_cooldown_s', 'sound_enabled', 'sound_sensitivity', 'source', 'start', 'zone',
    ]);
  });

  test('numbers typed into text boxes are sent as numbers, not strings', async () => {
    // The inputs hand back strings. The route coerces too, but only after `Number(x) || default` —
    // so a string that fails to coerce lands on the default rather than erroring, and the setting
    // someone just typed would quietly not be the one saved.
    mount('sound');
    const confirm = await screen.findByLabelText('Confirm (seconds)');
    fireEvent.change(confirm, { target: { value: '12' } });
    const body = await sentBody();
    expect(body.sound_confirm_s).toBe(12);
    expect(typeof body.sound_confirm_s).toBe('number');
  });
});

describe('★ writes are debounced and coalesced', () => {
  test('a flurry of changes produces ONE write, carrying the last value', async () => {
    // Each write restarts the camera's detector. Dragging a slider fires a change per pixel, so
    // without coalescing this screen would restart the detector dozens of times and the camera would
    // effectively stop watching while someone adjusts it.
    mount('sound');
    const slider = await screen.findByLabelText(/Sensitivity/);
    for (const v of ['20', '30', '40', '55']) fireEvent.change(slider, { target: { value: v } });

    await waitFor(() => expect(putSpy).toHaveBeenCalled(), SETTLE);
    expect(putSpy).toHaveBeenCalledTimes(1);
    expect(putSpy.mock.calls[0][1].sound_sensitivity).toBe(55);
  });

  test('nothing is written until the pause — and the pause is a real one', async () => {
    // The other half: if the write fired immediately and only COALESCED afterwards, the test above
    // would still pass while the first change had already gone out.
    //
    // ⚠️ The obvious assertion — "not called, synchronously, right after the change" — is worthless
    // here, because `setTimeout(fn, 0)` is also asynchronous. It passed against a mutant that reduced
    // the debounce to zero, which is the entire behaviour under test. So this waits out a window far
    // longer than a slider drag's gaps and shorter than the real 700 ms, and requires silence across
    // it. That is the property that actually matters: a change is held long enough to absorb the next
    // one.
    mount('sound');
    fireEvent.change(await screen.findByLabelText(/Sensitivity/), { target: { value: '20' } });
    expect(putSpy).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 350));
    expect(putSpy, 'a change must still be waiting 350 ms later').not.toHaveBeenCalled();
    await waitFor(() => expect(putSpy).toHaveBeenCalled(), SETTLE);
  });

  test('it writes to the camera named in the route', async () => {
    mount('sound');
    fireEvent.change(await screen.findByLabelText(/Sensitivity/), { target: { value: '20' } });
    await waitFor(() => expect(putSpy).toHaveBeenCalled(), SETTLE);
    expect(putSpy.mock.calls[0][0]).toBe('/cameras/cam-1/detection');
  });
});

describe('the save flag', () => {
  test('says Saving… then Saved ✓', async () => {
    mount('sound');
    fireEvent.change(await screen.findByLabelText(/Sensitivity/), { target: { value: '20' } });
    expect(await screen.findByText('Saving…')).toBeTruthy();
    expect(await screen.findByText('Saved ✓', {}, SETTLE)).toBeTruthy();
  });

  test('★★ a FAILED write never says Saved ✓', async () => {
    // There is no error banner on this screen — the flag is the only feedback there is. If a failed
    // write still reported success, someone would set a sensitivity, read "Saved ✓", and walk away
    // from a camera that was never reconfigured. (That the failure is otherwise silent is a real
    // limitation, and deliberately not papered over here: this test pins that it at least does not
    // LIE. Reporting the reason would be a change to the screen, not to its tests.)
    vi.restoreAllMocks();
    putSpy = vi.spyOn(api, 'put').mockRejectedValue(new Error('camera is offline'));
    mount('sound');
    fireEvent.change(await screen.findByLabelText(/Sensitivity/), { target: { value: '20' } });

    await waitFor(() => expect(putSpy).toHaveBeenCalled(), SETTLE);
    await waitFor(() => expect(screen.queryByText('Saving…')).toBeNull(), SETTLE);
    expect(screen.queryByText('Saved ✓')).toBeNull();
  });
});

describe('reading a camera into the form', () => {
  test('★★ a stored ZERO confirm delay survives — no delay is a real choice', async () => {
    // The defaults are written `?? 3` / `?? 4`; a single `||` would show 4 to somebody who had
    // deliberately chosen 0, and then WRITE that 4 back on the next unrelated change. The route
    // accepts 0 (its floor is 0, not 1), so this is a value someone can really be running.
    mount('sound', { ...CAM, sound_confirm_s: 0 });
    expect((await screen.findByLabelText('Confirm (seconds)')).value).toBe('0');
  });

  test('★★ and so does a stored ZERO on the MOTION screen', async () => {
    // The same `??`-vs-`||` trap, on the other detector. `detect_confirm_s` has the same floor of 0
    // server-side (`Math.max(0, …)`), so 0 is a value a camera can really be running — and because
    // this screen rewrites the whole payload on any change, showing 3 instead would then SAVE 3 over
    // it on the next unrelated edit. Covering only the sound field left this one open: mutating
    // `detect_confirm_s ?? 3` to `|| 3` survived the whole suite.
    mount('motion', { ...CAM, detect_confirm_s: 0 });
    expect((await screen.findByLabelText('Confirm (seconds)')).value).toBe('0');
  });

  test('missing values fall back to the documented defaults', async () => {
    mount('sound', { id: 'cam-1', name: 'Bare', detect_sound_enabled: 1 });
    expect((await screen.findByLabelText('Confirm (seconds)')).value).toBe('4');
    expect(screen.getByLabelText('Cooldown (seconds)').value).toBe('120');
    expect(screen.getByLabelText(/Sensitivity/).value).toBe('50');
  });

  test('an unrecognised detection source reads as Nightlight rather than passing through', async () => {
    // The screen has no button for an unknown source, so without the coercion the segmented control
    // would show nothing selected and the next write would send the garbage value straight back.
    mount('motion', { ...CAM, detect_source: 'carrier-pigeon' });
    const nightlight = await screen.findByRole('button', { name: 'Nightlight' });
    expect(nightlight.className).toContain('segmented__btn--active');
  });

  test('a camera still loading shows Loading…, not an empty form', async () => {
    // `cameras` is empty until the context resolves. An empty form here would be initialised from
    // nothing and could write those blanks over a configured camera on the first touch.
    renderAsAdmin(
      <Routes><Route path="/cameras/:id/:kind" element={<DetectionSettings />} /></Routes>,
      { cameras: [], route: '/cameras/cam-1/motion' }
    );
    expect(screen.getByText('Loading…')).toBeTruthy();
    expect(screen.queryByLabelText(/Sensitivity/)).toBeNull();
  });
});

describe('the alert schedule', () => {
  test('a stored window is shown as times', async () => {
    mount('schedule');
    expect((await screen.findByLabelText('From')).value).toBe('19:00');
    expect(screen.getByLabelText('To').value).toBe('06:40');
  });

  test('★ a camera that never had a window offers a night, not 00:00–00:00', async () => {
    // start === end is how "never set" is stored, and it is also a zero-length window. Showing it
    // literally would offer someone a schedule that alerts for no minutes of the day, which reads as
    // broken; the screen suggests 20:00–07:00 instead. ⚠️ This is a SUGGESTION, not a saved value —
    // see the test below.
    mount('schedule', { ...CAM, detect_start: 0, detect_end: 0 });
    expect((await screen.findByLabelText('From')).value).toBe('20:00');
    expect(screen.getByLabelText('To').value).toBe('07:00');
  });

  test('⚠️ but the suggested window IS written on the next change, whatever was changed', async () => {
    // Documenting a real consequence of the whole-payload design rather than asserting it is correct:
    // because every write carries all three slices, touching the switch on a never-scheduled camera
    // also persists the suggested 20:00–07:00. Harmless today — the window is ignored while the
    // schedule is off — but it means the suggestion silently becomes the stored value, and anyone
    // changing the default needs to know that is what happens.
    mount('schedule', { ...CAM, detect_start: 0, detect_end: 0, detect_schedule_enabled: 0 });
    await screen.findByText('Alerting 24/7.');
    fireEvent.click(screen.getByRole('switch'));

    const body = await sentBody();
    expect(body.schedule_enabled).toBe(true);
    expect(body.start).toBe(1200);
    expect(body.end).toBe(420);
  });

  test('with the schedule off there are no times to set', async () => {
    mount('schedule', { ...CAM, detect_schedule_enabled: 0 });
    expect(await screen.findByText('Alerting 24/7.')).toBeTruthy();
    expect(screen.queryByLabelText('From')).toBeNull();
  });
});

describe('the motion screen', () => {
  test('turned off, it offers nothing to configure', async () => {
    mount('motion', { ...CAM, detect_motion_enabled: 0 });
    expect(await screen.findByText(/Turn on to configure/)).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Detection source' })).toBeNull();
  });

  test('the source picker offers Nightlight and MQTT', async () => {
    mount('motion');
    expect(await screen.findByRole('button', { name: 'Nightlight' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Camera via MQTT' })).toBeTruthy();
  });

  test('★ ONVIF is offered only to a camera that advertised it', async () => {
    mount('motion', { ...CAM, onvif_motion_capable: 0 });
    await screen.findByRole('button', { name: 'Nightlight' });
    expect(screen.queryByRole('button', { name: 'Camera via ONVIF' }), 'a subscription would just sit idle').toBeNull();
  });

  test('★★ …but a camera ALREADY on ONVIF keeps the button, so it can be switched away', async () => {
    // The escape hatch, and the reason the condition is an OR rather than a capability check. A camera
    // that loses the capability — a firmware downgrade, or a re-probe that came back thinner — would
    // otherwise be stranded on a source it can no longer serve, with no control on screen to move it.
    mount('motion', { ...CAM, onvif_motion_capable: 0, detect_source: 'onvif' });
    expect(await screen.findByRole('button', { name: 'Camera via ONVIF' })).toBeTruthy();
  });

  test('MQTT shows the topic fields and hides the sensitivity slider', async () => {
    // The camera decides what counts as motion on this source, so a Nightlight sensitivity would be
    // an inert control — and an inert control that looks live is how someone spends an evening
    // "tuning" a setting that does nothing.
    mount('motion', { ...CAM, detect_source: 'mqtt' });
    expect(await screen.findByLabelText('Motion MQTT topic')).toBeTruthy();
    expect(screen.queryByLabelText(/^Sensitivity/)).toBeNull();
  });

  test('frame-diff shows the sensitivity slider and a confirm delay', async () => {
    mount('motion');
    expect(await screen.findByLabelText(/Sensitivity/)).toBeTruthy();
    expect(screen.getByLabelText('Confirm (seconds)')).toBeTruthy();
  });

  test('★ ONVIF hides the confirm delay, because the camera has already confirmed', async () => {
    mount('motion', { ...CAM, onvif_motion_capable: 1, detect_source: 'onvif' });
    await screen.findByRole('button', { name: 'Camera via ONVIF' });
    expect(screen.queryByLabelText('Confirm (seconds)')).toBeNull();
    expect(screen.getByLabelText('Cooldown (seconds)'), 'the gap between alerts is still ours to set').toBeTruthy();
  });

  test('switching source writes it', async () => {
    mount('motion');
    fireEvent.click(await screen.findByRole('button', { name: 'Camera via MQTT' }));
    expect((await sentBody()).source).toBe('mqtt');
  });
});

describe('the clip opt-in', () => {
  test('appears on BOTH detection screens, because a clip follows either trigger', async () => {
    for (const kind of ['motion', 'sound']) {
      const { unmount } = mount(kind);
      expect(await screen.findByText('Save a clip when triggered')).toBeTruthy();
      unmount();
    }
  });

  test('and writes the per-camera flag', async () => {
    mount('sound', { ...CAM, detect_record_clips: 0 });
    const toggle = (await screen.findAllByRole('switch')).at(-1);
    fireEvent.click(toggle);
    expect((await sentBody()).record_clips).toBe(true);
  });
});

// -------------------------------------------------------------------------------------------
// The snapshot password the server will not send back — issue #271.
//
// The server strips the Basic-auth password from snapshot_url before it leaves, so this screen can
// only ever be told WHETHER one is set. That makes the blank-means-keep contract load-bearing: if the
// screen sent an empty snapshot_password on an ordinary save, the route would read it as "clear it"
// and every save of this page would quietly break alert images.
describe('the snapshot password field (#271)', () => {
  const WITH_PW = { ...CAM, snapshot_url: 'http://admin@cam.local/snap.jpg', snapshot_has_password: true };

  test('an ordinary save sends NO snapshot_password at all', async () => {
    mount('motion', WITH_PW);
    fireEvent.change(await screen.findByLabelText(/Sensitivity/), { target: { value: '30' } });
    const body = await sentBody();
    expect('snapshot_password' in body).toBe(false);
    expect(body.snapshot_url).toBe('http://admin@cam.local/snap.jpg');
  });

  test('typing one sends it', async () => {
    mount('motion', WITH_PW);
    fireEvent.change(await screen.findByLabelText(/Alert image password/), { target: { value: 'typed-pw' } });
    const body = await sentBody();
    expect(body.snapshot_password).toBe('typed-pw');
  });

  test('the field never shows the stored password — only that there is one', async () => {
    mount('motion', WITH_PW);
    const input = await screen.findByLabelText(/Alert image password/);
    expect(input.value).toBe('');
    expect(input.type).toBe('password');
    expect(await screen.findByText(/never sent back to this page/i)).toBeTruthy();
  });

  test('a camera with no stored password says so instead', async () => {
    mount('motion', { ...CAM, snapshot_has_password: false });
    expect(await screen.findByLabelText(/Alert image password \(optional\)/)).toBeTruthy();
  });
});

// -------------------------------------------------------------------------------------------
// The "(saved)" label must reflect the SERVER, not a snapshot taken at mount — issue #271.
//
// Found by adversarial review of that PR. `fromCam` runs exactly once per mount (the `initedRef`
// guard), which is right for every editable field: the client's own value already matches what will
// come back. `snapshot_has_password` is the one field here that is a server-computed FACT the client
// cannot otherwise know, so freezing it at mount meant an admin who typed a password and saved was
// still told "(optional)" until they navigated away and back — the CHANGELOG claims the label says
// "(saved)", and mid-session it did not.
describe('the snapshot password label follows the server (#271)', () => {
  test('★ it becomes "(saved)" after the save that sets one, without a remount', async () => {
    const { rerenderWith } = mount('motion', { ...CAM, snapshot_has_password: false });
    expect(await screen.findByLabelText(/Alert image password \(optional\)/)).toBeTruthy();

    // What CamerasContext.refresh() really does after a successful PUT: publishes a fresh cameras
    // array. The harness's own `refresh` is a no-op spy, which is exactly why the shipped tests could
    // not catch this.
    rerenderWith({ cameras: [{ ...CAM, snapshot_has_password: true }] });

    expect(await screen.findByLabelText(/Alert image password \(saved\)/)).toBeTruthy();
  });

  test('...and back to "(optional)" if the password is cleared server-side', async () => {
    // The mirror. A one-way sync would pass the case above and still be wrong.
    const { rerenderWith } = mount('motion', { ...CAM, snapshot_has_password: true });
    expect(await screen.findByLabelText(/Alert image password \(saved\)/)).toBeTruthy();
    rerenderWith({ cameras: [{ ...CAM, snapshot_has_password: false }] });
    expect(await screen.findByLabelText(/Alert image password \(optional\)/)).toBeTruthy();
  });

  test('a server refresh does NOT clobber what the user is still typing', async () => {
    // The reason this is derived from `cam` rather than synced INTO form state: a refresh landing
    // mid-edit must not wipe the URL box. This is the regression a naive "re-run fromCam on every
    // cam change" fix would introduce.
    const { rerenderWith } = mount('motion', CAM);
    const url = await screen.findByLabelText(/Alert image URL/);
    fireEvent.change(url, { target: { value: 'http://typing-in-progress/snap.jpg' } });
    rerenderWith({ cameras: [{ ...CAM, snapshot_has_password: true }] });
    expect((await screen.findByLabelText(/Alert image URL/)).value).toBe('http://typing-in-progress/snap.jpg');
  });
});
