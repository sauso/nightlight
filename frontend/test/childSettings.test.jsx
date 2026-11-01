// Add / edit a child.
//
// ★ WHY. Two things here are load-bearing well beyond this screen:
//
//  1. **The sleep window and the tracking switch live here, and nowhere else.** Every night's analysis
//     is scoped to that window; turning tracking off stops a child's sleep being recorded at all. A
//     screen that quietly changed either would show nothing wrong — the damage appears days later as
//     missing or mis-scoped nights.
//  2. **Setting a photo writes IMMEDIATELY, with a partial payload** (just `photo`, #384) that carries
//     neither of those fields, nor the name, birthday or colour the person may have edited but not saved. That is safe only because the route keeps what it is not sent
//     (backend/test/children-route.test.js pins the other half). What is tested here is that the
//     partial payload really is partial — and that the screen does not reach for stale state to pad
//     it out, which is how a "helpful" fix would reintroduce exactly the bug.
//
// ⚠️ The photo PICKER is not exercised: it goes through `imageResize.js` (canvas), which jsdom stubs.
// `persistPhoto` is reached through Remove, which takes the same path with a null photo.
//
// Both roles reach this screen, but since #542 (owner decision 2026-10-10) a caregiver may change only a
// child's name, birthday, colour and photo: tracking and the window are shown disabled and left out of
// their save, and Add / Remove child are admin-only. Both roles are exercised wherever the screen differs.
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, within, fireEvent } from '@testing-library/react';
import { Routes, Route, useLocation } from 'react-router-dom';
import { renderAs, renderAsAdmin, ADMIN, CAREGIVER } from './helpers/render.jsx';
import ChildSettings from '../src/pages/ChildSettings.jsx';
import { api } from '../src/lib/api.js';

const KID = {
  id: 'kid-1',
  name: 'Child B',
  birthday: '2023-04-01',
  color: '#7FBFA3',
  photo: 'data:image/png;base64,AAA',
  track_sleep: 1,
  sleep_window_start: '19:30',
  sleep_window_end: '06:45',
};

const Probe = () => <div>at {useLocation().pathname}</div>;

let postSpy;
let putSpy;
let delSpy;

function mockApi() {
  postSpy = vi.spyOn(api, 'post').mockResolvedValue({ id: 'kid-new' });
  putSpy = vi.spyOn(api, 'put').mockResolvedValue({});
  delSpy = vi.spyOn(api, 'del').mockResolvedValue({});
}

function mount({ kid = KID, id = KID.id, who = ADMIN, cameras = [] } = {}) {
  return renderAs(
    who,
    <>
      <Probe />
      <Routes>
        <Route path="/children/new" element={<ChildSettings />} />
        <Route path="/children/:id" element={<ChildSettings />} />
        <Route path="*" element={<div>elsewhere</div>} />
      </Routes>
    </>,
    { kids: kid ? [kid] : [], cameras, route: `/children/${id}` }
  );
}

beforeEach(() => mockApi());
afterEach(() => vi.restoreAllMocks());

