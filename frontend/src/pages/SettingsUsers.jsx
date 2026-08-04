import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/AuthContext.jsx';
import Modal from '../components/Modal.jsx';
import AppHeader from '../components/AppHeader.jsx';
import SettingsBack from '../components/SettingsBack.jsx';

const BLANK_FORM = { username: '', password: '', role: 'caregiver', first_name: '', last_name: '' };

function timeAgo(iso) {
  const seconds = Math.floor((Date.now() - new Date(iso + 'Z').getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export default function SettingsUsers() {
  const { user, logout, refresh } = useAuth();
  const [users, setUsers] = useState([]);
  const [allSessions, setAllSessions] = useState([]);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(null); // null | user being edited
  const [form, setForm] = useState(BLANK_FORM);
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      setUsers(await api.get('/auth/users'));
      setAllSessions(await api.get('/auth/sessions/all'));
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => { load(); }, []);

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

  async function removeUser(u) {
    if (!confirm(`Remove caregiver "${displayName(u)}"?`)) return;
    try {
      await api.del(`/auth/users/${u.id}`);
      await load();
    } catch (err) {
      setError(err.message);
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
      <AppHeader title="User management" />
      <main className="app-main">
        <SettingsBack />
        {error && <div className="error-banner">{error}</div>}

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

        <div className="section-title">All active sessions</div>
        <div className="card" style={{ marginBottom: 14 }}>
          {allSessions.length === 0 && <div className="camera-tile__sub" style={{ padding: 12 }}>None active</div>}
          {allSessions.map((s) => (
            <div className="list-row" key={s.id}>
              <div>
                <div>{s.username} — {s.device}{s.is_current ? ' (this device)' : ''}</div>
                <div className="camera-tile__sub">Active {timeAgo(s.last_seen_at)}</div>
              </div>
              <button className="icon-btn" onClick={() => terminateSession(s)}>
                Sign out
              </button>
            </div>
          ))}
        </div>
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
    </>
  );
}
