import { useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { useCameras } from '../lib/CamerasContext.jsx';
import { useAuth } from '../lib/AuthContext.jsx';
import AppHeader from '../components/AppHeader.jsx';
import ChildListCard from '../components/ChildListCard.jsx';
import LoadFailed from '../components/LoadFailed.jsx';
import { loadState } from '../lib/loadState.js';

// The Children tab: each child gets their own card (echoing their detail screen's hero), tapping
// through to their detail (cameras, alerts, sleep). Its own top-level tab (pulled out of the old
// Family hub).
export default function Children() {
  const navigate = useNavigate();
  const { kids, cameras, loaded, error, refresh } = useCameras();
  // A failed or unanswered request must not read as "no children yet" (#375): that copy, and the Add child
  // button under it, only appear once a request has actually succeeded with an empty list.
  const state = loadState({ loaded, error, count: kids.length });
  const blocked = state === 'loading' || state === 'error';
  // Adding a child is admin-only (#542; the server refuses a caregiver's add), so a caregiver gets no
  // Add button, and an empty list tells them who can add one instead of inviting them to.
  const { user } = useAuth() || {};
  const isAdmin = user?.role === 'admin';

  const camCount = (kidId) => cameras.filter((c) => c.child_id === kidId).length;

  return (
    <>
      <AppHeader title="Children" />
      <main className="app-main">
        {state === 'loading' && <div className="empty-state" style={{ padding: 20 }}>Loading…</div>}
        {(state === 'error' || state === 'stale') && (
          <LoadFailed what="children" error={error} onRetry={refresh} stale={state === 'stale'} />
        )}
        {kids.map((kid) => {
          const n = camCount(kid.id);
          const open = () => navigate(`/children/${kid.id}`);
          return (
            <ChildListCard key={kid.id} child={kid} cameraCount={n} onOpen={open} />
          );
        })}
        {state === 'empty' && (
          <div className="empty-state" style={{ padding: 20 }}>
            {isAdmin ? 'No children yet. Add one to start grouping cameras.' : 'No children yet. An admin can add one.'}
          </div>
        )}
        {isAdmin && !blocked && (
          <button className="btn btn-primary" onClick={() => navigate('/children/new')} style={{ marginTop: 4 }}>
            <Plus size={16} aria-hidden="true" /> Add child
          </button>
        )}
      </main>
    </>
  );
}
