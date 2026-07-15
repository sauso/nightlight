import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/AuthContext.jsx';
import Modal from '../components/Modal.jsx';
import AppHeader from '../components/AppHeader.jsx';

const BLANK_FORM = { username: '', password: '', role: 'caregiver', first_name: '', last_name: '' };
const BLANK_PASSWORD_FORM = { current_password: '', new_password: '', confirm_password: '' };

export default function Account() {
  const { user, logout, refresh } = useAuth();
  const [users, setUsers] = useState([]);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(null); // null | user being edited
  const [form, setForm] = useState(BLANK_FORM);
  const [busy, setBusy] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);
  const [passwordForm, setPasswordForm] = useState(BLANK_PASSWORD_FORM);
  const [passwordError, setPasswordError] = useState('');
  const [passwordSaved, setPasswordSaved] = useState(false);

  async function load() {
    if (user?.role !== 'admin') return;
    try {
      setUsers(await api.get('/auth/users'));
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => { load(); }, [user]);

  function displayName(u) {
    const name = [u.first_name, u.last_name].filter(Boolean).join(' ');
    return name || u.username;
  }

  async function addUser(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.post('/auth/users', form);
      setAdding(false);
      setForm(BLANK_FORM);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function openEdit(u) {
    setForm({
      username: u.username,
      password: '',
      role: u.role,
      first_name: u.first_name || '',
      last_name: u.last_name || '',
    });
    setEditing(u);
  }

  async function saveEdit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const payload = {
        username: form.username,
        role: form.role,
        first_name: form.first_name,
        last_name: form.last_name,
      };
      if (form.password) payload.password = form.password;
      await api.put(`/auth/users/${editing.id}`, payload);
      setEditing(null);
      await load();
      if (editing.id === user.id) await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
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

  async function removeUser(u) {
    if (!confirm(`Remove caregiver "${displayName(u)}"?`)) return;
    try {
      await api.del(`/auth/users/${u.id}`);
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <>
      <AppHeader title={displayName(user || {})} />
      <main className="app-main">
        {error && <div className="error-banner">{error}</div>}

        <div className="card">
          <div className="list-row">
            <span>Role</span>
            <span className="tag">{user?.role}</span>
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

        {user?.role === 'admin' && (
          <>
            <div className="section-title">Caregiver accounts</div>
            <div className="card">
              {users.map((u) => (
                <div className="list-row" key={u.id}>
                  <div>
                    <div>{displayName(u)}</div>
                    <div className="camera-tile__sub">{u.username} · {u.role}</div>
                  </div>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button className="icon-btn" onClick={() => openEdit(u)}>Edit</button>
                    {u.id !== user.id && (
                      <button className="icon-btn" onClick={() => removeUser(u)}>Remove</button>
                    )}
                  </div>
                </div>
              ))}
            </div>
            <button className="btn btn-secondary" onClick={() => { setForm(BLANK_FORM); setAdding(true); }} style={{ marginBottom: 14 }}>
              + Add caregiver
            </button>
          </>
        )}

        <button className="btn btn-danger" onClick={logout}>Sign out</button>
      </main>

      {(adding || editing) && (
        <Modal title={editing ? 'Edit user' : 'Add caregiver'} onClose={() => { setAdding(false); setEditing(null); }}>
          <form onSubmit={editing ? saveEdit : addUser}>
            <div style={{ display: 'flex', gap: 10 }}>
              <div className="field" style={{ flex: 1 }}>
                <label htmlFor="user-first-name">First name</label>
                <input
                  id="user-first-name"
                  value={form.first_name}
                  onChange={(e) => setForm({ ...form, first_name: e.target.value })}
                  autoFocus
                />
              </div>
              <div className="field" style={{ flex: 1 }}>
                <label htmlFor="user-last-name">Last name</label>
                <input
                  id="user-last-name"
                  value={form.last_name}
                  onChange={(e) => setForm({ ...form, last_name: e.target.value })}
                />
              </div>
            </div>
            <div className="field">
              <label htmlFor="new-username">Username</label>
              <input
                id="new-username"
                value={form.username}
                onChange={(e) => setForm({ ...form, username: e.target.value })}
                required
              />
            </div>
            {!editing && (
              <div className="field">
                <label htmlFor="new-password">Password</label>
                <input
                  id="new-password"
                  type="password"
                  minLength={8}
                  value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                  required
                />
              </div>
            )}
            {editing && (
              <div className="field">
                <label htmlFor="reset-password">Reset password (optional)</label>
                <input
                  id="reset-password"
                  type="password"
                  minLength={8}
                  value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                  placeholder="Leave blank to keep current password"
                />
              </div>
            )}
            <div className="field">
              <label htmlFor="new-role">Role</label>
              <select
                id="new-role"
                value={form.role}
                onChange={(e) => setForm({ ...form, role: e.target.value })}
              >
                <option value="caregiver">Caregiver</option>
                <option value="admin">Admin</option>
              </select>
            </div>
            <button className="btn btn-primary" type="submit" disabled={busy}>
              {busy ? 'Saving…' : editing ? 'Save changes' : 'Add caregiver'}
            </button>
          </form>
        </Modal>
      )}

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