describe('loading a child', () => {
  test('every stored field is shown', async () => {
    mount();
    expect((await screen.findByLabelText('Name')).value).toBe('Child B');
    expect(screen.getByLabelText(/Birthday/).value).toBe('2023-04-01');
    expect(screen.getByRole('switch', { name: /Track sleep/ }).checked).toBe(true);
    expect(screen.getByLabelText('Bedtime').value).toBe('19:30');
    expect(screen.getByLabelText('Wake time').value).toBe('06:45');
  });

  test('★ a child with no stored window gets the documented defaults', async () => {
    // These are the values the docs promise and the ones every new child starts with, so they have to
    // survive a child row that predates the fields.
    //
    // ⚠️ ASSERTED ON THE SAVED PAYLOAD as well as the boxes. Dropping the `|| '19:00'` fallback sets
    // the value to `undefined`, which makes React treat the input as UNCONTROLLED — the initial
    // state's 19:00 stays painted on screen while the state behind it is empty. Checking only the
    // displayed value passed against exactly that mutation.
    const { user } = mount({ kid: { id: 'kid-1', name: 'Child A', track_sleep: 1 } });
    expect((await screen.findByLabelText('Bedtime')).value).toBe('19:00');
    expect(screen.getByLabelText('Wake time').value).toBe('07:00');

    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(putSpy).toHaveBeenCalled());
    const body = putSpy.mock.calls[0][1];
    expect(body.sleep_window_start, 'and the default is what actually gets saved').toBe('19:00');
    expect(body.sleep_window_end).toBe('07:00');
  });

  test('★★ a child whose track_sleep is NULL defaults to ON, not off', async () => {
    // `track_sleep == null ? true : !!track_sleep` — the loose == is deliberate and covers both null
    // and undefined, which is what a row created before the column existed looks like. Defaulting to
    // OFF would silently stop tracking a child who had been tracked for months, and the screen would
    // look like it had always been that way.
    mount({ kid: { id: 'kid-1', name: 'Child A', track_sleep: null } });
    await screen.findByLabelText('Name');
    expect(screen.getByRole('switch', { name: /Track sleep/ }).checked).toBe(true);
  });

  test('a child still loading shows Loading…, not a blank form', async () => {
    mount({ kid: null });
    expect(screen.getByText('Loading…')).toBeTruthy();
    expect(screen.queryByLabelText('Name')).toBeNull();
  });

  test('the sleep times are hidden when tracking is off', async () => {
    // Nothing to schedule when nothing is being tracked; leaving them visible would suggest they
    // still did something.
    mount({ kid: { ...KID, track_sleep: 0 } });
    await screen.findByLabelText('Name');
    expect(screen.queryByLabelText('Bedtime')).toBeNull();
  });

  test('turning tracking on reveals them, without saving anything yet', async () => {
    // This switch is a form field, unlike the immediate-apply ones elsewhere — nothing is written
    // until Save.
    const { user } = mount({ kid: { ...KID, track_sleep: 0 } });
    await user.click(await screen.findByRole('switch'));
    expect(await screen.findByLabelText('Bedtime')).toBeTruthy();
    expect(putSpy).not.toHaveBeenCalled();
  });
});

describe('saving', () => {
  test('an edit sends the whole form, including the sleep settings', async () => {
    const { user } = mount();
    const name = await screen.findByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Alexandra');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(putSpy).toHaveBeenCalled());
    const [path, body] = putSpy.mock.calls[0];
    expect(path).toBe('/children/kid-1');
    expect(body.name).toBe('Alexandra');
    expect(body.track_sleep).toBe(true);
    expect(body.sleep_window_start).toBe('19:30');
    expect(body.sleep_window_end).toBe('06:45');
  });

  test('an edited window reaches the payload', async () => {
    const { user } = mount();
    const bed = await screen.findByLabelText('Bedtime');
    await user.clear(bed);
    await user.type(bed, '20:15');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(putSpy).toHaveBeenCalled());
    expect(putSpy.mock.calls[0][1].sleep_window_start).toBe('20:15');
  });

  test('a new child is POSTed and the list refreshed', async () => {
    const { user, camerasValue } = mount({ id: 'new' });
    await user.type(await screen.findByLabelText('Name'), 'Child A');
    await user.click(screen.getByRole('button', { name: 'Add child' }));

    await waitFor(() => expect(postSpy).toHaveBeenCalled());
    expect(postSpy.mock.calls[0][0]).toBe('/children');
    expect(postSpy.mock.calls[0][1].name).toBe('Child A');
    await waitFor(() => expect(camerasValue.refresh).toHaveBeenCalled());
  });

  test('a rejected save says why and stays on the form', async () => {
    putSpy = vi.spyOn(api, 'put').mockRejectedValue(new Error('Bedtime must be a time like 19:00'));
    const { user } = mount();
    await user.click(await screen.findByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Bedtime must be a time like 19:00')).toBeTruthy();
    expect(screen.getByText('at /children/kid-1')).toBeTruthy();
  });

  test('★ it returns to wherever you came from', async () => {
    // A child is reachable from the Children tab and from their own detail page; going "back" to a
    // fixed destination would strand someone who arrived the other way.
    const { user } = mount();
    await user.click(await screen.findByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('at /children')).toBeTruthy();
  });
});

