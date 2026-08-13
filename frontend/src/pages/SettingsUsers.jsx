import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, ChevronRight } from 'lucide-react';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/AuthContext.jsx';
import AppHeader from '../components/AppHeader.jsx';
import Avatar from '../components/Avatar.jsx';

function timeAgo(iso) {
  const seconds = Math.floor((Date.now() - new Date(iso + 'Z').getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// Caregiver management list + all active sessions. Adding / editing a caregiver now happens on
// its own routed screen (UserSettings.jsx) rather than a modal.
export default function SettingsUsers() {
  const { logout } = useAuth();
  const navigate = useNavigate();
  const [users, setUsers] = useState([]);
  const [allSessions, setAllSessions] = useState([]);
  const [error, setError] = useState('');

  async function load() {
    try {
      setUsers(await api.get('/auth/users'));
      setAllSessions(await api.get('/auth/sessions/all'));
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => { load(); }, []);

  const displayName = (u) => [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username;

  async function terminateSession(s) {
    try {
      await api.del(`/auth/sessions/${s.id}`);
      if (s.is_current) { logout(); return; }
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <>
      <AppHeader title="User management" back={{ to: '/settings', label: 'Settings' }} />
      <main className="app-main">
        {error && <div className="error-banner">{error}</div>}

        <div className="section-title">Caregiver accounts</div>
        <div className="card tight">
          {users.map((u) => {
            const open = () => navigate(`/settings/users/${u.id}`);
            return (
              <div
                className="list-row"
                key={u.id}
                role="button"
                tabIndex={0}
                style={{ cursor: 'pointer', padding: '12px 14px' }}
                onClick={open}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
                  <Avatar name={displayName(u)} src={u.photo} size={50} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 500 }}>{displayName(u)}</div>
                    <div className="camera-tile__sub">{u.username} · {u.role}</div>
                  </div>
                </div>
                <ChevronRight size={18} style={{ opacity: 0.45, flexShrink: 0 }} aria-hidden="true" />
              </div>
            );
          })}
        </div>
        <button className="btn btn-primary" onClick={() => navigate('/settings/users/new')} style={{ marginBottom: 14 }}>
          <Plus size={16} aria-hidden="true" /> Add caregiver
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
              <button className="icon-btn" onClick={() => terminateSession(s)}>Sign out</button>
            </div>
          ))}
        </div>
      </main>
    </>
  );
}
