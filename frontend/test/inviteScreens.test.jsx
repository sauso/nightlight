// The caregiver invite screens (#1094, PR-Q2): the admin side (Users -> Add user -> "Send an invite", the invite panel, a pending
// account's page, the list pills, the setup guide) and the public page a caregiver opens from the link (AcceptInvite).
//
// ★ WHAT MATTERS MOST HERE, in order:
//  1. The TOKEN is a one-time secret that lets its holder choose the password for an account. It may appear in exactly two places
//     (the QR and the link the admin copies), never in storage on the admin's device, a console, an aria-label or a draft; and on the
//     caregiver's device it leaves the address bar at once and is only ever sent in a POST body.
//  2. The page asks the server ONCE (the server counts failures), and never replaces a session that is already signed in.
//  3. An invite never carries a password or an admin role.
// The server's side (single use, expiry, the compare-and-swaps) is tested in backend/test/auth-invite.test.js; nothing here pretends
// to cover it. Not covered here, and not coverable in jsdom: that the QR code really scans, how the pages look on a phone.
import { StrictMode } from 'react';
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, within, render, act, fireEvent } from '@testing-library/react';
import { Routes, Route, useLocation, useNavigate, useNavigationType, HashRouter } from 'react-router-dom';
import { renderAs, renderAsAdmin, ADMIN, CAREGIVER, forEachRole } from './helpers/render.jsx';
import UserSettings from '../src/pages/UserSettings.jsx';
import SettingsUsers from '../src/pages/SettingsUsers.jsx';
import AcceptInvite from '../src/pages/AcceptInvite.jsx';
import InvitePanel from '../src/components/InvitePanel.jsx';
import QrCode from '../src/components/QrCode.jsx';
import SetupCaregivers from '../src/components/SetupCaregivers.jsx';
import App, { AdminProtected } from '../src/App.jsx';
import { api, setToken } from '../src/lib/api.js';
import { isReloadHeld } from '../src/lib/reloadGuard.js';
import * as copyTextModule from '../src/lib/copyText.js';
import * as nativeBridge from '../src/lib/nativeBridge.js';
import * as push from '../src/lib/pushNotifications.js';
import { resetDemoStatusForTests } from '../src/lib/demoStatus.js';
import { captureInviteTokenFromLocation, readInviteToken, clearInviteToken, stashInviteToken } from '../src/lib/inviteToken.js';

// 43 characters, base64url, like the server's. Obviously fake, and unmistakable if it turns up somewhere it should not.
const TOKEN = 't0k3n-'.padEnd(43, 'Qz_x');
const EXPIRES = '2026-11-21 22:10:03'; // UTC text, no zone marker, exactly as the API sends it

const CREATED = { id: 'u-new', username: 'robin', role: 'caregiver', first_name: 'Robin', last_name: 'Ash', photo: null, invite: { token: TOKEN, expires_at: EXPIRES } };
const PENDING = { id: 'u-pend', username: 'robin', role: 'caregiver', first_name: 'Robin', last_name: 'Ash', photo: null, mfa_enabled: 0, password_set: false, invite_expires_at: EXPIRES, invite_accepted_at: null };
const NORMAL = { id: 'u-care', username: 'nanny', role: 'caregiver', first_name: 'Nanny', last_name: 'McPhee', photo: null, mfa_enabled: 0, password_set: true, invite_expires_at: null, invite_accepted_at: null };

const Probe = () => <div data-testid="at">{useLocation().pathname}|{useNavigationType()}</div>;
const at = () => screen.getByTestId('at').textContent;

let postSpy; let putSpy; let delSpy;

// Every test starts from a page with no token anywhere and nothing held.
beforeEach(() => {
  clearInviteToken();
  sessionStorage.clear();
  localStorage.clear();
  resetDemoStatusForTests();
});
afterEach(() => {
  vi.restoreAllMocks();
  clearInviteToken();
  sessionStorage.clear();
  localStorage.clear();
});

