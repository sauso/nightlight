// The tappable avatar with a camera badge (owner, 2026-11-05; the badge became the round disc 2026-11-15, its colours are pinned in
// paletteTokens.test.jsx), used on the child's settings, your own account, the caregiver form and the setup screens.
//
// The component is only the picker: what happens with the file stays with each page. So these tests cover the component's
// own contract (name, change event, initials fallback) AND, on both pages, that picking a photo still reaches the same save
// as before the avatar replaced the "Add photo" button. imageResize is mocked because jsdom's canvas is a stub; the pages'
// save paths are what is under test here.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { Routes, Route } from 'react-router-dom';
import { renderAs, ADMIN } from './helpers/render.jsx';
import AvatarEditor from '../src/components/AvatarEditor.jsx';
import ChildSettings from '../src/pages/ChildSettings.jsx';
import Account from '../src/pages/Account.jsx';
import UserSettings from '../src/pages/UserSettings.jsx';
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { api } from '../src/lib/api.js';
import * as imageResize from '../src/lib/imageResize.js';

afterEach(() => vi.restoreAllMocks());

const FILE = () => new File(['x'], 'face.png', { type: 'image/png' });
const pick = (input) => fireEvent.change(input, { target: { files: [FILE()] } });

describe('AvatarEditor', () => {
  const mount = (props = {}) => renderAs(ADMIN, <AvatarEditor name="Child B" size={88} onChange={() => {}} {...props} />, {});

  test('★ with no photo it shows the initials and offers "Add photo"', () => {
    mount();
    expect(screen.getByText('CB')).toBeTruthy(); // the initials of "Child B"
    expect(screen.getByLabelText('Add photo').type).toBe('file');
  });

  test('with a photo it shows the picture and offers "Change photo"', () => {
    const { container } = mount({ src: 'data:image/png;base64,AAA' });
    expect(container.querySelector('img').getAttribute('src')).toBe('data:image/png;base64,AAA');
    expect(screen.getByLabelText('Change photo').type).toBe('file');
  });

  test('★ choosing a file calls onChange with the change event (the pages read the file from it)', () => {
    const onChange = vi.fn();
    mount({ onChange });
    pick(screen.getByLabelText('Add photo'));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0].target.files[0].name).toBe('face.png');
  });

  test('the camera badge is decoration: hidden from assistive technology, and the picker is only images', () => {
    const { container } = mount();
    const badge = container.querySelector('.avatar-editor__badge');
    expect(badge.getAttribute('aria-hidden')).toBe('true');
    expect(badge.querySelector('svg'), 'the camera glyph is inside the badge').not.toBeNull();
    expect(badge.style.width, 'the badge scales with the avatar').toBe('30px'); // round(88 * 0.34)
    expect(screen.getByLabelText('Add photo').getAttribute('accept')).toBe('image/*');
  });
});

describe('on the child settings page', () => {
  const KID = { id: 'kid-1', name: 'Child B', birthday: null, color: '#7FBFA3', photo: null,
    track_sleep: 1, sleep_window_start: '19:30', sleep_window_end: '06:45' };
  let putSpy;
  beforeEach(() => {
    putSpy = vi.spyOn(api, 'put').mockResolvedValue({});
    vi.spyOn(api, 'post').mockResolvedValue({ id: 'kid-new' });
    vi.spyOn(imageResize, 'fileToAvatarDataUrl').mockResolvedValue('data:image/png;base64,PICKED');
  });
  const mount = (id) => renderAs(ADMIN, <Routes>
    <Route path="/children/new" element={<ChildSettings />} />
    <Route path="/children/:id" element={<ChildSettings />} />
  </Routes>, { kids: [KID], route: `/children/${id}` });

  test('★ picking a photo for an existing child saves it at once, carrying only the photo', async () => {
    mount('kid-1');
    pick(await screen.findByLabelText('Add photo'));
    await waitFor(() => expect(putSpy).toHaveBeenCalledWith('/children/kid-1', { photo: 'data:image/png;base64,PICKED' }, expect.anything()));
    expect(putSpy.mock.calls[0][1]).toEqual({ photo: 'data:image/png;base64,PICKED' });
    expect(await screen.findByText('Photo saved ✓')).toBeTruthy();
  });

  test('★ a new child keeps the picked photo in the form and writes nothing yet', async () => {
    const { container } = mount('new');
    pick(await screen.findByLabelText('Add photo'));
    await waitFor(() => expect(imageResize.fileToAvatarDataUrl).toHaveBeenCalled());
    await waitFor(() => expect(container.querySelector('.avatar-editor img')).not.toBeNull());
    expect(putSpy).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Change photo')).toBeTruthy();
  });

  test('a photo that cannot be read says why and saves nothing', async () => {
    imageResize.fileToAvatarDataUrl.mockRejectedValue(new Error('That image is too large'));
    mount('kid-1');
    pick(await screen.findByLabelText('Add photo'));
    expect(await screen.findByText('That image is too large')).toBeTruthy();
    expect(putSpy).not.toHaveBeenCalled();
  });
});

