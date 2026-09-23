// The Motion / Sound / Alert-schedule screens — one component serving three routes.
//
// ★ WHY THIS SCREEN IS WORTH REAL TESTS. It has no Save button. Every control applies itself, and
// each write restarts the camera's detector, so several things that can go wrong are all invisible:
//
//  1. **It used to write the WHOLE detection state on every change, not a patch** (fixed by #444).
//     The screen holds all three slices (motion, sound, schedule) in one state object `d`, so a
//     field `fromCam` fails to read used to go out WRONG rather than missing whenever ANY field
//     changed — adjusting the sound sensitivity could silently rewrite the motion zone or the alert
//     window, with nothing on screen to show it. Since #444 every write is a PATCH — only the fields
//     the user actually touched — routed through the per-camera save queue in
//     `src/lib/detectionSaves.js` (its own unit tests live in detectionSaves.test.js). `PUT
//     /:id/detection` keeps any field it isn't sent (backend/test/detection-route.test.js, #443),
//     which is what makes sending only the changed keys safe.
//  2. **Writes are debounced at 700 ms and coalesced.** Dragging a slider must produce ONE restart,
//     not forty. A lost debounce would not fail anything; it would just thrash the detector.
//  3. **Navigating away, a failed save, and two overlapping writes** (issue #444's three defects) —
//     covered by the T1/T1b/T2/T4/T5/T7 tests below. T6, in the same file for convenience, covers the
//     matching failure banner on CameraSettings.jsx, the screen "Back" from here lands on.
//
// Role gating is not tested here: the route is <AdminProtected> (routeGuards.test.jsx).
import { StrictMode } from 'react';
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import { Routes, Route } from 'react-router-dom';
import { renderAsAdmin } from './helpers/render.jsx';
import DetectionSettings from '../src/pages/DetectionSettings.jsx';
import CameraSettings from '../src/pages/CameraSettings.jsx';
import { togglePatch } from '../src/components/CameraTile.jsx';
import { api } from '../src/lib/api.js';
import { queuePatch, __resetForTests } from '../src/lib/detectionSaves.js';

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

// Wrapped in StrictMode (issue #444): React double-invokes a functional state updater in
// development/test mode to surface an impure one. `apply`'s `setD` updater must have no side effects
// — the actual queueing happens once, outside it — and this is what would catch a regression back to
// the old shape (a debounce/send started from inside the updater) by sending twice for one change.
function mount(kind, cam = CAM) {
  return renderAsAdmin(
    <StrictMode>
      <Routes>
        <Route path="/cameras/:id/:kind" element={<DetectionSettings />} />
      </Routes>
    </StrictMode>,
    { cameras: [cam], route: `/cameras/${cam.id}/${kind}` }
  );
}

function mountCameraSettings(cams) {
  return renderAsAdmin(
    <StrictMode>
      <Routes>
        <Route path="/cameras/:id" element={<CameraSettings />} />
      </Routes>
    </StrictMode>,
    { cameras: cams, route: `/cameras/${cams[0].id}` }
  );
}

// The single write the screen produced, once the debounce has fired.
async function sentBody() {
  await waitFor(() => expect(putSpy).toHaveBeenCalled(), SETTLE);
  return putSpy.mock.calls[putSpy.mock.calls.length - 1][1];
}

beforeEach(() => {
  putSpy = vi.spyOn(api, 'put').mockResolvedValue({});
  // The save queue is module-level state (issue #444), so it leaks across tests — and across THIS
  // file and cameraTileHelpers.test.jsx/detectionSaves.test.js, all of which import the same module
  // instance — unless reset. Also invalidates any promise still unsettled from a previous test.
  __resetForTests();
});
afterEach(() => vi.restoreAllMocks());