// ---------------------------------------------------------------------------------------------
describe('QrCode (shared with the Tailscale card)', () => {
  test('draws one dark square per module as an image named by its label, and the label is also the caption', () => {
    const { container } = render(<QrCode value="https://example.test/x" label="Scan me" />);
    expect(screen.getByRole('img', { name: 'Scan me' })).toBeInTheDocument();
    expect(container.querySelector('figcaption')).toHaveTextContent('Scan me');
    expect(container.querySelectorAll('.tailscale-qr__modules rect').length).toBeGreaterThan(50);
  });

  test('the code depends on the value (two values never draw the same code)', () => {
    const a = render(<QrCode value="https://example.test/a" label="a" />).container.querySelector('.tailscale-qr__modules').innerHTML;
    const b = render(<QrCode value="https://example.test/b" label="b" />).container.querySelector('.tailscale-qr__modules').innerHTML;
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------------------------
describe('the invite panel', () => {
  const link = () => `${window.location.origin}${window.location.pathname}#/invite/${TOKEN}`;
  const mount = (props = {}) => renderAsAdmin(<InvitePanel token={TOKEN} expiresAt={EXPIRES} firstName="Robin" {...props} />);

  test('★ shows the QR, the link, when it runs out, and both plain sentences', () => {
    mount({ onDone: () => {} });
    expect(screen.getByRole('img', { name: 'Scan to open your invite' })).toBeInTheDocument();
    expect(screen.getByText(link())).toBeInTheDocument();
    expect(screen.getByText(/^This link uses the address you are using now \(/)).toHaveTextContent(
      `(${window.location.host}). It only works where that address works, so on your home network if it is a home address.`
    );
    expect(screen.getByText(/^Anyone with this link can set the password: send it only to Robin\. It works once and expires in 7 days\.$/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Invite for Robin', level: 2 }).className).toContain('card-heading');
  });

  test('★ the QR encodes exactly the link (not the bare token, not another address)', () => {
    const { container } = mount();
    const drawn = container.querySelector('.tailscale-qr__modules').innerHTML;
    const expected = render(<QrCode value={link()} label="x" />).container.querySelector('.tailscale-qr__modules').innerHTML;
    expect(drawn).toBe(expected);
  });

  test('★★ "Valid until" is the UTC text read AS UTC and shown in the home time zone, not the device\'s', () => {
    // 22:10 UTC on 21 Nov is 09:10 on 22 Nov in Melbourne (the helper's home zone). This suite runs on Pacific/Auckland, where a
    // reading that dropped the Z (parsed the text as the device's own time) lands on a different day and hour.
    mount();
    // Worked out by Intl in the home zone (the locale is the machine's own, which is also what the screen uses), so only the
    // instant and the zone are under test here, not how a locale spells a date.
    const melbourne = new Intl.DateTimeFormat([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'Australia/Melbourne' })
      .format(new Date('2026-11-22T09:10:03+11:00'));
    expect(screen.getByText(/^Valid until /).textContent.replace(/\s/g, ' ')).toContain(`Valid until ${melbourne.replace(/\s/g, ' ')}`);
  });

  test('an expiry the panel cannot read says nothing rather than a wrong time', () => {
    mount({ expiresAt: 'not a date' });
    expect(screen.queryByText(/Valid until/)).toBeNull();
  });

  test('★ focus moves to the panel heading when it appears (the form that had it is gone), and the heading is not a tab stop', () => {
    mount();
    const heading = screen.getByRole('heading', { name: 'Invite for Robin', level: 2 });
    expect(heading).toHaveFocus();
    expect(heading).toHaveAttribute('tabindex', '-1');
  });

  test('a missing first name still reads sensibly', () => {
    mount({ firstName: '' });
    expect(screen.getByRole('heading', { name: 'Invite ready', level: 2 })).toBeInTheDocument();
    expect(screen.getByText(/send it only to the person you are inviting\./)).toBeInTheDocument();
  });

  test('★ Copy puts the link on the clipboard and announces "Copied" in a live region that was already on the page', async () => {
    const copy = vi.spyOn(copyTextModule, 'copyText').mockResolvedValue('copied');
    const { user } = mount();
    const region = screen.getByRole('status');
    expect(region, 'a live region announces a CHANGE, so it must exist before the copy').toBeEmptyDOMElement();
    await user.click(screen.getByRole('button', { name: 'Copy link' }));
    expect(copy).toHaveBeenCalledWith(link());
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Copied'));
    expect(screen.getByRole('status')).toBe(region);
    expect(region).toHaveAttribute('aria-live', 'polite');
  });

  test('when the browser will not copy, it says so and tells the admin to select the link', async () => {
    vi.spyOn(copyTextModule, 'copyText').mockResolvedValue('manual');
    const { user } = mount();
    await user.click(screen.getByRole('button', { name: 'Copy link' }));
    expect(await screen.findByText(/Select the link above and copy it by hand/)).toBeInTheDocument();
  });

  test('Revoke invite and Done are offered only when given, and call what they were given', async () => {
    const onRevoke = vi.fn().mockResolvedValue();
    const onDone = vi.fn();
    const first = mount();
    expect(screen.queryByRole('button', { name: 'Revoke invite' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Done' })).toBeNull();
    first.unmount();

    const { user } = mount({ onRevoke, onDone });
    await user.click(screen.getByRole('button', { name: 'Revoke invite' }));
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(onRevoke).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  test('★★ the token is in the page exactly once (the link), and in no storage, console, aria-label or title', async () => {
    const consoleSpies = ['log', 'info', 'warn', 'error', 'debug'].map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    vi.spyOn(copyTextModule, 'copyText').mockResolvedValue('copied');
    const { user, container } = mount({ onRevoke: async () => {}, onDone: () => {} });
    await user.click(screen.getByRole('button', { name: 'Copy link' }));

    expect(document.body.textContent.split(TOKEN).length - 1, 'the link text only: the QR is drawn, not written').toBe(1);
    for (const el of container.querySelectorAll('[aria-label], [title], [alt]')) {
      for (const attr of ['aria-label', 'title', 'alt']) expect(el.getAttribute(attr) ?? '').not.toContain(TOKEN);
    }
    expect(container.innerHTML.split(TOKEN).length - 1, 'one place in the markup').toBe(1);
    expect(JSON.stringify({ ...localStorage })).not.toContain(TOKEN);
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(TOKEN);
    for (const spy of consoleSpies) expect(JSON.stringify(spy.mock.calls)).not.toContain(TOKEN);
  });
});

// ---------------------------------------------------------------------------------------------
function mockUsersApi({ users = [NORMAL], created = CREATED, reissue = { invite: { token: TOKEN, expires_at: EXPIRES } } } = {}) {
  vi.spyOn(api, 'get').mockImplementation((path) => {
    if (path === '/auth/users') return Promise.resolve(users);
    if (path === '/auth/sessions/all') return Promise.resolve([]);
    return Promise.resolve(null);
  });
  postSpy = vi.spyOn(api, 'post').mockImplementation((path) => {
    if (path === '/auth/users') return Promise.resolve(created);
    if (/^\/auth\/users\/[^/]+\/invite$/.test(path)) return Promise.resolve(reissue);
    return Promise.resolve({});
  });
  putSpy = vi.spyOn(api, 'put').mockResolvedValue({});
  delSpy = vi.spyOn(api, 'del').mockResolvedValue({ ok: true, revoked: 1 });
}

const mountUser = (id, who = ADMIN) => renderAs(who,
  <>
    <Probe />
    <Routes>
      <Route path="/settings/users/new" element={<UserSettings />} />
      <Route path="/settings/users/:id" element={<UserSettings />} />
      <Route path="*" element={<div>elsewhere</div>} />
    </Routes>
  </>,
  { route: `/settings/users/${id}` });

const chooseInvite = (user) => user.click(screen.getByRole('button', { name: 'Send an invite' }));

describe('adding a caregiver: the choice between a password and an invite', () => {
  beforeEach(() => mockUsersApi());

  test('★ starts on "Set a password", pressed, with the password box: nothing changes for anyone who does not look', async () => {
    mountUser('new');
    await screen.findByLabelText('Username (login)');
    const group = screen.getByRole('group', { name: 'How they get a password' });
    expect(group).toHaveClass('seg-track');
    expect(within(group).getByRole('button', { name: 'Set a password' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(group).getByRole('button', { name: 'Send an invite' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByLabelText('Password')).toBeRequired();
    expect(screen.getByRole('button', { name: 'Add user' })).toBeInTheDocument();
  });

  test('the default way sends the same request as before: a password, and no `invite` key', async () => {
    const { user } = mountUser('new');
    await user.type(await screen.findByLabelText('Username (login)'), 'newnanny');
    await user.type(screen.getByLabelText('Password'), 'password123');
    await user.click(screen.getByRole('button', { name: 'Add user' }));
    await waitFor(() => expect(postSpy).toHaveBeenCalled());
    const [, body] = postSpy.mock.calls[0];
    expect(body.password).toBe('password123');
    expect(body).not.toHaveProperty('invite');
  });

  test('★ "Send an invite" hides the password box, fixes the role to caregiver with a note, and renames the button', async () => {
    const { user } = mountUser('new');
    await screen.findByLabelText('Username (login)');
    await user.selectOptions(screen.getByLabelText(/Role/), 'admin'); // chosen BEFORE switching: it must not survive into an invite
    await chooseInvite(user);

    expect(screen.queryByLabelText('Password')).toBeNull();
    const role = screen.getByLabelText(/Role/);
    expect(role).toBeDisabled();
    expect(role.value, 'an invite can only make a caregiver').toBe('caregiver');
    expect(screen.getByText('Invites are for caregivers.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send an invite' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Create and show invite' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add user' })).toBeNull();
    // names, username and photo stay
    for (const label of ['First name', 'Last name', 'Username (login)']) expect(screen.getByLabelText(label)).toBeInTheDocument();
    expect(screen.getByLabelText('Add photo')).toBeInTheDocument();
  });

  test('switching back restores the password box, and a password typed before switching does not linger', async () => {
    const { user } = mountUser('new');
    await user.type(await screen.findByLabelText('Password'), 'secret-typed-1');
    await chooseInvite(user);
    await user.click(screen.getByRole('button', { name: 'Set a password' }));
    expect(screen.getByLabelText('Password')).toBeRequired();
    expect(screen.getByLabelText('Password').value, 'a hidden field must not keep a secret').toBe('');
    expect(screen.getByLabelText(/Role/)).toBeEnabled();
  });

  test('★★ the invite request is `invite: true` with NO password key and the caregiver role, even if admin was picked first', async () => {
    const { user } = mountUser('new');
    await user.type(await screen.findByLabelText('First name'), 'Robin');
    await user.type(screen.getByLabelText('Last name'), 'Ash');
    await user.type(screen.getByLabelText('Username (login)'), 'robin');
    await user.type(screen.getByLabelText('Password'), 'typed-then-dropped');
    await user.selectOptions(screen.getByLabelText(/Role/), 'admin');
    await chooseInvite(user);
    await user.click(screen.getByRole('button', { name: 'Create and show invite' }));

    await waitFor(() => expect(postSpy).toHaveBeenCalled());
    const [path, body] = postSpy.mock.calls[0];
    expect(path).toBe('/auth/users');
    expect(body).toEqual({ username: 'robin', first_name: 'Robin', last_name: 'Ash', photo: null, role: 'caregiver', invite: true });
    expect(body).not.toHaveProperty('password');
    expect(JSON.stringify(body)).not.toContain('typed-then-dropped');
  });

  test('★ on 201 the panel replaces the form, with the link, and Done goes back to Users', async () => {
    const { user } = mountUser('new');
    await user.type(await screen.findByLabelText('First name'), 'Robin');
    await user.type(screen.getByLabelText('Username (login)'), 'robin');
    await chooseInvite(user);
    await user.click(screen.getByRole('button', { name: 'Create and show invite' }));

    expect(await screen.findByRole('heading', { name: 'Invite for Robin', level: 2 })).toBeInTheDocument();
    expect(screen.getByText(`${window.location.origin}${window.location.pathname}#/invite/${TOKEN}`)).toBeInTheDocument();
    expect(screen.queryByLabelText('Username (login)'), 'the form is gone while the panel shows').toBeNull();
    expect(at()).toContain('/settings/users/new');

    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(await screen.findByText('elsewhere')).toBeInTheDocument();
    expect(at()).toContain('/settings/users|');
  });

  test('★★ the token is held in component state ONLY: not in localStorage, sessionStorage or the saved draft', async () => {
    const { user } = mountUser('new');
    await user.type(await screen.findByLabelText('Username (login)'), 'robin');
    const draftKeys = () => Object.keys(sessionStorage).filter((k) => k.includes('user:new'));
    await waitFor(() => expect(draftKeys(), 'typing saved a draft (drafts live in sessionStorage), so the check below can fail').toHaveLength(1));
    await chooseInvite(user);
    await user.click(screen.getByRole('button', { name: 'Create and show invite' }));
    await screen.findByRole('heading', { name: /^Invite/, level: 2 });

    expect(JSON.stringify({ ...localStorage })).not.toContain(TOKEN);
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(TOKEN);
    // and the draft of the half-typed form is gone: the account exists, so a reload must not offer it back
    expect(draftKeys()).toEqual([]);
  });

  test('★ a background reload is held while the panel shows, and released on Done and on leaving', async () => {
    expect(isReloadHeld()).toBe(false);
    const { user, unmount } = mountUser('new');
    await user.type(await screen.findByLabelText('Username (login)'), 'robin');
    expect(isReloadHeld(), 'not held while the form is only being filled in').toBe(false);
    await chooseInvite(user);
    await user.click(screen.getByRole('button', { name: 'Create and show invite' }));
    await screen.findByRole('heading', { name: /^Invite/, level: 2 });
    expect(isReloadHeld()).toBe(true);
    unmount();
    expect(isReloadHeld(), 'leaving the page releases it').toBe(false);

    const second = mountUser('new');
    await second.user.type(await screen.findByLabelText('Username (login)'), 'robin');
    await chooseInvite(second.user);
    await second.user.click(screen.getByRole('button', { name: 'Create and show invite' }));
    await screen.findByRole('button', { name: 'Done' });
    expect(isReloadHeld()).toBe(true);
    await second.user.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(isReloadHeld()).toBe(false));
  });

  test('a refused invite (taken username) shows the reason, keeps the form, and shows no panel', async () => {
    postSpy.mockRejectedValue(new Error('That username is already taken'));
    const { user } = mountUser('new');
    await user.type(await screen.findByLabelText('Username (login)'), 'robin');
    await chooseInvite(user);
    await user.click(screen.getByRole('button', { name: 'Create and show invite' }));
    expect(await screen.findByText('That username is already taken')).toBeInTheDocument();
    expect(screen.getByLabelText('Username (login)').value).toBe('robin');
    expect(screen.queryByRole('button', { name: 'Done' })).toBeNull();
    expect(isReloadHeld()).toBe(false);
  });

  test('Revoke invite on the panel deletes the invite of the account just made and leaves for Users', async () => {
    const { user } = mountUser('new');
    await user.type(await screen.findByLabelText('Username (login)'), 'robin');
    await chooseInvite(user);
    await user.click(screen.getByRole('button', { name: 'Create and show invite' }));
    await user.click(await screen.findByRole('button', { name: 'Revoke invite' }));
    await waitFor(() => expect(delSpy).toHaveBeenCalledWith('/auth/users/u-new/invite'));
    expect(await screen.findByText('elsewhere')).toBeInTheDocument();
  });

  test('★ the panel (not <body>) holds focus after "Create and show invite", and a refused revoke there is announced as an alert', async () => {
    const { user } = mountUser('new');
    await user.type(await screen.findByLabelText('Username (login)'), 'robin');
    await chooseInvite(user);
    await user.click(screen.getByRole('button', { name: 'Create and show invite' }));
    expect(await screen.findByRole('heading', { name: /^Invite/, level: 2 })).toHaveFocus();

    delSpy.mockRejectedValue(new Error('User not found'));
    await user.click(screen.getByRole('button', { name: 'Revoke invite' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('User not found');
  });

  test('★ a caregiver never reaches it: the route is admin-only, so no invite control is rendered for them', async () => {
    renderAs(CAREGIVER,
      <Routes>
        <Route path="/settings/users/new" element={<AdminProtected><UserSettings /></AdminProtected>} />
        <Route path="*" element={<div>elsewhere</div>} />
      </Routes>,
      { route: '/settings/users/new' });
    expect(await screen.findByText('elsewhere')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send an invite' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
describe('an account that has not chosen a password yet (its own page)', () => {
  test('★ pending WITH a live invite: the Invite card says who we are waiting for and offers a new invite and a revoke', async () => {
    mockUsersApi({ users: [PENDING] });
    mountUser(PENDING.id);
    const heading = await screen.findByRole('heading', { name: 'Invite', level: 2 });
    expect(heading).toHaveClass('card-heading');
    expect(within(heading.closest('.card')).getByText('Waiting for Robin to choose a password')).toBeInTheDocument();
    expect(within(heading.closest('.card')).getByRole('button', { name: 'Show a new invite' })).toBeInTheDocument();
    expect(within(heading.closest('.card')).getByRole('button', { name: 'Revoke invite' })).toBeInTheDocument();
    // the password fields stay, and the page says what setting one does
    expect(screen.getByLabelText(/Reset password/)).toBeInTheDocument();
    expect(within(heading.closest('.card')).getByText(/Setting a password below makes it a normal account and ends any open invite/)).toBeInTheDocument();
  });

  test('★ pending with NO invite (null): says "No usable invite" (never "expired"), offers a new invite, nothing to revoke', async () => {
    mockUsersApi({ users: [{ ...PENDING, invite_expires_at: null }] });
    mountUser(PENDING.id);
    const heading = await screen.findByRole('heading', { name: 'Invite', level: 2 });
    const card = heading.closest('.card');
    expect(within(card).getByText('No usable invite')).toBeInTheDocument();
    expect(card.textContent.toLowerCase()).not.toContain('expired');
    expect(within(card).getByRole('button', { name: 'Show a new invite' })).toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: 'Revoke invite' })).toBeNull();
  });

  test('★ an ordinary account (password set, or a server that sends no such field) has no Invite card', async () => {
    mockUsersApi({ users: [NORMAL] });
    const first = mountUser(NORMAL.id);
    await screen.findByLabelText('First name');
    expect(screen.queryByRole('heading', { name: 'Invite' })).toBeNull();
    first.unmount();

    const { password_set: _omit, invite_expires_at: _a, invite_accepted_at: _b, ...oldServer } = NORMAL;
    mockUsersApi({ users: [oldServer] });
    mountUser(NORMAL.id);
    await screen.findByLabelText('First name');
    expect(screen.queryByRole('heading', { name: 'Invite' }), 'an absent password_set is not "pending"').toBeNull();
  });

  test('★ "Show a new invite" POSTs to that account, shows the panel with the new link, and holds the reload', async () => {
    mockUsersApi({ users: [PENDING] });
    const { user } = mountUser(PENDING.id);
    await user.click(await screen.findByRole('button', { name: 'Show a new invite' }));
    await waitFor(() => expect(postSpy).toHaveBeenCalledWith('/auth/users/u-pend/invite'));
    expect(await screen.findByRole('heading', { name: 'Invite for Robin', level: 2 })).toBeInTheDocument();
    expect(screen.getByText(new RegExp(`#/invite/${TOKEN}$`))).toBeInTheDocument();
    expect(isReloadHeld()).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(await screen.findByText('elsewhere')).toBeInTheDocument();
  });

  test('★ "Revoke invite" DELETEs that account\'s invite and the card then says "No usable invite"', async () => {
    mockUsersApi({ users: [PENDING] });
    const { user } = mountUser(PENDING.id);
    await user.click(await screen.findByRole('button', { name: 'Revoke invite' }));
    await waitFor(() => expect(delSpy).toHaveBeenCalledWith('/auth/users/u-pend/invite'));
    expect(await screen.findByText('No usable invite')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Revoke invite' })).toBeNull();
  });

  test('★ while a revoke is in flight both Invite-card buttons are disabled (no duplicate DELETE, no new invite racing it)', async () => {
    mockUsersApi({ users: [PENDING] });
    let finish;
    delSpy.mockImplementation(() => new Promise((resolve) => { finish = () => resolve({ ok: true, revoked: 1 }); }));
    const { user } = mountUser(PENDING.id);
    await user.click(await screen.findByRole('button', { name: 'Revoke invite' }));
    expect(screen.getByRole('button', { name: 'Revoke invite' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Show a new invite' })).toBeDisabled();
    await act(async () => { finish(); });
    expect(await screen.findByText('No usable invite')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show a new invite' })).toBeEnabled();
    expect(delSpy).toHaveBeenCalledTimes(1);
  });

  test('a refused new invite or revoke shows the server\'s reason', async () => {
    mockUsersApi({ users: [PENDING] });
    const { user } = mountUser(PENDING.id);
    postSpy.mockRejectedValue(new Error('Only a caregiver account that has not chosen its password yet can be sent a new invite.'));
    await user.click(await screen.findByRole('button', { name: 'Show a new invite' }));
    expect(await screen.findByText(/has not chosen its password yet can be sent a new invite/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Done' })).toBeNull();

    delSpy.mockRejectedValue(new Error('User not found'));
    await user.click(screen.getByRole('button', { name: 'Revoke invite' }));
    expect(await screen.findByText('User not found')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------------------------
describe('the Users list pills', () => {
  // 15 Nov in Melbourne, spelled by the machine's own locale (as the screen does); the 14th would mean the Z was dropped.
  const JOINED_DAY = new Intl.DateTimeFormat([], { month: 'short', day: 'numeric', timeZone: 'Australia/Melbourne' }).format(new Date('2026-11-15T09:30:00+11:00'));
  const mountList = (users) => {
    mockUsersApi({ users });
    return renderAsAdmin(<Routes><Route path="/settings/users" element={<SettingsUsers />} /></Routes>, { route: '/settings/users' });
  };
  const row = (name) => screen.getByText(name).closest('.user-row');

  test('★ pending with a live invite reads "Invite pending"; pending with none reads "No active invite"; both only for pending', async () => {
    mountList([
      PENDING,
      { ...PENDING, id: 'u-none', username: 'sam', first_name: 'Sam', last_name: 'Reed', invite_expires_at: null },
      NORMAL,
    ]);
    await screen.findByText('Robin Ash');
    expect(within(row('Robin Ash')).getByText('Invite pending')).toBeInTheDocument();
    expect(within(row('Sam Reed')).getByText('No active invite')).toBeInTheDocument();
    expect(within(row('Nanny McPhee')).queryByText(/Invite pending|No active invite|Joined/)).toBeNull();
    expect(screen.queryByText(/expired/i), 'null means none OR revoked OR expired: the screen claims only what it knows').toBeNull();
  });

  test('★ after the invite is used, "Joined <date>" shows (home time zone, UTC text read as UTC)', async () => {
    // 22:30 UTC on 14 Nov is 09:30 on 15 Nov in Melbourne; a reading without the Z (device = Auckland) lands on the 14th.
    mountList([{ ...NORMAL, invite_accepted_at: '2026-11-14 22:30:00' }]);
    await screen.findByText('Nanny McPhee');
    expect(within(row('Nanny McPhee')).getByText(`Joined ${JOINED_DAY}`)).toBeInTheDocument();
  });

  test('a server older than the feature (no such fields) shows no pill at all', async () => {
    const { password_set: _a, invite_expires_at: _b, invite_accepted_at: _c, ...old } = NORMAL;
    mountList([old]);
    await screen.findByText('Nanny McPhee');
    expect(document.querySelector('.status-badge')).toBeNull();
  });

  test('the three pills use the existing status-badge colours (no new ones)', async () => {
    mountList([PENDING, { ...PENDING, id: 'u-none', username: 'sam', first_name: 'Sam', last_name: 'Reed', invite_expires_at: null }, { ...NORMAL, invite_accepted_at: '2026-11-14 22:30:00' }]);
    await screen.findByText('Robin Ash');
    expect(screen.getByText('Invite pending')).toHaveClass('status-badge', 'status-badge--highlight');
    expect(screen.getByText('No active invite')).toHaveClass('status-badge', 'status-badge--off');
    expect(screen.getByText(`Joined ${JOINED_DAY}`)).toHaveClass('status-badge', 'status-badge--ok');
  });
});

// ---------------------------------------------------------------------------------------------
describe('the setup guide: adding a caregiver', () => {
  beforeEach(() => {
    vi.spyOn(api, 'get').mockResolvedValue({ demo: false });
    postSpy = vi.spyOn(api, 'post').mockResolvedValue(CREATED);
  });

  test('★ the same two-way choice; "Send an invite" hides the password and posts `invite: true` with no password', async () => {
    const onAdded = vi.fn();
    const { user } = renderAs(ADMIN, <SetupCaregivers onAdded={onAdded} />);
    const group = await screen.findByRole('group', { name: 'How they get a password' });
    expect(within(group).getByRole('button', { name: 'Set a password' })).toHaveAttribute('aria-pressed', 'true');
    await user.type(screen.getByLabelText('Password'), 'typed-then-dropped');
    await user.click(within(group).getByRole('button', { name: 'Send an invite' }));
    expect(screen.queryByLabelText('Password')).toBeNull();

    await user.type(screen.getByLabelText('First name'), 'Robin');
    await user.type(screen.getByLabelText('Username'), 'robin');
    await user.click(screen.getByRole('button', { name: 'Create and show invite' }));
    await waitFor(() => expect(postSpy).toHaveBeenCalledTimes(1));
    expect(postSpy.mock.calls[0][1]).toEqual({ username: 'robin', role: 'caregiver', first_name: 'Robin', last_name: '', invite: true });
    expect(onAdded).toHaveBeenCalledWith(1);
  });

  test('★ the panel replaces the form, holds the reload, and Done brings the form back with the person listed', async () => {
    const { user } = renderAs(ADMIN, <SetupCaregivers />);
    await user.click(await screen.findByRole('button', { name: 'Send an invite' }));
    await user.type(screen.getByLabelText('First name'), 'Robin');
    await user.type(screen.getByLabelText('Username'), 'robin');
    await user.click(screen.getByRole('button', { name: 'Create and show invite' }));

    expect(await screen.findByRole('heading', { name: 'Invite for Robin', level: 2 })).toBeInTheDocument();
    expect(screen.getByText(new RegExp(`#/invite/${TOKEN}$`))).toBeInTheDocument();
    expect(screen.queryByLabelText('Username')).toBeNull();
    expect(isReloadHeld()).toBe(true);
    expect(screen.queryByRole('button', { name: 'Revoke invite' }), 'revoking lives in Settings -> Users, not the guide').toBeNull();
    expect(JSON.stringify({ ...localStorage })).not.toContain(TOKEN);
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(TOKEN);

    await user.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(isReloadHeld()).toBe(false));
    expect(screen.getByLabelText('Username').value).toBe('');
    expect(screen.getByLabelText('Caregivers you added')).toHaveTextContent('Robin');
  });

  test('★ focus goes to the panel when it appears and back to the first field of the form on Done (never left on <body>)', async () => {
    const { user } = renderAs(ADMIN, <SetupCaregivers />);
    await user.click(await screen.findByRole('button', { name: 'Send an invite' }));
    expect(screen.getByLabelText('First name'), 'opening the guide must not steal focus').not.toHaveFocus();
    await user.type(screen.getByLabelText('Username'), 'robin');
    await user.click(screen.getByRole('button', { name: 'Create and show invite' }));
    expect(await screen.findByRole('heading', { name: /^Invite/, level: 2 })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.getByLabelText('First name')).toHaveFocus());
  });

  test('a refused invite shows the reason and no panel', async () => {
    postSpy.mockRejectedValue(new Error('That username is already taken'));
    const { user } = renderAs(ADMIN, <SetupCaregivers />);
    await user.click(await screen.findByRole('button', { name: 'Send an invite' }));
    await user.type(screen.getByLabelText('Username'), 'robin');
    await user.click(screen.getByRole('button', { name: 'Create and show invite' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That username is already taken');
    expect(screen.queryByRole('button', { name: 'Done' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
describe('the public invite page (AcceptInvite)', () => {
  const FOUND = { first_name: 'Robin', username: 'robin', app_name: 'Nightlight' };
  const SESSION = { token: 'session-jwt', user: { id: 'u-new', username: 'robin', role: 'caregiver', first_name: 'Robin' } };
  const refused = (status, message) => Object.assign(new Error(message), { status });

  // `redeem` / `check` are the answers (a value, an Error to reject with, or a promise).
  function mockServer({ check = FOUND, redeem = SESSION } = {}) {
    postSpy = vi.spyOn(api, 'post').mockImplementation((path) => {
      const answer = path === '/auth/invite/check' ? check : path === '/auth/invite/redeem' ? redeem : {};
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    });
  }
  const calls = (path) => postSpy.mock.calls.filter(([p]) => p === path);

  const page = (user = null, route = `/invite/${TOKEN}`, { strict = false } = {}) => {
    const ui = (
      <>
        <Probe />
        <Routes>
          <Route path="/invite/:token?" element={<AcceptInvite />} />
          <Route path="/login" element={<div>the sign-in page</div>} />
          <Route path="/" element={<div>home</div>} />
        </Routes>
      </>
    );
    return renderAs(user, strict ? <StrictMode>{ui}</StrictMode> : ui, { route });
  };

  const fillAndSubmit = async (user, password = 'chosen-password', confirm = password) => {
    await user.type(await screen.findByLabelText('Choose a password'), password);
    await user.type(screen.getByLabelText('Confirm password'), confirm);
    await user.click(screen.getByRole('button', { name: 'Set password and sign in' }));
  };

  test('shows a loading line while the server is asked', async () => {
    postSpy = vi.spyOn(api, 'post').mockImplementation(() => new Promise(() => {}));
    page();
    expect(await screen.findByText('Checking your invite…')).toBeInTheDocument();
  });

  test('★ a valid invite: welcome by first name, the username as text AND in a hidden username field, new-password fields', async () => {
    mockServer();
    const { container } = page();
    expect(await screen.findByText(/Welcome, Robin\./)).toHaveTextContent('Welcome, Robin. Choose a password to finish setting up your account.');
    expect(screen.getByText('robin', { selector: 'strong' })).toBeInTheDocument();
    const hidden = container.querySelector('input[autocomplete="username"]');
    expect(hidden.value, 'so a password manager saves the username WITH the password').toBe('robin');
    expect(hidden).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByLabelText('Choose a password')).toHaveAttribute('autocomplete', 'new-password');
    expect(screen.getByLabelText('Confirm password')).toHaveAttribute('autocomplete', 'new-password');
    expect(screen.getByLabelText('Choose a password')).toHaveAttribute('minlength', '8');
  });

  test('★★ the token leaves the address at once (replace, not push), is kept in sessionStorage ONLY, and the check is sent once with it in the body', async () => {
    mockServer();
    page();
    await screen.findByText(/Welcome, Robin/);
    expect(at(), 'the address no longer carries the token').toBe('/invite|REPLACE');
    expect(document.body.innerHTML).not.toContain(TOKEN);
    expect(sessionStorage.getItem('nightlight_invite_token')).toBe(TOKEN);
    expect(JSON.stringify({ ...localStorage }), 'localStorage is where the sign-in lives').not.toContain(TOKEN);
    expect(calls('/auth/invite/check')).toEqual([['/auth/invite/check', { token: TOKEN }]]);
  });

  test('★★ the check runs EXACTLY ONCE even under React StrictMode and across re-renders (the server counts failures)', async () => {
    mockServer();
    const { rerenderWith } = page(null, `/invite/${TOKEN}`, { strict: true });
    await screen.findByText(/Welcome, Robin/);
    rerenderWith({});
    rerenderWith({ settings: { app_name: 'Other' } });
    expect(calls('/auth/invite/check')).toHaveLength(1);
  });

  test('★ it carries on from sessionStorage when the address has no token (a reload of #/invite)', async () => {
    stashInviteToken(TOKEN);
    mockServer();
    page(null, '/invite');
    await screen.findByText(/Welcome, Robin/);
    expect(calls('/auth/invite/check')[0][1]).toEqual({ token: TOKEN });
  });

  test('★ with no token anywhere it says the invite is not valid and asks nothing', async () => {
    mockServer();
    page(null, '/invite');
    expect(await screen.findByRole('alert')).toHaveTextContent(/isn.t valid any more/);
    expect(calls('/auth/invite/check')).toHaveLength(0);
  });

  test('★ still works when sessionStorage refuses (a private window): the token is kept in memory for this page', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    mockServer();
    page();
    await screen.findByText(/Welcome, Robin/);
    expect(readInviteToken()).toBe(TOKEN);
  });

  test('★ validation: under 8 characters and a mismatch are said inline, and nothing is sent', async () => {
    mockServer();
    const { user } = page();
    await user.type(await screen.findByLabelText('Choose a password'), 'short');
    expect(await screen.findByRole('alert')).toHaveTextContent('Use at least 8 characters.');
    await user.clear(screen.getByLabelText('Choose a password'));
    await user.type(screen.getByLabelText('Choose a password'), 'long-enough-1');
    await user.type(screen.getByLabelText('Confirm password'), 'long-enough-2');
    expect(await screen.findByRole('alert')).toHaveTextContent('The two passwords do not match.');
    await user.click(screen.getByRole('button', { name: 'Set password and sign in' }));
    expect(calls('/auth/invite/redeem')).toHaveLength(0);
  });

  test('submitting an empty form shows the messages instead of nothing happening', async () => {
    mockServer();
    const { user } = page();
    await user.click(await screen.findByRole('button', { name: 'Set password and sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Use at least 8 characters.');
    expect(calls('/auth/invite/redeem')).toHaveLength(0);
  });

  test('★ the button is disabled while the request is pending and a second press sends nothing', async () => {
    let finish;
    mockServer({ redeem: new Promise((resolve) => { finish = () => resolve(SESSION); }) });
    // mockServer treats a promise as a value, so the redeem here is the pending promise itself
    const { user, auth } = page();
    await fillAndSubmit(user);
    const button = screen.getByRole('button', { name: 'Please wait…' });
    expect(button).toBeDisabled();
    await user.click(button);
    // Enter in a field submits the form without a click on the (disabled) button, so the handler guards itself too.
    fireEvent.submit(button.closest('form'));
    expect(calls('/auth/invite/redeem')).toHaveLength(1);
    await act(async () => { finish(); });
    await waitFor(() => expect(auth.login).toHaveBeenCalled());
  });

  test('★ the route is only replaced AFTER login() has finished (navigating first would bounce a signed-out shell to the sign-in page)', async () => {
    mockServer();
    const { user, auth } = page();
    let finishLogin;
    auth.login.mockImplementation(() => new Promise((resolve) => { finishLogin = resolve; }));
    await fillAndSubmit(user);
    await waitFor(() => expect(auth.login).toHaveBeenCalled());
    expect(at(), 'still on the invite page while the media token is being fetched').toBe('/invite|REPLACE');
    expect(screen.getByText('Signing you in…')).toBeInTheDocument();
    await act(async () => { finishLogin(); });
    expect(await screen.findByText('home')).toBeInTheDocument();
  });

  test('★★ success: sends token + password, signs in with the SAME login() the sign-in page uses, replaces the route, clears the stored token', async () => {
    mockServer();
    const { user, auth } = page();
    await fillAndSubmit(user, 'chosen-password');
    await waitFor(() => expect(auth.login).toHaveBeenCalledWith('session-jwt', SESSION.user));
    expect(calls('/auth/invite/redeem')).toEqual([['/auth/invite/redeem', { token: TOKEN, password: 'chosen-password' }]]);
    expect(await screen.findByText('home')).toBeInTheDocument();
    expect(at()).toBe('/|REPLACE');
    expect(sessionStorage.getItem('nightlight_invite_token')).toBeNull();
    expect(readInviteToken()).toBeNull();
    expect(isReloadHeld()).toBe(false);
  });

  test('★ a 404 on the check: "isn\'t valid any more", who to tell, a link to sign in, and the stored token is dropped', async () => {
    mockServer({ check: refused(404, 'invite_invalid') });
    const { user } = page();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("This invite isn’t valid any more. If you never used this link, tell the person who invited you. If you just chose a password, try signing in with it.");
    expect(screen.queryByLabelText('Choose a password')).toBeNull();
    expect(sessionStorage.getItem('nightlight_invite_token')).toBeNull();
    await user.click(screen.getByRole('link', { name: 'Go to sign in' }));
    expect(await screen.findByText('the sign-in page')).toBeInTheDocument();
  });

  test('★ a 404 when choosing the password (used or revoked meanwhile) shows the same page', async () => {
    mockServer({ redeem: refused(404, 'invite_invalid') });
    const { user, auth } = page();
    await fillAndSubmit(user);
    expect(await screen.findByRole('alert')).toHaveTextContent(/isn.t valid any more/);
    expect(auth.login).not.toHaveBeenCalled();
  });

  test('★ a 409 (another request for this invite is being processed) says to try signing in, keeps the form, and re-enables the button', async () => {
    mockServer({ redeem: refused(409, 'invite_in_progress') });
    const { user } = page();
    await fillAndSubmit(user);
    expect(await screen.findByRole('alert')).toHaveTextContent('Just a moment. If you just chose a password, try signing in with it.');
    expect(screen.getByRole('link', { name: 'Go to sign in' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Set password and sign in' })).toBeEnabled();
    expect(screen.getByLabelText('Choose a password')).toBeInTheDocument();
  });

  test('★ a 429 says to wait a few minutes (on the check and on the submit)', async () => {
    mockServer({ check: refused(429, 'Too many attempts - please wait a few minutes and try again.') });
    const first = page();
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many attempts. Please wait a few minutes and try again.');
    first.unmount();

    mockServer({ redeem: refused(429, 'Too many attempts - please wait a few minutes and try again.') });
    const { user } = page();
    await fillAndSubmit(user);
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many attempts. Please wait a few minutes and try again.');
    expect(screen.getByRole('button', { name: 'Set password and sign in' })).toBeEnabled();
  });

  test('any other refusal shows the server\'s own message (a password with characters that cannot be used)', async () => {
    mockServer({ redeem: refused(400, 'That password contains characters that cannot be used') });
    const { user } = page();
    await fillAndSubmit(user);
    expect(await screen.findByRole('alert')).toHaveTextContent('That password contains characters that cannot be used');
  });

  test('a check that fails some other way (server down) shows the message, does not retry, and offers sign-in', async () => {
    mockServer({ check: new Error('Request failed (500)') });
    page();
    expect(await screen.findByRole('alert')).toHaveTextContent('Request failed (500)');
    expect(calls('/auth/invite/check')).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'Go to sign in' })).toBeInTheDocument();
  });

  test('★★ someone ALREADY signed in is asked, never silently replaced (admin and caregiver alike); nothing is checked or redeemed', async () => {
    await forEachRole(async (name, who) => {
      mockServer();
      const view = page(who);
      expect(await screen.findByText(new RegExp(`You are already signed in as ${who.first_name}\\. Opening an invite replaces nothing: sign out first if this link is for someone else\\.`))).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Go to Nightlight' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
      expect(screen.queryByLabelText('Choose a password')).toBeNull();
      expect(calls('/auth/invite/check'), `${name}: no check while signed in`).toHaveLength(0);
      expect(view.auth.login).not.toHaveBeenCalled();
      view.unmount();
    });
  });

  test('★ "Sign out" signs out, and THEN the invite is checked (once) and the form appears', async () => {
    mockServer();
    const { user, auth, rerenderWith } = page(CAREGIVER);
    await user.click(await screen.findByRole('button', { name: 'Sign out' }));
    expect(auth.logout).toHaveBeenCalledTimes(1);
    expect(calls('/auth/invite/check')).toHaveLength(0);
    rerenderWith({ user: null });
    expect(await screen.findByText(/Welcome, Robin/)).toBeInTheDocument();
    expect(calls('/auth/invite/check')).toHaveLength(1);
  });

  test('"Go to Nightlight" leaves by replacing the route and drops the stored token', async () => {
    mockServer();
    const { user } = page(ADMIN);
    await user.click(await screen.findByRole('button', { name: 'Go to Nightlight' }));
    expect(await screen.findByText('home')).toBeInTheDocument();
    expect(at()).toBe('/|REPLACE');
    expect(readInviteToken()).toBeNull();
  });

  test('★★ the password is set but the automatic sign-in then fails: says so, offers sign-in, shows no form and never redeems twice', async () => {
    mockServer();
    const { user, auth } = page();
    auth.login.mockRejectedValue(new Error('Request failed (500)'));
    await fillAndSubmit(user, 'chosen-password');
    expect(await screen.findByRole('alert')).toHaveTextContent('Your password is set. Sign in with your username and the password you just chose.');
    expect(screen.queryByLabelText('Choose a password'), 'the invite is spent: a form would only retry a redeem that now says invalid').toBeNull();
    expect(screen.queryByRole('button', { name: 'Set password and sign in' })).toBeNull();
    expect(calls('/auth/invite/redeem')).toHaveLength(1);
    expect(readInviteToken(), 'the spent token is gone from storage').toBeNull();
    await user.click(screen.getByRole('link', { name: 'Go to sign in' }));
    expect(await screen.findByText('the sign-in page')).toBeInTheDocument();
  });

  // The route is `/invite/:token?`, so ONE AcceptInvite stays mounted while the address goes A -> (scrubbed) -> B (review of #1096).
  describe('a different invite opened in the same tab', () => {
    const TOKEN_B = 'b-t0k3n-'.padEnd(43, 'Wy9_');
    const GoTo = ({ to }) => { const navigate = useNavigate(); return <button type="button" onClick={() => navigate(to)}>open {to.slice(-4)}</button>; };
    const byToken = {
      [TOKEN]: { first_name: 'Robin', username: 'robin', app_name: 'Nightlight' },
      [TOKEN_B]: { first_name: 'Blake', username: 'blake', app_name: 'Nightlight' },
    };
    const ui = (
      <>
        <Probe />
        <GoTo to={`/invite/${TOKEN_B}`} />
        <Routes>
          <Route path="/invite/:token?" element={<AcceptInvite />} />
          <Route path="/" element={<div>home</div>} />
        </Routes>
      </>
    );
    const serve = (check) => {
      postSpy = vi.spyOn(api, 'post').mockImplementation((path, body) => {
        if (path === '/auth/invite/check') return check ? check(body.token) : Promise.resolve(byToken[body.token]);
        return Promise.resolve(SESSION);
      });
    };

    test('★★ B is checked and stashed, the form is B\'s, a submit redeems B (never A), and A is gone from storage', async () => {
      serve();
      const { user, auth } = renderAs(null, ui, { route: `/invite/${TOKEN}` });
      expect(await screen.findByText(/Welcome, Robin/)).toBeInTheDocument();
      await user.type(screen.getByLabelText('Choose a password'), 'typed-for-a');
      expect(at()).toBe('/invite|REPLACE');

      await user.click(screen.getByRole('button', { name: /^open / }));
      expect(await screen.findByText(/Welcome, Blake/)).toBeInTheDocument();
      expect(screen.queryByText(/Welcome, Robin/)).toBeNull();
      expect(at(), 'B left the address too').toBe('/invite|REPLACE');
      expect(calls('/auth/invite/check').map(([, body]) => body.token), 'one check each, A then B, none repeated by the scrub').toEqual([TOKEN, TOKEN_B]);
      expect(sessionStorage.getItem('nightlight_invite_token')).toBe(TOKEN_B);
      expect(JSON.stringify({ ...sessionStorage })).not.toContain(TOKEN);
      expect(screen.getByLabelText('Choose a password').value, 'what was typed for A is not carried into B').toBe('');

      await user.type(screen.getByLabelText('Choose a password'), 'chosen-for-b');
      await user.type(screen.getByLabelText('Confirm password'), 'chosen-for-b');
      await user.click(screen.getByRole('button', { name: 'Set password and sign in' }));
      await waitFor(() => expect(auth.login).toHaveBeenCalled());
      expect(calls('/auth/invite/redeem')).toEqual([['/auth/invite/redeem', { token: TOKEN_B, password: 'chosen-for-b' }]]);
    });

    test('★ a slow answer for A that arrives after B opened does not touch B (a 404 must not clear B\'s stored token)', async () => {
      let rejectA;
      serve((token) => (token === TOKEN ? new Promise((_, reject) => { rejectA = reject; }) : Promise.resolve(byToken[token])));
      const { user } = renderAs(null, ui, { route: `/invite/${TOKEN}` });
      await screen.findByText('Checking your invite…');
      await user.click(screen.getByRole('button', { name: /^open / }));
      expect(await screen.findByText(/Welcome, Blake/)).toBeInTheDocument();

      await act(async () => { rejectA(Object.assign(new Error('invite_invalid'), { status: 404 })); });
      expect(screen.getByText(/Welcome, Blake/), 'still B\'s form, not an "invalid" page').toBeInTheDocument();
      expect(sessionStorage.getItem('nightlight_invite_token')).toBe(TOKEN_B);
    });
  });

  test('★ a background reload is held while the page is open (checking, form, invalid and signed-in views) and released on leaving', async () => {
    mockServer();
    const form = page();
    await screen.findByText(/Welcome, Robin/);
    expect(isReloadHeld()).toBe(true);
    form.unmount();
    expect(isReloadHeld()).toBe(false);

    mockServer({ check: refused(404, 'invite_invalid') });
    const invalid = page();
    await screen.findByRole('alert');
    expect(isReloadHeld()).toBe(true);
    invalid.unmount();

    const signedIn = page(ADMIN);
    await screen.findByRole('button', { name: 'Sign out' });
    expect(isReloadHeld()).toBe(true);
    signedIn.unmount();
    expect(isReloadHeld()).toBe(false);
  });

  test('★★ the token appears nowhere on the page, in any console, or in an aria-label, in any state', async () => {
    const consoleSpies = ['log', 'info', 'warn', 'error', 'debug'].map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    mockServer({ redeem: refused(409, 'invite_in_progress') });
    const { user, container } = page();
    await fillAndSubmit(user);
    await screen.findByRole('alert');
    expect(container.innerHTML).not.toContain(TOKEN);
    expect(document.title).not.toContain(TOKEN);
    for (const spy of consoleSpies) expect(JSON.stringify(spy.mock.calls)).not.toContain(TOKEN);
  });
});

// ---------------------------------------------------------------------------------------------
describe('lib/inviteToken: taking the token out of the address before React starts', () => {
  afterEach(() => { window.history.replaceState(null, '', '#'); });

  test('★ moves `#/invite/<token>` to sessionStorage and rewrites the address to `#/invite` WITHOUT adding a history entry', () => {
    window.history.replaceState(null, '', `#/invite/${TOKEN}`);
    const before = window.history.length;
    expect(captureInviteTokenFromLocation()).toBe(true);
    expect(window.location.hash).toBe('#/invite');
    expect(window.history.length, 'replace, not push').toBe(before);
    expect(readInviteToken()).toBe(TOKEN);
    expect(sessionStorage.getItem('nightlight_invite_token')).toBe(TOKEN);
    expect(JSON.stringify({ ...localStorage })).not.toContain(TOKEN);
  });

  test('★ a valid token with a percent-encoded character (%74 for "t") is decoded, stashed DECODED and scrubbed from the address', () => {
    window.history.replaceState(null, '', `#/invite/${TOKEN.replace('t', '%74')}`);
    expect(window.location.hash).toContain('%74');
    expect(captureInviteTokenFromLocation()).toBe(true);
    expect(window.location.hash).toBe('#/invite');
    expect(readInviteToken()).toBe(TOKEN);
  });

  test('★ a malformed escape does not throw (this runs before React) and is left alone; a decoded slash or space is not a token', () => {
    for (const segment of ['abc%zz', 'abc%', '%E0%A4%A', 'abc%2Fdef', 'abc%20def', 'abc%00', 'a'.repeat(257), `${'%41'.repeat(257)}`]) {
      window.history.replaceState(null, '', `#/invite/${segment}`);
      const before = window.location.hash;
      expect(() => captureInviteTokenFromLocation(), segment).not.toThrow();
      expect(captureInviteTokenFromLocation(), segment).toBe(false);
      expect(window.location.hash).toBe(before);
    }
    expect(readInviteToken()).toBeNull();
  });

  test('anything else in the address is left alone and nothing is stashed', () => {
    for (const hash of ['', '#/', '#/login', '#/invite', '#/invite/', '#/settings/invite/abc', '#/invite/abc/def']) {
      window.history.replaceState(null, '', hash || '#');
      const before = window.location.hash;
      expect(captureInviteTokenFromLocation(), hash).toBe(false);
      expect(window.location.hash).toBe(before);
    }
    expect(readInviteToken()).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
describe('the route in the app shell', () => {
  beforeEach(() => {
    vi.spyOn(nativeBridge, 'isNativeApp').mockReturnValue(false);
    vi.spyOn(nativeBridge, 'hasActiveBackgroundAudio').mockReturnValue(false);
    vi.spyOn(push, 'initPushNotifications').mockResolvedValue(undefined);
    vi.spyOn(nativeBridge, 'syncTailscaleEndpoint').mockResolvedValue(null);
  });
  afterEach(() => { setToken(null); window.location.hash = ''; });

  test('★★ a signed-out visitor on #/invite/<token> gets the invite page (NOT the sign-in form), and the token leaves the address', async () => {
    vi.spyOn(api, 'get').mockImplementation((p) => (String(p).startsWith('/settings') ? Promise.resolve({ app_name: 'Nightlight', timezone: 'UTC' }) : Promise.resolve({ needsSetup: false, demo: false })));
    postSpy = vi.spyOn(api, 'post').mockResolvedValue({ first_name: 'Robin', username: 'robin', app_name: 'Nightlight' });
    window.location.hash = `#/invite/${TOKEN}`;
    render(<HashRouter><App /></HashRouter>);
    expect(await screen.findByText(/Welcome, Robin/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Username')).toBeNull();
    expect(window.location.hash).toBe('#/invite');
    expect(postSpy).toHaveBeenCalledWith('/auth/invite/check', { token: TOKEN });
  });
});
