import { useNavigate } from 'react-router-dom';
import { Camera, ChevronRight, Clapperboard } from 'lucide-react';
import AppHeader from '../components/AppHeader.jsx';

// state.from returns a visit through this menu here; each page also has this as its
// fallback parent so direct links and refreshes have the same back destination.
const BACK = { state: { from: { to: '/settings/camera-recording', label: 'Camera and Recording' } } };
const ITEMS = [
  { key: 'camera', to: '/settings/camera', Icon: Camera, label: 'Camera controls', desc: 'PTZ step size and offline-camera alerts' },
  { key: 'recording', to: '/settings/recording', Icon: Clapperboard, label: 'Recording', desc: 'Automatic clips, on-demand recording, retention and storage' },
  { key: 'clips', to: '/settings/clips', Icon: Clapperboard, label: 'Clip management', desc: 'Browse recorded clips by date; bulk-delete' },
];

export default function SettingsCameraRecording() {
  const navigate = useNavigate();
  return (
    <>
      <AppHeader title="Camera and Recording" back={{ to: '/settings', label: 'Settings' }} />
      <main className="app-main">
        <div className="camera-tile__sub" style={{ marginBottom: 12 }}>
          Manage camera controls, recording settings and saved clips.
        </div>
        <div className="card" style={{ padding: 0 }}>
          {ITEMS.map(({ key, ...item }) => (
            <Row key={key} {...item} onClick={() => navigate(item.to, BACK)} />
          ))}
        </div>
      </main>
    </>
  );
}

function Row({ Icon, label, desc, onClick }) {
  return (
    <div className="list-row" role="button" tabIndex={0}
      style={{ cursor: 'pointer', padding: '12px 14px' }}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
        <span style={{ width: 24, display: 'inline-flex', justifyContent: 'center', flexShrink: 0 }}>
          <Icon size={22} color="var(--peri)" aria-hidden="true" />
        </span>
        <div style={{ minWidth: 0 }}>
          <div>{label}</div>
          <div className="camera-tile__sub">{desc}</div>
        </div>
      </div>
      <ChevronRight size={18} style={{ opacity: 0.5 }} aria-hidden="true" />
    </div>
  );
}