describe('★★ every write carries ONLY the changed slice, since #444', () => {
  test('changing the SOUND sensitivity does not resend the motion slice at all', async () => {
    // Until #444 the sound screen sent the WHOLE detection state, so this test pinned that the motion
    // fields it resent were at least unchanged. Since #444 the screen sends only what changed — a
    // PATCH — so the motion slice (the bed zone above all: it's painted per installation, nothing
    // validates it, and sleep tracking depends on it entirely) simply isn't part of the request; the
    // server (PUT /:id/detection, #443) keeps it because it was never sent, not because it round-tripped.
    const { user } = mount('sound');
    const slider = await screen.findByLabelText(/Sensitivity/);
    fireEvent.change(slider, { target: { value: '30' } });

    const body = await sentBody();
    expect(body).toEqual({ sound_sensitivity: 30 });
    for (const key of ['zone', 'sensitivity', 'source', 'motion_enabled', 'start', 'end', 'motion_mqtt_topic', 'snapshot_url', 'record_clips']) {
      expect(key in body, `${key} must not be sent at all by an unrelated sound edit`).toBe(false);
    }
    void user;
  });

  test('changing the SCHEDULE does not resend the sound or motion slice', async () => {
    const { user } = mount('schedule');
    const from = await screen.findByLabelText('From');
    fireEvent.change(from, { target: { value: '21:30' } });

    const body = await sentBody();
    expect(body, '21:30 in minutes since midnight, and nothing else').toEqual({ start: 1290 });
    void user;
  });

  test('the payload carries exactly the keys this screen actually changed — one field, one key', async () => {
    // A field appearing here that the user did not touch would mean this screen (or the queue's
    // shared toPartialPayload) had started resending untouched state again — the #444 regression.
    mount('sound');
    fireEvent.change(await screen.findByLabelText(/Sensitivity/), { target: { value: '30' } });
    const body = await sentBody();
    expect(Object.keys(body)).toEqual(['sound_sensitivity']);
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
    // start === end is how "all-day" is stored (inActiveWindow in detectSchedule.js treats it as
    // always active), and it is also a zero-length window. Showing it literally would offer someone a
    // schedule that alerts for no minutes of the day, which reads as broken; the screen suggests
    // 20:00–07:00 instead. This is a render-time SUGGESTION only — the next tests are why it must
    // never become the saved value on its own.
    mount('schedule', { ...CAM, detect_start: 0, detect_end: 0 });
    expect((await screen.findByLabelText('From')).value).toBe('20:00');
    expect(screen.getByLabelText('To').value).toBe('07:00');
  });

  test('★★ enabling the schedule on a never-set camera commits a REAL window, not an inert one (#443 review finding)', async () => {
    // Turning the switch on is the user's own deliberate schedule edit, not an unrelated one — so it
    // must commit the suggested window for real, matching the camera tile's quick toggle
    // (cameraTileHelpers.test.jsx). The alternative — leaving start===end while schedule_enabled
    // becomes true — would make this switch inert: inActiveWindow() (backend/src/lib/
    // detectSchedule.js, covered by detectSchedule.test.js) treats an equal pair as always active
    // REGARDLESS of schedule_enabled, so the screen would show "Only alert during set hours" with a
    // specific 20:00–07:00 window while alerts kept firing around the clock. Found by adversarial
    // review of this fix's first draft, which made exactly that mistake.
    mount('schedule', { ...CAM, detect_start: 0, detect_end: 0, detect_schedule_enabled: 0 });
    await screen.findByText('Alerting 24/7.');
    fireEvent.click(screen.getByRole('switch'));

    const body = await sentBody();
    expect(body.schedule_enabled).toBe(true);
    expect(body.start, 'a real 20:00, not an inert equal pair').toBe(1200);
    expect(body.end, 'a real 07:00').toBe(420);
  });

  test('re-enabling a schedule that already has a real window does not re-seed it — and does not resend it either', async () => {
    // The commit-a-real-window behavior above only applies while there is genuinely no window yet
    // (start === end). A camera that already has a real, if currently-disabled, window must keep it
    // exactly as stored when the switch is flipped back on — and since #444, "keep it" means the
    // patch doesn't mention start/end at all, not that it resends the same values.
    mount('schedule', { ...CAM, detect_schedule_enabled: 0 }); // CAM's default window is 19:00–06:40
    await screen.findByText('Alerting 24/7.');
    fireEvent.click(screen.getByRole('switch'));

    const body = await sentBody();
    expect(body).toEqual({ schedule_enabled: true });
  });

  test('with the schedule off there are no times to set', async () => {
    mount('schedule', { ...CAM, detect_schedule_enabled: 0 });
    expect(await screen.findByText('Alerting 24/7.')).toBeTruthy();
    expect(screen.queryByLabelText('From')).toBeNull();
  });

  test('★★ an unrelated SOUND edit does not narrow an already-enabled all-day schedule (#443)', async () => {
    // The issue's literal repro: a schedule already saved as enabled with equal start/end — all-day,
    // per inActiveWindow's own "start === end" rule — must survive a save triggered from a completely
    // different screen. Since #444 that's because the patch a sound edit sends doesn't mention the
    // schedule fields at all — there's nothing left FOR it to narrow.
    mount('sound', { ...CAM, detect_schedule_enabled: 1, detect_start: 0, detect_end: 0 });
    fireEvent.change(await screen.findByLabelText(/Sensitivity/), { target: { value: '30' } });

    const body = await sentBody();
    expect(body).toEqual({ sound_sensitivity: 30 });
    expect('schedule_enabled' in body, 'the schedule is not part of this payload at all').toBe(false);
  });

  test('★★ an unrelated MOTION edit does not narrow an already-enabled all-day schedule (#443)', async () => {
    // Same repro, via the other screen — a fix scoped to only one of the two screens would pass the
    // test above and still corrupt the schedule from here.
    mount('motion', { ...CAM, detect_schedule_enabled: 1, detect_start: 0, detect_end: 0 });
    fireEvent.change(await screen.findByLabelText('Cooldown (seconds)'), { target: { value: '90' } });

    const body = await sentBody();
    expect(body).toEqual({ cooldown_s: 90 });
    expect('schedule_enabled' in body, 'the schedule is not part of this payload at all').toBe(false);
  });

  test('editing one time field while the suggestion is showing commits BOTH as displayed', async () => {
    // If only the touched field were committed, the untouched "From" would silently fall back to the
    // real pre-suggestion stored time (00:00) instead of the 20:00 on screen — a different, quieter
    // version of the same "what you see is not what gets saved" bug.
    mount('schedule', { ...CAM, detect_start: 0, detect_end: 0 });
    await screen.findByLabelText('From');
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '08:00' } });

    const body = await sentBody();
    expect(body.start, '20:00, matching what "From" displayed').toBe(1200);
    expect(body.end).toBe(480);
  });

  test('★★ an edit that happens to land on equal values is not silently reverted (#443 review finding)', async () => {
    // Typing 07:00 into "From" while "To" still shows the suggested 07:00 produces an equal pair —
    // which is ALSO how all-day is stored. A version of the fix that re-derives "still showing the
    // suggestion" from `d.start === d.end` on every render (instead of latching it off after the
    // first real edit) misreads this as "still the suggestion" and silently swaps the display back to
    // 20:00–07:00, discarding what was just typed and overwriting it again on the next save.
    mount('schedule', { ...CAM, detect_start: 0, detect_end: 0 });
    const from = await screen.findByLabelText('From');
    fireEvent.change(from, { target: { value: '07:00' } });

    let body = await sentBody();
    expect(body.start, 'From, as typed').toBe(420);
    expect(body.end, 'To, as it was displayed (07:00)').toBe(420);
    expect(from.value, 'must keep showing what was typed, not revert to the 20:00 suggestion').toBe('07:00');

    // A second, later edit to "To" must change only "To" — not silently restore "From" to 20:00.
    // Since #444 that "must not restore" shows up in the FORM (`from.value` below); the payload
    // itself now carries only the field actually touched this time, "To" — it no longer resends
    // "From" at all, so there's nothing there left to have reverted.
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '09:00' } });
    await waitFor(() => expect(putSpy.mock.calls.length).toBeGreaterThan(1), SETTLE);
    body = putSpy.mock.calls[putSpy.mock.calls.length - 1][1];
    expect(body).toEqual({ end: 540 });
    expect(from.value, '"From" must still read 07:00, not have reverted to 20:00').toBe('07:00');
  });

  test('★★ the same guard applies editing "To" first, not just "From" (#443 review finding)', async () => {
    // The two fields are edited by separate handlers (editStart/editEnd), each with its own copy of
    // "stop showing the suggestion." The "From"-first case above does not exercise editEnd's copy at
    // all — a version of the fix that reset the latch in editStart but not editEnd passed every
    // existing test in this file. Mirrors the assertions above onto the other input.
    mount('schedule', { ...CAM, detect_start: 0, detect_end: 0 });
    const to = await screen.findByLabelText('To');
    fireEvent.change(to, { target: { value: '20:00' } });

    let body = await sentBody();
    expect(body.start, 'From, as it was displayed (20:00)').toBe(1200);
    expect(body.end, 'To, as typed').toBe(1200);
    expect(to.value, 'must keep showing what was typed, not revert to the 07:00 suggestion').toBe('20:00');

    // Since #444 the payload for this second edit carries only "From" — nothing left to have
    // reverted "To"; the form value (`to.value` below) is what pins that it stayed 20:00.
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '18:00' } });
    await waitFor(() => expect(putSpy.mock.calls.length).toBeGreaterThan(1), SETTLE);
    body = putSpy.mock.calls[putSpy.mock.calls.length - 1][1];
    expect(body).toEqual({ start: 1080 });
    expect(to.value, '"To" must still read 20:00, not have reverted to 07:00').toBe('20:00');
  });

  test('once a real window exists, editing one field leaves the other alone', async () => {
    // The paired-commit above only applies while start === end. A camera with a genuine window
    // (CAM's default 19:00–06:40) must go back to editing each field independently — and since #444
    // that means the untouched "From" isn't resent at all, not merely resent unchanged.
    mount('schedule');
    fireEvent.change(await screen.findByLabelText('To'), { target: { value: '08:00' } });

    const body = await sentBody();
    expect(body).toEqual({ end: 480 });
    expect('start' in body, 'From (19:00) is not sent, not merely unchanged').toBe(false);
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
    // Since #444 an ordinary save of an unrelated field (sensitivity here) is a one-key patch, so
    // snapshot_url isn't sent either — the load-bearing part of this test, that the stored URL
    // survives, now holds because it was never sent, not because it round-tripped unchanged.
    mount('motion', WITH_PW);
    fireEvent.change(await screen.findByLabelText(/Sensitivity/), { target: { value: '30' } });
    const body = await sentBody();
    expect(body).toEqual({ sensitivity: 30 });
    expect('snapshot_password' in body).toBe(false);
    expect('snapshot_url' in body).toBe(false);
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

// -------------------------------------------------------------------------------------------
// Issue #444 — a per-camera save queue that outlives this component. T1/T1b/T2/T4/T5/T7 exercise it
// through this screen; T6 (same file, for convenience — it's the failure state the "Back" button from
// here lands on) exercises the matching banner on CameraSettings.jsx.
describe('★★ #444: navigating away must not cancel a pending save', () => {
  test('T1: unmount well inside the 700ms debounce still saves — flush, not cancel (fails on the pre-#444 cancel-on-unmount code)', async () => {
    const { unmount } = mount('motion'); // CAM: detect_motion_enabled = 1
    const [motionToggle] = await screen.findAllByRole('switch');
    fireEvent.click(motionToggle);
    unmount(); // long before the 700ms debounce would fire on its own

    // ⚠️ Asserted SYNCHRONOUSLY, straight after unmount, with no waitFor. The debounce timer lives in the
    // module-level queue (detectionSaves.js), so even an unmount that did NOTHING would still send the
    // change ~700ms later — a waitFor here passed against exactly that mutant (#444 M1 survived the first
    // mutation run). What flush-on-unmount adds is sending AT THE MOMENT the user leaves (flush → doSend
    // calls `send` synchronously), which is what survives the app being closed right after tapping Back.
    // Only a no-wait assertion can tell those apart.
    expect(putSpy, 'leaving the screen did not send the pending change immediately').toHaveBeenCalledTimes(1);
    await waitFor(() => expect(putSpy).toHaveBeenCalled(), SETTLE);
    expect(putSpy).toHaveBeenCalledTimes(1);
    expect(putSpy.mock.calls[0][0]).toBe('/cameras/cam-1/detection');
    expect(putSpy.mock.calls[0][1]).toEqual({ motion_enabled: false });
  });

  test('T1b: unmount AFTER the debounce has already sent still produces exactly one PUT (Codex F3)', async () => {
    const { unmount } = mount('motion');
    const [motionToggle] = await screen.findAllByRole('switch');
    fireEvent.click(motionToggle);
    await waitFor(() => expect(putSpy).toHaveBeenCalledTimes(1), SETTLE);

    unmount(); // nothing left unsent — this must be a no-op, not a second PUT
    await new Promise((r) => setTimeout(r, 100));
    expect(putSpy).toHaveBeenCalledTimes(1);
  });
});

describe('★★ #444: a failed save is visible and recoverable', () => {
  test('T2: a rejected PUT shows "Not saved" with a Retry button; the value sticks; Retry saves it (fails on the pre-#444 code, which just goes quiet)', async () => {
    putSpy.mockRejectedValueOnce(new Error('camera is offline'));
    mount('sound');
    const slider = await screen.findByLabelText(/Sensitivity/);
    fireEvent.change(slider, { target: { value: '30' } });

    await waitFor(() => expect(putSpy).toHaveBeenCalledTimes(1), SETTLE);
    expect(await screen.findByText(/Not saved/, {}, SETTLE)).toBeTruthy();
    const retryBtn = await screen.findByRole('button', { name: 'Retry' });
    expect(slider.value, "the user's value sticks — it is their intent, and Retry sends exactly it").toBe('30');

    fireEvent.click(retryBtn);
    await waitFor(() => expect(putSpy).toHaveBeenCalledTimes(2), SETTLE);
    expect(putSpy.mock.calls[1][1], 'Retry resends the same (still one-key) patch').toEqual({ sound_sensitivity: 30 });
    expect(await screen.findByText('Saved ✓', {}, SETTLE)).toBeTruthy();
  });
});

describe('★★ #444: overlapping writes are serialized, not raced', () => {
  test('T4: a change made while the first save is still in flight sends no second PUT until it resolves, then sends the latest (fails on the pre-#444 code, which has no in-flight guard)', async () => {
    let resolveFirst;
    putSpy.mockImplementationOnce(() => new Promise((r) => { resolveFirst = r; }));
    mount('sound');
    const slider = await screen.findByLabelText(/Sensitivity/);
    fireEvent.change(slider, { target: { value: '20' } });
    await waitFor(() => expect(putSpy).toHaveBeenCalledTimes(1), SETTLE); // first PUT sent, hanging

    fireEvent.change(slider, { target: { value: '35' } }); // a further change while it's still pending
    await new Promise((r) => setTimeout(r, 900)); // well past the 700ms debounce
    expect(putSpy, 'no second PUT while the first is still pending').toHaveBeenCalledTimes(1);

    resolveFirst({});
    await waitFor(() => expect(putSpy).toHaveBeenCalledTimes(2), SETTLE);
    expect(putSpy.mock.calls[1][1], 'the second PUT carries the latest value').toEqual({ sound_sensitivity: 35 });
  });

  test('T7: a page edit in flight and a tile toggle on the same camera are serialized, each payload carrying only its own key', async () => {
    let resolveFirst;
    putSpy.mockImplementationOnce(() => new Promise((r) => { resolveFirst = r; }));
    mount('sound');
    fireEvent.change(await screen.findByLabelText(/Sensitivity/), { target: { value: '15' } });
    await waitFor(() => expect(putSpy).toHaveBeenCalledTimes(1), SETTLE);
    expect(putSpy.mock.calls[0][1]).toEqual({ sound_sensitivity: 15 });

    // What CameraTile.jsx's toggleDetection does: build the patch, then queue it through the SAME
    // module-level queue — the tile itself can't be rendered in jsdom (cameraTileHelpers.test.jsx).
    const tilePatch = togglePatch(CAM, 'motion');
    queuePatch(CAM.id, tilePatch, {
      kind: null,
      immediate: true,
      send: (payload) => api.put(`/cameras/${CAM.id}/detection`, payload),
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(putSpy, "the tile's write waits for the page's in-flight one").toHaveBeenCalledTimes(1);

    resolveFirst({});
    await waitFor(() => expect(putSpy).toHaveBeenCalledTimes(2), SETTLE);
    expect(putSpy.mock.calls[1][1], "the tile's payload carries only its own key").toEqual({ motion_enabled: false });
  });
});

describe('★★ #444: revisiting a screen shows unsaved reality, not the server\'s', () => {
  test('T5: a failed save, unmount, remount → the form shows the pending value and the failed state', async () => {
    putSpy.mockRejectedValueOnce(new Error('offline'));
    const { unmount } = mount('sound');
    fireEvent.change(await screen.findByLabelText(/Sensitivity/), { target: { value: '77' } });
    await screen.findByText(/Not saved/, {}, SETTLE);
    unmount();

    mount('sound'); // a fresh mount, same camera — NOT the same component instance
    expect((await screen.findByLabelText(/Sensitivity/)).value).toBe('77');
    expect(await screen.findByText(/Not saved/, {}, SETTLE)).toBeTruthy();
  });
});

describe('★★ #444: the CameraSettings banner (where "Back" from a detection screen lands)', () => {
  test('T6: a failed detection save shows a banner with Retry that clears on success; Retry only calls the detection PUT', async () => {
    putSpy.mockRejectedValueOnce(new Error('offline'));
    const { unmount } = mount('sound');
    fireEvent.change(await screen.findByLabelText(/Sensitivity/), { target: { value: '10' } });
    await screen.findByText(/Not saved/, {}, SETTLE);
    unmount();

    mountCameraSettings([CAM]);
    expect(await screen.findByText(/wasn't saved/i, {}, SETTLE)).toBeTruthy();
    const retryBtn = screen.getByRole('button', { name: 'Retry' });

    const callsBefore = putSpy.mock.calls.length;
    fireEvent.click(retryBtn); // a non-submit control — must not touch the camera-settings form's own PUT
    await waitFor(() => expect(putSpy.mock.calls.length).toBeGreaterThan(callsBefore), SETTLE);
    const lastCall = putSpy.mock.calls[putSpy.mock.calls.length - 1];
    expect(lastCall[0], 'only the detection PUT, never PUT /cameras/:id').toBe('/cameras/cam-1/detection');
    expect(lastCall[1]).toEqual({ sound_sensitivity: 10 });
    await waitFor(() => expect(screen.queryByText(/wasn't saved/i)).toBeNull(), SETTLE);
  });

  test('T6b: no banner for a different camera than the one that failed', async () => {
    putSpy.mockRejectedValueOnce(new Error('offline'));
    const { unmount } = mount('sound'); // fails on cam-1 (CAM)
    fireEvent.change(await screen.findByLabelText(/Sensitivity/), { target: { value: '10' } });
    await screen.findByText(/Not saved/, {}, SETTLE);
    unmount();

    const otherCam = { ...CAM, id: 'cam-2', name: 'Other room' };
    mountCameraSettings([otherCam]);
    await screen.findByText('Other room');
    expect(screen.queryByText(/wasn't saved/i)).toBeNull();
  });

  test('T6c: no banner at all when nothing has failed', async () => {
    mountCameraSettings([{ ...CAM, id: 'cam-3', name: 'Clean room' }]);
    await screen.findByText('Clean room');
    expect(screen.queryByText(/wasn't saved/i)).toBeNull();
  });
});