describe('★★ the immediate photo write', () => {
  test('sends ONLY the photo — not the identity fields, not the sleep settings (#384)', async () => {
    // The partial payload the route is trusted to complete. If this screen ever padded it out from
    // its own state, a photo change would start writing whatever the form happened to be holding —
    // a name or birthday, or a sleep window, the person had edited but not saved.
    const { user } = mount();
    await user.click(await screen.findByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(putSpy).toHaveBeenCalled());
    const [path, body] = putSpy.mock.calls[0];
    expect(path).toBe('/children/kid-1');
    expect(body).toEqual({ photo: null });
  });

  test('★ #384: an unsaved name and birthday are neither written by the photo save nor lost, and still go with Save changes', async () => {
    const { user } = mount();
    const name = await screen.findByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Renamed');
    fireEvent.change(screen.getByLabelText(/Birthday/), { target: { value: '2024-02-02' } });

    await user.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(putSpy).toHaveBeenCalledTimes(1));
    expect(putSpy.mock.calls[0][1], 'the photo save must carry nothing the person has not saved').toEqual({ photo: null });
    await screen.findByText('Photo saved ✓');

    // Left untouched: still on screen after the photo save and the refresh that follows it...
    expect(screen.getByLabelText('Name').value).toBe('Renamed');
    expect(screen.getByLabelText(/Birthday/).value).toBe('2024-02-02');

    // ...and still unsaved, so Save changes is what commits them (with the photo as it now is).
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(putSpy).toHaveBeenCalledTimes(2));
    const saved = putSpy.mock.calls[1][1];
    expect(saved.name).toBe('Renamed');
    expect(saved.birthday).toBe('2024-02-02');
    expect(saved.photo).toBe(null);
  });

  test('says it saved, and refreshes so the avatar updates everywhere', async () => {
    const { user, camerasValue } = mount();
    await user.click(await screen.findByRole('button', { name: 'Remove' }));
    expect(await screen.findByText('Photo saved ✓')).toBeTruthy();
    await waitFor(() => expect(camerasValue.refresh).toHaveBeenCalled());
  });

  // #855: the 2 s timer that blanks "Photo saved" used to run on after the page had gone, and in CI it fired after jsdom
  // was torn down ("window is not defined", an unhandled error that failed the run although every test passed).
  test('★ #855: leaving the page cancels the "Photo saved" timer', async () => {
    const setSpy = vi.spyOn(globalThis, 'setTimeout');
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    const { user, unmount } = mount();
    await user.click(await screen.findByRole('button', { name: 'Remove' }));
    await screen.findByText('Photo saved ✓');
    // The 2 s timers this screen started (other libraries use other delays).
    const ids = setSpy.mock.calls.flatMap((c, i) => (c[1] === 2000 ? [setSpy.mock.results[i].value] : []));
    expect(ids).toHaveLength(1);
    expect(clearSpy).not.toHaveBeenCalledWith(ids[0]);
    unmount();
    expect(clearSpy).toHaveBeenCalledWith(ids[0]);
  });

  // The other way in (Codex review of #858): the page closes while the save is still in flight, so the cleanup has
  // already run when the save finishes. It must not start a timer nothing would ever cancel.
  test('★ #855: a save that finishes after the page is gone starts no "Photo saved" timer', async () => {
    const setSpy = vi.spyOn(globalThis, 'setTimeout');
    let finish;
    putSpy.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const { user, unmount } = mount();
    await user.click(await screen.findByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(putSpy).toHaveBeenCalled());
    unmount();
    finish({});
    await new Promise((resolve) => setTimeout(resolve, 20)); // let the save's continuation run
    expect(setSpy.mock.calls.filter((c) => c[1] === 2000)).toHaveLength(0);
  });

  test('a failed photo write says why and does not claim success', async () => {
    putSpy = vi.spyOn(api, 'put').mockRejectedValue(new Error('Image is too large'));
    const { user } = mount();
    await user.click(await screen.findByRole('button', { name: 'Remove' }));
    expect(await screen.findByText('Image is too large')).toBeTruthy();
    expect(screen.queryByText('Photo saved ✓')).toBeNull();
  });

  test('a new child offers no photo controls that would write on their own', async () => {
    // ⚠️ NAMED FOR WHAT IT ACTUALLY PROVES. `persistPhoto`'s `if (isNew) return` guard — which stops
    // the screen PUTting to /children/undefined — is reachable only through the photo PICKER, and
    // that goes via `imageResize.js` (canvas), which jsdom stubs. So this test cannot exercise the
    // guard, and a mutant removing it survives here; it is covered by the Playwright suite instead.
    // What this does prove is the half that is reachable: nothing on a new child's screen triggers an
    // immediate write.
    mount({ id: 'new' });
    await screen.findByLabelText('Name');
    expect(screen.queryByRole('button', { name: 'Remove' }), 'nothing to remove yet').toBeNull();
    expect(putSpy).not.toHaveBeenCalled();
  });
});

