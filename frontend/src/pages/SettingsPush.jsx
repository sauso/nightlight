import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { api } from '../lib/api.js';
import AppHeader from '../components/AppHeader.jsx';
import PushoverIcon from '../components/icons/PushoverIcon.jsx';
import FirebaseIcon from '../components/icons/FirebaseIcon.jsx';
import GotifyIcon from '../components/icons/GotifyIcon.jsx';
import NtfyIcon from '../components/icons/NtfyIcon.jsx';

// Push notifications is now a hub, like the top-level Settings screen: one row per provider, each
// drilling into its own config page. An alert fires to every provider that's enabled. State comes
// from /notifications/status so each row can show On / Off / Not set up at a glance (see badgeFor).
const PERI = 'var(--peri)';
const BACK = { state: { from: { to: '/settings/push', label: 'Push notifications' } } };

const PROVIDERS = [
  { key: 'pushover', to: '/settings/push/pushover', Icon: PushoverIcon, label: 'Pushover', desc: 'Simple paid app; works on iOS. Snapshots included.' },
  { key: 'firebase', to: '/settings/push/firebase', Icon: FirebaseIcon, label: 'Firebase', desc: 'Direct to the Nightlight Android app via your own project.' },
  { key: 'gotify', to: '/settings/push/gotify', Icon: GotifyIcon, label: 'Gotify', desc: 'Self-hosted push server. Text alerts.' },
  { key: 'ntfy', to: '/settings/push/ntfy', Icon: NtfyIcon, label: 'ntfy', desc: 'ntfy.sh or self-hosted. Snapshots included.' },
];

// Four answers, and no row is ever blank once the status request has settled (#385). It used to return
// null for "never set up" AND, because the request's failure was swallowed, for "could not ask", so a hub
// where nothing was configured looked identical to a hub that failed to load.
//   On              enabled (checked first: if the server ever says enabled+unconfigured, On is the truth,
//                   the server decides whether it delivers).
//   Off             credentials are saved and someone switched it off.
//   Not set up      nothing saved. A different WORD from Off on purpose: "Off" reads as "was on, turned
//                   off", which this provider never was.
//   Status unavailable  the request failed, or the server did not mention this provider: we were not
//                   told, so the row must not claim either way.
const UNAVAILABLE = { text: 'Status unavailable', cls: 'status-badge--off' };
function badgeFor(s) {
  if (!s) return UNAVAILABLE;
  if (s.enabled) return { text: 'On', cls: 'status-badge--ok' };
  if (s.configured) return { text: 'Off', cls: 'status-badge--off' };
  return { text: 'Not set up', cls: 'status-badge--off' };
}

export default function SettingsPush() {
  const navigate = useNavigate();
  const [status, setStatus] = useState(null);
  const [statusFailed, setStatusFailed] = useState(false);

  // The hub stays usable if this fails (the rows are static and each page loads its own config); the
  // failure only changes what the badges say. No badge at all only while the request is in flight.
  useEffect(() => { api.get('/notifications/status').then(setStatus).catch(() => setStatusFailed(true)); }, []);
  const badgeOf = (key) => (statusFailed ? UNAVAILABLE : status ? badgeFor(status[key]) : null);

  return (
    <>
      <AppHeader title="Push notifications" back={{ to: '/settings', label: 'Settings' }} />
      <main className="app-main">
        <div className="camera-tile__sub" style={{ marginBottom: 12 }}>
          Get alerted on your phone when a camera with motion or sound detection is triggered, even when
          the app is closed. Set up one or more providers below — an alert is sent to <strong>every</strong>{' '}
          one you enable. Detection and the in-app <strong>Recent alerts</strong> work with or without any of these.
        </div>
        <div className="card" style={{ padding: 0 }}>
          {PROVIDERS.map((p) => (
            <Row key={p.key} {...p} badge={badgeOf(p.key)} onClick={() => navigate(p.to, BACK)} />
          ))}
        </div>
      </main>
    </>
  );
}

function Row({ Icon, label, desc, badge, onClick }) {
  return (
    <div
      className="list-row"
      role="button"
      tabIndex={0}
      style={{ cursor: 'pointer', padding: '12px 14px' }}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
        <span style={{ width: 24, display: 'inline-flex', justifyContent: 'center', flexShrink: 0 }}>
          <Icon size={22} color={PERI} aria-hidden="true" />
        </span>
        <div style={{ minWidth: 0 }}>
          <div>{label}</div>
          <div className="camera-tile__sub">{desc}</div>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        {badge && <span className={`status-badge ${badge.cls}`}>{badge.text}</span>}
        <ChevronRight size={18} style={{ opacity: 0.5 }} aria-hidden="true" />
      </div>
    </div>
  );
}
