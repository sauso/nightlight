import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, ChevronRight, ChevronDown } from 'lucide-react';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/AuthContext.jsx';
import AppHeader from '../components/AppHeader.jsx';
import Avatar from '../components/Avatar.jsx';
import { useHomeTime } from '../lib/useHomeTime.js';

function timeAgo(iso) {
  const seconds = Math.floor((Date.now() - new Date(iso + 'Z').getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// The small status pill on a row for the caregiver invite feature (#1094), or null for an ordinary account. Three states, from the
// fields GET /auth/users adds (all additive: a server older than this sends none of them and no pill shows):
//  - password_set === false with a live invite: "Invite pending" (they have a link and have not used it);
//  - password_set === false with invite_expires_at null: "No active invite". NOT "expired": null also means revoked or never made,
//    and the server cannot tell the screen which, so the wording claims only what is known (the account cannot sign in);
//  - invite_accepted_at set (the server sends it for 7 days after the invite was used): "Joined <date>".
// `=== false`, not falsy, so an account with no `password_set` key is not mistaken for a pending one.
// Colours are the existing status-badge modifiers (gold highlight, grey, green), which already have both themes.
function invitePill(u, formatDay) {
  if (u.password_set === false) {
    return u.invite_expires_at
      ? { text: 'Invite pending', cls: 'status-badge--highlight' }
      : { text: 'No active invite', cls: 'status-badge--off' };
  }
  if (u.invite_accepted_at) {
    // UTC text with no zone marker; the `T` and `Z` make it a real instant (Safari refuses a space before the Z).
    const when = new Date(`${u.invite_accepted_at.replace(' ', 'T')}Z`);
    const day = formatDay(when);
    return { text: day ? `Joined ${day}` : 'Joined', cls: 'status-badge--ok' };
  }
  return null;
}

// Caregiver management list. Each account that has signed-in devices carries a down arrow that opens
// that account's active sessions underneath it (they used to be one separate card listing everyone's).
// Adding / editing a caregiver happens on its own routed screen (UserSettings.jsx) rather than a modal.
export default function SettingsUsers() {
  const { logout } = useAuth();
  const { day } = useHomeTime();
  const navigate = useNavigate();
  const [users, setUsers] = useState([]);
  const [allSessions, setAllSessions] = useState([]);
  const [error, setError] = useState('');
  // Which accounts have their session list open. Empty = everything collapsed, which is how the page
  // starts (the sessions are a look-up, not the point of the screen). Keyed by user id so a reload
  // after a sign-out keeps the panel the admin is working in open.
  const [expanded, setExpanded] = useState(() => new Set());

  async function load() {
    try {
      // Both reads are issued together and both states are set together. Two sequential awaits rendered the
      // rows first WITHOUT their arrows and then shifted every row that has sessions when the second reply
      // arrived (a layout jump), and a rename landing between the two reads left the join on username empty
      // for that account until the next load.
      const [nextUsers, nextSessions] = await Promise.all([
        api.get('/auth/users'),
        api.get('/auth/sessions/all'),
      ]);
      setUsers(nextUsers);
      setAllSessions(nextSessions);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => { load(); }, []);

  const displayName = (u) => [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username;

  function toggleSessions(id) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

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
      <AppHeader title="Users" back={{ to: '/settings', label: 'Settings' }} />
      <main className="app-main">
        {error && <div className="error-banner">{error}</div>}

        <div className="card tight">
          <h2 className="card-heading">Accounts</h2>
          {users.map((u) => {
            const open = () => navigate(`/settings/users/${u.id}`);
            // GET /auth/sessions/all returns `username` on each session but no user id (toPublicSession in
            // routes/auth.js), and usernames are unique logins, so that is the join key. The backend is
            // deliberately left as it is.
            const sessions = allSessions.filter((s) => s.username === u.username);
            const isOpen = expanded.has(u.id);
            const panelId = `user-sessions-${u.id}`;
            const pill = invitePill(u, (d) => day(d, { month: 'short', day: 'numeric' }));
            return (
              <div className="user-row" key={u.id}>
                {/* The row is two SIBLING controls, not one button holding another: a button inside a role=button
                    is invalid nesting, and a tap on the arrow must not also open the account. */}
                <div className="user-row__line">
                  <div
                    className="user-row__open"
                    role="button"
                    tabIndex={0}
                    onClick={open}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
                      <Avatar name={displayName(u)} src={u.photo} size={50} />
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 500 }}>{displayName(u)}</div>
                        <div className="camera-tile__sub">{u.username} · {u.role}</div>
                        {pill && <span className={`status-badge status-badge--sm ${pill.cls}`} style={{ marginTop: 4 }}>{pill.text}</span>}
                      </div>
                    </div>
                    <ChevronRight size={18} style={{ opacity: 0.45, flexShrink: 0 }} aria-hidden="true" />
                  </div>
                  {/* No sessions, no toggle: an arrow that opens an empty panel would be a control with nothing behind it.
                      The name stays the same open or closed; aria-expanded carries the state. */}
                  {sessions.length > 0 && (
                    <button
                      type="button"
                      className="user-row__toggle"
                      aria-expanded={isOpen}
                      aria-controls={panelId}
                      aria-label={`Show sessions for ${displayName(u)}, ${sessions.length} active`}
                      onClick={() => toggleSessions(u.id)}
                    >
                      <ChevronDown size={18} className="user-row__toggle-chev" aria-hidden="true" />
                    </button>
                  )}
                </div>
                {sessions.length > 0 && (
                  <div className="user-row__sessions" id={panelId} hidden={!isOpen}>
                    {sessions.map((s) => (
                      <div className="list-row" key={s.id}>
                        <div className="list-row__main">
                          <div className="list-row__title">{s.device}{s.is_current ? ' (this device)' : ''}</div>
                          <div className="camera-tile__sub">Active {timeAgo(s.last_seen_at)}</div>
                        </div>
                        <button type="button" className="icon-btn" onClick={() => terminateSession(s)}>Sign out</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          <button type="button" className="btn btn-primary" onClick={() => navigate('/settings/users/new')} style={{ marginTop: 12 }}>
            <Plus size={16} aria-hidden="true" /> Add user
          </button>
        </div>
      </main>
    </>
  );
}