describe('the colour picker', () => {
  test('offers every colour and marks the chosen one', async () => {
    mount();
    await screen.findByLabelText('Name');
    const chosen = screen.getByLabelText(`Colour ${KID.color}`);
    expect(chosen.style.border).toContain('3px solid var(--text-primary)');
  });

  test('choosing one updates the form without saving', async () => {
    const { user } = mount();
    await screen.findByLabelText('Name');
    await user.click(screen.getByLabelText('Colour #8A9FE0'));
    expect(putSpy).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(putSpy).toHaveBeenCalled());
    expect(putSpy.mock.calls[0][1].color).toBe('#8A9FE0');
  });
});

describe('what each role is told about clip settings', () => {
  test('★ an admin gets a link to the settings they can actually change', async () => {
    renderAsAdmin(
      <Routes><Route path="/children/:id" element={<ChildSettings />} /></Routes>,
      { kids: [KID], route: '/children/kid-1' }
    );
    await screen.findByLabelText('Name');
    const link = screen.getByRole('link', { name: /Settings › Camera and Recording › Recording/ });
    expect(link.getAttribute('href')).toBe('/settings/recording');
  });

  test('★ a caregiver is told an admin can change them, and given no dead link', async () => {
    // Recording settings sit behind <AdminProtected>. Offering a caregiver the link would send them
    // to a screen that bounces them back — which reads as a broken app rather than a boundary.
    renderAs(CAREGIVER, <Routes><Route path="/children/:id" element={<ChildSettings />} /></Routes>,
      { kids: [KID], route: '/children/kid-1' });
    await screen.findByLabelText('Name');
    expect(screen.queryByRole('link', { name: /Settings › Camera and Recording › Recording/ })).toBeNull();
    expect(screen.getByText(/an admin can change their length and retention/)).toBeTruthy();
  });

  test('both roles can still edit the child', async () => {
    // Name, birthday, colour and photo stay open to a caregiver (#542 gates only tracking and the
    // window, below), so both roles get the form and its Save.
    for (const who of [ADMIN, CAREGIVER]) {
      const { unmount } = mount({ who });
      expect(await screen.findByRole('button', { name: 'Save changes' })).toBeTruthy();
      expect(screen.getByLabelText('Name')).toBeEnabled();
      unmount();
    }
  });
});

