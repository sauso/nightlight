import { useNavigate } from 'react-router-dom';
import { Plus, ChevronRight, Cctv } from 'lucide-react';
import { useCameras } from '../lib/CamerasContext.jsx';
import { ageLabel } from '../lib/age.js';
import AppHeader from '../components/AppHeader.jsx';
import Avatar from '../components/Avatar.jsx';

// The Children tab: each child gets their own card (echoing their detail screen's hero), tapping
// through to their detail (cameras, alerts, sleep). Its own top-level tab (pulled out of the old
// Family hub).
export default function Children() {
  const navigate = useNavigate();
  const { kids, cameras } = useCameras();

  const camCount = (kidId) => cameras.filter((c) => c.child_id === kidId).length;

  return (
    <>
      <AppHeader title="Children" />
      <main className="app-main">
        {kids.map((kid) => {
          const n = camCount(kid.id);
          const age = ageLabel(kid.birthday);
          const open = () => navigate(`/children/${kid.id}`);
          return (
            <button key={kid.id} className="child-card" onClick={open}>
              <Avatar name={kid.name} src={kid.photo} color={kid.color} size={64} />
              <span className="child-card__id">
                <span className="child-card__name">{kid.name}</span>
                <span className="child-card__meta">
                  <Cctv size={13} aria-hidden="true" />
                  {n} camera{n === 1 ? '' : 's'}{age ? ` · ${age}` : ''}
                </span>
              </span>
              <ChevronRight size={20} className="child-card__chev" aria-hidden="true" />
            </button>
          );
        })}
        {kids.length === 0 && (
          <div className="empty-state" style={{ padding: 20 }}>No children yet. Add one to start grouping cameras.</div>
        )}
        <button className="btn btn-primary" onClick={() => navigate('/children/new')} style={{ marginTop: 4 }}>
          <Plus size={16} aria-hidden="true" /> Add child
        </button>
      </main>
    </>
  );
}
