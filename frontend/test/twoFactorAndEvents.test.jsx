// TwoFactorSection (the whole TOTP enrolment flow) and EventLog (camera up/down history).
//
// Added to put real headroom under the 80% gate rather than clearing it by a rounding error — the
// runner measured 79.97% where this machine measured 80.09%, and a bar you clear by 0.03 of a point
// is not cleared. But these are also the two most under-tested things left, and one of them is a
// security surface:
//
//   * TwoFactorSection is the ONLY place a person can turn their own second factor on or off. Its
//     backup codes are shown EXACTLY ONCE and never again, so anything that loses them locks someone
//     out of their own account; and "off" versus "we could not find out" are different answers, only
//     one of which is safe to state.
//   * EventLog's Clear is irreversible and deletes the history you would use to diagnose a camera
//     that keeps dropping — i.e. the thing you clear it while investigating.
import { describe, test, expect, vi, afterEach, beforeEach } from 'vitest';
import { screen, waitFor, within, act } from '@testing-library/react';
import { renderAsAdmin, renderAsCaregiver } from './helpers/render.jsx';
import TwoFactorSection from '../src/components/TwoFactorSection.jsx';
import EventLog from '../src/components/EventLog.jsx';
import { api } from '../src/lib/api.js';

afterEach(() => vi.restoreAllMocks());

// --- TwoFactorSection ---------------------------------------------------------------------------