describe('★★ the sleep camera picker (#655)', () => {
  // GET /cameras order (tile order), as CamerasContext publishes it. cam-other belongs to another child and
  // must never be offered.
  const CAMS = [
    { id: 'cam-1', name: 'Cam one', child_id: 'kid-1', disabled: 0 },
    { id: 'cam-other', name: 'Their cam', child_id: 'kid-9', disabled: 0 },
    { id: 'cam-2', name: 'Cam two', child_id: 'kid-1', disabled: 1 },
  ];
  const LABEL = "Camera used for this child's sleep";
  const optionTexts = () => [...screen.getByLabelText(LABEL).options].map((o) => o.textContent);

  test('★ an admin gets every camera of this child, turned-off ones marked, and Automatic first', async () => {
    mount({ kid: { ...KID, primary_camera_id: null, primary_camera: { id: 'cam-1', name: 'Cam one' } }, cameras: CAMS });
    const select = await screen.findByLabelText(LABEL);
    expect(select).toBeEnabled();
    expect(select.value).toBe('');
    expect(optionTexts()).toEqual([
      'Automatic (first enabled camera in tile order)', 'Cam one', 'Cam two (turned off)',
    ]);
  });

  test('★ a caregiver sees it disabled, with the reason', async () => {
    mount({ who: CAREGIVER, kid: { ...KID, primary_camera_id: 'cam-1', primary_camera: { id: 'cam-1', name: 'Cam one' } }, cameras: CAMS });
    const select = await screen.findByLabelText(LABEL);
    expect(select).toBeDisabled();
    expect(select.value, 'still SHOWS the stored choice').toBe('cam-1');
    expect(screen.getByText(/Only an admin can change sleep tracking, the bedtime window and the sleep camera/)).toBeTruthy();
  });

  test('hidden for a child with one camera and no choice made (nothing to choose)', async () => {
    mount({ cameras: [CAMS[0], CAMS[1]] });
    await screen.findByLabelText('Name');
    expect(screen.queryByLabelText(LABEL)).toBeNull();
  });

  test('hidden for a child with no camera at all', async () => {
    mount({ cameras: [] });
    await screen.findByLabelText('Name');
    expect(screen.queryByLabelText(LABEL)).toBeNull();
  });

  test('★ "Currently measured from" names the camera the SERVER resolved, not one re-derived here', async () => {
    // The stored choice is cam-2, which is turned off, so the server falls back to cam-1 and says so in
    // `primary_camera`. A screen that re-derived the answer from the stored id would name Cam two.
    mount({ kid: { ...KID, primary_camera_id: 'cam-2', primary_camera: { id: 'cam-1', name: 'Cam one' } }, cameras: CAMS });
    await screen.findByLabelText(LABEL);
    const line = screen.getByText(/Currently measured from/);
    expect(line.textContent).toMatch(/Currently measured from Cam one\./);
    expect(line.textContent).toMatch(/The chosen camera is turned off or no longer assigned/);
  });

  test('★ says truthfully which saved nights a change can still reach', async () => {
    // The first wording said "saved summaries keep their numbers", which is false: last night's summary
    // is re-scored for ~3h after the wake time, and a review correction or Recompute re-scores a night
    // (#655 review). Pinned on the parts a reader acts on, not the whole sentence.
    mount({ kid: { ...KID, primary_camera_id: null, primary_camera: { id: 'cam-1', name: 'Cam one' } }, cameras: CAMS });
    await screen.findByLabelText(LABEL);
    const text = screen.getByText(/Currently measured from/).textContent;
    expect(text).toMatch(/A night's detail page always\s+uses the new camera\./);
    expect(text).toMatch(/last night's can still\s+be updated for a few hours after the wake time/);
    expect(text).toMatch(/a review correction or a Recompute\s+works a night out again/);
    expect(text).not.toMatch(/saved summaries keep their\s+numbers/);
  });

  test('says so when no camera of the child is on', async () => {
    mount({ kid: { ...KID, primary_camera_id: 'cam-2', primary_camera: null }, cameras: CAMS });
    await screen.findByLabelText(LABEL);
    expect(screen.getByText(/No camera of this child is turned on/)).toBeTruthy();
  });

  test('★★ a stale stored camera (deleted) is still shown, as "(unavailable)", and a save keeps it', async () => {
    // One camera left, so only the stored choice makes the picker appear. Without the extra option the
    // select would show Automatic and a plain rename would clear the stored choice without anyone asking.
    const { user } = mount({ kid: { ...KID, primary_camera_id: 'cam-gone', primary_camera: { id: 'cam-1', name: 'Cam one' } }, cameras: [CAMS[0]] });
    const select = await screen.findByLabelText(LABEL);
    expect(select.value).toBe('cam-gone');
    expect(optionTexts()).toContain('A removed camera (unavailable)');

    const name = screen.getByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Renamed');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(putSpy).toHaveBeenCalled());
    expect(putSpy.mock.calls[0][1].primary_camera_id).toBe('cam-gone');
  });

  test('an admin\'s choice reaches the payload; Automatic is sent as ""', async () => {
    const { user } = mount({ kid: { ...KID, primary_camera_id: null, primary_camera: { id: 'cam-1', name: 'Cam one' } }, cameras: CAMS });
    await user.selectOptions(await screen.findByLabelText(LABEL), 'cam-2');
    expect(putSpy, 'a form field: nothing is written until Save').not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(putSpy).toHaveBeenCalled());
    expect(putSpy.mock.calls[0][1].primary_camera_id).toBe('cam-2');
  });

  test('★ a caregiver\'s save leaves it OUT, so a stale form can never be why a rename is refused', async () => {
    const { user } = mount({ who: CAREGIVER, kid: { ...KID, primary_camera_id: 'cam-1', primary_camera: { id: 'cam-1', name: 'Cam one' } }, cameras: CAMS });
    await screen.findByLabelText(LABEL);
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(putSpy).toHaveBeenCalled());
    expect(putSpy.mock.calls[0][1]).not.toHaveProperty('primary_camera_id');
  });
});