describe('on the account page', () => {
  let putSpy;
  beforeEach(() => {
    vi.spyOn(api, 'get').mockImplementation((path) => Promise.resolve(path === '/auth/sessions' ? [] : path === '/auth/me/mfa' ? { enabled: false, backup_codes_remaining: 0 } : null));
    putSpy = vi.spyOn(api, 'put').mockResolvedValue({});
    vi.spyOn(imageResize, 'fileToAvatarDataUrl').mockResolvedValue('data:image/png;base64,PICKED');
  });

  test('★ picking a photo saves it to your account, and shows Saved', async () => {
    renderAs({ ...ADMIN, photo: null }, <Account />, { route: '/account' });
    pick(await screen.findByLabelText('Add photo'));
    await waitFor(() => expect(putSpy).toHaveBeenCalledWith('/auth/me', { photo: 'data:image/png;base64,PICKED' }, expect.anything()));
    expect(await screen.findByText('Saved ✓')).toBeTruthy();
  });

  test('with a photo the avatar offers Change photo, and Remove clears it', async () => {
    const { user } = renderAs({ ...ADMIN, photo: 'data:image/png;base64,AAA' }, <Account />, { route: '/account' });
    expect(await screen.findByLabelText('Change photo')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(putSpy).toHaveBeenCalledWith('/auth/me', { photo: null }, expect.anything()));
  });

  test('no photo, nothing to remove', async () => {
    renderAs({ ...ADMIN, photo: null }, <Account />, { route: '/account' });
    await screen.findByLabelText('Add photo');
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
  });
});

describe('on the caregiver page (an admin editing a caregiver)', () => {
  const CAREGIVER = { id: 'u-care', username: 'nanny', first_name: 'Nanny', last_name: 'McPhee', role: 'caregiver', photo: null, mfa_enabled: 0 };
  const mount = (user = CAREGIVER) => {
    // The page fetches the LIST and finds its user in it: there is no per-user GET.
    vi.spyOn(api, 'get').mockImplementation((p) => (String(p).includes('/auth/users') ? Promise.resolve([user]) : Promise.resolve([])));
    vi.spyOn(api, 'put').mockResolvedValue({});
    vi.spyOn(imageResize, 'fileToAvatarDataUrl').mockResolvedValue('data:image/png;base64,PICKED');
    return renderAs(ADMIN, <Routes>
      <Route path="/settings/users/:id" element={<UserSettings />} />
    </Routes>, { route: `/settings/users/${user.id}` });
  };

  test('★ the avatar is the photo control, like the child and account pages', async () => {
    mount();
    await screen.findByDisplayValue('nanny');
    expect(screen.getByLabelText('Add photo').type).toBe('file');
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
  });

  test('★ picking a photo saves it to that caregiver, carrying only the photo; with a photo there is a Remove', async () => {
    const { user } = mount();
    await screen.findByDisplayValue('nanny');
    pick(screen.getByLabelText('Add photo'));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/auth/users/u-care', { photo: 'data:image/png;base64,PICKED' }, expect.anything()));
    expect(await screen.findByText('Photo saved ✓')).toBeTruthy();
    await user.click(await screen.findByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/auth/users/u-care', { photo: null }, expect.anything()));
  });
});

// Owner 2026-11-05: clicking the camera drew a second box around the badge, because the ring was on :focus-within and a click
// focuses the invisible input. jsdom does not apply :focus-visible or :has(), so this reads the rules by their tokens (not exact
// text, so a reformat cannot break it); the rendered check with a real click and a real Tab is in the PR.
describe("the focus ring", () => {
  const css = readFileSync(join(process.cwd(), "src", "index.css"), "utf8");
  const rules = () => css.replace(/\/\*[\s\S]*?\*\//g, '').split("}").map((rule) => rule.replace(/\s+/g, ' ').trim()).filter((rule) => rule.includes('avatar-editor'));

  test('★ nothing outlines the badge or the avatar on a plain focus (a click)', () => {
    expect(rules().length, 'the stylesheet was read and has the avatar rules').toBeGreaterThan(3);
    const outlined = rules().filter((rule) => /outline\s*:\s*[^;]*\S/.test(rule) && !/outline\s*:\s*none/.test(rule));
    for (const rule of outlined) expect(rule, `an outline that applies on any focus: ${rule}`).toContain(':focus-visible');
    expect(outlined.some((rule) => rule.includes(':focus-within')), 'no :focus-within ring').toBe(false);
  });

  test('★ keyboard focus still gets a visible ring, around the avatar', () => {
    const ring = rules().find((rule) => rule.includes(':focus-visible') && /outline\s*:/.test(rule));
    expect(ring, 'a :focus-visible ring exists').toBeTruthy();
    expect(ring.startsWith('.avatar-editor:has(')).toBe(true);
    expect(ring, 'the ring is on the avatar, not on the badge').not.toContain('__badge');
  });
});
