import { useNavigate } from 'react-router-dom';
import { Plus, ChevronRight } from 'lucide-react';
import { useCameras } from '../lib/CamerasContext.jsx';
import AppHeader from '../components/AppHeader.jsx';
import Avatar from '../components/Avatar.jsx';

// The Children tab: one row per child, tapping through to their detail (cameras, alerts, sleep).
// Its own top-level tab now (pulled out of the old Family hub).
export default function Children() {
  const navigate = useNavigate();
  const { kids, cameras } = useCameras();

  const camCount = (kidId) => cameras.filter((c) => c.child_id === kidId).length;

  return (
    <>
      <AppHeader title="Children" />
      <main className="app-main">
        <div className="card tight">
          {kids.map((kid) => {
            const n = camCount(kid.id);
            return (
              <button
                key={kid.id}
                className="list-row"
                style={{ cursor: 'pointer', padding: '12px 14px' }}
                onClick={() => navigate(`/children/${kid.id}`)}
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
                  <Avatar name={kid.name} src={kid.photo} color={kid.color} size={40} />
                  <span style={{ minWidth: 0, textAlign: 'left' }}>
                    <span style={{ display: 'block', fontWeight: 500 }}>{kid.name}</span>
                    <span className="camera-tile__sub">{n} camera{n === 1 ? '' : 's'}</span>
                  </span>
                </span>
                <ChevronRight size={18} style={{ opacity: 0.45, flexShrink: 0 }} aria-hidden="true" />
              </button>
            );
          })}
          {kids.length === 0 && (
            <div className="camera-tile__sub" style={{ padding: 14 }}>No children yet.</div>
          )}
        </div>
        <button className="btn btn-secondary" onClick={() => navigate('/children/new')}>
          <Plus size={16} aria-hidden="true" /> Add child
        </button>
      </main>
    </>
  );
}