describe('★★ what a caregiver can change (#542)', () => {
  const NOTE = 'Only an admin can change sleep tracking, the bedtime window and the sleep camera.';

  test('tracking and the window are shown but disabled, with the reason; an admin gets them enabled', async () => {
    const carer = mount({ who: CAREGIVER });
    await screen.findByLabelText('Name');
    expect(screen.getByRole('switch', { name: /Track sleep/ })).toBeDisabled();
    expect(screen.getByRole('switch', { name: /Track sleep/ }).checked, 'still SHOWS the stored state').toBe(true);
    expect(screen.getByLabelText('Bedtime')).toBeDisabled();
    expect(screen.getByLabelText('Wake time')).toBeDisabled();
    expect(screen.getByText(NOTE)).toBeTruthy();
    carer.unmount();

    mount({ who: ADMIN });
    await screen.findByLabelText('Name');
    expect(screen.getByRole('switch', { name: /Track sleep/ })).toBeEnabled();
    expect(screen.getByLabelText('Bedtime')).toBeEnabled();
    expect(screen.getByLabelText('Wake time')).toBeEnabled();
    expect(screen.queryByText(NOTE)).toBeNull();
  });

  test('★ a caregiver\'s save sends ONLY name, birthday, colour and photo', async () => {
    // The server refuses the whole request if a caregiver's save would CHANGE tracking or the window.
    // Leaving them out (rather than echoing the form) means no stale form state can be the reason a
    // caregiver's rename is refused.
    const { user } = mount({ who: CAREGIVER });
    const name = await screen.findByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Alexandra');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(putSpy).toHaveBeenCalled());
    const [path, body] = putSpy.mock.calls[0];
    expect(path).toBe('/children/kid-1');
    expect(Object.keys(body).sort()).toEqual(['birthday', 'color', 'name', 'photo']);
    expect(body.name).toBe('Alexandra');
  });

  test('a refused save shows the server\'s reason and stays on the form', async () => {
    // A page opened by an admin who was then demoted still renders the admin form; the server's 403
    // message is what tells them why nothing was saved.
    const reason = 'Only an admin can turn sleep tracking on or off, change the sleep window or choose the camera '
      + "a child's sleep is measured from, or hold alerts until asleep. Your other changes were not saved.";
    putSpy = vi.spyOn(api, 'put').mockRejectedValue(Object.assign(new Error(reason), { status: 403 }));
    const { user } = mount({ who: CAREGIVER });
    await user.click(await screen.findByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText(reason)).toBeTruthy();
    expect(screen.getByText('at /children/kid-1')).toBeTruthy();
  });

  test('★ a caregiver has no Remove child; an admin does', async () => {
    const carer = mount({ who: CAREGIVER });
    await screen.findByLabelText('Name');
    expect(screen.queryByRole('button', { name: 'Remove child' })).toBeNull();
    carer.unmount();
    mount({ who: ADMIN });
    expect(await screen.findByRole('button', { name: 'Remove child' })).toBeTruthy();
  });

  test('★ a caregiver on Add child is told an admin adds children, with no form to fill in', async () => {
    mount({ who: CAREGIVER, id: 'new' });
    expect(await screen.findByText('Only an admin can add a child. Ask an admin to add them.')).toBeTruthy();
    expect(screen.queryByLabelText('Name')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add child' })).toBeNull();
    expect(postSpy).not.toHaveBeenCalled();
  });
});

describe('removing a child', () => {
  test('★ the dialog is a real dialog, named by its own heading', async () => {
    // `role="dialog"` is covered incidentally by every `findByRole('dialog')` in the suite, but
    // `aria-modal` and `aria-labelledby` were not asserted anywhere — removing BOTH left all 500
    // tests green. They are the parts that make the page behind inert and give the dialog a name, and
    // this dialog is a destructive confirmation, which is exactly where that matters.
    const { user } = mount();
    await user.click(await screen.findByRole('button', { name: 'Remove child' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog).toHaveAccessibleName('Remove child');
  });

  test('★ asks first, and says what happens to the cameras', async () => {
    // The consequence people do not expect: the cameras survive, unassigned. Saying so is what stops
    // someone believing they are about to delete the cameras too.
    const { user } = mount();
    await user.click(await screen.findByRole('button', { name: 'Remove child' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/become unassigned/)).toBeTruthy();
    expect(delSpy).not.toHaveBeenCalled();
  });

  // ★ #540. The server now deletes everything recorded for the child, files included. The dialog must
  // say so and list it; "Cameras assigned to them become unassigned" alone read as if that were the whole
  // consequence. One assertion per category: a regex over the paragraph would survive a dropped line.
  test('★ #540 the dialog says plainly that everything for the child is deleted, lists what, and asks', async () => {
    const { user } = mount();
    await user.click(await screen.findByRole('button', { name: 'Remove child' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/permanently deletes everything for this child/)).toBeTruthy();
    const items = within(dialog).getAllByRole('listitem').map((li) => li.textContent);
    expect(items).toHaveLength(5);
    expect(items.join('|')).toMatch(/sleep nights and morning reviews, with their notes/);
    expect(items.join('|')).toMatch(/bed transitions and their snapshot photos/);
    expect(items.join('|')).toMatch(/activity history their cameras recorded/);
    expect(items.join('|')).toMatch(/recordings, wake clips and timelapses, including the video files/);
    expect(items.join('|')).toMatch(/profile, photo and sleep settings/);
    expect(within(dialog).getByText('Are you sure?')).toBeTruthy();
    // #719 review: "everything for this child" has one exception, and the dialog has to name it to be true.
    expect(within(dialog).getByText(/Alert clips and photos from those cameras belong to the camera, so they are kept until their retention removes them \(or the camera is removed\)/)).toBeTruthy();
    expect(delSpy).not.toHaveBeenCalled();
  });

  // ★ #719 review. Through the REAL api.js (only fetch is stubbed): a 409 refusal shows the server's reason inside
  // the dialog, never "Request failed (409)". (A 5xx body would be stripped by Cloudflare, which is why it is 409.)
  test('★ #719 a refused delete (409) shows the server\'s reason inside the dialog', async () => {
    const reason = "Could not delete everything for this child (a file was in use), so the child was not removed.";
    delSpy.mockRestore();
    const fetchSpy = vi.fn(async () => ({ ok: false, status: 409, text: async () => JSON.stringify({ error: reason }) }));
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const { user, camerasValue } = mount();
      await user.click(await screen.findByRole('button', { name: 'Remove child' }));
      await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove' }));
      const dialog = screen.getByRole('dialog');
      expect(await within(dialog).findByRole('alert')).toHaveTextContent(reason);
      expect(within(dialog).queryByText(/Request failed/)).toBeNull();
      expect(fetchSpy).toHaveBeenCalledWith('/api/children/kid-1', expect.objectContaining({ method: 'DELETE' }));
      expect(camerasValue.refresh).not.toHaveBeenCalled();
      expect(screen.getByText('at /children/kid-1')).toBeTruthy();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('confirming deletes, refreshes and goes back', async () => {
    const { user, camerasValue } = mount();
    await user.click(await screen.findByRole('button', { name: 'Remove child' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(delSpy).toHaveBeenCalledWith('/children/kid-1'));
    await waitFor(() => expect(camerasValue.refresh).toHaveBeenCalled());
    expect(await screen.findByText('at /children')).toBeTruthy();
  });

  test('a failed delete says why and keeps you on the child', async () => {
    delSpy = vi.spyOn(api, 'del').mockRejectedValue(new Error('Child has recorded nights'));
    const { user } = mount();
    await user.click(await screen.findByRole('button', { name: 'Remove child' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove' }));

    expect(await screen.findByText('Child has recorded nights')).toBeTruthy();
    expect(screen.getByText('at /children/kid-1')).toBeTruthy();
  });

  // ★ #378. The test above only asks that the text is somewhere in the document, which is just as true
  // when it sits in the page banner in <main>, under the modal overlay: the person tapped Remove and saw
  // nothing happen. jsdom cannot see an overlay; it can see which element the message is a descendant of.
  test('★ #378 the failure is shown INSIDE the dialog, once, and the dialog stays open to retry', async () => {
    delSpy = vi.spyOn(api, 'del').mockRejectedValue(new Error('Refused: cameras still streaming #378'));
    const { user, camerasValue } = mount();
    await user.click(await screen.findByRole('button', { name: 'Remove child' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove' }));

    const dialog = screen.getByRole('dialog');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Refused: cameras still streaming #378');
    expect(screen.getAllByText('Refused: cameras still streaming #378')).toHaveLength(1);
    expect(within(dialog).getByRole('button', { name: 'Remove' })).toBeEnabled();
    expect(camerasValue.refresh).not.toHaveBeenCalled();
    expect(screen.getByText('at /children/kid-1')).toBeTruthy();

    // Cancel and reopen: the old message must not greet the next attempt.
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await user.click(screen.getByRole('button', { name: 'Remove child' }));
    expect(within(screen.getByRole('dialog')).queryByRole('alert')).toBeNull();
  });

  test('a new child has nothing to remove', async () => {
    mount({ id: 'new' });
    await screen.findByLabelText('Name');
    expect(screen.queryByRole('button', { name: 'Remove child' })).toBeNull();
  });
});

describe('#919 hold alerts until asleep', () => {
  const HOLD = /Hold alerts until asleep/;

  test('legacy children default to off', async () => {
    mount();
    expect((await screen.findByRole('switch', { name: HOLD })).checked).toBe(false);
  });

  test('new children submit the default off value', async () => {
    const { user } = mount({ kid: null, id: 'new' });
    expect((await screen.findByRole('switch', { name: HOLD })).checked).toBe(false);
    await user.type(screen.getByLabelText('Name'), 'A child');
    await user.click(screen.getByRole('button', { name: 'Add child' }));
    await waitFor(() => expect(postSpy).toHaveBeenCalled());
    expect(postSpy.mock.calls[0][1].hold_alerts_until_asleep).toBe(false);
  });

  test('admin can save the switch', async () => {
    const { user } = mount({ kid: { ...KID, hold_alerts_until_asleep: 1 } });
    expect((await screen.findByRole('switch', { name: HOLD })).checked).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(putSpy).toHaveBeenCalled());
    expect(putSpy.mock.calls[0][1].hold_alerts_until_asleep).toBe(true);
  });

  test('caregiver sees a disabled switch and does not send it', async () => {
    const { user } = mount({ who: CAREGIVER });
    expect(await screen.findByRole('switch', { name: HOLD })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(putSpy).toHaveBeenCalled());
    expect(putSpy.mock.calls[0][1]).not.toHaveProperty('hold_alerts_until_asleep');
  });

  test('switch is hidden when Track sleep is off', async () => {
    mount({ kid: { ...KID, track_sleep: 0 } });
    await screen.findByLabelText('Name');
    expect(screen.queryByRole('switch', { name: HOLD })).toBeNull();
  });
});

describe('★★ the nightly sleep report choices (#397, #398)', () => {
  const SEND = /Send this child's sleep report/;
  const NAME = /Show this child's name in the report/;

  test('a child that predates the choices shows both ON, which is what they have always done', async () => {
    mount({ kid: KID }); // KID carries neither field
    await screen.findByLabelText('Name');
    expect(screen.getByRole('switch', { name: SEND }).checked).toBe(true);
    expect(screen.getByRole('switch', { name: NAME }).checked).toBe(true);
  });

  test('stored OFF values are shown OFF', async () => {
    mount({ kid: { ...KID, sleep_report_enabled: 0, sleep_report_show_name: 0 } });
    await screen.findByLabelText('Name');
    expect(screen.getByRole('switch', { name: SEND }).checked).toBe(false);
    expect(screen.getByRole('switch', { name: NAME }).checked).toBe(false);
  });

  test('an admin can turn each off, and the save carries both', async () => {
    const { user } = mount({ kid: KID });
    await screen.findByLabelText('Name');
    await user.click(screen.getByRole('switch', { name: NAME }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(putSpy).toHaveBeenCalled());
    expect(putSpy.mock.calls[0][1]).toMatchObject({ sleep_report_enabled: true, sleep_report_show_name: false });
  });

  test('the name choice means nothing while the report is off, so it cannot be changed then', async () => {
    const { user } = mount({ kid: KID });
    await screen.findByLabelText('Name');
    await user.click(screen.getByRole('switch', { name: SEND }));
    expect(screen.getByRole('switch', { name: NAME })).toBeDisabled();
  });

  test('a caregiver sees them disabled with the reason, and their save does not send them', async () => {
    const { user } = mount({ kid: { ...KID, sleep_report_show_name: 0 }, who: CAREGIVER });
    await screen.findByLabelText('Name');
    expect(screen.getByRole('switch', { name: SEND })).toBeDisabled();
    expect(screen.getByRole('switch', { name: NAME })).toBeDisabled();
    expect(screen.getByText('Only an admin can change what the sleep report sends.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(putSpy).toHaveBeenCalled());
    expect(putSpy.mock.calls[0][1]).not.toHaveProperty('sleep_report_enabled');
    expect(putSpy.mock.calls[0][1]).not.toHaveProperty('sleep_report_show_name');
  });

  test('a new child starts with both ON', async () => {
    const { user } = mount({ kid: null, id: 'new' });
    await user.type(await screen.findByLabelText('Name'), 'Someone');
    await user.click(screen.getByRole('button', { name: 'Add child' }));
    await waitFor(() => expect(postSpy).toHaveBeenCalled());
    expect(postSpy.mock.calls[0][1]).toMatchObject({ sleep_report_enabled: true, sleep_report_show_name: true });
  });
});
