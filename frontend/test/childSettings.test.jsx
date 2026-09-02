// Add / edit a child.
//
// ★ WHY. Two things here are load-bearing well beyond this screen:
//
//  1. **The sleep window and the tracking switch live here, and nowhere else.** Every night's analysis
//     is scoped to that window; turning tracking off stops a child's sleep being recorded at all. A
//     screen that quietly changed either would show nothing wrong — the damage appears days later as
//     missing or mis-scoped nights.
//  2. **Setting a photo writes IMMEDIATELY, with a partial payload** that carries neither of those
//     fields. That is safe only because the route keeps what it is not sent
//     (backend/test/children-route.test.js pins the other half). What is tested here is that the
//     partial payload really is partial — and that the screen does not reach for stale state to pad
//     it out, which is how a "helpful" fix would reintroduce exactly the bug.
//
// ⚠️ The photo PICKER is not exercised: it goes through `imageResize.js` (canvas), which jsdom stubs.
// `persistPhoto` is reached through Remove, which takes the same path with a null photo.
//
// This screen is open to any signed-in user — children have always been managed by both roles — so
// both roles are exercised where the screen differs.
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { Routes, Route, useLocation } from 'react-router-dom';
import { renderAs, renderAsAdmin, ADMIN, CAREGIVER } from './helpers/render.jsx';
import ChildSettings from '../src/pages/ChildSettings.jsx';
import { api } from '../src/lib/api.js';

const KID = {
  id: 'kid-1',
  name: 'Raffa',
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

function mount({ kid = KID, id = KID.id, who = ADMIN } = {}) {
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
    { kids: kid ? [kid] : [], route: `/children/${id}` }
  );
}

beforeEach(() => mockApi());
afterEach(() => vi.restoreAllMocks());

describe('loading a child', () => {
  test('every stored field is shown', async () => {
    mount();
    expect((await screen.findByLabelText('Name')).value).toBe('Raffa');
    expect(screen.getByLabelText(/Birthday/).value).toBe('2023-04-01');
    expect(screen.getByRole('switch').checked).toBe(true);
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
    const { user } = mount({ kid: { id: 'kid-1', name: 'Renz', track_sleep: 1 } });
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
    mount({ kid: { id: 'kid-1', name: 'Renz', track_sleep: null } });
    await screen.findByLabelText('Name');
    expect(screen.getByRole('switch').checked).toBe(true);
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
    await user.type(name, 'Raffaella');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(putSpy).toHaveBeenCalled());
    const [path, body] = putSpy.mock.calls[0];
    expect(path).toBe('/children/kid-1');
    expect(body.name).toBe('Raffaella');
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
    await user.type(await screen.findByLabelText('Name'), 'Renz');
    await user.click(screen.getByRole('button', { name: 'Add child' }));

    await waitFor(() => expect(postSpy).toHaveBeenCalled());
    expect(postSpy.mock.calls[0][0]).toBe('/children');
    expect(postSpy.mock.calls[0][1].name).toBe('Renz');
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
  test('sends ONLY the identity fields — not the sleep settings', async () => {
    // The partial payload the route is trusted to complete. If this screen ever padded it out from
    // its own state, a photo change would start writing whatever the form happened to be holding —
    // including a sleep window the person had edited but not saved.
    const { user } = mount();
    await user.click(await screen.findByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(putSpy).toHaveBeenCalled());
    const [path, body] = putSpy.mock.calls[0];
    expect(path).toBe('/children/kid-1');
    expect(Object.keys(body).sort()).toEqual(['birthday', 'color', 'name', 'photo']);
    expect(body.photo).toBe(null);
    expect(body, 'the sleep window is the route\'s to keep').not.toHaveProperty('sleep_window_start');
    expect(body).not.toHaveProperty('track_sleep');
  });

  test('says it saved, and refreshes so the avatar updates everywhere', async () => {
    const { user, camerasValue } = mount();
    await user.click(await screen.findByRole('button', { name: 'Remove' }));
    expect(await screen.findByText('Photo saved ✓')).toBeTruthy();
    await waitFor(() => expect(camerasValue.refresh).toHaveBeenCalled());
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
    const link = screen.getByRole('link', { name: /Settings › Recording/ });
    expect(link.getAttribute('href')).toBe('/settings/recording');
  });

  test('★ a caregiver is told an admin can change them, and given no dead link', async () => {
    // Recording settings sit behind <AdminProtected>. Offering a caregiver the link would send them
    // to a screen that bounces them back — which reads as a broken app rather than a boundary.
    renderAs(CAREGIVER, <Routes><Route path="/children/:id" element={<ChildSettings />} /></Routes>,
      { kids: [KID], route: '/children/kid-1' });
    await screen.findByLabelText('Name');
    expect(screen.queryByRole('link', { name: /Settings › Recording/ })).toBeNull();
    expect(screen.getByText(/an admin can change their length and retention/)).toBeTruthy();
  });

  test('both roles can still edit the child', async () => {
    // Children have always been managed by both roles; this screen does no gating of its own beyond
    // the link above, and that is deliberate.
    for (const who of [ADMIN, CAREGIVER]) {
      const { unmount } = mount({ who });
      expect(await screen.findByRole('button', { name: 'Save changes' })).toBeTruthy();
      unmount();
    }
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

  test('a new child has nothing to remove', async () => {
    mount({ id: 'new' });
    await screen.findByLabelText('Name');
    expect(screen.queryByRole('button', { name: 'Remove child' })).toBeNull();
  });
});
