import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Video, Plus, ChevronRight } from 'lucide-react';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/AuthContext.jsx';
import { useCameras } from '../lib/CamerasContext.jsx';
import AppHeader from '../components/AppHeader.jsx';
import Avatar from '../components/Avatar.jsx';

// Family is the "who and what we're monitoring" hub. It lists the children, the cameras (with
// their capability badges), and — for admins — the caregivers, inline like the design mockup,
// rather than being a menu of sub-menus. Each row carries state.from so the destination's back
// button returns here.
const BACK = { state: { from: { to: '/family', label: 'Family' } } };
const PERI = 'var(--peri)';

function displayName(u) {
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ').trim();
  return name || u.username || 'Caregiver';
}

function Row({ leading, title, sub, badges, trailing, onClick }) {
  return (
    <div
      className="list-row"
      role="button"
      tabIndex={0}
      style={{ cursor: 'pointer' }}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
        {leading}
        <div style={{ minWidth: 0 }}>
          <div>{title}</div>
          {sub && <div className="camera-tile__sub">{sub}</div>}
          {badges}
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
        {trailing}
        <ChevronRight size={18} style={{ opacity: 0.45 }} aria-hidden="true" />
      </div>
    </div>
  );
}

export default function Family() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const { kids, cameras } = useCameras();
  const [caregivers, setCaregivers] = useState([]);

  useEffect(() => {
    if (!isAdmin) return;
    api.get('/auth/users').then(setCaregivers).catch(() => {});
  }, [isAdmin]);

  const camCount = (kidId) => cameras.filter((c) => c.child_id === kidId).length;

  function camBadges(c) {
    const items = [];
    if (c.detect_motion_enabled) items.push(['MOTION', 'cam-badge--ok']);
    if (c.detect_sound_enabled) items.push(['SOUND', 'cam-badge--ok']);
    if (c.ptz_supported) items.push(['PTZ', '']);
    if (c.talk_configured) items.push(['TALK', '']);
    if (items.length === 0) return null;
    return (
      <div className="cam-badge-row">
        {items.map(([label, cls]) => (
          <span key={label} className={`cam-badge ${cls}`}>{label}</span>
        ))}
      </div>
    );
  }

  return (
    <>
      <AppHeader title="Family" />
      <main className="app-main">
        <div className="section-title">Children</div>
        <div className="card">
          {kids.map((kid) => (
            <Row
              key={kid.id}
              leading={<Avatar name={kid.name} color={kid.color} size={30} />}
              title={kid.name}
              sub={`${camCount(kid.id)} camera${camCount(kid.id) === 1 ? '' : 's'}`}
              onClick={() => navigate(`/children/${kid.id}`, BACK)}
            />
          ))}
          <Row
            leading={<Plus size={20} color={PERI} aria-hidden="true" />}
            title="Add child"
            onClick={() => navigate('/children/new', BACK)}
          />
        </div>

        <div className="section-title">Cameras</div>
        <div className="card">
          {cameras.map((c) => (
            <Row
              key={c.id}
              leading={<Video size={20} color={PERI} aria-hidden="true" />}
              title={c.name}
              badges={camBadges(c)}
              // Camera settings are admin-only; a caregiver goes to the (viewable) cameras list.
              onClick={() => navigate(isAdmin ? `/cameras/${c.id}` : '/cameras', BACK)}
            />
          ))}
          {isAdmin && (
            <Row
              leading={<Plus size={20} color={PERI} aria-hidden="true" />}
              title="Add camera"
              onClick={() => navigate('/cameras/new', BACK)}
            />
          )}
        </div>

        {isAdmin && (
          <>
            <div className="section-title">Caregivers</div>
            <div className="card">
              {caregivers.map((u) => (
                <Row
                  key={u.id}
                  leading={<Avatar name={displayName(u)} size={30} />}
                  title={displayName(u)}
                  trailing={<span className="camera-tile__sub" style={{ textTransform: 'capitalize' }}>{u.role}</span>}
                  onClick={() => navigate(`/settings/users/${u.id}`, BACK)}
                />
              ))}
              <Row
                leading={<Plus size={20} color={PERI} aria-hidden="true" />}
                title="Add caregiver"
                onClick={() => navigate('/settings/users/new', BACK)}
              />
            </div>
          </>
        )}
      </main>
    </>
  );
}
