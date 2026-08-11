import { useNavigate } from 'react-router-dom';
import { Baby, Video, Users, ChevronRight } from 'lucide-react';
import { useAuth } from '../lib/AuthContext.jsx';
import AppHeader from '../components/AppHeader.jsx';

// Family is a hub: who and what we're monitoring. Children and Cameras are open to any
// signed-in user; Caregivers (account management) is admin-only, so it only appears for
// admins. Each row carries `state.from` so the sub-page's back button returns here.
const BACK = { state: { from: { to: '/family', label: 'Family' } } };

export default function Family() {
  const navigate = useNavigate();
  const { user } = useAuth();

  const items = [
    { to: '/children', Icon: Baby, label: 'Children', desc: 'Group cameras by child' },
    { to: '/cameras', Icon: Video, label: 'Cameras', desc: 'Add, edit and arrange cameras' },
  ];
  if (user?.role === 'admin') {
    items.push({ to: '/settings/users', Icon: Users, label: 'Caregivers', desc: 'Accounts and active sessions' });
  }

  return (
    <>
      <AppHeader title="Family" />
      <main className="app-main">
        <div className="card">
          {items.map(({ to, Icon, label, desc }) => (
            <div
              key={to}
              className="list-row"
              role="button"
              tabIndex={0}
              style={{ cursor: 'pointer' }}
              onClick={() => navigate(to, BACK)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate(to, BACK); } }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <Icon size={20} aria-hidden="true" />
                <div>
                  <div>{label}</div>
                  <div className="camera-tile__sub">{desc}</div>
                </div>
              </div>
              <ChevronRight size={18} style={{ opacity: 0.5, flexShrink: 0 }} aria-hidden="true" />
            </div>
          ))}
        </div>
      </main>
    </>
  );
}
