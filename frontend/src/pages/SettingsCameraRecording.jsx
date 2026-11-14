import { useNavigate } from 'react-router-dom';
import { Camera, Clapperboard, Film } from 'lucide-react';
import AppHeader from '../components/AppHeader.jsx';
import NavRow from '../components/NavRow.jsx';

// state.from returns a visit through this menu here; each page also has this as its
// fallback parent so direct links and refreshes have the same back destination.
const BACK = { state: { from: { to: '/settings/camera-recording', label: 'Camera settings' } } };
const ITEMS = [
  { key: 'camera', to: '/settings/camera', Icon: Camera, label: 'Camera controls', desc: 'PTZ step size and offline-camera alerts' },
  { key: 'recording', to: '/settings/recording', Icon: Clapperboard, label: 'Recording', desc: 'Automatic clips, on-demand recording, retention and storage' },
  { key: 'clips', to: '/settings/clips', Icon: Film, label: 'Clip management', desc: 'Browse recorded clips by date; bulk-delete' },
];

export default function SettingsCameraRecording() {
  const navigate = useNavigate();
  return (
    <>
      <AppHeader title="Camera and recording" back={{ to: '/settings', label: 'Settings' }} />
      <main className="app-main">
        <div className="camera-tile__sub" style={{ marginBottom: 12 }}>
          Manage camera controls, recording settings and saved clips.
        </div>
        <div className="card" style={{ padding: 0 }}>
          {ITEMS.map(({ key, ...item }) => (
            <NavRow key={key} Icon={item.Icon} label={item.label} sub={item.desc}
              onClick={() => navigate(item.to, BACK)} />
          ))}
        </div>
      </main>
    </>
  );
}
