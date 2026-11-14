import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  SlidersHorizontal, Plug, Globe, ScrollText, Users, Video,
  Info, Server, ListChecks,
} from 'lucide-react';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/AuthContext.jsx';
import { isNativeApp, changeServer } from '../lib/nativeBridge.js';
import AppHeader from '../components/AppHeader.jsx';
import Avatar from '../components/Avatar.jsx';
import useSetupStatus from '../lib/useSetupStatus.js';
import NavRow from '../components/NavRow.jsx';

// Settings is a hub. Account sits at the top in its own card (like the mockup); system config
// (General / Camera and recording / Users / Integrations / Remote access / Logs) is admin-only; About + Change server share the
// last card. Sign out lives on the Account page, not here. Rows that stay under Settings pass
// state.from so their back button returns here.
const BACK = { state: { from: { to: '/settings', label: 'Settings' } } };

function displayName(u) {
  const name = [u?.first_name, u?.last_name].filter(Boolean).join(' ').trim();
  return name || u?.username || 'You';
}

const ADMIN_ITEMS = [
  { key: 'setup', to: '/setup', Icon: ListChecks, label: 'Setup & diagnostics', desc: 'Finish setup or check the camera picture' },
  { key: 'general', to: '/settings/general', Icon: SlidersHorizontal, label: 'General', desc: 'App name, timezone and temperature unit' },
  { key: 'camera-recording', to: '/settings/camera-recording', Icon: Video, label: 'Camera and recording', desc: 'Camera controls, recording settings and clip management' },
  { key: 'caregivers', to: '/settings/users', Icon: Users, label: 'Users', desc: 'Manage logins and active sessions' },
  { key: 'integrations', to: '/settings/integrations', Icon: Plug, label: 'Integrations', desc: 'Notifications and MQTT' },
  { key: 'remote-access', to: '/settings/remote-access', Icon: Globe, label: 'Remote access', desc: 'Check how you reach Nightlight from outside your home' },
  { key: 'logs', to: '/settings/logs', Icon: ScrollText, label: 'Logs', desc: 'Camera history and server logs' },
];

export default function Settings() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const setupStatus = useSetupStatus(isAdmin);
  const [version, setVersion] = useState(null);

  useEffect(() => {
    api.get('/about').then((info) => setVersion(info?.version)).catch(() => {});
  }, []);

  return (
    <>
      <AppHeader title="Settings" />
      <main className="app-main">
        {/* Account — top of the list, in its own card. */}
        <div className="card">
          <NavRow leading={<Avatar name={displayName(user)} src={user?.photo} size={50} />}
            label={displayName(user)} sub={`${user?.role} · Account`}
            onClick={() => navigate('/account', BACK)} />
        </div>

        {isAdmin && (
          <div className="card">
            {ADMIN_ITEMS.filter((it) => it.key !== 'setup' || ['not_started', 'in_progress', 'completed_limited'].includes(setupStatus)).map((it) => (
              <NavRow
                key={it.key}
                Icon={it.Icon} label={it.label} sub={it.desc}
                onClick={() => navigate(it.to, BACK)}
              />
            ))}
          </div>
        )}

        <div className="card">
          <NavRow
            Icon={Info}
            label="About"
            sub="Version, links, disclaimer"
            value={version}
            onClick={() => navigate('/about', BACK)}
          />
          {isNativeApp() && (
            <NavRow Icon={Server} label="Change server" onClick={changeServer} />
          )}
        </div>
      </main>
    </>
  );
}
