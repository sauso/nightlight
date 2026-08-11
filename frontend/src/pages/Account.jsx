import { useEffect, useState } from 'react';
import { Sun, Moon, Monitor } from 'lucide-react';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/AuthContext.jsx';
import { getTheme, setTheme } from '../lib/theme.js';
import Modal from '../components/Modal.jsx';
import AppHeader from '../components/AppHeader.jsx';
import Switch from '../components/Switch.jsx';

const THEME_OPTIONS = [
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon },
  { value: 'system', label: 'System', Icon: Monitor },
];
import {
  notificationsSupported,
  notificationsEnabled,
  enableNotifications,
  disableNotifications,
  getServerPushStatus,
} from '../lib/pushNotifications.js';

const BLANK_PASSWORD_FORM = { current_password: '', new_password: '', confirm_password: '' };

function timeAgo(iso) {
  const seconds = Math.floor((Date.now() - new Date(iso + 'Z').getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export default function Account() {
  const { user, logout } = useAuth();
  const [sessions, setSessions] = useState([]);
  const [error, setError] = useState('');
  const [theme, setThemeState] = useState(getTheme());

  function chooseTheme(value) {
    setThemeState(value);
    setTheme(value); // per-device; applies immediately (see lib/theme.js)
  }
  const [busy, setBusy] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);
  const [passwordForm, setPasswordForm] = useState(BLANK_PASSWORD_FORM);
  const [passwordError, setPasswordError] = useState('');
  const [passwordSaved, setPasswordSaved] = useState(false);
  // Notifications (per-device, native app only).
  const [notifEnabled, setNotifEnabled] = useState(notificationsEnabled());
  const [serverPush, setServerPush] = useState(null); // { configured, push_enabled } | null (loading)
  const [notifBusy, setNotifBusy] = useState(false);

  useEffect(() => {
    if (notificationsSupported()) getServerPushStatus().then(setServerPush);
  }, []);

  async function toggleNotifications(on) {
    setNotifBusy(true);
    try {
      if (on) await enableNotifications();
      else await disableNotifications();
      setNotifEnabled(notificationsEnabled());
    } finally {
      setNotifBusy(false);
    }
  }

  async function load() {
    try {
      setSessions(await api.get('/auth/sessions'));
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => { load(); }, [user]);

  function displayName(u) {
    const name = [u.first_name, u.last_name].filter(Boolean).join(' ');
    return name || u.username;
  }

  async function changeOwnPassword(e) {
    e.preventDefault();
    setPasswordError('');
    if (passwordForm.new_password !== passwordForm.confirm_password) {
      setPasswordError("New passwords don't match");
      return;
    }
    setBusy(true);
    try {
      await api.put('/auth/me/password', {
        current_password: passwordForm.current_password,
        new_password: passwordForm.new_password,
      });
      setChangingPassword(false);
      setPasswordForm(BLANK_PASSWORD_FORM);
      setPasswordSaved(true);
      setTimeout(() => setPasswordSaved(false), 2500);
    } catch (err) {
      setPasswordError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function terminateSession(s) {
    if (s.is_current) {
      if (!confirm('This will sign you out of this device too. Continue?')) return;
    }
    try {
      await api.del(`/auth/sessions/${s.id}`);
      if (s.is_current) {
        logout();
        return;
      }
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <>
      <AppHeader title={displayName(user || {})} back={{ to: '/settings', label: 'Settings' }} />
      <main className="app-main">
        {error && <div className="error-banner">{error}</div>}

        <div className="card">
          <div className="list-row">
            <span>Role</span>
            <span className="tag">{user?.role}</span>
          </div>
        </div>

        <div className="section-title">Appearance</div>
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="segmented" role="group" aria-label="Theme">
            {THEME_OPTIONS.map(({ value, label, Icon }) => (
              <button
                key={value}
                type="button"
                className={`segmented__btn${theme === value ? ' segmented__btn--active' : ''}`}
                aria-pressed={theme === value}
                onClick={() => chooseTheme(value)}
              >
                <Icon size={18} aria-hidden="true" />
                {label}
              </button>
            ))}
          </div>
          <div className="camera-tile__sub" style={{ marginTop: 8 }}>
            Applies to this device only. System follows your phone's light / dark setting.
          </div>
        </div>

        {passwordSaved && <div className="saved-banner">Password updated ✓</div>}
        <button
          className="btn btn-secondary"
          onClick={() => { setPasswordForm(BLANK_PASSWORD_FORM); setPasswordError(''); setChangingPassword(true); }}
          style={{ marginBottom: 14 }}
        >
          Change my password
        </button>

        <div className="section-title">Signed in on</div>
        <div className="card" style={{ marginBottom: 14 }}>
          {sessions.map((s) => (
            <div className="list-row" key={s.id}>
              <div>
                <div>{s.device}{s.is_current ? ' (this device)' : ''}</div>
                <div className="camera-tile__sub">Active {timeAgo(s.last_seen_at)}</div>
              </div>
              <button className="icon-btn" onClick={() => terminateSession(s)}>
                Sign out
              </button>
            </div>
          ))}
        </div>

        {notificationsSupported() && (
          <>
            <div className="section-title">Notifications</div>
            <div className="card" style={{ marginBottom: 14 }}>
              {serverPush && !serverPush.configured ? (
                <div className="camera-tile__sub" style={{ padding: 12 }}>
                  Notifications aren't set up on this server yet. An admin needs to add a Firebase
                  project — see <strong>docs/notifications.md</strong>.
                </div>
              ) : serverPush && !serverPush.push_enabled ? (
                <div className="camera-tile__sub" style={{ padding: 12 }}>
                  Push notifications are set up but not enabled on this server yet. An admin can turn
                  them on under <strong>Settings → Push notifications</strong>.
                </div>
              ) : (
                <>
                  <label className="log-viewer__toggle" style={{ padding: 12, margin: 0 }}>
                    <Switch
                      checked={notifEnabled}
                      disabled={notifBusy || !serverPush}
                      onChange={(e) => toggleNotifications(e.target.checked)}
                    />
                    Send motion alerts to this device
                  </label>
                  <div className="camera-tile__sub" style={{ padding: '0 12px 12px' }}>
                    Get a push notification when a camera with motion detection sees movement, even
                    when the app is closed. Turning this on asks for notification permission.
                  </div>
                </>
              )}
            </div>
          </>
        )}

        <button className="btn btn-danger" onClick={logout}>Sign out</button>
      </main>

      {changingPassword && (
        <Modal title="Change my password" onClose={() => setChangingPassword(false)}>
          <form onSubmit={changeOwnPassword}>
            {passwordError && <div className="error-banner">{passwordError}</div>}
            <div className="field">
              <label htmlFor="current-password">Current password</label>
              <input
                id="current-password"
                type="password"
                value={passwordForm.current_password}
                onChange={(e) => setPasswordForm({ ...passwordForm, current_password: e.target.value })}
                required
                autoFocus
              />
            </div>
            <div className="field">
              <label htmlFor="new-own-password">New password</label>
              <input
                id="new-own-password"
                type="password"
                minLength={8}
                value={passwordForm.new_password}
                onChange={(e) => setPasswordForm({ ...passwordForm, new_password: e.target.value })}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="confirm-own-password">Confirm new password</label>
              <input
                id="confirm-own-password"
                type="password"
                minLength={8}
                value={passwordForm.confirm_password}
                onChange={(e) => setPasswordForm({ ...passwordForm, confirm_password: e.target.value })}
                required
              />
            </div>
            <button className="btn btn-primary" type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Update password'}
            </button>
          </form>
        </Modal>
      )}
    </>
  );
}