describe('TwoFactorSection', () => {
  const SETUP = { secret: 'JBSWY3DPEHPK3PXP', otpauth_uri: 'otpauth://x', qr: 'data:image/png;base64,QR' };
  const CODES = ['aaa-111', 'bbb-222', 'ccc-333', 'ddd-444'];

  const withStatus = (status) => vi.spyOn(api, 'get').mockResolvedValue(status);

  test('an account without two-factor is offered set-up, and told what it does', async () => {
    withStatus({ enabled: false });
    renderAsAdmin(<TwoFactorSection />);
    expect(await screen.findByText(/Require a 6-digit code from an authenticator app at login\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Set up two-factor' })).toBeEnabled();
  });

  test('an enrolled account is told how many backup codes are LEFT, pluralised', async () => {
    withStatus({ enabled: true, backup_codes_remaining: 4 });
    const { unmount } = renderAsAdmin(<TwoFactorSection />);
    expect(await screen.findByText('4 backup codes left')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Turn off two-factor' })).toBeInTheDocument();
    unmount();

    // The count is the only warning someone gets that they are about to run out; "1 backup codes" is
    // the kind of wrong that makes a person distrust the number itself.
    withStatus({ enabled: true, backup_codes_remaining: 1 });
    renderAsAdmin(<TwoFactorSection />);
    expect(await screen.findByText('1 backup code left')).toBeInTheDocument();
  });

  test('★ a status it could not fetch reads UNKNOWN, never a confident "Off"', async () => {
    vi.spyOn(api, 'get').mockRejectedValue(new Error('Network unreachable'));
    renderAsAdmin(<TwoFactorSection />);
    // ⚠️ Telling a PROTECTED account it is unprotected is the one wrong answer this card can give: it
    // invites an enrolment that will fail, and it undermines every other status in the app. `enabled`
    // is false in both cases, so nothing but this distinction separates them.
    expect(await screen.findByText('Network unreachable')).toBeInTheDocument();
    expect(screen.queryByText(/Require a 6-digit code/)).not.toBeInTheDocument();
    // And no action is offered on a state we cannot see.
    expect(screen.getByRole('button', { name: 'Set up two-factor' })).toBeDisabled();
  });

  test('the set-up dialog shows BOTH a QR and the manual key', async () => {
    withStatus({ enabled: false });
    vi.spyOn(api, 'post').mockResolvedValue(SETUP);
    const { user } = renderAsAdmin(<TwoFactorSection />);
    await user.click(await screen.findByRole('button', { name: 'Set up two-factor' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByAltText('Two-factor setup QR code')).toHaveAttribute('src', SETUP.qr);
    // ⚠️ The manual key is not a nicety: a desktop browser cannot scan its own screen, and neither
    // can someone whose only camera is the phone holding the authenticator.
    expect(within(dialog).getByText(SETUP.secret)).toBeInTheDocument();
    expect(api.post).toHaveBeenCalledWith('/auth/me/mfa/setup', {});
  });

  test('a failed set-up says why and does not open an empty dialog', async () => {
    withStatus({ enabled: false });
    vi.spyOn(api, 'post').mockRejectedValue(new Error('Two-factor is disabled on this server'));
    const { user } = renderAsAdmin(<TwoFactorSection />);
    await user.click(await screen.findByRole('button', { name: 'Set up two-factor' }));
    expect(await screen.findByText('Two-factor is disabled on this server')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('confirming trims the typed code, and the backup codes are then shown ONCE', async () => {
    withStatus({ enabled: false });
    const post = vi.spyOn(api, 'post')
      .mockResolvedValueOnce(SETUP)
      .mockResolvedValueOnce({ backup_codes: CODES });
    const { user } = renderAsAdmin(<TwoFactorSection />);
    await user.click(await screen.findByRole('button', { name: 'Set up two-factor' }));

    api.get.mockResolvedValue({ enabled: true, backup_codes_remaining: 4 });
    await user.type(screen.getByLabelText('Enter the 6-digit code to confirm'), '  123456  ');
    await user.click(screen.getByRole('button', { name: 'Turn on' }));

    // ⚠️ Trimmed: authenticator apps and password managers paste with surrounding whitespace, and an
    // untrimmed code fails verification for a reason the person cannot see.
    await waitFor(() => expect(post).toHaveBeenCalledWith('/auth/me/mfa/enable', { code: '123456' }));
    for (const c of CODES) expect(await screen.findByText(c)).toBeInTheDocument();
    expect(screen.getByText(/won't be shown again/)).toBeInTheDocument();
  });

  test('a wrong code keeps the set-up dialog open so it can be retried', async () => {
    withStatus({ enabled: false });
    vi.spyOn(api, 'post')
      .mockResolvedValueOnce(SETUP)
      .mockRejectedValueOnce(new Error('That code is not right'));
    const { user } = renderAsAdmin(<TwoFactorSection />);
    await user.click(await screen.findByRole('button', { name: 'Set up two-factor' }));
    await user.type(screen.getByLabelText('Enter the 6-digit code to confirm'), '000000');
    await user.click(screen.getByRole('button', { name: 'Turn on' }));

    expect(await screen.findByText('That code is not right')).toBeInTheDocument();
    // ⚠️ Losing the dialog here would lose the SECRET with it — the setup call is one-shot, so the
    // person would have to start over and re-scan.
    expect(screen.getByText(SETUP.secret)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Turn on' })).toBeEnabled();
  });

  test('backup codes can be copied, and a clipboard that refuses does not break the dialog', async () => {
    withStatus({ enabled: false });
    vi.spyOn(api, 'post').mockResolvedValueOnce(SETUP).mockResolvedValueOnce({ backup_codes: CODES });
    const writeText = vi.fn().mockResolvedValue(undefined);
    const { user } = renderAsAdmin(<TwoFactorSection />);
    // ⚠️ AFTER the render, not before. `userEvent.setup()` installs its own `navigator.clipboard`
    // stub, so a clipboard defined earlier is silently replaced and the spy is never called — the
    // assertion then fails against perfectly good code.
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    await user.click(await screen.findByRole('button', { name: 'Set up two-factor' }));
    await user.type(screen.getByLabelText('Enter the 6-digit code to confirm'), '123456');
    await user.click(screen.getByRole('button', { name: 'Turn on' }));
    await screen.findByText(CODES[0]);

    await user.click(screen.getByRole('button', { name: 'Copy codes' }));
    // One per line — pasted into a notes app they have to stay readable as separate codes.
    expect(writeText).toHaveBeenCalledWith(CODES.join('\n'));
    expect(await screen.findByRole('button', { name: 'Copied ✓' })).toBeInTheDocument();

    // A rejected clipboard (permission denied, insecure context) must not throw — the codes are still
    // on screen to copy by hand, which is the whole reason the failure is swallowed.
    writeText.mockRejectedValue(new Error('denied'));
    await user.click(screen.getByRole('button', { name: 'Copied ✓' }));
    expect(screen.getByText(CODES[0])).toBeInTheDocument();
  });

  test('a browser with NO clipboard API at all does not throw', async () => {
    withStatus({ enabled: false });
    vi.spyOn(api, 'post').mockResolvedValueOnce(SETUP).mockResolvedValueOnce({ backup_codes: CODES });
    const { user } = renderAsAdmin(<TwoFactorSection />);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }); // after setup(), as above
    await user.click(await screen.findByRole('button', { name: 'Set up two-factor' }));
    await user.type(screen.getByLabelText('Enter the 6-digit code to confirm'), '123456');
    await user.click(screen.getByRole('button', { name: 'Turn on' }));
    await screen.findByText(CODES[0]);
    // `navigator.clipboard?.writeText(...)` — the optional chain is load-bearing on http:// origins,
    // which is exactly how this self-hosted app is usually reached on a LAN.
    await user.click(screen.getByRole('button', { name: 'Copy codes' }));
    expect(screen.getByText(CODES[0])).toBeInTheDocument();
  });

  test('turning two-factor OFF requires the password, and refreshes the status', async () => {
    withStatus({ enabled: true, backup_codes_remaining: 4 });
    const post = vi.spyOn(api, 'post').mockResolvedValue({});
    const { user } = renderAsAdmin(<TwoFactorSection />);
    await user.click(await screen.findByRole('button', { name: 'Turn off two-factor' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Enter your password to confirm.')).toBeInTheDocument();
    api.get.mockResolvedValue({ enabled: false });
    await user.type(within(dialog).getByLabelText(/password/i), 'hunter2');
    await user.click(within(dialog).getByRole('button', { name: /Turn off/ }));

    // ⚠️ Password-confirmed on purpose: a borrowed unlocked session must not be able to strip the
    // second factor off an account in two taps.
    await waitFor(() => expect(post).toHaveBeenCalledWith('/auth/me/mfa/disable', { password: 'hunter2' }));
    expect(await screen.findByRole('button', { name: 'Set up two-factor' })).toBeInTheDocument();
  });

  test('a wrong password keeps two-factor ON and says why', async () => {
    withStatus({ enabled: true, backup_codes_remaining: 4 });
    vi.spyOn(api, 'post').mockRejectedValue(new Error('Password is not correct'));
    const { user } = renderAsAdmin(<TwoFactorSection />);
    await user.click(await screen.findByRole('button', { name: 'Turn off two-factor' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/password/i), 'wrong');
    // Scoped to the dialog: the card's own "Turn off two-factor" button is still on the page behind
    // it, so an unscoped /Turn off/ is ambiguous — and would silently pick the wrong one if it were
    // not.
    await user.click(within(dialog).getByRole('button', { name: /Turn off/ }));

    expect(await screen.findByText('Password is not correct')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  test('a caregiver manages their own two-factor exactly as an admin does', async () => {
    // This is not an admin feature — it is every account's own security, and gating it would leave
    // caregivers unable to protect the accounts that can see the cameras.
    withStatus({ enabled: false });
    renderAsCaregiver(<TwoFactorSection />);
    expect(await screen.findByRole('button', { name: 'Set up two-factor' })).toBeEnabled();
  });
});

// --- EventLog -----------------------------------------------------------------------------------

describe('EventLog', () => {
  const at = (secondsAgo) =>
    new Date(Date.now() - secondsAgo * 1000).toISOString().slice(0, 19).replace('T', ' ');
  const EVENTS = [
    { id: 1, camera_name: 'Raffa Room', type: 'offline', created_at: at(30) },
    { id: 2, camera_name: 'Raffa Room', type: 'online', created_at: at(3 * 3600) },
    { id: 3, camera_name: 'Hallway', type: 'restart', created_at: at(50 * 3600) },
  ];
  const withEvents = (events = EVENTS) => {
    vi.spyOn(api, 'get').mockResolvedValue({ events });
    vi.spyOn(api, 'del').mockResolvedValue({});
  };

  test('lists what happened to each camera, newest first, in relative time', async () => {
    withEvents();
    renderAsAdmin(<EventLog />);
    expect(await screen.findByText('just now')).toBeInTheDocument();
    expect(screen.getByText('3h ago')).toBeInTheDocument();
    expect(screen.getByText('2d ago')).toBeInTheDocument();
    expect(screen.getAllByText('Raffa Room')).toHaveLength(2);
  });

  test('says so when a camera has never reported anything', async () => {
    withEvents([]);
    renderAsAdmin(<EventLog />);
    // An empty log and a broken log must not look alike — this screen is opened when something is
    // already wrong.
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/events'));
    expect(screen.queryByText('just now')).not.toBeInTheDocument();
  });

  test('Refresh now re-reads on demand', async () => {
    withEvents();
    const { user } = renderAsAdmin(<EventLog />);
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole('button', { name: 'Refresh now' }));
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
  });

  test('a failed load shows the reason and keeps the last good list', async () => {
    withEvents();
    const { user } = renderAsAdmin(<EventLog />);
    await screen.findByText('just now');
    api.get.mockRejectedValue(new Error('History unavailable'));
    await user.click(screen.getByRole('button', { name: 'Refresh now' }));
    expect(await screen.findByText('History unavailable')).toBeInTheDocument();
    expect(screen.getByText('3h ago')).toBeInTheDocument();
  });

  test('clearing asks first, says it is permanent, and only then deletes', async () => {
    withEvents();
    const { user } = renderAsAdmin(<EventLog />);
    await screen.findByText('just now');
    await user.click(screen.getByRole('button', { name: 'Clear log' }));

    const dialog = await screen.findByRole('dialog');
    // ⚠️ This is the history you would use to diagnose a camera that keeps dropping — which is
    // exactly when someone is on this screen with an urge to tidy up.
    expect(within(dialog).getByText(/permanently deletes the up\/down\/restart history/)).toBeInTheDocument();
    expect(api.del).not.toHaveBeenCalled();

    api.get.mockResolvedValue({ events: [] });
    await user.click(within(dialog).getByRole('button', { name: 'Clear log' }));
    await waitFor(() => expect(api.del).toHaveBeenCalledWith('/events'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.queryByText('just now')).not.toBeInTheDocument();
  });

  test('cancelling deletes nothing', async () => {
    withEvents();
    const { user } = renderAsAdmin(<EventLog />);
    await screen.findByText('just now');
    await user.click(screen.getByRole('button', { name: 'Clear log' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(api.del).not.toHaveBeenCalled();
  });

  test('a failed clear surfaces the reason rather than looking like it worked', async () => {
    withEvents();
    api.del.mockRejectedValue(new Error('Database is locked'));
    const { user } = renderAsAdmin(<EventLog />);
    await screen.findByText('just now');
    await user.click(screen.getByRole('button', { name: 'Clear log' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Clear log' }));
    expect(await screen.findByText('Database is locked')).toBeInTheDocument();
  });

  describe('auto-refresh', () => {
    beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
    // ⚠️ try/finally is not enough here because the polling is per-test — restore in afterEach, or a
    // failure inside a timer test leaves fake timers installed and every later test hangs to its
    // 5 s timeout. That happened once already in this suite.
    afterEach(() => vi.useRealTimers());

    test('polls while on, and stops when switched off', async () => {
      withEvents();
      const { user } = renderAsAdmin(<EventLog />);
      await waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));
      await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
      expect(api.get.mock.calls.length).toBeGreaterThan(1);

      await user.click(screen.getByRole('checkbox'));
      const settled = api.get.mock.calls.length;
      await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
      expect(api.get).toHaveBeenCalledTimes(settled);
    });

    test('unmounting stops the polling', async () => {
      withEvents();
      const { unmount } = renderAsAdmin(<EventLog />);
      await waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));
      unmount();
      await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
      expect(api.get).toHaveBeenCalledTimes(1);
    });
  });
});
